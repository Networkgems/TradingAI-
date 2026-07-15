import { describe, expect, it } from 'vitest';
import {
  adjustedUpliftStat,
  atrBySession,
  ciHalfWidth,
  clearsEffectiveBar,
  cohortize,
  DETECTABILITY_FLOOR_CONSTRAINT,
  effectiveBar,
  effectiveBarReason,
  evaluateCell,
  joinForwardReturns,
  mean,
  naiveRowBootstrap,
  PCR_UPLIFT_BAR_R,
  pcrSideFor,
  placeboUpliftStat,
  PRIMARY_FEASIBILITY_GATE_N,
  PRIMARY_HW30_FEASIBILITY_R,
  PRIMARY_POWER_CONSTRAINT,
  rawUpliftStat,
  runPcrExpectancy,
  sessionClusteredBootstrap,
  type DailyBar,
  type JoinedRow,
  type PcrShadowRow,
} from './pcr-expectancy.js';
// The synthetic market moved to a shared fixture (TRA-1727) so the SECONDARY estimand
// is controlled against the SAME generator as the primary rather than a copy of it.
// The pinned seed-by-seed counts below are what prove the extraction was faithful: any
// drift in the RNG consumption order would move them.
import {
  BETA,
  idioLoading,
  NAMES,
  session,
  synth,
  SYNTH_FACTOR_SCALE,
} from './pcr-synth.fixture.js';
// TRA-1829 — the secondary's constants, imported only to PIN that the primary's re-ruled
// feasibility threshold equals them (one number pre-registered for both estimands).
import {
  XS_FEASIBILITY_GATE_N,
  XS_HW30_FEASIBILITY_R,
} from './pcr-cross-sectional.js';

// TRA-1664 — the harness's own gate.
//
// The load-bearing test is the ZERO-EDGE control: a synthetic ledger with no
// predictive content at all, built with the SAME cross-name correlation the real
// watchlist has. The harness must REFUSE it. If it clears, the harness would have
// promoted noise — which is how Supertrend got as far as it did (TRA-1334, washed
// out at E[R] -0.047R over 2098 signals).
//
// A refusal-only proof is worthless on its own: a harness hard-wired to say NO-GO
// passes the zero-edge test perfectly. So the POSITIVE control is equally
// load-bearing — a ledger with a REAL injected edge must CLEAR. Only the two
// together show the instrument DISCRIMINATES rather than merely declines.

// ---------------------------------------------------------------------------
// Mechanics
// ---------------------------------------------------------------------------

describe('atrBySession', () => {
  it('is null until a full period of true ranges exists, and never looks ahead', () => {
    const bars: DailyBar[] = Array.from({ length: 20 }, (_, i) => ({
      underlying: 'X',
      session: session(i),
      close: 100 + i,
      high: 101 + i,
      low: 99 + i,
    }));
    const atr = atrBySession(bars, 14);
    expect(atr.get(session(12))).toBeNull();
    expect(atr.get(session(13))).toBeGreaterThan(0);

    // A violent bar AFTER session 13 must not change the ATR AT session 13. If it
    // did, the normalizer would leak the answer into itself.
    const withSpike = bars.map((b, i) =>
      i === 17 ? { ...b, high: b.high + 500, low: b.low - 500 } : b,
    );
    expect(atrBySession(withSpike, 14).get(session(13))).toBe(atr.get(session(13)));
  });
});

describe('joinForwardReturns', () => {
  it('counts every dropped row instead of silently shrinking the denominator', () => {
    const bars: DailyBar[] = Array.from({ length: 30 }, (_, i) => ({
      underlying: 'X',
      session: session(i),
      close: 100,
      high: 101,
      low: 99,
    }));
    const base = {
      session: session(20),
      underlying: 'X',
      asof: 0,
      pcrVolume: 1.2,
      pcrZ: 0.5,
      pcrRegime: 'bearish' as const,
      contrarian: 'bullish' as const,
    };
    const ledger: PcrShadowRow[] = [
      { ...base, id: 'a', trio: { side: 'call', trioFired: true } },
      { ...base, id: 'b', trio: { side: 'none', trioFired: false } },                  // no side
      { ...base, id: 'c', pcrVolume: null, trio: { side: 'call', trioFired: true } },  // unusable
      { ...base, id: 'd', underlying: 'ZZZZ', trio: { side: 'call', trioFired: true } }, // no bars
      { ...base, id: 'e', session: session(28), trio: { side: 'call', trioFired: true } }, // no fwd
      { ...base, id: 'f', session: session(5), trio: { side: 'call', trioFired: true } },  // no ATR
    ];
    const { rows, diagnostics: d } = joinForwardReturns(ledger, bars, 5);

    expect(rows).toHaveLength(1);
    expect(d).toMatchObject({
      ledgerRows: 6,
      joined: 1,
      droppedNoTrioSide: 1,
      droppedUnusablePcr: 1,
      droppedNoBars: 1,
      droppedNoForwardBar: 1,
      droppedNoAtr: 1,
    });
    // Every row is accounted for — nothing vanished into a favourable denominator.
    expect(
      d.joined + d.droppedNoTrioSide + d.droppedUnusablePcr + d.droppedNoBars +
      d.droppedNoForwardBar + d.droppedNoAtr + d.droppedNoTrailingBar,
    ).toBe(d.ledgerRows);
  });

  it("measures the horizon in the underlying's own sessions and signs by trio side", () => {
    const tail = [100, 101, 102, 103, 104, 110];
    const bars: DailyBar[] = Array.from({ length: 20 }, (_, i) => ({
      underlying: 'X',
      session: session(i),
      close: i < 14 ? 100 : tail[i - 14] ?? 100,
      high: 101,
      low: 99,
    }));
    const row = (side: 'call' | 'put'): PcrShadowRow => ({
      id: `x-${side}`,
      session: session(14),
      underlying: 'X',
      asof: 0,
      pcrVolume: 1.2,
      pcrZ: 0,
      pcrRegime: 'bearish',
      contrarian: 'bullish',
      trio: { side, trioFired: true },
    });
    const call = joinForwardReturns([row('call')], bars, 5).rows[0];
    const put = joinForwardReturns([row('put')], bars, 5).rows[0];
    // close[19] - close[14] = 110 - 100 = +10 => a call profits, a put loses.
    expect(call.rMultiple).toBeGreaterThan(0);
    expect(put.rMultiple).toBeCloseTo(-call.rMultiple, 10);
  });
});

