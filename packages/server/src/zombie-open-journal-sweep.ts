// TRA-3547 (parent TRA-2946) — make the stale-live-OPEN repair SELF-DRIVING, and
// publish a positive-zero zombie count.
//
// ── WHY THIS EXISTS ON TOP OF TRA-3485 ───────────────────────────────────────
// TRA-3485 shipped the hard part: `planStaleOpenRepair`, a pure partition of the
// live `OPEN` journal rows against durable broker fills, refusing rather than
// guessing. It is reached through `POST /api/health/option-journal/repair`, which
// is `requireAuth + requireAdmin`.
//
// On bqb1 an admin-gated write is effectively UNREACHABLE: login and pre-minted
// tokens both 401 against Render's separate user store (the TRA-803 note in
// index.ts). That is not a hypothetical — it is the SAME failure the fee
// back-fill already lived through. TRA-1954 put the fee join behind an admin
// POST, two consecutive real-money windows then ended `feesMeasured 0/n`, and
// TRA-2810 had to re-ship it as a scheduler-driven pass under the one-line
// summary that applies verbatim here: **a back-fill nobody can trigger is a
// back-fill that never runs.**
//
// So the 13 zombie rows measured on 2026-08-13 (7 real round trips whose CLOSE
// was dropped, 6 that never filled, oldest unresolved close 9.9 days) would have
// survived TRA-3485's merge untouched. This module rides the existing ET hourly
// tick plus a post-boot kick, needs no auth, and quenches itself when there is
// nothing to do.
//
// ── WHY AN AGE FLOOR (the thing an unattended pass needs and a human-timed
//    route did not) ──────────────────────────────────────────────────────────
// The planner's `retract` branch fires when a row has NO fill on either leg,
// reading "no ledger row" as "the order never filled". That inference is sound
// for a settled cohort and DANGEROUS at the moment of entry: the journal OPEN is
// written before the broker is contacted, so for the first seconds of every real
// live trade the row legitimately has no fill yet. A human POSTing the repair
// route picks their moment; an hourly timer does not. {@link ZOMBIE_MIN_AGE_MS}
// is that missing guard — rows younger than it are HELD, counted, and named
// (`youngHeld`), never silently skipped.
//
// ── INVARIANTS ───────────────────────────────────────────────────────────────
// - Re-derives the partition EVERY tick from the live journal + live ledger.
//   There is no stored cohort (the standing instruction on TRA-3472/TRA-3485).
// - Never throws: every failure lands in the state below, so the scheduler tick
//   that hosts it cannot be starved.
// - Refuses to WRITE when the fill ledger is not a usable discriminator
//   (ephemeral / append errors / empty) — under that reading "no ledger row"
//   means "the ledger is broken", not "the order never filled", and a retraction
//   pass would delete real trades. Same gate the admin route enforces.
// - Observe-only kill switch: `ZOMBIE_OPEN_SWEEP_OBSERVE_ONLY=true` keeps the
//   measurement (and therefore the alarm) while writing nothing.
//
// ── READING THE STATE (ask 4 — the positive zero) ────────────────────────────
// `zombieOpenRows.count === null` means NEVER CHECKED. `count === 0` means
// checked and clean. Those are different facts and the shape makes them
// impossible to confuse — the whole point of the ask, and the reason the count
// is not a bare number.

import type { LiveOptionFillRecord } from './live-options-fee-slippage-ledger.js';
import type {
  OptionTradeJournalClose,
  OptionTradeJournalRecord,
} from './option-trade-journal.js';
import { TRADIER_IMPORT_STRUCTURE } from './option-trade-journal.js';
import { planStaleOpenRepair, type StaleOpenPlan, type StaleOpenPlanRow } from './tra3485-stale-open-repair.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'zombie-open-journal-sweep' });

