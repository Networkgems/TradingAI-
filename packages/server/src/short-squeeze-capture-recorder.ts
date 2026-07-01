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

/**
 * The raw engine legs for a captured symbol-day, surfaced as discrete fields so
 * the Step-2 grader (TRA-1208) does not have to reach into `filters[]` for each
 * datum. These are POINT-IN-TIME values that cannot be reconstructed later —
 * `price` in particular is the entry close the forward MFE is measured against,
 * and `shortInterestAsOf` is the FINRA settlement date the squeeze move must be
 * graded relative to (short interest is bi-monthly / stale). All null-tolerant.
 */
export interface ShortSqueezeCaptureRawInputs {
  shortPercentOfFloat: number | null;
  sharesShort: number | null;
  daysToCover: number | null;
  floatShares: number | null;
  sharesOutstanding: number | null;
  marketCap: number | null;
  avgDailyVolume: number | null;
  rvol: number | null;
  /** Entry close — the denominator for the forward return / MFE. */
  price: number | null;
  sma50: number | null;
  /** FINRA settlement / as-of date of the short-interest datum (epoch ms). */
  shortInterestAsOf: number | null;
}

/**
 * Forward outcome, appended on resolution (mirrors the reversal / IV-RV shadow
 * ledgers). Computed by {@link resolveShortSqueezeForwardOutcomes} once the
 * post-scan sessions have closed: it never exists at capture time. The label the
 * Step-2 grader scores each qualifier on.
 */
export interface ShortSqueezeForwardOutcome {
  /** Entry close the returns are measured from (copied from rawInputs.price). */
  entryClose: number;
  /** ms-epoch of the last session folded into this resolution. */
  resolvedAt: number;
  /** Close return at +1 / +3 / +5 sessions (fraction; null until that session closes). */
  ret1d: number | null;
  ret3d: number | null;
  ret5d: number | null;
  /**
   * Max favorable excursion over the next ≤5 sessions = highest high ÷ entry
   * close − 1. The squeeze label: how far the name ran, not just where it closed.
   */
  mfe5d: number | null;
  /** Number of post-entry sessions actually observed (0–5); <5 ⇒ still resolving. */
  sessionsForward: number;
}

export interface ShortSqueezeCaptureRow {
  /** Underlying ticker (uppercased). */
  symbol: string;
  /**
   * ms-epoch the scan sweep ran (mirrors the file-level `recordedAt`). Stamped
   * per-row so a single row is self-contained for JSONL-style grading and so the
   * forward resolver can anchor the +1d/+3d/+5d window without the file header.
   */
  scanTs: number;
  /**
   * `ok` — the screener produced an evaluation for this symbol-day;
   * `no_data` — neither fundamentals nor daily bars were available;
   * `fetch_error` — a feed threw. The last two carry null qualifier fields.
   */
  outcome: 'ok' | 'no_data' | 'fetch_error';
  /**
   * Raw engine legs (discrete fields) — point-in-time, non-reconstructable.
   * Null when not `ok`.
   */
  rawInputs: ShortSqueezeCaptureRawInputs | null;
  /**
   * Forward outcome — null until {@link resolveShortSqueezeForwardOutcomes}
   * appends it once the post-scan sessions close. This is the graded label.
   */
  forward: ShortSqueezeForwardOutcome | null;
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
  /** Self-documenting entry/return convention for the Step-2 grader (TRA-1208). */
  entryConvention: string;
  /** One row per requested symbol. */
  symbols: ShortSqueezeCaptureRow[];
}

/**
 * The entry/return convention, stamped into every partition + `_meta.json` so the
 * Step-2 ratification P&L (TRA-1208) is unambiguous. The capture rides the
 * 3:55 PM ET `onChainRecord` hook, so `entryClose` = `rawInputs.price` = the last
 * daily bar's close at that instant (the scan-day ~3:55 PM close, NOT next-day
 * open). `ret{1,3,5}d` and `mfe5d` are measured off daily bars whose ET date is
 * STRICTLY AFTER the scan date — so `ret1d` is the NEXT session's close ÷
 * entryClose − 1. A signal firing at 3:55 PM realistically fills next-day open, so
 * treat `ret1d` as the realizable first-bar proxy when grading a tradable entry.
 */
export const SHORT_SQUEEZE_ENTRY_CONVENTION =
  'entryClose=scan-day 3:55PM ET close (last daily bar at capture instant); ' +
  'ret{1,3,5}d & mfe5d measured off daily bars strictly after scan date ' +
  '(ret1d = next-session close ÷ entryClose − 1); realizable entry ≈ next-day open, ' +
  'so treat ret1d as the realizable first-bar proxy.';

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
function toRow(result: ShortSqueezeScanResult, scanTs: number): ShortSqueezeCaptureRow {
  const evaluation = result.evaluation;
  if (result.reason !== 'ok' || !evaluation) {
    // `no_data` / `fetch_error` — no qualifier reading for this symbol-day.
    // Preserve the outcome (fail-closed: absence is recorded, never a pass).
    return {
      symbol: result.symbol,
      scanTs,
      outcome: result.reason === 'fetch_error' ? 'fetch_error' : 'no_data',
      rawInputs: null,
      forward: null,
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
  const f = result.fundamentals;
  const p = result.priceStats;
  const rawInputs: ShortSqueezeCaptureRawInputs = {
    shortPercentOfFloat: f?.shortPercentOfFloat ?? null,
    sharesShort: f?.sharesShort ?? null,
    daysToCover: f?.daysToCover ?? null,
    floatShares: f?.floatShares ?? null,
    sharesOutstanding: f?.sharesOutstanding ?? null,
    marketCap: f?.marketCap ?? null,
    avgDailyVolume: p?.avgDailyVolume ?? null,
    rvol: p?.rvol ?? null,
    price: p?.price ?? null,
    sma50: p?.sma50 ?? null,
    shortInterestAsOf: f?.shortInterestAsOf ?? null,
  };
  return {
    symbol: result.symbol,
    scanTs,
    outcome: 'ok',
    rawInputs,
    forward: null,
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
  const symbols = results.map((r) => toRow(r, now));

  const file: ShortSqueezeCaptureFile = {
    date,
    recordedAt: now,
    universeSource: options.universeSource,
    thresholds: options.thresholds,
    entryConvention: SHORT_SQUEEZE_ENTRY_CONVENTION,
    symbols,
  };
  const filePath = join(outDir, 'short-squeeze.json');
  await writeFile(filePath, JSON.stringify(file), 'utf-8');

  const meta = {
    date,
    recordedAt: now,
    universeSource: options.universeSource,
    entryConvention: SHORT_SQUEEZE_ENTRY_CONVENTION,
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
