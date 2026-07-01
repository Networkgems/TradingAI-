// TRA-1221 (parent TRA-1219, rec #2 of the TRA-1211 memo) — regime-gated TSMOM
// crypto OBSERVE-ONLY scanner. Thin sibling to `perp-funding-carry-scanner.ts`
// (TRA-1216) and `crypto-regime-scanner.ts` (TRA-1220): a PURE, stateful
// `scanRegimeTsmom(barsBySymbol, regimeBySymbol, cfg, prevStateBySymbol, now)`
// over 4H candles the caller already fetched, plus an in-memory store backing the
// read-only `GET /api/health/crypto-regime-tsmom` surface. It places NO orders,
// sizes nothing, and touches no account — it emits would-be long/exit/short-
// observe SIGNALS and forward net-of-fee round-trip evidence only.
//
// The signal (spec §2): trailing-return TSMOM on CLOSED 4H bars, `r_L = close_t /
// close_{t-L} − 1` (reusing `trailingTotalReturn` from @trading-app/engine — the
// momentum math is NOT re-derived here), with WIDE hysteresis bands (±10% default)
// to cut the memo's ~543 turnover/yr, GATED on the TRA-1220 regime label (spec §3):
//   • trend_up → long-eligible (band decides)
//   • trend_down → suppress long / surface short_observe (observe-only, never sized)
//   • chop → suppress long (allowChopLong=false; the churn zone)
//   • null / insufficient → fail-closed flat (invariant #2)
// A held long is force-exited at THIS bar's close the moment its regime leaves
// trend_up (invariant #3 — conservative for 4H gap fat-tails).
//
// R convention (spec §5): validated net of taker fees. Round-trip cost =
// `2×(feeBps+slipBps)`; 1R = one daily vol-target σ = `tsmomSizingStopFraction(v)`
// = `(v/100)/√365`; `netR = (dirGross − rtCostFrac)/1R`. The SAME denominator as
// the TRA-1211 memo so forward net R is directly comparable to its cells.
//
// Stateful by necessity (TSMOM holds a position): the caller threads a per-symbol
// state map through `scanRegimeTsmom` (in → new-state out; the fn stays pure). The
// in-memory store retains the latest per-symbol view + a rolling list of completed
// would-be round trips (for turnover / net-of-taker expectancy) — nothing is
// realized to any book.

import {
  trailingTotalReturn,
  tsmomSizingStopFraction,
  type CryptoRegimeConfig,
  type CryptoRegimeLabel,
  type CryptoRegimeReading,
} from '@trading-app/engine';
import type { Candle } from '@trading-app/shared';
import { scanCryptoRegime } from './crypto-regime-scanner.js';
import type { RegimeTsmomConfig } from './crypto-regime-tsmom-flag.js';

/** The would-be position a symbol holds between passes (never sized to a book). */
export type RegimeTsmomPosition = 'flat' | 'long' | 'short_observe';

/** Per-symbol carried state — threaded in and out of {@link scanRegimeTsmom}. */
export interface RegimeTsmomState {
  position: RegimeTsmomPosition;
  /** Would-be entry price of the held position, or null when flat. */
  entryPrice: number | null;
  /** ISO of the 4H bar the position was opened on, or null when flat. */
  entryBarTime: string | null;
  /** Regime label at entry, or null when flat. */
  entryRegime: CryptoRegimeLabel | null;
}

/** Signal emitted for a symbol this pass. Enumerated exactly per spec §6. */
export type RegimeTsmomAction =
  | 'enter_long'
  | 'hold_long'
  | 'exit_long'
  | 'flat'
  | 'short_observe'
  | null;

/** A completed would-be round trip (never realized to a book) — forward evidence. */
export interface RegimeTsmomRoundTrip {
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  entryBarTime: string | null;
  exitBarTime: string | null;
  entryRegime: CryptoRegimeLabel | null;
  /** Directional gross move %, pre-fee. */
  grossMovePct: number;
  /** Directional move % net of the round-trip taker+slip cost. */
  netMovePct: number;
  /** {@link netMovePct} expressed in §5 1R units (1R = one daily vol-target σ). */
  netR: number;
}

