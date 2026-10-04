/**
 * TRA-5061 (parent TRA-4992) — the SIDE-BY-SIDE ATR shadow for the options
 * chandelier: compute BOTH the 5m and the daily trail on every ratchet, publish
 * both, and let only the selected one decide.
 *
 * ── Why this exists, and what it is NOT ─────────────────────────────────────
 *
 * TRA-4992 shipped `CHANDELIER_ATR_TIMEFRAME` dark. Arming it is a board call,
 * and the board's bear case is about two things that are NOT the same question:
 *
 *   1. MECHANISM REACHABILITY — on real options underlyings, would the daily
 *      trail even have a level? Or would it sit in `no_daily_atr` because the
 *      daily store was cold for that name? And does the 3.5 high-beta branch
 *      ever resolve, or is `EXIT_CHANDELIER_HIGHBETA_ATRPCT = 0.05` (a
 *      daily-scale threshold) still effectively dead?
 *   2. P&L — what would a row have EARNED under the daily trail?
 *
 * ⛔ THIS INSTRUMENT ANSWERS (1) ONLY, AND IT CANNOT ANSWER (2). That is
 * ratified in writing by QuantTrader (TRA-5061 AC5) and published on the
 * payload as {@link CHANDELIER_ATR_SHADOW_EVIDENCE_CLASS}, so no later reader
 * can cite this surface as the forward test. The reason is structural, not a
 * limitation of the implementation: a shadow width is a counterfactual on a
 * LEVEL. An exit that does not fire changes every subsequent tick of that
 * position's path — peak, give-back, hold, and the eventual exit reason all
 * move — so a row's `crossedR` under the counterfactual trail is simply not a
 * function of anything observable on the factual path. Cost-aware `crossedR`
 * over `n >= 20` per side still needs REAL FILLS behind the flag.
 *
 * ── Why a shadow rather than the flag, for this question ────────────────────
 *
 * The flag earns nothing until something arms: measured 2026-10-02 on live
 * bqb1 `104bc8ed`, the live exit hoist read `verdict: disarmed` with 0 of 3
 * engines armed, and the OTM sleeve has the chandelier family retired
 * (TRA-3941). The shadow accrues on every ratchet the exit pass ALREADY
 * performs, on whichever book is armed, with zero behaviour change and nothing
 * to arm.
 *
 * ⚠️ BUT NOT "IMMEDIATELY", AND NOT FLEET-WIDE — the original premise for this
 * instrument was wrong in a way that had to be fixed in the ACs rather than
 * discovered later. A ratchet needs an OPEN ROW, and on 2026-10-02 every book
 * was flat (live `fleetAtRiskUsd` 0 on all three, demo `openPositionCount` 0).
 * On the LIVE book it is worse than flat: with the hoist disarmed no exit pass
 * fires there at all. The only accrual carrier is whichever book is armed and
 * holding single-leg directional rows. Hence {@link ChandelierAtrShadowTally}
 * carries its own denominator and its own skip attribution, and hence the
 * per-book partition below is not decoration.
 *
 * ── The three failure shapes this module is built against ──────────────────
 *
 * `observations: 0` must never read as "the daily trail is unreachable" when it
 * means "there were no rows". That is TRA-3514's shape (a zero needs its
 * ELIGIBLE denominator) and TRA-4744's (`booksScanned` 4 vs `books[]` 3 silently
 * dropped the book under test). So:
 *
 *   • AC2 — every count ships beside `rowsSeen` and the full `rowsSkipped`
 *     attribution, which partition it. `rowsSeen: 0` ⇒ every other number here
 *     is a 0/0 and NONE of them is a reading about the daily trail.
 *   • AC3 — {@link ChandelierAtrShadowSummary.byBook} is PER BOOK and never
 *     pooled. Live is the disarmed/flat one; a blended `n` would let demo rows
 *     answer a question asked about real money (QuantTrader's own n=9 blend on
 *     TRA-3945 is the cited precedent). `all` is published, clearly labelled,
 *     for the "did this branch ever resolve anywhere" read only.
 *   • AC1 — the counters are day-partitioned and SEEDED FROM DISK, because a
 *     since-boot-only twin would have published a vacuous 0 on the morning it
 *     shipped: the graded process booted 2026-10-02T12:51:47Z, AFTER the 10-01
 *     close, so the live surface's own `sessionCoverage` already read
 *     `boot_after_close` / `zeroReading: "vacuous"` (TRA-4343).
 *
 * ── The number the arm decision turns on ───────────────────────────────────
 *
 * `daily.coldSeries / observations` is the PRE-ARM ESTIMATE OF THE
 * `no_daily_atr` RATE. While the flag is `shadow_5m` the producer refuses
 * nothing, so the census cell `ratchets.skipped.no_daily_atr` is structurally 0
 * and tells you nothing; this arm is its counterfactual, measured on the same
 * real rows, with no arm. QuantTrader's pre-registered stop is `> 25%` of
 * ratchets ⇒ abandon the daily flip (a trail that is absent a quarter of the
 * time is worse than a too-tight one), and `> 15%` is the bear case.
 *
 * Second: `daily.highBeta / daily.resolved` is the 3.0/3.5 SPLIT on real
 * options names. Pre-registered: `> 80%` ⇒ the daily arm is a de-facto 3.5
 * constant rather than a scale change, which is a DIFFERENT spec from the one
 * TRA-4992 cites (Chande's constant is 3.0) and comes back to QuantTrader for
 * ratification before it arms.
 *
 * ⛔ OBSERVE-ONLY. Nothing here is read by an exit decision, a level, or an
 * order path. {@link ChandelierAtrShadowPair.decidedBy} names the arm that
 * actually decided, and it is the ONLY one `buildOptionExitRisk` wires into
 * `underlyingAtrBySymbol`.
 */

