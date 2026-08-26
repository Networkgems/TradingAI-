import type { LiveOptionFillRecord } from './live-options-fee-slippage-ledger.js';
import type {
  OptionTradeJournalClose,
  OptionTradeJournalRecord,
  OptionTradeOutcome,
} from './option-trade-journal.js';
import { outcomeForR, SAME_CLOSE_TOLERANCE_MS } from './option-trade-journal.js';

// TRA-3485 (parent TRA-3472, CTO ruling 2026-08-13) — repair the stale live
// `OPEN` journal rows, PARTITIONED.
//
// ── Why this is not one treatment ────────────────────────────────────────────
//
// Thirteen rows on the admin book read `outcome:'OPEN'` on a live account for
// trades that are long over. They do NOT share one cause, and a uniform repair
// is wrong in BOTH directions:
//
//   * Some orders NEVER FILLED. The live open path journals the OPEN before it
//     contacts the broker (`signal-engine.ts` opens the paper position, which
//     calls `queueJournalOpen`, and only then awaits `mirrorLiveOptionOpen`), and
//     every abort inside that mirror funnels into `tradierVoid` → `voidOpenOption`,
//     which deletes the position without touching the journal. Synthesising a
//     close for one of these INVENTS a trade — into the learner, into the
//     expectancy fold, and into every verdict that reads the journal as the desk's
//     record.
//   * The rest are REAL round trips whose CLOSE was dropped (the TRA-2937 shape).
//     Retracting one of these ERASES a live trade, its realized P&L, and the only
//     durable record that it happened.
//
// ── The discriminator is broker truth, re-derived every run ──────────────────
//
// `recordLiveOptionFill(..., side:'buy_to_open')` fires at `signal-engine.ts`
// ONLY inside `if (outcome.status === 'filled')`, and the live OTM path always
// passes a `sleeve`, so on this cohort a fill cannot happen without a durable
// row in the fee/slippage ledger. Contrapositive, and this is the whole basis of
// the partition: **no ledger row means no fill.**
//
// There is deliberately NO list of thirteen ids in this file. The CTO's standing
// instruction on the parent is to re-derive the partition in the beat the repair
// runs, because rows can close or be adopted in between and a repair keyed to a
// stale partition is exactly the "rewrites history in the wrong direction"
// failure the ticket exists to avoid. Same reasoning as `eod-row-backfill.ts`:
// a hard-coded cohort MIS-SCOPES SILENTLY while still reading as correct.
//
// ── Refusal is a first-class outcome ─────────────────────────────────────────
//
// A row that is neither cleanly never-filled nor cleanly round-tripped gets
// `no_action` with a named reason, never a guess. The shapes that land there are
// real and were observed live: an entry fill with no exit (still open at the
// broker), an exit with no matchable entry, and an exit that does not cover the
// journalled contract count. Every one of them would produce a plausible,
// wrong number if the planner "did its best".

/** How the repair proposes to treat one stale row. */
export type StaleOpenTreatment = 'retract' | 'backfill_close' | 'no_action';

/**
 * The `exitReason` every back-filled CLOSE carries.
 *
 * It names the CTO ruling that authorised the reconstruction rather than this
 * implementation ticket (the `eod-row-backfill.ts` precedent): someone who greps
 * this string out of the journal in six months lands on why the row exists.
 *
 * It is deliberately NOT one of the engine's exit vocabulary (`tp1`, `stop`,
 * `time_stop`, `expired`). The original TRA-2937 complaint is that the engine's
 * exit DECISION is unrecoverable for these rows — it was never journalled and
 * cannot be reconstructed from broker fills, which record what happened and not
 * why. A reconstructed close wearing `stop` would assert a decision nobody made
 * and would silently join the `byExitReason` rollup as if it had been observed.
 */
export const RECONSTRUCTED_EXIT_REASON = 'reconstructed-TRA-3472';

/**
 * How far from the journal's `openTs` a `buy_to_open` fill may sit and still be
 * THIS row's entry.
 *
 * The journal OPEN is written immediately before the broker is contacted, so a
 * genuine entry fill lands seconds later — all seven observed live entries were
 * within 2s. The window is generous (a chase ladder can walk for minutes) but
 * has to stay far below the gap to an unrelated fill on the same contract: the
 * live book carries a `history_import` `buy_to_open` on `QQQ260911P00545000`
 * stamped 17:00:00Z, 3h13m after that row's real entry and belonging to a
 * DIFFERENT position. Pricing the entry off both would have overstated the
 * position by 25%.
 */
