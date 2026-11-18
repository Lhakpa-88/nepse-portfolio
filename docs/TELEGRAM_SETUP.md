# Telegram notifications

Alerts are sent by the GitHub Actions pipeline. The bot token lives only in GitHub Secrets; it is never in the
dashboard, the repository or the Pages site.

## 1. Create your bot

1. In Telegram, open a chat with **@BotFather** (the verified one with the blue tick).
2. Send `/newbot`, choose a display name and a username ending in `bot`.
3. BotFather replies with a token that looks like `1234567890:AA…`. Treat it like a password.

## 2. Get your chat id

1. Open a chat with your new bot and press **Start** (a bot cannot message you until you do).
2. Send any message, for example `hello`.
3. In a browser open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
4. Find `"chat":{"id":123456789` — that number is your chat id. (For a group it is negative.)

## 3. Add the secrets

GitHub repository → **Settings → Secrets and variables → Actions → New repository secret**:

* `TELEGRAM_BOT_TOKEN` — the token from step 1
* `TELEGRAM_CHAT_ID` — the number from step 2

## 4. Test

**Actions → Market pipeline and deploy → Run workflow** → command `test-telegram`. You should receive:

> NEPSE Portfolio Intelligence: test message. Your Telegram notifications are working.

If the job fails, the log shows the HTTP status only (the token is never printed). 401 = wrong token,
400 = wrong chat id or you have not pressed Start in the bot chat.

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
| Reports | Pre-market brief, daily report, Friday weekly review, monthly review |

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

Alerts pause automatically when market data is stale, so you are never told to act on old prices.

## Position-aware alerts need your holdings

Without the encrypted portfolio the pipeline runs in *market-only* mode: news and opportunity alerts work, but it
cannot know your cost, weights, targets or stops. See step 6 of [DEPLOYMENT.md](DEPLOYMENT.md).

## Optional email copies

Set `SMTP_HOST`, `SMTP_PORT` (465), `SMTP_USER`, `SMTP_PASSWORD` and `EMAIL_TO` secrets. Stop-loss alerts,
critical news and the weekly/monthly reports are then also emailed. With Gmail, create an *app password*; your
normal password will not work.
