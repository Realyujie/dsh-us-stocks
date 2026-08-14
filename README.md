# dsh-us-stocks

English | [中文](README.zh.md)

US stock market data tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), powered by [`yahoo-finance2`](https://github.com/gadicc/yahoo-finance2).

Gives the agent five first-class tools for quotes, price history, financial statements, analyst consensus and news — instead of leaving it to improvise against HTML pages.

## Before and after

One agent turn, same question, same model, same machine — the only variable is whether the plugin is installed. The task: *price, three-month trend, recent quarterly financials, analyst rating and recent news for AAPL.*

| | Without this plugin | With this plugin |
|---|---|---|
| Steps | 14 | 2 |
| Tool calls | 31 | 5 |
| Wall clock | 213.5s | 33.2s |
| What it called | 16 × `web_search`, 15 × `bash` | one call to each of the five tools |

With no market-data tool available, the agent falls back on web search and shell commands, fetching and parsing one page at a time.

Most of the remaining 33 seconds is model inference, which no plugin controls. Data retrieval itself is 2.6s:

```
Acceptance benchmark — AAPL

  ✅ get_quote           2092ms  305.26 USD (+0.9959%), mcap 4455.02B
  ✅ get_history          437ms  63 bars 2026-05-14..2026-08-13
  ✅ get_financials      2255ms  4 income / 4 balance / 4 cash-flow periods
  ✅ get_analyst_view    2557ms  buy from 41 analysts, target 322.2844
  ✅ get_news             974ms  8 headlines, latest "Tim Cook’s Final Act: A $60 Billion Bet On Texa…"

  tool calls        5
  wall clock        2.56s (concurrent)
  payload           22.0 KiB across 5 results
```

Reproduce with `npm run benchmark`, optionally against another ticker: `npm run benchmark -- TTMI`.

## Install

### The lazy way

Say it to your DeepSeek Harness:

```
Install this plugin: https://github.com/Realyujie/dsh-us-stocks
```

The agent reads this README and runs the command itself. It will ask for filesystem permission on the way, because the profile directory sits outside the session workspace.

### By hand

If `dsh` is on your `PATH`:

```bash
dsh plugin --profile web add dsh-us-stocks
```

If it is not — which is the case when Harness was started through `npx`, since the binary then only exists in the npx cache — call it through `npx` instead:

```bash
npx @deepseek-ai/dsh plugin --profile web add dsh-us-stocks
```

Every command below works the same way: prefix it with `npx @deepseek-ai/dsh` in place of `dsh`, or install the CLI globally once with `npm install -g @deepseek-ai/dsh` and use the short form throughout.

To update later:

```bash
dsh plugin --profile web update dsh-us-stocks
```

Restart the profile afterwards — plugins are resolved when the tree is composed at boot.

For local development, point the profile at a checkout instead. Changes take effect after `npm run build` and a restart:

```bash
dsh plugin --profile web add link:/absolute/path/to/dsh-us-stocks
```

`dsh plugin` forwards to pnpm inside the profile directory and keeps the profile's `dsh.profile.bundles` list in step, so no manual registration is needed.

The plugin registers server-side agent tools only. It ships no browser UI.

## Tools

| Tool | Returns |
|---|---|
| `get_quote` | Last price, change, day range, volume, market cap, P/E, EPS, book value, dividend yield, 52-week range, moving averages, last and next earnings dates |
| `get_history` | Daily/weekly/monthly OHLCV bars with adjusted close, plus dividends and splits in the window, as structured data points |
| `get_financials` | Income statement, balance sheet and cash flow line items, quarterly or annual, with the reporting currency and trailing-twelve-month ratios |
| `get_analyst_view` | Consensus rating, buy/hold/sell counts by month, price targets, forward EPS and revenue estimates, recent broker upgrades and downgrades, EPS beat/miss history |
| `get_news` | Recent headlines with publisher, timestamp and link |

### `get_quote`

| Parameter | Type | Notes |
|---|---|---|
| `ticker` | string, required | e.g. `AAPL`, `BRK-B` |

Earnings dates are reported as `last_earnings_date` and `next_earnings_date` separately, because upstream conflates them in one field. `next_earnings_date_is_estimate` marks a date projected from the reporting cadence rather than confirmed by the company. Across a ten-ticker sample it was true half the time, so it is worth checking rather than assuming either way.

`currency` is what the stock trades in; `financial_currency` is what the company reports in. They differ for ADRs, and only the latter applies to the figures in `get_financials`.

Analyst ratings are deliberately not part of this tool even though upstream returns one. Consensus ratings and price targets live in `get_analyst_view`, so a caller that only wants market data never has a recommendation put in front of it.

### `get_history`

| Parameter | Type | Notes |
|---|---|---|
| `ticker` | string, required | |
| `range` | enum | `5d` `1mo` `3mo` `6mo` `1y` `2y` `5y` `10y` `max`. Default `1y` |
| `start_date` / `end_date` | string | `yyyy-MM-dd`; `start_date` overrides `range` |
| `interval` | enum | `1d` `1wk` `1mo`. Default `1d`. One call covers ~2 years at `1d`, ~8 at `1wk`, ~35 at `1mo` |
| `limit` | integer | Keep the most recent N bars, 1–500. Defaults to every bar in the window |

Bars are ordered oldest to newest. No chart is rendered — visualisation is the caller's job.

Dividends and splits falling inside the returned window come back as `dividends` and `splits`; both keys are absent for symbols that have never paid or split.

**The two price bases are not interchangeable.** `open`/`high`/`low`/`close` are adjusted for splits only; `adj_close` is adjusted for splits *and* dividends. Over 2019–2026, 91 of 93 AAPL monthly bars have `close ≠ adj_close`, so mixing them in one calculation is quietly wrong. Every response states this in `price_adjustment`.

Bars are trimmed to fit the output budget rather than to a fixed count, since a bar costs 117–127 characters depending on price magnitude and interval. In practice a request for `max` returns 266–489 bars. When trimming happens, the warning names the next coarser interval to use for the full span.

### `get_financials`

| Parameter | Type | Notes |
|---|---|---|
| `ticker` | string, required | |
| `period` | enum | `quarterly` (default) or `annual` |
| `statements` | array | Any of `income` `balance` `cash_flow`. Default all three |
| `limit` | integer | Most recent N periods, 1–8. Default 4 |
| `detail` | enum | `summary` (default, headline line items) or `full` (every reported field) |

Upstream depth is fixed and cannot be widened by asking for an earlier start: about 5 periods of income statement and cash flow, 7 of balance sheet, quarterly or annual alike.

Every response carries `reporting_currency`. **This is not always USD.** An ADR files in its home currency while trading in dollars — TSM in TWD, SAP in EUR, BABA in CNY, NVO in DKK — so raw revenue is off by ~32x for TSM against a USD filer. If the currency cannot be determined the statements are still returned, with a warning not to assume USD.

A full trailing-twelve-month *statement* is not available: the upstream `trailing` period type returns `periodType: "TTM"`, which fails `yahoo-finance2`'s schema validation, and reading it would mean disabling result validation wholesale. TTM *aggregates* — revenue, gross profit, EBITDA, free cash flow and the margin, return, growth and leverage ratios — do come back, in the `ratios` block.

Margins, returns and growth rates in `ratios` are unitless fractions (`0.27` means 27%). `debt_to_equity_percent` is the exception: Yahoo scales it by 100, so AAPL's 0.784x arrives as `78.445`. It keeps the upstream value and carries the unit in its name rather than being silently rescaled.

### `get_analyst_view`

| Parameter | Type | Notes |
|---|---|---|
| `ticker` | string, required | |

**`recommendation_mean` runs 1–5 where 1 is Strong Buy and 5 is Strong Sell** — a lower number is more bullish, which reads backwards if taken as a score out of five. Each response repeats the scale in `recommendation_mean_scale` rather than relying on the reader to know it.

Period codes count away from now in opposite directions: `recommendation_trend` uses `0m` for this month and `-1m` for last month, while `estimates` uses `0q`/`+1q` for the current and next quarter and `0y`/`+1y` for the current and next fiscal year. `earnings_surprises` uses `-1q` for the most recently reported quarter.

`rating_changes` keeps the ten most recent broker actions, newest first; upstream holds hundreds. `action` is `up`, `down`, `main` (reiterated) or `init` (coverage initiated).

Prices here are in the trading currency (USD for US listings) even when the company reports in another — unlike the statement figures in `get_financials`.

### `get_news`

| Parameter | Type | Notes |
|---|---|---|
| `ticker` | string, required | |
| `limit` | integer | 1–10. Default 10 |

Headline metadata only. Article bodies are not fetched. Upstream returns at most 10 headlines regardless of what is requested, so 10 is both the default and the ceiling.

**Only headlines that actually reference the symbol are returned.** The upstream news search matches text, so a ticker that is also an ordinary word pulls in unrelated stories — searching `ALL` returned a Finnish bank's tender offer and a mineral resource update, `KEY` returned UK property filings, none of which mention Allstate or KeyCorp. Results are filtered against each article's related-tickers list, and when the symbol pass comes up short the company name is searched as well. That recovered `ALL` from 0 of 6 relevant to 6 of 6, and `KEY` likewise. The number of discarded headlines is reported as a warning; if every match is noise the tool fails with `no_data` and says so, rather than returning plausible-looking articles about other companies.

## Response shape

Every tool returns a JSON string with a consistent envelope.

Success:

```json
{
  "ok": true,
  "market": "us",
  "ticker": "AAPL",
  "as_of": "2026-08-14T09:28:31.204Z",
  "data": { "…": "…" },
  "warnings": ["Returned the most recent 455 of 11509 bars, the most that fits the tool output budget. …"]
}
```

Failure — never a bare exception:

```json
{
  "ok": false,
  "market": "us",
  "ticker": "ZZZZ",
  "error": {
    "kind": "unknown_symbol",
    "retryable": false,
    "message": "No quote data for symbol \"ZZZZ\"."
  }
}
```

`retryable` is the field that matters to the model. It separates "this ticker genuinely has no such data, stop asking" from "the upstream hiccuped, the same call may work shortly".

| `kind` | `retryable` | Meaning |
|---|---|---|
| `unknown_symbol` | no | Symbol does not resolve to any instrument |
| `no_data` | no | Symbol is valid but this dataset is absent (ETFs file no income statement) |
| `invalid_argument` | no | Argument the tool cannot honour |
| `upstream_unavailable` | yes | Upstream refused or errored transiently |
| `rate_limited` | yes | Upstream throttled the request |
| `timeout` | yes | Deadline or caller cancellation fired |
| `response_too_large` | yes | Payload exceeded the output budget even after the envelope was stripped |
| `internal` | no | Unclassified |

Results above 64,000 characters are truncated: `data` is dropped, the envelope is preserved, and `output_truncated` plus `original_characters` tell the model to retry with a narrower query. `get_history`, whose payload scales with the requested window, trims its own bars against the measured size first, so it reaches that fallback only in pathological cases.

## Configuration

```yaml
enabled: true          # register the tools
market: us             # only "us" today
quoteTtlMs: 10000      # live quote cache lifetime
referenceTtlMs: 300000 # statements, bars, ratings and news cache lifetime
```

Caching is in-memory and per-process. Concurrent identical requests are collapsed onto a single upstream call, so an agent fanning five tools at one ticker does not make five redundant round trips. Failures are never cached.

## Development

```bash
npm install
npm run typecheck
npm test            # unit tests, no network
npm run build
npm run test:live   # live smoke test against Yahoo, needs network
npm run benchmark   # AAPL acceptance benchmark
```

Requires Node >= 22.19.0.

### Layout

```
src/
├── index.ts                    apply(ctx, config) entry point
├── config.ts                   schemastery config, incl. the market enum
├── datasource/us/
│   └── yahoo-client.ts         yahoo-finance2 wrapper: caching, cancellation, error typing
├── tools/                      one file per tool, plus shared shaping helpers
└── util/
    ├── cache.ts                short-TTL cache with in-flight de-duplication
    ├── errors.ts               failure taxonomy and envelopes
    └── stringify.ts            output budget enforcement
```

Only US equities are supported. The `datasource/<market>/` split, the `market` config enum and the opaque handling of `ticker` exist so another venue can be added without reshaping the plugin — but nothing else is implemented today.

## Notes on the data source

Financial statements come from Yahoo's `fundamentalsTimeSeries` endpoint rather than the `quoteSummary` statement modules. Since late 2024 those modules return only a handful of income-statement fields and lag by a reporting period; for AAPL they gave 9 populated fields ending 2026-03-31, against 35 ending 2026-06-30 from the endpoint used here.

This is an unofficial, undocumented API. It can change without notice, and it is rate-limited. Data is provided as-is for research; it is not investment advice.

## License

MIT
