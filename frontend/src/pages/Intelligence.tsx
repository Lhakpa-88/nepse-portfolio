import { useMemo, useState } from 'react';
import { useOpenStock } from '../App';
import { Badge, Banner, Card, Empty } from '../components/ui';
import { useMarket, type NewsItem } from '../lib/data';
import { fmtTime } from '../lib/format';
import { useStore } from '../lib/store';
import { usePortfolio } from '../lib/usePortfolio';

const IMPACTS = ['Critical', 'High', 'Moderate', 'General'] as const;

export default function Intelligence() {
  const m = useMarket();
  const pf = usePortfolio();
  const { state } = useStore();
  const open = useOpenStock();
  const [impact, setImpact] = useState('');
  const [mine, setMine] = useState(false);
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const held = useMemo(() => new Set(pf.held.map((h) => h.symbol)), [pf.held]);
  const watched = useMemo(() => new Set(state.watchlist.map((w) => w.symbol)), [state.watchlist]);
  const heldSectors = useMemo(() => new Set(pf.held.map((h) => pf.sectorOf(h.symbol))), [pf.held]);
  const items = m.news?.items ?? [];
  const cats = useMemo(() => [...new Set(items.map((i) => i.category))].sort(), [items]);
  const relevance = (n: NewsItem) => {
    const hs = n.symbols.filter((s) => held.has(s));
    if (hs.length) return { level: 2, text: `Directly concerns your holding${hs.length > 1 ? 's' : ''}: ${hs.join(', ')}` };
    const ws = n.symbols.filter((s) => watched.has(s));
    if (ws.length) return { level: 1, text: `Concerns your watchlist: ${ws.join(', ')}` };
    const ss = n.sectors.filter((s) => heldSectors.has(s));
    if (ss.length) return { level: 1, text: `Sector-level relevance to your ${ss.join(', ')} holdings` };
    if (n.category === 'Monetary policy' || n.category === 'Regulation' || n.category === 'Fiscal policy & tax') return { level: 1, text: 'Market-wide: can affect all holdings through liquidity, interest rates or tax' };
    return { level: 0, text: 'No direct link to your current holdings' };
  };
  const view = items.filter((n) => (!impact || n.impact === impact) && (!cat || n.category === cat) && (!mine || relevance(n).level > 0)
    && (!q || n.title.toLowerCase().includes(q.toLowerCase()) || n.symbols.includes(q.toUpperCase())));
  const counts = Object.fromEntries(IMPACTS.map((i) => [i, items.filter((n) => n.impact === i).length]));

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Market Intelligence</h1>
        <span className="text-xs text-mute">{m.news ? `Updated ${fmtTime(m.news.generatedAt)} · ${items.length} items after de-duplication` : ''}</span>
      </div>
      {!m.news ? <Empty>{m.loading ? 'Loading…' : 'News has not been collected yet. Run the pipeline (python -m scripts.run_pipeline news).'}</Empty> : (
        <>
          <Banner level="info">Headlines come from the sources listed below and link to the original article. Impact, sentiment and category are assigned by transparent keyword rules, not by reading the full article, so treat them as a triage aid and open the source before acting. Social-media rumours are not collected.</Banner>
          <Card>
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => setImpact('')} className={`rounded-md border px-3 py-1 text-sm ${!impact ? 'border-accent bg-accent/15 text-accent' : 'border-line text-mute'}`}>All {items.length}</button>
              {IMPACTS.map((i) => <button key={i} onClick={() => setImpact(i)} className={`rounded-md border px-3 py-1 text-sm ${impact === i ? 'border-accent bg-accent/15 text-accent' : 'border-line text-mute'}`}>{i === 'High' ? 'High impact' : i === 'Moderate' ? 'Moderate impact' : i === 'General' ? 'General information' : i} {counts[i]}</button>)}
              <select className="input !w-auto" value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All topics</option>{cats.map((x) => <option key={x}>{x}</option>)}</select>
              <input className="input !w-48" placeholder="Search headline or symbol…" value={q} onChange={(e) => setQ(e.target.value)} />
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Relevant to me only</label>
            </div>
          </Card>
          {view.length === 0 ? <Empty>No items match these filters.</Empty> : (
            <div className="space-y-2">
              {view.map((n) => { const rel = relevance(n); return (
                <article key={n.id} className={`card p-3 ${rel.level === 2 ? 'border-accent/60' : ''}`}>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge kind={n.impact}>{n.impact === 'High' ? 'High Impact' : n.impact === 'Moderate' ? 'Moderate Impact' : n.impact === 'General' ? 'General Information' : 'Critical'}</Badge>
                    <Badge kind={n.sentiment}>{n.sentiment}</Badge>
                    <span className="chip bg-line/60 text-mute">{n.category}</span>
                    <span className={`chip ${n.confirmed ? 'bg-up/10 text-up' : 'bg-warn/10 text-warn'}`}>{n.confirmed ? 'Confirmed announcement' : 'News report'}</span>
                    <span className="ml-auto text-mute">{n.source} · {n.publishedAt ? fmtTime(n.publishedAt) : 'time not published'}</span>
                  </div>
                  <a href={n.url} target="_blank" rel="noreferrer noopener" className="mt-1.5 block text-sm font-semibold hover:text-accent">{n.title} ↗</a>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                    {n.symbols.map((s) => <button key={s} onClick={() => open(s)} className={`chip ${held.has(s) ? 'bg-accent/20 text-accent' : 'bg-line/60 text-ink'} hover:underline`}>{s}</button>)}
                    {n.sectors.map((s) => <span key={s} className="chip bg-line/40 text-mute">{s}</span>)}
                  </div>
                  <div className="mt-1.5 grid grid-cols-1 gap-x-6 gap-y-0.5 text-xs text-mute md:grid-cols-3">
                    <div><b className="text-ink">Significance:</b> {n.why}</div>
                    <div><b className="text-ink">Impact on my holdings:</b> <span className={rel.level === 2 ? 'text-accent' : ''}>{rel.text}</span></div>
                    <div><b className="text-ink">Suggested action:</b> {rel.level === 0 ? 'None' : n.action ?? 'Read the source; no action indicated by the headline alone'}</div>
                  </div>
                </article>); })}
            </div>
          )}
          <Card title="Sources monitored">
            <div className="grid grid-cols-1 gap-2 text-sm md:grid-cols-2 xl:grid-cols-3">
              {Object.entries(m.news.sources).map(([k, v]: [string, any]) => (
                <div key={k} className="flex items-center justify-between rounded border border-line px-3 py-1.5">
                  <span>{v.label ?? k}</span><span className={v.ok ? 'text-up' : 'text-down'}>{v.ok ? `${v.count} items` : `failed: ${String(v.error ?? '').slice(0, 40)}`}</span>
                </div>))}
            </div>
            <div className="mt-2 text-xs text-mute">Not yet covered automatically (no machine-readable feed found): NEPSE notices, Ministry of Finance, Merolagani and international economic news. Check those directly for major events such as the budget speech.</div>
          </Card>
        </>
      )}
    </>
  );
}
