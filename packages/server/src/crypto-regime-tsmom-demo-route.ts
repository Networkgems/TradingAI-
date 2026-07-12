// TRA-1317 (parent TRA-1316, board interaction `7042a614` answer = demo) — DEMO
// paper routing for the regime-gated TSMOM scanner.
//
// The board APPROVED promoting crypto Regime-TSMOM from observe-only to DEMO paper
// routing (via TRA-1316) — so the crypto dashboard shows movement and we accrue
// forward round-trip evidence at ZERO real-capital risk. Live promotion remains a
// separate future board decision.
//
// This module is the routing layer + its durable ledger. It owns a DEDICATED
// `CryptoPaperAccount` "route book" — completely separate from the per-user
// `CryptoEngine.account`, so routed fills never mix with the engine's own strategy
// book and are never touched by the engine's tick/checkExits (the SCANNER owns
// entry AND exit here). The route book has NO live-broker path whatsoever, so
// arming the flag on the single production instance (bqb1) is structurally
// incapable of opening real capital (mirrors the TRA-1294 take-profit-early
// demo-scoping guarantee).
//
// Sizing REUSES the existing demo crypto convention verbatim: we build a
// `TradeSignal` (entry = the scanner's would-be entry price, stop = the §5 1R
// vol-target σ below entry) and hand it to `CryptoPaperAccount.openPosition`, which
// applies the SAME risk-per-trade / managed-equity caps + Coinbase taker-fee model
// the user's demo crypto book uses. No new sizing is invented here.
//
// Routing rule (spec §2): when armed AND the scanner emits `enter_long` we open one
// paper long per symbol; when it emits `exit_long` we close that symbol's open route
// position at the scanner's would-be exit price. The scanner already guarantees a
// single transition per bar (no exit-and-re-enter same pass), so this layer never
// double-fills.
//
// Persistence (spec §3): mirrors the TRA-1264 scanner persistence + TRA-1278/1300
// ledger pattern — an append-only JSONL fills audit AND a small state snapshot
// (the route-book account + counters), both under DATA_DIR, hydrated on boot so an
// open paper position and the realized-R accrual survive the ~daily Render demo
// reboot.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { tsmomSizingStopFraction } from '@trading-app/engine';
import type { Position, TradeSignal } from '@trading-app/shared';
import { CryptoPaperAccount } from './crypto-account.js';
import type { RegimeTsmomConfig } from './crypto-regime-tsmom-flag.js';
import type { RegimeTsmomResult } from './crypto-regime-tsmom-scanner.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'crypto-regime-tsmom-demo-route' });

export const REGIME_TSMOM_DEMO_ROUTE_FILLS_FILENAME = 'crypto-regime-tsmom-demo-route-fills.jsonl';
export const REGIME_TSMOM_DEMO_ROUTE_STATE_FILENAME = 'crypto-regime-tsmom-demo-route-state.json';

/** The signalType stamped on routed positions so the dashboard/audit can attribute them. */
const ROUTE_SIGNAL_TYPE = 'tsmom_majors' as const;

/** Rolling recent-fills retention for the health tail (counters stay complete). */
const MAX_RECENT_FILLS = 50;

/** One durable route fill event (open or close) — the paper-routing audit unit. */
export interface RegimeTsmomDemoFill {
  /** Fill time, ms epoch. */
  ts: number;
  event: 'open' | 'close';
  symbol: string;
  /** Route-book position id (stable across the open→close pair). */
  positionId: string;
  side: 'buy';
  /** Units filled (fractional crypto). */
  qty: number;
  /** Fill price — the scanner's would-be entry price (open) or exit price (close). */
  price: number;
  /** ISO of the 4H bar that drove the transition, or null. */
  barTime: string | null;
  /** close-only — the entry price the round trip opened at. */
  entryPrice?: number;
  /** close-only — the scanner's net-of-taker round-trip R (§5 1R units). */
  netR?: number;
  /** close-only — the scanner's net-of-taker directional move %. */
  netMovePct?: number;
  /** close-only — the route book's realized $ PnL on the close (fee-aware). */
  pnl?: number;
  /** Always 'demo' — this book has no live path. */
  mode: 'demo';
}

