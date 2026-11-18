import { useState } from 'react';
import defaultFees from '../../../config/fees.json';
import defaultScoring from '../../../config/scoring.json';
import { SyncCard } from '../components/SyncCard';
import { Badge, Card, Field } from '../components/ui';
import { useMarket } from '../lib/data';
import { DEMO_PLANS, DEMO_TXNS, DEMO_WATCH } from '../lib/demo';
import type { Fees } from '../lib/engine';
import { fmtTime } from '../lib/format';
import { uid, useStore, type Settings as S } from '../lib/store';

export default function Settings() {
  const { state, updateSettings, reset, setState } = useStore();
  const m = useMarket();
  const s = state.settings;
  const [feesText, setFeesText] = useState(JSON.stringify(s.fees, null, 2));
  const [feesMsg, setFeesMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const wsum = Object.values(s.weights).reduce((a, b) => a + b, 0);
  const setW = (k: keyof S['weights'], v: number) => updateSettings({ weights: { ...s.weights, [k]: v } });

  const saveFees = () => {
    try {
      const f = JSON.parse(feesText) as Fees;
      if (!Array.isArray(f.schedules) || !f.schedules.length) throw new Error('"schedules" must be a non-empty array');
      for (const x of f.schedules) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(x.effectiveFrom)) throw new Error(`effectiveFrom "${x.effectiveFrom}" must be YYYY-MM-DD`);
        if (!x.commissionSlabs?.length || x.commissionSlabs.some((sl) => !(sl.rate >= 0 && sl.rate < 0.05))) throw new Error('commission slab rates must be decimals, e.g. 0.0036 for 0.36%');
        if (!(x.sebonRate >= 0 && x.sebonRate < 0.01) || !(x.cgt?.shortTermRate >= 0 && x.cgt.shortTermRate < 0.5)) throw new Error('rates must be decimals (0.075 = 7.5%)');
      }
      updateSettings({ fees: f, feesCustomised: true });
      setFeesMsg({ ok: true, text: 'Fee schedule saved. All portfolio figures have been recalculated with it.' });
    } catch (e) { setFeesMsg({ ok: false, text: `Not saved: ${(e as Error).message}` }); }
  };

  return (
    <>
      <h1 className="text-lg font-semibold">Settings</h1>
      {/* grid-cols-1: a column that cannot be stretched, so a wide table scrolls inside its card instead of widening every card on a phone */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SyncCard />

        <Card title="Accounting & portfolio rules">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Cost-basis method" hint="Weighted average matches MeroShare / broker practice.">
              <select className="input" value={s.engine.method} onChange={(e) => updateSettings({ engine: { ...s.engine, method: e.target.value as 'WACC' | 'FIFO' } })}><option value="WACC">Weighted average (WACC)</option><option value="FIFO">First in, first out (FIFO)</option></select></Field>
            <Field label="Bonus share cost (my P/L)" hint="0 = bonus shares are free; lowers your average cost.">
              <input className="input" type="number" value={s.engine.bonusCostBasis} onChange={(e) => updateSettings({ engine: { ...s.engine, bonusCostBasis: Number(e.target.value) } })} /></Field>
            <Field label="Bonus share cost (for CGT)" hint="Rs 100 par value is used for capital-gains tax.">
              <input className="input" type="number" value={s.engine.bonusTaxBasis} onChange={(e) => updateSettings({ engine: { ...s.engine, bonusTaxBasis: Number(e.target.value) } })} /></Field>
            <Field label="Available cash (Rs)"><input className="input" type="number" value={s.cash} onChange={(e) => updateSettings({ cash: Number(e.target.value) })} /></Field>
            <Field label="Max single-stock weight (%)" hint="Triggers concentration warnings."><input className="input" type="number" value={s.concentrationPct} onChange={(e) => updateSettings({ concentrationPct: Number(e.target.value) })} /></Field>
            <Field label="Deposit benchmark (% p.a.)" hint="Fixed-deposit rate to compare returns with."><input className="input" type="number" step="0.25" value={s.depositRatePct} onChange={(e) => updateSettings({ depositRatePct: Number(e.target.value) })} /></Field>
          </div>
        </Card>

        <Card title="Recommendation weights" right={<button className="btn !py-0.5" onClick={() => updateSettings({ weights: { ...(defaultScoring.weights as S['weights']) } })}>Reset to default</button>}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {(Object.keys(s.weights) as (keyof S['weights'])[]).map((k) => (
              <Field key={k} label={k === 'market' ? 'Market & sector' : k}><input className="input" type="number" min={0} max={100} value={s.weights[k]} onChange={(e) => setW(k, Number(e.target.value))} /></Field>))}
          </div>
          <div className={`mt-2 text-sm ${wsum === 100 ? 'text-mute' : 'text-warn'}`}>Total: {wsum}%{wsum !== 100 && ' — weights are normalised automatically, but 100 keeps them easy to read.'}</div>
          <div className="mt-1 text-xs text-mute">Applies instantly to scores and signals in this dashboard. The automated alerts and reports use config/scoring.json in the repository.</div>
        </Card>

        <Card title="Transaction charges & tax (effective-date schedule)" right={<span className="flex gap-2"><button className="btn !py-0.5" onClick={() => { setFeesText(JSON.stringify(defaultFees, null, 2)); updateSettings({ fees: structuredClone(defaultFees) as unknown as Fees, feesCustomised: false }); setFeesMsg({ ok: true, text: 'Restored the shipped schedule.' }); }}>Reset</button><button className="btn btn-primary !py-0.5" onClick={saveFees}>Save</button></span>}>
          <div className="mb-2 overflow-x-auto">
            <table className="w-full text-xs"><thead><tr className="border-b border-line"><th className="th">Effective from</th><th className="th">Commission slabs</th><th className="th">SEBON</th><th className="th">DP</th><th className="th">CGT short / long</th><th className="th">Div. tax</th></tr></thead>
              <tbody className="num">{s.fees.schedules.map((x) => <tr key={x.effectiveFrom} className="border-b border-line/50"><td className="td">{x.effectiveFrom}</td><td className="td !whitespace-normal">{x.commissionSlabs.map((sl) => `${(sl.rate * 100).toFixed(2)}%`).join(' / ')}</td><td className="td">{(x.sebonRate * 100).toFixed(3)}%</td><td className="td">Rs {x.dpCharge}</td><td className="td">{(x.cgt.shortTermRate * 100).toFixed(1)}% / {(x.cgt.longTermRate * 100).toFixed(1)}%</td><td className="td">{(x.dividendTaxRate * 100).toFixed(0)}%</td></tr>)}</tbody></table>
          </div>
          <textarea className="input h-48 font-mono text-xs" value={feesText} onChange={(e) => setFeesText(e.target.value)} spellCheck={false} />
          {feesMsg && <div className={`mt-2 text-sm ${feesMsg.ok ? 'text-up' : 'text-down'}`}>{feesMsg.text}</div>}
          <div className="mt-2 text-xs text-mute">Each transaction uses the schedule in force on its date. When rates change, add a new block with its effectiveFrom date instead of editing old ones. Always confirm against your broker's contract note; rates here are a best-effort record, not legal advice.</div>
        </Card>

        <Card title="Market data sources & health">
          {!m.status ? <div className="text-sm text-mute">No status file yet. Run the pipeline.</div> : (
            <>
              <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <span>Freshness: <Badge kind={m.status.freshness.state === 'fresh' ? 'Low' : m.status.freshness.state === 'delayed' ? 'Medium' : 'High'}>{m.status.freshness.state}</Badge></span>
                <span>Reliability: <Badge kind={m.status.reliability === 'cross-verified' ? 'Low' : m.status.reliability === 'unverified' ? 'Medium' : 'High'}>{m.status.reliability}</Badge></span>
                <span className="text-mute">Last run {fmtTime(m.status.generatedAt)}</span>
              </div>
              <div className="overflow-x-auto">
              <table className="w-full text-xs"><thead><tr className="border-b border-line"><th className="th">Data</th><th className="th">Primary → fallback</th><th className="th">Used now</th><th className="th">Last success</th><th className="th">Detail</th></tr></thead>
                <tbody>{Object.entries(m.status.chain).map(([cap, chain]) => { const c = m.status!.capabilities[cap]; return (
                  <tr key={cap} className="border-b border-line/50"><td className="td font-medium">{cap}</td><td className="td">{chain.join(' → ')}</td>
                    <td className="td">{c ? (c.ok ? <span className="text-up">{c.source}{c.role && c.role !== 'primary' ? ` (${c.role})` : ''}</span> : <span className="text-down">failed</span>) : <span className="text-mute">not run</span>}</td>
                    <td className="td">{fmtTime(m.status!.lastSuccess[cap])}</td>
                    <td className="td !whitespace-normal text-mute">{cap === 'prices' && c?.crossCheck?.against ? `${c.rows} symbols; ${c.crossCheck.mismatches}/${c.crossCheck.compared} differ >1% vs ${c.crossCheck.against}` : cap === 'fundamentals' && c ? `${c.covered}/${c.universe} companies covered` : cap === 'history' && c ? `${c.appended} updated, ${c.bootstrapped} loaded, ${c.failed} failed` : (c?.errors ?? []).join('; ').slice(0, 80)}</td></tr>); })}</tbody></table>
              </div>
              <div className="mt-2 text-xs text-mute">{m.status.disclaimer} The official NEPSE site (nepalstock.com) does not offer anonymous API access. Change the order in config/sources.json.</div>
            </>
          )}
        </Card>

        <Card title="AI assistant (optional Claude API key)">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Claude API key" hint="Optional. Stored in this browser only and sent only to api.anthropic.com. Usage is billed to your Anthropic account."><input className="input" type="password" autoComplete="off" value={s.ai.apiKey} placeholder="sk-ant-…" onChange={(e) => updateSettings({ ai: { ...s.ai, apiKey: e.target.value.trim() } })} /></Field>
            <Field label="Model"><input className="input" value={s.ai.model} onChange={(e) => updateSettings({ ai: { ...s.ai, model: e.target.value.trim() } })} /></Field>
          </div>
          <div className="mt-2 text-xs text-mute">Without a key the assistant still works: it answers the supported question types directly from your data. With a key, questions it cannot map are sent to Claude together with a snapshot of your holdings and market data (so only add a key if you are comfortable with that).</div>
        </Card>

        <Card title="Notifications (Telegram / email)">
          <p className="text-sm text-mute">Alerts are sent by the scheduled GitHub Actions pipeline, not by this page, so no bot token is ever exposed in the browser. Set these repository secrets (Settings → Secrets and variables → Actions):</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
            <li><code>TELEGRAM_BOT_TOKEN</code> and <code>TELEGRAM_CHAT_ID</code> — Telegram (check the app works on your connection: it is blocked by internet providers in Nepal)</li>
            <li><code>SMTP_USER</code> and <code>SMTP_PASSWORD</code> — email, instead of or as well as Telegram (Gmail: your address and an app password)</li>
            <li><code>PORTFOLIO_PASSPHRASE</code> — the passphrase from the first card on this page, so the pipeline can read your encrypted holdings</li>
            <li><code>ANTHROPIC_API_KEY</code> — optional, adds a short AI-written summary to the daily report</li>
          </ul>
          <p className="mt-2 text-xs text-mute">Thresholds (day move %, loss %, concentration, cooldown, max alerts per run) live in config/alerts.json. Per-stock target and stop-loss prices are set on the My Portfolio page and travel inside the encrypted file.</p>
        </Card>

        <Card title="Data" className="xl:col-span-2">
          <div className="flex flex-wrap gap-2">
            <button className="btn" onClick={() => { if (!state.transactions.length || window.confirm('Replace your current data with the DEMO portfolio?')) setState((x) => ({ ...x, demo: true, transactions: DEMO_TXNS.map((t) => ({ ...t, id: uid(), createdAt: new Date().toISOString() })), watchlist: DEMO_WATCH, plans: DEMO_PLANS, audit: [...x.audit, { at: new Date().toISOString(), action: 'DEMO', detail: 'DEMO sample portfolio loaded' }] })); }}>Load DEMO portfolio</button>
            <button className="btn btn-danger" onClick={() => { if (window.confirm('Erase ALL transactions, watchlist and settings from this browser? Download a backup first if unsure. This cannot be undone.')) reset(); }}>Erase all data in this browser</button>
          </div>
          <div className="mt-2 text-xs text-mute">{state.transactions.length} transaction(s) stored · {state.audit.length} audit entries · {state.demo ? 'DEMO data active' : 'your own data'}</div>
        </Card>
      </div>
    </>
  );
}
