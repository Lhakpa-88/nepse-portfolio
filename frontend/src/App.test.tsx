// @vitest-environment jsdom
/**
 * Render tests: every page and the stock detail view are actually rendered with a real sample of the
 * published data (tests/fixtures/site_data), with an empty and with the DEMO portfolio.
 *
 * Why these exist: the first release crashed to a blank page when any stock was opened, because one score
 * block had no `notes` list. Reading page text had not caught it - only rendering the view does.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { ErrorBoundary } from './components/ui';
import { DEMO_PLANS, DEMO_TXNS, DEMO_WATCH } from './lib/demo';

// (in the jsdom environment import.meta.url is an http address, so resolve from the test file's folder instead)
const DATA = resolve(__dirname, '../../tests/fixtures/site_data') + sep;
const SAMPLE = JSON.parse(readFileSync(`${DATA}README.json`, 'utf8')) as { noFundamentals: string; highRisk: string; mutualFund: string; carried: string[] };
const KEY = 'nepse-portfolio-state-v1';
const ROUTES: [string, RegExp][] = [
  ['/', /Market overview/], ['/portfolio', /My Portfolio/], ['/buy-sell', /Buy \/ Sell Analysis/], ['/screener', /Stock Screener/],
  ['/opportunities', /Investment Opportunities/], ['/intelligence', /Market Intelligence/], ['/watchlist', /^Watchlist$/],
  ['/risk', /Risk Analysis/], ['/assistant', /AI Investment Assistant/], ['/settings', /^Settings$/],
];
let problems: string[] = [];
/** simulate data published by an older pipeline version: score blocks without their optional lists */
let legacyData = true;

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const m = String(input).match(/data\/([^?]+)/);
    const file = m ? DATA + m[1] : '';
    if (!file || !existsSync(file)) return { ok: false, status: 404, json: async () => null };
    const body = JSON.parse(readFileSync(file, 'utf8'));
    if (legacyData && m![1] === 'analysis.json') {
      for (const s of Object.values(body.stocks) as any[]) delete s.market.notes;
    }
    return { ok: true, status: 200, json: async () => body };
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = () => undefined;
});

