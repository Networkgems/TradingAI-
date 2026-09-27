import { readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import {
  classifyOiQuadrant,
  type OiTotals,
  type OiQuadrant,
  type OiConviction,
  type DeltaDirection,
} from '@trading-app/engine';
import { logger } from './observability/index.js';
import { etDateKey } from './options-chain-recorder.js';
import type { PcrTrioVerdict } from './pcr-shadow-ledger.js';
import { resolveDataDir } from './data-dir.js';
import { appendBoundedTapeLine } from './data-tape-bounds.js';

// TRA-1610 (parent TRA-1607) — durable, flag-gated SHADOW Open-Interest-trend
// ledger.
//
// The engine's `computeOiTotals` + `classifyOiQuadrant` (oi-trend.ts) are the
// pure folds: Σ OI across the tracked expiries, and the price×OI 4-quadrant read
// from the session-over-session deltas. This module is the server seam that
// (a) reads the feature flag, (b) maintains the per-underlying prior-session
// snapshot the deltas need, and (c) appends well-formed observations to an
// append-only JSONL ledger. NOTHING here routes an order, touches sizing, or
// influences an exit — it is observe-only, $0 live.
//
// This is the dataset QuantTrader validates on the TRA-532 promotion gate: the
// OI-quadrant conviction filter is promoted only after a ≥200-signal shadow
// window shows it improves expectancy vs. the current 21EMA+RSI+Vol trio alone.
// Each row is therefore stamped with the paired trio verdict at capture time so
// the incremental attribution can be measured cleanly.
//
// CADENCE: deduped to ONE row per underlying per ET session. OCC open interest
// updates once daily (a prior-close figure), so a per-tick re-capture would add
// nothing and would corrupt the session-over-session delta basis. The first
// snapshot of each session for an underlying is the recorded one; later ticks
// that session are no-ops. `oiDelta`/`priceDelta` are computed against the most
// recent PRIOR session's row, keeping both legs of the quadrant on the same
// daily cadence. `oiAsOf` stamps the session the OI figure belongs to so a stale
// value isn't over-weighted.

const log = logger.child({ module: 'oi-shadow-ledger' });

/**
 * Phase-1 kill switch. Off by default so a deploy can't start writing OI shadow
 * rows without an explicit operator opt-in. Independent of the PCR/option-shadow
 * flags, but the per-tick capture rides inside the existing option-shadow chain
 * pass (warm chain, zero extra Tradier fetch), so in practice it's armed
 * alongside them in the shadow window.
 */
export const OI_SHADOW_FLAG = 'ENABLE_OI_SHADOW';

export function isOiShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[OI_SHADOW_FLAG];
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** What the caller hands the ledger for one capture. */
export interface OiObservationInput {
  underlying: string;
  /** ms-epoch of the capture. */
  asof: number;
  /** The pure fold from `computeOiTotals`. */
  oi: OiTotals;
  /**
   * Underlying close (or last bar close) at capture — the price leg. null when
   * unavailable; then `priceDelta` and the quadrant can't be computed.
   */
  underlyingClose: number | null;
  /** The paired 21EMA+RSI+Vol trio verdict (null when no directional side). */
  trio: PcrTrioVerdict | null;
}

/** One persisted OI-trend shadow observation. */
export interface OiShadowRecord {
  /** Stable dedupe key: `${underlying}:${session}`. */
  id: string;
  /** ET trading day (YYYY-MM-DD) the observation belongs to. */
  session: string;
  underlying: string;
  /** ms-epoch of capture. */
  asof: number;
  /**
   * The session the OI figure belongs to (ET date). OCC OI is a prior-close
   * daily read, so this equals `session` at capture but is recorded explicitly
   * so a downstream reader treats the value as a slow daily read, not intraday.
   */
  oiAsOf: string;
  /** Σ OI across the tracked expiries. null when the chain OI was untrustworthy. */
  oiTotal: number | null;
  callOpenInterest: number;
  putOpenInterest: number;
  contractsWithOi: number;
  /** Underlying close at capture — the price leg. */
  underlyingClose: number | null;
  /** The prior session (YYYY-MM-DD) the deltas were computed against; null on the first. */
  priorSession: string | null;
  /** oiTotal − prior session oiTotal. null on the first session or when a leg is null. */
  oiDelta: number | null;
  /** underlyingClose − prior session close. null on the first session or when a leg is null. */
  priceDelta: number | null;
  /** The article's 4-quadrant read; null until a prior snapshot exists / on a flat leg. */
  quadrant: OiQuadrant | null;
  priceDirection: DeltaDirection | null;
  oiDirection: DeltaDirection | null;
  /** Conviction mapped from the quadrant; null when the quadrant is null. */
  conviction: OiConviction | null;
  /** Distinct expirations that fed the OI total (ascending). */
  expiriesUsed: string[];
  /** True when the chain carried no usable OI (ratio fields nulled). */
  insufficientData: boolean;
  /** Why the OI total / quadrant is null, when applicable. */
  reason: string | null;
  /** The paired 21EMA+RSI+Vol trio verdict at capture time. */
  trio: PcrTrioVerdict | null;
}

function defaultStoreFile(): string {
  const root = resolveDataDir();
  return join(root, 'oi-shadow-signals.jsonl');
}

let storeFileOverride: string | null = null;
/** Test seam — point the ledger at a temp file. Pass `null` to restore default. */
export function setOiShadowLedgerFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
}
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

