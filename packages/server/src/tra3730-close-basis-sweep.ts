// TRA-3730 (parent TRA-2819) — make the close-basis restatement SELF-DRIVING,
// and publish the fee-pending backlog as a first-class, countable state.
//
// ── WHY THIS EXISTS ON TOP OF TRA-2819 ───────────────────────────────────────
// TRA-2819 shipped the arithmetic (`planCloseBasisRestate`), the writer
// (`recordOptionTradeCloseBasis`) and a route to fire them:
// `POST /api/health/option-journal/close-basis-repair`, which is
// `requireAuth + requireAdmin`. That discharged the incident — the three
// 2026-07-30 rows now read Tradier's +695.09 / +15.11 / +3.53, +713.73 to the
// cent — and left the MECHANISM running.
//
// Commission is not knowable at close time. Tradier's order-status payload
// carries no commission; it appears only on the account HISTORY / `/gainloss`
// surface after settlement (TRA-1929), which is why `LiveOptionFillRecord.fees`
// is born honestly `null` rather than `0`. So `queueJournalClose` books
// `position.pnl` GROSS, correctly — at that instant there is nothing else it
// could do. The half that was missing is that **nothing ever came back for it**.
// The fee reconcile (TRA-2810/TRA-2850) already does the hard part: it back-fills
// `fees` onto the ledger from `/gainloss`. That measurement then sat in the fee
// ledger and never reached the journal.
//
// The residual the CTO measured on 2026-08-14, on prod build `0e9f0e8bb4b6`, is
// four live rows closed 08-06..08-11, each overstated by EXACTLY its own
// measured commission:
//
//   QQQ260911P00545000  08-11  −57.24 vs −57.66   +0.42   (fees 0.86, pro-rated)
//   KVYO260918C00017500 08-07  −14.01 vs −14.68   +0.67   (fees 0.67)
//   TROW260918C00115000 08-10  −79.00 vs −79.24   +0.24   (fees 0.24)
//   ABCL260918C00010000 08-11  −16.00 vs −16.86   +0.86   (fees 0.86)
//
// The error IS the fee, on every row. Their ENTRY basis was already correct —
// `restateEngineOpenedBasis` (TRA-2889) reached them while they were open — so
// the mid-vs-fill component that dominated the 07-30 cohort is absent and what
// is left is the structural, recurring half, alone.
//
// **This is the TRA-3485 → TRA-3547 move, for the identical reason.** On bqb1 an
// admin-gated write is effectively UNREACHABLE: login and pre-minted tokens both
// 401 against Render's separate user store (the TRA-803 note in index.ts). That
// is not hypothetical — it is the SAME failure the fee back-fill already lived
// through: TRA-1954 put the fee join behind an admin POST, two consecutive
// real-money windows then ended `feesMeasured 0/n`, and TRA-2810 had to re-ship
// it as a scheduler-driven pass. A repair route that only a human with an admin
// token can fire is a repair that runs once, on the rows that happened to be
// wrong the day somebody looked.
//
// ── WHY THERE IS NO AGE FLOOR HERE (and TRA-3547 needed one) ─────────────────
// TRA-3547 had to invent {@link ZOMBIE_MIN_AGE_MS} because its `retract` branch
// reads "no ledger row" as "the order never filled" — an inference that is sound
// for a settled cohort and DANGEROUS at the moment of entry, when a legitimate
// live row has no fill yet. A wall clock was the only guard available.
//
// This pass needs no such invention, and adding one would be strictly worse than
// useless. Its gate is the fee-completeness refusal, and that is a SETTLEMENT
// clock rather than a wall clock: a fill's `fees` are null until the reconcile
// derives them from a `/gainloss` lot, and a lot only appears in `/gainloss`
// after it settles. So `allocatedFees !== null` on every leg is a positive
// witness that the broker has finished with this round trip — strictly stronger
// than "N hours have passed", and it cannot be satisfied early. A wall-clock
// floor bolted on top would only DELAY correct restatements while adding no
// protection the planner does not already provide (the partial-coverage and
// window refusals cover the mid-exit races).
//
// The corollary, and the thing that must not be relaxed: `fees: null` means
// UNMEASURED, not free (TRA-1707). Driving this automatically makes that refusal
// MORE load-bearing, not less. A just-closed row legitimately has no fees yet;
// the correct behaviour is to SKIP it and pick it up on a later tick. Zero-filling
// would publish a gross number wearing a broker-settled label — strictly worse
// than the wrong number it replaced, because it stops anyone from looking again.
// That backlog is therefore not a silent skip: it is counted as `feesPending` and
// gets its own outcome (`'fees-pending'`), because "nothing to do" and "waiting on
// the broker" are different facts about the same quiet tick.
//
// ── INVARIANTS ───────────────────────────────────────────────────────────────
// - Re-derives the plan EVERY tick from the live journal + live ledger. There is
//   no stored cohort and no list of ids in the code (the standing instruction on
//   TRA-3472/TRA-3485/TRA-2819): a correction keyed to a stale partition rewrites
//   history in the wrong direction while still reading as correct.
// - Never throws: every failure lands in the state below, so the scheduler tick
//   that hosts it cannot be starved by a bad row.
// - Refuses to WRITE when the fill ledger is not a usable source of broker truth
//   (ephemeral / append errors / empty) — the same gate the admin route enforces.
//   Here a sick ledger does not invert an inference, it supplies MISSING FILLS,
//   and a missing leg reads as a smaller correction rather than as an error.
// - The OPEN guard is never routed around: the writer is
//   `recordOptionTradeCloseBasis`, the production fold entry point, which refuses
//   a row that is still OPEN. A refusal is RECORDED (`lastApplied.refused` here,
//   `closeBasisAmends.refused` on the journal witness), never dropped.
// - Observe-only kill switch: `CLOSE_BASIS_SWEEP_OBSERVE_ONLY=true` keeps the
//   measurement (and therefore the backlog alarm) while writing nothing.
//
// ── READING THE STATE ────────────────────────────────────────────────────────
// `restatableRows.count === null` means NEVER CHECKED. `count === 0` means
// checked and clean. Those are different facts and the shape makes them
// impossible to confuse — the same positive-zero rule TRA-3547 published under.

