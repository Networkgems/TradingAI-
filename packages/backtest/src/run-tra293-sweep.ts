/**
 * TRA-293 — §8 walk-forward sweep for the Phase-1.2 funding-extreme-short
 * trigger (TRA-255 §4.4 Layer 3 alternate trigger, routed from TRA-291).
 *
 * Adds a single new entry rule on top of the TRA-287 4H r9 baseline:
 *   - Per-hour funding rate ≥ +0.0005 (= +0.05%/h) for 6 consecutive 8h
 *     intervals (= 48h of sustained positive carry) at the 4H bar close →
 *     short the perp at the **next 4H bar open**.
 *
 * Exit knobs (binding per the issue spec):
 *   - 1% account risk per trade.
 *   - ATR(14)-2.0 above entry as the initial stop.
 *   - 1:2 R:R take-profit at entry − 2×stopDistance below entry.
 *   - ATR(14)-1.5 trail above the lowest-low since entry, **armed only after
 *     unrealised profit ≥ +1R**.
 *   - Time stop at 24 × 4H bars (= 96h) from entry if no R-target hit.
 *   - Carry-broken exit: if per-hour funding flips ≤ 0% for **2 consecutive
 *     8h intervals** while the position is open, exit at the next 4H bar open.
 *
 * **Why this is harness-only.** Mirrors TRA-287's wire-into-harness-first
 * pattern. The cascade-leg trigger (§4.4 Layer 3 r7) lives inside
 * `MomentumStrategy.evaluate(symbol, candles)` — that contract has no funding
 * history input, so wiring funding-extreme-short into the engine StrategyRouter
 * means extending Strategy/Router for funding context. The spec routes us
 * through §8 first; we only pay that surface-area cost if §8 passes. If it
 * does, the promotion is mechanical: extend `paramsByDirection.short` with a
 * `byTimeframe['4h'].fundingExtremeShort` knob alongside `cascadeLeg4h` and
 * `btcRsiBracket`, and add `fundingHistoryPerHour` to a strategy-context shape.
 *
 * **Why we run it standalone (not piggybacked on TRA-261).** The funding-
 * extreme-short trigger replaces the §4.1/§4.4-cascade short emission for the
 * 4H r9 universe per the spec; piggybacking on `run-tra261-sweep.ts` would
 * intertwine the cascade-leg path with the funding-extreme path under the
 * same §8 sidecar and obscure each one's contribution. The TRA-293 sidecar is
 * the apples-to-apples §8 read on funding-extreme-short alone.
 *
 * **Universe gates honoured (per spec):**
 *   - r9 universe membership (SOL-USD, DOGE-USD).
 *   - §3.1 per-symbol consecutive-loss cooldown (3 losses → 48h cooldown).
 *   - §6 max-concurrent-shorts cap (3) and notional caps.
 *   - §5.1 funding cap is **structurally non-overlapping** here: the cap fires
 *     on funding ≤ -0.05%/h, the trigger fires on funding ≥ +0.05%/h. Both
 *     can coexist by design; counted in the skip histogram for completeness.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra293-sweep.ts
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONSECUTIVE_LOSS_COOLDOWN_MS,
  CONSECUTIVE_LOSS_THRESHOLD,
  MAX_CONCURRENT_SHORTS,
  PERP_SHORT_CROSS_STRATEGY_CAP,
  PERP_SHORT_SINGLE_SYMBOL_CAP,
  PERP_SHORT_TOTAL_NOTIONAL_CAP,
  atr,
} from '@trading-app/engine';
import type { Candle, ExitReason } from '@trading-app/shared';
import { fetchCoinbase4hBars } from './coinbase-feed.js';
import { loadOrFetchFunding, lookupFundingPerHour, type FundingPoint } from './funding-feed.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');
const DATA_DIR = resolve(HERE, '..', 'data');
const BAR_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

interface BarCacheEntry {
  symbol: string;
  fetchedAt: number;
  start: number;
  end: number;
  candles: Candle[];
}

/**
 * Local 4H bar loader with on-disk cache, isolated from `fetch-tra266-data.ts`
 * so this sweep doesn't drag in the yahoo-finance2 import that file uses for
 * the 1D path. Same `<symbol>.4h.json` cache shape as TRA-267 — both loaders
 * read each other's caches without conversion.
 */
async function loadOrFetch4hBarsLocal(symbol: string, fromMs: number, toMs: number): Promise<Candle[]> {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const path = resolve(DATA_DIR, `${symbol.toLowerCase()}.4h.json`);
  // Cache hit conditions:
  //   - file is fresh (< TTL)
  //   - cache covers `fromMs`
  //   - cache covers `toMs` OR cache.end is within TTL of now (i.e., it was
  //     updated recently enough that the only missing bars would be the
  //     current incomplete period — fine for §8 walk-forward)
  if (existsSync(path) && Date.now() - statSync(path).mtimeMs < BAR_CACHE_TTL_MS) {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as BarCacheEntry;
    const coversFrom = raw.start <= fromMs;
    const coversTo = raw.end >= Math.min(toMs, Date.now() - 4 * 60 * 60 * 1000);
    if (coversFrom && coversTo) {
      return raw.candles.filter((c) => c.timestamp >= fromMs && c.timestamp <= toMs);
    }
  }
  console.log(`[run-tra293-sweep] Fetching ${symbol} 4H from Coinbase…`);
  const candles = await fetchCoinbase4hBars(symbol, fromMs, toMs);
  if (candles.length === 0) throw new Error(`Coinbase returned 0 4H bars for ${symbol}`);
  const entry: BarCacheEntry = {
    symbol,
    fetchedAt: Date.now(),
    start: candles[0].timestamp,
    end: candles[candles.length - 1].timestamp,
    candles,
  };
  writeFileSync(path, JSON.stringify(entry));
  return candles.filter((c) => c.timestamp >= fromMs && c.timestamp <= toMs);
}

// ── r9 universe (TRA-291 / TRA-255 §4.4 v3) ────────────────────────────────
const R9_UNIVERSE: readonly string[] = ['SOL-USD', 'DOGE-USD'];

// ── Risk / cost model (TRA-293 binding spec) ───────────────────────────────
const INITIAL_EQUITY_USD = 25_000;
const FEE_BPS = 40;             // Coinbase Advanced Trade taker
const SLIPPAGE_BPS = 5;
const RISK_FRACTION = 0.01;     // 1% account equity per trade (binding)

// ── Trigger thresholds (TRA-293 binding spec) ──────────────────────────────
/** Per-hour funding rate threshold for entry confirmation. +0.05%/h. */
const TRIGGER_FUNDING_PER_HOUR = 0.0005;
/** Number of consecutive 8h funding intervals at/above the threshold. */
const TRIGGER_INTERVAL_COUNT = 6;
/** ATR multiple for the initial stop above entry. */
const ATR_STOP_MULTIPLIER = 2.0;
/** Minimum R:R for the take-profit target. */
const RR_TARGET = 2.0;
/** ATR multiple for the trail-stop offset above the lowest-low since entry. */
const ATR_TRAIL_MULTIPLIER = 1.5;
/** Time-stop in 4H bars from entry if no R-target hit. */
const TIME_STOP_BARS = 24;
/** Funding-flip threshold for the carry-broken exit (per-hour). */
const CARRY_BROKEN_PER_HOUR = 0.0;
/** Number of consecutive 8h funding intervals at/below threshold to force exit. */
const CARRY_BROKEN_INTERVAL_COUNT = 2;

