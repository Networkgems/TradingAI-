// TRA-4711 (parent TRA-4230) — retract DEMO journal rows whose contract has
// expired and which no book holds.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
// The journal OPEN is appended to `/data` the instant a paper position opens;
// the BOOK that owns the position only reaches disk on the 1s-debounced
// snapshot (and on the SIGTERM flush). A process that dies between the two
// keeps the row and loses the position. Every close path — tp/sl/time_stop/
// chandelier/manual, and the covered-write expiry settle — keys on a position
// the restored book no longer has, so the row reads `outcome: 'OPEN'` forever.
//
// Measured on bqb1 2026-09-18 (b6c8b057): five desk demo rows, all July, all
// 31-38 DTE. Four of them were written inside the last ~70s of an outgoing
// instance: CRNX 07-20T13:58:46Z (deploy 9af61a9d live 13:59:27Z) and
// LION/RUN/GIS 07-21T17:06:57Z (deploy fa2a874f live 17:08:10Z). The fifth,
// LCID `dacac494` (07-15T18:06:59Z), has no deploy beside it, but the same book
// opened the SAME OCC again at 18:10:56Z as `44b2b4fc` — and the open path
// dedupes by OCC, so by 18:10 no book held `dacac494`. A no-deploy restart
// (the watchdog's pm2 self-restart writes no deploy record) fits.
//
// The live twin of this is TRA-3547's zombie sweep, which judges a live row
// against broker fills. A demo row has no broker, so the only discriminator is
// the one used here: the contract is DEAD (OCC expiry before today, ET) and no
// in-process book holds a position whose journal id is this row's id. A dead
// contract cannot be traded, marked or closed by anything, so there is nothing
// left to wait for.
//
// ── WHY VOID, NOT CLOSE ──────────────────────────────────────────────────────
// The position left the book with no exit, no mark and no P&L. A CLOSE would
// need an invented exit price, and the invented R would then feed the learner
// and every desk rollup as if the engine had managed the trade. The `void` line
// retracts the row through the replay fold (the file never rewrites a byte) and
// its witness is served back as `voids.recent[]` with this reason.
//
// ── WHAT IT REFUSES ──────────────────────────────────────────────────────────
// - A row a book still HOLDS is never voided, expired or not. That is a
//   different defect (nothing settles an expired LONG single leg — there is no
//   DTE exit), it is the book's to close, and it is counted as `heldExpired` and
//   named rather than silently skipped.
// - No books booted ⇒ nothing is "held" by construction ⇒ no writes.
// - A row without a parseable OCC (multi-leg, legacy import) is counted as
//   `unparseable`, never guessed at — unless the DTE bound below proves it dead.
//
// ── TRA-4721: THE DTE BOUND (rows with no OCC) ───────────────────────────────
// 28 demo rows (2026-06-25..07-10: single_leg_rv, iron_condor, bear_put_spread,
// single_leg_otm) pre-date OCC/account attribution, so the OCC test above cannot
// read them. Their own OPEN carries `openTs` and `entryDte`, the days from open
// to the (single) expiry every engine structure uses — no engine path opens a
// calendar/diagonal. `ET date(openTs) + entryDte` IS the expiry; the sweep adds
// a {@link DTE_BOUND_MARGIN_DAYS} margin on top so a rounding or ET/UTC
// boundary in how `entryDte` was computed can never void a live contract, and
// voids under its OWN reason so the witness says which proof was used.
// Refused (stays `unparseable`): a `tradier_import` row (its `openTs` is the
// broker's OCC-level aggregate and is not the position's open — see
// `OptionTradeJournalOpen`'s TRA-4025 write-time field), any structure whose name says it
// has more than one expiry, and a non-finite/negative `openTs`/`entryDte`. The
// held check is by journal id across every booted book, so it applies to these
// rows exactly as to the OCC ones — a row a book holds is never voided.
// - Live rows are out of scope: TRA-3547 owns them, with broker truth.

import {
  journalIdForPosition,
  TRADIER_IMPORT_STRUCTURE,
  type OptionTradeJournalRecord,
} from './option-trade-journal.js';
import { etDateString } from './scheduler.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'expired-demo-orphan-sweep' });

