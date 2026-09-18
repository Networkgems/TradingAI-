// TRA-1023 (TRA-1022 audit) — options EXECUTION feature flag.
//
// This is a SEPARATE flag from `ENABLE_OPTION_SHADOW_SELECTOR` (the research
// ledger in `option-shadow-ledger.ts`). The shadow flag governs the observe-only
// Phase-A ledger; THIS flag governs whether the disciplined selection-quality /
// breaker logic is allowed to influence the EXECUTING options path:
//
//   • enforce the options-sleeve risk breaker on the option-open gate
//     (work-item 5 — recording is always on; enforcement is gated here), and
//   • (follow-ups TRA-1024 / TRA-1025) gate the executing RV long path on
//     IVR ≤ 25 + a TRA-734 technical trigger, route mid/high-IVR cheap legs to a
//     defined-risk spread, and swap the flat stop/target for structure-aware exits.
//
// OFF by default. Per the TRA-1023 acceptance criteria nothing here may change
// executing behaviour until QuantTrader signs off on the shadow-vs-live
// comparison, and live promotion stays gated on TRA-382 regardless of this flag.
// Conflating it with the shadow flag would either turn execution on whenever the
// research ledger is accruing or silence the ledger whenever execution is gated —
// both wrong, hence the distinct env var.

import type { OptionAdmissionBoundBy, OptionAdmissionStamp } from '@trading-app/shared';

export const OPTION_EXEC_FLAG = 'ENABLE_OPTION_EXEC_SELECTOR';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** True iff the options execution-quality flag is enabled (accepts 1/true/yes/on). */
export function isOptionExecEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTION_EXEC_FLAG]);
}

// --------------------------------------------------------------------------
// TRA-3829 — may the engine ACT on broker inventory it did not open?
//
// The reconcile ADOPTS any option in the broker payload that has no local row
// (`options-account.ts:6976`). On a hand-traded account that is not an edge
// case: production Tradier `***0154` is the account owner's personal account
// AND the go-live account, with 118 hand-traded closed lots since 2026-05-08.
// On 2026-08-17 they placed six tickets in Tradier's own web UI; the engine
// adopted them and, with the shipped defaults, would have run its exit logic
// against them and sold them at the next open. No arm, no deploy, no code
// change and no human decision was required for that.
//
// ── Why a NEW flag and not `autoManageImportedTradierOptions` ─────────────
// That setting exists and would have prevented this, but it cannot be the
// guard, for three reasons:
//   1. It DEFAULTS ON, in three places, and `resolveAutoManageImportedTradier
//      Options` reads `!== false` — so a snapshot that predates the setting
//      auto-manages. A safety property must not depend on a field being
//      present.
//   2. It is a per-BOOK user preference on the Settings page. Whether the
//      engine may liquidate a human's discretionary position is not a user
//      preference; it is a deployment posture, which is what an env flag is.
//   3. It is undifferentiated. Turning it off ALSO stops managing rows the
//      ENGINE opened and then lost the local row for — which is TRA-2820, 8
//      live contracts left with no stop for a session. The guard has to keep
//      those managed, so it cannot key on the same bit.
//
// So this flag composes with, rather than replaces, TRA-361's setting: the
// engine acts on an adopted row only when BOTH allow it, and this one is
// keyed on PROVENANCE (`OptionPosition.adoptionAuthority`) rather than on the
// `importedFromTradier` bookkeeping bit.
//
// ⚠️ DEFAULT-SAFE AND DEFAULT-OFF, deliberately: `flagOn` returns false for
// absent, empty, misspelled and every non-truthy value, so the failure mode of
// this flag is "the engine does not touch the human's money". The expensive
// direction here is acting, not refusing — refusing leaves a position exactly
// where its owner put it, whereas acting realises a loss on a trade nobody
// assigned to the engine.
//
// ⚠️ This gates ACTING (exits) only. It does not stop adoption, and must not
// be read as doing so: an adopted row is still reconciled, still visible, and
// still costs the reader nothing to see. Whether adopted rows should leave the
// live book altogether is the AC2 board question (option C), not this flag.
export const ENGINE_ACT_ON_ADOPTED_FLAG = 'ENABLE_ENGINE_ACT_ON_ADOPTED_BROKER_OPTIONS';

/**
 * TRA-3829 — true iff the engine is EXPLICITLY armed to run its exit logic
 * against option rows it adopted from the broker but cannot prove it opened.
 *
 * Default **false**. See {@link ENGINE_ACT_ON_ADOPTED_FLAG} for why the default
 * direction is the non-acting one, and why this is not
 * `autoManageImportedTradierOptions`.
 */
export function isEngineActionOnAdoptedRowsArmed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return flagOn(env[ENGINE_ACT_ON_ADOPTED_FLAG]);
}

/**
 * TRA-3829 — the single decision point: may the engine act on THIS row?
 *
 * Deliberately total over the input space, and deliberately written as an
 * allow-list rather than a deny-list. A deny-list (`authority === 'foreign'`)
 * would admit `undefined` — which is what an adopted row persisted by an older
 * build carries — and those are exactly the rows this exists to refuse. The
 * allow-list makes "a shape I do not recognise" refuse by construction.
 *
 * - Not an adopted row at all (`imported` false) ⇒ **true**. Engine-opened
 *   positions are untouched by this ticket; the guard must never widen onto
 *   them.
 * - `tradierEnv === 'sandbox'` ⇒ **true**. See the partition note below.
 * - `engine_origin` ⇒ **true**. The oracle PROVED we placed it. TRA-2820's fix
 *   stands: a live row whose local record was lost keeps its stops.
 * - `desk_add` ⇒ **true**. TRA-3909, and the one deliberate widening of this
 *   guard since it shipped — EXEMPTED FROM RULING B BY THE BOARD, see below.
 * - `foreign` / `unresolved` / absent / anything else ⇒ **`armed && granted`**,
 *   i.e. false unless the deployment has opted in AND a human handed this row
 *   over.
 *
 * ── TRA-3909 `desk_add`: a widening, retracted, then EXEMPTED by the board ──
 * Board instruction, TRA-3904 `92bc1e83`, 2026-08-20T23:21:32Z: *"Bot should
 * manage added positions from Tradier"*. TRA-3909 read that as requiring a
 * fourth allow-list entry — `desk_add ⇒ true`, unconditional. The CTO reviewed
 * and accepted that line on TRA-3916.
 *
 * ⚠️ That review PRE-DATES board ruling B (card `331ddc56`, 2026-08-21, shipped
 * `a5ab388`), which answers the same question more narrowly for adopted rows in
 * general: *fully managed, but only after an explicit PER-ROW opt-in*. The line
 * was therefore RETRACTED in `17727ec` rather than shipped on a stale review,
 * and the question was put to the board as a ruling-B amendment.
 *
 * ✅ THE BOARD RULED `desk_add` EXEMPT — TRA-3909 interaction
 * `d4f622fb-9db2-467e-981f-6f54f29b6a10`, question `desk_add_exempt`, answered
 * `exempt` at 2026-08-22T04:23:58Z: *"the desk added to a trade the engine
 * already ran. Restore the line, then merge."* This docblock is the record of
 * that grant; the line below is the grant itself.
 *
 * ⚠️ The exemption is a POPULATION, not a policy change, and the population is
 * strictly smaller than the one TRA-3829 and ruling B were written about. Their
 * case is a STANDALONE desk position — the six tickets typed into Tradier's web
 * UI on 2026-08-17, with no engine contract anywhere near them. `desk_add` is
 * minted ONLY for a residual lot on an OCC symbol where this engine already
 * owns a row (`planLotAdoption` refuses `no_engine_row` otherwise), i.e. the
 * desk adding to a trade the engine is already running. Those two sets are
 * disjoint, so nothing ruling B refuses today starts being actioned, and the
 * default direction of the flag is UNCHANGED and still the non-acting one.
 *
 * ⚠️ Do NOT re-derive the necessity of this line from the old argument, which
 * was FALSE: a `desk_add` lot does not need this entry to carry an armed stop
 * LEVEL. `updateConfig` and the reconcile both `continue` past
 * `applyImportedRiskThresholds` for a `desk_add` row and re-derive
 * `applyEngineOriginRiskThresholds(opt, opt.deskAddSleeve, …)` against the
 * lot's OWN basis. What this entry decides is solely who may pull the trigger:
 * with it, the engine; without it, nobody until a human grants hand-over. If
 * the board ever revokes the exemption, deleting the line restores ruling B's
 * two-key posture and `liveLotAdoptionReport` publishes `engineMayAct: false`
 * with `exitInertReason: 'adopted_not_authorized'` per lot, as it did under the
 * retraction.
 *
 * ── Why the partition is `tradierEnv` and NOT `mode` ──────────────────────
 * ⛔ TRA-3112 item 3: on an imported row `mode` is stamped `'live'`
 * UNCONDITIONALLY by the sync route, so a DEMO book importing its own SANDBOX
 * account produces rows whose `mode` says `'live'`. Keying this guard on `mode`
 * would therefore be wrong in both directions at once — it would catch every
 * sandbox import (regressing the TRA-323/TRA-361 path, whose whole stated use
 * case is *"opened directly on the broker, e.g. on the broker's Sandbox web
 * UI"*) while telling us nothing about whether real money is involved.
 * `tradierEnv` is minted from the owning bucket and is the documented-correct
 * partition for exactly this question.
 *
 * ABSENT `tradierEnv` is guarded, not exempted. The mint at
 * `options-account.ts:7002` only stamps the field when the account carries one,
 * so absent means "unknown env", and unknown env on real money is the case this
 * ticket exists to refuse. Sandbox has to say so to be let through — which
 * costs a legacy sandbox row nothing but a stop it never needed, and is the
 * cheap direction of the two.
 *
 * ── Board ruling B (card `331ddc56`, 2026-08-21): PER-ROW hand-over ───────
 * The board chose (b) — *fully managed, but only after an explicit per-row
 * opt-in* — over (a) visible-never-actioned and (c) excluded. So `armed`
 * alone is NOT sufficient for a `foreign` / `unresolved` row any more: that
 * would be option (a) with a deployment-wide switch, which is not what was
 * ruled. Two keys are now required, and both are explicit:
 *
 *   1. `armed` — the deployment-wide `ENABLE_ENGINE_ACT_ON_ADOPTED_BROKER_OPTIONS`
 *      master arm (default off). This is what keeps the whole mechanism dark
 *      under the go-live code freeze: with it unset, a grant written onto a row
 *      is recorded but inert.
 *   2. `row.engineHandover` — a legible per-row grant written by a human
 *      through `POST /api/options/:id/engine-handover`. See
 *      `OptionPosition.engineHandover` for why malformed counts as absent.
 *
 * Either key missing ⇒ refuse. The window ruling B accepts — between the
 * broker fill and the human's hand-over — is spent with the row visible,
 * marked, counted as the HUMAN'S exposure (`adoptedUsd`), and carrying the
 * unmanaged sentinel, exactly as under (a).
 */
export function engineMayActOnAdoptedRow(
  row: {
    importedFromTradier?: boolean;
    adoptionAuthority?: string;
    tradierEnv?: string;
    engineHandover?: { grantedAt?: unknown; grantedBy?: unknown } | null;
  },
  armed: boolean,
): boolean {
  if (row.importedFromTradier !== true) return true;
  if (row.tradierEnv === 'sandbox') return true;
  if (row.adoptionAuthority === 'engine_origin') return true;
  // TRA-3909 — a desk lot added to a contract the engine already holds. Exempt
  // from ruling B by the board (interaction `d4f622fb`, `exempt`, 2026-08-22).
  // Still an allow-list entry, so an unrecognised shape keeps refusing by
  // construction, and a STANDALONE desk position never reaches it — it takes
  // `planLotAdoption`'s `no_engine_row` refusal and stays `foreign`.
  if (row.adoptionAuthority === 'desk_add') return true;
  return armed && hasEngineHandover(row);
}

/**
 * TRA-3829 (ruling B) — is there a LEGIBLE hand-over on this row?
 *
 * Strict on purpose: a grant is a statement about who decided what and when,
 * so both halves must parse. `{ grantedBy: '' }`, `{ grantedAt: 'soon' }` and
 * `true` all read as "nobody handed it over". The only way to be admitted is
 * to have been written by the one surface that writes well-formed grants.
 */
export function hasEngineHandover(
  row: { engineHandover?: { grantedAt?: unknown; grantedBy?: unknown } | null },
): boolean {
  const g = row.engineHandover;
  if (!g || typeof g !== 'object') return false;
  if (typeof g.grantedBy !== 'string' || g.grantedBy.trim() === '') return false;
  if (typeof g.grantedAt !== 'string' || !Number.isFinite(Date.parse(g.grantedAt))) return false;
  return true;
}

// --------------------------------------------------------------------------
// TRA-3913 — WHOSE EXPOSURE IS THIS ROW? A different question from
// `engineMayActOnAdoptedRow`, which the two shared one answer for until now.
//
// TRA-3829 attributed a row away from the engine iff `engineMayActOnAdoptedRow`
// refused it, on the stated ground that "the attribution follows the
// authorisation rather than being a second, independently-drifting opinion".
// That is wrong in the one branch the authorisation predicate says YES to for a
// reason that has nothing to do with who paid: `engine_origin`.
//
// Measured on bqb1 `020100dc56aa`, 2026-08-21T00:19:40Z, real money:
//
//   XLF260925C00057500  contracts 2  premiumPaid 0.965  -> row folds $193.00
//     engine ledger: ONE buy_to_open, 1 @1.08, oid 142603071  = $108.00
//     (1.08 + 0.85) / 2 = 0.965 EXACTLY  =>  contract #2 is the DESK's, $85.00
//
// The pre-TRA-3896 reconcile took the BROKER's lot of 2 and its BLENDED premium
// onto the engine's own row, so an `engine_origin` row now carries a contract
// nobody routed through the engine. `engineMayActOnAdoptedRow` returns true on
// it — correctly, we must be able to EXIT it — and the fold read that `true` as
// "this is the engine's money". `adoptedUsd` therefore read $0.00 on a row
// holding $85.00 of somebody else's premium.
//
// ⚠ THE PRICE THIS ACQUIRED. Before TRA-3911 nothing consumed the split, so it
// was a labelling defect. As of `404e8e5bd919` the order path gates on
// `admissible_i = max(0, min(cap_i − atRisk_i, A − Σ_j atRisk_j))`, and
// `Σ_j atRisk_j` is this fold. The desk's $85.00 now crowds out engine entries
// dollar-for-dollar out of the board's $500 authorization (v0nni $193.67 →
// $142.00 on that fleet). It errs SAFE — the fleet under-admits, never over —
// but it spends an authorization the desk was never granted.
//
// ⛔ WHAT THIS DOES **NOT** DO. It does not change `usd`, so no cap gets looser:
// the adopted share is CARVED OUT of the row's total, never subtracted from it.
// It does not restate the row (TRA-3896's guard is default-safe and correct
// going forward; this is attribution, not a basis rewrite). And it does not
// widen `engineMayActOnAdoptedRow` — the engine may still exit every row it
// could exit before, which is the whole reason that predicate had to stay.
//
// ⛔ `armed` IS DELIBERATELY NOT CONSULTED HERE. `ENABLE_ENGINE_ACT_ON_ADOPTED_
// BROKER_OPTIONS` answers "may the engine exit the desk's position", which has
// no bearing on who bought it. Arming an exit path must not silently reclassify
// the desk's premium as engine spend — that is the same conflation one level up.
// --------------------------------------------------------------------------

/**
 * TRA-3913 — the attribution oracle's answer, narrowed to the two fields this
 * predicate reads. Structurally a `Pick` of `RecordedEngineOpenBasis`
 * (`live-options-fee-slippage-ledger.ts`), restated locally so this module keeps
 * importing nothing — the acyclic direction the TRA-3829 note above relies on.
 */
export interface EngineRecordedOpenEvidence {
  /**
   * Contracts EVERY priced `buy_to_open` row in the episode accounts for,
   * whoever placed them.
   *
   * ⛔ NOT the attribution figure — read {@link EngineRecordedOpenEvidence.enginePlacedContracts}.
   * Kept on the interface because the refusal messages report it: "the ledger
   * knows about 2 contracts and can only vouch for 1" is a different, and more
   * useful, statement than either number alone.
   */
  contracts: number;
  /** Quantity-weighted `filledPrice` over those fills, per contract. */
  premiumPaid: number;
  /** `buy_to_open` rows in the episode we could not price. `> 0` ⇒ refuse. */
  unpricedFills: number;
  /**
   * TRA-3913 (regression 2026-08-21) — contracts backed by rows the ENGINE
   * PLACED, i.e. excluding the reconcile's `history_import` reconstructions of
   * broker fills no chokepoint of ours recorded. THIS is the attribution
   * oracle: an import row is written for the desk's hand-placed contract
   * exactly as readily as for ours, so counting it answers "the broker says
   * this OCC was bought" where the question is "did WE buy it".
   */
  enginePlacedContracts: number;
  /** Quantity-weighted `filledPrice` over the engine-placed fills only. */
  enginePlacedPremiumPaid: number;
  /** Engine-placed rows in the episode we could not price. `> 0` ⇒ refuse. */
  enginePlacedUnpricedFills: number;
  /** Contracts in the episode whose only evidence is a `history_import` row. */
  importedContracts: number;
}

/** Why {@link splitEngineExposureContracts} attributed the row the way it did. */
export type EngineExposureReason =
  /** Not an adopted row at all — engine-opened, never imported. Oracle not consulted. */
  | 'not_imported'
  /** A SANDBOX import. Oracle not consulted: the live fill ledger cannot answer for it. */
  | 'sandbox_import'
  /** `foreign` / `unresolved` / absent authority ⇒ wholly the desk's, `armed` or not. */
  | 'foreign_authority'
  /** `engine_origin` and our own fills cover the whole lot ⇒ wholly ours. */
  | 'engine_accounted'
  /** `engine_origin` and our own fills cover only PART of the lot ⇒ the rest is the desk's. */
  | 'engine_partial'
  /** `engine_origin` but the ledger holds no `buy_to_open` for the symbol ⇒ cannot answer. */
  | 'oracle_silent'
  /** `engine_origin` but the episode holds an unpriceable fill ⇒ cannot answer completely. */
  | 'oracle_unpriced'
  /**
   * TRA-3913 regression — `engine_origin`, the ledger DOES hold opens for the
   * symbol, and every one of them is a `history_import` reconstruction of a
   * broker fill. The ledger can say the contracts exist; it cannot say they are
   * ours. A REFUSAL, not a finding: the engine's own row may equally have aged
   * out of the 30-day retention and been re-imported from history.
   */
  | 'oracle_import_only';

export interface EngineExposureSplit {
  /** Contracts attributable to THIS engine's own recorded entries. */
  engineContracts: number;
  /** The remainder — contracts on the row that the engine cannot account for. */
  adoptedContracts: number;
  /**
   * The oracle's per-contract basis for `engineContracts`, or `null` when the
   * oracle did not answer. ⚠ The caller must price the engine share at THIS,
   * never at the row's `premiumPaid`: the row's figure is the BROKER's blend
   * across both parties, so pricing 1 of 2 XLF contracts at the blended 0.965
   * yields $96.50 where the engine actually paid $108.00 — and the $85.00 the
   * desk actually paid would come out as $96.50 too. Both wrong, and they do
   * not even sum to the row.
   */
  recordedPremiumPaid: number | null;
  reason: EngineExposureReason;
  /**
   * True iff `adoptedContracts` is a REFUSAL (the oracle could not answer)
   * rather than a FINDING (it answered, and the contracts are not ours).
   *
   * These must never share a column. "The desk owns 1 XLF contract" and "the
   * fill ledger was never hydrated so we cannot vouch for anything" produce the
   * identical `adoptedUsd`, and only one of them is a fact about the book.
   */
  oracleRefused: boolean;
}

/**
 * TRA-3913 — split a row's open contracts into ENGINE and ADOPTED, using this
 * engine's own recorded `buy_to_open` fills as the oracle.
 *
 * The rule, in one line: **a row is the engine's exposure only to the extent
 * this engine's own fill records account for its contracts.**
 *
 * Total over the input space and, like {@link engineMayActOnAdoptedRow}, written
 * as an allow-list so an unrecognised shape lands in the conservative branch:
 *
 * 1. `importedFromTradier !== true` ⇒ **wholly ENGINE**, oracle NOT consulted.
 *    ⛔ This early-out is load-bearing, not an optimisation. The ledger is
 *    LIVE-only, so consulting it for a demo/paper row returns `null` for every
 *    one of them, and rule 5 would then attribute the ENTIRE paper book to the
 *    desk. Engine-opened rows are outside this ticket and the guard must never
 *    widen onto them.
 * 2. `tradierEnv === 'sandbox'` ⇒ **wholly ENGINE**, oracle NOT consulted. Same
 *    reason, and the same partition as the action predicate — on an imported row
 *    `mode` is stamped `'live'` unconditionally (TRA-3112 item 3), so `mode`
 *    would be wrong in both directions here exactly as it is there.
 * 3. authority other than `engine_origin` ⇒ **wholly ADOPTED**. A `foreign` row
 *    is the desk's by provenance; there is nothing for the oracle to add, and
 *    asking it opens a double-attribution hazard (two rows on one OCC symbol
 *    would each claim the same recorded contracts).
 * 4. `engine_origin`, oracle `null` / no engine-placed contracts / an unpriced
 *    engine-placed fill ⇒ **wholly ADOPTED**, `oracleRefused: true`. ⛔ `null`
 *    is "cannot answer", NOT "the engine bought nothing" and NOT permission
 *    (AC2). A fail-OPEN reading of exactly this `null` is what put a foreign
 *    contract on an engine row to begin with.
 * 5. `engine_origin`, oracle answered ⇒ ours up to
 *    `min(enginePlacedContracts, remaining)`, the rest the desk's. `min`
 *    matters: a PARTIAL CLOSE truncates the oracle's episode window, and a
 *    partial close on the ROW shrinks `remaining` — the two move independently
 *    and neither may over-claim the other.
 *
 * ⚠ TRA-3913 REGRESSION (2026-08-21) — rules 4 and 5 read
 * `enginePlacedContracts`, NEVER `contracts`. The episode-wide count includes
 * the reconcile's `history_import` rows, which are the broker's record of a
 * fill NO chokepoint of ours saw — written for the DESK's contract as readily
 * as for ours. Overnight on 2026-08-21 the importer appended the desk's XLF
 * contract at $0.85, the wide count went 1 → 2, and this predicate handed the
 * engine a contract it did not buy on a build that had graded 12/12 PASS the
 * same morning. **The fix was correct and the DATA moved underneath it.**
 */
export function splitEngineExposureContracts(
  row: { importedFromTradier?: boolean; adoptionAuthority?: string; tradierEnv?: string },
  remainingContracts: number,
  /**
   * Lazy on purpose: rules 1–3 must not pay for a ledger walk, and rule 1 must
   * not even be ABLE to read an answer it would have to discard.
   */
  lookupRecordedOpenBasis: () => EngineRecordedOpenEvidence | null,
): EngineExposureSplit {
  const remaining =
    Number.isFinite(remainingContracts) && remainingContracts > 0 ? remainingContracts : 0;
  const wholly = (
    who: 'engine' | 'adopted',
    reason: EngineExposureReason,
    oracleRefused: boolean,
    recordedPremiumPaid: number | null = null,
  ): EngineExposureSplit => ({
    engineContracts: who === 'engine' ? remaining : 0,
    adoptedContracts: who === 'engine' ? 0 : remaining,
    recordedPremiumPaid,
    reason,
    oracleRefused,
  });

  if (row.importedFromTradier !== true) return wholly('engine', 'not_imported', false);
  if (row.tradierEnv === 'sandbox') return wholly('engine', 'sandbox_import', false);
  if (row.adoptionAuthority !== 'engine_origin') {
    return wholly('adopted', 'foreign_authority', false);
  }

  const recorded = lookupRecordedOpenBasis();
  if (recorded === null) return wholly('adopted', 'oracle_silent', true);
  // ⚠ SCOPED TO THE ENGINE-PLACED ROWS, NOT THE EPISODE (TRA-3913 regression,
  // measured on bqb1 2026-08-21 13:26Z with the FIXED build still running). An
  // unpriceable row we did not place cannot spoil an answer about contracts we
  // did: it only concerns contracts already on the adopted side. Refusing on
  // the episode-wide count would hand the desk a whole engine row every time the
  // importer recovered one unpriced broker leg.
  if (!(recorded.enginePlacedUnpricedFills === 0)) {
    return wholly('adopted', 'oracle_unpriced', true);
  }

  // `!(x > 0)` rather than `x <= 0`: the latter admits NaN into the ACCOUNTED
  // branch, and a NaN contract count reads as a number until something compares
  // it (TRA-3486).
  const accounted =
    Number.isFinite(recorded.enginePlacedContracts) && recorded.enginePlacedContracts > 0
      ? recorded.enginePlacedContracts
      : 0;
  const premium =
    Number.isFinite(recorded.enginePlacedPremiumPaid) && recorded.enginePlacedPremiumPaid > 0
      ? recorded.enginePlacedPremiumPaid
      : null;
  if (accounted === 0 || premium === null) {
    // Separate the two silences one last time. "We hold import rows for this OCC
    // and nothing that says we placed it" is a different fact from "the episode
    // holds a fill we cannot price", and on 2026-08-21 the first one is what the
    // overnight reconcile manufactured on the live book.
    const importedOnly =
      Number.isFinite(recorded.importedContracts) && recorded.importedContracts > 0;
    return wholly('adopted', importedOnly ? 'oracle_import_only' : 'oracle_unpriced', true);
  }

  const engineContracts = Math.min(accounted, remaining);
  const adoptedContracts = remaining - engineContracts;
  return {
    engineContracts,
    adoptedContracts,
    recordedPremiumPaid: premium,
    reason: adoptedContracts > 0 ? 'engine_partial' : 'engine_accounted',
    oracleRefused: false,
  };
}

