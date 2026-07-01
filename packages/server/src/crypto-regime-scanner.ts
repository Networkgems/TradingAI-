// TRA-1220 (parent TRA-1218, rec #3 of the TRA-1211 memo) — crypto regime-filter
// overlay OBSERVE-ONLY scanner. Thin sibling to `perp-funding-carry-scanner.ts`
// (TRA-1216): a PURE `scanCryptoRegime(barsBySymbol, cfg, now)` over 4H candles
// the caller already fetched, plus an in-memory latest-wins store backing the
// read-only `GET /api/health/crypto-regime` surface. It places NO orders, sizes
// nothing, touches no account — the classifier emits regime LABELS only.
//
// Fail-closed throughout: a symbol with insufficient/degenerate candles surfaces
// a `regime:null, reason:'insufficient_data'` reading (never an invented regime).
// No lookahead — the caller passes CLOSED bars only (drops the forming bar) and
// the classifier is stateless per bar.
//
// In-memory (not persisted) by design: the labels are transient observe-only
// reads the board/QuantTrader watches to validate separation/calibration before
// any gating decision (invariant #4). Nothing is written to disk off this pass.

import {
  classifyCryptoRegime,
  type CryptoRegimeConfig,
  type CryptoRegimeReading,
} from '@trading-app/engine';
import type { Candle } from '@trading-app/shared';

/**
 * Classify a batch of symbols' CLOSED 4H candles into regime readings. Pure — no
 * I/O, no orders. Readings are ranked trend-first (trend_up/trend_down before
 * chop before insufficient), then by descending confidence, then symbol for
 * stability.
 *
 * @param barsBySymbol map of symbol → CLOSED 4H candles (oldest-first).
 * @param cfg          classifier thresholds.
 * @param now          injected clock (ms) so the `asOf` stamp is deterministic.
 */
export function scanCryptoRegime(
  barsBySymbol: ReadonlyMap<string, Candle[]> | Record<string, Candle[]>,
  cfg: CryptoRegimeConfig,
  now: number = Date.now(),
): CryptoRegimeReading[] {
  const entries: Array<[string, Candle[]]> =
    barsBySymbol instanceof Map ? [...barsBySymbol.entries()] : Object.entries(barsBySymbol);
  const readings = entries.map(([symbol, bars]) => {
    const reading = classifyCryptoRegime(bars ?? [], cfg, now);
    // Prefer the caller's map key as the canonical symbol when the candles carry
    // none (or a stale one) — the store keys on it.
    const key = symbol.trim().toUpperCase();
    return key !== '' && reading.symbol !== key ? { ...reading, symbol: key } : reading;
  });
  return sortReadings(readings);
}

function regimeRank(r: CryptoRegimeReading): number {
  if (r.regime === 'trend_up' || r.regime === 'trend_down') return 0;
  if (r.regime === 'chop') return 1;
  return 2; // null / insufficient
}

function sortReadings(readings: CryptoRegimeReading[]): CryptoRegimeReading[] {
  return [...readings].sort((a, b) => {
    const ra = regimeRank(a);
    const rb = regimeRank(b);
    if (ra !== rb) return ra - rb;
    const ca = a.confidence ?? -1;
    const cb = b.confidence ?? -1;
    if (cb !== ca) return cb - ca;
    return a.symbol.localeCompare(b.symbol);
  });
}

// ── In-memory latest-scan store (backs GET /api/health/crypto-regime) ────────

interface StoredReading {
  reading: CryptoRegimeReading;
  recordedAt: number;
}

/** Cap on retained symbols so the store can't grow unbounded over a long run. */
const MAX_STORED_SYMBOLS = 128;
/**
 * Entries older than this are swept on read. 4H bars roll every 4h, so the TTL
 * sits at one bar + a 1h buffer (5h): a fresh reading stays until the next bar's
 * classification replaces it, with slack for a missed pass.
 */
const STORE_TTL_MS = 5 * 60 * 60_000;

const store = new Map<string, StoredReading>();

/**
 * Record a batch of regime readings (latest-wins per symbol). Oldest-inserted
 * symbols are evicted past the cap. Observe-only — callers gate on the flag, so
 * the store stays empty when the scanner is off.
 */
