import {
  EXIT_CHANDELIER_ATR_MULT,
  EXIT_CHANDELIER_ATR_MULT_HIGHBETA,
  EXIT_CHANDELIER_HIGHBETA_ATRPCT,
  type Candle,
} from '@trading-app/shared';
import {
  resolveOtmSleeveExitRule,
  OTM_SLEEVE_EXIT_RULE_VALUE,
  resolveChandelierAtrTimeframe,
  CHANDELIER_ATR_TIMEFRAME_VALUE,
  type OtmSleeveExitRuleResolution,
  type ChandelierAtrTimeframeName,
  type ChandelierAtrTimeframeResolution,
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
 * Nominal bar spacing of the DAILY series the TRA-4992 repair selects — the
 * `market-data-daily-cache` store `refreshTechnicalSnapshot` warms for free and
 * `otmDailyAtr` already reads for the sibling (entry-invalidation) leg.
 *
 * ⚠️ NOMINAL, and the one place the distinction bites. A daily series' MEASURED
 * spacing is never this number: weekends and holidays make the median
 * consecutive delta 86400000 only across a Mon–Fri run, and a session-boundary
 * gap is 3x it. So with the flag on `daily` the route's configured
 * `atrTimeframeMs` and a row's measured `chandelier.atrTimeframeMs` are EXPECTED
 * to differ — the row is the measurement (TRA-4991's rule), and a measured
 * ~86.4e6 ± a weekend is the positive confirmation that the daily series is what
 * the ATR was actually taken on. ⛔ Do not "reconcile" these two by asserting
 * equality; that assertion would fail on every correct daily read.
 */
export const DAILY_CANDLE_TIMEFRAME_MS = 86_400_000;

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
  /**
   * TRA-4992 — WHICH series the producer SELECTED, beside the measured spacing.
   *
   * Both are published because they fail differently. `timeframeMs` is the
   * ground truth about the bars but it is a RANGE on a daily series (weekends),
   * so it cannot be compared to a constant; `series` is exact but it is a
   * declaration, so on its own it could lie about a mis-wired cache. Together
   * they pin the repair: `series: 'daily'` with a measured spacing still at
   * 300000 is the one reading that says the flag flipped and the input did not.
   */
  series: ChandelierAtrTimeframeName;
}

/**
 * Why the producer served NO chandelier ATR for an otherwise-eligible symbol
 * (TRA-4992 AC3). Carried per symbol so the exit pass's census can attribute the
 * inert row instead of folding it into `no_spot_or_atr`, which also means "the
 * feed served no spot" and would make the two indistinguishable.
 *
 * `cold_daily_atr` — the flag is `daily` and the daily-bars store held too few
 * bars for this underlying (or they yielded no positive ATR). ⛔ THE LEG GOES
 * INERT, it does NOT fall back to the 5m ATR: a fallback would make the flag's
 * effect unobservable, which is the entire reason the repair is flagged. Same
 * fail-closed direction, and the same reason, as TRA-3943's `atrLegInertRows` —
 * a level derived from a number we did not measure is worse than no level.
 */
export type ChandelierAtrInertReason = 'cold_daily_atr';

// ── AC3 — the high-beta branch counter ───────────────────────────────────────

/**
 * Why a row the exit pass looked at produced NO ratchet.
 *
 * ⛔ THIS IS AC3'S DENOMINATOR, and without it AC3 has the defect it was filed
 * against. Measured on live `7b99dda8cd30` minutes after this shipped: `ratchets:
 * 0` across both books — and the book held exactly TWO open rows, both
 * `bull_put` combos. The chandelier is single-leg only, so that zero was a 0/0:
 * nothing was ELIGIBLE. A bare `ratchets: 0` reads identically to "the trail ran
 * all day and never went high-beta", which is the exact "reads the same whether
 * the branch is live or dead" failure the counter exists to kill, one level up.
 *
 * `multi_leg` — a combo (`legs.length > 1`). Held to expiry / manual close; the
 * single-leg trail never evaluates it. ⚠ Counted at the exit loop's OWN combo
 * filter, which `continue`s ~400 lines before the chandelier chain — a census
 * taken at the chain cannot see these rows at all, which is exactly how the live
 * 0/0 above came to be unreadable.
 * `covered_write` — a cash-secured put / covered call. Short credit positions
 * with an inverted P&L basis; the long-side schedule does not apply. Same filter
 * boundary as `multi_leg`.
 * `retired` — TRA-3941: the whole chandelier family is retired on
 * `single_leg_otm`, so those rows never reach the ratchet. This is the cell that
 * explains a zero on a book trading only that sleeve.
 * `no_exit_risk` — no `OptionExitRiskInput` was attached, i.e. the exit-risk
 * master is off. A STRUCTURAL zero; read `exitRiskMaster` beside the census.
 * `no_spot_or_atr` — eligible, but the tick served no underlying spot or no
 * positive ATR (too few cached bars for this underlying). The nearest cell to a
 * real absence: the trail would have run if the feed had reached it.
 * `no_daily_atr` — TRA-4992: eligible, spot served, `CHANDELIER_ATR_TIMEFRAME`
 * is `daily`, and the daily-bars store was COLD for this underlying. The leg is
 * inert for the row by design (AC3) — no level stamped, no fire, and NO fallback
 * to the 5m ATR. ⛔ This cell is the flag's cost of admission and it MUST stay
 * separate from `no_spot_or_atr`: pooled, a warm-up of the daily store would
 * read as a feed outage, and the one question the arm decision turns on — "is the
 * repair inert because the input is missing, or is the book just quiet?" — would
 * be unanswerable. A non-zero here with `timeframe: shadow_5m` is impossible by
 * construction and would mean the producer and the resolver disagree.
 *
 * ⛔ `rowsSeen` IS NOT THE OPEN-ROW COUNT. It counts rows reaching the chandelier
 * chain plus the two filters named above; the exit loop has further `continue`s
 * (an unmirrored import, an in-flight `pendingExit`) that are NOT instrumented
 * here. For the book census read `/api/health/option-journal?rows=open`. What
 * `rowsSeen` is good for is the question it was added to answer: is a
 * `ratchets: 0` a rate or a 0/0?
 */
export type ChandelierSkipReason =
  | 'retired'
  | 'multi_leg'
  | 'covered_write'
  | 'no_exit_risk'
  | 'no_spot_or_atr'
  | 'no_daily_atr';

export const CHANDELIER_SKIP_REASONS: readonly ChandelierSkipReason[] = [
  'retired', 'multi_leg', 'covered_write', 'no_exit_risk', 'no_spot_or_atr', 'no_daily_atr',
];

/** One book's ratchet tally. `maxAtrPct` is `null` until an `atrPct` is seen. */
export interface ChandelierRatchetTally {
  /**
   * Every row the exit pass evaluated for the chandelier, ratcheted or not —
   * `ratchets + Σ skipped`. ⛔ READ THIS FIRST. `rowsSeen: 0` means the pass
   * looked at NO row, so every other number below is a 0/0 and none of them is a
   * reading about the trail.
   */
  rowsSeen: number;
  /** Ratchets resolved, one per row per exit pass. */
  ratchets: number;
  /** Why the other `rowsSeen − ratchets` rows produced none. See {@link ChandelierSkipReason}. */
  skipped: Record<ChandelierSkipReason, number>;
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
  return {
    rowsSeen: 0,
    ratchets: 0,
    skipped: {
      retired: 0, multi_leg: 0, covered_write: 0, no_exit_risk: 0, no_spot_or_atr: 0,
      no_daily_atr: 0,
    },
    highBeta: 0,
    base: 0,
    baseAtrPctAbsent: 0,
    maxAtrPct: null,
  };
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
  tally.rowsSeen += 1;
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

/**
 * Record ONE row the exit pass evaluated for the chandelier that produced NO
 * ratchet, and WHY (AC3's denominator). See {@link ChandelierSkipReason} — the
 * live 0/0 this exists for is documented there.
 */
export function noteChandelierRowSkipped(
  mode: RatchetMode,
  reason: ChandelierSkipReason,
): void {
  const tally = ledger[mode];
  tally.rowsSeen += 1;
  tally.skipped[reason] += 1;
}

function foldTallies(parts: readonly ChandelierRatchetTally[]): ChandelierRatchetTally {
  const out = emptyTally();
  for (const p of parts) {
    out.rowsSeen += p.rowsSeen;
    out.ratchets += p.ratchets;
    for (const r of CHANDELIER_SKIP_REASONS) out.skipped[r] += p.skipped[r];
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
  const live = { ...ledger.live, skipped: { ...ledger.live.skipped } };
  const demo = { ...ledger.demo, skipped: { ...ledger.demo.skipped } };
  return {
    byMode: { live, demo },
    all: foldTallies([live, demo]),
    sinceBootAt: ledgerSinceBootAt,
    note:
      'TRA-4991 AC3. ⛔ READ `rowsSeen` FIRST: it is the DENOMINATOR (ratchets + sum of skipped). '
      + 'rowsSeen 0 means the exit pass evaluated NO row for the chandelier, so `ratchets: 0` and '
      + '`highBeta: 0` are a 0/0 and neither is a reading about the trail — measured exactly that '
      + 'way on 2026-10-02, when the whole book was two bull_put combos. `skipped` attributes every '
      + 'non-ratchet: `multi_leg` = a combo (never reaches the single-leg trail), `covered_write` = '
      + 'a CSP/covered call (inverted P&L basis), `retired` = TRA-3941 retired the family on '
      + 'single_leg_otm, `no_exit_risk` = the exit-risk master is off (structural), `no_spot_or_atr` '
      + '= eligible but the tick served no spot or no positive ATR, `no_daily_atr` = TRA-4992, the '
      + 'ATR timeframe is `daily` and the daily-bars store was COLD for that underlying so the leg '
      + 'went inert by design (no level, no fire, no 5m fallback) — kept SEPARATE from '
      + 'no_spot_or_atr so a daily-store warm-up cannot read as a feed outage. ⛔ rowsSeen is NOT the open-row '
      + 'count: the exit loop has further skips that are not instrumented here, so read '
      + '/api/health/option-journal?rows=open for the book census. '
      + 'One count per row per exit pass, SINCE BOOT only (nothing persists these). '
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
   * TRA-4992 AC4 — which timeframe `highBetaAtrPct` is CALIBRATED for, stated
   * because it does not move with the flag and the flag is what makes it
   * meaningful.
   *
   * `EXIT_CHANDELIER_HIGHBETA_ATRPCT = 0.05` is a DAILY-scale number: a name
   * whose daily ATR is >5% of spot is high-beta. `chandelierMultiplier` compares
   * it against `atrPct = atr(series)/lastClose` on whichever series is selected
   * (`packages/engine/src/indicators/atr.ts`). On the 5m series a 5% 70-minute
   * range is a near-unreachable extreme, so the 3.5 multiplier was effectively
   * dead; on `daily` the threshold means what it was calibrated to mean and 3.5
   * becomes REACHABLE. ⛔ So flipping this flag changes the trail width through
   * TWO paths, not one — the ATR level AND which multiplier it is scaled by.
   */
  highBetaAtrPctCalibratedFor: 'daily';
  /**
   * ⚠ `compiled`: the three multipliers above have NO env override in this
   * build — they are `@trading-app/shared` literals. Published so a reader stops
   * hunting for an env key instead of concluding one was unset.
   */
  multSource: 'compiled';
  atrPeriod: number;
  /**
   * Configured (NOMINAL) bar width of the ATR's source series, for the SELECTED
   * timeframe. ⚠️ On `daily` compare this to a row's measured
   * `chandelier.atrTimeframeMs` only as an order of magnitude — see
   * {@link DAILY_CANDLE_TIMEFRAME_MS}.
   */
  atrTimeframeMs: number;
  atrSeries: 'supertrend_shadow_5m' | 'daily_bars';
  /**
   * TRA-4992 — the ATR-series selection, resolved HERE through
   * `resolveChandelierAtrTimeframe` (not copied), so this route and the producer
   * can only disagree if the resolver does.
   *
   * ⛔ `source: 'default'` ⇒ `shadow_5m` ⇒ THE DEFECT IS STILL LIVE AND THAT IS
   * THE INTENDED SHIPPING STATE (AC5). `source: 'env_invalid'` ⇒ somebody tried
   * to arm the repair and misspelled it, and got the OLD behaviour — the one
   * reading on this route that is a standing action item.
   */
  atrTimeframe: ChandelierAtrTimeframeResolution & { envKey: string };
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
  const atrTf = resolveChandelierAtrTimeframe(env);
  const daily = atrTf.timeframe === 'daily';
  return {
    issue: 'TRA-4991',
    atrMult: EXIT_CHANDELIER_ATR_MULT,
    atrMultHighBeta: EXIT_CHANDELIER_ATR_MULT_HIGHBETA,
    highBetaAtrPct: EXIT_CHANDELIER_HIGHBETA_ATRPCT,
    highBetaAtrPctCalibratedFor: 'daily',
    multSource: 'compiled',
    atrPeriod: CHANDELIER_ATR_PERIOD,
    atrTimeframeMs: daily ? DAILY_CANDLE_TIMEFRAME_MS : SHADOW_CANDLE_TIMEFRAME_MS,
    atrSeries: daily ? 'daily_bars' : 'supertrend_shadow_5m',
    atrTimeframe: { ...atrTf, envKey: CHANDELIER_ATR_TIMEFRAME_VALUE },
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
      + 'chandelier by design. '
      + 'TRA-4992: `atrTimeframe` selects the ATR SERIES — `shadow_5m` (default) is the 3.0 x '
      + 'ATR(14, 5m) UNIT ERROR this repair exists to fix (a 3.0 multiplier specified for a DAILY '
      + 'ATR, applied to three 70-minute ranges; pooled median hold 1.04h, shortest 1.9s), `daily` '
      + 'is the repair. source `default` means the defect is STILL LIVE, which is the intended '
      + 'shipping state — arming is a board call graded by QuantTrader, not a deploy. source '
      + '`env_invalid` means somebody tried to arm it, misspelled the value, and got the OLD '
      + 'behaviour: that is the one reading here that needs action. ⛔ On `daily` a cold daily-bars '
      + 'store makes the leg INERT for that row (no level, no fire, NO 5m fallback) and the row '
      + 'lands in `ratchets.skipped.no_daily_atr` — read that cell before reading `ratchets: 0`. '
      + 'And note `highBetaAtrPctCalibratedFor: daily`: flipping to `daily` moves the trail through '
      + 'TWO paths, the ATR level AND which multiplier scales it, because the 0.05 high-beta '
      + 'threshold only becomes reachable on a daily-scale atrPct.',
  };
}
