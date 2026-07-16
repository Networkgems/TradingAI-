// TRA-1929 (parent TRA-1916) — DURABLE per-trade fee + slippage ledger for the
// bounded 2-day real-money options test.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The board authorized a bounded real-money options test on the live Tradier
// Production account to harvest live FEE + SLIPPAGE calibration data before the
// August go-live gate ("track Tradier fees and slippage per trade"). Every real
// fill (open AND close) writes one row here so the board and LeadDev can read the
// calibration data at `GET /api/health/live-options-fee-slippage` WITHOUT shell
// access to the box.
//
// ── THE DURABILITY CAVEAT THAT IS NOT OPTIONAL (TRA-1681 / TRA-1719) ──────────
// "A persisted file survives a reboot" is TRUE only if DATA_DIR points at a mounted
// persistent disk. With DATA_DIR unset the caller falls back to a path INSIDE the
// build bundle (`index.ts`: `process.env.DATA_DIR ?? join(__dirname,'..','data')`)
// — a real, writable directory whose bytes still evaporate on the next redeploy.
// There is NO error to catch; the only discriminator is the PATH. So
// `durability.ephemeral` (a property of the path, decisive on the very first boot
// before a single row exists) is published in the read payload and MUST be read
// FIRST: `ephemeral: true` ⇒ these records die on the next redeploy and the
// calibration is NOT durably captured — the fix is `DATA_DIR=/data` on bqb1
// (TRA-1719), not code.
//
// ── SCOPE / INVARIANT ────────────────────────────────────────────────────────
// Observe-only telemetry. NEVER places an order or mutates an account — it is a
// write-through of a fill the broker mirror ALREADY executed. `mode` is always
// 'live' (the demo book pays a MODELLED cost, not a real one, so it has nothing to
// calibrate). Unmeasured numeric fields are `null`, NEVER `0` (TRA-1707: a `0`
// slippage/fee reads as "measured, and it was zero" — a false datapoint that would
// bias the mean the board reads; `null` reads as "not measured").

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { isEphemeralDataDir } from './data-dir.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'live-options-fee-slippage-ledger' });

export const LIVE_OPTIONS_FEE_SLIPPAGE_LOG_FILENAME = 'live-options-fee-slippage.jsonl';

/**
 * Retain this many ms of fill records on disk (compacted on boot). The bounded
 * test runs ~2 days; 30 days comfortably covers reading the calibration back well
 * after the window closes while bounding a file that takes a handful of lines per
 * trade.
 */
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

/** Which automated sleeve fired the fill. */
export type LiveFillSleeve = 'single_leg_rv' | 'single_leg_otm' | 'directional';

/** Order side of the fill. */
export type LiveFillSide = 'buy_to_open' | 'sell_to_close';

/**
 * One real Tradier fill, open or close. Every price is per-contract (per-share ×
 * 1). Slippage is signed in the direction of cost: for a BUY, `filled − ask` > 0
 * means we paid up through the ask; for a SELL it is `filled − ask` in the same
 * raw arithmetic (a grader reads the sign against `side`). Unmeasured fields are
 * `null` (see the file header on why never `0`).
 */
export interface LiveOptionFillRecord {
  /** Always 'live' — the demo book has no real fee/slippage to calibrate. */
  mode: 'live';
  /** Fill time, ms epoch. */
  ts: number;
  /** ET calendar day (America/New_York, YYYY-MM-DD). */
  etDay: string;
  /** Automated sleeve that fired the fill. */
  sleeve: LiveFillSleeve;
  /** OCC option symbol. */
  optionSymbol: string;
  /** Order side. */
  side: LiveFillSide;
  /** Contracts filled. */
  contracts: number;
  /** The limit price we submitted at (null when unknown, e.g. a market exit). */
  submittedLimit: number | null;
  /** Ask at submit (null when the quote had no usable ask, e.g. a one-sided close). */
  askAtSubmit: number | null;
  /** Midpoint at submit (null on a one-sided/ask-only quote — cannot triangulate). */
  midAtSubmit: number | null;
  /** Broker average fill price (null only if the broker omitted it AND no limit fallback). */
  filledPrice: number | null;
  /**
   * Tradier commission / fees for this fill, USD. `null` at fill time — the
   * order-status payload does NOT carry commission; it is only on the account
   * HISTORY endpoint (`TradierTradeHistoryFill.commission`). A follow-up reconcile
   * pass back-fills it; until then it is honestly UNMEASURED (never 0). (TRA-1929)
   */
  fees: number | null;
  /** `filledPrice − askAtSubmit` (per contract), null when either side is null. */
  slippageVsAsk: number | null;
  /** `filledPrice − midAtSubmit` (per contract), null when either side is null. */
  slippageVsMid: number | null;
  /** Broker order id, when known. */
  orderId: number | null;
}

