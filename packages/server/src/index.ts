import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { writeFile, readFile, readdir, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SignalEngine } from './signal-engine.js';
import { CryptoSignalEngine } from './crypto-engine.js';
import { MarketScheduler } from './scheduler.js';
import { generateEodReport } from './reports/eod-report.js';
import { generateCryptoEodReport } from './reports/crypto-eod-report.js';
import { createToken, verifyToken, generateResetToken, consumeResetToken } from './auth.js';
import { loadSettings, getSettings, saveSettings } from './account-settings.js';
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
import { PnlTracker } from './pnl-tracker.js';
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
import type { AccountSettings } from '@trading-app/shared';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';

const PORT = Number(process.env.PORT ?? 4242);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(__dirname, '..', 'reports');
const CRYPTO_REPORTS_DIR = join(__dirname, '..', 'crypto-reports');
const DATA_DIR = join(__dirname, '..', 'data');

if (!existsSync(REPORTS_DIR)) {
  await mkdir(REPORTS_DIR, { recursive: true });
}
if (!existsSync(CRYPTO_REPORTS_DIR)) {
  await mkdir(CRYPTO_REPORTS_DIR, { recursive: true });
}

// Load users before starting
await loadUsers();

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

// ── Engines ───────────────────────────────────────────────────────────────────

const initialSettings = await loadSettings();
const tracker = new PnlTracker(DATA_DIR, initialSettings.demoEquity);
const engine = new SignalEngine(initialSettings, tracker);
const cryptoEngine = new CryptoSignalEngine(initialSettings);
const scheduler = new MarketScheduler();

// Restore persisted watchlist overrides into engines
await initWatchlistStore();
const savedCrypto = getCryptoWatchlistData();
for (const sym of savedCrypto.hidden) cryptoEngine.removeSymbol(sym);
for (const sym of savedCrypto.added) cryptoEngine.addSymbol(sym);
const savedStocks = getStocksWatchlistData();
for (const sym of savedStocks.hidden) engine.removeSymbol(sym);
for (const sym of savedStocks.added) engine.addSymbol(sym);

// ── EOD Report generation ────────────────────────────────────────────────────

async function generateAndSaveReport(): Promise<void> {
  const snapshot = engine.getReportSnapshot();
  const report = generateEodReport(snapshot);
  const datePath = join(REPORTS_DIR, `${report.date}.json`);
  const mdPath = join(REPORTS_DIR, `${report.date}.md`);
  const latestJsonPath = join(REPORTS_DIR, 'latest.json');
  const latestMdPath = join(REPORTS_DIR, 'latest.md');

  await Promise.all([
    writeFile(datePath, JSON.stringify(report, null, 2), 'utf-8'),
    writeFile(mdPath, report.markdown, 'utf-8'),
    writeFile(latestJsonPath, JSON.stringify(report, null, 2), 'utf-8'),
    writeFile(latestMdPath, report.markdown, 'utf-8'),
  ]);

  // Persist daily equity snapshot for cumulative tracking
  const equitySnap = engine.getEquitySnapshot();
  tracker.saveSnapshot({
    date: report.date,
    openingEquity: tracker.getOpeningEquity(),
    closingEquity: equitySnap.equity,
    dailyPnl: equitySnap.equity - tracker.getOpeningEquity(),
    optionsPnl: equitySnap.optionsPnl,
    combinedPnl: (equitySnap.equity - tracker.getOpeningEquity()) + equitySnap.optionsPnl,
    trades: snapshot.allClosedPositions.length,
  });

  console.log(`[reports] EOD report saved → ${datePath}`);

  const msg = JSON.stringify({ type: 'eod_report', payload: report });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

async function generateAndSaveCryptoReport(): Promise<void> {
  const snapshot = cryptoEngine.getReportSnapshot();
  const report = generateCryptoEodReport(snapshot);
  const datePath = join(CRYPTO_REPORTS_DIR, `${report.date}.json`);
  const mdPath = join(CRYPTO_REPORTS_DIR, `${report.date}.md`);
  const latestJsonPath = join(CRYPTO_REPORTS_DIR, 'latest.json');
  const latestMdPath = join(CRYPTO_REPORTS_DIR, 'latest.md');

  await Promise.all([
    writeFile(datePath, JSON.stringify(report, null, 2), 'utf-8'),
    writeFile(mdPath, report.markdown, 'utf-8'),
    writeFile(latestJsonPath, JSON.stringify(report, null, 2), 'utf-8'),
    writeFile(latestMdPath, report.markdown, 'utf-8'),
  ]);

  console.log(`[crypto-reports] EOD report saved → ${datePath}`);
}

// ── REST endpoints ───────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
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
  res.json({ token: createToken(username.trim()) });
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body as { email?: string };
  if (typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ error: 'A valid email address is required' });
    return;
  }
  const user = getUserByEmail(email);
  // Always return success to prevent email enumeration
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
  res.json({ ok: true });
});

// ── State ─────────────────────────────────────────────────────────────────────

app.get('/api/state', requireAuth, (_req, res) => {
  res.json(engine.getState());
});

