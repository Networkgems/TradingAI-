import type { LiveOptionFillRecord } from './live-options-fee-slippage-ledger.js';
import type {
  OptionTradeCloseBasis,
  OptionTradeJournalRecord,
  OptionTradeOutcome,
} from './option-trade-journal.js';
import { outcomeForR } from './option-trade-journal.js';
import {
  allocate,
  ENTRY_MATCH_WINDOW_MS,
  isFinitePositive,
  round2,
  round4,
  type AllocatedFill,
} from './tra3485-stale-open-repair.js';

// TRA-2819 asks 1+2 (CTO, 2026-08-14) — restate the MONEY on live journal rows
// that are already closed, from the app's own arithmetic onto broker truth.
//
// ── What is actually wrong, after the ingestion fix ──────────────────────────
//
// The original P0 was that exit fills were never ingested at all: three live
// round trips that settled +$713.73 at Tradier were booked −$2.00, because a
// boot reconcile force-closed them at the last local MARK. That half is fixed —
// the exits now carry the broker's fill prices (2.78 / 0.12 / 0.10, matching the
// ledger's `filledPrice` to the cent).
//
// What is left is smaller, permanent, and in the direction that flatters. The
// same three rows now read +$739.00 against the broker's +$713.73, and the
// +$25.27 residual is not noise — it decomposes EXACTLY, every cent of it:
//
//   +23.00  entry basis. An engine-opened row books `premiumPaid = signal.mark`,
//           the scanner's pre-trade NBBO MID, and the journal's `entryMarkUsd`
//           freezes it. AAPL filled at 1.04 against a 0.995 mid: 0.045 × 4 × 100
//           = 18.00. Same shape on both SPY legs (2.00 and 3.00).
//           `restateEngineOpenedBasis` (TRA-2889) fixes this on the POSITION,
//           but only while it is still open and only once the 30s reconcile
//           reaches it — these three went phantom before it ever did.
//    +2.27  commission. Nothing subtracts it, because it is not knowable at
//           close time: the order-status payload carries no commission and the
//           account HISTORY endpoint only publishes it after settlement
//           (TRA-1929). So the close path books a GROSS number and no later
//           pass ever nets it down.
//
// ── The control that makes this diagnosis safe to act on ────────────────────
//
// A fourth live row sits in the same store, on the same book, closed the same
// week: `PLTR260911C00170000`, the round trip TRA-3485 reconstructed. It reads
// 155.75 against the broker's 155.75 — exact. It is exact because it was priced
// from ledger FILLS and netted of MEASURED fees, which is precisely the
// arithmetic below. So this is not a new theory about what broker truth is; it
// is the arithmetic that already produced a broker-exact row in production,
// pointed at the three rows the engine wrote instead.
//
// That is also why this module imports `allocate` from the TRA-3485 planner
// rather than reimplementing it. A second copy of the fee pro-rating rule is how
// the reconstructed rows and the restated rows would silently stop agreeing.
//
// ── Refusal is a first-class outcome, and stricter here than in TRA-3485 ─────
//
// TRA-3485 tolerated `feesComplete: false` — it was CREATING a row where none
// existed, and a fee-incomplete row beats no row. This module OVERWRITES a
// number with one that claims to be broker-settled, so it refuses outright when
// any allocated leg's fee is unmeasured. `fees: null` means UNMEASURED, not free
// (TRA-1707); a GROSS figure wearing a broker-truth label is strictly worse than
// the wrong figure it replaced, because it stops anyone from looking again.

/** How the restatement proposes to treat one closed live row. */
export type CloseBasisTreatment = 'restate' | 'skip';

/**
 * Why a row was skipped. Named rather than boolean because the denominator must
 * never be implicit: a pass that matched nothing and a pass that matched
 * everything and agreed produce the same journal, and only the reasons tell them
 * apart. `zero_delta` is the one that matters most — it means the engine's
 * figure ALREADY equals broker truth, so the row is evidence the close path is
 * healthy, not evidence the pass failed to reach it.
 */