import { atr, atrPct as atrPctOf, chandelierMultiplier } from '@trading-app/engine';
import { EXIT_CHANDELIER_ATR_MULT_HIGHBETA, type Candle } from '@trading-app/shared';

import { etDateKey } from './et-clock.js';
// The skip-reason vocabulary and the ATR period are single-sourced from the
// TRA-4991 module. There must not be a second copy of either: the two censuses
// have to partition the SAME rows, and the period has to be the one `atr()` was
// actually called with.
//
// ⚠ This dependency runs ONE WAY — `option-chandelier-trail.ts` must never
// import this module back. That is why the two `note*` functions below are
// forwarded from the call sites in `options-account.ts` rather than from inside
// `noteChandelierRowSkipped`: forwarding there would be tidier but it would
// close an ESM cycle. The property that would have bought (a future sixth skip
// site cannot land in one census and miss the other) is instead held by a test
// asserting the two `rowsSeen` agree after an exit pass — which is a stronger
// guarantee than the comment would have been.
import {
  CHANDELIER_SKIP_REASONS,
  CHANDELIER_ATR_PERIOD,
  type ChandelierSkipReason,
} from './option-chandelier-trail.js';
import type { ChandelierAtrTimeframeName } from './exit-risk-rules-flag.js';
import {
  readChandelierAtrShadowDay,
  persistChandelierAtrShadowDay,
  readChandelierAtrShadowDurable,
} from './tra5061-chandelier-atr-shadow-store.js';

/**
 * AC5, as a field rather than as prose in a ticket. Published on every payload
 * this module emits.
 *
 * ⛔ Do not widen this string without a QuantTrader ruling. It is the written
 * ratification that this instrument answers MECHANISM REACHABILITY only — see
 * the module docblock for why P&L is structurally out of reach here, not merely
 * unimplemented.
 */
export const CHANDELIER_ATR_SHADOW_EVIDENCE_CLASS = 'reachability_only' as const;

/** Why one arm of the pair served no trail width. */
export type ChandelierAtrShadowUnavailable =
  /** Fewer than the ATR period + 1 bars in that series for this underlying. */
  | 'cold_series'
  /** Bars present, but `atr()` returned null or a non-positive value. */
  | 'no_positive_atr';

/**
 * ONE series' resolved chandelier trail, as a counterfactual.
 *
 * Both arms of a pair are built by {@link buildChandelierAtrShadowArm} from the
 * same code path, so the selected arm's numbers here are the ones the trail
 * really used and the unselected arm's are what it would have used.
 */
export interface ChandelierAtrShadowArm {
  series: ChandelierAtrTimeframeName;
  /** ATR(period) on this series. `null` ⇔ `unavailable !== null`. */
  atrValue: number | null;
  /**
   * ATR / last close on this series — the input `chandelierMultiplier` compares
   * to the 0.05 threshold. `null` means the series served an ATR but no ATR%,
   * on which the high-beta branch is structurally UNREACHABLE rather than
   * declined (`chandelierMultiplier` requires a defined `atrPct`).
   */
  atrPctValue: number | null;
  bars: number;
  /** MEASURED bar spacing, never 0 — see `measureCandleTimeframeMs`. */
  timeframeMs: number | null;
  /**
   * The multiplier THIS arm resolved, from the engine's own
   * `chandelierMultiplier` — never a re-spelling of `atrPct > 0.05` here. A
   * second copy of the threshold would publish what this file believes instead
   * of what the trail does, which is the exact defect TRA-4991 was filed
   * against one layer up.
   */
  multiplier: number | null;
  /**
   * `multiplier * atrValue` — the trail's HALF-WIDTH in underlying dollars, the
   * quantity the two scales are actually being compared on. This is the whole
   * point of a side-by-side: the daily/5m ratio of THIS field is the real width
   * change, and it is NOT the ATR ratio, because the multiplier moves too.
   */
  halfWidthUsd: number | null;
  unavailable: ChandelierAtrShadowUnavailable | null;
}

