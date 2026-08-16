import YahooFinance from 'yahoo-finance2'
import { DataSourceError } from '../../util/errors.ts'
import { TtlCache } from '../../util/cache.ts'

/** `YahooFinance` is exported as a value, so the instance type has to be derived. */
type YahooFinanceInstance = InstanceType<typeof YahooFinance>

/** Live quotes move constantly; cache only long enough to collapse a fan-out. */
const QUOTE_TTL_MS = 10_000
/** Statements, ratings and bars change at most daily. */
const REFERENCE_TTL_MS = 5 * 60_000

export type FundamentalsPeriod = 'quarterly' | 'annual'
export type FundamentalsModule = 'financials' | 'balance-sheet' | 'cash-flow'

export interface ChartRequest {
  readonly period1: string | Date
  readonly period2?: string | Date
  readonly interval: '1h' | '1d' | '1wk' | '1mo'
}

export interface YahooClientOptions {
  readonly quoteTtlMs?: number
  readonly referenceTtlMs?: number
  /** Injectable for tests; defaults to a real `yahoo-finance2` instance. */
  readonly yf?: YahooFinanceInstance
}

/**
 * Thin normalising wrapper over `yahoo-finance2`.
 *
 * Responsibilities kept here deliberately: caching, cancellation plumbing, and
 * turning "upstream returned nothing" into a typed {@link DataSourceError} so
 * the tool layer never has to guess whether an empty result means "no such
 * ticker" or "upstream hiccup". Field selection and shaping belong to the tools.
 */
export class YahooClient {
  readonly #yf: YahooFinanceInstance
  readonly #quoteCache: TtlCache<unknown>
  readonly #referenceCache: TtlCache<unknown>

  constructor(options: YahooClientOptions = {}) {
    this.#yf = options.yf ?? new YahooFinance({
      suppressNotices: ['yahooSurvey', 'ripHistorical'],
    })
    this.#quoteCache = new TtlCache({ ttlMs: options.quoteTtlMs ?? QUOTE_TTL_MS })
    this.#referenceCache = new TtlCache({ ttlMs: options.referenceTtlMs ?? REFERENCE_TTL_MS })
  }

  async quote(ticker: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const key = `quote:${normalizeKey(ticker)}`
    const result = await this.#quoteCache.resolve(key, async () => {
      return await this.#yf.quote(ticker, {}, { fetchOptions: fetchOptions(signal) })
    })
    const record = asRecord(result)
    if (record === undefined) {
      throw new DataSourceError('unknown_symbol', `No quote data for symbol "${ticker}".`)
    }
    return record
  }

  async chart(ticker: string, request: ChartRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const key = `chart:${normalizeKey(ticker)}:${String(request.period1)}:${String(request.period2 ?? '')}:${request.interval}`
    const result = await this.#referenceCache.resolve(key, async () => {
      return await this.#yf.chart(ticker, {
        period1: request.period1,
        ...(request.period2 === undefined ? {} : { period2: request.period2 }),
        interval: request.interval,
      }, { fetchOptions: fetchOptions(signal) })
    })
    const record = asRecord(result)
    if (record === undefined) {
      throw new DataSourceError('unknown_symbol', `No chart data for symbol "${ticker}".`)
    }
    return record
  }

  /**
   * @param options.validateResult - pass `false` for modules whose upstream
   * shape outruns the library's schema. `upgradeDowngradeHistory` is one: a
   * single old entry carrying `priceTargetAction: "Removes"`, a value absent
   * from the enum, rejects the entire response. Callers that opt out must treat
   * the result as untyped and narrow every field themselves.
   */
  async quoteSummary(
    ticker: string,
    modules: readonly string[],
    signal?: AbortSignal,
    options: { readonly validateResult?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const validateResult = options.validateResult ?? true
    const key = `summary:${normalizeKey(ticker)}:${[...modules].sort().join(',')}:${validateResult}`
    const result = await this.#referenceCache.resolve(key, async () => {
      return await this.#yf.quoteSummary(ticker, {
        modules: modules as string[],
      } as never, { fetchOptions: fetchOptions(signal), validateResult } as never)
    })
    const record = asRecord(result)
    if (record === undefined) {
      throw new DataSourceError('no_data', `No summary data for symbol "${ticker}".`)
    }
    return record
  }

  /**
   * Financial statements. Uses `fundamentalsTimeSeries` rather than the
   * `quoteSummary` statement modules: since late 2024 those modules return only
   * a handful of income-statement fields and lag by a reporting period, while
   * this endpoint carries the full statement and the current period.
   */
  async fundamentals(
    ticker: string,
    module: FundamentalsModule,
    period: FundamentalsPeriod,
    period1: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>[]> {
    const key = `fundamentals:${normalizeKey(ticker)}:${module}:${period}:${period1}`
    const result = await this.#referenceCache.resolve(key, async () => {
      return await this.#yf.fundamentalsTimeSeries(ticker, {
        period1,
        type: period,
        module,
      }, { fetchOptions: fetchOptions(signal) })
    })
    if (!Array.isArray(result)) {
      throw new DataSourceError('no_data', `No ${module} data for symbol "${ticker}".`)
    }
    return result.filter((row): row is Record<string, unknown> => asRecord(row) !== undefined)
  }

  async search(
    query: string,
    counts: { readonly newsCount: number, readonly quotesCount: number },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const key = `search:${normalizeKey(query)}:${counts.newsCount}:${counts.quotesCount}`
    const result = await this.#referenceCache.resolve(key, async () => {
      return await this.#yf.search(query, {
        newsCount: counts.newsCount,
        quotesCount: counts.quotesCount,
      }, { fetchOptions: fetchOptions(signal) })
    })
    const record = asRecord(result)
    if (record === undefined) {
      throw new DataSourceError('no_data', `No search results for "${query}".`)
    }
    return record
  }

  clearCaches(): void {
    this.#quoteCache.clear()
    this.#referenceCache.clear()
  }
}

function fetchOptions(signal?: AbortSignal): RequestInit | undefined {
  return signal === undefined ? undefined : { signal }
}

function normalizeKey(value: string): string {
  return value.trim().toUpperCase()
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
