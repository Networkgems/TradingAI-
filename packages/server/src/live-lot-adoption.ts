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
//
// ── TRA-3960: the residual's evidence EXPIRES in about one trading day ──────
// The residual is exact only while the engine's side is non-zero. The moment
// the engine sibling closes, Tradier's `/positions` reports the survivor at the
// two-lot AVERAGE, and `(X − 0) / (N − 0)` is not a residual — it is the blend
// wearing one. On the live BAC row that was 1.41 for two days (TRA-3895 →
// TRA-3958), and the only thing that stopped it being re-derived here was the
// upstream `no_engine_row` refusal. Two things follow, both below:
//
//   1. The capture store (TRA-3939, `tra3939-broker-order-capture.jsonl`) is
//      consulted FIRST. It holds the broker's one-day `/orders` window, day by
//      day, forever — so a desk `buy_to_open` with an order id and a price is
//      still readable next week, when `/orders` has long since rolled over and
//      the fill ledger (which never held a desk order) still answers nothing.
//      An order id and a price beat an arithmetic residual.
//   2. The residual identity REFUSES when its engine side is zero
//      (`engine_side_zero`). That refusal did not exist; it is the one that
//      would have caught BAC.
//
// Whichever source priced the lot is carried on the mint step as DATA
// (`basisSource`), so a capture-sourced basis and a residual-sourced one are
// distinguishable on the row, in the log and on the route.

/**
 * TRA-3960 — one captured broker order, narrowed to what the planner reads.
 * The caller builds these from `capturedBrokerOrders()`; `etDay` is derived by
 * the caller from `createDate` so this module stays clock-free.
 */
export interface LotAdoptionCapturedOrder {
  orderId: number;
  status: string;
  orderClass: string;
  side: string | null;
  optionSymbol: string | null;
  execQuantity: number | null;
  avgFillPrice: number | null;
  /** `Date.parse(createDate)`, or `null` when the capture row carried no date. */
  createMs: number | null;
  /** ET day of `createDate`, or `null` when the capture row carried no date. */
  etDay: string | null;
}

/**
 * TRA-3960 — the capture store as a basis source.
 *
 * ── What the capture is asked, and what it is NOT asked ─────────────────────
 * It is asked for the PRICE of the residual contracts. It is not asked WHO
 * placed them: the residual identity already labels every contract the fill
 * ledger cannot account for `desk_add`, and the capture prices exactly that
 * population — filled `buy_to_open` on this OCC whose id the fill ledger does
 * not hold. An engine fill the chokepoint missed (TRA-2959: 7 of 11) lands in
 * the residual under BOTH sources, at its real price under this one. So the
 * submit witness's attestation — TRA-3939's guard against ACCUSING a human of
 * an engine trade — is not load-bearing for the price. It is PUBLISHED
 * (`captureAttestation`), never required; measured live 2026-08-22, bqb1 boots
 * mid-session often enough that both captured days read `partial`, and a
 * predicate that required `full` would decline on nearly every real day.
 *
 * ── What IS load-bearing ────────────────────────────────────────────────────
 *   • `engineOrderIds` — the fill ledger's own ids for this OCC (∪ the submit
 *     ledger's). The exclusion set that defines the population.
 *   • `episodeStartMs` — the engine's first `buy_to_open` in the CURRENT open
 *     episode. A desk add "to a trade the engine is in" cannot predate it, and
 *     a desk round-trip from an earlier episode must not price this one.
 *   • no non-engine `sell_to_close` inside the window — a desk that reduced
 *     its lot makes which fill is still open a FIFO question, and this module
 *     does not guess.
 *   • the candidates sum EXACTLY to the residual.
 */
export interface LotAdoptionCaptureView {
  orders: readonly LotAdoptionCapturedOrder[];
  /** `EngineSubmitWitnessSummary.coveredEtDays` — stamped on the mint, not required. */
  attestedEtDays: readonly string[];
  /** Submit-ledger production ids ∪ this symbol's fill-ledger `orderIds`. */
  engineOrderIds: ReadonlySet<number>;
  /** Fill time of the engine's oldest open in the current episode; `null` ⇒ unknown ⇒ decline. */
  episodeStartMs: number | null;
}

