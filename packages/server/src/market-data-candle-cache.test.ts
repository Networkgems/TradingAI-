import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import type { Candle } from '@trading-app/shared';
import { SignalEngine } from './signal-engine.js';
import {
  __resetMarketDataCandleCacheForTest,
  candleShareStats,
  getCandles,
  marketDataCandleCacheCensusTarget,
  marketDataCandleCacheSize,
  setCandles,
} from './market-data-candle-cache.js';
import { foldCensus, type CensusSubject } from './heap-retainer-census.js';
import { RETAINER_BOUND_NOTES } from './retainer-bound-notes.js';

function bars(symbol: string, count: number, startMs = 1_700_000_000_000, close = 100): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      symbol,
      timestamp: startMs + i * 60_000,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000 + i,
    });
  }
  return out;
}

describe('TRA-4986 market-data minute-candle store', () => {
  beforeEach(() => {
    __resetMarketDataCandleCacheForTest();
  });

  it('is ONE copy: two engines reading the same symbol get the identical array object', () => {
    const a = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });
    const b = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });
    type Priv = { candleCache: Map<string, Candle[]> };

    const series = bars('AAPL', 80);
    setCandles('AAPL', series);

    // The whole point of the hoist: not merely equal, the SAME object.
    expect((a as unknown as Priv).candleCache.get('AAPL')).toBe(series);
    expect((b as unknown as Priv).candleCache.get('AAPL')).toBe(series);
    expect((a as unknown as Priv).candleCache).toBe((b as unknown as Priv).candleCache);
    expect(marketDataCandleCacheSize()).toBe(1);
  });

  it('a write through one engine is visible to another — the per-engine copy is gone', () => {
    const a = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });
    const b = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'live' });
    type Priv = { candleCache: Map<string, Candle[]> };

    (a as unknown as Priv).candleCache.set('NVDA', bars('NVDA', 10));
    expect((b as unknown as Priv).candleCache.get('NVDA')).toHaveLength(10);
  });

  it('AC2 — the per-engine census row is ABSENT (not owners:0) and the shared row is PRESENT with owners 1', () => {
    const engines = [
      new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' }),
      new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' }),
      new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' }),
    ];
    setCandles('AAPL', bars('AAPL', 80));
    setCandles('MSFT', bars('MSFT', 40));

    const subjects: CensusSubject[] = [
      ...engines.map((e): CensusSubject => ({ klass: 'signalEngine', target: e })),
      { klass: 'marketData', target: marketDataCandleCacheCensusTarget },
    ];
    const rows = foldCensus(subjects, { deep: true, notes: RETAINER_BOUND_NOTES });

    // ABSENT is the success condition. A getter is neither an own property nor a
    // data property, so the reflective walk emits no row at all — which is why a
    // check written for `owners === 0` would refuse a hoist that worked.
    expect(rows.find(r => r.name === 'signalEngine.candleCache')).toBeUndefined();

    const shared = rows.find(r => r.name === 'marketData.minuteCandles');
    expect(shared).toBeDefined();
    expect(shared?.owners).toBe(1);
    expect(shared?.entries).toBe(2);
    expect(shared?.nested).toBe(120);
    // ...and it is the SAME read that saw three signalEngine subjects, so an
    // absent per-engine row cannot be the instrument having gone blind.
    expect(rows.find(r => r.name === 'signalEngine.symbolState')?.owners).toBe(3);
  });

  it('AC1 — a re-write of the identical series is classified equalByValue, never a divergence', () => {
    const first = bars('AAPL', 80);
    // A fresh array with identical content — exactly what two engines got from
    // `fetchMinuteBarsWithSource`'s `entry.bars.slice(-count)` off ONE cache entry.
    const second = bars('AAPL', 80);
    expect(second).not.toBe(first);

    setCandles('AAPL', first);
    setCandles('AAPL', second);

    const s = candleShareStats();
    expect(s.writes).toBe(2);
    expect(s.rewrites).toBe(1);
    expect(s.equalByValue).toBe(1);
    expect(s.divergentSameInstant).toBe(0);
    expect(s.divergentWitness).toEqual([]);
    expect(getCandles('AAPL')).toBe(second); // last-writer-wins
  });

  it('AC1 — an ordinary sharded refresh (newer newest bar) is newerSeries, not a divergence', () => {
    setCandles('AAPL', bars('AAPL', 80));
    setCandles('AAPL', bars('AAPL', 80, 1_700_000_060_000));

    const s = candleShareStats();
    expect(s.newerSeries).toBe(1);
    expect(s.equalByValue).toBe(0);
    expect(s.divergentSameInstant).toBe(0);
  });

  it('AC1 — THE FALSIFIER: a disagreement at the same newest instant is counted and witnessed', () => {
    const held = bars('AAPL', 80);
    const conflicting = bars('AAPL', 80);
    // Same newest timestamp, different close on the newest bar — the only shape
    // under which one shared copy could be wrong for one of the two callers.
    const last = conflicting[conflicting.length - 1];
    if (!last) throw new Error('fixture');
    last.close = 999;

    setCandles('AAPL', held);
    setCandles('AAPL', conflicting);

    const s = candleShareStats();
    expect(s.divergentSameInstant).toBe(1);
    expect(s.newerSeries).toBe(0);
    expect(s.equalByValue).toBe(0);
    expect(s.divergentWitness).toHaveLength(1);
    expect(s.divergentWitness[0]).toMatchObject({
      symbol: 'AAPL',
      field: 'close',
      atIndex: 0,
      heldValue: 100,
      incomingValue: 999,
    });
  });

  it('AC1 — a backwards write is olderSeries, so the hazard the monotone guard would cover is measured', () => {
    setCandles('AAPL', bars('AAPL', 80, 1_700_000_060_000));
    setCandles('AAPL', bars('AAPL', 80, 1_700_000_000_000));

    const s = candleShareStats();
    expect(s.olderSeries).toBe(1);
    expect(s.divergentSameInstant).toBe(0);
    // Last-writer-wins is PRESERVED — the counter publishes the hazard, it does
    // not silently introduce a new behaviour on a live-money path.
    expect(getCandles('AAPL')?.[0]?.timestamp).toBe(1_700_000_000_000);
  });

  it('a longer series at the same newest instant whose overlapping tail agrees is not a divergence', () => {
    // 40 bars ending at T, then 80 bars ending at the same T — more history off
    // the same feed, which must not be reported as two callers disagreeing.
    // Built the way production builds them: both are `slice(-count)` of ONE
    // upstream entry, which is what makes the overlapping tail agree.
    const long = bars('AAPL', 80, 1_700_000_000_000);
    const short = long.slice(-40);
    expect(short[short.length - 1]?.timestamp).toBe(long[long.length - 1]?.timestamp);
    expect(short).toHaveLength(40);

    setCandles('AAPL', short);
    setCandles('AAPL', long);

    const s = candleShareStats();
    expect(s.divergentSameInstant).toBe(0);
    expect(s.equalByValue).toBe(1);
  });

  it('the witness ring is bounded — the instrument cannot become the leak it hunts', () => {
    for (let i = 0; i < 40; i += 1) {
      const held = bars(`S${i}`, 5);
      const conflicting = bars(`S${i}`, 5);
      const last = conflicting[conflicting.length - 1];
      if (!last) throw new Error('fixture');
      last.volume = 7;
      setCandles(`S${i}`, held);
      setCandles(`S${i}`, conflicting);
    }
    const s = candleShareStats();
    expect(s.divergentSameInstant).toBe(40);
    expect(s.divergentWitness).toHaveLength(20);
  });

  it('the reset clears the counters as well as the map, so one suite cannot grade another', () => {
    setCandles('AAPL', bars('AAPL', 3));
    setCandles('AAPL', bars('AAPL', 3));
    expect(candleShareStats().rewrites).toBe(1);

    __resetMarketDataCandleCacheForTest();
    const s = candleShareStats();
    expect(s.writes).toBe(0);
    expect(s.rewrites).toBe(0);
    expect(s.symbols).toBe(0);
    expect(marketDataCandleCacheSize()).toBe(0);
  });
});