/** Both arms for one ratchet, plus which one decided. */
export interface ChandelierAtrShadowPair {
  shadow5m: ChandelierAtrShadowArm;
  daily: ChandelierAtrShadowArm;
  /**
   * The arm `buildOptionExitRisk` wired into `underlyingAtrBySymbol`, i.e. the
   * one that set the real level. Carried so a reader never has to join this
   * payload to the flag to know which column was load-bearing.
   */
  decidedBy: ChandelierAtrTimeframeName;
}

/** Minimum bars either arm needs, matching `buildOptionExitRisk`'s own gate. */
export const CHANDELIER_ATR_SHADOW_MIN_BARS = 15;

/**
 * Resolve ONE arm. Pure; no module state, no clock, no IO.
 *
 * ⚠ The `< CHANDELIER_ATR_SHADOW_MIN_BARS` gate is the SAME threshold
 * `buildOptionExitRisk` applies before it will use a series. It must stay the
 * same number, or `cold_series` here would stop being the counterfactual of the
 * producer's own refusal and this instrument would be measuring a different
 * predicate from the one the arm decision turns on.
 */
export function buildChandelierAtrShadowArm(
  // Mutable `Candle[]`, matching `atr()` / `atrPct()`'s own signatures — the
  // point of this function is to put both arms through the SAME indicator calls
  // the producer makes, so it must accept exactly what they accept.
  series: Candle[] | undefined,
  name: ChandelierAtrTimeframeName,
  measureTimeframeMs: (s: readonly Candle[] | undefined) => number | null,
  period: number = CHANDELIER_ATR_PERIOD,
): ChandelierAtrShadowArm {
  const empty = (unavailable: ChandelierAtrShadowUnavailable): ChandelierAtrShadowArm => ({
    series: name,
    atrValue: null,
    atrPctValue: null,
    bars: series?.length ?? 0,
    timeframeMs: measureTimeframeMs(series),
    multiplier: null,
    halfWidthUsd: null,
    unavailable,
  });
  if (!series || series.length < CHANDELIER_ATR_SHADOW_MIN_BARS) return empty('cold_series');
  const a = atr(series, period);
  if (a == null || !(a > 0)) return empty('no_positive_atr');
  const ap = atrPctOf(series, period);
  const atrPctValue = ap != null && Number.isFinite(ap) ? ap : null;
  // The engine's own comparison, called exactly as `chandelierStop` calls it
  // internally — `undefined`, not `null`, for an absent atrPct, because
  // `chandelierMultiplier` branches on `!== undefined`.
  const multiplier = chandelierMultiplier(atrPctValue === null ? undefined : atrPctValue);
  return {
    series: name,
    atrValue: a,
    atrPctValue,
    bars: series.length,
    timeframeMs: measureTimeframeMs(series),
    multiplier,
    halfWidthUsd: multiplier * a,
    unavailable: null,
  };
}

// ── The census ───────────────────────────────────────────────────────────────

/** One arm's tally. `resolved = highBeta + base + baseAtrPctAbsent`. */
export interface ChandelierAtrShadowArmTally {
  /** Observations where this arm produced a width. The arm's own denominator. */
  resolved: number;
  /** Of `resolved`: resolved to `EXIT_CHANDELIER_ATR_MULT_HIGHBETA` (3.5). */
  highBeta: number;
  /** Of `resolved`: the base multiplier (3.0) on a MEASURED `atrPct`. */
  base: number;
  /**
   * Of `resolved`: the base multiplier because NO `atrPct` was served, so the
   * high-beta branch was never offered an input.
   *
   * ⛔ Read this before reading `highBeta: 0` — a zero over this denominator is
   * not a reading about volatility.
   */
  baseAtrPctAbsent: number;
  /**
   * Observations where the series held too few bars.
   *
   * ⛔ ON THE `daily` ARM THIS IS THE HEADLINE: it is the counterfactual
   * `no_daily_atr` rate, the flag's cost of admission, measured with no arm.
   * See the module docblock for the pre-registered thresholds.
   */
  coldSeries: number;
  /** Observations where bars were present but no positive ATR came out. */
  noPositiveAtr: number;
  /** Extremes of the MEASURED `atrPct`, `null` until one is seen. Never 0 by default. */
  minAtrPct: number | null;
  maxAtrPct: number | null;
  /** Σ half-width and its sample count, so a reader can take a mean without us pre-dividing. */
  halfWidthUsdSum: number;
  halfWidthSamples: number;
}

