/**
 * TRA-3943 (parent TRA-3927, board card `a29b2db8` accepted 2026-08-22T04:18Z) —
 * the `single_leg_otm` sleeve's INTRADAY stop, and the release that makes it
 * reach the broker on day one.
 *
 * ## The defect this is the remedy for (finding F4)
 *
 * `liveStopPolicy: daily_close` (TRA-3902 ruling B) reads the −20% premium stop
 * only inside the last 30 minutes of RTH, and `holdLiveOptionsOvernightForPdt`
 * (TRA-483) refuses EVERY engine exit on a live row opened today. Composed, a
 * day-one entry has no stop at all until the NEXT session's close window —
 * `liveDayOneStopPosture.stopBasis: 'full_premium'` (TRA-3892) is that fact
 * published. The tape: losers ran to −45…−75% (AMZN put −$189, SPY −$156,
 * PLTR −$115, BAC −$74) while winners were cut at the next open.
 *
 * ## The rule
 *
 * On this sleeve, and on every day of the position's life including day one, the
 * stop fires INTRADAY on the exit cadence when EITHER leg is through:
 *
 *   • **premium** — `mark ≤ premiumPaid × (1 − premiumStopPct)`, default −35%;
 *   • **ATR** — the underlying has traded through
 *     {@link OptionPosition.otmAtrInvalidationLevel} (`underlyingEntryPrice ∓
 *     atrMult × ATR(14, daily)`, stamped at entry) on the WRONG side of entry.
 *
 * `daily_close` survives as a BACKSTOP below this: −20% at the close window and
 * −50% catastrophic intraday still fire on rows this rule declines.
 *
 * ## Why the two legs are OR and not AND
 *
 * They fail in different worlds. A gap or an IV crush shows up in the premium
 * first and may never touch the spot level; a slow grind against the thesis
 * takes the spot out while theta has not yet eaten 35% of a longer-dated
 * contract. Requiring both is the −45…−75% tape again with more steps.
 *
 * ## Fail directions, each one deliberate
 *
 *   • the RULE is armed by default and only the exact token `off` disarms it —
 *     a garbage env resolves ARMED with `source: 'env_invalid'`, so a typo is
 *     visible on the wire instead of silently restoring the decorative stop
 *     (the same discipline as `resolveOtmSleeveExitRule`, TRA-3941);
 *   • the ATR leg is INERT without a stamped level. It is never derived from a
 *     defaulted anchor: `underlyingEntryPrice` is a hard `0` on every
 *     `tradier_import` row, and `0 + 1×ATR` makes `spot ≥ level` ALWAYS TRUE for
 *     a put — the TRA-2893 fail-open, which force-exited every imported put and
 *     journalled it as a legitimate trail;
 *   • the day-one RELEASE fails CLOSED. A stop that cannot legally fire is the
 *     status quo; a same-day round trip on a margin account with no day-trade
 *     capacity is a compliance event. An unreadable account type therefore HOLDS
 *     and says why, rather than releasing on an assumption.
 *
 * ## Scope
 *
 * `single_leg_otm` only ({@link isOtmSleeveRow}). RV and directional rows are
 * byte-identical. Nothing here reads the real-money arm, the row size or the
 * 2-row cap — asserted by an absence test over this file's own source, which is
 * why those identifiers are named nowhere in it.
 */

import type { TradierAccountBalance } from '@trading-app/engine';

/**
 * What `/api/health/options-live` `liveDayOneStopPosture.stopBasis` reads for a
 * sleeve this rule governs — the AC2 token, distinct from TRA-3892's
 * `full_premium`.
 */
export const OTM_DAY_ONE_STOP_BASIS = 'premium_pct_or_atr' as const;
export type OtmDayOneStopBasis = typeof OTM_DAY_ONE_STOP_BASIS;

