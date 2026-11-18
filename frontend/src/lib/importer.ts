/** Excel/CSV import + export of transactions, with validation and duplicate detection. */
import * as XLSX from 'xlsx';
import type { Txn, TxnType } from './engine';

export const TEMPLATE_COLUMNS = ['Date', 'Symbol', 'Company', 'Type', 'Quantity', 'Price', 'Commission', 'SEBON Fee',
  'DP Charge', 'CGT or Tax', 'Other Charges', 'Broker', 'Notes'];

const ALIASES: Record<string, string[]> = {
  date: ['date', 'transaction date', 'txn date', 'trade date'],
  symbol: ['symbol', 'scrip', 'stock', 'stock symbol', 'ticker'],
  company: ['company', 'company name', 'name'],
  type: ['type', 'transaction type', 'txn type', 'action'],
  qty: ['quantity', 'qty', 'shares', 'units', 'kitta', 'number of shares'],
  price: ['price', 'rate', 'price per share', 'purchase price', 'selling price'],
  commission: ['commission', 'brokerage', 'broker commission', 'brokerage commission'],
  sebon: ['sebon fee', 'sebon', 'sebon commission'],
  dp: ['dp charge', 'dp', 'dp fee'],
  cgt: ['cgt or tax', 'cgt', 'capital gains tax', 'tax', 'capital gain tax'],
  other: ['other charges', 'other', 'other charge'],
  broker: ['broker', 'broker name', 'broker no'],
  notes: ['notes', 'note', 'remarks', 'remark'],
};
const TYPES: Record<string, TxnType> = {
  buy: 'BUY', purchase: 'BUY', secondary: 'BUY', sell: 'SELL', sale: 'SELL', ipo: 'IPO', fpo: 'IPO', auction: 'IPO',
  right: 'RIGHT', rights: 'RIGHT', 'right share': 'RIGHT', bonus: 'BONUS', 'bonus share': 'BONUS',
  dividend: 'DIVIDEND', 'cash dividend': 'DIVIDEND', adjust: 'ADJUST', adjustment: 'ADJUST',
};

export interface ParsedRow { row: number; txn?: Omit<Txn, 'id'>; errors: string[]; duplicate: boolean }

export const txnKey = (t: Pick<Txn, 'date' | 'symbol' | 'type' | 'qty' | 'price'>) =>
  `${t.date}|${t.symbol.toUpperCase().trim()}|${t.type}|${Number(t.qty)}|${Number(t.price)}`;