/**
 * How old a live `OPEN` journal row must be before this UNATTENDED pass may
 * treat it.
 *
 * 24h, chosen against both sides of the error:
 *  - FLOOR side: a genuine in-flight entry is seconds old, and the fill→ledger
 *    append is in-process and immediate; a fill that is somehow un-appended after
 *    a full day is not "settling", it is lost.
 *  - CEILING side: the zombies this exists to clear were 1.7–13.9 days old, so a
 *    24h floor holds none of them back for more than one extra day, and the pass
 *    runs hourly.
 *
 * Rows below the floor are reported as `youngHeld`, never dropped: an exclusion
 * with no count is how a wrong denominator hides.
 */
export const ZOMBIE_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** The reason string every auto-retraction carries into the void witness. */
export const AUTO_RETRACT_REASON = 'tra3547_auto_sweep_never_filled';

/** Env kill switch — measure and publish, write nothing. */
export function isZombieSweepObserveOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env['ZOMBIE_OPEN_SWEEP_OBSERVE_ONLY'] ?? '').toLowerCase() === 'true';
}

/**
 * Why a tick ended where it did. Every value is a DISTINCT operational fact —
 * in particular `no-open-rows` (nothing to grade) and `clean` (rows graded, none
 * zombie) are not collapsed, because "quiet" and "verified quiet" are the same
 * reading only to a reader who cannot tell them apart.
 */
export type ZombieSweepOutcome =
  | 'never-run'
  | 'disabled'
  | 'no-open-rows'
  | 'clean'
  | 'repaired'
  | 'refused'
  | 'held-young'
  | 'observe-only'
  | 'ledger-unusable'
  | 'error';

export interface ZombieSweepCounts {
  /** Live rows the journal reads as `OPEN` this tick. */
  liveOpenRows: number;
  /**
   * Rows the broker tape says are NOT open: planner `retract` + `backfill_close`.
   * This is the alarm number. It is the count BEFORE the age floor, because the
   * age floor governs when we may WRITE, not what is true.
   */
  zombieOpenRows: number;
  /** Zombies the planner would retract (no fill on either leg). */
  retract: number;
  /** Zombies the planner would close from broker fills (real round trip). */
  backfillClose: number;
  /**
   * Rows the planner refused. Includes genuinely-open positions (entry filled,
   * no exit yet) AND unjoinable rows. Reported, never rounded into "clean".
   */
  noAction: number;
  /**
   * Zombies held back by {@link ZOMBIE_MIN_AGE_MS} — measured from the row's
   * WRITE time ({@link zombieAgeAnchorTs}), never from an inherited `openTs`.
   * Includes `ageUnknownHeld`.
   */
  youngHeld: number;
  /**
   * TRA-4025 — zombies whose age could not be read at all: `tradier_import`
   * rows written before `mintedAt` existed. Held, and counted separately so a
   * legacy import can never hide inside "young".
   */
  ageUnknownHeld: number;
  /** Age of the oldest zombie in hours (write-time basis), or null when none is measurable. */
  oldestZombieAgeHours: number | null;
}

/**
 * TRA-4025 (AC3) — the instant the age floor is measured FROM, per row.
 *
 * On 2026-08-21T18:01:50Z this sweep read the desk's residual BAC lot
 * `6bbc5d17` — minted by the reconciler at 17:06:09.836Z, FIFTY-FIVE MINUTES
 * earlier — as a 28.4-hour zombie, because its `openTs` was the broker
 * aggregate's `date_acquired`, i.e. the ENGINE lot's 08-20T13:36:22.761Z. The
 * floor that exists to protect a row's first day of life was cleared by a stamp
 * the reconciler had copied from another lot, and the sweep closed the row on
 * that other lot's exit (TRA-4004).
 *
 *  - an engine-written row: `openTs` IS its write time (the journal OPEN is
 *    written before the broker is contacted), so it stands;
 *  - a reconciler mint (`tradier_import`): `mintedAt`, the row's own write time,
 *    and `null` when the row predates the stamp. NOT `openTs` as a fallback —
 *    on an import that is precisely the number this function exists to refuse.
 */