export const OTM_DAY_ONE_STOP_VALUE = 'OTM_DAY_ONE_STOP';
export const OTM_DAY_ONE_STOP_PREMIUM_PCT_VALUE = 'OTM_DAY_ONE_STOP_PREMIUM_PCT';
export const OTM_DAY_ONE_STOP_ATR_MULT_VALUE = 'OTM_DAY_ONE_STOP_ATR_MULT';

/** Board default: fire at −35% of entry premium (mark ≤ 65% of entry). */
export const OTM_DAY_ONE_STOP_PREMIUM_PCT_DEFAULT = 0.35;
/** Board default: 1 × ATR(14, daily) from the entry spot. */
export const OTM_DAY_ONE_STOP_ATR_MULT_DEFAULT = 1;

/** The resolved rule. `source` is the honesty field — see the module docblock. */
export interface OtmDayOneStopRule {
  /** `false` only when someone spelled `OTM_DAY_ONE_STOP=off` exactly. */
  armed: boolean;
  /** Fraction of entry premium lost at which the premium leg fires. */
  premiumStopPct: number;
  /** `1 − premiumStopPct`. Published so the wire carries the level, not just the loss. */
  markFloorRatio: number;
  /** ATR multiple for the spot invalidation level. */
  atrMult: number;
  source: 'default' | 'env' | 'env_invalid';
}

function parseBounded(raw: string | undefined, lo: number, hi: number): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const v = Number(raw.trim());
  // `!(v > lo)` rather than `v <= lo`: `NaN` must land in the REFUSED branch,
  // and `NaN <= lo` is false (TRA-3486).
  if (!Number.isFinite(v) || !(v > lo) || !(v <= hi)) return Number.NaN;
  return v;
}

/**
 * Resolve the effective rule (TRA-3943).
 *
 * Every knob is bounded, and an out-of-bounds or unparseable value resolves to
 * the BOARD DEFAULT with `source: 'env_invalid'` — never to "no stop". A
 * `premiumStopPct` of 0 or 1 is "never fire" and "fire at zero premium"
 * respectively, which are both this rule spelled as its own absence.
 */
export function resolveOtmDayOneStopRule(
  env: NodeJS.ProcessEnv = process.env,
): OtmDayOneStopRule {
  let source: OtmDayOneStopRule['source'] = 'default';

  const rawArm = env[OTM_DAY_ONE_STOP_VALUE];
  let armed = true;
  if (typeof rawArm === 'string' && rawArm.trim() !== '') {
    const token = rawArm.trim().toLowerCase();
    if (token === 'off') { armed = false; source = 'env'; }
    else if (token === 'on') { source = 'env'; }
    else source = 'env_invalid';
  }

  const rawPct = parseBounded(env[OTM_DAY_ONE_STOP_PREMIUM_PCT_VALUE], 0, 0.99);
  let premiumStopPct = OTM_DAY_ONE_STOP_PREMIUM_PCT_DEFAULT;
  if (rawPct !== null) {
    if (Number.isNaN(rawPct)) source = 'env_invalid';
    else { premiumStopPct = rawPct; if (source === 'default') source = 'env'; }
  }

  const rawMult = parseBounded(env[OTM_DAY_ONE_STOP_ATR_MULT_VALUE], 0, 10);
  let atrMult = OTM_DAY_ONE_STOP_ATR_MULT_DEFAULT;
  if (rawMult !== null) {
    if (Number.isNaN(rawMult)) source = 'env_invalid';
    else { atrMult = rawMult; if (source === 'default') source = 'env'; }
  }

  return {
    armed,
    premiumStopPct,
    markFloorRatio: 1 - premiumStopPct,
    atrMult,
    source,
  };
}

