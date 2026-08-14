# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-14

Initial release. US equities only.

### Added

- `get_quote` — live quote: price, change, day range, volume (10-day and 3-month
  averages), market cap, P/E, EPS (trailing, current-year, forward), book value
  per share, dividend yield, 52-week range, moving averages and listing date.
  Earnings dates are reported as separate `last_earnings_date` and
  `next_earnings_date` fields, with `next_earnings_date_is_estimate` marking a
  projected rather than company-confirmed date. Analyst ratings are intentionally
  excluded here and confined to `get_analyst_view`.
- `get_history` — OHLCV bars with adjusted close at daily, weekly or monthly
  interval, by trailing range or explicit date window, plus any dividends and
  splits inside that window. Structured data only, no chart rendering. Every
  response carries a `price_adjustment` note because OHLC are split-adjusted
  while `adj_close` is split- and dividend-adjusted. Bars are trimmed against the
  measured payload size rather than a fixed count, so a response never overflows
  the output budget; when trimmed, the warning names the next coarser interval.
- `get_financials` — income statement, balance sheet and cash flow line items,
  quarterly or annual, in summary or full detail. Each response states its
  `reporting_currency`, which for an ADR is the home-market currency rather than
  USD; without it, raw figures invite an order-of-magnitude misreading. A
  `ratios` block carries trailing-twelve-month margins, returns, growth and
  leverage, with `debt_to_equity_percent` named for the 100x scaling Yahoo
  applies to that one field. Full trailing-twelve-month statements are not
  offered, as upstream returns a period type that fails schema validation.
- `get_analyst_view` — consensus rating, buy/hold/sell counts by month, price
  targets with derived upside, forward EPS and revenue estimates, the ten most
  recent broker upgrades and downgrades, and the EPS beat/miss record. The 1–5
  rating scale is restated in every response, since a lower number being more
  bullish reads backwards otherwise.
- `get_news` — recent headlines with publisher, timestamp and link. Metadata
  only; article bodies are not fetched. Headlines are filtered to those actually
  referencing the symbol, with a company-name search as a second pass, because
  the upstream text search returns unrelated stories for tickers that are also
  ordinary words. When every match is noise the tool reports `no_data` rather
  than returning articles about other companies.
- Structured failure taxonomy with an explicit `retryable` flag, separating
  absent data from transient upstream faults.
- 64,000-character output budget enforcement that preserves the response
  envelope and reports `original_characters` when data is dropped.
- Short-TTL in-memory cache with in-flight request de-duplication; failures are
  not cached.
- AAPL acceptance benchmark (`npm run benchmark`) and a live smoke test
  (`npm run test:live`).

### Notes

- Financial statements are sourced from Yahoo's `fundamentalsTimeSeries`
  endpoint rather than the `quoteSummary` statement modules, which have returned
  only a handful of income-statement fields and lagged by one reporting period
  since late 2024.

[Unreleased]: https://github.com/Realyujie/dsh-us-stocks/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Realyujie/dsh-us-stocks/releases/tag/v0.1.0
