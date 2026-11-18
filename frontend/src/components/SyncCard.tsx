/**
 * Guided "send my holdings to the alert pipeline" flow.
 *
 * The first version of this screen hid the action two-thirds of the way down the Settings page and, for a
 * passphrase that was too short, showed its warning far below the button - so the button looked dead.
 * Everything here answers in place: each step says what it needs, buttons explain why they are not ready,
 * and results appear directly under the button that produced them.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { decryptJson, encryptJson } from '../lib/crypto';
import { download, fmtTime, todayNPT } from '../lib/format';
import { exportable, useStore } from '../lib/store';
import { Banner, Card, Field } from './ui';

export const MIN_PASSPHRASE = 12;
const VALID_REPO = /^[\w.-]+\/[\w.-]+$/;
const FROM_GITHUB = 'Loaded the encrypted portfolio from GitHub';
const b64utf8 = (s: string) => btoa(unescape(encodeURIComponent(s)));
const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/** "owner/name" of the repository a GitHub Pages address belongs to, or '' anywhere else. */
export function repoFromLocation(loc: { hostname: string; pathname: string } = window.location): string {
  const owner = loc.hostname.match(/^([a-z0-9-]+)\.github\.io$/i)?.[1];
  const name = loc.pathname.split('/').filter(Boolean)[0];
  return owner && name ? `${owner}/${name}` : '';
}

type Result = { where: 'create' | 'more'; level: 'ok' | 'bad' | 'warn'; text: string };
export type Remote = { state: 'none' | 'checking' | 'found' | 'missing' | 'invalid' | 'exposed' | 'norepo' | 'unknown'; updatedAt?: string };

/**
 * Is this the text of an encrypted portfolio? Anything else at that address makes the pipeline fail, and a
 * plain backup there ("exposed") can be read by anyone who opens the repository.
 */
function describe(text: string): Remote {
  let blob: any = null;
  try { blob = JSON.parse(text); } catch { /* not JSON at all */ }
  if (blob?.ct && blob?.salt && blob?.iv) return { state: 'found', updatedAt: blob.updatedAt };
  return { state: Array.isArray(blob?.transactions) ? 'exposed' : 'invalid' };
}

/**
 * What GitHub holds at the sync address right now.
 *
 * GitHub's API reflects an upload at once. The plain file address (raw.githubusercontent.com) is served from a
 * cache that can be five minutes behind, whatever is added to the address, so it is only trusted to confirm a
 * file while the API is not answering (without a token GitHub answers 60 questions an hour per network).
 * It is never taken as proof that a file is missing.
 */
