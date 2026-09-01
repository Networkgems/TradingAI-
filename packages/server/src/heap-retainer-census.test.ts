import { describe, it, expect } from 'vitest';
import {
  censusObject,
  foldCensus,
  HeapCensusTape,
  type CensusSubject,
} from './heap-retainer-census.js';

// TRA-4158 — the census exists to name the container that retains bqb1's RTH
// heap (352 MB -> 1605 MB across one session, flat overnight). Every control
// below is written against the way this instrument could go WRONG QUIETLY,
// because a memory probe that under-reports looks exactly like a healthy box:
//
//   * it could miss a container that a hand-written field list forgot;
//   * it could report a fleet total that hides a single hot owner;
//   * it could drop a retainer that was RELEASED, which is the outcome the fix
//     is trying to produce and therefore the one it must be able to show;
//   * it could grow without bound itself, which is the very defect class.
//
// A census that only ever finds containers someone already suspected is not
// evidence, so the completeness arm is the load-bearing one.

class EngineLike {
  candleCache = new Map<string, number[]>();
  symbolState = new Map<string, { n: number }>();
  dynamicSymbols = new Set<string>();
  recentSignals: string[] = [];
  // Scalars and non-containers must not appear as rows.
  username = 'alice';
  tickCount = 0;
  handler: (() => void) | null = null;
}

describe('censusObject', () => {
  it('finds every own container field WITHOUT being told which ones to look for', () => {
    const e = new EngineLike();
    e.candleCache.set('AAPL', [1, 2, 3]);
    e.symbolState.set('AAPL', { n: 1 });
    e.dynamicSymbols.add('AAPL');
    e.recentSignals.push('s1', 's2');

    const rows = censusObject(e);
    const names = rows.map(r => r.key).sort();

    // The completeness claim: all four containers, and ONLY containers.
    expect(names).toEqual(['candleCache', 'dynamicSymbols', 'recentSignals', 'symbolState']);
    expect(rows.every(r => ['map', 'set', 'array'].includes(r.kind))).toBe(true);
  });

  it('picks up a container added AFTER the instrument was written', () => {
    // The staleness control. A hand-written suspect list passes the test above
    // and fails this one, which is the whole reason the walk is reflective.
    const e = new EngineLike() as EngineLike & { brandNewCache?: Map<string, number> };
    e.brandNewCache = new Map([['X', 1]]);
    const rows = censusObject(e);
    expect(rows.find(r => r.key === 'brandNewCache')?.entries).toBe(1);
  });

  it('sorts by entries descending so the head of the list is the answer', () => {
    const e = new EngineLike();
    for (let i = 0; i < 5; i += 1) e.symbolState.set(`S${i}`, { n: i });
    e.candleCache.set('AAPL', [1]);
    const rows = censusObject(e);
    expect(rows[0].key).toBe('symbolState');
    expect(rows[0].entries).toBe(5);
  });

  it('never runs an own accessor', () => {
    const target: Record<string, unknown> = { plain: [1, 2] };
    let ran = 0;
    Object.defineProperty(target, 'trap', {
      enumerable: true,
      get() {
        ran += 1;
        return new Map([['a', 1]]);
      },
    });
    const rows = censusObject(target);
    expect(ran).toBe(0);
    expect(rows.map(r => r.key)).toEqual(['plain']);
  });

  it('separates KEY growth from VALUE growth — the two have different fixes', () => {
    // `Map<string, Candle[]>` gaining keys is universe drift; the same map's
    // existing arrays getting longer is an append with no trim. A shallow count
    // cannot tell them apart, so the deep sum is what makes the distinction.
    const e = new EngineLike();
    e.candleCache.set('AAPL', [1, 2, 3, 4]);
    e.candleCache.set('MSFT', [1, 2]);

    const shallow = censusObject(e).find(r => r.key === 'candleCache');
    expect(shallow).toMatchObject({ entries: 2, nested: null });

    const deep = censusObject(e, { deep: true }).find(r => r.key === 'candleCache');
    expect(deep).toMatchObject({ entries: 2, nested: 6 });
  });

  it('reports nested null — not 0 — when the values are not arrays', () => {
    // `0` would read as "its values are empty arrays". They are numbers; there
    // is no nested dimension to report, and the two must not look alike.
    const e = new EngineLike();
    e.symbolState.set('AAPL', { n: 1 });
    const deep = censusObject(e, { deep: true }).find(r => r.key === 'symbolState');
    expect(deep?.nested).toBeNull();
  });

  it('stops the deep sum at its entry budget rather than becoming its own incident', () => {
    const e = new EngineLike();
    for (let i = 0; i < 100; i += 1) e.candleCache.set(`S${i}`, [1, 1]);
    const capped = censusObject(e, { deep: true, deepEntryBudget: 10 }).find(r => r.key === 'candleCache');
    expect(capped?.entries).toBe(100); // the shallow count is always exact
    expect(capped?.nested).toBe(20); // the deep sum walked 10 of 100
  });
});

