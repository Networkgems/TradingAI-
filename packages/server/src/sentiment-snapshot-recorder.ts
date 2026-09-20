/**
 * TRA-822 (TRA-820 Step 1) — Daily StockTwits sentiment-snapshot recorder.
 *
 * Mirrors the TRA-376 option-chain recorder (`options-chain-recorder.ts`): once
 * per trading day at ~3:55 PM ET it reduces each watchlist symbol's live
 * StockTwits stream to a single {@link SocialSentiment} read and appends it to a
 * date-partitioned JSON file. The output is the forward-collected sentiment time
 * series the TRA-820 IC/flow study needs — StockTwits sentiment is otherwise
 * held only in `SignalEngine.socialCache` (in-memory, reduced on read), so
 * without this logger there is no persisted history to measure.
 *
 * Storage layout
 *   <outDir>/<YYYY-MM-DD>/sentiment.json   one snapshot row per symbol
 *   <outDir>/<YYYY-MM-DD>/_meta.json       recorder run metadata
 *
 * Like the chain recorder this is a pure data layer: it owns no engine / account
 * state and the actual StockTwits fetch + aggregation is injected as
 * `fetchSentiment`, keeping the recorder testable without network IO. The server
 * wires it into the SAME `onChainRecord` scheduler hook so the two snapshots
 * co-accumulate on the persistent disk (TRA-820 §5).
 *
 * TRA-2519 — the sweep is NOT once per day in practice, and the write used to be
 * a blind overwrite. Two facts collide:
 *
 *   1. The `onChainRecord` hook fires at-or-after 15:55 ET through 20:00 ET and
 *      dedupes on `lastChainRecordDate`, which is IN-MEMORY. Every process
 *      restart inside that window re-arms it, so a restart storm re-runs the
 *      sweep — bqb1 ran it ~50 times on 2026-07-27 alone (TRA-2476).
 *   2. `writeFile` replaced the whole partition. The LAST run of the day won.
 *
 * So one late sweep that found the rate-limit breaker open (a 3ms no-op that
 * returns `no_data` for all 25 symbols) ERASED whatever earlier runs had
 * captured. A day that read `recorded: 0` was indistinguishable from a day that
 * never had data at all — the artifact carried no trace of the read it destroyed.
 *
 * The write is now a MERGE that can only ever upgrade a symbol-day
 * ({@link OUTCOME_RANK}: `recorded` > `error` > `no_data`), and rows for symbols
 * absent from the current universe are carried forward rather than dropped. That
 * turns the restart storm from a data destroyer into a free retry: each re-fire
 * is another chance at the same day, and the partition keeps the best read.
 *
 * Non-recorded rows also carry a `reason` now (`breaker_open` vs `fetch_failed`),
 * because "0 of 25 recorded" read identically whether the breaker was open, the
 * egress was Cloudflare-blocked, or every call timed out.
 */

import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { SocialSentiment } from '@trading-app/shared';
import { etDateKey } from './options-chain-recorder.js';

export interface SentimentSnapshotRow {
  /** Underlying ticker (uppercased). */
  symbol: string;
  /**
   * `recorded` — a sentiment read was obtained (even a neutral/empty one);
   * `no_data` — the fetch degraded to null (rate-limit breaker / 429 / cold),
   * so there is no read for this symbol-day; `error` — the resolver threw.
   */
  outcome: 'recorded' | 'no_data' | 'error';
  /** The aggregated read, or null when not `recorded`. */
  sentiment: SocialSentiment | null;
  errorMessage?: string;
  /**
   * TRA-2519 — why a non-`recorded` row has no read, as reported by the caller's
   * {@link SentimentSnapshotRecorderOptions.describeUnavailable}. `breaker_open`
   * (the rate-limit breaker short-circuited the fetch, so no request was even
   * made) reads very differently from `fetch_failed` (a request went out and was
   * refused/timed out) when you are deciding whether the problem is our backoff
   * or the egress IP. Absent on `recorded` rows.
   */
  reason?: string;
  /** TRA-2519 — 1-based sweep pass that produced this row (>1 = a retry won it). */
  attempt?: number;
}

/**
 * TRA-2519 — merge precedence for the same symbol-day. A partition rewrite may
 * only ever move a symbol UP this ladder, never down: a real read outranks a
 * failure, and a failure that at least made a request outranks a silent
 * no-op. Ties go to the newer row (a later read is fresher and closer to the
 * close).
 */
