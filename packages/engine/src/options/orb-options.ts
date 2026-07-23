import type { Candle, OptionType } from '@trading-app/shared';
import { getEasternUtcOffset } from '@trading-app/shared';

/**
 * TRA-2172 — Fully-automated Opening Range Breakout (ORB) for CALLS and PUTS.
 *
 * Pure, deterministic engine core that maps an intraday opening-range breakout
 * to a LONG-premium directional options intent:
 *
 *   - price CLOSES above the opening-range HIGH  → buy a CALL  (bullish break)
 *   - price CLOSES below the opening-range LOW   → buy a PUT   (bearish break)
 *
 * The strict rules are lifted from the two source strategies attached to the
 * issue and exposed as parameters so a downstream sweep can tune them:
 *
 *   - Opening range = high/low of the first `rangeMinutes` of the ET session
 *     (default 15m; the sources study 5/15/30/60).
 *   - `requireClose` — wait for a bar to CLOSE beyond the edge, not merely wick
 *     through it (r/Daytrading: "do not enter until the 5-minute candle has
 *     closed above or below the ORB").
 *   - `minRangePct` — the range must be at least this wide (fraction of the
 *     session-open price) to count as a real signal (Option Alpha: 0.2%).
 *   - `maxRangePct` — skip oversized ranges (tradethatswing caps at 0.8%); set
 *     to 0 to disable the cap.
 *   - `entryCutoffEtMinute` — no entry after this ET minute-of-day (Option
 *     Alpha: 12:00 EST = 720).
 *   - `allowedBreakouts` — take both sides ('both', the default — "calls AND
 *     puts"), or restrict to one ('up_only' = calls only / long-bias uptrend,
 *     'down_only' = puts only). tradethatswing found long-only best in an
 *     uptrend; the caller decides which regime it is in.
 *   - `excludedEtWeekdays` — skip named ET weekdays (tradethatswing avoids
 *     Mondays=1 / Thursdays=4). Empty by default so the core stays neutral.
 *
 * ONE TRADE A DAY: the FIRST post-range bar that breaks either edge sets the
 * day's single trade. A later break of the opposite edge is ignored — matching
 * the sources ("if ORB is broken to the downside first, all trades for the day
 * are ignored"). The signal therefore fires exactly once per ET session, on the
 * breakout bar itself.
 *
 * Contract/strike/expiry selection, IV structure, sizing and exits are NOT this
 * module's job — the directional intent is handed to the options execution layer
 * (0DTE strike/expiry selection lives in the server package, gated behind the
 * shadow ledger). This core stays dependency-free and golden-fixture testable
 * exactly like `strategies/orb.ts` and `options/supertrend-options.ts`.
 *
 * NOTHING here routes to live. Live promotion is gated on TRA-382.
 */

export interface OrbOptionsParams {
  /** Minutes after the ET open that define the opening range (default 15). */
  rangeMinutes: number;
  /** ET minute-of-day the regular session opens (default 570 = 09:30 ET). */
  sessionOpenEtMinute: number;
  /**
   * Require a bar to CLOSE beyond the edge (default true). When false a wick
   * (intrabar high/low) piercing the edge triggers.
   */
  requireClose: boolean;
  /** Minimum opening-range width as a fraction of the open price (default 0.002 = 0.2%). */
  minRangePct: number;
  /**
   * Maximum opening-range width as a fraction of the open price (default 0.008
   * = 0.8%). Set to 0 to disable the cap.
   */
  maxRangePct: number;
  /** No entry after this ET minute-of-day (default 720 = 12:00 ET). */
  entryCutoffEtMinute: number;
  /** Which breakout sides to act on (default 'both'). */
  allowedBreakouts: 'both' | 'up_only' | 'down_only';
  /**
   * ET weekdays to skip (0=Sun … 6=Sat). Empty by default; pass [1, 4] to
   * reproduce the tradethatswing "avoid Mondays and Thursdays" rule.
   */
  excludedEtWeekdays: readonly number[];
}

export const DEFAULT_ORB_OPTIONS_PARAMS: OrbOptionsParams = {
  rangeMinutes: 15,
  sessionOpenEtMinute: 9 * 60 + 30,
  requireClose: true,
  minRangePct: 0.002,
  maxRangePct: 0.008,
  entryCutoffEtMinute: 12 * 60,
  allowedBreakouts: 'both',
  excludedEtWeekdays: [],
};

