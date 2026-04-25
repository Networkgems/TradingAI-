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
import { PnlTracker } from './pnl-tracker.js';

const PORT = Number(process.env.PORT ?? 4242);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(__dirname, '..', 'reports');
const DATA_DIR = join(__dirname, '..', 'data');

// Ensure directories exist
if (!existsSync(REPORTS_DIR)) {
  await mkdir(REPORTS_DIR, { recursive: true });
}

const app = express();

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.use(express.json());

const tracker = new PnlTracker(DATA_DIR);
const engine = new SignalEngine(tracker);
const cryptoEngine = new CryptoSignalEngine();
const scheduler = new MarketScheduler();

// ── EOD Report generation ────────────────────────────────────────────────────

async function generateAndSaveReport(): Promise<void> {
  const snapshot = engine.getReportSnapshot();
  const report = generateEodReport(snapshot);
  const datePath = join(REPORTS_DIR, `${report.date}.json`);
  const mdPath = join(REPORTS_DIR, `${report.date}.md`);
  const latestJsonPath = join(REPORTS_DIR, 'latest.json');
  const latestMdPath = join(REPORTS_DIR, 'latest.md');

  // Save daily P&L snapshot for cumulative tracking
  const equitySnap = engine.getEquitySnapshot();
  tracker.saveSnapshot({
    date: report.date,
    openingEquity: tracker.getOpeningEquity(),
    closingEquity: equitySnap.equity,
    dailyPnl: report.realizedPnl + report.unrealizedPnl,
    optionsPnl: report.optionsPnl,
    combinedPnl: report.combinedPnl,
    trades: report.totalTrades,
  });

  await Promise.all([
    writeFile(datePath, JSON.stringify(report, null, 2), 'utf-8'),
    writeFile(mdPath, report.markdown, 'utf-8'),
    writeFile(latestJsonPath, JSON.stringify(report, null, 2), 'utf-8'),
    writeFile(latestMdPath, report.markdown, 'utf-8'),
  ]);

  console.log(`[reports] EOD report saved → ${datePath}`);

  // Broadcast report event to all WebSocket clients
  const msg = JSON.stringify({ type: 'eod_report', payload: report });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

// ── REST endpoints ───────────────────────────────────────────────────────────

app.get('/api/state', (_req, res) => {
  res.json(engine.getState());
});

app.get('/api/crypto/state', (_req, res) => {
  res.json(cryptoEngine.getState());
});

app.get('/api/crypto/news', (_req, res) => {
  res.json(cryptoEngine.getNews());
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/api/reports/latest', async (_req, res) => {
  const latestPath = join(REPORTS_DIR, 'latest.json');
  if (!existsSync(latestPath)) {
    return res.status(404).json({ error: 'No report generated yet' });
  }
  try {
    const raw = await readFile(latestPath, 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.status(500).json({ error: 'Failed to read report' });
  }
});

app.get('/api/reports', async (_req, res) => {
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

app.get('/api/reports/:date', async (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
  }
  const filePath = join(REPORTS_DIR, `${date}.json`);
  if (!existsSync(filePath)) {
    return res.status(404).json({ error: `No report for ${date}` });
  }
  try {
    const raw = await readFile(filePath, 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.status(500).json({ error: 'Failed to read report' });
  }
});

// Manual trigger endpoint (for testing / on-demand)
app.post('/api/reports/generate', async (_req, res) => {
  try {
    await generateAndSaveReport();
    res.json({ ok: true, message: 'EOD report generated successfully' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Historical P&L snapshots for the analytics view
app.get('/api/snapshots', (_req, res) => {
  res.json(tracker.getSnapshots());
});

// ── WebSocket ────────────────────────────────────────────────────────────────

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', async (ws) => {
  // Send current trading state immediately on connect
  ws.send(JSON.stringify({ type: 'state', payload: engine.getState() }));
  ws.send(JSON.stringify({ type: 'crypto_state', payload: cryptoEngine.getState() }));

  // Also send latest report if available
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
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
});

cryptoEngine.onTick((state) => {
  const msg = JSON.stringify({ type: 'crypto_state', payload: state });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
});

// ── Start ────────────────────────────────────────────────────────────────────

engine.start();
cryptoEngine.start();
scheduler.start(generateAndSaveReport);

httpServer.listen(PORT, () => {
  console.log(`Trading server running on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`Reports directory: ${REPORTS_DIR}`);
  console.log(`Data directory: ${DATA_DIR}`);
});

process.on('SIGINT', () => {
  engine.stop();
  cryptoEngine.stop();
  scheduler.stop();
  process.exit(0);
});
