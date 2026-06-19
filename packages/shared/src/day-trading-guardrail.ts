// TRA-598 (TRA-595 C3) — first-class "no day trading" guardrail.
//
// The user's hard product requirement is: NO DAY TRADING. Before this module
// that rule was only *implicit* in the 21–60 DTE scanner window — nothing
// stopped a short-dated entry from another path, and nothing stopped a
// voluntary same-session open→close round trip (the textbook day trade).
//
// This is the single, central config block + the pure decision helpers that
// make the rule first-class. It lives in `@trading-app/shared` so BOTH the
// idea-generation layer (`@trading-app/agents` Head-of-Options-Research pass)
// and the order-time layer (`@trading-app/server` options account + Tradier
// smart-open/close) enforce the exact same thresholds — there is one source of
// truth, not three drifting copies.
//
// Two distinct DTE floors by design:
//   • `minIdeaDteDays` (21) — the IDEA-GEN floor, aligned to the swing window
//     (TRA-373). We never even *surface* a sub-swing idea.
//   • `minEntryDteDays` (7) — the ORDER-TIME hard floor, a looser absolute
//     backstop that blocks 0DTE/day-trade entries on ANY path (manual, mirror,
//     a future refactor) regardless of which scanner produced them. It is ≤ the
//     idea floor so it can never reject something idea-gen already allowed.
//
// And the round-trip rule:
//   • `blockSameSessionRoundTrip` (true) — a *discretionary* close of a position
//     opened in the same session is refused. Risk-driven exits (stop-loss,
//     take-profit, trailing) are NOT discretionary and are always allowed, so a
//     position going against the user still auto-exits at its stop — the rule
//     prevents voluntary same-day scalping, it does not trap a losing position.
//   • `minHoldingPeriodMs` (0) — optional finer-grained floor on top of the
//     same-session rule; 0 means the same-session rule is the only time gate.

/** Central, config-driven thresholds for the no-day-trading guardrail. */
export interface DayTradingGuardrailConfig {
  /**
   * Hard floor on days-to-expiration at ORDER time. Any entry whose nearest leg
   * expires in fewer than this many calendar days is refused — this is what
   * makes "no 0DTE / no sub-N-DTE" first-class at the broker boundary. Default 7.
   */
  minEntryDteDays: number;
  /**
   * Floor on days-to-expiration at IDEA-GEN time. Aligned to the 21–60 swing
   * window so the product never surfaces a short-dated (day-trade-adjacent)
   * idea. Always ≥ {@link minEntryDteDays}. Default 21.
   */
  minIdeaDteDays: number;
  /**
   * When true, a discretionary close of a position opened in the SAME session
   * (UTC calendar day) is refused — no same-day round trips. Risk exits are
   * exempt (see module header). Default true.
   */
  blockSameSessionRoundTrip: boolean;
  /**
   * Minimum wall-clock a position must be held before a discretionary close is
   * allowed, on top of the same-session rule. 0 disables this finer gate.
   * Default 0.
   */
  minHoldingPeriodMs: number;
}

/**
 * Documented defaults for the no-day-trading guardrail. These are the shipped
 * thresholds; callers may pass an override config to {@link checkEntryDte} et al
 * (the options account threads one through for tests). Changing the product
 * stance is a one-line edit here.
 */
export const DAY_TRADING_GUARDRAIL: DayTradingGuardrailConfig = {
  minEntryDteDays: 7,
  minIdeaDteDays: 21,
  blockSameSessionRoundTrip: true,
  minHoldingPeriodMs: 0,
};

/** Outcome of a guardrail check — `allowed:false` always carries a UI/log `reason`. */
export interface GuardrailVerdict {
  allowed: boolean;
  /** Human-readable rejection reason, present iff `allowed === false`. */
  reason?: string;
}

const ALLOWED: GuardrailVerdict = { allowed: true };

