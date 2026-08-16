import { describe, expect, it } from 'vitest'
import { parseHistory } from '../src/client/envelope.ts'

/** Shape taken from a real `tool/result` session event. */
function toolResult(payload: unknown) {
  return [{
    type: 'tool-result',
    toolCallId: 'call_1',
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  }]
}

const SUCCESS = {
  ok: true,
  market: 'us',
  ticker: 'AAPL',
  as_of: '2026-08-15T00:00:00.000Z',
  data: {
    currency: 'USD',
    exchange: 'NasdaqGS',
    interval: '1d',
    price_adjustment: { ohlc: 'split-adjusted', adj_close: 'split-and-dividend-adjusted' },
    bar_count: 2,
    first_bar_date: '2026-05-15',
    last_bar_date: '2026-05-16',
    bars: [
      { date: '2026-05-15', open: 297.9, high: 303.2, low: 296.52, close: 300.23, adj_close: 299.97, volume: 54862800 },
      { date: '2026-05-16', open: 300.5, high: 305.0, low: 299.1, close: 304.4, adj_close: 304.1, volume: 41000000 },
    ],
  },
}

describe('parseHistory', () => {
  it('reads the envelope out of a nested tool-result block', () => {
    const result = parseHistory(toolResult(SUCCESS))
    expect(result?.ok).toBe(true)
    if (result?.ok !== true) return
    expect(result.ticker).toBe('AAPL')
    expect(result.data.bars).toHaveLength(2)
    expect(result.data.bars[0].close).toBe(300.23)
    expect(result.data.last_bar_date).toBe('2026-05-16')
  })

  it('also reads a flat text block, since the host may hand over either level', () => {
    const result = parseHistory([{ type: 'text', text: JSON.stringify(SUCCESS) }])
    expect(result?.ok).toBe(true)
  })

  it('surfaces a failure envelope rather than discarding it', () => {
    const result = parseHistory(toolResult({
      ok: false,
      ticker: 'ZZZZ',
      error: { kind: 'unknown_symbol', message: 'No bars.', retryable: false },
    }))
    expect(result?.ok).toBe(false)
    if (result?.ok !== false) return
    expect(result.error.kind).toBe('unknown_symbol')
    expect(result.error.retryable).toBe(false)
  })

  it('drops bars missing a date or close instead of rendering holes', () => {
    const result = parseHistory(toolResult({
      ...SUCCESS,
      data: { ...SUCCESS.data, bars: [...SUCCESS.data.bars, { date: '2026-05-17' }, { close: 1 }] },
    }))
    if (result?.ok !== true) return
    expect(result.data.bars).toHaveLength(2)
  })

  it.each([
    ['no content at all', undefined],
    ['an empty array', []],
    ['a block with no text', [{ type: 'image' }]],
    ['text that is not JSON', [{ type: 'text', text: 'not json' }]],
    ['JSON that is not an envelope', [{ type: 'text', text: '[1,2,3]' }]],
  ])('returns undefined for %s', (_label, content) => {
    expect(parseHistory(content)).toBeUndefined()
  })

  it('returns undefined when a truncated response replaced data.bars', () => {
    // `stringify` drops `data` wholesale past the output budget.
    const truncated = parseHistory(toolResult({
      ok: true,
      ticker: 'AAPL',
      data: { omitted: true, reason: 'too large' },
      output_truncated: true,
    }))
    expect(truncated?.ok).toBe(true)
    if (truncated?.ok !== true) return
    expect(truncated.data.bars).toEqual([])
  })

  it('keeps warnings so the card can show why bars were trimmed', () => {
    const result = parseHistory(toolResult({ ...SUCCESS, warnings: ['Returned the most recent 500 of 11509 bars.'] }))
    if (result?.ok !== true) return
    expect(result.warnings?.[0]).toMatch(/most recent 500/)
  })
})