// --------------------------------------------------------------------------
// TRA-3926 — THE SAME SPLIT, ON THE WRITE PATH.
//
// ⚠ THIS FIRED ON REAL MONEY. 2026-08-21T13:48:04Z, production account ***0154:
//
//     08-20 13:35:30Z  buy_to_open   ct=1  @1.08  origin=fill            oid=142603071
//     08-20 17:00:00Z  buy_to_open   ct=1  @0.85  origin=history_import  oid=null
//     08-21 13:48:04Z  sell_to_close ct=2  @1.01  origin=fill            oid=142806015
//
// One engine buy, one DESK buy, and a TWO-contract engine sell. The close
// carries `origin: 'fill'` and a broker order id, so this engine submitted it,
// and `LIVE_OPTION_TEST_MAX_CONTRACTS` is 1 — no engine entry can open a 2-lot
// and there is no second XLF `buy_to_open` order id anywhere in our tape. The
// pre-TRA-3896 reconcile had widened the engine's row onto the broker's whole
// lot of 2, and the exit path took its quantity from `contracts`.
//
// ⛔ WHY TRA-3913 DID NOT PREVENT IT, HAVING SHIPPED THE ORACLE THAT WOULD HAVE.
// {@link splitEngineExposureContracts} had exactly ONE caller —
// `foldOpenPremiumAtRisk`, a READER. The exit path asked
// {@link engineMayActOnAdoptedRow}, a WHOLE-ROW boolean that returns `true` for
// `adoptionAuthority: 'engine_origin'` (correctly — we opened that row and must
// be able to exit it), and then took the QUANTITY from the row. **A row is a
// reader's claim about exposure AND a writer's order ticket at the same time,
// and only the reader was fixed.** The comment at `options-account.ts` naming
// `armed` as "still the parameter the exit path resolves" was written by the
// same commit and is what makes this a scoping miss rather than a surprise.
//
// ⛔ AUTHORIZATION IS NOT QUANTITY. Deploying TRA-3829's ruling B
// (`a5ab3887`, per-row hand-over) would NOT have stopped this close: ruling B
// gates rows the engine may not ACT on, and an `engine_origin` row is one the
// engine genuinely may act on. The authorization question was right here. The
// QUANTITY was wrong, and it needs a different remedy — this one.
// --------------------------------------------------------------------------

/** Why {@link boundExitContractsToEngineShare} allowed / refused what it did. */
export interface EngineExitQuantityBound {
  /**
   * Contracts the exit path may submit: `min(requested, engineContracts)`.
   * **This is the only number that may reach `sellContracts…`.**
   */
  exitContracts: number;
  /**
   * Requested minus allowed — contracts on the row this engine must NOT sell.
   * `> 0` is a REFUSAL and must be surfaced, never silently dropped: the
   * position is still open at the broker and somebody has to close it.
   */
  refusedContracts: number;
  /** What the row asked to exit before the bound. */
  requestedContracts: number;
  /**
   * {@link splitEngineExposureContracts}'s verdict on the row, or the
   * `handed_over` sentinel when a human's per-row grant lifted the bound before
   * the split was consulted.
   */
  reason:
    | EngineExposureReason
    | 'handed_over'
    | 'engine_net_of_closes'
    | 'reconcile_terminal'
    /**
     * ⭐ TRA-3977 — the fill ledger serves more than one book and at least one
     * row on this OCC carries no book discriminator, so it cannot say whether
     * those contracts are this book's or a sibling's. BLIND (the pre-fix
     * quantity) and COUNTED, never permission — but named, because the remedy
     * is not the other blind branches': those want somebody to look at the
     * ledger, this one wants the row's book stamped at fill time and then
     * waits out the retention window.
     */
    | 'book_unattributed'
    /**
     * ⭐ TRA-3926 (2026-08-25) — the row is a `desk_add` lot: the board's
     * SECOND grant of the transaction question (TRA-3909, interaction
     * `d4f622fb`, `exempt`). Like `handed_over`, the oracle is never consulted
     * and the exit goes out at the requested quantity. Measured live on
     * `07cc4ba4` before this existed: `RIG260925C00006000`, `desk_add`, 1 ct,
     * trailing stop breached, REFUSED 245× on one boot as `foreign_authority`
     * — the exemption made inert by the bound, on real money.
     */
    | 'desk_add_exempt';
  /**
   * True iff the oracle COULD NOT ANSWER for this row, rather than answering
   * and finding the contracts are not ours. Same discipline as
   * {@link EngineExposureSplit.oracleRefused} — a refusal and a finding must not
   * share a column, and the remedies differ: a finding wants the desk to close
   * its own contract, a refusal wants somebody to look at the ledger.
   */
  oracleRefused: boolean;
  /**
   * True iff the bound DECLINED TO BIND because the oracle could not make a
   * complete positive statement about this row. The exit goes out UNBOUNDED —
   * i.e. at the pre-fix quantity — and this flag is the countable residual.
   *
   * ⚠ This is a deliberate, measured fail-open and it is the smaller of two
   * real-money hazards. See the rule note on
   * {@link boundExitContractsToEngineShare}.
   */
  blind: boolean;
  /** True iff the bound actually reduced the quantity. The countable event. */
  bounded: boolean;
  /**
   * TRA-3926 (2026-08-24) — true iff the answer came from the SECOND oracle,
   * `engineNetOpenContracts`, after the first one refused. Counted separately
   * from `bounded` because it is the population that used to be `blind`, and
   * "the residual fail-open shrank by N" is the only claim this fix can make
   * that a quiet tape cannot manufacture.
   */
  netOfCloses: boolean;
}

/**
 * TRA-3926 (2026-08-24) — the WRITE path's second oracle, consulted only where
 * the first one refuses. Structural mirror of
 * `live-options-fee-slippage-ledger.ts`'s `EngineNetOpenAccount`; see that
 * function's docblock for the rule and for the four refusals it will not answer
 * through.
 */
export interface EngineNetOpenEvidence {
  /** `'open'` is the only status this bound may act on. */
  status: string;
  /** Contracts the ledger believes are open on this OCC right now. */
  netContracts: number;
  /** Of the open episode's opens, the ones the ENGINE placed. */
  engineOpenContracts: number;
  /** Of the same opens, the ones whose only evidence is a `history_import`. */
  importedOpenContracts: number;
  /** Contracts the episode's closes consumed. */
  closedContracts: number;
  /** `min(netContracts, max(0, engineOpen − closed))`. */
  engineNetContracts: number;
  /**
   * TRA-3976 — WHY the ledger could not state a net position, when it could
   * not. `'reconcile_terminal'` is the one refusal on this path that is BACKED
   * BY EVIDENCE OF OURS rather than by an absence, and the bound treats it
   * differently for exactly that reason — see
   * {@link boundExitContractsToEngineShare}.
   */
  reason?: string | null;
}

/**
 * TRA-3926 — bound an exit's `sell_to_close` quantity by the contracts THIS
 * engine's own fill records account for.
 *
 * The rule, in one line: **the engine may sell only what it can prove it
 * bought.**
 *
 * Total over the input space, and byte-for-byte a no-op on the rows that carry
 * the entire demo book plus every engine-opened live row: rules 1 and 2 of
 * {@link splitEngineExposureContracts} return the whole remainder as ENGINE for
 * `importedFromTradier !== true` and for sandbox imports, so
 * `min(requested, remaining) === requested` for every caller that was already
 * honouring `contractsRemaining`. The bound can only ever bite on a LIVE
 * IMPORTED row — which is exactly the population the reconcile can widen.
 *
 * ── ⛔ THE RULE FOR ORACLE SILENCE, AND WHY IT IS NOT "REFUSE EVERYTHING" ────
 *
 * TRA-3926 AC2 asked for the strict form: a row the oracle cannot answer for
 * exits at most what the ledger POSITIVELY accounts for — which is 0 — with the
 * residual refused. Written that way, **it turns TRA-2820 back on**, and the
 * repository already carries the control that proves it: `TRA-3829 — an
 * ENGINE-OPENED row re-adopted after a lost local row keeps its stops`. That
 * fixture is a row the app really did place, whose local row was lost to a
 * reboot; the fill ledger holds nothing for it, and the strict rule leaves it
 * open at the broker under a breached stop with no exit at all. That is not a
 * hypothetical — it is TRA-2820, measured: 8 live contracts, $216 of real
 * premium, unstopped for a session, and filed as working-as-intended.
 *
 * Two real-money hazards, opposite directions, and the choice has to be made
 * per BRANCH rather than per ticket:
 *
 *  • the ledger holds a COMPLETE, POSITIVE account of this OCC's current
 *    episode and it accounts for FEWER contracts than the row holds
 *    (`engine_partial`) ⇒ **BIND**. The ledger is working and it contradicts
 *    the row. This is the 2026-08-21 state exactly, and binding here is
 *    unambiguous: we know what we bought, we know what the row says, and the
 *    difference is somebody else's.
 *  • the oracle REFUSED — no rows for the OCC, an unpriceable engine fill, or
 *    an episode of nothing but imports ⇒ **BLIND**. The instrument is dark for
 *    this row, and a dark instrument cannot support a refusal any more than it
 *    can support a permission (`recordedOpenFillCount`'s whole reason for
 *    existing: *a discriminator that cannot tell "no" from "I do not know" is
 *    not a discriminator*). The exit goes out unbounded — the pre-fix
 *    behaviour — and `blind` is set so the residual is COUNTED rather than
 *    quietly inherited.
 *
 * ⚠ SAY WHAT THAT LEAVES OPEN. The blind branch is a fail-open, deliberately.
 * The fix shrinks the population that can over-sell from *every imported row*
 * to *rows the ledger cannot speak about*, and makes that remainder visible;
 * it does not reduce it to zero, and a report that claimed otherwise would be
 * wrong. Closing the blind branch needs a durable per-row order-id provenance
 * the ledger's 30-day retention does not currently provide — a different
 * ticket, with a different remedy.
 *
 * **Never silently sold and never silently abandoned** is one requirement, and
 * it is met branch by branch: `refusedContracts` for what we would not sell,
 * `blind` for what we could not judge. Neither is allowed to be zero-cost.
 *
 * ⛔ TWO CARVE-OUTS, AND BOTH ARE THE BOARD'S.
 *
 * 1. AN EXPLICIT PER-ROW HAND-OVER. TRA-3829 ruling B (card `331ddc56`) is
 *    that a human may hand a specific broker row to the engine, after which the
 *    engine manages it FULLY — which necessarily includes selling contracts the
 *    engine never bought, because that is the entire content of the grant. A
 *    grant that left the engine unable to exit what it was granted would be
 *    option (a) wearing ruling B's name, and it is a shipped, ratified
 *    behaviour with its own control (`TRA-3829 ARM A`).
 *
 * 2. A `desk_add` LOT. TRA-3909, interaction `d4f622fb`, answered `exempt`
 *    2026-08-22T04:23:58Z on the board instruction *"Bot should manage added
 *    positions from Tradier"* (TRA-3904 `92bc1e83`). {@link engineMayActOnAdoptedRow}
 *    has carried that grant since; this bound did not, and the two gates
 *    disagreed on real money: 2026-08-25, `RIG260925C00006000`, a `desk_add`
 *    lot (residual identity, 1 ct @0.22) with its trailing stop breached, was
 *    admitted by the authorisation gate and then REFUSED here 245× on one boot
 *    as `foreign_authority` — the row's own fill records account for 0 of it,
 *    which is TRUE and is exactly why the board's grant, not the ledger, has
 *    to answer the quantity. The refusal left a real-money position under a
 *    breached stop with no exit, i.e. TRA-2820's shape, dressed as a safety.
 *    ⚠ A `desk_add` row is the desk's WHOLE lot by construction (minted for the
 *    residual after the engine's rows are accounted for), so the requested
 *    quantity IS the granted quantity; there is no engine share to carve.
 *
 * So the bound asks the split ONLY where nobody has answered the transaction
 * question — by hand, or by ruling on the population. Note what this does NOT
 * unlock: `engine_origin` rows never needed a hand-over to be actionable, so a
 * desk contract the reconcile widened onto one has been granted by NOBODY —
 * and that is precisely the row the 2026-08-21 close sold from.
 * **AUTHORIZATION AND QUANTITY ARE STILL TWO QUESTIONS; these are the two
 * places the first one legitimately answers the second, because a decision-maker
 * answered it about THIS row, or THIS population, on purpose.**
 *
 * @param requestedContracts what the exit rule wants to sell (a full exit's
 *   `contractsRemaining`, or a TP1 partial's slice — the bound does not care
 *   which, it only ever lowers).
 * @param remainingContracts the row's open quantity, i.e. the denominator the
 *   split attributes. Passed separately from `requestedContracts` because a TP1
 *   partial asks for less than the row holds and the SPLIT must still see the
 *   whole row: attributing against the slice would let a sequence of partials
 *   each re-claim the same engine contracts.
 * @param armed the deployment-wide `ENABLE_ENGINE_ACT_ON_ADOPTED_BROKER_OPTIONS`
 *   master arm — the FIRST of ruling B's two keys. Read here for the hand-over
 *   carve-out ONLY. ⛔ It is still not consulted for the split itself: whether
 *   the engine may exit the desk's position has no bearing on who bought it
 *   (TRA-3913), and this parameter must never widen `engineContracts`.
 */
export function boundExitContractsToEngineShare(
  row: {
    importedFromTradier?: boolean;
    adoptionAuthority?: string;
    tradierEnv?: string;
    engineHandover?: { grantedAt?: unknown; grantedBy?: unknown } | null;
  },
  requestedContracts: number,
  remainingContracts: number,
  lookupRecordedOpenBasis: () => EngineRecordedOpenEvidence | null,
  armed: boolean,
  /**
   * TRA-3926 (2026-08-24) — the SECOND oracle, consulted ONLY on the branch
   * where the first one refused. Lazy for the same reason as its sibling, and
   * separate rather than folded into it because
   * {@link EngineRecordedOpenEvidence} is TRA-3913's READER contract and
   * `foldOpenPremiumAtRisk` is its other caller: re-shaping the walk that feeds
   * the fold would move numbers TRA-3911 closed on.
   */
  lookupNetOpenAccount: () => EngineNetOpenEvidence | null,
): EngineExitQuantityBound {
  const requested =
    Number.isFinite(requestedContracts) && requestedContracts > 0 ? Math.floor(requestedContracts) : 0;
  if (row.importedFromTradier === true && armed && hasEngineHandover(row)) {
    // Both of ruling B's keys are present on THIS row. The oracle is not
    // consulted at all — deliberately, so a hand-over cannot be silently
    // narrowed by the state of a ledger the human never looked at.
    return {
      exitContracts: requested,
      refusedContracts: 0,
      requestedContracts: requested,
      reason: 'handed_over',
      oracleRefused: false,
      blind: false,
      bounded: false,
      netOfCloses: false,
    };
  }
  if (row.importedFromTradier === true && row.adoptionAuthority === 'desk_add') {
    // TRA-3909's exemption (board, `d4f622fb`) — carve-out 2 in the rule note.
    // Same shape as the hand-over and for the same reason: the transaction
    // question was answered about this population on purpose, and consulting
    // the ledger here can only ever say "0 of these are ours", which is true
    // and is not the question. Not gated on `armed`: the exemption is not
    // ruling B's hand-over and `engineMayActOnAdoptedRow` does not gate it
    // either — the two gates must agree or the grant is inert (2026-08-25).
    return {
      exitContracts: requested,
      refusedContracts: 0,
      requestedContracts: requested,
      reason: 'desk_add_exempt',
      oracleRefused: false,
      blind: false,
      bounded: false,
      netOfCloses: false,
    };
  }
  const split = splitEngineExposureContracts(row, remainingContracts, lookupRecordedOpenBasis);
  if (split.oracleRefused) {
    // ── SECOND ORACLE (TRA-3926, 2026-08-24) ──────────────────────────────
    // The first oracle's episode walk truncates at the first `sell_to_close`,
    // so an OCC we bought and then CLOSED reads as silence — and on the write
    // path silence had meant "sell the row's quantity". Measured live on
    // `3d0c3582` over `BAC260925C00063000`: engine bought 1, desk added 1, we
    // sold 1, and the one contract left — which the FOLD was attributing 100%
    // to the desk in the same process — was staged to be sold by us.
    //
    // ⛔ IT CAN ONLY LOWER. Every path below returns `min(requested, …)`, and
    // every refusal falls through to the BLIND branch unchanged, which is the
    // pre-fix quantity. There is no input on which consulting this widens an
    // exit, so it cannot re-open TRA-2820 through the front door either.
    const net = lookupNetOpenAccount();
    // ── TRA-3976 — THE ONE REFUSAL THAT BINDS ─────────────────────────────
    // Asked FIRST, because the BLIND branch below would otherwise swallow it:
    // both arrive here as `oracleRefused`, and only one of them is an absence.
    //
    // `reconcile_terminal` means the reconcile watched this OCC leave the
    // broker's book across consecutive sweeps, dropped our row, and RECORDED
    // that it did so. The ledger is not dark for this symbol — it is holding
    // our own written statement that the position left our book through a
    // close no fill of ours accounts for. **A dark instrument cannot support a
    // refusal; a lit one saying "gone" can.**
    //
    // ⛔ SO ASK "CLOSED FOR WHOM" ONE MORE TIME. For the READER this refusal
    // routes the dollars to the desk (conservative: over-states adopted). For
    // the WRITER the identical byte, routed to BLIND, would submit a
    // `sell_to_close` for a position the broker already reports gone — an
    // over-sell against inventory that is not there, which is TRA-3926's
    // hazard with the phantom supplying the quantity. Conservative HERE is
    // zero.
    //
    // ⚠ SAY WHAT THIS COSTS, AND WHY IT IS NOT TRA-2820. The stranding shape
    // this can produce is: an OCC we were dropped out of, that the engine then
    // RE-BOUGHT without any chokepoint recording the fill. TRA-2820's shape —
    // "the ledger holds nothing for this OCC at all" — is `no_record`, and it
    // still falls through to BLIND, untouched. And a re-entry the ledger DID
    // record re-opens the episode (`openEpisodeWindow` clears the termination
    // at the next `buy_to_open` off zero), so the engine keeps the ability to
    // exit its own new position. `refusedContracts` carries the residual out so
    // the refusal is surfaced rather than silently abandoned.
    if (net !== null && net.status === 'indeterminate' && net.reason === 'reconcile_terminal') {
      return {
        exitContracts: 0,
        refusedContracts: requested,
        requestedContracts: requested,
        reason: 'reconcile_terminal',
        // The oracle ANSWERED — about our own book. Reporting this as a
        // refusal would route it to "somebody look at the ledger" when the
        // remedy is "somebody find out who closed this at the broker".
        oracleRefused: false,
        blind: false,
        bounded: requested > 0,
        netOfCloses: false,
      };
    }
    // ── ⭐ TRA-3977 — THE REFUSAL THAT IS NOT A DARK INSTRUMENT EITHER ─────
    // Asked BEFORE the positive-witness branch below, and named rather than
    // folded into the generic BLIND return, because it is a THIRD state and the
    // other two do not cover it: the ledger is neither dark for this OCC
    // (`no_record`) nor holding our own statement that the position left the
    // book (`reconcile_terminal`). It is holding rows it cannot attribute to a
    // book, in a process that serves more than one.
    //
    // ⛔ BLIND, NOT BOUND, and the choice is the same one the rule note above
    // makes branch by branch. Binding to 0 here would refuse an exit on every
    // legacy row on the tape the day this ships — TRA-2820 exactly, at fleet
    // scale — because every retained row predates the discriminator. The
    // reachable population that can over-sell is unchanged from TRA-3926's; what
    // changes is that it is now NAMED, so "the fix shrank the residual by N" is
    // a claim about a counted population rather than about a quiet tape.
    if (net !== null && net.status === 'indeterminate' && net.reason === 'book_unattributed') {
      return {
        exitContracts: requested,
        refusedContracts: 0,
        requestedContracts: requested,
        reason: 'book_unattributed',
        oracleRefused: true,
        blind: true,
        bounded: false,
        netOfCloses: false,
      };
    }
    if (net !== null && net.status === 'open' && net.engineOpenContracts > 0) {
      // `engineOpenContracts > 0` is the positive witness the whole branch
      // rests on: the ledger holds a `buy_to_open` WE placed on this OCC in the
      // episode that is open right now, so it is demonstrably not dark for it.
      // An import-only episode fails this test and stays BLIND — a
      // `history_import` row is evidence about the ACCOUNT, never about who
      // placed the order (TRA-3913), and TRA-3932 refuted the fetch that could
      // have told them apart.
      const share =
        Number.isFinite(net.engineNetContracts) && net.engineNetContracts > 0
          ? Math.floor(net.engineNetContracts)
          : 0;
      const exitContracts = Math.min(requested, share);
      const refusedContracts = requested - exitContracts;
      return {
        exitContracts,
        refusedContracts,
        requestedContracts: requested,
        reason: 'engine_net_of_closes',
        // The oracle ANSWERED. Keeping `oracleRefused` true here would report a
        // measured finding as a refusal, and the two want different remedies:
        // a finding wants the desk to close its own contract, a refusal wants
        // somebody to look at the ledger.
        oracleRefused: false,
        blind: false,
        bounded: refusedContracts > 0,
        netOfCloses: true,
      };
    }
    // BLIND. See the rule note above: binding on a dark instrument is how the
    // strict reading of AC2 re-creates TRA-2820. The exit goes out at the
    // quantity the rule asked for and the caller COUNTS this.
    return {
      exitContracts: requested,
      refusedContracts: 0,
      requestedContracts: requested,
      reason: split.reason,
      oracleRefused: true,
      blind: true,
      bounded: false,
      netOfCloses: false,
    };
  }
  // `Math.min` against a floored, positive-checked `requested` — a NaN request
  // has already been coerced to 0 above rather than propagated into the
  // comparison (TRA-3486: `NaN` reads as a number until something compares it,
  // and `Math.min(NaN, 1)` is `NaN`, which would reach the broker as a quantity).
  const exitContracts = Math.min(requested, split.engineContracts);
  const refusedContracts = requested - exitContracts;
  return {
    exitContracts,
    refusedContracts,
    requestedContracts: requested,
    reason: split.reason,
    oracleRefused: false,
    blind: false,
    bounded: refusedContracts > 0,
    netOfCloses: false,
  };
}

// --------------------------------------------------------------------------
// TRA-1114 — demo-only deterministic directional call/put entry.
//
// Board escalation (3rd time: TRA-1021 → TRA-1113). The board keeps reporting
// that calls/puts never fire in the DEMO paper book, yet prior tickets were
// closed on "config is live". Root cause (verified TRA-1114): the only enabled
// idea source on the EXECUTING single-leg path is the legacy RV anomaly scanner,
// which surfaces nothing on calm days (long-known, TRA-592); and the
// deterministic shadow / Phase-B spread selector stands DOWN whenever the
// trailing-year IV-rank store is thin (`ivRank === null` → stand_down), which it
// is on a fresh demo. Phase-B paper execution is on but has nothing to execute.
//
// This flag turns on a DEMO-ONLY path that builds a near-ATM, trend-aligned
// single-leg long call (uptrend) / put (downtrend) directly from the live
// selector chain and opens it in the paper book via
// `PaperOptionsAccount.openOptionFromRvCandidate(…, 'demo')`. It is:
//   • demo/paper only  — the caller hard-gates on `mode === 'demo'`; the open is
//     `mode:'demo'` with no equity override → no Tradier mirror, no live capital;
//   • OFF by default   — prod and live paths are byte-for-byte unchanged unset;
//   • an idea source   — it only produces entries; the account's existing
//     trading-window / dedup / daily-cap / sizing gates still bound it.
// Its sole purpose is to give the board the OBSERVABLE evidence the prior
// config-only closes never produced. Live-capital promotion stays gated on
// TRA-382 regardless; this path can never touch the live book.
// --------------------------------------------------------------------------

export const OPTION_DEMO_DIRECTIONAL_FLAG = 'ENABLE_OPTION_DEMO_DIRECTIONAL';

/** True iff the demo-only deterministic directional-entry flag is on. */
export function isOptionDemoDirectionalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTION_DEMO_DIRECTIONAL_FLAG]);
}

// --------------------------------------------------------------------------
// TRA-1156 (TRA-1155 follow-up) — IV-vs-realised-vol mispricing scanner wiring.
//
// TRA-1155 landed the PURE engine (`findIvRvMispricings` +
// `realizedVolFromDailyCloses`) — the volatility-risk-premium read the existing
// own-IV / skew scanners miss — but nothing calls it. This flag turns on an
// OBSERVE-ONLY demo pass that, per tick, pulls the SAME warm selector chain the
// directional/shadow passes already fetched, computes realised vol from the
// underlying's already-loaded daily closes, runs the engine, and records the
// candidates to an in-memory store surfaced read-only at
// `GET /api/health/iv-rv`.
//
// OFF by default ⇒ zero cost/IO (the engine pass early-returns and the store
// stays empty). When ON it NEVER routes into the paper book — no order is ever
// placed off these candidates this iteration; routing waits on QuantTrader's
// threshold sign-off (parent TRA-1155). Demo-first: the engine pass hard-gates
// on `mode === 'demo'`, so prod/live paths are byte-for-byte unchanged.
// --------------------------------------------------------------------------

