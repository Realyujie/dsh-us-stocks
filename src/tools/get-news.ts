import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { YahooClient } from '../datasource/us/yahoo-client.ts'
import { DataSourceError, guard, success, type ToolEnvelope } from '../util/errors.ts'
import { stringify } from '../util/stringify.ts'
import { compact, isoDate, jsonOutput, str, tickerSchema, TOOL_TIMEOUT_MS } from './shared.ts'

const DEFAULT_LIMIT = 10
/** Yahoo's search endpoint returns at most 10 news items whatever `newsCount` asks for. */
const MAX_LIMIT = 10

interface NewsArgs {
  readonly ticker: string
  readonly limit?: number
}

export function createGetNewsTool(market: string, client: YahooClient): ToolDefinition {
  return defineTool({
    name: 'get_news',
    description:
      'Get recent news headlines for a US stock: title, publisher, publication time and link. '
      + 'Returns metadata only — article bodies are not fetched. Newest first. '
      + 'Only headlines that actually reference the symbol are returned; the upstream search matches text, '
      + 'so tickers that are also ordinary words would otherwise pull in unrelated stories. '
      + `The upstream source caps results at ${MAX_LIMIT} headlines.`,
    parameters: {
      ticker: tickerSchema('Stock symbol, e.g. "AAPL".'),
      limit: {
        type: 'integer' as const,
        description: `Number of headlines, 1 to ${MAX_LIMIT} (upstream maximum). Default ${DEFAULT_LIMIT}.`,
      },
    },
    output: jsonOutput(),
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => stringify(await getNews(market, client, args, exec.signal)),
  })
}

export async function getNews(
  market: string,
  client: YahooClient,
  args: NewsArgs,
  signal?: AbortSignal,
): Promise<ToolEnvelope<Record<string, unknown>>> {
  return await guard(market, args.ticker, async () => {
    const limit = resolveLimit(args.limit)
    // `quotesCount: 1` both confirms the symbol and yields the company name used
    // by the second pass below.
    const first = await client.search(args.ticker, { newsCount: MAX_LIMIT, quotesCount: 1 }, signal)

    const quotes = Array.isArray(first.quotes) ? first.quotes : []
    const resolved = quotes.length > 0 ? (quotes[0] as Record<string, unknown>) : undefined
    if (resolved === undefined) {
      throw new DataSourceError('unknown_symbol', `"${args.ticker}" did not resolve to any instrument.`)
    }
    const symbol = str(resolved.symbol) ?? args.ticker.toUpperCase()
    const companyName = str(resolved.longname) ?? str(resolved.shortname)

    // Both keyed by upstream id: the two passes overlap, and a headline seen
    // twice is still one headline.
    const pool = new Map<string, Record<string, unknown>>()
    const rejected = new Set<string>()
    collect(pool, rejected, first.news, symbol)

    // Yahoo's news search matches text, so a ticker that is also an ordinary
    // word pulls in unrelated stories — "ALL" returned a Finnish bank tender
    // offer, "KEY" returned UK property filings. Searching the company name
    // recovers the real coverage, but is not uniformly better, so it runs only
    // when matching on the symbol came up short.
    if (pool.size < limit && companyName !== undefined) {
      const second = await client.search(companyName, { newsCount: MAX_LIMIT, quotesCount: 0 }, signal)
      collect(pool, rejected, second.news, symbol)
    }

    const articles = [...pool.values()].sort(byPublishedDescending).slice(0, limit)

    if (articles.length === 0) {
      throw new DataSourceError(
        'no_data',
        rejected.size === 0
          ? `No recent news indexed for "${args.ticker}".`
          : `Found ${rejected.size} headlines matching "${args.ticker}" but none reference the symbol, so all were `
            + 'discarded as text-search noise. This happens when a ticker is also a common word.',
      )
    }

    const discarded = rejected.size
    const warnings = discarded > 0
      ? [`Discarded ${discarded} headline${discarded === 1 ? '' : 's'} that did not reference ${symbol}.`]
      : []

    return success(market, {
      article_count: articles.length,
      articles,
    }, { ticker: symbol, warnings })
  })
}

/**
 * Sort articles into `pool` if they reference `symbol` and `rejected` if they
 * do not. Both are keyed by the upstream id, so a headline returned by both
 * passes is counted once.
 */
function collect(
  pool: Map<string, Record<string, unknown>>,
  rejected: Set<string>,
  raw: unknown,
  symbol: string,
): void {
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (typeof entry !== 'object' || entry === null) continue
    const item = entry as Record<string, unknown>
    const article = shapeArticle(item)
    const key = str(item.uuid) ?? str(item.link) ?? str(item.title)
    if (key === undefined) continue

    const related = Array.isArray(item.relatedTickers) ? item.relatedTickers : []
    const references = related.some((ticker) => typeof ticker === 'string' && ticker.toUpperCase() === symbol)
    if (!references) {
      rejected.add(key)
      continue
    }
    // Titleless entries are unusable even when they do reference the symbol.
    if (article !== undefined) pool.set(key, article)
  }
}

function shapeArticle(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const item = raw as Record<string, unknown>
  const title = str(item.title)
  if (title === undefined) return undefined
  const relatedTickers = Array.isArray(item.relatedTickers)
    ? item.relatedTickers.filter((ticker): ticker is string => typeof ticker === 'string')
    : []
  return compact({
    title,
    publisher: str(item.publisher),
    published_at: isoDate(item.providerPublishTime),
    link: str(item.link),
    type: str(item.type),
    related_tickers: relatedTickers.length > 0 ? relatedTickers : undefined,
  })
}

function byPublishedDescending(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const left = typeof a.published_at === 'string' ? Date.parse(a.published_at) : 0
  const right = typeof b.published_at === 'string' ? Date.parse(b.published_at) : 0
  return right - left
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new DataSourceError('invalid_argument', `\`limit\` must be an integer between 1 and ${MAX_LIMIT}; got ${limit}.`)
  }
  return limit
}
