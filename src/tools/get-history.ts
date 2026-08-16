import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ChartRequest, YahooClient } from '../datasource/us/yahoo-client.ts'
import { DataSourceError, guard, success, type ToolEnvelope } from '../util/errors.ts'
import { MAX_TOOL_OUTPUT_CHARACTERS, stringify } from '../util/stringify.ts'
import { compact, isoDate, jsonOutput, num, round, str, tickerSchema, TOOL_TIMEOUT_MS } from './shared.ts'

const RANGES = ['5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max'] as const
const INTERVALS = ['1h', '1d', '1wk', '1mo'] as const

/**
 * Ceiling on the `limit` argument. 500 daily bars is about two years; longer
 * spans are meant to be requested at a coarser interval. This bounds what a
 * caller may ask for — {@link fitToBudget} bounds what actually fits.
 */
const MAX_LIMIT = 500

/**
 * Serialized-size ceiling for the payload.
 *
 * A bar costs 117-127 characters depending on the price magnitude and interval,
 * so a fixed bar count cannot guarantee the response fits: 500 monthly AAPL bars
 * measure 98.6% of the budget, and anything over it is replaced wholesale by a
 * truncation stub. Bars are therefore trimmed against the measured payload, with
 * headroom left for the envelope and any events.
 */
const SAFE_OUTPUT_CHARACTERS = Math.floor(MAX_TOOL_OUTPUT_CHARACTERS * 0.85)

/** Coarser interval to recommend when a request outgrows the bar cap. */
const COARSER: Partial<Record<Interval, Interval>> = { '1h': '1d', '1d': '1wk', '1wk': '1mo' }

type Range = typeof RANGES[number]
type Interval = typeof INTERVALS[number]

interface HistoryArgs {
  readonly ticker: string
  readonly range?: string
  readonly start_date?: string
  readonly end_date?: string
  readonly interval?: string
  readonly limit?: number
}

export function createGetHistoryTool(market: string, client: YahooClient): ToolDefinition {
  return defineTool({
    name: 'get_history',
    description:
      'Get historical OHLCV bars for a US stock, plus any dividends and splits in the window. '
      + 'The response itself is structured data, not an image — but in the Web UI, calling this tool renders '
      + 'a candlestick chart with a volume band in place of the generic result card, drawn from this same data. '
      + 'Call it when the user wants to see price action, not just read the numbers; a TUI or headless client '
      + 'shows the plain data instead, with no loss of information either way. '
      + 'Use `range` for a trailing window, or `start_date`/`end_date` for an explicit one. Bars run oldest to newest. '
      + 'IMPORTANT — the two price bases differ: `open`/`high`/`low`/`close` are adjusted for splits only, '
      + 'while `adj_close` is adjusted for splits and dividends. Compare like with like; do not mix them in one calculation. '
      + `At most ${MAX_LIMIT} bars are returned (about two years of daily bars), so use a coarser \`interval\` for longer spans.`,
    parameters: {
      ticker: tickerSchema('Stock symbol, e.g. "AAPL".'),
      range: {
        type: 'string' as const,
        enum: RANGES,
        description: 'Trailing window ending today. Default "1y". Ignored when `start_date` is given.',
      },
      start_date: { type: 'string' as const, description: 'Inclusive start date, yyyy-MM-dd. Overrides `range`.' },
      end_date: { type: 'string' as const, description: 'Exclusive end date, yyyy-MM-dd. Defaults to today.' },
      interval: {
        type: 'string' as const,
        enum: INTERVALS,
        // Stated as a rule the model can apply before calling: picking the
        // interval after hitting the truncation warning costs a second round trip.
        description: 'Bar size. Default "1d". Match it to the window: "1h" covers about 5 weeks, "1d" about 2 years, '
          + '"1wk" about 8 years, "1mo" about 35 years. A window longer than the chosen interval '
          + 'can carry is trimmed to the most recent bars. The upstream source separately refuses "1h" data '
          + 'older than about 730 days regardless of window size.',
      },
      limit: {
        type: 'integer' as const,
        description: `Keep only the most recent N bars, 1 to ${MAX_LIMIT}. `
          + `Defaults to every bar in the window, capped at ${MAX_LIMIT}.`,
      },
    },
    output: jsonOutput(),
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => stringify(await getHistory(market, client, args, exec.signal)),
  })
}

