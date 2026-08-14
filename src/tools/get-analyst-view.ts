import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { YahooClient } from '../datasource/us/yahoo-client.ts'
import { DataSourceError, guard, success, type ToolEnvelope } from '../util/errors.ts'
import { stringify } from '../util/stringify.ts'
import { compact, isoDate, jsonOutput, num, round, str, tickerSchema, TOOL_TIMEOUT_MS } from './shared.ts'

const MODULES = [
  'financialData',
  'recommendationTrend',
  'earningsTrend',
  'earningsHistory',
] as const

/**
 * Fetched apart from {@link MODULES} for two reasons: the library's schema
 * rejects `priceTargetAction: "Removes"`, which appears in older entries for
 * real tickers, so this module needs validation turned off; and bundling it
 * would let one bad historical row sink the consensus and estimates too.
 */
const RATING_HISTORY_MODULE = 'upgradeDowngradeHistory'

/** Firms publish constantly; the full history runs to hundreds of entries. */
const RATING_CHANGE_LIMIT = 10

export function createGetAnalystViewTool(market: string, client: YahooClient): ToolDefinition {
  return defineTool({
    name: 'get_analyst_view',
    description:
      'Get the sell-side view on a US stock: consensus rating, buy/hold/sell counts by month, '
      + 'mean/high/low price targets, forward revenue and EPS estimates, recent broker upgrades and '
      + 'downgrades, and the company\'s recent record of beating or missing EPS estimates. '
      + 'NOTE — `recommendation_mean` runs 1 to 5 where 1 is Strong Buy and 5 is Strong Sell, so a LOWER '
      + 'number is more bullish. Period codes count away from now in opposite directions: '
      + '`recommendation_trend` uses "0m" for this month and "-1m" for last month, while `estimates` uses '
      + '"0q"/"+1q" for the current and next quarter and "0y"/"+1y" for the current and next fiscal year. '
      + 'Prices are in the trading currency (USD for US listings) even when the company reports in another.',
    parameters: {
      ticker: tickerSchema('Stock symbol, e.g. "AAPL".'),
    },
    output: jsonOutput(),
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => stringify(await getAnalystView(market, client, args.ticker, exec.signal)),
  })
}

export async function getAnalystView(
  market: string,
  client: YahooClient,
  ticker: string,
  signal?: AbortSignal,
): Promise<ToolEnvelope<Record<string, unknown>>> {
  return await guard(market, ticker, async () => {
    const [summary, ratingChanges] = await Promise.all([
      client.quoteSummary(ticker, MODULES, signal),
      resolveRatingChanges(client, ticker, signal),
    ])

    const financialData = record(summary.financialData)
    const trendCounts = shapeTrend(summary.recommendationTrend)
    const estimates = shapeEstimates(summary.earningsTrend)
    const surprises = shapeSurprises(summary.earningsHistory)

    const consensus = compact({
      recommendation_key: str(financialData.recommendationKey),
      recommendation_mean: round(financialData.recommendationMean, 2),
      // Restated in the payload because the direction is counter-intuitive and
      // a bare 2.13 reads like a middling score out of five.
      recommendation_mean_scale: financialData.recommendationMean === undefined
        ? undefined
        : '1=strong_buy, 2=buy, 3=hold, 4=sell, 5=strong_sell; lower is more bullish',
      analyst_count: num(financialData.numberOfAnalystOpinions),
      current_price: num(financialData.currentPrice),
      target_mean_price: round(financialData.targetMeanPrice, 4),
      target_median_price: round(financialData.targetMedianPrice, 4),
      target_high_price: round(financialData.targetHighPrice, 4),
      target_low_price: round(financialData.targetLowPrice, 4),
      target_upside_percent: upside(financialData),
    })

    const empty = Object.keys(consensus).length === 0 && trendCounts.length === 0
      && estimates.length === 0 && ratingChanges.length === 0 && surprises.length === 0
    if (empty) {
      throw new DataSourceError(
        'no_data',
        `No analyst coverage reported for "${ticker}". Small caps, ETFs and funds are frequently uncovered.`,
      )
    }

    return success(market, {
      consensus,
      recommendation_trend: trendCounts,
      estimates,
      rating_changes: ratingChanges,
      earnings_surprises: surprises,
    }, { ticker })
  })
}

