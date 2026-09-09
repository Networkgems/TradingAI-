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
//
// ── WHY A ROSTER, NOT ONE CLIENT (TRA-4295) ─────────────────────────────────
// The ledger is process-global and holds fills from EVERY live book, but until
// TRA-4295 the pass fetched exactly one Tradier account — the pinned operator's.
// The moment a second book (`v0nni`) started trading, its lots settled in an
// account the pass never queried: every one of its groups rejected 'no-lot'
// forever, `consecutiveNoMatch` climbed monotonically (7 by 2026-09-01, spanning
// process restarts), and its rows aged toward permanently-unmeasured while the
// operator's own lots kept fetching fine. The pass now takes the full production
// account roster: history is fetched and imported PER ACCOUNT (an imported row's
// `book` stamp is exactly as attributable as the account it came from,
// TRA-3977), and the gainloss join runs ONCE over the UNION of every account's
// lots — each (symbol, day, side) group's lots live in exactly one account, so
// the union finds them wherever they settled, including for legacy `book: null`
// rows that predate attribution.

import type { TradierTradeHistoryFill, TradierGainLossLot } from '@trading-app/engine';
import {
  backfillLiveOptionFees,
  backfillLiveOptionFeesFromGainLoss,
  importMissingLiveOptionFills,
  ledgerCoverageAgainstHistory,
  repriceImportedLiveOptionFills,
  summarizeLiveOptionsFeeSlippage,
  historyFillSide,
  type GainLossPrefixRepair,
  type GainLossWashRepair,
  type ImportedPriceRepair,
  type GainLossRejection,
  type GainLossRejectionReason,
  type LedgerCoverageResult,
  type LiveOptionFillRecord,
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

/**
 * TRA-2959 — calendar days after which an unmeasured row stops counting as
 * ACTIONABLE (and stops feeding the `stalled` alarm). Rationale: a fee becomes
 * derivable when its lot settles into `/gainloss` — T+1 settlement plus
 * Tradier's reporting lag, observed at 2–4 calendar days on the live account.
 * 7 days is comfortably past that: a row still unmeasured after 7 days is not
 * "pending settlement", it is UNMEASURABLE from this account (the concrete
 * population: fills predating the TRA-2847 account migration, whose lots live
 * on the OLD account and can never appear in this one's gainloss). Those rows
 * are reported as `unmeasuredAged` — a named exclusion with a count — instead
 * of holding `stalled: true` forever and training readers to ignore it.
 * The alarm still has teeth: a real join defect keeps its rows inside the
 * 7-day window for 7 days of hourly ticks, far past STALLED_AFTER_NO_MATCH.
 */
export const FEE_MEASURABLE_HORIZON_DAYS = 7;

/**
 * TRA-3558 — how many RAW gainloss lots the state republishes. The commission
 * join has had `lastHistorySample` since TRA-2850; the gainloss join — the one
 * that measures every production fee — had only a bare `lastGainLossLots` count,
 * so a 'no-match' could not distinguish a lot that never came back from the
 * broker from one that came back MIS-KEYED. The cap is generous relative to the
 * observed lot volume (22 on the 2026-08-13 live read) precisely so the sample is
 * usable as a PRESENCE test: `lastGainLossLots <= this` ⇒ the sample is the whole
 * fetch, and a symbol absent from it is absent from the broker payload, full stop.
 */
export const GAINLOSS_SAMPLE_MAX = 40;

/** TRA-3558 — how many named group rejections the state republishes (newest ET day first). */
export const GAINLOSS_REJECTION_MAX = 25;

/**
 * TRA-4143 — how many same-day round-trip lots the state republishes. Observed
 * volume is 0–1 per window (one confirmed instance in 4 weeks of live trading),
 * so the cap sits far above it: `lastPdtDayTradeCount <= this` ⇒ the sample is
 * the whole detection, same presence-test reasoning as {@link GAINLOSS_SAMPLE_MAX}.
 */
export const PDT_DAY_TRADE_SAMPLE_MAX = 10;

/**
 * TRA-3563 — how many RAW history fills the state republishes. The old cap of 5
 * against 37 observed fills was a SPOT CHECK, not a presence test: diagnosing
 * TRA-3563 needed the executions of one 2026-08-04 group and the sample held
 * only the five newest, so the prices that decided the defect were unreadable
 * from the route entirely. Same reasoning as {@link GAINLOSS_SAMPLE_MAX}: sit
 * the cap ABOVE the observed volume, so `lastHistoryFills <= this` means the
 * sample IS the fetch. The sample now also carries `price`/`quantity` — the two
 * fields the import attribution runs on, and without which "which execution did
 * this row's price come from" cannot be answered.
 */
export const HISTORY_SAMPLE_MAX = 60;

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
 * TRA-4295 — one production account the pass reconciles against. `book` is the
 * operator/book username whose creds resolve `client` (the TRA-3977 stamp every
 * `history_import` row minted from that account's history carries). The factory
 * may still return a bare {@link FeeReconcileHistoryClient} — it is treated as
 * a one-account roster under the legacy `book` argument.
 */
export interface FeeReconcileAccount {
  book: string | null;
  client: FeeReconcileHistoryClient;
}

/** What the client factory may resolve — see {@link FeeReconcileAccount}. */
export type FeeReconcileClients = FeeReconcileHistoryClient | FeeReconcileAccount[] | null;

/**
 * Outcome of one pass invocation:
 * - 'no-unmeasured' — every retained row already has a measured fee (or the
 *   ledger is empty). The quiescent/healthy end state; NO broker call was made.
 * - 'backfilled'    — data fetched, ≥1 row went `fees: null` → measured.
 * - 'no-match'      — data fetched but no unmeasured ACTIONABLE row joined.
 *   Rows stay `null` (never 0, TRA-1707); the lot may simply not have settled
 *   yet. Consecutive no-matches ≥ STALLED_AFTER_NO_MATCH flip `stalled: true`.
 * - 'no-actionable' — TRA-2959: data fetched, nothing joined, and every
 *   unmeasured row is either past FEE_MEASURABLE_HORIZON_DAYS (see
 *   `unmeasuredAged` — e.g. pre-account-migration fills whose lots this
 *   account will never report) or an open leg whose position has not closed
 *   yet (`unmeasuredAwaitingClose` — no lot EXISTS to derive from). Not
 *   evidence of a stall: does not feed `consecutiveNoMatch`.
 * - 'residue'       — TRA-4408: data fetched, nothing joined, and every
 *   actionable unmeasured row belongs to a group whose rejection is
 *   DETERMINISTIC and IDENTICAL to the previous attempt's (same reason, same
 *   operands — re-running the same arithmetic on the same inputs). Not
 *   evidence of a stall: does not feed `consecutiveNoMatch`. Before this
 *   outcome existed, 5 permanently-rejecting rows pinned `stalled: true`
 *   forever — the alarm's own false-positive mode.
 * - 'no-client'     — no production Tradier options credentials resolvable for
 *   ANY account (or the client factory threw). Expected on boxes without live
 *   creds.
 * - 'fetch-failed'  — EVERY broker request on EVERY account threw; see
 *   `lastError`. (A partial failure keeps the surviving fetches' outcome and
 *   still records every error, per account.)
 */
export type LiveOptionsFeeReconcileOutcome =
  | 'no-unmeasured'
  | 'backfilled'
  | 'no-match'
  | 'no-actionable'
  | 'residue'
  | 'no-client'
  | 'fetch-failed';

/**
 * TRA-4408 — the rejection reasons that are DETERMINISTIC given their inputs:
 * lots and rows are both present and the join's own arithmetic refused them
 * ('above-bound' / 'negative-fee' — a basis artifact; 'qty-mismatch' — totals
 * that do not reconcile). When one of these repeats with identical operands on
 * the next attempt, re-attempting is not evidence of a stall — the exact same
 * refusal is guaranteed. 'no-lot' is deliberately EXCLUDED: an absent lot
 * looks identical whether it is pending settlement or permanently missing,
 * and the TRA-4295 incident (v0nni's account never fetched) was a no-lot
 * streak — the one shape `stalled` must always catch. 'priceless-row' is
 * excluded because the reprice pass can heal it between attempts.
 */
const DETERMINISTIC_REJECTION_REASONS: ReadonlySet<GainLossRejectionReason> = new Set([
  'above-bound',
  'negative-fee',
  'qty-mismatch',
]);

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
  /** History fills returned by the last successful fetch, ALL accounts (null when none ran). */
  lastHistoryFills: number | null;
  /** TRA-2850 — settled gainloss lots returned by the last successful fetch, ALL accounts. */
  lastGainLossLots: number | null;
  /**
   * TRA-4295 — per-account fetch provenance for the last attempt. The scalars
   * above fold over every account; this is the only surface that can say WHICH
   * account a fetch (or a failure) belongs to — the exact question the v0nni
   * stall was undiagnosable without. Null before the first attempt.
   */
  lastAccounts: Array<{
    book: string | null;
    historyFills: number | null;
    gainLossLots: number | null;
    historyError: string | null;
    gainLossError: string | null;
    coverage: LedgerCoverageResult | null;
  }> | null;
  /**
   * TRA-3558 — RAW settled lots from the last gainloss fetch, PRE-filter and
   * PRE-join, capped at {@link GAINLOSS_SAMPLE_MAX}. The counterpart of
   * `lastHistorySample` for the join that does the real work. Read it together
   * with `lastGainLossRejections`: a group rejected `no-lot` whose symbol does
   * NOT appear here was never fetched; one whose symbol DOES appear here is
   * mis-keyed, and the lot dates/quantity printed here say on which field.
   * Truncated iff `lastGainLossLots > GAINLOSS_SAMPLE_MAX`. `book` (TRA-4295)
   * names the account the lot was fetched from.
   */
  lastGainLossSample: Array<{
    symbol: string;
    quantity: number;
    cost: number;
    proceeds: number;
    openDate: string;
    closeDate: string;
    book: string | null;
  }> | null;
  /**
   * TRA-3558 — WHICH test rejected each still-unmeasured (symbol, day, side)
   * group, with the two numbers that decided it. A bare 'no-match' trains
   * readers to ignore it (the same failure shape TRA-2819 ask 4B was filed
   * about); this names the branch. Newest ET day first, capped at
   * {@link GAINLOSS_REJECTION_MAX} — the counts below are NOT capped.
   */
  lastGainLossRejections: GainLossRejection[] | null;
  /**
   * TRA-3558 — histogram of EVERY rejection this pass produced, by reason.
   * Survives the sample cap, so the shape of a stall is readable even when the
   * per-group list is truncated. Null until a gainloss fetch has run.
   */
  lastGainLossRejectionCounts: Record<GainLossRejectionReason, number> | null;
  /**
   * TRA-3558 — lots the last pass re-keyed off a TRUNCATED broker symbol. A
   * symbol rewrite inside the path that writes real money numbers must be
   * VISIBLE, not just correct: each entry names the short symbol the broker
   * sent and the full ledger symbol it was uniquely resolved to. Empty array =
   * the payload was clean; null = no gainloss fetch has run.
   */
  lastGainLossPrefixRepairs: GainLossPrefixRepair[] | null;
  /**
   * TRA-4408 — open-side groups whose fee was recovered from under a
   * wash-sale-adjusted `/gainloss` cost basis on the last pass. A fee written
   * off an inferred broker adjustment must be visible: each entry carries the
   * raw derivation the bound rejected, the loss subtracted, and the loss
   * lot(s)' close day(s). Empty = no adjusted lots; null = no gainloss fetch
   * has run.
   */
  lastGainLossWashRepairs: GainLossWashRepair[] | null;
  /**
   * TRA-4143 — same-day live round trips (PDT day trades) in the last gainloss
   * fetch, per the BROKER'S OWN lot attribution: a settled `/gainloss` lot whose
   * `openDate` equals its `closeDate`. This is the ONE discriminator the
   * fabricated `history_import` timestamps cannot poison: an `etDay`-keyed join
   * over the ledger both manufactures false pairs (the 08-24 RIG artefact — an
   * engine close of a PRIOR lot colliding with a same-day imported open) and
   * cannot confirm true ones, because all import rows carry a synthesised
   * constant `17:00:00.000Z`. The broker pairs open to close per LOT, so
   * `openDate === closeDate` is a day trade by construction — no join heuristics.
   *
   * Why here: `holdLiveOptionsOvernightForPdt` suppresses ENGINE-fired same-day
   * exits only (options-account.ts, mode 'live' + same-date-key). The confirmed
   * 2026-08-04 PLTR260911C00170000 round trip (term 0 at the broker, verified
   * against trade-dated `/history` on 2026-09-01) was closed OUT-OF-BAND — the
   * close reached the ledger via `history_import`, a path the gate structurally
   * never sees. Detection therefore rides the pass that already reads the
   * broker's lot report; the fetch window covers the measurable horizon
   * (FEE_MEASURABLE_HORIZON_DAYS = 7 days ≥ the 5-business-day PDT window).
   *
   * `null` until a gainloss fetch has run — an unfetched detector must never
   * read as a measured zero. `[]`/`0` after a fetch IS a measured zero.
   * Count is NOT capped; the lot list caps at {@link PDT_DAY_TRADE_SAMPLE_MAX}.
   */
  lastPdtDayTradeLots: Array<{
    symbol: string;
    quantity: number;
    cost: number;
    proceeds: number;
    openDate: string;
    closeDate: string;
    /** TRA-4295 — the account the lot settled in (PDT is enforced per account). */
    book: string | null;
  }> | null;
  /** TRA-4143 — count over the WHOLE fetch (never capped); null until a gainloss fetch has run. */
  lastPdtDayTradeCount: number | null;
  /** Rows back-filled by the last attempt, both sources (null when none ran). */
  lastUpdated: number | null;
  /** TRA-2850 — of `lastUpdated`, rows measured by the gainloss derivation. */
  lastGainLossUpdated: number | null;
  /** Rows back-filled since boot, all attempts. */
  totalUpdated: number;
  /**
   * TRA-2850 — consecutive attempts that ended 'no-match'. Reset by
   * 'backfilled' / 'no-unmeasured' / 'no-actionable' / 'residue' (TRA-4408 —
   * a fully-explained pass is a complete read, not stall evidence); carried
   * across 'no-client'/'fetch-failed' (those attempts are not evidence either
   * way).
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
   * History fills from the last fetch, PRE-filter — diagnostic for key-mismatch
   * investigation and (TRA-3563) for the import price attribution. Shows symbol,
   * date, description (truncated), orderId, commission, and the `price`/
   * `quantity` the attribution runs on. Capped at {@link HISTORY_SAMPLE_MAX};
   * truncated iff `lastHistoryFills > HISTORY_SAMPLE_MAX`.
   */
  lastHistorySample: Array<{
    symbol: string;
    date: string;
    description: string;
    orderId: number | null;
    commission: number;
    price: number;
    quantity: number;
    /** TRA-4295 — the account the fill was fetched from. */
    book: string | null;
  }> | null;
  /**
   * How many history fills could actually enter the commission join (tradeType
   * option, recognizable side, qty>0, commission > 0). TRA-2850: the pre-2850
   * count admitted `commission: 0` fills the join could never convert into a
   * measurement — 14 "joinable" fills that were nothing of the kind.
   */
  lastJoinableCount: number | null;
  /**
   * TRA-2959 — the unmeasured set, PARTITIONED so a reader can tell "work in
   * flight" from "permanently unmeasurable" from "no lot exists yet":
   * - actionable: closes (or opens of closed positions) within
   *   FEE_MEASURABLE_HORIZON_DAYS — these SHOULD measure; only they feed
   *   `consecutiveNoMatch`/`stalled`.
   * - awaitingClose: open legs whose position has no recorded close — no
   *   settled lot can exist for them yet, whatever their age.
   * - aged: past the horizon — named unmeasurable exclusion (the concrete
   *   population: fills predating the account migration).
   * TRA-4408 adds a fourth bucket carved OUT of actionable:
   * - residue: rows whose group was rejected for a DETERMINISTIC reason with
   *   operands identical to the previous attempt's — re-attempting cannot
   *   measure them, so they must not feed `consecutiveNoMatch`/`stalled`
   *   either. Named and counted, never silent.
   */
  unmeasuredTotal: number;
  unmeasuredActionable: number;
  unmeasuredAwaitingClose: number;
  unmeasuredAged: number;
  /** TRA-4408 — see the partition note above; rows in deterministically-rejected groups. */
  unmeasuredResidue: number;
  /**
   * TRA-2959 — fill-coverage cross-check against broker account-history, the
   * independent denominator `durability.appendErrors` structurally lacks (a
   * counter inside the writer reads 0 when the writer is never CALLED — the
   * 2026-08-04 silence: 4 of 11 filled orders in the ledger, appendErrors 0).
   * `missingContracts > 0` means broker fills existed that NO code path
   * recorded; the same pass appends them as `origin: 'history_import'` rows,
   * so the gap both alarms and heals. Null until a history fetch has run.
   * TRA-4408 — a UNION read across every account whose history fetched, each
   * ledger row counted once (the TRA-4295 summed fold double-counted
   * `book: null` rows in groups two accounts share); the per-account
   * pre-import results live on `lastAccounts`.
   */
  coverage: LedgerCoverageResult | null;
  /** Rows imported from history since boot (cumulative across passes). */
  totalImportedRows: number;
  /**
   * TRA-3563 — `history_import` rows whose `filledPrice` this pass RE-DERIVED
   * from the broker's own executions. The old attribution copied the price off
   * whichever execution the shortfall walk landed on, so a group that filled at
   * two prices could mint a row at its SIBLING's price — contract totals still
   * reconciled (`coverage.missingContracts: 0` read clean) while the ledger
   * gross overstated the broker and the gainloss join derived a negative fee.
   * A price rewrite in a money path must be visible: each entry names the row
   * and both prices. `to: null` means no attribution was determinable, which is
   * the intended outcome — it converts a silent wrong price into a named
   * `priceless-row` rejection. Empty array = nothing needed repair; null = no
   * history fetch has run.
   */
  lastImportPriceRepairs: ImportedPriceRepair[] | null;
  /** Imported rows re-priced since boot (cumulative across passes). */
  totalImportPriceRepairs: number;
}

let state: LiveOptionsFeeReconcileState = emptyState();

/**
 * TRA-4143 — lots already warn-logged as day trades, keyed on the full lot
 * identity. The pass re-fetches a rolling window every tick, so without this an
 * ongoing violation would re-alert every ~90s and train readers to ignore it;
 * the STATE republishes the full detection every pass regardless. Since-boot on
 * purpose: a restart re-warns once, which for a real-money PDT event is the
 * right direction to fail in.
 */
const warnedPdtDayTradeKeys = new Set<string>();

/**
 * TRA-4408 — fingerprints (group key + reason + operands) of the DETERMINISTIC
 * rejections the previous gainloss join produced. A rejection present here that
 * recurs identically is residue, not stall evidence. Updated only on attempts
 * where the gainloss join actually ran — a failed fetch is not evidence the
 * inputs changed, so it must not launder a repeat back into "new".
 */
let prevDeterministicRejections = new Set<string>();

function rejectionFingerprint(r: GainLossRejection): string {
  return `${r.symbol}|${r.day}|${r.side}|${r.reason}|${r.observed}|${r.expected}`;
}

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
    lastAccounts: null,
    lastGainLossSample: null,
    lastGainLossRejections: null,
    lastGainLossRejectionCounts: null,
    lastGainLossPrefixRepairs: null,
    lastGainLossWashRepairs: null,
    lastPdtDayTradeLots: null,
    lastPdtDayTradeCount: null,
    lastUpdated: null,
    lastGainLossUpdated: null,
    totalUpdated: 0,
    consecutiveNoMatch: 0,
    stalled: false,
    lastError: null,
    lastHistorySample: null,
    lastJoinableCount: null,
    unmeasuredTotal: 0,
    unmeasuredActionable: 0,
    unmeasuredAwaitingClose: 0,
    unmeasuredAged: 0,
    unmeasuredResidue: 0,
    coverage: null,
    totalImportedRows: 0,
    lastImportPriceRepairs: null,
    totalImportPriceRepairs: 0,
  };
}

