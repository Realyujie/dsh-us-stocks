import { describe, expect, it } from 'vitest'
import { isFundQuoteType, shapeFund } from '../src/tools/fund.ts'

/** Shapes reduced from live responses on 2026-08-16. */
const XLK = {
  fundProfile: {
    family: 'State Street Investment Management',
    categoryName: 'Technology',
    legalType: 'Exchange Traded Fund',
    feesExpensesInvestment: { annualReportExpenseRatio: 0.0008 },
    feesExpensesInvestmentCat: { annualReportExpenseRatio: 0.009007 },
  },
  defaultKeyStatistics: {
    category: 'Technology',
    totalAssets: 115_400_000_000,
    fundFamily: 'State Street Investment Management',
    legalType: 'Exchange Traded Fund',
  },
  topHoldings: {
    stockPosition: 0.9992,
    bondPosition: 0,
    cashPosition: 0.0008,
    otherPosition: 0,
    holdings: [
      { symbol: 'NVDA', holdingName: 'NVIDIA Corp', holdingPercent: 0.137932 },
      { symbol: 'AAPL', holdingName: 'Apple Inc', holdingPercent: 0.128707 },
      { symbol: 'MSFT', holdingName: 'Microsoft Corp', holdingPercent: 0.09793 },
    ],
  },
  fundPerformance: {
    trailingReturns: { ytd: 0.220516, oneYear: 0.342502, fiveYear: 0.188652, tenYear: 0.236961 },
  },
}

/** A commodity ETF: profiled and priced, but holding bullion rather than positions. */
const GLD = {
  fundProfile: {
    family: 'State Street Investment Management',
    categoryName: 'Commodities Focused',
    feesExpensesInvestment: { annualReportExpenseRatio: 0.004 },
  },
  defaultKeyStatistics: { category: 'Commodities Focused', totalAssets: 130_300_000_000 },
  topHoldings: { cashPosition: 0, stockPosition: 0, bondPosition: 0, holdings: [] },
  fundPerformance: { trailingReturns: { ytd: -0.0674672, oneYear: 0.21584 } },
}

describe('isFundQuoteType', () => {
  // Gating on ETF alone silently dropped every mutual fund, which reports the
  // same four modules with the same shapes.
  it('accepts both fund quote types and nothing else', () => {
    expect(isFundQuoteType('ETF')).toBe(true)
    expect(isFundQuoteType('MUTUALFUND')).toBe(true)
    expect(isFundQuoteType('EQUITY')).toBe(false)
    expect(isFundQuoteType(undefined)).toBe(false)
  })
})

describe('shapeFund', () => {
  it('scales upstream fractions into the percent its field names promise', () => {
    const fund = shapeFund(XLK)
    expect(fund.fund_expense_ratio_percent).toBe(0.08)
    expect(fund.fund_expense_ratio_category_percent).toBe(0.9007)
    expect(fund.fund_trailing_returns_percent).toMatchObject({ ytd: 22.05, one_year: 34.25 })
    expect(fund.fund_asset_allocation_percent).toMatchObject({ stock: 99.92, cash: 0.08 })
  })

  it('carries the raw net assets unscaled, since it is not a ratio', () => {
    expect(shapeFund(XLK).fund_total_assets).toBe(115_400_000_000)
  })

  it('states how much of the fund the listed holdings cover', () => {
    const fund = shapeFund(XLK)
    expect(fund.fund_top_holdings).toEqual([
      { symbol: 'NVDA', name: 'NVIDIA Corp', weight_percent: 13.79 },
      { symbol: 'AAPL', name: 'Apple Inc', weight_percent: 12.87 },
      { symbol: 'MSFT', name: 'Microsoft Corp', weight_percent: 9.79 },
    ])
    expect(fund.fund_top_holdings_coverage_percent).toBe(36.45)
  })

  it('warns that the equity ratios are aggregates, and that holdings are partial', () => {
    const notes = shapeFund(XLK).fund_notes as Record<string, string>
    expect(notes.equity_ratios).toMatch(/aggregate/i)
    expect(notes.expense_ratio).toMatch(/sanity-check/i)
    expect(notes.top_holdings).toMatch(/not a complete/i)
  })

  // Bond, commodity and inverse funds returned no positions at all in a 21-fund
  // sample, so absent holdings are ordinary rather than a fault.
  it('omits holdings and their caveat for a fund that reports none', () => {
    const fund = shapeFund(GLD)
    expect(fund).not.toHaveProperty('fund_top_holdings')
    expect(fund).not.toHaveProperty('fund_top_holdings_coverage_percent')
    const notes = fund.fund_notes as Record<string, string>
    expect(notes).not.toHaveProperty('top_holdings')
    expect(notes.expense_ratio).toBeDefined()
    expect(fund.fund_expense_ratio_percent).toBe(0.4)
  })

  it('keeps the aggregate-ratio caveat even with no expense ratio or holdings', () => {
    const notes = shapeFund({ defaultKeyStatistics: { category: 'Technology' } }).fund_notes as Record<string, string>
    expect(Object.keys(notes)).toEqual(['equity_ratios'])
  })

  it('drops a holding that upstream returned without a symbol or a weight', () => {
    const fund = shapeFund({
      topHoldings: {
        holdings: [
          { symbol: 'NVDA', holdingName: 'NVIDIA Corp', holdingPercent: 0.1 },
          { holdingName: 'Undisclosed', holdingPercent: 0.05 },
          { symbol: 'CASH', holdingName: 'Cash' },
        ],
      },
    })
    expect(fund.fund_top_holdings).toEqual([{ symbol: 'NVDA', name: 'NVIDIA Corp', weight_percent: 10 }])
  })

  it('yields nothing at all for an equity, whose summary carries no fund modules', () => {
    expect(shapeFund({})).toEqual({})
  })
})
