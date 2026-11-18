# NEPSE Portfolio Intelligence

A personal, AI-assisted portfolio management and investment research system for an individual investor on the
Nepal Stock Exchange (NEPSE). It runs entirely on free infrastructure: a static dashboard on **GitHub Pages**, a
scheduled **GitHub Actions** pipeline for data, analysis, news and **Telegram or email** alerts, and no paid API.

> **Decision support only.** Nothing here is licensed investment advice or a prediction, and the system never
> places orders. Every buy or sell is your own manual decision. Prices come from unofficial public sources and can
> be delayed or wrong: confirm with your broker/TMS before trading.

## What it does

| # | Page | What you get |
|---|------|--------------|
| 1 | Overview | Portfolio KPIs, "needs attention" list, NEPSE/sector indices, movers, value-over-time, monthly P/L, allocation |
| 2 | My Portfolio | Holdings, transaction ledger (add / correct / void with audit trail), Excel & CSV import/export |
| 3 | Buy/Sell Analysis | BUY / ACCUMULATE / HOLD / REDUCE / SELL / WATCH per holding with evidence; sell and buy calculators with scenarios |
| 4 | Stock Screener | Every analysed NEPSE stock, searchable and filterable by sector, signal, risk, P/E, ROE, yield |
| 5 | Investment Opportunities | Nine screens plus a transparent top-10 ranking with entry range, upside and downside |
| 6 | Market Intelligence | De-duplicated news and announcements, impact-classified, linked to your holdings |
| 7 | Watchlist | Stocks you track, with buy range and target; Watchlist / Avoid lists |
| 8 | Risk Analysis | Concentration, sector exposure, volatility, drawdown, beta, correlation, liquidity, benchmark, stress test |
| 9 | AI Investment Assistant | Answers questions from your live portfolio and market data; optional Claude for free-form questions |
| 10 | Settings | Cost-basis method, fee/tax schedule, scoring weights, data-source health, encrypted sync, backup |

Automation (GitHub Actions, Nepal time): morning brief before the open · every 30 minutes while the market is open ·
post-close update 15:20 · evening report 18:00 · weekly review on Friday · monthly review on the 1st. GitHub starts
scheduled runs late and sometimes skips one, so each report is sent once per day by whichever run gets there first.

## Architecture in one picture

```
            GitHub Actions (scheduled, free)                         Your browser
 ┌──────────────────────────────────────────────────┐      ┌──────────────────────────────┐
 │ backend/    collect prices, indices, history,    │      │ frontend/ (React + TS + Vite)│
 │             fundamentals  (primary → fallback)   │      │                              │
 │ analytics/  indicators, scores, screens          │ JSON │  market data  ◄── GitHub     │
 │ ai_engine/  news triage, reports                 ├─────►│  (public)         Pages      │
 │ notifications/  alerts ──► Telegram              │      │                              │
 └───────────────▲──────────────────────────────────┘      │  portfolio (private) stays   │
                 │ decrypts with PORTFOLIO_PASSPHRASE       │  in localStorage             │
        data/private/portfolio.enc.json  ◄──────────────────┤  encrypted sync (AES-256)    │
                 (encrypted, safe to commit)                └──────────────────────────────┘
```

* **Public** (on Pages): market prices, indices, analysis, news. No personal data.
* **Private**: your transactions live in your browser. An AES-256-GCM encrypted copy can be committed so the
  pipeline can send position-aware alerts; only you hold the passphrase.

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

1. **Create the GitHub repository and deploy** — follow [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) (about 10 minutes).
2. **Open the dashboard** at `https://<your-username>.github.io/<repo>/` and click *Load DEMO portfolio* to explore.
3. **Enter your transactions** — [docs/USER_GUIDE.md](docs/USER_GUIDE.md). Use the Excel template for bulk import.
4. **Turn on alerts** by Telegram or email — [docs/TELEGRAM_SETUP.md](docs/TELEGRAM_SETUP.md). Telegram is blocked by
   internet providers in Nepal, so check the app works for you; email works on any connection.