/** TRA-3960 — where a minted lot's `premiumPaid` came from. Never absent. */
export type LotMintBasisSource =
  /** The desk's own `buy_to_open`, by order id, from the TRA-3939 capture. */
  | 'capture_fill'
  /** `broker_cost − engine_cost` over the residual contracts (TRA-3909). */
  | 'residual_identity';

/**
 * TRA-3960 — why a mint fell back to the residual. Published on the step so a
 * residual-sourced mint NEXT to a populated capture store is legible as the
 * capture declining, not as the capture never having been asked.
 */
export type LotMintCaptureFallbackReason =
  /** The caller passed no capture view (the store is not wired on this path). */
  | 'capture_absent'
  /** No filled `buy_to_open` on this OCC in the store that is not an engine id. */
  | 'no_desk_fill_captured'
  /** The engine's episode start is unknown, so no window can be drawn. */
  | 'episode_unknown'
  /** Candidates exist, but all predate the engine's current episode (or are undated). */
  | 'outside_episode'
  /** A non-engine `sell_to_close` sits inside the window: which fill is open is FIFO. */
  | 'desk_close_in_window'
  /** A candidate carries no usable `avgFillPrice` / `execQuantity`. */
  | 'unpriced'
  /** The in-window desk fills do not sum to the residual contracts. */
  | 'quantity_mismatch';

/** TRA-3960 — whether the submit witness covers every day the capture priced from. */
export type LotMintCaptureAttestation = 'full' | 'partial';

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
   * TRA-3960 — the ENGINE side of the residual identity is zero: no recorded
   * engine contracts, no recorded engine dollars, or no engine contracts held.
   * `(broker_cost − 0) / (broker_ct − 0)` is not a residual, it is the broker's
   * AVERAGE wearing one — on BAC that average was 1.41, and neither lot ever
   * traded there. Refused here, in the arithmetic, so no re-ordering of the
   * upstream guards can ever reach the blend.
   */
  | 'engine_side_zero'
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

/**
 * TRA-3909 — mint a row for the desk's contracts at their own basis.
 *
 * TRA-3960 — `premiumPaid` is the figure to install; `basisSource` says where
 * it came from. BOTH candidate figures are always carried (`residualPremiumPaid`
 * is computed whatever wins) so a capture-sourced mint that disagrees with the
 * residual is visible as a disagreement rather than as one number.
 */
export interface LotMintStep {
  contracts: number;
  premiumPaid: number;
  /** `broker_cost − engine_recorded − already-adopted`, in dollars. */
  residualUsd: number;
  basisSource: LotMintBasisSource;
  /** The residual identity's own figure, whichever source won. */
  residualPremiumPaid: number;
  /** Order ids the capture priced this lot from. Empty on `residual_identity`. */
  captureOrderIds: number[];
  /** `Σ execQuantity × avgFillPrice × 100` over `captureOrderIds`, else `null`. */
  captureCostUsd: number | null;
  /** Why the capture did NOT price this lot. `null` iff `basisSource === 'capture_fill'`. */
  captureFallback: LotMintCaptureFallbackReason | null;
  /**
   * Whether the submit witness attests every ET day the capture priced from.
   * `null` unless `basisSource === 'capture_fill'`. Legibility, not a gate —
   * see {@link LotAdoptionCaptureView}.
   */
  captureAttestation: LotMintCaptureAttestation | null;
}

/**
 * TRA-3960 — find the desk's own fills for `residualContracts` on `optionSymbol`
 * in the capture store. PURE. Returns the priced lot, or the reason it declined.
 *
 * The population is by EXCLUSION and by WINDOW, never by shape: a filled
 * `buy_to_open` on this OCC whose id the fill ledger does not hold, created at
 * or after the engine's first open in the current episode, with no non-engine
 * close in that window. The candidates must sum EXACTLY to the residual — a
 * partial match would price some of the residual off a fill and the rest off
 * nothing.
 */
