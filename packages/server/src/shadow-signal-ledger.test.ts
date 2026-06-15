import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import type { Candle } from '@trading-app/shared';
import {
  setShadowLedgerFileForTests,
  initShadowLedger,
  recordShadowSignal,
  resolveShadowSignal,
  listShadowSignals,
  openShadowSignalsSync,
  resolveOutcome,
  type ShadowSignalRecord,
  type ShadowSignalOpen,
} from './shadow-signal-ledger.js';

// A fixed ET session day; we vary intra-day timestamps off this anchor. The
// ledger's session key is the ET calendar date, so all bars on the same UTC day
// (well inside RTH) share a session.
const DAY = Date.UTC(2026, 5, 10); // 2026-06-10
const MIN = 60_000;

function bar(tsOffsetMin: number, o: number, h: number, l: number, c: number): Candle {
  return { symbol: 'AAPL', timestamp: DAY + tsOffsetMin * MIN, open: o, high: h, low: l, close: c, volume: 0 };
}

function openRec(over: Partial<ShadowSignalOpen> = {}): ShadowSignalOpen {
  return {
    id: 'AAPL:buy:1',
    ts: DAY + 5 * MIN,
    symbol: 'AAPL',
    side: 'buy',
    entryRef: 100,
    supertrendValue: 98,
    supertrendFlip: true,
    maStack: true,
    macd: true,
    rsi: true,
    emitted: true,
    stopLoss: 98,
    takeProfit: 104,
    ...over,
  };
}

function asRecord(open: ShadowSignalOpen): ShadowSignalRecord {
  return { ...open, outcome: 'OPEN' };
}

describe('shadow-signal-ledger — durable append-only store', () => {
  let file: string;
  let n = 0;

  beforeEach(() => {
    n += 1;
    file = join(tmpdir(), `shadow-ledger-test-${process.pid}-${n}.jsonl`);
    try { rmSync(file); } catch { /* fresh */ }
    setShadowLedgerFileForTests(file);
  });
  afterEach(() => {
    setShadowLedgerFileForTests(null);
    try { rmSync(file); } catch { /* ignore */ }
  });

  it('appends OPEN rows and dedupes by id', async () => {
    await initShadowLedger();
    expect(await recordShadowSignal(openRec())).toBe(true);
    // Same id (same 5m bar) is a no-op — a per-tick re-fire can't inflate the sample.
    expect(await recordShadowSignal(openRec())).toBe(false);
    const rows = await listShadowSignals();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('OPEN');
    expect(openShadowSignalsSync()).toHaveLength(1);
  });

  it('folds a RESOLVED line over the OPEN line on read (append-only)', async () => {
    await initShadowLedger();
    await recordShadowSignal(openRec());
    await resolveShadowSignal('AAPL:buy:1', { outcome: 'TP_HIT', realizedR: 2, barsToResolution: 3 }, DAY + 30 * MIN);
    const rows = await listShadowSignals();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('TP_HIT');
    expect(rows[0].realizedR).toBe(2);
    expect(rows[0].barsToResolution).toBe(3);
    expect(openShadowSignalsSync()).toHaveLength(0);
    // The file physically carries BOTH lines — nothing was rewritten in place.
    const raw = await readFile(file, 'utf-8');
    expect(raw.trim().split('\n')).toHaveLength(2);
  });

  it('survives a reload from disk (rebuilds the folded view)', async () => {
    await initShadowLedger();
    await recordShadowSignal(openRec());
    await resolveShadowSignal('AAPL:buy:1', { outcome: 'SL_HIT', realizedR: -1, barsToResolution: 1 }, DAY + 10 * MIN);
    // Drop the in-memory cache and re-init from the same file.
    setShadowLedgerFileForTests(file);
    await initShadowLedger();
    const rows = await listShadowSignals();
    expect(rows[0].outcome).toBe('SL_HIT');
  });

  it('re-baselines (archives) a contaminated pre-TRA-840 ledger on init', async () => {
    // A pre-fix row lacks the `emitted` field; write one directly to disk.
    const legacy = {
      kind: 'open',
      rec: {
        id: 'old:buy:1', ts: DAY, symbol: 'OLD', side: 'buy', entryRef: 10,
        supertrendValue: 9, supertrendFlip: false, maStack: true, macd: true, rsi: true,
        stopLoss: 9, takeProfit: 12,
      },
    };
    await writeFile(file, `${JSON.stringify(legacy)}\n`, 'utf-8');
    setShadowLedgerFileForTests(file); // drop cache so init reloads from disk
    await initShadowLedger();
    // Contaminated rows are archived away — the fresh capture starts empty.
    expect(await listShadowSignals()).toHaveLength(0);
    // A fixed-generator row carrying `emitted` survives a subsequent reload
    // (the re-baseline is idempotent and does not fire again).
    await recordShadowSignal(openRec({ id: 'new:buy:1', emitted: false }));
    setShadowLedgerFileForTests(file);
    await initShadowLedger();
    const rows = await listShadowSignals();
    expect(rows.map((r) => r.id)).toEqual(['new:buy:1']);
    expect(rows[0].emitted).toBe(false);
  });

  it('windows by signal ts with from/to', async () => {
    await initShadowLedger();
    await recordShadowSignal(openRec({ id: 'a', ts: DAY + 1 * MIN }));
    await recordShadowSignal(openRec({ id: 'b', ts: DAY + 100 * MIN }));
    const windowed = await listShadowSignals({ from: DAY + 50 * MIN });
    expect(windowed.map((r) => r.id)).toEqual(['b']);
  });
});