const OUTCOME_RANK: Readonly<Record<SentimentSnapshotRow['outcome'], number>> = {
  recorded: 2,
  error: 1,
  no_data: 0,
};

export interface SentimentSnapshotFile {
  /** ET date partition (YYYY-MM-DD). */
  date: string;
  /** ms-epoch when the snapshot sweep ran. */
  recordedAt: number;
  /** One row per requested symbol, in request order. */
  symbols: SentimentSnapshotRow[];
}

export interface SentimentSnapshotRecorderResult {
  /** The MERGED partition rows — prior reads this sweep did not beat included. */
  symbols: SentimentSnapshotRow[];
  /** Rows produced by THIS sweep only, before the merge against the partition. */
  swept: SentimentSnapshotRow[];
  /** Date partition written into (YYYY-MM-DD in ET). */
  date: string;
  /** Absolute directory the snapshot was written to. */
  outDir: string;
  /** Absolute path of the sentiment.json file. */
  filePath: string;
  /** Sweep passes actually run (1 = no retry was needed or allowed). */
  attempts: number;
  /**
   * TRA-2519 — symbols whose merged row came from a PRIOR run of the same day
   * because this sweep did no better. Under the old blind overwrite each of
   * these was silently destroyed; a non-zero count here is the repair working.
   */
  preservedFromPrior: string[];
}

/**
 * TRA-2519 (ask #2) — bounded half-open retry for one sweep.
 *
 * The failure this exists for: the rate-limit breaker short-circuits every fetch
 * while it is open, so a sweep that starts inside an open cooldown finishes in
 * ~3ms with `no_data` across the entire universe and never looks again. On bqb1
 * the breaker cycles — it opened 68 times on 2026-07-27/28, each for exactly the
 * 5-minute default cooldown — so the very next window would have served data.
 *
 * The budget is deliberately tight. It runs on the scheduler's hook inside a
 * process the watchdog may kill at any moment, so it must never become a long
 * blocking sleep: `budgetMs` caps TOTAL wall-clock across all waits and the
 * per-pass delay is clamped to whatever is left.
 */
export interface SentimentRetryPolicy {
  /** Extra passes over the still-unrecorded symbols. 0 disables retry. */
  maxAttempts: number;
  /** Total wall-clock budget across ALL waits, in ms. */
  budgetMs: number;
  /**
   * How long to wait before the next pass, or null to stop retrying now.
   * The server wires this to the breaker's own reset deadline so we resume the
   * instant the cooldown lapses instead of guessing.
   */
  nextDelayMs: () => number | null;
  /** Test seam — defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SentimentSnapshotRecorderOptions {
  /** Symbols to record. Caller resolves the active watchlist. */
  symbols: readonly string[];
  /**
   * Sentiment resolver — returns the aggregated read for a symbol, or null when
   * no read could be obtained (rate-limited / cold). Injected so the recorder
   * stays a pure data layer; the server wires the StockTwits fetch +
   * `aggregateStockTwitsSentiment` reduction here.
   */
  fetchSentiment: (symbol: string) => Promise<SocialSentiment | null>;
  /** Output root — partitioned by ET date below. */
  outDir: string;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
  /**
   * TRA-2519 — label WHY a fetch came back null, evaluated immediately after the
   * null so it can read live feed state (breaker open vs a refused request).
   * Optional; omitted → rows carry no `reason`.
   */
  describeUnavailable?: (symbol: string) => string | undefined;
  /** TRA-2519 — bounded half-open retry. Omitted → single pass, as before. */
  retry?: SentimentRetryPolicy;
  /**
   * TRA-4739 — provenance for the curated (followed-account) lane, stamped into
   * `_meta.json` verbatim. The curated lane was retired on 2026-09-20, and a
   * row's `curatedCount: 0` cannot tell you which side of that you are on: it
   * reads the same whether nine accounts were polled and contributed nothing
   * (the 20 dry days before) or nobody was polled at all (every day after). The
   * study that consumes this series has to partition on the change, so the
   * change is written down rather than left to be inferred from the dates.
   * Omitted → the key is absent from meta, which itself dates the partition to
   * before this field shipped.
   */
  curatedLane?: { status: string; accounts: number };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Read the existing partition for this date, or null when there isn't one. */
async function readExistingPartition(filePath: string): Promise<SentimentSnapshotFile | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return null; // first sweep of the day — nothing to merge against.
  }
  try {
    const parsed = JSON.parse(raw) as SentimentSnapshotFile;
    return Array.isArray(parsed?.symbols) ? parsed : null;
  } catch {
    // A truncated/corrupt partition must not abort the sweep — but we also must
    // not silently treat it as "no prior data" without saying so.
    return null;
  }
}