/** One book's shadow tally for one ET day. */
export interface ChandelierAtrShadowTally {
  /**
   * Rows the exit pass evaluated for the chandelier — `observations + Σ
   * rowsSkipped`.
   *
   * ⛔ READ THIS FIRST (AC2). `rowsSeen: 0` means the pass looked at NO row, so
   * every number below is a 0/0 and none is a reading about either trail.
   */
  rowsSeen: number;
  /** Ratchets this instrument saw a pair for. The denominator for both arms. */
  observations: number;
  /**
   * Ratchets that reached the trail but carried NO pair — the producer attached
   * no shadow for that underlying.
   *
   * Expected to be 0 in this build and non-zero only for a hand-built
   * `OptionExitRiskInput` (tests) or a producer/consumer version skew. Counted
   * rather than silently folded into `observations`, because folding would let
   * a skew read as a quiet book.
   */
  pairAbsent: number;
  /** Why the other `rowsSeen − observations − pairAbsent` rows produced none. */
  rowsSkipped: Record<ChandelierSkipReason, number>;
  shadow5m: ChandelierAtrShadowArmTally;
  daily: ChandelierAtrShadowArmTally;
  /**
   * Of the observations where BOTH arms resolved: the two arms picked DIFFERENT
   * multipliers. This is the second of TRA-4992's two paths made directly
   * observable — a non-zero here is the 3.0→3.5 promotion that an ATR-ratio
   * estimate of the flip would miss entirely.
   */
  multiplierDisagreements: number;
  /**
   * Of the observations where BOTH arms resolved: Σ and extremes of
   * `daily.halfWidthUsd / shadow5m.halfWidthUsd` — the MEASURED width change
   * the flip would produce, through both paths at once.
   *
   * ⚠ `samples` is the only valid denominator for the sum. It is NOT
   * `observations`: a ratio is undefined wherever either arm was unavailable,
   * and on a cold daily store that is most of them.
   */
  widthRatio: {
    sum: number;
    samples: number;
    min: number | null;
    max: number | null;
  };
}

export type ChandelierAtrShadowBook = 'live' | 'demo';

export const CHANDELIER_ATR_SHADOW_BOOKS: readonly ChandelierAtrShadowBook[] = ['live', 'demo'];

function emptyArmTally(): ChandelierAtrShadowArmTally {
  return {
    resolved: 0,
    highBeta: 0,
    base: 0,
    baseAtrPctAbsent: 0,
    coldSeries: 0,
    noPositiveAtr: 0,
    minAtrPct: null,
    maxAtrPct: null,
    halfWidthUsdSum: 0,
    halfWidthSamples: 0,
  };
}

export function emptyChandelierAtrShadowTally(): ChandelierAtrShadowTally {
  const skipped = {} as Record<ChandelierSkipReason, number>;
  for (const r of CHANDELIER_SKIP_REASONS) skipped[r] = 0;
  return {
    rowsSeen: 0,
    observations: 0,
    pairAbsent: 0,
    rowsSkipped: skipped,
    shadow5m: emptyArmTally(),
    daily: emptyArmTally(),
    multiplierDisagreements: 0,
    widthRatio: { sum: 0, samples: 0, min: null, max: null },
  };
}

/**
 * The live, day-partitioned ledger: `${etDay}|${book}` → cumulative counters
 * for that ET day, SEEDED FROM DISK on first touch (AC1).
 *
 * Cumulative-within-day is what makes the durable snapshots exact: the newest
 * snapshot for a key is that day's total, so the fold is a latest-wins per key
 * and summing across days double-counts nothing. Without the disk seed, a boot
 * mid-session would restart the counters at 0 and the next snapshot would
 * REGRESS the day's total — which is the same silent-undercount shape the
 * durable twin exists to remove.
 */
const dayLedger = new Map<string, ChandelierAtrShadowTally>();
const seededKeys = new Set<string>();
let ledgerSinceBootAt = Date.now();

export function chandelierAtrShadowDayKey(etDay: string, book: ChandelierAtrShadowBook): string {
  return `${etDay}|${book}`;
}

function tallyFor(etDay: string, book: ChandelierAtrShadowBook): ChandelierAtrShadowTally {
  const key = chandelierAtrShadowDayKey(etDay, book);
  let t = dayLedger.get(key);
  if (t) return t;
  // First touch this boot: adopt the day's stored total so this process
  // CONTINUES the day rather than restarting it.
  if (!seededKeys.has(key)) {
    seededKeys.add(key);
    const stored = readChandelierAtrShadowDay(etDay, book);
    if (stored) {
      dayLedger.set(key, stored);
      return stored;
    }
  }
  t = emptyChandelierAtrShadowTally();
  dayLedger.set(key, t);
  return t;
}

function noteArm(tally: ChandelierAtrShadowArmTally, arm: ChandelierAtrShadowArm): void {
  if (arm.unavailable === 'cold_series') {
    tally.coldSeries += 1;
    return;
  }
  if (arm.unavailable === 'no_positive_atr') {
    tally.noPositiveAtr += 1;
    return;
  }
  tally.resolved += 1;
  // The two multipliers are distinct compiled literals (3.0 / 3.5), so this
  // equality identifies the branch unambiguously.
  if (arm.multiplier === EXIT_CHANDELIER_ATR_MULT_HIGHBETA) tally.highBeta += 1;
  else if (arm.atrPctValue !== null) tally.base += 1;
  else tally.baseAtrPctAbsent += 1;
  if (arm.atrPctValue !== null) {
    if (tally.minAtrPct === null || arm.atrPctValue < tally.minAtrPct) tally.minAtrPct = arm.atrPctValue;
    if (tally.maxAtrPct === null || arm.atrPctValue > tally.maxAtrPct) tally.maxAtrPct = arm.atrPctValue;
  }
  if (arm.halfWidthUsd !== null && Number.isFinite(arm.halfWidthUsd)) {
    tally.halfWidthUsdSum += arm.halfWidthUsd;
    tally.halfWidthSamples += 1;
  }
}

