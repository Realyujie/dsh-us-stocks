import { describe, expect, it } from 'vitest'
import type { Bar } from '../src/client/envelope.ts'
import {
  dateTickIndices,
  formatBarDate,
  formatBarDateTime,
  formatPrice,
  formatVolume,
  layoutCandles,
  priceExtent,
  priceTicks,
  priceToY,
  volumeMax,
  type PlotBox,
} from '../src/client/geometry.ts'

const BOX: PlotBox = { left: 0, top: 0, width: 100, height: 200 }

function bar(over: Partial<Bar> & { date: string, close: number }): Bar {
  return { open: over.close, high: over.close, low: over.close, ...over }
}

describe('priceExtent', () => {
  it('spans low to high across every bar, with padding', () => {
    const bars = [
      bar({ date: '1', close: 10, low: 8, high: 12 }),
      bar({ date: '2', close: 20, low: 18, high: 25 }),
    ]
    const { min, max } = priceExtent(bars, 0.1)
    // Raw span 8..25 (17), padded by 1.7 on each side.
    expect(min).toBeCloseTo(6.3, 6)
    expect(max).toBeCloseTo(26.7, 6)
  })

  it('gives a flat series a band instead of dividing by zero', () => {
    const { min, max } = priceExtent([bar({ date: '1', close: 100 }), bar({ date: '2', close: 100 })])
    expect(max).toBeGreaterThan(min)
    expect((min + max) / 2).toBeCloseTo(100, 6)
  })

  it('falls back to close when high and low are missing', () => {
    const { min, max } = priceExtent([{ date: '1', close: 5 }, { date: '2', close: 15 }], 0)
    expect(min).toBe(5)
    expect(max).toBe(15)
  })

  it('survives an empty series', () => {
    expect(priceExtent([])).toEqual({ min: 0, max: 1 })
  })
})

describe('priceToY', () => {
  const extent = { min: 0, max: 100 }

  it('puts the maximum at the top and the minimum at the bottom', () => {
    expect(priceToY(100, extent, BOX)).toBe(0)
    expect(priceToY(0, extent, BOX)).toBe(200)
    expect(priceToY(50, extent, BOX)).toBe(100)
  })

  it('centres everything when the extent has no span', () => {
    expect(priceToY(7, { min: 7, max: 7 }, BOX)).toBe(100)
  })
})

describe('layoutCandles', () => {
  const bars = [
    bar({ date: '1', close: 12, open: 10, low: 9, high: 13 }),
    bar({ date: '2', close: 8, open: 12, low: 7, high: 12 }),
  ]

  it('centres each bar in its slot', () => {
    const [a, b] = layoutCandles(bars, { min: 0, max: 100 }, BOX)
    expect(a.x).toBe(25)
    expect(b.x).toBe(75)
  })

  it('marks direction from open versus close', () => {
    const [a, b] = layoutCandles(bars, { min: 0, max: 100 }, BOX)
    expect(a.rising).toBe(true)
    expect(b.rising).toBe(false)
  })

  it('treats a doji as rising, as terminals do', () => {
    const [only] = layoutCandles([bar({ date: '1', close: 10, open: 10 })], { min: 0, max: 100 }, BOX)
    expect(only.rising).toBe(true)
  })

  it('keeps candles visible when hundreds share a narrow plot', () => {
    const many = Array.from({ length: 500 }, (_, i) => bar({ date: `d${i}`, close: 10 }))
    const laid = layoutCandles(many, { min: 0, max: 100 }, BOX)
    expect(laid[0].halfWidth).toBeGreaterThan(0)
  })

  it('orders wick ends so high sits above low on screen', () => {
    const [a] = layoutCandles(bars, { min: 0, max: 100 }, BOX)
    expect(a.highY).toBeLessThan(a.lowY)
  })
})

describe('priceTicks', () => {
  it('produces round values inside the extent', () => {
    const ticks = priceTicks({ min: 0, max: 100 }, 5)
    expect(ticks).toEqual([0, 25, 50, 75, 100])
  })

  it('never steps outside the extent', () => {
    const ticks = priceTicks({ min: 137.42, max: 298.61 }, 4)
    expect(Math.min(...ticks)).toBeGreaterThanOrEqual(137.42)
    expect(Math.max(...ticks)).toBeLessThanOrEqual(298.61)
    expect(ticks.length).toBeGreaterThan(1)
  })

  it('degrades to a single value for a zero span', () => {
    expect(priceTicks({ min: 5, max: 5 })).toEqual([5])
  })
})

describe('dateTickIndices', () => {
  it('always includes both ends', () => {
    const indices = dateTickIndices(63)
    expect(indices[0]).toBe(0)
    expect(indices.at(-1)).toBe(62)
  })

  it('never repeats an index when bars are fewer than ticks', () => {
    expect(dateTickIndices(2)).toEqual([0, 1])
    expect(dateTickIndices(1)).toEqual([0])
    expect(dateTickIndices(0)).toEqual([])
  })
})

describe('formatting', () => {
  it.each([
    [4455.02, '4455'],
    [305.26, '305.3'],
    [12.5, '12.5'],
    [3.1416, '3.14'],
    [0.0985, '0.0985'],
  ])('formats price %s as %s', (input, expected) => {
    expect(formatPrice(input)).toBe(expected)
  })

  it.each([
    [2_947_200, '2.9M'],
    [54_862_800, '54.9M'],
    [1_200_000_000, '1.2B'],
    [8_400, '8K'],
    [42, '42'],
  ])('formats volume %s as %s', (input, expected) => {
    expect(formatVolume(input)).toBe(expected)
  })
})

describe('formatBarDate / formatBarDateTime', () => {
  it('leaves a date-only bar (1d/1wk/1mo) unchanged but for the tick prefix', () => {
    expect(formatBarDate('2026-08-13')).toBe('08-13')
    expect(formatBarDateTime('2026-08-13')).toBe('2026-08-13')
  })

  it('appends the hour to an intraday bar rather than truncating it away', () => {
    expect(formatBarDate('2026-08-13T13:30:00.000Z')).toBe('08-13 13:30')
    expect(formatBarDateTime('2026-08-13T13:30:00.000Z')).toBe('2026-08-13 13:30')
  })

  it('distinguishes same-day hours that a date-only label would collapse', () => {
    const hours = ['2026-08-13T13:30:00.000Z', '2026-08-13T14:30:00.000Z', '2026-08-13T15:30:00.000Z']
    expect(new Set(hours.map(formatBarDate)).size).toBe(3)
  })
})

describe('volumeMax', () => {
  it('ignores bars with no volume', () => {
    expect(volumeMax([{ date: '1', close: 1 }, { date: '2', close: 1, volume: 500 }])).toBe(500)
  })

  it('is zero when nothing reports volume', () => {
    expect(volumeMax([{ date: '1', close: 1 }])).toBe(0)
  })
})
