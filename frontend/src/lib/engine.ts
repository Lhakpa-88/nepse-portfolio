/**
 * Portfolio accounting engine (TypeScript mirror of backend/portfolio.py).
 * Both are verified against tests/fixtures/portfolio_cases.json (hand-computed).
 * See docs/CALCULATIONS.md for every formula.
 */
export type TxnType = 'BUY' | 'SELL' | 'IPO' | 'RIGHT' | 'BONUS' | 'DIVIDEND' | 'ADJUST';

export interface Txn {
  id: string;
  date: string; // YYYY-MM-DD
  symbol: string;
  company?: string;
  type: TxnType;
  qty: number;
  price: number;
  commission?: number | null; // overrides; blank = auto from fee schedule
  sebon?: number | null;
  dp?: number | null;
  cgt?: number | null; // CGT on SELL, TDS on DIVIDEND
  other?: number | null;
  broker?: string;
  notes?: string;
  voided?: boolean;
  supersedes?: string;
  createdAt?: string;
}

export interface FeeSchedule {
  effectiveFrom: string;
  label?: string;
  commissionSlabs: { upTo: number | null; rate: number }[];
  minCommission: number;
  sebonRate: number;
  dpCharge: number;
  cgt: { shortTermRate: number; longTermRate: number; longTermDays: number };
  dividendTaxRate: number;
}
export interface Fees { schedules: FeeSchedule[] }
export interface EngineOptions { method: 'WACC' | 'FIFO'; bonusCostBasis: number; bonusTaxBasis: number }
export const DEFAULT_OPTIONS: EngineOptions = { method: 'WACC', bonusCostBasis: 0, bonusTaxBasis: 100 };

interface Lot { date: string; qty: number; unitCost: number; unitTax: number }
export interface SaleEstimate {
  gross: number; commission: number; sebon: number; dp: number; cgt: number; costRemoved: number;
  taxCostRemoved: number; taxableGain: number; netProceeds: number; profit: number;
  longTermQty: number; shortTermQty: number;
}
export interface Position {
  symbol: string; qty: number; cost: number; taxCost: number; lots: Lot[]; realized: number;
  dividendGross: number; dividendTax: number; dividendNet: number; bonusQty: number; rightQty: number;
  totalBought: number; firstDate: string | null;
  fees: { commission: number; sebon: number; dp: number; cgt: number; other: number };
}
export interface Holding extends Position {
  avgCost: number; ltp: number | null; value: number | null; unrealized: number | null;
  unrealizedPct: number | null; sellNow: SaleEstimate | null;
}
export interface PnlEvent { date: string; symbol: string; kind: 'SELL' | 'DIVIDEND'; amount: number; qty?: number; price?: number; costRemoved?: number; cgt?: number }
export interface EngineError { id?: string; symbol: string; date: string; message: string }
export interface Totals {
  cost: number; value: number; unrealized: number; realized: number; dividendNet: number; dividendGross: number;
  dividendTax: number; bonusQty: number; rightQty: number; commission: number; sebon: number; dp: number;
  cgt: number; other: number; unpricedCost: number; netIfSold: number; fees: number; netReturn: number;
  totalBuyCost: number; netReturnPct: number | null; unrealizedPct: number | null; holdingCount: number;
}
export interface EngineResult { holdings: Holding[]; totals: Totals; events: PnlEvent[]; errors: EngineError[]; options: EngineOptions }

export const r2 = (x: number) => Math.round((x + 1e-9) * 100) / 100;

export function scheduleFor(fees: Fees, d: string): FeeSchedule {
  const sorted = [...fees.schedules].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  let best = sorted[0];
  for (const s of sorted) if (s.effectiveFrom <= d) best = s;
  return best;
}

export function commission(s: FeeSchedule, amount: number): number {
  if (amount <= 0) return 0;
  for (const slab of s.commissionSlabs) {
    if (slab.upTo === null || amount <= slab.upTo) return r2(Math.max(s.minCommission ?? 0, amount * slab.rate));
  }
  return 0;
}

export function tradeCharges(s: FeeSchedule, amount: number) {
  return { commission: commission(s, amount), sebon: r2(amount * s.sebonRate), dp: amount > 0 ? s.dpCharge : 0 };
}

const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const num = (v: number | null | undefined) => (v === null || v === undefined || (v as unknown) === '' || Number.isNaN(Number(v)) ? null : Number(v));

export function newPosition(symbol: string): Position {
  return {
    symbol, qty: 0, cost: 0, taxCost: 0, lots: [], realized: 0, dividendGross: 0, dividendTax: 0, dividendNet: 0,
    bonusQty: 0, rightQty: 0, totalBought: 0, firstDate: null,
    fees: { commission: 0, sebon: 0, dp: 0, cgt: 0, other: 0 },
  };
}