export function priceResidualFromCapture(
  capture: LotAdoptionCaptureView | null | undefined,
  optionSymbol: string,
  residualContracts: number,
):
  | { ok: true; premiumPaid: number; costUsd: number; orderIds: number[]; attestation: LotMintCaptureAttestation }
  | { ok: false; reason: LotMintCaptureFallbackReason; detail: string } {
  if (!capture) return { ok: false, reason: 'capture_absent', detail: 'no capture view was supplied on this path.' };
  const nonEngineFilled = capture.orders.filter(o =>
    o.optionSymbol === optionSymbol
    && o.orderClass === 'option'
    && o.status === 'filled'
    && Number.isFinite(o.orderId)
    && !capture.engineOrderIds.has(o.orderId));
  const opens = nonEngineFilled.filter(o => o.side === 'buy_to_open');
  if (opens.length === 0) {
    return { ok: false, reason: 'no_desk_fill_captured', detail: `the capture store holds no filled \`buy_to_open\` on ${optionSymbol} outside the engine's own order ids.` };
  }
  const start = capture.episodeStartMs;
  if (start === null || !Number.isFinite(start)) {
    return { ok: false, reason: 'episode_unknown', detail: `${opens.length} candidate fill(s) on ${optionSymbol} but the engine's episode start is unknown, so no window can be drawn around them.` };
  }
  const inWindow = opens.filter(o => o.createMs !== null && Number.isFinite(o.createMs) && o.createMs >= start);
  if (inWindow.length === 0) {
    const days = [...new Set(opens.map(o => o.etDay ?? 'undated'))].sort();
    return {
      ok: false,
      reason: 'outside_episode',
      detail: `${opens.length} candidate fill(s) on ${days.join(', ')} all predate the engine's current episode (or are undated); a desk add to this trade cannot precede it.`,
    };
  }
  const closesInWindow = nonEngineFilled.filter(o =>
    o.side === 'sell_to_close' && o.createMs !== null && Number.isFinite(o.createMs) && o.createMs >= start);
  if (closesInWindow.length > 0) {
    return {
      ok: false,
      reason: 'desk_close_in_window',
      detail: `non-engine sell_to_close order(s) ${closesInWindow.map(o => o.orderId).join(', ')} sit inside the episode window; which desk fill is still open is a FIFO question this pass does not answer.`,
    };
  }
  let qty = 0;
  let costUsd = 0;
  const orderIds: number[] = [];
  const attested = new Set(capture.attestedEtDays);
  let attestation: LotMintCaptureAttestation = 'full';
  for (const o of inWindow) {
    if (!usable(o.execQuantity) || !usable(o.avgFillPrice) || !Number.isInteger(o.execQuantity)) {
      return { ok: false, reason: 'unpriced', detail: `captured order ${o.orderId} carries execQuantity ${o.execQuantity} / avgFillPrice ${o.avgFillPrice}; a fill with no price cannot be a basis.` };
    }
    qty += o.execQuantity;
    costUsd += o.execQuantity * o.avgFillPrice * 100;
    orderIds.push(o.orderId);
    if (o.etDay === null || !attested.has(o.etDay)) attestation = 'partial';
  }
  if (qty !== residualContracts) {
    return {
      ok: false,
      reason: 'quantity_mismatch',
      detail: `in-window desk fills on ${optionSymbol} (orders ${orderIds.join(', ')}) total ${qty} contract(s) against a residual of ${residualContracts}; a partial attribution would price part of the lot off nothing.`,
    };
  }
  const premiumPaid = costUsd / (qty * 100);
  if (!usable(premiumPaid)) {
    return { ok: false, reason: 'unpriced', detail: `capture cost ${costUsd} over ${qty} contract(s) is not a positive finite premium.` };
  }
  return { ok: true, premiumPaid, costUsd: round2(costUsd), orderIds, attestation };
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

/**
 * TRA-3916 / TRA-4218 — the `checkExits` gates that can refuse a single-leg long
 * desk lot, in that walk's own order. `multi_leg_combo` / `covered_write` cannot
 * reach a row this pass mints, so they are not in the union.
 */
export type AdoptedLotExitGate =
  | 'imported_auto_manage_off'
  | 'imported_no_broker_mirror'
  | 'adopted_not_authorized'
  | 'stop_not_armed'
  | 'close_reject_breaker'
  /** TRA-4266 — latched AND every half-open retest spent; the only one with no release. */
  | 'close_reject_breaker_exhausted'
  | 'exit_transport_backoff'
  | 'exit_expired_breaker';

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
   *
   * TRA-3916 (CTO review) — this is the COMPOSED answer, not
   * `engineMayActOnAdoptedRow` alone. That predicate sits FIFTH in the
   * `checkExits` inert walk, behind `imported_auto_manage_off` and
   * `imported_no_broker_mirror`, both of which apply to every imported row. With
   * either of those off the bare predicate returns `true` on a row whose stop
   * the exit pass will never fire — precisely the reads-identically shape this
   * route exists to break. {@link exitInertReason} names which gate refused.
   */
  engineMayAct: boolean;
  /**
   * TRA-3916 — the FIRST gate in the `checkExits` walk that refuses this row, in
   * that walk's own order, or `null` when nothing does. A bare boolean cannot be
   * acted on; this can.
   *
   * TRA-4218 — the three run-time suppressions below were MISSING from this
   * walk, and their absence was measured live: adopted row `a2f9c8cd`
   * (NOK261002C00010500) published `engineMayAct: true, exitInertReason: null,
   * stopArmed: true` on 2026-09-01T02:47Z while carrying `closeRejectCount: 3`
   * — its auto-close had been paused for eleven hours. This route exists to
   * break the "reads identically to a managed row" shape and it was reproducing
   * that shape itself, because the walk was re-implemented from the STATIC
   * gates only. The gates a row acquires while it trades are exactly the ones a
   * census is for.
   */
  exitInertReason: AdoptedLotExitGate | null;
  /**
   * TRA-4225 — EVERY gate refusing this row, in the same walk order, not just
   * the first. `exitInertReasons[0] === exitInertReason` always.
   *
   * The first-gate answer above is right about "which gate did the not-acting"
   * and wrong as an inventory of what is wrong with the row. On 2026-08-31 the
   * production book's adopted row carried BOTH `adopted_not_authorized` and a
   * latched `close_reject_breaker` from a Tradier 500 — and only the first was
   * published, so the fleet's three identically-latched rows read as three
   * different hazards. Clearing the gate a surface names and finding the row
   * still inert is the failure mode this closes.
   */
  exitInertReasons: AdoptedLotExitGate[];
  stopArmed: boolean;
  riskUnmanagedReason: string | null;
  /**
   * TRA-3960 — where this lot's `premiumPaid` came from, read off the row's
   * `deskAddBasis` stamp. `null` on rows minted before the stamp existed
   * (pre-TRA-3960 residual mints); never defaulted to a source.
   */
  basisSource: LotMintBasisSource | null;
  /** TRA-3960 — the capture order id(s) behind a `capture_fill` basis. */
  basisOrderIds: number[];
  /** TRA-3960 — witness coverage of the capture days behind a `capture_fill` basis. */
  basisAttestation: LotMintCaptureAttestation | null;
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
  /**
   * TRA-3916 — broker increases refused on a SOLE `desk_add` row: a second desk
   * add on a symbol the engine has since left. The refusal that stops a desk lot
   * absorbing another and then decaying into `engine_origin`.
   */
  deskLotAbsorptionRefusals: number;
  /**
   * TRA-3960 — mints priced off the TRA-3939 capture store vs off the residual
   * identity, since boot. `mintedTotal === mintedFromResidualTotal` with a
   * populated capture store is the capture being DECLINED on every mint (see
   * `captureFallback` on the log line), not the capture being unwired.
   */
  mintedFromCaptureTotal: number;
  mintedFromResidualTotal: number;
  /**
   * TRA-3916 — the two `checkExits` gates that precede the authority test and
   * apply to every imported row, echoed so a reader can see WHY a lot's
   * `engineMayAct` reads false without re-deriving the engine's state.
   */
  gates: { autoManageImportedTradierOptions: boolean; brokerMirroring: boolean };
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
  /**
   * TRA-3960 — the capture store. `undefined`/`null` is recorded on the mint as
   * `captureFallback: 'capture_absent'`, never silently read as "consulted and
   * empty".
   */
  capture?: LotAdoptionCaptureView | null,
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
  // TRA-3960 — the engine side of the subtraction must be NON-ZERO before any
  // residual is computed. Checked on its own, ahead of the generic usability
  // test, because "zero" is the specific shape that returns the broker's blend
  // and it deserves its own name in the refusal list.
  if (recorded.contracts === 0 || recorded.costBasisUsd === 0 || engineHeldContracts === 0) {
    return refuse(
      'engine_side_zero',
      `recorded engine side is ${recorded.contracts} ct / $${round2(recorded.costBasisUsd)} and the engine rows hold ${engineHeldContracts}; (broker ${brokerCostBasisUsd} − 0) / (${brokerContracts} − 0) is the broker's average, not a residual, so the identity refuses rather than re-derive the blend.`,
    );
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
  // ── The residual identity. ⛔ Guarded again HERE, at the arithmetic: a zero
  // engine side returns the blend, and this guard must hold whatever is
  // re-ordered above it (TRA-3960).
  if (!(recorded.costBasisUsd > 0) || !(recorded.contracts > 0)) {
    return refuse('engine_side_zero', `residual identity reached with engine side ${recorded.contracts} ct / $${round2(recorded.costBasisUsd)}; refused at the arithmetic.`);
  }
  const residualUsd = round2(brokerCostBasisUsd - recorded.costBasisUsd - deskCarriedUsd);
  const residualPremiumPaid = residualUsd / (residualContracts * 100);
  if (!usable(residualUsd) || !usable(residualPremiumPaid)) {
    // A non-positive residual is the book and the ledger DISAGREEING, not a
    // pricing question — so a captured fill does not rescue it. The capture is
    // a better PRICE for a lot the identity already admits exists; it is not
    // evidence that overrides an inconsistency on the engine side.
    return refuse(
      'residual_non_positive',
      `residual = broker ${brokerCostBasisUsd} − engine-recorded ${round2(recorded.costBasisUsd)} − already-adopted ${round2(deskCarriedUsd)} = ${residualUsd} over ${residualContracts} contract(s); a desk lot cannot have cost nothing, so the derivation is declined rather than rounded.`,
    );
  }

  // ── TRA-3960: the capture store is consulted FIRST for the PRICE ───────────
  // A recorded desk fill (order id + price) beats the arithmetic. It is also the
  // only source that survives the engine sibling closing, because the residual
  // above has no engine side left at that point and refuses.
  const captured = priceResidualFromCapture(capture, optionSymbol, residualContracts);
  if (captured.ok) {
    plan.mint = {
      contracts: residualContracts,
      premiumPaid: captured.premiumPaid,
      residualUsd,
      basisSource: 'capture_fill',
      residualPremiumPaid,
      captureOrderIds: captured.orderIds,
      captureCostUsd: captured.costUsd,
      captureFallback: null,
      captureAttestation: captured.attestation,
    };
    return plan;
  }

  plan.mint = {
    contracts: residualContracts,
    premiumPaid: residualPremiumPaid,
    residualUsd,
    basisSource: 'residual_identity',
    residualPremiumPaid,
    captureOrderIds: [],
    captureCostUsd: null,
    captureFallback: captured.reason,
    captureAttestation: null,
  };
  return plan;
}
