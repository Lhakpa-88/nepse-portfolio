import { useState } from 'react';
import { useOpenStock } from '../App';
import { Badge, Card, DataTable, ScoreBar, Tabs, type Col } from '../components/ui';
import { useMarket } from '../lib/data';
import { npr, num, pct, tone } from '../lib/format';
import { adviseProspect } from '../lib/recommend';
import { useStore, type WatchItem } from '../lib/store';
import { usePortfolio } from '../lib/usePortfolio';

export default function Watchlist() {
  const m = useMarket();
  const { state, upsertWatch, removeWatch } = useStore();
  const pf = usePortfolio();
  const open = useOpenStock();
  const [tab, setTab] = useState<'watch' | 'avoid'>('watch');
  const [sym, setSym] = useState('');
  const rows = state.watchlist.filter((w) => w.list === tab);
  const A = (s: string) => m.analysis?.stocks[s];
  const P = (s: string) => { const a = A(s); return a && m.analysis ? adviseProspect(a, state.settings.weights, m.analysis.thresholds) : null; };
  const ltp = (s: string) => m.priceMap[s] ?? null;
  const inRange = (w: WatchItem) => { const p = ltp(w.symbol); return p !== null && !!w.buyHigh && p <= w.buyHigh && (!w.buyLow || p >= w.buyLow * 0.97); };
  const numInput = (w: WatchItem, k: 'buyLow' | 'buyHigh' | 'targetSell') => (
    <input className="input !w-20 !py-0.5 text-right" type="number" defaultValue={w[k] ?? ''} onClick={(e) => e.stopPropagation()}
      onBlur={(e) => upsertWatch({ symbol: w.symbol, [k]: e.target.value ? Number(e.target.value) : null })} />);

  const cols: Col<WatchItem>[] = [
    { key: 'symbol', header: 'Symbol', sort: (w) => w.symbol, cell: (w) => <span><b>{w.symbol}</b> <span className="text-xs text-mute">{m.rowMap[w.symbol]?.sector ?? ''}</span></span> },
    { key: 'ltp', header: 'LTP', align: 'right', sort: (w) => ltp(w.symbol), cell: (w) => (ltp(w.symbol) ? npr(ltp(w.symbol), 1) : <span className="text-warn">no price</span>) },
    { key: 'chg', header: 'Day', align: 'right', sort: (w) => m.rowMap[w.symbol]?.pctChange, cell: (w) => <span className={tone(m.rowMap[w.symbol]?.pctChange)}>{pct(m.rowMap[w.symbol]?.pctChange)}</span> },
    { key: 'm1', header: '1M / 3M', align: 'right', cell: (w) => <span>{pct(A(w.symbol)?.tech.ret1m, 1)} / {pct(A(w.symbol)?.tech.ret3m, 1)}</span> },
    { key: 'signal', header: 'Signal', sort: (w) => P(w.symbol)?.action, cell: (w) => <Badge>{P(w.symbol)?.action ?? 'WATCH'}</Badge> },
    { key: 'q', header: 'Quality', sort: (w) => P(w.symbol)?.quality, cell: (w) => <ScoreBar value={P(w.symbol)?.quality} /> },
    { key: 'val', header: 'P/E · P/B', align: 'right', cell: (w) => `${num(A(w.symbol)?.valuation.pe, 1)} · ${num(A(w.symbol)?.valuation.pb)}` },
    { key: 'rsi', header: 'RSI', align: 'right', sort: (w) => A(w.symbol)?.tech.rsi14, cell: (w) => num(A(w.symbol)?.tech.rsi14, 0) },
    { key: 'risk', header: 'Risk', cell: (w) => <Badge>{A(w.symbol)?.risk.level ?? 'Unknown'}</Badge> },
    { key: 'buy', header: 'My buy range', cell: (w) => <span className="flex items-center gap-1">{numInput(w, 'buyLow')}–{numInput(w, 'buyHigh')}{inRange(w) && <span className="chip bg-up/15 text-up">IN RANGE</span>}</span> },
    { key: 'target', header: 'Target sell', cell: (w) => numInput(w, 'targetSell') },
    { key: 'up', header: 'Upside', align: 'right', sort: (w) => (w.targetSell && ltp(w.symbol) ? w.targetSell / ltp(w.symbol)! - 1 : null), cell: (w) => (w.targetSell && ltp(w.symbol) ? <span className={tone(w.targetSell / ltp(w.symbol)! - 1)}>{pct((w.targetSell / ltp(w.symbol)! - 1) * 100, 1)}</span> : '—') },
    { key: 'act', header: '', cell: (w) => (
      <span className="flex gap-1" onClick={(e) => e.stopPropagation()}>
        <button className="btn !px-2 !py-0.5" title={tab === 'watch' ? 'Move to Avoid list' : 'Move back to Watchlist'} onClick={() => upsertWatch({ symbol: w.symbol, list: tab === 'watch' ? 'avoid' : 'watch' })}>{tab === 'watch' ? '→ Avoid' : '→ Watch'}</button>
        <button className="btn btn-danger !px-2 !py-0.5" onClick={() => removeWatch(w.symbol)}>Remove</button>
      </span>) },
  ];
  const add = () => {
    const s = sym.toUpperCase().trim();
    if (!s) return;
    const a = A(s);
    upsertWatch({ symbol: s, list: tab, buyLow: a?.levels?.entryLow ?? null, buyHigh: a?.levels?.entryHigh ?? null, targetSell: a?.levels?.upsideTarget ?? null });
    setSym('');
  };
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Watchlist</h1>
        <Tabs value={tab} onChange={setTab} options={[{ value: 'watch', label: `Watchlist (${state.watchlist.filter((w) => w.list === 'watch').length})` }, { value: 'avoid', label: `Avoid (${state.watchlist.filter((w) => w.list === 'avoid').length})` }]} />
      </div>
      <Card title={tab === 'watch' ? 'Stocks I am tracking but do not own' : 'Stocks I have decided to avoid'} right={
        <div className="flex gap-2">
          <input className="input !w-40 uppercase" list="wl-symbols" placeholder="Add symbol…" value={sym} onChange={(e) => setSym(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <datalist id="wl-symbols">{(m.prices?.rows ?? []).map((r) => <option key={r.symbol} value={r.symbol}>{r.name}</option>)}</datalist>
          <button className="btn btn-primary" onClick={add}>Add</button>
        </div>}>
        <DataTable rows={rows} cols={cols} rowKey={(w) => w.symbol} onRow={(w) => open(w.symbol)} empty={tab === 'watch' ? 'Your watchlist is empty. Add a symbol above, or use "+ Watchlist" on any stock in the Screener or Opportunities pages.' : 'No stocks on your avoid list.'} />
        <div className="mt-3 text-xs text-mute">
          Buy range and target are prefilled from the analysed entry zone and resistance, and are yours to edit. When a watched stock trades inside your buy range, the automated pipeline sends a Telegram alert (after you sync your encrypted portfolio file — see Settings).
          {pf.held.some((h) => rows.some((w) => w.symbol === h.symbol)) && ' Stocks you now own also appear in My Portfolio.'}
        </div>
      </Card>
    </>
  );
}
