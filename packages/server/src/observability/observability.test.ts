// TRA-406 — observability test suite.
//
// Covers the acceptance criteria for the issue:
//   • errors surface in a queryable destination with trace correlation;
//   • an alert fires on a simulated health-check failure;
//   • the trade audit tracker records opens and closes.

import { describe, it, expect, beforeEach } from 'vitest';
import { runWithTrace, getTraceContext } from './trace.js';
import { captureException, getErrorCountSince } from './errors.js';
import { TradeAuditTracker, getTradeOpenCount } from './audit.js';
import {
  __resetAlertsForTest,
  getRecentAlerts,
  dispatchAlert,
  runHealthCheck,
  recordBootAndCheckRestarts,
  checkTradeVolume,
  checkErrorSpike,
} from './alerts.js';

describe('trace context', () => {
  it('threads a trace id through the async chain', () => {
    expect(getTraceContext()).toBeUndefined();
    runWithTrace({ traceId: 'trace-123', username: 'alice' }, () => {
      const ctx = getTraceContext();
      expect(ctx?.traceId).toBe('trace-123');
      expect(ctx?.username).toBe('alice');
    });
    // Context does not leak outside the `runWithTrace` scope.
    expect(getTraceContext()).toBeUndefined();
  });

  it('generates a trace id when none is supplied', () => {
    runWithTrace({}, () => {
      expect(getTraceContext()?.traceId).toBeTruthy();
    });
  });
});

describe('error telemetry', () => {
  it('captures an exception and correlates it to the active trace', () => {
    const before = getErrorCountSince();
    let captured: string | undefined;
    runWithTrace({ traceId: 'err-trace-1' }, () => {
      captured = captureException(new Error('boom'), 'unit-test.scope', { symbol: 'BTC-USD' });
    });
    expect(captured).toBe('err-trace-1');
    expect(getErrorCountSince()).toBe(before + 1);
  });

  it('handles a non-Error throwable', () => {
    expect(() => captureException('string failure', 'unit-test.scope')).not.toThrow();
  });
});

describe('alerting', () => {
  beforeEach(() => __resetAlertsForTest());

  it('fires a critical alert on a simulated health-check failure', async () => {
    const ok = await runHealthCheck(async () => false);
    expect(ok).toBe(false);
    const alerts = getRecentAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.key).toBe('health-check');
    expect(alerts[0]?.severity).toBe('critical');
  });

  it('does not alert when the health probe is OK', async () => {
    const ok = await runHealthCheck(async () => true);
    expect(ok).toBe(true);
    expect(getRecentAlerts()).toHaveLength(0);
  });

  it('alerts when a health probe throws', async () => {
    await runHealthCheck(async () => {
      throw new Error('connection refused');
    });
    expect(getRecentAlerts()[0]?.key).toBe('health-check');
  });

  it('throttles repeated alerts of the same key', () => {
    expect(dispatchAlert('disk-near-full', 'critical', 'first')).toBe(true);
    expect(dispatchAlert('disk-near-full', 'critical', 'second')).toBe(false);
    expect(getRecentAlerts()).toHaveLength(1);
  });

  it('alerts on a restart storm', async () => {
    const now = Date.now();
    const history = Array.from({ length: 6 }, (_, i) => now - i * 30_000);
    const result = await recordBootAndCheckRestarts({
      maxBoots: 5,
      windowMs: 10 * 60_000,
      history,
      persist: async () => undefined,
    });
    expect(result.bootsInWindow).toBe(7);
    expect(result.alerted).toBe(true);
    expect(getRecentAlerts()[0]?.key).toBe('restart-storm');
  });

  it('does not alert on a normal boot count', async () => {
    const result = await recordBootAndCheckRestarts({
      maxBoots: 5,
      history: [Date.now() - 60_000],
      persist: async () => undefined,
    });
    expect(result.alerted).toBe(false);
  });

  it('alerts on zero trade volume past noon on a market day', () => {
    expect(
      checkTradeVolume({ tradeCountToday: 0, etHour: 14, isMarketDay: true }),
    ).toBe(true);
    expect(getRecentAlerts()[0]?.key).toBe('trade-volume-zero');
  });

  it('does not alert on zero volume before the threshold hour', () => {
    expect(
      checkTradeVolume({ tradeCountToday: 0, etHour: 9, isMarketDay: true }),
    ).toBe(false);
  });

  it('does not alert on zero volume on a non-market day', () => {
    expect(
      checkTradeVolume({ tradeCountToday: 0, etHour: 14, isMarketDay: false }),
    ).toBe(false);
  });

  it('alerts on an error spike above threshold', () => {
    expect(checkErrorSpike(30, 25)).toBe(true);
    expect(checkErrorSpike(10, 25)).toBe(false);
  });
});

describe('trade audit tracker', () => {
  const pos = (id: string) => ({ id, symbol: 'AAPL', side: 'long', entryPrice: 100, quantity: 1 });

  it('does not audit positions that existed at boot', () => {
    const tracker = new TradeAuditTracker('alice', 'equity');
    const before = getTradeOpenCount();
    tracker.observe({ account: { openPositions: [pos('p1')] }, closedPositions: [] });
    expect(getTradeOpenCount()).toBe(before); // bootstrap only
  });

  it('records a newly opened position', () => {
    const tracker = new TradeAuditTracker('alice', 'equity');
    tracker.observe({ account: { openPositions: [] }, closedPositions: [] });
    const before = getTradeOpenCount();
    tracker.observe({ account: { openPositions: [pos('p2')] }, closedPositions: [] });
    expect(getTradeOpenCount()).toBe(before + 1);
  });

  it('records a close without throwing when a position leaves the open book', () => {
    const tracker = new TradeAuditTracker('alice', 'equity');
    tracker.observe({ account: { openPositions: [] }, closedPositions: [] });
    tracker.observe({ account: { openPositions: [pos('p3')] }, closedPositions: [] });
    expect(() =>
      tracker.observe({
        account: { openPositions: [] },
        closedPositions: [{ ...pos('p3'), exitPrice: 110, pnl: 10 }],
      }),
    ).not.toThrow();
  });
});
