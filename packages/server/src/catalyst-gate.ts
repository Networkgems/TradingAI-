// TRA-1972 (D1 of TRA-1968) — Equity earnings-proximity gate, SHADOW-first.
//
// A PURE, point-in-time event-proximity evaluator for the live equity entry
// paths. It turns the already-plumbed earnings / macro calendars (which today
// only decorate option cards as badges) into a *gate decision* for new equity
// entries — but in D1 the decision is OBSERVE-ONLY: the signal-engine computes
// it, stamps + logs it, and surfaces it on engine state, and NEVER suppresses
// the open. Live suppression waits on the D2 out-of-sample grade + QuantTrader
// Stage-3 sign-off (see TRA-1968), flipped via `ENABLE_CATALYST_EARNINGS_GATE=1`.
//
// The evaluator is deliberately self-contained and side-effect-free so it can be
// unit-tested point-in-time via `asOf` + injectable calendar readers. All I/O
// (the warmed earnings/macro caches) is injected, not imported at the call site,
// so a test needs no store warm-up.

import { earningsInDaysSync } from './earnings-store.js';
import { daysToNextFOMCSync, eventsNearDateSync } from './macro-store.js';
import type { MacroEvent } from '@trading-app/engine';
import type { SignalType } from '@trading-app/shared';

/** Flag: 0/off ⇒ shadow-log-only (D1 default); 1 ⇒ enforce (post D2 sign-off). */
export const CATALYST_EARNINGS_GATE_FLAG = 'ENABLE_CATALYST_EARNINGS_GATE';
/** Optional off-by-default macro mean-reversion suppression rule. */
export const CATALYST_MACRO_MEANREV_FLAG = 'ENABLE_CATALYST_MACRO_MEANREV_SUPPRESS';
export const CATALYST_SWING_MAX_DAYS_FLAG = 'CATALYST_EARNINGS_SWING_MAX_DAYS';
export const CATALYST_INTRADAY_MAX_DAYS_FLAG = 'CATALYST_EARNINGS_INTRADAY_MAX_DAYS';

/** Default earnings-proximity thresholds (calendar days), per the TRA-1968 plan. */
export const DEFAULT_SWING_MAX_DAYS = 10;
export const DEFAULT_INTRADAY_MAX_DAYS = 1;

/**
 * Strategies whose entry the earnings gate targets. The daily swing router
 * (`sma200_pullback`) uses the wider swing threshold; the intraday routers
 * (ORB / BB-fade / Ichimoku) use the tight 1-day threshold.
 */
const SWING_STRATEGIES: ReadonlySet<SignalType> = new Set(['sma200_pullback']);
const INTRADAY_STRATEGIES: ReadonlySet<SignalType> = new Set([
  'orb_breakout',
  'bb_fade',
  'ichimoku',
]);
/**
 * Mean-reversion entries the OPTIONAL macro rule suppresses near a high-impact
 * macro print (a mean-reverting entry into an FOMC/CPI/NFP gap is the exact
 * trade the rule is meant to stand aside from). Trend/breakout entries (ORB,
 * Ichimoku) are unaffected by the macro rule.
 */
const MEANREV_STRATEGIES: ReadonlySet<SignalType> = new Set(['bb_fade', 'sma200_pullback']);

export type CatalystGateRule =
  | 'earnings_swing'
  | 'earnings_intraday'
  | 'macro_meanrev';

export interface CatalystGateConfig {
  /** `ENABLE_CATALYST_EARNINGS_GATE=1` ⇒ the operator intends live enforcement. */
  enforce: boolean;
  /** `ENABLE_CATALYST_MACRO_MEANREV_SUPPRESS=1` ⇒ arm the optional macro rule. */
  macroMeanRev: boolean;
  swingMaxDays: number;
  intradayMaxDays: number;
}

export interface CatalystGateDecision {
  symbol: string;
  strategy: SignalType;
  /** True when at least one rule would block this NEW entry. */
  gated: boolean;
  /** Which rule fired first (earnings before macro), or `null` when clear. */
  rule: CatalystGateRule | null;
  /** Human-readable reason, `signalSkipReason`-style. `null` when clear. */
  reason: string | null;
  /** Calendar days to next earnings, or `null` when uncovered/unknown. */
  earningsInDays: number | null;
  /** The earnings threshold applied for this strategy's cadence. */
  thresholdDays: number;
  /** Days to next FOMC at `asOf` (surfaced for the macro rule; may be `null`). */
  daysToFomc: number | null;
  /**
   * Whether the operator has armed live enforcement (`enforce`). In D1 this is
   * carried for observability only — the engine never routes on it.
   */
  enforce: boolean;
  asOf: number;
}

const TRUE_TOKENS = ['1', 'true', 'yes', 'on'];

