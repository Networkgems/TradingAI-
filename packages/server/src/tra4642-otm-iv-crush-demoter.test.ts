import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EarningsCalendarClient } from '@trading-app/engine';
import {
  CATALYST_EARNINGS_DEMOTE_WITHIN_SESSIONS,
  EARNINGS_IV_CRUSH_TAG,
} from '@trading-app/shared';
import {
  refreshEarningsCalendar,
  initEarningsStore,
  earningsCalendarReadSync,
  earningsInDaysSync,
  earningsStoreStatusSync,
  __resetEarningsStoreForTests,
} from './earnings-store.js';
import {
  OTM_IV_CRUSH_SHADOW_FLAG,
  OTM_IV_CRUSH_CODES,
  isOtmIvCrushDemoterShadowEnabled,
  evaluateOtmIvCrushDemoter,
  recordOtmIvCrushDemoter,
  resetOtmIvCrushDemoterCountersForTest,
  otmIvCrushDemoterHealth,
  type OtmIvCrushCode,
} from './otm-iv-crush-demoter.js';

/**
 * TRA-4642 (parent TRA-4413 item 1) — ROUTE the OTM nomination through the
 * existing news-catalyst EARNINGS_IV_CRUSH_RISK demoter, SHADOW-first.
 *
 * What these lock down, in order of how much it would hurt to lose:
 *   1. the verdict is the DEMOTER's OWN — `computeCatalystScore(...).demoted`
 *      at its live N — not a re-implemented comparison that could drift
 *      (`demoted === (code === 'ivcrush_demoted')` is asserted as an identity,
 *      and the demote boundary sits exactly at the shared constant);
 *   2. `ivcrush_calendar_unreadable` (unloaded OR unpopulated store — the
 *      feed's defect) is DISTINCT from `ivcrush_no_earnings_scheduled` (store
 *      readable, this name uncovered) — the TRA-4424 laundering trap;
 *   3. the calendar read the demoter is consulted on is byte-identical to the
 *      `earningsInDaysSync` read the news-catalyst path feeds it;
 *   4. the counter read is DENSE over the vocabulary (absent is not zero) and
 *      carries the `evaluated` denominator beside every numerator;
 *   5. the flag is STANDALONE and default OFF, and the module contains no
 *      enforce arm to test — there is nothing here that can refuse.
 */

let tmpRoot: string;

function stubClient(events: Array<{ symbol: string; date: string }>): EarningsCalendarClient {
  const client = new EarningsCalendarClient('test-token');
  vi.spyOn(client, 'fetchWindow').mockResolvedValue(
    events.map((e) => ({ ...e, epsEstimate: null, hour: '' })),
  );
  return client;
}

function isoInDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'tra4642-ivcrush-test-'));
  __resetEarningsStoreForTests(join(tmpRoot, 'earnings-calendar.json'));
  resetOtmIvCrushDemoterCountersForTest();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  __resetEarningsStoreForTests(null);
  vi.restoreAllMocks();
});

// ─── 1. the flag ─────────────────────────────────────────────────────────────

