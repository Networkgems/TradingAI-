import { appendFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { pcrZScore, type PutCallRatio, type PcrRegime, type PcrContrarian } from '@trading-app/engine';
import { logger } from './observability/index.js';
import { etDateKey } from './options-chain-recorder.js';

// TRA-1609 (parent TRA-1607) — durable, flag-gated SHADOW Put-Call-Ratio ledger.
//
// The engine's `computePutCallRatio` (put-call-ratio.ts) is the pure fold of a
// chain snapshot into the ratio + regime + contrarian read. This module is the
// server seam that (a) reads the feature flag, (b) maintains the per-underlying
// trailing-session history that the z-score needs, and (c) appends well-formed
// observations to an append-only JSONL ledger. NOTHING here routes an order,
// touches sizing, or influences an exit — it is observe-only, $0 live.
//
// This is the dataset QuantTrader validates on the TRA-532 promotion gate: sign
// off comes only after a ≥200-signal shadow window shows positive incremental
// expectancy vs. the current 21EMA+RSI+Vol trio. Each row is therefore stamped
// with the paired trio verdict at capture time so the incremental attribution
// can be measured cleanly.
//
// Cadence: deduped to ONE row per underlying per ET session. The z-score wants
// session-spaced samples (its own trailing 20-session mean/σ), and a per-tick
// re-capture would both inflate the sample and corrupt the z basis — so the
// first snapshot of each session for an underlying is the recorded one and
// later ticks that session are no-ops. This mirrors the option-shadow ledger's
// per-day dedup (TRA-911).

const log = logger.child({ module: 'pcr-shadow-ledger' });

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Phase-1 kill switch. Off by default so a deploy can't start writing PCR shadow
 * rows without an explicit operator opt-in. Accepts the usual truthy spellings.
 * Independent of the option-shadow selector flag, but the per-tick capture rides
 * inside the existing option-shadow chain pass (warm chain, zero extra Tradier
 * fetch), so in practice both flags are on together in the shadow window.
 */
export const PCR_SHADOW_FLAG = 'ENABLE_PCR_SHADOW';

export function isPcrShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[PCR_SHADOW_FLAG];
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** Number of trailing sessions the z-score is measured against (per the contract). */
export const PCR_Z_WINDOW_SESSIONS = 20;

/**
 * The paired 21EMA+RSI+Vol trio verdict at capture time. Recorded so QuantTrader
 * can measure PCR's incremental expectancy vs. the trio already on the signal.
 * The caller (signal engine) computes this from the same 5m series; the ledger
 * only persists it verbatim.
 */
export interface PcrTrioVerdict {
  /** The directional side the trio was evaluated for. */
  side: 'call' | 'put' | 'none';
  /** 21EMA trend-pullback trigger fired (trend + pullback + reversal candle). */
  emaPullbackFired: boolean;
  /** RSI(14) on the underlying at capture (null when history is thin). */
  rsi: number | null;
  /** RSI sits in our momentum-continuation band (50–70) per TRA-1605 posture. */
  rsiInMomentumBand: boolean;
  /** A volume-confirmed breakout printed on the trio's side. */
  volumeConfirmed: boolean;
  /** All three legs aligned — the routable trio verdict. */
  trioFired: boolean;
}

/** What the caller hands the ledger for one capture. */
export interface PcrObservationInput {
  underlying: string;
  /** ms-epoch of the capture. */
  asof: number;
  /** The pure fold from `computePutCallRatio`. */
  pcr: PutCallRatio;
  /** The paired trio verdict (null when no directional side was in play). */
  trio: PcrTrioVerdict | null;
}

/** One persisted PCR shadow observation. */
export interface PcrShadowRecord {
  /** Stable dedupe key: `${underlying}:${session}`. */
  id: string;
  /** ET trading day (YYYY-MM-DD) the observation belongs to. */
  session: string;
  underlying: string;
  /** ms-epoch of capture. */
  asof: number;
  /** Σ put vol / Σ call vol — primary. null when the chain read was untrustworthy. */
  pcrVolume: number | null;
  /** Σ put OI / Σ call OI — secondary. */
  pcrOi: number | null;
  /** z-score of `pcrVolume` vs the trailing 20-session mean/σ. null until enough history. */
  pcrZ: number | null;
  /** Face-value regime bucket from `pcrVolume`. */
  pcrRegime: PcrRegime | null;
  /** Contrarian read at a regime extreme, flagged separately. */
  contrarian: PcrContrarian | null;
  /** Distinct expirations that fed the ratio (ascending). */
  expiriesUsed: string[];
  putVolume: number;
  callVolume: number;
  aggregateVolume: number;
  /** True when the chain was below the liquidity floor (ratio fields nulled). */
  insufficientLiquidity: boolean;
  /** Why the ratio is null/untrustworthy, when applicable. */
  reason: string | null;
  /** The paired 21EMA+RSI+Vol trio verdict at capture time. */
  trio: PcrTrioVerdict | null;
}

function defaultStoreFile(): string {
  const root = process.env['DATA_DIR'] ?? join(__dirname, '..', 'data');
  return join(root, 'pcr-shadow-signals.jsonl');
}

let storeFileOverride: string | null = null;
/** Test seam — point the ledger at a temp file. Pass `null` to restore default. */
export function setPcrShadowLedgerFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
}
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

