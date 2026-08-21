// TRA-3909 — PER-LOT adoption of desk-added broker contracts.
//
// Board instruction (TRA-3904 `92bc1e83`, 2026-08-20T23:21:32Z): *"Bot should
// manage added positions from Tradier"*, under the CEO reading recorded on
// TRA-3895 `e7b15b97` — **adopt, per lot, at each lot's own fill basis, with
// each lot's own stop. Adoption is never blending.**
//
// ── What this replaces ──────────────────────────────────────────────────────
// Tradier's `/positions` is ONE row per OCC symbol, so `cost_basis / quantity`
// is a BLEND across every contract the ACCOUNT holds on that symbol — the
// engine's and the desk's together. The reconcile used to copy that blend onto
// the engine's row, and the damage is not the mis-stated basis. It is that
// **every risk threshold is `premiumPaid × k`, so blending a CHEAPER foreign
// lot in LOWERS the stop.** Measured on the live book 2026-08-20T23:38Z:
//
//     XLF 260925C57.5 · engine 1 ct @ 1.08 (true stop 0.864)
//                     · desk   1 ct @ 0.85 (its own stop 0.680)
//                     · row    2 ct @ 0.965 → stop 0.772, `currentPremium` 0.82
//
// 0.82 sits BETWEEN 0.864 and 0.772: the engine's leg is through its stop and
// the row reads healthy with 6% headroom. That is TRA-3895 in one line.
//
// TRA-3896 (`627e892`) stopped the widening — an `engine_origin` row no longer
// absorbs a broker lot bigger than this engine's own fill ledger can account
// for. It REFUSES, which is the right default and stays exactly where it is.
// This module is the branch that refusal falls through to: instead of leaving
// the desk's contract with no row and no stop, mint it **its own row**.
//
// ── Why this is PURE ────────────────────────────────────────────────────────
// Same reason `live-broker-position-drift.ts` is: the caller owns the read, the
// mutation and the log line, so every refusal below is reachable from a test
// without a broker, a ledger or a clock. The expensive direction here is a
// silent success — a plan that mints nothing reads exactly like a plan that had
// nothing to mint — so the plan carries its refusals as DATA and the caller
// publishes them.
//
// ── The arithmetic, and why it needs no new API surface ─────────────────────
// The residual is exact:
//
//     adopted_basis = (broker_cost_basis − engine_recorded_cost_basis)
//                     ÷ (broker_ct − engine_recorded_ct)
//
// `broker_cost_basis` is reconstructed as `premiumPaid × contracts × 100` —
// the same reconstruction `EngineBasisRestatement.brokerCostBasisUsd` already
// ships, because `TradierOpenOptionPosition.premiumPaid` IS
// `cost_basis / quantity / 100`. The engine side comes from
// `recordedEngineOpenBasis`, this engine's own `buy_to_open` records written at
// fill time. Checked against the two real fills of 2026-08-20:
//
//     XLF: (193 − 108) / (2 − 1) = 0.85  ✅ order 142769426
//     BAC: (282 − 165) / (2 − 1) = 1.17  ✅ order 142769192
//
// ⛔ A derived basis computed from an INCOMPLETE ledger is the TRA-3895 defect
// wearing a different hat, so every way the ledger can be incomplete is a
// REFUSAL and never a fallback to the blend. There is no branch below that
// averages anything.

/** TRA-3909 — how a row on the symbol got onto this book. */
export type LotProvenance =
  /**
   * The engine's own contract: either never imported, or imported and proven
   * ours by the fill ledger (`adoptionAuthority: 'engine_origin'`).
   */
  | 'engine'
  /** A desk lot THIS module already minted (`adoptionAuthority: 'desk_add'`). */
  | 'desk_add'
  /**
   * A `foreign` / `unresolved` import — the TRA-3829 population: a position the
   * desk opened with no engine contract anywhere near it. Not ours to
   * restructure, and its presence makes the group ambiguous.
   */
  | 'foreign';

