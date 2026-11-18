/**
 * AI Investment Assistant.
 *
 * Built-in engine (no API key, works offline on GitHub Pages): recognises the
 * question, retrieves the CURRENT portfolio and market data, and answers only
 * from those numbers. Every line is tagged Fact / Estimate / Opinion and it
 * says so when data is insufficient. It cannot fabricate a price because it
 * has no text generator - it only formats values that exist in the data.
 *
 * Optional: with your own Claude API key (Settings), free-form questions are
 * sent to Claude together with a compact snapshot of the same data and strict
 * instructions not to invent figures.
 */
import type { Market, StockAnalysis } from './data';
import { npr, pct } from './format';
import { adviseProspect, qualityWith } from './recommend';
import { stressTest } from './risk';
import type { AppState } from './store';
import type { PortfolioView } from './usePortfolio';

export type Tag = 'fact' | 'estimate' | 'opinion' | 'note';
export interface Line { tag: Tag; text: string }
export interface Answer { title: string; lines: Line[]; sources: { label: string; url?: string }[]; engine: 'built-in' | 'claude' }
export interface Ctx { state: AppState; m: Market; pf: PortfolioView; betas: Record<string, number | null> }

const F = (text: string): Line => ({ tag: 'fact', text });
const E = (text: string): Line => ({ tag: 'estimate', text });
const O = (text: string): Line => ({ tag: 'opinion', text });
const N = (text: string): Line => ({ tag: 'note', text });

function dataSource(c: Ctx) {
  return [{ label: `Prices: ${c.m.prices?.source ?? 'n/a'} (unofficial), market date ${c.m.prices?.marketDate ?? 'n/a'}` },
    { label: `Analysis generated ${c.m.analysis?.generatedAt ?? 'n/a'} from reported fundamentals (ShareHub, unofficial) and daily price history (Chukul, unofficial)` }];
}
function findSymbols(q: string, c: Ctx): string[] {
  const words = q.toUpperCase().match(/[A-Z0-9]{2,10}/g) ?? [];
  const stop = new Set(['NEPSE', 'NRB', 'NPR', 'AI', 'IF', 'MY', 'IN', 'AT', 'TO', 'IS', 'IT', 'OF', 'ON', 'THE', 'BUY', 'SELL', 'HOLD', 'MORE', 'WHAT', 'WHICH', 'SHOULD', 'RS']);
  const out = words.filter((w) => !stop.has(w) && (c.m.rowMap[w] || c.pf.holdings.some((h) => h.symbol === w)));
  const lower = q.toLowerCase();
  for (const r of c.m.prices?.rows ?? []) {
    const name = (r.name ?? '').toLowerCase().replace(/ limited| ltd\.?| company| bank/g, '').trim();
    if (name.length > 5 && lower.includes(name) && !out.includes(r.symbol)) out.push(r.symbol);
  }
  return [...new Set(out)];
}
function stale(c: Ctx): Line[] {
  const f = c.m.status?.freshness;
  if (!c.m.prices) return [N('Market data is unavailable right now, so I cannot value the portfolio. No prices are assumed.')];
  if (f && f.state !== 'fresh') return [N(`Data warning: ${f.message}`)];
  return [];
}

function pnl(c: Ctx): Answer {
  const t = c.pf.totals;
  const best = [...c.pf.held].filter((h) => h.unrealized !== null).sort((a, b) => b.unrealized! - a.unrealized!);
  return { title: 'Portfolio profit / loss', engine: 'built-in', sources: dataSource(c), lines: [
    ...stale(c),
    F(`Market value Rs ${npr(t.value)} against a cost of Rs ${npr(t.cost)} across ${t.holdingCount} stock(s).`),
    F(`Unrealized P/L: Rs ${npr(t.unrealized)} (${pct(t.unrealizedPct)}). Realized P/L to date: Rs ${npr(t.realized)} after charges and Rs ${npr(t.cgt)} CGT. Net dividends: Rs ${npr(t.dividendNet)}.`),
    F(`Net return (realized + unrealized + dividends): Rs ${npr(t.netReturn)} (${pct(t.netReturnPct)} of the Rs ${npr(t.totalBuyCost)} you have invested in total).`),
    F(`Today: ${c.pf.dayChange.amount >= 0 ? 'up' : 'down'} Rs ${npr(Math.abs(c.pf.dayChange.amount))} (${pct(c.pf.dayChange.pct)}).`),
    E(`If you sold everything at the latest prices you would receive about Rs ${npr(t.netIfSold)} after brokerage, SEBON fee, DP charges and CGT.`),
    ...(best.length ? [F(`Largest gain: ${best[0].symbol} Rs ${npr(best[0].unrealized)} (${pct(best[0].unrealizedPct, 1)}). Largest loss/smallest gain: ${best[best.length - 1].symbol} Rs ${npr(best[best.length - 1].unrealized)} (${pct(best[best.length - 1].unrealizedPct, 1)}).`)] : []),
    ...(t.unpricedCost > 0 ? [N(`Holdings costing Rs ${npr(t.unpricedCost)} have no current price and are excluded.`)] : []),
  ] };
}

