import z from '@deepseek-ai/schemastery'

/**
 * `market` is fixed to `us` for now. The field exists so that adding another
 * venue later is a widening of the enum plus a sibling `datasource/<market>/`
 * implementation, rather than a config-shape break for existing users.
 */
export const MARKETS = ['us'] as const
export type Market = typeof MARKETS[number]

export interface UsStocksPluginConfig {
  enabled: boolean
  market: Market
  quoteTtlMs: number
  referenceTtlMs: number
}

export const Config: z<UsStocksPluginConfig> = z.object({
  enabled: z.boolean().default(true).description('Register the stock tools with the agent.'),
  market: z.union(MARKETS.map((market) => z.const(market))).default('us')
    .description('Market coverage. Only "us" is supported today.'),
  quoteTtlMs: z.number().default(10_000)
    .description('Cache lifetime for live quotes, in milliseconds.'),
  referenceTtlMs: z.number().default(300_000)
    .description('Cache lifetime for statements, bars, ratings and news, in milliseconds.'),
})
