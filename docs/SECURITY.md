# Security and privacy

## What is public and what is private

| Data | Where it lives | Who can read it |
|------|----------------|-----------------|
| Market prices, indices, analysis, news | `market-data` branch and the GitHub Pages site | Anyone (it is public market data) |
| Dashboard code | `main` branch, Pages site | Anyone |
| Your transactions, watchlist, targets, cash | Your browser's localStorage | Only someone using your browser profile |
| Encrypted portfolio (`data/private/portfolio.enc.json`) | Repository, if you choose to sync | Anyone can download the file; only the passphrase holder can read it |
| Telegram token, chat id, passphrase, API keys | GitHub Actions Secrets | GitHub Actions runs only |
| GitHub token / Claude key typed into Settings | Your browser's localStorage | Only your browser; never included in backups or the encrypted file |

GitHub Pages serves only the built frontend plus public market data. The Pages build excludes the alert state
folder.

### Public by design: logs, commits and the data branch

On a public repository three more things are world-readable, and the pipeline is written around that:

* **Actions logs.** Nothing built from your portfolio is ever printed there, not even in a dry run: alerts and
  reports are replaced by counts and delivery status, and errors in the alert/report stages are reduced to the
  location and error type because an error message can contain a holding or a price. Tests enforce this
  (`tests/test_pipeline.py::PublicLogTest`). To read the actual text, use Telegram or run the command locally.
* **The alert cooldown state** (`state/alerts.json` on the `market-data` branch). It holds only keyed digests.
  The key is stretched with PBKDF2 (300,000 rounds, random per-repository salt) from the bot token (without
  Telegram: the email password, then the passphrase), so the file cannot be used to learn your holdings or to
  guess a secret cheaply. With no secret configured, no state is written for portfolio alerts at all.
* **Commit metadata.** Every commit shows its author name and email. Use GitHub's no-reply address
  (`<username>@users.noreply.github.com`) for this repository if you do not want your email published.

What an observer can still infer: that an encrypted portfolio exists, roughly how large it is, when you last
updated it, and how many alerts a run produced. Not which stocks, quantities or prices.

### Other sites on the same GitHub Pages address

All project sites of one GitHub account share the address `https://<username>.github.io`, and a browser treats
that whole address as one site. Scripts on another Pages site **of your own account** could therefore read this
dashboard's stored data in your browser, including a GitHub token or Claude key typed into Settings. This only
matters if you publish other Pages sites that load scripts you do not control. Serving this dashboard from its own
custom domain or subdomain removes the overlap.

## Access control

A static site has no server-side login. Protection therefore comes from where the data is:

* Opening the dashboard URL on another device shows **market data only** and an empty portfolio.
* To see your portfolio elsewhere you must pull the encrypted file and enter the passphrase, or restore a backup.

If you need the page itself hidden, use a private repository with a paid GitHub plan, or put the site behind an
access proxy such as Cloudflare Access.

## Encryption

* AES-256-GCM. The key is derived from your passphrase with PBKDF2-HMAC-SHA256, 600,000 iterations, random
  16-byte salt, random 12-byte nonce per encryption.
* Done in your browser with the Web Crypto API (`frontend/src/lib/crypto.ts`); decrypted in the pipeline with the
  Python `cryptography` package (`backend/secure_store.py`).
* Tampering is detected (authenticated encryption). A wrong passphrase fails cleanly.

The file is only as strong as the passphrase. On a public repository anyone can copy it and try guesses offline,
so use a long random passphrase (five or more random words). **If you forget it the file cannot be recovered** —
keep a plain backup somewhere safe and offline.

If you would rather not publish even an encrypted file, use the `PORTFOLIO_JSON` secret instead: paste a plain
backup into a GitHub secret (limit about 48 KB). The trade-off is updating the secret by hand after each trade.

## Secrets hygiene

* `.gitignore` blocks `.env*`, `portfolio-backup-*.json`, `*.portfolio.json` and everything in `data/private/`
  except the encrypted file.
* The Telegram sender never logs the request URL (it contains the token) and reports only HTTP status codes.
* The fine-grained GitHub token for one-click sync should be limited to **this repository** with **Contents:
  read and write** only. Revoke it at any time in GitHub → Settings → Developer settings.
* Rotate a leaked Telegram token with `/revoke` in @BotFather.

## Data integrity controls

| Control | Implementation |
|---------|----------------|
| Audit trail | Corrections void the original and add a superseding row; every add, correction, void, restore and import is logged with a timestamp |
| Validation | Sell cannot exceed holdings; dates cannot be in the future; BS dates rejected; rejected rows are excluded and shown |
| Duplicate prevention | Warning on manual entry, skip-by-default on import |
| Stale data | Freshness computed in the pipeline and re-checked in the browser; red banner; alerts paused |
| No fabricated prices | A failed fetch never writes a price; unpriced holdings are excluded and reported |
| Rate limits and retries | Per-host minimum interval, exponential backoff, honour Telegram `retry_after` |
| Cross-verification | Prices compared between two providers every run |
| Error logging | Each pipeline stage logs success or a traceback in the Actions run; one failed stage does not stop the others |
| Backup and recovery | Plain JSON backup, encrypted file, Excel export; the market-data branch is rebuilt from sources if lost |

## No trading access

The system has no broker or TMS credentials and no code path that places orders. Recommendations are
decision support and every trade is entered by you.

## Third parties

* Market data requests go from GitHub's servers to the data providers; they contain no personal data.
* If you add a Claude API key in Settings, free-form assistant questions send a snapshot of your holdings and
  market data to Anthropic's API from your browser. Leave the key empty to keep everything local.
* If you set `ANTHROPIC_API_KEY` as a GitHub secret, the daily report text (which includes your position
  summary) is sent to Anthropic for a three-sentence summary.
