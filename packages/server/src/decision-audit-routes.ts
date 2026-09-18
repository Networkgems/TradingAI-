// TRA-4658 — HTTP surface for the decision audit log. READ-ONLY: the trail
// is written by the engine/choke-point tees, never by an operator — a POST
// here would be a second entry path around the recorders, and an audit trail
// with a write route is an audit trail someone can pre-fill. Same
// deps-injection shape as `registerPaperTradingRoutes`.

import type { Express, RequestHandler } from 'express';
import {
  DECISION_AUDIT_CATEGORIES,
  decisionAuditEventsToCsv,
  getDecisionAuditState,
  initDecisionAuditLog,
  queryDecisionAudit,
  type DecisionAuditCategory,
  type DecisionAuditFilter,
} from './decision-audit-log.js';
import { etDateKey } from './et-clock.js';

export interface DecisionAuditRouteDeps {
  requireAuth: RequestHandler;
}

function dayOrNull(raw: unknown): string | null | undefined {
  if (raw == null || raw === '') return undefined;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

function strOrUndef(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

/** Parse the shared query params; null ⇒ a 400 was already the right answer. */
function parseFilter(query: Record<string, unknown>): { filter: DecisionAuditFilter } | { error: string } {
  const fromDay = dayOrNull(query['from']);
  const toDay = dayOrNull(query['to']);
  const day = dayOrNull(query['day']);
  if (fromDay === null || toDay === null || day === null) {
    return { error: 'from/to/day must be YYYY-MM-DD' };
  }
  if (day !== undefined && (fromDay !== undefined || toDay !== undefined)) {
    return { error: 'pass either day or from/to, not both' };
  }
  const category = strOrUndef(query['category']);
  if (category !== undefined && !DECISION_AUDIT_CATEGORIES.includes(category as DecisionAuditCategory)) {
    return { error: `category must be one of ${DECISION_AUDIT_CATEGORIES.join('|')}` };
  }
  let limit: number | undefined;
  const rawLimit = strOrUndef(query['limit']);
  if (rawLimit !== undefined) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit <= 0) return { error: 'limit must be a positive integer' };
  }
  return {
    filter: {
      fromDay: day ?? fromDay,
      toDay: day ?? toDay,
      category: category as DecisionAuditCategory | undefined,
      action: strOrUndef(query['action']),
      strategy: strOrUndef(query['strategy']),
      symbol: strOrUndef(query['symbol']),
      outcome: strOrUndef(query['outcome']),
      positionId: strOrUndef(query['positionId']),
      signalId: strOrUndef(query['signalId']),
      limit,
    },
  };
}

export function registerDecisionAuditRoutes(app: Express, deps: DecisionAuditRouteDeps): void {
  // Boot-time retention sweep here: registration is the one point that runs
  // exactly once at boot, after DATA_DIR is settled.
  initDecisionAuditLog();

  /** Search/filter by date, category, strategy, symbol, outcome (AC 5). */
  app.get('/api/audit/decisions', deps.requireAuth, (req, res) => {
    const parsed = parseFilter(req.query as Record<string, unknown>);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    res.json(queryDecisionAudit(parsed.filter));
  });

  /** CSV export with every envelope field (AC 3), same filters as the JSON route. */
  app.get('/api/audit/decisions.csv', deps.requireAuth, (req, res) => {
    const parsed = parseFilter(req.query as Record<string, unknown>);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const result = queryDecisionAudit(parsed.filter);
    const name = `decision-audit-${result.fromDay}${result.fromDay === result.toDay ? '' : `-to-${result.toDay}`}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(decisionAuditEventsToCsv(result.events));
  });

  /**
   * Health/coverage counters — the discriminator surface. A broken audit log
   * does NOT read like a quiet day here: `appendFailures`/`droppedInputs`
   * count every suppressed write, and `ephemeral: true` says the disk the
   * trail sits on will not survive a redeploy.
   */
  app.get('/api/audit/decisions/state', deps.requireAuth, (_req, res) => {
    res.json({ ...getDecisionAuditState(), today: etDateKey(Date.now()) });
  });
}
