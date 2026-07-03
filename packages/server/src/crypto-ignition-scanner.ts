// TRA-1271 (parent TRA-1266 → TRA-1210) — observe-only crypto ignition scanner.
//
// Sibling to `crypto-regime-tsmom-scanner.ts` (TRA-1221) and
// `perp-funding-carry-scanner.ts` (TRA-1216): a PURE `scanIgnition(bars, cfg,
// regime)` signal core ported from `run-tra1217-ignition.ts`, a PURE forward
// resolver `resolveIgnition(bars, signalIdx, cfg)` that walks a fire forward to
// TP/stop/timeout (pessimistic, stop-first), an in-memory store backing the
// read-only `GET /api/health/crypto-ignition` surface, and a JSONL forward log +
// snapshot under DATA_DIR so the OOS/forward sample survives restarts.
//
// ── HARD INVARIANT (do NOT violate) ──────────────────────────────────────────
// Observe-only, ZERO capital, NO order submission, NO sizing, NO account touch
// anywhere in this module. Every "record"/"entry"/"exit" here is a would-be
// forward-tracking bookkeeping event, NEVER an order. Graduation to live sizing
// requires forward evidence that the TAKER-cost expectancy CI is clearly > 0
// (currently straddles 0, P≈0.81, TRA-1217 §4) — a separate board-visible
// decision, NOT this task.
//
// TODO(graduation): the first feature to add IF this graduates to live sizing is a
// perp OI + funding-surge signal (needs a perp feed). Do NOT build it here.
//
// The confirmed edge (+0.328R all-regime) lives entirely in the maker-fill
// assumption; the taker case only straddles 0. The single most important
// instrument this harness carries is therefore the **would-a-limit-fill** flag:
// for each fire we log whether a limit buy at the intended maker price (the signal
// bar close) would actually have filled before the trade resolved.

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { CryptoRegimeConfig, CryptoRegimeLabel, CryptoRegimeReading } from '@trading-app/engine';
import type { Candle } from '@trading-app/shared';
import { scanCryptoRegime } from './crypto-regime-scanner.js';
import { IGNITION_SECONDARY_ARM, type IgnitionConfig } from './crypto-ignition-flag.js';
import { logger } from './observability/index.js';

const persistLog = logger.child({ module: 'crypto-ignition-persistence' });

// ── Pure signal core (ported from run-tra1217-ignition.ts detectSignals) ─────

/** EMA over `values`; NaN for the warm-up region (< len-1). Pure. */
function ema(values: number[], len: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  const k = 2 / (len + 1);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    prev = Number.isNaN(prev) ? v : v * k + prev * (1 - k);
    if (i >= len - 1) out[i] = prev;
  }
  return out;
}

/** The outcome of evaluating the ignition trigger on the LAST bar of a series. */
export interface IgnitionSignal {
  symbol: string;
  /** True iff all five conditions (Donchian / squeeze / RVOL / trend / regime) AND. */
  fired: boolean;
  /** ISO of the signal bar (the last CLOSED bar decided on), or null when unusable. */
  signalBarTime: string | null;
  /** Signal bar close = the intended MAKER limit price (the fill instrument). */
  signalClose: number | null;
  /** RVOL = bar volume / SMA(vol, volLen) as-of the signal bar, or null. */
  rvol: number | null;
  /** Donchian channel width / price over the squeeze window, or null. */
  squeezeWidthPct: number | null;
  /** EMA(trendLen) as-of the signal bar, or null. */
  ema: number | null;
  /** Regime label as-of the signal bar (drives condition 5), or null. */
  regime: CryptoRegimeLabel | null;
  /** First failed condition when `fired:false` (diagnostics only). */
  failReason: string | null;
}

/**
 * Evaluate the ignition trigger on the CLOSE of the LAST bar of `bars`. Pure — no
 * I/O, no orders. All FIVE conditions are AND-ed (spec §2):
 *   1. Donchian breakout — close > highest-high of the prior `donchLen` bars.
 *   2. Squeeze — Donchian width over the `squeezeLen` pre-breakout window < `squeezePct` × price.
 *   3. RVOL ignition — bar volume / SMA(vol, `volLen`) ≥ `rvolMin`.
 *   4. Trend — close > EMA(`trendLen`).
 *   5. Regime — bull (`trend_up`) only when `cfg.bullOnly`; otherwise any non-null label.
 *
 * FAIL-CLOSED (no fire) on insufficient history, a synthetic/gap-filled last bar,
 * any NaN/non-finite input, or a missing/unavailable regime (spec §1/§2).
 */