/**
 * Run a one-shot sentiment capture across all `symbols`. Returns the per-symbol
 * outcome so the caller can log a summary; the JSON file itself is the durable
 * artifact. Errors are isolated per symbol — a single failing ticker doesn't
 * abort the whole sweep.
 */
export async function recordSentimentSnapshot(
  options: SentimentSnapshotRecorderOptions,
): Promise<SentimentSnapshotRecorderResult> {
  const now = options.now ? options.now() : Date.now();
  const date = etDateKey(now);
  const outDir = join(options.outDir, date);
  await mkdir(outDir, { recursive: true });

  const filePath = join(outDir, 'sentiment.json');

  // TRA-2519 — stamp the partition BEFORE the first fetch. A sweep the
  // watchdog killed mid-pass used to leave NO artifact at all: a 404 that
  // reads identically to a date never reached (2026-08-04 was dark this way —
  // the sweep started 21:23:47Z, died, and left nothing to attribute). The
  // skeleton is all-`no_data` rows with reason `sweep_incomplete`; the
  // end-of-sweep write (or any later re-fire's merge) upgrades every row it
  // beats, so a surviving `sweep_incomplete` row IS the durable record that a
  // sweep started and never finished. Only written when no partition exists —
  // an earlier run's real rows are never touched.
  const skeletonOrder: string[] = [];
  const skeletonSeen = new Set<string>();
  for (const raw of options.symbols) {
    const symbol = raw.trim().toUpperCase();
    if (!skeletonSeen.has(symbol)) {
      skeletonSeen.add(symbol);
      skeletonOrder.push(symbol);
    }
  }
  if ((await readExistingPartition(filePath)) === null) {
    const skeletonRows: SentimentSnapshotRow[] = skeletonOrder.map((symbol) => ({
      symbol,
      outcome: 'no_data',
      sentiment: null,
      reason: 'sweep_incomplete',
    }));
    const skeleton: SentimentSnapshotFile = { date, recordedAt: now, symbols: skeletonRows };
    await writeFile(filePath, JSON.stringify(skeleton), 'utf-8');
    await writeFile(
      join(outDir, '_meta.json'),
      JSON.stringify(
        {
          date,
          recordedAt: now,
          symbolCount: skeletonRows.length,
          recorded: 0,
          noData: skeletonRows.length,
          errored: 0,
          // attempts: 0 is the discriminator — no completed sweep has ever
          // written this partition. A finished sweep always stamps >= 1.
          attempts: 0,
          sweptRecorded: 0,
          preservedFromPrior: [],
          reasons: countBy(skeletonRows.map(() => 'sweep_incomplete')),
          perSymbol: skeletonRows.map((s) => ({ symbol: s.symbol, outcome: s.outcome })),
        },
        null,
        2,
      ),
      'utf-8',
    );
  }

  const sleep = options.retry?.sleep ?? defaultSleep;

  /** Fetch one symbol into a row. Errors are isolated per symbol. */
  const fetchRow = async (symbol: string, attempt: number): Promise<SentimentSnapshotRow> => {
    try {
      const sentiment = await options.fetchSentiment(symbol);
      if (sentiment === null) {
        const reason = options.describeUnavailable?.(symbol);
        return { symbol, outcome: 'no_data', sentiment: null, attempt, ...(reason ? { reason } : {}) };
      }
      return { symbol, outcome: 'recorded', sentiment, attempt };
    } catch (err) {
      return {
        symbol,
        outcome: 'error',
        sentiment: null,
        attempt,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  };

  // --- pass 1 over the full universe -------------------------------------
  const swept = new Map<string, SentimentSnapshotRow>();
  const order: string[] = [];
  for (const raw of options.symbols) {
    const symbol = raw.trim().toUpperCase();
    if (!swept.has(symbol)) order.push(symbol);
    swept.set(symbol, await fetchRow(symbol, 1));
  }

  // --- bounded half-open retry over what pass 1 could not record ----------
  // Only `recorded` ends a symbol's retries; a `no_data` from an open breaker is
  // exactly the case worth asking again, which is the whole point (ask #2).
  let attempts = 1;
  const retry = options.retry;
  if (retry && retry.maxAttempts > 0 && retry.budgetMs > 0) {
    let spentMs = 0;
    while (attempts <= retry.maxAttempts) {
      const missing = order.filter((s) => swept.get(s)?.outcome !== 'recorded');
      if (missing.length === 0) break;

      const remaining = retry.budgetMs - spentMs;
      if (remaining <= 0) break;
      const requested = retry.nextDelayMs();
      if (requested === null || !Number.isFinite(requested) || requested < 0) break;
      // Clamp to the surviving budget so a far-future breaker deadline can never
      // park this sweep for hours inside a process the watchdog may kill.
      const delay = Math.min(requested, remaining);

      if (delay > 0) await sleep(delay);
      spentMs += delay;
      attempts += 1;

      for (const symbol of missing) {
        const row = await fetchRow(symbol, attempts);
        // Never let a retry DOWNGRADE what pass 1 already got.
        const prior = swept.get(symbol);
        if (!prior || OUTCOME_RANK[row.outcome] >= OUTCOME_RANK[prior.outcome]) {
          swept.set(symbol, row);
        }
      }
    }
  }

  const sweptRows = order.map((s) => swept.get(s)!);

  // --- merge against any partition an earlier run of this ET day wrote -----
  // (Includes our own skeleton: every swept row ranks >= a skeleton row, so
  // the merge replaces skeleton rows wholesale and `preservedFromPrior` never
  // counts them.)
  const prior = await readExistingPartition(filePath);
  const merged = new Map<string, SentimentSnapshotRow>();
  const mergedOrder: string[] = [];
  const preservedFromPrior: string[] = [];

  for (const row of prior?.symbols ?? []) {
    if (typeof row?.symbol !== 'string') continue;
    const symbol = row.symbol.toUpperCase();
    if (!merged.has(symbol)) mergedOrder.push(symbol);
    merged.set(symbol, row);
  }
  for (const row of sweptRows) {
    const existing = merged.get(row.symbol);
    if (!existing) {
      mergedOrder.push(row.symbol);
      merged.set(row.symbol, row);
      continue;
    }
    // The one-way ratchet: this sweep may only replace a prior row when it is at
    // least as good. A late breaker-open no-op can no longer erase a real read.
    if (OUTCOME_RANK[row.outcome] >= OUTCOME_RANK[existing.outcome]) {
      merged.set(row.symbol, row);
    } else {
      preservedFromPrior.push(row.symbol);
    }
  }

  const symbols = mergedOrder.map((s) => merged.get(s)!);

  const file: SentimentSnapshotFile = { date, recordedAt: now, symbols };
  await writeFile(filePath, JSON.stringify(file), 'utf-8');

  const meta = {
    date,
    recordedAt: now,
    symbolCount: symbols.length,
    recorded: symbols.filter((s) => s.outcome === 'recorded').length,
    noData: symbols.filter((s) => s.outcome === 'no_data').length,
    errored: symbols.filter((s) => s.outcome === 'error').length,
    // TRA-2519 — sweep-vs-partition provenance. `sweptRecorded` well below
    // `recorded` means the merge saved the day from a late zero sweep.
    attempts,
    sweptRecorded: sweptRows.filter((s) => s.outcome === 'recorded').length,
    preservedFromPrior,
    reasons: countBy(symbols.filter((s) => s.outcome !== 'recorded').map((s) => s.reason ?? 'unspecified')),
    // TRA-4739 — which side of the curated-lane retirement this partition is on.
    // Absent when the caller did not say, which is itself the pre-2026-09-20 read.
    ...(options.curatedLane ? { curatedLane: options.curatedLane } : {}),
    perSymbol: symbols.map((s) => ({ symbol: s.symbol, outcome: s.outcome })),
  };
  await writeFile(join(outDir, '_meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

  return { symbols, swept: sweptRows, date, outDir, filePath, attempts, preservedFromPrior };
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}
