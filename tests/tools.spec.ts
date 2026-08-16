import { describe, expect, it } from 'vitest'
import type { YahooClient } from '../src/datasource/us/yahoo-client.ts'
import { DataSourceError } from '../src/util/errors.ts'
import { getQuote } from '../src/tools/get-quote.ts'
import { getHistory } from '../src/tools/get-history.ts'
import { getFinancials } from '../src/tools/get-financials.ts'
import { getAnalystView } from '../src/tools/get-analyst-view.ts'
import { getNews } from '../src/tools/get-news.ts'
import { createUsStockTools } from '../src/tools/index.ts'
import { MAX_TOOL_OUTPUT_CHARACTERS, stringify } from '../src/util/stringify.ts'

/** Minimal stand-in so tool shaping is tested without touching the network. */
function fakeClient(overrides: Partial<Record<keyof YahooClient, unknown>>): YahooClient {
  return overrides as unknown as YahooClient
}

describe('createUsStockTools', () => {
  it('registers every tool with an explicit timeout', () => {
    const tools = createUsStockTools('us', fakeClient({}))
    expect(tools.map((tool) => tool.name)).toEqual([
      'get_quote', 'get_history', 'get_financials', 'get_analyst_view', 'get_news', 'get_ownership',
    ])
    for (const tool of tools) {
      expect(tool.timeoutMs).toBe(25_000)
      expect(tool.description.length).toBeGreaterThan(20)
    }
  })
})