/** The mutable inputs a caller hands {@link recordLiveOptionFill}; the module fills ts/etDay/derived slippage. */
export interface LiveOptionFillInput {
  ts: number;
  etDay: string;
  sleeve: LiveFillSleeve;
  optionSymbol: string;
  side: LiveFillSide;
  contracts: number;
  submittedLimit?: number | null;
  askAtSubmit?: number | null;
  midAtSubmit?: number | null;
  filledPrice?: number | null;
  fees?: number | null;
  orderId?: number | null;
}

// ── In-memory store (backs the durable records + the health endpoint) ─────────
//
// Module-global + observe-only. `dataDir` is set once at boot by
// hydrateLiveOptionsFeeSlippageFromDisk so the engine chokepoints can append
// without threading a path through the SignalEngine.

let dataDir: string | null = null;
/** All retained fills, oldest-first as read/appended. */
const fills: LiveOptionFillRecord[] = [];
let lastRecordAt: number | null = null;
// TRA-1681 — durability provenance.
let hydratedRecords = 0;
let appendErrors = 0;
let lastAppendError: string | null = null;

export function liveOptionsFeeSlippageLogPath(dir: string): string {
  return join(dir, LIVE_OPTIONS_FEE_SLIPPAGE_LOG_FILENAME);
}

/** Test seam — drop every record and the configured dir. */
export function clearLiveOptionsFeeSlippageLedger(): void {
  dataDir = null;
  fills.length = 0;
  lastRecordAt = null;
  hydratedRecords = 0;
  appendErrors = 0;
  lastAppendError = null;
}

function finiteOrNull(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Build a fully-derived record from a caller input (shared by record + a hydrate re-derive). */
function toRecord(input: LiveOptionFillInput): LiveOptionFillRecord {
  const filledPrice = finiteOrNull(input.filledPrice);
  const askAtSubmit = finiteOrNull(input.askAtSubmit);
  const midAtSubmit = finiteOrNull(input.midAtSubmit);
  return {
    mode: 'live',
    ts: input.ts,
    etDay: input.etDay,
    sleeve: input.sleeve,
    optionSymbol: input.optionSymbol,
    side: input.side,
    contracts: input.contracts,
    submittedLimit: finiteOrNull(input.submittedLimit),
    askAtSubmit,
    midAtSubmit,
    filledPrice,
    fees: finiteOrNull(input.fees),
    // Derived slippage — null unless BOTH legs are measured (TRA-1707: never 0-as-unknown).
    slippageVsAsk: filledPrice !== null && askAtSubmit !== null ? filledPrice - askAtSubmit : null,
    slippageVsMid: filledPrice !== null && midAtSubmit !== null ? filledPrice - midAtSubmit : null,
    orderId: input.orderId ?? null,
  };
}

/**
 * Record one real live option fill (open or close) against the in-memory store AND
 * append one JSONL line under the configured DATA_DIR. Best-effort on IO — a write
 * failure logs, is COUNTED (so the swallow is never silent), and is swallowed so
 * this accounting can never break the trade pass. When no dataDir is configured
 * (unit tests / CLI without boot) the in-memory record still updates; only the file
 * write is skipped.
 */
export function recordLiveOptionFill(input: LiveOptionFillInput): void {
  const rec = toRecord(input);
  fills.push(rec);
  lastRecordAt = rec.ts;
  if (dataDir == null) return;

  const path = liveOptionsFeeSlippageLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    // Swallowed so the trade pass survives — but COUNTED, so the swallow is not silent.
    appendErrors += 1;
    lastAppendError = err instanceof Error ? err.message : String(err);
    log.warn('live-options-fee-slippage append failed', { reason: lastAppendError });
  }
}

