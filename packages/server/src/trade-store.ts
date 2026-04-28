import { readFile, writeFile, mkdir, readdir, rm, copyFile, access, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { constants as FS } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Position, TradeSignal, OptionPosition, SignalType } from '@trading-app/shared';
import type { DailySignalRecord } from './reports/eod-report.js';

// ─────────────────────────────────────────────────────────────────────────────
// TRA-140 — durable trade-history store with automatic backups.
//
// Trade history (open positions, closed positions, signals, options activity)
// used to live ONLY in RAM. Every server restart on Render erased everything,
// even though the persistent disk was mounted. This module writes that state
// to JSON files under DATA_DIR after every meaningful change, rotates backup
// snapshots so a corrupt write can be recovered, and auto-restores from the
// most recent backup if the primary file is missing or unparseable.
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? join(__dirname, '..', 'data');
const BACKUP_DIR = join(DATA_DIR, 'backups');
const STOCKS_TRADES_FILE = join(DATA_DIR, 'trades-stocks.json');
const CRYPTO_TRADES_FILE = join(DATA_DIR, 'trades-crypto.json');

/** Maximum number of timestamped backup folders to keep. */
const MAX_BACKUPS = 24; // 12 hours of 30-min snapshots

export interface StocksTradeSnapshot {
  version: 1;
  savedAt: string;
  openPositions: Position[];
  closedPositions: Position[];
  recentSignals: TradeSignal[];
  dailySignals: DailySignalRecord[];
  positionSignalType: Array<[string, SignalType]>; // serialized Map
  options: {
    openOptions: OptionPosition[];
    closedOptions: OptionPosition[];
    optionsPnl: number;
    dailyCount: number;
    currentDayKey: string;
    cash: number;
    equity: number;
  };
  account: {
    cash: number;
    equity: number;
    initialEquity: number;
    dailyPnl: number;
  };
}