/** TRA-3909 — the row facts the plan needs. Deliberately not `OptionPosition`. */
export interface LotAdoptionRowView {
  id: string;
  /** `contractsRemaining ?? contracts`. */
  contracts: number;
  premiumPaid: number;
  provenance: LotProvenance;
  /** `pendingExit` or `pendingCloseOrderId` — the pollers own this row. */
  inFlight: boolean;
  multiLeg: boolean;
  coveredWrite: boolean;
}

/** TRA-3909 — `recordedEngineOpenBasis(occ)`, narrowed to what the plan reads. */
export interface LotAdoptionLedgerView {
  contracts: number;
  premiumPaid: number;
  costBasisUsd: number;
  unpricedFills: number;
  stoppedAtClose: boolean;
}

/** TRA-3909 — the broker's one row for this OCC symbol. */
export interface LotAdoptionBrokerView {
  optionSymbol: string;
  contracts: number;
  /** Tradier `cost_basis / quantity / 100`, i.e. the LOT BLEND. */
  premiumPaid: number;
}

/**
 * TRA-3909 — why a symbol was not restructured.
 *
 * Enumerated, not prose, for the same reason
 * {@link import('./options-account.js').EngineBasisRepairRefusal} is: the route
 * publishes these and a caller has to be able to branch on them. Every one of
 * them leaves the book EXACTLY as it found it — no close, no broker write, no
 * partial application.
 */
export type LotAdoptionRefusalReason =
  /** Not the live book. The fill ledger records LIVE fills only. */
  | 'not_live'
  | 'no_occ'
  /**
   * No engine-owned row on this symbol. This is TRA-3829's population — a
   * standalone desk position — and it stays guarded exactly as that ticket left
   * it. Adoption here is scoped to *a desk lot added to a trade the engine is
   * already in*, which is the narrower thing the board ruled on.
   */
  | 'no_engine_row'
  /**
   * More than one engine row, or a pre-existing `foreign` import, on the same
   * OCC. Attribution is not determinate, so nothing is written.
   */
  | 'group_ambiguous'
  /** An exit or close is in flight on this symbol; the pollers own the basis. */
  | 'in_flight'
  | 'multi_leg'
  | 'covered_write'
  /**
   * The fill ledger holds no `buy_to_open` for this contract. ⛔ `null` is NOT
   * permission — it is the oracle unable to answer, and the fail-open reading of
   * it is what put a foreign contract on an engine row in the first place.
   */
  | 'oracle_silent'
  /**
   * Recorded fills carry no usable `filledPrice`, so the engine-side cost basis
   * is an average over the priced subset only and the residual would be wrong by
   * however much it missed. The order's explicit `unpricedFills > 0` refusal.
   */
  | 'oracle_unpriced'
  /**
   * The ledger's backward walk stopped at a `sell_to_close` AND the engine rows
   * hold more than it accounts for. A PARTIAL close truncates the episode, so
   * "the ledger is short because a foreign contract was absorbed" and "the
   * ledger is short because it was truncated" are the same shape — and only the
   * first is safe to act on. Refuse rather than pick.
   */
  | 'ledger_truncated_by_close'
  /**
   * Engine rows hold FEWER contracts than our own priced fills account for, with
   * no close in the episode to explain it. The book and the ledger disagree in
   * the direction this module cannot repair.
   */
  | 'engine_rows_short_of_ledger'
  /** The broker lot's quantity or blended premium is not a usable number. */
  | 'broker_lot_unreadable'
  /**
   * `broker_ct <= engine_ct` — there is no residual to adopt. Not a defect; it
   * is the ordinary state of a book with no desk adds on it, and it is reported
   * rather than silently skipped so a whole book of them is legible.
   */
  | 'no_residual'
  /**
   * The residual dollars are ≤ 0 or non-finite. The order's explicit "residual
   * is negative" refusal — a desk lot cannot have cost nothing.
   */
  | 'residual_non_positive'
  /**
   * Desk rows on this symbol hold MORE contracts than the broker reports, i.e.
   * the desk closed part of their own lot. Reducing it means booking a close,
   * and this change places no order and books no exit (TRA-3909 non-negotiable).
   * Reported here and visible as a `shortfall` on `brokerPositionDrift`.
   */
  | 'desk_rows_exceed_broker';

