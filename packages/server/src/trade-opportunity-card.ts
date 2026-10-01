// TRA-4649 (parent TRA-4645) — Trade Opportunity Card builder.
//
// Folds ONE emitted TradeSignal into a complete, actionable trade PROPOSAL with
// the 8 board-required fields:
//   1. setup          — identification + classification
//   2. entryTrigger   — entry spec with per-criterion pass/fail
//   3. invalidation   — what breaks the thesis
//   4. targets        — target levels + holding period
//   5. contract       — contract selection with liquidity analysis
//   6. costs          — estimated slippage + transaction costs
//   7. sizing         — position sizing calculation
//   8. whyNow         — "why now?" context (evidence + freshness)
//
// DESIGN CONSTRAINTS (board directive on TRA-4645, 2026-09-17):
//  - A card is a PROPOSAL OBJECT and nothing else. `disposition` is DERIVED
//    from the TRA-4651 lifecycle machine (TRA-4813) — 'proposal_only' for every
//    state up to `proposed`, never a hard-coded literal; there is no order
//    field, no broker hook, no execution callback. The lifecycle state machine
//    is the only consumer that can advance one, and it starts at Detected.
//  - `confidence` is populated ONLY from a validated TRA-4779 calibration cell
//    (historical expectancy after fees/slippage, costs charged inside the fold
//    per TRA-4578, ≥30 instances, out-of-sample validated). No calibration in
//    the build context, or a setup that fails any of those gates, leaves the
//    slot `null` — this module never invents a number.
//  - FAIL CLOSED per field: a field that cannot be populated from measured
//    inputs reports `incomplete` with the named missing inputs. It is never
//    silently defaulted, and `card.complete` is true only when all 8 verify.
//    "Verified" means the field's content is measured/derivable from the signal
//    + context — economic ADMISSION stays with the cost bar and the lifecycle
//    gates, not here.
//  - Cost arithmetic is the SHIPPED `netEdgeCostBreakdown` (option-net-edge-bar,
//    TRA-3483): a card that computes its own copy of the cost math can silently
//    disagree with the number the gate uses. Equity sizing is the shipped
//    `sizeFromStopViaRiskManager` (TRA-2034) for the same reason.
//  - Types live here (not @trading-app/shared) for now: shared/src/index.ts
//    carries uncommitted peer work in this tree; promoting the card type to
//    shared for the desktop UI is an integration follow-up.
//
// The per-type registry below is STRING-keyed on purpose, not an exhaustive
// Record<SignalType, …>: SignalType is actively being widened in-flight (the
// TRA-4570 option-vol types exist in a peer's uncommitted shared/ work), and an
// exhaustive map would turn every union widening into a compile break in the
// widener's push. Instead the builder is TOTAL over unknown types at runtime —
// an unregistered type still produces a card, with `setup`/`targets`/`whyNow`
// failed closed as "unregistered" — so a coverage hole surfaces as a loud
// nonzero row in the acceptance fold (`summary.missingByField.setup`), never as
// a silently absent card and never as someone else's build failure.

import type { SignalType, TradeSignal } from '@trading-app/shared';
import {
  netEdgeCostBreakdown,
  DEFAULT_NET_EDGE_BAR_CONFIG,
  type NetEdgeCostBreakdown,
} from './option-net-edge-bar.js';
import { sizeFromStopViaRiskManager } from './account-sizing.js';
import {
  confidenceFor,
  type CalibrationOutcome,
  type SetupCalibrationIndex,
  type SetupConfidence,
} from './setup-calibration.js';
import {
  buildReasonsNotToEnter,
  type ReasonsNotToEnter,
  type ReasonsNotToEnterInputs,
} from './card-reasons-not-to-enter.js';
import type { RelativeStrengthReading } from './otm-relative-strength.js';
// TRA-4813 — the disposition is the lifecycle's derivation, not this module's
// literal. strategy-lifecycle imports only TYPES from here, so this runtime
// edge does not close a cycle.
import { dispositionFor, type CardDisposition } from './strategy-lifecycle.js';

// ── Field plumbing ──────────────────────────────────────────────────────────

// A field that was COMPUTED IN FULL and whose computed answer is "do not enter"
// is NOT the same event as a field we could not build, and TRA-4649's acceptance
// fold must not report them in the same cell. Both leave the card not-`complete`
// — that part is deliberate and unchanged — but `incomplete` means "the input
// was missing" and `refused` means "the input was there, we ran the rule, and it
// says no". Collapsing them makes the instrument unable to tell a broken builder
// from a healthy one: on 2026-09-22 all 50 live cards read
// `missingByField.entryTrigger: 50`, which looks exactly like a builder emitting
// no entry triggers at all, when in fact every one of the 50 had a fully
// populated trigger spec whose `not_suppressed` criterion correctly fired
// (TRA-3942 entry window). A broken build and a quiet afternoon must not
// render as the same number.
export type CardFieldStatus = 'verified' | 'incomplete' | 'refused';

/** One of the 8 card fields. `missing` is non-empty iff not `verified`. */
export interface CardField<T> {
  status: CardFieldStatus;
  /** Populated content; null only when the field could not be built at all. */
  data: T | null;
  /** Named missing/failed inputs — the fail-closed audit trail. */
  missing: string[];
}

function verified<T>(data: T): CardField<T> {
  return { status: 'verified', data, missing: [] };
}
function incomplete<T>(data: T | null, missing: string[]): CardField<T> {
  return { status: 'incomplete', data, missing };
}
/**
 * Built from measured inputs; the rule that ran on them says do not enter.
 * `data` is non-null BY CONSTRUCTION — a refusal we cannot show the workings of
 * is an `incomplete`, not a `refused`.
 */
function refused<T>(data: T, reasons: string[]): CardField<T> {
  return { status: 'refused', data, missing: reasons };
}

/** Finite-number reader for optional/loosely-typed signal extensions. */
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// ── Per-type registry ───────────────────────────────────────────────────────

export type SetupFamily =
  | 'breakout'
  | 'trend'
  | 'mean_reversion'
  | 'reversal'
  | 'scalp'
  | 'options_mispricing'
  | 'options_volatility'
  | 'accumulation'
  | 'import';

export interface CardTypeSpec {
  family: SetupFamily;
  /** One-line setup classification — the narrative half of field 1. */
  label: string;
  /** Nominal holding window in days; option types override with DTE. `max: null` = rule decides. */
  holding: { min: number; max: number | null };
  /** Present ⇒ the exit is a RULE, not a fixed take-profit level. */
  ruleExit?: string;
  /** Thesis-break narrative — invalidation beyond the hard stop. */
  thesisBreak: string;
  /** "Why now" narrative — the always-available half of field 8. */
  whyNow: string;
}

/**
 * String-keyed so in-flight SignalType widenings don't break this compile (see
 * header). Keys are checked against the live union by the registry test, and an
 * unregistered runtime type fails closed per-card. Includes the TRA-4570
 * option-vol types ahead of their SignalType landing so their signals card
 * correctly from the first emission.
 */
