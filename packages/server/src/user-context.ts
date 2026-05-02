import { mkdir, rename, copyFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { SignalEngine } from './signal-engine.js';
import { CryptoSignalEngine } from './crypto-engine.js';
import { PnlTracker } from './pnl-tracker.js';
import type { RelativeValueScannerService } from './relative-value-scanner.js';
import {
  loadSettings,
  clearSettingsCache,
} from './account-settings.js';
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
import { getAllUsers } from './users.js';

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
      console.log(`[migration TRA-142] moved ${src} -> ${dst}`);
      migratedAny = true;
    } catch {
      // Cross-device rename can fail; fall back to copy + delete.
      try {
        await copyFile(src, dst);
        await rm(src, { force: true });
        console.log(`[migration TRA-142] copied ${src} -> ${dst} (rename failed)`);
        migratedAny = true;
      } catch (copyErr: unknown) {
        console.warn(`[migration TRA-142] failed to migrate ${src}: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`);
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
      console.log(`[migration TRA-142] moved ${legacy} -> ${target}`);
      migratedAny = true;
    } catch (err: unknown) {
      console.warn(`[migration TRA-142] failed to migrate ${legacy}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await writeFile(markerFile, new Date().toISOString(), 'utf-8');
  console.log(migratedAny
    ? '[migration TRA-142] complete — admin namespace populated.'
    : '[migration TRA-142] no legacy files to migrate (fresh install).');
}

async function createUserContext(username: string): Promise<UserContext> {
  const dataDir = userDataDir(username);
  if (!existsSync(dataDir)) await mkdir(dataDir, { recursive: true });
  const cryptoDir = join(dataDir, 'crypto');
  if (!existsSync(cryptoDir)) await mkdir(cryptoDir, { recursive: true });

  const settings = await loadSettings(username);

  const tracker = new PnlTracker(
    dataDir,
    settings.mode === 'live' ? 0 : (settings.demoEquityStocks ?? settings.demoEquity),
  );
  const cryptoTracker = new PnlTracker(
    cryptoDir,
    settings.mode === 'live' ? 0 : (settings.demoEquityCrypto ?? settings.demoEquity),
  );

  const engine = new SignalEngine(settings, tracker, sharedRvScanner);
  const cryptoEngine = new CryptoSignalEngine(cryptoTracker, settings);

  // Restore trade history (TRA-140)
  try {
    const stocksSnap = await loadStocksTradeSnapshot(username);
    if (stocksSnap) {
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
        options: {
          openOptions: stocksSnap.options.openOptions ?? [],
          closedOptions: stocksSnap.options.closedOptions ?? [],
          optionsPnl: stocksSnap.options.optionsPnl ?? 0,
          dailyCount: stocksSnap.options.dailyCount ?? 0,
          currentDayKey: stocksSnap.options.currentDayKey ?? new Date().toISOString().slice(0, 10),
          cash: stocksSnap.options.cash ?? stocksSnap.account.cash,
          equity: stocksSnap.options.equity ?? stocksSnap.account.equity,
        },
      });
      console.log(`[user-context:${username}] Restored stocks trade history: ${stocksSnap.openPositions?.length ?? 0} open, ${stocksSnap.closedPositions?.length ?? 0} closed.`);
    }
  } catch (err: unknown) {
    console.warn(`[user-context:${username}] Failed to restore stocks history: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const cryptoSnap = await loadCryptoTradeSnapshot(username);
    if (cryptoSnap) {
      cryptoEngine.importTradeSnapshot({
        closedPositions: cryptoSnap.closedPositions ?? [],
        recentSignals: cryptoSnap.recentSignals ?? [],
        account: {
          cash: cryptoSnap.account.cash,
          equity: cryptoSnap.account.equity,
          initialEquity: cryptoSnap.account.initialEquity,
          openingEquityToday: cryptoSnap.account.openingEquityToday,
          openPositions: cryptoSnap.openPositions ?? [],
        },
      });
      console.log(`[user-context:${username}] Restored crypto trade history: ${cryptoSnap.openPositions?.length ?? 0} open, ${cryptoSnap.closedPositions?.length ?? 0} closed.`);
    }
  } catch (err: unknown) {
    console.warn(`[user-context:${username}] Failed to restore crypto history: ${err instanceof Error ? err.message : String(err)}`);
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
  cryptoEngine.setAutoTrading(settings.cryptoAutoTradingEnabledLive ?? true, 'live');

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
      account: {
        cash: snap.account.cash,
        equity: snap.account.equity,
        initialEquity: snap.account.initialEquity,
        dailyPnl: snap.account.dailyPnl,
      },
    });
  } catch (err: unknown) {
    console.warn(`[user-context:${ctx.username}] stocks persist failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function persistCryptoNow(ctx: UserContext): Promise<void> {
  try {
    const snap = ctx.cryptoEngine.exportTradeSnapshot();
    await saveCryptoTradeSnapshot(ctx.username, {
      version: 1,
      savedAt: new Date().toISOString(),
      openPositions: snap.account.openPositions,
      closedPositions: snap.closedPositions,
      recentSignals: snap.recentSignals,
      account: {
        cash: snap.account.cash,
        equity: snap.account.equity,
        initialEquity: snap.account.initialEquity,
        openingEquityToday: snap.account.openingEquityToday,
      },
    });
  } catch (err: unknown) {
    console.warn(`[user-context:${ctx.username}] crypto persist failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Bootstrap contexts for every existing user in users.json. */
export async function initAllUserContexts(): Promise<void> {
  for (const u of getAllUsers()) {
    try {
      await initUserContext(u.username);
    } catch (err: unknown) {
      console.warn(`[user-context] failed to init ${u.username}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
