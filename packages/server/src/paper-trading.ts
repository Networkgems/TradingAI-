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

import type { OptionBasisWriter } from '@trading-app/shared';
import { mkdir } from 'fs/promises';
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
import { appendBoundedTapeLine } from './data-tape-bounds.js';
import {
  engineBasisRestatementDataDir,
  readEngineBasisRestatements,
} from './engine-basis-restatement-log.js';

const log = logger.child({ module: 'paper-trading' });

/**
 * TRA-4781 — how many times the engine restated THIS row's entry basis
 * **through the durable restatement log**.
 *
 * Three-valued on purpose. A row the logged restatement never reached and a row
 * it reached at zero delta BOTH show `basisDeltaUsd: 0.00` — the delta alone
 * cannot separate them, and publishing a bare `0` for both is the
 * indistinguishable-payload shape TRA-4781 is about.
 *
 *   • `null`  — the durable census is UNREADABLE (DATA_DIR unset, file absent,
 *     or open failed). NOT zero. A consumer must never `?? 0` this.
 *   • `0`     — census readable and it holds nothing for this id: **no LOGGED
 *     restatement landed**.
 *   • `n >= 1` — a logged restatement landed n times.
 *
 * ⛔ TRA-5010 — `0` DOES NOT MEAN THE BASIS DID NOT MOVE, and the shipped
 * wording here used to say it did ("the engine's basis is still the open mark
 * and `basisDeltaUsd` of 0.00 is structural"). That is only true of a row whose
 * basis no *other* writer touched, and there are eleven other writers. The log
 * has **four** feeders (`broker_reconcile`, `recorded_fill_repair`,
 * `operator_restatement`, `desk_lot_split`); `premiumPaid` is assigned at
 * **twelve** sites. Measured on bqb1 2026-09-28: the census read
 * `logPresent: true, count: 22`, newest record `2026-09-01T19:08:40Z`, while the
 * 2026-09-22 fixture session moved the basis by $13.80 net across four pairs —
 * i.e. `count: 0` on every one of them, and the basis moved anyway.
 *
 * So the honest pair is `basisRestatementCount` (did the LOGGED path land?) and
 * {@link PaperCloseRow.basisDeltaAttribution} (did the basis move, and was the
 * logged path what moved it?). This function answers only the first question,
 * and widening it to count unlogged writes would destroy its one clean property:
 * it is backed by an append-only durable log.
 *
 * Fails to `null` in every doubt: asserting "no logged restatement" off a census
 * we could not read is the expensive direction.
 */
function countBasisRestatements(positionId: string): number | null {
  try {
    const read = readEngineBasisRestatements(engineBasisRestatementDataDir());
    if (!read.logPresent || read.readError !== null) return null;
    return read.records.filter((r) => r.positionId === positionId).length;
  } catch {
    return null;
  }
}

/**
 * TRA-5010 — the attribution of `basisDeltaUsd`. Exhaustive and mutually
 * exclusive, because the pair (`basisDeltaUsd`, `basisRestatementCount`) carries
 * four readings that a consumer was collapsing into two.
 *
 *   • `null`                     — NOT COMPUTABLE: `basisDeltaUsd` is null (no
 *     matched open, or either basis unknown). There is no delta to attribute.
 *   • `census_unreadable`        — the delta is readable and the census is not.
 *     The basis may or may not have moved through the logged path; we cannot say.
 *     ⛔ Not an error state and not a zero.
 *   • `logged_restatement`       — a logged restatement landed on this row
 *     (`count >= 1`). It accounts for AT LEAST PART of the delta; it does not
 *     prove it accounts for all of it, because an unlogged writer can have moved
 *     the basis too and the log would not know.
 *   • `unlogged_writer`          — ★ THE FINDING. The census is readable, holds
 *     nothing, and the basis moved anyway ⇒ one of the eight unlogged writers did
 *     it. A LEGITIMATE, EXPECTED live reading, not a fault. Read
 *     {@link PaperCloseRow.basisWriter} for which one.
 *   • `no_delta_no_restatement`  — census readable and empty, and the basis did
 *     not move. The never-restated class on live data. Named rather than folded
 *     into a boolean `explained: true`, which would be a VACUOUS pass: there is
 *     nothing here to explain, and a row with nothing to explain must not read
 *     identically to one whose gap was accounted for.
 *
 * That last bullet is why this is an enum and not the
 * `basisDeltaExplainedByRestatement: boolean | null` TRA-5010 proposed — a
 * boolean has three cells to carry and four readings to carry them.
 */