/** One symbol's scan result — carries the signal + the NEW per-symbol state. */
export interface RegimeTsmomResult {
  symbol: string;
  action: RegimeTsmomAction;
  /** Regime label as-of this closed bar (drives the §3 gate), or null. */
  regime: CryptoRegimeLabel | null;
  /** Regime confidence [0,1] as-of this bar, or null. */
  confidence: number | null;
  /** Trailing L-bar total return `r_L`, or null when < L+1 closes. */
  rL: number | null;
  entryBandPct: number;
  exitBandPct: number;
  /** Would-be entry price of the position now held (post-transition), null when flat. */
  wouldBeEntryPrice: number | null;
  /** ISO of the last CLOSED 4H bar this result was computed on, or null. */
  lastBarTime: string | null;
  /** Present only when this pass CLOSED a would-be round trip (exit_long / short close). */
  roundTrip: RegimeTsmomRoundTrip | null;
  /** The NEW per-symbol state after this pass (caller persists it). */
  state: RegimeTsmomState;
}

const FLAT_STATE: RegimeTsmomState = {
  position: 'flat',
  entryPrice: null,
  entryBarTime: null,
  entryRegime: null,
};

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

/**
 * Compute a completed would-be round trip's directional gross/net move and net R
 * (spec §5). `dirGross` is the directional return (long: `exit/entry−1`; short:
 * `entry/exit−1`). Fee drag is the round-trip taker+slip cost; 1R is one daily
 * vol-target σ. Pure.
 */
function buildRoundTrip(
  side: 'long' | 'short',
  entryPrice: number,
  exitPrice: number,
  entryBarTime: string | null,
  exitBarTime: string | null,
  entryRegime: CryptoRegimeLabel | null,
  cfg: RegimeTsmomConfig,
): RegimeTsmomRoundTrip {
  const dirGross = side === 'long' ? exitPrice / entryPrice - 1 : entryPrice / exitPrice - 1;
  const rtCostFrac = (2 * (cfg.feeBps + cfg.slipBps)) / 10_000;
  const netFrac = dirGross - rtCostFrac;
  const oneR = tsmomSizingStopFraction(cfg.volTargetPct); // (v/100)/√365
  const netR = oneR > 0 ? netFrac / oneR : 0;
  return {
    side,
    entryPrice,
    exitPrice,
    entryBarTime,
    exitBarTime,
    entryRegime,
    grossMovePct: round4(dirGross * 100),
    netMovePct: round4(netFrac * 100),
    netR: round4(netR),
  };
}

/**
 * Evaluate ONE symbol's regime-gated TSMOM transition. Pure. Given the closed 4H
 * bars, the regime reading as-of the same bar, and the carried state, returns the
 * signal + the new state (and a round trip when a would-be position closed).
 *
 * A single transition per bar (conservative, invariant #3): a position that exits
 * this bar goes flat and only re-enters on a LATER bar — never exit-and-re-enter
 * in the same pass.
 */
