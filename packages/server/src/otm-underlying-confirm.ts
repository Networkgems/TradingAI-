import type { Candle } from '@trading-app/shared';
import {
  emaPullbackTrigger,
  volumeConfirmedBreakout,
  type EmaPullbackResult,
  type SwingSide,
  type VolumeBreakoutResult,
} from '@trading-app/engine';

/**
 * TRA-4639 (parent TRA-4413, item A) — SHADOW evaluation of the two shipped-
 * but-off underlying-confirmation archetypes (TRA-1028's EMA pullback and
 * volume-confirmed breakout) ON THE OTM NOMINEE POPULATION.
 *
 * ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
 * The swing spec ranks underlying directional setup ABOVE RV dislocation and
 * absolute mispricing; the live sleeve runs that inverted (TRA-3942: 15 of 17
 * live entries were gap-ranked, filling 13:35-13:51Z, because the overnight gap
 * is the largest mispricing print on the chain). The two confirmation
 * archetypes sit built and dark behind `ENABLE_OPTION_EMA_PULLBACK` /
 * `ENABLE_OPTION_VOLUME_BREAKOUT` — but those flags gate the RV-LONG and
 * high-IVR SPREAD paths, and each is inert unless `ENABLE_OPTION_EXEC_SELECTOR`
 * is also on. NEITHER touches the OTM sleeve, which is where the misranked
 * entries actually happen. This module asks the measurable question first:
 * on the nominees the OTM ranker actually surfaces, how often would each
 * archetype have confirmed vs refused — and for which reason?
 *
 * ── WHAT IT IS NOT ───────────────────────────────────────────────────────────
 *   • NOT a gate. It never refuses anything, in any mode. There is no enforce
 *     arm in this module at all — an enforce flip is a separate board decision
 *     with its own placement analysis (an enforcing gate above `entry_window`
 *     would eat that gate's denominator; see `otmSetupTaxonomyDecision`).
 *   • NOT a composite score and NOT a threshold. TRA-3392 §6: thresholds are
 *     pre-registered, not picked. This publishes the two archetypes' verdicts
 *     SEPARATELY, with reason codes, and nothing folds them into a number.
 *
 * ── DENOMINATOR (the issue's "check before minting a second one") ────────────
 * The call site is INSIDE `otmSetupTaxonomyDecision`, immediately beside the
 * `setup_confirmation` recorder, reading the SAME `readOtmDailySeries` bars for
 * the SAME nominee. So over one process's own evaluations, `evaluated` here
 * tracks the `setup_confirmation` seam call-for-call BY CONSTRUCTION — no
 * second population was minted. It is still published as its own counter
 * because (a) the live-enforce ledger retains `reasonCode` only on BLOCKS, and
 * an observe-only instrument blocks nothing, so its refusal histogram cannot
 * live there; and (b) that ledger is disk-hydrated across builds while these
 * counters are SINCE-BOOT — the two are only comparable over rows one process
 * wrote (the `crossCheck.comparable` lesson, TRA-4422 Finding 2).
 *
 * ── FLAG ─────────────────────────────────────────────────────────────────────
 * `ENABLE_OTM_UNDERLYING_CONFIRM_SHADOW`, default OFF, STANDALONE. Deliberately
 * NOT layered on `ENABLE_OPTION_EXEC_SELECTOR`: that AND-shape belongs to the
 * RV exec path the TRA-1028 flags gate. Requiring the exec flag here would mean
 * arming this observer also arms the exec-path selector — a capital-adjacent
 * side effect an instrument must not carry.
 */

export const OTM_UNDERLYING_CONFIRM_SHADOW_FLAG = 'ENABLE_OTM_UNDERLYING_CONFIRM_SHADOW';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** True iff the shadow evaluation records. Standalone — see the module block. */
export function isOtmUnderlyingConfirmShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OTM_UNDERLYING_CONFIRM_SHADOW_FLAG]);
}

// ─── Reason codes ────────────────────────────────────────────────────────────
// Low-cardinality, per archetype, following the `otm-contract-floor.ts`
// pattern: every refusal names WHICH leg refused, so "would have blocked 80%"
// is decomposable into "trend was misaligned" vs "no pullback printed" —
// different remedies, different spec conversations.
//
// `*_series_unreadable` is DISTINCT from `*_insufficient_series` on purpose:
// a cold/stale daily cache (the feed's defect) must never launder into "the
// series was too short for the 21 EMA" (the symbol's property). Same split
// TRA-4424 built into the taxonomy's `series_unreadable`.

