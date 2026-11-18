# Calculations

Every figure in the dashboard is derived from your transaction ledger and market prices by the accounting
engine. There are two implementations — `frontend/src/lib/engine.ts` (dashboard) and `backend/portfolio.py`
(alerts and reports) — and both must reproduce the hand-worked examples below to within Rs 0.01
(`tests/fixtures/portfolio_cases.json`).

## Charges and tax (config/fees.json)

The schedule whose `effectiveFrom` is the latest date on or before the transaction date applies, so old trades
keep the rates that were in force when they happened.

| Item | Current schedule (from 2021-07-16) |
|------|-----------------------------------|
| Broker commission | 0.36% up to Rs 50,000 · 0.33% to Rs 5,00,000 · 0.31% to Rs 20,00,000 · 0.27% to Rs 1,00,00,000 · 0.24% above. The rate of the slab the **whole** amount falls in applies. Minimum Rs 10 |
| SEBON fee | 0.015% of the transaction amount |
| DP charge | Rs 25 per transaction |
| Capital gains tax (individual) | 7.5% if held 365 days or less, 5% if held longer |
| Dividend tax | 5% withheld |

> Verify these against your broker's contract note. Rates change through SEBON/NEPSE decisions and the annual
> Finance Act. To record a change, add a new schedule block with its effective date (Settings, or
> `config/fees.json`); do not edit past blocks. You can also override the charges on any single transaction.

## Formulas

**Buy** (secondary market)

```
amount   = quantity × price
cost     = amount + commission(amount) + SEBON(amount) + DP charge + other
```

IPO and right shares: `cost = quantity × price` (no brokerage). Buy charges are part of cost, so they are never
subtracted again later.

**Weighted average cost (default)**

```
average cost = total cost of shares held ÷ shares held
```

**Bonus shares** add shares at the configured cost (default Rs 0), which lowers the average cost. A separate *tax
cost* of Rs 100 per bonus share is tracked for capital-gains purposes.

**Sell**

```
gross            = quantity × price
cost removed     = quantity × average cost            (WACC)   or the oldest lots' cost (FIFO)
taxable gain     = gross − commission − SEBON − tax cost removed
CGT              = Σ over lots sold [ lot gain × rate for that lot's holding period ]   (never below 0)
net proceeds     = gross − commission − SEBON − DP charge − CGT
realized P/L     = net proceeds − other charges − cost removed
```

The holding period is always measured on a first-in-first-out basis, so a sale can be part short-term and part
long-term. The DP charge reduces your proceeds but is not deducted before tax.

**Cash dividend**: `net = shares × dividend per share × (1 − 5%)`. Dividends never change the cost basis.

**Portfolio**

```
market value     = Σ shares × last traded price
unrealized P/L   = market value − cost of shares held
net return       = realized P/L + unrealized P/L + net dividends
net return %     = net return ÷ total money ever put into purchases
```

Charges appear once, inside cost (buys) or realized P/L (sells). The "Charges paid" tile is informational and is
not subtracted again. A test asserts that net return equals cash received plus current value minus cash paid.

**Break-even selling price**: the price at which net profit after all selling charges and CGT is zero, found
numerically.

**Time-weighted return** (vs NEPSE): daily returns are chained with money added treated as arriving before the
day's move and money withdrawn as leaving after it, so deposits and withdrawals do not distort performance.

## Worked example A — two buys, partial sale, bonus, dividend (WACC)

| Step | Working | Result |
|------|---------|--------|
| Buy 100 @ 500 on 2024-01-10 | 50,000 + 180.00 (0.36%) + 7.50 + 25 | cost 50,212.50 |
| Buy 50 @ 560 on 2024-03-10 | 28,000 + 100.80 + 4.20 + 25 | cost 28,130.00 |
| Position | 150 shares, 78,342.50 | average 522.2833 |
| Sell 60 @ 600 on 2024-06-10 | gross 36,000; commission 129.60; SEBON 5.40; DP 25 | |
| | cost removed 60 × 522.2833 | 31,337.00 |
| | taxable gain 36,000 − 129.60 − 5.40 − 31,337 | 4,528.00 |
| | CGT 7.5% (held under 365 days) | 339.60 |
| | realized 36,000 − 129.60 − 5.40 − 25 − 339.60 − 31,337 | **4,163.40** |
| Remaining | 90 shares | cost 47,005.50 |
| Bonus 9 shares on 2024-09-01 | 99 shares, cost unchanged | average **474.80** |
| Dividend Rs 5 × 90 | 450 − 22.50 tax | **427.50** net |
| Valued at 550 | 99 × 550 = 54,450 | unrealized **7,444.50** |
| Net return | 4,163.40 + 7,444.50 + 427.50 | **12,035.40** |

Cross-check: cash out 78,342.50; cash in 35,500.40 (sale) + 427.50 (dividend); value 54,450 →
35,500.40 + 427.50 + 54,450 − 78,342.50 = 12,035.40 ✓

## Worked example B — FIFO across a long-term and a short-term lot

Buy 100 @ 200 on 2023-01-01 (cost 20,100.00). Buy 100 @ 300 on 2024-06-01 (cost 30,137.50).
Sell 150 @ 400 on 2024-07-01: gross 60,000; commission 198.00 (0.33%); SEBON 9.00; DP 25.

| Lot | Shares | Days held | Net sale value | Cost | Gain | Rate | CGT |
|-----|--------|-----------|----------------|------|------|------|-----|
| 2023-01-01 | 100 | 547 | 39,862.00 | 20,100.00 | 19,762.00 | 5% | 988.10 |
| 2024-06-01 | 50 | 30 | 19,931.00 | 15,068.75 | 4,862.25 | 7.5% | 364.67 |

CGT 1,352.77 · realized 60,000 − 198 − 9 − 25 − 1,352.77 − 35,168.75 = **23,246.48** · 50 shares remain at 301.375.

## Worked example C — the same trades under WACC

Average cost 251.1875 → cost removed 37,678.13 → taxable gain 22,114.88 → blended rate
(100 × 5% + 50 × 7.5%) ÷ 150 = 5.8333% → CGT **1,290.03** → realized **20,799.85**.

## Worked example D — IPO, right shares and a loss

IPO 10 @ 100 and right 10 @ 100 (no charges) → cost 2,000. Sell 20 @ 90: gross 1,800; commission is the Rs 10
minimum (0.36% would be 6.48); SEBON 0.27; DP 25; no CGT on a loss → realized **−235.27**. A later sale of 5 more
shares is **rejected** (nothing left to sell) and a voided entry is ignored.

## Running the checks yourself

```bash
python -m unittest tests.test_portfolio -v
cd frontend && npm test
```