function sellIdeas(c: Ctx, profitFocus = false): Answer {
  const adv = Object.values(c.pf.advice);
  const sells = adv.filter((a) => a.action === 'SELL' || a.action === 'REDUCE' || a.flags.some((f) => ['stop', 'target', 'support'].includes(f.kind)));
  const lines: Line[] = [...stale(c)];
  if (!adv.length) lines.push(N('You have no holdings recorded.'));
  else if (!sells.length) lines.push(O('No holding currently has a sell or reduce signal, a breached stop/target, or broken support. On the evidence tracked, continuing to hold is reasonable.'));
  for (const a of sells) {
    const h = c.pf.held.find((x) => x.symbol === a.symbol)!;
    lines.push(F(`${a.symbol}: price Rs ${npr(h.ltp, 1)}, your average cost Rs ${npr(h.avgCost, 2)}, unrealized ${pct(h.unrealizedPct, 1)}. Signal ${a.action} (confidence ${a.confidence}/100).`));
    a.flags.slice(0, 3).forEach((f) => lines.push(F(`  ${f.text}`)));
    lines.push(O(`  ${a.suggested}`));
  }
  if (profitFocus) {
    const winners = c.pf.held.filter((h) => (h.unrealizedPct ?? 0) >= 15 && !sells.some((s) => s.symbol === h.symbol));
    winners.forEach((h) => {
      const a = c.pf.advice[h.symbol];
      lines.push(F(`${h.symbol} is up ${pct(h.unrealizedPct, 1)} (Rs ${npr(h.unrealized)}); signal ${a.action}, technical outlook ${a.technicalOutlook}.`));
      lines.push(O(`  ${a.technicalOutlook === 'Bearish' ? 'Momentum has turned down: booking part of the profit is defensible.' : 'Trend is intact: holding with a trailing stop below support protects the gain without capping it.'} ${h.sellNow ? `Selling all now nets about Rs ${npr(h.sellNow.profit)} profit after tax.` : ''}`));
    });
    if (!winners.length && !sells.length) lines.push(N('No holding is up 15% or more, so there is no large profit to book right now.'));
  }
  lines.push(N('These are decision-support signals from reported financials and price data. They are not predictions, and no order is placed for you.'));
  return { title: profitFocus ? 'Book profits or keep holding?' : 'Holdings to consider selling', lines, sources: dataSource(c), engine: 'built-in' };
}

