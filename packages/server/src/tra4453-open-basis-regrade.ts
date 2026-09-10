// TRA-4453 (parent TRA-4028) — RE-GRADE an import row's `atRiskBasis: 'mark'`
// against the fill ledger as it stands NOW. The one grade the row got was taken
// against a ledger that did not yet hold the fill it needed.
//
// ── The measured defect (bqb1 `8e51be03261c`, read 2026-09-09T21:3xZ) ────────
//
//   2026-08-28T14:36:02.948Z  engine `buy_to_open` 1 @ 0.73 (order 143816913),
//                             claimed by engine row `7e6fef50`.
//   2026-08-28T19:49:00.538Z  reconciler MINTS desk row `a2f9c8cd` at $57. The
//                             ledger's only buy on NOK261002C00010500 is the
//                             engine's, already claimed ⇒ the remainder is empty
//                             ⇒ `mark:no_unclaimed_buys`. CORRECT on that ledger.
//   later (an hourly tick)    the fee reconcile imports the desk's own buy,
//                             1 @ 0.57, `history_import`, synthetic stamp
//                             2026-08-28T17:00:00Z — BEFORE the mint on paper,
//                             AFTER it in fact. Nothing ever re-asked.
//
// $57 IS the 0.57 fill; the row's R divides by the right number and labels it
// `mark`, so TRA-4035's export publishes `premium-open-mark` over a fill
// divisor and every fill/mark cohort split reads the row into the wrong bucket.
// The only ledger writer of `history_import` rows is `importMissingLiveOptionFills`
// inside `runLiveOptionsFeeReconcile` (boot + 90s, then the ET hourly tick), and
// it can only import what broker `/history` already publishes. So the backfill
// is bounded BELOW by an external lag we do not control, and a delayed mint cannot
// be made safe; a re-grade after every backfill can.
//
// ── Why "the current ledger" is BOUNDED at the lot's own instant ─────────────
//
// Measured live 2026-09-10T05:55Z: running `resolveImportOpenBasis` on the WHOLE
// current ledger returns `unclaimed_sells` for BOTH live mark rows, not `fill`.
// Each lot has since CLOSED and its own exit now sits on the ledger, and the
// resolver (written for a mint, when the lot is open) cannot tell that sell from
// one that consumed somebody else's buy. NOK's exit cannot even be claimed by
// the TRA-3986 exit rule: its close (order 144350660) reached the ledger only as
// a `history_import` sell with `orderId: null` and a synthetic 17:00:00Z stamp.
//
// So the re-grade asks the MINT's question with the fills the mint was entitled
// to see: every fill on the contract before the lot's instant
// `min(mintedAt, closeTs)`, minus the row's own exit by the TRA-3986 exit rule.
// A `tsSynthetic` fill has date resolution only, so it is compared by ET day and
// KEPT on the instant's own day. That errs toward MORE fills (toward
// `remainder_excess` / `unclaimed_sells`), never toward a fill the lot did not own.
// The resolver's decision rule is untouched; only its ledger is fresher.
//
// ── What moves, and what never does ──────────────────────────────────────────
//
// Promote only when the ledger now attributes a fill AND its dollars equal the
// figure already on the row to the cent. That is two independent instruments
// agreeing on one number: the book figure at the mint (residual identity or
// broker basis) and the ledger allocation now. The amend is then LABEL-ONLY:
// `atRiskUsd`, `realizedR` and the outcome stay byte-identical (the fold's
// label-only branch, option-trade-journal.ts). A fill that DISAGREES is a
// denominator change on a real-money row, so it is surfaced and NEVER
// auto-applied. The TRA-4028 witness route is the path for it.
//
// Which `'mark'` rows are eligible:
//   • recoverable — `mark:no_ledger_fills|no_unclaimed_buys|remainder_short`:
//     statements about what the ledger did NOT YET hold.
//   • unconsulted — a `'mark'` whose provenance is not `mark:<reason>` at all.
//     The resolver never ran (the TRA-4082 detach writes `detached_from:…` with a
//     hard-coded `'mark'`), so this is the row's FIRST decision, not a re-grade.
//   • everything else is left alone — `demo_book`, `no_contract_identity`,
//     `unclaimed_sells`, `remainder_excess`, `unpriced_fill` are statements about
//     ambiguity, not about ledger freshness.
import type { LiveOptionFillRecord } from './live-options-fee-slippage-ledger.js';
import {
  SAME_CLOSE_TOLERANCE_MS,
  type OptionTradeJournalRecord,
  type OptionTradeOpenBasisAmendRecord,
} from './option-trade-journal.js';
import {
  resolveImportOpenBasis,
  type ImportOpenBasis,
  type ImportOpenMarkReason,
} from './tra4028-import-open-basis.js';
import { etDateString } from './scheduler.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'tra4453-open-basis-regrade' });

