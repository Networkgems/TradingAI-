import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import type { ReversalShadowRecord } from './reversal-shadow-ledger.js';
import { computeLearnedWeights } from './learned-signal-weights.js';
import {
  setLearnedWeightsHistoryFileForTests,
  learnedWeightsHistoryFile,
  appendLearnedWeightsSnapshot,
  listLearnedWeightsSnapshots,
  buildLearnedWeightsSnapshot,
  learnedWeightsTrajectory,
  recordDailyLearnedWeightsSnapshot,
  isLearnedWeightsSnapshotEnabled,
  initLearnedWeightsHistory,
  etDay,
  LEARNED_WEIGHTS_SNAPSHOT_FLAG,
  MAX_SNAPSHOT_ROWS,
  type LearnedWeightsSnapshot,
} from './learned-weights-history.js';

// 2026-07-20 (Monday) is EDT, so 21:00 ET = 01:00 UTC on the 21st. Using a real
// post-21:00-ET instant keeps the ET-day derivation honest (a naive UTC slice
// would stamp this row 2026-07-21).
const D1_TICK = Date.UTC(2026, 6, 21, 1, 0); // 2026-07-20 21:00 ET
const DAY_MS = 86_400_000;

let dir: string;
let file: string;

function row(over: Partial<ReversalShadowRecord> = {}): ReversalShadowRecord {
  return {
    id: `SPY:long:${over.ts ?? 1}`,
    ts: 1,
    symbol: 'SPY',
    side: 'long',
    atKeyLevel: true,
    trendBreak: true,
    unhealthyMove: true,
    pattern: true,
    patternName: 'hammer',
    score: 4,
    zoneTouches: 2,
    entry: 100,
    stop: 99,
    target: 102,
    outcome: 'TP_HIT',
    realizedR: 2,
    ...over,
  };
}

/** A ledger with enough resolved rows for the min-sample guard (10) to clear. */
function ledger(n = 12, over: Partial<ReversalShadowRecord> = {}): ReversalShadowRecord[] {
  return Array.from({ length: n }, (_, i) =>
    row({ id: `SPY:long:${i}`, ts: i + 1, ...over }),
  );
}

function snapshotFrom(
  rows: ReversalShadowRecord[],
  date: string,
  opts: { generatedAt?: number; shrinkageFlagEnabled?: boolean; watchlist?: readonly string[] } = {},
): LearnedWeightsSnapshot {
  return buildLearnedWeightsSnapshot(computeLearnedWeights(rows), {
    date,
    generatedAt: opts.generatedAt ?? D1_TICK,
    shrinkageFlagEnabled: opts.shrinkageFlagEnabled ?? false,
    ...(opts.watchlist !== undefined ? { watchlist: opts.watchlist } : {}),
  });
}

function lines(): string[] {
  return readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim() !== '');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lwh-'));
  file = join(dir, 'learned-weights-history.jsonl');
  setLearnedWeightsHistoryFileForTests(file);
  delete process.env[LEARNED_WEIGHTS_SNAPSHOT_FLAG];
});

afterEach(() => {
  setLearnedWeightsHistoryFileForTests(null);
  delete process.env[LEARNED_WEIGHTS_SNAPSHOT_FLAG];
  rmSync(dir, { recursive: true, force: true });
});

describe('flag', () => {
  it('is OFF by default and accepts the usual truthy spellings', () => {
    expect(isLearnedWeightsSnapshotEnabled({})).toBe(false);
    expect(isLearnedWeightsSnapshotEnabled({ [LEARNED_WEIGHTS_SNAPSHOT_FLAG]: 'false' })).toBe(false);
    for (const v of ['1', 'true', 'YES', ' on ']) {
      expect(isLearnedWeightsSnapshotEnabled({ [LEARNED_WEIGHTS_SNAPSHOT_FLAG]: v })).toBe(true);
    }
  });
});

