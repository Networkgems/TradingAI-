import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { writeFile, readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MarketScheduler, isMarketDay } from './scheduler.js';
import { generateEodReport } from './reports/eod-report.js';
import { generateCryptoEodReport } from './reports/crypto-eod-report.js';
import { createToken, verifyToken, generateResetToken, consumeResetToken, initResetTokenStore } from './auth.js';
import { getSettings, mergeScopedRiskSettings, saveSettings } from './account-settings.js';
import {
  initWatchlistStore,
  getCryptoWatchlistData,
  getStocksWatchlistData,
  addCryptoSymbol,
  removeCryptoSymbol,
  addStocksSymbol,
  removeStocksSymbol,
} from './watchlist-store.js';
import { scanStocksMarket, scanCryptoMarket } from './market-scanner.js';
import {
  loadUsers,
  validateUserCredentials,
  changeUserPassword,
  getUserByEmail,
  getUser,
  getAllUsers,
  createUser,
  updateUser,
  deleteUser,
  isUserLocked,
  setUserLocked,
} from './users.js';
import { sendPasswordResetEmail } from './email.js';
import { rotateBackups, checkDataDirHealth } from './trade-store.js';
import { TradierRelativeValueScannerService } from './relative-value-scanner.js';
import { CoinbaseOrderClient, tradierBaseUrl, TradierOptionsClient } from '@trading-app/engine';
import type { TradierEnv } from '@trading-app/shared';
import { fetchQuotes } from './yahoo-feed.js';
import {
  runFirstBootMigration,
  runTra237OptionsReset,
  runTra241CalendarReset,
  runTra301DemoFreshStart,
  runTra330CryptoEquityReset,
  runTra338MegaUsdCleanup,
  initAllUserContexts,
  initUserContext,
  ensureUserContext,
  destroyUserContext,
  getAllUserContexts,
  tryGetUserContext,
  persistStocksNow,
  persistCryptoNow,
  setRvScanner,
  stockModeKey,
  cryptoModeKey,
  stockReportsDirFor,
  cryptoReportsDirFor,
  type StockModeKey,
  type CryptoModeKey,
  type UserContext,
} from './user-context.js';
import {
  resolveTradierOptionsCreds,
  STRATEGY_PRESETS,
  DEFAULT_STRATEGY_PRESET_ID,
  type AccountSettings,
  type NewsItem,
  type ResearchReport,
  type StrategyPresetId,
} from '@trading-app/shared';
import {
  saveResearchReport,
  listResearchReports,
  getResearchReport,
  seedSampleResearchReportIfEmpty,
  ResearchValidationError,
} from './research-store.js';

const PORT = Number(process.env.PORT ?? 4242);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? join(__dirname, '..', 'data');

// TRA-140 — log DATA_DIR and warn loudly if it's ephemeral.
await checkDataDirHealth();

// Load users and reset tokens from persistent storage.
await loadUsers();
initResetTokenStore(DATA_DIR);

// TRA-191 — server-side relative-value scanner. The only options strategy
// active for stock options in this iteration; OTM mispricing and per-equity
// ATM auto-open are disabled. Wired into user-context BEFORE any contexts
// are constructed so every per-user SignalEngine sees the same scanner
// instance and shares the 60s chain cache + 1h breaker. Uses Yahoo's
// existing quote pipeline as the spot source so we don't pay for Tradier
// quotes too.
//
// Credentials resolution by `TRADIER_ENV`:
//   • `production` → TRADIER_API_TOKEN + TRADIER_ACCOUNT_ID
//   • `sandbox` (default) → TRADIER_SANDBOX_API_TOKEN + TRADIER_SANDBOX_ACCOUNT_ID,
//     falling back to the unprefixed pair when the sandbox-specific ones
//     are missing (so legacy single-pair setups still work).
// Reports `no_credentials` when the resolved pair is empty — the engine
// then simply skips options scanning, equity trading is unaffected.
const tradierEnv = (process.env['TRADIER_ENV'] as 'sandbox' | 'production') ?? 'sandbox';
const tradierApiToken = tradierEnv === 'production'
  ? process.env['TRADIER_API_TOKEN']
  : (process.env['TRADIER_SANDBOX_API_TOKEN'] ?? process.env['TRADIER_API_TOKEN']);
const tradierAccountId = tradierEnv === 'production'
  ? process.env['TRADIER_ACCOUNT_ID']
  : (process.env['TRADIER_SANDBOX_ACCOUNT_ID'] ?? process.env['TRADIER_ACCOUNT_ID']);

const relativeValueScannerService = new TradierRelativeValueScannerService({
  tradierApiToken,
  tradierAccountId,
  tradierEnv,
  fetchSpot: async (symbol) => {
    const quotes = await fetchQuotes([symbol]);
    const q = quotes.get(symbol);
    return q && q.price > 0 ? q.price : null;
  },
});
setRvScanner(
  relativeValueScannerService.diagnostics().configured ? relativeValueScannerService : undefined,
);
console.log(
  `[rv-scanner] env=${tradierEnv} configured=${relativeValueScannerService.diagnostics().configured}`,
);

// TRA-142 — migrate legacy global files into the admin namespace exactly once,
// then bootstrap per-user contexts (engines, trackers, persistence timers) for
// every known user. New signups get their context created on demand.
await runFirstBootMigration('admin');
// TRA-237 — one-shot cleanup of options buckets corrupted by the pre-fix
// importTradeSnapshot() routing. Runs before context bootstrap so engines
// load from the cleared snapshot. Idempotent via marker file.
await runTra237OptionsReset();
// TRA-241 — paired with the 9 PM dailyPnl reset fix: the board asked for a
// fresh P&L calendar across every account so the historical view starts
// clean. Wipes per-user EOD reports + daily-snapshots before PnlTracker
// reads them on first construction. Idempotent via marker file.
await runTra241CalendarReset();
// TRA-301 — full demo fresh-start: with the new strategy generation rolling
// out for both Stocks and Crypto, the board asked to wipe every user's
// persisted demo P&L, equity baselines, trade history, and calendar reports
// so the dashboards open clean on the new strategies. Runs before context
// bootstrap so engines load empty. Idempotent via marker file.
await runTra301DemoFreshStart();
// TRA-330 — one-shot crypto equity reset: prod demo crypto accounts drifted
// into the billions because of a short cash-flow accounting bug. The bug
// itself is fixed in crypto-account.ts; this migration clears the persisted
// snapshots that already loaded the bad state. Crypto-only, idempotent.
await runTra330CryptoEquityReset();
// TRA-338 — surgical removal of the phantom MEGA-USD paper position opened
// off Yahoo's frozen $4.05 ghost ticker (root cause in TRA-337). Refunds the
// recorded cost basis to cash and drops the position before the engine boots
// off the cleaned snapshot. Runs after TRA-330 so the equity reset (which
// may itself wipe trades-crypto.json) doesn't undo the cleanup mid-flight.
// Idempotent via marker file.
await runTra338MegaUsdCleanup();
await initAllUserContexts();

// TRA-227 — drop a placeholder QuantTrader research report so the Stocks
// News tab has visible "Research" content the first time the server boots.
// No-op once the store has at least one report, so real reports posted via
// `/api/research/reports` aren't shadowed.
await seedSampleResearchReportIfEmpty();

const app = express();

// ── CORS ─────────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});
app.use(express.json());

// ── Auth middleware ───────────────────────────────────────────────────────────

