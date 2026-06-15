import { describe, it, expect } from 'vitest';
import type { OptionPosition } from '@trading-app/shared';
import type { OptionChainRow } from '@trading-app/engine';
import {
  diffChain,
  scanTargetStop,
  computeOptionsAlerts,
  toAlertEvents,
  type ChainSnapshot,
} from './options-alert-engine.js';

// Fixed ET clock — 2026-06-12 ~mid-session — so dedup keys are deterministic.
const NOW = Date.parse('2026-06-12T18:00:00Z');
const PREV = Date.parse('2026-06-11T18:00:00Z');

function row(over: Partial<OptionChainRow>): OptionChainRow {
  return {
    optionSymbol: over.optionSymbol ?? `AAPL_${over.optionType}_${over.strike}_${over.expiration}`,
    underlying: 'AAPL',
    optionType: 'call',
    strike: 100,
    expiration: '2026-07-17',
    midIv: 0.3,
    ...over,
  } as OptionChainRow;
}

function snap(over: Partial<ChainSnapshot>): ChainSnapshot {
  return {
    symbol: 'AAPL',
    spot: 100,
    recordedAt: NOW,
    expirations: [],
    rows: [],
    ...over,
  };
}

describe('diffChain', () => {
  it('flags a brand-new expiry once and does not double-report its strikes', () => {
    const prev = snap({ recordedAt: PREV, rows: [row({ strike: 100, expiration: '2026-07-17' })] });
    const today = snap({
      rows: [
        row({ strike: 100, expiration: '2026-07-17' }),
        row({ strike: 100, expiration: '2026-08-21' }),
        row({ strike: 105, expiration: '2026-08-21' }),
      ],
    });
    const alerts = diffChain(prev, today);
    const expiry = alerts.filter((a) => a.kind === 'new_expiry');
    expect(expiry).toHaveLength(1);
    expect(expiry[0].expiration).toBe('2026-08-21');
    expect(expiry[0].message).toContain('2 contracts');
    // None of the new-expiry strikes leak into new_strike alerts.
    expect(alerts.some((a) => a.kind === 'new_strike')).toBe(false);
  });

  it('flags strikes added to an existing expiry', () => {
    const prev = snap({ recordedAt: PREV, rows: [row({ strike: 100, expiration: '2026-07-17' })] });
    const today = snap({
      rows: [
        row({ strike: 100, expiration: '2026-07-17' }),
        row({ strike: 110, expiration: '2026-07-17' }),
      ],
    });
    const alerts = diffChain(prev, today);
    const ns = alerts.filter((a) => a.kind === 'new_strike');
    expect(ns).toHaveLength(1);
    expect(ns[0].strike).toBe(110);
  });

  it('rolls up new strikes once they exceed the per-expiry cap', () => {
    const prev = snap({ recordedAt: PREV, rows: [row({ strike: 100, expiration: '2026-07-17' })] });
    const todayRows = [row({ strike: 100, expiration: '2026-07-17' })];
    for (let s = 101; s <= 112; s++) todayRows.push(row({ strike: s, expiration: '2026-07-17' }));
    const today = snap({ rows: todayRows });
    const alerts = diffChain(prev, today, { maxNewStrikesPerExpiry: 8 });
    const ns = alerts.filter((a) => a.kind === 'new_strike');
    expect(ns).toHaveLength(1);
    expect(ns[0].message).toContain('12 new strikes');
    expect(ns[0].dedupKey).toContain('rollup');
  });

  it('flags a big IV move and ignores moves under the threshold', () => {
    const prev = snap({
      recordedAt: PREV,
      rows: [
        row({ strike: 100, expiration: '2026-07-17', midIv: 0.3 }),
        row({ strike: 105, expiration: '2026-07-17', midIv: 0.3 }),
      ],
    });
    const today = snap({
      rows: [
        row({ strike: 100, expiration: '2026-07-17', midIv: 0.45 }), // +15 pts → trips
        row({ strike: 105, expiration: '2026-07-17', midIv: 0.34 }), // +4 pts → ignored
      ],
    });
    const moves = diffChain(prev, today, { ivMoveThreshold: 0.1 }).filter((a) => a.kind === 'iv_move');
    expect(moves).toHaveLength(1);
    expect(moves[0].strike).toBe(100);
    expect(moves[0].ivFrom).toBeCloseTo(0.3);
    expect(moves[0].ivTo).toBeCloseTo(0.45);
    expect(moves[0].ivDelta).toBeCloseTo(0.15);
  });

  it('prefers smvVol over midIv when diffing IV', () => {
    const prev = snap({ recordedAt: PREV, rows: [row({ strike: 100, midIv: 0.9, smvVol: 0.3 })] });
    const today = snap({ rows: [row({ strike: 100, midIv: 0.9, smvVol: 0.5 })] });
    const moves = diffChain(prev, today).filter((a) => a.kind === 'iv_move');
    expect(moves).toHaveLength(1);
    expect(moves[0].ivFrom).toBeCloseTo(0.3);
    expect(moves[0].ivTo).toBeCloseTo(0.5);
  });
});

