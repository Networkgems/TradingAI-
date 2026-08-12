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
  /**
   * TRA-3218 — cooldown re-arm. Minutes a latched halt holds before it RELEASES
   * and new entries may resume. `0` (the default) DISABLES the release entirely:
   * the halt latches for the rest of the ET day, byte-for-byte the pre-3218
   * behaviour. The clock runs from the LATCH ({@link OptionsRiskBreaker}
   * `haltAt`), not from the last close — further bleed during the cooldown does
   * not extend it, but it DOES lower the state the re-trip floors are cut from
   * at release, so a sleeve that kept bleeding needs that much more room before
   * it trips again.
   */
  haltCooldownMinutes: number;
  /**
   * TRA-3218 — how much FURTHER the sleeve must deteriorate after a cooldown
   * release before the halt re-trips, in R (positive magnitude). At release the
   * breaker records the cumulative-R and daily-P&L water lines; a re-trip
   * requires the original trip condition AND a drop of this much R (or its
   * drawdown-dollar equivalent, `dailyDrawdownPct × sleeveEquity`) below those
   * lines. Without this step the original predicate (`cumulativeR ≤ −maxR`)
   * still holds at the moment of release and the very next close would re-latch,
   * making the release a no-op.
   */
  reArmStepR: number;
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
  // TRA-3218 — cooldown re-arm RATIFIED. It initially shipped disabled (0 ⇒
  // day-latched halt) because the release window and re-arm step are risk
  // numbers the board signs off on, not values a build picks unilaterally.
  // The board signed off 2026-08-12 (TRA-3218 interaction aaa723a6, option
  // scope_0): a latched sleeve halt releases after 60 minutes, and re-trips
  // only one further R (or drawdown-dollar equivalent) below the release-time
  // water lines. Set `haltCooldownMinutes: 0` to restore the day-latch.
  haltCooldownMinutes: 60,
  reArmStepR: 1,
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
  /** TRA-3218 — ms epoch of the latest halt latch this day (null when never latched). */
  haltAt: number | null;
  /** TRA-3218 — halt latches booked this day (a released-then-re-tripped day counts 2). */
  haltsToday: number;
  /** TRA-3218 — cooldown releases granted this day (0 while the cooldown is disabled). */
  releasesToday: number;
  /** TRA-3218 — the cooldown re-arm stage's configuration + live floors. */
  cooldown: {
    /** Minutes a latch holds before releasing; 0 ⇒ disabled (day-latched, legacy). */
    minutes: number;
    /** Extra R of deterioration a re-trip requires after a release. */
    reArmStepR: number;
    /** cumulative-R water line a re-trip must breach (null until a release). */
    reTripFloorR: number | null;
    /** daily-P&L water line ($) a drawdown re-trip must breach (null until a release). */
    reTripFloorPnl: number | null;
  };
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

/**
 * TRA-3218 — the breaker's full daily state, as persisted by the server's
 * options-breaker ledger and re-applied at boot via
 * {@link OptionsRiskBreaker.restoreState}. Everything here is DAY-SCOPED: the
 * `day` key is what stops yesterday's latch resurrecting across the ET roll.
 */