function firstHeader(val: string | string[] | undefined): string | undefined {
  return Array.isArray(val) ? val[0] : val;
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const header = firstHeader(req.headers.authorization);
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const user = verifyToken(header.slice(7));
  if (!user) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  res.locals['authUser'] = user;
  next();
}

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const username = res.locals['authUser'] as string;
  const user = getUser(username);
  if (!user || user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

/**
 * Resolve the per-user context for the authenticated user. Falls back to
 * lazily creating one if it isn't present (defensive — initAllUserContexts
 * should have built it at boot, and signup builds it on creation). When a
 * brand-new context is built here, also attach WS broadcast handlers so the
 * user's clients receive engine ticks.
 */
async function userCtx(res: express.Response): Promise<UserContext> {
  const username = res.locals['authUser'] as string;
  const wasNew = !tryGetUserContext(username);
  const ctx = await ensureUserContext(username);
  if (wasNew) attachBroadcastHandlers(ctx);
  return ctx;
}

// ── EOD Report generation ────────────────────────────────────────────────────

async function generateAndSaveReport(ctx: UserContext): Promise<void> {
  const snapshot = ctx.engine.getReportSnapshot();
  const report = generateEodReport(snapshot);
  // TRA-244 — write under the active stocks bucket (demo / live / sandbox)
  // so the per-account calendar shows only the rows that belong to it.
  const mode = stockModeKey(getSettings(ctx.username));
  const targetDir = stockReportsDirFor(ctx, mode);
  const datePath = join(targetDir, `${report.date}.json`);
  const mdPath = join(targetDir, `${report.date}.md`);
  const latestJsonPath = join(targetDir, 'latest.json');
  const latestMdPath = join(targetDir, 'latest.md');

  await Promise.all([
    writeFile(datePath, JSON.stringify(report, null, 2), 'utf-8'),
    writeFile(mdPath, report.markdown, 'utf-8'),
    writeFile(latestJsonPath, JSON.stringify(report, null, 2), 'utf-8'),
    writeFile(latestMdPath, report.markdown, 'utf-8'),
  ]);

  // Persist daily equity snapshot for cumulative tracking.
  const equitySnap = ctx.engine.getEquitySnapshot();
  ctx.tracker.saveSnapshot({
    date: report.date,
    openingEquity: ctx.tracker.getOpeningEquity(),
    closingEquity: equitySnap.equity,
    dailyPnl: equitySnap.equity - ctx.tracker.getOpeningEquity(),
    optionsPnl: equitySnap.optionsPnl,
    combinedPnl: (equitySnap.equity - ctx.tracker.getOpeningEquity()) + equitySnap.optionsPnl,
    trades: snapshot.allClosedPositions.length,
  });

  console.log(`[reports:${ctx.username}] EOD report saved → ${datePath}`);

  const msg = JSON.stringify({ type: 'eod_report', payload: report });
  broadcastToUser(ctx.username, msg);
}

async function generateAndSaveCryptoReport(ctx: UserContext): Promise<void> {
  // TRA-244 — same per-mode bucketing as the stocks generator above; crypto
  // only has demo vs live (no sandbox) since Coinbase has no paper sandbox.
  // TRA-245 — pass the mode into getReportSnapshot so the Live folder gets
  // Live (Coinbase) data and the Demo folder gets Demo paper-account data;
  // pre-fix the snapshot was always Demo even when written under live/.
  const mode = cryptoModeKey(getSettings(ctx.username));
  const snapshot = ctx.cryptoEngine.getReportSnapshot(mode);
  const report = generateCryptoEodReport(snapshot);
  const targetDir = cryptoReportsDirFor(ctx, mode);
  const datePath = join(targetDir, `${report.date}.json`);
  const mdPath = join(targetDir, `${report.date}.md`);
  const latestJsonPath = join(targetDir, 'latest.json');
  const latestMdPath = join(targetDir, 'latest.md');

  await Promise.all([
    writeFile(datePath, JSON.stringify(report, null, 2), 'utf-8'),
    writeFile(mdPath, report.markdown, 'utf-8'),
    writeFile(latestJsonPath, JSON.stringify(report, null, 2), 'utf-8'),
    writeFile(latestMdPath, report.markdown, 'utf-8'),
  ]);

  // TRA-193 — persist the day's equity snapshot so the crypto P&L calendar and
  // cumulative stats see this row, mirroring the stocks flow above.
  // TRA-245 — only write to cryptoTracker in demo mode. The tracker is shared
  // across both crypto modes, and saveSnapshot rebases the demo dashboard's
  // openingEquity to the snapshot's closingEquity. Writing a live-equity row
  // here would corrupt that baseline (e.g. a $0 live equity from missing
  // Coinbase creds would make the demo dashboard report a phantom -$25k
  // dailyPnl after a restart). Live equity history lives in the per-mode
  // crypto-reports/live/ files and longer-term in Coinbase's account history.
  if (mode === 'demo') {
    const closingEquity = snapshot.accountState.totalEquity;
    const openingEquity = ctx.cryptoTracker.getOpeningEquity();
    ctx.cryptoTracker.saveSnapshot({
      date: report.date,
      openingEquity,
      closingEquity,
      dailyPnl: closingEquity - openingEquity,
      optionsPnl: 0,
      combinedPnl: closingEquity - openingEquity,
      trades: snapshot.allClosedPositions.length,
    });
  }

  console.log(`[crypto-reports:${ctx.username}] EOD report saved → ${datePath}`);

  const msg = JSON.stringify({ type: 'crypto_eod_report', payload: report });
  broadcastToUser(ctx.username, msg);
}

// TRA-244 — Single 9 PM ET close-out for every user. Order is load-bearing:
//   1. Generate today's EOD reports + persist the equity snapshot for the
//      Calendar. We do this BEFORE resetting dailyPnl so the report's combined
//      P&L still reflects the day. Stocks only on market days; crypto every
//      day (24/7).
//   2. Reset the in-memory `dailyPnl` baseline on both engines so the next
//      tick broadcasts a fresh 0 for the new trading day. The persisted
//      tracker.openingEquity is realigned in lock-step.
//   3. Archive the rolling "Recent Closed" lists so the Positions/Options
//      tabs start the next session blank.
//   4. Persist + broadcast so connected clients see the reset immediately.
// TRA-249-D — top-of-hour fan-out: every active user's crypto engine gets
// one funding-accrual pass per ET hour. Demo and uninitialised-broker
// engines short-circuit inside `tickFundingHourly`, so this is essentially
// free unless the user is running live perps. Failures per-user are
// isolated so one user's outage can't starve the rest of the fleet.
async function runHourlyFundingForAllUsers(): Promise<void> {
  for (const ctx of getAllUserContexts()) {
    try {
      await ctx.cryptoEngine.tickFundingHourly();
    } catch (err) {
      console.error(`[funding:${ctx.username}] hourly tick failed:`, err);
    }
  }
}

async function runDailyCloseForAllUsers(): Promise<void> {
  const stocksMarketDay = isMarketDay();
  for (const ctx of getAllUserContexts()) {
    try {
      // 1a. Stocks EOD — only on trading days (Mon–Fri, non-holiday).
      if (stocksMarketDay) {
        try {
          await generateAndSaveReport(ctx);
        } catch (err) {
          console.error(`[reports:${ctx.username}] EOD report failed:`, err);
        }
      }
      // 1b. Crypto EOD — every calendar day (24/7 market).
      try {
        await generateAndSaveCryptoReport(ctx);
      } catch (err) {
        console.error(`[crypto-reports:${ctx.username}] EOD report failed:`, err);
      }

      // 2. Reset dashboard daily-P&L baselines for the new trading day.
      ctx.engine.resetDailyPnl();
      ctx.cryptoEngine.resetDailyPnl();

      // 3. Archive closed trades.
      const stocks = ctx.engine.archiveClosedTrades();
      const crypto = ctx.cryptoEngine.archiveClosedTrades();

      // 4. Persist + broadcast.
      await Promise.all([persistStocksNow(ctx), persistCryptoNow(ctx)]);
      broadcastEngineState(ctx);
      broadcastCryptoState(ctx);
      console.log(
        `[archive:${ctx.username}] reset dailyPnl, archived ${stocks.positions} closed positions, ${stocks.options} closed options, ${crypto} closed crypto positions`,
      );
    } catch (err) {
      console.error(`[archive:${ctx.username}] archive failed:`, err);
    }
  }
}

// ── REST endpoints ───────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// TRA-191 — surface live relative-value scan output. Read-only, gated by auth.
// Returns up to `limit` ranked candidates and the diagnostics block so QA can
// see whether the breaker is open / cache is warm without needing server logs.
app.get('/api/options/relative-value', requireAuth, async (req, res) => {
  const symbol = typeof req.query['symbol'] === 'string' ? req.query['symbol'] : '';
  if (!symbol) {
    res.status(400).json({ error: 'symbol query parameter is required' });
    return;
  }
  const limit = Math.max(1, Math.min(50, Number(req.query['limit'] ?? 10)));
  const zRaw = req.query['minZ'];
  const minZ = typeof zRaw === 'string' && zRaw.length > 0 ? Number(zRaw) : undefined;

  const result = await relativeValueScannerService.scan(symbol, {
    zScoreThreshold: Number.isFinite(minZ) ? Number(minZ) : undefined,
  });
  res.json({
    ...result,
    candidates: result.candidates.slice(0, limit),
    diagnostics: relativeValueScannerService.diagnostics(),
  });
});

app.get('/api/health/options-mispricing', (_req, res) => {
  res.json(relativeValueScannerService.diagnostics());
});

// TRA-141 — storage diagnostic so QA can verify from outside the box that the
// Render persistent disk is actually mounted and that user/settings/trade files
// are surviving redeploys. No PII is exposed (only paths, sizes, mtimes, count).
app.get('/api/health/storage', async (_req, res) => {
  async function statFile(p: string): Promise<{ exists: boolean; size?: number; mtime?: string }> {
    try {
      const s = await stat(p);
      return { exists: true, size: s.size, mtime: s.mtime.toISOString() };
    } catch {
      return { exists: false };
    }
  }
  const usersFile = join(DATA_DIR, 'users.json');
  const backupsDir = join(DATA_DIR, 'backups');
  // TRA-142 — per-user files now live under DATA_DIR/users/<username>/. The
  // legacy DATA_DIR/account-settings.json etc. are migrated into the admin
  // namespace on first boot, so we report admin's path so QA sees the
  // post-migration location while the legacy fields show migration ran.
  const legacySettingsFile = join(DATA_DIR, 'account-settings.json');
  const legacyTradesStocksFile = join(DATA_DIR, 'trades-stocks.json');
  const legacyTradesCryptoFile = join(DATA_DIR, 'trades-crypto.json');
  const adminDir = join(DATA_DIR, 'users', 'admin');
  const adminSettingsFile = join(adminDir, 'account-settings.json');
  const adminTradesStocksFile = join(adminDir, 'trades-stocks.json');
  const adminTradesCryptoFile = join(adminDir, 'trades-crypto.json');
  const migrationMarker = join(DATA_DIR, '.tra-142-migrated');
  let backupsCount = 0;
  try {
    backupsCount = (await readdir(backupsDir)).length;
  } catch {
    backupsCount = 0;
  }
  res.json({
    dataDir: DATA_DIR,
    dataDirEnv: process.env['DATA_DIR'] ?? null,
    dataDir_exists: existsSync(DATA_DIR),
    usersFile: await statFile(usersFile),
    settingsFile: await statFile(legacySettingsFile),
    tradesStocksFile: await statFile(legacyTradesStocksFile),
    tradesCryptoFile: await statFile(legacyTradesCryptoFile),
    adminSettingsFile: await statFile(adminSettingsFile),
    adminTradesStocksFile: await statFile(adminTradesStocksFile),
    adminTradesCryptoFile: await statFile(adminTradesCryptoFile),
    tra142Migrated: existsSync(migrationMarker),
    backupsDir_exists: existsSync(backupsDir),
    backupsCount,
    userCount: getAllUsers().length,
    userContextCount: getAllUserContexts().length,
    processStart: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  });
});

// ── Auth endpoints ────────────────────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (typeof username !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'username and password are required' });
    return;
  }
  if (!(await validateUserCredentials(username, password))) {
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }
  // TRA-217 — locked accounts cannot log in even with correct credentials.
  // Check after credential validation so we don't leak which usernames exist.
  if (isUserLocked(username)) {
    res.status(423).json({ error: 'Account is locked. Contact an administrator.' });
    return;
  }
  res.json({ token: createToken(username) });
});

