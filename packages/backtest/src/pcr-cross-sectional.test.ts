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
  SELECTION_ONLY_CONSTRAINT,
  XS_MIN_SESSIONS,
  blockBootstrapSeries,
  crossSectionalContrasts,
  crossSectionalPlaceboCaller,
  crossSectionalSeries,
  pcrSideCaller,
  runPcrCrossSectional,
  sessionLevelPlaceboCaller,
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
  it('FAIL control — an ANTI-SELECTIVE overlay is DECISIVELY refused at only 30 sessions', () => {
    // Proves the condemn branch CAN FIRE. Without it, HELD-vs-FAIL could have collapsed
    // and the secondary would abstain forever — a gate that can never condemn is exactly
    // as broken as one that condemns everything.
    //
    // The sign-mirror of a real selection edge: we read the CONFIRMING interpretation of
    // a ledger whose true selection edge is CONTRARIAN. The whole interval sits below the
    // bar — positive evidence AGAINST — and it is decisive at 30 sessions.
    for (const sessions of [30, 45, 60]) {
      for (let t = 0; t < 8; t++) {
        const { ledger, bars } = synth({
          sessions, seed: 5 + t * 101, edge: 'none', gamma: 2.0, crossSectionalEdge: 2.5,
        });
        const rep = runPcrCrossSectional(ledger, bars, {
          iters: 400, seed: 11, primaryInterpretation: 'confirming',
        });
        expect(rep.verdict).toBe('FAIL');
        // ASSERT THE PREDICATE, NOT THE LABEL.
        expect(rep.primary!.clustered.hi).toBeLessThan(PCR_UPLIFT_BAR_R);
      }
    }
  }, 300000);

  it('the rule is EXACTLY "CI upper bound < bar" — the label always matches the predicate', () => {
    for (const edge of ['none', 'real'] as const) {
      for (const xsEdge of [0, 2.5]) {
        for (const sessions of [10, 30, 60]) {
          const { ledger, bars } = synth({
            sessions, seed: 77, edge, gamma: 2.0, crossSectionalEdge: xsEdge,
          });
          const rep = runPcrCrossSectional(ledger, bars, { iters: 300, seed: 11 });
          const hi = rep.primary?.clustered.hi ?? NaN;
          const decisive = Number.isFinite(hi) && hi < PCR_UPLIFT_BAR_R;

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