export interface CryptoTradeSnapshot {
  version: 1;
  savedAt: string;
  openPositions: Position[];
  closedPositions: Position[];
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
  // Node's fs/promises.rename is atomic on POSIX and atomic-enough on Windows
  // (replace dest if exists). On EXDEV / cross-device errors fall back to copy.
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
    console.warn(`[trade-store] Failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
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
      .sort(); // ISO strings sort lexicographically
    return sorted.length > 0 ? join(BACKUP_DIR, sorted[sorted.length - 1]) : null;
  } catch {
    return null;
  }
}

async function tryRestoreFromBackup<T>(file: string): Promise<T | null> {
  const latestBackup = await findLatestBackupDir();
  if (!latestBackup) return null;
  const backupFile = join(latestBackup, file.split(/[\\/]/).pop() ?? '');
  if (!existsSync(backupFile)) return null;
  try {
    const raw = await readFile(backupFile, 'utf-8');
    const parsed = JSON.parse(raw) as T;
    console.warn(`[trade-store] ⚠ Restored ${file} from backup ${backupFile}`);
    // Promote backup to primary so subsequent reads succeed.
    await writeFile(file, raw, 'utf-8');
    return parsed;
  } catch (err: unknown) {
    console.warn(`[trade-store] Backup at ${backupFile} also unparseable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function loadStocksTradeSnapshot(): Promise<StocksTradeSnapshot | null> {
  const primary = await readJsonOrNull<StocksTradeSnapshot>(STOCKS_TRADES_FILE);
  if (primary) return primary;
  return tryRestoreFromBackup<StocksTradeSnapshot>(STOCKS_TRADES_FILE);
}

export async function loadCryptoTradeSnapshot(): Promise<CryptoTradeSnapshot | null> {
  const primary = await readJsonOrNull<CryptoTradeSnapshot>(CRYPTO_TRADES_FILE);
  if (primary) return primary;
  return tryRestoreFromBackup<CryptoTradeSnapshot>(CRYPTO_TRADES_FILE);
}

export async function saveStocksTradeSnapshot(snap: StocksTradeSnapshot): Promise<void> {
  await atomicWriteJson(STOCKS_TRADES_FILE, { ...snap, savedAt: new Date().toISOString() });
}

export async function saveCryptoTradeSnapshot(snap: CryptoTradeSnapshot): Promise<void> {
  await atomicWriteJson(CRYPTO_TRADES_FILE, { ...snap, savedAt: new Date().toISOString() });
}

/**
 * Snapshot every persisted file under DATA_DIR into a timestamped backup folder
 * and prune old folders. Files snapshotted: trades-stocks.json,
 * trades-crypto.json, account-settings.json, users.json, watchlist.json,
 * equity-state.json, daily-snapshots.json (and their crypto counterparts).
 *
 * The backup is the user's "cannot be overwritten or wiped" safety net — if a
 * bad write or disk hiccup ever clears a primary file, the next startup
 * automatically restores from the most recent backup.
 */
export async function rotateBackups(): Promise<void> {
  await ensureDir(BACKUP_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(BACKUP_DIR, stamp);
  await ensureDir(target);

  const filesToBackup = [
    'trades-stocks.json',
    'trades-crypto.json',
    'account-settings.json',
    'users.json',
    'watchlist.json',
    'equity-state.json',
    'daily-snapshots.json',
  ];
  for (const name of filesToBackup) {
    const src = join(DATA_DIR, name);
    if (!existsSync(src)) continue;
    try {
      await copyFile(src, join(target, name));
    } catch (err: unknown) {
      console.warn(`[trade-store] backup copy failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Crypto subdir state files
  const cryptoDir = join(DATA_DIR, 'crypto');
  if (existsSync(cryptoDir)) {
    const cryptoTarget = join(target, 'crypto');
    await ensureDir(cryptoTarget);
    for (const name of ['equity-state.json', 'daily-snapshots.json']) {
      const src = join(cryptoDir, name);
      if (!existsSync(src)) continue;
      try {
        await copyFile(src, join(cryptoTarget, name));
      } catch { /* ignore */ }
    }
  }

  // Prune old backups
  try {
    const entries = (await readdir(BACKUP_DIR))
      .filter(n => /^\d{4}-\d{2}-\d{2}T/.test(n))
      .sort();
    const excess = entries.length - MAX_BACKUPS;
    for (let i = 0; i < excess; i++) {
      await rm(join(BACKUP_DIR, entries[i]), { recursive: true, force: true });
    }
  } catch (err: unknown) {
    console.warn(`[trade-store] backup prune failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Logs a clear warning when DATA_DIR is ephemeral (i.e. inside the package
 * bundle). On Render, DATA_DIR should point to the mounted persistent disk
 * (typically /data). If the env var is unset or points inside the build
 * artifact, every restart wipes the entire app state — exactly the symptom
 * TRA-140 is reporting.
 */
export async function checkDataDirHealth(): Promise<void> {
  const isEphemeral =
    !process.env.DATA_DIR ||
    DATA_DIR.includes('node_modules') ||
    DATA_DIR.includes(`${'packages'}${process.platform === 'win32' ? '\\' : '/'}server`);

  console.log(`[startup] DATA_DIR = ${DATA_DIR}`);
  if (isEphemeral) {
    console.warn('[startup] ⚠⚠⚠ DATA_DIR appears to be inside the build directory.');
    console.warn('[startup] ⚠⚠⚠ On Render this means trades, settings, and users will be ERASED on every redeploy.');
    console.warn('[startup] ⚠⚠⚠ Set DATA_DIR=/data and mount the tradingai-data persistent disk.');
  }
  // Sanity write/read to confirm the dir is writable.
  try {
    await ensureDir(DATA_DIR);
    const probe = join(DATA_DIR, '.write-probe');
    await writeFile(probe, String(Date.now()), 'utf-8');
    await access(probe, FS.R_OK);
    await rm(probe, { force: true });
  } catch (err: unknown) {
    console.error(`[startup] ✗ DATA_DIR is not writable: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Report freshness of any existing backup so operators can see the durable
  // safety net is in place.
  const latest = await findLatestBackupDir();
  if (latest) {
    try {
      const s = await stat(latest);
      console.log(`[startup] Latest backup: ${latest} (${s.mtime.toISOString()})`);
    } catch { /* ignore */ }
  } else {
    console.log('[startup] No backups yet — first one will be written shortly.');
  }
}