app.post('/api/auth/signup', async (req, res) => {
  const { username, email, password } = req.body as { username?: string; email?: string; password?: string };
  if (typeof username !== 'string' || !username.trim()) {
    res.status(400).json({ error: 'Username is required' });
    return;
  }
  if (typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ error: 'A valid email address is required' });
    return;
  }
  if (typeof password !== 'string' || password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }
  const result = await createUser(username.trim(), email.trim(), password);
  if (result.error) {
    res.status(409).json({ error: result.error });
    return;
  }
  // TRA-142 — spin up the new user's per-user context (fresh equity, empty
  // trade history, default settings) so their engine starts ticking right away.
  await provisionUser(username.trim());
  res.json({ token: createToken(username.trim()) });
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body as { email?: string };
  if (typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ error: 'A valid email address is required' });
    return;
  }
  const user = getUserByEmail(email);
  if (user) {
    const code = generateResetToken(user.username);
    try {
      await sendPasswordResetEmail(email, user.username, code);
    } catch (err) {
      console.error('[auth] Failed to send reset email:', err);
    }
  }
  res.json({ ok: true, message: 'If an account with that email exists, a reset code has been sent.' });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { code, newPassword } = req.body as { code?: string; newPassword?: string };
  if (typeof code !== 'string' || typeof newPassword !== 'string') {
    res.status(400).json({ error: 'code and newPassword are required' });
    return;
  }
  if (newPassword.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }
  const username = consumeResetToken(code);
  if (!username) {
    res.status(400).json({ error: 'Invalid or expired reset code' });
    return;
  }
  await changeUserPassword(username, newPassword);
  res.json({ ok: true, message: 'Password has been reset. You can now log in.' });
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const { currentPassword, newPassword } = req.body as {
    currentPassword?: string;
    newPassword?: string;
  };
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    res.status(400).json({ error: 'currentPassword and newPassword are required' });
    return;
  }
  if (newPassword.length < 6) {
    res.status(400).json({ error: 'New password must be at least 6 characters' });
    return;
  }
  if (!(await validateUserCredentials(username, currentPassword))) {
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }
  await changeUserPassword(username, newPassword);
  res.json({ ok: true, message: 'Password changed successfully' });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const username = res.locals['authUser'] as string;
  const user = getUser(username);
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  const { passwordHash: _ph, ...safe } = user;
  res.json(safe);
});

app.patch('/api/auth/me', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const { email } = req.body as { email?: string };
  if (typeof email !== 'string') { res.status(400).json({ error: 'email is required' }); return; }
  const result = await updateUser(username, { email });
  if (!result.ok) { res.status(404).json({ error: result.error }); return; }
  res.json({ ok: true });
});

// ── Admin: user management ────────────────────────────────────────────────────

app.get('/api/admin/users', requireAuth, requireAdmin, (_req, res) => {
  res.json({ users: getAllUsers() });
});

app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const { username, email, password, role } = req.body as {
    username?: string;
    email?: string;
    password?: string;
    role?: 'admin' | 'user';
  };
  if (typeof username !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'username, email, and password are required' });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }
  const result = await createUser(username, email, password, role ?? 'user');
  if (result.error) {
    res.status(409).json({ error: result.error });
    return;
  }
  // TRA-142 — admin-created users also get an isolated context.
  await provisionUser(username);
  res.status(201).json({ ok: true, user: result.user });
});

app.patch('/api/admin/users/:username', requireAuth, requireAdmin, async (req, res) => {
  const { username } = req.params as Record<string, string>;
  const { email, newUsername } = req.body as { email?: string; newUsername?: string };
  const result = await updateUser(username, { email, username: newUsername });
  if (!result.ok) {
    res.status(result.error === 'User not found' ? 404 : 409).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

app.delete('/api/admin/users/:username', requireAuth, requireAdmin, async (req, res) => {
  const { username } = req.params as Record<string, string>;
  const authUser = res.locals['authUser'] as string;
  if (username === authUser) {
    res.status(400).json({ error: 'Cannot delete your own account' });
    return;
  }
  const deleted = await deleteUser(username);
  if (!deleted) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  // TRA-142 — stop the deleted user's engines and forget their caches. Their
  // on-disk state is left intact under DATA_DIR/users/<username>/ so an admin
  // can restore them if needed.
  destroyUserContext(username);
  res.json({ ok: true });
});

// TRA-217 — admin sets a user's password directly (no current-password check).
app.post('/api/admin/users/:username/password', requireAuth, requireAdmin, async (req, res) => {
  const { username } = req.params as Record<string, string>;
  const { newPassword } = req.body as { newPassword?: string };
  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    res.status(400).json({ error: 'newPassword must be at least 6 characters' });
    return;
  }
  if (!getUser(username)) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  await changeUserPassword(username, newPassword);
  res.json({ ok: true });
});

// TRA-217 — admin locks/unlocks a user. Locked accounts cannot log in.
app.post('/api/admin/users/:username/lock', requireAuth, requireAdmin, async (req, res) => {
  const { username } = req.params as Record<string, string>;
  const { locked } = req.body as { locked?: boolean };
  if (typeof locked !== 'boolean') {
    res.status(400).json({ error: 'locked (boolean) is required' });
    return;
  }
  const authUser = res.locals['authUser'] as string;
  // Prevent admins from locking themselves out of the system.
  if (locked && username === authUser) {
    res.status(400).json({ error: 'Cannot lock your own account' });
    return;
  }
  const ok = await setUserLocked(username, locked);
  if (!ok) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({ ok: true, locked });
});

// TRA-217 — admin triggers a password-reset email for any user. Reuses the
// same generator + email template the public forgot-password flow uses, so
// the user resets their own password by entering the PIN.
app.post('/api/admin/users/:username/reset-password', requireAuth, requireAdmin, async (req, res) => {
  const { username } = req.params as Record<string, string>;
  const user = getUser(username);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (!user.email) {
    res.status(400).json({ error: 'User has no email address on file' });
    return;
  }
  const code = generateResetToken(user.username);
  try {
    await sendPasswordResetEmail(user.email, user.username, code);
  } catch (err) {
    console.error('[admin] Failed to send reset email:', err);
    res.status(502).json({ error: 'Failed to send reset email' });
    return;
  }
  res.json({ ok: true, message: `Reset code emailed to ${user.email}` });
});

// ── News + research merge (TRA-227) ──────────────────────────────────────────
//
// Maps a research report into a NewsItem for the News tab and merges with the
// Yahoo headline list. Reports newer than 24h are pinned to the top in
// publishedAt order; older reports interleave with Yahoo by time. The
// front-end recognises research items by `kind`/`bodyMarkdown` and renders an
// expandable card with a "Research" badge.

const RESEARCH_PIN_WINDOW_MS = 24 * 60 * 60 * 1000;

function researchToNewsItem(r: ResearchReport): NewsItem {
  return {
    id: r.id,
    title: r.title,
    url: `/research/${r.id}`,
    source: r.source,
    publishedAt: r.publishedAt,
    kind: r.kind,
    bodyMarkdown: r.bodyMarkdown,
  };
}

async function mergeResearchAndNews(yahoo: NewsItem[]): Promise<NewsItem[]> {
  const reports = await listResearchReports();
  if (reports.length === 0) return yahoo;
  const now = Date.now();
  const pinned: NewsItem[] = [];
  const rest: NewsItem[] = [...yahoo];
  for (const r of reports) {
    const item = researchToNewsItem(r);
    const ts = Date.parse(r.publishedAt);
    if (Number.isFinite(ts) && now - ts <= RESEARCH_PIN_WINDOW_MS) {
      pinned.push(item);
    } else {
      rest.push(item);
    }
  }
  pinned.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  rest.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return [...pinned, ...rest];
}

// ── State ─────────────────────────────────────────────────────────────────────

app.get('/api/state', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  res.json(ctx.engine.getState());
});

app.get('/api/crypto/state', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  res.json(ctx.cryptoEngine.getState());
});

