import { appendFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from './observability/index.js';
import { resolveDataDir } from './data-dir.js';

// TRA-1601 (TRA-1600 deliverable A/telemetry) — the maker-fill TELEMETRY ledger.
//
// The smart-open limit walk (`submitSmartBuyToOpen`) and its close-side twin
// (`submitSmartSellToClose`) route every LIVE option order as a maker chase
// (walk the limit toward the touch instead of paying the spread). Before this
// module there was no measurement of how well that routing actually performs:
// what fraction of chases fill, how far the realised fill lands from the mid we
// booked at, and how long a fill takes. This is the durable, observe-only store
// that answers those three questions per side (open / close).
//
// Shape mirrors `option-trade-journal.ts`: append-only JSONL under DATA_DIR, an
// in-memory cache, a pure `summarize` fold, and a kill-switch flag so nothing is
// written unless `ENABLE_OPTION_MAKER_TELEMETRY` is set. Recording is
// fire-and-forget at the (capital-adjacent) call sites — a telemetry write can
// never block or throw into an order path.
//
// NOTHING here routes an order or touches the broker; it only records what the
// smart-open / smart-close walk already did.

const log = logger.child({ module: 'option-maker-fill-ledger' });

/** Kill switch — the ledger writes nothing unless this is truthy. OFF by default. */
export const OPTION_MAKER_TELEMETRY_FLAG = 'ENABLE_OPTION_MAKER_TELEMETRY';

export function isOptionMakerTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[OPTION_MAKER_TELEMETRY_FLAG];
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** Which leg of the round trip produced the fill. */
export type MakerFillSide = 'open' | 'close';

/**
 * Terminal outcome of a single maker chase. `filled` is the only result that
 * carries fill metrics; the rest are recorded so the fill-RATE denominator is
 * every chase, not just the ones that filled.
 */
export type MakerFillResult = 'filled' | 'walk_exhausted' | 'rejected' | 'no_quote' | 'pending';

/**
 * One maker-chase attempt outcome. Optional metric fields are present only on a
 * `filled` result (and only when the geometry was measurable) so unmeasured
 * chases drop out of the metric means rather than dragging them toward zero.
 */
export interface MakerFillEvent {
  /** ms-epoch the chase completed. */
  ts: number;
  side: MakerFillSide;
  /** Book the order routed in — keeps demo experiments off the live rollup. */
  mode: 'demo' | 'live';
  /** OCC option symbol. */
  symbol: string;
  result: MakerFillResult;
  /** 0-indexed walk step that filled; omitted when not filled. */
  walk?: number;
  /**
   * Signed realised slippage vs the mid we booked at, in USD. POSITIVE = COST
   * (open filled above mid / close filled below mid). Omitted when the fill
   * geometry couldn't be measured (ask-only quote, no mid) or the chase didn't
   * fill.
   */
  realizedVsMidUsd?: number;
  /** ms from first submit to the terminal fill; omitted when not filled. */
  timeToFillMs?: number;
}

function defaultStoreFile(): string {
  const root = resolveDataDir();
  return join(root, 'option-maker-fills.jsonl');
}

let storeFileOverride: string | null = null;
/** Test seam — point the ledger at a temp file. Pass `null` to restore default. */
export function setOptionMakerFillFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
}
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

/** In-memory append-ordered view of the recorded events. */
let cache: MakerFillEvent[] | null = null;

async function ensureLoaded(): Promise<MakerFillEvent[]> {
  if (cache) return cache;
  const events: MakerFillEvent[] = [];
  const path = storeFile();
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, 'utf-8');
      for (const rawLine of raw.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        try {
          events.push(JSON.parse(trimmed) as MakerFillEvent);
        } catch {
          // Skip a single corrupt line rather than losing the whole ledger.
        }
      }
    } catch (err) {
      log.error('failed to read maker-fill ledger, starting empty', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  cache = events;
  return cache;
}

async function appendLine(event: MakerFillEvent): Promise<void> {
  const path = storeFile();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, 'utf-8');
}

