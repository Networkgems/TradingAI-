import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';
import type { Candle } from '@trading-app/shared';
import {
  setOrbOptionsShadowLedgerFileForTests,
  initOrbOptionsShadowLedger,
  recordOrbOptionsShadowSignal,
  listOrbOptionsShadowSignals,
  emitOrbOptionsShadowSignal,
  isOrbOptionsShadowEnabled,
  ORB_OPTIONS_SHADOW_FLAG,
  type OrbOptionsShadowRecord,
} from './orb-options-shadow-ledger.js';

// 2026-06-16 (Tuesday) is EDT, so 09:30 ET = 13:30 UTC.
const OPEN_UTC = Date.UTC(2026, 5, 16, 13, 30);
const MIN = 60_000;

function bar(offsetMin: number, o: number, h: number, l: number, c: number): Candle {
  return {
    symbol: 'SPY',
    timestamp: OPEN_UTC + offsetMin * MIN,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 1_000,
  };
}

/**
 * A synthetic 5m session whose opening range (first 15m = the 09:30/09:35/09:40
 * bars) is [100.0, 100.3] (width 0.3% — inside the 0.2–0.8% gate), then the 09:45
 * bar CLOSES at 100.5, above the range high → an upside ORB break (buy call).
 */
const UPSIDE_RANGE: Candle[] = [
  bar(0, 100.0, 100.2, 100.0, 100.1), // 09:30
  bar(5, 100.1, 100.3, 100.05, 100.2), // 09:35 (range high 100.3)
  bar(10, 100.2, 100.25, 100.05, 100.15), // 09:40
];
const UPSIDE_BREAKOUT = bar(15, 100.2, 100.6, 100.15, 100.5); // 09:45 close 100.5 > 100.3

/** Same range, but the 09:45 bar CLOSES at 99.8, below the range low → buy put. */
const DOWNSIDE_BREAKOUT = bar(15, 99.95, 100.05, 99.7, 99.8); // 09:45 close 99.8 < 100.0

function upsideSession(): Candle[] {
  return [...UPSIDE_RANGE, UPSIDE_BREAKOUT];
}

describe('isOrbOptionsShadowEnabled (flag gate)', () => {
  it('is off when the flag is unset or falsy', () => {
    expect(isOrbOptionsShadowEnabled({})).toBe(false);
    expect(isOrbOptionsShadowEnabled({ [ORB_OPTIONS_SHADOW_FLAG]: 'false' })).toBe(false);
    expect(isOrbOptionsShadowEnabled({ [ORB_OPTIONS_SHADOW_FLAG]: '0' })).toBe(false);
  });
  it('is on for the usual truthy spellings', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) {
      expect(isOrbOptionsShadowEnabled({ [ORB_OPTIONS_SHADOW_FLAG]: v })).toBe(true);
    }
  });
});