/** What {@link hydrateLiveOptionsFeeSlippageFromDisk} recovered (for the boot log line). */
export interface LiveOptionsFeeSlippageHydration {
  records: number;
}

function isSleeve(v: unknown): v is LiveFillSleeve {
  return v === 'single_leg_rv' || v === 'single_leg_otm' || v === 'directional';
}
function isSide(v: unknown): v is LiveFillSide {
  return v === 'buy_to_open' || v === 'sell_to_close';
}

/**
 * Rebuild the in-memory records from disk on boot and remember `dir` for subsequent
 * appends. Idempotent: CLEARS first, so it is safe to call exactly once at startup
 * before any live pass. Only records within {@link RETAIN_MS} of `now` are kept, and
 * the file is COMPACTED to exactly those lines (bounding growth). Best-effort: a
 * missing/corrupt file yields an empty hydration; a torn trailing line is skipped
 * rather than throwing.
 */
export function hydrateLiveOptionsFeeSlippageFromDisk(
  dir: string,
  now: number = Date.now(),
): LiveOptionsFeeSlippageHydration {
  clearLiveOptionsFeeSlippageLedger();
  dataDir = dir;

  let raw = '';
  try {
    raw = readFileSync(liveOptionsFeeSlippageLogPath(dir), 'utf8');
  } catch {
    raw = '';
  }

  const cutoff = now - RETAIN_MS;
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let rec: LiveOptionFillRecord;
    try {
      rec = JSON.parse(trimmed) as LiveOptionFillRecord;
    } catch {
      continue; // skip a torn/partial line rather than abort the hydrate
    }
    if (typeof rec.ts !== 'number' || !Number.isFinite(rec.ts) || rec.ts < cutoff) continue;
    if (typeof rec.etDay !== 'string' || rec.etDay === '') continue;
    if (!isSleeve(rec.sleeve) || !isSide(rec.side)) continue;
    if (typeof rec.optionSymbol !== 'string' || rec.optionSymbol === '') continue;
    // Re-derive through toRecord so the disk copy and a live record are byte-identical
    // in shape and the slippage invariants hold even if an old line was hand-edited.
    const clean = toRecord({
      ts: rec.ts,
      etDay: rec.etDay,
      sleeve: rec.sleeve,
      optionSymbol: rec.optionSymbol,
      side: rec.side,
      contracts: typeof rec.contracts === 'number' && Number.isFinite(rec.contracts) ? rec.contracts : 0,
      submittedLimit: rec.submittedLimit,
      askAtSubmit: rec.askAtSubmit,
      midAtSubmit: rec.midAtSubmit,
      filledPrice: rec.filledPrice,
      fees: rec.fees,
      orderId: rec.orderId,
    });
    fills.push(clean);
    kept.push(JSON.stringify(clean));
    if (clean.ts > (lastRecordAt ?? 0)) lastRecordAt = clean.ts;
  }

  // Compact: rewrite the file to the retained lines only (best-effort). Skipped when
  // there is nothing to drop, to avoid a needless rewrite on every clean boot.
  const nonEmptyLines = raw.split('\n').filter((l) => l.trim() !== '').length;
  if (kept.length < nonEmptyLines) {
    const path = liveOptionsFeeSlippageLogPath(dir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8');
    } catch (err) {
      log.warn('live-options-fee-slippage compaction failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  hydratedRecords = kept.length;
  return { records: kept.length };
}

// ── Health summary ───────────────────────────────────────────────────────────

/** TRA-1681 — is anything this module reports actually ON DISK? Read `ephemeral` FIRST. */
export interface LiveOptionsFeeSlippageDurability {
  /** Resolved append target. `null` = memory-only: no boot hydrate ran, NOTHING is durable. */
  dataDir: string | null;
  /**
   * TRUE ⇒ every record in this payload dies on the next redeploy. The calibration is
   * NOT durably captured — the fix is `DATA_DIR=/data` on bqb1 (TRA-1719), not code.
   */
  ephemeral: boolean;
  /** Records recovered FROM DISK at boot. Distinguishes a real ledger from this-uptime-only. */
  hydratedRecords: number;
  /** Appends that threw and were SWALLOWED. > 0 ⇒ the counts above overstate disk. */
  appendErrors: number;
  /** Message from the most recent swallowed append (null when none). */
  lastAppendError: string | null;
}

/** Mean/median of the measured (non-null) values, or null when none measured. */
function stats(values: number[]): { n: number; mean: number | null; median: number | null } {
  if (values.length === 0) return { n: 0, mean: null, median: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { n: sorted.length, mean, median };
}

function round(n: number | null, dp = 4): number | null {
  if (n === null) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export interface SlippageSummary {
  /** Count of fills with a MEASURED slippage-vs-ask (denominator is measured, not total). */
  nMeasured: number;
  meanVsAsk: number | null;
  medianVsAsk: number | null;
  meanVsMid: number | null;
  medianVsMid: number | null;
}

export interface LiveOptionsFeeSlippageSummary {
  /** Total fills recorded (open + close, live + hydrated). */
  n: number;
  /** Fills split by side. */
  opens: number;
  closes: number;
  /** Slippage summary over all fills (measured legs only). */
  slippage: SlippageSummary;
  /**
   * Total measured Tradier fees, USD, and how many fills had a measured (non-null)
   * fee. `feesMeasured < n` ⇒ some fills' commission is not yet back-filled — do NOT
   * read `totalFees` as complete (TRA-1929 fee reconcile is a follow-up).
   */
  totalFees: number | null;
  feesMeasured: number;
  /** How many days back the ledger retains. */
  retentionDays: number;
  /** TRA-1681 — whether ANY of the above survives a reboot. Check BEFORE trusting a count. */
  durability: LiveOptionsFeeSlippageDurability;
  /** ms epoch of the last recorded fill (null if none yet). */
  lastRecordAt: number | null;
  /** The full record set, most-recent first. */
  records: LiveOptionFillRecord[];
}

/**
 * Fold the store into the read-only fee/slippage calibration diagnostics. Pure — no
 * IO. Records are returned most-recent first. Read `durability.ephemeral` FIRST: if
 * true, every record below is wiped at the next reboot and the calibration is not
 * durably captured (TRA-1719).
 */
export function summarizeLiveOptionsFeeSlippage(): LiveOptionsFeeSlippageSummary {
  const vsAsk: number[] = [];
  const vsMid: number[] = [];
  const feeValues: number[] = [];
  let opens = 0;
  let closes = 0;
  for (const f of fills) {
    if (f.side === 'buy_to_open') opens += 1;
    else closes += 1;
    if (f.slippageVsAsk !== null) vsAsk.push(f.slippageVsAsk);
    if (f.slippageVsMid !== null) vsMid.push(f.slippageVsMid);
    if (f.fees !== null) feeValues.push(f.fees);
  }
  const askStats = stats(vsAsk);
  const midStats = stats(vsMid);
  const records = [...fills].sort((a, b) => b.ts - a.ts);
  return {
    n: fills.length,
    opens,
    closes,
    slippage: {
      nMeasured: askStats.n,
      meanVsAsk: round(askStats.mean),
      medianVsAsk: round(askStats.median),
      meanVsMid: round(midStats.mean),
      medianVsMid: round(midStats.median),
    },
    totalFees: feeValues.length > 0 ? round(feeValues.reduce((s, v) => s + v, 0), 2) : null,
    feesMeasured: feeValues.length,
    retentionDays: RETAIN_MS / (24 * 60 * 60 * 1000),
    durability: {
      dataDir,
      ephemeral: isEphemeralDataDir(dataDir),
      hydratedRecords,
      appendErrors,
      lastAppendError,
    },
    lastRecordAt,
    records,
  };
}
