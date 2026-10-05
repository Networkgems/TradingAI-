import type { Candle } from '@trading-app/shared';
import {
  emaPullbackTrigger,
  volumeConfirmedBreakout,
  type EmaPullbackResult,
  type SwingSide,
  type VolumeBreakoutResult,
} from '@trading-app/engine';
import { logger } from './observability/index.js';

// TRA-4413 "flags evaluation" (parent TRA-4412) — THE COUNTERFACTUAL FOR THE
// TWO SHIPPED-BUT-OFF UNDERLYING-CONFIRMATION FLAGS.
//
// The ticket's first queue item reads "evaluating the flags costs a flag, not a
// build". It does not, and the reason is worth writing down because it is the
// same shape three tickets in this family already hit:
//
//   `ENABLE_OPTION_EMA_PULLBACK` and `ENABLE_OPTION_VOLUME_BREAKOUT` are not
//   observers. Both are RESTRICTIONS wired directly into the decision: the
//   first `continue`s the symbol on `ema_pullback_not_fired`, the second
//   SUBSTITUTES a stricter breakout predicate for the volume-blind one. Arming
//   either changes what trades in the same tick it changes what is measured,
//   and neither publishes the one number the decision needs — how much of the
//   live population it would have refused. A restriction graded by watching
//   `opensPlaced` fall cannot be told from a restriction that is simply wrong
//   (the TRA-4424 finding, in a different costume).
//
// So the flags get a SHADOW first, and it is this module: the identical engine
// predicates, run on the identical inputs, at the identical seams, recording a
// low-cardinality code per evaluation and refusing to route anything. Nothing
// here can open, size, close, or suppress an order in either book: every entry
// point returns `void`, reads no order state, and is called for its counters.
//
// ⚠️ THE DENOMINATOR IS THE DELIVERABLE, NOT THE FINDING. Each arm publishes
// `evaluated` first and splits the refusals from the BLIND reads, because an
// empty feed and a blind instrument are the same bytes on every counter that
// only counts firings. `blind_*` / `insufficient_*` are not "did not confirm" —
// they are "was never asked", and folding them together is how a gate proposal
// gets argued from a number that was never about the gate.
//
// ⚠️ TIMEFRAME IS PER-ARM AND IT IS NOT COSMETIC (TRA-4424). The RV arms read
// the 5-minute `shadowCandleCache` because that is what their real call sites
// read — a shadow on a different series would be measuring a gate we do not
// have. The OTM arm reads the DAILY series, for the same reason in reverse: the
// OTM nomination seam was moved to daily bars precisely because a multi-day
// thesis read off six sessions of intraday bars produces confident verdicts
// about a different question. The arm name carries the timeframe so no reader
// has to remember which is which.

const log = logger.child({ module: 'underlying-confirmation-shadow' });

/**
 * Sub-flag, default OFF, and deliberately INDEPENDENT of `ENABLE_OPTION_EXEC`
 * (which both graded flags require). The point of this instrument is to price
 * the flags BEFORE the exec path is armed; making it inherit the gate's own
 * precondition would leave it dark in exactly the state it exists to inform.
 */
export const UNDERLYING_CONFIRMATION_SHADOW_FLAG = 'ENABLE_UNDERLYING_CONFIRMATION_SHADOW';

export function isUnderlyingConfirmationShadowEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[UNDERLYING_CONFIRMATION_SHADOW_FLAG];
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * The seams this instrument is wired at. An arm is a (call site × predicate ×
 * timeframe) triple, never just a predicate: the same `emaPullbackTrigger` run
 * on 5-minute RV candidates and on daily OTM nominees answers two different
 * questions, and pooling them would produce a number that describes neither.
 */
export type ConfirmationArm = 'rv_long_5m' | 'high_ivr_breakout_5m' | 'otm_nominee_daily';

export const CONFIRMATION_ARMS: readonly ConfirmationArm[] = [
  'rv_long_5m',
  'high_ivr_breakout_5m',
  'otm_nominee_daily',
] as const;

/**
 * EMA-pullback outcome codes. Low cardinality by construction — derived from
 * the result's STRUCTURED legs, never from its `reason` string, which is prose
 * written for a log line and would put an unbounded key space on a counter.
 */
