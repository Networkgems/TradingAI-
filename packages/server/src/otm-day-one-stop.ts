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
 *   • TRA-3981 — the PREMIUM leg is INERT without a FILL-GRADE anchor, for the
 *     same reason one field over. `premiumPaid` on an adopted row can be a
 *     `residual_identity` RESTATEMENT rather than a fill, and an under-stated
 *     basis lowers the floor: the live `RIG260925C00006000` desk lot resolved
 *     `0.143` where its sibling's fill gives `0.2145`, i.e. a −35% stop
 *     declining until −57%. See {@link OtmStopPremiumBasisSource};
 *   • TRA-3981 — a row with BOTH legs inert is NOT GOVERNED and does not read as
 *     governed ({@link otmDayOneStopGovernance}). It keeps the pre-existing
 *     cascade rather than a stop anchored on a number of unknown provenance;
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

/**
 * TRA-3981 — WHERE this row's `premiumPaid` came from, which is a different
 * question from what it says.
 *
 * The premium leg is `mark ≤ premiumPaid × markFloorRatio`, so the anchor IS the
 * stop. On an engine-opened row `premiumPaid` is the price we paid and the two
 * questions collapse. On an ADOPTED row they do not:
 *
 *   • `entry_fill` — this process opened the row and wrote its own fill.
 *   • `desk_capture_fill` — a `desk_add` lot priced off the desk's OWN filled
 *     `buy_to_open`, by order id, out of the TRA-3939 capture store
 *     (`deskAddBasis.source === 'capture_fill'`). We did not place it, but we
 *     read the fill. Fill-grade.
 *   • `restated_residual` — `deskAddBasis.source === 'residual_identity'`:
 *     `broker_cost − engine_recorded_cost` over the residual contracts. A
 *     DERIVED figure, and by its own field doc "exact while the engine sibling
 *     is open; its evidence EXPIRES when that sibling closes". Not a fill.
 *   • `adopted_unstamped` — `importedFromTradier` with no `deskAddBasis` at all:
 *     the reconcile installed the broker's cost basis, which on a multi-lot
 *     symbol is an AVERAGE no lot ever traded at (`live-lot-adoption.ts`'s
 *     `engine_side_zero` makes the same point: BAC's blend was 1.41 and neither
 *     lot traded there). Not a fill.
 *
 * ## Why the distinction is a SAFETY one and not bookkeeping
 *
 * The sign of a basis error is the sign of the stop error. An UNDER-stated basis
 * lowers the floor and the stop fires LATE — permissive. An OVER-stated one
 * fires early and sells a live position on a number nobody paid. Measured on
 * bqb1 2026-08-24T16:24Z: row `96b0dc72` `RIG260925C00006000`, `premiumPaid`
 * `0.22` from a `residual_identity` stamped 14:47:02Z, against the engine
 * sibling's `0.33` fill — floor `0.143` instead of `0.2145`, i.e. the −35% stop
 * declining until −57%. `isOtmSleeveRow()` admits that row, so the rule GOVERNED
 * a basis it did not set.
 *
 * So the premium leg anchors on a FILL-GRADE basis only. On anything else it is
 * INERT and counted, never evaluated against a number of unknown provenance —
 * the same fail-closed shape the ATR leg already has for a missing anchor.
 */
export type OtmStopPremiumBasisSource =
  | 'entry_fill'
  | 'desk_capture_fill'
  | 'restated_residual'
  | 'adopted_unstamped';

/** The provenance fields {@link resolveOtmStopPremiumBasis} reads. Structural. */
export interface OtmStopBasisRow {
  premiumPaid: number;
  /** TRA-3553 — the Tradier reconcile adopted this row rather than opening it. */
  importedFromTradier?: boolean;
  /** TRA-3960 — a `desk_add` lot's basis stamp. Absent ⇒ no stamp exists. */
  deskAddBasis?: { source: 'capture_fill' | 'residual_identity' };
}

export interface OtmStopPremiumBasis {
  source: OtmStopPremiumBasisSource;
  /** Did THIS process observe the fill behind the number? Provenance only. */
  fillGrade: boolean;
  /** The number the premium leg may anchor on. `null` ⇔ not fill-grade, or unusable. */
  premiumBasisUsd: number | null;
  /** The row's own `premiumPaid` whatever its provenance, so a reader can see both. */
  rowPremiumPaid: number;
}

/**
 * TRA-3981 — classify a row's premium anchor. PURE. No env, no clock, no I/O.
 *
 * Fill-grade is defined POSITIVELY ("we saw the fill"), never by enumerating the
 * adoption shapes that are not: a shape nobody has written yet must land in the
 * REFUSED branch, not inherit the permissive one.
 */
export function resolveOtmStopPremiumBasis(row: OtmStopBasisRow): OtmStopPremiumBasis {
  const stamped = row.deskAddBasis?.source;
  const source: OtmStopPremiumBasisSource =
    stamped === 'capture_fill' ? 'desk_capture_fill'
      : stamped === 'residual_identity' ? 'restated_residual'
        : row.importedFromTradier === true ? 'adopted_unstamped'
          : 'entry_fill';
  const fillGrade = source === 'entry_fill' || source === 'desk_capture_fill';
  // `!(x > 0)` and not `x <= 0`, so a `NaN` premium refuses (TRA-3486).
  const usable = Number.isFinite(row.premiumPaid) && row.premiumPaid > 0;
  return {
    source,
    fillGrade,
    premiumBasisUsd: fillGrade && usable ? row.premiumPaid : null,
    rowPremiumPaid: row.premiumPaid,
  };
}

