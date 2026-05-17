// TRA-406 — trade audit log.
//
// An append-only `<LOG_DIR>/trade-audit.jsonl` recording who / what / when for
// every position open and close, across both the equity and crypto engines,
// demo and live. This is deliberately separate from the trade-history JSON the
// dashboard reads: trade history is mutable product state (it gets rewritten,
// backed up, restored), whereas the audit log is an immutable forensic record
// — if a live close looked wrong, this is the file you reach for.
//
// Capture point: rather than threading a callback through every execution path
// in the engines, the audit is derived by diffing successive engine-state
// snapshots (`TradeAuditTracker`). A position id that appears in `openPositions`
// is an open; one that leaves it is a close. This is a single, reliable choke
// point that covers automated and manual trades identically.

import { join } from 'path';
import { appendJsonLine, LOG_DIR, logger } from './logger.js';

const AUDIT_LOG_FILE = join(LOG_DIR, 'trade-audit.jsonl');

export type AuditEngine = 'equity' | 'crypto';

export interface TradeAuditEntry {
  ts: string;
  action: 'open' | 'close';
  /** Account owner — the "who". */
  user: string;
  engine: AuditEngine;
  positionId: string;
  symbol: string;
  side?: string;
  signalType?: string;
  quantity?: number;
  entryPrice?: number;
  exitPrice?: number;
  pnl?: number;
  exitReason?: string;
  openedAt?: number;
  closedAt?: number;
}

/** Loosely-typed view of an engine position — avoids coupling to a concrete
 *  `Position` shape that differs slightly between the equity / crypto engines. */
export interface AuditPositionLike {
  id: string;
  symbol: string;
  side?: string;
  signalType?: string;
  entryPrice?: number;
  quantity?: number;
  openedAt?: number;
  closedAt?: number;
  exitPrice?: number;
  pnl?: number;
  exitReason?: string;
}

export interface AuditStateLike {
  account?: { openPositions?: AuditPositionLike[] } | undefined;
  closedPositions?: AuditPositionLike[] | undefined;
}

/** Per-ET-date count of position opens — feeds the trade-volume-zero alert. */
const openCountByEtDate = new Map<string, number>();

function etDateKey(d = new Date()): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Number of positions opened (across all users/engines) on the given ET date. */
export function getTradeOpenCount(etDate: string = etDateKey()): number {
  return openCountByEtDate.get(etDate) ?? 0;
}

/** Append one audit entry. Never throws — auditing must not break a trade. */
export async function recordTradeAudit(entry: TradeAuditEntry): Promise<void> {
  if (entry.action === 'open') {
    const key = etDateKey();
    openCountByEtDate.set(key, (openCountByEtDate.get(key) ?? 0) + 1);
    // Keep the map small — only the last few days matter.
    if (openCountByEtDate.size > 7) {
      const oldest = [...openCountByEtDate.keys()].sort()[0];
      if (oldest) openCountByEtDate.delete(oldest);
    }
  }
  logger.info(`trade ${entry.action}`, {
    module: 'audit',
    action: entry.action,
    user: entry.user,
    engine: entry.engine,
    symbol: entry.symbol,
    positionId: entry.positionId,
    ...(entry.pnl !== undefined ? { pnl: entry.pnl } : {}),
  });
  if (process.env['NODE_ENV'] === 'test') return;
  await appendJsonLine(AUDIT_LOG_FILE, JSON.stringify(entry));
}

function buildEntry(
  action: 'open' | 'close',
  user: string,
  engine: AuditEngine,
  p: AuditPositionLike,
): TradeAuditEntry {
  return {
    ts: new Date().toISOString(),
    action,
    user,
    engine,
    positionId: p.id,
    symbol: p.symbol,
    ...(p.side !== undefined ? { side: p.side } : {}),
    ...(p.signalType !== undefined ? { signalType: p.signalType } : {}),
    ...(p.quantity !== undefined ? { quantity: p.quantity } : {}),
    ...(p.entryPrice !== undefined ? { entryPrice: p.entryPrice } : {}),
    ...(p.exitPrice !== undefined ? { exitPrice: p.exitPrice } : {}),
    ...(p.pnl !== undefined ? { pnl: p.pnl } : {}),
    ...(p.exitReason !== undefined ? { exitReason: p.exitReason } : {}),
    ...(p.openedAt !== undefined ? { openedAt: p.openedAt } : {}),
    ...(p.closedAt !== undefined ? { closedAt: p.closedAt } : {}),
  };
}

/**
 * Tracks one user's positions for a single engine and emits an audit entry
 * each time a position enters or leaves the open book.
 *
 * The first `observe()` after construction only seeds the baseline — positions
 * that already existed at boot are not re-audited as fresh opens.
 */
export class TradeAuditTracker {
  private readonly openSnapshots = new Map<string, AuditPositionLike>();
  private bootstrapped = false;

  constructor(
    private readonly user: string,
    private readonly engine: AuditEngine,
  ) {}

  /** Diff the latest engine state against the last one and audit the delta. */
  observe(state: AuditStateLike): void {
    const open = state.account?.openPositions ?? [];
    const closed = state.closedPositions ?? [];
    const closedById = new Map(closed.map((p) => [p.id, p]));
    const nextIds = new Set(open.map((p) => p.id));

    if (!this.bootstrapped) {
      for (const p of open) this.openSnapshots.set(p.id, p);
      this.bootstrapped = true;
      return;
    }

    for (const p of open) {
      if (!this.openSnapshots.has(p.id)) {
        void recordTradeAudit(buildEntry('open', this.user, this.engine, p));
      }
      this.openSnapshots.set(p.id, p);
    }

    for (const [id, snapshot] of [...this.openSnapshots]) {
      if (nextIds.has(id)) continue;
      const closedPos = closedById.get(id) ?? snapshot;
      void recordTradeAudit(buildEntry('close', this.user, this.engine, closedPos));
      this.openSnapshots.delete(id);
    }
  }
}
