// TRA-5202 (parent TRA-5192) — the TRA-554 daily equity trades gate was POOLED:
// options-sleeve `dailySignals` rows (including rows for option signals that were
// REFUSED and never booked a trade) consumed the equity sleeve's entry budget. On
// 2026-10-05 the demo equity sleeve rejected 8 of 14 candidates
// `daily_trades_limit` on a 1-trade day. The states "budget spent by my own
// sleeve" and "budget consumed by a sibling sleeve" read byte-identically on
// every summary surface, so these tests hold three things in place:
//
//   1. the split itself (option rows never count toward the equity cap),
//   2. the funnel detail that makes the two states produce DIFFERENT bytes,
//   3. a source-scan control that fails if a new sleeve starts pushing an
//      unclassified type literal into `dailySignals` — the way the pooling
//      would silently come back.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, rmSync, mkdtempSync } from 'fs';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { join } from 'path';
import { SignalEngine } from './signal-engine.js';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import type { TradeSignal } from '@trading-app/shared';
import {
  OPTION_SLEEVE_DAILY_SIGNAL_TYPES,
  splitDailySignalsForEquityGate,
} from './daily-trades-gate.js';
import type { DailySignalRecord } from './reports/eod-report.js';
import { etDateString } from './scheduler.js';
import {
  summarizeEquityEntryFunnel,
  __resetEquityEntryFunnelForTests,
} from './equity-entry-funnel.js';
import {
  flushEquityEntryFunnelLedger,
  hydrateEquityEntryFunnelFromDisk,
  ledgerRecordDailyTradesGate,
  summarizeEquityEntryFunnelLedger,
} from './equity-entry-funnel-ledger.js';
import { __resetMarketDataCandleCacheForTest } from './market-data-candle-cache.js';

/** The real engine internals we drive — the same seam equity-entry-funnel.test.ts uses. */
type Privates = {
  routeEquitySignal: (
    signal: TradeSignal,
    price: number | undefined,
    source?: 'deterministic' | 'agent-gating',
  ) => Promise<unknown>;
  dailySignals: DailySignalRecord[];
  feedContextKey: string;
};
const priv = (e: SignalEngine) => e as unknown as Privates;

/** AAPL is in the locked 21-name swing universe (TRA-955), so it clears the universe gate. */
function buildSignal(symbol = 'AAPL', id = 'sig-1'): TradeSignal {
  return {
    id,
    symbol,
    type: 'momentum',
    side: 'buy',
    entryPrice: 100,
    stopLoss: 95,
    takeProfit: 110,
    riskRewardRatio: 2,
    timestamp: Date.now(),
    mode: 'demo',
  } as unknown as TradeSignal;
}

function row(type: DailySignalRecord['type'], i: number, firedAt = Date.now()): DailySignalRecord {
  return { id: `seed-${type}-${i}`, symbol: `SYM${i}`, type, firedAt };
}

/** A small cap so the seeds stay readable; the default (10) is not load-bearing here. */
const CAP = 3;

