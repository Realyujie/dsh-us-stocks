/**
 * Pure geometry for the candlestick chart.
 *
 * Kept apart from the SVG so the arithmetic can be tested directly: a chart
 * that looks plausible but plots the wrong price is exactly the failure this
 * plugin exists to avoid, and eyeballing an image does not catch it.
 */
import type { Bar } from './envelope.ts'

export interface Extent {
  readonly min: number
  readonly max: number
}

export interface PlotBox {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export interface Candle {
  /** Centre of the slot this bar occupies. */
  readonly x: number
  /** Half-width of the body; the wick is drawn at `x`. */
  readonly halfWidth: number
  readonly openY: number
  readonly closeY: number
  readonly highY: number
  readonly lowY: number
  readonly rising: boolean
  readonly bar: Bar
}

/** A bar's own high/low, falling back to the values it does carry. */
function barHigh(bar: Bar): number {
  return Math.max(bar.high ?? bar.close, bar.open ?? bar.close, bar.close)
}

function barLow(bar: Bar): number {
  return Math.min(bar.low ?? bar.close, bar.open ?? bar.close, bar.close)
}

/**
 * Price range covered by the bars, padded so candles never touch the frame.
 * A flat series would otherwise divide by zero, so it is given an arbitrary
 * band around its single value and drawn as a centred line.
 */
export function priceExtent(bars: readonly Bar[], padRatio = 0.06): Extent {
  if (bars.length === 0) return { min: 0, max: 1 }

  let min = Infinity
  let max = -Infinity
  for (const bar of bars) {
    min = Math.min(min, barLow(bar))
    max = Math.max(max, barHigh(bar))
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 }
  if (max === min) {
    const band = Math.abs(max) * 0.01 || 1
    return { min: min - band, max: max + band }
  }

  const pad = (max - min) * padRatio
  return { min: min - pad, max: max + pad }
}

export function volumeMax(bars: readonly Bar[]): number {
  let max = 0
  for (const bar of bars) max = Math.max(max, bar.volume ?? 0)
  return max
}

/** Map a price onto a y coordinate; higher prices sit nearer the top. */
export function priceToY(price: number, extent: Extent, box: PlotBox): number {
  const span = extent.max - extent.min
  if (span <= 0) return box.top + box.height / 2
  const ratio = (extent.max - price) / span
  return box.top + ratio * box.height
}

/**
 * Lay the bars out across the plot. Bodies get 70% of their slot so adjacent
 * candles stay visually separate, and never thinner than a hairline — a year of
 * daily bars in a narrow card would otherwise vanish.
 */
export function layoutCandles(bars: readonly Bar[], extent: Extent, box: PlotBox): Candle[] {
  if (bars.length === 0) return []

  const slot = box.width / bars.length
  const halfWidth = Math.max(slot * 0.35, 0.4)

  return bars.map((bar, index) => {
    const open = bar.open ?? bar.close
    return {
      x: box.left + slot * (index + 0.5),
      halfWidth,
      openY: priceToY(open, extent, box),
      closeY: priceToY(bar.close, extent, box),
      highY: priceToY(barHigh(bar), extent, box),
      lowY: priceToY(barLow(bar), extent, box),
      // A doji counts as rising, matching how most terminals colour it.
      rising: bar.close >= open,
      bar,
    }
  })
}

/**
 * Round price gridlines inside the extent. Returns the values, not positions,
 * so the caller decides how to draw them.
 */
export function priceTicks(extent: Extent, count = 4): number[] {
  const span = extent.max - extent.min
  if (span <= 0 || count < 2) return [extent.min]

  const rawStep = span / (count - 1)
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const normalized = rawStep / magnitude

  // Nearest rung, not the next one up: always rounding up costs a gridline
  // every time — a step of 2.5 became 5, and 5.4 became 10, which left a
  // 137-299 range with a single line at 200.
  const ladder = [1, 2, 2.5, 5, 10]
  const rung = ladder.reduce((best, candidate) =>
    Math.abs(candidate - normalized) < Math.abs(best - normalized) ? candidate : best)
  const niceStep = rung * magnitude

  const ticks: number[] = []
  const first = Math.ceil(extent.min / niceStep) * niceStep
  for (let value = first; value <= extent.max + niceStep * 1e-9; value += niceStep) {
    ticks.push(Number(value.toFixed(10)))
  }
  return ticks
}

/** Evenly spaced bar indices for date labels, always including both ends. */
export function dateTickIndices(barCount: number, max = 4): number[] {
  if (barCount <= 0) return []
  if (barCount === 1) return [0]
  const count = Math.min(max, barCount)
  if (count < 2) return [barCount - 1]

  const indices = new Set<number>()
  for (let i = 0; i < count; i += 1) {
    indices.add(Math.round((i * (barCount - 1)) / (count - 1)))
  }
  return [...indices].sort((a, b) => a - b)
}

/** Compact price label: enough precision for penny stocks, terse for indices. */
export function formatPrice(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1000) return value.toFixed(0)
  if (abs >= 10) return value.toFixed(1)
  if (abs >= 1) return value.toFixed(2)
  return value.toFixed(4)
}

/** Volume in the units a reader scans quickly. */
export function formatVolume(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)}K`
  return String(value)
}

/**
 * A bar's `date` is `YYYY-MM-DD` for daily-or-coarser bars and a full ISO
 * instant for intraday ones — hourly bars share a calendar day, so date-only
 * would print the same label for several candles in a row. Detected by
 * length rather than an explicit flag threaded through every caller.
 */
function isIntraday(date: string): boolean {
  return date.length > 10
}

/** Compact x-axis tick: 'MM-DD', or 'MM-DD HH:mm' for an intraday bar. */
export function formatBarDate(date: string): string {
  return isIntraday(date) ? `${date.slice(5, 10)} ${date.slice(11, 16)}` : date.slice(5)
}

/** Full label for a hover readout or tooltip: unchanged, or with HH:mm appended. */
export function formatBarDateTime(date: string): string {
  return isIntraday(date) ? `${date.slice(0, 10)} ${date.slice(11, 16)}` : date
}
