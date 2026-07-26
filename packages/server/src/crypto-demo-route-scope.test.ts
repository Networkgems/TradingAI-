import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TradeSignal } from '@trading-app/shared';
import { REGIME_TSMOM_DEFAULTS } from './crypto-regime-tsmom-flag.js';
import type { RegimeTsmomResult } from './crypto-regime-tsmom-scanner.js';
import {
  routeRegimeTsmomResults,
  getRegimeTsmomDemoRoutePositions,
  hydrateRegimeTsmomDemoRouteFromDisk,
  clearRegimeTsmomDemoRoute,
} from './crypto-regime-tsmom-demo-route.js';
import { demoRoutePositionsFor, mayViewFirmWideDemoRouteBook } from './crypto-demo-route-scope.js';
import { CryptoSignalEngine } from './crypto-engine.js';
import type { CryptoPaperAccount } from './crypto-account.js';

// TRA-2411 — the regime-TSMOM demo-route book is a PROCESS-GLOBAL singleton with no
// user key, and its rows were pushed into every demo account's `openPositions`.
//
// ⚠️ THE WHOLE POINT OF THIS FILE IS THAT IT RUNS AGAINST A NON-EMPTY ROUTE BOOK.
// The defect was reported latent on an EMPIRICAL zero: the book is empty today
// (crypto parked TRA-1210, TSMOM killed at n=18 TRA-1440), so a probe of a fresh
// account returns `openPositions: []` whether the isolation exists or not. A test
// that skipped the seeding would pass identically before and after the fix — this
// repo's recurring failure shape, an instrument that reads the same in the pass and
// fail state. `seedRouteBook()` opens a real routed long first, and
// `expect(...).toHaveLength(1)` on the raw accessor is asserted as a PRECONDITION in
// every case so the isolation assertions can never be vacuously true.
//
// Mutation-checked against the pre-fix code: binding the bare
// `getRegimeTsmomDemoRoutePositions` provider (i.e. reverting `index.ts`) fails the
// two "does not see" cases; returning `[]` unconditionally (i.e. deleting the
// feature instead of scoping it) fails the two "still sees" cases.

const ROUTE_SIGNAL_TYPE = 'tsmom_majors';

function enterLong(symbol: string, entry: number): RegimeTsmomResult {
  return {
    symbol,
    action: 'enter_long',
    regime: 'trend_up',
    confidence: 0.8,
    rL: 0.2,
    entryBandPct: 10,
    exitBandPct: 10,
    wouldBeEntryPrice: entry,
    lastBarTime: '2026-07-05T00:00:00.000Z',
    roundTrip: null,
    state: { position: 'long', entryPrice: entry, entryBarTime: null, entryRegime: 'trend_up' },
  };
}

/** Put a real routed long in the process-global book (AC3: never test the empty state). */
function seedRouteBook(dir: string): void {
  hydrateRegimeTsmomDemoRouteFromDisk(dir);
  const out = routeRegimeTsmomResults([enterLong('SOL', 100)], REGIME_TSMOM_DEFAULTS, 1000);
  expect(out.opened).toBe(1);
  expect(getRegimeTsmomDemoRoutePositions()).toHaveLength(1);
}

/** A bare demo engine with the TRA-2411 scoped provider bound exactly as index.ts binds it. */
function engineFor(username: string, role: 'admin' | 'user' | undefined): CryptoSignalEngine {
  const engine = new CryptoSignalEngine();
  engine.setExternalDemoPositionsProvider(() => demoRoutePositionsFor(username, role));
  return engine;
}

function routeRows(engine: CryptoSignalEngine) {
  return engine.getState().account.openPositions.filter(p => p.signalType === ROUTE_SIGNAL_TYPE);
}

let dir: string;
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  dir = mkdtempSync(join(tmpdir(), 'tra2411-route-scope-'));
  clearRegimeTsmomDemoRoute();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearRegimeTsmomDemoRoute();
  vi.restoreAllMocks();
});

