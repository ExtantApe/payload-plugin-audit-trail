import { describe, expect, it } from 'vitest'
import { changed, same } from '../src/index.js'

const none = new Set<string>()

describe('missing, null and an empty list are the same value (K729)', () => {
  it('lists nothing when a list field goes from missing or null to []', () => {
    expect(changed({ name: 'a', securityChanges: [] }, { name: 'a' }, none)).toEqual([])
    expect(changed({ name: 'a', securityChanges: [] }, { name: 'a', securityChanges: null }, none)).toEqual([])
    expect(changed({ name: 'a' }, { name: 'a', securityChanges: [] }, none)).toEqual([])
  })
  it('still lists a list that gains or loses items', () => {
    expect(changed({ securityChanges: [{ at: '2026-11-24' }] }, {}, none)).toEqual(['securityChanges'])
    expect(changed({ securityChanges: [] }, { securityChanges: [{ at: '2026-11-24' }] }, none)).toEqual(['securityChanges'])
    expect(changed({ securityChanges: [{ at: 'b' }] }, { securityChanges: [{ at: 'a' }] }, none)).toEqual(['securityChanges'])
  })
  it('treats an empty list inside a group the same way', () => {
    expect(same({ tags: [], note: 'x' }, { note: 'x' })).toBe(true)
    expect(same({ tags: ['t'], note: 'x' }, { note: 'x' })).toBe(false)
  })
  it('keeps other empty values distinct', () => {
    expect(changed({ title: '' }, {}, none)).toEqual(['title'])
    expect(changed({ count: 0 }, { count: null }, none)).toEqual(['count'])
    expect(changed({ flag: false }, {}, none)).toEqual(['flag'])
  })
})