function scanSymbol(
  symbol: string,
  bars: Candle[],
  reading: CryptoRegimeReading | undefined,
  cfg: RegimeTsmomConfig,
  prev: RegimeTsmomState,
): RegimeTsmomResult {
  const lastBar = bars.length > 0 ? bars[bars.length - 1] : undefined;
  const close = lastBar ? lastBar.close : NaN;
  const lastBarTime =
    lastBar && Number.isFinite(lastBar.timestamp)
      ? new Date(lastBar.timestamp).toISOString()
      : null;
  const rL = trailingTotalReturn(
    bars.map((b) => b.close),
    cfg.lookbackBars,
  );
  const regime = reading?.regime ?? null;
  const confidence = reading?.confidence ?? null;

  const base = {
    symbol,
    regime,
    confidence,
    rL,
    entryBandPct: cfg.entryBandPct,
    exitBandPct: cfg.exitBandPct,
    lastBarTime,
  };

  // Fail-closed on an unusable price: we can neither open nor price an exit, so we
  // hold the prior state untouched and emit no signal (invariant #2).
  if (!(close > 0) || !Number.isFinite(close)) {
    return { ...base, action: null, wouldBeEntryPrice: prev.entryPrice, roundTrip: null, state: prev };
  }

  const entryThresh = cfg.entryBandPct / 100;
  const exitThresh = cfg.exitBandPct / 100;
  const confOk = confidence != null && confidence >= cfg.minRegimeConfidence;

  const held = (state: RegimeTsmomState): RegimeTsmomResult => ({
    ...base,
    action: state.position === 'short_observe' ? 'short_observe' : 'hold_long',
    wouldBeEntryPrice: state.entryPrice,
    roundTrip: null,
    state,
  });

  if (prev.position === 'long') {
    // Force exit at THIS bar's close the moment the regime leaves trend_up, or the
    // trailing return crosses the lower band, or r_L is no longer computable.
    const exit = regime !== 'trend_up' || rL == null || rL <= -exitThresh;
    if (exit && prev.entryPrice != null) {
      const roundTrip = buildRoundTrip(
        'long',
        prev.entryPrice,
        close,
        prev.entryBarTime,
        lastBarTime,
        prev.entryRegime,
        cfg,
      );
      return { ...base, action: 'exit_long', wouldBeEntryPrice: null, roundTrip, state: FLAT_STATE };
    }
    return held(prev);
  }

  if (prev.position === 'short_observe') {
    // Mirror-image exit: close the observed short when the regime leaves
    // trend_down or up-momentum crosses the upper band.
    const exit = regime !== 'trend_down' || rL == null || rL >= exitThresh;
    if (exit && prev.entryPrice != null) {
      const roundTrip = buildRoundTrip(
        'short',
        prev.entryPrice,
        close,
        prev.entryBarTime,
        lastBarTime,
        prev.entryRegime,
        cfg,
      );
      return { ...base, action: 'flat', wouldBeEntryPrice: null, roundTrip, state: FLAT_STATE };
    }
    return held(prev);
  }

  // prev.position === 'flat' — evaluate a fresh would-be entry.
  if (rL == null) {
    // Insufficient history to compute r_L → no signal (not a decision, `null`).
    return { ...base, action: null, wouldBeEntryPrice: null, roundTrip: null, state: FLAT_STATE };
  }

  const longEligibleTrend = regime === 'trend_up' && confOk;
  const longEligibleChop = cfg.allowChopLong && regime === 'chop';
  if ((longEligibleTrend || longEligibleChop) && rL >= entryThresh) {
    const state: RegimeTsmomState = {
      position: 'long',
      entryPrice: close,
      entryBarTime: lastBarTime,
      entryRegime: regime,
    };
    return { ...base, action: 'enter_long', wouldBeEntryPrice: close, roundTrip: null, state };
  }

  if (cfg.shortObserve && regime === 'trend_down' && rL <= -entryThresh) {
    const state: RegimeTsmomState = {
      position: 'short_observe',
      entryPrice: close,
      entryBarTime: lastBarTime,
      entryRegime: 'trend_down',
    };
    return { ...base, action: 'short_observe', wouldBeEntryPrice: close, roundTrip: null, state };
  }

  return { ...base, action: 'flat', wouldBeEntryPrice: null, roundTrip: null, state: FLAT_STATE };
}

/**
 * Scan a batch of symbols' CLOSED 4H bars, gating TSMOM on the regime reading
 * as-of the same bar, threading the carried per-symbol state. Pure — no I/O, no
 * orders. Results are ranked signal-first (actionable before flat/null), then by
 * descending |r_L|, then symbol for stability.
 *
 * @param barsBySymbol      symbol → CLOSED 4H candles (oldest-first).
 * @param regimeBySymbol    symbol → regime reading for the SAME closed bar.
 * @param cfg               band/fee/vol config.
 * @param prevStateBySymbol symbol → carried state (missing ⇒ flat). NOT mutated.
 * @param now               injected clock (ms) — reserved for future stamping.
 */
