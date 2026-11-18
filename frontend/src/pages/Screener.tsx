import { useMemo, useState } from 'react';
import { useOpenStock } from '../App';
import { Badge, Card, DataTable, Empty, ScoreBar, type Col } from '../components/ui';
import { useMarket, type StockAnalysis } from '../lib/data';
import { compact, download, npr, num, pct, toCsv, todayNPT, tone } from '../lib/format';
import { qualityWith, stanceOf } from '../lib/recommend';
import { useStore } from '../lib/store';

type Row = StockAnalysis & { q: number | null; action: string };

export default function Screener() {
  const m = useMarket();
  const { state } = useStore();
  const open = useOpenStock();
  const [q, setQ] = useState('');
  const [sector, setSector] = useState('');
  const [action, setAction] = useState('');
  const [risk, setRisk] = useState('');
  const [cat, setCat] = useState('');
  const [maxPe, setMaxPe] = useState('');
  const [minRoe, setMinRoe] = useState('');
  const [minYield, setMinYield] = useState('');

  const all: Row[] = useMemo(() => Object.values(m.analysis?.stocks ?? {}).map((a) => {
    const qq = qualityWith(a, state.settings.weights);
    return { ...a, q: qq, action: stanceOf(a, qq, m.analysis!.thresholds) };
  }), [m.analysis, state.settings.weights]);
  const sectors = useMemo(() => [...new Set(all.map((a) => a.sector ?? 'Unknown'))].sort(), [all]);
  const rows = all.filter((a) => (!q || a.symbol.includes(q.toUpperCase()) || (a.name ?? '').toLowerCase().includes(q.toLowerCase()))
    && (!sector || (a.sector ?? 'Unknown') === sector) && (!action || a.action === action) && (!risk || a.risk.level === risk)
    && (!cat || a.categories.includes(cat))
    && (!maxPe || (a.valuation.pe !== null && a.valuation.pe !== undefined && a.valuation.pe <= Number(maxPe)))
    && (!minRoe || (a.fundamentals?.roe ?? -999) >= Number(minRoe))
    && (!minYield || (a.valuation.divYield ?? 0) >= Number(minYield)));

  const cols: Col<Row>[] = [
    { key: 'symbol', header: 'Symbol', sort: (a) => a.symbol, cell: (a) => <span title={a.name ?? ''}><b>{a.symbol}</b></span> },
    { key: 'sector', header: 'Sector', sort: (a) => a.sector, cell: (a) => <span className="text-xs text-mute">{a.sector}</span> },
    { key: 'price', header: 'LTP', align: 'right', sort: (a) => a.price, cell: (a) => npr(a.price, 1) },
    { key: 'chg', header: 'Day', align: 'right', sort: (a) => a.pctChange, cell: (a) => <span className={tone(a.pctChange)}>{pct(a.pctChange)}</span> },
    { key: 'action', header: 'Signal', sort: (a) => a.action, cell: (a) => <Badge>{a.action}</Badge> },
    { key: 'q', header: 'Quality', sort: (a) => a.q, cell: (a) => <ScoreBar value={a.q} /> },
    { key: 'trading', header: 'Trading', sort: (a) => a.trading, cell: (a) => <ScoreBar value={a.trading} /> },
    { key: 'risk', header: 'Risk', sort: (a) => a.risk.score, cell: (a) => <Badge>{a.risk.level ?? 'Unknown'}</Badge> },
    { key: 'pe', header: 'P/E', align: 'right', sort: (a) => a.valuation.pe, cell: (a) => num(a.valuation.pe, 1) },
    { key: 'pb', header: 'P/B', align: 'right', sort: (a) => a.valuation.pb, cell: (a) => num(a.valuation.pb) },
    { key: 'eps', header: 'EPS', align: 'right', sort: (a) => a.fundamentals?.eps, cell: (a) => num(a.fundamentals?.eps, 1) },
    { key: 'roe', header: 'ROE %', align: 'right', sort: (a) => a.fundamentals?.roe, cell: (a) => num(a.fundamentals?.roe, 1) },
    { key: 'dy', header: 'Yield %', align: 'right', sort: (a) => a.valuation.divYield, cell: (a) => num(a.valuation.divYield, 1) },
    { key: 'rsi', header: 'RSI', align: 'right', sort: (a) => a.tech.rsi14, cell: (a) => num(a.tech.rsi14, 0) },
    { key: 'm1', header: '1M', align: 'right', sort: (a) => a.tech.ret1m, cell: (a) => <span className={tone(a.tech.ret1m)}>{pct(a.tech.ret1m, 1)}</span> },
    { key: 'to', header: 'Avg turnover', align: 'right', sort: (a) => a.tech.avgTurnover20, cell: (a) => compact(a.tech.avgTurnover20) },
    { key: 'conf', header: 'Conf.', align: 'right', sort: (a) => a.confidence, cell: (a) => <span className={a.incomplete ? 'text-warn' : ''}>{a.confidence.toFixed(0)}</span> },
  ];
  const exportCsv = () => download(`nepse-screener-${todayNPT()}.csv`, toCsv(rows.map((a) => ({ Symbol: a.symbol, Name: a.name, Sector: a.sector, LTP: a.price, 'Day %': a.pctChange, Signal: a.action, Quality: a.q?.toFixed(1), Trading: a.trading, 'Risk level': a.risk.level, 'P/E': a.valuation.pe, 'P/B': a.valuation.pb, EPS: a.fundamentals?.eps, 'ROE %': a.fundamentals?.roe, 'Div yield %': a.valuation.divYield, RSI: a.tech.rsi14, '1M %': a.tech.ret1m, Confidence: a.confidence, Categories: a.categories.join(' ') }))), 'text/csv');

  if (!m.analysis) return <Empty>{m.loading ? 'Loading…' : 'Analysis data is not available yet. Run the pipeline.'}</Empty>;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Stock Screener</h1>
        <span className="text-xs text-mute">{m.analysis.coverage.stocks} stocks analysed · {m.analysis.coverage.withFundamentals} with fundamentals · market date {m.analysis.marketDate}</span>
      </div>
      <Card>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
          <input className="input" placeholder="Search symbol or name…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input" value={sector} onChange={(e) => setSector(e.target.value)}><option value="">All sectors</option>{sectors.map((s) => <option key={s}>{s}</option>)}</select>
          <select className="input" value={action} onChange={(e) => setAction(e.target.value)}><option value="">All signals</option>{['BUY', 'ACCUMULATE', 'HOLD', 'REDUCE', 'SELL', 'WATCH'].map((s) => <option key={s}>{s}</option>)}</select>
          <select className="input" value={risk} onChange={(e) => setRisk(e.target.value)}><option value="">All risk levels</option>{['Low', 'Medium', 'High'].map((s) => <option key={s}>{s}</option>)}</select>
          <select className="input" value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All screens</option>{Object.entries(m.analysis.categories).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <input className="input" type="number" placeholder="Max P/E" value={maxPe} onChange={(e) => setMaxPe(e.target.value)} />
          <input className="input" type="number" placeholder="Min ROE %" value={minRoe} onChange={(e) => setMinRoe(e.target.value)} />
          <input className="input" type="number" placeholder="Min div. yield %" value={minYield} onChange={(e) => setMinYield(e.target.value)} />
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-sm text-mute">{rows.length} match(es)</span>
          <button className="btn" onClick={exportCsv}>Export CSV</button>
        </div>
        <div className="mt-3"><DataTable rows={rows} cols={cols} rowKey={(a) => a.symbol} initialSort={{ key: 'q', dir: -1 }} onRow={(a) => open(a.symbol)} pageSize={40} /></div>
      </Card>
    </>
  );
}