app.get('/api/crypto/state', requireAuth, (_req, res) => {
  res.json(cryptoEngine.getState());
});

app.get('/api/crypto/news', requireAuth, (_req, res) => {
  res.json(cryptoEngine.getNews());
});

app.get('/api/news', requireAuth, (_req, res) => {
  res.json(engine.getNews());
});

app.get('/api/reports/latest', requireAuth, async (_req, res) => {
  const latestPath = join(REPORTS_DIR, 'latest.json');
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
  try {
    const files = await readdir(REPORTS_DIR);
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
  const { date } = req.params as Record<string, string>;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    return;
  }
  const filePath = join(REPORTS_DIR, `${date}.json`);
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
    await generateAndSaveReport();
    res.json({ ok: true, message: 'EOD report generated successfully' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Crypto Reports ────────────────────────────────────────────────────────────

app.get('/api/crypto/reports/latest', requireAuth, async (_req, res) => {
  const latestPath = join(CRYPTO_REPORTS_DIR, 'latest.json');
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
  try {
    const files = await readdir(CRYPTO_REPORTS_DIR);
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
  const { date } = req.params as Record<string, string>;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    return;
  }
  const filePath = join(CRYPTO_REPORTS_DIR, `${date}.json`);
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
    await generateAndSaveCryptoReport();
    res.json({ ok: true, message: 'Crypto EOD report generated successfully' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/snapshots', requireAuth, (_req, res) => {
  res.json(tracker.getSnapshots());
});

// ── Account Settings ─────────────────────────────────────────────────────────

app.get('/api/account/settings', requireAuth, (_req, res) => {
  res.json(getSettings());
});

app.put('/api/account/settings', requireAuth, async (req, res) => {
  const body = req.body as Partial<AccountSettings>;
  const current = getSettings();
  const updated: AccountSettings = {
    ...current,
    ...body,
    demoEquity: Math.max(1_000, Math.min(10_000_000, Number(body.demoEquity ?? current.demoEquity))),
    dailyTradesLimit: Math.max(1, Math.min(100, Number(body.dailyTradesLimit ?? current.dailyTradesLimit))),
    managedAccountRatio: Math.max(0.01, Math.min(1, Number(body.managedAccountRatio ?? current.managedAccountRatio))),
    riskPerTrade: Math.max(0.001, Math.min(0.5, Number(body.riskPerTrade ?? current.riskPerTrade))),
  };
  await saveSettings(updated);
  engine.applySettings(updated);
  broadcastEngineState();
  cryptoEngine.applySettings(updated);
  broadcastCryptoState();
  res.json({ ok: true, settings: updated });
});

app.post('/api/account/reset-demo', requireAuth, async (_req, res) => {
  const settings = getSettings();
  engine.applySettings(settings);
  cryptoEngine.applySettings(settings);
  broadcastEngineState();
  broadcastCryptoState();
  res.json({ ok: true });
});

// ── Trading controls ──────────────────────────────────────────────────────────

app.post('/api/trading/start', requireAuth, (_req, res) => {
  engine.setAutoTrading(true);
  broadcastEngineState();
  res.json({ ok: true, autoTradingEnabled: true });
});

app.post('/api/trading/stop', requireAuth, (_req, res) => {
  engine.setAutoTrading(false);
  broadcastEngineState();
  res.json({ ok: true, autoTradingEnabled: false });
});

app.post('/api/positions/:id/close', requireAuth, (req, res) => {
  const { id } = req.params as Record<string, string>;
  const state = engine.getState();
  const pos = state.account.openPositions.find(p => p.id === id);
  if (!pos) {
    res.status(404).json({ error: 'Position not found' });
    return;
  }
  const sym = state.symbols.find(s => s.symbol === pos.symbol);
  const price = sym?.price ?? pos.entryPrice;
  engine.manualClosePosition(id, price);
  broadcastEngineState();
  res.json({ ok: true });
});

app.post('/api/options/:id/close', requireAuth, (req, res) => {
  const { id } = req.params as Record<string, string>;
  const closed = engine.manualCloseOption(id);
  if (!closed) {
    res.status(404).json({ error: 'Option position not found' });
    return;
  }
  broadcastEngineState();
  res.json({ ok: true });
});

app.post('/api/crypto/trading/start', requireAuth, (_req, res) => {
  cryptoEngine.setAutoTrading(true);
  broadcastCryptoState();
  res.json({ ok: true, autoTradingEnabled: true });
});

app.post('/api/crypto/trading/stop', requireAuth, (_req, res) => {
  cryptoEngine.setAutoTrading(false);
  broadcastCryptoState();
  res.json({ ok: true, autoTradingEnabled: false });
});

// ── Watchlist management ──────────────────────────────────────────────────────

app.get('/api/watchlist/crypto', requireAuth, (_req, res) => {
  res.json(getCryptoWatchlistData());
});

app.post('/api/watchlist/crypto', requireAuth, async (req, res) => {
  const { symbol } = req.body as { symbol?: string };
  if (typeof symbol !== 'string' || !symbol.trim()) {
    res.status(400).json({ error: 'symbol is required' });
    return;
  }
  const sym = symbol.trim().toUpperCase();
  await addCryptoSymbol(sym);
  cryptoEngine.addSymbol(sym);
  res.json({ ok: true, symbol: sym });
});

app.delete('/api/watchlist/crypto/:symbol', requireAuth, async (req, res) => {
  const raw = req.params['symbol'];
  const sym = (Array.isArray(raw) ? raw[0] : raw ?? '').toUpperCase();
  if (!sym) { res.status(400).json({ error: 'symbol is required' }); return; }
  await removeCryptoSymbol(sym);
  cryptoEngine.removeSymbol(sym);
  broadcastCryptoState();
  res.json({ ok: true });
});

app.post('/api/watchlist/crypto/scan', requireAuth, async (_req, res) => {
  try {
    const results = await scanCryptoMarket();
    for (const r of results) {
      await addCryptoSymbol(r.symbol);
      cryptoEngine.addSymbol(r.symbol);
    }
    res.json({ ok: true, added: results.map(r => r.symbol) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/watchlist/stocks', requireAuth, (_req, res) => {
  res.json(getStocksWatchlistData());
});

app.post('/api/watchlist/stocks', requireAuth, async (req, res) => {
  const { symbol } = req.body as { symbol?: string };
  if (typeof symbol !== 'string' || !symbol.trim()) {
    res.status(400).json({ error: 'symbol is required' });
    return;
  }
  const sym = symbol.trim().toUpperCase();
  await addStocksSymbol(sym);
  engine.addSymbol(sym);
  res.json({ ok: true, symbol: sym });
});

app.delete('/api/watchlist/stocks/:symbol', requireAuth, async (req, res) => {
  const raw = req.params['symbol'];
  const sym = (Array.isArray(raw) ? raw[0] : raw ?? '').toUpperCase();
  if (!sym) { res.status(400).json({ error: 'symbol is required' }); return; }
  await removeStocksSymbol(sym);
  engine.removeSymbol(sym);
  broadcastEngineState();
  res.json({ ok: true });
});

app.post('/api/watchlist/stocks/scan', requireAuth, async (_req, res) => {
  try {
    const results = await scanStocksMarket();
    for (const r of results) {
      await addStocksSymbol(r.symbol);
      engine.addSymbol(r.symbol);
    }
    res.json({ ok: true, added: results.map(r => r.symbol) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/crypto/positions/:id/close', requireAuth, (req, res) => {
  const { id } = req.params as Record<string, string>;
  const state = cryptoEngine.getState();
  const pos = state.account.openPositions.find(p => p.id === id);
  if (!pos) {
    res.status(404).json({ error: 'Position not found' });
    return;
  }
  const sym = state.symbols.find(s => s.symbol === pos.symbol);
  const price = sym?.price ?? pos.entryPrice;
  cryptoEngine.manualClosePosition(id, price);
  broadcastCryptoState();
  res.json({ ok: true });
});

// ── WebSocket ────────────────────────────────────────────────────────────────

const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });

function broadcastEngineState() {
  const msg = JSON.stringify({ type: 'state', payload: engine.getState() });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

function broadcastCryptoState() {
  const msg = JSON.stringify({ type: 'crypto_state', payload: cryptoEngine.getState() });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${firstHeader(req.headers.host) ?? 'localhost'}`);
  const token = url.searchParams.get('token') ?? '';
  const user = verifyToken(token);
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', async (ws) => {
  ws.send(JSON.stringify({ type: 'state', payload: engine.getState() }));
  ws.send(JSON.stringify({ type: 'crypto_state', payload: cryptoEngine.getState() }));

  const latestPath = join(REPORTS_DIR, 'latest.json');
  if (existsSync(latestPath)) {
    try {
      const raw = await readFile(latestPath, 'utf-8');
      ws.send(JSON.stringify({ type: 'eod_report', payload: JSON.parse(raw) }));
    } catch { /* ignore */ }
  }
});

engine.onTick((state) => {
  const msg = JSON.stringify({ type: 'state', payload: state });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
});

cryptoEngine.onTick((state) => {
  const msg = JSON.stringify({ type: 'crypto_state', payload: state });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
});

// ── Static frontend (production web) ────────────────────────────────────────
// When the Vite build exists alongside this server, serve it so the web PWA
// and the API share the same origin (avoids CORS and makes WS auth simpler).
const DIST_DIR = join(__dirname, '..', '..', '..', 'apps', 'desktop', 'dist');
if (existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  // SPA fallback: all non-API paths → index.html (supports React client-side routing)
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(join(DIST_DIR, 'index.html'));
  });
}

// ── Start ────────────────────────────────────────────────────────────────────

engine.start();
cryptoEngine.start();
scheduler.start(generateAndSaveReport);

httpServer.listen(PORT, () => {
  console.log(`Trading server running on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`Reports directory: ${REPORTS_DIR}`);
});

process.on('SIGINT', () => {
  engine.stop();
  cryptoEngine.stop();
  scheduler.stop();
  process.exit(0);
});