export function scanIgnition(
  bars: Candle[],
  cfg: IgnitionConfig,
  regime: CryptoRegimeLabel | null,
): IgnitionSignal {
  const symbol = bars.length > 0 ? bars[bars.length - 1].symbol : '';
  const base: IgnitionSignal = {
    symbol,
    fired: false,
    signalBarTime: null,
    signalClose: null,
    rvol: null,
    squeezeWidthPct: null,
    ema: null,
    regime,
    failReason: null,
  };

  const i = bars.length - 1;
  const need = Math.max(cfg.donchLen, cfg.squeezeLen, cfg.volLen, cfg.trendLen) + 1;
  if (i < need) return { ...base, failReason: 'insufficient_history' };

  const cur = bars[i];
  if (!cur || cur.synthetic) return { ...base, failReason: 'synthetic_bar' };
  const close = cur.close;
  if (!(Number.isFinite(close) && close > 0)) return { ...base, failReason: 'bad_close' };

  const signalBarTime = Number.isFinite(cur.timestamp) ? new Date(cur.timestamp).toISOString() : null;

  // 1. Donchian breakout — close above the prior donchLen-bar high (exclusive of i).
  let priorHigh = -Infinity;
  for (let j = i - cfg.donchLen; j < i; j++) priorHigh = Math.max(priorHigh, bars[j].high);
  if (!Number.isFinite(priorHigh)) return { ...base, signalBarTime, signalClose: close, failReason: 'bad_donchian' };
  const donchOk = close > priorHigh;

  // 2. Squeeze — pre-breakout channel width small relative to price.
  let hi = -Infinity;
  let lo = Infinity;
  for (let j = i - cfg.squeezeLen; j < i; j++) {
    hi = Math.max(hi, bars[j].high);
    lo = Math.min(lo, bars[j].low);
  }
  const squeezeWidthPct = Number.isFinite(hi) && Number.isFinite(lo) ? (hi - lo) / close : NaN;
  const squeezeOk = Number.isFinite(squeezeWidthPct) && squeezeWidthPct < cfg.squeezePct;

  // 3. RVOL ignition — bar volume vs the baseline SMA (exclude the current bar).
  let volSum = 0;
  for (let j = i - cfg.volLen; j < i; j++) volSum += bars[j].volume;
  const baseVol = volSum / cfg.volLen;
  const rvol = baseVol > 0 ? cur.volume / baseVol : NaN;
  const rvolOk = Number.isFinite(rvol) && rvol >= cfg.rvolMin;

  // 4. Trend filter.
  const emaTrend = ema(bars.map((b) => b.close), cfg.trendLen)[i];
  const trendOk = Number.isFinite(emaTrend) && close > emaTrend;

  // 5. Regime — fail-closed on a missing label; bull-only when configured.
  const regimeOk = cfg.bullOnly ? regime === 'trend_up' : regime != null;

  const enriched: IgnitionSignal = {
    ...base,
    signalBarTime,
    signalClose: close,
    rvol: Number.isFinite(rvol) ? round6(rvol) : null,
    squeezeWidthPct: Number.isFinite(squeezeWidthPct) ? round6(squeezeWidthPct) : null,
    ema: Number.isFinite(emaTrend) ? round6(emaTrend) : null,
  };

  if (!donchOk) return { ...enriched, failReason: 'no_donchian_breakout' };
  if (!squeezeOk) return { ...enriched, failReason: 'no_squeeze' };
  if (!rvolOk) return { ...enriched, failReason: 'low_rvol' };
  if (!trendOk) return { ...enriched, failReason: 'below_trend' };
  if (!regimeOk) return { ...enriched, failReason: regime == null ? 'no_regime' : 'not_bull' };

  return { ...enriched, fired: true };
}

// ── Pure forward resolver (ported from run-tra1217-ignition.ts simulateTrade) ─

export type IgnitionArmName = 'tp10sl4' | 'tp15sl5';
export type IgnitionOutcome = 'tp' | 'stop' | 'timeout';