/** The snapshot persisted alongside the JSONL (latest-wins, rewritten each routed pass). */
export interface RegimeTsmomDemoRouteSnapshot {
  version: 1;
  /** Serialized route-book account (cash/equity/openPositions) so open fills survive a restart. */
  account: ReturnType<CryptoPaperAccount['exportSnapshot']>;
  /** Monotonic count of every fill event (open + close) ever recorded. */
  fillCount: number;
  /** Monotonic count of closed round trips (close events). */
  closeCount: number;
  /** Σ net-of-taker R over closed round trips (the forward evidence the live gate needs). */
  realizedR: number;
  /** Σ route-book realized $ PnL over closes (fee-aware). */
  realizedPnl: number;
  firstFillAt: number | null;
  lastFillAt: number | null;
  updatedAt: number;
}

// ── Module-global route book + counters (backs the health demoRoute block) ────

let dataDir: string | null = null;
let account: CryptoPaperAccount | null = null;
let fillCount = 0;
let closeCount = 0;
let realizedR = 0;
let realizedPnl = 0;
let firstFillAt: number | null = null;
let lastFillAt: number | null = null;
const recentFills: RegimeTsmomDemoFill[] = [];

/**
 * The route book, constructed on FIRST USE rather than at module scope. Constructing it
 * eagerly made module init depend on the `CryptoPaperAccount` binding being ready, which
 * it is not when the import graph is entered at crypto-account.ts (TRA-1674).
 */
function routeBook(): CryptoPaperAccount {
  if (account == null) account = new CryptoPaperAccount();
  return account;
}

export function regimeTsmomDemoRouteFillsPath(dir: string): string {
  return join(dir, REGIME_TSMOM_DEMO_ROUTE_FILLS_FILENAME);
}

export function regimeTsmomDemoRouteStatePath(dir: string): string {
  return join(dir, REGIME_TSMOM_DEMO_ROUTE_STATE_FILENAME);
}

