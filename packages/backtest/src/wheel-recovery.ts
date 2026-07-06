// TRA-1322 — Guarded covered-call recovery branch on the TRA-592 put-write sleeve.
//
// Paper/backtest ONLY. No live wiring, no live flags. This is the ported,
// in-repo home of QuantTrader's TRA-1146 Phase-1 wheel screen (reference script
// `wheel-backtest.mjs`, attached on TRA-1146), plus the guards the board
// approved (confirmation 996bbfb2, 2026-07-06) as the ONLY defensible build:
//
//   the bare wheel (accept-assignment, no stop) has an unbounded left tail —
//   maxDD 92% and −120% sum-return-on-collateral in the 2026 downtrend on the
//   full 25-name universe. The guards below cap that tail so the recovery branch
//   is genuinely additive over the stopped put-write instead of net-negative.
//
// The state machine is a faithful port of the reference (same TRA-592 §B entry,
// same Black-Scholes, same VRP-band IV, same 50%-buyback / accept-assignment /
// covered-call mechanics, same return-on-collateral denominator). With guards
// left OFF (`guards: undefined`) it reproduces the reference results bit-for-bit
// — that is the parity contract exercised by `wheel-recovery.test.ts`.
//
// The GUARDS the board required (all off by default → bare wheel):
//   • Call floored at cost basis — never lock a loss on the call leg. (Already in
//     the reference via the pickStrike floor; kept and made explicit.)
//   • Hard stock-side stop — liquidate assigned stock if it falls a fixed % below
//     cost basis. This is the guard that removes the unbounded tail (no bag-holding).
//   • Max recovery window — at most N covered-call cycles, then liquidate.
//
// Downstream gates G1–G4 (real-chain replay, CI-lower-bound robustness, spread/
// slippage stress, owner/board approval) are OUT OF SCOPE here and tracked on
// TRA-1143 behind the real-chain data clock. This module does the code + the
// Phase-1 synthetic-IV backtest, which need no real chains.

import { blackScholesPrice, blackScholesDelta } from '@trading-app/engine';

const R = 0.045; // risk-free rate, matches TRA-592 harness
const SLIP = 0.01; // 1¢/share modeled microstructure cost per side

// ── Black-Scholes adapters (engine primitives; identical formula to the
//    reference's inline verbatim port → bit-identical numerics). ──
function bsPrice(spot: number, strike: number, T: number, sigma: number, type: 'call' | 'put'): number {
  return blackScholesPrice({ spot, strike, timeToExpiryYears: T, riskFreeRate: R, volatility: sigma, optionType: type });
}
function bsDelta(spot: number, strike: number, T: number, sigma: number, type: 'call' | 'put'): number {
  return blackScholesDelta({ spot, strike, timeToExpiryYears: T, riskFreeRate: R, volatility: sigma, optionType: type });
}

// ── Indicators (verbatim conventions from the reference / TRA-592 harness). ──
export function sma(a: number[], i: number, n: number): number | null {
  if (i + 1 < n) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += a[k]!;
  return s / n;
}
export function rsi(c: number[], i: number, n = 14): number | null {
  if (i < n) return null;
  let g = 0, l = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const d = c[k]! - c[k - 1]!;
    if (d > 0) g += d; else l -= d;
  }
  if (l === 0) return 100;
  const rs = g / l;
  return 100 - 100 / (1 + rs);
}
export function realizedVol(c: number[], i: number, n = 20): number | null {
  if (i < n) return null;
  let m = 0;
  const rr: number[] = [];
  for (let k = i - n + 1; k <= i; k++) {
    const ret = Math.log(c[k]! / c[k - 1]!);
    rr.push(ret);
    m += ret;
  }
  m /= n;
  let v = 0;
  for (const x of rr) v += (x - m) ** 2;
  v /= (n - 1);
  return Math.sqrt(v * 252);
}

function strikeStep(S: number): number {
  return S >= 500 ? 10 : S >= 200 ? 5 : S >= 50 ? 2.5 : S >= 20 ? 1 : 0.5;
}

/**
 * Nearest listed strike to a target delta, at or above an optional floor. The
 * `floor` is how the covered-call leg is kept at/above cost basis — a covered
 * call struck below basis would lock in a realized loss, which the wheel
 * discipline (and TRA-1322 guard #1) forbids.
 */
