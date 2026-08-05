// TRA-2810 / TRA-2850 (parents TRA-2536 / TRA-1929) — AUTOMATIC fee back-fill
// for the live options fee/slippage ledger.
//
// ── WHY AUTOMATIC ────────────────────────────────────────────────────────────
// Commission is the ONE calibration field the fill-time path cannot capture:
// Tradier's order-status payload carries no commission, so every ledger row is
// born `fees: null` (honest-unmeasured, TRA-1707) and stays that way until a
// broker-side join runs. TRA-1954 shipped that join behind an admin POST
// (`/api/health/live-options-fee-slippage/reconcile`) — and TWO consecutive
// real-money windows then ended `feesMeasured 0/n`, because admin-gated writes
// are effectively unreachable on bqb1 (login and pre-minted tokens both 401 on
// Render's separate user store — see the TRA-803 note in index.ts). A back-fill
// nobody can trigger is a back-fill that never runs. This module makes the pass
// self-driving: it rides the existing ET hourly scheduler tick plus a one-shot
// post-boot kick, needs no auth, and quenches itself once nothing is unmeasured.
//
// ── WHY TWO SOURCES (TRA-2850) ───────────────────────────────────────────────
// The TRA-2810 pass joined ONLY on account-history `commission` — a field that
// is 0 on every production row (Tradier bakes exchange/regulatory fees into
// cost/proceeds, it does not itemise them), over an `orderId` history does not
// carry. Three ticks ran, `totalUpdated` stayed 0, and the rows that read
// `fees: 0` were false zeros. The real fees live on `/gainloss`: a settled
// lot's `cost` is fees-included and its `proceeds` fees-net, so the ledger's
// own fill prices recover the per-leg fee. This pass now fetches BOTH: the
// commission join still runs (and only writes commissions > 0), and the
// gainloss-derived join measures everything the commission field cannot.
//
// ── INVARIANTS ───────────────────────────────────────────────────────────────
// - Observe-only: reads broker history/gainloss, never places or mutates an order.
// - Self-quenching: when no retained row has `fees: null` it returns WITHOUT a
//   broker call, so the steady state costs zero IO ('no-unmeasured').
// - Never throws: every failure lands in the state below (and a log line), so
//   the scheduler tick that hosts it cannot be starved by a broker outage.
// - Null-not-zero (TRA-1707): an unmatched row keeps `fees: null` — the joins
//   themselves enforce this; nothing here weakens it.
//
// ── READING THE STATE (the pass/fail discriminator) ─────────────────────────
// The state is published on `/api/health/live-options-fee-slippage` as
// `autoReconcile`. A HEALTHY box reads `ticks > 0` with `lastOutcome` of
// 'no-unmeasured' (quiet — nothing to do) or 'backfilled'. A box where the
// wiring never ran reads `ticks: 0` — which is exactly how the TRA-1954 route
// era looked, so the zero state is now DISTINGUISHABLE from the healthy one.
// 'no-match' means data was fetched but nothing joined; `stalled: true`
// (STALLED_AFTER_NO_MATCH consecutive no-matches) is the NON-GREEN state —
// TRA-2850's original symptom was three no-match ticks self-reporting healthy
// via `lastError: null`.

import type { TradierTradeHistoryFill, TradierGainLossLot } from '@trading-app/engine';
import {
  backfillLiveOptionFees,
  backfillLiveOptionFeesFromGainLoss,
  summarizeLiveOptionsFeeSlippage,
  historyFillSide,
} from './live-options-fee-slippage-ledger.js';
import { etDateString } from './scheduler.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'live-options-fee-reconcile' });

/**
 * TRA-2850 — consecutive 'no-match' attempts after which the pass reports
 * `stalled: true`. A reconcile that fetches data and never writes is
 * indistinguishable from a healthy quiet one unless it says so itself.
 */
export const STALLED_AFTER_NO_MATCH = 3;

/** The slice of the Tradier options client this pass needs (injectable in tests). */
export interface FeeReconcileHistoryClient {
  listAccountHistory(options: {
    start: string;
    end: string;
    limit?: number;
    type?: string;
  }): Promise<TradierTradeHistoryFill[]>;
  /** TRA-2850 — settled lots; where the real fees are (see file header). */
  listGainLoss(options: {
    start: string;
    end: string;
    limit?: number;
  }): Promise<TradierGainLossLot[]>;
}

/**
 * Outcome of one pass invocation:
 * - 'no-unmeasured' — every retained row already has a measured fee (or the
 *   ledger is empty). The quiescent/healthy end state; NO broker call was made.
 * - 'backfilled'    — data fetched, ≥1 row went `fees: null` → measured.
 * - 'no-match'      — data fetched but no unmeasured row joined. Rows stay
 *   `null` (never 0, TRA-1707); the lot may simply not have settled yet.
 *   Consecutive no-matches ≥ STALLED_AFTER_NO_MATCH flip `stalled: true`.
 * - 'no-client'     — no production Tradier options credentials resolvable (or
 *   the client factory threw). Expected on boxes without live creds.
 * - 'fetch-failed'  — BOTH broker requests threw; see `lastError`. (A partial
 *   failure keeps the surviving source's outcome and still records the error.)
 */
