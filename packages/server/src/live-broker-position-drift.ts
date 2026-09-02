/**
 * TRA-3067 — read-only intraday cross-check of BROKER truth against the
 * engine's own open LIVE rows.
 *
 * ## Why this exists
 *
 * TRA-2983 established that `PLTR260911C00170000` was opened by the engine on
 * 2026-08-04 13:43:03Z and then sold **at the broker with no order from any
 * code path on bqb1** (proven with a three-control read of the full-day log:
 * the close emitter logged 3 times that same afternoon for SPY, PLTR appears
 * twice and both are the open). The TRA-483 PDT gate did not fire because an
 * out-of-band close never reaches `checkExits` at all — it is not a gate
 * failure, it is a *visibility* failure.
 *
 * `diffMissingFillsFromHistory` deliberately skips same-day fills
 * (`if (day >= todayEt) continue`), which is correct for the fee ledger and
 * means a broker-side close we did not order is invisible until the NEXT ET
 * day's import. In that window the engine believes it holds a position it does
 * not hold: greeks, exposure and equity are all wrong, an exit can be submitted
 * into a flat broker position (the TRA-2799 "not closing a long position"
 * shape), and the round trip silently consumes PDT day-trade budget on a
 * sub-$25k account. It then heals via `origin: history_import` with **no
 * alarm** — which is why it took a post-close grade to find at all.
 *
 * ## What this is NOT
 *
 * It is **not** a healer. `reconcileTradierPositions` already books a local
 * close when the broker stops reporting an engine-opened row
 * (`closeBrokerFlatPosition`, two consecutive misses, TRA-2799). That heal is
 * wanted — the row must not sit open forever — but it is precisely the silent
 * part TRA-2983 says hid the event. This module only ever READS and returns a
 * verdict; the caller logs it. No row is mutated, no order is placed, no
 * broker write is made.
 *
 * ## Why it does not reuse `listOpenOptionPositions()`
 *
 * That method returns `[]` both when the account genuinely holds nothing and
 * when the request fails: `getJson` returns `null` on any non-2xx and
 * `parseTradierPositions(null)` is `[]`. An instrument fed from it has **no
 * absence state** — a 401 would read as "the broker is flat on everything",
 * which is the maximally alarming reading of an unreadable broker (and the
 * exact shape of the recurring bug this repo keeps hitting: a read route that
 * synthesises on miss). So the input here is a discriminated union that a
 * caller can only produce from a read that distinguished the two, and a failed
 * read produces `status: 'blind'` — never `clean`, and never `drift`.
 *
 * ## Why counts, never a boolean
 *
 * A boolean `inSync` reads identically at 1 missing contract and at 10. Every
 * verdict below is per-OCC-symbol contract arithmetic, and the top-level
 * numbers are sums of contracts, not flags.
 *
 * ## The discriminator
 *
 * "The broker is flat because WE closed it" and "the broker is flat because
 * SOMEONE ELSE did" are the two readings that matter, and they are separated by
 * the engine's own submission record — a `pendingExit` carrying a real Tradier
 * order id, or a `pendingCloseOrderId`. Note what does NOT count: a
 * `pendingExit` whose `tradierOrderId` is `''` was staged and never handed to
 * the broker (TRA-2819), so it explains nothing at all about the broker's book.
 * Treating it as an explanation would have made this detector silent on exactly
 * the row that most needs it.
 */
import type { TradierOpenOptionPosition } from '@trading-app/engine';
import type { OptionPosition, TradierEnv } from '@trading-app/shared';

/**
 * A position read that kept its failure state. `ok: false` is NOT an empty
 * book — see the module doc.
 */
export type BrokerPositionsRead =
  | { ok: true; positions: readonly TradierOpenOptionPosition[] }
  | { ok: false; reason: BrokerReadFailure; detail?: string };

/**
 * Why a read could not be turned into a statement about the broker's book.
 *
 *   • `http_status`  — the broker answered non-2xx. Unreadable, not flat.
 *   • `transport`    — fetch threw / the body was not JSON.
 *   • `malformed`    — 2xx, but the envelope carried no `positions` key at all.
 *     Distinct from Tradier's real empty book, which is `positions: "null"`.
 */
export type BrokerReadFailure = 'http_status' | 'transport' | 'malformed';

/**
 * Why an open live row is not in the comparison's denominator.
 *
 * Published as counts because a denominator with an invisible filter in front
 * of it is the same unread instrument as a boolean: `engineRowsChecked: 0` has
 * to say WHY. The carve-outs mirror the TRA-2799 broker-flat sweep, for the
 * same reasons it gives:
 *
 *   • `not_live`    — a demo row has no broker counterpart, so it is "missing"
 *     from every payload.
 *   • `imported`    — a `tradier_import` row is foreign inventory whose
 *     disappearance is already booked by the imported branch of the reconcile.
 *     Its absence is not evidence about an engine order.
 *
 *     ⚠️ TRA-3896 narrows this. It used to swallow EVERY imported row, including
 *     one the reconcile itself classified `adoptionAuthority: 'engine_origin'` —
 *     a contract this engine placed, lost the row for, and re-adopted through
 *     the import path. Those are engine-managed positions with engine stops, and
 *     excluding them left the live check reading `engineRowsChecked: 1` over a
 *     two-row live book. The collision that got REFUSED (BAC) was reported; the
 *     one that got ABSORBED (XLF, a desk contract copied onto the engine's row)
 *     had no instrument on it at all. Engine-origin imports are now in the
 *     denominator; `imported` counts only foreign/unresolved ones.
 *   • `multi_leg`   — a combo is not one OCC row in `/positions`.
 *   • `covered_write` — short; `/positions` short legs are dropped at the
 *     parser, so a short row is absent from the payload by construction.
 *   • `no_occ`      — nothing to join on.
 *   • `no_contracts` — the row holds no remaining contracts, so there is no
 *     shortfall it could have.
 */