export const OPTION_IV_RV_SCANNER_FLAG = 'ENABLE_OPTION_IV_RV_SCANNER';

/** True iff the observe-only IV-vs-RV mispricing scanner flag is on. */
export function isOptionIvRvScannerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTION_IV_RV_SCANNER_FLAG]);
}

// --------------------------------------------------------------------------
// TRA-1292 — defined-risk SHORT-PREMIUM scanner (credit spreads / iron condors).
//
// The desk is structurally LONG premium (every executing option path buys a
// contract → theta-negative). This flag turns on an OBSERVE-ONLY demo pass that,
// per tick, pulls the SAME warm selector chain the directional/IV-RV passes
// already fetched, computes realised vol from the underlying's daily closes,
// stamps the trailing-year IV-rank (TRA-1153), and runs the short-premium engine
// (`findShortPremiumStructures`) — assembling put/call credit spreads and iron
// condors gated on ivRank >= 50 + VRP-positive (IV/RV >= 1) + short-strike delta
// ~0.15–0.30. Results are recorded to an in-memory store surfaced read-only at
// `GET /api/health/short-premium`.
//
// OFF by default ⇒ zero cost/IO (the pass early-returns, store stays empty).
// When ON it NEVER routes into the paper book — no order is ever placed off these
// structures this iteration; demo routing / graduation is a SEPARATE board
// decision. Demo-first: the pass hard-gates on `mode === 'demo'`, so prod/live
// paths are byte-for-byte unchanged. Live promotion stays gated on TRA-382.
// --------------------------------------------------------------------------

export const OPTION_SHORT_PREMIUM_SCANNER_FLAG = 'ENABLE_OPTION_SHORT_PREMIUM_SCANNER';

/** True iff the observe-only defined-risk short-premium scanner flag is on. */
export function isOptionShortPremiumScannerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTION_SHORT_PREMIUM_SCANNER_FLAG]);
}

// --------------------------------------------------------------------------
// TRA-4570/4626 (landed by TRA-4705) — observe-only SWING signal scanner
// (post-earnings IV crush, momentum breakout IV lag, panic reversal, ranked by
// the fusion engine) surfaced on `EngineState.swingSignals` / the Swing tab.
//
// OFF by default ⇒ zero cost/IO. The pass walks the selector chain per symbol
// sequentially — the same shape that made the short-premium scan the Σ-leader
// of the tick tape (TRA-2262) — so it must not run on bqb1 until someone arms
// it deliberately. When ON it NEVER routes: no order is placed off these
// candidates. Demo-only (the pass hard-gates on `mode === 'demo'`).
// --------------------------------------------------------------------------

export const SWING_SIGNAL_SCANNER_FLAG = 'ENABLE_SWING_SIGNAL_SCANNER';

/** True iff the observe-only swing signal scanner flag is on. */
export function isSwingSignalScannerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[SWING_SIGNAL_SCANNER_FLAG]);
}

// --------------------------------------------------------------------------
// TRA-1977 (parent TRA-1976, rides TRA-1292's scanner) — route the short-premium
// scanner into the WHEEL paper primitive under a SHADOW/paper sub-flag.
//
// TRA-1966/1976 landed the write/settle primitives end-to-end
// (`openCashSecuredPut` → assignment → `openCoveredCall` → called-away /
// liquidation, with the TRA-1322 guards). This sub-flag turns on a DEMO-ONLY
// pass that feeds the SAME observe-only short-premium candidates (already gated
// on ivRank >= 50 + VRP-positive + short-strike |Δ| 0.15–0.30) into those
// primitives on the `WHEEL_QUALITY_UNIVERSE` names, and drives the put→stock→call
// cycle in the tick (hold-to-expiry settlement, assignment → covered call, the
// stock-stop / max-window liquidation guards).
//
// Layered ON TOP OF the scanner flag (mirrors the TRA-1203 IV-RV routing sub-flag
// pattern): it only takes effect when `isOptionShortPremiumScannerEnabled()` is
// ALSO true, so the observe-only ledger and the paper-routing path can never
// diverge, and turning the scanner off kills routing too. OFF by default ⇒ the
// short-premium pass stays exactly observe-only and prod/live paths are
// byte-for-byte unchanged. Paper-only by construction: every write opens
// `mode:'demo'` with no Tradier mirror — live `sell_to_open`/`buy_to_close`
// routing stays gate-sequenced behind TRA-1965 + real-chain gates TRA-1143, no
// live capital until cleared.
// --------------------------------------------------------------------------

export const OPTION_WHEEL_ROUTING_FLAG = 'ENABLE_OPTION_WHEEL_ROUTING';

/** True iff the short-premium scanner flag AND the wheel demo-routing sub-flag are both on. */
export function isOptionWheelRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOptionShortPremiumScannerEnabled(env) && flagOn(env[OPTION_WHEEL_ROUTING_FLAG]);
}

// --------------------------------------------------------------------------
// TRA-2028 (parent TRA-1966, spec TRA-2026) — IV-PERCENTILE entry filter on the
// wheel loop, OBSERVE-ONLY behind an OFF flag.
//
// Premium selling is only positive-EV when the premium pays for the risk —
// selling when implied vol is CHEAP is systematically negative-EV. This gates
// CSP/CC `sell_to_open` on the underlying's IV PERCENTILE (fraction of the
// trailing window below today's IV): block < 30, prefer ≥ 50, size down in the
// 30–50 `marginal` band, and require the TRA-1968 catalyst check above 90 (rich
// IV is usually a ticking event, not a mispricing). Thresholds are wired as
// config (`WHEEL_IV_FILTER_*` env), not magic numbers.
//
// SHADOW-FIRST like {@link isPopCalibrationEnabled}: the filter's decision is
// EVALUATED and ledgered on every wheel idea (entered AND skipped) for the
// entered-vs-skipped-by-decile calibration the gate needs, but it does NOT
// suppress or resize any write until an operator sets the flag. OFF by default ⇒
// the wheel routing path is byte-for-byte the pre-TRA-2028 behaviour; the ledger
// still accrues so the forward book can prove the entered set beats the
// unfiltered set before the filter earns enforcement. Live promotion stays gated
// on TRA-382 regardless.
// --------------------------------------------------------------------------

export const WHEEL_IV_FILTER_FLAG = 'ENABLE_WHEEL_IV_ENTRY_FILTER';

/**
 * True iff the wheel IV-percentile entry filter is allowed to SUPPRESS/RESIZE
 * writes (accepts 1/true/yes/on). Default OFF ⇒ observe-only: the decision is
 * still recorded for calibration, but the wheel routes exactly as before.
 */
export function isWheelIvEntryFilterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[WHEEL_IV_FILTER_FLAG]);
}

// --------------------------------------------------------------------------
// TRA-1203 (board: "try mispriced options for the rest of the week instead of
// relative value") — turn the TRA-1156 OBSERVE-ONLY IV-vs-RV scan into an
// EXECUTING demo paper-routing path.
//
// "Mispriced value" here is the volatility-risk-premium read the scanner already
// computes: fair value priced off the underlying's REALISED vol (what actually
// happened), independent of the peer/skew comparison the relative-value path
// uses. When ON, each demo tick's top BUY_PREMIUM candidate per symbol (IV cheap
// vs realised → premium underpriced → buy it) is opened on the demo paper book
// via the same `openOptionFromRvCandidate` single-leg path the directional/RV
// fills use, journal-tagged `entryArchetype:'iv-rv-buy-premium'` so the TRA-1200
// byArchetype rollup attributes it SEPARATELY from bare `single_leg_rv` — that
// per-archetype split is how the board reads "mispriced vs relative value".
//
// SELL_PREMIUM (IV rich) candidates are surfaced/logged but NOT routed: the demo
// single-leg book is long-only, so shorting premium would need a defined-risk
// spread (future work) — never a naked short.
//
// Layered ON TOP OF the scanner flag (mirrors the TRA-1028 sub-flag pattern): it
// only takes effect when `isOptionIvRvScannerEnabled()` is ALSO true, so the
// observe-only ledger and the routing path can never diverge, and turning the
// scanner off kills routing too. OFF by default ⇒ the IV-RV pass stays exactly
// observe-only and prod/live paths are byte-for-byte unchanged. Demo-only: the
// engine pass hard-gates on `mode === 'demo'`. Live-capital promotion stays
// gated on TRA-382 regardless of this flag.
// --------------------------------------------------------------------------

export const OPTION_IV_RV_ROUTING_FLAG = 'ENABLE_OPTION_IV_RV_ROUTING';

/** True iff the scanner flag AND the IV-RV demo-routing sub-flag are both on. */
export function isOptionIvRvRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOptionIvRvScannerEnabled(env) && flagOn(env[OPTION_IV_RV_ROUTING_FLAG]);
}

// Optional threshold overrides for the routing path so QuantTrader/the operator
// can loosen or tighten what counts as actionably-mispriced WITHOUT a code change
// (a calm tape can otherwise yield zero BUY_PREMIUM candidates at the strict
// 0.70 / 25% engine defaults, and the board wants observable fills this week).
// Both default to undefined ⇒ the engine's `IvRvScannerOptions` defaults stand.
export const OPTION_IV_RV_BUY_RATIO_VAR = 'OPTION_IV_RV_BUY_RATIO';
export const OPTION_IV_RV_MISPRICING_PCT_VAR = 'OPTION_IV_RV_MISPRICING_PCT';

export interface IvRvRoutingOverride {
  /** IV/RV ratio at or below which a contract is BUY_PREMIUM, or undefined for the engine default (0.70). */
  buyIvRvRatio: number | undefined;
  /** |mispricingPct| (as a fraction, e.g. 0.25) gate, or undefined for the engine default (0.25). */
  mispricingThresholdPct: number | undefined;
}

function parsePositiveFloat(raw: string | undefined): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Resolve the optional IV-RV routing threshold overrides. Returns undefined
 * bounds when unset/invalid so the caller passes nothing to the engine and the
 * 0.70 / 0.25 defaults stand. A buy ratio ≥ 1 is rejected (a BUY_PREMIUM gate
 * must sit below parity or it would fire on rich premium) and falls back.
 */
export function resolveIvRvRoutingOverride(env: NodeJS.ProcessEnv = process.env): IvRvRoutingOverride {
  let buyIvRvRatio = parsePositiveFloat(env[OPTION_IV_RV_BUY_RATIO_VAR]);
  if (buyIvRvRatio !== undefined && buyIvRvRatio >= 1) buyIvRvRatio = undefined;
  const mispricingThresholdPct = parsePositiveFloat(env[OPTION_IV_RV_MISPRICING_PCT_VAR]);
  return { buyIvRvRatio, mispricingThresholdPct };
}

// --------------------------------------------------------------------------
// TRA-1028 — net-new options swing-entry enhancements (TRA-1026 follow-up).
//
// Each lands AFTER TRA-1024/1025 (IV-aware + structure-exit-aware exec path) and
// is OFF by default with its OWN sub-flag, layered ON TOP OF the exec flag: a
// sub-flag only takes effect when `isOptionExecEnabled()` is also true, so the
// default prod path and the baseline exec path are both unchanged until
// QuantTrader signs off on the shadow/paper before-after readout. Live-capital
// promotion stays gated on TRA-382 regardless.
// --------------------------------------------------------------------------

/**
 * Item 1 — EMA-pullback (Trend-Pullback) entry archetype. When on, the bare RV
 * long additionally requires an `emaPullbackTrigger` confirmation on the trend
 * side before opening (uptrend above the 21 EMA + pullback to the 9 EMA +
 * bullish reversal candle, mirror inverse for puts).
 */
export const OPTION_EMA_PULLBACK_FLAG = 'ENABLE_OPTION_EMA_PULLBACK';

/** True iff the exec flag AND the EMA-pullback sub-flag are both on. */
export function isOptionEmaPullbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOptionExecEnabled(env) && flagOn(env[OPTION_EMA_PULLBACK_FLAG]);
}

/**
 * Item 2 — volume-confirmed breakout. When on, the high-IVR spread-routing
 * breakout signal requires `volumeConfirmedBreakout` (close beyond the Donchian
 * channel on above-average volume) instead of the bare volume-blind Donchian
 * close, tightening what counts as a high-conviction breakout on the exec path.
 */
export const OPTION_VOLUME_BREAKOUT_FLAG = 'ENABLE_OPTION_VOLUME_BREAKOUT';

/** True iff the exec flag AND the volume-breakout sub-flag are both on. */
export function isOptionVolumeBreakoutEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOptionExecEnabled(env) && flagOn(env[OPTION_VOLUME_BREAKOUT_FLAG]);
}

/**
 * Item 3 — DTE-window tunable for new directional RV long entries. The playbook
 * recommends 45–90 DTE for pullback swings (vs the current executing 30–45);
 * this exposes the window as env overrides so QuantTrader can widen it and read
 * the theta/leverage trade-off in the ledger WITHOUT a hard code change. Both
 * default to `undefined` (i.e. the engine's 30/45 `RV_LONG_DTE_ENTRY_*`), so
 * absent overrides preserve current behaviour exactly. A non-finite, non-positive
 * value, or an inverted min>max pair, is ignored (falls back to the default) so
 * a fat-finger env can't silently stand the scanner down.
 */
export const OPTION_RV_LONG_DTE_MIN_VAR = 'OPTION_RV_LONG_DTE_ENTRY_MIN';
export const OPTION_RV_LONG_DTE_MAX_VAR = 'OPTION_RV_LONG_DTE_ENTRY_MAX';

export interface RvLongDteOverride {
  /** Lower DTE bound override, or undefined to use the engine default (30). */
  min: number | undefined;
  /** Upper DTE bound override, or undefined to use the engine default (45). */
  max: number | undefined;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Resolve the optional RV-long DTE entry-window overrides. Returns `undefined`
 * bounds when unset/invalid so the caller passes nothing to the engine selector
 * and the 30/45 defaults stand. An inverted pair (min > max) is rejected as a
 * unit — both fall back — so the window never inverts.
 */
export function resolveRvLongDteOverride(env: NodeJS.ProcessEnv = process.env): RvLongDteOverride {
  let min = parsePositiveInt(env[OPTION_RV_LONG_DTE_MIN_VAR]);
  let max = parsePositiveInt(env[OPTION_RV_LONG_DTE_MAX_VAR]);
  if (min !== undefined && max !== undefined && min > max) {
    min = undefined;
    max = undefined;
  }
  return { min, max };
}

// --------------------------------------------------------------------------
// TRA-1057 (TRA-1047 sign-off) — RV scanner today-volume liquidity floor.
//
// The T2/T3 sweep on the recorded Tradier chains (TRA-1049 data) found a
// minDailyVolume floor of 25 flips the 25-day book P&L −163 → +99 and halves
// maxDD 1.77% → 0.95%. This exposes the floor as an env override so QuantTrader
// can enable it on the executing RV long path (behind `isOptionExecEnabled()`)
// after a longer forward window WITHOUT a code change. DEFAULT 0 = OFF, so the
// scanner rejects nothing on volume and prod behaviour is unchanged until set.
// A non-finite / non-positive value falls back to 0 (off). Live-capital
// promotion stays gated on TRA-382 regardless.
// --------------------------------------------------------------------------

export const OPTION_RV_MIN_DAILY_VOLUME_VAR = 'OPTION_RV_MIN_DAILY_VOLUME';

/**
 * Resolve the RV scanner's today-volume floor for the executing long path.
 * Returns 0 (off) when unset/invalid so the scanner's volume gate is a no-op
 * and prod behaviour is unchanged; returns the positive floor (e.g. 25) when
 * QuantTrader sets the env var. The caller only wires this in when
 * `isOptionExecEnabled()` is true.
 */
export function resolveRvMinDailyVolume(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInt(env[OPTION_RV_MIN_DAILY_VOLUME_VAR]) ?? 0;
}

// --------------------------------------------------------------------------
// TRA-1140 (TRA-1139 board-approved unification) — route an accepted AI Idea
// onto the SHARED proposal/execution rail (proposal-store + approve/reject +
// caps + kill-switch) as a typed `options` proposal, instead of the bespoke
// `POST …/paper-enter` direct open path.
//
// OFF by default. When OFF, `POST /api/options/ideas/:id/paper-enter` opens the
// idea directly on the paper book exactly as before (byte-for-byte unchanged).
// When ON, the same click instead queues a `kind:'options'` TradeProposal and
// confirms it through the engine's shared execution gate, so both the Proposals
// and AI-Ideas engines share ONE review/execution rail. Paper-only by
// construction on BOTH branches (the open path is `mode:'demo'`); live-capital
// wiring stays gated on TRA-382 regardless of this flag.
//
// NOTE: routing through the shared gate means the SAME kill-switches that gate
// equity proposals now gate an AI-idea entry on this path — the env kill
// (TRADING_AGENTS_LLM_DISABLED), the per-user Trading-Agents banner toggle, the
// risk circuit-breaker halt, the demo auto-trade toggle, and the demo daily
// caps. A blocked confirm leaves the proposal pending and returns the gate's
// verbatim reason (orders are never silently dropped).
// --------------------------------------------------------------------------

export const OPTIONS_PROPOSAL_RAIL_FLAG = 'ENABLE_OPTIONS_PROPOSAL_RAIL';

/** True iff the AI-Ideas → shared-proposal-rail flag is enabled (1/true/yes/on). */
export function isOptionsProposalRailEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTIONS_PROPOSAL_RAIL_FLAG]);
}

// --------------------------------------------------------------------------
// TRA-1142 (TRA-1139 board-approved direction; rides TRA-1140's rail) — demo
// AUTO-CONFIRM for accepted AI-Ideas options.
//
// TRA-1140 gave AI Ideas a MANUAL shared-rail entry (the click IS the approval).
// This flag adds the SAME demo auto-confirm path Proposals already have: when ON
// and the shared rail is ON, each surfaced+enterable idea is run through
// `shouldAutoConfirm` with options-appropriate gates (demo/paper only,
// defined-risk only, POP floor, single-lot max-loss cap, kill-switch clear,
// demo auto-trade ON) and — only if it passes — entered through the shared
// proposal queue WITHOUT a click, so the paper book starts accruing real
// auto-trade evidence for the scorecard (TRA-1141).
//
// Layered ON TOP OF the rail flag: it only takes effect when
// `isOptionsProposalRailEnabled()` is also true, so auto-confirm can never
// diverge from the manual rail path. OFF by default ⇒ no idea is ever entered
// without a click unless an operator sets BOTH env vars. Paper-only by
// construction (the entry path is `mode:'demo'`); live options auto-confirm is a
// hard NO inside `shouldAutoConfirm` regardless. Forward-test sign-off / enable
// decision is QuantTrader's, gated on accrued evidence.
// --------------------------------------------------------------------------

export const OPTION_DEMO_AUTO_CONFIRM_FLAG = 'ENABLE_OPTION_DEMO_AUTO_CONFIRM';

/** True iff the shared rail AND the demo options auto-confirm sub-flag are both on. */
export function isOptionDemoAutoConfirmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOptionsProposalRailEnabled(env) && flagOn(env[OPTION_DEMO_AUTO_CONFIRM_FLAG]);
}

// --------------------------------------------------------------------------
// TRA-1205 (TRA-1202 follow-up) — auto-execute the TOP N ranked AI option
// ideas into the DEMO paper book without a manual "Paper entry" click.
//
// This is a SEPARATE path from TRA-1142's `ENABLE_OPTION_DEMO_AUTO_CONFIRM`
// (which rides the shared proposal rail and auto-confirms EVERY enterable idea
// through `shouldAutoConfirm`). This flag turns on a simpler, self-contained
// post-feed-refresh hook that picks only the TOP N (default 3) enterable ideas,
// dedups by (symbol + structure + expiry) so a re-run of the same cached feed
// can't double-enter, and opens each through the SAME direct
// `enterPaperOptionsIdea` path the manual click uses.
//
// OFF by default ⇒ the feed read is byte-for-byte unchanged. When ON it is
// hard-gated demo-only by the caller (`settings.mode === 'demo'`) AND again
// inside the runner, so live-capital is never touched; live promotion stays
// gated on TRA-382 regardless. Activity is surfaced read-only at
// `GET /api/health/options-ideas-auto-execute`.
// --------------------------------------------------------------------------

export const OPTION_IDEAS_AUTO_EXECUTE_FLAG = 'ENABLE_OPTION_IDEAS_AUTO_EXECUTE';
export const OPTION_IDEAS_AUTO_EXECUTE_TOP_N_VAR = 'OPTION_IDEAS_AUTO_EXECUTE_TOP_N';

/** Default count of top-ranked enterable ideas to auto-execute per refresh cycle. */
export const OPTION_IDEAS_AUTO_EXECUTE_DEFAULT_TOP_N = 3;
/** Hard ceiling so a fat-finger env can't fan out the whole feed into the book. */
const OPTION_IDEAS_AUTO_EXECUTE_MAX_TOP_N = 25;

/** True iff the AI-Ideas demo auto-execute flag is on (accepts 1/true/yes/on). */
export function isOptionIdeasAutoExecuteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTION_IDEAS_AUTO_EXECUTE_FLAG]);
}

/**
 * Resolve the configured top-N (default {@link OPTION_IDEAS_AUTO_EXECUTE_DEFAULT_TOP_N}).
 * A non-finite, non-positive, or fractional value falls back to the default so a
 * malformed env can't silently disable (0) or over-fan-out the auto-executor;
 * the result is clamped to [1, {@link OPTION_IDEAS_AUTO_EXECUTE_MAX_TOP_N}].
 */
export function resolveOptionIdeasAutoExecuteTopN(env: NodeJS.ProcessEnv = process.env): number {
  const n = parsePositiveInt(env[OPTION_IDEAS_AUTO_EXECUTE_TOP_N_VAR]);
  if (n === undefined) return OPTION_IDEAS_AUTO_EXECUTE_DEFAULT_TOP_N;
  return Math.min(n, OPTION_IDEAS_AUTO_EXECUTE_MAX_TOP_N);
}

// --------------------------------------------------------------------------
// TRA-1491 (parent TRA-1479 "Demo to Live", family options-rv-long) — DARK
// live-capital gate on the RV (relative-value / reversion) single-leg LONG
// options order path.
//
// The RV scan (`runRelativeValueScan`) runs in BOTH demo and live: in live the
// paper-book open is immediately mirrored to a real Tradier `buy_to_open`
// (TRA-221). The board authorized BUILDING this live path via the TRA-1479
// checkbox interaction (accepted 2026-07-08 by `local-board`) but explicitly
// did NOT arm real capital — arming is a SEPARATE `request_board_approval`.
//
// This flag is that separation. It is a SECRET-ADJACENT live toggle (it
// authorizes real orders), so — unlike the demo flags — it is read ONLY from
// the process env (never from the `demo-flags.json` file override) and is NOT
// on the demo-flag allowlist. OFF by default ⇒ the entire live RV single-leg
// long entry (the live-book open AND its Tradier mirror) is inert: a live RV
// candidate opens nothing and places no order, so the shipped state carries
// zero real-capital risk. When an operator arms it on `tradingai-bqb1` (only
// after board approval + greeks-gate forward-sample sufficiency, TRA-1409 /
// TRA-1293), the live entry additionally inherits the SAME PoP/delta greeks
// gate the demo path forward-samples, so what gets armed is exactly what was
// validated. Demo behaviour is byte-for-byte unchanged regardless (the gate is
// live-mode only).
// --------------------------------------------------------------------------

export const OPTION_LIVE_RV_LONG_FLAG = 'ENABLE_OPTION_LIVE_RV_LONG';

/**
 * True iff the DARK live-capital RV single-leg long options order path is armed
 * (accepts 1/true/yes/on). Default OFF. Read from the process env only — this is
 * a live-order toggle, never sourced from the demo-flags file override.
 */
export function isOptionLiveRvLongEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTION_LIVE_RV_LONG_FLAG]);
}

export const RV_ENGINE_FLAG = 'RV_ENGINE_ENABLED';

/**
 * TRA-4385 (board ruling TRA-4383, option c-rv-demo) — the relative-value
 * engine master switch, env-resolved. From TRA-1207 (2026-06-30) until now this
 * was a module-local compile-time `const RV_ENGINE_ENABLED = false` in
 * signal-engine.ts that NO env var read, which meant the producer was dead in
 * every build regardless of host configuration — and `isOptionLiveRvLongArmed`
 * below could in principle read green over it. Default OFF (accepts
 * 1/true/yes/on). Setting it arms the RV SCAN only — demo evidence accrual.
 * The live entry stays dark behind `ENABLE_OPTION_LIVE_RV_LONG` + the test
 * window exactly as before (signal-engine `runRelativeValueScan` suppresses the
 * entire live entry pre-open when that arm is off, TRA-1491/TRA-1929).
 */
export function isRvEngineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[RV_ENGINE_FLAG]);
}

