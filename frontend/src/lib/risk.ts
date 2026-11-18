/** Portfolio risk & performance analytics. All inputs are real prices; gaps are reported, not filled with guesses. */
import type { HistRow } from './data';
import { positionsOverTime, type EngineOptions, type Fees, type Holding, type Txn } from './engine';

export const TRADING_DAYS = 230;

export interface SeriesPoint { date: string; value: number; cost: number; invested: number; pnl: number; twr: number; nepse: number | null; unpriced: number }

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export function stdev(xs: number[]) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
export function correlation(a: number[], b: number[]) {
  const n = Math.min(a.length, b.length);
  if (n < 20) return null;
  const x = a.slice(-n), y = b.slice(-n), mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i += 1) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}
export function maxDrawdown(values: number[]) {
  let peak = -Infinity, mdd = 0;
  for (const v of values) { peak = Math.max(peak, v); if (peak > 0) mdd = Math.min(mdd, v / peak - 1); }
  return mdd * 100;
}

/** date -> close lookup with forward fill over the given calendar. */
function closeMap(rows: HistRow[], calendar: string[]) {
  const by = new Map(rows.map((r) => [r[0], r[4]]));
  const out = new Map<string, number | null>();
  let last: number | null = null;
  const first = rows[0]?.[0];
  for (const d of calendar) {
    if (by.has(d)) last = by.get(d)!;
    out.set(d, first && d >= first ? last : null);
  }
  return out;
}

/**
 * Actual portfolio value over time from the transaction ledger and real closing prices.
 * Time-weighted return (TWR) removes the effect of deposits/withdrawals so it is comparable to NEPSE.
 * Limited to the price history available (about one year from the free sources).
 */
export function portfolioSeries(txns: Txn[], fees: Fees, options: Partial<EngineOptions>,
  hist: Record<string, HistRow[]>, nepse: HistRow[]): SeriesPoint[] {
  const live = txns.filter((t) => !t.voided);
  if (!live.length || !nepse.length) return [];
  const firstTxn = live.map((t) => t.date).sort()[0];
  let calendar = nepse.map((r) => r[0]).filter((d) => d >= firstTxn);
  if (!calendar.length) return [];
  // include one prior day so flows before the window are captured as starting capital
  const snaps = positionsOverTime(live, fees, options, calendar);
  const closes: Record<string, Map<string, number | null>> = {};
  for (const s of Object.keys(hist)) closes[s] = closeMap(hist[s], calendar);
  const nepseClose = closeMap(nepse, calendar);
  const out: SeriesPoint[] = [];
  let twr = 1, prevValue = 0, prevIn = 0, prevOut = 0, nepse0: number | null = null;
  calendar = calendar.slice();
  snaps.forEach((s, i) => {
    let value = 0, unpriced = 0;
    for (const h of s.holdings) {
      const c = closes[h.symbol]?.get(s.date) ?? null;
      if (c === null) { unpriced += h.cost; value += h.cost; } else value += h.qty * c; // unpriced carried at cost, flagged
    }
    const flow = (s.cashIn - prevIn) - (s.cashOut - prevOut); // net new money put in today
    if (i > 0) {
      const base = prevValue + Math.max(flow, 0);
      const end = value + Math.max(-flow, 0);
      if (base > 0) twr *= end / base;
    }
    prevValue = value; prevIn = s.cashIn; prevOut = s.cashOut;
    const n = nepseClose.get(s.date) ?? null;
    if (nepse0 === null && n !== null) nepse0 = n;
    out.push({ date: s.date, value, cost: s.cost, invested: s.cashIn - s.cashOut, pnl: value - s.cost + s.realized + s.dividends,
      twr: (twr - 1) * 100, nepse: n !== null && nepse0 ? (n / nepse0 - 1) * 100 : null, unpriced });
  });
  return out;
}