export type DriftIneligibleReason =
  | 'not_live'
  | 'imported'
  | 'multi_leg'
  | 'covered_write'
  | 'no_occ'
  | 'no_contracts';

/**
 * How a per-symbol shortfall is explained. Ordered from "needs a human now" to
 * "benign, self-resolving"; they are NOT interchangeable and each carries a
 * different remedy.
 *
 *   • `out_of_band` — the engine has NO submission record for this symbol and
 *     the broker is short. This is the TRA-2983 shape: someone or something
 *     outside this process moved real contracts. ALARM.
 *   • `staged_never_submitted` — the row carries a `pendingExit` with an empty
 *     `tradierOrderId`. The engine intended to close and never reached the
 *     broker (TRA-2819), so the broker being short is still unexplained by any
 *     order of ours. ALARM, and it names a second defect.
 *   • `partially_explained` — an engine close is in flight but for FEWER
 *     contracts than are missing. The remainder is out-of-band. ALARM on the
 *     remainder only.
 *   • `engine_close_in_flight` — an engine submission covers the whole
 *     shortfall. The exit poller owns it and will finalise against the broker's
 *     ORDER status. Benign; counted, not alarmed.
 *   • `too_young` — the row was opened inside {@link DRIFT_MIN_ROW_AGE_MS}. A
 *     still-working open order explains the absence. Benign; counted so a
 *     suppressed row is never invisible.
 */
export type DriftShortfallReason =
  | 'out_of_band'
  | 'staged_never_submitted'
  | 'partially_explained'
  | 'engine_close_in_flight'
  | 'too_young';

/**
 * A row younger than this is not evidence: the open order may still be working
 * at the broker, and `/positions` does not show an unfilled order. Same floor
 * the TRA-2799 sweep uses (`BROKER_MISSING_MIN_AGE_MS`), on purpose — a
 * detector that alarms on rows the healer would not touch generates noise the
 * responder cannot act on.
 */
export const DRIFT_MIN_ROW_AGE_MS = 5 * 60_000;

/** One OCC symbol on which the broker holds fewer contracts than the engine. */
export interface BrokerShortfall {
  optionSymbol: string;
  /** Contracts the engine believes are open (`contractsRemaining`). */
  engineContracts: number;
  /** Contracts the broker reports. 0 means the broker is FLAT on this symbol. */
  brokerContracts: number;
  /** `engineContracts − brokerContracts`, floored at 0. */
  shortfallContracts: number;
  /** Of the shortfall, how many are covered by an engine submission record. */
  explainedContracts: number;
  /** The residue: contracts that left the broker with no order of ours. */
  outOfBandContracts: number;
  reason: DriftShortfallReason;
  /** Engine row ids on this symbol, so the log line is actionable. */
  rowIds: string[];
}

/** One OCC symbol on which the broker holds MORE contracts than the engine. */
export interface BrokerExcess {
  optionSymbol: string;
  engineContracts: number;
  brokerContracts: number;
  excessContracts: number;
}

/**
 * TRA-3896 — one engine-origin row holding MORE contracts than this engine can
 * account for having bought.
 *
 * ── Why `excess` cannot find this ───────────────────────────────────────────
 * `excess` compares the BROKER to the ROW. It fires only while the row has not
 * yet taken the foreign contract in. The moment the reconcile copies the
 * broker's quantity onto the row — which the imported branch did unconditionally
 * until TRA-3896, on every reconcile including the one at boot — row and broker
 * AGREE, and the comparison reads `clean` over the exact state that is wrong.
 *
 * That is the XLF row on 2026-08-20: adopted at 1 contract, 2 at the broker
 * after the desk's 19:36Z add, persisted 2 @ $0.965 with a stop derived from the
 * blend. Every broker-vs-engine instrument called it healthy, because by the
 * time they looked the engine's book had already agreed to the wrong number.
 *
 * So this compares the row against a THIRD source neither of those two can
 * contaminate: this engine's own `buy_to_open` records. `recordedContracts` is
 * what we can prove we bought; anything the row holds beyond it is somebody
 * else's contract wearing our stop.
 */
export interface EngineOriginAbsorption {
  optionSymbol: string;
  /** Contracts the row currently holds (`contractsRemaining`). */
  rowContracts: number;
  /**
   * Contracts this engine's own fill ledger accounts for, or `null` when the
   * ledger cannot answer. `null` is UNRESOLVED — reported, never counted as an
   * absorption, because "we have no record" is also what an empty ledger says
   * about a contract we really did buy.
   */
  recordedContracts: number | null;
  /** `rowContracts − recordedContracts`, or 0 when unresolved. */
  absorbedContracts: number;
  rowIds: string[];
}

