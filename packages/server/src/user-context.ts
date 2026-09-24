import { mkdir, rename, copyFile, rm, writeFile, readdir, unlink, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';

import { assertContainedUserDir } from './username-grammar.js';
import {
  SignalEngine,
  shouldBootArmLiveEquity,
  applyLiveBrokerArm,
} from './signal-engine.js';
import type { LiveBrokerArmField } from './signal-engine.js';
import { PnlTracker } from './pnl-tracker.js';
import { isMarketDayIso } from './scheduler.js';
import type { RelativeValueScannerService } from './relative-value-scanner.js';
import {
  loadSettings,
  saveSettings,
  clearSettingsCache,
} from './account-settings.js';
import type { AccountSettings } from '@trading-app/shared';
import {
  initWatchlistStore,
  getStocksWatchlistData,
  clearWatchlistCache,
} from './watchlist-store.js';
import {
  loadStocksTradeSnapshot,
  saveStocksTradeSnapshot,
  // TRA-2629 — the single seam `PaperAccountSnapshot` crosses on the way to and
  // from disk. Both directions must go through these or a field added to the
  // in-memory snapshot silently stops persisting.
  toDurableAccountSnapshot,
  restoreDurableAccountSnapshot,
  unrecordedAbsorbedOptionsCredit,
} from './trade-store.js';
import { listOptionTradeJournal } from './option-trade-journal.js';
import { journalRowsForBook } from './options-daily-pnl-source.js';
import { accountDeletedAt } from './deleted-accounts.js';
import type { OptionsBucketSnapshot } from './trade-store.js';
import type { TradierEnv } from '@trading-app/shared';
import { getAllUsers } from './users.js';
import { noteEngineBornForHardControls } from './hard-controls-bridge.js'; // TRA-4650
import { scrubStaleOptionsPnlCells } from './reports/stale-cell-cleanup.js';
import {
  bookReportRoots,
  reclaimReportSidecars,
  reportSidecarMaxUnlinks,
} from './reports/report-sidecar-reclaim.js';
import { logger } from './observability/index.js';
import { resolveDataDir } from './data-dir.js';
// TRA-3407 (delivery of TRA-2892) — the WRITE axis. Every persist failure used
// to land in a `log.warn` and nowhere else; these three calls are the only
// producers the graded staleness verdict on `/api/health/snapshot-persist`
// counts. `recordPersistTick` is wired to the ENGINE tick, deliberately upstream
// of and blind to the write, so "quiet box" and "dead writer" stay separable.
import {
  recordPersistTick,
  recordPersistSuccess,
  recordPersistFailure,
  forgetPersistOutcomes,
} from './snapshot-persist-health.js';

const log = logger.child({ module: 'user-context' });

// ─────────────────────────────────────────────────────────────────────────────
// TRA-142 — per-user account isolation.
//
// Every user (admin and any non-admin signups) gets their own SignalEngine,
// PnlTracker, and persistence timers. State is rooted
// at DATA_DIR/users/<username>/ so settings, watchlist, trades, and equity
// history never collide across users.
//
// On first boot, `runFirstBootMigration` moves the legacy global files into
// the admin namespace so the existing single-tenant install is preserved.
// ─────────────────────────────────────────────────────────────────────────────

const DATA_DIR = resolveDataDir();
const PERSIST_DEBOUNCE_MS = 1000;

// TRA-1084 — boot-herd mitigation. Each per-user engine creates its OWN
// SignalEngine, and each `.start()` fires an immediate
// full-universe tick. With N demo books that is N engines sweeping the SAME
// watchlist ALIGNED at
// `server_available`, saturating the single libuv loop for >5s so `/api/health`
// can't answer inside Render's 5s budget → Render kills the box mid-warmup →
// restart-loop (the bqb1 502 root cause, TRA-1082 forensics). Staggering the
// boot tick by a per-engine step spreads that herd across the warmup so no
// single synchronous window blows the 5s budget; the staggered start also
// phase-offsets the steady-state 30s/60s intervals so they don't re-align into
// periodic tick storms. Tunable via env for ops; 0 disables the stagger.
const ENGINE_BOOT_STAGGER_MS = Math.max(0, Number(process.env.ENGINE_BOOT_STAGGER_MS ?? 1500) || 0);

export interface EngineStartStagger {
  /** Delay before the stocks SignalEngine fires its first tick. */
  engineDelayMs?: number;
}

export interface UserContext {
  username: string;
  /** Per-user data root: DATA_DIR/users/<username>. */
  dataDir: string;
  /** EOD reports for this user (stocks). */
  reportsDir: string;
  engine: SignalEngine;
  tracker: PnlTracker;
  /** Pending debounce timer for stocks trade-history persistence. */
  stocksPersistTimer: ReturnType<typeof setTimeout> | null;
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

/**
 * TRA-2649 — what the live-broker boot-arm actually DID for the pinned operator on
 * this boot. `null` ⇔ the arm never ran for an eligible operator this process, which
 * on a service where `/api/health/options-live` reports `bootArmEligible:true` means
 * the context was materialised without `createUserContext` (or has not been built yet).
 *
 * This exists because "the arm could not run", "the arm ran but could not persist",
 * and "the arm ran clean and something rewrote the operator afterwards" all produce
 * the SAME non-empty `bootArmDrift` on the health route. Telling them apart used to
 * require Render log access; TRA-2649 was diagnosed exactly that way, and the
 * distinguishing evidence (a request `traceId` on the demoting write, absent on the
 * boot write) is not something a probe can see.
 */
export interface LiveBrokerBootArmOutcome {
  username: string;
  /** ISO timestamp of the boot-arm evaluation for this operator. */
  ranAt: string;
  /** Fields the arm repaired this boot ([] ⇔ already converged — a healthy no-op). */
  repaired: LiveBrokerArmField[];
  /** Non-null ⇔ the force-persist threw; the engine is Live but disk is not. */
  persistError: string | null;
}

let bootArmOutcome: LiveBrokerBootArmOutcome | null = null;

export function getLiveBrokerBootArmOutcome(): LiveBrokerBootArmOutcome | null {
  return bootArmOutcome;
}

export function tryGetUserContext(username: string): UserContext | undefined {
  return contexts.get(username);
}

// TRA-4475 — the second place a raw username became a path. Same backstop as
// `orphaned-books.ts:userDirIn`: refuse at the join, on the shape of the RESULT,
// so a name that resolves outside `DATA_DIR/users/` can never name a context
// directory. Narrower than the signup grammar on purpose — legacy names that
// predate that grammar still resolve here, which is what keeps this off the
// login path's blast radius.
export function userDataDir(username: string): string {
  return assertContainedUserDir(DATA_DIR, username);
}

/**
 * Resolve a user context, creating it (and starting its engines) on demand.
 * Used by request handlers when a context wasn't built at boot (e.g. signup
 * provisioning failed, or initAllUserContexts skipped a user). For known-new
 * users the caller should prefer `initUserContext` so failures surface.
 */
export async function ensureUserContext(
  username: string,
  stagger?: EngineStartStagger,
): Promise<UserContext> {
  const existing = contexts.get(username);
  if (existing) return existing;
  const ctx = await createUserContext(username);
  // TRA-1084 — stagger the boot tick so N per-user engines don't sweep at once.
  ctx.engine.start({ initialDelayMs: stagger?.engineDelayMs });
  return ctx;
}

/**
 * Move the legacy single-tenant files into the admin user's namespace exactly
 * once. Idempotent: a marker file at DATA_DIR/.tra-142-migrated guards against
 * re-running. Files migrated:
 *   - account-settings.json, watchlist.json
 *   - trades-stocks.json
 *   - equity-state.json, daily-snapshots.json
 *   - reports/
 * Global files (users.json, admin-reset-applied.json, reset tokens, backups)
 * stay at the data-dir root.
 */
export async function runFirstBootMigration(adminUsername = 'admin'): Promise<void> {
  const markerFile = join(DATA_DIR, '.tra-142-migrated');
  if (existsSync(markerFile)) return;

  const adminDir = userDataDir(adminUsername);
  if (!existsSync(adminDir)) await mkdir(adminDir, { recursive: true });

  const fileMoves: Array<[string, string]> = [
    [join(DATA_DIR, 'account-settings.json'), join(adminDir, 'account-settings.json')],
    [join(DATA_DIR, 'watchlist.json'), join(adminDir, 'watchlist.json')],
    [join(DATA_DIR, 'trades-stocks.json'), join(adminDir, 'trades-stocks.json')],
    [join(DATA_DIR, 'equity-state.json'), join(adminDir, 'equity-state.json')],
    [join(DATA_DIR, 'daily-snapshots.json'), join(adminDir, 'daily-snapshots.json')],
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
 *   - `<userDir>/daily-snapshots.json`          (weekly/monthly/yearly P&L)
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
      for (const snapPath of [
        join(dir, 'daily-snapshots.json'),
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
 * TRA-1475 (Part 2) — one-shot scrub of pre-TRA-594 corrupted calendar cells.
 *
 * Before TRA-594 (~2026-06-09) the demo EOD report booked the mode's ALL-TIME
 * cumulative options P&L into every calendar cell instead of the day's realized
 * options P&L, so the same value froze across consecutive days (e.g. 158.28 on
 * 06-03/04/05, -44.00 on 05-22/24/26). TRA-594 fixed it forward but never
 * scrubbed the historical cells on disk. This deletes those leaked pre-cutoff
 * cell files (the board's "remove the old corrupted cells"); the pure detector +
 * fs scrub live in `reports/stale-cell-cleanup.ts`. Post-fix cells are never
 * read or touched. Idempotent via marker `DATA_DIR/.tra-1472-stale-cells-cleaned`
 * so it runs automatically on the next prod deploy.
 */
export async function runTra1472StaleCellCleanup(): Promise<void> {
  const markerFile = join(DATA_DIR, '.tra-1472-stale-cells-cleaned');
  if (existsSync(markerFile)) return;

  let userCount = 0;
  let cellCount = 0;
  for (const u of getAllUsers()) {
    try {
      const demoReportsDir = join(userDataDir(u.username), 'reports', 'demo');
      const removed = await scrubStaleOptionsPnlCells(demoReportsDir);
      if (removed.length > 0) {
        userCount += 1;
        cellCount += removed.length;
        log.info('migration TRA-1472: scrubbed stale cells for user', {
          migration: 'TRA-1472', username: u.username, dates: removed,
        });
      }
    } catch (err: unknown) {
      log.warn('migration TRA-1472: scrub failed for user', {
        migration: 'TRA-1472', username: u.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await writeFile(markerFile, new Date().toISOString(), 'utf-8');
  log.info('migration TRA-1472: complete — removed pre-TRA-594 stale cells.', {
    migration: 'TRA-1472', cellCount, userCount,
  });
}

/**
 * TRA-3064 — reclaim the write-only `<date>.md` report sidecars across every
 * book.
 *
 * `users/` was the #1 unbounded inode holder on bqb1's `/data` (55.0% of the
 * 23,070 used inodes, measured 2026-08-06), and 3,820 of those files were
 * verbatim copies of a `markdown` field already inside the sibling `.json`.
 * The write sites stopped emitting them in this same change; this releases the
 * ones already on disk.
 *
 * Deliberately NOT marker-gated, unlike TRA-241 / TRA-1472 above. A marker
 * would make this a historical event, and the bound has to survive a rollback
 * to a build that still writes sidecars. Idempotent, and one `readdir` per
 * report directory when there is nothing to do.
 *
 * Only deletes a `<name>.md` that has a `<name>.json` beside it, so every byte
 * it releases is still recoverable from `json.markdown`. See
 * `reports/report-sidecar-reclaim.ts` for why that gate is the whole design.
 */
export async function runTra3064SidecarReclaim(): Promise<void> {
  try {
    // Book directories come off the FILESYSTEM, not `getAllUsers()`. See
    // `bookReportRoots` — the registry-driven first cut left 3,017 of 4,259
    // sidecars behind, because `users/` holds ~251 book trees against 62
    // registered accounts and the inodes belong to the directory, not the
    // account.
    const roots = await bookReportRoots(join(DATA_DIR, 'users'));
    const result = await reclaimReportSidecars(roots, reportSidecarMaxUnlinks());
    if (result.removed > 0 || result.budgetExhausted) {
      log.info('TRA-3064: report sidecar reclaim complete', {
        ticket: 'TRA-3064',
        // Both numbers, deliberately. Their divergence is the reason this sweep
        // is filesystem-driven, and a run that reported only one of them would
        // hide it again.
        bookDirsOnDisk: roots.length / 2,
        registeredUsers: getAllUsers().length,
        removed: result.removed,
        orphansKept: result.orphansKept,
        errors: result.errors,
        budgetExhausted: result.budgetExhausted,
      });
    }
  } catch (err: unknown) {
    // A reclaim is housekeeping. It must never be the reason a boot fails.
    log.warn('TRA-3064: report sidecar reclaim failed', {
      ticket: 'TRA-3064',
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * TRA-301 — full demo fresh-start across every user. The board is rolling out
 * a new generation of strategies, so every user's persisted
 * demo P&L, trade history, and calendar history must be wiped before the
 * engines boot.
 *
 * Wider than TRA-241: that migration only touched daily-snapshots and the
 * (now legacy) unscoped `reports/` files. TRA-301 also clears
 *   - `equity-state.json`, so PnlTracker reseeds from the
 *     configured demoEquity instead of carrying yesterday's equity baseline,
 *   - `trades-stocks.json`, so engines start with no open/closed
 *     positions or recent signals,
 *   - `reports/` recursively, covering the TRA-244
 *     per-mode subfolders (`{demo,live,sandbox}/`) as well as legacy files.
 *
 * Idempotent via marker `.tra-301-demo-fresh-start`.
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
        join(dir, 'trades-stocks.json'),
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
// The Calendar tab used to share a single `<userDir>/reports/`
// regardless of which account the user was viewing
// (demo, live, sandbox). Users explicitly asked for per-mode history so the
// calendar shows only the rows that belong to the active account. Reports now
// live under `reports/{demo,live,sandbox}/...`.
// ─────────────────────────────────────────────────────────────────────────────

export type StockModeKey = 'demo' | 'live' | 'sandbox';

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

export function stockReportsDirFor(ctx: UserContext, mode: StockModeKey): string {
  return join(ctx.reportsDir, mode);
}

/**
 * One-shot per-user move of pre-TRA-244 calendar files into the `demo/`
 * subfolder. Demo was the only account the calendar ever wrote to under the
 * old layout, so legacy `reports/*.json|*.md`
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
  //
  // TRA-1652 — this block is a CONVERGENCE step, not a one-shot initializer. It used
  // to be latched behind `settings.mode !== 'live'`, so it only ever ran on the single
  // boot that first flipped the operator demo → live. That left the arm unable to
  // repair itself: once `mode:'live'` was persisted, a later drift of
  // `liveTradierEnvOptions` back to `'sandbox'` (a settings PUT omitting the field
  // defaults it to sandbox; a DATA_DIR restore predating TRA-1411 does the same) was
  // PERMANENT, because the only writer of `'production'` was gated off by the very
  // field it had already set. That is the TRA-1652 pre-open blocker QA caught on the
  // TRA-1578 mirror: `mode: live` + `optionsBrokerEnv: sandbox` + the SANDBOX account
  // tail `***6703` instead of the signed-off production `***0154`, which would have
  // routed the board's attended <=$100 options canary into the Tradier sandbox.
  // Re-deriving the drift set every boot means a plain redeploy always restores the
  // ratified arm. Scope is unchanged (operator pin + TRADIER_ENV=production +
  // resolvable prod creds, all inside `shouldBootArmLiveEquity`).
  // TRA-1411 — the repair also persists the production Tradier env so
  // `buildTradierLiveEquityClient` constructs the PRODUCTION order client (not sandbox);
  // that setting is only otherwise reachable via an admin-authed settings PUT, so forcing
  // it is what lets a plain `git push` actually configure the live-equity broker (board
  // approval 411c0c5a, previously inert as `liveEquityClientConfigured:false` / 62 signals
  // / 0 fills). TRA-1482 — and forces `liveTradeEquitiesTradier` ON, since
  // `buildTradierLiveEquityClient` gates on it independently and a persisted `false`
  // opt-out left the engine unarmed even in Live (the aabcfc8a regression: 132 skipped
  // live signals). Both stay inside the unchanged `shouldBootArmLiveEquity` scope.
  //
  // TRA-2649 — the three field writes moved into `applyLiveBrokerArm` so the settings
  // WRITE path can enforce the IDENTICAL repair. Boot-only convergence was not enough:
  // a post-boot `PUT /api/account/settings` carrying `mode:'demo'` silently demoted the
  // operator and the arm then stayed inert until the next redeploy. See
  // `applyLiveBrokerArm` for the Render-log evidence.
  const armEligible = shouldBootArmLiveEquity(settings, username);
  const armDrift = applyLiveBrokerArm(settings, username);
  // TRA-2649 — record the boot outcome so `/api/health/options-live` can distinguish
  // "the arm could not run / could not persist" from "the arm ran clean and something
  // rewrote the operator afterwards". Those two produce an IDENTICAL `bootArmDrift`,
  // and telling them apart previously required a Render log dig.
  if (armEligible) {
    bootArmOutcome = {
      username,
      ranAt: new Date().toISOString(),
      repaired: [...armDrift],
      persistError: null,
    };
  }
  if (armDrift.length > 0) {
    try {
      await saveSettings(username, settings);
      log.info('TRA-713/TRA-1411/TRA-1482/TRA-1652 boot-arm: converged production stocks engine onto the ratified live arm', {
        username,
        // TRA-1652 — which fields had DRIFTED and were repaired this boot. A
        // recurring `liveTradierEnvOptions` here means something is still writing
        // the operator back to sandbox between boots (look for a settings PUT).
        repaired: armDrift,
        mode: settings.mode,
        liveTradierEnvOptions: settings.liveTradierEnvOptions,
        liveTradeEquitiesTradier: settings.liveTradeEquitiesTradier,
      });
    } catch (err: unknown) {
      // TRA-2649 — ERROR, not warn. This is a REAL-MONEY arm silently failing to
      // become durable: the engine boots Live in memory but the persisted operator
      // stays demoted, so every settings-derived gate (including
      // `/api/health/options-live`'s `optionsBrokerConfigured`) reads disarmed while
      // the engine believes otherwise. A `warn` put that divergence in the same bucket
      // as routine feed noise, which is how it went unnoticed. Also surfaced on the
      // health route via `bootArmPersistError` so it is readable without log access.
      const reason = err instanceof Error ? err.message : String(err);
      log.error('TRA-713/TRA-2649 boot-arm: FAILED to persist the forced live arm (engine boots Live in-memory, persisted state stays demoted)', {
        username,
        repaired: armDrift,
        reason,
      });
      if (bootArmOutcome && bootArmOutcome.username === username) bootArmOutcome.persistError = reason;
    }
  }

  const tracker = new PnlTracker(
    dataDir,
    settings.mode === 'live' ? 0 : (settings.demoEquityStocks ?? settings.demoEquity),
    // TRA-4003 — the STOCKS tracker rolls its daily-P&L anchor on the exchange
    // calendar. Without this, a boot on a weekend/holiday followed by another
    // boot before the next 21:00 ET close re-anchored `openingEquity` off the
    // stale trade-path cache and the next row booked phantom stock P&L
    // (41 of 64 demo books, session 2026-08-24).
    { isMarketDay: isMarketDayIso },
  );

  const engine = new SignalEngine(settings, tracker, sharedRvScanner);
  // TRA-4650 — an engine born while the persisted fleet hard-kill latch is
  // engaged (or hard-controls state is unreadable) starts halted; the bridge
  // observer only fires on transitions and cannot reach a context that did
  // not exist yet.
  noteEngineBornForHardControls(engine);
  // TRA-563 — bind the owning user so engine alert hooks (fill/exit/signal/
  // risk-halt) resolve this user's notification preferences.
  engine.setAlertUsername(username);
  // TRA-3387 (child of TRA-3243) — restore today's session-scoped moveSuspect condemnations
  // before the engine starts ticking.
  //
  // ORDERING, both directions: after `setAlertUsername` so the restore log names its owner, and
  // BEFORE `engine.start()` (in `ensureUserContext` / `initUserContext`), which pre-seeds
  // `symbolState` with blank rows and would otherwise sit in front of the restored ones.
  //
  // Per-user `dataDir`, not the shared root: a condemnation belongs to the universe the owning
  // engine actually quotes, and one shared file would let one user's feed exclude another
  // user's row. Awaited and never fatal — the store reports how it failed, and the EOD census
  // grades that failure as BLIND rather than publishing a clean-looking empty exclusion list.
  await engine.hydrateMoveSuspectSession(dataDir);

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
      const restoredStocksAccount = restoreDurableAccountSnapshot(
        stocksSnap.account,
        stocksSnap.openPositions ?? [],
        tracker.getLastOptionsCreditedCumulative(),
      );
      // TRA-2847 — reseed the counter for credits the restored equity absorbed
      // that neither the durable counter nor any EOD row ever recorded (the
      // Defect B path `ec05639` does not cover; see
      // `unrecordedAbsorbedOptionsCredit`). Demo books only: the sink never
      // credits live P&L into `PaperAccount`, so a live book's counter has
      // nothing journal-vouched to recover. The journal read is best-effort —
      // an unreadable journal means no adjustment, never a crash, and the
      // restore then behaves byte-for-byte as before this fix.
      if (settings.mode !== 'live') {
        try {
          const demoRows = journalRowsForBook(
            await listOptionTradeJournal({ mode: 'demo' }),
            username,
            accountDeletedAt(username),
          );
          let journalDemoRealizedCumUsd = 0;
          for (const r of demoRows) {
            if (typeof r.closeTs !== 'number' || !Number.isFinite(r.closeTs)) continue;
            if (typeof r.realizedPnlUsd !== 'number' || !Number.isFinite(r.realizedPnlUsd)) continue;
            journalDemoRealizedCumUsd += r.realizedPnlUsd;
          }
          const reseed = unrecordedAbsorbedOptionsCredit({
            restoredEquity: restoredStocksAccount.equity,
            restoredOptionsCredited: restoredStocksAccount.optionsCredited ?? 0,
            trackerOpeningEquity: tracker.getOpeningEquity(),
            journalDemoRealizedCumUsd,
          });
          if (reseed > 0) {
            restoredStocksAccount.optionsCredited =
              (restoredStocksAccount.optionsCredited ?? 0) + reseed;
            log.warn('TRA-2847: reseeded optionsCredited for a credit equity absorbed but nothing recorded', {
              username,
              reseedUsd: reseed,
              restoredEquity: restoredStocksAccount.equity,
              trackerOpeningEquity: tracker.getOpeningEquity(),
              journalDemoRealizedCumUsd,
              durableCounter: stocksSnap.account.optionsCredited ?? null,
            });
          }
        } catch (err: unknown) {
          log.warn('TRA-2847: journal read for the counter reseed failed — restoring unadjusted', {
            username,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
      engine.importTradeSnapshot({
        closedPositions: stocksSnap.closedPositions ?? [],
        recentSignals: stocksSnap.recentSignals ?? [],
        // TRA-3688 S-3 — restore the void ledger so the witness survives a boot.
        sma200SignalVoids: stocksSnap.sma200SignalVoids ?? [],
        // TRA-4411 (AC6) — restore the gate-rejection ledger. `importTradeSnapshot`
        // also rebuilds the rejections' OWN debounce map from it, so dropping the
        // field here did not just lose the evidence: it let a name already
        // refused on bar t be refused again inside its 5-bar window, double-
        // counting the same setup in whatever cohort did survive.
        sma200GateRejections: stocksSnap.sma200GateRejections ?? [],
        dailySignals: stocksSnap.dailySignals ?? [],
        positionSignalType: stocksSnap.positionSignalType ?? [],
        // TRA-2629 — routed through the single durability seam in `trade-store`.
        // This used to be a hand-written literal, and rebuilding the account
        // field by field has now dropped a field twice: TRA-2301's `cashRepair`
        // (caught) and TRA-2323's `optionsCredited` (not caught — it reset to 0
        // on every boot while `equity` kept the credits it exists to cancel, so
        // the EOD writer re-added the previous session's option P&L into the
        // STOCK leg on 13 books / 18 sessions).
        //
        // The fallback is the last EOD row's cumulative, NOT 0: a pre-TRA-2629
        // snapshot has no stored value but its `equity` already contains the
        // historical credits, and the writer only ever uses the counter as a
        // delta against that same row. See `restoreDurableAccountSnapshot`.
        //
        // TRA-2847 — that fallback is exact only while SOME row recorded the
        // credit. A file whose equity absorbed a credit that no row and no
        // counter ever recorded restores poisoned, and the next written row
        // books the credit as stock; `restoredStocksAccount` above carries the
        // journal-bounded reseed that closes that state.
        account: restoredStocksAccount,
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
        // TRA-936 — restore the durable cumulative closed forward-test ledger so
        // the Stage-2 paper count survives the nightly archive and a redeploy.
        ...(stocksSnap.supertrendPaperClosed ? { supertrendPaperClosed: stocksSnap.supertrendPaperClosed } : {}),
        // TRA-3860 — restore the export's archive-boundary coverage floor.
        // Spread conditionally so an absent key stays absent rather than
        // arriving as an explicit `undefined`: both restore as null, but only
        // the absent form keeps the pre-TRA-3860 snapshot readable as one.
        ...(stocksSnap.lastArchivedAt != null ? { lastArchivedAt: stocksSnap.lastArchivedAt } : {}),
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

  // Restore watchlist into engines
  await initWatchlistStore(username);
  const savedStocks = getStocksWatchlistData(username);
  for (const sym of savedStocks.hidden) engine.removeSymbol(sym);
  for (const sym of savedStocks.added) engine.addSymbol(sym);

  // Restore auto-trading state — TRA-229 split per dashboard × per mode.
  engine.setAutoTrading(settings.stocksAutoTradingEnabledDemo ?? true, 'demo');
  engine.setAutoTrading(settings.stocksAutoTradingEnabledLive ?? true, 'live');

  const ctx: UserContext = {
    username,
    dataDir,
    reportsDir: join(dataDir, 'reports'),
    engine,
    tracker,
    stocksPersistTimer: null,
  };

  if (!existsSync(ctx.reportsDir)) await mkdir(ctx.reportsDir, { recursive: true });

  // TRA-244 — migrate legacy top-level report files into the demo/ subfolder
  // before the per-mode dirs are seeded. Idempotent via a per-user marker.
  const reportsMarker = join(dataDir, '.tra-244-reports-migrated');
  if (!existsSync(reportsMarker)) {
    try {
      const stockMoved = await migrateLegacyReports(ctx.reportsDir, reportsMarker);
      if (stockMoved > 0) {
        log.info('migration TRA-244: moved report files into demo/', {
          migration: 'TRA-244',
          username,
          stockMoved,
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

  // Wire up debounced trade-history persistence (TRA-140) per user.
  //
  // TRA-3407 — the tick observation is recorded HERE, in the same hook, and NOT
  // inside `persistStocksNow`. That placement is the point: it fires on every
  // tick whether or not the subsequent write throws, so it is an independent
  // liveness operand rather than a second reading of the persist outcome.
  engine.onTick(() => {
    recordPersistTick(ctx.username, 'stocks');
    scheduleStocksPersist(ctx);
  });

  contexts.set(username, ctx);

  // Initial persist so a fresh user has a snapshot on disk before any trades.
  await persistStocksNow(ctx);

  return ctx;
}

/**
 * Initialize a user context and start its engines. Used at boot for every
 * existing user, and immediately on signup so newly created users have a
 * ticking engine without waiting for their first request.
 */
export async function initUserContext(
  username: string,
  stagger?: EngineStartStagger,
): Promise<UserContext> {
  const ctx = await ensureUserContext(username, stagger);
  // `start()` is idempotent (TRA-1084): for a freshly-created context
  // ensureUserContext already armed the staggered boot; this call is a no-op
  // (it used to leak a second interval + boot tick). For a pre-existing context
  // it ensures the engines are ticking.
  ctx.engine.start({ initialDelayMs: stagger?.engineDelayMs });
  return ctx;
}

/** Stop engines and forget caches for a user (used on delete-user). */
export function destroyUserContext(username: string): void {
  const ctx = contexts.get(username);
  if (!ctx) return;
  if (ctx.stocksPersistTimer) clearTimeout(ctx.stocksPersistTimer);
  ctx.engine.stop();
  contexts.delete(username);
  clearSettingsCache(username);
  clearWatchlistCache(username);
  // TRA-3407 — drop the write-axis rows too. A deleted book stops ticking, so it
  // would grade IDLE rather than STALE, but leaving the record behind keeps a
  // dead username in the published per-context list forever.
  forgetPersistOutcomes(username);
}

function scheduleStocksPersist(ctx: UserContext): void {
  if (ctx.stocksPersistTimer) return;
  ctx.stocksPersistTimer = setTimeout(() => {
    ctx.stocksPersistTimer = null;
    void persistStocksNow(ctx);
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
      // TRA-3688 S-3 — persist the void ledger (removed AND recorded).
      sma200SignalVoids: snap.sma200SignalVoids,
      // TRA-4411 (AC6) — persist the gate-rejection ledger. It was shipped
      // "snapshot-persisted" on the strength of the engine's own
      // export/import pair, and that pair does carry it — but this literal is
      // the only writer that reaches disk, and it did not, so every rejection
      // died at the next boot and read back as `[]`: identical to "the gate
      // refused nothing". Graded by `tra4411-rejection-ledger-durability.test.ts`
      // against the WRITTEN object, not against `exportTradeSnapshot()`.
      sma200GateRejections: snap.sma200GateRejections,
      dailySignals: snap.dailySignals,
      positionSignalType: snap.positionSignalType,
      options: snap.options,
      // TRA-233 — persist both Tradier env buckets so a restart restores
      // sandbox and production state independently. The legacy single
      // `options` field remains so older readers can still parse the file.
      optionsByEnv: snap.optionsByEnv,
      // TRA-2629 — writer side of the same seam the boot restore reads through.
      // Was a hand-written literal; it dropped `cashRepair` (TRA-2301, caught)
      // and then `optionsCredited` (TRA-2323, not caught). One choke point means
      // a field added to `PaperAccountSnapshot` cannot be persisted by one side
      // and dropped by the other.
      account: toDurableAccountSnapshot(snap.account),
      // TRA-801 — persist the SupertrendConfluence paper forward-test book so a
      // redeploy doesn't abandon its open positions and stall Stage-2 accrual.
      supertrendPaper: snap.supertrendPaper,
      // TRA-936 — persist the durable cumulative closed forward-test ledger so
      // the Stage-2 paper count survives the nightly archive and a redeploy.
      supertrendPaperClosed: snap.supertrendPaperClosed,
      // TRA-3860 — persist the archive boundary. It is written once a day, so a
      // boundary that lived only in memory would fall back to process-start on
      // every redeploy and make `/api/trades/export` refuse ranges it could have
      // served several times a week.
      lastArchivedAt: snap.lastArchivedAt,
    });
    // TRA-3407 — AFTER the await resolves, never before. `saveStocksTradeSnapshot`
    // is an atomic write-then-rename; recording success on entry would book a
    // success for the ENOSPC that is about to be thrown by the write.
    recordPersistSuccess(ctx.username, 'stocks');
  } catch (err: unknown) {
    // TRA-3407 (delivery of TRA-2892) — this catch used to be the ENTIRE
    // consequence of a failed write. Five days of ENOSPC (2026-07-30T23:40:19Z →
    // the TRA-2817 prune at 2026-08-04T21:20Z) produced nothing but these lines.
    // The counter is what makes it gradeable; the log line stays because it is
    // what names the error in Render's log search.
    recordPersistFailure(ctx.username, 'stocks', err);
    log.warn('stocks persist failed', { username: ctx.username, reason: err instanceof Error ? err.message : String(err) });
  }
}

/** Bootstrap contexts for every existing user in users.json. */
export async function initAllUserContexts(): Promise<void> {
  const users = getAllUsers();
  // TRA-1084 — assign each user an incremental boot-tick delay so the N
  // engines don't all sweep the full universe simultaneously at
  // `server_available`. `await initUserContext` only blocks on the
  // synchronous context build (restore + persist); the boot tick itself is
  // deferred by the stagger, so the loop still finishes provisioning every
  // context promptly and the spread is applied to the *ticks*, not the loop.
  let idx = 0;
  for (const u of users) {
    const stagger: EngineStartStagger = ENGINE_BOOT_STAGGER_MS > 0
      ? {
        engineDelayMs: idx * ENGINE_BOOT_STAGGER_MS,
      }
      : {};
    try {
      await initUserContext(u.username, stagger);
    } catch (err: unknown) {
      log.warn('failed to init user context', { username: u.username, reason: err instanceof Error ? err.message : String(err) });
    }
    idx += 1;
  }
  if (ENGINE_BOOT_STAGGER_MS > 0 && users.length > 1) {
    log.info('TRA-1084 boot stagger applied', {
      users: users.length,
      stepMs: ENGINE_BOOT_STAGGER_MS,
      spanMs: (users.length - 1) * ENGINE_BOOT_STAGGER_MS,
    });
  }
}
