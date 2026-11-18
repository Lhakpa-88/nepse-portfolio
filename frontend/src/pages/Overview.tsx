import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, LineChart, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useOpenStock } from '../App';
import { Badge, Banner, Card, chartColors, Empty, Kpi, tooltipStyle } from '../components/ui';
import { useHistories, useMarket, type PriceRow } from '../lib/data';
import { DEMO_PLANS, DEMO_TXNS, DEMO_WATCH } from '../lib/demo';
import { compact, npr, num, pct, tone } from '../lib/format';
import { portfolioSeries, riskReport } from '../lib/risk';
import { uid, useStore } from '../lib/store';
import { usePortfolio } from '../lib/usePortfolio';

function Movers({ title, rows, metric }: { title: string; rows: PriceRow[]; metric: 'pct' | 'turnover' }) {
  const open = useOpenStock();
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-mute">{title}</div>
      {rows.map((r) => (
        <button key={r.symbol} onClick={() => open(r.symbol)} className="num flex w-full items-center justify-between rounded px-1.5 py-1 text-sm hover:bg-accent/10">
          <span className="font-medium">{r.symbol}</span>
          <span className="text-mute">{npr(r.ltp, 1)}</span>
          <span className={`w-20 text-right ${metric === 'pct' ? tone(r.pctChange) : ''}`}>{metric === 'pct' ? pct(r.pctChange) : compact(r.turnover)}</span>
        </button>
      ))}
    </div>
  );
}

