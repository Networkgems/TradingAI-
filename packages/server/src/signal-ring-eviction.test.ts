import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Sma200Signal, TradeSignal } from '@trading-app/shared';
import { SignalEngine } from './signal-engine.js';
import { signalRingEvictionIndex } from './sma200-validity.js';

/**
 * TRA-4529 — the display ring (`recentSignals`, cap 50) is shared by 5-day
 * SMA-200 rows and the intraday stream. A plain `pop()` let the OTM refusal
 * flood evict SMA-200 rows minutes after the open with no void record and no
 * log line (AEHR/DOCN on 2026-09-10: 2 of 4 exits invisible to
 * `sma200SignalVoids`). These tests grade the served surface, `getState()`.
 */

const RING_CAP = 50;

type Pushable = TradeSignal | Sma200Signal;

function push(engine: SignalEngine, sig: Pushable): void {
  (engine as unknown as { pushRecentSignal: (s: Pushable) => void }).pushRecentSignal(sig);
}

function mode(engine: SignalEngine): 'demo' | 'live' {
  return (engine as unknown as { mode: 'demo' | 'live' }).mode;
}

let seq = 0;

function sma200Row(engine: SignalEngine, symbol: string): Sma200Signal {
  seq++;
  return {
    id: `sma-${seq}`,
    symbol,
    type: 'sma200_pullback',
    side: 'buy',
    entryPrice: 100,
    stopLoss: 95,
    takeProfit: null,
    riskRewardRatio: null,
    timestamp: Date.now(),
    mode: mode(engine),
    barTimestamp: Date.parse('2026-09-09T20:00:00Z'),
    atr14: 4,
    validForBarTimestamp: Date.parse('2026-09-09T20:00:00Z'),
  } as unknown as Sma200Signal;
}

function otmRefusalRow(engine: SignalEngine, i: number): TradeSignal {
  seq++;
  return {
    id: `otm-${seq}`,
    symbol: `OTM${i}`,
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: 1,
    stopLoss: 0.5,
    takeProfit: 2,
    riskRewardRatio: 2,
    timestamp: Date.now(),
    mode: mode(engine),
    liveSkipReason: 'OTM setup refused: entry window closed',
  } as unknown as TradeSignal;
}

describe('TRA-4529 — signalRingEvictionIndex', () => {
  const t = (type: string) => ({ type });

  it('picks the OLDEST non-SMA-200 row, skipping SMA-200 rows at the tail', () => {
    // newest first: [new otm, otm, sma, otm(oldest non-sma), sma(oldest)]
    const ring = [t('otm_mispricing'), t('otm_mispricing'), t('sma200_pullback'), t('orb'), t('sma200_reclaim')];
    expect(signalRingEvictionIndex(ring)).toBe(3);
  });

  it('never evicts the row just pushed while an older row exists', () => {
    const ring = [t('otm_mispricing'), t('sma200_pullback'), t('sma200_reclaim')];
    // Only non-SMA-200 row is index 0 (the new one) ⇒ fall back to the oldest row.
    expect(signalRingEvictionIndex(ring)).toBe(2);
  });

  it('returns -1 when nothing but the new row exists', () => {
    expect(signalRingEvictionIndex([t('otm_mispricing')])).toBe(-1);
    expect(signalRingEvictionIndex([])).toBe(-1);
  });
});

describe('TRA-4529 — SMA-200 rows survive the refusal flood', () => {
  it('60 OTM refusal rows pushed after an SMA-200 row leave it served, with no void', () => {
    const engine = new SignalEngine();
    const sma = sma200Row(engine, 'AEHR');
    push(engine, sma);
    for (let i = 0; i < 60; i++) push(engine, otmRefusalRow(engine, i));

    const state = engine.getState();
    expect(state.signals).toHaveLength(RING_CAP);
    expect(state.signals.map(s => s.id)).toContain(sma.id);
    // Newest first is preserved: the last refusal pushed is served at the head.
    expect(state.signals[0].symbol).toBe('OTM59');
    // Survived ⇒ nothing to record.
    expect(state.sma200SignalVoids ?? []).toHaveLength(0);
  });

  it('control: the oldest REFUSAL rows are the ones evicted', () => {
    const engine = new SignalEngine();
    push(engine, sma200Row(engine, 'DOCN'));
    for (let i = 0; i < 60; i++) push(engine, otmRefusalRow(engine, i));
    const syms = engine.getState().signals.map(s => s.symbol);
    // 1 SMA-200 row + the 49 NEWEST refusals (OTM11..OTM59).
    expect(syms).not.toContain('OTM10');
    expect(syms).toContain('OTM11');
    expect(syms).toContain('DOCN');
  });

  it('an SMA-200 row that MUST be evicted is RECORDED as `evicted`, never silently dropped', () => {
    const engine = new SignalEngine();
    // Fill the ring with SMA-200 rows only, then push refusals: every older
    // row is SMA-200, so the first refusal must evict one.
    const smaRows: Sma200Signal[] = [];
    for (let i = 0; i < RING_CAP; i++) {
      const r = sma200Row(engine, `S${i}`);
      smaRows.push(r);
      push(engine, r);
    }
    expect(engine.getState().sma200SignalVoids ?? []).toHaveLength(0);

    for (let i = 0; i < 60; i++) push(engine, otmRefusalRow(engine, i));
    const state = engine.getState();
    const voids = state.sma200SignalVoids ?? [];

    // Exactly ONE SMA-200 row is displaced: after it, the refusal stream
    // recycles its own single slot (the oldest non-SMA-200 row is always the
    // previous refusal), so SMA-200 rows are not drained by the flood.
    expect(voids).toHaveLength(1);
    expect(voids[0]).toMatchObject({
      signalId: smaRows[0].id,
      symbol: 'S0',
      kind: 'sma200_pullback',
      voidReason: 'evicted',
      entryPrice: 100,
      atr14: 4,
    });
    expect(state.signals).toHaveLength(RING_CAP);
    expect(state.signals.filter(s => s.type === 'sma200_pullback')).toHaveLength(RING_CAP - 1);
    expect(state.signals[0].symbol).toBe('OTM59');

    // Conservation: every SMA-200 row ever pushed is either served or recorded.
    const served = new Set(state.signals.map(s => s.id));
    const recorded = new Set(voids.map(v => v.signalId));
    for (const r of smaRows) expect(served.has(r.id) || recorded.has(r.id)).toBe(true);
  });
});

describe('TRA-4529 — every feed push goes through the helper', () => {
  it('signal-engine.ts carries no raw unshift/pop on `recentSignals` outside pushRecentSignal', () => {
    // A 26th inline copy of the old pattern would silently reopen the defect.
    const src = readFileSync(fileURLToPath(new URL('./signal-engine.ts', import.meta.url)), 'utf8');
    const unshifts = src.match(/this\.recentSignals\.unshift\(/g) ?? [];
    expect(unshifts).toHaveLength(1);
    expect(src).not.toMatch(/this\.recentSignals\.pop\(\)/);
    expect(src).not.toMatch(/this\.recentSignals\.push\(/);
    const helper = src.indexOf('private pushRecentSignal(');
    expect(helper).toBeGreaterThan(0);
    expect(src.indexOf('this.recentSignals.unshift(')).toBeGreaterThan(helper);
  });
});