/** The row fields the verdict reads. Structural, so a test needs no `OptionPosition`. */
export interface OtmDayOneStopSubject extends OtmStopBasisRow {
  optionType: 'call' | 'put';
  /** TRA-3943 — the entry-stamped level. Absent ⇒ the ATR leg is inert. */
  otmAtrInvalidationLevel?: number;
}

/**
 * TRA-3981 — which of the two legs this row can actually be evaluated on, and
 * therefore whether the rule GOVERNS it at all.
 *
 * Split out of {@link otmDayOneStopVerdict} because the two READERS
 * (`summarizeDayOneStopPosture`, `summarizeLiveStopActionability`) have to ask
 * "is this row governed" with no mark and no spot in hand, and a
 * re-implementation on their side would drift from the gate it claims to
 * predict — the TRA-3829 discipline the actionability walk already cites.
 */
export interface OtmDayOneStopGovernance {
  /** Armed, and at least one leg can be evaluated on this row. */
  governs: boolean;
  reason: 'governed' | 'rule_disarmed' | 'both_legs_inert';
  premiumBasis: OtmStopPremiumBasis;
  /** `premiumBasisUsd × markFloorRatio`, or `null` when the premium leg is inert. */
  markFloor: number | null;
  /** True when no fill-grade anchor exists — the countable blindness (TRA-3981). */
  premiumLegInert: boolean;
  /** The level the ATR leg would read, or `null` when that leg is inert. */
  atrLevel: number | null;
  /** True when the row carries no usable ATR level — the countable blindness. */
  atrLegInert: boolean;
}

export function otmDayOneStopGovernance(
  subject: OtmDayOneStopSubject,
  rule: OtmDayOneStopRule,
): OtmDayOneStopGovernance {
  const premiumBasis = resolveOtmStopPremiumBasis(subject);
  const markFloor = premiumBasis.premiumBasisUsd === null
    ? null
    : premiumBasis.premiumBasisUsd * rule.markFloorRatio;
  const atrLevel = Number.isFinite(subject.otmAtrInvalidationLevel ?? Number.NaN)
    && (subject.otmAtrInvalidationLevel as number) > 0
    ? (subject.otmAtrInvalidationLevel as number)
    : null;
  const premiumLegInert = markFloor === null;
  const atrLegInert = atrLevel === null;
  // TRA-3981 AC3, posture (b): a row with NO fill-grade basis and NO stamped
  // spot level has no leg to be evaluated on, so the rule does not claim it and
  // must not READ as claiming it. It falls through to the pre-existing cascade
  // (`stopLossPremium`, the `daily_close` −20% backstop and the −50%
  // catastrophic), which is the posture such a row was already on before this
  // sleeve had a day-one lever.
  //
  // Posture (a) — stamping the ATR level at adoption from a historical spot
  // oracle — is NOT taken here and is not a silent omission: the live rows carry
  // `underlyingEntryUnknownReason: 'no_spot_oracle'`, i.e. no resolver is wired
  // in at all, and inventing one inside an exit rule is how a defaulted anchor
  // gets born (TRA-2893). It is a separate change with its own evidence.
  const governs = rule.armed && !(premiumLegInert && atrLegInert);
  return {
    governs,
    reason: !rule.armed ? 'rule_disarmed' : governs ? 'governed' : 'both_legs_inert',
    premiumBasis,
    markFloor,
    premiumLegInert,
    atrLevel,
    atrLegInert,
  };
}

export interface OtmDayOneStopVerdict {
  fires: boolean;
  trigger: OtmDayOneStopTrigger | null;
  /** `premiumBasisUsd × markFloorRatio`, or `null` when the premium leg cannot be evaluated. */
  markFloor: number | null;
  /** The level the ATR leg read, or `null` when that leg is inert on this row. */
  atrLevel: number | null;
  /** True when the row carries no usable ATR level — the countable blindness. */
  atrLegInert: boolean;
  /** TRA-3981 — true when no FILL-GRADE premium anchor exists on this row. */
  premiumLegInert: boolean;
  /** TRA-3981 — where the premium anchor came from, or would have. */
  premiumBasisSource: OtmStopPremiumBasisSource;
  /** TRA-3981 — armed AND at least one leg evaluable. `false` ⇒ this rule is not this row's stop. */
  governs: boolean;
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
  // TRA-3981 — ONE derivation of "which legs are live on this row", shared with
  // the two readers. The premium leg's anchor is FILL-GRADE or it is inert; it is
  // never a restated basis, whose sign of error is the sign of the stop error.
  const gov = otmDayOneStopGovernance(subject, rule);
  const { markFloor, atrLevel: level } = gov;
  const base: OtmDayOneStopVerdict = {
    fires: false,
    trigger: null,
    markFloor,
    atrLevel: level,
    atrLegInert: gov.atrLegInert,
    premiumLegInert: gov.premiumLegInert,
    premiumBasisSource: gov.premiumBasis.source,
    governs: gov.governs,
  };
  if (!gov.governs) return base;

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