export default function Overview() {
  const m = useMarket();
  const { state, setState } = useStore();
  const pf = usePortfolio();
  const open = useOpenStock();
  const c = chartColors();
  const tt = tooltipStyle();
  const t = pf.totals;

  const allSymbols = useMemo(() => [...new Set(state.transactions.filter((x) => !x.voided).map((x) => x.symbol))], [state.transactions]);
  const hist = useHistories(useMemo(() => [...allSymbols, 'NEPSE'], [allSymbols]));
  const series = useMemo(() => (hist ? portfolioSeries(state.transactions, state.settings.fees, state.settings.engine, hist, hist.NEPSE ?? []) : []), [hist, state.transactions, state.settings.fees, state.settings.engine]);
  const risk = useMemo(() => riskReport(pf.held, pf.sectorOf, hist ?? {}, hist?.NEPSE ?? [], (s) => m.analysis?.stocks[s]?.tech.avgTurnover20 ?? null, state.settings.concentrationPct), [pf.held, hist, m.analysis, state.settings.concentrationPct]);
  const monthly = useMemo(() => {
    const byMonth = new Map<string, number>();
    let prev = series[0]?.pnl ?? 0;
    series.forEach((p, i) => { if (i === 0) return; byMonth.set(p.date.slice(0, 7), (byMonth.get(p.date.slice(0, 7)) ?? 0) + (p.pnl - prev)); prev = p.pnl; });
    return [...byMonth.entries()].map(([month, pnl]) => ({ month, pnl }));
  }, [series]);

  const rows = (m.prices?.rows ?? []).filter((r) => m.analysis?.stocks[r.symbol]);
  const gainers = [...rows].sort((a, b) => (b.pctChange ?? -99) - (a.pctChange ?? -99)).slice(0, 5);
  const losers = [...rows].sort((a, b) => (a.pctChange ?? 99) - (b.pctChange ?? 99)).slice(0, 5);
  const traded = [...rows].sort((a, b) => (b.turnover ?? 0) - (a.turnover ?? 0)).slice(0, 5);
  const sectors = (m.market?.sectors ?? []).filter((s) => s.pctChange !== null).map((s) => ({ name: s.name, pct: s.pctChange as number })).sort((a, b) => b.pct - a.pct);
  const sum = m.market?.summary ?? {};
  const regime = m.analysis?.regime;
  const idle = pf.held.filter((h) => m.rowMap[h.symbol]?.carried).map((h) => h.symbol);

  const loadDemo = () => setState((s) => ({ ...s, demo: true, transactions: DEMO_TXNS.map((x) => ({ ...x, id: uid(), createdAt: new Date().toISOString() })), watchlist: DEMO_WATCH, plans: DEMO_PLANS,
    audit: [...s.audit, { at: new Date().toISOString(), action: 'DEMO', detail: 'DEMO sample portfolio loaded' }] }));

  const stockBars = pf.held.filter((h) => h.value).map((h) => ({ symbol: h.symbol, cost: Math.round(h.cost), value: Math.round(h.value!) }));
  const contrib = pf.holdings.map((h) => ({ symbol: h.symbol, total: Math.round((h.unrealized ?? 0) + h.realized + h.dividendNet) })).filter((x) => x.total !== 0).sort((a, b) => b.total - a.total);
  const realVsUnreal = [{ name: 'Realized', v: Math.round(t.realized) }, { name: 'Unrealized', v: Math.round(t.unrealized) }, { name: 'Dividends', v: Math.round(t.dividendNet) }];

  return (
    <>
      {pf.errors.length > 0 && <Banner level="bad"><b>{pf.errors.length} transaction(s) could not be applied</b> and are excluded from all figures: {pf.errors.slice(0, 3).map((e) => `${e.symbol} ${e.date}: ${e.message}`).join(' · ')}. Fix them in <Link className="underline" to="/portfolio">My Portfolio</Link>.</Banner>}
      {t.unpricedCost > 0 && <Banner level="warn">Holdings costing Rs {npr(t.unpricedCost)} have no market price in the last 45 days and are excluded from market value and unrealized P/L (not estimated).</Banner>}
      {idle.length > 0 && <Banner level="info">{idle.length === 1 ? '1 of your holdings has' : `${idle.length} of your holdings have`} not traded yet in the latest session ({idle.join(', ')}) and {idle.length === 1 ? 'is' : 'are'} valued at the last closing price.</Banner>}

      {allSymbols.length === 0 ? (
        <Card title="Welcome — your portfolio is empty">
          <p className="text-sm text-mute">Your transactions are stored privately in this browser. Add them manually, import an Excel/CSV file, or load a DEMO portfolio to explore every feature with real market prices.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link className="btn btn-primary" to="/portfolio">Add or import transactions</Link>
            <button className="btn" onClick={loadDemo}>Load DEMO portfolio</button>
          </div>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            <Kpi label="Current market value" value={`Rs ${npr(t.value)}`} sub={<span className={tone(pf.dayChange.amount)}>Today {npr(pf.dayChange.amount)} ({pct(pf.dayChange.pct)})</span>} />
            <Kpi label="Investment cost" value={`Rs ${npr(t.cost)}`} sub="Cost of shares still held, incl. charges" />
            <Kpi label="Unrealized P/L" value={`Rs ${npr(t.unrealized)}`} delta={t.unrealized} sub={pct(t.unrealizedPct)} />
            <Kpi label="Realized P/L" value={`Rs ${npr(t.realized)}`} delta={t.realized} sub={`After charges and Rs ${npr(t.cgt)} CGT`} />
            <Kpi label="Dividends received" value={`Rs ${npr(t.dividendNet)}`} sub={`Net of Rs ${npr(t.dividendTax)} tax`} />
            <Kpi label="Net portfolio return" value={`Rs ${npr(t.netReturn)}`} delta={t.netReturn} sub={`${pct(t.netReturnPct)} on Rs ${npr(t.totalBuyCost)} invested to date`} hint="Realized + unrealized + net dividends. Charges are already inside these figures, so nothing is counted twice." />
            <Kpi label="Stocks held" value={t.holdingCount} sub={`${risk.sectors.length} sector(s)`} />
            <Kpi label="Charges paid" value={`Rs ${npr(t.fees)}`} sub={`Brokerage ${npr(t.commission)} · SEBON ${npr(t.sebon)} · DP ${npr(t.dp)}`} />
            <Kpi label="Bonus / right shares" value={`${npr(t.bonusQty)} / ${npr(t.rightQty)}`} sub="Shares received" />
            <Kpi label="Cash available" value={state.settings.cash ? `Rs ${npr(state.settings.cash)}` : 'Not set'} sub={<Link to="/settings" className="underline">Set in Settings</Link>} />
            <Kpi label="Diversification" value={`${risk.diversification}/100`} sub={`Effective stocks ${num(risk.effectiveStocks, 1)}`} hint="50% from effective number of stocks (target 8), 50% from effective number of sectors (target 4)." />
            <Kpi label="Largest position" value={risk.weights[0] ? `${risk.weights[0].symbol} ${num(risk.weights[0].pct, 0)}%` : '—'} sub={`Limit ${state.settings.concentrationPct}%`} delta={risk.weights[0] && risk.weights[0].pct > state.settings.concentrationPct ? -1 : undefined} />
          </div>

          <Card title={`Needs your attention (${pf.attention.length})`} right={<Link to="/buy-sell" className="text-xs text-accent underline">All recommendations</Link>}>
            {pf.attention.length === 0 ? <div className="text-sm text-mute">Nothing urgent. No holding has an active sell signal, breached level or concentration warning.</div> : (
              <div className="space-y-2">
                {pf.attention.slice(0, 6).map((a) => (
                  <button key={a.symbol} onClick={() => open(a.symbol)} className="flex w-full flex-wrap items-start gap-x-3 gap-y-1 rounded-md border border-line px-3 py-2 text-left hover:border-accent">
                    <span className="w-16 font-semibold">{a.symbol}</span><Badge>{a.action}</Badge>
                    <span className="min-w-0 flex-1 text-sm text-mute">{a.flags[0]?.text ?? a.suggested}</span>
                    <span className="text-xs text-mute">Review: {a.review}</span>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      <Card title="Market overview" right={<span className="text-xs text-mute">{m.prices ? `Market date ${m.prices.marketDate} · source ${m.prices.source} (unofficial)` : ''}</span>}>
        {!m.prices ? <Empty>{m.loading ? 'Loading…' : m.error}</Empty> : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
              {(m.market?.main ?? []).slice(0, 4).map((i) => (
                <Kpi key={i.name} label={i.name} value={num(i.value)} delta={i.pctChange} sub={<span className={tone(i.pctChange)}>{num(i.change)} ({pct(i.pctChange)})</span>} />
              ))}
              <Kpi label="Turnover" value={`Rs ${compact(sum.turnover)}`} sub={`${npr(sum.transactions)} transactions`} />
              <Kpi label="Volume" value={compact(sum.volume)} sub={`${npr(sum.scripsTraded)} scrips traded`} />
              <Kpi label="Market trend" value={regime?.label ?? 'Unknown'} sub={m.market?.breadth ? `${m.market.breadth.advancers} up · ${m.market.breadth.decliners} down` : ''}
                hint="From NEPSE vs its 20/50/200-day averages, 1-month momentum and today's breadth." />
            </div>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
              <Movers title="Top gainers" rows={gainers} metric="pct" />
              <Movers title="Top losers" rows={losers} metric="pct" />
              <Movers title="Most traded (turnover)" rows={traded} metric="turnover" />
            </div>
            {sectors.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-mute">Sector indices today (%)</div>
                <div className="h-56">
                  <ResponsiveContainer>
                    <BarChart data={sectors} margin={{ left: 0, right: 5, top: 5, bottom: 40 }}>
                      <CartesianGrid stroke={c.line} strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 10, fill: c.mute }} interval={0} angle={-30} textAnchor="end" />
                      <YAxis tick={{ fontSize: 11, fill: c.mute }} width={35} />
                      <Tooltip {...tt} formatter={(v: number) => [`${v.toFixed(2)}%`, 'Change']} />
                      <ReferenceLine y={0} stroke={c.mute} />
                      <Bar dataKey="pct" isAnimationActive={false}>{sectors.map((s) => <Cell key={s.name} fill={s.pct >= 0 ? c.up : c.down} />)}</Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      {allSymbols.length > 0 && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card title="Portfolio value over time" right={<span className="text-xs text-mute">{series.length ? `${series[0].date} → ${series[series.length - 1].date}` : ''}</span>}>
            {!hist ? <Empty>Loading price history…</Empty> : series.length < 2 ? <Empty>Not enough price history yet to chart value over time.</Empty> : (
              <>
                <div className="h-64">
                  <ResponsiveContainer>
                    <ComposedChart data={series} margin={{ left: 0, right: 5, top: 5 }}>
                      <CartesianGrid stroke={c.line} strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="date" tick={{ fontSize: 11, fill: c.mute }} minTickGap={50} />
                      <YAxis tick={{ fontSize: 11, fill: c.mute }} width={60} tickFormatter={(v) => compact(v)} domain={['auto', 'auto']} />
                      <Tooltip {...tt} formatter={(v: number, n: string) => [`Rs ${npr(v)}`, n]} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Area name="Market value" dataKey="value" stroke={c.accent} fill={c.accent} fillOpacity={0.1} strokeWidth={2} isAnimationActive={false} />
                      <Line name="Cost of holdings" dataKey="cost" stroke={c.mute} strokeDasharray="4 4" dot={false} isAnimationActive={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-1 text-xs text-mute">Built from your transactions and real daily closes. Free sources provide roughly one year of history, so earlier periods are not shown{series.some((p) => p.unpriced > 0) ? '; holdings without a price on a date are carried at cost' : ''}.</div>
              </>
            )}
          </Card>
          <Card title="Time-weighted return vs NEPSE (%)">
            {series.length < 2 ? <Empty>Not enough history.</Empty> : (
              <div className="h-64">
                <ResponsiveContainer>
                  <LineChart data={series} margin={{ left: 0, right: 5, top: 5 }}>
                    <CartesianGrid stroke={c.line} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: c.mute }} minTickGap={50} />
                    <YAxis tick={{ fontSize: 11, fill: c.mute }} width={40} />
                    <Tooltip {...tt} formatter={(v: number, n: string) => [`${v.toFixed(2)}%`, n]} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <ReferenceLine y={0} stroke={c.mute} />
                    <Line name="My portfolio (TWR)" dataKey="twr" stroke={c.accent} dot={false} strokeWidth={2} isAnimationActive={false} />
                    <Line name="NEPSE index" dataKey="nepse" stroke="#fbbf24" dot={false} strokeWidth={1.5} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>
          <Card title="Investment vs current market value">
            {stockBars.length === 0 ? <Empty>No priced holdings.</Empty> : (
              <div className="h-64">
                <ResponsiveContainer>
                  <BarChart data={stockBars} margin={{ left: 0, right: 5, top: 5 }}>
                    <CartesianGrid stroke={c.line} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="symbol" tick={{ fontSize: 11, fill: c.mute }} />
                    <YAxis tick={{ fontSize: 11, fill: c.mute }} width={60} tickFormatter={(v) => compact(v)} />
                    <Tooltip {...tt} formatter={(v: number, n: string) => [`Rs ${npr(v)}`, n]} cursor={{ fill: c.line, opacity: 0.3 }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar name="Cost" dataKey="cost" fill={c.mute} isAnimationActive={false} />
                    <Bar name="Market value" dataKey="value" fill={c.accent} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>
          <Card title="Monthly profit / loss (realized + mark-to-market + dividends)">
            {monthly.length === 0 ? <Empty>Not enough history.</Empty> : (
              <div className="h-64">
                <ResponsiveContainer>
                  <BarChart data={monthly} margin={{ left: 0, right: 5, top: 5 }}>
                    <CartesianGrid stroke={c.line} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="month" tick={{ fontSize: 11, fill: c.mute }} />
                    <YAxis tick={{ fontSize: 11, fill: c.mute }} width={60} tickFormatter={(v) => compact(v)} />
                    <Tooltip {...tt} formatter={(v: number) => [`Rs ${npr(v)}`, 'P/L']} cursor={{ fill: c.line, opacity: 0.3 }} />
                    <ReferenceLine y={0} stroke={c.mute} />
                    <Bar dataKey="pnl" isAnimationActive={false}>{monthly.map((x) => <Cell key={x.month} fill={x.pnl >= 0 ? c.up : c.down} />)}</Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>
          <Card title="Sector allocation">
            {risk.sectors.length === 0 ? <Empty>No priced holdings.</Empty> : (
              <div className="h-64">
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={risk.sectors} dataKey="value" nameKey="sector" innerRadius="50%" outerRadius="80%" paddingAngle={2} isAnimationActive={false}
                      label={(p: any) => `${p.sector} ${p.pct.toFixed(0)}%`} labelLine={false} fontSize={11}>
                      {risk.sectors.map((s, i) => <Cell key={s.sector} fill={c.series[i % c.series.length]} stroke={c.panel} />)}
                    </Pie>
                    <Tooltip {...tt} formatter={(v: number, n: string) => [`Rs ${npr(v)}`, n]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>
          <Card title="Return by stock, and realized vs unrealized">
            <div className="grid h-64 grid-cols-3 gap-2">
              <div className="col-span-2">
                <ResponsiveContainer>
                  <BarChart data={contrib} layout="vertical" margin={{ left: 10, right: 10 }}>
                    <CartesianGrid stroke={c.line} strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11, fill: c.mute }} tickFormatter={(v) => compact(v)} />
                    <YAxis type="category" dataKey="symbol" tick={{ fontSize: 11, fill: c.mute }} width={55} />
                    <Tooltip {...tt} formatter={(v: number) => [`Rs ${npr(v)}`, 'Total return']} cursor={{ fill: c.line, opacity: 0.3 }} />
                    <ReferenceLine x={0} stroke={c.mute} />
                    <Bar dataKey="total" isAnimationActive={false}>{contrib.map((x) => <Cell key={x.symbol} fill={x.total >= 0 ? c.up : c.down} />)}</Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div>
                <ResponsiveContainer>
                  <BarChart data={realVsUnreal} margin={{ left: 0, right: 0 }}>
                    <XAxis dataKey="name" tick={{ fontSize: 10, fill: c.mute }} interval={0} />
                    <YAxis hide />
                    <Tooltip {...tt} formatter={(v: number) => [`Rs ${npr(v)}`, '']} cursor={{ fill: c.line, opacity: 0.3 }} />
                    <ReferenceLine y={0} stroke={c.mute} />
                    <Bar dataKey="v" isAnimationActive={false}>{realVsUnreal.map((x) => <Cell key={x.name} fill={x.v >= 0 ? c.up : c.down} />)}</Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
