import { appendFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { Candle } from '@trading-app/shared';
import type { CandlePattern, ReversalChecklist } from '@trading-app/engine';
import { logger } from './observability/index.js';
import {
  resolveOutcome,
  type ShadowOutcome,
  type ShadowResolution,
  type ShadowSignalRecord,
} from './shadow-signal-ledger.js';

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

const __dirname = dirname(fileURLToPath(import.meta.url));

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

function defaultStoreFile(): string {
  const root = process.env['DATA_DIR'] ?? join(__dirname, '..', 'data');
  return join(root, 'reversal-shadow-signals.jsonl');
}

let storeFileOverride: string | null = null;
/** Test seam — point the ledger at a temp file. Pass `null` to restore default. */
export function setReversalShadowLedgerFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
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

async function ensureLoaded(): Promise<Map<string, ReversalShadowRecord>> {
  if (cache) return cache;
  const map = new Map<string, ReversalShadowRecord>();
  const path = storeFile();
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, 'utf-8');
      for (const rawLine of raw.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        try {
          foldLine(map, JSON.parse(trimmed) as LedgerLine);
        } catch {
          // Skip a single corrupt line rather than losing the whole ledger.
        }
      }
    } catch (err) {
      log.error('failed to read reversal shadow ledger, starting empty', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
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

/** Eagerly load the ledger so reads have data right after boot. */
export async function initReversalShadowLedger(): Promise<void> {
  await ensureLoaded();
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