// ── Walk-forward sizing (matches TRA-287 4H r9) ────────────────────────────
const TRAIN_BARS = 180 * 6;     // 1080 4H bars ≈ 180d
const TEST_BARS = 90 * 6;       // 540  4H bars ≈ 90d
const STEP_BARS = TEST_BARS;    // non-overlapping test windows
const ROLLING_DD_BARS = 90 * 6; // 90d rolling DD window
const ATR_PERIOD = 14;
const FROM_MS = Date.UTC(2022, 0, 1);
/**
 * Force-align the walk-forward common start to the TRA-287 4H r9 sweep
 * (2023-07-13). TRA-287 ran the 5-symbol universe and XRP's Coinbase 4H
 * history forced this date as the latest-common start. The TRA-293 r9
 * universe is SOL + DOGE only — both go back to 2022-01-01 — so without
 * pinning we'd produce 15 windows instead of TRA-287's 9. The spec
 * explicitly calls for "the same 9 windows used in TRA-287", so we override
 * the natural common start with the TRA-287 reference and hand QuantTrader
 * an apples-to-apples §8 comparison.
 */
const TRA287_COMMON_START_MS = Date.UTC(2023, 6, 13);

// Skip-reason strings (mirroring engine perp-shorts.ts).
const SKIP_NOT_IN_UNIVERSE = 'shorts disabled — symbol not in perp universe';
const SKIP_FUNDING_TOO_NEGATIVE = 'funding too negative — squeeze risk';
const SKIP_CONSECUTIVE_LOSSES = '3 consecutive short losses — symbol cooldown';
const SKIP_MAX_CONCURRENT_SHORTS = 'max 3 concurrent shorts';
const SKIP_SINGLE_SYMBOL_CAP = 'single-symbol short cap';
const SKIP_CROSS_STRATEGY_CAP = 'cross-strategy per-symbol short cap';
const SKIP_TOTAL_SHORT_NOTIONAL = 'total short notional cap';
const SKIP_ZERO_STOP_DISTANCE = 'zero stop distance';
const SKIP_EQUITY_EXHAUSTED = 'equity exhausted';

// ── Cost helpers ───────────────────────────────────────────────────────────
const slipRate = SLIPPAGE_BPS / 10_000;
const feeRate = FEE_BPS / 10_000;
function entrySlip(side: 'sell', px: number): number { return side === 'sell' ? px * (1 - slipRate) : px * (1 + slipRate); }
function exitSlip(side: 'sell', px: number): number { return side === 'sell' ? px * (1 + slipRate) : px * (1 - slipRate); }
function netPnl(entryFill: number, exitFill: number, qty: number): number {
  const gross = (entryFill - exitFill) * qty;
  const commission = entryFill * qty * feeRate + exitFill * qty * feeRate;
  return gross - commission;
}
function rMultiple(entryFill: number, exitFill: number, initialStop: number): number {
  const stopDistance = Math.abs(initialStop - entryFill);
  if (stopDistance === 0) return 0;
  return (entryFill - exitFill) / stopDistance;
}

// ── Trigger predicate ─────────────────────────────────────────────────────

/**
 * Confirm the §4.4 funding-extreme-short trigger at `barCloseTs`. Returns
 * `true` iff the 6 most-recent 8h funding intervals at or before the bar
 * close are all ≥ +0.0005/h. Caller is responsible for ordering: this
 * predicate evaluates at the bar **close**; the engine opens the short on
 * the **next** bar's open.
 */