export type LiveOptionsFeeReconcileOutcome =
  | 'no-unmeasured'
  | 'backfilled'
  | 'no-match'
  | 'no-client'
  | 'fetch-failed';

/** Provenance for the health payload — see the file header on how to read it. */
export interface LiveOptionsFeeReconcileState {
  /** Total invocations since boot (hourly tick + boot kick). 0 ⇒ the pass NEVER ran. */
  ticks: number;
  /** Invocations that found unmeasured rows and attempted a broker fetch. */
  attempts: number;
  /** ms epoch of the last invocation (null before the first). */
  lastTickAt: number | null;
  /** ms epoch of the last fetch attempt (null when none — e.g. always quiescent). */
  lastAttemptAt: number | null;
  lastOutcome: LiveOptionsFeeReconcileOutcome | null;
  /** ET-day window of the last fetch (min unmeasured etDay → today). */
  lastWindow: { start: string; end: string } | null;
  /** History fills returned by the last successful fetch (null when none ran). */
  lastHistoryFills: number | null;
  /** TRA-2850 — settled gainloss lots returned by the last successful fetch. */
  lastGainLossLots: number | null;
  /** Rows back-filled by the last attempt, both sources (null when none ran). */
  lastUpdated: number | null;
  /** TRA-2850 — of `lastUpdated`, rows measured by the gainloss derivation. */
  lastGainLossUpdated: number | null;
  /** Rows back-filled since boot, all attempts. */
  totalUpdated: number;
  /**
   * TRA-2850 — consecutive attempts that ended 'no-match'. Reset by
   * 'backfilled' / 'no-unmeasured'; carried across 'no-client'/'fetch-failed'
   * (those attempts are not evidence either way).
   */
  consecutiveNoMatch: number;
  /**
   * TRA-2850 — THE NON-GREEN FLAG: `consecutiveNoMatch >= STALLED_AFTER_NO_MATCH`.
   * A reconcile that keeps fetching and never once writes must not read as
   * healthy-quiet. Graders key on this, not on `lastError` (which is null on a
   * clean fetch that matched nothing).
   */
  stalled: boolean;
  /** Message from the most recent failure (cleared on the next fully clean attempt). */
  lastError: string | null;
  /**
   * Up to 5 history fills from the last fetch — diagnostic for key-mismatch
   * investigation. Shows symbol, date, description (truncated), orderId, and
   * commission so caller can verify the join is seeing the right account fills.
   */
  lastHistorySample: Array<{
    symbol: string;
    date: string;
    description: string;
    orderId: number | null;
    commission: number;
  }> | null;
  /**
   * How many history fills could actually enter the commission join (tradeType
   * option, recognizable side, qty>0, commission > 0). TRA-2850: the pre-2850
   * count admitted `commission: 0` fills the join could never convert into a
   * measurement — 14 "joinable" fills that were nothing of the kind.
   */
  lastJoinableCount: number | null;
}

let state: LiveOptionsFeeReconcileState = emptyState();

function emptyState(): LiveOptionsFeeReconcileState {
  return {
    ticks: 0,
    attempts: 0,
    lastTickAt: null,
    lastAttemptAt: null,
    lastOutcome: null,
    lastWindow: null,
    lastHistoryFills: null,
    lastGainLossLots: null,
    lastUpdated: null,
    lastGainLossUpdated: null,
    totalUpdated: 0,
    consecutiveNoMatch: 0,
    stalled: false,
    lastError: null,
    lastHistorySample: null,
    lastJoinableCount: null,
  };
}

/** Test seam — reset the provenance between cases. */
export function clearLiveOptionsFeeReconcileState(): void {
  state = emptyState();
}

/** Snapshot for the health payload (a copy — callers cannot mutate the pass). */
export function getLiveOptionsFeeReconcileState(): LiveOptionsFeeReconcileState {
  return {
    ...state,
    lastWindow: state.lastWindow === null ? null : { ...state.lastWindow },
    lastHistorySample: state.lastHistorySample === null ? null : state.lastHistorySample.map((s) => ({ ...s })),
  };
}

/**
 * Run one fee back-fill pass: if any retained ledger row is `fees: null`, fetch
 * Tradier account-history AND the settled gain/loss report over
 * [min unmeasured etDay, today ET], then back-fill via the commission join
 * (positive commissions only) and the gainloss derivation (TRA-2850). Both
 * writers rewrite the durable JSONL so the fees survive a redeploy.
 * `buildClient` is invoked ONLY when there is something to measure, so the
 * quiescent path costs no settings read and no broker call. Never throws — see
 * the file header.
 */