/** Mark reasons that describe ledger FRESHNESS — a later ledger can answer them. */
export const RECOVERABLE_MARK_REASONS: ReadonlySet<ImportOpenMarkReason> = new Set([
  'no_ledger_fills',
  'no_unclaimed_buys',
  'remainder_short',
]);

const KNOWN_MARK_REASONS: ReadonlySet<string> = new Set<ImportOpenMarkReason>([
  'demo_book',
  'no_contract_identity',
  'no_ledger_fills',
  'unclaimed_sells',
  'unpriced_fill',
  'no_unclaimed_buys',
  'remainder_short',
  'remainder_excess',
]);

/** "Within rounding": both figures are cents; half a cent is the widest gap rounding explains. */
export const REGRADE_VALUE_TOLERANCE_USD = 0.005;

export type OpenBasisRegradeClass = 'recoverable' | 'unconsulted' | 'not_recoverable';

export type OpenBasisRegradeVerdict =
  /** The ledger now attributes a fill at the row's own figure ⇒ label-only amend. */
  | 'promote'
  /** The ledger attributes a fill at a DIFFERENT figure ⇒ surfaced, never auto-amended. */
  | 'disagree'
  /** The resolver still says `'mark'` on the fresher ledger (reason in `resolved`). */
  | 'still_mark'
  /** A statement about ambiguity, not freshness ⇒ left alone. */
  | 'not_recoverable'
  /** The row carries no `mintedAt`, so the ledger cannot be bounded at its instant. */
  | 'no_lot_instant';

export interface OpenBasisRegradeRow {
  id: string;
  optionSymbol: string | null;
  mode: 'demo' | 'live';
  outcome: string;
  atRiskUsd: number;
  priorProvenance: string | null;
  basisClass: OpenBasisRegradeClass;
  /** The parsed `mark:<reason>`; null on an unconsulted row. */
  priorReason: ImportOpenMarkReason | null;
  /** `min(mintedAt, closeTs)` — the instant the ledger is read as of; null when unbounded. */
  lotInstant: number | null;
  verdict: OpenBasisRegradeVerdict;
  resolved: Pick<ImportOpenBasis, 'atRiskUsd' | 'atRiskBasis' | 'atRiskProvenance' | 'markReason' | 'fills'> | null;
  /** `resolved.atRiskUsd − atRiskUsd` on a fill verdict; null otherwise. */
  deltaUsd: number | null;
}

export interface OpenBasisRegradePlan {
  /** Every `'mark'` row, with its verdict. */
  rows: OpenBasisRegradeRow[];
  counts: Record<OpenBasisRegradeVerdict, number>;
}

function classify(rec: OptionTradeJournalRecord): { basisClass: OpenBasisRegradeClass; priorReason: ImportOpenMarkReason | null } {
  const m = /^mark:([a-z_]+)$/.exec(rec.atRiskProvenance ?? '');
  if (!m) return { basisClass: 'unconsulted', priorReason: null };
  const reason = m[1]!;
  if (!KNOWN_MARK_REASONS.has(reason)) return { basisClass: 'not_recoverable', priorReason: null };
  const r = reason as ImportOpenMarkReason;
  return { basisClass: RECOVERABLE_MARK_REASONS.has(r) ? 'recoverable' : 'not_recoverable', priorReason: r };
}

