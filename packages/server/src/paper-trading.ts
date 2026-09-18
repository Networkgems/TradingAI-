// TRA-4657 — paper trading with live data: the theoretical book the go-live
// decision is graded against.
//
// The demo book already runs every strategy against the live feed, but it
// fills at the chain MID with zero slippage and zero fees — the TRA-4674
// measurement put the spread at 52% of the signal, so demo P&L is gross of
// the one cost that decides whether the edge survives. This ledger re-prices
// every strategy-driven entry and exit AT THE TOUCH (bid/ask, never mid),
// with the slippage assumption written on every row, and folds a daily
// summary (signals · fills · refusals · theoretical P&L net of spread+fees).
//
// BORN calling the choke point (the TRA-4655 contract): every paper OPEN
// passes `admitOrderThroughHardControls` before it is booked — the paper book
// rehearses the fleet kill switch, the day-loss lockout, the $300/3-position
// caps and the stale-quote breaker exactly as the live seams do, and a
// refusal is LOGGED as a refusal, never silently dropped. Paper CLOSES do
// NOT admit — deliberately mirroring TRA-4650, which left the live
// close-path admits unwired so a control outage can never trap an exit; the
// paper book must not rehearse a policy the live book does not have.
//
// ZERO live orders, structurally: this module imports no broker client and
// exposes no submit path — it only observes decisions other seams already
// made (the signal-engine alert emitters) and books theoretical fills into
// its own JSONL ledger. Paper P&L is never fed to `recordHardControlsPnl`;
// a theoretical loss must not lock the real book out (and vice versa the
// real lockout DOES bind paper opens, which is the rehearsal working).
//
// Population: strategy-driven opens/exits (the alert-emitter seams). Manual
// operator closes and broker reconciles are not strategy decisions and stay
// out; TP1 partial exits fold into the terminal close (the ledger books one
// open fill and one close fill per position id, at the original contract
// count). Both bounds are documented here rather than silently absorbed.

import { appendFile, mkdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from './observability/index.js';
import { resolveDataDir } from './data-dir.js';
import { etDateKey } from './et-clock.js';
import {
  admitOrderThroughHardControls,
  registerForceCloseHandler,
  type HardControlVerdict,
} from './hard-controls.js';
import {
  clampHalfSpreadFrac,
  DEFAULT_MARKETABLE_HALF_SPREAD_FRAC,
} from './marketable-open-mtm.js';
import { DEFAULT_COST_MODEL } from './options-cost-model.js';

const log = logger.child({ module: 'paper-trading' });

export const PAPER_TRADING_FLAG = 'ENABLE_PAPER_TRADING';

/**
 * Fill aggression f ∈ (0, 1]: the fraction of the half-spread a theoretical
 * fill crosses. f = 1 is a taker at the touch (buy at ask / sell at bid) —
 * the default, because the AC's whole point is "bid/ask, not mid"; anything
 * below 1 models a maker-ish limit resting inside the spread. Slippage per
 * share is therefore `f × halfSpread` — the "bid-ask spread × fill
 * aggression" assumption the AC asks to be logged, and it is stamped on
 * every fill row rather than assumed once globally.
 */
export const DEFAULT_PAPER_FILL_AGGRESSION = 1;

/**
 * Modeled equity half-spread as a fraction of price, used because the equity
 * decision path carries no two-sided quote (the engine ticks on marks).
 * 2.5 bps half ⇒ 5 bps full spread — the same figure `paper-account.ts`
 * stamps as `STOCK_SLIPPAGE_BPS` telemetry without applying it to the fill.
 */
export const PAPER_EQUITY_HALF_SPREAD_FRAC = 0.00025;

export function isPaperTradingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[PAPER_TRADING_FLAG] ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function resolvePaperFillAggression(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env['PAPER_FILL_AGGRESSION']);
  if (!Number.isFinite(raw) || raw <= 0 || raw > 1) return DEFAULT_PAPER_FILL_AGGRESSION;
  return raw;
}