/** The reason every retraction carries into the void witness. */
export const EXPIRED_DEMO_ORPHAN_REASON = 'tra4711_expired_orphan_demo';

/** TRA-4721 — the reason a DTE-bound (no-OCC) retraction carries. */
export const EXPIRED_DEMO_ORPHAN_DTE_BOUND_REASON = 'tra4721_dte_bound_expired_orphan_demo';

/** TRA-4721 — days added past `openTs + entryDte` before a no-OCC row is called dead. */
export const DTE_BOUND_MARGIN_DAYS = 7;

const MULTI_EXPIRY_STRUCTURE = /calendar|diagonal/i;

function addDaysToYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * TRA-4721 — for a row with no OCC, the latest date its contract can still
 * trade: `ET date(openTs) + ceil(entryDte) + DTE_BOUND_MARGIN_DAYS`. Null when
 * the row's own fields cannot bound it (see the header for what is refused).
 */
export function dteBoundExpiryDate(
  row: Pick<OptionTradeJournalRecord, 'openTs' | 'entryDte' | 'structure'>,
): string | null {
  if (row.structure === TRADIER_IMPORT_STRUCTURE) return null;
  if (MULTI_EXPIRY_STRUCTURE.test(row.structure ?? '')) return null;
  if (typeof row.openTs !== 'number' || !Number.isFinite(row.openTs) || row.openTs <= 0) return null;
  if (typeof row.entryDte !== 'number' || !Number.isFinite(row.entryDte) || row.entryDte < 0) return null;
  return addDaysToYmd(etDateString(new Date(row.openTs)), Math.ceil(row.entryDte) + DTE_BOUND_MARGIN_DAYS);
}

/** Env kill switch — measure and publish, write nothing. */
export function isExpiredDemoOrphanSweepObserveOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env['EXPIRED_DEMO_ORPHAN_SWEEP_OBSERVE_ONLY'] ?? '').toLowerCase() === 'true';
}

/**
 * The expiry date (`YYYY-MM-DD`) encoded in an OCC symbol, or null. The root is
 * variable-length (`SPXW`, `BRKB`), so the parse anchors on the fixed 15-char
 * tail: YYMMDD + C/P + 8-digit strike.
 */
export function occExpiryDate(optionSymbol: string | null | undefined): string | null {
  if (!optionSymbol) return null;
  const m = /(\d{2})(\d{2})(\d{2})[CP]\d{8}$/.exec(optionSymbol);
  if (!m) return null;
  const [, yy, mm, dd] = m;
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `20${yy}-${mm}-${dd}`;
}

export type ExpiredDemoOrphanTreatment = 'void' | 'void_dte_bound' | 'held_expired' | 'live' | 'unparseable';

export interface ExpiredDemoOrphanPlanRow {
  id: string;
  symbol: string;
  optionSymbol: string | null;
  account: string | null;
  /** OCC expiry, or — on a `void_dte_bound` / DTE-bounded held row — the DTE bound (margin included). */
  expiry: string | null;
  treatment: ExpiredDemoOrphanTreatment;
}

export interface ExpiredDemoOrphanPlan {
  /** Demo rows reading `OPEN`. */
  demoOpenRows: number;
  /** Expired and held by no book — the alarm number, and what gets voided. Includes `dteBoundOrphans`. */
  orphans: number;
  /** TRA-4721 — the subset of `orphans` proven dead by the DTE bound (no OCC). */
  dteBoundOrphans: number;
  /** Expired but a book still holds the position. Never voided. */
  heldExpired: number;
  /** Contract not yet expired. */
  live: number;
  /** No OCC to read an expiry from, and the DTE bound could not prove it dead either. */
  unparseable: number;
  rows: ExpiredDemoOrphanPlanRow[];
}

/**
 * Pure partition. `today` is the ET calendar date; a contract whose expiry is
 * strictly before it can no longer trade. The expiry day itself stays `live` —
 * the position may still be exited that session.
 */
