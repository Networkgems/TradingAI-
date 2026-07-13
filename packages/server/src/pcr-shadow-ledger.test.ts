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
  pcrSampleSufficiency,
  isPcrShadowEnabled,
  PCR_SHADOW_FLAG,
  type PcrTrioVerdict,
  type PcrShadowRecord,
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

// A 10-session history alternating 0.5/1.5: mean 1.0, SAMPLE σ = sqrt(2.5/9).
// 10 is the z floor (PCR_Z_MIN_SAMPLES) and n-1 is the Bessel correction — both
// are the TRA-1663 fix, so the fixtures are shared by every z assertion below.
const ALT = [0.5, 1.5, 0.5, 1.5, 0.5, 1.5, 0.5, 1.5, 0.5, 1.5];
const SAMPLE_SD = Math.sqrt(2.5 / 9);

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
    // 10 prior sessions alternating {0.5, 1.5}: mean 1.0, SAMPLE σ = sqrt(2.5/9).
    for (let i = 0; i < 10; i++) {
      await recordPcrObservation({
        underlying: 'SPY',
        asof: etTs(i),
        pcr: pcrWith(ALT[i]),
        trio,
      });
    }
    const res = await recordPcrObservation({
      underlying: 'SPY',
      asof: etTs(10),
      pcr: pcrWith(1.5),
      trio,
    });
    expect(res.record!.pcrZ).toBeCloseTo(0.5 / SAMPLE_SD, 6);
  });

  // TRA-1663 regression. The old minSamples=2 emitted a z from session 3 onward,
  // off a 2-point POPULATION σ — biased low, so |z| came out biased high and the
  // opening sessions of an append-only ledger manufactured extreme-|z| rows in
  // exactly the buckets the TRA-532 promotion bar reads as edge.
  it('emits pcrZ: null through the immature window, then a z at 10 trailing sessions', async () => {
    const z: (number | null)[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await recordPcrObservation({
        underlying: 'SPY',
        asof: etTs(i),
        pcr: pcrWith(ALT[i % ALT.length]),
        trio,
      });
      z.push(res.record!.pcrZ);
    }
    // Rows 0..9 see 0..9 trailing sessions — all below the floor.
    expect(z.slice(0, 10)).toEqual(Array(10).fill(null));
    // Row 10 is the first with 10 trailing sessions.
    expect(z[10]).not.toBeNull();
    // Rows still accrued while their z was null — usableSignalCount counts the
    // ratio, not the z, so the floor costs the promotion window nothing.
    expect(usableSignalCount(await listPcrShadowSignals())).toBe(11);
  });

  it('keeps per-underlying history separate for the z-score', async () => {
    // SPY accrues a full mature window; QQQ's first observation still has no
    // history of its own → null z (history must not pool across names).
    for (let i = 0; i < 10; i++) {
      await recordPcrObservation({ underlying: 'SPY', asof: etTs(i), pcr: pcrWith(ALT[i]), trio });
    }
    const qqq = await recordPcrObservation({
      underlying: 'QQQ',
      asof: etTs(10),
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
    // 10 usable sessions with an illiquid one wedged in the middle. The illiquid
    // row carries no pcrVolume, so it is skipped by the z basis rather than
    // counted as a session — the 10 usable priors still make a mature window.
    const illiquid = computePutCallRatio([row('put', 100, 50), row('call', 105, 50)]);
    for (let i = 0; i < 5; i++) {
      await recordPcrObservation({ underlying: 'SPY', asof: etTs(i), pcr: pcrWith(ALT[i]), trio });
    }
    await recordPcrObservation({ underlying: 'SPY', asof: etTs(5), pcr: illiquid, trio });
    for (let i = 5; i < 10; i++) {
      await recordPcrObservation({
        underlying: 'SPY',
        asof: etTs(i + 1),
        pcr: pcrWith(ALT[i]),
        trio,
      });
    }
    // History = the 10 usable priors (illiquid skipped): mean 1.0, sample σ.
    const res = await recordPcrObservation({
      underlying: 'SPY',
      asof: etTs(11),
      pcr: pcrWith(1.5),
      trio,
    });
    expect(res.record!.pcrZ).toBeCloseTo(0.5 / SAMPLE_SD, 6);
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

// TRA-1663 — the promotion bar is four legs, not a row count.
// TRA-1676 — and a fifth, because legs 1-4 grade ratio rows while the read grades z rows.
describe('pcrSampleSufficiency', () => {
  // `names` underlyings x `sessions` ET sessions, one usable row each. Rows from
  // session index `zFrom` onward carry a z; earlier ones are the warm-up (null z),
  // mirroring `trailingPcrVolume` — each name's z is null through its own 10th
  // session. `zFrom: Infinity` (the default) = no row has a z at all.
  function grid(names: number, sessions: number, zFrom = Infinity): PcrShadowRecord[] {
    const out: PcrShadowRecord[] = [];
    for (let s = 0; s < sessions; s++) {
      for (let u = 0; u < names; u++) {
        out.push({
          id: `N${u}:S${s}`,
          session: `2026-06-${String(s + 1).padStart(2, '0')}`,
          underlying: `N${u}`,
          asof: etTs(s),
          pcrVolume: 1.0,
          pcrOi: 1.0,
          pcrZ: s >= zFrom ? 1.2 : null,
          pcrRegime: 'neutral',
          contrarian: null,
          expiriesUsed: ['2026-08-21'],
          putVolume: 1000,
          callVolume: 1000,
          aggregateVolume: 2000,
          insufficientLiquidity: false,
          reason: null,
          trio,
        });
      }
    }
    return out;
  }

  it('fails closed on an empty ledger — 0 rows must not vacuously clear the concentration or z leg', () => {
    const s = pcrSampleSufficiency([]);
    expect(s.promotionReady).toBe(false);
    expect(s.legs.nameConcentration).toBe(false);
    expect(s.shortfall).toContain('no usable rows');
    // TRA-1676: the fifth leg must fail closed too.
    expect(s.zSessionCount).toBe(0);
    expect(s.legs.zSessionCount).toBe(false);
    expect(s.shortfall).toContain('zSessionCount 0 < 20');
  });

  // The defect that made the old row-count bar wrong: 25 names x 9 sessions is
  // 225 rows -> the old `usableCount >= 200` fired here, ~11 sessions short of
  // the real bar, and the handoff it triggered would have bounced straight back.
  it('is NOT ready at 225 rows spanning only 9 sessions', () => {
    const s = pcrSampleSufficiency(grid(25, 9));
    expect(s.usableCount).toBe(225);
    expect(s.legs.usableCount).toBe(true); // the old bar's sole leg — passes
    expect(s.sessionCount).toBe(9);
    expect(s.legs.sessionCount).toBe(false); // the leg it never checked
    expect(s.promotionReady).toBe(false);
    expect(s.shortfall).toContain('sessionCount 9 < 20');
  });

  // The green branch, and the only shape that produces it: 20 sessions of rows
  // that ALL carry a z. If this ever goes red the gate can never release.
  it('is ready at 25 names x 20 z-bearing sessions — all five legs hold', () => {
    const s = pcrSampleSufficiency(grid(25, 20, 0));
    expect(s).toMatchObject({
      usableCount: 500,
      sessionCount: 20,
      underlyingCount: 25,
      zSessionCount: 20,
      promotionReady: true,
      shortfall: [],
    });
    expect(s.legs.zSessionCount).toBe(true);
    expect(s.maxNameSharePct).toBeCloseTo(4, 6);
  });

  it('fails a sample dominated by one name even when every other leg holds', () => {
    // 4 names x 20 sessions clears count/sessions, but only 4 underlyings and
    // each holds 25% -> the underlying-count leg is what catches it.
    const s = pcrSampleSufficiency(grid(4, 20));
    expect(s.legs.usableCount).toBe(false); // 80 rows
    expect(s.legs.underlyingCount).toBe(false);
    expect(s.promotionReady).toBe(false);

    // Now the concentration leg specifically: 5 names, 20 sessions, but one name
    // carries 200 extra rows -> 50% share.
    const skewed = [
      ...grid(5, 20),
      ...Array.from({ length: 200 }, (_, i) => ({
        ...grid(1, 1)[0],
        id: `N0:X${i}`,
        underlying: 'N0',
      })),
    ];
    const t = pcrSampleSufficiency(skewed);
    expect(t.underlyingCount).toBe(5);
    expect(t.sessionCount).toBe(20);
    expect(t.usableCount).toBe(300); // 100 from the grid + 200 piled onto N0
    expect(t.maxNameSharePct).toBeCloseTo(100 * (220 / 300), 6); // N0: 20 + 200
    expect(t.legs.nameConcentration).toBe(false);
    expect(t.promotionReady).toBe(false);
  });

  it('grades on USABLE rows only — illiquid rows inflate no leg', async () => {
    const illiquid = computePutCallRatio([row('put', 100, 50), row('call', 105, 50)]);
    await recordPcrObservation({ underlying: 'SPY', asof: etTs(0), pcr: pcrWith(0.8), trio });
    await recordPcrObservation({ underlying: 'QQQ', asof: etTs(0), pcr: illiquid, trio: null });
    const s = pcrSampleSufficiency(await listPcrShadowSignals());
    expect(s.usableCount).toBe(1);
    expect(s.underlyingCount).toBe(1); // QQQ's nulled row contributes nothing
    expect(s.promotionReady).toBe(false);
  });

  // TRA-1676 — the defect the four-leg bar could not see. The z warm-up means the
  // ratio population and the z population are NOT the same rows, so a ledger can
  // be green on all four ratio legs while the read's own sample is half-built.
  describe('the fifth leg — z-bearing sessions', () => {
    it('is NOT ready at 25 names x 20 sessions: 4 legs green on 500 ratio rows, but only 10 z-bearing sessions', () => {
      // The real accrual: each name's z is null through its own 10th session, so
      // at ledger session 20 the ledger carries 500 usable rows and 10 z sessions.
      const s = pcrSampleSufficiency(grid(25, 20, 10));

      // Every leg the old bar graded is green...
      expect(s.usableCount).toBe(500);
      expect(s.legs.usableCount).toBe(true);
      expect(s.legs.sessionCount).toBe(true);
      expect(s.legs.underlyingCount).toBe(true);
      expect(s.legs.nameConcentration).toBe(true);

      // ...and the sample the promotion read actually consumes is half the bar.
      expect(s.zSessionCount).toBe(10);
      expect(s.legs.zSessionCount).toBe(false);
      expect(s.promotionReady).toBe(false);
      expect(s.shortfall).toEqual(['zSessionCount 10 < 20']);
    });

    it('is ready at 25 names x 30 sessions — 10 warm-up + 20 z-bearing', () => {
      const s = pcrSampleSufficiency(grid(25, 30, 10));
      expect(s.sessionCount).toBe(30);
      expect(s.zSessionCount).toBe(20);
      expect(s.legs.zSessionCount).toBe(true);
      expect(s.promotionReady).toBe(true);
      expect(s.shortfall).toEqual([]);
    });

    // Boundary, from the failing side: one z-session short must still hold the gate.
    it('holds at 19 z-bearing sessions and releases at exactly 20', () => {
      const short = pcrSampleSufficiency(grid(25, 30, 11));
      expect(short.zSessionCount).toBe(19);
      expect(short.promotionReady).toBe(false);
      expect(short.shortfall).toEqual(['zSessionCount 19 < 20']);

      const exact = pcrSampleSufficiency(grid(25, 30, 10));
      expect(exact.zSessionCount).toBe(20);
      expect(exact.promotionReady).toBe(true);
    });

    it('counts SESSIONS, not z rows — 500 z rows on 10 sessions do not clear it', () => {
      // Same 10 z-bearing sessions, but every name carries a z on each of them.
      // A row-count leg would read 250 and feel roomy; the leg reads 10 and holds.
      const s = pcrSampleSufficiency(grid(25, 20, 10));
      const zRows = grid(25, 20, 10).filter((r) => typeof r.pcrZ === 'number').length;
      expect(zRows).toBe(250);
      expect(s.zSessionCount).toBe(10);
      expect(s.promotionReady).toBe(false);
    });

    it('a z-bearing row is what counts the session — one name is enough, a null-z session is not', () => {
      const rows = grid(3, 2); // 2 sessions, no z anywhere
      expect(pcrSampleSufficiency(rows).zSessionCount).toBe(0);

      // Give exactly ONE row in ONE session a z: that session, and only it, counts.
      const withOneZ = rows.map((r, i) => (i === 0 ? { ...r, pcrZ: -2.4 } : r));
      expect(pcrSampleSufficiency(withOneZ).zSessionCount).toBe(1);
    });
  });
});