/**
 * Record ONE ratchet's side-by-side pair.
 *
 * Called from the ratchet rather than from the fire, for the reason
 * `noteChandelierRatchet` already gives: the question is what the two trail
 * WIDTHS resolved to while the trail was running, and almost no ratchet ends in
 * a fire.
 *
 * `pair` may be `undefined` — a hand-built `OptionExitRiskInput` carries no
 * shadow map. That increments `pairAbsent`, never `observations`.
 */
export function noteChandelierAtrShadow(
  book: ChandelierAtrShadowBook,
  pair: ChandelierAtrShadowPair | undefined,
  nowMs: number = Date.now(),
): void {
  const t = tallyFor(etDateKey(nowMs), book);
  t.rowsSeen += 1;
  if (!pair) {
    t.pairAbsent += 1;
    persistChandelierAtrShadowDay(etDateKey(nowMs), book, t, nowMs);
    return;
  }
  t.observations += 1;
  noteArm(t.shadow5m, pair.shadow5m);
  noteArm(t.daily, pair.daily);
  const w5 = pair.shadow5m.halfWidthUsd;
  const wd = pair.daily.halfWidthUsd;
  if (pair.shadow5m.multiplier !== null && pair.daily.multiplier !== null) {
    if (pair.shadow5m.multiplier !== pair.daily.multiplier) t.multiplierDisagreements += 1;
  }
  if (w5 !== null && wd !== null && w5 > 0 && Number.isFinite(wd)) {
    const ratio = wd / w5;
    if (Number.isFinite(ratio)) {
      t.widthRatio.sum += ratio;
      t.widthRatio.samples += 1;
      if (t.widthRatio.min === null || ratio < t.widthRatio.min) t.widthRatio.min = ratio;
      if (t.widthRatio.max === null || ratio > t.widthRatio.max) t.widthRatio.max = ratio;
    }
  }
  persistChandelierAtrShadowDay(etDateKey(nowMs), book, t, nowMs);
}

/**
 * Record ONE row the exit pass evaluated that produced no ratchet, and why —
 * the shadow's own copy of AC2's denominator.
 *
 * ⚠ Called at each of `noteChandelierRowSkipped`'s own call sites, NOT
 * forwarded from inside it — see the one-way-dependency note at the imports.
 * The two censuses must partition the same rows; that is asserted by test
 * (`rowsSeen` agreement after an exit pass), which is where a future sixth skip
 * site will be caught.
 */
export function noteChandelierAtrShadowSkip(
  book: ChandelierAtrShadowBook,
  reason: ChandelierSkipReason,
  nowMs: number = Date.now(),
): void {
  const etDay = etDateKey(nowMs);
  const t = tallyFor(etDay, book);
  t.rowsSeen += 1;
  t.rowsSkipped[reason] += 1;
  persistChandelierAtrShadowDay(etDay, book, t, nowMs);
}

function foldArms(parts: readonly ChandelierAtrShadowArmTally[]): ChandelierAtrShadowArmTally {
  const out = emptyArmTally();
  for (const p of parts) {
    out.resolved += p.resolved;
    out.highBeta += p.highBeta;
    out.base += p.base;
    out.baseAtrPctAbsent += p.baseAtrPctAbsent;
    out.coldSeries += p.coldSeries;
    out.noPositiveAtr += p.noPositiveAtr;
    out.halfWidthUsdSum += p.halfWidthUsdSum;
    out.halfWidthSamples += p.halfWidthSamples;
    if (p.minAtrPct !== null && (out.minAtrPct === null || p.minAtrPct < out.minAtrPct)) {
      out.minAtrPct = p.minAtrPct;
    }
    if (p.maxAtrPct !== null && (out.maxAtrPct === null || p.maxAtrPct > out.maxAtrPct)) {
      out.maxAtrPct = p.maxAtrPct;
    }
  }
  return out;
}

export function foldChandelierAtrShadowTallies(
  parts: readonly ChandelierAtrShadowTally[],
): ChandelierAtrShadowTally {
  const out = emptyChandelierAtrShadowTally();
  for (const p of parts) {
    out.rowsSeen += p.rowsSeen;
    out.observations += p.observations;
    out.pairAbsent += p.pairAbsent;
    for (const r of CHANDELIER_SKIP_REASONS) out.rowsSkipped[r] += p.rowsSkipped[r];
    out.multiplierDisagreements += p.multiplierDisagreements;
    out.widthRatio.sum += p.widthRatio.sum;
    out.widthRatio.samples += p.widthRatio.samples;
    if (p.widthRatio.min !== null && (out.widthRatio.min === null || p.widthRatio.min < out.widthRatio.min)) {
      out.widthRatio.min = p.widthRatio.min;
    }
    if (p.widthRatio.max !== null && (out.widthRatio.max === null || p.widthRatio.max > out.widthRatio.max)) {
      out.widthRatio.max = p.widthRatio.max;
    }
  }
  out.shadow5m = foldArms(parts.map((p) => p.shadow5m));
  out.daily = foldArms(parts.map((p) => p.daily));
  return out;
}