export async function lookUp(repo: string, branch: string, path: string, token = ''): Promise<Remote> {
  const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/${enc(path)}?ref=${encodeURIComponent(branch)}`,
      { cache: 'no-store', headers: { Accept: 'application/vnd.github.raw+json', ...auth } });
    if (r.ok) return describe(await r.text());
    if (r.status === 404) {
      // "no such file" and "no such repository" look the same; ask which, so a mistyped name is not reported as a missing file
      const visible = await fetch(`https://api.github.com/repos/${repo}`, { cache: 'no-store', headers: { Accept: 'application/vnd.github+json', ...auth } });
      return { state: visible.status === 404 ? 'norepo' : 'missing' };
    }
  } catch { /* offline or blocked: the plain address may still answer */ }
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${repo}/${enc(branch)}/${enc(path)}`, { cache: 'no-store' });
    if (r.ok) return describe(await r.text());
  } catch { /* nothing else to try */ }
  return { state: 'unknown' };
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-line p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="num flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-bold text-accent">{n}</span>
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <div className="space-y-2 text-sm">{children}</div>
    </div>
  );
}

export function SyncCard() {
  const { state, updateSettings, replaceAll } = useStore();
  const sync = state.settings.sync;

  // On GitHub Pages the address says which repository this is; a name typed under "More" wins once it is complete.
  const detected = repoFromLocation();
  const typed = sync.repo.trim();
  const repo = VALID_REPO.test(typed) ? typed : detected;
  const repoOk = VALID_REPO.test(repo);
  const branch = sync.branch || 'main';
  const path = sync.path || 'data/private/portfolio.enc.json';
  const file = path.split('/').pop()!;
  const dir = path.split('/').slice(0, -1).join('/');

  const [pass, setPass] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [made, setMade] = useState<'download' | 'copy' | null>(null);
  const [manual, setManual] = useState('');
  const [remote, setRemote] = useState<Remote>({ state: repoOk ? 'checking' : 'none' });
  const asked = useRef(0);
  const fileEnc = useRef<HTMLInputElement>(null);
  const filePlain = useRef<HTMLInputElement>(null);

  const ready = pass.length >= MIN_PASSPHRASE;
  const active = state.transactions.filter((t) => !t.voided).length;
  // the last change made in this browser; loading GitHub's own copy is not a change
  const lastChange = [...state.audit].reverse().find((a) => !(a.action === 'IMPORT' && a.detail === FROM_GITHUB))?.at;
  const stale = remote.state === 'found' && !!lastChange && !!remote.updatedAt && lastChange > remote.updatedAt;
  const exists = remote.state === 'found' || remote.state === 'invalid' || remote.state === 'exposed';

  const gh = `https://github.com/${repo}`;
  const uploadUrl = [gh, 'upload', enc(branch), enc(dir)].filter(Boolean).join('/');
  const pasteUrl = exists ? [gh, 'edit', enc(branch), enc(path)].join('/')
    : `${[gh, 'new', enc(branch), enc(dir)].filter(Boolean).join('/')}?filename=${encodeURIComponent(file)}`;
  const secretUrl = `${gh}/settings/secrets/actions/new`;

  const checkRemote = useCallback(async () => {
    const mine = ++asked.current;
    if (!repoOk) { setRemote({ state: 'none' }); return; }
    setRemote({ state: 'checking' });
    const found = await lookUp(repo, branch, path, sync.token);
    if (mine === asked.current) setRemote(found);          // otherwise a newer question is already on its way
  }, [repo, repoOk, branch, path, sync.token]);
  useEffect(() => {
    // the repository, branch and path can be typed: wait for a pause instead of asking GitHub on every keystroke
    const t = window.setTimeout(() => { void checkRemote(); }, 500);
    return () => window.clearTimeout(t);
  }, [checkRemote]);

  const act = async (where: Result['where'], fn: () => Promise<string | Result>) => {
    setBusy(true);
    setResult(null);
    try {
      const out = await fn();
      setResult(typeof out === 'string' ? { where, level: 'ok', text: out } : out);
    } catch (e) {
      setResult({ where, level: 'bad', text: (e as Error).message });
    }
    setBusy(false);
  };
  const encrypted = async () => JSON.stringify(await encryptJson(exportable(state), pass));

  const doDownload = () => act('create', async () => {
    download(file, await encrypted(), 'application/json');
    setMade('download');
    setManual('');
    return `Saved as ${file}. Look in your Downloads folder, then go to step 3.`;
  });
  const doCopy = () => act('create', async () => {
    const text = await encrypted();
    setMade('copy');
    try {
      await navigator.clipboard.writeText(text);
      setManual('');
      return 'Copied. Go to step 3 and paste it.';
    } catch {
      setManual(text);
      return { where: 'create', level: 'warn', text: 'Your browser did not allow automatic copying. Click in the box below, select everything (Ctrl+A), copy it (Ctrl+C), then go to step 3.' };
    }
  });

  // ---- "More": bringing a portfolio into this browser, and one-click sending ----
  const unchanged: Result = { where: 'more', level: 'warn', text: 'Nothing was changed.' };
  /** Replacing what this browser holds cannot be undone, so real transactions are never overwritten without a yes. */
  const okToReplace = (source: string) => state.demo || active === 0
    || window.confirm(`Replace the ${active} transaction${active === 1 ? '' : 's'} in this browser with ${source}? Download a plain backup first if unsure.`);
  const applyImport = (data: any, note: string) => {
    if (!data || !Array.isArray(data.transactions)) throw new Error('That file does not contain a portfolio.');
    replaceAll({ transactions: data.transactions, watchlist: data.watchlist ?? [], plans: data.plans ?? {}, demo: !!data.demo, audit: data.audit, settings: data.settings }, note);
  };
  const needPass = () => { if (!ready) throw new Error(`Type your passphrase in step 1 first (at least ${MIN_PASSPHRASE} characters).`); };
  const parseEncrypted = (text: string, where: string) => {
    try { return JSON.parse(text); } catch { throw new Error(`${where} is not an encrypted portfolio.`); }
  };
  const github = async (method: 'GET' | 'PUT', opts: { raw?: boolean; body?: unknown } = {}) => {
    if (!repoOk) throw new Error('Fill in the repository first, as owner/name.');
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/${enc(path)}${method === 'GET' ? `?ref=${encodeURIComponent(branch)}` : ''}`, {
      method,
      cache: 'no-store',
      headers: { Accept: opts.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', ...(sync.token ? { Authorization: `Bearer ${sync.token}` } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (r.status === 404 && method === 'GET') return null;
    if ((r.status === 403 || r.status === 429) && r.headers.get('x-ratelimit-remaining') === '0') {
      throw new Error('GitHub has stopped answering this network for up to an hour (too many requests). Try again later.');
    }
    if (!r.ok) throw new Error(`GitHub refused the request (${r.status}). Check the repository name, the branch, and that the token allows "Contents: read and write" for this repository.`);
    return r;
  };
  const push = () => act('more', async () => {
    needPass();
    if (!sync.token) throw new Error('One-click sending needs a GitHub token. Without one, use steps 2 and 3 above.');
    const existing = await github('GET');
    const sha = existing ? (await existing.json()).sha : undefined;
    await github('PUT', { body: { message: 'Update encrypted portfolio', content: b64utf8(await encrypted()), branch, sha } });
    void checkRemote();
    return `Encrypted portfolio sent to ${repo}. The pipeline run that follows will use it.`;
  });
  const pull = () => act('more', async () => {
    needPass();
    const f = await github('GET', { raw: true });
    if (!f) throw new Error('GitHub does not have an encrypted file yet.');
    const data = await decryptJson(parseEncrypted(await f.text(), 'The file on GitHub'), pass);
    if (!okToReplace('the copy from GitHub')) return unchanged;
    applyImport(data, FROM_GITHUB);
    return 'Your portfolio was loaded from GitHub into this browser.';
  });
  const openEncrypted = (f: File) => act('more', async () => {
    needPass();
    const data = await decryptJson(parseEncrypted(await f.text(), 'That file'), pass);
    if (!okToReplace('the ones in that file')) return unchanged;
    applyImport(data, 'Loaded an encrypted portfolio file');
    return 'The encrypted file was decrypted and loaded into this browser.';
  });
  const restorePlain = (f: File) => act('more', async () => {
    let data;
    try { data = JSON.parse(await f.text()); } catch { throw new Error('That file is not a portfolio backup.'); }
    if (!okToReplace('the ones in that backup')) return unchanged;
    applyImport(data, 'Restored a plain backup file');
    return 'Backup restored.';
  });

  const uploadOption = (
    <div key="upload">
      <a className={`btn ${made !== 'copy' ? 'btn-primary' : ''}`} href={uploadUrl} target="_blank" rel="noreferrer noopener">Open the upload page ↗</a>
      <div className="mt-1 text-xs text-mute">
        If you downloaded: drop <code>{file}</code> onto that page, then click <b>Commit changes</b>.{exists ? ' It replaces the file that is there.' : ''}
      </div>
    </div>
  );
  const pasteOption = (
    <div key="paste">
      <a className={`btn ${made === 'copy' ? 'btn-primary' : ''}`} href={pasteUrl} target="_blank" rel="noreferrer noopener">Open GitHub to paste ↗</a>
      <div className="mt-1 text-xs text-mute">
        If you copied: click in the large text box, {exists ? 'select everything (Ctrl+A), ' : ''}paste (Ctrl+V), click <b>Commit changes…</b>,
        then <b>Commit changes</b> in the box that opens.
        {remote.state === 'unknown' && ' If GitHub says the file already exists, use the upload page instead: it replaces the old file.'}
      </div>
    </div>
  );

  const hint = pass.length === 0 ? `At least ${MIN_PASSPHRASE} characters. Five random words work well.`
    : !ready ? `${MIN_PASSPHRASE - pass.length} more character${MIN_PASSPHRASE - pass.length === 1 ? '' : 's'} needed (at least ${MIN_PASSPHRASE}).`
      : 'Long enough.';

  return (
    <Card title="Send my holdings to the alert pipeline (encrypted)" className="xl:col-span-2">
      <p className="mb-3 text-sm text-mute">
        Your transactions stay in this browser. For alerts about <b className="text-ink">your</b> positions, the pipeline on GitHub needs a copy,
        which you give it encrypted with a passphrase only you know. Repeat these three steps whenever you add a transaction or change a target or stop price.
      </p>
      {state.demo && <div className="mb-3"><Banner level="warn">The DEMO portfolio is loaded. This would send sample data, not your holdings.</Banner></div>}
      {!state.demo && active === 0 && <div className="mb-3"><Banner level="warn">You have no transactions yet. Add them on the My Portfolio page first, otherwise the file has nothing for the pipeline to work with.</Banner></div>}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Step n={1} title="Type your passphrase">
          <div className="flex gap-2">
            <input className="input" aria-label="Passphrase" type={show ? 'text' : 'password'} autoComplete="new-password" value={pass}
              onChange={(e) => setPass(e.target.value)} placeholder={`at least ${MIN_PASSPHRASE} characters`} />
            <button type="button" className="btn shrink-0" onClick={() => setShow((v) => !v)}>{show ? 'Hide' : 'Show'}</button>
          </div>
          <div role="status" className={`text-xs ${ready ? 'text-up' : pass.length ? 'text-warn' : 'text-mute'}`}>{hint}</div>
          <p className="text-xs text-mute">
            Use exactly the passphrase saved in GitHub as the secret <code>PORTFOLIO_PASSPHRASE</code>.
            {repoOk && <> <a className="text-accent underline" href={secretUrl} target="_blank" rel="noreferrer noopener">Add or change that secret ↗</a></>}
          </p>
          <p className="text-xs text-mute">It is not stored anywhere. If you lose it, the encrypted file cannot be recovered, so write it down.</p>
        </Step>

        <Step n={2} title="Create the encrypted file">
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary" disabled={!ready || busy} onClick={doDownload}>Download encrypted file</button>
            <button type="button" className="btn" disabled={!ready || busy} onClick={doCopy}>Copy as text instead</button>
          </div>
          {!ready && <div className="text-xs text-warn">These buttons switch on once the passphrase in step 1 is long enough.</div>}
          {busy && <div className="text-xs text-mute">Working…</div>}
          {result?.where === 'create' && <Banner level={result.level}>{result.text}</Banner>}
          {manual && <textarea className="input h-24 font-mono text-xs" readOnly value={manual} aria-label="Encrypted text to copy" onFocus={(e) => e.currentTarget.select()} />}
          <p className="text-xs text-mute">Either way works. Copying avoids hunting for a downloaded file.</p>
        </Step>

        <Step n={3} title="Put it in your GitHub repository">
          {!detected && (
            <Field label="Your repository" hint="owner/name, for example yourname/nepse-portfolio">
              <input className="input" value={sync.repo} placeholder="yourname/nepse-portfolio" onChange={(e) => updateSettings({ sync: { ...sync, repo: e.target.value.trim() } })} />
            </Field>
          )}
          {repoOk
            // the option matching what was done in step 2 comes first and is highlighted
            ? (made === 'copy' ? [pasteOption, uploadOption] : [uploadOption, pasteOption])
            : <div className="text-xs text-mute">The links to GitHub appear here once the repository is filled in as owner/name.</div>}
          {repoOk && (
            <div className="border-t border-line pt-2 text-xs" role="status">
              {remote.state === 'checking' && <span className="text-mute">Checking GitHub…</span>}
              {remote.state === 'found' && <span className="text-up">GitHub has your encrypted file{remote.updatedAt ? `, created ${fmtTime(remote.updatedAt)}` : ''}.</span>}
              {remote.state === 'invalid' && <span className="text-down">GitHub has a file at that address, but it is not an encrypted portfolio. Create it again in step 2 and replace it.</span>}
              {remote.state === 'exposed' && (
                <span className="font-semibold text-down" role="alert">
                  The file on GitHub is a plain backup, not an encrypted file: anyone who opens the repository can read your holdings.
                  Replace it now with the file from step 2. The old version stays in the repository's history: see
                  "If a readable file was uploaded" in docs/SECURITY.md.
                </span>
              )}
              {remote.state === 'missing' && <span className="text-warn">GitHub does not have an encrypted file yet.</span>}
              {remote.state === 'norepo' && <span className="text-warn">GitHub shows no public repository called {repo}. Check the name under More below; a private repository also needs the token there.</span>}
              {remote.state === 'unknown' && <span className="text-mute">Could not check GitHub just now.</span>}
              {remote.state !== 'checking' && <> <button type="button" className="text-accent underline" onClick={() => void checkRemote()}>Check again</button></>}
              {stale && <span className="mt-1 block text-warn">This browser's portfolio has changed since then. Create and upload a new file so alerts use your current holdings.</span>}
              <span className="mt-1 block text-mute">The pipeline run that follows an upload shows "Your portfolio was loaded" on its page.</span>
            </div>
          )}
        </Step>
      </div>

      <details className="mt-4 rounded-md border border-line p-3">
        <summary className="cursor-pointer text-sm font-medium">More: use another device, one-click sending, plain backup</summary>
        <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="space-y-2">
            <div className="label">Load my portfolio on this device</div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn" disabled={busy} onClick={pull}>Load from GitHub</button>
              <button type="button" className="btn" disabled={busy} onClick={() => fileEnc.current?.click()}>Open encrypted file…</button>
              <input ref={fileEnc} type="file" accept=".json" className="hidden" aria-label="Encrypted file to open" onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void openEncrypted(f);
                e.target.value = '';
              }} />
            </div>
            <div className="text-xs text-mute">Uses the passphrase from step 1. It replaces what this browser currently holds.</div>
          </div>
          <div className="space-y-2">
            <div className="label">One-click sending (optional)</div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Repository"><input className="input" value={sync.repo} placeholder={detected || 'owner/name'} onChange={(e) => updateSettings({ sync: { ...sync, repo: e.target.value.trim() } })} /></Field>
              <Field label="Branch"><input className="input" value={sync.branch} onChange={(e) => updateSettings({ sync: { ...sync, branch: e.target.value.trim() } })} /></Field>
              <Field label="File path"><input className="input" value={sync.path} onChange={(e) => updateSettings({ sync: { ...sync, path: e.target.value.trim() } })} /></Field>
              <Field label="GitHub token"><input className="input" type="password" autoComplete="off" value={sync.token} onChange={(e) => updateSettings({ sync: { ...sync, token: e.target.value.trim() } })} /></Field>
            </div>
            <button type="button" className="btn" disabled={busy} onClick={push}>Encrypt and send to GitHub</button>
            <div className="text-xs text-mute">Replaces steps 2 and 3. Needs a fine-grained token limited to this repository with "Contents: read and write". The token is kept in this browser only.</div>
          </div>
          <div className="space-y-2">
            <div className="label">Plain backup (not encrypted)</div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn" onClick={() => download(`portfolio-backup-${todayNPT()}.json`, JSON.stringify(exportable(state), null, 2), 'application/json')}>Download plain backup</button>
              <button type="button" className="btn" disabled={busy} onClick={() => filePlain.current?.click()}>Restore plain backup…</button>
              <input ref={filePlain} type="file" accept=".json" className="hidden" aria-label="Plain backup to restore" onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void restorePlain(f);
                e.target.value = '';
              }} />
            </div>
            <div className="text-xs text-mute">Anyone who gets this file can read your holdings. Keep it somewhere private, never on GitHub.</div>
          </div>
        </div>
        {result?.where === 'more' && <div className="mt-3"><Banner level={result.level}>{result.text}</Banner></div>}
      </details>
      <p className="mt-3 text-xs text-mute">Encryption: AES-256-GCM, with the key derived from your passphrase by PBKDF2 (600,000 rounds). The public site only ever contains market data.</p>
    </Card>
  );
}
