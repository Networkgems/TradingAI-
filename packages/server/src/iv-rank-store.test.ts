import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// TRA-5172 — fault injection for the atomic-persist tests: a one-shot throw
// from `writeFile` simulates a kill while the TMP file is being written, and a
// one-shot throw from `rename` simulates a kill between the tmp write and the
// swap. Passthrough when disarmed, so every other suite in this file runs
// against the real fs.
const fsFault = vi.hoisted(() => ({ failWriteOnce: false, failRenameOnce: false }));
vi.mock('fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs/promises')>();
  return {
    ...real,
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      if (fsFault.failWriteOnce) {
        fsFault.failWriteOnce = false;
        throw new Error('TRA-5172 simulated kill mid-write');
      }
      return real.writeFile(...args);
    },
    rename: async (...args: Parameters<typeof real.rename>) => {
      if (fsFault.failRenameOnce) {
        fsFault.failRenameOnce = false;
        throw new Error('TRA-5172 simulated rename failure');
      }
      return real.rename(...args);
    },
  };
});
import type { OptionChainRow } from '@trading-app/engine';
import {
  computeIvRank,
  computeIvPercentile,
  recordDailyIv,
  ivRankSync,
  ivPercentileSync,
  initIvRankStore,
  atmIvFromRows,
  setIvStoreFileForTests,
  MIN_IV_SAMPLES,
  readIvStoreProvenanceSync,
  readIvRankCoverageSync,
  isIvRankStoreLoaded,
  IV_RANK_COVERAGE_CODES,
  type IvSample,
} from './iv-rank-store.js';
import {
  IV_PERCENTILE_COVERAGE_CODES,
  classifyIvPercentileCoverage,
} from './iv-percentile-coverage.js';

const DAY = 86_400_000;
function samples(ivs: number[], startMs: number): IvSample[] {
  return ivs.map((iv, i) => ({ day: new Date(startMs + i * DAY).toISOString().slice(0, 10), iv }));
}

describe('computeIvRank', () => {
  it('returns null below the minimum sample count', () => {
    expect(computeIvRank(samples([0.2, 0.3, 0.4], 0), 0.3)).toBeNull();
  });

  it('ranks current IV between the window min and max', () => {
    const s = samples(
      Array.from({ length: MIN_IV_SAMPLES }, (_, i) => 0.1 + (i / (MIN_IV_SAMPLES - 1)) * 0.3),
      0,
    ); // 0.10 .. 0.40
    expect(computeIvRank(s, 0.1)).toBeCloseTo(0, 6);
    expect(computeIvRank(s, 0.4)).toBeCloseTo(100, 6);
    expect(computeIvRank(s, 0.25)).toBeCloseTo(50, 6);
  });

  it('clamps an out-of-range current IV into [0,100]', () => {
    const s = samples(Array.from({ length: MIN_IV_SAMPLES }, () => 0).map((_, i) => 0.2 + i * 0.01), 0);
    expect(computeIvRank(s, 0.05)).toBe(0);
    expect(computeIvRank(s, 5)).toBe(100);
  });

  it('returns null when the window is flat', () => {
    expect(computeIvRank(samples(Array.from({ length: MIN_IV_SAMPLES }, () => 0.3), 0), 0.3)).toBeNull();
  });
});

