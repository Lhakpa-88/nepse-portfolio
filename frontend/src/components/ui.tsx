import { Component, useMemo, useState, type ReactNode } from 'react';
import { tone } from '../lib/format';

/**
 * Contains a display error to the view it happened in. Without it, one bad value in one component
 * would blank the entire dashboard. The portfolio itself is never touched by a display error.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; what?: string; overlay?: boolean; onClose?: () => void }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('A view failed to display:', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const box = (
      <div className="card w-full max-w-xl p-4" role="alert">
        <div className="text-sm font-semibold text-down">{this.props.what ?? 'This view'} could not be displayed.</div>
        <div className="mt-1 text-sm text-mute">Your portfolio data is not affected. The rest of the dashboard still works.</div>
        <div className="mt-2 rounded bg-bg px-2 py-1 font-mono text-xs text-mute">{String(this.state.error.message).slice(0, 200)}</div>
        <button className="btn mt-3" onClick={() => { this.setState({ error: null }); this.props.onClose?.(); }}>
          {this.props.onClose ? 'Close' : 'Try again'}
        </button>
      </div>
    );
    return this.props.overlay
      ? <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-6">{box}</div>
      : box;
  }
}

export function Card({ title, right, children, className = '' }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || right) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          {right}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Kpi({ label, value, sub, delta, hint }: { label: string; value: ReactNode; sub?: ReactNode; delta?: number | null; hint?: string }) {
  return (
    <div className="card px-4 py-3" title={hint}>
      <div className="text-xs font-medium uppercase tracking-wide text-mute">{label}</div>
      <div className={`num mt-1 text-xl font-semibold ${delta !== undefined ? tone(delta) : ''}`}>{value}</div>
      {sub && <div className="num mt-0.5 text-xs text-mute">{sub}</div>}
    </div>
  );
}

const ACTION_STYLE: Record<string, string> = {
  BUY: 'bg-up/15 text-up', ACCUMULATE: 'bg-up/10 text-up', HOLD: 'bg-accent/15 text-accent',
  REDUCE: 'bg-warn/15 text-warn', SELL: 'bg-down/15 text-down', WATCH: 'bg-mute/15 text-mute',
  Low: 'bg-up/15 text-up', Medium: 'bg-warn/15 text-warn', High: 'bg-down/15 text-down',
  Positive: 'bg-up/15 text-up', Bullish: 'bg-up/15 text-up', Negative: 'bg-down/15 text-down', Bearish: 'bg-down/15 text-down',
  Neutral: 'bg-mute/15 text-mute', Unknown: 'bg-mute/15 text-mute', Sideways: 'bg-mute/15 text-mute',
  Critical: 'bg-down/20 text-down', Moderate: 'bg-accent/15 text-accent', General: 'bg-mute/15 text-mute',
};
export function Badge({ children, kind }: { children: ReactNode; kind?: string }) {
  const k = kind ?? String(children);
  return <span className={`chip ${ACTION_STYLE[k] ?? 'bg-mute/15 text-mute'}`}>{children}</span>;
}

export function Banner({ level, children }: { level: 'ok' | 'warn' | 'bad' | 'info'; children: ReactNode }) {
  const cls = { ok: 'border-up/40 bg-up/10 text-up', warn: 'border-warn/50 bg-warn/10 text-warn', bad: 'border-down/50 bg-down/10 text-down', info: 'border-accent/40 bg-accent/10 text-accent' }[level];
  return <div className={`rounded-md border px-3 py-2 text-sm ${cls}`}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-dashed border-line px-4 py-8 text-center text-sm text-mute">{children}</div>;
}

export function ScoreBar({ value, invert = false }: { value: number | null | undefined; invert?: boolean }) {
  if (value === null || value === undefined) return <span className="text-xs text-mute">n/a</span>;
  const good = invert ? 100 - value : value;
  const color = good >= 60 ? 'bg-up' : good >= 40 ? 'bg-warn' : 'bg-down';
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded bg-line"><div className={`h-full ${color}`} style={{ width: `${Math.max(3, Math.min(100, value))}%` }} /></div>
      <span className="num w-7 text-xs">{value.toFixed(0)}</span>
    </div>
  );
}

export interface Col<T> {
  key: string; header: ReactNode; cell: (row: T) => ReactNode; sort?: (row: T) => number | string | null | undefined;
  align?: 'right' | 'left'; className?: string;
}

export function DataTable<T>({ rows, cols, rowKey, initialSort, onRow, pageSize = 50, empty }: {
  rows: T[]; cols: Col<T>[]; rowKey: (r: T) => string; initialSort?: { key: string; dir: 1 | -1 };
  onRow?: (r: T) => void; pageSize?: number; empty?: ReactNode;
}) {
  const [sort, setSort] = useState(initialSort ?? null);
  const [page, setPage] = useState(0);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = cols.find((c) => c.key === sort.key);
    if (!col?.sort) return rows;
    return [...rows].sort((a, b) => {
      const x = col.sort!(a), y = col.sort!(b);
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [rows, cols, sort]);
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const p = Math.min(page, pages - 1);
  const view = sorted.slice(p * pageSize, (p + 1) * pageSize);
  if (!rows.length) return <Empty>{empty ?? 'Nothing to show.'}</Empty>;
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-line">
              {cols.map((c) => (
                <th key={c.key} className={`th ${c.align === 'right' ? 'text-right' : ''} ${c.sort ? 'cursor-pointer select-none hover:text-ink' : ''}`}
                  onClick={() => c.sort && setSort((s) => ({ key: c.key, dir: s?.key === c.key ? (s.dir === 1 ? -1 : 1) : -1 }))}>
                  {c.header}{sort?.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.map((r) => (
              <tr key={rowKey(r)} className={`border-b border-line/60 ${onRow ? 'cursor-pointer hover:bg-accent/5' : ''}`} onClick={() => onRow?.(r)}>
                {cols.map((c) => <td key={c.key} className={`td num ${c.align === 'right' ? 'text-right' : ''} ${c.className ?? ''}`}>{c.cell(r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="mt-3 flex items-center justify-end gap-2 text-xs text-mute">
          <span>{sorted.length} rows</span>
          <button className="btn !px-2 !py-0.5" disabled={p === 0} onClick={() => setPage(p - 1)}>Prev</button>
          <span>{p + 1} / {pages}</span>
          <button className="btn !px-2 !py-0.5" disabled={p >= pages - 1} onClick={() => setPage(p + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-mute">{hint}</span>}
    </label>
  );
}

export function Modal({ title, onClose, children, wide = false }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-3 sm:p-6" onClick={onClose}>
      <div className={`card w-full ${wide ? 'max-w-5xl' : 'max-w-2xl'} shadow-xl`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button className="btn !px-2 !py-0.5" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)}
          className={`rounded-md px-3 py-1.5 text-sm font-medium ${value === o.value ? 'bg-accent/15 text-accent' : 'text-mute hover:text-ink'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Chart colours resolved from the active theme. */
export function chartColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => `rgb(${css.getPropertyValue(n).trim().split(' ').join(',')})`;
  return { ink: v('--ink'), mute: v('--mute'), line: v('--line'), accent: v('--accent'), up: v('--up'), down: v('--down'), warn: v('--warn'), panel: v('--panel'),
    series: ['#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#f472b6', '#fb923c', '#60a5fa', '#4ade80', '#e879f9', '#facc15', '#2dd4bf', '#f87171'] };
}
export const tooltipStyle = () => {
  const c = chartColors();
  return { contentStyle: { background: c.panel, border: `1px solid ${c.line}`, borderRadius: 6, fontSize: 12, color: c.ink }, labelStyle: { color: c.mute }, itemStyle: { color: c.ink } };
};
