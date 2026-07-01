// TRA-1216 (parent TRA-1214, epic TRA-1210) — forward perp funding-history log.
//
// This is the ONE persisted artifact of the funding-carry build and the reason
// it exists: today the harness has NO funding time series, which is the sole
// blocker on backtesting the carry (#1) and basis (#B) strategies. The existing
// `FundingRateTracker.tick()` only fetches funding for OPEN positions and applies
// accrual — it persists nothing. So the flag-gated hourly hook appends one row
// per watchlist perp here, building the series forward.
//
// Append-only JSONL under DATA_DIR, size-capped with a single rolled `.1` backup
// so a long run can't grow the file without bound. The scan store itself stays
// transient (in-memory, like IV-RV). Flag-gated at the caller: when the flag is
// OFF this module is never invoked, so there are zero file writes.

import { appendFileSync, mkdirSync, renameSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'perp-funding-history' });

export const FUNDING_HISTORY_FILENAME = 'perp-funding-history.jsonl';

/** Default rotation threshold — roll to `.1` and start fresh past ~8 MB. */
export const FUNDING_HISTORY_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** One captured funding observation — the backtest-ready series row. */
export interface FundingHistoryEntry {
  /** Observation time, ms epoch. */
  ts: number;
  productId: string;
  /** Per-interval funding decimal (signed). */
  fundingRate: number;
  /** Venue funding cadence in hours (INTX = 1) — needed to annualize later. */
  intervalHours: number;
  /** Mark price at capture, or null when unavailable. */
  markPrice: number | null;
}

/** Resolve the funding-history file path under DATA_DIR. */
export function fundingHistoryPath(dataDir: string): string {
  return join(dataDir, FUNDING_HISTORY_FILENAME);
}

/**
 * Append funding rows to the JSONL series, rotating the file to `<path>.1` when
 * it would exceed `maxBytes`. Only rows with a FINITE `fundingRate` are written —
 * a missing/null funding point is a gap, not a data point, and a phantom row
 * would poison a downstream carry backtest. Returns the number of rows written.
 *
 * Best-effort: an I/O failure logs and returns the count written so far rather
 * than throwing — this is an observe-only accrual and must never break the
 * hourly funding tick.
 */
export function appendFundingHistory(
  dataDir: string,
  entries: readonly FundingHistoryEntry[],
  maxBytes: number = FUNDING_HISTORY_DEFAULT_MAX_BYTES,
): number {
  const clean = entries.filter(
    (e) => Number.isFinite(e.fundingRate) && Number.isFinite(e.intervalHours) && e.intervalHours > 0,
  );
  if (clean.length === 0) return 0;

  const path = fundingHistoryPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // directory already exists / unwritable — the append below surfaces the error
  }

  try {
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      size = 0; // file absent ⇒ fresh
    }
    if (size >= maxBytes) {
      // Roll to a single backup, overwriting any prior `.1`, then start fresh.
      try {
        renameSync(path, `${path}.1`);
      } catch (err) {
        log.warn('funding-history rotate failed', {
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const payload = clean.map((e) => JSON.stringify(e)).join('\n') + '\n';
    appendFileSync(path, payload, 'utf8');
    return clean.length;
  } catch (err) {
    log.warn('funding-history append failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}