describe('orb-options-shadow-ledger — append-only store', () => {
  let file: string;
  let n = 0;

  function record(over: Partial<OrbOptionsShadowRecord> = {}): OrbOptionsShadowRecord {
    return {
      id: 'SPY:2026-06-16',
      symbol: 'SPY',
      etDay: '2026-06-16',
      timestamp: OPEN_UTC + 15 * MIN,
      type: 'call_breakout',
      optionType: 'call',
      breakoutDirection: 'up',
      breakLevel: 100.3,
      underlyingEntry: 100.5,
      box: { openTimestamp: OPEN_UTC, openPrice: 100.0, high: 100.3, low: 100.0, widthPct: 0.003 },
      reason: 'upside ORB break',
      params: {
        rangeMinutes: 15,
        sessionOpenEtMinute: 570,
        requireClose: true,
        minRangePct: 0.002,
        maxRangePct: 0.008,
        entryCutoffEtMinute: 720,
        allowedBreakouts: 'both',
        excludedEtWeekdays: [],
      },
      ...over,
    };
  }

  beforeEach(() => {
    file = join(tmpdir(), `orb-opt-shadow-${process.pid}-${n++}.jsonl`);
    setOrbOptionsShadowLedgerFileForTests(file);
  });
  afterEach(() => {
    setOrbOptionsShadowLedgerFileForTests(null);
    try { rmSync(file); } catch { /* ignore */ }
  });

  it('records a well-formed row and reads it back', async () => {
    await initOrbOptionsShadowLedger();
    expect(await recordOrbOptionsShadowSignal(record())).toBe(true);
    const rows = await listOrbOptionsShadowSignals();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('SPY:2026-06-16');
    expect(rows[0].type).toBe('call_breakout');
    expect(rows[0].optionType).toBe('call');
    expect(rows[0].breakLevel).toBe(100.3);
  });

  it('dedupes a re-fire on the same symbol/ET-day (one trade a day)', async () => {
    await initOrbOptionsShadowLedger();
    expect(await recordOrbOptionsShadowSignal(record())).toBe(true);
    // Same id, later in the session → no-op.
    expect(await recordOrbOptionsShadowSignal(record({ timestamp: OPEN_UTC + 30 * MIN }))).toBe(false);
    expect(await listOrbOptionsShadowSignals()).toHaveLength(1);
  });

  it('keeps distinct rows for different underlyings and days', async () => {
    await initOrbOptionsShadowLedger();
    await recordOrbOptionsShadowSignal(record());
    await recordOrbOptionsShadowSignal(record({ id: 'QQQ:2026-06-16', symbol: 'QQQ' }));
    await recordOrbOptionsShadowSignal(record({ id: 'SPY:2026-06-17', etDay: '2026-06-17' }));
    expect(await listOrbOptionsShadowSignals()).toHaveLength(3);
  });

  it('persists across a reload (append-only durability)', async () => {
    await initOrbOptionsShadowLedger();
    await recordOrbOptionsShadowSignal(record());
    setOrbOptionsShadowLedgerFileForTests(file); // drops the cache, same file
    expect(await listOrbOptionsShadowSignals()).toHaveLength(1);
  });
});

describe('emitOrbOptionsShadowSignal — flag-gated, never routes an order', () => {
  let file: string;
  let n = 0;

  beforeEach(() => {
    file = join(tmpdir(), `orb-opt-emit-${process.pid}-${n++}.jsonl`);
    setOrbOptionsShadowLedgerFileForTests(file);
    delete process.env[ORB_OPTIONS_SHADOW_FLAG];
  });
  afterEach(() => {
    setOrbOptionsShadowLedgerFileForTests(null);
    delete process.env[ORB_OPTIONS_SHADOW_FLAG];
    try { rmSync(file); } catch { /* ignore */ }
  });

  it('emits nothing and writes nothing when the flag is off', async () => {
    await initOrbOptionsShadowLedger();
    const r = await emitOrbOptionsShadowSignal({ symbol: 'SPY', candles: upsideSession(), now: OPEN_UTC });
    expect(r.emitted).toBe(false);
    expect(r.reason).toBe('flag_off');
    expect(await listOrbOptionsShadowSignals()).toHaveLength(0);
  });

  it('flag on but no breakout → emits nothing (reason none)', async () => {
    process.env[ORB_OPTIONS_SHADOW_FLAG] = 'true';
    await initOrbOptionsShadowLedger();
    // Only the opening-range bars, no post-range break.
    const r = await emitOrbOptionsShadowSignal({ symbol: 'SPY', candles: UPSIDE_RANGE, now: OPEN_UTC });
    expect(r.emitted).toBe(false);
    expect(r.reason).toBe('none');
    expect(await listOrbOptionsShadowSignals()).toHaveLength(0);
  });

  it('flag on + upside break → writes exactly one call_breakout row', async () => {
    process.env[ORB_OPTIONS_SHADOW_FLAG] = 'true';
    await initOrbOptionsShadowLedger();
    const r = await emitOrbOptionsShadowSignal({
      symbol: 'SPY',
      candles: upsideSession(),
      now: OPEN_UTC + 15 * MIN,
    });
    expect(r.emitted).toBe(true);
    expect(r.signal?.type).toBe('call_breakout');
    expect(r.signal?.optionType).toBe('call');
    const rows = await listOrbOptionsShadowSignals();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('SPY:2026-06-16');
    expect(rows[0].breakLevel).toBe(100.3);
    expect(rows[0].underlyingEntry).toBe(100.5);
  });

  it('a downside break writes a put_breakout row', async () => {
    process.env[ORB_OPTIONS_SHADOW_FLAG] = 'true';
    await initOrbOptionsShadowLedger();
    const r = await emitOrbOptionsShadowSignal({
      symbol: 'QQQ',
      candles: [...UPSIDE_RANGE, DOWNSIDE_BREAKOUT],
      now: OPEN_UTC + 15 * MIN,
    });
    expect(r.emitted).toBe(true);
    expect(r.signal?.type).toBe('put_breakout');
    expect(r.signal?.optionType).toBe('put');
    const rows = await listOrbOptionsShadowSignals();
    expect(rows).toHaveLength(1);
    expect(rows[0].optionType).toBe('put');
  });

  it('one-trade-a-day: a later same-session bar writes NO new row', async () => {
    process.env[ORB_OPTIONS_SHADOW_FLAG] = 'true';
    await initOrbOptionsShadowLedger();
    // First: the breakout bar fires and writes one row.
    const first = await emitOrbOptionsShadowSignal({
      symbol: 'SPY',
      candles: upsideSession(),
      now: OPEN_UTC + 15 * MIN,
    });
    expect(first.emitted).toBe(true);
    // A second bar later the same session — the engine returns
    // 'already_triggered_today' (none), so nothing new is written.
    const second = await emitOrbOptionsShadowSignal({
      symbol: 'SPY',
      candles: [...upsideSession(), bar(20, 100.5, 100.7, 100.4, 100.6)],
      now: OPEN_UTC + 20 * MIN,
    });
    expect(second.emitted).toBe(false);
    expect(second.reason).toBe('none');
    expect(await listOrbOptionsShadowSignals()).toHaveLength(1);
  });

  it('accepts an OrbOptionsParams override through the seam', async () => {
    process.env[ORB_OPTIONS_SHADOW_FLAG] = 'true';
    await initOrbOptionsShadowLedger();
    // down_only filters an upside break out → none, nothing written.
    const r = await emitOrbOptionsShadowSignal({
      symbol: 'SPY',
      candles: upsideSession(),
      now: OPEN_UTC + 15 * MIN,
      params: { allowedBreakouts: 'down_only' },
    });
    expect(r.emitted).toBe(false);
    expect(r.reason).toBe('none');
    expect(await listOrbOptionsShadowSignals()).toHaveLength(0);
  });
});

