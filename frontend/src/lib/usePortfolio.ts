import { useMemo } from 'react';
import { useMarket, type StockAnalysis } from './data';
import { compute, type EngineResult, type Holding } from './engine';
import { todayNPT } from './format';
import { adviseHolding, type Advice } from './recommend';
import { useStore } from './store';

export interface PortfolioView extends EngineResult {
  held: Holding[];
  weightOf: Record<string, number>;
  sectorOf: (symbol: string) => string;
  sectorPct: Record<string, number>;
  advice: Record<string, Advice>;
  attention: Advice[];
  dayChange: { amount: number; pct: number | null };
  analysisOf: (symbol: string) => StockAnalysis | undefined;
}

export function usePortfolio(): PortfolioView {
  const { state } = useStore();
  const m = useMarket();
  return useMemo(() => {
    const res = compute(state.transactions, state.settings.fees, m.priceMap, state.settings.engine, todayNPT());
    const held = res.holdings.filter((h) => h.qty > 0);
    const total = res.totals.value;
    const sectorOf = (s: string) => m.rowMap[s]?.sector ?? m.analysis?.stocks[s]?.sector ?? 'Unknown';
    const weightOf: Record<string, number> = {};
    const sectorPct: Record<string, number> = {};
    let dayAmt = 0, prevValue = 0;
    for (const h of held) {
      if (h.value && total) {
        weightOf[h.symbol] = (h.value / total) * 100;
        sectorPct[sectorOf(h.symbol)] = (sectorPct[sectorOf(h.symbol)] ?? 0) + weightOf[h.symbol];
      }
      const row = m.rowMap[h.symbol];
      if (row?.prevClose && h.ltp) { dayAmt += (h.ltp - row.prevClose) * h.qty; prevValue += row.prevClose * h.qty; }
    }
    const advice: Record<string, Advice> = {};
    const heldSymbols = held.map((h) => h.symbol);
    for (const h of held) {
      advice[h.symbol] = adviseHolding(h, m.analysis?.stocks[h.symbol], {
        weightPct: weightOf[h.symbol] ?? null, sectorPct: sectorPct[sectorOf(h.symbol)] ?? null,
        plan: state.plans[h.symbol], concentrationPct: state.settings.concentrationPct,
        weights: state.settings.weights, analysis: m.analysis, heldSymbols,
      });
    }
    const rank = (a: Advice) => (a.flags.some((f) => f.level === 'critical') ? 0 : a.action === 'SELL' ? 1 : a.action === 'REDUCE' ? 2 : a.flags.some((f) => f.level === 'warn') ? 3 : 9);
    const attention = Object.values(advice).filter((a) => rank(a) < 9).sort((a, b) => rank(a) - rank(b));
    return { ...res, held, weightOf, sectorOf, sectorPct, advice, attention,
      dayChange: { amount: dayAmt, pct: prevValue ? (dayAmt / prevValue) * 100 : null },
      analysisOf: (s: string) => m.analysis?.stocks[s] };
  }, [state.transactions, state.settings, state.plans, m.priceMap, m.rowMap, m.analysis]);
}