/** One TP/SL arm's forward resolution — net-R for BOTH fee assumptions + fill flag. */
export interface IgnitionArmResult {
  arm: IgnitionArmName;
  tpPct: number;
  stopPct: number;
  outcome: IgnitionOutcome;
  /** Gross move in R units (R = stop distance). Clean tp10/sl4 ≈ +2.5R; full stop = −1R. */
  grossR: number;
  /** Net-of-fee R at the MAKER assumption (20bps/side, 0 slip). */
  netRMaker: number;
  /** Net-of-fee R at the TAKER assumption (60bps/side + slip). */
  netRTaker: number;
  /** ★ Would a limit buy at the intended maker price have filled before this arm resolved? */
  makerFilled: boolean;
  exitBarTime: string | null;
  holdBars: number;
}

/** A fully-resolved forward record — never realized to any book. */
export interface IgnitionResolution {
  symbol: string;
  signalBarTime: string | null;
  entryBarTime: string | null;
  /** Next-bar OPEN reference (no lookahead), matching the TRA-1217 backtest convention. */
  entryPrice: number;
  /** Intended maker limit = the signal bar close (the fill instrument's price). */
  makerLimitPrice: number;
  regimeAtSignal: CryptoRegimeLabel | null;
  byArm: { tp10sl4: IgnitionArmResult; tp15sl5: IgnitionArmResult };
}

function round6(x: number): number {
  return Math.round(x * 1_000_000) / 1_000_000;
}
function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

/**
 * Walk ONE arm forward from `entryIdx` (the bar whose OPEN is the entry) to TP,
 * stop, or `maxHoldBars`. PESSIMISTIC (stop-first) when a single bar spans both.
 * Returns null when the arm is NOT YET resolvable (not enough forward bars AND the
 * max-hold bar has not closed). Pure.
 *
 * `makerFilled` is the would-a-limit-fill instrument: whether any bar in the
 * [entry, exit] span traded down to/through the maker limit (`low ≤ makerLimit`),
 * i.e. a resting limit buy at that price would have been hit before resolution.
 */
function resolveArm(
  bars: Candle[],
  entryIdx: number,
  arm: IgnitionArmName,
  tpPct: number,
  stopPct: number,
  makerLimit: number,
  cfg: IgnitionConfig,
): IgnitionArmResult | null {
  if (entryIdx <= 0 || entryIdx >= bars.length) return null;
  const entry = bars[entryIdx].open;
  if (!(Number.isFinite(entry) && entry > 0)) return null;
  const tp = entry * (1 + tpPct);
  const sl = entry * (1 - stopPct);
  const lastIdx = bars.length - 1;
  const maxHoldIdx = entryIdx + cfg.maxHoldBars;

  let exitIdx = -1;
  let exitPrice = NaN;
  let outcome: IgnitionOutcome = 'timeout';
  const walkTo = Math.min(maxHoldIdx, lastIdx);
  for (let k = entryIdx; k <= walkTo; k++) {
    const bar = bars[k];
    if (k === entryIdx) {
      // Entry-bar gap: if the open already cleared a level, fill at open.
      if (bar.open >= tp) { exitIdx = k; exitPrice = tp; outcome = 'tp'; break; }
      if (bar.open <= sl) { exitIdx = k; exitPrice = sl; outcome = 'stop'; break; }
    }
    const hitTp = bar.high >= tp;
    const hitSl = bar.low <= sl;
    if (hitTp && hitSl) {
      // Single bar spans both — PESSIMISTIC: the stop fills first.
      exitIdx = k; exitPrice = sl; outcome = 'stop'; break;
    }
    if (hitTp) { exitIdx = k; exitPrice = tp; outcome = 'tp'; break; }
    if (hitSl) { exitIdx = k; exitPrice = sl; outcome = 'stop'; break; }
  }

  if (exitIdx < 0) {
    // No TP/stop hit yet. Only resolve as a TIMEOUT once the max-hold bar has
    // actually closed; otherwise the arm is still open — wait for more bars.
    if (maxHoldIdx > lastIdx) return null;
    exitIdx = maxHoldIdx;
    exitPrice = bars[exitIdx].close;
    outcome = 'timeout';
  }

  const grossRet = exitPrice / entry - 1;
  const grossR = grossRet / stopPct;
  const makerCost = (2 * cfg.makerFeeBps) / 10_000; // maker: fee only, no slip
  const takerCost = (2 * (cfg.takerFeeBps + cfg.slipBps)) / 10_000; // taker: fee + slip
  const netRMaker = (grossRet - makerCost) / stopPct;
  const netRTaker = (grossRet - takerCost) / stopPct;

  let makerFilled = false;
  for (let k = entryIdx; k <= exitIdx; k++) {
    if (bars[k].low <= makerLimit) { makerFilled = true; break; }
  }

  return {
    arm,
    tpPct,
    stopPct,
    outcome,
    grossR: round4(grossR),
    netRMaker: round4(netRMaker),
    netRTaker: round4(netRTaker),
    makerFilled,
    exitBarTime: Number.isFinite(bars[exitIdx].timestamp)
      ? new Date(bars[exitIdx].timestamp).toISOString()
      : null,
    holdBars: exitIdx - entryIdx,
  };
}

