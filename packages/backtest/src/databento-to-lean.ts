/**
 * TRA-2052 — Databento (DBN/CSV) → QuantConnect LEAN data converter.
 *
 * Implementation child of TRA-2041 (board-approved spend `c6d47aba`,
 * $750 one-time HARD CEILING, $0 recurring). Parent context TRA-2029.
 *
 * WHY this exists
 * ---------------
 * Our backtest↔live *fidelity* is the open gap flagged by the CTO review
 * (TRA-2031, "core gap = backtest<->live fidelity B+"). To cross-check the
 * engine's numbers we need an INDEPENDENT data source (Databento) fed through
 * an INDEPENDENT replay stack (LEAN). This module is the seam between the two:
 * it maps Databento equity bars/ticks onto the on-disk layout LEAN expects.
 *
 * The actual reconciliation (running LEAN over this data and diffing against
 * our engine) is the SIBLING child (TRA-2053), which is blocked by this one.
 *
 * SCOPE / STATUS
 * --------------
 *   ✅  LEAN data-format encoders (daily/minute bars, map-files, factor-files)
 *       — fully implemented and unit-tested (`databento-to-lean.test.ts`).
 *   🔒  DBN ingestion (`readDatabentoDaily` / `readDatabentoTrades`) is a STUB.
 *       It cannot be completed until a Databento account + API key exist, which
 *       is OPERATOR-GATED (payment method the agent cannot supply — see
 *       `tools/lean/README.md` §"Operator action required"). The stub documents
 *       the exact record shape so wiring the real pull is a mechanical drop-in.
 *
 * LEAN DATA FORMAT (US equities), for reference:
 *   daily : data/equity/usa/daily/<sym>.zip  → <sym>.csv
 *           rows: "yyyyMMdd 00:00,O,H,L,C,V"  prices in DECI-CENTS (usd*10000)
 *   minute: data/equity/usa/minute/<sym>/<yyyyMMdd>_trade.zip
 *           → <yyyyMMdd>_<sym>_minute_trade.csv
 *           rows: "<ms-since-midnight>,O,H,L,C,V"  prices in DECI-CENTS
 *   map   : data/equity/usa/map_files/<sym>.csv  rows: "yyyyMMdd,ticker,exch"
 *   factor: data/equity/usa/factor_files/<sym>.csv
 *           rows: "yyyyMMdd,priceFactor,splitFactor,referencePrice"
 *
 * Prices are stored as deci-cents so LEAN's decimal reader is exact; volumes
 * are whole shares. This module never rounds silently — it asserts finite,
 * non-negative inputs and throws on bad bars so a corrupt pull fails LOUD.
 */

import { WATCHLIST } from '@trading-app/shared';

/** A single OHLCV bar, prices in whole US dollars, volume in shares. */
export interface EquityBar {
  /** Epoch milliseconds at the bar's OPEN (UTC). */
  readonly timestamp: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/** One entry in a LEAN factor-file (split/dividend adjustment history). */
export interface FactorRow {
  /** Effective date, epoch ms (UTC midnight). */
  readonly timestamp: number;
  /** Cumulative dividend/price adjustment factor (1.0 = unadjusted). */
  readonly priceFactor: number;
  /** Cumulative split factor (1.0 = unadjusted). */
  readonly splitFactor: number;
  /** Reference (close) price on the effective date, whole dollars. */
  readonly referencePrice: number;
}

/**
 * The exact set this converter targets: the ~25-name equities WATCHLIST, which
 * ALREADY includes the SPY/QQQ benchmarks (plus IWM/DIA/XLF). Kept in sync with
 * `@trading-app/shared` so the Databento pull, this converter, and the engine
 * backtest all speak the same universe — no drift.
 */
export const LEAN_SYMBOL_SET: readonly string[] = WATCHLIST;

const MS_PER_DAY = 86_400_000;

// ── deci-cent price encoding ─────────────────────────────────────────────────

/**
 * Dollars → deci-cents (LEAN's integer price unit). `123.45` → `1234500`.
 * Rounds to the nearest deci-cent (LEAN's own resolution); asserts finiteness so
 * a NaN/Inf from a malformed source record can never be silently written as 0.
 */
export function toDeciCents(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new RangeError(`toDeciCents: non-finite/negative price ${usd}`);
  }
  return Math.round(usd * 10_000);
}

/** Assert a bar is well-formed (finite, ordered H≥L, non-negative volume). */
export function assertValidBar(b: EquityBar): void {
  for (const [k, v] of [
    ['open', b.open], ['high', b.high], ['low', b.low], ['close', b.close],
  ] as const) {
    if (!Number.isFinite(v) || v < 0) throw new RangeError(`bar.${k}=${v} invalid`);
  }
  if (!Number.isFinite(b.volume) || b.volume < 0) {
    throw new RangeError(`bar.volume=${b.volume} invalid`);
  }
  if (b.high < b.low) throw new RangeError(`bar high ${b.high} < low ${b.low}`);
  if (!Number.isInteger(b.timestamp)) throw new RangeError(`bar.timestamp not int`);
}

// ── UTC date helpers (LEAN keys everything off the trading date) ──────────────

function yyyymmdd(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getUTCFullYear();
  const m = `${d.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${d.getUTCDate()}`.padStart(2, '0');
  return `${y}${m}${day}`;
}

