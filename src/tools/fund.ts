/**
 * ETF and mutual-fund detail, from the `quoteSummary` modules that carry
 * nothing for an ordinary equity.
 *
 * Split out of `get-quote` because it is a different upstream call under a
 * different validation regime: `fundProfile` embeds a `FundProfileBrokerage`
 * definition the library's schema rejects, so this module must opt out of
 * validation and narrow every field by hand — the contract `YahooClient.
 * quoteSummary` documents for `validateResult: false` callers.
 */

import type { YahooClient } from '../datasource/us/yahoo-client.ts'
import { compact, num, round, str } from './shared.ts'

const MODULES = ['fundProfile', 'defaultKeyStatistics', 'topHoldings', 'fundPerformance'] as const

/**
 * Quote types that carry fund modules. Mutual funds are included deliberately:
 * they report the same four modules with the same shapes, and gating on `ETF`
 * alone silently drops every `VFIAX`-style symbol.
 */
const FUND_QUOTE_TYPES: ReadonlySet<string> = new Set(['ETF', 'MUTUALFUND'])

export function isFundQuoteType(quoteType: unknown): boolean {
  return typeof quoteType === 'string' && FUND_QUOTE_TYPES.has(quoteType)
}

/**
 * Fetch and shape fund detail. Returns `undefined` when upstream carries none,
 * so the caller can fall through to a plain quote rather than fail: the quote
 * itself already succeeded, and a fund whose profile is missing is still worth
 * reporting at its price.
 */
export async function fetchFundDetail(
  client: YahooClient,
  ticker: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  const summary = await client.quoteSummary(ticker, MODULES, signal, { validateResult: false })
  const shaped = shapeFund(summary)
  return Object.keys(shaped).length === 0 ? undefined : shaped
}

export function shapeFund(summary: Record<string, unknown>): Record<string, unknown> {
  const profile = record(summary.fundProfile)
  const stats = record(summary.defaultKeyStatistics)
  const holdings = record(summary.topHoldings)
  const performance = record(summary.fundPerformance)

  const fees = record(profile.feesExpensesInvestment)
  const categoryFees = record(profile.feesExpensesInvestmentCat)
  const positions = shapeAllocation(holdings)
  const returns = shapeReturns(record(performance.trailingReturns))
  const topHoldings = shapeHoldings(holdings.holdings)
  const coverage = topHoldings === undefined
    ? undefined
    : round(topHoldings.reduce((total, holding) => total + (num(holding.weight_percent) ?? 0), 0), 2)

  // Expense ratios keep four decimals because they are small and compared
  // closely — 0.0945% against 0.03% is a real difference. Weights and returns
  // are rounded harder: a holding weight to four decimals implies a precision
  // the fund's own disclosure does not have.
  const expenseRatio = percent(fees.annualReportExpenseRatio, 4)

  const fund = compact({
    fund_expense_ratio_percent: expenseRatio,
    /** Category average, so a bare expense ratio can be read as cheap or dear. */
    fund_expense_ratio_category_percent: percent(categoryFees.annualReportExpenseRatio, 4),
    fund_total_assets: num(stats.totalAssets),
    fund_category: str(stats.category) ?? str(profile.categoryName),
    fund_family: str(stats.fundFamily) ?? str(profile.family),
    fund_legal_type: str(stats.legalType) ?? str(profile.legalType),
    fund_asset_allocation_percent: positions,
    fund_trailing_returns_percent: returns,
    fund_top_holdings: topHoldings,
    /**
     * How much of the fund the listed positions add up to. Reported alongside
     * them because the share varies enormously — a measured 14% for VXUS
     * against 73% for XLE — and the list reads like a complete one without it.
     */
    fund_top_holdings_coverage_percent: coverage,
  })

  // Notes qualify the fields above, so they follow rather than lead: a symbol
  // whose fund modules all came back empty gets nothing at all, instead of
  // advice about figures that are not in the response.
  if (Object.keys(fund).length === 0) return {}

  return {
    ...fund,
    fund_notes: notes({
      hasExpenseRatio: expenseRatio !== undefined,
      hasHoldings: topHoldings !== undefined,
    }),
  }
}