/**
 * Resolve a fire (its signal bar at `signalIdx`) forward across BOTH TP/SL arms.
 * Entry is the NEXT bar's OPEN (`signalIdx + 1`, no lookahead). Returns null when
 * the entry bar has not yet closed OR either arm is not yet resolvable — the caller
 * keeps the record open and retries on a later pass. Pure — no I/O, no orders.
 */
export function resolveIgnition(
  bars: Candle[],
  signalIdx: number,
  cfg: IgnitionConfig,
  regimeAtSignal: CryptoRegimeLabel | null = null,
): IgnitionResolution | null {
  const entryIdx = signalIdx + 1;
  if (signalIdx < 0 || entryIdx >= bars.length) return null; // entry bar not yet available
  const makerLimit = bars[signalIdx].close;
  if (!(Number.isFinite(makerLimit) && makerLimit > 0)) return null;
  const entry = bars[entryIdx].open;
  if (!(Number.isFinite(entry) && entry > 0)) return null;

  const primary = resolveArm(bars, entryIdx, 'tp10sl4', cfg.tpPct, cfg.stopPct, makerLimit, cfg);
  const secondary = resolveArm(
    bars, entryIdx, 'tp15sl5', IGNITION_SECONDARY_ARM.tpPct, IGNITION_SECONDARY_ARM.stopPct, makerLimit, cfg,
  );
  if (!primary || !secondary) return null; // wait for the slower arm to determine

  return {
    symbol: bars[entryIdx].symbol,
    signalBarTime: Number.isFinite(bars[signalIdx].timestamp)
      ? new Date(bars[signalIdx].timestamp).toISOString()
      : null,
    entryBarTime: Number.isFinite(bars[entryIdx].timestamp)
      ? new Date(bars[entryIdx].timestamp).toISOString()
      : null,
    entryPrice: round6(entry),
    makerLimitPrice: round6(makerLimit),
    regimeAtSignal,
    byArm: { tp10sl4: primary, tp15sl5: secondary },
  };
}

// ── In-memory store (backs GET /api/health/crypto-ignition) ──────────────────
//
// The open records ARE the carried state (a fire waits for its entry bar, then
// walks forward across passes). The resolved records feed the rolling rollups.
// Everything here is module-global and observe-only — callers gate on the flag,
// so the store stays empty when the scanner is off.

/** A fire awaiting its entry bar / forward resolution — never an order. */
export interface IgnitionOpenRecord {
  symbol: string;
  /** ISO of the signal bar — locates the fire in the current series each pass. */
  signalBarTime: string;
  /** Signal bar close = the intended maker limit price. */
  signalClose: number;
  regimeAtSignal: CryptoRegimeLabel | null;
  /** Wall-clock ms the fire was recorded (turnover anchor + open-age bookkeeping). */
  openedAt: number;
}

/** Rolling resolved-record retention for the rollups (turnover uses the monotonic total). */
const MAX_RESOLVED_RECORDS = 512;
/**
 * Minimum resolved forward records before the rolling expectancy is treated as
 * material. Below this the value is still surfaced with `n` (no silent cap — mirror
 * TRA-1217) but `sufficientSample:false`.
 */
export const MIN_RESOLVED_FOR_EXPECTANCY = 20;

const openRecordBySymbol = new Map<string, IgnitionOpenRecord>();
/** Per-symbol dedupe: ISO of the last CLOSED bar already scanned (advance-only). */
const lastBarBySymbol = new Map<string, string>();
/** Per-symbol ISO of the last signal bar we already opened a record on (no re-fire). */
const lastFireBarBySymbol = new Map<string, string>();
/** Per-symbol ISO of the last resolved exit bar — non-overlapping guard (no re-entry ≤ exit). */
const freeAfterBarBySymbol = new Map<string, string>();
const resolvedRecords: IgnitionResolution[] = [];
let totalOpens = 0;
let totalResolved = 0;
let firstRecordedAt: number | null = null;