// --------------------------------------------------------------------------
// TRA-1490 (parent TRA-1479 "Demo to Live", family options-directional) — DARK
// live-capital gate on the deterministic DIRECTIONAL (near-ATM single-leg long
// call/put) options order path.
//
// Unlike the RV single-leg long path (TRA-1491), which already ran in BOTH demo
// and live, the directional "ignition" entry (`evaluateDemoDirectional`,
// TRA-1114) has always been caller-gated to `mode === 'demo'` and opens with no
// equity override → no Tradier mirror. There is no live directional order path
// to "flip on"; this flag is what BUILDS one (Phase 1 of the TRA-1490 gated
// promotion plan). The board authorized building the live path via the TRA-1479
// checkbox interaction (accepted 2026-07-08 by `local-board`) but explicitly did
// NOT arm real capital — arming is a SEPARATE `request_board_approval` gated on
// the option-chain capture window (TRA-382) + sandbox forward-validation
// (TRA-1436).
//
// Like the RV live flag, this is a SECRET-ADJACENT live toggle (it authorizes
// real orders), so it is read ONLY from the process env (never the
// `demo-flags.json` file override) and is NOT on the demo-flag allowlist. OFF by
// default ⇒ the directional pass NEVER runs in live (the caller gate is
// demo-OR-armed-live), no live position is created, and no Tradier order is
// placed — the shipped state carries zero real-capital risk. When an operator
// arms it on `tradingai-bqb1` (only after board approval), the live directional
// entry sizes off the real Tradier equity and mirrors the paper open to a real
// `buy_to_open` through the SAME audited smart-open broker seam the RV long path
// uses. Demo behaviour is byte-for-byte unchanged regardless (the live gate is
// live-mode only; the demo pass still keys off ENABLE_OPTION_DEMO_DIRECTIONAL).
// --------------------------------------------------------------------------

export const OPTION_LIVE_DIRECTIONAL_FLAG = 'ENABLE_OPTION_LIVE_DIRECTIONAL';

/**
 * True iff the DARK live-capital directional (call/put) single-leg options order
 * path is armed (accepts 1/true/yes/on). Default OFF. Read from the process env
 * only — this is a live-order toggle, never sourced from the demo-flags file
 * override.
 */
export function isOptionLiveDirectionalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTION_LIVE_DIRECTIONAL_FLAG]);
}

// --------------------------------------------------------------------------
// TRA-1929 (parent TRA-1916) — DARK live-capital gate on the OTM
// (`single_leg_otm`) single-leg long options order path, PLUS a shared,
// ops-dated expiry WINDOW that governs BOTH the OTM and RV live sleeves for the
// board-authorized real-money fee/slippage calibration on live capital.
//
// ⚠️ READ BEFORE CITING THIS WINDOW AS A BOUND ON EXPOSURE (TRA-2914).
// This block, and several call sites, originally described a *short* test with a
// near-term self-disable, because that is what TRA-1916/TRA-2536 authorized. THAT
// IS NO LONGER WHAT RUNS. On 2026-08-05 the board directed (TRA-2877, verbatim)
// "Don't stop trading live, overwrite the 5 day live trading test, keep Live
// Production trading going with the OTM Mispricing", and the horizon was moved out
// accordingly. The arm is a STANDING one, renewed by ops, not a short experiment
// that lapses on its own within days.
//
// The MECHANISM below is unchanged and still fail-closed. What changed is the
// HORIZON, and therefore what the window is evidence OF:
//   • it is still true that an unset/malformed/past window reads OFF;
//   • it is NOT true that inattention ends this arm on any near horizon.
// So do not size a risk, a monitoring gap, or a "bounded exposure" claim off the
// existence of this window. Read the live horizon — never a number in a comment,
// a ticket title, or a variable name:
//     GET /api/health/live-options-fee-slippage  ->  arm.testUntilIso
// A value is deliberately NOT repeated here: the previous wording went stale
// precisely because it hard-coded a duration, and TRA-2693 was filed and sized
// against that stale duration by a reader who was reading this correctly at the
// time. Whatever horizon is set, this file cannot tell you it — the process can.
//
// The OTM scan (`runOtmScan`) runs in BOTH demo and live, but until now the live
// branch had NO real-money open — it only stamped a `liveSkipReason` and skipped
// (signal-engine `runOtmScan` ~5538). This flag is the arm for wiring the same
// audited broker mirror (`mirrorLiveOptionOpen`) the RV path uses. Like the RV /
// directional live flags it is SECRET-ADJACENT (it authorizes real orders), so it
// is read ONLY from the process env — never from the `demo-flags.json` file
// override — and is NOT on the demo-flag allowlist. OFF by default ⇒ the live OTM
// entry is inert (byte-for-byte the pre-TRA-1929 suppress-and-skip behaviour), so
// the shipped state carries zero real-capital risk.
//
// ── THE AUTO-DISABLE (must be CODE, not config trust) ────────────────────────
// A boolean flag left armed is exactly the "missed manual disable leaves real
// money armed" failure mode, so the arm carries a dated expiry rather than
// trusting a manual switch-off:
// `OPTION_LIVE_TEST_UNTIL=<epoch-ms>` is a hard window end. Past it,
// BOTH `ENABLE_OPTION_LIVE_OTM` and `ENABLE_OPTION_LIVE_RV_LONG` are treated as OFF
// regardless of their boolean value ({@link isOptionLiveOtmArmed} /
// {@link isOptionLiveRvLongArmed}). FAIL-CLOSED: an unset or malformed
// `OPTION_LIVE_TEST_UNTIL` reads as a CLOSED window ⇒ neither sleeve can arm.
//
// ⚠️ The sentence that used to close this block — "prod today runs both sleeve
// flags OFF, so adding the window gate only ever tightens" — was true when it was
// written and is NOT true now: prod runs `ENABLE_OPTION_LIVE_OTM` ON against the
// live Tradier Production account, and this sleeve has real fills and open
// positions. It is removed rather than reworded because a reassurance about the
// deployed state does not belong in a source comment at all — it cannot be kept
// true, and it is read as an alibi by exactly the reviewer who should be checking.
// The flags' deployed values are readable at /api/health/live-options-fee-slippage
// (`arm.otmFlagOn` / `arm.rvFlagOn` / `arm.otmArmed`). RV remains OFF; OTM does not.
// --------------------------------------------------------------------------

export const OPTION_LIVE_OTM_FLAG = 'ENABLE_OPTION_LIVE_OTM';

/**
 * True iff the DARK live-capital OTM single-leg long options order path flag is
 * set (accepts 1/true/yes/on). Default OFF. Read from the process env only — this
 * is a live-order toggle, never sourced from the demo-flags file override. NOTE:
 * this is the RAW boolean; the actual arm additionally requires the test window to
 * be open — use {@link isOptionLiveOtmArmed} at the order-decision sites.
 */
export function isOptionLiveOtmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTION_LIVE_OTM_FLAG]);
}

export const OPTION_LIVE_TEST_UNTIL_VAR = 'OPTION_LIVE_TEST_UNTIL';

/**
 * The bounded-test DEFAULT cap on a single live entry's notional, in USD. The board
 * (TRA-1916) sized the original test off the live Tradier Production account's
 * ~$268.58 tradeable cash. The per-entry cap the guardrail enforces is
 * `min(available cash, resolveLiveOptionTestNotionalCapUsd(env))`.
 *
 * This stays the COMPILED DEFAULT rather than being bumped in place, so a box
 * running an older build (or a rollback) sizes DOWN to the July number instead of
 * inheriting a larger cap it was never reviewed for (TRA-2536).
 */
export const LIVE_OPTION_TEST_NOTIONAL_CAP_USD = 268.58;

// --------------------------------------------------------------------------
// TRA-2536 — the board authorized a SECOND bounded live-production window on the
// OTM sleeve, sized "2-4 contracts/trade, limit-at-ask, swing-only, hard 5-day
// auto-disable", against the $468.58 now funded on the live Tradier Production
// account (admin book).
//
// The TRA-1929 window hard-coded BOTH the size (exactly 1 contract) and the cap
// ($268.58), so neither of the board's two size parameters was expressible without
// a deploy. These two resolvers make them ops-settable — but BOUNDED IN CODE, so a
// typo or a stale env cannot authorize more than the board did:
//
//   • the notional cap clamps to `LIVE_OPTION_TEST_NOTIONAL_CEILING_USD` — the
//     board-stated account balance. A larger value clamps DOWN, it never widens.
//   • the contract count clamps to `LIVE_OPTION_TEST_CONTRACTS_HARD_MAX` (4 — the
//     top of the board's "2-4" range).
//
// Both FAIL SAFE: absent / malformed / non-positive reads fall back to the COMPILED
// conservative default (the July cap, 1 contract), never to the ceiling. So the
// shipped state with no env set is byte-equivalent in risk to the TRA-1929 window,
// and an env wipe (TRA-2193) shrinks the arm rather than widening it.
// --------------------------------------------------------------------------

/**
 * Hard ceiling on the per-entry notional cap, USD. The board funded $468.58 on the
 * live Tradier Production account for TRA-2536; no env value may authorize a single
 * entry larger than that. Combined with the `min(available cash, cap)` rule at the
 * order site, aggregate exposure across the window is bounded by the real balance —
 * each open reduces buying power, so successive entries self-limit.
 */
export const LIVE_OPTION_TEST_NOTIONAL_CEILING_USD = 468.58;

export const LIVE_OPTION_TEST_NOTIONAL_CAP_VAR = 'LIVE_OPTION_TEST_NOTIONAL_CAP_USD';

/**
 * Resolve the per-entry notional cap (USD) for the bounded live-options test.
 * Clamped to `(0, LIVE_OPTION_TEST_NOTIONAL_CEILING_USD]`. Absent, malformed or
 * non-positive ⇒ the compiled {@link LIVE_OPTION_TEST_NOTIONAL_CAP_USD} default
 * (fail-safe: never the ceiling).
 */
export function resolveLiveOptionTestNotionalCapUsd(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[LIVE_OPTION_TEST_NOTIONAL_CAP_VAR];
  if (typeof raw !== 'string') return LIVE_OPTION_TEST_NOTIONAL_CAP_USD;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return LIVE_OPTION_TEST_NOTIONAL_CAP_USD;
  return Math.min(n, LIVE_OPTION_TEST_NOTIONAL_CEILING_USD);
}

/**
 * Top of the board's authorized "2-4 contracts/trade" range (TRA-2536). No env
 * value may size a bounded-test entry above this.
 */
export const LIVE_OPTION_TEST_CONTRACTS_HARD_MAX = 4;

/**
 * Compiled default contract count — the conservative TRA-1929 size. An unset or
 * malformed env var sizes here, NOT at the hard max.
 */
export const LIVE_OPTION_TEST_MAX_CONTRACTS_DEFAULT = 1;

export const LIVE_OPTION_TEST_MAX_CONTRACTS_VAR = 'LIVE_OPTION_TEST_MAX_CONTRACTS';

/**
 * Resolve the MAXIMUM contracts a single bounded-test live entry may open. Integer,
 * clamped to `[1, LIVE_OPTION_TEST_CONTRACTS_HARD_MAX]`. Absent / malformed /
 * non-integer / non-positive ⇒ {@link LIVE_OPTION_TEST_MAX_CONTRACTS_DEFAULT}.
 *
 * This is a CEILING, not a target: the order site steps the count DOWN until the
 * ask-notional fits the cap, so a rich contract opens fewer (or is skipped) rather
 * than breaching the cap.
 */
export function resolveLiveOptionTestMaxContracts(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[LIVE_OPTION_TEST_MAX_CONTRACTS_VAR];
  if (typeof raw !== 'string') return LIVE_OPTION_TEST_MAX_CONTRACTS_DEFAULT;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1) return LIVE_OPTION_TEST_MAX_CONTRACTS_DEFAULT;
  return Math.min(n, LIVE_OPTION_TEST_CONTRACTS_HARD_MAX);
}

// --------------------------------------------------------------------------
// TRA-3445 — the AGGREGATE bound. The board's TRA-3384 answer (option A,
// 2026-08-12T23:32Z) authorized "1 contract/name, max $150/entry, **max $750
// total**". The first two clauses are the two resolvers above. The third had NO
// enforcement path: every guard in this file bounds a SINGLE entry.
//
// The comment on LIVE_OPTION_TEST_NOTIONAL_CEILING_USD above argues aggregate
// exposure is "bounded by the real balance — each open reduces buying power, so
// successive entries self-limit". That is TRUE and it is the WRONG BOUND: it is
// the CASH bound, not the board's. Measured on the admin book (***0154) the night
// this was filed: `optionsCash` $1,035.94, `openOptions: 0` ⇒ floor(1035.94/150)
// = SIX entries fit before cash blocks the seventh, i.e. a $900 worst case, $150
// over the authorization. The 1-hour `recentSignals` dedupe is keyed on the exact
// OCC symbol, so it does not dedupe by underlying and bounds no dollars at all.
//
// The utilization side of this bound is DELIBERATELY not a counter. A since-boot
// accumulator resets to 0 on every redeploy (bqb1 restarted six times on
// 2026-08-12 alone) and so cannot bound a multi-session window — and, worse, a
// reset one reads IDENTICALLY to a genuinely empty book. The order site derives
// it from the CURRENTLY-OPEN POSITIONS instead (see
// `foldOpenPremiumAtRisk` in options-account.ts), which survives a restart
// because the positions do.
// --------------------------------------------------------------------------

/**
 * Compiled default AGGREGATE cap on concurrent live bounded-test premium at
 * risk, USD — the board's stated "$750 total" (TRA-3445 / TRA-3384).
 *
 * Unlike the per-entry pair, the default and the ceiling are the SAME number:
 * the board named one figure and there is no conservative value below it that
 * was separately authorized. Keeping both constants (rather than one) preserves
 * the fail-safe shape of the sibling resolvers and lets a future board raise or
 * lower one edge without the other silently following.
 */
export const LIVE_OPTION_TEST_AGGREGATE_CAP_USD = 750;

/**
 * Hard ceiling on the aggregate cap, USD. No env value may authorize more total
 * exposure than the board did — a larger value clamps DOWN, it never widens.
 */
export const LIVE_OPTION_TEST_AGGREGATE_CEILING_USD = 750;

export const LIVE_OPTION_TEST_AGGREGATE_CAP_VAR = 'LIVE_OPTION_TEST_AGGREGATE_CAP_USD';

/**
 * Resolve the AGGREGATE premium-at-risk cap (USD) for the bounded live-options
 * test. Clamped to `(0, LIVE_OPTION_TEST_AGGREGATE_CEILING_USD]`. Absent,
 * malformed or non-positive ⇒ the compiled
 * {@link LIVE_OPTION_TEST_AGGREGATE_CAP_USD} default — never unlimited, and
 * never larger than the ceiling.
 */
export function resolveLiveOptionTestAggregateCapUsd(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[LIVE_OPTION_TEST_AGGREGATE_CAP_VAR];
  if (typeof raw !== 'string') return LIVE_OPTION_TEST_AGGREGATE_CAP_USD;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return LIVE_OPTION_TEST_AGGREGATE_CAP_USD;
  return Math.min(n, LIVE_OPTION_TEST_AGGREGATE_CEILING_USD);
}

// --------------------------------------------------------------------------
// TRA-3674 — the aggregate cap is CAPITAL-PROPORTIONAL, not a flat per-book
// dollar figure.
//
// The scalar above is enforced PER BOOK (each engine sizes against its own
// Tradier balance; there is no fleet accumulator), which TRA-3445 disclosed
// rather than fixed. Measured 2026-08-14T01:0xZ off `/api/health/options-live`
// → `liveArmCensus`, TWO books hold `liveEntryGateOpen`: `admin` (***0154,
// $1,143.96) and `v0nni` (***9652, $400.00). Under a flat $750/book cap the
// fleet worst case is $1,150 — $400 over the board's TRA-3384 authorization —
// and v0nni's own bound is **100% of its account**: its cash runs out before
// the cap ever bites. A dollar-denominated cap is EQUITY-BLIND, so it
// necessarily mis-sizes one of any two books with different balances.
//
// ⚠ The worst case is NOT `cap × books`. That multiplication assumes the cap is
// what binds; run the admit loop instead. admin binds on the cap ($750), v0nni
// binds on its own cash ($400) ⇒ $1,150, not $1,400.
//
// The replacement needs NO cross-engine state, which is the whole point:
//
//     B_i = min( φ · availableCash_i , A )
//
// ⚠⚠ TRA-3723 — READ THE PRECONDITION. This block used to close the line above
// with `Σ_i φ·E_i = φ·Σ_i E_i ≡ A` and call the fleet bound automatic. IT IS
// NOT. That identity is not an identity; it is a FITTED COINCIDENCE that holds
// only while
//
//     Σ_i E_i  ≤  A / φ  =  750 / 0.4858  =  $1,543.85
//
// because φ was fitted to ONE NIGHT of balances — the two numbers measured
// 2026-08-14T01:0xZ, right above, summing to $1,543.96
// ({@link LIVE_OPTION_TEST_FLEET_CAPITAL_BASIS_USD}). Note those are not the
// same figure: rounding φ UP at the 4th place puts the ceiling ELEVEN CENTS
// BELOW the capital it was fitted to, so the precondition is *already*
// marginally violated — which is precisely the disclosed $0.05 overage, and
// nothing more. `min(…, A)` is a PER-BOOK clamp; a per-book
// clamp cannot bound a SUM. Past the basis the fleet fails OPEN, and the
// trigger is a DEPOSIT — nobody has to touch φ, this file, or an env var:
//
//     admin at $2,000 : min(0.4858 × 2000, 750) = 750.00
//     v0nni at $  400 : min(0.4858 ×  400, 750) = 194.32
//     fleet                                       $944.32   vs a $750 authorization
//
// TRA-3723 took its option (c): the fail-open is DETECTED AND PUBLISHED rather
// than assumed away — see `gradeLiveOtmFleetBound` below, served as
// `aggregateFleetBound` on `GET /api/health/live-options-fee-slippage`. Be
// exact about what that buys: a DETECTOR, not a bound. It made the breach
// visible; it did not stop it — and on 2026-08-20 it published `breach` on
// ARMED real money (Σ B_i $558.68 vs A $500) for six days into an empty room
// until TRA-3737 gave it a reader.
//
// ⭐ TRA-3879 CLOSED THE FAIL-OPEN ITSELF: `φ_eff = min(φ, A / Σ E_i)`, so
// `Σ_i B_i ≤ A` now holds STRUCTURALLY at any balances — see
// {@link resolveEffectiveFleetRiskFraction}. Two things that were true above
// are no longer true and are corrected rather than softened: bounding the sum
// did NOT require the mutable cross-engine accumulator TRA-3445 avoided (a READ
// of one derived scalar is enough), and the bound in force is no longer per
// book. ⚠ WITH ONE EXCEPTION, and it is the reason the detector stays: when the
// fleet read is unusable, sizing falls back to the per-book bound and the SUM is
// unbounded again — published as `fleetSizingReason: 'fleet_capital_unreadable'`
// rather than left to be inferred. The bound is also only ever as fresh as the
// last balance read.
//
// Two properties worth naming because they are the reason to prefer this over a
// smaller flat cap:
//   • it EQUALIZES concentration — every book lands on the same fraction of
//     itself, rather than one at 66% and another at 100%;
//   • it self-adjusts in the SAFE direction — a book that loses money gets a
//     smaller budget. A fixed cap does the reverse: as a book shrinks, a flat
//     $750 becomes an ever larger fraction of it. That is exactly how v0nni
//     reached 100%.
//
// `min(…, A)` is retained so no single book can ever hold the whole
// authorization, whatever φ resolves to.
// --------------------------------------------------------------------------

/**
 * Compiled default fleet risk fraction φ — the share of a book's own available
 * cash it may put at aggregate risk in the bounded live-options test.
 *
 * `0.4858` = 750 / 1,543.96 = the board's authorization over the fleet capital
 * MEASURED ON THE NIGHT THIS SHIPPED (admin $1,143.96 + v0nni $400.00), so
 * `Σ φ·E_i` lands on the authorization exactly — *at that capital and no
 * other*. It is a DEFAULT, not a law: when fleet capital moves, ops re-points
 * {@link LIVE_OPTION_TEST_FLEET_RISK_FRACTION_VAR}.
 *
 * ⚠⚠ TRA-3723 — this docstring used to close with "a stale φ can only ever
 * mis-size in the bounded direction, never above `A`". That is true PER BOOK
 * (`B_i ≤ A` always) and FALSE FOR THE FLEET, which is the number the board
 * actually authorized. A stale φ over GROWN capital fails open on the sum:
 * admin at $2,000 + v0nni at $400 ⇒ `Σ B_i` = $944.32 against `A` = $750. The
 * precondition is `Σ E_i ≤ A/φ` = $1,543.85, it is not enforced anywhere, and
 * the thing that violates it is a DEPOSIT — not an edit.
 * {@link gradeLiveOtmFleetBound} detects and publishes the violation; nothing
 * prevents it.
 *
 * ⚠ DISCLOSED, not hidden: `0.4858` is 750/1,543.96 = `0.485764…` rounded UP at
 * the 4th place, so on today's two books `Σ B_i` = 555.73 + 194.32 = **$750.05**
 * — five cents over the authorization, from the rounding of φ itself and not
 * from the bound. Named here because the whole point of this ticket is that a
 * fleet figure must be stated rather than assumed; a φ of `0.48576` clears it
 * if the board ever wants the cent. Per book `B_i ≤ A` holds exactly.
 */
export const LIVE_OPTION_TEST_FLEET_RISK_FRACTION = 0.4858;

/**
 * Hard ceiling on φ. 1.0 = "a book may risk its entire own balance", which is
 * the state TRA-3674 exists to stop being reachable by accident; no env value
 * may authorize more than the whole account, so a larger value clamps DOWN.
 */
export const LIVE_OPTION_TEST_FLEET_RISK_FRACTION_CEILING = 1.0;

export const LIVE_OPTION_TEST_FLEET_RISK_FRACTION_VAR = 'LIVE_OPTION_TEST_FLEET_RISK_FRACTION';

/**
 * Resolve the fleet risk fraction φ. Clamped to
 * `(0, LIVE_OPTION_TEST_FLEET_RISK_FRACTION_CEILING]`. Absent, malformed
 * (`''` / `abc` / `NaN` / `Infinity`) or non-positive (`0` / `-1`) ⇒ the
 * compiled {@link LIVE_OPTION_TEST_FLEET_RISK_FRACTION} default.
 *
 * Same fail-safe shape as its three siblings above, deliberately: a malformed
 * value falls back to a bounded default rather than to 0 (which would silently
 * dark the whole sleeve and read identically to "the market offered nothing")
 * and never to 1.0.
 */
export function resolveLiveOptionTestFleetRiskFraction(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[LIVE_OPTION_TEST_FLEET_RISK_FRACTION_VAR];
  if (typeof raw !== 'string') return LIVE_OPTION_TEST_FLEET_RISK_FRACTION;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return LIVE_OPTION_TEST_FLEET_RISK_FRACTION;
  return Math.min(n, LIVE_OPTION_TEST_FLEET_RISK_FRACTION_CEILING);
}

// --------------------------------------------------------------------------
// TRA-3879 — remedy (f): BOUND THE SUM by re-deriving φ from LIVE capital.
//
//     φ_eff = min( φ , A / Σ_i E_i )      ⇒      Σ_i B_i ≤ φ_eff · Σ_i E_i ≤ A
//
// structurally, at ANY balances. It is not a tighter fitting of φ; it removes
// the fitting from the bound entirely. φ stays as the CONCENTRATION policy (no
// book may risk more than that share of itself) and `A` becomes what the board
// ratified it to be: a bound on the fleet.
//
// Why this shape and not the other two candidates (the board call on TRA-3879):
//   • (a) a cross-engine ACCUMULATOR at the order site bounds the true sum
//     under arbitrary balances, but puts shared MUTABLE state on the order
//     path — the thing TRA-3445 avoided on purpose.
//   • (e) a DECLARED per-book basis `D_i` is structurally exact with zero
//     cross-engine state, but a book missing from the declaration map has no
//     `D_i` and the fail-closed default DARKS it silently — indistinguishable
//     from "the market offered nothing".
//   • (f) — this — needs a cross-engine READ of one derived scalar, and its
//     only failure mode is SIZING SMALLER THAN EXPECTED. It cannot dark a
//     book: `φ_eff > 0` whenever `A > 0`, and an unreadable fleet degrades to
//     the per-book bound already in force (see `fleet_capital_unreadable`).
//
// ⚠ IT IS ONLY AS FRESH AS THE LAST BALANCE READ. That is the honest weakness
// versus (e): between a deposit and the next balance snapshot, `Σ E_i` is
// understated and the bound is loose by that delta. The TRA-3737 reader is the
// backstop for exactly that window, which is why AC3 forbids blinding it.
// --------------------------------------------------------------------------

/**
 * One book's contribution to `Σ E_i`, as the cross-engine read publishes it.
 *
 * ⚠ BALANCES ONLY. Deliberately NOT the full `LiveOtmFleetBoundRow` (no
 * `capUsd`): a budget is now a function of the fleet sum, so a row carrying a
 * budget would make resolving one re-enter the read that produced it.
 */
export interface LiveOtmFleetCapitalRow {
  /** `alertUsername`. */
  book: string | null;
  /** Summed on THIS, never on `mode` (TRA-3445: three `live` books, two armed). */
  liveEntryGateOpen: boolean;
  /**
   * The CASH half of `E_i`. `null` ⇒ no usable snapshot ⇒ contributes nothing
   * and can spend nothing.
   *
   * ⚠ TRA-3897 — this is no longer `E_i` on its own. `E_i` is
   * {@link resolveLiveOtmSizingBasisUsd}`(availableCashUsd, openPremiumAtRiskUsd)`.
   */
  availableCashUsd: number | null;
  /**
   * TRA-3897 — the PREMIUM half of `E_i`: this book's open live option premium
   * at ENTRY cost (`foldOpenPremiumAtRisk().usd`).
   *
   * Required, not optional-with-a-default, for the same reason `fleetCapitalUsd`
   * is required on {@link resolveLiveOptionTestBookAggregateCapUsd}: an optional
   * operand lets a new producer silently re-introduce the cash-only basis, and
   * the cash-only basis is the defect. The compiler makes every producer say.
   */
  openPremiumAtRiskUsd: number;
}

