import { useState } from 'react';
import { useOpenStock } from '../App';
import { Badge, Banner, Card, Empty, ScoreBar } from '../components/ui';
import { shortDate, useMarket, type StockAnalysis } from '../lib/data';
import { fmtTime, npr, num, pct, tone } from '../lib/format';
import { adviseProspect } from '../lib/recommend';
import { useStore } from '../lib/store';
import { usePortfolio } from '../lib/usePortfolio';

function holdingPeriod(a: StockAnalysis, action: string) {
  if (a.categories.includes('trading') && !['BUY', 'ACCUMULATE'].includes(action)) return 'Short term (days to weeks) - trading setup only';
  if ((a.fundamental.score ?? 0) >= 68) return 'Long term (1 year+), review each quarter';
  return 'Medium term (3-12 months)';
}

function IdeaCard({ a, rank }: { a: StockAnalysis; rank?: number }) {
  const open = useOpenStock();
  const m = useMarket();
  const { state, upsertWatch } = useStore();
  const pf = usePortfolio();
  const p = adviseProspect(a, state.settings.weights, m.analysis!.thresholds);
  const f = a.fundamentals;
  const lv = a.levels;
  const owned = pf.held.some((h) => h.symbol === a.symbol);
  const watched = state.watchlist.some((w) => w.symbol === a.symbol);
  const positives = [...a.fundamental.notes.filter((n) => /up |ranks at the (6|7|8|9)/.test(n)), ...a.technical.notes.filter((n) => /Breakout|uptrend|bullish/i.test(n))];
  const negatives = [...a.fundamental.notes.filter((n) => /down |High non|loss|below/.test(n)), ...a.technical.notes.filter((n) => /Breakdown|downtrend|bearish|overbought/i.test(n)), ...a.risk.notes];
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center gap-2">
        {rank && <span className="num flex h-7 w-7 items-center justify-center rounded-full bg-accent/15 text-sm font-bold text-accent">{rank}</span>}
        <button className="text-base font-semibold hover:text-accent" onClick={() => open(a.symbol)}>{a.symbol}</button>
        <span className="text-xs text-mute">{a.name} · {a.sector}</span>
        <span className="ml-auto flex items-center gap-2"><Badge>{p.action}</Badge><Badge>{a.risk.level ?? 'Unknown'}</Badge></span>
      </div>
      <div className="num mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <span className="text-xl font-semibold">Rs {npr(a.price, 1)}</span><span className={tone(a.pctChange)}>{pct(a.pctChange)}</span>
        <span className="text-mute">P/E {num(a.valuation.pe, 1)} · P/B {num(a.valuation.pb)} · ROE {num(f?.roe, 1)}% · Yield {num(a.valuation.divYield, 1)}%</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
        <div className="flex items-center justify-between"><span className="text-mute">Quality</span><ScoreBar value={p.quality} /></div>
        <div className="flex items-center justify-between"><span className="text-mute">Fundamental</span><ScoreBar value={a.fundamental.score} /></div>
        <div className="flex items-center justify-between"><span className="text-mute">Technical</span><ScoreBar value={a.technical.score} /></div>
        <div className="flex items-center justify-between"><span className="text-mute">Valuation</span><ScoreBar value={a.valuation.score} /></div>
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm md:grid-cols-2">
        <div><dt className="inline text-mute">Entry range: </dt><dd className="num inline">{lv ? `Rs ${npr(lv.entryLow)} – ${npr(lv.entryHigh)}` : 'n/a'}{p.inZone && <span className="ml-1 text-up">(in zone now)</span>}</dd></div>
        <div><dt className="inline text-mute">Holding period: </dt><dd className="inline">{holdingPeriod(a, p.action)}</dd></div>
        <div><dt className="inline text-mute">Upside scenario: </dt><dd className="num inline">{lv?.upsideTarget ? `Rs ${npr(lv.upsideTarget)} (${pct(lv.upsidePct, 1)}) to prior resistance / 52-week high` : 'No resistance above price in the data window'}</dd></div>
        <div><dt className="inline text-mute">Downside scenario: </dt><dd className="num inline">{lv ? `Rs ${npr(lv.downsideLevel)} (${pct(lv.downsidePct, 1)}) at 60-day support; stop ~Rs ${npr(lv.stopLoss)}` : 'n/a'}</dd></div>
        <div><dt className="inline text-mute">Recent results: </dt><dd className="inline">{f ? `FY ${f.period?.fiscalYear} ${String(f.period?.quarter).toUpperCase()}: EPS ${num(f.eps, 1)} (${pct(f.epsGrowthYoY, 0)} YoY), net profit ${pct(f.profitGrowthYoY, 0)} YoY` : 'not available'}</dd></div>
        <div><dt className="inline text-mute">Performance: </dt><dd className="num inline">1M {pct(a.tech.ret1m, 1)} · 3M {pct(a.tech.ret3m, 1)} · 1Y {pct(a.tech.ret1y, 1)}</dd></div>
      </dl>
      <div className="mt-3 grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
        <div><div className="label !text-up">Positives</div><ul className="list-disc pl-4">{(positives.length ? positives : ['No standout positive signals beyond the scores above']).slice(0, 4).map((x) => <li key={x}>{x}</li>)}</ul></div>
        <div><div className="label !text-down">Negatives / risks</div><ul className="list-disc pl-4">{(negatives.length ? negatives : ['No specific red flags in the tracked data']).slice(0, 4).map((x) => <li key={x}>{x}</li>)}</ul></div>
      </div>
      <p className="mt-3 text-sm"><b>Rationale:</b> {p.suggested} {a.incomplete && <span className="text-warn">Data incomplete: {a.dataGaps.join('; ')}.</span>}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-mute">
        <span>Confidence {a.confidence.toFixed(0)}/100</span>
        {owned && <span className="chip bg-accent/15 text-accent">In portfolio</span>}
        {!owned && !watched && <button className="btn !py-0.5" onClick={() => upsertWatch({ symbol: a.symbol, list: 'watch', buyLow: lv?.entryLow ?? null, buyHigh: lv?.entryHigh ?? null, targetSell: lv?.upsideTarget ?? null })}>+ Watchlist</button>}
        {watched && <span className="chip bg-accent/15 text-accent">On watchlist</span>}
        <button className="btn !py-0.5" onClick={() => open(a.symbol)}>Full analysis</button>
      </div>
    </div>
  );
}

