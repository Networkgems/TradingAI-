/**
 * TRA-1209 (TRA-1208 Phase-2 Step 1) — Short-squeeze observe-capture recorder.
 *
 * Mirrors the TRA-822 StockTwits sentiment-snapshot recorder
 * (`sentiment-snapshot-recorder.ts`) and the TRA-376 option-chain recorder: once
 * per trading day it runs the {@link ShortSqueezeScannerService} over the demo
 * watchlist and appends every per-symbol qualifier reading to a date-partitioned
 * JSON file. This is the forward-collected qualifier time series QuantTrader
 * grades in the Step-2 ratification gate — the running server predates the
 * Phase-1 screener route, so without this loop there is no persisted history.
 *
 * OBSERVE-ONLY. This is a pure data layer: it records what the screener sees and
 * never sizes or places an order. The scan itself is injected as `scanUniverse`
 * so the recorder stays testable without network IO, exactly like the sentiment
 * recorder injects `fetchSentiment`.
 *
 * Capture is intentionally taken at the SHIPPED PERMISSIVE thresholds (RVOL >
 * 1.0), NOT QuantTrader's provisional 1.5 tightening — the point of the observe
 * window is to see the full RVOL distribution across short-float-eligible names
 * so the final 1.5 cut can be ratified empirically. The full per-criterion
 * `filters` array is persisted for exactly this reason. The effective thresholds
 * are stamped into each file so a grader can confirm the capture cut.
 *
 * Storage layout
 *   <outDir>/<YYYY-MM-DD>/short-squeeze.json   one qualifier row per symbol
 *   <outDir>/<YYYY-MM-DD>/_meta.json           recorder run metadata
 *
 * Null coverage is fail-closed by construction: a missing input maps to
 * `applicable:false` inside the engine (never a silent pass), and a symbol whose
 * feeds are cold records a `no_data` / `fetch_error` outcome rather than a row.
 */

import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import type {
  ShortSqueezeClassification,
  ShortSqueezeFilterKey,
  ShortSqueezeFilterResult,
  ShortSqueezeThresholds,
} from '@trading-app/engine';
import { etDateKey } from './options-chain-recorder.js';
import type { ShortSqueezeScanResult } from './short-squeeze-scanner.js';

export interface ShortSqueezeCaptureRow {
  /** Underlying ticker (uppercased). */
  symbol: string;
  /**
   * `ok` — the screener produced an evaluation for this symbol-day;
   * `no_data` — neither fundamentals nor daily bars were available;
   * `fetch_error` — a feed threw. The last two carry null qualifier fields.
   */
  outcome: 'ok' | 'no_data' | 'fetch_error';
  /** 0–100 composite score (null when not `ok`). */
  score: number | null;
  classification: ShortSqueezeClassification | null;
  /** Core-gate qualifier verdict at the capture thresholds (null when not `ok`). */
  qualifies: boolean | null;
  /**
   * Full per-criterion breakdown (value + pass + applicable + threshold + weight).
   * The whole array is retained — QuantTrader needs the RVOL distribution across
   * short-float-eligible names, not just the pass/fail.
   */
  filters: ShortSqueezeFilterResult[] | null;
  /** Count of applicable criteria that passed (null when not `ok`). */
  passedCount: number | null;
  /** Count of criteria that could be judged — input present (null when not `ok`). */
  applicableCount: number | null;
  /** Criteria that could not be judged because their input was missing. */
  missingInputs: ShortSqueezeFilterKey[] | null;
  errorMessage?: string;
}

export interface ShortSqueezeCaptureFile {
  /** ET date partition (YYYY-MM-DD). */
  date: string;
  /** ms-epoch when the capture sweep ran. */
  recordedAt: number;
  /** `SHORT_SQUEEZE_WATCHLIST` vs the resolved demo watchlist. */
  universeSource: string;
  /** Effective thresholds the capture was scored at (the permissive RVOL>1.0 cut). */
  thresholds: ShortSqueezeThresholds;
  /** One row per requested symbol. */
  symbols: ShortSqueezeCaptureRow[];
}

