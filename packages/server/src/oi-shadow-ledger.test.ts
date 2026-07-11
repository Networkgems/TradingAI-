import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';
import { computeOiTotals } from '@trading-app/engine';
import type { OptionChainRow } from '@trading-app/engine';
import {
  setOiShadowLedgerFileForTests,
  initOiShadowLedger,
  recordOiObservation,
  listOiShadowSignals,
  usableSignalCount,
  isOiShadowEnabled,
  OI_SHADOW_FLAG,
} from './oi-shadow-ledger.js';
import type { PcrTrioVerdict } from './pcr-shadow-ledger.js';

// A mid-RTH ET timestamp for a given day offset (days from 2026-06-16).
function etTs(dayOffset: number): number {
  return Date.UTC(2026, 5, 16 + dayOffset, 18, 0); // 18:00Z ~ 14:00 ET
}

function row(
  optionType: 'call' | 'put',
  strike: number,
  openInterest: number,
  expiration = '2026-08-21',
): OptionChainRow {
  return {
    optionSymbol: `X${optionType[0]}${strike}`,
    underlying: 'SPY',
    optionType,
    strike,
    expiration,
    openInterest,
  };
}

// Build an OiTotals with a target total OI split across a call and a put.
function oiWith(total: number) {
  const call = Math.round(total / 2);
  const put = total - call;
  return computeOiTotals([row('call', 100, call), row('put', 95, put)]);
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
  file = join(tmpdir(), `oi-shadow-${process.pid}-${n++}.jsonl`);
  setOiShadowLedgerFileForTests(file);
  process.env[OI_SHADOW_FLAG] = '1';
  await initOiShadowLedger();
});

