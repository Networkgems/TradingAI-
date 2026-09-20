// TRA-2048 (parent TRA-2044) — DURABLE enforcement telemetry for the two LIVE
// pre-trade gates promoted from shadow to ENFORCING (the cost-vs-edge bar and the
// liquidity / spread veto).
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The CTO's assignment was explicit: "Do not silently enforce with no counter."
// A working admission gate's evidence is the trades that DIDN'T happen, so a live
// flip that rejects real orders is invisible from the fill tape alone — the exact
// trap that cost two demo sessions on the TRA-1476 quality gate (armed-but-inert,
// TRA-1486) and that the sibling cost-aware-gate ledger already guards for demo.
// This module makes the LIVE enforcement deterministic in one read:
//   • how many ARMED live evaluations each gate saw (allowed AND blocked), so an
//     armed-but-inert flip (`evaluated:0`) never reads the same as an armed gate
//     that saw candidates and passed them all (`evaluated>0, blocked:0`) or one
//     that is biting (`blocked>0`);
//   • split by gate (`cost_bar` / `spread`) and by scope (structure / symbol);
//   • whether any of it is actually ON DISK (the TRA-1681 durability caveat).
//
// The cost-aware-gate ledger is DELIBERATELY not reused: its header contract is
// that it is "structurally incapable of describing a live open," and graders read
// `/api/health/cost-aware-gate` as demo-only. Live enforcement records land here,
// on a separate axis and a separate `/api/health/live-enforce-gates` route.
//
// ── DURABILITY (TRA-1681 / TRA-1719) ─────────────────────────────────────────
// JSONL-appended under DATA_DIR, keyed by ET calendar day, rebuilt on boot. "A
// persisted file survives a reboot" is TRUE only if DATA_DIR points at a mounted
// persistent disk; with DATA_DIR unset the fallback path is inside the build
// bundle and evaporates on redeploy with NO error to catch. `durability.ephemeral`
// (a property of the PATH, decisive on the first boot before a row exists) is
// published and MUST be read first.
//
// ── SCOPE / INVARIANT ────────────────────────────────────────────────────────
// Observe-through accounting. NEVER places an order or mutates an account — it is
// a write-through of an enforcement decision the engine already made. Records are
// written ONLY from the engine's LIVE enforcing branches, which themselves bail
// unless the corresponding `ENABLE_OPTION_*_LIVE_ENFORCE` flag is armed — so every
// row reflects an ARMED LIVE evaluation. No balances / PII — gate, scope, ET day,
// and whether the order was blocked.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { isEphemeralDataDir } from './data-dir.js';
import {
  DEFAULT_NET_EDGE_BAR_CONFIG,
  NET_EDGE_SHADOW_K_SWEEP,
  netEdgeShadowAdmits,
  type NetEdgeShadowSample,
} from './option-net-edge-bar.js';
import type { LiveEnforceGatePredicate } from './live-enforce-gate-predicate.js';
import type { AdmissibleSelection } from './otm-admissible-strike.js';
import {
  OPTION_LIVE_OTM_UNIVERSE_DEFAULT,
  type LiveOtmRatifiedSetCounterfactual,
} from './otm-live-universe-flag.js';
import { logger } from './observability/index.js';
// TRA-4748 — the derived session-coverage block. Lives in its own module so the
// calendar comparison (and its one-directional rule) is unit-testable as a pure
// function, without stuffing the ledger store to construct each case.
import {
  foldSessionCoverage,
  type LiveEnforceSessionCoverage,
} from './live-enforce-gate-session-coverage.js';

const log = logger.child({ module: 'live-enforce-gate-ledger' });

export const LIVE_ENFORCE_GATE_LOG_FILENAME = 'live-enforce-gate.jsonl';

/**
 * Retain this many ms of decisions on disk (compacted on boot). A month covers
 * reading enforcement back well after a bounded live window closes while bounding
 * a file that takes one line per armed live evaluation.
 */
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Which live gate produced the record. `cost_bar` is the TRA-1602 modeled-gross-R
 * admission bar promoted to live enforcement; `spread` is the TRA-1967 liquidity /
 * spread veto (`SPREAD_TOO_WIDE` / thin-book / unusable-quote) enforced at the
 * live-options broker seam; `otm_delta_floor` is the TRA-2763 live arm of the
 * TRA-1407 OTM entry |delta| floor (the demo-only guard that left real money
 * running unfiltered at |delta| 0.03-0.07); `universe` is the TRA-3216 live OTM
 * underlying allowlist (the scan universe was the full ~614-name watchlist, so
 * real money opened on KVYO / TROW / ABCL because nothing restricted it).
 *
 * TRA-3394 adds the two CEILING axes. `entry_delta_ceiling` is the live arm of
 * the TRA-3392 upper band edge — the cut the cost bar is algebraically incapable
 * of making, since it is a floor. `entry_delta_ceiling_shadow` is the SAME
 * verdict recorded while the gate is dark: `blocked` there means WOULD HAVE
 * BLOCKED, and no live open was stopped. They are separate gates rather than one
 * gate with a mode field because a counter must report what the engine actually
 * did, not what the config intended (TRA-1682) — folding a shadow "block" into
 * the enforcing gate's `blocked` would claim a trade was prevented when it fired.
 *
 * TRA-3445 adds `aggregate_cap` — the board's "max $750 TOTAL" bound on the live
 * bounded-test sleeve, which until now had no enforcement path at all (every
 * other guard bounds a SINGLE entry). It is its own gate rather than a reason
 * code on an existing one for the usual reason: only a gate carries an
 * `evaluated` denominator, and "the cap never had to bite" (`evaluated > 0,
 * blocked: 0`) must not read the same as "the cap is inert" (`evaluated: 0`).
 */
export type LiveEnforceGate =
  | 'cost_bar'
  | 'spread'
  | 'otm_delta_floor'
  | 'universe'
  | 'entry_delta_ceiling'
  | 'entry_delta_ceiling_shadow'
  | 'aggregate_cap'
  | 'canary_ceiling'
  /**
   * TRA-3911 — the FLEET bound `Σ_j atRisk_j + entry ≤ A`. Its own gate rather
   * than a reason code on `aggregate_cap` for the same reason `aggregate_cap` is
   * its own gate: only a gate carries an `evaluated` denominator, and this one
   * has a THIRD state the others do not — `boundBy: 'fleet_unreadable'`, where
   * the fleet read degraded and the SUM is unbounded again. That state is an
   * ADMIT, so without its own `evaluated` column a day on which the fleet bound
   * was never actually in force is indistinguishable after the fact from a day
   * on which it simply never bit.
   *
   * Also: the two refusals have different remedies. `aggregate_cap` says "this
   * book is full"; this says "the FLEET is at its authorization", which nothing
   * this book does can change.
   */
  | 'fleet_reachable_bound'
  /**
   * TRA-3942 (parent TRA-3927, board card `a29b2db8`) — the ENTRY-TIME window on
   * the `single_leg_otm` sleeve: new buys only inside 10:15–11:30 ET and
   * 15:00–15:45 ET. Its own gate because it is the only cut here that is a
   * property of the CLOCK rather than of the candidate — an operator reading
   * `blocked` on this axis learns "the sleeve was awake at the wrong time",
   * which no threshold change can fix and no other axis can express.
   *
   * Recorded on BOTH verdicts. The admits are what supply the denominator that
   * separates "the window never bit" from "the gate was never wired in".
   */
  | 'entry_window'
  /**
   * TRA-3944 (parent TRA-3927, board card `a29b2db8`) — the CONTRACT FLOOR on
   * the `single_leg_otm` sleeve: premium ≥ $0.50, |Δ| ∈ [0.25, 0.40], DTE ∈
   * [21, 45] (hard-refuse ≤ 7), max 2 contracts / 1 open row per underlying.
   * Its own gate because it is the first cut that is a property of the CHAIN
   * rather than of one nominee: it runs over every candidate BEFORE the
   * selector, so a refusal here says "nothing on this chain is buyable under
   * the floor", which no per-nominee axis can express. `reasonCode` is one of
   * `contract_floor_premium` / `_delta` / `_dte` / `_size` (rule 6).
   *
   * Recorded on BOTH verdicts, same reason as `entry_window`.
   */
  | 'contract_floor'
  /**
   * TRA-4144 (parent TRA-3703, axis 4) — the UNDERLYING ASSET CLASS of the
   * candidate, at the entry site. The second NAME-axis gate (beside
   * `universe`) and the only one that keys on what the name IS rather than
   * whether it is listed: the 08-25 $128 ETHA call passed every gate on this
   * roster correctly, because "crypto OFF" was scoped on the crypto MODULE and
   * a spot-ether ETF arrives as an equity option. A control scoped on a venue
   * is blind to the same exposure arriving through a wrapper.
   *
   * Recorded on BOTH verdicts whenever the live path evaluates a candidate —
   * including while the refusal flag is OFF (`blocked` is then always false),
   * because the census question "what classes reach the entry site" must be
   * answerable BEFORE the board arms the refusal, not only after.
   * `reasonCode` on blocks is `asset_class_<class>`.
   */
  | 'underlying_asset_class'
  /**
   * TRA-4276 (parent TRA-4217) — the ENTRY↔EXIT interlock on the
   * `single_leg_otm` sleeve: a live entry into a book whose OWN close path is
   * currently non-actionable is refused. Its own gate because it is the only
   * cut on this roster keyed on the EXIT side of the book — on 09-01 the
   * sleeve admitted $150 while `liveStopActionability` read 3/0/0/3
   * (`close_reject_breaker: 3`) on the same process, and no capital axis can
   * express that refusal. `reasonCode` on blocks is `exit_path_latched`
   * (this book's breached rows have nothing acting on them) or
   * `exit_instrument_blind` (the exit read threw — fail closed, AC3).
   *
   * Recorded on BOTH verdicts: the admits are the AC2 denominator that tells
   * "no entry was attempted" apart from "attempted and refused for exit-path
   * reasons" — the exact distinction the parent's Defect 1 (a refusal
   * upstream of a counter is invisible to that counter) says must not be
   * re-committed here.
   */
  | 'exit_actionability'
  /**
   * TRA-4422 (parent TRA-4421, off the TRA-4412 swing-OTM spec) — the SETUP
   * TAXONOMY on the `single_leg_otm` sleeve: does the UNDERLYING have a
   * multi-day directional setup on the same side as the wing the mispricing
   * nominator picked.
   *
   * The first gate on this roster that is a property of the UNDERLYING rather
   * than of the contract, the chain, the clock, the book or the fleet. Every
   * one of the other 18 cuts on the OTM sweep body vetoes the CONTRACT; none
   * asks anything about the stock. Since the nominator ranks on
   * `|mispricingPct|` over a long-only sleeve, the option's SIDE is currently
   * chosen by whichever wing happens to be cheap.
   *
   * Its own gate, not a reason code on `contract_floor`, for the reason every
   * neighbour here is its own gate: ONLY A GATE CARRIES AN `evaluated`
   * DENOMINATOR. And this gate needs one more than most, because arming it is a
   * RESTRICTION — `opensPlaced` falls whether the taxonomy works or is broken
   * and confirming nothing, so a working gate and a dead one read identically
   * on every other metric the sleeve publishes.
   *
   * SHIPPED IN OBSERVE, WITH ZERO SETUPS REGISTERED (`OTM_SETUP_TAXONOMY_MODE`
   * defaults to `observe`; `SETUP_TAXONOMY_REGISTRY` is empty). So on arrival
   * `blocked` is ALWAYS false and the only thing this gate measures is the
   * reason-code histogram over live nominees — in particular how many arrive
   * with a series deep enough to run a setup on at all. That precondition has
   * never been measured on this path.
   *
   * Recorded on BOTH verdicts, and while dark, for the same reason
   * `underlying_asset_class` is: the census question "what would the taxonomy
   * have said" must be answerable BEFORE the board arms the refusal, not only
   * after. `reasonCode` is one of `no_setup_matched` / `setup_side_conflict` /
   * `awaiting_confirmation` / `confirmation_expired` / `series_unreadable`,
   * where the last is SPLIT OUT because an unreadable input is a runtime defect
   * that happens to fail closed, and folding it into the ordinary refusal hides
   * a broken box inside a bucket that is supposed to be large.
   */
  | 'setup_confirmation';