describe('TRA-4986 AC3 published retainer dispositions', () => {
  it('publishes an explicit reason for the one deliberately unbounded row', () => {
    const note = RETAINER_BOUND_NOTES['signalEngine.dynamicSymbols'];
    expect(note).toBeDefined();
    // `bound: null` is a CLAIM, so it only counts when the reason carries the
    // mechanism AND names where the demand is actually capped.
    expect(note?.bound).toBeNull();
    expect(note?.reason).toMatch(/persisted/i);
    expect(note?.reason).toMatch(/watchlist\.json|stocks\.added/);
    expect(note?.boundedBy).toMatch(/boundActiveSymbols|scanUniverseBound/);
  });

  it('attaches the note to the census row the reflective walk found', () => {
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });
    const rows = foldCensus(
      [{ klass: 'signalEngine', target: engine }],
      { notes: RETAINER_BOUND_NOTES },
    );
    const dyn = rows.find(r => r.name === 'signalEngine.dynamicSymbols');
    expect(dyn?.note?.bound).toBeNull();
    expect(dyn?.note?.reason).toContain('Deliberately uncapped');
  });

  it('an un-annotated row reads note:null — a gap in the record, not a claim of unboundedness', () => {
    const rows = foldCensus(
      [{ klass: 'signalEngine', target: new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' }) }],
      { notes: RETAINER_BOUND_NOTES },
    );
    const unannotated = rows.filter(r => r.note === null);
    expect(unannotated.length).toBeGreaterThan(0);
    expect(unannotated.every(r => !(r.name in RETAINER_BOUND_NOTES))).toBe(true);
  });

  it('notes never change WHAT is walked — the same subjects fold to the same rows either way', () => {
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });
    const withNotes = foldCensus([{ klass: 'signalEngine', target: engine }], { notes: RETAINER_BOUND_NOTES });
    const without = foldCensus([{ klass: 'signalEngine', target: engine }]);
    expect(withNotes.map(r => r.name)).toEqual(without.map(r => r.name));
    expect(without.every(r => r.note === null)).toBe(true);
  });
});
