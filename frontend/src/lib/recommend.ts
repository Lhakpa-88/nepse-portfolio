/**
 * Position-aware decision support. Starts from the market-level analysis
 * (analysis.json, built from real fundamentals + price history) and layers on
 * MY position: cost, charges, tax, concentration, target/stop and thesis.
 * Rule-based and fully explainable - every action lists its evidence.
 */
import type { Analysis, StockAnalysis } from './data';
import type { Holding } from './engine';
import { npr, pct } from './format';
import type { PositionPlan } from './store';

export type Action = 'BUY' | 'ACCUMULATE' | 'HOLD' | 'REDUCE' | 'SELL' | 'WATCH';
export type Weights = Record<'fundamental' | 'technical' | 'valuation' | 'market' | 'risk', number>;
export interface Flag { level: 'critical' | 'warn' | 'info'; kind: string; text: string }
export interface Advice {
  symbol: string; action: Action; suggested: string; reasons: string[]; flags: Flag[]; confidence: number;
  review: string; horizon: string; invalidation: string[]; downside: string; quality: number | null;
  fundamentalOutlook: string; technicalOutlook: string; riskLevel: string; incomplete: boolean; analysedAt: string | null;
}

const ORDER: Action[] = ['SELL', 'REDUCE', 'HOLD', 'ACCUMULATE', 'BUY'];
const cap = (a: Action, max: Action): Action => (a === 'WATCH' ? a : ORDER[Math.min(ORDER.indexOf(a), ORDER.indexOf(max))]);

/** Investment-quality score re-weighted with the user's weights (missing areas are excluded, not zero-filled). */
export function qualityWith(a: StockAnalysis, w: Weights): number | null {
  const vals: Record<keyof Weights, number | null> = {
    fundamental: a.fundamental.score, technical: a.technical.score, valuation: a.valuation.score,
    market: a.market.score, risk: a.risk.score === null ? null : 100 - a.risk.score,
  };
  let sum = 0, ws = 0;
  (Object.keys(vals) as (keyof Weights)[]).forEach((k) => { if (vals[k] !== null) { sum += (vals[k] as number) * w[k]; ws += w[k]; } });
  return ws ? sum / ws : null;
}

/** Same stance rules as analytics/scoring.py::stance, applied to the re-weighted score. */
export function stanceOf(a: StockAnalysis, q: number | null, th: Record<string, number>): Action {
  const f = a.fundamental.score, risk = a.risk.level, tech = a.technical.outlook;
  if (f === null || q === null) return 'WATCH';
  if (q >= th.buy && f >= 60 && tech !== 'Bearish' && risk !== 'High') return 'BUY';
  if (q >= th.accumulate && f >= 50 && risk !== 'High') return tech === 'Bearish' ? 'WATCH' : 'ACCUMULATE';
  if (q >= th.hold) return 'HOLD';
  if (q >= th.reduce) return 'REDUCE';
  return 'SELL';
}

export interface AdviceCtx {
  weightPct: number | null; sectorPct: number | null; plan?: PositionPlan; concentrationPct: number;
  weights: Weights; analysis: Analysis | null; heldSymbols: string[];
}

