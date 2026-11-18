# Recommendation methodology

The model is rule-based and deterministic: the same data always gives the same answer, and every score can be
opened in the dashboard to see its components. No language model decides a recommendation.

Code: `analytics/technicals.py`, `analytics/scoring.py`, `analytics/build.py`, `frontend/src/lib/recommend.ts`.

## Three separate scores

| Score | Question it answers | Built from |
|-------|--------------------|-----------|
| **Investment quality** (0–100) | Is this a sound company at a reasonable price in a supportive market? | Weighted areas below |
| **Short-term trading** (0–100) | Is there a price/volume setup right now? | Technical 45%, 1-week momentum 20%, volume surge 20%, liquidity 15% |
| **Risk** (0–100, higher = riskier) | How badly can this hurt me? | Volatility 30%, illiquidity 25%, drawdown 15%, financial risk 30% |

They are never merged into one number. A bullish chart raises the trading score, not the long-term view.

## Investment quality weights (configurable)

| Area | Default | Components (each 0–100) |
|------|--------:|-------------------------|
| Fundamental | 35% | EPS level · ROE · EPS growth vs same quarter last year · ROE rank among sector peers · book value · dividend record · for banks and finance: NPL and capital adequacy |
| Technical | 25% | Trend (price vs 20/50/200-day averages, 50 vs 200) · RSI(14) · MACD · 1-month momentum · volume confirmation · breakout/breakdown |
| Valuation | 15% | P/E against sector median and in absolute terms · P/B likewise · cash dividend yield |
| Market & sector | 15% | NEPSE trend (index vs its averages, momentum, breadth) · sector 1-month momentum · sector today |
| Risk | 10% | 100 − risk score |

Change the weights in the dashboard (Settings → Recommendation weights; applies instantly in the browser) or in
`config/scoring.json` (used by the automated pipeline).

**Missing data is excluded, not zero-filled.** The score is the weighted average of the areas that have data, and
the missing weight lowers confidence instead.

## From score to signal

| Signal | Rule |
|--------|------|
| BUY | quality ≥ 70 **and** fundamental ≥ 60 **and** technical outlook not Bearish **and** risk not High |
| ACCUMULATE | quality ≥ 60 **and** fundamental ≥ 50 **and** risk not High (if the trend is Bearish → WATCH: sound but wait) |
| HOLD | quality ≥ 45 |
| REDUCE | quality ≥ 35 |
| SELL | quality < 35 |
| WATCH | no fundamentals available, or the wait-for-trend case above |

Consequences worth noting:

* A stock with **no reported fundamentals can never be BUY or ACCUMULATE**, however good its chart (covered by a test).
* A falling price alone never produces a buy: "Undervalued" requires positive earnings and a fundamental score of 50+.

## Adjustments for your own position

For stocks you hold, the dashboard and the alert engine then apply:

| Condition | Effect |
|-----------|--------|
| Price at or below your stop | SELL, flagged critical |
| Price at or above your target | Capped at REDUCE (book partial profits) |
| Price below 60-day support | BUY/ACCUMULATE capped at HOLD |
| P/E above 40 and far above sector | Capped at HOLD |
| Position above your maximum weight | Capped at HOLD; suggests trimming |
| Down 15% or more from cost | Flag: re-check the thesis |
| EPS negative or down 25%+ year on year | Flag: fundamentals deteriorating |
| Volume 3× the 20-day average | Flag: abnormal activity |
| REDUCE/SELL | Lists higher-ranked alternatives you do not own |

The suggested action always states what selling would net after brokerage, SEBON fee, DP charge and CGT.

## Confidence (0–100)

```
confidence = 100 × (weight of areas with data ÷ total weight)
                 × (0.5 + 0.5 × average coverage of fundamental, technical and valuation components)
           × 0.70 if the stock has not traded for two or more sessions
           × 0.85 if fundamentals were last refreshed more than 45 days ago
```

Position advice multiplies confidence by 0.6 when the analysis is flagged incomplete. Every data gap is listed
in words next to the score.

## Reference price levels

| Level | Definition |
|-------|-----------|
| Entry zone | From 60-day support (or 5% below) up to the lower of the price and the 20-day average |
| Upside reference | Nearest 60-day resistance, else the 52-week high, if at least 3% above the price |
| Downside reference | 60-day support |
| Stop-loss reference | Downside reference − 2% |

These are levels taken from past prices, not forecasts.

## Screens (Investment Opportunities)

| Screen | Rule |
|--------|------|
| Fundamentally strong | fundamental ≥ 68, at least 60% of components present, risk not High |
| Undervalued | valuation ≥ 65, EPS > 0, fundamental ≥ 50 |
| Dividend-paying | cash yield ≥ 3% and cash dividends in at least 2 of the last 3 years |
| Growth potential | EPS growth ≥ 15% year on year, ROE ≥ 10%, EPS > 0 |
| Technical breakout | close above the prior 20-day high on ≥ 1.5× volume, adequately liquid |
| Short-term trading | trading score ≥ 68, adequately liquid |
| Unusual volume | volume ≥ 2.5× the 20-day average |
| Approaching entry | quality ≥ 58, fundamental ≥ 55, trend not Bearish, price inside the entry zone |
| High risk — avoid | risk level High, or negative EPS, or quality < 35 |

**Top 10** = quality × confidence ÷ 100, among stocks with fundamentals, fundamental ≥ 55, risk not High and a
BUY or ACCUMULATE signal. If fewer than ten qualify, fewer are shown.

Mutual funds and debentures are priced but excluded from scoring.

## During market hours

* **Signals are end-of-day.** While a session is open, today's bar is incomplete (a fraction of a day's volume
  and a close that keeps moving), so indicators, scores, signals and screens use completed sessions only. This
  keeps recommendations from flipping during the day for reasons that are artefacts. They update after the close.
* **Prices are live.** The latest price is still used for P/E and P/B, the entry-zone check, your profit and loss,
  and the stop-loss, target and support alerts.
* **A stock with no trade yet today** is shown at its last real closing price with that date. It stays in the
  analysis with a note, but is left out of the three short-term screens (breakout, trading, unusual volume).
  Confidence is reduced only when a stock has gone two or more sessions without a trade.

## Known limitations

* About one year of price history, so "52-week" figures and the 200-day average are near their minimum sample,
  and long-run valuation history is not available.
* Fundamentals are the latest reported quarter as published by the source, with annualised EPS. They can lag a
  new report by up to a week and may contain source errors: check the company's own report before a large decision.
* Governance, promoter behaviour, litigation and management quality are not measured. News triage reads headlines only.
* Thinly traded stocks can gap through support and stop levels.
* Past relationships (beta, correlation) can break down exactly when markets fall.