export function pickStrike(
  S: number, T: number, sigma: number, type: 'call' | 'put', targetDelta: number, floor = 0,
): number | null {
  const step = strikeStep(S);
  let best: number | null = null, bestErr = 1e9;
  for (let k = Math.max(step, Math.round((S * 0.5) / step) * step); k <= S * 1.6; k += step) {
    if (k < floor) continue;
    const dd = Math.abs(bsDelta(S, k, T, sigma, type));
    const e = Math.abs(dd - targetDelta);
    if (e < bestErr) { bestErr = e; best = k; }
  }
  return best;
}

/** One symbol's daily series. */
export interface PriceSeries {
  sym: string;
  date: string[];
  close: number[];
}

/**
 * The guards the board approved. ALL optional; when omitted the state machine
 * is the bare reference wheel (accept-assignment, no stop, unbounded window) —
 * used only for parity and as the adverse baseline. In any promotion path the
 * guards are REQUIRED.
 */
export interface WheelGuards {
  /**
   * Hard stock-side stop: liquidate the assigned stock if the close falls this
   * fraction below cost basis (e.g. 0.15 = stop at 15% below basis). Removes the
   * unbounded left tail. Omit/undefined → no stop (bare wheel).
   */
  stockStopPct?: number;
  /**
   * Max recovery window: at most this many covered-call cycles after assignment,
   * then liquidate the stock at market. Omit/undefined → unbounded (bare wheel).
   */
  maxCcCycles?: number;
}

export interface WheelParams {
  ivFactor: number;
  guards?: WheelGuards;
}

/** A closed wheel cycle (CSP entry → back to FLAT). */
export interface WheelCycle {
  sym: string;
  entryDate: string;
  exitDate: string;
  reason: string;
  pnl: number;
  collateral: number;
  retColl: number;
  hold: number;
  K: number;
  /** Covered-call cycles run during this wheel cycle (0 if never assigned). */
  ccCycles: number;
}

export interface WheelRunResult {
  cycles: WheelCycle[];
  assignedCount: number;
  calledAwayCount: number;
  ccSold: number;
  cyclesWithCC: number;
  /** Cycles closed by the hard stock-side stop (guard #2). 0 in bare mode. */
  stoppedCount: number;
  /** Cycles closed by the max-recovery-window liquidation (guard #3). 0 in bare mode. */
  windowLiquidatedCount: number;
}

interface WheelState {
  phase: 'put' | 'stock';
  sym: string;
  entryIdx: number;
  entryDate: string;
  expIdx: number;
  K: number;
  sigma: number;
  credit: number;
  pnl: number;
  collateral: number;
  basis?: number;
  shares?: number;
  ccOpen?: boolean;
  ccK?: number;
  ccCredit?: number;
  ccSigma?: number;
  ccExpIdx?: number;
  /** Number of covered-call cycles opened so far in this wheel cycle. */
  ccCount: number;
}

function closeCycle(st: WheelState, sym: string, exitDate: string, exitIdx: number, reason: string): WheelCycle {
  return {
    sym,
    entryDate: st.entryDate,
    exitDate,
    reason,
    pnl: st.pnl,
    collateral: st.collateral,
    retColl: st.pnl / st.collateral,
    hold: exitIdx - st.entryIdx,
    K: st.K,
    ccCycles: st.ccCount,
  };
}

/**
 * Run the (optionally guarded) wheel state machine over a set of price series.
 * Faithful port of the TRA-1146 reference `runWheel`; the only additions are the
 * two tail-capping guards, gated behind `params.guards` and off by default.
 */