/** Test seam — reset the route book, counters, and configured dir to a clean slate. */
export function clearRegimeTsmomDemoRoute(): void {
  dataDir = null;
  account = null; // lazily reconstructed by routeBook() on next use
  fillCount = 0;
  closeCount = 0;
  realizedR = 0;
  realizedPnl = 0;
  firstFillAt = null;
  lastFillAt = null;
  recentFills.length = 0;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Fold one fill into the in-memory counters + rolling tail (no IO). */
function applyFillCounters(fill: RegimeTsmomDemoFill): void {
  fillCount += 1;
  if (fill.event === 'close') {
    closeCount += 1;
    if (Number.isFinite(fill.netR)) realizedR += fill.netR as number;
    if (Number.isFinite(fill.pnl)) realizedPnl += fill.pnl as number;
  }
  if (firstFillAt == null || fill.ts < firstFillAt) firstFillAt = fill.ts;
  if (lastFillAt == null || fill.ts > lastFillAt) lastFillAt = fill.ts;
  recentFills.push(fill);
  while (recentFills.length > MAX_RECENT_FILLS) recentFills.shift();
}

/** Append one fill to the JSONL audit (best-effort — a write failure never breaks routing). */
function appendFill(fill: RegimeTsmomDemoFill): void {
  if (dataDir == null) return;
  const path = regimeTsmomDemoRouteFillsPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendFileSync(path, JSON.stringify(fill) + '\n', 'utf8');
  } catch (err) {
    log.warn('regime-tsmom demo-route fill append failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Rewrite the state snapshot so the open route book + counters survive a restart. */
function writeSnapshot(now: number): void {
  if (dataDir == null) return;
  const snapshot: RegimeTsmomDemoRouteSnapshot = {
    version: 1,
    account: routeBook().exportSnapshot(),
    fillCount,
    closeCount,
    realizedR: round2(realizedR),
    realizedPnl: round2(realizedPnl),
    firstFillAt,
    lastFillAt,
    updatedAt: now,
  };
  const path = regimeTsmomDemoRouteStatePath(dataDir);
  try {
    writeFileSync(path, JSON.stringify(snapshot), 'utf8');
  } catch (err) {
    log.warn('regime-tsmom demo-route snapshot write failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The open route position for `symbol` (single long per symbol), or null. */
function openPositionForSymbol(symbol: string): Position | null {
  const key = symbol.trim().toUpperCase();
  for (const p of routeBook().getState().openPositions) {
    if (p.symbol.trim().toUpperCase() === key) return p;
  }
  return null;
}

/**
 * Build the entry `TradeSignal` for a would-be long. The stop is placed one §5 1R
 * (the daily vol-target σ, `(v/100)/√365`) below entry so `CryptoPaperAccount`'s
 * risk-per-trade sizing produces the SAME quantity convention the demo book already
 * uses; the take-profit sits a wide 4R away (the route book is never ticked, so this
 * TP never auto-fires — the SCANNER owns the exit). No new sizing is invented.
 */
function buildEntrySignal(symbol: string, entryPrice: number, cfg: RegimeTsmomConfig): TradeSignal {
  const stopFrac = tsmomSizingStopFraction(cfg.volTargetPct);
  const safeFrac = Number.isFinite(stopFrac) && stopFrac > 0 ? stopFrac : 0.02;
  const stopLoss = entryPrice * (1 - safeFrac);
  const takeProfit = entryPrice * (1 + 4 * safeFrac);
  return {
    id: randomUUID(),
    symbol,
    type: ROUTE_SIGNAL_TYPE,
    side: 'buy',
    entryPrice,
    stopLoss,
    takeProfit,
    riskRewardRatio: 4,
    timestamp: Date.now(),
    mode: 'demo',
  };
}

export interface RouteRegimeTsmomOutcome {
  opened: number;
  closed: number;
  fills: RegimeTsmomDemoFill[];
}

/**
 * Route a batch of scanner results into the DEMO paper route book. For each result:
 *   • `enter_long` (and no open route position for the symbol) → open one paper long
 *     sized by the reused demo crypto convention, at the would-be entry price;
 *   • `exit_long` (with a completed round trip) → close the symbol's open route
 *     position at the would-be exit price and accrue the scanner's net-of-taker R.
 * Any other action is a no-op. Persists a JSONL fill per open/close and rewrites the
 * state snapshot when anything changed. DEMO-only: the route book has no live path.
 * The caller MUST gate on {@link isRegimeTsmomDemoRouteEnabled} before calling.
 */
export function routeRegimeTsmomResults(
  results: readonly RegimeTsmomResult[],
  cfg: RegimeTsmomConfig,
  now: number = Date.now(),
): RouteRegimeTsmomOutcome {
  const fills: RegimeTsmomDemoFill[] = [];
  let opened = 0;
  let closed = 0;

  for (const r of results) {
    const symbol = r.symbol.trim().toUpperCase();
    if (symbol === '') continue;

    if (r.action === 'enter_long') {
      const entry = r.wouldBeEntryPrice;
      if (entry == null || !(entry > 0) || !Number.isFinite(entry)) continue;
      if (openPositionForSymbol(symbol)) continue; // already long (single transition/bar)
      const pos = routeBook().openPosition(buildEntrySignal(symbol, entry, cfg), entry, 'coinbase');
      if (!pos) continue; // sizing/cash rejected — no fill
      pos.signalType = ROUTE_SIGNAL_TYPE;
      pos.mode = 'demo';
      const fill: RegimeTsmomDemoFill = {
        ts: now,
        event: 'open',
        symbol,
        positionId: pos.id,
        side: 'buy',
        qty: pos.quantity,
        price: entry,
        barTime: r.lastBarTime,
        mode: 'demo',
      };
      applyFillCounters(fill);
      appendFill(fill);
      fills.push(fill);
      opened += 1;
    } else if (r.action === 'exit_long' && r.roundTrip) {
      const pos = openPositionForSymbol(symbol);
      if (!pos) continue; // nothing to close (e.g. hydrated mid-trip mismatch)
      const exitPrice = r.roundTrip.exitPrice;
      const closedPos = routeBook().closePosition(pos.id, exitPrice);
      if (!closedPos) continue;
      const fill: RegimeTsmomDemoFill = {
        ts: now,
        event: 'close',
        symbol,
        positionId: pos.id,
        side: 'buy',
        qty: closedPos.quantity,
        price: exitPrice,
        barTime: r.roundTrip.exitBarTime,
        entryPrice: closedPos.entryPrice,
        netR: r.roundTrip.netR,
        netMovePct: r.roundTrip.netMovePct,
        pnl: closedPos.pnl != null ? round2(closedPos.pnl) : undefined,
        mode: 'demo',
      };
      applyFillCounters(fill);
      appendFill(fill);
      fills.push(fill);
      closed += 1;
    }
  }

  if (opened > 0 || closed > 0) writeSnapshot(now);
  return { opened, closed, fills };
}

/**
 * The route book's open paper positions, stamped for the dashboard. Handed to the
 * demo crypto dashboard feed (via the CryptoEngine external-positions provider) so
 * the board sees the routed longs as "movement". Read-only — a defensive copy.
 */
export function getRegimeTsmomDemoRoutePositions(): Position[] {
  return routeBook().getState().openPositions.map((p) => ({
    ...p,
    signalType: ROUTE_SIGNAL_TYPE,
    mode: 'demo' as const,
  }));
}

/** What {@link hydrateRegimeTsmomDemoRouteFromDisk} recovered (for the boot log line). */
export interface RegimeTsmomDemoRouteHydration {
  openPositions: number;
  fillCount: number;
  closeCount: number;
  realizedR: number;
}

/**
 * Rebuild the route book + counters from the state snapshot on boot and remember
 * `dir` for subsequent appends. Idempotent: CLEARS first, so it is safe to call
 * once at startup before any routed pass. The snapshot is authoritative for the
 * open book + counters (the JSONL is the append-only audit); a missing/corrupt
 * snapshot yields an empty (clean) route book rather than throwing.
 */
export function hydrateRegimeTsmomDemoRouteFromDisk(dir: string): RegimeTsmomDemoRouteHydration {
  clearRegimeTsmomDemoRoute();
  dataDir = dir;

  let snapshot: RegimeTsmomDemoRouteSnapshot | null = null;
  try {
    snapshot = JSON.parse(readFileSync(regimeTsmomDemoRouteStatePath(dir), 'utf8')) as RegimeTsmomDemoRouteSnapshot;
  } catch {
    snapshot = null; // absent/corrupt ⇒ clean book
  }
  if (snapshot && snapshot.account) {
    try {
      routeBook().importSnapshot(snapshot.account);
    } catch {
      account = new CryptoPaperAccount(); // corrupt snapshot ⇒ clean book
    }
    fillCount = Number.isFinite(snapshot.fillCount) ? snapshot.fillCount : 0;
    closeCount = Number.isFinite(snapshot.closeCount) ? snapshot.closeCount : 0;
    realizedR = Number.isFinite(snapshot.realizedR) ? snapshot.realizedR : 0;
    realizedPnl = Number.isFinite(snapshot.realizedPnl) ? snapshot.realizedPnl : 0;
    firstFillAt = snapshot.firstFillAt ?? null;
    lastFillAt = snapshot.lastFillAt ?? null;
  }

  return {
    openPositions: routeBook().getState().openPositions.length,
    fillCount,
    closeCount,
    realizedR: round2(realizedR),
  };
}

// ── Health summary (backs the demoRoute block on /api/health/crypto-regime-tsmom) ──

export interface RegimeTsmomDemoRouteSummary {
  /** Open paper positions currently held in the route book. */
  openPositions: number;
  /** Total fill events (open + close) recorded — survives restart. */
  fillCount: number;
  /** Closed round trips recorded. */
  closeCount: number;
  /** ms epoch of the most recent fill, or null. */
  lastFillAt: number | null;
  /** Σ net-of-taker R over closed round trips (the live-gate forward evidence). */
  realizedR: number;
  /** Σ route-book realized $ PnL over closes (fee-aware). */
  realizedPnl: number;
  /** Most-recent fills, oldest→newest (capped tail). */
  recent: RegimeTsmomDemoFill[];
}

/**
 * Fold the route book into the read-only demoRoute diagnostics. Pure — no IO. The
 * counters are monotonic and rebuilt from the snapshot on boot, so they are the
 * since-arm forward sample the (future) live-promotion decision reads.
 */
export function summarizeRegimeTsmomDemoRoute(): RegimeTsmomDemoRouteSummary {
  return {
    openPositions: routeBook().getState().openPositions.length,
    fillCount,
    closeCount,
    lastFillAt,
    realizedR: round2(realizedR),
    realizedPnl: round2(realizedPnl),
    recent: recentFills.slice(-MAX_RECENT_FILLS),
  };
}
