// TRA-4082 — DETACH a rebound lot's close off its sibling's journal row.
//
// ── The measured incident (bqb1 `56804e1a` pid 75, RIG260925C00006000) ───────
//
//   2026-08-21T18:04:24.494Z  engine lot opens; journal row `8a849902`, basis 0.33.
//   2026-08-21T18:04:24.851Z  the desk adds 1 ct; the reconciler MINTS residual
//                             `96b0dc72` (`residual_identity` 0.22) and the
//                             TRA-2937 rebind puts it on `8a849902` — one row,
//                             two lots.
//   2026-08-24T15:15:55.327Z  engine lot exits, `sl_otm_premium_pct` 0.33→0.18,
//                             order 143048620, −$15.24, R −0.4618. The row closes.
//   2026-08-26T13:45:31.275Z  residual exits, `profit_lock` 0.22→0.15, order
//                             143384264, −$7. `queueJournalClose` finds the row
//                             CLOSED 1.9 days earlier and — by TRA-4004's rule,
//                             right for one position and wrong for two —
//                             SUPERSEDES: the 08-24 fill drops into
//                             `supersededCloses[]`, and `/api/trades/export`
//                             serves one RIG row where it served two.
//
// The forward fix lives in `options-account.ts` (a desk-add lot never rebinds;
// a witnessed close under another order is never superseded). This module is
// the REPAIR for the row that already moved: restore the sibling's own close as
// the row's primary, and give the rebound lot its own row carrying the close
// that displaced it. Both fills export again; nothing is deleted — the store is
// append-only and the move is auditable from the two rows alone.
//
// ── Shape, and why it is this shape ───────────────────────────────────────────
//
// The journal has three primitives that reach a closed row: `open` (a new row),
// `close` (settle an OPEN row once) and `supersede_close` (replace a close and
// keep the replaced one on the row). The restore is therefore a SUPERSEDE back
// to the original close: after it, `supersededCloses[]` on the sibling's row
// holds BOTH the original (from the wrongful supersession) and the moved close
// (from this one, `reason: admin_detach_restore:…:moved_to:<lotId>`), and the
// primary is the original again. A reader of `supersededCloses[]` sees the
// primary's own order id echoed in an entry; that is the audit trail, not a
// duplicate — `tra3485-stale-open-repair` already claims nothing from that
// array, and the export reads the primary only.
//
// Pure planner + separate apply, so the dry run and the write share ONE refusal
// set and a dry run cannot disagree with the write it previews.
import {
  getOptionTradeJournalRecord,
  recordOptionTradeOpen,
  recordOptionTradeClose,
  recordOptionTradeCloseSupersede,
  outcomeForR,
  TRADIER_IMPORT_STRUCTURE,
  type OptionTradeJournalRecord,
  type OptionTradeJournalClose,
  type OptionTradeJournalOpen,
  type OptionTradeSupersededClose,
  type OptionTradeCloseWriteResult,
} from './option-trade-journal.js';

const MS_PER_DAY = 86_400_000;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

export interface DetachReboundCloseRequest {
  /** The SHARED row — the sibling's (`8a849902` on the incident). */
  journalId: string;
  /** The rebound lot's own position id — becomes its journal row id (`96b0dc72`). */
  lotId: string;
  /** The lot's own `openedAt` (ms epoch). */
  lotOpenTs: number;
  /** Per-contract basis the MOVED close was priced against (the residual's 0.22). */
  lotBasisPremium: number;
  /** Which entry of `supersededCloses[]` to restore as the row's primary — by broker order. */
  restoreBrokerOrderId: string | number;
  /** Optional: the restored close's own entry basis (TRA-4031 column), e.g. the engine lot's 0.33. */
  restoreEntryBasisPremium?: number;
  /** Must name a ticket (`TRA-nnnn`). */
  provenance: string;
}

export type DetachReboundCloseRefusal =
  | 'bad_request'
  | 'lot_is_row'
  | 'unknown_row'
  | 'row_open'
  | 'row_unjoinable'
  | 'lot_row_exists'
  | 'no_superseded_closes'
  | 'restore_close_not_found'
  | 'primary_is_restore_order'
  | 'primary_has_no_broker_order';

export interface DetachReboundClosePlan {
  ok: true;
  journalId: string;
  lotId: string;
  /** The rebound lot's own OPEN row. */
  open: OptionTradeJournalOpen;
  /** The close currently on the shared row, re-based onto the lot's own row. */
  movedClose: OptionTradeJournalClose;
  /** The sibling's own close, restored as the shared row's primary. */
  restoreClose: OptionTradeJournalClose;
  /** The `supersededCloses[]` entry `restoreClose` was read from. */
  restoredFrom: OptionTradeSupersededClose;
  reason: string;
}

export type DetachReboundClosePlanResult =
  | DetachReboundClosePlan
  | { ok: false; refusal: DetachReboundCloseRefusal; detail: string };

