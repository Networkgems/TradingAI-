// TRA-2810 (parents TRA-2536 / TRA-1929) — AUTOMATIC fee back-fill for the live
// options fee/slippage ledger.
//
// ── WHY AUTOMATIC ────────────────────────────────────────────────────────────
// Commission is the ONE calibration field the fill-time path cannot capture:
// Tradier's order-status payload carries no commission, so every ledger row is
// born `fees: null` (honest-unmeasured, TRA-1707) and stays that way until an
// account-HISTORY join runs. TRA-1954 shipped that join behind an admin POST
// (`/api/health/live-options-fee-slippage/reconcile`) — and TWO consecutive
// real-money windows then ended `feesMeasured 0/n`, because admin-gated writes
// are effectively unreachable on bqb1 (login and pre-minted tokens both 401 on
// Render's separate user store — see the TRA-803 note in index.ts). A back-fill
// nobody can trigger is a back-fill that never runs. This module makes the pass
// self-driving: it rides the existing ET hourly scheduler tick plus a one-shot
// post-boot kick, needs no auth, and quenches itself once nothing is unmeasured.
//
// ── INVARIANTS ───────────────────────────────────────────────────────────────
// - Observe-only: reads broker history, never places or mutates an order.
// - Self-quenching: when no retained row has `fees: null` it returns WITHOUT a
//   broker call, so the steady state costs zero IO ('no-unmeasured').
// - Never throws: every failure lands in the state below (and a log line), so
//   the scheduler tick that hosts it cannot be starved by a broker outage.
// - Null-not-zero (TRA-1707): an unmatched row keeps `fees: null` — the join
//   itself (`reconcileLedgerFees`) enforces this; nothing here weakens it.
//
// ── READING THE STATE (the pass/fail discriminator) ─────────────────────────
// The state is published on `/api/health/live-options-fee-slippage` as
// `autoReconcile`. A HEALTHY box reads `ticks > 0` with `lastOutcome` of
// 'no-unmeasured' (quiet — nothing to do) or 'backfilled'. A box where the
// wiring never ran reads `ticks: 0` — which is exactly how the TRA-1954 route
// era looked, so the zero state is now DISTINGUISHABLE from the healthy one.
// 'no-match' with attempts climbing means history was fetched but nothing
// joined — the rows are honestly unmeasured and someone should look at why.

import type { TradierTradeHistoryFill } from '@trading-app/engine';
import {
  backfillLiveOptionFees,
  summarizeLiveOptionsFeeSlippage,
} from './live-options-fee-slippage-ledger.js';
import { etDateString } from './scheduler.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'live-options-fee-reconcile' });

/** The one slice of the Tradier options client this pass needs (injectable in tests). */
export interface FeeReconcileHistoryClient {
  listAccountHistory(options: {
    start: string;
    end: string;
    limit?: number;
    type?: string;
  }): Promise<TradierTradeHistoryFill[]>;
}

/**
 * Outcome of one pass invocation:
 * - 'no-unmeasured' — every retained row already has a measured fee (or the
 *   ledger is empty). The quiescent/healthy end state; NO broker call was made.
 * - 'backfilled'    — history fetched, ≥1 row went `fees: null` → measured.
 * - 'no-match'      — history fetched but no unmeasured row joined. Rows stay
 *   `null` (never 0, TRA-1707); commission may simply not have posted yet.
 * - 'no-client'     — no production Tradier options credentials resolvable (or
 *   the client factory threw). Expected on boxes without live creds.
 * - 'fetch-failed'  — the account-history request threw; see `lastError`.
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
  /** ET-day window of the last history fetch (min unmeasured etDay → today). */
  lastWindow: { start: string; end: string } | null;
  /** History fills returned by the last successful fetch (null when none ran). */
  lastHistoryFills: number | null;
  /** Rows back-filled by the last fetch (null when none ran). */
  lastUpdated: number | null;
  /** Rows back-filled since boot, all attempts. */
  totalUpdated: number;
  /** Message from the most recent failure (cleared on the next clean attempt). */
  lastError: string | null;
  /**
   * Up to 5 history fills from the last fetch — diagnostic for key-mismatch
   * investigation. Shows symbol, date, side (from description), orderId, and
   * commission so caller can verify the join is seeing the right account fills.
   */
  lastHistorySample: Array<{
    symbol: string;
    date: string;
    description: string;
    orderId: number | null;
    commission: number;
  }> | null;
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
    lastUpdated: null,
    totalUpdated: 0,
    lastError: null,
    lastHistorySample: null,
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
    lastHistorySample: state.lastHistorySample === null ? null : [...state.lastHistorySample],
  };
}

/**
 * Run one fee back-fill pass: if any retained ledger row is `fees: null`, fetch
 * Tradier account-history over [min unmeasured etDay, today ET] and join
 * commission on via {@link backfillLiveOptionFees} (which also rewrites the
 * durable JSONL so the fees survive a redeploy). `buildClient` is invoked ONLY
 * when there is something to measure, so the quiescent path costs no settings
 * read and no broker call. Never throws — see the file header.
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

  // Window: earliest unmeasured fill day → today. History events can post later
  // than the fill's own day, so the end is always "now", not the max etDay. The
  // ledger retains 30 days, which bounds the window.
  let start = unmeasured[0]!.etDay;
  for (const r of unmeasured) if (r.etDay < start) start = r.etDay;
  const today = etDateString(new Date(now));
  const end = today >= start ? today : start;
  state.lastWindow = { start, end };

  let historyFills: TradierTradeHistoryFill[];
  try {
    historyFills = await client.listAccountHistory({ start, end, type: 'trade', limit: 2000 });
  } catch (err) {
    state.lastOutcome = 'fetch-failed';
    state.lastError = err instanceof Error ? err.message : String(err);
    log.warn('live-options fee reconcile: history fetch failed', {
      start,
      end,
      reason: state.lastError,
    });
    return getLiveOptionsFeeReconcileState();
  }

  const { updated } = backfillLiveOptionFees(historyFills);
  state.lastHistoryFills = historyFills.length;
  state.lastUpdated = updated;
  state.lastHistorySample = historyFills.slice(0, 5).map((f) => ({
    symbol: f.symbol,
    date: f.date,
    description: f.description,
    orderId: f.orderId,
    commission: f.commission,
  }));
  state.totalUpdated += updated;
  state.lastOutcome = updated > 0 ? 'backfilled' : 'no-match';
  state.lastError = null;
  const summary = summarizeLiveOptionsFeeSlippage();
  log.info('live-options fee reconcile pass complete (TRA-2810)', {
    outcome: state.lastOutcome,
    window: { start, end },
    historyFills: historyFills.length,
    updated,
    feesMeasured: summary.feesMeasured,
    n: summary.n,
    totalFees: summary.totalFees,
  });
  return getLiveOptionsFeeReconcileState();
}
