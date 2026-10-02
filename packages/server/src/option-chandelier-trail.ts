import {
  EXIT_CHANDELIER_ATR_MULT,
  EXIT_CHANDELIER_ATR_MULT_HIGHBETA,
  EXIT_CHANDELIER_HIGHBETA_ATRPCT,
  type Candle,
} from '@trading-app/shared';
import {
  resolveOtmSleeveExitRule,
  OTM_SLEEVE_EXIT_RULE_VALUE,
  type OtmSleeveExitRuleResolution,
} from './exit-risk-rules-flag.js';

// TRA-4991 (parent TRA-4945) — the underlying-space ATR chandelier's INPUTS, as
// a publishable surface.
//
// ── What this module exists to stop ─────────────────────────────────────────
//
// TRA-4945 was asked which condition stamped `exitReason: "chandelier"` on a
// 197-second, ZERO-excursion close (MARA261030P00013000, journal row
// `6e704cf5-925c-47b7-a5b3-1904f3e48366`). It could only be answered by reading
// SOURCE BYTES against the deployed commit, because every published field about
// that close is in PREMIUM space (`peakPremium`, `entryBasisPremium`, `mae.*`,
// `stopBasisPremium`) and the chandelier fires on SPOT:
// `chandelierExitTriggered(chandelierUSide, chandelierUnderlying,
// opt.chandelierStop)`. A reader sees `peakPremium == entryBasisPremium` and
// `mae.frac == 0` and concludes "a trailing stop fired with no trail". The trail
// was real. It was in a space nothing published. That misread cost a weekly
// roll-up escalation, and `git show` is not a surface a reader can re-cut.
//
// ── The three things published here ─────────────────────────────────────────
//
//  1. {@link CHANDELIER_ATR_PERIOD} / {@link SHADOW_CANDLE_TIMEFRAME_MS} — the
//     ATR the ratchet consumes, named ONCE so the producer
//     (`SignalEngine.buildOptionExitRisk`), the per-row journal stamp and the
//     health route cannot disagree about it.
//  2. {@link measureCandleTimeframeMs} — and because a constant can still LIE
//     about the series actually in the cache, the per-row stamp carries the
//     timeframe MEASURED off the bars the ATR was computed on. A repair that
//     re-points the chandelier at a different series (TRA-4992) moves the
//     measured field whether or not anyone remembers the constant.
//  3. {@link noteChandelierRatchet} / {@link summarizeChandelierRatchets} — the
//     high-beta branch COUNTER. `EXIT_CHANDELIER_ATR_MULT_HIGHBETA` (3.5) is
//     gated on `atrPct > EXIT_CHANDELIER_HIGHBETA_ATRPCT` (0.05) where `atrPct`
//     is computed on the FIVE-MINUTE series — a daily-scale threshold applied
//     to a 5m-scale input. TRA-4945 deliberately did NOT claim that makes the
//     branch unreachable, because it never read a live `atrPct`. A flag reads
//     identically whether a branch is live or dead; a counter does not.
//
// ⛔ OBSERVE-ONLY. Nothing in this module is read by an exit decision, a level,
// or an order path. The ledger is a since-boot counter and the constants are the
// ones the engine already compiled in.

/**
 * ATR period the option chandelier's underlying trail runs on.
 *
 * This is `atr()`'s own default (14) stated EXPLICITLY at the one call site that
 * feeds the chandelier (`buildOptionExitRisk`), so the number published beside a
 * fire is the number that produced it rather than a second copy of a default
 * that could be changed in the indicator without this following.
 */
export const CHANDELIER_ATR_PERIOD = 14;

/**
 * Resample width of the shadow-candle series the chandelier's ATR is computed
 * on — the SAME series the Supertrend shadow fills
 * (`refreshSupertrendShadowSeries` → `resampleCandles(minuteBars, …)`).
 *
 * ⚠ ONE definition, aliased by `signal-engine.ts`'s `SUPERTREND_SHADOW_TF_MS`.
 * Two constants claiming to describe one series is how a published timeframe
 * goes stale silently, and the ATR timeframe is the exact quantity TRA-4992 is
 * filed to repair — it must not be possible to repair the series and leave this
 * reading 5m.
 */
