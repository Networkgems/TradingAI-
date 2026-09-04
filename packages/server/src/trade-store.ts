import { readFile, writeFile, mkdir, readdir, rm, copyFile, access, stat } from 'fs/promises';
import type { Dirent } from 'fs';
import { existsSync } from 'fs';
import { constants as FS } from 'fs';
import { join, dirname, basename } from 'path';
import { accountDeletedAt, DELETED_ACCOUNTS_FILENAME } from './deleted-accounts.js';
import type { AccountMode, Position, TradeSignal, Sma200Signal, Sma200SignalVoidRecord, OptionPosition, SignalType, TradierEnv } from '@trading-app/shared';
import type { DailySignalRecord } from './reports/eod-report.js';
import type { PaperAccountSnapshot } from './paper-account.js';
import { isEphemeralDataDir, resolveDataDir } from './data-dir.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'trade-store' });

// ─────────────────────────────────────────────────────────────────────────────
// TRA-140 — durable trade-history store with automatic backups.
// TRA-142 — extended to scope every persisted file by username so per-user
// trade history, settings, watchlist, and equity state never collide. Each
// user's data lives under DATA_DIR/users/<username>/ and the global files
// (users.json, reset-tokens.json) stay at the root.
// ─────────────────────────────────────────────────────────────────────────────

// TRA-2421 — `resolveDataDir` now lives in the leaf module `data-dir.ts` and is
// re-exported here so every existing importer keeps working. It had to move:
// `deleted-accounts.ts` needs the resolved root, and this module has to ask IT
// whether an account was destroyed before restoring one from a backup — which
// made the two a cycle, and `scripts/check-cycles.mjs` (TRA-1684) refuses cycles
// on principle. One implementation, two doors.
export { resolveDataDir };

const DATA_DIR = resolveDataDir();
const BACKUP_DIR = join(DATA_DIR, 'backups');

/** Maximum number of timestamped backup folders to keep. */
const MAX_BACKUPS = 24; // 12 hours of 30-min snapshots

/**
 * TRA-2817 — the INODE budget for the whole `backups/` tree, and the reason
 * `MAX_BACKUPS` alone is not a retention policy.
 *
 * On 2026-07-30T23:40:19Z `/data` on bqb1 began returning `ENOSPC` on every
 * write and did not stop for five days. It was not out of BYTES — 383 MB of
 * 1 GB were free, `freePct 37.6`, and `disk.belowThreshold` read a clean
 * `false` throughout. It was out of INODES: `usage.allocation.sampledPaths`
 * measured **65524** against the 65536-entry inode table an ext4 filesystem
 * gets on a 1 GB volume, and `backups` held **39590** of the 50668 files.
 *
 * `MAX_BACKUPS` bounds the number of GENERATIONS. But a generation mirrors six
 * files per user plus a crypto subdir, so its inode cost scales LINEARLY with
 * the book count — 39590 / 25 generations = ~1584 files each at 61 users. The
 * backup code never changed; the fleet grew into the table (28 -> 56 -> 61
 * accounts over three weeks, measured by TRA-2414). A retention policy
 * denominated in the wrong unit has no failing state: it was doing exactly what
 * it said, at 24 generations, while consuming 60% of the filesystem's capacity
 * to hold a file at all.
 *
 * So retention is now bounded by BOTH: at most `MAX_BACKUPS` generations AND at
 * most `BACKUP_MAX_FILES` inodes across the tree. Whichever binds first wins,
 * and the depth in generations therefore FALLS as the fleet grows instead of
 * the cost rising. The resulting depth is published on the health route so a
 * shrinking retention window is visible rather than inferred.
 *
 * The budget is deliberately a small fraction of a 1 GB volume's table: backups
 * are a convenience (a corrupt primary auto-restores from the newest one), and
 * they must never again be able to starve the primary writes they exist to
 * protect. Env-tunable because the right number depends on the volume, and a
 * constant compiled into the bundle is one that cannot be moved during an
 * incident.
 */
