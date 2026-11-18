import { useEffect, useMemo, useState } from 'react';
import { Area, Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { loadHistory, shortDate, useMarket, type HistRow, type Scored } from '../lib/data';
import { fmtTime, npr, num, pct, tone } from '../lib/format';
import { adviseProspect } from '../lib/recommend';
import { useStore } from '../lib/store';
import { usePortfolio } from '../lib/usePortfolio';
import { Badge, Banner, Card, chartColors, Modal, ScoreBar, tooltipStyle } from './ui';

function sma(rows: HistRow[], n: number, i: number) {
  if (i + 1 < n) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k += 1) s += rows[k][4];
  return s / n;
}

const LABELS: Record<string, string> = {
  earnings: 'Earnings (EPS)', roe: 'Return on equity', epsGrowth: 'EPS growth YoY', peerRoe: 'ROE vs sector peers',
  bookValue: 'Book value', dividend: 'Dividend record', assetQuality: 'Asset quality (NPL)', capitalAdequacy: 'Capital adequacy',
  pe: 'P/E (sector-relative)', pb: 'P/B (sector-relative)', dividendYield: 'Dividend yield', trend: 'Trend (20/50/200 MA)',
  rsi: 'RSI (14)', macd: 'MACD', momentum: '1-month momentum', volume: 'Volume confirmation', breakout: 'Breakout / breakdown',
  market: 'NEPSE trend', sectorMomentum: 'Sector 1-month momentum', sectorToday: 'Sector today', volatility: 'Volatility',
  liquidity: 'Illiquidity', drawdown: 'Drawdown from 52w high', financial: 'Financial risk',
};