/**
 * Plan the detach. Pure: reads the two records it is handed and returns either
 * the three writes or a named refusal. Refuses anything but the incident's
 * exact shape — a CLOSED row whose primary close is a witnessed broker fill
 * under one order, carrying in `supersededCloses[]` an earlier close under a
 * DIFFERENT order, and a lot id the journal has never seen.
 */
export function planDetachReboundClose(
  rec: OptionTradeJournalRecord | null | undefined,
  lotRow: OptionTradeJournalRecord | null | undefined,
  req: DetachReboundCloseRequest,
  now: number,
): DetachReboundClosePlanResult {
  const refuse = (refusal: DetachReboundCloseRefusal, detail: string): DetachReboundClosePlanResult =>
    ({ ok: false, refusal, detail });

  if (typeof req.journalId !== 'string' || req.journalId === '') return refuse('bad_request', 'journalId must be a non-empty string');
  if (typeof req.lotId !== 'string' || req.lotId === '') return refuse('bad_request', 'lotId must be a non-empty string');
  if (!(Number.isFinite(req.lotOpenTs) && req.lotOpenTs > 0)) return refuse('bad_request', 'lotOpenTs must be a positive ms epoch');
  if (!(Number.isFinite(req.lotBasisPremium) && req.lotBasisPremium > 0)) return refuse('bad_request', 'lotBasisPremium must be > 0');
  if (!(typeof req.restoreBrokerOrderId === 'string' || typeof req.restoreBrokerOrderId === 'number')) {
    return refuse('bad_request', 'restoreBrokerOrderId must name the superseded close to restore');
  }
  if (req.restoreEntryBasisPremium !== undefined
    && !(Number.isFinite(req.restoreEntryBasisPremium) && req.restoreEntryBasisPremium > 0)) {
    return refuse('bad_request', 'restoreEntryBasisPremium, when given, must be > 0');
  }
  if (typeof req.provenance !== 'string' || !/TRA-\d+/.test(req.provenance)) return refuse('bad_request', 'provenance must cite a TRA-nnnn ticket');
  if (req.lotId === req.journalId) return refuse('lot_is_row', 'the lot IS the row; nothing to detach');
  if (!rec) return refuse('unknown_row', `no journal row under ${req.journalId}`);
  if (rec.outcome === 'OPEN') return refuse('row_open', 'the row is OPEN; a detach moves a CLOSE');
  if (!rec.optionSymbol || !Number.isFinite(rec.contracts) || !(rec.contracts! > 0)) {
    return refuse('row_unjoinable', 'the row carries no optionSymbol/contracts; the lot row cannot be sized');
  }
  if (lotRow) return refuse('lot_row_exists', `a journal row already exists under ${req.lotId} (outcome ${lotRow.outcome})`);
  const superseded = rec.supersededCloses ?? [];
  if (superseded.length === 0) return refuse('no_superseded_closes', 'the row carries no superseded close to restore');
  const primaryOrder = rec.brokerOrderId ?? null;
  if (primaryOrder === null) {
    return refuse('primary_has_no_broker_order', 'the row\'s primary close is not a witnessed broker fill; that is TRA-4004\'s shape, not this one');
  }
  if (String(primaryOrder) === String(req.restoreBrokerOrderId)) {
    return refuse('primary_is_restore_order', `the row's primary close already carries order ${String(primaryOrder)}; nothing to move`);
  }
  // Most recently superseded entry under that order wins — the same close can
  // only be demoted once per supersession, and the latest is the one that
  // describes the row as it stood before the wrongful move.
  const restoredFrom = [...superseded].reverse().find((s) => String(s.brokerOrderId ?? '') === String(req.restoreBrokerOrderId));
  if (!restoredFrom) {
    return refuse('restore_close_not_found', `no superseded close under order ${String(req.restoreBrokerOrderId)} on the row (have: ${superseded.map((s) => String(s.brokerOrderId ?? 'null')).join(', ')})`);
  }
  if (!(Number.isFinite(rec.closeTs) && (rec.closeTs as number) >= req.lotOpenTs)) {
    return refuse('bad_request', 'the row\'s primary close precedes lotOpenTs; it cannot be the lot\'s');
  }

  const contracts = rec.contracts as number;
  const atRiskUsd = round2(req.lotBasisPremium * contracts * 100);
  const open: OptionTradeJournalOpen = {
    id: req.lotId,
    openTs: req.lotOpenTs,
    symbol: rec.symbol,
    structure: TRADIER_IMPORT_STRUCTURE,
    mode: rec.mode,
    ivRank: null,
    trend: 'unknown',
    sentiment: null,
    sentimentIcBand: null,
    entryDelta: 0,
    entryDte: Math.max(0, Math.round(rec.entryDte - (req.lotOpenTs - rec.openTs) / MS_PER_DAY)),
    atRiskUsd,
    // The basis is the operator's statement of what the close was priced
    // against, not a ledger fill — say so, and name the row it came off.
    atRiskBasis: 'mark',
    atRiskProvenance: `detached_from:${req.journalId}:${req.provenance}`,
    agentConviction: null,
    optionSymbol: rec.optionSymbol,
    contracts,
    ...(rec.account ? { account: rec.account } : {}),
    mintedAt: now,
    riskThrottleMultiplier: 1,
    riskThrottleDecided: 1,
    riskThrottleSizingPath: null,
  };

  const movedPnl = rec.realizedPnlUsd as number;
  const movedR = atRiskUsd > 0 ? round4(movedPnl / atRiskUsd) : 0;
  const movedClose: OptionTradeJournalClose = {
    closeTs: rec.closeTs as number,
    outcome: outcomeForR(movedR),
    realizedPnlUsd: movedPnl,
    realizedR: movedR,
    exitReason: rec.exitReason ?? '',
    holdDays: Math.max(0, ((rec.closeTs as number) - req.lotOpenTs) / MS_PER_DAY),
    ...(rec.exitSlippageUsd !== undefined ? { exitSlippageUsd: rec.exitSlippageUsd } : {}),
    brokerOrderId: primaryOrder,
    entryBasisPremium: typeof rec.entryBasisPremium === 'number' && rec.entryBasisPremium > 0
      ? rec.entryBasisPremium
      : req.lotBasisPremium,
    // ⛔ peakPremium / openingRangeSuppressed / markProvenance / PDT hold are
    // NOT carried: the supersede fold kept the ORIGINAL close's copies on the
    // record, so which lot they describe is not knowable from the row. A
    // reconstructed provenance is a fabricated column (TRA-4055).
  };

  const restoreClose: OptionTradeJournalClose = {
    closeTs: restoredFrom.closeTs,
    outcome: restoredFrom.outcome,
    realizedPnlUsd: restoredFrom.realizedPnlUsd,
    realizedR: restoredFrom.realizedR,
    exitReason: restoredFrom.exitReason,
    holdDays: Math.max(0, (restoredFrom.closeTs - rec.openTs) / MS_PER_DAY),
    brokerOrderId: restoredFrom.brokerOrderId,
    ...(req.restoreEntryBasisPremium !== undefined ? { entryBasisPremium: req.restoreEntryBasisPremium } : {}),
  };

  return {
    ok: true,
    journalId: req.journalId,
    lotId: req.lotId,
    open,
    movedClose,
    restoreClose,
    restoredFrom,
    reason: `admin_detach_restore:${req.provenance}:moved_to:${req.lotId}`,
  };
}