// ---------------------------------------------------------------------------
// Pure fill math
// ---------------------------------------------------------------------------

/** Where the spread the fill crossed came from — on every row, never implied. */
export type PaperSpreadSource = 'quoted' | 'modeled_entry_spread' | 'modeled_default' | 'modeled_equity';

export interface PaperFillSim {
  /** Theoretical per-share fill: `mid ± f × halfSpread` (+ buys, − sells). */
  fillPerShare: number;
  halfSpreadPerShare: number;
  spreadSource: PaperSpreadSource;
  /** `f × halfSpread` — always ≥ 0; the cost vs. the mid, per share. */
  slippagePerShare: number;
  aggression: number;
}

/**
 * Price a theoretical fill off the best spread evidence available, worst
 * evidence last: a real two-sided quote → the row's own stamped entry spread
 * → the fleet-median default haircut (`DEFAULT_MARKETABLE_HALF_SPREAD_FRAC`,
 * TRA-2885). Never returns a mid fill: the floor assumption is the default
 * haircut, not zero — an unmeasured spread must not price like a free one.
 */
export function simulatePaperFill(args: {
  side: 'buy' | 'sell';
  midPerShare: number;
  bid?: number | null;
  ask?: number | null;
  /** `(ask − bid)/mid` stamped at open (TRA-3990), when the quote itself is gone. */
  entrySpreadPct?: number | null;
  aggression: number;
  /** Equity rows carry no two-sided quote at all — model at the flat bps frac. */
  equityModeled?: boolean;
}): PaperFillSim {
  const { side, midPerShare, bid, ask, entrySpreadPct, aggression, equityModeled } = args;
  let halfSpreadPerShare: number;
  let spreadSource: PaperSpreadSource;
  if (equityModeled) {
    halfSpreadPerShare = midPerShare * PAPER_EQUITY_HALF_SPREAD_FRAC;
    spreadSource = 'modeled_equity';
  } else if (
    typeof bid === 'number' && typeof ask === 'number'
    && Number.isFinite(bid) && Number.isFinite(ask)
    && bid > 0 && ask >= bid
  ) {
    halfSpreadPerShare = (ask - bid) / 2;
    spreadSource = 'quoted';
  } else if (typeof entrySpreadPct === 'number' && Number.isFinite(entrySpreadPct) && entrySpreadPct > 0) {
    halfSpreadPerShare = midPerShare * clampHalfSpreadFrac(entrySpreadPct / 2);
    spreadSource = 'modeled_entry_spread';
  } else {
    halfSpreadPerShare = midPerShare * DEFAULT_MARKETABLE_HALF_SPREAD_FRAC;
    spreadSource = 'modeled_default';
  }
  const slippagePerShare = aggression * halfSpreadPerShare;
  const fillPerShare = side === 'buy' ? midPerShare + slippagePerShare : Math.max(0, midPerShare - slippagePerShare);
  return { fillPerShare, halfSpreadPerShare, spreadSource, slippagePerShare, aggression };
}

// ---------------------------------------------------------------------------
// Ledger rows
// ---------------------------------------------------------------------------

export interface PaperSignalRow {
  kind: 'signal';
  atMs: number;
  etDay: string;
  mode: string;
  signalId: string;
  symbol: string;
  signalType: string;
  side: string | null;
  /** The trigger conditions + proposed trade, verbatim off the signal. */
  trigger: {
    entryPrice: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
    riskRewardRatio: number | null;
    skipReason: string | null;
    skipCode: string | null;
  };
}

export interface PaperOpenRow {
  kind: 'open';
  instrument: 'equity' | 'option';
  atMs: number;
  etDay: string;
  mode: string;
  positionId: string;
  signalId: string | null;
  symbol: string;
  occ: string | null;
  side: 'buy' | 'sell';
  qty: number;
  multiplier: number;
  midPerShare: number;
  fill: PaperFillSim;
  notionalUsd: number;
  commissionUsd: number;
  /** The choke-point verdict this open was BORN under (TRA-4655 contract). */
  admit: { allowed: boolean; reasonCode: string | null; reason: string | null };
}