/** Test seam — reset the provenance between cases. */
export function clearLiveOptionsFeeReconcileState(): void {
  state = emptyState();
  warnedPdtDayTradeKeys.clear();
  prevDeterministicRejections = new Set();
}

/** Snapshot for the health payload (a copy — callers cannot mutate the pass). */
export function getLiveOptionsFeeReconcileState(): LiveOptionsFeeReconcileState {
  return {
    ...state,
    lastWindow: state.lastWindow === null ? null : { ...state.lastWindow },
    lastAccounts:
      state.lastAccounts === null
        ? null
        : state.lastAccounts.map((a) => ({ ...a, coverage: a.coverage === null ? null : { ...a.coverage } })),
    lastHistorySample: state.lastHistorySample === null ? null : state.lastHistorySample.map((s) => ({ ...s })),
    lastGainLossSample: state.lastGainLossSample === null ? null : state.lastGainLossSample.map((s) => ({ ...s })),
    lastGainLossRejections:
      state.lastGainLossRejections === null ? null : state.lastGainLossRejections.map((r) => ({ ...r })),
    lastGainLossRejectionCounts:
      state.lastGainLossRejectionCounts === null ? null : { ...state.lastGainLossRejectionCounts },
    lastGainLossPrefixRepairs:
      state.lastGainLossPrefixRepairs === null ? null : state.lastGainLossPrefixRepairs.map((r) => ({ ...r })),
    lastGainLossWashRepairs:
      state.lastGainLossWashRepairs === null
        ? null
        : state.lastGainLossWashRepairs.map((r) => ({ ...r, lossCloseDays: [...r.lossCloseDays] })),
    lastPdtDayTradeLots:
      state.lastPdtDayTradeLots === null ? null : state.lastPdtDayTradeLots.map((l) => ({ ...l })),
    coverage: state.coverage === null ? null : { ...state.coverage },
    lastImportPriceRepairs:
      state.lastImportPriceRepairs === null ? null : state.lastImportPriceRepairs.map((r) => ({ ...r })),
  };
}