export function scanRegimeTsmom(
  barsBySymbol: ReadonlyMap<string, Candle[]> | Record<string, Candle[]>,
  regimeBySymbol: ReadonlyMap<string, CryptoRegimeReading> | Record<string, CryptoRegimeReading>,
  cfg: RegimeTsmomConfig,
  prevStateBySymbol:
    | ReadonlyMap<string, RegimeTsmomState>
    | Record<string, RegimeTsmomState> = {},
  _now: number = Date.now(),
): RegimeTsmomResult[] {
  const barEntries: Array<[string, Candle[]]> =
    barsBySymbol instanceof Map ? [...barsBySymbol.entries()] : Object.entries(barsBySymbol);
  const regimeGet = (key: string): CryptoRegimeReading | undefined =>
    regimeBySymbol instanceof Map
      ? regimeBySymbol.get(key)
      : (regimeBySymbol as Record<string, CryptoRegimeReading>)[key];
  const stateGet = (key: string): RegimeTsmomState =>
    (prevStateBySymbol instanceof Map
      ? prevStateBySymbol.get(key)
      : (prevStateBySymbol as Record<string, RegimeTsmomState>)[key]) ?? FLAT_STATE;

  const results = barEntries.map(([rawSymbol, bars]) => {
    const key = rawSymbol.trim().toUpperCase();
    const symbol = key !== '' ? key : rawSymbol;
    return scanSymbol(symbol, bars ?? [], regimeGet(symbol) ?? regimeGet(rawSymbol), cfg, stateGet(symbol));
  });
  return sortResults(results);
}

function actionRank(a: RegimeTsmomAction): number {
  switch (a) {
    case 'enter_long':
    case 'short_observe':
      return 0; // new signals first
    case 'exit_long':
      return 1;
    case 'hold_long':
      return 2;
    case 'flat':
      return 3;
    default:
      return 4; // null
  }
}

function sortResults(results: RegimeTsmomResult[]): RegimeTsmomResult[] {
  return [...results].sort((a, b) => {
    const ra = actionRank(a.action);
    const rb = actionRank(b.action);
    if (ra !== rb) return ra - rb;
    const ma = a.rL == null ? -1 : Math.abs(a.rL);
    const mb = b.rL == null ? -1 : Math.abs(b.rL);
    if (mb !== ma) return mb - ma;
    return a.symbol.localeCompare(b.symbol);
  });
}

// ── In-memory store (backs GET /api/health/crypto-regime-tsmom) ──────────────

interface StoredResult {
  result: RegimeTsmomResult;
  recordedAt: number;
}

/** Cap on retained symbols so the store can't grow unbounded over a long run. */
const MAX_STORED_SYMBOLS = 128;
/**
 * Entries older than this are swept on read. 4H bars roll every 4h, so the TTL
 * sits at one bar + a 1h buffer (5h): a fresh view stays until the next bar's scan
 * replaces it, with slack for a missed pass.
 */
const STORE_TTL_MS = 5 * 60 * 60_000;
/** Rolling completed-round-trip retention for expectancy/PF (turnover uses the
 * monotonic total, so a cap here never undercounts turnover). */
const MAX_ROUND_TRIPS = 512;
/**
 * Minimum completed would-be round trips before the rolling net-of-taker
 * expectancy is treated as material. Below this the value is still surfaced with
 * `n` (no silent cap — mirror TRA-1217) but `sufficientSample:false`.
 */
export const MIN_ROUND_TRIPS_FOR_EXPECTANCY = 20;

const store = new Map<string, StoredResult>();
const roundTrips: RegimeTsmomRoundTrip[] = [];
let totalRoundTrips = 0;
let firstRecordedAt: number | null = null;

/**
 * Record a batch of scan results (latest-wins per symbol) plus any completed
 * round trips. Observe-only — callers gate on the flag, so the store stays empty
 * when the scanner is off. Oldest-inserted symbols are evicted past the cap.
 */
