import { useCallback, useEffect, useRef, useState } from 'react'
import type { Bar } from './envelope.ts'
import { copyFor } from './i18n.ts'
import { useLocale } from './locale.ts'
import { useRenderedWidth } from './useRenderedWidth.ts'
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
  type Candle,
  type PlotBox,
} from './geometry.ts'

/** Drawn in a fixed coordinate space and scaled by the viewBox. */
const WIDTH = 720
const HEIGHT = 240
const VOLUME_HEIGHT = 40
const TOP_PAD = 8

/**
 * Gutters are sized in multiples of the label font rather than in fixed units.
 * Compensating the font for a narrow card makes the glyphs wider in viewBox
 * terms, and a fixed 46-unit gutter then clipped "75.0" to "75." and "成交量"
 * to "成交". Scaling with the text keeps both gutters a constant width on
 * screen instead.
 */
const GUTTER_EMS = 4.8
const DATE_GUTTER_EMS = 1.6

/** Font sizes in CSS pixels; the scale below keeps them at these sizes. */
const TICK_PX = 10
const NOTE_PX = 9

/**
 * Below this the axis text would crowd out the plot even at full size, and 63
 * candles in 180px are 2.7px each. Showing the shape without labels beats
 * showing both illegibly.
 */
const BARE_BELOW_PX = 260

/**
 * Host theme variables, each with a literal fallback so the chart still reads
 * on a build that does not define them. Note the prefix is `dsw`, not `dsh`.
 *
 * Direction uses the host's own success/error colours rather than fixed hex, so
 * the candles match the rest of the UI in either theme. US convention applies:
 * green rises, red falls — the reverse of the A-share terminals the reference
 * plugin follows.
 */
export const UP = 'var(--dsw-alias-state-success-primary, #26a17b)'
export const DOWN = 'var(--dsw-alias-state-error-primary, #e5534b)'
const GRID = 'var(--dsw-alias-border-l2, rgba(127,127,127,0.22))'
const LABEL = 'var(--dsw-alias-label-dimmed, rgba(127,127,127,0.9))'

export interface CandlesProps {
  readonly bars: readonly Bar[]
  /** Called with the bar under the pointer, so the header can show it. */
  readonly onHover?: (candle: Candle | undefined) => void
}