/**
 * The verdict. Five states, because "we could not look", "there was nothing to
 * look at", and "we looked and it agreed" have three different remedies and
 * must never collapse into one green.
 *
 *   • `dark`    — the check did not run (not live, no broker client). Nothing
 *     was ever going to be measured.
 *   • `blind`   — the broker was unreadable. NOT flat.
 *   • `vacuous` — the read succeeded and the engine holds no eligible live
 *     row, so the comparison had an empty denominator. Read `ineligible` to
 *     see whether that is genuinely an empty book or a filter eating it.
 *   • `clean`   — at least one eligible row, and the broker matches on every
 *     one of them.
 *   • `excess`  — TRA-3890: at least one engine-owned symbol where the broker
 *     holds MORE than the engine. Until 2026-08-20 this was folded into
 *     `clean` ("reported, not alarmed"). The first live OTM session showed why
 *     it must not be: a desk-side add of 1 BAC contract at 19:36Z made the
 *     broker's `/positions` row a 2-lot blend, and the TRA-2889 basis
 *     restatement wrote that blended average ($1.41) onto the engine's 1-lot
 *     row whose real fill was $1.65 — while this detector read `clean` over the
 *     exact state that caused it. Excess is the precondition for a wrong
 *     basis and for an exit that sells only part of the broker's lot, so it is
 *     a finding, ranked below `drift` (nothing LEFT the account) and above
 *     `blind`.
 *   • `absorbed` — TRA-3896: at least one engine-origin row holding more
 *     contracts than this engine's own fills account for. Ranked ABOVE `excess`
 *     because it is the same collision one step further along: `excess` is the
 *     broker holding more than us (a precondition, and the row's own basis and
 *     stop are still its own), while `absorbed` means the row has already TAKEN
 *     the foreign contract in and is running a stop derived from a blend of
 *     somebody else's fill. Below `drift`, which is still the only state where
 *     contracts left the account.
 *   • `drift`   — at least one symbol where the broker is short.
 */
export type LiveBrokerDriftStatus =
  | 'dark'
  | 'blind'
  | 'vacuous'
  | 'clean'
  | 'excess'
  | 'absorbed'
  | 'drift';

export interface LiveBrokerPositionDriftReport {
  status: LiveBrokerDriftStatus;
  /** Set iff `status === 'blind'`. */
  blindReason: BrokerReadFailure | null;
  /** Set iff `status === 'dark'`. */
  darkReason: 'not_live' | 'no_client' | null;
  /**
   * TRA-4292 — WHICH broker env this check addressed. `production` is the
   * money account; `sandbox` is paper. `null` only when no env was ever
   * selected: a `not_live` dark (demo book), or a caller that predates the
   * stamp.
   *
   * This exists because the fleet fold's `liveBookStatus` needs to separate
   * "a money book is unwatched" from "a book that structurally cannot touch
   * money is unwatched". A live-mode book with `tradierEnv: sandbox` and no
   * saved creds reports `dark`/`no_client` on every check forever, and before
   * this stamp that dark was indistinguishable from the money book's own —
   * so one such book (Richard, 2026-09-02) held the headline at "dark" across
   * 615 clean checks of the real-money book. The env is known even on the
   * `no_client` path (it is resolved before the client lookup), so the report
   * carries it rather than making the fold guess.
   */
  tradierEnv: TradierEnv | null;
  checkedAt: number;
  /** Denominator: eligible engine live open rows. */
  engineRowsChecked: number;
  engineSymbolsChecked: number;
  engineContractsChecked: number;
  /** Open live rows excluded from the denominator, by reason. */
  ineligible: Record<DriftIneligibleReason, number>;
  /** Symbols/contracts the broker reported on this read. */
  brokerSymbols: number;
  brokerContracts: number;
  /** Broker symbols the engine holds no eligible row for (foreign inventory). */
  brokerOnlySymbols: number;
  /**
   * TRA-3909 — CONTRACTS on those symbols, not just how many symbols.
   *
   * `brokerOnlySymbols` counts names; this counts real money. Paired with
   * {@link excessContracts} it is the whole of "broker premium this book has no
   * row for", which is what `liveUnmanagedRisk.uncoveredBrokerContracts`
   * publishes — the number that read a correct-but-useless 0 over an unstopped
   * $117 BAC contract on 2026-08-20.
   */
  brokerOnlyContracts: number;
  shortfalls: BrokerShortfall[];
  /** ★ The alarm number: contracts that left the broker with no order of ours. */
  outOfBandContracts: number;
  outOfBandSymbols: number;
  /** Shortfall contracts covered by an engine submission record. */
  explainedContracts: number;
  /** Symbols suppressed only by the age floor. */
  tooYoungSymbols: number;
  excess: BrokerExcess[];
  excessContracts: number;
  /** TRA-3896 — engine-origin rows holding more than our own fills account for. */
  absorbed: EngineOriginAbsorption[];
  absorbedContracts: number;
  /**
   * TRA-3896 — engine-origin imported rows now IN the denominator. Reported
   * separately from `engineRowsChecked` so extending the coverage cannot be
   * mistaken for the engine having opened more rows than it did.
   */
  engineOriginImportedRowsChecked: number;
  /**
   * TRA-3896 — engine-origin rows the fill ledger could not answer for. NOT
   * absorptions: an empty ledger says exactly this about a contract we did buy.
   * Non-zero means the absorption check has a coverage hole, and a reader must
   * not take `absorbedContracts: 0` as an all-clear over these rows.
   */
  absorptionUnresolvedRows: number;
}

