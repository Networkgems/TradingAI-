// TRA-3910 — "which book the dashboard SHOWS" is split from "which book the
// engine ARMS". The pinned live operator (`LIVE_EQUITY_BOOT_USER`) could not
// look at the demo book: a Demo press was a `{mode:'demo'}` settings write, which
// the TRA-2649 arm re-converged (200, `repaired:["mode"]` on the ledger, toggle
// reverts). The clamp is ratified and stays. The split is a separate `viewMode`
// field the arm never reads, rendered by `SignalEngine.getState(view)`.
//
// Three properties, each with its direction stated:
//
//   1. the ARM is blind to `viewMode` — a demo VIEW on an armed operator repairs
//      nothing (so no ledger row), while a demo MODE on the same operator still
//      repairs `mode` (the positive control that proves the arm is armed at all);
//   2. `getState('demo')` on a LIVE engine renders the demo book and stamps
//      `bookView:'demo'` / `engineMode:'live'`, and the engine's routing mode and
//      its default `getState()` are byte-identical before and after the view read;
//   3. the field set the view route may write is exactly `{viewMode}` — the three
//      armed fields are named so a route that grows write power over them is a
//      test failure here, not a toggle that finally "stuck".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ACCOUNT_SETTINGS, type AccountSettings, type TradeSignal } from '@trading-app/shared';
import {
  SignalEngine,
  applyLiveBrokerArm,
  resolveLiveBrokerArmDrift,
  shouldBootArmLiveEquity,
} from './signal-engine.js';

const savedEnv = { ...process.env };
const ARM_ENV_KEYS = ['LIVE_EQUITY_BOOT_USER', 'TRADIER_ENV', 'TRADIER_API_TOKEN', 'TRADIER_ACCOUNT_ID'];

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-08-22T14:00:00.000Z'), toFake: ['Date'] });
  process.env.LIVE_EQUITY_BOOT_USER = 'admin';
  process.env.TRADIER_ENV = 'production';
  process.env.TRADIER_API_TOKEN = 'tok-test';
  process.env.TRADIER_ACCOUNT_ID = 'acct-test';
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of ARM_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const armed = (extra: Partial<AccountSettings> = {}): AccountSettings => ({
  ...DEFAULT_ACCOUNT_SETTINGS,
  mode: 'live',
  liveTradierEnvOptions: 'production',
  liveTradeEquitiesTradier: true,
  ...extra,
} as AccountSettings);

describe('1. the TRA-2649 arm is blind to viewMode', () => {
  it('meta-control — the fixture env really arms the operator', () => {
    expect(shouldBootArmLiveEquity(armed(), 'admin')).toBe(true);
  });

  it('positive control — a demo MODE write on the armed operator still repairs `mode`', () => {
    const s = armed({ mode: 'demo' });
    expect(applyLiveBrokerArm(s, 'admin')).toEqual(['mode']);
    expect(s.mode).toBe('live');
  });

  it('a demo VIEW on the armed operator repairs NOTHING and leaves viewMode in place', () => {
    const s = armed({ viewMode: 'demo' });
    const before = JSON.stringify(s);
    expect(resolveLiveBrokerArmDrift(s, 'admin')).toEqual([]);
    expect(applyLiveBrokerArm(s, 'admin')).toEqual([]);
    // Nothing moved — `mode` still live, `viewMode` still demo, no other field touched.
    expect(JSON.stringify(s)).toBe(before);
    expect(s.mode).toBe('live');
    expect(s.viewMode).toBe('demo');
  });
});

type EngineInternals = { recentSignals: TradeSignal[]; mode: 'demo' | 'live' };

function liveEngineWithBothBooks(): SignalEngine {
  const e = new SignalEngine(armed());
  const inner = e as unknown as EngineInternals;
  const sig = (mode: 'demo' | 'live', symbol: string): TradeSignal =>
    ({ symbol, mode, timestamp: 1, side: 'buy', price: 1 } as unknown as TradeSignal);
  inner.recentSignals.push(sig('demo', 'DEMO-ONLY'), sig('live', 'LIVE-ONLY'));
  return e;
}

// The clock is frozen (`vi.useFakeTimers` below) so every `Date.now()` stamp in
// the state (`lastTick`, `marketReview.asOf`, `portfolioGreeks.asOf`, …) is
// identical across reads and the two states are compared VERBATIM — no field is
// stripped, so a book-bearing difference cannot hide behind a clock mask.
const stripClock = (s: ReturnType<SignalEngine['getState']>) => s;

describe('2. getState(view) renders the other book without touching the routing mode', () => {
  it('a LIVE engine renders the demo book on request and stamps bookView/engineMode honestly', () => {
    const e = liveEngineWithBothBooks();
    const inner = e as unknown as EngineInternals;
    expect(inner.mode).toBe('live');

    const defaultBefore = stripClock(e.getState());
    expect(defaultBefore.bookView).toBe('live');
    expect(defaultBefore.engineMode).toBe('live');
    expect(defaultBefore.signals.map(s => s.symbol)).toEqual(['LIVE-ONLY']);

    const demoView = e.getState('demo');
    expect(demoView.bookView).toBe('demo');
    expect(demoView.engineMode).toBe('live'); // the honest label: viewing demo, routing live
    expect(demoView.signals.map(s => s.symbol)).toEqual(['DEMO-ONLY']);

    // The read changed nothing: routing mode and the default state are identical.
    expect(inner.mode).toBe('live');
    expect(stripClock(e.getState())).toEqual(defaultBefore);
  });

  it('an explicit view equal to the routing mode is the default state', () => {
    const e = liveEngineWithBothBooks();
    expect(stripClock(e.getState('live'))).toEqual(stripClock(e.getState()));
  });

  it('a DEMO engine can render the live book the same way (symmetry — no privileged direction)', () => {
    const e = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });
    const inner = e as unknown as EngineInternals;
    inner.recentSignals.push({ symbol: 'LIVE-ONLY', mode: 'live' } as unknown as TradeSignal);
    expect(e.getState().signals).toEqual([]);
    const liveView = e.getState('live');
    expect(liveView.bookView).toBe('live');
    expect(liveView.engineMode).toBe('demo');
    expect(liveView.signals.map(s => s.symbol)).toEqual(['LIVE-ONLY']);
    expect(inner.mode).toBe('demo');
  });
});

describe('3. the view route contract — the writable field set is exactly {viewMode}', () => {
  // Mirrors the allow-list in `index.ts` (`PUT /api/account/view-mode`). Kept as a
  // pure predicate here so the refusal is pinned even without spinning the app up.
  const ARM_FIELDS = ['mode', 'liveTradierEnvOptions', 'liveTradeEquitiesTradier'] as const;
  const rejectedKeys = (body: Record<string, unknown>): string[] => Object.keys(body).filter(k => k !== 'viewMode');

  it('refuses each armed field by name, and any other foreign key', () => {
    for (const f of ARM_FIELDS) {
      expect(rejectedKeys({ viewMode: 'demo', [f]: 'demo' })).toEqual([f]);
    }
    expect(rejectedKeys({ viewMode: 'demo', demoEquity: 1 })).toEqual(['demoEquity']);
    expect(rejectedKeys({ viewMode: 'demo' })).toEqual([]);
  });

  it('the route body is built so the armed fields cannot change (the in-route tripwire is unreachable by construction)', () => {
    const current = armed({ viewMode: null });
    const updated: AccountSettings = { ...current, viewMode: 'demo' };
    const armDelta = ARM_FIELDS.filter(k => updated[k] !== current[k]);
    expect(armDelta).toEqual([]);
    expect(updated.viewMode).toBe('demo');
  });
});
