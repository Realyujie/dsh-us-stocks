import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { FundamentalsModule, FundamentalsPeriod, YahooClient } from '../datasource/us/yahoo-client.ts'
import { DataSourceError, guard, success, type ToolEnvelope } from '../util/errors.ts'
import { stringify } from '../util/stringify.ts'
import { compact, isoDate, jsonOutput, num, str, tickerSchema, TOOL_TIMEOUT_MS } from './shared.ts'

const STATEMENTS = ['income', 'balance', 'cash_flow'] as const
const PERIODS = ['quarterly', 'annual'] as const
const DETAILS = ['summary', 'full'] as const
const DEFAULT_LIMIT = 4

/**
 * Upstream depth is fixed and cannot be widened by asking for an earlier
 * `period1`: measured against AAPL back to 2000, the income statement and cash
 * flow return 5 periods and the balance sheet 7, quarterly or annual alike.
 * The ceiling sits just above that so the argument never promises more than
 * the source can deliver.
 */
const MAX_LIMIT = 8

type Statement = typeof STATEMENTS[number]

const MODULE_BY_STATEMENT: Record<Statement, FundamentalsModule> = {
  income: 'financials',
  balance: 'balance-sheet',
  cash_flow: 'cash-flow',
}

/**
 * Line items kept in `summary` mode. The full response carries 35-75 fields per
 * period per statement, which blows the output budget once several periods are
 * requested, so the default is the set an analyst actually reads first.
 */
const SUMMARY_FIELDS: Record<Statement, readonly string[]> = {
  income: [
    'totalRevenue', 'costOfRevenue', 'grossProfit', 'operatingExpense', 'operatingIncome',
    'EBIT', 'EBITDA', 'pretaxIncome', 'taxProvision', 'netIncome',
    'netIncomeCommonStockholders', 'basicEPS', 'dilutedEPS', 'interestExpense',
    'dilutedAverageShares', 'researchAndDevelopment',
  ],
  balance: [
    'totalAssets', 'currentAssets', 'cashAndCashEquivalents',
    'cashCashEquivalentsAndShortTermInvestments', 'receivables', 'inventory', 'netPPE',
    'goodwill', 'totalLiabilitiesNetMinorityInterest', 'currentLiabilities', 'payables',
    'totalDebt', 'longTermDebt', 'netDebt', 'stockholdersEquity', 'workingCapital',
    'investedCapital', 'tangibleBookValue', 'ordinarySharesNumber',
  ],
  cash_flow: [
    'operatingCashFlow', 'investingCashFlow', 'financingCashFlow', 'freeCashFlow',
    'capitalExpenditure', 'depreciationAndAmortization', 'changeInWorkingCapital',
    'stockBasedCompensation', 'repurchaseOfCapitalStock', 'cashDividendsPaid',
    'netIncomeFromContinuingOperations', 'endCashPosition', 'changesInCash',
  ],
}

interface FinancialsArgs {
  readonly ticker: string
  readonly period?: string
  readonly statements?: readonly string[]
  readonly limit?: number
  readonly detail?: string
}