const EMPTY_INELIGIBLE: Record<DriftIneligibleReason, number> = {
  not_live: 0,
  imported: 0,
  multi_leg: 0,
  covered_write: 0,
  no_occ: 0,
  no_contracts: 0,
};

/**
 * The verdict for a check that never reached the broker at all.
 *
 * Separate from `blind` on purpose. `blind` means we asked and could not read
 * the answer — someone should look at the broker connection. `dark` means the
 * check is structurally not running (the engine is not in live mode, or has no
 * broker client), so there is no incident, only an absence of coverage. Rolling
 * them together would let a detector that has been switched off for a week read
 * exactly like one that is watching and finding nothing.
 */
export function darkBrokerPositionDriftReport(
  reason: 'not_live' | 'no_client',
  now: number,
  // TRA-4292 — the env a `no_client` dark WOULD have addressed. A demo book's
  // `not_live` dark never selected one, so it stays null there.
  tradierEnv: TradierEnv | null = null,
): LiveBrokerPositionDriftReport {
  return {
    status: 'dark',
    blindReason: null,
    darkReason: reason,
    tradierEnv,
    checkedAt: now,
    engineRowsChecked: 0,
    engineSymbolsChecked: 0,
    engineContractsChecked: 0,
    ineligible: { ...EMPTY_INELIGIBLE },
    brokerSymbols: 0,
    brokerContracts: 0,
    brokerOnlySymbols: 0,
    brokerOnlyContracts: 0,
    shortfalls: [],
    outOfBandContracts: 0,
    outOfBandSymbols: 0,
    explainedContracts: 0,
    tooYoungSymbols: 0,
    excess: [],
    excessContracts: 0,
    absorbed: [],
    absorbedContracts: 0,
    engineOriginImportedRowsChecked: 0,
    absorptionUnresolvedRows: 0,
  };
}

/**
 * Contracts the engine still believes it holds on a row.
 *
 * `contractsRemaining`, NOT `contracts`: after a partial close at TP1 the row
 * legitimately holds fewer contracts than it opened with, and the broker agrees
 * with the remainder. Comparing against `contracts` would manufacture a
 * shortfall on every post-TP1 row in the book — a false breach on real money,
 * every single tick.
 */
function remainingContracts(opt: OptionPosition): number {
  const remaining = opt.contractsRemaining;
  if (typeof remaining === 'number' && Number.isFinite(remaining)) return remaining;
  return typeof opt.contracts === 'number' && Number.isFinite(opt.contracts) ? opt.contracts : 0;
}

/**
 * The join key for "we did this". A submission record is an order the broker
 * actually received; an intent that never left the process is not one.
 *
 * Returns the number of contracts our in-flight orders would remove from the
 * broker's book for this row, or 0 when nothing of ours is in flight.
 */
function engineSubmittedContracts(opt: OptionPosition): number {
  let submitted = 0;
  const pendingExit = opt.pendingExit;
  if (pendingExit && pendingExit.tradierOrderId !== '' && pendingExit.tradierOrderId != null) {
    const qty = pendingExit.qty;
    if (typeof qty === 'number' && Number.isFinite(qty) && qty > 0) submitted += qty;
  }
  // A user-initiated close in flight (`pendingCloseOrderId`) has no qty of its
  // own on the row — it closes the remainder — so it accounts for whatever is
  // left. Same authority as the exit poller: it resolves against the broker's
  // ORDER status.
  if (opt.pendingCloseOrderId !== undefined && opt.pendingCloseOrderId !== '') {
    submitted += remainingContracts(opt);
  }
  return submitted;
}

/** True iff the row staged an exit that never reached the broker (TRA-2819). */
function hasStagedNeverSubmitted(opt: OptionPosition): boolean {
  const pendingExit = opt.pendingExit;
  return !!pendingExit && (pendingExit.tradierOrderId === '' || pendingExit.tradierOrderId == null);
}

/**
 * TRA-3067 — compare broker truth to the engine's open live rows.
 *
 * Pure: no I/O, no clock of its own (`now` is injected), no mutation of the
 * rows it is handed. The caller owns the read, the log line and the alarm.
 *
 * @param read  the broker's positions, WITH its failure state intact
 * @param rows  every open option row the engine holds (all modes; filtered here
 *              so the exclusions can be counted rather than hidden by the
 *              caller)
 * @param now   epoch ms, for the age floor
 */
/**
 * TRA-3896 — "how many contracts does this engine's OWN fill ledger account for
 * on this symbol", or `null` when the ledger cannot answer.
 *
 * Injected rather than imported so this module stays pure and testable. The
 * default is a function that answers `null` for everything, which makes the
 * absorption check report `absorptionUnresolvedRows` instead of silently
 * grading rows against an oracle nobody wired — the same refusal-to-guess the
 * rest of the module makes.
 */
export type RecordedEngineContractsOracle = (optionSymbol: string) => number | null;

const NO_RECORDED_CONTRACTS_ORACLE: RecordedEngineContractsOracle = () => null;

