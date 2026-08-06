// TRA-1023 (TRA-1022 audit, work-item 5) — options-sleeve risk breaker.
//
// A circuit-breaker for the OPTIONS sleeve, deliberately DECOUPLED from the
// equity `DailyRiskGovernor` (server `signal-engine.ts`). The audit found option
// closes never reach ANY breaker, and folding them into the equity governor
// would be wrong in both directions: an equity loss-streak must not freeze a
// healthy options book, and a bad options day must not freeze equity entries.
//
// The equity governor keeps its raw 3-consecutive-loss + 8% daily-drawdown rule.
// For the options sleeve a raw loss-COUNT trips on a run of small theta scratches
// that a single defined-risk winner more than pays for, so this breaker prefers
// an R-multiple / daily-drawdown rule better matched to the fat-tailed,
// theta-bleeding option P&L distribution:
//
//   • cumulative realized R at/below −maxCumulativeLossR (default −2R), OR
//   • sleeve daily drawdown at/beyond dailyDrawdownPct of the sleeve equity
//     baseline (default 5%).
//
// Pure and dependency-free: the ET-day roll is injected (`now` + `dayKey`) so the
// server can pass the same `etDateString` semantics the equity governor uses and
// the boundary stays unit-testable. NEVER routes or opens anything — it only
// reports a halt the caller's option-open gate consults.
//
// TRA-3086 (CTO ruling on TRA-2878) — the sleeve was given a HALT and never given
// a THROTTLE. The equity book has both stages (`risk-autopilot.ts`: throttle at
// halt−1 consecutive losses / ≈4% drawdown, halt at 3 / ≈8%); the options sleeve
// had only the all-or-nothing trip above. Worse, `activeRiskSizingMultiplier`
// sized every option ticket off the EQUITY governor's throttle, so an option was
// trimmed only while the OTHER book sat at exactly two consecutive losses.
//
// {@link OptionsRiskBreaker.riskThrottle} closes that gap: a tighten-only
// multiplier in (0, 1], banded strictly BELOW the halt, derived entirely from
// state this class already keeps (`cumulativeR`, `dailyPnl`, and the sleeve
// equity baseline the halt's own drawdown leg already receives). No new inputs
// and no new plumbing — deliberately, because the counter-proposal (feed option
// closes into the equity `DailyRiskGovernor.recordTrade`) was ruled against on
// the merits: a raw loss-COUNT is the wrong ESTIMATOR for a book whose P&L is
// fat-tailed and theta-bleeding, not merely the wrong wire (TRA-1023 header).
// The two books' halt paths stay decoupled exactly as TRA-1023 set them.

export interface OptionsBreakerParams {
  /**
   * Cumulative realized R at/below which the sleeve halts for the day. Stored as
   * a positive magnitude; the trip compares against its negation (default 2 ⇒ −2R).
   */
  maxCumulativeLossR: number;
  /** Sleeve daily-drawdown fraction at/beyond which it halts (default 0.05 = 5%). */
  dailyDrawdownPct: number;
  /**
   * TRA-3086 — THROTTLE band, cumulative-R leg: realized R at/below which the
   * sleeve sizes down (positive magnitude; compared against its negation). Must
   * be strictly less than {@link maxCumulativeLossR} or the leg has no region to
   * fire in — see {@link resolveOptionsThrottleBand}, which reports that rather
   * than silently inventing one.
   */
  throttleCumulativeLossR: number;
  /**
   * TRA-3086 — THROTTLE band, drawdown leg: sleeve daily-drawdown fraction
   * at/beyond which the sleeve sizes down. Must be strictly less than
   * {@link dailyDrawdownPct}.
   */
  throttleDrawdownPct: number;
  /** TRA-3086 — the multiplier applied inside the band. Tighten-only: clamped into [0.1, 1]. */
  throttleMultiplier: number;
}

/**
 * Floor for the throttle multiplier, mirroring the equity side's
 * `MIN_RISK_THROTTLE` (`packages/server/src/risk-autopilot.ts`). Duplicated as a
 * literal rather than imported because this package must stay dependency-free of
 * the server; the two are pinned equal by a guard test.
 *
 * A configured 0 or a negative clamps UP to this rather than through to 0 for the
 * same reason the equity clamp does: "de-risk" conservatively means "size small",
 * never "the throttle silently became a second halt". A halt is a separate,
 * explicit, surfaced state ({@link OptionsRiskBreaker.isHalted}).
 */
export const MIN_OPTIONS_RISK_THROTTLE = 0.1;

