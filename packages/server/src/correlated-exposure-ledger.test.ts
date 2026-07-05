import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordCorrelatedExposureBinding,
  summarizeCorrelatedExposureBindings,
  __resetCorrelatedExposureLedgerForTest,
} from './correlated-exposure-ledger.js';

// TRA-1301 (parent TRA-1295, Rule 5) — the in-memory observability ledger the
// entry chokepoints record cap bindings into for the /api/health + EOD readout.
describe('correlated-exposure ledger (TRA-1301)', () => {
  beforeEach(() => __resetCorrelatedExposureLedgerForTest());

  it('starts empty', () => {
    const s = summarizeCorrelatedExposureBindings();
    expect(s).toEqual({ bindingCount: 0, scaledCount: 0, rejectedCount: 0, recent: [] });
  });

  it('tallies scaled vs rejected bindings and counts the total', () => {
    recordCorrelatedExposureBinding({
      ts: 1, venue: 'equity', mode: 'demo', level: 'underlying', key: 'AAPL',
      scale: 0.5, action: 'scaled', symbol: 'AAPL',
    });
    recordCorrelatedExposureBinding({
      ts: 2, venue: 'crypto', mode: 'demo', level: 'assetClass', key: 'crypto',
      scale: 0, action: 'rejected', symbol: 'BTC-USD',
    });
    const s = summarizeCorrelatedExposureBindings();
    expect(s.scaledCount).toBe(1);
    expect(s.rejectedCount).toBe(1);
    expect(s.bindingCount).toBe(2);
  });

  it('returns recent events most-recent-first', () => {
    recordCorrelatedExposureBinding({
      ts: 1, venue: 'equity', mode: 'demo', level: 'underlying', key: 'AAPL',
      scale: 0.5, action: 'scaled', symbol: 'AAPL',
    });
    recordCorrelatedExposureBinding({
      ts: 2, venue: 'option', mode: 'demo', level: 'underlying', key: 'MSFT',
      scale: 0, action: 'rejected', symbol: 'MSFT',
    });
    const s = summarizeCorrelatedExposureBindings();
    expect(s.recent.map(e => e.symbol)).toEqual(['MSFT', 'AAPL']);
  });

  it('caps the retained tail at 50 while keeping the full counts', () => {
    for (let i = 0; i < 60; i++) {
      recordCorrelatedExposureBinding({
        ts: i, venue: 'equity', mode: 'demo', level: 'underlying', key: `S${i}`,
        scale: 0.5, action: 'scaled', symbol: `S${i}`,
      });
    }
    const s = summarizeCorrelatedExposureBindings();
    expect(s.recent).toHaveLength(50);
    expect(s.scaledCount).toBe(60);
    expect(s.bindingCount).toBe(60);
    // Newest first ⇒ the most recent record leads the tail.
    expect(s.recent[0]?.symbol).toBe('S59');
  });
});