/** One durable ARMED-LIVE enforcement decision — a write-through of the verdict. */
export interface LiveEnforceRecord {
  /** Decision time, ms epoch. */
  ts: number;
  /** ET calendar day (America/New_York, YYYY-MM-DD) — the key the health view rolls on. */
  etDay: string;
  /** Which gate ruled. */
  gate: LiveEnforceGate;
  /**
   * For `cost_bar`, the structure (single_leg_rv / single_leg_otm / directional);
   * for `spread` and `universe`, the underlying symbol.
   *
   * TRA-4631 — on `cost_bar` this IS the call-site stamp. The structure literal
   * is passed by the caller and each caller passes a distinct one, so the
   * mapping is 1:1 with the source sites in `signal-engine.ts`:
   *   • `single_leg_otm`  — `runOtmScan` → `costAwareGateReject('single_leg_otm', …)`.
   *     THE LIVE ENTRY SITE: the only caller that traverses `entry_window`
   *     (`otmEntryWindowRejectReason` is consulted nowhere else).
   *   • `single_leg_rv`   — `runRelativeValueScan` → `costAwareGateReject('single_leg_rv', …)`.
   *     Bypasses `entry_window` entirely — this is the caller whose 425 rows on
   *     2026-09-09/09-10 (days `entry_window` blocked 100%) made the pooled
   *     per-day counter unreadable as an entry-site denominator.
   *   • `directional`     — the directional sleeve's `costAwareGateReject('directional', …)`.
   * The field has been REQUIRED since the ledger's birth (the hydrate drops a
   * scope-less row), so every retained row is attributable; the TRA-4631 defect
   * was that the per-day roll did not PUBLISH this axis — see
   * {@link LiveEnforceGateDaySummary.byScope}.
   */
  scope: string;
  /** TRUE ⇒ the order was BLOCKED (rejected). FALSE ⇒ evaluated and allowed to proceed. */
  blocked: boolean;
  /** Human-readable rejection reason (present only when blocked). */
  reason?: string;
  /**
   * TRA-3216 — LOW-CARDINALITY classification of the block, present only when
   * blocked. `reason` above is per-candidate prose (it embeds the candidate's own
   * numbers), so folding on it yields one bucket per decision and answers
   * nothing. This is the tuneable axis: for `cost_bar` it says how far under the
   * bar the candidate fell, which is what turns "99.15% blocked" into "N of them
   * were within 0.10R of admission".
   */
  reasonCode?: string;
  /**
   * TRA-3216 — WHICH LIVE BOOK this verdict governed (the `alertUsername` the
   * options journal stamps as `account`, so this joins to the journal and to the
   * TRA-3117 per-book census without a translation table). A process-level flag
   * reads identically for a book it does not govern; this field is what makes the
   * fleet claim checkable. Absent ⇒ the call site could not attribute the book,
   * which folds to an explicit `unattributed` key rather than disappearing.
   */
  book?: string;
  /**
   * TRA-3391 — for `cost_bar`, WHICH tape cell (`structure::|delta| bucket`) the
   * verdict was decided under. The edge is no longer a per-candidate formula but
   * a lookup into a measured table, so "why did this block" is only answerable
   * with the cell identity: `insufficient_evidence` on `single_leg_otm::0.45-0.50`
   * and on `::0.00-0.10` are different facts about the book.
   *
   * Stamped on ADMITS too (unlike `reasonCode`) — the admitted cells are exactly
   * the ones a grader needs to check against the published table.
   *
   * Absent ⇒ the verdict predates this field or the gate does not use cells; that
   * folds to no `byCell` row at all rather than to a synthetic bucket, because
   * "never stamped" is not a cell.
   */
  cell?: string;
  /**
   * TRA-3483 — the NUMERATOR of the net-edge comparison, recorded on EVERY
   * `cost_bar` verdict including admits, whichever form actually decided.
   *
   * `k` is defined by `admit ⟺ costR ≤ k · modeledGrossR`, and every row inside a
   * cell shares the same `modeledGrossR` (the cell's lower CI bound), so `costR`
   * is the ONLY axis `k` can discriminate on. Until this field existed, `k` was
   * unidentifiable from any deployed instrument no matter how clean the tape.
   *
   * ABSENT ⇒ the quote was unusable at decision time (the net-edge form's
   * fail-closed case) or the row predates this field. Both are published as a
   * MISSING sample, never as a zero — see `costRQuantiles.rowsMissingCostR`.
   */
  cost?: {
    /** costPerShare / riskPerShare, in the same `R_gate` unit as `barR`. */
    costR: number;
    /** The spread-cross term alone (0.235 of the 0.285 modeled bar — 82%). */
    spreadR: number;
    /** The commission/fee term alone. `spreadR + feeR === costR`. */
    feeR: number;
    /** costPerShare / mark — what the k-INDEPENDENT absolute ceiling tests. */
    costFracOfPremium: number;
  };
  /**
   * TRA-3483 — the DENOMINATOR at decision time (`tapeEdgeR`: the cell's lower 95%
   * CI bound). Recorded per row rather than joined from the expectancy table after
   * the fact, because that table is re-folded continuously and a later read would
   * answer a different question than the one the verdict was made under.
   *
   * Absent ⇒ the edge was unknown (unfolded tape / underpowered cell / no bucket),
   * which fails closed at every `k`.
   */
  grossR?: number;
  /**
   * TRA-4745 — the UNDERLYING this verdict ruled on.
   *
   * NOT redundant with {@link scope}: on `cost_bar` the scope key is the
   * STRUCTURE (`single_leg_otm` / `single_leg_rv` / `directional`), so before
   * this field a `cost_bar` outcome could not be joined to a symbol at ALL —
   * `byGate[cost_bar].bySymbol` read `null` while `byGate[universe].bySymbol`
   * carried 372 names, and the "is the live universe simply illiquid?"
   * hypothesis could only be refuted indirectly. On `spread`/`universe` the
   * scope key IS the symbol and this field duplicates it, which is harmless and
   * keeps one axis rather than two.
   *
   * Absent ⇒ the call site did not stamp it or the row predates this field. That
   * is published as `costRowsMissingSymbol`, never as an absent symbol row —
   * every row hydrated from before this deploy lacks it, so an empty
   * `costBySymbol` must not read as "no candidates".
   */
  symbol?: string;
  /**
   * TRA-4745 — the REALISED COMPARISON: left side, operator, right side, outcome,
   * exactly as the gate evaluated it. Recorded on EVERY `cost_bar` verdict,
   * admits included.
   *
   * ⭐ THE FIELD TO GRADE on this gate. `byReason` publishes `shortfall_lt_0.10`
   * / `shortfall_0.25_0.50` / `shortfall_gte_0.50` **without saying shortfall of
   * WHAT against WHAT**, and the payload's only other numbers were the bar and
   * the `costR` distribution — so the obvious reading (costR vs barR) is wrong,
   * unstated, and was corroborated by one cell out of four. The shortfall is
   * `barR − grossR`; `costR` is a recorder that the deployed flat form never
   * consults. Read `compared` first: `false` ⇒ the row refused on a precondition
   * and no inequality ran at all.
   *
   * Absent ⇒ a non-`cost_bar` gate or a row predating this field, published as
   * `predicateUnstamped`.
   */
  predicate?: LiveEnforceGatePredicate;
  /**
   * TRA-3674 — for `aggregate_cap`, the THREE TERMS the per-book budget
   * `B_i = min(φ · availableCash, A)` was resolved from, recorded on EVERY
   * verdict including admits.
   *
   * The budget stopped being a process constant the reader could look up: it is
   * now a function of a per-book balance that moves intra-session and of a
   * process scalar ops can re-point. Without these terms a block is
   * UNATTRIBUTABLE — "over budget" reads byte-identically for
   *
   *   • a genuinely full book,
   *   • a φ that mis-resolved to the compiled default when ops meant to move it,
   *   • a stale/absent balance snapshot that collapsed the budget toward 0,
   *
   * and those are three different incidents with three different remedies. A
   * guard whose rejects cannot be told apart is the TRA-3216 shape.
   *
   * Absent ⇒ a non-`aggregate_cap` gate, or a row predating this field; that is
   * a MISSING stamp, never a zero budget.
   */
  budget?: {
    /** The resolved per-book budget `B_i` actually compared against, USD. */
    capUsd: number;
    /** `A` — the fleet authorization the per-book budget was clamped to, USD. */
    fleetCapUsd: number;
    /** φ as resolved from env at decision time (compiled default if unset/malformed). */
    fleetRiskFraction: number;
    /** `min(optionBuyingPower, totalCash, totalEquity)` for this book at decision time, USD. */
    availableCashUsd: number;
    /**
     * TRA-3879 — `φ_eff = min(φ, A / Σ E_i)`, the fraction the budget was
     * ACTUALLY sized on. Equal to `fleetRiskFraction` while φ binds; below it
     * once φ is stale against live fleet capital.
     */
    fleetRiskFractionEffective?: number;
    /** `Σ E_i` the derivation used. `null` ⇒ the fleet read was unusable. */
    fleetCapitalUsd?: number | null;
    /** How many books that sum covered (this one included). */
    fleetCapitalBooks?: number;
    /**
     * WHY the φ in force is what it is. ⭐ THE FIELD TO GRADE: its PRESENCE is
     * the deployed-bytes proof that the fleet bound shipped, and the value
     * `fleet_capital_unreadable` is the single state in which `Σ B_i` is
     * unbounded again. Absent ⇒ a row written before TRA-3879, i.e. a row from
     * a build with a PER-BOOK bound only — never read it as "it bound".
     */
    fleetSizingReason?: 'phi_configured' | 'phi_fleet_derived' | 'fleet_capital_unreadable';
    /**
     * TRA-3911 — `max(0, min(capUsd − atRisk_i, A − Σ_j atRisk_j))`: the premium
     * the `fleet_reachable_bound` gate actually admitted against.
     */
    admissibleUsd?: number;
    /**
     * TRA-3911 — ⭐ THE FIELD TO GRADE on this gate, for exactly the reason
     * `fleetSizingReason` is the one to grade on `aggregate_cap`: its PRESENCE
     * is the deployed-bytes proof the reachable bound shipped, and the value
     * `fleet_unreadable` is the single state in which the fleet term is NOT in
     * force and `Σ atRisk` is unbounded again. Absent ⇒ a row from a build with
     * the per-book bound only — never read it as "it bound".
     */
    admissibleBoundBy?: 'book' | 'fleet_reachable' | 'both' | 'fleet_unreadable' | 'none';
    /** TRA-3911 — `capUsd − atRisk_i`, SIGNED. Negative ⇒ already over this book's own cap. */
    bookHeadroomSignedUsd?: number;
    /** TRA-3911 — `A − Σ_j atRisk_j`, SIGNED. `null` ⇒ the fleet at-risk fold was unusable. */
    fleetHeadroomSignedUsd?: number | null;
    /** TRA-3911 — `Σ_j atRisk_j` at decision time. `null` ⇒ unreadable. */
    fleetAtRiskUsd?: number | null;
    /** TRA-3911 — how many gate-open books that fold covered (this one included). */
    fleetAtRiskBooks?: number;
  };
  /**
   * TRA-3510 — WHICH NOMINATOR BRANCH produced the candidate this verdict ruled
   * on (TRA-3401's `selectAdmissibleOtmCandidate`).
   *
   * This is the axis that makes a ZERO on the delta gates readable. The selector
   * runs UPSTREAM of every gate here, and on its `in_band` branch the nominee's
   * `|Δ|` is inside `[min, max)` BY CONSTRUCTION — so it cannot breach a ceiling
   * at the band's own `max`, nor a floor at or below its `min`. Without this
   * field, `entry_delta_ceiling_shadow.blocked === 0` has two byte-identical
   * causes:
   *
   *   • the selector clamped every row into the band (a vacuous zero), and
   *   • the far tail was nominated and genuinely did not breach (a real zero).
   *
   * `cheapConsidered` / `cheapInBand` are the CHAIN SHAPE behind the branch: a
   * `fallback_top_mispricing` row with `cheapInBand: 0` says the chain offered no
   * admissible strike, which is a different fact about the book than a chain that
   * offered one and lost it downstream.
   *
   * Absent ⇒ the verdict did not come from the OTM nominator (RV / directional
   * cost-bar rows) or predates this field. That folds to no `bySelection` row
   * rather than to a synthetic bucket — "never stamped" is not a branch.
   */
  nominator?: LiveEnforceNominator;
  /**
   * TRA-4269 — the RATIFIED-SET COUNTERFACTUAL, on `universe` rows only.
   *
   * With `OPTION_LIVE_OTM_UNIVERSE=*` every name is admitted, so `blocked` is
   * `false` on every row and cannot say which of those admits the allowlist
   * would have refused. This field can. It is stamped on EVERY unrestricted row,
   * `true` and `false` alike. If only the would-block rows were stamped, an
   * in-set admit and a row from before this field would be the same bytes.
   *
   * Absent ⇒ the gate was RESTRICTED when the row was recorded (its `blocked`
   * already is the verdict under the list in force), a non-`universe` gate, or
   * a row from before TRA-4269.
   */
  wouldBlockUnderRatifiedSet?: boolean;
  /**
   * TRA-4269 — the set `wouldBlockUnderRatifiedSet` was taken against,
   * comma-joined (`AAPL,SPY,QQQ,PLTR,TSLA`). Present iff that field is. Carried
   * per row so a later change to `OPTION_LIVE_OTM_UNIVERSE_DEFAULT` cannot
   * silently redefine what the retained rows measured.
   */
  ratifiedSet?: string;
}

/** TRA-3510 — the nominator branch + chain shape carried on an OTM verdict. */
export interface LiveEnforceNominator {
  /** `in_band` | `in_band_fair` | `fallback_top_mispricing` (persisted pre-TRA-3856 rows only) | `legacy` | `none`. */
  selection: AdmissibleSelection;
  /** How many `cheap` candidates the scanned chain offered. */
  cheapConsidered: number;
  /** How many of those landed inside the armed band (0 when the selector is dark). */
  cheapInBand: number;
  /**
   * TRA-3619 — every candidate the scanner offered the selector, BEFORE the
   * cheapness screen (post-liquidity; see `AdmissibleStrikeResult`).
   *
   * OPTIONAL, and it stays optional forever: rows written before this field
   * existed carry the nominator block without it, and demanding it in
   * {@link usableNominator} would silently drop every one of them from the
   * `bySelection` axis — turning a field addition into a retroactive data loss.
   * The pair below therefore folds on its OWN denominator (`rowsWithStrikeShape`).
   */
  strikesConsidered?: number;
  /**
   * TRA-3619 — of those, how many sat inside the armed band. This is the field
   * that separates "the band is empty in the chain" (0) from "the cheapness
   * screen emptied it" (≥1 while `cheapInBand` is 0). 0 on the dark `legacy`
   * branch, where the band is never consulted.
   */
  strikesInBand?: number;
}

/**
 * The selection values a persisted row may carry. Anything else is dropped on
 * hydrate — so this list being SHORT is the failure mode (TRA-3839's shape: a
 * hand-written key list ships the next value ABSENT). The `Record` makes the
 * compiler refuse a union member this list is missing. `fallback_top_mispricing`
 * stays: no new row can carry it (TRA-3856 replaced the fallback with an
 * abstention), but rows persisted before that deploy do.
 */
const SELECTION_SET: Record<AdmissibleSelection, true> = {
  in_band: true,
  in_band_fair: true,
  fallback_top_mispricing: true,
  abstain_no_in_band: true,
  legacy: true,
  none: true,
};
const SELECTIONS: readonly AdmissibleSelection[] =
  Object.keys(SELECTION_SET) as AdmissibleSelection[];

/**
 * TRA-3483 — one recorded decision's ingredients for the counterfactual sweep.
 * Retained per gate-day alongside the counters; `cost_bar` is the only gate that
 * produces them.
 */
interface CostSample extends NetEdgeShadowSample {
  spreadR: number;
  feeR: number;
  /** What the DEPLOYED form actually did — the `flatFormAdmits` baseline. */
  blocked: boolean;
  /** The cell this verdict was decided under, for the per-cell quantile fold. */
  cell: string | null;
  /** TRA-4745 — the ET day, so the per-cell predicate sample can be one PER DAY after pooling. */
  etDay: string;
  /** TRA-4745 — the underlying, for the `costBySymbol` join. Null on pre-field rows. */
  symbol: string | null;
  /** TRA-4745 — the block classification, carried onto the predicate sample. Null on admits. */
  reasonCode: string | null;
  /** TRA-4745 — the realised comparison. Null on pre-field rows. */
  predicate: LiveEnforceGatePredicate | null;
}

/**
 * Hard cap on retained samples per gate-day. The observed live rate is ~300
 * decisions/day, so this is a runaway backstop, not a working limit — but it is a
 * COUNTED cap: `costRQuantiles.samplesDropped > 0` says the quantiles are over a
 * truncated head and must not be read as the day's distribution.
 */
const MAX_COST_SAMPLES_PER_GATE_DAY = 20_000;

interface GateScopeTally {
  evaluated: number;
  blocked: number;
}

/**
 * TRA-3510 — the selection axis carries the plain evaluated/blocked tally PLUS
 * the chain-shape sums, because `cheapConsidered` / `cheapInBand` are per-row
 * measurements rather than keys. Sums (not means) are accumulated so the axis
 * merges across days by addition like every other axis; the mean is derived at
 * read time over `rowsWithChainShape`, which is its own denominator.
 */
interface GateSelectionTally extends GateScopeTally {
  cheapConsideredSum: number;
  cheapInBandSum: number;
  /** Rows that carried the chain-shape numbers at all. */
  rowsWithChainShape: number;
  /**
   * TRA-3619 — the pre-cheapness pair, on its OWN denominator. It is NOT folded
   * into `rowsWithChainShape` because the two fields were deployed on different
   * days: a fold spanning that boundary holds rows with the cheap counts and no
   * strike counts, and sharing a denominator would divide a partial numerator by
   * a complete denominator — deflating `meanStrikesInBand` toward zero, which is
   * precisely the value that decides State A vs State B.
   */
  strikesConsideredSum: number;
  strikesInBandSum: number;
  rowsWithStrikeShape: number;
}

/** The per-gate accumulator: the same tally shape folded on four independent keys. */
interface GateTallies {
  /** structure (cost_bar) or underlying symbol (spread / universe). */
  byScope: Map<string, GateScopeTally>;
  /** normalized block classification — BLOCKED rows only (an admit has no reason). */
  byReason: Map<string, GateScopeTally>;
  /** live book (`alertUsername`), or `unattributed`. */
  byBook: Map<string, GateScopeTally>;
  /** TRA-3391 tape cell (`structure::bucket`) — rows that carry one, admits included. */
  byCell: Map<string, GateScopeTally>;
  /**
   * TRA-3510 — TRA-3401 nominator branch, admits included. Rows that carry no
   * nominator contribute no key: this axis answers "which branch nominated the
   * candidate this gate ruled on", and a row from a non-OTM path was not
   * nominated by it at all.
   */
  bySelection: Map<string, GateSelectionTally>;
  /**
   * TRA-3483 — per-decision cost/edge samples (`cost_bar` only). This is a LIST,
   * not a tally, because quantiles and a median-of-admitted are not foldable into
   * counters: the sweep's `medianNetR_admitted` is over a k-DEPENDENT subset that
   * is only known at read time.
   */
  costSamples: CostSample[];
  /** Rows of this gate/day that carried NO usable cost (unusable quote / pre-field). */
  costRowsMissing: number;
  /** Samples discarded by {@link MAX_COST_SAMPLES_PER_GATE_DAY}. */
  costSamplesDropped: number;
  /**
   * TRA-4745 — the UNDERLYING axis, admits included. Bumped only by rows that
   * carry a `symbol`, so a pre-field row contributes no key rather than a
   * synthetic one — the same contract `byCell` and `bySelection` hold.
   */
  byUnderlying: Map<string, GateScopeTally>;
  /**
   * TRA-4745 — rows of this gate/day carrying NO `symbol`. The denominator that
   * stops an empty `costBySymbol` (every hydrated pre-deploy row) from reading
   * as "this gate saw no candidates".
   */
  symbolRowsMissing: number;
  /** TRA-3483 (D2) — BLOCKED rows carrying no `reasonCode`, so `byReason`'s denominator is visible. */
  blockedUnclassified: number;
  /**
   * TRA-4269 — `universe` rows carrying the ratified-set counterfactual, keyed
   * by membership + symbol ({@link ratifiedSymbolKey}). Empty on every other gate.
   */
  byRatifiedSymbol: Map<string, RatifiedSymbolTally>;
  /** TRA-4269 — the same rows, counted by the set they were stamped under. */
  byRatifiedSet: Map<string, number>;
}

