import type { OptionType } from '@trading-app/shared';

/**
 * TRA-911 (TRA-908 Phase A) — IV-Rank + Technicals option-structure selector.
 *
 * SHADOW ONLY. This module is pure decision logic: given an IV-rank read, a
 * trend label, a technical-breakout flag, ATR, support/resistance anchors and an
 * option chain slice, it picks a defined-risk option STRUCTURE and lays out its
 * legs, strikes, deltas, DTE, sizing INTENT and a rationale. It returns plain
 * data. It does NOT import the router, the order client, or any execution path,
 * and it never holds capital — the caller (server) writes the result to the
 * shadow ledger and stops there. Order routing / short-leg execution / capital
 * are Phase B/C (TRA-912 / TRA-913).
 *
 * Decision matrix (board-approved TRA-908 plan, Section 1):
 *   • IVR ≥ shortPremiumMinIvr (50)  → SHORT premium:
 *       trend up        → bull put spread
 *       trend down      → bear call spread
 *       range-bound     → iron condor
 *   • IVR ≤ longPremiumMaxIvr (25) AND high-conviction technical breakout
 *                                    → debit spread (directional)
 *   • otherwise                      → STAND DOWN (emit nothing)
 *
 * Construction rules:
 *   • Short strike at ~16–30 Δ (target 0.23), anchored on S/R.
 *   • Long strike one wing-width away; wing width = widthAtrMult × ATR.
 *   • DTE window 30–45; new shorts < minShortDte (21) are hard-rejected.
 *   • Earnings before expiry is a HARD gate for LONG premium (debit spreads).
 *   • Liquidity (open interest + bid/ask spread) is a MANDATORY per-leg filter.
 */

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

/** Trend label derived from the TRA-734 confluence stack by the caller. */
export type OptionTrend = 'up' | 'down' | 'range';

/** The structure the gate matrix resolves to (`stand_down` emits nothing). */
export type OptionStrategyKind =
  | 'bull_put_spread'
  | 'bear_call_spread'
  | 'iron_condor'
  | 'debit_spread'
  | 'stand_down';

/** A live quote for one option contract, enriched with a signed BS delta. */
export interface ContractQuote {
  optionSymbol: string;
  optionType: OptionType;
  strike: number;
  /** Signed Black-Scholes delta (calls > 0, puts < 0). */
  delta: number;
  bid: number;
  ask: number;
  openInterest: number;
}

export interface StrategySelectorParams {
  /** IVR at/above which we sell premium (default 50). */
  shortPremiumMinIvr: number;
  /** IVR at/below which we may buy premium on a breakout (default 25). */
  longPremiumMaxIvr: number;
  /** Target absolute delta for the short strike (default 0.23). */
  shortDeltaTarget: number;
  /** Inclusive absolute-delta band for the short strike (default [0.16, 0.30]). */
  shortDeltaBand: [number, number];
  /** Wing width as a multiple of ATR (default 1.0). */
  widthAtrMult: number;
  /** Minimum DTE for a NEW entry (default 30). */
  dteMin: number;
  /** Maximum DTE for a NEW entry (default 45). */
  dteMax: number;
  /** Hard floor: never open a new short under this DTE (default 21). */
  minShortDte: number;
  /** Reject a leg whose open interest is below this (default 250). */
  minOpenInterest: number;
  /** Reject a leg whose (ask − bid)/mid exceeds this (default 0.10 = 10%). */
  maxSpreadPct: number;
  /** Advisory fraction of equity to risk per spread (default 0.02 = 2%). */
  riskFraction: number;
}

export const DEFAULT_SELECTOR_PARAMS: StrategySelectorParams = {
  shortPremiumMinIvr: 50,
  longPremiumMaxIvr: 25,
  shortDeltaTarget: 0.23,
  shortDeltaBand: [0.16, 0.3],
  widthAtrMult: 1.0,
  dteMin: 30,
  dteMax: 45,
  minShortDte: 21,
  minOpenInterest: 250,
  maxSpreadPct: 0.1,
  riskFraction: 0.02,
};