describe('computeIvPercentile (TRA-2028)', () => {
  it('returns null below the minimum sample count', () => {
    expect(computeIvPercentile(samples([0.2, 0.3, 0.4], 0), 0.3)).toBeNull();
  });

  it('is the fraction of the window strictly below the current IV, scaled 0-100', () => {
    // 20 samples 0.10..0.29 (0.10 + i*0.01). currentIv 0.20 → 10 below (0.10..0.19).
    const s = samples(Array.from({ length: MIN_IV_SAMPLES }, (_, i) => 0.1 + i * 0.01), 0);
    expect(computeIvPercentile(s, 0.2)).toBeCloseTo(50, 6);
    expect(computeIvPercentile(s, 0.1)).toBeCloseTo(0, 6); // nothing strictly below the min
    expect(computeIvPercentile(s, 1.0)).toBeCloseTo(100, 6); // everything below
  });

  it('is robust to a single outlier high (unlike IV rank)', () => {
    // A cluster near 0.20 with one 1.00 spike: today's 0.25 sits above ~all the
    // cluster → high percentile, but IV RANK is dragged toward 0 by the outlier max.
    const base = Array.from({ length: MIN_IV_SAMPLES - 1 }, () => 0.2);
    const s = samples([...base, 1.0], 0);
    expect(computeIvPercentile(s, 0.25)).toBeCloseTo((19 / 20) * 100, 6);
    expect(computeIvRank(s, 0.25)).toBeLessThan(10); // outlier compresses the rank
  });
});

describe('atmIvFromRows', () => {
  const row = (strike: number, iv: number): OptionChainRow => ({
    optionSymbol: `O${strike}`,
    underlying: 'X',
    optionType: 'call',
    strike,
    expiration: '2026-07-17',
    smvVol: iv,
  });
  it('picks the IV of the strike nearest spot', () => {
    expect(atmIvFromRows([row(90, 0.5), row(100, 0.3), row(110, 0.6)], 101)).toBe(0.3);
  });
  it('returns null with no usable IV', () => {
    expect(atmIvFromRows([{ optionSymbol: 'O', underlying: 'X', optionType: 'put', strike: 100, expiration: '2026-07-17' }], 100)).toBeNull();
  });
});

describe('recordDailyIv + ivRankSync (disk-backed)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iv-store-'));
    setIvStoreFileForTests(join(dir, 'iv-history.json'));
  });
  afterEach(() => {
    setIvStoreFileForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null before the store is loaded', () => {
    expect(ivRankSync('AAA', 0.3)).toBeNull();
  });

  it('records a trailing series and ranks against it after init', async () => {
    const start = Date.parse('2025-06-01T00:00:00Z');
    for (let i = 0; i < MIN_IV_SAMPLES; i++) {
      await recordDailyIv('AAA', 0.1 + (i / (MIN_IV_SAMPLES - 1)) * 0.3, start + i * DAY);
    }
    await initIvRankStore();
    const asOf = start + (MIN_IV_SAMPLES - 1) * DAY;
    expect(ivRankSync('AAA', 0.4, asOf)).toBeCloseTo(100, 4);
    expect(ivRankSync('AAA', 0.1, asOf)).toBeCloseTo(0, 4);
  });

  it('dedupes multiple samples on the same UTC day', async () => {
    const day = Date.parse('2025-06-01T12:00:00Z');
    await recordDailyIv('BBB', 0.2, day);
    await recordDailyIv('BBB', 0.9, day + 1000); // same UTC day → replaces
    await initIvRankStore();
    // Only one sample → below MIN → null, proving no double-count.
    expect(ivRankSync('BBB', 0.5, day)).toBeNull();
  });

  it('ivPercentileSync reads the same store as ivRankSync (TRA-2028)', async () => {
    const start = Date.parse('2025-06-01T00:00:00Z');
    for (let i = 0; i < MIN_IV_SAMPLES; i++) {
      await recordDailyIv('CCC', 0.1 + i * 0.01, start + i * DAY); // 0.10..0.29
    }
    await initIvRankStore();
    const asOf = start + (MIN_IV_SAMPLES - 1) * DAY;
    expect(ivPercentileSync('CCC', 0.2, asOf)).toBeCloseTo(50, 4);
    expect(ivPercentileSync('CCC', 0.05, asOf)).toBeCloseTo(0, 4);
    expect(ivPercentileSync('DDD', 0.2, asOf)).toBeNull(); // uncovered symbol
  });

  it('ivPercentileSync returns null before the store is loaded', () => {
    expect(ivPercentileSync('AAA', 0.3)).toBeNull();
  });
});