export const ENTRY_MATCH_WINDOW_MS = 10 * 60 * 1000;

/** One ledger fill, with the contracts this row is claiming from it. */
export interface AllocatedFill {
  ts: number;
  side: 'buy_to_open' | 'sell_to_close';
  /** Contracts on the ledger record. */
  recordContracts: number;
  /** Contracts of that record allocated to THIS journal row. */
  allocatedContracts: number;
  filledPrice: number | null;
  /** Fee on the record (null = never measured), before pro-rating. */
  fees: number | null;
  /** `fees × allocated/recordContracts`; null when the record's fee is null. */
  allocatedFees: number | null;
  origin: string;
  sleeve: string;
  orderId: number | null;
}

/** The planner's decision for one stale live OPEN row, with its evidence. */
export interface StaleOpenPlanRow {
  id: string;
  symbol: string;
  optionSymbol: string | null;
  openTs: number;
  /** Journalled contract count; `null` on an older row that predates the field. */
  contracts: number | null;
  atRiskUsd: number;
  treatment: StaleOpenTreatment;
  /** Why this treatment, in a form that can be read row-by-row in an audit. */
  reason: string;
  /** Every ledger fill on this contract, whether or not it was matched. */
  ledgerOpens: number;
  ledgerCloses: number;
  /** Fills allocated to this row (empty for `retract`). */
  allocations: AllocatedFill[];
  /**
   * Ledger fills on the same contract that were NOT allocated, and why. Stated
   * rather than dropped — an unexplained exclusion is how a wrong basis hides.
   * Includes (TRA-3986) fills wholly claimed by ANOTHER journal row, named.
   */
  excluded: { ts: number; side: string; contracts: number; origin: string; why: string }[];
  /** The CLOSE that would be (or was) written. Present only for `backfill_close`. */
  close?: OptionTradeJournalClose;
  /**
   * FALSE when any allocated fill carried `fees:null` — the fee reconcile never
   * matched it. The P&L below then EXCLUDES that leg's commission and is a
   * slight overstatement of the gain / understatement of the loss. Never
   * silently zero-filled: `fees:null` means unmeasured, not free (TRA-1707).
   */
  feesComplete?: boolean;
  /**
   * TRUE when any allocated fill has `origin:'history_import'` — a
   * reconstruction from account history rather than a fill-time capture, so its
   * `ts` is the import's synthetic stamp and NOT the true fill instant. The
   * `closeTs` inherits that imprecision.
   */
  closeTsImported?: boolean;
}

export interface StaleOpenPlan {
  /** Live `OPEN` rows considered. */
  scanned: number;
  rows: StaleOpenPlanRow[];
  counts: { retract: number; backfillClose: number; noAction: number };
}