export const SHADOW_CANDLE_TIMEFRAME_MS = 5 * 60_000;

/**
 * The bar spacing of a candle series, MEASURED — median of the consecutive
 * `timestamp` deltas, so one gap (a session boundary, a halt) cannot move it.
 *
 * ⛔ Returns `null`, never `0`, below two bars: "fewer than two bars, cannot
 * measure" and "zero-width bars" are different facts and a `0` here would read
 * as the second. Same discipline as this ticket's rule for a `0` ATR.
 */
export function measureCandleTimeframeMs(series: readonly Candle[] | undefined): number | null {
  if (!series || series.length < 2) return null;
  const deltas: number[] = [];
  for (let i = 1; i < series.length; i += 1) {
    const prev = series[i - 1]?.timestamp;
    const cur = series[i]?.timestamp;
    if (typeof prev !== 'number' || typeof cur !== 'number') continue;
    const d = cur - prev;
    if (Number.isFinite(d) && d > 0) deltas.push(d);
  }
  if (deltas.length === 0) return null;
  deltas.sort((a, b) => a - b);
  // Lower median: a spacing some adjacent pair actually had, never an
  // interpolation between two real ones.
  return deltas[Math.floor((deltas.length - 1) / 2)] as number;
}

/**
 * The ATR series provenance for ONE underlying, as `buildOptionExitRisk`
 * measured it. Carried on {@link import('./options-account.js').OptionExitRiskInput}
 * and folded onto the journal close row by the fire.
 */
export interface OptionChandelierAtrSource {
  /** Period handed to `atr()` / `atrPct()`. */
  period: number;
  /** MEASURED bar spacing of the series, `null` when unmeasurable. Never 0. */
  timeframeMs: number | null;
  /** Bars in the series the ATR was computed over. */
  bars: number;
}

// ── AC3 — the high-beta branch counter ───────────────────────────────────────

/** One book's ratchet tally. `maxAtrPct` is `null` until an `atrPct` is seen. */
export interface ChandelierRatchetTally {
  /** Ratchets resolved, one per row per exit pass. */
  ratchets: number;
  /** Resolved to `EXIT_CHANDELIER_ATR_MULT_HIGHBETA`. */
  highBeta: number;
  /** Resolved to `EXIT_CHANDELIER_ATR_MULT` with a MEASURED `atrPct` below the threshold. */
  base: number;
  /**
   * Resolved to the base multiplier because `atrPct` was ABSENT — the series
   * served an ATR but not an ATR%, so the high-beta branch was structurally
   * unreachable on that ratchet (`chandelierMultiplier` requires
   * `atrPct !== undefined`).
   *
   * ⛔ Read this BEFORE reading `highBeta: 0`. A zero under a large
   * `baseAtrPctAbsent` is not evidence about volatility; it is evidence the
   * branch was never offered an input.
   */
  baseAtrPctAbsent: number;
  /** Largest `atrPct` observed on a ratchet, `null` if none was. Never 0 by default. */
  maxAtrPct: number | null;
}

/** {@link summarizeChandelierRatchets}'s payload. */
export interface ChandelierRatchetSummary {
  /**
   * ⚠ PER BOOK, not pooled. The live and demo books ratchet in one process and a
   * pooled counter would let demo volatility answer a question asked about real
   * money. `all` is published too, clearly labelled, for the "did this branch
   * ever resolve anywhere" read.
   */
  byMode: { live: ChandelierRatchetTally; demo: ChandelierRatchetTally };
  all: ChandelierRatchetTally;
  /** Boot of the process these counts accrued in — they are since-boot only. */
  sinceBootAt: number;
  note: string;
}

type RatchetMode = 'live' | 'demo';

