/**
 * Live smoke test against the real Yahoo endpoints. Not part of `npm test` —
 * it needs network access and asserts only on shape, not on values.
 *
 * Run: npm run build && npm run test:live
 */
import { YahooClient } from '../lib/datasource/us/yahoo-client.js'
import { createUsStockTools } from '../lib/tools/index.js'

const client = new YahooClient()
const tools = createUsStockTools('us', client)
const tickers = process.argv.slice(2)
const symbols = tickers.length > 0 ? tickers : ['AAPL', 'MSFT']

let failures = 0

for (const tool of tools) {
  for (const symbol of symbols) {
    const args = buildArgs(tool.name, symbol)
    const started = Date.now()
    try {
      const raw = await tool.execute(args, { signal: undefined })
      const envelope = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw))
      const ms = Date.now() - started
      if (envelope.ok !== true) {
        failures += 1
        console.log(`❌ ${tool.name}(${symbol}) ${ms}ms -> ${envelope.error?.kind}: ${envelope.error?.message}`)
        continue
      }
      console.log(`✅ ${tool.name}(${symbol}) ${ms}ms  ${describe(envelope.data)}`)
    } catch (error) {
      failures += 1
      console.log(`❌ ${tool.name}(${symbol}) threw: ${error?.message ?? error}`)
    }
  }
}

console.log(failures === 0 ? '\nall live checks passed' : `\n${failures} live check(s) failed`)
process.exit(failures === 0 ? 0 : 1)

function buildArgs(name, ticker) {
  switch (name) {
    case 'get_history':
      return { ticker, range: '1mo', interval: '1d' }
    case 'get_financials':
      return { ticker, period: 'quarterly' }
    case 'get_news':
      return { ticker, limit: 5 }
    default:
      return { ticker }
  }
}

function describe(data) {
  if (Array.isArray(data)) return `${data.length} items`
  if (data === null || typeof data !== 'object') return String(data)
  const keys = Object.keys(data)
  const preview = keys.slice(0, 4).map((key) => {
    const value = data[key]
    return `${key}=${Array.isArray(value) ? `[${value.length}]` : typeof value === 'object' && value !== null ? '{…}' : value}`
  })
  return `${keys.length} keys: ${preview.join(' ')}`
}
