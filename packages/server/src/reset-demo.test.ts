import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// TRA-348 acceptance: `/api/account/reset-demo` must NOT delete or zero
// `reports/live/<date>.json`. The route handler delegates to
// `engine.forceReset(settings)` (and the crypto equivalent); neither method
// touches the filesystem `reports/...` tree, so the invariant is preserved
// "for free." This test pins that contract: any future refactor that adds
// a filesystem wipe to forceReset would break this check loud and early.
import { SignalEngine } from './signal-engine.js';
import { PnlTracker } from './pnl-tracker.js';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';

let TMP_ROOT: string;

beforeEach(() => {
  TMP_ROOT = mkdtempSync(join(tmpdir(), 'reset-demo-test-'));
});

afterEach(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('TRA-348 — reset-demo preserves reports/live history', () => {
  it('forceReset does not delete or modify reports/live/<date>.json', () => {
    // Seed a fake live EOD report on disk that the calendar would read.
    const reportsDir = join(TMP_ROOT, 'reports', 'live');
    mkdirSync(reportsDir, { recursive: true });
    const date = '2026-05-08';
    const reportPath = join(reportsDir, `${date}.json`);
    const payload = JSON.stringify({
      date,
      generatedAt: 1715212800000,
      realizedPnl: 0,
      unrealizedPnl: 0,
      totalPnl: 0,
      optionsPnl: 15.67,
      combinedPnl: 15.67,
      totalEquity: 100_000,
      managedEquity: 50_000,
      availableCash: 50_000,
      trades: [],
      openPositionCount: 0,
      winRate: 0,
      avgRR: 0,
      totalTrades: 0,
      winners: 0,
      losers: 0,
      expectancy: 0,
      maxDrawdown: 0,
      sharpeRatio: 0,
      top5Movers: [],
      signalAccuracy: { totalSignals: 0, winningSignals: 0, winRate: 0, avgRR: 0 },
      markdown: '# placeholder',
    });
    writeFileSync(reportPath, payload, 'utf-8');

    // Spin up an engine with a tracker pointed at TMP_ROOT and run forceReset
    // — exactly what /api/account/reset-demo does for stocks.
    const tracker = new PnlTracker(TMP_ROOT, 100_000);
    const settings = { ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' as const };
    const engine = new SignalEngine(settings, tracker);

    engine.forceReset(settings);

    // The file must still exist with the same contents.
    expect(existsSync(reportPath)).toBe(true);
    expect(readFileSync(reportPath, 'utf-8')).toBe(payload);
    // Nothing else should have been written into reports/live by the reset.
    expect(readdirSync(reportsDir).sort()).toEqual([`${date}.json`]);
  });
});