describe('get_quote', () => {
  it('renames upstream fields and drops absent ones', async () => {
    const client = fakeClient({
      quote: async () => ({
        symbol: 'AAPL',
        longName: 'Apple Inc.',
        regularMarketPrice: 305.26,
        regularMarketChangePercent: 0.9958681,
        marketCap: 4_455_019_315_200,
        trailingPE: 34.609978,
        fiftyTwoWeekHigh: 344.57,
        forwardPE: null,
      }),
    })

    const result = await getQuote('us', client, 'AAPL')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.ticker).toBe('AAPL')
    expect(result.data.name).toBe('Apple Inc.')
    expect(result.data.price).toBe(305.26)
    expect(result.data.change_percent).toBe(0.9959)
    expect(result.data.market_cap).toBe(4_455_019_315_200)
    expect(result.data).not.toHaveProperty('forward_pe')
    expect(result.data).not.toHaveProperty('day_high')
  })

  // Shapes taken from live responses on 2026-08-14.
  it('separates a past report from a projected next one (TTMI shape)', async () => {
    const client = fakeClient({
      quote: async () => ({
        symbol: 'TTMI',
        earningsTimestamp: new Date('2026-08-05T20:00:00Z'),
        earningsTimestampStart: new Date('2026-11-04T20:00:00Z'),
        earningsTimestampEnd: new Date('2026-11-04T20:00:00Z'),
        isEarningsDateEstimate: true,
      }),
    })

    const result = await getQuote('us', client, 'TTMI')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.last_earnings_date).toBe('2026-08-05T20:00:00.000Z')
    expect(result.data.next_earnings_date).toBe('2026-11-04T20:00:00.000Z')
    expect(result.data.next_earnings_date_is_estimate).toBe(true)
    expect(result.data).not.toHaveProperty('next_earnings_date_end')
  })

  it('treats a confirmed upcoming date as next, not last (NVDA shape)', async () => {
    const client = fakeClient({
      quote: async () => ({
        symbol: 'NVDA',
        earningsTimestamp: new Date('2126-08-26T20:00:00Z'),
        earningsTimestampStart: new Date('2126-08-26T20:00:00Z'),
        earningsTimestampEnd: new Date('2126-08-26T20:00:00Z'),
        isEarningsDateEstimate: false,
      }),
    })

    const result = await getQuote('us', client, 'NVDA')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).not.toHaveProperty('last_earnings_date')
    expect(result.data.next_earnings_date).toBe('2126-08-26T20:00:00.000Z')
    expect(result.data.next_earnings_date_is_estimate).toBe(false)
  })

  it('exposes the closing bound when the next date is a window', async () => {
    const client = fakeClient({
      quote: async () => ({
        symbol: 'XYZ',
        earningsTimestampStart: new Date('2126-11-04T20:00:00Z'),
        earningsTimestampEnd: new Date('2126-11-08T20:00:00Z'),
        isEarningsDateEstimate: true,
      }),
    })

    const result = await getQuote('us', client, 'XYZ')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.next_earnings_date).toBe('2126-11-04T20:00:00.000Z')
    expect(result.data.next_earnings_date_end).toBe('2126-11-08T20:00:00.000Z')
  })

  it('omits every earnings key when none is reported', async () => {
    const client = fakeClient({ quote: async () => ({ symbol: 'SPY', isEarningsDateEstimate: true }) })
    const result = await getQuote('us', client, 'SPY')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const key of ['last_earnings_date', 'next_earnings_date', 'next_earnings_date_is_estimate']) {
      expect(result.data).not.toHaveProperty(key)
    }
  })

  it('never surfaces an analyst rating; ratings belong to get_analyst_view', async () => {
    const client = fakeClient({
      quote: async () => ({
        symbol: 'TTMI',
        regularMarketPrice: 138.88,
        averageAnalystRating: '1.3 - Strong Buy',
      }),
    })

    const result = await getQuote('us', client, 'TTMI')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(JSON.stringify(result.data)).not.toMatch(/buy|sell|hold|rating/i)
  })

  it('reports an unknown symbol as non-retryable', async () => {
    const client = fakeClient({
      quote: async () => { throw new DataSourceError('unknown_symbol', 'No quote data for symbol "ZZZZ".') },
    })

    const result = await getQuote('us', client, 'ZZZZ')
    expect(result).toMatchObject({ ok: false, error: { kind: 'unknown_symbol', retryable: false } })
  })

  it('reports a network fault as retryable', async () => {
    const client = fakeClient({ quote: async () => { throw new Error('fetch failed') } })
    const result = await getQuote('us', client, 'AAPL')
    expect(result).toMatchObject({ ok: false, error: { kind: 'upstream_unavailable', retryable: true } })
  })

  it('adds fund detail for an ETF, opting out of the schema fundProfile fails', async () => {
    const calls: { modules: readonly string[], options: unknown }[] = []
    const client = fakeClient({
      quote: async () => ({ symbol: 'XLK', quoteType: 'ETF', regularMarketPrice: 190.01 }),
      quoteSummary: async (_t: string, modules: readonly string[], _s: unknown, options: unknown) => {
        calls.push({ modules, options })
        return {
          fundProfile: { feesExpensesInvestment: { annualReportExpenseRatio: 0.0008 } },
          defaultKeyStatistics: { totalAssets: 115_400_000_000, fundFamily: 'State Street' },
        }
      },
    })

    const result = await getQuote('us', client, 'XLK')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.price).toBe(190.01)
    expect(result.data.fund_expense_ratio_percent).toBe(0.08)
    expect(result.data.fund_family).toBe('State Street')
    expect(calls).toHaveLength(1)
    expect(calls[0].options).toMatchObject({ validateResult: false })
  })

  it('adds fund detail for a mutual fund too', async () => {
    const client = fakeClient({
      quote: async () => ({ symbol: 'VFIAX', quoteType: 'MUTUALFUND' }),
      quoteSummary: async () => ({ defaultKeyStatistics: { category: 'Large Blend' } }),
    })

    const result = await getQuote('us', client, 'VFIAX')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.fund_category).toBe('Large Blend')
  })

  // The second call is what makes a fund quote cost roughly three times an
  // equity one, so an equity must never reach it.
  it('never makes the fund call for an equity', async () => {
    let summaries = 0
    const client = fakeClient({
      quote: async () => ({ symbol: 'AAPL', quoteType: 'EQUITY' }),
      quoteSummary: async () => { summaries += 1; return {} },
    })

    const result = await getQuote('us', client, 'AAPL')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(summaries).toBe(0)
    expect(JSON.stringify(result.data)).not.toMatch(/fund_/)
  })

  // The price is already in hand at that point; failing the whole call would
  // throw away an answer the caller can still use.
  it('degrades to a warning when the fund call fails, keeping the quote', async () => {
    const client = fakeClient({
      quote: async () => ({ symbol: 'SPY', quoteType: 'ETF', regularMarketPrice: 690.5 }),
      quoteSummary: async () => { throw new Error('fetch failed') },
    })

    const result = await getQuote('us', client, 'SPY')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.price).toBe(690.5)
    expect(result.data).not.toHaveProperty('fund_expense_ratio_percent')
    expect(result.warnings?.[0]).toMatch(/fund detail.*unavailable/i)
  })

  it('keeps the plain quote when a fund reports no profile at all', async () => {
    const client = fakeClient({
      quote: async () => ({ symbol: 'NEWETF', quoteType: 'ETF', regularMarketPrice: 25 }),
      quoteSummary: async () => ({}),
    })

    const result = await getQuote('us', client, 'NEWETF')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.price).toBe(25)
    expect(JSON.stringify(result.data)).not.toMatch(/fund_/)
    expect(result.warnings).toBeUndefined()
  })
})

