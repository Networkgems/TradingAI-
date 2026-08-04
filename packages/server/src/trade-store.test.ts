import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { StocksTradeSnapshot, CryptoTradeSnapshot } from './trade-store.js';

// trade-store.ts captures DATA_DIR at module-evaluation time, so we must set
// process.env.DATA_DIR BEFORE importing it. Use a dynamic import in beforeAll.
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'trade-store-test-'));
process.env.DATA_DIR = TMP_ROOT;

type TradeStoreModule = typeof import('./trade-store.js');
let loadStocksTradeSnapshot: TradeStoreModule['loadStocksTradeSnapshot'];
let saveStocksTradeSnapshot: TradeStoreModule['saveStocksTradeSnapshot'];
let loadCryptoTradeSnapshot: TradeStoreModule['loadCryptoTradeSnapshot'];
let saveCryptoTradeSnapshot: TradeStoreModule['saveCryptoTradeSnapshot'];
let rotateBackups: TradeStoreModule['rotateBackups'];
// TRA-2817 — the inode-budget retention math.
let backupGenerationsWithinBudget: TradeStoreModule['backupGenerationsWithinBudget'];

beforeAll(async () => {
  const mod = await import('./trade-store.js');
  loadStocksTradeSnapshot = mod.loadStocksTradeSnapshot;
  saveStocksTradeSnapshot = mod.saveStocksTradeSnapshot;
  loadCryptoTradeSnapshot = mod.loadCryptoTradeSnapshot;
  saveCryptoTradeSnapshot = mod.saveCryptoTradeSnapshot;
  rotateBackups = mod.rotateBackups;
  backupGenerationsWithinBudget = mod.backupGenerationsWithinBudget;
});

beforeEach(() => {
  // Reset DATA_DIR contents between tests. Wipe per-user files and the
  // shared BACKUP_DIR so findLatestBackupDir() starts clean each time.
  rmSync(join(TMP_ROOT, 'users'), { recursive: true, force: true });
  rmSync(join(TMP_ROOT, 'backups'), { recursive: true, force: true });
});

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

const USER = 'alice';

function makeStocksSnapshot(): StocksTradeSnapshot {
  return {
    version: 1,
    savedAt: '',
    openPositions: [
      {
        id: 'p1',
        symbol: 'AAPL',
        side: 'buy',
        signalType: 'orb_breakout',
        entryPrice: 180,
        quantity: 10,
        stopLoss: 178,
        takeProfit: 184,
        openedAt: 1700000000000,
      },
    ],
    closedPositions: [],
    recentSignals: [],
    dailySignals: [],
    positionSignalType: [['p1', 'orb_breakout']],
    options: {
      openOptions: [],
      closedOptions: [],
      optionsPnl: 0,
      dailyCount: 0,
      currentDayKey: '2026-04-28',
      cash: 1000,
      equity: 1000,
    },
    account: {
      cash: 9820,
      equity: 11620,
      initialEquity: 10000,
      dailyPnl: 0,
    },
  };
}

function makeCryptoSnapshot(): CryptoTradeSnapshot {
  return {
    version: 1,
    savedAt: '',
    openPositions: [
      {
        id: 'c1',
        symbol: 'BTC-USD',
        side: 'buy',
        signalType: 'macd_cross',
        entryPrice: 60000,
        quantity: 0.05,
        stopLoss: 59000,
        takeProfit: 62000,
        openedAt: 1700000000000,
      },
    ],
    closedPositions: [],
    recentSignals: [],
    account: {
      cash: 22000,
      equity: 25000,
      initialEquity: 25000,
      openingEquityToday: 25000,
    },
  };
}

const stocksFile = (user: string) => join(TMP_ROOT, 'users', user, 'trades-stocks.json');
const cryptoFile = (user: string) => join(TMP_ROOT, 'users', user, 'trades-crypto.json');

describe('loadStocksTradeSnapshot — restore-from-backup paths', () => {
  it('happy-path: restores from backup when primary is missing and re-creates primary', async () => {
    const snap = makeStocksSnapshot();
    await saveStocksTradeSnapshot(USER, snap);
    await rotateBackups();

    rmSync(stocksFile(USER), { force: true });
    expect(existsSync(stocksFile(USER))).toBe(false);

    const loaded = await loadStocksTradeSnapshot(USER);
    expect(loaded).not.toBeNull();
    expect(loaded!.openPositions).toEqual(snap.openPositions);
    expect(loaded!.account).toEqual(snap.account);
    expect(loaded!.options).toEqual(snap.options);
    // Primary file is recreated as a side-effect of the restore.
    expect(existsSync(stocksFile(USER))).toBe(true);
  });

  it('corrupt-primary: falls back to the latest backup when primary JSON is unparseable', async () => {
    const snap = makeStocksSnapshot();
    await saveStocksTradeSnapshot(USER, snap);
    await rotateBackups();

    writeFileSync(stocksFile(USER), '{ this is not valid json', 'utf-8');

    const loaded = await loadStocksTradeSnapshot(USER);
    expect(loaded).not.toBeNull();
    expect(loaded!.openPositions).toEqual(snap.openPositions);
    expect(loaded!.account).toEqual(snap.account);
    // Restore overwrites the corrupted primary with valid JSON.
    const restoredRaw = readFileSync(stocksFile(USER), 'utf-8');
    expect(() => JSON.parse(restoredRaw)).not.toThrow();
  });

  it('no-backup: returns null safely when there is neither primary nor any backup', async () => {
    const loaded = await loadStocksTradeSnapshot(USER);
    expect(loaded).toBeNull();
  });
});