// The read endpoint mirrors the option-shadow probe; index.ts boots the server,
// so we assert the response SHAPE the handler builds from the ledger accessors
// (the established convention for these health probes).
describe('GET /api/health/orb-options-shadow-signals — response shape', () => {
  let file: string;
  let n = 0;

  beforeEach(() => {
    file = join(tmpdir(), `orb-opt-health-${process.pid}-${n++}.jsonl`);
    setOrbOptionsShadowLedgerFileForTests(file);
    delete process.env[ORB_OPTIONS_SHADOW_FLAG];
  });
  afterEach(() => {
    setOrbOptionsShadowLedgerFileForTests(null);
    delete process.env[ORB_OPTIONS_SHADOW_FLAG];
    try { rmSync(file); } catch { /* ignore */ }
  });

  async function payload() {
    const signals = await listOrbOptionsShadowSignals();
    return {
      issue: 'TRA-2172' as const,
      flagEnabled: isOrbOptionsShadowEnabled(),
      count: signals.length,
      signals,
    };
  }

  it('flag OFF → flagEnabled:false, count:0', async () => {
    await initOrbOptionsShadowLedger();
    expect(await payload()).toEqual({ issue: 'TRA-2172', flagEnabled: false, count: 0, signals: [] });
  });

  it('flag ON + a written signal → flagEnabled:true, count:1', async () => {
    process.env[ORB_OPTIONS_SHADOW_FLAG] = 'true';
    await initOrbOptionsShadowLedger();
    await emitOrbOptionsShadowSignal({ symbol: 'SPY', candles: upsideSession(), now: OPEN_UTC + 15 * MIN });
    const p = await payload();
    expect(p.flagEnabled).toBe(true);
    expect(p.count).toBe(1);
    expect(p.signals[0].type).toBe('call_breakout');
  });
});