/**
 * TRA-3896 — a row the engine is MANAGING, whichever path it arrived by.
 *
 * An `engine_origin` import is a contract this engine placed, lost the row for,
 * and re-adopted (TRA-3553/TRA-3829 stamp the verdict at adoption). It carries
 * an engine stop and an engine schedule, so the broker-vs-engine comparison
 * applies to it exactly as it does to a row that never left. `foreign` and
 * `unresolved` imports stay out: those are the desk's inventory, and their
 * absence from a payload is not evidence about any order of ours.
 */
/**
 * TRA-3909 — `desk_add` joins the managed set, and it MUST.
 *
 * A desk lot adopted per-lot carries an engine stop and is exited by the engine
 * exit pass, so it is engine-managed by the same reading `engine_origin` is. It
 * is also the only reason the split symbol reconciles at all: with the desk lot
 * excluded, the engine side of XLF would count 1 against the broker's 2 and this
 * detector would report a permanent `excess` over a contract that now has a row
 * and a stop — turning the fix into a standing false alarm.
 */
/**
 * TRA-3946 — a lot the ENGINE added under the average-down rule is engine
 * inventory by construction, whatever a later re-adoption stamps on it. It is
 * a second row on the same OCC, and this grader sums engine contracts per OCC,
 * so the add is EXPECTED quantity — not a desk `excess`, which is the TRA-3895
 * failure mode re-created by our own code (TRA-3907 §4c). Phase 1 writes no
 * such row; the reading ships ahead of the row so phase 2 cannot forget it.
 */
export function isEngineManagedRow(opt: OptionPosition): boolean {
  if (opt.addOrigin === 'engine_average_down') return true;
  if (!opt.importedFromTradier) return true;
  return opt.adoptionAuthority === 'engine_origin' || opt.adoptionAuthority === 'desk_add';
}