function stockView(c: Ctx, sym: string, wantBuy: boolean): Answer {
  const a = c.m.analysis?.stocks[sym];
  const row = c.m.rowMap[sym];
  const h = c.pf.held.find((x) => x.symbol === sym);
  const lines: Line[] = [...stale(c)];
  if (!row) return { title: sym, engine: 'built-in', sources: dataSource(c), lines: [N(`${sym} has no price in the latest market data, so I cannot assess it. Nothing is assumed.`)] };
  lines.push(F(row.carried
    ? `${sym} (${row.name ?? ''}, ${row.sector ?? 'sector unknown'}) has not traded yet in the latest session; its last close was Rs ${npr(row.ltp, 1)} on ${row.asOf}.`
    : `${sym} (${row.name ?? ''}, ${row.sector ?? 'sector unknown'}) last traded at Rs ${npr(row.ltp, 1)} (${pct(row.pctChange)} today).`));
  if (!a) { lines.push(N('This instrument is priced but not analysed (mutual funds and debentures are excluded from scoring).')); return { title: sym, lines, sources: dataSource(c), engine: 'built-in' }; }
  const p = adviseProspect(a, c.state.settings.weights, c.m.analysis!.thresholds);
  const f = a.fundamentals;
  if (f) lines.push(F(`Fundamentals (FY ${f.period?.fiscalYear} ${String(f.period?.quarter).toUpperCase()}): EPS ${f.eps}, book value ${f.bookValue ?? 'n/a'}, ROE ${f.roe ?? 'n/a'}%, P/E ${a.valuation.pe?.toFixed(1) ?? 'n/a'}, P/B ${a.valuation.pb?.toFixed(2) ?? 'n/a'}${f.npl !== null && f.npl !== undefined ? `, NPL ${f.npl}%` : ''}. EPS growth YoY ${pct(f.epsGrowthYoY, 0)}.`));
  else lines.push(N('Fundamentals are missing for this company, so any view is incomplete.'));
  lines.push(F(`Technicals: RSI ${a.tech.rsi14?.toFixed(0) ?? 'n/a'}, price vs 50-day MA ${a.tech.sma50 ? (a.price > a.tech.sma50 ? 'above' : 'below') : 'n/a'} (${a.tech.sma50 ? `Rs ${npr(a.tech.sma50)}` : ''}), outlook ${a.technical.outlook}. 1-month return ${pct(a.tech.ret1m, 1)}.`));
  lines.push(F(`Scores: quality ${p.quality?.toFixed(0) ?? 'n/a'}/100, short-term trading ${a.trading?.toFixed(0) ?? 'n/a'}/100, risk ${a.risk.level} (${a.risk.score?.toFixed(0) ?? 'n/a'}/100). Model signal: ${p.action}. Confidence ${a.confidence.toFixed(0)}/100.`));
  if (a.levels) lines.push(E(`Reference levels from price history: entry zone Rs ${npr(a.levels.entryLow)}–${npr(a.levels.entryHigh)}, support Rs ${npr(a.levels.downsideLevel)} (${pct(a.levels.downsidePct, 1)}), ${a.levels.upsideTarget ? `resistance Rs ${npr(a.levels.upsideTarget)} (${pct(a.levels.upsidePct, 1)})` : 'no resistance above price in the window'}.`));
  if (h) {
    const adv = c.pf.advice[sym];
    lines.push(F(`You hold ${npr(h.qty)} shares at an average cost of Rs ${npr(h.avgCost, 2)}: unrealized ${pct(h.unrealizedPct, 1)} (Rs ${npr(h.unrealized)}). It is ${c.pf.weightOf[sym]?.toFixed(0) ?? '?'}% of your portfolio (limit ${c.state.settings.concentrationPct}%).`));
    adv.flags.forEach((fl) => lines.push(F(fl.text)));
    lines.push(O(adv.suggested));
    if (wantBuy) {
      const w = c.pf.weightOf[sym] ?? 0;
      lines.push(O(w > c.state.settings.concentrationPct ? `Buying more would deepen an already over-limit position (${w.toFixed(0)}%). The model signal alone does not justify that.`
        : p.action === 'BUY' || p.action === 'ACCUMULATE' ? `Adding is supported by the model${p.inZone ? ' and the price is inside the entry zone' : ', but the price is above the entry zone, so a staggered purchase or waiting for a pullback lowers timing risk'}. Buying at Rs ${npr(row.ltp, 1)} would ${row.ltp < h.avgCost ? 'lower' : 'raise'} your average cost. Use the Buying calculator for the exact revised average.`
          : `The model does not support adding now (signal ${p.action}). Averaging down on a weak signal increases risk rather than reducing it.`));
    }
  } else lines.push(O(p.suggested));
  if (a.incomplete) lines.push(N(`Incomplete data: ${a.dataGaps.join('; ')}.`));
  p.invalidation.slice(0, 2).forEach((x) => lines.push(N(`Would change this view: ${x}`)));
  return { title: `${sym}: ${wantBuy ? 'should I buy' + (h ? ' more' : '') + '?' : 'analysis'}`, lines, sources: dataSource(c), engine: 'built-in' };
}