export async function runLiveOptionsFeeReconcile(
  buildClient: () => Promise<FeeReconcileHistoryClient | null>,
  now: number = Date.now(),
): Promise<LiveOptionsFeeReconcileState> {
  state.ticks += 1;
  state.lastTickAt = now;

  const unmeasured = summarizeLiveOptionsFeeSlippage().records.filter((r) => r.fees === null);
  if (unmeasured.length === 0) {
    state.lastOutcome = 'no-unmeasured';
    state.consecutiveNoMatch = 0;
    state.stalled = false;
    return getLiveOptionsFeeReconcileState();
  }

  state.attempts += 1;
  state.lastAttemptAt = now;

  let client: FeeReconcileHistoryClient | null = null;
  try {
    client = await buildClient();
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    client = null;
  }
  if (client === null) {
    state.lastOutcome = 'no-client';
    log.warn('live-options fee reconcile: no production client — rows stay unmeasured', {
      unmeasured: unmeasured.length,
      reason: state.lastError,
    });
    return getLiveOptionsFeeReconcileState();
  }

  // Window: earliest unmeasured fill day → today. History events / lot settlements
  // can post later than the fill's own day, so the end is always "now", not the max
  // etDay. The ledger retains 30 days, which bounds the window. The same window
  // works for /gainloss (it filters on close date, and any lot covering an
  // unmeasured row closes on or after that row's etDay).
  let start = unmeasured[0]!.etDay;
  for (const r of unmeasured) if (r.etDay < start) start = r.etDay;
  const today = etDateString(new Date(now));
  const end = today >= start ? today : start;
  state.lastWindow = { start, end };

  // Fetch the two sources INDEPENDENTLY — the gainloss derivation is the one that
  // measures real production fees (TRA-2850), so a history outage must not stop it.
  let historyFills: TradierTradeHistoryFill[] | null = null;
  let historyError: string | null = null;
  try {
    historyFills = await client.listAccountHistory({ start, end, type: 'trade', limit: 2000 });
  } catch (err) {
    historyError = err instanceof Error ? err.message : String(err);
  }
  let lots: TradierGainLossLot[] | null = null;
  let gainLossError: string | null = null;
  try {
    lots = await client.listGainLoss({ start, end, limit: 2000 });
  } catch (err) {
    gainLossError = err instanceof Error ? err.message : String(err);
  }

  if (historyFills === null && lots === null) {
    state.lastOutcome = 'fetch-failed';
    state.lastError = `history: ${historyError} | gainloss: ${gainLossError}`;
    log.warn('live-options fee reconcile: both broker fetches failed', {
      start,
      end,
      historyError,
      gainLossError,
    });
    return getLiveOptionsFeeReconcileState();
  }

  let updated = 0;
  let gainLossUpdated = 0;
  if (historyFills !== null) {
    updated += backfillLiveOptionFees(historyFills).updated;
    state.lastHistoryFills = historyFills.length;
    // Mirror the join's ACTUAL eligibility (incl. commission > 0) — a diagnostic
    // that counts fills the join is required to skip advertises progress that
    // cannot happen (the TRA-2850 "14 joinable, 0 updated forever" shape).
    state.lastJoinableCount = historyFills.filter(
      (f) => f.tradeType === 'option'
        && historyFillSide(f.description, f.amount) !== null
        && typeof f.quantity === 'number' && Number.isFinite(f.quantity) && f.quantity > 0
        && typeof f.commission === 'number' && Number.isFinite(f.commission) && f.commission > 0,
    ).length;
    // Take up to 5 fills from the raw array BEFORE the join filters them —
    // include fills regardless of tradeType/side so we can diagnose filter drops.
    state.lastHistorySample = historyFills.slice(0, 5).map((f) => ({
      symbol: f.symbol,
      date: f.date,
      description: f.description.slice(0, 80), // truncate long descriptions
      orderId: f.orderId,
      commission: f.commission,
    }));
  }
  if (lots !== null) {
    gainLossUpdated = backfillLiveOptionFeesFromGainLoss(lots).updated;
    updated += gainLossUpdated;
    state.lastGainLossLots = lots.length;
  }

  state.lastUpdated = updated;
  state.lastGainLossUpdated = lots !== null ? gainLossUpdated : null;
  state.totalUpdated += updated;
  state.lastOutcome = updated > 0 ? 'backfilled' : 'no-match';
  state.consecutiveNoMatch = updated > 0 ? 0 : state.consecutiveNoMatch + 1;
  state.stalled = state.consecutiveNoMatch >= STALLED_AFTER_NO_MATCH;
  // A partial fetch failure is still a failure — record it even when the other
  // source produced an outcome, so the state never self-reports cleaner than it ran.
  state.lastError = historyError ?? gainLossError ?? null;
  const summary = summarizeLiveOptionsFeeSlippage();
  const logFields = {
    outcome: state.lastOutcome,
    window: { start, end },
    historyFills: historyFills?.length ?? null,
    gainLossLots: lots?.length ?? null,
    updated,
    gainLossUpdated: state.lastGainLossUpdated,
    feesMeasured: summary.feesMeasured,
    n: summary.n,
    totalFees: summary.totalFees,
    consecutiveNoMatch: state.consecutiveNoMatch,
    partialFetchError: state.lastError,
  };
  if (state.stalled) {
    log.warn('live-options fee reconcile STALLED — repeated no-match, nothing ever written (TRA-2850)', logFields);
  } else {
    log.info('live-options fee reconcile pass complete (TRA-2810/TRA-2850)', logFields);
  }
  return getLiveOptionsFeeReconcileState();
}