export function recordCryptoRegimeScan(
  readings: readonly CryptoRegimeReading[],
  now: number = Date.now(),
): void {
  for (const r of readings) {
    const key = r.symbol.trim().toUpperCase();
    if (key === '') continue;
    store.delete(key); // re-insert at the tail so eviction is oldest-first
    store.set(key, { reading: { ...r, symbol: key }, recordedAt: now });
  }
  while (store.size > MAX_STORED_SYMBOLS) {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** Test seam — drop every recorded reading. */
export function clearCryptoRegimeScans(): void {
  store.clear();
}

/** One symbol's most-recent regime reading, plus when it was recorded. */
export interface CryptoRegimeScanView extends CryptoRegimeReading {
  recordedAt: string;
}

export interface CryptoRegimeScansSummary {
  /** Symbols with a fresh (within-TTL) recorded reading. */
  symbolCount: number;
  /** Fresh readings labelled trend_up or trend_down. */
  trendCount: number;
  /** Fresh readings labelled chop. */
  chopCount: number;
  scans: CryptoRegimeScanView[];
}

/**
 * Fold the store into the read-only diagnostics summary, dropping entries past
 * the TTL and ranking trend-first then by descending confidence. Pure beyond the
 * injected clock.
 */
export function summarizeCryptoRegimeScans(now: number = Date.now()): CryptoRegimeScansSummary {
  const views: CryptoRegimeScanView[] = [];
  for (const [key, entry] of store) {
    if (now - entry.recordedAt >= STORE_TTL_MS) {
      store.delete(key);
      continue;
    }
    views.push({ ...entry.reading, recordedAt: new Date(entry.recordedAt).toISOString() });
  }
  views.sort((a, b) => {
    const ra = regimeRank(a);
    const rb = regimeRank(b);
    if (ra !== rb) return ra - rb;
    const ca = a.confidence ?? -1;
    const cb = b.confidence ?? -1;
    if (cb !== ca) return cb - ca;
    return a.symbol.localeCompare(b.symbol);
  });
  return {
    symbolCount: views.length,
    trendCount: views.filter((v) => v.regime === 'trend_up' || v.regime === 'trend_down').length,
    chopCount: views.filter((v) => v.regime === 'chop').length,
    scans: views,
  };
}

// ── Observe routine (dependency-injected so zero-IO-when-off is testable) ────

/** 4H-bar fetcher: symbol → CLOSED-or-forming candles (oldest-first). */
export type Fetch4hBars = (symbol: string) => Promise<Candle[]>;

export interface ObserveCryptoRegimeDeps {
  /** ENABLE_CRYPTO_REGIME_OVERLAY state — checked FIRST (invariant #1). */
  enabled: boolean;
  watchlist: string[];
  cfg: CryptoRegimeConfig;
  fetch4h: Fetch4hBars;
  /**
   * Per-symbol dedupe: ISO of the last CLOSED bar already classified. Re-classify
   * a symbol at most once per newly-closed 4H bar (spec §6). Mutated in place.
   */
  lastBarBySymbol: Map<string, string>;
  now?: number;
  onError?: (symbol: string, err: unknown) => void;
}

export interface ObserveCryptoRegimeResult {
  fetched: number;
  recorded: number;
  readings: CryptoRegimeReading[];
}

const FOUR_H_MS = 4 * 60 * 60 * 1000;

/**
 * Run one observe-only crypto-regime pass. GUARDS on `enabled` BEFORE touching
 * `fetch4h` so a flag-OFF pass is provably zero cost/IO (invariant #1 — the spy
 * test asserts `fetch4h` is never called). When ON: fetches per watchlist symbol,
 * drops the in-progress forming bar (invariant #3 — no lookahead), dedupes on the
 * newest closed bar, classifies via the pure engine substrate, and records the
 * ranked labels into the store. Read-only — NO order/entry/sizing path.
 */
export async function observeCryptoRegime(
  deps: ObserveCryptoRegimeDeps,
): Promise<ObserveCryptoRegimeResult> {
  const empty: ObserveCryptoRegimeResult = { fetched: 0, recorded: 0, readings: [] };
  if (!deps.enabled) return empty; // flag OFF ⇒ zero cost/IO (no fetch)
  if (deps.watchlist.length === 0) return empty;
  const now = deps.now ?? Date.now();

  const barsBySymbol = new Map<string, Candle[]>();
  let fetched = 0;
  for (const symbol of deps.watchlist) {
    let bars: Candle[];
    try {
      bars = await deps.fetch4h(symbol);
      fetched++;
    } catch (err) {
      deps.onError?.(symbol, err);
      continue;
    }
    // Invariant #3 — classify only CLOSED bars: drop any trailing forming bar
    // whose 4H bucket has not yet elapsed.
    const closed = bars.filter(
      (b) => Number.isFinite(b.timestamp) && b.timestamp + FOUR_H_MS <= now,
    );
    if (closed.length === 0) continue;
    const lastBarIso = new Date(closed[closed.length - 1].timestamp).toISOString();
    if (deps.lastBarBySymbol.get(symbol) === lastBarIso) continue; // bar hasn't advanced
    deps.lastBarBySymbol.set(symbol, lastBarIso);
    barsBySymbol.set(symbol, closed);
  }

  if (barsBySymbol.size === 0) return { fetched, recorded: 0, readings: [] };
  const readings = scanCryptoRegime(barsBySymbol, deps.cfg, now);
  recordCryptoRegimeScan(readings, now);
  return { fetched, recorded: readings.length, readings };
}

/**
 * Pure "Crypto regime overlay" EOD markdown section (spec §6) capturing the
 * forward regime labels so we accrue evidence for the later gating decision.
 * Observe-only — folds a {@link CryptoRegimeScansSummary} into a table; renders a
 * disabled/empty fallback when the overlay is off or no fresh labels exist.
 *
 * @param enabled  ENABLE_CRYPTO_REGIME_OVERLAY state (surfaced verbatim).
 * @param summary  {@link summarizeCryptoRegimeScans} output for the report clock.
 */
export function buildCryptoRegimeEodSection(
  enabled: boolean,
  summary: CryptoRegimeScansSummary,
): string {
  const header = '## Crypto Regime Overlay (observe-only)';
  if (!enabled || summary.scans.length === 0) {
    const why = !enabled ? 'overlay disabled' : 'no fresh regime labels';
    return `${header}\n\n_${why}._`;
  }
  const num = (n: number | null, dp: number) => (n == null ? '—' : n.toFixed(dp));
  const rows = summary.scans
    .map((s) => {
      const label = s.regime ?? 'insufficient';
      return `| ${s.symbol} | ${label} | ${num(s.confidence, 3)} | ${num(s.adx, 1)} | ${num(
        s.choppiness,
        1,
      )} | ${num(s.efficiencyRatio, 3)} | ${s.lastBarTime ?? '—'} |`;
    })
    .join('\n');
  return `${header}

Symbols ${summary.symbolCount} · trend ${summary.trendCount} · chop ${summary.chopCount}

| Symbol | Regime | Conf | ADX | CHOP | ER | Last 4H bar |
|--------|--------|------|-----|------|----|-------------|
${rows}`;
}