export default function Opportunities() {
  const m = useMarket();
  const [cat, setCat] = useState('top10');
  if (!m.analysis) return <Empty>{m.loading ? 'Loading…' : 'Analysis data is not available yet. Run the pipeline.'}</Empty>;
  const an = m.analysis;
  const stocks = Object.values(an.stocks);
  const count = (k: string) => stocks.filter((s) => s.categories.includes(k)).length;
  const list = cat === 'top10' ? an.top10.map((t) => an.stocks[t.symbol]).filter(Boolean)
    : stocks.filter((s) => s.categories.includes(cat)).sort((a, b) => (cat === 'avoid' ? (b.risk.score ?? 0) - (a.risk.score ?? 0) : cat === 'trading' || cat === 'breakout' || cat === 'volume' ? (b.trading ?? 0) - (a.trading ?? 0) : (b.quality ?? 0) - (a.quality ?? 0))).slice(0, 15);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Investment Opportunities</h1>
        <span className="text-xs text-mute">Generated {fmtTime(an.generatedAt)} · market trend: {an.regime.label}{an.sessionInProgress ? ` · market open: signals use closes through ${shortDate(an.indicatorsThrough)}, prices are today's` : ''}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button onClick={() => setCat('top10')} className={`rounded-md border px-3 py-1.5 text-sm ${cat === 'top10' ? 'border-accent bg-accent/15 text-accent' : 'border-line text-mute hover:text-ink'}`}>Top 10 ranked</button>
        {Object.entries(an.categories).map(([k, v]) => (
          <button key={k} onClick={() => setCat(k)} className={`rounded-md border px-3 py-1.5 text-sm ${cat === k ? (k === 'avoid' ? 'border-down bg-down/15 text-down' : 'border-accent bg-accent/15 text-accent') : 'border-line text-mute hover:text-ink'}`}>{v} <span className="num opacity-70">{count(k)}</span></button>
        ))}
      </div>
      {cat === 'top10' && <Banner level="info"><b>Ranking method:</b> {an.methodology} Weights: fundamental {an.weights.fundamental}%, technical {an.weights.technical}%, valuation {an.weights.valuation}%, market/sector {an.weights.market}%, risk {an.weights.risk}%.</Banner>}
      {cat === 'avoid' && <Banner level="warn">Stocks here have a High risk score, negative earnings, or a very low quality score. Listed so you can avoid them, not as short ideas.</Banner>}
      {cat === 'trading' && <Banner level="warn">Short-term setups are driven by price and volume only. A bullish chart does not make a stock a long-term investment; check the fundamental score on each card.</Banner>}
      {list.length === 0 ? <Empty>No stocks currently meet this screen's criteria. That is a valid result: the screen does not lower its bar to fill the list.</Empty>
        : <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">{list.map((a, i) => <IdeaCard key={a.symbol} a={a} rank={cat === 'top10' ? i + 1 : undefined} />)}</div>}
    </>
  );
}