const CARD_TYPE_SPECS: Record<string, CardTypeSpec> = {
  orb_breakout: {
    family: 'breakout',
    label: 'Opening-range breakout',
    holding: { min: 0, max: 1 },
    thesisBreak: 'Price re-enters the opening range (breakout failed).',
    whyNow: 'Opening range just resolved; edge decays with the session.',
  },
  reversal: {
    family: 'reversal',
    label: 'Intraday reversal',
    holding: { min: 0, max: 1 },
    thesisBreak: 'Price takes out the reversal pivot extreme.',
    whyNow: 'Reversal trigger just printed at the pivot.',
  },
  macd_cross: {
    family: 'trend',
    label: 'MACD/Bollinger cross (legacy)',
    holding: { min: 1, max: 10 },
    thesisBreak: 'MACD re-crosses against the position.',
    whyNow: 'Cross just printed.',
  },
  macd_trend: {
    family: 'trend',
    label: 'MACD trend continuation',
    holding: { min: 2, max: 15 },
    thesisBreak: 'MACD trend leg re-crosses against the position.',
    whyNow: 'Trend-continuation cross just printed.',
  },
  bb_fade: {
    family: 'mean_reversion',
    label: 'Bollinger-band mean-reversion fade',
    holding: { min: 1, max: 5 },
    thesisBreak: 'Price closes beyond the faded band (expansion, not reversion).',
    whyNow: 'Band excursion just printed; reversion edge is at entry.',
  },
  momentum: {
    family: 'trend',
    label: 'MA-cross + Donchian momentum breakout (trend-regime gated)',
    holding: { min: 3, max: 20 },
    thesisBreak: 'MA-cross flips back / Donchian level lost.',
    whyNow: 'Momentum breakout just confirmed in a trend regime.',
  },
  mean_reversion: {
    family: 'mean_reversion',
    label: 'Regime-gated RSI+BB mean reversion',
    holding: { min: 1, max: 7 },
    thesisBreak: 'Regime flips out of range-bound; reversion premise void.',
    whyNow: 'Oversold/overbought extreme just printed in a range regime.',
  },
  breakout_vol: {
    family: 'breakout',
    label: 'Volume-confirmed consolidation breakout (high-vol regime)',
    holding: { min: 2, max: 15 },
    thesisBreak: 'Breakout closes back inside the consolidation on falling volume.',
    whyNow: 'Volume-confirmed breakout just cleared the consolidation.',
  },
  ichimoku: {
    family: 'trend',
    label: 'Ichimoku trend signal',
    holding: { min: 3, max: 20 },
    thesisBreak: 'Price closes back through the cloud against the signal.',
    whyNow: 'Ichimoku trigger just confirmed.',
  },
  scalping: {
    family: 'scalp',
    label: 'Scalp',
    holding: { min: 0, max: 1 },
    thesisBreak: 'Scalp level lost; time-stop exceeded.',
    whyNow: 'Scalp trigger live only while the level holds.',
  },
  swing_trade: {
    family: 'trend',
    label: 'Swing trade',
    holding: { min: 2, max: 15 },
    thesisBreak: 'Swing structure (higher-low / lower-high) broken.',
    whyNow: 'Swing entry structure just completed.',
  },
  dca: {
    family: 'accumulation',
    label: 'Trend-gated DCA accumulation',
    holding: { min: 30, max: null },
    ruleExit: 'Accumulation program: exits on trend-gate loss or cadence completion, not a per-lot TP.',
    thesisBreak: 'Trend gate lost — accumulation pauses; existing lots keep their stops.',
    whyNow: 'Cadence slot open under an intact trend gate.',
  },
  otm_mispricing: {
    family: 'options_mispricing',
    label: 'OTM option priced below Black-Scholes theoretical',
    holding: { min: 1, max: null },
    thesisBreak: 'Mispricing closes: mark reprices to/above theoretical, or the quote widens so the edge no longer covers the spread.',
    whyNow: 'Contract marks below theoretical NOW; mispricings close when quotes reprice.',
  },
  relative_value: {
    family: 'options_mispricing',
    label: 'Option cheap vs same-expiration fitted IV skew',
    holding: { min: 1, max: null },
    thesisBreak: 'IV residual reverts to the fitted skew (zScore → 0); the contract is no longer cheap relative to its own surface.',
    whyNow: 'Contract sits cheap vs its own fitted skew NOW; residuals mean-revert.',
  },
  post_earnings_iv_crush: {
    family: 'options_volatility',
    label: 'Post-earnings IV crush + directional continuation',
    holding: { min: 2, max: null },
    thesisBreak: 'Post-earnings trend leg fails (gap fill against direction) or IV re-expands.',
    whyNow: 'IV crushed post-print while the directional leg holds — the reasonably-priced window is immediately post-event.',
  },
  momentum_breakout_iv_lag: {
    family: 'options_volatility',
    label: 'Price breakout with lagging option IV',
    holding: { min: 1, max: null },
    thesisBreak: 'Price falls back through the breakout level, or IV reprices before entry (the lag closed without us).',
    whyNow: 'Price broke out but IV has not repriced yet — the lag is the trade and it closes fast.',
  },
  panic_reversal: {
    family: 'options_volatility',
    label: 'Panic selloff reversal via cheap OTM calls',
    holding: { min: 1, max: null },
    thesisBreak: 'Reversal confirmation fails: price loses the stabilization support.',
    whyNow: 'Reversal confirmation just printed while downside skew is still elevated and OTM calls are still cheap.',
  },
  sma200_pullback: {
    family: 'trend',
    label: 'Pullback-to-200SMA continuation bounce',
    holding: { min: 5, max: 30 },
    ruleExit: 'Exit on stop or on loss of the 200SMA pullback structure (no fixed TP by design; TRA-3688 stop basis on the signal).',
    thesisBreak: 'Close below the TRA-3688 stop basis (200SMA minus ATR buffer).',
    whyNow: 'Price just tagged the 200SMA with the bounce trigger intact.',
  },
  sma200_reclaim: {
    family: 'reversal',
    label: '200SMA reclaim trend-change swing',
    holding: { min: 10, max: 60 },
    ruleExit: 'Exit on stop or on close back below the reclaimed 200SMA.',
    thesisBreak: 'Close back below the reclaimed 200SMA.',
    whyNow: 'Price just reclaimed the 200SMA.',
  },
  supertrend_confluence: {
    family: 'trend',
    label: 'Supertrend + MA-stack + MACD + RSI confluence',
    holding: { min: 2, max: 20 },
    thesisBreak: 'Supertrend flips against the position (confluence broken).',
    whyNow: 'All four confluence legs agree as of this bar.',
  },
  tsmom_majors: {
    family: 'trend',
    label: 'Time-series momentum, crypto majors (band exit)',
    holding: { min: 5, max: null },
    ruleExit: 'Band exit: flatten when the TSMOM signal decays through the exit band (long-or-flat).',
    thesisBreak: 'TSMOM signal decays through the exit band.',
    whyNow: 'Daily TSMOM signal crossed into the long band at yesterday\'s close.',
  },
  tradier_import: {
    family: 'import',
    label: 'Position imported from Tradier (managed to close here)',
    holding: { min: 0, max: null },
    ruleExit: 'Imported position: managed to close under the importing book\'s rules.',
    thesisBreak: 'Importing book\'s close criteria met.',
    whyNow: 'Position exists on the broker now and must be managed here.',
  },
};

/** Registered signal types — exported so the registry test grades coverage. */
export function registeredCardTypes(): string[] {
  return Object.keys(CARD_TYPE_SPECS);
}