/** Deep copy, so a summary can never alias (and so mutate) the live ledger. */
export function copyChandelierAtrShadowTally(t: ChandelierAtrShadowTally): ChandelierAtrShadowTally {
  return {
    ...t,
    rowsSkipped: { ...t.rowsSkipped },
    shadow5m: { ...t.shadow5m },
    daily: { ...t.daily },
    widthRatio: { ...t.widthRatio },
  };
}

/** Test seam — the ledger and its disk-seed memo are module state. */
export function resetChandelierAtrShadowLedgerForTests(now = Date.now()): void {
  dayLedger.clear();
  seededKeys.clear();
  ledgerSinceBootAt = now;
}

/** The live ledger, keyed `${etDay}|${book}`. Copies, never aliases. */
export function chandelierAtrShadowLedgerSnapshot(): Map<string, ChandelierAtrShadowTally> {
  const out = new Map<string, ChandelierAtrShadowTally>();
  for (const [k, v] of dayLedger) out.set(k, copyChandelierAtrShadowTally(v));
  return out;
}

export function chandelierAtrShadowSinceBootAt(): number {
  return ledgerSinceBootAt;
}

// ── The published payload ────────────────────────────────────────────────────

/**
 * A rate, WITH the denominator it was taken over.
 *
 * Never a bare number. Every reading on this instrument is a ratio whose
 * denominator can legitimately be 0 (a flat book), and a bare `0.0` would read
 * as a measured absence rather than as "nothing was eligible" — the exact
 * TRA-3514 shape this instrument is built against.
 */
export interface ChandelierAtrShadowRate {
  /** `null` ⇔ `denominator === 0`. Never 0-by-default. */
  value: number | null;
  numerator: number;
  denominator: number;
  /** `true` ⇔ the denominator is 0, i.e. this is a 0/0 and NOT a reading. */
  vacuous: boolean;
  /** What the denominator IS, named so it cannot be mistaken for `observations`. */
  denominatorIs: string;
}

function rate(numerator: number, denominator: number, denominatorIs: string): ChandelierAtrShadowRate {
  return {
    value: denominator > 0 ? numerator / denominator : null,
    numerator,
    denominator,
    vacuous: denominator === 0,
    denominatorIs,
  };
}

/** The readings the arm decision turns on, derived for one book. */
export interface ChandelierAtrShadowReadings {
  /**
   * The COUNTERFACTUAL `no_daily_atr` rate — how often the daily trail would
   * have had NO level because the daily store was cold for that underlying.
   *
   * ⛔ THE HEADLINE. While `CHANDELIER_ATR_TIMEFRAME` is `shadow_5m` the
   * producer refuses nothing, so the real census cell
   * `ratchets.skipped.no_daily_atr` is a STRUCTURAL 0 and says nothing. This is
   * its counterfactual on the same real rows with no arm.
   */
  dailyColdRate: ChandelierAtrShadowRate;
  /**
   * The 3.0/3.5 split on the DAILY arm — the single number QuantTrader asked
   * for. Denominator is `daily.resolved`, NOT `observations`: a cold ratchet
   * resolved no multiplier at all.
   */
  dailyHighBetaShare: ChandelierAtrShadowRate;
  /**
   * The same split on the 5m arm, i.e. the branch's reachability under TODAY's
   * shipped behaviour. Expected near 0 — a 5% 70-minute range is a
   * near-unreachable extreme — and it is the control that makes the daily
   * number mean something.
   */
  shadow5mHighBetaShare: ChandelierAtrShadowRate;
  /**
   * Mean `daily / 5m` trail HALF-WIDTH ratio, over ratchets where both arms
   * resolved. This is the real width change through BOTH of TRA-4992's paths —
   * the ATR scale AND the multiplier promotion — and it is why an ATR-ratio
   * estimate understates the flip (on the suite's fixture, 18.67x not 16x).
   */
  meanWidthRatio: ChandelierAtrShadowRate;
  /**
   * Of the ratchets where both arms resolved: how often the two arms picked
   * DIFFERENT multipliers. Non-zero ⇒ the 3.0→3.5 promotion is live in the
   * flip, not theoretical.
   */
  multiplierDisagreementRate: ChandelierAtrShadowRate;
}

function readingsFor(t: ChandelierAtrShadowTally): ChandelierAtrShadowReadings {
  const bothResolved = t.widthRatio.samples;
  return {
    dailyColdRate: rate(t.daily.coldSeries, t.observations, 'observations (ratchets with a pair)'),
    dailyHighBetaShare: rate(t.daily.highBeta, t.daily.resolved, 'daily.resolved (ratchets where the daily arm produced a width)'),
    shadow5mHighBetaShare: rate(t.shadow5m.highBeta, t.shadow5m.resolved, 'shadow5m.resolved'),
    meanWidthRatio: rate(t.widthRatio.sum, bothResolved, 'widthRatio.samples (ratchets where BOTH arms resolved)'),
    multiplierDisagreementRate: rate(t.multiplierDisagreements, bothResolved, 'widthRatio.samples (ratchets where BOTH arms resolved)'),
  };
}