export function Candles({ bars, onHover }: CandlesProps): JSX.Element | null {
  const t = copyFor(useLocale())
  const [ref, renderedWidth] = useRenderedWidth<HTMLDivElement>()
  const [hovered, setHovered] = useState<number | undefined>(undefined)
  /** Latest layout, so the effect below reads it without re-running on render. */
  const layoutRef = useRef<Candle[]>([])
  /** Plot width as last rendered, so hit-testing matches what is on screen. */
  const plotWidthRef = useRef<number>(WIDTH)

  /**
   * Pointer coordinates are converted through the SVG's own box, so the mapping
   * holds at any rendered width.
   */
  const onMove = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    if (box.width === 0) return
    const x = ((event.clientX - box.left) / box.width) * WIDTH
    const index = Math.floor(x / (plotWidthRef.current / bars.length))
    setHovered(index >= 0 && index < bars.length ? index : undefined)
  }, [bars.length])

  const onLeave = useCallback(() => setHovered(undefined), [])

  /**
   * Notify the parent after the commit, never during render. Calling a parent's
   * setState while this component renders is what React warns about, and here
   * it would have looped: the parent re-renders this child, which notifies
   * again.
   */
  const notify = onHover
  useEffect(() => {
    notify?.(hovered === undefined ? undefined : layoutRef.current?.[hovered])
  }, [notify, hovered])

  if (bars.length === 0) return null

  /**
   * Cancel the viewBox scaling for text. Without this every label shrinks with
   * the card — 10 units became 2.5px in a narrow column.
   */
  const scale = renderedWidth === undefined ? 1 : renderedWidth / WIDTH
  const font = (px: number): number => px / scale
  const bare = renderedWidth !== undefined && renderedWidth < BARE_BELOW_PX

  const gutter = bare ? 0 : font(TICK_PX) * GUTTER_EMS
  const dateGutter = bare ? 0 : font(TICK_PX) * DATE_GUTTER_EMS
  const plot: PlotBox = {
    left: 0,
    top: TOP_PAD,
    width: WIDTH - gutter,
    height: HEIGHT - VOLUME_HEIGHT - dateGutter - TOP_PAD,
  }
  const volumeTop = plot.top + plot.height + dateGutter

  const extent = priceExtent(bars)
  const candles = layoutCandles(bars, extent, plot)
  layoutRef.current = candles
  plotWidthRef.current = plot.width
  const ticks = priceTicks(extent)
  const maxVolume = volumeMax(bars)
  const slot = plot.width / bars.length
  const hoveredCandle = hovered === undefined ? undefined : candles[hovered]

  return (
    <div ref={ref}>
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      style={{ width: '100%', height: 'auto', display: 'block' }}
      role="img"
      aria-label={t.chartLabel(bars.length, formatBarDateTime(bars[0].date), formatBarDateTime(bars[bars.length - 1].date))}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
    >
      {!bare && ticks.map((price) => {
        const y = priceToY(price, extent, plot)
        return (
          <g key={`p${price}`}>
            <line x1={0} y1={y} x2={plot.width} y2={y} stroke={GRID} strokeWidth={1} />
            <text x={plot.width + 6} y={y + font(TICK_PX) * 0.35} fill={LABEL} fontSize={font(TICK_PX)} fontFamily="ui-monospace, monospace">
              {formatPrice(price)}
            </text>
          </g>
        )
      })}

      {maxVolume > 0 && candles.map((candle) => {
        const height = ((candle.bar.volume ?? 0) / maxVolume) * VOLUME_HEIGHT
        return (
          <rect
            key={`v${candle.bar.date}`}
            x={candle.x - candle.halfWidth}
            y={volumeTop + (VOLUME_HEIGHT - height)}
            width={candle.halfWidth * 2}
            height={Math.max(height, 0.5)}
            fill={candle.rising ? UP : DOWN}
            opacity={hovered === undefined || candles[hovered] === candle ? 0.45 : 0.25}
          />
        )
      })}

      {candles.map((candle) => {
        const color = candle.rising ? UP : DOWN
        const bodyTop = Math.min(candle.openY, candle.closeY)
        // A doji has zero body height and would disappear; keep a hairline.
        const bodyHeight = Math.max(Math.abs(candle.closeY - candle.openY), 0.75)
        const dimmed = hovered !== undefined && candles[hovered] !== candle
        return (
          <g key={candle.bar.date} opacity={dimmed ? 0.55 : 1}>
            <line
              x1={candle.x}
              y1={candle.highY}
              x2={candle.x}
              y2={candle.lowY}
              stroke={color}
              strokeWidth={Math.min(1, candle.halfWidth)}
            />
            <rect
              x={candle.x - candle.halfWidth}
              y={bodyTop}
              width={candle.halfWidth * 2}
              height={bodyHeight}
              fill={color}
            />
          </g>
        )
      })}

      {!bare && maxVolume > 0 && (
        <text x={plot.width + 6} y={volumeTop + font(NOTE_PX)} fill={LABEL} fontSize={font(NOTE_PX)} fontFamily="ui-monospace, monospace">
          {/*
            Two lines, because one does not fit. Full-width characters cost
            three times what the price ticks beside them do, and "成交量 64.6M"
            ran past the viewBox edge as a single line.
          */}
          <tspan x={plot.width + 6}>{t.volume}</tspan>
          <tspan x={plot.width + 6} dy={font(NOTE_PX) * 1.2}>{formatVolume(maxVolume)}</tspan>
        </text>
      )}

      {!bare && dateTickIndices(bars.length).map((index) => {
        const x = slot * (index + 0.5)
        const anchor = index === 0 ? 'start' : index === bars.length - 1 ? 'end' : 'middle'
        return (
          <text
            key={`d${index}`}
            x={Math.min(Math.max(x, 0), plot.width)}
            y={plot.top + plot.height + font(TICK_PX) * 1.1}
            fill={LABEL}
            fontSize={font(TICK_PX)}
            fontFamily="ui-monospace, monospace"
            textAnchor={anchor}
          >
            {formatBarDate(bars[index].date)}
          </text>
        )
      })}

      {/*
        Only the crosshair stays in the plot. The values themselves go to the
        header, where they cannot cover the candles they describe.
      */}
      {hoveredCandle !== undefined && (
        <g pointerEvents="none">
          <line
            x1={hoveredCandle.x}
            y1={plot.top}
            x2={hoveredCandle.x}
            y2={volumeTop + VOLUME_HEIGHT}
            stroke={LABEL}
            strokeWidth={0.75}
            strokeDasharray="3 3"
          />
          <line
            x1={0}
            y1={hoveredCandle.closeY}
            x2={plot.width}
            y2={hoveredCandle.closeY}
            stroke={LABEL}
            strokeWidth={0.5}
            strokeDasharray="2 4"
          />
        </g>
      )}
    </svg>
    </div>
  )
}
