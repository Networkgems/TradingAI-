/**
 * TRA-471 — regime-gate-aware ORB P&L backtest (MA-variant comparison).
 *
 * Child of TRA-470 (S&P trend-filter MA length for the ORB regime gate). The
 * QuantTrader gate-flip analysis recommends replacing the production 20-DMA
 * trend filter with SMA-50 + ±1% hysteresis; this harness is the P&L
 * confirmation the TRA-470 report needs before board sign-off.
 *
 * What it does
 * ------------
 *  1. Runs the real `OrbStrategy` (`packages/engine/src/strategies/orb.ts`)
 *     across the 25-name `WATCHLIST` on intraday bars — one session-scoped
 *     window per bar, exactly the shape the live engine feeds it.
 *  2. For each candidate ORB signal it derives the `^GSPC` trend gate for the
 *     signal's session date and keeps an ORB **long only when the gate is UP**
 *     and an ORB **short only when the gate is DOWN** — the `deriveGates()`
 *     `orbLongs` / `orbShorts` filter from `market-review.ts`.
 *  3. Sweeps the trend filter across the six configs the QuantTrader analysed:
 *     SMA-20 (production baseline), SMA-50, SMA-200, EMA-50, Dual-MA 50/200,
 *     and SMA-50 ±1% hysteresis.
 *  4. Reports per config — ORB-only — net return, Sharpe, max drawdown, trade
 *     count and gate-flip frequency.
 *
 * Data-depth defect (TRA-470 callout)
 * -----------------------------------
 * Production `readIndexes()` in `market-review.ts` fetches only `MA_PERIOD + 5`
 * (= 25) `^GSPC` daily candles. A 200-DMA needs ≥ 200 bars, so SMA-200 / EMA-50
 * / Dual-MA cannot even be *computed* on that feed. This harness fetches the
 * `^GSPC` daily series at `max(period, 200) + testWindow + slack` depth — the
 * scaling fix the parent issue called for. No production edit is made here:
 * `MA_PERIOD` stays 20 until the board approves (per the TRA-471 deliverable).
 *
 * Feed
 * ----
 * `backtest-equity.ts` paginates Twelve Data intraday bars, but the free-tier
 * key (`TWELVE_DATA_API_KEY`) is not present in this environment. The harness
 * therefore uses Yahoo's chart endpoint via `yahoo-finance2` — the same
 * provider `fetch-tra266-data.ts` uses for daily bars and the same one
 * `yahoo-feed.ts` already lists in the intraday chart-fallback chain — so no
 * feed code is reinvented and no key is required. If `TWELVE_DATA_API_KEY` is
 * set, it would still be Yahoo here: Yahoo's 5-minute history (~60 days) and
 * Twelve Data's free tier (~30 days) are both short, and a single provider for
 * intraday + `^GSPC` daily keeps the timestamps consistent.
 *
 * Window — two passes
 * -------------------
 * Yahoo caps 5-minute history at ~60 days, which is too short to tell SMA-50 /
 * SMA-200 / EMA-50 apart (a 2-month tape rarely crosses more than one of them).
 * So the harness runs two passes:
 *   - 5m  / ~58 days  — the faithful 30-minute ORB, but MA-indiscriminate.
 *   - 1h  / ~730 days — a coarser first-hour-range ORB over a 2-year window
 *                       that spans real regime changes, so the MA variants and
 *                       the `orbShorts` path are actually exercised.
 * The exact window and bar count of each pass are printed in the output. The
 * 2022 bear market is NOT reachable on any free intraday tier (Yahoo 1h caps at
 * 730 days) — stated as a limitation; a paid-tier 2022 re-run is a follow-up.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra470-orb-gate.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YahooFinance from 'yahoo-finance2';
import { OrbStrategy } from '@trading-app/engine';
import { WATCHLIST } from '@trading-app/shared';
import type { Candle } from '@trading-app/shared';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');

const yf = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  validation: { logErrors: false },
});

// ── Backtest knobs ───────────────────────────────────────────────────────────
type IntradayInterval = '5m' | '1h';
/**
 * Two passes. The 5m pass is the faithful 30-minute ORB but Yahoo caps 5m
 * history at ~60 days — too short to tell SMA-50 / SMA-200 / EMA-50 apart
 * (a 2-month tape rarely crosses more than one of them). The 1h pass trades a
 * coarser opening range (the first hourly bar) for a 2-year window that spans
 * real regime changes, so the MA variants — and the `orbShorts` path — are
 * actually exercised. Yahoo caps 1h history at 730 days.
 */
