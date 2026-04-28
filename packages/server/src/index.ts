import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { writeFile, readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MarketScheduler } from './scheduler.js';
import { generateEodReport } from './reports/eod-report.js';
import { generateCryptoEodReport } from './reports/crypto-eod-report.js';
import { createToken, verifyToken, generateResetToken, consumeResetToken, initResetTokenStore } from './auth.js';
import { getSettings, saveSettings } from './account-settings.js';
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
} from './users.js';
import { sendPasswordResetEmail } from './email.js';
import { rotateBackups, checkDataDirHealth } from './trade-store.js';
import { TradierOtmMispricingService } from './options-scanner.js';
import { fetchQuotes } from './yahoo-feed.js';
import {
  runFirstBootMigration,
  initAllUserContexts,
  initUserContext,
  ensureUserContext,
  destroyUserContext,
  getAllUserContexts,
  tryGetUserContext,
  persistStocksNow,
  persistCryptoNow,
  type UserContext,
} from './user-context.js';
import type { AccountSettings } from '@trading-app/shared';

const PORT = Number(process.env.PORT ?? 4242);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? join(__dirname, '..', 'data');

// TRA-140 — log DATA_DIR and warn loudly if it's ephemeral.
await checkDataDirHealth();

// Load users and reset tokens from persistent storage.
await loadUsers();
initResetTokenStore(DATA_DIR);

// TRA-142 — migrate legacy global files into the admin namespace exactly once,
// then bootstrap per-user contexts (engines, trackers, persistence timers) for
// every known user. New signups get their context created on demand.
await runFirstBootMigration('admin');
await initAllUserContexts();

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
  const datePath = join(ctx.reportsDir, `${report.date}.json`);
  const mdPath = join(ctx.reportsDir, `${report.date}.md`);
  const latestJsonPath = join(ctx.reportsDir, 'latest.json');
  const latestMdPath = join(ctx.reportsDir, 'latest.md');

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
  const snapshot = ctx.cryptoEngine.getReportSnapshot();
  const report = generateCryptoEodReport(snapshot);
  const datePath = join(ctx.cryptoReportsDir, `${report.date}.json`);
  const mdPath = join(ctx.cryptoReportsDir, `${report.date}.md`);
  const latestJsonPath = join(ctx.cryptoReportsDir, 'latest.json');
  const latestMdPath = join(ctx.cryptoReportsDir, 'latest.md');

  await Promise.all([
    writeFile(datePath, JSON.stringify(report, null, 2), 'utf-8'),
    writeFile(mdPath, report.markdown, 'utf-8'),
    writeFile(latestJsonPath, JSON.stringify(report, null, 2), 'utf-8'),
    writeFile(latestMdPath, report.markdown, 'utf-8'),
  ]);

  console.log(`[crypto-reports:${ctx.username}] EOD report saved → ${datePath}`);
}

async function generateAllUserEodReports(): Promise<void> {
  for (const ctx of getAllUserContexts()) {
    try {
      await generateAndSaveReport(ctx);
    } catch (err) {
      console.error(`[reports:${ctx.username}] EOD report failed:`, err);
    }
  }
}

// TRA-158 — server-side OTM mispricing scanner. Disabled (no_credentials) until
// TRADIER_API_TOKEN + TRADIER_ACCOUNT_ID are configured. Uses Yahoo's existing
// quote pipeline as the spot source so we don't pay for Tradier quotes too.
const otmMispricingService = new TradierOtmMispricingService({
  tradierApiToken: process.env['TRADIER_API_TOKEN'],
  tradierAccountId: process.env['TRADIER_ACCOUNT_ID'],
  tradierEnv: (process.env['TRADIER_ENV'] as 'sandbox' | 'production') ?? 'sandbox',
  fetchSpot: async (symbol) => {
    const quotes = await fetchQuotes([symbol]);
    const q = quotes.get(symbol);
    return q && q.price > 0 ? q.price : null;
  },
});

