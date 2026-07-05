import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { REGIME_TSMOM_DEFAULTS } from './crypto-regime-tsmom-flag.js';
import type { RegimeTsmomResult, RegimeTsmomState } from './crypto-regime-tsmom-scanner.js';
import {
  routeRegimeTsmomResults,
  getRegimeTsmomDemoRoutePositions,
  summarizeRegimeTsmomDemoRoute,
  hydrateRegimeTsmomDemoRouteFromDisk,
  clearRegimeTsmomDemoRoute,
  regimeTsmomDemoRouteFillsPath,
  regimeTsmomDemoRouteStatePath,
} from './crypto-regime-tsmom-demo-route.js';

// TRA-1317 — DEMO paper routing of the regime-gated TSMOM scanner. These tests
// prove: enter_long/exit_long transitions produce paper fills in the isolated route
// book, the book's open longs surface for the dashboard, realized-R accrues off the
// scanner's round trips, and the JSONL + snapshot survive a restart. DEMO-only — the
// route book has no live path.

const FLAT: RegimeTsmomState = { position: 'flat', entryPrice: null, entryBarTime: null, entryRegime: null };
const LONG: RegimeTsmomState = { position: 'long', entryPrice: 100, entryBarTime: null, entryRegime: 'trend_up' };

function result(symbol: string, over: Partial<RegimeTsmomResult> = {}): RegimeTsmomResult {
  return {
    symbol,
    action: 'flat',
    regime: 'trend_up',
    confidence: 0.8,
    rL: 0.2,
    entryBandPct: 10,
    exitBandPct: 10,
    wouldBeEntryPrice: null,
    lastBarTime: '2026-07-05T00:00:00.000Z',
    roundTrip: null,
    state: FLAT,
    ...over,
  };
}

function enterLong(symbol: string, entry: number): RegimeTsmomResult {
  return result(symbol, {
    action: 'enter_long',
    wouldBeEntryPrice: entry,
    state: { position: 'long', entryPrice: entry, entryBarTime: null, entryRegime: 'trend_up' },
  });
}

function exitLong(symbol: string, entry: number, exit: number): RegimeTsmomResult {
  return result(symbol, {
    action: 'exit_long',
    wouldBeEntryPrice: null,
    state: FLAT,
    roundTrip: {
      side: 'long',
      entryPrice: entry,
      exitPrice: exit,
      entryBarTime: null,
      exitBarTime: '2026-07-05T04:00:00.000Z',
      entryRegime: 'trend_up',
      grossMovePct: ((exit / entry - 1) * 100),
      netMovePct: 8,
      netR: 0.75,
    },
  });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'regime-tsmom-route-'));
  clearRegimeTsmomDemoRoute();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearRegimeTsmomDemoRoute();
});

describe('routeRegimeTsmomResults', () => {
  it('opens a paper long on enter_long and surfaces it for the dashboard', () => {
    hydrateRegimeTsmomDemoRouteFromDisk(dir);
    const out = routeRegimeTsmomResults([enterLong('SOL', 100)], REGIME_TSMOM_DEFAULTS, 1000);
    expect(out.opened).toBe(1);
    expect(out.closed).toBe(0);
    const positions = getRegimeTsmomDemoRoutePositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].symbol).toBe('SOL');
    expect(positions[0].side).toBe('buy');
    expect(positions[0].mode).toBe('demo');
    expect(positions[0].quantity).toBeGreaterThan(0);
  });

  it('does not double-open when already long (single transition per bar)', () => {
    hydrateRegimeTsmomDemoRouteFromDisk(dir);
    routeRegimeTsmomResults([enterLong('SOL', 100)], REGIME_TSMOM_DEFAULTS, 1000);
    const again = routeRegimeTsmomResults([enterLong('SOL', 105)], REGIME_TSMOM_DEFAULTS, 2000);
    expect(again.opened).toBe(0);
    expect(getRegimeTsmomDemoRoutePositions()).toHaveLength(1);
  });

  it('closes on exit_long and accrues the scanner net-of-taker R', () => {
    hydrateRegimeTsmomDemoRouteFromDisk(dir);
    routeRegimeTsmomResults([enterLong('SOL', 100)], REGIME_TSMOM_DEFAULTS, 1000);
    const out = routeRegimeTsmomResults([exitLong('SOL', 100, 112)], REGIME_TSMOM_DEFAULTS, 2000);
    expect(out.closed).toBe(1);
    expect(getRegimeTsmomDemoRoutePositions()).toHaveLength(0);
    const s = summarizeRegimeTsmomDemoRoute();
    expect(s.openPositions).toBe(0);
    expect(s.closeCount).toBe(1);
    expect(s.fillCount).toBe(2);
    expect(s.realizedR).toBeCloseTo(0.75, 5);
  });

  it('is a no-op on non-transition actions', () => {
    hydrateRegimeTsmomDemoRouteFromDisk(dir);
    const out = routeRegimeTsmomResults(
      [result('BTC', { action: 'hold_long', state: LONG }), result('ETH', { action: 'short_observe' })],
      REGIME_TSMOM_DEFAULTS,
      1000,
    );
    expect(out.opened).toBe(0);
    expect(out.closed).toBe(0);
    expect(summarizeRegimeTsmomDemoRoute().fillCount).toBe(0);
  });
});

describe('persistence / restart safety', () => {
  it('survives a restart: an open paper long + counters reload from the snapshot', () => {
    hydrateRegimeTsmomDemoRouteFromDisk(dir);
    routeRegimeTsmomResults([enterLong('SOL', 100), enterLong('BCH', 400)], REGIME_TSMOM_DEFAULTS, 1000);
    routeRegimeTsmomResults([exitLong('BCH', 400, 440)], REGIME_TSMOM_DEFAULTS, 2000);
    expect(existsSync(regimeTsmomDemoRouteStatePath(dir))).toBe(true);
    expect(existsSync(regimeTsmomDemoRouteFillsPath(dir))).toBe(true);

    // Simulate a redeploy: clear in-memory state, then hydrate from disk.
    const h = hydrateRegimeTsmomDemoRouteFromDisk(dir);
    expect(h.openPositions).toBe(1); // SOL still open, BCH closed
    expect(h.fillCount).toBe(3); // 2 opens + 1 close
    expect(h.closeCount).toBe(1);

    const positions = getRegimeTsmomDemoRoutePositions();
    expect(positions.map((p) => p.symbol).sort()).toEqual(['SOL']);
    // The reloaded book can still be routed: SOL exits cleanly.
    const out = routeRegimeTsmomResults([exitLong('SOL', 100, 108)], REGIME_TSMOM_DEFAULTS, 3000);
    expect(out.closed).toBe(1);
    expect(getRegimeTsmomDemoRoutePositions()).toHaveLength(0);
  });

  it('writes one JSONL audit line per fill event', () => {
    hydrateRegimeTsmomDemoRouteFromDisk(dir);
    routeRegimeTsmomResults([enterLong('SOL', 100)], REGIME_TSMOM_DEFAULTS, 1000);
    routeRegimeTsmomResults([exitLong('SOL', 100, 110)], REGIME_TSMOM_DEFAULTS, 2000);
    const lines = readFileSync(regimeTsmomDemoRouteFillsPath(dir), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const open = JSON.parse(lines[0]);
    const close = JSON.parse(lines[1]);
    expect(open.event).toBe('open');
    expect(close.event).toBe('close');
    expect(close.netR).toBeCloseTo(0.75, 5);
  });
});
