import { appendFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from './observability/index.js';
import { resolveDataDir } from './data-dir.js';
import { entryDeltaBucket, entryDteBand, type EntryDteBand } from './option-trade-journal.js';

// TRA-4888 (board direction on TRA-4885, item 3) — OBSERVE-ONLY real-fill shadow.
//
// ── What is broken ──────────────────────────────────────────────────────────
// `premiumPaid` on an engine-opened row STARTS LIFE as the scanner's pre-trade
// NBBO **mid** (`option-trade-journal.ts:771`, `:2605`; `options-account.ts:4825`,
// `:4881`, `:5476`). A cost-dominated strategy measured at mid is measured with
// its dominant cost removed: spread cross is **99.1%** of measured cost against
// 0.9% of fees (TRA-4885 §2b). That is what manufactured **+1.13 R** in
// `single_leg_otm::0.50-0.55` while the 23 REAL desk rows in the same cell
// returned **−0.835 R_gate**. Same cell, opposite sign, and the only difference
// is the basis.
//
// ── What already exists, and is NOT rebuilt here ────────────────────────────
//   • TRA-4674 `crossedPnlUsd` publishes the crossed number BESIDE
//     `realizedPnlUsd`. That is a diagnostic on an already-booked row; the
//     BASIS is still mid.
//   • `option-maker-shadow.ts` runs a forward shadow CHASE and measures
//     `recoveryPct` — how much of the raw cross a ladder rung recovers. It is a
//     measurement of the LEVER, per chase, and it produces no per-trade booked
//     basis and no taxonomy. Its fill rule is imported conceptually below as
//     `touch_cross` so the two surfaces can be compared row-for-row rather than
//     diverging silently.
//   • Tradier SANDBOX is not a substitute: `fillRealism: 'SANDBOX_SIMULATED'`
//     explicitly disclaims queue position, slippage and partial fills
//     (TRA-4809 `done` — "a plumbing rig, not a learning surface").
//
// ── What this module adds ───────────────────────────────────────────────────
// A resting limit order is advanced against a POLLED tape and books a
// `fillBasisUsd` under a NAMED fill rule, beside the `midBasisUsd` the journal
// books today. Both numbers ride every row, so the error the defect is about is
// the row's own `basisDeltaUsd` rather than something a reader must re-derive.
//
// Three rules are evaluated on EVERY poll and all three verdicts are recorded,
// because the choice of rule IS the measurement and a single stamped verdict
// cannot show that the rules disagreed:
//
//   touch_cross         the opposing touch reaches our limit (a buy at L fills
//                       iff ask <= L). This is `option-maker-shadow`'s rule. It
//                       is PERMISSIVE about queue: a book that merely quotes at
//                       our price has not necessarily served us.
//   print_at_limit      a NEW PRINT occurred at or better than L. Evidence that
//                       trading happened at our price — but a print AT our limit
//                       is exactly the case queue position decides, and we
//                       cannot see queue position (see UNMODELLED below).
//   print_through_limit a NEW PRINT occurred STRICTLY better than L. This is the
//                       rule the board asked for — "fills only when the market
//                       trades through it" — and it is the CONSERVATIVE one: if
//                       the tape printed below our buy limit, a resting order at
//                       L ahead of that print would have had to be served first
//                       regardless of where in the queue it sat.
//
// `print_through_limit` is the default `primaryRule` and is what stamps
// `fillBasisUsd`. The other two ride along as columns.
//
// ── Why a print tape is readable at all (TRA-4870) ──────────────────────────
// Tradier's `trade_date` was documented in this repo as a quote timestamp and
// was measured on 2026-09-24 to be the **LAST-TRADE** clock: frozen up to
// 863.7 h on a contract whose `bid_date` was 0.9 s old, and bit-identical
// across three 25 s snaps while the quote clocks advanced
// (`docs/tradier-quote-clock-TRA-4870.md`). That finding is a liability for the
// freshness gate and an ASSET here: a clock that only moves when a print lands
// is precisely the new-print detector a trade-through rule needs. This module
// is the first consumer to read it as what it is.
//
// NOTHING here routes an order, prices a live fill, or gates an admission. It
// reads a tape and writes a ledger. Observe-only, no capital, no gate loosened.

const log = logger.child({ module: 'option-real-fill-shadow' });

/** Kill switch — nothing is advanced or recorded unless this is truthy. OFF by default. */
export const OPTION_REAL_FILL_SHADOW_FLAG = 'ENABLE_OPTION_REAL_FILL_SHADOW';

export function isOptionRealFillShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[OPTION_REAL_FILL_SHADOW_FLAG];
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * Row schema tag. TRA-4885 child A counts what this module produces, so the
 * shape is versioned ON THE ROW: a consumer that folds two schema versions into
 * one mean is the failure this tag exists to make visible. Bump on any change
 * to the meaning of an existing field — never on an additive one.
 */
export const REAL_FILL_SHADOW_SCHEMA = 'real_fill_shadow_v1' as const;

/** Fill-model version, stamped per row beside the schema. */
export const REAL_FILL_MODEL_VERSION = 'tra4888.1' as const;

// ─────────────────────────────────────────────────────────────────────────────
// The declared-unmodelled surface.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TRA-4888 asked for queue position and partial fills "modelled or explicitly
 * declared unmodelled". This is that declaration, and it SHIPS ON EVERY ROLLUP
 * rather than living in a comment — a reader who pulls the summary must not
 * have to find this file to learn what the number cannot see.
 *
 * Each entry names the dimension, whether it is modelled, and — for the
 * unmodelled ones — WHICH DIRECTION the omission biases the measurement. A
 * declared limitation with no direction is not usable by a promotion gate: the
 * gate has to know whether a green reading is conservative or flattering.
 */
export interface UnmodelledDimension {
  dimension: string;
  modelled: boolean;
  /** Why it is not modelled, in terms of the data we actually receive. */
  reason: string;
  /**
   * `against` — the omission makes the measured basis WORSE than reality
   * (conservative; a lever clearing this bar clears it for real).
   * `flattering` — the omission makes it BETTER than reality (a green here is
   * not evidence).
   * `unknown` — sign not established. Treat as flattering until measured.
   */
  bias: 'against' | 'flattering' | 'unknown' | 'none';
}

export const REAL_FILL_UNMODELLED: readonly UnmodelledDimension[] = Object.freeze([
  Object.freeze({
    dimension: 'queue_position',
    modelled: false,
    reason:
      'Tradier market data returns NBBO top-of-book only — no depth, no per-exchange size, no '
      + 'order count ahead of ours. There is no field from which a queue rank could be derived, '
      + 'so this is not a modelling choice we deferred; it is not observable on this feed.',
    bias: 'against',
  }),
  Object.freeze({
    dimension: 'print_sampling',
    modelled: false,
    reason:
      'The tape is POLLED, not streamed. Between two polls many prints can land and only the '
      + 'FINAL one survives in `last`. A print that traded through our limit mid-interval and '
      + 'then reverted is invisible, so trade-through fills are UNDER-counted.',
    bias: 'against',
  }),
  Object.freeze({
    dimension: 'partial_fills',
    modelled: true,
    reason:
      'Modelled when the poll carries cumulative contract `volume`: fillable size is '
      + '`floor(volumeDelta x participationRate)`, clamped to the unfilled remainder. When '
      + '`volume` is absent the row falls back to ALL-OR-NONE and stamps '
      + '`partialFillBasis: all_or_none_unmodelled` — read that column before pooling.',
    bias: 'unknown',
  }),
  Object.freeze({
    dimension: 'hidden_and_midpoint_liquidity',
    modelled: false,
    reason:
      'Price-improvement mechanisms (midpoint match, retail liquidity programs, auction '
      + 'responses) are not visible on NBBO top-of-book, so a fill we would have received '
      + 'inside the quoted spread is never credited.',
    bias: 'against',
  }),
  Object.freeze({
    dimension: 'market_impact',
    modelled: false,
    reason:
      'Our own resting size is assumed not to move the book. At engine lot sizes against '
      + 'listed-option depth this is close to true, but it is an assumption, not a measurement.',
    bias: 'flattering',
  }),
  Object.freeze({
    dimension: 'exchange_fees_and_commission',
    modelled: false,
    reason:
      'This module measures the SPREAD half of cost only. Fees are 0.9% of measured cost '
      + '(TRA-4885) and are already carried by the fee/slippage ledger; double-counting them '
      + 'here would corrupt the comparison against `midBasisUsd`, which is also fee-free.',
    bias: 'flattering',
  }),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Tape + order model.
// ─────────────────────────────────────────────────────────────────────────────

export type FillSide = 'buy' | 'sell';

/**
 * One poll of the contract. Every field is nullable on purpose: a field this
 * module cannot read must produce an UNGRADED verdict, never a silent `no_fill`
 * — an unreadable tape that reads as "never filled" would drop exactly the
 * illiquid rows the cost bar is about, and a survivorship hole is worse than a
 * missing row a consumer can count.
 */
export interface RealFillTapeSample {
  ts: number;
  bid: number | null;
  ask: number | null;
  /** Last print price. */
  last: number | null;
  /**
   * Tradier `trade_date` in ms epoch — the LAST-TRADE clock (TRA-4870), NOT the
   * quote clock. Advancing ⇒ a new print landed since the previous poll.
   */
  lastTradeMs: number | null;
  /** Cumulative session contract volume, when the poll carried it (chain reads do; quote reads do not). */
  volume: number | null;
}

export type RealFillRule = 'touch_cross' | 'print_at_limit' | 'print_through_limit';

export const REAL_FILL_RULES: readonly RealFillRule[] = Object.freeze([
  'touch_cross',
  'print_at_limit',
  'print_through_limit',
]);

/**
 * `ungraded` is a FIRST-CLASS verdict and is never collapsed into `no_fill`.
 * The two are different facts — "the market did not come to our price" versus
 * "we could not see whether it did" — and a rollup that cannot tell them apart
 * reports a fill rate over an unknown denominator.
 */
export type RuleVerdict = 'fill' | 'no_fill' | 'ungraded';

export type RealFillOutcome = 'filled' | 'partial' | 'unfilled' | 'ungraded';

export type PartialFillBasis = 'volume_participation' | 'all_or_none_unmodelled';

/** Defaults for the fill model. Overridable per-order so a sweep can vary one knob. */
export interface RealFillModelConfig {
  /** Which rule stamps `fillBasisUsd`. Default `print_through_limit` (the conservative one). */
  primaryRule: RealFillRule;
  /**
   * Share of observed printed volume a resting order of ours is assumed to
   * capture. 0.10 is a deliberately modest default; it is NOT measured, and the
   * sensitivity of any downstream number to it must be reported beside that
   * number.
   */
  participationRate: number;
  /** Ladder/resting lifetime. Past this the order is abandoned unfilled. */
  maxRestMs: number;
}

export const DEFAULT_REAL_FILL_CONFIG: RealFillModelConfig = Object.freeze({
  primaryRule: 'print_through_limit',
  participationRate: 0.1,
  maxRestMs: 5 * 60_000,
});

/** Which of the two independent print tells was readable, over an order's whole life. */
export interface PrintTellCoverage {
  clock: boolean;
  volume: boolean;
}

export interface RestingOrderState {
  id: string;
  side: FillSide;
  optionSymbol: string;
  limitUsd: number;
  contractsRequested: number;
  contractsFilled: number;
  placedAt: number;
  /** Decision-time NBBO — the basis the journal books today. */
  decisionBid: number;
  decisionAsk: number;
  decisionMid: number;
  config: RealFillModelConfig;
  polls: number;
  /** Previous sample, held so the print clock and volume can be differenced. */
  prev: RealFillTapeSample | null;
  /** True once any poll produced a usable print clock or volume delta. */
  printTapeReadable: boolean;
  /**
   * WHICH tell carried that readability, over the order's whole life. Tracked
   * separately from `printTapeReadable` so a rollup can say whether the
   * TRA-4893 clock tell actually contributes, rather than inferring it.
   */
  printTells: PrintTellCoverage;
  firstFillAt: number | null;
  /** Size-weighted mean of the prices we were filled at. */
  filledNotionalUsd: number;
  /**
   * Per-rule verdict AGGREGATED OVER THE ORDER'S WHOLE LIFE, not the last
   * poll's snapshot. `fill` means the rule said fill on at least one poll.
   *
   * This distinction is the reason the disagreement statistic is readable at
   * all: an order that filled on poll 2 and expired on poll 9 would otherwise
   * publish poll 9's verdicts, which describe a market the order was no longer
   * resting in. The question this column answers is "would THIS rule have
   * filled THIS order", and that is a fact about the whole rest, not an instant.
   */
  ruleVerdicts: Record<RealFillRule, RuleVerdict>;
  partialFillBasis: PartialFillBasis;
}

/**
 * Fold a poll's verdict into the order-lifetime aggregate.
 * Precedence `fill` > `no_fill` > `ungraded`: one readable poll is enough to
 * lift a rule out of `ungraded`, and one fill is enough to say the rule fills.
 */
function mergeVerdict(prior: RuleVerdict, next: RuleVerdict): RuleVerdict {
  if (prior === 'fill' || next === 'fill') return 'fill';
  if (prior === 'no_fill' || next === 'no_fill') return 'no_fill';
  return 'ungraded';
}

let seq = 0;
function nextId(ts: number): string {
  seq += 1;
  return `rf_${ts}_${seq}`;
}

/**
 * Begin a resting shadow order. Returns `null` on a one-sided or crossed
 * decision quote — a basis comparison against a mid that does not exist is
 * meaningless, and such rows DROP OUT of the denominator rather than being
 * booked at a flattering zero cost.
 */
export function beginRestingOrder(
  input: {
    side: FillSide;
    optionSymbol: string;
    limitUsd: number;
    contracts: number;
    bid: number;
    ask: number;
  },
  nowTs: number,
  config: RealFillModelConfig = DEFAULT_REAL_FILL_CONFIG,
): RestingOrderState | null {
  const { bid, ask } = input;
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  if (!(bid > 0) || !(ask > 0) || !(ask > bid)) return null;
  if (!Number.isFinite(input.limitUsd) || !(input.limitUsd > 0)) return null;
  if (!Number.isFinite(input.contracts) || !(input.contracts > 0)) return null;

  return {
    id: nextId(nowTs),
    side: input.side,
    optionSymbol: input.optionSymbol,
    limitUsd: input.limitUsd,
    contractsRequested: input.contracts,
    contractsFilled: 0,
    placedAt: nowTs,
    decisionBid: bid,
    decisionAsk: ask,
    decisionMid: (bid + ask) / 2,
    config,
    polls: 0,
    prev: null,
    printTapeReadable: false,
    printTells: { clock: false, volume: false },
    firstFillAt: null,
    filledNotionalUsd: 0,
    ruleVerdicts: { touch_cross: 'ungraded', print_at_limit: 'ungraded', print_through_limit: 'ungraded' },
    partialFillBasis: 'all_or_none_unmodelled',
  };
}

/**
 * The outcome of one print probe.
 *
 * `clockReadable` / `volumeReadable` are carried SEPARATELY from `printed`
 * (TRA-4893 item 4) because the two tells have very different coverage and the
 * difference is not knowable a priori. Until TRA-4893 only the volume tell was
 * ever fed — `lastTradeMs` was hard-wired `null` at the call site because
 * Tradier's `trade_date` was not projected into `OptionChainRow`. Now that it
 * is, "the clock tell is live" must be MEASURED rather than assumed: a chain
 * endpoint that simply omits `trade_date` would leave `clockReadable` false on
 * every row, and the fleet would read exactly as it does today — one more
 * detector that is present, called, and contributes nothing. These two booleans
 * are folded up into {@link RealFillShadowSummary.printTellCoverage} so that
 * state is visible in the rollup instead of inferred from an unchanged
 * `nUngraded`.
 */
export interface PrintDetection {
  printed: boolean;
  volumeDelta: number | null;
  /** Both polls carried a last-trade clock, so the clock tell could be evaluated. */
  clockReadable: boolean;
  /** Both polls carried cumulative volume, so the volume tell could be evaluated. */
  volumeReadable: boolean;
}

/**
 * Did a NEW print land between `prev` and `curr`?
 *
 * Two independent tells, either of which is sufficient: the last-trade clock
 * advanced, or cumulative volume rose. `null` means neither could be read and
 * the print rules must grade `ungraded`.
 *
 * A volume DECREASE is a session rollover (the counter resets daily), not a
 * negative trade — it reads as "cannot tell", never as a print.
 */
export function detectNewPrint(
  prev: RealFillTapeSample | null,
  curr: RealFillTapeSample,
): PrintDetection | null {
  if (prev === null) return null;
  const clockReadable = typeof prev.lastTradeMs === 'number' && typeof curr.lastTradeMs === 'number';
  const volumeReadable = typeof prev.volume === 'number' && typeof curr.volume === 'number';
  if (!clockReadable && !volumeReadable) return null;

  const clockAdvanced = clockReadable && (curr.lastTradeMs as number) > (prev.lastTradeMs as number);
  let volumeDelta: number | null = null;
  if (volumeReadable) {
    const d = (curr.volume as number) - (prev.volume as number);
    volumeDelta = d >= 0 ? d : null; // negative ⇒ rollover ⇒ unreadable, not a print
  }
  const volumeRose = volumeDelta !== null && volumeDelta > 0;
  return { printed: clockAdvanced || volumeRose, volumeDelta, clockReadable, volumeReadable };
}

/** Grade one rule against one poll. Exported so a control can assert each rule in isolation. */
export function gradeRule(
  rule: RealFillRule,
  side: FillSide,
  limitUsd: number,
  curr: RealFillTapeSample,
  print: PrintDetection | null,
): RuleVerdict {
  if (rule === 'touch_cross') {
    const touch = side === 'buy' ? curr.ask : curr.bid;
    if (typeof touch !== 'number' || !Number.isFinite(touch) || !(touch > 0)) return 'ungraded';
    if (side === 'buy') return touch <= limitUsd ? 'fill' : 'no_fill';
    return touch >= limitUsd ? 'fill' : 'no_fill';
  }

  // Both print rules need the print clock AND a price to compare.
  if (print === null) return 'ungraded';
  if (typeof curr.last !== 'number' || !Number.isFinite(curr.last) || !(curr.last > 0)) return 'ungraded';
  if (!print.printed) return 'no_fill';

  if (rule === 'print_at_limit') {
    return side === 'buy'
      ? (curr.last <= limitUsd ? 'fill' : 'no_fill')
      : (curr.last >= limitUsd ? 'fill' : 'no_fill');
  }
  // print_through_limit — STRICTLY better than our limit.
  return side === 'buy'
    ? (curr.last < limitUsd ? 'fill' : 'no_fill')
    : (curr.last > limitUsd ? 'fill' : 'no_fill');
}

/**
 * Advance the resting order against one poll.
 *
 * Returns `true` once the order is terminal (fully filled, or rested past
 * `maxRestMs`). A partially-filled order that runs out of time is terminal at
 * its partial size — that is a real outcome of a resting limit and must not be
 * rounded up to a fill or down to nothing.
 *
 * ⚠️ The order fills AT ITS OWN LIMIT, never at the (better) observed print or
 * touch. A resting limit order does not receive price improvement in this
 * model, and crediting it with the prevailing price would book an improvement
 * the `queue_position` omission has already failed to earn.
 */
export function advanceRestingOrder(
  state: RestingOrderState,
  curr: RealFillTapeSample,
  nowTs: number = curr.ts,
): boolean {
  state.polls += 1;
  const print = detectNewPrint(state.prev, curr);
  if (print !== null) {
    state.printTapeReadable = true;
    // Sticky OR, not last-poll: a tell that was readable on any poll of this
    // order's life did contribute to its grade, and a tape that goes dark on
    // the final poll must not erase that.
    if (print.clockReadable) state.printTells.clock = true;
    if (print.volumeReadable) state.printTells.volume = true;
  }

  const pollVerdicts: Record<RealFillRule, RuleVerdict> = {
    touch_cross: gradeRule('touch_cross', state.side, state.limitUsd, curr, print),
    print_at_limit: gradeRule('print_at_limit', state.side, state.limitUsd, curr, print),
    print_through_limit: gradeRule('print_through_limit', state.side, state.limitUsd, curr, print),
  };
  for (const rule of REAL_FILL_RULES) {
    state.ruleVerdicts[rule] = mergeVerdict(state.ruleVerdicts[rule], pollVerdicts[rule]);
  }
  state.prev = curr;

  const remaining = state.contractsRequested - state.contractsFilled;
  if (pollVerdicts[state.config.primaryRule] === 'fill' && remaining > 0) {
    let take: number;
    if (print !== null && print.volumeDelta !== null) {
      state.partialFillBasis = 'volume_participation';
      take = Math.min(remaining, Math.floor(print.volumeDelta * state.config.participationRate));
    } else {
      state.partialFillBasis = 'all_or_none_unmodelled';
      take = remaining;
    }
    if (take > 0) {
      state.contractsFilled += take;
      state.filledNotionalUsd += take * state.limitUsd;
      if (state.firstFillAt === null) state.firstFillAt = nowTs;
    }
  }

  if (state.contractsFilled >= state.contractsRequested) return true;
  return nowTs - state.placedAt >= state.config.maxRestMs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Taxonomy — the five axes TRA-4888 asks every row to carry.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Spread-width bands on `(ask − bid) / mid` — the same quantity the journal
 * publishes as `entrySpreadPct`, so a row here and a row there bucket on one
 * definition. Half-open `[from, to)`, and an unreadable quote is `unknown`,
 * never the tightest band.
 */
export type SpreadBand = 'lte05' | 'lte10' | 'lte20' | 'lte40' | 'gt40' | 'unknown';

export function spreadBandOf(spreadPct: number | null): SpreadBand {
  if (typeof spreadPct !== 'number' || !Number.isFinite(spreadPct) || spreadPct < 0) return 'unknown';
  if (spreadPct <= 0.05) return 'lte05';
  if (spreadPct <= 0.10) return 'lte10';
  if (spreadPct <= 0.20) return 'lte20';
  if (spreadPct <= 0.40) return 'lte40';
  return 'gt40';
}

/**
 * Liquidity bands on open interest. Separate axis from spread on purpose: a
 * contract can quote tight on thin OI (a market maker's obligation) and the two
 * facts predict different fill behaviour. Absent OI is `unknown`, NOT `oi_lt100`
 * — an unmeasured contract must not land in the band the promotion gate is most
 * likely to refuse, which would read as evidence it does not have.
 */
export type LiquidityBand = 'oi_lt100' | 'oi_lt1k' | 'oi_lt10k' | 'oi_gte10k' | 'unknown';

export function liquidityBandOf(openInterest: number | null): LiquidityBand {
  if (typeof openInterest !== 'number' || !Number.isFinite(openInterest) || openInterest < 0) return 'unknown';
  if (openInterest < 100) return 'oi_lt100';
  if (openInterest < 1_000) return 'oi_lt1k';
  if (openInterest < 10_000) return 'oi_lt10k';
  return 'oi_gte10k';
}

/** How the order was placed. `taker_cross` pays the full touch; the rest rest. */
export type EntryType = 'taker_cross' | 'maker_mid' | 'maker_ladder_rung' | 'maker_touch' | 'unknown';

/**
 * How the position left. Derived from the journal's free-text `exitReason` by
 * {@link classifyExitType} rather than invented as a parallel vocabulary — the
 * journal's string is the shipped symbol and this axis must not drift from it.
 */
export type ExitType =
  | 'stop_loss'
  | 'take_profit'
  | 'trailing_stop'
  | 'time_stop'
  | 'expiry'
  | 'assignment'
  | 'manual'
  | 'reconstructed'
  | 'other'
  | 'unknown';

/**
 * ⚠️ `other` and `unknown` are DIFFERENT and are never merged. `unknown` is an
 * ABSENT reason (nothing was recorded); `other` is a reason that was recorded
 * and that this classifier does not yet have a bucket for. Collapsing them
 * would make a gap in this function look like a gap in the data.
 */
export function classifyExitType(exitReason: string | null | undefined): ExitType {
  if (typeof exitReason !== 'string' || exitReason.trim() === '') return 'unknown';
  const r = exitReason.trim().toLowerCase();
  if (r.startsWith('reconstructed')) return 'reconstructed';
  if (r.includes('trail')) return 'trailing_stop';
  if (r.includes('stop') || r.includes('sl')) return 'stop_loss';
  if (r.includes('tp') || r.includes('profit') || r.includes('target')) return 'take_profit';
  if (r.includes('expir') || r.includes('dte')) return 'expiry';
  if (r.includes('assign') || r.includes('called_away') || r.includes('exercis')) return 'assignment';
  if (r.includes('time') || r.includes('max_hold')) return 'time_stop';
  if (r.includes('manual') || r.includes('operator') || r.includes('desk')) return 'manual';
  return 'other';
}

/**
 * Where a row's ENTRY-TIME taxonomy came from. TRA-4893 item 1.
 *
 * Every row's delta / DTE / spread / liquidity bands describe WHAT WE ENTERED
 * INTO, never what the contract decayed to — a close row bucketed on its exit
 * delta would migrate cells as it moved and make `byDeltaBand` unreadable. But
 * there are three different ways a row can come to hold entry-time numbers, and
 * they are NOT equally trustworthy:
 *
 *   `entry_native`    Built at the open, from the live entry quote. Complete.
 *   `entry_carried`   A close row handed the exact taxonomy object its own open
 *                     row was built with. Identical to `entry_native` by
 *                     construction — same object, same fields.
 *   `entry_rederived` A close row whose open-side taxonomy was NOT in memory
 *                     (process restarted between open and close, or the row was
 *                     opened before the flag was armed) and which therefore
 *                     rebuilt entry-time bands from the position's PERSISTED
 *                     entry fields. Open interest is not persisted on the
 *                     position, so `liquidityBand` is `unknown` on these rows —
 *                     NOT a real band.
 *
 * ⚠️ A pooled `byLiquidityBand` over `entry_rederived` rows is measuring the
 * absence of a persisted field, not the liquidity of the contracts. Partition on
 * this column before reading that axis. It exists because the alternative — a
 * close row that looks exactly like an open row while carrying a structurally
 * `unknown` band — is the pass/fail-identical instrument this ticket was filed
 * about.
 */
export type EntryTaxonomySource = 'entry_native' | 'entry_carried' | 'entry_rederived';

export interface RealFillTaxonomy {
  /** `entryDeltaBucket(|delta|)` — the SHIPPED bucketer, not a re-implementation. */
  deltaBand: string;
  delta: number | null;
  dte: number | null;
  /** `entryDteBand(dte)`, or `unknown` when DTE was not measured. */
  dteBand: EntryDteBand | 'unknown';
  spreadUsd: number | null;
  /** `(ask − bid) / mid` — same definition as the journal's `entrySpreadPct`. */
  spreadPct: number | null;
  spreadBand: SpreadBand;
  openInterest: number | null;
  liquidityBand: LiquidityBand;
  entryType: EntryType;
  /** `null` on an OPEN-side row — the exit has not happened yet and must not read as `unknown`. */
  exitType: ExitType | null;
  /** `${structure}::${deltaBand}` — the cost bar's own cell key, so rows join to `byCell`. */
  cell: string;
  /** Provenance of the entry-time bands above. See {@link EntryTaxonomySource}. */
  entryTaxonomySource: EntryTaxonomySource;
}

export function buildTaxonomy(input: {
  structure: string;
  delta: number | null;
  dte: number | null;
  bid: number | null;
  ask: number | null;
  openInterest: number | null;
  entryType: EntryType;
  exitReason?: string | null;
  /** Pass `false` for an open-side row so `exitType` stays `null`. */
  hasExit: boolean;
  /** Defaults to `entry_native` — the open path, building from the live entry quote. */
  entryTaxonomySource?: EntryTaxonomySource;
}): RealFillTaxonomy {
  const { bid, ask } = input;
  const twoSided =
    typeof bid === 'number' && typeof ask === 'number'
    && Number.isFinite(bid) && Number.isFinite(ask)
    && bid > 0 && ask > 0 && ask >= bid;
  const mid = twoSided ? (bid + ask) / 2 : null;
  const spreadUsd = twoSided ? ask - bid : null;
  const spreadPct = mid !== null && mid > 0 && spreadUsd !== null ? spreadUsd / mid : null;
  const deltaBand = entryDeltaBucket(typeof input.delta === 'number' ? input.delta : Number.NaN);

  return {
    deltaBand,
    delta: typeof input.delta === 'number' && Number.isFinite(input.delta) ? input.delta : null,
    dte: typeof input.dte === 'number' && Number.isFinite(input.dte) ? input.dte : null,
    dteBand:
      typeof input.dte === 'number' && Number.isFinite(input.dte) ? entryDteBand(input.dte) : 'unknown',
    spreadUsd,
    spreadPct,
    spreadBand: spreadBandOf(spreadPct),
    openInterest:
      typeof input.openInterest === 'number' && Number.isFinite(input.openInterest)
        ? input.openInterest
        : null,
    liquidityBand: liquidityBandOf(input.openInterest),
    entryType: input.entryType,
    exitType: input.hasExit ? classifyExitType(input.exitReason) : null,
    cell: `${input.structure}::${deltaBand}`,
    entryTaxonomySource: input.entryTaxonomySource ?? 'entry_native',
  };
}

/**
 * Re-stamp an OPEN row's taxonomy for its matching CLOSE row (TRA-4893 item 1).
 *
 * The entry-time bands are carried through UNTOUCHED — that is the whole point:
 * a close row must bucket on what we entered into, not on what the contract
 * decayed to by the time we sold it. Only two things change: `exitType` becomes
 * readable, and the provenance is downgraded from `entry_native` to
 * `entry_carried` so a reader can tell a close row from the open row it was
 * derived from.
 *
 * ⚠️ `cell` is deliberately NOT recomputed. It is `${structure}::${deltaBand}`
 * over the ENTRY delta band, which is the cost bar's own cell key — recomputing
 * it at exit delta would silently move the close row into a different cell from
 * its own open row, and the two would no longer join.
 */
export function carryEntryTaxonomyToExit(
  entry: RealFillTaxonomy,
  exitReason: string | null | undefined,
): RealFillTaxonomy {
  return {
    ...entry,
    exitType: classifyExitType(exitReason),
    entryTaxonomySource: 'entry_carried',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The ledger row.
// ─────────────────────────────────────────────────────────────────────────────

export interface RealFillShadowRow {
  ts: number;
  schema: typeof REAL_FILL_SHADOW_SCHEMA;
  modelVersion: typeof REAL_FILL_MODEL_VERSION;
  mode: 'demo' | 'live';
  structure: string;
  underlying: string;
  optionSymbol: string;
  side: FillSide;

  // ── The basis, both ways. This pair IS the ticket. ────────────────────────
  /** The pre-trade NBBO mid. What `premiumPaid` books today. */
  midBasisUsd: number;
  /** The modelled resting-limit fill price under `primaryRule`. `null` when unfilled. */
  fillBasisUsd: number | null;
  /**
   * Signed COST of the fill basis against the mid basis, per share: positive
   * means the fill was worse than mid (a buy paid up / a sell sold down). Sign
   * is normalised across sides so a buy row and a sell row can be averaged.
   */
  basisDeltaUsd: number | null;
  /** `basisDeltaUsd × contractsFilled × 100`. */
  basisDeltaTotalUsd: number | null;

  // ── The fill. ─────────────────────────────────────────────────────────────
  limitUsd: number;
  primaryRule: RealFillRule;
  outcome: RealFillOutcome;
  /** All three rules' last verdict. The disagreement between them is the measurement. */
  ruleVerdicts: Record<RealFillRule, RuleVerdict>;
  contractsRequested: number;
  contractsFilled: number;
  partialFillBasis: PartialFillBasis;
  participationRate: number;
  /** Always `false` in v1 — see `REAL_FILL_UNMODELLED.queue_position`. */
  queuePositionModelled: false;
  /** `false` ⇒ the print rules on this row are `ungraded`; exclude it, do not count it as unfilled. */
  printTapeReadable: boolean;
  /**
   * WHICH print tell was readable (TRA-4893 item 4). `{clock:false,volume:true}`
   * on every row means the `trade_date` projection is not reaching this path and
   * the second detector is inert — a state that is otherwise invisible, because
   * a detector that never fires and a detector that fires and agrees both leave
   * `nUngraded` looking exactly the same.
   */
  printTells: PrintTellCoverage;
  timeToFirstFillMs: number | null;
  restedMs: number;
  polls: number;

  taxonomy: RealFillTaxonomy;
}

/**
 * Close out a resting order into a durable row.
 *
 * `outcome` precedence — `ungraded` DOMINATES. A row whose primary rule could
 * never be graded is not an `unfilled` row: reporting it as unfilled would
 * charge the lever for a tape we could not read.
 */
export function finalizeRestingOrder(
  state: RestingOrderState,
  meta: {
    mode: 'demo' | 'live';
    structure: string;
    underlying: string;
    taxonomy: RealFillTaxonomy;
  },
  nowTs: number,
): RealFillShadowRow {
  const filled = state.contractsFilled;
  const primaryVerdict = state.ruleVerdicts[state.config.primaryRule];

  let outcome: RealFillOutcome;
  if (filled >= state.contractsRequested && filled > 0) outcome = 'filled';
  else if (filled > 0) outcome = 'partial';
  else if (primaryVerdict === 'ungraded' && !state.printTapeReadable) outcome = 'ungraded';
  else outcome = 'unfilled';

  const fillBasisUsd = filled > 0 ? state.filledNotionalUsd / filled : null;
  const basisDeltaUsd =
    fillBasisUsd === null
      ? null
      : state.side === 'buy'
        ? fillBasisUsd - state.decisionMid
        : state.decisionMid - fillBasisUsd;

  return {
    ts: nowTs,
    schema: REAL_FILL_SHADOW_SCHEMA,
    modelVersion: REAL_FILL_MODEL_VERSION,
    mode: meta.mode,
    structure: meta.structure,
    underlying: meta.underlying,
    optionSymbol: state.optionSymbol,
    side: state.side,
    midBasisUsd: state.decisionMid,
    fillBasisUsd,
    basisDeltaUsd,
    basisDeltaTotalUsd: basisDeltaUsd === null ? null : basisDeltaUsd * filled * 100,
    limitUsd: state.limitUsd,
    primaryRule: state.config.primaryRule,
    outcome,
    ruleVerdicts: { ...state.ruleVerdicts },
    contractsRequested: state.contractsRequested,
    contractsFilled: filled,
    partialFillBasis: state.partialFillBasis,
    participationRate: state.config.participationRate,
    queuePositionModelled: false,
    printTapeReadable: state.printTapeReadable,
    printTells: { ...state.printTells },
    timeToFirstFillMs: state.firstFillAt === null ? null : state.firstFillAt - state.placedAt,
    restedMs: nowTs - state.placedAt,
    polls: state.polls,
    taxonomy: meta.taxonomy,
  };
}

/**
 * ⚠️ `ruleVerdicts[primaryRule] === 'fill'` with `outcome: 'unfilled'` is a
 * LEGITIMATE row, not a contradiction: the rule said the market traded through
 * our limit, and the modelled participation share of the printed volume rounded
 * to zero contracts. That is a participation-limited non-fill, and it is the
 * conservative direction. Read {@link RealFillShadowRow.partialFillBasis} —
 * on `volume_participation` rows this is expected on thin prints; on
 * `all_or_none_unmodelled` rows it cannot occur by construction.
 */
export const REAL_FILL_PARTICIPATION_STARVED_NOTE =
  'ruleVerdicts[primaryRule]=fill with outcome=unfilled means participation-limited: '
  + 'the print was real and our modelled share of it rounded to zero contracts.';

// ─────────────────────────────────────────────────────────────────────────────
// Durable ledger — append-only JSONL, mirrors option-maker-shadow.ts.
// ─────────────────────────────────────────────────────────────────────────────

function defaultStoreFile(): string {
  return join(resolveDataDir(), 'option-real-fill-shadow.jsonl');
}

let storeFileOverride: string | null = null;
/** Test seam — point the ledger at a temp file. Pass `null` to restore default. */
export function setOptionRealFillShadowFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
}
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

let cache: RealFillShadowRow[] | null = null;

async function ensureLoaded(): Promise<RealFillShadowRow[]> {
  if (cache) return cache;
  const rows: RealFillShadowRow[] = [];
  const path = storeFile();
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, 'utf-8');
      for (const rawLine of raw.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        try {
          rows.push(JSON.parse(trimmed) as RealFillShadowRow);
        } catch {
          // Skip a single corrupt line rather than losing the ledger.
        }
      }
    } catch (err) {
      log.error('failed to read real-fill shadow ledger, starting empty', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  cache = rows;
  return cache;
}

/** Eagerly load the ledger so reads have data right after boot. */
export async function initOptionRealFillShadowLedger(): Promise<void> {
  await ensureLoaded();
}

/**
 * Record one terminal row. No-op (`false`) when the measurement is off.
 *
 * `enabled` is THREADED IN rather than read from `process.env` here, for the
 * same reason `option-maker-shadow.recordShadowChase` threads it: the flag can
 * be armed from `demo-flags.json`, which the engine resolves and `process.env`
 * does not — a ledger that re-checked the environment would look armed and
 * write nothing.
 */
export async function recordRealFillShadowRow(
  row: RealFillShadowRow,
  enabled = isOptionRealFillShadowEnabled(),
): Promise<boolean> {
  if (!enabled) return false;
  if (!Number.isFinite(row.midBasisUsd) || !(row.midBasisUsd > 0)) return false;
  const rows = await ensureLoaded();
  rows.push(row);
  const path = storeFile();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await appendFile(path, `${JSON.stringify(row)}\n`, 'utf-8');
  return true;
}

export interface RealFillShadowFilter {
  mode?: 'demo' | 'live';
  side?: FillSide;
  structure?: string;
  sinceTs?: number;
}

export async function listRealFillShadowRows(
  filter: RealFillShadowFilter = {},
): Promise<RealFillShadowRow[]> {
  const rows = await ensureLoaded();
  return rows.filter(
    (r) =>
      (filter.mode === undefined || r.mode === filter.mode)
      && (filter.side === undefined || r.side === filter.side)
      && (filter.structure === undefined || r.structure === filter.structure)
      && (filter.sinceTs === undefined || r.ts >= filter.sinceTs),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Rollup — what TRA-4885 child A counts.
// ─────────────────────────────────────────────────────────────────────────────

export interface RealFillCohort {
  key: string;
  /** Rows in the cohort, INCLUDING ungraded ones. */
  n: number;
  /** Rows whose primary rule could be graded. Every rate below is over THIS. */
  nGraded: number;
  nUngraded: number;
  filled: number;
  partial: number;
  unfilled: number;
  /** `(filled + partial) / nGraded`, or `null` when `nGraded === 0`. */
  fillRate: number | null;
  /** Mean signed cost of fill-basis vs mid-basis, per share, over FILLED+PARTIAL rows. */
  meanBasisDeltaUsd: number | null;
  /** The same as a fraction of the mid — the unit the cost bar speaks. */
  meanBasisDeltaPctOfMid: number | null;
  /** Total dollars the mid basis under-books across this cohort. */
  totalBasisDeltaUsd: number;
}

export interface RealFillRuleDisagreement {
  /** Polls where the permissive rule said fill and the conservative one did not. */
  touchFilledPrintDidNot: number;
  /** The reverse — a print through our limit with no touch at it. */
  printFilledTouchDidNot: number;
  agreed: number;
  /** Rows where at least one of the two could not be graded. */
  ungradedEither: number;
}

export interface RealFillShadowSummary {
  schema: typeof REAL_FILL_SHADOW_SCHEMA;
  modelVersion: typeof REAL_FILL_MODEL_VERSION;
  generatedAt: number;
  rows: number;
  /**
   * ⚠️ Ships WITH the numbers, by design. A promotion gate reading this summary
   * must be able to see what the measurement cannot see without opening the
   * source. See {@link REAL_FILL_UNMODELLED}.
   */
  unmodelled: readonly UnmodelledDimension[];
  overall: RealFillCohort;
  byDeltaBand: RealFillCohort[];
  byDteBand: RealFillCohort[];
  bySpreadBand: RealFillCohort[];
  byLiquidityBand: RealFillCohort[];
  byEntryType: RealFillCohort[];
  byExitType: RealFillCohort[];
  byCell: RealFillCohort[];
  ruleDisagreement: RealFillRuleDisagreement;
  /**
   * Rows stamped `all_or_none_unmodelled`. Their sizes are not modelled, so a
   * dollar total that pools them is over a mixed population — published as a
   * count so the pooling is a choice rather than an accident.
   */
  rowsWithUnmodelledPartials: number;
  /**
   * TRA-4893 item 4 — per-tell readability across the whole population. Read
   * `clockOnly + both` before crediting the `trade_date` detector with anything:
   * if it is 0 while `volumeOnly` is the entire population, the second detector
   * is wired but inert and `nUngraded` is still resting on one tell.
   */
  printTellCoverage: {
    rows: number;
    clockReadable: number;
    volumeReadable: number;
    both: number;
    clockOnly: number;
    volumeOnly: number;
    neither: number;
  };
  /**
   * TRA-4893 item 1 — how many rows hold entry-time bands by each route. See
   * {@link EntryTaxonomySource}. `entry_rederived` rows have a structurally
   * `unknown` `liquidityBand` (open interest is not persisted on the position),
   * so `byLiquidityBand` must be partitioned on this before it is read.
   */
  byEntryTaxonomySource: Record<EntryTaxonomySource, number>;
  /**
   * Rows by side. TRA-4888 shipped OPEN-side call sites only, so a
   * `sell` count of 0 meant "the close side is not wired", NOT "no exits
   * happened" — published explicitly so that state can never again be read as
   * an empty cohort.
   */
  bySide: Record<FillSide, number>;
}

function foldCohort(key: string, rows: readonly RealFillShadowRow[]): RealFillCohort {
  const graded = rows.filter((r) => r.outcome !== 'ungraded');
  const filled = graded.filter((r) => r.outcome === 'filled').length;
  const partial = graded.filter((r) => r.outcome === 'partial').length;
  const unfilled = graded.filter((r) => r.outcome === 'unfilled').length;
  const withBasis = rows.filter(
    (r) => typeof r.basisDeltaUsd === 'number' && Number.isFinite(r.basisDeltaUsd),
  );
  const meanBasisDeltaUsd =
    withBasis.length === 0
      ? null
      : withBasis.reduce((a, r) => a + (r.basisDeltaUsd as number), 0) / withBasis.length;
  const pcts = withBasis
    .filter((r) => r.midBasisUsd > 0)
    .map((r) => (r.basisDeltaUsd as number) / r.midBasisUsd);
  return {
    key,
    n: rows.length,
    nGraded: graded.length,
    nUngraded: rows.length - graded.length,
    filled,
    partial,
    unfilled,
    fillRate: graded.length === 0 ? null : (filled + partial) / graded.length,
    meanBasisDeltaUsd,
    meanBasisDeltaPctOfMid: pcts.length === 0 ? null : pcts.reduce((a, b) => a + b, 0) / pcts.length,
    totalBasisDeltaUsd: rows.reduce((a, r) => a + (r.basisDeltaTotalUsd ?? 0), 0),
  };
}

function groupBy(
  rows: readonly RealFillShadowRow[],
  keyOf: (r: RealFillShadowRow) => string,
): RealFillCohort[] {
  const map = new Map<string, RealFillShadowRow[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const list = map.get(k);
    if (list) list.push(r);
    else map.set(k, [r]);
  }
  return [...map.entries()]
    .map(([k, list]) => foldCohort(k, list))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function summarizeRealFillShadow(
  rows: readonly RealFillShadowRow[],
  generatedAt = Date.now(),
): RealFillShadowSummary {
  const disagreement: RealFillRuleDisagreement = {
    touchFilledPrintDidNot: 0,
    printFilledTouchDidNot: 0,
    agreed: 0,
    ungradedEither: 0,
  };
  for (const r of rows) {
    const touch = r.ruleVerdicts.touch_cross;
    const through = r.ruleVerdicts.print_through_limit;
    if (touch === 'ungraded' || through === 'ungraded') disagreement.ungradedEither += 1;
    else if (touch === through) disagreement.agreed += 1;
    else if (touch === 'fill') disagreement.touchFilledPrintDidNot += 1;
    else disagreement.printFilledTouchDidNot += 1;
  }

  const tellCoverage = {
    rows: rows.length,
    clockReadable: 0,
    volumeReadable: 0,
    both: 0,
    clockOnly: 0,
    volumeOnly: 0,
    neither: 0,
  };
  for (const r of rows) {
    // A row written before TRA-4893 has no `printTells`. That is an ABSENT
    // field, not two `false`s — defaulting it to `{false,false}` would silently
    // deepen `neither` with rows that simply predate the column. It is counted
    // as `neither` only because `neither` here means "no tell is recorded for
    // this row", which is true either way; the discriminator for the old rows is
    // `schema`/`modelVersion`, which they carry.
    const tells = r.printTells;
    const clock = tells?.clock === true;
    const volume = tells?.volume === true;
    if (clock) tellCoverage.clockReadable += 1;
    if (volume) tellCoverage.volumeReadable += 1;
    if (clock && volume) tellCoverage.both += 1;
    else if (clock) tellCoverage.clockOnly += 1;
    else if (volume) tellCoverage.volumeOnly += 1;
    else tellCoverage.neither += 1;
  }

  const taxonomySource: Record<EntryTaxonomySource, number> = {
    entry_native: 0,
    entry_carried: 0,
    entry_rederived: 0,
  };
  const bySide: Record<FillSide, number> = { buy: 0, sell: 0 };
  for (const r of rows) {
    const src = r.taxonomy?.entryTaxonomySource;
    if (src === 'entry_carried' || src === 'entry_rederived' || src === 'entry_native') {
      taxonomySource[src] += 1;
    } else {
      // Pre-TRA-4893 rows carry no provenance. They are all open-side by
      // construction (no close call site existed), so `entry_native` is their
      // true provenance rather than a guess.
      taxonomySource.entry_native += 1;
    }
    if (r.side === 'buy' || r.side === 'sell') bySide[r.side] += 1;
  }

  return {
    schema: REAL_FILL_SHADOW_SCHEMA,
    modelVersion: REAL_FILL_MODEL_VERSION,
    generatedAt,
    rows: rows.length,
    unmodelled: REAL_FILL_UNMODELLED,
    overall: foldCohort('overall', rows),
    byDeltaBand: groupBy(rows, (r) => r.taxonomy.deltaBand),
    byDteBand: groupBy(rows, (r) => r.taxonomy.dteBand),
    bySpreadBand: groupBy(rows, (r) => r.taxonomy.spreadBand),
    byLiquidityBand: groupBy(rows, (r) => r.taxonomy.liquidityBand),
    byEntryType: groupBy(rows, (r) => r.taxonomy.entryType),
    byExitType: groupBy(rows, (r) => r.taxonomy.exitType ?? 'open_side'),
    byCell: groupBy(rows, (r) => r.taxonomy.cell),
    ruleDisagreement: disagreement,
    rowsWithUnmodelledPartials: rows.filter((r) => r.partialFillBasis === 'all_or_none_unmodelled')
      .length,
    printTellCoverage: tellCoverage,
    byEntryTaxonomySource: taxonomySource,
    bySide,
  };
}