// ── REST endpoints ───────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// TRA-158 — surface live OTM mispricing scan output. Read-only, gated by auth.
// Returns up to `limit` ranked candidates and the diagnostics block so QA can
// see whether the breaker is open / cache is warm without needing server logs.
app.get('/api/options/otm-mispricing', requireAuth, async (req, res) => {
  const symbol = typeof req.query['symbol'] === 'string' ? req.query['symbol'] : '';
  if (!symbol) {
    res.status(400).json({ error: 'symbol query parameter is required' });
    return;
  }
  const limit = Math.max(1, Math.min(50, Number(req.query['limit'] ?? 10)));
  const minMispricing = req.query['minMispricing'] != null
    ? Number(req.query['minMispricing'])
    : undefined;

  const result = await otmMispricingService.scan(symbol, {
    mispricingThresholdPct: Number.isFinite(minMispricing) ? Number(minMispricing) : undefined,
  });
  res.json({
    ...result,
    candidates: result.candidates.slice(0, limit),
    diagnostics: otmMispricingService.diagnostics(),
  });
});

app.get('/api/health/options-mispricing', (_req, res) => {
  res.json(otmMispricingService.diagnostics());
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
  res.json(ctx.engine.getNews());
});

app.get('/api/reports/latest', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  const latestPath = join(ctx.reportsDir, 'latest.json');
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

app.get('/api/reports', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  try {
    const files = await readdir(ctx.reportsDir);
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
  const filePath = join(ctx.reportsDir, `${date}.json`);
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

app.get('/api/crypto/reports/latest', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  const latestPath = join(ctx.cryptoReportsDir, 'latest.json');
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

app.get('/api/crypto/reports', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  try {
    const files = await readdir(ctx.cryptoReportsDir);
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
  const filePath = join(ctx.cryptoReportsDir, `${date}.json`);
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
    managedAccountRatio: Math.max(0.01, Math.min(1, Number(body.managedAccountRatio ?? current.managedAccountRatio))),
    riskPerTrade: Math.max(0.001, Math.min(0.5, Number(body.riskPerTrade ?? current.riskPerTrade))),
  };
  await saveSettings(username, updated);
  ctx.engine.applySettings(updated);
  broadcastEngineState(ctx);
  ctx.cryptoEngine.applySettings(updated);
  broadcastCryptoState(ctx);
  res.json({ ok: true, settings: updated });
});

app.post('/api/account/reset-demo', requireAuth, async (_req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const settings = getSettings(username);
  ctx.engine.forceReset(settings);
  const cryptoEquity = settings.demoEquityCrypto ?? settings.demoEquity;
  ctx.cryptoEngine.forceReset(cryptoEquity);
  broadcastEngineState(ctx);
  broadcastCryptoState(ctx);
  res.json({ ok: true });
});

// ── Trading controls ──────────────────────────────────────────────────────────

app.post('/api/trading/start', requireAuth, async (_req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  ctx.engine.setAutoTrading(true);
  await saveSettings(username, { ...getSettings(username), stocksAutoTradingEnabled: true });
  broadcastEngineState(ctx);
  res.json({ ok: true, autoTradingEnabled: true });
});

app.post('/api/trading/stop', requireAuth, async (_req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  ctx.engine.setAutoTrading(false);
  await saveSettings(username, { ...getSettings(username), stocksAutoTradingEnabled: false });
  broadcastEngineState(ctx);
  res.json({ ok: true, autoTradingEnabled: false });
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
  const ctx = await userCtx(res);
  const { id } = req.params as Record<string, string>;
  const closed = ctx.engine.manualCloseOption(id);
  if (!closed) {
    res.status(404).json({ error: 'Option position not found' });
    return;
  }
  broadcastEngineState(ctx);
  res.json({ ok: true });
});

app.post('/api/crypto/trading/start', requireAuth, async (_req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  ctx.cryptoEngine.setAutoTrading(true);
  await saveSettings(username, { ...getSettings(username), cryptoAutoTradingEnabled: true });
  broadcastCryptoState(ctx);
  res.json({ ok: true, autoTradingEnabled: true });
});

app.post('/api/crypto/trading/stop', requireAuth, async (_req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  ctx.cryptoEngine.setAutoTrading(false);
  await saveSettings(username, { ...getSettings(username), cryptoAutoTradingEnabled: false });
  broadcastCryptoState(ctx);
  res.json({ ok: true, autoTradingEnabled: false });
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
  ctx.cryptoEngine.manualClosePosition(id, price);
  broadcastCryptoState(ctx);
  res.json({ ok: true });
});

// ── Data-source health check ─────────────────────────────────────────────────

app.get('/api/health/quotes', async (_req, res) => {
  const {
    testYahooFinance,
    testFinnhub,
    testTwelveData,
    testTiingo,
    isYahooBreakerOpen,
    isTiingoBreakerOpen,
    fetchMinuteBarsWithSource,
    getFallbackRequestCounts,
  } = await import('./yahoo-feed.js');
  const { testCoinMarketCap } = await import('./crypto-feed.js');
  const results: Record<string, unknown> = {};

  try {
    results['yahooFinance'] = await testYahooFinance();
  } catch (err: unknown) {
    results['yahooFinance'] = { error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const fh = await testFinnhub();
    results['finnhub'] = fh ?? { skipped: 'FINNHUB_API_KEY not set' };
  } catch (err: unknown) {
    results['finnhub'] = { error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const td = await testTwelveData();
    results['twelveData'] = td ?? { skipped: 'TWELVE_DATA_API_KEY not set' };
  } catch (err: unknown) {
    results['twelveData'] = { error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const tiingo = await testTiingo();
    results['tiingo'] = tiingo ?? { skipped: 'TIINGO_API_KEY not set' };
  } catch (err: unknown) {
    results['tiingo'] = { error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const cmc = await testCoinMarketCap();
    results['coinMarketCap'] = cmc ?? { skipped: 'CMC_API_KEY not set' };
  } catch (err: unknown) {
    results['coinMarketCap'] = { error: err instanceof Error ? err.message : String(err) };
  }

  // TRA-148/TRA-154/TRA-155: probe the actual minute-bar path the signal engine
  // uses, so QA can confirm the fallback chain engages while yahooBreakerOpen=true
  // without grepping logs. All provider diags are surfaced so QA can see *why* a
  // given tier returned nothing (plan-rejection 403, no_data, http error, etc.)
  // without redeploying with extra logging.
  try {
    const probe = await fetchMinuteBarsWithSource('AAPL', 60);
    results['chartFallback'] = {
      symbol: 'AAPL',
      bars: probe.bars.length,
      source: probe.source,
      yahooSkipped: probe.yahooSkipped,
      cached: probe.cached ?? false,
      finnhubDiag: probe.finnhubDiag ?? null,
      twelveDataDiag: probe.twelveDataDiag ?? null,
      tiingoDiag: probe.tiingoDiag ?? null,
    };
  } catch (err: unknown) {
    results['chartFallback'] = { error: err instanceof Error ? err.message : String(err) };
  }

  // TRA-154: surface daily fallback request counts so QA can see whether we're
  // approaching the free-tier caps (Twelve Data 800/day, Tiingo 1,000/day) before
  // the engine stalls. Resets at UTC midnight.
  results['fallbackRequestsToday'] = getFallbackRequestCounts();

  const ok = (key: string) => {
    const v = results[key];
    return v && typeof v === 'object' && !('error' in (v as object)) && !('skipped' in (v as object));
  };
  const stocksOk = ok('yahooFinance') || ok('finnhub');
  const cryptoOk = ok('yahooFinance') || ok('coinMarketCap');
  const allOk = stocksOk && cryptoOk;
  res.status(allOk ? 200 : 502).json({
    ok: allOk,
    stocksOk,
    cryptoOk,
    yahooBreakerOpen: isYahooBreakerOpen(),
    tiingoBreakerOpen: isTiingoBreakerOpen(),
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

  const latestPath = join(ctx.reportsDir, 'latest.json');
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
scheduler.start(generateAllUserEodReports);

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
