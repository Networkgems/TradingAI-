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
  resolveFleetOpenPositionCount,
  type FleetOpenPositionCountRow,
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

describe('control 4 fleet count — TRA-5283: "3 positions max" counts the FLEET, not one book', () => {
  const row = (
    book: string, open: boolean, options: number, equity: number,
  ): FleetOpenPositionCountRow =>
    ({ book, liveEntryGateOpen: open, openLiveOptionRows: options, openEquityPositions: equity });
  const WIRED = true;
  const UNWIRED = false;

  it('the filing scenario: 2 gate-open books × 2 open rows — a 5th position on EITHER book is REFUSED', () => {
    // self = admin, holding 2 open live rows (its own count excludes the row
    // being graded, TRA-3872); sibling v0nni holds 2 more. Fleet = 4 ≥ cap 3.
    const rows = [row('admin', true, 2, 0), row('v0nni', true, 2, 0)];
    const count = resolveFleetOpenPositionCount(rows, { book: 'admin', openPositionCount: 2 }, WIRED);
    expect(count).toBe(4);
    const v = admitOrderThroughHardControls(intent({ openPositionCount: count }), NOW);
    expect(v.allowed).toBe(false);
    expect(v.reasonCode).toBe('max_open_positions');
    expect(v.reason).toContain('fleet-wide cap');
    // The PRE-FIX supplier — this book's own count alone — admits the same
    // order. That admit is the defect this suite now pins: per-book grading
    // makes the effective fleet cap `3 × gate-open books`.
    expect(admitOrderThroughHardControls(intent({ openPositionCount: 2 }), NOW).allowed).toBe(true);
  });

  it('a sibling book\'s EQUITY mirrors count toward the cap too', () => {
    const rows = [row('admin', true, 0, 0), row('v0nni', true, 1, 2)];
    expect(resolveFleetOpenPositionCount(rows, { book: 'admin', openPositionCount: 0 }, WIRED)).toBe(3);
  });

  it('a gate-CLOSED book\'s rows do NOT count — live-MODE-on-sandbox phantoms must not tighten the cap (TRA-3445)', () => {
    const rows = [row('admin', true, 1, 0), row('Richard', false, 4, 3)];
    expect(resolveFleetOpenPositionCount(rows, { book: 'admin', openPositionCount: 1 }, WIRED)).toBe(1);
  });

  it('the self row is matched by book and never double-counted — the caller\'s own figure wins', () => {
    // The fleet row for admin says 3 (it cannot exclude the row being graded);
    // the caller's figure says 2 (it can). The caller's figure is used.
    const rows = [row('admin', true, 3, 0), row('v0nni', true, 1, 0)];
    expect(resolveFleetOpenPositionCount(rows, { book: 'admin', openPositionCount: 2 }, WIRED)).toBe(3);
  });

  it.each([
    ['wired read returned null (provider threw)', null],
    ['a null row element', [row('admin', true, 0, 0), null]],
    ['an unreadable gate', [{ ...row('v0nni', true, 0, 0), liveEntryGateOpen: 'yes' as unknown as boolean }]],
    ['a non-integer sibling count', [row('v0nni', true, 1.5, 0)]],
    ['a negative sibling count', [row('v0nni', true, -1, 0)]],
    ['a NaN sibling count', [row('v0nni', true, Number.NaN, 0)]],
  ])('fail-closed: %s yields NaN, which the admit refuses as open_positions_unreadable — never "count the books we can see"', (_label, rows) => {
    const count = resolveFleetOpenPositionCount(
      rows as readonly FleetOpenPositionCountRow[] | null, { book: 'admin', openPositionCount: 0 }, WIRED,
    );
    expect(Number.isNaN(count)).toBe(true);
    expect(admitOrderThroughHardControls(intent({ openPositionCount: count }), NOW).reasonCode)
      .toBe('open_positions_unreadable');
  });

  it('an unreadable SELF count is NaN even with readable siblings', () => {
    const rows = [row('v0nni', true, 0, 0)];
    expect(Number.isNaN(
      resolveFleetOpenPositionCount(rows, { book: 'admin', openPositionCount: Number.NaN }, WIRED),
    )).toBe(true);
  });

  it('UNWIRED (a context with no fleet read at all) degrades to the per-book count — the TRA-3879 AC4 never-dark-a-book posture, not a refusal', () => {
    expect(resolveFleetOpenPositionCount(null, { book: 'admin', openPositionCount: 1 }, UNWIRED)).toBe(1);
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