export function planExpiredDemoOrphans(
  rows: readonly OptionTradeJournalRecord[],
  heldJournalIds: ReadonlySet<string>,
  today: string,
): ExpiredDemoOrphanPlan {
  const plan: ExpiredDemoOrphanPlan = {
    demoOpenRows: 0,
    orphans: 0,
    dteBoundOrphans: 0,
    heldExpired: 0,
    live: 0,
    unparseable: 0,
    rows: [],
  };
  for (const r of rows) {
    if (r.mode !== 'demo' || r.outcome !== 'OPEN') continue;
    plan.demoOpenRows += 1;
    const occExpiry = occExpiryDate(r.optionSymbol);
    const bound = occExpiry === null ? dteBoundExpiryDate(r) : null;
    const expiry = occExpiry ?? bound;
    let treatment: ExpiredDemoOrphanTreatment;
    if (occExpiry === null && (bound === null || bound >= today)) {
      // No OCC, and the bound either cannot be computed or does not yet prove
      // the contract dead. Never guessed at.
      treatment = 'unparseable';
      plan.unparseable += 1;
    } else if (expiry === null) {
      treatment = 'unparseable';
      plan.unparseable += 1;
    } else if (expiry >= today) {
      treatment = 'live';
      plan.live += 1;
    } else if (heldJournalIds.has(r.id)) {
      treatment = 'held_expired';
      plan.heldExpired += 1;
    } else if (occExpiry === null) {
      treatment = 'void_dte_bound';
      plan.orphans += 1;
      plan.dteBoundOrphans += 1;
    } else {
      treatment = 'void';
      plan.orphans += 1;
    }
    if (treatment === 'void' || treatment === 'void_dte_bound' || treatment === 'held_expired') {
      plan.rows.push({
        id: r.id,
        symbol: r.symbol,
        optionSymbol: r.optionSymbol ?? null,
        account: r.account ?? null,
        expiry,
        treatment,
      });
    }
  }
  return plan;
}

export type ExpiredDemoOrphanOutcome =
  | 'never-run'
  | 'disabled'
  | 'no-books'
  | 'clean'
  | 'repaired'
  | 'refused'
  | 'held-expired'
  | 'observe-only'
  | 'error';

export interface ExpiredDemoOrphanSweepState {
  ticks: number;
  lastRunAt: string | null;
  lastOutcome: ExpiredDemoOrphanOutcome;
  lastError: string | null;
  /** FALSE until a tick has enumerated rows against booted books. */
  checked: boolean;
  observeOnly: boolean;
  booksScanned: number | null;
  counts: Omit<ExpiredDemoOrphanPlan, 'rows'> | null;
  lastApplied: { voided: number; refused: number };
  lifetime: { voided: number; refused: number };
  lastRows: (ExpiredDemoOrphanPlanRow & { applied: boolean; reason: string })[];
}

const ROW_EVIDENCE_MAX = 40;

const state: ExpiredDemoOrphanSweepState = {
  ticks: 0,
  lastRunAt: null,
  lastOutcome: 'never-run',
  lastError: null,
  checked: false,
  observeOnly: false,
  booksScanned: null,
  counts: null,
  lastApplied: { voided: 0, refused: 0 },
  lifetime: { voided: 0, refused: 0 },
  lastRows: [],
};

export function getExpiredDemoOrphanSweepState(): ExpiredDemoOrphanSweepState {
  return { ...state, lastRows: state.lastRows.map((r) => ({ ...r })) };
}

export function resetExpiredDemoOrphanSweepStateForTests(): void {
  state.ticks = 0;
  state.lastRunAt = null;
  state.lastOutcome = 'never-run';
  state.lastError = null;
  state.checked = false;
  state.observeOnly = false;
  state.booksScanned = null;
  state.counts = null;
  state.lastApplied = { voided: 0, refused: 0 };
  state.lifetime = { voided: 0, refused: 0 };
  state.lastRows = [];
}

export interface ExpiredDemoOrphanSweepDeps {
  journalEnabled: () => boolean;
  listDemoJournalRows: () => Promise<OptionTradeJournalRecord[]>;
  /** One entry per booted book: the open positions it holds (both Tradier envs). */
  listBookOpenPositions: () => Array<Array<{ id: string; journalId?: string }>>;
  /** Returns FALSE when the fold refused (row unknown or no longer OPEN). */
  recordVoid: (id: string, reason: string, book: string | null) => Promise<boolean>;
  now?: () => number;
  observeOnly?: () => boolean;
}

