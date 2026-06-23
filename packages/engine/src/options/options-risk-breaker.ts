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

export interface OptionsBreakerParams {
  /**
   * Cumulative realized R at/below which the sleeve halts for the day. Stored as
   * a positive magnitude; the trip compares against its negation (default 2 ⇒ −2R).
   */
  maxCumulativeLossR: number;
  /** Sleeve daily-drawdown fraction at/beyond which it halts (default 0.05 = 5%). */
  dailyDrawdownPct: number;
}

export const DEFAULT_OPTIONS_BREAKER_PARAMS: OptionsBreakerParams = {
  maxCumulativeLossR: 2,
  dailyDrawdownPct: 0.05,
};

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

  constructor(
    private readonly params: OptionsBreakerParams = DEFAULT_OPTIONS_BREAKER_PARAMS,
    private readonly now: () => Date = () => new Date(),
    /** ET-day key for the date; defaults to a UTC slice. Server passes `etDateString`. */
    private readonly dayKey: (d: Date) => string = (d) => d.toISOString().slice(0, 10),
  ) {
    this.currentDay = this.dayKey(this.now());
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

  /** Diagnostics for the `/api/health/options-pipeline` readout. */
  snapshot(): OptionsBreakerSnapshot {
    this.resetIfNewDay();
    return {
      halted: this.halted,
      reason: this.haltReason,
      cumulativeR: round2(this.cumulativeR),
      dailyPnl: round2(this.dailyPnl),
      closes: this.closes,
      day: this.currentDay,
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
  }
}