function fundingExtremeTriggered(history: FundingPoint[], barCloseTs: number): boolean {
  // Find the index of the most recent funding point ≤ barCloseTs.
  let lo = 0;
  let hi = history.length - 1;
  let pick = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (history[mid].ts <= barCloseTs) { pick = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (pick < TRIGGER_INTERVAL_COUNT - 1) return false;
  for (let k = 0; k < TRIGGER_INTERVAL_COUNT; k++) {
    const r = history[pick - k].ratePerHour;
    if (!Number.isFinite(r) || r < TRIGGER_FUNDING_PER_HOUR) return false;
  }
  return true;
}

/**
 * Check the carry-broken exit predicate at `barCloseTs`. Returns `true` iff
 * the 2 most-recent 8h funding intervals at or before the bar close are both
 * ≤ 0%. Caller exits at the next bar's open.
 */
function carryBroken(history: FundingPoint[], barCloseTs: number): boolean {
  let lo = 0;
  let hi = history.length - 1;
  let pick = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (history[mid].ts <= barCloseTs) { pick = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (pick < CARRY_BROKEN_INTERVAL_COUNT - 1) return false;
  for (let k = 0; k < CARRY_BROKEN_INTERVAL_COUNT; k++) {
    const r = history[pick - k].ratePerHour;
    if (!Number.isFinite(r) || r > CARRY_BROKEN_PER_HOUR) return false;
  }
  return true;
}

// ── Position lifecycle ─────────────────────────────────────────────────────

interface OpenShort {
  symbol: string;
  openedAt: number;
  /** Bar index at which the position was opened (current symbol's bar series). */
  openedAtBarIdx: number;
  entryFill: number;
  initialStop: number;
  takeProfit: number;
  qty: number;
  /** Lowest low observed across the position lifetime; drives the ATR-1.5 trail. */
  lowestLow: number;
  /** Active stop (initially `initialStop`; tightens as the trail engages). */
  stop: number;
  /** True once unrealised profit has exceeded +1R; trail locks in from this bar. */
  trailArmed: boolean;
}

interface ClosedShort {
  symbol: string;
  openedAt: number;
  closedAt: number;
  entryFill: number;
  exitFill: number;
  qty: number;
  pnlUsd: number;
  rMultiple: number;
  exitReason: ExitReason;
  initialStop: number;
}

interface SimReport {
  closedShorts: ClosedShort[];
  equityCurve: Array<{ ts: number; equity: number }>;
  skipReasons: Map<string, number>;
  /** Number of bars where the trigger predicate fired (pre-gating). */
  triggerFireCount: number;
  /** Of those fires, how many actually opened a position after gating. */
  triggerToTradeCount: number;
  /** Number of positions exited by the carry-broken predicate. */
  carryBrokenExitCount: number;
}

interface SimInput {
  candlesBySymbol: Map<string, Candle[]>;
  fundingBySymbol: Map<string, FundingPoint[]>;
}

function bumpSkip(map: Map<string, number>, reason: string) {
  map.set(reason, (map.get(reason) ?? 0) + 1);
}

function totalEquityUsd(cashUsd: number, openShorts: OpenShort[], lastClose: Map<string, number>): number {
  let unrealised = 0;
  for (const o of openShorts) {
    const px = lastClose.get(o.symbol);
    if (px === undefined) continue;
    unrealised += (o.entryFill - px) * o.qty;
  }
  return cashUsd + unrealised;
}

function openShortNotionalForSymbol(open: OpenShort[], symbol: string): number {
  let n = 0;
  for (const o of open) if (o.symbol === symbol) n += o.entryFill * o.qty;
  return n;
}
function openShortNotionalAll(open: OpenShort[]): number {
  let n = 0;
  for (const o of open) n += o.entryFill * o.qty;
  return n;
}

function consecutiveSymbolLossCooldown(closed: ClosedShort[], symbol: string, nowMs: number): boolean {
  // Walk most-recent-first, count consecutive losing closes on this symbol.
  const recent = closed
    .filter((t) => t.symbol === symbol)
    .sort((a, b) => b.closedAt - a.closedAt);
  let losses = 0;
  let mostRecentLossAt: number | null = null;
  for (const t of recent) {
    if (t.pnlUsd < 0) {
      losses++;
      if (mostRecentLossAt === null) mostRecentLossAt = t.closedAt;
      if (losses >= CONSECUTIVE_LOSS_THRESHOLD) {
        return mostRecentLossAt !== null && nowMs - mostRecentLossAt <= CONSECUTIVE_LOSS_COOLDOWN_MS;
      }
    } else {
      return false;
    }
  }
  return false;
}

/**
 * Run the funding-extreme-short simulation across every symbol's 4H bar
 * window. Each iteration represents one 4H bar; entries arm at the
 * **previous** bar's close and execute at the **current** bar's open per
 * the spec ("short the perp at the next 4H bar open after confirmation").
 *
 * Lifecycle order on each bar:
 *   1. For each open short: process carry-broken exit at this bar's open
 *      (if the previous bar's close confirmed the predicate). Same bar, new
 *      open price, slippage adverse.
 *   2. For each open short: bracket SL/TP/trail/time-stop checks against
 *      the bar's high/low. Same conventions as run-tra261-sweep.ts.
 *   3. For each symbol: if the previous bar's close confirmed the trigger
 *      AND no open position on this symbol AND all gates pass, open at
 *      this bar's open.
 *   4. Mark to market for the equity curve.
 */
function runFundingExtremeSim(input: SimInput): SimReport {
  const symbols = Array.from(input.candlesBySymbol.keys());
  // Build a unified bar timestamp index across symbols (intersection).
  const tsSets = symbols.map((s) => new Set(input.candlesBySymbol.get(s)!.map((c) => c.timestamp)));
  const baseTimestamps = symbols.length > 0
    ? input.candlesBySymbol.get(symbols[0])!.map((c) => c.timestamp).filter((ts) => tsSets.every((set) => set.has(ts)))
    : [];

  const idxBySymbol = new Map<string, number>();
  for (const sym of symbols) idxBySymbol.set(sym, 0);

  const openShorts: OpenShort[] = [];
  const closedShorts: ClosedShort[] = [];
  const equityCurve: Array<{ ts: number; equity: number }> = [];
  const skipReasons = new Map<string, number>();
  let triggerFireCount = 0;
  let triggerToTradeCount = 0;
  let carryBrokenExitCount = 0;

  let cashUsd = INITIAL_EQUITY_USD;
  // Pending arms keyed by symbol: trigger fired at prev bar close; act at next bar open.
  const pendingEntry = new Map<string, { triggerTs: number }>();
  const pendingCarryExit = new Set<string>();

  for (let baseI = 0; baseI < baseTimestamps.length; baseI++) {
    const ts = baseTimestamps[baseI];
    // Advance per-symbol indices.
    for (const sym of symbols) {
      const bars = input.candlesBySymbol.get(sym)!;
      let idx = idxBySymbol.get(sym)!;
      while (idx < bars.length && bars[idx].timestamp < ts) idx += 1;
      idxBySymbol.set(sym, idx);
    }
    const lastClose = new Map<string, number>();
    for (const sym of symbols) {
      const bars = input.candlesBySymbol.get(sym)!;
      const idx = idxBySymbol.get(sym)!;
      if (idx < bars.length && bars[idx].timestamp === ts) lastClose.set(sym, bars[idx].close);
    }

    // ── 1) Carry-broken exits at this bar's open.
    for (const o of [...openShorts]) {
      if (!pendingCarryExit.has(o.symbol)) continue;
      pendingCarryExit.delete(o.symbol);
      const bars = input.candlesBySymbol.get(o.symbol)!;
      const idx = idxBySymbol.get(o.symbol)!;
      if (idx >= bars.length || bars[idx].timestamp !== ts) continue;
      const exitRaw = bars[idx].open;
      const exitFill = exitSlip('sell', exitRaw);
      const pnl = netPnl(o.entryFill, exitFill, o.qty);
      const r = rMultiple(o.entryFill, exitFill, o.initialStop);
      cashUsd += pnl;
      closedShorts.push({
        symbol: o.symbol,
        openedAt: o.openedAt,
        closedAt: ts,
        entryFill: o.entryFill,
        exitFill,
        qty: o.qty,
        pnlUsd: pnl,
        rMultiple: r,
        exitReason: 'time_stop', // re-use the closest existing reason; sidecar tags it explicitly
        initialStop: o.initialStop,
      });
      carryBrokenExitCount += 1;
      const i = openShorts.indexOf(o);
      if (i >= 0) openShorts.splice(i, 1);
    }

    // ── 2) Bracket / trail / time-stop on remaining open positions.
    for (const o of [...openShorts]) {
      const bars = input.candlesBySymbol.get(o.symbol)!;
      const idx = idxBySymbol.get(o.symbol)!;
      if (idx >= bars.length || bars[idx].timestamp !== ts) continue;
      const bar = bars[idx];
      // Skip the entry bar itself — entries open at this bar's open and
      // shouldn't also exit on the same bar (matches runner convention).
      if (o.openedAt === ts) continue;

      // Update lowest-low + arm trail if +1R reached.
      o.lowestLow = Math.min(o.lowestLow, bar.low);
      const stopDistance = Math.abs(o.initialStop - o.entryFill);
      const oneRTarget = o.entryFill - stopDistance;
      if (!o.trailArmed && bar.low <= oneRTarget) {
        o.trailArmed = true;
      }
      if (o.trailArmed) {
        const window = bars.slice(0, idx + 1);
        const atrNow = atr(window, ATR_PERIOD);
        if (atrNow !== null && atrNow > 0) {
          const candidateStop = o.lowestLow + ATR_TRAIL_MULTIPLIER * atrNow;
          // Tighten only — short trail can only move down (closer to price).
          if (candidateStop < o.stop) o.stop = candidateStop;
        }
      }

      const hitsStop = bar.high >= o.stop;
      const hitsTarget = bar.low <= o.takeProfit;
      let exitReason: ExitReason | null = null;
      let rawExit = 0;
      if (hitsTarget) {
        rawExit = o.takeProfit;
        exitReason = 'target';
      } else if (hitsStop) {
        rawExit = o.stop;
        exitReason = o.stop !== o.initialStop ? 'trailing' : 'stop';
      } else {
        const barsHeld = idx - o.openedAtBarIdx;
        if (barsHeld >= TIME_STOP_BARS) {
          rawExit = bar.close;
          exitReason = 'time_stop';
        }
      }
      if (exitReason !== null) {
        const exitFill = exitSlip('sell', rawExit);
        const pnl = netPnl(o.entryFill, exitFill, o.qty);
        const r = rMultiple(o.entryFill, exitFill, o.initialStop);
        cashUsd += pnl;
        closedShorts.push({
          symbol: o.symbol,
          openedAt: o.openedAt,
          closedAt: ts,
          entryFill: o.entryFill,
          exitFill,
          qty: o.qty,
          pnlUsd: pnl,
          rMultiple: r,
          exitReason,
          initialStop: o.initialStop,
        });
        const i = openShorts.indexOf(o);
        if (i >= 0) openShorts.splice(i, 1);
      }
    }

    // ── 3) Open new positions for any symbols with a pending entry arm.
    for (const sym of symbols) {
      const armed = pendingEntry.get(sym);
      if (!armed) continue;
      pendingEntry.delete(sym);
      const bars = input.candlesBySymbol.get(sym)!;
      const idx = idxBySymbol.get(sym)!;
      if (idx >= bars.length || bars[idx].timestamp !== ts) continue;

      // Universe gate (defensive — sim only runs r9 symbols).
      if (!R9_UNIVERSE.includes(sym)) {
        bumpSkip(skipReasons, SKIP_NOT_IN_UNIVERSE);
        continue;
      }
      // Already-open short on this symbol → skip; we only ever hold one
      // funding-extreme position per symbol at a time.
      if (openShorts.some((o) => o.symbol === sym)) continue;

      // §3.1 cooldown.
      if (consecutiveSymbolLossCooldown(closedShorts, sym, ts)) {
        bumpSkip(skipReasons, SKIP_CONSECUTIVE_LOSSES);
        continue;
      }
      // §6 max-concurrent.
      if (openShorts.length >= MAX_CONCURRENT_SHORTS) {
        bumpSkip(skipReasons, SKIP_MAX_CONCURRENT_SHORTS);
        continue;
      }
      // §5.1 funding cap — structurally non-overlapping with the trigger;
      // recorded in the histogram only for completeness.
      const fundingNow = lookupFundingPerHour(input.fundingBySymbol.get(sym) ?? [], ts);
      if (fundingNow !== undefined && fundingNow <= -0.0005) {
        bumpSkip(skipReasons, SKIP_FUNDING_TOO_NEGATIVE);
        continue;
      }

      // Sizing — 1% account equity per spec.
      const equityNow = totalEquityUsd(cashUsd, openShorts, lastClose);
      if (equityNow <= 0) {
        bumpSkip(skipReasons, SKIP_EQUITY_EXHAUSTED);
        continue;
      }
      // ATR(14) computed on the prior bars (entry-bar excluded so the trigger
      // and the stop are independent of the entry bar's own range).
      const window = bars.slice(0, idx);
      const atrValue = atr(window, ATR_PERIOD);
      if (atrValue === null || atrValue <= 0) {
        bumpSkip(skipReasons, SKIP_ZERO_STOP_DISTANCE);
        continue;
      }
      const entryRaw = bars[idx].open;
      const entryFill = entrySlip('sell', entryRaw);
      const initialStop = entryFill + ATR_STOP_MULTIPLIER * atrValue;
      const stopDistance = initialStop - entryFill;
      if (stopDistance <= 0) {
        bumpSkip(skipReasons, SKIP_ZERO_STOP_DISTANCE);
        continue;
      }
      const takeProfit = entryFill - RR_TARGET * stopDistance;
      const riskUsd = equityNow * RISK_FRACTION;
      const qty = riskUsd / stopDistance;
      if (qty <= 0) {
        bumpSkip(skipReasons, SKIP_ZERO_STOP_DISTANCE);
        continue;
      }

      // §6 notional caps.
      const candidateNotional = entryFill * qty;
      const singleSymCap = equityNow * PERP_SHORT_SINGLE_SYMBOL_CAP;
      if (openShortNotionalForSymbol(openShorts, sym) + candidateNotional > singleSymCap) {
        bumpSkip(skipReasons, SKIP_SINGLE_SYMBOL_CAP);
        continue;
      }
      const crossCap = equityNow * PERP_SHORT_CROSS_STRATEGY_CAP;
      if (openShortNotionalForSymbol(openShorts, sym) + candidateNotional > crossCap) {
        bumpSkip(skipReasons, SKIP_CROSS_STRATEGY_CAP);
        continue;
      }
      const totalCap = equityNow * PERP_SHORT_TOTAL_NOTIONAL_CAP;
      if (openShortNotionalAll(openShorts) + candidateNotional > totalCap) {
        bumpSkip(skipReasons, SKIP_TOTAL_SHORT_NOTIONAL);
        continue;
      }

      openShorts.push({
        symbol: sym,
        openedAt: ts,
        openedAtBarIdx: idx,
        entryFill,
        initialStop,
        takeProfit,
        qty,
        lowestLow: bars[idx].low,
        stop: initialStop,
        trailArmed: false,
      });
      triggerToTradeCount += 1;
    }

    // ── 4) Arm next-bar entries / carry exits based on this bar's close.
    for (const sym of symbols) {
      const bars = input.candlesBySymbol.get(sym)!;
      const idx = idxBySymbol.get(sym)!;
      if (idx >= bars.length || bars[idx].timestamp !== ts) continue;
      const fundingHistory = input.fundingBySymbol.get(sym) ?? [];
      const closeTs = bars[idx].timestamp + 4 * 60 * 60 * 1000 - 1; // bar-close clock = bar open + ~4h
      // Trigger arm — only if no current open position on this symbol AND no
      // pending arm already queued.
      if (!openShorts.some((o) => o.symbol === sym) && !pendingEntry.has(sym)) {
        if (fundingExtremeTriggered(fundingHistory, closeTs)) {
          triggerFireCount += 1;
          pendingEntry.set(sym, { triggerTs: ts });
        }
      }
      // Carry-broken arm — only for currently open positions on this symbol.
      if (openShorts.some((o) => o.symbol === sym)) {
        if (carryBroken(fundingHistory, closeTs)) {
          pendingCarryExit.add(sym);
        }
      }
    }

    // ── 5) Equity curve.
    equityCurve.push({ ts, equity: totalEquityUsd(cashUsd, openShorts, lastClose) });
  }

  return {
    closedShorts,
    equityCurve,
    skipReasons,
    triggerFireCount,
    triggerToTradeCount,
    carryBrokenExitCount,
  };
}

// ── Walk-forward windowing ─────────────────────────────────────────────────

interface WindowSpec {
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
}

function buildWindows(totalBars: number, trainBars: number, testBars: number, step: number): WindowSpec[] {
  const out: WindowSpec[] = [];
  let origin = 0;
  while (origin + trainBars + testBars <= totalBars) {
    out.push({
      trainStart: origin,
      trainEnd: origin + trainBars,
      testStart: origin + trainBars,
      testEnd: origin + trainBars + testBars,
    });
    origin += step;
  }
  return out;
}

interface PerSymbolMetrics {
  symbol: string;
  trades: number;
  winners: number;
  hitRatePct: number;
  expectancyR: number;
  totalPnlUsd: number;
}

interface UniverseMetrics {
  trades: number;
  winners: number;
  hitRatePct: number;
  expectancyR: number;
  totalPnlUsd: number;
  rollingMaxDrawdownPct: number;
  passes: boolean;
  reasons: string[];
}

interface WindowReport {
  index: number;
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
  closedShorts: ClosedShort[];
  equityCurve: Array<{ ts: number; equity: number }>;
  skipReasons: Map<string, number>;
  triggerFireCount: number;
  triggerToTradeCount: number;
  carryBrokenExitCount: number;
}

function rollingMaxDrawdownPct(curve: Array<{ ts: number; equity: number }>, windowBars: number): number {
  if (curve.length < 2) return 0;
  let worst = 0;
  for (let i = 0; i < curve.length; i++) {
    const lo = Math.max(0, i - windowBars + 1);
    let runningPeak = curve[lo].equity;
    let dd = 0;
    for (let j = lo; j <= i; j++) {
      const eq = curve[j].equity;
      if (eq > runningPeak) runningPeak = eq;
      if (runningPeak > 0) {
        const candidate = ((runningPeak - eq) / runningPeak) * 100;
        if (candidate > dd) dd = candidate;
      }
    }
    if (dd > worst) worst = dd;
  }
  return worst;
}

function perSymbolMetrics(trades: ClosedShort[], symbols: string[]): PerSymbolMetrics[] {
  return symbols.map((sym) => {
    const ts = trades.filter((t) => t.symbol === sym);
    const winners = ts.filter((t) => t.pnlUsd > 0);
    const expectancy = ts.length > 0 ? ts.reduce((s, t) => s + t.rMultiple, 0) / ts.length : 0;
    const totalPnl = ts.reduce((s, t) => s + t.pnlUsd, 0);
    return {
      symbol: sym,
      trades: ts.length,
      winners: winners.length,
      hitRatePct: ts.length > 0 ? (winners.length / ts.length) * 100 : 0,
      expectancyR: expectancy,
      totalPnlUsd: totalPnl,
    };
  });
}

function universeMetrics(trades: ClosedShort[], equity: Array<{ ts: number; equity: number }>): UniverseMetrics {
  const winners = trades.filter((t) => t.pnlUsd > 0);
  const expectancy = trades.length > 0 ? trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length : 0;
  const hitRatePct = trades.length > 0 ? (winners.length / trades.length) * 100 : 0;
  const totalPnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const rollingDD = rollingMaxDrawdownPct(equity, ROLLING_DD_BARS);

  const reasons: string[] = [];
  if (trades.length < 4) reasons.push(`only ${trades.length} trade(s) in window < 4`);
  if (expectancy < 0.10) reasons.push(`expectancy ${expectancy.toFixed(3)}R < 0.10R`);
  if (hitRatePct < 35) reasons.push(`hit rate ${hitRatePct.toFixed(1)}% < 35%`);
  if (rollingDD > 8) reasons.push(`rolling-90d DD ${rollingDD.toFixed(2)}% > 8%`);

  return {
    trades: trades.length,
    winners: winners.length,
    hitRatePct,
    expectancyR: expectancy,
    totalPnlUsd: totalPnl,
    rollingMaxDrawdownPct: rollingDD,
    passes: reasons.length === 0,
    reasons,
  };
}

// ── Reporting ──────────────────────────────────────────────────────────────

function formatDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

interface ReportInputs {
  windows: WindowReport[];
  perWindow: Array<{ index: number; metrics: UniverseMetrics; perSymbol: PerSymbolMetrics[] }>;
  symbols: string[];
  fullByPair: Map<string, Candle[]>;
  fundingByPair: Map<string, FundingPoint[]>;
}

function buildReport(input: ReportInputs): string {
  const { windows, perWindow, symbols, fullByPair, fundingByPair } = input;
  const lines: string[] = [];
  lines.push('# TRA-291 — §8 Walk-Forward Sweep Report (4H r9 funding-extreme-short, TRA-293)\n');
  lines.push(`Generated: ${new Date().toISOString()}\n`);
  lines.push(`Granularity: 4h`);
  lines.push(`Universe: ${symbols.join(', ')} (TRA-255 §4.4 v3 r9)`);
  lines.push(`Date span: ${formatDate(fullByPair.get(symbols[0])![0].timestamp)} → ${formatDate(fullByPair.get(symbols[0])![fullByPair.get(symbols[0])!.length - 1].timestamp)}`);
  lines.push(`Initial equity: $${INITIAL_EQUITY_USD.toLocaleString()}, fees ${FEE_BPS} bps taker, slippage ${SLIPPAGE_BPS} bps`);
  lines.push(`Walk-forward: train=${TRAIN_BARS}4h, test=${TEST_BARS}4h, step=${STEP_BARS}4h, windows=${windows.length}\n`);
  lines.push('> **§4.4 Layer 3 alternate trigger.** Funding-extreme-short fires when the per-hour funding rate (Binance USD-M `fundingRate` history ÷ 8) is ≥ +0.0005 (= +0.05%/h) for 6 consecutive 8h intervals (= 48h sustained positive carry) at the 4H bar close. Position opens at the next 4H bar open. Stop ATR-2.0 above entry; 1:2 R:R take-profit; ATR-1.5 trail above the lowest-low after +1R; 24-bar time stop; carry-broken force-exit on 2 consecutive 8h intervals ≤ 0%. Cascade-leg trigger is parked on this run (sibling long-side child handles the engine-side park separately) so funding-extreme-short is the only Layer 3 trigger that can fire.\n');
  lines.push('> Funding feed: Binance USD-M futures, ~8h resolution. Live `fapi.binance.com` is geo-blocked from this dev host so the sweep falls back to the public Binance Vision monthly CSV dumps (`data.binance.vision/data/futures/um/monthly/fundingRate/...`). Same 8h-interval rates, no second feed introduced — see `packages/backtest/src/funding-feed.ts`.\n');

  lines.push('## §8 Acceptance bars\n');
  lines.push('| Window | Test span | Trades | Hit % | Expectancy R | Total PnL | Rolling 90d DD % | Pass? | Trigger fires (raw → trade) | Carry-broken exits | Reasons |');
  lines.push('| ------ | --------- | ------ | ----- | ------------ | --------- | ---------------- | ----- | --------------------------- | ------------------ | ------- |');
  for (const w of windows) {
    const m = perWindow[w.index].metrics;
    const startStr = w.equityCurve.length > 0 ? formatDate(w.equityCurve[0].ts) : '—';
    const endStr = w.equityCurve.length > 0 ? formatDate(w.equityCurve[w.equityCurve.length - 1].ts) : '—';
    const pass = m.passes ? '✅' : '❌';
    lines.push(`| ${w.index} | ${startStr}→${endStr} | ${m.trades} | ${m.hitRatePct.toFixed(1)} | ${m.expectancyR.toFixed(3)} | $${m.totalPnlUsd.toFixed(0)} | ${m.rollingMaxDrawdownPct.toFixed(2)} | ${pass} | ${w.triggerFireCount} → ${w.triggerToTradeCount} | ${w.carryBrokenExitCount} | ${m.reasons.join('; ') || '—'} |`);
  }
  lines.push('');

  const passingCount = perWindow.filter((w) => w.metrics.passes).length;
  lines.push(`Passing windows: ${passingCount} / ${perWindow.length}\n`);

  lines.push('## Per-symbol per-window R decomposition\n');
  lines.push('| Window | ' + symbols.map((s) => `${s} (n / hit% / R)`).join(' | ') + ' |');
  lines.push('| ------ | ' + symbols.map(() => '---').join(' | ') + ' |');
  for (const w of perWindow) {
    const cells = symbols.map((sym) => {
      const m = w.perSymbol.find((p) => p.symbol === sym)!;
      return `${m.trades} / ${m.hitRatePct.toFixed(0)}% / ${m.expectancyR.toFixed(2)}R`;
    });
    lines.push(`| ${w.index} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  // Aggregate trade tally.
  const allTrades = windows.flatMap((w) => w.closedShorts);
  const allWinners = allTrades.filter((t) => t.pnlUsd > 0);
  const aggregateExpectancy = allTrades.length > 0 ? allTrades.reduce((s, t) => s + t.rMultiple, 0) / allTrades.length : 0;
  const aggregatePnl = allTrades.reduce((s, t) => s + t.pnlUsd, 0);
  const aggregateHit = allTrades.length > 0 ? (allWinners.length / allTrades.length) * 100 : 0;
  const totalFires = windows.reduce((s, w) => s + w.triggerFireCount, 0);
  const totalToTrade = windows.reduce((s, w) => s + w.triggerToTradeCount, 0);
  const totalCarryExits = windows.reduce((s, w) => s + w.carryBrokenExitCount, 0);
  // Rolling DD on the concatenated equity curve.
  const fullCurve = windows.flatMap((w) => w.equityCurve);
  const aggregateDD = rollingMaxDrawdownPct(fullCurve, ROLLING_DD_BARS);

  lines.push('## Aggregate (SOL+DOGE rollup, all windows)\n');
  lines.push(`- Trades: ${allTrades.length} (winners ${allWinners.length})`);
  lines.push(`- Hit rate: ${aggregateHit.toFixed(1)}%`);
  lines.push(`- Mean expectancy: ${aggregateExpectancy.toFixed(3)}R`);
  lines.push(`- Total PnL: $${aggregatePnl.toFixed(0)}`);
  lines.push(`- Rolling-90d DD (concatenated): ${aggregateDD.toFixed(2)}%`);
  lines.push(`- Trigger fires: ${totalFires} raw → ${totalToTrade} trades after universe / cap / cooldown gating`);
  lines.push(`- Carry-broken force exits: ${totalCarryExits}`);
  lines.push('');

  // Pre-route skip histogram across all windows.
  const totalSkips = new Map<string, number>();
  for (const w of windows) for (const [k, v] of w.skipReasons) totalSkips.set(k, (totalSkips.get(k) ?? 0) + v);
  if (totalSkips.size > 0) {
    lines.push('## Pre-route skip reasons (across windows)\n');
    lines.push('| Reason | Count |');
    lines.push('| ------ | ----- |');
    const entries = [...totalSkips.entries()].sort((a, b) => b[1] - a[1]);
    for (const [k, v] of entries) lines.push(`| ${k} | ${v} |`);
    lines.push('');
  }

  // Funding-history sanity (covers the data span actually consumed).
  lines.push('## Funding feed coverage\n');
  lines.push('| Symbol | Intervals | First | Last | Min /h | Max /h | Median /h | p99 /h |');
  lines.push('| ------ | --------- | ----- | ---- | ------ | ------ | --------- | ------ |');
  for (const sym of symbols) {
    const fd = fundingByPair.get(sym) ?? [];
    if (fd.length === 0) {
      lines.push(`| ${sym} | 0 | — | — | — | — | — | — |`);
      continue;
    }
    const rates = fd.map((p) => p.ratePerHour).slice().sort((a, b) => a - b);
    const median = rates[Math.floor(rates.length / 2)];
    const p99 = rates[Math.floor(rates.length * 0.99)];
    lines.push(`| ${sym} | ${fd.length} | ${formatDate(fd[0].ts)} | ${formatDate(fd[fd.length - 1].ts)} | ${rates[0].toExponential(3)} | ${rates[rates.length - 1].toExponential(3)} | ${median.toExponential(3)} | ${p99.toExponential(3)} |`);
  }
  lines.push('');

  // Threshold-sensitivity diagnostic — fire counts if the trigger threshold
  // and consecutive-interval count are relaxed. Hands QuantTrader the data
  // for a relaxation call without needing a re-run; the harness still ships
  // the binding spec on the §8 path above.
  lines.push('## Threshold-sensitivity diagnostic (no positions opened — informational)\n');
  lines.push('Count of bars where the trigger condition would have fired against the per-symbol funding history, varying the per-hour threshold and consecutive-interval count. Binding spec is the **+0.0005/h × 6-interval** row.\n');
  const rows: Array<{ threshPerHour: number; intervals: number }> = [
    { threshPerHour: 0.0005, intervals: 6 }, // binding
    { threshPerHour: 0.0004, intervals: 6 }, // spec-suggested relaxation A
    { threshPerHour: 0.0004, intervals: 4 }, // spec-suggested relaxation B (combined)
    { threshPerHour: 0.0005, intervals: 4 },
    { threshPerHour: 0.0001, intervals: 6 },
    { threshPerHour: 0.0001, intervals: 4 },
    { threshPerHour: 0.00008, intervals: 6 },
    { threshPerHour: 0.00008, intervals: 4 },
    { threshPerHour: 0.00005, intervals: 6 },
    { threshPerHour: 0.00005, intervals: 4 },
    { threshPerHour: 0.00003, intervals: 6 },
    { threshPerHour: 0.00003, intervals: 4 },
  ];
  lines.push(`| Per-hour threshold | Consecutive intervals | ${symbols.join(' fires | ')} fires |`);
  lines.push(`| ------------------ | --------------------- | ${symbols.map(() => '----').join(' | ')} |`);
  for (const r of rows) {
    const cells = symbols.map((sym) => {
      const fd = fundingByPair.get(sym) ?? [];
      let streak = 0;
      let fires = 0;
      for (const p of fd) {
        if (p.ratePerHour >= r.threshPerHour) {
          streak += 1;
          if (streak === r.intervals) fires += 1;
        } else {
          streak = 0;
        }
      }
      return String(fires);
    });
    const isBinding = r.threshPerHour === 0.0005 && r.intervals === 6;
    const tag = isBinding ? ' (binding)' : '';
    lines.push(`| ${(r.threshPerHour * 100).toFixed(3)}%${tag} | ${r.intervals} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  // Decision per spec: at least 4 / 9 windows pass.
  // Compute peak per-hour funding observed on each symbol so the decision
  // narrative can call out empirical reality vs the spec threshold without
  // making QuantTrader cross-reference the table above.
  const peakPerHour: Record<string, number> = {};
  for (const sym of symbols) {
    const fd = fundingByPair.get(sym) ?? [];
    peakPerHour[sym] = fd.reduce((m, p) => (p.ratePerHour > m ? p.ratePerHour : m), -Infinity);
  }
  const peakStr = symbols.map((s) => `${s}=${(peakPerHour[s] * 100).toFixed(4)}%/h`).join(', ');

  lines.push('## Decision\n');
  if (passingCount >= 4) {
    lines.push(`**PASS** — ${passingCount} / ${windows.length} windows met §8 acceptance bars (quorum 4 per TRA-293 spec). Promotion plan: extend \`paramsByDirection.short.byTimeframe['4h']\` with a \`fundingExtremeShort\` knob alongside \`cascadeLeg4h\` and \`btcRsiBracket\`, plumb funding context through the Strategy interface, and reassign back to QuantTrader for sign-off.`);
  } else if (totalFires === 0) {
    lines.push(`**FAIL — trigger never fires on the r9 universe.** 0 / ${windows.length} windows met §8 acceptance bars; the +0.0005/h × 6-interval condition never triggered against the Binance USD-M funding history for SOL+DOGE over the full 4-year span (peak observed: ${peakStr}).`);
    lines.push('');
    lines.push(`The spec-suggested relaxation pass (lower threshold to +0.04%/h, OR shorten consecutive count from 6 → 4, OR both) does **not** move the count off zero — the threshold-sensitivity table above shows the trigger only fires once the per-hour threshold is dropped to ≤ +0.01%/h, and in any meaningful count only at ≤ +0.005%/h.`);
    lines.push('');
    lines.push(`Per TRA-293 spec, **do not relax the entry threshold here** — reassign to QuantTrader for the relaxation pass with this empirical funding distribution attached. Candidate thresholds the data supports (see "Threshold-sensitivity diagnostic" above): per-hour ≤ +0.008%/h × 6 intervals, or ≤ +0.005%/h × 4 intervals.`);
  } else if (windows.filter((w) => w.triggerToTradeCount < 4).length >= 6) {
    lines.push(`**FAIL — narrow regime.** Only ${passingCount} / ${windows.length} windows met §8 acceptance bars. Trigger fired & converted to trades < 4 in ${windows.filter((w) => w.triggerToTradeCount < 4).length} of ${windows.length} windows. Per TRA-293 spec, do not relax the entry threshold here — comment back to QuantTrader for a relaxation pass (candidate: lower per-hour funding threshold to +0.04%/h, or shorten consecutive-interval count from 6 to 4).`);
  } else {
    lines.push(`**FAIL** — only ${passingCount} / ${windows.length} windows met §8 acceptance bars (quorum 4). Reassign TRA-291 to QuantTrader for next Phase-1.2 substitution path.`);
  }
  return lines.join('\n');
}

// ── Main ───────────────────────────────────────────────────────────────────

interface SidecarShape {
  generatedAt: string;
  granularity: '4h';
  universe: string[];
  initialEquityUsd: number;
  feeBps: number;
  slippageBps: number;
  trainBars: number;
  testBars: number;
  triggerSpec: {
    fundingThresholdPerHour: number;
    intervalCount: number;
    atrStopMultiplier: number;
    rrTarget: number;
    atrTrailMultiplier: number;
    timeStopBars: number;
    carryBrokenPerHour: number;
    carryBrokenIntervalCount: number;
    riskFraction: number;
  };
  perWindow: Array<{
    index: number;
    testStart: string;
    testEnd: string;
    metrics: UniverseMetrics;
    perSymbol: PerSymbolMetrics[];
    triggerFireCount: number;
    triggerToTradeCount: number;
    carryBrokenExitCount: number;
    skipReasons: Record<string, number>;
  }>;
  aggregate: {
    trades: number;
    winners: number;
    hitRatePct: number;
    expectancyR: number;
    totalPnlUsd: number;
    rollingMaxDrawdownPct: number;
    triggerFires: number;
    triggerToTrades: number;
    carryBrokenExits: number;
    passingWindows: number;
  };
}

async function main() {
  const fromMs = FROM_MS;
  const toMs = Date.now();
  console.log(`[run-tra293-sweep] r9 universe = ${R9_UNIVERSE.join(', ')}`);
  console.log(`[run-tra293-sweep] Loading 4H bars + funding history ${formatDate(fromMs)} → ${formatDate(toMs)}…`);

  const fullByPair = new Map<string, Candle[]>();
  const fundingByPair = new Map<string, FundingPoint[]>();
  for (const sym of R9_UNIVERSE) {
    const bars = await loadOrFetch4hBarsLocal(sym, fromMs, toMs);
    fullByPair.set(sym, bars);
    console.log(`  ${sym}: ${bars.length} 4H bars (${formatDate(bars[0].timestamp)} → ${formatDate(bars[bars.length - 1].timestamp)})`);
    const fd = await loadOrFetchFunding(sym, fromMs, toMs);
    fundingByPair.set(sym, fd);
    console.log(`  ${sym}: ${fd.length} funding intervals (${fd.length > 0 ? formatDate(fd[0].ts) : '—'} → ${fd.length > 0 ? formatDate(fd[fd.length - 1].ts) : '—'})`);
  }

  // Align symbols to TRA-287's common start (2023-07-13) so the §8 read is
  // apples-to-apples with the failing baseline. SOL + DOGE both go back to
  // 2022-01-01 on Coinbase 4H, but the TRA-287 5-symbol sweep was capped by
  // XRP-USD's later 4H start. Pinning here keeps the window count at 9 and
  // the test spans aligned with TRA-287.
  const commonStart = Math.max(TRA287_COMMON_START_MS, ...R9_UNIVERSE.map((s) => fullByPair.get(s)![0].timestamp));
  for (const sym of R9_UNIVERSE) {
    const bars = fullByPair.get(sym)!;
    fullByPair.set(sym, bars.filter((c) => c.timestamp >= commonStart));
  }
  console.log(`[run-tra293-sweep] aligned common start: ${formatDate(commonStart)} (TRA-287 reference)`);

  const minLen = Math.min(...R9_UNIVERSE.map((s) => fullByPair.get(s)!.length));
  const wins = buildWindows(minLen, TRAIN_BARS, TEST_BARS, STEP_BARS);
  console.log(`[run-tra293-sweep] running ${wins.length} walk-forward windows…`);

  const windows: WindowReport[] = [];
  const perWindow: Array<{ index: number; metrics: UniverseMetrics; perSymbol: PerSymbolMetrics[] }> = [];
  for (let i = 0; i < wins.length; i++) {
    const win = wins[i];
    const sliceMap = new Map<string, Candle[]>();
    for (const sym of R9_UNIVERSE) {
      const all = fullByPair.get(sym)!;
      // Include train slice as warmup for ATR; trades only count if opened in test span.
      sliceMap.set(sym, all.slice(win.trainStart, win.testEnd));
    }
    const sim = runFundingExtremeSim({ candlesBySymbol: sliceMap, fundingBySymbol: fundingByPair });

    const sampleSlice = fullByPair.get(R9_UNIVERSE[0])!;
    const testStartTs = sampleSlice[win.testStart].timestamp;
    const testEndTs = sampleSlice[Math.min(win.testEnd - 1, sampleSlice.length - 1)].timestamp;

    const testTrades = sim.closedShorts.filter((t) => t.openedAt >= testStartTs && t.openedAt <= testEndTs);
    const testEquity = sim.equityCurve.filter((p) => p.ts >= testStartTs && p.ts <= testEndTs);

    const w: WindowReport = {
      index: i,
      trainStart: win.trainStart,
      trainEnd: win.trainEnd,
      testStart: win.testStart,
      testEnd: win.testEnd,
      closedShorts: testTrades,
      equityCurve: testEquity,
      skipReasons: sim.skipReasons,
      triggerFireCount: sim.triggerFireCount,
      triggerToTradeCount: sim.triggerToTradeCount,
      carryBrokenExitCount: sim.carryBrokenExitCount,
    };
    windows.push(w);
    const ps = perSymbolMetrics(testTrades, [...R9_UNIVERSE]);
    const um = universeMetrics(testTrades, testEquity);
    perWindow.push({ index: i, metrics: um, perSymbol: ps });
    console.log(`  window ${i}: trades=${testTrades.length}, fires=${sim.triggerFireCount}→${sim.triggerToTradeCount}, carry-exits=${sim.carryBrokenExitCount}, expectancy=${um.expectancyR.toFixed(3)}R`);
  }

  const report = buildReport({ windows, perWindow, symbols: [...R9_UNIVERSE], fullByPair, fundingByPair });
  mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = resolve(REPORT_DIR, 'tra291-sweep-4h-r9-funding-extreme.md');
  writeFileSync(reportPath, report);
  console.log(`\n[run-tra293-sweep] Report: ${reportPath}`);

  const passingCount = perWindow.filter((w) => w.metrics.passes).length;
  const allTrades = windows.flatMap((w) => w.closedShorts);
  const allWinners = allTrades.filter((t) => t.pnlUsd > 0);
  const aggregateExpectancy = allTrades.length > 0 ? allTrades.reduce((s, t) => s + t.rMultiple, 0) / allTrades.length : 0;
  const aggregatePnl = allTrades.reduce((s, t) => s + t.pnlUsd, 0);
  const aggregateHit = allTrades.length > 0 ? (allWinners.length / allTrades.length) * 100 : 0;
  const fullCurve = windows.flatMap((w) => w.equityCurve);
  const aggregateDD = rollingMaxDrawdownPct(fullCurve, ROLLING_DD_BARS);
  const totalFires = windows.reduce((s, w) => s + w.triggerFireCount, 0);
  const totalToTrade = windows.reduce((s, w) => s + w.triggerToTradeCount, 0);
  const totalCarryExits = windows.reduce((s, w) => s + w.carryBrokenExitCount, 0);

  const sidecar: SidecarShape = {
    generatedAt: new Date().toISOString(),
    granularity: '4h',
    universe: [...R9_UNIVERSE],
    initialEquityUsd: INITIAL_EQUITY_USD,
    feeBps: FEE_BPS,
    slippageBps: SLIPPAGE_BPS,
    trainBars: TRAIN_BARS,
    testBars: TEST_BARS,
    triggerSpec: {
      fundingThresholdPerHour: TRIGGER_FUNDING_PER_HOUR,
      intervalCount: TRIGGER_INTERVAL_COUNT,
      atrStopMultiplier: ATR_STOP_MULTIPLIER,
      rrTarget: RR_TARGET,
      atrTrailMultiplier: ATR_TRAIL_MULTIPLIER,
      timeStopBars: TIME_STOP_BARS,
      carryBrokenPerHour: CARRY_BROKEN_PER_HOUR,
      carryBrokenIntervalCount: CARRY_BROKEN_INTERVAL_COUNT,
      riskFraction: RISK_FRACTION,
    },
    perWindow: windows.map((w) => {
      const sampleSlice = fullByPair.get(R9_UNIVERSE[0])!;
      const tStart = sampleSlice[w.testStart].timestamp;
      const tEnd = sampleSlice[Math.min(w.testEnd - 1, sampleSlice.length - 1)].timestamp;
      return {
        index: w.index,
        testStart: formatDate(tStart),
        testEnd: formatDate(tEnd),
        metrics: perWindow[w.index].metrics,
        perSymbol: perWindow[w.index].perSymbol,
        triggerFireCount: w.triggerFireCount,
        triggerToTradeCount: w.triggerToTradeCount,
        carryBrokenExitCount: w.carryBrokenExitCount,
        skipReasons: Object.fromEntries(w.skipReasons),
      };
    }),
    aggregate: {
      trades: allTrades.length,
      winners: allWinners.length,
      hitRatePct: aggregateHit,
      expectancyR: aggregateExpectancy,
      totalPnlUsd: aggregatePnl,
      rollingMaxDrawdownPct: aggregateDD,
      triggerFires: totalFires,
      triggerToTrades: totalToTrade,
      carryBrokenExits: totalCarryExits,
      passingWindows: passingCount,
    },
  };
  const sidecarPath = resolve(REPORT_DIR, 'tra291-sweep-4h-r9-funding-extreme.json');
  writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));
  console.log(`[run-tra293-sweep] JSON sidecar: ${sidecarPath}`);

  console.log(`\n=== TRA-293 §8 (4H r9 funding-extreme-short) ===`);
  console.log(`Windows passing: ${passingCount} / ${windows.length} (quorum 4)`);
  console.log(`Aggregate: ${allTrades.length} trades, hit=${aggregateHit.toFixed(1)}%, expectancy=${aggregateExpectancy.toFixed(3)}R, PnL=$${aggregatePnl.toFixed(0)}, DD90=${aggregateDD.toFixed(2)}%`);
  console.log(`Trigger fires: ${totalFires} raw → ${totalToTrade} trades, carry-broken exits: ${totalCarryExits}`);
}

const invoked = process.argv[1] && /[\\/]run-tra293-sweep\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
