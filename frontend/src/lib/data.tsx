/** Loads the public market-data JSON files produced by the Python pipeline. Never fabricates values. */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export interface PriceRow {
  symbol: string; name: string | null; sector: string | null; open: number | null; high: number | null;
  low: number | null; ltp: number; prevClose: number | null; pctChange: number | null; volume: number | null;
  turnover: number | null; transactions: number | null; asOf: string;
  /** true = no trade yet in the latest session: `ltp` is the real closing price of the date in `asOf` */
  carried?: boolean;
}
export interface IndexRow { name: string; value: number | null; prev: number | null; change: number | null; pctChange: number | null; high?: number | null; low?: number | null; turnover?: number | null }
export interface Scored {
  score: number | null; coverage: number; components: Record<string, number | null>; notes: string[];
  outlook?: string; level?: string; pe?: number | null; pb?: number | null; divYield?: number | null;
}
export interface Levels { entryLow: number; entryHigh: number; upsideTarget: number | null; upsidePct: number | null; downsideLevel: number; downsidePct: number; stopLoss: number; basis: string }
export interface StockAnalysis {
  symbol: string; name: string | null; sector: string | null; price: number; pctChange: number | null;
  carried?: boolean; lastTraded?: string | null;
  quality: number | null; trading: number | null; confidence: number; stance: string; incomplete: boolean; dataGaps: string[];
  fundamental: Scored; technical: Scored; valuation: Scored; market: Scored; risk: Scored;
  tech: Record<string, any>; fundamentals: Record<string, any> | null; levels: Levels | null;
  horizon: { long: string; short: string }; categories: string[];
}
export interface SectorPerf { sector: string; count: number; avgDayChange: number | null; avgRet1m: number | null; indexDayChange: number | null; medianPE: number | null; medianPB: number | null; medianROE: number | null }
export interface Analysis {
  generatedAt: string; marketDate: string; weights: Record<string, number>; thresholds: Record<string, number>;
  /** while a session is open, indicators and signals are built from completed sessions only (through this date) */
  sessionInProgress?: boolean; indicatorsThrough?: string | null;
  regime: { score: number | null; label: string; components: Record<string, number>; nepse: Record<string, number | null> };
  sectorPerformance: SectorPerf[]; categories: Record<string, string>; top10: { symbol: string; rankScore: number }[];
  methodology: string; coverage: { stocks: number; withFundamentals: number; with200d: number };
  stocks: Record<string, StockAnalysis>;
}
export interface NewsItem {
  id: string; title: string; url: string; source: string; publishedAt: string | null; symbols: string[];
  sectors: string[]; category: string; impact: 'Critical' | 'High' | 'Moderate' | 'General';
  sentiment: 'Positive' | 'Negative' | 'Neutral'; confirmed: boolean; why: string; action?: string | null;
}
export interface Status {
  generatedAt: string; nepalTime: string; session: string; marketDate: string | null; reliability: string; disclaimer: string;
  freshness: { state: 'fresh' | 'delayed' | 'stale' | 'unavailable'; expected: string; lagTradingDays: number | null; message: string };
  capabilities: Record<string, any>; lastSuccess: Record<string, string>; chain: Record<string, string[]>;
}
export interface PricesFile { marketDate: string; asOf: string; source: string; fetchedAt: string; traded?: number; carried?: number; rows: PriceRow[] }

/** "17 Nov" for a YYYY-MM-DD date. */
export const shortDate = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
};
export interface MarketFile { main: IndexRow[]; sectors: IndexRow[]; summary: Record<string, number | null>; breadth?: { advancers: number; decliners: number; unchanged: number }; source: string }
export interface NewsFile { generatedAt: string; items: NewsItem[]; sources: Record<string, any> }
export interface Market {
  loading: boolean; error: string | null; status: Status | null; prices: PricesFile | null; market: MarketFile | null;
  analysis: Analysis | null; news: NewsFile | null; priceMap: Record<string, number>; rowMap: Record<string, PriceRow>;
  reload: () => void;
}
export type HistRow = [string, number | null, number | null, number | null, number, number | null];

