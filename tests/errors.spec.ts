import { describe, expect, it } from 'vitest'
import { classify, DataSourceError, failure, guard, success } from '../src/util/errors.ts'

describe('classify', () => {
  it('preserves an already-classified DataSourceError', () => {
    const result = classify(new DataSourceError('no_data', 'nothing filed'))
    expect(result).toEqual({ kind: 'no_data', retryable: false, message: 'nothing filed' })
  })

  it.each([
    ['Yahoo! Finance returned 429 Too Many Requests', 'rate_limited', true],
    ['fetch failed', 'upstream_unavailable', true],
    ['No set-cookie header present in Yahoo\'s response', 'upstream_unavailable', true],
    ['Yahoo returned 503 Service Unavailable', 'upstream_unavailable', true],
    ['Quote not found for symbol ZZZZ', 'unknown_symbol', false],
    // A valid symbol that simply does not carry the dataset, e.g. an ETF.
    ['No fundamentals data found for symbol: SPY', 'no_data', false],
    ['No earnings data found for symbol: XYZ', 'no_data', false],
    ['The operation timed out', 'timeout', true],
    ['something completely unexpected', 'internal', false],
  ])('maps %j to %s', (message, kind, retryable) => {
    const result = classify(new Error(message))
    expect(result.kind).toBe(kind)
    expect(result.retryable).toBe(retryable)
  })

  it('treats an AbortError as a timeout regardless of message', () => {
    const error = new Error('aborted by caller')
    error.name = 'AbortError'
    expect(classify(error)).toMatchObject({ kind: 'timeout', retryable: true })
  })

  it('marks unknown_symbol and no_data as non-retryable so the model stops asking', () => {
    expect(failure('us', 'unknown_symbol', 'x').error.retryable).toBe(false)
    expect(failure('us', 'no_data', 'x').error.retryable).toBe(false)
    expect(failure('us', 'invalid_argument', 'x').error.retryable).toBe(false)
  })
})

describe('envelopes', () => {
  it('omits optional keys rather than emitting undefined', () => {
    const envelope = success('us', { a: 1 })
    expect(envelope).not.toHaveProperty('ticker')
    expect(envelope).not.toHaveProperty('warnings')
    expect(envelope.ok).toBe(true)
    expect(typeof envelope.as_of).toBe('string')
  })

  it('includes warnings only when non-empty', () => {
    expect(success('us', {}, { warnings: [] })).not.toHaveProperty('warnings')
    expect(success('us', {}, { warnings: ['heads up'] })).toHaveProperty('warnings', ['heads up'])
  })

  it('guard converts a thrown error into a failure envelope', async () => {
    const result = await guard('us', 'AAPL', async () => {
      throw new DataSourceError('rate_limited', 'slow down')
    })
    expect(result).toEqual({
      ok: false,
      market: 'us',
      ticker: 'AAPL',
      error: { kind: 'rate_limited', retryable: true, message: 'slow down' },
    })
  })

  it('guard passes a success envelope through untouched', async () => {
    const result = await guard('us', 'AAPL', async () => success('us', { price: 1 }, { ticker: 'AAPL' }))
    expect(result.ok).toBe(true)
  })
})