export type OrbOptionsSignalType = 'call_breakout' | 'put_breakout' | 'none';

/** The opening-range box the read was taken against. */
export interface OrbOptionsBox {
  /** Timestamp of the first bar in the opening range (the session-open bar). */
  openTimestamp: number;
  /** Session-open price the width is measured against. */
  openPrice: number;
  /** Opening-range high (call-breakout trigger level). */
  high: number;
  /** Opening-range low (put-breakout trigger level). */
  low: number;
  /** (high − low) / openPrice. */
  widthPct: number;
}

export interface OrbOptionsSignal {
  type: OrbOptionsSignalType;
  /** 'call' on an upside break, 'put' on a downside break, null on `none`. */
  optionType: OptionType | null;
  /** 'up' | 'down' | null — the direction of the break. */
  breakoutDirection: 'up' | 'down' | null;
  /** The opening-range edge that was broken (high for up, low for down), or null. */
  breakLevel: number | null;
  /** Underlying price at the breakout (the breakout bar's close), or null. */
  underlyingEntry: number | null;
  /** The opening-range box, or null when one could not be drawn. */
  box: OrbOptionsBox | null;
  /** Human-readable rationale / skip reason. */
  reason: string;
}

const NONE = (reason: string, box: OrbOptionsBox | null = null): OrbOptionsSignal => ({
  type: 'none',
  optionType: null,
  breakoutDirection: null,
  breakLevel: null,
  underlyingEntry: null,
  box,
  reason,
});

/** The option a breakout direction buys: upside break → call, downside → put. */
export function optionTypeForBreakout(direction: 'up' | 'down'): OptionType {
  return direction === 'up' ? 'call' : 'put';
}

/** ET wall-clock shift for a UTC ms instant (handles EST/EDT via the shared offset). */
function etShift(utcMs: number): number {
  return utcMs + getEasternUtcOffset(utcMs) * 3_600_000;
}

