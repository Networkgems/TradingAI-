import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';
import type { ShadowOptionSignal } from '@trading-app/engine';
import {
  setOptionShadowLedgerFileForTests,
  initOptionShadowLedger,
  recordOptionShadowSignal,
  listOptionShadowSignals,
  isOptionShadowEnabled,
  isOptionPhaseBEnabled,
  emitShadowOptionSignal,
  shadowSignalToSpreadParams,
  OPTION_SHADOW_FLAG,
  OPTION_PHASE_B_FLAG,
} from './option-shadow-ledger.js';

const TS = Date.UTC(2026, 5, 16, 15, 0); // 2026-06-16 mid-RTH

function signal(over: Partial<ShadowOptionSignal> = {}): ShadowOptionSignal {
  return {
    symbol: 'SPY',
    timestamp: TS,
    strategy: 'bull_put_spread',
    legs: [
      { action: 'sell', optionType: 'put', strike: 93, delta: -0.23, optionSymbol: 'P93', mark: 1.44 },
      { action: 'buy', optionType: 'put', strike: 90, delta: -0.14, optionSymbol: 'P90', mark: 1.2 },
    ],
    expiration: '2026-08-21',
    daysToExpiry: 38,
    shortDelta: 0.23,
    netCredit: 0.24,
    netDebit: null,
    widthPoints: 3,
    sizingIntent: { maxLossPerSpread: 276, riskFraction: 0.02 },
    zoneTouches: null,
    reversalScore: null,
    rationale: 'ivr 60 >= 50 & trend up',
    ...over,
  };
}

describe('isOptionShadowEnabled (flag gate)', () => {
  it('is off when the flag is unset or falsy', () => {
    expect(isOptionShadowEnabled({})).toBe(false);
    expect(isOptionShadowEnabled({ [OPTION_SHADOW_FLAG]: 'false' })).toBe(false);
    expect(isOptionShadowEnabled({ [OPTION_SHADOW_FLAG]: '0' })).toBe(false);
  });
  it('is on for the usual truthy spellings', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) {
      expect(isOptionShadowEnabled({ [OPTION_SHADOW_FLAG]: v })).toBe(true);
    }
  });
});

describe('isOptionPhaseBEnabled (TRA-953 promotion gate)', () => {
  it('is off when the flag is unset or falsy', () => {
    expect(isOptionPhaseBEnabled({})).toBe(false);
    expect(isOptionPhaseBEnabled({ [OPTION_PHASE_B_FLAG]: 'false' })).toBe(false);
    expect(isOptionPhaseBEnabled({ [OPTION_PHASE_B_FLAG]: '0' })).toBe(false);
  });
  it('is on for the usual truthy spellings', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) {
      expect(isOptionPhaseBEnabled({ [OPTION_PHASE_B_FLAG]: v })).toBe(true);
    }
  });
  it('is independent of the shadow flag (Phase-B is its own switch)', () => {
    expect(isOptionShadowEnabled({ [OPTION_PHASE_B_FLAG]: 'true' })).toBe(false);
    expect(isOptionPhaseBEnabled({ [OPTION_SHADOW_FLAG]: 'true' })).toBe(false);
  });
});

describe('shadowSignalToSpreadParams (TRA-953 Phase-B mapper)', () => {
  it('maps a credit vertical: legs gain the shared expiration, totals ×100', () => {
    const p = shadowSignalToSpreadParams(signal(), 95);
    expect(p.symbol).toBe('SPY');
    expect(p.strategy).toBe('bull_put_spread');
    expect(p.spot).toBe(95);
    // legs carry the shared expiration; per-share quote/delta fields are dropped.
    expect(p.legs).toEqual([
      { action: 'sell', optionType: 'put', strike: 93, expiration: '2026-08-21' },
      { action: 'buy', optionType: 'put', strike: 90, expiration: '2026-08-21' },
    ]);
    // credit structure: netUsd = +credit×100, maxProfit = credit×100.
    expect(p.netUsd).toBeCloseTo(24, 6);
    expect(p.maxProfitUsd).toBeCloseTo(24, 6);
    // maxLoss passes through the selector's already-×100 figure.
    expect(p.maxLossUsd).toBe(276);
    expect(p.breakevens).toEqual([]);
  });

  it('maps a debit vertical: netUsd is negative, maxProfit = (width − debit)×100', () => {
    const p = shadowSignalToSpreadParams(
      signal({
        strategy: 'debit_spread',
        netCredit: null,
        netDebit: 1.1,
        widthPoints: 3,
        sizingIntent: { maxLossPerSpread: 110, riskFraction: 0.02 },
      }),
      100,
    );
    expect(p.netUsd).toBeCloseTo(-110, 6);
    expect(p.maxLossUsd).toBe(110);
    expect(p.maxProfitUsd).toBeCloseTo(190, 6); // (3 − 1.1) × 100
  });
});

