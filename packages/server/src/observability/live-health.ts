// TRA-528 — live reliability health summary.
//
// One consolidated verdict for the question every "nothing works in Live"
// incident actually asks: *is the live trading path healthy right now, and if
// not, exactly which link is broken?* The pieces already exist scattered across
// `/api/state` (mode, halt, per-symbol quotes), the settings credential check,
// and the build-info module — but no single surface joins them, so diagnosing a
// dead Live session has meant shelling into the box and cross-referencing three
// endpoints. This summarizer is the join.
//
// `summarizeLiveHealth` is a pure function of an engine-state snapshot + the
// resolved credential gaps, so the verdict is deterministic and unit-testable
// without a running engine. The route handler and the background monitor both
// build their input from the same place and read the same verdict.

import type { AccountMode, TradierEnv } from '@trading-app/shared';
import { MAX_QUOTE_AGE_MS } from '../feed-freshness.js';
import type { LiveStopActionabilitySummary } from '../options-account.js';
import type { AutopilotAction } from '../risk-autopilot.js';
import type { RiskThrottleSizingSnapshot } from '../risk-throttle-sizing.js';

export type HealthStatus = 'green' | 'yellow' | 'red';

/**
 * TRA-4281 — the exit dimension of live health, as READ FROM the fold that
 * already exists (`getLiveStopActionability()` /
 * `summarizeLiveStopActionability`), never a second derivation. The type is an
 * intersection with `LiveStopActionabilitySummary` itself so this surface
 * cannot drift from the instrument it is quoting.
 *
 * `instrumentBlind: true` is a first-class reading, not an absence: "could not
 * measure" and "measured clean" must not share a status (the route's blind
 * branch supplies it when the fold throws or the engine does not expose it).
 */
export type LiveStopExitHealth =
  | ({ instrumentBlind: false } & LiveStopActionabilitySummary)
  | { instrumentBlind: true; blindReason: string | null };

/** A market-data feed is "down" when no tick has landed in this long. */
export const MAX_TICK_AGE_MS = 5 * 60_000;

export interface LiveHealthSymbol {
  /** ms epoch of the last successful quote; 0 / undefined ⇒ never quoted. */
  lastUpdated?: number;
  // TRA-2610 — FRESHNESS / AVAILABILITY ONLY. The plausibility verdict moved off
  // this field onto `SymbolState.moveSuspect`, which is exactly why this roll-up no
  // longer has to carry it: a LIVE quote with an unbelievable published move is
  // `quoteStatus:'ok'`, so it is already counted as fresh here — correctly — without
  // a plausibility member having to be excluded by hand.
  quoteStatus?: 'ok' | 'rate_limited' | 'unavailable';
}

export interface LiveHealthInput {
  mode: AccountMode;
  tradierEnv: TradierEnv;
  /** Output of `findMissingLiveCredentials(settings)` — empty ⇒ broker auth OK. */
  missingCredentials: string[];
  autoTradingEnabled: boolean;
  tradingHalted: boolean;
  haltReason: string | null;
  marketOpen: boolean;
  symbols: LiveHealthSymbol[];
  /** ms epoch of the engine's last tick (EngineState.lastTick). */
  lastTick: number;
  now: number;
  maxQuoteAgeMs?: number;
  maxTickAgeMs?: number;
  /**
   * TRA-995 — the risk-autopilot's current tighten-only risk multiplier in
   * (0, 1]; 1 ⇒ full size. < 1 means the autopilot has de-risked. Optional so
   * callers (and existing tests) that don't supply it default to 1 / no actions.
   */
  riskThrottle?: number;
  /** TRA-995 — the rolling autopilot action log (halts/throttles + reasons). */
  autopilotActions?: AutopilotAction[];
  /**
   * TRA-1001 — since-boot counters for the sizing paths that CONSUME the
   * throttle. Optional: absent ⇒ the caller didn't supply it (the field is
   * omitted from the summary rather than reported as a zeroed rollup, because
   * "never consulted" and "not measured" are different states).
   */
  throttleSizing?: RiskThrottleSizingSnapshot;
  /**
   * TRA-4281 — whether the book's breached live stops will actually be acted
   * on. Before this key existed, `LiveHealthInput` had no member for a
   * position, an order, a stop, or a close outcome — so NO input value could
   * make the panel non-green for an exit-path failure, and three unexitable
   * real-money rows rendered as "All systems healthy".
   *
   * Optional ONLY for pure-function callers/tests that predate the dimension;
   * the production route always supplies it (measured, or `instrumentBlind:
   * true` when the fold threw / is unavailable). Absent ⇒ the summary omits the
   * echo, same discipline as `throttleSizing`.
   */
  liveStopActionability?: LiveStopExitHealth;
}