describe('get_history', () => {
  const bars = [
    { date: new Date('2026-08-11T13:30:00Z'), open: 1, high: 2, low: 0.5, close: 1.5, adjclose: 1.5, volume: 100 },
    { date: new Date('2026-08-12T13:30:00Z'), open: 2, high: 3, low: 1.5, close: 2.5, adjclose: 2.5, volume: 200 },
    { date: new Date('2026-08-13T13:30:00Z'), open: 3, high: 4, low: 2.5, close: 3.5, adjclose: 3.5, volume: 300 },
  ]

  it('shapes bars oldest-first and trims to limit with a warning', async () => {
    const client = fakeClient({
      chart: async () => ({ meta: { symbol: 'TTMI', currency: 'USD' }, quotes: bars }),
    })

    const result = await getHistory('us', client, { ticker: 'TTMI', limit: 2 })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const kept = result.data.bars as Record<string, unknown>[]
    expect(kept).toHaveLength(2)
    expect(kept[0].date).toBe('2026-08-12')
    expect(kept[1].date).toBe('2026-08-13')
    expect(result.data.bar_count).toBe(2)
    expect(result.warnings?.[0]).toMatch(/most recent 2 of 3/)
  })

  it('keeps a full timestamp for hourly bars instead of collapsing them onto one date', async () => {
    // Same calendar day, four distinct hours — the historical shapeBar()
    // sliced every bar's date to 10 characters, which made all four collide
    // on "2026-08-13" and made first_bar_date/last_bar_date indistinguishable.
    const sameDay = [
      { date: new Date('2026-08-13T13:30:00Z'), close: 1 },
      { date: new Date('2026-08-13T14:30:00Z'), close: 2 },
      { date: new Date('2026-08-13T15:30:00Z'), close: 3 },
      { date: new Date('2026-08-13T16:30:00Z'), close: 4 },
    ]
    const client = fakeClient({ chart: async () => ({ meta: {}, quotes: sameDay }) })

    const result = await getHistory('us', client, { ticker: 'AAPL', interval: '1h' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const dates = (result.data.bars as Record<string, unknown>[]).map((b) => b.date)
    expect(new Set(dates).size).toBe(4)
    expect(dates[0]).toBe('2026-08-13T13:30:00.000Z')
    expect(result.data.first_bar_date).not.toBe(result.data.last_bar_date)
  })

  it('keeps daily bars date-only, unaffected by the hourly timestamp change', async () => {
    const client = fakeClient({ chart: async () => ({ meta: {}, quotes: bars }) })
    const result = await getHistory('us', client, { ticker: 'AAPL', interval: '1d' })
    if (!result.ok) return
    expect((result.data.bars as Record<string, unknown>[])[0].date).toBe('2026-08-11')
  })

  it('recommends 1d as the coarser interval once hourly bars outgrow the budget', async () => {
    const many = Array.from({ length: 900 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 0, 1, index)),
      close: 1.5,
    }))
    const client = fakeClient({ chart: async () => ({ meta: {}, quotes: many }) })

    const result = await getHistory('us', client, { ticker: 'AAPL', interval: '1h' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings?.[0]).toMatch(/interval: "1d"/)
  })

  it('classifies an interval/range combination Yahoo refuses as invalid_argument, not internal', async () => {
    // The real message shape Yahoo returns for hourly bars requested too far
    // back — this used to fall through classify() to 'internal', which tells
    // the model nothing actionable.
    const client = fakeClient({
      chart: async () => {
        throw new Error(
          '1h data not available for startTime=345479400 and endTime=1786858864. '
          + 'The requested range must be within the last 730 days.',
        )
      },
    })

    const result = await getHistory('us', client, { ticker: 'AAPL', interval: '1h', range: 'max' })
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_argument', retryable: false } })
  })

  it('states both price adjustment bases so they are not conflated', async () => {
    const client = fakeClient({ chart: async () => ({ meta: {}, quotes: bars }) })
    const result = await getHistory('us', client, { ticker: 'TTMI' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.price_adjustment).toEqual({
      ohlc: 'split-adjusted',
      adj_close: 'split-and-dividend-adjusted',
    })
  })

  it('recommends the next coarser interval when the cap bites', async () => {
    const many = Array.from({ length: 600 }, (_, index) => ({
      date: new Date(Date.UTC(2024, 0, 1 + index)),
      open: 1, high: 2, low: 0.5, close: 1.5, adjclose: 1.5, volume: 10,
    }))
    const client = fakeClient({ chart: async () => ({ meta: {}, quotes: many }) })

    const daily = await getHistory('us', client, { ticker: 'AAPL', interval: '1d' })
    expect(daily.ok).toBe(true)
    if (!daily.ok) return
    expect(daily.data.bar_count).toBe(500)
    expect(daily.warnings?.[0]).toMatch(/interval: "1wk"/)

    const weekly = await getHistory('us', client, { ticker: 'AAPL', interval: '1wk' })
    if (!weekly.ok) return
    expect(weekly.warnings?.[0]).toMatch(/interval: "1mo"/)

    // Monthly is already the coarsest bar available, so there is nothing to suggest.
    const monthly = await getHistory('us', client, { ticker: 'AAPL', interval: '1mo' })
    if (!monthly.ok) return
    expect(monthly.warnings?.[0]).toMatch(/Narrow the window/)
  })

  it('trims bars to the output budget even when limit allows more', async () => {
    // Wide values so each bar costs far more than a typical one.
    const fat = Array.from({ length: 500 }, (_, index) => ({
      date: new Date(Date.UTC(2024, 0, 1 + index)),
      open: 1234.56789, high: 2345.67891, low: 1123.45678,
      close: 1987.65432, adjclose: 1876.54321, volume: 987654321,
    }))
    const client = fakeClient({ chart: async () => ({ meta: {}, quotes: fat }) })

    const result = await getHistory('us', client, { ticker: 'AAPL', limit: 500 })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.bar_count).toBeLessThan(500)
    expect(stringify(result).length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARACTERS)
    // The trimmed window must still end at the most recent bar.
    expect(result.data.last_bar_date).toBe('2025-05-14')
    expect(result.warnings?.[0]).toMatch(/output budget/)
  })

  it('leaves a small window untouched by the budget guard', async () => {
    const client = fakeClient({ chart: async () => ({ meta: {}, quotes: bars }) })
    const result = await getHistory('us', client, { ticker: 'TTMI' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.bar_count).toBe(3)
    expect(result.warnings).toBeUndefined()
  })

  it('rejects a limit above the 500-bar ceiling', async () => {
    const client = fakeClient({ chart: async () => ({ meta: {}, quotes: bars }) })
    const result = await getHistory('us', client, { ticker: 'AAPL', limit: 501 })
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_argument' } })
  })

  it('returns dividends and splits clipped to the kept window', async () => {
    const client = fakeClient({
      chart: async () => ({
        meta: {},
        quotes: bars,
        events: {
          dividends: [
            { date: new Date('2026-08-13T13:30:00Z'), amount: 0.27 },
            // Falls outside the two bars kept below.
            { date: new Date('2026-08-11T13:30:00Z'), amount: 0.26 },
          ],
          splits: [
            { date: new Date('2026-08-12T13:30:00Z'), numerator: 10, denominator: 1, splitRatio: '10:1' },
          ],
        },
      }),
    })

    const result = await getHistory('us', client, { ticker: 'AAPL', limit: 2 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.dividends).toEqual([{ date: '2026-08-13', amount: 0.27 }])
    expect(result.data.splits).toEqual([
      { date: '2026-08-12', ratio: '10:1', numerator: 10, denominator: 1 },
    ])
  })

  it('omits event keys for symbols that have never paid or split', async () => {
    const client = fakeClient({ chart: async () => ({ meta: {}, quotes: bars }) })
    const result = await getHistory('us', client, { ticker: 'TTMI' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).not.toHaveProperty('dividends')
    expect(result.data).not.toHaveProperty('splits')
  })

  it('skips placeholder rows with no close', async () => {
    const client = fakeClient({
      chart: async () => ({
        meta: {},
        quotes: [...bars, { date: new Date('2026-08-14T13:30:00Z'), close: null }],
      }),
    })

    const result = await getHistory('us', client, { ticker: 'TTMI' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.bar_count).toBe(3)
  })

  it('rejects an unknown interval before making a request', async () => {
    let called = false
    const client = fakeClient({ chart: async () => { called = true; return {} } })

    const result = await getHistory('us', client, { ticker: 'TTMI', interval: '5m' })
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_argument', retryable: false } })
    expect(called).toBe(false)
  })

  it('rejects an end_date at or before start_date', async () => {
    const client = fakeClient({ chart: async () => ({}) })
    const result = await getHistory('us', client, {
      ticker: 'TTMI', start_date: '2026-08-01', end_date: '2026-07-01',
    })
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_argument' } })
  })

  it('distinguishes an empty window from a bad symbol', async () => {
    const client = fakeClient({ chart: async () => ({ meta: {}, quotes: [] }) })
    const result = await getHistory('us', client, { ticker: 'TTMI', range: '5d' })
    expect(result).toMatchObject({ ok: false, error: { kind: 'no_data', retryable: false } })
  })
})

describe('get_financials', () => {
  const row = {
    date: new Date('2026-06-30T00:00:00Z'),
    periodType: '3M',
    totalRevenue: 1_004_054_000,
    netIncome: 83_047_000,
    unlistedField: 7,
  }

  it('returns only summary line items by default', async () => {
    const client = fakeClient({ fundamentals: async () => [row] })
    const result = await getFinancials('us', client, { ticker: 'TTMI', statements: ['income'] })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const income = result.data.income as Record<string, unknown>[]
    expect(income[0]).toEqual({
      period_end: '2026-06-30',
      period_type: '3M',
      totalRevenue: 1_004_054_000,
      netIncome: 83_047_000,
    })
  })

  it('includes every reported field in full detail mode', async () => {
    const client = fakeClient({ fundamentals: async () => [row] })
    const result = await getFinancials('us', client, { ticker: 'TTMI', statements: ['income'], detail: 'full' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.data.income as Record<string, unknown>[])[0]).toHaveProperty('unlistedField', 7)
  })

  it('labels the reporting currency, which for an ADR is not USD', async () => {
    const client = fakeClient({
      fundamentals: async () => [row],
      quote: async () => ({ symbol: 'TSM', currency: 'USD', financialCurrency: 'TWD' }),
    })

    const result = await getFinancials('us', client, { ticker: 'TSM', statements: ['income'] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.reporting_currency).toBe('TWD')
    expect(result.warnings).toBeUndefined()
  })

  it('falls back to the trading currency when no reporting currency is given', async () => {
    const client = fakeClient({
      fundamentals: async () => [row],
      quote: async () => ({ symbol: 'AAPL', currency: 'USD' }),
    })

    const result = await getFinancials('us', client, { ticker: 'AAPL', statements: ['income'] })
    if (!result.ok) return
    expect(result.data.reporting_currency).toBe('USD')
  })

  it('returns TTM ratios and flags the one field Yahoo scales by 100', async () => {
    const client = fakeClient({
      fundamentals: async () => [row],
      quote: async () => ({ symbol: 'AAPL', financialCurrency: 'USD' }),
      quoteSummary: async () => ({
        financialData: { grossMargins: 0.48653, debtToEquity: 78.445, returnOnEquity: 1.4875 },
      }),
    })

    const result = await getFinancials('us', client, { ticker: 'AAPL', statements: ['income'] })
    if (!result.ok) return
    const ratios = result.data.ratios as Record<string, unknown>
    expect(ratios.basis).toBe('trailing_twelve_months')
    expect(ratios.gross_margin).toBe(0.48653)
    // Named to keep the 100x scaling visible next to the plain fractions.
    expect(ratios.debt_to_equity_percent).toBe(78.445)
    expect(ratios).not.toHaveProperty('debt_to_equity')
  })

  it('omits ratios when the fundamentals module is unavailable', async () => {
    const client = fakeClient({
      fundamentals: async () => [row],
      quote: async () => ({ symbol: 'SPY', financialCurrency: 'USD' }),
      quoteSummary: async () => { throw new Error('No fundamentals data found for symbol: SPY') },
    })

    const result = await getFinancials('us', client, { ticker: 'SPY', statements: ['income'] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).not.toHaveProperty('ratios')
    expect(result.data.reporting_currency).toBe('USD')
  })

  it('still returns statements when the currency lookup fails, but warns', async () => {
    const client = fakeClient({
      fundamentals: async () => [row],
      quote: async () => { throw new Error('fetch failed') },
    })

    const result = await getFinancials('us', client, { ticker: 'TTMI', statements: ['income'] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).not.toHaveProperty('reporting_currency')
    expect((result.data.income as unknown[])).toHaveLength(1)
    expect(result.warnings?.[0]).toMatch(/do not assume the figures are in USD/)
  })

  it('fails as no_data when nothing is filed for any statement', async () => {
    const client = fakeClient({ fundamentals: async () => [] })
    const result = await getFinancials('us', client, { ticker: 'SPY' })
    expect(result).toMatchObject({ ok: false, error: { kind: 'no_data', retryable: false } })
  })

  it('rejects an unknown statement name', async () => {
    const client = fakeClient({ fundamentals: async () => [row] })
    const result = await getFinancials('us', client, { ticker: 'TTMI', statements: ['equity'] })
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_argument' } })
  })

  it('rejects a limit outside the supported range', async () => {
    const client = fakeClient({ fundamentals: async () => [row] })
    const result = await getFinancials('us', client, { ticker: 'TTMI', limit: 9 })
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_argument' } })
  })
})

describe('get_analyst_view', () => {
  it('derives target upside from the mean target and current price', async () => {
    const client = fakeClient({
      quoteSummary: async () => ({
        financialData: {
          recommendationKey: 'buy',
          numberOfAnalystOpinions: 41,
          currentPrice: 300,
          targetMeanPrice: 330,
        },
        recommendationTrend: { trend: [{ period: '0m', strongBuy: 6, buy: 21, hold: 14, sell: 3, strongSell: 2 }] },
        earningsTrend: { trend: [{ period: '0q', earningsEstimate: { avg: 1.5 }, revenueEstimate: { avg: 1_000 } }] },
      }),
    })

    const result = await getAnalystView('us', client, 'AAPL')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const consensus = result.data.consensus as Record<string, unknown>
    expect(consensus.recommendation_key).toBe('buy')
    expect(consensus.target_upside_percent).toBe(10)
    expect(result.data.recommendation_trend).toHaveLength(1)
    expect((result.data.estimates as Record<string, unknown>[])[0].eps_avg).toBe(1.5)
  })

  it('fails as no_data when the ticker has no coverage at all', async () => {
    const client = fakeClient({ quoteSummary: async () => ({}) })
    const result = await getAnalystView('us', client, 'ZZZZ')
    expect(result).toMatchObject({ ok: false, error: { kind: 'no_data', retryable: false } })
  })

  it('spells out the rating scale, whose direction is counter-intuitive', async () => {
    const client = fakeClient({
      quoteSummary: async () => ({ financialData: { recommendationMean: 2.13 } }),
    })
    const result = await getAnalystView('us', client, 'AAPL')
    if (!result.ok) return
    const consensus = result.data.consensus as Record<string, unknown>
    expect(consensus.recommendation_mean_scale).toMatch(/lower is more bullish/)
  })

  it('omits the scale when no mean is reported', async () => {
    const client = fakeClient({
      quoteSummary: async () => ({ financialData: { recommendationKey: 'buy' } }),
    })
    const result = await getAnalystView('us', client, 'AAPL')
    if (!result.ok) return
    expect(result.data.consensus).not.toHaveProperty('recommendation_mean_scale')
  })

  it('keeps only the ten newest rating changes, newest first', async () => {
    const history = Array.from({ length: 40 }, (_, index) => ({
      epochGradeDate: new Date(Date.UTC(2026, 0, 1 + index)),
      firm: `Firm ${index}`,
      action: 'up',
      fromGrade: 'Hold',
      toGrade: 'Buy',
      currentPriceTarget: 100 + index,
    }))
    const client = fakeClient({
      quoteSummary: async () => ({ upgradeDowngradeHistory: { history } }),
    })

    const result = await getAnalystView('us', client, 'AAPL')
    if (!result.ok) return
    const changes = result.data.rating_changes as Record<string, unknown>[]
    expect(changes).toHaveLength(10)
    expect(changes[0].date).toBe('2026-02-09')
    expect(changes[0].firm).toBe('Firm 39')
    expect(changes.at(-1)?.date).toBe('2026-01-31')
  })

  it('keeps the consensus when the rating history call fails', async () => {
    // The rating history is fetched separately precisely so its schema
    // failures cannot take the rest of the response down with it.
    let call = 0
    const client = fakeClient({
      quoteSummary: async (_t: string, modules: readonly string[]) => {
        call += 1
        if (modules.includes('upgradeDowngradeHistory')) throw new Error('Failed Yahoo Schema validation')
        return { financialData: { recommendationKey: 'buy', targetMeanPrice: 300, currentPrice: 250 } }
      },
    })

    const result = await getAnalystView('us', client, 'TTMI')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(call).toBe(2)
    expect((result.data.consensus as Record<string, unknown>).recommendation_key).toBe('buy')
    expect((result.data.consensus as Record<string, unknown>).target_upside_percent).toBe(20)
    expect(result.data.rating_changes).toEqual([])
  })

  it('returns EPS beats and misses with their surprise percentage', async () => {
    const client = fakeClient({
      quoteSummary: async () => ({
        earningsHistory: {
          history: [
            {
              quarter: new Date('2026-03-31T00:00:00Z'),
              period: '-2q',
              epsActual: 1.85,
              epsEstimate: 1.76993,
              epsDifference: 0.08,
              surprisePercent: 0.0452,
              currency: 'USD',
            },
          ],
        },
      }),
    })

    const result = await getAnalystView('us', client, 'AAPL')
    if (!result.ok) return
    expect(result.data.earnings_surprises).toEqual([{
      quarter_end: '2026-03-31',
      period: '-2q',
      eps_actual: 1.85,
      eps_estimate: 1.76993,
      eps_difference: 0.08,
      surprise_percent: 0.0452,
      currency: 'USD',
    }])
  })

  // Upstream says "No fundamentals data found for symbol: XLK", which reads as
  // a fault rather than the permanent fact that nothing sell-side covers a fund.
  it('explains why a fund has no coverage instead of relaying the upstream wording', async () => {
    const client = fakeClient({
      quoteSummary: async () => { throw new Error('No fundamentals data found for symbol: XLK') },
    })

    const result = await getAnalystView('us', client, 'XLK')
    expect(result).toMatchObject({ ok: false, error: { kind: 'no_data', retryable: false } })
    if (result.ok) return
    expect(result.error.message).toMatch(/analysts rate individual companies/i)
    expect(result.error.message).not.toMatch(/no fundamentals data found/i)
  })

  it('leaves an unrelated failure classified as it was', async () => {
    const client = fakeClient({
      quoteSummary: async () => { throw new Error('fetch failed') },
    })

    const result = await getAnalystView('us', client, 'AAPL')
    expect(result).toMatchObject({ ok: false, error: { kind: 'upstream_unavailable', retryable: true } })
  })
})

describe('get_news', () => {
  it('sorts newest first and normalizes publish times', async () => {
    const client = fakeClient({
      search: async () => ({
        quotes: [{ symbol: 'TTMI' }],
        news: [
          { uuid: 'a', title: 'older', publisher: 'Zacks', providerPublishTime: 1_760_000_000, link: 'https://example.com/a', relatedTickers: ['TTMI'] },
          { uuid: 'b', title: 'newer', publisher: 'Reuters', providerPublishTime: 1_770_000_000, link: 'https://example.com/b', relatedTickers: ['TTMI'] },
          { uuid: 'c', publisher: 'no title, dropped', relatedTickers: ['TTMI'] },
        ],
      }),
    })

    const result = await getNews('us', client, { ticker: 'TTMI' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const articles = result.data.articles as Record<string, unknown>[]
    expect(articles.map((article) => article.title)).toEqual(['newer', 'older'])
    expect(articles[0].published_at).toBe(new Date(1_770_000_000 * 1000).toISOString())
  })

  it('drops headlines that do not reference the symbol', async () => {
    // "KEY" as a word matched UK property filings upstream.
    const client = fakeClient({
      search: async () => ({
        quotes: [{ symbol: 'KEY', longname: 'KeyCorp' }],
        news: [
          { uuid: 'a', title: 'Form 8.3 - Picton Property', providerPublishTime: 1_770_000_000, relatedTickers: ['PCTN.L'] },
          { uuid: 'b', title: 'KeyCorp stock looks discounted', providerPublishTime: 1_770_000_001, relatedTickers: ['KEY'] },
        ],
      }),
    })

    const result = await getNews('us', client, { ticker: 'KEY' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const articles = result.data.articles as Record<string, unknown>[]
    expect(articles).toHaveLength(1)
    expect(articles[0].title).toBe('KeyCorp stock looks discounted')
    expect(result.warnings?.[0]).toBe('Discarded 1 headline that did not reference KEY.')
  })

  it('falls back to a company-name search when the symbol match comes up short', async () => {
    const queries: string[] = []
    const client = fakeClient({
      search: async (query: string) => {
        queries.push(query)
        if (query === 'ALL') {
          return {
            quotes: [{ symbol: 'ALL', longname: 'The Allstate Corporation' }],
            news: [{ uuid: 'x', title: 'Unrelated Finnish bank', providerPublishTime: 1, relatedTickers: ['OMASP.HE'] }],
          }
        }
        return {
          news: [
            { uuid: 'y', title: 'Allstate Q2 earnings call', providerPublishTime: 1_770_000_000, relatedTickers: ['ALL'] },
            // Already collected in the first pass, must not be duplicated.
            { uuid: 'x', title: 'Unrelated Finnish bank', providerPublishTime: 1, relatedTickers: ['OMASP.HE'] },
          ],
        }
      },
    })

    const result = await getNews('us', client, { ticker: 'ALL' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(queries).toEqual(['ALL', 'The Allstate Corporation'])
    const articles = result.data.articles as Record<string, unknown>[]
    expect(articles).toHaveLength(1)
    expect(articles[0].title).toBe('Allstate Q2 earnings call')
  })

  it('skips the second pass once enough relevant headlines are found', async () => {
    const queries: string[] = []
    const news = Array.from({ length: 10 }, (_, index) => ({
      uuid: `n${index}`,
      title: `Story ${index}`,
      providerPublishTime: 1_770_000_000 + index,
      relatedTickers: ['TTMI'],
    }))
    const client = fakeClient({
      search: async (query: string) => {
        queries.push(query)
        return { quotes: [{ symbol: 'TTMI', longname: 'TTM Technologies, Inc.' }], news }
      },
    })

    await getNews('us', client, { ticker: 'TTMI', limit: 5 })
    expect(queries).toEqual(['TTMI'])
  })

  it('explains an all-noise result rather than reporting no news', async () => {
    const client = fakeClient({
      search: async () => ({
        quotes: [{ symbol: 'KEY', longname: 'KeyCorp' }],
        news: [{ uuid: 'a', title: 'Form 8.3', providerPublishTime: 1, relatedTickers: ['PCTN.L'] }],
      }),
    })

    const result = await getNews('us', client, { ticker: 'KEY' })
    expect(result).toMatchObject({ ok: false, error: { kind: 'no_data' } })
    if (result.ok) return
    expect(result.error.message).toMatch(/none reference the symbol/)
  })

  it('separates an unresolvable symbol from a covered symbol with no news', async () => {
    const unknown = await getNews('us', fakeClient({ search: async () => ({ quotes: [], news: [] }) }), { ticker: 'ZZZZ' })
    expect(unknown).toMatchObject({ ok: false, error: { kind: 'unknown_symbol' } })

    const quiet = await getNews('us', fakeClient({ search: async () => ({ quotes: [{ symbol: 'TTMI' }], news: [] }) }), { ticker: 'TTMI' })
    expect(quiet).toMatchObject({ ok: false, error: { kind: 'no_data' } })
  })

  it('rejects a limit above the upstream cap of 10', async () => {
    let called = false
    const client = fakeClient({ search: async () => { called = true; return { quotes: [], news: [] } } })

    const result = await getNews('us', client, { ticker: 'TTMI', limit: 11 })
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_argument' } })
    if (result.ok) return
    expect(result.error.message).toContain('between 1 and 10')
    expect(called).toBe(false)
  })
})