describe('AC1 — append writes one line with today ET date and the bounded payload', () => {
  it('writes exactly one line carrying the date key and the (E) shape', async () => {
    const res = await recordDailyLearnedWeightsSnapshot({
      readLedger: async () => ledger(),
      now: D1_TICK,
      env: { [LEARNED_WEIGHTS_SNAPSHOT_FLAG]: '1' },
    });

    expect(res).toEqual({ written: true, date: '2026-07-20' });
    expect(lines()).toHaveLength(1);

    const rec = JSON.parse(lines()[0]!) as LearnedWeightsSnapshot;
    expect(rec.date).toBe('2026-07-20'); // ET, not the 07-21 UTC day
    expect(rec.generatedAt).toBe(D1_TICK);
    expect(rec.ledger).toEqual({ rows: 12, resolved: 12, priorRate: 1 });
    expect(rec.params.minSamples).toBe(10);
    expect(Object.keys(rec).sort()).toEqual([
      'bySymbol', 'bySymbolOmitted', 'byPattern', 'byScore',
      'date', 'generatedAt', 'ledger', 'params', 'shrinkageFlagEnabled',
    ].sort());

    // Bounded per-bucket payload: the back-compat `multiplier` field is dropped.
    const stat = rec.byScore[0]!;
    expect(Object.keys(stat).sort()).toEqual([
      'avgR', 'confident', 'hitRate', 'key', 'multiplierHardGate',
      'multiplierShrunk', 'resolved', 'slHit', 'timeout', 'total', 'tpHit',
    ].sort());
    expect(stat).not.toHaveProperty('multiplier');
  });
});

describe('AC2 — same-ET-date re-fire is a no-op', () => {
  it('does not append a second row for the same date', async () => {
    const env = { [LEARNED_WEIGHTS_SNAPSHOT_FLAG]: '1' };
    const first = await recordDailyLearnedWeightsSnapshot({ readLedger: async () => ledger(), now: D1_TICK, env });
    // Same ET day, later wall clock — the post-21:00 restart re-fire class.
    const second = await recordDailyLearnedWeightsSnapshot({
      readLedger: async () => ledger(30),
      now: D1_TICK + 3_600_000,
      env,
    });

    expect(first.written).toBe(true);
    expect(second).toEqual({ written: false, reason: 'duplicate', date: '2026-07-20' });
    expect(lines()).toHaveLength(1);
    // The original row is intact — the re-fire did not overwrite it with 30 rows.
    expect((JSON.parse(lines()[0]!) as LearnedWeightsSnapshot).ledger.rows).toBe(12);
  });
});

describe('AC3 — an empty fold is not written at all', () => {
  it('skips the write when generatedFrom.rows === 0', async () => {
    const res = await recordDailyLearnedWeightsSnapshot({
      readLedger: async () => [],
      now: D1_TICK,
      env: { [LEARNED_WEIGHTS_SNAPSHOT_FLAG]: '1' },
    });

    expect(res).toEqual({ written: false, reason: 'empty_ledger', date: '2026-07-20' });
    expect(existsSync(file)).toBe(false);
  });
});

describe('AC4 — flag OFF is provably zero-IO', () => {
  it('creates no file AND never reads the ledger', async () => {
    let reads = 0;
    const throwingReader = async (): Promise<ReversalShadowRecord[]> => {
      reads += 1;
      throw new Error('ledger must not be read while the flag is off');
    };

    const res = await recordDailyLearnedWeightsSnapshot({
      readLedger: throwingReader,
      now: D1_TICK,
      env: {},
    });

    expect(res).toEqual({ written: false, reason: 'flag_off' });
    expect(reads).toBe(0);
    expect(existsSync(file)).toBe(false);
  });
});

describe('AC5 — NO BACK-FILL: a missed day stays absent', () => {
  it('append D1, skip D2, append D3 -> exactly D1 and D3, and D3 is not stamped as D2', async () => {
    const env = { [LEARNED_WEIGHTS_SNAPSHOT_FLAG]: '1' };
    await recordDailyLearnedWeightsSnapshot({ readLedger: async () => ledger(12), now: D1_TICK, env });
    // D2: the tick never runs (process down / flag off for a day).
    await recordDailyLearnedWeightsSnapshot({
      readLedger: async () => ledger(20),
      now: D1_TICK + 2 * DAY_MS,
      env,
    });

    const stored = await listLearnedWeightsSnapshots();
    expect(stored.map((r) => r.date)).toEqual(['2026-07-20', '2026-07-22']);
    // The gap is a GAP: nothing reconstructed 07-21, and the D3 row carries D3's
    // own fold (20 rows) stamped under D3's own date.
    expect(stored.map((r) => r.ledger.rows)).toEqual([12, 20]);
    expect(stored.find((r) => r.date === '2026-07-21')).toBeUndefined();
  });
});