export interface LotAdoptionRefusal {
  optionSymbol: string;
  reason: LotAdoptionRefusalReason;
  detail: string;
  brokerContracts: number | null;
  engineContracts: number | null;
  deskContracts: number | null;
  recordedContracts: number | null;
}

/** TRA-3909 — shrink an engine row back to the lot it actually bought. */
export interface LotSplitStep {
  positionId: string;
  fromContracts: number;
  toContracts: number;
  fromPremiumPaid: number;
  /** The ledger's own quantity-weighted fill price. Never the broker's blend. */
  toPremiumPaid: number;
}

/** TRA-3909 — mint a row for the desk's contracts at their own residual basis. */
export interface LotMintStep {
  contracts: number;
  premiumPaid: number;
  residualUsd: number;
}

export interface LotAdoptionPlan {
  optionSymbol: string;
  brokerContracts: number;
  brokerCostBasisUsd: number;
  engineHeldContracts: number;
  deskHeldContracts: number;
  recordedContracts: number | null;
  recordedCostBasisUsd: number | null;
  split: LotSplitStep | null;
  mint: LotMintStep | null;
  refusals: LotAdoptionRefusal[];
}

/** TRA-3909 — one adopted desk lot, as the route publishes it. */
export interface AdoptedLotView {
  positionId: string;
  optionSymbol: string;
  mode: string;
  contracts: number;
  premiumPaid: number;
  /** The breach predicate's own input — `options-account.ts:1123`, NOT `lastMark`. */
  currentPremium: number;
  stopLossPremium: number;
  /** `null` when the row carries the `+Infinity` "no take-profit" sentinel. */
  tp1Premium: number | null;
  sleeve: string | null;
  openedAt: number;
  /**
   * ⚠️ The field that says whether this row is theatre. An adopted lot the
   * engine may not act on carries a stop nothing will ever fire, which reads
   * identically to a managed one on every other field here.
   */
  engineMayAct: boolean;
  stopArmed: boolean;
  riskUnmanagedReason: string | null;
}

/**
 * TRA-3909 — the AC4 reading: every adopted lot named, every refused one named.
 *
 * ⚠️ Read `adopted` and `refused` TOGETHER, and read `mintedTotal` with both. A
 * build where this mechanism is absent publishes `{adopted: [], refused: [],
 * mintedTotal: 0}` and so does a book nobody has ever added to — the
 * discriminator between those two is `symbolsExamined`, which is non-zero
 * whenever the pass ran over any symbol at all.
 */
export interface LiveLotAdoptionReport {
  /** ms epoch of the last pass, or `null` if the pass has never run. */
  ranAt: number | null;
  /** Live symbols the pass reached. `0` with a non-empty book ⇒ it did not run. */
  symbolsExamined: number;
  adopted: AdoptedLotView[];
  refused: LotAdoptionRefusal[];
  mintedLast: number;
  splitLast: number;
  mintedTotal: number;
  splitTotal: number;
  refusedTotal: number;
  /**
   * Reconcile passes that refused the broker's blended copy because the symbol
   * held more than one row. NON-ZERO IS THE HEALTHY STEADY STATE of a split
   * symbol — it is the count of times the blend was NOT written.
   */
  brokerCopyRefusedOnSplitSymbol: number;
  /** TRA-3909 — OCC collisions between books; see the counter's own docblock. */
  crossModeSymbolCollisions: number;
}

function usable(n: number | undefined | null): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * TRA-3909 — decide what, if anything, to do with one broker OCC row.
 *
 * ── The invariant ───────────────────────────────────────────────────────────
 * For every OCC symbol on the live book:
 *
 *   Σ engine-owned rows  ≡  what this engine's fill ledger accounts for
 *   Σ desk-added rows    ≡  broker contracts − that
 *
 * The SPLIT enforces the first clause and the MINT enforces the second, and
 * they are the same residual computed once. XLF is the first clause biting (row
 * holds 2, ledger accounts for 1 ⇒ split to 1 @ 1.08 and mint 1 @ 0.85); BAC is
 * the second (row holds 1 = ledger 1, broker holds 2 ⇒ mint 1 @ 1.17).
 *
 * ── Idempotence is the deliverable, not a nicety ────────────────────────────
 * The reconcile runs on BOOT and every 30s thereafter, so a plan that re-minted
 * would double the book on the next tick, and one that re-blended would undo
 * itself within seconds — which is exactly why the hand-repair route could
 * never have fixed XLF. After one application BOTH clauses read satisfied and
 * this returns a plan with no steps, forever. That is what makes the
 * restart-durability acceptance mean something instead of being a re-run.
 */