import type { LiveOptionFillRecord } from './live-options-fee-slippage-ledger.js';
import type {
  OptionTradeCloseBasis,
  OptionTradeJournalRecord,
} from './option-trade-journal.js';
import {
  planCloseBasisRestate,
  type CloseBasisPlan,
  type CloseBasisPlanRow,
} from './tra2819-close-basis-restate.js';
import { round2 } from './tra3485-stale-open-repair.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'tra3730-close-basis-sweep' });

/** Env kill switch — measure and publish, write nothing. */
export function isCloseBasisSweepObserveOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env['CLOSE_BASIS_SWEEP_OBSERVE_ONLY'] ?? '').toLowerCase() === 'true';
}

/**
 * Why a tick ended where it did. Every value is a DISTINCT operational fact.
 * In particular `'clean'` (rows graded, all already on broker truth or already
 * agreeing with it) and `'fees-pending'` (rows graded, some still waiting on the
 * broker's settlement) are not collapsed: the second one means COME BACK, and a
 * reader who cannot tell them apart will read a permanent backlog as a finished
 * job.
 */
export type CloseBasisSweepOutcome =
  | 'never-run'
  | 'disabled'
  | 'no-closed-rows'
  | 'clean'
  | 'restated'
  | 'refused'
  | 'fees-pending'
  | 'observe-only'
  | 'ledger-unusable'
  | 'error';

export interface CloseBasisSweepCounts {
  /** Closed LIVE journal rows the planner graded this tick. */
  closedLiveRows: number;
  /**
   * Rows the planner would restate. This is the alarm number: a row here is a
   * settled round trip whose journalled money disagrees with broker truth.
   */
  restatable: number;
  /** Rows already carrying `pnlBasis: 'broker-fill'` — nothing left to do. */
  alreadyRestated: number;
  /**
   * Rows the planner priced and found ALREADY broker-exact. Evidence the close
   * path is healthy, not evidence the pass failed to reach them.
   */
  zeroDelta: number;
  /**
   * Rows skipped because a leg's fee is still UNMEASURED. The backlog, and the
   * reason the pass has to be recurring rather than one-shot.
   */
  feesPending: number;
  /** Rows skipped for anything else (unjoinable, partial coverage, no basis). */
  otherSkips: number;
  /** Per-reason census, so the denominator is never implicit. */
  skipsByReason: Record<string, number>;
  /** Σ `deltaUsd` over the restatable rows — what this tick WOULD move the book by. */
  plannedNetDeltaUsd: number;
}

