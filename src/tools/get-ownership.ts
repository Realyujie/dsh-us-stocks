import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { YahooClient } from '../datasource/us/yahoo-client.ts'
import { classify, DataSourceError, guard, success, type ToolEnvelope } from '../util/errors.ts'
import { stringify } from '../util/stringify.ts'
import { compact, isoDate, jsonOutput, num, round, str, tickerSchema, TOOL_TIMEOUT_MS } from './shared.ts'

/**
 * Individual filings are fetched only for `detail: "full"`. They are the bulk
 * of the payload — 150 transactions for AMZN, 16-32K characters raw — while the
 * three summary modules together are under 5K.
 */
const SUMMARY_MODULES = ['majorHoldersBreakdown', 'netSharePurchaseActivity', 'institutionOwnership', 'fundOwnership'] as const
const FULL_MODULES = [...SUMMARY_MODULES, 'insiderTransactions', 'insiderHolders'] as const

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

type Detail = 'summary' | 'full'

interface OwnershipArgs {
  readonly ticker: string
  readonly detail?: string
  readonly limit?: number
}

export function createGetOwnershipTool(market: string, client: YahooClient): ToolDefinition {
  return defineTool({
    name: 'get_ownership',
    description:
      'Get who owns a US stock and whether insiders are buying or selling: the split between insider and '
      + 'institutional holdings, the largest institutional and fund holders with their stakes and quarterly '
      + 'position changes, and insiders\' aggregate buying and selling over the last six months. '
      + '`detail: "full"` adds individual insider filings — date, name, transaction and share count — and the '
      + 'named insiders with their current holdings. '
      + 'Answers "who is buying this stock", "is it institutionally held", "have insiders been selling". '
      + 'Ownership figures come from quarterly 13F filings and lag the market by up to a quarter; each holder '
      + 'carries the `report_date` its numbers are as of. Funds and ETFs have no such data.',
    parameters: {
      ticker: tickerSchema('Stock symbol, e.g. "AAPL".'),
      detail: {
        type: 'string' as const,
        enum: ['summary', 'full'],
        description: 'Default "summary" — breakdown, top holders and the six-month insider aggregate. '
          + '"full" also returns individual insider filings, which are most of the payload.',
      },
      limit: {
        type: 'integer' as const,
        description: `Rows per list, 1 to ${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.`,
      },
    },
    output: jsonOutput(),
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => stringify(await getOwnership(market, client, args, exec.signal)),
  })
}

export async function getOwnership(
  market: string,
  client: YahooClient,
  args: OwnershipArgs,
  signal?: AbortSignal,
): Promise<ToolEnvelope<Record<string, unknown>>> {
  return await guard(market, args.ticker, async () => {
    const detail = resolveDetail(args.detail)
    const limit = resolveLimit(args.limit)
    const modules = detail === 'full' ? FULL_MODULES : SUMMARY_MODULES
    const summary = await fetchOwnership(client, args.ticker, modules, signal)

    const breakdown = shapeBreakdown(record(summary.majorHoldersBreakdown))
    const insiderActivity = shapeInsiderActivity(record(summary.netSharePurchaseActivity))
    const institutionalActivity = shapeInstitutionalActivity(record(summary.netSharePurchaseActivity))
    const institutions = shapeHolders(record(summary.institutionOwnership).ownershipList, limit)
    const funds = shapeHolders(record(summary.fundOwnership).ownershipList, limit)
    const transactions = detail === 'full'
      ? shapeTransactions(record(summary.insiderTransactions).transactions, limit)
      : undefined
    const insiders = detail === 'full'
      ? shapeInsiders(record(summary.insiderHolders).holders, limit)
      : undefined

    const data = compact({
      detail,
      ownership_breakdown: breakdown,
      insider_activity: insiderActivity,
      institutional_activity: institutionalActivity,
      top_institutional_holders: institutions,
      top_fund_holders: funds,
      insider_transactions: transactions,
      insider_holders: insiders,
      /**
       * Stated in the payload rather than only the description: a model
       * comparing this against a news story about one insider needs to know the
       * aggregate is a different measurement, not a contradiction. Observed
       * without it — insiders were reported as selling on the strength of one
       * large filing, while the six-month net was positive.
       */
      ownership_note: 'Holder figures come from quarterly 13F filings and are as of each row\'s `report_date`, '
        + 'not today. `insider_activity` aggregates every insider over six months, so it can be net positive '
        + 'while a single well-publicised insider was selling.',
    })

    if (breakdown === undefined && institutions === undefined && funds === undefined) {
      throw new DataSourceError('no_data', `No ownership data reported for "${args.ticker}".`)
    }

    return success(market, data, { ticker: args.ticker })
  })
}

/**
 * Upstream answers a fund with "No fundamentals data found for symbol: XLK".
 * An ETF has holders, but nobody files 13Fs against it the way they do against
 * a company, and no insider reports transactions in it — so the gap is
 * permanent rather than a fault, and worth saying plainly.
 */