describe('flag', () => {
  it('defaults OFF (absent env)', () => {
    expect(isOtmIvCrushDemoterShadowEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it.each(['1', 'true', 'YES', ' on '])('arms on %j', (v) => {
    expect(isOtmIvCrushDemoterShadowEnabled({ [OTM_IV_CRUSH_SHADOW_FLAG]: v })).toBe(true);
  });

  it.each(['0', 'false', 'enabled', ''])('stays dark on %j', (v) => {
    expect(isOtmIvCrushDemoterShadowEnabled({ [OTM_IV_CRUSH_SHADOW_FLAG]: v })).toBe(false);
  });
});

// ─── 2. the earnings-store readability split ────────────────────────────────

describe('earningsCalendarReadSync', () => {
  it('reads `unloaded` before init — never a per-symbol claim', () => {
    expect(earningsCalendarReadSync('AAPL')).toEqual({
      state: 'unloaded', days: null, coveredSymbols: 0,
    });
    expect(earningsStoreStatusSync()).toEqual({ loaded: false, coveredSymbols: 0 });
  });

  it('reads `unpopulated` on a loaded-but-empty store (no refresh ever succeeded)', async () => {
    await initEarningsStore(); // no file on disk → empty cache
    expect(earningsCalendarReadSync('AAPL').state).toBe('unpopulated');
    expect(earningsStoreStatusSync()).toEqual({ loaded: true, coveredSymbols: 0 });
  });

  it('splits covered / uncovered once the store has data, and `days` matches earningsInDaysSync exactly', async () => {
    await refreshEarningsCalendar(stubClient([{ symbol: 'AAPL', date: isoInDays(5) }]), [
      'AAPL', 'MSFT',
    ]);
    const covered = earningsCalendarReadSync('AAPL');
    expect(covered.state).toBe('covered');
    expect(covered.days).toBe(5);
    expect(covered.days).toBe(earningsInDaysSync('AAPL'));
    expect(covered.coveredSymbols).toBe(1);

    const uncovered = earningsCalendarReadSync('MSFT');
    expect(uncovered.state).toBe('uncovered');
    expect(uncovered.days).toBeNull();
    expect(uncovered.days).toBe(earningsInDaysSync('MSFT'));
  });

  it('a stored date already passed reads `uncovered` — the same null the news-catalyst path sees', async () => {
    await refreshEarningsCalendar(
      stubClient([
        { symbol: 'AAPL', date: isoInDays(5) }, // keeps the store non-empty
        { symbol: 'TSLA', date: '2020-01-01' },
      ]),
      ['AAPL', 'TSLA'],
    );
    expect(earningsInDaysSync('TSLA')).toBeNull();
    expect(earningsCalendarReadSync('TSLA').state).toBe('uncovered');
  });
});

// ─── 3. the consult — the demoter's own verdict, classified ─────────────────

describe('evaluateOtmIvCrushDemoter', () => {
  it('demotes at the demoter\'s own boundary (N sessions), tagged EARNINGS_IV_CRUSH_RISK', () => {
    const n = CATALYST_EARNINGS_DEMOTE_WITHIN_SESSIONS;
    const at = evaluateOtmIvCrushDemoter('NVDA', {
      state: 'covered', days: n, coveredSymbols: 10,
    });
    expect(at.code).toBe('ivcrush_demoted');
    expect(at.demoted).toBe(true);
    expect(at.tags).toContain(EARNINGS_IV_CRUSH_TAG);

    const past = evaluateOtmIvCrushDemoter('NVDA', {
      state: 'covered', days: n + 1, coveredSymbols: 10,
    });
    expect(past.code).toBe('ivcrush_clear');
    expect(past.demoted).toBe(false);
    expect(past.tags).not.toContain(EARNINGS_IV_CRUSH_TAG);
  });

  it('earnings today (0 sessions) demotes', () => {
    expect(
      evaluateOtmIvCrushDemoter('AMD', { state: 'covered', days: 0, coveredSymbols: 3 }).code,
    ).toBe('ivcrush_demoted');
  });

  it('uncovered → no_earnings_scheduled, NEVER unreadable, and not demoted', () => {
    const v = evaluateOtmIvCrushDemoter('XLF', { state: 'uncovered', days: null, coveredSymbols: 3 });
    expect(v.code).toBe('ivcrush_no_earnings_scheduled');
    expect(v.demoted).toBe(false);
  });

  it.each(['unloaded', 'unpopulated'] as const)(
    '%s store → calendar_unreadable — an outage must not read as a clean pass',
    (state) => {
      const v = evaluateOtmIvCrushDemoter('SPY', { state, days: null, coveredSymbols: 0 });
      expect(v.code).toBe('ivcrush_calendar_unreadable');
      expect(v.demoted).toBe(false);
    },
  );

  it('`demoted` and the code are the SAME fact — the code never overrides the demoter', () => {
    const worlds = [
      { state: 'covered' as const, days: 0, coveredSymbols: 1 },
      { state: 'covered' as const, days: 1, coveredSymbols: 1 },
      { state: 'covered' as const, days: 2, coveredSymbols: 1 },
      { state: 'covered' as const, days: 30, coveredSymbols: 1 },
      { state: 'uncovered' as const, days: null, coveredSymbols: 1 },
      { state: 'unloaded' as const, days: null, coveredSymbols: 0 },
      { state: 'unpopulated' as const, days: null, coveredSymbols: 0 },
    ];
    for (const w of worlds) {
      const v = evaluateOtmIvCrushDemoter('T', w);
      expect(v.demoted).toBe(v.code === 'ivcrush_demoted');
    }
  });

  it('end-to-end through the real store: the consult sees what the news-catalyst path sees', async () => {
    await refreshEarningsCalendar(stubClient([{ symbol: 'NVDA', date: isoInDays(1) }]), ['NVDA']);
    const v = evaluateOtmIvCrushDemoter('NVDA', earningsCalendarReadSync('NVDA'));
    expect(v.code).toBe('ivcrush_demoted');
    expect(v.earningsInDays).toBe(earningsInDaysSync('NVDA'));
  });
});

// ─── 4. counters + health ───────────────────────────────────────────────────

describe('counters and health', () => {
  const demoted = { state: 'covered' as const, days: 0, coveredSymbols: 5 };
  const clear = { state: 'covered' as const, days: 30, coveredSymbols: 5 };

  it('dense byCode with the evaluated denominator; books keyed apart', () => {
    recordOtmIvCrushDemoter('live', evaluateOtmIvCrushDemoter('A', demoted));
    recordOtmIvCrushDemoter('live', evaluateOtmIvCrushDemoter('B', clear));
    recordOtmIvCrushDemoter('demo', evaluateOtmIvCrushDemoter('C', clear));

    const h = otmIvCrushDemoterHealth({ loaded: true, coveredSymbols: 5 }, {} as NodeJS.ProcessEnv);
    expect(h.books.live.evaluated).toBe(2);
    expect(h.books.demo.evaluated).toBe(1);
    // Dense: every code has a row, absent is zero, not missing (TRA-4154).
    expect(h.books.live.byCode.map((r) => r.code)).toEqual([...OTM_IV_CRUSH_CODES]);
    const liveCount = (c: OtmIvCrushCode) => h.books.live.byCode.find((r) => r.code === c)!;
    expect(liveCount('ivcrush_demoted')).toEqual({ code: 'ivcrush_demoted', count: 1, share: 0.5 });
    expect(liveCount('ivcrush_calendar_unreadable').count).toBe(0);
    expect(h.books.live.lastDemotedSymbol).toBe('A');
    expect(h.books.demo.lastDemotedSymbol).toBeNull();
  });

  it('share is null (not 0) on an empty book — 0/0 must not read as a measurement', () => {
    const h = otmIvCrushDemoterHealth({ loaded: false, coveredSymbols: 0 }, {} as NodeJS.ProcessEnv);
    for (const row of h.books.live.byCode) expect(row.share).toBeNull();
  });

  it('publishes the demoter\'s N and tag, so a "too tight" read cites what it measured', () => {
    const h = otmIvCrushDemoterHealth({ loaded: true, coveredSymbols: 5 }, {} as NodeJS.ProcessEnv);
    expect(h.demoteWithinSessions).toBe(CATALYST_EARNINGS_DEMOTE_WITHIN_SESSIONS);
    expect(h.demoteTag).toBe(EARNINGS_IV_CRUSH_TAG);
    expect(h.calendar).toEqual({ loaded: true, coveredSymbols: 5 });
  });

  it('a typo\'d arm attempt is visible: raw carried, enabled false, DARK note', () => {
    const h = otmIvCrushDemoterHealth(
      { loaded: true, coveredSymbols: 5 },
      { [OTM_IV_CRUSH_SHADOW_FLAG]: 'enable' } as NodeJS.ProcessEnv,
    );
    expect(h.enabled).toBe(false);
    expect(h.raw).toBe('enable');
    expect(h.note).toContain('DARK');
  });

  it('enabled note names the shadow contract, not a clean bill', () => {
    const h = otmIvCrushDemoterHealth(
      { loaded: true, coveredSymbols: 5 },
      { [OTM_IV_CRUSH_SHADOW_FLAG]: '1' } as NodeJS.ProcessEnv,
    );
    expect(h.enabled).toBe(true);
    expect(h.note).toContain('SHADOW ONLY');
  });
});

// ─── 5. the log brake ───────────────────────────────────────────────────────

describe('log brake', () => {
  const demoted = { state: 'covered' as const, days: 0, coveredSymbols: 5 };
  const unreadable = { state: 'unloaded' as const, days: null, coveredSymbols: 0 };
  const clear = { state: 'covered' as const, days: 30, coveredSymbols: 5 };
  const uncovered = { state: 'uncovered' as const, days: null, coveredSymbols: 5 };

  it('demoted and unreadable are log-worthy; clear and no-earnings never are', () => {
    const t0 = 1_000_000;
    expect(recordOtmIvCrushDemoter('live', evaluateOtmIvCrushDemoter('A', demoted), t0)).toBe(true);
    expect(recordOtmIvCrushDemoter('live', evaluateOtmIvCrushDemoter('B', unreadable), t0)).toBe(true);
    expect(recordOtmIvCrushDemoter('live', evaluateOtmIvCrushDemoter('C', clear), t0)).toBe(false);
    expect(recordOtmIvCrushDemoter('live', evaluateOtmIvCrushDemoter('D', uncovered), t0)).toBe(false);
  });

  it('brakes to one line per (book, symbol, code) per hour; counters still accrue every verdict', () => {
    const t0 = 1_000_000;
    expect(recordOtmIvCrushDemoter('live', evaluateOtmIvCrushDemoter('A', demoted), t0)).toBe(true);
    expect(recordOtmIvCrushDemoter('live', evaluateOtmIvCrushDemoter('A', demoted), t0 + 5 * 60_000)).toBe(false);
    // A different symbol, book, or code is its own key.
    expect(recordOtmIvCrushDemoter('live', evaluateOtmIvCrushDemoter('B', demoted), t0 + 5 * 60_000)).toBe(true);
    expect(recordOtmIvCrushDemoter('demo', evaluateOtmIvCrushDemoter('A', demoted), t0 + 5 * 60_000)).toBe(true);
    // The hour elapses → log-worthy again.
    expect(recordOtmIvCrushDemoter('live', evaluateOtmIvCrushDemoter('A', demoted), t0 + 61 * 60_000)).toBe(true);

    const h = otmIvCrushDemoterHealth({ loaded: true, coveredSymbols: 5 }, {} as NodeJS.ProcessEnv);
    expect(h.books.live.evaluated).toBe(4); // every call counted, braked or not
  });
});
