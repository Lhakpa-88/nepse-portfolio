import { useEffect, useMemo, useState } from 'react';
import { useOpenStock } from '../App';
import { Badge, Banner, Card, DataTable, Empty, Field, Tabs, type Col } from '../components/ui';
import { useMarket } from '../lib/data';
import { estimateSale, newPosition, scheduleFor, tradeCharges, type Fees, type Position } from '../lib/engine';
import { download, fmtTime, npr, pct, toCsv, todayNPT, tone } from '../lib/format';
import type { Advice } from '../lib/recommend';
import { useStore } from '../lib/store';
import { usePortfolio } from '../lib/usePortfolio';

function synth(qty: number, totalCost: number, date: string): Position {
  const p = newPosition('CALC');
  p.qty = qty; p.cost = totalCost; p.taxCost = totalCost;
  p.lots = qty > 0 ? [{ date, qty, unitCost: totalCost / qty, unitTax: totalCost / qty }] : [];
  return p;
}
/** Selling price at which net profit after all charges and tax is zero (bisection). */
function breakEven(pos: Position, qty: number, on: string, fees: Fees, method: 'WACC' | 'FIFO') {
  if (!qty || !pos.qty) return null;
  let lo = 0, hi = (pos.cost / pos.qty) * 3 + 10;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (estimateSale(pos, qty, mid, on, fees, method).profit < 0) lo = mid; else hi = mid;
  }
  return hi;
}
const Row = ({ k, v, strong = false, cls = '' }: { k: string; v: string; strong?: boolean; cls?: string }) => (
  <div className={`flex justify-between border-b border-line/50 py-1.5 text-sm ${strong ? 'font-semibold' : ''}`}><span className="text-mute">{k}</span><span className={`num ${cls}`}>{v}</span></div>
);
const SCEN = [-10, -5, 5, 10, 15];