/** One book's block: lifetime counts, today's counts, and the derived readings. */
export interface ChandelierAtrShadowBookBlock {
  /** Across every ET day this DATA_DIR's store holds. The accrual that matters. */
  lifetime: ChandelierAtrShadowTally;
  /** The CURRENT ET day only, from the live ledger (which is disk-seeded). */
  today: ChandelierAtrShadowTally;
  /** Derived over `lifetime`. */
  readings: ChandelierAtrShadowReadings;
  /** ET days with at least one observation — the unit of the accrual stop. */
  sessionsWithObservations: number;
  /** Those days, oldest first, with each day's observation count. */
  sessions: Array<{ etDay: string; observations: number; rowsSeen: number }>;
}

export interface ChandelierAtrShadowSummary {
  issue: 'TRA-5061';
  /** AC5 — see {@link CHANDELIER_ATR_SHADOW_EVIDENCE_CLASS}. */
  evidenceClass: typeof CHANDELIER_ATR_SHADOW_EVIDENCE_CLASS;
  notEvidenceFor: string;
  /** The arm that DECIDED, resolved from the flag by the caller. */
  decidedBy: ChandelierAtrTimeframeName;
  /**
   * ⚠ PER BOOK, never pooled (AC3). On 2026-10-02 the live book was flat AND
   * its exit hoist disarmed, so a pooled `n` would be entirely demo rows
   * answering a question asked about real money.
   */
  byBook: Record<ChandelierAtrShadowBook, ChandelierAtrShadowBookBlock>;
  /**
   * Both books folded. Published ONLY for the "did this branch ever resolve
   * ANYWHERE" read. ⛔ Do not quote a rate off this block — it blends two books
   * with different arming states.
   */
  all: ChandelierAtrShadowBookBlock;
  /** The durable store's own health. Read `armedAt` before believing any zero. */
  durable: {
    dataDir: string | null;
    ephemeral: boolean;
    lines: number;
    parsed: number;
    armedAt: number | null;
    cap: number;
    droppedAtCap: number;
    etDays: number;
  };
  sinceBootAt: number;
  /** QuantTrader's pre-registered decision thresholds, stated so a reader never re-derives them. */
  preRegistered: {
    abandonDailyFlipIfDailyColdRateAbove: number;
    bearCaseIfDailyColdRateAbove: number;
    unratifiedConstantIfDailyHighBetaShareAbove: number;
    abandonShadowIfObservationsBelow: number;
    overEtSessions: number;
  };
  note: string;
}

/**
 * The published census.
 *
 * `decidedBy` is passed in rather than resolved here so this module stays free
 * of the env: the caller already resolves the flag through
 * `resolveChandelierAtrTimeframe` for the rest of the payload, and resolving it
 * twice is how two fields on one route come to disagree.
 */
