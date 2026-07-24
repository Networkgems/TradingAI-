// TRA-2214 — the model-facing journal basis, exercised END-TO-END through the
// real durable store (a temp journal file), not against a hand-rolled row array.
//
// Why through the real store: the defect being fixed was never in the predicate —
// `excludeTestAccountRows` has been correct since TRA-1475. It was that four folds
// never CALLED it, and that `learned-weights-cache` asked for every mode while its
// own doc said demo-only. A test that hands rows straight to `applyModelFacingBasis`
// re-implements the load path and would pass just as happily against the broken
// tree. So the tests that matter here drive `loadModelFacingJournal()` and the
// cache's DEFAULT loader, and let them go to disk.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import {
  applyModelFacingBasis,
  loadModelFacingJournal,
  loadModelFacingJournalRows,
  MODEL_FACING_JOURNAL_BASIS,
} from './model-facing-journal.js';
import {
  recordOptionTradeOpen,
  recordOptionTradeClose,
  setOptionTradeJournalFileForTests,
  type OptionTradeJournalRecord,
} from './option-trade-journal.js';
import {
  OptionWeightsCache,
  resetLearnedWeightsCacheForTests,
} from './learned-weights-cache.js';
import { clearOptionTradeCloseListenersForTests } from './option-trade-journal.js';

let seq = 0;

/**
 * A CLOSED winner. Closed (not open) because the folds that consume this basis —
 * learned weights, edge decay, the analyst tuner — only see resolved rows; an
 * open-row fixture would be dropped downstream for a reason unrelated to account
 * class and could make a broken filter look like it worked.
 */
function closedRow(
  over: Partial<OptionTradeJournalRecord> = {},
): OptionTradeJournalRecord {
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
    outcome: 'WIN',
    closeTs: seq + 1,
    realizedPnlUsd: 100,
    realizedR: 1,
    exitReason: 'target',
    holdDays: 3,
    ...over,
  };
}

/**
 * Persist a row the way production does: an OPEN append followed by a CLOSE
 * append. `recordOptionTradeOpen` stamps `outcome:'OPEN'` regardless of what the
 * literal says, so a store-backed fixture that only opens is an OPEN row — and
 * every downstream fold would drop it for being unresolved rather than for its
 * account class, quietly making a broken filter look correct.
 */
async function persist(row: OptionTradeJournalRecord): Promise<OptionTradeJournalRecord> {
  await recordOptionTradeOpen(row);
  await recordOptionTradeClose(row.id, {
    closeTs: row.closeTs!,
    // The literal is always a resolved verdict (see `closedRow`); the record type
    // widens `outcome` to include 'OPEN', which the close payload cannot carry.
    outcome: row.outcome === 'OPEN' ? 'WIN' : row.outcome,
    realizedPnlUsd: row.realizedPnlUsd!,
    realizedR: row.realizedR!,
    exitReason: row.exitReason!,
    holdDays: row.holdDays!,
  });
  return row;
}

const FIXTURE = { account: 'qa_tra2214_fixture' }; // ^qa ⇒ a test book
const DESK = { account: 'realtrader' }; // a real book
// No `account` key at all — the 2,164-row pre-TRA-1475 majority.
const UNATTRIBUTED: Partial<OptionTradeJournalRecord> = {};

describe('TRA-2214 applyModelFacingBasis — the account-class predicate + census', () => {
  it('keeps desk + unattributed, drops fixtures, and the census closes', () => {
    const rows = [
      closedRow(DESK),
      closedRow(UNATTRIBUTED),
      closedRow(UNATTRIBUTED),
      closedRow(FIXTURE),
      closedRow(FIXTURE),
      closedRow(FIXTURE),
    ];

    const out = applyModelFacingBasis(rows, { env: {} });

    expect(out.basis).toBe('desk+unattributed');
    expect(out.counts).toEqual({ desk: 1, unattributed: 2, fixtureExcluded: 3 });
    expect(out.rows).toHaveLength(3);
    expect(out.rows.some((r) => r.account?.startsWith('qa'))).toBe(false);
    // The census must partition the INPUT, not merely describe the output — a
    // count that doesn't sum to the rows fed in is a count that can hide a class.
    expect(out.counts.desk + out.counts.unattributed + out.counts.fixtureExcluded)
      .toBe(rows.length);
  });

  it('prove-it-fires: includeTest keeps the same fixtures and reports 0 excluded', () => {
    // The mutation control. Without this, "3 rows kept" is consistent with a
    // predicate that drops three rows for any reason at all — or with a fixture
    // set that happened to contain three unusable rows. Flip the one input the
    // filter reads and the SAME rows must come back, with an honest census.
    const rows = [closedRow(DESK), closedRow(UNATTRIBUTED), closedRow(FIXTURE)];

    const filtered = applyModelFacingBasis(rows, { env: {} });
    const unfiltered = applyModelFacingBasis(rows, { env: {}, includeTest: true });

    expect(filtered.rows).toHaveLength(2);
    expect(unfiltered.rows).toHaveLength(3);
    expect(unfiltered.counts.fixtureExcluded).toBe(0);
    expect(unfiltered.counts.desk).toBe(2); // the fixture book counts as owned here
  });

  it('an all-fixture journal folds to zero rows, not to "no fixtures found"', () => {
    // The TRA-2212 trap in miniature: `fixtureExcluded` is the field that separates
    // "nothing was dropped" from "everything was". A basis line reading 0/0/0 and
    // one reading 0/0/5 mean opposite things and must not render the same.
    const out = applyModelFacingBasis([closedRow(FIXTURE), closedRow(FIXTURE)], { env: {} });
    expect(out.rows).toEqual([]);
    expect(out.counts).toEqual({ desk: 0, unattributed: 0, fixtureExcluded: 2 });
  });
});