app.get('/api/crypto/news', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  res.json(ctx.cryptoEngine.getNews());
});

app.get('/api/news', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  const yahoo = ctx.engine.getNews();
  const merged = await mergeResearchAndNews(yahoo);
  res.json(merged);
});

// TRA-227 — research-report ingestion + listing.
//
// `POST /api/research/reports` is admin-only: the QuantTrader routine runs
// internally and uses an admin token. The endpoint is idempotent on `id` —
// repeating with the same id updates the saved record rather than duplicating.
app.post('/api/research/reports', requireAuth, requireAdmin, async (req, res) => {
  try {
    const saved = await saveResearchReport(req.body);
    res.status(201).json(saved);
  } catch (err) {
    if (err instanceof ResearchValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error('[research] save failed:', err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: 'Failed to save research report' });
  }
});

app.get('/api/research/reports', requireAuth, async (_req, res) => {
  res.json(await listResearchReports());
});

app.get('/api/research/reports/:id', requireAuth, async (req, res) => {
  const id = (req.params as Record<string, string>)['id'];
  const report = await getResearchReport(id);
  if (!report) {
    res.status(404).json({ error: 'Report not found' });
    return;
  }
  res.json(report);
});

// TRA-244 — `?mode=` lets the client pick which calendar bucket to read.
// Defaults follow the user's saved settings so callers without the query
// (legacy clients, scripts) keep their current behavior.
function resolveStockReportMode(req: express.Request, username: string): StockModeKey {
  const q = (req.query['mode'] as string | undefined)?.trim();
  if (q === 'demo' || q === 'live' || q === 'sandbox') return q;
  return stockModeKey(getSettings(username));
}

function resolveCryptoReportMode(req: express.Request, username: string): CryptoModeKey {
  const q = (req.query['mode'] as string | undefined)?.trim();
  if (q === 'demo' || q === 'live') return q;
  return cryptoModeKey(getSettings(username));
}

app.get('/api/reports/latest', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const mode = resolveStockReportMode(req, ctx.username);
  const latestPath = join(stockReportsDirFor(ctx, mode), 'latest.json');
  if (!existsSync(latestPath)) {
    res.status(404).json({ error: 'No report generated yet' });
    return;
  }
  try {
    const raw = await readFile(latestPath, 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.status(500).json({ error: 'Failed to read report' });
  }
});

app.get('/api/reports', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const mode = resolveStockReportMode(req, ctx.username);
  try {
    const files = await readdir(stockReportsDirFor(ctx, mode));
    const dates = files
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.replace('.json', ''))
      .sort()
      .reverse();
    res.json({ dates });
  } catch {
    res.json({ dates: [] });
  }
});

app.get('/api/reports/:date', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const { date } = req.params as Record<string, string>;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    return;
  }
  const mode = resolveStockReportMode(req, ctx.username);
  const filePath = join(stockReportsDirFor(ctx, mode), `${date}.json`);
  if (!existsSync(filePath)) {
    res.status(404).json({ error: `No report for ${date}` });
    return;
  }
  try {
    const raw = await readFile(filePath, 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.status(500).json({ error: 'Failed to read report' });
  }
});