export interface FeedHealth {
  trackedSymbols: number;
  freshSymbols: number;
  staleSymbols: number;
  neverQuoted: number;
  lastTickAgeSec: number | null;
  /** True when there are tracked symbols but none carry a fresh quote. */
  stale: boolean;
}

export interface LiveHealthSummary {
  status: HealthStatus;
  mode: AccountMode;
  broker: {
    env: TradierEnv;
    /** True when no required live credential is missing. */
    authOk: boolean;
    missingCredentials: string[];
  };
  autoTradingEnabled: boolean;
  tradingHalted: boolean;
  haltReason: string | null;
  marketOpen: boolean;
  feed: FeedHealth;
  /** Human-readable problems, worst first. Empty ⇒ all green. */
  issues: string[];
  /**
   * TRA-995 — the risk autopilot's current state. `riskThrottle` < 1 means it
   * has autonomously de-risked; `actions` lists every halt/throttle with its
   * trigger reason. Observe-and-tighten only — never a limit increase.
   */
  autopilot: {
    riskThrottle: number;
    /** True when the autopilot has tightened risk below full size. */
    throttled: boolean;
    actions: AutopilotAction[];
    /**
     * TRA-1001 — whether the throttle is CONSUMED by per-trade sizing, and how
     * often it has actually trimmed a ticket since boot. `throttled: true` with
     * `sizing.armedScope: 'off'` is the honest "de-risk decided, sizing
     * unchanged" state that shipped with TRA-995; an armed scope with
     * `totalTrims: 0` means the consuming path has never seen a sub-1 throttle
     * at an entry — NOT that it works. Absent when the caller didn't measure it.
     *
     * TRA-2333 — read `armedScope` (`off` | `demo` | `all`), not the removed
     * `armed` boolean, and `byPath[x].armed` for the per-chokepoint bit. Under
     * `demo` the two live-broker paths report `armed: false` and are pinned to
     * multiplier 1; a reader that only checks a top-level boolean cannot tell a
     * demo arm from a live one.
     */
    sizing?: RiskThrottleSizingSnapshot;
  };
  /**
   * TRA-4281 — the exit-dimension reading this verdict consumed, echoed
   * verbatim so the panel can render the counts next to the issue string.
   * Omitted (not zeroed) when the caller didn't measure it.
   */
  liveStopActionability?: LiveStopExitHealth;
}

/**
 * TRA-4281 — render `byReason` for an issue string: reasons only (the fold
 * already guarantees no OCC symbols), largest first, counts included only when
 * there is more than one reason (with one reason the row count already said it).
 */
function inertReasonList(byReason: LiveStopActionabilitySummary['byReason']): string {
  const entries = Object.entries(byReason)
    .filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (entries.length === 0) return 'no refusing gate recorded';
  if (entries.length === 1) return entries[0]![0];
  return entries.map(([reason, n]) => `${reason}×${n}`).join(', ');
}

