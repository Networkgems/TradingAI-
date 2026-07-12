import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';
import { selectWeeklyPcs, type PcsPutQuote, type WeeklyPcsSignal } from '@trading-app/engine';
import {
  setPcsShadowLedgerFileForTests,
  initPcsShadowLedger,
  recordWeeklyPcsEntry,
  settleDuePcsEntries,
  listPcsShadowSignals,
  collectPcsShadowPaperSamples,
  settledSignalCount,
  isPcsShadowEnabled,
  PCS_SHADOW_FLAG,
  PCS_SHADOW_STRATEGY_ID,
} from './pcs-shadow-ledger.js';

// A synthetic QQQ put chain around a given spot (mirrors the engine test).
function qqqPuts(spot: number): PcsPutQuote[] {
  const rows: PcsPutQuote[] = [];
  for (let k = spot - 60; k <= spot; k += 1) {
    const otm = spot - k;
    const iv = 0.16 + otm * 0.0015;
    const mid = Math.max(0.05, 6 - otm * 0.09);
    rows.push({
      strike: k,
      optionType: 'put',
      bid: Number((mid - 0.05).toFixed(2)),
      ask: Number((mid + 0.05).toFixed(2)),
      smvVol: iv,
    });
  }
  return rows;
}

function sigAt(spot: number): WeeklyPcsSignal {
  const s = selectWeeklyPcs({ spot, dteDays: 7, puts: qqqPuts(spot) });
  if (!s) throw new Error('fixture: no signal');
  return s;
}

// A Friday-ish ET timestamp for a given week offset (weeks from 2026-06-19, a Fri).
function friTs(weekOffset: number): number {
  return Date.UTC(2026, 5, 19 + weekOffset * 7, 18, 0);
}
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

let file: string;
let n = 0;

beforeEach(async () => {
  file = join(tmpdir(), `pcs-shadow-${process.pid}-${n++}.jsonl`);
  setPcsShadowLedgerFileForTests(file);
  process.env[PCS_SHADOW_FLAG] = '1';
  await initPcsShadowLedger();
});

