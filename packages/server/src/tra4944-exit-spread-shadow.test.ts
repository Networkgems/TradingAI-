import { describe, expect, it } from 'vitest';
import { ExitSpreadShadow, mergeExitSpreadShadow } from './option-exit-spread-shadow.js';
import { foldCrossedCells } from './option-crossed-pnl.js';

describe('TRA-4944 exit spread shadow', () => {
  it('buckets spreads, keeps noQuote out of every bucket, flags forced reasons', () => {
    const s = new ExitSpreadShadow();
    const base = { sleeve: 'single_leg_otm', mode: 'demo', markSource: 'quote' };
    s.observe({ ...base, reason: 'chandelier', quote: { bid: 0.52, ask: 1.4 } }); // 0.9167
    s.observe({ ...base, reason: 'chandelier', quote: { bid: 0.99, ask: 1.01 } }); // 0.02
    s.observe({ ...base, reason: 'chandelier', quote: null, markSource: 'delta_backstop' });
    s.observe({ ...base, reason: 'sl_catastrophic', quote: { bid: 1, ask: 1 } });
    const snap = s.snapshot();
    const c = snap.cells['single_leg_otm|demo|chandelier']!;
    expect(snap.evaluated).toBe(4);
    expect(c.n).toBe(3);
    expect(c.noQuote).toBe(1);
    expect(c.noQuoteDeltaBackstop).toBe(1);
    expect(c.hist).toEqual([1, 0, 0, 0, 0, 1]);
    expect(c.maxSpread).toBeCloseTo(0.9167, 3);
    expect(c.forced).toBe(false);
    expect(snap.cells['single_leg_otm|demo|sl_catastrophic']!.forced).toBe(true);
  });

  it('merges snapshots additively', () => {
    const a = new ExitSpreadShadow();
    const b = new ExitSpreadShadow();
    const o = { sleeve: 'x', mode: 'live', reason: 'sl', markSource: null };
    a.observe({ ...o, quote: { bid: 1, ask: 1.2 } });
    b.observe({ ...o, quote: null });
    const m = mergeExitSpreadShadow([a.snapshot(), b.snapshot()]);
    expect(m.evaluated).toBe(2);
    expect(m.cells['x|live|sl']!.n).toBe(2);
    expect(m.cells['x|live|sl']!.noQuote).toBe(1);
  });

  it('crossed fold counts delta_backstop exits as UNMEASURED', () => {
    const f = foldCrossedCells([
      { structure: 'single_leg_otm', realizedPnlUsd: -1, markProvenance: { quoteAtFire: null, markSource: 'delta_backstop' } } as never,
    ]);
    expect(f.unpriced).toBe(1);
    expect(f.unmeasuredDeltaBackstop).toBe(1);
  });
});
