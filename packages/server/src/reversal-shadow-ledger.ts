import { appendFile, readFile, writeFile, mkdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import type { Candle } from '@trading-app/shared';
import type { CandlePattern, ReversalChecklist } from '@trading-app/engine';
import { logger } from './observability/index.js';
import {
  resolveOutcome,
  type ShadowOutcome,
  type ShadowResolution,
  type ShadowSignalRecord,
} from './shadow-signal-ledger.js';
import { resolveDataDir } from './data-dir.js';

// TRA-921 (TRA-920 B) — durable, OBSERVE-ONLY reversal-checklist signal->outcome
// ledger.
//
// TRA-920 Phase 1 shipped the swing-based S/R zones + reversal-confluence
// checklist primitive (`packages/engine/src/indicators/support-resistance.ts`).
// This module is the data spine that wires it into the shadow pipeline: on each
// signal-engine tick we evaluate `reversalChecklist()` per symbol and, when a
// bracketed setup prints (price AT a key zone, so entry/stop/target exist),
// append an immutable OPEN row carrying the four checklist legs, the score, and
// the zone touch-count. Once the bracket resolves over its forward horizon we
// append a RESOLVED row (TP_HIT | SL_HIT | TIMEOUT, realized R, bars-to-
// resolution) so the daily learning loop (TRA-920 A) can study how often N-of-4
// setups actually hit target.
//
// NOTHING here touches live capital. Like the Supertrend shadow ledger this is
// strictly append-only JSONL — reads fold by `id` keeping the latest line, so an
// OPEN row is superseded by its RESOLVED row without an in-place rewrite. The
// forward-horizon rule is shared VERBATIM with the Supertrend ledger
// (`resolveOutcome`) rather than re-implemented, so the two datasets resolve
// identically.

const log = logger.child({ module: 'reversal-shadow' });

/**
 * Kill switch. The pipeline appends nothing unless this is truthy, so the shadow
 * capture is OFF by default and a deploy can't start writing without an explicit
 * opt-in (mirrors `ENABLE_OPTION_SHADOW_SELECTOR`). Accepts the usual spellings.
 */
export const REVERSAL_SHADOW_FLAG = 'ENABLE_REVERSAL_SHADOW';

export function isReversalShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[REVERSAL_SHADOW_FLAG];
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * TRA-4883 — retention horizon. Rows whose SIGNAL time (`ts`) is older than this are
 * dropped from the fold and from disk on the boot load below.
 *
 * Why 30 days, and why the time-based cutoff the siblings use rather than a byte cap:
 * this file was the largest object on the money host's `/data` (133.5 MiB on
 * 2026-09-24) and it is the only one of the five biggest that had no bound of ANY
 * kind. Measured on bqb1 that beat, the ledger spans 2026-06-24 → 2026-09-24 (92.6
 * days) at ~437 bytes/row and ~5-7k rows per TRADING day, i.e. ~1.51 MiB per calendar
 * day averaged over its whole life. 30 days therefore parks it around 45-50 MiB —
 * the same band as its already-bounded siblings `churn-brake-guard.jsonl` (30d,
 * 38 MiB) and `live-enforce-gate.jsonl` (30d, 62 MiB), whose horizon this copies
 * verbatim rather than inventing a third number.
 *
 * A byte cap was considered and rejected: the only consumers are the TRA-925 learning
 * fold and the TRA-921 read probe, and BOTH reason in calendar time (per-ET-day
 * snapshots, `?from=`/`?to=` ms-epoch windows). A byte cap would make "how much
 * history is in here" depend on how busy the tape was, so a volatile fortnight would
 * silently shorten the learner's lookback exactly when its buckets matter most. The
 * min-sample guard is unaffected either way: 30 days is ~150k resolved rows against a
 * `minSamples` of 10.
 *
 * No capital path depends on this. `reversalSignalMultiplier` has no caller in the
 * signal engine (grepped 2026-09-24) — the ledger feeds the read probes and the daily
 * `learned-weights-history` trail, and that trail persists the DERIVED multipliers, so
 * pruning raw rows never rewrites recorded history.
 */
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

