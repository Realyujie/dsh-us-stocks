# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-08-17

### Added

- `get_quote` returns fund detail for ETFs and mutual funds: expense ratio
  against its category average, net assets, category, issuer, asset
  allocation, trailing returns, and top holdings with the share of the fund
  they cover. Observed without it: asked to look at XLK, the agent called this
  plugin, found no expense ratio or holdings, and fell back to `web_search`
  for exactly those two — which returned link titles and no content, spending
  9.4s of a 27s answer and an extra step to learn nothing. The expense ratio
  then went unmentioned, and the holdings were recited from memory in the
  wrong order.

  The extra call fires only once the quote reports a fund, so equities are
  unaffected; a fund quote costs roughly three times an equity one. If it
  fails the quote is still returned, with a warning, since the price is
  already in hand.

  Mutual funds are covered alongside ETFs. They report the same modules, and
  gating on `ETF` alone would have dropped every `VFIAX`-shaped symbol.

- `fund_notes` in fund responses, carrying three caveats where the numbers are
  read rather than only in the docs: that `trailing_pe` and its neighbours are
  holdings-weighted aggregates for a fund (a model was seen calling an ETF's
  P/E an expensive valuation, with nothing to suggest otherwise); that the
  expense ratio is upstream's and can be wrong (FXAIX reported 0.42% against a
  true 0.015%); and that the holdings list is capped at ten, so fund overlap
  cannot be derived from it. Each note appears only when the field it
  qualifies does — commodity and bond funds report no holdings at all.

  `fund_trailing_returns_percent` names its own convention: upstream reports
  `ytd` through `one_year` as the return over that window but annualises
  everything longer, so those keys end in `_annualized`. Verified against SPY,
  whose reported five-year 12.76% is the annualised form of an 83.95%
  cumulative — read as cumulative it is wrong by a factor of four.

- `get_ownership`, a sixth tool: the insider/institutional split, the largest
  institutional and fund holders with their quarterly position changes, and
  insiders' aggregate buying and selling over six months. `detail: "full"`
  adds individual insider filings and the named insiders; those are most of
  the payload, so they are opt-in and the summary modules are all that get
  requested otherwise.

  Measured before building it — asked "have insiders been buying or selling"
  and "who is buying this stock", the agent made no plugin call and ran 11
  `web_search` calls across six steps, 102.5s for the two questions. It
  arrived at 65.7% institutional ownership from a scraped page dated five
  weeks earlier against Yahoo's 68.85%, never mentioned the 8.87% insiders
  hold, and built "insiders are selling" out of one large filing while the
  six-month aggregate was net +456,643 shares.

  `institutional_activity` is a sibling of `insider_activity` rather than a
  member of it. Upstream returns both from one module, and following that
  shape gave a path — `insider_activity.net_institutional_shares` — whose name
  said insiders and whose value was institutions. Only the insider block
  carries a `period`; upstream never states the window its institutional net
  spans, so this does not either.

  `ownership_note` states that holder rows are as of their own `report_date`
  and that the six-month aggregate can be net positive while one insider was
  visibly selling — the reconciliation a model would otherwise have to guess
  at. Filings are made against operating companies, so ETFs and funds return
  `no_data` pointing at `get_quote` for a fund's own holdings.

### Fixed

- `get_analyst_view` relayed upstream's "No fundamentals data found for
  symbol: XLK" for funds, which reads as a fault rather than as permanent.
  It now explains that analysts rate companies and funds therefore carry no
  ratings, targets or estimates, matching how `get_financials` already answers
  the same question about statements.

### Notes

- `^0.2.0` does not admit 0.3.0 under semver's caret rule for `0.x`, so
  `dsh plugin update` will not pick this release up. Install it explicitly:

  ```bash
  dsh plugin --profile web add dsh-us-stocks@0.3.0
  ```

## [0.2.0] - 2026-08-15

### Added

- Candlestick chart for `get_history` in the Web UI. The call's result card is
  drawn by a browser half this release adds: bodies, wicks, a volume band,
  price gridlines, date labels and per-bar OHLC on hover. It reads the tool's
  own returned payload rather than fetching a second copy, so the picture and
  the numbers the model saw cannot drift apart. Colours come from the host's
  theme tokens, green rising and red falling — the US convention.

  Chart labels follow the host language, English or Chinese. Text from the
  data source is shown verbatim in either locale: those messages are written
  for the model as much as for the reader, and translating one audience's copy
  would split what the two see.

  The chart is additive: a TUI or headless profile has no browser half, and
  every tool behaves exactly as before there.

- `get_history` accepts `interval: "1h"`, covering about 5 weeks per call.
  Hourly bars carry a full ISO timestamp in `date` rather than the `1d`/`1wk`/
  `1mo` `yyyy-MM-dd` — several bars share a calendar day at that granularity,
  and a date-only label collapsed them onto one indistinguishable value.
  Upstream separately refuses `1h` history older than about 730 days
  regardless of the requested window; that now surfaces as `invalid_argument`
  rather than the generic `internal` a free-text Yahoo error fell into before.

- `get_history` responses carry a `chart_note` telling the model that a Web UI
  call already rendered a chart. Observed without it: the model called the
  tool, a chart rendered, and — unaware the request was already satisfied —
  it spent a minute installing `matplotlib` into a virtualenv to draw a
  second one from the same data.

### Fixed

- `get_history`'s description claimed it returns "no chart image", written
  before the chart existed and left uncorrected when it shipped. The model
  had no way to know a call it was about to make would already satisfy a
  request to see a chart.

### Notes

- `^0.1.0` does not admit 0.2.0 under semver's caret rule for `0.x`, so
  `dsh plugin update` will not pick this release up. Install it explicitly:

  ```bash
  dsh plugin --profile web add dsh-us-stocks@0.2.0
  ```

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

[Unreleased]: https://github.com/Realyujie/dsh-us-stocks/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Realyujie/dsh-us-stocks/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Realyujie/dsh-us-stocks/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Realyujie/dsh-us-stocks/releases/tag/v0.1.0