/**
 * The fills on the row's contract the lot's MINT was entitled to see: before
 * `lotInstant` (a synthetic stamp by ET day, inclusive), never the row's own
 * exit (TRA-3986 exit rule: its `brokerOrderId`, or within
 * {@link SAME_CLOSE_TOLERANCE_MS} of its `closeTs`). See the file header.
 */
export function ledgerAsOfLot(
  rec: OptionTradeJournalRecord,
  fills: readonly LiveOptionFillRecord[],
  lotInstant: number,
): LiveOptionFillRecord[] {
  const instantDay = etDateString(new Date(lotInstant));
  const closed = rec.outcome !== 'OPEN';
  const closeTs = closed && typeof rec.closeTs === 'number' && Number.isFinite(rec.closeTs) ? rec.closeTs : null;
  const ownOrder = closed && rec.brokerOrderId != null ? String(rec.brokerOrderId) : null;
  return fills.filter((f) => {
    if (f.optionSymbol !== rec.optionSymbol) return false;
    const ownExit = f.side === 'sell_to_close'
      && ((ownOrder !== null && f.orderId != null && String(f.orderId) === ownOrder)
        || (closeTs !== null && Math.abs(f.ts - closeTs) <= SAME_CLOSE_TOLERANCE_MS));
    if (ownExit) return false;
    const synthetic = f.tsSynthetic ?? f.origin === 'history_import';
    return synthetic ? f.etDay <= instantDay : f.ts <= lotInstant;
  });
}

/** Grade ONE `'mark'` row against the ledger. Pure. */
export function regradeOpenBasisRow(
  rec: OptionTradeJournalRecord,
  rows: readonly OptionTradeJournalRecord[],
  fills: readonly LiveOptionFillRecord[],
): OpenBasisRegradeRow {
  const { basisClass, priorReason } = classify(rec);
  const closeTs = rec.outcome !== 'OPEN' && typeof rec.closeTs === 'number' && Number.isFinite(rec.closeTs) ? rec.closeTs : null;
  const mintedAt = typeof rec.mintedAt === 'number' && Number.isFinite(rec.mintedAt) ? rec.mintedAt : null;
  const lotInstant = mintedAt === null ? null : closeTs === null ? mintedAt : Math.min(mintedAt, closeTs);
  const base: OpenBasisRegradeRow = {
    id: rec.id,
    optionSymbol: rec.optionSymbol ?? null,
    mode: rec.mode,
    outcome: rec.outcome,
    atRiskUsd: rec.atRiskUsd,
    priorProvenance: rec.atRiskProvenance ?? null,
    basisClass,
    priorReason,
    lotInstant,
    verdict: 'not_recoverable',
    resolved: null,
    deltaUsd: null,
  };
  if (basisClass === 'not_recoverable') return base;
  if (lotInstant === null) return { ...base, verdict: 'no_lot_instant' };

  const contracts = typeof rec.contracts === 'number' ? rec.contracts : NaN;
  const r = resolveImportOpenBasis(
    {
      id: rec.id,
      optionSymbol: rec.optionSymbol,
      mode: rec.mode,
      contracts,
      // Only the `'mark'` fallback reads this; it reproduces the row's own figure.
      premiumPaid: contracts > 0 ? rec.atRiskUsd / (contracts * 100) : rec.atRiskUsd,
    },
    rows.filter((s) => s.optionSymbol === rec.optionSymbol && s.mode === rec.mode),
    rec.optionSymbol ? ledgerAsOfLot(rec, fills, lotInstant) : [],
  );
  const resolved = {
    atRiskUsd: r.atRiskUsd,
    atRiskBasis: r.atRiskBasis,
    atRiskProvenance: r.atRiskProvenance,
    markReason: r.markReason,
    fills: r.fills,
  };
  if (r.atRiskBasis !== 'fill') return { ...base, verdict: 'still_mark', resolved };
  const deltaUsd = Math.round((r.atRiskUsd - rec.atRiskUsd) * 100) / 100;
  const agrees = Math.abs(r.atRiskUsd - rec.atRiskUsd) <= REGRADE_VALUE_TOLERANCE_USD;
  return { ...base, verdict: agrees ? 'promote' : 'disagree', resolved, deltaUsd };
}