describe('foldCensus', () => {
  const makeSubjects = (sizes: readonly number[]): CensusSubject[] =>
    sizes.map(size => {
      const e = new EngineLike();
      for (let i = 0; i < size; i += 1) e.candleCache.set(`S${i}`, [1]);
      return { klass: 'signalEngine', target: e };
    });

  it('multiplies a per-user container across its owners — the x67 the fleet actually pays', () => {
    const rows = foldCensus(makeSubjects([10, 10, 10]));
    const candle = rows.find(r => r.name === 'signalEngine.candleCache');
    expect(candle).toMatchObject({ owners: 3, entries: 30, maxEntries: 10 });
  });

  it('distinguishes a spread fleet total from one hot owner carrying all of it', () => {
    // 30 entries over 3 owners and 30 entries in ONE owner are different
    // defects with different fixes, and the fleet total alone cannot tell them
    // apart. `maxEntries` is what discriminates.
    const spread = foldCensus(makeSubjects([10, 10, 10]));
    const hot = foldCensus(makeSubjects([30, 0, 0]));
    const spreadRow = spread.find(r => r.name === 'signalEngine.candleCache');
    const hotRow = hot.find(r => r.name === 'signalEngine.candleCache');
    expect(spreadRow?.entries).toBe(hotRow?.entries);
    expect(spreadRow?.maxEntries).toBe(10);
    expect(hotRow?.maxEntries).toBe(30);
  });

  it('keeps two classes apart under the same field name', () => {
    const engine = new EngineLike();
    engine.recentSignals.push('a');
    const crypto = new EngineLike();
    crypto.recentSignals.push('a', 'b', 'c');
    const rows = foldCensus([
      { klass: 'signalEngine', target: engine },
      { klass: 'cryptoEngine', target: crypto },
    ]);
    expect(rows.find(r => r.name === 'signalEngine.recentSignals')?.entries).toBe(1);
    expect(rows.find(r => r.name === 'cryptoEngine.recentSignals')?.entries).toBe(3);
  });
});

describe('HeapCensusTape', () => {
  const subjectsWith = (candleKeys: number): CensusSubject[] => {
    const e = new EngineLike();
    for (let i = 0; i < candleKeys; i += 1) e.candleCache.set(`S${i}`, [1]);
    return [{ klass: 'signalEngine', target: e }];
  };

  it('is bounded — the instrument must not be a new instance of the defect it hunts', () => {
    const tape = new HeapCensusTape(3);
    for (let i = 0; i < 10; i += 1) tape.record(subjectsWith(i), 1000 + i);
    expect(tape.length).toBe(3);
    const kept = tape.snapshot();
    expect(kept.map(s => s.atMs)).toEqual([1007, 1008, 1009]);
  });

  it('refuses a capacity that would make it unbounded or empty', () => {
    expect(() => new HeapCensusTape(0)).toThrow(/positive integer/);
    expect(() => new HeapCensusTape(-1)).toThrow(/positive integer/);
  });

  it('ranks the retainer that GREW, not the one that is merely biggest', () => {
    // The static-but-large container is the decoy: on any single read it tops
    // the census, and it is not the defect. Only the series separates them.
    const bigStatic = new EngineLike();
    for (let i = 0; i < 500; i += 1) bigStatic.symbolState.set(`S${i}`, { n: i });
    const grower = new EngineLike();

    const tape = new HeapCensusTape(10);
    for (let step = 0; step < 5; step += 1) {
      grower.candleCache.set(`C${step}`, [1]);
      tape.record(
        [
          { klass: 'signalEngine', target: bigStatic },
          { klass: 'signalEngine', target: grower },
        ],
        1000 + step,
      );
    }

    const trends = tape.trends();
    expect(trends[0].name).toBe('signalEngine.candleCache');
    expect(trends[0]).toMatchObject({ first: 1, last: 5, peak: 5, delta: 4 });
    const staticRow = trends.find(t => t.name === 'signalEngine.symbolState');
    expect(staticRow).toMatchObject({ delta: 0, ratio: 1 });
  });

  it('can show a retainer being RELEASED — the outcome AC2 has to be able to prove', () => {
    // A trend list that silently drops names it no longer sees would make a
    // successful eviction indistinguishable from the instrument going blind.
    const e = new EngineLike();
    e.candleCache.set('AAPL', [1]);
    e.candleCache.set('MSFT', [1]);
    const tape = new HeapCensusTape(10);
    tape.record([{ klass: 'signalEngine', target: e }], 1000);
    e.candleCache.clear();
    tape.record([{ klass: 'signalEngine', target: e }], 2000);

    const row = tape.trends().find(t => t.name === 'signalEngine.candleCache');
    expect(row).toMatchObject({ first: 2, last: 0, peak: 2, delta: -2, ratio: 0 });
  });

  it('reports ratio null rather than Infinity for a container that gained its first entry', () => {
    const e = new EngineLike();
    const tape = new HeapCensusTape(10);
    tape.record([{ klass: 'signalEngine', target: e }], 1000);
    e.candleCache.set('AAPL', [1]);
    tape.record([{ klass: 'signalEngine', target: e }], 2000);
    const row = tape.trends().find(t => t.name === 'signalEngine.candleCache');
    expect(row?.ratio).toBeNull();
    expect(row?.delta).toBe(1);
  });

  it('carries the memory levels the counts are supposed to explain', () => {
    const tape = new HeapCensusTape(4);
    const sample = tape.record(subjectsWith(2), 1000);
    expect(sample.atMs).toBe(1000);
    expect(sample.subjects).toBe(1);
    expect(sample.heapUsedMB).toBeGreaterThan(0);
    expect(sample.rssMB).toBeGreaterThan(0);
    expect(sample.counts['signalEngine.candleCache']).toBe(2);
    expect(sample.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('returns no trends from an empty tape instead of throwing', () => {
    expect(new HeapCensusTape(4).trends()).toEqual([]);
  });
});