describe('option-shadow-ledger — append-only store', () => {
  let file: string;
  let n = 0;

  beforeEach(() => {
    file = join(tmpdir(), `opt-shadow-${process.pid}-${n++}.jsonl`);
    setOptionShadowLedgerFileForTests(file);
  });
  afterEach(() => {
    setOptionShadowLedgerFileForTests(null);
    try { rmSync(file); } catch { /* ignore */ }
  });

  it('records a well-formed signal and reads it back', async () => {
    await initOptionShadowLedger();
    expect(await recordOptionShadowSignal(signal())).toBe(true);
    const rows = await listOptionShadowSignals();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('SPY:bull_put_spread:2026-08-21:2026-06-16');
    expect(rows[0].strategy).toBe('bull_put_spread');
    expect(rows[0].legs).toHaveLength(2);
  });

  it('dedupes a re-fire on the same symbol/strategy/expiration/day', async () => {
    await initOptionShadowLedger();
    expect(await recordOptionShadowSignal(signal())).toBe(true);
    expect(await recordOptionShadowSignal(signal({ timestamp: TS + 5 * 60_000 }))).toBe(false);
    expect(await listOptionShadowSignals()).toHaveLength(1);
  });

  it('persists across a reload (append-only durability)', async () => {
    await initOptionShadowLedger();
    await recordOptionShadowSignal(signal());
    setOptionShadowLedgerFileForTests(file); // drops the cache, same file
    expect(await listOptionShadowSignals()).toHaveLength(1);
  });
});

describe('emitShadowOptionSignal — flag-gated, never routes an order', () => {
  let file: string;
  let n = 0;

  beforeEach(() => {
    file = join(tmpdir(), `opt-shadow-emit-${process.pid}-${n++}.jsonl`);
    setOptionShadowLedgerFileForTests(file);
    delete process.env[OPTION_SHADOW_FLAG];
  });
  afterEach(() => {
    setOptionShadowLedgerFileForTests(null);
    delete process.env[OPTION_SHADOW_FLAG];
    try { rmSync(file); } catch { /* ignore */ }
  });

  function input() {
    const spot = 100;
    const contracts = [];
    const extrinsic = (k: number) => Math.max(0.3, 2.0 - 0.08 * Math.abs(k - spot));
    for (let k = spot - 20; k <= spot + 20; k += 1) {
      const putDelta = -Math.max(0.02, Math.min(0.98, 0.5 + (k - spot) * 0.04));
      const callDelta = Math.max(0.02, Math.min(0.98, 0.5 - (k - spot) * 0.04));
      const putMid = Math.max(k - spot, 0) + extrinsic(k);
      const callMid = Math.max(spot - k, 0) + extrinsic(k);
      contracts.push({ optionSymbol: `P${k}`, optionType: 'put' as const, strike: k, delta: putDelta, bid: putMid * 0.98, ask: putMid * 1.02, openInterest: 1000 });
      contracts.push({ optionSymbol: `C${k}`, optionType: 'call' as const, strike: k, delta: callDelta, bid: callMid * 0.98, ask: callMid * 1.02, openInterest: 1000 });
    }
    return {
      symbol: 'SPY', spot, ivRank: 60, trend: 'up' as const, highConvictionBreakout: false,
      atr: 3, support: 96, resistance: 104, expiration: '2026-08-21', daysToExpiry: 38,
      contracts, earningsBeforeExpiry: false, timestamp: TS,
    };
  }

  it('emits nothing and writes nothing when the flag is off', async () => {
    await initOptionShadowLedger();
    const r = await emitShadowOptionSignal(input());
    expect(r.emitted).toBe(false);
    expect(r.reason).toBe('flag_off');
    expect(await listOptionShadowSignals()).toHaveLength(0);
  });

  it('runs the selector and writes a signal when the flag is on', async () => {
    process.env[OPTION_SHADOW_FLAG] = 'true';
    await initOptionShadowLedger();
    const r = await emitShadowOptionSignal(input());
    expect(r.emitted).toBe(true);
    expect(r.result?.decision).toBe('signal');
    const rows = await listOptionShadowSignals();
    expect(rows).toHaveLength(1);
    expect(rows[0].strategy).toBe('bull_put_spread');
  });

  it('flag on but gate says stand down → emits nothing', async () => {
    process.env[OPTION_SHADOW_FLAG] = 'true';
    await initOptionShadowLedger();
    const r = await emitShadowOptionSignal({ ...input(), ivRank: 35 });
    expect(r.emitted).toBe(false);
    expect(r.reason).toBe('stand_down');
    expect(await listOptionShadowSignals()).toHaveLength(0);
  });
});