export type EmaPullbackCode =
  | 'confirmed'
  | 'blind_no_series'
  | 'blind_no_side'
  | 'insufficient_bars'
  | 'trend_not_aligned'
  | 'no_pullback'
  | 'no_reversal_candle';

/** Volume-breakout outcome codes. Same discipline as above. */
export type VolumeBreakoutCode =
  | 'confirmed'
  | 'blind_no_series'
  | 'blind_no_side'
  | 'insufficient_bars'
  | 'insufficient_volume_history'
  | 'no_breakout'
  | 'volume_unconfirmed';

/** Codes that mean "the predicate was never actually asked". */
const EMA_BLIND_CODES: ReadonlySet<EmaPullbackCode> = new Set([
  'blind_no_series',
  'blind_no_side',
  'insufficient_bars',
]);

const VOLUME_BLIND_CODES: ReadonlySet<VolumeBreakoutCode> = new Set([
  'blind_no_series',
  'blind_no_side',
  'insufficient_bars',
  'insufficient_volume_history',
]);

/**
 * Map an {@link EmaPullbackResult} onto its countable code.
 *
 * ⛔ `insufficient_bars` folds BOTH of the engine's blind exits — the short
 * series and the non-finite EMA — because both leave `ema9`/`ema21` null and
 * both mean the same thing to a reader deciding whether to arm the gate: this
 * evaluation carried no information. The engine's prose `reason` still tells
 * them apart in the log; it is just not a counter key.
 */
export function classifyEmaPullback(result: EmaPullbackResult): EmaPullbackCode {
  if (result.fired) return 'confirmed';
  if (result.ema9 == null || result.ema21 == null) return 'insufficient_bars';
  if (!result.trendOk) return 'trend_not_aligned';
  if (!result.pulledBack) return 'no_pullback';
  return 'no_reversal_candle';
}

/**
 * Map a {@link VolumeBreakoutResult} onto its countable code.
 *
 * ⛔ `insufficient_volume_history` is NOT `volume_unconfirmed`, and the split is
 * the whole reason this classifier exists. The engine returns a bare
 * `fired:false` when the series is too short to build the average-volume
 * benchmark — a breakout it could not grade — and the below-average case, which
 * it DID grade, looks identical on `fired`. They are told apart by `avgVolume`:
 * null means the benchmark was never computed. Pooling them would count an
 * unreadable feed as evidence that the volume filter is selective.
 */
export function classifyVolumeBreakout(result: VolumeBreakoutResult): VolumeBreakoutCode {
  if (result.fired) return 'confirmed';
  if (result.channel == null) return 'insufficient_bars';
  if (!result.breakout) return 'no_breakout';
  if (result.avgVolume == null) return 'insufficient_volume_history';
  return 'volume_unconfirmed';
}

/** Bounded per-arm sample so the health surface shows WHAT was graded, not only counts. */
const MAX_RECENT_PER_ARM = 12;

interface RecentSample {
  symbol: string;
  side: SwingSide;
  code: string;
  at: number;
  bars: number;
}

interface ArmState {
  /** Every call, including the blind ones. The denominator, published first. */
  evaluated: number;
  byCode: Record<string, number>;
  confirmed: number;
  /** Evaluations that carried no information (see the `*_BLIND_CODES` sets). */
  blind: number;
  /**
   * What the ARMED gate would have refused = `evaluated - confirmed`.
   *
   * ⛔ Blind reads are INSIDE this number on purpose: the live
   * `ENABLE_OPTION_EMA_PULLBACK` path rejects `ema_pullback_no_series` exactly
   * as it rejects `ema_pullback_not_fired`. A `wouldSuppress` that quietly
   * excused the unreadable cases would understate the armed gate and is not the
   * counterfactual anyone is asking for. `blind` is published beside it so the
   * split is one subtraction away.
   */
  wouldSuppress: number;
  lastAt: number | null;
  recent: RecentSample[];
}

