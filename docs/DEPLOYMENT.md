# Deployment guide (GitHub Pages + GitHub Actions)

Everything runs on GitHub's free tier for a **public** repository. Your portfolio is not in the repository in
readable form (see [SECURITY.md](SECURITY.md)).

What "public" means here:

* Anyone with the link can open the dashboard and see **market data**. They see an empty portfolio, because yours
  is stored in your own browser.
* The code, the Actions logs and a daily copy of the collected market data are publicly readable. The pipeline
  never writes anything built from your portfolio into those logs.
* The page asks search engines not to index it, but it is not secret.

> Private repository instead? GitHub Pages on a private repository needs a paid plan (Pro/Team), and Actions
> minutes are metered there (about 13 short runs per trading day). The steps below are otherwise identical.

## 1. Create the repository

1. Sign in to GitHub and open <https://github.com/new>.
2. Repository name: for example `nepse-portfolio`. Visibility: **Public**.
3. Leave *Add a README*, *.gitignore* and *license* **off** (this project has its own). Click **Create repository**.

## 2. Turn on GitHub Pages

In the new repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

Do this before the first push so the first run can publish the site. If you push first, the run collects data but
its last steps fail with a notice telling you to enable Pages; enable it and re-run (step 4).

## 3. Commit and push

A public repository shows the author email of every commit. To keep yours private, set GitHub's no-reply address
for this repository only (replace `<username>`):

```bash
git config user.email "<username>@users.noreply.github.com"
```

Then, in the project folder:

```bash
git add -A
git commit -m "Initial commit: NEPSE Portfolio Intelligence"
git remote add origin https://github.com/<username>/nepse-portfolio.git
git push -u origin main
```

The first push opens a GitHub sign-in window if this computer is not signed in yet.

Nothing private can be staged by accident: `.gitignore` excludes plain backups, `.env` files, generated data and
everything in `data/private/` except the encrypted file. To double-check before pushing, this should print nothing:

```bash
git ls-files | grep -i -E "portfolio-backup|\.portfolio\.json|\.env"
```

## 4. Watch the first run

The push starts two workflows (repository → **Actions**):

| Workflow | What it does | Duration |
|----------|--------------|----------|
| *Tests* | Runs the 32 Python and 7 TypeScript tests and a production build | 2–3 min |
| *Market pipeline and deploy* | Downloads prices, a year of history and fundamentals; analyses; collects news; publishes the site | 8–15 min the first time, 2–3 min afterwards |

When *Market pipeline and deploy* is green, open the site:

```
https://<username>.github.io/nepse-portfolio/
```

It opens on the Overview page with live market data. Click **Load DEMO portfolio** to try everything.

If the run is not green, open it and read the annotations at the top:

| Annotation | Meaning | Fix |
|------------|---------|-----|
| *GitHub Pages is not enabled yet* | Step 2 was skipped | Do step 2, then **Re-run all jobs** |
| *No market data yet* | Every price source refused GitHub's servers | See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) → *Sources fail on GitHub but work locally* |
| *A pipeline stage failed* | One stage raised an error | Open the *Run pipeline* step to see which; the rest still ran and was published |

Fundamentals fill in over the first few runs (150 companies per run).

## 5. Add secrets (for alerts)

Repository → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Required for | Value |
|--------|--------------|-------|
| `TELEGRAM_BOT_TOKEN` | Telegram alerts | From @BotFather — see [TELEGRAM_SETUP.md](TELEGRAM_SETUP.md) |
| `TELEGRAM_CHAT_ID` | Telegram alerts | Your numeric chat id |
| `PORTFOLIO_PASSPHRASE` | Position-aware alerts | The passphrase you type in dashboard Settings when encrypting |
| `ANTHROPIC_API_KEY` | Optional AI summary line in reports | Your own key; leave unset to stay fully rule-based |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_TO` | Optional email copies | e.g. Gmail SMTP with an app password |

Without any secrets the pipeline still collects data and publishes the dashboard; notifications are skipped.

## 6. Give the pipeline your holdings (encrypted)

Enter your transactions on the **published site** (not on a local test copy: browsers keep each address's data
separately). Then, in the dashboard: **Settings → Privacy, backup & encrypted sync**.

*Easiest:* type a passphrase (12+ characters) → **Download encrypted file** → upload the file to the repository as
`data/private/portfolio.enc.json` (GitHub → Add file → Upload files).

*One click:* create a fine-grained personal access token (GitHub → Settings → Developer settings → Fine-grained
tokens → only this repository → Repository permissions → **Contents: Read and write**), paste it and the repository
name into Settings, then **Encrypt & push to GitHub**. Repeat the push whenever you add transactions.

Set the same passphrase as the `PORTFOLIO_PASSPHRASE` secret.

## 7. Verify

* **Actions → Market pipeline and deploy → Run workflow** → command `test-telegram`. A test message should arrive;
  if it does not, the run fails and its log shows the reason (HTTP status only, never the token).
* Run `alerts`. The log shows how many alerts were found and delivered, for example
  `6 candidate(s), 2 delivered`. **It never shows their content**, because this log is public; read them in Telegram.
* Dashboard → Settings → *Market data sources & health* shows which source served each dataset.

To preview alert or report text without sending anything, run the same command on your own computer:

```bash
python -m scripts.run_pipeline alerts --dry-run
```

## Schedule

Defined in `.github/workflows/pipeline.yml` in UTC (Nepal = UTC + 5:45):

| Nepal time | Days | Job |
|-----------|------|-----|
| 10:30 | Sun–Thu | Pre-market brief: overnight announcements, levels to watch |
| 11:00–15:00, every 30 min | Sun–Thu | Prices, analysis, price alerts |
| 15:20 | Sun–Thu | Post-close update, fundamentals refresh, alerts |
| 18:00 | Daily | Evening report; weekly review on Friday; monthly review on the 1st |

Things to know about GitHub's scheduler:

* Runs can start 5–20 minutes late at busy times. The pipeline decides what to do from the real Nepal clock, so a
  late run still does the correct job.
* On a public repository GitHub **disables scheduled workflows after 60 days without repository activity**.
  The pipeline's data pushes normally count as activity; if schedules ever stop, open Actions and click
  *Enable workflow*.
* Market holidays: add announced dates to `config/holidays.json`. Even without that, a day with no new trading
  data is detected and no stale-price alerts are sent.
* The workflow declares the permissions it needs, so the repository's default *Workflow permissions* setting can
  stay as it is.

## Updating

Edit, commit and push to `main`. The workflow redeploys automatically. Your browser data is unaffected by
deployments.
