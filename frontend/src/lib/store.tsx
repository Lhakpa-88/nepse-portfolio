/**
 * Private app state. Lives ONLY in this browser (localStorage) unless the user
 * explicitly exports it or pushes the ENCRYPTED sync file. Nothing here is ever
 * bundled into the public GitHub Pages site.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import defaultFees from '../../../config/fees.json';
import defaultScoring from '../../../config/scoring.json';
import type { EngineOptions, Fees, Txn } from './engine';

export interface WatchItem {
  symbol: string; list: 'watch' | 'avoid'; buyLow?: number | null; buyHigh?: number | null;
  targetSell?: number | null; notes?: string; addedAt: string;
}
export interface PositionPlan { target?: number | null; stop?: number | null; thesis?: string }
export interface AuditEntry { at: string; action: string; txnId?: string; detail: string }
export interface Settings {
  engine: EngineOptions;
  cash: number;
  depositRatePct: number;
  theme: 'dark' | 'light';
  weights: Record<'fundamental' | 'technical' | 'valuation' | 'market' | 'risk', number>;
  fees: Fees;
  feesCustomised: boolean;
  concentrationPct: number;
  ai: { apiKey: string; model: string };
  sync: { repo: string; branch: string; path: string; token: string };
}
export interface AppState {
  version: 1;
  demo: boolean;
  transactions: Txn[];
  watchlist: WatchItem[];
  plans: Record<string, PositionPlan>;
  settings: Settings;
  audit: AuditEntry[];
}

export const defaultSettings = (): Settings => ({
  engine: { method: 'WACC', bonusCostBasis: 0, bonusTaxBasis: 100 },
  cash: 0,
  depositRatePct: 6,
  theme: 'dark',
  weights: { ...(defaultScoring.weights as Settings['weights']) },
  fees: structuredClone(defaultFees) as unknown as Fees,
  feesCustomised: false,
  concentrationPct: 30,
  ai: { apiKey: '', model: 'claude-sonnet-5-5' },
  sync: { repo: '', branch: 'main', path: 'data/private/portfolio.enc.json', token: '' },
});

export const emptyState = (): AppState => ({
  version: 1, demo: false, transactions: [], watchlist: [], plans: {}, settings: defaultSettings(), audit: [],
});

const KEY = 'nepse-portfolio-state-v1';
export const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function load(): AppState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyState();
    const s = JSON.parse(raw) as AppState;
    const d = defaultSettings();
    s.settings = { ...d, ...s.settings, engine: { ...d.engine, ...s.settings?.engine }, ai: { ...d.ai, ...s.settings?.ai }, sync: { ...d.sync, ...s.settings?.sync } };
    if (!s.settings.feesCustomised) s.settings.fees = d.fees; // pick up shipped schedule updates
    return { ...emptyState(), ...s };
  } catch {
    return emptyState();
  }
}

/** Data that travels in backups / the encrypted sync file (secrets are stripped). */
export function exportable(s: AppState) {
  const { ai, sync, ...rest } = s.settings;
  return { version: 1, exportedAt: new Date().toISOString(), demo: s.demo, transactions: s.transactions,
    watchlist: s.watchlist, plans: s.plans, settings: rest, audit: s.audit };
}

interface Ctx {
  state: AppState;
  setState: (fn: (s: AppState) => AppState) => void;
  addTxns: (txns: Omit<Txn, 'id'>[], source: string) => void;
  correctTxn: (id: string, patch: Partial<Txn>) => void;
  voidTxn: (id: string, reason: string) => void;
  restoreTxn: (id: string) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  setPlan: (symbol: string, plan: PositionPlan) => void;
  upsertWatch: (item: Partial<WatchItem> & { symbol: string }) => void;
  removeWatch: (symbol: string) => void;
  replaceAll: (data: Partial<AppState>, note: string) => void;
  reset: () => void;
}