afterEach(() => {
  setPcsShadowLedgerFileForTests(null);
  delete process.env[PCS_SHADOW_FLAG];
  try {
    rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
});

describe('isPcsShadowEnabled (flag gate)', () => {
  it('is off when unset or falsy', () => {
    expect(isPcsShadowEnabled({})).toBe(false);
    expect(isPcsShadowEnabled({ [PCS_SHADOW_FLAG]: '0' })).toBe(false);
    expect(isPcsShadowEnabled({ [PCS_SHADOW_FLAG]: 'false' })).toBe(false);
  });
  it('is on for truthy spellings', () => {
    for (const v of ['1', 'true', 'yes', 'on', ' TRUE ']) {
      expect(isPcsShadowEnabled({ [PCS_SHADOW_FLAG]: v })).toBe(true);
    }
  });
});

describe('recordWeeklyPcsEntry', () => {
  it('no-ops with the flag off (no live orders, nothing written)', async () => {
    delete process.env[PCS_SHADOW_FLAG];
    const res = await recordWeeklyPcsEntry({
      underlying: 'QQQ',
      asof: friTs(0),
      signal: sigAt(500),
      expiryMs: friTs(0) + WEEK_MS,
    });
    expect(res.written).toBe(false);
    expect(res.reason).toBe('flag_off');
    expect(await listPcsShadowSignals()).toHaveLength(0);
  });

  it('writes one open row per weekly cycle and dedupes within the cycle', async () => {
    const first = await recordWeeklyPcsEntry({
      underlying: 'QQQ',
      asof: friTs(0),
      signal: sigAt(500),
      expiryMs: friTs(0) + WEEK_MS,
    });
    expect(first.written).toBe(true);
    expect(first.record?.status).toBe('open');

    // A second capture the same cycle (e.g. a later tick) is a no-op.
    const dup = await recordWeeklyPcsEntry({
      underlying: 'QQQ',
      asof: friTs(0) + 3 * 60 * 60 * 1000,
      signal: sigAt(501),
      expiryMs: friTs(0) + WEEK_MS,
    });
    expect(dup.written).toBe(false);
    expect(dup.reason).toBe('duplicate');
    expect(await listPcsShadowSignals()).toHaveLength(1);

    // A new week opens a fresh row.
    const next = await recordWeeklyPcsEntry({
      underlying: 'QQQ',
      asof: friTs(1),
      signal: sigAt(505),
      expiryMs: friTs(1) + WEEK_MS,
    });
    expect(next.written).toBe(true);
    expect(await listPcsShadowSignals()).toHaveLength(2);
  });
});

describe('settleDuePcsEntries', () => {
  it('leaves a spread open before expiry and settles it after', async () => {
    const open = friTs(0);
    const expiry = open + WEEK_MS;
    await recordWeeklyPcsEntry({ underlying: 'QQQ', asof: open, signal: sigAt(500), expiryMs: expiry });

    // Before expiry — nothing settles.
    const early = await settleDuePcsEntries(expiry - 1, () => 505);
    expect(early.settled).toBe(0);
    expect((await listPcsShadowSignals())[0]!.status).toBe('open');

    // At/after expiry, spot well above the short strike → keeps full credit.
    const done = await settleDuePcsEntries(expiry + 1, () => 505);
    expect(done.settled).toBe(1);
    const rec = (await listPcsShadowSignals())[0]!;
    expect(rec.status).toBe('settled');
    expect(rec.pnl).toBeGreaterThan(0);
    expect(rec.breached).toBe(false);
    expect(rec.settleSpot).toBe(505);
    expect(rec.R).toBeGreaterThan(0);
  });

  it('records a defined loss on a breach and never double-settles', async () => {
    const open = friTs(0);
    const expiry = open + WEEK_MS;
    const sig = sigAt(500);
    await recordWeeklyPcsEntry({ underlying: 'QQQ', asof: open, signal: sig, expiryMs: expiry });

    const done = await settleDuePcsEntries(expiry + 1, () => sig.longStrike - 10);
    expect(done.settled).toBe(1);
    const rec = (await listPcsShadowSignals())[0]!;
    expect(rec.maxLoss).toBe(true);
    expect(rec.pnl).toBeLessThan(0);
    expect(rec.R).toBeGreaterThan(-1.2); // bounded max loss

    // A second sweep settles nothing more (already settled).
    const again = await settleDuePcsEntries(expiry + 2, () => 400);
    expect(again.settled).toBe(0);
  });

  it('retries a spread whose spot lookup is unavailable', async () => {
    const open = friTs(0);
    const expiry = open + WEEK_MS;
    await recordWeeklyPcsEntry({ underlying: 'QQQ', asof: open, signal: sigAt(500), expiryMs: expiry });

    const miss = await settleDuePcsEntries(expiry + 1, () => null);
    expect(miss.settled).toBe(0);
    expect((await listPcsShadowSignals())[0]!.status).toBe('open');

    const hit = await settleDuePcsEntries(expiry + 1, () => 505);
    expect(hit.settled).toBe(1);
  });

  it('no-ops with the flag off', async () => {
    const open = friTs(0);
    const expiry = open + WEEK_MS;
    await recordWeeklyPcsEntry({ underlying: 'QQQ', asof: open, signal: sigAt(500), expiryMs: expiry });
    delete process.env[PCS_SHADOW_FLAG];
    const res = await settleDuePcsEntries(expiry + 1, () => 505);
    expect(res.settled).toBe(0);
  });
});

describe('collectPcsShadowPaperSamples (promotion-gate feed)', () => {
  it('maps settled cycles to R-preserving paper samples for the base-PCS id', async () => {
    const open = friTs(0);
    const expiry = open + WEEK_MS;
    const sig = sigAt(500);
    await recordWeeklyPcsEntry({ underlying: 'QQQ', asof: open, signal: sig, expiryMs: expiry });
    await settleDuePcsEntries(expiry + 1, () => 505);

    const samples = await collectPcsShadowPaperSamples(PCS_SHADOW_STRATEGY_ID);
    expect(samples).toHaveLength(1);
    const s = samples[0]!;
    // riskAmount = |entryPrice − stopLoss| × quantity = (width − credit) × 100.
    const riskAmount = Math.abs(s.entryPrice - s.stopLoss) * s.quantity;
    expect(riskAmount).toBeCloseTo(sig.riskDollars, 6);
    // R the gate would recover matches the settlement R.
    const rec = (await listPcsShadowSignals())[0]!;
    expect(s.pnl! / riskAmount).toBeCloseTo(rec.R!, 6);
    expect(s.openedAt).toBe(open);
    expect(typeof s.closedAt).toBe('number');
  });

  it('excludes open (unsettled) cycles from the paper feed', async () => {
    await recordWeeklyPcsEntry({
      underlying: 'QQQ',
      asof: friTs(0),
      signal: sigAt(500),
      expiryMs: friTs(0) + WEEK_MS,
    });
    expect(await collectPcsShadowPaperSamples(PCS_SHADOW_STRATEGY_ID)).toHaveLength(0);
    const recs = await listPcsShadowSignals();
    expect(settledSignalCount(recs)).toBe(0);
  });

  it('returns nothing for a different strategy id or with the flag off', async () => {
    const open = friTs(0);
    const expiry = open + WEEK_MS;
    await recordWeeklyPcsEntry({ underlying: 'QQQ', asof: open, signal: sigAt(500), expiryMs: expiry });
    await settleDuePcsEntries(expiry + 1, () => 505);

    expect(await collectPcsShadowPaperSamples('some_other_strategy')).toHaveLength(0);
    expect(await collectPcsShadowPaperSamples(PCS_SHADOW_STRATEGY_ID, {})).toHaveLength(0);
  });
});

describe('durability', () => {
  it('folds the append-only ledger latest-line-wins across a reload', async () => {
    const open = friTs(0);
    const expiry = open + WEEK_MS;
    await recordWeeklyPcsEntry({ underlying: 'QQQ', asof: open, signal: sigAt(500), expiryMs: expiry });
    await settleDuePcsEntries(expiry + 1, () => 505);

    // Simulate a restart: drop the cache, reload from disk.
    setPcsShadowLedgerFileForTests(file);
    await initPcsShadowLedger();
    const recs = await listPcsShadowSignals();
    expect(recs).toHaveLength(1);
    expect(recs[0]!.status).toBe('settled');
    expect(settledSignalCount(recs)).toBe(1);
  });
});
