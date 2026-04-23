import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { SignalEngine } from './signal-engine.js';

const PORT = Number(process.env.PORT ?? 4242);
const app = express();

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.use(express.json());

const engine = new SignalEngine();

app.get('/api/state', (_req, res) => {
  res.json(engine.getState());
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  // Send current state immediately on connect
  ws.send(JSON.stringify({ type: 'state', payload: engine.getState() }));
});

engine.onTick((state) => {
  const msg = JSON.stringify({ type: 'state', payload: state });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
});

engine.start();

httpServer.listen(PORT, () => {
  console.log(`Trading server running on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
});

process.on('SIGINT', () => {
  engine.stop();
  process.exit(0);
});
