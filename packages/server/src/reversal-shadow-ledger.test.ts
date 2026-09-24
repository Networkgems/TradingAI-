import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, readFileSync, writeFileSync } from 'fs';
import type { Candle } from '@trading-app/shared';
import type { ReversalChecklist } from '@trading-app/engine';
import {
  setReversalShadowLedgerFileForTests,
  initReversalShadowLedger,
  recordReversalShadowSignal,
  resolveReversalShadowSignal,
  listReversalShadowSignals,
  openReversalShadowSignalsSync,
  buildReversalShadowOpen,
  resolveReversalOutcome,
  reversalHitRateByScore,
  isReversalShadowEnabled,
  reversalShadowCompaction,
  REVERSAL_SHADOW_RETENTION_DAYS,
  type ReversalShadowOpen,
  type ReversalShadowRecord,
} from './reversal-shadow-ledger.js';

const DAY = Date.UTC(2026, 5, 10); // 2026-06-10
const MIN = 60_000;

function bar(tsOffsetMin: number, o: number, h: number, l: number, c: number): Candle {
  return { symbol: 'AAPL', timestamp: DAY + tsOffsetMin * MIN, open: o, high: h, low: l, close: c, volume: 0 };
}

function openRec(over: Partial<ReversalShadowOpen> = {}): ReversalShadowOpen {
  return {
    id: 'AAPL:long:1',
    ts: DAY + 5 * MIN,
    symbol: 'AAPL',
    side: 'long',
    atKeyLevel: true,
    trendBreak: true,
    unhealthyMove: true,
    pattern: true,
    patternName: 'hammer',
    score: 4,
    zoneTouches: 3,
    entry: 100,
    stop: 98,
    target: 104,
    ...over,
  };
}

function asRecord(open: ReversalShadowOpen): ReversalShadowRecord {
  return { ...open, outcome: 'OPEN' };
}

describe('reversal-shadow-ledger — durable append-only store', () => {
  let file: string;
  let n = 0;

  beforeEach(() => {
    n += 1;
    file = join(tmpdir(), `reversal-ledger-test-${process.pid}-${n}.jsonl`);
    try { rmSync(file); } catch { /* fresh */ }
    setReversalShadowLedgerFileForTests(file);
  });
  afterEach(() => {
    setReversalShadowLedgerFileForTests(null);
    try { rmSync(file); } catch { /* ignore */ }
  });

  it('is OFF by default and reads the flag from the env', () => {
    expect(isReversalShadowEnabled({})).toBe(false);
    expect(isReversalShadowEnabled({ ENABLE_REVERSAL_SHADOW: 'true' })).toBe(true);
    expect(isReversalShadowEnabled({ ENABLE_REVERSAL_SHADOW: 'on' })).toBe(true);
    expect(isReversalShadowEnabled({ ENABLE_REVERSAL_SHADOW: 'off' })).toBe(false);
  });

  it('appends OPEN rows and dedupes by id (one row per bar per symbol/side)', async () => {
    await initReversalShadowLedger();
    expect(await recordReversalShadowSignal(openRec())).toBe(true);
    // Same id (same bar) is a no-op — a per-tick re-fire can't inflate the sample.
    expect(await recordReversalShadowSignal(openRec())).toBe(false);
    const rows = await listReversalShadowSignals();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('OPEN');
    expect(rows[0].score).toBe(4);
    expect(rows[0].zoneTouches).toBe(3);
    expect(openReversalShadowSignalsSync()).toHaveLength(1);
  });

  it('folds a RESOLVED line over the OPEN line on read (append-only)', async () => {
    await initReversalShadowLedger();
    await recordReversalShadowSignal(openRec());
    await resolveReversalShadowSignal(
      'AAPL:long:1',
      { outcome: 'TP_HIT', realizedR: 2, barsToResolution: 3 },
      DAY + 30 * MIN,
    );
    const rows = await listReversalShadowSignals();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('TP_HIT');
    expect(rows[0].realizedR).toBe(2);
    expect(openReversalShadowSignalsSync()).toHaveLength(0);
  });

  it('survives a reload from disk (rebuilds the folded view)', async () => {
    await initReversalShadowLedger();
    await recordReversalShadowSignal(openRec());
    await resolveReversalShadowSignal(
      'AAPL:long:1',
      { outcome: 'SL_HIT', realizedR: -1, barsToResolution: 1 },
      DAY + 10 * MIN,
    );
    setReversalShadowLedgerFileForTests(file); // drop cache, re-init from same file
    // TRA-4883 — the reload now applies the retention cutoff, so it needs a `now` that
    // the fixture day is INSIDE. Left at the wall clock this assertion would decay from
    // passing to failing as `DAY` ages past the horizon, with nothing having changed.
    await initReversalShadowLedger(DAY + 60 * MIN);
    const rows = await listReversalShadowSignals();
    expect(rows[0].outcome).toBe('SL_HIT');
  });
});