export interface PaperCloseRow {
  kind: 'close' | 'force_close';
  instrument: 'equity' | 'option';
  atMs: number;
  etDay: string;
  mode: string;
  positionId: string;
  symbol: string;
  occ: string | null;
  exitReason: string | null;
  qty: number;
  multiplier: number;
  midPerShare: number;
  fill: PaperFillSim;
  commissionUsd: number;
  /** The demo book's own realized P&L on this row (mid-based, gross). */
  demoPnlUsd: number | null;
  /** Theoretical P&L off the PAPER fills, net of spread + commissions. */
  paperPnlUsd: number | null;
  /** FALSE ⇒ no admitted paper open existed for this id (refused/pre-arm). */
  matchedOpen: boolean;
  /** TRUE on force-closes priced off the entry mid — mark unknown, P&L excluded. */
  markStale?: boolean;
}

export type PaperLedgerRow = PaperSignalRow | PaperOpenRow | PaperCloseRow;

// ---------------------------------------------------------------------------
// Ledger state (hydrated synchronously at init, mutated synchronously by the
// recorders so `openPositionCount` can never race, persisted append-only)
// ---------------------------------------------------------------------------

interface PaperBookEntry {
  positionId: string;
  instrument: 'equity' | 'option';
  symbol: string;
  occ: string | null;
  qty: number;
  multiplier: number;
  fillPerShare: number;
  commissionUsd: number;
  openedAtMs: number;
}

function defaultLedgerFile(): string {
  return join(resolveDataDir(), 'paper-trading.jsonl');
}

let ledgerFileOverride: string | null = null;
let book = new Map<string, PaperBookEntry>();
let rows: PaperLedgerRow[] = [];
let hydrated = false;
let writeQueue: Promise<void> = Promise.resolve();

function ledgerFile(): string {
  return ledgerFileOverride ?? defaultLedgerFile();
}

