import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';
import { computePutCallRatio, type PutCallRatio } from '@trading-app/engine';
import type { OptionChainRow } from '@trading-app/engine';
import {
  setPcrShadowLedgerFileForTests,
  initPcrShadowLedger,
  recordPcrObservation,
  listPcrShadowSignals,
  usableSignalCount,
  isPcrShadowEnabled,
  PCR_SHADOW_FLAG,
  type PcrTrioVerdict,
} from './pcr-shadow-ledger.js';

// A mid-RTH ET timestamp for a given day offset (days from 2026-06-16).
function etTs(dayOffset: number): number {
  return Date.UTC(2026, 5, 16 + dayOffset, 18, 0); // 18:00Z ~ 14:00 ET
}

function row(
  optionType: 'call' | 'put',
  strike: number,
  volume: number,
  openInterest = 100,
  expiration = '2026-08-21',
): OptionChainRow {
  return {
    optionSymbol: `X${optionType[0]}${strike}`,
    underlying: 'SPY',
    optionType,
    strike,
    expiration,
    volume,
    openInterest,
  };
}

// Build a PutCallRatio with a target pcrVolume and enough aggregate volume to
// clear the floor.
function pcrWith(pcrVolume: number): PutCallRatio {
  const callVol = 1000;
  const putVol = Math.round(pcrVolume * callVol);
  return computePutCallRatio([row('put', 100, putVol), row('call', 105, callVol)]);
}

const trio: PcrTrioVerdict = {
  side: 'call',
  emaPullbackFired: true,
  rsi: 61,
  rsiInMomentumBand: true,
  volumeConfirmed: true,
  trioFired: true,
};

let file: string;
let n = 0;

beforeEach(async () => {
  file = join(tmpdir(), `pcr-shadow-${process.pid}-${n++}.jsonl`);
  setPcrShadowLedgerFileForTests(file);
  process.env[PCR_SHADOW_FLAG] = '1';
  await initPcrShadowLedger();
});