/** Freshness ceiling (ms) before a card's "why now" is stale, by family. */
const FRESHNESS_MAX_MS: Record<SetupFamily, number> = {
  breakout: 30 * 60_000,
  reversal: 30 * 60_000,
  scalp: 10 * 60_000,
  mean_reversion: 60 * 60_000,
  trend: 48 * 3_600_000,
  options_mispricing: 60 * 60_000, // an option quote perishes; a stale mispricing card proposes against a dead quote
  options_volatility: 60 * 60_000,
  accumulation: 72 * 3_600_000,
  import: 24 * 3_600_000,
};

// ── Field payload types ─────────────────────────────────────────────────────

export interface SetupIdentification {
  signalType: SignalType;
  family: SetupFamily;
  instrument: 'option' | 'underlying';
  label: string;
}

/**
 * Why a criterion failing means what it means.
 *  - `data`      — the criterion is asserting an INPUT is present and sane
 *                  (quote exists, price finite, stop on the right side). A
 *                  failure here means we do not actually know the trigger, so
 *                  the field is `incomplete`.
 *  - `admission` — the inputs are all there and a POLICY rule declines entry
 *                  (entry window, suppression). A failure here means we know
 *                  the trigger perfectly well and the answer is no: `refused`.
 * A `data` failure outranks an `admission` one — if we do not trust the inputs
 * we cannot claim to have run the policy on them.
 */
export type EntryCriterionKind = 'data' | 'admission';

export interface EntryCriterion {
  name: string;
  description: string;
  kind: EntryCriterionKind;
  pass: boolean;
}

export interface EntryTriggerSpec {
  side: TradeSignal['side'];
  orderType: 'limit';
  limitPrice: number;
  /** Every criterion must pass for the trigger field to verify. */
  criteria: EntryCriterion[];
}

export interface InvalidationSpec {
  hardStop: number;
  /** Per-share distance from entry to stop. */
  stopDistance: number;
  conditions: string[];
}

export interface TargetSpec {
  basis: 'fixed_take_profit' | 'rule_exit';
  takeProfit: number | null;
  /** |tp − entry| / |entry − stop| recomputed from the levels on the card. */
  rewardRiskRecomputed: number | null;
  exitRule: string | null;
  holdingPeriod: { minDays: number; maxDays: number | null; basis: 'nominal' | 'to_expiration' };
}

export interface LiquidityAnalysis {
  bid: number;
  ask: number;
  spreadPerShare: number;
  /** (ask − bid) / mark (options) or / entry (underlying). */
  spreadFrac: number;
  /** Modeled edge per share (theo/fair − mark) when the signal carries one. */
  edgePerShare: number | null;
  /** edgePerShare / spreadPerShare — the discriminator that separated real candidates on TRA-2917. */
  edgeToSpread: number | null;
  openInterest: number | null;
  volume: number | null;
  notes: string[];
}

export interface ContractSelection {
  kind: 'option' | 'underlying';
  symbol: string;
  optionSymbol: string | null;
  optionType: string | null;
  strike: number | null;
  expiration: string | null;
  delta: number | null;
  liquidity: LiquidityAnalysis;
}

export interface CostEstimate {
  /** Shipped arithmetic (TRA-3483) for options; mirrored form for underlying. */
  spreadPerShare: number;
  feesPerShare: number;
  costPerShare: number;
  riskPerShare: number;
  /** Round-trip cost in the trade's own R units — the number the cost bar tests. */
  costR: number;
  /** Options only: cost as a fraction of premium, vs the absolute ceiling. */
  costFracOfPremium: number | null;
  exceedsAbsCeiling: boolean | null;
}

/**
 * TRA-4990 Pin 2 — WHICH sizing model produced `quantity`.
 *
 * - `enforced` — the caller supplied the count the EXECUTION PATH would place
 *   for this row ({@link CardBuildContext.enforcedOptionSizing}). The card's
 *   verdict is that model's verdict, so a card describing a row the engine
 *   actually opened can no longer refuse it.
 * - `risk_budget_advisory` — nobody supplied the enforced count, so the card
 *   reports its own stop-distance risk budget. For the OTM sleeve that is **not
 *   the model the engine runs**: every OTM entry path sizes on PREMIUM NOTIONAL
 *   (`floor(budget / (premium × 100))`, or the bounded-live
 *   `resolveLiveOptionTestContracts(askLimit, min(cash, testCap), maxContracts)`),
 *   then clamps to the contract floor's 2-per-entry. Stop distance appears in
 *   neither. The two therefore disagree in the direction that matters — the
 *   engine opens 1 contract while a stop-distance budget buys 0 — which was 47
 *   of the 50 cards retained on 2026-10-01.
 */
export type PositionSizingModel = 'enforced' | 'risk_budget_advisory';

export interface PositionSizing {
  unit: 'contracts' | 'shares';
  quantity: number;
  riskBudget: number;
  /** Loss at the protective stop for `quantity`. */
  maxLossAtStop: number;
  /** Options: full-premium loss if the position gaps through the stop. */
  maxLossHard: number | null;
  basis: string;
  /**
   * TRA-4990 — which model `quantity` came from. Field ABSENT ⇒ the card
   * predates this change; never infer `enforced` from silence.
   */
  model?: PositionSizingModel;
  /**
   * TRA-4990 — the stop-distance risk-budget count, ALWAYS computed for option
   * rows so the two models stay comparable on the wire. `null` for underlying
   * rows (there the RiskManager IS the enforced model, so there is no second
   * number) and when the budget basis was unusable.
   */
  riskBudgetContracts?: number | null;
  /**
   * TRA-4990 — true iff the two models disagree about whether this row is
   * sizeable AT ALL (`>= 1` vs `0`). That disagreement, not the exact count, is
   * what makes the card unusable for grading the sleeve. `null` when only one
   * model was readable — "could not compare" must not read as "they agree".
   */
  divergesFromRiskBudget?: boolean | null;
}

export interface WhyNowContext {
  firedAt: number;
  ageMs: number;
  freshnessCeilingMs: number;
  narrative: string;
  /** Field-derived numeric evidence lines (measured, not narrated). */
  evidence: string[];
}

/**
 * TRA-4788 — the card-level calibration verdict. 'not_run' is the one state
 * `confidenceFor` cannot express (it requires an index to run at all); the
 * other four are its gate outcomes, passed through untouched.
 */
export type CalibrationStatus = 'not_run' | CalibrationOutcome;

/**
 * TRA-4788 — the fixed reason a card carries when the build context held no
 * calibration index. Exported so tests pin the exact wire bytes.
 */
export const CALIBRATION_NOT_RUN_REASON =
  'no calibration index in build context — calibrateSetups has no caller';