export function planLotAdoption(
  broker: LotAdoptionBrokerView,
  rows: readonly LotAdoptionRowView[],
  recorded: LotAdoptionLedgerView | null,
  opts: { live: boolean },
): LotAdoptionPlan {
  const optionSymbol = broker.optionSymbol;
  const engineRows = rows.filter(r => r.provenance === 'engine');
  const deskRows = rows.filter(r => r.provenance === 'desk_add');
  const foreignRows = rows.filter(r => r.provenance === 'foreign');
  const engineHeldContracts = engineRows.reduce((a, r) => a + (usable(r.contracts) ? r.contracts : 0), 0);
  const deskHeldContracts = deskRows.reduce((a, r) => a + (usable(r.contracts) ? r.contracts : 0), 0);

  const brokerContracts = usable(broker.contracts) ? broker.contracts : 0;
  const brokerCostBasisUsd = usable(broker.premiumPaid) && brokerContracts > 0
    ? round2(broker.premiumPaid * brokerContracts * 100)
    : 0;

  const plan: LotAdoptionPlan = {
    optionSymbol,
    brokerContracts,
    brokerCostBasisUsd,
    engineHeldContracts,
    deskHeldContracts,
    recordedContracts: recorded ? recorded.contracts : null,
    recordedCostBasisUsd: recorded ? round2(recorded.costBasisUsd) : null,
    split: null,
    mint: null,
    refusals: [],
  };

  const refuse = (reason: LotAdoptionRefusalReason, detail: string): LotAdoptionPlan => {
    plan.split = null;
    plan.mint = null;
    plan.refusals = [{
      optionSymbol,
      reason,
      detail,
      brokerContracts: brokerContracts > 0 ? brokerContracts : null,
      engineContracts: engineRows.length > 0 ? engineHeldContracts : null,
      deskContracts: deskRows.length > 0 ? deskHeldContracts : null,
      recordedContracts: recorded ? recorded.contracts : null,
    }];
    return plan;
  };

  if (!opts.live) {
    return refuse('not_live', 'the fee/slippage fill ledger records LIVE fills only, so the engine side of the residual has no source on a demo book.');
  }
  if (optionSymbol === '') return refuse('no_occ', 'the broker row carries no OCC symbol.');
  if (!usable(broker.contracts) || !usable(broker.premiumPaid)) {
    return refuse('broker_lot_unreadable', 'the broker lot\'s quantity or blended premium is not a positive finite number, so its cost basis cannot be reconstructed.');
  }
  if (engineRows.length === 0) {
    // NOT a defect and NOT widened: a standalone desk position is exactly the
    // TRA-3829 population, and the ordinary `foreign` adoption path already owns
    // it. Adoption here requires an engine contract on the same OCC.
    return refuse('no_engine_row', 'no engine-owned row on this symbol; a standalone desk position stays on the TRA-3829 guarded path.');
  }
  if (engineRows.length > 1 || foreignRows.length > 0) {
    return refuse(
      'group_ambiguous',
      `${engineRows.length} engine row(s) and ${foreignRows.length} foreign import(s) share this OCC; which lot a residual belongs to is not determinate, so nothing is written.`,
    );
  }
  if (rows.some(r => r.multiLeg)) return refuse('multi_leg', 'a combo is not one OCC row; its basis is not one number to split.');
  if (rows.some(r => r.coveredWrite)) return refuse('covered_write', 'a covered write is short; its premium is credit received, not a debit basis.');
  if (rows.some(r => r.inFlight)) {
    return refuse('in_flight', 'an exit or close is in flight on this symbol; the exit/close pollers own these rows\' basis until it resolves.');
  }

  if (!recorded) {
    return refuse('oracle_silent', 'the live fill ledger holds no `buy_to_open` for this contract in the current open episode. An absent record is the oracle unable to answer, NOT permission to derive a basis.');
  }
  if (recorded.unpricedFills > 0) {
    return refuse('oracle_unpriced', `${recorded.unpricedFills} recorded open fill(s) carry no usable price, so the engine-side cost basis is an average over the priced subset only and the residual would absorb the difference.`);
  }
  if (!usable(recorded.contracts) || !usable(recorded.premiumPaid) || !usable(recorded.costBasisUsd)) {
    return refuse('oracle_unpriced', 'the recorded fill quantity or weighted basis is not a positive finite number.');
  }

  // ── Clause 1: the engine rows must hold exactly what the ledger bought ─────
  const engineRow = engineRows[0]!;
  if (engineHeldContracts > recorded.contracts) {
    if (recorded.stoppedAtClose) {
      return refuse(
        'ledger_truncated_by_close',
        `the row holds ${engineHeldContracts} and the ledger accounts for ${recorded.contracts}, but the episode walk stopped at a \`sell_to_close\` — a partial close truncates the window, so an absorbed foreign contract and a truncated ledger are the same shape here.`,
      );
    }
    plan.split = {
      positionId: engineRow.id,
      fromContracts: engineHeldContracts,
      toContracts: recorded.contracts,
      fromPremiumPaid: engineRow.premiumPaid,
      toPremiumPaid: recorded.premiumPaid,
    };
  } else if (engineHeldContracts < recorded.contracts) {
    return refuse(
      'engine_rows_short_of_ledger',
      `the engine rows hold ${engineHeldContracts} and our own priced fills account for ${recorded.contracts} with no close in the episode; the book and the ledger disagree in the direction this pass cannot repair.`,
    );
  }

  // ── Clause 2: the desk rows must hold the residual ────────────────────────
  const deskTarget = brokerContracts - recorded.contracts;
  if (deskTarget < 0) {
    // The broker holds fewer contracts than we bought — a broker-side close, not
    // a desk add. The broker-flat / partial-close bookkeeping owns that; this
    // pass places no order and books no exit.
    return refuse(
      'no_residual',
      `the broker holds ${brokerContracts} and our own fills account for ${recorded.contracts}; there is no desk residual to adopt (a reduction is the reconcile's own bookkeeping, not this pass's).`,
    );
  }
  if (deskHeldContracts > deskTarget) {
    return refuse(
      'desk_rows_exceed_broker',
      `adopted desk rows hold ${deskHeldContracts} against a residual of ${deskTarget}; reducing them means booking a close, and this pass places no order and books no exit. Visible as a shortfall on \`brokerPositionDrift\`.`,
    );
  }
  if (deskTarget === 0 || deskHeldContracts === deskTarget) {
    // Steady state — including the second and every later run over an already
    // adopted symbol. Reported as `no_residual` when there was never one, and as
    // a clean plan with no steps when the residual is already carried.
    if (deskTarget === 0 && plan.split === null) {
      return refuse(
        'no_residual',
        `broker ${brokerContracts} ct == this engine's recorded ${recorded.contracts} ct; nothing was added outside this engine.`,
      );
    }
    return plan;
  }

  const residualContracts = deskTarget - deskHeldContracts;
  const deskCarriedUsd = deskRows.reduce(
    (a, r) => a + (usable(r.premiumPaid) && usable(r.contracts) ? r.premiumPaid * r.contracts * 100 : 0),
    0,
  );
  const residualUsd = round2(brokerCostBasisUsd - recorded.costBasisUsd - deskCarriedUsd);
  const premiumPaid = residualUsd / (residualContracts * 100);
  if (!usable(residualUsd) || !usable(premiumPaid)) {
    return refuse(
      'residual_non_positive',
      `residual = broker ${brokerCostBasisUsd} − engine-recorded ${round2(recorded.costBasisUsd)} − already-adopted ${round2(deskCarriedUsd)} = ${residualUsd} over ${residualContracts} contract(s); a desk lot cannot have cost nothing, so the derivation is declined rather than rounded.`,
    );
  }

  plan.mint = { contracts: residualContracts, premiumPaid, residualUsd };
  return plan;
}