describe('shadow-signal-ledger — resolveOutcome horizon labelling', () => {
  it('labels TP_HIT with the reward-to-risk R when a bar trades through the target', () => {
    const rec = asRecord(openRec()); // entry 100, stop 98 (risk 2), target 104 (reward 4)
    const bars = [bar(5, 100, 100, 100, 100), bar(10, 100, 101, 99, 100), bar(15, 101, 104.5, 100, 104)];
    const res = resolveOutcome(rec, bars);
    expect(res?.outcome).toBe('TP_HIT');
    expect(res?.realizedR).toBeCloseTo(2, 5); // reward 4 / risk 2
    expect(res?.barsToResolution).toBe(2);
  });

  it('labels SL_HIT at exactly -1R', () => {
    const rec = asRecord(openRec());
    const bars = [bar(10, 100, 100.5, 97.5, 98), bar(15, 98, 99, 98, 98)];
    const res = resolveOutcome(rec, bars);
    expect(res?.outcome).toBe('SL_HIT');
    expect(res?.realizedR).toBe(-1);
    expect(res?.barsToResolution).toBe(1);
  });

  it('resolves pessimistically to SL_HIT when one bar straddles both stop and target', () => {
    const rec = asRecord(openRec());
    const bars = [bar(10, 100, 105, 97, 101)]; // touches both 98 and 104
    expect(resolveOutcome(rec, bars)?.outcome).toBe('SL_HIT');
  });

  it('TIMEOUTs at session close with the signed close-based R', () => {
    const rec = asRecord(openRec());
    const sameSession = [bar(10, 100, 101, 99.5, 101), bar(15, 101, 101.5, 100, 101)];
    const nextSession: Candle[] = [
      { symbol: 'AAPL', timestamp: DAY + 24 * 60 * MIN + 10 * MIN, open: 101, high: 102, low: 100, close: 101, volume: 0 },
    ];
    const res = resolveOutcome(rec, [...sameSession, ...nextSession]);
    expect(res?.outcome).toBe('TIMEOUT');
    // last in-session close 101, entry 100, risk 2 -> +0.5R
    expect(res?.realizedR).toBeCloseTo(0.5, 5);
  });

  it('stays OPEN (null) while the session is still live and untouched', () => {
    const rec = asRecord(openRec());
    const bars = [bar(10, 100, 101, 99.5, 100), bar(15, 100, 101, 99.5, 100)];
    expect(resolveOutcome(rec, bars)).toBeNull();
  });

  it('labels a short (sell) TP_HIT below entry', () => {
    const rec = asRecord(openRec({ side: 'sell', entryRef: 100, stopLoss: 102, takeProfit: 96 }));
    const bars = [bar(10, 100, 100, 95.5, 96)]; // trades through 96
    const res = resolveOutcome(rec, bars);
    expect(res?.outcome).toBe('TP_HIT');
    expect(res?.realizedR).toBeCloseTo(2, 5); // reward 4 / risk 2
  });
});