function envFlag(env: NodeJS.ProcessEnv, key: string): boolean {
  const raw = env[key];
  if (typeof raw !== 'string') return false;
  return TRUE_TOKENS.includes(raw.trim().toLowerCase());
}

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Resolve the gate configuration from the environment (defaults observe/off). */
export function resolveCatalystGateConfig(env: NodeJS.ProcessEnv = process.env): CatalystGateConfig {
  return {
    enforce: envFlag(env, CATALYST_EARNINGS_GATE_FLAG),
    macroMeanRev: envFlag(env, CATALYST_MACRO_MEANREV_FLAG),
    swingMaxDays: envInt(env, CATALYST_SWING_MAX_DAYS_FLAG, DEFAULT_SWING_MAX_DAYS),
    intradayMaxDays: envInt(env, CATALYST_INTRADAY_MAX_DAYS_FLAG, DEFAULT_INTRADAY_MAX_DAYS),
  };
}

/** True when the earnings gate targets `strategy` at all (else the gate is inert). */
export function isCatalystGateTarget(strategy: SignalType): boolean {
  return SWING_STRATEGIES.has(strategy) || INTRADAY_STRATEGIES.has(strategy);
}

/** Injectable calendar readers so the predicate is testable without store warm-up. */
export interface CatalystGateReaders {
  earningsInDays: (symbol: string, asOf: number) => number | null;
  daysToNextFOMC: (asOf: number) => number | null;
  eventsNearDate: (dateIso: string, windowDays: number) => MacroEvent[];
}

const DEFAULT_READERS: CatalystGateReaders = {
  earningsInDays: earningsInDaysSync,
  daysToNextFOMC: daysToNextFOMCSync,
  eventsNearDate: eventsNearDateSync,
};

function isoDay(asOf: number): string {
  return new Date(asOf).toISOString().slice(0, 10);
}

/**
 * Point-in-time evaluation of the earnings-proximity (+ optional macro) gate for
 * a NEW `strategy` entry on `symbol`. Pure: no logging, no side effects, no
 * suppression. The caller (signal-engine, D1) logs + surfaces the decision but
 * still routes the open.
 *
 * Rule order — earnings first (the primary D1 rule), then the optional macro
 * mean-reversion rule. Only the FIRST firing rule is reported on `.rule` /
 * `.reason`; `.gated` is the OR of all rules.
 */
export function evaluateCatalystGate(params: {
  symbol: string;
  strategy: SignalType;
  asOf: number;
  config: CatalystGateConfig;
  readers?: Partial<CatalystGateReaders>;
}): CatalystGateDecision {
  const { symbol, strategy, asOf, config } = params;
  const readers: CatalystGateReaders = { ...DEFAULT_READERS, ...params.readers };

  const isSwing = SWING_STRATEGIES.has(strategy);
  const thresholdDays = isSwing ? config.swingMaxDays : config.intradayMaxDays;
  const earningsInDays = readers.earningsInDays(symbol, asOf);
  const daysToFomc = readers.daysToNextFOMC(asOf);

  const base = {
    symbol,
    strategy,
    earningsInDays,
    thresholdDays,
    daysToFomc,
    enforce: config.enforce,
    asOf,
  } as const;

  // Non-targeted strategies are never gated (the evaluator is a hard no-op for
  // them; callers only invoke it on targeted entry paths, but stay defensive).
  if (!isCatalystGateTarget(strategy)) {
    return { ...base, gated: false, rule: null, reason: null };
  }

  // Rule 1 (primary) — earnings within the strategy's window.
  if (earningsInDays !== null && earningsInDays <= thresholdDays) {
    const cadence = isSwing ? 'swing' : 'intraday';
    return {
      ...base,
      gated: true,
      rule: isSwing ? 'earnings_swing' : 'earnings_intraday',
      reason:
        `catalyst gate (${cadence}): ${symbol} earnings in ${earningsInDays}d ` +
        `≤ ${thresholdDays}d threshold`,
    };
  }

  // Rule 2 (optional, off by default) — macro mean-reversion suppression: stand
  // aside from a mean-reverting entry into an imminent high-impact macro print.
  if (config.macroMeanRev && MEANREV_STRATEGIES.has(strategy)) {
    const fomcImminent = daysToFomc !== null && daysToFomc <= 1;
    const highImpactNear = readers
      .eventsNearDate(isoDay(asOf), 1)
      .some((e) => e.importance === 'high');
    if (fomcImminent || highImpactNear) {
      const which = fomcImminent
        ? `FOMC in ${daysToFomc}d`
        : 'high-impact macro event within 1d';
      return {
        ...base,
        gated: true,
        rule: 'macro_meanrev',
        reason: `catalyst gate (macro mean-rev): ${symbol} ${which}`,
      };
    }
  }

  return { ...base, gated: false, rule: null, reason: null };
}