beforeEach(() => {
  localStorage.clear();
  legacyData = true;
  problems = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (!/not wrapped in act|width\(0\) and height\(0\)/.test(text)) problems.push(text.slice(0, 300));
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function useDemoPortfolio(extraWatch: string[] = []) {
  const extra = [...new Set(extraWatch)].filter((s) => !DEMO_WATCH.some((w) => w.symbol === s));   // one entry per symbol
  localStorage.setItem(KEY, JSON.stringify({
    version: 1, demo: true, audit: [], plans: DEMO_PLANS,
    transactions: DEMO_TXNS.map((t, i) => ({ ...t, id: `demo${i}` })),
    watchlist: [...DEMO_WATCH, ...extra.map((symbol) => ({ symbol, list: 'watch', addedAt: '2026-11-01T00:00:00Z' }))],
  }));
}

async function open(route: string) {
  window.location.hash = `#${route}`;
  render(<App />);
  await waitFor(() => expect(screen.queryByText(/Loading market data/)).toBeNull(), { timeout: 8000 });
}

function expectHealthy() {
  expect(screen.queryByText(/could not be displayed/)).toBeNull();
  expect(problems).toEqual([]);
}

const rowOf = (symbol: string) => screen.getAllByText(symbol).map((el) => el.closest('tr')).find(Boolean) as HTMLElement;

async function openDetail(symbol: string) {
  fireEvent.click(rowOf(symbol));
  const dialog = (await screen.findByLabelText('Close')).closest('.card') as HTMLElement;
  await waitFor(() => expect(within(dialog).queryByText(/Loading history/)).toBeNull(), { timeout: 8000 });
  return dialog;
}

describe('every page renders', () => {
  for (const [route, heading] of ROUTES) {
    it(`${route} with an empty portfolio`, async () => {
      await open(route);
      expect(screen.getAllByText(heading).length).toBeGreaterThan(0);
      expectHealthy();
    });
    it(`${route} with the DEMO portfolio`, async () => {
      useDemoPortfolio();
      await open(route);
      expect(screen.getAllByText(heading).length).toBeGreaterThan(0);
      expect(screen.getByText(/DEMO portfolio loaded/)).toBeTruthy();
      expectHealthy();
    });
  }

  it('pages still render when the market data files are missing', async () => {
    (globalThis.fetch as any).mockImplementationOnce(async () => ({ ok: false, status: 404, json: async () => null }));
    useDemoPortfolio();
    await open('/');
    expectHealthy();
  });
});

describe('stock detail view', () => {
  it('opens for a holding and shows the position, the chart area and the score breakdown', async () => {
    useDemoPortfolio();
    await open('/portfolio');
    const dialog = await openDetail('NABIL');
    expect(within(dialog).getByText('Your position')).toBeTruthy();
    expect(within(dialog).getByText(/How the scores were built/)).toBeTruthy();
    expect(within(dialog).getByText(/Market & sector/)).toBeTruthy();
    expectHealthy();
    fireEvent.click(within(dialog).getByLabelText('Close'));
    expect(screen.queryByText(/How the scores were built/)).toBeNull();
  });

  it('opens for every kind of stock: no trade yet today, no fundamentals, high risk, and one that is not analysed', async () => {
    const kinds = [SAMPLE.carried[0], SAMPLE.noFundamentals, SAMPLE.highRisk, SAMPLE.mutualFund];
    useDemoPortfolio(kinds);
    await open('/watchlist');
    for (const symbol of [...new Set(kinds)]) {
      const dialog = await openDetail(symbol);
      expect(within(dialog).getAllByText(new RegExp(symbol)).length).toBeGreaterThan(0);
      expectHealthy();
      fireEvent.click(within(dialog).getByLabelText('Close'));
    }
  });

  it('says so when a stock has not traded yet in the latest session', async () => {
    useDemoPortfolio([SAMPLE.carried[0]]);
    await open('/watchlist');
    const dialog = await openDetail(SAMPLE.carried[0]);
    expect(within(dialog).getByText(/No trade yet in the latest session/)).toBeTruthy();
    expectHealthy();
  });

  it('opens from the screener with data in the current format too', async () => {
    legacyData = false;
    await open('/screener');
    const dialog = await openDetail('NTC');
    expect(within(dialog).getByText(/How the scores were built/)).toBeTruthy();
    expectHealthy();
  });
});

describe('interactions that change what is shown', () => {
  it('adds a transaction through the form and shows the new holding', async () => {
    await open('/portfolio');
    fireEvent.click(screen.getByText('+ Add transaction'));
    fireEvent.change(screen.getByLabelText(/^Symbol/), { target: { value: 'ntc' } });
    fireEvent.change(screen.getByLabelText(/^Quantity/), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText(/^Price per share/), { target: { value: '900' } });
    fireEvent.click(screen.getByText('Save transaction'));
    await waitFor(() => expect(screen.getByText('Holdings (1)')).toBeTruthy());
    expect(rowOf('NTC')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(KEY)!).transactions).toHaveLength(1);
    expectHealthy();
  });

  it('rejects selling more shares than are held', async () => {
    await open('/portfolio');
    fireEvent.click(screen.getByText('+ Add transaction'));
    fireEvent.change(screen.getByLabelText(/^Type/), { target: { value: 'SELL' } });
    fireEvent.change(screen.getByLabelText(/^Symbol/), { target: { value: 'NTC' } });
    fireEvent.change(screen.getByLabelText(/^Quantity/), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText(/^Price per share/), { target: { value: '900' } });
    fireEvent.click(screen.getByText('Save transaction'));
    expect(await screen.findByText(/cannot sell 5/)).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(KEY) ?? '{"transactions":[]}').transactions).toHaveLength(0);
  });

  it('shows the selling and buying calculators and the reasoning behind a signal', async () => {
    useDemoPortfolio();
    await open('/buy-sell');
    fireEvent.click(rowOf('NABIL'));
    expect(await screen.findByText(/What would invalidate this/)).toBeTruthy();
    fireEvent.click(screen.getByText('Selling calculator'));
    expect(await screen.findByText('Break-even selling price')).toBeTruthy();
    expect(screen.getByText('Selling price simulation')).toBeTruthy();
    fireEvent.click(screen.getByText('Buying calculator'));
    expect(await screen.findByText(/Buying calculator — inputs/)).toBeTruthy();
    expectHealthy();
  });

  it('switches opportunity screens and adds a stock to the watchlist', async () => {
    await open('/opportunities');
    fireEvent.click(screen.getByText(/High-Risk Stocks to Avoid/));
    expect(await screen.findByText(/Listed so you can avoid them/)).toBeTruthy();
    fireEvent.click(screen.getByText('Top 10 ranked'));
    fireEvent.click((await screen.findAllByText('+ Watchlist'))[0]);
    await waitFor(() => expect(JSON.parse(localStorage.getItem(KEY)!).watchlist).toHaveLength(1));
    expectHealthy();
  });

  it('answers an assistant question from the data', async () => {
    useDemoPortfolio();
    await open('/assistant');
    fireEvent.click(screen.getByText('What is my current portfolio profit or loss?'));
    expect(await screen.findByText('Portfolio profit / loss')).toBeTruthy();
    expect(screen.getAllByText('Fact').length).toBeGreaterThan(0);
    expectHealthy();
  });
});