export interface StrategySelectorInput {
  symbol: string;
  /** Underlying spot at evaluation time. */
  spot: number;
  /** IV-rank 0–100, or null when history is insufficient (honest unknown). */
  ivRank: number | null;
  /** Trend from the confluence stack. */
  trend: OptionTrend;
  /** True iff a high-conviction technical breakout fired (TRA-734 stack). */
  highConvictionBreakout: boolean;
  /** ATR on the underlying — drives wing width. */
  atr: number;
  /**
   * Nearest support level (price), or null. Feed `supportResistance().support?.level`
   * from TRA-920 Phase 1 — touch-counted swing zones are better anchors than a
   * flat 20-bar min.
   */
  support: number | null;
  /**
   * Nearest resistance level (price), or null. Feed `supportResistance().resistance?.level`
   * from TRA-920 Phase 1.
   */
  resistance: number | null;
  /**
   * Touch count of the S/R zone that anchors the primary short strike. Recorded
   * in the shadow signal; does not affect the gate matrix. Source:
   * `supportResistance().support?.touches` (long bias) or `.resistance?.touches` (short bias).
   */
  zoneTouches?: number | null;
  /**
   * Reversal-checklist score (0–4) at the current key zone (from `reversalChecklist()`).
   * Used together with `reversalConfirmed` and `reversalSide` to bias the selector
   * toward a directional premium-selling spread in the mid-IVR dead zone. Recorded
   * in the shadow signal for learning; otherwise non-binding.
   */
  reversalScore?: number | null;
  /**
   * True when all four reversal-checklist legs confirmed (score === 4). When true
   * AND `reversalSide` is set, the selector biases toward the aligned spread even
   * in the mid-IVR dead zone where it would otherwise stand down.
   */
  reversalConfirmed?: boolean;
  /**
   * Direction the reversal checklist fired: `'long'` = bounce off support (→ bias
   * bull put spread); `'short'` = rejection at resistance (→ bias bear call spread).
   */
  reversalSide?: 'long' | 'short' | null;
  /** Chosen expiration `YYYY-MM-DD`. */
  expiration: string;
  /** Calendar days to that expiration. */
  daysToExpiry: number;
  /** Calls + puts for `expiration`, each carrying a delta + quote. */
  contracts: ContractQuote[];
  /** True iff an earnings event lands on/before `expiration` (hard gate for long premium). */
  earningsBeforeExpiry: boolean;
  /** ms-epoch the evaluation ran. */
  timestamp: number;
}

export type LegAction = 'sell' | 'buy';

export interface OptionLeg {
  action: LegAction;
  optionType: OptionType;
  strike: number;
  /** Signed delta of the chosen contract. */
  delta: number;
  optionSymbol: string;
  /** (bid + ask) / 2 per share. */
  mark: number;
}

export interface ShadowOptionSignal {
  symbol: string;
  timestamp: number;
  strategy: Exclude<OptionStrategyKind, 'stand_down'>;
  legs: OptionLeg[];
  expiration: string;
  daysToExpiry: number;
  /** |delta| of the (nearest-the-money) short leg, or null for a pure debit. */
  shortDelta: number | null;
  /** Net credit per share for credit structures (positive), else null. */
  netCredit: number | null;
  /** Net debit per share for debit structures (positive), else null. */
  netDebit: number | null;
  /** Strike width of the widest wing, in points. */
  widthPoints: number;
  sizingIntent: {
    /** Defined-risk max loss per spread in dollars (×100 multiplier applied). */
    maxLossPerSpread: number;
    /** Advisory fraction of equity to risk (NO capital is committed). */
    riskFraction: number;
  };
  rationale: string;
  /**
   * Touch count of the S/R zone that anchored the primary short strike, or null
   * when the caller did not provide zone context. Higher touches = stronger zone.
   */
  zoneTouches: number | null;
  /**
   * Reversal-checklist score (0–4) at evaluation time, or null when not provided.
   * Used in the shadow ledger to learn how often high-score setups outperform.
   */
  reversalScore: number | null;
}