export interface TradeOpportunityCard {
  schemaVersion: 1;
  signalId: string;
  symbol: string;
  signalType: SignalType;
  mode: string | null;
  generatedAt: number;
  /**
   * Cards propose. They never execute. Derived from the TRA-4651 lifecycle
   * machine by `dispositionFor` (TRA-4813): 'proposal_only' until the machine
   * accepts real fill/approval evidence, then the state itself; 'aborted' on a
   * terminal machine. The LifecycleRing re-stamps it on every transition.
   */
  disposition: CardDisposition;
  /**
   * TRA-4779 calibrated expectancy verdict. Non-null ONLY when the build
   * context carried a calibration index whose cell for this setup cleared the
   * ≥30-instance floor and out-of-sample validation (existence implies
   * validation — `SetupConfidence` has no unvalidated variant). Otherwise null.
   */
  confidence: SetupConfidence | null;
  /**
   * TRA-4788 — disambiguates `confidence: null`, which by itself cannot say
   * whether a floor was tested and missed or nothing was ever measured.
   * Three-valued contract on the wire: field ABSENT ⇒ the card predates this
   * change · 'not_run' ⇒ no calibration index in the build context, nothing
   * was folded and no floor was tested (the live state today — TRA-4779:
   * `calibrateSetups` has no caller) · any other value ⇒ `confidenceFor` ran
   * and this is the gate it landed on. `confidence` stays null in every
   * branch except 'calibrated' — never 0, never a prior, never a shrunk
   * estimate.
   */
  calibrationStatus?: CalibrationStatus;
  /**
   * TRA-4788 — why `confidence` is what it is: `confidenceFor(...).reasons`
   * verbatim when an index existed, a fixed one-line explanation when none
   * did. Non-empty whenever `calibrationStatus` is not 'calibrated'.
   */
  calibrationReasons?: string[];
  /** True iff all 8 fields `verified` — i.e. both lists below are empty. */
  complete: boolean;
  /**
   * TRA-4990 Pin 1 — `complete` is GATED ON ADMISSION and therefore cannot
   * answer the TRA-4645 priority-1 question ("convert every signal into a clear
   * proposed trade: setup, entry trigger, invalidation, target, holding period,
   * contract choice, liquidity, estimated slippage, position size, why now").
   *
   * The builder appends `not_suppressed` with `pass: false` for ANY
   * `signalSkipReason`/`liveSkipReason`, which refuses `entryTrigger`, which
   * pins `complete: false`. So `complete: true` requires a signal that cleared
   * every gate and reached `openOptionFromCandidate` — i.e. it re-expresses the
   * sleeve's ADMISSION RATE, not whether the product can state a proposal.
   *
   * THIS is the priority-1 column: every field populated, and the only thing
   * refusing is the sleeve's own admission decision. Superset of `complete`
   * (`complete ⇒ completeExceptAdmission`), so the two are never in tension;
   * the gap between them IS the admission rate, read in the open.
   *
   * ⛔ It is NOT a loosening of `not_suppressed` — that criterion still reads
   * `pass: false`, `entryTrigger` is still `refused`, and a refused card still
   * cannot reach `proposed` (TRA-4651). Only the question being asked changed.
   */
  completeExceptAdmission: boolean;
  /**
   * TRA-4990 — the subset of `refusedFields` whose refusal is attributable
   * ENTIRELY to `admission`-kind criteria. Derived from the criteria's own
   * `kind`, never from the reason strings: a prose match would go green the
   * first time a criterion is renamed, which is this repo's recurring
   * instrument-reads-identically bug.
   */
  admissionRefusedFields: string[];
  /** Fields whose inputs were MISSING — the builder could not populate them. */
  incompleteFields: string[];
  /**
   * Fields that were populated in full and whose own rule says do not enter.
   * Disjoint from `incompleteFields`. A card with entries here is a WORKING
   * card reporting a real "no", not a defective one — but it is still not
   * `complete`, so it still cannot reach `proposed` (TRA-4651).
   */
  refusedFields: string[];
  fields: {
    setup: CardField<SetupIdentification>;
    entryTrigger: CardField<EntryTriggerSpec>;
    invalidation: CardField<InvalidationSpec>;
    targets: CardField<TargetSpec>;
    contract: CardField<ContractSelection>;
    costs: CardField<CostEstimate>;
    sizing: CardField<PositionSizing>;
    whyNow: CardField<WhyNowContext>;
  };
  /**
   * TRA-4719 — negative evidence at entry, DISPLAY ONLY: outside `fields`, so
   * it never enters `complete`/`incompleteFields` and never touches
   * `confidence`. The builder always sets it; optional only so cards built
   * elsewhere (fixtures, pre-TRA-4719 rows) still typecheck — a consumer reads
   * an absent section as all `not_evaluated`, never as clear.
   */
  reasonsNotToEnter?: ReasonsNotToEnter;
  /**
   * TRA-4720 — relative strength vs SPY / QQQ / sector ETF (raw spreads per
   * pre-registered lookback + reason codes), OBSERVE ONLY: outside `fields`, so
   * it never moves `complete`/`incompleteFields`/`confidence`. Present only
   * under `ENABLE_OTM_RELATIVE_STRENGTH_SHADOW`; absent ⇒ not measured (NOT
   * neutral). Distinct from the `relativeStrength:` line in `fields.whyNow` evidence, which echoes the
   * signal's own value (the momentum scanner's `?? 50` placeholder included).
   */
  relativeStrength?: RelativeStrengthReading;
}

// ── Build context ───────────────────────────────────────────────────────────

export interface CardBuildContext {
  /** Wall clock of the build — freshness is measured, never assumed. */
  now: number;
  /** Absent ⇒ sizing field fails closed (no equity basis to size against). */
  sizing?: {
    managedEquity: number;
    riskPerTrade: number;
    /** Whole shares when false; 8dp when true (crypto). Default false. */
    fractionalQuantity?: boolean;
  };
  /**
   * TRA-4990 Pin 2 — the contract count the EXECUTION PATH would place for this
   * option row, computed by the engine with the SAME expression the open path
   * runs (`OptionsAccount.previewOtmContracts`). Supplied ⇒ the `sizing` field
   * reports and grades THAT model, and the card's stop-distance risk budget
   * drops to an advisory number beside it.
   *
   * ⚠️ Deliberately a number the caller already computed, never a bound
   * re-implemented here. A second copy of a capital bound inside an instrument
   * agrees with itself and would silently fork from the enforced one — and
   * TRA-4990 explicitly forbids moving `maxContractsPerEntry` or any capital
   * bound. `quantity: 0` means the enforced sizer REFUSES the row; absent means
   * nobody asked it, which is a different claim and must not read as zero.
   */
  enforcedOptionSizing?: {
    unit: 'contracts';
    /** 0 ⇒ the enforced sizer refuses this row. */
    quantity: number;
    /** Names the model, e.g. the bounded-live notional cap or the demo budget ratio. */
    basis: string;
  };
  /** Round-trip fees $/contract; defaults to the TRA-2810 measurement. */
  feesPerContractRoundTrip?: number;
  /** Underlying (non-option) signals need a two-sided quote for liquidity/cost. */
  underlyingQuote?: { bid: number; ask: number };
  /** Per-share round-trip fee for the underlying venue (crypto taker etc.). Default 0. */
  underlyingFeesPerShare?: number;
  /** Optional chain liquidity for option contracts. */
  optionLiquidity?: { openInterest?: number; volume?: number; marketPhase?: 'pre' | 'rth' | 'post' };
  /**
   * TRA-4779 calibration index (from `calibrateSetups`). Absent ⇒ every card's
   * `confidence` is null — the pre-TRA-4779 behavior, unchanged.
   */
  calibration?: SetupCalibrationIndex;
  /** Current market regime label, for regime-conditioned confidence lookup. */
  currentRegime?: string | null;
  /**
   * TRA-4719 — engine-owned reads for the "reasons NOT to enter" section.
   * Absent (or `enabled: false`) ⇒ every source reads `not_evaluated`.
   */
  reasonsNotToEnter?: ReasonsNotToEnterInputs;
  /** TRA-4720 — the engine's RS reading; absent (flag OFF) ⇒ no key on the card. */
  relativeStrength?: RelativeStrengthReading;
}