const BASE = `${import.meta.env.BASE_URL}data/`;
async function get<T>(file: string): Promise<T | null> {
  try {
    const r = await fetch(`${BASE}${file}?t=${Math.floor(Date.now() / 300000)}`, { cache: 'no-cache' });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

const histCache = new Map<string, Promise<HistRow[]>>();
/** Daily rows [date, open, high, low, close, volume] ascending; [] when unavailable. */
export function loadHistory(symbol: string): Promise<HistRow[]> {
  if (!histCache.has(symbol)) {
    const file = `history/${symbol.replace(/[^A-Za-z0-9_-]/g, '_')}.json`;
    histCache.set(symbol, get<{ rows: HistRow[] }>(file).then((h) => h?.rows ?? []));
  }
  return histCache.get(symbol)!;
}

export function useHistories(symbols: string[]): Record<string, HistRow[]> | null {
  const key = [...symbols].sort().join(',');
  const [out, setOut] = useState<Record<string, HistRow[]> | null>(null);
  useEffect(() => {
    let live = true;
    setOut(null);
    Promise.all(symbols.map((s) => loadHistory(s).then((rows) => [s, rows] as const))).then((all) => {
      if (live) setOut(Object.fromEntries(all));
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return out;
}

const MarketContext = createContext<Market | null>(null);
type Loaded = Omit<Market, 'reload'>;

export function MarketProvider({ children }: { children: ReactNode }) {
  const [tick, setTick] = useState(0);
  const [m, setM] = useState<Loaded>({ loading: true, error: null, status: null, prices: null, market: null, analysis: null, news: null, priceMap: {}, rowMap: {} });
  useEffect(() => {
    let live = true;
    (async () => {
      const [status, prices, market, analysis, news] = await Promise.all([
        get<Status>('status.json'), get<PricesFile>('prices.json'), get<MarketFile>('market.json'),
        get<Analysis>('analysis.json'), get<NewsFile>('news.json'),
      ]);
      if (!live) return;
      const priceMap: Record<string, number> = {};
      const rowMap: Record<string, PriceRow> = {};
      for (const r of prices?.rows ?? []) { priceMap[r.symbol] = r.ltp; rowMap[r.symbol] = r; }
      setM({
        loading: false,
        error: prices ? null : 'Market data files are not available yet. Run the data pipeline (see README). No prices are shown rather than invented ones.',
        status, prices, market, analysis, news, priceMap, rowMap,
      });
    })();
    return () => { live = false; };
  }, [tick]);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5 * 60000);
    return () => clearInterval(id);
  }, []);
  return <MarketContext.Provider value={{ ...m, reload: () => setTick((t) => t + 1) }}>{children}</MarketContext.Provider>;
}

export function useMarket(): Market {
  const c = useContext(MarketContext);
  if (!c) throw new Error('MarketProvider missing');
  return c;
}

/** Client-side freshness re-check so an old cached status.json cannot hide stale data. */
export function staleness(m: Market): { level: 'ok' | 'warn' | 'bad'; text: string } {
  if (!m.prices || !m.status) return { level: 'bad', text: 'Market data unavailable. No prices are shown.' };
  const f = m.status.freshness;
  const ageH = (Date.now() - Date.parse(m.status.generatedAt)) / 3600000;
  if (ageH > 96) {
    return { level: 'bad', text: `The data pipeline has not run for ${Math.floor(ageH / 24)} days. Prices are from ${m.prices.marketDate} and are STALE.` };
  }
  if (f.state === 'fresh') {
    const open = m.status.session === 'open' && m.analysis?.sessionInProgress !== false;
    const idle = m.prices.carried ? `; ${m.prices.carried} not traded yet show their last close` : '';
    return { level: 'ok', text: `Prices as of ${(m.prices.asOf ?? '').replace('T', ' ')} NPT (${open ? `market open, delayed snapshot${idle}` : 'latest close'})` };
  }
  return { level: f.state === 'delayed' ? 'warn' : 'bad', text: f.message };
}