export async function getHistory(
  market: string,
  client: YahooClient,
  args: HistoryArgs,
  signal?: AbortSignal,
): Promise<ToolEnvelope<Record<string, unknown>>> {
  return await guard(market, args.ticker, async () => {
    const request = buildRequest(args)
    const limit = resolveLimit(args.limit)
    const chart = await client.chart(args.ticker, request, signal)

    const meta = (typeof chart.meta === 'object' && chart.meta !== null ? chart.meta : {}) as Record<string, unknown>
    const rawQuotes = Array.isArray(chart.quotes) ? chart.quotes : []
    if (rawQuotes.length === 0) {
      throw new DataSourceError(
        'no_data',
        `No bars for "${args.ticker}" in the requested window. The symbol may be delisted or the window may predate its listing.`,
      )
    }

    const bars = rawQuotes
      .map((bar) => shapeBar(bar, request.interval))
      .filter((bar): bar is Record<string, unknown> => bar !== undefined)

    const build = (window: Record<string, unknown>[]): Record<string, unknown> => {
      const first = str(window[0]?.date)
      const last = str(window.at(-1)?.date)
      return {
        currency: str(meta.currency),
        exchange: str(meta.fullExchangeName) ?? str(meta.exchangeName),
        interval: request.interval,
        // Stated explicitly because the two bases are not interchangeable.
        price_adjustment: { ohlc: 'split-adjusted', adj_close: 'split-and-dividend-adjusted' },
        // Placed in the data, not just the tool description, because a model
        // deciding whether to build its own chart is reading this response, not
        // the description read at call time. Observed without it: the model
        // called this tool, a chart rendered, and it then spent a minute
        // installing matplotlib into a venv to draw a second one — unaware the
        // first request was already satisfied. Hedged because the server has no
        // way to know whether the connected client is the Web UI.
        chart_note: 'If the client is the DSH Web UI, this call already rendered a candlestick chart for the '
          + 'user in place of the generic result card. Do not build a separate chart from this data unless '
          + 'something the built-in chart cannot show is specifically needed.',
        bar_count: window.length,
        first_bar_date: first,
        last_bar_date: last,
        bars: window,
        ...shapeEvents(chart.events, first, last),
      }
    }

    const kept = fitToBudget(bars.slice(-limit), build)

    const warnings: string[] = []
    if (kept.length < bars.length) {
      const coarser = COARSER[request.interval]
      warnings.push(
        `Returned the most recent ${kept.length} of ${bars.length} bars, the most that fits the tool output budget. `
        + (coarser === undefined
          ? 'Narrow the window for earlier bars.'
          : `For the full span use \`interval: "${coarser}"\`, or narrow the window and page through it.`),
      )
    }

    return success(market, build(kept), { ticker: str(meta.symbol) ?? args.ticker, warnings })
  })
}

/**
 * Drop the oldest bars until the serialized payload fits the budget. Converges
 * in a couple of passes by scaling the window by the overshoot ratio rather than
 * stepping one bar at a time.
 */
function fitToBudget(
  bars: Record<string, unknown>[],
  build: (window: Record<string, unknown>[]) => Record<string, unknown>,
): Record<string, unknown>[] {
  let window = bars
  for (let pass = 0; pass < 6 && window.length > 1; pass += 1) {
    const size = JSON.stringify(build(window)).length
    if (size <= SAFE_OUTPUT_CHARACTERS) break
    // Shave an extra 2% so a near-miss does not cost another full pass.
    const next = Math.max(1, Math.floor(window.length * (SAFE_OUTPUT_CHARACTERS / size) * 0.98))
    if (next >= window.length) break
    window = window.slice(-next)
  }
  return window
}

/**
 * Corporate actions inside the returned window. Yahoo omits the `events` key
 * entirely for symbols that have never paid a dividend or split, and reports
 * events across the whole fetched range — which is wider than the bars actually
 * returned once `limit` bites, so they are clipped to the kept window.
 */