/**
 * The session bucket a timestamp falls in. We use the UTC calendar day to match
 * the existing options-account day-roll key (`toDateKey`) so "same session" here
 * means the same thing the daily-P&L / day-counter logic already means. (US
 * options trade a single RTH session per calendar day; UTC-day granularity is
 * sufficient to catch an open→close round trip.)
 */
export function sessionDayKey(utcMs: number): string {
  return new Date(utcMs).toISOString().slice(0, 10);
}

/** True when both timestamps fall in the same trading session (UTC calendar day). */
export function isSameSession(aMs: number, bMs: number): boolean {
  return sessionDayKey(aMs) === sessionDayKey(bMs);
}

/**
 * Whole calendar days from `nowMs` to an OCC/ISO `YYYY-MM-DD` expiration. An
 * option expiring today → 0 (0DTE), tomorrow → 1, etc. Returns `null` when the
 * expiration string can't be parsed. Computed against UTC midnight of both days
 * so it is a stable integer regardless of the intraday clock.
 */
export function dteFromExpiration(expiration: string, nowMs: number): number | null {
  const expMs = Date.parse(`${expiration}T00:00:00Z`);
  if (!Number.isFinite(expMs)) return null;
  const todayMs = Date.parse(`${sessionDayKey(nowMs)}T00:00:00Z`);
  return Math.round((expMs - todayMs) / 86_400_000);
}

/**
 * Order-time entry gate: reject an entry whose nearest-leg DTE is below the hard
 * floor (`minEntryDteDays`). This is the "block 0DTE / sub-threshold DTE
 * entries" rule, enforced at the broker boundary independent of which path
 * produced the order.
 */
export function checkEntryDte(
  dteDays: number,
  cfg: DayTradingGuardrailConfig = DAY_TRADING_GUARDRAIL,
): GuardrailVerdict {
  if (!Number.isFinite(dteDays)) {
    return { allowed: false, reason: 'no day trading: entry has no resolvable expiration/DTE' };
  }
  if (dteDays < cfg.minEntryDteDays) {
    return {
      allowed: false,
      reason: `no day trading: entry DTE ${dteDays} is below the ${cfg.minEntryDteDays}-day minimum (0DTE/short-dated entries are blocked)`,
    };
  }
  return ALLOWED;
}

/**
 * Idea-generation gate: reject an idea whose nearest-leg DTE is below the
 * idea-gen floor (`minIdeaDteDays`). Used by the Head-of-Options-Research pass
 * so a chatty model can never surface a 0DTE / short-dated idea.
 */
export function checkIdeaDte(
  dteDays: number,
  cfg: DayTradingGuardrailConfig = DAY_TRADING_GUARDRAIL,
): GuardrailVerdict {
  if (!Number.isFinite(dteDays)) {
    return { allowed: false, reason: 'no day trading: idea has no resolvable DTE' };
  }
  if (dteDays < cfg.minIdeaDteDays) {
    return {
      allowed: false,
      reason: `no day trading: idea DTE ${dteDays} is below the ${cfg.minIdeaDteDays}-day swing minimum`,
    };
  }
  return ALLOWED;
}

/**
 * Discretionary-close gate: refuse a voluntary close that would complete a
 * same-session round trip (or fall inside the optional minimum holding period).
 * Risk-driven exits do NOT call this — they are always allowed.
 *
 * @param openedAtMs when the position was opened (ms epoch).
 * @param nowMs      the close instant (ms epoch).
 */
export function checkDiscretionaryClose(
  openedAtMs: number,
  nowMs: number,
  cfg: DayTradingGuardrailConfig = DAY_TRADING_GUARDRAIL,
): GuardrailVerdict {
  if (cfg.blockSameSessionRoundTrip && isSameSession(openedAtMs, nowMs)) {
    return {
      allowed: false,
      reason:
        'no day trading: opening and closing the same position in one session is not allowed — the position can be closed on the next session or will auto-exit at its stop',
    };
  }
  if (cfg.minHoldingPeriodMs > 0 && nowMs - openedAtMs < cfg.minHoldingPeriodMs) {
    const heldMin = Math.max(0, Math.floor((nowMs - openedAtMs) / 60_000));
    const reqMin = Math.ceil(cfg.minHoldingPeriodMs / 60_000);
    return {
      allowed: false,
      reason: `no day trading: position held ${heldMin}m, below the ${reqMin}m minimum holding period`,
    };
  }
  return ALLOWED;
}

