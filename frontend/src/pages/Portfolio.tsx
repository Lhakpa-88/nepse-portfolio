import { useMemo, useRef, useState } from 'react';
import { useOpenStock } from '../App';
import { Badge, Banner, Card, DataTable, Field, Modal, Tabs, type Col } from '../components/ui';
import { shortDate, useMarket } from '../lib/data';
import { scheduleFor, tradeCharges, type Holding, type Txn, type TxnType } from '../lib/engine';
import { fmtTime, npr, pct, todayNPT, tone } from '../lib/format';
import { downloadTemplate, exportXlsx, parseRows, readFile, txnKey, txnsToRows, type ParsedRow } from '../lib/importer';
import { useStore } from '../lib/store';
import { usePortfolio } from '../lib/usePortfolio';

const TYPES: { v: TxnType; label: string; help: string }[] = [
  { v: 'BUY', label: 'Buy (secondary market)', help: 'Charges auto-calculated from the fee schedule.' },
  { v: 'SELL', label: 'Sell', help: 'Charges and CGT auto-calculated; override with contract-note figures if they differ.' },
  { v: 'IPO', label: 'IPO / FPO / Auction', help: 'No brokerage. Price is the issue price (usually Rs 100).' },
  { v: 'RIGHT', label: 'Right share', help: 'No brokerage. Price is the right-issue price (usually Rs 100).' },
  { v: 'BONUS', label: 'Bonus share', help: 'Quantity received. Price 0. Cost basis follows Settings.' },
  { v: 'DIVIDEND', label: 'Cash dividend', help: 'Quantity = shares it was paid on; price = dividend per share in Rs. 5% tax auto-applied.' },
  { v: 'ADJUST', label: 'Other adjustment', help: 'Positive or negative quantity (e.g. merger swap); price = cost per share added.' },
];

type Draft = { date: string; symbol: string; type: TxnType; qty: string; price: string; commission: string; sebon: string; dp: string; cgt: string; other: string; broker: string; notes: string };
const blank = (): Draft => ({ date: todayNPT(), symbol: '', type: 'BUY', qty: '', price: '', commission: '', sebon: '', dp: '', cgt: '', other: '', broker: '', notes: '' });
const n = (s: string) => (s.trim() === '' ? null : Number(s));

