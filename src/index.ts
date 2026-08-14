import type {} from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { Config, type UsStocksPluginConfig } from './config.ts'
import { YahooClient } from './datasource/us/yahoo-client.ts'
import { createUsStockTools } from './tools/index.ts'

export const name = 'dsh-us-stocks'
export const inject = ['tools']

export { Config }
export type { UsStocksPluginConfig }

export function apply(ctx: Context, config: UsStocksPluginConfig): void {
  if (!config.enabled) return

  const client = new YahooClient({
    quoteTtlMs: config.quoteTtlMs,
    referenceTtlMs: config.referenceTtlMs,
  })

  for (const tool of createUsStockTools(config.market, client)) {
    ctx.tools.register(tool)
  }
}
