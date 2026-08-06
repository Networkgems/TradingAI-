// TRA-2927 — regression cover for the option-mark jump observer.
//
// The load-bearing assertions are NOT "a clean tape reads 0". They are:
//   1. DARK and CLEAN are DISTINGUISHABLE (a `flagged: 0` that reads the same when
//      the observer never ran is the exact instrument defect this was built to
//      avoid inheriting);
//   2. an undefined ratio is NOT laundered into the clean bucket;
//   3. the observer sits on the SHARED mark-map seam, not on the imports-only
//      consumer — the live sleeve's rows are engine-opened, so an imports-only
//      observer would read clean against the very book that produced the phantom
//      peak.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  classifyMarkJump,
  recordMarkObservation,
  summarizeMarkSanity,
  clearMarkSanityTape,
  markSanityNote,
  OBSERVE_JUMP_X,
  MAX_SAMPLES,
  // TRA-2945 — the durable, per-book, distribution-keeping half.
  hydrateMarkSanityFromDisk,
  markSanityLogPath,
  jumpBucketIndex,
  JUMP_BUCKET_COUNT,
  BOUND_SESSIONS_REQUIRED,
} from './option-mark-sanity.js';

const obs = (over: Partial<Parameters<typeof recordMarkObservation>[0]> = {}) =>
  recordMarkObservation({
    optionSymbol: 'SPY260807C00650000',
    symbol: 'SPY',
    mode: 'live',
    mark: 0.4,
    priorMark: 0.3,
    entryPremium: 0.3,
    contracts: 1,
    now: 1_000,
    ...over,
  });

describe('TRA-2927 classifyMarkJump', () => {
  it('flags a jump above the capture threshold and reports the ratio', () => {
    expect(classifyMarkJump({ mark: 30, priorMark: 0.3 })).toEqual({ flagged: true, jumpX: 100 });
  });

  it('does not flag an ordinary move', () => {
    const d = classifyMarkJump({ mark: 0.45, priorMark: 0.3 });
    expect(d.flagged).toBe(false);
    expect(d.jumpX).toBeCloseTo(1.5, 10);
  });

  it('is a strict >, so exactly the threshold is not flagged', () => {
    expect(classifyMarkJump({ mark: 0.3 * OBSERVE_JUMP_X, priorMark: 0.3 }).flagged).toBe(false);
  });

  // The ratio is UNDEFINED, not 1 and not 0 — a numeric ratio here would read as
  // "no jump" and quietly launder an unmeasurable mark into the clean bucket.
  it.each([
    ['zero prior mark', 0],
    ['negative prior mark', -1],
    ['non-finite prior mark', Number.NaN],
  ])('returns jumpX null for a %s', (_label, priorMark) => {
    expect(classifyMarkJump({ mark: 5, priorMark: priorMark as number })).toEqual({
      flagged: false,
      jumpX: null,
    });
  });

  it('returns jumpX null for a non-finite mark', () => {
    expect(classifyMarkJump({ mark: Number.POSITIVE_INFINITY, priorMark: 0.3 }).jumpX).toBeNull();
  });
});

