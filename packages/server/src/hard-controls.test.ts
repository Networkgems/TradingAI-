// TRA-4655 — every one of the seven hard controls proven to BLOCK, not just
// to exist. Each control gets (a) a refusal on the breach input, (b) an allow
// just inside the limit, and the module gets its fail-closed story graded:
// unreadable state refuses everything, latches survive a re-hydrate.

import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetHardControlsForTest,
  admitOrderThroughHardControls,
  engageHardKillSwitch,
  getHardControlsState,
  HARD_CONTROLS_STATE_FILENAME,
  HARD_DAILY_LOSS_LIMIT_USD,
  HARD_MAX_OPEN_POSITIONS,
  HARD_MAX_ORDER_NOTIONAL_USD,
  HARD_MAX_QUOTE_AGE_MS,
  hydrateHardControlsFromDisk,
  recordHardControlsPnl,
  registerForceCloseHandler,
  releaseHardKillSwitch,
  requestForceCloseAll,
  type HardControlIntent,
} from './hard-controls.js';

// A weekday mid-session instant: 2026-09-16 14:00 ET.
const NOW = Date.parse('2026-09-16T18:00:00.000Z');

let dataDir: string;
let keySeq = 0;

function intent(overrides: Partial<HardControlIntent> = {}): HardControlIntent {
  return {
    kind: 'open',
    notionalUsd: 150,
    openPositionCount: 0,
    quoteAsOfMs: NOW - 1_000,
    idempotencyKey: `k-${++keySeq}`,
    ...overrides,
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'hard-controls-'));
  __resetHardControlsForTest({ dataDir, nowMs: NOW });
  hydrateHardControlsFromDisk(NOW);
});

describe('control 1 — global kill switch', () => {
  it('blocks the very next open after engage (synchronous, well under 1s)', () => {
    expect(admitOrderThroughHardControls(intent(), NOW).allowed).toBe(true);
    engageHardKillSwitch('cto', 'drill', NOW);
    const v = admitOrderThroughHardControls(intent(), NOW + 1);
    expect(v.allowed).toBe(false);
    expect(v.reasonCode).toBe('kill_switch_engaged');
  });

  it('does NOT block closes — being unable to exit while halted is the worse failure', () => {
    engageHardKillSwitch('cto', 'drill', NOW);
    const v = admitOrderThroughHardControls(intent({ kind: 'close' }), NOW);
    expect(v.allowed).toBe(true);
  });

  it('survives a restart: the latch re-hydrates engaged', () => {
    engageHardKillSwitch('cto', 'drill', NOW);
    __resetHardControlsForTest({ dataDir, nowMs: NOW });
    hydrateHardControlsFromDisk(NOW);
    const v = admitOrderThroughHardControls(intent(), NOW);
    expect(v.reasonCode).toBe('kill_switch_engaged');
  });

  it('release (admin path) re-opens the gate and clears the force-close latch', async () => {
    await requestForceCloseAll('cto', 'drill', NOW);
    releaseHardKillSwitch();
    expect(admitOrderThroughHardControls(intent(), NOW).allowed).toBe(true);
  });
});

describe('control 2 — $500 daily loss lockout', () => {
  it('latches at exactly −$500 realized and refuses further opens', () => {
    recordHardControlsPnl(-HARD_DAILY_LOSS_LIMIT_USD, NOW);
    const v = admitOrderThroughHardControls(intent(), NOW);
    expect(v.reasonCode).toBe('daily_loss_lockout');
  });

  it('triggers BEFORE exceeding: refuses an open whose full loss passes −$500', () => {
    recordHardControlsPnl(-450, NOW);
    // −450 realized − $100 at risk = −$550 → refused on headroom.
    expect(admitOrderThroughHardControls(intent({ notionalUsd: 100 }), NOW).reasonCode)
      .toBe('daily_loss_headroom');
    // −450 − $40 = −$490 → still inside the limit, allowed.
    expect(admitOrderThroughHardControls(intent({ notionalUsd: 40 }), NOW).allowed).toBe(true);
  });

  it('an unreadable P&L delta locks the day (fail-closed), and the ET day-roll clears it', () => {
    recordHardControlsPnl(Number.NaN, NOW);
    expect(admitOrderThroughHardControls(intent(), NOW).reasonCode).toBe('day_pnl_unreadable');
    // Next ET day (24h later), quote freshly stamped for the new instant.
    const nextDay = NOW + 24 * 60 * 60 * 1_000;
    expect(admitOrderThroughHardControls(intent({ quoteAsOfMs: nextDay - 1_000 }), nextDay).allowed).toBe(true);
  });

  it('the lockout survives a restart — a pm2 bounce must not reset the day', () => {
    recordHardControlsPnl(-600, NOW);
    __resetHardControlsForTest({ dataDir, nowMs: NOW });
    hydrateHardControlsFromDisk(NOW);
    expect(admitOrderThroughHardControls(intent(), NOW).reasonCode).toBe('daily_loss_lockout');
  });
});

describe('control 3 — $300 per-trade hard cap', () => {
  it.each([
    [HARD_MAX_ORDER_NOTIONAL_USD + 0.01, 'max_order_notional'],
    [Number.NaN, 'order_notional_unreadable'],
    [0, 'order_notional_unreadable'],
    [-50, 'order_notional_unreadable'],
    [Number.POSITIVE_INFINITY, 'order_notional_unreadable'],
  ])('refuses notional %s with %s', (notionalUsd, reasonCode) => {
    const v = admitOrderThroughHardControls(intent({ notionalUsd: notionalUsd as number }), NOW);
    expect(v.allowed).toBe(false);
    expect(v.reasonCode).toBe(reasonCode);
  });

  it('allows exactly $300 (cap is inclusive) and refuses, never resizes, above it', () => {
    expect(admitOrderThroughHardControls(intent({ notionalUsd: 300 }), NOW).allowed).toBe(true);
  });
});

