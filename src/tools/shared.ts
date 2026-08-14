/** Pieces every tool definition in this plugin repeats. */

/** Every tool serializes its envelope to a JSON string and renders it as text. */
export function jsonOutput() {
  return {
    schema: { type: 'string' as const },
    render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
  }
}

/**
 * Tickers are treated as opaque strings. No US-specific validation lives here —
 * a future market would reuse this schema with a different example set.
 */
export function tickerSchema(description: string) {
  return { type: 'string' as const, required: true as const, description }
}

/** Shared cooperative timeout budget; upstream calls settle well inside this. */
export const TOOL_TIMEOUT_MS = 25_000

/** Round to `digits` places, dropping non-finite values so JSON stays clean. */
export function round(value: unknown, digits = 4): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** Pass through only finite numbers. */
export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Pass through only non-empty strings. */
export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Normalize a Date, epoch-seconds number, or ISO string to an ISO string. */
export function isoDate(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString()
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Yahoo returns epoch seconds for timestamps; milliseconds would land in the far future.
    const date = new Date(value < 1e11 ? value * 1000 : value)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  if (typeof value === 'string' && value.length > 0) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  return undefined
}

/** Drop `undefined` entries so the model never sees empty keys. */
export function compact<T extends Record<string, unknown>>(record: T): Partial<T> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) result[key] = value
  }
  return result as Partial<T>
}