describe('AC6 — retention trims to the newest 400 rows', () => {
  it('keeps MAX_SNAPSHOT_ROWS newest rows and drops the oldest', async () => {
    // Seed the file directly so the test stays fast: 400 rows already at the cap.
    const seeded = Array.from({ length: MAX_SNAPSHOT_ROWS }, (_, i) =>
      snapshotFrom(ledger(), etDay(D1_TICK + i * DAY_MS)),
    );
    writeFileSync(file, seeded.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf-8');
    setLearnedWeightsHistoryFileForTests(file); // reset the cache onto the seed
    await initLearnedWeightsHistory();

    const oldest = seeded[0]!.date;
    const overflow = etDay(D1_TICK + MAX_SNAPSHOT_ROWS * DAY_MS);
    expect(await appendLearnedWeightsSnapshot(snapshotFrom(ledger(), overflow))).toBe(true);

    const stored = await listLearnedWeightsSnapshots();
    expect(stored).toHaveLength(MAX_SNAPSHOT_ROWS);
    expect(stored.at(-1)!.date).toBe(overflow);
    expect(stored.some((r) => r.date === oldest)).toBe(false);
    // The trim rewrote the file, so the on-disk line count matches too.
    expect(lines()).toHaveLength(MAX_SNAPSHOT_ROWS);
  });
});

describe('AC7 — a corrupt/truncated trailing line is skipped, not thrown', () => {
  it('loads the good rows and ignores the garbage', async () => {
    const good = snapshotFrom(ledger(), '2026-07-20');
    writeFileSync(file, `${JSON.stringify(good)}\n`, 'utf-8');
    // A truncated write (process killed mid-append) plus a well-formed line whose
    // date key is garbage — both must be tolerated.
    appendFileSync(file, `${JSON.stringify(good).slice(0, 40)}\n`, 'utf-8');
    appendFileSync(file, `${JSON.stringify({ ...good, date: 'not-a-date' })}\n`, 'utf-8');
    setLearnedWeightsHistoryFileForTests(file);

    const stored = await listLearnedWeightsSnapshots();
    expect(stored.map((r) => r.date)).toEqual(['2026-07-20']);
  });
});

describe('AC8 — read path: date window + single-bucket trajectory', () => {
  beforeEach(async () => {
    // Three days; SPY present on all three, TSLA only on the middle day.
    const days: Array<[string, ReversalShadowRecord[]]> = [
      ['2026-07-20', ledger(12)],
      ['2026-07-21', [...ledger(12), ...ledger(12, { symbol: 'TSLA' }).map((r, i) => ({ ...r, id: `TSLA:long:${i}`, symbol: 'TSLA' }))]],
      ['2026-07-22', ledger(12)],
    ];
    for (const [date, rows] of days) {
      await appendLearnedWeightsSnapshot(snapshotFrom(rows, date));
    }
  });

  it('filters inclusively by from/to date', async () => {
    expect((await listLearnedWeightsSnapshots()).map((r) => r.date)).toEqual([
      '2026-07-20', '2026-07-21', '2026-07-22',
    ]);
    expect(
      (await listLearnedWeightsSnapshots({ from: '2026-07-21' })).map((r) => r.date),
    ).toEqual(['2026-07-21', '2026-07-22']);
    expect(
      (await listLearnedWeightsSnapshots({ to: '2026-07-21' })).map((r) => r.date),
    ).toEqual(['2026-07-20', '2026-07-21']);
    expect(
      (await listLearnedWeightsSnapshots({ from: '2026-07-21', to: '2026-07-21' })).map((r) => r.date),
    ).toEqual(['2026-07-21']);
  });

  it('returns the trajectory shape for a bucket present on every day', async () => {
    const series = learnedWeightsTrajectory(await listLearnedWeightsSnapshots(), 'symbol', 'SPY');
    expect(series.map((p) => p.date)).toEqual(['2026-07-20', '2026-07-21', '2026-07-22']);
    expect(Object.keys(series[0]!).sort()).toEqual([
      'avgR', 'confident', 'date', 'hitRate', 'multiplierHardGate', 'multiplierShrunk', 'resolved',
    ].sort());
    expect(series[0]!.confident).toBe(true);
  });

  it('OMITS dates where the bucket does not exist — never zero-fills', async () => {
    const series = learnedWeightsTrajectory(await listLearnedWeightsSnapshots(), 'symbol', 'TSLA');
    expect(series.map((p) => p.date)).toEqual(['2026-07-21']);
    expect(learnedWeightsTrajectory(await listLearnedWeightsSnapshots(), 'symbol', 'NOPE')).toEqual([]);
  });

  it('resolves the score and pattern dimensions too', async () => {
    const rows = await listLearnedWeightsSnapshots();
    expect(learnedWeightsTrajectory(rows, 'score', '4')).toHaveLength(3);
    expect(learnedWeightsTrajectory(rows, 'pattern', 'hammer')).toHaveLength(3);
  });
});

describe('AC9 — shrinkageFlagEnabled is stamped per row and round-trips', () => {
  it('persists the A/B switch state that was live that day', async () => {
    await appendLearnedWeightsSnapshot(
      snapshotFrom(ledger(), '2026-07-20', { shrinkageFlagEnabled: false }),
    );
    await appendLearnedWeightsSnapshot(
      snapshotFrom(ledger(), '2026-07-21', { shrinkageFlagEnabled: true }),
    );
    setLearnedWeightsHistoryFileForTests(file); // drop the cache, re-read from disk

    const stored = await listLearnedWeightsSnapshots();
    expect(stored.map((r) => r.shrinkageFlagEnabled)).toEqual([false, true]);
  });

  it('reads the live shrinkage flag on the tick', async () => {
    await recordDailyLearnedWeightsSnapshot({
      readLedger: async () => ledger(),
      now: D1_TICK,
      env: { [LEARNED_WEIGHTS_SNAPSHOT_FLAG]: '1', ENABLE_LEARNED_WEIGHT_SHRINKAGE: 'true' },
    });
    expect((await listLearnedWeightsSnapshots())[0]!.shrinkageFlagEnabled).toBe(true);
  });
});

describe('AC10 (sizing amendment) — bySymbol is trimmed to the watchlist', () => {
  it('keeps only watchlist symbols, stamps bySymbolOmitted, and stays under 32 KB', () => {
    // Reproduce the prod shape measured 2026-07-25: 621 symbol buckets, of which
    // only the watchlist names may persist.
    const watchlist = ['SPY', 'QQQ', 'AAPL'];
    const rows: ReversalShadowRecord[] = [];
    const symbols = [
      ...watchlist,
      ...Array.from({ length: 618 }, (_, i) => `SYN${i}`),
    ];
    for (const symbol of symbols) {
      for (let i = 0; i < 12; i += 1) {
        rows.push(row({ id: `${symbol}:long:${i}`, ts: i + 1, symbol }));
      }
    }

    const fold = computeLearnedWeights(rows);
    expect(fold.bySymbol).toHaveLength(621);

    const snap = buildLearnedWeightsSnapshot(fold, {
      date: '2026-07-25',
      generatedAt: D1_TICK,
      shrinkageFlagEnabled: false,
      watchlist,
    });

    expect(snap.bySymbol.map((s) => s.key).sort()).toEqual([...watchlist].sort());
    expect(snap.bySymbolOmitted).toBe(618);
    // byScore/byPattern persist in FULL — only the symbol dimension is trimmed.
    expect(snap.byScore).toHaveLength(fold.byScore.length);
    expect(snap.byPattern).toHaveLength(fold.byPattern.length);

    const bytes = Buffer.byteLength(JSON.stringify(snap), 'utf-8');
    expect(bytes).toBeLessThan(32 * 1024);
  });

  it('defaults to the real WATCHLIST when none is injected', () => {
    const rows = [
      ...ledger(12),
      ...Array.from({ length: 12 }, (_, i) => row({ id: `ZZZZ:long:${i}`, ts: i + 1, symbol: 'ZZZZ' })),
    ];
    const snap = snapshotFrom(rows, '2026-07-20');
    expect(snap.bySymbol.map((s) => s.key)).toEqual(['SPY']); // SPY is on the watchlist
    expect(snap.bySymbolOmitted).toBe(1); // ZZZZ is not
  });
});

describe('storage location', () => {
  it('writes to <DATA_DIR>/learned-weights-history.jsonl by default', () => {
    setLearnedWeightsHistoryFileForTests(null);
    const prev = process.env['DATA_DIR'];
    process.env['DATA_DIR'] = dir;
    try {
      expect(learnedWeightsHistoryFile()).toBe(join(dir, 'learned-weights-history.jsonl'));
    } finally {
      if (prev === undefined) delete process.env['DATA_DIR'];
      else process.env['DATA_DIR'] = prev;
      setLearnedWeightsHistoryFileForTests(file);
    }
  });
});