/** ET minute-of-day (0–1439) for a UTC ms instant. */
function etMinuteOfDay(utcMs: number): number {
  const d = new Date(etShift(utcMs));
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** ET calendar-day index for a UTC ms instant (days since epoch in ET wall time). */
function etDayIndex(utcMs: number): number {
  return Math.floor(etShift(utcMs) / 86_400_000);
}

/** ET weekday (0=Sun … 6=Sat) for a UTC ms instant. */
function etWeekday(utcMs: number): number {
  return new Date(etShift(utcMs)).getUTCDay();
}

/**
 * The opening-range box for the ET session that contains `candles`' LAST bar, or
 * null when the session-open bar is not present or the range is degenerate. Pure
 * — depends only on OHLC + timestamps.
 */
export function openingRangeForSession(
  candles: Candle[],
  params: OrbOptionsParams = DEFAULT_ORB_OPTIONS_PARAMS,
): OrbOptionsBox | null {
  if (candles.length === 0) return null;
  const latest = candles[candles.length - 1];
  const day = etDayIndex(latest.timestamp);

  // Session-open bar = first bar on the latest bar's ET day at/after the open.
  const sessionStart = candles.find(
    c => etDayIndex(c.timestamp) === day && etMinuteOfDay(c.timestamp) >= params.sessionOpenEtMinute,
  );
  if (!sessionStart) return null;

  const rangeCutoff = sessionStart.timestamp + params.rangeMinutes * 60_000;
  // Half-open window [open, open+rangeMinutes): the cutoff bar is the first bar
  // that can BREAK the range, not part of it.
  const rangeCandles = candles.filter(
    c => c.timestamp >= sessionStart.timestamp && c.timestamp < rangeCutoff,
  );
  if (rangeCandles.length === 0) return null;

  const high = Math.max(...rangeCandles.map(c => c.high));
  const low = Math.min(...rangeCandles.map(c => c.low));
  const openPrice = rangeCandles[0].open;
  if (!(high > low) || !(openPrice > 0)) return null;

  return {
    openTimestamp: sessionStart.timestamp,
    openPrice,
    high,
    low,
    widthPct: (high - low) / openPrice,
  };
}

/**
 * Evaluate the ORB-options read for the ET session containing `candles`' last
 * bar. Returns a `call_breakout` / `put_breakout` intent ONLY when the last bar
 * is the session's first opening-range breakout (one trade a day), all gates
 * pass, and the direction is allowed. Otherwise returns `none` with a reason.
 *
 * `candles` must be intraday bars in ascending timestamp order. Bars from other
 * ET days are ignored for range and breakout purposes (anchored to the last
 * bar's ET day), so a multi-session series is safe to pass.
 */
export function evaluateOrbOptions(
  candles: Candle[],
  params: OrbOptionsParams = DEFAULT_ORB_OPTIONS_PARAMS,
): OrbOptionsSignal {
  if (candles.length < 2) return NONE('insufficient_bars');

  const box = openingRangeForSession(candles, params);
  if (!box) return NONE('no_opening_range');

  // Range-width gates.
  if (box.widthPct < params.minRangePct) {
    return NONE(
      `range_too_narrow: ${(box.widthPct * 100).toFixed(3)}% < ${(params.minRangePct * 100).toFixed(3)}%`,
      box,
    );
  }
  if (params.maxRangePct > 0 && box.widthPct > params.maxRangePct) {
    return NONE(
      `range_too_wide: ${(box.widthPct * 100).toFixed(3)}% > ${(params.maxRangePct * 100).toFixed(3)}%`,
      box,
    );
  }

  const latest = candles[candles.length - 1];
  const day = etDayIndex(latest.timestamp);
  const rangeCutoff = box.openTimestamp + params.rangeMinutes * 60_000;

  // Weekday exclusion (evaluated on the session, i.e. the latest bar's ET day).
  if (params.excludedEtWeekdays.includes(etWeekday(latest.timestamp))) {
    return NONE('excluded_weekday', box);
  }

  // Scan post-range bars on this ET day in order; the FIRST edge break sets the
  // day's single trade (one trade a day).
  const breaksUp = (c: Candle) => (params.requireClose ? c.close > box.high : c.high > box.high);
  const breaksDown = (c: Candle) => (params.requireClose ? c.close < box.low : c.low < box.low);

  let firstBreakIndex = -1;
  let firstBreakDir: 'up' | 'down' | null = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (etDayIndex(c.timestamp) !== day) continue;
    if (c.timestamp < rangeCutoff) continue;
    const up = breaksUp(c);
    const down = breaksDown(c);
    if (!up && !down) continue;
    // Both edges pierced on one bar (only possible when !requireClose): resolve
    // by where the bar closed relative to the range midline.
    if (up && down) {
      firstBreakDir = c.close >= (box.high + box.low) / 2 ? 'up' : 'down';
    } else {
      firstBreakDir = up ? 'up' : 'down';
    }
    firstBreakIndex = i;
    break;
  }

  if (firstBreakIndex < 0) return NONE('no_breakout', box);

  // Fire only on the breakout bar itself → exactly one signal per session.
  if (firstBreakIndex !== candles.length - 1) return NONE('already_triggered_today', box);

  // Entry-time cutoff.
  const breakMinute = etMinuteOfDay(latest.timestamp);
  if (breakMinute > params.entryCutoffEtMinute) {
    return NONE(`after_cutoff: ET minute ${breakMinute} > ${params.entryCutoffEtMinute}`, box);
  }

  const direction = firstBreakDir as 'up' | 'down';

  // Direction filter.
  if (direction === 'up' && params.allowedBreakouts === 'down_only') {
    return NONE('up_break_filtered: down_only', box);
  }
  if (direction === 'down' && params.allowedBreakouts === 'up_only') {
    return NONE('down_break_filtered: up_only', box);
  }

  const optionType = optionTypeForBreakout(direction);
  const breakLevel = direction === 'up' ? box.high : box.low;
  return {
    type: direction === 'up' ? 'call_breakout' : 'put_breakout',
    optionType,
    breakoutDirection: direction,
    breakLevel,
    underlyingEntry: latest.close,
    box,
    reason:
      direction === 'up'
        ? `upside ORB break: close ${latest.close} ${params.requireClose ? '>' : 'wicked >'} range high ${box.high} → buy call`
        : `downside ORB break: close ${latest.close} ${params.requireClose ? '<' : 'wicked <'} range low ${box.low} → buy put`,
  };
}