/** One tick. Never throws. */
export async function runExpiredDemoOrphanSweep(
  deps: ExpiredDemoOrphanSweepDeps,
): Promise<ExpiredDemoOrphanSweepState> {
  const now = deps.now ?? Date.now;
  const observeOnly = (deps.observeOnly ?? isExpiredDemoOrphanSweepObserveOnly)();
  state.ticks += 1;
  state.lastRunAt = new Date(now()).toISOString();
  state.lastError = null;
  state.observeOnly = observeOnly;
  state.lastApplied = { voided: 0, refused: 0 };

  try {
    if (!deps.journalEnabled()) {
      state.lastOutcome = 'disabled';
      state.counts = null;
      state.lastRows = [];
      return getExpiredDemoOrphanSweepState();
    }

    const books = deps.listBookOpenPositions();
    state.booksScanned = books.length;
    if (books.length === 0) {
      // Every row would read "held by no book" — which is a fact about boot
      // order, not about the rows.
      state.lastOutcome = 'no-books';
      state.checked = false;
      state.counts = null;
      state.lastRows = [];
      return getExpiredDemoOrphanSweepState();
    }
    const held = new Set<string>();
    for (const book of books) for (const p of book) held.add(journalIdForPosition(p));

    const plan = planExpiredDemoOrphans(
      await deps.listDemoJournalRows(),
      held,
      etDateString(new Date(now())),
    );
    const { rows, ...counts } = plan;
    state.counts = counts;
    state.checked = true;

    const evidence: ExpiredDemoOrphanSweepState['lastRows'] = [];
    for (const row of rows) {
      if (row.treatment === 'held_expired') {
        evidence.push({ ...row, applied: false, reason: 'expired but a book still holds it; the book owns the close' });
        continue;
      }
      if (observeOnly) {
        evidence.push({ ...row, applied: false, reason: 'observe-only: measured, not written' });
        continue;
      }
      const dteBound = row.treatment === 'void_dte_bound';
      const ok = await deps.recordVoid(
        row.id,
        dteBound ? EXPIRED_DEMO_ORPHAN_DTE_BOUND_REASON : EXPIRED_DEMO_ORPHAN_REASON,
        row.account,
      );
      if (ok) {
        state.lastApplied.voided += 1;
        state.lifetime.voided += 1;
      } else {
        state.lastApplied.refused += 1;
        state.lifetime.refused += 1;
      }
      evidence.push({
        ...row,
        applied: ok,
        reason: ok
          ? dteBound
            ? `retracted through the replay fold: no OCC; openTs + entryDte + ${DTE_BOUND_MARGIN_DAYS}d = ${row.expiry} is past, held by none of ${books.length} books`
            : `retracted through the replay fold: contract expired ${row.expiry}, held by none of ${books.length} books`
          : 'REFUSED by the fold (row unknown or no longer OPEN)',
      });
    }
    state.lastRows = evidence.slice(0, ROW_EVIDENCE_MAX);

    if (counts.orphans === 0 && counts.heldExpired === 0) state.lastOutcome = 'clean';
    else if (observeOnly && counts.orphans > 0) state.lastOutcome = 'observe-only';
    else if (state.lastApplied.voided > 0) state.lastOutcome = 'repaired';
    else if (state.lastApplied.refused > 0) state.lastOutcome = 'refused';
    else state.lastOutcome = 'held-expired';

    if (counts.orphans > 0 || counts.heldExpired > 0) {
      log.warn('expired demo journal rows detected', {
        issue: 'TRA-4711',
        outcome: state.lastOutcome,
        ...counts,
        applied: state.lastApplied,
      });
    }
  } catch (err) {
    state.lastOutcome = 'error';
    state.lastError = err instanceof Error ? err.message : String(err);
    log.warn('expired demo orphan sweep failed', { issue: 'TRA-4711', reason: state.lastError });
  }

  return getExpiredDemoOrphanSweepState();
}