export function backupMaxFiles(): number {
  const raw = Number(process.env['BACKUP_MAX_FILES']);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8_000;
}

/**
 * TRA-2817 — how many generations fit in the inode budget, given the measured
 * per-generation cost.
 *
 * `filesPerGeneration` is measured off the NEWEST generation on disk rather
 * than assumed from the user count: the mirror skips files that do not exist,
 * so a computed `userCount * 7` overstates it for a fleet of mostly-empty demo
 * books, and an overstatement here silently collapses retention to the floor.
 *
 * Floors at 2. One generation is not a backup — the newest one is written
 * DURING the window in which the primary can be corrupted, so a policy that
 * keeps only the newest can hand back the corruption it was meant to undo.
 * Returns `MAX_BACKUPS` when the cost cannot be measured (an empty tree, a
 * first boot): an unmeasurable cost must not manufacture an aggressive prune.
 */
export function backupGenerationsWithinBudget(
  filesPerGeneration: number,
  maxFiles: number = backupMaxFiles(),
  maxGenerations: number = MAX_BACKUPS,
): number {
  if (!Number.isFinite(filesPerGeneration) || filesPerGeneration <= 0) return maxGenerations;
  const fit = Math.floor(maxFiles / filesPerGeneration);
  return Math.max(2, Math.min(maxGenerations, fit));
}

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
 * TRA-3407 — the paths the write axis stats. Exported so
 * `/api/health/snapshot-persist` reads the SAME file `saveStocksTradeSnapshot`
 * writes, resolved by the SAME function, rather than re-deriving the layout at
 * the call site where a rename would silently point the instrument at a file
 * nobody writes (which grades NOT_MEASURED forever and reads like a quiet box).
 *
 * The route stats these itself. That is the point: the on-disk mtime must come
 * from a read independent of the in-process outcome counter, or a dead writer
 * confirms its own freshness.
 */
