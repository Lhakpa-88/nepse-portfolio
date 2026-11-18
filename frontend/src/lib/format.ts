export const npr = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined || Number.isNaN(v) ? '—'
    : v.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const rs = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? '—' : `Rs ${npr(v, digits)}`);
export const pct = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined || Number.isNaN(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
export const num = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(digits);
export const signed = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${npr(v, digits)}`;
export const tone = (v: number | null | undefined) =>
  v === null || v === undefined || v === 0 ? 'text-mute' : v > 0 ? 'text-up' : 'text-down';
export const compact = (v: number | null | undefined) => {
  if (v === null || v === undefined) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)} Arba`; // 1 Arba = 1,000,000,000
  if (a >= 1e7) return `${(v / 1e7).toFixed(2)} Cr`; // 1 Crore = 10,000,000
  if (a >= 1e5) return `${(v / 1e5).toFixed(2)} Lakh`;
  return npr(v);
};
export const todayNPT = () => new Date(Date.now() + (5 * 60 + 45) * 60000).toISOString().slice(0, 10);
export const fmtTime = (iso?: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} NPT`;
};
export function download(filename: string, content: string | Blob, mime = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
export function toCsv(rows: Record<string, unknown>[], cols?: string[]) {
  if (!rows.length) return '';
  const keys = cols ?? Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [keys.join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join('\n');
}