describe('reversal-shadow-ledger — buildReversalShadowOpen', () => {
  const baseChecklist: ReversalChecklist = {
    side: 'long',
    zone: { kind: 'support', level: 98, lower: 97.5, upper: 98.5, touches: 4, lastTouchIndex: 12 },
    atKeyLevel: true,
    trendBreak: true,
    unhealthyMove: false,
    pattern: 'hammer',
    score: 3,
    confirmed: false,
    // TRA-922 added this required field to ReversalChecklist; null = no
    // timing-window context supplied (matches the indicator's default).
    inTimingWindow: null,
    entry: 100,
    stop: 97,
    target: 106,
    riskReward: 2,
  };

  it('maps a bracketed setup into a ledger-open row (legs, score, zone touches)', () => {
    const open = buildReversalShadowOpen('AAPL', baseChecklist, DAY + 5 * MIN);
    expect(open).not.toBeNull();
    expect(open!.id).toBe(`AAPL:long:${DAY + 5 * MIN}`);
    expect(open!.side).toBe('long');
    expect(open!.score).toBe(3);
    expect(open!.atKeyLevel).toBe(true);
    expect(open!.unhealthyMove).toBe(false);
    expect(open!.pattern).toBe(true);
    expect(open!.patternName).toBe('hammer');
    expect(open!.zoneTouches).toBe(4);
    expect(open!.entry).toBe(100);
    expect(open!.stop).toBe(97);
    expect(open!.target).toBe(106);
  });

  it('returns null when there is no bracket (no level reacted off)', () => {
    const noSetup: ReversalChecklist = {
      ...baseChecklist, side: null, zone: null, entry: null, stop: null, target: null, score: 0,
    };
    expect(buildReversalShadowOpen('AAPL', noSetup, DAY)).toBeNull();
  });

  it('records pattern=false when no reversal candlestick printed', () => {
    const noPattern = buildReversalShadowOpen('AAPL', { ...baseChecklist, pattern: null, score: 2 }, DAY);
    expect(noPattern!.pattern).toBe(false);
    expect(noPattern!.patternName).toBeNull();
  });
});

describe('reversal-shadow-ledger — resolveReversalOutcome (shared horizon rule)', () => {
  it('labels a long TP_HIT with reward-to-risk R when a bar trades through target', () => {
    const rec = asRecord(openRec()); // entry 100, stop 98 (risk 2), target 104 (reward 4)
    const bars = [bar(5, 100, 100, 100, 100), bar(10, 100, 101, 99, 100), bar(15, 101, 104.5, 100, 104)];
    const res = resolveReversalOutcome(rec, bars);
    expect(res?.outcome).toBe('TP_HIT');
    expect(res?.realizedR).toBeCloseTo(2, 5);
  });

  it('labels a short TP_HIT below entry (long->buy / short->sell mapping)', () => {
    const rec = asRecord(openRec({ side: 'short', entry: 100, stop: 102, target: 96 }));
    const bars = [bar(10, 100, 100, 95.5, 96)];
    const res = resolveReversalOutcome(rec, bars);
    expect(res?.outcome).toBe('TP_HIT');
    expect(res?.realizedR).toBeCloseTo(2, 5);
  });

  it('labels SL_HIT at exactly -1R', () => {
    const rec = asRecord(openRec());
    const bars = [bar(10, 100, 100.5, 97.5, 98)];
    const res = resolveReversalOutcome(rec, bars);
    expect(res?.outcome).toBe('SL_HIT');
    expect(res?.realizedR).toBe(-1);
  });
});

