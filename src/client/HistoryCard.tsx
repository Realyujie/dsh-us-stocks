import type { ReactNode } from 'react'
import { useState } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { Candles, DOWN, UP } from './Candles.tsx'
import { parseHistory } from './envelope.ts'
import type { Candle } from './geometry.ts'
import { formatBarDateTime, formatPrice } from './geometry.ts'
import { copyFor } from './i18n.ts'
import { useLocale } from './locale.ts'

const SHELL: React.CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3))',
  borderRadius: 8,
  padding: '10px 12px',
  margin: '4px 0',
  font: '12px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace',
}

/**
 * Title and info pills share one row: the ticker leads, the interval/bar-
 * count/date-range pills sit beside it, and the price pill trails with
 * `marginLeft: auto`. Flexbox resolves an auto margin per line, so the price
 * pill still lands at the row's right edge even when it wraps onto a line of
 * its own on a narrow card — the "top-right" placement survives wrapping
 * without special-casing it.
 */
const INFO_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 6,
  marginBottom: 4,
}

const TITLE: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
}

/**
 * No explicit height here. The row's height comes from always rendering a
 * span at the card's own font size — 12px/1.7 line-height, 20.4px — and
 * toggling `visibility` rather than toggling its presence. A guessed
 * `minHeight` drifted from that real line-height before (16px reserved
 * against a 20.4px line), so hovering still nudged the chart down by the
 * difference; matching the actual box the text would occupy cannot drift.
 */
const HOVER_ROW: React.CSSProperties = {
  marginBottom: 2,
}

const DISCLAIMER: React.CSSProperties = {
  marginTop: 8,
  paddingTop: 6,
  borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.15))',
  fontSize: 9,
  opacity: 0.6,
}

function Pill(
  { children, tone, title, style }: { children: ReactNode, tone?: 'up' | 'down', title?: string, style?: React.CSSProperties },
): JSX.Element {
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        padding: '2px 8px',
        borderRadius: 999,
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.12))',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25))',
        color: tone === 'up' ? UP : tone === 'down' ? DOWN : undefined,
        fontWeight: tone === undefined ? 400 : 600,
        fontSize: 11,
        lineHeight: '16px',
        // No nowrap: a card can end up narrower than a pill's natural content
        // width (the date-range pill is ~24 characters), and nowrap text does
        // not shrink — it overflows the card instead. Wrapping inside the pill
        // is the fallback; maxWidth stops the pill itself from exceeding the
        // card no matter how the parent lays it out.
        maxWidth: '100%',
        boxSizing: 'border-box',
        overflowWrap: 'anywhere',
        ...style,
      }}
    >
      {children}
    </span>
  )
}

/**
 * Body of a `get_history` call.
 *
 * Reads the tool's own JSON back out of the settled call rather than taking a
 * second copy through some side channel: the payload the model saw and the
 * chart the reader sees are then the same numbers by construction.
 */
export function HistoryCard(props: ToolCallViewProps): JSX.Element {
  const { block } = props
  const t = copyFor(useLocale())
  const [hovered, setHovered] = useState<Candle | undefined>(undefined)

  if (!('kind' in block) || block.kind !== 'tool-result') {
    return <div style={SHELL}>{t.loading}</div>
  }

  const envelope = parseHistory(block.content)

  if (envelope === undefined) {
    return <div style={SHELL}>{t.unreadable}</div>
  }

  if (!envelope.ok) {
    return (
      <div style={SHELL}>
        <div style={TITLE}>{envelope.ticker ?? '—'}</div>
        {/*
          Upstream wording is printed verbatim and labelled as coming from the
          data source. Those messages are written for the model as much as for
          the reader, and translating one audience's copy would split them.
        */}
        <div>{t.sourceError} {envelope.error.kind} — {envelope.error.message}</div>
      </div>
    )
  }

  const { data, ticker, warnings } = envelope
  const first = data.bars[0]
  const last = data.bars.at(-1)
  const change = first === undefined || last === undefined || first.close === 0
    ? undefined
    : ((last.close - first.close) / first.close) * 100

  return (
    <div style={SHELL}>
      {/*
        Title and parameter pills are static — they do not swap on hover.
        Per-bar detail lives in its own row below so glancing at the card
        always answers "what is this and what is it worth" without waiting
        on a pointer.
      */}
      <div style={INFO_ROW}>
        <span style={TITLE}>{ticker ?? '—'}</span>
        {data.interval !== undefined && <Pill>{data.interval}</Pill>}
        <Pill>{t.bars(data.bars.length)}</Pill>
        {data.first_bar_date !== undefined && data.last_bar_date !== undefined && (
          <Pill>{formatBarDateTime(data.first_bar_date)} → {formatBarDateTime(data.last_bar_date)}</Pill>
        )}
        {last !== undefined && (
          <Pill
            tone={change === undefined ? undefined : change >= 0 ? 'up' : 'down'}
            title={first === undefined ? undefined : t.changeTitle(formatBarDateTime(first.date), first.close, formatBarDateTime(last.date), last.close)}
            style={{ marginLeft: 'auto' }}
          >
            {formatPrice(last.close)}{data.currency === undefined ? '' : ` ${data.currency}`}
            {change !== undefined && <span>{change >= 0 ? '+' : ''}{change.toFixed(2)}%</span>}
          </Pill>
        )}
      </div>

      {/*
        Always rendered, never removed — only `visibility` toggles. Removing
        the span when unhovered was what let the row's height depend on a
        hand-guessed minHeight instead of the text's real line box.
      */}
      <div style={HOVER_ROW}>
        <span style={{ visibility: hovered === undefined ? 'hidden' : 'visible', color: hovered === undefined ? undefined : hovered.rising ? UP : DOWN }}>
          {hovered === undefined ? ' ' : t.hover(hovered.bar)}
        </span>
      </div>

      {data.bars.length === 0
        ? <div style={{ opacity: 0.7 }}>{t.noBars}</div>
        : <Candles bars={data.bars} onHover={setHovered} />}

      {warnings !== undefined && warnings.length > 0 && (
        <div style={{ marginTop: 6, opacity: 0.75 }}>⚠ {warnings[0]}</div>
      )}

      <div style={DISCLAIMER}>{t.disclaimer}</div>
    </div>
  )
}
