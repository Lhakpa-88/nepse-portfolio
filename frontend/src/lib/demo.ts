import type { Txn } from './engine';
import type { PositionPlan, WatchItem } from './store';

/**
 * DEMO sample portfolio for testing only. Symbols are real NEPSE scrips so live
 * prices and analysis work, but the trades, dates and purchase prices below are
 * invented sample data - they are NOT anyone's actual holdings.
 */
export const DEMO_TXNS: Omit<Txn, 'id'>[] = [
  { date: '2025-11-23', symbol: 'NABIL', type: 'BUY', qty: 200, price: 498, notes: 'DEMO' },
  { date: '2025-12-14', symbol: 'NTC', type: 'BUY', qty: 60, price: 880, notes: 'DEMO' },
  { date: '2026-01-11', symbol: 'SHPC', type: 'BUY', qty: 150, price: 505, notes: 'DEMO' },
  { date: '2026-01-25', symbol: 'NABIL', type: 'BUY', qty: 100, price: 525, notes: 'DEMO second purchase at a different price' },
  { date: '2026-02-15', symbol: 'NLIC', type: 'BUY', qty: 80, price: 760, notes: 'DEMO' },
  { date: '2026-03-08', symbol: 'UPPER', type: 'BUY', qty: 300, price: 205, notes: 'DEMO' },
  { date: '2026-04-19', symbol: 'SHPC', type: 'SELL', qty: 50, price: 560, notes: 'DEMO partial sale' },
  { date: '2026-05-10', symbol: 'CBBL', type: 'BUY', qty: 40, price: 980, notes: 'DEMO' },
  { date: '2026-06-14', symbol: 'HRL', type: 'IPO', qty: 10, price: 100, notes: 'DEMO IPO allotment' },
  { date: '2026-09-30', symbol: 'NABIL', type: 'BONUS', qty: 15, price: 0, notes: 'DEMO 5% bonus' },
  { date: '2026-10-05', symbol: 'NABIL', type: 'DIVIDEND', qty: 300, price: 10.8, notes: 'DEMO 10.8% cash dividend' },
  { date: '2026-10-18', symbol: 'UPPER', type: 'SELL', qty: 100, price: 190, notes: 'DEMO partial sale at a loss' },
];

export const DEMO_WATCH: WatchItem[] = [
  { symbol: 'SANIMA', list: 'watch', buyLow: 370, buyHigh: 395, targetSell: 450, notes: 'DEMO', addedAt: '2026-10-01T00:00:00Z' },
  { symbol: 'BNT', list: 'watch', notes: 'DEMO', addedAt: '2026-10-01T00:00:00Z' },
];

export const DEMO_PLANS: Record<string, PositionPlan> = {
  NABIL: { target: 600, stop: 480, thesis: 'DEMO: largest private bank, steady earnings growth and dividends' },
  UPPER: { stop: 170, thesis: 'DEMO: turnaround after project repairs' },
};