export function zombieAgeAnchorTs(row: Pick<StaleOpenPlanRow, 'structure' | 'mintedAt' | 'openTs'>): number | null {
  if (row.structure !== TRADIER_IMPORT_STRUCTURE) return row.openTs;
  return row.mintedAt;
}

function ageHoursOf(row: StaleOpenPlanRow, now: number): number | null {
  const anchor = zombieAgeAnchorTs(row);
  return anchor === null ? null : Math.round(((now - anchor) / 3_600_000) * 10) / 10;
}

/** Above the floor on a MEASURABLE age. Unknown age is never "old enough". */
function clearsAgeFloor(row: StaleOpenPlanRow, now: number): boolean {
  const anchor = zombieAgeAnchorTs(row);
  return anchor !== null && now - anchor >= ZOMBIE_MIN_AGE_MS;
}

export interface ZombieSweepState {
  ticks: number;
  lastRunAt: string | null;
  lastOutcome: ZombieSweepOutcome;
  lastError: string | null;
  /**
   * TRUE once a tick has actually enumerated the rows. `zombieOpenRows.count`
   * below is null until then — see the header note on the positive zero.
   */
  checked: boolean;
  counts: ZombieSweepCounts | null;
  /** Was the fill ledger a usable discriminator on the last tick? */
  ledgerUsable: boolean | null;
  observeOnly: boolean;
  /** Writes applied on the LAST tick. */
  lastApplied: { retracted: number; closesBackfilled: number; refused: number };
  /** Writes applied since process start. */
  lifetime: { retracted: number; closesBackfilled: number; refused: number };
  /** Per-row evidence from the last tick, so a reader can audit without an admin login. */
  lastRows: {
    id: string;
    optionSymbol: string | null;
    treatment: string;
    /** Write-time basis ({@link zombieAgeAnchorTs}); `null` = unreadable (legacy import). */
    ageHours: number | null;
    applied: boolean;
    reason: string;
  }[];
}

const state: ZombieSweepState = {
  ticks: 0,
  lastRunAt: null,
  lastOutcome: 'never-run',
  lastError: null,
  checked: false,
  counts: null,
  ledgerUsable: null,
  observeOnly: false,
  lastApplied: { retracted: 0, closesBackfilled: 0, refused: 0 },
  lifetime: { retracted: 0, closesBackfilled: 0, refused: 0 },
  lastRows: [],
};

/** How many per-row evidence entries the state republishes. */
export const ROW_EVIDENCE_MAX = 40;

/**
 * The published readout. `zombieOpenRows.count` is `null` until a tick has
 * enumerated the rows — a never-checked box and a clean box must not read alike.
 */
export function getZombieOpenSweepState(): ZombieSweepState & {
  zombieOpenRows: { count: number | null; checked: boolean; asOf: string | null };
} {
  return {
    ...state,
    zombieOpenRows: {
      count: state.checked ? (state.counts?.zombieOpenRows ?? 0) : null,
      checked: state.checked,
      asOf: state.lastRunAt,
    },
  };
}

/** Test seam — reset the process-global state between cases. */
export function resetZombieOpenSweepStateForTests(): void {
  state.ticks = 0;
  state.lastRunAt = null;
  state.lastOutcome = 'never-run';
  state.lastError = null;
  state.checked = false;
  state.counts = null;
  state.ledgerUsable = null;
  state.observeOnly = false;
  state.lastApplied = { retracted: 0, closesBackfilled: 0, refused: 0 };
  state.lifetime = { retracted: 0, closesBackfilled: 0, refused: 0 };
  state.lastRows = [];
}

/** Everything the pass touches, injected so the whole thing is testable. */
export interface ZombieSweepDeps {
  journalEnabled: () => boolean;
  listLiveJournalRows: () => Promise<OptionTradeJournalRecord[]>;
  readLedger: () => {
    n: number;
    records: LiveOptionFillRecord[];
    durability: { ephemeral: boolean; appendErrors: number };
  };
  recordClose: (id: string, close: OptionTradeJournalClose) => Promise<void>;
  /** Returns FALSE when the fold refused (row unknown or already CLOSED). */
  recordVoid: (id: string, reason: string) => Promise<boolean>;
  now?: () => number;
  observeOnly?: () => boolean;
}