export function diffLiveBrokerPositions(
  read: BrokerPositionsRead,
  rows: readonly OptionPosition[],
  now: number,
  recordedEngineContracts: RecordedEngineContractsOracle = NO_RECORDED_CONTRACTS_ORACLE,
  // TRA-4292 — the env the caller's read addressed; see the report field.
  tradierEnv: TradierEnv | null = null,
): LiveBrokerPositionDriftReport {
  const base: LiveBrokerPositionDriftReport = {
    status: 'clean',
    blindReason: null,
    darkReason: null,
    tradierEnv,
    checkedAt: now,
    engineRowsChecked: 0,
    engineSymbolsChecked: 0,
    engineContractsChecked: 0,
    ineligible: { ...EMPTY_INELIGIBLE },
    brokerSymbols: 0,
    brokerContracts: 0,
    brokerOnlySymbols: 0,
    brokerOnlyContracts: 0,
    shortfalls: [],
    outOfBandContracts: 0,
    outOfBandSymbols: 0,
    explainedContracts: 0,
    tooYoungSymbols: 0,
    excess: [],
    excessContracts: 0,
    absorbed: [],
    absorbedContracts: 0,
    engineOriginImportedRowsChecked: 0,
    absorptionUnresolvedRows: 0,
  };

  if (!read.ok) {
    // An unreadable broker is never evidence about the book. Return BEFORE
    // touching the rows so no partial count can be mistaken for a comparison
    // that happened.
    return { ...base, status: 'blind', blindReason: read.reason };
  }

  // ── Broker side ──────────────────────────────────────────────────────────
  const brokerBySymbol = new Map<string, number>();
  for (const p of read.positions) {
    if (!p || typeof p.optionSymbol !== 'string' || p.optionSymbol === '') continue;
    const qty = typeof p.contracts === 'number' && Number.isFinite(p.contracts) ? p.contracts : 0;
    brokerBySymbol.set(p.optionSymbol, (brokerBySymbol.get(p.optionSymbol) ?? 0) + qty);
  }
  base.brokerSymbols = brokerBySymbol.size;
  base.brokerContracts = [...brokerBySymbol.values()].reduce((a, b) => a + b, 0);

  // ── Engine side ──────────────────────────────────────────────────────────
  interface SymbolAgg {
    engineContracts: number;
    submittedContracts: number;
    stagedNeverSubmitted: boolean;
    oldestOpenedAt: number;
    rowIds: string[];
    /** TRA-3896 — contracts on this symbol carried by engine-ORIGIN imports. */
    engineOriginImportedContracts: number;
    engineOriginImportedRowIds: string[];
  }
  const engineBySymbol = new Map<string, SymbolAgg>();

  for (const opt of rows) {
    if ((opt.mode ?? 'demo') !== 'live') {
      base.ineligible.not_live += 1;
      continue;
    }
    // TRA-3896 — an engine-ORIGIN import is an engine-managed row and belongs in
    // the denominator; only genuinely foreign/unresolved imports are excluded.
    if (!isEngineManagedRow(opt)) {
      base.ineligible.imported += 1;
      continue;
    }
    if (opt.legs && opt.legs.length > 0) {
      base.ineligible.multi_leg += 1;
      continue;
    }
    if (opt.coveredWrite) {
      base.ineligible.covered_write += 1;
      continue;
    }
    const occ = opt.optionSymbol;
    if (typeof occ !== 'string' || occ === '') {
      base.ineligible.no_occ += 1;
      continue;
    }
    const contracts = remainingContracts(opt);
    if (!(contracts > 0)) {
      base.ineligible.no_contracts += 1;
      continue;
    }

    const agg = engineBySymbol.get(occ) ?? {
      engineContracts: 0,
      submittedContracts: 0,
      stagedNeverSubmitted: false,
      oldestOpenedAt: Number.POSITIVE_INFINITY,
      rowIds: [],
      engineOriginImportedContracts: 0,
      engineOriginImportedRowIds: [],
    };
    agg.engineContracts += contracts;
    agg.submittedContracts += engineSubmittedContracts(opt);
    agg.stagedNeverSubmitted = agg.stagedNeverSubmitted || hasStagedNeverSubmitted(opt);
    const openedAt = typeof opt.openedAt === 'number' && Number.isFinite(opt.openedAt) ? opt.openedAt : now;
    agg.oldestOpenedAt = Math.min(agg.oldestOpenedAt, openedAt);
    agg.rowIds.push(opt.id);
    // TRA-3909 — narrowed from `importedFromTradier` to the ENGINE-ORIGIN
    // authority specifically. `importedFromTradier` was an adequate proxy while
    // `engine_origin` was the only import the filter above admitted; it is not
    // one now. A `desk_add` lot is by construction NOT accounted for by this
    // engine's fill ledger — that is what makes it a desk lot — so counting it
    // here would report an absorption on every pass over a correctly split
    // symbol, which is the reverse of what this arm exists to catch.
    if (opt.importedFromTradier && opt.adoptionAuthority === 'engine_origin') {
      agg.engineOriginImportedContracts += contracts;
      agg.engineOriginImportedRowIds.push(opt.id);
      base.engineOriginImportedRowsChecked += 1;
    }
    engineBySymbol.set(occ, agg);
    base.engineRowsChecked += 1;
    base.engineContractsChecked += contracts;
  }
  base.engineSymbolsChecked = engineBySymbol.size;

  // ── TRA-3896: the absorption check ────────────────────────────────────────
  // Runs against the fill LEDGER, not against the broker, and that is the whole
  // point: once the reconcile has copied a foreign contract onto an engine-origin
  // row, the row and the broker AGREE and every broker-vs-engine comparison below
  // reads clean over it. Only a third source that neither of them wrote can see
  // it. Scoped to engine-origin IMPORTS because an engine-opened row was never
  // exposed to the unconditional copy — its branch has refused a mismatched lot
  // since TRA-3890 — and widening the scope would start grading rows whose basis
  // the ledger legitimately does not cover.
  for (const [symbol, agg] of engineBySymbol) {
    if (agg.engineOriginImportedContracts <= 0) continue;
    const recorded = recordedEngineContracts(symbol);
    if (recorded === null || !Number.isFinite(recorded)) {
      // UNRESOLVED. Reported, never counted as an absorption: an empty or
      // unhydrated ledger says exactly this about a contract we really did buy,
      // and calling that an absorption would alarm on every row after a restart
      // that lost the ledger.
      base.absorptionUnresolvedRows += agg.engineOriginImportedRowIds.length;
      base.absorbed.push({
        optionSymbol: symbol,
        rowContracts: agg.engineOriginImportedContracts,
        recordedContracts: null,
        absorbedContracts: 0,
        rowIds: [...agg.engineOriginImportedRowIds],
      });
      continue;
    }
    if (agg.engineOriginImportedContracts <= recorded) continue;
    const absorbedContracts = agg.engineOriginImportedContracts - recorded;
    base.absorbed.push({
      optionSymbol: symbol,
      rowContracts: agg.engineOriginImportedContracts,
      recordedContracts: recorded,
      absorbedContracts,
      rowIds: [...agg.engineOriginImportedRowIds],
    });
    base.absorbedContracts += absorbedContracts;
  }

  let brokerOnly = 0;
  let brokerOnlyContracts = 0;
  for (const [symbol, qty] of brokerBySymbol) {
    if (!engineBySymbol.has(symbol)) {
      brokerOnly += 1;
      // TRA-3909 — the contracts too, not just the name. See the field's doc.
      brokerOnlyContracts += Number.isFinite(qty) && qty > 0 ? qty : 0;
    }
  }
  base.brokerOnlySymbols = brokerOnly;
  base.brokerOnlyContracts = brokerOnlyContracts;

  if (base.engineRowsChecked === 0) {
    // Nothing to compare. Deliberately NOT `clean`: a green with an empty
    // denominator is the vacuous pass this whole module exists to refuse.
    return { ...base, status: 'vacuous' };
  }

  // ── The comparison ───────────────────────────────────────────────────────
  for (const [symbol, agg] of engineBySymbol) {
    const brokerContracts = brokerBySymbol.get(symbol) ?? 0;
    if (brokerContracts > agg.engineContracts) {
      const excessContracts = brokerContracts - agg.engineContracts;
      base.excess.push({
        optionSymbol: symbol,
        engineContracts: agg.engineContracts,
        brokerContracts,
        excessContracts,
      });
      base.excessContracts += excessContracts;
      continue;
    }
    const shortfallContracts = agg.engineContracts - brokerContracts;
    if (shortfallContracts <= 0) continue;

    // Age floor first: a row this young may still have a working OPEN order, so
    // the broker not reporting it is not evidence of anything. Counted, never
    // silently dropped.
    if (now - agg.oldestOpenedAt < DRIFT_MIN_ROW_AGE_MS) {
      base.tooYoungSymbols += 1;
      base.shortfalls.push({
        optionSymbol: symbol,
        engineContracts: agg.engineContracts,
        brokerContracts,
        shortfallContracts,
        explainedContracts: 0,
        outOfBandContracts: 0,
        reason: 'too_young',
        rowIds: [...agg.rowIds],
      });
      continue;
    }

    const explainedContracts = Math.min(shortfallContracts, agg.submittedContracts);
    const outOfBandContracts = shortfallContracts - explainedContracts;

    let reason: DriftShortfallReason;
    if (outOfBandContracts === 0) {
      reason = 'engine_close_in_flight';
    } else if (explainedContracts > 0) {
      reason = 'partially_explained';
    } else if (agg.stagedNeverSubmitted) {
      // An intent that never reached the broker is not an explanation, but it
      // IS a different remedy from a pure out-of-band close: TRA-2819's reaper
      // owns the strand, and the responder needs to know both happened.
      reason = 'staged_never_submitted';
    } else {
      reason = 'out_of_band';
    }

    base.shortfalls.push({
      optionSymbol: symbol,
      engineContracts: agg.engineContracts,
      brokerContracts,
      shortfallContracts,
      explainedContracts,
      outOfBandContracts,
      reason,
      rowIds: [...agg.rowIds],
    });
    base.explainedContracts += explainedContracts;
    base.outOfBandContracts += outOfBandContracts;
    if (outOfBandContracts > 0) base.outOfBandSymbols += 1;
  }

  const drifted = base.shortfalls.some(s => s.reason !== 'too_young');
  // A shortfall outranks an absorption outranks an excess on the same read.
  // Contracts that LEFT are the loudest; a foreign contract already ON an engine
  // row (running our stop, blended into our basis) is louder than one merely
  // sitting beside it at the broker. All three arrays are carried either way, so
  // a lower-ranked finding is never lost to the headline.
  return {
    ...base,
    status: drifted
      ? 'drift'
      : base.absorbedContracts > 0
        ? 'absorbed'
        : base.excessContracts > 0
          ? 'excess'
          : 'clean',
  };
}

