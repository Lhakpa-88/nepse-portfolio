# Troubleshooting and maintenance

## Dashboard

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| "Market data unavailable. No prices are shown." | The pipeline has not run yet, or the data files were not deployed | Actions → *Market pipeline and deploy* → Run workflow (`all`). Locally: `python -m scripts.run_pipeline all --dry-run` |
| Red or amber "Data warning" banner | Prices are one or more sessions old: a market holiday, a source outage, or schedules stopped | Check Settings → *Market data sources & health* and the latest Actions run. Add a holiday to `config/holidays.json` if the market was closed |
| My portfolio is empty on a new device or browser | Data is stored per browser | Settings → Pull & decrypt from GitHub, or restore a backup |
| A holding shows "no price" | The symbol did not trade today, is misspelt, or was delisted/merged | Correct the symbol; for a merger add an *Other adjustment* and a transaction in the new symbol |
| A transaction is marked REJECTED | For example a sale larger than the holding on that date | Correct the date or quantity; rejected rows are excluded from every figure |
| Numbers differ from my broker | Charges on the contract note differ from the schedule, or bonus cost basis differs | Enter the exact charges on that transaction; check Settings → cost-basis method and bonus cost |
| Portfolio chart starts only about a year ago | Free sources provide about one year of daily history | Expected; holdings and P/L are still complete |
| Page is blank after an update | Old cached script | Hard refresh (Ctrl+Shift+R) |

## Pipeline (GitHub Actions)

| Symptom | Fix |
|---------|-----|
| Scheduled runs stopped | GitHub disables schedules after 60 days of inactivity on public repositories: Actions → the workflow → *Enable workflow* |
| Runs start late | Normal for GitHub's scheduler. The script uses the real Nepal clock, so the right job still runs |
| `Permission denied` pushing `market-data` | The workflow requests write access itself; this appears only if an organisation policy forbids it. Settings → Actions → General → Workflow permissions → *Read and write* |
| Pages deploy fails, annotation "GitHub Pages is not enabled yet" | Settings → Pages → Source: *GitHub Actions*, then re-run the workflow |
| Sources fail on GitHub but work locally (annotation "No market data yet") | The data providers are refusing requests from GitHub's servers. Nothing is invented: the site shows "Market data unavailable". Options: wait and re-run (blocks are sometimes temporary); reorder `config/sources.json` if only one provider fails; or collect from a computer in Nepal instead (run `python -m scripts.run_pipeline all` there on a schedule and publish `frontend/public/data`) |
| The alerts log shows no alert text | Intentional: the log is public, so only counts are shown. Read alerts in Telegram, or run `python -m scripts.run_pipeline alerts --dry-run` on your own computer |
| `NOT delivered (Telegram API returned HTTP …)` and a failed run | 401 = wrong token, 400 = wrong chat id or the bot was never started. Undelivered alerts are retried on the next run |
| `prices: failed` in the log | All price sources failed. Open the three URLs in `docs/DATA_SOURCES.md` in a browser. If a site changed its JSON, update the matching class in `backend/sources.py` and reorder `config/sources.json` |
| Fundamentals coverage is low | They refresh gradually (150 companies per run). It completes within a few runs |
| "encrypted portfolio could not be decrypted" | The `PORTFOLIO_PASSPHRASE` secret does not match the passphrase used in the dashboard |
| "market-only mode" in the alerts log | No encrypted file or passphrase configured: see DEPLOYMENT.md step 6 |
| No Telegram message | Run `test-telegram`. 401 = wrong token; 400 = wrong chat id or you never pressed Start in the bot chat |
| Too many alerts | Raise thresholds or `cooldownDays`, lower `maxAlertsPerRun`, or set `notifyOpportunities` to false in `config/alerts.json` |
| An alert did not repeat | Cooldown: the same condition is silent for `cooldownDays` |

Read a run: Actions → click the run → *pipeline* job → *Run pipeline* step. Each stage prints `start`, then `ok`
or `FAILED` with a traceback.

## Local development

| Symptom | Fix |
|---------|-----|
| `python` not found on Windows | Install Python 3.12 from python.org and tick *Add python.exe to PATH* (the Microsoft Store alias is not a real install) |
| `ModuleNotFoundError: backend` | Run commands from the repository root: `python -m scripts.run_pipeline …` |
| `An Application Control policy has blocked this file` during `npm` commands | Already handled: `package.json` overrides rollup and esbuild with their WebAssembly builds, which need no native binaries |
| `cryptography` missing | `pip install cryptography` (only needed to decrypt the portfolio for alerts) |
| Port 5173 in use | `npm run dev -- --port 5174` |

## Routine maintenance

| When | Task |
|------|------|
| After every trade | Record it; re-sync the encrypted file so alerts stay correct |
| Monthly | Download a backup (Settings). Glance at Settings → data source health |
| When NEPSE announces holidays | Add the dates to `config/holidays.json` |
| Each fiscal year (mid-July) and after any SEBON/NEPSE fee decision | Compare `config/fees.json` with a recent contract note; add a new dated schedule if rates changed |
| Quarterly | Review `config/alerts.json` thresholds and your targets/stops |
| Yearly | Update frontend dependencies (`npm outdated`, `npm update`), run the tests, redeploy |
| If a data source changes | Fix its adapter in `backend/sources.py`; the tests in `tests/test_pipeline.py` cover failover behaviour |

## Recovering from data loss

* **Browser data lost**: Settings → Pull & decrypt from GitHub, or *Restore plain backup*.
* **`market-data` branch deleted**: run the workflow with `all`; history and fundamentals are re-downloaded.
* **Passphrase forgotten**: the encrypted file is unrecoverable by design. Restore a plain backup, choose a new
  passphrase, re-encrypt and update the `PORTFOLIO_PASSPHRASE` secret.

## Tests

```bash
python -m unittest discover -s tests -t . -v    # accounting, indicators, scoring, calendar, failover, crypto, alerts, news
cd frontend && npm test                         # TypeScript engine against the same hand-computed fixtures
cd frontend && npm run build                    # type-check and production build
```