describe('reversal-shadow-ledger — reversalHitRateByScore breakdown', () => {
  it('buckets hit-rate and avg R by checklist score over RESOLVED rows', () => {
    const rows: ReversalShadowRecord[] = [
      { ...asRecord(openRec({ id: 'a', score: 4 })), outcome: 'TP_HIT', realizedR: 2 },
      { ...asRecord(openRec({ id: 'b', score: 4 })), outcome: 'SL_HIT', realizedR: -1 },
      { ...asRecord(openRec({ id: 'c', score: 4 })), outcome: 'OPEN' }, // not counted in resolved
      { ...asRecord(openRec({ id: 'd', score: 3 })), outcome: 'SL_HIT', realizedR: -1 },
    ];
    const buckets = reversalHitRateByScore(rows);
    const four = buckets.find((b) => b.score === 4)!;
    expect(four.total).toBe(3);
    expect(four.resolved).toBe(2);
    expect(four.tpHit).toBe(1);
    expect(four.hitRate).toBeCloseTo(0.5, 5); // 1 TP / 2 resolved
    expect(four.avgR).toBeCloseTo(0.5, 5); // (2 + -1) / 2

    const three = buckets.find((b) => b.score === 3)!;
    expect(three.hitRate).toBe(0); // 0 TP / 1 resolved
    // ascending by score
    expect(buckets.map((b) => b.score)).toEqual([3, 4]);
  });

  it('reports null hitRate/avgR for a score with no resolved rows', () => {
    const rows = [asRecord(openRec({ id: 'x', score: 2 }))];
    const bucket = reversalHitRateByScore(rows)[0];
    expect(bucket.resolved).toBe(0);
    expect(bucket.hitRate).toBeNull();
    expect(bucket.avgR).toBeNull();
  });

});