/** Per-feed health from an engine's symbol snapshot. Pure. */
export function summarizeFeed(
  symbols: LiveHealthSymbol[],
  now: number,
  maxQuoteAgeMs = MAX_QUOTE_AGE_MS,
  lastTick = 0,
  maxTickAgeMs = MAX_TICK_AGE_MS,
): FeedHealth {
  let fresh = 0;
  let stale = 0;
  let never = 0;
  for (const s of symbols) {
    const lu = s.lastUpdated ?? 0;
    if (lu <= 0) {
      never++;
    } else if (now - lu > maxQuoteAgeMs) {
      stale++;
    } else {
      fresh++;
    }
  }
  const tracked = symbols.length;
  const lastTickAgeSec = lastTick > 0 ? Math.max(0, Math.floor((now - lastTick) / 1000)) : null;
  // The feed is "stale" (an outage signal) when we are tracking symbols but not
  // one of them has a fresh quote, OR the engine itself has stopped ticking.
  const noFreshQuotes = tracked > 0 && fresh === 0;
  const tickStalled = lastTick > 0 && now - lastTick > maxTickAgeMs;
  return {
    trackedSymbols: tracked,
    freshSymbols: fresh,
    staleSymbols: stale,
    neverQuoted: never,
    lastTickAgeSec,
    stale: noFreshQuotes || tickStalled,
  };
}

/**
 * Roll the inputs into a single GREEN / YELLOW / RED verdict plus an ordered
 * list of issues.
 *
 * RED — the live path is broken and would not (or should not) trade:
 *   • live mode with a missing broker credential (the silent "live with no
 *     creds" foot-gun TRA-506 guards against, surfaced here for monitoring);
 *   • market open but the data feed is stale (no fresh quotes / engine stalled)
 *     — the literal "nothing works" symptom;
 *   • TRA-4281: live rows breached with NONE actionable and at least one inert
 *     — real money past its stop that nothing in the engine will exit. This is
 *     the state that let TRA-4277's condition run for a day while the panel
 *     said "All systems healthy".
 * YELLOW — degraded or intentionally paused, worth a look but not an outage:
 *   • trading halted (risk circuit-breaker or kill switch engaged);
 *   • auto-trading switched off while in live mode;
 *   • some — but not all — symbols stale;
 *   • TRA-4281: some breached live rows inert while others are still being
 *     acted on, or (on a live book) the stop-actionability instrument is BLIND
 *     — a blind instrument and a clean book must never share a status.
 * GREEN — none of the above.
 *
 * Market-closed is never itself an issue: a stale feed outside market hours is
 * expected, so the feed checks that imply an outage are gated on `marketOpen`.
 */