/** Published on the health probes (AC4) so `/data` can be audited without grepping here. */
export const REVERSAL_SHADOW_RETENTION_DAYS = RETAIN_MS / (24 * 60 * 60 * 1000);

/**
 * What the boot load actually did — the AC5 surface. A `RETAIN_MS` that ships without a
 * working boot hook reads identically to one that works, so the outcome is published,
 * not the constant alone. `null` until {@link initReversalShadowLedger} has run.
 */
export interface ReversalShadowCompaction {
  /** ISO time the load ran. */
  ranAt: string;
  /** Cutoff applied (ISO); rows with `ts` below this were dropped. */
  cutoff: string;
  /** Non-empty JSONL lines read off disk. */
  linesBefore: number;
  /** Lines kept (and, when `rewrote`, the lines now on disk). */
  linesAfter: number;
  /** Folded records dropped by the cutoff. */
  recordsDropped: number;
  /** Records retained in the in-memory fold. */
  recordsAfter: number;
  /** File size before/after, bytes. Equal when nothing was dropped. */
  bytesBefore: number;
  bytesAfter: number;
  /** False when nothing aged out (no needless rewrite on a clean boot). */
  rewrote: boolean;
  /** Set when the rewrite itself failed; the fold is still correct, disk is not. */
  error?: string;
}

let lastCompaction: ReversalShadowCompaction | null = null;

/** The most recent boot compaction, or null if the ledger has not been loaded yet. */
export function reversalShadowCompaction(): ReversalShadowCompaction | null {
  return lastCompaction;
}

function defaultStoreFile(): string {
  const root = resolveDataDir();
  return join(root, 'reversal-shadow-signals.jsonl');
}

let storeFileOverride: string | null = null;
/** Test seam — point the ledger at a temp file. Pass `null` to restore default. */
export function setReversalShadowLedgerFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
  lastCompaction = null;
}
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

/**
 * One captured reversal-checklist setup and (once resolved) its forward outcome.
 * The four legs are the RAW booleans the checklist scored, so attribution can
 * bucket hit-rate by `score` (4-of-4 vs 3-of-4 …). `entry` is the basis every R
 * multiple is measured from.
 */
export interface ReversalShadowRecord {
  /** Stable dedupe key: `${symbol}:${side}:${entryBarTs}` (one row per bar). */
  id: string;
  /** ms-epoch the setup printed. */
  ts: number;
  symbol: string;
  /** Direction the checklist bets the reversal. */
  side: 'long' | 'short';
  /** Leg 1 — price within proximity of a key swing zone. */
  atKeyLevel: boolean;
  /** Leg 2 — the trend into the level has broken. */
  trendBreak: boolean;
  /** Leg 3 — the approach into the level was a fast, over-extended move. */
  unhealthyMove: boolean;
  /** Leg 4 — a reversal candlestick printed in the trade direction. */
  pattern: boolean;
  /** The reversal candlestick name, when leg 4 fired (null otherwise). */
  patternName: CandlePattern | null;
  /** Count of satisfied checklist legs (1–4; rows always have leg 1). */
  score: number;
  /** Touch-count of the zone being reacted off — a proxy for how "key" it is. */
  zoneTouches: number;
  /** Bracket entry (the basis for realized R). */
  entry: number;
  stop: number;
  target: number;
  /** Forward outcome; `OPEN` until the horizon resolves it. */
  outcome: ShadowOutcome;
  /** Realized R multiple at resolution (signed). */
  realizedR?: number;
  /** Bars from signal bar to the resolving bar (inclusive of resolver). */
  barsToResolution?: number;
  /** ms-epoch the outcome was labelled. */
  resolvedAt?: number;
}

/** The fields needed to open a ledger row (outcome bookkeeping is added here). */
export type ReversalShadowOpen = Omit<
  ReversalShadowRecord,
  'outcome' | 'realizedR' | 'barsToResolution' | 'resolvedAt'
>;