function pos(over: Partial<OptionPosition>): OptionPosition {
  return {
    id: over.id ?? 'p1',
    symbol: 'AAPL',
    optionType: 'call',
    strike: 100,
    expiration: '2026-07-17',
    contracts: 2,
    contractsRemaining: 2,
    premiumPaid: 3,
    currentPremium: 3,
    tp1Premium: 4,
    tp1Hit: false,
    stopLossPremium: 2,
    peakPremium: 3,
    trailingActive: false,
    trailingStopPremium: 3.6,
    underlyingEntryPrice: 100,
    openedAt: PREV,
    signalType: 'relative_value',
    ...over,
  } as OptionPosition;
}

describe('scanTargetStop', () => {
  it('flags a target hit only while the partial has not fired', () => {
    const hit = scanTargetStop([pos({ currentPremium: 4.2 })], { now: NOW });
    expect(hit.map((a) => a.kind)).toEqual(['target_hit']);
    expect(hit[0].mark).toBe(4.2);
    expect(hit[0].level).toBe(4);

    const already = scanTargetStop([pos({ currentPremium: 4.2, tp1Hit: true })], { now: NOW });
    expect(already.some((a) => a.kind === 'target_hit')).toBe(false);
  });

  it('flags a hard stop hit', () => {
    const hit = scanTargetStop([pos({ currentPremium: 1.8 })], { now: NOW });
    expect(hit.map((a) => a.kind)).toEqual(['stop_hit']);
    expect(hit[0].level).toBe(2);
    expect(hit[0].message).not.toContain('trailing');
  });

  it('flags the active trailing stop and labels it', () => {
    const hit = scanTargetStop(
      [pos({ currentPremium: 3.5, trailingActive: true, trailingStopPremium: 3.6, stopLossPremium: 2 })],
      { now: NOW },
    );
    expect(hit.map((a) => a.kind)).toEqual(['stop_hit']);
    expect(hit[0].level).toBe(3.6); // trailing binds above the hard stop
    expect(hit[0].message).toContain('trailing');
  });

  it('emits nothing for a position sitting between its levels', () => {
    expect(scanTargetStop([pos({ currentPremium: 3 })], { now: NOW })).toEqual([]);
  });

  it('skips positions with no live mark', () => {
    expect(scanTargetStop([pos({ currentPremium: 0 })], { now: NOW })).toEqual([]);
  });
});

describe('computeOptionsAlerts', () => {
  it('merges detectors, orders action items first, and counts by kind', () => {
    const prev = new Map<string, ChainSnapshot>([
      ['AAPL', snap({ recordedAt: PREV, rows: [row({ strike: 100, midIv: 0.3 })] })],
    ]);
    const today = new Map<string, ChainSnapshot>([
      ['AAPL', snap({ rows: [row({ strike: 100, midIv: 0.5 }), row({ strike: 110 })] })],
    ]);
    const res = computeOptionsAlerts({
      prevBySymbol: prev,
      todayBySymbol: today,
      openOptions: [pos({ currentPremium: 1.5 })], // stop hit
      opts: { now: NOW },
    });
    expect(res.symbolsDiffed).toEqual(['AAPL']);
    expect(res.alerts[0].severity).toBe('action'); // stop_hit sorts first
    expect(res.counts.stop_hit).toBe(1);
    expect(res.counts.new_strike).toBe(1);
    expect(res.counts.iv_move).toBe(1);
  });

  it('only diffs symbols present in both days', () => {
    const prev = new Map<string, ChainSnapshot>([['AAPL', snap({ recordedAt: PREV })]]);
    const today = new Map<string, ChainSnapshot>([
      ['AAPL', snap({})],
      ['MSFT', snap({ symbol: 'MSFT' })],
    ]);
    const res = computeOptionsAlerts({ prevBySymbol: prev, todayBySymbol: today, openOptions: [], opts: { now: NOW } });
    expect(res.symbolsDiffed).toEqual(['AAPL']);
  });
});

describe('toAlertEvents', () => {
  it('maps alerts to options signal events preserving the dedup key', () => {
    const alerts = scanTargetStop([pos({ currentPremium: 1.8 })], { now: NOW });
    const events = toAlertEvents(alerts, 'trader1', NOW);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'signal',
      market: 'options',
      username: 'trader1',
      signalType: 'options_alert_stop_hit',
      side: 'sell',
    });
    expect(events[0].dedupKey).toBe(alerts[0].dedupKey);
  });
});
