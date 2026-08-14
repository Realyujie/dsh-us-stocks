import { describe, expect, it } from 'vitest'
import { TtlCache } from '../src/util/cache.ts'

function clock(start = 0) {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => { current += ms },
  }
}

describe('TtlCache', () => {
  it('returns a cached value inside the TTL and drops it after', () => {
    const time = clock()
    const cache = new TtlCache<string>({ ttlMs: 1_000, now: time.now })

    cache.set('a', 'first')
    expect(cache.get('a')).toBe('first')

    time.advance(999)
    expect(cache.get('a')).toBe('first')

    time.advance(1)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('collapses concurrent identical loads onto a single call', async () => {
    const cache = new TtlCache<number>({ ttlMs: 1_000 })
    let calls = 0
    const load = async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return 42
    }

    const results = await Promise.all([
      cache.resolve('k', load),
      cache.resolve('k', load),
      cache.resolve('k', load),
    ])

    expect(results).toEqual([42, 42, 42])
    expect(calls).toBe(1)
  })

  it('does not cache failures, so a transient error is retried', async () => {
    const cache = new TtlCache<string>({ ttlMs: 60_000 })
    let attempts = 0
    const load = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('transient')
      return 'ok'
    }

    await expect(cache.resolve('k', load)).rejects.toThrow('transient')
    await expect(cache.resolve('k', load)).resolves.toBe('ok')
    expect(attempts).toBe(2)
  })

  it('evicts the oldest entry once maxEntries is reached', () => {
    const cache = new TtlCache<number>({ ttlMs: 60_000, maxEntries: 2 })
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)

    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe(2)
    expect(cache.get('c')).toBe(3)
    expect(cache.size).toBe(2)
  })

  it('refreshes an existing key without evicting a sibling', () => {
    const cache = new TtlCache<number>({ ttlMs: 60_000, maxEntries: 2 })
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('a', 10)

    expect(cache.get('a')).toBe(10)
    expect(cache.get('b')).toBe(2)
  })
})