describe('TRA-2927 mark sanity tape', () => {
  beforeEach(() => clearMarkSanityTape());

  it('DARK and CLEAN are distinguishable — flagged:0 alone does not mean clean', () => {
    const dark = summarizeMarkSanity();
    expect(dark.observed).toBe(0);
    expect(dark.flagged).toBe(0);
    expect(dark.note).toMatch(/^DARK/);
    expect(dark.maxJumpX).toBeNull();

    obs({ mark: 0.35 });
    const clean = summarizeMarkSanity();
    expect(clean.observed).toBe(1);
    expect(clean.flagged).toBe(0);
    expect(clean.note).toMatch(/^CLEAN/);

    // The whole point: the two states do not read alike.
    expect(clean.note).not.toBe(dark.note);
  });

  it('attributes a 100x mark to its leg and to the dollars it pushed into the peak', () => {
    obs({ mark: 0.31 }); // an ordinary tick first, so `observed` is a real denominator
    obs({
      optionSymbol: 'SPY260803C00500000',
      symbol: 'SPY',
      mode: 'live',
      mark: 30,
      priorMark: 0.3,
      entryPremium: 0.3,
      contracts: 4,
      now: 2_000,
    });

    const s = summarizeMarkSanity();
    expect(s.observed).toBe(2);
    expect(s.flagged).toBe(1);
    expect(s.maxJumpX).toBe(100);
    expect(s.note).toMatch(/^FLAGGED/);

    const [sample] = s.samples;
    expect(sample.optionSymbol).toBe('SPY260803C00500000');
    expect(sample.mode).toBe('live');
    expect(sample.jumpX).toBe(100);
    expect(sample.contracts).toBe(4);
    // (30 − 0.3) × 4 × 100 — the exact term `unrealizedPnlForMode` adds, so it is
    // directly comparable to the give-back `peakPnl` it lands in.
    expect(sample.mtmDeltaUsd).toBeCloseTo(11_880, 6);
    expect(s.maxMtmDeltaUsd).toBeCloseTo(11_880, 6);
  });

  it('counts an undefined ratio in its own bucket and in observed, never as clean', () => {
    obs({ mark: 5, priorMark: 0 });
    const s = summarizeMarkSanity();
    expect(s.observed).toBe(1);
    expect(s.undefinedRatio).toBe(1);
    expect(s.flagged).toBe(0);
    expect(s.samples).toHaveLength(0);
    // It is NOT silently folded into the clean claim — the note says so out loud.
    expect(s.note).toMatch(/NO defined ratio/);
  });

  it('the CLEAN note names the undefined-ratio count so a clean read is qualified', () => {
    obs({ mark: 0.35 });
    obs({ mark: 5, priorMark: 0 });
    expect(markSanityNote()).toMatch(/1 had NO defined ratio/);
  });

  it('bounds retained samples but never lets the flagged COUNT read low', () => {
    for (let i = 0; i < MAX_SAMPLES + 10; i += 1) {
      obs({ mark: 30, priorMark: 0.3, now: 1_000 + i });
    }
    const s = summarizeMarkSanity();
    expect(s.samples).toHaveLength(MAX_SAMPLES);
    expect(s.flagged).toBe(MAX_SAMPLES + 10); // the count is NOT capped by the ring
    expect(s.observed).toBe(MAX_SAMPLES + 10);
    // Oldest dropped first — the surviving window is the most recent one.
    expect(s.samples[s.samples.length - 1].ts).toBe(1_000 + MAX_SAMPLES + 9);
  });

  it('summarize returns a COPY — a caller cannot mutate the tape through it', () => {
    obs({ mark: 30, priorMark: 0.3 });
    summarizeMarkSanity().samples.pop();
    expect(summarizeMarkSanity().samples).toHaveLength(1);
  });
});

describe('TRA-2927 the observer is on the SHARED mark seam, not the imports-only one', () => {
  // A source-level guard, deliberately. The scope error this prevents is invisible
  // to any behavioural test of the module itself: wiring the observer into
  // `refreshImportedMarks` would satisfy every assertion above while reading a
  // clean 0 in production, because the live OTM sleeve's rows are ENGINE-OPENED and
  // never pass through the imports path. The seam is the contract.
  const src = readFileSync(join(__dirname, 'signal-engine.ts'), 'utf8');

  const bodyOf = (methodSignature: string): string => {
    const start = src.indexOf(methodSignature);
    expect(start, `${methodSignature} not found — re-grep the symbol, do not trust this line`).toBeGreaterThan(-1);
    const next = src.indexOf('\n  private ', start + methodSignature.length);
    const end = next === -1 ? src.length : next;
    return src.slice(start, end);
  };

  it('calls the observer inside refreshOptionMarks (covers checkExits AND imports)', () => {
    expect(bodyOf('private async refreshOptionMarks(')).toContain('recordMarkObservation(');
  });

  it('does NOT call it inside refreshImportedMarksAllAccounts (that would halve the book)', () => {
    const body = bodyOf('private refreshImportedMarksAllAccounts(');
    // A `not.toContain` on an EMPTY string passes for free. Pin the body to a marker
    // only that method has, so this assertion cannot go vacuous if the extractor
    // silently stops matching (a renamed method, a reformat, a moved brace).
    expect(body).toContain('acct.refreshImportedMarks(marks)');
    expect(body).not.toContain('recordMarkObservation(');
  });

  it('the extractor really isolates one method — the two bodies are not the same slice', () => {
    // Guards the same way round: if `bodyOf` returned the whole file for both, the
    // positive and negative assertions above would contradict each other silently.
    expect(bodyOf('private async refreshOptionMarks(')).not.toContain(
      'acct.refreshImportedMarks(marks)',
    );
  });

  it('is called exactly once in the engine — two call sites would double-count', () => {
    expect(src.split('recordMarkObservation(').length - 1).toBe(1);
  });
});