describe('TRA-2214 loadModelFacingJournal — through the real durable store', () => {
  let tmpFile: string;
  let fileSeq = 0;

  beforeEach(() => {
    fileSeq += 1;
    tmpFile = join(tmpdir(), `mfj-${process.pid}-${fileSeq}.jsonl`);
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

  it('a fixture-account row is absent from the loaded rows', async () => {
    const fixture = closedRow(FIXTURE);
    const desk = closedRow(DESK);
    const orphan = closedRow(UNATTRIBUTED);
    for (const r of [fixture, desk, orphan]) await persist(r);

    const out = await loadModelFacingJournal();

    expect(out.rows.map((r) => r.id).sort()).toEqual([desk.id, orphan.id].sort());
    expect(out.rows.map((r) => r.id)).not.toContain(fixture.id);
    expect(out.counts.fixtureExcluded).toBe(1);
    expect(out.basis).toBe(MODEL_FACING_JOURNAL_BASIS);
  });

  it('a mode:live row never reaches a model-facing fold', async () => {
    // Today this is inert — 100% of the 2,359 live rows are `mode:'demo'`. It stops
    // being inert the moment TRA-2134's Tradier SANDBOX journaling starts writing,
    // and there is no wire-format tell when it does; hence the pin.
    const demo = closedRow(DESK);
    const live = closedRow({ ...DESK, mode: 'live' });
    for (const r of [demo, live]) await persist(r);

    const rows = await loadModelFacingJournalRows();

    expect(rows.map((r) => r.id)).toEqual([demo.id]);
  });
});

describe('TRA-2214 OptionWeightsCache default loader', () => {
  let tmpFile: string;
  let fileSeq = 0;

  beforeEach(() => {
    fileSeq += 1;
    tmpFile = join(tmpdir(), `mfj-lwc-${process.pid}-${fileSeq}.jsonl`);
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

  /**
   * The cache's default `load` is the thing under test, so it must NOT be injected.
   * `resolved` (the bucket's sample count) is the observable: it counts exactly the
   * rows that reached `computeOptionLearnedWeights`, which is the acceptance
   * criterion phrased as a number the fold itself publishes.
   */
  const params = {
    minSamples: 1,
    baselineHitRate: 0.5,
    sensitivity: 1,
    expectancyPenalty: 0.1,
    floor: 0.5,
    ceil: 1.5,
  };

  it('folds neither a live row nor a fixture row (2 of 4 reach the fold)', async () => {
    await persist(closedRow(DESK));
    await persist(closedRow(UNATTRIBUTED));
    await persist(closedRow(FIXTURE));
    await persist(closedRow({ ...DESK, mode: 'live' }));

    const { weights } = await new OptionWeightsCache({ params }).get();

    const bullPut = weights.byStructure.find((s) => s.key === 'bull_put');
    expect(bullPut?.resolved).toBe(2);
  });

  it('prove-it-fires: all four reach the fold when the loader is opted out', async () => {
    // Positive control for the assertion above. If the journal store or the fixture
    // shape were wrong, `resolved` would read low for a reason that has nothing to
    // do with the filter — and `2` would look like a pass. Feeding the SAME four
    // rows through an unfiltered loader must yield 4.
    const rows = [
      closedRow(DESK),
      closedRow(UNATTRIBUTED),
      closedRow(FIXTURE),
      closedRow({ ...DESK, mode: 'live' }),
    ];
    for (const r of rows) await persist(r);

    const { weights } = await new OptionWeightsCache({
      params,
      load: async () => rows,
    }).get();

    expect(weights.byStructure.find((s) => s.key === 'bull_put')?.resolved).toBe(4);
  });
});
