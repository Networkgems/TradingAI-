// TRA-4657 — HTTP surface for the paper-trading ledger. Read-only: the
// ledger is written by the engine tees, never by an operator — a POST here
// would be a second entry path around the choke point. Same deps-injection
// shape as `registerHardControlRoutes`.

import type { Express, RequestHandler } from 'express';
import {
  buildPaperDailySummary,
  getPaperLedgerRowsForDay,
  getPaperTradingState,
  initPaperTrading,
} from './paper-trading.js';
import { etDateKey } from './et-clock.js';

export interface PaperTradingRouteDeps {
  requireAuth: RequestHandler;
}

/** `?day=YYYY-MM-DD`, defaulting to the current ET day; garbage is refused. */
function resolveDay(raw: unknown): string | null {
  if (raw == null || raw === '') return etDateKey(Date.now());
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

export function registerPaperTradingRoutes(app: Express, deps: PaperTradingRouteDeps): void {
  // Hydrate + register the paper force-close handler here: registration is
  // the one point that runs exactly once at boot, after DATA_DIR is settled.
  initPaperTrading();

  /** Book state + today's summary — the dashboard/ops source of truth. */
  app.get('/api/paper-trading', deps.requireAuth, (_req, res) => {
    res.json(getPaperTradingState());
  });

  /** Daily summary: signals · fills · refusals · theoretical P&L (AC 4). */
  app.get('/api/paper-trading/summary', deps.requireAuth, (req, res) => {
    const day = resolveDay(req.query['day']);
    if (!day) {
      res.status(400).json({ error: 'day must be YYYY-MM-DD' });
      return;
    }
    res.json(buildPaperDailySummary(day));
  });

  /** The raw per-signal / per-fill rows for one ET day (AC 2/3 evidence). */
  app.get('/api/paper-trading/rows', deps.requireAuth, (req, res) => {
    const day = resolveDay(req.query['day']);
    if (!day) {
      res.status(400).json({ error: 'day must be YYYY-MM-DD' });
      return;
    }
    res.json({ etDay: day, rows: getPaperLedgerRowsForDay(day) });
  });
}