function topIdeas(c: Ctx): Answer {
  const an = c.m.analysis;
  const lines: Line[] = [...stale(c)];
  if (!an) lines.push(N('Analysis data is not available.'));
  else {
    lines.push(F(`Market trend indicator: ${an.regime.label}. Ranking = quality score x confidence, only stocks with fundamentals, non-high risk and a BUY/ACCUMULATE signal.`));
    an.top10.forEach((t, i) => {
      const a = an.stocks[t.symbol];
      lines.push(F(`${i + 1}. ${a.symbol} (${a.sector}) Rs ${npr(a.price, 1)} · quality ${a.quality?.toFixed(0)} · P/E ${a.valuation.pe?.toFixed(1) ?? 'n/a'} · ROE ${a.fundamentals?.roe ?? 'n/a'}% · risk ${a.risk.level}${a.levels ? ` · entry Rs ${npr(a.levels.entryLow)}–${npr(a.levels.entryHigh)}` : ''}`));
    });
    if (!an.top10.length) lines.push(N('No stock currently passes all the ranking filters. That is a legitimate outcome in a weak market.'));
    lines.push(O('These rank highest on the transparent model today. Read each company\'s latest quarterly report before buying; the ranking cannot see qualitative issues such as governance.'));
  }
  return { title: 'Highest-ranked investment opportunities', lines, sources: dataSource(c), engine: 'built-in' };
}

function riskiest(c: Ctx): Answer {
  const rows = c.pf.held.map((h) => ({ h, a: c.m.analysis?.stocks[h.symbol] })).sort((x, y) => (y.a?.risk.score ?? 60) - (x.a?.risk.score ?? 60));
  const lines: Line[] = [...stale(c)];
  if (!rows.length) lines.push(N('You have no holdings recorded.'));
  rows.forEach(({ h, a }) => {
    if (!a) { lines.push(N(`${h.symbol}: no analysis available, risk cannot be measured (treat as unknown, not as low).`)); return; }
    lines.push(F(`${h.symbol}: risk ${a.risk.level} (${a.risk.score?.toFixed(0)}/100) · volatility ${a.tech.volatility?.toFixed(0) ?? 'n/a'}% · ${pct(a.tech.fromHigh52, 0)} from high · weight ${c.pf.weightOf[h.symbol]?.toFixed(0) ?? '?'}%${a.risk.notes.length ? ` · ${a.risk.notes.join('; ')}` : ''}`));
  });
  const over = c.pf.held.filter((h) => (c.pf.weightOf[h.symbol] ?? 0) > c.state.settings.concentrationPct);
  over.forEach((h) => lines.push(F(`Concentration risk: ${h.symbol} is ${c.pf.weightOf[h.symbol].toFixed(0)}% of the portfolio.`)));
  return { title: 'Risk across my holdings (highest first)', lines, sources: dataSource(c), engine: 'built-in' };
}

function stress(c: Ctx, shock: number): Answer {
  const st = stressTest(c.pf.held, c.betas, shock);
  const lines: Line[] = [...stale(c), F(`Current market value: Rs ${npr(st.value)}.`),
    E(`If NEPSE moves ${shock > 0 ? '+' : ''}${shock}%, the portfolio is estimated to change by Rs ${npr(st.change)} (${pct(st.pct, 1)}) to about Rs ${npr(st.value + st.change)}.`)];
  [...st.rows].sort((a, b) => a.change - b.change).slice(0, 6).forEach((r) => lines.push(E(`${r.symbol}: beta ${r.assumed ? '1.00 (assumed, insufficient history)' : r.beta!.toFixed(2)} → ${pct(r.movePct, 1)} → Rs ${npr(r.change)}`)));
  lines.push(N('Method: each holding moves by its historical beta to NEPSE (last ~120 sessions) times the index move. Real sell-offs are usually worse for illiquid stocks; treat this as a rough guide.'));
  return { title: `What if NEPSE moves ${shock > 0 ? '+' : ''}${shock}%?`, lines, sources: dataSource(c), engine: 'built-in' };
}