/** TRA-4269 — one symbol's counterfactual rows under one membership verdict. */
interface RatifiedSymbolTally {
  symbol: string;
  inRatifiedSet: boolean;
  evaluated: number;
}

/**
 * TRA-4269 — membership is part of the key, so a symbol whose verdict flipped
 * with a change to the ratified set lands in two rows. Otherwise it would be one
 * row whose `inRatifiedSet` is whichever verdict came last.
 */
function ratifiedSymbolKey(symbol: string, inRatifiedSet: boolean): string {
  return `${inRatifiedSet ? 'in' : 'out'}::${symbol}`;
}

const UNATTRIBUTED_BOOK = 'unattributed';

/**
 * TRA-4631 — the three `cost_bar` call sites, named by the `scope` each one
 * stamps (see {@link LiveEnforceRecord.scope} for the file+symbol mapping).
 * `single_leg_otm` is the LIVE ENTRY SITE — the only caller that traverses
 * `entry_window`. The per-day `byScope` roll seeds every one of these at 0 so
 * an entry-site zero is a readable value, not an absence; a NEW call site that
 * ships without being added here still publishes its own row (the fold takes
 * the union), it just is not seeded on its silent days.
 */
export const COST_BAR_CALL_SITE_SCOPES: readonly string[] = [
  'single_leg_otm',
  'single_leg_rv',
  'directional',
];

function emptyTallies(): GateTallies {
  return {
    byScope: new Map(),
    byReason: new Map(),
    byBook: new Map(),
    byCell: new Map(),
    bySelection: new Map(),
    costSamples: [],
    costRowsMissing: 0,
    costSamplesDropped: 0,
    byUnderlying: new Map(),
    symbolRowsMissing: 0,
    blockedUnclassified: 0,
    byRatifiedSymbol: new Map(),
    byRatifiedSet: new Map(),
  };
}

function bump(map: Map<string, GateScopeTally>, key: string, blocked: boolean): void {
  let tally = map.get(key);
  if (!tally) {
    tally = { evaluated: 0, blocked: 0 };
    map.set(key, tally);
  }
  tally.evaluated += 1;
  if (blocked) tally.blocked += 1;
}

/** TRA-3510 — `bump` plus the chain-shape sums. Non-finite chain numbers are counted
 *  as evaluated but contribute NO sample, so a malformed row cannot move a mean. */
function bumpSelection(
  map: Map<string, GateSelectionTally>,
  nom: LiveEnforceNominator,
  blocked: boolean,
): void {
  let tally = map.get(nom.selection);
  if (!tally) {
    tally = emptySelectionTally();
    map.set(nom.selection, tally);
  }
  tally.evaluated += 1;
  if (blocked) tally.blocked += 1;
  if (Number.isFinite(nom.cheapConsidered) && Number.isFinite(nom.cheapInBand)) {
    tally.cheapConsideredSum += nom.cheapConsidered;
    tally.cheapInBandSum += nom.cheapInBand;
    tally.rowsWithChainShape += 1;
  }
  // TRA-3619 — same discipline, separate denominator: a row carrying only the
  // cheap pair contributes to `rowsWithChainShape` and NOT to this one.
  if (isStrikeCount(nom.strikesConsidered) && isStrikeCount(nom.strikesInBand)) {
    tally.strikesConsideredSum += nom.strikesConsidered;
    tally.strikesInBandSum += nom.strikesInBand;
    tally.rowsWithStrikeShape += 1;
  }
}

function emptySelectionTally(): GateSelectionTally {
  return {
    evaluated: 0,
    blocked: 0,
    cheapConsideredSum: 0,
    cheapInBandSum: 0,
    rowsWithChainShape: 0,
    strikesConsideredSum: 0,
    strikesInBandSum: 0,
    rowsWithStrikeShape: 0,
  };
}

// ── In-memory store (backs the durable counts + the health endpoint) ─────────
//
// Module-global + observe-through. `dataDir` is set once at boot by
// hydrateLiveEnforceGateFromDisk so the engine chokepoints can append without
// threading a path through the SignalEngine.

let dataDir: string | null = null;
/** etDay -> (gate -> per-axis tallies). */
const byDay = new Map<string, Map<LiveEnforceGate, GateTallies>>();
let decisionsTotal = 0;
let lastDecisionAt: number | null = null;
// TRA-1681 — durability provenance: `byDay` is fed by BOTH the boot hydrate and the
// live pass, and once folded the two are indistinguishable. These say which.
let hydratedRecords = 0;
let hydratedDays = 0;
let appendErrors = 0;
let lastAppendError: string | null = null;

export function liveEnforceGateLogPath(dir: string): string {
  return join(dir, LIVE_ENFORCE_GATE_LOG_FILENAME);
}

/** Test seam — drop every counter and the configured dir. */
export function clearLiveEnforceGateLedger(): void {
  dataDir = null;
  byDay.clear();
  decisionsTotal = 0;
  lastDecisionAt = null;
  hydratedRecords = 0;
  hydratedDays = 0;
  appendErrors = 0;
  lastAppendError = null;
}

const GATES: LiveEnforceGate[] = [
  'cost_bar',
  'spread',
  'otm_delta_floor',
  'universe',
  // TRA-3394 — both ceiling axes are listed so each publishes a row at
  // `evaluated: 0` before it has ever fired. A gate that is absent from the
  // payload and a gate that is present-and-silent are the same JSON to a grader
  // otherwise, and this gate's expected healthy read is precisely
  // `evaluated > 0, blocked = 0` (n=20 above 0.55 on the whole tape).
  'entry_delta_ceiling',
  'entry_delta_ceiling_shadow',
  // TRA-3445 — same reasoning: publish a zero row so an aggregate cap that has
  // never been reached is distinguishable from one that is not wired in.
  'aggregate_cap',
  // TRA-3836 (parent TRA-3827) — the board's <=$100 attended-canary premium
  // ceiling at the mirrorLiveOptionOpen seam. Listed so the deployed build
  // prints `evaluated: 0` before the first live nominee reaches the seam —
  // the key's PRESENCE in this census is the env-independent deployed-bytes
  // proof the control shipped, and its ABSENCE proves it did not.
  'canary_ceiling',
  // TRA-3911 — the REACHABLE fleet bound `Σ_j atRisk_j + entry ≤ A`. Listed for
  // the same reason every gate above it is: the key's PRESENCE in this census is
  // the env-independent deployed-bytes proof the control shipped, and its
  // ABSENCE proves it did not — which matters more here than anywhere else on
  // this list, because this gate's deadline (TRA-3911 AC5) is graded on whether
  // it is enforcing on a PINNED BUILD, not on whether it was merged.
  'fleet_reachable_bound',
  // TRA-3942 (parent TRA-3927) — the ENTRY-TIME window on the OTM sleeve. Listed
  // for the same deployed-bytes reason, and with one extra property worth
  // stating: this gate is ordered at the TOP of the OTM funnel, above the
  // universe cut and above the cost bar, so its `evaluated` is the whole nominee
  // population rather than the ~0.7% that survives the bar. A zero here is a
  // zero the SLEEVE produced, not one a tighter sibling upstream ate — which is
  // exactly the reading `fleet_reachable_bound` could not make (TRA-3926).
  'entry_window',
  // TRA-3944 (parent TRA-3927) — the CONTRACT FLOOR on the OTM sleeve. Listed
  // for the deployed-bytes reason, and ordered in the funnel directly under
  // `entry_window` (above the universe cut and the cost bar), so its
  // `evaluated` is the in-window nominee population — one chain per symbol per
  // sweep — and a zero here is the SLEEVE's zero, not a tighter sibling's.
  'contract_floor',
  // TRA-4144 — the UNDERLYING ASSET CLASS admission gate. Listed for the same
  // deployed-bytes reason as every row above: the key's PRESENCE in this
  // census is the env-independent proof the control shipped (AC5 grades on
  // field presence against a pinned build, never a deploy order's commit), and
  // it must publish `evaluated: 0` before the first live nominee reaches it.
  'underlying_asset_class',
  // TRA-4276 — the ENTRY↔EXIT interlock. Listed for the deployed-bytes reason
  // (the row's presence at `evaluated: 0` is the proof the control shipped —
  // AC5 turns on exactly this on a pinned build), and its healthy read is
  // `evaluated > 0, blocked = 0`: on most days no book is latched, which is
  // precisely the reading an absent row would forge.
  'exit_actionability',
  // TRA-4422 (parent TRA-4421) — the SETUP TAXONOMY. Listed for the same
  // deployed-bytes reason as every row above, and this one leans on it hardest:
  // the gate ships in OBSERVE with an EMPTY setup registry, so its healthy
  // arrival read is `evaluated > 0, blocked = 0` — byte-identical to an absent
  // row folded to zero, and byte-identical to a gate wired in backwards. The
  // key's presence in this census at `evaluated: 0` is what says the control
  // shipped; `evaluated > 0` is what says it is running; and ONLY the
  // `byReasonCode` histogram underneath says it is running on real inputs.
  // ⛔ `evaluated: 0` on this row is UNMEASURED, never a pass.
  'setup_confirmation',
];

/**
 * TRA-3974 — read-only observers on every applied decision.
 *
 * Deliberately hung on {@link apply}, not on the write path, so a subscriber
 * sees BOTH the live append AND the boot replay from
 * {@link hydrateLiveEnforceGateFromDisk}. A subscriber that only saw live
 * appends would silently lose whatever the ledger recorded between its last
 * persist and an unclean stop; one that sees the replay can recover it — but it
 * then owns its own de-duplication, because the replay re-offers rows it has
 * already folded in. That is the subscriber's contract, stated here so the next
 * one does not have to rediscover it.
 *
 * An observer that throws is logged and swallowed: this list is downstream of a
 * verdict that has already been made, and nothing on it may reach an order path.
 */
export type LiveEnforceObserver = (rec: LiveEnforceRecord) => void;

const observers: LiveEnforceObserver[] = [];

/** Register a read-only observer. Not removable — the call sites are module-init. */
export function onLiveEnforceRecord(fn: LiveEnforceObserver): void {
  observers.push(fn);
}