export function isFinitePositive(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Decide, per row, from broker truth. PURE — no IO, no clock, no writes, so the
 * partition it produces can be graded before anything mutates.
 *
 * `rows` should be the live-mode `OPEN` journal rows; anything else is filtered
 * out here as well, so a caller cannot widen the blast radius by passing more.
 */
export function planStaleOpenRepair(
  rows: OptionTradeJournalRecord[],
  ledger: LiveOptionFillRecord[],
): StaleOpenPlan {
  const live = rows.filter((r) => r.mode === 'live' && r.outcome === 'OPEN');
  const byContract = new Map<string, LiveOptionFillRecord[]>();
  for (const f of ledger) {
    if (f.mode !== 'live') continue;
    const list = byContract.get(f.optionSymbol) ?? [];
    list.push(f);
    byContract.set(f.optionSymbol, list);
  }

  const claims = claimFillsBySiblingRows(rows, byContract);

  const planned: StaleOpenPlanRow[] = [];
  for (const row of [...live].sort((a, b) => a.openTs - b.openTs)) {
    planned.push(planOne(row, byContract.get(row.optionSymbol ?? '') ?? [], claims));
  }
  return {
    scanned: live.length,
    rows: planned,
    counts: {
      retract: planned.filter((r) => r.treatment === 'retract').length,
      backfillClose: planned.filter((r) => r.treatment === 'backfill_close').length,
      noAction: planned.filter((r) => r.treatment === 'no_action').length,
    },
  };
}

/**
 * TRA-3986 — which ledger fills are ALREADY SOME OTHER ROW'S, and by how many
 * contracts.
 *
 * ── The defect this closes ─────────────────────────────────────────────────
 *
 * `planOne` used to see every live fill on the contract. On 2026-08-21 the
 * TRA-3547 sweep planned the desk's residual BAC lot `6bbc5d17` (a 55-minute-old
 * reconciler mint carrying the ENGINE lot's `openTs`, TRA-3933) against a ledger
 * that held the engine's own round trip — `buy_to_open` 1 @ 1.65 (order
 * 142603649) and `sell_to_close` 1 @ 0.91 (order 142899523) — both of which were
 * already the entry and the close of the engine's row `0e180e8c`. Oldest-first
 * allocation handed both to the desk row and wrote a −$74 close on a lot that was
 * still at the broker; the lot's REAL exit three days later (order 143160792,
 * −$3.00) then found the row shut (TRA-4004). One fill, two rows, the engine's
 * loss counted twice and the desk's loss dropped.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 *
 * A fill is one lot's fill. Before a stale OPEN row may allocate from the ledger,
 * every OTHER live journal row on the same contract claims what is its own:
 *
 *   • its ENTRY — `buy_to_open` fills inside {@link ENTRY_MATCH_WINDOW_MS} of its
 *     `openTs`, oldest first, up to its journalled `contracts`. Rows are walked
 *     in `openTs` order so an earlier lot's entry cannot be taken by a later one;
 *   • its EXIT, when the row is CLOSED — the `sell_to_close` whose `orderId`
 *     matches the row's `brokerOrderId`, or failing that whose `ts` is within
 *     {@link SAME_CLOSE_TOLERANCE_MS} of the row's `closeTs` (a reconstructed
 *     close IS the fill's `ts`, to the millisecond), up to `contracts`.
 *
 * What the planned row then sees is the REMAINDER. A fill wholly claimed is
 * excluded with the claimant's id in `why`, so the audit names the row that owns
 * it rather than reporting the contract as fill-less.
 *
 * ── What it does NOT claim ─────────────────────────────────────────────────
 *
 * A row with no `contracts` cannot size a claim and claims nothing — the same
 * refusal `planOne` makes for itself. A closed row's `supersededCloses[]` claim
 * nothing: a superseded close was, by construction, never that row's. And this
 * is a sibling-ROW rule, not a broker-position rule — on BAC the remainder for
 * the desk row is the `history_import` open at the synthetic 17:00:00Z stamp,
 * which is outside the entry window, so the row lands at `no_action` ("cannot
 * establish the entry basis") rather than at a different wrong close. That is
 * the correct verdict: the lot was still at the broker, and the engine's real
 * close reached an OPEN row on 08-24.
 */
export interface FillClaim {
  /** Journal row id that owns this slice. */
  row: string;
  leg: 'entry' | 'exit';
  contracts: number;
}
export type FillClaims = Map<LiveOptionFillRecord, { total: number; by: FillClaim[] }>;

/** Contracts of `f` claimed by rows OTHER than `rowId` (a row never competes with itself). */
export function claimedByOthers(claims: FillClaims, f: LiveOptionFillRecord, rowId: string): FillClaim[] {
  return (claims.get(f)?.by ?? []).filter((c) => c.row !== rowId);
}

export function claimFillsBySiblingRows(
  rows: OptionTradeJournalRecord[],
  byContract: Map<string, LiveOptionFillRecord[]>,
): FillClaims {
  const claims: FillClaims = new Map();
  const claim = (f: LiveOptionFillRecord, take: number, row: string, leg: FillClaim['leg']): void => {
    const c = claims.get(f) ?? { total: 0, by: [] };
    c.total += take;
    c.by.push({ row, leg, contracts: take });
    claims.set(f, c);
  };
  const left = (f: LiveOptionFillRecord): number => f.contracts - (claims.get(f)?.total ?? 0);

  const claimants = rows
    .filter((r) => r.mode === 'live' && typeof r.optionSymbol === 'string' && isFinitePositive(r.contracts))
    .sort((a, b) => a.openTs - b.openTs);

  for (const r of claimants) {
    const fills = [...(byContract.get(r.optionSymbol as string) ?? [])].sort((a, b) => a.ts - b.ts);
    const contracts = r.contracts as number;

    let want = contracts;
    for (const f of fills) {
      if (want <= 0) break;
      if (f.side !== 'buy_to_open' || Math.abs(f.ts - r.openTs) > ENTRY_MATCH_WINDOW_MS) continue;
      const take = Math.min(want, left(f));
      if (take <= 0) continue;
      claim(f, take, r.id, 'entry');
      want -= take;
    }

    if (r.outcome === 'OPEN') continue;
    const closeTs = typeof r.closeTs === 'number' && Number.isFinite(r.closeTs) ? r.closeTs : null;
    const orderId = r.brokerOrderId == null ? null : String(r.brokerOrderId);
    want = contracts;
    // An order-id match is the stronger witness; take those first, then the
    // millisecond match, so a row that carries both does not double-claim.
    const exitMatches = fills.filter(
      (f) => f.side === 'sell_to_close'
        && ((orderId !== null && f.orderId != null && String(f.orderId) === orderId)
          || (closeTs !== null && Math.abs(f.ts - closeTs) <= SAME_CLOSE_TOLERANCE_MS)),
    );
    for (const f of exitMatches) {
      if (want <= 0) break;
      const take = Math.min(want, left(f));
      if (take <= 0) continue;
      claim(f, take, r.id, 'exit');
      want -= take;
    }
  }
  return claims;
}

function planOne(row: OptionTradeJournalRecord, allFills: LiveOptionFillRecord[], claims: FillClaims): StaleOpenPlanRow {
  // TRA-3986 — what OTHER rows on this contract already own is not this row's
  // to allocate. Fully-claimed fills leave the candidate set here and are named
  // in `excluded`; partially-claimed ones stay, with only the remainder on offer.
  const claimedExcluded: StaleOpenPlanRow['excluded'] = [];
  const available = new Map<LiveOptionFillRecord, number>();
  const fills: LiveOptionFillRecord[] = [];
  for (const f of allFills) {
    // The row's OWN claim (it is in `rows` too) is not a competitor — subtract
    // only what other rows took.
    const others = claimedByOthers(claims, f, row.id);
    const remainder = f.contracts - others.reduce((s, c) => s + c.contracts, 0);
    if (others.length > 0 && remainder <= 0) {
      claimedExcluded.push({
        ts: f.ts,
        side: f.side,
        contracts: f.contracts,
        origin: f.origin,
        why: `already the ${f.side === 'buy_to_open' ? 'entry' : 'exit'} of journal row(s) ${others.map((c) => `${c.row}:${c.leg}`).join(', ')} — one fill is one lot's fill (TRA-3986)`,
      });
      continue;
    }
    available.set(f, remainder);
    fills.push(f);
  }

  const base = {
    id: row.id,
    symbol: row.symbol,
    optionSymbol: row.optionSymbol ?? null,
    openTs: row.openTs,
    contracts: row.contracts ?? null,
    atRiskUsd: row.atRiskUsd,
    ledgerOpens: allFills.filter((f) => f.side === 'buy_to_open').length,
    ledgerCloses: allFills.filter((f) => f.side === 'sell_to_close').length,
    allocations: [] as AllocatedFill[],
    excluded: claimedExcluded,
  };

  // A row with no OCC symbol cannot be joined to the ledger at all, so its
  // partition is unknowable — which is a refusal, not a retraction.
  if (!row.optionSymbol) {
    return { ...base, treatment: 'no_action', reason: 'row carries no optionSymbol; cannot join to the fill ledger' };
  }

  // TRA-3986 — the contract HAS fills, but every one of them is already some
  // other row's. That is not Group A: "no unclaimed fill" cannot distinguish a
  // duplicate mint of a lot that already has its row (TRA-3933) from a real
  // second lot whose fills were never captured (a desk lot before TRA-3939).
  // Retracting would erase the second; closing would double-count the first.
  if (allFills.length > 0 && fills.length === 0) {
    return {
      ...base,
      treatment: 'no_action',
      reason:
        `ledger has ${base.ledgerOpens} buy_to_open / ${base.ledgerCloses} sell_to_close on this contract, and every `
        + 'one is already the entry or exit of another journal row — a duplicate row and an uncaptured second lot '
        + 'look identical here, so neither a retraction nor a close is safe',
    };
  }

  // ── GROUP A — no fill on either leg, therefore the trade never happened. ──
  if (fills.length === 0) {
    return {
      ...base,
      treatment: 'retract',
      reason:
        'no buy_to_open and no sell_to_close in the durable live fill ledger; on this cohort a fill '
        + 'cannot occur without a ledger row, so the order never filled and the row must be retracted, '
        + 'not closed',
    };
  }

  // Past this point every branch prices the position, and pricing needs the size.
  // `contracts` is optional on the record (older rows predate the field), and
  // guessing it from the ledger would let an unrelated fill on the same contract
  // DEFINE the size of the row it is being matched against.
  const contracts = row.contracts;
  if (!isFinitePositive(contracts)) {
    return {
      ...base,
      treatment: 'no_action',
      reason:
        `ledger has ${base.ledgerOpens} buy_to_open / ${base.ledgerCloses} sell_to_close on this contract, but the `
        + 'journal row carries no contract count — the position cannot be priced without inferring its size',
    };
  }

  const sorted = [...fills].sort((a, b) => a.ts - b.ts);
  const entryCandidates = sorted.filter(
    (f) => f.side === 'buy_to_open' && Math.abs(f.ts - row.openTs) <= ENTRY_MATCH_WINDOW_MS,
  );
  const excluded: StaleOpenPlanRow['excluded'] = [...claimedExcluded];
  for (const f of sorted) {
    if (f.side === 'buy_to_open' && !entryCandidates.includes(f)) {
      excluded.push({
        ts: f.ts,
        side: f.side,
        contracts: f.contracts,
        origin: f.origin,
        why: `buy_to_open ${Math.round(Math.abs(f.ts - row.openTs) / 1000)}s from this row's openTs, outside the ${ENTRY_MATCH_WINDOW_MS / 1000}s entry window — belongs to a different position`,
      });
    }
  }

  if (entryCandidates.length === 0) {
    return {
      ...base,
      excluded,
      treatment: 'no_action',
      reason:
        `ledger has ${base.ledgerOpens} buy_to_open / ${base.ledgerCloses} sell_to_close on this contract but none `
        + 'of the opens is within the entry window of this row — the entry basis cannot be established, so neither '
        + 'a retraction nor a close is safe',
    };
  }

  // ── Entry: allocate up to the journalled contract count, oldest first. ──
  const entry = allocate(entryCandidates, contracts, available);
  if (entry.remaining > 0) {
    return {
      ...base,
      excluded,
      treatment: 'no_action',
      reason:
        `entry fills cover only ${contracts - entry.remaining}/${contracts} journalled contracts; `
        + 'a partial entry basis would price the whole position off a fraction of it',
    };
  }
  if (entry.allocations.some((a) => !isFinitePositive(a.filledPrice))) {
    return {
      ...base,
      excluded,
      treatment: 'no_action',
      reason: 'an allocated entry fill carries no filledPrice; the entry basis is unmeasured',
    };
  }

  const lastEntryTs = Math.max(...entry.allocations.map((a) => a.ts));
  const exitCandidates = sorted.filter((f) => f.side === 'sell_to_close' && f.ts >= lastEntryTs);
  for (const f of sorted) {
    if (f.side === 'sell_to_close' && f.ts < lastEntryTs) {
      excluded.push({
        ts: f.ts,
        side: f.side,
        contracts: f.contracts,
        origin: f.origin,
        why: 'sell_to_close predates this row\'s entry fill; it closed an earlier position on the same contract',
      });
    }
  }

  if (exitCandidates.length === 0) {
    return {
      ...base,
      excluded,
      allocations: entry.allocations,
      treatment: 'no_action',
      reason:
        'entry filled but the ledger has no sell_to_close after it — this position may still be OPEN at the '
        + 'broker, in which case the row is correct and must not be touched',
    };
  }

  const exit = allocate(exitCandidates, contracts, available);
  if (exit.remaining > 0) {
    return {
      ...base,
      excluded,
      allocations: [...entry.allocations, ...exit.allocations],
      treatment: 'no_action',
      reason:
        `exit fills cover only ${contracts - exit.remaining}/${contracts} journalled contracts — the `
        + 'position is not fully closed, and a CLOSE row asserts a completed round trip',
    };
  }
  if (exit.allocations.some((a) => !isFinitePositive(a.filledPrice))) {
    return {
      ...base,
      excluded,
      allocations: [...entry.allocations, ...exit.allocations],
      treatment: 'no_action',
      reason: 'an allocated exit fill carries no filledPrice; the realized proceeds are unmeasured',
    };
  }

  const allocations = [...entry.allocations, ...exit.allocations];
  const entryCost = entry.allocations.reduce((s, a) => s + (a.filledPrice ?? 0) * a.allocatedContracts * 100, 0);
  const exitProceeds = exit.allocations.reduce((s, a) => s + (a.filledPrice ?? 0) * a.allocatedContracts * 100, 0);
  const fees = allocations.reduce((s, a) => s + (a.allocatedFees ?? 0), 0);
  const feesComplete = allocations.every((a) => a.allocatedFees !== null);
  const realizedPnlUsd = round2(exitProceeds - entryCost - fees);
  // `atRiskUsd` is the basis captured AT OPEN, which is what makes R comparable
  // across rows — see the `realizedR` docstring. It is not the fill cost and
  // must not be replaced by it here.
  const realizedR = isFinitePositive(row.atRiskUsd) ? realizedPnlUsd / row.atRiskUsd : 0;
  const closeTs = Math.max(...exit.allocations.map((a) => a.ts));
  const outcome: OptionTradeOutcome = outcomeForR(realizedR);

  return {
    ...base,
    excluded,
    allocations,
    treatment: 'backfill_close',
    feesComplete,
    closeTsImported: allocations.some((a) => a.origin === 'history_import'),
    reason:
      `broker fills on BOTH legs: ${entry.allocations.length} entry / ${exit.allocations.length} exit slice(s) `
      + `covering ${contracts}/${contracts} contracts. Real round trip with a dropped CLOSE (TRA-2937 shape); `
      + `reconstructing the close from broker truth, exit REASON marked reconstructed because it was never journalled`,
    close: {
      closeTs,
      outcome,
      realizedPnlUsd,
      realizedR: round4(realizedR),
      exitReason: RECONSTRUCTED_EXIT_REASON,
      holdDays: Math.max(0, (closeTs - row.openTs) / 86_400_000),
      // `exitSlippageUsd` is deliberately ABSENT. It is `(mark − fillPremium)`
      // against the CLOSING MARK, and no closing mark was ever captured for
      // these rows. Deriving one from the fill would make the measurement equal
      // its own input and report 0 slippage on trades whose slippage is unknown.
    },
  };
}

/**
 * TRA-2819 — exported so the close-basis restatement prices a round trip with
 * the EXACT arithmetic that made the reconstructed rows broker-exact, rather
 * than a second copy of it. Two implementations of one fee pro-rating rule is
 * how two numbers that must agree quietly drift apart.
 */
export function allocate(
  fills: LiveOptionFillRecord[],
  want: number,
  // TRA-3986 — contracts of each fill still unclaimed by another journal row.
  // Absent (the TRA-2819 caller) means the whole record is on offer.
  available?: Map<LiveOptionFillRecord, number>,
): { allocations: AllocatedFill[]; remaining: number } {
  let remaining = want;
  const allocations: AllocatedFill[] = [];
  for (const f of fills) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, available?.get(f) ?? f.contracts);
    if (take <= 0) continue;
    allocations.push({
      ts: f.ts,
      side: f.side,
      recordContracts: f.contracts,
      allocatedContracts: take,
      filledPrice: f.filledPrice,
      fees: f.fees,
      // Pro-rate rather than take the whole fee: a 5-contract exit that covers a
      // 4-contract row also covered 1 contract of something else, and charging
      // this row for all of it moves P&L in the wrong direction.
      allocatedFees: f.fees === null ? null : round2((f.fees * take) / f.contracts),
      origin: f.origin,
      sleeve: f.sleeve,
      orderId: f.orderId,
    });
    remaining -= take;
  }
  return { allocations, remaining };
}

/** @see allocate — exported with it, for the same reason. */
export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** @see allocate — exported with it, for the same reason. */
export function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}
