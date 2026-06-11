import { readFile, writeFile, mkdir, readdir, rm, copyFile, access, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { constants as FS } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { AccountMode, Position, TradeSignal, OptionPosition, SignalType, TradierEnv } from '@trading-app/shared';
import type { DailySignalRecord } from './reports/eod-report.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'trade-store' });

// ─────────────────────────────────────────────────────────────────────────────
// TRA-140 — durable trade-history store with automatic backups.
// TRA-142 — extended to scope every persisted file by username so per-user
// trade history, settings, watchlist, and equity state never collide. Each
// user's data lives under DATA_DIR/users/<username>/ and the global files
// (users.json, reset-tokens.json) stay at the root.
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * TRA-522 — resolve the on-disk persistence root.
 *
 * Root cause of the silent demo-book swap on restart: this path was only ever
 * pinned to `process.env.DATA_DIR`, and the fallback anchors to the *module's*
 * location (`<repo>/packages/server/data`). On the self-hosted host two repos
 * exist (`_default/tradingai_repo` and a sibling `~/TradingAI`), each with its
 * own `packages/server/data`. A PM2 restart launched from a different repo /
 * ecosystem file therefore loaded a *different* book — that is how the demo
 * account flipped from $1,000 (live book) to $26,397 (stale sibling book).
 *
 * The contract this helper guarantees:
 *   1. When `DATA_DIR` is set, it wins verbatim — the canonical, launch-cwd /
 *      repo-independent location ops point every instance at (see
 *      `ops/bootstrap-trading-server.sh` and `docs/runbook.md` §1).
 *   2. The fallback is anchored to `moduleDir`, never to `process.cwd()`, so
 *      the resolved path does not move just because PM2 was started from a
 *      different working directory.
 *
 * `ecosystem.config.cjs` now sets `DATA_DIR` explicitly so the canonical
 * production launch path always takes branch (1); the fallback only applies to
 * ad-hoc / dev runs.
 */
export function resolveDataDir(
  env: NodeJS.ProcessEnv = process.env,
  moduleDir: string = __dirname,
): string {
  const fromEnv = env.DATA_DIR;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  return join(moduleDir, '..', 'data');
}

const DATA_DIR = resolveDataDir();
const BACKUP_DIR = join(DATA_DIR, 'backups');

/** Maximum number of timestamped backup folders to keep. */
const MAX_BACKUPS = 24; // 12 hours of 30-min snapshots

function userDir(username: string): string {
  return join(DATA_DIR, 'users', username);
}

function stocksTradesFile(username: string): string {
  return join(userDir(username), 'trades-stocks.json');
}

function cryptoTradesFile(username: string): string {
  return join(userDir(username), 'trades-crypto.json');
}

/**
 * TRA-233 — single env's options bucket as serialized to disk. Existed
 * inline before; pulled out so the per-env snapshot map can reuse the same
 * shape.
 */
export interface OptionsBucketSnapshot {
  openOptions: OptionPosition[];
  closedOptions: OptionPosition[];
  optionsPnl: number;
  /**
   * TRA-246 — per-mode realized P&L. When absent (legacy snapshot), the
   * importer attributes the bucket-wide `optionsPnl` total to the live
   * bucket (demo cannot open options under TRA-220).
   */
  optionsPnlByMode?: Partial<Record<AccountMode, number>>;
  /**
   * TRA-475 — per-mode opening realized P&L for the current ET-day, used
   * to compute the dashboard "Daily Opts P&L" pill. Optional for back-compat;
   * legacy snapshots have the bucket re-anchor to current cumulative on import.
   */
  openingOptionsPnlByMode?: Partial<Record<AccountMode, number>>;
  dailyCount: number;
  /** Added in TRA-160 — older snapshots may be missing it. */
  dailyOtmCount?: number;
  /** Added in TRA-191 — older snapshots may be missing it. */
  dailyRvCount?: number;
  currentDayKey: string;
  cash: number;
  equity: number;
  /** TRA-233 — env this bucket belongs to. */
  tradierEnv?: TradierEnv | null;
}

export interface StocksTradeSnapshot {
  version: 1;
  savedAt: string;
  openPositions: Position[];
  closedPositions: Position[];
  recentSignals: TradeSignal[];
  dailySignals: DailySignalRecord[];
  positionSignalType: Array<[string, SignalType]>; // serialized Map
  /**
   * Active env's options bucket. Kept for back-compat with snapshots written
   * before TRA-233 — current readers should prefer `optionsByEnv` so both
   * sandbox and production survive a server restart.
   */
  options: OptionsBucketSnapshot;
  /** TRA-233 — per-env options buckets (sandbox + production). */
  optionsByEnv?: Record<TradierEnv, OptionsBucketSnapshot>;
  account: {
    cash: number;
    equity: number;
    initialEquity: number;
    dailyPnl: number;
  };
  /**
   * TRA-801 — the SupertrendConfluence PAPER forward-test book. Optional for
   * back-compat with snapshots written before the forward test existed; absent
   * means "start the book empty". Closed forward-test trades live in
   * `closedPositions` like any other paper trade — this only persists the OPEN
   * positions (cash/equity/openPositions) so a redeploy doesn't abandon them.
   */
  supertrendPaper?: {
    cash: number;
    equity: number;
    initialEquity: number;
    dailyPnl: number;
    openPositions: Position[];
  };
}

export interface CryptoTradeSnapshot {
  version: 1;
  savedAt: string;
  openPositions: Position[];
  /**
   * Pre-TRA-242 merged closed list. Always equal to `demoClosedPositions`
   * on fresh saves so older callers / pre-split backups round-trip safely.
   * New code should consume the split lists below.
   */
  closedPositions: Position[];
  /**
   * TRA-242 — Demo (paper) closed positions only. Persisted separately
   * from the live broker history so the Live dashboard never surfaces
   * Demo trades.
   */
  demoClosedPositions?: Position[];
  /**
   * TRA-242 — Live closed positions mirrored from the Coinbase broker
   * view. Optional because pre-TRA-242 snapshots don't have it; the engine
   * treats absence as "no live history yet".
   */
  liveClosedPositions?: Position[];
  recentSignals: TradeSignal[];
  account: {
    cash: number;
    equity: number;
    initialEquity: number;
    openingEquityToday: number;
  };
}

async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * Atomic write: write to <file>.tmp first, then rename. Prevents a half-written
 * JSON file if the process is killed mid-write — the previous file stays valid.
 */
async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await ensureDir(dirname(file));
  const tmp = `${file}.tmp`;
  const json = JSON.stringify(value, null, 2);
  await writeFile(tmp, json, 'utf-8');
  const { rename } = await import('fs/promises');
  try {
    await rename(tmp, file);
  } catch {
    await copyFile(tmp, file);
    await rm(tmp, { force: true });
  }
}