describe('loadCryptoTradeSnapshot — mirror coverage', () => {
  it('happy-path: restores from backup when primary is missing and re-creates primary', async () => {
    const snap = makeCryptoSnapshot();
    await saveCryptoTradeSnapshot(USER, snap);
    await rotateBackups();

    rmSync(cryptoFile(USER), { force: true });
    expect(existsSync(cryptoFile(USER))).toBe(false);

    const loaded = await loadCryptoTradeSnapshot(USER);
    expect(loaded).not.toBeNull();
    expect(loaded!.openPositions).toEqual(snap.openPositions);
    expect(loaded!.account).toEqual(snap.account);
    expect(existsSync(cryptoFile(USER))).toBe(true);
  });

  it('corrupt-primary: falls back to the latest backup when primary JSON is unparseable', async () => {
    const snap = makeCryptoSnapshot();
    await saveCryptoTradeSnapshot(USER, snap);
    await rotateBackups();

    writeFileSync(cryptoFile(USER), 'not-json-at-all', 'utf-8');

    const loaded = await loadCryptoTradeSnapshot(USER);
    expect(loaded).not.toBeNull();
    expect(loaded!.openPositions).toEqual(snap.openPositions);
    expect(loaded!.account).toEqual(snap.account);
  });

  it('no-backup: returns null safely when there is neither primary nor any backup', async () => {
    const loaded = await loadCryptoTradeSnapshot(USER);
    expect(loaded).toBeNull();
  });
});

/**
 * TRA-2817 — backup retention denominated in INODES, not generations.
 *
 * `/data` on bqb1 returned `ENOSPC` on every write from 2026-07-30T23:40:19Z
 * for five days; the EOD ledger stopped dead across 47 books. It was not out of
 * bytes — 383 MB of 1 GB were free. It was out of inodes: 65524 of the 65536
 * entries an ext4 volume of that size gets, with `backups/` holding 39590 of
 * the 50668 files.
 *
 * `MAX_BACKUPS = 24` was doing exactly what it said. That is the defect: it
 * bounds GENERATIONS, and a generation costs six files per user plus a crypto
 * subdir, so its inode cost scales linearly with the book count. The fleet grew
 * 28 -> 56 -> 61 accounts and walked into the inode table. A retention policy
 * denominated in the wrong unit has no failing state.
 */
describe('TRA-2817 backup retention inode budget', () => {
  const MAX_FILES = 8_000;
  const MAX_GENERATIONS = 24;

  const fit = (filesPerGeneration: number) =>
    backupGenerationsWithinBudget(filesPerGeneration, MAX_FILES, MAX_GENERATIONS);

  it('collapses retention as the fleet grows — the live 61-book cost', () => {
    // 39590 files / 25 generations = ~1584 per generation at 61 users.
    // 8000 / 1584 = 5 generations, not 24. Depth FALLS, cost does not RISE.
    expect(fit(1584)).toBe(5);
  });

  it('keeps the full window while a generation is cheap', () => {
    // A small fleet is unaffected: the generation cap still binds first, so
    // this change is not a silent retention cut for every install.
    expect(fit(100)).toBe(MAX_GENERATIONS);
    expect(fit(1)).toBe(MAX_GENERATIONS);
  });

  it('never floors below 2, even at an absurd per-generation cost', () => {
    // One generation is not a backup: the newest is written DURING the window
    // in which the primary can be corrupted, so a keep-1 policy can hand back
    // the corruption it exists to undo.
    expect(fit(1_000_000)).toBe(2);
  });

  it('returns the full cap when the cost cannot be measured', () => {
    // An empty tree / first boot. An unmeasurable cost must not manufacture an
    // aggressive prune — the failure direction has to be conservative.
    expect(fit(0)).toBe(MAX_GENERATIONS);
    expect(fit(Number.NaN)).toBe(MAX_GENERATIONS);
    expect(fit(-5)).toBe(MAX_GENERATIONS);
  });

  it('prunes BEFORE it copies, so a full filesystem can recover', () => {
    // The half of this fix that ends an incident rather than preventing the
    // next one. Copy-then-prune is a stable deadlock under ENOSPC: every
    // copyFile fails and is swallowed as a warn, the prune then finds exactly
    // MAX_BACKUPS generations and removes nothing, and the tree sits at its
    // high-water inode mark forever. Nothing in that loop can release the
    // inodes it needs to make progress.
    const src = readFileSync(new URL('./trade-store.ts', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('export async function rotateBackups'));
    const pruneAt = fn.indexOf('pruneBackupsToBudget()');
    const copyAt = fn.indexOf('copyFile(');
    expect(pruneAt).toBeGreaterThan(-1);
    expect(copyAt).toBeGreaterThan(-1);
    expect(pruneAt).toBeLessThan(copyAt);
  });
});