export function recordRegimeTsmomScan(
  results: readonly RegimeTsmomResult[],
  now: number = Date.now(),
): void {
  if (results.length > 0 && firstRecordedAt == null) firstRecordedAt = now;
  for (const r of results) {
    const key = r.symbol.trim().toUpperCase();
    if (key === '') continue;
    store.delete(key); // re-insert at the tail so eviction is oldest-first
    store.set(key, { result: { ...r, symbol: key }, recordedAt: now });
    if (r.roundTrip) {
      totalRoundTrips += 1;
      roundTrips.push(r.roundTrip);
      while (roundTrips.length > MAX_ROUND_TRIPS) roundTrips.shift();
    }
  }
  while (store.size > MAX_STORED_SYMBOLS) {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** Test seam — drop every recorded view, round trip, and the elapsed-time anchor. */
export function clearRegimeTsmomScans(): void {
  store.clear();
  roundTrips.length = 0;
  totalRoundTrips = 0;
  firstRecordedAt = null;
}

/** One symbol's most-recent scan view, plus when it was recorded. */
export interface RegimeTsmomScanView extends RegimeTsmomResult {
  recordedAt: string;
}

export interface RegimeTsmomScansSummary {
  /** Symbols with a fresh (within-TTL) recorded view. */
  symbolCount: number;
  /** Fresh views currently in a would-be long. */
  longCount: number;
  /** Fresh views currently in a would-be short_observe. */
  shortObserveCount: number;
  /** Fresh views whose regime is `chop`. */
  choppedCount: number;
  scans: RegimeTsmomScanView[];
  /** Completed would-be round trips × 365 / elapsed days, or null before any accrue. */
  rollingTurnoverPerYr: number | null;
  /** Mean net-of-taker R over retained round trips, or null when n = 0. */
  rollingNetExpectancyR: number | null;
  /** Profit factor (Σ wins / Σ|losses|) over retained round trips, or null when n = 0. */
  rollingProfitFactor: number | null;
  /** Completed round trips in the rolling window (surfaced always — no silent cap). */
  n: number;
  /** True once `n ≥ MIN_ROUND_TRIPS_FOR_EXPECTANCY` — do not overclaim below it. */
  sufficientSample: boolean;
}

/**
 * Fold the store into the read-only diagnostics summary, dropping entries past the
 * TTL and ranking signal-first. Also folds the rolling round-trip list into
 * turnover/yr + net-of-taker expectancy R + PF (spec §6). Pure beyond the injected
 * clock. No PnL is realized — these are would-be forward numbers only.
 */
export function summarizeRegimeTsmomScans(now: number = Date.now()): RegimeTsmomScansSummary {
  const views: RegimeTsmomScanView[] = [];
  for (const [key, entry] of store) {
    if (now - entry.recordedAt >= STORE_TTL_MS) {
      store.delete(key);
      continue;
    }
    views.push({ ...entry.result, recordedAt: new Date(entry.recordedAt).toISOString() });
  }
  views.sort((a, b) => {
    const ra = actionRank(a.action);
    const rb = actionRank(b.action);
    if (ra !== rb) return ra - rb;
    const ma = a.rL == null ? -1 : Math.abs(a.rL);
    const mb = b.rL == null ? -1 : Math.abs(b.rL);
    if (mb !== ma) return mb - ma;
    return a.symbol.localeCompare(b.symbol);
  });

  const n = roundTrips.length;
  let expectancyR: number | null = null;
  let profitFactor: number | null = null;
  if (n > 0) {
    const sumR = roundTrips.reduce((acc, rt) => acc + rt.netR, 0);
    expectancyR = round4(sumR / n);
    const wins = roundTrips.filter((rt) => rt.netR > 0).reduce((acc, rt) => acc + rt.netR, 0);
    const losses = roundTrips
      .filter((rt) => rt.netR < 0)
      .reduce((acc, rt) => acc + Math.abs(rt.netR), 0);
    profitFactor = losses > 0 ? round4(wins / losses) : wins > 0 ? Infinity : 0;
  }

  let turnover: number | null = null;
  if (totalRoundTrips > 0 && firstRecordedAt != null) {
    const elapsedMs = Math.max(now - firstRecordedAt, 1);
    const elapsedDays = Math.max(elapsedMs / 86_400_000, 1 / 24); // floor ≥ 1h
    turnover = round4((totalRoundTrips * 365) / elapsedDays);
  }

  return {
    symbolCount: views.length,
    longCount: views.filter((v) => v.state.position === 'long').length,
    shortObserveCount: views.filter((v) => v.state.position === 'short_observe').length,
    choppedCount: views.filter((v) => v.regime === 'chop').length,
    scans: views,
    rollingTurnoverPerYr: turnover,
    rollingNetExpectancyR: expectancyR,
    rollingProfitFactor: profitFactor,
    n,
    sufficientSample: n >= MIN_ROUND_TRIPS_FOR_EXPECTANCY,
  };
}

// ── Observe routine (dependency-injected so zero-IO-when-off is testable) ────

/** 4H-bar fetcher: symbol → CLOSED-or-forming candles (oldest-first). */
export type Fetch4hBars = (symbol: string) => Promise<Candle[]>;

export interface ObserveRegimeTsmomDeps {
  /** ENABLE_CRYPTO_REGIME_TSMOM state — checked FIRST (invariant #1). */
  enabled: boolean;
  watchlist: string[];
  /** Regime classifier config (fed to the SAME closed series that computes r_L). */
  regimeCfg: CryptoRegimeConfig;
  /** TSMOM band/fee/vol config. */
  cfg: RegimeTsmomConfig;
  fetch4h: Fetch4hBars;
  /**
   * Per-symbol dedupe: ISO of the last CLOSED bar already scanned. Re-scan a
   * symbol at most once per newly-closed 4H bar (spec §6). Mutated in place.
   */
  lastBarBySymbol: Map<string, string>;
  /** Carried per-symbol TSMOM state (position/entry). Mutated in place. */
  stateBySymbol: Map<string, RegimeTsmomState>;
  now?: number;
  onError?: (symbol: string, err: unknown) => void;
}

export interface ObserveRegimeTsmomResult {
  fetched: number;
  scanned: number;
  results: RegimeTsmomResult[];
}

const FOUR_H_MS = 4 * 60 * 60 * 1000;

/**
 * Run one observe-only regime-gated TSMOM pass. GUARDS on `enabled` BEFORE
 * touching `fetch4h` so a flag-OFF pass is provably zero cost/IO (invariant #1 —
 * the spy test asserts `fetch4h` is never called). When ON: fetches per watchlist
 * symbol, drops the in-progress forming bar (invariant #3 — no lookahead), dedupes
 * on the newest closed bar, classifies the regime AND computes `r_L` off the SAME
 * closed series (no time-skew, no double fetch), runs the pure gated scan, records
 * the results, and threads the new per-symbol state back into `stateBySymbol`.
 * Read-only — NO order/entry/sizing path.
 */
export async function observeRegimeTsmom(
  deps: ObserveRegimeTsmomDeps,
): Promise<ObserveRegimeTsmomResult> {
  const empty: ObserveRegimeTsmomResult = { fetched: 0, scanned: 0, results: [] };
  if (!deps.enabled) return empty; // flag OFF ⇒ zero cost/IO (no fetch)
  if (deps.watchlist.length === 0) return empty;
  const now = deps.now ?? Date.now();

  const barsBySymbol = new Map<string, Candle[]>();
  let fetched = 0;
  for (const rawSymbol of deps.watchlist) {
    const symbol = rawSymbol.trim().toUpperCase();
    let bars: Candle[];
    try {
      bars = await deps.fetch4h(symbol);
      fetched++;
    } catch (err) {
      deps.onError?.(symbol, err);
      continue;
    }
    // Invariant #3 — only CLOSED bars: drop any trailing forming bar whose 4H
    // bucket has not yet elapsed.
    const closed = bars.filter(
      (b) => Number.isFinite(b.timestamp) && b.timestamp + FOUR_H_MS <= now,
    );
    if (closed.length === 0) continue;
    const lastBarIso = new Date(closed[closed.length - 1].timestamp).toISOString();
    if (deps.lastBarBySymbol.get(symbol) === lastBarIso) continue; // bar hasn't advanced
    deps.lastBarBySymbol.set(symbol, lastBarIso);
    barsBySymbol.set(symbol, closed);
  }

  if (barsBySymbol.size === 0) return { fetched, scanned: 0, results: [] };

  // Classify the regime off the SAME closed series (reuse the TRA-1220 pure scan —
  // do NOT re-derive the detector), then index by symbol for the gate.
  const readings = scanCryptoRegime(barsBySymbol, deps.regimeCfg, now);
  const regimeBySymbol = new Map<string, CryptoRegimeReading>();
  for (const r of readings) regimeBySymbol.set(r.symbol.trim().toUpperCase(), r);

  const results = scanRegimeTsmom(barsBySymbol, regimeBySymbol, deps.cfg, deps.stateBySymbol, now);
  recordRegimeTsmomScan(results, now);
  // Thread the new state forward for the next pass.
  for (const r of results) deps.stateBySymbol.set(r.symbol.trim().toUpperCase(), r.state);
  return { fetched, scanned: results.length, results };
}

// ── EOD forward-evidence section ─────────────────────────────────────────────

/**
 * Pure "Crypto Regime-Gated TSMOM" EOD markdown section (spec §6): open would-be
 * signals + rolling turnover/net-of-taker expectancy, so we accrue the forward
 * evidence the later live-sizing decision needs. Observe-only — no PnL realized.
 * Renders a disabled/empty fallback when the scanner is off or no fresh views
 * exist. `n` is always surfaced (no silent sample cap) and the expectancy line is
 * flagged provisional below {@link MIN_ROUND_TRIPS_FOR_EXPECTANCY}.
 */
export function buildRegimeTsmomEodSection(
  enabled: boolean,
  summary: RegimeTsmomScansSummary,
): string {
  const header = '## Crypto Regime-Gated TSMOM (observe-only)';
  if (!enabled || summary.scans.length === 0) {
    const why = !enabled ? 'scanner disabled' : 'no fresh signals';
    return `${header}\n\n_${why}._`;
  }
  const num = (n: number | null, dp: number) => (n == null ? '—' : n.toFixed(dp));
  const pf = (n: number | null) =>
    n == null ? '—' : n === Infinity ? '∞' : n.toFixed(2);
  const rows = summary.scans
    .map((s) => {
      return `| ${s.symbol} | ${s.action ?? '—'} | ${s.regime ?? 'insufficient'} | ${num(
        s.confidence,
        3,
      )} | ${s.rL == null ? '—' : (s.rL * 100).toFixed(2) + '%'} | ${
        s.wouldBeEntryPrice == null ? '—' : s.wouldBeEntryPrice.toFixed(2)
      } | ${s.lastBarTime ?? '—'} |`;
    })
    .join('\n');
  const expLine = summary.sufficientSample
    ? `net-of-taker expectancy **${num(summary.rollingNetExpectancyR, 3)}R** · PF ${pf(
        summary.rollingProfitFactor,
      )} (n=${summary.n})`
    : `net-of-taker expectancy ${num(summary.rollingNetExpectancyR, 3)}R · PF ${pf(
        summary.rollingProfitFactor,
      )} — **provisional, n=${summary.n} < ${MIN_ROUND_TRIPS_FOR_EXPECTANCY}**`;
  return `${header}

Symbols ${summary.symbolCount} · long ${summary.longCount} · short_observe ${summary.shortObserveCount} · chop ${summary.choppedCount}
Would-be turnover/yr ${num(summary.rollingTurnoverPerYr, 1)} · ${expLine}

| Symbol | Action | Regime@bar | Conf | rL | Would-be entry | Last 4H bar |
|--------|--------|-----------|------|----|----------------|-------------|
${rows}`;
}