/** Best-effort: losing the rating history must not cost the consensus too. */
async function resolveRatingChanges(
  client: YahooClient,
  ticker: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  try {
    const summary = await client.quoteSummary(ticker, [RATING_HISTORY_MODULE], signal, {
      validateResult: false,
    })
    return shapeRatingChanges(summary[RATING_HISTORY_MODULE])
  } catch {
    return []
  }
}

/**
 * Recent broker upgrades and downgrades, newest first. Yahoo returns the full
 * history — hundreds of entries for a widely covered name — so only the most
 * recent handful are kept. The response is unvalidated, so every field is
 * narrowed rather than trusted.
 */
function shapeRatingChanges(raw: unknown): Record<string, unknown>[] {
  const history = record(raw).history
  if (!Array.isArray(history)) return []
  return history
    .map((entry) => {
      const item = record(entry)
      const date = isoDate(item.epochGradeDate)
      if (date === undefined) return undefined
      return compact({
        date: date.slice(0, 10),
        firm: str(item.firm),
        // "up", "down", "main" (reiterated), "init" (initiated coverage).
        action: str(item.action),
        from_grade: str(item.fromGrade),
        to_grade: str(item.toGrade),
        price_target_action: str(item.priceTargetAction),
        price_target: num(item.currentPriceTarget),
      })
    })
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, RATING_CHANGE_LIMIT)
}

/** Reported EPS against the consensus estimate for recent quarters. */
function shapeSurprises(raw: unknown): Record<string, unknown>[] {
  const history = record(raw).history
  if (!Array.isArray(history)) return []
  return history
    .map((entry) => {
      const item = record(entry)
      const actual = num(item.epsActual)
      const estimate = num(item.epsEstimate)
      if (actual === undefined && estimate === undefined) return undefined
      return compact({
        quarter_end: isoDate(item.quarter)?.slice(0, 10),
        // "-1q" is the most recently reported quarter, "-4q" a year ago.
        period: str(item.period),
        eps_actual: actual,
        eps_estimate: estimate,
        eps_difference: num(item.epsDifference),
        surprise_percent: round(item.surprisePercent, 4),
        currency: str(item.currency),
      })
    })
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
}

/** Percentage move implied by the mean target versus the current price. */
function upside(financialData: Record<string, unknown>): number | undefined {
  const target = num(financialData.targetMeanPrice)
  const current = num(financialData.currentPrice)
  if (target === undefined || current === undefined || current === 0) return undefined
  return round(((target - current) / current) * 100, 2)
}

function shapeTrend(raw: unknown): Record<string, unknown>[] {
  const trend = record(raw).trend
  if (!Array.isArray(trend)) return []
  return trend.map((entry) => {
    const item = record(entry)
    return compact({
      // "0m" is the current month, "-1m" one month ago, and so on.
      period: str(item.period),
      strong_buy: num(item.strongBuy),
      buy: num(item.buy),
      hold: num(item.hold),
      sell: num(item.sell),
      strong_sell: num(item.strongSell),
    })
  }).filter((entry) => Object.keys(entry).length > 1)
}

function shapeEstimates(raw: unknown): Record<string, unknown>[] {
  const trend = record(raw).trend
  if (!Array.isArray(trend)) return []
  return trend.map((entry) => {
    const item = record(entry)
    const earnings = record(item.earningsEstimate)
    const revenue = record(item.revenueEstimate)
    return compact({
      // "0q" current quarter, "+1q" next quarter, "0y" current year, "+1y" next year.
      period: str(item.period),
      end_date: str(item.endDate),
      eps_avg: num(earnings.avg),
      eps_low: num(earnings.low),
      eps_high: num(earnings.high),
      eps_year_ago: num(earnings.yearAgoEps),
      eps_analyst_count: num(earnings.numberOfAnalysts),
      eps_growth: round(earnings.growth, 4),
      revenue_avg: num(revenue.avg),
      revenue_low: num(revenue.low),
      revenue_high: num(revenue.high),
      revenue_year_ago: num(revenue.yearAgoRevenue),
      revenue_growth: round(revenue.growth, 4),
    })
  }).filter((entry) => Object.keys(entry).length > 1)
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}