/** Test seam — drop every open/resolved record, dedupe map, and the elapsed anchor. */
export function clearIgnitionScans(): void {
  openRecordBySymbol.clear();
  lastBarBySymbol.clear();
  lastFireBarBySymbol.clear();
  freeAfterBarBySymbol.clear();
  resolvedRecords.length = 0;
  totalOpens = 0;
  totalResolved = 0;
  firstRecordedAt = null;
}

function recordResolved(res: IgnitionResolution): void {
  totalResolved += 1;
  resolvedRecords.push(res);
  while (resolvedRecords.length > MAX_RESOLVED_RECORDS) resolvedRecords.shift();
}

// ── Health / EOD summary ─────────────────────────────────────────────────────

/** Per-arm rollup across resolved records (spec §4). */
export interface IgnitionArmRollup {
  resolved: number;
  hitPct: number | null;
  stopPct: number | null;
  timeoutPct: number | null;
  expRMaker: number | null;
  expRTaker: number | null;
  makerFillPct: number | null;
}

export interface IgnitionScansSummary {
  watchlistSize: number;
  openRecords: number;
  resolvedRecords: number;
  byArm: { tp10sl4: IgnitionArmRollup; tp15sl5: IgnitionArmRollup };
  /** Headline expectancy R (PRIMARY tp10sl4 arm) for the maker vs taker assumption. */
  expR: { maker: number | null; taker: number | null };
  /** Headline hit% (PRIMARY arm). */
  hitPct: number | null;
  /** ★ Headline would-a-limit-fill rate (PRIMARY arm) — the confirm-or-kill instrument. */
  makerFillRate: number | null;
  /** Resolved records × 365 / elapsed days, or null before any accrue. */
  firesPerYr: number | null;
  /** Resolved-record count (surfaced always — no silent cap). */
  n: number;
  /** True once `n ≥ MIN_RESOLVED_FOR_EXPECTANCY` — do not overclaim below it. */
  sufficientSample: boolean;
}

function rollupArm(records: IgnitionResolution[], arm: IgnitionArmName): IgnitionArmRollup {
  const arms = records.map((r) => r.byArm[arm]);
  const n = arms.length;
  if (n === 0) {
    return {
      resolved: 0, hitPct: null, stopPct: null, timeoutPct: null,
      expRMaker: null, expRTaker: null, makerFillPct: null,
    };
  }
  const tp = arms.filter((a) => a.outcome === 'tp').length;
  const st = arms.filter((a) => a.outcome === 'stop').length;
  const to = arms.filter((a) => a.outcome === 'timeout').length;
  const filled = arms.filter((a) => a.makerFilled).length;
  const sumMaker = arms.reduce((acc, a) => acc + a.netRMaker, 0);
  const sumTaker = arms.reduce((acc, a) => acc + a.netRTaker, 0);
  return {
    resolved: n,
    hitPct: round4((100 * tp) / n),
    stopPct: round4((100 * st) / n),
    timeoutPct: round4((100 * to) / n),
    expRMaker: round4(sumMaker / n),
    expRTaker: round4(sumTaker / n),
    makerFillPct: round4((100 * filled) / n),
  };
}

/**
 * Fold the store into the read-only diagnostics summary (spec §4). Pure beyond the
 * injected clock. No PnL is realized — these are would-be forward numbers only. `n`
 * is always surfaced (no silent sample cap) and expectancy is flagged provisional
 * below {@link MIN_RESOLVED_FOR_EXPECTANCY}.
 */
export function summarizeIgnitionScans(
  now: number = Date.now(),
  watchlistSize = 0,
): IgnitionScansSummary {
  const tp10sl4 = rollupArm(resolvedRecords, 'tp10sl4');
  const tp15sl5 = rollupArm(resolvedRecords, 'tp15sl5');
  const n = resolvedRecords.length;

  let firesPerYr: number | null = null;
  if (totalResolved > 0 && firstRecordedAt != null) {
    const elapsedMs = Math.max(now - firstRecordedAt, 1);
    const elapsedDays = Math.max(elapsedMs / 86_400_000, 1 / 24); // floor ≥ 1h
    firesPerYr = round4((totalResolved * 365) / elapsedDays);
  }

  return {
    watchlistSize,
    openRecords: openRecordBySymbol.size,
    resolvedRecords: n,
    byArm: { tp10sl4, tp15sl5 },
    expR: { maker: tp10sl4.expRMaker, taker: tp10sl4.expRTaker },
    hitPct: tp10sl4.hitPct,
    makerFillRate: tp10sl4.makerFillPct,
    firesPerYr,
    n,
    sufficientSample: n >= MIN_RESOLVED_FOR_EXPECTANCY,
  };
}

