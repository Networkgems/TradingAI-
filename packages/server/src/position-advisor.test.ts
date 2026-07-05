import { describe, it, expect } from 'vitest';
import { SignalEngine } from './signal-engine.js';
import { DEFAULT_ACCOUNT_SETTINGS, CONVICTION_DCA } from '@trading-app/shared';
import type { TradeSignal, Candle } from '@trading-app/shared';

// TRA-1303 — Position Advisor readout. These lock the read-only contract:
// getPositionAdvisor() surfaces the engine's own DCA verdict + sell plan for a
// held demo position and NEVER mutates the book, the fill ledgers, or the
// per-day add counters.

/** A gently-uptrending daily series: current price sits above the SMA-50 and ATR>0. */
function upCandles(symbol = 'AAPL', n = 60, start = 95, step = 0.15): Candle[] {
  const base = Date.parse('2024-06-01T00:00:00Z');
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const close = start + i * step;
    out.push({
      symbol,
      timestamp: base + i * 86_400_000,
      open: close - 0.1,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000_000,
    });
  }
  return out;
}

interface Privates {
  account: { openPosition: (s: TradeSignal, p: number) => unknown };
  candleCache: Map<string, Candle[]>;
  symbolState: Map<string, { symbol: string; price: number; volume: number; change: number; changePct: number; lastUpdated: number }>;
  dcaTranches: Map<string, unknown>;
  dcaAddsToday: Map<string, unknown>;
}

function openAaplLong(engine: SignalEngine): Privates {
  const p = engine as unknown as Privates;
  const opened = p.account.openPosition(
    { id: 's1', symbol: 'AAPL', type: 'orb_breakout', side: 'buy', entryPrice: 100, stopLoss: 95, takeProfit: 110, riskRewardRatio: 2, timestamp: Date.now() },
    100,
  );
  expect(opened).not.toBeNull();
  p.candleCache.set('AAPL', upCandles('AAPL'));
  p.symbolState.set('AAPL', { symbol: 'AAPL', price: 103, volume: 1_000_000, change: 3, changePct: 3, lastUpdated: Date.now() });
  return p;
}

describe('SignalEngine.getPositionAdvisor (TRA-1303)', () => {
  it('surfaces a sell plan (SL/TP) and a DCA next-add plan for a held demo equity position', () => {
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });
    openAaplLong(engine);

    const rows = engine.getPositionAdvisor();
    const row = rows.find(r => r.book === 'equity' && r.symbol === 'AAPL');
    expect(row).toBeDefined();
    if (!row) return;

    // Position facts.
    expect(row.side).toBe('long');
    expect(row.quantity).toBeGreaterThan(0);
    expect(row.avgEntry).toBe(100);
    expect(row.currentPrice).toBe(103);

    // Sell plan = the position's own bracket, in price units.
    expect(row.sell.unit).toBe('price');
    expect(row.sell.stopLoss).toBe(95);
    expect(row.sell.takeProfit).toBe(110);
    expect(row.sell.method).toContain('orb_breakout');

    // DCA plan: the conviction-DCA ladder trigger sits below the last fill (long
    // adds on a pullback), risk budget is positive, and a reason is always present.
    expect(row.dca.enabled).toBe(CONVICTION_DCA.enabled);
    expect(row.dca.riskBudget).toBeGreaterThan(0);
    expect(typeof row.dca.reason).toBe('string');
    expect(row.dca.reason.length).toBeGreaterThan(0);
    if (CONVICTION_DCA.enabled) {
      expect(row.dca.triggerPrice).not.toBeNull();
      expect(row.dca.triggerPrice as number).toBeGreaterThan(0);
      expect(row.dca.triggerPrice as number).toBeLessThan(100); // −ATR from the 100 entry
    }
  });

  it('is read-only: it never seeds the fill ledger or the per-day add counters', () => {
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });
    const p = openAaplLong(engine);

    expect(p.dcaTranches.size).toBe(0);
    expect(p.dcaAddsToday.size).toBe(0);

    engine.getPositionAdvisor();
    engine.getPositionAdvisor();

    // A read-only readout must not persist the engine's DCA state that the live
    // execution pass (evaluateConvictionDcaAdds) owns.
    expect(p.dcaTranches.size).toBe(0);
    expect(p.dcaAddsToday.size).toBe(0);
  });

  it('returns an empty array on a flat book', () => {
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });
    expect(engine.getPositionAdvisor()).toEqual([]);
  });
});