/** Charges, CGT and net result of selling `qty` at `price` on date `on`. */
export function estimateSale(pos: Position, qty: number, price: number, on: string, fees: Fees,
  method: 'WACC' | 'FIFO' = 'WACC', consume = false): SaleEstimate {
  const s = scheduleFor(fees, on);
  const gross = qty * price;
  const ch = tradeCharges(s, gross);
  const avgCost = pos.qty ? pos.cost / pos.qty : 0;
  const avgTax = pos.qty ? pos.taxCost / pos.qty : 0;
  const netPerShare = qty ? (gross - ch.commission - ch.sebon) / qty : 0;
  let remaining = qty, costRemoved = 0, taxRemoved = 0, cgt = 0, longQty = 0;
  const lots = consume ? pos.lots : pos.lots.map((l) => ({ ...l }));
  for (const lot of lots) {
    if (remaining <= 1e-9) break;
    const q = Math.min(lot.qty, remaining);
    if (q <= 0) continue;
    const unitCost = method === 'FIFO' ? lot.unitCost : avgCost;
    const unitTax = method === 'FIFO' ? lot.unitTax : avgTax;
    const isLong = days(lot.date, on) > s.cgt.longTermDays;
    cgt += (q * netPerShare - q * unitTax) * (isLong ? s.cgt.longTermRate : s.cgt.shortTermRate);
    costRemoved += q * unitCost;
    taxRemoved += q * unitTax;
    if (isLong) longQty += q;
    lot.qty -= q;
    remaining -= q;
  }
  if (consume) pos.lots = pos.lots.filter((l) => l.qty > 1e-9);
  cgt = r2(Math.max(0, cgt));
  const netProceeds = gross - ch.commission - ch.sebon - ch.dp - cgt;
  return {
    gross, ...ch, cgt, costRemoved, taxCostRemoved: taxRemoved, taxableGain: gross - ch.commission - ch.sebon - taxRemoved,
    netProceeds, profit: netProceeds - costRemoved, longTermQty: longQty, shortTermQty: qty - longQty,
  };
}