/** Apply one decision to the in-memory tallies (shared by record + hydrate). */
function apply(rec: LiveEnforceRecord): void {
  let day = byDay.get(rec.etDay);
  if (!day) {
    day = new Map();
    byDay.set(rec.etDay, day);
  }
  let tallies = day.get(rec.gate);
  if (!tallies) {
    tallies = emptyTallies();
    day.set(rec.gate, tallies);
  }
  bump(tallies.byScope, rec.scope, rec.blocked);
  bump(tallies.byBook, rec.book ?? UNATTRIBUTED_BOOK, rec.blocked);
  // Blocked rows ONLY: an admitted candidate has no rejection classification, and
  // folding admits into this axis under a synthetic "admitted" key would make the
  // dominant bucket of every gate the one that explains nothing.
  if (rec.blocked && typeof rec.reasonCode === 'string' && rec.reasonCode !== '') {
    bump(tallies.byReason, rec.reasonCode, true);
  } else if (rec.blocked) {
    // TRA-3483 (D2) — a block with no classification is NOT absent from the
    // ledger, it is absent from `byReason`. On the retained 6-day fold 1759 of
    // 1929 cost_bar blocks predate reason stamping, so `gross_negative`'s
    // published `share` of 0.0881 reads as a RATE when it is a COVERAGE artifact.
    // Counting them here puts the missing denominator on the payload.
    tallies.blockedUnclassified += 1;
  }
  // TRA-3391 — cell axis, admits INCLUDED (`bump` counts evaluated and, when
  // blocked, blocked). Only rows that actually carry a cell contribute: a missing
  // cell is "never stamped", not a bucket.
  if (typeof rec.cell === 'string' && rec.cell !== '') {
    bump(tallies.byCell, rec.cell, rec.blocked);
  }
  // TRA-3510 — nominator branch, admits INCLUDED. A gate whose whole `blocked`
  // count sits on `in_band` is reporting a bound the SELECTOR imposed, not one it
  // measured; that is only visible if admits are on the same axis as blocks.
  if (rec.nominator && SELECTIONS.includes(rec.nominator.selection)) {
    bumpSelection(tallies.bySelection, rec.nominator, rec.blocked);
  }
  // TRA-3483 — the cost/edge sample. A row with no usable cost is COUNTED as
  // missing rather than skipped: the sweep's denominator has to be visible, and a
  // silently shorter sample list is exactly how a coverage gap reads as a rate.
  if (rec.cost && Number.isFinite(rec.cost.costR) && Number.isFinite(rec.cost.costFracOfPremium)) {
    if (tallies.costSamples.length < MAX_COST_SAMPLES_PER_GATE_DAY) {
      tallies.costSamples.push({
        costR: rec.cost.costR,
        spreadR: rec.cost.spreadR,
        feeR: rec.cost.feeR,
        costFracOfPremium: rec.cost.costFracOfPremium,
        grossR: typeof rec.grossR === 'number' && Number.isFinite(rec.grossR) ? rec.grossR : null,
        blocked: rec.blocked,
        cell: typeof rec.cell === 'string' && rec.cell !== '' ? rec.cell : null,
        // TRA-4745 — the three stamps the `grossR` / predicate / symbol axes are
        // folded off. Each is independently nullable: a row can carry a cost and
        // no symbol (pre-deploy), or a predicate and no cost (unusable quote).
        etDay: rec.etDay,
        symbol: typeof rec.symbol === 'string' && rec.symbol !== '' ? rec.symbol : null,
        reasonCode:
          rec.blocked && typeof rec.reasonCode === 'string' && rec.reasonCode !== ''
            ? rec.reasonCode
            : null,
        predicate: usablePredicate(rec.predicate) ? rec.predicate! : null,
      });
    } else {
      tallies.costSamplesDropped += 1;
    }
  } else if (rec.gate === 'cost_bar') {
    // Scoped to `cost_bar`: the other gates never carry a cost at all, and
    // counting them here would publish `rowsMissingCostR === evaluated` on a gate
    // that was never instrumented — a fake coverage hole.
    tallies.costRowsMissing += 1;
  }
  // TRA-4745 — the underlying axis, admits INCLUDED and INDEPENDENT of the cost
  // sample: a row whose quote was unusable still has a symbol, and excluding it
  // would make `costBySymbol`'s denominator the cost coverage rather than the
  // gate's own population.
  if (typeof rec.symbol === 'string' && rec.symbol !== '') {
    bump(tallies.byUnderlying, rec.symbol, rec.blocked);
  } else if (rec.gate === 'cost_bar') {
    tallies.symbolRowsMissing += 1;
  }
  // TRA-4269 — the ratified-set counterfactual. A row that carries none adds
  // nothing here: a restricted or pre-field row is not an in-set admit.
  const counterfactual = usableCounterfactual(rec.gate, rec.wouldBlockUnderRatifiedSet, rec.ratifiedSet);
  if (counterfactual) {
    const inRatifiedSet = !counterfactual.wouldBlockUnderRatifiedSet;
    const key = ratifiedSymbolKey(rec.scope, inRatifiedSet);
    const t = tallies.byRatifiedSymbol.get(key);
    if (t) t.evaluated += 1;
    else tallies.byRatifiedSymbol.set(key, { symbol: rec.scope, inRatifiedSet, evaluated: 1 });
    const set = counterfactual.ratifiedSet;
    tallies.byRatifiedSet.set(set, (tallies.byRatifiedSet.get(set) ?? 0) + 1);
  }
  decisionsTotal += 1;
  lastDecisionAt = rec.ts;
  // TRA-3974 — LAST, and never before the tallies: an observer must not be able
  // to change what the ledger itself recorded, and it must not be able to break
  // it either.
  for (const fn of observers) {
    try {
      fn(rec);
    } catch (err) {
      log.warn('live-enforce-gate observer threw (swallowed)', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Record one ARMED-LIVE gate decision and append one JSONL line under the
 * configured DATA_DIR. Best-effort on IO — a write failure logs, is COUNTED
 * (`appendErrors`), and is swallowed so this accounting can never break a live
 * order path. When no dataDir is configured (unit tests / CLI without boot) the
 * in-memory counts still update; only the file write is skipped.
 */
export function recordLiveEnforceDecision(
  gate: LiveEnforceGate,
  scope: string,
  blocked: boolean,
  etDay: string,
  reason?: string,
  now: number = Date.now(),
  // TRA-3216 — trailing options bag so the three pre-existing call sites keep
  // their positional signature unchanged.
  opts?: {
    reasonCode?: string;
    book?: string | null;
    cell?: string | null;
    // TRA-3483 — the cost NUMERATOR and edge DENOMINATOR of the net-edge
    // comparison, on every cost_bar verdict, admits included. Both optional:
    // `cost: null` is the unusable-quote case, `grossR` non-finite is the
    // unknown-edge case, and each has to stay distinguishable from the other.
    cost?: LiveEnforceRecord['cost'] | null;
    grossR?: number | null;
    // TRA-4745 — the underlying, and the realised comparison. Both `cost_bar`
    // stamps today; both optional so every other call site compiles unchanged
    // and hydrates as a COUNTED miss rather than a synthetic value.
    symbol?: string | null;
    predicate?: LiveEnforceGatePredicate | null;
    // TRA-3510 — which TRA-3401 branch nominated this candidate. Null/absent on
    // every non-OTM call site, which is the honest reading: those rows were not
    // produced by the OTM nominator at all.
    nominator?: LiveEnforceNominator | null;
    // TRA-3674 — the per-book budget's three resolved terms, admits included.
    budget?: LiveEnforceRecord['budget'] | null;
    // TRA-4269 — the ratified-set counterfactual: `universe` only, and only
    // while unrestricted. Null/absent on a restricted verdict and on every
    // other gate.
    ratifiedSetCounterfactual?: LiveOtmRatifiedSetCounterfactual | null;
  },
): void {
  const cost = opts?.cost;
  const costUsable =
    !!cost
    && Number.isFinite(cost.costR)
    && Number.isFinite(cost.spreadR)
    && Number.isFinite(cost.feeR)
    && Number.isFinite(cost.costFracOfPremium);
  const rec: LiveEnforceRecord = {
    ts: now,
    etDay,
    gate,
    scope,
    blocked,
    ...(blocked && reason ? { reason } : {}),
    ...(blocked && opts?.reasonCode ? { reasonCode: opts.reasonCode } : {}),
    ...(typeof opts?.book === 'string' && opts.book !== '' ? { book: opts.book } : {}),
    ...(typeof opts?.cell === 'string' && opts.cell !== '' ? { cell: opts.cell } : {}),
    ...(costUsable ? { cost: cost! } : {}),
    ...(typeof opts?.grossR === 'number' && Number.isFinite(opts.grossR) ? { grossR: opts.grossR } : {}),
    // TRA-4745 — the symbol and the realised comparison. A blank symbol is a
    // MISSING stamp, never the empty-string key.
    ...(typeof opts?.symbol === 'string' && opts.symbol !== '' ? { symbol: opts.symbol } : {}),
    ...(usablePredicate(opts?.predicate ?? undefined) ? { predicate: opts!.predicate! } : {}),
    ...(usableNominator(opts?.nominator) ? { nominator: opts!.nominator! } : {}),
    // TRA-3674 — stamped on BOTH verdicts. The admits are what supply the
    // denominator that tells "the budget never had to bite" apart from "the
    // budget resolved to 0 and blocked everything silently".
    ...(hydratedBudget(opts?.budget ?? undefined) ? { budget: opts!.budget! } : {}),
    // TRA-4269 — both halves or neither. A stamp offered on any other gate is dropped.
    ...(usableCounterfactual(
      gate,
      opts?.ratifiedSetCounterfactual?.wouldBlock,
      opts?.ratifiedSetCounterfactual?.ratifiedSet,
    ) ?? {}),
  };
  applyAndAppend(rec);
}

function applyAndAppend(rec: LiveEnforceRecord): void {
  // In-memory tally updates FIRST and UNCONDITIONALLY, then the disk write is
  // attempted best-effort — so accounting can never break a live order pass. But
  // that means the counters are NOT proof anything reached disk: `durability`
  // below is the field that tells a memory-only / failed-append ledger apart from a
  // clean durable write (TRA-1681).
  apply(rec);
  if (dataDir == null) return;
  const path = liveEnforceGateLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    appendErrors += 1;
    lastAppendError = err instanceof Error ? err.message : String(err);
    log.warn('live-enforce-gate append failed', { reason: lastAppendError });
  }
}

/**
 * TRA-3483 — is a persisted `cost` block usable? Every term must be a finite
 * number: a partially-written block would otherwise put a NaN into the quantile
 * sort, which silently corrupts the whole day's distribution rather than showing
 * up as one bad row.
 */
/**
 * TRA-3674 — is a budget block usable? ALL FOUR terms must be finite, because
 * the block exists precisely to tell a full book apart from a mis-resolved φ
 * and from a collapsed balance: a partial block would answer none of the three.
 * `capUsd` may legitimately be `0` (the fail-closed no-balance verdict), so the
 * test is finiteness, not positivity.
 */
function hydratedBudget(budget: LiveEnforceRecord['budget']): boolean {
  return (
    !!budget
    && typeof budget === 'object'
    && Number.isFinite(budget.capUsd)
    && Number.isFinite(budget.fleetCapUsd)
    && Number.isFinite(budget.fleetRiskFraction)
    && Number.isFinite(budget.availableCashUsd)
  );
}

function hydratedCost(cost: LiveEnforceRecord['cost']): boolean {
  return (
    !!cost
    && typeof cost === 'object'
    && Number.isFinite(cost.costR)
    && Number.isFinite(cost.spreadR)
    && Number.isFinite(cost.feeR)
    && Number.isFinite(cost.costFracOfPremium)
  );
}

/**
 * TRA-4745 — is a realised-predicate block usable?
 *
 * Shared by the write path and the hydrate path deliberately, same as
 * {@link hydratedCost}: a block this refuses to record must also be one it
 * refuses to read back, or the retained fold would publish a shape the live fold
 * cannot produce.
 *
 * ⛔ The `compared`/`lhs`/`rhs` INVARIANT is enforced here rather than trusted:
 * `compared === true` demands two finite sides, and `compared === false` demands
 * two nulls. A half-populated block is exactly the surface this ticket exists to
 * delete — a reader would infer a comparison from a number that decided nothing.
 * `form` is checked against the known set because it becomes a published key.
 */
function usablePredicate(p: LiveEnforceRecord['predicate']): boolean {
  if (!p || typeof p !== 'object') return false;
  if (p.form !== 'tape_expectancy_flat' && p.form !== 'net_edge') return false;
  if (typeof p.compared !== 'boolean' || typeof p.admit !== 'boolean') return false;
  if (p.op !== '>=' && p.op !== '<=') return false;
  if (typeof p.lhsLabel !== 'string' || typeof p.rhsLabel !== 'string') return false;
  if (p.compared) {
    return typeof p.lhs === 'number' && Number.isFinite(p.lhs)
      && typeof p.rhs === 'number' && Number.isFinite(p.rhs);
  }
  return p.lhs === null && p.rhs === null && typeof p.shortCircuit === 'string';
}

/**
 * TRA-3510 — is a nominator block usable? `selection` must be one of the four
 * KNOWN branches: this value becomes a map key, so accepting an arbitrary string
 * off a persisted line would let a corrupt row invent an unbounded axis. Both
 * chain counts must be finite non-negative integers for the same reason a NaN
 * `costR` is rejected — one bad row would otherwise poison a published mean.
 *
 * Shared by the write path and the hydrate path deliberately: a row this refuses
 * to record must also be a row it refuses to read back.
 *
 * TRA-3619's `strikesConsidered` / `strikesInBand` are deliberately NOT part of
 * this predicate. They post-date the field, so requiring them would reject every
 * previously-written nominator block on hydrate and vaporize the retained
 * `bySelection` axis. They are validated where they are USED
 * ({@link isStrikeCount}), which drops a bad pair without dropping the row.
 */
function usableNominator(nom: LiveEnforceNominator | null | undefined): boolean {
  return (
    !!nom
    && typeof nom === 'object'
    && SELECTIONS.includes(nom.selection)
    && Number.isInteger(nom.cheapConsidered) && nom.cheapConsidered >= 0
    && Number.isInteger(nom.cheapInBand) && nom.cheapInBand >= 0
  );
}

/**
 * TRA-3619 — a strike count is a non-negative integer or it is absent. Anything
 * else (NaN off a truncated line, a float, a negative) contributes NO sample
 * rather than a poisoned one, exactly as {@link bumpSelection} treats a
 * non-finite cheap count.
 */
function isStrikeCount(v: number | undefined): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/**
 * TRA-4269 — the counterfactual stamp, normalized, or `null` when it is not
 * usable: a non-`universe` gate, a non-boolean verdict, or a missing/empty set.
 * Shared by the write path, the hydrate path and {@link apply} for the same
 * reason as {@link usableNominator}. A row this refuses to record must also be
 * a row it refuses to read back or count.
 */
function usableCounterfactual(
  gate: LiveEnforceGate,
  wouldBlock: unknown,
  ratifiedSet: unknown,
): { wouldBlockUnderRatifiedSet: boolean; ratifiedSet: string } | null {
  if (gate !== 'universe') return null;
  if (typeof wouldBlock !== 'boolean') return null;
  if (typeof ratifiedSet !== 'string' || ratifiedSet === '') return null;
  return { wouldBlockUnderRatifiedSet: wouldBlock, ratifiedSet };
}

/** What {@link hydrateLiveEnforceGateFromDisk} recovered (for the boot log line). */
export interface LiveEnforceGateHydration {
  days: number;
  records: number;
}

/**
 * Rebuild the in-memory tallies from disk on boot and remember `dir` for
 * subsequent appends. Idempotent: CLEARS first, so it is safe to call once at
 * startup before any live pass. Only records within {@link RETAIN_MS} of `now` are
 * kept, and the file is COMPACTED to exactly those lines. Best-effort: a
 * missing/corrupt file yields an empty hydration; a torn trailing line is skipped.
 */
export function hydrateLiveEnforceGateFromDisk(dir: string, now: number = Date.now()): LiveEnforceGateHydration {
  clearLiveEnforceGateLedger();
  dataDir = dir;

  let raw = '';
  try {
    raw = readFileSync(liveEnforceGateLogPath(dir), 'utf8');
  } catch {
    raw = '';
  }

  const cutoff = now - RETAIN_MS;
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let rec: LiveEnforceRecord;
    try {
      rec = JSON.parse(trimmed) as LiveEnforceRecord;
    } catch {
      continue; // skip a torn/partial line rather than abort the hydrate
    }
    if (typeof rec.ts !== 'number' || !Number.isFinite(rec.ts) || rec.ts < cutoff) continue;
    if (typeof rec.etDay !== 'string' || rec.etDay === '') continue;
    if (!GATES.includes(rec.gate)) continue;
    if (typeof rec.scope !== 'string' || rec.scope === '') continue;
    if (typeof rec.blocked !== 'boolean') continue;
    const clean: LiveEnforceRecord = {
      ts: rec.ts,
      etDay: rec.etDay,
      gate: rec.gate,
      scope: rec.scope,
      blocked: rec.blocked,
      ...(rec.blocked && typeof rec.reason === 'string' ? { reason: rec.reason } : {}),
      // TRA-3216 — rows written before these fields existed simply lack them; they
      // hydrate into the `unattributed` book and contribute no byReason row, which
      // is the honest reading (the classification was never recorded), not a zero.
      ...(rec.blocked && typeof rec.reasonCode === 'string' && rec.reasonCode !== ''
        ? { reasonCode: rec.reasonCode }
        : {}),
      ...(typeof rec.book === 'string' && rec.book !== '' ? { book: rec.book } : {}),
      ...(typeof rec.cell === 'string' && rec.cell !== '' ? { cell: rec.cell } : {}),
      // TRA-3483 — a row written before the cost fields existed simply lacks
      // them and hydrates as a MISSING sample (counted), never as a zero.
      ...(hydratedCost(rec.cost) ? { cost: rec.cost! } : {}),
      ...(typeof rec.grossR === 'number' && Number.isFinite(rec.grossR) ? { grossR: rec.grossR } : {}),
      // TRA-4745 — every row on disk today predates both fields and hydrates
      // WITHOUT them, which is what makes `costRowsMissingSymbol` /
      // `predicateUnstamped` the honest coverage denominator on the retained
      // fold rather than a hole nobody can see.
      ...(typeof rec.symbol === 'string' && rec.symbol !== '' ? { symbol: rec.symbol } : {}),
      ...(usablePredicate(rec.predicate) ? { predicate: rec.predicate! } : {}),
      // TRA-3674 — a row written before the budget terms existed hydrates
      // WITHOUT them (a missing stamp), never with a synthetic zero budget,
      // which would read as "this book was allowed nothing".
      ...(hydratedBudget(rec.budget) ? { budget: rec.budget! } : {}),
      // TRA-3510 — a row written before the nominator axis existed simply lacks
      // it and contributes no `bySelection` key. That is what makes the axis
      // honest across the deploy boundary: the retained fold's `bySelection`
      // denominator is the rows that were STAMPED, never the gate's `evaluated`.
      ...(usableNominator(rec.nominator)
        ? {
          nominator: {
            selection: rec.nominator!.selection,
            cheapConsidered: rec.nominator!.cheapConsidered,
            cheapInBand: rec.nominator!.cheapInBand,
            // TRA-3619 — carried only when the pair is BOTH present and sane.
            // A row from before the field, or one holding half of it, hydrates
            // with no strike shape and lands outside `rowsWithStrikeShape`,
            // which is what keeps `meanStrikesInBand` a mean over rows that
            // actually measured it.
            ...(isStrikeCount(rec.nominator!.strikesConsidered)
              && isStrikeCount(rec.nominator!.strikesInBand)
              ? {
                strikesConsidered: rec.nominator!.strikesConsidered,
                strikesInBand: rec.nominator!.strikesInBand,
              }
              : {}),
          },
        }
        : {}),
      // TRA-4269 — both halves or neither, and `universe` only. A row from
      // before the field, or one with a malformed half, hydrates with no stamp
      // and stays out of the counterfactual's denominator.
      ...(usableCounterfactual(rec.gate, rec.wouldBlockUnderRatifiedSet, rec.ratifiedSet) ?? {}),
    };
    apply(clean);
    kept.push(JSON.stringify(clean));
  }

  // Compact: rewrite the file to the retained lines only (best-effort). Skipped
  // when there is nothing to drop, to avoid a needless rewrite on every clean boot.
  const nonEmptyLines = raw.split('\n').filter((l) => l.trim() !== '').length;
  if (kept.length < nonEmptyLines) {
    const path = liveEnforceGateLogPath(dir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8');
    } catch (err) {
      log.warn('live-enforce-gate compaction failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  hydratedRecords = kept.length;
  hydratedDays = byDay.size;
  return { days: byDay.size, records: kept.length };
}

// ── Health summary ───────────────────────────────────────────────────────────

export interface LiveEnforceScopeSummary {
  scope: string;
  evaluated: number;
  blocked: number;
  /** blocked / evaluated; **`null` when the gate ruled on nothing** (not 0 — TRA-1707/TRA-1682). */
  blockRate: number | null;
}

/**
 * TRA-3216 — the tuning axis. One row per normalized block classification,
 * heaviest first. **Blocks only** — `share` is of this gate's BLOCKED total, so
 * the rows sum to 1 and read directly as "which term dominated".
 */
export interface LiveEnforceReasonSummary {
  reasonCode: string;
  blocked: number;
  /** blocked / (this gate's blocked total); `null` when the gate blocked nothing. */
  share: number | null;
}

/**
 * TRA-3216 — the FLEET axis. One row per live book (`alertUsername`) the gate
 * actually ruled for, plus `unattributed` for verdicts whose call site could not
 * name a book. A process-level flag reads identically for a book it does not
 * govern; this is the split that tells the two apart.
 */
export interface LiveEnforceBookSummary {
  book: string;
  evaluated: number;
  blocked: number;
  blockRate: number | null;
}

/**
 * TRA-3391 — the EVIDENCE axis. One row per tape cell (`structure::|delta|
 * bucket`) the gate decided under, busiest first. Unlike `byReason` this counts
 * ADMITS too: an admitted cell is exactly what a grader checks against the
 * published expectancy table, and a cell that only ever appears with
 * `evaluated === blocked` is one the live universe has never had evidence for.
 *
 * Empty on a gate that stamps no cell (`spread`, `universe`, `otm_delta_floor`)
 * and on rows written before the field existed — never a synthetic bucket.
 */
export interface LiveEnforceCellSummary {
  cell: string;
  evaluated: number;
  blocked: number;
  blockRate: number | null;
  /**
   * TRA-3483 — the `costR` distribution WITHIN this cell, which is the only place
   * it can discriminate anything: every row in a cell shares the same
   * `modeledGrossR` (the cell lower bound), so the cell-level cost spread IS the
   * within-cell decision boundary a `k` would move. Null on cells with no sample.
   *
   * ⚠️ TRA-4745 — this is a RECORDER. The DEPLOYED flat form compares
   * `grossRQuantiles` against `barR` and never looks at this block. Inferring a
   * block rate from this distribution and the published bar is exactly what
   * produced a +98.0pp miss on `single_leg_rv::0.55-1.00`.
   */
  costRQuantiles: CostRQuantiles | null;
  /**
   * TRA-4745 — the `grossR` distribution WITHIN this cell: the LEFT SIDE of the
   * deployed comparison, and therefore the only one of the two blocks here that
   * can explain this cell's own `blockRate`. Null on cells with no sample.
   */
  grossRQuantiles: GrossRQuantiles | null;
  /**
   * TRA-4745 — one sampled BLOCKED row per ET day in this cell, carrying the
   * exact comparison the gate evaluated. Empty on a cell with no blocks, and on
   * a cell whose rows all predate the stamp (see `predicateUnstamped`).
   */
  predicateSamples: LiveEnforcePredicateSample[];
  /**
   * TRA-4745 — this cell's cost samples carrying NO realised predicate. The
   * coverage denominator for `predicateSamples`: every row written before this
   * deploy is here, so an empty sample list is a coverage hole, not a quiet cell.
   */
  predicateUnstamped: number;
  /**
   * TRA-4745 — of this cell's stamped rows, how many the gate actually COMPARED
   * vs short-circuited on a precondition. ⭐ THE PAIR TO GRADE: a cell at
   * `blocked === evaluated` with `rowsCompared === 0` was refused by
   * `insufficient_evidence` / `band_deauthorized` / `gross_unknown` and is
   * NEITHER a cost problem NOR an edge collapse — no bar move and no `k` can
   * reach it, so no re-tune of this gate is the remedy.
   */
  rowsCompared: number;
  rowsShortCircuited: number;
}

/**
 * TRA-3510 — one nominator branch's contribution to a gate.
 *
 * ## How to read it
 *
 * `entry_delta_ceiling_shadow` at `blocked: 0` is only informative once this axis
 * is present:
 *
 *   • rows concentrated on `in_band` ⇒ the zero is BY CONSTRUCTION. The selector
 *     nominated inside `[min, max)` and the ceiling sits at `max`, so no row it
 *     saw was capable of breaching. Do not publish that zero as a tail estimate.
 *   • rows on `fallback_top_mispricing` / `legacy` ⇒ the far tail WAS nominated
 *     and did not breach. That zero is a measurement.
 *
 * The same reading, mirrored, applies to `otm_delta_floor`: an `in_band` row
 * cannot breach a floor at or below the band's `min` either.
 */
export interface LiveEnforceSelectionSummary {
  /** `in_band` | `in_band_fair` | `fallback_top_mispricing` (persisted pre-TRA-3856 rows only) | `legacy` | `none`. */
  selection: string;
  evaluated: number;
  blocked: number;
  /** blocked / evaluated; `null` when this branch produced nothing. */
  blockRate: number | null;
  /**
   * Rows on this branch carrying the chain-shape numbers — the DENOMINATOR of
   * the two means below, published rather than implied so a partially-stamped
   * fold cannot read as a complete one.
   */
  rowsWithChainShape: number;
  /** Mean `cheap` candidates the chain offered, over `rowsWithChainShape`. */
  meanCheapConsidered: number | null;
  /**
   * Mean `cheap` candidates that landed INSIDE the armed band. On a
   * `fallback_top_mispricing` row this is 0 by definition (the fallback is taken
   * precisely because nothing was in band), so a nonzero value here on that
   * branch would be a wiring defect, not a finding.
   */
  meanCheapInBand: number | null;
  /**
   * TRA-3619 — rows on this branch carrying the PRE-CHEAPNESS strike counts.
   * Its own denominator, separate from `rowsWithChainShape`: rows written before
   * the field carry the cheap pair and not this one, and a fold across that
   * boundary must not divide a partial numerator by a complete denominator.
   * `0` here with `rowsWithChainShape > 0` means "this fold predates the
   * measurement", NOT "the chain had no strikes".
   */
  rowsWithStrikeShape: number;
  /**
   * TRA-3619 — mean candidates the scanner offered BEFORE the cheapness screen,
   * over `rowsWithStrikeShape`. Post-liquidity, not the raw chain.
   */
  meanStrikesConsidered: number | null;
  /**
   * TRA-3619 — **the separator.** Mean candidates whose |Δ| sat inside the band,
   * counted BEFORE `classification === 'cheap'` is applied.
   *
   * Read it against `meanCheapInBand` on the `fallback_top_mispricing` branch,
   * where `meanCheapInBand` is 0 by construction:
   *
   *   • `meanStrikesInBand ≈ 0` ⇒ the band is EMPTY IN THE CHAIN. Re-ordering the
   *     screens cannot manufacture a strike that is not there; the band edges are
   *     the open question (TRA-3401 / board).
   *   • `meanStrikesInBand ≥ 1` ⇒ the chain HELD in-band strikes and the cheapness
   *     screen discarded them upstream of the band filter. The screen ORDER is
   *     then the lever.
   *
   * `null` on the dark `legacy` branch's semantics is not how this reports: the
   * selector writes 0 there (the band is never consulted), and `legacy` is its
   * own axis key, so a dark 0 can never be pooled with an armed branch's zero.
   */
  meanStrikesInBand: number | null;
}

/**
 * TRA-3483 — a distribution, published as quantiles rather than a mean. The bar
 * is a THRESHOLD, so what decides how many candidates a given `k` admits is the
 * SHAPE of the cost distribution near it; a mean cannot answer that and a mean is
 * all the deployed surface could have offered.
 */
export interface QuantileBlock {
  /** Samples behind these quantiles. */
  n: number;
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
}

/**
 * TRA-3483 — the per-decision `costR` distribution: the NUMERATOR of
 * `admit ⟺ costR ≤ k · modeledGrossR`, in the same `R_gate` unit as `barR`.
 *
 * The decomposition is published beside it because the two terms behave
 * completely differently under a retune: `feeR` is a constant per share
 * ($0.229/contract RT ÷ 100 ÷ risk), while `spreadR` is the candidate's OWN quote
 * and is ~82% of the modeled bar (0.235 of 0.285). A `k` chosen against the
 * aggregate without seeing which term moves is a `k` chosen against the fee floor.
 */
export interface CostRQuantiles extends QuantileBlock {
  /** The spread-cross term alone, same R unit. */
  spreadR: QuantileBlock;
  /** The commission/fee term alone, same R unit. */
  feeR: QuantileBlock;
  /** Median of `spreadR / costR` — how much of the cost the quote (not the fee) is. */
  medianSpreadShareOfCost: number | null;
  /**
   * Rows in this fold that carried NO usable `costR` (unusable quote at decision
   * time, or written before TRA-3483). `n + rowsMissingCostR` is the fold's row
   * count — publishing it is what stops a partial-coverage quantile from reading
   * as the day's distribution.
   */
  rowsMissingCostR: number;
  /** Samples dropped by the retention cap; > 0 ⇒ these quantiles are over a truncated head. */
  samplesDropped: number;
}

/**
 * TRA-4745 — the per-decision `grossR` distribution: the LEFT SIDE of the
 * DEPLOYED flat form's comparison, `admit ⟺ grossR ≥ barR`.
 *
 * ## Why this had to ship beside `costRQuantiles`
 *
 * Until now the payload published the bar (`arm.costBar.bar.barR`) and the
 * `costR` distribution — the bar and the ONE quantity the flat form never
 * compares it to. The obvious reading (blocked share ≈ share of `costR` above
 * the bar) held on `single_leg_otm::0.50-0.55` to −1.7pp and failed by **+39.1**,
 * **+56.1** and **+98.0pp** on the other three live cells, with
 * `single_leg_rv::0.55-1.00` refusing 633 of 633 at a median `costR` 57% BELOW
 * the bar (TRA-4741, comment `47a32c11`). This block is the side that actually
 * decides, so the prediction becomes checkable instead of misleading.
 *
 * ## How to read it, per cell
 *
 * Every row inside a cell shares the SAME `grossR` — it is the cell's lower 95%
 * CI bound, a property of the cell and not of the candidate. So within one cell
 * on one day this block is DEGENERATE (`min === max`) and the flat predicate is
 * constant: block rate 0% or 100%, never in between. A pooled multi-day cell
 * spreads only because the tape re-folds between days. **A 100.0% cell is the
 * expected shape of a cell whose bound sits under the bar, not evidence of a
 * mis-attributed non-cost refusal.**
 *
 * ⚠️ `n` here counts rows that carried a FINITE edge. A row whose cell was
 * unmeasured carries `grossR: null` and is in `rowsMissingGrossR` — and those
 * rows are `insufficient_evidence` blocks, which never reached any comparison at
 * all. Read `rowsMissingGrossR` against `predicate.compared` before calling a
 * block rate an edge collapse.
 */
export interface GrossRQuantiles extends QuantileBlock {
  /**
   * Rows in this fold whose edge was UNKNOWN at decision time (unmeasured /
   * underpowered cell, unusable delta, or written before TRA-3483).
   * `n + rowsMissingGrossR` is the fold's cost-sample count.
   */
  rowsMissingGrossR: number;
  /**
   * The bar those rows were compared against, as recorded per row. Published as
   * a distribution rather than a scalar because `barR` is resolved from env at
   * decision time and a retune mid-fold would otherwise be invisible — and
   * because reading the CURRENT `arm.costBar.bar.barR` against a 30-day fold is
   * the same class of mistake this whole block exists to stop. Null when no row
   * in the fold carried a realised predicate (every pre-deploy row).
   */
  barR: QuantileBlock | null;
  /**
   * `barR − grossR` over the rows that were actually COMPARED — EXACTLY the
   * quantity `byReason`'s `shortfall_lt_0.10` / `shortfall_0.25_0.50` /
   * `shortfall_gte_0.50` buckets. Published so "shortfall of what against what"
   * is answered on the payload instead of in the source. Null when no row in the
   * fold was compared.
   */
  shortfallR: QuantileBlock | null;
}

/**
 * TRA-4745 — one sampled row's REALISED predicate: the exact comparison the gate
 * performed, with both sides' numbers and the outcome.
 *
 * One BLOCKED row per cell per ET day, which is what the witness asked for — the
 * per-cell distribution blocks are the fold, this is the traceable instance.
 */
export interface LiveEnforcePredicateSample {
  etDay: string;
  /** The comparison, rendered — e.g. `grossR 0.1645 >= barR 0.3850 ⇒ BLOCK`. */
  statement: string;
  form: string;
  /** FALSE ⇒ the gate refused on a precondition; `lhs`/`rhs` are null and NO inequality ran. */
  compared: boolean;
  lhsLabel: string;
  lhs: number | null;
  op: string;
  rhsLabel: string;
  rhs: number | null;
  /** `rhs − lhs` on a `>=` comparison — the `byReason` shortfall. Null otherwise. */
  shortfallR: number | null;
  /** The precondition that fired when `compared === false`; null otherwise. */
  shortCircuit: string | null;
  reasonCode: string | null;
  /**
   * The same row's recorded `costR`. ⚠️ A RECORDER — the flat form does not
   * consult it. It is published here precisely so a reader can SEE it sitting
   * outside the comparison instead of assuming it is inside one.
   */
  costR: number | null;
  symbol: string | null;
}

/**
 * TRA-4745 — one underlying's contribution to `cost_bar`.
 *
 * ⚠️ **This is NOT `bySymbol`, and `cost_bar.bySymbol` stays `null` by design.**
 * That key is the TRA-4269 RATIFIED-SET COUNTERFACTUAL and its rows carry
 * `inRatifiedSet`, a fact only the `universe` gate computes; populating it on
 * `cost_bar` would mean two different questions under one name, which is the
 * class of defect this ticket is fixing rather than propagating. The join the
 * witness needed — cost outcomes against symbols — is here.
 *
 * ⛔ Read `costRowsMissingSymbol` FIRST. `cost_bar` rows carried no symbol at all
 * before this ticket (the gate's `scope` key is the STRUCTURE), so every row
 * hydrated from a pre-deploy JSONL line is in that counter and contributes no
 * row here. An empty or short `costBySymbol` over a 30-day retained fold means
 * COVERAGE, not a quiet universe.
 */
export interface LiveEnforceCostSymbolSummary {
  symbol: string;
  evaluated: number;
  blocked: number;
  blockRate: number | null;
  /** The symbol's `costR` distribution. Null when no row of its carried a usable cost. */
  costR: QuantileBlock | null;
  /** The symbol's `grossR` distribution — the side that decides. Null when none carried an edge. */
  grossR: QuantileBlock | null;
  /** This symbol's rows whose edge was unknown (unmeasured cell) — they never reached a comparison. */
  rowsMissingGrossR: number;
  /** Rows of this symbol the gate actually COMPARED, of those carrying a predicate stamp. */
  rowsCompared: number;
}

/** TRA-3483 — one counterfactual `k` on the recorded row set. Decides nothing. */
export interface NetEdgeShadowSweepRow {
  k: number;
  /** Rows the net-edge form at this `k` WOULD have admitted. */
  admits: number;
  /** admits / rowsEvaluated; null when the fold evaluated nothing. */
  admitRate: number | null;
  /**
   * median(`modeledGrossR − costR`) over the rows this `k` admits — the R2
   * acceptance statistic in TRA-3481, and the one thing that cannot be
   * reconstructed from counts. Null when this `k` admits nothing.
   */
  medianNetR_admitted: number | null;
}

/**
 * TRA-3483 — the counterfactual k-sweep. **A RECORDER, NOT A GATE.**
 * `ENABLE_OPTION_COST_BAR_NET_EDGE` is `false`; every number here describes what
 * a form that is NOT running would have done to rows a form that IS running
 * already decided. Nothing in this block feeds a verdict.
 */
export interface NetEdgeShadowSummary {
  /** The ET day folded, or null on the multi-day `retained` view. */
  etDay: string | null;
  /** ET days behind the fold (one entry on the day view). */
  etDays: string[];
  /** Every `cost_bar` verdict in the fold — the COVERAGE denominator. */
  rowsRecorded: number;
  /**
   * Rows the sweep could evaluate: those carrying a usable `costR`. Rows with an
   * unusable quote are EXCLUDED here and reported below, because under the real
   * net-edge form they are `net_edge_quote_unusable` blocks at every `k` — they
   * would depress every admit rate identically and tell a reader nothing.
   */
  rowsEvaluated: number;
  /** Rows with no usable cost (unusable quote / pre-instrumentation). */
  rowsMissingCostR: number;
  /**
   * Evaluated rows whose modeled edge was unknown. These fail closed at every
   * `k` and are counted IN `rowsEvaluated` — an unknown edge is a real block
   * under the net-edge form, not missing data about the cost side.
   */
  rowsMissingGrossR: number;
  /** Evaluated rows the k-INDEPENDENT absolute ceiling blocks; a floor under every sweep row. */
  rowsBlockedByAbsCeiling: number;
  /** The ceiling those rows were tested against (resolved config, not a literal). */
  absCostFracCeiling: number;
  /**
   * Admits under the CURRENTLY DEPLOYED form on the IDENTICAL row set
   * (`rowsEvaluated`) — the baseline every sweep row is read against. Without it
   * a sweep row is a number with no comparator.
   */
  flatFormAdmits: number;
  /** Admits under the deployed form over ALL recorded rows, incl. those with no cost sample. */
  flatFormAdmitsAllRows: number;
  sweep: NetEdgeShadowSweepRow[];
}

/**
 * TRA-4154 — the per-ET-day CELL row. Deliberately LEANER than
 * {@link LiveEnforceCellSummary}: no `costRQuantiles`. A per-day quantile block on
 * 14 gates × 30 days would multiply the payload for a distribution nobody reads
 * per-day, and — worse — a cell-day with two samples would publish a p10/p90 that
 * looks like a distribution. The pooled `byCell` keeps the quantiles; this axis
 * answers WHEN, which is the only thing the pooled one cannot.
 */
export interface LiveEnforceDayCellSummary {
  cell: string;
  evaluated: number;
  blocked: number;
  /** blocked / evaluated; `null` when the cell decided nothing THAT DAY (never 0). */
  blockRate: number | null;
}

/** TRA-4154 — the per-ET-day NOMINATOR-BRANCH row. Lean for the same reason: the
 *  chain-shape means are folded over their own denominators on the pooled axis and
 *  a one-row day would publish a "mean" of a single observation. */
export interface LiveEnforceDaySelectionSummary {
  selection: string;
  evaluated: number;
  blocked: number;
  blockRate: number | null;
}

/**
 * TRA-4154 — rows this gate ruled on THAT DAY which carry no key on a partial
 * axis. Published rather than left to arithmetic because both partial axes here
 * (`byCell`, `bySelection`) are stamped only by some call sites and only since
 * some deploy, so `Σ byCell[].blocked` does NOT reconcile with the day's
 * `blocked` — on the live retained fold read 2026-09-01 that gap is 1759 of 4342
 * cost_bar blocks. An unpublished remainder is how partial coverage reads as a
 * rate (the TRA-3216 shape, and the same reason `blockedUnclassified` exists).
 */
export interface LiveEnforceUnstampedTally {
  evaluated: number;
  blocked: number;
}

/**
 * TRA-4154 (container shared with TRA-3731) — ONE ET DAY of one gate.
 *
 * ## Why this exists
 *
 * `retained.byGate[]` is a 30-day fold and the since-boot `byGate[]` is zeroed by
 * every redeploy, so between them there was no read that could answer **when**. A
 * cell that admitted for fifteen days and has refused every candidate since
 * pools to a mid-range `blockRate` — on the live fold read 2026-09-01,
 * `single_leg_otm::0.50-0.55` reads `blockRate 0.3112` over 20 ET days, which is
 * the arithmetic mean of a working gate and a self-disarmed one and is not a
 * description of either. A self-disarmed sleeve and a quiet market therefore
 * rendered IDENTICALLY on any single day, and TRA-2879's disarm criterion
 * (`avgR < 0 over >= 20 closes`) is structurally unable to fire in the state it
 * exists to detect, because a sleeve admitting nothing produces no closes.
 *
 * ## Where the numbers come from — the TRA-3501 placement question, answered
 *
 * NOTHING new is counted at any call site. This roll re-reads the day dimension
 * that {@link byDay} has always keyed on and that {@link accumulateAllDays}
 * throws away: the pooled `retained.byGate[]` totals and these rows are folded
 * from the SAME `GateTallies` objects, so `Σ byEtDay[].evaluated` equals the
 * gate's `evaluated` exactly, by construction rather than by agreement.
 *
 * That is what makes the TRA-3501 trap inapplicable here. A shadow counter placed
 * downstream of a gate that `continue`s is pinned to zero; this is not a counter,
 * it is a projection of rows {@link apply} already folded — and `apply` is fed by
 * {@link recordLiveEnforceDecision} at the refusal site ITSELF
 * (`signal-engine.ts` `costAwareGateReject`, both the flat-form branch and the
 * net-edge branch, each of which records BEFORE returning the rejection reason).
 * Above that site sit `entry_window`, `contract_floor` and `universe`, which is
 * why a cost-bar day can read `evaluated: 0` on a day the box was up: read those
 * gates' rows for the same day before concluding the bar saw a quiet market.
 *
 * ## Durability
 *
 * Free, and for the same reason. {@link byDay} is rebuilt from the JSONL under
 * `DATA_DIR` by {@link hydrateLiveEnforceGateFromDisk} on every boot, keyed by
 * `etDay` off the persisted row. So this roll survives a redeploy inside the same
 * ET fold exactly as far as the pooled fold does — no further, no less. Read
 * `durability.ephemeral` first: TRUE ⇒ neither view is durable.
 */
export interface LiveEnforceGateDaySummary {
  /** ET calendar day (America/New_York, YYYY-MM-DD). */
  etDay: string;
  /**
   * Rows this gate ruled on that day. `0` means this gate recorded NOTHING that
   * day — which is a real and common state (the box was down, the sleeve was
   * dark, or an upstream gate ate the whole population) and is NOT the same as
   * the day being absent from the fold. Every day in `retained.etDays` gets a row
   * on every gate for precisely that reason.
   */
  evaluated: number;
  blocked: number;
  /** blocked / evaluated; **`null` when the gate ruled on nothing that day** — never 0. */
  blockRate: number | null;
  /**
   * TRA-4631 — the per-day CALL-SITE split, on **`cost_bar` only**; `null` on
   * every other gate.
   *
   * On `cost_bar` the scope key is the calling sleeve's structure — bounded
   * (3 known call sites, see {@link COST_BAR_CALL_SITE_SCOPES}) and 1:1 with
   * the source site that evaluated the candidate — so publishing it per day is
   * cheap and it is the axis that makes the ENTRY-SITE DENOMINATOR readable:
   * `runRelativeValueScan`'s rows bypass `entry_window`, and pooling them with
   * the OTM entry site's rows is how TRA-4622's "4002 of 4002" headline
   * overcounted a 3577-row population by 425. The three known call-site scopes
   * are ALWAYS present (seeded at 0), so "the entry site admitted nothing to
   * this gate today" is a readable `evaluated: 0` on the `single_leg_otm` row,
   * never an absence a reader has to notice — that zero is exactly the
   * discriminating state (2026-09-09/09-10) the pooled counter rendered
   * invisible.
   *
   * ⚠️ It stays `null` on every OTHER gate for the original reason: on
   * `spread` and `universe` the scope key is the underlying symbol — UNBOUNDED
   * cardinality (178 on `universe` alone, read 2026-09-01), and crossed with 30
   * retained days that is a ~250 KB payload for a split nothing asks for. The
   * pooled `byScope` on the gate is unchanged.
   */
  byScope: LiveEnforceScopeSummary[] | null;
  /**
   * TRA-4631 (AC3) — rows this day whose scope is missing from `byScope`'s
   * rows. Non-null exactly where `byScope` is. `scope` is a REQUIRED field
   * (the write path demands it and the hydrate drops a row without one), so
   * there is no unstamped pre-fix population and this reads `0/0` by
   * construction — published anyway so "nothing was silently pooled" is a
   * value a grader can read rather than a property they must prove from the
   * code, and so a future fold defect surfaces as a nonzero here instead of as
   * silent undercounting.
   */
  scopeUnstamped: LiveEnforceUnstampedTally | null;
  /** Per-tape-cell split for the day, admits included. **The AC2/AC3 axis.** */
  byCell: LiveEnforceDayCellSummary[];
  /** Per-nominator-branch split for the day, admits included. */
  bySelection: LiveEnforceDaySelectionSummary[];
  /** Per-reason split of the day's BLOCKS; `share` is of the DAY's blocked total. */
  byReason: LiveEnforceReasonSummary[];
  /** The day's blocks carrying no `reasonCode` — `byReason`'s missing denominator. */
  blockedUnclassified: number;
  /** The day's rows carrying no `cell` stamp — `byCell`'s missing denominator. */
  cellUnstamped: LiveEnforceUnstampedTally;
  /** The day's rows carrying no `nominator` stamp — `bySelection`'s missing denominator. */
  selectionUnstamped: LiveEnforceUnstampedTally;
}

export interface LiveEnforceGateSummary {
  gate: LiveEnforceGate;
  evaluated: number;
  blocked: number;
  blockRate: number | null;
  /**
   * TRA-4154 — the per-ET-day roll of this gate, ascending by day. **This is the
   * axis that answers WHEN**; see {@link LiveEnforceGateDaySummary}.
   *
   * On `retained.byGate[]` it carries one row for EVERY day in
   * `retained.etDays`, including days this gate recorded nothing on — so
   * "silent that day" is a value you can read rather than an absence you have to
   * notice. On the per-day `byGate[]` view it is the single row for that day
   * (redundant there, published anyway so the field is never `null` and can
   * never be misread as "not deployed").
   */
  byEtDay: LiveEnforceGateDaySummary[];
  /** Per-scope split, busiest first. */
  byScope: LiveEnforceScopeSummary[];
  /** Per-reason split of the BLOCKS, heaviest first (TRA-3216). */
  byReason: LiveEnforceReasonSummary[];
  /**
   * TRA-3483 (D2) — BLOCKED rows in this fold carrying NO `reasonCode`, i.e. rows
   * `byReason` cannot see. `share` on every `byReason` row is of `blocked`, which
   * INCLUDES these, so a nonzero value here says the rows do not sum to 1 by
   * design and the gap is coverage, not a residual bucket. On the retained fold
   * this is the 1759 pre-stamping blocks that made `gross_negative 0.0881` read
   * as a rate.
   */
  blockedUnclassified: number;
  /** Per-live-book split, busiest first (TRA-3216). */
  byBook: LiveEnforceBookSummary[];
  /** Per-tape-cell split, busiest first; admits included (TRA-3391). */
  byCell: LiveEnforceCellSummary[];
  /**
   * TRA-3510 — per-NOMINATOR-BRANCH split, busiest first; admits included. This
   * is the axis that makes a zero on a delta gate readable — see
   * {@link LiveEnforceRecord.nominator}. An EMPTY array on a gate with
   * `evaluated > 0` means those rows predate the axis or came from a non-OTM
   * path; it never means "one branch produced them all".
   */
  bySelection: LiveEnforceSelectionSummary[];
  /**
   * TRA-3483 — the `costR` distribution over this fold. Non-null on `cost_bar`
   * (even at `n: 0`, so "not instrumented" and "instrumented, no rows yet" stay
   * distinguishable); null on every gate that records no cost.
   */
  costRQuantiles: CostRQuantiles | null;
  /**
   * TRA-4745 — the `grossR` distribution over this fold, with the realised
   * `barR` and `shortfallR` beside it. Non-null on `cost_bar` on the same terms
   * as `costRQuantiles`.
   *
   * ⭐ THE BLOCK TO GRADE on this gate, and the discriminator the witness asked
   * for: `grossR` healthy while the band still blocks ⇒ a non-cost refusal is
   * being stamped `cost_bar` (remedy in the gate's attribution); `grossR` under
   * the bar ⇒ the edge estimator is what collapsed (remedy in the signal team).
   * If `rowsCompared` is 0 against a nonzero `blocked`, it is NEITHER: those rows
   * refused on a precondition and no inequality ran.
   */
  grossRQuantiles: GrossRQuantiles | null;
  /**
   * TRA-4745 — of the rows carrying a realised predicate, how many the gate
   * COMPARED vs short-circuited, and how many carry no stamp at all.
   * `rowsCompared + rowsShortCircuited + predicateUnstamped` is the gate's cost
   * sample count. Non-null on `cost_bar` only.
   */
  rowsCompared: number | null;
  rowsShortCircuited: number | null;
  predicateUnstamped: number | null;
  /**
   * TRA-4745 — the per-UNDERLYING fold for `cost_bar`, busiest first. Non-null on
   * `cost_bar` only (`[]` at n=0, never omitted).
   *
   * ⛔ NOT `bySymbol` — see {@link LiveEnforceCostSymbolSummary}. That key is the
   * TRA-4269 ratified-set counterfactual and stays `null` here on purpose.
   */
  costBySymbol: LiveEnforceCostSymbolSummary[] | null;
  /**
   * TRA-4745 — `cost_bar` rows carrying NO underlying stamp. READ THIS FIRST:
   * `cost_bar` never recorded a symbol before this ticket (its `scope` key is the
   * STRUCTURE), so on the first retained folds after this deploy essentially the
   * whole 30-day population sits here and `costBySymbol` is short. That is
   * COVERAGE, not a quiet universe.
   */
  costRowsMissingSymbol: number | null;
  /** TRA-3483 — the counterfactual k-sweep. Non-null on `cost_bar` only. */
  netEdgeShadow: NetEdgeShadowSummary | null;
  /**
   * TRA-4269 — the RATIFIED-SET COUNTERFACTUAL. These five fields are ALWAYS
   * non-null on `universe` (`0` / `[]` at n=0) and null on every other gate, so
   * "0 would-block" can never read as "not deployed" or as a build from before
   * the field.
   *
   * "Restoring the allowlist would have refused N of M entries, in these names"
   * reads straight off the row: N = `wouldBlockUnderRatifiedSet`,
   * M = `counterfactualEvaluated`, and the names are the `bySymbol` rows with
   * `inRatifiedSet: false`.
   *
   * M is NOT `evaluated`. Rows recorded while the gate was RESTRICTED carry no
   * counterfactual and fall outside M; `evaluated − counterfactualEvaluated` is
   * that restricted (or pre-TRA-4269) remainder.
   *
   * `ratifiedSet` is the set NEW rows are stamped against
   * (`OPTION_LIVE_OTM_UNIVERSE_DEFAULT`).
   */
  ratifiedSet: string[] | null;
  /** TRA-4269 — rows carrying the counterfactual (M). */
  counterfactualEvaluated: number | null;
  /** TRA-4269 — of those, the rows the ratified set would have refused (N). */
  wouldBlockUnderRatifiedSet: number | null;
  /**
   * TRA-4269 — counterfactual rows stamped under a set OTHER than `ratifiedSet`.
   * `0` unless the default changed inside this fold. Nonzero ⇒ N and M mix two
   * definitions of the set, and neither can be quoted as-is.
   */
  counterfactualUnderOtherSet: number | null;
  /** TRA-4269 — every counterfactual row by symbol, would-block names included, busiest first. */
  bySymbol: LiveEnforceRatifiedSymbolSummary[] | null;
}

/** TRA-4269 — one name's rows under the ratified-set counterfactual. */
export interface LiveEnforceRatifiedSymbolSummary {
  symbol: string;
  evaluated: number;
  /** FALSE ⇒ the ratified allowlist would have refused every one of these rows. */
  inRatifiedSet: boolean;
}

export interface LiveEnforceDurability {
  /** Resolved append target. `null` = memory-only: no boot hydrate ran, NOTHING is durable. */
  dataDir: string | null;
  /** TRUE ⇒ every count in this payload dies on the next redeploy (fix = DATA_DIR=/data). */
  ephemeral: boolean;
  /** Records recovered FROM DISK at boot. Distinguishes a real floor from this-uptime-only. */
  hydratedRecords: number;
  hydratedDays: number;
  /** Appends that threw and were SWALLOWED. > 0 ⇒ the counters overstate what is on disk. */
  appendErrors: number;
  lastAppendError: string | null;
}

export interface LiveEnforceSummary {
  /** Total decisions recorded (live + hydrated, across retained days). */
  decisionsRecorded: number;
  /** Per-gate fold for the requested ET day. */
  byGate: LiveEnforceGateSummary[];
  /** Same fold across EVERY retained ET day (a one-day counter self-clears at midnight). */
  retained: {
    etDays: string[];
    retentionDays: number;
    byGate: LiveEnforceGateSummary[];
    /**
     * TRA-4748 — `etDays` read against the NYSE calendar. `etDays` alone cannot
     * say whether an ABSENT day was a weekend/holiday or a dead recorder, and
     * those two have different remedies; `sessionCoverage.missingSessions`
     * non-empty is the alarm. See {@link LiveEnforceSessionCoverage} — the
     * comparison is ONE-DIRECTIONAL on purpose.
     */
    sessionCoverage: LiveEnforceSessionCoverage;
  };
  durability: LiveEnforceDurability;
  lastDecisionAt: number | null;
}

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// ── TRA-3483 — quantiles and the counterfactual sweep ────────────────────────

/**
 * Nearest-rank quantile on an ALREADY-SORTED ascending array. Nearest-rank (not
 * linear interpolation) on purpose: every value returned is a value that actually
 * occurred, so `p50` names a real candidate's cost and can be traced back to a
 * decision rather than being a synthetic point between two of them.
 */
function quantileSorted(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

/** Median of an arbitrary (unsorted) sample, or null when empty. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  return quantileSorted([...values].sort((a, b) => a - b), 0.5);
}

function quantileBlock(values: number[]): QuantileBlock {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const q = (p: number): number | null => {
    const v = quantileSorted(sorted, p);
    return v === null ? null : round(v, 6);
  };
  return {
    n,
    p10: q(0.10),
    p25: q(0.25),
    p50: q(0.50),
    p75: q(0.75),
    p90: q(0.90),
    min: n > 0 ? round(sorted[0]!, 6) : null,
    max: n > 0 ? round(sorted[n - 1]!, 6) : null,
    mean: n > 0 ? round(sorted.reduce((a, b) => a + b, 0) / n, 6) : null,
  };
}

/** Fold a sample list into the published `costR` distribution + its decomposition. */
function costRQuantiles(samples: CostSample[], rowsMissingCostR: number, samplesDropped: number): CostRQuantiles {
  const shares = samples
    .filter((s) => s.costR !== 0 && Number.isFinite(s.spreadR / s.costR))
    .map((s) => s.spreadR / s.costR);
  const medianShare = median(shares);
  return {
    ...quantileBlock(samples.map((s) => s.costR)),
    spreadR: quantileBlock(samples.map((s) => s.spreadR)),
    feeR: quantileBlock(samples.map((s) => s.feeR)),
    medianSpreadShareOfCost: medianShare === null ? null : round(medianShare),
    rowsMissingCostR,
    samplesDropped,
  };
}

// ── TRA-4745 — the side that actually decides, and the comparison it ran ──────

/**
 * Fold a sample list into the published `grossR` distribution.
 *
 * `grossR: null` rows are EXCLUDED from the quantiles and COUNTED in
 * `rowsMissingGrossR` — the same contract `costRQuantiles` holds for a missing
 * cost. An unknown edge is not a zero edge; it is an unmeasured cell, and those
 * rows never reached a comparison at all.
 *
 * `barR` and `shortfallR` come off the realised predicate rather than from the
 * current config, so a fold that spans a bar retune publishes the spread instead
 * of one number that was true for part of it.
 */
function grossRQuantiles(samples: CostSample[]): GrossRQuantiles {
  const gross: number[] = [];
  let rowsMissingGrossR = 0;
  const bars: number[] = [];
  const shortfalls: number[] = [];
  for (const s of samples) {
    if (s.grossR === null || !Number.isFinite(s.grossR)) rowsMissingGrossR += 1;
    else gross.push(s.grossR);
    const p = s.predicate;
    if (p && p.compared && p.lhs !== null && p.rhs !== null) {
      bars.push(p.rhs);
      // `rhs − lhs` only on the `>=` (flat) form: on the net-edge form the sides
      // are costR and k·grossR, whose difference is NOT the `byReason` shortfall.
      if (p.op === '>=') shortfalls.push(p.rhs - p.lhs);
    }
  }
  return {
    ...quantileBlock(gross),
    rowsMissingGrossR,
    barR: bars.length > 0 ? quantileBlock(bars) : null,
    shortfallR: shortfalls.length > 0 ? quantileBlock(shortfalls) : null,
  };
}

/** Render a realised comparison the way a reader would write it by hand. */
function predicateStatement(s: CostSample, p: LiveEnforceGatePredicate): string {
  const outcome = s.blocked ? 'BLOCK' : 'ADMIT';
  if (!p.compared) {
    return `NO COMPARISON — short-circuited on \`${p.shortCircuit ?? 'unknown'}\` ⇒ ${outcome}`;
  }
  return `${p.lhsLabel.split(' —')[0]} ${p.lhs!.toFixed(4)} ${p.op} ${p.rhsLabel.split(' —')[0]} ${p.rhs!.toFixed(4)} ⇒ ${outcome}`;
}

/**
 * TRA-4745 — ONE sampled BLOCKED row per ET day out of `samples`, each rendered
 * with the comparison the gate actually ran.
 *
 * Blocked rows only: an admit's predicate is not what anyone is trying to
 * explain, and mixing them would let a day be represented by the one candidate
 * that got through. The FIRST blocked row of each day is taken (samples are
 * appended in decision order), so the choice is deterministic and re-reading the
 * route twice on the same fold returns the same rows.
 */
function predicateSamples(samples: CostSample[]): LiveEnforcePredicateSample[] {
  const perDay = new Map<string, LiveEnforcePredicateSample>();
  for (const s of samples) {
    if (!s.blocked || s.predicate === null) continue;
    if (perDay.has(s.etDay)) continue;
    const p = s.predicate;
    perDay.set(s.etDay, {
      etDay: s.etDay,
      statement: predicateStatement(s, p),
      form: p.form,
      compared: p.compared,
      lhsLabel: p.lhsLabel,
      lhs: p.lhs === null ? null : round(p.lhs, 6),
      op: p.op,
      rhsLabel: p.rhsLabel,
      rhs: p.rhs === null ? null : round(p.rhs, 6),
      shortfallR:
        p.compared && p.op === '>=' && p.lhs !== null && p.rhs !== null
          ? round(p.rhs - p.lhs, 6)
          : null,
      shortCircuit: p.shortCircuit,
      reasonCode: s.reasonCode,
      costR: Number.isFinite(s.costR) ? round(s.costR, 6) : null,
      symbol: s.symbol,
    });
  }
  return [...perDay.values()].sort((a, b) => a.etDay.localeCompare(b.etDay));
}

/** TRA-4745 — compared / short-circuited split over a sample list. */
function predicateCoverage(samples: CostSample[]): {
  rowsCompared: number;
  rowsShortCircuited: number;
  predicateUnstamped: number;
} {
  let rowsCompared = 0;
  let rowsShortCircuited = 0;
  let predicateUnstamped = 0;
  for (const s of samples) {
    if (s.predicate === null) predicateUnstamped += 1;
    else if (s.predicate.compared) rowsCompared += 1;
    else rowsShortCircuited += 1;
  }
  return { rowsCompared, rowsShortCircuited, predicateUnstamped };
}

/** Options for the counterfactual sweep — resolved config, never literals. */
export interface NetEdgeShadowOptions {
  /** The `k` grid. Defaults to {@link NET_EDGE_SHADOW_K_SWEEP}. */
  ks?: readonly number[];
  /** The k-independent absolute ceiling the sweep replays. Defaults to the shipped config. */
  absCostFracCeiling?: number;
}

/**
 * TRA-3483 I2 — fold the recorded decisions into the counterfactual sweep.
 *
 * PURE and READ-ONLY. It replays {@link netEdgeShadowAdmits} — the same admit
 * order the real form uses — over rows that a DIFFERENT form already decided. The
 * `flatFormAdmits` baseline is taken from the same row set so the comparison is
 * paired, not two populations.
 */
function netEdgeShadow(
  tallies: GateTallies,
  etDay: string | null,
  etDays: string[],
  rowsRecorded: number,
  rowsBlocked: number,
  opts: NetEdgeShadowOptions,
): NetEdgeShadowSummary {
  const ks = opts.ks ?? NET_EDGE_SHADOW_K_SWEEP;
  const ceiling = opts.absCostFracCeiling ?? DEFAULT_NET_EDGE_BAR_CONFIG.absCostFracCeiling;
  const samples = tallies.costSamples;
  const sweep: NetEdgeShadowSweepRow[] = ks.map((k) => {
    const admitted = samples.filter((s) => netEdgeShadowAdmits(s, k, ceiling));
    const netR = admitted.map((s) => (s.grossR ?? Number.NaN) - s.costR).filter((v) => Number.isFinite(v));
    const med = median(netR);
    return {
      k,
      admits: admitted.length,
      admitRate: samples.length > 0 ? round(admitted.length / samples.length) : null,
      medianNetR_admitted: med === null ? null : round(med, 6),
    };
  });
  return {
    etDay,
    etDays,
    rowsRecorded,
    rowsEvaluated: samples.length,
    rowsMissingCostR: tallies.costRowsMissing,
    rowsMissingGrossR: samples.filter((s) => s.grossR === null).length,
    rowsBlockedByAbsCeiling: samples.filter((s) => s.costFracOfPremium > ceiling).length,
    absCostFracCeiling: ceiling,
    // The DEPLOYED form's verdict on the identical rows: `blocked === false`.
    flatFormAdmits: samples.filter((s) => !s.blocked).length,
    flatFormAdmitsAllRows: rowsRecorded - rowsBlocked,
    sweep,
  };
}

/**
 * TRA-4154 — fold ONE gate's ONE-DAY tallies into a {@link LiveEnforceGateDaySummary}.
 *
 * `tallies === undefined` is the "this gate recorded nothing that day" case and
 * folds to an all-zero row with `blockRate: null` — NOT an omitted row. The
 * caller drives this off `etDays`, so the roll's length is the fold's length on
 * every gate and a silent day is readable instead of inferable.
 */
function foldGateDay(
  gate: LiveEnforceGate,
  etDay: string,
  tallies: GateTallies | undefined,
): LiveEnforceGateDaySummary {
  const t = tallies ?? emptyTallies();

  // The day's totals are summed from `byScope`, which every record bumps exactly
  // once — the same denominator the pooled fold uses, which is what makes
  // `Σ byEtDay[].evaluated === gate.evaluated` an identity. The per-scope ROWS
  // are not published (see the interface: unbounded symbol cardinality); only
  // the total is taken from them. `byCell` / `bySelection` are bumped AT MOST
  // once per record, which is what makes the two `*Unstamped` remainders below
  // exact subtractions rather than estimates.
  let evaluated = 0;
  let blocked = 0;
  for (const s of t.byScope.values()) {
    evaluated += s.evaluated;
    blocked += s.blocked;
  }

  // TRA-4631 — the per-day call-site split, `cost_bar` only (bounded scope
  // cardinality: the scope is the calling sleeve's structure). The known call
  // sites are seeded at 0 FIRST so the entry site's silent day publishes an
  // explicit `evaluated: 0` row; scopes actually recorded (known or not) then
  // overwrite / extend the seed, so an unforeseen caller still shows up.
  let byScope: LiveEnforceScopeSummary[] | null = null;
  let scopeUnstamped: LiveEnforceUnstampedTally | null = null;
  if (gate === 'cost_bar') {
    const rows = new Map<string, LiveEnforceScopeSummary>();
    for (const scope of COST_BAR_CALL_SITE_SCOPES) {
      rows.set(scope, { scope, evaluated: 0, blocked: 0, blockRate: null });
    }
    let scopeEvaluated = 0;
    let scopeBlocked = 0;
    for (const [scope, s] of t.byScope.entries()) {
      scopeEvaluated += s.evaluated;
      scopeBlocked += s.blocked;
      rows.set(scope, {
        scope,
        evaluated: s.evaluated,
        blocked: s.blocked,
        blockRate: s.evaluated > 0 ? round(s.blocked / s.evaluated) : null,
      });
    }
    byScope = [...rows.values()].sort(
      (a, b) => b.evaluated - a.evaluated || a.scope.localeCompare(b.scope),
    );
    // Identity by construction (the day totals above are summed from the SAME
    // `byScope` map), so this is 0/0 unless the fold itself regresses — see the
    // interface doc for why it is published anyway (AC3).
    scopeUnstamped = {
      evaluated: Math.max(0, evaluated - scopeEvaluated),
      blocked: Math.max(0, blocked - scopeBlocked),
    };
  }

  let cellEvaluated = 0;
  let cellBlocked = 0;
  const byCell: LiveEnforceDayCellSummary[] = [];
  for (const [cell, c] of t.byCell.entries()) {
    cellEvaluated += c.evaluated;
    cellBlocked += c.blocked;
    byCell.push({
      cell,
      evaluated: c.evaluated,
      blocked: c.blocked,
      blockRate: c.evaluated > 0 ? round(c.blocked / c.evaluated) : null,
    });
  }
  byCell.sort((a, b) => b.evaluated - a.evaluated || a.cell.localeCompare(b.cell));

  let selEvaluated = 0;
  let selBlocked = 0;
  const bySelection: LiveEnforceDaySelectionSummary[] = [];
  for (const [selection, s] of t.bySelection.entries()) {
    selEvaluated += s.evaluated;
    selBlocked += s.blocked;
    bySelection.push({
      selection,
      evaluated: s.evaluated,
      blocked: s.blocked,
      blockRate: s.evaluated > 0 ? round(s.blocked / s.evaluated) : null,
    });
  }
  bySelection.sort((a, b) => b.evaluated - a.evaluated || a.selection.localeCompare(b.selection));

  // `share` is of the DAY's blocked total (which includes the unclassified rows),
  // never of the `byReason` rows' own sum — renormalizing would make a day with
  // partial coverage read as a complete classification, which is the exact
  // defect `blockedUnclassified` was added to expose on the pooled fold.
  const byReason: LiveEnforceReasonSummary[] = [];
  for (const [reasonCode, r] of t.byReason.entries()) {
    byReason.push({
      reasonCode,
      blocked: r.blocked,
      share: blocked > 0 ? round(r.blocked / blocked) : null,
    });
  }
  byReason.sort((a, b) => b.blocked - a.blocked || a.reasonCode.localeCompare(b.reasonCode));

  return {
    etDay,
    evaluated,
    blocked,
    blockRate: evaluated > 0 ? round(blocked / evaluated) : null,
    byScope,
    scopeUnstamped,
    byCell,
    bySelection,
    byReason,
    blockedUnclassified: t.blockedUnclassified,
    cellUnstamped: {
      evaluated: Math.max(0, evaluated - cellEvaluated),
      blocked: Math.max(0, blocked - cellBlocked),
    },
    selectionUnstamped: {
      evaluated: Math.max(0, evaluated - selEvaluated),
      blocked: Math.max(0, blocked - selBlocked),
    },
  };
}

/** Fold a gate->tallies map for one or more days into the per-gate rows. */
function foldGates(
  acc: Map<LiveEnforceGate, GateTallies>,
  etDay: string | null,
  etDays: string[],
  shadowOpts: NetEdgeShadowOptions,
  // TRA-4154 — the UNPOOLED source for the per-day roll. `acc` has already lost
  // the day dimension (see `accumulateAllDays`), so the roll cannot be derived
  // from it; it is folded from the same per-day `GateTallies` objects `acc` was
  // built out of, which is what makes `Σ byEtDay[].evaluated === evaluated` hold
  // by construction rather than by two code paths agreeing.
  perDay: Map<string, Map<LiveEnforceGate, GateTallies>>,
): LiveEnforceGateSummary[] {
  const out: LiveEnforceGateSummary[] = [];
  for (const gate of GATES) {
    const tallies = acc.get(gate) ?? emptyTallies();
    let evaluated = 0;
    let blocked = 0;
    const byScope: LiveEnforceScopeSummary[] = [];
    for (const [scope, t] of tallies.byScope.entries()) {
      evaluated += t.evaluated;
      blocked += t.blocked;
      byScope.push({
        scope,
        evaluated: t.evaluated,
        blocked: t.blocked,
        blockRate: t.evaluated > 0 ? round(t.blocked / t.evaluated) : null,
      });
    }
    byScope.sort((a, b) => b.evaluated - a.evaluated);

    const byBook: LiveEnforceBookSummary[] = [];
    for (const [book, t] of tallies.byBook.entries()) {
      byBook.push({
        book,
        evaluated: t.evaluated,
        blocked: t.blocked,
        blockRate: t.evaluated > 0 ? round(t.blocked / t.evaluated) : null,
      });
    }
    byBook.sort((a, b) => b.evaluated - a.evaluated);

    // `share` denominator is the gate's BLOCKED total (from byScope, which counts
    // every row) — NOT the sum of the byReason rows. Using the rows' own sum would
    // silently renormalize away any block that carried no classification, making
    // partial coverage read as complete.
    const byReason: LiveEnforceReasonSummary[] = [];
    for (const [reasonCode, t] of tallies.byReason.entries()) {
      byReason.push({
        reasonCode,
        blocked: t.blocked,
        share: blocked > 0 ? round(t.blocked / blocked) : null,
      });
    }
    byReason.sort((a, b) => b.blocked - a.blocked);

    // TRA-3483 — bucket the cost samples by cell ONCE rather than filtering the
    // full list per cell (that is O(cells × rows) on a 20k-row day).
    const samplesByCell = new Map<string, CostSample[]>();
    for (const s of tallies.costSamples) {
      if (s.cell === null) continue;
      const list = samplesByCell.get(s.cell);
      if (list) list.push(s);
      else samplesByCell.set(s.cell, [s]);
    }

    const byCell: LiveEnforceCellSummary[] = [];
    for (const [cell, t] of tallies.byCell.entries()) {
      const cellSamples = samplesByCell.get(cell) ?? [];
      // TRA-4745 — the predicate coverage split for this cell.
      const coverage = predicateCoverage(cellSamples);
      byCell.push({
        cell,
        evaluated: t.evaluated,
        blocked: t.blocked,
        blockRate: t.evaluated > 0 ? round(t.blocked / t.evaluated) : null,
        // Missing = this cell's rows that produced no sample. Derived from the
        // cell's own `evaluated`, so a cell whose quotes were unusable shows the
        // hole instead of publishing quantiles over the surviving minority.
        costRQuantiles:
          cellSamples.length > 0
            ? costRQuantiles(cellSamples, Math.max(0, t.evaluated - cellSamples.length), 0)
            : null,
        // TRA-4745 — the side that decides, sampled on the SAME rows as the cost
        // block so the two are paired and a reader can hold them against each
        // other row-for-row.
        grossRQuantiles: cellSamples.length > 0 ? grossRQuantiles(cellSamples) : null,
        predicateSamples: predicateSamples(cellSamples),
        predicateUnstamped: coverage.predicateUnstamped,
        rowsCompared: coverage.rowsCompared,
        rowsShortCircuited: coverage.rowsShortCircuited,
      });
    }
    byCell.sort((a, b) => b.evaluated - a.evaluated || a.cell.localeCompare(b.cell));

    // TRA-4745 — the UNDERLYING axis. Counts come from `byUnderlying` (bumped on
    // every stamped row, admits included) while the distributions come from the
    // cost samples, so a symbol whose quotes were unusable still publishes its
    // evaluated/blocked instead of vanishing from the join.
    const samplesBySymbol = new Map<string, CostSample[]>();
    for (const s of tallies.costSamples) {
      if (s.symbol === null) continue;
      const list = samplesBySymbol.get(s.symbol);
      if (list) list.push(s);
      else samplesBySymbol.set(s.symbol, [s]);
    }
    const costBySymbol: LiveEnforceCostSymbolSummary[] = [];
    for (const [symbol, t] of tallies.byUnderlying.entries()) {
      const symSamples = samplesBySymbol.get(symbol) ?? [];
      const gross = symSamples.length > 0 ? grossRQuantiles(symSamples) : null;
      costBySymbol.push({
        symbol,
        evaluated: t.evaluated,
        blocked: t.blocked,
        blockRate: t.evaluated > 0 ? round(t.blocked / t.evaluated) : null,
        costR: symSamples.length > 0 ? quantileBlock(symSamples.map((s) => s.costR)) : null,
        grossR: gross === null ? null : { n: gross.n, p10: gross.p10, p25: gross.p25, p50: gross.p50, p75: gross.p75, p90: gross.p90, min: gross.min, max: gross.max, mean: gross.mean },
        rowsMissingGrossR: gross?.rowsMissingGrossR ?? 0,
        rowsCompared: predicateCoverage(symSamples).rowsCompared,
      });
    }
    costBySymbol.sort(
      (a, b) => b.evaluated - a.evaluated || a.symbol.localeCompare(b.symbol),
    );

    // TRA-3510 — the nominator axis. Means are derived HERE from the retained
    // sums over `rowsWithChainShape`, never from `evaluated`: a fold that spans
    // the deploy boundary holds rows that carry no chain shape, and dividing by
    // `evaluated` would silently deflate both means toward zero.
    const bySelection: LiveEnforceSelectionSummary[] = [];
    for (const [selection, t] of tallies.bySelection.entries()) {
      bySelection.push({
        selection,
        evaluated: t.evaluated,
        blocked: t.blocked,
        blockRate: t.evaluated > 0 ? round(t.blocked / t.evaluated) : null,
        rowsWithChainShape: t.rowsWithChainShape,
        meanCheapConsidered:
          t.rowsWithChainShape > 0 ? round(t.cheapConsideredSum / t.rowsWithChainShape) : null,
        meanCheapInBand:
          t.rowsWithChainShape > 0 ? round(t.cheapInBandSum / t.rowsWithChainShape) : null,
        // TRA-3619 — the pre-cheapness pair, over its OWN denominator.
        rowsWithStrikeShape: t.rowsWithStrikeShape,
        meanStrikesConsidered:
          t.rowsWithStrikeShape > 0 ? round(t.strikesConsideredSum / t.rowsWithStrikeShape) : null,
        meanStrikesInBand:
          t.rowsWithStrikeShape > 0 ? round(t.strikesInBandSum / t.rowsWithStrikeShape) : null,
      });
    }
    bySelection.sort((a, b) => b.evaluated - a.evaluated || a.selection.localeCompare(b.selection));

    // TRA-3483 — cost instrumentation is `cost_bar`-only. Published as an object
    // at `n: 0` rather than omitted on that gate, so "the recorder is not
    // deployed" cannot read the same as "deployed, no live candidates yet" —
    // the same distinction the zero gate rows exist for.
    const instrumented = gate === 'cost_bar';
    // TRA-4745 — the gate-wide predicate coverage split, over the same sample
    // list the quantiles are folded from.
    const gatePredicateCoverage = predicateCoverage(tallies.costSamples);
    // TRA-4269 — the ratified-set counterfactual: `0` / `[]` on `universe` at
    // n=0 (never omitted), and null on every other gate.
    const counterfactual = gate === 'universe' ? foldRatifiedCounterfactual(tallies) : null;

    out.push({
      gate,
      evaluated,
      blocked,
      blockRate: evaluated > 0 ? round(blocked / evaluated) : null,
      // TRA-4154 — driven off `etDays`, not off the keys `perDay` happens to hold
      // for this gate: a day on which this gate recorded nothing must publish a
      // zero row, not vanish. `etDays` is ascending on both callers.
      byEtDay: etDays.map((d) => foldGateDay(gate, d, perDay.get(d)?.get(gate))),
      byScope,
      byReason,
      blockedUnclassified: tallies.blockedUnclassified,
      byBook,
      byCell,
      bySelection,
      costRQuantiles: instrumented
        ? costRQuantiles(tallies.costSamples, tallies.costRowsMissing, tallies.costSamplesDropped)
        : null,
      // TRA-4745 — same `cost_bar`-only contract as `costRQuantiles`: published
      // at `n: 0` rather than omitted, so "not deployed" and "deployed, no rows
      // yet" stay distinguishable.
      grossRQuantiles: instrumented ? grossRQuantiles(tallies.costSamples) : null,
      rowsCompared: instrumented ? gatePredicateCoverage.rowsCompared : null,
      rowsShortCircuited: instrumented ? gatePredicateCoverage.rowsShortCircuited : null,
      predicateUnstamped: instrumented ? gatePredicateCoverage.predicateUnstamped : null,
      costBySymbol: instrumented ? costBySymbol : null,
      costRowsMissingSymbol: instrumented ? tallies.symbolRowsMissing : null,
      netEdgeShadow: instrumented
        ? netEdgeShadow(tallies, etDay, etDays, evaluated, blocked, shadowOpts)
        : null,
      ratifiedSet: counterfactual?.ratifiedSet ?? null,
      counterfactualEvaluated: counterfactual?.counterfactualEvaluated ?? null,
      wouldBlockUnderRatifiedSet: counterfactual?.wouldBlockUnderRatifiedSet ?? null,
      counterfactualUnderOtherSet: counterfactual?.counterfactualUnderOtherSet ?? null,
      bySymbol: counterfactual?.bySymbol ?? null,
    });
  }
  return out;
}

/** TRA-4269 — fold one gate's counterfactual tallies into the `universe` row's five fields. */
function foldRatifiedCounterfactual(tallies: GateTallies): {
  ratifiedSet: string[];
  counterfactualEvaluated: number;
  wouldBlockUnderRatifiedSet: number;
  counterfactualUnderOtherSet: number;
  bySymbol: LiveEnforceRatifiedSymbolSummary[];
} {
  let counterfactualEvaluated = 0;
  let wouldBlockUnderRatifiedSet = 0;
  const bySymbol: LiveEnforceRatifiedSymbolSummary[] = [];
  for (const t of tallies.byRatifiedSymbol.values()) {
    counterfactualEvaluated += t.evaluated;
    if (!t.inRatifiedSet) wouldBlockUnderRatifiedSet += t.evaluated;
    bySymbol.push({ symbol: t.symbol, evaluated: t.evaluated, inRatifiedSet: t.inRatifiedSet });
  }
  bySymbol.sort(
    (a, b) =>
      b.evaluated - a.evaluated
      || a.symbol.localeCompare(b.symbol)
      || Number(a.inRatifiedSet) - Number(b.inRatifiedSet),
  );
  const current = OPTION_LIVE_OTM_UNIVERSE_DEFAULT.join(',');
  let counterfactualUnderOtherSet = 0;
  for (const [set, n] of tallies.byRatifiedSet.entries()) {
    if (set !== current) counterfactualUnderOtherSet += n;
  }
  return {
    ratifiedSet: [...OPTION_LIVE_OTM_UNIVERSE_DEFAULT],
    counterfactualEvaluated,
    wouldBlockUnderRatifiedSet,
    counterfactualUnderOtherSet,
    bySymbol,
  };
}

/** Merge one axis map into an accumulator. */
function mergeAxis(into: Map<string, GateScopeTally>, from: Map<string, GateScopeTally>): void {
  for (const [key, t] of from.entries()) {
    const cur = into.get(key) ?? { evaluated: 0, blocked: 0 };
    cur.evaluated += t.evaluated;
    cur.blocked += t.blocked;
    into.set(key, cur);
  }
}

/**
 * TRA-3510 — merge the selection axis. Separate from {@link mergeAxis} because
 * the chain-shape SUMS and their own row denominator have to travel with the
 * counters; folding this axis with `mergeAxis` would drop them and publish
 * `meanCheapInBand: null` on every retained row.
 */
function mergeSelectionAxis(
  into: Map<string, GateSelectionTally>,
  from: Map<string, GateSelectionTally>,
): void {
  for (const [key, t] of from.entries()) {
    const cur = into.get(key) ?? emptySelectionTally();
    cur.evaluated += t.evaluated;
    cur.blocked += t.blocked;
    cur.cheapConsideredSum += t.cheapConsideredSum;
    cur.cheapInBandSum += t.cheapInBandSum;
    cur.rowsWithChainShape += t.rowsWithChainShape;
    // TRA-3619 — the strike pair travels with its own denominator, or the
    // retained view would publish `meanStrikesInBand: null` on every row.
    cur.strikesConsideredSum += t.strikesConsideredSum;
    cur.strikesInBandSum += t.strikesInBandSum;
    cur.rowsWithStrikeShape += t.rowsWithStrikeShape;
    into.set(key, cur);
  }
}

/** Merge every retained day into one gate->tallies accumulator. */
function accumulateAllDays(): Map<LiveEnforceGate, GateTallies> {
  const acc = new Map<LiveEnforceGate, GateTallies>();
  for (const day of byDay.values()) {
    for (const [gate, tallies] of day.entries()) {
      let into = acc.get(gate);
      if (!into) {
        into = emptyTallies();
        acc.set(gate, into);
      }
      mergeAxis(into.byScope, tallies.byScope);
      mergeAxis(into.byReason, tallies.byReason);
      mergeAxis(into.byBook, tallies.byBook);
      mergeAxis(into.byCell, tallies.byCell);
      mergeSelectionAxis(into.bySelection, tallies.bySelection);
      // TRA-3483 — samples concatenate (the retained sweep is over the union of
      // days), still under the same cap so a runaway day cannot unbound the fold.
      for (const s of tallies.costSamples) {
        if (into.costSamples.length < MAX_COST_SAMPLES_PER_GATE_DAY) into.costSamples.push(s);
        else into.costSamplesDropped += 1;
      }
      into.costRowsMissing += tallies.costRowsMissing;
      into.costSamplesDropped += tallies.costSamplesDropped;
      // TRA-4745 — the underlying axis and its two coverage denominators travel
      // with the day, or the retained fold would publish an empty
      // `costBySymbol` alongside `costRowsMissingSymbol: 0` — a hole that reads
      // as a complete zero, which is the failure this ticket is about.
      mergeAxis(into.byUnderlying, tallies.byUnderlying);
      into.symbolRowsMissing += tallies.symbolRowsMissing;
      into.blockedUnclassified += tallies.blockedUnclassified;
      // TRA-4269 — the counterfactual travels with the day, or the retained view
      // would publish `counterfactualEvaluated: 0` over a fold that has rows.
      // Copied, never aliased: the per-day tallies must not grow on each read.
      for (const [key, t] of tallies.byRatifiedSymbol.entries()) {
        const cur = into.byRatifiedSymbol.get(key);
        if (cur) cur.evaluated += t.evaluated;
        else into.byRatifiedSymbol.set(key, { ...t });
      }
      for (const [set, n] of tallies.byRatifiedSet.entries()) {
        into.byRatifiedSet.set(set, (into.byRatifiedSet.get(set) ?? 0) + n);
      }
    }
  }
  return acc;
}

/**
 * Fold the store into the read-only health diagnostics for `etDay`. Pure — no IO.
 * An all-zero read on an ARMED gate means it saw no live candidates this day, NOT
 * that it is inert; `blocked > 0` is the direct evidence it is biting, and
 * `evaluated > 0 with blocked === 0` is an armed gate that passed everything.
 */
export function summarizeLiveEnforceGate(
  etDay: string,
  // TRA-3483 — the sweep's ceiling comes from the caller's RESOLVED net-edge
  // config, not from a literal in here: a ceiling that drifts from the deployed
  // one would publish a counterfactual for a form nobody could arm.
  shadowOpts: NetEdgeShadowOptions = {},
): LiveEnforceSummary {
  const day = byDay.get(etDay) ?? new Map<LiveEnforceGate, GateTallies>();
  const retainedDays = [...byDay.keys()].sort();
  // TRA-4154 — `byDay` is the store hydrated from `/data` on boot, so the roll
  // is durable on exactly the same terms as the pooled totals beside it.
  const retainedByGate = foldGates(accumulateAllDays(), null, retainedDays, shadowOpts, byDay);
  return {
    decisionsRecorded: decisionsTotal,
    // TRA-4154 — the day view's roll is the requested day alone, whether or not
    // anything was recorded on it. Passing a one-entry map (rather than `byDay`)
    // keeps this view scoped to `etDay` exactly as before.
    byGate: foldGates(day, etDay, [etDay], shadowOpts, new Map([[etDay, day]])),
    retained: {
      etDays: retainedDays,
      retentionDays: RETAIN_MS / (24 * 60 * 60 * 1000),
      byGate: retainedByGate,
      // TRA-4748 — folded from the two lines above plus the shipped NYSE bundle.
      // `etDay` is the caller's ET "today"; the fold deliberately expects days
      // only up to the session STRICTLY BEFORE it, so a session still in
      // progress is never reported missing.
      sessionCoverage: foldSessionCoverage(retainedDays, retainedByGate, etDay),
    },
    durability: {
      dataDir,
      ephemeral: isEphemeralDataDir(dataDir),
      hydratedRecords,
      hydratedDays,
      appendErrors,
      lastAppendError,
    },
    lastDecisionAt,
  };
}