async function fetchOwnership(
  client: YahooClient,
  ticker: string,
  modules: readonly string[],
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  try {
    // `insiderTransactions` carries free-text descriptions that have outrun the
    // library's schema before, and one bad row would sink the whole response.
    return await client.quoteSummary(ticker, modules, signal, { validateResult: false })
  } catch (error) {
    if (classify(error).kind !== 'no_data') throw error
    throw new DataSourceError(
      'no_data',
      `No ownership data for "${ticker}". Institutional and insider filings are made against operating `
      + 'companies, so ETFs and funds carry none. For a fund\'s own holdings, use `get_quote`.',
      { cause: error },
    )
  }
}

function shapeBreakdown(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const breakdown = compact({
    insiders_percent: percent(raw.insidersPercentHeld),
    institutions_percent: percent(raw.institutionsPercentHeld),
    /** Of the free float rather than of shares outstanding; the two differ. */
    institutions_percent_of_float: percent(raw.institutionsFloatPercentHeld),
    institutions_count: num(raw.institutionsCount),
  })
  return Object.keys(breakdown).length === 0 ? undefined : breakdown
}

function shapeInsiderActivity(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const activity = compact({
    period: str(raw.period),
    buy_count: num(raw.buyInfoCount),
    buy_shares: num(raw.buyInfoShares),
    sell_count: num(raw.sellInfoCount),
    sell_shares: num(raw.sellInfoShares),
    /** Positive when insiders bought more shares than they sold over the period. */
    net_shares: num(raw.netInfoShares),
    total_insider_shares: num(raw.totalInsiderShares),
  })
  return Object.keys(activity).length === 0 ? undefined : activity
}

/**
 * Institutions, not insiders — reported by upstream inside the same module as
 * the insider counts, which is where it lived here at first. A path reading
 * `insider_activity.net_institutional_shares` says one thing and carries
 * another, so the two are siblings instead.
 *
 * No `period`: the module's `6m` sits beside the insider counts, while
 * institutional positions come from quarterly 13Fs. Upstream never says which
 * window this figure spans, so neither does this.
 */
function shapeInstitutionalActivity(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const activity = compact({
    /** Negative when institutions reduced their holdings overall. */
    net_shares: num(raw.netInstSharesBuying),
    net_percent: percent(raw.netInstBuyingPercent),
  })
  return Object.keys(activity).length === 0 ? undefined : activity
}

function shapeHolders(raw: unknown, limit: number): Record<string, unknown>[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const holders = raw.flatMap((entry) => {
    const holder = record(entry)
    const organization = str(holder.organization)
    if (organization === undefined) return []
    return [compact({
      organization,
      percent_held: percent(holder.pctHeld),
      shares: num(holder.position),
      value: num(holder.value),
      /** Change in the position over the quarter, as reported. */
      position_change_percent: percent(holder.pctChange),
      report_date: isoDate(holder.reportDate)?.slice(0, 10),
    })]
  })
  return holders.length === 0 ? undefined : holders.slice(0, limit)
}

function shapeTransactions(raw: unknown, limit: number): Record<string, unknown>[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const transactions = raw.flatMap((entry) => {
    const transaction = record(entry)
    const date = isoDate(transaction.startDate)?.slice(0, 10)
    if (date === undefined) return []
    return [compact({
      date,
      name: str(transaction.filerName),
      relation: str(transaction.filerRelation),
      // Upstream free text, e.g. "Sale at price 286.41 per share." Kept verbatim
      // rather than parsed: the wording carries gifts, awards and conversions
      // that no fixed enum here would cover.
      transaction: str(transaction.transactionText),
      shares: num(transaction.shares),
      value: num(transaction.value),
    })]
  })
  return transactions.length === 0 ? undefined : transactions.slice(0, limit)
}

function shapeInsiders(raw: unknown, limit: number): Record<string, unknown>[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const insiders = raw.flatMap((entry) => {
    const insider = record(entry)
    const name = str(insider.name)
    if (name === undefined) return []
    return [compact({
      name,
      relation: str(insider.relation),
      latest_transaction: str(insider.transactionDescription),
      latest_transaction_date: isoDate(insider.latestTransDate)?.slice(0, 10),
      shares_held: num(insider.positionDirect),
    })]
  })
  return insiders.length === 0 ? undefined : insiders.slice(0, limit)
}

function resolveDetail(detail: string | undefined): Detail {
  if (detail === undefined) return 'summary'
  if (detail !== 'summary' && detail !== 'full') {
    throw new DataSourceError('invalid_argument', `\`detail\` must be "summary" or "full"; got "${detail}".`)
  }
  return detail
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new DataSourceError('invalid_argument', `\`limit\` must be an integer between 1 and ${MAX_LIMIT}; got ${limit}.`)
  }
  return limit
}

/** Upstream reports these as fractions; the `_percent` names carry the 100x. */
function percent(value: unknown): number | undefined {
  const raw = num(value)
  return raw === undefined ? undefined : round(raw * 100, 2)
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}
