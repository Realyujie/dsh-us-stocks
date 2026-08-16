/** Shapes the client reads out of a settled `get_history` call. */

export interface Bar {
  readonly date: string
  readonly open?: number
  readonly high?: number
  readonly low?: number
  readonly close: number
  readonly adj_close?: number
  readonly volume?: number
}

export interface HistoryData {
  readonly currency?: string
  readonly exchange?: string
  readonly interval?: string
  readonly bar_count?: number
  readonly first_bar_date?: string
  readonly last_bar_date?: string
  readonly bars: readonly Bar[]
}

export type HistoryEnvelope =
  | { readonly ok: true, readonly ticker?: string, readonly data: HistoryData, readonly warnings?: readonly string[] }
  | { readonly ok: false, readonly ticker?: string, readonly error: { readonly kind: string, readonly message: string, readonly retryable: boolean } }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Pull the tool's JSON text out of a settled call's content.
 *
 * The blocks arrive nested: a `tool-result` block carries the text block the
 * tool actually returned. Whether the host hands over the outer or the inner
 * level is not pinned down by its types, so both are walked.
 */
function findToolText(content: unknown, depth = 0): string | undefined {
  if (depth > 3 || !Array.isArray(content)) return undefined
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') return block.text
    const nested = findToolText(block.content, depth + 1)
    if (nested !== undefined) return nested
  }
  return undefined
}

/** Numbers only; the shaper already dropped non-finite values server-side. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function toBar(raw: unknown): Bar | undefined {
  if (!isRecord(raw)) return undefined
  const date = typeof raw.date === 'string' ? raw.date : undefined
  const close = num(raw.close)
  if (date === undefined || close === undefined) return undefined
  return {
    date,
    close,
    open: num(raw.open),
    high: num(raw.high),
    low: num(raw.low),
    adj_close: num(raw.adj_close),
    volume: num(raw.volume),
  }
}

/**
 * Parse a settled call's content into the envelope, or `undefined` when the
 * payload is not one this view can read — a truncated response, a shape change
 * upstream, or simply another tool's output reaching this key.
 */
export function parseHistory(content: unknown): HistoryEnvelope | undefined {
  const text = findToolText(content)
  if (text === undefined) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined

  const ticker = typeof parsed.ticker === 'string' ? parsed.ticker : undefined

  if (parsed.ok === false) {
    const error = isRecord(parsed.error) ? parsed.error : {}
    return {
      ok: false,
      ticker,
      error: {
        kind: typeof error.kind === 'string' ? error.kind : 'internal',
        message: typeof error.message === 'string' ? error.message : 'Unknown error.',
        retryable: error.retryable === true,
      },
    }
  }

  if (parsed.ok !== true || !isRecord(parsed.data)) return undefined
  const data = parsed.data

  // A truncated response keeps the envelope but replaces `data` with a notice.
  const bars = (Array.isArray(data.bars) ? data.bars : [])
    .map(toBar)
    .filter((bar): bar is Bar => bar !== undefined)

  return {
    ok: true,
    ticker,
    data: {
      currency: typeof data.currency === 'string' ? data.currency : undefined,
      exchange: typeof data.exchange === 'string' ? data.exchange : undefined,
      interval: typeof data.interval === 'string' ? data.interval : undefined,
      bar_count: num(data.bar_count),
      first_bar_date: typeof data.first_bar_date === 'string' ? data.first_bar_date : undefined,
      last_bar_date: typeof data.last_bar_date === 'string' ? data.last_bar_date : undefined,
      bars,
    },
    warnings: Array.isArray(parsed.warnings)
      ? parsed.warnings.filter((w): w is string => typeof w === 'string')
      : undefined,
  }
}