5. **Send your encrypted portfolio** (Settings → first card, three guided steps) so alerts know your holdings —
   [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#6-give-the-pipeline-your-holdings-encrypted).

### Run locally

Requires Python 3.11+ and Node.js 20+.

```bash
# 1. collect real market data, analyse it and fetch news (writes frontend/public/data/)
python -m scripts.run_pipeline all --dry-run

# 2. start the dashboard
cd frontend
npm install
npm run dev            # http://localhost:5173
```

```bash
# tests
python -m unittest discover -s tests -t . -v     # 59 tests
cd frontend && npm test                          # 60 tests: calculations, encryption, every page and view rendered
```

Useful pipeline commands (`python -m scripts.run_pipeline --help`):

| Command | Purpose |
|---------|---------|
| `auto` | What the scheduler runs: picks the job from the current Nepal time |
| `collect` / `analyze` / `news` | Individual stages |
| `alerts --dry-run` | Show the alerts that would be sent (content is shown locally only, never in a GitHub log) |
| `report daily --dry-run` | Preview a report (`premarket`, `daily`, `weekly`, `monthly`) |
| `test-telegram` | Guided Telegram check: with only the token set the bot tells you your chat id, then it sends a test |
| `test-email` | Send a test email |

## Data sources and their limits (please read)

There is **no free official NEPSE API**: `nepalstock.com` rejects anonymous API calls (HTTP 401). After testing
what is actually reachable, the system uses the public JSON that three Nepali finance sites serve to their own
pages, in a fallback chain, and cross-checks prices between two of them on every run:

| Data | Primary → fallback | Notes |
|------|--------------------|-------|
| Prices | ShareHub → NepaliPaisa → Chukul | Snapshot, not tick-by-tick; refreshed every 30 min in market hours |
| Indices & sectors | NepaliPaisa → ShareHub | |
| Daily history | Chukul → NepaliPaisa | About one year, so charts and the 200-day average start there |
| Fundamentals, dividends | ShareHub | Latest reported quarter; refreshed weekly |
| News | ShareSansar, NEPSE/company announcements (via ShareHub), NRB RSS | Headlines only |

These endpoints are **unofficial and undocumented**. They can change or disappear, and their terms of use may
restrict automated access; this project is for personal, non-commercial use at low request rates. When a source
fails the pipeline falls back, and when all fail the dashboard shows the last closing price **with its date and a
warning** — it never substitutes an invented price. Details: [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).

Not available for free, and therefore not implemented: true real-time ticks, market depth, floorsheet/broker
analysis, multi-year valuation history, and automatic coverage of Ministry of Finance, Merolagani and
international news.

## Documentation

| Guide | Contents |
|-------|----------|
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Step-by-step GitHub repository, Pages and Actions setup |
| [DATA_SOURCES.md](docs/DATA_SOURCES.md) | Source investigation, configuration, adding a licensed provider |
| [TELEGRAM_SETUP.md](docs/TELEGRAM_SETUP.md) | Telegram and email alerts: which to choose, setup, thresholds |
| [USER_GUIDE.md](docs/USER_GUIDE.md) | Adding, correcting and removing transactions; import; daily use |
| [CALCULATIONS.md](docs/CALCULATIONS.md) | Every formula, with the hand-worked examples used in the tests |
| [METHODOLOGY.md](docs/METHODOLOGY.md) | Scoring model, recommendation rules, confidence, screens |
| [SECURITY.md](docs/SECURITY.md) | What is public, what is private, encryption, threat model |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common problems and routine maintenance |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data files, optional database schema |

## Repository layout

```
frontend/        React + TypeScript + Vite + Tailwind + Recharts dashboard (served by GitHub Pages)
backend/         data-source adapters, collectors, trading calendar, accounting engine, encrypted store
analytics/       technical indicators, scoring model, screens and ranking
ai_engine/       news triage, reports, optional Claude summary
notifications/   alert rules, Telegram and email channels
scripts/         run_pipeline.py (single entry point)
config/          fees.json, scoring.json, sources.json, alerts.json, holidays.json
data/            templates (import template, DEMO portfolio), private/ (encrypted file only)
tests/           Python tests and the shared hand-computed fixture
.github/workflows/  pipeline.yml (schedule + deploy), ci.yml (tests)
docs/            guides
```

## Licence and responsibility

For personal use. You are responsible for your own investment decisions and for complying with the terms of the
data sources you enable. Tax and fee figures are a best-effort record: verify against your broker's contract note.