describe('the remaining controls', () => {
  const stored = () => JSON.parse(localStorage.getItem(KEY)!);

  it('voids a transaction with a reason and keeps it in the audit trail', async () => {
    useDemoPortfolio();
    vi.stubGlobal('prompt', () => 'entered twice by mistake');
    await open('/portfolio');
    fireEvent.click(screen.getByText('Transactions (12)'));
    fireEvent.click((await screen.findAllByText('Void'))[0]);
    await waitFor(() => expect(screen.getByText('Transactions (11)')).toBeTruthy());
    expect(stored().transactions.filter((t: any) => t.voided)).toHaveLength(1);        // kept, not deleted
    expect(stored().audit.at(-1).detail).toContain('entered twice by mistake');
    fireEvent.click(screen.getByText('Audit trail'));
    expect(await screen.findByText(/entered twice by mistake/)).toBeTruthy();
    expectHealthy();
  });

  it('corrects a transaction by superseding it, never by overwriting', async () => {
    useDemoPortfolio();
    await open('/portfolio');
    fireEvent.click(screen.getByText('Transactions (12)'));
    fireEvent.click((await screen.findAllByText('Correct'))[0]);
    fireEvent.change(await screen.findByLabelText(/^Quantity/), { target: { value: '77' } });
    fireEvent.click(screen.getByText('Save correction'));
    await waitFor(() => expect(stored().transactions).toHaveLength(13));
    const txns = stored().transactions;
    const replacement = txns.find((t: any) => t.supersedes);
    expect(replacement.qty).toBe(77);
    expect(txns.find((t: any) => t.id === replacement.supersedes).voided).toBe(true);
    expect(stored().audit.at(-1).action).toBe('CORRECT');
    expectHealthy();
  });

  it('adds, moves and removes a watchlist stock', async () => {
    await open('/watchlist');
    fireEvent.change(screen.getByPlaceholderText('Add symbol…'), { target: { value: 'sanima' } });
    fireEvent.click(screen.getByText('Add'));
    expect(await screen.findByText('Watchlist (1)')).toBeTruthy();
    expect(stored().watchlist[0].buyHigh).toBeGreaterThan(0);            // prefilled from the analysed entry zone
    fireEvent.click(screen.getByText('→ Avoid'));
    expect(await screen.findByText('Avoid (1)')).toBeTruthy();
    fireEvent.click(screen.getByText('Avoid (1)'));
    fireEvent.click(await screen.findByText('Remove'));
    await waitFor(() => expect(stored().watchlist).toHaveLength(0));
    expectHealthy();
  });

  it('changes scoring weights and saves an edited fee schedule', async () => {
    await open('/settings');
    fireEvent.change(screen.getByLabelText(/^fundamental/i), { target: { value: '40' } });
    expect(await screen.findByText(/Total: 105%/)).toBeTruthy();
    const save = screen.getAllByText('Save').find((b) => b.tagName === 'BUTTON')!;
    fireEvent.click(save);
    expect(await screen.findByText(/Fee schedule saved/)).toBeTruthy();
    expect(stored().settings.weights.fundamental).toBe(40);
    expect(stored().settings.feesCustomised).toBe(true);
    expectHealthy();
  });

  it('filters the news, moves the stress-test slider and switches the theme', async () => {
    useDemoPortfolio();
    await open('/intelligence');
    fireEvent.click(screen.getByText(/^High impact/));
    fireEvent.click(screen.getByLabelText(/Relevant to me only/));
    expectHealthy();
    cleanup();

    await open('/risk');
    const slider = document.querySelector('input[type="range"]') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '-20' } });
    expect(await screen.findByText('-20%')).toBeTruthy();
    const dark = document.documentElement.classList.contains('dark');
    fireEvent.click(screen.getByTitle('Toggle light/dark'));
    await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(!dark));
    expectHealthy();
  });
});

describe('a display error', () => {
  it('is contained to the view it happened in instead of blanking the dashboard', () => {
    const Boom = (): never => { throw new Error('bad value in one view'); };
    render(<div><p>the rest of the page</p><ErrorBoundary what="This view"><Boom /></ErrorBoundary></div>);
    expect(screen.getByText('the rest of the page')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('This view could not be displayed');
    expect(screen.getByRole('alert').textContent).toContain('Your portfolio data is not affected');
  });
});
