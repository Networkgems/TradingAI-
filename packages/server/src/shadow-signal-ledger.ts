import { readFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import type { Candle, Side } from '@trading-app/shared';
import { logger } from './observability/index.js';
import { etDateKey } from './options-chain-recorder.js';
import { resolveDataDir } from './data-dir.js';
import { appendBoundedTapeLine } from './data-tape-bounds.js';

// TRA-791 — durable SupertrendConfluence SHADOW signal -> outcome ledger.
//
// This is the dataset QuantTrader validates on TRA-789. The shadow channel
// (wired in TRA-787, commit 428c9eb) surfaces observe-only signals on
// `EngineState.supertrendShadowSignals`, but those are in-memory, capped, and
// only ever appeared as free-form `app.jsonl` log lines — there was no
// signal->outcome record to compute hit rate / R:R / false-signal rate against.
//
// This module is that record. On each NEW emitted shadow signal we append an
// immutable OPEN line; once the signal resolves over its forward horizon we
// append a RESOLVED line carrying the label (TP_HIT | SL_HIT | TIMEOUT), the
// realized R multiple on the underlying, and the bar count to resolution. The
// file is strictly append-only JSONL — reads fold by `id` keeping the latest
// line, so an OPEN row is superseded by its RESOLVED row without an in-place
// rewrite.
//
// NOTHING here touches live capital. Supertrend stays router-gated OFF pending
// the TRA-734 real-chain go/no-go; this ledger only observes and labels.

const log = logger.child({ module: 'supertrend-shadow' });

function defaultStoreFile(): string {
  const root = resolveDataDir();
  return join(root, 'shadow-signals.jsonl');
}

let storeFileOverride: string | null = null;
/** Test seam — point the ledger at a temp file. Pass `null` to restore default. */
export function setShadowLedgerFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
}
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

/** Resolved outcome label for a shadow signal over its forward horizon. */
export type ShadowOutcome = 'OPEN' | 'TP_HIT' | 'SL_HIT' | 'TIMEOUT';

/**
 * One captured shadow signal and (once resolved) its forward outcome. The
 * confluence reads are booleans the strategy used to fire; `entryRef` is the
 * underlying price at signal time, the basis every R multiple is measured from.
 */
export interface ShadowSignalRecord {
  /** Stable dedupe key: `${symbol}:${side}:${entryBarTs}` (one row per 5m bar). */
  id: string;
  /** ms-epoch the signal fired. */
  ts: number;
  symbol: string;
  side: Side;
  /** Underlying price at signal time — the basis for realized R. */
  entryRef: number;
  /** Raw Supertrend line value on the signal bar (null if undefined). */
  supertrendValue: number | null;
  /** Did the Supertrend direction just flip on the signal bar? */
  supertrendFlip: boolean;
  /** Confluence booleans — the RAW per-component reads for the Supertrend-implied
   *  side (TRA-840), recorded independent of the emit gate so they carry variance. */
  maStack: boolean | null;
  macd: boolean | null;
  rsi: boolean | null;
  /**
   * TRA-840 — true iff all confluence gates passed (a routable emit); false for a
   * near-miss candidate captured only so attribution has a false-subset. Optional
   * for backward compatibility: pre-TRA-840 rows lack it and are treated as emits
   * (and trigger the one-time re-baseline below).
   */
  emitted?: boolean;
  stopLoss: number;
  takeProfit: number;
  /** Forward outcome; `OPEN` until the horizon resolves it. */
  outcome: ShadowOutcome;
  /** Realized R multiple on the underlying at resolution (signed). */
  realizedR?: number;
  /** 5m bars from signal bar to the resolving bar (inclusive of resolver). */
  barsToResolution?: number;
  /** ms-epoch the outcome was labelled. */
  resolvedAt?: number;
}

/** The fields needed to open a ledger row (outcome bookkeeping is added here). */
export type ShadowSignalOpen = Omit<
  ShadowSignalRecord,
  'outcome' | 'realizedR' | 'barsToResolution' | 'resolvedAt'