interface VolumeControlState {
  /** The volume-BLIND Donchian predicate the live path uses today. */
  bareFired: number;
  /** The volume-CONFIRMED predicate the flag would substitute. */
  confirmedFired: number;
  /** Bare fired, confirmed did not — the flag's actual suppression set. */
  wouldSuppress: number;
  /**
   * NEGATIVE CONTROL, expected 0 forever.
   *
   * Volume confirmation is strictly additive on top of the same Donchian
   * channel (same period, same `excludeCurrent`), so `confirmed ⇒ bare` is an
   * identity, not a hope. A non-zero here means the two predicates stopped
   * reading the same channel — a parameter drifted, or a call site passed a
   * different series — and every suppression number above it is void. It is
   * published either way: a control that fires silently is no control.
   */
  confirmedNotBare: number;
  lastControlViolationAt: number | null;
}

interface ShadowState {
  arms: Record<ConfirmationArm, ArmState>;
  volumeControl: VolumeControlState;
  /** Unexpected throws out of a record call (this module never rethrows). */
  errors: number;
}

function freshArm(): ArmState {
  return {
    evaluated: 0,
    byCode: {},
    confirmed: 0,
    blind: 0,
    wouldSuppress: 0,
    lastAt: null,
    recent: [],
  };
}

function freshState(): ShadowState {
  return {
    arms: {
      rv_long_5m: freshArm(),
      high_ivr_breakout_5m: freshArm(),
      otm_nominee_daily: freshArm(),
    },
    volumeControl: {
      bareFired: 0,
      confirmedFired: 0,
      wouldSuppress: 0,
      confirmedNotBare: 0,
      lastControlViolationAt: null,
    },
    errors: 0,
  };
}

let state = freshState();

/** Test seam. */
export function __resetUnderlyingConfirmationShadow(): void {
  state = freshState();
}

function note(
  arm: ConfirmationArm,
  symbol: string,
  side: SwingSide,
  code: string,
  blind: boolean,
  bars: number,
  now: number,
): void {
  const a = state.arms[arm];
  a.evaluated += 1;
  a.byCode[code] = (a.byCode[code] ?? 0) + 1;
  if (code === 'confirmed') a.confirmed += 1;
  else a.wouldSuppress += 1;
  if (blind) a.blind += 1;
  a.lastAt = now;
  a.recent.push({ symbol, side, code, at: now, bars });
  if (a.recent.length > MAX_RECENT_PER_ARM) {
    a.recent.splice(0, a.recent.length - MAX_RECENT_PER_ARM);
  }
}

export interface EmaPullbackShadowArgs {
  arm: ConfirmationArm;
  symbol: string;
  /** The SAME series the real call site reads — never a re-fetch. */
  series: Candle[] | null | undefined;
  /** The side the nomination would take. `null` is itself a countable outcome. */
  side: SwingSide | null;
  env?: NodeJS.ProcessEnv;
  now?: number;
}

/**
 * Record one EMA-pullback counterfactual. Flag-gated, never throws, returns
 * nothing: the caller's decision must be byte-identical whether this ran or not.
 */
