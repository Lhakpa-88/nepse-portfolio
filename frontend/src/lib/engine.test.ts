import { describe, expect, it } from 'vitest';
import fees from '../../../config/fees.json';
import fixture from '../../../tests/fixtures/portfolio_cases.json';
import { commission, compute, estimateSale, newPosition, scheduleFor, type Fees, type Txn } from './engine';

const FEES = fees as unknown as Fees;

describe('portfolio engine vs hand-computed DEMO fixtures', () => {
  for (const c of (fixture as any).cases) {
    it(c.name, () => {
      const res = compute(c.transactions as Txn[], FEES, c.prices, c.options, c.today);
      const bySym = Object.fromEntries(res.holdings.map((h) => [h.symbol, h as any]));
      for (const [sym, fields] of Object.entries(c.expected.holdings ?? {})) {
        for (const [k, v] of Object.entries(fields as Record<string, number>)) {
          expect(Math.abs(bySym[sym][k] - v), `${sym}.${k}`).toBeLessThanOrEqual(0.011);
        }
      }
      for (const [k, v] of Object.entries((c.expected.totals ?? {}) as Record<string, number>)) {
        expect(Math.abs((res.totals as any)[k] - v), `totals.${k}`).toBeLessThanOrEqual(0.011);
      }
      expect(res.errors.length).toBe(c.expected.errorCount ?? 0);
    });
  }
});

describe('fees', () => {
  const s = scheduleFor(FEES, '2025-01-01');
  it('commission slabs and minimum', () => {
    expect(commission(s, 50000)).toBe(180);
    expect(commission(s, 50001)).toBe(165);
    expect(commission(s, 1000)).toBe(10);
    expect(commission(s, 3000000)).toBe(8100);
  });
  it('effective-date schedule selection', () => {
    expect(scheduleFor(FEES, '2019-05-01').commissionSlabs[0].rate).toBe(0.004);
    expect(scheduleFor(FEES, '2021-01-01').cgt.shortTermRate).toBe(0.05);
    expect(scheduleFor(FEES, '2024-01-01').cgt.shortTermRate).toBe(0.075);
  });
  it('near break-even sale: charges and CGT match hand calculation', () => {
    const pos = newPosition('X');
    pos.qty = 100; pos.cost = 50212.5; pos.taxCost = 50212.5;
    pos.lots = [{ date: '2024-01-10', qty: 100, unitCost: 502.125, unitTax: 502.125 }];
    const est = estimateSale(pos, 100, 504.2, '2024-02-01', FEES);
    expect(est.profit).toBeCloseTo(6.03, 2); // 50420 - 166.39 - 7.56 - 25 - 2.52 - 50212.5 (hand-computed)
    expect(est.cgt).toBe(2.52); // 7.5% x (50420 - 166.39 - 7.56 - 50212.5)
  });
});
