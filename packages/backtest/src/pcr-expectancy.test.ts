import { describe, expect, it } from 'vitest';
import {
  adjustedUpliftStat,
  atrBySession,
  cohortize,
  evaluateCell,
  joinForwardReturns,
  mulberry32,
  naiveRowBootstrap,
  PCR_UPLIFT_BAR_R,
  pcrSideFor,
  placeboUpliftStat,
  rawUpliftStat,
  runPcrExpectancy,
  sessionClusteredBootstrap,
  type DailyBar,
  type JoinedRow,
  type PcrShadowRow,
} from './pcr-expectancy.js';

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
// Synthetic market with the real watchlist's correlation structure.
// ---------------------------------------------------------------------------

/** 4 near-duplicate index exposures + a mega-cap-tech beta block + a few others. */
const NAMES = [
  'SPY', 'QQQ', 'IWM', 'DIA',
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'AVGO',
  'XOM', 'JPM', 'WMT', 'PFE',
];

/** Everything loads hard on the single market factor — that is the whole point. */
const BETA: Record<string, number> = Object.fromEntries(
  NAMES.map((n) => [
    n,
    ['SPY', 'QQQ', 'IWM', 'DIA'].includes(n) ? 1.0
      : ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'AVGO'].includes(n) ? 1.2
      : 0.7,
  ]),
);

const WARMUP = 20; // bars before the first ledger session (ATR(14) + trailing window)
const TAIL = 15;   // bars after the last ledger session, so H=10 can resolve

function session(i: number): string {
  const d = new Date(Date.UTC(2026, 0, 5) + i * 86400000);
  return d.toISOString().slice(0, 10);
}

function gauss(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/**
 * Build a synthetic ledger + bars.
 *
 * `edge`:
 *  - 'none' — PCR is a function of the PRECEDING market window: fear rises AFTER a
 *             selloff. Realistic, and carries NO information about the future.
 *             TRUE FORWARD EDGE IS EXACTLY ZERO.
 *  - 'real' — PCR is a (noisy) function of the FORWARD window: fear rises BEFORE a
 *             rally, so the CONTRARIAN read is genuinely predictive.
 *             TRUE FORWARD EDGE IS POSITIVE.
 *
 * In both worlds the BARS are constructed identically — only the PCR generation
 * changes. That isolates exactly the thing under test.
 */
function synth(opts: {
  sessions: number;
  seed: number;
  edge: 'none' | 'real';
  horizon?: number;
  gamma?: number;
}): { ledger: PcrShadowRow[]; bars: DailyBar[] } {
  const { sessions: N, seed, edge } = opts;
  const H = opts.horizon ?? 5;
  const gamma = opts.gamma ?? 1.2;
  const rng = mulberry32(seed);

  const total = WARMUP + N + TAIL;
  // One market factor per session — the source of the cross-name correlation.
  const m: number[] = Array.from({ length: total }, () => gauss(rng));

  const bars: DailyBar[] = [];
  for (const name of NAMES) {
    let px = 100;
    for (let i = 0; i < total; i++) {
      px = px * (1 + (BETA[name] * m[i] + 0.6 * gauss(rng)) * 0.01);
      bars.push({
        underlying: name,
        session: session(i),
        close: px,
        high: px * (1 + Math.abs(gauss(rng)) * 0.004),
        low: px * (1 - Math.abs(gauss(rng)) * 0.004),
      });
    }
  }

  const ledger: PcrShadowRow[] = [];
  for (let s = 0; s < N; s++) {
    const i = WARMUP + s;
    // The PCR driver — the ONLY difference between the two worlds.
    // Positive driver => high z => high PCR => "fear" => contrarian read = CALL.
    const driver =
      edge === 'real'
        ? m.slice(i + 1, i + 1 + H).reduce((a, b) => a + b, 0) / Math.sqrt(H) //  fear PRECEDES a rally
        : -m.slice(i - H + 1, i + 1).reduce((a, b) => a + b, 0) / Math.sqrt(H); // fear FOLLOWS a selloff

    for (const name of NAMES) {
      const z = gamma * driver + 0.8 * gauss(rng);
      const pcrVolume = Math.max(0.05, 0.85 + 0.28 * z);
      const regime = pcrVolume < 0.7 ? 'bullish' : pcrVolume > 1.0 ? 'bearish' : 'neutral';
      const contrarian =
        regime === 'bearish' ? 'bullish' : regime === 'bullish' ? 'bearish' : null;

      ledger.push({
        id: `${name}:${session(i)}`,
        session: session(i),
        underlying: name,
        asof: i * 86400000,
        pcrVolume,
        pcrZ: z,
        pcrRegime: regime,
        contrarian,
        // Every row is a fired trio on the long side, so the trio-alone baseline is
        // the plain forward return and the overlay's only job is to beat it.
        trio: { side: 'call', trioFired: true },
      });
    }
  }

  return { ledger, bars };
}

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
    const { ledger, bars } = synth({ sessions: 90, seed: 5, edge: 'real', gamma: 2.0 });
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
  /** [sessions, expected PASS count over the 8 seeds] */
  const REAL_THIN: Array<[number, number]> = [[20, 4], [30, 3], [45, 4]];

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
    // The early exit on the exact cell TRA-1726 asked to pin. Here the clustered
    // interval HAS tightened under the +0.05R bar, so the sample genuinely refutes the
    // overlay and the harness says so plainly. FAIL is a real, reachable outcome at
    // the planned window — it is simply no longer the DEFAULT for "not PASS".
    const { ledger, bars } = synth({ sessions: 90, seed: 42, edge: 'none' });
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