/**
 * TRA-3086 — band thresholds are **PROVISIONAL and UNRATIFIED**.
 *
 * They are placeholders at half the halt's magnitudes, chosen only so the band is
 * well-formed (strictly below the trip) and so the dark counters have something
 * to count. They are NOT a calibration and must not be cited as one. The halt's
 * own −2R/−5% came from the sleeve's observed R and drawdown distribution
 * (TRA-1023); the throttle band gets its numbers from the SAME basis, and that
 * derivation is QuantTrader's under TRA-2331 once the dark observation this issue
 * ships has accrued a distribution to read.
 *
 * That is exactly why {@link OptionsRiskBreaker.riskThrottle} ships dark at the
 * sizing site (`OPTIONS_RISK_THROTTLE_SIZING_ENABLED`, server-side): picking a
 * band from a guess and arming it in the same change would leave nothing to
 * measure the guess against.
 */
export const DEFAULT_OPTIONS_BREAKER_PARAMS: OptionsBreakerParams = {
  maxCumulativeLossR: 2,
  dailyDrawdownPct: 0.05,
  throttleCumulativeLossR: 1,
  throttleDrawdownPct: 0.025,
  throttleMultiplier: 0.5,
};

/** TRA-3086 — the resolved throttle band, with each leg's usability made explicit. */
export interface OptionsThrottleBand {
  /**
   * Effective cumulative-R threshold (positive magnitude), or `null` when the
   * configured value is not strictly below the halt's — in which case the leg has
   * no region between throttle and halt and is DISABLED rather than clamped.
   * Clamping would trim on a band the operator never asked for; disabling is the
   * same "no information ⇒ no trim" rule the multiplier clamp uses, and
   * {@link degenerate} makes it loud instead of silent.
   */
  cumulativeLossR: number | null;
  /** Effective drawdown-fraction threshold, or `null` when not strictly below the halt's. */
  drawdownPct: number | null;
  /** The tighten-only multiplier applied inside the band, clamped into [0.1, 1]. */
  multiplier: number;
  /**
   * True when at least one configured leg was NOT strictly below its halt
   * counterpart and was therefore dropped. A band with BOTH legs degenerate can
   * never fire — a throttle stage that reads exactly like a calm sleeve — so this
   * flag is surfaced in {@link OptionsBreakerSnapshot} and asserted by the guards.
   */
  degenerate: boolean;
}

/**
 * Resolve the usable throttle band from the params. Exported so the degenerate
 * case is directly testable: a band whose legs sit at or above the halt is a
 * refusal branch that cannot fire, and one of those reads identically to a sleeve
 * that simply never entered the band.
 */
export function resolveOptionsThrottleBand(params: OptionsBreakerParams): OptionsThrottleBand {
  const haltR = Math.abs(params.maxCumulativeLossR);
  const haltDd = params.dailyDrawdownPct;

  const wantR = Math.abs(params.throttleCumulativeLossR);
  const wantDd = params.throttleDrawdownPct;

  const rOk = Number.isFinite(wantR) && wantR > 0 && wantR < haltR;
  const ddOk = Number.isFinite(wantDd) && wantDd > 0 && wantDd < haltDd;

  return {
    cumulativeLossR: rOk ? wantR : null,
    drawdownPct: ddOk ? wantDd : null,
    multiplier: clampThrottleMultiplier(params.throttleMultiplier),
    degenerate: !rOk || !ddOk,
  };
}

/**
 * Tighten-only clamp for the band multiplier. Mirrors
 * `riskThrottleSizeMultiplier`'s contract on the equity side:
 *   • non-finite ⇒ 1 (no information ⇒ no trim)
 *   • ≥ 1        ⇒ 1 (a throttle may never RAISE size)
 *   • otherwise  ⇒ clamped into [MIN_OPTIONS_RISK_THROTTLE, 1)
 */
function clampThrottleMultiplier(m: number): number {
  if (typeof m !== 'number' || !Number.isFinite(m)) return 1;
  if (m >= 1) return 1;
  return Math.min(1, Math.max(MIN_OPTIONS_RISK_THROTTLE, m));
}

/** One realized option close fed to the breaker. */
export interface OptionCloseRecord {
  /** Realized P&L in dollars (signed; net of fees/slippage as booked). */
  pnl: number;
  /**
   * Initial defined risk for the position in dollars (> 0). R = pnl / riskUsd.
   * For a defined-risk spread this is `maxLossUsd`; for a long single leg it is
   * the premium at risk (`premiumPaid × contracts × 100`). A non-positive or
   * non-finite value contributes to daily P&L but not to the R tally.
   */
  riskUsd: number;
}