/**
 * Counts-only projection for the no-auth `/api/health/options-live` route.
 *
 * TRA-2163 is the standing reason not to widen what that surface discloses
 * about the real-money book, so OCC symbols and row ids stay in the process log
 * and the authenticated `/api/state`. The numbers that survive are the ones a
 * responder needs to decide whether to look: the status, the denominator, and
 * the out-of-band contract count.
 */
/**
 * Precedence used to fold several books' statuses into the one the no-auth
 * route publishes. Most actionable first, and every non-verdict outranks
 * `clean`: one book reporting `clean` must never hide another that is `blind`
 * or `dark`, which is how an aggregate turns a coverage hole into a green.
 */
const DRIFT_STATUS_RANK: Record<LiveBrokerDriftStatus | 'never_ran', number> = {
  drift: 8,
  // TRA-3896 — above `excess` and below `drift`; see `LiveBrokerDriftStatus`.
  absorbed: 7,
  excess: 6,
  blind: 5,
  dark: 4,
  never_ran: 3,
  vacuous: 2,
  clean: 1,
};

/** Fold two statuses, keeping the one that most demands a look. */
export function worseBrokerDriftStatus<T extends LiveBrokerDriftStatus | 'never_ran'>(a: T, b: T): T {
  return DRIFT_STATUS_RANK[b] > DRIFT_STATUS_RANK[a] ? b : a;
}

export type LiveBrokerDriftFoldStatus = LiveBrokerDriftStatus | 'never_ran';

/**
 * TRA-3890 — the fleet fold, with the live book's own verdict kept separate.
 *
 * `worseBrokerDriftStatus` is correct for what it was built for: one `clean`
 * book must never hide another that is `blind`. But the no-auth route folds
 * EVERY user context through it, and a demo-mode context reports `dark`
 * (`not_live`) on every check, forever. So on 2026-08-20 the route read
 * `status: "dark", driftChecks 0` across the first live OTM session while the
 * admin engine's live check had run ~330 times and was, at that moment,
 * computing `excess: [BAC engine 1 / broker 2]` — and calling it `clean`.
 * "Dark" and "watching, found something" were the same payload.
 *
 * Two things fix that without weakening the fold:
 *   • `liveBookStatus` — the same fold over only the contexts whose check is
 *     structurally able to watch the MONEY book. A `no_client` dark on a
 *     production-env book still counts: a money book with no broker client IS
 *     a coverage hole on the money book.
 *   • `contextsByLastStatus` — how many contexts sit in each state, so a reader
 *     can see "1 live context clean, 9 demo contexts dark" instead of one word.
 *
 * TRA-4292 narrows the `liveBookStatus` cohort by ENV. The original rule was
 * "everything except `dark`/`not_live`", and that admitted a live-MODE book
 * whose creds resolve to the SANDBOX env with no client at all (Richard,
 * 2026-09-02: `tradierEnv: sandbox`, `clientPresent: false`). Such a book
 * reports `dark`/`no_client` on every check forever, it structurally cannot
 * touch the money account, and — `dark` outranking `clean` — it pinned the
 * headline at "dark" across 615 real clean checks of the money book. Anyone
 * grading coverage off the field (including TRA-4278's starting facts)
 * concluded the detector never read: the instrument read identically in pass
 * and fail. So a context whose report is stamped with a NON-production env now
 * lands in `sandboxLiveContexts` instead of the money fold. An UNSTAMPED
 * (`tradierEnv: null`) non-demo report still folds in — when the env is
 * unknown, excluding it could hide a real money book, which is the expensive
 * direction.
 *
 * `liveContexts === 0` means there is no money-capable book at all;
 * `liveBookStatus` is then `never_ran`, which the rank treats as a coverage
 * gap, not a green.
 */