app.post('/api/reports/generate', requireAuth, async (_req, res) => {
  try {
    const ctx = await userCtx(res);
    await generateAndSaveReport(ctx);
    res.json({ ok: true, message: 'EOD report generated successfully' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Crypto Reports ────────────────────────────────────────────────────────────

app.get('/api/crypto/reports/latest', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const mode = resolveCryptoReportMode(req, ctx.username);
  const latestPath = join(cryptoReportsDirFor(ctx, mode), 'latest.json');
  if (!existsSync(latestPath)) {
    res.status(404).json({ error: 'No crypto report generated yet' });
    return;
  }
  try {
    const raw = await readFile(latestPath, 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.status(500).json({ error: 'Failed to read crypto report' });
  }
});

app.get('/api/crypto/reports', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const mode = resolveCryptoReportMode(req, ctx.username);
  try {
    const files = await readdir(cryptoReportsDirFor(ctx, mode));
    const dates = files
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.replace('.json', ''))
      .sort()
      .reverse();
    res.json({ dates });
  } catch {
    res.json({ dates: [] });
  }
});

app.get('/api/crypto/reports/:date', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const { date } = req.params as Record<string, string>;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    return;
  }
  const mode = resolveCryptoReportMode(req, ctx.username);
  const filePath = join(cryptoReportsDirFor(ctx, mode), `${date}.json`);
  if (!existsSync(filePath)) {
    res.status(404).json({ error: `No crypto report for ${date}` });
    return;
  }
  try {
    const raw = await readFile(filePath, 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.status(500).json({ error: 'Failed to read crypto report' });
  }
});

app.post('/api/crypto/reports/generate', requireAuth, async (_req, res) => {
  try {
    const ctx = await userCtx(res);
    await generateAndSaveCryptoReport(ctx);
    res.json({ ok: true, message: 'Crypto EOD report generated successfully' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/snapshots', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  res.json(ctx.tracker.getSnapshots());
});

// ── Account Settings ─────────────────────────────────────────────────────────

app.get('/api/account/settings', requireAuth, (_req, res) => {
  const username = res.locals['authUser'] as string;
  res.json(getSettings(username));
});

app.put('/api/account/settings', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const body = req.body as Partial<AccountSettings>;
  const current = getSettings(username);
  const clampEquity = (v: number) => Math.max(1_000, Math.min(10_000_000, Number(v)));
  const updated: AccountSettings = {
    ...current,
    ...body,
    demoEquity: clampEquity(body.demoEquity ?? current.demoEquity),
    demoEquityStocks: clampEquity(body.demoEquityStocks ?? current.demoEquityStocks ?? current.demoEquity),
    demoEquityCrypto: clampEquity(body.demoEquityCrypto ?? current.demoEquityCrypto ?? current.demoEquity),
    dailyTradesLimit: Math.max(1, Math.min(100, Number(body.dailyTradesLimit ?? current.dailyTradesLimit))),
    optionsDailyTradesLimit: Math.max(1, Math.min(100, Number(body.optionsDailyTradesLimit ?? current.optionsDailyTradesLimit))),
    // TRA-327 — clamp the live-only counterparts independently so a Demo edit
    // never pulls the Live cap with it. Falls back to the un-suffixed demo
    // value for back-compat with saved settings written before TRA-327.
    dailyTradesLimitLive: Math.max(
      1,
      Math.min(
        100,
        Number(body.dailyTradesLimitLive ?? current.dailyTradesLimitLive ?? current.dailyTradesLimit),
      ),
    ),
    optionsDailyTradesLimitLive: Math.max(
      1,
      Math.min(
        100,
        Number(
          body.optionsDailyTradesLimitLive
            ?? current.optionsDailyTradesLimitLive
            ?? current.optionsDailyTradesLimit,
        ),
      ),
    ),
    managedAccountRatio: Math.max(0.01, Math.min(1, Number(body.managedAccountRatio ?? current.managedAccountRatio))),
    riskPerTrade: Math.max(0.001, Math.min(0.5, Number(body.riskPerTrade ?? current.riskPerTrade))),
    // TRA-346 — scoped Managed Account Ratio + Risk Per Trade. Each of the
    // eight (mode × dashboard) buckets is clamped independently and preserved
    // as `undefined` when neither the request body nor the saved snapshot
    // holds a value, so untouched buckets keep falling back to the legacy
    // un-suffixed field via `resolveManagedAccountRatio` /
    // `resolveRiskPerTrade`. Pinning every bucket to a default the moment any
    // other setting is saved would silently break that fallback for users who
    // saved before TRA-346. Helper extracted to `account-settings.ts` so
    // TRA-349 regression tests can lock the contract without spinning up the
    // route.
    ...mergeScopedRiskSettings(current, body),
    // TRA-249-E — clamp the operator-facing leverage cap to [1, 5] integer.
    // The live engine still hard-caps at 1× (PERP_SHORT_LEVERAGE) so a
    // misconfigured value can't bypass the §6 caps; clamping here keeps the
    // stored payload sane regardless of what the UI sends.
    liveMaxLeverageCrypto: Math.max(
      1,
      Math.min(5, Math.round(Number(body.liveMaxLeverageCrypto ?? current.liveMaxLeverageCrypto ?? 1))),
    ),
    // TRA-325 — clamp to a known preset id so a malformed request can't park
    // the engine on an unknown preset (which would degrade-fall to legacy_5
    // anyway via resolveStrategyPreset, but persisting a junk id would
    // surface as a confusing UI selection on next load).
    activeStrategyPreset: ((): StrategyPresetId => {
      const requested = body.activeStrategyPreset ?? current.activeStrategyPreset;
      if (requested && requested in STRATEGY_PRESETS) return requested as StrategyPresetId;
      return DEFAULT_STRATEGY_PRESET_ID;
    })(),
  };
  await saveSettings(username, updated);
  // Await the stocks engine: TRA-226 makes applySettings async so a flip into
  // live mode can refresh the Tradier balance once before the broadcast,
  // matching the Coinbase pattern from TRA-224 — without this the dashboard
  // would show $0 equity for up to 30s until the next tick.
  await ctx.engine.applySettings(updated);
  broadcastEngineState(ctx);
  // Await the crypto engine: switching into live mode does an initial Coinbase
  // balance fetch, and the broadcast that follows must reflect that equity
  // instead of a transient $0 the user sees until the next 60s tick (TRA-224).
  await ctx.cryptoEngine.applySettings(updated);
  broadcastCryptoState(ctx);
  res.json({ ok: true, settings: updated });
});

// Per-market scope (TRA-192): Stockdashboard and Cryptodashboard each have
// their own "Reset Demo Account" button, and resetting one must not wipe the
// other. The optional `market` body field selects which engine to reset.
// Omitting it preserves the legacy "reset both" behavior used by the global
// settings page where no market context is active.
app.post('/api/account/reset-demo', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const settings = getSettings(username);
  const market = (req.body as { market?: string } | undefined)?.market;
  if (market !== undefined && market !== 'stocks' && market !== 'crypto') {
    res.status(400).json({ error: "market must be 'stocks', 'crypto', or omitted" });
    return;
  }
  if (market === undefined || market === 'stocks') {
    ctx.engine.forceReset(settings);
    broadcastEngineState(ctx);
  }
  if (market === undefined || market === 'crypto') {
    const cryptoEquity = settings.demoEquityCrypto ?? settings.demoEquity;
    ctx.cryptoEngine.forceReset(cryptoEquity);
    broadcastCryptoState(ctx);
  }
  res.json({ ok: true, market: market ?? 'both' });
});

// ── Trading controls ──────────────────────────────────────────────────────────

/**
 * TRA-323 — build a Tradier options client targeting a specific env regardless
 * of the user's current `liveTradierEnvOptions` selection. Used by the
 * "Sync Tradier positions" flow so a user can pull sandbox state in even
 * while the engine is configured for production (or vice versa). Returns
 * `null` when neither saved per-options creds nor env-var fallbacks are
 * present for the requested env; the caller should respond with a clear
 * 409 rather than silently no-op.
 */
function buildTradierOptionsClientForEnv(
  settings: AccountSettings,
  env: TradierEnv,
): TradierOptionsClient | null {
  const apiToken = (
    (env === 'production'
      ? settings.liveApiKeyOptionsProduction
      : (settings.liveApiKeyOptionsSandbox ?? settings.liveApiKeyOptions))
    ?? (env === 'production'
      ? process.env['TRADIER_API_TOKEN']
      : (process.env['TRADIER_SANDBOX_API_TOKEN'] ?? process.env['TRADIER_API_TOKEN']))
    ?? ''
  ).trim();
  const accountId = (
    (env === 'production'
      ? settings.liveAccountIdOptionsProduction
      : (settings.liveAccountIdOptionsSandbox ?? settings.liveAccountIdOptions))
    ?? (env === 'production'
      ? process.env['TRADIER_ACCOUNT_ID']
      : (process.env['TRADIER_SANDBOX_ACCOUNT_ID'] ?? process.env['TRADIER_ACCOUNT_ID']))
    ?? ''
  ).trim();
  if (!apiToken || !accountId) return null;
  return new TradierOptionsClient(apiToken, accountId, env);
}

// TRA-229 — start/stop are scoped to the dashboard's current account mode
// (demo or live) so a user can run live trading while leaving demo paused, or
// vice versa. The mode is taken from saved settings; clients can also pass an
// explicit `{ "mode": "demo" | "live" }` body to set the inactive-mode flag
// without switching modes.
function resolveTradingMode(
  body: unknown,
  current: 'demo' | 'live',
): 'demo' | 'live' {
  const requested = (body as { mode?: unknown } | undefined)?.mode;
  if (requested === 'demo' || requested === 'live') return requested;
  return current;
}

app.post('/api/trading/start', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const settings = getSettings(username);
  const mode = resolveTradingMode(req.body, settings.mode);
  ctx.engine.setAutoTrading(true, mode);
  const updated: AccountSettings = {
    ...settings,
    ...(mode === 'live'
      ? { stocksAutoTradingEnabledLive: true }
      : { stocksAutoTradingEnabledDemo: true }),
  };
  await saveSettings(username, updated);
  broadcastEngineState(ctx);
  res.json({ ok: true, mode, autoTradingEnabled: true });
});

app.post('/api/trading/stop', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const settings = getSettings(username);
  const mode = resolveTradingMode(req.body, settings.mode);
  ctx.engine.setAutoTrading(false, mode);
  const updated: AccountSettings = {
    ...settings,
    ...(mode === 'live'
      ? { stocksAutoTradingEnabledLive: false }
      : { stocksAutoTradingEnabledDemo: false }),
  };
  await saveSettings(username, updated);
  broadcastEngineState(ctx);
  res.json({ ok: true, mode, autoTradingEnabled: false });
});

// TRA-230: clear the displayed signal list without resetting positions or equity.
app.post('/api/signals/reset', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  ctx.engine.clearSignals();
  broadcastEngineState(ctx);
  res.json({ ok: true });
});

app.post('/api/positions/:id/close', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const { id } = req.params as Record<string, string>;
  const state = ctx.engine.getState();
  const pos = state.account.openPositions.find(p => p.id === id);
  if (!pos) {
    res.status(404).json({ error: 'Position not found' });
    return;
  }
  const sym = state.symbols.find(s => s.symbol === pos.symbol);
  const price = sym?.price ?? pos.entryPrice;
  ctx.engine.manualClosePosition(id, price);
  broadcastEngineState(ctx);
  res.json({ ok: true });
});

