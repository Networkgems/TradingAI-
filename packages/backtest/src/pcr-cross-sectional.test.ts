import { describe, expect, it } from 'vitest';
import {
  PCR_UPLIFT_BAR_R,
  joinForwardReturns,
  mean,
  placeboUpliftStat,
  rawUpliftStat,
  runPcrExpectancy,
} from './pcr-expectancy.js';
import {
  PCR_STUDY_TRIALS,
  POWER_CONSTRAINT,
  SELECTION_ONLY_CONSTRAINT,
  XS_HW30_FEASIBILITY_R,
  XS_MIN_FAIL_SESSIONS,
  XS_MIN_SESSIONS,
  XS_MIN_USED_SESSIONS_AT_30,
  blockBootstrapSeries,
  crossSectionalContrasts,
  crossSectionalPlaceboCaller,
  crossSectionalSeries,
  evaluateXsCell,
  pcrSideCaller,
  runPcrCrossSectional,
  sessionLevelPlaceboCaller,
  xsCondemnRuling,
  xsFeasibilityRuling,
} from './pcr-cross-sectional.js';
import { synth } from './pcr-synth.fixture.js';

// TRA-1727 — the SECONDARY estimand's own gate.
//
// Same discipline as TRA-1664/TRA-1726, and for the same reasons:
//   - a NEGATIVE control (must never promote noise),
//   - a POSITIVE control (must be ABLE to release — a gate wired shut certifies nothing),
//   - a HELD control and a FAIL control (three outcomes need three controls),
//   - and every one of them asserts the EXACT verdict, never `not.toBe('PASS')`.
//
// Two things in the pre-registration turned out to be wrong, and both are corrected
// here rather than coded around. Both corrections are driven ENTIRELY by the synthetic
// generator — no real ledger row has been read — which is the only moment at which
// fixing a control is legitimate rather than p-hacking.

const H5 = 5;

// ---------------------------------------------------------------------------
// THE MECHANISM — what actually makes this estimand artifact-immune.
// ---------------------------------------------------------------------------