/**
 * TRA-2959 — split the unmeasured rows into the three populations the state
 * documents (see {@link LiveOptionsFeeReconcileState}). `records` is the FULL
 * record set (measured rows included — an open leg's close may itself already
 * be measured). Pure; ET-day strings compare lexicographically.
 */
export function partitionUnmeasured(
  records: readonly LiveOptionFillRecord[],
  cutoffDay: string,
): { actionable: LiveOptionFillRecord[]; awaitingClose: LiveOptionFillRecord[]; aged: LiveOptionFillRecord[] } {
  // Latest recorded close day per symbol — the settlement clock for an OPEN leg
  // starts at its position's CLOSE, not at the open fill.
  const lastCloseDay = new Map<string, string>();
  for (const r of records) {
    if (r.side !== 'sell_to_close') continue;
    const prev = lastCloseDay.get(r.optionSymbol);
    if (prev === undefined || r.etDay > prev) lastCloseDay.set(r.optionSymbol, r.etDay);
  }
  const actionable: LiveOptionFillRecord[] = [];
  const awaitingClose: LiveOptionFillRecord[] = [];
  const aged: LiveOptionFillRecord[] = [];
  for (const r of records) {
    if (r.fees !== null) continue;
    let basisDay = r.etDay;
    if (r.side === 'buy_to_open') {
      const closeDay = lastCloseDay.get(r.optionSymbol);
      if (closeDay === undefined || closeDay < r.etDay) {
        awaitingClose.push(r); // position still open — no settled lot can exist
        continue;
      }
      basisDay = closeDay > basisDay ? closeDay : basisDay;
    }
    (basisDay < cutoffDay ? aged : actionable).push(r);
  }
  return { actionable, awaitingClose, aged };
}