app.post('/api/options/:id/close', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const { id } = req.params as Record<string, string>;

  // TRA-323 — imported Tradier positions don't share the local paper-cash
  // bucket; closing them through `manualCloseOption` would no-op (the
  // method explicitly skips `importedFromTradier` rows). Detect that case
  // first, submit a real `sell_to_close` order to Tradier in the
  // position's env, and only drop the local row once the broker accepted
  // the order. Failures bubble back as a 502 so the UI can surface the
  // reason instead of silently leaving a stuck row.
  const imported = ctx.engine.findImportedOption(id);
  if (imported) {
    const settings = getSettings(username);
    const client = buildTradierOptionsClientForEnv(settings, imported.env);
    if (!client) {
      res.status(409).json({
        error: `No Tradier credentials saved for ${imported.env} — set them in Settings before closing imported positions.`,
      });
      return;
    }
    const optionSymbol = imported.position.optionSymbol;
    const contracts = imported.position.contractsRemaining;
    if (!optionSymbol || contracts <= 0) {
      res.status(409).json({ error: 'Imported position is missing OCC symbol or contracts' });
      return;
    }
    try {
      const order = await client.sellContracts(optionSymbol, contracts);
      console.log(
        `[tradier-import] sell_to_close ${optionSymbol} qty=${contracts} env=${imported.env} order=${order.id} status=${order.status}`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[tradier-import] sell_to_close failed for ${optionSymbol} (${imported.env}): ${message}`,
      );
      res.status(502).json({ error: `Tradier rejected the close order: ${message}` });
      return;
    }
    ctx.engine.dropImportedOption(id);
    broadcastEngineState(ctx);
    res.json({ ok: true, imported: true });
    return;
  }

  const closed = ctx.engine.manualCloseOption(id);
  if (!closed) {
    res.status(404).json({ error: 'Option position not found' });
    return;
  }
  broadcastEngineState(ctx);
  res.json({ ok: true });
});

/**
 * TRA-323 — sync open option positions from Tradier into the local options
 * store so the user can manage them from TradeAI's Open Options view. Used
 * primarily for Sandbox (where the user opens positions on Tradier's web UI
 * and wants to close them through TradeAI), but the same flow works in
 * production. The env defaults to whichever the user has selected for
 * options live mode (`liveTradierEnvOptions`); a `?env=...` query param
 * lets the UI override it explicitly.
 *
 * Returns a count summary so the caller can render "synced N positions"
 * feedback. Failures pre-empt with a clear error rather than silently
 * leaving an empty list — the UI distinguishes "no creds" from "broker
 * returned no positions" from "we hit a network error".
 */
app.post('/api/tradier/positions/sync', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const settings = getSettings(username);
  const envParam = typeof req.query['env'] === 'string' ? req.query['env'] : undefined;
  const env: TradierEnv =
    envParam === 'production' || envParam === 'sandbox'
      ? envParam
      : (settings.liveTradierEnvOptions ?? 'sandbox');

  const client = buildTradierOptionsClientForEnv(settings, env);
  if (!client) {
    res.status(409).json({
      error: `No Tradier credentials saved for ${env} — set them in Settings before syncing.`,
    });
    return;
  }

  let positions;
  try {
    positions = await client.listOpenOptionPositions();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[tradier-import] list positions failed (${env}): ${message}`);
    res.status(502).json({ error: `Tradier list-positions failed: ${message}` });
    return;
  }

  // TRA-323 — imported rows are stamped with the position's mode so the
  // dashboard's mode-scoped views can find them. We attribute them to
  // 'live' since that's where Tradier-mirrored activity belongs; the demo
  // dashboard never owns Tradier positions.
  const summary = ctx.engine.reconcileTradierPositions(env, positions, 'live');
  broadcastEngineState(ctx);
  res.json({ ok: true, env, ...summary });
});

/**
 * Smoke-test Coinbase live credentials without placing any orders.
 *
 * Pulls the user's saved API key/secret (env-var fallback identical to
 * crypto-engine.buildLiveBroker), instantiates a CoinbaseOrderClient, then
 * issues a single authenticated GET against /api/v3/brokerage/accounts.
 *
 * The response always returns 200 with an `ok` flag; the UI only needs to
 * inspect the body. `authScheme` lets the user confirm a PEM secret was
 * recognised as CDP rather than silently treated as HMAC.
 */
app.post('/api/crypto/coinbase/test-connection', requireAuth, async (_req, res) => {
  const username = res.locals['authUser'] as string;
  const settings = getSettings(username);
  // Same precedence as crypto-engine.buildLiveBroker: per-market crypto
  // credentials (TRA-165) → legacy un-suffixed fields → env vars.
  const apiKey = (
    settings.liveApiKeyCrypto?.trim()
    || settings.liveApiKey?.trim()
    || process.env['COINBASE_API_KEY']
    || ''
  ).trim();
  const apiSecret = (
    settings.liveApiSecretCrypto?.trim()
    || settings.liveApiSecret?.trim()
    || process.env['COINBASE_API_SECRET']
    || ''
  ).trim();
  if (!apiKey || !apiSecret) {
    res.json({ ok: false, error: 'Coinbase API key and secret are not configured. Save them in Settings before testing.' });
    return;
  }
  let client: CoinbaseOrderClient;
  try {
    client = new CoinbaseOrderClient({ apiKey, apiSecret });
  } catch (err: unknown) {
    res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const authScheme = client.getAuthScheme();
  try {
    const accounts = await client.listAccounts();
    const currencies = Array.from(new Set(accounts.map(a => a.currency))).sort();
    res.json({ ok: true, authScheme, accountCount: accounts.length, currencies });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.json({ ok: false, authScheme, error: message });
  }
});

/**
 * Place a deliberately tiny market BUY against Coinbase Advanced Trade so the
 * user can verify their funded live account end-to-end (TRA-222) before
 * flipping auto-trading on. Reuses the same credential precedence as
 * /test-connection. The order is NOT registered with the engine — it's a
 * one-shot smoke test, the resulting crypto sits in the user's Coinbase
 * wallet exactly like a manual buy.
 *
 * Hard caps: $5 USD max quote size and BUY only. We refuse to do this in demo
 * mode so a misclick can't waste real money on a user who hasn't switched
 * over yet.
 */
app.post('/api/crypto/coinbase/place-test-order', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const settings = getSettings(username);
  if (settings.mode !== 'live') {
    res.json({ ok: false, error: 'Account is in demo mode. Switch to Live before placing a test order.' });
    return;
  }
  const body = (req.body ?? {}) as { productId?: string; quoteSize?: number };
  const productId = (body.productId ?? 'BTC-USD').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}-USD[CT]?$/.test(productId)) {
    res.json({ ok: false, error: `Invalid productId "${productId}". Expected e.g. BTC-USD.` });
    return;
  }
  const quoteSize = Number(body.quoteSize ?? 1);
  if (!Number.isFinite(quoteSize) || quoteSize <= 0) {
    res.json({ ok: false, error: 'quoteSize must be a positive number (USD).' });
    return;
  }
  if (quoteSize > 5) {
    res.json({ ok: false, error: 'Test order capped at $5 USD. Reduce quoteSize.' });
    return;
  }
  const apiKey = (
    settings.liveApiKeyCrypto?.trim()
    || settings.liveApiKey?.trim()
    || process.env['COINBASE_API_KEY']
    || ''
  ).trim();
  const apiSecret = (
    settings.liveApiSecretCrypto?.trim()
    || settings.liveApiSecret?.trim()
    || process.env['COINBASE_API_SECRET']
    || ''
  ).trim();
  if (!apiKey || !apiSecret) {
    res.json({ ok: false, error: 'Coinbase API key and secret are not configured. Save them in Settings before testing.' });
    return;
  }
  let client: CoinbaseOrderClient;
  try {
    client = new CoinbaseOrderClient({ apiKey, apiSecret });
  } catch (err: unknown) {
    res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const authScheme = client.getAuthScheme();
  let orderId: string;
  try {
    const placed = await client.placeMarketOrder({ productId, side: 'buy', quoteSize });
    orderId = placed.order_id;
  } catch (err: unknown) {
    res.json({ ok: false, authScheme, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  // Best-effort fill reconciliation — same backoff schedule as
  // CryptoLiveAccount.awaitFill so a typical fill returns rich detail without
  // dragging the request out indefinitely.
  const delays = [200, 400, 800, 1500, 2000];
  let fillPrice: number | undefined;
  let fillSize: number | undefined;
  let status = 'unknown';
  for (const d of delays) {
    await new Promise(r => setTimeout(r, d));
    try {
      const order = await client.getOrder(orderId);
      status = (order.status ?? 'unknown').toUpperCase();
      if (status === 'FILLED') {
        const p = parseFloat(order.average_filled_price);
        const s = parseFloat(order.filled_size);
        if (Number.isFinite(p) && p > 0) fillPrice = p;
        if (Number.isFinite(s) && s > 0) fillSize = s;
        break;
      }
      if (status === 'CANCELLED' || status === 'EXPIRED' || status === 'FAILED') break;
    } catch {
      // Order was already accepted by Coinbase — keep polling.
    }
  }
  res.json({
    ok: true,
    authScheme,
    orderId,
    productId,
    quoteSize,
    status,
    fillPrice,
    fillSize,
  });
});

/**
 * Smoke-test Tradier live credentials without placing any orders (TRA-221).
 *
 * Reads the user's saved options API token, account ID, and environment from
 * AccountSettings and issues an authenticated GET against
 * `/v1/user/profile`. Tradier returns the account list scoped to the token,
 * so we can confirm the supplied accountId is reachable. Falls back to env
 * vars only if the user explicitly left the per-options fields blank — a hint
 * that the saved RV-scanner creds should also work for live trading.
 */
app.post('/api/options/tradier/test-connection', requireAuth, async (_req, res) => {
  const username = res.locals['authUser'] as string;
  const settings = getSettings(username);
  // TRA-226 — sandbox/production credentials are stored on separate fields so
  // the resolver only returns the pair matching the currently selected env.
  // Env-var fallback is layered on top here so a deployment that bootstrapped
  // creds via env (TRADIER_*) still works without forcing every user to retype
  // them in Settings.
  const resolved = resolveTradierOptionsCreds(settings);
  const env = resolved.env;
  const apiToken = (
    resolved.apiToken
    || (env === 'production'
      ? process.env['TRADIER_API_TOKEN']
      : (process.env['TRADIER_SANDBOX_API_TOKEN'] ?? process.env['TRADIER_API_TOKEN']))
    || ''
  ).trim();
  const accountId = (
    resolved.accountId
    || (env === 'production'
      ? process.env['TRADIER_ACCOUNT_ID']
      : (process.env['TRADIER_SANDBOX_ACCOUNT_ID'] ?? process.env['TRADIER_ACCOUNT_ID']))
    || ''
  ).trim();
  if (!apiToken || !accountId) {
    res.json({
      ok: false,
      error: `Tradier ${env} API token and Account ID are not configured. Save them in Settings before testing.`,
    });
    return;
  }
  try {
    const profileResp = await fetch(`${tradierBaseUrl(env)}/user/profile`, {
      headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' },
    });
    if (!profileResp.ok) {
      const text = await profileResp.text().catch(() => '');
      res.json({ ok: false, error: `Tradier ${profileResp.status} — ${text || profileResp.statusText}` });
      return;
    }
    const data = (await profileResp.json()) as {
      profile?: {
        account?:
          | { account_number?: string; status?: string; classification?: string; type?: string }
          | { account_number?: string; status?: string; classification?: string; type?: string }[];
      };
    };
    const accountsRaw = data.profile?.account;
    const accounts = Array.isArray(accountsRaw) ? accountsRaw : accountsRaw ? [accountsRaw] : [];
    const matched = accounts.find(a => a.account_number === accountId);
    if (!matched) {
      const known = accounts.map(a => a.account_number).filter(Boolean).join(', ') || 'none';
      res.json({
        ok: false,
        error: `Token authenticated but Account ID ${accountId} not found on this Tradier profile (known: ${known}).`,
      });
      return;
    }
    res.json({
      ok: true,
      env,
      accountNumber: matched.account_number,
      status: matched.status,
      classification: matched.classification,
    });
  } catch (err: unknown) {
    res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/crypto/trading/start', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const settings = getSettings(username);
  const mode = resolveTradingMode(req.body, settings.mode);
  ctx.cryptoEngine.setAutoTrading(true, mode);
  const updated: AccountSettings = {
    ...settings,
    ...(mode === 'live'
      ? { cryptoAutoTradingEnabledLive: true }
      : { cryptoAutoTradingEnabledDemo: true }),
  };
  await saveSettings(username, updated);
  broadcastCryptoState(ctx);
  res.json({ ok: true, mode, autoTradingEnabled: true });
});

app.post('/api/crypto/trading/stop', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const settings = getSettings(username);
  const mode = resolveTradingMode(req.body, settings.mode);
  ctx.cryptoEngine.setAutoTrading(false, mode);
  const updated: AccountSettings = {
    ...settings,
    ...(mode === 'live'
      ? { cryptoAutoTradingEnabledLive: false }
      : { cryptoAutoTradingEnabledDemo: false }),
  };
  await saveSettings(username, updated);
  broadcastCryptoState(ctx);
  res.json({ ok: true, mode, autoTradingEnabled: false });
});

// ── Watchlist management ──────────────────────────────────────────────────────

app.get('/api/watchlist/crypto', requireAuth, async (_req, res) => {
  const username = res.locals['authUser'] as string;
  await initWatchlistStore(username);
  res.json(getCryptoWatchlistData(username));
});

app.post('/api/watchlist/crypto', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const { symbol } = req.body as { symbol?: string };
  if (typeof symbol !== 'string' || !symbol.trim()) {
    res.status(400).json({ error: 'symbol is required' });
    return;
  }
  const sym = symbol.trim().toUpperCase();
  if (!/^[A-Z]{2,10}-USD$/.test(sym)) {
    res.status(400).json({ error: 'Invalid symbol format. Expected XXX-USD (e.g. ETH-USD)' });
    return;
  }
  await addCryptoSymbol(username, sym);
  ctx.cryptoEngine.addSymbol(sym);
  ctx.cryptoEngine.refresh();
  res.json({ ok: true, symbol: sym });
});

app.delete('/api/watchlist/crypto/:symbol', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const raw = req.params['symbol'];
  const sym = (Array.isArray(raw) ? raw[0] : raw ?? '').toUpperCase();
  if (!sym) { res.status(400).json({ error: 'symbol is required' }); return; }
  await removeCryptoSymbol(username, sym);
  ctx.cryptoEngine.removeSymbol(sym);
  broadcastCryptoState(ctx);
  res.json({ ok: true });
});

