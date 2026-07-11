import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import {
  recordMakerFill,
  listMakerFillEvents,
  summarizeMakerFills,
  setOptionMakerFillFileForTests,
  isOptionMakerTelemetryEnabled,
  type MakerFillEvent,
} from './option-maker-fill-ledger.js';

// TRA-1601 — the maker-fill telemetry ledger. Flag-gated capture + the pure
// per-side fill-rate / realised-vs-mid / time-to-fill fold.

let dir: string;
const FLAG = 'ENABLE_OPTION_MAKER_TELEMETRY';
const prev = process.env[FLAG];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'maker-fills-'));
  setOptionMakerFillFileForTests(join(dir, 'ledger.jsonl'));
  process.env[FLAG] = '1';
});

afterEach(() => {
  setOptionMakerFillFileForTests(null);
  if (prev === undefined) delete process.env[FLAG];
  else process.env[FLAG] = prev;
  rmSync(dir, { recursive: true, force: true });
});

function ev(over: Partial<MakerFillEvent>): MakerFillEvent {
  return { ts: 1, side: 'open', mode: 'live', symbol: 'X', result: 'filled', ...over };
}

describe('recordMakerFill flag gating', () => {
  it('no-ops when the flag is off', async () => {
    process.env[FLAG] = '0';
    expect(isOptionMakerTelemetryEnabled()).toBe(false);
    expect(await recordMakerFill(ev({}))).toBe(false);
    expect(await listMakerFillEvents()).toHaveLength(0);
  });

  it('persists and reloads events when the flag is on', async () => {
    expect(await recordMakerFill(ev({ walk: 2, realizedVsMidUsd: 5, timeToFillMs: 1200 }))).toBe(true);
    // Force a reload from disk by pointing the store at the same file again.
    setOptionMakerFillFileForTests(join(dir, 'ledger.jsonl'));
    const events = await listMakerFillEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ side: 'open', walk: 2, realizedVsMidUsd: 5, timeToFillMs: 1200 });
  });

  it('drops non-finite metric fields on write', async () => {
    await recordMakerFill(ev({ realizedVsMidUsd: Number.NaN, timeToFillMs: Infinity, walk: 0 }));
    const [e] = await listMakerFillEvents();
    expect(e.realizedVsMidUsd).toBeUndefined();
    expect(e.timeToFillMs).toBeUndefined();
    expect(e.walk).toBe(0);
  });
});

describe('summarizeMakerFills', () => {
  it('computes fill-rate, avg realised-vs-mid, time-to-fill, walk step per side', () => {
    const events: MakerFillEvent[] = [
      ev({ side: 'open', result: 'filled', walk: 0, realizedVsMidUsd: 2, timeToFillMs: 1000 }),
      ev({ side: 'open', result: 'filled', walk: 2, realizedVsMidUsd: 4, timeToFillMs: 3000 }),
      ev({ side: 'open', result: 'walk_exhausted' }),
      ev({ side: 'close', result: 'filled', realizedVsMidUsd: 6 }),
      ev({ side: 'close', result: 'rejected' }),
    ];
    const s = summarizeMakerFills(events, true);
    expect(s.total).toBe(5);
    // open: 3 chases, 2 fills
    expect(s.open.chases).toBe(3);
    expect(s.open.fills).toBe(2);
    expect(s.open.fillRate).toBeCloseTo(2 / 3, 5);
    expect(s.open.avgRealizedVsMidUsd).toBeCloseTo(3, 5);
    expect(s.open.avgTimeToFillMs).toBeCloseTo(2000, 5);
    expect(s.open.avgWalkStep).toBeCloseTo(1, 5);
    // close: 2 chases, 1 fill (no time / walk captured on close events)
    expect(s.close.chases).toBe(2);
    expect(s.close.fills).toBe(1);
    expect(s.close.fillRate).toBeCloseTo(0.5, 5);
    expect(s.close.avgRealizedVsMidUsd).toBeCloseTo(6, 5);
    expect(s.close.avgTimeToFillMs).toBeNull();
    expect(s.close.avgWalkStep).toBeNull();
  });

  it('empty ledger folds to honest zeros / nulls', () => {
    const s = summarizeMakerFills([], false);
    expect(s.enabled).toBe(false);
    expect(s.open.fillRate).toBe(0);
    expect(s.open.avgRealizedVsMidUsd).toBeNull();
  });
});

describe('listMakerFillEvents filtering', () => {
  it('filters by mode, side, and sinceTs', async () => {
    await recordMakerFill(ev({ ts: 10, mode: 'demo', side: 'open' }));
    await recordMakerFill(ev({ ts: 20, mode: 'live', side: 'open' }));
    await recordMakerFill(ev({ ts: 30, mode: 'live', side: 'close' }));
    expect(await listMakerFillEvents({ mode: 'live' })).toHaveLength(2);
    expect(await listMakerFillEvents({ side: 'close' })).toHaveLength(1);
    expect(await listMakerFillEvents({ sinceTs: 20 })).toHaveLength(2);
    expect(await listMakerFillEvents({ mode: 'live', side: 'open', sinceTs: 15 })).toHaveLength(1);
  });
});