export const OTM_EMA_PULLBACK_CODES = [
  'ema_confirmed',
  'ema_series_unreadable',
  'ema_insufficient_series',
  'ema_trend_misaligned',
  'ema_no_pullback',
  'ema_no_reversal',
] as const;
export type OtmEmaPullbackCode = (typeof OTM_EMA_PULLBACK_CODES)[number];

export const OTM_VOLUME_BREAKOUT_CODES = [
  'vb_confirmed',
  'vb_series_unreadable',
  'vb_insufficient_series',
  'vb_no_channel_break',
  'vb_volume_unconfirmed',
] as const;
export type OtmVolumeBreakoutCode = (typeof OTM_VOLUME_BREAKOUT_CODES)[number];

export interface OtmUnderlyingConfirmVerdict {
  readonly symbol: string;
  readonly side: SwingSide;
  /** Bars the evaluation saw (0 on an unreadable series). */
  readonly bars: number;
  readonly ema: { readonly confirmed: boolean; readonly code: OtmEmaPullbackCode };
  readonly volume: { readonly confirmed: boolean; readonly code: OtmVolumeBreakoutCode };
}

/** Classify an EMA-pullback result into the code vocabulary. Exported for the retro script. */
export function classifyEmaPullback(r: EmaPullbackResult): OtmEmaPullbackCode {
  if (r.fired) return 'ema_confirmed';
  // `ema21 === null` covers both "too few bars for the 21 EMA" and "EMA not
  // finite" — the trigger returns before computing structure in either case.
  if (r.ema21 === null) return 'ema_insufficient_series';
  if (!r.trendOk) return 'ema_trend_misaligned';
  if (!r.pulledBack) return 'ema_no_pullback';
  return 'ema_no_reversal';
}

/** Classify a volume-breakout result into the code vocabulary. Exported for the retro script. */
export function classifyVolumeBreakout(r: VolumeBreakoutResult): OtmVolumeBreakoutCode {
  if (r.fired) return 'vb_confirmed';
  if (r.channel === null) return 'vb_insufficient_series';
  if (!r.breakout) return 'vb_no_channel_break';
  // Covers both "insufficient bars for the volume benchmark" and "breakout on
  // below-average volume": the channel broke, the volume leg did not confirm.
  return 'vb_volume_unconfirmed';
}

/**
 * Score one nominee's underlying against BOTH archetypes. Pure: candles in,
 * verdicts out. `seriesReadable: false` (a cold/stale daily cache) stamps the
 * unreadable code without running the triggers — an empty array would otherwise
 * read as `ema_insufficient_series`, which blames the symbol for the feed.
 */
export function evaluateOtmUnderlyingConfirm(
  symbol: string,
  side: SwingSide,
  series: readonly Candle[],
  seriesReadable: boolean,
): OtmUnderlyingConfirmVerdict {
  if (!seriesReadable || series.length === 0) {
    return {
      symbol,
      side,
      bars: series.length,
      ema: { confirmed: false, code: 'ema_series_unreadable' },
      volume: { confirmed: false, code: 'vb_series_unreadable' },
    };
  }
  const bars = [...series];
  const ema = emaPullbackTrigger(bars, side);
  const vb = volumeConfirmedBreakout(bars, side);
  return {
    symbol,
    side,
    bars: bars.length,
    ema: { confirmed: ema.fired, code: classifyEmaPullback(ema) },
    volume: { confirmed: vb.fired, code: classifyVolumeBreakout(vb) },
  };
}

// ─── Counters ────────────────────────────────────────────────────────────────
// SINCE-BOOT, in-memory, keyed by book class. Not disk-hydrated on purpose:
// hydration is what makes the `setup_confirmation` cross-build fold lie on
// deploy day (TRA-4422 Finding 2), and a shadow instrument's job is to be
// trivially attributable to the build that wrote it.

export type OtmUnderlyingConfirmBook = 'live' | 'demo';

interface BookCounters {
  evaluated: number;
  byEma: Record<OtmEmaPullbackCode, number>;
  byVb: Record<OtmVolumeBreakoutCode, number>;
  /** Both archetypes confirmed on the same nominee — the strict-AND read. */
  bothConfirmed: number;
  /** At least one archetype confirmed — the permissive-OR read. */
  eitherConfirmed: number;
  lastEvaluatedAt: number | null;
  lastSymbol: string | null;
}

function emptyBook(): BookCounters {
  const byEma = Object.fromEntries(OTM_EMA_PULLBACK_CODES.map((c) => [c, 0])) as Record<
    OtmEmaPullbackCode,
    number
  >;
  const byVb = Object.fromEntries(OTM_VOLUME_BREAKOUT_CODES.map((c) => [c, 0])) as Record<
    OtmVolumeBreakoutCode,
    number
  >;
  return {
    evaluated: 0,
    byEma,
    byVb,
    bothConfirmed: 0,
    eitherConfirmed: 0,
    lastEvaluatedAt: null,
    lastSymbol: null,
  };
}