// Append-only line shapes (discriminated by `kind`).
type OpenLine = { kind: 'open'; rec: ReversalShadowOpen };
type ResolveLine = { kind: 'resolve'; id: string; res: ShadowResolution; resolvedAt: number };
type LedgerLine = OpenLine | ResolveLine;

/** In-memory folded view: id -> latest record. */
let cache: Map<string, ReversalShadowRecord> | null = null;

function foldLine(map: Map<string, ReversalShadowRecord>, line: LedgerLine): void {
  if (line.kind === 'open') {
    if (!map.has(line.rec.id)) map.set(line.rec.id, { ...line.rec, outcome: 'OPEN' });
    return;
  }
  const existing = map.get(line.id);
  if (!existing) return;
  map.set(line.id, {
    ...existing,
    outcome: line.res.outcome,
    realizedR: line.res.realizedR,
    barsToResolution: line.res.barsToResolution,
    resolvedAt: line.resolvedAt,
  });
}

/**
 * Load the ledger and, in the same pass, APPLY {@link RETAIN_MS} — to the fold and to
 * the file. Runs once per process (the cache short-circuits every later call), and the
 * boot hook {@link initReversalShadowLedger} is its first caller, so in production this
 * IS the boot compaction.
 *
 * The cutoff keys on the record's SIGNAL time `ts`, never on `resolvedAt`: a `resolve`
 * line carries no `ts` of its own, so ageing the two line kinds independently would
 * orphan resolutions from their opens. Because a resolve can only follow its open in an
 * append-only file, one forward pass suffices — an open decides its id's fate, and a
 * resolve inherits it.
 *
 * Retained lines are written back VERBATIM, not re-serialized from the folded record.
 * The sibling ledgers rebuild sanitized lines and have twice paid for it (TRA-1703,
 * TRA-2355: a field dropped by the rewrite is not merely absent from that boot's
 * counters, it is ERASED FROM DISK). Echoing the original bytes makes a future field on
 * {@link ReversalShadowRecord} survive a compaction that predates it.
 */