/** Grade every `'mark'` row in `rows` (the whole journal — siblings claim from it too). Pure. */
export function planOpenBasisRegrade(
  rows: readonly OptionTradeJournalRecord[],
  fills: readonly LiveOptionFillRecord[],
): OpenBasisRegradePlan {
  const graded = rows.filter((r) => r.atRiskBasis === 'mark').map((r) => regradeOpenBasisRow(r, rows, fills));
  const counts: Record<OpenBasisRegradeVerdict, number> = {
    promote: 0, disagree: 0, still_mark: 0, not_recoverable: 0, no_lot_instant: 0,
  };
  for (const g of graded) counts[g.verdict] += 1;
  return { rows: graded, counts };
}

// ─────────────────────────────────────────────────────────────────────────────
// The self-driving pass. Rides directly behind `runLiveOptionsFeeReconcile` (the
// only `history_import` writer), so a backfilled fill is re-graded on the same
// tick it lands. Refuses inside RTH: the TRA-3945 window re-reads each row's
// basis on its next tick, and a row must not change cohort mid-session.

export interface OpenBasisRegradeDeps {
  journalEnabled: () => boolean;
  /** The WHOLE journal, every mode — sibling rows claim fills too. */
  listRows: () => Promise<readonly OptionTradeJournalRecord[]>;
  /** The fill ledger, and whether it is durable enough to price a basis off. */
  ledger: () => { records: readonly LiveOptionFillRecord[]; usable: boolean };
  amend: (
    id: string,
    basis: { atRiskUsd: number; atRiskBasis: 'fill' | 'mark'; provenance: string },
    meta: { reason: string; issue: string },
  ) => Promise<{ applied: boolean; refusal: OptionTradeOpenBasisAmendRecord['refusal'] }>;
}

export type OpenBasisRegradeOutcome =
  | 'graded'
  | 'no_candidates'
  | 'skipped_rth'
  | 'journal_disabled'
  | 'ledger_unusable'
  | 'failed';

/** Served on `/api/health/option-journal` as `openBasisRegrade`. */
export interface OpenBasisRegradeState {
  /** Invocations since boot. 0 ⇒ the pass never ran. */
  ticks: number;
  lastRunAt: number | null;
  lastOutcome: OpenBasisRegradeOutcome | null;
  lastError: string | null;
  /** Verdict counts of the last GRADED pass (null before one). */
  lastCounts: Record<OpenBasisRegradeVerdict, number> | null;
  /** Every `'mark'` row the last graded pass saw, with its verdict (capped). */
  lastRows: OpenBasisRegradeRow[] | null;
  /** Label promotions APPLIED since boot. */
  totalPromoted: number;
  promoted: Array<{ id: string; at: number; atRiskUsd: number; provenance: string }>;
  /** Promotions the fold REFUSED since boot (a promote verdict whose amend did not land) — a finding. */
  refused: Array<{ id: string; at: number; refusal: OptionTradeOpenBasisAmendRecord['refusal'] }>;
}

export const OPEN_BASIS_REGRADE_ROW_CAP = 50;
const SINCE_BOOT_CAP = 200;

let state: OpenBasisRegradeState = emptyState();
const warnedDisagreements = new Set<string>();

function emptyState(): OpenBasisRegradeState {
  return {
    ticks: 0,
    lastRunAt: null,
    lastOutcome: null,
    lastError: null,
    lastCounts: null,
    lastRows: null,
    totalPromoted: 0,
    promoted: [],
    refused: [],
  };
}

/** Test seam. */
export function clearOpenBasisRegradeState(): void {
  state = emptyState();
  warnedDisagreements.clear();
}

export function getOpenBasisRegradeState(): OpenBasisRegradeState {
  return {
    ...state,
    lastCounts: state.lastCounts === null ? null : { ...state.lastCounts },
    lastRows: state.lastRows === null ? null : state.lastRows.map((r) => ({ ...r })),
    promoted: state.promoted.map((p) => ({ ...p })),
    refused: state.refused.map((p) => ({ ...p })),
  };
}

