/**
 * TRA-4059 — completeness census for `/api/health/chain-capture`.
 *
 * The route used to publish `tradingDaysCaptured: <partition count>`, and a
 * partition is created by `mkdir` BEFORE a single symbol is fetched — so a
 * session that wrote zero files (2026-08-18: 25/25 `no_expirations`) counted
 * exactly like one that wrote 25. Over 2026-07-31 → 2026-08-25 only 7 of 20
 * sessions were complete, two trading days had no partition at all, and the
 * envelope read `capturing: true` / `progressToThirtyDays {captured: 68}` the
 * whole time. This is the pass/fail-identical instrument shape.
 *
 * This module is pure so the classification is unit-testable against a
 * synthetic partition list; the route feeds it the storage report it already
 * computes plus each partition's cheap `_meta.json`.
 */

export type ChainSessionKind = 'complete' | 'partial' | 'empty' | 'absent';

export interface ChainPartitionObservation {
  date: string;
  /** Per-symbol snapshot files on disk (either storage form). */
  files: number;
  /** From `_meta.json`, when present. */
  meta?: {
    symbolCount?: number;
    written?: number;
    skipped?: number;
    wholesaleSkip?: boolean;
    passes?: number;
    rescuedByRetry?: string[];
    outcomeCounts?: Record<string, number>;
  } | null;
}

export interface ChainSessionRow {
  date: string;
  kind: ChainSessionKind;
  /** Files on disk — the durable truth a replay reads. `0` for absent. */
  files: number;
  /** Universe the session was asked for (meta `symbolCount`, else the configured universe). */
  universe: number;
  written: number | null;
  skipped: number | null;
  outcomeCounts: Record<string, number> | null;
  /** Retry passes the session ran (TRA-4059 builds only; `null` before). */
  passes: number | null;
  rescuedByRetry: number | null;
}

export type ChainCaptureStatus = 'green' | 'degraded' | 'outage' | 'no_data';

export interface ChainCaptureCompleteness {
  window: {
    /** Trading days graded — the retention window, ending at `to`. */
    tradingDays: number;
    from: string | null;
    to: string | null;
  };
  /** Expected sessions inside the window (= trading days). */
  expectedSessions: number;
  completeSessions: number;
  partialSessions: number;
  emptySessions: number;
  absentSessions: number;
  /** `completeSessions / expectedSessions`, 4 dp. `null` when nothing is expected. */
  completeRate: number | null;
  /** Dates in the window with no partition directory at all. */
  absentDates: string[];
  /** Dates with a partition and zero snapshot files. */
  emptyDates: string[];
  /**
   * The session that lost the most — fewest files — among the most recent
   * `recentSessions`. An outage reads here first.
   */
  worstRecentSession: ChainSessionRow | null;
  /** Newest-last, the last `recentSessions` expected trading days. */
  recentSessions: ChainSessionRow[];
  /**
   * `outage`   — the most recent expected session is empty or absent.
   * `degraded` — the most recent expected session is partial, or any of the
   *              last `recentSessions` is not complete.
   * `green`    — the last `recentSessions` expected sessions are all complete.
   * `no_data`  — nothing expected / nothing on disk.
   */
  status: ChainCaptureStatus;
  statusReason: string;
}

export function classifyChainSession(
  obs: ChainPartitionObservation | null,
  date: string,
  configuredUniverse: number,
): ChainSessionRow {
  if (!obs) {
    return {
      date,
      kind: 'absent',
      files: 0,
      universe: configuredUniverse,
      written: null,
      skipped: null,
      outcomeCounts: null,
      passes: null,
      rescuedByRetry: null,
    };
  }
  const meta = obs.meta ?? null;
  const universe =
    typeof meta?.symbolCount === 'number' && meta.symbolCount > 0 ? meta.symbolCount : configuredUniverse;
  const files = Math.max(0, obs.files);
  const kind: ChainSessionKind = files === 0 ? 'empty' : universe > 0 && files < universe ? 'partial' : 'complete';
  return {
    date,
    kind,
    files,
    universe,
    written: typeof meta?.written === 'number' ? meta.written : null,
    skipped: typeof meta?.skipped === 'number' ? meta.skipped : null,
    outcomeCounts: meta?.outcomeCounts ?? null,
    passes: typeof meta?.passes === 'number' ? meta.passes : null,
    rescuedByRetry: Array.isArray(meta?.rescuedByRetry) ? meta!.rescuedByRetry!.length : null,
  };
}