export interface OptionsBreakerPersistedState {
  /** ET day-key the state belongs to (same semantics as the injected `dayKey`). */
  day: string;
  cumulativeR: number;
  dailyPnl: number;
  closes: number;
  sleeveEquityBaseline: number | null;
  halted: boolean;
  haltReason: string | null;
  haltAt: number | null;
  haltsToday: number;
  releasesToday: number;
  reTripFloorR: number | null;
  reTripFloorPnl: number | null;
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
  /** TRA-3218 — ms epoch of the latest latch (null when never latched today). */
  private haltAt: number | null = null;
  /** TRA-3218 — per-day latch / release tallies for the health readout. */
  private haltsToday = 0;
  private releasesToday = 0;
  /**
   * TRA-3218 — re-trip water lines, cut at the moment of a cooldown RELEASE from
   * the then-current tallies minus one `reArmStepR` step. Null until a release
   * happens (the first trip of the day uses the plain thresholds). They exist
   * because the plain predicates (`cumulativeR ≤ −maxR`) still hold at release —
   * without a floor strictly below the release-time state, the next close would
   * re-latch instantly and the release would be a no-op.
   */
  private reTripFloorR: number | null = null;
  private reTripFloorPnl: number | null = null;
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
      // TRA-3218 — latch time, tallies, and re-trip floors are DAILY state like
      // everything else here; the ET day roll clears them in lockstep.
      this.haltAt = null;
      this.haltsToday = 0;
      this.releasesToday = 0;
      this.reTripFloorR = null;
      this.reTripFloorPnl = null;
      this.sleeveEquityBaseline = null;
      this.currentDay = today;
    }
  }

  /**
   * TRA-3218 — the cooldown re-arm. When enabled (`haltCooldownMinutes > 0`) and
   * the latch is older than the window, RELEASE the halt and cut the re-trip
   * water lines one `reArmStepR` step below the CURRENT tallies (which include
   * any further bleed booked by exits during the cooldown — a sleeve that kept
   * deteriorating needs that much more room before it trips again).
   *
   * Deliberately evaluated lazily from the read sites (`isHalted` / `recordClose`
   * / `snapshot`) rather than on a timer, mirroring how `resetIfNewDay` rolls:
   * no clock callback to leak, and a restored (post-reboot) latch releases on the
   * same schedule it would have in-process because `haltAt` is persisted with it.
   */
  private maybeReleaseHalt(): void {
    const mins = this.params.haltCooldownMinutes;
    if (!this.halted || !(mins > 0) || this.haltAt === null) return;
    if (this.now().getTime() - this.haltAt < mins * 60_000) return;
    const stepR = Math.abs(this.params.reArmStepR) || 1;
    // The drawdown leg's dollar step: one reArmStepR-scaled drawdown-limit's
    // worth of the retained sleeve equity. With no baseline retained (cannot
    // happen after a close; defensive) fall back to 0 ⇒ any further loss re-trips.
    const equity = this.sleeveEquityBaseline ?? 0;
    const stepPnl = stepR * this.params.dailyDrawdownPct * equity;
    this.halted = false;
    this.haltReason = null;
    this.releasesToday += 1;
    this.reTripFloorR = this.cumulativeR - stepR;
    this.reTripFloorPnl = this.dailyPnl - stepPnl;
  }

  /**
   * Book one realized option close. `sleeveEquity` is the sleeve-capital baseline
   * for the drawdown test (the demo options book sizes against the demo equity
   * account, so the caller passes that). Trips the breaker when either the
   * cumulative-R or the daily-drawdown limit is breached.
   */
  recordClose(rec: OptionCloseRecord, sleeveEquity: number): void {
    this.resetIfNewDay();
    // TRA-3218 — settle an expired cooldown BEFORE booking, so a close landing
    // after the window books against a released sleeve and the re-trip floors
    // (not the raw thresholds) decide whether it re-latches.
    this.maybeReleaseHalt();
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
    // TRA-3218 — after a cooldown release the plain threshold still holds, so a
    // re-trip additionally requires breaching the release-time water line.
    const rFloorOk = this.reTripFloorR === null || this.cumulativeR <= this.reTripFloorR;
    if (!this.halted && this.cumulativeR <= -lossR && rFloorOk) {
      this.halted = true;
      this.haltAt = this.now().getTime();
      this.haltsToday += 1;
      this.haltReason =
        `Options sleeve cumulative ${this.cumulativeR.toFixed(2)}R ≤ −${lossR}R ` +
        `— sleeve halted for the day`;
    }

    const ddPct = sleeveEquity > 0 ? Math.abs(this.dailyPnl) / sleeveEquity : 0;
    const pnlFloorOk = this.reTripFloorPnl === null || this.dailyPnl <= this.reTripFloorPnl;
    if (!this.halted && this.dailyPnl < 0 && ddPct >= this.params.dailyDrawdownPct && pnlFloorOk) {
      this.halted = true;
      this.haltAt = this.now().getTime();
      this.haltsToday += 1;
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
    this.maybeReleaseHalt(); // TRA-3218 — an expired cooldown releases at the read
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
    this.maybeReleaseHalt(); // TRA-3218 — never report a latch the read sites would release
    const throttle = this.evaluateThrottle();
    return {
      halted: this.halted,
      reason: this.haltReason,
      cumulativeR: round2(this.cumulativeR),
      dailyPnl: round2(this.dailyPnl),
      closes: this.closes,
      day: this.currentDay,
      haltAt: this.haltAt,
      haltsToday: this.haltsToday,
      releasesToday: this.releasesToday,
      cooldown: {
        minutes: this.params.haltCooldownMinutes,
        reArmStepR: this.params.reArmStepR,
        reTripFloorR: this.reTripFloorR === null ? null : round2(this.reTripFloorR),
        reTripFloorPnl: this.reTripFloorPnl === null ? null : round2(this.reTripFloorPnl),
      },
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
   * TRA-3218 — the durable-restart seam, in BOTH directions.
   *
   * `exportState()` is the full daily state a caller persists after each close /
   * latch; `restoreState()` re-applies it at boot. Together they close the hole
   * the ticket names: the breaker is in-memory, and bqb1 reboots nightly (plus
   * mid-session on deploys/crashes) — without this seam a reboot silently CLEARS
   * a latched halt (the accidental halt-clearing mechanism), and equally
   * silently ZEROES the tallies so a bleeding sleeve reboots as a calm one and
   * cannot re-trip. Restoring `haltAt` with the latch means a cooldown release
   * happens on the same schedule it would have in-process — a reboot neither
   * shortens nor restarts the window.
   *
   * `restoreState` applies ONLY when (a) the persisted day equals the current ET
   * day (yesterday's halt must never resurrect — the day roll is the one
   * legitimate clearing mechanism), and (b) this breaker is still pristine
   * (no closes booked, no halt): it is a BOOT seam, not a merge — once live
   * closes have booked, the in-memory state is the truth and a late restore
   * would clobber it. Returns whether it applied.
   */
  exportState(): OptionsBreakerPersistedState {
    this.resetIfNewDay();
    return {
      day: this.currentDay,
      cumulativeR: this.cumulativeR,
      dailyPnl: this.dailyPnl,
      closes: this.closes,
      sleeveEquityBaseline: this.sleeveEquityBaseline,
      halted: this.halted,
      haltReason: this.haltReason,
      haltAt: this.haltAt,
      haltsToday: this.haltsToday,
      releasesToday: this.releasesToday,
      reTripFloorR: this.reTripFloorR,
      reTripFloorPnl: this.reTripFloorPnl,
    };
  }

  restoreState(state: OptionsBreakerPersistedState): boolean {
    this.resetIfNewDay();
    if (state.day !== this.currentDay) return false; // stale day — the roll wins
    if (this.closes > 0 || this.halted) return false; // live state wins over a late restore
    this.cumulativeR = Number.isFinite(state.cumulativeR) ? state.cumulativeR : 0;
    this.dailyPnl = Number.isFinite(state.dailyPnl) ? state.dailyPnl : 0;
    this.closes = Number.isFinite(state.closes) && state.closes > 0 ? Math.floor(state.closes) : 0;
    this.sleeveEquityBaseline =
      typeof state.sleeveEquityBaseline === 'number' && state.sleeveEquityBaseline > 0
        ? state.sleeveEquityBaseline
        : null;
    this.halted = state.halted === true;
    this.haltReason = typeof state.haltReason === 'string' ? state.haltReason : null;
    this.haltAt = typeof state.haltAt === 'number' && Number.isFinite(state.haltAt) ? state.haltAt : null;
    this.haltsToday =
      Number.isFinite(state.haltsToday) && state.haltsToday > 0 ? Math.floor(state.haltsToday) : 0;
    this.releasesToday =
      Number.isFinite(state.releasesToday) && state.releasesToday > 0
        ? Math.floor(state.releasesToday)
        : 0;
    this.reTripFloorR =
      typeof state.reTripFloorR === 'number' && Number.isFinite(state.reTripFloorR)
        ? state.reTripFloorR
        : null;
    this.reTripFloorPnl =
      typeof state.reTripFloorPnl === 'number' && Number.isFinite(state.reTripFloorPnl)
        ? state.reTripFloorPnl
        : null;
    return true;
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
    // TRA-3218 — an operator reset clears the latch history and re-trip floors
    // too: "reset means reset", exactly as the baseline note below says.
    this.haltAt = null;
    this.haltsToday = 0;
    this.releasesToday = 0;
    this.reTripFloorR = null;
    this.reTripFloorPnl = null;
    // TRA-3086 — clear the throttle's denominator too. Leaving it set would let a
    // reset sleeve carry a stale baseline; with the tallies at 0 that changes no
    // decision today, but "reset means reset" is the invariant worth keeping.
    this.sleeveEquityBaseline = null;
  }
}