/**
 * TRA-3943 — the day-one RELEASE of the TRA-483 PDT overnight hold, scoped to
 * this stop and to risk-REDUCING intent only.
 *
 * TRA-3892's ruling 4 named this shape and only this shape: "a capacity-aware,
 * risk-reducing-only release of `holdLiveOptionsOvernightForPdt` — sl/trail
 * through while day-trade capacity > 0, never tp". Nothing else in the exit
 * cascade is released; take-profit, TP1 and the trail stay held on day one.
 *
 * Capacity, in the order the broker actually constrains us:
 *
 *   • **cash account** — PDT is a MARGIN rule (FINRA 4210). A cash account has
 *     no day-trade counter to burn, and selling a long option you bought today
 *     is not free-riding (that is about BUYING with unsettled proceeds). The
 *     production account ***0154 is `cash`, which is why this is the live path.
 *   • **day-trade buying power > 0** — a margin/PDT account with room.
 *   • anything else HOLDS, including an unreadable balance snapshot.
 */
export type OtmDayOneStopReleaseReason =
  /** Cash account — no PDT bucket exists to burn. Released. */
  | 'cash_account'
  /** Margin/PDT account reporting positive DTBP. Released. */
  | 'day_trade_capacity'
  /** Margin/PDT account whose DTBP is exhausted — the broker would reject. Held. */
  | 'dtbp_exhausted'
  /** No usable balance snapshot, or an account type Tradier did not classify. Held. */
  | 'capacity_unreadable';

export interface OtmDayOneStopRelease {
  released: boolean;
  reason: OtmDayOneStopReleaseReason;
  accountType: string | null;
  dayTradeBuyingPowerUsd: number | null;
}

/**
 * Resolve the release from the live broker balance snapshot (TRA-3943).
 *
 * `null` balance ⇒ HELD (`capacity_unreadable`). The snapshot is dropped
 * whenever it goes stale (`TRADIER_BALANCE_STALE_MS`), so "we have not heard
 * from the broker recently" must not authorise a same-day round trip.
 */
export function resolveOtmDayOneStopRelease(
  balance: Pick<TradierAccountBalance, 'accountType' | 'dayTradeBuyingPower'> | null | undefined,
): OtmDayOneStopRelease {
  if (!balance) {
    return {
      released: false,
      reason: 'capacity_unreadable',
      accountType: null,
      dayTradeBuyingPowerUsd: null,
    };
  }
  const accountType = balance.accountType ?? null;
  const dtbp = typeof balance.dayTradeBuyingPower === 'number'
    && Number.isFinite(balance.dayTradeBuyingPower)
    ? balance.dayTradeBuyingPower
    : null;
  if (accountType === 'cash') {
    return { released: true, reason: 'cash_account', accountType, dayTradeBuyingPowerUsd: dtbp };
  }
  // `dtbp > 0` and not `!(dtbp <= 0)`: a null/NaN DTBP on a NON-cash account is
  // exactly the state we refuse to guess on, and it must not ride the positive
  // branch (TRA-3486, the other direction).
  if (dtbp !== null && dtbp > 0) {
    return { released: true, reason: 'day_trade_capacity', accountType, dayTradeBuyingPowerUsd: dtbp };
  }
  if (dtbp !== null) {
    return { released: false, reason: 'dtbp_exhausted', accountType, dayTradeBuyingPowerUsd: dtbp };
  }
  return { released: false, reason: 'capacity_unreadable', accountType, dayTradeBuyingPowerUsd: null };
}

/** Which leg fired. Becomes the journal `exit_reason`, so the tape can separate them. */
export type OtmDayOneStopTrigger = 'premium_pct' | 'atr_invalidation';

/** TRA-3943 — the journal reasons this rule mints. Never `sl` bare. */
export const OTM_DAY_ONE_STOP_JOURNAL_REASON: Record<OtmDayOneStopTrigger, string> = {
  premium_pct: 'sl_otm_premium_pct',
  atr_invalidation: 'sl_otm_atr_invalidation',
};