const StoreContext = createContext<Ctx | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, set] = useState<AppState>(load);
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage blocked: state stays in memory */ }
    document.documentElement.classList.toggle('dark', state.settings.theme === 'dark');
  }, [state]);

  const setState = useCallback((fn: (s: AppState) => AppState) => set(fn), []);
  const log = (s: AppState, action: string, detail: string, txnId?: string): AuditEntry[] =>
    [...s.audit, { at: new Date().toISOString(), action, detail, txnId }].slice(-2000);

  const api = useMemo<Ctx>(() => ({
    state,
    setState,
    addTxns: (txns, source) => set((s) => {
      const now = new Date().toISOString();
      const added = txns.map((t) => ({ ...t, id: uid(), symbol: t.symbol.toUpperCase().trim(), createdAt: now }));
      return { ...s, transactions: [...s.transactions, ...added],
        audit: log(s, 'ADD', `${added.length} transaction(s) via ${source}: ${added.slice(0, 5).map((t) => `${t.type} ${t.qty} ${t.symbol}`).join(', ')}`) };
    }),
    // Corrections never overwrite: the original is voided and a new version supersedes it.
    correctTxn: (id, patch) => set((s) => {
      const old = s.transactions.find((t) => t.id === id);
      if (!old) return s;
      const next: Txn = { ...old, ...patch, id: uid(), supersedes: id, voided: false, createdAt: new Date().toISOString() };
      return { ...s, transactions: [...s.transactions.map((t) => (t.id === id ? { ...t, voided: true } : t)), next],
        audit: log(s, 'CORRECT', `${old.type} ${old.qty} ${old.symbol} @ ${old.price} (${old.date}) -> ${next.type} ${next.qty} ${next.symbol} @ ${next.price} (${next.date})`, id) };
    }),
    voidTxn: (id, reason) => set((s) => {
      const t = s.transactions.find((x) => x.id === id);
      if (!t) return s;
      return { ...s, transactions: s.transactions.map((x) => (x.id === id ? { ...x, voided: true } : x)),
        audit: log(s, 'VOID', `${t.type} ${t.qty} ${t.symbol} @ ${t.price} (${t.date}) - ${reason || 'no reason given'}`, id) };
    }),
    restoreTxn: (id) => set((s) => ({ ...s, transactions: s.transactions.map((x) => (x.id === id ? { ...x, voided: false } : x)),
      audit: log(s, 'RESTORE', `Transaction ${id} restored`, id) })),
    updateSettings: (patch) => set((s) => ({ ...s, settings: { ...s.settings, ...patch } })),
    setPlan: (symbol, plan) => set((s) => ({ ...s, plans: { ...s.plans, [symbol]: { ...s.plans[symbol], ...plan } } })),
    upsertWatch: (item) => set((s) => {
      const ex = s.watchlist.find((w) => w.symbol === item.symbol);
      const merged: WatchItem = { list: 'watch', addedAt: new Date().toISOString(), ...ex, ...item };
      return { ...s, watchlist: ex ? s.watchlist.map((w) => (w.symbol === item.symbol ? merged : w)) : [...s.watchlist, merged] };
    }),
    removeWatch: (symbol) => set((s) => ({ ...s, watchlist: s.watchlist.filter((w) => w.symbol !== symbol) })),
    replaceAll: (data, note) => set((s) => ({
      ...s, ...data, settings: { ...s.settings, ...(data.settings ?? {}), ai: s.settings.ai, sync: s.settings.sync },
      audit: [...(data.audit ?? s.audit), { at: new Date().toISOString(), action: 'IMPORT', detail: note }].slice(-2000),
    })),
    reset: () => set((s) => ({ ...emptyState(), settings: { ...defaultSettings(), theme: s.settings.theme, ai: s.settings.ai, sync: s.settings.sync } })),
  }), [state, setState]);

  return <StoreContext.Provider value={api}>{children}</StoreContext.Provider>;
}

export function useStore(): Ctx {
  const c = useContext(StoreContext);
  if (!c) throw new Error('StoreProvider missing');
  return c;
}
