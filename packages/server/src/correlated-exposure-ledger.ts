// TRA-1301 (parent TRA-1295) — process-global, in-memory observability ledger for
// the correlated-exposure cap (Rule 5, the "7%" leg of the 3-5-7 governor).
//
// Unlike the scale-out ladder / conviction-DCA ledgers this is NOT the
// forward-validation evidence — it is an operator readout of how often the cap
// bound (scaled) or rejected an entry, and which correlated grain bound it. So it
// is a lightweight in-memory ring buffer (like the short-premium in-memory store),
// deliberately NOT durable: the counts are session-scoped diagnostics, and losing
// them on the ~daily demo reboot is acceptable. It records nothing that could open
// or size an order — every consult site owns its own gate + sizing.
//
// ── HARD INVARIANT ──────────────────────────────────────────────────────────
// OBSERVE-ONLY. This module records binding events; it NEVER places an order or
// mutates any account. The cap itself scales/rejects at the entry chokepoint; this
// is purely the surfaced record of those decisions.

import type { ExposureLevel } from '@trading-app/engine';

/** Which entry chokepoint consulted the cap. */
export type CorrelatedExposureVenue = 'equity' | 'crypto' | 'option';

/** What the cap did to the candidate at this consult. */
export type CorrelatedExposureAction = 'scaled' | 'rejected';

/** One binding event — the cap trimmed or rejected a candidate entry. */
export interface CorrelatedExposureBindingEvent {
  /** Event time, ms epoch. */
  ts: number;
  venue: CorrelatedExposureVenue;
  /** Book mode that fired the entry. */
  mode: 'demo' | 'live';
  /** The correlated grain that bound the candidate. */
  level: ExposureLevel;
  /** The bound group's key (underlying ticker / sector / asset-class). */
  key: string;
  /** Position-size multiplier the cap applied (0 ⇒ rejected). */
  scale: number;
  action: CorrelatedExposureAction;
  symbol: string;
}

/** Rolling recent-events retention for the health tail (counts stay complete). */
const MAX_RECENT_EVENTS = 50;

let events: CorrelatedExposureBindingEvent[] = [];
let scaledCount = 0;
let rejectedCount = 0;

/**
 * Record a cap binding (a scale-down or an outright reject). Called by the entry
 * chokepoints ONLY when the cap actually bound the candidate (scale < 1 or a
 * reject) — a full-size admission is not an event. Pure bookkeeping; never opens
 * or sizes anything.
 */
export function recordCorrelatedExposureBinding(
  event: Omit<CorrelatedExposureBindingEvent, 'ts'> & { ts?: number },
): void {
  const rec: CorrelatedExposureBindingEvent = {
    ts: event.ts ?? Date.now(),
    venue: event.venue,
    mode: event.mode,
    level: event.level,
    key: event.key,
    scale: event.scale,
    action: event.action,
    symbol: event.symbol,
  };
  if (rec.action === 'rejected') rejectedCount += 1;
  else scaledCount += 1;
  events.push(rec);
  if (events.length > MAX_RECENT_EVENTS) events = events.slice(-MAX_RECENT_EVENTS);
}

/** Session-scoped rollup for `/api/health` + the EOD report. */
export interface CorrelatedExposureSummary {
  bindingCount: number;
  scaledCount: number;
  rejectedCount: number;
  /** Most-recent-first tail of binding events (capped at {@link MAX_RECENT_EVENTS}). */
  recent: CorrelatedExposureBindingEvent[];
}

export function summarizeCorrelatedExposureBindings(): CorrelatedExposureSummary {
  return {
    bindingCount: scaledCount + rejectedCount,
    scaledCount,
    rejectedCount,
    recent: [...events].reverse(),
  };
}

/** Test-only reset so specs don't leak counters across cases. */
export function __resetCorrelatedExposureLedgerForTest(): void {
  events = [];
  scaledCount = 0;
  rejectedCount = 0;
}