/**
 * TRA-4143 — same-day round-trip (PDT day-trade) lots, per the broker's own
 * lot attribution: `openDate === closeDate` compared on the calendar-day part
 * (the normaliser emits `YYYY-MM-DD`, but raw ISO stamps like
 * `2026-08-04T00:00:00.000Z` are tolerated). A lot with an empty/unparseable
 * open date is NOT matched — absent must never resolve to a value that pairs.
 * Pure; see {@link LiveOptionsFeeReconcileState.lastPdtDayTradeLots} for why
 * this is the one decidable discriminator.
 */
export function detectPdtDayTradeLots(lots: readonly TradierGainLossLot[]): TradierGainLossLot[] {
  const day = (d: string): string => (typeof d === 'string' ? d.slice(0, 10) : '');
  return lots.filter((l) => day(l.openDate) !== '' && day(l.openDate) === day(l.closeDate));
}

/**
 * Run one fee back-fill pass: if any retained ledger row is `fees: null`, fetch
 * Tradier account-history AND the settled gain/loss report over
 * [min unmeasured etDay, today ET] — from EVERY production account on the
 * roster (TRA-4295) — then (TRA-2959) import any broker fill the ledger is
 * missing, and back-fill via the commission join (positive commissions only)
 * and the gainloss derivation (TRA-2850) over the union of every account's
 * lots. All writers rewrite the durable JSONL so the rows survive a redeploy.
 * `buildClient` is invoked ONLY when there is something to measure, so the
 * quiescent path costs no settings read and no broker call. Never throws — see
 * the file header.
 */