export function setPaperTradingLedgerFileForTests(path: string | null): void {
  ledgerFileOverride = path;
  book = new Map();
  rows = [];
  hydrated = false;
  writeQueue = Promise.resolve();
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  const file = ledgerFile();
  if (!existsSync(file)) return;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch (err) {
    log.warn('paper ledger unreadable — starting from an empty fold (rows on disk are NOT lost)', {
      file, reason: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row: PaperLedgerRow;
    try {
      row = JSON.parse(line) as PaperLedgerRow;
    } catch {
      continue; // skip the corrupt line, never lose the ledger
    }
    rows.push(row);
    foldRowIntoBook(row);
  }
}

function foldRowIntoBook(row: PaperLedgerRow): void {
  if (row.kind === 'open' && row.admit.allowed) {
    book.set(row.positionId, {
      positionId: row.positionId,
      instrument: row.instrument,
      symbol: row.symbol,
      occ: row.occ,
      qty: row.qty,
      multiplier: row.multiplier,
      fillPerShare: row.fill.fillPerShare,
      commissionUsd: row.commissionUsd,
      openedAtMs: row.atMs,
    });
  } else if (row.kind === 'close' || row.kind === 'force_close') {
    book.delete(row.positionId);
  }
}

function append(row: PaperLedgerRow): void {
  rows.push(row);
  const file = ledgerFile();
  writeQueue = writeQueue
    .then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify(row)}\n`, 'utf-8');
    })
    .catch((err) => {
      log.warn('paper ledger append failed (row survives in memory this process)', {
        reason: err instanceof Error ? err.message : String(err),
      });
    });
}

/** Test seam: await the append queue so on-disk assertions don't race it. */
export function paperLedgerFlushForTests(): Promise<void> {
  return writeQueue;
}

// ---------------------------------------------------------------------------
// Recorders — called fire-and-forget from the signal-engine alert emitters.
// Synchronous on purpose (admit + book mutation must not interleave), only
// the disk append is deferred. Each swallows its own throw: an observation
// ledger must never take down a trade path.
// ---------------------------------------------------------------------------

export interface PaperSignalLike {
  id: string;
  symbol: string;
  type: string;
  side?: string;
  entryPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  riskRewardRatio?: number | null;
  timestamp: number;
  signalSkipReason?: string;
  signalSkipCode?: string;
}

export function recordPaperSignal(signal: PaperSignalLike, mode: string): { recorded: boolean } {
  if (!isPaperTradingEnabled()) return { recorded: false };
  try {
    hydrate();
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    append({
      kind: 'signal',
      atMs: signal.timestamp,
      etDay: etDateKey(signal.timestamp),
      mode,
      signalId: signal.id,
      symbol: signal.symbol,
      signalType: String(signal.type),
      side: signal.side ?? null,
      trigger: {
        entryPrice: num(signal.entryPrice),
        stopLoss: num(signal.stopLoss),
        takeProfit: num(signal.takeProfit),
        riskRewardRatio: num(signal.riskRewardRatio),
        skipReason: signal.signalSkipReason ?? null,
        skipCode: signal.signalSkipCode ?? null,
      },
    });
    return { recorded: true };
  } catch (err) {
    log.warn('recordPaperSignal failed', { reason: err instanceof Error ? err.message : String(err) });
    return { recorded: false };
  }
}

export interface PaperOptionOpenLike {
  id: string;
  symbol: string;
  optionSymbol?: string;
  contracts: number;
  premiumPaid: number;
  openedAt: number;
  signalId?: string;
  signalType?: string;
  entryBidAtOpen?: number | null;
  entryAskAtOpen?: number | null;
  entrySpreadPct?: number | null;
}

export function recordPaperOptionOpen(
  opt: PaperOptionOpenLike,
  mode: string,
  nowMs: number = Date.now(),
): { recorded: boolean; admitted?: boolean } {
  if (!isPaperTradingEnabled()) return { recorded: false };
  try {
    hydrate();
    const aggression = resolvePaperFillAggression();
    const fill = simulatePaperFill({
      side: 'buy',
      midPerShare: opt.premiumPaid,
      bid: opt.entryBidAtOpen,
      ask: opt.entryAskAtOpen,
      entrySpreadPct: opt.entrySpreadPct,
      aggression,
    });
    const notionalUsd = fill.fillPerShare * opt.contracts * 100;
    const commissionUsd = DEFAULT_COST_MODEL.commissionPerContract * opt.contracts;
    const verdict = admitOrderThroughHardControls({
      kind: 'open',
      notionalUsd,
      openPositionCount: book.size,
      quoteAsOfMs: opt.openedAt,
      idempotencyKey: `paper-open:${opt.id}`,
    }, nowMs);
    append(buildOpenRow('option', opt.id, opt.signalId ?? null, opt.symbol, opt.optionSymbol ?? null,
      'buy', opt.contracts, 100, opt.premiumPaid, fill, notionalUsd, commissionUsd, mode, opt.openedAt, verdict));
    return { recorded: true, admitted: verdict.allowed };
  } catch (err) {
    log.warn('recordPaperOptionOpen failed', { reason: err instanceof Error ? err.message : String(err) });
    return { recorded: false };
  }
}

export interface PaperEquityOpenLike {
  id: string;
  symbol: string;
  side: string;
  signalType?: string;
  signalId?: string;
  entryPrice: number;
  quantity: number;
  openedAt: number;
}

export function recordPaperEquityOpen(
  pos: PaperEquityOpenLike,
  mode: string,
  nowMs: number = Date.now(),
): { recorded: boolean; admitted?: boolean } {
  if (!isPaperTradingEnabled()) return { recorded: false };
  try {
    hydrate();
    const aggression = resolvePaperFillAggression();
    const side = pos.side === 'sell' ? 'sell' : 'buy';
    const fill = simulatePaperFill({
      side, midPerShare: pos.entryPrice, aggression, equityModeled: true,
    });
    const notionalUsd = fill.fillPerShare * pos.quantity;
    const verdict = admitOrderThroughHardControls({
      kind: 'open',
      notionalUsd,
      openPositionCount: book.size,
      quoteAsOfMs: pos.openedAt,
      idempotencyKey: `paper-open:${pos.id}`,
    }, nowMs);
    append(buildOpenRow('equity', pos.id, pos.signalId ?? null, pos.symbol, null,
      side, pos.quantity, 1, pos.entryPrice, fill, notionalUsd, 0, mode, pos.openedAt, verdict));
    return { recorded: true, admitted: verdict.allowed };
  } catch (err) {
    log.warn('recordPaperEquityOpen failed', { reason: err instanceof Error ? err.message : String(err) });
    return { recorded: false };
  }
}

function buildOpenRow(
  instrument: 'equity' | 'option',
  positionId: string,
  signalId: string | null,
  symbol: string,
  occ: string | null,
  side: 'buy' | 'sell',
  qty: number,
  multiplier: number,
  midPerShare: number,
  fill: PaperFillSim,
  notionalUsd: number,
  commissionUsd: number,
  mode: string,
  atMs: number,
  verdict: HardControlVerdict,
): PaperOpenRow {
  const row: PaperOpenRow = {
    kind: 'open',
    instrument,
    atMs,
    etDay: etDateKey(atMs),
    mode,
    positionId,
    signalId,
    symbol,
    occ,
    side,
    qty,
    multiplier,
    midPerShare,
    fill,
    notionalUsd,
    commissionUsd,
    admit: {
      allowed: verdict.allowed,
      reasonCode: verdict.reasonCode ?? null,
      reason: verdict.reason ?? null,
    },
  };
  foldRowIntoBook(row);
  return row;
}

export interface PaperOptionCloseLike {
  id: string;
  symbol: string;
  optionSymbol?: string;
  contracts: number;
  /** On a CLOSED row this is the actual demo exit fill (TRA-2890). */
  currentPremium: number;
  closedAt?: number;
  pnl?: number;
  exitReason?: string;
  entrySpreadPct?: number | null;
}

export function recordPaperOptionClose(opt: PaperOptionCloseLike, mode: string): { recorded: boolean } {
  if (!isPaperTradingEnabled()) return { recorded: false };
  try {
    hydrate();
    const atMs = opt.closedAt ?? Date.now();
    const aggression = resolvePaperFillAggression();
    const fill = simulatePaperFill({
      side: 'sell',
      midPerShare: opt.currentPremium,
      entrySpreadPct: opt.entrySpreadPct,
      aggression,
    });
    const entry = book.get(opt.id);
    const commissionUsd = DEFAULT_COST_MODEL.commissionPerContract * opt.contracts;
    const paperPnlUsd = entry
      ? (fill.fillPerShare - entry.fillPerShare) * entry.qty * entry.multiplier - entry.commissionUsd - commissionUsd
      : null;
    const row: PaperCloseRow = {
      kind: 'close',
      instrument: 'option',
      atMs,
      etDay: etDateKey(atMs),
      mode,
      positionId: opt.id,
      symbol: opt.symbol,
      occ: opt.optionSymbol ?? null,
      exitReason: opt.exitReason ?? null,
      qty: entry?.qty ?? opt.contracts,
      multiplier: 100,
      midPerShare: opt.currentPremium,
      fill,
      commissionUsd,
      demoPnlUsd: typeof opt.pnl === 'number' && Number.isFinite(opt.pnl) ? opt.pnl : null,
      paperPnlUsd,
      matchedOpen: !!entry,
    };
    foldRowIntoBook(row);
    append(row);
    return { recorded: true };
  } catch (err) {
    log.warn('recordPaperOptionClose failed', { reason: err instanceof Error ? err.message : String(err) });
    return { recorded: false };
  }
}

export interface PaperEquityCloseLike {
  id: string;
  symbol: string;
  side: string;
  quantity: number;
  exitPrice?: number;
  closedAt?: number;
  pnl?: number;
  exitReason?: string;
}

export function recordPaperEquityClose(pos: PaperEquityCloseLike, mode: string): { recorded: boolean } {
  if (!isPaperTradingEnabled()) return { recorded: false };
  try {
    hydrate();
    const atMs = pos.closedAt ?? Date.now();
    const mid = typeof pos.exitPrice === 'number' && Number.isFinite(pos.exitPrice) ? pos.exitPrice : 0;
    const aggression = resolvePaperFillAggression();
    // Closing a long sells; closing a short buys back.
    const closeSide = pos.side === 'sell' ? 'buy' : 'sell';
    const fill = simulatePaperFill({ side: closeSide, midPerShare: mid, aggression, equityModeled: true });
    const entry = book.get(pos.id);
    const signed = closeSide === 'sell' ? 1 : -1;
    const paperPnlUsd = entry && mid > 0
      ? signed * (fill.fillPerShare - entry.fillPerShare) * entry.qty * entry.multiplier - entry.commissionUsd
      : null;
    const row: PaperCloseRow = {
      kind: 'close',
      instrument: 'equity',
      atMs,
      etDay: etDateKey(atMs),
      mode,
      positionId: pos.id,
      symbol: pos.symbol,
      occ: null,
      exitReason: pos.exitReason ?? null,
      qty: entry?.qty ?? pos.quantity,
      multiplier: 1,
      midPerShare: mid,
      fill,
      commissionUsd: 0,
      demoPnlUsd: typeof pos.pnl === 'number' && Number.isFinite(pos.pnl) ? pos.pnl : null,
      paperPnlUsd,
      matchedOpen: !!entry,
    };
    foldRowIntoBook(row);
    append(row);
    return { recorded: true };
  } catch (err) {
    log.warn('recordPaperEquityClose failed', { reason: err instanceof Error ? err.message : String(err) });
    return { recorded: false };
  }
}

// ---------------------------------------------------------------------------
// Force-close handler — control 7's paper leg (the TRA-4655 contract's second
// half: the handler registry had zero paper coverage until this module).
// ---------------------------------------------------------------------------

/**
 * Flatten every open paper row. The module holds no live marks, so these
 * closes price at the ENTRY fill minus one modeled half-spread and are
 * stamped `markStale: true` — the daily summary counts them but excludes
 * them from theoretical P&L rather than publishing a number priced off a
 * quote that does not exist. The point of the handler is latch compliance
 * (nothing stays open through a mandated flatten), not P&L.
 */
export async function forceCloseAllPaperPositions(nowMs: number = Date.now()): Promise<{ closed: number; errors: string[] }> {
  hydrate();
  let closed = 0;
  for (const entry of [...book.values()]) {
    const fill = simulatePaperFill({
      side: 'sell',
      midPerShare: entry.fillPerShare,
      aggression: resolvePaperFillAggression(),
      equityModeled: entry.instrument === 'equity',
    });
    const row: PaperCloseRow = {
      kind: 'force_close',
      instrument: entry.instrument,
      atMs: nowMs,
      etDay: etDateKey(nowMs),
      mode: 'paper',
      positionId: entry.positionId,
      symbol: entry.symbol,
      occ: entry.occ,
      exitReason: 'hard_controls_force_close',
      qty: entry.qty,
      multiplier: entry.multiplier,
      midPerShare: entry.fillPerShare,
      fill,
      commissionUsd: 0,
      demoPnlUsd: null,
      paperPnlUsd: null,
      matchedOpen: true,
      markStale: true,
    };
    foldRowIntoBook(row);
    append(row);
    closed += 1;
  }
  await paperLedgerFlushForTests();
  return { closed, errors: [] };
}

/**
 * Boot wiring: hydrate the fold and register the paper book on the
 * force-close registry. Idempotent per process (`registerForceCloseHandler`
 * last-wins on the name). Runs regardless of the flag so a flatten ordered
 * while the flag is off still clears rows a previously-armed process booked.
 */
export function initPaperTrading(): void {
  hydrate();
  registerForceCloseHandler('paper-book', () => forceCloseAllPaperPositions());
}

// ---------------------------------------------------------------------------
// Daily summary + state readout
// ---------------------------------------------------------------------------

export interface PaperDailySummary {
  etDay: string;
  enabled: boolean;
  signals: number;
  opens: { admitted: number; refused: number; refusedByReason: Record<string, number> };
  closes: number;
  forceCloses: number;
  /** Net of spread + commissions, over matched closes with a real mark. */
  theoreticalRealizedPnlUsd: number;
  /** The demo book's own (mid-based) realized P&L over the same closes. */
  demoRealizedPnlUsd: number;
  /** Total logged slippage assumption (open + close legs), USD. */
  slippageAssumedUsd: number;
  commissionAssumedUsd: number;
  /** Closes that had no admitted paper open to settle against. */
  unmatchedCloses: number;
  openPositionsNow: number;
}

export function buildPaperDailySummary(etDay?: string, env: NodeJS.ProcessEnv = process.env): PaperDailySummary {
  hydrate();
  const day = etDay ?? etDateKey(Date.now());
  const summary: PaperDailySummary = {
    etDay: day,
    enabled: isPaperTradingEnabled(env),
    signals: 0,
    opens: { admitted: 0, refused: 0, refusedByReason: {} },
    closes: 0,
    forceCloses: 0,
    theoreticalRealizedPnlUsd: 0,
    demoRealizedPnlUsd: 0,
    slippageAssumedUsd: 0,
    commissionAssumedUsd: 0,
    unmatchedCloses: 0,
    openPositionsNow: book.size,
  };
  for (const row of rows) {
    if (row.etDay !== day) continue;
    if (row.kind === 'signal') {
      summary.signals += 1;
    } else if (row.kind === 'open') {
      if (row.admit.allowed) {
        summary.opens.admitted += 1;
        summary.slippageAssumedUsd += row.fill.slippagePerShare * row.qty * row.multiplier;
        summary.commissionAssumedUsd += row.commissionUsd;
      } else {
        summary.opens.refused += 1;
        const code = row.admit.reasonCode ?? 'unknown';
        summary.opens.refusedByReason[code] = (summary.opens.refusedByReason[code] ?? 0) + 1;
      }
    } else if (row.kind === 'force_close') {
      summary.forceCloses += 1;
    } else {
      summary.closes += 1;
      if (!row.matchedOpen) summary.unmatchedCloses += 1;
      if (typeof row.paperPnlUsd === 'number') summary.theoreticalRealizedPnlUsd += row.paperPnlUsd;
      if (typeof row.demoPnlUsd === 'number') summary.demoRealizedPnlUsd += row.demoPnlUsd;
      summary.slippageAssumedUsd += row.fill.slippagePerShare * row.qty * row.multiplier;
      summary.commissionAssumedUsd += row.commissionUsd;
    }
  }
  return summary;
}

export interface PaperTradingState {
  enabled: boolean;
  aggression: number;
  ledgerFile: string;
  rowsLoaded: number;
  openPositions: PaperBookEntry[];
  today: PaperDailySummary;
}

export function getPaperTradingState(env: NodeJS.ProcessEnv = process.env): PaperTradingState {
  hydrate();
  return {
    enabled: isPaperTradingEnabled(env),
    aggression: resolvePaperFillAggression(env),
    ledgerFile: ledgerFile(),
    rowsLoaded: rows.length,
    openPositions: [...book.values()],
    today: buildPaperDailySummary(undefined, env),
  };
}

/** Ledger rows for a given ET day (the AC's per-signal/per-fill evidence). */
export function getPaperLedgerRowsForDay(etDay: string): PaperLedgerRow[] {
  hydrate();
  return rows.filter((r) => r.etDay === etDay);
}