export function createGetFinancialsTool(market: string, client: YahooClient): ToolDefinition {
  return defineTool({
    name: 'get_financials',
    description:
      'Get reported income statement, balance sheet and cash flow line items for a US stock, quarterly or annual: '
      + 'revenue, gross profit, operating income, EBIT/EBITDA, net income and reported basic and diluted EPS; '
      + 'total assets, inventory, total and long-term debt, shareholders equity and working capital; '
      + 'operating and free cash flow, capital expenditure, buybacks and dividends paid. '
      + 'This is the tool for EPS, revenue and margins as actually reported in a given period — '
      + '`get_quote` carries only the current trailing and forward figures, and `get_analyst_view` carries forecasts. '
      + 'Also returns a `ratios` block of trailing-twelve-month margins, returns on assets and equity, '
      + 'revenue and earnings growth, leverage and liquidity ratios; its margins and growth rates are '
      + 'unitless fractions, so 0.27 means 27%, while `debt_to_equity_percent` is already scaled by 100. '
      + 'Periods are ordered oldest to newest. Figures are unscaled and denominated in `reporting_currency`, '
      + 'which for an ADR is the home-market currency, not USD — check it before comparing across companies. '
      + 'Request fewer statements or a smaller `limit` if the response is truncated.',
    parameters: {
      ticker: tickerSchema('Stock symbol, e.g. "AAPL".'),
      period: {
        type: 'string' as const,
        enum: PERIODS,
        description: 'Reporting period. Default "quarterly".',
      },
      statements: {
        type: 'array' as const,
        items: { type: 'string' as const, enum: STATEMENTS },
        description: 'Which statements to return. Default all three.',
      },
      limit: {
        type: 'integer' as const,
        description: `Number of most recent periods, 1 to ${MAX_LIMIT}. Default ${DEFAULT_LIMIT}. `
          + 'The source itself holds only about 5 periods of income statement and cash flow, and 7 of '
          + 'balance sheet, so asking for more returns everything available rather than failing.',
      },
      detail: {
        type: 'string' as const,
        enum: DETAILS,
        description: '"summary" returns headline line items (default); "full" returns every reported field and is much larger.',
      },
    },
    output: jsonOutput(),
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => stringify(await getFinancials(market, client, args, exec.signal)),
  })
}

export async function getFinancials(
  market: string,
  client: YahooClient,
  args: FinancialsArgs,
  signal?: AbortSignal,
): Promise<ToolEnvelope<Record<string, unknown>>> {
  return await guard(market, args.ticker, async () => {
    const period = normalizeEnum(args.period, PERIODS, 'quarterly', 'period') as FundamentalsPeriod
    const detail = normalizeEnum(args.detail, DETAILS, 'summary', 'detail')
    const limit = resolveLimit(args.limit)
    const statements = resolveStatements(args.statements)
    const period1 = lookbackStart(period, limit)

    const warnings: string[] = []

    // Fetched alongside the statements: the reporting currency is not carried in
    // the fundamentals rows, and without it an ADR's figures are silently
    // misread. TSM files in TWD, SAP in EUR, BABA in CNY, NVO in DKK, while all
    // four trade in USD — comparing raw revenue across them is off by ~32x for
    // TSM. The quote is cached and runs in parallel, so it costs nothing.
    const [reportingCurrency, ratios, fetched] = await Promise.all([
      resolveReportingCurrency(client, args.ticker, signal),
      resolveRatios(client, args.ticker, signal),
      Promise.all(statements.map(async (statement) => {
        const rows = await client.fundamentals(args.ticker, MODULE_BY_STATEMENT[statement], period, period1, signal)
        return [statement, rows] as const
      })),
    ])

    const data: Record<string, unknown> = compact({
      period,
      detail,
      requested_periods: limit,
      reporting_currency: reportingCurrency,
      ratios,
    })
    if (reportingCurrency === undefined) {
      warnings.push('Reporting currency could not be determined; do not assume the figures are in USD.')
    }

    let totalRows = 0
    for (const [statement, rows] of fetched) {
      const kept = rows.slice(-limit).map((row) => shapeRow(row, statement, detail === 'full'))
      totalRows += kept.length
      if (kept.length === 0) warnings.push(`No ${statement} data reported for "${args.ticker}" at ${period} frequency.`)
      data[statement] = kept
    }

    if (totalRows === 0) {
      throw new DataSourceError(
        'no_data',
        `No ${period} financial statements reported for "${args.ticker}". Funds, ETFs and some ADRs do not file these.`,
      )
    }

    return success(market, data, { ticker: args.ticker, warnings })
  })
}

/**
 * Reporting currency, which for an ADR differs from the trading currency. A
 * failure here must not sink the statements themselves — the caller is warned
 * instead, since unlabelled figures are still usable when the reader knows they
 * are unlabelled.
 */
