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
| *Tests* | Runs the 57 Python tests and the 48 dashboard tests (calculations, encryption, and every page and view rendered with sample data), then a production build | 2–3 min |
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
| `TELEGRAM_BOT_TOKEN` | Telegram alerts | From @BotFather |
| `TELEGRAM_CHAT_ID` | Telegram alerts | Your numeric chat id (the bot tells you: run `test-telegram` once with only the token set) |
| `SMTP_USER`, `SMTP_PASSWORD` | Email alerts, instead of or as well as Telegram | Your address and an app password. Gmail needs nothing else; other providers also need `SMTP_HOST` |
| `PORTFOLIO_PASSPHRASE` | Position-aware alerts | The passphrase you type in dashboard Settings when encrypting |
| `ANTHROPIC_API_KEY` | Optional AI summary line in reports | Your own key; leave unset to stay fully rule-based |

Step-by-step instructions for both channels, and which to choose, are in [TELEGRAM_SETUP.md](TELEGRAM_SETUP.md).
Telegram is blocked by internet providers in Nepal, so check that the app works for you before relying on it.

Without any secrets the pipeline still collects data and publishes the dashboard; notifications are skipped.

## 6. Give the pipeline your holdings (encrypted)

Your transactions stay in your browser. For position-aware alerts the pipeline needs a copy, which you give it
**encrypted**; only you know the passphrase.

1. **Enter your transactions on the published site** (not on a local test copy: browsers keep each address's
   data separately). Check that the Holdings tab matches your actual share balances.
2. **Choose a passphrase** of 12 or more characters (five random words work well) and write it down somewhere
   safe. If you lose it, the encrypted file cannot be recovered.
3. **Save the passphrase in GitHub first**: add the secret `PORTFOLIO_PASSPHRASE`. Doing this before the upload
   means the very first run can read the file.
4. **Create the encrypted file**: dashboard → Settings → *Privacy, backup & encrypted sync* → type the same
   passphrase → **Download encrypted file**. The file must be named exactly `portfolio.enc.json` (if the browser
   saved it as `portfolio.enc (1).json`, rename it).
5. **Upload it** to the folder `data/private/` of the repository: open
   `https://github.com/<username>/nepse-portfolio/upload/main/data/private`, drop the file in, and click
   **Commit changes**. This starts a pipeline run.
6. **Check the run page** (Actions tab). It shows *"Your portfolio was loaded"*; if the passphrase does not match
   it shows *"Your portfolio was NOT loaded"* with the reason.

For immediate proof, run the workflow with the command `report daily`: the report that arrives lists your holdings.

Repeat steps 4 and 5 whenever you add transactions or change a target or stop price.

*One-click alternative to steps 4 and 5:* create a fine-grained personal access token (GitHub → Settings →
Developer settings → Fine-grained tokens → only this repository → Repository permissions → **Contents: Read and
write**), paste it and the repository name into Settings, then use **Encrypt & push to GitHub**.

## 7. Verify

* **Actions → Market pipeline and deploy → Run workflow** → command `test-telegram` or `test-email`. A test
  message should arrive and the run page says so; if it does not, the run fails and the reason is shown at the top
  of the run page (never the token, password, chat id or address).
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
| 09:55 and 10:30 | Sun–Thu | Morning brief: overnight announcements, levels to watch. Sent once, by whichever run starts first |
| 11:00–15:00, every 30 min | Sun–Thu | Prices, position alerts. (Signals use completed sessions and update after the close) |
| 15:00 and 15:20 | Sun–Thu | Post-close update, fundamentals refresh, signals, alerts |
| 18:00 and 19:35 | Daily | Evening report, sent once; weekly review on Friday; monthly review on the 1st |

Things to know about GitHub's scheduler:

* Runs start late (commonly 10–30 minutes) and GitHub sometimes skips a slot. The pipeline decides what to do from
  the real Nepal clock, and each report is tied to the day rather than to one trigger: if both morning triggers
  are late, the first run after the open still sends the brief, and nothing is sent twice.
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