/** Why the φ in force is what it is. Published so a small budget is attributable. */
export type LiveOtmFleetSizingReason =
  /** `φ` binds: the live fleet still fits under `A/φ`. The pre-TRA-3879 posture. */
  | 'phi_configured'
  /** `A / Σ E_i` binds: φ is STALE against live capital and would have failed open. */
  | 'phi_fleet_derived'
  /**
   * The fleet read is unwired / threw / summed to nothing usable, so only THIS
   * book's basis was visible. Sizing falls back to `min(φ·E_i, A)` — the bound
   * in force before this ticket, NOT zero. A book is never darked by a missing
   * fleet read (TRA-3879 AC4); the TRA-3737 reader stays the backstop.
   */
  | 'fleet_capital_unreadable';

/** The φ actually used to size, with everything it was derived from. */
export interface LiveOtmFleetSizing {
  /** `φ_eff` — full precision, NOT rounded to φ's published 4 places. */
  phiEffective: number;
  /** φ as resolved from env/compiled default, after the ceiling clamp. */
  phiConfigured: number;
  /** `Σ E_i` the derivation used. `null` ⇒ nothing usable was visible. */
  fleetCapitalUsd: number | null;
  /** How many books that sum covered (self included). */
  fleetCapitalBooks: number;
  reason: LiveOtmFleetSizingReason;
}

/**
 * TRA-3897 — `E_i`, the SIZING BASIS: `availableCash_i + openPremiumAtRisk_i`.
 *
 * ── Why the basis had to stop being cash ────────────────────────────────────
 * `capUsd = φ · availableCash` was a ceiling on a book's TOTAL at-risk
 * (`fitsLiveOptionTestAggregateCap` is `atRisk + entry ≤ cap`), while the thing
 * it bounded was measured on the OTHER SIDE of the same transaction. Buying an
 * option for `x` moves `atRisk` UP by `x` and moves `cap` DOWN by `φ·x`,
 * because the cash that funded it left the basis. Two consequences, both
 * measured live on `1fed3f51c65c` 2026-08-20:
 *
 *   • THE FLEET METRIC MOVED THE WRONG WAY WHEN RISK WAS TAKEN. At 03:07Z
 *     `aggregateFleetBound.verdict` was `breach`, Σ B_i $558.68 vs A $500. At
 *     20:33Z the same field read `within`, Σ B_i $327.75 — with NO fix shipped
 *     in between. The sleeve had converted $273.00 of cash into two real-money
 *     contracts. A reader grepping the route would have closed the breach on a
 *     self-healed symptom.
 *   • ANY BOOK SPENDING MORE THAN `φ/(1+φ)` OF ITS CASH ENDED UP PERMANENTLY
 *     OVER ITS OWN PUBLISHED CAP, BY CONSTRUCTION — 32.7% at φ 0.4858. `admin`
 *     spent $273.00 against a $199.02 threshold and carried
 *     `openPremiumAtRiskUsd $334.00` against `capUsd $133.43`. Not a gate
 *     failure: at order time the entries fit the then-current cap. The basis
 *     moved out from under the position after it was opened.
 *
 * `cash + atRisk` is the only candidate that is INVARIANT UNDER THE ACT OF
 * TAKING RISK, and it is invariant EXACTLY — not approximately — because
 * `foldOpenPremiumAtRisk` bases on the ENTRY premium (`premiumPaid`), never the
 * mark. Buying moves `cash` down by `x` and `atRisk` up by the same `x`, so the
 * basis is unchanged and the cap does not drift under an open position. A
 * mark-based at-risk figure would have re-created the defect in the other
 * direction, authorizing new entries out of unrealized gains.
 *
 * ── The two fail-modes, and why both are conservative ───────────────────────
 * `null` (never 0) when CASH is unreadable: unchanged from the cash-only
 * resolver, so `no_balance_snapshot` keeps its existing fail-closed verdict and
 * this function does not acquire a second one.
 *
 * An unreadable / negative / non-finite `openPremiumAtRiskUsd` coerces to **0**
 * rather than darking the book. That is deliberate and it is bounded: it can
 * only UNDERSTATE `E_i`, and the worst case it degrades to — `φ · cash` — is
 * exactly the bound in force before this ticket. Per TRA-3879's rule, a missing
 * operand costs the fleet its improvement, never its floor.
 *
 * ⚠ `foldOpenPremiumAtRisk` counts an UNPRICED row as $0 toward `usd`, so an
 * imported row with no cost basis understates this basis too. Same direction:
 * the cap comes out tighter, never looser. `unpricedOpenRows` is published
 * beside it so the understatement is readable rather than assumed away.
 */
export function resolveLiveOtmSizingBasisUsd(
  availableCashUsd: number | null | undefined,
  openPremiumAtRiskUsd: number | null | undefined,
): number | null {
  if (typeof availableCashUsd !== 'number') return null;
  if (!Number.isFinite(availableCashUsd) || availableCashUsd < 0) return null;
  const atRisk =
    typeof openPremiumAtRiskUsd === 'number'
    && Number.isFinite(openPremiumAtRiskUsd)
    && openPremiumAtRiskUsd > 0
      ? openPremiumAtRiskUsd
      : 0;
  return (Math.round(availableCashUsd * 100) + Math.round(atRisk * 100)) / 100;
}

// --------------------------------------------------------------------------
// TRA-3964 — THE TWO HALVES OF `E_i` ARE SNAPSHOTS TAKEN UP TO 120s APART, AND
// THE SKEW IS FAIL-OPEN.
//
// `resolveLiveOtmSizingBasisUsd` above is exact — *given simultaneous operands*.
// Its whole justification is the invariance "buying for `x` lowers cash by `x`
// and raises at-risk by `x`, so `E_i` does not move". The two halves do not move
// together:
//
//   • `openPremiumAtRiskUsd` — SYNCHRONOUS. A fold over the in-memory
//     `openOptions` map, correct the instant `openOptionFromCandidate` returns.
//   • `availableCashUsd`     — a CACHED broker balance, refreshed on `doTick`
//     only once `TRADIER_BALANCE_REFRESH_MS` (120s) has elapsed.
//
// And the refresh asymmetry was exactly backwards: `mirrorLiveOptionOpen` forced
// a refresh on `rejected` and on `walk_exhausted` — the two branches where NO
// cash moved — and not on `filled`, the one where it did. So for up to 120s (FOUR
// scanner ticks at the 30s interval) `E_i` DOUBLE-COUNTS the premium just spent:
// the stale cash still contains it and `openPremiumAtRiskUsd` now contains it
// too. `capUsd` is inflated by `φ_eff · x`, and so is every column derived from
// it. Measured on the shipped folds over bqb1's live `admin` row: after spending
// its whole $36.90 allowance the engine offered $6.45 more admission where the
// true book had $0.01.
//
// ⛔ THE ONE-LINE FIX (refresh on `filled`) INVERTS THE FAILURE. A refresh
// RACES the broker's own settlement: return before Tradier debits and we cache
// PRE-DEBIT cash *and* push the next scheduled refresh out another 120s — a
// LONGER skew with no self-healing deadline.
//
// ⭐ So the basis is made UN-DOUBLE-COUNTABLE instead, with no new broker call on
// the order path: the engine tracks the premium it has spent since the balance
// snapshot was taken and DEDUCTS it from the cash half. `E_i` is then correct
// regardless of refresh timing — the correction is exactly the term the stale
// snapshot is missing, and it goes to zero on its own the moment a snapshot that
// post-dates the fill arrives.
// --------------------------------------------------------------------------

/**
 * How long AFTER a fill a balance snapshot must have been taken before that
 * fill's premium is treated as reflected in it.
 *
 * ⭐ THIS CONSTANT IS THE WHOLE ANSWER TO THE SETTLEMENT RACE, and it is why
 * this is not the one-line fix. `snapshotAt > filledAt` is NOT sufficient: a
 * balance fetched microseconds after the fill acknowledgment can legitimately
 * come back pre-debit, and clearing the fill on it would restore the very
 * double-count this exists to remove. The grace makes "reflected" mean "taken
 * far enough after the fill that a debit had to be in it".
 *
 * ⚠ IT IS ONE-SIDED ON PURPOSE. Too LARGE and a settled fill stays deducted a
 * little longer than it had to — the cap comes out TIGHTER, and it self-clears
 * at the next refresh. Too SMALL and the fail-open comes back. Every error this
 * constant can make is therefore paid in the conservative direction, which is
 * the only reason a magic number is tolerable here at all.
 */
export const LIVE_BALANCE_SETTLEMENT_GRACE_MS = 10_000;

/** One live open fill whose cash debit may not yet be in the cached balance. */
export interface UnsettledLivePremiumFill {
  /** Wall clock at which the broker reported the fill. */
  filledAtMs: number;
  /**
   * The CASH the broker debited: `avgFillPrice × contracts × 100`.
   *
   * ⚠ Deliberately the FILL price, not the row's `premiumPaid`. This term
   * corrects the CASH half, so it must be the number that actually left the
   * account — if the two ever disagree, the broker's is the one the balance
   * moved by.
   */
  premiumUsd: number;
}

/**
 * `Σ premium` over the fills a balance snapshot taken at `balanceAsOfMs` cannot
 * yet contain.
 *
 * `balanceAsOfMs = 0` (never had a successful fetch) folds EVERY fill in: with
 * no snapshot there is nothing to have settled into, and the fail-closed
 * direction is to assume none of it has.
 *
 * A non-finite / negative `premiumUsd` is counted as 0 rather than poisoning the
 * sum to `NaN` — the sum is a deduction, and a `NaN` deduction would null the
 * whole basis and dark the book over one malformed fill record. It is reported
 * in `blindFills` so "nothing is pending" and "one fill was unreadable" are not
 * the same reading.
 */
export function foldUnsettledLivePremiumUsd(
  fills: readonly UnsettledLivePremiumFill[] | null | undefined,
  balanceAsOfMs: number,
  graceMs: number = LIVE_BALANCE_SETTLEMENT_GRACE_MS,
): { usd: number; fills: number; blindFills: number } {
  if (!Array.isArray(fills) || fills.length === 0) {
    return { usd: 0, fills: 0, blindFills: 0 };
  }
  let cents = 0;
  let counted = 0;
  let blind = 0;
  for (const f of fills) {
    if (!f || !isLivePremiumUnsettled(f, balanceAsOfMs, graceMs)) continue;
    counted += 1;
    if (typeof f.premiumUsd !== 'number' || !Number.isFinite(f.premiumUsd) || f.premiumUsd <= 0) {
      blind += 1;
      continue;
    }
    cents += Math.round(f.premiumUsd * 100);
  }
  return { usd: cents / 100, fills: counted, blindFills: blind };
}

/**
 * Is this fill's debit still MISSING from a snapshot taken at `balanceAsOfMs`?
 *
 * A fill with a non-finite `filledAtMs` reads UNSETTLED (never settled): an
 * unreadable timestamp must not be a licence to stop deducting.
 */
export function isLivePremiumUnsettled(
  fill: UnsettledLivePremiumFill,
  balanceAsOfMs: number,
  graceMs: number = LIVE_BALANCE_SETTLEMENT_GRACE_MS,
): boolean {
  if (!Number.isFinite(balanceAsOfMs) || balanceAsOfMs <= 0) return true;
  const filledAt = fill.filledAtMs;
  if (typeof filledAt !== 'number' || !Number.isFinite(filledAt)) return true;
  const grace = Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : LIVE_BALANCE_SETTLEMENT_GRACE_MS;
  return balanceAsOfMs < filledAt + grace;
}

/**
 * TRA-3964 — the CASH half of `E_i`, corrected for premium the cached balance
 * snapshot has not caught up to yet: `max(0, brokerCash − unsettledPremium)`.
 *
 * `unsettledPremiumUsd` is REQUIRED, positional-second, for the same reason
 * TRA-3897 made `openPremiumAtRiskUsd` required on the basis resolver: an
 * optional operand lets a new call site silently re-introduce the raw broker
 * cash, and the raw broker cash IS the defect. The compiler makes every producer
 * say.
 *
 * FAIL-CLOSED in both directions:
 *   • an unusable `brokerCashUsd` → `null`, unchanged from before, so
 *     `no_balance_snapshot` keeps its existing verdict;
 *   • an unusable `unsettledPremiumUsd` → `null` as well. A non-finite
 *     deduction cannot be read as "deduct nothing" — that is the fail-open
 *     direction and it is the direction this whole ticket is about.
 *
 * The `max(0, …)` floor matters: a book that spent nearly all its cash between
 * two snapshots would otherwise produce a NEGATIVE cash half, which
 * `resolveLiveOtmSizingBasisUsd` rejects as unusable and would DARK the book. A
 * $0 cash half is the honest reading there — no spendable cash — and it leaves
 * `E_i` equal to the premium already at risk, i.e. the cap stops moving rather
 * than the book going out.
 */
export function resolveSettledAvailableCashUsd(
  brokerCashUsd: number | null | undefined,
  unsettledPremiumUsd: number,
): number | null {
  if (typeof brokerCashUsd !== 'number') return null;
  if (!Number.isFinite(brokerCashUsd) || brokerCashUsd < 0) return null;
  if (typeof unsettledPremiumUsd !== 'number' || !Number.isFinite(unsettledPremiumUsd)) return null;
  const deduction = unsettledPremiumUsd > 0 ? unsettledPremiumUsd : 0;
  const netCents = Math.round(brokerCashUsd * 100) - Math.round(deduction * 100);
  return Math.max(0, netCents) / 100;
}

/**
 * Sum `Σ E_i` over the gate-open books with a readable balance.
 *
 * `self` is folded in EXPLICITLY: if the caller's own book is absent from the
 * rows (unwired provider, a race at boot before this engine registered, a
 * predicate that disagrees), the sum would be missing the very basis about to
 * be sized against — which understates `Σ E_i` and LOOSENS the bound. The one
 * failure this function must not have is an optimistic one.
 *
 * `fleetCapitalUsd: null` = "could not read", never 0: a zero would make
 * `A / Σ E_i` infinite, i.e. unlimited headroom.
 */
export function sumLiveOtmFleetCapitalUsd(
  rows: readonly LiveOtmFleetCapitalRow[] | null | undefined,
  self?: {
    book: string | null;
    availableCashUsd: number | null;
    /** TRA-3897 — the premium half of self's basis. Absent ⇒ 0, i.e. cash-only. */
    openPremiumAtRiskUsd?: number | null;
  } | null,
): { fleetCapitalUsd: number | null; books: number; selfIncluded: boolean } {
  const usable = (v: number | null | undefined): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const selfBasis = self
    ? resolveLiveOtmSizingBasisUsd(self.availableCashUsd, self.openPremiumAtRiskUsd)
    : null;

  if (!Array.isArray(rows)) {
    // Unwired ⇒ the fleet is at least us. `min(φ·E_self, A)` — today's bound.
    return selfBasis === null
      ? { fleetCapitalUsd: null, books: 0, selfIncluded: false }
      : { fleetCapitalUsd: selfBasis, books: 1, selfIncluded: true };
  }

  const open = rows.filter(r => r?.liveEntryGateOpen === true && usable(r?.availableCashUsd));
  let cents = 0;
  let books = 0;
  let selfIncluded = false;
  for (const r of open) {
    // TRA-3897 — `E_i` is CAPITAL (cash + premium already at risk), not cash.
    // Summing cash alone made `Σ E_i` — and therefore φ_eff and every budget
    // derived from it — SHRINK the moment the fleet converted cash into open
    // premium, i.e. the fleet read more compliant precisely as it took risk.
    cents += Math.round(
      (resolveLiveOtmSizingBasisUsd(r.availableCashUsd, r.openPremiumAtRiskUsd) as number) * 100,
    );
    books += 1;
    if (self && r.book !== null && r.book === self.book) selfIncluded = true;
  }
  if (selfBasis !== null && !selfIncluded) {
    cents += Math.round(selfBasis * 100);
    books += 1;
    selfIncluded = true;
  }
  if (books === 0) return { fleetCapitalUsd: null, books: 0, selfIncluded: false };
  return { fleetCapitalUsd: cents / 100, books, selfIncluded };
}

/**
 * `φ_eff = min(φ, A / Σ E_i)` — the fraction that makes `Σ B_i ≤ A` STRUCTURAL
 * instead of fitted.
 *
 * Degrades to `φ` (never to 0) on an unusable `Σ E_i`, and passes an unusable φ
 * straight through so {@link resolveLiveOptionTestBookAggregateCapUsd} keeps
 * its existing fail-closed verdict rather than acquiring a second one here.
 */
export function resolveEffectiveFleetRiskFraction(
  fleetRiskFraction: number,
  fleetCapUsd: number,
  fleetCapitalUsd: number | null | undefined,
  fleetCapitalBooks = 0,
): LiveOtmFleetSizing {
  const phiConfigured =
    Number.isFinite(fleetRiskFraction) && fleetRiskFraction > 0
      ? Math.min(fleetRiskFraction, LIVE_OPTION_TEST_FLEET_RISK_FRACTION_CEILING)
      : fleetRiskFraction;
  const unreadable: LiveOtmFleetSizing = {
    phiEffective: phiConfigured,
    phiConfigured,
    fleetCapitalUsd: null,
    fleetCapitalBooks: 0,
    reason: 'fleet_capital_unreadable',
  };
  if (!Number.isFinite(fleetCapUsd) || fleetCapUsd <= 0) return unreadable;
  if (!Number.isFinite(phiConfigured) || phiConfigured <= 0) return unreadable;
  if (
    typeof fleetCapitalUsd !== 'number'
    || !Number.isFinite(fleetCapitalUsd)
    || fleetCapitalUsd <= 0
  ) {
    return unreadable;
  }
  const phiFleet = fleetCapUsd / fleetCapitalUsd;
  const derived = phiFleet < phiConfigured;
  return {
    phiEffective: derived ? phiFleet : phiConfigured,
    phiConfigured,
    fleetCapitalUsd,
    fleetCapitalBooks,
    reason: derived ? 'phi_fleet_derived' : 'phi_configured',
  };
}

/**
 * This book's aggregate premium-at-risk budget
 * `B_i = min(φ_eff · E_i, A)`, USD, rounded DOWN to whole cents, where
 * `E_i = availableCash_i + openPremiumAtRisk_i` ({@link resolveLiveOtmSizingBasisUsd}).
 *
 * ⚠ TRA-3897 — `E_i` used to be `availableCash` alone, which made this cap
 * FALL as the book spent, on the same transaction that raised the figure the
 * cap is compared against. See {@link resolveLiveOtmSizingBasisUsd} for the
 * measurement. Under the capital basis the cap is invariant across an admitted
 * entry, so a book that was inside its cap at order time stays inside it:
 * admitting `x` requires `atRisk + x ≤ φ·E`, and `E` does not move when the
 * order fills, hence `atRisk' ≤ cap' `. The pre-existing overage on `admin` is
 * NOT retroactively cleared by this — those entries were admitted under the
 * cash basis at a moment when the cap was larger.
 *
 * FAILS CLOSED to `0` — which {@link fitsLiveOptionTestAggregateCap} rejects on
 * — for every unusable input: an absent / non-finite / negative balance, a
 * non-positive fleet cap, a non-positive φ. **No balance snapshot ⇒ the book
 * takes nothing.** (The order site already fails closed one gate earlier at
 * `no_balance_snapshot`; this is the same verdict re-derived here so the health
 * route's row cannot publish a budget the order site would not honour.)
 *
 * ⚠ TRA-3879 — `fleetCapitalUsd` is REQUIRED, not optional with a status-quo
 * default. An optional argument would let a new call site silently inherit the
 * unbounded-sum behaviour, which is the TRA-3723 shape (a fleet bound nobody
 * had to state). `null` is a legal, explicit answer meaning "per book only";
 * the compiler makes every caller say which one it means.
 *
 * Floored, not rounded: `Math.round` would widen the budget by up to half a
 * cent, and this is a TIGHTENING-ONLY change — for every book `B_i ≤ A`, the
 * bound in force before it, and now `Σ_i B_i ≤ A` as well whenever the fleet
 * sum is readable. The floor is also what absorbs the float error in
 * `A / Σ E_i`: `Σ floor(φ_eff·E_i)` ≤ `φ_eff·Σ E_i` = `A` exactly.
 */
export function resolveLiveOptionTestBookAggregateCapUsd(
  availableCashUsd: number | null | undefined,
  /**
   * TRA-3897 — the premium half of `E_i`. REQUIRED and positional-second so the
   * two operands of the basis sit adjacent at every call site and the compiler
   * refuses the old 4-argument (cash-only) call outright.
   */
  openPremiumAtRiskUsd: number | null | undefined,
  fleetCapUsd: number,
  fleetRiskFraction: number,
  fleetCapitalUsd: number | null,
): number {
  const basisUsd = resolveLiveOtmSizingBasisUsd(availableCashUsd, openPremiumAtRiskUsd);
  if (basisUsd === null) return 0;
  if (!Number.isFinite(fleetCapUsd) || fleetCapUsd <= 0) return 0;
  if (!Number.isFinite(fleetRiskFraction) || fleetRiskFraction <= 0) return 0;
  const phi = resolveEffectiveFleetRiskFraction(
    fleetRiskFraction, fleetCapUsd, fleetCapitalUsd,
  ).phiEffective;
  const proRata = Math.floor(basisUsd * phi * 100) / 100;
  return Math.min(proRata, fleetCapUsd);
}

/** Round a USD figure to whole cents (integer cents) for exact comparison. */
function cents(usd: number): number {
  return Math.round(usd * 100);
}

// --------------------------------------------------------------------------
// TRA-3911 — BOUND *REACHABLE* EXPOSURE, NOT `Σ B_i`.
//
// CEO ruling (TRA-3703 comment `4b54935e`): **`A` bounds capital REACHABLE, not
// capital committed.** Everything above bounds `Σ B_i`, the fleet's unspent
// BUDGET, and that is a different quantity from the one the board authorized.
//
// Measured on `020100dc56aa`, pid 73, `startedAt 2026-08-21T00:10:46.728Z`,
// read 00:19:40Z — the same numbers the CEO read at 23:47Z on the build before:
//
//                cap B_i    cash      atRisk    headroomSigned
//     admin      $306.32   $274.68   $358.00      −$51.68
//     v0nni      $193.67   $400.00     $0.00     +$193.67
//
//     SERVED   within      Σ B_i $499.99 ≤ A $500.00
//     TRUE     reachable = Σ_i (atRisk_i + admissible_i) = $551.67  > A
//
// The whole gap is ONE GRANDFATHERED EXCESS. `admin`'s cap tightened underneath
// an already-open position (`A` came down on TRA-3827 and φ_eff moved), so its
// at-risk sits $51.68 ABOVE its own cap — and `Σ B_i` omits that excess exactly,
// because `B_i` is a budget and a budget cannot be negative. `min(cap_i, …)` is
// PER BOOK and `Σ B_i ≤ A` says nothing about `Σ atRisk_i + the next entry`.
//
// ⭐ THE FIX IS ONE EXTRA OPERAND, NOT A SECOND ENUMERATION:
//
//     admissible_i = max( 0, min( cap_i − atRisk_i , A − Σ_j atRisk_j ) )
//
// `Σ_j atRisk_j` rides the SAME cross-engine seam `Σ E_i` already uses —
// `LiveOtmFleetCapitalRow` has carried `openPremiumAtRiskUsd` since TRA-3897, so
// this is a second FOLD over rows already read, not a second read. Nothing here
// re-enters `getLiveOtmAggregateExposure()` (the re-entrancy warning at
// `index.ts` still binds: the exposure row's `capUsd` is a function of the fleet
// sum, and this fold touches only balances).
//
// ⭐ WHY THIS ACTUALLY BOUNDS THE SUM, sequentially. The second operand makes
// every admission satisfy `Σ_j atRisk_j + entry ≤ A`, and `Σ_j atRisk_j` is
// re-read at each order. So after ANY sequence of admissions `Σ atRisk ≤ A` —
// the invariant `Σ B_i ≤ A` was never able to state. On today's numbers v0nni
// goes `$193.67 → $142.00` and reachable lands on EXACTLY $500.00.
//
// ⚠ It does NOT serialize two engines evaluating in the same tick — and the
// trigger for that residual is FLEET COMPOSITION, not luck. (CEO, TRA-3911
// comment `2451aaf1`; recorded on TRA-3703 as a standing precondition. An
// earlier revision of this paragraph said only "a concurrent double-admit can
// only reach `A` from a FLAT fleet" — true, but loose enough to hide WHEN the
// residual bites.)
//
// The sharp statement starts from the first operand: a book with
// `atRisk_i ≥ cap_i` has `admissible_i = 0`, so **every book that CAN race is by
// construction under its own cap.** Count the racers:
//
//   • TWO gate-open books, both under cap → concurrent worst case is
//     `Σ_i cap_i = Σ B_i ≤ A` (the TRA-3879 invariant). Safe.
//   • TWO gate-open books, one grandfathered → the grandfathered one is
//     admissible $0, leaving exactly ONE racer. **No race exists.**
//     ⇒ on TODAY'S fleet (`admin` grandfathered, `v0nni` open) the concurrent
//     overshoot is not merely bounded, it is STRUCTURALLY UNREACHABLE.
//   • THREE OR MORE gate-open books with one grandfathered → two or more racers
//     read the same `Σ_j atRisk_j` and each admits up to its own cap, so the
//     worst case is `Σ_i cap_i + excess ≤ A + excess` — which is EXACTLY the
//     overshoot this ticket closed, back again through the concurrent door.
//
// ⭐ SO: OPENING A THIRD LIVE ENTRY GATE RE-OPENS TRA-3703'S FINDING, and
// whoever proposes it OWNS SERIALIZING ADMISSION FIRST. Do not read the
// two-book safety above as a property of the bound; it is a property of the
// fleet's current shape. It is the grandfathered term — not concurrency — that
// this ticket exists to close, and the residual is published (see
// {@link LiveOtmFleetBoundGrade.reachableSumUsd}) rather than assumed away.
//
// ⚠ DEGRADES, NEVER DARKS. An unreadable fleet at-risk yields `null` and the
// order path falls back to the per-book gate that is in force today — the same
// contract `fleet_capital_unreadable` already has (TRA-3879 AC4). A missing
// operand costs the fleet its improvement, never its floor. The fallback is
// PUBLISHED as `boundBy: 'fleet_unreadable'` so it can never be inferred from an
// admissible figure that merely looks normal.
// --------------------------------------------------------------------------