// ── Disk persistence (mirror TRA-1264 / perp-funding-history) ────────────────
//
// The in-memory store is wiped by any restart/redeploy, resetting the resolved
// count `n` to 0 — but the taker-CI-off-zero decision needs a multi-week forward
// sample (strict RVOL≥6 ⇒ ~48 fires/yr, TRA-1217). So we persist, mirroring the
// TRA-1216 funding-history JSONL + TRA-1264 snapshot pattern:
//   • one JSONL line per fire (open) and per resolution (close) — the accrual
//     evidence itself, which must NOT live only in memory;
//   • a small JSON snapshot (open records + dedupe maps + the turnover anchor/total)
//     so an in-flight fire and the turnover denominator both survive a restart.
// Both are hydrated on boot. Observe-only throughout — read/write of forward
// evidence only, NO order/entry/sizing path is touched.

export const IGNITION_LOG_FILENAME = 'crypto-ignition-forward.jsonl';
export const IGNITION_STATE_FILENAME = 'crypto-ignition-state.json';
/** Roll the forward JSONL to a single `.1` backup past ~8 MB (as funding-history). */
export const IGNITION_LOG_MAX_BYTES = 8 * 1024 * 1024;

export function ignitionLogPath(dataDir: string): string {
  return join(dataDir, IGNITION_LOG_FILENAME);
}
export function ignitionStatePath(dataDir: string): string {
  return join(dataDir, IGNITION_STATE_FILENAME);
}

type IgnitionLogRow =
  | ({ type: 'open'; recordedAt: number } & IgnitionOpenRecord)
  | ({ type: 'close'; recordedAt: number } & IgnitionResolution);

export interface IgnitionStateSnapshot {
  version: 1;
  firstRecordedAt: number | null;
  totalOpens: number;
  totalResolved: number;
  openRecordBySymbol: Record<string, IgnitionOpenRecord>;
  lastBarBySymbol: Record<string, string>;
  lastFireBarBySymbol: Record<string, string>;
  freeAfterBarBySymbol: Record<string, string>;
  updatedAt: number;
}

function mapToRecord<V>(m: Map<string, V>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [k, v] of m) out[k] = v;
  return out;
}

