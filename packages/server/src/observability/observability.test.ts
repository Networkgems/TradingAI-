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
  getAlertingPosture,
  dispatchAlert,
  runHealthCheck,
  recordBootAndCheckRestarts,
  checkTradeVolume,
  checkErrorSpike,
  checkDiskSpace,
  readDiskSpace,
  diskMinFreePct,
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

// TRA-2136 — alerting posture surfaced no-auth at /api/health/alerting. The
// SMTP secrets could not be restored after the Render env-var wipe, so this
// verifies the "no push channel → observable degraded fallback" contract that
// the fix depends on, rather than a silent hole.
describe('alerting posture', () => {
  beforeEach(() => __resetAlertsForTest());

  it('reports the degraded fallback when no push channel is configured', () => {
    // The server test env carries no SMTP/webhook creds, so push is unconfigured.
    const p = getAlertingPosture();
    expect(p.pushAlertingConfigured).toBe(false);
    expect(p.degradedTo).toBe('log+ring+poll');
    expect(p.channels.email.configured).toBe(false);
    expect(p.channels.webhook.configured).toBe(false);
  });

  it('summarizes the recent ring by key without leaking alert detail', () => {
    dispatchAlert('health-check', 'critical', 'down', { host: 'secret-host' });
    dispatchAlert('disk-near-full', 'critical', 'low');
    const p = getAlertingPosture();
    expect(p.recent.total).toBe(2);
    expect(p.recent.byKey['health-check']).toBe(1);
    expect(p.recent.byKey['disk-near-full']).toBe(1);
    expect(p.recent.newestKey).toBe('disk-near-full');
    expect(p.recent.newestTs).toBeTruthy();
    // Posture is a count-only summary — it must not carry the alert `detail`
    // (host/path info) that keeps /api/health/alerts auth-gated.
    expect(JSON.stringify(p)).not.toContain('secret-host');
  });

  it('reports an empty ring cleanly after reset', () => {
    const p = getAlertingPosture();
    expect(p.recent.total).toBe(0);
    expect(p.recent.newestKey).toBeNull();
    expect(p.recent.newestTs).toBeNull();
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

// TRA-2357 — the 2026-07-25T20:33:34Z bqb1 CRITICAL was
// `disk-near-full: Disk 16.3% free — below 99%`: a healthy disk (166.7 MB free of
// 1020.7 MB) graded against a 99%-free threshold. The alert TEXT and the alert
// DETAIL are the only records that survive a reboot — the in-memory ring does not —
// so the threshold has to travel with the reading, and the read-only surface has to
// be readable without firing anything.
describe('disk-space reading (TRA-2357)', () => {
  beforeEach(() => {
    __resetAlertsForTest();
    delete process.env['DISK_MIN_FREE_PCT'];
  });

  it('reads headroom on a real path WITHOUT dispatching — an anonymous poll must not burn the alert throttle', async () => {
    // Threshold at 100% free: any real filesystem is "below" it, so a reader that
    // shared checkDiskSpace's code path would fire here.
    process.env['DISK_MIN_FREE_PCT'] = '100';
    const reading = await readDiskSpace(process.cwd());
    expect(reading).not.toBeNull();
    expect(reading!.totalBytes).toBeGreaterThan(0);
    expect(reading!.freePct).toBeGreaterThanOrEqual(0);
    expect(getRecentAlerts()).toHaveLength(0);

    // The same path through checkDiskSpace DOES alert — proving the assertion
    // above measures purity and not simply a healthy disk.
    await checkDiskSpace(process.cwd());
    expect(getRecentAlerts()).toHaveLength(1);
    expect(getRecentAlerts()[0]!.key).toBe('disk-near-full');
  });

  it('carries the effective threshold in the alert detail, so a bad threshold is distinguishable from a full disk', async () => {
    process.env['DISK_MIN_FREE_PCT'] = '99';
    await checkDiskSpace(process.cwd());
    const alert = getRecentAlerts()[0]!;
    expect(alert.detail?.['minFreePct']).toBe(99);
    expect(alert.message).toContain('below 99%');
  });

  it('does not alert on a healthy disk at the default 10% threshold', async () => {
    const reading = await readDiskSpace(process.cwd());
    // Only meaningful when the test host actually has headroom.
    if (reading && reading.freePct >= 10) {
      await checkDiskSpace(process.cwd());
      expect(getRecentAlerts()).toHaveLength(0);
    }
  });

  it('defaults the threshold to 10 and honours the env override', () => {
    expect(diskMinFreePct()).toBe(10);
    process.env['DISK_MIN_FREE_PCT'] = '25';
    expect(diskMinFreePct()).toBe(25);
  });

  it('returns null rather than throwing when the path does not exist', async () => {
    expect(await readDiskSpace('/definitely/not/a/real/mount/tra2357')).toBeNull();
    expect(await checkDiskSpace('/definitely/not/a/real/mount/tra2357')).toBeNull();
    expect(getRecentAlerts()).toHaveLength(0);
  });
});