describe('the mechanism', () => {
  it('THE DEMEANING IS AN ALGEBRAIC NO-OP — the immunity comes from the CONTRAST', () => {
    // The pre-registration says the demeaning "removes the market factor, which is
    // precisely the thing that manufactures the fake edge". The CONCLUSION is right.
    // The MECHANISM is not: the statistic is a difference of two group means taken
    // within ONE session, so the session mean c cancels out of it EXACTLY --
    //
    //     (mean(r|A) - c) - (mean(r|B) - c) == mean(r|A) - mean(r|B)
    //
    // Demeaning changes NOTHING. What buys the immunity is that both cohorts eat the
    // same market factor on the same day and it differences away. That is a STRONGER
    // guarantee than the one claimed, because it cannot be mis-specified — but it means
    // nobody should ever "fix" this estimand by adjusting how the demeaning is done.
    const { ledger, bars } = synth({ sessions: 40, seed: 42, edge: 'none' });
    const { rows } = joinForwardReturns(ledger, bars, H5);
    const caller = pcrSideCaller('raw', 'contrarian');

    const bySession = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!r.trioFired) continue;
      const l = bySession.get(r.session) ?? [];
      l.push(r);
      bySession.set(r.session, l);
    }

    const demeaned = crossSectionalContrasts(rows, caller).contrasts;
    expect(demeaned.length).toBeGreaterThan(20);

    for (const c of demeaned) {
      const list = bySession.get(c.session)!;
      const sides = caller(list);
      const A: number[] = [];
      const B: number[] = [];
      // The SAME partition, but WITHOUT subtracting the session mean.
      list.forEach((r, i) => (sides[i] !== null && sides[i] === r.side ? A : B).push(r.rMultiple));
      expect(mean(A) - mean(B)).toBeCloseTo(c.contrast, 12);
    }
  });

  it('THE CROSS-SECTION IS ARTIFACT-IMMUNE: +0.24R of fake edge becomes ~0', () => {
    // The claim the whole secondary rests on, measured head-to-head on the SAME
    // zero-edge worlds. The time-series statistic carries the TRA-1664 artifact —
    // several times the promotion bar. The within-session contrast does not.
    //
    // 200 worlds, because the per-world spread is itself of order the bar: on 30 worlds
    // this measurement swings by +/-0.05R of pure seed noise, which is enough to fake
    // either conclusion. (I read exactly that false signal off a 30-world sample while
    // building this and briefly believed the premise had failed. A harness-builder is
    // not exempt from the artifact the harness exists to catch.)
    const tsRaw: number[] = [];
    const xsRaw: number[] = [];

    for (let t = 0; t < 200; t++) {
      const { ledger, bars } = synth({ sessions: 30, seed: 500000 + t, edge: 'none' });
      const { rows } = joinForwardReturns(ledger, bars, H5);
      const r = rawUpliftStat('raw', 'contrarian')(rows);
      if (Number.isFinite(r)) tsRaw.push(r);
      const s = crossSectionalSeries(rows, 'raw', 'contrarian');
      if (s.raw.length) xsRaw.push(mean(s.raw));
    }

    // The primary's un-adjusted statistic: ~5x the +0.05R bar, on EXACTLY ZERO edge.
    expect(mean(tsRaw)).toBeGreaterThan(0.15);
    // The secondary's: an order of magnitude smaller, and inside the bar.
    expect(Math.abs(mean(xsRaw))).toBeLessThan(0.05);
    // ...and it is not a wash — the contrast removes the great majority of it.
    expect(Math.abs(mean(xsRaw))).toBeLessThan(Math.abs(mean(tsRaw)) / 4);
  });

  it('THE LOAD-BEARING PLACEBO CHECK — it comes out at ~0, as pre-registered', () => {
    // The pre-registration: "The placebo must still be run and reported. It should come
    // out at ~0 by construction here — if it does NOT, the demeaning is not doing what I
    // claim and the whole secondary is void. That check is load-bearing; do not skip it
    // because you expect it to pass."
    //
    // It passes. In the CROSS-SECTION a zero-information "buy the relative laggard"
    // earns ~0, where in the TIME SERIES the equivalent placebo earns +0.23R.
    const tsPlacebo: number[] = [];
    const xsPlacebo: number[] = [];

    for (let t = 0; t < 200; t++) {
      const { ledger, bars } = synth({ sessions: 30, seed: 500000 + t, edge: 'none' });
      const { rows } = joinForwardReturns(ledger, bars, H5);
      const p = placeboUpliftStat()(rows);
      if (Number.isFinite(p)) tsPlacebo.push(p);
      const s = crossSectionalSeries(rows, 'raw', 'contrarian');
      if (s.placebo.length) xsPlacebo.push(mean(s.placebo));
    }

    expect(mean(tsPlacebo)).toBeGreaterThan(0.15);        // the artifact, in the time series
    expect(Math.abs(mean(xsPlacebo))).toBeLessThan(0.05); // ...and gone from the cross-section
  });

  it('THE PRIMARY\'S PLACEBO IS DEGENERATE HERE — and NaN renders as CLEAN', () => {
    // THE TRAP THIS TEST EXISTS TO NAIL DOWN.
    //
    // The primary's placebo calls ONE side for the WHOLE session. In the cross-section
    // that is not a weak placebo, it is a VACUOUS one: a constant has no cross-sectional
    // variation, so it sorts every name into the SAME cohort, leaves the other EMPTY,
    // and the contrast is undefined on EVERY session. The statistic comes back NaN.
    //
    // And NaN is EXACTLY what a clean placebo looks like in a report that prints `n/a`
    // or coerces to zero. The pre-registration treats a ~0 placebo as the check that
    // VALIDATES the secondary — so reusing the primary's placebo would have produced a
    // check that SILENTLY CONFIRMED ITSELF while measuring nothing at all. A blind check
    // that renders as a clean one is worse than no check.
    const { ledger, bars } = synth({ sessions: 40, seed: 42, edge: 'none' });
    const { rows } = joinForwardReturns(ledger, bars, H5);

    const degenerate = crossSectionalContrasts(rows, sessionLevelPlaceboCaller());
    expect(degenerate.diagnostics.sessionsSeen).toBe(40);
    expect(degenerate.diagnostics.sessionsUsed).toBe(0);          // NOT ONE session survives
    expect(degenerate.diagnostics.droppedEmptyCohort).toBe(40);   // ...and we say WHY
    expect(Number.isNaN(mean(degenerate.contrasts.map((c) => c.contrast)))).toBe(true);

    // The placebo actually used is the cross-sectional one, and it is COMPUTABLE — which
    // is the whole difference between a check and a decoration.
    const real = crossSectionalContrasts(rows, crossSectionalPlaceboCaller());
    expect(real.diagnostics.sessionsUsed).toBe(40);
    expect(real.diagnostics.droppedEmptyCohort).toBe(0);
    expect(Number.isFinite(mean(real.contrasts.map((c) => c.contrast)))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE CONTROLS.
// ---------------------------------------------------------------------------

describe('NEGATIVE control — must never promote', () => {
  it('a zero-edge ledger never PASSes, at ANY N', () => {
    for (const sessions of [30, 45, 60, 90]) {
      const counts: Record<string, number> = { PASS: 0, FAIL: 0, HELD: 0 };
      for (let t = 0; t < 8; t++) {
        const { ledger, bars } = synth({ sessions, seed: 5 + t * 101, edge: 'none', gamma: 2.0 });
        counts[runPcrCrossSectional(ledger, bars, { iters: 400, seed: 11 }).verdict]++;
      }
      expect(counts.PASS).toBe(0);
    }
  }, 120000);

  it('the RAW contrast would clear the bar ~40% of the time — the CI leg is what saves us', () => {
    // The un-adjusted cross-sectional point estimate is UNBIASED but NOISY: on zero-edge
    // worlds it lands above +0.05R on roughly four draws in ten. Promoting on the point
    // estimate alone would therefore be a coin flip dressed as a finding.
    //
    // The full gate — bar AND session-clustered CI lower bound > 0 AND DSR AND PBO —
    // promotes ZERO of them. This is the leg that does the work in the cross-section, and
    // it is why "the placebo is ~0 here" does NOT mean "the inference is free".
    let rawClears = 0;
    let promoted = 0;
    let n = 0;
    for (let t = 0; t < 60; t++) {
      const { ledger, bars } = synth({ sessions: 30, seed: 700000 + t, edge: 'none' });
      const rep = runPcrCrossSectional(ledger, bars, { iters: 300, seed: 11 });
      if (!rep.primary || !Number.isFinite(rep.primary.clustered.lo)) continue;
      n++;
      if (rep.primary.rawContrastR >= PCR_UPLIFT_BAR_R) rawClears++;
      if (rep.verdict === 'PASS') promoted++;
    }
    expect(n).toBeGreaterThan(50);
    expect(rawClears / n).toBeGreaterThan(0.25); // the point estimate is a coin flip...
    expect(promoted).toBe(0);                    // ...and the gate refuses every one.
  }, 120000);
});

describe('THE SELECTION-ONLY CONSTRAINT, proven rather than asserted', () => {
  it('a strong genuine MARKET-TIMING edge — which the PRIMARY promotes — is NEVER promoted here', () => {
    // `synth({edge:'real'})` injects its edge through the MARKET FACTOR, which every
    // name loads on. It is therefore a pure TIMING edge: it moves the whole session
    // together and says nothing about WHICH NAME will do better than which.
    //
    // The primary sees it and releases. The secondary is BLIND to it — 0 PASS at every N
    // out to 90 — because a within-session contrast differences the session's own
    // direction away. That is the pre-registration's "it can never promote a
    // market-timing use", and it is now a MEASUREMENT rather than a promise in a docstring.
    for (const sessions of [30, 45, 60, 90]) {
      const counts: Record<string, number> = { PASS: 0, FAIL: 0, HELD: 0 };
      for (let t = 0; t < 8; t++) {
        const { ledger, bars } = synth({ sessions, seed: 5 + t * 101, edge: 'real', gamma: 2.0 });
        counts[runPcrCrossSectional(ledger, bars, { iters: 400, seed: 11 }).verdict]++;
      }
      expect(counts.PASS).toBe(0);
    }

    // ...and the PRIMARY, on the very same generator, DOES release. Without this half the
    // test above proves nothing: a gate wired shut also refuses every timing edge.
    const { ledger, bars } = synth({ sessions: 90, seed: 5, edge: 'real', gamma: 2.0 });
    expect(runPcrExpectancy(ledger, bars, { iters: 500, seed: 11 }).verdict).toBe('PASS');
  }, 180000);
});

describe('POSITIVE control — the gate can RELEASE, and sooner than the primary', () => {
  // THE PRE-REGISTERED POSITIVE CONTROL WAS MIS-SPECIFIED, AND ITS KILL-CONDITION WOULD
  // HAVE FIRED ON A WORKING ESTIMAND.
  //
  // The issue says: "POSITIVE: edge:'real' => must PASS ... If it does not release at
  // ~30-45 sessions, this secondary buys us nothing and you should say so plainly ...
  // close this issue with that finding and we drop the secondary."
  //
  // Run literally, that control FAILS — `edge:'real'` never PASSes the secondary at any
  // N (the test above pins it). But NOT because the secondary is useless: because
  // `edge:'real'` contains NO CROSS-SECTIONAL EDGE AT ALL. Its edge is injected through
  // the shared market factor, so there is nothing for a within-session contrast to find.
  // It is a positive control with the positive left out, and obeying its kill-condition
  // would have retired an estimand that works.
  //
  // A POSITIVE CONTROL MUST CONTAIN THE THING THE INSTRUMENT DETECTS. This is the exact
  // mirror of TRA-1664's lesson that "a gate wired shut passes every negative control":
  // there, a broken gate looked good because the known-bad was refused; here, a working
  // gate looks broken because the known-good has nothing in it. Both are the same
  // failure — the control does not DISCRIMINATE.
  //
  // So the generator gains `crossSectionalEdge`: a per-NAME edge where a name's own PCR
  // forecasts its OWN idiosyncratic forward move. That is the SELECTION edge this
  // estimand exists to detect, and the only thing a PASS here may ever promote.

  it('a genuine SELECTION edge RELEASES at N=45 — half the primary\'s 90', () => {
    const counts = (sessions: number, xsEdge: number) => {
      const c: Record<string, number> = { PASS: 0, FAIL: 0, HELD: 0 };
      for (let t = 0; t < 8; t++) {
        const { ledger, bars } = synth({
          sessions,
          seed: 5 + t * 101,
          edge: 'none',
          gamma: 2.0,
          crossSectionalEdge: xsEdge,
        });
        c[runPcrCrossSectional(ledger, bars, { iters: 400, seed: 11 }).verdict]++;
      }
      return c;
    };

    // A MODERATE selection edge. HELD at 30 (honest — not enough evidence yet), and
    // RELEASING at 45. That is the whole promise of the secondary: a promotable answer
    // at ~45 sessions instead of ~90, i.e. weeks earlier.
    const mod30 = counts(30, 1.5);
    expect(mod30.PASS).toBe(0);
    expect(mod30.HELD).toBe(8); // ABSTAINS — it does not condemn a real edge it cannot yet see

    const mod45 = counts(45, 1.5);
    expect(mod45.PASS).toBeGreaterThanOrEqual(7); // RELEASES
    expect(mod45.FAIL).toBe(0);

    const mod60 = counts(60, 1.5);
    expect(mod60.PASS).toBe(8);

    // A STRONG selection edge clears earlier still — at the 30-session floor itself.
    const strong30 = counts(30, 2.5);
    expect(strong30.PASS).toBeGreaterThanOrEqual(4);
    const strong45 = counts(45, 2.5);
    expect(strong45.PASS).toBe(8);
  }, 300000);

  it('a NOISY single-sample placebo does NOT void an otherwise-valid PASS', () => {
    // A per-sample placebo is noisy (SD ~0.2R at these sample sizes), so on any given
    // real read it will often land well beyond the 0.05R bar even when the estimand is
    // perfectly healthy — as it does on this very world, which PASSES.
    //
    // An earlier revision raised an ALARM in that situation and told the reader "the
    // pre-registration's premise does not hold here". It fired on the first real sample I
    // pointed it at. A CHECK FOR A CROSS-WORLD PROPERTY, EVALUATED ON ONE SAMPLE, IS NOT
    // A CONSERVATIVE CHECK — IT IS A WRONG ONE, and this one would have talked somebody
    // into discarding a valid result. The premise is verified across worlds, by the
    // control suite above; here the placebo is simply SUBTRACTED and reported.
    const { ledger, bars } = synth({
      sessions: 60, seed: 5, edge: 'none', gamma: 2.0, crossSectionalEdge: 2.5,
    });
    const rep = runPcrCrossSectional(ledger, bars, { iters: 400, seed: 11 });

    // This sample's placebo really is far beyond the bar...
    expect(Math.abs(rep.primary!.placeboContrastR)).toBeGreaterThan(PCR_UPLIFT_BAR_R);
    // ...and it is netted out of the binding statistic, so the verdict stands.
    expect(rep.verdict).toBe('PASS');
    expect(rep.primary!.adjustedContrastR).toBeCloseTo(
      rep.primary!.rawContrastR - rep.primary!.placeboContrastR,
      10,
    );
    // The note must INFORM, never condemn.
    const note = rep.primary!.notes.find((n) => /placebo on this sample/.test(n));
    expect(note).toBeDefined();
    expect(note).toMatch(/DO NOT void the secondary/);
    expect(note).not.toMatch(/does not hold/);
  }, 120000);

  it('a PASS carries the selection-only constraint in the report itself', () => {
    const { ledger, bars } = synth({
      sessions: 60, seed: 5, edge: 'none', gamma: 2.0, crossSectionalEdge: 2.5,
    });
    const rep = runPcrCrossSectional(ledger, bars, { iters: 400, seed: 11 });

    expect(rep.verdict).toBe('PASS');
    expect(rep.primary!.adjustedContrastR).toBeGreaterThan(PCR_UPLIFT_BAR_R);
    expect(rep.primary!.clustered.lo).toBeGreaterThan(0);
    expect(rep.guards!.dsr!.pass).toBe(true);
    expect(rep.guards!.pbo!.pass).toBe(true);

    // The number must never travel without the sentence. In November someone will read
    // "PASS" off a table and not this file.
    expect(rep.constraint).toBe(SELECTION_ONLY_CONSTRAINT);
    expect(rep.constraint).toMatch(/never promote a market-timing use/i);
    expect(rep.reasons.some((r) => /SELECTION USE ONLY/.test(r))).toBe(true);
  }, 120000);
});

describe('THE THIRD BRANCH — three outcomes, three controls (TRA-1726)', () => {
  it('FAIL control — an ANTI-SELECTIVE overlay is DECISIVELY refused, 8/8 from N=45 up', () => {
    // Proves the condemn branch CAN FIRE. Without it, HELD-vs-FAIL could have collapsed
    // and the secondary would abstain forever — a gate that can never condemn is exactly
    // as broken as one that condemns everything.
    //
    // The sign-mirror of a real selection edge: we read the CONFIRMING interpretation of
    // a ledger whose true selection edge is CONTRARIAN. The true contrast is ~-1.6R, the
    // whole interval sits far below the bar — positive evidence AGAINST — and it misses
    // the bar by many times the interval's own half-width, so TRA-1756's margin term is
    // satisfied comfortably. This is the KNOWN-BAD half of the two-sided control below.
    for (const sessions of [45, 60, 90]) {
      for (let t = 0; t < 8; t++) {
        const { ledger, bars } = synth({
          sessions, seed: 5 + t * 101, edge: 'none', gamma: 2.0, crossSectionalEdge: 2.5,
        });
        const rep = runPcrCrossSectional(ledger, bars, {
          iters: 400, seed: 11, primaryInterpretation: 'confirming',
        });
        expect(rep.verdict).toBe('FAIL');
        // ASSERT THE PREDICATE, NOT THE LABEL — and assert the SHARED one, never a
        // retyped copy. A grader written from recall is a different grader.
        expect(xsCondemnRuling(rep.primary!).decisive).toBe(true);
      }
    }
  }, 300000);

  it('TRA-1756 R1: at 30 sessions the floor WITHHOLDS the kill, and says so', () => {
    // The same anti-selective world at calendar N=30. The point estimate is just as damning,
    // but the sample is too thin for a DECISIVE, IRREVERSIBLE verdict — so the branch
    // withholds on 7 of 8 worlds and the report explains itself rather than going quiet.
    //
    // (1 of the 8 does condemn: `XS_MIN_FAIL_SESSIONS` counts USED sessions, and this world
    // is so strongly cross-sectional that ~93% of its sessions survive, so it clears 30 used
    // sessions at calendar 30. That is the floor behaving correctly, not leaking — it is
    // gating on how much evidence there actually IS, which is the whole point.)
    const counts: Record<string, number> = { PASS: 0, FAIL: 0, HELD: 0 };
    let withheldReasons = 0;
    for (let t = 0; t < 8; t++) {
      const { ledger, bars } = synth({
        sessions: 30, seed: 5 + t * 101, edge: 'none', gamma: 2.0, crossSectionalEdge: 2.5,
      });
      const rep = runPcrCrossSectional(ledger, bars, {
        iters: 400, seed: 11, primaryInterpretation: 'confirming',
      });
      counts[rep.verdict]++;
      if (rep.reasons.some((r) => /CONDEMNATION WITHHELD \(session floor\)/.test(r))) {
        withheldReasons++;
      }
    }
    expect(counts).toEqual({ PASS: 0, FAIL: 1, HELD: 7 });
    // A silent withholding is how this gate would rot: the next reader sees a sub-bar
    // interval sitting on a HELD, calls it a bug, and "fixes" it back into the coin flip.
    expect(withheldReasons).toBe(7);
  }, 300000);

  it('the label ALWAYS matches `xsCondemnRuling` — one predicate, no second copy', () => {
    for (const edge of ['none', 'real'] as const) {
      for (const xsEdge of [0, 0.04, 2.5]) {
        for (const sessions of [10, 30, 60]) {
          const { ledger, bars } = synth({
            sessions, seed: 77, edge, gamma: 2.0, crossSectionalEdge: xsEdge,
          });
          const rep = runPcrCrossSectional(ledger, bars, { iters: 300, seed: 11 });
          const decisive = rep.primary ? xsCondemnRuling(rep.primary).decisive : false;

          if (rep.verdict === 'FAIL') expect(decisive).toBe(true);
          else if (rep.verdict === 'HELD') expect(decisive).toBe(false);
        }
      }
    }
  }, 300000);

  it('IGNORANCE IS NOT CONDEMNATION — an inevaluable CI is HELD, never FAIL', () => {
    // 8 sessions: the block bootstrap cannot form two whole blocks, so the interval is
    // NaN. A NaN upper bound must NOT satisfy `hi < bar` and drop into FAIL — that would
    // condemn an overlay on the strength of having NO information about it.
    const { ledger, bars } = synth({
      sessions: 8, seed: 3, edge: 'none', gamma: 2.0, crossSectionalEdge: 2.5,
    });
    const rep = runPcrCrossSectional(ledger, bars, { iters: 300, seed: 11 });

    expect(Number.isFinite(rep.primary!.clustered.hi)).toBe(false);
    expect(rep.verdict).toBe('HELD');
    expect(rep.reasons.join(' ')).toMatch(/not evaluable/i);
  }, 60000);

  it('HOLDS below the 30-session floor even when the point estimate looks wonderful', () => {
    // 25 sessions of a STRONG selection edge. The uplift bar and the CI leg both clear.
    // The floor does not, and the floor is not negotiable — it is the pre-registered
    // minimum for the secondary and the whole reason a "fast" read is not a free one.
    const { ledger, bars } = synth({
      sessions: 25, seed: 3, edge: 'none', gamma: 2.0, crossSectionalEdge: 2.5,
    });
    const rep = runPcrCrossSectional(ledger, bars, { iters: 300, seed: 11 });

    expect(rep.verdict).toBe('HELD');
    expect(rep.primary!.legs.upliftBar).toBe(true);            // looks great...
    expect(rep.primary!.legs.clusteredCiPositive).toBe(true);  // ...and significant...
    expect(rep.primary!.legs.sessionFloor).toBe(false);        // ...and still not enough.
    expect(rep.reasons.join(' ')).toMatch(new RegExp(`${XS_MIN_SESSIONS}-session`));
  }, 60000);

  it('HOLDS on an empty ledger rather than vacuously passing', () => {
    const rep = runPcrCrossSectional([], [], { iters: 100, seed: 1 });
    expect(rep.verdict).toBe('HELD');
    expect(rep.shape.rows).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TRA-1756 R1 — THE CONDEMN BRANCH MUST DISCRIMINATE.
//
// A FAIL retires the overlay. Before TRA-1756 the rule was `hi < bar`, and on a realistic
// world that was a COIN FLIP WITH AN IRREVERSIBLE CONSEQUENCE: it fired on 9.5% of worlds
// carrying a REAL +0.087R selection edge (1.7x the promotion bar) and on 17% of worlds
// carrying none — a 7.5-point margin, which is noise.
//
// The controls below are TWO-SIDED, and that is the whole point. "Can the branch fire?" is
// only HALF a control: a branch that fires on everything passes it, and so does a branch
// that fires on nothing if you only ever check that it stayed quiet. The instrument must be
// shown to FIRE ON A KNOWN-BAD *and* STAY SILENT ON A KNOWN-GOOD. Blind and clean render
// identically, and this issue has already produced that same failure three times.
//
// The known-BAD is the anti-selective world (true contrast ~-1.6R — PCR anti-ranks the
// names). The known-GOOD is `crossSectionalEdge: 0.04`, which is a genuine +0.087R edge
// (measured on N=400 x 40 worlds: +0.0867R +/- 0.0131). It is 1.7x the +0.05R bar, so it is
// exactly the kind of edge the study exists to find — and condemning it is a FALSE KILL.
// ---------------------------------------------------------------------------

/** A real, promotable selection edge: +0.087R +/- 0.013, i.e. 1.7x the +0.05R bar. */
const REAL_EDGE_2X_BAR = 0.04;

const failCount = (
  sessions: number,
  xsEdge: number,
  interpretation: 'confirming' | 'contrarian',
  worlds: number,
): number => {
  let fails = 0;
  for (let t = 0; t < worlds; t++) {
    const { ledger, bars } = synth({
      sessions, seed: 300000 + t, edge: 'none', gamma: 2.0, crossSectionalEdge: xsEdge,
    });
    const rep = runPcrCrossSectional(ledger, bars, {
      iters: 400, seed: 11, primaryInterpretation: interpretation,
    });
    if (rep.verdict === 'FAIL') fails++;
  }
  return fails;
};

describe('TRA-1756 R1 — the condemn branch DISCRIMINATES', () => {
  it('FIRES on a known-BAD and is SILENT on a known-GOOD — at N=45 AND at N=60', () => {
    // The two-sided control. Both halves must hold at the same N, or the branch is either
    // decoration (never fires) or a coin flip (fires on anything).
    for (const sessions of [45, 60]) {
      // ...fires on a genuinely HARMFUL overlay: 8/8. The branch is not decoration.
      expect(failCount(sessions, 2.5, 'confirming', 8)).toBe(8);
      // ...and is SILENT on a world carrying a REAL, promotable +0.087R selection edge.
      // 0/25 here; 0.5% measured over 200 worlds. Under the OLD rule this was 9.5% at
      // N=45 and 6.5% at N=60 — i.e. a 1-in-11 chance of permanently retiring a signal
      // that worked.
      expect(failCount(sessions, REAL_EDGE_2X_BAR, 'contrarian', 25)).toBe(0);
      // ...and silent on a zero-edge world too. FAIL is *correct* there, but it is not
      // NEEDED — HELD already refuses to promote it, and abstaining costs nothing.
      expect(failCount(sessions, 0, 'contrarian', 25)).toBe(0);
    }
  }, 600000);

  it('THE SESSION FLOOR ALONE IS NOT THE FIX — it moves the coin flip to N=90', () => {
    // The measurement that changed the remedy, and the reason this test exists.
    //
    // The review's R1 asked for a session floor and nothing else. Graded on 200 worlds/cell,
    // a floor-only rule looks immaculate at N=45-60 and then the FALSE KILL CLIMBS BACK TO
    // 6.5% AT N=90 — the exact window the study is actually read at — because once used
    // sessions cross the floor, the old `hi < bar` coin flip simply resumes underneath it.
    //
    //   false kill on a real +0.087R edge   N=45   N=60   N=90   N=150
    //   `hi < bar` (the old rule)            9.5%   6.5%   7.0%   4.0%
    //   + session floor ONLY (R1 as asked)   1.0%   2.5%   6.5%   4.0%   <- DELAYS it
    //   + floor AND margin (what shipped)    0.0%   0.5%   0.5%   0.0%   <- CURES it
    //
    // A CORRECT DIAGNOSIS IS NOT A CORRECT REMEDY. This test re-derives the two superseded
    // rules ON THE SAME WORLDS and pins that they would still kill a real edge where the
    // shipped rule does not. Without it, "0 false kills" is unfalsifiable — it reads the
    // same whether the fix works or the branch is simply blind.
    const worlds = 25;
    const sessions = 90;
    let oldRuleKills = 0;
    let floorOnlyKills = 0;
    let shippedKills = 0;

    for (let t = 0; t < worlds; t++) {
      const { ledger, bars } = synth({
        sessions, seed: 300000 + t, edge: 'none', gamma: 2.0, crossSectionalEdge: REAL_EDGE_2X_BAR,
      });
      const rep = runPcrCrossSectional(ledger, bars, { iters: 400, seed: 11 });
      const p = rep.primary!;
      const hi = p.clustered.hi;

      // The two SUPERSEDED rules, re-derived here deliberately — they no longer exist in
      // the source, so a copy is the only way to grade them.
      if (Number.isFinite(hi) && hi < PCR_UPLIFT_BAR_R) oldRuleKills++;
      if (Number.isFinite(hi) && hi < PCR_UPLIFT_BAR_R && p.sessions >= XS_MIN_FAIL_SESSIONS) {
        floorOnlyKills++;
      }
      // The SHIPPED rule — the shared predicate, not a copy.
      if (xsCondemnRuling(p).decisive) shippedKills++;
    }

    // At N=90 the floor is already cleared, so it buys NOTHING: the floor-only rule kills
    // exactly as often as the old one. This is the finding.
    expect(floorOnlyKills).toBe(oldRuleKills);
    expect(oldRuleKills).toBeGreaterThanOrEqual(2); // it really does kill real edges here
    // The margin term is what does the work.
    expect(shippedKills).toBeLessThan(oldRuleKills);
    expect(shippedKills).toBeLessThanOrEqual(1);
  }, 600000);

  it('the floor counts USED sessions (~0.48 x calendar) — do NOT "fix" it to 60', () => {
    // The trap that would have silently deleted the branch. The review asked for "no FAIL
    // below N=60" meaning 60 CALENDAR sessions, but the code can only see sessions that
    // carry a DEFINED contrast — the rest are dropped as empty-cohort. On a realistic
    // (zero-to-small-edge) world that is about HALF of them.
    //
    // So `XS_MIN_FAIL_SESSIONS = 30` USED sessions IS calendar ~62. Writing the literal 60
    // would push the branch out to calendar ~125 — past anything this study will reach —
    // and a branch that never fires renders exactly like a branch that never needed to.
    // The claim is the RATIO, so the ratio is what gets asserted. (Over 200 worlds the
    // means are 21.6 / 29.2 / 43.3 used sessions at calendar 45 / 60 / 90; 12 worlds cannot
    // resolve those to a decimal place, and pinning them here would be the same
    // read-an-effect-off-too-few-worlds mistake this file exists to document.)
    for (const calendar of [45, 60, 90]) {
      const used: number[] = [];
      for (let t = 0; t < 12; t++) {
        const { ledger, bars } = synth({
          sessions: calendar, seed: 300000 + t, edge: 'none', gamma: 2.0,
        });
        used.push(runPcrCrossSectional(ledger, bars, { iters: 200, seed: 11 }).primary!.sessions);
      }
      const ratio = mean(used) / calendar;
      expect(ratio).toBeGreaterThan(0.4);
      expect(ratio).toBeLessThan(0.55); // ~HALF. Emphatically NOT 1:1.
    }
    // 30 used sessions is the floor, and it lands where the review wanted it: calendar ~62.
    expect(XS_MIN_FAIL_SESSIONS).toBe(30);
  }, 300000);

  it('the fix costs NO power — the positive control releases exactly as before', () => {
    // A gate can always be made safe by wiring it shut. Pin that this one was not: the
    // pre-TRA-1756 positive-control rows are reproduced to the world.
    const counts = (sessions: number, xsEdge: number) => {
      const c: Record<string, number> = { PASS: 0, FAIL: 0, HELD: 0 };
      for (let t = 0; t < 8; t++) {
        const { ledger, bars } = synth({
          sessions, seed: 5 + t * 101, edge: 'none', gamma: 2.0, crossSectionalEdge: xsEdge,
        });
        c[runPcrCrossSectional(ledger, bars, { iters: 400, seed: 11 }).verdict]++;
      }
      return c;
    };
    expect(counts(45, 1.5).PASS).toBe(7); // unchanged
    expect(counts(60, 1.5).PASS).toBe(8); // unchanged
    expect(counts(45, 2.5).PASS).toBe(8); // unchanged
  }, 300000);
});

// ---------------------------------------------------------------------------
// TRA-1756 R2 — the POWER caveat travels with the number.
// ---------------------------------------------------------------------------

describe('TRA-1756 R2 — a HELD is NOT evidence of absence', () => {
  it('stamps POWER_CONSTRAINT on every report, and into the reasons of every HELD', () => {
    // Same reasoning that made SELECTION_ONLY_CONSTRAINT necessary, and it binds harder:
    // that one guards the outcome we will probably never get (a PASS), this one guards the
    // outcome we almost certainly WILL get. In November somebody reads "HELD" off a table,
    // not this file, and "HELD" reads as "PCR does not rank names — drop it."
    const { ledger, bars } = synth({ sessions: 45, seed: 300000, edge: 'none', gamma: 2.0 });
    const held = runPcrCrossSectional(ledger, bars, { iters: 300, seed: 11 });

    expect(held.verdict).toBe('HELD');
    expect(held.power).toBe(POWER_CONSTRAINT);
    expect(held.power).toMatch(/HELD IS NOT EVIDENCE OF ABSENCE/i);
    expect(held.power).toMatch(/minimum detectable effect/i);
    // ...and it is in the REASONS, not merely in a field somebody has to know to look up.
    expect(held.reasons.some((r) => /HELD — READ THIS BEFORE ACTING ON IT/.test(r))).toBe(true);

    // It ships on a PASS too — the number never travels without it.
    const strong = synth({
      sessions: 60, seed: 5, edge: 'none', gamma: 2.0, crossSectionalEdge: 2.5,
    });
    const pass = runPcrCrossSectional(strong.ledger, strong.bars, { iters: 400, seed: 11 });
    expect(pass.verdict).toBe('PASS');
    expect(pass.power).toBe(POWER_CONSTRAINT);
  }, 120000);

  it('the caveat is TRUE: the CI half-width is 4-6x the bar it is asked to grade', () => {
    // POWER_CONSTRAINT is a claim about this estimator, so it is MEASURED, not asserted.
    // A caveat nobody checked is just a comment.
    //
    // This one number is the whole of R2 and R3: the promotion bar is +0.05R and the
    // instrument's resolution is 0.2-0.3R. The bar was chosen as a PROMOTION threshold and
    // nobody ever checked it was a DETECTABLE one.
    //
    // The constant claims a BAND (0.2-0.3R), so the band is what gets asserted — not a
    // decimal point estimate that 12 worlds cannot resolve. (Over 200 worlds: 0.309R at
    // calendar 45, 0.286R at 60, 0.246R at 90, 0.203R at 150 — it shrinks with N, but
    // nowhere near fast enough to reach the bar.)
    for (const sessions of [45, 90]) {
      const hws: number[] = [];
      for (let t = 0; t < 12; t++) {
        const { ledger, bars } = synth({ sessions, seed: 300000 + t, edge: 'none', gamma: 2.0 });
        const p = runPcrCrossSectional(ledger, bars, { iters: 400, seed: 11 }).primary!;
        if (Number.isFinite(p.clustered.hi)) hws.push((p.clustered.hi - p.clustered.lo) / 2);
      }
      expect(mean(hws)).toBeGreaterThan(0.2);
      expect(mean(hws)).toBeLessThan(0.35);
      expect(mean(hws)).toBeGreaterThan(4 * PCR_UPLIFT_BAR_R); // the bar is BELOW the noise floor
    }
  }, 300000);
});

// ---------------------------------------------------------------------------
// Mechanics that fail closed.
// ---------------------------------------------------------------------------

describe('fails closed', () => {
  it('DROPS AND COUNTS a session with fewer than the required names', () => {
    // The generator has 15 names. Demand 20 and EVERY session must drop — and say so.
    const { ledger, bars } = synth({
      sessions: 40, seed: 3, edge: 'none', gamma: 2.0, crossSectionalEdge: 2.5,
    });
    const rep = runPcrCrossSectional(ledger, bars, { iters: 300, seed: 11, minNames: 20 });

    expect(rep.primary!.sessions).toBe(0);
    expect(rep.primary!.diagnostics.droppedTooFewNames).toBe(40);
    expect(Number.isFinite(rep.primary!.clustered.hi)).toBe(false);
    expect(rep.verdict).toBe('HELD'); // no data is an ABSTENTION, never a refusal
  }, 60000);

  it('refuses a DEGENERATE bootstrap: fewer than two whole blocks => NaN, not zero width', () => {
    // Every circular draw would be a rotation of the whole series, the statistic would
    // never vary, and the interval would collapse to ZERO WIDTH — which, sitting above
    // zero, reads as `lo > 0`: a confident PASS backed by no variance at all.
    const series = [0.4, 0.5, 0.6, 0.55, 0.45, 0.5];
    const degenerate = blockBootstrapSeries(series, { iters: 200, seed: 1, blockLength: 10 });
    expect(Number.isNaN(degenerate.lo)).toBe(true);
    expect(degenerate.effective).toBe(0);

    const healthy = blockBootstrapSeries(series, { iters: 200, seed: 1, blockLength: 2 });
    expect(Number.isFinite(healthy.lo)).toBe(true);
    expect(healthy.hi).toBeGreaterThan(healthy.lo);
  });

  it('the bootstrap resamples SESSIONS, so a duplicated session is COUNTED TWICE', () => {
    // The trap this construction exists to avoid. Had the statistic been handed a flat
    // ROW array and re-grouped by session key, a session drawn twice would MERGE back
    // into one group — silently DE-DUPLICATING the resample, collapsing the
    // between-session variance and producing an interval that is TOO NARROW. A too-narrow
    // interval is a false PASS.
    //
    // Resampling the per-session CONTRAST SERIES directly makes that impossible: the
    // observation is a scalar, and a scalar drawn twice IS two observations. A series
    // with real spread must therefore produce an interval with real width.
    const spread = [-0.6, -0.3, 0, 0.3, 0.6, -0.45, 0.15, 0.5, -0.2, 0.25];
    const ci = blockBootstrapSeries(spread, { iters: 2000, seed: 4, blockLength: 2 });
    expect(ci.hi - ci.lo).toBeGreaterThan(0.15);
    expect(ci.point).toBeCloseTo(mean(spread), 12);
  });
});

describe('the multiplicity is PAID, not laundered', () => {
  it('BOTH reads deflate by the WHOLE study: 12 primary cells + 12 secondary = 24 trials', () => {
    // "Its multiplicity enters the DSR trial count for the whole study. Adding a second
    // look is not free and must not be laundered as one."
    //
    // If each read deflated by only its own 12, the study would take two independent
    // shots at the bar while each shot reported the multiplicity of a single one. So the
    // PRIMARY's penalty goes UP the moment this estimand exists — and it does: the
    // primary's thin-sample PASS counts fell (see the REAL_THIN matrix in
    // pcr-expectancy.test.ts, re-pinned for exactly this reason). It still releases at
    // its own N=90 window, which is the only window it was ever read at.
    expect(PCR_STUDY_TRIALS).toBe(24);

    const { ledger, bars } = synth({
      sessions: 60, seed: 5, edge: 'none', gamma: 2.0, crossSectionalEdge: 2.5,
    });
    expect(runPcrCrossSectional(ledger, bars, { iters: 300, seed: 11 }).guards!.trials).toBe(24);

    const real = synth({ sessions: 90, seed: 5, edge: 'real', gamma: 2.0 });
    expect(runPcrExpectancy(real.ledger, real.bars, { iters: 300, seed: 11 }).guards!.trials).toBe(24);
  }, 120000);

  it('publishes every cell — 2 carriers x 2 interpretations x 3 horizons', () => {
    // Hiding the losers is how a horizon-cherry-pick gets laundered into a promotion.
    const { ledger, bars } = synth({ sessions: 40, seed: 42, edge: 'none' });
    const rep = runPcrCrossSectional(ledger, bars, { iters: 200, seed: 11 });
    expect(rep.cells).toHaveLength(12);
    expect(new Set(rep.cells.map((c) => c.horizon))).toEqual(new Set([3, 5, 10]));
  }, 60000);
});

// ===========================================================================
// TRA-1800 — SPEC v3.1(C): the SECONDARY's N=30 FEASIBILITY KILL-GATE
// ===========================================================================
//
// The gate is a PURE FUNCTION of (half-width, used sessions, calendar sessions), so it is
// tested on CONSTRUCTED cells wherever the point is the RULE, and on the GENERATOR wherever
// the point is what the rule will actually DO on data.
//
// Both matter, and for different reasons. A gate proven only on the generator is a gate
// whose reachability you cannot see (the generator may simply never produce the input that
// fires a branch). A gate proven only on constructed cells is a gate you have never watched
// meet its subject. TRA-1726/TRA-1727 cost this study three separate non-discriminating
// controls; every branch below is pinned to an EXACT state, never to `not.toBe(...)`.

const xsCell = (hw: number, used: number) => ({
  clustered: { lo: 0.1 - hw, hi: 0.1 + hw, point: 0.1, effective: 1000 },
  sessions: used,
});

describe('TRA-1800 — the N=30 feasibility gate: ALL THREE STATES ARE REACHABLE', () => {
  // TRA-1726's rule, applied to this gate. A gate that can only ever emit RETIRE certifies
  // nothing — it is a foregone conclusion wearing a threshold. A gate that can only ever
  // emit FEASIBLE is not a gate at all. Pin all three, on exact states.

  it('FEASIBLE is REACHABLE — a tight interval on a broad cross-section passes', () => {
    const r = xsFeasibilityRuling(xsCell(0.05, 20), 30);
    expect(r.state).toBe('FEASIBLE');
    expect(r.leg).toBe('pass');
    // and it projects a terminal half-width that actually resolves the bar
    expect(r.projectedHw90).toBeLessThanOrEqual(PCR_UPLIFT_BAR_R);
  });

  it('RETIRE (resolution) is REACHABLE — a wide interval fails, and ONLY on that leg', () => {
    const r = xsFeasibilityRuling(xsCell(0.2, 20), 30);
    expect(r.state).toBe('RETIRE');
    expect(r.leg).toBe('resolution');
    expect(r.projectedHw90).toBeGreaterThan(PCR_UPLIFT_BAR_R);
  });

  it('RETIRE (breadth) is REACHABLE — and it fires even on a PERFECT half-width', () => {
    // *** THE LEG THE PRIMARY HAS NO ANALOGUE FOR. ***
    // A half-width of 0.001R is a flawless resolution read. It does not matter: with 8 used
    // sessions the terminal read projects to ~24, short of the 30 that BOTH verdict branches
    // require, so N=90 could return NOTHING BUT HELD however good the data were. A gate that
    // looked only at the half-width would wave this straight through into 60 more sessions
    // of accrual for a number that can never be read.
    const r = xsFeasibilityRuling(xsCell(0.001, 8), 30);
    expect(r.state).toBe('RETIRE');
    expect(r.leg).toBe('breadth');
    expect(r.hw).toBeLessThan(XS_HW30_FEASIBILITY_R); // the resolution leg would have PASSED it
  });

  it('GATE_NOT_REACHED below 30 CALENDAR sessions — and it is NOT a pass', () => {
    const r = xsFeasibilityRuling(xsCell(0.05, 20), 29);
    expect(r.state).toBe('GATE_NOT_REACHED');
    expect(r.leg).toBe(null);
    expect(r.reason).toContain('NOT A PASS');
  });

  it('the threshold BINDS exactly at 0.073R — the boundary is not a rounding accident', () => {
    expect(XS_HW30_FEASIBILITY_R).toBe(0.073);
    expect(xsFeasibilityRuling(xsCell(0.073, 20), 30).state).toBe('FEASIBLE');
    expect(xsFeasibilityRuling(xsCell(0.0731, 20), 30).state).toBe('RETIRE');
  });

  it('the breadth floor BINDS exactly at 12 USED sessions', () => {
    expect(XS_MIN_USED_SESSIONS_AT_30).toBe(12);
    expect(xsFeasibilityRuling(xsCell(0.05, 12), 30).state).toBe('FEASIBLE');
    expect(xsFeasibilityRuling(xsCell(0.05, 11), 30).state).toBe('RETIRE');
  });
});

describe('TRA-1800 — NON-EVALUABLE ⇒ RETIRE, and it INVERTS the condemn rule ON PURPOSE', () => {
  it('a NaN interval RETIREs the study — a broken ledger must not buy an extension', () => {
    const nan = { clustered: { lo: NaN, hi: NaN, point: NaN, effective: 0 }, sessions: 4 };
    const r = xsFeasibilityRuling(nan, 30);
    expect(r.state).toBe('RETIRE');
    expect(r.leg).toBe('non-evaluable');
  });

  it('THE SAME NaN CELL: the CONDEMN rule ABSTAINS while the FEASIBILITY rule RETIREs', () => {
    // *** THE DISCRIMINATING TEST OF THIS WHOLE ISSUE. ***
    //
    // These two rules look at the identical input and give OPPOSITE answers, and that is
    // correct, because they are asking different questions:
    //
    //   xsCondemnRuling   — "is the OVERLAY bad?"  A NaN cannot say so. IGNORANCE IS NOT
    //                       CONDEMNATION => abstain (HELD). Fail-closed AGAINST condemning.
    //   xsFeasibilityRuling — "can the STUDY answer?" A NaN has ALREADY demonstrated it
    //                       cannot => RETIRE. Fail-closed AGAINST accruing.
    //
    // Whoever next edits either rule will be tempted to "make them consistent". They are
    // consistent — both fail CLOSED — and closed points in opposite directions here. Making
    // them agree would turn one of them fail-OPEN, and the fail-open one would be the gate
    // that lets an unreadable study spend four more months. Pinned so that edit breaks a test.
    const nan = { clustered: { lo: NaN, hi: NaN, point: NaN, effective: 0 }, sessions: 4 };
    expect(xsCondemnRuling(nan).decisive).toBe(false); // abstains
    expect(xsFeasibilityRuling(nan, 30).state).toBe('RETIRE'); // retires
  });
});

describe('TRA-1800 — what the gate DOES on the generator (and it is a kill)', () => {
  // The honest, load-bearing prediction of Spec v3.1: WE EXPECT THIS GATE TO KILL THE STUDY
  // AT N=30. On our best prior the secondary's hw(30) is ~0.30R against a 0.073R threshold —
  // 4x above it. If this ever starts returning FEASIBLE on the synth, either the generator
  // or the threshold has moved and the ruling must be re-opened BEFORE the flip.

  it('at calendar N=30 the half-width is ~0.30R — 4x ABOVE the 0.073R gate, in EVERY world', () => {
    for (const [label, edge, xs] of [
      ['zero', 'none', 0],
      ['market-factor edge', 'real', 0],
      ['xs edge 1.5 (the positive control)', 'none', 1.5],
    ] as const) {
      const hws: number[] = [];
      for (let s = 1; s <= 6; s++) {
        const { ledger, bars } = synth({
          sessions: 30, seed: 1000 + s, edge, gamma: 1.2, crossSectionalEdge: xs,
        });
        const { rows } = joinForwardReturns(ledger, bars, 5);
        const cell = evaluateXsCell(rows, 5, 'raw', 'contrarian', { iters: 400, seed: 11 });
        hws.push((cell.clustered.hi - cell.clustered.lo) / 2);
        // and the GATE ITSELF says RETIRE — on every seed, in every world
        expect(xsFeasibilityRuling(cell, 30).state).toBe(`RETIRE`);
      }
      const m = mean(hws);
      expect(m, `${label}: hw(30)`).toBeGreaterThan(3 * XS_HW30_FEASIBILITY_R);
      expect(m, `${label}: hw(30)`).toBeLessThan(0.45);
    }
  }, 120000);

  it('the half-width is NOT state-dependent here — the primary\'s 3x inflation does NOT transfer', () => {
    // TRA-1741 corrected the PRIMARY's power arithmetic because its half-width inflates
    // 2.5-3x in the world where a promotion decision gets made (the edge enters through the
    // MARKET FACTOR, so edge and noise scale together). The obvious move is to inherit that
    // inflation factor here by analogy. IT WOULD BE WRONG: this estimand differences the
    // market factor out exactly, so a per-NAME edge does not widen the contrast's variance.
    //
    // Measured: FLAT (if anything slightly narrower under a real cross-sectional edge). So
    // for the SECONDARY — and only the secondary — the null-world half-width is a sound
    // estimate of the act-world one. This is why the threshold needed no inflation term.
    const hwOf = (xs: number) => {
      const hws: number[] = [];
      for (let s = 1; s <= 6; s++) {
        const { ledger, bars } = synth({
          sessions: 90, seed: 1000 + s, edge: 'none', gamma: 1.2, crossSectionalEdge: xs,
        });
        const { rows } = joinForwardReturns(ledger, bars, 5);
        const cell = evaluateXsCell(rows, 5, 'raw', 'contrarian', { iters: 400, seed: 11 });
        hws.push((cell.clustered.hi - cell.clustered.lo) / 2);
      }
      return mean(hws);
    };
    const nullWorld = hwOf(0);      // no cross-sectional edge
    const actWorld = hwOf(1.5);     // a 32x-bar cross-sectional edge — where we would ACT

    // The primary inflates by 2.5-3.2x across this same comparison. This estimand does not
    // inflate AT ALL: pin the ratio inside a tight band around 1.
    const ratio = actWorld / nullWorld;
    expect(ratio, `act/null half-width ratio`).toBeGreaterThan(0.75);
    expect(ratio, `act/null half-width ratio`).toBeLessThan(1.25);
  }, 120000);
});