/**
 * The `n` most recent trading days ending at `lastInclusive` (YYYY-MM-DD),
 * ascending. Walks calendar days backward through `isTradingDay`.
 */
export function trailingTradingDays(
  lastInclusive: string,
  n: number,
  isTradingDay: (iso: string) => boolean,
): string[] {
  const out: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lastInclusive) || n <= 0) return out;
  const cursor = new Date(`${lastInclusive}T00:00:00Z`);
  // Bound the walk: n trading days never span more than ~2n calendar days
  // plus holidays; 4n is a generous ceiling that still terminates on a
  // pathological predicate.
  for (let guard = 0; out.length < n && guard < n * 4 + 10; guard++) {
    const iso = cursor.toISOString().slice(0, 10);
    if (isTradingDay(iso)) out.unshift(iso);
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return out;
}

export function summarizeChainCaptureCompleteness(opts: {
  partitions: readonly ChainPartitionObservation[];
  /** Ascending expected trading days — see {@link trailingTradingDays}. */
  expectedDates: readonly string[];
  configuredUniverse: number;
  /** How many of the newest expected sessions the status is judged on. Default 5. */
  recentSessions?: number;
}): ChainCaptureCompleteness {
  const recentN = Math.max(1, opts.recentSessions ?? 5);
  const byDate = new Map(opts.partitions.map((p) => [p.date, p]));
  const rows = opts.expectedDates.map((d) => classifyChainSession(byDate.get(d) ?? null, d, opts.configuredUniverse));

  const count = (k: ChainSessionKind) => rows.filter((r) => r.kind === k).length;
  const complete = count('complete');
  const recent = rows.slice(-recentN);
  const worst = recent.length
    ? recent.reduce((w, r) => (r.files < w.files ? r : w), recent[0])
    : null;

  let status: ChainCaptureStatus;
  let statusReason: string;
  const newest = rows[rows.length - 1] ?? null;
  if (!newest) {
    status = 'no_data';
    statusReason = 'no expected sessions in window';
  } else if (newest.kind === 'empty' || newest.kind === 'absent') {
    status = 'outage';
    statusReason = `most recent expected session ${newest.date} is ${newest.kind} (${newest.files}/${newest.universe})`;
  } else if (newest.kind === 'partial') {
    status = 'degraded';
    statusReason = `most recent expected session ${newest.date} is partial (${newest.files}/${newest.universe})`;
  } else {
    const bad = recent.filter((r) => r.kind !== 'complete');
    if (bad.length > 0) {
      status = 'degraded';
      statusReason = `${bad.length} of the last ${recent.length} expected sessions not complete: ${bad
        .map((r) => `${r.date}=${r.kind}(${r.files}/${r.universe})`)
        .join(', ')}`;
    } else {
      status = 'green';
      statusReason = `last ${recent.length} expected sessions complete`;
    }
  }

  return {
    window: {
      tradingDays: opts.expectedDates.length,
      from: opts.expectedDates[0] ?? null,
      to: opts.expectedDates[opts.expectedDates.length - 1] ?? null,
    },
    expectedSessions: rows.length,
    completeSessions: complete,
    partialSessions: count('partial'),
    emptySessions: count('empty'),
    absentSessions: count('absent'),
    completeRate: rows.length ? Math.round((complete / rows.length) * 10_000) / 10_000 : null,
    absentDates: rows.filter((r) => r.kind === 'absent').map((r) => r.date),
    emptyDates: rows.filter((r) => r.kind === 'empty').map((r) => r.date),
    worstRecentSession: worst,
    recentSessions: recent,
    status,
    statusReason,
  };
}