export function adviseHolding(h: Holding, a: StockAnalysis | undefined, ctx: AdviceCtx): Advice {
  const flags: Flag[] = [];
  const reasons: string[] = [];
  const base: Advice = {
    symbol: h.symbol, action: 'WATCH', suggested: '', reasons, flags, confidence: 0, review: 'Medium term',
    horizon: 'Medium term', invalidation: [], downside: '', quality: null, fundamentalOutlook: 'Unknown',
    technicalOutlook: 'Unknown', riskLevel: 'Unknown', incomplete: true, analysedAt: ctx.analysis?.generatedAt ?? null,
  };
  if (!a || h.ltp === null) {
    base.suggested = 'No recommendation: this symbol has no current market data or analysis. Verify the symbol and check the price with your broker.';
    reasons.push('Recommendation incomplete: market data for this symbol is missing, so nothing is inferred.');
    return base;
  }
  const th = ctx.analysis?.thresholds ?? { buy: 70, accumulate: 60, hold: 45, reduce: 35 };
  const q = qualityWith(a, ctx.weights);
  let action = stanceOf(a, q, th);
  const ltp = h.ltp;
  const t = a.tech;
  const gainPct = h.unrealizedPct ?? 0;

  reasons.push(`Investment-quality score ${q === null ? 'n/a' : q.toFixed(0)}/100 (fundamental ${fmt(a.fundamental.score)}, technical ${fmt(a.technical.score)}, valuation ${fmt(a.valuation.score)}, market ${fmt(a.market.score)}, risk ${fmt(a.risk.score)} where higher = riskier).`);
  [...a.fundamental.notes.slice(0, 2), ...a.valuation.notes.slice(0, 1), ...a.technical.notes.slice(0, 2)].forEach((n) => reasons.push(n));

  // --- sell-side signals -------------------------------------------------
  const plan = ctx.plan ?? {};
  if (plan.stop && ltp <= plan.stop) {
    flags.push({ level: 'critical', kind: 'stop', text: `Stop-loss breached: price ${npr(ltp, 1)} is at/below your stop ${npr(plan.stop, 1)}.` });
    action = cap(action === 'WATCH' ? 'SELL' : action, 'SELL');
  }
  if (plan.target && ltp >= plan.target) {
    flags.push({ level: 'warn', kind: 'target', text: `Target reached: price ${npr(ltp, 1)} has hit your target ${npr(plan.target, 1)}.` });
    action = cap(action === 'WATCH' ? 'REDUCE' : action, 'REDUCE');
  }
  const sup = t.support60 ?? t.support20;
  if (sup && ltp < sup) {
    flags.push({ level: 'warn', kind: 'support', text: `Technical support broken: price is below the ${t.support60 ? '60' : '20'}-day low of ${npr(sup, 1)}.` });
    action = cap(action, action === 'BUY' || action === 'ACCUMULATE' ? 'HOLD' : action);
  }
  const f = a.fundamentals;
  if (f && (f.eps <= 0 || (f.epsGrowthYoY ?? 0) <= -25)) {
    flags.push({ level: 'warn', kind: 'fundamental', text: f.eps <= 0 ? 'Fundamentals deteriorated: the company is reporting losses.' : `Earnings fell ${Math.abs(f.epsGrowthYoY).toFixed(0)}% vs the same quarter last year.` });
  }
  if (a.valuation.pe && a.valuation.pe > 40 && (a.valuation.components.pe ?? 100) < 25) {
    flags.push({ level: 'warn', kind: 'valuation', text: `Valuation looks expensive: P/E ${a.valuation.pe.toFixed(1)} is well above sector norms.` });
    action = cap(action, 'HOLD');
  }
  if ((t.volRatio ?? 0) >= 3) {
    flags.push({ level: 'info', kind: 'volume', text: `Abnormal activity: volume is ${t.volRatio.toFixed(1)}x the 20-day average.` });
  }
  if (ctx.weightPct !== null && ctx.weightPct > ctx.concentrationPct) {
    flags.push({ level: 'warn', kind: 'concentration', text: `Concentration: this stock is ${ctx.weightPct.toFixed(0)}% of your portfolio (your limit ${ctx.concentrationPct}%).` });
    action = cap(action, 'HOLD');
  }
  if (gainPct <= -15) {
    flags.push({ level: 'warn', kind: 'loss', text: `Position is down ${Math.abs(gainPct).toFixed(1)}% from your cost. Re-check whether your original reason for buying still holds.` });
  }
  if (plan.thesis && (action === 'REDUCE' || action === 'SELL')) {
    flags.push({ level: 'warn', kind: 'thesis', text: `Your thesis ("${plan.thesis.slice(0, 80)}") may no longer hold. Review it against the evidence below.` });
  }
  if ((action === 'REDUCE' || action === 'SELL') && ctx.analysis) {
    const better = ctx.analysis.top10.map((x) => x.symbol).filter((s) => !ctx.heldSymbols.includes(s)).slice(0, 3);
    if (better.length) flags.push({ level: 'info', kind: 'alternative', text: `Higher-ranked alternatives in the screener: ${better.join(', ')}.` });
  }

  // --- suggested action (cost, charges and tax aware) ---------------------
  const sn = h.sellNow;
  const afterTax = sn ? ` Selling everything at ${npr(ltp, 1)} would net about Rs ${npr(sn.netProceeds)} after brokerage, SEBON fee, DP charge and Rs ${npr(sn.cgt)} CGT, i.e. ${sn.profit >= 0 ? 'a profit' : 'a loss'} of Rs ${npr(Math.abs(sn.profit))}.` : '';
  const lv = a.levels;
  let suggested: string;
  switch (action) {
    case 'BUY':
    case 'ACCUMULATE':
      suggested = `Hold your ${npr(h.qty)} shares; adding is reasonable${lv ? ` in the Rs ${npr(lv.entryLow)}-${npr(lv.entryHigh)} zone` : ''}, in small tranches, keeping the position under ${ctx.concentrationPct}% of the portfolio.`;
      break;
    case 'HOLD':
      suggested = flags.some((x) => x.kind === 'concentration')
        ? `Hold, but do not add. Consider trimming towards your ${ctx.concentrationPct}% limit on strength.`
        : `Hold the entire position.${lv ? ` Set a stop-loss near Rs ${npr(lv.stopLoss)} (below 60-day support).` : ''}`;
      break;
    case 'REDUCE':
      suggested = gainPct > 0
        ? `Book partial profits: consider selling about a third to a half and keep the rest with a stop${lv ? ` near Rs ${npr(lv.stopLoss)}` : ''}.`
        : `Sell partially to cut exposure, or set a firm stop-loss${lv ? ` near Rs ${npr(lv.stopLoss)}` : ''} and reconsider the investment thesis.`;
      break;
    case 'SELL':
      suggested = 'Consider exiting completely (or in two tranches if liquidity is thin). Evidence no longer supports holding.';
      break;
    default:
      suggested = 'No firm view: data is incomplete. Keep the position under watch and do not add until the gaps are resolved.';
  }
  suggested += afterTax;

  const critical = flags.some((x) => x.level === 'critical');
  const longTermOk = (action === 'BUY' || action === 'ACCUMULATE') && (a.fundamental.score ?? 0) >= 65;
  return {
    ...base,
    action, suggested, quality: q,
    confidence: Math.round(a.confidence * (a.incomplete ? 0.6 : 1)),
    review: critical ? 'Short term (next trading session)' : action === 'REDUCE' || action === 'SELL' || flags.length ? 'Short term (within a week)' : longTermOk ? 'Long term (quarterly results)' : 'Medium term (monthly)',
    horizon: longTermOk ? 'Long term' : action === 'HOLD' ? 'Medium term' : 'Short to medium term',
    invalidation: invalidation(action, a),
    downside: lv ? `If 60-day support at Rs ${npr(lv.downsideLevel, 1)} fails, downside from here is about ${pct(lv.downsidePct, 1)} to that level; a ${a.risk.level?.toLowerCase()} risk profile (volatility ${a.tech.volatility ? `${a.tech.volatility.toFixed(0)}%` : 'n/a'} annualised).` : 'Not enough price history to estimate downside levels.',
    fundamentalOutlook: a.fundamental.outlook ?? 'Unknown', technicalOutlook: a.technical.outlook ?? 'Unknown',
    riskLevel: a.risk.level ?? 'Unknown', incomplete: a.incomplete,
  };
}