function emptyTally(): ChandelierRatchetTally {
  return { ratchets: 0, highBeta: 0, base: 0, baseAtrPctAbsent: 0, maxAtrPct: null };
}

const ledger: Record<RatchetMode, ChandelierRatchetTally> = {
  live: emptyTally(),
  demo: emptyTally(),
};
let ledgerSinceBootAt = Date.now();

/**
 * Record ONE chandelier ratchet's multiplier resolution (AC3).
 *
 * Called from the ratchet, not from the fire: the question is which multiplier
 * the trail WIDTH resolved to while it was running, and almost no ratchet ends
 * in a fire. `mult` is the value `chandelierMultiplier` returned for this
 * ratchet, so the three cells are a partition of `ratchets` by construction and
 * cannot drift from the engine's own comparison.
 */
export function noteChandelierRatchet(
  mode: RatchetMode,
  atrPct: number | undefined,
  mult: number,
): void {
  const tally = ledger[mode];
  tally.ratchets += 1;
  const measured = typeof atrPct === 'number' && Number.isFinite(atrPct);
  if (measured && (tally.maxAtrPct === null || (atrPct as number) > tally.maxAtrPct)) {
    tally.maxAtrPct = atrPct as number;
  }
  // The two multipliers are distinct compiled literals (3.0 / 3.5), so this
  // equality identifies the branch unambiguously — the type checker rejects a
  // defensive "and not also the base one" conjunct as provably dead.
  if (mult === EXIT_CHANDELIER_ATR_MULT_HIGHBETA) {
    tally.highBeta += 1;
  } else if (measured) {
    tally.base += 1;
  } else {
    tally.baseAtrPctAbsent += 1;
  }
}

function foldTallies(parts: readonly ChandelierRatchetTally[]): ChandelierRatchetTally {
  const out = emptyTally();
  for (const p of parts) {
    out.ratchets += p.ratchets;
    out.highBeta += p.highBeta;
    out.base += p.base;
    out.baseAtrPctAbsent += p.baseAtrPctAbsent;
    if (p.maxAtrPct !== null && (out.maxAtrPct === null || p.maxAtrPct > out.maxAtrPct)) {
      out.maxAtrPct = p.maxAtrPct;
    }
  }
  return out;
}

/** The since-boot ratchet census (AC3). Pure read; copies, never aliases. */
export function summarizeChandelierRatchets(): ChandelierRatchetSummary {
  const live = { ...ledger.live };
  const demo = { ...ledger.demo };
  return {
    byMode: { live, demo },
    all: foldTallies([live, demo]),
    sinceBootAt: ledgerSinceBootAt,
    note:
      'TRA-4991 AC3. One count per row per exit pass, SINCE BOOT only (nothing persists these). '
      + 'The three cells partition `ratchets`: `highBeta` resolved to '
      + `EXIT_CHANDELIER_ATR_MULT_HIGHBETA (${EXIT_CHANDELIER_ATR_MULT_HIGHBETA}), \`base\` resolved to `
      + `EXIT_CHANDELIER_ATR_MULT (${EXIT_CHANDELIER_ATR_MULT}) with a MEASURED atrPct at or below `
      + `EXIT_CHANDELIER_HIGHBETA_ATRPCT (${EXIT_CHANDELIER_HIGHBETA_ATRPCT}), and \`baseAtrPctAbsent\` `
      + 'got the base multiplier because no atrPct was served at all — on those ratchets the '
      + 'high-beta branch was UNREACHABLE, not declined. Read `baseAtrPctAbsent` and `maxAtrPct` '
      + 'before reading `highBeta: 0`: a zero with no measured atrPct is not a reading about '
      + 'volatility. atrPct is ATR/price on the SAME series as `atrSource` below (5m by default), '
      + 'so the 0.05 threshold is a daily-scale number applied to a 5m-scale input — that is '
      + 'TRA-4992, and these counts are what grade it. byMode is NOT pooled: the live and demo '
      + 'books ratchet in one process.',
  };
}