let counters: Record<OtmUnderlyingConfirmBook, BookCounters> = {
  live: emptyBook(),
  demo: emptyBook(),
};
let sinceMs = Date.now();

/** Test seam. */
export function resetOtmUnderlyingConfirmCountersForTest(): void {
  counters = { live: emptyBook(), demo: emptyBook() };
  sinceMs = Date.now();
}

/** Fold one verdict into the counters. Called by the seam, never by a route. */
export function recordOtmUnderlyingConfirm(
  book: OtmUnderlyingConfirmBook,
  verdict: OtmUnderlyingConfirmVerdict,
  nowMs: number = Date.now(),
): void {
  const c = counters[book];
  c.evaluated += 1;
  c.byEma[verdict.ema.code] += 1;
  c.byVb[verdict.volume.code] += 1;
  if (verdict.ema.confirmed && verdict.volume.confirmed) c.bothConfirmed += 1;
  if (verdict.ema.confirmed || verdict.volume.confirmed) c.eitherConfirmed += 1;
  c.lastEvaluatedAt = nowMs;
  c.lastSymbol = verdict.symbol;
}

/** Dense rows over a code vocabulary — absent is not zero (TRA-4154 trap). */
function denseRows<C extends string>(
  vocabulary: readonly C[],
  by: Record<C, number>,
  evaluated: number,
): { code: C; count: number; share: number | null }[] {
  return vocabulary.map((code) => ({
    code,
    count: by[code],
    share: evaluated > 0 ? by[code] / evaluated : null,
  }));
}

export interface OtmUnderlyingConfirmHealth {
  readonly flag: string;
  readonly enabled: boolean;
  /** The raw env string, so a typo'd arm attempt is visible (UNKNOWN IS NOT OFF). */
  readonly raw: string | null;
  /** ⚠️ SINCE-BOOT. A restart zeroes every count below. */
  readonly sinceMs: number;
  readonly books: Record<
    OtmUnderlyingConfirmBook,
    {
      evaluated: number;
      emaPullback: { code: OtmEmaPullbackCode; count: number; share: number | null }[];
      volumeBreakout: { code: OtmVolumeBreakoutCode; count: number; share: number | null }[];
      bothConfirmed: number;
      eitherConfirmed: number;
      lastEvaluatedAt: string | null;
      lastSymbol: string | null;
    }
  >;
  readonly note: string;
}

export function otmUnderlyingConfirmHealth(
  env: NodeJS.ProcessEnv = process.env,
): OtmUnderlyingConfirmHealth {
  const raw = env[OTM_UNDERLYING_CONFIRM_SHADOW_FLAG];
  const enabled = isOtmUnderlyingConfirmShadowEnabled(env);
  const book = (b: OtmUnderlyingConfirmBook) => {
    const c = counters[b];
    return {
      evaluated: c.evaluated,
      emaPullback: denseRows(OTM_EMA_PULLBACK_CODES, c.byEma, c.evaluated),
      volumeBreakout: denseRows(OTM_VOLUME_BREAKOUT_CODES, c.byVb, c.evaluated),
      bothConfirmed: c.bothConfirmed,
      eitherConfirmed: c.eitherConfirmed,
      lastEvaluatedAt: c.lastEvaluatedAt === null ? null : new Date(c.lastEvaluatedAt).toISOString(),
      lastSymbol: c.lastSymbol,
    };
  };
  return {
    flag: OTM_UNDERLYING_CONFIRM_SHADOW_FLAG,
    enabled,
    raw: raw ?? null,
    sinceMs,
    books: { live: book('live'), demo: book('demo') },
    note: enabled
      ? 'SHADOW ONLY: verdicts are recorded on the OTM nominee population (the setup_confirmation '
        + 'seam) and NOTHING is refused. `evaluated` here tracks setup_confirmation call-for-call '
        + 'over this process\'s own rows; that ledger is disk-hydrated and this one is since-boot, '
        + 'so compare only rows one process wrote. A confirmed share near zero is a REAL measurement '
        + 'only when evaluated > 0 — an off flag and an unreached seam both read 0/0.'
      : `DARK: set ${OTM_UNDERLYING_CONFIRM_SHADOW_FLAG}=1 to record. Counters below are structurally `
        + 'zero — this is the shipped-but-unarmed default (TRA-4639 deliverable 1), not a clean bill.',
  };
}