function isZombie(row: StaleOpenPlanRow): boolean {
  return row.treatment === 'retract' || row.treatment === 'backfill_close';
}

function countsFrom(plan: StaleOpenPlan, now: number): ZombieSweepCounts {
  const zombies = plan.rows.filter(isZombie);
  const ages = zombies.map((r) => ageHoursOf(r, now)).filter((h): h is number => h !== null);
  return {
    liveOpenRows: plan.scanned,
    zombieOpenRows: zombies.length,
    retract: plan.counts.retract,
    backfillClose: plan.counts.backfillClose,
    noAction: plan.counts.noAction,
    youngHeld: zombies.filter((r) => !clearsAgeFloor(r, now)).length,
    ageUnknownHeld: zombies.filter((r) => zombieAgeAnchorTs(r) === null).length,
    oldestZombieAgeHours: ages.length > 0 ? Math.max(...ages) : null,
  };
}

/**
 * One tick. Never throws.
 *
 * Ordering matters: the MEASUREMENT is published even when the pass is not
 * allowed to write. An unusable ledger, or the observe-only switch, must still
 * leave the alarm readable — otherwise the one condition under which repair is
 * impossible is also the one under which nothing is reported.
 */
export async function runZombieOpenSweep(deps: ZombieSweepDeps): Promise<ZombieSweepState> {
  const now = deps.now ?? Date.now;
  const observeOnly = (deps.observeOnly ?? isZombieSweepObserveOnly)();
  state.ticks += 1;
  state.lastRunAt = new Date(now()).toISOString();
  state.lastError = null;
  state.observeOnly = observeOnly;
  state.lastApplied = { retracted: 0, closesBackfilled: 0, refused: 0 };

  try {
    if (!deps.journalEnabled()) {
      // The journal is off, so there are no rows to be wrong about. `checked`
      // stays FALSE: this box has not verified anything, and reporting 0 here
      // would be the never-checked-reads-clean bug the ask names.
      state.lastOutcome = 'disabled';
      state.counts = null;
      state.ledgerUsable = null;
      state.lastRows = [];
      return getZombieOpenSweepState();
    }

    const rows = await deps.listLiveJournalRows();
    const ledger = deps.readLedger();
    const plan = planStaleOpenRepair(rows, ledger.records);
    const at = now();
    const counts = countsFrom(plan, at);
    state.counts = counts;
    state.checked = true;

    // Same gate as the admin route: a broken ledger INVERTS the retract
    // inference. Measurement stands, writes do not.
    const ledgerUsable = !ledger.durability.ephemeral && ledger.durability.appendErrors === 0 && ledger.n > 0;
    state.ledgerUsable = ledgerUsable;

    // TRA-4025 — the floor is measured from the row's WRITE time. See
    // `zombieAgeAnchorTs`: an import's `openTs` is a stamp copied from the
    // broker aggregate and read a 55-minute-old row as 28.4h on 08-21.
    const eligible = plan.rows.filter((r) => isZombie(r) && clearsAgeFloor(r, at));
    const evidence: ZombieSweepState['lastRows'] = [];
    const mayWrite = ledgerUsable && !observeOnly;

    for (const row of eligible) {
      if (!mayWrite) break;
      let applied = false;
      let detail = row.reason;
      if (row.treatment === 'backfill_close' && row.close) {
        await deps.recordClose(row.id, row.close);
        state.lastApplied.closesBackfilled += 1;
        state.lifetime.closesBackfilled += 1;
        applied = true;
        detail = `CLOSE written from broker fills: ${row.close.outcome} ${row.close.realizedPnlUsd} USD`;
      } else if (row.treatment === 'retract') {
        const ok = await deps.recordVoid(row.id, AUTO_RETRACT_REASON);
        if (ok) {
          state.lastApplied.retracted += 1;
          state.lifetime.retracted += 1;
          applied = true;
          detail = 'row retracted through the replay fold (no fill on either leg)';
        } else {
          // The fold refused — the row was unknown or already CLOSED. That is
          // the stop signal from TRA-3485's brief, not a routine miss.
          state.lastApplied.refused += 1;
          state.lifetime.refused += 1;
          detail = 'REFUSED by the fold (row unknown or already CLOSED)';
        }
      }
      evidence.push({
        id: row.id,
        optionSymbol: row.optionSymbol,
        treatment: row.treatment,
        ageHours: ageHoursOf(row, at),
        applied,
        reason: detail,
      });
    }

    // Zombies we did NOT write are still evidence — a held or refused row that
    // vanishes from the readout is a zombie nobody can see.
    for (const row of plan.rows.filter(isZombie)) {
      if (evidence.some((e) => e.id === row.id)) continue;
      const ageHours = ageHoursOf(row, at);
      evidence.push({
        id: row.id,
        optionSymbol: row.optionSymbol,
        treatment: row.treatment,
        ageHours,
        applied: false,
        reason: !mayWrite
          ? (observeOnly
              ? 'observe-only: measured, not written'
              : 'fill ledger is not a usable discriminator; refusing to write')
          : ageHours === null
            ? `held: write time UNKNOWN — a ${TRADIER_IMPORT_STRUCTURE} row written before mintedAt existed, and its openTs `
              + 'is a stamp inherited from the broker aggregate that cannot be read as an age (TRA-4025); repair by hand via the admin route'
            : `held: ${ageHours}h old (write-time basis), below the ${ZOMBIE_MIN_AGE_MS / 3_600_000}h floor for an unattended pass`,
      });
    }
    state.lastRows = evidence.slice(0, ROW_EVIDENCE_MAX);

    // Order matters, and each step earns its place:
    //  - NO OPEN ROWS first: with nothing to grade, the ledger's health is not a
    //    fact about this journal, and reporting 'ledger-unusable' on an empty
    //    book would make the quietest possible state read as an alarm.
    //  - LEDGER UNUSABLE next, AHEAD of 'clean': a zero counted through a
    //    degraded discriminator must not be published as a green. That is the
    //    green-by-suppression shape, and it is worse than a loud unknown.
    if (counts.liveOpenRows === 0) {
      state.lastOutcome = 'no-open-rows';
    } else if (!ledgerUsable) {
      state.lastOutcome = 'ledger-unusable';
    } else if (observeOnly) {
      state.lastOutcome = 'observe-only';
    } else if (counts.zombieOpenRows === 0) {
      state.lastOutcome = 'clean';
    } else if (state.lastApplied.retracted + state.lastApplied.closesBackfilled > 0) {
      state.lastOutcome = 'repaired';
    } else if (state.lastApplied.refused > 0) {
      // The fold rejected every write it was offered. That is TRA-3485's stop
      // signal (the row was already CLOSED or is unknown to the fold), not a
      // quiet hold, and collapsing it into 'held-young' would name the wrong
      // cause on the one outcome that means the partition disagreed with the store.
      state.lastOutcome = 'refused';
    } else {
      // Zombies exist, nothing was written, and the ledger is fine: every one of
      // them is under the age floor (or the fold refused it). Distinct from
      // 'clean' on purpose.
      state.lastOutcome = 'held-young';
    }

    if (counts.zombieOpenRows > 0 || state.lastApplied.refused > 0) {
      log.warn('zombie open journal rows detected', {
        issue: 'TRA-3547',
        outcome: state.lastOutcome,
        ...counts,
        applied: state.lastApplied,
      });
    }
  } catch (err) {
    state.lastOutcome = 'error';
    state.lastError = err instanceof Error ? err.message : String(err);
    log.warn('zombie open journal sweep failed', { issue: 'TRA-3547', reason: state.lastError });
  }

  return getZombieOpenSweepState();
}