app.post('/api/watchlist/crypto/scan', requireAuth, async (_req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  try {
    const results = await scanCryptoMarket();
    for (const r of results) {
      await addCryptoSymbol(username, r.symbol);
      ctx.cryptoEngine.addSymbol(r.symbol);
    }
    ctx.cryptoEngine.refresh();
    res.json({ ok: true, added: results.map(r => r.symbol) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/watchlist/stocks', requireAuth, async (_req, res) => {
  const username = res.locals['authUser'] as string;
  await initWatchlistStore(username);
  res.json(getStocksWatchlistData(username));
});

app.post('/api/watchlist/stocks', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const { symbol } = req.body as { symbol?: string };
  if (typeof symbol !== 'string' || !symbol.trim()) {
    res.status(400).json({ error: 'symbol is required' });
    return;
  }
  const sym = symbol.trim().toUpperCase();
  if (!/^[A-Z]{1,5}$/.test(sym)) {
    res.status(400).json({ error: 'Invalid symbol format. Expected 1–5 letters (e.g. NVDA)' });
    return;
  }
  await addStocksSymbol(username, sym);
  ctx.engine.addSymbol(sym);
  ctx.engine.refresh();
  res.json({ ok: true, symbol: sym });
});

app.delete('/api/watchlist/stocks/:symbol', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const raw = req.params['symbol'];
  const sym = (Array.isArray(raw) ? raw[0] : raw ?? '').toUpperCase();
  if (!sym) { res.status(400).json({ error: 'symbol is required' }); return; }
  await removeStocksSymbol(username, sym);
  ctx.engine.removeSymbol(sym);
  broadcastEngineState(ctx);
  res.json({ ok: true });
});

app.post('/api/watchlist/stocks/scan', requireAuth, async (_req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  try {
    const results = await scanStocksMarket();
    for (const r of results) {
      await addStocksSymbol(username, r.symbol);
      ctx.engine.addSymbol(r.symbol);
    }
    ctx.engine.refresh();
    res.json({ ok: true, added: results.map(r => r.symbol) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// TRA-230: clear the displayed crypto signal list without resetting positions or equity.
app.post('/api/crypto/signals/reset', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  ctx.cryptoEngine.clearSignals();
  broadcastCryptoState(ctx);
  res.json({ ok: true });
});

app.post('/api/crypto/positions/:id/close', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const { id } = req.params as Record<string, string>;
  const state = ctx.cryptoEngine.getState();
  const pos = state.account.openPositions.find(p => p.id === id);
  if (!pos) {
    res.status(404).json({ error: 'Position not found' });
    return;
  }
  const sym = state.symbols.find(s => s.symbol === pos.symbol);
  const price = sym?.price ?? pos.entryPrice;
  // TRA-320 — await the broker close so a Coinbase reject (auth,
  // INSUFFICIENT_FUND, product not tradable) surfaces back to the dashboard
  // instead of being swallowed by a fire-and-forget. On failure the position
  // stays open in the broker mirror and the dashboard's next state tick will
  // continue to show it; we just need to tell the user *why* the close did
  // not go through.
  try {
    await ctx.cryptoEngine.manualClosePosition(id, price);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[crypto-engine] manualClose live failed: ${reason}`);
    broadcastCryptoState(ctx);
    res.status(502).json({ error: 'Coinbase rejected close', reason });
    return;
  }
  broadcastCryptoState(ctx);
  res.json({ ok: true });
});

// ── Data-source health check ─────────────────────────────────────────────────

app.get('/api/health/quotes', async (_req, res) => {
  const {
    testYahooFinance,
    testTradier,
    testTwelveData,
    isYahooBreakerOpen,
    isTradierBreakerOpen,
    isTradierStocksConfigured,
    fetchMinuteBarsWithSource,
    getFallbackRequestCounts,
  } = await import('./yahoo-feed.js');
  const { testCoinMarketCap, testCoinbase, isCoinbaseBreakerOpen } = await import('./crypto-feed.js');
  const results: Record<string, unknown> = {};

  try {
    const tradier = await testTradier();
    results['tradier'] = tradier ?? { skipped: 'TRADIER_*_API_TOKEN not set' };
  } catch (err: unknown) {
    results['tradier'] = { error: err instanceof Error ? err.message : String(err) };
  }

  // TRA-331 — Coinbase Exchange is the LIVE crypto engine's primary quote
  // source. Probing it here makes the health response reflect the path the
  // engine actually uses; without this the endpoint only saw fallbacks and
  // reported `cryptoOk: false` whenever Yahoo/Twelve/CMC were degraded even
  // though crypto was flowing through Coinbase fine.
  try {
    results['coinbase'] = await testCoinbase();
  } catch (err: unknown) {
    results['coinbase'] = { error: err instanceof Error ? err.message : String(err) };
  }

  try {
    results['yahooFinance'] = await testYahooFinance();
  } catch (err: unknown) {
    results['yahooFinance'] = { error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const td = await testTwelveData();
    results['twelveData'] = td ?? { skipped: 'TWELVE_DATA_API_KEY not set' };
  } catch (err: unknown) {
    results['twelveData'] = { error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const cmc = await testCoinMarketCap();
    results['coinMarketCap'] = cmc ?? { skipped: 'CMC_API_KEY not set' };
  } catch (err: unknown) {
    results['coinMarketCap'] = { error: err instanceof Error ? err.message : String(err) };
  }

  // TRA-191 follow-up: probe the actual minute-bar path the signal engine uses,
  // so QA can confirm Tradier (primary) is serving and the fallback chain
  // engages when its breaker is open. All provider diags are surfaced so QA
  // can see *why* a given tier returned nothing (no_data, http_error, etc.).
  try {
    const probe = await fetchMinuteBarsWithSource('AAPL', 60);
    results['chartFallback'] = {
      symbol: 'AAPL',
      bars: probe.bars.length,
      source: probe.source,
      yahooSkipped: probe.yahooSkipped,
      cached: probe.cached ?? false,
      tradierDiag: probe.tradierDiag ?? null,
      twelveDataDiag: probe.twelveDataDiag ?? null,
    };
  } catch (err: unknown) {
    results['chartFallback'] = { error: err instanceof Error ? err.message : String(err) };
  }

  // Daily request counters per provider. Resets at UTC midnight.
  results['fallbackRequestsToday'] = getFallbackRequestCounts();

  const ok = (key: string) => {
    const v = results[key];
    return v && typeof v === 'object' && !('error' in (v as object)) && !('skipped' in (v as object));
  };
  const stocksOk = ok('tradier') || ok('yahooFinance');
  // TRA-331 — Coinbase is primary for crypto; YF/CMC are fallbacks only.
  const cryptoOk = ok('coinbase') || ok('yahooFinance') || ok('coinMarketCap');
  const allOk = stocksOk && cryptoOk;
  res.status(allOk ? 200 : 502).json({
    ok: allOk,
    stocksOk,
    cryptoOk,
    tradierConfigured: isTradierStocksConfigured(),
    tradierBreakerOpen: isTradierBreakerOpen(),
    yahooBreakerOpen: isYahooBreakerOpen(),
    coinbaseBreakerOpen: isCoinbaseBreakerOpen(),
    results,
    ts: new Date().toISOString(),
  });
});

// ── WebSocket ────────────────────────────────────────────────────────────────

const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// TRA-142 — every WS client is tagged with the authenticated username so
// state and EOD broadcasts only go to that user's clients.
type AuthedSocket = WebSocket & { username?: string };

function broadcastToUser(username: string, msg: string): void {
  for (const client of wss.clients) {
    const c = client as AuthedSocket;
    if (c.readyState === WebSocket.OPEN && c.username === username) c.send(msg);
  }
}

function broadcastEngineState(ctx: UserContext): void {
  broadcastToUser(ctx.username, JSON.stringify({ type: 'state', payload: ctx.engine.getState() }));
}

function broadcastCryptoState(ctx: UserContext): void {
  broadcastToUser(ctx.username, JSON.stringify({ type: 'crypto_state', payload: ctx.cryptoEngine.getState() }));
}

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${firstHeader(req.headers.host) ?? 'localhost'}`);
  const token = url.searchParams.get('token') ?? '';
  const username = verifyToken(token);
  if (!username) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    (ws as AuthedSocket).username = username;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', async (ws) => {
  const c = ws as AuthedSocket;
  const username = c.username;
  if (!username) { ws.close(); return; }
  const ctx = await ensureUserContext(username);

  ws.send(JSON.stringify({ type: 'state', payload: ctx.engine.getState() }));
  ws.send(JSON.stringify({ type: 'crypto_state', payload: ctx.cryptoEngine.getState() }));

  // TRA-244 — read latest.json from the active stocks bucket so the WS
  // handshake matches whatever the Calendar tab is showing for this account.
  const stocksMode = stockModeKey(getSettings(ctx.username));
  const latestPath = join(stockReportsDirFor(ctx, stocksMode), 'latest.json');
  if (existsSync(latestPath)) {
    try {
      const raw = await readFile(latestPath, 'utf-8');
      ws.send(JSON.stringify({ type: 'eod_report', payload: JSON.parse(raw) }));
    } catch { /* ignore */ }
  }
});

// Wire up per-user engine onTick → user-scoped WS broadcasts.
function attachBroadcastHandlers(ctx: UserContext): void {
  ctx.engine.onTick((state) => {
    broadcastToUser(ctx.username, JSON.stringify({ type: 'state', payload: state }));
  });
  ctx.cryptoEngine.onTick((state) => {
    broadcastToUser(ctx.username, JSON.stringify({ type: 'crypto_state', payload: state }));
  });
}

for (const ctx of getAllUserContexts()) {
  attachBroadcastHandlers(ctx);
}

/**
 * Provision a brand-new user: build their context and wire WS broadcast
 * handlers. Used by signup and admin-create. Failures are logged but do not
 * break the calling request — the user is created and their context can be
 * lazily rebuilt on first auth.
 */
async function provisionUser(username: string): Promise<void> {
  try {
    const ctx = await initUserContext(username);
    attachBroadcastHandlers(ctx);
  } catch (err: unknown) {
    console.warn(`[provisionUser] failed for ${username}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Periodic backup snapshots (TRA-140) — every 30 minutes the persisted JSON
// files are copied into a timestamped folder under DATA_DIR/backups/. Old
// folders are pruned (last 24 kept = ~12 hours). On startup, missing/corrupt
// primary files auto-restore from the latest backup.
void rotateBackups().catch(err => console.warn(`[trade-store] initial backup failed: ${err instanceof Error ? err.message : String(err)}`));
const BACKUP_INTERVAL_MS = 30 * 60_000;
const backupTimer = setInterval(() => {
  void rotateBackups().catch(err => console.warn(`[trade-store] backup failed: ${err instanceof Error ? err.message : String(err)}`));
}, BACKUP_INTERVAL_MS);
backupTimer.unref?.();

// ── Static frontend (production web) ────────────────────────────────────────
const DIST_DIR = join(__dirname, '..', '..', '..', 'apps', 'desktop', 'dist');
if (existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(join(DIST_DIR, 'index.html'));
  });
}

// ── Start ────────────────────────────────────────────────────────────────────

const scheduler = new MarketScheduler();
scheduler.start({
  // TRA-244 — collapsed onto the 9 PM ET archive hook so the Calendar row
  // appears AFTER the dashboard's dailyPnl reset (the previous 4:05 PM hooks
  // ran before the reset, leaving the row visible at 4:05 but the dashboard
  // still showing the stale total until 9). Stocks generation is gated on
  // market days inside the callback; crypto fires every day (24/7).
  onArchive: runDailyCloseForAllUsers,
  // TRA-249-D — hourly funding accrual on open Coinbase INTX perps. Fires
  // at minute=0 every ET hour; per-user trackers no-op when no perps are
  // open or the user is in demo mode.
  onHourly: runHourlyFundingForAllUsers,
});

httpServer.listen(PORT, () => {
  console.log(`Trading server running on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
});

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`[shutdown] received ${signal} — stopping engines and flushing trade history`);
  scheduler.stop();
  const all = getAllUserContexts();
  for (const ctx of all) {
    ctx.engine.stop();
    ctx.cryptoEngine.stop();
    if (ctx.stocksPersistTimer) clearTimeout(ctx.stocksPersistTimer);
    if (ctx.cryptoPersistTimer) clearTimeout(ctx.cryptoPersistTimer);
  }
  // Flush every user's pending trade-history writes synchronously before exit.
  try {
    await Promise.all(all.flatMap(ctx => [persistStocksNow(ctx), persistCryptoNow(ctx)]));
  } catch (err: unknown) {
    console.warn(`[shutdown] persist failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(0);
}

process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