function TxnForm({ initial, editId, onDone }: { initial?: Draft; editId?: string; onDone: () => void }) {
  const { state, addTxns, correctTxn } = useStore();
  const m = useMarket();
  const pf = usePortfolio();
  const [d, setD] = useState<Draft>(initial ?? blank());
  const [err, setErr] = useState<string[]>([]);
  const set = (k: keyof Draft, v: string) => setD((x) => ({ ...x, [k]: v }));
  const sym = d.symbol.toUpperCase().trim();
  const row = m.rowMap[sym];
  const qty = Number(d.qty) || 0, price = Number(d.price) || 0, amount = qty * price;
  const sched = scheduleFor(state.settings.fees, d.date || todayNPT());
  const auto = d.type === 'BUY' || d.type === 'SELL' ? tradeCharges(sched, amount) : { commission: 0, sebon: 0, dp: 0 };
  const held = pf.held.find((h) => h.symbol === sym);
  const typeInfo = TYPES.find((t) => t.v === d.type)!;
  const total = d.type === 'SELL' ? amount - (n(d.commission) ?? auto.commission) - (n(d.sebon) ?? auto.sebon) - (n(d.dp) ?? auto.dp) - (n(d.other) ?? 0)
    : d.type === 'DIVIDEND' ? amount * (1 - sched.dividendTaxRate)
      : amount + (n(d.commission) ?? auto.commission) + (n(d.sebon) ?? auto.sebon) + (n(d.dp) ?? auto.dp) + (n(d.other) ?? 0);

  const submit = () => {
    const e: string[] = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || d.date > todayNPT()) e.push('Enter a valid date that is not in the future.');
    if (!sym) e.push('Symbol is required.');
    if (!(qty > 0) && d.type !== 'ADJUST') e.push('Quantity must be greater than zero.');
    if (price < 0 || (price === 0 && !['BONUS', 'ADJUST'].includes(d.type))) e.push('Price must be greater than zero.');
    if (d.type === 'SELL' && !editId && qty > (held?.qty ?? 0)) e.push(`You hold ${held?.qty ?? 0} ${sym}; cannot sell ${qty}.`);
    const txn = { date: d.date, symbol: sym, company: row?.name ?? undefined, type: d.type, qty, price, commission: n(d.commission), sebon: n(d.sebon), dp: n(d.dp), cgt: n(d.cgt), other: n(d.other), broker: d.broker || undefined, notes: d.notes || undefined };
    if (!editId && state.transactions.some((t) => !t.voided && txnKey(t) === txnKey(txn as Txn)) && !err.includes('dup')) {
      setErr([...e, 'An identical transaction already exists (same date, symbol, type, quantity and price). Press Save again to add it anyway.', 'dup']);
      return;
    }
    if (e.length) { setErr(e); return; }
    if (editId) correctTxn(editId, txn); else addTxns([txn], 'manual entry');
    onDone();
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="Date (AD)"><input type="date" className="input" value={d.date} max={todayNPT()} onChange={(e) => set('date', e.target.value)} /></Field>
        <Field label="Type"><select className="input" value={d.type} onChange={(e) => set('type', e.target.value)}>{TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}</select></Field>
        <Field label="Symbol" hint={sym ? (row ? `${row.name ?? ''} · ${row.carried ? `last close Rs ${npr(row.ltp, 1)} (${shortDate(row.asOf)})` : `LTP Rs ${npr(row.ltp, 1)}`}` : 'Not in the NEPSE price list of the last 45 days: check the spelling') : undefined}>
          <input className="input uppercase" list="symbols" value={d.symbol} onChange={(e) => set('symbol', e.target.value)} placeholder="e.g. NABIL" />
          <datalist id="symbols">{(m.prices?.rows ?? []).map((r) => <option key={r.symbol} value={r.symbol}>{r.name}</option>)}</datalist>
        </Field>
        <Field label={d.type === 'DIVIDEND' ? 'Shares paid on' : 'Quantity'} hint={held ? `Currently held: ${npr(held.qty)}` : undefined}><input className="input" type="number" min="0" value={d.qty} onChange={(e) => set('qty', e.target.value)} /></Field>
        <Field label={d.type === 'DIVIDEND' ? 'Dividend per share (Rs)' : 'Price per share (Rs)'}><input className="input" type="number" min="0" step="0.01" value={d.price} onChange={(e) => set('price', e.target.value)} /></Field>
        <Field label="Brokerage commission"><input className="input" type="number" placeholder={`auto ${npr(auto.commission, 2)}`} value={d.commission} onChange={(e) => set('commission', e.target.value)} /></Field>
        <Field label="SEBON fee"><input className="input" type="number" placeholder={`auto ${npr(auto.sebon, 2)}`} value={d.sebon} onChange={(e) => set('sebon', e.target.value)} /></Field>
        <Field label="DP charge"><input className="input" type="number" placeholder={`auto ${npr(auto.dp, 2)}`} value={d.dp} onChange={(e) => set('dp', e.target.value)} /></Field>
        <Field label={d.type === 'DIVIDEND' ? 'Tax deducted (TDS)' : 'Capital gains tax'}><input className="input" type="number" placeholder="auto" disabled={!['SELL', 'DIVIDEND'].includes(d.type)} value={d.cgt} onChange={(e) => set('cgt', e.target.value)} /></Field>
        <Field label="Other charges"><input className="input" type="number" placeholder="0" value={d.other} onChange={(e) => set('other', e.target.value)} /></Field>
        <Field label="Broker (optional)"><input className="input" value={d.broker} onChange={(e) => set('broker', e.target.value)} /></Field>
        <Field label="Notes"><input className="input" value={d.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
      </div>
      <div className="text-xs text-mute">{typeInfo.help} Fee schedule in force on this date: {sched.label ?? sched.effectiveFrom}. Leave charge fields blank to use it.</div>
      <div className="num text-sm">Total transaction amount: <b>Rs {npr(total, 2)}</b> {d.type === 'SELL' && <span className="text-mute">(before CGT, which is calculated from your cost basis)</span>}</div>
      {err.filter((x) => x !== 'dup').map((x) => <Banner key={x} level="bad">{x}</Banner>)}
      <div className="flex gap-2">
        <button className="btn btn-primary" onClick={submit}>{editId ? 'Save correction' : 'Save transaction'}</button>
        <button className="btn" onClick={onDone}>Cancel</button>
      </div>
      {editId && <div className="text-xs text-mute">Corrections keep the original: it is marked void and this new version supersedes it. Both remain in the audit trail.</div>}
    </div>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const { state, addTxns } = useStore();
  const m = useMarket();
  const [rows, setRows] = useState<ParsedRow[] | null>(null);
  const [error, setError] = useState('');
  const [skipDup, setSkipDup] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const onFile = async (f?: File) => {
    if (!f) return;
    try {
      setError('');
      setRows(parseRows(await readFile(f), state.transactions, new Set(Object.keys(m.rowMap))));
    } catch (e) { setError(`Could not read the file: ${(e as Error).message}`); }
  };
  const ok = (rows ?? []).filter((r) => r.txn && !(skipDup && r.duplicate));
  const bad = (rows ?? []).filter((r) => !r.txn);
  return (
    <Modal title="Import transactions from Excel or CSV" onClose={onClose} wide>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <input ref={input} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
          <button className="btn btn-primary" onClick={() => input.current?.click()}>Choose file…</button>
          <button className="btn" onClick={downloadTemplate}>Download template (.xlsx)</button>
          <span className="text-xs text-mute">Files are read in your browser only. Nothing is uploaded.</span>
        </div>
        {error && <Banner level="bad">{error}</Banner>}
        {rows && (
          <>
            <div className="text-sm">{rows.length} row(s) read · <span className="text-up">{ok.length} ready</span> · <span className="text-warn">{rows.filter((r) => r.duplicate).length} duplicate(s)</span> · <span className="text-down">{bad.length} with errors</span></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={skipDup} onChange={(e) => setSkipDup(e.target.checked)} /> Skip duplicates (same date, symbol, type, quantity, price as an existing or earlier row)</label>
            <div className="max-h-72 overflow-auto rounded border border-line">
              <table className="w-full text-xs">
                <thead><tr className="border-b border-line"><th className="th">Row</th><th className="th">Date</th><th className="th">Symbol</th><th className="th">Type</th><th className="th text-right">Qty</th><th className="th text-right">Price</th><th className="th">Status</th></tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.row} className="border-b border-line/50">
                    <td className="td">{r.row}</td><td className="td">{r.txn?.date ?? '—'}</td><td className="td">{r.txn?.symbol ?? '—'}</td><td className="td">{r.txn?.type ?? '—'}</td>
                    <td className="td text-right">{r.txn ? npr(r.txn.qty) : '—'}</td><td className="td text-right">{r.txn ? npr(r.txn.price, 2) : '—'}</td>
                    <td className={`td !whitespace-normal ${!r.txn ? 'text-down' : r.duplicate || r.errors.length ? 'text-warn' : 'text-up'}`}>{!r.txn ? r.errors.join('; ') : r.duplicate ? 'Duplicate' : r.errors.length ? r.errors.join('; ') : 'OK'}</td>
                  </tr>))}</tbody>
              </table>
            </div>
            <div className="flex gap-2">
              <button className="btn btn-primary" disabled={!ok.length} onClick={() => { addTxns(ok.map((r) => r.txn!), 'file import'); onClose(); }}>Import {ok.length} transaction(s)</button>
              <button className="btn" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

export default function Portfolio() {
  const { state, voidTxn, restoreTxn, setPlan } = useStore();
  const m = useMarket();
  const pf = usePortfolio();
  const open = useOpenStock();
  const [tab, setTab] = useState<'holdings' | 'ledger' | 'closed' | 'audit'>('holdings');
  const [form, setForm] = useState<{ editId?: string; initial?: Draft } | null>(null);
  const [importing, setImporting] = useState(false);
  const [q, setQ] = useState('');
  const [showVoid, setShowVoid] = useState(false);
  const t = pf.totals;

  const holdCols: Col<Holding>[] = [
    { key: 'symbol', header: 'Symbol', sort: (h) => h.symbol, cell: (h) => <span><b>{h.symbol}</b> <span className="text-xs text-mute">{pf.sectorOf(h.symbol)}</span></span> },
    { key: 'qty', header: 'Shares', align: 'right', sort: (h) => h.qty, cell: (h) => npr(h.qty) },
    { key: 'avg', header: 'Avg cost', align: 'right', sort: (h) => h.avgCost, cell: (h) => npr(h.avgCost, 2) },
    { key: 'ltp', header: 'LTP', align: 'right', sort: (h) => h.ltp, cell: (h) => {
      if (!h.ltp) return <span className="text-warn" title="No price in the market data for this symbol in the last 45 days. Check the symbol; it may be suspended, merged or delisted.">no price</span>;
      const row = m.rowMap[h.symbol];
      return row?.carried
        ? <span title={`No trade yet in the latest session. This is the closing price of ${row.asOf}.`}>{npr(h.ltp, 1)} <span className="text-xs text-mute">({shortDate(row.asOf)})</span></span>
        : npr(h.ltp, 1);
    } },
    { key: 'cost', header: 'Cost', align: 'right', sort: (h) => h.cost, cell: (h) => npr(h.cost) },
    { key: 'value', header: 'Market value', align: 'right', sort: (h) => h.value, cell: (h) => npr(h.value) },
    { key: 'unreal', header: 'Unrealized P/L', align: 'right', sort: (h) => h.unrealized, cell: (h) => <span className={tone(h.unrealized)}>{npr(h.unrealized)} <span className="text-xs">({pct(h.unrealizedPct, 1)})</span></span> },
    { key: 'weight', header: 'Weight', align: 'right', sort: (h) => pf.weightOf[h.symbol], cell: (h) => (pf.weightOf[h.symbol] ? `${pf.weightOf[h.symbol].toFixed(1)}%` : '—') },
    { key: 'net', header: 'Net if sold', align: 'right', sort: (h) => h.sellNow?.profit, cell: (h) => (h.sellNow ? <span className={tone(h.sellNow.profit)} title={`Net proceeds Rs ${npr(h.sellNow.netProceeds)} after charges and Rs ${npr(h.sellNow.cgt)} CGT`}>{npr(h.sellNow.profit)}</span> : '—') },
    { key: 'action', header: 'Signal', sort: (h) => pf.advice[h.symbol]?.action, cell: (h) => <Badge>{pf.advice[h.symbol]?.action ?? 'WATCH'}</Badge> },
    { key: 'plan', header: 'Target / Stop', cell: (h) => (
      <span className="flex gap-1" onClick={(e) => e.stopPropagation()}>
        <input className="input !w-20 !py-0.5 text-right" type="number" placeholder="target" defaultValue={state.plans[h.symbol]?.target ?? ''} onBlur={(e) => setPlan(h.symbol, { target: e.target.value ? Number(e.target.value) : null })} />
        <input className="input !w-20 !py-0.5 text-right" type="number" placeholder="stop" defaultValue={state.plans[h.symbol]?.stop ?? ''} onBlur={(e) => setPlan(h.symbol, { stop: e.target.value ? Number(e.target.value) : null })} />
      </span>) },
  ];

  const ledger = useMemo(() => state.transactions.filter((x) => (showVoid || !x.voided) && (!q || x.symbol.includes(q.toUpperCase())))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt ?? '').localeCompare(a.createdAt ?? '')), [state.transactions, q, showVoid]);
  const errIds = new Set(pf.errors.map((e) => e.id));
  const ledgerCols: Col<Txn>[] = [
    { key: 'date', header: 'Date', sort: (x) => x.date, cell: (x) => x.date },
    { key: 'symbol', header: 'Symbol', sort: (x) => x.symbol, cell: (x) => <b>{x.symbol}</b> },
    { key: 'type', header: 'Type', sort: (x) => x.type, cell: (x) => <Badge kind={x.type === 'SELL' ? 'SELL' : x.type === 'BUY' ? 'BUY' : 'HOLD'}>{x.type}</Badge> },
    { key: 'qty', header: 'Qty', align: 'right', sort: (x) => x.qty, cell: (x) => npr(x.qty) },
    { key: 'price', header: 'Price', align: 'right', sort: (x) => x.price, cell: (x) => npr(x.price, 2) },
    { key: 'amount', header: 'Amount', align: 'right', sort: (x) => x.qty * x.price, cell: (x) => npr(x.qty * x.price) },
    { key: 'charges', header: 'Charges', cell: (x) => <span className="text-xs text-mute">{[x.commission, x.sebon, x.dp, x.cgt].some((v) => v !== null && v !== undefined) ? 'manual override' : 'auto'}</span> },
    { key: 'notes', header: 'Notes', className: '!whitespace-normal max-w-xs', cell: (x) => <span className="text-xs text-mute">{x.broker ? `${x.broker} · ` : ''}{x.notes ?? ''}{x.supersedes ? ' (correction)' : ''}</span> },
    { key: 'status', header: 'Status', cell: (x) => (x.voided ? <Badge kind="Unknown">VOID</Badge> : errIds.has(x.id) ? <Badge kind="SELL">REJECTED</Badge> : <Badge kind="Low">ACTIVE</Badge>) },
    { key: 'act', header: '', cell: (x) => (x.voided
      ? <button className="btn !px-2 !py-0.5" onClick={() => restoreTxn(x.id)}>Restore</button>
      : <span className="flex gap-1">
        <button className="btn !px-2 !py-0.5" onClick={() => setForm({ editId: x.id, initial: { date: x.date, symbol: x.symbol, type: x.type, qty: String(x.qty), price: String(x.price), commission: x.commission?.toString() ?? '', sebon: x.sebon?.toString() ?? '', dp: x.dp?.toString() ?? '', cgt: x.cgt?.toString() ?? '', other: x.other?.toString() ?? '', broker: x.broker ?? '', notes: x.notes ?? '' } })}>Correct</button>
        <button className="btn btn-danger !px-2 !py-0.5" onClick={() => { const r = window.prompt(`Void ${x.type} ${x.qty} ${x.symbol}? It stays in the audit trail. Reason:`, ''); if (r !== null) voidTxn(x.id, r); }}>Void</button>
      </span>) },
  ];
  const closed = pf.holdings.filter((h) => h.realized !== 0 || h.dividendNet !== 0);

  const exportAll = () => exportXlsx(`nepse-portfolio-${todayNPT()}.xlsx`, {
    Holdings: pf.held.map((h) => ({ Symbol: h.symbol, Sector: pf.sectorOf(h.symbol), Shares: h.qty, 'Avg cost': +h.avgCost.toFixed(2), LTP: h.ltp ?? '', Cost: +h.cost.toFixed(2), 'Market value': h.value ?? '', 'Unrealized P/L': h.unrealized ?? '', 'Unrealized %': h.unrealizedPct ?? '', 'Realized P/L': +h.realized.toFixed(2), 'Dividends (net)': +h.dividendNet.toFixed(2), 'Net proceeds if sold': h.sellNow?.netProceeds ?? '', Signal: pf.advice[h.symbol]?.action ?? '' })),
    Summary: [{ 'Investment cost': t.cost, 'Market value': t.value, 'Unrealized P/L': t.unrealized, 'Realized P/L': t.realized, 'Dividends net': t.dividendNet, 'Net return': t.netReturn, 'Brokerage': t.commission, 'SEBON': t.sebon, 'DP': t.dp, 'CGT': t.cgt, 'Cost basis method': pf.options.method, 'Price date': '' }],
    Transactions: txnsToRows(state.transactions),
  });

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-lg font-semibold">My Portfolio</h1>
        <button className="btn btn-primary" onClick={() => setForm({})}>+ Add transaction</button>
        <button className="btn" onClick={() => setImporting(true)}>Import Excel / CSV</button>
        <button className="btn" onClick={exportAll} disabled={!state.transactions.length}>Export Excel</button>
        <button className="btn no-print" onClick={() => window.print()}>Print / PDF report</button>
      </div>
      {pf.errors.map((e) => <Banner key={`${e.id}${e.message}`} level="bad"><b>{e.symbol} {e.date}:</b> {e.message}. This transaction is excluded until corrected.</Banner>)}
      <Card right={<Tabs value={tab} onChange={setTab} options={[{ value: 'holdings', label: `Holdings (${pf.held.length})` }, { value: 'ledger', label: `Transactions (${state.transactions.filter((x) => !x.voided).length})` }, { value: 'closed', label: 'Realized & dividends' }, { value: 'audit', label: 'Audit trail' }]} />}
        title={tab === 'holdings' ? `Cost basis: ${pf.options.method === 'WACC' ? 'weighted average' : 'FIFO'} · bonus at Rs ${pf.options.bonusCostBasis}` : ''}>
        {tab === 'holdings' && (
          <>
            <DataTable rows={pf.held} cols={holdCols} rowKey={(h) => h.symbol} initialSort={{ key: 'value', dir: -1 }} onRow={(h) => open(h.symbol)} empty="No holdings yet. Add or import transactions." />
            {pf.held.length > 0 && <div className="num mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-line pt-3 text-sm">
              <span>Cost <b>Rs {npr(t.cost)}</b></span><span>Value <b>Rs {npr(t.value)}</b></span>
              <span className={tone(t.unrealized)}>Unrealized <b>Rs {npr(t.unrealized)} ({pct(t.unrealizedPct)})</b></span>
              <span>Net if all sold today <b>Rs {npr(t.netIfSold)}</b></span>
            </div>}
          </>
        )}
        {tab === 'ledger' && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <input className="input max-w-xs" placeholder="Filter by symbol…" value={q} onChange={(e) => setQ(e.target.value)} />
              <label className="flex items-center gap-2 text-sm text-mute"><input type="checkbox" checked={showVoid} onChange={(e) => setShowVoid(e.target.checked)} /> Show voided</label>
            </div>
            <DataTable rows={ledger} cols={ledgerCols} rowKey={(x) => x.id} pageSize={25} empty="No transactions." />
          </>
        )}
        {tab === 'closed' && (
          <DataTable rows={closed} rowKey={(h) => h.symbol} initialSort={{ key: 'realized', dir: -1 }} empty="No sales or dividends recorded yet." cols={[
            { key: 'symbol', header: 'Symbol', sort: (h) => h.symbol, cell: (h) => <b>{h.symbol}</b> },
            { key: 'realized', header: 'Realized P/L (after charges & CGT)', align: 'right', sort: (h) => h.realized, cell: (h) => <span className={tone(h.realized)}>{npr(h.realized, 2)}</span> },
            { key: 'cgt', header: 'CGT paid', align: 'right', sort: (h) => h.fees.cgt, cell: (h) => npr(h.fees.cgt, 2) },
            { key: 'divg', header: 'Dividend (gross)', align: 'right', sort: (h) => h.dividendGross, cell: (h) => npr(h.dividendGross, 2) },
            { key: 'divt', header: 'Dividend tax', align: 'right', cell: (h) => npr(h.dividendTax, 2) },
            { key: 'divn', header: 'Dividend (net)', align: 'right', sort: (h) => h.dividendNet, cell: (h) => npr(h.dividendNet, 2) },
            { key: 'bonus', header: 'Bonus shares', align: 'right', cell: (h) => npr(h.bonusQty) },
            { key: 'right', header: 'Right shares', align: 'right', cell: (h) => npr(h.rightQty) },
          ]} />
        )}
        {tab === 'audit' && (
          <DataTable rows={[...state.audit].reverse()} rowKey={(a) => `${a.at}${a.detail}`} pageSize={25} empty="No changes recorded yet." cols={[
            { key: 'at', header: 'When', cell: (a) => fmtTime(a.at) }, { key: 'action', header: 'Action', cell: (a) => <Badge kind={a.action === 'VOID' ? 'SELL' : 'HOLD'}>{a.action}</Badge> },
            { key: 'detail', header: 'Detail', className: '!whitespace-normal', cell: (a) => a.detail },
          ]} />
        )}
      </Card>
      {form && <Modal title={form.editId ? 'Correct transaction' : 'Add transaction'} onClose={() => setForm(null)} wide><TxnForm initial={form.initial} editId={form.editId} onDone={() => setForm(null)} /></Modal>}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </>
  );
}