/**
 * Reading caveats that belong in the payload rather than the tool description:
 * the model deciding how to phrase a number is looking at the response. Each is
 * emitted only when the field it qualifies is actually present, so a commodity
 * ETF with no holdings does not carry advice about holdings.
 */
function notes(present: { hasExpenseRatio: boolean, hasHoldings: boolean }): Record<string, string> | undefined {
  const result = compact({
    // Observed live: a model read an ETF's `trailing_pe` as the fund being
    // expensively valued, with no way to tell it aggregates ~70 holdings.
    equity_ratios: 'For a fund, `trailing_pe`, `price_to_book`, `book_value_per_share` and '
      + '`eps_trailing_twelve_months` are holdings-weighted aggregates of what the fund owns, not one '
      + "company's own figures.",
    expense_ratio: present.hasExpenseRatio
      ? 'As reported upstream, and occasionally wrong — FXAIX has been observed at 0.42% against a true '
        + '0.015%. Sanity-check it before ranking funds on cost.'
      : undefined,
    top_holdings: present.hasHoldings
      ? 'Upstream returns at most 10 positions, so this is not a complete holdings list. Overlap between '
        + 'two funds cannot be computed from it.'
      : undefined,
  })
  return Object.keys(result).length === 0 ? undefined : result as Record<string, string>
}

function shapeAllocation(holdings: Record<string, unknown>): Record<string, unknown> | undefined {
  const allocation = compact({
    stock: percent(holdings.stockPosition, 2),
    bond: percent(holdings.bondPosition, 2),
    cash: percent(holdings.cashPosition, 2),
    other: percent(holdings.otherPosition, 2),
  })
  return Object.keys(allocation).length === 0 ? undefined : allocation
}

/**
 * Upstream switches convention partway through this object: everything up to a
 * year is the plain return over the window, while the multi-year figures are
 * annualised. Verified against SPY — a reported `fiveYear` of 12.76% against an
 * actual 83.95% cumulative, which annualises to 12.96%.
 *
 * The longer keys carry `_annualized` because a uniform `three_year` beside
 * `one_year` reads as one convention throughout, and the two differ by a factor
 * of four over five years. Naming it is the same fix `debt_to_equity_percent`
 * applies to Yahoo's other silent convention.
 */
function shapeReturns(trailing: Record<string, unknown>): Record<string, unknown> | undefined {
  const returns = compact({
    ytd: percent(trailing.ytd, 2),
    one_month: percent(trailing.oneMonth, 2),
    three_month: percent(trailing.threeMonth, 2),
    one_year: percent(trailing.oneYear, 2),
    three_year_annualized: percent(trailing.threeYear, 2),
    five_year_annualized: percent(trailing.fiveYear, 2),
    ten_year_annualized: percent(trailing.tenYear, 2),
  })
  return Object.keys(returns).length === 0 ? undefined : returns
}

function shapeHoldings(raw: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const holdings = raw.flatMap((entry) => {
    const holding = record(entry)
    const weight = percent(holding.holdingPercent, 2)
    const symbol = str(holding.symbol)
    if (weight === undefined || symbol === undefined) return []
    return [compact({ symbol, name: str(holding.holdingName), weight_percent: weight })]
  })
  return holdings.length === 0 ? undefined : holdings
}

/**
 * Upstream reports these as fractions (0.000945). Every field fed through here
 * is named `_percent` so the 100x scaling is stated where it is read, the same
 * way `debt_to_equity_percent` names Yahoo's scaling in `get_financials`.
 */
function percent(value: unknown, digits: number): number | undefined {
  const raw = num(value)
  return raw === undefined ? undefined : round(raw * 100, digits)
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}