export interface CloseBasisSweepState {
  ticks: number;
  lastRunAt: string | null;
  lastOutcome: CloseBasisSweepOutcome;
  lastError: string | null;
  /**
   * TRUE once a tick has actually graded the rows. `restatableRows.count` below
   * is null until then — see the header note on the positive zero.
   */
  checked: boolean;
  counts: CloseBasisSweepCounts | null;
  /** Was the fill ledger a usable source of broker truth on the last tick? */
  ledgerUsable: boolean | null;
  observeOnly: boolean;
  /** Writes applied on the LAST tick. */
  lastApplied: { restated: number; refused: number; netDeltaUsd: number };
  /** Writes applied since process start. */
  lifetime: { restated: number; refused: number; netDeltaUsd: number };
  /** Per-row evidence from the last tick, so a reader can audit without an admin login. */
  lastRows: {
    id: string;
    optionSymbol: string | null;
    treatment: string;
    skipReason: string | null;
    realizedPnlUsdBefore: number | null;
    realizedPnlUsdAfter: number | null;
    deltaUsd: number | null;
    feesUsd: number | null;
    applied: boolean;
    reason: string;
  }[];
}

const state: CloseBasisSweepState = {
  ticks: 0,
  lastRunAt: null,
  lastOutcome: 'never-run',
  lastError: null,
  checked: false,
  counts: null,
  ledgerUsable: null,
  observeOnly: false,
  lastApplied: { restated: 0, refused: 0, netDeltaUsd: 0 },
  lifetime: { restated: 0, refused: 0, netDeltaUsd: 0 },
  lastRows: [],
};

/** How many per-row evidence entries the state republishes. */
export const ROW_EVIDENCE_MAX = 40;

/**
 * What a reader actually gets — the raw state PLUS the two positive-zero boxes.
 *
 * Named rather than inlined on the getter because {@link runCloseBasisSweep}
 * returns it too. Declaring that function as `Promise<CloseBasisSweepState>`
 * type-checks (the readout is a supertype) and then silently hides
 * `restatableRows` from every caller — and `tsc -b --force` type-checks the
 * `.test.ts` files, so the first thing to notice would have been the DEPLOY
 * build, not the suite (TRA-3695).
 */
export type CloseBasisSweepReadout = CloseBasisSweepState & {
  restatableRows: { count: number | null; checked: boolean; asOf: string | null };
  feesPendingRows: { count: number | null; checked: boolean };
};

/**
 * The published readout. `restatableRows.count` is `null` until a tick has
 * graded the rows — a never-checked box and a clean box must not read alike.
 */
export function getCloseBasisSweepState(): CloseBasisSweepReadout {
  return {
    ...state,
    restatableRows: {
      count: state.checked ? (state.counts?.restatable ?? 0) : null,
      checked: state.checked,
      asOf: state.lastRunAt,
    },
    feesPendingRows: {
      count: state.checked ? (state.counts?.feesPending ?? 0) : null,
      checked: state.checked,
    },
  };
}

/** Test seam — reset the process-global state between cases. */
export function resetCloseBasisSweepStateForTests(): void {
  state.ticks = 0;
  state.lastRunAt = null;
  state.lastOutcome = 'never-run';
  state.lastError = null;
  state.checked = false;
  state.counts = null;
  state.ledgerUsable = null;
  state.observeOnly = false;
  state.lastApplied = { restated: 0, refused: 0, netDeltaUsd: 0 };
  state.lifetime = { restated: 0, refused: 0, netDeltaUsd: 0 };
  state.lastRows = [];
}

