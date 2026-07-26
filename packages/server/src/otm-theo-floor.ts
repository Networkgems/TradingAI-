/**
 * TRA-2341 — denominator guard for the read-only OTM mispricing panel.
 *
 * ## The defect
 *
 * `findMispricedOtmContracts` reports `mispricingPct = (mark − theo) / theo`
 * (`otm-mispricing.ts:229`). Far OTM, Black-Scholes `theo` decays toward zero
 * far faster than the market's bid, which stays pinned near a penny by the
 * minimum tick and lottery-ticket demand. Live on 2026-07-25, SPY 738.93,
 * 2026-08-31 expiry: `SPY260831P00420000` marked 0.095 against a theo of
 * 0.000128 — a ratio of 741, rendered as **+74215.7%**. Because the scanner
 * ranks by `|mispricingPct|` descending, those artifacts crowd out every
 * genuinely interesting contract: SPY's default panel was 15 of 15 such rows.
 *
 * The scanner's existing guards are all on the WRONG SIDE of the ratio:
 *   • `minMark: 0.05` (`:97`) floors the NUMERATOR. Its own docstring says
 *     "penny-quoted far-OTM strikes have unstable mispricing ratios" — but
 *     every artifact row clears it comfortably (marks 0.095–0.215).
 *   • `theo <= 0` (`:211`) is the only DENOMINATOR guard, and it does not fire
 *     at theo = 1.28e-4.
 *   • `minAbsDelta` (TRA-1407) would catch all 15, but defaults to 0.
 *
 * ## Why this lives in the server route and not in the engine
 *
 * `findMispricedOtmContracts` is shared: the `single_leg_otm` sleeve reaches it
 * through `rvScanner.scanOtm()` **in-process** (`signal-engine.ts:7267`), which
 * is a different call site from the HTTP route. Changing the engine `DEFAULTS`
 * — a theo floor or a delta floor — would be a live trading-logic change to
 * that sleeve, and TRA-1407 is explicit that its floor is board-tuned and
 * passed by callers only when the OTM delta-floor flag is on. Filtering here,
 * in the route projection, is structurally incapable of altering a sleeve
 * decision: the sleeve never calls this function. Engine behaviour is
 * bit-identical.
 *
 * The engine-side fix (option 2 on the ticket — replacing `theo <= 0` with a
 * real floor, or clamping the reported ratio) is deliberately NOT done here.
 * It needs the OTM sleeve owner, and it is tracked separately.
 *
 * ## Never silent
 *
 * A filter that just drops rows turns "15 artifacts" into "nothing found",
 * which reads identically to a thin chain. So this returns the suppressed
 * COUNT and the largest suppressed ratio, and the route echoes the applied
 * floor. Callers render it as a footnote. `?minTheo=0` restores the raw,
 * pre-TRA-2341 projection for debugging — and the echoed `floor` doubles as a
 * deploy detector, since a build without this guard omits the block entirely.
 */

/**
 * Dollar floor on `theo` applied by `/api/options/otm-mispricing` unless the
 * caller overrides it.
 *
 * $0.01 is one minimum tick. Below it the model is saying the contract is
 * worth less than the smallest price at which it can trade, so the ratio is
 * reporting the tick size, not a disagreement with the vol surface. It clears
 * all 15 SPY artifact rows (max suppressed theo ~0.008) while leaving every
 * NVDA / AAPL / QQQ / MSFT / AMD / IWM row on the panel untouched — those read
 * -27.3% to +14.9% off theos comparable in magnitude to their marks.
 */
export const OTM_PANEL_THEO_FLOOR = 0.01;

/** The subset of `OtmMispricingCandidate` this guard reads. */
export interface TheoFloorCandidate {
  theo: number;
  mispricingPct: number;
}

export interface TheoFloorResult<T extends TheoFloorCandidate> {
  /** Candidates at or above the floor, in the order they arrived (rank order). */
  kept: T[];
  /** The floor actually applied. 0 ⇒ disabled, every candidate kept. */
  floor: number;
  /** How many candidates the floor removed. Rendered, never swallowed. */
  suppressed: number;
  /**
   * Largest `|mispricingPct|` among the suppressed rows, so the footnote can
   * say HOW absurd the discarded reads were. `null` when nothing was dropped.
   */
  maxSuppressedMispricingPct: number | null;
}

/**
 * Drop candidates whose theo is below `floor`, reporting what was dropped.
 *
 * A non-finite or non-positive `floor` disables the guard (everything is kept,
 * `floor` reported as 0) — that is the explicit `?minTheo=0` escape hatch, and
 * it also means a garbage query string degrades to the legacy projection
 * rather than to an empty table.
 *
 * Rank order is preserved: the caller slices to `limit` AFTER this runs, which
 * is the whole point. Filtering after the slice would leave the artifacts
 * occupying the top N and merely blank the table.
 */
export function applyTheoFloor<T extends TheoFloorCandidate>(
  candidates: readonly T[],
  floor: number,
): TheoFloorResult<T> {
  if (!Number.isFinite(floor) || floor <= 0) {
    return { kept: [...candidates], floor: 0, suppressed: 0, maxSuppressedMispricingPct: null };
  }

  const kept: T[] = [];
  let suppressed = 0;
  let maxSuppressed: number | null = null;

  for (const c of candidates) {
    // Fail closed on a non-finite theo: an un-priced contract has no meaningful
    // ratio at all, so it belongs on the suppressed side of a denominator guard.
    if (Number.isFinite(c.theo) && c.theo >= floor) {
      kept.push(c);
      continue;
    }
    suppressed += 1;
    const abs = Math.abs(c.mispricingPct);
    if (Number.isFinite(abs) && (maxSuppressed === null || abs > maxSuppressed)) {
      maxSuppressed = abs;
    }
  }

  return { kept, floor, suppressed, maxSuppressedMispricingPct: maxSuppressed };
}