describe('pcrSideFor', () => {
  it('reads the SAME row to OPPOSITE sides under the two interpretations', () => {
    const fear = { pcrRegime: 'bearish' as const, contrarian: 'bullish' as const, pcrZ: 2 };
    expect(pcrSideFor(fear, 'raw', 'confirming')).toBe('put');   // face value
    expect(pcrSideFor(fear, 'raw', 'contrarian')).toBe('call');  // contrarian
    expect(pcrSideFor(fear, 'zDelta', 'confirming')).toBe('put');
    expect(pcrSideFor(fear, 'zDelta', 'contrarian')).toBe('call');
  });

  it('is SILENT — not disagreeing — on a neutral regime or an immature z', () => {
    expect(pcrSideFor({ pcrRegime: 'neutral', contrarian: null, pcrZ: 0.2 }, 'raw', 'contrarian'))
      .toBeNull();
    // pcrZ null = fewer than 10 trailing sessions (TRA-1663). That is not a side.
    expect(
      pcrSideFor({ pcrRegime: 'bearish', contrarian: 'bullish', pcrZ: null }, 'zDelta', 'contrarian'),
    ).toBeNull();
  });

  it('keeps a silent row out of BOTH overlay cohorts', () => {
    const rows: JoinedRow[] = [
      {
        session: 's', underlying: 'X', side: 'call', trioFired: true,
        pcrRegime: 'neutral', contrarian: null, pcrZ: 0, rMultiple: 5, trailingReturn: 0,
      },
    ];
    const c = cohortize(rows, 'raw', 'contrarian');
    expect(c.trioAlone).toHaveLength(1);
    expect(c.agreeing).toHaveLength(0);
    expect(c.disagreeing).toHaveLength(0);
    expect(c.silent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// THE ARTIFACT — the finding that reshaped this harness.
// ---------------------------------------------------------------------------

describe('the finite-sample artifact', () => {
  it('RAW pre-registered uplift is badly biased UP on a zero-edge ledger; the placebo exposes it', () => {
    // Over one finite price path, backward and forward windows are mechanically
    // negatively correlated, so a contrarian signal built from recent returns shows
    // fake forward edge. At the ~4-week window this study plans to read, that fake
    // edge is several times the +0.05R promotion bar.
    const raw: number[] = [];
    const placebo: number[] = [];
    const adjusted: number[] = [];

    for (let t = 0; t < 60; t++) {
      const { ledger, bars } = synth({ sessions: 30, seed: 40000 + t, edge: 'none' });
      const { rows } = joinForwardReturns(ledger, bars, 5);
      const r = rawUpliftStat('raw', 'contrarian')(rows);
      const p = placeboUpliftStat()(rows);
      const a = adjustedUpliftStat('raw', 'contrarian')(rows);
      if ([r, p, a].every(Number.isFinite)) { raw.push(r); placebo.push(p); adjusted.push(a); }
    }
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

    // The raw statistic — the one the pre-registration named — clears the bar on
    // data with EXACTLY ZERO edge. Promoting on it would promote nothing.
    expect(mean(raw)).toBeGreaterThan(0.15);

    // A signal that provably knows NOTHING earns almost all of that same uplift.
    // That is the proof the raw number is an artifact and not a finding.
    expect(mean(placebo)).toBeGreaterThan(0.15);

    // Netting the placebo out lands the statistic back on ~zero, where the truth is.
    expect(Math.abs(mean(adjusted))).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------
// THE CONTROL PAIR — the reason this harness exists.
// ---------------------------------------------------------------------------

describe('zero-edge control (NEGATIVE)', () => {
  it('refuses a known-zero-edge ledger — where the METHOD AS PRE-REGISTERED would have promoted it', () => {
    // 25 independent zero-edge worlds at the ~4-week window this study plans to
    // read. Count how often each method declares a positive edge (90% CI lower
    // bound > 0). THE TRUE RATE IS ZERO — every fire is a false promotion.
    const TRIALS = 25;
    const boot = { iters: 400, seed: 7 };
    const rawStat = rawUpliftStat('raw', 'contrarian');
    const adjStat = adjustedUpliftStat('raw', 'contrarian');

    let preRegisteredFired = 0; // raw uplift + session-clustered CI = the spec as written
    let correctedFired = 0;     // placebo-adjusted uplift + moving-block CI
    let naiveTighter = 0;

    for (let t = 0; t < TRIALS; t++) {
      const { ledger, bars } = synth({ sessions: 30, seed: 1000 + t, edge: 'none' });
      const { rows } = joinForwardReturns(ledger, bars, 5);

      const preReg = sessionClusteredBootstrap(rows, rawStat, { ...boot, blockLength: 1 });
      const corrected = sessionClusteredBootstrap(rows, adjStat, { ...boot, blockLength: 5 });
      const naive = naiveRowBootstrap(rows, rawStat, boot);

      if (preReg.lo > 0) preRegisteredFired++;
      if (corrected.lo > 0) correctedFired++;
      if (naive.hi - naive.lo < preReg.hi - preReg.lo) naiveTighter++;
    }

    // (1) The row-level illusion: pooling ~450 cross-correlated rows as if they were
    // iid shrinks the interval every single time. That shrinkage is not information —
    // it is the same market factor counted 15 times over.
    expect(naiveTighter).toBe(TRIALS);

    // (2) THE INDICTMENT OF THE SPEC AS WRITTEN. Session-clustering fixes the
    // cross-sectional correlation but leaves the finite-sample bias untouched, so it
    // still puts its interval around a POISONED point estimate and promotes noise on
    // a large fraction of zero-edge ledgers.
    expect(preRegisteredFired).toBeGreaterThan(TRIALS * 0.2);

    // (3) THE ASSERTION THE WHOLE HARNESS IS FOR: with the placebo netted out and the
    // block bootstrap sized to the horizon, a ledger with exactly zero edge
    // essentially never clears the bar.
    expect(correctedFired / TRIALS).toBeLessThanOrEqual(0.12);
    expect(correctedFired).toBeLessThan(preRegisteredFired);
  });

  it('ABSTAINS (HELD) end to end on a zero-edge ledger — the EXACT verdict, not merely "not PASS"', () => {
    const { ledger, bars } = synth({ sessions: 40, seed: 42, edge: 'none' });
    const report = runPcrExpectancy(ledger, bars, { iters: 500, seed: 11 });

    // TRA-1726: assert the EXACT verdict. `not.toBe('PASS')` is what hid the type-II
    // bug — it cannot tell a REJECTION from an ABSTENTION, and both render alike.
    //
    // A zero-edge ledger at 40 sessions is HELD, not FAIL: the clustered interval
    // still STRADDLES the +0.05R bar, so the sample has not refuted the overlay — it
    // has merely failed to support it. Condemning here would be a decision the
    // evidence does not license. (See the anti-predictive control below for what a
    // DECISIVE refutation actually looks like.)
    expect(report.verdict).toBe('HELD');
    expect(report.primary!.clustered.hi).toBeGreaterThanOrEqual(PCR_UPLIFT_BAR_R);

    // And it still PUBLISHES every pre-registered cell — 2 carriers x 2
    // interpretations x 3 horizons. Hiding the losers is how a cherry-pick hides.
    expect(report.cells).toHaveLength(12);
    expect(new Set(report.cells.map((c) => c.horizon))).toEqual(new Set([3, 5, 10]));
  });
});

describe('real-edge control (POSITIVE)', () => {
  it('CLEARS a ledger with a genuine injected edge — the harness can RELEASE, not just refuse', () => {
    // Same bars, same code path. The only change: PCR genuinely forecasts the
    // forward window.
    //
    // This test is exactly as load-bearing as the zero-edge one. A harness hard-wired
    // to say NO-GO passes every negative control perfectly and certifies nothing. An
    // earlier revision of this file did precisely that: a real +1.6R edge could not
    // clear at ANY sample size, because the DSR trial set contained the sign-mirror of
    // the signal itself and so raised its own benchmark as the edge got stronger.
    // Auditing only the refusal path would never have found it.
    //
    // RE-PINNED FOR TRA-1830. The factor-calibrated generator buys ~half the uplift per gamma
    // that the old synth did (ICC 0.712 -> 0.358), and the effective bar now floors the PASS
    // leg at the CI half-width (~0.4R at N=90). So a positive control has to carry a LARGER,
    // LONGER edge to clear — which is the whole point of the change, not a regression: N=120,
    // gamma=3.5 gives a true uplift of ~+1.3R and releases with margin (lo ~0.8R > 0). The
    // gate still RELEASES; it is not wired shut by the detectability floor.
    const { ledger, bars } = synth({ sessions: 120, seed: 5, edge: 'real', gamma: 3.5 });
    const report = runPcrExpectancy(ledger, bars, { iters: 500, seed: 11 });

    expect(report.verdict).toBe('PASS');
    expect(report.primary!.adjustedUpliftR).toBeGreaterThan(0.05);
    expect(report.primary!.clustered.lo).toBeGreaterThan(0);
    expect(report.guards!.dsr!.pass).toBe(true);
    expect(report.guards!.pbo!.pass).toBe(true);
  });

  it('needs a REAL sample: the same genuine edge is HELD — NOT condemned — at the ~4-week window', () => {
    // The corrected inference is honest about how much evidence it has. A strong true
    // edge measured over ~20 sessions is not promotable — not because the edge is
    // absent, but because 20 sessions cannot distinguish it from the artifact. This is
    // the sample-size message for TRA-1609's schedule, pinned as a test.
    //
    // TRA-1726: the EXACT verdict is HELD, and that is the whole point. This assertion
    // used to read `not.toBe('PASS')`, under which the harness actually returned FAIL
    // here and nobody noticed — a real edge, read at the window we had planned, was
    // CONDEMNED. The assertion could not see the difference.
    const { ledger, bars } = synth({ sessions: 20, seed: 5, edge: 'real', gamma: 2.0 });
    const report = runPcrExpectancy(ledger, bars, { iters: 400, seed: 11 });
    expect(report.verdict).toBe('HELD');
  });
});

// ---------------------------------------------------------------------------
// TRA-1726 — THE THREE-VALUED VERDICT.
//
// A GATE WITH THREE OUTCOMES NEEDS THREE CONTROLS. With only a PASS control and a
// refusal control, PASS/FAIL/HELD collapses to PASS/not-PASS — and an unreachable
// branch is then invisible. That is precisely how the type-II bug shipped: `HELD`
// was unreachable above the 20-session floor, every non-PASS fell through to `FAIL`,
// and every control asserted `not.toBe('PASS')` — which a rejection and an
// abstention satisfy identically.
//
// So: one control per outcome, each asserting the EXACT verdict AND the PREDICATE
// that is supposed to produce it.
// ---------------------------------------------------------------------------

describe('the decisive-NO-GO rule (TRA-1726)', () => {
  /**
   * [sessions, expected PASS count over the 8 seeds]
   *
   * RE-PINNED BY TRA-1727 (was 4 / 3 / 4). The secondary estimand added 12 more
   * configurations to the study, so the DSR trial count went from 12 to 24 and the
   * primary now deflates by the FULL study multiplicity. A stricter deflation promotes
   * less on THIN samples, and these counts fell accordingly.
   *
   * THIS IS THE COST OF THE SECOND LOOK, PAID WHERE IT IS INCURRED. It is not a
   * regression and it is not p-hacking: the movement is driven entirely by a declared
   * method change measured on SYNTHETIC controls, before any real ledger row has been
   * read, and it moves the gate toward ABSTENTION — the safe direction. The primary's
   * own promotion window is N=90, where it still releases (the POSITIVE control above).
   * These rows are all BELOW that window, where PASS was never the operative outcome.
   *
   * The two safety legs are unchanged and are what this test is really for: FAIL stays
   * rare (a real edge is not condemned) and HELD stays reachable.
   *
   * RE-PINNED AGAIN FOR TRA-1830 (was 2 / 2 / 4). The factor-calibrated generator buys ~half
   * the uplift per gamma, and the detectability floor tightened the PASS leg, so PASS on these
   * THIN samples fell to 1 / 1 / 1 — further toward ABSTENTION, the safe direction, and still
   * a declared method change measured on synthetic controls before any real row was read.
   */
  const REAL_THIN: Array<[number, number]> = [[20, 1], [30, 1], [45, 1]];

  it('HELD control — a GENUINE edge on a thin sample ABSTAINS; it is not condemned', () => {
    // The regression this issue exists for. Under the old branch this matrix was
    // FAIL 7/8, 6/8, 7/8 — a real overlay retired at the planned read on seven draws
    // out of eight. FAIL is now the rare exception (the nominal tail of the ratified
    // 90% CI), not the default for "we could not prove it".
    for (const [sessions, expectedPass] of REAL_THIN) {
      const counts: Record<string, number> = { PASS: 0, FAIL: 0, HELD: 0 };
      for (let t = 0; t < 8; t++) {
        const { ledger, bars } = synth({ sessions, seed: 5 + t * 101, edge: 'real', gamma: 2.0 });
        counts[runPcrExpectancy(ledger, bars, { iters: 400, seed: 11 }).verdict]++;
      }
      expect(counts.FAIL).toBeLessThanOrEqual(1);     // at most 1 of 8 condemned
      expect(counts.HELD).toBeGreaterThanOrEqual(3);  // the abstention branch is REACHABLE
      expect(counts.PASS).toBe(expectedPass);
    }
  });

  it('FAIL control — an ANTI-PREDICTIVE overlay is DECISIVELY refused, on a THIN sample', () => {
    // The control that proves the check CAN FIRE. Without it, converting FAIL->HELD
    // could have left FAIL unreachable — and a gate that can never condemn is exactly
    // as broken as one that condemns everything: TRA-1609 would abstain forever.
    //
    // A genuinely HARMFUL overlay — the sign-mirror of a real edge, i.e. we read the
    // CONFIRMING interpretation of a ledger whose true edge is contrarian — puts the
    // WHOLE interval below the bar. That is positive evidence AGAINST, and it is
    // decisive at only 30 sessions. This is the early exit the rule buys: we are not
    // committing to a blind wait for 90 sessions to bin a bad overlay.
    for (const sessions of [30, 45]) {
      for (let t = 0; t < 8; t++) {
        const { ledger, bars } = synth({ sessions, seed: 5 + t * 101, edge: 'real', gamma: 2.0 });
        const report = runPcrExpectancy(ledger, bars, {
          iters: 400,
          seed: 11,
          primaryInterpretation: 'confirming',
        });
        expect(report.verdict).toBe('FAIL');
        // ASSERT THE PREDICATE, NOT THE LABEL: a FAIL must mean the optimistic end of
        // the interval genuinely cannot reach the bar.
        expect(report.primary!.clustered.hi).toBeLessThan(PCR_UPLIFT_BAR_R);
      }
    }
  });

  it('the rule is EXACTLY "CI upper bound < bar" — the label always matches the predicate', () => {
    // A structural invariant over a mixed sweep. Whatever verdict comes out, it must
    // be the one the STATED rule produces. This is what stops the three branches from
    // silently drifting apart from their documented meanings again.
    for (const edge of ['none', 'real'] as const) {
      for (const sessions of [6, 20, 45]) {
        const { ledger, bars } = synth({ sessions, seed: 77, edge, gamma: 2.0 });
        const report = runPcrExpectancy(ledger, bars, { iters: 300, seed: 11 });
        const hi = report.primary?.clustered.hi ?? NaN;
        const decisive = Number.isFinite(hi) && hi < PCR_UPLIFT_BAR_R;

        if (report.verdict === 'FAIL') {
          expect(decisive).toBe(true);
        } else if (report.verdict === 'HELD') {
          // HELD is EITHER a straddling interval OR an inevaluable one — never a
          // decisive refutation.
          expect(decisive).toBe(false);
        }
      }
    }
  });

  it('IGNORANCE IS NOT CONDEMNATION — an inevaluable CI is HELD, never FAIL', () => {
    // 6 sessions: the block bootstrap cannot form two whole blocks, so the interval is
    // NaN. A NaN upper bound must NOT satisfy `hi < bar` and drop into FAIL — that
    // would condemn an overlay on the strength of having NO information about it.
    const { ledger, bars } = synth({ sessions: 6, seed: 3, edge: 'real', gamma: 2.5 });
    const report = runPcrExpectancy(ledger, bars, { iters: 300, seed: 11 });

    expect(Number.isFinite(report.primary!.clustered.hi)).toBe(false);
    expect(report.verdict).toBe('HELD');
    expect(report.reasons.join(' ')).toMatch(/not evaluable/i);
  });

  it('MONOTONE TOWARD ABSTENTION — the rule never manufactures a PASS on zero edge', () => {
    // The safety property that lets this land WITHOUT re-opening the pre-registration:
    // the change can only ever convert FAIL -> HELD. PASS is evaluated FIRST and its
    // legs are untouched, so no sample that used to be refused can now be promoted.
    for (const sessions of [20, 45, 90]) {
      for (let t = 0; t < 4; t++) {
        const { ledger, bars } = synth({ sessions, seed: 300 + t * 17, edge: 'none' });
        const report = runPcrExpectancy(ledger, bars, { iters: 300, seed: 11 });
        // The one place a negative assertion belongs: this is a statement about the
        // PASS branch ALONE (never promote noise), not a stand-in for a verdict we
        // could not be bothered to name.
        expect(report.verdict).not.toBe('PASS');
      }
    }
  });

  it('zero edge at the planned read CAN be decisively refused — N=90 => FAIL', () => {
    // The early exit on the exact cell TRA-1726 asked to pin. On THIS seed the clustered
    // interval HAS tightened under the +0.05R bar, so the sample genuinely refutes the
    // overlay and the harness says so plainly. FAIL is a real, reachable outcome at
    // the planned window — it is simply no longer the DEFAULT for "not PASS".
    //
    // RE-PINNED FOR TRA-1830 (was seed 42). On the factor-calibrated generator a truly-zero
    // overlay is decisively refused on only a MINORITY of N=90 draws (the noise floor is
    // ~0.20R against a 0.05R bar, so the interval usually straddles) — the companion test
    // below pins that rate. seed 528 is one of the draws where the whole interval clears
    // the bar (ciHi ~ -0.07R, a comfortable margin), so the decisive branch is REACHABLE.
    const { ledger, bars } = synth({ sessions: 90, seed: 528, edge: 'none' });
    const report = runPcrExpectancy(ledger, bars, { iters: 500, seed: 11 });

    expect(report.verdict).toBe('FAIL');
    expect(report.primary!.clustered.hi).toBeLessThan(PCR_UPLIFT_BAR_R);
    expect(report.reasons.join(' ')).toMatch(/DECISIVE NO-GO/);
  });

  it('KNOWN LIMITATION, pinned: on a USELESS overlay a decisive NO-GO is the MINORITY outcome', () => {
    // The honest RATE, so nobody plans around the single seed above. A merely USELESS
    // overlay (exactly zero edge — as opposed to a HARMFUL one, refused 8/8 at N=30)
    // is decisively refused on only a MINORITY of draws even at the planned read: its
    // interval usually still straddles the bar, so HELD is the MODAL verdict.
    //
    // Consequence for the TRA-1664 study plan, recorded here so it is not discovered
    // in November: if PCR is pure noise, the most likely outcome at N=90 is HELD, not
    // a clean FAIL — the study will most often want to keep accruing rather than
    // retire. Retiring TRA-1609 on a NULL result therefore wants a separate
    // PRECISION/FUTILITY stopping rule (retire once the interval is tight enough that
    // a +0.05R effect WOULD have been seen). That is a change to the pre-registration
    // and needs board sign-off; it is deliberately NOT smuggled in here.
    const counts: Record<string, number> = { PASS: 0, FAIL: 0, HELD: 0 };
    for (let t = 0; t < 8; t++) {
      const { ledger, bars } = synth({ sessions: 90, seed: 5 + t * 101, edge: 'none' });
      counts[runPcrExpectancy(ledger, bars, { iters: 300, seed: 11 }).verdict]++;
    }
    expect(counts.PASS).toBe(0);                    // never promotes noise (safety)
    expect(counts.HELD).toBeGreaterThanOrEqual(6);  // ...but mostly ABSTAINS
    expect(counts.FAIL).toBeLessThanOrEqual(2);     // ...and only sometimes refutes
  });
});

describe('fail-closed on a thin ledger', () => {
  it('HOLDS (never PASSes) below the 20-session floor, even when the point uplift looks great', () => {
    // 6 sessions of a strong real edge. The number will look wonderful. There is
    // still not enough INDEPENDENT evidence to promote, and PBO/DSR cannot even be
    // computed — the underlying CSCV would fail OPEN here, so we hold instead.
    const { ledger, bars } = synth({ sessions: 6, seed: 3, edge: 'real', gamma: 2.5 });
    const report = runPcrExpectancy(ledger, bars, { iters: 300, seed: 11 });

    expect(report.verdict).toBe('HELD');
    expect(report.primary!.legs.sessionFloor).toBe(false);
    expect(report.guards!.dsrEvaluable).toBe(false);
    expect(report.reasons.join(' ')).toMatch(/HELD, not passed/);
  });

  it('HOLDS on an empty ledger rather than vacuously passing', () => {
    const report = runPcrExpectancy([], [], { iters: 100, seed: 1 });
    expect(report.verdict).toBe('HELD');
    expect(report.shape.rows).toBe(0);
  });

  it('refuses to report a DEGENERATE interval when the block is too long for the sample', () => {
    // Fewer than 2 whole blocks => every circular draw is a rotation of the entire
    // session set => the statistic never varies => the interval collapses to zero
    // width. A zero-width interval sitting above zero would read as `lo > 0`: a
    // confident PASS backed by no variance whatsoever. It must come back NOT
    // EVALUABLE (NaN), which fails the CI leg closed.
    const { ledger, bars } = synth({ sessions: 6, seed: 3, edge: 'real', gamma: 2.5 });
    const { rows } = joinForwardReturns(ledger, bars, 5);
    const stat = adjustedUpliftStat('raw', 'contrarian');

    const degenerate = sessionClusteredBootstrap(rows, stat, {
      iters: 200, seed: 1, blockLength: 10, // 10 > 6 sessions
    });
    expect(Number.isNaN(degenerate.lo)).toBe(true);
    expect(degenerate.effective).toBe(0);

    // ...and therefore the cell's CI leg is false, not a silent pass.
    const cell = evaluateCell(rows, 10, 'raw', 'contrarian', { iters: 200, seed: 1 });
    expect(cell.legs.clusteredCiPositive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TRA-1756 R3 — THE BAR WAS NEVER CHECKED FOR DETECTABILITY.
// RE-ISSUED FOR TRA-1830 against the factor-calibrated generator (ICC 0.712 -> 0.358).
//
// TRA-1727's review found that the SECONDARY estimand can only release on an edge that does
// not exist. The primary has the same disease: its MDE at the planned N=90 read is ~+1.0R
// against a +0.05R promotion bar. The bar is a PROMOTION threshold — "an edge this small is
// not worth trading" — and nobody ever checked it was a DETECTABLE one. Both things are true
// at once, and only the first was ever a decision.
//
// The magnitudes here are ~30% smaller than the pre-TRA-1830 table (MDE +1.5R -> +1.0R, the
// half-width 0.19-0.61R -> 0.20-0.47R) because the old synth was 2x too market-factor-
// dominated and so bought 2x the uplift per gamma. THE DISEASE SURVIVED THE FIX: the bar is
// still far under the noise floor after the generator was made realistic.
//
// These tests MEASURE the claim `PRIMARY_POWER_CONSTRAINT` makes. A caveat nobody checked
// is just a comment, and this one is load-bearing for how the November verdict gets read.
// ---------------------------------------------------------------------------

describe('TRA-1756 R3 — the primary MDE, pinned', () => {
  it('the CI half-width is 4-9x the bar it is asked to grade — the bar is UNDER the noise floor', () => {
    // The mechanism behind the whole finding, in one number. And note the direction: the
    // interval WIDENS as the true edge grows, so the instrument gets LESS precise exactly
    // when there is something to see. That is why the power curve climbs so slowly.
    //
    // Measured on the corrected generator (12 worlds/cell, N=90): zero edge -> ~0.20R
    // half-width at gamma 2.0; the +1.02R positive control (gamma 1.2) -> ~0.47R. Against
    // a +0.05R bar.
    const halfWidthAt = (gamma: number, edge: 'none' | 'real'): number => {
      const hws: number[] = [];
      for (let t = 0; t < 12; t++) {
        const { ledger, bars } = synth({ sessions: 90, seed: 1000 + t, edge, gamma });
        const p = runPcrExpectancy(ledger, bars, { iters: 300, seed: 11 }).primary;
        if (p && Number.isFinite(p.clustered.hi)) hws.push((p.clustered.hi - p.clustered.lo) / 2);
      }
      return mean(hws);
    };

    const zeroEdge = halfWidthAt(2.0, 'none');
    const posControl = halfWidthAt(1.2, 'real');

    expect(zeroEdge).toBeGreaterThan(3 * PCR_UPLIFT_BAR_R); // ~0.20R vs a 0.05R bar
    expect(posControl).toBeGreaterThan(7 * PCR_UPLIFT_BAR_R); // ~0.47R
    // ...and it gets WORSE, not better, when a real edge is present.
    expect(posControl).toBeGreaterThan(zeroEdge);
  }, 300000);

  it('a NEARLY-TEN-TIMES-THE-BAR true edge is all but INVISIBLE at the planned N=90 read', () => {
    // `gamma: 0.3` is a true bias-adjusted uplift of +0.48R (+/-0.05, N=250 x 15 worlds) on
    // the corrected generator — 9.6x the +0.05R promotion bar, far larger than any PCR edge
    // anyone has claimed.
    //
    // It releases 2 times out of 12 at N=90. This is the number that makes the November read
    // uninterpretable without the caveat: the study is being run at an N where an edge many
    // times better than the bar is essentially indistinguishable from nothing.
    let passes = 0;
    for (let t = 0; t < 12; t++) {
      const { ledger, bars } = synth({ sessions: 90, seed: 1000 + t, edge: 'real', gamma: 0.3 });
      if (runPcrExpectancy(ledger, bars, { iters: 300, seed: 11 }).verdict === 'PASS') passes++;
    }
    expect(passes).toBeLessThanOrEqual(3); // ~17% power on a ~10x-bar edge
  }, 300000);

  it('the gate is NOT simply wired shut — its own 20x-the-bar positive control DOES release', () => {
    // The other half of the two-sided control, and the reason the test above means anything.
    // A gate that never releases would produce the identical near-0/12 above. This one
    // releases ~7/12 on a +1.02R edge (gamma 1.2, the pre-registered `edge:'real'` control)
    // — which is exactly the point: the ONLY thing it can see is ~20x the bar it grades.
    let passes = 0;
    for (let t = 0; t < 12; t++) {
      const { ledger, bars } = synth({ sessions: 90, seed: 1000 + t, edge: 'real', gamma: 1.2 });
      if (runPcrExpectancy(ledger, bars, { iters: 300, seed: 11 }).verdict === 'PASS') passes++;
    }
    expect(passes).toBeGreaterThanOrEqual(5); // MDE territory: ~58% power on a 20x-bar edge
  }, 300000);

  it('stamps PRIMARY_POWER_CONSTRAINT on every report, and into the reasons of every HELD', () => {
    const { ledger, bars } = synth({ sessions: 90, seed: 1000, edge: 'none', gamma: 2.0 });
    const rep = runPcrExpectancy(ledger, bars, { iters: 300, seed: 11 });

    expect(rep.power).toBe(PRIMARY_POWER_CONSTRAINT);
    expect(rep.power).toMatch(/HELD IS NOT EVIDENCE OF ABSENCE/i);
    expect(rep.power).toMatch(/never checked to be a DETECTABLE one/i);
    // TRA-1830: the R-scale/factor structure ARE now calibrated to real bars, and the
    // constant must say so — plus the residual ~1.5x optimism the ICC fix leaves behind.
    expect(rep.power).toMatch(/CALIBRATED TO REAL BARS/i);
    expect(rep.power).toMatch(/OPTIMISTIC/);

    if (rep.verdict === 'HELD') {
      expect(rep.reasons.some((r) => /HELD — READ THIS BEFORE ACTING ON IT/.test(r))).toBe(true);
    }
  }, 120000);
});

// ---------------------------------------------------------------------------
// TRA-1830 — THE DETECTABILITY FLOOR. `effectiveBar = max(+0.05R economic, CI half-width)`.
//
// These MEASURE the four properties the issue asks for, they do not label them:
//   (a) effectiveBar >= half-width, always;
//   (b) the change is MONOTONE — no world that FAILed/HELD under the raw bar PASSes under it;
//   (c) a positive control on a large-enough edge STILL releases (the gate is not wired shut);
//   (d) the zero-edge control STILL refuses.
// Plus the load-bearing asymmetry: the floor tightens PASS but is NOT wired into the FAIL
// (decisive-NO-GO) branch, where it would convert imprecision into an irreversible condemnation.
// ---------------------------------------------------------------------------

describe('TRA-1830 — the detectability floor', () => {
  it('(a) effectiveBar is ALWAYS >= the CI half-width AND >= the economic floor', () => {
    // A grid of intervals spanning tight/wide and negative/positive point estimates.
    const cis = [
      { lo: -0.02, hi: 0.02 },   // tight, half-width 0.02 < economic
      { lo: 0.0, hi: 0.10 },     // half-width 0.05 == economic
      { lo: -0.30, hi: 0.30 },   // wide, half-width 0.30 > economic
      { lo: 0.20, hi: 0.80 },    // wide and positive, half-width 0.30
      { lo: -1.0, hi: 1.0 },     // very wide
    ];
    for (const ci of cis) {
      const hw = ciHalfWidth(ci);
      const bar = effectiveBar(ci);
      expect(bar.effectiveR).toBeGreaterThanOrEqual(hw - 1e-12);
      expect(bar.effectiveR).toBeGreaterThanOrEqual(PCR_UPLIFT_BAR_R - 1e-12);
      expect(bar.effectiveR).toBeCloseTo(Math.max(PCR_UPLIFT_BAR_R, hw), 12);
      expect(bar.binding).toBe(hw > PCR_UPLIFT_BAR_R ? 'detectability' : 'economic');
    }
  });

  it('FAILS CLOSED: an inevaluable (NaN) interval yields no passable bar', () => {
    const bar = effectiveBar({ lo: Number.NaN, hi: 0.5 });
    expect(bar.binding).toBe('non-evaluable');
    expect(Number.isNaN(bar.effectiveR)).toBe(true);
    // "We could not measure the noise" is not a licence to promote — a huge uplift still
    // cannot clear a non-evaluable bar.
    expect(clearsEffectiveBar(999, bar)).toBe(false);
    expect(effectiveBarReason(bar, 999)).toMatch(/NOT EVALUABLE/i);
  });

  it('(b) MONOTONE — clearing the effective bar IMPLIES clearing the +0.05R economic bar', () => {
    // The property in the abstract: because effectiveR = max(0.05, hw) >= 0.05, anything that
    // clears it clears the raw bar too. Swept over a wide grid of (uplift, interval) pairs so
    // this is a measurement of the invariant, not a restatement of the max().
    for (let u = -1; u <= 2; u += 0.05) {
      for (const hw of [0.0, 0.03, 0.05, 0.2, 0.5]) {
        const bar = effectiveBar({ lo: -hw, hi: hw });
        if (clearsEffectiveBar(u, bar)) {
          expect(u).toBeGreaterThanOrEqual(PCR_UPLIFT_BAR_R - 1e-12);
        }
      }
    }
  });

  it('(b) MONOTONE end-to-end — no synth world PASSes on an uplift below the raw bar', () => {
    // The same invariant through the whole harness. A PASS verdict must carry an adjusted
    // uplift that clears BOTH the effective bar and (therefore) the +0.05R economic one. The
    // floor can only ever make PASS harder; it cannot manufacture one.
    for (const gamma of [0, 0.3, 1.2, 3.5]) {
      for (let t = 0; t < 4; t++) {
        const { ledger, bars } = synth({
          sessions: 120, seed: 2000 + t, edge: gamma === 0 ? 'none' : 'real', gamma: gamma || 1.2,
        });
        const rep = runPcrExpectancy(ledger, bars, { iters: 300, seed: 11 });
        if (rep.verdict === 'PASS') {
          expect(rep.primary!.adjustedUpliftR).toBeGreaterThanOrEqual(rep.primary!.bar.effectiveR);
          expect(rep.primary!.adjustedUpliftR).toBeGreaterThanOrEqual(PCR_UPLIFT_BAR_R);
        }
      }
    }
  }, 300000);

  it('(c)+(d) DISCRIMINATES — zero edge REFUSED, a large-enough edge still RELEASES', () => {
    // The two-sided control on the floored gate. Without (c) the change could have wired the
    // gate shut; without (d) it could have been a rubber stamp.
    const zero = synth({ sessions: 120, seed: 5, edge: 'none' });
    expect(runPcrExpectancy(zero.ledger, zero.bars, { iters: 500, seed: 11 }).verdict).not.toBe('PASS');

    const strong = synth({ sessions: 120, seed: 5, edge: 'real', gamma: 3.5 });
    const rep = runPcrExpectancy(strong.ledger, strong.bars, { iters: 500, seed: 11 });
    expect(rep.verdict).toBe('PASS');
    // ...and it passed BECAUSE the uplift cleared the (much larger than 0.05R) effective bar.
    expect(rep.primary!.bar.effectiveR).toBeGreaterThan(PCR_UPLIFT_BAR_R);
    expect(rep.primary!.adjustedUpliftR).toBeGreaterThan(rep.primary!.bar.effectiveR);
  }, 180000);

  it('the effective bar TRAVELS with every verdict — in reasons[], PASS/FAIL/HELD alike', () => {
    for (const [edge, gamma] of [['none', 1.2], ['real', 3.5]] as const) {
      const { ledger, bars } = synth({ sessions: 120, seed: 5, edge, gamma });
      const rep = runPcrExpectancy(ledger, bars, { iters: 300, seed: 11 });
      const joined = rep.reasons.join(' ');
      expect(joined).toMatch(/EFFECTIVE BAR/);
      // The binding term is named out loud, so a November reader does not "fix" a 0.4R bar
      // back to 0.05R.
      expect(joined).toMatch(/binding|BINDING/);
    }
  }, 120000);

  it('THE ASYMMETRY — the floor tightens PASS but does NOT drive the irreversible FAIL branch', () => {
    // The load-bearing property from DETECTABILITY_FLOOR_CONSTRAINT. On a zero-edge world the
    // effective bar is ~0.4R and the uplift plainly does NOT clear it — the uplift LEG is
    // false — yet the world must NOT be CONDEMNED, because a wide interval is IGNORANCE and
    // the condemn branch reads the ECONOMIC bar (`ciUpper < 0.05`), never the effective one.
    // Wiring the floor into FAIL would condemn zero edge on ~a coin flip; this pins that it
    // does not.
    let held = 0;
    for (let t = 0; t < 6; t++) {
      const { ledger, bars } = synth({ sessions: 90, seed: 700 + t * 31, edge: 'none' });
      const rep = runPcrExpectancy(ledger, bars, { iters: 300, seed: 11 });
      const p = rep.primary!;
      // The uplift leg is failed by the floor (0 uplift < ~0.4R effective bar)...
      expect(p.legs.upliftBar).toBe(false);
      // ...but a straddling interval is HELD, not FAIL: the floor did not manufacture a
      // condemnation out of imprecision.
      if (Number.isFinite(p.clustered.hi) && p.clustered.hi >= PCR_UPLIFT_BAR_R) {
        expect(rep.verdict).not.toBe('FAIL');
        held++;
      }
    }
    expect(held).toBeGreaterThanOrEqual(1);
    expect(DETECTABILITY_FLOOR_CONSTRAINT).toMatch(/deliberately NOT applied to the FAIL/i);
  }, 180000);
});

// ---------------------------------------------------------------------------
// TRA-1830 — THE SYNTH FACTOR-STRUCTURE CALIBRATION.
//
// The generator's within-session ICC was 0.712 vs the real watchlist's 0.358 (TRA-1810), so
// it was 2x too market-factor-dominated and every effect size read off it was ~2x optimistic.
// `SYNTH_FACTOR_SCALE` moves variance from the factor channel to the idiosyncratic one, HOLDING
// each name's total daily variance constant, so the ICC drops to ~0.358 WITHOUT disturbing the
// already-calibrated R-scale. These MEASURE that, using the SAME variance-ratio ICC estimator
// (`1 - (rho_idio/rho_total)^2`) that produced TRA-1810's 0.358.
// ---------------------------------------------------------------------------

describe('TRA-1830 — synth factor-structure calibration', () => {
  const sd = (xs: number[]): number => {
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  };
  // Within-session ICC of the R-multiple, variance-ratio form — matches TRA-1810 / _1830_icc.
  const iccAt = (factorScale: number): number => {
    const iccs: number[] = [];
    for (let seed = 1; seed <= 6; seed++) {
      const { ledger, bars } = synth({ sessions: 90, seed, edge: 'none', factorScale });
      const { rows } = joinForwardReturns(ledger, bars, 5);
      const bySess = new Map<string, number[]>();
      for (const r of rows) {
        if (!Number.isFinite(r.rMultiple)) continue;
        if (!bySess.has(r.session)) bySess.set(r.session, []);
        bySess.get(r.session)!.push(r.rMultiple);
      }
      const sessMean = new Map([...bySess].map(([s, v]) => [s, mean(v)]));
      const rhoTotal = sd(rows.map((r) => r.rMultiple));
      const rhoIdio = sd(rows.map((r) => r.rMultiple - sessMean.get(r.session)!));
      iccs.push(1 - (rhoIdio / rhoTotal) ** 2);
    }
    return mean(iccs);
  };

  it('the default factorScale is CALIBRATED (< 1) and its ICC matches the real 0.358', () => {
    expect(SYNTH_FACTOR_SCALE).toBeLessThan(1);
    const calibrated = iccAt(SYNTH_FACTOR_SCALE);
    const original = iccAt(1);
    // The original synth is ~0.70 (2x the real target); the calibrated one lands near 0.358.
    expect(original).toBeGreaterThan(0.62);
    expect(calibrated).toBeGreaterThan(0.30);
    expect(calibrated).toBeLessThan(0.42);
    // And the WHOLE POINT: calibration moved the ICC MUCH closer to reality than it was.
    const REAL_ICC = 0.358;
    expect(Math.abs(calibrated - REAL_ICC)).toBeLessThan(Math.abs(original - REAL_ICC));
  }, 60000);

  it('holds TOTAL daily variance constant — the R-scale axis is not disturbed', () => {
    // The invariant that lets the ICC be fixed without re-breaking the (already calibrated)
    // R-scale: for every name and every scale, (s*beta)^2 + idio^2 == beta^2 + 0.36.
    for (const name of NAMES) {
      const b = BETA[name];
      for (const s of [1.0, SYNTH_FACTOR_SCALE, 0.5, 0.8]) {
        const idio = idioLoading(name, s);
        expect((s * b) ** 2 + idio ** 2).toBeCloseTo(b * b + 0.36, 10);
      }
    }
  });

  it('is BIT-IDENTICAL to the TRA-1664 original at factorScale = 1', () => {
    // idioLoading collapses to exactly the old 0.6, so the RNG draws and the bars are
    // unchanged — a "generalization" that silently moved the baseline would invalidate every
    // control in the suite at once.
    for (const name of NAMES) expect(idioLoading(name, 1)).toBeCloseTo(0.6, 12);
    const a = synth({ sessions: 40, seed: 7, edge: 'real', gamma: 2.0, factorScale: 1 });
    const b = synth({ sessions: 40, seed: 7, edge: 'real', gamma: 2.0, factorScale: 1 });
    expect(a.bars.map((x) => x.close)).toEqual(b.bars.map((x) => x.close));
  });

  it('REFUSES a factorScale that would leave no idiosyncratic variance', () => {
    // beta=1.0 name: total budget 1.36, so factorScale 1.2 (factor var 1.44) overruns it.
    // Emit an error rather than a NaN price path.
    expect(() => idioLoading('SPY', 1.2)).toThrow(/variance budget/);
  });
});

// SPEC v3.1(A) — the PRIMARY's N=30 feasibility kill-gate constant. TRA-1741, re-ruled 1829.
describe('Spec v3.1(A) — primary N=30 feasibility threshold', () => {
  it('BINDS at 0.073R — the CTO re-rule (TRA-1829), NOT the null-world 0.09R', () => {
    // 0.09R = 0.05 * 3^0.5 assumed an i.i.d. 1/sqrt(N) decay that holds only under H0.
    // The act-world decay exponent is ~0.34, which puts the threshold at ~0.073R. Pinning
    // the RULED value so it cannot silently drift back to the loose null-world number.
    expect(PRIMARY_HW30_FEASIBILITY_R).toBe(0.073);
    // Strictly tighter than the originally-ruled null-world number.
    expect(PRIMARY_HW30_FEASIBILITY_R).toBeLessThan(0.0866);
  });

  it('EQUALS the secondary constant by design — one number pre-registered for both', () => {
    // Both estimands' act-world decay exponent lands at ~0.34, so a single shared value is
    // pre-registered. If either estimand is re-derived to a different p, this MUST break.
    expect(PRIMARY_HW30_FEASIBILITY_R).toBe(XS_HW30_FEASIBILITY_R);
  });

  it('is read at calendar N=30, the same gate the secondary uses', () => {
    expect(PRIMARY_FEASIBILITY_GATE_N).toBe(30);
    expect(PRIMARY_FEASIBILITY_GATE_N).toBe(XS_FEASIBILITY_GATE_N);
  });
});