/** 13:30–20:00Z Mon–Fri — the same bound the TRA-4028 amend route refuses inside. */
export function insideRegularSessionUtc(nowMs: number): boolean {
  const d = new Date(nowMs);
  const dow = d.getUTCDay();
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return dow >= 1 && dow <= 5 && m >= 13 * 60 + 30 && m < 20 * 60;
}

function capPush<T>(list: T[], item: T): void {
  list.push(item);
  while (list.length > SINCE_BOOT_CAP) list.shift();
}

/** One pass. Never throws — a failure lands in the state and a log line. */
export async function runOpenBasisRegradePass(
  deps: OpenBasisRegradeDeps,
  now: number = Date.now(),
): Promise<OpenBasisRegradeState> {
  state.ticks += 1;
  state.lastRunAt = now;
  try {
    if (!deps.journalEnabled()) {
      state.lastOutcome = 'journal_disabled';
      return getOpenBasisRegradeState();
    }
    if (insideRegularSessionUtc(now)) {
      state.lastOutcome = 'skipped_rth';
      return getOpenBasisRegradeState();
    }
    const ledger = deps.ledger();
    if (!ledger.usable) {
      state.lastOutcome = 'ledger_unusable';
      return getOpenBasisRegradeState();
    }
    const plan = planOpenBasisRegrade(await deps.listRows(), ledger.records);
    for (const r of plan.rows) {
      if (r.verdict === 'promote' && r.resolved) {
        const provenance = `TRA-4453 regrade: ${r.resolved.atRiskProvenance} (was ${r.priorProvenance ?? 'unlabelled'})`;
        const res = await deps.amend(
          r.id,
          { atRiskUsd: r.atRiskUsd, atRiskBasis: 'fill', provenance },
          { reason: `regrade_open_basis:${r.priorReason ?? r.basisClass}`, issue: 'TRA-4453' },
        );
        if (res.applied) {
          state.totalPromoted += 1;
          capPush(state.promoted, { id: r.id, at: now, atRiskUsd: r.atRiskUsd, provenance });
          log.warn('import journal OPEN basis label PROMOTED mark → fill (figure unchanged)', {
            issue: 'TRA-4453', id: r.id, optionSymbol: r.optionSymbol, atRiskUsd: r.atRiskUsd,
            was: r.priorProvenance, provenance, fills: r.resolved.fills,
          });
        } else {
          capPush(state.refused, { id: r.id, at: now, refusal: res.refusal });
          log.warn('import journal OPEN basis promotion REFUSED by the fold', {
            issue: 'TRA-4453', id: r.id, refusal: res.refusal, atRiskUsd: r.atRiskUsd,
          });
        }
      } else if (r.verdict === 'disagree' && r.resolved) {
        const key = `${r.id}|${r.resolved.atRiskUsd}`;
        if (!warnedDisagreements.has(key)) {
          warnedDisagreements.add(key);
          log.warn('import journal OPEN basis: the ledger now attributes a fill that DISAGREES with the row — NOT amended', {
            issue: 'TRA-4453', id: r.id, optionSymbol: r.optionSymbol, rowAtRiskUsd: r.atRiskUsd,
            fillAtRiskUsd: r.resolved.atRiskUsd, deltaUsd: r.deltaUsd, provenance: r.resolved.atRiskProvenance,
            note: 'a denominator change on a real-money row wants a witness: POST /api/health/option-journal/amend-open-basis (TRA-4028)',
          });
        }
      }
    }
    state.lastCounts = plan.counts;
    state.lastRows = plan.rows.slice(0, OPEN_BASIS_REGRADE_ROW_CAP);
    state.lastOutcome = plan.rows.length === 0 ? 'no_candidates' : 'graded';
    state.lastError = null;
  } catch (err) {
    state.lastOutcome = 'failed';
    state.lastError = err instanceof Error ? err.message : String(err);
    log.warn('TRA-4453 open-basis regrade pass failed', { reason: state.lastError });
  }
  return getOpenBasisRegradeState();
}
