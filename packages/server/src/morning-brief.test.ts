import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EodReport } from '@trading-app/shared';

// TRA-4303 — the overnight section's two legs are the only I/O in this module.
// Stub them at the module boundary and keep everything else real: `scoreSymbols`
// and `suspectMover` are the code under test for acceptance #1 and #2, so
// replacing them with fakes would test the fake.
const loadLatestEodReportMock = vi.fn<(ctx: unknown) => Promise<EodReport | null>>();
const scanStocksMarketMock = vi.fn();

vi.mock('./premarket-watchlist.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./premarket-watchlist.js')>();
  return { ...actual, loadLatestEodReport: (ctx: unknown) => loadLatestEodReportMock(ctx) };
});
vi.mock('./market-scanner.js', () => ({
  scanStocksMarket: () => scanStocksMarketMock(),
}));

import {
  buildBriefForUser,
  buildOvernightSection,
  getOvernightScan,
  isOvernightSetupsEnabled,
  resetOvernightScanCache,
} from './morning-brief.js';
import type { UserContext } from './user-context.js';

const addSymbolSpy = vi.fn();
const refreshSpy = vi.fn();

// Minimal engine-state stubs — buildBriefForUser only reads getState()/getNews().
function fakeCtx(opts: {
  username?: string;
  stocksSignals?: unknown[];
  cryptoSignals?: unknown[];
  stocksPositions?: unknown[];
  cryptoPositions?: unknown[];
  openOptions?: unknown[];
  stocksNews?: unknown[];
  cryptoNews?: unknown[];
}): UserContext {
  const stocksState = {
    signals: opts.stocksSignals ?? [],
    account: { openPositions: opts.stocksPositions ?? [] },
    options: { openOptions: opts.openOptions ?? [] },
  };
  const cryptoState = {
    signals: opts.cryptoSignals ?? [],
    account: { openPositions: opts.cryptoPositions ?? [] },
  };
  return {
    username: opts.username ?? 'alice',
    engine: {
      getState: () => stocksState,
      getNews: () => opts.stocksNews ?? [],
      // TRA-4303 — spies, so the read-only acceptance (#3) is measured rather
      // than asserted by inspection.
      addSymbol: addSymbolSpy,
      refresh: refreshSpy,
    },
    cryptoEngine: {
      getState: () => cryptoState,
      getNews: () => opts.cryptoNews ?? [],
    },
  } as unknown as UserContext;
}

const MACRO = {
  regime: 'yellow',
  rationale: 'VIX elevated',
  indexes: [{ label: 'VIX', value: 24, note: 'hot' }],
};
const TS = Date.parse('2026-05-17T12:30:00Z');

describe('buildBriefForUser', () => {
  it('threads macro, setups, positions and news into a briefing event', () => {
    const ctx = fakeCtx({
      stocksSignals: [
        { symbol: 'AAPL', type: 'orb_long', side: 'buy', entryPrice: 150, stopLoss: 147, takeProfit: 156, timestamp: 2 },
      ],
      cryptoSignals: [
        { symbol: 'BTC-USD', type: 'momentum', side: 'buy', entryPrice: 65000, stopLoss: 64000, takeProfit: 67000, timestamp: 5 },
      ],
      stocksPositions: [{ symbol: 'MSFT', side: 'buy', quantity: 10, entryPrice: 400 }],
      cryptoPositions: [{ symbol: 'ETH-USD', side: 'buy', quantity: 2, entryPrice: 3140, productType: 'perp' }],
      openOptions: [
        { symbol: 'NVDA', optionType: 'call', strike: 900, expiration: '2026-06-19', contracts: 3, contractsRemaining: 3, premiumPaid: 10, currentPremium: 12 },
      ],
      stocksNews: [{ title: 'Apple ships', source: 'WSJ', publishedAt: '2026-05-17T05:00:00Z' }],
      cryptoNews: [{ title: 'BTC rallies', source: 'CoinDesk', publishedAt: '2026-05-17T06:00:00Z' }],
    });

    const e = buildBriefForUser(ctx, MACRO, '2026-05-17', TS);

    expect(e.kind).toBe('briefing');
    expect(e.username).toBe('alice');
    expect(e.date).toBe('2026-05-17');
    expect(e.macro.regime).toBe('yellow');

    // Setups sorted newest-first (BTC ts=5 before AAPL ts=2).
    expect(e.setups.map((s) => s.symbol)).toEqual(['BTC-USD', 'AAPL']);

    // Positions: stocks, crypto (perp tagged), options (with estimated P&L).
    expect(e.positions.map((p) => p.market)).toEqual(['stocks', 'crypto', 'options']);
    expect(e.positions[1]?.detail).toBe('perp');
    const opt = e.positions[2]!;
    expect(opt.detail).toBe('call 900 2026-06-19');
    expect(opt.pnl).toBeCloseTo((12 - 10) * 3 * 100); // +$600

    // News merged + recency-sorted (crypto 06:00 before stocks 05:00).
    expect(e.news.map((n) => n.title)).toEqual(['BTC rallies', 'Apple ships']);
  });

  it('dedupes news by title and caps the list', () => {
    // Two newest items share a title (must collapse); rest are unique fillers.
    const dupNews = Array.from({ length: 10 }, (_, i) => ({
      title: i < 2 ? 'Same headline' : `Headline ${i}`,
      source: 'X',
      // Higher i → earlier time, so i=0 and i=1 are the two most recent.
      publishedAt: `2026-05-17T${String(20 - i).padStart(2, '0')}:00:00Z`,
    }));
    const ctx = fakeCtx({ stocksNews: dupNews });
    const e = buildBriefForUser(ctx, MACRO, '2026-05-17', TS);
    // Capped at 6 and the duplicate title collapses to one.
    expect(e.news.length).toBe(6);
    expect(e.news.filter((n) => n.title === 'Same headline').length).toBe(1);
    // No duplicate titles survive.
    expect(new Set(e.news.map((n) => n.title)).size).toBe(e.news.length);
  });

  it('produces empty sections (not crashes) for an idle user', () => {
    const e = buildBriefForUser(fakeCtx({}), MACRO, '2026-05-17', TS);
    expect(e.setups).toEqual([]);
    expect(e.positions).toEqual([]);
    expect(e.news).toEqual([]);
  });

  it('omits the overnight section entirely when none is supplied', () => {
    const e = buildBriefForUser(fakeCtx({}), MACRO, '2026-05-17', TS);
    expect(e.overnight).toBeUndefined();
    expect('overnight' in e).toBe(false);
  });

  it('threads a supplied overnight section onto the event', () => {
    const section = { available: true, rows: [{ symbol: 'NVDA', legs: ['prior-close mover'], score: 5 }] };
    const e = buildBriefForUser(fakeCtx({}), MACRO, '2026-05-17', TS, section);
    expect(e.overnight).toEqual(section);
  });
});