/**
 * `Σ_j atRisk_j` — premium ALREADY AT RISK across every gate-open book, USD.
 *
 * `self` is folded in explicitly for the same reason it is on
 * {@link sumLiveOtmFleetCapitalUsd}: if the caller's own book is absent from the
 * rows (unwired provider, a boot race, a predicate that disagrees) the sum would
 * omit the very at-risk figure the caller is about to add to — and here that
 * omission LOOSENS the bound, which is the one direction this function must not
 * fail in.
 *
 * ⚠ `null` (never `0`) when the fleet cannot be read. A zero would read as "the
 * fleet has spent nothing", i.e. the full authorization is available — the
 * fail-open shape. `null` routes the caller to the per-book bound instead.
 *
 * ⚠ A gate-open row carrying a non-finite / negative `openPremiumAtRiskUsd`
 * nulls the WHOLE sum rather than contributing 0. Opposite of
 * {@link resolveLiveOtmSizingBasisUsd}, and deliberately so: there, coercing a
 * missing at-risk to 0 UNDERSTATES `E_i` and therefore TIGHTENS the cap; here it
 * would understate `Σ atRisk` and therefore WIDEN the headroom. Same input, and
 * the safe coercion is the opposite one, so it cannot be shared.
 */
export function sumLiveOtmFleetAtRiskUsd(
  rows: readonly LiveOtmFleetCapitalRow[] | null | undefined,
  self?: {
    book: string | null;
    openPremiumAtRiskUsd: number | null | undefined;
  } | null,
): { fleetAtRiskUsd: number | null; books: number; selfIncluded: boolean } {
  const usable = (v: number | null | undefined): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const selfAtRisk = self && usable(self.openPremiumAtRiskUsd) ? self.openPremiumAtRiskUsd : null;

  if (!Array.isArray(rows)) {
    // Unwired ⇒ we can only vouch for ourselves, and one book's at-risk is NOT
    // `Σ_j atRisk_j`. Returning it would bound the fleet on a strict subset and
    // call it the fleet — exactly the `min(…, A)`-is-per-book defect one level
    // up. `null` ⇒ the caller keeps the per-book bound it has today.
    return { fleetAtRiskUsd: null, books: 0, selfIncluded: false };
  }

  const open = rows.filter(r => r?.liveEntryGateOpen === true);
  let acc = 0;
  let books = 0;
  let selfIncluded = false;
  for (const r of open) {
    if (!usable(r.openPremiumAtRiskUsd)) {
      return { fleetAtRiskUsd: null, books: 0, selfIncluded: false };
    }
    acc += cents(r.openPremiumAtRiskUsd);
    books += 1;
    if (self && r.book !== null && r.book === self.book) selfIncluded = true;
  }
  if (self && !selfIncluded) {
    // Our own book is not in the rows. We cannot silently drop it — that is the
    // loosening direction — so either fold it in, or admit we cannot read the
    // fleet at all.
    if (selfAtRisk === null) return { fleetAtRiskUsd: null, books: 0, selfIncluded: false };
    acc += cents(selfAtRisk);
    books += 1;
    selfIncluded = true;
  }
  if (books === 0) return { fleetAtRiskUsd: null, books: 0, selfIncluded: false };
  return { fleetAtRiskUsd: acc / 100, books, selfIncluded };
}

/**
 * Which term is holding {@link LiveOtmAdmissibleEntry.admissibleUsd} down.
 *
 *  - `book`             — `cap_i − atRisk_i` binds: this book's own budget (the pre-TRA-3911 posture).
 *  - `fleet_reachable`  — `A − Σ_j atRisk_j` binds: the FLEET's reachable headroom (the new term).
 *  - `both`             — both operands agree to the cent; published as itself so neither can claim it.
 *  - `fleet_unreadable` — `Σ_j atRisk_j` unreadable ⇒ per-book only, i.e. the bound in force before TRA-3911.
 *  - `none`             — no admissible entry at all: the book is at/over its cap, or the fleet is at `A`.
 *
 * TRA-3997 — an ALIAS of the shared `OptionAdmissionBoundBy`, so the value the
 * order site stamps on the row ({@link buildOptionAdmissionStamp}) and the value
 * the gate ledger / health route publish are one vocabulary by construction.
 */
export type LiveOtmAdmissibleBoundBy = OptionAdmissionBoundBy;

/** TRA-3911 — the largest new premium this book may add, with both operands attached. */
export interface LiveOtmAdmissibleEntry {
  /** `max(0, min(cap_i − atRisk_i, A − Σ_j atRisk_j))`, floored to whole cents. */
  admissibleUsd: number;
  /** WHICH operand bound it. Evidence, so a small budget is attributable. */
  boundBy: LiveOtmAdmissibleBoundBy;
  /** `cap_i − atRisk_i`, SIGNED. Negative ⇒ this book is already over its own cap. */
  bookHeadroomSignedUsd: number;
  /** `A − Σ_j atRisk_j`, SIGNED. `null` ⇒ fleet at-risk unreadable. */
  fleetHeadroomSignedUsd: number | null;
  /** `Σ_j atRisk_j` as folded. `null` ⇒ unreadable. */
  fleetAtRiskUsd: number | null;
  /** Gate-open books the fold covered. */
  fleetAtRiskBooks: number;
}

/**
 * TRA-3911 (AC1) — the admissible new premium for one book:
 *
 *     admissible_i = max( 0, min( cap_i − atRisk_i , A − Σ_j atRisk_j ) )
 *
 * FLOORED to whole cents, like {@link resolveLiveOptionTestBookAggregateCapUsd}:
 * this is a TIGHTENING-ONLY change and `Math.round` would widen it by up to half
 * a cent at the exact boundary the bound is about.
 *
 * FAILS CLOSED to `0` on every unusable input — a non-finite cap or at-risk, a
 * non-positive `A`. An unreadable exposure is not evidence of headroom
 * ({@link fitsLiveOptionTestAggregateCap} has the same posture). The ONE
 * exception is an unreadable `fleetAtRiskUsd`, which is a legal, explicit
 * `null`: it degrades to the per-book bound and says so in `boundBy`.
 *
 * ⚠ THE ALREADY-OVER-CAP CASE IS THE POINT, and it is the case today.
 * `bookHeadroomSignedUsd` is SIGNED on purpose — `admin` sits at −$51.68 — and
 * the `max(0, …)` is applied ONCE, at the end, so a negative book headroom
 * cannot be laundered into fleet headroom by an earlier clamp. This is the same
 * defect `liveOptionTestAggregateHeadroomUsd`'s floor produces one layer up
 * (TRA-3897): a clamped operand makes "exactly full" and "over by $51.68"
 * arithmetically identical.
 */
export function resolveLiveOtmAdmissibleEntryUsd(
  bookCapUsd: number,
  bookAtRiskUsd: number,
  fleetCapUsd: number,
  fleetAtRisk: { fleetAtRiskUsd: number | null; books: number },
): LiveOtmAdmissibleEntry {
  const fleetAtRiskUsd =
    typeof fleetAtRisk.fleetAtRiskUsd === 'number' && Number.isFinite(fleetAtRisk.fleetAtRiskUsd)
      ? fleetAtRisk.fleetAtRiskUsd
      : null;
  const fleetAtRiskBooks = fleetAtRiskUsd === null ? 0 : fleetAtRisk.books;
  const unusable = (): LiveOtmAdmissibleEntry => ({
    admissibleUsd: 0,
    boundBy: 'none',
    bookHeadroomSignedUsd: 0,
    fleetHeadroomSignedUsd: null,
    fleetAtRiskUsd,
    fleetAtRiskBooks,
  });
  if (!Number.isFinite(bookCapUsd) || bookCapUsd <= 0) return unusable();
  if (!Number.isFinite(bookAtRiskUsd) || bookAtRiskUsd < 0) return unusable();
  if (!Number.isFinite(fleetCapUsd) || fleetCapUsd <= 0) return unusable();

  const bookHeadroomSignedUsd = (cents(bookCapUsd) - cents(bookAtRiskUsd)) / 100;
  const fleetHeadroomSignedUsd =
    fleetAtRiskUsd === null ? null : (cents(fleetCapUsd) - cents(fleetAtRiskUsd)) / 100;

  const binding =
    fleetHeadroomSignedUsd === null
      ? bookHeadroomSignedUsd
      : Math.min(bookHeadroomSignedUsd, fleetHeadroomSignedUsd);
  const admissibleUsd = Math.max(0, Math.floor(binding * 100) / 100);

  let boundBy: LiveOtmAdmissibleBoundBy;
  if (admissibleUsd <= 0) boundBy = 'none';
  else if (fleetHeadroomSignedUsd === null) boundBy = 'fleet_unreadable';
  else if (cents(bookHeadroomSignedUsd) === cents(fleetHeadroomSignedUsd)) boundBy = 'both';
  else boundBy = cents(bookHeadroomSignedUsd) < cents(fleetHeadroomSignedUsd) ? 'book' : 'fleet_reachable';

  return {
    admissibleUsd,
    boundBy,
    bookHeadroomSignedUsd,
    fleetHeadroomSignedUsd,
    fleetAtRiskUsd,
    fleetAtRiskBooks,
  };
}

/**
 * TRA-3911 (AC1) — the ORDER-PATH GATE: does one more entry of
 * `entryNotionalUsd` fit the REACHABLE bound?
 *
 * Boundary INCLUSIVE and cent-compared, exactly like
 * {@link fitsLiveOptionTestAggregateCap} — an entry landing on the admissible
 * figure to the penny is admitted, and the two gates must not disagree about
 * their boundary or a reader reconciling a refusal will find one gate blaming
 * the other.
 *
 * This is deliberately a SEPARATE predicate composed with AND at the order site
 * rather than a widened `fitsLiveOptionTestAggregateCap`: the two refusals have
 * different remedies (spend down THIS book vs the FLEET is at its
 * authorization) and TRA-3674's rule is that an unattributable refusal is the
 * TRA-3216 shape. `min(…)` and `AND` are the same arithmetic; only the
 * attribution differs, and the attribution is what a desk acts on.
 */
export function fitsLiveOtmReachableBound(
  entryNotionalUsd: number,
  admissible: LiveOtmAdmissibleEntry,
): boolean {
  if (!Number.isFinite(entryNotionalUsd) || entryNotionalUsd <= 0) return false;
  return cents(entryNotionalUsd) <= cents(admissible.admissibleUsd);
}

/**
 * TRA-3997 (parent TRA-3703) — freeze the admission reading the order site just
 * compared an entry against, in the shape the row keeps
 * ({@link OptionAdmissionStamp}).
 *
 * Called at the ONE place that holds every operand at once — immediately after
 * {@link fitsLiveOtmReachableBound} admits, BEFORE the paper open — so:
 *
 *   • `openPremiumAtRiskUsd` is the PRE-order fold by construction (AC2). It is
 *     the same `atRisk.usd` the cap, the basis and the admissible figure were
 *     all computed from, not a re-read after the row landed;
 *   • `capUsd` / `phiEff` / `sizingBasisUsd` / `fleetCapUsd` are the terms the
 *     order site actually used, so the AC3 identity holds on the row alone;
 *   • `admissibleBoundBy` is whatever `resolveLiveOtmAdmissibleEntryUsd`
 *     returned — it discriminates because the operand it names varies (AC4).
 *
 * Pure: takes the numbers, returns the stamp. It NEVER reads a bound, moves a
 * cap, or refuses anything (AC6). A caller that has no admission reading (the
 * RV / directional sleeves) does not call it; the mirror seam records
 * `not_evaluated_on_path` for those instead of inventing a stamp.
 */
export function buildOptionAdmissionStamp(read: {
  admissible: LiveOtmAdmissibleEntry;
  /** The PRE-order at-risk the admissible figure was derived from. */
  openPremiumAtRiskUsd: number;
  /** `B_i` in force at admit. */
  capUsd: number;
  /** φ_eff the cap was derived from. */
  phiEff: number;
  /** `E_i` the cap was derived from; `null` ⇒ cash unreadable. */
  sizingBasisUsd: number | null;
  /** `A`. */
  fleetCapUsd: number;
  /** The entry premium (USD) being admitted. */
  entryNotionalUsd: number;
  /** Wall clock of the read, ms epoch. */
  at: number;
}): OptionAdmissionStamp {
  return {
    admissibleEntryUsd: read.admissible.admissibleUsd,
    openPremiumAtRiskUsd: read.openPremiumAtRiskUsd,
    capUsd: read.capUsd,
    admissibleBoundBy: read.admissible.boundBy,
    phiEff: read.phiEff,
    sizingBasisUsd: typeof read.sizingBasisUsd === 'number' && Number.isFinite(read.sizingBasisUsd)
      ? read.sizingBasisUsd
      : null,
    fleetCapUsd: read.fleetCapUsd,
    fleetAtRiskUsd: read.admissible.fleetAtRiskUsd,
    entryNotionalUsd: read.entryNotionalUsd,
    admittedAt: read.at,
    admissionSource: 'otm_reachable_bound',
  };
}

// --------------------------------------------------------------------------
// TRA-3723 — the FLEET-LEVEL assertion. Option (c) of the filing.
//
// Everything above bounds ONE book. Nothing above bounds the SUM, and the
// comments used to say otherwise (see the corrected block at
// `LIVE_OPTION_TEST_FLEET_RISK_FRACTION`). This is the detector that makes the
// difference readable instead of assumed.
//
// It does NOT gate any order. A refusal would need every engine's balance at
// the order site, i.e. the cross-engine accumulator TRA-3445 avoided on
// purpose. What it converts is the FAILURE MODE: a silent, deposit-triggered
// fail-open becomes a published verdict with the arithmetic attached.
// --------------------------------------------------------------------------

/**
 * The fleet capital φ's compiled default was fitted to, USD: admin $1,143.96 +
 * v0nni $400.00 as measured 2026-08-14T01:0xZ.
 *
 * This is the PRECONDITION of the whole capital-proportional scheme:
 * `Σ_i E_i ≲ 1,543.96` ⇒ `Σ_i B_i ≲ A`. Above it the fleet exceeds the board's
 * authorization with no edit, no flag and no env write — a deposit is enough.
 *
 * ⚠ `≲`, not `≤`. The bound that actually binds is `A/φ` = $1,543.85, ELEVEN
 * CENTS below this, because `0.4858` is `0.485764…` rounded UP. Today's fleet
 * therefore sits marginally past its own ceiling already, and that — not
 * anything about capital — is the entire disclosed $0.05 overage.
 * {@link gradeLiveOtmFleetBound} computes the ceiling from the φ IN FORCE
 * rather than from this constant, so an ops re-point of φ moves it.
 *
 * ⚠ It is a DISCLOSURE, not a bound. Nothing reads it to refuse. It exists so
 * the number the scheme silently depends on is nameable, greppable and
 * gradeable, and so {@link gradeLiveOtmFleetBound} can publish the headroom
 * against it. Re-derive it (and re-point φ) whenever the fleet's composition
 * changes; a book joining the arm moves it as surely as a deposit does.
 */
export const LIVE_OPTION_TEST_FLEET_CAPITAL_BASIS_USD = 1543.96;

/**
 * φ is published and configured to FOUR decimal places, so the value in force
 * may exceed the exact ratio `A / Σ E_i` by up to one unit in that place. That
 * slack costs `1e-4 × Σ E_i` on the fleet sum — $0.15 at today's capital, which
 * is what admits the already-disclosed $0.05 overage (`0.4858` is `0.485764…`
 * rounded UP) without calling it a breach.
 *
 * It scales WITH capital deliberately. A flat dollar tolerance would be the
 * same mistake as φ itself: a constant fitted to one night's balances, wrong by
 * construction the moment they move.
 */
export const LIVE_OPTION_TEST_FLEET_RISK_FRACTION_ULP = 1e-4;

/** One book's row as the fleet grade reads it. Matches `LiveOtmAggregateExposure`. */
export interface LiveOtmFleetBoundRow {
  /** `alertUsername`. Named in `books` / `unreadableBalanceBooks` so a breach is attributable. */
  book: string | null;
  /**
   * ⭐ THE DISCRIMINATING FIELD. Rows are summed on THIS, never on `mode`:
   * bqb1 carries three `mode: 'live'` books and two armed ones, so a
   * mode-based sum overstates the fleet by a whole book (TRA-3445).
   */
  liveEntryGateOpen: boolean;
  /** `B_i = min(φ_eff · availableCashUsd, A)` as the order site would resolve it. */
  capUsd: number;
  /**
   * The CASH half of `E_i`. `null` ⇒ no usable snapshot ⇒ `capUsd` is 0.
   *
   * ⚠ TRA-3903 — this is NOT `E_i` and has not been since TRA-3897. Read
   * {@link sizingBasisUsd}. The name is kept because it is the name the served
   * `aggregateExposure` row uses, and renaming a published column to fix a
   * comment breaks every reader that already joins on it.
   */
  availableCashUsd: number | null;
  /**
   * TRA-3903 — `E_i = availableCashUsd + openPremiumAtRiskUsd`, as the row
   * ALREADY publishes it. This is the column `Σ E_i` must be folded from.
   *
   * OPTIONAL for the same reason the sizing block above is: ABSENCE IS A REAL
   * READING. A row without it came from pre-TRA-3897 bytes, where `E_i`
   * genuinely WAS cash, and defaulting it would make an old build grade like a
   * new one. Absent ⇒ fall back to {@link availableCashUsd}, which is exactly
   * what that build sized on.
   */
  sizingBasisUsd?: number | null;
  /**
   * TRA-3881 — the TRA-3879 sizing block, as `getLiveOtmAggregateExposure`
   * already publishes it on the very same rows.
   *
   * OPTIONAL because ABSENCE IS A REAL READING, not a gap to be defaulted away:
   * a row without these fields came from pre-TRA-3879 bytes, where the fitted
   * precondition `Σ E_i ≤ A/φ` genuinely IS what holds the sum down. Defaulting
   * them to a post-fix value would make an old build grade like a new one — the
   * direction that costs money.
   */
  fleetRiskFractionEffective?: number;
  /** `Σ E_i` THIS row's engine derived `φ_eff` from. `null` ⇒ its fleet read was unusable. */
  fleetCapitalUsd?: number | null;
  /** WHY this row's `φ_eff` is what it is. Evidence for the ceiling gate below. */
  fleetSizingReason?: LiveOtmFleetSizingReason;
  /**
   * TRA-3911 (AC2) — `atRisk_i`, the premium this book has ALREADY SPENT, as the
   * served `aggregateExposure` row has always published it.
   *
   * ⭐ THIS IS THE OPERAND THE VERDICT WAS MISSING. `Σ B_i` is unspent BUDGET;
   * `Σ atRisk_i` is spent money; the board authorized their SUM. Grading only
   * the first is why one payload served `within` while the fleet could reach
   * $551.67 against a $500 authorization.
   *
   * OPTIONAL for the same reason every field above it is: ABSENCE IS A REAL
   * READING. A row without it is pre-TRA-3897 bytes, where the reachable term
   * cannot be computed at all — and {@link LiveOtmFleetBoundGrade.reachableSumUsd}
   * goes `null` rather than defaulting to a number that would read as "nothing
   * is at risk", which is the fail-open direction.
   */
  openPremiumAtRiskUsd?: number | null;
  /**
   * TRA-3911 (AC2) — the SIGNED headroom `capUsd − openPremiumAtRiskUsd`, as
   * TRA-3897 already publishes it on the same rows.
   *
   * ⚠ THE VERDICT MUST CONSUME **THIS**, NEVER THE CLAMPED `headroomUsd`.
   * `Math.max(0, …)` makes a book over its cap byte-identical to one exactly at
   * it, so the grandfathered excess — the entire $51.68 gap — is invisible to
   * any reader that only has the floored column. It was published and unread.
   *
   * Optional, and RECOMPUTED from `capUsd − openPremiumAtRiskUsd` when absent, so
   * a producer that publishes at-risk but not the signed column still grades
   * correctly. Never defaulted to 0.
   */
  headroomSignedUsd?: number | null;
  /**
   * TRA-3911 (AC1) — `admissible_i` AS THE ORDER SITE RESOLVED IT on this build.
   *
   * ⭐ ABSENCE IS THE DEPLOYED-BYTES PROOF, and it is load-bearing. Rows from a
   * build without the AC1 gate publish no such field, so the grade falls back to
   * `(cap_i − atRisk_i)⁺` — the rule THOSE bytes are running — and its
   * `reachableSumUsd` correctly reads $551.67. Defaulting this to the post-fix
   * value would make an old build grade like a new one, which is the direction
   * that costs money (the TRA-3881/TRA-3903 rule, third application).
   */
  admissibleEntryUsd?: number | null;
  /** TRA-3911 — which operand bound {@link admissibleEntryUsd}. Evidence for `reachableBoundEnforced`. */
  admissibleBoundBy?: LiveOtmAdmissibleBoundBy;
}

/**
 * - `within` — `Σ B_i ≤ A`. The authorization holds.
 * - `rounding_only` — over `A`, but by no more than the φ 4th-place slack
 *   ({@link LIVE_OPTION_TEST_FLEET_RISK_FRACTION_ULP}). The disclosed $0.05,
 *   NOT the defect TRA-3723 is about. Separated so it cannot be spent as
 *   evidence in either direction.
 * - `breach` — `Σ B_i` exceeds `A` by more than that slack. THE FAIL-OPEN.
 * - `blind` — could not be graded (provider unwired, unusable `A`, a non-finite
 *   `capUsd`). Never collapse this into `within`: "checked and fine" and "could
 *   not check" must not share a value.
 */
export type LiveOtmFleetBoundVerdict = 'within' | 'rounding_only' | 'breach' | 'blind';