/**
 * Selector outcome. `stand_down` = the gate matrix said no. `no_structure` =
 * the gate passed but a well-formed, liquid structure couldn't be built (bad
 * DTE, earnings, missing strikes, illiquid legs) — also emits nothing.
 */
export type StrategySelectorResult =
  | { decision: 'stand_down'; kind: OptionStrategyKind; rationale: string }
  | { decision: 'no_structure'; kind: OptionStrategyKind; rationale: string }
  | { decision: 'signal'; kind: OptionStrategyKind; signal: ShadowOptionSignal };

// ---------------------------------------------------------------------------
// 1. Gate matrix (pure — the explicitly-tested artifact)
// ---------------------------------------------------------------------------

export interface GateDecision {
  kind: OptionStrategyKind;
  rationale: string;
}

/** Optional reversal-regime context for the gate matrix (TRA-924). */
export interface ReversalContext {
  /** True when all four checklist legs fired (`reversalChecklist().confirmed`). */
  reversalConfirmed?: boolean;
  /** Direction the checklist fired — determines which spread to bias toward. */
  reversalSide?: 'long' | 'short' | null;
}

/**
 * Resolve the option structure from (IV-rank × trend × breakout × reversal) per
 * the board-approved plan. Pure and total — every input maps to a decision, with
 * `stand_down` as the safe default (including unknown IV-rank). This is the
 * function the gate-matrix unit tests pin down exhaustively.
 *
 * TRA-924 bias: when a reversal checklist confirms at a key zone AND IVR falls in
 * the mid-zone dead-band (would otherwise stand down), the selector overrides to
 * the directionally-aligned premium-selling spread:
 *   confirmed long (support bounce) → bull put spread
 *   confirmed short (resistance rejection) → bear call spread
 */
export function selectStrategyKind(
  ivRank: number | null,
  trend: OptionTrend,
  highConvictionBreakout: boolean,
  params: StrategySelectorParams = DEFAULT_SELECTOR_PARAMS,
  reversalCtx?: ReversalContext,
): GateDecision {
  if (ivRank === null || !Number.isFinite(ivRank)) {
    return { kind: 'stand_down', rationale: 'iv_rank_unknown' };
  }

  // High IV-rank → sell premium, structure by trend.
  if (ivRank >= params.shortPremiumMinIvr) {
    const ivr = ivRank.toFixed(0);
    if (trend === 'up') {
      return { kind: 'bull_put_spread', rationale: `ivr ${ivr} >= ${params.shortPremiumMinIvr} & trend up` };
    }
    if (trend === 'down') {
      return { kind: 'bear_call_spread', rationale: `ivr ${ivr} >= ${params.shortPremiumMinIvr} & trend down` };
    }
    return { kind: 'iron_condor', rationale: `ivr ${ivr} >= ${params.shortPremiumMinIvr} & range-bound` };
  }

  // Low IV-rank + conviction breakout → buy premium via a debit spread.
  if (ivRank <= params.longPremiumMaxIvr && highConvictionBreakout) {
    return {
      kind: 'debit_spread',
      rationale: `ivr ${ivRank.toFixed(0)} <= ${params.longPremiumMaxIvr} & breakout`,
    };
  }

  // Reversal bias: mid-IVR dead zone + confirmed checklist at a key zone →
  // aligned premium-selling spread. Models the desk "reversal off a key level"
  // entry where the zone provides the directional edge that IV-rank alone lacks.
  if (reversalCtx?.reversalConfirmed) {
    const ivr = ivRank.toFixed(0);
    if (reversalCtx.reversalSide === 'long') {
      return {
        kind: 'bull_put_spread',
        rationale: `ivr ${ivr} mid-zone + confirmed_reversal at support`,
      };
    }
    if (reversalCtx.reversalSide === 'short') {
      return {
        kind: 'bear_call_spread',
        rationale: `ivr ${ivr} mid-zone + confirmed_reversal at resistance`,
      };
    }
  }

  // Mid-IVR dead-zone, or low IVR without a breakout → stand down.
  return {
    kind: 'stand_down',
    rationale: `ivr ${ivRank.toFixed(0)} no edge (mid-zone or no breakout)`,
  };
}

