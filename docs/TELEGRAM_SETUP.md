# Notifications: Telegram and email

Alerts and reports are sent by the GitHub Actions pipeline, from GitHub's servers. Tokens and passwords live only
in GitHub Secrets; they are never in the dashboard, the repository or the Pages site, and the pipeline never
prints them, your chat id or your address in its (public) log.

## Which channel?

| | Telegram | Email |
|---|----------|-------|
| Best for | Instant push notifications on your phone | Reliability; works on any connection |
| Needs | The Telegram app working where you are | A mailbox that allows app passwords (Gmail does) |
| Secrets | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | `SMTP_USER`, `SMTP_PASSWORD` |

**In Nepal, check Telegram first.** Nepali internet providers were instructed by the telecom regulator to block
Telegram in July 2025. Where that block applies, the pipeline can still *send* (it runs outside Nepal) but your
Telegram app will not *receive*. If Telegram does not open on your phone, use email.

How the two combine:

* **Only Telegram set up** – everything goes to Telegram.
* **Only email set up** – everything goes to email.
* **Both set up** – everything goes to Telegram, and the urgent items (stop-loss alerts, critical news, weekly
  and monthly reports) are also emailed.

Add secrets at: repository → **Settings → Secrets and variables → Actions → New repository secret**.
Run commands at: repository → **Actions → Market pipeline and deploy → Run workflow**.

## Telegram

### 1. Create your bot

1. In Telegram, open a chat with **@BotFather** (the verified one with the blue tick).
2. Send `/newbot`, choose a display name, then a username ending in `bot`.
3. BotFather replies with a token that looks like `1234567890:AA…`. Treat it like a password.

### 2. Save the token

Add the secret `TELEGRAM_BOT_TOKEN` with the token as its value.

### 3. Let the bot tell you your chat id

1. Open your new bot's chat in Telegram and press **Start** (a bot cannot message you until you do).
2. Run the workflow with the command **`test-telegram`**.
3. Within a couple of minutes the bot sends you a message containing **your chat ID**.

The run page shows *"Check Telegram - your bot has sent you your chat ID"*. If instead it says *"The bot could
not reach you yet"*, press Start in the bot chat and run it again.

### 4. Save the chat id and test

1. Add the secret `TELEGRAM_CHAT_ID` with that number as its value.
2. Run **`test-telegram`** again. You should receive:

> NEPSE Portfolio Intelligence: test message. Your Telegram notifications are working.

The run page then shows *"Telegram is working"*. If it fails, the reason is at the top of the run page:

| Message | Meaning |
|---------|---------|
| *the bot token was rejected* (HTTP 401) | The token is wrong or was revoked: copy it again from @BotFather |
| *check TELEGRAM_CHAT_ID…* (HTTP 400) | The chat id is wrong, or you have not pressed Start in the bot chat |
| *the bot is not allowed to message you yet* (HTTP 403) | You blocked the bot or never started it |
| *does not look like a bot token* | Something other than the token was pasted (it is digits, a colon, then about 35 characters) |

A stray space or line break around a pasted value is ignored.

<details>
<summary>Finding the chat id by hand instead</summary>

Send your bot a message, then open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser and look for
`"chat":{"id":123456789`. That number is your chat id (a group's id is negative). This puts the token in your
browser history, which is why the bot-assisted way above is preferred.
</details>

## Email

Works with any SMTP mailbox. Gmail needs only two secrets.

### Gmail

1. Turn on **2-Step Verification** for the Google account (Google Account → Security).
2. Create an **app password**: <https://myaccount.google.com/apppasswords> → give it a name such as
   `nepse-portfolio` → Google shows a 16-character password. This is not your normal password, and it can be
   revoked at any time without affecting your account.
3. Add two secrets:
   * `SMTP_USER` – your full Gmail address
   * `SMTP_PASSWORD` – the 16-character app password (spaces are fine)
4. Run the workflow with the command **`test-email`**. The run page shows *"Email is working"* and the message
   arrives in your inbox (check spam the first time).

Alerts are sent from your own address to your own address. To deliver them elsewhere add the secret `EMAIL_TO`.

### Other providers

Also add `SMTP_HOST` (for example `smtp.mail.yahoo.com`) and, if the provider uses STARTTLS, `SMTP_PORT` = `587`
(the default is 465, SSL). Many providers require an app password rather than the account password.

## What you will receive

| Notification | When |
|--------------|------|
| Stop-loss triggered | Price at or below the stop you set for a holding |
| Target price achieved | Price at or above your target |
| Support breach | Close below 60-day support (with a 1% buffer) |
| Sell / reduce signal | The model signal for a holding turns to REDUCE or SELL |
| Major position loss | A holding is down more than 15% from your cost |
| Significant price move | A holding moves more than 5% in a day |
| Portfolio loss | The whole portfolio falls more than 3% in a day |
| Concentration | One stock exceeds your maximum weight |
| Watchlist in range | A watched stock enters your buy range |
| Buy opportunity | A top-3 ranked stock is inside its entry zone (can be turned off) |
| Critical / holding news | Monetary policy, tax changes, suspensions, or High-impact news naming a stock you hold |
| Reports | Morning brief, daily report, Friday weekly review, monthly review |

Example:

```
NEPSE PORTFOLIO ALERT

Stock: NABIL

Current Price: NPR 549.0
Your Average Cost: NPR 484.68
Unrealized Return: +13.3%

Signal: REDUCE

Reason:
TARGET PRICE ACHIEVED. Target 545.0 reached; 40% of portfolio (limit 30%).

Suggested Action:
Consider booking partial profits / trimming; keep a stop near Rs 508.

Risk: Low

Review: Next trading session

Data updated: 2026-11-17T14:59:59 NPT (fresh)
```

## Controlling the volume

`config/alerts.json`:

| Setting | Default | Effect |
|---------|---------|--------|
| `dayMovePct` | 5 | Daily move that counts as significant |
| `positionLossPct` | 15 | Loss from cost that triggers a review alert |
| `portfolioDayLossPct` | 3 | Whole-portfolio daily fall |
| `concentrationPct` | 30 | Used when the dashboard setting is not synced |
| `supportBreachBufferPct` | 1 | How far below support counts as a breach |
| `cooldownDays` | 3 | The same condition is not repeated within this many days |
| `maxAlertsPerRun` | 8 | Hard cap per run; the most urgent are sent first |
| `notifyOpportunities` | true | Set false to stop buy-opportunity alerts |
| `minOpportunityScore` | 72 | Minimum quality score for an opportunity alert |

Per-stock **target** and **stop** prices are set in the dashboard (My Portfolio → Target / Stop columns) and travel
inside the encrypted portfolio file, so re-sync after changing them.

Alerts pause automatically when market data is stale, so you are never told to act on old prices. An alert that
fails to send is not marked as sent: it is retried on the next run, and the run is shown as failed.

## Position-aware alerts need your holdings

Without the encrypted portfolio the pipeline runs in *market-only* mode: news and opportunity alerts work, but it
cannot know your cost, weights, targets or stops. See step 6 of [DEPLOYMENT.md](DEPLOYMENT.md).

## If a token or password leaks

* Telegram: send `/revoke` to @BotFather, then update `TELEGRAM_BOT_TOKEN`.
* Gmail: delete the app password at <https://myaccount.google.com/apppasswords>, create a new one and update
  `SMTP_PASSWORD`.