// ── The builder ─────────────────────────────────────────────────────────────

interface OptionView {
  optionSymbol: string;
  optionType: string;
  strike: number;
  expiration: string;
  mark: number;
  bid: number | undefined;
  ask: number | undefined;
  delta: number | undefined;
  /** theo (OTM scanner) or fairPrice (RV scanner) — the modeled fair value. */
  fairValue: number | undefined;
}

/** Structural option-signal detection — presence of the contract fields. */
function optionView(signal: TradeSignal): OptionView | null {
  const s = signal as TradeSignal & Record<string, unknown>;
  const optionSymbol = str(s.optionSymbol);
  const optionType = str(s.optionType);
  const strike = num(s.strike);
  const expiration = str(s.expiration);
  const mark = num(s.mark);
  if (!optionSymbol || !optionType || strike === undefined || !expiration || mark === undefined) {
    return null;
  }
  return {
    optionSymbol,
    optionType,
    strike,
    expiration,
    mark,
    bid: num(s.bid),
    ask: num(s.ask),
    delta: num(s.delta),
    fairValue: num(s.theo) ?? num(s.fairPrice),
  };
}

const MS_PER_DAY = 86_400_000;

/** Whole days from `now` to the expiration date string, or null if unparseable. */
function daysToExpiration(expiration: string, now: number): number | null {
  const t = Date.parse(expiration);
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - now) / MS_PER_DAY);
}