// ---------------------------------------------------------------------------
// 2. Liquidity + strike helpers
// ---------------------------------------------------------------------------

function mark(c: ContractQuote): number | null {
  if (c.bid > 0 && c.ask > 0 && c.ask >= c.bid) return (c.bid + c.ask) / 2;
  return null;
}

/** Mandatory per-leg liquidity gate: enough OI and a tight enough spread. */
export function isLiquid(c: ContractQuote, params: StrategySelectorParams = DEFAULT_SELECTOR_PARAMS): boolean {
  if (!(c.openInterest >= params.minOpenInterest)) return false;
  const m = mark(c);
  if (m === null || m <= 0) return false;
  const spreadPct = (c.ask - c.bid) / m;
  return spreadPct <= params.maxSpreadPct;
}

/**
 * Pick the short strike of the given option type: the liquid contract whose
 * absolute delta is nearest the target, preferring one inside the band and, when
 * a support/resistance anchor is supplied, on the protective side of it (short
 * puts at/below support; short calls at/above resistance). Returns null when no
 * liquid candidate exists.
 */
function pickShortStrike(
  contracts: ContractQuote[],
  optionType: OptionType,
  anchor: number | null,
  params: StrategySelectorParams,
): ContractQuote | null {
  const [lo, hi] = params.shortDeltaBand;
  const liquid = contracts.filter((c) => c.optionType === optionType && isLiquid(c, params));
  if (liquid.length === 0) return null;

  // S/R anchoring: short puts sit at/below support, short calls at/above
  // resistance. Only constrain when an anchor exists and leaves candidates.
  let anchored = liquid;
  if (anchor !== null && Number.isFinite(anchor)) {
    const onSide =
      optionType === 'put'
        ? liquid.filter((c) => c.strike <= anchor)
        : liquid.filter((c) => c.strike >= anchor);
    if (onSide.length > 0) anchored = onSide;
  }

  const inBand = anchored.filter((c) => Math.abs(c.delta) >= lo && Math.abs(c.delta) <= hi);
  const pool = inBand.length > 0 ? inBand : anchored;
  return pool.reduce((best, c) =>
    Math.abs(Math.abs(c.delta) - params.shortDeltaTarget) <
    Math.abs(Math.abs(best.delta) - params.shortDeltaTarget)
      ? c
      : best,
  );
}

/** Nearest liquid contract of `optionType` to `targetStrike`. */
function pickStrikeNear(
  contracts: ContractQuote[],
  optionType: OptionType,
  targetStrike: number,
  params: StrategySelectorParams,
): ContractQuote | null {
  const liquid = contracts.filter((c) => c.optionType === optionType && isLiquid(c, params));
  if (liquid.length === 0) return null;
  return liquid.reduce((best, c) =>
    Math.abs(c.strike - targetStrike) < Math.abs(best.strike - targetStrike) ? c : best,
  );
}

function leg(action: LegAction, c: ContractQuote): OptionLeg {
  return {
    action,
    optionType: c.optionType,
    strike: c.strike,
    delta: c.delta,
    optionSymbol: c.optionSymbol,
    mark: mark(c) ?? 0,
  };
}

// ---------------------------------------------------------------------------
// 3. Vertical builders (defined-risk, two legs each)
// ---------------------------------------------------------------------------

const MULTIPLIER = 100;

interface Vertical {
  legs: OptionLeg[];
  shortDelta: number;
  netCredit: number | null;
  netDebit: number | null;
  width: number;
}