/** TRA-3723 — the published fleet-bound assertion. */
export interface LiveOtmFleetBoundGrade {
  verdict: LiveOtmFleetBoundVerdict;
  /** Why, in words, for a reader who has only this object. */
  reason: string;
  /** `A`, the board's TRA-3384 fleet authorization as resolved from env. */
  fleetCapUsd: number;
  /** φ as resolved from env. `null` ⇒ unusable, which nulls the capital columns ONLY. */
  fleetRiskFraction: number | null;
  /** How many rows were summed (`liveEntryGateOpen === true`). */
  gateOpenBooks: number;
  /** Every gate-open book, named. */
  books: Array<string | null>;
  /** `Σ B_i` over the gate-open rows. `null` when `blind`. */
  sumBookCapUsd: number | null;
  /** `max(0, Σ B_i − A)`. `null` when `blind`. */
  overageUsd: number | null;
  /** The φ-rounding slack allowed before `overageUsd` counts as a breach. */
  roundingAllowanceUsd: number | null;
  /**
   * `Σ E_i` over gate-open rows with a readable balance.
   *
   * ⚠ TRA-3903 — folded from the rows' own `sizingBasisUsd` (`cash + atRisk`),
   * NOT from `availableCashUsd`. Read {@link fleetCapitalBasis} to see which
   * column a given build actually used before comparing this to anything.
   */
  fleetCapitalUsd: number | null;
  /**
   * TRA-3903 — WHICH COLUMN {@link fleetCapitalUsd} was folded from.
   *
   * - `capital`   — every readable row published `sizingBasisUsd`; `Σ E_i` is
   *                 the same basis the order site sized on. The correct state.
   * - `cash_only` — no readable row published one: pre-TRA-3897 bytes, where
   *                 cash genuinely IS `E_i`. Honest for that build.
   * - `mixed`     — some did, some did not (a fleet mid-deploy).
   *
   * ⭐ PRESENCE of this key is the deployed-bytes proof the TRA-3903 fold
   * shipped; a build without it lacks the key entirely (`hasOwnProperty`).
   */
  fleetCapitalBasis: 'capital' | 'cash_only' | 'mixed';
  /**
   * TRA-3903 — does the ceiling this object publishes actually cover the sum
   * this object is serving? `fleetSizedMaxSumUsd >= sumBookCapUsd`.
   *
   * `null` ⇒ not computable (blind, or no `φ_eff` on these rows). `false` is a
   * SELF-CONTRADICTION and always a defect in this object — never a statement
   * about the fleet: on 2026-08-20 it was `false` while `Σ B_i ≤ A` genuinely
   * held at the order site. It is published rather than folded into `verdict`
   * precisely so a reader can tell "the detector is lying" apart from "the
   * fleet is over", which are different incidents with different remedies.
   */
  sizedCeilingCoversSum: boolean | null;
  /**
   * `A / φ` — the FITTED precondition: the capital above which a bound built on
   * the CONFIGURED φ fails open.
   *
   * ⚠ TRA-3881 — this is `null` whenever that precondition is no longer what
   * holds `Σ B_i` down. It is not a general-purpose disclosure; it is an
   * instrument for one regime, and after TRA-3879 that regime is no longer the
   * normal one. Publishing `A/φ` against a stale φ on a healthy fleet served a
   * −$120.81 headroom beside its own `within` — and a permanent false alarm and
   * a deleted alarm end in the same place. {@link fleetCapitalCeilingBasis}
   * always says which it is; read that before reading these two.
   */
  fleetCapitalCeilingUsd: number | null;
  /** `ceiling − capital`; NEGATIVE means the fitted precondition is already violated. */
  fleetCapitalHeadroomUsd: number | null;
  /**
   * TRA-3881 — WHY the two fields above are published or withheld, in words, for
   * a reader who has only this object. Always a sentence, never `null`: "the
   * field is absent" and "the field is absent FOR A REASON" must not look alike.
   */
  fleetCapitalCeilingBasis: string;
  /**
   * The `fleetSizingReason` the armed rows agree on, or `'mixed'` when they do
   * not. `null` ⇒ the rows predate TRA-3879 and publish no sizing block at all.
   *
   * ⚠ EVIDENCE, NOT THE TEST — the arithmetic below is the test (TRA-3831: a
   * ban-list of reason names is a list of names; an invariant is arithmetic).
   */
  fleetSizingReason: LiveOtmFleetSizingReason | 'mixed' | null;
  /**
   * TRA-3881 — `φ_eff`, the fraction the order site is ACTUALLY sizing on, taken
   * as the LOOSEST (max) value across the armed rows. Loosest, not first or
   * mean: `Σ B_i ≤ φ_eff · Σ E_i` only bounds the sum if it holds for the
   * largest φ_eff any book is using, and a mean would let one book's stale
   * fraction hide behind another's tight one.
   */
  fleetRiskFractionEffective: number | null;
  /**
   * `φ_eff · Σ E_i` — the LARGEST `Σ B_i` the sizing rule now in force can
   * produce at this capital. THIS is the quantity that governs after TRA-3879,
   * and it is the same arithmetic the TRA-3737 reader performs client-side.
   */
  fleetSizedMaxSumUsd: number | null;
  /**
   * `A − fleetSizedMaxSumUsd`. **This one MAY go negative, and a negative here
   * is a real finding**: it means the fraction the books are sizing on does not
   * deliver the authorization — the `fleet_capital_unreadable` fallback, or a
   * fleet read that missed a book. That is the state the detector exists for,
   * so this field is never suppressed.
   */
  fleetSizedHeadroomUsd: number | null;
  /** Gate-open books whose balance was unreadable — they contribute `B_i = 0`. */
  unreadableBalanceBooks: Array<string | null>;
  /**
   * TRA-3911 (AC2) — ⭐ **THE QUANTITY `A` ACTUALLY BOUNDS.** CEO ruling
   * TRA-3703 `4b54935e`: `A` bounds capital REACHABLE, not capital committed.
   *
   *     reachableSumUsd = Σ_i ( atRisk_i + admissible_i )
   *
   * where `admissible_i` is resolved by {@link resolveLiveOtmAdmissibleEntryUsd}
   * UNDER THE RULE THIS BUILD IS ACTUALLY ENFORCING — not under a rule the
   * detector wishes were in force. That distinction is the whole design:
   *
   *   • PRE-TRA-3911 order path (`admissible_i = (cap_i − atRisk_i)⁺`) this
   *     reduces ALGEBRAICALLY to the CEO's own formula —
   *     `Σ (atRisk_i + (cap_i − atRisk_i)⁺) = Σ max(atRisk_i, cap_i)
   *      = Σ cap_i + Σ (atRisk_i − cap_i)⁺ = Σ B_i + Σ (atRisk_i − cap_i)⁺` —
   *     and reproduces the ruled number to the cent: `499.99 + 51.68 = $551.67`.
   *   • POST-TRA-3911 (`admissible_i` also bounded by `A − Σ_j atRisk_j`) it
   *     lands on `358.00 + 0 + 142.00 = $500.00` EXACTLY.
   *
   * ⚠ IT HAD TO BE COMPUTED FROM THE RULE, NOT FROM THE CEO'S CLOSED FORM.
   * `Σ B_i + Σ (atRisk_i − cap_i)⁺` is invariant under the AC1 fix — neither
   * `B_i` nor `cap_i` moves — so a verdict graded on it would publish `breach`
   * FOREVER after the order path was correctly bounded. That is the TRA-3881
   * lesson exactly: a permanent false alarm and a deleted alarm end in the same
   * place. The two forms agree wherever the old rule is what is running, which
   * is what makes this an implementation of the ruling rather than a different
   * number wearing its name.
   *
   * `null` ⇒ at least one gate-open row published no `openPremiumAtRiskUsd`
   * (pre-TRA-3897 bytes). Never 0: "nothing is at risk" is the fail-open
   * reading, and `blind` is what "could not check" is for.
   */
  reachableSumUsd: number | null;
  /**
   * TRA-3911 — `max(0, reachableSumUsd − A)`. **THIS is the overage the board's
   * authorization is about**; {@link overageUsd} is the same arithmetic on
   * `Σ B_i` and is retained only so the two quantities stay separable.
   */
  reachableOverageUsd: number | null;
  /**
   * TRA-3911 — `Σ_i max(0, atRisk_i − cap_i)`: premium sitting ABOVE the book's
   * own cap, which `Σ B_i` omits exactly because a budget cannot go negative.
   *
   * A cap tightening underneath an already-open position GRANDFATHERS the
   * excess — `admin` carried $51.68 of it on 2026-08-20/21 having breached no
   * gate (the entries fit the cap that was in force when they were admitted;
   * `A` then came down on TRA-3827 and φ_eff moved). It is not a violation and
   * it is not closeable by refusing anything; it is simply a term `Σ B_i`
   * cannot see, and it recurs every time φ moves.
   */
  grandfatheredExcessUsd: number | null;
  /** TRA-3911 — `Σ_j atRisk_j` over the gate-open rows. `null` ⇒ unreadable. */
  fleetAtRiskUsd: number | null;
  /**
   * TRA-3911 — `Σ_i admissible_i` under the rule in force. Read beside
   * {@link fleetAtRiskUsd}: the two sum to {@link reachableSumUsd}, so a reader
   * can always see WHICH half moved.
   */
  sumAdmissibleEntryUsd: number | null;
  /**
   * TRA-3911 — is this build's order path enforcing the reachable bound?
   *
   * `true` iff every gate-open row publishes an `admissibleEntryUsd` whose
   * `boundBy` shows the fleet term was CONSIDERED (`fleet_reachable`, `both`, or
   * a `book`/`none` resolved against a readable `Σ_j atRisk_j`). ⭐ Graded on the
   * ROWS, never on ancestry: a deploy order's commit is a lower bound on content,
   * not an expected reading (TRA-3660).
   */
  reachableBoundEnforced: boolean;
}

function blindGrade(reason: string, fleetCapUsd: number): LiveOtmFleetBoundGrade {
  return {
    verdict: 'blind',
    reason,
    fleetCapUsd,
    fleetRiskFraction: null,
    gateOpenBooks: 0,
    books: [],
    sumBookCapUsd: null,
    overageUsd: null,
    roundingAllowanceUsd: null,
    fleetCapitalUsd: null,
    // A blind grade folded nothing, so it cannot claim a capital basis. It
    // reports the pre-TRA-3897 value rather than inventing a fourth state:
    // `sizedCeilingCoversSum: null` beside it already says "not computed".
    fleetCapitalBasis: 'cash_only',
    sizedCeilingCoversSum: null,
    fleetCapitalCeilingUsd: null,
    fleetCapitalHeadroomUsd: null,
    fleetCapitalCeilingBasis:
      'not computed — the grade is blind, so there is no capital column to state a precondition against',
    fleetSizingReason: null,
    fleetRiskFractionEffective: null,
    fleetSizedMaxSumUsd: null,
    fleetSizedHeadroomUsd: null,
    unreadableBalanceBooks: [],
    // TRA-3911 — a blind grade folded no at-risk, so it has no reachable term.
    // `null`, never 0: "the fleet has spent nothing" is the fail-open reading of
    // exactly this field, and `blind` already says "could not check".
    reachableSumUsd: null,
    reachableOverageUsd: null,
    grandfatheredExcessUsd: null,
    fleetAtRiskUsd: null,
    sumAdmissibleEntryUsd: null,
    reachableBoundEnforced: false,
  };
}

/** Cent-round, and normalise `-0` to `0` so a headroom of exactly zero reads as zero. */
function usd(n: number): number {
  return Math.round(n * 100) / 100 + 0;
}

/**
 * Grade the FLEET bound: does `Σ_i B_i` over the armed books still fit the
 * board's authorization `A`?
 *
 * Two columns, deliberately independent (TRA-3421: a validity gate for the
 * SECONDARY reading must not suppress the PRIMARY one):
 *
 *   1. THE VERDICT — summed from `capUsd`, which is what each order site will
 *      actually honour. A book whose balance is dark has `capUsd = 0` and can
 *      spend nothing, so the sum is exact even when the capital column is not.
 *      An unusable φ does NOT blind it.
 *   2. THE CAPITAL COLUMNS — the forward-looking precondition. These go `null`
 *      when they cannot be computed, and that never touches the verdict.
 *
 * ⭐ TRA-3881 — THE SECOND COLUMN IS NOW TWO COLUMNS, because after TRA-3879
 * there are two candidate bounds and only one of them is holding on any given
 * reading:
 *
 *   • `fleetCapitalCeilingUsd` / `fleetCapitalHeadroomUsd` — `A/φ` vs `Σ E_i`,
 *     the FITTED precondition. Published only in the states where it still
 *     governs (`phi_configured`, `fleet_capital_unreadable`, pre-TRA-3879
 *     rows), `null` otherwise, with `fleetCapitalCeilingBasis` always naming
 *     which and why.
 *   • `fleetSizedMaxSumUsd` / `fleetSizedHeadroomUsd` — `φ_eff · Σ E_i` vs `A`,
 *     the bound TRA-3879 actually installed. Always published.
 *
 * The old pair kept firing on a fleet that was fine: `A/φ` against a stale φ
 * served `−$120.81` beside its own `within` all through 2026-08-20. A detector
 * whose supporting columns contradict its verdict gets muted, and a muted
 * detector and no detector are the same object.
 *
 * Fails to `blind`, never to `within`: an unwired provider (`rows == null`), a
 * non-finite / non-positive `A`, or any gate-open row carrying a non-finite
 * `capUsd`.
 */
export function gradeLiveOtmFleetBound(
  rows: readonly LiveOtmFleetBoundRow[] | null | undefined,
  fleetCapUsd: number,
  fleetRiskFraction: number,
): LiveOtmFleetBoundGrade {
  if (!Number.isFinite(fleetCapUsd) || fleetCapUsd <= 0) {
    return blindGrade('fleet authorization A is unusable — cannot grade a sum against it', fleetCapUsd);
  }
  if (!Array.isArray(rows)) {
    return blindGrade('aggregate exposure provider is not wired — no rows to sum', fleetCapUsd);
  }

  const open = rows.filter(r => r?.liveEntryGateOpen === true);
  const books = open.map(r => r.book);
  if (open.some(r => typeof r.capUsd !== 'number' || !Number.isFinite(r.capUsd))) {
    return {
      ...blindGrade('a gate-open book published a non-finite capUsd — the sum is unknowable', fleetCapUsd),
      gateOpenBooks: open.length,
      books,
    };
  }

  const sumCents = open.reduce((acc, r) => acc + cents(r.capUsd), 0);
  const sumBookCapUsd = sumCents / 100;
  const overageUsd = Math.max(0, (sumCents - cents(fleetCapUsd)) / 100);

  // ------------------------------------------------------------------------
  // TRA-3911 (AC2) — THE REACHABLE COLUMN. `Σ B_i` bounds unspent BUDGET; the
  // board authorized `Σ atRisk_i + what can still be added`. Those are two
  // different quantities and this detector served only the first, so a fleet
  // that could reach $551.67 against a $500 authorization read `within`.
  //
  // ⚠ CONSUMES `headroomSignedUsd`, NOT `headroomUsd`. The clamped sibling
  // floors at 0, which makes a book $51.68 OVER its cap byte-identical to one
  // exactly at it — the grandfathered excess is precisely what the floor
  // deletes, and it was published-and-unread the whole time (TRA-3897 shipped
  // the signed column; nothing consumed it).
  //
  // The signed column is RECOMPUTED from `capUsd − openPremiumAtRiskUsd` when a
  // row publishes at-risk but not the signed field, so a producer can supply
  // either. It is never DEFAULTED — a row with no at-risk at all nulls the whole
  // column (see `reachableSumUsd`).
  // ------------------------------------------------------------------------
  const atRiskOf = (r: LiveOtmFleetBoundRow): number | null =>
    typeof r.openPremiumAtRiskUsd === 'number' && Number.isFinite(r.openPremiumAtRiskUsd)
      && r.openPremiumAtRiskUsd >= 0
      ? r.openPremiumAtRiskUsd
      : null;
  const headroomSignedOf = (r: LiveOtmFleetBoundRow, atRisk: number): number =>
    typeof r.headroomSignedUsd === 'number' && Number.isFinite(r.headroomSignedUsd)
      ? r.headroomSignedUsd
      : (cents(r.capUsd) - cents(atRisk)) / 100;

  const atRiskReadable = open.every(r => atRiskOf(r) !== null);
  let reachableSumUsd: number | null = null;
  let reachableOverageUsd: number | null = null;
  let grandfatheredExcessUsd: number | null = null;
  let fleetAtRiskUsd: number | null = null;
  let sumAdmissibleEntryUsd: number | null = null;
  let reachableBoundEnforced = false;

  if (atRiskReadable) {
    const atRiskCents = open.reduce((acc, r) => acc + cents(atRiskOf(r) as number), 0);
    fleetAtRiskUsd = atRiskCents / 100;
    // Σ_i max(0, atRisk_i − cap_i) — the term Σ B_i omits by construction.
    grandfatheredExcessUsd =
      open.reduce((acc, r) => {
        const signed = headroomSignedOf(r, atRiskOf(r) as number);
        return acc + Math.max(0, -cents(signed));
      }, 0) / 100;
    // ⭐ ADMISSIBLE IS TAKEN FROM THE ROW WHEN THE ROW PUBLISHES IT — that is
    // the rule the ORDER SITE is running on these bytes. Absent ⇒ the row is
    // pre-TRA-3911 and its rule is the per-book one, `(cap_i − atRisk_i)⁺`.
    // Grading field PRESENCE rather than assuming the fix is deployed is what
    // makes `reachableSumUsd` read $551.67 on the build that has the defect and
    // $500.00 on the build that does not.
    const admissibleCents = open.reduce((acc, r) => {
      const published =
        typeof r.admissibleEntryUsd === 'number' && Number.isFinite(r.admissibleEntryUsd)
          ? Math.max(0, r.admissibleEntryUsd)
          : null;
      if (published !== null) return acc + cents(published);
      return acc + Math.max(0, cents(headroomSignedOf(r, atRiskOf(r) as number)));
    }, 0);
    sumAdmissibleEntryUsd = admissibleCents / 100;
    reachableSumUsd = (atRiskCents + admissibleCents) / 100;
    reachableOverageUsd = Math.max(0, (atRiskCents + admissibleCents - cents(fleetCapUsd)) / 100);
    reachableBoundEnforced =
      open.length > 0
      && open.every(
        r =>
          typeof r.admissibleEntryUsd === 'number'
          && Number.isFinite(r.admissibleEntryUsd)
          && r.admissibleBoundBy !== undefined
          && r.admissibleBoundBy !== 'fleet_unreadable',
      );
  }

  const phi =
    Number.isFinite(fleetRiskFraction) && fleetRiskFraction > 0 ? fleetRiskFraction : null;
  const readable = open.filter(
    r => typeof r.availableCashUsd === 'number' && Number.isFinite(r.availableCashUsd),
  );
  const unreadableBalanceBooks = open
    .filter(r => typeof r.availableCashUsd !== 'number' || !Number.isFinite(r.availableCashUsd))
    .map(r => r.book);
  // ------------------------------------------------------------------------
  // TRA-3903 — `Σ E_i` FOLDS THE SAME BASIS THE ROWS PUBLISH, NOT CASH.
  //
  // TRA-3897 re-based the PER-BOOK cap on capital (`E_i = cash + atRisk`) and
  // this reduce did not follow, so one `aggregateFleetBound` object served
  // `sumBookCapUsd $499.99` beside `fleetSizedMaxSumUsd $326.66` — a ceiling
  // $173.33 BELOW the sum it is a ceiling ON, published as the fleet's headroom
  // while the true headroom was ONE CENT (measured on `f3718bcee7a6`,
  // 2026-08-20T23:52Z, complete population).
  //
  // ⚠ THE ROWS WERE NEVER WRONG, AND THAT IS THE WHOLE POINT. On the same
  // reading each row published `fleetCapitalUsd 1032.68` and `φ_eff 0.484177 =
  // A/1032.68`, i.e. the ORDER SITE was correctly bounded and `Σ B_i ≤ A` held.
  // Only this column was cash. So this is a DETECTOR defect, not a fail-open —
  // but a detector that contradicts itself gets muted, and a muted detector and
  // no detector are the same object (TRA-3881). The margin it was mis-reporting
  // was $0.01.
  //
  // Falls back to `availableCashUsd` per row, never fleet-wide: on pre-TRA-3897
  // bytes cash IS `E_i`, and a mixed fleet mid-deploy must fold each row on the
  // basis THAT row was sized with rather than picking one rule for both.
  // ------------------------------------------------------------------------
  const rowBasisUsd = (r: LiveOtmFleetBoundRow): number =>
    typeof r.sizingBasisUsd === 'number' && Number.isFinite(r.sizingBasisUsd)
      ? r.sizingBasisUsd
      : (r.availableCashUsd as number);
  const fleetCapitalUsd = readable.reduce((acc, r) => acc + cents(rowBasisUsd(r)), 0) / 100;
  // Which column this fold actually came from. ⭐ ITS PRESENCE IS THE
  // DEPLOYED-BYTES PROOF that the capital fold shipped (TRA-3903 AC5: grade
  // FIELD PRESENCE — ancestry is only a lower bound on content); its VALUE is
  // the proof the fold is right. A build serving `cash_only` over rows that
  // publish `sizingBasisUsd` is the defect, and now says so in one word.
  const basisRows = readable.filter(r => typeof r.sizingBasisUsd === 'number' && Number.isFinite(r.sizingBasisUsd));
  const fleetCapitalBasis: 'capital' | 'cash_only' | 'mixed' =
    readable.length === 0 || basisRows.length === 0
      ? 'cash_only'
      : basisRows.length === readable.length
        ? 'capital'
        : 'mixed';

  // ------------------------------------------------------------------------
  // TRA-3881 — WHICH BOUND IS ACTUALLY HOLDING THE SUM DOWN?
  //
  // `A/φ` and `A − φ_eff·Σ E_i` answer two different questions and only one of
  // them governs on any given reading. Publishing both unconditionally made the
  // detector's supporting columns contradict its own verdict: on 2026-08-20 a
  // healthy post-TRA-3879 fleet served `within` beside `fleetCapitalHeadroomUsd
  // −$120.81`, because `A/φ` describes a precondition TRA-3879 retired.
  //
  // ⚠ The remedy is NOT to recompute the ceiling from `φ_eff`. That pins the
  // headroom to exactly $0.00 whenever the derived branch binds, which is
  // arithmetically true and instrumentally worthless — a field that cannot
  // move is not a reading.
  // ------------------------------------------------------------------------
  const sizingReasons = [...new Set(open.map(r => r.fleetSizingReason ?? null))];
  const publishesSizingBlock = open.some(
    r => typeof r.fleetRiskFractionEffective === 'number' && Number.isFinite(r.fleetRiskFractionEffective),
  );
  const fleetSizingReason: LiveOtmFleetSizingReason | 'mixed' | null =
    !publishesSizingBlock || sizingReasons.length === 0
      ? null
      : sizingReasons.length === 1 && sizingReasons[0] !== null
        ? sizingReasons[0]
        : 'mixed';

  // φ_eff taken at its LOOSEST across the arm: the sum is bounded only if the
  // largest fraction any book is sizing on delivers the bound.
  const phiEffs = open
    .map(r => r.fleetRiskFractionEffective)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  const fleetRiskFractionEffective = phiEffs.length > 0 ? Math.max(...phiEffs) : phi;
  // Σ E_i is taken from THIS route's own capital column, never from a row's
  // self-reported `fleetCapitalUsd`: a fleet read that silently missed a book
  // reports its own coverage honestly-but-wrongly, and the whole point of this
  // number is to catch that. Cross-column, deliberately (TRA-3737 §2 item 2).
  const fleetSizedMaxSumUsd =
    fleetRiskFractionEffective === null ? null : usd(fleetRiskFractionEffective * fleetCapitalUsd);
  const fleetSizedHeadroomUsd =
    fleetSizedMaxSumUsd === null ? null : usd(fleetCapUsd - fleetSizedMaxSumUsd);

  // Does the FITTED precondition still govern? Publish the pair when it does,
  // `null` when it does not — never a stale number. Precedence is deliberate:
  // the states that keep the evidence win over the state that suppresses it.
  const fleetReadUnusable = open.some(
    r =>
      r.fleetSizingReason === 'fleet_capital_unreadable'
      || (r.fleetSizingReason !== undefined
        && (typeof r.fleetCapitalUsd !== 'number' || !Number.isFinite(r.fleetCapitalUsd))),
  );
  // ⭐ THE SUPPRESSION IS ARITHMETIC-GATED, NOT NAME-GATED (TRA-3831/TRA-3737 §2).
  // A row that CLAIMS `phi_fleet_derived` while its φ_eff does not actually
  // deliver `φ_eff · Σ E_i ≤ A` has not installed the new bound, so retiring the
  // old instrument on the strength of the label alone would blind the detector
  // on exactly the reading that needs it. A reason name is a name; a bound is
  // arithmetic. The claim must pay for itself before it buys the suppression.
  const derivedBoundHolds =
    fleetSizedMaxSumUsd !== null && cents(fleetSizedMaxSumUsd) <= cents(fleetCapUsd);
  const allDerived =
    publishesSizingBlock
    && open.length > 0
    && open.every(r => r.fleetSizingReason === 'phi_fleet_derived')
    && derivedBoundHolds;

  let ceilingApplies: boolean;
  let fleetCapitalCeilingBasis: string;
  if (phi === null) {
    ceilingApplies = false;
    fleetCapitalCeilingBasis =
      'withheld — φ is unusable, so A/φ is not computable. This is not a statement about the fleet.';
  } else if (!publishesSizingBlock) {
    // AC2's other half: on pre-TRA-3879 bytes the fitted precondition is the
    // ONLY thing standing between `Σ B_i` and the authorization. Retiring the
    // instrument for that build would delete the TRA-3723 finding itself.
    ceilingApplies = true;
    fleetCapitalCeilingBasis =
      'IN FORCE — these rows publish no TRA-3879 sizing block (pre-TRA-3879 bytes), so Σ B_i is held '
      + 'down by the fitted precondition Σ E_i ≤ A/φ and NOTHING ELSE. A negative headroom here is the '
      + 'TRA-3723 fail-open.';
  } else if (fleetReadUnusable) {
    // AC3. The one state where `Σ B_i` is unbounded again — and therefore the
    // one state where this pair must keep its teeth. Blinding the detector here
    // would be worse than the wrong sign: it removes the evidence too.
    ceilingApplies = true;
    fleetCapitalCeilingBasis =
      'IN FORCE — at least one armed book sized with an UNUSABLE fleet read (fleet_capital_unreadable), '
      + 'so it fell back to the pre-TRA-3879 per-book bound min(φ·E_i, A) and the SUM is bounded only by '
      + 'the fitted precondition again. A negative headroom here is real.';
  } else if (allDerived) {
    // AC1. `φ_eff = A/Σ E_i` binds on every armed book, so `Σ B_i ≤ A` holds at
    // ANY `Σ E_i` the fleet read can see. `A/φ` describes a precondition that
    // no longer governs, and a number that no longer governs is not a caveat —
    // it is a false alarm with a dollar sign in front of it.
    ceilingApplies = false;
    fleetCapitalCeilingBasis =
      'withheld — every armed book is sizing on φ_eff = A/Σ E_i (phi_fleet_derived), so Σ B_i ≤ A holds '
      + 'at ANY fleet capital and the fitted precondition Σ E_i ≤ A/φ no longer governs. Read '
      + 'fleetSizedMaxSumUsd / fleetSizedHeadroomUsd instead — that is the bound in force (TRA-3881).';
  } else if (!derivedBoundHolds) {
    // The rows claim a bound their own arithmetic does not deliver. Nothing
    // structural is holding the sum, so the fitted precondition is the only
    // instrument left and it stays lit.
    ceilingApplies = true;
    fleetCapitalCeilingBasis =
      `IN FORCE — the armed rows publish φ_eff ${fleetRiskFractionEffective ?? 'unreadable'}, but `
      + `φ_eff × Σ E_i $${fleetCapitalUsd.toFixed(2)} = $${fleetSizedMaxSumUsd?.toFixed(2) ?? '?'} `
      + `EXCEEDS A $${fleetCapUsd.toFixed(2)}, so the TRA-3879 bound is NOT delivering and Σ B_i is held `
      + 'by the fitted precondition alone. Read fleetSizedHeadroomUsd — it is negative.';
  } else {
    // φ itself binds on at least one book and nothing is unreadable: the fitted
    // precondition is genuinely what is holding that book's budget down.
    ceilingApplies = true;
    fleetCapitalCeilingBasis =
      `IN FORCE — sizing reason ${fleetSizingReason ?? 'unknown'}: at least one armed book is sizing on `
      + 'the CONFIGURED φ, so the fitted precondition Σ E_i ≤ A/φ is what bounds its budget. A negative '
      + 'headroom here means φ has gone stale against live capital.';
  }

  const fleetCapitalCeilingUsd = ceilingApplies && phi !== null ? usd(fleetCapUsd / phi) : null;
  const fleetCapitalHeadroomUsd =
    fleetCapitalCeilingUsd === null ? null : usd(fleetCapitalCeilingUsd - fleetCapitalUsd);

  // The slack is a property of how precisely φ can be EXPRESSED, so it is
  // measured against the capital that produced the sum — never a flat dollar
  // figure, which would be φ's own mistake one level up.
  const roundingAllowanceUsd =
    Math.round(LIVE_OPTION_TEST_FLEET_RISK_FRACTION_ULP * fleetCapitalUsd * 100) / 100;

  // ------------------------------------------------------------------------
  // TRA-3911 (AC2) — ⭐ THE VERDICT IS GRADED ON **REACHABLE**, NOT ON `Σ B_i`.
  //
  // `A` bounds capital REACHABLE (CEO, TRA-3703 `4b54935e`). Grading `Σ B_i`
  // answered a question nobody authorized: on 2026-08-20/21 it served `within`
  // at `Σ B_i $499.99 ≤ A $500.00` while the fleet could reach $551.67, and the
  // whole $51.67 gap sat in a signed column this function was not reading.
  //
  // `Σ B_i` is NOT retired — `sumBookCapUsd` / `overageUsd` are published
  // unchanged, because the TRA-3879 invariant `Σ B_i ≤ A` is a real and separate
  // guarantee and collapsing the two is how they got confused in the first
  // place. What changed is which one the VERDICT is about.
  //
  // Falls back to the `Σ B_i` grade when the reachable column is unreadable
  // (pre-TRA-3897 rows carry no at-risk), and says so in the reason: that build
  // genuinely cannot compute the reachable term, and `within` on a quantity it
  // CAN compute is more honest than `blind` on the whole object.
  // ------------------------------------------------------------------------
  const gradedOverageUsd = reachableOverageUsd ?? overageUsd;
  const gradedSumUsd = reachableSumUsd ?? sumBookCapUsd;
  const gradedLabel = reachableSumUsd === null ? 'Σ B_i' : 'reachable';
  const reachableSuffix =
    reachableSumUsd === null
      ? ' ⚠ REACHABLE UNREADABLE: no gate-open row published openPremiumAtRiskUsd (pre-TRA-3897 bytes), '
        + 'so this verdict is about Σ B_i — unspent BUDGET — and not about the quantity A bounds (TRA-3911)'
      : ` [reachable = Σ atRisk $${(fleetAtRiskUsd as number).toFixed(2)} + Σ admissible `
        + `$${(sumAdmissibleEntryUsd as number).toFixed(2)}; Σ B_i $${sumBookCapUsd.toFixed(2)}; `
        + `grandfathered excess $${(grandfatheredExcessUsd as number).toFixed(2)}; order path `
        + `${reachableBoundEnforced ? 'ENFORCING' : 'NOT enforcing'} the reachable bound]`;

  let verdict: LiveOtmFleetBoundVerdict;
  let reason: string;
  if (gradedOverageUsd <= 0) {
    verdict = 'within';
    reason =
      `${gradedLabel} $${gradedSumUsd.toFixed(2)} over ${open.length} armed book(s) fits the `
      + `$${fleetCapUsd.toFixed(2)} fleet authorization`
      + reachableSuffix;
  } else if (cents(gradedOverageUsd) <= cents(roundingAllowanceUsd)) {
    verdict = 'rounding_only';
    reason =
      `${gradedLabel} $${gradedSumUsd.toFixed(2)} is $${gradedOverageUsd.toFixed(2)} over the `
      + `$${fleetCapUsd.toFixed(2)} authorization, within the $${roundingAllowanceUsd.toFixed(2)} `
      + `φ 4th-place slack — the disclosed rounding overage, not a capital fail-open`
      + reachableSuffix;
  } else if (reachableSumUsd !== null && overageUsd <= 0) {
    // ⭐ THE CASE THIS TICKET IS ABOUT, AND IT MUST NAME ITSELF. `Σ B_i` fits
    // and the fleet is STILL over — so a remedy aimed at φ, at `A`, or at the
    // per-book cap is aimed at the wrong term. Lowering `A` cannot cure an
    // overshoot that is already BELOW it: the excess is grandfathered under an
    // open position and only closes when that position does.
    verdict = 'breach';
    reason =
      `FLEET FAIL-OPEN (REACHABLE): the fleet can reach $${gradedSumUsd.toFixed(2)} against the `
      + `$${fleetCapUsd.toFixed(2)} authorization — $${gradedOverageUsd.toFixed(2)} over — while `
      + `Σ B_i $${sumBookCapUsd.toFixed(2)} fits it. Σ B_i is UNSPENT BUDGET, not exposure; A bounds `
      + 'capital REACHABLE (CEO ruling TRA-3703 `4b54935e`). '
      + `$${(grandfatheredExcessUsd as number).toFixed(2)} of this is GRANDFATHERED EXCESS — premium `
      + 'above a book\'s own cap because the cap tightened underneath an already-open position, which '
      + 'Σ B_i omits exactly because a budget cannot go negative. '
      + (reachableBoundEnforced
        ? 'The order path IS enforcing min(cap_i − atRisk_i, A − Σ_j atRisk_j), so no NEW entry can '
          + 'widen this; it closes when the open position does — see TRA-3911.'
        : 'The order path is NOT enforcing the reachable bound (rows publish no admissibleEntryUsd) — '
          + 'the next entry can widen this. TRA-3911 AC1 is the fix.')
      + reachableSuffix;
  } else {
    verdict = 'breach';
    // ⚠ TRA-3881 — the diagnosis a breach carries has to name the bound that
    // was ACTUALLY in force, or the remedy it points at is the wrong one. Under
    // the derived branch a breach is NOT "φ is stale" (φ is not what sized it);
    // it is the order site failing to honour a φ_eff the route can see.
    reason =
      `FLEET FAIL-OPEN: Σ B_i $${sumBookCapUsd.toFixed(2)} over ${open.length} armed book(s) `
      + `exceeds the $${fleetCapUsd.toFixed(2)} authorization by $${overageUsd.toFixed(2)}. `
      + (ceilingApplies
        ? `φ ${phi ?? 'unreadable'} is stale against fleet capital $${fleetCapitalUsd.toFixed(2)}; `
          + `the precondition is Σ E_i ≤ $${fleetCapitalCeilingUsd?.toFixed(2) ?? '?'}. `
          + 'min(…, A) is PER BOOK and does not bound this sum — see TRA-3723'
        : `The TRA-3879 bound was sizing (φ_eff ${fleetRiskFractionEffective ?? 'unreadable'} × Σ E_i `
          + `$${fleetCapitalUsd.toFixed(2)} = $${fleetSizedMaxSumUsd?.toFixed(2) ?? '?'} ≤ A), so this `
          + 'sum should not be possible: the order site is NOT honouring the φ_eff this route publishes, '
          + 'or a book sized against a different Σ E_i — see TRA-3881')
      // TRA-3911 — `Σ B_i` being over does not excuse withholding the reachable
      // column: they are different overages with different remedies, and this
      // branch is the ONLY one that would otherwise publish neither.
      + reachableSuffix;
  }

  // ⚠ A pass computed one book short is not a pass over the whole arm. The
  // verdict itself stays honest either way — a dark book has `B_i = 0` and the
  // order site fails closed at `no_balance_snapshot`, so it cannot spend — but
  // COVERAGE and CORRECTNESS are different claims and the reason string must not
  // let a reader collapse them. Measured live on the TRA-3723 deploy itself:
  // seconds after boot, v0nni had no balance yet and the fleet read $555.73
  // `within`, which is 74% of the authorization and looks like plenty of room.
  if (unreadableBalanceBooks.length > 0 && verdict !== 'breach') {
    reason +=
      ` ⚠ PARTIAL: ${unreadableBalanceBooks.length} armed book(s) `
      + `(${unreadableBalanceBooks.map(b => b ?? '<unnamed>').join(', ')}) had no balance `
      + `snapshot and contributed $0 — this verdict covers ${readable.length}/${open.length} `
      + `of the arm, and does not say what the fleet sums to once they read`;
  }

  return {
    verdict,
    reason,
    fleetCapUsd,
    fleetRiskFraction: phi,
    gateOpenBooks: open.length,
    books,
    sumBookCapUsd,
    overageUsd,
    roundingAllowanceUsd,
    fleetCapitalUsd,
    fleetCapitalBasis,
    // Cent-compared, like every other equality in this file: both operands are
    // products of a fraction and a balance, so a bare `>=` flaps at the penny.
    sizedCeilingCoversSum:
      fleetSizedMaxSumUsd === null ? null : cents(fleetSizedMaxSumUsd) >= cents(sumBookCapUsd),
    fleetCapitalCeilingUsd,
    fleetCapitalHeadroomUsd,
    fleetCapitalCeilingBasis,
    fleetSizingReason,
    fleetRiskFractionEffective,
    fleetSizedMaxSumUsd,
    fleetSizedHeadroomUsd,
    unreadableBalanceBooks,
    // TRA-3911 (AC2) — published ALONGSIDE `sumBookCapUsd`, never instead of it.
    // The two quantities were confused precisely because a reader only ever saw
    // one of them; the remedy is that both are on the wire with the identity
    // between them (`reachable = Σ atRisk + Σ admissible`) spelled out in the
    // reason string, not that one replaces the other.
    reachableSumUsd,
    reachableOverageUsd,
    grandfatheredExcessUsd,
    fleetAtRiskUsd,
    sumAdmissibleEntryUsd,
    reachableBoundEnforced,
  };
}

