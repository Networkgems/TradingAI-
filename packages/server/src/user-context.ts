import { mkdir, rename, copyFile, rm, writeFile, readdir, unlink, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { SignalEngine, shouldBootArmLiveEquity } from './signal-engine.js';
import { CryptoSignalEngine } from './crypto-engine.js';
import { PnlTracker } from './pnl-tracker.js';
import type { RelativeValueScannerService } from './relative-value-scanner.js';
import {
  loadSettings,
  saveSettings,
  clearSettingsCache,
} from './account-settings.js';
import type { AccountSettings } from '@trading-app/shared';
import {
  initWatchlistStore,
  getCryptoWatchlistData,
  getStocksWatchlistData,
  clearWatchlistCache,
} from './watchlist-store.js';
import {
  loadStocksTradeSnapshot,
  loadCryptoTradeSnapshot,
  saveStocksTradeSnapshot,
  saveCryptoTradeSnapshot,
} from './trade-store.js';
import type { OptionsBucketSnapshot } from './trade-store.js';
import type { TradierEnv } from '@trading-app/shared';
import { getAllUsers } from './users.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'user-context' });

// ─────────────────────────────────────────────────────────────────────────────
// TRA-142 — per-user account isolation.
//
// Every user (admin and any non-admin signups) gets their own SignalEngine,
// CryptoSignalEngine, PnlTracker pair, and persistence timers. State is rooted
// at DATA_DIR/users/<username>/ so settings, watchlist, trades, and equity
// history never collide across users.
//
// On first boot, `runFirstBootMigration` moves the legacy global files into
// the admin namespace so the existing single-tenant install is preserved.
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? join(__dirname, '..', 'data');
const PERSIST_DEBOUNCE_MS = 1000;

export interface UserContext {
  username: string;
  /** Per-user data root: DATA_DIR/users/<username>. */
  dataDir: string;
  /** EOD reports for this user (stocks). */
  reportsDir: string;
  /** EOD reports for this user (crypto). */
  cryptoReportsDir: string;
  engine: SignalEngine;
  cryptoEngine: CryptoSignalEngine;
  tracker: PnlTracker;
  cryptoTracker: PnlTracker;
  /** Pending debounce timer for stocks trade-history persistence. */
  stocksPersistTimer: ReturnType<typeof setTimeout> | null;
  /** Pending debounce timer for crypto trade-history persistence. */
  cryptoPersistTimer: ReturnType<typeof setTimeout> | null;
}

const contexts = new Map<string, UserContext>();

// TRA-191 — server-wide relative-value scanner instance shared across all
// per-user SignalEngines. Set once at server boot via `setRvScanner` before
// any contexts are constructed; left undefined when Tradier creds are
// missing, in which case the engines run without options scanning.
let sharedRvScanner: RelativeValueScannerService | undefined;

export function setRvScanner(svc: RelativeValueScannerService | undefined): void {
  sharedRvScanner = svc;
}

export function getAllUserContexts(): UserContext[] {
  return Array.from(contexts.values());
}

export function tryGetUserContext(username: string): UserContext | undefined {
  return contexts.get(username);
}

export function userDataDir(username: string): string {
  return join(DATA_DIR, 'users', username);
}

/**
 * Resolve a user context, creating it (and starting its engines) on demand.
 * Used by request handlers when a context wasn't built at boot (e.g. signup
 * provisioning failed, or initAllUserContexts skipped a user). For known-new
 * users the caller should prefer `initUserContext` so failures surface.
 */
export async function ensureUserContext(username: string): Promise<UserContext> {
  const existing = contexts.get(username);
  if (existing) return existing;
  const ctx = await createUserContext(username);
  ctx.engine.start();
  ctx.cryptoEngine.start();
  return ctx;
}

/**
 * Move the legacy single-tenant files into the admin user's namespace exactly
 * once. Idempotent: a marker file at DATA_DIR/.tra-142-migrated guards against
 * re-running. Files migrated:
 *   - account-settings.json, watchlist.json
 *   - trades-stocks.json, trades-crypto.json
 *   - equity-state.json, daily-snapshots.json
 *   - crypto/equity-state.json, crypto/daily-snapshots.json
 *   - reports/, crypto-reports/
 * Global files (users.json, admin-reset-applied.json, reset tokens, backups)
 * stay at the data-dir root.
 */
export async function runFirstBootMigration(adminUsername = 'admin'): Promise<void> {
  const markerFile = join(DATA_DIR, '.tra-142-migrated');
  if (existsSync(markerFile)) return;

  const adminDir = userDataDir(adminUsername);
  if (!existsSync(adminDir)) await mkdir(adminDir, { recursive: true });
  await mkdir(join(adminDir, 'crypto'), { recursive: true });

  const fileMoves: Array<[string, string]> = [
    [join(DATA_DIR, 'account-settings.json'), join(adminDir, 'account-settings.json')],
    [join(DATA_DIR, 'watchlist.json'), join(adminDir, 'watchlist.json')],
    [join(DATA_DIR, 'trades-stocks.json'), join(adminDir, 'trades-stocks.json')],
    [join(DATA_DIR, 'trades-crypto.json'), join(adminDir, 'trades-crypto.json')],
    [join(DATA_DIR, 'equity-state.json'), join(adminDir, 'equity-state.json')],
    [join(DATA_DIR, 'daily-snapshots.json'), join(adminDir, 'daily-snapshots.json')],
    [join(DATA_DIR, 'crypto', 'equity-state.json'), join(adminDir, 'crypto', 'equity-state.json')],
    [join(DATA_DIR, 'crypto', 'daily-snapshots.json'), join(adminDir, 'crypto', 'daily-snapshots.json')],
  ];

  let migratedAny = false;
  for (const [src, dst] of fileMoves) {
    if (!existsSync(src)) continue;
    if (existsSync(dst)) continue; // never clobber an already-migrated file
    try {
      await mkdir(dirname(dst), { recursive: true });
      await rename(src, dst);
      log.info('migration TRA-142: moved file', { migration: 'TRA-142', src, dst });
      migratedAny = true;
    } catch {
      // Cross-device rename can fail; fall back to copy + delete.
      try {
        await copyFile(src, dst);
        await rm(src, { force: true });
        log.info('migration TRA-142: copied file (rename failed)', { migration: 'TRA-142', src, dst });
        migratedAny = true;
      } catch (copyErr: unknown) {
        log.warn('migration TRA-142: failed to migrate file', { migration: 'TRA-142', src, reason: copyErr instanceof Error ? copyErr.message : String(copyErr) });
      }
    }
  }

  // Move legacy reports directories into the admin namespace.
  for (const [legacy, target] of [
    [join(DATA_DIR, 'reports'), join(adminDir, 'reports')],
    [join(DATA_DIR, 'crypto-reports'), join(adminDir, 'crypto-reports')],
  ] as const) {
    if (!existsSync(legacy) || existsSync(target)) continue;
    try {
      await mkdir(dirname(target), { recursive: true });
      await rename(legacy, target);
      log.info('migration TRA-142: moved directory', { migration: 'TRA-142', src: legacy, dst: target });
      migratedAny = true;
    } catch (err: unknown) {
      log.warn('migration TRA-142: failed to migrate directory', { migration: 'TRA-142', src: legacy, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  await writeFile(markerFile, new Date().toISOString(), 'utf-8');
  log.info(migratedAny
    ? 'migration TRA-142: complete — admin namespace populated.'
    : 'migration TRA-142: no legacy files to migrate (fresh install).', { migration: 'TRA-142' });
}

/**
 * TRA-237 — one-shot options reset.
 *
 * The TRA-220-era paper-options state was attributed into the wrong env bucket
 * by the pre-fix `importTradeSnapshot()` (defaulted to the engine's *current*
 * `tradierEnv` when migrating legacy snapshots, so users who had switched to
 * production saw their old sandbox P&L surface in the Live Production header).
 * The routing fix only prevents *new* mis-routings; users whose snapshot was
 * already corrupted keep the leaked positions in their persisted production
 * bucket.
 *
 * This migration runs once on boot, walks every known user's stocks-trade
 * snapshot, and clears BOTH options env buckets back to a fresh state so the
 * dashboard starts clean. Equity stays untouched; cash for each empty bucket
 * is reseeded from the user's account equity. Idempotent via marker file at
 * `DATA_DIR/.tra-237-options-reset`.
 */
function makeEmptyOptionsBucket(env: TradierEnv | null, equity: number, today: string): OptionsBucketSnapshot {
  return {
    openOptions: [],
    closedOptions: [],
    optionsPnl: 0,
    dailyCount: 0,
    dailyOtmCount: 0,
    dailyRvCount: 0,
    currentDayKey: today,
    cash: equity,
    equity,
    tradierEnv: env,
  };
}

export async function runTra237OptionsReset(): Promise<void> {
  const markerFile = join(DATA_DIR, '.tra-237-options-reset');
  if (existsSync(markerFile)) return;

  const today = new Date().toISOString().slice(0, 10);
  let resetCount = 0;

  for (const u of getAllUsers()) {
    try {
      const snap = await loadStocksTradeSnapshot(u.username);
      if (!snap) continue;
      const equity = snap.account?.equity ?? 0;
      await saveStocksTradeSnapshot(u.username, {
        ...snap,
        options: makeEmptyOptionsBucket(null, equity, today),
        optionsByEnv: {
          sandbox: makeEmptyOptionsBucket('sandbox', equity, today),
          production: makeEmptyOptionsBucket('production', equity, today),
        },
      });
      resetCount += 1;
      log.info('migration TRA-237: reset options buckets for user', { migration: 'TRA-237', username: u.username });
    } catch (err: unknown) {
      log.warn('migration TRA-237: reset failed for user', { migration: 'TRA-237', username: u.username, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  await writeFile(markerFile, new Date().toISOString(), 'utf-8');
  log.info('migration TRA-237: complete — cleared options state.', { migration: 'TRA-237', resetCount });
}

/**
 * TRA-241 — one-shot P&L calendar wipe across every user.
 *
 * Companion to the daily-reset fix (commit `bf8d54e`): the dashboard now
 * resets `dailyPnl` correctly at the 9 PM ET archive, but the calendar grid
 * and cumulative stats card still carry the pre-fix EOD reports / daily
 * snapshots. The board asked us to "clear P&L calendars for all accounts —
 * we're starting fresh," so this migration removes the file-backed history
 * that feeds CalendarTab + PnlTracker.getCumulativeStats:
 *
 *   - `<userDir>/reports/*.{json,md}`           (stocks Calendar tab)
 *   - `<userDir>/crypto-reports/*.{json,md}`    (crypto Calendar tab)
 *   - `<userDir>/daily-snapshots.json`          (weekly/monthly/yearly P&L)
 *   - `<userDir>/crypto/daily-snapshots.json`   (crypto cumulative P&L)
 *
 * Today's calendar is shared across demo / live / sandbox views; per-account
 * scoping moves to TRA-244, so a single wipe per user covers every dashboard
 * view at this point. Idempotent via marker `.tra-241-calendar-cleared`.
 */
async function clearReportsDir(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.endsWith('.json') && !name.endsWith('.md')) continue;
    try {
      await unlink(join(dir, name));
      removed += 1;
    } catch {
      // file vanished mid-iteration; ignore
    }
  }
  return removed;
}

export async function runTra241CalendarReset(): Promise<void> {
  const markerFile = join(DATA_DIR, '.tra-241-calendar-cleared');
  if (existsSync(markerFile)) return;

  let userCount = 0;
  let fileCount = 0;

  for (const u of getAllUsers()) {
    const dir = userDataDir(u.username);
    if (!existsSync(dir)) continue;
    try {
      fileCount += await clearReportsDir(join(dir, 'reports'));
      fileCount += await clearReportsDir(join(dir, 'crypto-reports'));
      for (const snapPath of [
        join(dir, 'daily-snapshots.json'),
        join(dir, 'crypto', 'daily-snapshots.json'),
      ]) {
        if (!existsSync(snapPath)) continue;
        try {
          await unlink(snapPath);
          fileCount += 1;
        } catch (err: unknown) {
          log.warn('migration TRA-241: could not remove snapshot', { migration: 'TRA-241', path: snapPath, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      userCount += 1;
    } catch (err: unknown) {
      log.warn('migration TRA-241: reset failed for user', { migration: 'TRA-241', username: u.username, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  await writeFile(markerFile, new Date().toISOString(), 'utf-8');
  log.info('migration TRA-241: complete — cleared calendar files.', { migration: 'TRA-241', fileCount, userCount });
}

/**
 * TRA-301 — full demo fresh-start across every user. The board is rolling out
 * a new generation of stock and crypto strategies, so every user's persisted
 * demo P&L, trade history, and calendar history must be wiped before the
 * engines boot.
 *
 * Wider than TRA-241: that migration only touched daily-snapshots and the
 * (now legacy) unscoped `reports/` files. TRA-301 also clears
 *   - `equity-state.json` (stocks + crypto), so PnlTracker reseeds from the
 *     configured demoEquity instead of carrying yesterday's equity baseline,
 *   - `trades-{stocks,crypto}.json`, so engines start with no open/closed
 *     positions or recent signals,
 *   - `reports/` and `crypto-reports/` recursively, covering the TRA-244
 *     per-mode subfolders (`{demo,live,sandbox}/`) as well as legacy files.
 *
 * Crypto's live broker mirror is sourced from Coinbase on each sync, so the
 * `liveClosedPositions` array dropped here repopulates from the broker API
 * — wiping it carries no canonical-data loss. Idempotent via marker
 * `.tra-301-demo-fresh-start`.
 */
async function clearReportsTree(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const path = join(dir, name);
    let isDir = false;
    try {
      isDir = (await stat(path)).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      removed += await clearReportsTree(path);
      continue;
    }
    if (!name.endsWith('.json') && !name.endsWith('.md')) continue;
    try {
      await unlink(path);
      removed += 1;
    } catch {
      // file vanished mid-iteration; ignore
    }
  }
  return removed;
}

/**
 * TRA-330 — one-shot crypto-only equity reset. The demo crypto account drifted
 * into the billions in prod (cash $2.52B, sized cost $3.44B on a $25k-capped
 * account) because the short cash-flow path mis-tracked sells. The runtime
 * invariant in `crypto-account.ts` will catch any future drift, but the
 * already-corrupt persisted snapshots need to be cleared once so the engines
 * don't import the bad state on the next boot.
 *
 * Narrower than TRA-301: only crypto state (`crypto/equity-state.json`,
 * `crypto/daily-snapshots.json`, `trades-crypto.json`, `crypto-reports/`).
 * Stocks state is untouched. Idempotent via marker `.tra-330-crypto-reset`.
 */
export async function runTra330CryptoEquityReset(): Promise<void> {
  const markerFile = join(DATA_DIR, '.tra-330-crypto-reset');
  if (existsSync(markerFile)) return;

  let userCount = 0;
  let fileCount = 0;

  for (const u of getAllUsers()) {
    const dir = userDataDir(u.username);
    if (!existsSync(dir)) continue;
    try {
      for (const filePath of [
        join(dir, 'crypto', 'equity-state.json'),
        join(dir, 'crypto', 'daily-snapshots.json'),
        join(dir, 'trades-crypto.json'),
      ]) {
        if (!existsSync(filePath)) continue;
        try {
          await unlink(filePath);
          fileCount += 1;
        } catch (err: unknown) {
          log.warn('migration TRA-330: could not remove file', { migration: 'TRA-330', path: filePath, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      fileCount += await clearReportsTree(join(dir, 'crypto-reports'));
      userCount += 1;
    } catch (err: unknown) {
      log.warn('migration TRA-330: reset failed for user', { migration: 'TRA-330', username: u.username, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  await writeFile(markerFile, new Date().toISOString(), 'utf-8');
  log.info('migration TRA-330: complete — wiped crypto-state files.', { migration: 'TRA-330', fileCount, userCount });
}

/**
 * TRA-338 — surgical one-shot cleanup for the MEGA-USD phantom position
 * documented in TRA-337. Yahoo's `MEGA-USD` ticker resolves to a different
 * (delisted-2022) token and returned a frozen $4.05 quote that opened a paper
 * position whose true Coinbase price is around $0.12. Rather than realising
 * the bogus ~97% loss into trade history, we expunge the open position and
 * refund the recorded `entryPrice * quantity` to the paper cash balance, so
 * the next snapshot reflects a clean book.
 *
 * Behaviour:
 *  - Scans every user's `trades-crypto.json` for OPEN positions with
 *    `symbol === 'MEGA-USD'`. Closed positions are left alone (closing the
 *    record after the fact would only obscure the audit trail).
 *  - Per-user: refunds `entryPrice * quantity` to `account.cash` (the
 *    persisted USD balance), drops the position from `openPositions`, and
 *    writes the snapshot back atomically. `account.equity` is intentionally
 *    NOT recomputed here — the engine's next tick reconciles equity from
 *    cash + open-position MTM, so a one-shot adjustment of cash is enough
 *    and we avoid double-counting if another path also touches equity on
 *    boot.
 *  - Skips users with no open MEGA-USD entry, with a missing snapshot, or
 *    with a snapshot the JSON parser couldn't read.
 *  - Idempotent via marker file `.tra-338-mega-usd-cleanup`.
 *
 * Runs BEFORE `initAllUserContexts` so engines load the cleaned snapshot.
 * Sequenced AFTER `runTra330CryptoEquityReset` (which may wipe
 * `trades-crypto.json` outright) so a one-time stale-snapshot reset can't
 * undo this cleanup mid-flight.
 */
export async function runTra338MegaUsdCleanup(): Promise<void> {
  const markerFile = join(DATA_DIR, '.tra-338-mega-usd-cleanup');
  if (existsSync(markerFile)) return;

  const { readFile } = await import('fs/promises');
  let usersTouched = 0;
  let positionsRemoved = 0;
  let cashRefunded = 0;

  for (const u of getAllUsers()) {
    const file = join(userDataDir(u.username), 'trades-crypto.json');
    if (!existsSync(file)) continue;
    let snap: import('./trade-store.js').CryptoTradeSnapshot | null = null;
    try {
      const raw = await readFile(file, 'utf-8');
      if (!raw.trim()) continue;
      snap = JSON.parse(raw) as import('./trade-store.js').CryptoTradeSnapshot;
    } catch (err: unknown) {
      log.warn('migration TRA-338: could not parse snapshot', { migration: 'TRA-338', path: file, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!snap || !Array.isArray(snap.openPositions)) continue;

    const ghosts = snap.openPositions.filter(p => p.symbol === 'MEGA-USD');
    if (ghosts.length === 0) continue;

    let userRefund = 0;
    for (const p of ghosts) {
      const refund = (p.entryPrice ?? 0) * (p.quantity ?? 0);
      if (Number.isFinite(refund) && refund > 0) {
        userRefund += refund;
      }
      log.info('migration TRA-338: expunging phantom MEGA-USD position', {
        migration: 'TRA-338',
        username: u.username,
        positionId: p.id,
        quantity: p.quantity,
        entryPrice: p.entryPrice,
        refund,
      });
    }

    const nextOpen = snap.openPositions.filter(p => p.symbol !== 'MEGA-USD');
    const nextCash = (snap.account?.cash ?? 0) + userRefund;
    const nextSnap: import('./trade-store.js').CryptoTradeSnapshot = {
      ...snap,
      savedAt: new Date().toISOString(),
      openPositions: nextOpen,
      account: {
        ...snap.account,
        cash: nextCash,
      },
    };
    try {
      await saveCryptoTradeSnapshot(u.username, nextSnap);
      usersTouched += 1;
      positionsRemoved += ghosts.length;
      cashRefunded += userRefund;
    } catch (err: unknown) {
      log.warn('migration TRA-338: persist failed', { migration: 'TRA-338', username: u.username, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  await writeFile(markerFile, new Date().toISOString(), 'utf-8');
  log.info('migration TRA-338: complete — removed phantom MEGA-USD positions.', {
    migration: 'TRA-338',
    positionsRemoved,
    usersTouched,
    cashRefunded,
  });
}

export async function runTra301DemoFreshStart(): Promise<void> {
  const markerFile = join(DATA_DIR, '.tra-301-demo-fresh-start');
  if (existsSync(markerFile)) return;

  let userCount = 0;
  let fileCount = 0;

  for (const u of getAllUsers()) {
    const dir = userDataDir(u.username);
    if (!existsSync(dir)) continue;
    try {
      for (const filePath of [
        join(dir, 'daily-snapshots.json'),
        join(dir, 'equity-state.json'),
        join(dir, 'crypto', 'daily-snapshots.json'),
        join(dir, 'crypto', 'equity-state.json'),
        join(dir, 'trades-stocks.json'),
        join(dir, 'trades-crypto.json'),
      ]) {
        if (!existsSync(filePath)) continue;
        try {
          await unlink(filePath);
          fileCount += 1;
        } catch (err: unknown) {
          log.warn('migration TRA-301: could not remove file', { migration: 'TRA-301', path: filePath, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      fileCount += await clearReportsTree(join(dir, 'reports'));
      fileCount += await clearReportsTree(join(dir, 'crypto-reports'));
      userCount += 1;
    } catch (err: unknown) {
      log.warn('migration TRA-301: reset failed for user', { migration: 'TRA-301', username: u.username, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  await writeFile(markerFile, new Date().toISOString(), 'utf-8');
  log.info('migration TRA-301: complete — wiped demo-history files.', { migration: 'TRA-301', fileCount, userCount });
}

// ─────────────────────────────────────────────────────────────────────────────
// TRA-244 — per-account calendar buckets.
//
// The Calendar tab used to share a single `<userDir>/reports/` and
// `<userDir>/crypto-reports/` regardless of which account the user was viewing
// (demo, live, sandbox). Users explicitly asked for per-mode history so the
// calendar shows only the rows that belong to the active account. Reports now
// live under `reports/{demo,live,sandbox}/...` (stocks) and
// `crypto-reports/{demo,live}/...` (crypto).
// ─────────────────────────────────────────────────────────────────────────────

export type StockModeKey = 'demo' | 'live' | 'sandbox';
export type CryptoModeKey = 'demo' | 'live';

/**
 * Resolve the active stocks mode for a user from saved settings. In demo mode
 * the bucket is always `demo`. In live mode the bucket follows
 * `liveTradierEnvOptions` so the sandbox header (paper Tradier fills) and the
 * production header (real Tradier orders) keep separate calendar histories.
 */
export function stockModeKey(settings: AccountSettings): StockModeKey {
  if (settings.mode !== 'live') return 'demo';
  return settings.liveTradierEnvOptions === 'production' ? 'live' : 'sandbox';
}

/** Crypto only has demo (paper) vs live (Coinbase). */
export function cryptoModeKey(settings: AccountSettings): CryptoModeKey {
  return settings.mode === 'live' ? 'live' : 'demo';
}

export function stockReportsDirFor(ctx: UserContext, mode: StockModeKey): string {
  return join(ctx.reportsDir, mode);
}

export function cryptoReportsDirFor(ctx: UserContext, mode: CryptoModeKey): string {
  return join(ctx.cryptoReportsDir, mode);
}

/**
 * One-shot per-user move of pre-TRA-244 calendar files into the `demo/`
 * subfolder. Demo was the only account the calendar ever wrote to under the
 * old layout, so legacy `reports/*.json|*.md` and `crypto-reports/*.json|*.md`
 * files (including `latest.json` / `latest.md`) all belong in the demo bucket.
 *
 * Idempotent: a marker file `<userDir>/.tra-244-reports-migrated` short-
 * circuits a second run. Per-context (rather than a global migration) so
 * brand-new signups skip the work cleanly.
 */
async function migrateLegacyReports(reportsRoot: string, markerFile: string): Promise<number> {
  if (!existsSync(reportsRoot)) return 0;
  let entries: string[];
  try {
    entries = await readdir(reportsRoot);
  } catch {
    return 0;
  }
  const demoDir = join(reportsRoot, 'demo');
  let moved = 0;
  for (const name of entries) {
    if (!name.endsWith('.json') && !name.endsWith('.md')) continue;
    const src = join(reportsRoot, name);
    const dst = join(demoDir, name);
    if (existsSync(dst)) {
      // Already-migrated copy wins; drop the legacy file so future readdir
      // calls don't see both.
      try { await unlink(src); } catch { /* ignore */ }
      continue;
    }
    if (!existsSync(demoDir)) await mkdir(demoDir, { recursive: true });
    try {
      await rename(src, dst);
      moved += 1;
    } catch {
      try {
        await copyFile(src, dst);
        await rm(src, { force: true });
        moved += 1;
      } catch {
        // ignore — leaving the legacy file in place is safe; next boot retries.
      }
    }
  }
  await writeFile(markerFile, new Date().toISOString(), 'utf-8');
  return moved;
}

async function createUserContext(username: string): Promise<UserContext> {
  const dataDir = userDataDir(username);
  if (!existsSync(dataDir)) await mkdir(dataDir, { recursive: true });
  const cryptoDir = join(dataDir, 'crypto');
  if (!existsSync(cryptoDir)) await mkdir(cryptoDir, { recursive: true });

  const settings = await loadSettings(username);

  // TRA-713 — persistent live-equity boot-arm (scoped, default-OFF, board-ratified
  // approval 979c77c1). The original Live arm lived only in the running engine's
  // in-memory `mode` and was lost on the next redeploy; re-arm the single
  // operator-pinned production user deterministically at boot. `saveSettings`
  // persists `mode:"live"` so it is visible via GET /api/account/settings and the
  // engine/tracker below construct in Live from the same snapshot. No-op for every
  // non-pinned user, so the shared prod Tradier account can never be armed
  // fleet-wide. `loadSettings` returns the cached reference, so mutating + saving
  // keeps cache, disk, and engine in agreement.
  if (settings.mode !== 'live' && shouldBootArmLiveEquity(settings, username)) {
    settings.mode = 'live';
    try {
      await saveSettings(username, settings);
      log.info('TRA-713 boot-arm: forced production stocks engine to Live at boot', {
        username,
        liveTradierEnvOptions: settings.liveTradierEnvOptions,
      });
    } catch (err: unknown) {
      log.warn('TRA-713 boot-arm: failed to persist forced live mode (engine still boots Live in-memory)', {
        username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const tracker = new PnlTracker(
    dataDir,
    settings.mode === 'live' ? 0 : (settings.demoEquityStocks ?? settings.demoEquity),
  );
  const cryptoTracker = new PnlTracker(
    cryptoDir,
    settings.mode === 'live' ? 0 : (settings.demoEquityCrypto ?? settings.demoEquity),
  );

  const engine = new SignalEngine(settings, tracker, sharedRvScanner);
  // TRA-563 — bind the owning user so engine alert hooks (fill/exit/signal/
  // risk-halt) resolve this user's notification preferences.
  engine.setAlertUsername(username);
  const cryptoEngine = new CryptoSignalEngine(cryptoTracker, settings);

  // Restore trade history (TRA-140)
  try {
    const stocksSnap = await loadStocksTradeSnapshot(username);
    if (stocksSnap) {
      const today = new Date().toISOString().slice(0, 10);
      const fallbackBucket = (b: typeof stocksSnap.options | undefined) => ({
        openOptions: b?.openOptions ?? [],
        closedOptions: b?.closedOptions ?? [],
        optionsPnl: b?.optionsPnl ?? 0,
        // TRA-246 — pass per-mode buckets through when present so the demo
        // dashboard's options P&L survives a server restart without leaking
        // the live total.
        optionsPnlByMode: b?.optionsPnlByMode,
        dailyCount: b?.dailyCount ?? 0,
        dailyOtmCount: b?.dailyOtmCount ?? 0,
        dailyRvCount: b?.dailyRvCount ?? 0,
        currentDayKey: b?.currentDayKey ?? today,
        cash: b?.cash ?? stocksSnap.account.cash,
        equity: b?.equity ?? stocksSnap.account.equity,
        tradierEnv: b?.tradierEnv,
      });
      engine.importTradeSnapshot({
        closedPositions: stocksSnap.closedPositions ?? [],
        recentSignals: stocksSnap.recentSignals ?? [],
        dailySignals: stocksSnap.dailySignals ?? [],
        positionSignalType: stocksSnap.positionSignalType ?? [],
        account: {
          cash: stocksSnap.account.cash,
          equity: stocksSnap.account.equity,
          initialEquity: stocksSnap.account.initialEquity,
          dailyPnl: stocksSnap.account.dailyPnl,
          openPositions: stocksSnap.openPositions ?? [],
        },
        // TRA-233 — `options` stays for back-compat (legacy single-bucket
        // snapshots route through it). New snapshots include `optionsByEnv`
        // so both Tradier envs survive a restart.
        options: fallbackBucket(stocksSnap.options),
        ...(stocksSnap.optionsByEnv
          ? {
            optionsByEnv: {
              sandbox: fallbackBucket(stocksSnap.optionsByEnv.sandbox),
              production: fallbackBucket(stocksSnap.optionsByEnv.production),
            },
          }
          : {}),
        // TRA-801 — restore the SupertrendConfluence paper forward-test book
        // when present (absent on legacy snapshots → book starts empty).
        ...(stocksSnap.supertrendPaper ? { supertrendPaper: stocksSnap.supertrendPaper } : {}),
      });
      log.info('Restored stocks trade history', {
        username,
        open: stocksSnap.openPositions?.length ?? 0,
        closed: stocksSnap.closedPositions?.length ?? 0,
      });
    }
  } catch (err: unknown) {
    log.warn('Failed to restore stocks history', { username, reason: err instanceof Error ? err.message : String(err) });
  }

  try {
    const cryptoSnap = await loadCryptoTradeSnapshot(username);
    if (cryptoSnap) {
      cryptoEngine.importTradeSnapshot({
        // TRA-242 — prefer the split lists; fall back to the pre-TRA-242
        // merged `closedPositions` (treated as demo, since live history is
        // broker-owned and was effectively unavailable before this fix).
        closedPositions: cryptoSnap.closedPositions ?? [],
        demoClosedPositions: cryptoSnap.demoClosedPositions,
        liveClosedPositions: cryptoSnap.liveClosedPositions,
        recentSignals: cryptoSnap.recentSignals ?? [],
        account: {
          cash: cryptoSnap.account.cash,
          equity: cryptoSnap.account.equity,
          initialEquity: cryptoSnap.account.initialEquity,
          openingEquityToday: cryptoSnap.account.openingEquityToday,
          openPositions: cryptoSnap.openPositions ?? [],
        },
      });
      const demoCount = cryptoSnap.demoClosedPositions?.length ?? cryptoSnap.closedPositions?.length ?? 0;
      const liveCount = cryptoSnap.liveClosedPositions?.length ?? 0;
      log.info('Restored crypto trade history', {
        username,
        open: cryptoSnap.openPositions?.length ?? 0,
        demoClosed: demoCount,
        liveClosed: liveCount,
      });
    }
  } catch (err: unknown) {
    log.warn('Failed to restore crypto history', { username, reason: err instanceof Error ? err.message : String(err) });
  }

  // Restore watchlist into engines
  await initWatchlistStore(username);
  const savedCrypto = getCryptoWatchlistData(username);
  for (const sym of savedCrypto.hidden) cryptoEngine.removeSymbol(sym);
  for (const sym of savedCrypto.added) cryptoEngine.addSymbol(sym);
  const savedStocks = getStocksWatchlistData(username);
  for (const sym of savedStocks.hidden) engine.removeSymbol(sym);
  for (const sym of savedStocks.added) engine.addSymbol(sym);

  // Restore auto-trading state — TRA-229 split per dashboard × per mode.
  engine.setAutoTrading(settings.stocksAutoTradingEnabledDemo ?? true, 'demo');
  engine.setAutoTrading(settings.stocksAutoTradingEnabledLive ?? true, 'live');
  cryptoEngine.setAutoTrading(settings.cryptoAutoTradingEnabledDemo ?? true, 'demo');
  // TRA-575 — absent ↔ OFF for live crypto (matches the gate's strict `=== true`).
  cryptoEngine.setAutoTrading(settings.cryptoAutoTradingEnabledLive ?? false, 'live');

  const ctx: UserContext = {
    username,
    dataDir,
    reportsDir: join(dataDir, 'reports'),
    cryptoReportsDir: join(dataDir, 'crypto-reports'),
    engine,
    cryptoEngine,
    tracker,
    cryptoTracker,
    stocksPersistTimer: null,
    cryptoPersistTimer: null,
  };

  if (!existsSync(ctx.reportsDir)) await mkdir(ctx.reportsDir, { recursive: true });
  if (!existsSync(ctx.cryptoReportsDir)) await mkdir(ctx.cryptoReportsDir, { recursive: true });

  // TRA-244 — migrate legacy top-level report files into the demo/ subfolder
  // before the per-mode dirs are seeded. Idempotent via a per-user marker.
  const reportsMarker = join(dataDir, '.tra-244-reports-migrated');
  if (!existsSync(reportsMarker)) {
    try {
      const stockMoved = await migrateLegacyReports(ctx.reportsDir, reportsMarker);
      const cryptoMoved = await migrateLegacyReports(ctx.cryptoReportsDir, reportsMarker);
      if (stockMoved + cryptoMoved > 0) {
        log.info('migration TRA-244: moved report files into demo/', {
          migration: 'TRA-244',
          username,
          stockMoved,
          cryptoMoved,
        });
      }
    } catch (err: unknown) {
      log.warn('migration TRA-244: failed', { migration: 'TRA-244', username, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  // Pre-create the per-mode subfolders so writers/readers don't need to mkdir.
  for (const mode of ['demo', 'live', 'sandbox'] as const) {
    const dir = join(ctx.reportsDir, mode);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  }
  for (const mode of ['demo', 'live'] as const) {
    const dir = join(ctx.cryptoReportsDir, mode);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  }

  // Wire up debounced trade-history persistence (TRA-140) per user.
  engine.onTick(() => scheduleStocksPersist(ctx));
  cryptoEngine.onTick(() => scheduleCryptoPersist(ctx));

  contexts.set(username, ctx);

  // Initial persist so a fresh user has a snapshot on disk before any trades.
  await persistStocksNow(ctx);
  await persistCryptoNow(ctx);

  return ctx;
}

/**
 * Initialize a user context and start its engines. Used at boot for every
 * existing user, and immediately on signup so newly created users have a
 * ticking engine without waiting for their first request.
 */
export async function initUserContext(username: string): Promise<UserContext> {
  const ctx = await ensureUserContext(username);
  ctx.engine.start();
  ctx.cryptoEngine.start();
  return ctx;
}

/** Stop engines and forget caches for a user (used on delete-user). */
export function destroyUserContext(username: string): void {
  const ctx = contexts.get(username);
  if (!ctx) return;
  if (ctx.stocksPersistTimer) clearTimeout(ctx.stocksPersistTimer);
  if (ctx.cryptoPersistTimer) clearTimeout(ctx.cryptoPersistTimer);
  ctx.engine.stop();
  ctx.cryptoEngine.stop();
  contexts.delete(username);
  clearSettingsCache(username);
  clearWatchlistCache(username);
}

function scheduleStocksPersist(ctx: UserContext): void {
  if (ctx.stocksPersistTimer) return;
  ctx.stocksPersistTimer = setTimeout(() => {
    ctx.stocksPersistTimer = null;
    void persistStocksNow(ctx);
  }, PERSIST_DEBOUNCE_MS);
}

function scheduleCryptoPersist(ctx: UserContext): void {
  if (ctx.cryptoPersistTimer) return;
  ctx.cryptoPersistTimer = setTimeout(() => {
    ctx.cryptoPersistTimer = null;
    void persistCryptoNow(ctx);
  }, PERSIST_DEBOUNCE_MS);
}

export async function persistStocksNow(ctx: UserContext): Promise<void> {
  try {
    const snap = ctx.engine.exportTradeSnapshot();
    await saveStocksTradeSnapshot(ctx.username, {
      version: 1,
      savedAt: new Date().toISOString(),
      openPositions: snap.account.openPositions,
      closedPositions: snap.closedPositions,
      recentSignals: snap.recentSignals,
      dailySignals: snap.dailySignals,
      positionSignalType: snap.positionSignalType,
      options: snap.options,
      // TRA-233 — persist both Tradier env buckets so a restart restores
      // sandbox and production state independently. The legacy single
      // `options` field remains so older readers can still parse the file.
      optionsByEnv: snap.optionsByEnv,
      account: {
        cash: snap.account.cash,
        equity: snap.account.equity,
        initialEquity: snap.account.initialEquity,
        dailyPnl: snap.account.dailyPnl,
      },
      // TRA-801 — persist the SupertrendConfluence paper forward-test book so a
      // redeploy doesn't abandon its open positions and stall Stage-2 accrual.
      supertrendPaper: snap.supertrendPaper,
    });
  } catch (err: unknown) {
    log.warn('stocks persist failed', { username: ctx.username, reason: err instanceof Error ? err.message : String(err) });
  }
}

export async function persistCryptoNow(ctx: UserContext): Promise<void> {
  try {
    const snap = ctx.cryptoEngine.exportTradeSnapshot();
    await saveCryptoTradeSnapshot(ctx.username, {
      version: 1,
      savedAt: new Date().toISOString(),
      openPositions: snap.account.openPositions,
      // TRA-242 — keep the legacy `closedPositions` field populated with
      // the demo list so old readers see the same view they always have,
      // and persist the split lists alongside it for the new UI separation.
      closedPositions: snap.demoClosedPositions,
      demoClosedPositions: snap.demoClosedPositions,
      liveClosedPositions: snap.liveClosedPositions,
      recentSignals: snap.recentSignals,
      account: {
        cash: snap.account.cash,
        equity: snap.account.equity,
        initialEquity: snap.account.initialEquity,
        openingEquityToday: snap.account.openingEquityToday,
      },
    });
  } catch (err: unknown) {
    log.warn('crypto persist failed', { username: ctx.username, reason: err instanceof Error ? err.message : String(err) });
  }
}

/** Bootstrap contexts for every existing user in users.json. */
export async function initAllUserContexts(): Promise<void> {
  for (const u of getAllUsers()) {
    try {
      await initUserContext(u.username);
    } catch (err: unknown) {
      log.warn('failed to init user context', { username: u.username, reason: err instanceof Error ? err.message : String(err) });
    }
  }
}
