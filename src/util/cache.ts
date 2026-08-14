interface CacheEntry<T> {
  readonly expiresAt: number
  readonly value: T
}

export interface TtlCacheOptions {
  /** Entry lifetime in milliseconds. */
  readonly ttlMs: number
  /** Upper bound on retained entries; the oldest insertion is evicted first. */
  readonly maxEntries?: number
  /** Injectable clock, for tests. */
  readonly now?: () => number
}

/**
 * Short-lived in-memory cache with in-flight de-duplication.
 *
 * A single model turn typically fans out several tools against the same ticker,
 * so concurrent identical requests are collapsed onto one upstream call. Failed
 * lookups are never cached — a transient upstream error must not be pinned for
 * the whole TTL.
 */
export class TtlCache<T> {
  readonly #entries = new Map<string, CacheEntry<T>>()
  readonly #inFlight = new Map<string, Promise<T>>()
  readonly #ttlMs: number
  readonly #maxEntries: number
  readonly #now: () => number

  constructor(options: TtlCacheOptions) {
    this.#ttlMs = options.ttlMs
    this.#maxEntries = options.maxEntries ?? 256
    this.#now = options.now ?? Date.now
  }

  get(key: string): T | undefined {
    const entry = this.#entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: T): void {
    if (this.#entries.size >= this.#maxEntries && !this.#entries.has(key)) {
      const oldest = this.#entries.keys().next()
      if (!oldest.done) this.#entries.delete(oldest.value)
    }
    this.#entries.set(key, { value, expiresAt: this.#now() + this.#ttlMs })
  }

  /** Resolve `key` from cache, an in-flight call, or `load` — in that order. */
  async resolve(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.get(key)
    if (cached !== undefined) return cached

    const pending = this.#inFlight.get(key)
    if (pending !== undefined) return await pending

    const started = (async () => {
      const value = await load()
      this.set(key, value)
      return value
    })()

    this.#inFlight.set(key, started)
    try {
      return await started
    } finally {
      this.#inFlight.delete(key)
    }
  }

  clear(): void {
    this.#entries.clear()
    this.#inFlight.clear()
  }

  get size(): number {
    return this.#entries.size
  }
}
