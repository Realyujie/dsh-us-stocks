import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { YahooClient } from '../datasource/us/yahoo-client.ts'
import { createGetQuoteTool } from './get-quote.ts'
import { createGetHistoryTool } from './get-history.ts'
import { createGetFinancialsTool } from './get-financials.ts'
import { createGetAnalystViewTool } from './get-analyst-view.ts'
import { createGetNewsTool } from './get-news.ts'

export function createUsStockTools(market: string, client: YahooClient): ToolDefinition[] {
  return [
    createGetQuoteTool(market, client),
    createGetHistoryTool(market, client),
    createGetFinancialsTool(market, client),
    createGetAnalystViewTool(market, client),
    createGetNewsTool(market, client),
  ]
}