describe('control 4 — 3 open positions max', () => {
  it('refuses the 4th position and unreadable counts', () => {
    expect(admitOrderThroughHardControls(intent({ openPositionCount: HARD_MAX_OPEN_POSITIONS }), NOW).reasonCode)
      .toBe('max_open_positions');
    expect(admitOrderThroughHardControls(intent({ openPositionCount: Number.NaN }), NOW).reasonCode)
      .toBe('open_positions_unreadable');
    expect(admitOrderThroughHardControls(intent({ openPositionCount: -1 }), NOW).reasonCode)
      .toBe('open_positions_unreadable');
    expect(admitOrderThroughHardControls(intent({ openPositionCount: 2 }), NOW).allowed).toBe(true);
  });
});

describe('control 5 — stale-quote circuit breaker (5s)', () => {
  it('refuses a quote one ms over the limit, allows one at the limit', () => {
    expect(admitOrderThroughHardControls(
      intent({ quoteAsOfMs: NOW - HARD_MAX_QUOTE_AGE_MS - 1 }), NOW).reasonCode).toBe('stale_quote');
    expect(admitOrderThroughHardControls(
      intent({ quoteAsOfMs: NOW - HARD_MAX_QUOTE_AGE_MS }), NOW).allowed).toBe(true);
  });

  it('refuses a missing timestamp and a future (clock-skewed) one', () => {
    expect(admitOrderThroughHardControls(intent({ quoteAsOfMs: Number.NaN }), NOW).reasonCode)
      .toBe('quote_timestamp_unreadable');
    expect(admitOrderThroughHardControls(intent({ quoteAsOfMs: NOW + 5_000 }), NOW).reasonCode)
      .toBe('quote_clock_skew');
  });

  it('binds closes too — a routine exit must not price against a dead feed', () => {
    const v = admitOrderThroughHardControls(
      intent({ kind: 'close', quoteAsOfMs: NOW - 60_000 }), NOW);
    expect(v.reasonCode).toBe('stale_quote');
  });
});

describe('control 6 — idempotency', () => {
  it('the same key admitted twice is a duplicate, and the refusal names the first admit', () => {
    const one = intent({ idempotencyKey: 'fixed-key' });
    expect(admitOrderThroughHardControls(one, NOW).allowed).toBe(true);
    const v = admitOrderThroughHardControls(intent({ idempotencyKey: 'fixed-key' }), NOW + 500);
    expect(v.reasonCode).toBe('duplicate_order');
    expect(v.reason).toContain('fixed-key');
  });

  it('a missing/blank key refuses — every order must be deduplicable', () => {
    expect(admitOrderThroughHardControls(intent({ idempotencyKey: '' }), NOW).reasonCode)
      .toBe('idempotency_key_missing');
    expect(admitOrderThroughHardControls(
      intent({ idempotencyKey: '   ' }), NOW).reasonCode).toBe('idempotency_key_missing');
  });

  it('keys survive a restart — a bounce must not permit a replay', () => {
    admitOrderThroughHardControls(intent({ idempotencyKey: 'replay-me' }), NOW);
    __resetHardControlsForTest({ dataDir, nowMs: NOW });
    hydrateHardControlsFromDisk(NOW);
    expect(admitOrderThroughHardControls(
      intent({ idempotencyKey: 'replay-me' }), NOW + 1_000).reasonCode).toBe('duplicate_order');
  });
});

describe('control 7 — force-close-all', () => {
  it('engages the kill switch, runs every registered handler, reports a throwing one', async () => {
    registerForceCloseHandler('paper-book', async () => ({ closed: 2, errors: [] }));
    registerForceCloseHandler('broken-engine', async () => { throw new Error('socket down'); });
    const { handlers } = await requestForceCloseAll('cto', 'drill', NOW);
    expect(handlers).toEqual([
      { name: 'paper-book', ok: true, closed: 2, errors: [] },
      { name: 'broken-engine', ok: false, closed: 0, errors: ['socket down'] },
    ]);
    expect(getHardControlsState(NOW).killSwitch.engaged).toBe(true);
    expect(admitOrderThroughHardControls(intent(), NOW).allowed).toBe(false);
  });

  it('while the latch is engaged, a market close passes even on a stale quote', async () => {
    await requestForceCloseAll('cto', 'feed died', NOW);
    const v = admitOrderThroughHardControls(
      intent({ kind: 'close', quoteAsOfMs: NOW - 60_000 }), NOW);
    expect(v.allowed).toBe(true);
  });
});

describe('fail-closed on unreadable persisted state', () => {
  it('an unparseable state file refuses EVERYTHING, opens and closes alike', () => {
    writeFileSync(join(dataDir, HARD_CONTROLS_STATE_FILENAME), '{not json', 'utf8');
    __resetHardControlsForTest({ dataDir, nowMs: NOW });
    hydrateHardControlsFromDisk(NOW);
    expect(admitOrderThroughHardControls(intent(), NOW).reasonCode).toBe('hard_controls_state_unreadable');
    expect(admitOrderThroughHardControls(intent({ kind: 'close' }), NOW).reasonCode)
      .toBe('hard_controls_state_unreadable');
    // and it does not clobber the corrupt file (the forensic evidence).
    expect(readFileSync(join(dataDir, HARD_CONTROLS_STATE_FILENAME), 'utf8')).toBe('{not json');
  });

  it('a missing file is a normal cold boot, not degradation', () => {
    expect(getHardControlsState(NOW).degraded).toBe(false);
    expect(admitOrderThroughHardControls(intent(), NOW).allowed).toBe(true);
  });
});