describe('readIvRankCoverageSync (TRA-4917) — the five null branches are separable', () => {
  let dir: string;
  const start = Date.parse('2025-06-01T00:00:00Z');
  const asOf = start + (MIN_IV_SAMPLES + 4) * DAY;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iv-cov-'));
    setIvStoreFileForTests(join(dir, 'iv-history.json'));
  });
  afterEach(() => {
    setIvStoreFileForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  async function seed(symbol: string, ivs: number[]): Promise<void> {
    for (let i = 0; i < ivs.length; i++) await recordDailyIv(symbol, ivs[i]!, start + i * DAY);
  }
  const ramp = (n: number): number[] => Array.from({ length: n }, (_, i) => 0.1 + i * 0.01);

  it('an UNLOADED store reads store_unloaded, and depth is null — NOT 0', () => {
    expect(isIvRankStoreLoaded()).toBe(false);
    const r = readIvRankCoverageSync('AAA', 0.3, asOf);
    expect(r.coverage).toBe('store_unloaded');
    expect(r.ivRank).toBeNull();
    // 0 would be a claim about the symbol; the honest answer is "unknown".
    expect(r.ivSampleDepth).toBeNull();
  });

  it('no ATM IV reads no_atm_iv even when the store is deep — branch (a) vs (b)', async () => {
    await seed('AAA', ramp(MIN_IV_SAMPLES));
    await initIvRankStore();
    const r = readIvRankCoverageSync('AAA', null, asOf);
    expect(r.coverage).toBe('no_atm_iv');
    expect(r.ivRank).toBeNull();
    expect(r.atmIv).toBeNull();
    // The depth is still REPORTED, which is what proves (a) and not (b).
    expect(r.ivSampleDepth).toBe(MIN_IV_SAMPLES);
  });

  it('a non-finite / non-positive ATM IV is no_atm_iv, never ranked', async () => {
    await seed('AAA', ramp(MIN_IV_SAMPLES));
    await initIvRankStore();
    for (const bad of [0, -0.2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(readIvRankCoverageSync('AAA', bad, asOf).coverage).toBe('no_atm_iv');
    }
  });

  it('an unknown symbol with ATM IV in hand reads uncovered (depth 0)', async () => {
    await seed('AAA', ramp(MIN_IV_SAMPLES));
    await initIvRankStore();
    const r = readIvRankCoverageSync('ZZZ', 0.3, asOf);
    expect(r.coverage).toBe('uncovered');
    expect(r.ivSampleDepth).toBe(0);
  });

  it('one sample short of the floor reads insufficient_history; the floor itself covers', async () => {
    await seed('THIN', ramp(MIN_IV_SAMPLES - 1));
    await initIvRankStore();
    const thin = readIvRankCoverageSync('THIN', 0.15, asOf);
    expect(thin.coverage).toBe('insufficient_history');
    expect(thin.ivSampleDepth).toBe(MIN_IV_SAMPLES - 1);
    expect(thin.ivRank).toBeNull();

    await seed('DEEP', ramp(MIN_IV_SAMPLES));
    await initIvRankStore();
    const deep = readIvRankCoverageSync('DEEP', 0.15, asOf);
    expect(deep.coverage).toBe('covered');
    expect(deep.ivSampleDepth).toBe(MIN_IV_SAMPLES);
    expect(deep.ivRank).not.toBeNull();
  });

  it('a FLAT window at/above the floor reads flat_window, not insufficient_history', async () => {
    await seed('FLAT', Array.from({ length: MIN_IV_SAMPLES + 3 }, () => 0.3));
    await initIvRankStore();
    const r = readIvRankCoverageSync('FLAT', 0.3, asOf);
    expect(r.coverage).toBe('flat_window');
    // The discriminator: depth CLEARS the floor, so "warm up and wait" is wrong here.
    expect(r.ivSampleDepth).toBeGreaterThanOrEqual(MIN_IV_SAMPLES);
    expect(r.ivRank).toBeNull();
  });

  it('samples aged out of the trailing window read uncovered, not covered', async () => {
    await seed('OLD', ramp(MIN_IV_SAMPLES));
    await initIvRankStore();
    const wayLater = start + 800 * DAY; // past the 366d trailing window
    const r = readIvRankCoverageSync('OLD', 0.15, wayLater);
    expect(r.coverage).toBe('uncovered');
    expect(r.ivSampleDepth).toBe(0);
  });

  it('the rank it reports is byte-identical to the one ivRankSync gates on', async () => {
    await seed('AAA', ramp(MIN_IV_SAMPLES));
    await initIvRankStore();
    for (const iv of [0.1, 0.15, 0.29, 0.4]) {
      expect(readIvRankCoverageSync('AAA', iv, asOf).ivRank).toBe(ivRankSync('AAA', iv, asOf));
    }
  });

  it('every code the classifier can emit is in the published vocabulary', async () => {
    await seed('AAA', ramp(MIN_IV_SAMPLES));
    await seed('THIN', ramp(3));
    await seed('FLAT', Array.from({ length: MIN_IV_SAMPLES }, () => 0.3));
    await initIvRankStore();
    const emitted = new Set([
      readIvRankCoverageSync('AAA', 0.15, asOf).coverage,
      readIvRankCoverageSync('AAA', null, asOf).coverage,
      readIvRankCoverageSync('ZZZ', 0.3, asOf).coverage,
      readIvRankCoverageSync('THIN', 0.15, asOf).coverage,
      readIvRankCoverageSync('FLAT', 0.3, asOf).coverage,
    ]);
    // Five distinct codes — if any two branches collapsed, this set would shrink.
    expect(emitted.size).toBe(5);
    for (const code of emitted) expect(IV_RANK_COVERAGE_CODES).toContain(code);
  });

  it('carries every IV_PERCENTILE_COVERAGE_CODES name verbatim — the two lists cannot drift', () => {
    // TRA-4917 asked for the TRA-4644 vocabulary to be reused rather than a fifth
    // one minted, and `0fb62e3e` recorded that the constant "does not exist on
    // origin/main". It did — `215fd4db` added it 2026-09-17, eight days earlier;
    // the clearing grep ran against a stale ref in a checkout 285 commits behind.
    // This set relation is what that grep was supposed to establish, asserted
    // mechanically so it stays true as either list changes.
    for (const code of IV_PERCENTILE_COVERAGE_CODES) {
      expect(IV_RANK_COVERAGE_CODES).toContain(code);
    }
  });

  it('is a strict REFINEMENT of the percentile vocabulary — `uncovered` is narrower here', () => {
    // The names overlap but two of them do NOT mean the same thing, so the two
    // surfaces' per-code counts must never be pooled:
    //
    //   percentile `uncovered` = store unloaded OR symbol never recorded
    //   rank       `uncovered` = store LOADED, symbol has zero usable samples
    //
    // An unloaded store is a process-wide fault with a different owner than a
    // per-symbol gap, which is the exact distinction the 164/164 incident lacked.
    expect(isIvRankStoreLoaded()).toBe(false);
    expect(readIvRankCoverageSync('AAA', 0.3, asOf).coverage).toBe('store_unloaded');
    // `classifyIvPercentileCoverage` cannot express that: with no store it sees
    // sampleDepth 0 and answers `uncovered`, pooling the two.
    expect(classifyIvPercentileCoverage(0.3, null, 0)).toBe('uncovered');

    // And the codes this vocabulary adds are genuinely absent from the other one,
    // i.e. the refinement is real rather than a rename.
    for (const extra of ['store_unloaded', 'flat_window', 'not_evaluated'] as const) {
      expect(IV_RANK_COVERAGE_CODES).toContain(extra);
      expect(IV_PERCENTILE_COVERAGE_CODES as readonly string[]).not.toContain(extra);
    }
  });
});

// TRA-5171 — boot-load provenance: the three ways the store can read empty
// (file absent / corrupt / parsed-but-shallow) must never serialise identically.
describe('iv-store boot-load provenance (TRA-5171)', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iv-prov-'));
    path = join(dir, 'iv-history.json');
    setIvStoreFileForTests(path);
  });
  afterEach(() => {
    setIvStoreFileForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads loaded:false with bootLoad:null (never zeros) before the store loads', () => {
    const view = readIvStoreProvenanceSync();
    expect(view.loaded).toBe(false);
    expect(view.bootLoad).toBeNull();
    expect(view.storeFile).toBe(path);
  });

  it('file absent: storeFileExisted:false, parseError:null, zero samples', async () => {
    await initIvRankStore();
    const b = readIvStoreProvenanceSync().bootLoad!;
    expect(b.storeFileExisted).toBe(false);
    expect(b.parseError).toBeNull();
    expect(b.symbolsLoadedAtBoot).toBe(0);
    expect(b.samplesLoadedAtBoot).toBe(0);
  });

  it('NEGATIVE CONTROL: a TRUNCATED store file surfaces parseError — never the file-absent shape', async () => {
    const valid = JSON.stringify({
      version: 1,
      updatedAt: 1,
      symbols: { AAPL: [{ day: '2026-09-01', iv: 0.3 }] },
    });
    // A kill mid-write: syntactically broken JSON, exactly the TRA-5170 wipe mechanism.
    writeFileSync(path, valid.slice(0, Math.floor(valid.length / 2)), 'utf-8');
    await initIvRankStore();
    const b = readIvStoreProvenanceSync().bootLoad!;
    expect(b.storeFileExisted).toBe(true);
    expect(b.parseError).not.toBeNull();
    expect(b.samplesLoadedAtBoot).toBe(0);
    // The forbidden serialisation: corrupt must NOT read as { samples: 0, parseError: null }.
    expect(b.parseError === null && b.samplesLoadedAtBoot === 0).toBe(false);
  });

  it('a VALID 30-day store reads samplesLoadedAtBoot:30 with the depth histogram keyed at 30 — depth is a measurement, not an instrument ceiling', async () => {
    const nowMs = Date.now();
    const thirty = Array.from({ length: 30 }, (_, i) => ({
      day: new Date(nowMs - (30 - i) * DAY).toISOString().slice(0, 10),
      iv: 0.2 + i * 0.01,
    }));
    writeFileSync(path, JSON.stringify({ version: 1, updatedAt: nowMs, symbols: { AAPL: thirty } }), 'utf-8');
    await initIvRankStore();
    const b = readIvStoreProvenanceSync().bootLoad!;
    expect(b.storeFileExisted).toBe(true);
    expect(b.parseError).toBeNull();
    expect(b.symbolsLoadedAtBoot).toBe(1);
    expect(b.samplesLoadedAtBoot).toBe(30);
    expect(b.distinctDaysInStore).toBe(30);
    expect(b.depthHistogram).toEqual({ '30': 1 });
    expect(b.oldestSampleDay).toBe(thirty[0]!.day);
    expect(b.newestSampleDay).toBe(thirty[29]!.day);
  });

  it('counts successful persists since boot', async () => {
    await initIvRankStore();
    await recordDailyIv('AAA', 0.3);
    await recordDailyIv('AAA', 0.4, Date.now() + DAY);
    const view = readIvStoreProvenanceSync();
    expect(view.persistCount).toBe(2);
    expect(view.persistErrors).toBe(0);
    expect(view.lastPersistError).toBeNull();
  });
});