export type PaperBasisDeltaAttribution =
  | 'census_unreadable'
  | 'logged_restatement'
  | 'unlogged_writer'
  | 'no_delta_no_restatement';

/**
 * Float-noise guard ONLY. `entryBasisAtOpen - entryBasisRestated` is exactly
 * `0` when the two bases are equal, so this never fires on real inputs; it is
 * here so a denormal residue cannot be reported as a basis move.
 *
 * ⛔ Deliberately NOT a materiality threshold. Anything larger would silently
 * re-merge "moved a little" into "did not move", which is the exact collapse
 * this field exists to undo. A sub-cent basis move IS a basis move here.
 */
export const BASIS_DELTA_ZERO_EPSILON_USD = 1e-9;

/**
 * The shipped classifier, exported so the row, the daily summary and the tests
 * all read one implementation — a second copy would be free to disagree with
 * the published cell.
 */
export function classifyBasisDelta(
  basisRestatementCount: number | null | undefined,
  basisDeltaUsd: number | null | undefined,
): PaperBasisDeltaAttribution | null {
  if (typeof basisDeltaUsd !== 'number' || !Number.isFinite(basisDeltaUsd)) return null;
  if (basisRestatementCount === null || basisRestatementCount === undefined) return 'census_unreadable';
  if (!Number.isFinite(basisRestatementCount)) return 'census_unreadable';
  if (basisRestatementCount >= 1) return 'logged_restatement';
  return Math.abs(basisDeltaUsd) <= BASIS_DELTA_ZERO_EPSILON_USD
    ? 'no_delta_no_restatement'
    : 'unlogged_writer';
}

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
  /**
   * TRA-4781 — THE TWO LEGS ABOVE DO NOT SHARE AN ENTRY BASIS, and until these
   * fields existed nothing on the payload said so.
   *
   * `demoPnlUsd` is the engine's, struck against `premiumPaid` AFTER
   * `restateEngineOpenedBasis` (TRA-3965) moved it to broker truth on a later
   * reconcile — measured 23.1s (SOFI) and 72.3s (BAC) after the open, and never
   * at all on a `quantity_mismatch` / `multi_leg` / `covered_write` row.
   * `paperPnlUsd` is struck against the tee's own entry fill, derived from the
   * mid at the decision instant, which is NEVER restated. So the natural read
   * of the summary route — `demo − theoretical = cost of trading` — silently
   * absorbs a third term that is not a cost at all: on the four TRA-4657 pairs
   * of 2026-09-22 it was $13.80, larger than every commission combined, 29% of
   * the gap, and it went BOTH ways (GME +17.22, TLT −8.93).
   *
   * The bridge these fields close, exact to the cent on that fixture:
   *
   *     demoPnlUsd − paperPnlUsd = spread + commissions + basisDeltaUsd
   *
   * Additive by design (TRA-4781 §2): the paper open is NOT re-stamped when the
   * restatement lands, because a paper row recording what was knowable at
   * DECISION time is the more valuable audit property. The divergence is made
   * readable instead of made to disappear.
   */
  /** The basis the TEE used: the open-time mid. `null` ⇒ no matched open. */
  entryBasisAtOpen: number | null;
  /** The basis the ENGINE's `demoPnlUsd` used: `premiumPaid` as of the close. */
  entryBasisRestated: number | null;
  /**
   * `(entryBasisAtOpen − entryBasisRestated) × qty × multiplier` — the term to
   * SUBTRACT from `demoPnlUsd − paperPnlUsd` to recover the true cost of
   * trading. Sign is oriented to the bridge above; `null` when either basis is
   * unknown. ⛔ A `0.00` here is meaningless without `basisRestatementCount`.
   */
  basisDeltaUsd: number | null;
  /**
   * Three-valued: `null` = census UNREADABLE · `0` = no **LOGGED** restatement
   * landed · `n ≥ 1` = one landed n times. ⛔ Never `?? 0` this — that re-merges
   * the two readings the field exists to split.
   *
   * ⛔ TRA-5010 — `0` IS NOT "THE BASIS DID NOT MOVE". It is a single-writer-
   * family census: the durable log has four feeders and `premiumPaid` has twelve
   * assignment sites, so `basisDeltaUsd != 0` beside `basisRestatementCount: 0`
   * is a legitimate live reading meaning "the basis moved, through a path that
   * does not append". Read {@link basisDeltaAttribution} for that distinction and
   * {@link basisWriter} for which writer did it.
   */
  basisRestatementCount: number | null;
  /**
   * TRA-5010 — which of the four readings of the (`basisDeltaUsd`,
   * `basisRestatementCount`) pair this row actually is. See
   * {@link PaperBasisDeltaAttribution}. `null` ⇒ no delta to attribute.
   *
   * The cell that matters is `unlogged_writer`: the basis moved and the durable
   * restatement log holds nothing for the row. That is the reading a consumer of
   * `basisRestatementCount: 0` alone gets exactly backwards.
   */
  basisDeltaAttribution: PaperBasisDeltaAttribution | null;
  /**
   * TRA-5010 — the writer that last assigned the engine's `premiumPaid`, i.e.
   * the one that produced `entryBasisRestated` above. `null` ⇒ the position was
   * opened before the stamp shipped, or the engine passed no position at all.
   *
   * ⛔ `null` is UNSTAMPED, not "no writer". Splitting a future `_missing` census
   * by the date this shipped is the TRA-4997 lesson; do not fold the two.
   */
  basisWriter: OptionBasisWriter | null;
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
  /**
   * TRA-4781 — the open-time MID (`premiumPaid` as the decision seam saw it),
   * kept beside the theoretical fill because the close needs the basis the tee
   * was anchored to in order to name its divergence from the engine's.
   * Recovered from the persisted open row, so rows already on disk fold with
   * it and no migration is needed.
   */
  midPerShare: number;
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
      midPerShare: row.midPerShare,
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
      await appendBoundedTapeLine(file, `${JSON.stringify(row)}\n`);
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
  /**
   * TRA-4781 — the entry basis `pnl` above was struck against, i.e. the
   * engine's `premiumPaid` as it stands NOW (after any
   * `restateEngineOpenedBasis`). `OptionPosition` already carries this, so the
   * call site needs no change — widening the structural type is the whole
   * wiring. Optional because the force-close and equity paths have no engine
   * basis to report, and inventing one would be worse than a null.
   */
  premiumPaid?: number;
  /**
   * TRA-5010 — the writer that produced `premiumPaid` above. `OptionPosition`
   * carries this, so the one production call site needs no change: widening the
   * structural type is the whole wiring, exactly as `premiumPaid` was wired.
   */
  basisWriter?: OptionBasisWriter;
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
    // TRA-4781 — name the basis split rather than let it hide in the gap
    // between the two P&L legs. `entryBasisAtOpen` is what the tee anchored to
    // at the decision instant; `entryBasisRestated` is what the engine's `pnl`
    // was struck against by the time this close ran.
    const entryBasisAtOpen = entry && Number.isFinite(entry.midPerShare) ? entry.midPerShare : null;
    const entryBasisRestated =
      typeof opt.premiumPaid === 'number' && Number.isFinite(opt.premiumPaid) ? opt.premiumPaid : null;
    const basisDeltaUsd =
      entry && entryBasisAtOpen !== null && entryBasisRestated !== null
        ? (entryBasisAtOpen - entryBasisRestated) * entry.qty * entry.multiplier
        : null;
    const basisRestatementCount = countBasisRestatements(opt.id);
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
      entryBasisAtOpen,
      entryBasisRestated,
      basisDeltaUsd,
      basisRestatementCount,
      // TRA-5010 — computed from the SHIPPED classifier, not re-derived here, so
      // the row and the summary cannot fork.
      basisDeltaAttribution: classifyBasisDelta(basisRestatementCount, basisDeltaUsd),
      basisWriter: opt.basisWriter ?? null,
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
      // TRA-4781 — `restateEngineOpenedBasis` is an OPTIONS mechanism; there is
      // no equity restatement and therefore no census to read. The tee's own
      // basis is still reported, but the other three stay null rather than
      // publish a `0` that would read as a measured agreement we never made.
      entryBasisAtOpen: entry && Number.isFinite(entry.midPerShare) ? entry.midPerShare : null,
      entryBasisRestated: null,
      basisDeltaUsd: null,
      basisRestatementCount: null,
      // TRA-5010 — nothing to attribute: these paths carry no engine basis at
      // all, so `null` here is "not computable", never "no writer".
      basisDeltaAttribution: null,
      basisWriter: null,
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
      // TRA-4781 — a force-close publishes no P&L at all (`markStale`), so
      // there is no gap between two legs to decompose. All four stay null.
      entryBasisAtOpen: Number.isFinite(entry.midPerShare) ? entry.midPerShare : null,
      entryBasisRestated: null,
      basisDeltaUsd: null,
      basisRestatementCount: null,
      // TRA-5010 — nothing to attribute: these paths carry no engine basis at
      // all, so `null` here is "not computable", never "no writer".
      basisDeltaAttribution: null,
      basisWriter: null,
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
  /**
   * Net of spread + commissions, over matched closes with a real mark.
   *
   * TRA-4874 — **`null` when NOTHING was bookable**, never `0`. A bare `0` here
   * was byte-identical across four different days: a genuine breakeven, a
   * no-trade day, a day flattened by the force-close handler (marks stale ⇒ P&L
   * excluded by construction), and a day where every close was unbookable. The
   * 2026-09-23 and 2026-09-24 paper sessions were the fourth kind — 12 unmatched
   * closes each — and both published `0`, which reads as "equities were flat".
   * The row level was already honest (`paperPnlUsd: null` + `matchedOpen: false`);
   * only the day summary flattened it. `pnlBasis` below names which case this is.
   * ⛔ Never `?? 0` this — that re-merges the readings the null exists to split.
   */
  theoreticalRealizedPnlUsd: number | null;
  /**
   * The demo book's own (mid-based) realized P&L over the same closes. `null`
   * under the same rule (TRA-4874), counted separately: the two legs have
   * different populations, and a day with unmatched closes typically publishes a
   * demo number with NO theoretical twin — which is itself the discriminator.
   */
  demoRealizedPnlUsd: number | null;
  /** Total logged slippage assumption (open + close legs), USD. */
  slippageAssumedUsd: number;
  commissionAssumedUsd: number;
  /**
   * TRA-4781 — the third term in `demo − theoretical`, folded over the option
   * closes that carry a readable basis pair. WITHOUT this the summary's two
   * P&L totals differ by spread + commissions + an unnamed basis drift, and
   * the obvious subtraction overstates the cost of trading (by 29% on the
   * 2026-09-22 fixture). Subtract it to recover the real cost:
   *
   *     demoRealizedPnlUsd − theoreticalRealizedPnlUsd
   *       = slippageAssumedUsd + commissionAssumedUsd + basisDeltaUsd
   *
   * ⚠️ TRA-4874 — that bridge is only computable when BOTH legs are non-null,
   * i.e. `pnlBasis === 'matched_closes'` and `demoPnlCloses ≥ 1`. Do not coerce a
   * null leg to zero to make the subtraction go through; there is no bridge to
   * close on a day that booked nothing.
   */
  basisDeltaUsd: number;
  /**
   * Option closes NOT in the fold above, split three ways so a quiet day and a
   * broken census never render as the same number:
   *   • `unreadable` — the restatement census could not be read
   *   • `unstamped`  — row predates TRA-4781 (no basis fields on it at all)
   *   • `neverRestated` — census readable, zero records: **no LOGGED restatement
   *     landed on the row**. ⛔ TRA-5010 — this used to be documented as "the
   *     delta is structurally zero", which is wrong: it counts rows whose basis
   *     moved through one of the eight UNLOGGED writers too. It is a subset of
   *     `inFold` and it is the SUM of `basisAttribution.unloggedWriter +
   *     basisAttribution.noDeltaNoRestatement`. Read those two if you want the
   *     structural zero on its own.
   */
  basisCloses: { inFold: number; unreadable: number; unstamped: number; neverRestated: number };
  /**
   * TRA-5010 — the in-fold basis closes partitioned by WHAT the pair
   * (`basisDeltaUsd`, `basisRestatementCount`) actually says. Exhaustive over
   * `basisCloses.inFold` and mutually exclusive, so the partition is auditable
   * rather than asserted:
   *
   *     loggedRestatement + unloggedWriter + noDeltaNoRestatement
   *       === basisCloses.inFold
   *
   * `unloggedWriter` is the cell this ticket exists for: the basis MOVED and the
   * durable restatement log holds nothing for the row. A non-zero reading here is
   * normal operation, not an incident — but it is also proof that
   * `basisRestatementCount` is not an account of the basis gap. A day with
   * `unloggedWriter: 0` and `neverRestated > 0` is the genuinely-never-moved day.
   *
   * (`census_unreadable` has no cell: it lands in `basisCloses.unreadable` and is
   * excluded from the fold by the branch above, so counting it twice would break
   * the sum identity.)
   */
  basisAttribution: {
    loggedRestatement: number;
    unloggedWriter: number;
    noDeltaNoRestatement: number;
  };
  /**
   * TRA-5010 item 3 — WHICH writer produced the basis each in-fold close settled
   * against, keyed by {@link OptionBasisWriter} plus `unstamped` for a row opened
   * before the stamp shipped. Bounded by construction (eleven possible keys, none
   * derived from a per-row value), so it cannot saturate.
   *
   * This is the attribution the restatement log structurally cannot give: the log
   * only ever sees its own four feeders, so "which of the eight unlogged writers
   * moved the basis" was previously unanswerable from any payload. Absent key ⇒
   * no close settled against that writer today; ⛔ never read a missing key as a
   * measured zero for a writer the build cannot produce.
   */
  basisWriters: Record<string, number>;
  /**
   * TRA-4874 — WHY `theoreticalRealizedPnlUsd` reads the way it does. Exhaustive
   * and mutually exclusive, so the four readings a bare `0` collapsed are four
   * distinct values:
   *   • `matched_closes`        — `pnlCloses.inFold ≥ 1`: the number is MEASURED
   *   • `no_closes`             — no close and no force-close landed today
   *   • `only_force_closes`     — flattened by control 7; a force-close prices off
   *     the entry mid and publishes no P&L, so zero is structural, not measured
   *   • `all_closes_unbookable` — closes landed and not one could be settled
   *     (the 2026-09-23 / 09-24 state). ⛔ This is the reading that used to be
   *     indistinguishable from a flat day, and it is the point of the field.
   */
  pnlBasis: 'matched_closes' | 'no_closes' | 'only_force_closes' | 'all_closes_unbookable';
  /**
   * TRA-4874 — the denominator behind `theoreticalRealizedPnlUsd`, partitioned so
   * the three ways a close can fail to contribute stay separate. The four counts
   * sum to `closes` exactly (force-closes are counted in `forceCloses`, never
   * here), which is what makes the partition auditable rather than asserted:
   *   • `inFold`    — contributed a finite `paperPnlUsd`
   *   • `unmatched` — no admitted paper open to settle against (`matchedOpen:false`)
   *   • `noMark`    — matched, but the exit mark was missing/non-finite
   */
  pnlCloses: { inFold: number; unmatched: number; noMark: number };
  /** TRA-4874 — closes that contributed a finite `demoPnlUsd`. `0` ⇒ that leg is null. */
  demoPnlCloses: number;
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
    // TRA-4874 — seeded NULL, not 0: "nothing bookable" is the state before the
    // fold runs, and an early return must never publish a zero it never measured.
    theoreticalRealizedPnlUsd: null,
    demoRealizedPnlUsd: null,
    slippageAssumedUsd: 0,
    commissionAssumedUsd: 0,
    basisDeltaUsd: 0,
    basisCloses: { inFold: 0, unreadable: 0, unstamped: 0, neverRestated: 0 },
    basisAttribution: { loggedRestatement: 0, unloggedWriter: 0, noDeltaNoRestatement: 0 },
    basisWriters: {},
    pnlBasis: 'no_closes',
    pnlCloses: { inFold: 0, unmatched: 0, noMark: 0 },
    demoPnlCloses: 0,
    unmatchedCloses: 0,
    openPositionsNow: book.size,
  };
  // TRA-4874 — the two P&L legs fold into LOCALS, not into the payload, because
  // the payload cells are three-valued now: a running `0` that is later published
  // as `null` must never be observable half-way. Each is published only if its
  // own population is non-empty.
  let theoreticalUsd = 0;
  let demoUsd = 0;
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
      // TRA-4874 — bucket EVERY close, so `inFold + unmatched + noMark == closes`
      // and the published total carries its own denominator. `Number.isFinite`
      // rather than the old bare `typeof`: a NaN is not a P&L, and folding one
      // would poison the whole day's total into `NaN` — a fourth unreadable value
      // in the cell this ticket is un-flattening. It buckets as `noMark`.
      // (Not reachable through the JSONL seam — `JSON.stringify(NaN)` is `null` —
      //  so this is a guard on the in-process path, deliberately untested.)
      const paperPnl = row.paperPnlUsd;
      if (typeof paperPnl === 'number' && Number.isFinite(paperPnl)) {
        theoreticalUsd += paperPnl;
        summary.pnlCloses.inFold += 1;
      } else if (!row.matchedOpen) {
        summary.pnlCloses.unmatched += 1;
      } else {
        summary.pnlCloses.noMark += 1;
      }
      const demoPnl = row.demoPnlUsd;
      if (typeof demoPnl === 'number' && Number.isFinite(demoPnl)) {
        demoUsd += demoPnl;
        summary.demoPnlCloses += 1;
      }
      summary.slippageAssumedUsd += row.fill.slippagePerShare * row.qty * row.multiplier;
      summary.commissionAssumedUsd += row.commissionUsd;
      // TRA-4781 — fold the basis term, and bucket every option close that
      // cannot contribute to it. `undefined` here is a row written before this
      // shipped; `null` is a census we could not read. Folding either as 0
      // would put the two readings back in one cell.
      if (row.instrument === 'option') {
        if (!('basisDeltaUsd' in row)) {
          summary.basisCloses.unstamped += 1;
        } else if (row.basisRestatementCount === null) {
          summary.basisCloses.unreadable += 1;
        } else if (typeof row.basisDeltaUsd === 'number' && Number.isFinite(row.basisDeltaUsd)) {
          summary.basisDeltaUsd += row.basisDeltaUsd;
          summary.basisCloses.inFold += 1;
          if (row.basisRestatementCount === 0) summary.basisCloses.neverRestated += 1;
          // TRA-5010 — attribute the term, do not just total it. Re-derived from
          // the row's own two numbers through the SHIPPED classifier rather than
          // read off `row.basisDeltaAttribution`, so rows written before that
          // field shipped bucket correctly instead of falling out of the
          // partition. The two agree by construction on a stamped row.
          const attribution = classifyBasisDelta(row.basisRestatementCount, row.basisDeltaUsd);
          if (attribution === 'logged_restatement') summary.basisAttribution.loggedRestatement += 1;
          else if (attribution === 'unlogged_writer') summary.basisAttribution.unloggedWriter += 1;
          else if (attribution === 'no_delta_no_restatement') summary.basisAttribution.noDeltaNoRestatement += 1;
          // `unstamped` keeps a pre-TRA-5010 row out of the ten real writers
          // rather than attributing its basis to a writer nothing observed.
          const writerKey = row.basisWriter ?? 'unstamped';
          summary.basisWriters[writerKey] = (summary.basisWriters[writerKey] ?? 0) + 1;
        } else {
          summary.basisCloses.unreadable += 1;
        }
      }
    }
  }
  // TRA-4874 — publish the two totals ONLY over a non-empty population, and name
  // the case. The four `pnlBasis` arms are checked in the order that makes them
  // mutually exclusive; `matched_closes` is the only one that publishes a number.
  summary.theoreticalRealizedPnlUsd = summary.pnlCloses.inFold > 0 ? theoreticalUsd : null;
  summary.demoRealizedPnlUsd = summary.demoPnlCloses > 0 ? demoUsd : null;
  summary.pnlBasis =
    summary.pnlCloses.inFold > 0 ? 'matched_closes'
      : summary.closes > 0 ? 'all_closes_unbookable'
        : summary.forceCloses > 0 ? 'only_force_closes'
          : 'no_closes';
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