export interface DetachReboundCloseApplyResult {
  ok: boolean;
  /** `recordOptionTradeOpen` — false means a row appeared under the lot id between plan and apply. */
  opened: boolean;
  closed: OptionTradeCloseWriteResult | null;
  restored: { applied: boolean; refusal: string | null } | null;
  row: OptionTradeJournalRecord | null | undefined;
  lot: OptionTradeJournalRecord | null | undefined;
}

/**
 * Apply a plan, in the order that leaves the least damage if a step refuses:
 * the lot's OPEN row first (nothing on the shared row has moved yet), then its
 * CLOSE, and only then the restore on the shared row. Every step's verdict is
 * returned; a false/refused step stops the sequence.
 */
export async function applyDetachReboundClose(
  plan: DetachReboundClosePlan,
  now: number,
): Promise<DetachReboundCloseApplyResult> {
  const opened = await recordOptionTradeOpen(plan.open);
  if (!opened) {
    return { ok: false, opened, closed: null, restored: null, row: await getOptionTradeJournalRecord(plan.journalId), lot: await getOptionTradeJournalRecord(plan.lotId) };
  }
  const closed = await recordOptionTradeClose(plan.lotId, plan.movedClose);
  if (closed !== 'written') {
    return { ok: false, opened, closed, restored: null, row: await getOptionTradeJournalRecord(plan.journalId), lot: await getOptionTradeJournalRecord(plan.lotId) };
  }
  const restored = await recordOptionTradeCloseSupersede(
    plan.journalId,
    plan.restoreClose,
    { reason: plan.reason, issue: 'TRA-4082' },
    now,
  );
  return {
    ok: restored.applied,
    opened,
    closed,
    restored,
    row: await getOptionTradeJournalRecord(plan.journalId),
    lot: await getOptionTradeJournalRecord(plan.lotId),
  };
}

/** The fields a before/after paired read of a row should show. */
export function summarizeDetachRow(rec: OptionTradeJournalRecord | null | undefined): Record<string, unknown> | null {
  if (!rec) return null;
  return {
    id: rec.id,
    outcome: rec.outcome,
    openTs: rec.openTs,
    closeTs: rec.closeTs ?? null,
    exitReason: rec.exitReason ?? null,
    realizedPnlUsd: rec.realizedPnlUsd ?? null,
    realizedR: rec.realizedR ?? null,
    atRiskUsd: rec.atRiskUsd,
    atRiskProvenance: rec.atRiskProvenance ?? null,
    brokerOrderId: rec.brokerOrderId ?? null,
    entryBasisPremium: rec.entryBasisPremium ?? null,
    supersededCloses: rec.supersededCloses ?? [],
  };
}
