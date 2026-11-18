import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Banner, Card, chartColors, Empty, Kpi, tooltipStyle } from '../components/ui';
import { useHistories, useMarket } from '../lib/data';
import { compact, npr, num, pct, tone } from '../lib/format';
import { portfolioSeries, riskReport, stressTest } from '../lib/risk';
import { useStore } from '../lib/store';
import { usePortfolio } from '../lib/usePortfolio';

const corrColor = (v: number | null) => {
  if (v === null) return 'transparent';
  const a = Math.min(1, Math.abs(v));
  return v >= 0 ? `rgba(248,113,113,${a * 0.75})` : `rgba(52,211,153,${a * 0.75})`;
};

export default function Risk() {
  const m = useMarket();
  const { state } = useStore();
  const pf = usePortfolio();
  const c = chartColors();
  const tt = tooltipStyle();
  const [shock, setShock] = useState(-10);
  const symbols = useMemo(() => [...new Set(state.transactions.filter((x) => !x.voided).map((x) => x.symbol))], [state.transactions]);
  const hist = useHistories(useMemo(() => [...symbols, 'NEPSE'], [symbols]));
  const r = useMemo(() => riskReport(pf.held, pf.sectorOf, hist ?? {}, hist?.NEPSE ?? [], (s) => m.analysis?.stocks[s]?.tech.avgTurnover20 ?? null, state.settings.concentrationPct), [pf.held, hist, m.analysis, state.settings.concentrationPct]);
  const series = useMemo(() => (hist ? portfolioSeries(state.transactions, state.settings.fees, state.settings.engine, hist, hist.NEPSE ?? []) : []), [hist, state.transactions, state.settings.fees, state.settings.engine]);
  const st = useMemo(() => stressTest(pf.held, r.betas, shock), [pf.held, r.betas, shock]);
  if (!pf.held.length) return <><h1 className="text-lg font-semibold">Risk Analysis</h1><Empty>Add holdings to analyse portfolio risk.</Empty></>;

  const last = series[series.length - 1];
  const days = series.length > 1 ? (Date.parse(last.date) - Date.parse(series[0].date)) / 86400000 : 0;
  const deposit = days ? state.settings.depositRatePct * (days / 365) : null;
  const twrVals = series.map((p) => 1 + p.twr / 100);
  let peak = 0, mdd = 0;
  twrVals.forEach((v) => { peak = Math.max(peak, v); if (peak) mdd = Math.min(mdd, v / peak - 1); });
  const sharpe = r.volatility && last && days > 60 ? (((1 + last.twr / 100) ** (365 / days) - 1) * 100 - state.settings.depositRatePct) / r.volatility : null;
  const heldSectors = new Set(r.sectors.map((s) => s.sector));
  const sectorBench = (m.analysis?.sectorPerformance ?? []).filter((s) => heldSectors.has(s.sector));

  return (
    <>
      <h1 className="text-lg font-semibold">Risk Analysis</h1>
      {!hist && <Banner level="info">Loading price history for risk calculations…</Banner>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Kpi label="Diversification score" value={`${r.diversification}/100`} sub={`${num(r.effectiveStocks, 1)} effective stocks · ${num(r.effectiveSectors, 1)} sectors`} hint="50 x min(1, effective stocks / 8) + 50 x min(1, effective sectors / 4), where effective = 1 / sum of squared weights." />
        <Kpi label="Portfolio volatility" value={r.volatility !== null ? `${num(r.volatility, 1)}%` : 'n/a'} sub={`Annualised, current holdings, ${r.window} sessions`} />
        <Kpi label="Max drawdown (holdings)" value={r.maxDrawdown !== null ? `${num(r.maxDrawdown, 1)}%` : 'n/a'} delta={r.maxDrawdown} sub="Current mix over the same window" />
        <Kpi label="Max drawdown (actual)" value={series.length > 1 ? `${num(mdd * 100, 1)}%` : 'n/a'} delta={mdd} sub="Your time-weighted return path" />
        <Kpi label="Beta vs NEPSE" value={num(r.beta)} sub={r.beta !== null ? `Moves ~${num(r.beta * 10, 1)}% per 10% NEPSE move` : 'Needs 20+ sessions'} />
        <Kpi label="Avg correlation" value={num(r.corr.avg)} sub="Between holdings (1 = move together)" />
        <Kpi label="Risk-adjusted return" value={sharpe !== null ? num(sharpe) : 'n/a'} sub={sharpe !== null ? 'Sharpe-style: (annualised TWR − deposit rate) / volatility' : 'Needs 60+ days of history'} />
      </div>

      <Card title="Recommendations to improve diversification">
        <ul className="list-disc space-y-1 pl-5 text-sm">{r.suggestions.map((s) => <li key={s}>{s}</li>)}</ul>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Individual stock concentration">
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={r.weights} layout="vertical" margin={{ left: 10, right: 20 }}>
                <CartesianGrid stroke={c.line} strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11, fill: c.mute }} unit="%" />
                <YAxis type="category" dataKey="symbol" tick={{ fontSize: 11, fill: c.mute }} width={55} />
                <Tooltip {...tt} formatter={(v: number) => [`${v.toFixed(1)}%`, 'Weight']} cursor={{ fill: c.line, opacity: 0.3 }} />
                <ReferenceLine x={state.settings.concentrationPct} stroke={c.warn} strokeDasharray="4 4" label={{ value: 'limit', fontSize: 10, fill: c.warn }} />
                <Bar dataKey="pct" isAnimationActive={false}>{r.weights.map((w) => <Cell key={w.symbol} fill={w.pct > state.settings.concentrationPct ? c.warn : c.accent} />)}</Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="Sector exposure">
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={r.sectors} layout="vertical" margin={{ left: 10, right: 20 }}>
                <CartesianGrid stroke={c.line} strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11, fill: c.mute }} unit="%" />
                <YAxis type="category" dataKey="sector" tick={{ fontSize: 11, fill: c.mute }} width={130} />
                <Tooltip {...tt} formatter={(v: number) => [`${v.toFixed(1)}%`, 'Weight']} cursor={{ fill: c.line, opacity: 0.3 }} />
                <Bar dataKey="pct" isAnimationActive={false}>{r.sectors.map((s, i) => <Cell key={s.sector} fill={c.series[i % c.series.length]} />)}</Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title="Benchmark comparison">
          {series.length < 2 ? <Empty>Not enough history to benchmark.</Empty> : (
            <table className="w-full">
              <thead><tr className="border-b border-line"><th className="th">Since {series[0].date}</th><th className="th text-right">Return</th><th className="th text-right">vs my portfolio</th></tr></thead>
              <tbody className="num">
                <tr className="border-b border-line/50"><td className="td">My portfolio (time-weighted)</td><td className={`td text-right font-semibold ${tone(last.twr)}`}>{pct(last.twr)}</td><td className="td text-right">—</td></tr>
                <tr className="border-b border-line/50"><td className="td">NEPSE Index</td><td className={`td text-right ${tone(last.nepse)}`}>{pct(last.nepse)}</td><td className={`td text-right ${tone(last.nepse !== null ? last.twr - last.nepse : null)}`}>{last.nepse !== null ? pct(last.twr - last.nepse) : '—'}</td></tr>
                <tr className="border-b border-line/50"><td className="td">Fixed deposit at {state.settings.depositRatePct}% p.a.</td><td className="td text-right">{pct(deposit)}</td><td className={`td text-right ${tone(deposit !== null ? last.twr - deposit : null)}`}>{deposit !== null ? pct(last.twr - deposit) : '—'}</td></tr>
                {sectorBench.map((s) => <tr key={s.sector} className="border-b border-line/50"><td className="td">{s.sector} sector (avg of members, last 1 month)</td><td className={`td text-right ${tone(s.avgRet1m)}`}>{pct(s.avgRet1m)}</td><td className="td text-right text-xs text-mute">1-month only</td></tr>)}
              </tbody>
            </table>
          )}
          <div className="mt-2 text-xs text-mute">Time-weighted return strips out the timing of your deposits and withdrawals so it is comparable with an index. Sector index history is not available from the free sources, so sector rows show the average 1-month move of each sector's stocks.</div>
        </Card>

        <Card title="What if NEPSE moves?" right={<span className="num text-sm">{shock > 0 ? '+' : ''}{shock}%</span>}>
          <input type="range" min={-30} max={30} step={1} value={shock} onChange={(e) => setShock(Number(e.target.value))} className="w-full accent-sky-400" />
          <div className="num mt-2 text-sm">Estimated portfolio change: <b className={tone(st.change)}>Rs {npr(st.change)} ({pct(st.pct, 1)})</b> → about Rs {npr(st.value + st.change)}</div>
          <div className="mt-2 max-h-44 overflow-y-auto">
            <table className="w-full"><thead><tr className="border-b border-line"><th className="th">Stock</th><th className="th text-right">Beta</th><th className="th text-right">Est. move</th><th className="th text-right">Est. change</th></tr></thead>
              <tbody className="num">{st.rows.map((x) => <tr key={x.symbol} className="border-b border-line/50"><td className="td">{x.symbol}</td><td className="td text-right">{x.assumed ? <span className="text-warn" title="Not enough history; beta of 1 assumed">1.00*</span> : num(x.beta)}</td><td className={`td text-right ${tone(x.movePct)}`}>{pct(x.movePct, 1)}</td><td className={`td text-right ${tone(x.change)}`}>{npr(x.change)}</td></tr>)}</tbody></table>
          </div>
          <div className="mt-2 text-xs text-mute">Estimate, not a forecast: each stock is assumed to move by its historical beta x the index move. In a real sell-off, correlations rise and thinly traded stocks can fall further. * = beta assumed.</div>
        </Card>

        <Card title="Correlation between holdings (daily returns)">
          {r.corr.symbols.length < 2 ? <Empty>Needs at least two holdings.</Empty> : (
            <div className="overflow-x-auto">
              <table className="num border-collapse text-xs">
                <thead><tr><th />{r.corr.symbols.map((s) => <th key={s} className="px-1.5 py-1 font-medium text-mute">{s}</th>)}</tr></thead>
                <tbody>{r.corr.matrix.map((row, i) => (
                  <tr key={r.corr.symbols[i]}><th className="pr-2 text-right font-medium text-mute">{r.corr.symbols[i]}</th>
                    {row.map((v, j) => <td key={j} className="h-9 w-12 border border-line text-center" style={{ background: i === j ? 'transparent' : corrColor(v) }}>{v === null ? 'n/a' : v.toFixed(2)}</td>)}</tr>))}</tbody>
              </table>
              <div className="mt-2 text-xs text-mute">Red = move together (less diversification), green = move opposite. n/a = fewer than 20 common sessions.</div>
            </div>
          )}
        </Card>
        <Card title="Liquidity analysis">
          <table className="w-full"><thead><tr className="border-b border-line"><th className="th">Stock</th><th className="th text-right">Position value</th><th className="th text-right">Avg daily turnover (20d)</th><th className="th text-right">Days to exit*</th></tr></thead>
            <tbody className="num">{r.liquidity.map((l) => <tr key={l.symbol} className="border-b border-line/50"><td className="td">{l.symbol}</td><td className="td text-right">{npr(l.value)}</td><td className="td text-right">{compact(l.avgTurnover)}</td><td className={`td text-right ${l.daysToExit !== null && l.daysToExit > 5 ? 'text-warn' : ''}`}>{l.daysToExit === null ? 'n/a' : l.daysToExit < 1 ? '< 1' : l.daysToExit.toFixed(1)}</td></tr>)}</tbody></table>
          <div className="mt-2 text-xs text-mute">* Trading days needed to sell the whole position if you are at most 10% of the stock's average daily turnover.</div>
        </Card>
      </div>
    </>
  );
}