export function buildTradeOpportunityCard(
  signal: TradeSignal,
  ctx: CardBuildContext,
): TradeOpportunityCard {
  const s = signal as TradeSignal & Record<string, unknown>;
  const opt = optionView(signal);
  const spec: CardTypeSpec | undefined = CARD_TYPE_SPECS[signal.type];
  const unregistered = `signal type '${signal.type}' not registered in the card system — register a CardTypeSpec (TRA-4649)`;
  const entry = num(signal.entryPrice);
  const stop = num(signal.stopLoss);
  const tp = num(signal.takeProfit); // Sma200Signal omits it at the type level
  const isBuy = signal.side === 'buy';

  // 1. Setup identification & classification — fails closed on a type the
  // registry does not know; the batch fold makes that hole loud.
  const setup = spec
    ? verified<SetupIdentification>({
        signalType: signal.type,
        family: spec.family,
        instrument: opt ? 'option' : 'underlying',
        label: spec.label,
      })
    : incomplete<SetupIdentification>(null, [unregistered]);

  // 2. Entry trigger with pass/fail criteria.
  const criteria: EntryCriterion[] = [];
  const entryPrice = opt ? opt.mark : entry;
  criteria.push({
    name: 'entry_price_positive',
    description: 'Entry price / premium is a finite positive number',
    kind: 'data',
    pass: entryPrice !== undefined && entryPrice > 0,
  });
  // Long-premium semantics for option signals: the named contract (call or put)
  // is BOUGHT and direction rides on optionType, so the premium stop sits below
  // mark regardless of `side`. Underlying signals use side-relative geometry.
  const stopOnThesisSide =
    stop !== undefined && entryPrice !== undefined
    && (opt ? stop >= 0 && stop < entryPrice : isBuy ? stop < entryPrice : stop > entryPrice);
  criteria.push({
    name: 'protective_stop_on_thesis_side',
    description: opt
      ? 'Premium stop sits below the entry mark (long-premium position)'
      : 'Stop sits on the loss side of entry for the stated side',
    kind: 'data',
    pass: stopOnThesisSide,
  });
  if (opt) {
    const quoteUsable =
      opt.bid !== undefined && opt.ask !== undefined && opt.bid >= 0 && opt.ask >= opt.bid;
    criteria.push({
      name: 'two_sided_quote_present',
      description: 'Contract has a usable two-sided quote (bid ≤ ask, bid ≥ 0)',
      kind: 'data',
      pass: quoteUsable,
    });
    criteria.push({
      name: 'mark_within_quote',
      description: 'Entry mark lies within [bid, ask] — a mark outside its own quote is stale',
      kind: 'data',
      pass: quoteUsable && opt.bid! <= opt.mark && opt.mark <= opt.ask!,
    });
  }
  const suppressReason = str(s.signalSkipReason) ?? str(s.liveSkipReason);
  if (suppressReason !== undefined) {
    criteria.push({
      name: 'not_suppressed',
      description: `Signal was suppressed at emission: ${suppressReason}`,
      kind: 'admission',
      pass: false,
    });
  }
  const failedCriteria = criteria.filter((c) => !c.pass);
  const triggerData: EntryTriggerSpec | null =
    entryPrice !== undefined
      ? { side: signal.side, orderType: 'limit', limitPrice: entryPrice, criteria }
      : null;
  // Field #2 of the spec is "entry trigger specification WITH PASS/FAIL
  // CRITERIA" — an `admission` criterion returning `pass: false` is this field
  // delivering its contract, not failing to. A `data` criterion returning false
  // means we never knew the trigger in the first place, and that stays
  // `incomplete`. Data outranks admission (see EntryCriterionKind).
  const failedData = failedCriteria.filter((c) => c.kind === 'data');
  const reasons = failedCriteria.map((c) => `entry criterion failed: ${c.name}`);
  const entryTrigger =
    triggerData === null
      ? incomplete<EntryTriggerSpec>(null, ['entry price missing/non-finite'])
      : failedData.length > 0
        ? incomplete(triggerData, reasons)
        : failedCriteria.length === 0
          ? verified(triggerData)
          : refused(triggerData, reasons);

  // 3. Invalidation — hard stop + type-specific thesis break.
  let invalidation: CardField<InvalidationSpec>;
  if (stop === undefined) {
    invalidation = incomplete<InvalidationSpec>(null, ['stopLoss missing/non-finite']);
  } else if (entryPrice === undefined || !stopOnThesisSide) {
    invalidation = incomplete<InvalidationSpec>(null, [
      'stopLoss on the wrong side of entry for the stated side',
    ]);
  } else {
    const data: InvalidationSpec = {
      hardStop: stop,
      stopDistance: Math.abs(entryPrice - stop),
      conditions: [
        `Hard stop at ${stop} (${opt ? 'premium' : 'price'} level).`,
        ...(spec ? [spec.thesisBreak] : []),
      ],
    };
    invalidation = spec
      ? verified(data)
      : incomplete(data, [`thesis-break conditions unknown: ${unregistered}`]);
  }

  // 4. Targets + holding period.
  const targetMissing: string[] = [];
  let holding: TargetSpec['holdingPeriod'] | null = spec
    ? { minDays: spec.holding.min, maxDays: spec.holding.max, basis: 'nominal' }
    : null;
  if (spec === undefined) targetMissing.push(`holding period unknown: ${unregistered}`);
  if (opt) {
    const dte = daysToExpiration(opt.expiration, ctx.now);
    if (dte === null) targetMissing.push(`expiration '${opt.expiration}' unparseable`);
    else if (dte <= 0) targetMissing.push(`expiration '${opt.expiration}' is in the past`);
    else if (holding !== null) {
      holding = { minDays: Math.min(holding.minDays, dte), maxDays: dte, basis: 'to_expiration' };
    }
  }
  let targetData: TargetSpec | null = null;
  if (holding !== null && targetMissing.length === 0) {
    if (spec?.ruleExit !== undefined) {
      targetData = {
        basis: 'rule_exit',
        takeProfit: tp ?? null,
        rewardRiskRecomputed: null,
        exitRule: spec.ruleExit,
        holdingPeriod: holding,
      };
    } else if (tp === undefined) {
      targetMissing.push('takeProfit missing/non-finite for a fixed-TP setup');
    } else if (entryPrice === undefined || stop === undefined || !stopOnThesisSide) {
      targetMissing.push('cannot recompute reward:risk without a valid entry and stop');
    } else {
      const tpOnProfitSide = opt || isBuy ? tp > entryPrice : tp < entryPrice;
      const rr = Math.abs(tp - entryPrice) / Math.abs(entryPrice - stop);
      if (!tpOnProfitSide) {
        targetMissing.push('takeProfit on the wrong side of entry for the stated side');
      } else {
        const stated = num(signal.riskRewardRatio);
        if (stated !== undefined && stated > 0 && Math.abs(rr - stated) / stated > 0.1) {
          targetMissing.push(
            `stated riskRewardRatio ${stated} inconsistent with recomputed ${rr.toFixed(3)} (>10%)`,
          );
        } else {
          targetData = {
            basis: 'fixed_take_profit',
            takeProfit: tp,
            rewardRiskRecomputed: rr,
            exitRule: null,
            holdingPeriod: holding,
          };
        }
      }
    }
  }
  const targets =
    targetData !== null && targetMissing.length === 0
      ? verified(targetData)
      : incomplete(targetData, targetMissing);

  // 5. Contract selection + liquidity analysis.
  let contract: CardField<ContractSelection>;
  if (opt) {
    if (opt.bid === undefined || opt.ask === undefined || opt.bid < 0 || opt.ask < opt.bid) {
      contract = incomplete<ContractSelection>(null, [
        'usable two-sided option quote (bid/ask) required for liquidity analysis',
      ]);
    } else {
      const spread = opt.ask - opt.bid;
      const edge = opt.fairValue !== undefined ? opt.fairValue - opt.mark : null;
      const notes: string[] = [];
      if (ctx.optionLiquidity?.marketPhase === 'pre') {
        notes.push('pre-market: volume reads 0 on all rows and is not a liquidity discriminator (TRA-4638)');
      }
      contract = verified<ContractSelection>({
        kind: 'option',
        symbol: signal.symbol,
        optionSymbol: opt.optionSymbol,
        optionType: opt.optionType,
        strike: opt.strike,
        expiration: opt.expiration,
        delta: opt.delta ?? null,
        liquidity: {
          bid: opt.bid,
          ask: opt.ask,
          spreadPerShare: spread,
          spreadFrac: opt.mark > 0 ? spread / opt.mark : Number.NaN,
          edgePerShare: edge,
          edgeToSpread: edge !== null && spread > 0 ? edge / spread : null,
          openInterest: ctx.optionLiquidity?.openInterest ?? null,
          volume: ctx.optionLiquidity?.volume ?? null,
          notes,
        },
      });
    }
  } else {
    const q = ctx.underlyingQuote;
    if (q === undefined || !Number.isFinite(q.bid) || !Number.isFinite(q.ask) || q.bid <= 0 || q.ask < q.bid) {
      contract = incomplete<ContractSelection>(null, [
        'underlying two-sided quote (ctx.underlyingQuote) required for liquidity analysis',
      ]);
    } else {
      const spread = q.ask - q.bid;
      contract = verified<ContractSelection>({
        kind: 'underlying',
        symbol: signal.symbol,
        optionSymbol: null,
        optionType: null,
        strike: null,
        expiration: null,
        delta: null,
        liquidity: {
          bid: q.bid,
          ask: q.ask,
          spreadPerShare: spread,
          spreadFrac: entryPrice !== undefined && entryPrice > 0 ? spread / entryPrice : Number.NaN,
          edgePerShare: null,
          edgeToSpread: null,
          openInterest: null,
          volume: null,
          notes: [],
        },
      });
    }
  }

  // 6. Estimated slippage + transaction costs.
  const riskPerShare =
    stop !== undefined && entryPrice !== undefined && stopOnThesisSide
      ? Math.abs(entryPrice - stop)
      : undefined;
  let costs: CardField<CostEstimate>;
  if (opt) {
    const fees = ctx.feesPerContractRoundTrip ?? DEFAULT_NET_EDGE_BAR_CONFIG.feesPerContractRoundTrip;
    const breakdown: NetEdgeCostBreakdown | null = netEdgeCostBreakdown(
      { mark: opt.mark, bid: opt.bid, ask: opt.ask, riskPerShare },
      fees,
    );
    costs =
      breakdown === null
        ? incomplete<CostEstimate>(null, [
            'cost unknown: option quote unusable (netEdgeCostBreakdown fail-closed, TRA-3483)',
          ])
        : verified<CostEstimate>({
            spreadPerShare: breakdown.spreadPerShare,
            feesPerShare: breakdown.feesPerShare,
            costPerShare: breakdown.costPerShare,
            riskPerShare: breakdown.riskPerShare,
            costR: breakdown.costR,
            costFracOfPremium: breakdown.costFracOfPremium,
            exceedsAbsCeiling:
              breakdown.costFracOfPremium > DEFAULT_NET_EDGE_BAR_CONFIG.absCostFracCeiling,
          });
  } else {
    const q = ctx.underlyingQuote;
    if (q === undefined || !Number.isFinite(q.bid) || !Number.isFinite(q.ask) || q.bid <= 0 || q.ask < q.bid) {
      costs = incomplete<CostEstimate>(null, ['cost unknown: no usable underlying quote']);
    } else if (riskPerShare === undefined || riskPerShare <= 0) {
      costs = incomplete<CostEstimate>(null, ['cost basis unknown: no valid stop distance to express cost in R']);
    } else {
      const spread = q.ask - q.bid;
      const feesPerShare = ctx.underlyingFeesPerShare ?? 0;
      const costPerShare = spread + feesPerShare;
      costs = verified<CostEstimate>({
        spreadPerShare: spread,
        feesPerShare,
        costPerShare,
        riskPerShare,
        costR: costPerShare / riskPerShare,
        costFracOfPremium: null,
        exceedsAbsCeiling: null,
      });
    }
  }

  // 7. Position sizing.
  let sizing: CardField<PositionSizing>;
  if (ctx.sizing === undefined
      || !Number.isFinite(ctx.sizing.managedEquity) || ctx.sizing.managedEquity <= 0
      || !Number.isFinite(ctx.sizing.riskPerTrade) || ctx.sizing.riskPerTrade <= 0) {
    sizing = incomplete<PositionSizing>(null, ['sizing basis missing: ctx.sizing {managedEquity, riskPerTrade} required']);
  } else if (entryPrice === undefined || riskPerShare === undefined || riskPerShare <= 0) {
    sizing = incomplete<PositionSizing>(null, ['cannot size without a valid entry and stop distance']);
  } else if (opt) {
    const budget = ctx.sizing.managedEquity * ctx.sizing.riskPerTrade;
    // The card's own stop-distance reading. Kept in BOTH arms below so the two
    // models are always comparable on the wire — an advisory number that
    // disappears when the enforced one shows up would make the divergence
    // unmeasurable exactly where it matters.
    const riskBudgetContracts = Math.floor(budget / (riskPerShare * 100));
    const enforced = ctx.enforcedOptionSizing;
    if (enforced !== undefined) {
      // TRA-4990 Pin 2 — the ENFORCED model governs. The engine sizes OTM on
      // premium notional and clamps to the contract floor; stop distance is not
      // an input to any OTM entry path. Reporting the enforced count here is
      // what stops the card refusing a row the engine placed.
      const q = Number.isFinite(enforced.quantity) ? Math.floor(enforced.quantity) : 0;
      const diverges = q >= 1 !== riskBudgetContracts >= 1;
      const data: PositionSizing = {
        unit: 'contracts',
        quantity: Math.max(0, q),
        riskBudget: budget,
        maxLossAtStop: Math.max(0, q) * riskPerShare * 100,
        maxLossHard: Math.max(0, q) * entryPrice * 100,
        basis: `${enforced.basis} (ENFORCED). Stop-distance risk budget $${budget.toFixed(2)} would size `
          + `${riskBudgetContracts} at $${(riskPerShare * 100).toFixed(2)} risk/contract — advisory only, `
          + 'no OTM entry path sizes on stop distance.',
        model: 'enforced',
        riskBudgetContracts,
        divergesFromRiskBudget: diverges,
      };
      sizing =
        q >= 1
          ? verified<PositionSizing>(data)
          : refused<PositionSizing>(data, [
              `the enforced sizer places 0 contracts: ${enforced.basis}`,
            ]);
    } else {
      // No enforced count supplied. The verdict stays what it was — this ticket
      // moves no capital bound and must not silently re-bucket existing cards —
      // but the basis string now NAMES the model it is, and says it is not the
      // one the sleeve runs. A basis naming a model the engine does not run was
      // the defect TRA-4990 Pin 2 filed.
      const advisory =
        'floor(managedEquity × riskPerTrade / (stopDistance × 100)) — RISK-BUDGET ADVISORY, '
        + 'NOT the enforced model: every OTM entry path sizes on premium notional '
        + '(bounded-live: resolveLiveOptionTestContracts(ask, min(cash, testCap), maxContracts); '
        + 'demo: floor(budgetRatio × equity / (premium × 100))) and clamps to the contract floor\'s '
        + '2-per-entry. No enforced count was supplied for this row (TRA-4990).';
      const common = {
        unit: 'contracts' as const,
        riskBudget: budget,
        model: 'risk_budget_advisory' as const,
        riskBudgetContracts,
        // One model read, so the comparison is UNAVAILABLE. Never `false`.
        divergesFromRiskBudget: null,
      };
      sizing =
        riskBudgetContracts >= 1
          ? verified<PositionSizing>({
              ...common,
              quantity: riskBudgetContracts,
              maxLossAtStop: riskBudgetContracts * riskPerShare * 100,
              maxLossHard: riskBudgetContracts * entryPrice * 100,
              basis: `${advisory} Hard max loss is full premium.`,
            })
          : refused<PositionSizing>(
              {
                ...common,
                quantity: 0,
                maxLossAtStop: 0,
                maxLossHard: 0,
                basis: `${advisory} It evaluates to 0 — budget below one contract.`,
              },
              [
                `risk budget $${budget.toFixed(2)} buys 0 contracts at $${(riskPerShare * 100).toFixed(2)} risk/contract`
                  + ' — advisory model; the enforced sizer was not consulted for this row (TRA-4990 Pin 2)',
              ],
            );
    }
  } else {
    const qty = sizeFromStopViaRiskManager(entryPrice, stop!, {
      managedEquity: ctx.sizing.managedEquity,
      riskPerTrade: ctx.sizing.riskPerTrade,
      fractionalQuantity: ctx.sizing.fractionalQuantity ?? false,
    });
    sizing =
      qty > 0
        ? verified<PositionSizing>({
            unit: 'shares',
            quantity: qty,
            riskBudget: ctx.sizing.managedEquity * ctx.sizing.riskPerTrade,
            maxLossAtStop: qty * riskPerShare,
            maxLossHard: null,
            basis: 'sizeFromStopViaRiskManager (TRA-2034: engine RiskManager + TRA-178 notional cap)',
            // TRA-4990 — on the UNDERLYING path the card calls the engine's own
            // RiskManager, so this IS the enforced model and there is no second
            // number to diverge from. `null`, not `false`: no comparison ran.
            model: 'enforced',
            riskBudgetContracts: null,
            divergesFromRiskBudget: null,
          })
        : refused<PositionSizing>(
            {
              unit: 'shares',
              quantity: 0,
              riskBudget: ctx.sizing.managedEquity * ctx.sizing.riskPerTrade,
              maxLossAtStop: 0,
              maxLossHard: null,
              basis: 'sizeFromStopViaRiskManager (TRA-2034) returned 0 — budget below one unit or notional-capped to zero',
              model: 'enforced',
              riskBudgetContracts: null,
              divergesFromRiskBudget: null,
            },
            ['RiskManager sized 0 (budget below one unit or notional-capped to zero)'],
          );
  }

  // 8. "Why now?" — narrative + measured evidence + freshness (fail closed on stale).
  const firedAt = num(signal.timestamp);
  const evidence: string[] = [];
  const push = (label: string, v: number | undefined, unit = '') => {
    if (v !== undefined) evidence.push(`${label}: ${v}${unit}`);
  };
  push('mispricingPct', num(s.mispricingPct));
  push('zScore', num(s.zScore));
  push('ivPercentile', num(s.ivPercentile));
  push('ivRank', num(s.ivRank));
  push('gapPercent', num(s.gapPercent));
  push('daysSinceEarnings', num(s.daysSinceEarnings));
  push('momentumScore', num(s.momentumScore));
  push('volumeRatio', num(s.volumeRatio));
  push('recentDeclinePct', num(s.recentDeclinePct));
  push('putCallSkew', num(s.putCallSkew));
  push('reversalScore', num(s.reversalScore));
  push('rsi', num(s.rsi));
  push('relativeStrength', num(s.relativeStrength));
  let whyNow: CardField<WhyNowContext>;
  if (firedAt === undefined) {
    whyNow = incomplete<WhyNowContext>(null, ['signal timestamp missing — freshness unmeasurable']);
  } else if (spec === undefined) {
    whyNow = incomplete<WhyNowContext>(null, [`freshness ceiling unknown: ${unregistered}`]);
  } else {
    const ageMs = ctx.now - firedAt;
    const ceiling = FRESHNESS_MAX_MS[spec.family];
    const data: WhyNowContext = {
      firedAt,
      ageMs,
      freshnessCeilingMs: ceiling,
      narrative: spec.whyNow,
      evidence,
    };
    if (ageMs < 0) {
      whyNow = incomplete(data, ['signal timestamp is in the future of the build clock']);
    } else if (ageMs > ceiling) {
      whyNow = incomplete(data, [
        `signal stale: age ${Math.round(ageMs / 60_000)}m exceeds the ${Math.round(ceiling / 60_000)}m ceiling for family '${spec.family}'`,
      ]);
    } else {
      whyNow = verified(data);
    }
  }

  const fields = { setup, entryTrigger, invalidation, targets, contract, costs, sizing, whyNow };
  const fieldNames = Object.keys(fields) as (keyof typeof fields)[];
  const incompleteFields = fieldNames.filter((k) => fields[k].status === 'incomplete');
  const refusedFields = fieldNames.filter((k) => fields[k].status === 'refused');
  // TRA-4990 Pin 1 — which refusals are the SLEEVE's admission decision rather
  // than a card rule. Keyed on the criteria's own `kind`, so it stays correct
  // when a criterion is renamed and goes BLIND (empty) rather than green if the
  // criteria list ever stops being published. `entryTrigger` is the only field
  // that can carry admission criteria today; the filter is written over the
  // field list so a second one needs no edit here.
  const admissionRefusedFields = refusedFields.filter((k) => {
    if (k !== 'entryTrigger') return false;
    const failing = (fields.entryTrigger.data?.criteria ?? []).filter((c) => !c.pass);
    return failing.length > 0 && failing.every((c) => c.kind === 'admission');
  });
  // TRA-4788 — one lookup, kept whole: the verdict, the gate it landed on and
  // its reasons travel together. An absent index is 'not_run' — nothing was
  // folded and no floor was tested — which is a different claim from a floor
  // that was tested and missed ('below_floor'); the two must never collapse
  // into a bare null. `.reasons` used to be discarded here (TRA-4779).
  const calibration = ctx.calibration
    ? confidenceFor(ctx.calibration, signal.type, ctx.currentRegime ?? null)
    : null;
  return {
    schemaVersion: 1,
    signalId: signal.id,
    symbol: signal.symbol,
    signalType: signal.type,
    mode: str(s.mode) ?? null,
    generatedAt: ctx.now,
    // TRA-4813 — derived, not a literal: at build time no machine exists yet,
    // and dispositionFor(null) is the proposal-only reading of that fact. The
    // LifecycleRing re-derives this stamp on every accepted transition.
    disposition: dispositionFor(null),
    confidence: calibration ? calibration.confidence : null,
    calibrationStatus: calibration ? calibration.status : 'not_run',
    calibrationReasons: calibration ? calibration.reasons : [CALIBRATION_NOT_RUN_REASON],
    complete: incompleteFields.length === 0 && refusedFields.length === 0,
    // TRA-4990 — the TRA-4645 priority-1 column. Note the ORDER of the two
    // terms: `incompleteFields.length === 0` first, so an unbuildable card can
    // never reach this cell by having no refusals. `every` over an empty
    // `refusedFields` is vacuously true, which is exactly right — that is the
    // `complete` case, and this must be its superset.
    completeExceptAdmission:
      incompleteFields.length === 0
      && refusedFields.every((f) => admissionRefusedFields.includes(f)),
    incompleteFields,
    refusedFields,
    admissionRefusedFields,
    fields,
    reasonsNotToEnter: buildReasonsNotToEnter(
      {
        symbol: signal.symbol,
        signalType: signal.type,
        instrument: opt ? 'option' : 'underlying',
        family: spec?.family ?? null,
        optionType: opt?.optionType ?? null,
      },
      ctx.reasonsNotToEnter,
    ),
    ...(ctx.relativeStrength ? { relativeStrength: ctx.relativeStrength } : {}),
  };
}

