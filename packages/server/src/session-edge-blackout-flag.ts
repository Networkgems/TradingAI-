// TRA-2049 (parent TRA-2044 "how to actually reduce slippage") — the configurable
// EDGE-OF-SESSION entry blackout. Suppresses NEW equity entries in the first and
// last N minutes of the regular US session (the open/close auction churn is where
// spreads are widest and slippage is worst), while leaving exits and position
// management untouched — those run earlier in the tick and never pass through the
// entry chokepoints this flag is consulted at (routeEquitySignal / openSma200Pullback).
//
// FLAG-OFF by default (board directive): a byte-for-byte no-op until an operator
// sets ENABLE_SESSION_EDGE_BLACKOUT=1. This is a TIGHTENING-only gate — it can only
// ever PREVENT an entry, never permit or resize one, so the demo-flags.json override
// path is safe even though the same env is consulted regardless of mode (the gate is
// deliberately NOT mode-scoped: an edge-of-session entry is equally bad in demo and
// live, and flag-off means neither is affected until armed).
//
// The two edge widths are independently tunable in minutes; a `0` disables that edge
// (e.g. blackout the close but not the open). A suppressed entry is counted under the
// `session_edge_blackout` reason on the equity-entry funnel, so it is distinguishable
// from a dry signal — see equity-entry-funnel.ts.

import {
  isStockMarketOpen,
  minutesSinceSessionOpen,
  minutesToSessionClose,
} from '@trading-app/shared';

export const SESSION_EDGE_BLACKOUT_FLAG = 'ENABLE_SESSION_EDGE_BLACKOUT';
/** Minutes at the OPEN edge to suppress new entries (default 3; 0 disables the open edge). */
export const SESSION_EDGE_BLACKOUT_OPEN_MINUTES = 'SESSION_EDGE_BLACKOUT_OPEN_MINUTES';
/** Minutes at the CLOSE edge to suppress new entries (default 3; 0 disables the close edge). */
export const SESSION_EDGE_BLACKOUT_CLOSE_MINUTES = 'SESSION_EDGE_BLACKOUT_CLOSE_MINUTES';
export const SESSION_EDGE_BLACKOUT_DEFAULT_MINUTES = 3;

export type SessionEdge = 'open' | 'close';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** True iff the edge-of-session entry blackout is armed (standalone; 1/true/yes/on). */
export function isSessionEdgeBlackoutEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[SESSION_EDGE_BLACKOUT_FLAG]);
}

/**
 * Resolve one edge width in minutes. Reads the optional override, falling back to
 * {@link SESSION_EDGE_BLACKOUT_DEFAULT_MINUTES}. A malformed / negative value falls
 * back to the default (never silently 0-disables an edge); an explicit `0` is
 * honoured as "disable this edge". Floored to an integer — a fractional edge is
 * meaningless against the whole-minute ET clock the session helpers use.
 */
function resolveEdgeMinutes(raw: string | undefined): number {
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return SESSION_EDGE_BLACKOUT_DEFAULT_MINUTES;
}

export interface SessionEdgeBlackoutMinutes {
  openMinutes: number;
  closeMinutes: number;
}

/** The two configured edge widths (independent; either may be 0 to disable that edge). */
export function resolveSessionEdgeBlackoutMinutes(
  env: NodeJS.ProcessEnv = process.env,
): SessionEdgeBlackoutMinutes {
  return {
    openMinutes: resolveEdgeMinutes(env[SESSION_EDGE_BLACKOUT_OPEN_MINUTES]),
    closeMinutes: resolveEdgeMinutes(env[SESSION_EDGE_BLACKOUT_CLOSE_MINUTES]),
  };
}

/**
 * PURE session geometry — independent of the flag. Given a timestamp and the two
 * edge widths, returns which edge (`open` / `close`) the timestamp falls inside, or
 * `null` if it is in the interior or outside regular hours. Gated on
 * {@link isStockMarketOpen} FIRST so a pre-open / post-close / weekend timestamp
 * (where the minutes-since/to helpers collapse to 0) never reads as an open-edge
 * hit — the blackout is an intraday overlay ON TOP of the existing RTH gate, not a
 * replacement for it. Open edge: `minutesSinceOpen < openMinutes` (first N minutes,
 * inclusive of the 9:30 bell). Close edge: `minutesToClose <= closeMinutes` (last N
 * minutes up to the 16:00 close). Open edge wins a (never-overlapping in a normal
 * 6.5h session) tie.
 */
export function sessionEdgeAt(
  utcMs: number,
  openMinutes: number,
  closeMinutes: number,
): SessionEdge | null {
  if (!isStockMarketOpen(utcMs)) return null;
  if (openMinutes > 0 && minutesSinceSessionOpen(utcMs) < openMinutes) return 'open';
  if (closeMinutes > 0 && minutesToSessionClose(utcMs) <= closeMinutes) return 'close';
  return null;
}

export interface SessionEdgeBlackoutVerdict {
  /** True iff a NEW entry should be suppressed right now (enabled AND inside an edge). */
  blocked: boolean;
  /** Which edge is active, or `null` if none / disarmed. */
  edge: SessionEdge | null;
  /** Whether the flag is armed at all (so a caller can log arm-off vs interior). */
  enabled: boolean;
  openMinutes: number;
  closeMinutes: number;
}

/**
 * The blackout verdict for opening a NEW position `now`. `blocked` is true only when
 * the flag is armed AND `now` falls inside a configured edge during regular hours.
 * DARK by default: with the flag off (the shipped default) this is always
 * `blocked:false`, so the entry paths behave byte-for-byte as before.
 */
export function sessionEdgeBlackoutVerdict(
  utcMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): SessionEdgeBlackoutVerdict {
  const enabled = isSessionEdgeBlackoutEnabled(env);
  const { openMinutes, closeMinutes } = resolveSessionEdgeBlackoutMinutes(env);
  const edge = enabled ? sessionEdgeAt(utcMs, openMinutes, closeMinutes) : null;
  return { blocked: enabled && edge !== null, edge, enabled, openMinutes, closeMinutes };
}