export type CloseBasisSkipReason =
  | 'already_restated'
  | 'no_option_symbol'
  | 'no_contract_count'
  | 'no_at_risk_basis'
  | 'no_entry_fill_in_window'
  | 'entry_partially_covered'
  | 'entry_price_unmeasured'
  | 'no_exit_fill_in_window'
  | 'exit_partially_covered'
  | 'exit_price_unmeasured'
  | 'fees_unmeasured'
  | 'zero_delta';

/**
 * How far past the journalled `closeTs` a `sell_to_close` fill may sit and still
 * be THIS row's exit.
 *
 * The upper bound exists only on this pass and not on TRA-3485's, and it is the
 * one guard a closed row can afford that an open row cannot: a closed row knows
 * when it closed. Without it, a LATER re-acquisition of the same OCC symbol —
 * this book trades the same contracts repeatedly — would have its exit pulled
 * back onto an older row and reprice a settled trade off somebody else's fill.
 *
 * Generous in the same direction as the entry window, because `closeTs` is
 * itself sometimes the reconcile's clock rather than the fill's: on the three
 * 2026-07-30 rows the exit fills land within 1ms of `closeTs`, but a row
 * force-closed by a boot reconcile carries a `closeTs` minutes to days AFTER its
 * fills. That direction is safe — those fills are still `>= lastEntryTs` and
 * still before the close — so the bound only has to keep out the NEXT position.
 */
export const EXIT_MATCH_GRACE_MS = 10 * 60 * 1000;

/** One row's decision, with every number it was reached from. */
export interface CloseBasisPlanRow {
  id: string;
  symbol: string;
  optionSymbol: string | null;
  mode: 'demo' | 'live';
  openTs: number;
  closeTs: number | null;
  contracts: number | null;
  atRiskUsd: number;
  exitReason: string | null;
  treatment: CloseBasisTreatment;
  skipReason: CloseBasisSkipReason | null;
  /** Human-readable, row-by-row auditable. */
  reason: string;
  /** What the journal says today. */
  realizedPnlUsdBefore: number | null;
  /** What broker fills say, net of measured fees; `null` when the row is skipped. */
  realizedPnlUsdAfter: number | null;
  /** `after − before`. Negative means the app was OVERSTATING this trade. */
  deltaUsd: number | null;
  /** The journal's frozen entry mid, and the broker's actual entry fill. */
  entryMarkUsd: number | null;
  entryFillPremium: number | null;
  exitFillPremium: number | null;
  feesUsd: number | null;
  /** Split of `deltaUsd` into its two independent causes. They must sum to it. */
  entryBasisDeltaUsd: number | null;
  feeDeltaUsd: number | null;
  allocations: AllocatedFill[];
  /** Ledger fills on this contract that were NOT claimed, each with a why. */
  excluded: { ts: number; side: string; contracts: number; origin: string; why: string }[];
  /** The restatement to write; present iff `treatment === 'restate'`. */
  basis?: OptionTradeCloseBasis;
}

export interface CloseBasisPlan {
  /** Closed live rows considered. */
  scanned: number;
  rows: CloseBasisPlanRow[];
  counts: { restate: number; skip: number };
  /** Σ `deltaUsd` over the `restate` rows — what the pass would move the book by. */
  netDeltaUsd: number;
  /** Per-reason skip census, so the denominator is never implicit. */
  skipsByReason: Record<string, number>;
}

/**
 * A restatement below this many dollars is treated as agreement, not as a
 * correction.
 *
 * Half a cent: the journal stores a float (`713.9999999999999` is a real stored
 * value), so an exact compare would restate rows that already agree and burn an
 * append line per pass per row — and, worse, would make the idempotency check
 * below unreadable. Never `===` a computed float in a criterion.
 */
export const ZERO_DELTA_EPSILON_USD = 0.005;

/**
 * Plan the restatement. PURE — no I/O, no clock, no store.
 *
 * `rows` is filtered to live, CLOSED rows here rather than trusting the caller,
 * so no call site can widen the blast radius by passing the demo book. Demo rows
 * are excluded on principle and not merely by accident: a demo fill has no
 * broker behind it, so there is no truth to restate toward, and the modelled
 * `demoSlippagePct` haircut baked into their `premiumPaid` is deliberate.
 */
