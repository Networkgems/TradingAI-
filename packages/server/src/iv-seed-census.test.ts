import { describe, it, expect, afterEach } from 'vitest';
import type { ChainDay } from '@trading-app/backtest';
import type { OptionChainRow } from '@trading-app/engine';
import {
  ensureArchiveSeedCensusFresh,
  readArchiveSeedCensusSync,
  resetArchiveSeedCensusForTests,
  summarizeSeedableUniverse,
} from './iv-seed-census.js';
import { MIN_IV_SAMPLES } from './iv-rank-store.js';

// TRA-5171 — the chain-archive seedable-depth census behind the TRA-5170 seed
// decision. The loader is injected so these tests grade the census logic, not
// the disk format (that loader, `loadChainDays`, has its own suite in
// chain-partition-compactor.test.ts).

const DAY = 86_400_000;

function row(strike: number, iv: number): OptionChainRow {
  return {
    optionSymbol: `O${strike}`,
    underlying: 'X',
    optionType: 'call',
    strike,
    expiration: '2027-01-15',
    bid: 1,
    ask: 1.2,
    smvVol: iv,
  } as unknown as OptionChainRow;
}

/** One partition carrying a snapshot for each listed symbol (ATM IV per symbol). */
function chainDay(date: string, symbols: ReadonlyArray<readonly [string, number]>): ChainDay {
  const bySymbol = new Map();
  for (const [symbol, iv] of symbols) {
    bySymbol.set(symbol, {
      symbol,
      spot: 100,
      recordedAt: Date.parse(`${date}T20:00:00Z`),
      expirations: ['2027-01-15'],
      rows: [row(100, iv)],
    });
  }
  return { date, bySymbol } as ChainDay;
}

/** `n` recent partition dates (all inside the 366-day trailing window), ascending. */
function recentDates(n: number): string[] {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => new Date(now - (n - i) * DAY).toISOString().slice(0, 10));
}

/** DEEP appears in all `deep` partitions (>= floor), THIN only in the last 2. */
function plantedArchive(deep: number): ChainDay[] {
  const dates = recentDates(deep);
  return dates.map((d, i) =>
    chainDay(d, i >= deep - 2 ? ([['DEEP', 0.2 + i * 0.001], ['THIN', 0.3]] as const) : ([['DEEP', 0.2 + i * 0.001]] as const)),
  );
}

afterEach(() => {
  resetArchiveSeedCensusForTests();
});

describe('archive seedable-depth census (TRA-5171)', () => {
  it('reads an honest pending (never a fabricated zero) before the first walk lands', () => {
    resetArchiveSeedCensusForTests(() => new Promise<ChainDay[]>(() => {}), '/census-test');
    const read = readArchiveSeedCensusSync();
    expect(read.status).toBe('pending');
    expect(read.census).toBeNull();
    expect(read.computeError).toBeNull();
  });

  it('measures per-symbol seedable depth, the histogram, and the floor count', async () => {
    const deep = MIN_IV_SAMPLES + 5; // 25 partitions
    resetArchiveSeedCensusForTests(async () => plantedArchive(deep), '/census-test');
    await ensureArchiveSeedCensusFresh();
    const read = readArchiveSeedCensusSync();
    expect(read.status).toBe('ready');
    expect(read.computeError).toBeNull();
    const census = read.census!;
    expect(census.chainsDir).toBe('/census-test');
    expect(census.partitionCount).toBe(deep);
    expect(census.oldestPartitionDay).toBe(recentDates(deep)[0]);
    expect(census.newestPartitionDay).toBe(recentDates(deep)[deep - 1]);
    expect(census.archiveSymbolCount).toBe(2);
    expect(census.minSamples).toBe(MIN_IV_SAMPLES);
    // DEEP would seed to 25 (>= floor), THIN to 2 — the instrument can show a
    // deep symbol, so a shallow reading is a measurement, not a ceiling.
    expect(census.depthHistogram).toEqual({ [String(deep)]: 1, '2': 1 });
    expect(census.archiveSymbolsAtOrAboveFloor).toBe(1);
  });

  it('does not re-walk inside the refresh TTL', async () => {
    let calls = 0;
    resetArchiveSeedCensusForTests(async () => {
      calls++;
      return plantedArchive(3);
    }, '/census-test');
    await ensureArchiveSeedCensusFresh();
    readArchiveSeedCensusSync();
    readArchiveSeedCensusSync();
    expect(calls).toBe(1);
  });

  it('a failed walk surfaces its reason verbatim and never fabricates a census', async () => {
    resetArchiveSeedCensusForTests(async () => {
      throw new Error('EACCES: walk refused');
    }, '/census-test');
    await ensureArchiveSeedCensusFresh();
    const read = readArchiveSeedCensusSync();
    expect(read.status).toBe('pending');
    expect(read.census).toBeNull();
    expect(read.computeError).toContain('EACCES: walk refused');
  });
});

describe('summarizeSeedableUniverse (TRA-5171)', () => {
  it('reads census_pending with nulls (not zeros) before the walk lands', () => {
    resetArchiveSeedCensusForTests(() => new Promise<ChainDay[]>(() => {}), '/census-test');
    const s = summarizeSeedableUniverse(['AAPL', 'MSFT']);
    expect(s.basis).toBe('census_pending');
    expect(s.universeSize).toBe(2);
    expect(s.matchedInArchive).toBeNull();
    expect(s.seedableAtFloor).toBeNull();
    expect(s.universeDepthHistogram).toBeNull();
  });

  it('counts the universe symbols the seed would take to the floor — the TRA-5170 deciding number', async () => {
    const deep = MIN_IV_SAMPLES + 5;
    resetArchiveSeedCensusForTests(async () => plantedArchive(deep), '/census-test');
    await ensureArchiveSeedCensusFresh();
    // MISSING is in the live universe but absent from the archive: a measured
    // depth-0 (the walk ran), binned at "0", never dropped from the population.
    const s = summarizeSeedableUniverse(['DEEP', 'thin', 'MISSING']);
    expect(s.basis).toBe('archive_census');
    expect(s.universeSize).toBe(3);
    expect(s.matchedInArchive).toBe(2);
    expect(s.seedableAtFloor).toBe(1);
    expect(s.universeDepthHistogram).toEqual({ [String(deep)]: 1, '2': 1, '0': 1 });
  });
});