describe('atomic persist + fail-closed load (TRA-5172)', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iv-5172-'));
    path = join(dir, 'iv-history.json');
    setIvStoreFileForTests(path);
    fsFault.failWriteOnce = false;
    fsFault.failRenameOnce = false;
  });
  afterEach(() => {
    setIvStoreFileForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a kill during the tmp write leaves the PREVIOUS good file intact and parseable', async () => {
    await recordDailyIv('AAA', 0.3); // a good store on disk
    const before = readFileSync(path, 'utf-8');
    expect(() => JSON.parse(before)).not.toThrow(); // control: parseable going in
    fsFault.failWriteOnce = true;
    await expect(recordDailyIv('AAA', 0.9, Date.now() + DAY)).rejects.toThrow('simulated kill mid-write');
    expect(fsFault.failWriteOnce).toBe(false); // control: the plant actually fired
    // The destination is BYTE-IDENTICAL to the previous good file — the in-place
    // rewrite this ticket removes would have left it truncated here.
    expect(readFileSync(path, 'utf-8')).toBe(before);
    expect(readIvStoreProvenanceSync().persistErrors).toBe(1);
  });

  it('a kill between the tmp write and the swap also leaves the destination untouched, and the tmp is cleaned up', async () => {
    await recordDailyIv('AAA', 0.3);
    const before = readFileSync(path, 'utf-8');
    fsFault.failRenameOnce = true;
    await expect(recordDailyIv('AAA', 0.9, Date.now() + DAY)).rejects.toThrow('simulated rename failure');
    expect(readFileSync(path, 'utf-8')).toBe(before);
    expect(readdirSync(dir)).toEqual(['iv-history.json']); // no .tmp-* litter
  });

  it('THE WIPE, CLOSED: an unreadable store is never overwritten — refused persist, original bytes renamed aside', async () => {
    const garbage = '{"version":1,"updatedAt":9,"symbols":{"AAPL":[{"day"';
    writeFileSync(path, garbage, 'utf-8');
    // The TRA-5170 wipe mechanism: load fails, and the very next recordDailyIv
    // used to persist the empty map over the file.
    await recordDailyIv('AAA', 0.3);
    const view = readIvStoreProvenanceSync();
    expect(view.loadFailed).toBe(true);
    expect(view.persistRefusals).toBeGreaterThanOrEqual(1);
    expect(view.corruptFileRenamedTo).toMatch(/iv-history\.corrupt-[0-9TZ-]+\.json$/);
    // The ORIGINAL bytes are still on disk — renamed aside, not overwritten.
    expect(readFileSync(view.corruptFileRenamedTo!, 'utf-8')).toBe(garbage);
    // And nothing silently replaced the store path in the refused write.
    expect(existsSync(path)).toBe(false);
  });

  it('after the rename-aside a fresh store accumulates, and the refused sample is not lost', async () => {
    writeFileSync(path, 'not json at all', 'utf-8');
    await recordDailyIv('AAA', 0.3); // refused + renamed aside
    await recordDailyIv('AAA', 0.4, Date.now() + DAY); // fresh store writes
    const view = readIvStoreProvenanceSync();
    expect(view.persistRefusals).toBe(1);
    expect(view.persistCount).toBe(1);
    const fresh = JSON.parse(readFileSync(path, 'utf-8')) as { symbols: Record<string, unknown[]> };
    expect(fresh.symbols['AAA']).toHaveLength(2); // the refused day came along in the cache
  });

  it('while the rename-aside itself fails, EVERY persist keeps refusing and the original is never clobbered', async () => {
    const garbage = 'junk{{{';
    writeFileSync(path, garbage, 'utf-8');
    fsFault.failRenameOnce = true; // the first aside attempt fails (locked file, perms, ...)
    await recordDailyIv('AAA', 0.3);
    let view = readIvStoreProvenanceSync();
    expect(view.persistRefusals).toBe(1);
    expect(view.corruptFileRenamedTo).toBeNull();
    expect(readFileSync(path, 'utf-8')).toBe(garbage); // still fail-CLOSED, nothing clobbered
    // Next write attempt: still refused, but the retry of the rename succeeds.
    await recordDailyIv('AAA', 0.4, Date.now() + DAY);
    view = readIvStoreProvenanceSync();
    expect(view.persistRefusals).toBe(2);
    expect(readFileSync(view.corruptFileRenamedTo!, 'utf-8')).toBe(garbage);
  });
});
