// TRA-4501 — `/api/options/alerts` must scan the book the dashboard SHOWS.
//
// Before: the route read `ctx.engine.getState()` (the ROUTING book) while
// `/api/state` — the open-options table directly above the alerts panel — read
// the VIEW book (`viewMode`, TRA-3910). A test where view == routing passes
// either way, so every case below splits the two: routing `live`, viewing
// `demo`, with the stop-breached row in exactly ONE book. Each case also runs
// the pre-fix read (`getState()` with no view) as its negative control, so the
// test is proven to tell the broken route from the fixed one.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNT_SETTINGS, type AccountSettings, type OptionPosition } from '@trading-app/shared';
import type { ChainDay } from '@trading-app/backtest';
import { SignalEngine } from './signal-engine.js';
import { buildOptionsAlertsBody, dashboardBookViewFor } from './options-alerts-book.js';

const routingLiveViewingDemo: Pick<AccountSettings, 'mode' | 'viewMode'> = { mode: 'live', viewMode: 'demo' };

// Mark 0.50 is under the 0.75 hard stop, so `scanTargetStop` emits one stop_hit.
const stopBreached = (id: string, symbol: string, mode: 'demo' | 'live'): OptionPosition => ({
  id, symbol, mode, optionType: 'call', strike: 100, expiration: '2026-10-16',
  contracts: 1, contractsRemaining: 1, premiumPaid: 1.0, currentPremium: 0.5,
  tp1Premium: 1.25, tp1Hit: false, stopLossPremium: 0.75, peakPremium: 1.0,
  trailingActive: false, trailingStopPremium: 0, underlyingEntryPrice: 100,
  openedAt: 1, signalId: 's1', signalType: 'momentum',
} as OptionPosition);

type Seedable = { optionsAccount: { openOptions: Map<string, OptionPosition> } };

function liveEngineWith(...rows: OptionPosition[]): SignalEngine {
  const e = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'live' } as AccountSettings);
  for (const r of rows) (e as unknown as Seedable).optionsAccount.openOptions.set(r.id, r);
  return e;
}

// Both route paths: <2 chain partitions (target/stop only) and the full diff.
const NO_DAYS: ChainDay[] = [];
const TWO_DAYS = [
  { date: '2026-09-09', bySymbol: new Map() },
  { date: '2026-09-10', bySymbol: new Map() },
] as unknown as ChainDay[];

const stopSymbols = (body: ReturnType<typeof buildOptionsAlertsBody>) =>
  body.alerts.filter((a) => a.kind === 'stop_hit').map((a) => a.symbol);

describe('TRA-4501 — alerts scan the dashboard book, not the routing book', () => {
  it('meta-control: routing live + viewing demo resolves to the demo book; view == routing resolves to the default', () => {
    expect(dashboardBookViewFor(routingLiveViewingDemo)).toBe('demo');
    expect(dashboardBookViewFor({ mode: 'live', viewMode: 'live' })).toBeUndefined();
    expect(dashboardBookViewFor({ mode: 'live', viewMode: null })).toBeUndefined();
    expect(dashboardBookViewFor({ mode: 'demo', viewMode: 'live' })).toBe('live');
  });

  for (const [label, days] of [['<2 partitions', NO_DAYS], ['2 partitions', TWO_DAYS]] as const) {
    it(`[${label}] a stop breach in the VIEW (demo) book comes back`, () => {
      const e = liveEngineWith(stopBreached('d1', 'DEMOSTOP', 'demo'));
      const state = e.getState(dashboardBookViewFor(routingLiveViewingDemo));
      const body = buildOptionsAlertsBody(days, state.options.openOptions, state.bookView);
      expect(body.bookView).toBe('demo');
      expect(stopSymbols(body)).toEqual(['DEMOSTOP']);
      expect(body.counts.stop_hit).toBe(1);
      expect(body.alerts[0].severity).toBe('action');

      // Negative control — the pre-fix read (routing book) misses it.
      const old = e.getState();
      expect(old.bookView).toBe('live');
      expect(stopSymbols(buildOptionsAlertsBody(days, old.options.openOptions, old.bookView))).toEqual([]);
    });

    it(`[${label}] a stop breach in the ROUTING (live) book only does NOT come back`, () => {
      const e = liveEngineWith(stopBreached('l1', 'LIVESTOP', 'live'));
      const state = e.getState(dashboardBookViewFor(routingLiveViewingDemo));
      const body = buildOptionsAlertsBody(days, state.options.openOptions, state.bookView);
      expect(stopSymbols(body)).toEqual([]);
      expect(body.counts.stop_hit).toBe(0);

      // Negative control — the pre-fix read surfaces a row the table is not showing.
      const old = e.getState();
      expect(stopSymbols(buildOptionsAlertsBody(days, old.options.openOptions, old.bookView))).toEqual(['LIVESTOP']);
    });
  }

  it('alerts and the /api/state table read the same rows for the same settings', () => {
    const e = liveEngineWith(stopBreached('d1', 'DEMOSTOP', 'demo'), stopBreached('l1', 'LIVESTOP', 'live'));
    const state = e.getState(dashboardBookViewFor(routingLiveViewingDemo));
    const tableSymbols = state.options.openOptions.map((o) => o.symbol);
    const body = buildOptionsAlertsBody(NO_DAYS, state.options.openOptions, state.bookView);
    expect(tableSymbols).toEqual(['DEMOSTOP']);
    expect(stopSymbols(body)).toEqual(tableSymbols);
  });
});

describe('TRA-4501 — index.ts wires the route through the dashboard book', () => {
  // The cases above grade the helper; this pins the route actually calling it.
  // Reverting the route to `ctx.engine.getState()` fails here.
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');
  const start = src.indexOf("app.get('/api/options/alerts'");
  const route = src.slice(start, src.indexOf('\napp.', start + 1));

  it('the alerts route reads dashboardEngineState(ctx) and never the routing book', () => {
    expect(start).toBeGreaterThan(-1);
    expect(route).toContain('dashboardEngineState(ctx)');
    expect(route).toContain('buildOptionsAlertsBody(');
    expect(route).not.toMatch(/ctx\.engine\.getState\(/);
  });

  it('/api/state resolves its book with the same helper', () => {
    expect(src).toMatch(/function resolveDashboardBookView[\s\S]{0,200}?dashboardBookViewFor\(getSettings\(username\)\)/);
  });
});