// ── Batch + acceptance instrument ───────────────────────────────────────────

export interface CardBatchSummary {
  total: number;
  complete: number;
  /** Cards not `complete`, for any reason — `unbuildable + refusedOnly`. */
  incomplete: number;
  /**
   * Cards with ≥1 field the builder COULD NOT POPULATE. This is the defect
   * cell: a nonzero here means missing inputs or a coverage hole.
   */
  unbuildable: number;
  /**
   * Cards fully populated whose own rules decline entry. This is the HEALTHY
   * not-enterable cell — a quiet afternoon, an entry window, an unaffordable
   * contract. It is not a defect and must never be read as one.
   */
  refusedOnly: number;
  /**
   * TRA-4990 Pin 1 — THE TRA-4645 PRIORITY-1 COLUMN. Cards with every field
   * populated whose only refusal is the sleeve's own admission decision.
   * Superset of `complete`; `completeExceptAdmission - complete` IS the
   * admission rate, which is what `complete` alone was silently reporting.
   *
   * Read this, not `complete`, to answer "does this product produce an
   * actionable card". Read `complete` to answer "did the sleeve admit an
   * entry" — a question about the sleeve, not about the card surface.
   */
  completeExceptAdmission: number;
  /**
   * TRA-4990 — fully built cards refused by a CARD RULE (sizing, contract,
   * costs, …) rather than by admission. This is the cell Pin 2 lives in: a
   * sizing model that is not the enforced one lands 47-of-50 here and reads as
   * "the sleeve declined", which it is not.
   *
   * Exhaustive partition, asserted in the tests:
   * `unbuildable + completeExceptAdmission + refusedByCardRule === total`.
   */
  refusedByCardRule: number;
  /** Per-field count of cards that could not BUILD the field. */
  missingByField: Record<string, number>;
  /** Per-field count of cards that built it and whose rule declined entry. */
  refusedByField: Record<string, number>;
}

