// TRA-4282 — derived exit-risk state for an open option row, shared by the
// StockOptionsPanel cells and the open-table sort. Two questions the table
// previously could not answer with any planted value of the row:
//
//  1. Is the stop BREACHED (engine basis), or merely set? The old Trail/SL cell
//     rendered red whenever a stop existed, so red carried no information.
//  2. Is the engine's auto-exit LATCHED (`closeRejectCount` at the cap, no new
//     sell_to_close staged), and if so, when — if ever — does it release?
import type { OptionPosition } from '@trading-app/shared';

/**
 * Mirror of the engine's `MAX_CONSECUTIVE_CLOSE_REJECTS`
 * (packages/server/src/options-account.ts). Deliberately NOT hoisted into
 * @trading-app/shared: packages/shared ships in the bqb1 server build, which is
 * under a live deploy hold (ops/deploy-hold.json), and a UI label is not worth
 * widening that hold's blast radius. If the engine cap moves, this renders the
 * true count over a stale cap — the count is the datum, the cap is context.
 */
export const MAX_CONSECUTIVE_CLOSE_REJECTS = 3;

/** Engine's `isArmedThreshold`: `0` / absent / non-finite means "no threshold". */
function armed(value: number | undefined | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export type StopBreachState = 'none' | 'set' | 'breached';

/**
 * Grades the stop the way `checkExits` does: against `currentPremium` (the NBBO
 * mid), NOT the broker-tape last trade the Current Mark cell displays — a stale
 * print must neither paint nor hide a breach the engine can't see (TRA-2890).
 * A dark feed (`currentPremium` absent/0/NaN) grades `set`, never `breached`:
 * no reading is not a low reading.
 */
export function stopBreachState(o: OptionPosition): StopBreachState {
  const stop = o.trailingActive && armed(o.trailingStopPremium)
    ? o.trailingStopPremium
    : o.stopLossPremium;
  if (!armed(stop)) return 'none';
  if (armed(o.currentPremium) && o.currentPremium <= stop) return 'breached';
  return 'set';
}

export interface CloseRejectLatch {
  /** `closeRejectCount` as persisted — the datum. */
  count: number;
  /** The engine cap (mirrored above) — the context for rendering `3/3`. */
  max: number;
  /**
   * TRA-4266's half-open release instant (`closeRejectProbeNotBeforeMs`), when
   * the serving build has stamped one. Absent ⇒ the latch is indefinite: it
   * releases only on a fill or a manual re-stage.
   */
  probeNotBeforeMs?: number;
}

/**
 * Non-null iff the engine has stopped staging exit orders for this row
 * (`options-account.ts` skips submission once the counter reaches the cap).
 */
export function closeRejectLatch(o: OptionPosition): CloseRejectLatch | null {
  const count = o.closeRejectCount;
  if (typeof count !== 'number' || !Number.isFinite(count) || count < MAX_CONSECUTIVE_CLOSE_REJECTS) {
    return null;
  }
  return {
    count,
    max: MAX_CONSECUTIVE_CLOSE_REJECTS,
    probeNotBeforeMs: armed(o.closeRejectProbeNotBeforeMs) ? o.closeRejectProbeNotBeforeMs : undefined,
  };
}