>;

/** A resolution result for an open row. */
export interface ShadowResolution {
  outcome: Exclude<ShadowOutcome, 'OPEN'>;
  realizedR: number;
  barsToResolution: number;
}

// Append-only line shapes (discriminated by `kind`).
type OpenLine = { kind: 'open'; rec: ShadowSignalOpen };
type ResolveLine = { kind: 'resolve'; id: string; res: ShadowResolution; resolvedAt: number };
type LedgerLine = OpenLine | ResolveLine;

/** In-memory folded view: id -> latest record. */
let cache: Map<string, ShadowSignalRecord> | null = null;

function foldLine(map: Map<string, ShadowSignalRecord>, line: LedgerLine): void {
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

async function ensureLoaded(): Promise<Map<string, ShadowSignalRecord>> {
  if (cache) return cache;
  const map = new Map<string, ShadowSignalRecord>();
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
      log.error('failed to read shadow ledger, starting empty', {
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
  await appendBoundedTapeLine(path, `${JSON.stringify(line)}\n`);
}

/**
 * TRA-840 — one-time ledger re-baseline. Every row produced before the
 * SupertrendConfluence generator fixes (seed-pinned confirm + tautological
 * booleans, TRA-809) is contaminated and must NOT feed the TRA-734 go/no-go.
 * Pre-fix rows are detectable by the absence of the `emitted` field. On the first
 * boot after the fix lands we archive the whole file and start a fresh capture;
 * the heuristic is idempotent (fresh rows all carry `emitted`, so later boots are
 * no-ops). Operates on whatever DATA_DIR file exists, so it re-baselines the live
 * Render ledger automatically on deploy.
 */
async function rebaselineIfLegacy(): Promise<void> {
  if (!cache || cache.size === 0) return;
  const hasLegacy = [...cache.values()].some((r) => r.emitted === undefined);
  if (!hasLegacy) return;
  const path = storeFile();
  if (existsSync(path)) {
    const archive = `${path}.pre-tra840.${Date.now()}.jsonl`;
    try {
      await rename(path, archive);
      log.info('shadow ledger re-baselined (TRA-840): archived contaminated pre-fix rows', {
        archive, rows: cache.size,
      });
    } catch (err) {
      log.error('shadow ledger re-baseline rename failed; keeping contaminated rows', {
        reason: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }
  cache = new Map();
}

/** Eagerly load the ledger so reads have data right after boot. */
export async function initShadowLedger(): Promise<void> {
  await ensureLoaded();
  await rebaselineIfLegacy();
}

/**
 * Append an OPEN row for a freshly emitted shadow signal. Deduped by `id`: a
 * signal that re-fires on the same 5m bar (same symbol/side/bar) is a no-op, so
 * a per-tick shadow pass can't inflate the sample. Returns true iff a new row
 * was written.
 */
export async function recordShadowSignal(open: ShadowSignalOpen): Promise<boolean> {
  const map = await ensureLoaded();
  if (map.has(open.id)) return false;
  map.set(open.id, { ...open, outcome: 'OPEN' });
  await appendLine({ kind: 'open', rec: open });
  log.info('shadow ledger opened', { id: open.id, symbol: open.symbol, side: open.side });
  return true;
}

/** Append a RESOLVED row, labelling a previously opened signal. No-op if unknown. */
export async function resolveShadowSignal(
  id: string,
  res: ShadowResolution,
  resolvedAt: number,
): Promise<void> {
  const map = await ensureLoaded();
  const existing = map.get(id);
  if (!existing || existing.outcome !== 'OPEN') return;
  foldLine(map, { kind: 'resolve', id, res, resolvedAt });
  await appendLine({ kind: 'resolve', id, res, resolvedAt });
  log.info('shadow ledger resolved', {
    id, outcome: res.outcome, realizedR: res.realizedR, bars: res.barsToResolution,
  });
}

/** Sync snapshot of rows still OPEN (empty until {@link initShadowLedger}). */
export function openShadowSignalsSync(): ShadowSignalRecord[] {
  if (!cache) return [];
  return [...cache.values()].filter((r) => r.outcome === 'OPEN');
}

/**
 * Labelled ledger, ascending by signal time, optionally windowed by signal `ts`
 * (`from`/`to` are ms-epoch inclusive bounds).
 */
export async function listShadowSignals(
  opts: { from?: number; to?: number } = {},
): Promise<ShadowSignalRecord[]> {
  const map = await ensureLoaded();
  const { from, to } = opts;
  return [...map.values()]
    .filter((r) => (from === undefined || r.ts >= from) && (to === undefined || r.ts <= to))
    .sort((a, b) => a.ts - b.ts);
}

/** Default forward-horizon cap: a US RTH session is ~78 5m bars. */
export const SHADOW_HORIZON_BARS = 78;

/**
 * Resolve a single open signal against the forward 5m bars, or return null if it
 * is still open (no TP/SL touch and the horizon has not closed yet).
 *
 * Horizon rule (default; the exact spec defers to the TRA-789 shadow-validation
 * protocol): walk bars strictly after the signal bar within the SAME ET session.
 * - TP_HIT  — a bar trades through `takeProfit`.
 * - SL_HIT  — a bar trades through `stopLoss`.
 * - TIMEOUT — the session closes (next bar is a new ET date) or {@link
 *   SHADOW_HORIZON_BARS} bars elapse without a touch; marked at the last in-
 *   session bar's close.
 * When a single bar straddles BOTH stop and target we resolve pessimistically
 * to SL_HIT (worst case), the standard no-look-ahead backtest convention.
 *
 * `realizedR` is signed and measured on the underlying from `entryRef`, with the
 * risk leg `|entryRef - stopLoss|` as the denominator (so SL_HIT is exactly -1R).
 */
export function resolveOutcome(
  rec: ShadowSignalRecord,
  bars: Candle[],
  sessionKey: (ts: number) => string = etDateKey,
): ShadowResolution | null {
  const risk = Math.abs(rec.entryRef - rec.stopLoss);
  if (!(risk > 0)) return null;
  const long = rec.side === 'buy';
  const entrySession = sessionKey(rec.ts);
  // Bars strictly after the signal bar, ascending.
  const future = bars
    .filter((b) => b.timestamp > rec.ts)
    .sort((a, b) => a.timestamp - b.timestamp);

  let lastInSession: Candle | null = null;
  for (let i = 0; i < future.length && i < SHADOW_HORIZON_BARS; i++) {
    const bar = future[i];
    if (!bar) continue;
    if (sessionKey(bar.timestamp) !== entrySession) break; // session closed
    lastInSession = bar;
    const bars1 = i + 1;
    const hitStop = long ? bar.low <= rec.stopLoss : bar.high >= rec.stopLoss;
    const hitTarget = long ? bar.high >= rec.takeProfit : bar.low <= rec.takeProfit;
    if (hitStop) {
      return { outcome: 'SL_HIT', realizedR: -1, barsToResolution: bars1 };
    }
    if (hitTarget) {
      const reward = Math.abs(rec.takeProfit - rec.entryRef);
      return { outcome: 'TP_HIT', realizedR: reward / risk, barsToResolution: bars1 };
    }
  }

  // No touch. Resolve TIMEOUT only once the session has closed (we saw a later
  // session) or the horizon cap is hit; otherwise the signal is still live.
  const sawNextSession =
    future.some((b) => sessionKey(b.timestamp) !== entrySession) ||
    future.length >= SHADOW_HORIZON_BARS;
  if (!sawNextSession || !lastInSession) return null;

  const exit = lastInSession.close;
  const signed = long ? exit - rec.entryRef : rec.entryRef - exit;
  const barsToResolution = future.indexOf(lastInSession) + 1;
  return { outcome: 'TIMEOUT', realizedR: signed / risk, barsToResolution };
}
