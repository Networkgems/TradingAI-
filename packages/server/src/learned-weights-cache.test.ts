// TRA-1046 (TRA-1041c L1) — intraday learned-weights refresh tests.
//
// Proves the issue's acceptance ("weights demonstrably change intraday after a
// close"): a close event invalidates the fold so the very next read recomputes
// against the new journal row, bumping the generation and moving the multiplier —
// no EOD snapshot or restart required. Also covers the TTL cost-cap (a read inside
// the TTL with no close does NOT refold) and the journal→cache close wiring.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import {
  OptionWeightsCache,
  optionWeightsCache,
  resetLearnedWeightsCacheForTests,
} from './learned-weights-cache.js';
import {
  recordOptionTradeOpen,
  recordOptionTradeClose,
  onOptionTradeClose,
  clearOptionTradeCloseListenersForTests,
  setOptionTradeJournalFileForTests,
  outcomeForR,
  type OptionTradeJournalRecord,
} from './option-trade-journal.js';

let seq = 0;
function lossRow(): OptionTradeJournalRecord {
  seq += 1;
  return {
    id: `SPY:bull_put:${seq}`,
    openTs: seq,
    symbol: 'SPY',
    structure: 'bull_put',
    mode: 'demo',
    ivRank: 60,
    trend: 'up',
    sentiment: 0.4,
    entryDelta: 0.25,
    entryDte: 38,
    atRiskUsd: 100,
    outcome: 'LOSS',
    closeTs: seq + 1,
    realizedPnlUsd: -100,
    realizedR: -1,
    exitReason: 'stop',
    holdDays: 4,
  };
}

describe('OptionWeightsCache (intraday refresh)', () => {
  it('recomputes on invalidate and the weights change after a close', async () => {
    let clock = 1_000;
    const rows: OptionTradeJournalRecord[] = [];
    const cache = new OptionWeightsCache({
      ttlMs: 60_000,
      now: () => clock,
      load: async () => [...rows],
      // minSamples 2 so a 2-row bucket clears the guard within the test.
      params: { minSamples: 2, baselineHitRate: 0.5, sensitivity: 1, expectancyPenalty: 0.1, floor: 0.5, ceil: 1.5 },
    });

    const first = await cache.get();
    expect(first.freshness.generation).toBe(1);
    // Empty journal ⇒ no structure buckets ⇒ neutral fold.
    expect(first.weights.byStructure).toHaveLength(0);

    // Two losing closes land mid-session.
    rows.push(lossRow(), lossRow());
    cache.invalidate(); // a close event would call this

    const second = await cache.get();
    expect(second.freshness.generation).toBe(2); // refolded
    const bullPut = second.weights.byStructure.find((s) => s.key === 'bull_put');
    expect(bullPut?.confident).toBe(true);
    // A 0%-win bucket pulls the multiplier BELOW neutral — weights moved intraday.
    expect(bullPut!.multiplier).toBeLessThan(1);
  });

  it('does not refold inside the TTL without a close (cost cap)', async () => {
    let clock = 1_000;
    const rows: OptionTradeJournalRecord[] = [];
    const cache = new OptionWeightsCache({ ttlMs: 60_000, now: () => clock, load: async () => [...rows] });

    const a = await cache.get();
    expect(a.freshness.generation).toBe(1);

    // Rows change but no invalidate + still inside TTL ⇒ stale read is intentional.
    rows.push(lossRow());
    clock += 30_000;
    const b = await cache.get();
    expect(b.freshness.generation).toBe(1); // NOT refolded
    expect(b.weights.byStructure).toHaveLength(0);

    // Past the TTL ⇒ refold even without a close.
    clock += 31_000;
    const c = await cache.get();
    expect(c.freshness.generation).toBe(2);
    expect(c.weights.byStructure).toHaveLength(1);
  });

  it('serves the last good fold when a refold throws', async () => {
    let clock = 1_000;
    let fail = false;
    const cache = new OptionWeightsCache({
      ttlMs: 10,
      now: () => clock,
      load: async () => {
        if (fail) throw new Error('journal read blew up');
        return [];
      },
    });
    const ok = await cache.get();
    expect(ok.freshness.generation).toBe(1);

    fail = true;
    cache.invalidate();
    clock += 100;
    const stillOk = await cache.get(); // does not throw
    expect(stillOk.weights).toBeDefined();
  });
});

describe('journal close → cache wiring', () => {
  let tmpFile: string;
  let fileSeq = 0;
  beforeEach(() => {
    fileSeq += 1;
    tmpFile = join(tmpdir(), `lwc-${process.pid}-${fileSeq}.jsonl`);
    setOptionTradeJournalFileForTests(tmpFile);
    clearOptionTradeCloseListenersForTests();
    resetLearnedWeightsCacheForTests();
    process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  });
  afterEach(async () => {
    delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
    setOptionTradeJournalFileForTests(null);
    clearOptionTradeCloseListenersForTests();
    resetLearnedWeightsCacheForTests();
    await rm(tmpFile, { force: true });
  });

  it('fires the close subscriber so the singleton invalidates', async () => {
    let fired = 0;
    onOptionTradeClose(() => (fired += 1));

    await recordOptionTradeOpen({
      id: 'OD1', openTs: 1, symbol: 'SPY', structure: 'bull_put', mode: 'demo',
      ivRank: 60, trend: 'up', sentiment: 0.3, entryDelta: 0.2, entryDte: 35, atRiskUsd: 100,
    });
    await recordOptionTradeClose('OD1', {
      closeTs: 2, outcome: outcomeForR(-1), realizedPnlUsd: -100, realizedR: -1,
      exitReason: 'stop', holdDays: 1,
    });

    expect(fired).toBe(1);
  });

  it('the singleton refolds after a real journal close', async () => {
    const cache = optionWeightsCache(); // constructs + subscribes
    const before = await cache.get();
    await recordOptionTradeOpen({
      id: 'OD2', openTs: 1, symbol: 'SPY', structure: 'bull_put', mode: 'demo',
      ivRank: 60, trend: 'up', sentiment: 0.3, entryDelta: 0.2, entryDte: 35, atRiskUsd: 100,
    });
    await recordOptionTradeClose('OD2', {
      closeTs: 2, outcome: outcomeForR(-1), realizedPnlUsd: -100, realizedR: -1,
      exitReason: 'stop', holdDays: 1,
    });
    const after = await cache.get();
    expect(after.freshness.generation).toBeGreaterThan(before.freshness.generation);
    expect(after.weights.generatedFrom.resolved).toBe(1);
  });
});
