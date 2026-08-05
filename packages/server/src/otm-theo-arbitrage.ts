/**
 * TRA-2662 — static no-arbitrage detector for the OTM panel's `theo` surface.
 *
 * ## The defect this measures
 *
 * Vertical-spread monotonicity is a **model-free** no-arbitrage condition on any
 * price surface:
 *
 *   • calls  C(K) must be NON-INCREASING in K
 *   • puts   P(K) must be NON-DECREASING in K
 *
 * Violate it and a vertical spread can be bought for a credit with a payoff that
 * is never negative. It holds for the market by construction — nobody offers a
 * free option — so applying it to `mark` asks "is the tape coherent?" and
 * applying it to `theo` asks "is OUR MODEL coherent?".
 *
 * Measured live and reproduced by three agents on five builds across seven days:
 *
 * | capture                                   | `mark`  | `theo`  |
 * |-------------------------------------------|---------|---------|
 * | 2026-07-30 pre-open, `176834c5` (TRA-2662) | 0 / 143 | 11 / 143|
 * | 2026-07-30 ~09:40Z, `239f2b5`  (TRA-2669)  | —       | 11 / 143|
 * | 2026-07-30 RTH,    `9e7f1c7`   (TRA-2706)  | 0 / 170 |  5 / 170|
 * | 2026-08-05 pre-open, `9fbc9077` (this fix) | 0 /  97 |  3 /  97|
 *
 * The market is coherent in every capture; the model never is.
 *
 * ## Cause — measured, and now ATTRIBUTED
 *
 * `theo` is textbook Black-Scholes-Merton at **r = 0.045, q = 0**, T = calendar
 * days to 16:00 ET / 365, and σ = the contract's OWN `ivUsed`, which is Tradier's
 * per-contract `greeks.smv_vol` taken at face value
 * (`tradier/options-client.ts:524` → `otm-mispricing.ts:217`).
 *
 * Every other BS input is **shared by every strike in a chain**: one scalar
 * `spot`, one `now`, one `r`, one `q`. With σ held FLAT across strikes, BS is
 * strictly monotone in K by construction — so the σ sequence is the only degree
 * of freedom that can break monotonicity. That makes attribution a computation,
 * not an inference, and it was confirmed both ways on 2026-08-05:
 *
 *   • repricing each chain at its MEDIAN `ivUsed` → **0 / 97** violations;
 *   • repricing each violating pair's HIGH strike at the LOW strike's own
 *     `ivUsed` → **3 / 3** violations vanish.
 *
 * There is no smile FIT here to be mis-shaped — `smv_vol` is a vendor field read
 * per contract with no cross-strike constraint anywhere in the pipeline. That is
 * why the failing cell ROTATES between captures (SPY calls → QQQ calls → SPY
 * puts) and why the earlier "call-wing" localisation was falsified on TRA-2706:
 * there is no wing, only whichever contracts the vendor happened to quote a
 * noisy σ on that minute.
 *
 * ## Why a violation count on the PANEL is a LOWER BOUND
 *
 * The panel's rows are already filtered (OTM, spread, OI, minMark, theo/delta
 * floors), so "adjacent" here means adjacent among SURVIVING strikes, not
 * adjacent in the raw chain. That only ever UNDER-counts: monotonicity is
 * transitive, so a violation between two surviving strikes is necessarily a
 * violation of the full surface, while a violation between two strikes that were
 * filtered apart can be missed. A non-zero count is therefore always real; a
 * zero count is "none detected", not "proven arbitrage-free".
 *
 * ## The acceptance trap this guard must NOT fall into (TRA-2669)
 *
 * **A monotonicity-only bar can be passed by over-smoothing.** Flattening σ
 * across strikes drives violations to 0 — that is exactly what the attribution
 * test above does — while destroying the strike-by-strike disagreement the panel
 * exists to surface. So this module deliberately reports the `mark` arm as a
 * NEGATIVE CONTROL next to the `theo` arm. `mark` violations must stay 0 for the
 * measurement to mean anything: if the detector starts flagging the market, the
 * detector is broken, not the market. A green `theo` arm is only meaningful
 * alongside a green `mark` arm AND retained discrimination — see
 * `scripts/check-theo-arb.mjs`, which grades all of it and can fail on either.
 */

/** The subset of `OtmMispricingCandidate` this detector reads. */
export interface ArbitrageCandidate {
  optionSymbol: string;
  optionType: 'call' | 'put';
  strike: number;
  expiration: string;
  theo: number;
  mark: number;
}

/** Which surface a violation was found on. */
export type ArbitrageBasis = 'theo' | 'mark';

