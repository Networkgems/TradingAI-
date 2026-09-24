/**
 * TRA-4411 (AC6) — the gate-rejection ledger must survive a process restart.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `sma200-capital-gate.test.ts`.
 * That file already has a test named "the rejection ledger and its own debounce
 * survive a snapshot round-trip", and it passed — against
 * `engine.exportTradeSnapshot()` → `engine.importTradeSnapshot()`. That pair is
 * IN-PROCESS. It is not the seam a restart crosses. The seam a restart crosses is
 *
 *     engine.exportTradeSnapshot()
 *       → persistStocksNow()'s hand-written literal      ← dropped the field
 *       → saveStocksTradeSnapshot() → JSON on disk
 *       → loadStocksTradeSnapshot()
 *       → ensureUserContext()'s hand-written restore literal  ← dropped it again
 *       → engine.importTradeSnapshot()
 *
 * and both hand-written literals omitted `sma200GateRejections` while naming its
 * sibling `sma200SignalVoids` on the line above. So the ledger was in-memory-only
 * from the day AC6 shipped, and the green in-process test is precisely what made
 * that invisible: the working half made the broken half look covered. Same shape
 * as TRA-2629 (`cashRepair`, then `optionsCredited`), one level up from the
 * account object that fix consolidated.
 *
 * WHY IT IS WORTH A TEST AND NOT JUST A PATCH. A lost rejection reads back as
 * `[]`, which is bit-identical to "the gate refused nothing" — the failure has no
 * signature on any surface, and it silently deflates AC7's rejected cohort (its
 * slow-accruing denominator) once per redeploy. QuantTrader could not falsify it
 * live for exactly that reason (TRA-4838, 2026-09-24) and asked for this read.
 *
 * Two arms, one per literal. Neither arm can be satisfied by the in-process pair.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Sma200GateRejectionRecord } from '@trading-app/shared';
import type { StocksTradeSnapshot } from './trade-store.js';

// trade-store + user-context capture DATA_DIR at module-evaluation time.
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'tra4411-durability-'));
process.env.DATA_DIR = TMP_ROOT;

/** The object the writer hands to disk, captured by the mock in arm 1. */
const written: { snap: StocksTradeSnapshot | null } = { snap: null };

vi.mock('./trade-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./trade-store.js')>();
  return {
    ...actual,
    // Arm 1 only: capture the literal. Arm 2 calls the REAL pair below, which
    // `actual` still exposes under different local names.
    saveStocksTradeSnapshot: vi.fn(async (username: string, snap: StocksTradeSnapshot) => {
      written.snap = snap;
      await actual.saveStocksTradeSnapshot(username, snap);
    }),
  };
});

let persistStocksNow: typeof import('./user-context.js')['persistStocksNow'];
let ensureUserContext: typeof import('./user-context.js')['ensureUserContext'];
let destroyUserContext: typeof import('./user-context.js')['destroyUserContext'];
let loadStocksTradeSnapshot: typeof import('./trade-store.js')['loadStocksTradeSnapshot'];

const USER = 'alice';

/** One rejection, the shape `runSma200Scan` appends under a finite cap. */
function rejection(over: Partial<Sma200GateRejectionRecord> = {}): Sma200GateRejectionRecord {
  return {
    symbol: 'TER',
    kind: 'sma200_pullback',
    barTimestamp: Date.parse('2026-09-21T13:30:00.000Z'),
    entryPrice: 141.20,
    stopLoss: 96.44,
    distAtr: 4.31,
    atr14: 10.39,
    maxDistAtr: 3,
    recordedAt: Date.parse('2026-09-24T02:21:25.273Z'),
    ...over,
  };
}

/**
 * The minimum of `UserContext` that `persistStocksNow` reads. Cast rather than
 * built: arm 1 is about the literal, not about engine construction. The engine's
 * own export is already covered in `sma200-capital-gate.test.ts`, so stubbing it
 * here is the point — it isolates "does what the engine exported reach disk".
 */