const fmt = (v: number | null) => (v === null ? 'n/a' : v.toFixed(0));

export function invalidation(action: Action, a: StockAnalysis): string[] {
  const out: string[] = [];
  const lv = a.levels;
  if (action === 'BUY' || action === 'ACCUMULATE' || action === 'HOLD') {
    if (lv) out.push(`Close below Rs ${npr(lv.stopLoss)} (60-day support minus 2%).`);
    out.push('Next quarterly report shows EPS falling sharply or turning negative.');
    if (a.fundamentals?.npl !== null && a.fundamentals?.npl !== undefined) out.push('Non-performing loans rise materially or capital adequacy drops near the regulatory minimum.');
    out.push('Adverse regulatory action or governance issue affecting the company or sector.');
  } else if (action === 'REDUCE' || action === 'SELL') {
    if (a.tech.sma50) out.push(`Price reclaims the 50-day average (Rs ${npr(a.tech.sma50)}) on rising volume.`);
    out.push('Next quarterly report shows a clear earnings recovery.');
  } else {
    out.push('View will be formed once fundamentals and at least 30 days of price history are available.');
  }
  return out;
}

/** Analysis card for a stock I do not own (watchlist / screener). */
export function adviseProspect(a: StockAnalysis, weights: Weights, th: Record<string, number>) {
  const q = qualityWith(a, weights);
  const action = stanceOf(a, q, th);
  const lv = a.levels;
  const inZone = lv ? a.price >= lv.entryLow && a.price <= lv.entryHigh * 1.01 : false;
  let suggested = 'No view: data incomplete.';
  if (action === 'BUY' || action === 'ACCUMULATE') {
    suggested = lv ? (inZone ? `Price is inside the entry zone Rs ${npr(lv.entryLow)}-${npr(lv.entryHigh)}. Consider a first tranche.` : `Wait for the entry zone Rs ${npr(lv.entryLow)}-${npr(lv.entryHigh)} rather than chasing.`) : 'Fundamentals support buying; no technical entry zone yet.';
  } else if (action === 'HOLD') suggested = 'Not compelling at this price. Keep on the watchlist.';
  else if (action === 'REDUCE' || action === 'SELL') suggested = 'Avoid for now: evidence is weak.';
  return { action, quality: q, suggested, inZone, invalidation: invalidation(action, a) };
}
