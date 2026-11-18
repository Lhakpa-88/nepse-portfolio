# User guide

## Adding a transaction

**My Portfolio → + Add transaction.**

| Field | What to enter |
|-------|---------------|
| Date | The trade date in **AD** (the form has a date picker). Not Bikram Sambat |
| Type | See the table below |
| Symbol | NEPSE symbol, e.g. `NABIL`. The form shows the company name and last price to confirm |
| Quantity | Number of shares |
| Price | Price per share in rupees |
| Commission, SEBON fee, DP charge, CGT, other | **Leave blank** to calculate automatically from the fee schedule in force on that date. Fill in only to override with the exact figures on your broker's contract note |
| Broker, Notes | Optional |

| Type | Use for | Quantity / Price |
|------|---------|------------------|
| Buy | Secondary-market purchase | Shares / price paid |
| Sell | Sale (partial sales are fine) | Shares sold / price received |
| IPO / FPO / Auction | Shares allotted in a primary issue | Shares / issue price (usually 100). No brokerage |
| Right share | Rights you subscribed to | Shares / issue price (usually 100). No brokerage |
| Bonus share | Bonus shares credited | Shares received / 0 |
| Cash dividend | Dividend paid to your bank | Shares it was paid on / **rupees per share** (10% on Rs 100 par = 10). 5% tax is applied automatically |
| Other adjustment | Mergers, corrections | Positive or negative shares / cost per share added |

The form refuses a sale larger than your holding, a future date, and warns before saving an exact duplicate.

## Correcting a transaction

**My Portfolio → Transactions → Correct.** Change the fields and save.

The original is not overwritten. It is marked *void* and a new version takes its place, linked to the original.
Both stay visible (tick *Show voided*) and the change is written to the **Audit trail** tab with a timestamp.

## Removing a transaction

**Transactions → Void.** You are asked for a reason. The row stops affecting any figure but remains in the ledger
and the audit trail. **Restore** brings it back. There is deliberately no hard delete for single rows; to wipe
everything use Settings → Data → *Erase all data in this browser*.

## Importing from Excel or CSV

1. **My Portfolio → Import Excel / CSV → Download template (.xlsx)** (a CSV version is in
   `data/templates/transactions_template.csv`).
2. Fill one row per transaction. Delete the DEMO example row.
3. **Choose file…** The preview shows every row as *OK*, *Duplicate* or with its error. Nothing is imported until
   you press **Import**.

Rules the importer enforces:

* Dates: `YYYY-MM-DD` or real Excel date cells. Ambiguous dates such as `03/04/2025` are rejected rather than
  guessed. Bikram Sambat years are detected and rejected with a message.
* Type must be Buy, Sell, IPO, Right, Bonus, Dividend or Adjust.
* Quantity and price must be numbers; charge columns may be blank.
* Duplicates (same date, symbol, type, quantity and price as an existing or earlier row) are skipped by default.
* A symbol that is not in today's price list imports with a warning (it may be delisted or merged).

Files are read in your browser. Nothing is uploaded anywhere.

> MeroShare's transaction history export has no prices, so it cannot be imported directly. Use your broker's
> trade history or contract notes for prices.

## Targets, stop-losses and your thesis

On the Holdings tab, type a **target** and **stop** price next to any stock. They drive the "target reached" and
"stop-loss breached" signals in the dashboard and in your alerts (after you send the encrypted file again, see
below).

## Exporting and reports

* **Export Excel** — holdings, summary and the full ledger in one workbook.
* **Print / PDF report** — prints the current page; choose "Save as PDF".
* Buy/Sell Analysis and Screener each have **Export CSV**.
* Settings → first card → *More* → **Download plain backup** saves everything as a readable JSON file. Keep it
  somewhere private and never put it on GitHub.

**Back up regularly.** Your data lives in this browser's storage. Clearing site data, a private window or a new
device starts empty until you restore a backup or load the encrypted file (Settings → first card → *More* →
**Load from GitHub**, with your passphrase).

## Sending your holdings to the alert pipeline

Alerts and reports about *your* positions are produced on GitHub, which cannot see your browser. You give it an
encrypted copy. The first card on the **Settings** page does this in three steps:

1. **Type your passphrase** — the one saved in GitHub as the secret `PORTFOLIO_PASSPHRASE` (12 characters or
   more). The card shows how many characters are still needed.
2. **Create the encrypted file** — **Download encrypted file**, or **Copy as text instead**. The result appears
   right under the buttons.
3. **Put it in your GitHub repository** — **Open the upload page** and drop the file in, or **Open GitHub to
   paste**; then commit. The line underneath says whether GitHub has the file and when it was created.

Do this again after adding or correcting transactions or changing a target or stop: the card reminds you when this
browser has changed since the file on GitHub was made. The first-time setup, including the passphrase secret, is in
[DEPLOYMENT.md](DEPLOYMENT.md#6-give-the-pipeline-your-holdings-encrypted).

## A two-minute daily routine

1. Read the evening report (email or Telegram). If nothing "needs attention", you are done.
2. Otherwise open the dashboard → **Overview → Needs your attention** → click the stock for the evidence.
3. If you are considering a trade, open **Buy/Sell Analysis → Selling / Buying calculator** to see the result
   after brokerage, SEBON fee, DP charge and capital-gains tax, including the break-even price.
4. Record any trade you make the same day so the figures stay correct, then send the encrypted file again
   (Settings, first card).

Weekly: read the Friday review. Monthly: open **Risk Analysis** and act on the diversification suggestions.

## Reading a recommendation

| Signal | Meaning |
|--------|---------|
| BUY | Strong on quality, fundamentals and trend, and not high risk |
| ACCUMULATE | Good quality; add gradually, preferably in the entry zone |
| HOLD | Keep; not compelling enough to add |
| REDUCE | Evidence weakening, or a target was hit; trim |
| SELL | Evidence no longer supports holding |
| WATCH | Data is incomplete, or fundamentals are fine but the trend is still down. No firm view |

Every recommendation shows its supporting evidence, the downside level, the horizon, what would invalidate it, a
confidence score and the time of analysis. A stock marked *incomplete* is missing fundamentals or price history;
treat its signal with extra caution. The **Trading** score is separate and purely technical: a high trading score
does not make a stock a long-term investment.