export function summarizeChandelierAtrShadow(
  decidedBy: ChandelierAtrTimeframeName,
  nowMs: number = Date.now(),
): ChandelierAtrShadowSummary {
  const durable = readChandelierAtrShadowDurable();
  const todayEtDay = etDateKey(nowMs);
  const live = chandelierAtrShadowLedgerSnapshot();

  const blockFor = (books: readonly ChandelierAtrShadowBook[]): ChandelierAtrShadowBookBlock => {
    // Lifetime comes from the STORE, and today's live counters are folded in on
    // top of the stored day only where the ledger is ahead of the last flush.
    // Taking the max per key rather than summing is what keeps the throttle
    // invisible: the live ledger is disk-seeded, so it is a SUPERSET of the
    // day's last stored snapshot, never a disjoint delta to be added.
    const perDay = new Map<string, ChandelierAtrShadowTally>();
    for (const d of durable.days) {
      if (!books.includes(d.book)) continue;
      perDay.set(`${d.etDay}|${d.book}`, d.counters);
    }
    for (const book of books) {
      for (const [key, tally] of live) {
        const [etDay, keyBook] = key.split('|');
        if (keyBook !== book || etDay === undefined) continue;
        const stored = perDay.get(key);
        // `rowsSeen` is monotonic within a (day, book), so the larger reading is
        // the later one.
        if (!stored || tally.rowsSeen >= stored.rowsSeen) perDay.set(key, tally);
      }
    }
    const all = [...perDay.entries()];
    const lifetime = foldChandelierAtrShadowTallies(all.map(([, t]) => t));
    const today = foldChandelierAtrShadowTallies(
      all.filter(([k]) => k.startsWith(`${todayEtDay}|`)).map(([, t]) => t),
    );
    const byEtDay = new Map<string, { observations: number; rowsSeen: number }>();
    for (const [key, t] of all) {
      const etDay = key.split('|')[0] as string;
      const prev = byEtDay.get(etDay) ?? { observations: 0, rowsSeen: 0 };
      byEtDay.set(etDay, {
        observations: prev.observations + t.observations,
        rowsSeen: prev.rowsSeen + t.rowsSeen,
      });
    }
    const sessions = [...byEtDay.entries()]
      .map(([etDay, v]) => ({ etDay, ...v }))
      .sort((a, b) => (a.etDay < b.etDay ? -1 : 1));
    return {
      lifetime,
      today,
      readings: readingsFor(lifetime),
      sessionsWithObservations: sessions.filter((s) => s.observations > 0).length,
      sessions,
    };
  };

  return {
    issue: 'TRA-5061',
    evidenceClass: CHANDELIER_ATR_SHADOW_EVIDENCE_CLASS,
    notEvidenceFor:
      'P&L, expectancy, crossedR, or ANY forward test. A shadow width is a counterfactual on a '
      + 'LEVEL: an exit that does not fire changes every subsequent tick of that position\'s path '
      + '(peak, give-back, hold and the eventual exit reason all move), so what a row would have '
      + 'EARNED under the other trail is not a function of anything observable on the factual path. '
      + 'Cost-aware crossedR over n >= 20 per side still needs REAL FILLS behind '
      + 'CHANDELIER_ATR_TIMEFRAME. Ratified in writing by QuantTrader on TRA-5061 (AC5) so this '
      + 'surface cannot later be cited as the forward test.',
    decidedBy,
    byBook: {
      live: blockFor(['live']),
      demo: blockFor(['demo']),
    },
    all: blockFor(CHANDELIER_ATR_SHADOW_BOOKS),
    durable: {
      dataDir: durable.dataDir,
      ephemeral: durable.ephemeral,
      lines: durable.lines,
      parsed: durable.parsed,
      armedAt: durable.armedAt,
      cap: durable.cap,
      droppedAtCap: durable.droppedAtCap,
      etDays: new Set(durable.days.map((d) => d.etDay)).size,
    },
    sinceBootAt: ledgerSinceBootAt,
    preRegistered: {
      abandonDailyFlipIfDailyColdRateAbove: 0.25,
      bearCaseIfDailyColdRateAbove: 0.15,
      unratifiedConstantIfDailyHighBetaShareAbove: 0.8,
      abandonShadowIfObservationsBelow: 20,
      overEtSessions: 10,
    },
    note:
      'TRA-5061 (parent TRA-4992). SIDE-BY-SIDE counterfactual: both the 5m and the daily '
      + 'chandelier ATR are resolved on every ratchet and BOTH widths published; only `decidedBy` '
      + 'sets the real level, so this instrument changes NO behaviour and needs NO arm. '
      + '⛔ READ `rowsSeen` FIRST: it is the eligible denominator (observations + pairAbsent + sum '
      + 'of rowsSkipped). rowsSeen 0 means the exit pass evaluated NO row, so every number here is '
      + 'a 0/0 and none of them is a reading about either trail — measured exactly that way on '
      + '2026-10-02, when every book was flat (live fleetAtRiskUsd 0 on all three, demo '
      + 'openPositionCount 0) and the LIVE exit hoist read disarmed with 0 of 3 engines armed. '
      + 'A ratchet needs an OPEN ROW, so the accrual carrier is whichever book is armed and holding '
      + 'single-leg directional rows — NOT "immediately" and NOT fleet-wide. '
      + '⛔ `readings.dailyColdRate` IS THE HEADLINE: it is the COUNTERFACTUAL no_daily_atr rate. '
      + 'While the flag is shadow_5m the producer refuses nothing, so the real census cell '
      + 'ratchets.skipped.no_daily_atr is a STRUCTURAL 0 and tells you nothing; this is its '
      + 'counterfactual on the same real rows. `readings.dailyHighBetaShare` is the 3.0/3.5 split '
      + 'on real options names — denominator daily.resolved, NOT observations. '
      + 'Every rate carries its own denominator and a `vacuous` flag; a null value means 0/0, never '
      + 'a measured zero. byBook is NEVER pooled (live is the disarmed/flat one); `all` is for the '
      + '"did it ever resolve anywhere" read only. '
      + 'DURABLE: counts are partitioned by ET day and written to a JSONL store that survives a '
      + 'restart, because a since-boot counter cannot accumulate a rate — this process booted after '
      + 'the prior close, which is why the live sessionCoverage already reads boot_after_close / '
      + 'vacuous (TRA-4343), and TRA-3926\'s boot-scoped census read 0 for 37 days after its '
      + 'subject shipped. ⛔ Read `durable.armedAt` before believing any zero: an empty store reads '
      + 'identically whether it watched ten sessions or was installed 90 seconds ago. '
      + '`durable.ephemeral: true` means this DATA_DIR does NOT survive a redeploy, so the durable '
      + 'half is not durable on this host. '
      + 'EVIDENCE CLASS reachability_only — see `notEvidenceFor`.',
  };
}
