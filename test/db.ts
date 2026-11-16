import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { postgresAdapter } from '@payloadcms/db-postgres'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Which database the suite runs on: `AUDIT_DB=postgres` for Postgres, anything else for MongoDB. */
export const DB: 'mongo' | 'postgres' = process.env.AUDIT_DB === 'postgres' ? 'postgres' : 'mongo'

export type TestDb = {
  /** A database adapter for a made-up database called `name` (a schema on Postgres). */
  adapter: (name: string, opts?: { transactions?: boolean; indexes?: boolean }) => any
  stop: () => Promise<void>
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })

export async function startDb(): Promise<TestDb> {
  if (DB === 'mongo') {
    const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
    return {
      adapter: (name, o = {}) => mongooseAdapter({ url: mongo.getUri(name), ...(o.indexes === false ? {} : { ensureIndexes: true }), ...(o.transactions === false ? { transactionOptions: false } : {}) }),
      stop: async () => void (await mongo.stop()),
    }
  }
  // Payload skips the schema push when another adapter in the same process pushed the same tables; every test site here is its own schema.
  process.env.PAYLOAD_FORCE_DRIZZLE_PUSH = 'true'
  const dir = mkdtempSync(join(tmpdir(), 'audit-trail-pg-'))
  const port = await freePort()
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'made-up-pw', port, persistent: false, postgresFlags: ['-c', 'max_connections=1000'], onLog: () => {}, onError: () => {} })
  await server.initialise()
  await server.start()
  // Payload's adapter destroy() leaves the pg pool open, and its connect() checks out one client and never gives it back, so pool.end() would wait forever.
  // Every pool this suite makes is kept, along with that first client, and stop() hands the client back and ends the pool before the server stops.
  const pools: { pool: any; first?: any }[] = []
  class TrackedPool extends pg.Pool {
    constructor(opts: any) {
      super(opts)
      pools.push({ pool: this })
    }
    connect(...args: any[]): any {
      const entry = pools.find((e) => e.pool === this)!
      if (args.length || entry.first) return (super.connect as any)(...args)
      return (super.connect as any)().then((c: any) => ((entry.first = c), c))
    }
  }
  return {
    adapter: (name, o = {}) =>
      postgresAdapter({
        pg: { ...pg, Pool: TrackedPool },
        pool: { connectionString: `postgres://postgres:made-up-pw@127.0.0.1:${port}/postgres`, max: 10 },
        schemaName: name.replace(/[^a-z0-9_]/gi, '_').toLowerCase(),
        ...(o.transactions === false ? { transactionOptions: false } : {}),
      } as never),
    stop: async () => {
      for (const { pool, first } of pools.splice(0)) {
        try {
          first?.release()
        } catch {}
        if (!pool.ended) await pool.end()
      }
      // pool.end() returns before the server has seen every socket close, so wait until it reports none left (up to 10 seconds).
      const probe = new pg.Client({ connectionString: `postgres://postgres:made-up-pw@127.0.0.1:${port}/postgres` })
      await probe.connect()
      for (let i = 0; i < 100; i++) {
        const { rows } = await probe.query('select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()')
        if (rows[0].n === 0) break
        await new Promise((r) => setTimeout(r, 100))
      }
      await probe.end()
      await server.stop()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

type Doc = Record<string, any>
type Filter = Record<string, any>

const where = (f: Filter): any => {
  const parts = Object.entries(f).map(([k, v]) => (v && typeof v === 'object' && !(v instanceof Date) && '$ne' in v ? { [k]: { not_equals: v.$ne } } : { [k]: { equals: v } }))
  return parts.length ? { and: parts } : { id: { exists: true } }
}
const clean = (d: Doc) => Object.fromEntries(Object.entries(d).filter(([k, v]) => v !== undefined && k !== '_id' && k !== 'id'))
const setPath = (target: Doc, path: string, value: unknown) => {
  const keys = path.split('.')
  let at = target
  for (const k of keys.slice(0, -1)) at = at[k] = { ...(at[k] ?? {}) }
  at[keys.at(-1)!] = value
}

/**
 * Writes straight to the database, the way a person with database access would: past hooks, access and the plugin.
 * On MongoDB it is the driver's collection, unchanged. On Postgres it speaks the same small subset (`insertOne`,
 * `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, with `$set`, `$unset` and `$ne`) through the
 * adapter's own methods, which run no hooks.
 */
export const rawCollection = (payload: any, slug: string): any => {
  if (DB === 'mongo') return payload.db.collections[slug].collection
  const db = payload.db
  const first = async (f: Filter) => (await db.find({ collection: slug, where: where(f), limit: 1, pagination: false })).docs[0] as Doc | undefined
  const patch = async (row: Doc, u: Doc) => {
    const data: Doc = {}
    for (const [k, v] of Object.entries(u.$set ?? {})) {
      const top = k.split('.')[0]!
      data[top] ??= row[top] !== null && typeof row[top] === 'object' && !(row[top] instanceof Date) ? structuredClone(row[top]) : row[top]
      if (k.includes('.')) setPath(data, k, v)
      else data[k] = v
    }
    for (const k of Object.keys(u.$unset ?? {})) data[k] = null
    return data
  }
  return {
    insertOne: (d: Doc) => db.create({ collection: slug, data: clean(d) }),
    insertMany: async (ds: Doc[]) => {
      for (const d of ds) await db.create({ collection: slug, data: clean(d) })
    },
    updateOne: async (f: Filter, u: Doc) => {
      const row = await first(f)
      if (row) await db.updateOne({ collection: slug, where: { id: { equals: row.id } }, data: { ...clean(row), ...(await patch(row, u)) } })
    },
    updateMany: async (f: Filter, u: Doc) => {
      for (const row of (await db.find({ collection: slug, where: where(f), pagination: false, limit: 0 })).docs as Doc[]) await db.updateOne({ collection: slug, where: { id: { equals: row.id } }, data: { ...clean(row), ...(await patch(row, u)) } })
    },
    deleteOne: async (f: Filter) => {
      const row = await first(f)
      if (row) await db.deleteOne({ collection: slug, where: { id: { equals: row.id } } })
    },
    deleteMany: (f: Filter) => db.deleteMany({ collection: slug, where: where(f) }),
  }
}

/** Every row of a collection as stored, hidden fields included, as plain objects. */
export const rawRows = async (payload: any, slug: string): Promise<Doc[]> =>
  DB === 'mongo' ? payload.db.collections[slug].find({}).lean() : (await payload.db.find({ collection: slug, pagination: false, limit: 0 })).docs