export function foldLiveBrokerDriftStatuses(
  lasts: readonly (Pick<LiveBrokerPositionDriftReport, 'status' | 'darkReason' | 'tradierEnv'> | null)[],
): {
  status: LiveBrokerDriftFoldStatus;
  liveBookStatus: LiveBrokerDriftFoldStatus;
  liveContexts: number;
  notLiveContexts: number;
  /** TRA-4292 — live-mode contexts addressed at a non-money env. */
  sandboxLiveContexts: number;
  contextsByLastStatus: Record<LiveBrokerDriftFoldStatus, number>;
} {
  const contextsByLastStatus: Record<LiveBrokerDriftFoldStatus, number> = {
    never_ran: 0,
    dark: 0,
    blind: 0,
    vacuous: 0,
    clean: 0,
    excess: 0,
    absorbed: 0,
    drift: 0,
  };
  // Seeded with null, not 'never_ran': the rank treats never_ran as a gap that
  // outranks clean, so a seed of never_ran could never be lowered by a context
  // that actually ran clean.
  let status: LiveBrokerDriftFoldStatus | null = null;
  let liveBookStatus: LiveBrokerDriftFoldStatus | null = null;
  let liveContexts = 0;
  let notLiveContexts = 0;
  let sandboxLiveContexts = 0;
  for (const last of lasts) {
    const s: LiveBrokerDriftFoldStatus = last ? last.status : 'never_ran';
    contextsByLastStatus[s] += 1;
    status = status === null ? s : worseBrokerDriftStatus(status, s);
    if (last && last.status === 'dark' && last.darkReason === 'not_live') {
      notLiveContexts += 1;
      continue;
    }
    // TRA-4292 — a book whose check addressed a non-money env cannot be a
    // money-book coverage hole; counted apart so it stays visible without
    // pinning the money verdict. `null` env (unstamped) deliberately falls
    // through into the money fold — see the function doc.
    if (last && last.tradierEnv !== null && last.tradierEnv !== 'production') {
      sandboxLiveContexts += 1;
      continue;
    }
    liveContexts += 1;
    liveBookStatus = liveBookStatus === null ? s : worseBrokerDriftStatus(liveBookStatus, s);
  }
  return {
    status: status ?? 'never_ran',
    liveBookStatus: liveBookStatus ?? 'never_ran',
    liveContexts,
    notLiveContexts,
    sandboxLiveContexts,
    contextsByLastStatus,
  };
}

export function summarizeLiveBrokerPositionDrift(
  report: LiveBrokerPositionDriftReport | null,
): {
  status: LiveBrokerDriftStatus | 'never_ran';
  blindReason: BrokerReadFailure | null;
  darkReason: 'not_live' | 'no_client' | null;
  checkedAt: number | null;
  engineRowsChecked: number;
  engineContractsChecked: number;
  outOfBandContracts: number;
  outOfBandSymbols: number;
  explainedContracts: number;
  tooYoungSymbols: number;
  excessContracts: number;
  brokerOnlySymbols: number;
  /** TRA-3909 — contracts on broker-only symbols; see the report field. */
  brokerOnlyContracts: number;
  /** TRA-3896 — engine-origin rows holding more than our own fills account for. */
  absorbedContracts: number;
  engineOriginImportedRowsChecked: number;
  absorptionUnresolvedRows: number;
} {
  if (!report) {
    // `never_ran` is its own state on purpose. A boot that has not reached the
    // first check yet must not publish the same payload as a check that ran and
    // found nothing.
    return {
      status: 'never_ran',
      blindReason: null,
      darkReason: null,
      checkedAt: null,
      engineRowsChecked: 0,
      engineContractsChecked: 0,
      outOfBandContracts: 0,
      outOfBandSymbols: 0,
      explainedContracts: 0,
      tooYoungSymbols: 0,
      excessContracts: 0,
      brokerOnlySymbols: 0,
      brokerOnlyContracts: 0,
      absorbedContracts: 0,
      engineOriginImportedRowsChecked: 0,
      absorptionUnresolvedRows: 0,
    };
  }
  return {
    status: report.status,
    blindReason: report.blindReason,
    darkReason: report.darkReason,
    checkedAt: report.checkedAt,
    engineRowsChecked: report.engineRowsChecked,
    engineContractsChecked: report.engineContractsChecked,
    outOfBandContracts: report.outOfBandContracts,
    outOfBandSymbols: report.outOfBandSymbols,
    explainedContracts: report.explainedContracts,
    tooYoungSymbols: report.tooYoungSymbols,
    excessContracts: report.excessContracts,
    brokerOnlySymbols: report.brokerOnlySymbols,
    brokerOnlyContracts: report.brokerOnlyContracts,
    absorbedContracts: report.absorbedContracts,
    engineOriginImportedRowsChecked: report.engineOriginImportedRowsChecked,
    absorptionUnresolvedRows: report.absorptionUnresolvedRows,
  };
}