export interface OptionsBreakerSnapshot {
  halted: boolean;
  reason: string | null;
  /** Cumulative realized R booked so far today. */
  cumulativeR: number;
  /** Realized sleeve P&L booked so far today (dollars). */
  dailyPnl: number;
  /** Number of closes booked today. */
  closes: number;
  /** ET day-key the tallies belong to. */
  day: string;
  /** TRA-3086 — the sub-halt THROTTLE stage. */
  throttle: {
    /** What {@link OptionsRiskBreaker.riskThrottle} returns right now, in (0, 1]. */
    multiplier: number;
    /**
     * Which leg armed it, or `null` when the sleeve is outside the band. Present
     * so "1.0 because the sleeve is calm" and "1.0 because the band is
     * unreachable" are not the same reading — {@link OptionsThrottleBand.degenerate}
     * separates them.
     */
    reason: string | null;
    /** The resolved band, including whether either leg was dropped as degenerate. */
    band: OptionsThrottleBand;
    /**
     * The sleeve-equity baseline the drawdown leg is measured against — the value
     * from the most recent {@link OptionsRiskBreaker.recordClose}. `null` before
     * the first close of the day, which is also exactly when `dailyPnl` is 0 and
     * the drawdown leg has nothing to say.
     */
    sleeveEquity: number | null;
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Per-sleeve circuit-breaker. Construct one per options sleeve; feed it every
 * realized option close via {@link recordClose} and consult {@link isHalted} at
 * the option-open gate. Tallies reset on the injected day roll.
 */
export class OptionsRiskBreaker {
  private cumulativeR = 0;
  private dailyPnl = 0;
  private closes = 0;
  private currentDay: string;
  private halted = false;
  private haltReason: string | null = null;
  private haltListener: ((reason: string) => void) | null = null;
  /**
   * TRA-3086 — the sleeve-equity denominator from the most recent `recordClose`.
   *
   * `recordClose` already receives this for the halt's drawdown leg; the throttle
   * needs the same denominator at a moment when no close is happening, so it is
   * retained rather than added as a new input (the issue forbids both a signature
   * change and new plumbing). Retaining the LAST value is sufficient rather than
   * approximate: `dailyPnl` can only be non-zero after at least one `recordClose`,
   * so the drawdown leg can never be asked a question while this is null.
   */
  private sleeveEquityBaseline: number | null = null;
  private readonly band: OptionsThrottleBand;

  constructor(
    private readonly params: OptionsBreakerParams = DEFAULT_OPTIONS_BREAKER_PARAMS,
    private readonly now: () => Date = () => new Date(),
    /** ET-day key for the date; defaults to a UTC slice. Server passes `etDateString`. */
    private readonly dayKey: (d: Date) => string = (d) => d.toISOString().slice(0, 10),
  ) {
    this.currentDay = this.dayKey(this.now());
    this.band = resolveOptionsThrottleBand(this.params);
  }

  /**
   * Register a listener fired exactly once on the false→true halt transition
   * (mirrors `DailyRiskGovernor.setHaltListener`). A failing listener never
   * breaks breaker accounting.
   */
  setHaltListener(listener: (reason: string) => void): void {
    this.haltListener = listener;
  }

  private resetIfNewDay(): void {
    const today = this.dayKey(this.now());
    if (today !== this.currentDay) {
      this.cumulativeR = 0;
      this.dailyPnl = 0;
      this.closes = 0;
      this.halted = false;
      this.haltReason = null;
      this.sleeveEquityBaseline = null;
      this.currentDay = today;
    }
  }

  /**
   * Book one realized option close. `sleeveEquity` is the sleeve-capital baseline
   * for the drawdown test (the demo options book sizes against the demo equity
   * account, so the caller passes that). Trips the breaker when either the
   * cumulative-R or the daily-drawdown limit is breached.
   */
  recordClose(rec: OptionCloseRecord, sleeveEquity: number): void {
    this.resetIfNewDay();
    const pnl = Number.isFinite(rec.pnl) ? rec.pnl : 0;
    this.dailyPnl += pnl;
    this.closes += 1;
    // TRA-3086 — retain the denominator the halt's drawdown leg uses below, so
    // `riskThrottle()` can answer between closes off the same basis.
    if (Number.isFinite(sleeveEquity) && sleeveEquity > 0) this.sleeveEquityBaseline = sleeveEquity;
    if (Number.isFinite(rec.riskUsd) && rec.riskUsd > 0) {
      this.cumulativeR += pnl / rec.riskUsd;
    }

    const wasHalted = this.halted;
    const lossR = Math.abs(this.params.maxCumulativeLossR);
    if (!this.halted && this.cumulativeR <= -lossR) {
      this.halted = true;
      this.haltReason =
        `Options sleeve cumulative ${this.cumulativeR.toFixed(2)}R ≤ −${lossR}R ` +
        `— sleeve halted for the day`;
    }

    const ddPct = sleeveEquity > 0 ? Math.abs(this.dailyPnl) / sleeveEquity : 0;
    if (!this.halted && this.dailyPnl < 0 && ddPct >= this.params.dailyDrawdownPct) {
      this.halted = true;
      this.haltReason =
        `Options sleeve daily drawdown −${(ddPct * 100).toFixed(1)}% exceeded ` +
        `${this.params.dailyDrawdownPct * 100}% limit — sleeve halted for the day`;
    }

    if (!wasHalted && this.halted && this.haltListener) {
      try {
        this.haltListener(this.haltReason ?? 'Options sleeve halted by risk breaker');
      } catch {
        // A notification failure must never break the breaker's accounting.
      }
    }
  }

  /** True when the options sleeve is halted for the current ET day. */
  isHalted(): boolean {
    this.resetIfNewDay();
    return this.halted;
  }

  getHaltReason(): string | null {
    return this.haltReason;
  }

  /**
   * TRA-3086 — the sleeve's THROTTLE stage: a tighten-only sizing multiplier in
   * (0, 1] for the current ET day, banded strictly BELOW {@link isHalted}'s trip.
   *
   * Returns exactly 1 outside the band, so composing it into an existing
   * `sizeMultiplier` can only ever shrink a sized quantity, never raise one.
   *
   * Both legs read state this class already accrues on every `recordClose`:
   *   • cumulative realized R at/below −`throttleCumulativeLossR`, OR
   *   • sleeve daily drawdown at/beyond `throttleDrawdownPct` of the retained
   *     sleeve-equity baseline.
   *
   * Deliberately NOT special-cased when halted. Past the halt's trip the sleeve is
   * necessarily past the (strictly lower) throttle band too, so this keeps
   * returning the trimmed multiplier and the function stays monotone in loss —
   * a "halted ⇒ 1" branch would make the throttle read LOOSER at the worst state
   * it can be in. The halt is enforced separately at the open gate, so nothing is
   * sized off this value there anyway.
   */
  riskThrottle(): number {
    this.resetIfNewDay();
    return this.evaluateThrottle().multiplier;
  }

  /** The throttle multiplier plus the leg that armed it. Assumes the day roll is settled. */
  private evaluateThrottle(): { multiplier: number; reason: string | null } {
    const { cumulativeLossR, drawdownPct, multiplier } = this.band;

    if (cumulativeLossR !== null && this.cumulativeR <= -cumulativeLossR) {
      return {
        multiplier,
        reason:
          `Options sleeve cumulative ${this.cumulativeR.toFixed(2)}R ≤ −${cumulativeLossR}R ` +
          `— sizing throttled to ${multiplier}× (halt at −${Math.abs(this.params.maxCumulativeLossR)}R)`,
      };
    }

    const equity = this.sleeveEquityBaseline;
    if (drawdownPct !== null && equity !== null && equity > 0 && this.dailyPnl < 0) {
      const ddPct = Math.abs(this.dailyPnl) / equity;
      if (ddPct >= drawdownPct) {
        return {
          multiplier,
          reason:
            `Options sleeve daily drawdown −${(ddPct * 100).toFixed(1)}% ≥ ${drawdownPct * 100}% ` +
            `— sizing throttled to ${multiplier}× (halt at ${this.params.dailyDrawdownPct * 100}%)`,
        };
      }
    }

    return { multiplier: 1, reason: null };
  }

  /** Diagnostics for the `/api/health/options-pipeline` readout. */
  snapshot(): OptionsBreakerSnapshot {
    this.resetIfNewDay();
    const throttle = this.evaluateThrottle();
    return {
      halted: this.halted,
      reason: this.haltReason,
      cumulativeR: round2(this.cumulativeR),
      dailyPnl: round2(this.dailyPnl),
      closes: this.closes,
      day: this.currentDay,
      // TRA-3086 — the sub-halt stage, with its band, so a reader can tell a calm
      // sleeve from an unreachable band without re-deriving either.
      throttle: {
        multiplier: throttle.multiplier,
        reason: throttle.reason,
        band: { ...this.band },
        sleeveEquity: this.sleeveEquityBaseline,
      },
    };
  }

  /**
   * Operator reset of the sleeve breaker for the current day (mirrors
   * `DailyRiskGovernor.resetDailyCircuitBreaker`). Clears the tallies and the
   * halt so an operator can re-enable the sleeve after reviewing a tripped day.
   */
  reset(): void {
    this.cumulativeR = 0;
    this.dailyPnl = 0;
    this.closes = 0;
    this.halted = false;
    this.haltReason = null;
    // TRA-3086 — clear the throttle's denominator too. Leaving it set would let a
    // reset sleeve carry a stale baseline; with the tallies at 0 that changes no
    // decision today, but "reset means reset" is the invariant worth keeping.
    this.sleeveEquityBaseline = null;
  }
}