/** The row fields the verdict reads. Structural, so a test needs no `OptionPosition`. */
export interface OtmDayOneStopSubject {
  premiumPaid: number;
  optionType: 'call' | 'put';
  /** TRA-3943 — the entry-stamped level. Absent ⇒ the ATR leg is inert. */
  otmAtrInvalidationLevel?: number;
}

export interface OtmDayOneStopVerdict {
  fires: boolean;
  trigger: OtmDayOneStopTrigger | null;
  /** `premiumPaid × markFloorRatio`, or `null` when the premium leg cannot be evaluated. */
  markFloor: number | null;
  /** The level the ATR leg read, or `null` when that leg is inert on this row. */
  atrLevel: number | null;
  /** True when the row carries no usable ATR level — the countable blindness. */
  atrLegInert: boolean;
}

/**
 * TRA-3943 — evaluate both legs against one tick. PURE: no clock, no env, no
 * account. `checkExits` owns the scope (`isOtmSleeveRow`), the suppressions and
 * the order staging; this owns only "is the thesis dead".
 *
 * Precedence when both are through is `premium_pct`, because that is the leg
 * the loss is actually denominated in and the one AC3 grades.
 */
export function otmDayOneStopVerdict(
  subject: OtmDayOneStopSubject,
  ctx: { mark: number; underlyingSpot: number | undefined; rule: OtmDayOneStopRule },
): OtmDayOneStopVerdict {
  const { rule } = ctx;
  const premiumUsable = Number.isFinite(subject.premiumPaid) && subject.premiumPaid > 0;
  const markFloor = premiumUsable ? subject.premiumPaid * rule.markFloorRatio : null;
  const level = Number.isFinite(subject.otmAtrInvalidationLevel ?? Number.NaN)
    && (subject.otmAtrInvalidationLevel as number) > 0
    ? (subject.otmAtrInvalidationLevel as number)
    : null;
  const base: OtmDayOneStopVerdict = {
    fires: false,
    trigger: null,
    markFloor,
    atrLevel: level,
    atrLegInert: level === null,
  };
  if (!rule.armed) return base;

  // A non-finite mark is a dark feed, not a low reading (TRA-3440): `mark <=
  // floor` must not admit `NaN` into the firing branch.
  if (markFloor !== null && Number.isFinite(ctx.mark) && ctx.mark > 0 && ctx.mark <= markFloor) {
    return { ...base, fires: true, trigger: 'premium_pct' };
  }

  const spot = ctx.underlyingSpot;
  if (level !== null && spot !== undefined && Number.isFinite(spot) && spot > 0) {
    const through = subject.optionType === 'call' ? spot <= level : spot >= level;
    if (through) return { ...base, fires: true, trigger: 'atr_invalidation' };
  }
  return base;
}

/**
 * TRA-3943 — the entry-time level, or `null` when it cannot be honestly derived.
 *
 * `null` is the whole guard against TRA-2893: a `0`/absent/non-finite entry
 * anchor or a non-positive ATR yields NO level, and a row with no level has an
 * inert ATR leg rather than one that fires on every tick.
 */
export function otmAtrInvalidationLevel(args: {
  optionType: 'call' | 'put';
  underlyingEntryPrice: number | undefined;
  atrDaily: number | undefined;
  atrMult: number;
}): number | null {
  const anchor = args.underlyingEntryPrice;
  const atr = args.atrDaily;
  if (anchor === undefined || !Number.isFinite(anchor) || !(anchor > 0)) return null;
  if (atr === undefined || !Number.isFinite(atr) || !(atr > 0)) return null;
  if (!Number.isFinite(args.atrMult) || !(args.atrMult > 0)) return null;
  const dist = atr * args.atrMult;
  const level = args.optionType === 'call' ? anchor - dist : anchor + dist;
  // A call whose 1×ATR band reaches through zero has no usable level either —
  // `spot <= 0` is unreachable, so publishing it would claim a leg that cannot
  // fire. Say inert instead.
  if (!Number.isFinite(level) || !(level > 0)) return null;
  return level;
}
