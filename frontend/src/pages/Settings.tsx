import { useRef, useState } from 'react';
import defaultFees from '../../../config/fees.json';
import defaultScoring from '../../../config/scoring.json';
import { Badge, Banner, Card, Field } from '../components/ui';
import { decryptJson, encryptJson } from '../lib/crypto';
import { useMarket } from '../lib/data';
import { DEMO_PLANS, DEMO_TXNS, DEMO_WATCH } from '../lib/demo';
import type { Fees } from '../lib/engine';
import { download, fmtTime, todayNPT } from '../lib/format';
import { exportable, uid, useStore, type Settings as S } from '../lib/store';

const b64utf8 = (s: string) => btoa(unescape(encodeURIComponent(s)));

export default function Settings() {
  const { state, updateSettings, replaceAll, reset, setState } = useStore();
  const m = useMarket();
  const s = state.settings;
  const [feesText, setFeesText] = useState(JSON.stringify(s.fees, null, 2));
  const [feesMsg, setFeesMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pass, setPass] = useState('');
  const [msg, setMsg] = useState<{ level: 'ok' | 'bad' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileEnc = useRef<HTMLInputElement>(null);
  const filePlain = useRef<HTMLInputElement>(null);
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

  const applyImport = (data: any, note: string) => {
    if (!data || !Array.isArray(data.transactions)) throw new Error('File does not contain a portfolio backup');
    replaceAll({ transactions: data.transactions, watchlist: data.watchlist ?? [], plans: data.plans ?? {}, demo: !!data.demo, audit: data.audit, settings: data.settings }, note);
  };
  const needPass = () => { if (pass.length < 12) { setMsg({ level: 'bad', text: 'Use a passphrase of at least 12 characters. It is the only thing protecting the encrypted file.' }); return false; } return true; };
  const run = async (fn: () => Promise<string>) => { setBusy(true); try { setMsg({ level: 'ok', text: await fn() }); } catch (e) { setMsg({ level: 'bad', text: (e as Error).message }); } setBusy(false); };

  const gh = async (method: 'GET' | 'PUT', body?: unknown) => {
    const { repo, branch, path, token } = s.sync;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Repository must look like owner/name');
    const url = `https://api.github.com/repos/${repo}/contents/${path}${method === 'GET' ? `?ref=${encodeURIComponent(branch)}` : ''}`;
    const r = await fetch(url, { method, headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 404 && method === 'GET') return null;
    if (!r.ok) throw new Error(`GitHub ${method} failed (${r.status}). Check repository, branch and that the token has Contents read/write access to this one repository.`);
    return r.json();
  };
  const push = () => needPass() && run(async () => {
    if (!s.sync.token) throw new Error('A GitHub token is required to push.');
    const blob = await encryptJson(exportable(state), pass);
    const existing = await gh('GET');
    await gh('PUT', { message: 'Update encrypted portfolio', content: b64utf8(JSON.stringify(blob)), branch: s.sync.branch, sha: existing?.sha });
    return `Encrypted portfolio pushed to ${s.sync.repo}/${s.sync.path}. The automated alerts will use it from the next run.`;
  });
  const pull = () => needPass() && run(async () => {
    const f = await gh('GET');
    if (!f) throw new Error('No encrypted file found in the repository yet.');
    applyImport(await decryptJson(JSON.parse(decodeURIComponent(escape(atob(f.content.replace(/\n/g, ''))))), pass), 'Pulled encrypted portfolio from GitHub');
    return 'Portfolio pulled from GitHub and decrypted.';
  });

  return (
    <>
      <h1 className="text-lg font-semibold">Settings</h1>
      <div className="grid gap-4 xl:grid-cols-2">
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
          <div className="mt-1 text-xs text-mute">Applies instantly to scores and signals in this dashboard. The automated Telegram alerts use config/scoring.json in the repository.</div>
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
              <table className="w-full text-xs"><thead><tr className="border-b border-line"><th className="th">Data</th><th className="th">Primary → fallback</th><th className="th">Used now</th><th className="th">Last success</th><th className="th">Detail</th></tr></thead>
                <tbody>{Object.entries(m.status.chain).map(([cap, chain]) => { const c = m.status!.capabilities[cap]; return (
                  <tr key={cap} className="border-b border-line/50"><td className="td font-medium">{cap}</td><td className="td">{chain.join(' → ')}</td>
                    <td className="td">{c ? (c.ok ? <span className="text-up">{c.source}{c.role && c.role !== 'primary' ? ` (${c.role})` : ''}</span> : <span className="text-down">failed</span>) : <span className="text-mute">not run</span>}</td>
                    <td className="td">{fmtTime(m.status!.lastSuccess[cap])}</td>
                    <td className="td !whitespace-normal text-mute">{cap === 'prices' && c?.crossCheck?.against ? `${c.rows} symbols; ${c.crossCheck.mismatches}/${c.crossCheck.compared} differ >1% vs ${c.crossCheck.against}` : cap === 'fundamentals' && c ? `${c.covered}/${c.universe} companies covered` : cap === 'history' && c ? `${c.appended} updated, ${c.bootstrapped} loaded, ${c.failed} failed` : (c?.errors ?? []).join('; ').slice(0, 80)}</td></tr>); })}</tbody></table>
              <div className="mt-2 text-xs text-mute">{m.status.disclaimer} The official NEPSE site (nepalstock.com) does not offer anonymous API access. Change the order in config/sources.json.</div>
            </>
          )}
        </Card>

        <Card title="Privacy, backup & encrypted sync" className="xl:col-span-2">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3">
              <p className="text-sm text-mute">Your transactions never leave this browser unless you export them. The public GitHub Pages site contains market data only. To use the dashboard on another device, or to let the automated Telegram alerts see your holdings, sync an <b className="text-ink">encrypted</b> copy (AES-256-GCM, key derived from your passphrase with PBKDF2 600,000 rounds).</p>
              <Field label="Encryption passphrase" hint="Not stored anywhere. Must match the PORTFOLIO_PASSPHRASE GitHub secret. If you lose it the encrypted file cannot be recovered.">
                <input className="input" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="at least 12 characters" /></Field>
              <div className="flex flex-wrap gap-2">
                <button className="btn" disabled={busy} onClick={() => needPass() && run(async () => { download('portfolio.enc.json', JSON.stringify(await encryptJson(exportable(state), pass)), 'application/json'); return 'Encrypted file downloaded. Commit it to data/private/portfolio.enc.json in your repository.'; })}>Download encrypted file</button>
                <button className="btn" disabled={busy} onClick={() => fileEnc.current?.click()}>Open encrypted file…</button>
                <input ref={fileEnc} type="file" accept=".json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f && needPass()) run(async () => { applyImport(await decryptJson(JSON.parse(await f.text()), pass), 'Imported encrypted backup file'); return 'Encrypted backup decrypted and loaded.'; }); e.target.value = ''; }} />
              </div>
              <div className="flex flex-wrap gap-2 border-t border-line pt-3">
                <button className="btn" onClick={() => download(`portfolio-backup-${todayNPT()}.json`, JSON.stringify(exportable(state), null, 2), 'application/json')}>Download plain backup (unencrypted)</button>
                <button className="btn" onClick={() => filePlain.current?.click()}>Restore plain backup…</button>
                <input ref={filePlain} type="file" accept=".json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) run(async () => { applyImport(JSON.parse(await f.text()), 'Restored plain backup file'); return 'Backup restored.'; }); e.target.value = ''; }} />
              </div>
              <div className="text-xs text-mute">Keep plain backups off GitHub. The repository's .gitignore blocks portfolio-backup-*.json for that reason.</div>
            </div>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="GitHub repository" hint="owner/name"><input className="input" value={s.sync.repo} placeholder="yourname/nepse-portfolio" onChange={(e) => updateSettings({ sync: { ...s.sync, repo: e.target.value.trim() } })} /></Field>
                <Field label="Branch"><input className="input" value={s.sync.branch} onChange={(e) => updateSettings({ sync: { ...s.sync, branch: e.target.value.trim() } })} /></Field>
                <Field label="File path"><input className="input" value={s.sync.path} onChange={(e) => updateSettings({ sync: { ...s.sync, path: e.target.value.trim() } })} /></Field>
                <Field label="GitHub token (optional)" hint="Fine-grained token limited to this repo, Contents: read & write. Stored in this browser only.">
                  <input className="input" type="password" autoComplete="off" value={s.sync.token} onChange={(e) => updateSettings({ sync: { ...s.sync, token: e.target.value.trim() } })} /></Field>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="btn btn-primary" disabled={busy} onClick={push}>Encrypt & push to GitHub</button>
                <button className="btn" disabled={busy} onClick={pull}>Pull & decrypt from GitHub</button>
              </div>
              <div className="text-xs text-mute">Without a token, use "Download encrypted file" and upload it to the repository yourself. Pull works without a token on a public repository.</div>
            </div>
          </div>
          {msg && <div className="mt-3"><Banner level={msg.level}>{msg.text}</Banner></div>}
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
            <li><code>TELEGRAM_BOT_TOKEN</code> and <code>TELEGRAM_CHAT_ID</code> — from @BotFather (see docs/TELEGRAM_SETUP.md)</li>
            <li><code>PORTFOLIO_PASSPHRASE</code> — the passphrase used above, so the pipeline can read your encrypted holdings</li>
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