/**
 * Build a credit vertical: sell the short strike, buy protection one wing-width
 * out. `direction` = 'put' for a bull put spread, 'call' for a bear call spread.
 * Returns null if either liquid leg is missing.
 */
function buildCreditVertical(
  contracts: ContractQuote[],
  optionType: OptionType,
  anchor: number | null,
  atr: number,
  params: StrategySelectorParams,
): Vertical | null {
  const short = pickShortStrike(contracts, optionType, anchor, params);
  if (!short) return null;
  const width = Math.max(atr * params.widthAtrMult, 0);
  // Long wing is further OTM: lower strike for puts, higher for calls.
  const longTarget = optionType === 'put' ? short.strike - width : short.strike + width;
  const long = pickStrikeNear(contracts, optionType, longTarget, params);
  if (!long || long.strike === short.strike) return null;

  const shortMark = mark(short);
  const longMark = mark(long);
  if (shortMark === null || longMark === null) return null;
  const netCredit = shortMark - longMark;

  return {
    legs: [leg('sell', short), leg('buy', long)],
    shortDelta: Math.abs(short.delta),
    netCredit,
    netDebit: null,
    width: Math.abs(short.strike - long.strike),
  };
}

/**
 * Build a directional debit vertical for a breakout: buy near-the-money, sell
 * one wing-width in the trade direction to cut cost/vega. `up` → call debit,
 * `down` → put debit.
 */
function buildDebitVertical(
  contracts: ContractQuote[],
  trend: OptionTrend,
  spot: number,
  atr: number,
  params: StrategySelectorParams,
): Vertical | null {
  const optionType: OptionType = trend === 'down' ? 'put' : 'call';
  // Long leg: nearest-the-money liquid contract.
  const long = pickStrikeNear(contracts, optionType, spot, params);
  if (!long) return null;
  const width = Math.max(atr * params.widthAtrMult, 0);
  const shortTarget = optionType === 'call' ? long.strike + width : long.strike - width;
  const short = pickStrikeNear(contracts, optionType, shortTarget, params);
  if (!short || short.strike === long.strike) return null;

  const longMark = mark(long);
  const shortMark = mark(short);
  if (longMark === null || shortMark === null) return null;
  const netDebit = longMark - shortMark;
  if (!(netDebit > 0)) return null;

  return {
    legs: [leg('buy', long), leg('sell', short)],
    shortDelta: Math.abs(short.delta),
    netCredit: null,
    netDebit,
    width: Math.abs(short.strike - long.strike),
  };
}

// ---------------------------------------------------------------------------
// 4. Top-level selector — gate matrix + DTE/earnings/liquidity + leg build
// ---------------------------------------------------------------------------

/**
 * Run the full Phase-A selector. Returns a `signal` only when (a) the gate
 * matrix resolves to a tradeable structure, (b) the DTE and earnings gates pass,
 * and (c) liquid legs can be assembled. Every other path returns `stand_down`
 * or `no_structure` — i.e. emits nothing. NEVER routes an order.
 */