const PASSES: { label: string; interval: IntradayInterval; days: number }[] = [
  { label: 'Primary — 5m bars (~58d, faithful 30-min ORB)', interval: '5m', days: 58 },
  { label: 'Long-window — 1h bars (~730d, regime-discriminating)', interval: '1h', days: 729 },
];
/** `^GSPC` daily depth: deepest MA (200) + longest test window + warm-up slack. */
const GSPC_DAILY_DAYS = 1000;
const SLIPPAGE_BPS = 5; // matches backtest-equity.ts (commission-free equities)
const RISK_PER_TRADE = 0.01; // 1% of equity risked per trade
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

// ── Yahoo feed ───────────────────────────────────────────────────────────────

async function fetchChart(
  symbol: string,
  interval: IntradayInterval | '1d',
  days: number,
): Promise<Candle[]> {
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const result = await yf.chart(symbol, { period1: from, period2: now, interval });
  const quotes = result?.quotes ?? [];
  return quotes
    .filter((q) => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({
      symbol,
      timestamp: new Date(q.date).getTime(),
      open: q.open!,
      high: q.high!,
      low: q.low!,
      close: q.close!,
      volume: q.volume ?? 0,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

// ── ET calendar-date helper ──────────────────────────────────────────────────

/** `YYYY-MM-DD` calendar date in America/New_York for a UTC ms timestamp. */
function etDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ── Indicator series ─────────────────────────────────────────────────────────

/** Simple moving average; NaN before index `period - 1`. */
function smaSeries(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average; SMA-seeded at index `period - 1`, NaN before. */
function emaSeries(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

// ── Trend-gate configs ───────────────────────────────────────────────────────
// Gate labels mirror `deriveGates()` exactly:
//   orbLongs  = close ≥ MA        → 'UP'
//   orbShorts = close < MA        → 'DOWN'
// Dual-MA adds a NEUTRAL band; hysteresis holds the prior state inside ±1%.

type GateLabel = 'UP' | 'DOWN' | 'NEUTRAL' | 'NA';

interface GateConfig {
  key: string;
  label: string;
  /** Per-daily-bar gate label array, given the `^GSPC` daily candles. */
  compute: (daily: Candle[]) => GateLabel[];
}

function simpleMaGate(closes: number[], ma: number[]): GateLabel[] {
  return closes.map((c, i) =>
    Number.isFinite(ma[i]) ? (c >= ma[i] ? 'UP' : 'DOWN') : 'NA',
  );
}

const GATE_CONFIGS: GateConfig[] = [
  {
    key: 'sma20',
    label: 'SMA-20 (baseline)',
    compute: (d) => {
      const closes = d.map((c) => c.close);
      return simpleMaGate(closes, smaSeries(closes, 20));
    },
  },
  {
    key: 'sma50',
    label: 'SMA-50',
    compute: (d) => {
      const closes = d.map((c) => c.close);
      return simpleMaGate(closes, smaSeries(closes, 50));
    },
  },
  {
    key: 'sma200',
    label: 'SMA-200',
    compute: (d) => {
      const closes = d.map((c) => c.close);
      return simpleMaGate(closes, smaSeries(closes, 200));
    },
  },
  {
    key: 'ema50',
    label: 'EMA-50',
    compute: (d) => {
      const closes = d.map((c) => c.close);
      return simpleMaGate(closes, emaSeries(closes, 50));
    },
  },
  {
    key: 'dual',
    label: 'Dual-MA 50/200',
    compute: (d) => {
      const closes = d.map((c) => c.close);
      const sma50 = smaSeries(closes, 50);
      const sma200 = smaSeries(closes, 200);
      return closes.map((c, i) => {
        if (!Number.isFinite(sma50[i]) || !Number.isFinite(sma200[i])) return 'NA';
        // UP   = close > SMA50 AND SMA50 > SMA200
        // DOWN = close < SMA50 AND SMA50 < SMA200
        if (c > sma50[i] && sma50[i] > sma200[i]) return 'UP';
        if (c < sma50[i] && sma50[i] < sma200[i]) return 'DOWN';
        return 'NEUTRAL';
      });
    },
  },
  {
    key: 'hyst50',
    label: 'SMA-50 ±1% hysteresis',
    compute: (d) => {
      const closes = d.map((c) => c.close);
      const sma50 = smaSeries(closes, 50);
      const out: GateLabel[] = [];
      let state: GateLabel = 'NA';
      for (let i = 0; i < closes.length; i++) {
        const ma = sma50[i];
        if (!Number.isFinite(ma)) {
          out.push('NA');
          continue;
        }
        // Flip to UP only above MA×1.01, to DOWN only below MA×0.99, else hold.
        if (closes[i] > ma * 1.01) state = 'UP';
        else if (closes[i] < ma * 0.99) state = 'DOWN';
        else if (state === 'NA') state = closes[i] >= ma ? 'UP' : 'DOWN'; // seed
        out.push(state);
      }
      return out;
    },
  },
];

// ── ORB signal generation + trade simulation ─────────────────────────────────

interface OrbTrade {
  symbol: string;
  sessionDate: string; // ET date the signal fired on
  side: 'buy' | 'sell';
  rMultiple: number; // net of slippage
  exitTs: number;
  exitReason: 'stop' | 'target' | 'eod';
}

function applySlip(side: 'buy' | 'sell', leg: 'entry' | 'exit', raw: number): number {
  const s = SLIPPAGE_BPS / 10_000;
  // Adverse: buys fill up, sells fill down on entry; the reverse on exit.
  const up = (side === 'buy') === (leg === 'entry');
  return up ? raw * (1 + s) : raw * (1 - s);
}

/**
 * Run `OrbStrategy` over one symbol's intraday bars, session by session, and
 * simulate every fired signal as a 2R bracket (next-bar-open entry, EOD close
 * if neither level is hit). One trade open at a time per symbol — re-entry
 * resumes after the prior trade closes, mirroring the backtest runner.
 */
function collectOrbTrades(symbol: string, bars: Candle[]): OrbTrade[] {
  const orb = new OrbStrategy(); // engine defaults (ET session anchor + windows)
  const trades: OrbTrade[] = [];

  // Group bars by ET session date so each `evaluate()` window is one session —
  // ORB's session anchor finds the first 9:30 ET bar in the window, so a
  // multi-session window would anchor on the wrong day.
  const sessions = new Map<string, Candle[]>();
  for (const b of bars) {
    const d = etDate(b.timestamp);
    const arr = sessions.get(d);
    if (arr) arr.push(b);
    else sessions.set(d, [b]);
  }

  for (const [date, sb] of sessions) {
    let k = 1; // need ≥ 2 candles for evaluate()
    while (k < sb.length) {
      const sig = orb.evaluate(symbol, sb.slice(0, k + 1));
      if (!sig) {
        k += 1;
        continue;
      }
      // Entry at the next bar's open within the same session.
      const entryIdx = k + 1;
      if (entryIdx >= sb.length) break;
      const entryFill = applySlip(sig.side, 'entry', sb[entryIdx].open);
      const stop = sig.stopLoss;
      const target = sig.takeProfit;
      const risk = Math.abs(entryFill - stop);
      if (risk <= 0) {
        k = entryIdx;
        continue;
      }

      let exitIdx = sb.length - 1;
      let rawExit = sb[exitIdx].close;
      let reason: OrbTrade['exitReason'] = 'eod';
      for (let j = entryIdx + 1; j < sb.length; j++) {
        const bar = sb[j];
        const hitStop = sig.side === 'buy' ? bar.low <= stop : bar.high >= stop;
        const hitTgt = sig.side === 'buy' ? bar.high >= target : bar.low <= target;
        if (hitStop || hitTgt) {
          // Ambiguous bar (both levels in range) resolves pessimistically — stop.
          exitIdx = j;
          rawExit = hitStop ? stop : target;
          reason = hitStop ? 'stop' : 'target';
          break;
        }
      }
      const exitFill = applySlip(sig.side, 'exit', rawExit);
      const dir = sig.side === 'buy' ? 1 : -1;
      trades.push({
        symbol,
        sessionDate: date,
        side: sig.side,
        rMultiple: ((exitFill - entryFill) * dir) / risk,
        exitTs: sb[exitIdx].timestamp,
        exitReason: reason,
      });
      k = exitIdx + 1; // resume scanning after the trade closes
    }
  }
  return trades;
}

// ── Per-config P&L metrics ───────────────────────────────────────────────────

interface ConfigMetrics {
  config: string;
  trades: number;
  longs: number;
  shorts: number;
  droppedByGate: number;
  netReturnPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  winRatePct: number;
  gateFlips: number;
  gateFlipsPerMonth: number;
}

/**
 * Gate label for an ORB signal's session date — the most recent `^GSPC` daily
 * bar *strictly before* that date (premarket-review semantics: no look-ahead
 * onto the signal day's own close).
 */
function gateForSession(
  labels: GateLabel[],
  dailyDates: string[],
  sessionDate: string,
): GateLabel {
  let label: GateLabel = 'NA';
  for (let i = 0; i < dailyDates.length; i++) {
    if (dailyDates[i] < sessionDate) label = labels[i];
    else break;
  }
  return label;
}

function evaluateConfig(
  cfg: GateConfig,
  allTrades: OrbTrade[],
  daily: Candle[],
  windowStart: string,
  windowEnd: string,
  years: number,
): ConfigMetrics {
  const labels = cfg.compute(daily);
  const dailyDates = daily.map((c) => etDate(c.timestamp));

  // Keep ORB longs only when the gate is UP, shorts only when DOWN.
  const kept: OrbTrade[] = [];
  let dropped = 0;
  for (const t of allTrades) {
    const g = gateForSession(labels, dailyDates, t.sessionDate);
    const keep = (t.side === 'buy' && g === 'UP') || (t.side === 'sell' && g === 'DOWN');
    if (keep) kept.push(t);
    else dropped += 1;
  }

  // Equity curve over kept trades, ordered by exit time; 1% risk per trade.
  const ordered = [...kept].sort((a, b) => a.exitTs - b.exitTs);
  let equity = 1;
  let peak = 1;
  let maxDD = 0;
  const perTradeReturns: number[] = [];
  for (const t of ordered) {
    const r = RISK_PER_TRADE * t.rMultiple;
    perTradeReturns.push(r);
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // Trade-frequency-annualised Sharpe (zero risk-free rate).
  let sharpe = 0;
  if (perTradeReturns.length > 1) {
    const mean = perTradeReturns.reduce((s, r) => s + r, 0) / perTradeReturns.length;
    const variance =
      perTradeReturns.reduce((s, r) => s + (r - mean) ** 2, 0) /
      (perTradeReturns.length - 1);
    const std = Math.sqrt(variance);
    const tradesPerYear = years > 0 ? perTradeReturns.length / years : 0;
    sharpe = std > 0 ? (mean / std) * Math.sqrt(tradesPerYear) : 0;
  }

  // Gate-flip frequency over the test window's daily bars.
  let flips = 0;
  let prev: GateLabel | null = null;
  let windowDays = 0;
  for (let i = 0; i < dailyDates.length; i++) {
    const d = dailyDates[i];
    if (d < windowStart || d > windowEnd) continue;
    const cur = labels[i];
    if (cur === 'NA') continue;
    windowDays += 1;
    if (prev !== null && cur !== prev) flips += 1;
    prev = cur;
  }
  const flipsPerMonth = windowDays > 0 ? (flips / windowDays) * 21 : 0;

  const wins = kept.filter((t) => t.rMultiple > 0).length;
  return {
    config: cfg.label,
    trades: kept.length,
    longs: kept.filter((t) => t.side === 'buy').length,
    shorts: kept.filter((t) => t.side === 'sell').length,
    droppedByGate: dropped,
    netReturnPct: (equity - 1) * 100,
    sharpe,
    maxDrawdownPct: maxDD * 100,
    winRatePct: kept.length > 0 ? (wins / kept.length) * 100 : 0,
    gateFlips: flips,
    gateFlipsPerMonth: flipsPerMonth,
  };
}

// ── Ungated reference (keeps every ORB trade, both sides) ────────────────────

function rawOrbAggregate(allTrades: OrbTrade[], years: number): ConfigMetrics {
  const ordered = [...allTrades].sort((a, b) => a.exitTs - b.exitTs);
  let equity = 1;
  let peak = 1;
  let maxDD = 0;
  const rets: number[] = [];
  for (const t of ordered) {
    const r = RISK_PER_TRADE * t.rMultiple;
    rets.push(r);
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  let sharpe = 0;
  if (rets.length > 1) {
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const v = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
    const std = Math.sqrt(v);
    const tpy = years > 0 ? rets.length / years : 0;
    sharpe = std > 0 ? (mean / std) * Math.sqrt(tpy) : 0;
  }
  const wins = allTrades.filter((t) => t.rMultiple > 0).length;
  return {
    config: 'No gate (raw ORB)',
    trades: allTrades.length,
    longs: allTrades.filter((t) => t.side === 'buy').length,
    shorts: allTrades.filter((t) => t.side === 'sell').length,
    droppedByGate: 0,
    netReturnPct: (equity - 1) * 100,
    sharpe,
    maxDrawdownPct: maxDD * 100,
    winRatePct: allTrades.length > 0 ? (wins / allTrades.length) * 100 : 0,
    gateFlips: 0,
    gateFlipsPerMonth: 0,
  };
}

// ── One pass (single intraday interval) ──────────────────────────────────────

function fmt(n: number, d = 2): string {
  return Number.isFinite(n) ? n.toFixed(d) : '—';
}

interface PassResult {
  label: string;
  interval: IntradayInterval;
  window: { start: string; end: string; months: number };
  intradayBars: number;
  symbols: number;
  fetchFailures: string[];
  totalOrbSignals: number;
  rows: ConfigMetrics[]; // raw-ORB row first, then the 6 gate configs
  markdownTable: string;
}

async function runPass(
  pass: { label: string; interval: IntradayInterval; days: number },
  gspcDaily: Candle[],
): Promise<PassResult> {
  console.log(`\n${'#'.repeat(96)}`);
  console.log(`# ${pass.label}`);
  console.log('#'.repeat(96));

  // (1) Intraday bars for the 25-name watchlist.
  console.log(
    `Fetching ${pass.interval} bars (~${pass.days}d) for ${WATCHLIST.length} watchlist names via Yahoo…`,
  );
  const barsBySymbol = new Map<string, Candle[]>();
  const fetchFailures: string[] = [];
  for (const sym of WATCHLIST) {
    try {
      const bars = await fetchChart(sym, pass.interval, pass.days);
      if (bars.length === 0) fetchFailures.push(`${sym} (0 bars)`);
      else barsBySymbol.set(sym, bars);
      process.stdout.write(` ${sym}:${bars.length}`);
    } catch (err) {
      fetchFailures.push(`${sym} (${err instanceof Error ? err.message : String(err)})`);
      process.stdout.write(` ${sym}:FAIL`);
    }
    await new Promise((r) => setTimeout(r, 300)); // be polite to Yahoo
  }
  console.log('\n');
  if (fetchFailures.length > 0) console.log(`Fetch issues: ${fetchFailures.join(', ')}\n`);
  if (barsBySymbol.size === 0) {
    throw new Error(`No ${pass.interval} bars fetched — cannot run this pass.`);
  }

  // (2) ORB signal generation + trade simulation.
  const allTrades: OrbTrade[] = [];
  let totalBars = 0;
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const [sym, bars] of barsBySymbol) {
    totalBars += bars.length;
    minTs = Math.min(minTs, bars[0].timestamp);
    maxTs = Math.max(maxTs, bars[bars.length - 1].timestamp);
    allTrades.push(...collectOrbTrades(sym, bars));
  }
  const windowStart = etDate(minTs);
  const windowEnd = etDate(maxTs);
  const years = (maxTs - minTs) / MS_PER_YEAR;
  const tradingDays = new Set(allTrades.map((t) => t.sessionDate)).size;

  console.log(
    `Test window: ${windowStart} → ${windowEnd}  (${fmt(years * 12, 1)} months, ` +
      `${totalBars.toLocaleString()} intraday ${pass.interval} bars across ${barsBySymbol.size} symbols)`,
  );
  console.log(
    `ORB signals simulated: ${allTrades.length}  ` +
      `(${allTrades.filter((t) => t.side === 'buy').length} long / ` +
      `${allTrades.filter((t) => t.side === 'sell').length} short, on ${tradingDays} session-dates)\n`,
  );

  // (3) Per-config sweep + ungated reference.
  const metrics = GATE_CONFIGS.map((cfg) =>
    evaluateConfig(cfg, allTrades, gspcDaily, windowStart, windowEnd, years),
  );
  const rows = [rawOrbAggregate(allTrades, years), ...metrics];

  // (4) Console table.
  const head =
    'Config'.padEnd(24) +
    'Net Ret%'.padStart(10) +
    'Sharpe'.padStart(9) +
    'MaxDD%'.padStart(9) +
    'Trades'.padStart(8) +
    'L/S'.padStart(10) +
    'Win%'.padStart(8) +
    'Dropped'.padStart(9) +
    'Flips'.padStart(7) +
    'Flips/mo'.padStart(10);
  console.log('='.repeat(head.length));
  console.log(head);
  console.log('-'.repeat(head.length));
  for (const m of rows) {
    console.log(
      m.config.padEnd(24) +
        fmt(m.netReturnPct).padStart(10) +
        fmt(m.sharpe).padStart(9) +
        fmt(m.maxDrawdownPct).padStart(9) +
        String(m.trades).padStart(8) +
        `${m.longs}/${m.shorts}`.padStart(10) +
        fmt(m.winRatePct, 1).padStart(8) +
        String(m.droppedByGate).padStart(9) +
        String(m.gateFlips).padStart(7) +
        fmt(m.gateFlipsPerMonth, 1).padStart(10),
    );
  }
  console.log('='.repeat(head.length));

  // (5) Markdown table for the issue comment.
  const md: string[] = [];
  md.push(`**${pass.label}** — window ${windowStart} → ${windowEnd}, ${allTrades.length} raw ORB signals`);
  md.push('');
  md.push('| Config | Net Return | Sharpe | Max DD | Trades (L/S) | Win % | Gate Flips (/mo) |');
  md.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const m of rows) {
    md.push(
      `| ${m.config} | ${fmt(m.netReturnPct)}% | ${fmt(m.sharpe)} | ${fmt(m.maxDrawdownPct)}% | ` +
        `${m.trades} (${m.longs}/${m.shorts}) | ${fmt(m.winRatePct, 1)}% | ` +
        `${m.gateFlips} (${fmt(m.gateFlipsPerMonth, 1)}) |`,
    );
  }

  return {
    label: pass.label,
    interval: pass.interval,
    window: { start: windowStart, end: windowEnd, months: Number((years * 12).toFixed(2)) },
    intradayBars: totalBars,
    symbols: barsBySymbol.size,
    fetchFailures,
    totalOrbSignals: allTrades.length,
    rows,
    markdownTable: md.join('\n'),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  mkdirSync(REPORT_DIR, { recursive: true });
  console.log('TRA-471 — regime-gate-aware ORB P&L backtest (MA-variant comparison)');

  // `^GSPC` daily series at scaled depth — the TRA-470 data-depth fix. Fetched
  // once and shared by both intraday passes.
  console.log(`\nFetching ^GSPC daily (~${GSPC_DAILY_DAYS}d, scaled depth for SMA-200)…`);
  let gspcDaily = await fetchChart('^GSPC', '1d', GSPC_DAILY_DAYS);
  if (gspcDaily.length < 200) {
    // SPY proxy fallback — ^GSPC index endpoint is flakier (see TRA-469).
    console.log(`  ^GSPC returned ${gspcDaily.length} bars (< 200) — falling back to SPY proxy.`);
    gspcDaily = await fetchChart('SPY', '1d', GSPC_DAILY_DAYS);
  }
  if (gspcDaily.length < 200) {
    throw new Error(`^GSPC daily depth ${gspcDaily.length} < 200 — SMA-200 cannot be computed.`);
  }
  console.log(
    `  ^GSPC daily: ${gspcDaily.length} bars ` +
      `(${etDate(gspcDaily[0].timestamp)} → ${etDate(gspcDaily[gspcDaily.length - 1].timestamp)})`,
  );

  const passes: PassResult[] = [];
  for (const pass of PASSES) {
    passes.push(await runPass(pass, gspcDaily));
  }

  console.log('\nMARKDOWN_TABLE_START');
  console.log(passes.map((p) => p.markdownTable).join('\n\n'));
  console.log('MARKDOWN_TABLE_END');

  const report = {
    issue: 'TRA-471',
    generatedAt: new Date().toISOString(),
    feed: 'Yahoo intraday (5m + 1h) + ^GSPC daily',
    gspcDailyBars: gspcDaily.length,
    riskPerTrade: RISK_PER_TRADE,
    slippageBps: SLIPPAGE_BPS,
    passes,
    notes: [
      'ORB-only P&L; the gate keeps longs when UP and shorts when DOWN.',
      'Twelve Data key absent in this environment — Yahoo feed used (no key required).',
      'Yahoo caps 5m history at ~60 days and 1h at ~730 days; the 2022 bear market is not reachable on a free intraday tier.',
      '5m pass = faithful 30-min ORB; 1h pass = coarser first-hour-range ORB but a 2-year window that actually discriminates the MA variants.',
      'Production market-review.ts readIndexes() fetches MA_PERIOD+5 (=25) ^GSPC bars; this harness fetches max(period,200)+window+slack — the TRA-470 data-depth fix. No production edit made.',
    ],
  };
  const path = resolve(REPORT_DIR, 'tra471-orb-gate.json');
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(`\nReport written: ${path}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