afterEach(() => {
  setOiShadowLedgerFileForTests(null);
  delete process.env[OI_SHADOW_FLAG];
  try {
    rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
});

describe('isOiShadowEnabled (flag gate)', () => {
  it('is off when unset or falsy', () => {
    expect(isOiShadowEnabled({})).toBe(false);
    expect(isOiShadowEnabled({ [OI_SHADOW_FLAG]: '0' })).toBe(false);
    expect(isOiShadowEnabled({ [OI_SHADOW_FLAG]: 'false' })).toBe(false);
  });
  it('is on for truthy spellings', () => {
    for (const v of ['1', 'true', 'yes', 'on', ' TRUE ']) {
      expect(isOiShadowEnabled({ [OI_SHADOW_FLAG]: v })).toBe(true);
    }
  });
});

describe('recordOiObservation', () => {
  it('no-ops with the flag off', async () => {
    delete process.env[OI_SHADOW_FLAG];
    const res = await recordOiObservation({
      underlying: 'SPY',
      asof: etTs(0),
      oi: oiWith(1000),
      underlyingClose: 100,
      trio,
    });
    expect(res.written).toBe(false);
    expect(res.reason).toBe('flag_off');
    expect(await listOiShadowSignals()).toHaveLength(0);
  });

  it('writes a first-session row with a null quadrant (no prior snapshot)', async () => {
    const res = await recordOiObservation({
      underlying: 'SPY',
      asof: etTs(0),
      oi: oiWith(1000),
      underlyingClose: 100,
      trio,
    });
    expect(res.written).toBe(true);
    const rec = res.record!;
    expect(rec.oiTotal).toBe(1000);
    expect(rec.priorSession).toBeNull();
    expect(rec.oiDelta).toBeNull();
    expect(rec.priceDelta).toBeNull();
    expect(rec.quadrant).toBeNull();
    expect(rec.conviction).toBeNull();
    expect(rec.reason).toBe('no_prior_snapshot');
    expect(rec.oiAsOf).toBe(rec.session);
    expect(rec.trio).toEqual(trio);
  });

  it('classifies price up / OI up as strong / confirm vs the prior session', async () => {
    await recordOiObservation({
      underlying: 'SPY',
      asof: etTs(0),
      oi: oiWith(1000),
      underlyingClose: 100,
      trio,
    });
    const res = await recordOiObservation({
      underlying: 'SPY',
      asof: etTs(1),
      oi: oiWith(1500), // OI up
      underlyingClose: 102, // price up
      trio,
    });
    const rec = res.record!;
    expect(rec.priorSession).toBe(await sessionOf(etTs(0)));
    expect(rec.oiDelta).toBe(500);
    expect(rec.priceDelta).toBeCloseTo(2, 6);
    expect(rec.quadrant).toBe('strong');
    expect(rec.conviction).toBe('confirm');
    expect(rec.priceDirection).toBe('up');
    expect(rec.oiDirection).toBe('up');
  });

  it('classifies price down / OI up as weak / veto-candidate (fresh shorts)', async () => {
    await recordOiObservation({
      underlying: 'SPY',
      asof: etTs(0),
      oi: oiWith(1000),
      underlyingClose: 100,
      trio,
    });
    const res = await recordOiObservation({
      underlying: 'SPY',
      asof: etTs(1),
      oi: oiWith(1500), // OI up
      underlyingClose: 98, // price down
      trio,
    });
    expect(res.record!.quadrant).toBe('weak');
    expect(res.record!.conviction).toBe('veto-candidate');
  });

  it('dedups to one row per underlying per session', async () => {
    const first = await recordOiObservation({
      underlying: 'SPY',
      asof: etTs(0),
      oi: oiWith(1000),
      underlyingClose: 100,
      trio,
    });
    expect(first.written).toBe(true);
    const again = await recordOiObservation({
      underlying: 'SPY',
      asof: etTs(0) + 3_600_000,
      oi: oiWith(9999),
      underlyingClose: 200,
      trio,
    });
    expect(again.written).toBe(false);
    expect(again.reason).toBe('duplicate');
    expect(again.record!.oiTotal).toBe(1000);
    expect(await listOiShadowSignals()).toHaveLength(1);
  });

  it('records an illiquid read as null and excludes it from the usable count', async () => {
    const illiquid = computeOiTotals([row('call', 100, 0), row('put', 95, 0)]);
    const res = await recordOiObservation({
      underlying: 'SPY',
      asof: etTs(0),
      oi: illiquid,
      underlyingClose: 100,
      trio: null,
    });
    expect(res.written).toBe(true);
    expect(res.record!.oiTotal).toBeNull();
    expect(res.record!.insufficientData).toBe(true);
    expect(res.record!.reason).toBe('no_open_interest');
    expect(res.record!.quadrant).toBeNull();
    expect(usableSignalCount(await listOiShadowSignals())).toBe(0);
  });

  it('an illiquid session does not become the delta basis', async () => {
    await recordOiObservation({
      underlying: 'SPY',
      asof: etTs(0),
      oi: oiWith(1000),
      underlyingClose: 100,
      trio,
    });
    // Illiquid middle session — null oiTotal, skipped as a prior basis.
    const illiquid = computeOiTotals([row('call', 100, 0)]);
    await recordOiObservation({
      underlying: 'SPY',
      asof: etTs(1),
      oi: illiquid,
      underlyingClose: 105,
      trio,
    });
    // Next liquid session should diff against session 0 (1000 -> 1500, 100 -> 102).
    const res = await recordOiObservation({
      underlying: 'SPY',
      asof: etTs(2),
      oi: oiWith(1500),
      underlyingClose: 102,
      trio,
    });
    const rec = res.record!;
    expect(rec.priorSession).toBe(await sessionOf(etTs(0)));
    expect(rec.oiDelta).toBe(500);
    expect(rec.priceDelta).toBeCloseTo(2, 6);
    expect(rec.quadrant).toBe('strong');
  });

  it('keeps per-underlying history separate', async () => {
    await recordOiObservation({
      underlying: 'SPY',
      asof: etTs(0),
      oi: oiWith(1000),
      underlyingClose: 100,
      trio,
    });
    const qqq = await recordOiObservation({
      underlying: 'QQQ',
      asof: etTs(1),
      oi: oiWith(2000),
      underlyingClose: 300,
      trio,
    });
    // QQQ's first row — no SPY carryover into its deltas.
    expect(qqq.record!.priorSession).toBeNull();
    expect(qqq.record!.quadrant).toBeNull();
  });

  it('survives a reload from the append-only file', async () => {
    await recordOiObservation({
      underlying: 'SPY',
      asof: etTs(0),
      oi: oiWith(1000),
      underlyingClose: 100,
      trio,
    });
    await recordOiObservation({
      underlying: 'QQQ',
      asof: etTs(0),
      oi: oiWith(2000),
      underlyingClose: 300,
      trio,
    });
    setOiShadowLedgerFileForTests(file);
    await initOiShadowLedger();
    const rows = await listOiShadowSignals();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.underlying).sort()).toEqual(['QQQ', 'SPY']);
  });
});

describe('usableSignalCount', () => {
  it('counts only rows carrying a non-null quadrant', async () => {
    // Session 0: first snapshot (null quadrant), session 1: real quadrant.
    await recordOiObservation({
      underlying: 'SPY',
      asof: etTs(0),
      oi: oiWith(1000),
      underlyingClose: 100,
      trio,
    });
    await recordOiObservation({
      underlying: 'SPY',
      asof: etTs(1),
      oi: oiWith(1500),
      underlyingClose: 102,
      trio,
    });
    expect(usableSignalCount(await listOiShadowSignals())).toBe(1);
  });
});

// The ET session key the ledger derives — re-derived here so assertions don't
// hard-code the calendar mapping.
async function sessionOf(ts: number): Promise<string> {
  const { etDateKey } = await import('./options-chain-recorder.js');
  return etDateKey(ts);
}
