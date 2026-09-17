// TRA-4655 — HTTP surface for the hard operating controls.
//
// Auth asymmetry ON PURPOSE: engaging the kill switch or force-close is
// available to ANY authenticated user (halting is the safe direction — a
// one-click halt that first asks "are you admin?" is not one-click), while
// RELEASE is admin-only (resuming trading is the risky direction and gets the
// narrow gate). Same deps-injection shape as `registerLiveHealthRoutes`.

import type { Express, RequestHandler } from 'express';
import {
  admitOrderThroughHardControls,
  engageHardKillSwitch,
  getHardControlsState,
  hydrateHardControlsFromDisk,
  releaseHardKillSwitch,
  requestForceCloseAll,
  type HardControlIntent,
} from './hard-controls.js';

export interface HardControlRouteDeps {
  requireAuth: RequestHandler;
  requireAdmin: RequestHandler;
}

export function registerHardControlRoutes(app: Express, deps: HardControlRouteDeps): void {
  // Hydrate here rather than at import time: registration is the one point
  // that runs exactly once at boot, after DATA_DIR is settled.
  hydrateHardControlsFromDisk();

  /** Read-only state — the dashboard's source of truth for all seven controls. */
  app.get('/api/controls/hard', deps.requireAuth, (_req, res) => {
    res.json(getHardControlsState());
  });

  /** Engage the fleet-wide kill switch. Any authenticated user; one click. */
  app.post('/api/controls/hard/kill', deps.requireAuth, (req, res) => {
    const by = String(res.locals['authUser'] ?? 'unknown');
    const body = req.body as { reason?: unknown } | undefined;
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 280) : '';
    engageHardKillSwitch(by, reason);
    res.json({ ok: true, state: getHardControlsState() });
  });

  /** Release — admin only. Also clears the force-close latch (documented). */
  app.post('/api/controls/hard/kill/release', deps.requireAuth, deps.requireAdmin, (_req, res) => {
    releaseHardKillSwitch();
    res.json({ ok: true, state: getHardControlsState() });
  });

  /** One-click flatten. Engages the kill switch first, then runs every handler. */
  app.post('/api/controls/hard/force-close-all', deps.requireAuth, async (req, res) => {
    const by = String(res.locals['authUser'] ?? 'unknown');
    const body = req.body as { reason?: unknown } | undefined;
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 280) : 'operator request';
    const result = await requestForceCloseAll(by, reason);
    res.json({ ok: true, handlers: result.handlers, state: getHardControlsState() });
  });

  /**
   * Dry-run grade of a prospective order — for the dashboard's pre-flight and
   * for TRA-4650's verification harness. NOTE: an ALLOWED admit here CONSUMES
   * the idempotency key exactly as the real order path does; that is the
   * proof-of-block surface the acceptance criteria ask for, not a simulation.
   */
  app.post('/api/controls/hard/admit', deps.requireAuth, (req, res) => {
    const body = (req.body ?? {}) as Partial<HardControlIntent>;
    const intent: HardControlIntent = {
      kind: body.kind === 'close' ? 'close' : 'open',
      notionalUsd: Number(body.notionalUsd),
      openPositionCount: Number(body.openPositionCount),
      quoteAsOfMs: Number(body.quoteAsOfMs),
      idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '',
    };
    res.json(admitOrderThroughHardControls(intent));
  });
}
