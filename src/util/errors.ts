/**
 * Failure taxonomy. The split that matters to the model is `retryable`: a
 * `no_data` result means "stop asking, this ticker genuinely has no such data",
 * whereas `upstream_unavailable` means "the same call may succeed shortly".
 */
export type FailureKind =
  /** Symbol does not resolve to any instrument upstream. */
  | 'unknown_symbol'
  /** Symbol is valid but this dataset is absent (e.g. an ETF has no income statement). */
  | 'no_data'
  /** Caller passed an argument the tool cannot honour. */
  | 'invalid_argument'
  /** Upstream refused or errored transiently. */
  | 'upstream_unavailable'
  /** Upstream throttled us. */
  | 'rate_limited'
  /** Our own deadline or the caller's abort signal fired. */
  | 'timeout'
  /** Anything unclassified. */
  | 'internal'

const RETRYABLE: ReadonlySet<FailureKind> = new Set<FailureKind>([
  'upstream_unavailable',
  'rate_limited',
  'timeout',
])

export interface FailureBody {
  readonly kind: FailureKind
  readonly retryable: boolean
  readonly message: string
}

export interface FailureEnvelope {
  readonly ok: false
  readonly market: string
  readonly ticker?: string
  readonly error: FailureBody
}

export interface SuccessEnvelope<T> {
  readonly ok: true
  readonly market: string
  readonly ticker?: string
  readonly as_of: string
  readonly data: T
  readonly warnings?: readonly string[]
}

export type ToolEnvelope<T> = SuccessEnvelope<T> | FailureEnvelope

/** A failure carrying an already-classified kind, thrown by the datasource layer. */
export class DataSourceError extends Error {
  readonly kind: FailureKind

  constructor(kind: FailureKind, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DataSourceError'
    this.kind = kind
  }
}

export function success<T>(
  market: string,
  data: T,
  options: { ticker?: string, warnings?: readonly string[] } = {},
): SuccessEnvelope<T> {
  const envelope: SuccessEnvelope<T> = {
    ok: true,
    market,
    ...(options.ticker === undefined ? {} : { ticker: options.ticker }),
    as_of: new Date().toISOString(),
    data,
    ...(options.warnings === undefined || options.warnings.length === 0
      ? {}
      : { warnings: options.warnings }),
  }
  return envelope
}

export function failure(market: string, kind: FailureKind, message: string, ticker?: string): FailureEnvelope {
  return {
    ok: false,
    market,
    ...(ticker === undefined ? {} : { ticker }),
    error: { kind, retryable: RETRYABLE.has(kind), message },
  }
}

/**
 * Map an arbitrary thrown value onto the failure taxonomy. `yahoo-finance2`
 * surfaces upstream problems as plain `Error`s with characteristic messages, so
 * classification is message-shape based; anything unrecognised stays
 * non-retryable rather than inviting the model into a retry loop.
 */
export function classify(error: unknown): FailureBody {
  if (error instanceof DataSourceError) {
    return { kind: error.kind, retryable: RETRYABLE.has(error.kind), message: error.message }
  }

  const message = error instanceof Error ? error.message : String(error)
  const lowered = message.toLowerCase()

  let kind: FailureKind = 'internal'
  if (error instanceof Error && error.name === 'AbortError') kind = 'timeout'
  else if (lowered.includes('abort') || lowered.includes('timed out') || lowered.includes('timeout')) kind = 'timeout'
  else if (lowered.includes('too many requests') || lowered.includes('429')) kind = 'rate_limited'
  // Checked before the unknown-symbol patterns it would otherwise match: a
  // message like "No fundamentals data found for symbol: SPY" means the symbol
  // resolved fine and simply has no such dataset, which an ETF never will.
  else if (/no\s+\w+\s+data found for symbol/.test(lowered)) kind = 'no_data'
  else if (lowered.includes('not found') || lowered.includes('no data found') || lowered.includes('404')) kind = 'unknown_symbol'
  // Yahoo's chart endpoint rejects an interval/range combination it cannot
  // serve — e.g. hourly bars requested more than 730 days back — with a
  // message shaped "{interval} data not available for startTime=... The
  // requested range must be within the last N days." Retrying the identical
  // call fails identically; the caller must narrow the range or use a
  // coarser interval, which is what invalid_argument means here.
  else if (lowered.includes('data not available for starttime')) kind = 'invalid_argument'
  else if (
    lowered.includes('set-cookie')
    || lowered.includes('crumb')
    || lowered.includes('fetch failed')
    || lowered.includes('econnreset')
    || lowered.includes('enotfound')
    || lowered.includes('socket')
    || lowered.includes('network')
    || /\b5\d{2}\b/.test(message)
  ) kind = 'upstream_unavailable'

  return { kind, retryable: RETRYABLE.has(kind), message }
}

/** Run a tool body, converting any thrown value into a failure envelope. */
export async function guard<T>(
  market: string,
  ticker: string | undefined,
  body: () => Promise<SuccessEnvelope<T>>,
): Promise<ToolEnvelope<T>> {
  try {
    return await body()
  } catch (error) {
    const classified = classify(error)
    return {
      ok: false,
      market,
      ...(ticker === undefined ? {} : { ticker }),
      error: classified,
    }
  }
}