function shapeEvents(raw: unknown, first: string | undefined, last: string | undefined): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) return {}
  const events = raw as Record<string, unknown>

  const inWindow = (date: string | undefined): date is string => {
    if (date === undefined) return false
    if (first !== undefined && date < first) return false
    if (last !== undefined && date > last) return false
    return true
  }

  const dividends = (Array.isArray(events.dividends) ? events.dividends : [])
    .map((entry) => {
      const item = entry as Record<string, unknown>
      const date = isoDate(item.date)?.slice(0, 10)
      const amount = num(item.amount)
      return inWindow(date) && amount !== undefined ? { date, amount } : undefined
    })
    .filter((entry): entry is { date: string, amount: number } => entry !== undefined)

  const splits = (Array.isArray(events.splits) ? events.splits : [])
    .map((entry) => {
      const item = entry as Record<string, unknown>
      const date = isoDate(item.date)?.slice(0, 10)
      const ratio = str(item.splitRatio)
      if (!inWindow(date)) return undefined
      return compact({
        date,
        ratio,
        numerator: num(item.numerator),
        denominator: num(item.denominator),
      })
    })
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)

  return {
    ...(dividends.length > 0 ? { dividends } : {}),
    ...(splits.length > 0 ? { splits } : {}),
  }
}

function buildRequest(args: HistoryArgs): ChartRequest {
  const interval = normalizeEnum(args.interval, INTERVALS, '1d' as Interval, 'interval')

  if (args.start_date !== undefined) {
    const period1 = parseDate(args.start_date, 'start_date')
    const period2 = args.end_date === undefined ? undefined : parseDate(args.end_date, 'end_date')
    if (period2 !== undefined && period2 <= period1) {
      throw new DataSourceError('invalid_argument', '`end_date` must be later than `start_date`.')
    }
    return { period1, ...(period2 === undefined ? {} : { period2 }), interval }
  }

  const range = normalizeEnum(args.range, RANGES, '1y' as Range, 'range')
  return { period1: rangeStart(range), interval }
}

/** Yahoo's chart endpoint takes an explicit start date rather than a range token. */
function rangeStart(range: Range): Date {
  if (range === 'max') return new Date('1970-01-01T00:00:00Z')
  const now = new Date()
  const start = new Date(now)
  switch (range) {
    case '5d': start.setUTCDate(now.getUTCDate() - 7); break
    case '1mo': start.setUTCMonth(now.getUTCMonth() - 1); break
    case '3mo': start.setUTCMonth(now.getUTCMonth() - 3); break
    case '6mo': start.setUTCMonth(now.getUTCMonth() - 6); break
    case '1y': start.setUTCFullYear(now.getUTCFullYear() - 1); break
    case '2y': start.setUTCFullYear(now.getUTCFullYear() - 2); break
    case '5y': start.setUTCFullYear(now.getUTCFullYear() - 5); break
    case '10y': start.setUTCFullYear(now.getUTCFullYear() - 10); break
  }
  return start
}

function parseDate(value: string, field: string): Date {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new DataSourceError('invalid_argument', `\`${field}\` is not a valid date: ${JSON.stringify(value)}. Use yyyy-MM-dd.`)
  }
  return parsed
}

function normalizeEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
  field: string,
): T {
  if (value === undefined) return fallback
  if ((allowed as readonly string[]).includes(value)) return value as T
  throw new DataSourceError(
    'invalid_argument',
    `\`${field}\` must be one of ${allowed.join(', ')}; got ${JSON.stringify(value)}.`,
  )
}

/** Absent `limit` means "everything in the window", bounded by the output budget. */
function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return MAX_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new DataSourceError('invalid_argument', `\`limit\` must be an integer between 1 and ${MAX_LIMIT}; got ${limit}.`)
  }
  return limit
}

function shapeBar(raw: unknown, interval: Interval): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const bar = raw as Record<string, unknown>
  const date = isoDate(bar.date)
  const close = num(bar.close)
  // Yahoo emits placeholder rows with null OHLC on non-trading days.
  if (date === undefined || close === undefined) return undefined
  return compact({
    // Daily bars and coarser carry no meaningful time of day, so they stay
    // date-only as every response did before hourly bars existed. Hourly bars
    // keep the full timestamp: slicing it to a date collapsed a whole trading
    // day's worth of bars onto one identical date string, which also broke
    // first_bar_date/last_bar_date and the client's per-candle x-axis labels.
    date: interval === '1h' ? date : date.slice(0, 10),
    open: round(bar.open, 4),
    high: round(bar.high, 4),
    low: round(bar.low, 4),
    close: round(close, 4),
    adj_close: round(bar.adjclose, 4),
    volume: num(bar.volume),
  })
}