describe('TRA-2411 — TSMOM demo-route book is scoped to the operator books', () => {
  // ── AC1: a non-owner does not see the firm's routed positions ────────────────
  it('a brand-new ordinary account sees NO route positions with the book NON-EMPTY', () => {
    seedRouteBook(dir);
    expect(demoRoutePositionsFor('ctoverify_tra2406', 'user')).toEqual([]);
    expect(routeRows(engineFor('ctoverify_tra2406', 'user'))).toEqual([]);
  });

  it('an ordinary NAMED account (not a QA fixture) also sees none', () => {
    // The reporter's repro account is QA-classified by design (TRA-1949). TRA-2407
    // records why that matters: a predicate that only answers "is this a fixture?"
    // returns the RIGHT answer for that one name and the wrong one for everybody
    // else. So the audience that actually matters is pinned here explicitly.
    seedRouteBook(dir);
    expect(demoRoutePositionsFor('aqua', 'user')).toEqual([]);
    expect(routeRows(engineFor('aqua', 'user'))).toEqual([]);
  });

  it('denies when the user lookup failed (undefined role) — default-deny, not default-show', () => {
    seedRouteBook(dir);
    expect(demoRoutePositionsFor('someone', undefined)).toEqual([]);
    expect(demoRoutePositionsFor(undefined, undefined)).toEqual([]);
    expect(demoRoutePositionsFor('', 'admin')).toEqual([]);
  });

  // ── AC2: the owning books still see them (the fix is a scope, not a delete) ──
  it('the admin operator book STILL sees the routed longs', () => {
    seedRouteBook(dir);
    const scoped = demoRoutePositionsFor('admin', 'admin');
    expect(scoped).toHaveLength(1);
    expect(scoped[0].symbol).toBe('SOL');
    expect(scoped[0].mode).toBe('demo');

    const rows = routeRows(engineFor('admin', 'admin'));
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe('SOL');
  });

  it('Richard is an operator book BY NAME, case-insensitively, without role admin', () => {
    // TRA-2407: only `admin` is ever seeded role:'admin' and signup defaults to
    // 'user', so a pure role gate would silently blank the second board book. The
    // repo spells him both `Richard` and `richard`.
    seedRouteBook(dir);
    expect(demoRoutePositionsFor('Richard', 'user')).toHaveLength(1);
    expect(demoRoutePositionsFor('richard', 'user')).toHaveLength(1);
    expect(routeRows(engineFor('Richard', 'user'))).toHaveLength(1);
  });

  it('env can WIDEN the operator set but never empty it', () => {
    seedRouteBook(dir);
    const widened = { DEMO_CALENDAR_OPERATOR_BOOKS: 'boardviewer' } as unknown as NodeJS.ProcessEnv;
    expect(demoRoutePositionsFor('boardviewer', 'user', widened)).toHaveLength(1);
    // ...and the builtins survive a hostile/blank env (TRA-2136/2193 wipes).
    const emptied = { DEMO_CALENDAR_OPERATOR_BOOKS: '' } as unknown as NodeJS.ProcessEnv;
    expect(demoRoutePositionsFor('admin', 'admin', emptied)).toHaveLength(1);
    expect(demoRoutePositionsFor('boardviewer', 'user', emptied)).toEqual([]);
  });

  // ── Negative control: scoping the FIRM's book does not blank the USER's own ──
  it("a denied account still sees its OWN demo book — the scope removes only the firm's rows", () => {
    seedRouteBook(dir);
    const engine = engineFor('aqua', 'user');
    const own = (engine as unknown as { account: CryptoPaperAccount }).account;
    const signal: TradeSignal = {
      id: 'own-1',
      symbol: 'BTC-USD',
      type: 'breakout_vol',
      side: 'buy',
      entryPrice: 100,
      stopLoss: 98,
      takeProfit: 108,
      riskRewardRatio: 4,
      timestamp: 1000,
      mode: 'demo',
    };
    expect(own.openPosition(signal, 100, 'coinbase')).not.toBeNull();

    const positions = engine.getState().account.openPositions;
    expect(positions.map(p => p.symbol)).toEqual(['BTC-USD']);
    expect(positions.every(p => p.signalType !== ROUTE_SIGNAL_TYPE)).toBe(true);
  });

  // ── The predicate itself ─────────────────────────────────────────────────────
  it('mayViewFirmWideDemoRouteBook is default-deny and admin/operator-allow', () => {
    expect(mayViewFirmWideDemoRouteBook('admin', 'admin')).toBe(true);
    expect(mayViewFirmWideDemoRouteBook('Richard', 'user')).toBe(true);
    expect(mayViewFirmWideDemoRouteBook('promoted_user', 'admin')).toBe(true);
    expect(mayViewFirmWideDemoRouteBook('aqua', 'user')).toBe(false);
    expect(mayViewFirmWideDemoRouteBook('monitorly', 'user')).toBe(false);
    expect(mayViewFirmWideDemoRouteBook(null, null)).toBe(false);
  });

  it('the scope is re-evaluated per call, so a role change cannot leave it stale', () => {
    // index.ts binds a CLOSURE, not a decision made once at attach time. Proven by
    // flipping the role behind the same engine instance.
    seedRouteBook(dir);
    let role: 'admin' | 'user' = 'admin';
    const engine = new CryptoSignalEngine();
    engine.setExternalDemoPositionsProvider(() => demoRoutePositionsFor('promoted_user', role));
    expect(routeRows(engine)).toHaveLength(1);
    role = 'user';
    expect(routeRows(engine)).toEqual([]);
  });
});