function allocate(c: Ctx, amount: number): Answer {
  const an = c.m.analysis;
  const lines: Line[] = [...stale(c)];
  if (!an || !an.top10.length) { lines.push(N('No ranked opportunities are available, so I cannot suggest an allocation.')); return { title: 'Allocation', lines, sources: dataSource(c), engine: 'built-in' }; }
  const limit = c.state.settings.concentrationPct / 100;
  const total = c.pf.totals.value + amount;
  const picks: { a: StockAnalysis; rs: number; kitta: number }[] = [];
  const sectorsUsed = new Map<string, number>();
  const per = amount / 4;
  for (const t of an.top10) {
    if (picks.length >= 4) break;
    const a = an.stocks[t.symbol];
    const sec = a.sector ?? 'Unknown';
    if ((sectorsUsed.get(sec) ?? 0) >= 2) continue;
    const existing = c.pf.held.find((h) => h.symbol === a.symbol)?.value ?? 0;
    const room = Math.max(0, total * limit - existing);
    const rs = Math.min(per, room);
    const kitta = Math.floor(rs / a.price / 10) * 10;
    if (kitta < 10) continue;
    picks.push({ a, rs: kitta * a.price, kitta });
    sectorsUsed.set(sec, (sectorsUsed.get(sec) ?? 0) + 1);
  }
  lines.push(F(`Starting from the ranked list (quality x confidence), keeping any single stock under your ${c.state.settings.concentrationPct}% limit and at most two picks per sector:`));
  picks.forEach((p) => lines.push(E(`${p.a.symbol} (${p.a.sector}): ~${p.kitta} shares ≈ Rs ${npr(p.rs)} at Rs ${npr(p.a.price, 1)} · quality ${qualityWith(p.a, c.state.settings.weights)?.toFixed(0)} · risk ${p.a.risk.level}${p.a.levels ? ` · preferred entry Rs ${npr(p.a.levels.entryLow)}–${npr(p.a.levels.entryHigh)}` : ''}`)));
  const used = picks.reduce((s, p) => s + p.rs, 0);
  lines.push(E(`Total ≈ Rs ${npr(used)} of Rs ${npr(amount)} (before about 0.4% buying charges). Remainder stays in cash.`));
  if (!picks.length) lines.push(N('The amount is too small for a 10-share lot in the ranked stocks, or concentration limits leave no room.'));
  lines.push(O('Consider buying in two or three tranches rather than all at once, and only stocks whose business you understand. This is a model-based starting point, not personal financial advice.'));
  return { title: `Ideas for investing Rs ${npr(amount)}`, lines, sources: dataSource(c), engine: 'built-in' };
}

function undervalued(c: Ctx): Answer {
  const an = c.m.analysis;
  const list = Object.values(an?.stocks ?? {}).filter((s) => s.categories.includes('undervalued')).sort((a, b) => (b.valuation.score ?? 0) - (a.valuation.score ?? 0)).slice(0, 10);
  const lines: Line[] = [...stale(c), N('Limitation: the free data gives about one year of prices and the latest fundamentals, not a multi-year P/E history. So I can show stocks cheap relative to their SECTOR PEERS and to their own 1-year price range, but not versus their long-run historical valuation.')];
  list.forEach((a) => lines.push(F(`${a.symbol} (${a.sector}): P/E ${a.valuation.pe?.toFixed(1)} · P/B ${a.valuation.pb?.toFixed(2)} · ${a.valuation.notes[0] ?? ''} · at ${a.tech.rangePos52?.toFixed(0) ?? '?'}% of its 1-year range · fundamental score ${a.fundamental.score?.toFixed(0)}`)));
  if (!list.length) lines.push(N('No profitable company with acceptable fundamentals currently screens as cheap versus peers.'));
  lines.push(O('Cheap can stay cheap: each of these still has positive earnings and a fundamental score of 50+, which is why they are listed rather than simply the biggest fallers.'));
  return { title: 'Stocks trading at a discount to sector peers', lines, sources: dataSource(c), engine: 'built-in' };
}

