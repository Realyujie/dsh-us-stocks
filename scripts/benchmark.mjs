/**
 * Acceptance benchmark: the six questions a ticker research task needs.
 *
 * Reproduces the data an agent gathered by hand in the original session log
 * (price, financials, ratings, news) and measures how long the plugin needs.
 *
 * What this measures: wall-clock time to fetch and shape the data, plus the
 * number of tool calls. It deliberately excludes model inference time, which
 * dominates any real agent turn and is not something this plugin controls.
 *
 * Run: npm run build && node scripts/benchmark-ttmi.mjs [TICKER]
 */
import { YahooClient } from '../lib/datasource/us/yahoo-client.js'
import { createUsStockTools } from '../lib/tools/index.js'

const ticker = process.argv[2] ?? 'AAPL'
const client = new YahooClient()
const tools = new Map(createUsStockTools('us', client).map((tool) => [tool.name, tool]))

// The same questions the original session answered by scraping.
const plan = [
  ['get_quote', { ticker }],
  ['get_history', { ticker, range: '3mo', interval: '1d' }],
  ['get_financials', { ticker, period: 'quarterly', limit: 4 }],
  ['get_analyst_view', { ticker }],
  ['get_news', { ticker, limit: 8 }],
  ['get_ownership', { ticker }],
]

console.log(`Acceptance benchmark — ${ticker}\n`)

// An agent issues these concurrently; every tool is marked concurrency-safe.
const started = Date.now()
const settled = await Promise.all(plan.map(async ([name, args]) => {
  const toolStarted = Date.now()
  const raw = await tools.get(name).execute(args, { signal: undefined })
  return { name, ms: Date.now() - toolStarted, envelope: JSON.parse(raw) }
}))
const parallelMs = Date.now() - started

let failures = 0
for (const { name, ms, envelope } of settled) {
  if (envelope.ok !== true) {
    failures += 1
    console.log(`  ❌ ${name.padEnd(18)} ${String(ms).padStart(5)}ms  ${envelope.error?.kind}: ${envelope.error?.message}`)
    continue
  }
  console.log(`  ✅ ${name.padEnd(18)} ${String(ms).padStart(5)}ms  ${summarize(name, envelope.data)}`)
}

const bytes = settled.reduce((total, { envelope }) => total + JSON.stringify(envelope).length, 0)

console.log(`\n  tool calls        ${plan.length}`)
console.log(`  wall clock        ${(parallelMs / 1000).toFixed(2)}s (concurrent)`)
console.log(`  payload           ${(bytes / 1024).toFixed(1)} KiB across ${plan.length} results`)

if (failures > 0) {
  console.log(`\n${failures} of ${plan.length} calls failed`)
  process.exit(1)
}

console.log('\nBaseline from the pre-plugin session log: 21 steps, 32 tool calls, ~238s.')

function summarize(name, data) {
  switch (name) {
    case 'get_quote':
      return `${data.price} ${data.currency} (${data.change_percent >= 0 ? '+' : ''}${data.change_percent}%), mcap ${(data.market_cap / 1e9).toFixed(2)}B`
    case 'get_history':
      return `${data.bar_count} bars ${data.first_bar_date}..${data.last_bar_date}`
    case 'get_financials':
      return `${data.income?.length ?? 0} income / ${data.balance?.length ?? 0} balance / ${data.cash_flow?.length ?? 0} cash-flow periods`
    case 'get_analyst_view':
      return `${data.consensus.recommendation_key} from ${data.consensus.analyst_count} analysts, target ${data.consensus.target_mean_price}`
    case 'get_news':
      return `${data.article_count} headlines, latest "${truncate(data.articles[0]?.title)}"`
    case 'get_ownership':
      return `${data.ownership_breakdown?.institutions_percent}% institutional across `
        + `${data.ownership_breakdown?.institutions_count} filers, insiders net `
        + `${data.insider_activity?.net_shares} shares over ${data.insider_activity?.period}`
    default:
      return ''
  }
}

function truncate(text, max = 48) {
  if (typeof text !== 'string') return ''
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
