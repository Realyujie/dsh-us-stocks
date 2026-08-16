import { describe, expect, it } from 'vitest'
import type { YahooClient } from '../src/datasource/us/yahoo-client.ts'
import { getOwnership } from '../src/tools/get-ownership.ts'

function fakeClient(overrides: Partial<Record<keyof YahooClient, unknown>>): YahooClient {
  return overrides as unknown as YahooClient
}

/** Reduced from a live AMZN response on 2026-08-16. */
const AMZN = {
  majorHoldersBreakdown: {
    insidersPercentHeld: 0.0887,
    institutionsPercentHeld: 0.6885,
    institutionsFloatPercentHeld: 0.7555,
    institutionsCount: 7885,
  },
  netSharePurchaseActivity: {
    period: '6m',
    buyInfoCount: 58,
    buyInfoShares: 2_401_344,
    sellInfoCount: 67,
    sellInfoShares: 1_944_701,
    netInfoShares: 456_643,
    totalInsiderShares: 956_638_144,
    netInstSharesBuying: -704_049_622,
  },
  institutionOwnership: {
    ownershipList: [
      { organization: 'Blackrock Inc.', pctHeld: 0.0694, position: 748_403_539, value: 1, pctChange: 0.0175, reportDate: new Date('2026-06-30T00:00:00Z') },
      { organization: 'Vanguard Capital Management LLC', pctHeld: 0.0589, position: 635_764_130, pctChange: 0.0073, reportDate: new Date('2026-06-30T00:00:00Z') },
    ],
  },
  fundOwnership: {
    ownershipList: [
      { organization: 'Vanguard Total Stock Market Index Fund', pctHeld: 0.0284, position: 306_806_261, reportDate: new Date('2026-03-31T00:00:00Z') },
    ],
  },
  insiderTransactions: {
    transactions: [
      { startDate: new Date('2026-08-03T00:00:00Z'), filerName: 'BEZOS JEFFREY P', filerRelation: 'Officer and Director', transactionText: 'Sale at price 286.41 per share.', shares: 1_209_649 },
      { startDate: new Date('2026-08-06T00:00:00Z'), filerName: 'HERRINGTON DOUGLAS J', transactionText: 'Stock Gift at price 0.00 per share.', shares: 22_000 },
      { filerName: 'NO DATE', transactionText: 'Sale', shares: 1 },
    ],
  },
  insiderHolders: {
    holders: [
      { name: 'BEZOS JEFFREY P', relation: 'Officer and Director', transactionDescription: 'Sale', latestTransDate: new Date('2026-08-03T00:00:00Z'), positionDirect: 884_826_000 },
    ],
  },
}