function SellCalc() {
  const { state } = useStore();
  const m = useMarket();
  const pf = usePortfolio();
  const fees = state.settings.fees, method = state.settings.engine.method;
  const [symbol, setSymbol] = useState(pf.held[0]?.symbol ?? '');
  const held = pf.held.find((h) => h.symbol === symbol.toUpperCase());
  const [usePos, setUsePos] = useState(true);
  const [qty, setQty] = useState('');
  const [buy, setBuy] = useState('');
  const [buyDate, setBuyDate] = useState(todayNPT());
  const [buyCh, setBuyCh] = useState('');
  const [sell, setSell] = useState('');
  const [custom, setCustom] = useState('');
  useEffect(() => {
    const ltp = m.priceMap[symbol.toUpperCase()];
    if (held) { setQty(String(held.qty)); setBuy(held.avgCost.toFixed(2)); }
    if (ltp) setSell(String(ltp));
  }, [symbol, held?.qty]); // eslint-disable-line react-hooks/exhaustive-deps
  const q = Number(qty) || 0, bp = Number(buy) || 0, sp = Number(sell) || 0;
  const fromPos = !!held && usePos;
  const autoBuy = tradeCharges(scheduleFor(fees, buyDate), q * bp);
  const buyCharges = buyCh === '' ? autoBuy.commission + autoBuy.sebon + autoBuy.dp : Number(buyCh);
  const pos = fromPos ? held! : synth(q, q * bp + buyCharges, buyDate);
  const valid = q > 0 && sp > 0 && q <= pos.qty + 1e-9;
  const est = valid ? estimateSale(pos, q, sp, todayNPT(), fees, method) : null;
  const be = valid ? breakEven(pos, q, todayNPT(), fees, method) : null;
  const prices = useMemo(() => {
    const list = SCEN.map((s) => ({ label: `${s > 0 ? '+' : ''}${s}%`, price: sp * (1 + s / 100) }));
    list.splice(2, 0, { label: 'Proposed', price: sp });
    custom.split(/[ ,;]+/).map(Number).filter((x) => x > 0).forEach((x) => list.push({ label: 'Custom', price: x }));
    return list;
  }, [sp, custom]);
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card title="Selling calculator — inputs">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Stock symbol"><input className="input uppercase" list="symbols-all" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} /></Field>
          <Field label="Shares to sell" hint={held ? `You hold ${npr(held.qty)}` : undefined}><input className="input" type="number" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
          {held && <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={usePos} onChange={(e) => setUsePos(e.target.checked)} /> Use my actual position (real cost basis, purchase dates and holding period)</label>}
          {!fromPos && (<>
            <Field label="Purchase price / share"><input className="input" type="number" value={buy} onChange={(e) => setBuy(e.target.value)} /></Field>
            <Field label="Purchase date" hint="Sets short/long-term CGT rate"><input className="input" type="date" value={buyDate} max={todayNPT()} onChange={(e) => setBuyDate(e.target.value)} /></Field>
            <Field label="Purchase charges (total)"><input className="input" type="number" placeholder={`auto ${npr(autoBuy.commission + autoBuy.sebon + autoBuy.dp, 2)}`} value={buyCh} onChange={(e) => setBuyCh(e.target.value)} /></Field>
          </>)}
          <Field label="Proposed selling price" hint={m.priceMap[symbol] ? `LTP Rs ${npr(m.priceMap[symbol], 1)}` : undefined}><input className="input" type="number" value={sell} onChange={(e) => setSell(e.target.value)} /></Field>
          <Field label="Extra prices to simulate" hint="Comma-separated"><input className="input" placeholder="e.g. 600, 650" value={custom} onChange={(e) => setCustom(e.target.value)} /></Field>
        </div>
        {q > pos.qty + 1e-9 && fromPos && <div className="mt-3"><Banner level="bad">You hold only {npr(pos.qty)} shares.</Banner></div>}
      </Card>
      <Card title="Result">
        {!est ? <Empty>Enter quantity and selling price.</Empty> : (
          <>
            <Row k="Total acquisition cost (incl. purchase charges)" v={`Rs ${npr(est.costRemoved, 2)}`} />
            <Row k="Gross selling proceeds" v={`Rs ${npr(est.gross, 2)}`} />
            <Row k="Brokerage commission" v={`− ${npr(est.commission, 2)}`} />
            <Row k="SEBON fee" v={`− ${npr(est.sebon, 2)}`} />
            <Row k="DP charge" v={`− ${npr(est.dp, 2)}`} />
            <Row k={`Capital gains tax (${npr(est.shortTermQty)} short-term, ${npr(est.longTermQty)} long-term shares)`} v={`− ${npr(est.cgt, 2)}`} />
            <Row k="Net proceeds" v={`Rs ${npr(est.netProceeds, 2)}`} strong />
            <Row k="Net profit / loss" v={`Rs ${npr(est.profit, 2)}`} strong cls={tone(est.profit)} />
            <Row k="Return on cost" v={pct(est.costRemoved ? (est.profit / est.costRemoved) * 100 : null)} cls={tone(est.profit)} />
            <Row k="Break-even selling price" v={be ? `Rs ${npr(be, 2)}` : '—'} strong />
          </>
        )}
      </Card>
      <Card title="Selling price simulation" className="lg:col-span-2">
        {!valid ? <Empty>Complete the inputs above.</Empty> : (
          <div className="overflow-x-auto"><table className="w-full">
            <thead><tr className="border-b border-line"><th className="th">Scenario</th><th className="th text-right">Sell price</th><th className="th text-right">Gross</th><th className="th text-right">Charges</th><th className="th text-right">CGT</th><th className="th text-right">Net proceeds</th><th className="th text-right">Net P/L</th><th className="th text-right">Return</th></tr></thead>
            <tbody>{prices.map((p, i) => { const e = estimateSale(pos, q, p.price, todayNPT(), fees, method); return (
              <tr key={`${p.label}${i}`} className={`border-b border-line/50 ${p.label === 'Proposed' ? 'bg-accent/5' : ''}`}>
                <td className="td">{p.label}</td><td className="td num text-right">{npr(p.price, 2)}</td><td className="td num text-right">{npr(e.gross)}</td>
                <td className="td num text-right">{npr(e.commission + e.sebon + e.dp, 2)}</td><td className="td num text-right">{npr(e.cgt, 2)}</td>
                <td className="td num text-right">{npr(e.netProceeds)}</td><td className={`td num text-right ${tone(e.profit)}`}>{npr(e.profit)}</td>
                <td className={`td num text-right ${tone(e.profit)}`}>{pct(e.costRemoved ? (e.profit / e.costRemoved) * 100 : null)}</td>
              </tr>); })}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

function BuyCalc() {
  const { state } = useStore();
  const m = useMarket();
  const pf = usePortfolio();
  const fees = state.settings.fees, method = state.settings.engine.method;
  const [symbol, setSymbol] = useState('');
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const [exQty, setExQty] = useState('');
  const [exAvg, setExAvg] = useState('');
  const [custom, setCustom] = useState('');
  const held = pf.held.find((h) => h.symbol === symbol);
  useEffect(() => {
    if (m.priceMap[symbol]) setPrice(String(m.priceMap[symbol]));
    setExQty(held ? String(held.qty) : ''); setExAvg(held ? held.avgCost.toFixed(2) : '');
  }, [symbol]); // eslint-disable-line react-hooks/exhaustive-deps
  const q = Number(qty) || 0, p = Number(price) || 0, eq = Number(exQty) || 0, ea = Number(exAvg) || 0;
  const ch = tradeCharges(scheduleFor(fees, todayNPT()), q * p);
  const costs = ch.commission + ch.sebon + ch.dp;
  const purchase = q * p + costs;
  const newQty = eq + q, newCost = eq * ea + purchase;
  const valid = q > 0 && p > 0;
  // combined position: existing lots keep their real dates when it is my holding, new lot dated today
  const pos = useMemo(() => {
    const x = synth(newQty, newCost, todayNPT());
    if (held && eq === held.qty) x.lots = [...held.lots.map((l) => ({ ...l })), { date: todayNPT(), qty: q, unitCost: purchase / (q || 1), unitTax: purchase / (q || 1) }];
    return x;
  }, [newQty, newCost, held, eq, q, purchase]);
  const be = valid ? breakEven(pos, newQty, todayNPT(), fees, method) : null;
  const targets = [...SCEN.map((s) => ({ label: `${s > 0 ? '+' : ''}${s}%`, price: p * (1 + s / 100) })), ...custom.split(/[ ,;]+/).map(Number).filter((x) => x > 0).map((x) => ({ label: 'Custom', price: x }))];
  const cash = state.settings.cash;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card title="Buying calculator — inputs">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Stock symbol"><input className="input uppercase" list="symbols-all" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} /></Field>
          <Field label="Shares to buy"><input className="input" type="number" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
          <Field label="Proposed buying price" hint={m.priceMap[symbol] ? `LTP Rs ${npr(m.priceMap[symbol], 1)}` : undefined}><input className="input" type="number" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
          <Field label="Existing shares held"><input className="input" type="number" value={exQty} onChange={(e) => setExQty(e.target.value)} /></Field>
          <Field label="Existing average cost"><input className="input" type="number" value={exAvg} onChange={(e) => setExAvg(e.target.value)} /></Field>
          <Field label="Custom target prices" hint="Comma-separated"><input className="input" value={custom} onChange={(e) => setCustom(e.target.value)} /></Field>
        </div>
        {valid && cash > 0 && purchase > cash && <div className="mt-3"><Banner level="warn">This purchase (Rs {npr(purchase)}) exceeds your recorded available cash (Rs {npr(cash)}).</Banner></div>}
        {valid && pf.totals.value > 0 && ((eq * p + q * p) / (pf.totals.value + q * p)) * 100 > state.settings.concentrationPct && <div className="mt-3"><Banner level="warn">After this purchase {symbol || 'this stock'} would be about {(((eq * p + q * p) / (pf.totals.value + q * p)) * 100).toFixed(0)}% of your portfolio, above your {state.settings.concentrationPct}% limit.</Banner></div>}
      </Card>
      <Card title="Result">
        {!valid ? <Empty>Enter quantity and price.</Empty> : (<>
          <Row k="Share amount" v={`Rs ${npr(q * p, 2)}`} />
          <Row k="Brokerage commission" v={npr(ch.commission, 2)} /><Row k="SEBON fee" v={npr(ch.sebon, 2)} /><Row k="DP charge" v={npr(ch.dp, 2)} />
          <Row k="Total transaction costs" v={`Rs ${npr(costs, 2)}`} />
          <Row k="Total purchase amount" v={`Rs ${npr(purchase, 2)}`} strong />
          <Row k="Revised shares held" v={npr(newQty)} />
          <Row k="Revised weighted average cost" v={`Rs ${npr(newCost / newQty, 2)}`} strong />
          <Row k="Revised total investment" v={`Rs ${npr(newCost, 2)}`} />
          <Row k="Break-even selling price (after sell charges & tax)" v={be ? `Rs ${npr(be, 2)}` : '—'} strong />
        </>)}
      </Card>
      <Card title="Expected profit / loss on the whole position at future selling prices" className="lg:col-span-2">
        {!valid ? <Empty>Complete the inputs above.</Empty> : (
          <div className="overflow-x-auto"><table className="w-full">
            <thead><tr className="border-b border-line"><th className="th">Scenario</th><th className="th text-right">Sell price</th><th className="th text-right">Net proceeds</th><th className="th text-right">CGT</th><th className="th text-right">Net P/L</th><th className="th text-right">Return</th></tr></thead>
            <tbody>{targets.map((t, i) => { const e = estimateSale(pos, newQty, t.price, todayNPT(), fees, method); return (
              <tr key={`${t.label}${i}`} className="border-b border-line/50"><td className="td">{t.label}</td><td className="td num text-right">{npr(t.price, 2)}</td><td className="td num text-right">{npr(e.netProceeds)}</td><td className="td num text-right">{npr(e.cgt, 2)}</td>
                <td className={`td num text-right ${tone(e.profit)}`}>{npr(e.profit)}</td><td className={`td num text-right ${tone(e.profit)}`}>{pct((e.profit / newCost) * 100)}</td></tr>); })}</tbody>
          </table></div>
        )}
        <div className="mt-2 text-xs text-mute">Scenario sales are dated today, so newly bought shares are taxed at the short-term CGT rate. Holding more than 365 days lowers the rate.</div>
      </Card>
    </div>
  );
}

function Recommendations() {
  const pf = usePortfolio();
  const m = useMarket();
  const open = useOpenStock();
  const [sel, setSel] = useState<string | null>(null);
  const [filter, setFilter] = useState('ALL');
  const rows = Object.values(pf.advice).filter((a) => filter === 'ALL' || a.action === filter || a.riskLevel === filter);
  const h = (s: string) => pf.held.find((x) => x.symbol === s)!;
  const cols: Col<Advice>[] = [
    { key: 'symbol', header: 'Stock', sort: (a) => a.symbol, cell: (a) => <b>{a.symbol}</b> },
    { key: 'ltp', header: 'Current price', align: 'right', sort: (a) => h(a.symbol).ltp, cell: (a) => npr(h(a.symbol).ltp, 1) },
    { key: 'avg', header: 'My avg price', align: 'right', sort: (a) => h(a.symbol).avgCost, cell: (a) => npr(h(a.symbol).avgCost, 2) },
    { key: 'ret', header: 'Unrealized', align: 'right', sort: (a) => h(a.symbol).unrealizedPct, cell: (a) => <span className={tone(h(a.symbol).unrealizedPct)}>{pct(h(a.symbol).unrealizedPct, 1)}</span> },
    { key: 'fund', header: 'Fundamental', sort: (a) => a.fundamentalOutlook, cell: (a) => <Badge>{a.fundamentalOutlook}</Badge> },
    { key: 'tech', header: 'Technical', sort: (a) => a.technicalOutlook, cell: (a) => <Badge>{a.technicalOutlook}</Badge> },
    { key: 'risk', header: 'Risk', sort: (a) => a.riskLevel, cell: (a) => <Badge>{a.riskLevel}</Badge> },
    { key: 'action', header: 'Recommendation', sort: (a) => a.action, cell: (a) => <span className="flex items-center gap-1"><Badge>{a.action}</Badge>{a.incomplete && <span className="text-xs text-warn" title="Incomplete data">incomplete</span>}</span> },
    { key: 'conf', header: 'Confidence', align: 'right', sort: (a) => a.confidence, cell: (a) => `${a.confidence}/100` },
    { key: 'review', header: 'Review', cell: (a) => <span className="text-xs text-mute">{a.review}</span> },
  ];
  const a = sel ? pf.advice[sel] : null;
  const exportCsv = () => download(`recommendations-${todayNPT()}.csv`, toCsv(Object.values(pf.advice).map((x) => ({ Symbol: x.symbol, Price: h(x.symbol).ltp, 'Avg cost': h(x.symbol).avgCost.toFixed(2), 'Unrealized %': h(x.symbol).unrealizedPct?.toFixed(2), Fundamental: x.fundamentalOutlook, Technical: x.technicalOutlook, Risk: x.riskLevel, Recommendation: x.action, Confidence: x.confidence, Review: x.review, 'Suggested action': x.suggested, Flags: x.flags.map((f) => f.text).join(' | '), 'Analysed at': x.analysedAt }))), 'text/csv');
  if (!pf.held.length) return <Empty>Add holdings to get position-specific recommendations.</Empty>;
  return (
    <div className="space-y-4">
      <Card title="Recommendations for my holdings" right={<div className="flex items-center gap-2">
        <select className="input !w-auto" value={filter} onChange={(e) => setFilter(e.target.value)}>{['ALL', 'BUY', 'ACCUMULATE', 'HOLD', 'REDUCE', 'SELL', 'WATCH', 'Low', 'Medium', 'High'].map((x) => <option key={x} value={x}>{x === 'ALL' ? 'All signals' : ['Low', 'Medium', 'High'].includes(x) ? `${x} risk` : x}</option>)}</select>
        <button className="btn" onClick={exportCsv}>Export CSV</button></div>}>
        <DataTable rows={rows} cols={cols} rowKey={(x) => x.symbol} onRow={(x) => setSel(x.symbol)} />
        <div className="mt-2 text-xs text-mute">Click a row for the reasoning. Analysis generated {fmtTime(m.analysis?.generatedAt)} from market date {m.analysis?.marketDate ?? '—'}. Decision support only: built from reported financials and price data, not predictions.</div>
      </Card>
      {a && (
        <Card title={<span>{a.symbol} — why <Badge>{a.action}</Badge></span>} right={<button className="btn" onClick={() => open(a.symbol)}>Full analysis & chart</button>}>
          <p className="text-sm"><b>Suggested action:</b> {a.suggested}</p>
          {a.flags.length > 0 && <div className="mt-3 space-y-1">{a.flags.map((f) => <div key={f.text} className={`text-sm ${f.level === 'critical' ? 'text-down' : f.level === 'warn' ? 'text-warn' : 'text-mute'}`}>{f.level === 'critical' ? '■' : '▲'} {f.text}</div>)}</div>}
          <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-3">
            <div><div className="label">Supporting evidence</div><ul className="list-disc space-y-1 pl-4 text-sm">{a.reasons.map((r) => <li key={r}>{r}</li>)}</ul></div>
            <div><div className="label">Potential downside</div><p className="text-sm">{a.downside}</p><div className="label mt-3">Horizon</div><p className="text-sm">{a.horizon} · review: {a.review}</p></div>
            <div><div className="label">What would invalidate this</div><ul className="list-disc space-y-1 pl-4 text-sm">{a.invalidation.map((r) => <li key={r}>{r}</li>)}</ul></div>
          </div>
        </Card>
      )}
    </div>
  );
}

export default function BuySell() {
  const m = useMarket();
  const [tab, setTab] = useState<'rec' | 'sell' | 'buy'>('rec');
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Buy / Sell Analysis</h1>
        <Tabs value={tab} onChange={setTab} options={[{ value: 'rec', label: 'Buy · Hold · Sell signals' }, { value: 'sell', label: 'Selling calculator' }, { value: 'buy', label: 'Buying calculator' }]} />
      </div>
      <datalist id="symbols-all">{(m.prices?.rows ?? []).map((r) => <option key={r.symbol} value={r.symbol}>{r.name}</option>)}</datalist>
      {tab === 'rec' && <Recommendations />}
      {tab === 'sell' && <SellCalc />}
      {tab === 'buy' && <BuyCalc />}
    </>
  );
}