export interface ShortSqueezeCaptureRecorderResult {
  symbols: ShortSqueezeCaptureRow[];
  /** Date partition written into (YYYY-MM-DD in ET). */
  date: string;
  /** Absolute directory the capture was written to. */
  outDir: string;
  /** Absolute path of the short-squeeze.json file. */
  filePath: string;
}

export interface ShortSqueezeCaptureRecorderOptions {
  /** Symbols to capture. Caller resolves the active demo watchlist. */
  symbols: readonly string[];
  /**
   * Universe scanner — the server wires this to
   * `shortSqueezeScannerService.scanUniverse`. Injected so the recorder stays a
   * pure data layer, testable without Yahoo/Tradier network IO.
   */
  scanUniverse: (symbols: readonly string[]) => Promise<ShortSqueezeScanResult[]>;
  /** Output root — partitioned by ET date below. */
  outDir: string;
  /** Effective thresholds, stamped into the file so a grader can confirm the cut. */
  thresholds: ShortSqueezeThresholds;
  /** Provenance label for the universe (`SHORT_SQUEEZE_WATCHLIST` | `demo-watchlist`). */
  universeSource: string;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
}

/** Map a scanner result onto the persisted capture row (observe-only projection). */
function toRow(result: ShortSqueezeScanResult): ShortSqueezeCaptureRow {
  const evaluation = result.evaluation;
  if (result.reason !== 'ok' || !evaluation) {
    // `no_data` / `fetch_error` — no qualifier reading for this symbol-day.
    // Preserve the outcome (fail-closed: absence is recorded, never a pass).
    return {
      symbol: result.symbol,
      outcome: result.reason === 'fetch_error' ? 'fetch_error' : 'no_data',
      score: null,
      classification: null,
      qualifies: null,
      filters: null,
      passedCount: null,
      applicableCount: null,
      missingInputs: null,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    };
  }
  return {
    symbol: result.symbol,
    outcome: 'ok',
    score: evaluation.score,
    classification: evaluation.classification,
    qualifies: evaluation.qualifies,
    filters: evaluation.filters,
    passedCount: evaluation.passedCount,
    applicableCount: evaluation.applicableCount,
    missingInputs: evaluation.missingInputs,
  };
}

/**
 * Run a one-shot short-squeeze capture across all `symbols`. Returns the
 * per-symbol rows so the caller can log a summary; the JSON file is the durable
 * artifact. The underlying scan isolates per-symbol failures already, so a
 * single cold ticker degrades to a `no_data` row rather than aborting the sweep.
 */
export async function recordShortSqueezeCapture(
  options: ShortSqueezeCaptureRecorderOptions,
): Promise<ShortSqueezeCaptureRecorderResult> {
  const now = options.now ? options.now() : Date.now();
  const date = etDateKey(now);
  const outDir = join(options.outDir, date);
  await mkdir(outDir, { recursive: true });

  const requested = [...new Set(options.symbols.map((s) => s.trim().toUpperCase()))].filter(Boolean);
  const results = await options.scanUniverse(requested);
  const symbols = results.map(toRow);

  const file: ShortSqueezeCaptureFile = {
    date,
    recordedAt: now,
    universeSource: options.universeSource,
    thresholds: options.thresholds,
    symbols,
  };
  const filePath = join(outDir, 'short-squeeze.json');
  await writeFile(filePath, JSON.stringify(file), 'utf-8');

  const meta = {
    date,
    recordedAt: now,
    universeSource: options.universeSource,
    symbolCount: symbols.length,
    ok: symbols.filter((s) => s.outcome === 'ok').length,
    qualifiers: symbols.filter((s) => s.qualifies === true).length,
    noData: symbols.filter((s) => s.outcome === 'no_data').length,
    errored: symbols.filter((s) => s.outcome === 'fetch_error').length,
    perSymbol: symbols.map((s) => ({
      symbol: s.symbol,
      outcome: s.outcome,
      score: s.score,
      qualifies: s.qualifies,
    })),
  };
  await writeFile(join(outDir, '_meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

  return { symbols, date, outDir, filePath };
}
