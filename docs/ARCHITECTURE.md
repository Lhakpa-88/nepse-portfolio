# Architecture

## Design constraints

* No paid API, no always-on server, no budget: GitHub Pages (static hosting) and GitHub Actions (scheduled compute).
* Personal financial data must not be readable in a public repository.
* Calculation accuracy comes before AI features; every number must be auditable.
* No single data provider may be a point of failure.

## Components

```
config/                       shared settings (fees, scoring weights, sources, alerts, holidays)
   │
   ▼
backend/sources.py            provider adapters + Registry (primary → secondary → fallback, retries, rate limit)
backend/collect.py            prices · indices · history · fundamentals · status      ─┐
backend/market_calendar.py    Nepal time, sessions, freshness                          │  JSON files
analytics/technicals.py       SMA, RSI, MACD, Bollinger, support/resistance, volume    ├─► (market-data branch
analytics/scoring.py          fundamental / technical / valuation / market / risk      │    → GitHub Pages /data)
analytics/build.py            analysis.json: scores, signals, screens, top 10          │
ai_engine/news.py             collect, de-duplicate, classify headlines               ─┘
backend/portfolio.py          accounting engine (Python)
backend/secure_store.py       decrypts the private portfolio from secrets
notifications/alerts.py       alert rules, cooldown, cap
notifications/telegram.py     Telegram + optional SMTP
ai_engine/report.py           pre-market, daily, weekly, monthly reports (+ optional Claude summary)
scripts/run_pipeline.py       single entry point; `auto` selects the job from the Nepal clock

frontend/src/lib/engine.ts    accounting engine (TypeScript) – same fixtures as the Python one
frontend/src/lib/recommend.ts position-aware advice
frontend/src/lib/risk.ts      concentration, volatility, drawdown, beta, correlation, TWR, stress test
frontend/src/lib/assistant.ts built-in assistant + optional Claude
frontend/src/lib/store.tsx    private state (localStorage), audit trail
frontend/src/lib/data.tsx     loads the public JSON, client-side freshness check
frontend/src/pages/*          the ten pages
```

## Data files (public, produced by the pipeline)

| File | Contents |
|------|----------|
| `status.json` | Source health, last success per dataset, freshness, reliability, session |
| `prices.json` | Market date, as-of time, source, one row per symbol (OHLC, LTP, change, volume, turnover) |
| `market.json` | Main and sector indices, turnover, volume, transactions, breadth |
| `history/<SYMBOL>.json` | Daily `[date, open, high, low, close, volume]`, up to 520 sessions; `NEPSE.json` for the index |
| `fundamentals.json` | Per company: latest quarter (EPS, book value, ROE, ROA, NPL, CAR…), growth, 8-quarter trend, dividends |
| `companies.json` | Symbol → name and sector cache |
| `analysis.json` | Per stock: indicators, five area scores with components and notes, quality/trading/risk, signal, confidence, data gaps, levels, screens; market regime; sector table; top 10 |
| `news.json` | Classified, de-duplicated items with source links |
| `state/alerts.json` | HMAC digests of sent alerts for cooldown (not deployed to Pages) |

## Private state (browser)

`localStorage["nepse-portfolio-state-v1"]`: transactions (with `voided`, `supersedes`), watchlist, per-stock
plans (target, stop, thesis), settings (engine options, fee schedule, weights, cash, limits) and the audit log.
The encrypted sync file contains the same structure minus API keys and tokens.

## Why two accounting engines

The dashboard must compute instantly in the browser without sending your data anywhere, and the alert pipeline
must compute in Python on GitHub. Rather than trust either, both are tested against one fixture whose expected
values were worked out by hand (`docs/CALCULATIONS.md`). A change that breaks parity fails CI.

## Scheduling

GitHub cron → `scripts/run_pipeline.py auto` → the script reads the Nepal clock and the trading calendar:

| Session | Stages |
|---------|--------|
| Before open | news → prices → pre-market brief |
| Open | prices → analysis → news → alerts |
| After close (before 17:00) | prices + fundamentals → analysis → news → alerts |
| Evening | the same, then the daily report |
| Closed day | news → data refresh; weekly report on Friday evening; monthly report on the 1st |

Each stage is isolated: a failure is logged and the remaining stages still run, and the last good data is still
published together with a status file that says what failed.

## AI design

| Layer | Role | Needs a key? |
|-------|------|--------------|
| Scoring and recommendation rules | All signals, screens, rankings, alerts | No |
| Built-in assistant | Maps a question to a data query and formats the real numbers, tagging Fact / Estimate / Opinion | No |
| Claude in the dashboard | Free-form questions, grounded on a JSON snapshot with instructions not to invent figures | Your own key (optional) |
| Claude in the pipeline | Three-sentence summary appended to reports, from the report text only | Your own key (optional) |

Keeping the numeric layer rule-based is what guarantees no price, ratio or announcement is ever fabricated.

## Optional database (not required)

The system needs no database: the public data is a set of JSON files and the private data is in the browser.
If you later want multi-device sync without the encrypted file, or a multi-year price archive,
`backend/schema.sql` is a PostgreSQL/Supabase schema that mirrors these structures (with row-level security on
the private tables). It is provided as an upgrade path and is **not wired into the application**.

## Possible next steps (Phase 4)

* Historical backtest of the scoring model once more than a year of data has accumulated on the `market-data` branch.
* Dividend forecasting from the dividend history already collected.
* Portfolio optimisation (target weights under concentration and liquidity limits).
* A licensed data provider for intraday and floorsheet data.