/** Everything the pass touches, injected so the whole thing is testable. */
export interface CloseBasisSweepDeps {
  journalEnabled: () => boolean;
  listLiveJournalRows: () => Promise<OptionTradeJournalRecord[]>;
  readLedger: () => {
    n: number;
    records: LiveOptionFillRecord[];
    durability: { ephemeral: boolean; appendErrors: number };
  };
  /** Returns FALSE when the fold refused (row unknown, still OPEN, or non-finite basis). */
  recordCloseBasis: (id: string, basis: OptionTradeCloseBasis) => Promise<boolean>;
  now?: () => number;
  observeOnly?: () => boolean;
}

function countsFrom(plan: CloseBasisPlan): CloseBasisSweepCounts {
  const by = plan.skipsByReason;
  const alreadyRestated = by['already_restated'] ?? 0;
  const zeroDelta = by['zero_delta'] ?? 0;
  const feesPending = by['fees_unmeasured'] ?? 0;
  return {
    closedLiveRows: plan.scanned,
    restatable: plan.counts.restate,
    alreadyRestated,
    zeroDelta,
    feesPending,
    otherSkips: plan.counts.skip - alreadyRestated - zeroDelta - feesPending,
    skipsByReason: { ...by },
    plannedNetDeltaUsd: plan.netDeltaUsd,
  };
}

/**
 * Which skips are worth a per-row line in the readout.
 *
 * `already_restated` and `zero_delta` are the steady state of a healthy book and
 * would flood the evidence out of every other row within a few weeks of trading.
 * They keep their COUNTS in `skipsByReason` — an exclusion with a count is a
 * denominator, an exclusion without one is a hiding place.
 */
function isNoteworthySkip(row: CloseBasisPlanRow): boolean {
  return row.skipReason !== 'already_restated' && row.skipReason !== 'zero_delta';
}

/**
 * One tick. Never throws.
 *
 * Ordering matters: the MEASUREMENT is published even when the pass is not
 * allowed to write. An unusable ledger, or the observe-only switch, must still
 * leave the backlog readable — otherwise the one condition under which repair is
 * impossible is also the one under which nothing is reported.
 */