/** In-memory folded view: id -> record (append-only file, latest line wins). */
let cache: Map<string, PcrShadowRecord> | null = null;

async function ensureLoaded(): Promise<Map<string, PcrShadowRecord>> {
  if (cache) return cache;
  const map = new Map<string, PcrShadowRecord>();
  const path = storeFile();
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, 'utf-8');
      for (const rawLine of raw.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed) as PcrShadowRecord;
          if (rec && typeof rec.id === 'string') map.set(rec.id, rec);
        } catch {
          // Skip a single corrupt line rather than losing the whole ledger.
        }
      }
    } catch (err) {
      log.error('failed to read pcr shadow ledger, starting empty', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  cache = map;
  return cache;
}

/** Eagerly load the ledger so reads have data right after boot. */
export async function initPcrShadowLedger(): Promise<void> {
  await ensureLoaded();
}

async function appendRecord(rec: PcrShadowRecord): Promise<void> {
  const path = storeFile();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await appendFile(path, `${JSON.stringify(rec)}\n`, 'utf-8');
}

/**
 * Trailing PCR-by-volume history for `underlying`, ascending by session, over
 * the most recent {@link PCR_Z_WINDOW_SESSIONS} sessions STRICTLY before
 * `beforeSession`. Only sessions with a non-null `pcrVolume` contribute — an
 * illiquid session doesn't leave a hole in the z basis.
 */
function trailingPcrVolume(
  map: Map<string, PcrShadowRecord>,
  underlying: string,
  beforeSession: string,
): number[] {
  return [...map.values()]
    .filter(
      (r) =>
        r.underlying === underlying &&
        r.session < beforeSession &&
        typeof r.pcrVolume === 'number',
    )
    .sort((a, b) => a.session.localeCompare(b.session))
    .slice(-PCR_Z_WINDOW_SESSIONS)
    .map((r) => r.pcrVolume as number);
}

/** Result of a capture attempt. */
export interface PcrRecordResult {
  written: boolean;
  /** Why nothing was written, when `written` is false. */
  reason?: 'flag_off' | 'duplicate';
  /** The record (the newly-written one, or the pre-existing row on a duplicate). */
  record?: PcrShadowRecord;
}

/**
 * Capture one PCR observation into the shadow ledger. Flag-gated and deduped to
 * one row per underlying per ET session (see module header). Computes the
 * trailing-20-session z-score from prior sessions and stamps the paired trio
 * verdict. NEVER routes an order. Returns whether a new row was written.
 */
export async function recordPcrObservation(obs: PcrObservationInput): Promise<PcrRecordResult> {
  if (!isPcrShadowEnabled()) return { written: false, reason: 'flag_off' };

  const map = await ensureLoaded();
  const session = etDateKey(obs.asof);
  const id = `${obs.underlying}:${session}`;
  const existing = map.get(id);
  if (existing) return { written: false, reason: 'duplicate', record: existing };

  const pcrVolume = obs.pcr.pcrVolume;
  const pcrZ =
    pcrVolume === null
      ? null
      : pcrZScore(pcrVolume, trailingPcrVolume(map, obs.underlying, session));

  const rec: PcrShadowRecord = {
    id,
    session,
    underlying: obs.underlying,
    asof: obs.asof,
    pcrVolume,
    pcrOi: obs.pcr.pcrOi,
    pcrZ,
    pcrRegime: obs.pcr.regime,
    contrarian: obs.pcr.contrarian,
    expiriesUsed: obs.pcr.expiriesUsed,
    putVolume: obs.pcr.putVolume,
    callVolume: obs.pcr.callVolume,
    aggregateVolume: obs.pcr.aggregateVolume,
    insufficientLiquidity: obs.pcr.insufficientLiquidity,
    reason: obs.pcr.reason,
    trio: obs.trio,
  };
  map.set(id, rec);
  await appendRecord(rec);
  log.info('pcr shadow observation recorded', {
    id,
    pcrVolume,
    pcrZ,
    regime: rec.pcrRegime,
    insufficientLiquidity: rec.insufficientLiquidity,
  });
  return { written: true, record: rec };
}

/** All persisted PCR shadow observations, ascending by capture time. */
export async function listPcrShadowSignals(): Promise<PcrShadowRecord[]> {
  const map = await ensureLoaded();
  return [...map.values()].sort((a, b) => a.asof - b.asof);
}

/**
 * Count of rows carrying a usable ratio (non-null `pcrVolume`) — the promotion
 * denominator for QuantTrader's ≥200-signal shadow-window check. Rows nulled for
 * illiquidity or a zero denominator don't count toward the window.
 */
export function usableSignalCount(records: readonly PcrShadowRecord[]): number {
  return records.filter((r) => typeof r.pcrVolume === 'number').length;
}
