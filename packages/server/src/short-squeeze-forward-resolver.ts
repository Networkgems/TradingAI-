/**
 * TRA-1209 (TRA-1208 Phase-2 Step 1) — Short-squeeze forward-outcome resolver.
 *
 * The capture recorder ({@link ./short-squeeze-capture-recorder}) persists a
 * point-in-time qualifier snapshot per symbol-day, but a snapshot alone can't
 * tell QuantTrader whether a qualifier actually squeezed. This resolver is the
 * append-on-resolution half of the shadow-ledger pattern (mirrors the reversal /
 * IV-RV forward-return backfill): once the sessions AFTER a capture have closed
 * it fetches the forward daily bars and stamps each row's `forward` outcome —
 * the +1d / +3d / +5d close return and the 5-session max favorable excursion —
 * which is the label the Step-2 threshold sign-off grades on.
 *
 * OBSERVE-ONLY, idempotent, and reconstructable: forward closes/highs are
 * permanent history, so this can be (re)run at any time over the accumulated
 * partitions and it only rewrites a file when it actually folds in new sessions.
 * A partition whose sessions haven't fully elapsed resolves partially now and
 * completes on a later run (sessionsForward climbs 0→5).
 */

import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { join } from 'path';
import type { Candle } from '@trading-app/shared';
import { etDateKey } from './options-chain-recorder.js';
import type {
  ShortSqueezeCaptureFile,
  ShortSqueezeCaptureRow,
  ShortSqueezeForwardOutcome,
} from './short-squeeze-capture-recorder.js';

/** How many post-entry sessions the MFE / return window spans. */
export const SHORT_SQUEEZE_FORWARD_SESSIONS = 5;

const DATE_PARTITION = /^\d{4}-\d{2}-\d{2}$/;
// Enough daily bars to always cover the 5 forward sessions plus slack for
// weekends/holidays between the capture date and "today".
const FORWARD_BARS_TO_FETCH = 30;

/**
 * Pure forward-outcome computation. `forwardBars` must be the daily bars STRICTLY
 * AFTER the entry session, chronologically ascending. Returns the outcome
 * resolvable from however many sessions have elapsed (0–5); callers re-run until
 * `sessionsForward` reaches {@link SHORT_SQUEEZE_FORWARD_SESSIONS}.
 */
export function computeForwardOutcome(
  entryClose: number,
  forwardBars: readonly Candle[],
  now: number,
): ShortSqueezeForwardOutcome {
  const window = forwardBars.slice(0, SHORT_SQUEEZE_FORWARD_SESSIONS);
  const retAt = (n: number): number | null => {
    const bar = window[n - 1];
    return bar && Number.isFinite(bar.close) && entryClose > 0 ? bar.close / entryClose - 1 : null;
  };
  const highs = window.map((b) => b.high).filter((h) => Number.isFinite(h));
  const mfe5d =
    highs.length > 0 && entryClose > 0 ? Math.max(...highs) / entryClose - 1 : null;
  return {
    entryClose,
    resolvedAt: now,
    ret1d: retAt(1),
    ret3d: retAt(3),
    ret5d: retAt(5),
    mfe5d,
    sessionsForward: window.length,
  };
}

export interface ResolveShortSqueezeForwardOptions {
  /** Capture root — the same `SHORT_SQUEEZE_OUT_DIR` the recorder writes under. */
  outDir: string;
  /** Daily-bar source (server wires this to `fetchDailyCandles`; Yahoo → Tradier). */
  fetchDailyBars: (symbol: string, count: number) => Promise<Candle[]>;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
}

export interface ResolveShortSqueezeForwardResult {
  /** Date partitions inspected. */
  partitions: number;
  /** Partition files rewritten because at least one row gained sessions. */
  filesUpdated: number;
  /** Rows whose forward window advanced this run. */
  rowsResolved: number;
  /** Rows now fully resolved (sessionsForward === 5). */
  rowsComplete: number;
}

/** True when a row still needs forward sessions folded in. */
function needsResolution(row: ShortSqueezeCaptureRow): boolean {
  if (row.outcome !== 'ok' || row.rawInputs?.price == null || !(row.rawInputs.price > 0)) return false;
  const done = row.forward?.sessionsForward ?? 0;
  return done < SHORT_SQUEEZE_FORWARD_SESSIONS;
}

/**
 * Walk every capture partition and append/advance the forward outcome for each
 * unresolved `ok` row. Per-symbol bar fetches are cached within a run (the same
 * ticker can appear across many partitions) and isolated so one cold feed never
 * aborts the sweep. Returns a summary for the health surface.
 */
export async function resolveShortSqueezeForwardOutcomes(
  options: ResolveShortSqueezeForwardOptions,
): Promise<ResolveShortSqueezeForwardResult> {
  const now = options.now ? options.now() : Date.now();
  let dates: string[] = [];
  try {
    dates = (await readdir(options.outDir)).filter((d) => DATE_PARTITION.test(d)).sort();
  } catch {
    dates = [];
  }

  const barCache = new Map<string, Candle[]>();
  const getBars = async (symbol: string): Promise<Candle[]> => {
    const key = symbol.toUpperCase();
    const cached = barCache.get(key);
    if (cached) return cached;
    let bars: Candle[] = [];
    try {
      bars = await options.fetchDailyBars(key, FORWARD_BARS_TO_FETCH);
    } catch {
      bars = [];
    }
    const sorted = [...bars].sort((a, b) => a.timestamp - b.timestamp);
    barCache.set(key, sorted);
    return sorted;
  };

  const result: ResolveShortSqueezeForwardResult = {
    partitions: dates.length,
    filesUpdated: 0,
    rowsResolved: 0,
    rowsComplete: 0,
  };

  for (const date of dates) {
    const filePath = join(options.outDir, date, 'short-squeeze.json');
    let file: ShortSqueezeCaptureFile;
    try {
      file = JSON.parse(await readFile(filePath, 'utf-8')) as ShortSqueezeCaptureFile;
    } catch {
      continue;
    }
    const rows = Array.isArray(file.symbols) ? file.symbols : [];
    let fileChanged = false;

    for (const row of rows) {
      if (!needsResolution(row)) continue;
      const entryClose = row.rawInputs!.price!;
      const bars = await getBars(row.symbol);
      // Forward sessions = bars whose ET date is strictly after the capture's
      // partition date (the entry session itself is excluded). Using the ET date
      // key rather than the raw scanTs avoids a same-day boundary ambiguity when
      // the capture runs after the close.
      const forwardBars = bars.filter((b) => etDateKey(b.timestamp) > date);
      if (forwardBars.length === 0 && (row.forward?.sessionsForward ?? 0) === 0) {
        // Nothing has closed yet — leave the row unresolved rather than stamping
        // an empty outcome, so the health surface reads "still pending".
        continue;
      }
      const outcome = computeForwardOutcome(entryClose, forwardBars, now);
      const prior = row.forward?.sessionsForward ?? 0;
      if (outcome.sessionsForward > prior) {
        row.forward = outcome;
        fileChanged = true;
        result.rowsResolved += 1;
      }
      if ((row.forward?.sessionsForward ?? 0) >= SHORT_SQUEEZE_FORWARD_SESSIONS) {
        result.rowsComplete += 1;
      }
    }

    if (fileChanged) {
      await mkdir(join(options.outDir, date), { recursive: true });
      await writeFile(filePath, JSON.stringify(file), 'utf-8');
      result.filesUpdated += 1;
    }
  }

  return result;
}