async function readJsonOrNull<T>(file: string): Promise<T | null> {
  if (!existsSync(file)) return null;
  try {
    const raw = await readFile(file, 'utf-8');
    if (!raw.trim()) return null;
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    log.warn('Failed to parse JSON file', {
      file,
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Returns the most recent backup directory (ISO-timestamped), or null. */
async function findLatestBackupDir(): Promise<string | null> {
  if (!existsSync(BACKUP_DIR)) return null;
  try {
    const entries = await readdir(BACKUP_DIR);
    const sorted = entries
      .filter(name => /^\d{4}-\d{2}-\d{2}T/.test(name))
      .sort();
    return sorted.length > 0 ? join(BACKUP_DIR, sorted[sorted.length - 1]) : null;
  } catch {
    return null;
  }
}

/**
 * Try to restore a per-user file from the latest backup. Backups mirror the
 * user-namespaced layout (backups/<ts>/users/<username>/<file>).
 */
async function tryRestoreFromBackup<T>(targetFile: string, username: string, fileName: string): Promise<T | null> {
  const latestBackup = await findLatestBackupDir();
  if (!latestBackup) return null;
  const backupFile = join(latestBackup, 'users', username, fileName);
  if (!existsSync(backupFile)) return null;
  try {
    const raw = await readFile(backupFile, 'utf-8');
    const parsed = JSON.parse(raw) as T;
    log.warn('Restored file from backup', { targetFile, backupFile });
    await ensureDir(dirname(targetFile));
    await writeFile(targetFile, raw, 'utf-8');
    return parsed;
  } catch (err: unknown) {
    log.warn('Backup file also unparseable', {
      backupFile,
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function loadStocksTradeSnapshot(username: string): Promise<StocksTradeSnapshot | null> {
  const file = stocksTradesFile(username);
  const primary = await readJsonOrNull<StocksTradeSnapshot>(file);
  if (primary) return primary;
  return tryRestoreFromBackup<StocksTradeSnapshot>(file, username, 'trades-stocks.json');
}

export async function loadCryptoTradeSnapshot(username: string): Promise<CryptoTradeSnapshot | null> {
  const file = cryptoTradesFile(username);
  const primary = await readJsonOrNull<CryptoTradeSnapshot>(file);
  if (primary) return primary;
  return tryRestoreFromBackup<CryptoTradeSnapshot>(file, username, 'trades-crypto.json');
}

export async function saveStocksTradeSnapshot(username: string, snap: StocksTradeSnapshot): Promise<void> {
  await atomicWriteJson(stocksTradesFile(username), { ...snap, savedAt: new Date().toISOString() });
}

export async function saveCryptoTradeSnapshot(username: string, snap: CryptoTradeSnapshot): Promise<void> {
  await atomicWriteJson(cryptoTradesFile(username), { ...snap, savedAt: new Date().toISOString() });
}

/**
 * Snapshot every persisted file under DATA_DIR into a timestamped backup folder
 * and prune old folders. Backs up global files (users.json) at the root and
 * mirrors per-user trees under backups/<ts>/users/<username>/.
 *
 * If a primary file is wiped or corrupted, the next startup automatically
 * restores from the most recent backup.
 */
export async function rotateBackups(): Promise<void> {
  await ensureDir(BACKUP_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(BACKUP_DIR, stamp);
  await ensureDir(target);

  // Global files at the data-dir root.
  const globalFiles = ['users.json', 'admin-reset-applied.json'];
  for (const name of globalFiles) {
    const src = join(DATA_DIR, name);
    if (!existsSync(src)) continue;
    try {
      await copyFile(src, join(target, name));
    } catch (err: unknown) {
      log.warn('backup copy failed', {
        name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Per-user trees: walk DATA_DIR/users/* and mirror each user's files.
  const usersRoot = join(DATA_DIR, 'users');
  if (existsSync(usersRoot)) {
    const userFiles = [
      'trades-stocks.json',
      'trades-crypto.json',
      'account-settings.json',
      'watchlist.json',
      'equity-state.json',
      'daily-snapshots.json',
    ];
    let entries: string[] = [];
    try {
      entries = await readdir(usersRoot);
    } catch { /* ignore */ }
    for (const username of entries) {
      const srcDir = join(usersRoot, username);
      try {
        const st = await stat(srcDir);
        if (!st.isDirectory()) continue;
      } catch { continue; }
      const dstDir = join(target, 'users', username);
      await ensureDir(dstDir);
      for (const name of userFiles) {
        const src = join(srcDir, name);
        if (!existsSync(src)) continue;
        try {
          await copyFile(src, join(dstDir, name));
        } catch (err: unknown) {
          log.warn('backup copy failed', {
            username,
            name,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Crypto subdir for tracker state files.
      const cryptoSrc = join(srcDir, 'crypto');
      if (existsSync(cryptoSrc)) {
        const cryptoDst = join(dstDir, 'crypto');
        await ensureDir(cryptoDst);
        for (const name of ['equity-state.json', 'daily-snapshots.json']) {
          const src = join(cryptoSrc, name);
          if (!existsSync(src)) continue;
          try {
            await copyFile(src, join(cryptoDst, name));
          } catch { /* ignore */ }
        }
      }
    }
  }

  // Prune old backups.
  try {
    const entries = (await readdir(BACKUP_DIR))
      .filter(n => /^\d{4}-\d{2}-\d{2}T/.test(n))
      .sort();
    const excess = entries.length - MAX_BACKUPS;
    for (let i = 0; i < excess; i++) {
      await rm(join(BACKUP_DIR, entries[i]), { recursive: true, force: true });
    }
  } catch (err: unknown) {
    log.warn('backup prune failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Logs a clear warning when DATA_DIR is ephemeral (i.e. inside the package
 * bundle). On Render, DATA_DIR should point to the mounted persistent disk.
 */
export async function checkDataDirHealth(): Promise<void> {
  const isEphemeral =
    !process.env.DATA_DIR ||
    DATA_DIR.includes('node_modules') ||
    DATA_DIR.includes(`${'packages'}${process.platform === 'win32' ? '\\' : '/'}server`);

  log.info('DATA_DIR resolved', { dataDir: DATA_DIR });
  if (isEphemeral) {
    log.warn('DATA_DIR appears to be inside the build directory.');
    log.warn('On Render this means trades, settings, and users will be ERASED on every redeploy.');
    log.warn('Set DATA_DIR=/data and mount the tradingai-data persistent disk.');
  }
  try {
    await ensureDir(DATA_DIR);
    const probe = join(DATA_DIR, '.write-probe');
    await writeFile(probe, String(Date.now()), 'utf-8');
    await access(probe, FS.R_OK);
    await rm(probe, { force: true });
  } catch (err: unknown) {
    log.error('DATA_DIR is not writable', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  const latest = await findLatestBackupDir();
  if (latest) {
    try {
      const s = await stat(latest);
      log.info('Latest backup found', { latest, mtime: s.mtime.toISOString() });
    } catch { /* ignore */ }
  } else {
    log.info('No backups yet — first one will be written shortly.');
  }
}