afterEach(() => {
  setPcrShadowLedgerFileForTests(null);
  delete process.env[PCR_SHADOW_FLAG];
  try {
    rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
});

describe('isPcrShadowEnabled (flag gate)', () => {
  it('is off when unset or falsy', () => {
    expect(isPcrShadowEnabled({})).toBe(false);
    expect(isPcrShadowEnabled({ [PCR_SHADOW_FLAG]: '0' })).toBe(false);
    expect(isPcrShadowEnabled({ [PCR_SHADOW_FLAG]: 'false' })).toBe(false);
  });
  it('is on for truthy spellings', () => {
    for (const v of ['1', 'true', 'yes', 'on', ' TRUE ']) {
      expect(isPcrShadowEnabled({ [PCR_SHADOW_FLAG]: v })).toBe(true);
    }
  });
});

describe('recordPcrObservation', () => {
  it('no-ops with the flag off', async () => {
    delete process.env[PCR_SHADOW_FLAG];
    const res = await recordPcrObservation({
      underlying: 'SPY',
      asof: etTs(0),
      pcr: pcrWith(0.8),
      trio,
    });
    expect(res.written).toBe(false);
    expect(res.reason).toBe('flag_off');
    expect(await listPcrShadowSignals()).toHaveLength(0);
  });

  it('writes a well-formed row stamped with the trio verdict', async () => {
    const res = await recordPcrObservation({
      underlying: 'SPY',
      asof: etTs(0),
      pcr: pcrWith(1.4),
      trio,
    });
    expect(res.written).toBe(true);
    const rec = res.record!;
    expect(rec.underlying).toBe('SPY');
    expect(rec.pcrVolume).toBeCloseTo(1.4, 6);
    expect(rec.pcrRegime).toBe('bearish');
    expect(rec.contrarian).toBe('bullish');
    expect(rec.pcrZ).toBeNull(); // no prior history yet
    expect(rec.trio).toEqual(trio);
    expect(rec.expiriesUsed).toEqual(['2026-08-21']);
  });

  it('dedups to one row per underlying per session', async () => {
    const first = await recordPcrObservation({
      underlying: 'SPY',
      asof: etTs(0),
      pcr: pcrWith(0.8),
      trio,
    });
    expect(first.written).toBe(true);
    // Same ET session, later tick → no-op returning the existing row.
    const again = await recordPcrObservation({
      underlying: 'SPY',
      asof: etTs(0) + 3_600_000,
      pcr: pcrWith(1.9),
      trio,
    });
    expect(again.written).toBe(false);
    expect(again.reason).toBe('duplicate');
    expect(again.record!.pcrVolume).toBeCloseTo(0.8, 6);
    expect(await listPcrShadowSignals()).toHaveLength(1);
  });

  it('computes the z-score from prior sessions once enough history exists', async () => {
    // Seed 4 prior sessions with pcrVolume {0.5, 1.5, 0.5, 1.5}: mean 1.0, σ 0.5.
    const seeds = [0.5, 1.5, 0.5, 1.5];
    for (let i = 0; i < seeds.length; i++) {
      await recordPcrObservation({
        underlying: 'SPY',
        asof: etTs(i),
        pcr: pcrWith(seeds[i]),
        trio,
      });
    }
    // New session with pcrVolume 1.5 → z = (1.5 - 1.0)/0.5 = 1.0.
    const res = await recordPcrObservation({
      underlying: 'SPY',
      asof: etTs(seeds.length),
      pcr: pcrWith(1.5),
      trio,
    });
    expect(res.record!.pcrZ).toBeCloseTo(1.0, 6);
  });

  it('keeps per-underlying history separate for the z-score', async () => {
    // SPY history is flat at 0.8; QQQ gets its own first observation → null z.
    for (let i = 0; i < 3; i++) {
      await recordPcrObservation({ underlying: 'SPY', asof: etTs(i), pcr: pcrWith(0.8), trio });
    }
    const qqq = await recordPcrObservation({
      underlying: 'QQQ',
      asof: etTs(3),
      pcr: pcrWith(1.2),
      trio,
    });
    expect(qqq.record!.pcrZ).toBeNull();
  });

  it('records an illiquid read as null with a reason and excludes it from the usable count', async () => {
    const illiquid = computePutCallRatio([row('put', 100, 100), row('call', 105, 100)]); // 200 < 500
    const res = await recordPcrObservation({
      underlying: 'SPY',
      asof: etTs(0),
      pcr: illiquid,
      trio: null,
    });
    expect(res.written).toBe(true);
    expect(res.record!.pcrVolume).toBeNull();
    expect(res.record!.insufficientLiquidity).toBe(true);
    expect(res.record!.reason).toMatch(/insufficient_liquidity/);
    expect(res.record!.pcrZ).toBeNull();
    expect(usableSignalCount(await listPcrShadowSignals())).toBe(0);
  });

  it('an illiquid session does not leave a hole in the z basis', async () => {
    await recordPcrObservation({ underlying: 'SPY', asof: etTs(0), pcr: pcrWith(0.5), trio });
    await recordPcrObservation({ underlying: 'SPY', asof: etTs(1), pcr: pcrWith(1.5), trio });
    // Illiquid session in the middle — contributes no pcrVolume.
    const illiquid = computePutCallRatio([row('put', 100, 50), row('call', 105, 50)]);
    await recordPcrObservation({ underlying: 'SPY', asof: etTs(2), pcr: illiquid, trio });
    await recordPcrObservation({ underlying: 'SPY', asof: etTs(3), pcr: pcrWith(0.5), trio });
    await recordPcrObservation({ underlying: 'SPY', asof: etTs(4), pcr: pcrWith(1.5), trio });
    // History for a new obs = {0.5, 1.5, 0.5, 1.5} (illiquid skipped): mean 1.0, σ 0.5.
    const res = await recordPcrObservation({
      underlying: 'SPY',
      asof: etTs(5),
      pcr: pcrWith(1.5),
      trio,
    });
    expect(res.record!.pcrZ).toBeCloseTo(1.0, 6);
  });

  it('survives a reload from the append-only file', async () => {
    await recordPcrObservation({ underlying: 'SPY', asof: etTs(0), pcr: pcrWith(0.9), trio });
    await recordPcrObservation({ underlying: 'QQQ', asof: etTs(0), pcr: pcrWith(1.1), trio });
    // Fresh in-memory view over the same file.
    setPcrShadowLedgerFileForTests(file);
    await initPcrShadowLedger();
    const rows = await listPcrShadowSignals();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.underlying).sort()).toEqual(['QQQ', 'SPY']);
  });
});

describe('usableSignalCount', () => {
  it('counts only rows carrying a usable ratio', async () => {
    await recordPcrObservation({ underlying: 'SPY', asof: etTs(0), pcr: pcrWith(0.8), trio });
    const illiquid = computePutCallRatio([row('put', 100, 50), row('call', 105, 50)]);
    await recordPcrObservation({ underlying: 'QQQ', asof: etTs(0), pcr: illiquid, trio: null });
    expect(usableSignalCount(await listPcrShadowSignals())).toBe(1);
  });
});