export function planCloseBasisRestate(
  rows: OptionTradeJournalRecord[],
  ledger: LiveOptionFillRecord[],
): CloseBasisPlan {
  const live = rows.filter((r) => r.mode === 'live' && r.outcome !== 'OPEN');
  const byContract = new Map<string, LiveOptionFillRecord[]>();
  for (const f of ledger) {
    if (f.mode !== 'live') continue;
    const list = byContract.get(f.optionSymbol) ?? [];
    list.push(f);
    byContract.set(f.optionSymbol, list);
  }

  const planned = [...live]
    .sort((a, b) => a.openTs - b.openTs)
    .map((row) => planOne(row, byContract.get(row.optionSymbol ?? '') ?? []));

  const restate = planned.filter((r) => r.treatment === 'restate');
  const skipsByReason: Record<string, number> = {};
  for (const r of planned) {
    if (r.skipReason) skipsByReason[r.skipReason] = (skipsByReason[r.skipReason] ?? 0) + 1;
  }
  return {
    scanned: live.length,
    rows: planned,
    counts: { restate: restate.length, skip: planned.length - restate.length },
    netDeltaUsd: round2(restate.reduce((s, r) => s + (r.deltaUsd ?? 0), 0)),
    skipsByReason,
  };
}

function planOne(row: OptionTradeJournalRecord, fills: LiveOptionFillRecord[]): CloseBasisPlanRow {
  const before = Number.isFinite(row.realizedPnlUsd) ? (row.realizedPnlUsd as number) : null;
  const base = {
    id: row.id,
    symbol: row.symbol,
    optionSymbol: row.optionSymbol ?? null,
    mode: row.mode,
    openTs: row.openTs,
    closeTs: Number.isFinite(row.closeTs) ? (row.closeTs as number) : null,
    contracts: row.contracts ?? null,
    atRiskUsd: row.atRiskUsd,
    exitReason: row.exitReason ?? null,
    realizedPnlUsdBefore: before,
    realizedPnlUsdAfter: null,
    deltaUsd: null,
    entryMarkUsd: Number.isFinite(row.entryMarkUsd) ? (row.entryMarkUsd as number) : null,
    entryFillPremium: null,
    exitFillPremium: null,
    feesUsd: null,
    entryBasisDeltaUsd: null,
    feeDeltaUsd: null,
    allocations: [] as AllocatedFill[],
    excluded: [] as CloseBasisPlanRow['excluded'],
  };
  const skip = (skipReason: CloseBasisSkipReason, reason: string, extra: Partial<CloseBasisPlanRow> = {}): CloseBasisPlanRow => ({
    ...base,
    ...extra,
    treatment: 'skip',
    skipReason,
    reason,
  });

  // Idempotency. A row already carrying broker provenance is not re-priced: a
  // second pass would re-derive the same number, but it would also append a
  // second amend line per row per run, and `netDeltaUsd` — the acceptance
  // figure — would then read 0 on a re-run and be indistinguishable from a pass
  // that found nothing to do.
  if (row.pnlBasis === 'broker-fill') {
    return skip('already_restated', 'row already carries pnlBasis broker-fill; nothing to restate');
  }
  if (!row.optionSymbol) {
    return skip('no_option_symbol', 'row carries no optionSymbol; cannot join to the fill ledger');
  }
  const contracts = row.contracts;
  if (!isFinitePositive(contracts)) {
    return skip(
      'no_contract_count',
      'journal row carries no contract count; the round trip cannot be priced without inferring its size',
    );
  }
  if (!isFinitePositive(row.atRiskUsd)) {
    // R is `realizedPnlUsd / atRiskUsd`. Restating the money without a
    // denominator would leave `realizedR` describing the OLD figure, and R is
    // what `outcome` and every expectancy fold read — a row whose P&L and R
    // disagree is worse than one that is uniformly wrong.
    return skip('no_at_risk_basis', 'row carries no atRiskUsd; realizedR could not be recomputed alongside the money');
  }

  const sorted = [...fills].sort((a, b) => a.ts - b.ts);
  const excluded: CloseBasisPlanRow['excluded'] = [];

  const entryCandidates = sorted.filter(
    (f) => f.side === 'buy_to_open' && Math.abs(f.ts - row.openTs) <= ENTRY_MATCH_WINDOW_MS,
  );
  for (const f of sorted) {
    if (f.side === 'buy_to_open' && !entryCandidates.includes(f)) {
      excluded.push({
        ts: f.ts,
        side: f.side,
        contracts: f.contracts,
        origin: f.origin,
        why: `buy_to_open ${Math.round(Math.abs(f.ts - row.openTs) / 1000)}s from this row's openTs, outside the ${ENTRY_MATCH_WINDOW_MS / 1000}s entry window — belongs to a different position on the same contract`,
      });
    }
  }
  if (entryCandidates.length === 0) {
    return skip(
      'no_entry_fill_in_window',
      `ledger has ${sorted.filter((f) => f.side === 'buy_to_open').length} buy_to_open on this contract but none inside this row's entry window; the broker entry basis cannot be established`,
      { excluded },
    );
  }

  const entry = allocate(entryCandidates, contracts);
  if (entry.remaining > 0) {
    return skip(
      'entry_partially_covered',
      `entry fills cover only ${contracts - entry.remaining}/${contracts} journalled contracts; pricing the whole position off a fraction of its basis is how a wrong number hides`,
      { excluded, allocations: entry.allocations },
    );
  }
  if (entry.allocations.some((a) => !isFinitePositive(a.filledPrice))) {
    return skip('entry_price_unmeasured', 'an allocated entry fill carries no filledPrice; the broker entry basis is unmeasured', {
      excluded,
      allocations: entry.allocations,
    });
  }

  // Exit legs are bounded on BOTH sides: at or after the last entry fill (so an
  // earlier position's exit on the same contract cannot be claimed) and at or
  // before this row's own close (so a LATER position's exit cannot be either).
  const lastEntryTs = Math.max(...entry.allocations.map((a) => a.ts));
  const closeCeiling = base.closeTs === null ? Infinity : base.closeTs + EXIT_MATCH_GRACE_MS;
  const exitCandidates = sorted.filter(
    (f) => f.side === 'sell_to_close' && f.ts >= lastEntryTs && f.ts <= closeCeiling,
  );
  for (const f of sorted) {
    if (f.side === 'sell_to_close' && !exitCandidates.includes(f)) {
      excluded.push({
        ts: f.ts,
        side: f.side,
        contracts: f.contracts,
        origin: f.origin,
        why:
          f.ts < lastEntryTs
            ? "sell_to_close predates this row's entry fill; it closed an earlier position on the same contract"
            : `sell_to_close ${Math.round((f.ts - (base.closeTs ?? 0)) / 1000)}s after this row's closeTs, outside the ${EXIT_MATCH_GRACE_MS / 1000}s grace — it closed a LATER position on the same contract`,
      });
    }
  }
  if (exitCandidates.length === 0) {
    return skip(
      'no_exit_fill_in_window',
      'no sell_to_close between this row\'s entry fill and its close; the realized proceeds cannot be established from broker truth',
      { excluded, allocations: entry.allocations },
    );
  }

  const exit = allocate(exitCandidates, contracts);
  if (exit.remaining > 0) {
    return skip(
      'exit_partially_covered',
      `exit fills cover only ${contracts - exit.remaining}/${contracts} journalled contracts; the journal asserts a completed round trip that broker truth does not support`,
      { excluded, allocations: [...entry.allocations, ...exit.allocations] },
    );
  }
  if (exit.allocations.some((a) => !isFinitePositive(a.filledPrice))) {
    return skip('exit_price_unmeasured', 'an allocated exit fill carries no filledPrice; the realized proceeds are unmeasured', {
      excluded,
      allocations: [...entry.allocations, ...exit.allocations],
    });
  }

  const allocations = [...entry.allocations, ...exit.allocations];

  // Fees must be COMPLETE. See the header: this pass replaces a number with one
  // that claims to be broker-settled, so a null fee is a refusal and never a
  // zero. The reconcile back-fills fees a day after settlement, so the honest
  // answer for a just-closed row is "not yet", and the pass will pick it up on a
  // later run — which is exactly why the skip is named rather than silent.
  if (allocations.some((a) => a.allocatedFees === null)) {
    const missing = allocations.filter((a) => a.allocatedFees === null).length;
    return skip(
      'fees_unmeasured',
      `${missing}/${allocations.length} allocated fills carry fees: null (UNMEASURED, not free — TRA-1707). A gross figure labelled broker-settled is worse than the wrong figure it would replace; re-run once the fee reconcile has back-filled this lot`,
      { excluded, allocations },
    );
  }

  const entryCost = entry.allocations.reduce((s, a) => s + (a.filledPrice ?? 0) * a.allocatedContracts * 100, 0);
  const exitProceeds = exit.allocations.reduce((s, a) => s + (a.filledPrice ?? 0) * a.allocatedContracts * 100, 0);
  const feesUsd = round2(allocations.reduce((s, a) => s + (a.allocatedFees ?? 0), 0));
  const realizedPnlUsd = round2(exitProceeds - entryCost - feesUsd);

  // `atRiskUsd` is the basis captured AT OPEN and is what makes R comparable
  // across rows — the same call TRA-3485 made on the reconstructed closes. It is
  // NOT the fill cost and is deliberately not replaced by it here: restating the
  // R denominator would silently re-scale every historical R this cohort
  // contributes to, which is a different ruling than "book the broker's money".
  const realizedR = realizedPnlUsd / row.atRiskUsd;
  // Re-derived, never carried over. A fee-and-basis correction is small in
  // dollars and can still move a row across the ±0.1 scratch band, and R is not
  // rounded before the classification: `-0.109` is a LOSS, and a planner that
  // rounds it to one decimal calls it SCRATCH.
  const outcome: OptionTradeOutcome = outcomeForR(realizedR);

  const entryFillPremium = round4(entryCost / contracts / 100);
  const exitFillPremium = round4(exitProceeds / contracts / 100);
  const deltaUsd = before === null ? null : round2(realizedPnlUsd - before);
  // The two independent causes, published separately so the correction can be
  // checked against the mechanism rather than taken on trust. They sum to
  // `deltaUsd` whenever the engine's figure was `(exit − entryMark) × n × 100`,
  // and a row where they DON'T sum is a row whose close was wrong for some third
  // reason — which is worth seeing, so this reports rather than asserts.
  const entryBasisDeltaUsd =
    base.entryMarkUsd === null ? null : round2(-(entryFillPremium - base.entryMarkUsd) * contracts * 100);

  const priced = {
    ...base,
    realizedPnlUsdAfter: realizedPnlUsd,
    deltaUsd,
    entryFillPremium,
    exitFillPremium,
    feesUsd,
    entryBasisDeltaUsd,
    feeDeltaUsd: -feesUsd,
    allocations,
    excluded,
  };

  // Already broker-exact. Reported WITH its numbers rather than as a bare skip:
  // this is the shape the PLTR row (reconstructed by TRA-3485 from these same
  // fills) lands in, and it is the positive control for the whole pass — a row
  // the arithmetic reaches, prices, and finds nothing wrong with.
  if (deltaUsd !== null && Math.abs(deltaUsd) < ZERO_DELTA_EPSILON_USD) {
    return {
      ...priced,
      treatment: 'skip',
      skipReason: 'zero_delta',
      reason:
        `broker fills agree with the journal to within ${ZERO_DELTA_EPSILON_USD} USD `
        + `(${before} vs ${realizedPnlUsd}) — this row was already priced from fills and netted of fees, `
        + 'so it is evidence the close path is healthy, not a row that needs correcting',
    };
  }

  return {
    ...priced,
    treatment: 'restate',
    skipReason: null,
    reason:
      `broker fills on BOTH legs (${entry.allocations.length} entry / ${exit.allocations.length} exit slice(s), `
      + `${contracts}/${contracts} contracts, fees measured on all ${allocations.length}). Restating the money from `
      + `entry mark ${base.entryMarkUsd ?? '?'} to entry fill ${entryFillPremium} and netting ${feesUsd} of commission; `
      + `closeTs / exitReason / holdDays unchanged`,
    basis: {
      realizedPnlUsd,
      realizedR: round4(realizedR),
      outcome,
      feesUsd,
      entryFillPremium,
      exitFillPremium,
    },
  };
}
