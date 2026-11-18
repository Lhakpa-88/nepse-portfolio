# Data sources and API configuration

## What was investigated

Each endpoint below was called anonymously and its response inspected before it was adopted.

| Candidate | Result | Decision |
|-----------|--------|----------|
| `nepalstock.com/api/nots/...` (official NEPSE site) | **HTTP 401** "UNAUTHORIZED ACCESS". The site's own pages use a token scheme that is not offered as a public API | Not used. There is no free official NEPSE API |
| NEPSE licensed data feed | Sold to licensed vendors under contract | Not available to an individual for free |
| ShareHub (`sharehubnepal.com`) | Public JSON: live prices with sector, indices, market summary, fundamentals by quarter, dividend history, NEPSE announcements | **Primary** for prices, fundamentals, dividends, announcements |
| NepaliPaisa (`nepalipaisa.com/api`) | Public JSON: prices with company names, main and sector indices, history | **Primary** for indices, secondary for prices and history |
| Chukul (`chukul.com/api`) | Public JSON: prices, about one year of daily OHLCV (including the NEPSE index). Index endpoint needs login | **Primary** for history, fallback for prices |
| `nepseapi.surajrimal.dev` (community NEPSE API) | HTTP 522 (down) when tested | Not used |
| ShareSansar | HTML news listing | Used for headlines |
| Merolagani | HTML only, structure not stable enough to parse reliably | Not used |
| Nepal Rastra Bank | Official RSS feed | Used for notices |
| SEBON | No feed found (`/rss` returns 404) | Not covered automatically |

**Important:** ShareHub, NepaliPaisa and Chukul are **not** official NEPSE APIs. They are the endpoints those
sites' own web pages call. They are undocumented, may change without notice, and their terms of use may restrict
automated access. This project uses them for personal, non-commercial purposes at a deliberately low rate (one
request per 0.35 s per host, about 13 short runs per trading day). If a provider objects or offers a proper API,
switch to that.

## How the source layer works

`config/sources.json`:

```json
"capabilities": {
  "prices":       ["sharehub", "nepalipaisa", "chukul"],
  "indices":      ["nepalipaisa", "sharehub"],
  "history":      ["chukul", "nepalipaisa"],
  "fundamentals": ["sharehub"],
  "dividends":    ["sharehub"]
}
```

For each capability the first entry is the **primary** source, the second the **secondary**, the rest
**fallbacks**. `backend/sources.py::Registry` tries them in order, with retries and exponential backoff, and
records the outcome. Reorder the lists to change priority.

Every run writes `status.json`, which the dashboard shows under Settings → *Market data sources & health*:

| Field | Meaning |
|-------|---------|
| `capabilities.<x>.source` / `role` | Which provider actually served the data, and whether it was a fallback |
| `lastSuccess.<x>` | Last successful update per dataset |
| `reliability` | `cross-verified` (prices agree with a second provider within 1% for 95%+ of symbols), `disputed`, `unverified` or `down` |
| `freshness.state` | `fresh`, `delayed` (one session behind), `stale` (two or more) or `unavailable` |

### No fabricated prices

* If every price source fails, `prices.json` is left untouched and `status.json` records the failure. The dashboard
  then shows the **last available closing price with its date** and a red warning banner.
* The browser re-checks freshness itself, so a cached status file cannot hide stale data.
* Holdings whose symbol has no price are excluded from market value and reported separately, not estimated.
* Price-based alerts pause automatically while data is stale.
* **During market hours the feeds list only stocks that have traded so far that day.** A stock with no trade yet
  keeps its last real closing price, marked with the date it is from (the dashboard shows that date in brackets
  next to the price). No bar is added to its history for a day without a trade, and it is dropped only after
  `carryForwardDays` (45) without one.
* **While a session is open, indicators and signals use completed sessions only.** Today's bar is still forming
  (a fraction of a day's volume, a close that keeps moving), so it is left out until the market closes. The live
  price is still used for valuation, entry zones, your profit and loss, and position alerts.

## Adding a licensed or official provider

If you later obtain credentials (for example a paid ShareHub/NEPSE-vendor plan):

1. Add a class to `backend/sources.py` with the methods you can support: `prices()`, `indices()`,
   `history(symbol)`, `fundamentals(symbol)`, `dividends(symbol)`. Return the same normalised shapes as the
   existing classes.
2. Read the key from an environment variable, never from the repository:
   ```python
   key = os.environ["MY_PROVIDER_KEY"]
   ```
3. Register it in `PROVIDERS` and put its name first in the relevant lists in `config/sources.json`.
4. Add the secret in GitHub (Settings → Secrets and variables → Actions) and pass it in the `env:` block of
   `.github/workflows/pipeline.yml`.

The frontend needs no change: it only reads the generated JSON files.

## Request budget per run

| Stage | Requests |
|-------|----------|
| Prices + cross-check | 2–3 |
| Indices and summary | 3–4 |
| History | 0 on normal days (today's bar is appended from prices); 1 per new symbol |
| Fundamentals + dividends | 2 per company, at most 150 companies per run, each refreshed weekly |
| News | 3 |

## Trading calendar

`config/holidays.json` holds the weekend (Friday, Saturday), trading hours (11:00–15:00) and a `holidays` list.
NEPSE announces public holidays during the year, many on the lunar calendar, so they cannot be precomputed
reliably. Add dates as they are announced. As a safety net the pipeline also infers closures from the data itself.