/** Test seam — the ledger is module state and a suite must be able to zero it. */
export function resetChandelierRatchetLedgerForTests(now = Date.now()): void {
  ledger.live = emptyTally();
  ledger.demo = emptyTally();
  ledgerSinceBootAt = now;
}

// ── AC2 — the live trail parameterisation ────────────────────────────────────

/** {@link resolveChandelierTrailParams}'s payload. */
export interface ChandelierTrailParams {
  issue: 'TRA-4991';
  atrMult: number;
  atrMultHighBeta: number;
  highBetaAtrPct: number;
  /**
   * ⚠ `compiled`: the three multipliers above have NO env override in this
   * build — they are `@trading-app/shared` literals. Published so a reader stops
   * hunting for an env key instead of concluding one was unset.
   */
  multSource: 'compiled';
  atrPeriod: number;
  /** Configured resample width of the ATR's source series. */
  atrTimeframeMs: number;
  atrSeries: 'supertrend_shadow_5m';
  /** The TRA-3941 sleeve rule, resolved HERE (not copied) so it cannot drift. */
  otmSleeveExitRule: OtmSleeveExitRuleResolution & {
    envKey: string;
    /** `true` ⇒ the chandelier FAMILY is retired on `single_leg_otm` in this process. */
    chandelierRetired: boolean;
  };
  note: string;
}

/**
 * AC2 — the resolved trail parameterisation, for publication on
 * `/api/health/option-swing-exits`.
 *
 * `otmSleeveExitRule` is re-resolved through `resolveOtmSleeveExitRule` rather
 * than copied from `/api/health/options-live`, so the two routes can only
 * disagree if the resolver does. That is the whole point of putting it on the
 * exit-parameterisation route: "is the chandelier retired on the OTM sleeve"
 * becomes one read instead of an inference from a missing `render.yaml` key.
 */
export function resolveChandelierTrailParams(
  env: NodeJS.ProcessEnv = process.env,
): ChandelierTrailParams {
  const rule = resolveOtmSleeveExitRule(env);
  return {
    issue: 'TRA-4991',
    atrMult: EXIT_CHANDELIER_ATR_MULT,
    atrMultHighBeta: EXIT_CHANDELIER_ATR_MULT_HIGHBETA,
    highBetaAtrPct: EXIT_CHANDELIER_HIGHBETA_ATRPCT,
    multSource: 'compiled',
    atrPeriod: CHANDELIER_ATR_PERIOD,
    atrTimeframeMs: SHADOW_CANDLE_TIMEFRAME_MS,
    atrSeries: 'supertrend_shadow_5m',
    otmSleeveExitRule: {
      ...rule,
      envKey: OTM_SLEEVE_EXIT_RULE_VALUE,
      chandelierRetired: rule.rule === 'trail',
    },
    note:
      'TRA-4991 AC2. The UNDERLYING-space ATR chandelier: stop = extremeSinceEntry -/+ mult x '
      + 'ATR(atrPeriod) on the atrTimeframeMs series, ratcheting only tighter. `atrTimeframeMs` '
      + 'here is the CONFIGURED resample width; each journal close row in the chandelier family '
      + 'carries the width MEASURED off the bars its own ATR was computed on '
      + '(`chandelier.atrTimeframeMs`) — read the row when they disagree, the row is the '
      + 'measurement. multSource `compiled` means these three have no env override at all. '
      + 'otmSleeveExitRule `trail` + chandelierRetired `true` ⇒ the whole chandelier family '
      + '(ratchet AND fire) is retired on single_leg_otm in THIS process, so no chandelier '
      + 'exit_reason can be minted for an OTM row; source `default` means nothing is set in the '
      + 'env, which IS the TRA-3941 ruling, and `env_invalid` means somebody spelled the key '
      + 'wrong and got the ruling anyway. SCOPE: one sleeve — RV and directional rows keep the '
      + 'chandelier by design.',
  };
}
