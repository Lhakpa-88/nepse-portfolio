import { createContext, useContext, useState, type ReactNode } from 'react';
import { HashRouter, NavLink, Route, Routes } from 'react-router-dom';
import { Banner } from './components/ui';
import { StockDetail } from './components/StockDetail';
import { MarketProvider, staleness, useMarket } from './lib/data';
import { fmtTime, num, pct, tone } from './lib/format';
import { StoreProvider, useStore } from './lib/store';
import Assistant from './pages/Assistant';
import BuySell from './pages/BuySell';
import Intelligence from './pages/Intelligence';
import Opportunities from './pages/Opportunities';
import Overview from './pages/Overview';
import Portfolio from './pages/Portfolio';
import Risk from './pages/Risk';
import Screener from './pages/Screener';
import Settings from './pages/Settings';
import Watchlist from './pages/Watchlist';

const NAV = [
  { to: '/', label: 'Overview', el: <Overview /> },
  { to: '/portfolio', label: 'My Portfolio', el: <Portfolio /> },
  { to: '/buy-sell', label: 'Buy/Sell Analysis', el: <BuySell /> },
  { to: '/screener', label: 'Stock Screener', el: <Screener /> },
  { to: '/opportunities', label: 'Investment Opportunities', el: <Opportunities /> },
  { to: '/intelligence', label: 'Market Intelligence', el: <Intelligence /> },
  { to: '/watchlist', label: 'Watchlist', el: <Watchlist /> },
  { to: '/risk', label: 'Risk Analysis', el: <Risk /> },
  { to: '/assistant', label: 'AI Investment Assistant', el: <Assistant /> },
  { to: '/settings', label: 'Settings', el: <Settings /> },
];

const StockCtx = createContext<(symbol: string) => void>(() => undefined);
export const useOpenStock = () => useContext(StockCtx);

function Shell({ children }: { children: ReactNode }) {
  const m = useMarket();
  const { state, updateSettings } = useStore();
  const [menu, setMenu] = useState(false);
  const st = staleness(m);
  const nepse = m.market?.main.find((i) => i.name === 'NEPSE Index');
  return (
    <div className="flex h-full">
      <aside className={`${menu ? 'fixed inset-0 z-40 flex' : 'hidden'} w-full flex-col border-r border-line bg-panel lg:static lg:flex lg:w-60 lg:shrink-0`}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <div className="text-sm font-bold tracking-wide">NEPSE <span className="text-accent">Portfolio Intelligence</span></div>
            <div className="text-[11px] text-mute">Personal research assistant</div>
          </div>
          <button className="btn !px-2 !py-0.5 lg:hidden" onClick={() => setMenu(false)}>✕</button>
        </div>
        <nav className="flex-1 overflow-y-auto p-2">
          {NAV.map((n, i) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} onClick={() => setMenu(false)}
              className={({ isActive }) => `mb-0.5 flex items-center gap-2 rounded-md px-3 py-2 text-sm ${isActive ? 'bg-accent/15 font-semibold text-accent' : 'text-mute hover:bg-line/40 hover:text-ink'}`}>
              <span className="num w-5 text-[11px] opacity-60">{String(i + 1).padStart(2, '0')}</span>{n.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-line p-3 text-[11px] leading-relaxed text-mute">
          Decision support only. Not investment advice, not a guarantee. No orders are ever placed: every trade is your own manual decision.
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-panel px-3 py-2 sm:px-5">
          <button className="btn !px-2 lg:hidden" onClick={() => setMenu(true)} aria-label="Menu">☰</button>
          {nepse?.value ? (
            <div className="num flex items-baseline gap-2">
              <span className="text-xs font-semibold uppercase text-mute">NEPSE</span>
              <span className="text-base font-semibold">{num(nepse.value)}</span>
              <span className={`text-sm ${tone(nepse.pctChange)}`}>{num(nepse.change)} ({pct(nepse.pctChange)})</span>
            </div>
          ) : <span className="text-sm text-mute">NEPSE index unavailable</span>}
          <div className="ml-auto flex items-center gap-2">
            <span className={`hidden text-xs sm:inline ${st.level === 'ok' ? 'text-mute' : st.level === 'warn' ? 'text-warn' : 'text-down'}`}>
              {st.level === 'ok' ? '● ' : '▲ '}{m.loading ? 'Loading market data…' : st.text}
            </span>
            <button className="btn no-print !px-2" title="Reload market data" onClick={m.reload}>↻</button>
            <button className="btn no-print !px-2" title="Toggle light/dark" onClick={() => updateSettings({ theme: state.settings.theme === 'dark' ? 'light' : 'dark' })}>
              {state.settings.theme === 'dark' ? '☀' : '☾'}
            </button>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-3 sm:p-5">
          <div className="mx-auto max-w-[1500px] space-y-4">
            {!m.loading && st.level !== 'ok' && (
              <Banner level={st.level}><b>Data warning:</b> {st.text} Last pipeline run: {fmtTime(m.status?.generatedAt)}.</Banner>
            )}
            {state.demo && (
              <Banner level="info"><b>DEMO portfolio loaded.</b> These transactions are sample data for testing, not your holdings. Market prices shown are real. Clear it in Settings → Data.</Banner>
            )}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  const [symbol, setSymbol] = useState<string | null>(null);
  return (
    <StoreProvider>
      <MarketProvider>
        <StockCtx.Provider value={setSymbol}>
          <HashRouter>
            <Shell>
              <Routes>
                {NAV.map((n) => <Route key={n.to} path={n.to} element={n.el} />)}
                <Route path="*" element={<Overview />} />
              </Routes>
            </Shell>
            {symbol && <StockDetail symbol={symbol} onClose={() => setSymbol(null)} />}
          </HashRouter>
        </StockCtx.Provider>
      </MarketProvider>
    </StoreProvider>
  );
}