async function ensureLoaded(now: number = Date.now()): Promise<Map<string, ReversalShadowRecord>> {
  if (cache) return cache;
  const map = new Map<string, ReversalShadowRecord>();
  const path = storeFile();
  const cutoff = now - RETAIN_MS;
  let linesBefore = 0;
  let recordsDropped = 0;
  let bytesBefore = 0;
  const kept: string[] = [];
  let read = false;

  if (existsSync(path)) {
    try {
      const raw = await readFile(path, 'utf-8');
      read = true;
      bytesBefore = Buffer.byteLength(raw, 'utf-8');
      // Ids the cutoff let through. A resolve line is kept iff its open was.
      const retained = new Set<string>();
      for (const rawLine of raw.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        linesBefore += 1;
        let line: LedgerLine;
        try {
          line = JSON.parse(trimmed) as LedgerLine;
        } catch {
          // Skip a single corrupt line rather than losing the whole ledger. It is also
          // dropped from the rewrite — an unparseable line folds to nothing either way.
          continue;
        }
        if (line.kind === 'open') {
          const rec = line.rec;
          if (!rec || typeof rec.id !== 'string' || typeof rec.ts !== 'number' || !Number.isFinite(rec.ts)) {
            continue;
          }
          if (rec.ts < cutoff) {
            // Aged out. Count it once, even if the file carries a duplicate open.
            if (!retained.has(rec.id)) recordsDropped += 1;
            continue;
          }
          if (map.has(rec.id)) continue; // duplicate open — the fold ignores it, so does the file
          retained.add(rec.id);
          foldLine(map, line);
          kept.push(trimmed);
          continue;
        }
        // resolve
        if (!retained.has(line.id)) continue; // its open aged out (or never existed)
        foldLine(map, line);
        kept.push(trimmed);
      }
    } catch (err) {
      log.error('failed to read reversal shadow ledger, starting empty', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Compact: rewrite to the retained lines only. Skipped when nothing aged out, so a
  // clean boot never rewrites a 50 MiB file for nothing.
  let rewrote = false;
  let error: string | undefined;
  if (read && kept.length < linesBefore) {
    try {
      const dir = dirname(path);
      if (!existsSync(dir)) await mkdir(dir, { recursive: true });
      await writeFile(path, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf-8');
      rewrote = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      log.warn('reversal shadow ledger compaction failed', { reason: error });
    }
  }

  let bytesAfter = bytesBefore;
  if (rewrote) {
    bytesAfter = await stat(path).then((s) => s.size).catch(() => bytesBefore);
  }
  lastCompaction = {
    ranAt: new Date(now).toISOString(),
    cutoff: new Date(cutoff).toISOString(),
    linesBefore,
    linesAfter: kept.length,
    recordsDropped,
    recordsAfter: map.size,
    bytesBefore,
    bytesAfter,
    rewrote,
    ...(error ? { error } : {}),
  };
  if (recordsDropped > 0 || rewrote) {
    log.info('reversal shadow ledger compacted', lastCompaction as unknown as Record<string, unknown>);
  }

  cache = map;
  return cache;
}

async function appendLine(line: LedgerLine): Promise<void> {
  const path = storeFile();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await appendFile(path, `${JSON.stringify(line)}\n`, 'utf-8');
}

/**
 * Eagerly load the ledger so reads have data right after boot — and, in the same pass,
 * apply the {@link RETAIN_MS} cutoff to disk. This is the boot compaction hook: it is
 * awaited in the server's startup chain before the signal engine ticks, so the rewrite
 * can never interleave with a live append. `now` is a test seam.
 */
export async function initReversalShadowLedger(now: number = Date.now()): Promise<void> {
  await ensureLoaded(now);
}

/**
 * Append an OPEN row for a freshly printed reversal setup. Deduped by `id`: a
 * setup that re-fires on the same bar (same symbol/side/bar) is a no-op, so a
 * per-tick shadow pass can't inflate the sample. Returns true iff a new row was
 * written.
 */
export async function recordReversalShadowSignal(open: ReversalShadowOpen): Promise<boolean> {
  const map = await ensureLoaded();
  if (map.has(open.id)) return false;
  map.set(open.id, { ...open, outcome: 'OPEN' });
  await appendLine({ kind: 'open', rec: open });
  log.info('reversal shadow ledger opened', {
    id: open.id, symbol: open.symbol, side: open.side, score: open.score,
  });
  return true;
}

/** Append a RESOLVED row, labelling a previously opened setup. No-op if unknown. */
export async function resolveReversalShadowSignal(
  id: string,
  res: ShadowResolution,
  resolvedAt: number,
): Promise<void> {
  const map = await ensureLoaded();
  const existing = map.get(id);
  if (!existing || existing.outcome !== 'OPEN') return;
  foldLine(map, { kind: 'resolve', id, res, resolvedAt });
  await appendLine({ kind: 'resolve', id, res, resolvedAt });
  log.info('reversal shadow ledger resolved', {
    id, outcome: res.outcome, realizedR: res.realizedR, bars: res.barsToResolution,
  });
}

/** Sync snapshot of rows still OPEN (empty until {@link initReversalShadowLedger}). */
export function openReversalShadowSignalsSync(): ReversalShadowRecord[] {
  if (!cache) return [];
  return [...cache.values()].filter((r) => r.outcome === 'OPEN');
}

/** Labelled ledger, ascending by signal time, optionally windowed by `ts`. */
export async function listReversalShadowSignals(
  opts: { from?: number; to?: number } = {},
): Promise<ReversalShadowRecord[]> {
  const map = await ensureLoaded();
  const { from, to } = opts;
  return [...map.values()]
    .filter((r) => (from === undefined || r.ts >= from) && (to === undefined || r.ts <= to))
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Evaluate a finished reversal checklist into the ledger-open shape, or return
 * null when there is no recordable setup. We only record a row when the bracket
 * exists (`atKeyLevel`, so entry/stop/target are non-null) — a setup with no
 * level to react off has nothing to resolve against. `entryBarTs` keys the dedup
 * so a per-tick re-fire on the same bar collapses to one row.
 */
export function buildReversalShadowOpen(
  symbol: string,
  checklist: ReversalChecklist,
  entryBarTs: number,
): ReversalShadowOpen | null {
  if (
    checklist.side === null ||
    checklist.zone === null ||
    checklist.entry === null ||
    checklist.stop === null ||
    checklist.target === null
  ) {
    return null;
  }
  return {
    id: `${symbol}:${checklist.side}:${entryBarTs}`,
    ts: entryBarTs,
    symbol,
    side: checklist.side,
    atKeyLevel: checklist.atKeyLevel,
    trendBreak: checklist.trendBreak,
    unhealthyMove: checklist.unhealthyMove,
    pattern: checklist.pattern !== null,
    patternName: checklist.pattern,
    score: checklist.score,
    zoneTouches: checklist.zone.touches,
    entry: checklist.entry,
    stop: checklist.stop,
    target: checklist.target,
  };
}

/**
 * Resolve a reversal row against the forward bars using the SAME intra-session
 * TP/SL/TIMEOUT horizon rule the Supertrend ledger uses. We synthesize the
 * minimal {@link ShadowSignalRecord} `resolveOutcome` reads (side/entryRef/
 * bracket/ts) so the rule is shared verbatim — no second, divergeable copy.
 * `long`→`buy`, `short`→`sell`.
 */
export function resolveReversalOutcome(
  rec: ReversalShadowRecord,
  bars: Candle[],
): ShadowResolution | null {
  const synthetic: ShadowSignalRecord = {
    id: rec.id,
    ts: rec.ts,
    symbol: rec.symbol,
    side: rec.side === 'long' ? 'buy' : 'sell',
    entryRef: rec.entry,
    supertrendValue: null,
    supertrendFlip: false,
    maStack: null,
    macd: null,
    rsi: null,
    stopLoss: rec.stop,
    takeProfit: rec.target,
    outcome: 'OPEN',
  };
  return resolveOutcome(synthetic, bars);
}

/** A single N-of-4 score bucket in the health breakdown. */
export interface ReversalScoreBucket {
  score: number;
  total: number;
  resolved: number;
  tpHit: number;
  slHit: number;
  timeout: number;
  /** TP_HIT / resolved — how often this score actually hit target. */
  hitRate: number | null;
  /** Mean realized R over resolved rows in the bucket. */
  avgR: number | null;
}

/**
 * Aggregate the labelled ledger into per-score hit-rate buckets — the core of
 * the TRA-920 learning question: how often do 4-of-4 vs 3-of-4 setups actually
 * hit target. `hitRate`/`avgR` are computed over RESOLVED rows only.
 */
export function reversalHitRateByScore(rows: ReversalShadowRecord[]): ReversalScoreBucket[] {
  const byScore = new Map<number, ReversalShadowRecord[]>();
  for (const r of rows) {
    const list = byScore.get(r.score) ?? [];
    list.push(r);
    byScore.set(r.score, list);
  }
  return [...byScore.keys()]
    .sort((a, b) => a - b)
    .map((score) => {
      const list = byScore.get(score) ?? [];
      const resolvedRows = list.filter((r) => r.outcome !== 'OPEN');
      const tpHit = resolvedRows.filter((r) => r.outcome === 'TP_HIT').length;
      const slHit = resolvedRows.filter((r) => r.outcome === 'SL_HIT').length;
      const timeout = resolvedRows.filter((r) => r.outcome === 'TIMEOUT').length;
      const rsResolved = resolvedRows.length;
      const avgR =
        rsResolved > 0
          ? resolvedRows.reduce((acc, r) => acc + (r.realizedR ?? 0), 0) / rsResolved
          : null;
      return {
        score,
        total: list.length,
        resolved: rsResolved,
        tpHit,
        slHit,
        timeout,
        hitRate: rsResolved > 0 ? tpHit / rsResolved : null,
        avgR,
      };
    });
}