export interface VerticalViolation {
  basis: ArbitrageBasis;
  expiration: string;
  optionType: 'call' | 'put';
  /** The lower of the two adjacent surviving strikes. */
  lowStrike: number;
  highStrike: number;
  lowValue: number;
  highValue: number;
  /**
   * Dollar size of the incoherence for ONE contract (×100 multiplier). This is
   * the credit the violated vertical would pay while owing a payoff that is
   * never negative.
   */
  gapPerContract: number;
  lowSymbol: string;
  highSymbol: string;
}

export interface ArbitrageReport {
  /** Adjacent surviving-strike pairs tested, summed over (expiration, type). */
  pairsTested: number;
  /** Violations on the MODEL surface. Expected 0; non-zero is the defect. */
  theoViolations: VerticalViolation[];
  /**
   * Violations on the MARKET surface — the negative control. Expected 0. A
   * non-zero value means the DETECTOR is miscalibrated (or the tape is genuinely
   * crossed), and invalidates the theo arm rather than confirming it.
   */
  markViolations: VerticalViolation[];
  /** Largest `gapPerContract` across `theoViolations`; null when there are none. */
  worstTheoGapPerContract: number | null;
}

/**
 * Group by (expiration, optionType), sort by strike, and flag adjacent pairs
 * that break vertical monotonicity on each surface.
 *
 * Rows with a non-finite value on a surface are skipped FOR THAT SURFACE only —
 * an unpriced row is not evidence of arbitrage, and dropping the whole row would
 * silently shrink the other arm's sample too.
 */
export function findVerticalArbitrage(candidates: readonly ArbitrageCandidate[]): ArbitrageReport {
  const buckets = new Map<string, ArbitrageCandidate[]>();
  for (const c of candidates) {
    const key = `${c.expiration}|${c.optionType}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(c);
  }

  const theoViolations: VerticalViolation[] = [];
  const markViolations: VerticalViolation[] = [];
  let pairsTested = 0;

  for (const bucket of buckets.values()) {
    const rows = [...bucket].sort((a, b) => a.strike - b.strike);
    if (rows.length < 2) continue;
    pairsTested += rows.length - 1;

    for (let i = 0; i + 1 < rows.length; i += 1) {
      const lo = rows[i];
      const hi = rows[i + 1];
      for (const basis of ['theo', 'mark'] as const) {
        const lv = lo[basis];
        const hv = hi[basis];
        if (!Number.isFinite(lv) || !Number.isFinite(hv)) continue;
        // Calls must not RISE with strike; puts must not FALL with strike.
        const violates = lo.optionType === 'call' ? hv > lv : hv < lv;
        if (!violates) continue;
        const v: VerticalViolation = {
          basis,
          expiration: lo.expiration,
          optionType: lo.optionType,
          lowStrike: lo.strike,
          highStrike: hi.strike,
          lowValue: lv,
          highValue: hv,
          gapPerContract: Math.abs(hv - lv) * 100,
          lowSymbol: lo.optionSymbol,
          highSymbol: hi.optionSymbol,
        };
        if (basis === 'theo') theoViolations.push(v);
        else markViolations.push(v);
      }
    }
  }

  const worst = theoViolations.reduce<number | null>(
    (acc, v) => (acc === null || v.gapPerContract > acc ? v.gapPerContract : acc),
    null,
  );

  return { pairsTested, theoViolations, markViolations, worstTheoGapPerContract: worst };
}

/**
 * How many violations the route embeds in full. The counts are always exact; the
 * detail array is capped so a pathological chain cannot bloat the response.
 */
export const ARBITRAGE_DETAIL_LIMIT = 10;

/**
 * Route-shaped projection of the report.
 *
 * Emitted on EVERY `/api/options/otm-mispricing` response, not just failing
 * ones, so that `theoViolations: 0` is a measurement that was actually taken
 * rather than an absent key that reads the same as a build without the guard.
 * `pairsTested` is what distinguishes "clean surface" from "nothing to test" —
 * a thin chain scores 0 violations over 0 pairs, which is not a pass.
 */
export interface ArbitrageDiagnostic {
  pairsTested: number;
  theoViolations: number;
  markViolations: number;
  worstTheoGapPerContract: number | null;
  /** Worst-first, capped at `ARBITRAGE_DETAIL_LIMIT`. Both arms, `basis`-tagged. */
  violations: VerticalViolation[];
}

export function toArbitrageDiagnostic(report: ArbitrageReport): ArbitrageDiagnostic {
  const all = [...report.theoViolations, ...report.markViolations].sort(
    (a, b) => b.gapPerContract - a.gapPerContract,
  );
  return {
    pairsTested: report.pairsTested,
    theoViolations: report.theoViolations.length,
    markViolations: report.markViolations.length,
    worstTheoGapPerContract: report.worstTheoGapPerContract,
    violations: all.slice(0, ARBITRAGE_DETAIL_LIMIT),
  };
}
