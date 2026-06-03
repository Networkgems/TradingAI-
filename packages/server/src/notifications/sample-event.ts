// TRA-566 (TRA-410 A2) — sample alert event for the "Send test" button.
//
// The test-send endpoint delivers this representative event through a single
// chosen channel so the user can confirm a channel is wired before any real
// trade fires. Mirrors the §1.4 sample payload (an exit on a live position).

import type { ExitAlertEvent } from './dispatcher.js';

/** A representative exit event used by `POST /api/notifications/test`. */
export function buildSampleAlertEvent(username: string, now: number = Date.now()): ExitAlertEvent {
  return {
    kind: 'exit',
    username,
    timestamp: now,
    symbol: 'ETH-USD',
    market: 'crypto',
    mode: 'demo',
    exitReason: 'take-profit @ 3,142.50',
    pnl: 84.2,
    pnlR: 1.32,
    strategy: 'mean-reversion (test)',
    // Per-send dedup key so two quick test clicks aren't collapsed by the
    // dispatcher's dedup window (the test endpoint bypasses the dispatcher, but
    // a stable, descriptive key keeps the event self-documenting).
    dedupKey: `test:${now}`,
  };
}