// ── TRA-952 — equity swing-trade holding-period floor ──────────────────────
//
// The options layer above blocks 0DTE/short-dated entries + same-session round
// trips. Equities have no DTE, so the swing-conversion analog is a *holding-
// period* floor expressed in TRADING days (weekends don't count toward the
// scalp window). A discretionary close is refused until the position has been
// held the minimum number of trading days. Risk-driven exits (stop-loss /
// take-profit / trailing) are NOT discretionary and bypass this entirely — a
// hard stop can always fire same-session, exactly as the acceptance allows.

/** Central config for the equity swing-trade holding-period floor (TRA-952). */
export interface EquitySwingGuardrailConfig {
  /** Refuse a discretionary close opened+closed in the same UTC session. Default true. */
  blockSameSessionRoundTrip: boolean;
  /** Minimum *trading* days held before a discretionary close is allowed. Default 2. */
  minHoldingTradingDays: number;
}

/** Shipped defaults: no same-session round trips, ≥2 trading-day swing floor. */
export const EQUITY_SWING_GUARDRAIL: EquitySwingGuardrailConfig = {
  blockSameSessionRoundTrip: true,
  minHoldingTradingDays: 2,
};

/**
 * Count whole TRADING days (Mon–Fri, UTC) strictly between the open session and
 * the close instant. Weekend days are not counted, so a Friday-open /
 * Monday-close is 1 trading day, not 3. Deliberately calendar-weekday based (no
 * exchange-holiday calendar) — it only needs to gate the intraday-scalp window,
 * where holiday precision is immaterial and erring toward "held fewer days"
 * keeps the floor conservative.
 */
export function tradingDaysBetween(openedAtMs: number, nowMs: number): number {
  if (!(nowMs > openedAtMs)) return 0;
  const startDay = Math.floor(Date.parse(`${sessionDayKey(openedAtMs)}T00:00:00Z`) / 86_400_000);
  const endDay = Math.floor(Date.parse(`${sessionDayKey(nowMs)}T00:00:00Z`) / 86_400_000);
  let count = 0;
  for (let d = startDay + 1; d <= endDay; d += 1) {
    const dow = new Date(d * 86_400_000).getUTCDay(); // 0 Sun … 6 Sat
    if (dow !== 0 && dow !== 6) count += 1;
  }
  return count;
}

/**
 * Equity discretionary-close gate: refuse a voluntary close that would complete
 * a same-session round trip or fall short of the swing holding floor. This is
 * the equity-engine analog of {@link checkDiscretionaryClose} (options). Risk
 * exits do NOT call this — they are always allowed.
 *
 * @param openedAtMs when the position was opened (ms epoch).
 * @param nowMs      the close instant (ms epoch).
 */
export function checkEquitySwingClose(
  openedAtMs: number,
  nowMs: number,
  cfg: EquitySwingGuardrailConfig = EQUITY_SWING_GUARDRAIL,
): GuardrailVerdict {
  if (cfg.blockSameSessionRoundTrip && isSameSession(openedAtMs, nowMs)) {
    return {
      allowed: false,
      reason:
        'no day trading: opening and closing this equity in one session is not allowed — close it on a later session or let it auto-exit at its stop',
    };
  }
  const held = tradingDaysBetween(openedAtMs, nowMs);
  if (cfg.minHoldingTradingDays > 0 && held < cfg.minHoldingTradingDays) {
    return {
      allowed: false,
      reason: `no day trading: equity held ${held} trading day(s), below the ${cfg.minHoldingTradingDays}-trading-day swing minimum`,
    };
  }
  return ALLOWED;
}
