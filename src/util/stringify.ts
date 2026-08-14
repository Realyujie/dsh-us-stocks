/** Hard ceiling on a single tool result, matching the DSH tool output budget. */
export const MAX_TOOL_OUTPUT_CHARACTERS = 64_000

/**
 * Serialize a tool result, degrading gracefully when it exceeds the output
 * budget. Oversized payloads keep their envelope (so the model still learns the
 * ticker and the failure mode) but drop `data`, and carry the metadata the
 * model needs to retry with a narrower query.
 */
export function stringify(value: unknown): string {
  const serialized = JSON.stringify(value)
  if (serialized.length <= MAX_TOOL_OUTPUT_CHARACTERS) return serialized

  const record = isRecord(value) ? value : {}
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.filter((item): item is string => typeof item === 'string').slice(0, 10)
    : []
  const bounded = JSON.stringify({
    ...record,
    data: {
      omitted: true,
      reason: 'Response exceeded the 64k character tool output limit. Narrow the date range, lower `limit`, or request fewer periods.',
    },
    warnings: [...warnings, 'Full data omitted because it exceeded the tool output limit.'],
    output_truncated: true,
    original_characters: serialized.length,
  })
  if (bounded.length <= MAX_TOOL_OUTPUT_CHARACTERS) return bounded

  return JSON.stringify({
    ok: false,
    output_truncated: true,
    original_characters: serialized.length,
    error: {
      kind: 'response_too_large',
      retryable: true,
      message: 'Response exceeded the 64k character tool output limit. Narrow the query.',
    },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
