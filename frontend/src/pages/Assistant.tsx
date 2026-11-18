import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Banner, Card } from '../components/ui';
import { answerLocal, askClaude, EXAMPLES, type Answer, type Tag } from '../lib/assistant';
import { useHistories, useMarket } from '../lib/data';
import { riskReport } from '../lib/risk';
import { useStore } from '../lib/store';
import { usePortfolio } from '../lib/usePortfolio';

const TAG: Record<Tag, { label: string; cls: string }> = {
  fact: { label: 'Fact', cls: 'bg-accent/15 text-accent' }, estimate: { label: 'Estimate', cls: 'bg-warn/15 text-warn' },
  opinion: { label: 'Opinion', cls: 'bg-[#a78bfa]/20 text-[#a78bfa]' }, note: { label: 'Note', cls: 'bg-mute/15 text-mute' },
};
type Msg = { role: 'user'; text: string } | { role: 'assistant'; answer: Answer } | { role: 'error'; text: string };

export default function Assistant() {
  const { state } = useStore();
  const m = useMarket();
  const pf = usePortfolio();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const symbols = useMemo(() => pf.held.map((h) => h.symbol), [pf.held]);
  const hist = useHistories(useMemo(() => [...symbols, 'NEPSE'], [symbols]));
  const betas = useMemo(() => riskReport(pf.held, pf.sectorOf, hist ?? {}, hist?.NEPSE ?? [], () => null, state.settings.concentrationPct).betas, [pf.held, hist]); // eslint-disable-line react-hooks/exhaustive-deps
  const hasKey = !!state.settings.ai.apiKey;
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, busy]);

  const ask = async (q: string) => {
    if (!q.trim() || busy) return;
    setInput('');
    setMsgs((x) => [...x, { role: 'user', text: q }]);
    const ctx = { state, m, pf, betas }; // portfolio + market data are read fresh for every question
    const local = answerLocal(q, ctx);
    if (local) { setMsgs((x) => [...x, { role: 'assistant', answer: local }]); return; }
    if (!hasKey) {
      setMsgs((x) => [...x, { role: 'assistant', answer: { title: 'I could not match that question', engine: 'built-in', sources: [], lines: [
        { tag: 'note', text: 'The built-in assistant answers from your data using fixed question types (see the examples). It does not guess at questions it cannot map to data.' },
        { tag: 'note', text: 'Try naming a stock symbol, or ask about profit/loss, what to sell, risk, opportunities, a NEPSE move, or investing an amount. For free-form questions, add your own Claude API key in Settings.' }] } }]);
      return;
    }
    setBusy(true);
    try {
      const history = msgs.filter((x) => x.role !== 'error').map((x) => (x.role === 'user' ? { role: 'user' as const, content: x.text } : { role: 'assistant' as const, content: (x as any).answer.lines.map((l: any) => l.text).join('\n') }));
      const a = await askClaude(q, ctx, history);
      setMsgs((x) => [...x, { role: 'assistant', answer: a }]);
    } catch (e) { setMsgs((x) => [...x, { role: 'error', text: (e as Error).message }]); }
    setBusy(false);
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">AI Investment Assistant</h1>
        <span className="text-xs text-mute">Engine: built-in data assistant{hasKey ? ` + Claude (${state.settings.ai.model}) for free-form questions` : ''}</span>
      </div>
      {!hasKey && <Banner level="info">Running on the built-in assistant, which needs no API key: it reads your live portfolio and market data and answers the question types below. Free-form conversation is optional and uses your own Claude API key (<Link to="/settings" className="underline">Settings</Link>).</Banner>}
      <Card className="flex min-h-[55vh] flex-col">
        <div className="flex-1 space-y-4">
          {msgs.length === 0 && (
            <div>
              <div className="mb-2 text-sm text-mute">Ask about your portfolio. Each answer re-reads your current holdings and the latest market data, and marks what is fact, estimate or opinion.</div>
              <div className="grid gap-2 md:grid-cols-2">{EXAMPLES.map((e) => <button key={e} className="rounded-md border border-line px-3 py-2 text-left text-sm hover:border-accent hover:text-accent" onClick={() => ask(e)}>{e}</button>)}</div>
            </div>
          )}
          {msgs.map((x, i) => (x.role === 'user' ? (
            <div key={i} className="ml-auto max-w-[85%] rounded-lg bg-accent/15 px-3 py-2 text-sm">{x.text}</div>
          ) : x.role === 'error' ? <Banner key={i} level="bad">{x.text}</Banner> : (
            <div key={i} className="max-w-[95%] rounded-lg border border-line px-3 py-2.5">
              <div className="mb-2 flex items-center justify-between gap-2"><span className="text-sm font-semibold">{x.answer.title}</span><span className="text-[11px] text-mute">{x.answer.engine === 'claude' ? 'Claude, grounded on your data snapshot' : 'built-in, computed from data'}</span></div>
              <div className="space-y-1.5">
                {x.answer.lines.map((l, j) => (
                  <div key={j} className="flex gap-2 text-sm">
                    {x.answer.engine === 'built-in' && <span className={`chip h-5 w-[62px] shrink-0 justify-center ${TAG[l.tag].cls}`}>{TAG[l.tag].label}</span>}
                    <span className="whitespace-pre-wrap">{l.text}</span>
                  </div>))}
              </div>
              {x.answer.sources.length > 0 && <div className="mt-2 border-t border-line pt-1.5 text-[11px] text-mute">Sources: {x.answer.sources.map((s, j) => <span key={j}>{j > 0 && ' · '}{s.url ? <a className="underline hover:text-accent" href={s.url} target="_blank" rel="noreferrer noopener">{s.label}</a> : s.label}</span>)}</div>}
            </div>)))}
          {busy && <div className="text-sm text-mute">Thinking…</div>}
          <div ref={end} />
        </div>
        <form className="mt-4 flex gap-2 border-t border-line pt-3" onSubmit={(e) => { e.preventDefault(); ask(input); }}>
          <input className="input" placeholder="e.g. Should I buy more NABIL?  ·  What if NEPSE falls 15%?" value={input} onChange={(e) => setInput(e.target.value)} />
          <button className="btn btn-primary" disabled={busy || !input.trim()}>Ask</button>
          {msgs.length > 0 && <button type="button" className="btn" onClick={() => setMsgs([])}>Clear</button>}
        </form>
        <div className="mt-2 text-[11px] text-mute">Decision support only. Not licensed investment advice; nothing here places an order.</div>
      </Card>
    </>
  );
}