// ── TRA-4883 — retention + boot compaction ──────────────────────────────────
describe('reversal-shadow-ledger — retention + boot compaction (TRA-4883)', () => {
  let file: string;
  let n = 0;

  beforeEach(() => {
    n += 1;
    file = join(tmpdir(), `reversal-retention-test-${process.pid}-${n}.jsonl`);
    try { rmSync(file); } catch { /* fresh */ }
    setReversalShadowLedgerFileForTests(file);
  });
  afterEach(() => {
    setReversalShadowLedgerFileForTests(null);
    try { rmSync(file); } catch { /* ignore */ }
  });

  {
    const DAY_MS = 24 * 60 * 60 * 1000;
    /** A fixed "now" all the cases below age against. */
    const NOW = Date.UTC(2026, 8, 24, 21, 0, 0);
    const openLine = (rec: ReversalShadowOpen) => JSON.stringify({ kind: 'open', rec });
    const resolveLine = (id: string, outcome: string, resolvedAt: number) =>
      JSON.stringify({
        kind: 'resolve',
        id,
        res: { outcome, realizedR: 2, barsToResolution: 3 },
        resolvedAt,
      });

    it('publishes a 30-day horizon matching the bounded siblings', () => {
      expect(REVERSAL_SHADOW_RETENTION_DAYS).toBe(30);
    });

    it('drops rows older than the horizon from the fold AND from disk, keeping the rest verbatim', async () => {
      const oldRec = openRec({ id: 'OLD:long:1', ts: NOW - 31 * DAY_MS });
      const freshRec = openRec({ id: 'FRESH:long:1', ts: NOW - 2 * DAY_MS });
      writeFileSync(
        file,
        [
          openLine(oldRec),
          resolveLine(oldRec.id, 'TP_HIT', NOW - 31 * DAY_MS + 60_000),
          openLine(freshRec),
          resolveLine(freshRec.id, 'SL_HIT', NOW - 2 * DAY_MS + 60_000),
        ].join('\n') + '\n',
        'utf-8',
      );

      await initReversalShadowLedger(NOW);

      const rows = await listReversalShadowSignals();
      expect(rows.map((r) => r.id)).toEqual(['FRESH:long:1']);
      // The aged row's RESOLVE line goes with its OPEN — never orphaned, and never
      // aged on `resolvedAt` (which a resolve line is the only carrier of).
      const onDisk = readFileSync(file, 'utf-8').trim().split('\n');
      expect(onDisk).toHaveLength(2);
      expect(onDisk[0]).toBe(openLine(freshRec));
      expect(onDisk[1]).toBe(resolveLine(freshRec.id, 'SL_HIT', NOW - 2 * DAY_MS + 60_000));

      const c = reversalShadowCompaction()!;
      expect(c.rewrote).toBe(true);
      expect(c.linesBefore).toBe(4);
      expect(c.linesAfter).toBe(2);
      expect(c.recordsDropped).toBe(1);
      expect(c.recordsAfter).toBe(1);
      expect(c.bytesAfter).toBeLessThan(c.bytesBefore);
      expect(c.cutoff).toBe(new Date(NOW - 30 * DAY_MS).toISOString());
    });

    it('preserves unknown fields on a retained line (the rewrite echoes bytes, it does not re-serialize)', async () => {
      // TRA-1703/TRA-2355 one ledger over: a sanitizing rewrite ERASES FROM DISK any
      // field it does not know about. A field a future version adds must survive a
      // compaction that predates it.
      const fresh = openRec({ id: 'FRESH:long:1', ts: NOW - 1 * DAY_MS });
      const line = JSON.stringify({ kind: 'open', rec: { ...fresh, futureField: 'keep-me' } });
      writeFileSync(
        file,
        [openLine(openRec({ id: 'OLD:long:1', ts: NOW - 40 * DAY_MS })), line].join('\n') + '\n',
        'utf-8',
      );

      await initReversalShadowLedger(NOW);

      expect(readFileSync(file, 'utf-8').trim()).toBe(line);
      expect(readFileSync(file, 'utf-8')).toContain('keep-me');
    });

    it('does NOT rewrite when nothing aged out', async () => {
      const fresh = openRec({ id: 'FRESH:long:1', ts: NOW - 3 * DAY_MS });
      const body = openLine(fresh) + '\n';
      writeFileSync(file, body, 'utf-8');

      await initReversalShadowLedger(NOW);

      const c = reversalShadowCompaction()!;
      expect(c.rewrote).toBe(false);
      expect(c.recordsDropped).toBe(0);
      expect(c.linesBefore).toBe(1);
      expect(c.linesAfter).toBe(1);
      expect(c.bytesAfter).toBe(c.bytesBefore);
      expect(readFileSync(file, 'utf-8')).toBe(body);
    });

    it('drops a stale OPEN row too — the forward horizon is intra-session, so it can never resolve', async () => {
      writeFileSync(file, openLine(openRec({ id: 'STALE:long:1', ts: NOW - 45 * DAY_MS })) + '\n', 'utf-8');

      await initReversalShadowLedger(NOW);

      expect(openReversalShadowSignalsSync()).toHaveLength(0);
      expect(readFileSync(file, 'utf-8')).toBe('');
      expect(reversalShadowCompaction()!.recordsDropped).toBe(1);
    });

    it('a corrupt line is skipped by the fold and dropped by the rewrite, without losing its neighbours', async () => {
      const fresh = openRec({ id: 'FRESH:long:1', ts: NOW - 1 * DAY_MS });
      writeFileSync(file, ['{not json', openLine(fresh)].join('\n') + '\n', 'utf-8');

      await initReversalShadowLedger(NOW);

      expect((await listReversalShadowSignals()).map((r) => r.id)).toEqual(['FRESH:long:1']);
      expect(readFileSync(file, 'utf-8').trim()).toBe(openLine(fresh));
    });

    it('reports a compaction summary even on an empty/absent ledger', async () => {
      await initReversalShadowLedger(NOW);
      const c = reversalShadowCompaction()!;
      expect(c.rewrote).toBe(false);
      expect(c.linesBefore).toBe(0);
      expect(c.recordsAfter).toBe(0);
      expect(c.ranAt).toBe(new Date(NOW).toISOString());
    });
  }
});