export interface RiskReport {
  weights: { symbol: string; sector: string; value: number; pct: number }[];
  sectors: { sector: string; value: number; pct: number }[];
  hhi: number; effectiveStocks: number; effectiveSectors: number; diversification: number;
  volatility: number | null; maxDrawdown: number | null; beta: number | null; betas: Record<string, number | null>;
  corr: { symbols: string[]; matrix: (number | null)[][]; avg: number | null };
  liquidity: { symbol: string; daysToExit: number | null; avgTurnover: number | null; value: number }[];
  window: number; suggestions: string[];
}

function returnsByDate(rows: HistRow[]) {
  const m = new Map<string, number>();
  for (let i = 1; i < rows.length; i += 1) if (rows[i - 1][4]) m.set(rows[i][0], rows[i][4] / rows[i - 1][4] - 1);
  return m;
}

export function riskReport(holdings: Holding[], sectorOf: (s: string) => string, hist: Record<string, HistRow[]>,
  nepse: HistRow[], turnover: (s: string) => number | null, concentrationPct: number): RiskReport {
  const held = holdings.filter((h) => h.qty > 0 && h.value);
  const total = held.reduce((s, h) => s + (h.value ?? 0), 0);
  const weights = held.map((h) => ({ symbol: h.symbol, sector: sectorOf(h.symbol), value: h.value ?? 0, pct: total ? ((h.value ?? 0) / total) * 100 : 0 }))
    .sort((a, b) => b.pct - a.pct);
  const secMap = new Map<string, number>();
  weights.forEach((w) => secMap.set(w.sector, (secMap.get(w.sector) ?? 0) + w.value));
  const sectors = [...secMap.entries()].map(([sector, value]) => ({ sector, value, pct: total ? (value / total) * 100 : 0 })).sort((a, b) => b.pct - a.pct);
  const hhi = weights.reduce((s, w) => s + (w.pct / 100) ** 2, 0);
  const hhiS = sectors.reduce((s, w) => s + (w.pct / 100) ** 2, 0);
  const effectiveStocks = hhi ? 1 / hhi : 0, effectiveSectors = hhiS ? 1 / hhiS : 0;
  const diversification = Math.round(50 * Math.min(1, effectiveStocks / 8) + 50 * Math.min(1, effectiveSectors / 4));

  // Current-composition analytics over the common recent window
  const WINDOW = 120;
  const dates = nepse.slice(-WINDOW).map((r) => r[0]);
  const rets: Record<string, Map<string, number>> = {};
  held.forEach((h) => { rets[h.symbol] = returnsByDate(hist[h.symbol] ?? []); });
  const nret = returnsByDate(nepse);
  const port: number[] = [], bench: number[] = [];
  for (const d of dates) {
    let r = 0, w = 0;
    for (const x of weights) { const v = rets[x.symbol]?.get(d); if (v !== undefined) { r += v * x.pct; w += x.pct; } }
    if (w > 50 && nret.has(d)) { port.push(r / w); bench.push(nret.get(d)!); }
  }
  const vol = port.length >= 20 ? stdev(port) * Math.sqrt(TRADING_DAYS) * 100 : null;
  let cum = 1;
  const curve = port.map((r) => (cum *= 1 + r));
  const varB = stdev(bench) ** 2;
  const cov = (a: number[], b: number[]) => { const ma = mean(a), mb = mean(b); return a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0) / Math.max(1, a.length - 1); };
  const beta = port.length >= 20 && varB ? cov(port, bench) / varB : null;
  const betas: Record<string, number | null> = {};
  held.forEach((h) => {
    const a: number[] = [], b: number[] = [];
    for (const d of dates) { const v = rets[h.symbol]?.get(d); if (v !== undefined && nret.has(d)) { a.push(v); b.push(nret.get(d)!); } }
    const vb = stdev(b) ** 2;
    betas[h.symbol] = a.length >= 20 && vb ? cov(a, b) / vb : null;
  });
  const symbols = weights.map((w) => w.symbol);
  const series = symbols.map((s) => dates.map((d) => rets[s]?.get(d)).filter((v): v is number => v !== undefined));
  const matrix = symbols.map((_, i) => symbols.map((__, j) => (i === j ? 1 : correlation(series[i], series[j]))));
  const offs: number[] = [];
  matrix.forEach((row, i) => row.forEach((c, j) => { if (j > i && c !== null) offs.push(c); }));

  const liquidity = weights.map((w) => {
    const t = turnover(w.symbol);
    // days to exit assuming I can be at most 10% of average daily turnover
    return { symbol: w.symbol, value: w.value, avgTurnover: t, daysToExit: t ? w.value / (t * 0.1) : null };
  });

  const suggestions: string[] = [];
  if (!weights.length) suggestions.push('Add transactions to see risk analytics.');
  weights.filter((w) => w.pct > concentrationPct).forEach((w) => suggestions.push(`${w.symbol} is ${w.pct.toFixed(0)}% of the portfolio (limit ${concentrationPct}%). Direct new money elsewhere or trim on strength.`));
  sectors.filter((s) => s.pct > 50).forEach((s) => suggestions.push(`${s.sector} makes up ${s.pct.toFixed(0)}% of the portfolio. A sector-specific shock (regulation, NRB directive, monsoon for hydro) would hit most of your capital.`));
  if (weights.length && weights.length < 5) suggestions.push(`Only ${weights.length} stock(s) held. Spreading across 6-10 quality names in 3-4 sectors typically removes most single-company risk.`);
  if (sectors.length && sectors.length < 3) suggestions.push(`Holdings span ${sectors.length} sector(s). Consider adding an unrelated sector.`);
  if (offs.length && mean(offs) > 0.6) suggestions.push(`Holdings move together (average correlation ${mean(offs).toFixed(2)}): diversification benefit is limited.`);
  liquidity.filter((l) => l.daysToExit !== null && l.daysToExit > 5).forEach((l) => suggestions.push(`${l.symbol} is illiquid for your position size: about ${l.daysToExit!.toFixed(0)} trading days to exit at 10% of daily turnover.`));
  if (weights.length && !suggestions.length) suggestions.push('Diversification looks reasonable on the measures tracked here. Review again after each purchase.');

  return { weights, sectors, hhi, effectiveStocks, effectiveSectors, diversification, volatility: vol,
    maxDrawdown: curve.length ? maxDrawdown([1, ...curve]) : null, beta, betas,
    corr: { symbols, matrix, avg: offs.length ? mean(offs) : null }, liquidity, window: port.length, suggestions };
}

/** What-if: NEPSE moves by `shockPct`; each holding moves by beta x shock (beta 1 when unknown, flagged). */
export function stressTest(holdings: Holding[], betas: Record<string, number | null>, shockPct: number) {
  const rows = holdings.filter((h) => h.qty > 0 && h.value).map((h) => {
    const b = betas[h.symbol];
    const move = (b ?? 1) * shockPct;
    return { symbol: h.symbol, value: h.value!, beta: b, assumed: b === null, movePct: move, change: (h.value! * move) / 100 };
  });
  const value = rows.reduce((s, r) => s + r.value, 0);
  const change = rows.reduce((s, r) => s + r.change, 0);
  return { rows, value, change, pct: value ? (change / value) * 100 : 0 };
}

export function monthlyPnl(events: { date: string; kind: string; amount: number }[]) {
  const m = new Map<string, { month: string; realized: number; dividends: number }>();
  for (const e of events) {
    const k = e.date.slice(0, 7);
    const row = m.get(k) ?? { month: k, realized: 0, dividends: 0 };
    if (e.kind === 'SELL') row.realized += e.amount; else row.dividends += e.amount;
    m.set(k, row);
  }
  return [...m.values()].sort((a, b) => a.month.localeCompare(b.month));
}