export function selectShadowOptionSignal(
  input: StrategySelectorInput,
  params: StrategySelectorParams = DEFAULT_SELECTOR_PARAMS,
): StrategySelectorResult {
  const gate = selectStrategyKind(input.ivRank, input.trend, input.highConvictionBreakout, params, {
    reversalConfirmed: input.reversalConfirmed,
    reversalSide: input.reversalSide,
  });
  if (gate.kind === 'stand_down') {
    return { decision: 'stand_down', kind: 'stand_down', rationale: gate.rationale };
  }

  const isShortPremium =
    gate.kind === 'bull_put_spread' ||
    gate.kind === 'bear_call_spread' ||
    gate.kind === 'iron_condor';
  const isLongPremium = gate.kind === 'debit_spread';

  // DTE window for a NEW entry. Hard floor for shorts; window for everything.
  if (isShortPremium && input.daysToExpiry < params.minShortDte) {
    return { decision: 'no_structure', kind: gate.kind, rationale: `dte ${input.daysToExpiry} < min short ${params.minShortDte}` };
  }
  if (input.daysToExpiry < params.dteMin || input.daysToExpiry > params.dteMax) {
    return { decision: 'no_structure', kind: gate.kind, rationale: `dte ${input.daysToExpiry} outside ${params.dteMin}-${params.dteMax}` };
  }

  // Earnings hard gate for LONG premium (no debit through earnings).
  if (isLongPremium && input.earningsBeforeExpiry) {
    return { decision: 'no_structure', kind: gate.kind, rationale: 'earnings before expiry (long-premium gate)' };
  }

  if (!(input.atr > 0)) {
    return { decision: 'no_structure', kind: gate.kind, rationale: 'atr unavailable' };
  }

  // Build the structure's legs.
  let legs: OptionLeg[] = [];
  let shortDelta: number | null = null;
  let netCredit: number | null = null;
  let netDebit: number | null = null;
  let widthPoints = 0;

  if (gate.kind === 'bull_put_spread') {
    const v = buildCreditVertical(input.contracts, 'put', input.support, input.atr, params);
    if (!v) return { decision: 'no_structure', kind: gate.kind, rationale: 'no liquid put vertical' };
    ({ legs, netCredit, netDebit, width: widthPoints } = v);
    shortDelta = v.shortDelta;
  } else if (gate.kind === 'bear_call_spread') {
    const v = buildCreditVertical(input.contracts, 'call', input.resistance, input.atr, params);
    if (!v) return { decision: 'no_structure', kind: gate.kind, rationale: 'no liquid call vertical' };
    ({ legs, netCredit, netDebit, width: widthPoints } = v);
    shortDelta = v.shortDelta;
  } else if (gate.kind === 'iron_condor') {
    const put = buildCreditVertical(input.contracts, 'put', input.support, input.atr, params);
    const call = buildCreditVertical(input.contracts, 'call', input.resistance, input.atr, params);
    if (!put || !call) return { decision: 'no_structure', kind: gate.kind, rationale: 'no liquid condor wings' };
    legs = [...put.legs, ...call.legs];
    netCredit = (put.netCredit ?? 0) + (call.netCredit ?? 0);
    widthPoints = Math.max(put.width, call.width);
    shortDelta = Math.max(put.shortDelta, call.shortDelta);
  } else {
    // debit_spread
    const v = buildDebitVertical(input.contracts, input.trend, input.spot, input.atr, params);
    if (!v) return { decision: 'no_structure', kind: gate.kind, rationale: 'no liquid debit vertical' };
    ({ legs, netCredit, netDebit, width: widthPoints } = v);
    shortDelta = v.shortDelta;
  }

  // Defined-risk max loss per spread.
  //  • credit verticals: (width − credit) × 100
  //  • iron condor: (widest wing − total credit) × 100 (only one side can lose)
  //  • debit: net debit × 100
  let maxLossPerSpread: number;
  if (netDebit !== null) {
    maxLossPerSpread = netDebit * MULTIPLIER;
  } else {
    maxLossPerSpread = Math.max(0, (widthPoints - (netCredit ?? 0)) * MULTIPLIER);
  }

  const strategy = gate.kind as Exclude<OptionStrategyKind, 'stand_down'>;
  const signal: ShadowOptionSignal = {
    symbol: input.symbol,
    timestamp: input.timestamp,
    strategy,
    legs,
    expiration: input.expiration,
    daysToExpiry: input.daysToExpiry,
    shortDelta,
    netCredit: netCredit === null ? null : round2(netCredit),
    netDebit: netDebit === null ? null : round2(netDebit),
    widthPoints,
    sizingIntent: {
      maxLossPerSpread: round2(maxLossPerSpread),
      riskFraction: params.riskFraction,
    },
    rationale: gate.rationale,
    zoneTouches: input.zoneTouches ?? null,
    reversalScore: input.reversalScore ?? null,
  };

  return { decision: 'signal', kind: gate.kind, signal };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
