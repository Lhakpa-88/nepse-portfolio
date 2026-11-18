# Troubleshooting and maintenance

## Dashboard

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| "Market data unavailable. No prices are shown." | The pipeline has not run yet, or the data files were not deployed | Actions → *Market pipeline and deploy* → Run workflow (`all`). Locally: `python -m scripts.run_pipeline all --dry-run` |
| Red or amber "Data warning" banner | Prices are one or more sessions old: a market holiday, a source outage, or schedules stopped | Check Settings → *Market data sources & health* and the latest Actions run. Add a holiday to `config/holidays.json` if the market was closed |
| My portfolio is empty on a new device or browser | Data is stored per browser | Settings → first card → *More* → **Load from GitHub** (type your passphrase in step 1 first), or restore a backup |
| *Download encrypted file* and *Copy as text instead* are greyed out | The passphrase in step 1 is shorter than 12 characters | Keep typing: the line under the box counts the characters still needed, and the buttons switch on at 12 |
| "Your browser did not allow automatic copying" | The browser blocked access to the clipboard | Use the text box that appears under the buttons (click in it, Ctrl+A, Ctrl+C), or use **Download encrypted file** |
| Settings says "GitHub does not have an encrypted file yet" after I uploaded | The upload was not committed, or the file is in another folder or has another name | Click **Check again**. On GitHub the file must be `data/private/portfolio.enc.json` on the `main` branch; a browser name such as `portfolio.enc (1).json` does not count |
| Settings says the file on GitHub "is not an encrypted portfolio" or "is a plain backup" | Something other than the encrypted file was put there | Create the file again (step 2) and replace it. For a plain backup, also read "If a readable file was uploaded by mistake" in SECURITY.md |
| Settings says "GitHub shows no public repository called …" | The repository name under *More* is mistyped, or the repository is private | Correct the name, or clear the box to use the one from the site address. A private repository needs the token under *More* |
| A holding shows "no price" | The symbol is misspelt, or has not traded for more than 45 days (suspended, merged or delisted) | Correct the symbol; for a merger add an *Other adjustment* and a transaction in the new symbol. A stock that simply has not traded yet today keeps its last close, shown with its date in brackets |
| A price has a date in brackets, e.g. `12,062.0 (17 Nov)` | That stock has no trade yet in the latest session | Nothing to fix: it is valued at its last real closing price until it trades |
| Signals do not move during the day although prices do | Intended: while the market is open, indicators and signals use completed sessions only | They update after the close. Stop-loss, target and support alerts still use the live price |
| A transaction is marked REJECTED | For example a sale larger than the holding on that date | Correct the date or quantity; rejected rows are excluded from every figure |
| Numbers differ from my broker | Charges on the contract note differ from the schedule, or bonus cost basis differs | Enter the exact charges on that transaction; check Settings → cost-basis method and bonus cost |
| Portfolio chart starts only about a year ago | Free sources provide about one year of daily history | Expected; holdings and P/L are still complete |
| Page is blank after an update | Old cached script | Hard refresh (Ctrl+Shift+R) |
| A box says "… could not be displayed" | A display error in that one view | Your data is not affected and the rest of the dashboard keeps working. Close the box or open another page, then reload. If it comes back, note the message shown in the box: it names the cause |

## Pipeline (GitHub Actions)

| Symptom | Fix |
|---------|-----|
| Scheduled runs stopped | GitHub disables schedules after 60 days of inactivity on public repositories: Actions → the workflow → *Enable workflow* |
| Runs start late, or a slot is skipped | Normal for GitHub's scheduler on free accounts (on the first day one run started 26 minutes late and one slot never ran). The script uses the real Nepal clock, and each report is sent once per day by whichever run gets there first, with a spare trigger for the morning and evening reports |
| `Permission denied` pushing `market-data` | The workflow requests write access itself; this appears only if an organisation policy forbids it. Settings → Actions → General → Workflow permissions → *Read and write* |
| Pages deploy fails, annotation "GitHub Pages is not enabled yet" | Settings → Pages → Source: *GitHub Actions*, then re-run the workflow |
| Sources fail on GitHub but work locally (annotation "No market data yet") | The data providers are refusing requests from GitHub's servers. Nothing is invented: the site shows "Market data unavailable". Options: wait and re-run (blocks are sometimes temporary); reorder `config/sources.json` if only one provider fails; or collect from a computer in Nepal instead (run `python -m scripts.run_pipeline all` there on a schedule and publish `frontend/public/data`) |
| The alerts log shows no alert text | Intentional: the log is public, so only counts are shown. Read alerts in Telegram, or run `python -m scripts.run_pipeline alerts --dry-run` on your own computer |
| `NOT delivered (Telegram API returned HTTP …)` and a failed run | 401 = wrong token, 400 = wrong chat id or the bot was never started. Undelivered alerts are retried on the next run |
| `test-telegram` succeeds but nothing arrives on my phone | The message was accepted by Telegram, so the app is not receiving. Telegram is blocked by internet providers in Nepal: if the app does not connect on your network, use email (`SMTP_USER`, `SMTP_PASSWORD`, then `test-email`) |
| `test-email` fails with "the email login was rejected" | Gmail needs a 16-character app password (2-Step Verification must be on), not the normal password; `SMTP_USER` must be the full address |
| `git push` is refused with "Permission … denied to <another account>" | This computer is signed in to GitHub as a different account. Name the right one in the remote and keep its sign-in separate: `git remote set-url origin https://<username>@github.com/<username>/nepse-portfolio.git` then `git config credential.useHttpPath true`, and push again |
| `prices: failed` in the log | All price sources failed. Open the three URLs in `docs/DATA_SOURCES.md` in a browser. If a site changed its JSON, update the matching class in `backend/sources.py` and reorder `config/sources.json` |
| Fundamentals coverage is low | They refresh gradually (150 companies per run). It completes within a few runs |
| "encrypted portfolio could not be decrypted" | The `PORTFOLIO_PASSPHRASE` secret does not match the passphrase used in the dashboard |
| A failed run with "The file in data/private is not encrypted" | The file there is not the one the dashboard makes. Create it again (Settings → first card) and replace it. If it was a plain backup or a list of holdings, it has been readable by anyone: follow "If a readable file was uploaded by mistake" in SECURITY.md |
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

* **Browser data lost**: Settings → first card → *More* → **Load from GitHub**, or **Restore plain backup…**.
* **`market-data` branch deleted**: run the workflow with `all`; history and fundamentals are re-downloaded.
* **Passphrase forgotten**: the encrypted file is unrecoverable by design. Restore a plain backup, choose a new
  passphrase, re-encrypt and update the `PORTFOLIO_PASSPHRASE` secret.

## Tests

```bash
python -m unittest discover -s tests -t . -v    # accounting, indicators, scoring, calendar, failover, crypto, alerts, news, schedule
cd frontend && npm test                         # engine vs hand-computed fixtures, encryption, every page and view rendered
cd frontend && npm run build                    # type-check and production build
```

The dashboard tests render every page and the stock detail view with a real sample of the published data
(`tests/fixtures/site_data`). Refresh that sample after changing the data format:
`python -m scripts.make_test_sample` (run it during a trading session so it includes a stock with no trade yet).