/**
 * Fold a card population into the acceptance tally. Exported (TRA-4649 wiring)
 * so a caller retaining already-built cards — the signal engine's card ring —
 * reads the SAME fold the batch builder reports, not a re-implementation.
 */
export function summarizeCards(cards: readonly TradeOpportunityCard[]): CardBatchSummary {
  const missingByField: Record<string, number> = {};
  const refusedByField: Record<string, number> = {};
  for (const card of cards) {
    for (const f of card.incompleteFields) {
      missingByField[f] = (missingByField[f] ?? 0) + 1;
    }
    for (const f of card.refusedFields) {
      refusedByField[f] = (refusedByField[f] ?? 0) + 1;
    }
  }
  const complete = cards.filter((c) => c.complete).length;
  // Every card lands in exactly one of the three buckets; `unbuildable` wins a
  // card that is both, because a missing input is the finding that needs acting
  // on. complete + unbuildable + refusedOnly === total, asserted in the tests.
  const unbuildable = cards.filter((c) => c.incompleteFields.length > 0).length;
  const refusedOnly = cards.filter(
    (c) => c.incompleteFields.length === 0 && c.refusedFields.length > 0,
  ).length;
  // TRA-4990 — read the card's OWN `completeExceptAdmission` rather than
  // re-deriving it: one definition, so the fold and the card cannot disagree.
  const completeExceptAdmission = cards.filter((c) => c.completeExceptAdmission).length;
  // Derived INDEPENDENTLY — off the two field lists, not by subtracting the
  // cell above. A subtraction would make
  // `unbuildable + completeExceptAdmission + refusedByCardRule === total`
  // true by construction, i.e. a sum identity that cannot fail, which is the
  // green-that-cannot-go-red trap. This way the identity actually tests the
  // boolean against the arrays.
  const refusedByCardRule = cards.filter(
    (c) => c.incompleteFields.length === 0
      && c.refusedFields.some((f) => !c.admissionRefusedFields.includes(f)),
  ).length;
  return {
    total: cards.length,
    complete,
    incomplete: cards.length - complete,
    unbuildable,
    refusedOnly,
    completeExceptAdmission,
    refusedByCardRule,
    missingByField,
    refusedByField,
  };
}

/** Build a card for EVERY signal (total by construction) and fold the tally. */
export function buildCards(
  signals: readonly TradeSignal[],
  ctx: CardBuildContext,
): { cards: TradeOpportunityCard[]; summary: CardBatchSummary } {
  const cards = signals.map((sig) => buildTradeOpportunityCard(sig, ctx));
  return { cards, summary: summarizeCards(cards) };
}