/** Eagerly load the ledger so reads have data right after boot. */
export async function initOptionMakerFillLedger(): Promise<void> {
  await ensureLoaded();
}

/**
 * Record one maker-chase outcome. No-op (returns false) when the flag is off.
 * Non-finite metric fields are dropped so a bad measurement can never poison the
 * rollup. Returns true iff a row was written.
 */
export async function recordMakerFill(event: MakerFillEvent): Promise<boolean> {
  if (!isOptionMakerTelemetryEnabled()) return false;
  const sanitized: MakerFillEvent = {
    ts: event.ts,
    side: event.side,
    mode: event.mode,
    symbol: event.symbol,
    result: event.result,
    ...(typeof event.walk === 'number' && Number.isFinite(event.walk) ? { walk: event.walk } : {}),
    ...(typeof event.realizedVsMidUsd === 'number' && Number.isFinite(event.realizedVsMidUsd)
      ? { realizedVsMidUsd: event.realizedVsMidUsd }
      : {}),
    ...(typeof event.timeToFillMs === 'number' && Number.isFinite(event.timeToFillMs)
      ? { timeToFillMs: event.timeToFillMs }
      : {}),
  };
  const events = await ensureLoaded();
  events.push(sanitized);
  await appendLine(sanitized);
  return true;
}

export interface MakerFillFilter {
  mode?: 'demo' | 'live';
  side?: MakerFillSide;
  /** Only events at or after this ms-epoch (post-arm cohort scoping). */
  sinceTs?: number;
}

/** Read the folded event list, optionally filtered. Read-only. */
export async function listMakerFillEvents(filter: MakerFillFilter = {}): Promise<MakerFillEvent[]> {
  const events = await ensureLoaded();
  return events.filter(
    (e) =>
      (filter.mode === undefined || e.mode === filter.mode) &&
      (filter.side === undefined || e.side === filter.side) &&
      (filter.sinceTs === undefined || e.ts >= filter.sinceTs),
  );
}

/** Per-side rollup of maker-chase performance. */
export interface MakerFillSideStat {
  /** Total chases recorded for this side. */
  chases: number;
  /** Chases that reached a `filled` terminal. */
  fills: number;
  /** fills ÷ chases, 0 when no chases. */
  fillRate: number;
  /** Mean signed realised-vs-mid USD over measured fills; null when none. Positive = cost. */
  avgRealizedVsMidUsd: number | null;
  /** Mean time-to-fill ms over measured fills; null when none. */
  avgTimeToFillMs: number | null;
  /** Mean 0-indexed walk step over measured fills; null when none. */
  avgWalkStep: number | null;
}

export interface MakerFillSummary {
  /** Mirrors ENABLE_OPTION_MAKER_TELEMETRY so a reader sees whether capture is armed. */
  enabled: boolean;
  /** Total events across both sides. */
  total: number;
  open: MakerFillSideStat;
  close: MakerFillSideStat;
}

function meanOrNull(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function summarizeSide(events: MakerFillEvent[], side: MakerFillSide): MakerFillSideStat {
  const sideEvents = events.filter((e) => e.side === side);
  const fills = sideEvents.filter((e) => e.result === 'filled');
  const slips = fills
    .map((e) => e.realizedVsMidUsd)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const times = fills
    .map((e) => e.timeToFillMs)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const walks = fills
    .map((e) => e.walk)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return {
    chases: sideEvents.length,
    fills: fills.length,
    fillRate: sideEvents.length > 0 ? fills.length / sideEvents.length : 0,
    avgRealizedVsMidUsd: meanOrNull(slips),
    avgTimeToFillMs: meanOrNull(times),
    avgWalkStep: meanOrNull(walks),
  };
}

/**
 * Pure fold of the raw event list into the per-side fill-rate / realised-vs-mid
 * / time-to-fill rollup. `enabled` is threaded in (not read from env) so the
 * fold stays pure and testable.
 */
export function summarizeMakerFills(events: MakerFillEvent[], enabled: boolean): MakerFillSummary {
  return {
    enabled,
    total: events.length,
    open: summarizeSide(events, 'open'),
    close: summarizeSide(events, 'close'),
  };
}
