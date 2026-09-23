// TRA-4813 — HTTP surface for the TRA-4651 strategy lifecycle.
//
// This is the route the /api/cards comment always promised ("the TRA-4651
// lifecycle is the only intended consumer that can advance one") and never
// had. Same deps-injection shape as `registerPaperTradingRoutes`.
//
// Authority boundary (AC4): the ONLY intents accepted are `paper` (advance on
// a fill the TRA-4657 ledger already recorded under the TRA-4655 choke point)
// and `require_approval` (a named human approver on a machine already at
// `paper`). Anything else — `auto_execute` above all — is refused with 403
// before any machine is touched. The TRA-4750 option-book stand-down and the
// TRA-1653/1665 deploy pin hold; this surface grants no execution authority.

import type { Express, RequestHandler, Response } from 'express';
import { findAdmittedPaperFill, type LifecycleIntent, type LifecycleRing } from './lifecycle-manager.js';
import { getPaperLedgerRowsForDay, type PaperLedgerRow } from './paper-trading.js';
import { etDateKey } from './et-clock.js';

export interface LifecycleRouteDeps {
  requireAuth: RequestHandler;
  /** Resolve the per-user lifecycle ring (same user context as /api/cards). */
  ringFor: (res: Response) => Promise<LifecycleRing>;
  /** Authenticated operator identity — becomes the trail's actor / approver. */
  actorFor: (res: Response) => string;
  /** Today's paper ledger rows; injectable so tests feed fixtures. */
  paperRowsForToday?: () => readonly PaperLedgerRow[];
}

export function registerLifecycleRoutes(app: Express, deps: LifecycleRouteDeps): void {
  const paperRows = deps.paperRowsForToday ?? (() => getPaperLedgerRowsForDay(etDateKey(Date.now())));

  /** Fleet fold: state census + refusal targets + trail-replay verdicts. */
  app.get('/api/lifecycles', deps.requireAuth, async (_req, res) => {
    const ring = await deps.ringFor(res);
    res.json({
      asOf: new Date().toISOString(),
      summary: ring.summary(),
      items: ring.list().map((v) => ({
        signalId: v.signalId,
        symbol: v.symbol,
        state: v.state,
        disposition: v.disposition,
        terminal: v.terminal,
        trailOk: v.verify.ok,
      })),
    });
  });

  /** One machine: state, disposition, full audit trail, replay verdict. */
  app.get('/api/cards/:signalId/lifecycle', deps.requireAuth, async (req, res) => {
    const signalId = (req.params as Record<string, string>)['signalId'] ?? '';
    if (!signalId) {
      res.status(400).json({ error: 'signalId required' });
      return;
    }
    const ring = await deps.ringFor(res);
    const view = ring.view(signalId);
    if (!view) {
      res.status(404).json({ error: 'no lifecycle for signalId (evicted or never carded)' });
      return;
    }
    res.json(view);
  });

  /**
   * The advance path. Body: `{ intent: 'paper' | 'require_approval', note? }`.
   * A refusal is a FIRST-CLASS result (200, ok:false, reasons named, recorded
   * in the machine's trail) — not an HTTP error; the machine refusing is it
   * working. Only an unknown intent or a missing machine is an error status.
   */
  app.post('/api/cards/:signalId/lifecycle/advance', deps.requireAuth, async (req, res) => {
    const signalId = (req.params as Record<string, string>)['signalId'] ?? '';
    if (!signalId) {
      res.status(400).json({ error: 'signalId required' });
      return;
    }
    const body = (req.body ?? {}) as { intent?: unknown; note?: unknown };
    const intentRaw = typeof body.intent === 'string' ? body.intent : '';
    const note = typeof body.note === 'string' && body.note.trim().length > 0 ? body.note.trim() : undefined;
    const actor = deps.actorFor(res);

    let intent: LifecycleIntent;
    let provenanceNote: string;
    if (intentRaw === 'paper') {
      const { fill, note: fillNote } = findAdmittedPaperFill(signalId, [...paperRows()]);
      intent = { kind: 'paper', paperFill: fill, provenance: fillNote };
      provenanceNote = fillNote;
    } else if (intentRaw === 'require_approval') {
      intent = { kind: 'require_approval', approvedBy: actor, ...(note !== undefined ? { note } : {}) };
      provenanceNote = `approval requested by '${actor}'`;
    } else {
      // Refused BEFORE the machine is consulted: this surface has exactly two
      // intents, and execution is not one of them (TRA-4750 / TRA-1653/1665).
      res.status(403).json({
        error:
          `intent '${intentRaw || '(missing)'}' refused — this surface accepts only 'paper' and 'require_approval'; ` +
          'no execution authority exists here (TRA-4750 stand-down, TRA-1653/1665 deploy pin, TRA-4813 AC4)',
      });
      return;
    }

    const ring = await deps.ringFor(res);
    const result = ring.advanceIntent(signalId, intent, Date.now(), actor);
    if (!result.found) {
      res.status(404).json({ error: 'no lifecycle for signalId (evicted or never carded)', reasons: result.reasons });
      return;
    }
    res.json({
      ok: result.ok,
      state: result.state,
      disposition: result.disposition,
      reasons: result.reasons,
      note: provenanceNote,
    });
  });
}