function ctxFor(username: string, rejections: Sma200GateRejectionRecord[]) {
  const snap = {
    account: {
      cash: 100_000, equity: 100_000, initialEquity: 100_000,
      openingEquityToday: 100_000, dailyPnl: 0, openPositions: [],
      cashRepair: null, optionsCredited: 0,
    },
    closedPositions: [],
    recentSignals: [],
    sma200SignalVoids: [],
    sma200GateRejections: rejections,
    dailySignals: [],
    positionSignalType: [],
    options: undefined,
    optionsByEnv: undefined,
    supertrendPaper: undefined,
    supertrendPaperClosed: undefined,
    lastArchivedAt: null,
  };
  return { username, engine: { exportTradeSnapshot: () => snap } } as unknown as
    Parameters<typeof persistStocksNow>[0];
}

beforeAll(async () => {
  writeFileSync(
    join(TMP_ROOT, 'users.json'),
    JSON.stringify([{
      username: USER, email: '', passwordHash: 'x', role: 'user',
      createdAt: '2026-05-02T00:00:00.000Z',
    }]),
    'utf-8',
  );
  const users = await import('./users.js');
  await users.loadUsers();
  const tradeStore = await import('./trade-store.js');
  loadStocksTradeSnapshot = tradeStore.loadStocksTradeSnapshot;
  const userCtx = await import('./user-context.js');
  persistStocksNow = userCtx.persistStocksNow;
  ensureUserContext = userCtx.ensureUserContext;
  destroyUserContext = userCtx.destroyUserContext;
});

beforeEach(() => {
  written.snap = null;
  rmSync(join(TMP_ROOT, 'users', USER), { recursive: true, force: true });
  mkdirSync(join(TMP_ROOT, 'users', USER), { recursive: true });
});

afterEach(() => {
  destroyUserContext(USER);
});

describe('TRA-4411 AC6 — the rejection ledger crosses the DISK seam', () => {
  it('arm 1 — persistStocksNow writes `sma200GateRejections` into the persisted snapshot', async () => {
    const rej = rejection();
    await persistStocksNow(ctxFor(USER, [rej]));

    // The literal. Before the fix this was `undefined` while the line above it
    // carried `sma200SignalVoids`, and nothing anywhere went red.
    expect(written.snap?.sma200GateRejections).toEqual([rej]);

    // And it reached the real file, not just the captured argument — a JSON
    // round-trip is where a non-serialisable field would be lost instead.
    const onDisk = await loadStocksTradeSnapshot(USER);
    expect(onDisk?.sma200GateRejections).toEqual([rej]);
  });

  it('arm 2 — a booted user context restores the ledger AND its own debounce from disk', async () => {
    const rej = rejection();
    await persistStocksNow(ctxFor(USER, [rej]));

    // The real boot restore: `ensureUserContext` → `loadStocksTradeSnapshot` →
    // the restore literal → `importTradeSnapshot`. This is the arm the
    // in-process pair cannot reach, and the arm the restore literal broke.
    const ctx = await ensureUserContext(USER);
    const restored = ctx.engine.getState().sma200GateRejections ?? [];
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ symbol: 'TER', distAtr: 4.31, maxDistAtr: 3 });

    // `importTradeSnapshot` rebuilds the rejections' OWN debounce map off this
    // list. Dropping the field did not only lose evidence: it re-opened the
    // 5-bar window, so a name refused on bar t could be refused again and
    // double-count itself in whatever cohort did survive.
    const lastRejected = (ctx.engine as unknown as {
      sma200LastRejected: Map<string, number>;
    }).sma200LastRejected;
    expect(lastRejected.get('TER:sma200_pullback')).toBe(rej.barTimestamp);
  });

  it('arm 3 — a pre-TRA-4411 snapshot with no such key restores to `[]`, never undefined', async () => {
    // Back-compat: the field is optional on `StocksTradeSnapshot` because every
    // snapshot written before this fix lacks it. The restore must coerce, not
    // propagate `undefined` into the ledger the census and /api/state read.
    await persistStocksNow(ctxFor(USER, []));
    const onDisk = await loadStocksTradeSnapshot(USER);
    delete (onDisk as Partial<StocksTradeSnapshot>).sma200GateRejections;
    const tradeStore = await import('./trade-store.js');
    await tradeStore.saveStocksTradeSnapshot(USER, onDisk!);

    const ctx = await ensureUserContext(USER);
    expect(ctx.engine.getState().sma200GateRejections).toEqual([]);
  });
});