export function parseDate(v: unknown): { date?: string; error?: string } {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    // SheetJS gives local-midnight dates; shift to avoid off-by-one
    const d = new Date(v.getTime() + 12 * 3600000);
    return check(d.toISOString().slice(0, 10));
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = new Date(Math.round((v - 25569) * 86400000));
    return check(d.toISOString().slice(0, 10));
  }
  const s = String(v ?? '').trim();
  if (!s) return { error: 'Date missing' };
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return check(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a > 12 && b <= 12) return check(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`);
    if (b > 12 && a <= 12) return check(`${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`);
    return { error: `Ambiguous date "${s}" - use YYYY-MM-DD` };
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return check(new Date(d.getTime() + 12 * 3600000).toISOString().slice(0, 10));
  return { error: `Unrecognised date "${s}" - use YYYY-MM-DD` };
}
function check(iso: string) {
  const y = Number(iso.slice(0, 4));
  if (y >= 2060) return { error: `Date ${iso} looks like Bikram Sambat. Enter dates in AD (e.g. 2025-03-14).` };
  if (y < 1994 || Number.isNaN(Date.parse(iso))) return { error: `Invalid date ${iso}` };
  if (iso > new Date(Date.now() + 86400000).toISOString().slice(0, 10)) return { error: `Date ${iso} is in the future` };
  return { date: iso };
}

const toNum = (v: unknown) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[, ]|rs\.?|npr/gi, ''));
  return Number.isNaN(n) ? NaN : n;
};

export function parseRows(raw: Record<string, unknown>[], existing: Txn[], knownSymbols?: Set<string>): ParsedRow[] {
  const seen = new Set(existing.filter((t) => !t.voided).map(txnKey));
  return raw.map((r, i) => {
    const get = (field: string) => {
      const key = Object.keys(r).find((k) => ALIASES[field].includes(k.trim().toLowerCase()));
      return key ? r[key] : undefined;
    };
    const errors: string[] = [];
    const d = parseDate(get('date'));
    if (d.error) errors.push(d.error);
    const symbol = String(get('symbol') ?? '').toUpperCase().trim();
    if (!symbol) errors.push('Symbol missing');
    else if (knownSymbols && knownSymbols.size && !knownSymbols.has(symbol)) errors.push(`Warning: ${symbol} is not in today's NEPSE price list (check spelling; delisted/merged scrips will have no price)`);
    const type = TYPES[String(get('type') ?? '').trim().toLowerCase()];
    if (!type) errors.push(`Type "${get('type') ?? ''}" not recognised (use Buy, Sell, IPO, Right, Bonus, Dividend or Adjust)`);
    const qty = toNum(get('qty'));
    if (qty === null || Number.isNaN(qty) || (qty <= 0 && type !== 'ADJUST')) errors.push('Quantity must be a positive number');
    let price = toNum(get('price'));
    if (type === 'BONUS' && price === null) price = 0;
    if (price === null || Number.isNaN(price) || price < 0) errors.push('Price must be zero or a positive number');
    const opt = (f: string) => { const n = toNum(get(f)); if (Number.isNaN(n)) errors.push(`${f} is not a number`); return n; };
    const txn: Omit<Txn, 'id'> = {
      date: d.date ?? '', symbol, type: type ?? 'BUY', qty: qty ?? 0, price: price ?? 0,
      company: get('company') ? String(get('company')) : undefined,
      commission: opt('commission'), sebon: opt('sebon'), dp: opt('dp'), cgt: opt('cgt'), other: opt('other'),
      broker: get('broker') ? String(get('broker')) : undefined, notes: get('notes') ? String(get('notes')) : undefined,
    };
    const hard = errors.filter((e) => !e.startsWith('Warning'));
    const k = hard.length ? '' : txnKey(txn as Txn);
    const duplicate = !!k && seen.has(k);
    if (k) seen.add(k);
    return { row: i + 2, txn: hard.length ? undefined : txn, errors, duplicate };
  });
}

export async function readFile(file: File): Promise<Record<string, unknown>[]> {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames.find((n) => /transac/i.test(n)) ?? wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });
}

export function txnsToRows(txns: Txn[]) {
  return txns.map((t) => ({
    Date: t.date, Symbol: t.symbol, Company: t.company ?? '', Type: t.type, Quantity: t.qty, Price: t.price,
    Commission: t.commission ?? '', 'SEBON Fee': t.sebon ?? '', 'DP Charge': t.dp ?? '', 'CGT or Tax': t.cgt ?? '',
    'Other Charges': t.other ?? '', Broker: t.broker ?? '', Notes: t.notes ?? '', Status: t.voided ? 'VOIDED' : 'ACTIVE',
  }));
}

export function exportXlsx(filename: string, sheets: Record<string, Record<string, unknown>[]>) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{}]), name.slice(0, 31));
  }
  XLSX.writeFile(wb, filename);
}

export function downloadTemplate() {
  const example = [
    { Date: '2025-01-15', Symbol: 'DEMO', Company: 'DEMO row - delete before importing', Type: 'Buy', Quantity: 100, Price: 500, Commission: '', 'SEBON Fee': '', 'DP Charge': '', 'CGT or Tax': '', 'Other Charges': '', Broker: '', Notes: 'Leave charge columns blank to auto-calculate from the fee schedule' },
  ];
  const help = [
    { Column: 'Date', Rule: 'AD date, YYYY-MM-DD (Excel date cells also work). Not Bikram Sambat.' },
    { Column: 'Type', Rule: 'Buy | Sell | IPO | Right | Bonus | Dividend | Adjust' },
    { Column: 'Quantity', Rule: 'Shares. For Dividend: number of shares the dividend was paid on.' },
    { Column: 'Price', Rule: 'Per share. IPO/Right: issue price (usually 100). Bonus: 0. Dividend: cash dividend per share in Rs (e.g. 10% of Rs 100 par = 10).' },
    { Column: 'Charges', Rule: 'Leave blank to auto-calculate (commission slab, SEBON 0.015%, DP Rs 25, CGT 7.5%/5%). Fill only to override with the contract-note amount.' },
    { Column: 'CGT or Tax', Rule: 'Sell: capital gains tax actually deducted. Dividend: TDS deducted (5%).' },
  ];
  exportXlsx('nepse-transactions-template.xlsx', { Transactions: example, Instructions: help });
}