// ── TRA-2945 ────────────────────────────────────────────────────────────────
//
// TRA-2927 shipped an observer that reads CLEAN and cannot support the bound
// TRA-2945 §3 asks for. All three defects are invisible in the read, so the
// load-bearing assertions below are the ones that FAIL against the v1 tape:
//
//   1. the fold survives a reboot and RESUMES from the disk total (v1 restarted
//      from zero on every restart, and bqb1 restarts several times a day, so 5
//      sessions could never accumulate no matter how long you waited);
//   2. a demo-only tape is DISTINGUISHABLE from one that covered both books (v1's
//      aggregate was mode-blind, and `samples` is empty when nothing flags, so a
//      clean read carried ZERO evidence about which book it actually saw);
//   3. the ratio DISTRIBUTION is retained, not just a running max (v1 discarded
//      everything between 1.0x and 2.0x, and you cannot read a percentile off a
//      max — so "bias the bound LOOSE" had nothing to be loose relative to).

describe('TRA-2945 the durable per-book tape', () => {
  let dir: string;

  beforeEach(() => {
    clearMarkSanityTape();
    dir = mkdtempSync(join(tmpdir(), 'mark-sanity-'));
  });
  afterEach(() => {
    clearMarkSanityTape();
    rmSync(dir, { recursive: true, force: true });
  });

  const DAY = 24 * 60 * 60 * 1000;
  const DAY_A = Date.UTC(2026, 7, 4, 18, 0, 0); // 2026-08-04 ET
  const DAY_B = Date.UTC(2026, 7, 5, 18, 0, 0); // 2026-08-05 ET

  // THE defect this ticket exists to remove.
  it('survives a reboot and RESUMES from the disk total instead of restarting at zero', () => {
    hydrateMarkSanityFromDisk(dir, DAY_A);
    for (let i = 0; i < 40; i += 1) obs({ mode: 'live', now: DAY_A });
    expect(summarizeMarkSanity().byMode.live.observed).toBe(40);

    // The reboot: every module global is wiped, exactly as a restart does.
    clearMarkSanityTape();
    expect(summarizeMarkSanity().byMode.live.observed).toBe(0);

    const h = hydrateMarkSanityFromDisk(dir, DAY_A);
    expect(h.observed).toBe(40);
    expect(h.bookDays).toBe(1);
    expect(summarizeMarkSanity().byMode.live.observed).toBe(40);

    // And this boot ADDS to the recovered total rather than opening a fresh row
    // that would overwrite it — the difference between accumulating and resetting.
    for (let i = 0; i < 30; i += 1) obs({ mode: 'live', now: DAY_A });
    expect(summarizeMarkSanity().byMode.live.observed).toBe(70);

    clearMarkSanityTape();
    expect(hydrateMarkSanityFromDisk(dir, DAY_A).observed).toBe(70);
  });

  // The since-boot counters are UNCHANGED by all of this — they answer a different
  // question ("is the observer running right now") and callers already read them.
  it('leaves the since-boot counters alone — they are not the durable ones', () => {
    hydrateMarkSanityFromDisk(dir, DAY_A);
    for (let i = 0; i < 10; i += 1) obs({ mode: 'live', now: DAY_A });
    expect(summarizeMarkSanity().observed).toBe(10);

    clearMarkSanityTape();
    hydrateMarkSanityFromDisk(dir, DAY_A);
    const s = summarizeMarkSanity();
    expect(s.byMode.live.observed).toBe(10); // durable total recovered
    expect(s.observed).toBe(0); // since-boot correctly still zero
    expect(s.note).toMatch(/^DARK/);
  });

  it('a demo-only tape does NOT claim to cover the live book', () => {
    hydrateMarkSanityFromDisk(dir, DAY_A);
    for (let i = 0; i < 20; i += 1) obs({ mode: 'demo', now: DAY_A });
    const s = summarizeMarkSanity();
    expect(s.byMode.demo.observed).toBe(20);
    expect(s.byMode.live.observed).toBe(0);
    expect(s.note).toContain('LIVE DARK');
    expect(s.boundReadiness.ready).toBe(false);
  });

  // Positive control for the assertion above: the caveat must actually MOVE when
  // the live book appears, or "LIVE DARK" could be absent for any unrelated reason.
  it('the per-book caveat is a discriminator — it changes when live marks arrive', () => {
    hydrateMarkSanityFromDisk(dir, DAY_A);
    obs({ mode: 'demo', now: DAY_A });
    const demoOnly = summarizeMarkSanity().note;
    obs({ mode: 'live', now: DAY_A });
    const bothBooks = summarizeMarkSanity().note;

    expect(demoOnly).toContain('LIVE DARK');
    expect(bothBooks).not.toContain('LIVE DARK');
    expect(bothBooks).toContain('Per book (durable)');
    expect(bothBooks).not.toBe(demoOnly);
  });

  it('retains the DISTRIBUTION, not just the max', () => {
    hydrateMarkSanityFromDisk(dir, DAY_A);
    // 1.0x (flat), 1.5x and 100x — three different buckets from the same book.
    obs({ mode: 'live', mark: 0.3, priorMark: 0.3, now: DAY_A });
    obs({ mode: 'live', mark: 0.45, priorMark: 0.3, now: DAY_A });
    obs({ mode: 'live', mark: 30, priorMark: 0.3, now: DAY_A });

    const h = summarizeMarkSanity().byMode.live.histogram;
    expect(h).toHaveLength(JUMP_BUCKET_COUNT);
    expect(h[jumpBucketIndex(1)]).toBe(1);
    expect(h[jumpBucketIndex(1.5)]).toBe(1);
    expect(h[jumpBucketIndex(100)]).toBe(1);
    // Every DEFINED ratio lands in exactly one bucket, so the histogram total is a
    // denominator a percentile can be computed against. A max alone is not.
    expect(h.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('an undefined ratio is counted but never lands in a histogram bucket', () => {
    hydrateMarkSanityFromDisk(dir, DAY_A);
    obs({ mode: 'live', mark: 5, priorMark: 0, now: DAY_A });
    const t = summarizeMarkSanity().byMode.live;
    expect(t.observed).toBe(1); // still in the denominator
    expect(t.undefinedRatio).toBe(1);
    expect(t.histogram.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('counts SESSIONS per book, and a bound needs BOTH books at the bar', () => {
    hydrateMarkSanityFromDisk(dir, DAY_A);
    for (let d = 0; d < BOUND_SESSIONS_REQUIRED; d += 1) {
      const now = DAY_A + d * DAY;
      obs({ mode: 'demo', now });
      if (d > 0) obs({ mode: 'live', now }); // live is one session short
    }
    const r = summarizeMarkSanity().boundReadiness;
    expect(r.demoSessions).toBe(BOUND_SESSIONS_REQUIRED);
    expect(r.liveSessions).toBe(BOUND_SESSIONS_REQUIRED - 1);
    expect(r.ready).toBe(false);
    expect(r.note).toMatch(/NOT READY/);

    obs({ mode: 'live', now: DAY_A }); // closes the gap
    const r2 = summarizeMarkSanity().boundReadiness;
    expect(r2.liveSessions).toBe(BOUND_SESSIONS_REQUIRED);
    expect(r2.ready).toBe(true);
    expect(r2.note).toMatch(/^READY/);
  });

  it('splits the fold per ET day, so sessions are not one running blob', () => {
    hydrateMarkSanityFromDisk(dir, DAY_A);
    obs({ mode: 'live', now: DAY_A });
    obs({ mode: 'live', now: DAY_B });
    const days = summarizeMarkSanity().days.filter((d) => d.mode === 'live');
    expect(days.map((d) => d.etDay)).toEqual(['2026-08-05', '2026-08-04']);
    expect(days.every((d) => d.observed === 1)).toBe(true);
  });

  it('skips a torn trailing line — a bad tape recovers less, it does not crash', () => {
    hydrateMarkSanityFromDisk(dir, DAY_A);
    obs({ mode: 'live', now: DAY_A });
    clearMarkSanityTape();
    appendFileSync(markSanityLogPath(dir), '{"etDay":"2026-08-04","mode":"liv', 'utf8');
    expect(() => hydrateMarkSanityFromDisk(dir, DAY_A)).not.toThrow();
    expect(summarizeMarkSanity().byMode.live.observed).toBe(1);
  });

  it('drops rows past retention so the tape cannot grow without bound', () => {
    hydrateMarkSanityFromDisk(dir, DAY_A);
    obs({ mode: 'live', now: DAY_A });
    clearMarkSanityTape();
    // Hydrate 60 days on: the 08-04 row is outside the 30-day window.
    const h = hydrateMarkSanityFromDisk(dir, DAY_A + 60 * DAY);
    expect(h.bookDays).toBe(0);
    expect(summarizeMarkSanity().byMode.live.observed).toBe(0);
  });

  // `ephemeral` is a property of the PATH, so it is answerable even when the fold
  // is empty — `hydratedBookDays: 0` cannot tell a fresh persistent disk from a
  // wiped ephemeral one, which is the ambiguity this field exists to remove.
  it('reports durability, and a tape with no configured dir is ephemeral by definition', () => {
    expect(summarizeMarkSanity().durability).toMatchObject({ dataDir: null, ephemeral: true });
    hydrateMarkSanityFromDisk(dir, DAY_A);
    expect(summarizeMarkSanity().durability.dataDir).toBe(dir);
  });
});