/** In-memory folded view: id -> record (append-only file, latest line wins). */
let cache: Map<string, OiShadowRecord> | null = null;

async function ensureLoaded(): Promise<Map<string, OiShadowRecord>> {
  if (cache) return cache;
  const map = new Map<string, OiShadowRecord>();
  const path = storeFile();
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, 'utf-8');
      for (const rawLine of raw.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed) as OiShadowRecord;
          if (rec && typeof rec.id === 'string') map.set(rec.id, rec);
        } catch {
          // Skip a single corrupt line rather than losing the whole ledger.
        }
      }
    } catch (err) {
      log.error('failed to read oi shadow ledger, starting empty', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  cache = map;
  return cache;
}

/** Eagerly load the ledger so reads have data right after boot. */
export async function initOiShadowLedger(): Promise<void> {
  await ensureLoaded();
}

async function appendRecord(rec: OiShadowRecord): Promise<void> {
  const path = storeFile();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await appendBoundedTapeLine(path, `${JSON.stringify(rec)}\n`);
}

/**
 * The most recent PRIOR-session record for `underlying` carrying a usable
 * `oiTotal`, STRICTLY before `beforeSession`. An illiquid session (null oiTotal)
 * is skipped so it doesn't become a hole in the delta basis. Returns null when
 * there's no usable prior session yet.
 */
function priorSessionRecord(
  map: Map<string, OiShadowRecord>,
  underlying: string,
  beforeSession: string,
): OiShadowRecord | null {
  const candidates = [...map.values()]
    .filter(
      (r) =>
        r.underlying === underlying &&
        r.session < beforeSession &&
        typeof r.oiTotal === 'number',
    )
    .sort((a, b) => a.session.localeCompare(b.session));
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

/** Result of a capture attempt. */
export interface OiRecordResult {
  written: boolean;
  /** Why nothing was written, when `written` is false. */
  reason?: 'flag_off' | 'duplicate';
  /** The record (the newly-written one, or the pre-existing row on a duplicate). */
  record?: OiShadowRecord;
}

/**
 * Capture one OI-trend observation into the shadow ledger. Flag-gated and
 * deduped to one row per underlying per ET session (see module header). Computes
 * the session-over-session `oiDelta`/`priceDelta` against the most recent prior
 * session, classifies the price×OI quadrant, and stamps the paired trio verdict
 * plus `oiAsOf`. NEVER routes an order. Returns whether a new row was written.
 */
export async function recordOiObservation(obs: OiObservationInput): Promise<OiRecordResult> {
  if (!isOiShadowEnabled()) return { written: false, reason: 'flag_off' };

  const map = await ensureLoaded();
  const session = etDateKey(obs.asof);
  const id = `${obs.underlying}:${session}`;
  const existing = map.get(id);
  if (existing) return { written: false, reason: 'duplicate', record: existing };

  const oiTotal = obs.oi.oiTotal;
  const prior = priorSessionRecord(map, obs.underlying, session);

  const oiDelta =
    oiTotal !== null && prior && typeof prior.oiTotal === 'number' ? oiTotal - prior.oiTotal : null;
  const priceDelta =
    obs.underlyingClose !== null && prior && typeof prior.underlyingClose === 'number'
      ? obs.underlyingClose - prior.underlyingClose
      : null;

  const q = classifyOiQuadrant(priceDelta, oiDelta);

  const rec: OiShadowRecord = {
    id,
    session,
    underlying: obs.underlying,
    asof: obs.asof,
    oiAsOf: session,
    oiTotal,
    callOpenInterest: obs.oi.callOpenInterest,
    putOpenInterest: obs.oi.putOpenInterest,
    contractsWithOi: obs.oi.contractsWithOi,
    underlyingClose: obs.underlyingClose,
    priorSession: prior?.session ?? null,
    oiDelta,
    priceDelta,
    quadrant: q.quadrant,
    priceDirection: q.priceDirection,
    oiDirection: q.oiDirection,
    conviction: q.conviction,
    expiriesUsed: obs.oi.expiriesUsed,
    insufficientData: obs.oi.insufficientData,
    // Prefer the engine's OI reason (illiquid chain) over the quadrant reason
    // (no prior / flat leg) — a nulled OI is the more fundamental gap.
    reason: obs.oi.reason ?? q.reason,
    trio: obs.trio,
  };
  map.set(id, rec);
  await appendRecord(rec);
  log.info('oi shadow observation recorded', {
    id,
    oiTotal,
    oiDelta,
    priceDelta,
    quadrant: rec.quadrant,
    conviction: rec.conviction,
    insufficientData: rec.insufficientData,
  });
  return { written: true, record: rec };
}

/** All persisted OI shadow observations, ascending by capture time. */
export async function listOiShadowSignals(): Promise<OiShadowRecord[]> {
  const map = await ensureLoaded();
  return [...map.values()].sort((a, b) => a.asof - b.asof);
}

/**
 * Count of rows carrying a usable quadrant read (non-null `quadrant`) — the
 * promotion denominator for QuantTrader's ≥200-signal shadow-window check. Rows
 * on the first session, on a flat leg, or nulled for illiquidity carry no
 * directional read and don't count toward the window.
 */
export function usableSignalCount(records: readonly OiShadowRecord[]): number {
  return records.filter((r) => r.quadrant !== null).length;
}