function news(c: Ctx, q: string): Answer {
  const items = c.m.news?.items ?? [];
  const policy = /nrb|monetary|policy|interest|rate|budget|tax|sebon|regulat/i.test(q);
  const held = new Set(c.pf.held.map((h) => h.symbol));
  const rel = items.filter((n) => (policy ? ['Monetary policy', 'Regulation', 'Fiscal policy & tax', 'Banking sector'].includes(n.category) : n.symbols.some((s) => held.has(s)) || n.impact === 'Critical' || n.impact === 'High')).slice(0, 8);
  const lines: Line[] = [];
  if (!c.m.news) lines.push(N('News has not been collected yet.'));
  else if (!rel.length) lines.push(N(`I found no ${policy ? 'monetary-policy or regulatory' : 'high-impact or holding-specific'} items among the ${items.length} recent headlines collected. I cannot comment on a policy I have no sourced report of.`));
  rel.forEach((n) => lines.push(F(`[${n.impact}] ${n.title} (${n.source}${n.publishedAt ? `, ${n.publishedAt.slice(0, 10)}` : ''})`)));
  if (policy && c.pf.held.length) {
    const bfi = c.pf.held.filter((h) => /Bank|Finance|Microfinance/.test(c.pf.sectorOf(h.symbol)));
    lines.push(O(`General mechanism (not specific to any one announcement): NRB policy acts on your portfolio mainly through bank liquidity, interest rates and margin-lending limits. ${bfi.length ? `Your banking/finance holdings (${bfi.map((h) => h.symbol).join(', ')}) are the most directly exposed; ` : ''}looser policy and cheaper share-backed loans typically support the whole market, tightening does the opposite.`));
    lines.push(N('Open the linked sources on the Market Intelligence page for the actual text before drawing conclusions. I only see headlines.'));
  }
  return { title: policy ? 'Policy and regulatory developments' : 'News relevant to my portfolio', lines, engine: 'built-in',
    sources: rel.map((n) => ({ label: `${n.source}: ${n.title.slice(0, 70)}`, url: n.url })) };
}

export const EXAMPLES = [
  'What is my current portfolio profit or loss?', 'Which stock should I consider selling today?', 'Should I buy more NABIL at its current market price?',
  'Which stocks have the best investment potential this month?', 'Which stocks in my portfolio have the highest risk?',
  'What is the impact of the latest NRB monetary policy on my holdings?', 'If I invest another NPR 100,000, which stocks should I consider?',
  'What happens to my portfolio if NEPSE declines by 10%?', 'Which stocks are trading below their historical valuation?',
  'Should I book profits or continue holding my current stocks?',
];

/** Returns null when the built-in engine does not recognise the question. */
export function answerLocal(q: string, c: Ctx): Answer | null {
  const s = q.toLowerCase();
  const syms = findSymbols(q, c);
  const amount = (() => { const mm = s.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(lakh|lac|crore|k)?/); if (!mm) return null; const v = Number(mm[1]) * ({ lakh: 1e5, lac: 1e5, crore: 1e7, k: 1e3 }[mm[2] ?? ''] ?? 1); return v >= 1000 ? v : null; })();
  if (/nepse.*(declin|fall|drop|crash|down|ris|up|gain|increase)|if nepse|stress/.test(s)) {
    const mm = s.match(/(\d+(?:\.\d+)?)\s*%/);
    const mag = mm ? Number(mm[1]) : 10;
    return stress(c, /ris|up|gain|increase/.test(s) && !/declin|fall|drop|crash|down/.test(s) ? mag : -mag);
  }
  if (/invest (another|more|an additional)|if i invest|where (should|to) (i )?invest|have (rs|npr)/.test(s) && amount) return allocate(c, amount);
  if (/nrb|monetary|policy|news|announcement|budget|sebon|regulat/.test(s)) return news(c, q);
  if (/book profit|take profit|continue holding|keep holding/.test(s)) return sellIdeas(c, true);
  if (syms.length && /buy|add|accumulate|purchase|average/.test(s)) return stockView(c, syms[0], true);
  if (syms.length) return stockView(c, syms[0], false);
  if (/sell|exit|reduce/.test(s)) return sellIdeas(c);
  if (/risk|risky|volatil|danger/.test(s)) return riskiest(c);
  if (/historical valuation|undervalued|cheap|below.*valu|discount/.test(s)) return undervalued(c);
  if (/best|potential|opportunit|top|recommend|which stocks? (to|should i) buy|what (to|should i) buy/.test(s)) return topIdeas(c);
  if (/profit|loss|p&l|pnl|p\/l|return|worth|value|how (is|am) (my|i)/.test(s)) return pnl(c);
  return null;
}