export function compute(transactions: Txn[], fees: Fees, prices: Record<string, number> = {},
  options: Partial<EngineOptions> = {}, today: string = new Date().toISOString().slice(0, 10)): EngineResult {
  const opt = { ...DEFAULT_OPTIONS, ...options };
  const positions = new Map<string, Position>();
  const events: PnlEvent[] = [];
  const errors: EngineError[] = [];
  let totalBuyCost = 0;

  const live = transactions.filter((t) => !t.voided).map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.date.localeCompare(b.t.date) || a.i - b.i);
  for (const { t } of live) {
    const sym = t.symbol.toUpperCase().trim();
    const typ = t.type.toUpperCase() as TxnType;
    const d = t.date;
    const qty = Number(t.qty) || 0, price = Number(t.price) || 0;
    if (!positions.has(sym)) positions.set(sym, newPosition(sym));
    const pos = positions.get(sym)!;
    const s = scheduleFor(fees, d);
    const other = num(t.other) ?? 0;
    const err = (message: string) => errors.push({ id: t.id, symbol: sym, date: d, message });

    if (typ === 'BUY' || typ === 'IPO' || typ === 'RIGHT' || typ === 'BONUS' || typ === 'ADJUST') {
      const amount = qty * price;
      const auto = typ === 'BUY' ? tradeCharges(s, amount) : { commission: 0, sebon: 0, dp: 0 };
      const ch = {
        commission: num(t.commission) ?? auto.commission, sebon: num(t.sebon) ?? auto.sebon, dp: num(t.dp) ?? auto.dp,
      };
      let cost: number, taxCost: number;
      if (typ === 'BONUS') {
        cost = qty * opt.bonusCostBasis; taxCost = qty * opt.bonusTaxBasis; pos.bonusQty += qty;
      } else {
        cost = amount + ch.commission + ch.sebon + ch.dp + other; taxCost = cost;
        if (typ === 'RIGHT') pos.rightQty += qty;
      }
      if (typ === 'ADJUST' && qty < 0) {
        if (-qty > pos.qty + 1e-9) { err(`Adjustment removes ${-qty} shares but only ${pos.qty} held`); continue; }
        const frac = -qty / pos.qty;
        pos.cost -= pos.cost * frac; pos.taxCost -= pos.taxCost * frac; pos.qty += qty;
        let rem = -qty;
        for (const lot of pos.lots) { const q = Math.min(lot.qty, rem); lot.qty -= q; rem -= q; }
        pos.lots = pos.lots.filter((l) => l.qty > 1e-9);
        continue;
      }
      if (qty <= 0) { err('Quantity must be positive'); continue; }
      pos.qty += qty; pos.cost += cost; pos.taxCost += taxCost;
      pos.lots.push({ date: d, qty, unitCost: cost / qty, unitTax: taxCost / qty });
      pos.firstDate = pos.firstDate ?? d;
      if (typ !== 'BONUS') { pos.totalBought += cost; totalBuyCost += cost; }
      pos.fees.commission += ch.commission; pos.fees.sebon += ch.sebon; pos.fees.dp += ch.dp; pos.fees.other += other;
    } else if (typ === 'SELL') {
      if (qty <= 0 || qty > pos.qty + 1e-9) { err(`Cannot sell ${qty} shares; only ${pos.qty} held on ${d}`); continue; }
      const est = estimateSale(pos, qty, price, d, fees, opt.method, true);
      const ch = {
        commission: num(t.commission) ?? est.commission, sebon: num(t.sebon) ?? est.sebon,
        dp: num(t.dp) ?? est.dp, cgt: num(t.cgt) ?? est.cgt,
      };
      const realized = est.gross - ch.commission - ch.sebon - ch.dp - ch.cgt - other - est.costRemoved;
      pos.qty -= qty; pos.cost -= est.costRemoved; pos.taxCost -= est.taxCostRemoved;
      if (pos.qty < 1e-9) { pos.qty = 0; pos.cost = 0; pos.taxCost = 0; pos.lots = []; }
      pos.realized += realized;
      pos.fees.commission += ch.commission; pos.fees.sebon += ch.sebon; pos.fees.dp += ch.dp;
      pos.fees.cgt += ch.cgt; pos.fees.other += other;
      events.push({ date: d, symbol: sym, kind: 'SELL', amount: realized, qty, price, costRemoved: est.costRemoved, cgt: ch.cgt });
    } else if (typ === 'DIVIDEND') {
      const gross = qty * price;
      const tax = num(t.cgt) ?? r2(gross * s.dividendTaxRate);
      pos.dividendGross += gross; pos.dividendTax += tax; pos.dividendNet += gross - tax;
      events.push({ date: d, symbol: sym, kind: 'DIVIDEND', amount: gross - tax });
    } else err(`Unknown type ${typ}`);
  }

  const tot: any = {
    cost: 0, value: 0, unrealized: 0, realized: 0, dividendNet: 0, dividendGross: 0, dividendTax: 0, bonusQty: 0,
    rightQty: 0, commission: 0, sebon: 0, dp: 0, cgt: 0, other: 0, unpricedCost: 0, netIfSold: 0,
  };
  const holdings: Holding[] = [];
  for (const sym of [...positions.keys()].sort()) {
    const p = positions.get(sym)!;
    const ltp = prices[sym] ?? null;
    const h: Holding = { ...p, avgCost: p.qty ? p.cost / p.qty : 0, ltp, value: null, unrealized: null, unrealizedPct: null, sellNow: null };
    if (p.qty > 0 && ltp) {
      h.value = p.qty * ltp;
      h.unrealized = h.value - p.cost;
      h.unrealizedPct = p.cost ? (h.unrealized / p.cost) * 100 : null;
      h.sellNow = estimateSale(p, p.qty, ltp, today, fees, opt.method);
      tot.value += h.value; tot.unrealized += h.unrealized; tot.netIfSold += h.sellNow.netProceeds;
    } else if (p.qty > 0) tot.unpricedCost += p.cost;
    tot.cost += p.cost;
    for (const k of ['realized', 'dividendNet', 'dividendGross', 'dividendTax', 'bonusQty', 'rightQty'] as const) tot[k] += p[k];
    for (const k of ['commission', 'sebon', 'dp', 'cgt', 'other'] as const) tot[k] += p.fees[k];
    holdings.push(h);
  }
  tot.fees = tot.commission + tot.sebon + tot.dp + tot.other;
  tot.netReturn = tot.realized + tot.unrealized + tot.dividendNet;
  tot.totalBuyCost = totalBuyCost;
  tot.netReturnPct = totalBuyCost ? (tot.netReturn / totalBuyCost) * 100 : null;
  tot.unrealizedPct = tot.cost - tot.unpricedCost > 0 ? (tot.unrealized / (tot.cost - tot.unpricedCost)) * 100 : null;
  tot.holdingCount = holdings.filter((h) => h.qty > 0).length;
  return { holdings, totals: tot as Totals, events, errors, options: opt };
}

/** Shares held per symbol at the end of each given date (for portfolio-value-over-time). */
export function positionsOverTime(transactions: Txn[], fees: Fees, options: Partial<EngineOptions>, dates: string[]) {
  const live = transactions.filter((t) => !t.voided);
  return dates.map((d) => {
    const res = compute(live.filter((t) => t.date <= d), fees, {}, options, d);
    // cumulative cash paid in (buys incl. charges) and cash received (net sale proceeds + net dividends)
    const cashOut = res.events.reduce((s, e) => s + (e.kind === 'SELL' ? e.amount + (e.costRemoved ?? 0) : e.amount), 0);
    return { date: d, holdings: res.holdings.filter((h) => h.qty > 0).map((h) => ({ symbol: h.symbol, qty: h.qty, cost: h.cost })),
      realized: res.totals.realized, dividends: res.totals.dividendNet, cost: res.totals.cost,
      cashIn: res.totals.totalBuyCost, cashOut };
  });
}