/**
 * Trailing-twelve-month ratios and growth rates, which the per-period statements
 * do not carry. Best-effort: funds and ETFs have no fundamentals module at all,
 * and their absence must not fail a request whose statements did resolve.
 *
 * Monetary members are in the reporting currency; margins, returns and growth
 * rates are unitless fractions where 0.27 means 27%.
 *
 * `debtToEquity` is the exception — Yahoo scales it by 100, so AAPL's 0.784x
 * arrives as 78.445. It is renamed rather than rescaled so the value still
 * matches other tools reporting the same figure.
 */
async function resolveRatios(
  client: YahooClient,
  ticker: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  let financialData: Record<string, unknown>
  try {
    const summary = await client.quoteSummary(ticker, ['financialData'], signal)
    const body = summary.financialData
    if (typeof body !== 'object' || body === null) return undefined
    financialData = body as Record<string, unknown>
  } catch {
    return undefined
  }

  const ratios = compact({
    basis: 'trailing_twelve_months',
    gross_margin: num(financialData.grossMargins),
    operating_margin: num(financialData.operatingMargins),
    ebitda_margin: num(financialData.ebitdaMargins),
    profit_margin: num(financialData.profitMargins),
    return_on_assets: num(financialData.returnOnAssets),
    return_on_equity: num(financialData.returnOnEquity),
    revenue_growth: num(financialData.revenueGrowth),
    earnings_growth: num(financialData.earningsGrowth),
    debt_to_equity_percent: num(financialData.debtToEquity),
    current_ratio: num(financialData.currentRatio),
    quick_ratio: num(financialData.quickRatio),
    revenue_ttm: num(financialData.totalRevenue),
    gross_profit_ttm: num(financialData.grossProfits),
    ebitda_ttm: num(financialData.ebitda),
    free_cash_flow_ttm: num(financialData.freeCashflow),
    operating_cash_flow_ttm: num(financialData.operatingCashflow),
    total_cash: num(financialData.totalCash),
    total_debt: num(financialData.totalDebt),
  })

  // `basis` alone means nothing came back.
  return Object.keys(ratios).length > 1 ? ratios : undefined
}

async function resolveReportingCurrency(
  client: YahooClient,
  ticker: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const quote = await client.quote(ticker, signal)
    return str(quote.financialCurrency) ?? str(quote.currency)
  } catch {
    return undefined
  }
}

function shapeRow(row: Record<string, unknown>, statement: Statement, full: boolean): Record<string, unknown> {
  const shaped: Record<string, unknown> = compact({
    period_end: isoDate(row.date)?.slice(0, 10),
    period_type: typeof row.periodType === 'string' ? row.periodType : undefined,
  })

  const fields = full ? Object.keys(row) : SUMMARY_FIELDS[statement]
  for (const field of fields) {
    if (field === 'date' || field === 'periodType') continue
    const value = num(row[field])
    if (value !== undefined) shaped[field] = value
  }
  return shaped
}

/**
 * `fundamentalsTimeSeries` filters by start date, not by period count, so ask
 * for a generous window and trim to `limit` afterwards.
 */
function lookbackStart(period: FundamentalsPeriod, limit: number): string {
  const start = new Date()
  if (period === 'quarterly') start.setUTCMonth(start.getUTCMonth() - (limit + 2) * 3)
  else start.setUTCFullYear(start.getUTCFullYear() - (limit + 1))
  return start.toISOString().slice(0, 10)
}

function resolveStatements(requested: readonly string[] | undefined): Statement[] {
  if (requested === undefined || requested.length === 0) return [...STATEMENTS]
  const resolved: Statement[] = []
  for (const item of requested) {
    if (!(STATEMENTS as readonly string[]).includes(item)) {
      throw new DataSourceError(
        'invalid_argument',
        `\`statements\` entries must be one of ${STATEMENTS.join(', ')}; got ${JSON.stringify(item)}.`,
      )
    }
    if (!resolved.includes(item as Statement)) resolved.push(item as Statement)
  }
  return resolved
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

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new DataSourceError('invalid_argument', `\`limit\` must be an integer between 1 and ${MAX_LIMIT}; got ${limit}.`)
  }
  return limit
}