function ScoreBlock({ title, s, invert = false, weight }: { title: string; s: Scored; invert?: boolean; weight?: number }) {
  return (
    <div className="rounded-md border border-line p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold">{title}{weight !== undefined && <span className="ml-1 text-xs font-normal text-mute">weight {weight}%</span>}</div>
        <ScoreBar value={s.score} invert={invert} />
      </div>
      <div className="space-y-1">
        {Object.entries(s.components ?? {}).map(([k, v]) => (
          <div key={k} className="flex items-center justify-between text-xs text-mute">
            <span>{LABELS[k] ?? k}</span><ScoreBar value={v} invert={invert} />
          </div>
        ))}
      </div>
      {/* notes are optional in the data: never assume the list exists */}
      {(s.notes ?? []).length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs">{(s.notes ?? []).map((n) => <li key={n}>{n}</li>)}</ul>}
    </div>
  );
}

export function StockDetail({ symbol, onClose }: { symbol: string; onClose: () => void }) {
  const m = useMarket();
  const { state, upsertWatch } = useStore();
  const pf = usePortfolio();
  const a = m.analysis?.stocks[symbol];
  const row = m.rowMap[symbol];
  const [rows, setRows] = useState<HistRow[] | null>(null);
  const [range, setRange] = useState(120);
  useEffect(() => { setRows(null); loadHistory(symbol).then(setRows); }, [symbol]);
  const c = chartColors();
  const data = useMemo(() => (rows ?? []).map((r, i) => ({ date: r[0], close: r[4], volume: r[5], sma20: sma(rows!, 20, i), sma50: sma(rows!, 50, i), sma200: sma(rows!, 200, i) })).slice(-range), [rows, range]);
  const holding = pf.held.find((h) => h.symbol === symbol);
  const advice = pf.advice[symbol];
  const prospect = a ? adviseProspect(a, state.settings.weights, m.analysis!.thresholds) : null;
  const watch = state.watchlist.find((w) => w.symbol === symbol);
  const f = a?.fundamentals;
  const t = a?.tech ?? {};
  const w = state.settings.weights;

  return (
    <Modal wide onClose={onClose} title={<span>{symbol} <span className="font-normal text-mute">{row?.name ?? a?.name ?? ''} · {row?.sector ?? a?.sector ?? 'Unknown sector'}</span></span>}>
      {!row && <Banner level="bad">No current price for {symbol} in the latest market data. It may not have traded, or the symbol may be delisted/merged. Nothing is estimated.</Banner>}
      {row && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
            <div>
              <div className="num text-3xl font-semibold">Rs {npr(row.ltp, 1)}</div>
              {row.carried
                ? <div className="text-sm text-warn">No trade yet in the latest session · this is the {shortDate(row.asOf)} close</div>
                : <div className={`num text-sm ${tone(row.pctChange)}`}>{pct(row.pctChange)} today · prev close {npr(row.prevClose, 1)}</div>}
            </div>
            {a && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge>{advice?.action ?? prospect!.action}</Badge>
                <span className="text-mute">Quality</span><ScoreBar value={advice?.quality ?? prospect!.quality} />
                <span className="text-mute">Trading</span><ScoreBar value={a.trading} />
                <span className="text-mute">Risk</span><Badge>{a.risk.level ?? 'Unknown'}</Badge>
                <span className="text-mute">Confidence {a.confidence.toFixed(0)}/100</span>
              </div>
            )}
            <div className="ml-auto flex gap-2">
              {!holding && !watch && <button className="btn" onClick={() => upsertWatch({ symbol, list: 'watch', buyLow: a?.levels?.entryLow ?? null, buyHigh: a?.levels?.entryHigh ?? null, targetSell: a?.levels?.upsideTarget ?? null })}>+ Watchlist</button>}
              {watch && <span className="chip bg-accent/15 text-accent">On {watch.list === 'avoid' ? 'Avoid list' : 'Watchlist'}</span>}
            </div>
          </div>

          {a?.incomplete && <Banner level="warn"><b>Recommendation incomplete.</b> {a.dataGaps.join(' · ')}</Banner>}
          {!a && <Banner level="warn">This instrument is outside the analysed universe (mutual funds and debentures are priced but not scored).</Banner>}

          {holding && advice && (
            <Card title="Your position">
              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div><div className="text-xs text-mute">Shares</div><div className="num font-semibold">{npr(holding.qty)}</div></div>
                <div><div className="text-xs text-mute">Average cost</div><div className="num font-semibold">Rs {npr(holding.avgCost, 2)}</div></div>
                <div><div className="text-xs text-mute">Unrealized</div><div className={`num font-semibold ${tone(holding.unrealized)}`}>Rs {npr(holding.unrealized)} ({pct(holding.unrealizedPct)})</div></div>
                <div><div className="text-xs text-mute">Net if sold today</div><div className="num font-semibold">Rs {npr(holding.sellNow?.netProceeds)}</div></div>
              </div>
              <p className="mt-3 text-sm"><b>Suggested action:</b> {advice.suggested}</p>
              {advice.flags.map((fl) => <div key={fl.text} className={`mt-1 text-sm ${fl.level === 'critical' ? 'text-down' : fl.level === 'warn' ? 'text-warn' : 'text-mute'}`}>• {fl.text}</div>)}
            </Card>
          )}

          <Card title="Price, moving averages and volume" right={
            <div className="flex gap-1">{[60, 120, 250].map((n) => <button key={n} className={`btn !px-2 !py-0.5 ${range === n ? '!border-accent !text-accent' : ''}`} onClick={() => setRange(n)}>{n}d</button>)}</div>}>
            {rows === null ? <div className="py-10 text-center text-sm text-mute">Loading history…</div>
              : data.length < 2 ? <div className="py-10 text-center text-sm text-mute">No price history available for this symbol.</div> : (
                <div className="h-72">
                  <ResponsiveContainer>
                    <ComposedChart data={data} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke={c.line} strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="date" tick={{ fontSize: 11, fill: c.mute }} minTickGap={40} />
                      <YAxis yAxisId="p" domain={['auto', 'auto']} tick={{ fontSize: 11, fill: c.mute }} width={55} />
                      <YAxis yAxisId="v" orientation="right" hide domain={[0, (max: number) => max * 4]} />
                      <Tooltip {...tooltipStyle()} formatter={(v: number, n: string) => [n === 'volume' ? npr(v) : npr(v, 1), n]} />
                      <Bar yAxisId="v" dataKey="volume" fill={c.mute} opacity={0.35} isAnimationActive={false} />
                      <Area yAxisId="p" dataKey="close" stroke={c.accent} fill={c.accent} fillOpacity={0.08} strokeWidth={2} isAnimationActive={false} />
                      <Line yAxisId="p" dataKey="sma20" stroke="#fbbf24" dot={false} strokeWidth={1} isAnimationActive={false} />
                      <Line yAxisId="p" dataKey="sma50" stroke="#a78bfa" dot={false} strokeWidth={1} isAnimationActive={false} />
                      <Line yAxisId="p" dataKey="sma200" stroke="#f472b6" dot={false} strokeWidth={1} isAnimationActive={false} />
                      {holding && <ReferenceLine yAxisId="p" y={holding.avgCost} stroke={c.ink} strokeDasharray="4 4" label={{ value: 'My avg cost', fontSize: 10, fill: c.mute, position: 'insideTopLeft' }} />}
                      {a?.levels && <ReferenceLine yAxisId="p" y={a.levels.downsideLevel} stroke={c.down} strokeDasharray="2 4" label={{ value: 'Support', fontSize: 10, fill: c.down, position: 'insideBottomLeft' }} />}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              )}
            <div className="mt-2 flex flex-wrap gap-3 text-xs text-mute">
              <span><span className="text-[#fbbf24]">━</span> 20d MA {npr(t.sma20, 1)}</span>
              <span><span className="text-[#a78bfa]">━</span> 50d MA {npr(t.sma50, 1)}</span>
              <span><span className="text-[#f472b6]">━</span> 200d MA {t.sma200 ? npr(t.sma200, 1) : 'n/a (needs 200 sessions)'}</span>
            </div>
          </Card>

          {a && (
            <>
              <div className="grid gap-4 lg:grid-cols-2">
                <Card title={`Technical indicators${m.analysis?.sessionInProgress && t.lastDate ? ` · through the ${shortDate(t.lastDate)} close` : ''}`}>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                    {[
                      ['RSI (14)', num(t.rsi14, 1)], ['MACD / signal', t.macd ? `${num(t.macd.macd)} / ${num(t.macd.signal)}` : '—'],
                      ['Bollinger band', t.bollinger ? `${npr(t.bollinger.lower, 1)} – ${npr(t.bollinger.upper, 1)}` : '—'],
                      ['20-day range', t.tradingRange ? `${npr(t.tradingRange.low, 1)} – ${npr(t.tradingRange.high, 1)}` : '—'],
                      ['Support (20d / 60d)', `${npr(t.support20, 1)} / ${npr(t.support60, 1)}`],
                      ['Resistance (20d / 60d)', `${npr(t.resistance20, 1)} / ${npr(t.resistance60, 1)}`],
                      [`${t.window52Days >= 225 ? '52-week' : `${t.window52Days}-session`} high / low`, `${npr(t.high52, 1)} / ${npr(t.low52, 1)}`],
                      ['Volume vs 20d avg', t.volRatio ? `${num(t.volRatio, 1)}x` : '—'],
                      ['Return 1w / 1m / 3m', `${pct(t.ret1w, 1)} / ${pct(t.ret1m, 1)} / ${pct(t.ret3m, 1)}`],
                      ['Volatility (annualised)', t.volatility ? `${num(t.volatility, 0)}%` : '—'],
                    ].map(([k, v]) => (<div key={k} className="contents"><dt className="text-mute">{k}</dt><dd className="num text-right">{v}</dd></div>))}
                  </dl>
                </Card>
                <Card title={`Fundamentals${f?.period ? ` · FY ${f.period.fiscalYear} ${String(f.period.quarter).toUpperCase()}` : ''}`}>
                  {!f ? <div className="text-sm text-mute">No reported fundamentals available from the data source for this company.</div> : (
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                      {[
                        ['EPS (annualised)', num(f.eps)], ['P/E', num(a.valuation.pe, 1)], ['Book value / share', num(f.bookValue)],
                        ['P/B', num(a.valuation.pb)], ['ROE', f.roe !== null && f.roe !== undefined ? `${num(f.roe)}%` : '—'],
                        ['ROA', f.roa !== null && f.roa !== undefined ? `${num(f.roa)}%` : '—'],
                        ['EPS growth YoY', pct(f.epsGrowthYoY, 1)], ['Net profit growth YoY', pct(f.profitGrowthYoY, 1)],
                        ['NPL', f.npl !== null && f.npl !== undefined ? `${num(f.npl)}%` : 'n/a'], ['Capital adequacy', f.car !== null && f.car !== undefined ? `${num(f.car)}%` : 'n/a'],
                        ['Cash dividend yield', a.valuation.divYield !== null && a.valuation.divYield !== undefined ? `${num(a.valuation.divYield, 1)}%` : '—'],
                        ['Last dividend', f.dividends?.[0] ? `${f.dividends[0].cash}% cash + ${f.dividends[0].bonus}% bonus (${f.dividends[0].fiscalYear})` : '—'],
                      ].map(([k, v]) => (<div key={k} className="contents"><dt className="text-mute">{k}</dt><dd className="num text-right">{v}</dd></div>))}
                    </dl>
                  )}
                  {f?.fetchedAt && <div className="mt-2 text-xs text-mute">Source: ShareHub (unofficial). Refreshed {fmtTime(f.fetchedAt)}. Verify against the company's published report.</div>}
                </Card>
              </div>

              <Card title="How the scores were built (transparent methodology)">
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  <ScoreBlock title="Fundamental" s={a.fundamental} weight={w.fundamental} />
                  <ScoreBlock title="Technical" s={a.technical} weight={w.technical} />
                  <ScoreBlock title="Valuation" s={a.valuation} weight={w.valuation} />
                  <ScoreBlock title="Market & sector" s={a.market} weight={w.market} />
                  <ScoreBlock title="Risk (higher = riskier)" s={a.risk} invert weight={w.risk} />
                  <div className="rounded-md border border-line p-3 text-xs leading-relaxed text-mute">
                    <div className="mb-1 text-sm font-semibold text-ink">Reading this</div>
                    Quality = weighted average of the areas that have data (missing areas are excluded and lower the confidence, never filled in).
                    Trading score is separate and driven by price/volume only. Long-term view: <b className="text-ink">{a.horizon.long}</b>. Short-term setup: <b className="text-ink">{a.horizon.short}</b>.
                    {a.levels && <> Entry zone Rs {npr(a.levels.entryLow)}–{npr(a.levels.entryHigh)}; upside reference {a.levels.upsideTarget ? `Rs ${npr(a.levels.upsideTarget)} (${pct(a.levels.upsidePct, 1)})` : 'none above current price'}; downside reference Rs {npr(a.levels.downsideLevel)} ({pct(a.levels.downsidePct, 1)}).</>}
                  </div>
                </div>
                <div className="mt-3 text-sm">
                  <b>What would invalidate this view:</b>
                  <ul className="mt-1 list-disc pl-5 text-sm text-mute">{(advice?.invalidation ?? prospect!.invalidation).map((x) => <li key={x}>{x}</li>)}</ul>
                </div>
                <div className="mt-2 text-xs text-mute">Analysis generated {fmtTime(m.analysis?.generatedAt)} from market date {m.analysis?.marketDate}. Decision support, not a prediction.</div>
              </Card>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
