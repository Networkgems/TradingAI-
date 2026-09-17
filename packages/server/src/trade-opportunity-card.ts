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
//  - A card is a PROPOSAL OBJECT and nothing else. `disposition` is the literal
//    'proposal_only'; there is no order field, no broker hook, no execution
//    callback. The TRA-4651 lifecycle state machine is the only intended
//    consumer that can advance one, and it starts at Detected.
//  - `confidence` is populated ONLY from a validated TRA-4652 calibration cell
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
  type SetupCalibrationIndex,
  type SetupConfidence,
} from './setup-calibration.js';

// ── Field plumbing ──────────────────────────────────────────────────────────

export type CardFieldStatus = 'verified' | 'incomplete';

/** One of the 8 card fields. `missing` is non-empty iff `incomplete`. */
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

export interface EntryCriterion {
  name: string;
  description: string;
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

export interface PositionSizing {
  unit: 'contracts' | 'shares';
  quantity: number;
  riskBudget: number;
  /** Loss at the protective stop for `quantity`. */
  maxLossAtStop: number;
  /** Options: full-premium loss if the position gaps through the stop. */
  maxLossHard: number | null;
  basis: string;
}

export interface WhyNowContext {
  firedAt: number;
  ageMs: number;
  freshnessCeilingMs: number;
  narrative: string;
  /** Field-derived numeric evidence lines (measured, not narrated). */
  evidence: string[];
}

export interface TradeOpportunityCard {
  schemaVersion: 1;
  signalId: string;
  symbol: string;
  signalType: SignalType;
  mode: string | null;
  generatedAt: number;
  /** Cards propose. They never execute. See TRA-4651 for the state machine. */
  disposition: 'proposal_only';
  /**
   * TRA-4652 calibrated expectancy verdict. Non-null ONLY when the build
   * context carried a calibration index whose cell for this setup cleared the
   * ≥30-instance floor and out-of-sample validation (existence implies
   * validation — `SetupConfidence` has no unvalidated variant). Otherwise null.
   */
  confidence: SetupConfidence | null;
  complete: boolean;
  /** Names of the fields that failed to verify (empty iff complete). */
  incompleteFields: string[];
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
  /** Round-trip fees $/contract; defaults to the TRA-2810 measurement. */
  feesPerContractRoundTrip?: number;
  /** Underlying (non-option) signals need a two-sided quote for liquidity/cost. */
  underlyingQuote?: { bid: number; ask: number };
  /** Per-share round-trip fee for the underlying venue (crypto taker etc.). Default 0. */
  underlyingFeesPerShare?: number;
  /** Optional chain liquidity for option contracts. */
  optionLiquidity?: { openInterest?: number; volume?: number; marketPhase?: 'pre' | 'rth' | 'post' };
  /**
   * TRA-4652 calibration index (from `calibrateSetups`). Absent ⇒ every card's
   * `confidence` is null — the pre-TRA-4652 behavior, unchanged.
   */
  calibration?: SetupCalibrationIndex;
  /** Current market regime label, for regime-conditioned confidence lookup. */
  currentRegime?: string | null;
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
    pass: stopOnThesisSide,
  });
  if (opt) {
    const quoteUsable =
      opt.bid !== undefined && opt.ask !== undefined && opt.bid >= 0 && opt.ask >= opt.bid;
    criteria.push({
      name: 'two_sided_quote_present',
      description: 'Contract has a usable two-sided quote (bid ≤ ask, bid ≥ 0)',
      pass: quoteUsable,
    });
    criteria.push({
      name: 'mark_within_quote',
      description: 'Entry mark lies within [bid, ask] — a mark outside its own quote is stale',
      pass: quoteUsable && opt.bid! <= opt.mark && opt.mark <= opt.ask!,
    });
  }
  const suppressReason = str(s.signalSkipReason) ?? str(s.liveSkipReason);
  if (suppressReason !== undefined) {
    criteria.push({
      name: 'not_suppressed',
      description: `Signal was suppressed at emission: ${suppressReason}`,
      pass: false,
    });
  }
  const failedCriteria = criteria.filter((c) => !c.pass);
  const triggerData: EntryTriggerSpec | null =
    entryPrice !== undefined
      ? { side: signal.side, orderType: 'limit', limitPrice: entryPrice, criteria }
      : null;
  const entryTrigger =
    triggerData !== null && failedCriteria.length === 0
      ? verified(triggerData)
      : incomplete(
          triggerData,
          failedCriteria.length > 0
            ? failedCriteria.map((c) => `entry criterion failed: ${c.name}`)
            : ['entry price missing/non-finite'],
        );

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
    const contracts = Math.floor(budget / (riskPerShare * 100));
    sizing =
      contracts >= 1
        ? verified<PositionSizing>({
            unit: 'contracts',
            quantity: contracts,
            riskBudget: budget,
            maxLossAtStop: contracts * riskPerShare * 100,
            maxLossHard: contracts * entryPrice * 100,
            basis: 'floor(managedEquity × riskPerTrade / (stopDistance × 100)); hard max loss is full premium',
          })
        : incomplete<PositionSizing>(null, [
            `risk budget $${budget.toFixed(2)} buys 0 contracts at $${(riskPerShare * 100).toFixed(2)} risk/contract`,
          ]);
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
          })
        : incomplete<PositionSizing>(null, ['RiskManager sized 0 (budget below one unit or notional-capped to zero)']);
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
  const incompleteFields = (Object.keys(fields) as (keyof typeof fields)[])
    .filter((k) => fields[k].status !== 'verified');
  return {
    schemaVersion: 1,
    signalId: signal.id,
    symbol: signal.symbol,
    signalType: signal.type,
    mode: str(s.mode) ?? null,
    generatedAt: ctx.now,
    disposition: 'proposal_only',
    confidence: ctx.calibration
      ? confidenceFor(ctx.calibration, signal.type, ctx.currentRegime ?? null).confidence
      : null,
    complete: incompleteFields.length === 0,
    incompleteFields,
    fields,
  };
}

// ── Batch + acceptance instrument ───────────────────────────────────────────

export interface CardBatchSummary {
  total: number;
  complete: number;
  incomplete: number;
  /** Count of cards missing each field — the fold the acceptance grade reads. */
  missingByField: Record<string, number>;
}

/** Build a card for EVERY signal (total by construction) and fold the tally. */
export function buildCards(
  signals: readonly TradeSignal[],
  ctx: CardBuildContext,
): { cards: TradeOpportunityCard[]; summary: CardBatchSummary } {
  const cards = signals.map((sig) => buildTradeOpportunityCard(sig, ctx));
  const missingByField: Record<string, number> = {};
  for (const card of cards) {
    for (const f of card.incompleteFields) {
      missingByField[f] = (missingByField[f] ?? 0) + 1;
    }
  }
  const complete = cards.filter((c) => c.complete).length;
  return {
    cards,
    summary: { total: cards.length, complete, incomplete: cards.length - complete, missingByField },
  };
}