export async function runCloseBasisSweep(deps: CloseBasisSweepDeps): Promise<CloseBasisSweepReadout> {
  const now = deps.now ?? Date.now;
  const observeOnly = (deps.observeOnly ?? isCloseBasisSweepObserveOnly)();
  state.ticks += 1;
  state.lastRunAt = new Date(now()).toISOString();
  state.lastError = null;
  state.observeOnly = observeOnly;
  state.lastApplied = { restated: 0, refused: 0, netDeltaUsd: 0 };

  try {
    if (!deps.journalEnabled()) {
      // The journal is off, so there are no rows to be wrong about. `checked`
      // stays FALSE: this box has verified nothing, and reporting 0 here would
      // be the never-checked-reads-clean bug.
      state.lastOutcome = 'disabled';
      state.counts = null;
      state.ledgerUsable = null;
      state.lastRows = [];
      return getCloseBasisSweepState();
    }

    const rows = await deps.listLiveJournalRows();
    const ledger = deps.readLedger();
    // PURE, and filtered to live+closed inside the planner rather than here, so
    // this call site cannot widen the blast radius onto the demo book.
    const plan = planCloseBasisRestate(rows, ledger.records);
    const counts = countsFrom(plan);
    state.counts = counts;
    state.checked = true;

    // Same gate as the admin route. Every restated figure is derived from this
    // ledger's fills and fees; an ephemeral store, an append error or an empty
    // record set means a LEG can be missing, and a partially-covered round trip
    // would be priced off whatever survived.
    const ledgerUsable =
      !ledger.durability.ephemeral && ledger.durability.appendErrors === 0 && ledger.n > 0;
    state.ledgerUsable = ledgerUsable;
    const mayWrite = ledgerUsable && !observeOnly;

    const evidence: CloseBasisSweepState['lastRows'] = [];
    for (const row of plan.rows) {
      if (row.treatment !== 'restate' || !row.basis) continue;
      let applied = false;
      let detail = row.reason;
      if (mayWrite) {
        const ok = await deps.recordCloseBasis(row.id, row.basis);
        if (ok) {
          state.lastApplied.restated += 1;
          state.lifetime.restated += 1;
          state.lastApplied.netDeltaUsd = round2(state.lastApplied.netDeltaUsd + (row.deltaUsd ?? 0));
          state.lifetime.netDeltaUsd = round2(state.lifetime.netDeltaUsd + (row.deltaUsd ?? 0));
          applied = true;
          detail = `restated through the replay fold: ${row.realizedPnlUsdBefore} -> ${row.realizedPnlUsdAfter} USD (fees ${row.feesUsd})`;
        } else {
          // The fold refused: the row is unknown or still OPEN. That is the stop
          // signal, not a routine miss — a realized figure must never land on an
          // unsettled position, and the refusal is recorded rather than dropped.
          state.lastApplied.refused += 1;
          state.lifetime.refused += 1;
          detail = 'REFUSED by the fold (row unknown or still OPEN)';
        }
      } else {
        detail = observeOnly
          ? 'observe-only: measured, not written'
          : 'fill ledger is not a usable source of broker truth; refusing to write';
      }
      evidence.push({
        id: row.id,
        optionSymbol: row.optionSymbol,
        treatment: row.treatment,
        skipReason: null,
        realizedPnlUsdBefore: row.realizedPnlUsdBefore,
        realizedPnlUsdAfter: row.realizedPnlUsdAfter,
        deltaUsd: row.deltaUsd,
        feesUsd: row.feesUsd,
        applied,
        reason: detail,
      });
    }

    // The fee-pending backlog and every other non-routine skip are evidence too:
    // a row that is being SKIPPED forever, and cannot be named, is the defect
    // this whole module exists to make impossible.
    for (const row of plan.rows) {
      if (row.treatment === 'restate' || !isNoteworthySkip(row)) continue;
      evidence.push({
        id: row.id,
        optionSymbol: row.optionSymbol,
        treatment: row.treatment,
        skipReason: row.skipReason,
        realizedPnlUsdBefore: row.realizedPnlUsdBefore,
        realizedPnlUsdAfter: row.realizedPnlUsdAfter,
        deltaUsd: row.deltaUsd,
        feesUsd: row.feesUsd,
        applied: false,
        reason: row.reason,
      });
    }
    state.lastRows = evidence.slice(0, ROW_EVIDENCE_MAX);

    // Order matters, and each step earns its place:
    //  - NO CLOSED ROWS first: with nothing to grade, the ledger's health is not
    //    a fact about this journal, and reporting 'ledger-unusable' on an empty
    //    book would make the quietest possible state read as an alarm.
    //  - LEDGER UNUSABLE next, AHEAD of 'clean': a zero counted through a
    //    degraded source of truth must not be published as a green.
    //  - 'fees-pending' AFTER the write outcomes but BEFORE 'clean': a tick that
    //    restated two rows and is still waiting on a third is a restating tick,
    //    and the backlog it is waiting on is carried in the counts either way.
    if (counts.closedLiveRows === 0) {
      state.lastOutcome = 'no-closed-rows';
    } else if (!ledgerUsable) {
      state.lastOutcome = 'ledger-unusable';
    } else if (observeOnly) {
      state.lastOutcome = 'observe-only';
    } else if (state.lastApplied.restated > 0) {
      state.lastOutcome = 'restated';
    } else if (state.lastApplied.refused > 0) {
      state.lastOutcome = 'refused';
    } else if (counts.feesPending > 0) {
      state.lastOutcome = 'fees-pending';
    } else {
      state.lastOutcome = 'clean';
    }

    if (state.lastApplied.restated > 0 || state.lastApplied.refused > 0 || counts.restatable > 0) {
      log.warn('live option closes restated to broker truth', {
        issue: 'TRA-3730',
        outcome: state.lastOutcome,
        ...counts,
        applied: state.lastApplied,
      });
    } else if (counts.feesPending > 0) {
      log.info('live option closes awaiting broker fee measurement', {
        issue: 'TRA-3730',
        feesPending: counts.feesPending,
        closedLiveRows: counts.closedLiveRows,
      });
    }
  } catch (err) {
    state.lastOutcome = 'error';
    state.lastError = err instanceof Error ? err.message : String(err);
    log.warn('close basis sweep failed', { issue: 'TRA-3730', reason: state.lastError });
  }

  return getCloseBasisSweepState();
}