function appendLogRows(dataDir: string, rows: IgnitionLogRow[], maxBytes: number): void {
  if (rows.length === 0) return;
  const path = ignitionLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      size = 0; // absent ⇒ fresh
    }
    if (size >= maxBytes) {
      try {
        renameSync(path, `${path}.1`);
      } catch (err) {
        persistLog.warn('ignition forward-log rotate failed', {
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    appendFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  } catch (err) {
    persistLog.warn('ignition forward-log append failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

function writeSnapshot(dataDir: string, now: number): void {
  const snapshot: IgnitionStateSnapshot = {
    version: 1,
    firstRecordedAt,
    totalOpens,
    totalResolved,
    openRecordBySymbol: mapToRecord(openRecordBySymbol),
    lastBarBySymbol: mapToRecord(lastBarBySymbol),
    lastFireBarBySymbol: mapToRecord(lastFireBarBySymbol),
    freeAfterBarBySymbol: mapToRecord(freeAfterBarBySymbol),
    updatedAt: now,
  };
  try {
    writeFileSync(ignitionStatePath(dataDir), JSON.stringify(snapshot), 'utf8');
  } catch (err) {
    persistLog.warn('ignition state snapshot write failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/** What {@link hydrateIgnitionFromDisk} recovered (for the boot log line). */
export interface IgnitionHydration {
  resolvedLoaded: number;
  totalResolved: number;
  totalOpens: number;
  firstRecordedAt: number | null;
  openRecords: number;
}

/**
 * Rebuild the in-memory accrual from disk on boot. Idempotent: CLEARS the store
 * first, so it is safe to call exactly once at startup before any live pass. The
 * JSONL close-lines are the accrual evidence (seeded into the capped rolling list,
 * preserving `n`); the snapshot supplies the monotonic totals + turnover anchor
 * (authoritative after a JSONL roll) plus the open records + dedupe maps.
 * Best-effort — a missing/corrupt file yields an empty hydration rather than throwing.
 */
export function hydrateIgnitionFromDisk(dataDir: string): IgnitionHydration {
  clearIgnitionScans();

  // Seed resolved records from the JSONL close-lines (most-recent, post-cap).
  let raw = '';
  try {
    raw = readFileSync(ignitionLogPath(dataDir), 'utf8');
  } catch {
    raw = '';
  }
  const closes: IgnitionResolution[] = [];
  let jsonlOpens = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const row = JSON.parse(trimmed) as IgnitionLogRow;
      if (row.type === 'close' && row.byArm) {
        const { type: _t, recordedAt: _r, ...res } = row;
        void _t; void _r;
        closes.push(res as IgnitionResolution);
      } else if (row.type === 'open') {
        jsonlOpens += 1;
      }
    } catch {
      // skip a torn/partial trailing line rather than abort the hydrate
    }
  }
  for (const c of closes.slice(-MAX_RESOLVED_RECORDS)) resolvedRecords.push(c);

  let snapshot: IgnitionStateSnapshot | null = null;
  try {
    snapshot = JSON.parse(readFileSync(ignitionStatePath(dataDir), 'utf8')) as IgnitionStateSnapshot;
  } catch {
    snapshot = null;
  }

  if (snapshot && Number.isFinite(snapshot.totalResolved)) {
    totalResolved = Math.max(snapshot.totalResolved, closes.length);
  } else {
    totalResolved = closes.length;
  }
  if (snapshot && Number.isFinite(snapshot.totalOpens)) {
    totalOpens = Math.max(snapshot.totalOpens, jsonlOpens);
  } else {
    totalOpens = jsonlOpens;
  }
  if (snapshot && (snapshot.firstRecordedAt == null || Number.isFinite(snapshot.firstRecordedAt))) {
    firstRecordedAt = snapshot.firstRecordedAt;
  }

  if (snapshot) {
    for (const [k, v] of Object.entries(snapshot.openRecordBySymbol ?? {})) {
      if (v && typeof v.signalBarTime === 'string') openRecordBySymbol.set(k, v);
    }
    for (const [k, v] of Object.entries(snapshot.lastBarBySymbol ?? {})) {
      if (typeof v === 'string') lastBarBySymbol.set(k, v);
    }
    for (const [k, v] of Object.entries(snapshot.lastFireBarBySymbol ?? {})) {
      if (typeof v === 'string') lastFireBarBySymbol.set(k, v);
    }
    for (const [k, v] of Object.entries(snapshot.freeAfterBarBySymbol ?? {})) {
      if (typeof v === 'string') freeAfterBarBySymbol.set(k, v);
    }
  }

  return {
    resolvedLoaded: resolvedRecords.length,
    totalResolved,
    totalOpens,
    firstRecordedAt,
    openRecords: openRecordBySymbol.size,
  };
}

// ── Observe routine (dependency-injected so zero-IO-when-off is testable) ────

/** 4H-bar fetcher: symbol → CLOSED-or-forming candles (oldest-first). */
export type Fetch4hBars = (symbol: string) => Promise<Candle[]>;

export interface ObserveIgnitionDeps {
  /** ENABLE_CRYPTO_IGNITION_SCANNER state — checked FIRST (invariant #1). */
  enabled: boolean;
  watchlist: string[];
  /** Regime classifier config (fed to the SAME closed series the signal decides on). */
  regimeCfg: CryptoRegimeConfig;
  cfg: IgnitionConfig;
  fetch4h: Fetch4hBars;
  /** DATA_DIR for the JSONL + snapshot (persisted per pass). Omit to skip persistence. */
  dataDir?: string;
  now?: number;
  onError?: (symbol: string, err: unknown) => void;
}

export interface ObserveIgnitionResult {
  fetched: number;
  scanned: number;
  /** Fires opened this pass. */
  opened: IgnitionOpenRecord[];
  /** Forward records resolved this pass. */
  resolved: IgnitionResolution[];
}

const FOUR_H_MS = 4 * 60 * 60 * 1000;

/**
 * Run one observe-only ignition pass. GUARDS on `enabled` BEFORE touching
 * `fetch4h` so a flag-OFF pass is provably zero cost/IO (invariant #1 — the spy
 * test asserts `fetch4h` is never called). When ON: fetches per watchlist symbol,
 * drops the in-progress forming bar (no lookahead), dedupes on the newest closed
 * bar, classifies the regime off the SAME closed series (reuse TRA-1220 — do NOT
 * re-derive), resolves any open fire forward, then evaluates a fresh fire on the
 * last bar. Read-only — NO order/entry/sizing path.
 */
export async function observeIgnition(deps: ObserveIgnitionDeps): Promise<ObserveIgnitionResult> {
  const empty: ObserveIgnitionResult = { fetched: 0, scanned: 0, opened: [], resolved: [] };
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
    // Only CLOSED bars: drop any trailing forming bar whose 4H bucket hasn't elapsed.
    const closed = bars.filter((b) => Number.isFinite(b.timestamp) && b.timestamp + FOUR_H_MS <= now);
    if (closed.length === 0) continue;
    const lastBarIso = new Date(closed[closed.length - 1].timestamp).toISOString();
    if (lastBarBySymbol.get(symbol) === lastBarIso) continue; // bar hasn't advanced
    lastBarBySymbol.set(symbol, lastBarIso);
    barsBySymbol.set(symbol, closed);
  }

  if (barsBySymbol.size === 0) return { fetched, scanned: 0, opened: [], resolved: [] };

  // Classify the regime off the SAME closed series (reuse the TRA-1220 pure scan).
  const readings = scanCryptoRegime(barsBySymbol, deps.regimeCfg, now);
  const regimeBySymbol = new Map<string, CryptoRegimeReading>();
  for (const r of readings) regimeBySymbol.set(r.symbol.trim().toUpperCase(), r);

  const opened: IgnitionOpenRecord[] = [];
  const resolved: IgnitionResolution[] = [];
  const logRows: IgnitionLogRow[] = [];
  let scanned = 0;

  for (const [symbol, closed] of barsBySymbol) {
    scanned += 1;
    const regime = regimeBySymbol.get(symbol)?.regime ?? null;

    // 1. Try to resolve an open fire forward (pessimistic walk to TP/stop/timeout).
    const open = openRecordBySymbol.get(symbol);
    let resolvedThisPass = false;
    if (open) {
      const sigIdx = closed.findIndex(
        (b) => Number.isFinite(b.timestamp) && new Date(b.timestamp).toISOString() === open.signalBarTime,
      );
      if (sigIdx >= 0) {
        const res = resolveIgnition(closed, sigIdx, deps.cfg, open.regimeAtSignal);
        if (res) {
          openRecordBySymbol.delete(symbol);
          recordResolved(res);
          resolved.push(res);
          logRows.push({ type: 'close', recordedAt: now, ...res });
          resolvedThisPass = true;
          // Non-overlapping: don't re-enter on/before this trade's latest exit bar.
          const exitTimes = [res.byArm.tp10sl4.exitBarTime, res.byArm.tp15sl5.exitBarTime].filter(
            (t): t is string => t != null,
          );
          if (exitTimes.length > 0) {
            freeAfterBarBySymbol.set(symbol, exitTimes.sort()[exitTimes.length - 1]);
          }
        }
      }
      // signalBar not found (fell out of window) ⇒ leave open; the age cap on the
      // rolling series (260 bars ≫ maxHold) means this effectively never happens.
    }

    // 2. If flat, evaluate a FRESH fire on the last closed bar (non-overlapping).
    if (!openRecordBySymbol.has(symbol) && !resolvedThisPass) {
      const sig = scanIgnition(closed, deps.cfg, regime);
      const t = sig.signalBarTime;
      const newerThanLastFire = t != null && (lastFireBarBySymbol.get(symbol) ?? '') < t;
      const afterFree = t != null && (freeAfterBarBySymbol.get(symbol) ?? '') < t;
      if (sig.fired && sig.signalClose != null && t != null && newerThanLastFire && afterFree) {
        const rec: IgnitionOpenRecord = {
          symbol,
          signalBarTime: t,
          signalClose: round6(sig.signalClose),
          regimeAtSignal: regime,
          openedAt: now,
        };
        openRecordBySymbol.set(symbol, rec);
        lastFireBarBySymbol.set(symbol, t);
        totalOpens += 1;
        if (firstRecordedAt == null) firstRecordedAt = now;
        opened.push(rec);
        logRows.push({ type: 'open', recordedAt: now, ...rec });
      }
    }
  }

  // Persist the pass (best-effort): append the fire/resolution rows, rewrite the
  // snapshot so open fires + the turnover anchor survive a restart.
  if (deps.dataDir) {
    appendLogRows(deps.dataDir, logRows, IGNITION_LOG_MAX_BYTES);
    writeSnapshot(deps.dataDir, now);
  }

  return { fetched, scanned, opened, resolved };
}