/** Compact, factual snapshot sent to Claude (only when the user has configured their own key). */
export function snapshot(c: Ctx) {
  const an = c.m.analysis;
  return {
    asOf: { marketDate: c.m.prices?.marketDate, freshness: c.m.status?.freshness, analysisGeneratedAt: an?.generatedAt },
    portfolioTotals: c.pf.totals,
    holdings: c.pf.held.map((h) => { const a = an?.stocks[h.symbol]; return { symbol: h.symbol, sector: c.pf.sectorOf(h.symbol), qty: h.qty, avgCost: +h.avgCost.toFixed(2), ltp: h.ltp, unrealizedPct: h.unrealizedPct, weightPct: c.pf.weightOf[h.symbol], netProceedsIfSold: h.sellNow?.netProceeds, signal: c.pf.advice[h.symbol]?.action, flags: c.pf.advice[h.symbol]?.flags.map((f) => f.text), quality: a?.quality, risk: a?.risk.level, pe: a?.valuation.pe, pb: a?.valuation.pb, fundamentals: a?.fundamentals && { eps: a.fundamentals.eps, roe: a.fundamentals.roe, npl: a.fundamentals.npl, epsGrowthYoY: a.fundamentals.epsGrowthYoY, period: a.fundamentals.period }, tech: a && { rsi: a.tech.rsi14, sma50: a.tech.sma50, sma200: a.tech.sma200, ret1m: a.tech.ret1m, outlook: a.technical.outlook }, levels: a?.levels }; }),
    watchlist: c.state.watchlist.map((w) => ({ ...w, ltp: c.m.priceMap[w.symbol] })),
    cash: c.state.settings.cash,
    market: { indices: c.m.market?.main, regime: an?.regime.label, breadth: c.m.market?.breadth },
    top10: an?.top10.map((t) => { const a = an.stocks[t.symbol]; return { symbol: a.symbol, sector: a.sector, price: a.price, quality: a.quality, pe: a.valuation.pe, roe: a.fundamentals?.roe, risk: a.risk.level, entry: a.levels && [a.levels.entryLow, a.levels.entryHigh] }; }),
    news: (c.m.news?.items ?? []).slice(0, 25).map((n) => ({ title: n.title, source: n.source, url: n.url, date: n.publishedAt, impact: n.impact, symbols: n.symbols })),
  };
}

export const SYSTEM_PROMPT = `You are a careful investment research assistant for one individual investor on the Nepal Stock Exchange (NEPSE). Currency is NPR.
You are given a JSON snapshot of the investor's actual portfolio and current market data. Rules you must follow:
- Use ONLY numbers present in the snapshot. Never invent or recall prices, ratios, dates or announcements. If the snapshot lacks what is needed, say the data is insufficient.
- Label each statement as Fact (from the snapshot), Estimate (your calculation from snapshot numbers; show the arithmetic briefly) or Opinion (your judgement).
- When citing news, give the source name and URL from the snapshot. Headlines only: say you have not read the article body.
- If asOf.freshness.state is not "fresh", warn that prices are delayed or stale before anything else.
- This is decision support, not a guarantee or an instruction to trade. Mention the main risk and what would invalidate your view. Be concise and practical for a busy person.`;

export async function askClaude(q: string, c: Ctx, history: { role: 'user' | 'assistant'; content: string }[]): Promise<Answer> {
  const { apiKey, model } = c.state.settings.ai;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model, max_tokens: 1500, system: `${SYSTEM_PROMPT}\n\nSNAPSHOT:\n${JSON.stringify(snapshot(c))}`,
      messages: [...history.slice(-6), { role: 'user', content: q }] }),
  });
  if (!r.ok) throw new Error(`Claude API error ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const text: string = (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
  return { title: 'Claude', engine: 'claude', sources: dataSource(c), lines: text.split('\n').filter((l) => l.trim()).map((l) => N(l)) };
}