/**
 * Does one more entry of `entryNotionalUsd` fit under the aggregate cap given
 * `openPremiumAtRiskUsd` already at risk? The rule is
 * `openPremiumAtRisk + entryNotional <= capUsd`, **boundary INCLUSIVE** — an
 * entry that lands exactly on the cap is admitted, matching the board's "max
 * $750" (a maximum is attainable).
 *
 * Compared in whole CENTS, because the operands are products of a per-share
 * premium and 100 and neither side is exactly representable in binary: at
 * $468.58-class numbers a plain `<=` rejects sums that are one ULP over a cap
 * they equal to the penny, which would make the boundary case flap.
 *
 * FAILS SAFE — returns `false` (block) on any unusable input: a non-finite or
 * negative at-risk figure, a non-finite / non-positive entry notional, or a
 * non-finite / non-positive cap. An unreadable exposure is not evidence of
 * headroom.
 */
export function fitsLiveOptionTestAggregateCap(
  openPremiumAtRiskUsd: number,
  entryNotionalUsd: number,
  capUsd: number,
): boolean {
  if (!Number.isFinite(openPremiumAtRiskUsd) || openPremiumAtRiskUsd < 0) return false;
  if (!Number.isFinite(entryNotionalUsd) || entryNotionalUsd <= 0) return false;
  if (!Number.isFinite(capUsd) || capUsd <= 0) return false;
  return cents(openPremiumAtRiskUsd) + cents(entryNotionalUsd) <= cents(capUsd);
}

/**
 * Dollars of aggregate headroom left under `capUsd`, floored at 0. Publishing
 * this is the point of the instrument: "cap armed, headroom $600" and "cap
 * armed, headroom $0" are the two states a reader needs to tell apart, and a
 * cap value alone reads identically in both. Non-finite / negative at-risk ⇒
 * `null` (unreadable is not "full headroom").
 *
 * ⚠ STILL FLOORED, ON PURPOSE. TRA-3897 AC2 wanted the true signed value
 * readable; it did NOT want this field's range widened underneath consumers
 * that have only ever seen a non-negative number. The signed figure ships as
 * the SIBLING {@link liveOptionTestAggregateHeadroomSignedUsd} instead, so the
 * disambiguation arrives additively. The floor here remains a real defect
 * surface — it is why `admin` at −$200.57 published `0`, byte-identical to a
 * book exactly at its cap (the TRA-3827 shape, and the 08-17 breach in
 * `canary-ceiling.ts`'s header) — and the sibling is what closes it.
 */
export function liveOptionTestAggregateHeadroomUsd(
  openPremiumAtRiskUsd: number,
  capUsd: number,
): number | null {
  if (!Number.isFinite(openPremiumAtRiskUsd) || openPremiumAtRiskUsd < 0) return null;
  if (!Number.isFinite(capUsd) || capUsd <= 0) return null;
  return Math.max(0, Math.round((capUsd - openPremiumAtRiskUsd) * 100) / 100);
}

/**
 * TRA-3897 (AC2) — the SAME quantity as
 * {@link liveOptionTestAggregateHeadroomUsd}, UNCLAMPED: negative when the book
 * is over its own cap.
 *
 * A clamped metric is a deleted alarm. `Math.max(0, …)` made "exactly full" and
 * "over by $200.57" the same bytes on the route, so no reader could tell a book
 * that had run out of budget from one that had blown through it without
 * re-deriving `cap − atRisk` by hand — and a figure a reader has to re-derive
 * is a figure most readers will not derive.
 *
 * Deliberately a SECOND function rather than a flag on the first: a boolean
 * parameter would let a caller pick the clamped answer by accident, and every
 * caller that wants the clamp already has it by name.
 *
 * `null` on the same unreadable inputs as its sibling — the two must never
 * disagree about whether a reading exists, only about its sign.
 */
export function liveOptionTestAggregateHeadroomSignedUsd(
  openPremiumAtRiskUsd: number,
  capUsd: number,
): number | null {
  if (!Number.isFinite(openPremiumAtRiskUsd) || openPremiumAtRiskUsd < 0) return null;
  if (!Number.isFinite(capUsd) || capUsd <= 0) return null;
  return Math.round((capUsd - openPremiumAtRiskUsd) * 100) / 100;
}

/**
 * The contract count a bounded-test entry should open: the largest integer in
 * `[1, maxContracts]` whose ask notional (`ask * 100 * contracts`) fits `capUsd`.
 * Returns `0` when even ONE contract breaches the cap — the caller must SKIP, never
 * partial-fill or round up.
 */
export function resolveLiveOptionTestContracts(
  askLimit: number,
  capUsd: number,
  maxContracts: number,
): number {
  if (!Number.isFinite(askLimit) || askLimit <= 0) return 0;
  if (!Number.isFinite(capUsd) || capUsd <= 0) return 0;
  const perContract = askLimit * 100;
  const fits = Math.floor(capUsd / perContract);
  if (!Number.isFinite(fits) || fits < 1) return 0;
  return Math.min(fits, Math.max(1, Math.floor(maxContracts)));
}

/**
 * Parse `OPTION_LIVE_TEST_UNTIL` (the bounded-test window end, epoch-ms). Returns
 * the finite positive epoch, or `null` when unset / non-numeric / non-positive.
 * `null` is the FAIL-CLOSED sentinel — the caller treats a null window as CLOSED.
 */
export function parseOptionLiveTestUntil(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[OPTION_LIVE_TEST_UNTIL_VAR];
  if (typeof raw !== 'string') return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * True iff the live-options arm window is currently OPEN: a valid
 * `OPTION_LIVE_TEST_UNTIL` in the future (`now <= until`). FAIL-CLOSED — an unset
 * or malformed window var, or a window whose end has passed, returns false.
 *
 * ⚠️ SCOPE OF THAT GUARANTEE (TRA-2914): fail-closed describes the MECHANISM, not
 * the schedule. It means a lost/garbled window disarms; it does NOT mean the arm
 * lapses soon. The horizon is ops-set and currently a standing one (TRA-2877), so
 * "there is a window" is not by itself a bound on exposure. For the live horizon
 * read `arm.testUntilIso` off /api/health/live-options-fee-slippage.
 */
export function isOptionLiveTestWindowOpen(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): boolean {
  const until = parseOptionLiveTestUntil(env);
  if (until === null) return false; // fail-closed: unset/malformed ⇒ window CLOSED
  return now <= until;
}

/**
 * True iff the live RV single-leg long path is ACTUALLY armed: the
 * `ENABLE_OPTION_LIVE_RV_LONG` boolean is on AND the arm window is open. This is
 * the value the order-decision sites must consult (not the raw flag) so the dated
 * auto-disable holds for RV too (TRA-1929).
 *
 * TRA-4385 — additionally requires {@link isRvEngineEnabled}: with the RV
 * producer dead (engine flag off), an armed live flag is a flag over a path
 * that can never produce an order, and `arm.rvArmed:true` on the health route
 * would be a green reading over a dead producer. The arm now cannot read green
 * unless the engine that feeds it is actually running.
 */
export function isOptionLiveRvLongArmed(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): boolean {
  return isRvEngineEnabled(env) && isOptionLiveRvLongEnabled(env) && isOptionLiveTestWindowOpen(env, now);
}

/**
 * True iff the live OTM single-leg long path is ACTUALLY armed: the
 * `ENABLE_OPTION_LIVE_OTM` boolean is on AND the arm window is open. This is the
 * value the OTM order-decision sites must consult (TRA-1929).
 *
 * ⚠️ This gates the ENTRY site and nothing else — it authorizes `buy_to_open`.
 * Exit management gates on a different predicate entirely (mode/broker-client, see
 * `signal-engine` `liveOptionsMirroring`), so closing the window stops NEW opens
 * and does nothing for positions already open. Do not accept "close the window" as
 * a remedy for an open-position hazard (measured, TRA-2693).
 */
export function isOptionLiveOtmArmed(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): boolean {
  return isOptionLiveOtmEnabled(env) && isOptionLiveTestWindowOpen(env, now);
}

/**
 * True iff the DARK live directional (call/put) single-leg path is ACTUALLY
 * armed: the `ENABLE_OPTION_LIVE_DIRECTIONAL` boolean is on AND the arm window
 * is open. TRA-4288 — before this, the directional order sites consumed the raw
 * flag alone, so the one live sleeve WITHOUT the dated fail-closed window was
 * the one that would have armed with no expiry. All three live consumption
 * sites (gate, method guard, broker-submit re-check) must consult this, never
 * `isOptionLiveDirectionalEnabled`, so the window's fail-closed semantics
 * (unset/malformed/expired `OPTION_LIVE_TEST_UNTIL` ⇒ disarmed) bind the
 * directional sleeve identically to OTM and RV.
 */
export function isOptionLiveDirectionalArmed(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): boolean {
  return isOptionLiveDirectionalEnabled(env) && isOptionLiveTestWindowOpen(env, now);
}

// --------------------------------------------------------------------------
// TRA-2048 (parent TRA-2044 "how to reduce slippage", board-funded fork) —
// promote the two already-built, shadow-only pre-trade gates from OBSERVE to
// ENFORCING on the LIVE options path, each behind its OWN secret-adjacent env
// flag so the flip to real rejection is an OPS action, not a code default.
//
//   • the COST-vs-edge gate (`option-cost-gate.ts` — commission + maker-adjusted
//     spread-cross + safety-margin admission bar). Today it enforces ONLY in demo
//     (`SignalEngine.costAwareGateReject` early-returns on `mode !== 'demo'`); this
//     flag adds a LIVE-mode enforcing branch that rejects a live candidate whose
//     modeled gross R can't clear its structure's cost bar BEFORE the open.
//   • the LIQUIDITY / SPREAD gate (`packages/engine/src/liquidity-gate.ts` —
//     `SPREAD_TOO_WIDE` / thin-book veto). Today it only SHADOW-records post-open
//     (`recordOptionLiquidityShadow`); this flag adds a pre-submit veto at the
//     single audited live-options broker seam (`mirrorLiveOptionOpen`).
//
// TIGHTENING-ONLY and TRA-1897-HOLD-safe: both flags can only ADD rejections
// (reject a bad-spread / over-cost order) — neither can loosen, upsize, or admit
// anything the current path wouldn't already admit. OFF by default ⇒ the live
// options path is byte-for-byte the pre-TRA-2048 shadow behaviour: no rejection,
// same fills. Like the sleeve-arm flags these are SECRET-ADJACENT live toggles
// (they change what real orders do), so they are read from the process env ONLY —
// never from the `demo-flags.json` file override — and are NOT on the demo-flag
// allowlist. Every ARMED evaluation (allowed AND blocked) is recorded durably to
// `live-enforce-gate-ledger.ts` and surfaced at `/api/health/live-enforce-gates`,
// so an armed-but-inert flip cannot read the same as an armed-and-biting one
// (the TRA-1486 / TRA-1682 lesson): `armed:true` with a positive `evaluated` and a
// `blocked` count is the direct proof the gate is firing.
// --------------------------------------------------------------------------

export const OPTION_COST_GATE_LIVE_ENFORCE_FLAG = 'ENABLE_OPTION_COST_GATE_LIVE_ENFORCE';
export const OPTION_LIQUIDITY_LIVE_ENFORCE_FLAG = 'ENABLE_OPTION_LIQUIDITY_LIVE_ENFORCE';

/**
 * True iff the LIVE cost-vs-edge gate is armed to REJECT real option opens
 * (accepts 1/true/yes/on). Default OFF ⇒ live opens are never blocked by the cost
 * bar (the demo-only enforcement is unchanged). Read from the process env only —
 * this is a live-order toggle, never sourced from the demo-flags file override.
 */
export function isOptionCostGateLiveEnforceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTION_COST_GATE_LIVE_ENFORCE_FLAG]);
}

/**
 * True iff the LIVE liquidity/spread gate is armed to VETO real option opens on a
 * pathologically wide / dead book (accepts 1/true/yes/on). Default OFF ⇒ the
 * liquidity gate stays shadow-only on the live path (records, never blocks). Read
 * from the process env only — this is a live-order toggle, never sourced from the
 * demo-flags file override.
 */
export function isOptionLiquidityLiveEnforceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTION_LIQUIDITY_LIVE_ENFORCE_FLAG]);
}

// --------------------------------------------------------------------------
// TRA-2763 (parent TRA-2760, board interaction `257df809` = "file it with
// LeadDev now") — the LIVE arm of the TRA-1407 OTM entry |delta| FLOOR.
//
// The demo floor (`OTM_DELTA_FLOOR_ENABLED` / `OTM_DELTA_FLOOR`,
// exit-risk-rules-flag.ts) is consulted ONLY on the `mode === 'demo'` OTM
// branch, so the live real-money OTM sleeve ran with NO delta floor at all —
// last week's live fills landed at |delta| 0.03-0.07, the measured bleed
// cohort. This flag pair is the live containment, following the exact
// TRA-2048 cost-bar pattern: SECRET-ADJACENT (it changes what real orders
// do), read from the PROCESS env ONLY — never the demo-flags file, and NOT on
// the demo-flag allowlist. TIGHTENING-ONLY (it can only REMOVE live opens,
// never add one — TRA-1897-HOLD-safe) and OFF by default, so merging this
// changes nothing until an operator arms it. Every ARMED live verdict
// (admitted AND rejected) is recorded to `live-enforce-gate-ledger.ts` under
// gate `otm_delta_floor` and surfaced at `/api/health/live-enforce-gates`, so
// an armed-but-inert flip cannot read as armed-and-biting (TRA-1407/TRA-1486
// were both "shipped, believed armed, silently inert").
// --------------------------------------------------------------------------

export const OPTION_OTM_DELTA_FLOOR_LIVE_FLAG = 'ENABLE_OPTION_OTM_DELTA_FLOOR_LIVE';
/** Numeric |delta| floor the LIVE arm enforces (a (0,1) magnitude). */
export const OPTION_OTM_DELTA_FLOOR_LIVE_VALUE_VAR = 'OPTION_OTM_DELTA_FLOOR_LIVE';
/**
 * Malformed/absent-value containment ONLY — not an operational recommendation.
 * QuantTrader picks the real number from the live tape once the cost bar has
 * been armed for a few sessions (TRA-2763); operators MUST set
 * `OPTION_OTM_DELTA_FLOOR_LIVE` explicitly when arming. This default exists so
 * a typo'd value tightens at the long-standing demo default rather than
 * silently disarming the gate (the same fail-direction the demo resolver
 * chose), and the health route exposes the RAW value so the typo is visible.
 */
export const OPTION_OTM_DELTA_FLOOR_LIVE_DEFAULT = 0.4;

/**
 * True iff the LIVE OTM entry delta floor is armed to REJECT real option opens
 * below the resolved |delta| floor (accepts 1/true/yes/on). Default OFF ⇒ the
 * live OTM entry path is byte-for-byte unchanged (no floor, exactly the
 * pre-TRA-2763 behaviour). Read from the process env only — this is a
 * live-order toggle, never sourced from the demo-flags file override.
 */
export function isOptionOtmDeltaFloorLiveEnforceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTION_OTM_DELTA_FLOOR_LIVE_FLAG]);
}

/**
 * Resolve the LIVE |delta| floor. Reads `OPTION_OTM_DELTA_FLOOR_LIVE`; a
 * missing, malformed or out-of-range value (≤0 or ≥1 — a delta magnitude) falls
 * back to {@link OPTION_OTM_DELTA_FLOOR_LIVE_DEFAULT} rather than silently
 * disabling an armed gate. Deliberately does NOT read the demo `OTM_DELTA_FLOOR`
 * env var: the live number is chosen from the live tape, not inherited.
 */
export function resolveOptionOtmDeltaFloorLive(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[OPTION_OTM_DELTA_FLOOR_LIVE_VALUE_VAR];
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 1) return parsed;
  }
  return OPTION_OTM_DELTA_FLOOR_LIVE_DEFAULT;
}