export function runWheel(data: Record<string, PriceSeries>, params: WheelParams): WheelRunResult {
  const { ivFactor, guards } = params;
  const stockStopPct = guards?.stockStopPct;
  const maxCcCycles = guards?.maxCcCycles;

  const cycles: WheelCycle[] = [];
  let assignedCount = 0, calledAwayCount = 0, ccSold = 0, cyclesWithCC = 0;
  let stoppedCount = 0, windowLiquidatedCount = 0;

  for (const sym of Object.keys(data)) {
    const d = data[sym]!;
    const n = d.close.length;
    let st: WheelState | null = null;

    for (let i = 200; i < n; i++) {
      const S = d.close[i]!;
      const s50 = sma(d.close, i, 50), s200 = sma(d.close, i, 200);
      const rv = realizedVol(d.close, i, 20), rsiV = rsi(d.close, i, 14);
      if (s50 == null || s200 == null || rv == null || rsiV == null) continue;
      const sigma = Math.max(rv * ivFactor, 0.12);
      const last = i === n - 1;

      if (st && st.phase === 'put') {
        const dte = st.expIdx - i;
        const Tyr = Math.max(dte, 0) * (1 / 252);
        const mark = bsPrice(S, st.K, Tyr, st.sigma, 'put') + SLIP;
        if (mark <= 0.5 * st.credit) {
          // 50% profit buyback → cycle closes flat
          st.pnl += (st.credit - mark) * 100;
          cycles.push(closeCycle(st, sym, d.date[i]!, i, 'put_profit50'));
          st = null;
        } else if (dte <= 0 || last) {
          if (S >= st.K) {
            // expired OTM (or close-enough at end) → keep credit
            st.pnl += st.credit * 100;
            cycles.push(closeCycle(st, sym, d.date[i]!, i, 'put_expire_otm'));
            st = null;
          } else {
            // ASSIGNED — accept stock. Bare wheel takes no stop here; the guards
            // (below, in the stock phase) are what cap the resulting tail.
            assignedCount++; cyclesWithCC++;
            st.pnl += st.credit * 100;       // keep the put credit
            st.basis = st.K - st.credit;     // effective cost basis / share
            st.shares = 100;
            st.phase = 'stock';
            st.ccOpen = false;
            if (last) {
              // no room to run covered calls — mark stock to market
              st.pnl += (S - st.K) * 100;
              cycles.push(closeCycle(st, sym, d.date[i]!, i, 'assigned_mtm_end'));
              st = null;
            }
          }
        }
      } else if (st && st.phase === 'stock') {
        // ── GUARD #2: hard stock-side stop. Checked every day the stock is held,
        //    before any covered-call management, so a gap-down below the floor
        //    exits immediately rather than bag-holding. This is the guard that
        //    removes the unbounded left tail. ──
        if (stockStopPct != null && st.basis != null && S <= st.basis * (1 - stockStopPct)) {
          // Realize the stock leg vs the assignment strike (a bounded loss, since
          // the stop floor is a fixed % below basis). If a covered call is open we
          // buy it to close at its current mark and keep the net of premium minus
          // that cost — in a crash the call is deep OTM (≈0) so we keep ~all of it.
          st.pnl += (S - st.K) * 100;
          if (st.ccOpen) {
            const dte = st.ccExpIdx! - i;
            const Tyr = Math.max(dte, 0) * (1 / 252);
            const callMark = bsPrice(S, st.ccK!, Tyr, st.ccSigma!, 'call') + SLIP;
            st.pnl += (st.ccCredit! - callMark) * 100;
          }
          cycles.push(closeCycle(st, sym, d.date[i]!, i, 'stock_stop'));
          stoppedCount++;
          st = null;
          continue;
        }

        // manage open covered call
        if (st.ccOpen) {
          const dte = st.ccExpIdx! - i;
          if (dte <= 0 || last) {
            if (S >= st.ccK!) {
              // called away
              calledAwayCount++;
              st.pnl += (st.ccK! - st.K) * 100; // stock P&L vs assignment strike
              st.pnl += st.ccCredit! * 100;     // keep call credit
              cycles.push(closeCycle(st, sym, d.date[i]!, i, 'called_away'));
              st = null;
            } else {
              // expired OTM — keep call credit, will re-sell
              st.pnl += st.ccCredit! * 100;
              st.ccOpen = false;
            }
          }
        }

        if (st && st.phase === 'stock' && last && !st.ccOpen) {
          // end of data while holding stock: mark to market vs assignment strike
          st.pnl += (S - st.K) * 100;
          cycles.push(closeCycle(st, sym, d.date[i]!, i, 'stock_mtm_end'));
          st = null;
        } else if (st && st.phase === 'stock' && !st.ccOpen && !last) {
          // ── GUARD #3: max recovery window. Once we've run the allowed number of
          //    covered-call cycles without being called away, liquidate the stock
          //    at market rather than holding indefinitely. ──
          if (maxCcCycles != null && st.ccCount >= maxCcCycles) {
            st.pnl += (S - st.K) * 100;
            cycles.push(closeCycle(st, sym, d.date[i]!, i, 'max_window_liquidation'));
            windowLiquidatedCount++;
            st = null;
            continue;
          }
          // sell a fresh covered call — GUARD #1: strike floored at cost basis so
          // the call leg can never lock a loss.
          const Tyr = 30 / 365;
          const K = pickStrike(S, Tyr, sigma, 'call', 0.30, st.basis!);
          if (K != null) {
            const credit = bsPrice(S, K, Tyr, sigma, 'call') - SLIP;
            if (credit > 0.05) {
              st.ccOpen = true; st.ccK = K; st.ccCredit = credit; st.ccSigma = sigma;
              st.ccExpIdx = Math.min(i + 21, n - 1);
              st.ccCount += 1;
              ccSold++;
            }
          }
        }
      }

      // ENTRY (FLAT): TRA-592 §B support filter — sell cash-secured 30-DTE 0.25Δ put
      if (!st) {
        const nearSupport = S > s50 && s50 >= s200 && (S / s50 - 1) <= 0.08 && rsiV >= 35 && rsiV <= 58;
        if (nearSupport && !last) {
          const Tyr = 30 / 365;
          const K = pickStrike(S, Tyr, sigma, 'put', 0.25);
          if (K != null) {
            const credit = bsPrice(S, K, Tyr, sigma, 'put') - SLIP;
            if (credit > 0.05) {
              st = {
                phase: 'put', sym, entryIdx: i, entryDate: d.date[i]!,
                expIdx: Math.min(i + 21, n - 1), K, sigma, credit, pnl: 0,
                collateral: K * 100, ccCount: 0,
              };
            }
          }
        }
      }
    }
  }

  return { cycles, assignedCount, calledAwayCount, ccSold, cyclesWithCC, stoppedCount, windowLiquidatedCount };
}