export function summarizeLiveHealth(input: LiveHealthInput): LiveHealthSummary {
  const feed = summarizeFeed(
    input.symbols,
    input.now,
    input.maxQuoteAgeMs,
    input.lastTick,
    input.maxTickAgeMs,
  );
  const authOk = input.missingCredentials.length === 0;
  const isLive = input.mode === 'live';

  const issues: string[] = [];
  let status: HealthStatus = 'green';
  const escalate = (to: HealthStatus): void => {
    const rank: Record<HealthStatus, number> = { green: 0, yellow: 1, red: 2 };
    if (rank[to] > rank[status]) status = to;
  };

  if (isLive && !authOk) {
    issues.push(`Live mode but broker credentials missing: ${input.missingCredentials.join(', ')}`);
    escalate('red');
  }
  if (input.marketOpen && feed.stale) {
    issues.push(
      feed.trackedSymbols === 0
        ? 'Market open but engine is tracking no symbols'
        : `Market open but data feed is stale (0/${feed.trackedSymbols} symbols fresh)`,
    );
    escalate('red');
  }

  // TRA-4281 — the exit dimension. `breached === actionable + inFlight + inert`
  // (the fold's own identity), so with `actionable === 0`:
  //   • `inert > 0`  — at least one breached row was REFUSED by a gate and
  //     nothing will act on it → RED. The issue names the count, the refusing
  //     reasons, and whether a release is even scheduled.
  //   • `inert === 0` (all in flight) — every breached row already has a
  //     working exit order at the broker; something IS acting, and whether that
  //     order is stalling is `staleWorkingExits`' measurement, not this one.
  //     AC2's literal `breached > 0 && actionable === 0` predicate would flash
  //     RED on every healthy stop fire (a row gains `pendingExit` the moment
  //     its close is staged), so the in-flight-only case is deliberately not an
  //     issue here.
  // A blind instrument on a live book is YELLOW, never green: "could not
  // measure" and "measured clean" must not share a status (AC4). On a demo book
  // blindness is quiet for the same reason missing live creds are: the fold
  // only ever counts LIVE rows, so there is nothing it could have seen.
  const stops = input.liveStopActionability;
  if (stops !== undefined) {
    if (stops.instrumentBlind) {
      if (isLive) {
        issues.push(
          `Live stop-actionability instrument is BLIND (${stops.blindReason ?? 'no reason captured'}) — a breached, unexitable book would be invisible`,
        );
        escalate('yellow');
      }
    } else if (stops.breached > 0 && stops.actionable === 0 && stops.inert > 0) {
      issues.push(
        `${stops.breached} live row${stops.breached === 1 ? '' : 's'} breached, 0 actionable (${inertReasonList(stops.byReason)}) — ${stops.releasesAt !== null ? `earliest release ${stops.releasesAt}` : 'no release scheduled'}`,
      );
      escalate('red');
    } else if (stops.inert > 0) {
      issues.push(
        `${stops.inert}/${stops.breached} breached live rows are inert (${inertReasonList(stops.byReason)}) — the rest are actionable or in flight`,
      );
      escalate('yellow');
    }
  }

  if (input.tradingHalted) {
    issues.push(input.haltReason ? `Trading halted: ${input.haltReason}` : 'Trading halted');
    escalate('yellow');
  }
  if (isLive && !input.autoTradingEnabled) {
    issues.push('Live mode but auto-trading is disabled');
    escalate('yellow');
  }
  if (input.marketOpen && !feed.stale && feed.staleSymbols > 0) {
    issues.push(`${feed.staleSymbols}/${feed.trackedSymbols} symbols have a stale quote`);
    escalate('yellow');
  }

  // TRA-995 — an active autopilot throttle is a degraded-but-deliberate state:
  // the firm is intentionally trading smaller. Surface it as YELLOW (worth a
  // look, not an outage) with the most recent trigger reason.
  const riskThrottle = input.riskThrottle ?? 1;
  const autopilotActions = input.autopilotActions ?? [];
  const throttled = riskThrottle < 1;
  if (throttled && !input.tradingHalted) {
    const lastThrottle = [...autopilotActions].reverse().find((a) => a.kind === 'throttle');
    // TRA-1001 — say whether the throttle is actually CONSUMED by sizing. An
    // unarmed consumer means the de-risk is advisory: the reader must not infer
    // "the firm is trading smaller" from a throttle alone.
    // TRA-2333 — name the SCOPE, not a boolean. A demo-scoped arm and an
    // all-scoped arm both used to render as "consumed", so this line could not
    // tell a correctly-scoped arm from an accidental live one — and under `demo`
    // a LIVE ticket is still sizing at full risk, which is the opposite of what
    // an unqualified "consumed" tells the reader.
    const consumed = (() => {
      if (!input.throttleSizing) return '';
      switch (input.throttleSizing.armedScope) {
        case 'off':
          return ' (sizing consumer DARK — tickets still size at full risk)';
        case 'demo':
          return ' (sizing consumer armed for DEMO only — live-broker tickets still size at full risk)';
        case 'all':
          return ' (sizing consumer armed for ALL paths, including the live broker)';
      }
    })();
    issues.push(
      `Risk autopilot throttled to ${(riskThrottle * 100).toFixed(0)}%${lastThrottle ? ` — ${lastThrottle.reason}` : ''}${consumed}`,
    );
    escalate('yellow');
  }

  return {
    status,
    mode: input.mode,
    broker: { env: input.tradierEnv, authOk, missingCredentials: input.missingCredentials },
    autoTradingEnabled: input.autoTradingEnabled,
    tradingHalted: input.tradingHalted,
    haltReason: input.haltReason,
    marketOpen: input.marketOpen,
    feed,
    issues,
    autopilot: {
      riskThrottle,
      throttled,
      actions: autopilotActions,
      // TRA-1001 — omitted (not zeroed) when the caller didn't measure it.
      ...(input.throttleSizing ? { sizing: input.throttleSizing } : {}),
    },
    // TRA-4281 — omitted (not zeroed) when the caller didn't measure it; the
    // production route always supplies measured-or-blind.
    ...(stops !== undefined ? { liveStopActionability: stops } : {}),
  };
}
