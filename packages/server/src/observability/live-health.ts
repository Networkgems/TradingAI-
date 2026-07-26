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
import type { AutopilotAction } from '../risk-autopilot.js';
import type { RiskThrottleSizingSnapshot } from '../risk-throttle-sizing.js';

export type HealthStatus = 'green' | 'yellow' | 'red';

/** A market-data feed is "down" when no tick has landed in this long. */
export const MAX_TICK_AGE_MS = 5 * 60_000;

export interface LiveHealthSymbol {
  /** ms epoch of the last successful quote; 0 / undefined ⇒ never quoted. */
  lastUpdated?: number;
  // TRA-2379 — `'suspect'` is a LIVE quote with an unbelievable published move, so
  // it must not be counted alongside the no-quote statuses in any freshness roll-up.
  quoteStatus?: 'ok' | 'rate_limited' | 'unavailable' | 'suspect';
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
 *     — the literal "nothing works" symptom.
 * YELLOW — degraded or intentionally paused, worth a look but not an outage:
 *   • trading halted (risk circuit-breaker or kill switch engaged);
 *   • auto-trading switched off while in live mode;
 *   • some — but not all — symbols stale.
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
  };
}