export interface WheelMetrics {
  n: number;
  winRate?: number;
  avgRetColl?: number;
  annRetColl?: number;
  medRetColl?: number;
  sharpe?: number;
  pf?: number;
  maxDD?: number;
  avgHold?: number;
  tpy?: number;
  worst?: number;
  best?: number;
}

/** Return-on-collateral metrics — verbatim port of the reference `metrics`. */
export function metrics(cycles: WheelCycle[]): WheelMetrics {
  if (!cycles.length) return { n: 0 };
  const rets = cycles.map((c) => c.retColl);
  const wins = cycles.filter((c) => c.pnl > 0), losses = cycles.filter((c) => c.pnl <= 0);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1 || 1));
  const avgHold = cycles.reduce((a, b) => a + b.hold, 0) / cycles.length;
  const tpy = 252 / avgHold;
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(tpy) : 0;
  const gW = wins.reduce((a, b) => a + b.pnl, 0), gL = losses.reduce((a, b) => a + b.pnl, 0);
  const pf = Math.abs(gW / (gL || -1e-9));
  const seq = [...cycles].sort((a, b) => new Date(a.exitDate).getTime() - new Date(b.exitDate).getTime());
  let eq = 1, peak = 1, mdd = 0;
  for (const c of seq) { eq *= (1 + c.retColl); peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak); }
  const sorted = rets.slice().sort((a, b) => a - b);
  return {
    n: cycles.length, winRate: wins.length / cycles.length,
    avgRetColl: mean, annRetColl: mean * (252 / avgHold), medRetColl: sorted[Math.floor(rets.length / 2)],
    sharpe, pf, maxDD: mdd, avgHold, tpy,
    worst: Math.min(...rets), best: Math.max(...rets),
  };
}

/** Full 25-symbol watchlist (packages/shared WATCHLIST; XYZ = renamed Block Inc.). */
export const WHEEL_FULL_UNIVERSE = [
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AMD', 'NFLX', 'ORCL',
  'INTC', 'QCOM', 'AVGO', 'CRM', 'ADBE', 'PYPL', 'XYZ', 'SHOP', 'COIN', 'MSTR',
  'SPY', 'QQQ', 'IWM', 'DIA', 'XLF',
] as const;

/**
 * TRA-592 "quality lower-vol" sub-universe (ETFs + mega-cap; secular single
 * names excluded). This is the universe the guarded recovery branch is
 * restricted to (TRA-1322 scope item 3), via the TRA-421 per-strategy filter.
 */
export const WHEEL_QUALITY_UNIVERSE = [
  'SPY', 'QQQ', 'DIA', 'IWM', 'XLF', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'AVGO',
] as const;

/**
 * Restrict a price-series map to a universe (mirrors the TRA-421 filter intent).
 * Insertion order follows `universe`, not the input map — `runWheel` iterates
 * `Object.keys` in insertion order and the maxDD equity path breaks same-exit-date
 * ties by that order, so matching the reference run's symbol ordering is what
 * keeps the quality-universe parity exact.
 */
export function restrictUniverse(
  data: Record<string, PriceSeries>, universe: readonly string[],
): Record<string, PriceSeries> {
  const out: Record<string, PriceSeries> = {};
  for (const sym of universe) { const s = data[sym]; if (s) out[sym] = s; }
  return out;
}