async function demoEngine(): Promise<SignalEngine> {
  const engine = new SignalEngine(undefined, undefined, undefined);
  await engine.applySettings({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo', dailyTradesLimit: CAP });
  return engine;
}

describe('TRA-5202 — splitDailySignalsForEquityGate', () => {
  it('counts equity rows and option-sleeve rows separately, and only for the named ET day', () => {
    const now = Date.now();
    const yesterday = now - 24 * 60 * 60 * 1000;
    const dayKey = etDateString(new Date(now));
    const rows: DailySignalRecord[] = [
      row('momentum', 1, now),
      row('ichimoku', 2, now),
      row('relative_value', 3, now),
      row('otm_mispricing', 4, now),
      row('otm_mispricing', 5, now),
      // Other ET day — must be invisible to BOTH counts.
      row('momentum', 6, yesterday),
      row('relative_value', 7, yesterday),
    ];
    expect(splitDailySignalsForEquityGate(rows, dayKey)).toEqual({
      equityCount: 2,
      optionSleeveCount: 3,
    });
  });

  it('an all-options day counts ZERO toward the equity cap — the 2026-10-05 shape', () => {
    const now = Date.now();
    const dayKey = etDateString(new Date(now));
    const rows = Array.from({ length: 12 }, (_, i) =>
      row(i % 2 === 0 ? 'relative_value' : 'otm_mispricing', i, now));
    expect(splitDailySignalsForEquityGate(rows, dayKey)).toEqual({
      equityCount: 0,
      optionSleeveCount: 12,
    });
  });
});

describe('TRA-5202 — the gate, driven through the REAL engine chokepoint', () => {
  beforeEach(() => {
    __resetEquityEntryFunnelForTests();
    __resetMarketDataCandleCacheForTest();
  });
  afterEach(() => {
    __resetEquityEntryFunnelForTests();
    __resetMarketDataCandleCacheForTest();
  });

  it('CONTROL (the incident): a day of option-sleeve rows at/above the cap must NOT gate an equity entry', async () => {
    const engine = await demoEngine();
    // Seed well past the cap with option-sleeve rows only — the 2026-10-05 state,
    // where the one real option open plus refused option signals held >= cap rows.
    for (let i = 0; i < CAP + 5; i++) {
      priv(engine).dailySignals.push(row(i % 2 === 0 ? 'relative_value' : 'otm_mispricing', i));
    }

    await priv(engine).routeEquitySignal(buildSignal(), 100, 'deterministic');

    // The equity entry must reach the book. Before TRA-5202 this read
    // rejectedByReason { daily_trades_limit: 1 } and opened nothing.
    expect(engine.getState().account.openPositions.some(p => p.symbol === 'AAPL')).toBe(true);
    const [demo] = summarizeEquityEntryFunnel().demo;
    expect(demo.cumulative.admitted).toBe(1);
    expect(demo.cumulative.rejectedByReason).toEqual({});
    // The gate did not trip, so the detail stays a true null — "no trip", not "no data".
    expect(demo.dailyTradesGate).toBeNull();
  });

  it('a day of EQUITY rows at the cap still gates — and now publishes limit + both counts', async () => {
    const engine = await demoEngine();
    for (let i = 0; i < CAP; i++) priv(engine).dailySignals.push(row('momentum', i));
    // Option-sleeve rows present too, so the detail proves they are visible but uncounted.
    priv(engine).dailySignals.push(row('relative_value', 90), row('otm_mispricing', 91));

    await priv(engine).routeEquitySignal(buildSignal(), 100, 'deterministic');

    expect(engine.getState().account.openPositions.some(p => p.symbol === 'AAPL')).toBe(false);
    const [demo] = summarizeEquityEntryFunnel().demo;
    expect(demo.cumulative.rejectedByReason).toEqual({ daily_trades_limit: 1 });
    expect(demo.dailyTradesGate).not.toBeNull();
    expect(demo.dailyTradesGate).toMatchObject({
      limit: CAP,
      equityCount: CAP,
      optionSleeveCount: 2,
    });
    // And the durable per-ET-day twin carries the same reading (memory-only here;
    // persistence is proven separately below).
    const day = summarizeEquityEntryFunnelLedger().byEtDay
      .find(d => d.mode === 'demo' && d.etDay === etDateString(new Date()));
    expect(day?.rejectedByReason).toEqual({ daily_trades_limit: 1 });
    expect(day?.dailyTradesGate).toMatchObject({ limit: CAP, equityCount: CAP, optionSleeveCount: 2 });
  });
});

describe('TRA-5202 — the gate detail survives a restart (the TRA-4998 durable twin)', () => {
  let dir = '';
  beforeEach(() => {
    __resetEquityEntryFunnelForTests();
    dir = mkdtempSync(join(tmpdir(), 'tra5202-funnel-'));
  });
  afterEach(() => {
    __resetEquityEntryFunnelForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it('flush → rehydrate round-trips dailyTradesGate; absent on old lines reads null', () => {
    hydrateEquityEntryFunnelFromDisk(dir); // arms the append dir
    const at = Date.now();
    ledgerRecordDailyTradesGate('demo', 'engine-rt-1', { limit: 3, equityCount: 3, optionSleeveCount: 7 }, at);
    flushEquityEntryFunnelLedger(at + 1);

    // "Restart": drop everything and rebuild from disk.
    hydrateEquityEntryFunnelFromDisk(dir);
    const day = summarizeEquityEntryFunnelLedger().byEtDay
      .find(d => d.mode === 'demo' && d.etDay === etDateString(new Date(at)));
    expect(day?.dailyTradesGate).toEqual({ limit: 3, equityCount: 3, optionSleeveCount: 7, at });
  });
});

describe('TRA-5202 — source-scan control: no unclassified sleeve may consume the equity budget', () => {
  // The way the pooling comes back is a NEW push site stamping a type literal
  // this gate does not classify: an unclassified type counts as EQUITY (the
  // tightening direction), which re-creates the cross-sleeve exhaustion for the
  // new sleeve — undetected, because every summary surface reads the same. This
  // control fails the moment such a literal appears, forcing the author to
  // classify it here deliberately.
  const SRC = readFileSync(fileURLToPath(new URL('./signal-engine.ts', import.meta.url)), 'utf8');

  it('every dailySignals.push type literal is a classified option-sleeve type, and the scan is not vacuous', () => {
    const sites = [...SRC.matchAll(/this\.dailySignals\.push\(\{[^}]*\}/gs)];
    // Non-vacuity first: a refactor that renames the list must fail HERE, loudly,
    // not pass an empty population (the gate-upstream-of-the-scan failure).
    expect(sites.length).toBeGreaterThanOrEqual(10);

    const literals = new Set<string>();
    let dynamicSites = 0;
    for (const m of sites) {
      const body = m[0];
      const lit = body.match(/type:\s*'([a-z_]+)'/);
      if (lit) literals.add(lit[1]);
      else if (/type:\s*signal\.type/.test(body)) dynamicSites += 1;
      else throw new Error(`dailySignals.push site with unrecognisable type shape: ${body.slice(0, 200)}`);
    }
    // The equity chokepoint is the ONLY dynamic site; everything stamped with a
    // literal is an options-sleeve push and must be classified out of the cap.
    expect(dynamicSites).toBe(1);
    expect(literals.size).toBeGreaterThanOrEqual(2);
    for (const lit of literals) {
      expect(
        OPTION_SLEEVE_DAILY_SIGNAL_TYPES.has(lit as never),
        `signal-engine.ts pushes dailySignals rows with type '${lit}' but daily-trades-gate.ts does not
classify it. If it is an options-sleeve type, add it to OPTION_SLEEVE_DAILY_SIGNAL_TYPES (or it will
silently consume the EQUITY sleeve's daily_trades_limit budget — the TRA-5202 incident). If it is a
new equity path, push \`type: signal.type\` through the equity chokepoint instead of a literal.`,
      ).toBe(true);
    }
  });

  it('the gate itself counts through splitDailySignalsForEquityGate, not a raw length', () => {
    // The fix is one call site; a revert to `.filter(...).length` over the pooled
    // list would compile and pass every summary-surface check. Pin the call.
    expect(SRC).toContain('splitDailySignalsForEquityGate(this.dailySignals');
  });
});