export function snapshotFilePathFor(username: string, axis: 'stocks' | 'crypto'): string {
  return axis === 'stocks' ? stocksTradesFile(username) : cryptoTradesFile(username);
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
  // TRA-3688 — SMA-200 rows carry null takeProfit/riskRewardRatio, so the
  // persisted feed is the explicit union.
  recentSignals: (TradeSignal | Sma200Signal)[];
  /**
   * TRA-3688 S-3 — voided SMA-200 signals (`bar_rollover` / `price_drift`),
   * persisted so the "removed AND recorded" witness survives a restart.
   * Absent on snapshots written before the field.
   */
  sma200SignalVoids?: Sma200SignalVoidRecord[];
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
  /**
   * TRA-3860 — epoch ms of the last daily archive tick observed on this book,
   * and therefore the earliest exit time `/api/trades/export` can attest to for
   * stocks and crypto. The archive (TRA-219) empties `closedPositions` and the
   * options buckets wholesale, so a range starting before this is unservable and
   * the route refuses it instead of answering `trades: []` — which was
   * indistinguishable from a day that genuinely had no trades.
   *
   * Optional, and absent on every snapshot written before this ticket. ABSENT
   * MEANS "no boundary has been observed on this book", which routes the export
   * onto a conservative process-start floor. Do NOT default it to 0 at any read
   * site: an epoch-0 floor reads as "this export covers all of history", which is
   * the one wrong answer this field exists to prevent.
   */
  lastArchivedAt?: number | null;
  account: {
    cash: number;
    equity: number;
    initialEquity: number;
    dailyPnl: number;
    /**
     * TRA-2301 — audit trace of the one-shot cash repair. Absent on every
     * snapshot written before the fix and on books that never drifted; a
     * repaired book keeps it so it stays distinguishable from a clean one.
     */
    cashRepair?: { appliedAt: number; delta: number; from: number; to: number } | null;
    /**
     * TRA-2629 — cumulative realized option P&L credited into this book
     * (`PaperAccount.optionsCredited`). TRA-2323 added the field to
     * `PaperAccountSnapshot` but NOT to this durable type, so it was dropped on
     * both the write and the read and reset to 0 on every restart — while
     * `equity` (which contains those credits) survived. The EOD writer recovers
     * the stock-only leg as `equityDelta − (credited_now − credited_on_last_row)`;
     * zeroing only the left endpoint makes the two stop telescoping and re-adds
     * the prior session's option credit into `dailyPnl`. That is the
     * `stockDaily == prior session optionsDaily` lag observed on 13 books.
     *
     * Absent on every snapshot written before this fix. Do NOT collapse a missing
     * value to 0 at the restore site: seed it from the last EOD row's
     * `optionsCreditedCumulative`, which is the exact baseline the writer
     * differences against.
     */
    optionsCredited?: number;
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
  /**
   * TRA-936 — DURABLE cumulative closed SupertrendConfluence paper forward-test
   * trades. Persisted separately from `closedPositions` because the latter is
   * wiped nightly by the TRA-219 UI archive; this list is not, so the promotion
   * gate's Stage-2 `paper.tradeCount` accumulates across sessions and survives a
   * redeploy. Optional for back-compat with snapshots written before TRA-936
   * (absent ⇒ the ledger starts empty and re-accrues forward).
   */
  supertrendPaperClosed?: Position[];
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
 * TRA-2421 — parse a backup generation's directory name back to ms-epoch.
 *
 * `rotateBackups` stamps them with `new Date().toISOString().replace(/[:.]/g,'-')`,
 * i.e. `2026-07-26T12-00-00-000Z`. This is the inverse, and it lives here because
 * this module owns that naming. Returns `null` for anything that does not match
 * exactly — callers must treat `null` as UNKNOWN and fail closed, never as 0.
 */
export function parseBackupGenerationStamp(name: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(name);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Try to restore a per-user file from the latest backup. Backups mirror the
 * user-namespaced layout (backups/<ts>/users/<username>/<file>).
 *
 * TRA-2421 — this fallback is why `rm -rf DATA_DIR/users/<name>/` DOES NOT delete
 * an account: the next read of a missing primary silently restores the whole book
 * from a backup and writes it back to disk. `wipeAccountData` purges the user's
 * subtree from every generation, and this guard is the second line of defence for
 * when that purge cannot complete (a locked file, a `rotateBackups()` racing the
 * delete, or a DATA_DIR rolled back from an external snapshot): a tombstoned name
 * may never be restored from a generation older than its deletion.
 *
 * Fails CLOSED — a generation whose stamp cannot be parsed is refused rather than
 * assumed recent, because the cost of a false negative is one lost restore and the
 * cost of a false positive is resurrecting a book the user asked us to destroy.
 * Names with no tombstone (every ordinary account) are unaffected.
 */
async function tryRestoreFromBackup<T>(targetFile: string, username: string, fileName: string): Promise<T | null> {
  const latestBackup = await findLatestBackupDir();
  if (!latestBackup) return null;
  const deletedAt = accountDeletedAt(username, DATA_DIR);
  if (deletedAt !== null) {
    const stamp = parseBackupGenerationStamp(basename(latestBackup));
    if (stamp === null || stamp < deletedAt) {
      log.warn('Refusing backup restore for a deleted account', {
        targetFile,
        latestBackup,
        username,
        deletedAt: new Date(deletedAt).toISOString(),
        reason: stamp === null ? 'unparseable backup stamp' : 'backup predates deletion',
      });
      return null;
    }
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// TRA-2629 — the ONE place `PaperAccountSnapshot` crosses the durability seam.
//
// It used to be two hand-written object literals in `user-context.ts` (one in
// the boot restore, one in `persistStocksNow`), each rebuilding the account
// field by field. That shape has now silently dropped a field TWICE: TRA-2301's
// `cashRepair` (caught during the change) and TRA-2323's `optionsCredited`
// (NOT caught — it reset to 0 on every restart for 5 days while `equity` kept
// the credits it was supposed to cancel, pushing the previous session's option
// P&L into the stock leg on 13 books).
//
// Two literals that must agree with each other and with a third declaration —
// the type — is the TRA-2210 "filter at SOME call sites" failure, and a
// partially-routed field reads identically to a correct one from any single
// boot. One choke point, exercised by both directions in the tests, is the only
// shape where adding a field to `PaperAccountSnapshot` cannot silently fail to
// persist.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Project the in-memory account snapshot onto the durable shape.
 *
 * `openPositions` is deliberately NOT carried here: `StocksTradeSnapshot` stores
 * it at the TOP level (`snap.openPositions`), not nested under `account`, and
 * that layout predates this seam. {@link restoreDurableAccountSnapshot} takes it
 * as a separate argument for the same reason.
 */
export function toDurableAccountSnapshot(snap: PaperAccountSnapshot): StocksTradeSnapshot['account'] {
  return {
    cash: snap.cash,
    equity: snap.equity,
    initialEquity: snap.initialEquity,
    dailyPnl: snap.dailyPnl,
    cashRepair: snap.cashRepair ?? null,
    optionsCredited: snap.optionsCredited ?? 0,
  };
}

/**
 * Rehydrate the in-memory account snapshot from the durable shape.
 *
 * `fallbackOptionsCredited` is the migration seam for snapshots written before
 * TRA-2629 added the field. It must be the last EOD row's
 * `optionsCreditedCumulative` (`PnlTracker.getLastOptionsCreditedCumulative()`),
 * NOT 0: the restored `equity` already contains every historical option credit,
 * and the EOD writer only ever uses this counter as a DELTA against that same
 * row. Seeding from the row makes the first post-fix window exact even though
 * the row's absolute value was itself written during the buggy era.
 */
export function restoreDurableAccountSnapshot(
  durable: StocksTradeSnapshot['account'],
  openPositions: Position[],
  fallbackOptionsCredited: number,
): PaperAccountSnapshot {
  return {
    cash: durable.cash,
    equity: durable.equity,
    initialEquity: durable.initialEquity,
    dailyPnl: durable.dailyPnl,
    openPositions,
    cashRepair: durable.cashRepair ?? null,
    optionsCredited: durable.optionsCredited ?? fallbackOptionsCredited,
  };
}

/**
 * TRA-2847 — the counter credit the restored EQUITY absorbed that neither the
 * durable counter nor any EOD row ever recorded.
 *
 * TRA-2629's restore seam assumes the counter it rehydrates accounts for every
 * option credit sitting inside the restored `equity`. That invariant has a
 * failing state the fix never covered: a book whose durable file absorbed a
 * credit while the counter was dead (`ctoverify_tra2333` — its 07-29 close's
 * +73.05 reached the file's `equity` under the pre-fix writer, minutes before
 * the TRA-2817 inode outage froze `trades-stocks.json` for five days) restores
 * `equity` WITH the credit and a counter of 0, from a file whose every EOD row
 * also carries 0. The next written row's stock leg then books the whole credit:
 * `(equity − openingEquity) − (0 − 0)` — the Defect B signature, written by a
 * build that descends from `ec05639`.
 *
 * The unrecorded credit is recoverable because two independent ledgers bound it:
 *
 *  - the JOURNAL (append-only, survived the outage) knows the cumulative demo
 *    realized options P&L the sink SHOULD have credited over the book's life:
 *    `journalSurplus = journalDemoRealizedCumUsd − restoredOptionsCredited`;
 *  - the EQUITY WINDOW knows how much unexplained value actually sits between
 *    the restored equity and the anchor the EOD writer will difference against:
 *    `windowSurplus = restoredEquity − trackerOpeningEquity`.
 *
 * `min` of the two, floored at 0. Each surplus alone over-corrects a real
 * state: seeding from the journal alone re-breaks the FROZEN-counter book
 * (admin, TRA-2658 — $254 realized that never reached equity; its window
 * surplus is 0, so the min is 0 and the counter honestly stays put), and the
 * window alone would attribute a post-row STOCK gain to options (its journal
 * surplus is 0, so the min is 0 again). Only when the journal names missing
 * credits AND the equity window shows unexplained value does this move, and
 * then by no more than either ledger can vouch for.
 *
 * Returns 0 — never a repair — when any operand is unavailable or non-finite:
 * a probe that cannot run is not a probe that agrees (TRA-2829).
 */
export function unrecordedAbsorbedOptionsCredit(args: {
  restoredEquity: number;
  restoredOptionsCredited: number;
  trackerOpeningEquity: number | null;
  journalDemoRealizedCumUsd: number | null;
}): number {
  const { restoredEquity, restoredOptionsCredited, trackerOpeningEquity, journalDemoRealizedCumUsd } = args;
  if (!Number.isFinite(restoredEquity) || !Number.isFinite(restoredOptionsCredited)) return 0;
  if (trackerOpeningEquity === null || !Number.isFinite(trackerOpeningEquity)) return 0;
  if (journalDemoRealizedCumUsd === null || !Number.isFinite(journalDemoRealizedCumUsd)) return 0;
  const journalSurplus = journalDemoRealizedCumUsd - restoredOptionsCredited;
  const windowSurplus = restoredEquity - trackerOpeningEquity;
  const adj = Math.min(journalSurplus, windowSurplus);
  if (!(adj > 0)) return 0;
  return Math.round(adj * 100) / 100;
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

/** TRA-2817 — recursive file count under `dir`. Directories are not counted. */
async function countFiles(dir: string): Promise<number> {
  let n = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.isDirectory()) n += await countFiles(join(dir, e.name));
    else n += 1;
  }
  return n;
}

/** TRA-2817 — the timestamped generations under `backups/`, oldest first. */
async function backupGenerations(): Promise<string[]> {
  try {
    return (await readdir(BACKUP_DIR)).filter(n => /^\d{4}-\d{2}-\d{2}T/.test(n)).sort();
  } catch {
    return [];
  }
}

/**
 * TRA-2817 — prune generations until BOTH bounds hold: at most `MAX_BACKUPS`
 * generations, and at most `backupMaxFiles()` inodes across the tree.
 *
 * Runs BEFORE the new generation is written, which is the half of this fix that
 * actually ends an incident rather than preventing the next one. The old order
 * was copy-then-prune, and under `ENOSPC` that is a stable deadlock: every
 * `copyFile` fails and is swallowed as a warn, the prune then finds exactly
 * `MAX_BACKUPS` generations and removes nothing, and the tree sits at its
 * high-water inode mark forever. Nothing in the loop can ever release the
 * inodes it needs to make progress. Pruning first needs no new inode — `rm`
 * only frees them — so the very first rotation after this deploys reclaims
 * space on a filesystem that is already full.
 *
 * Returns what it did so the caller can log a retention window that SHRANK,
 * which is the observable a "backups are fine, there are 24 of them" reading
 * cannot produce.
 */
async function pruneBackupsToBudget(): Promise<{
  removed: number;
  kept: number;
  filesPerGeneration: number | null;
  budgetGenerations: number;
}> {
  const entries = await backupGenerations();
  // Measure the per-generation cost off the NEWEST generations — they reflect
  // the current fleet, where the oldest may pre-date half the accounts — and
  // take the MAX of a small sample rather than the newest one alone.
  //
  // The sample is what makes this work during the incident it was written for.
  // The newest generation on a full filesystem is a PARTIAL one: `ensureDir`
  // and every `copyFile` inside it failed on ENOSPC, so it holds far fewer
  // files than a healthy generation. Measuring that one alone reports a tiny
  // per-generation cost, which inflates the budget into allowing MORE
  // generations, which prunes less — the estimator is biased in exactly the
  // direction that keeps the disk full. The max over three is conservative
  // (over-estimating cost only prunes harder, which is the safe error here) and
  // survives one truncated generation.
  const sample = entries.slice(-3);
  const counts: number[] = [];
  for (const gen of sample) counts.push(await countFiles(join(BACKUP_DIR, gen)));
  const filesPerGeneration = counts.length === 0 ? null : Math.max(...counts);
  const budgetGenerations = backupGenerationsWithinBudget(filesPerGeneration ?? 0);
  // Leave room for the generation about to be written, so the budget bounds the
  // tree at its PEAK rather than at the trough right after a prune.
  const keep = Math.max(1, budgetGenerations - 1);
  const excess = Math.max(0, entries.length - keep);
  let removed = 0;
  for (let i = 0; i < excess; i++) {
    try {
      await rm(join(BACKUP_DIR, entries[i]), { recursive: true, force: true });
      removed += 1;
    } catch (err: unknown) {
      log.warn('backup prune failed', {
        generation: entries[i],
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { removed, kept: entries.length - removed, filesPerGeneration, budgetGenerations };
}

/**
 * Snapshot every persisted file under DATA_DIR into a timestamped backup folder
 * and prune old folders. Backs up global files (users.json) at the root and
 * mirrors per-user trees under backups/<ts>/users/<username>/.
 *
 * If a primary file is wiped or corrupted, the next startup automatically
 * restores from the most recent backup.
 *
 * TRA-2817 — the prune runs FIRST and is bounded by an inode budget, not just a
 * generation count. See `backupMaxFiles` for why a generation count is not a
 * retention policy and how it took `/data` down for five days.
 */
export async function rotateBackups(): Promise<void> {
  // TRA-2817 — the prune runs before `ensureDir`, not just before the copies.
  // `mkdir` needs an inode too, so on a full filesystem `ensureDir` THROWS and
  // takes the whole function with it — which is how the old copy-then-prune
  // order managed to never reach its prune at all. `backupGenerations` answers
  // `[]` on a missing directory, so pruning first is safe on a first boot.
  const pruned = await pruneBackupsToBudget();
  if (pruned.removed > 0) {
    // Logged at warn, not info: a retention window that shrank is a capacity
    // signal, and the last time this tree's cost went unread it exhausted the
    // filesystem's inode table.
    log.warn('backup retention pruned to inode budget (TRA-2817)', {
      removed: pruned.removed,
      kept: pruned.kept,
      filesPerGeneration: pruned.filesPerGeneration,
      budgetGenerations: pruned.budgetGenerations,
      maxFiles: backupMaxFiles(),
    });
  }
  await ensureDir(BACKUP_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(BACKUP_DIR, stamp);
  await ensureDir(target);

  // Global files at the data-dir root.
  // TRA-2421 — `deleted-accounts.json` MUST be here. It is the record of which
  // identities were destroyed; if a DATA_DIR were ever rolled back from a backup
  // without it, every tombstone would vanish while the per-user trees came back,
  // and the username-recycling adoption bug would silently re-arm.
  const globalFiles = ['users.json', 'admin-reset-applied.json', DELETED_ACCOUNTS_FILENAME];
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

  // TRA-2817 — the prune moved to the TOP of this function. Pruning after the
  // copy cannot recover a filesystem that is already out of inodes, because the
  // copy it runs behind is the step that failed.
}

/**
 * Logs a clear warning when DATA_DIR is ephemeral (i.e. inside the package
 * bundle). On Render, DATA_DIR should point to the mounted persistent disk.
 */
export async function checkDataDirHealth(): Promise<void> {
  // TRA-1681 — shared with the durable ledgers, which now PUBLISH this verdict rather
  // than only logging it. Two copies of the predicate would drift, and the copy that
  // drifts is the one a grader is trusting.
  const isEphemeral = isEphemeralDataDir(DATA_DIR);

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
