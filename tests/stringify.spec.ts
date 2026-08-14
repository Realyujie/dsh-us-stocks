import { describe, expect, it } from 'vitest'
import { MAX_TOOL_OUTPUT_CHARACTERS, stringify } from '../src/util/stringify.ts'

describe('stringify', () => {
  it('passes small payloads through unchanged', () => {
    const value = { ok: true, data: { price: 1 } }
    expect(JSON.parse(stringify(value))).toEqual(value)
  })

  it('drops data but keeps the envelope when over the limit', () => {
    const value = {
      ok: true,
      market: 'us',
      ticker: 'AAPL',
      warnings: ['pre-existing'],
      data: { bars: Array.from({ length: 20_000 }, (_, index) => ({ index, close: 123.456 })) },
    }

    const serialized = stringify(value)
    expect(serialized.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARACTERS)

    const parsed = JSON.parse(serialized)
    expect(parsed.output_truncated).toBe(true)
    expect(parsed.original_characters).toBeGreaterThan(MAX_TOOL_OUTPUT_CHARACTERS)
    expect(parsed.ticker).toBe('AAPL')
    expect(parsed.data.omitted).toBe(true)
    expect(parsed.warnings).toContain('pre-existing')
    expect(parsed.warnings.at(-1)).toMatch(/omitted/i)
  })

  it('falls back to a bare error when even the envelope is oversized', () => {
    const value = {
      ok: true,
      // Warnings are capped at 10 entries, but each one here is already huge.
      warnings: Array.from({ length: 10 }, () => 'w'.repeat(10_000)),
      data: { filler: 'x'.repeat(100_000) },
    }

    const parsed = JSON.parse(stringify(value))
    expect(parsed.ok).toBe(false)
    expect(parsed.output_truncated).toBe(true)
    expect(parsed.error.kind).toBe('response_too_large')
    expect(parsed.error.retryable).toBe(true)
  })

  it('handles non-object payloads that exceed the limit', () => {
    const parsed = JSON.parse(stringify('x'.repeat(MAX_TOOL_OUTPUT_CHARACTERS + 10)))
    expect(parsed.output_truncated).toBe(true)
  })
})
