import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { YahooClient } from '../datasource/us/yahoo-client.ts'
import { guard, success, type ToolEnvelope } from '../util/errors.ts'
import { stringify } from '../util/stringify.ts'
import { fetchFundDetail, isFundQuoteType } from './fund.ts'
import { compact, isoDate, jsonOutput, num, round, str, tickerSchema, TOOL_TIMEOUT_MS } from './shared.ts'

export function createGetQuoteTool(market: string, client: YahooClient): ToolDefinition {
  return defineTool({
    name: 'get_quote',
    description:
      'Get a live US stock quote: last price, change, day range, volume, market cap, P/E, EPS, book value, '
      + 'dividend yield, 52-week range and moving averages. '
      + 'Reports the last and next earnings dates separately; when `next_earnings_date_is_estimate` is true '
      + 'that date is projected from the reporting cadence, not confirmed by the company. '
      + 'Also covers ETFs and mutual funds: those additionally return expense ratio, net assets, category, '
      + 'issuer, asset allocation, trailing returns and top holdings, so answering "what is this fund" needs '
      + 'no separate lookup. Read `fund_notes` before quoting those figures — the equity ratios are '
      + 'holdings-weighted aggregates there, and the holdings list is a partial one. '
      + 'One symbol per call. Use exchange tickers such as AAPL or BRK-B.',
    parameters: {
      ticker: tickerSchema('Stock symbol, e.g. "AAPL". ETF and mutual-fund symbols are accepted.'),
    },
    output: jsonOutput(),
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => stringify(await getQuote(market, client, args.ticker, exec.signal)),
  })
}

export async function getQuote(
  market: string,
  client: YahooClient,
  ticker: string,
  signal?: AbortSignal,
): Promise<ToolEnvelope<Record<string, unknown>>> {
  return await guard(market, ticker, async () => {
    const q = await client.quote(ticker, signal)
    const quote = shapeQuote(q)
    const resolved = str(q.symbol) ?? ticker

    // Sequential, not parallel: the fund modules are worth fetching only once
    // the quote says this is a fund, and nothing else reveals that. Equities
    // therefore pay nothing for this — they never make the second call.
    if (!isFundQuoteType(quote.quote_type)) {
      return success(market, quote, { ticker: resolved })
    }

    try {
      const fund = await fetchFundDetail(client, resolved, signal)
      return success(market, fund === undefined ? quote : { ...quote, ...fund }, { ticker: resolved })
    } catch (error) {
      // The quote itself succeeded. Losing the fund detail is a degraded
      // answer, not a failed one, so it is reported as a warning rather than
      // discarding a price the caller can still use.
      return success(market, quote, {
        ticker: resolved,
        warnings: [`Fund detail (expense ratio, holdings, returns) was unavailable: ${describe(error)}`],
      })
    }
  })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function shapeQuote(q: Record<string, unknown>): Record<string, unknown> {
  return compact({
    ...shapeEarnings(q),
    symbol: str(q.symbol),
    name: str(q.longName) ?? str(q.shortName),
    quote_type: str(q.quoteType),
    exchange: str(q.fullExchangeName) ?? str(q.exchange),
    currency: str(q.currency),
    // Differs from `currency` for ADRs, whose statements are reported in the home currency.
    financial_currency: str(q.financialCurrency),
    market_state: str(q.marketState),
    listed_since: isoDate(q.firstTradeDateMilliseconds)?.slice(0, 10),

    price: num(q.regularMarketPrice),
    change: round(q.regularMarketChange, 4),
    change_percent: round(q.regularMarketChangePercent, 4),
    previous_close: num(q.regularMarketPreviousClose),
    open: num(q.regularMarketOpen),
    day_high: num(q.regularMarketDayHigh),
    day_low: num(q.regularMarketDayLow),
    volume: num(q.regularMarketVolume),
    average_volume_10d: num(q.averageDailyVolume10Day),
    average_volume_3m: num(q.averageDailyVolume3Month),
    quote_time: isoDate(q.regularMarketTime),

    // Populated only outside regular hours; omitted otherwise.
    pre_market_price: num(q.preMarketPrice),
    pre_market_change_percent: round(q.preMarketChangePercent, 4),
    post_market_price: num(q.postMarketPrice),
    post_market_change_percent: round(q.postMarketChangePercent, 4),

    market_cap: num(q.marketCap),
    shares_outstanding: num(q.sharesOutstanding),
    trailing_pe: round(q.trailingPE, 4),
    forward_pe: round(q.forwardPE, 4),
    price_to_book: round(q.priceToBook, 4),
    book_value_per_share: round(q.bookValue, 4),
    eps_trailing_twelve_months: num(q.epsTrailingTwelveMonths),
    eps_current_year: num(q.epsCurrentYear),
    eps_forward: num(q.epsForward),
    dividend_yield: round(q.dividendYield, 4),
    dividend_rate: num(q.dividendRate),

    fifty_two_week_high: num(q.fiftyTwoWeekHigh),
    fifty_two_week_low: num(q.fiftyTwoWeekLow),
    fifty_two_week_change_percent: round(q.fiftyTwoWeekChangePercent, 4),
    fifty_day_average: round(q.fiftyDayAverage, 4),
    two_hundred_day_average: round(q.twoHundredDayAverage, 4),

  })
}

/**
 * Yahoo splits the earnings calendar across three fields with easily conflated
 * meanings: `earningsTimestamp` is the most recently *announced* event, which is
 * usually the last report but flips to the upcoming one once that is confirmed;
 * `earningsTimestampStart`/`End` is the next event, as a point or a window; and
 * `isEarningsDateEstimate` qualifies only the *next* event, not the last one.
 *
 * Emitting a single `earnings_date` therefore risks handing the model a date
 * that has already passed, or pairing a past date with an estimate flag that
 * describes a different quarter. Both events are reported separately instead.
 */
function shapeEarnings(q: Record<string, unknown>, now: number = Date.now()): Record<string, unknown> {
  const announced = isoDate(Array.isArray(q.earningsTimestamp) ? q.earningsTimestamp[0] : q.earningsTimestamp)
  const start = isoDate(q.earningsTimestampStart)
  const end = isoDate(q.earningsTimestampEnd)

  const isPast = (value: string | undefined): boolean => value !== undefined && Date.parse(value) < now
  const next = start ?? (isPast(announced) ? undefined : announced)

  return {
    last_earnings_date: isPast(announced) ? announced : undefined,
    next_earnings_date: next,
    // Present only when Yahoo reports a window rather than a single day.
    next_earnings_date_end: end !== undefined && end !== next ? end : undefined,
    next_earnings_date_is_estimate: next === undefined ? undefined : q.isEarningsDateEstimate === true,
  }
}