describe('get_ownership', () => {
  it('scales the held fractions and keeps the raw share counts', async () => {
    const client = fakeClient({ quoteSummary: async () => AMZN })
    const result = await getOwnership('us', client, { ticker: 'AMZN' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.ownership_breakdown).toEqual({
      insiders_percent: 8.87,
      institutions_percent: 68.85,
      institutions_percent_of_float: 75.55,
      institutions_count: 7885,
    })
    expect(result.data.top_institutional_holders).toMatchObject([
      { organization: 'Blackrock Inc.', percent_held: 6.94, shares: 748_403_539, position_change_percent: 1.75, report_date: '2026-06-30' },
      { organization: 'Vanguard Capital Management LLC', percent_held: 5.89 },
    ])
  })

  // The measurement a news story about one insider cannot supply: over six
  // months AMZN insiders bought more shares than they sold, while the headline
  // filing was a large sale.
  it('reports the six-month insider aggregate with its sign intact', async () => {
    const client = fakeClient({ quoteSummary: async () => AMZN })
    const result = await getOwnership('us', client, { ticker: 'AMZN' })
    if (!result.ok) return
    expect(result.data.insider_activity).toMatchObject({
      period: '6m',
      buy_count: 58,
      sell_count: 67,
      net_shares: 456_643,
      net_institutional_shares: -704_049_622,
    })
    expect(result.data.ownership_note).toMatch(/net positive/i)
  })

  it('withholds individual filings unless full detail is asked for', async () => {
    const asked: string[][] = []
    const client = fakeClient({
      quoteSummary: async (_t: string, modules: readonly string[]) => { asked.push([...modules]); return AMZN },
    })

    const summary = await getOwnership('us', client, { ticker: 'AMZN' })
    if (!summary.ok) return
    expect(summary.data.detail).toBe('summary')
    expect(summary.data).not.toHaveProperty('insider_transactions')
    expect(summary.data).not.toHaveProperty('insider_holders')
    // Not merely dropped after the fact — the heavy modules are never requested.
    expect(asked[0]).not.toContain('insiderTransactions')

    const full = await getOwnership('us', client, { ticker: 'AMZN', detail: 'full' })
    if (!full.ok) return
    expect(full.data.detail).toBe('full')
    expect(asked[1]).toContain('insiderTransactions')
    expect(full.data.insider_transactions).toMatchObject([
      { date: '2026-08-03', name: 'BEZOS JEFFREY P', relation: 'Officer and Director', shares: 1_209_649 },
      { date: '2026-08-06', name: 'HERRINGTON DOUGLAS J' },
    ])
    expect(full.data.insider_holders).toMatchObject([{ name: 'BEZOS JEFFREY P', shares_held: 884_826_000 }])
  })

  it('drops a filing with no date, which cannot be placed in time', async () => {
    const client = fakeClient({ quoteSummary: async () => AMZN })
    const result = await getOwnership('us', client, { ticker: 'AMZN', detail: 'full' })
    if (!result.ok) return
    expect(result.data.insider_transactions).toHaveLength(2)
  })

  it('caps every list at the requested limit', async () => {
    const client = fakeClient({ quoteSummary: async () => AMZN })
    const result = await getOwnership('us', client, { ticker: 'AMZN', detail: 'full', limit: 1 })
    if (!result.ok) return
    expect(result.data.top_institutional_holders).toHaveLength(1)
    expect(result.data.insider_transactions).toHaveLength(1)
  })

  it('explains that a fund has no filings rather than relaying the upstream wording', async () => {
    const client = fakeClient({
      quoteSummary: async () => { throw new Error('No fundamentals data found for symbol: XLK') },
    })

    const result = await getOwnership('us', client, { ticker: 'XLK' })
    expect(result).toMatchObject({ ok: false, error: { kind: 'no_data', retryable: false } })
    if (result.ok) return
    expect(result.error.message).toMatch(/operating companies/i)
    expect(result.error.message).not.toMatch(/no fundamentals data found/i)
  })

  // Same rule the quote tool follows: ratings and recommendations live in
  // get_analyst_view alone, so ownership never editorialises about the buying
  // and selling it reports.
  it('never surfaces a rating or a recommendation', async () => {
    const client = fakeClient({ quoteSummary: async () => AMZN })
    const result = await getOwnership('us', client, { ticker: 'AMZN', detail: 'full' })
    if (!result.ok) return
    expect(JSON.stringify(result.data)).not.toMatch(/\b(buy|sell|hold)\s*rating\b|recommend|bullish|bearish|outperform/i)
  })

  it('keeps a network fault retryable rather than calling it missing data', async () => {
    const client = fakeClient({ quoteSummary: async () => { throw new Error('fetch failed') } })
    const result = await getOwnership('us', client, { ticker: 'AMZN' })
    expect(result).toMatchObject({ ok: false, error: { kind: 'upstream_unavailable', retryable: true } })
  })

  it('reports a symbol whose modules are all empty as no_data', async () => {
    const client = fakeClient({ quoteSummary: async () => ({}) })
    const result = await getOwnership('us', client, { ticker: 'ZZZZ' })
    expect(result).toMatchObject({ ok: false, error: { kind: 'no_data' } })
  })

  it('rejects an unusable detail or limit without calling upstream', async () => {
    let calls = 0
    const client = fakeClient({ quoteSummary: async () => { calls += 1; return AMZN } })

    for (const args of [{ ticker: 'AMZN', detail: 'deep' }, { ticker: 'AMZN', limit: 999 }, { ticker: 'AMZN', limit: 0 }]) {
      const result = await getOwnership('us', client, args)
      expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_argument', retryable: false } })
    }
    expect(calls).toBe(0)
  })
})