// ── TRA-4303 overnight / pre-close setups ────────────────────────────────────

/** Minimal EOD report with only the fields the overnight section reads. */
function eodReport(over: Partial<EodReport> = {}): EodReport {
  return {
    top5Movers: [],
    trades: [],
    ...over,
  } as unknown as EodReport;
}

describe('buildOvernightSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOvernightScanCache();
    loadLatestEodReportMock.mockResolvedValue(null);
    scanStocksMarketMock.mockResolvedValue([]);
  });

  it('fuses the prior-session report and the pre-market scan, naming both legs per row', async () => {
    loadLatestEodReportMock.mockResolvedValue(
      eodReport({
        top5Movers: [
          { symbol: 'NVDA', price: 900, changePct: 6.2 },
          { symbol: 'SOFI', price: 12, changePct: -4.1 },
        ],
        trades: [{ symbol: 'AAPL' }],
      } as unknown as Partial<EodReport>),
    );
    const scan = { ok: true as const, rows: [
      { symbol: 'NVDA', reason: 'gainer' as const, changePct: 8.4 },
      { symbol: 'AMD', reason: 'volume' as const },
    ] };

    const sec = await buildOvernightSection(fakeCtx({}), scan);

    expect(sec.available).toBe(true);
    expect(sec.note).toBeUndefined();

    // NVDA is in both legs ⇒ top score, and BOTH reasons are named on the row.
    const nvda = sec.rows.find((r) => r.symbol === 'NVDA')!;
    expect(nvda.legs).toEqual(['prior-close mover', 'pre-market gainer']);
    // The fresher pre-market number wins over the prior close's.
    expect(nvda.changePct).toBe(8.4);
    expect(nvda.score).toBe(9); // eod_mover 5 + gainer 4

    // Single-leg rows are still named.
    expect(sec.rows.find((r) => r.symbol === 'SOFI')!.legs).toEqual(['prior-close mover']);
    expect(sec.rows.find((r) => r.symbol === 'SOFI')!.changePct).toBe(-4.1);
    expect(sec.rows.find((r) => r.symbol === 'AAPL')!.legs).toEqual(['traded yesterday']);
    expect(sec.rows.find((r) => r.symbol === 'AMD')!.legs).toEqual(['most active']);
    // No move size known for a traded-yesterday-only row — absent, not zero.
    expect(sec.rows.find((r) => r.symbol === 'AAPL')!.changePct).toBeUndefined();

    // Ranked by score, highest first.
    expect(sec.rows[0]!.symbol).toBe('NVDA');
  });

  it('drops a suspect prior-session mover from BOTH the ranking and the move size', async () => {
    // price 12 with a published +8,951% implies a prev close of 0.13 — the
    // ratio the plausibility rule condemns. It must not seed a symbol…
    loadLatestEodReportMock.mockResolvedValue(
      eodReport({ top5Movers: [{ symbol: 'FAKE', price: 12, changePct: 8951 }] } as unknown as Partial<EodReport>),
    );
    // …and when the SCAN independently ranks the same name, the condemned
    // archived `changePct` must still not be rendered beside it.
    const scan = { ok: true as const, rows: [{ symbol: 'FAKE', reason: 'trending' as const }] };

    const sec = await buildOvernightSection(fakeCtx({}), scan);

    const row = sec.rows.find((r) => r.symbol === 'FAKE')!;
    expect(row.legs).toEqual(['trending']); // no `prior-close mover` bump
    expect(row.score).toBe(1); // trending only
    expect(row.changePct).toBeUndefined(); // no fabricated move size
  });

  it('degrades to unavailable only when BOTH legs fail', async () => {
    loadLatestEodReportMock.mockResolvedValue(null);
    const dead = await buildOvernightSection(fakeCtx({}), { ok: false, rows: [], reason: 'yahoo 429' });
    expect(dead.available).toBe(false);
    expect(dead.rows).toEqual([]);
    expect(dead.note).toContain('prior-session report unavailable');
    expect(dead.note).toContain('pre-market scan unavailable');

    // Scan alive, report dead ⇒ still a section, with the dead leg named.
    const partial = await buildOvernightSection(fakeCtx({}), {
      ok: true,
      rows: [{ symbol: 'AMD', reason: 'gainer', changePct: 5 }],
    });
    expect(partial.available).toBe(true);
    expect(partial.rows.map((r) => r.symbol)).toEqual(['AMD']);
    expect(partial.note).toBe('prior-session report unavailable');
  });

  it('survives a throwing EOD read rather than failing the brief', async () => {
    loadLatestEodReportMock.mockRejectedValue(new Error('disk on fire'));
    const sec = await buildOvernightSection(fakeCtx({}), {
      ok: true,
      rows: [{ symbol: 'AMD', reason: 'gainer', changePct: 5 }],
    });
    expect(sec.available).toBe(true);
    expect(sec.note).toBe('prior-session report unavailable');
  });

  it('caps the section', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      symbol: `S${i}`,
      reason: 'gainer' as const,
      changePct: i,
    }));
    const sec = await buildOvernightSection(fakeCtx({}), { ok: true, rows });
    expect(sec.rows.length).toBe(8);
  });

  it('is READ-ONLY — it never seeds the engine or writes the watchlist', async () => {
    loadLatestEodReportMock.mockResolvedValue(
      eodReport({
        top5Movers: [{ symbol: 'NVDA', price: 900, changePct: 6.2 }],
        trades: [{ symbol: 'AAPL' }],
      } as unknown as Partial<EodReport>),
    );
    const ctx = fakeCtx({});
    await buildOvernightSection(ctx, { ok: true, rows: [{ symbol: 'AMD', reason: 'gainer' }] });
    // Acceptance #3 — the 09:00 build stays the only writer of the watchlist.
    expect(addSymbolSpy).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

describe('getOvernightScan (bounded cost, acceptance #5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOvernightScanCache();
  });

  it('pulls the screener at most once per TTL, however many callers ask', async () => {
    scanStocksMarketMock.mockResolvedValue([{ symbol: 'AMD', reason: 'gainer' }]);
    const t0 = 1_000_000;
    const a = await getOvernightScan(t0);
    const b = await getOvernightScan(t0 + 29 * 60_000);
    expect(a.ok).toBe(true);
    expect(b).toBe(a);
    expect(scanStocksMarketMock).toHaveBeenCalledTimes(1);

    // Past the 30-min TTL — which is shorter than the 08:30 → 09:00 gap, so the
    // 09:00 build can never be served this section's warmed read.
    await getOvernightScan(t0 + 31 * 60_000);
    expect(scanStocksMarketMock).toHaveBeenCalledTimes(2);
  });

  it('reports a scanner failure instead of throwing, and does not cache it', async () => {
    scanStocksMarketMock.mockRejectedValueOnce(new Error('yahoo 429'));
    const bad = await getOvernightScan(2_000_000);
    expect(bad.ok).toBe(false);
    expect(bad.rows).toEqual([]);
    expect(bad.reason).toContain('429');

    scanStocksMarketMock.mockResolvedValue([{ symbol: 'AMD', reason: 'gainer' }]);
    const good = await getOvernightScan(2_000_001);
    expect(good.ok).toBe(true);
    expect(scanStocksMarketMock).toHaveBeenCalledTimes(2);
  });
});

describe('isOvernightSetupsEnabled', () => {
  it('defaults ON when unset or blank', () => {
    expect(isOvernightSetupsEnabled({})).toBe(true);
    expect(isOvernightSetupsEnabled({ MORNING_BRIEF_OVERNIGHT_SETUPS: '  ' })).toBe(true);
  });

  it('is an operator kill switch, not a feature gate', () => {
    for (const off of ['0', 'false', 'no', 'off', 'OFF']) {
      expect(isOvernightSetupsEnabled({ MORNING_BRIEF_OVERNIGHT_SETUPS: off })).toBe(false);
    }
    expect(isOvernightSetupsEnabled({ MORNING_BRIEF_OVERNIGHT_SETUPS: '1' })).toBe(true);
  });
});