export async function runLiveOptionsFeeReconcile(
  buildClient: () => Promise<FeeReconcileClients>,
  now: number = Date.now(),
  /**
   * ⭐ TRA-3977 — the BOOK whose Tradier account `buildClient` resolves, WHEN
   * it resolves a bare single client. Every `history_import` row this pass
   * mints is the broker's record of a fill on ONE account, and until this
   * argument existed those rows landed in a process-global array shared by two
   * live books with nothing saying whose they were. Absent ⇒ the rows are
   * honestly UNATTRIBUTED and every oracle refuses to answer from them once a
   * second book is known. Ignored when the factory returns a
   * {@link FeeReconcileAccount} roster — each account carries its own book.
   */
  book: string | null = null,
): Promise<LiveOptionsFeeReconcileState> {
  state.ticks += 1;
  state.lastTickAt = now;

  const cutoffDay = etDateString(new Date(now - FEE_MEASURABLE_HORIZON_DAYS * 86_400_000));
  const allRecords = summarizeLiveOptionsFeeSlippage().records;
  const unmeasured = allRecords.filter((r) => r.fees === null);
  let partition = partitionUnmeasured(allRecords, cutoffDay);
  state.unmeasuredTotal = unmeasured.length;
  state.unmeasuredActionable = partition.actionable.length;
  state.unmeasuredAwaitingClose = partition.awaitingClose.length;
  state.unmeasuredAged = partition.aged.length;
  // TRA-4408 — residue is confirmed per attempt by this pass's own join; until
  // then the rows count as actionable (the honest, alarm-preserving direction).
  state.unmeasuredResidue = 0;
  // TRA-2959 — the coverage cross-check must run even when every ledger row is
  // measured: the fill it exists to find is one the ledger does NOT contain, so
  // "nothing unmeasured" is not evidence there is nothing to do. Quench only
  // when there has ALSO been no ledger activity inside the horizon (a ledger
  // quiet for a week has no same-week broker fills to cross-check).
  const hasRecentActivity = allRecords.some((r) => r.etDay >= cutoffDay);
  if (unmeasured.length === 0 && !hasRecentActivity) {
    state.lastOutcome = 'no-unmeasured';
    state.consecutiveNoMatch = 0;
    state.stalled = false;
    return getLiveOptionsFeeReconcileState();
  }

  state.attempts += 1;
  state.lastAttemptAt = now;

  let resolved: FeeReconcileClients = null;
  try {
    resolved = await buildClient();
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    resolved = null;
  }
  // TRA-4295 — normalize to a roster: a bare client is a one-account roster
  // under the legacy `book` argument.
  const accounts: FeeReconcileAccount[] =
    resolved === null ? [] : Array.isArray(resolved) ? resolved : [{ book, client: resolved }];
  if (accounts.length === 0) {
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
  // unmeasured row closes on or after that row's etDay). On a fully-measured
  // ledger (coverage-only pass, TRA-2959) the window is the measurable horizon.
  let start = unmeasured.length > 0 ? unmeasured[0]!.etDay : cutoffDay;
  for (const r of unmeasured) if (r.etDay < start) start = r.etDay;
  const today = etDateString(new Date(now));
  const end = today >= start ? today : start;
  state.lastWindow = { start, end };

  // TRA-4295 — fetch every source on every account INDEPENDENTLY: the gainloss
  // derivation is the one that measures real production fees (TRA-2850), so a
  // history outage must not stop it, and one account's outage must not stop a
  // sibling's reconcile.
  interface AccountFetch {
    book: string | null;
    historyFills: TradierTradeHistoryFill[] | null;
    historyError: string | null;
    lots: TradierGainLossLot[] | null;
    gainLossError: string | null;
    coverage: LedgerCoverageResult | null;
  }
  const fetches: AccountFetch[] = [];
  for (const account of accounts) {
    const f: AccountFetch = {
      book: account.book,
      historyFills: null,
      historyError: null,
      lots: null,
      gainLossError: null,
      coverage: null,
    };
    try {
      f.historyFills = await account.client.listAccountHistory({ start, end, type: 'trade', limit: 2000 });
    } catch (err) {
      f.historyError = err instanceof Error ? err.message : String(err);
    }
    try {
      f.lots = await account.client.listGainLoss({ start, end, limit: 2000 });
    } catch (err) {
      f.gainLossError = err instanceof Error ? err.message : String(err);
    }
    fetches.push(f);
  }
  // Every fetch error, per account and per source — a partial fetch failure is
  // still a failure and the state must never self-report cleaner than it ran.
  const label = (b: string | null, source: string): string => (b === null ? source : `${b} ${source}`);
  const fetchErrors = fetches.flatMap((f) => [
    ...(f.historyError !== null ? [`${label(f.book, 'history')}: ${f.historyError}`] : []),
    ...(f.gainLossError !== null ? [`${label(f.book, 'gainloss')}: ${f.gainLossError}`] : []),
  ]);

  if (fetches.every((f) => f.historyFills === null && f.lots === null)) {
    state.lastOutcome = 'fetch-failed';
    state.lastError = fetchErrors.join(' | ');
    log.warn('live-options fee reconcile: every broker fetch failed on every account', {
      start,
      end,
      errors: fetchErrors,
    });
    return getLiveOptionsFeeReconcileState();
  }

  let updated = 0;
  let gainLossUpdated = 0;
  const anyHistory = fetches.some((f) => f.historyFills !== null);
  if (anyHistory) {
    let historyTotal = 0;
    let importedRowsThisPass = 0;
    let missingContractsThisPass = 0;
    const unionHistoryFills: TradierTradeHistoryFill[] = [];
    const historySample: NonNullable<LiveOptionsFeeReconcileState['lastHistorySample']> = [];
    const repairs: ImportedPriceRepair[] = [];
    let joinable = 0;
    for (const f of fetches) {
      if (f.historyFills === null) continue;
      const historyFills = f.historyFills;
      // TRA-2959 — coverage cross-check FIRST, so a fill no chokepoint recorded
      // becomes a ledger row before the fee joins run (a missing row otherwise
      // breaks its whole symbol/day/side group's qty reconciliation in the
      // gainloss join — one silent fill poisoned the group's fees too). Per
      // account, so every imported row carries the book whose account the
      // history was actually fetched from (TRA-3977/TRA-4295).
      const coverage = importMissingLiveOptionFills(historyFills, today, f.book);
      f.coverage = coverage;
      importedRowsThisPass += coverage.importedRows;
      missingContractsThisPass += coverage.missingContracts;
      state.totalImportedRows += coverage.importedRows;
      unionHistoryFills.push(...historyFills);
      // TRA-3563 — then RE-PRICE any imported row the old attribution minted at a
      // sibling execution's price. It runs AFTER the import (which establishes the
      // contract coverage the repair requires) and BEFORE the fee joins, so a
      // repaired price is the one the gainloss derivation reconciles against on
      // this same pass. It is NOT counted in `updated`: that counter means "rows
      // that gained a fee", and a pass that only fixed a price must not report
      // 'backfilled'.
      const repriced = repriceImportedLiveOptionFills(historyFills);
      repairs.push(...repriced.repairs);
      state.totalImportPriceRepairs += repriced.repairs.length;
      updated += backfillLiveOptionFees(historyFills).updated;
      historyTotal += historyFills.length;
      // Mirror the join's ACTUAL eligibility (incl. commission > 0) — a diagnostic
      // that counts fills the join is required to skip advertises progress that
      // cannot happen (the TRA-2850 "14 joinable, 0 updated forever" shape).
      joinable += historyFills.filter(
        (h) => h.tradeType === 'option'
          && historyFillSide(h.description, h.amount) !== null
          && typeof h.quantity === 'number' && Number.isFinite(h.quantity) && h.quantity > 0
          && typeof h.commission === 'number' && Number.isFinite(h.commission) && h.commission > 0,
      ).length;
      // Take fills from the raw array BEFORE the join filters them — include fills
      // regardless of tradeType/side so we can diagnose filter drops.
      for (const h of historyFills) {
        if (historySample.length >= HISTORY_SAMPLE_MAX) break;
        historySample.push({
          symbol: h.symbol,
          date: h.date,
          description: h.description.slice(0, 80), // truncate long descriptions
          orderId: h.orderId,
          commission: h.commission,
          price: h.price,
          quantity: h.quantity,
          book: f.book,
        });
      }
    }
    state.lastHistoryFills = historyTotal;
    state.lastHistorySample = historySample;
    state.lastJoinableCount = joinable;
    state.lastImportPriceRepairs = repairs;
    // TRA-4408 — the published contract totals are a UNION read (each ledger
    // row counted once against the union of every account's history), not a
    // per-account sum: summing double-counted `book: null` rows in groups two
    // accounts share and manufactured a phantom "over-recorded" ledger (see
    // {@link ledgerCoverageAgainstHistory}). `missingContracts`/`importedRows`
    // keep their per-account-sum semantics — the gap FOUND this pass and the
    // rows appended to heal it (a broker fill belongs to exactly one account,
    // so those sums cannot double-count) — and the verdict keys on the found
    // gap. Per-account (pre-import) coverage stays on `lastAccounts`.
    const unionCoverage = ledgerCoverageAgainstHistory(unionHistoryFills, today);
    state.coverage = {
      ...unionCoverage,
      missingContracts: missingContractsThisPass,
      importedRows: importedRowsThisPass,
      verdict:
        unionCoverage.comparedContracts === 0
          ? 'unmeasured'
          : missingContractsThisPass > 0
            ? 'missing'
            : 'complete',
    };
  }
  const anyGainLoss = fetches.some((f) => f.lots !== null);
  // TRA-4408 — the FULL (uncapped) rejection list of this pass's join, for the
  // deterministic-residue detection below. Null when no gainloss join ran.
  let gainLossRejections: GainLossRejection[] | null = null;
  if (anyGainLoss) {
    // TRA-4295 — the join runs ONCE over the UNION of every account's lots.
    // Each (symbol, day, side) group's lots settle in exactly one account, so
    // the union finds them wherever they live — including for `book: null`
    // legacy rows no static attribution could route to an account. `lotBooks`
    // rides along index-parallel so the published sample can still say which
    // account each lot came from.
    const unionLots: TradierGainLossLot[] = [];
    const lotBooks: Array<string | null> = [];
    for (const f of fetches) {
      if (f.lots === null) continue;
      for (const l of f.lots) {
        unionLots.push(l);
        lotBooks.push(f.book);
      }
    }
    const gainLoss = backfillLiveOptionFeesFromGainLoss(unionLots);
    gainLossUpdated = gainLoss.updated;
    updated += gainLossUpdated;
    state.lastGainLossLots = unionLots.length;
    // TRA-3558 — the RAW lots, before any filter or key derivation, so an ABSENT
    // lot is distinguishable from a MIS-KEYED one without source access.
    state.lastGainLossSample = unionLots.slice(0, GAINLOSS_SAMPLE_MAX).map((l, i) => ({
      symbol: l.symbol,
      quantity: l.quantity,
      cost: l.cost,
      proceeds: l.proceeds,
      openDate: l.openDate,
      closeDate: l.closeDate,
      book: lotBooks[i]!,
    }));
    state.lastGainLossRejections = gainLoss.rejections.slice(0, GAINLOSS_REJECTION_MAX);
    // Counted over ALL rejections, not the published slice — a truncated list
    // must not make a stall read smaller than it is.
    const counts: Record<GainLossRejectionReason, number> = {
      'no-lot': 0,
      'priceless-row': 0,
      'qty-mismatch': 0,
      'negative-fee': 0,
      'above-bound': 0,
    };
    for (const r of gainLoss.rejections) counts[r.reason] += 1;
    state.lastGainLossRejectionCounts = counts;
    state.lastGainLossPrefixRepairs = gainLoss.prefixRepairs;
    state.lastGainLossWashRepairs = gainLoss.washRepairs;
    gainLossRejections = gainLoss.rejections;
    if (gainLoss.washRepairs.length > 0) {
      // A fee written off an inferred broker basis adjustment must announce
      // itself in the log as well as the state (TRA-4408).
      log.warn('live-options fee reconcile recovered fee(s) from wash-sale-adjusted gainloss basis (TRA-4408)', {
        washRepairs: gainLoss.washRepairs.map(
          (r) =>
            `${r.symbol} ${r.day} ${r.side} x${r.contracts}: raw ${r.rawDerived} − wash ${r.washAdjustment} = ${r.fee} (loss closed ${r.lossCloseDays.join(',')})`,
        ),
      });
    }
    // TRA-4143 — day-trade detection off the broker's OWN lot pairing. Runs on
    // the raw lots (pre-filter, pre-join): a lot the fee join rejects is still a
    // round trip the account performed. Per account — PDT is enforced per
    // account, and the warn key carries the book so two accounts' identical
    // round trips cannot deduplicate each other.
    const dayTrades: Array<{ lot: TradierGainLossLot; book: string | null }> = [];
    for (const f of fetches) {
      if (f.lots === null) continue;
      for (const lot of detectPdtDayTradeLots(f.lots)) dayTrades.push({ lot, book: f.book });
    }
    state.lastPdtDayTradeCount = dayTrades.length;
    state.lastPdtDayTradeLots = dayTrades.slice(0, PDT_DAY_TRADE_SAMPLE_MAX).map(({ lot: l, book: b }) => ({
      symbol: l.symbol,
      quantity: l.quantity,
      cost: l.cost,
      proceeds: l.proceeds,
      openDate: l.openDate,
      closeDate: l.closeDate,
      book: b,
    }));
    const unseen = dayTrades.filter(({ lot: l, book: b }) => {
      const key = `${b ?? ''}|${l.symbol}|${l.openDate.slice(0, 10)}|${l.closeDate.slice(0, 10)}|${l.quantity}|${l.cost}|${l.proceeds}`;
      if (warnedPdtDayTradeKeys.has(key)) return false;
      warnedPdtDayTradeKeys.add(key);
      return true;
    });
    if (unseen.length > 0) {
      // The alert ask 2 of TRA-4143 exists for: a same-day live round trip on
      // the sub-$25k PDT account, discovered at the broker, must surface as a
      // warning — not sit as a silent ledger row. The engine-side overnight gate
      // (holdLiveOptionsOvernightForPdt) cannot see out-of-band closes; this can.
      log.warn(
        'live-options PDT DAY TRADE at the broker — same-day round trip on a live lot (TRA-4143)',
        {
          dayTrades: unseen.map(
            ({ lot: l, book: b }) =>
              `${b ?? 'unattributed'} ${l.symbol} ${l.openDate.slice(0, 10)} x${l.quantity} cost ${l.cost} proceeds ${l.proceeds}`,
          ),
          totalInWindow: dayTrades.length,
          window: { start, end },
        },
      );
    }
  }
  state.lastAccounts = fetches.map((f) => ({
    book: f.book,
    historyFills: f.historyFills === null ? null : f.historyFills.length,
    gainLossLots: f.lots === null ? null : f.lots.length,
    historyError: f.historyError,
    gainLossError: f.gainLossError,
    coverage: f.coverage,
  }));

  state.lastUpdated = updated;
  state.lastGainLossUpdated = anyGainLoss ? gainLossUpdated : null;
  state.totalUpdated += updated;
  // TRA-2959 — re-partition AFTER import + joins: imports add unmeasured rows,
  // joins remove them. `stalled` keys on the ACTIONABLE population only — rows
  // past the horizon or awaiting their close cannot match no matter how many
  // ticks run, and counting them trained readers to ignore the alarm.
  const after = summarizeLiveOptionsFeeSlippage().records;
  partition = partitionUnmeasured(after, cutoffDay);
  state.unmeasuredTotal = after.filter((r) => r.fees === null).length;
  state.unmeasuredAwaitingClose = partition.awaitingClose.length;
  state.unmeasuredAged = partition.aged.length;
  // TRA-4408 — carve the deterministic residue out of the actionable set: a
  // group rejected 'above-bound'/'negative-fee'/'qty-mismatch' with operands
  // IDENTICAL to the previous attempt's is re-running settled arithmetic, and
  // its rows must not feed `consecutiveNoMatch` — before this, 5 such rows
  // pinned `stalled: true` structurally. The first sighting of a rejection
  // still counts as no-match (one honest warm-up tick, incl. across restarts);
  // only a confirmed repeat is residue. Fingerprints update ONLY when a join
  // ran — a failed fetch must not launder a repeat back into "new".
  let residueGroupKeys = new Set<string>();
  if (gainLossRejections !== null) {
    const deterministic = gainLossRejections.filter((r) => DETERMINISTIC_REJECTION_REASONS.has(r.reason));
    residueGroupKeys = new Set(
      deterministic
        .filter((r) => prevDeterministicRejections.has(rejectionFingerprint(r)))
        .map((r) => `${r.symbol}|${r.day}|${r.side}`),
    );
    prevDeterministicRejections = new Set(deterministic.map(rejectionFingerprint));
  }
  const residueRows = partition.actionable.filter((r) =>
    residueGroupKeys.has(`${r.optionSymbol}|${r.etDay}|${r.side}`),
  );
  state.unmeasuredActionable = partition.actionable.length - residueRows.length;
  state.unmeasuredResidue = residueRows.length;
  state.lastOutcome =
    updated > 0
      ? 'backfilled'
      : state.unmeasuredTotal === 0
        ? 'no-unmeasured'
        : state.unmeasuredActionable > 0
          ? 'no-match'
          : residueRows.length > 0
            ? 'residue'
            : 'no-actionable';
  state.consecutiveNoMatch = state.lastOutcome === 'no-match' ? state.consecutiveNoMatch + 1 : 0;
  state.stalled = state.consecutiveNoMatch >= STALLED_AFTER_NO_MATCH;
  // A partial fetch failure is still a failure — record it even when the other
  // fetches produced an outcome, so the state never self-reports cleaner than it
  // ran. TRA-4295 — every failed fetch is named, per account and per source.
  state.lastError = fetchErrors.length > 0 ? fetchErrors.join(' | ') : null;
  const summary = summarizeLiveOptionsFeeSlippage();
  const logFields = {
    outcome: state.lastOutcome,
    window: { start, end },
    historyFills: state.lastHistoryFills,
    gainLossLots: state.lastGainLossLots,
    accounts: (state.lastAccounts ?? []).map(
      (a) => `${a.book ?? 'unattributed'}: history ${a.historyFills ?? 'FAILED'} / gainloss ${a.gainLossLots ?? 'FAILED'}`,
    ),
    updated,
    gainLossUpdated: state.lastGainLossUpdated,
    feesMeasured: summary.feesMeasured,
    n: summary.n,
    totalFees: summary.totalFees,
    consecutiveNoMatch: state.consecutiveNoMatch,
    // TRA-3558 — a 'no-match' log line that does not say WHICH test fired is a
    // dead end; carry the histogram and the actionable groups into the log too.
    gainLossRejectionCounts: state.lastGainLossRejectionCounts,
    gainLossPrefixRepairs: (state.lastGainLossPrefixRepairs ?? []).map(
      (r) => `${r.lotSymbol} -> ${r.resolvedSymbol} (${r.day} ${r.side})`,
    ),
    gainLossRejections: (state.lastGainLossRejections ?? [])
      .slice(0, 5)
      .map((r) => `${r.symbol} ${r.day} ${r.side}: ${r.reason} (${r.observed} vs ${r.expected})`),
    partialFetchError: state.lastError,
    // TRA-4143 — null = no gainloss fetch this pass (undetected ≠ zero).
    pdtDayTradeCount: state.lastPdtDayTradeCount,
    coverage: state.coverage,
    // TRA-3563 — coverage reads clean (missingContracts 0) on exactly the defect
    // this repairs, so the repair has to speak for itself in the same line.
    importPriceRepairs: (state.lastImportPriceRepairs ?? []).map(
      (r) => `${r.optionSymbol} ${r.day} ${r.side} x${r.contracts}: ${r.from} -> ${r.to}`,
    ),
    unmeasured: {
      total: state.unmeasuredTotal,
      actionable: state.unmeasuredActionable,
      awaitingClose: state.unmeasuredAwaitingClose,
      aged: state.unmeasuredAged,
      // TRA-4408 — deterministically-rejected rows, named so a 'residue'
      // outcome is readable off the log line alone.
      residue: state.unmeasuredResidue,
    },
    washRepairs: (state.lastGainLossWashRepairs ?? []).map(
      (r) => `${r.symbol} ${r.day} ${r.side}: raw ${r.rawDerived} − wash ${r.washAdjustment} = ${r.fee}`,
    ),
  };
  if (state.stalled) {
    log.warn('live-options fee reconcile STALLED — repeated no-match, nothing ever written (TRA-2850)', logFields);
  } else {
    log.info('live-options fee reconcile pass complete (TRA-2810/TRA-2850)', logFields);
  }
  return getLiveOptionsFeeReconcileState();
}