export function recordEmaPullbackShadow(args: EmaPullbackShadowArgs): void {
  try {
    if (!isUnderlyingConfirmationShadowEnabled(args.env)) return;
    const now = args.now ?? Date.now();
    const symbol = args.symbol.trim().toUpperCase();
    const bars = args.series?.length ?? 0;
    if (args.side == null) {
      note(args.arm, symbol, 'call', 'blind_no_side', true, bars, now);
      return;
    }
    if (!args.series || args.series.length === 0) {
      note(args.arm, symbol, args.side, 'blind_no_series', true, 0, now);
      return;
    }
    const result = emaPullbackTrigger(args.series, args.side);
    const code = classifyEmaPullback(result);
    note(args.arm, symbol, args.side, code, EMA_BLIND_CODES.has(code), bars, now);
  } catch (err) {
    state.errors += 1;
    log.warn('EMA-pullback shadow evaluation failed', {
      arm: args.arm,
      symbol: args.symbol,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface VolumeBreakoutShadowArgs {
  arm: ConfirmationArm;
  symbol: string;
  series: Candle[] | null | undefined;
  side: SwingSide | null;
  /**
   * What the live, volume-blind Donchian predicate said on this same tick —
   * passed IN rather than recomputed here, so the control compares the shadow
   * against the value the decision actually used.
   */
  bareBreakout: boolean;
  env?: NodeJS.ProcessEnv;
  now?: number;
}

/** Record one volume-confirmed-breakout counterfactual plus its negative control. */
export function recordVolumeBreakoutShadow(args: VolumeBreakoutShadowArgs): void {
  try {
    if (!isUnderlyingConfirmationShadowEnabled(args.env)) return;
    const now = args.now ?? Date.now();
    const symbol = args.symbol.trim().toUpperCase();
    const bars = args.series?.length ?? 0;
    const control = state.volumeControl;
    if (args.bareBreakout) control.bareFired += 1;

    if (args.side == null) {
      note(args.arm, symbol, 'call', 'blind_no_side', true, bars, now);
      if (args.bareBreakout) control.wouldSuppress += 1;
      return;
    }
    if (!args.series || args.series.length === 0) {
      note(args.arm, symbol, args.side, 'blind_no_series', true, 0, now);
      if (args.bareBreakout) control.wouldSuppress += 1;
      return;
    }

    const result = volumeConfirmedBreakout(args.series, args.side);
    const code = classifyVolumeBreakout(result);
    note(args.arm, symbol, args.side, code, VOLUME_BLIND_CODES.has(code), bars, now);

    if (result.fired) {
      control.confirmedFired += 1;
      if (!args.bareBreakout) {
        control.confirmedNotBare += 1;
        control.lastControlViolationAt = now;
        log.warn('volume-breakout shadow NEGATIVE CONTROL violated — confirmed fired without bare', {
          symbol,
          side: args.side,
          bars,
        });
      }
    } else if (args.bareBreakout) {
      control.wouldSuppress += 1;
    }
  } catch (err) {
    state.errors += 1;
    log.warn('volume-breakout shadow evaluation failed', {
      arm: args.arm,
      symbol: args.symbol,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function summarizeArm(a: ArmState) {
  return {
    evaluated: a.evaluated,
    confirmed: a.confirmed,
    wouldSuppress: a.wouldSuppress,
    blind: a.blind,
    /**
     * `null` on a zero denominator, never 0. A rate of 0 out of 0 reads as
     * "the gate refused nothing" when the truth is "the gate was never asked".
     */
    confirmRate: a.evaluated > 0 ? a.confirmed / a.evaluated : null,
    /** Confirm rate over the reads that actually carried information. */
    confirmRateExBlind:
      a.evaluated - a.blind > 0 ? a.confirmed / (a.evaluated - a.blind) : null,
    byCode: { ...a.byCode },
    lastAt: a.lastAt == null ? null : new Date(a.lastAt).toISOString(),
    recent: a.recent.map((r) => ({ ...r, at: new Date(r.at).toISOString() })),
  };
}

/** The health-route read surface (`/api/health/underlying-confirmation-shadow`). */
export function summarizeUnderlyingConfirmationShadow(env: NodeJS.ProcessEnv = process.env) {
  const control = state.volumeControl;
  return {
    flag: UNDERLYING_CONFIRMATION_SHADOW_FLAG,
    enabled: isUnderlyingConfirmationShadowEnabled(env),
    /**
     * The flags this instrument is pricing, and their live state. Published
     * here so a reader never has to join two routes to answer "is the thing
     * being measured already on?" — if either reads true, the counters below
     * are describing a gate that is no longer a counterfactual.
     */
    gradedFlags: {
      emaPullback: 'ENABLE_OPTION_EMA_PULLBACK',
      volumeBreakout: 'ENABLE_OPTION_VOLUME_BREAKOUT',
    },
    errors: state.errors,
    arms: {
      rv_long_5m: summarizeArm(state.arms.rv_long_5m),
      high_ivr_breakout_5m: summarizeArm(state.arms.high_ivr_breakout_5m),
      otm_nominee_daily: summarizeArm(state.arms.otm_nominee_daily),
    },
    volumeControl: {
      ...control,
      lastControlViolationAt:
        control.lastControlViolationAt == null
          ? null
          : new Date(control.lastControlViolationAt).toISOString(),
      controlHeld: control.confirmedNotBare === 0,
    },
  };
}
