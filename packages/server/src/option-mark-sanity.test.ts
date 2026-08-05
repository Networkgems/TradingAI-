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

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  classifyMarkJump,
  recordMarkObservation,
  summarizeMarkSanity,
  clearMarkSanityTape,
  markSanityNote,
  OBSERVE_JUMP_X,
  MAX_SAMPLES,
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