function msSinceUtcMidnight(epochMs: number): number {
  return ((epochMs % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
}

// ── LEAN CSV encoders (the tested core) ──────────────────────────────────────

/**
 * Encode DAILY bars into a LEAN daily CSV body (one row per bar, chronological).
 * Row: `yyyyMMdd 00:00,O,H,L,C,V` with prices in deci-cents. Returns the CSV
 * text that goes *inside* `<sym>.zip` as `<sym>.csv`.
 */
export function encodeDailyCsv(bars: readonly EquityBar[]): string {
  return [...bars]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((b) => {
      assertValidBar(b);
      return [
        `${yyyymmdd(b.timestamp)} 00:00`,
        toDeciCents(b.open), toDeciCents(b.high),
        toDeciCents(b.low), toDeciCents(b.close),
        Math.round(b.volume),
      ].join(',');
    })
    .join('\n');
}

/**
 * Encode one trading day's MINUTE bars into a LEAN minute CSV body.
 * Row: `<ms-since-midnight>,O,H,L,C,V` with prices in deci-cents. All bars MUST
 * fall on the same UTC date; throws otherwise (LEAN stores one zip per day).
 * Returns the CSV text for `<yyyyMMdd>_<sym>_minute_trade.csv`.
 */
export function encodeMinuteCsv(bars: readonly EquityBar[]): string {
  if (bars.length === 0) return '';
  const day0 = yyyymmdd(bars[0].timestamp);
  return [...bars]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((b) => {
      assertValidBar(b);
      if (yyyymmdd(b.timestamp) !== day0) {
        throw new RangeError(`encodeMinuteCsv: bar ${yyyymmdd(b.timestamp)} != day ${day0}`);
      }
      return [
        msSinceUtcMidnight(b.timestamp),
        toDeciCents(b.open), toDeciCents(b.high),
        toDeciCents(b.low), toDeciCents(b.close),
        Math.round(b.volume),
      ].join(',');
    })
    .join('\n');
}

/**
 * Emit a LEAN map-file body for a symbol with no ticker renames over the window.
 * LEAN needs a first-day and a far-future last-day sentinel row so its universe
 * resolver has explicit bounds. `exchange` is a single-char LEAN venue code
 * (e.g. 'Q'=Nasdaq, 'N'=NYSE, 'P'=NYSE Arca); default 'Q'.
 *
 * NOTE: for the two renamed names in our universe (SQ→XYZ, and any future
 * corporate actions) the map-file MUST carry the rename row — see
 * `STOCK_TICKER_ALIASES` in `@trading-app/shared`. This helper covers the
 * common no-rename case; renames are passed explicitly via `extraRows`.
 */
export function encodeMapFile(
  symbol: string,
  firstDateMs: number,
  opts: { exchange?: string; lastDate?: string; extraRows?: readonly string[] } = {},
): string {
  const exch = (opts.exchange ?? 'Q').toUpperCase();
  const sym = symbol.toLowerCase();
  const rows = [
    `${yyyymmdd(firstDateMs)},${sym},${exch}`,
    ...(opts.extraRows ?? []),
    `${opts.lastDate ?? '20501231'},${sym},${exch}`,
  ];
  return rows.join('\n');
}

/**
 * Emit a LEAN factor-file body from split/dividend history. LEAN reads these
 * chronologically and always terminates with a `20501231,1,1,0` sentinel.
 * With no corporate actions this collapses to a single unadjusted sentinel —
 * which is the correct default for a raw (unadjusted) Databento trades pull.
 */
export function encodeFactorFile(rows: readonly FactorRow[]): string {
  const body = [...rows]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((r) =>
      [yyyymmdd(r.timestamp), r.priceFactor, r.splitFactor, r.referencePrice].join(','),
    );
  body.push('20501231,1,1,0');
  return body.join('\n');
}

// ── Databento DBN ingestion — OPERATOR-GATED STUB ────────────────────────────

/**
 * Read Databento DAILY (`ohlcv-1d`) records for `symbol` from a pulled DBN/CSV
 * file and normalise to `EquityBar[]` (dollars, UTC-open timestamps).
 *
 * 🔒 NOT YET IMPLEMENTED — requires a Databento API key / a completed pull,
 * which is operator-gated (payment method). Databento `ohlcv-1d` records carry
 * `ts_event` (nanoseconds UTC), `open/high/low/close` as FIXED-POINT INT64 with
 * 1e-9 scaling, and `volume` (uint64). The real body is:
 *
 *   dollars = fixedPointInt64 / 1e9          // Databento price scale
 *   timestamp = Number(ts_event / 1_000_000n) // ns → ms
 *
 * Wire the official `databento` client (or parse the CSV export) here; the
 * encoders above then need no changes.
 */
export function readDatabentoDaily(_dbnPathOrCsv: string, _symbol: string): EquityBar[] {
  throw new Error(
    'readDatabentoDaily: Databento pull is operator-gated (no API key). ' +
      'See tools/lean/README.md §"Operator action required". ' +
      'This is a stub — implement against `databento` ohlcv-1d once provisioned.',
  );
}

/**
 * Read Databento TRADES (`trades`) or L1 BBO (`mbp-1`) records and aggregate to
 * minute `EquityBar[]`. Same operator-gated status as {@link readDatabentoDaily}.
 * Trade records carry `ts_event` (ns), `price` (1e-9 fixed-point) and `size`.
 * Minute aggregation groups by `floor(ts_ms / 60000)` and takes first/max/min/
 * last price + summed size per bucket.
 */
export function readDatabentoTrades(_dbnPathOrCsv: string, _symbol: string): EquityBar[] {
  throw new Error(
    'readDatabentoTrades: Databento pull is operator-gated (no API key). ' +
      'See tools/lean/README.md §"Operator action required". ' +
      'This is a stub — implement against `databento` trades/mbp-1 once provisioned.',
  );
}
