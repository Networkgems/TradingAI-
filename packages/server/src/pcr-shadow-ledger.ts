import { readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { pcrZScore, type PutCallRatio, type PcrRegime, type PcrContrarian } from '@trading-app/engine';
import { logger } from './observability/index.js';
import { etDateKey } from './options-chain-recorder.js';
import { resolveDataDir } from './data-dir.js';
import { appendBoundedTapeLine } from './data-tape-bounds.js';

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
  /**
   * z-score of `pcrVolume` vs the trailing 20-session mean/sample-σ. null until
   * at least `PCR_Z_MIN_SAMPLES` (10) trailing sessions exist — an honest
   * unknown beats a z we cannot trust (TRA-1663).
   */
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
  const root = resolveDataDir();
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
  await appendBoundedTapeLine(path, `${JSON.stringify(rec)}\n`);
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

// TRA-1663 — QuantTrader's sample-sufficiency bar, in code rather than in a
// comment thread. `usableSignalCount` alone is a ROW count, and the watchlist is
// 25 names deduped to one row per underlying per session (~23-25 rows/session),
// so it crosses 200 at session ~9 while the ≥20-SESSION leg is not met until
// session ~20. A `promotionReady` wired to the row count therefore goes true
// ~11 sessions before the sample is actually promotable, and the handoff it
// triggers would have to be bounced straight back.
//
// The legs exist because rows are NOT iid: a market-wide fear day lifts every
// name's PCR together, so effective N tracks the number of SESSIONS, not the
// number of rows. All five legs must hold.
//
// TRA-1676 — the four legs above grade RATIO rows; the promotion read grades Z
// rows, and after TRA-1663 those are two different populations. `pcrZ` stays
// null until a name has PCR_Z_MIN_SAMPLES (10) strictly-prior sessions of its
// own, so at ledger session 20 all four legs are green on 500 ratio rows while
// only 10 sessions carry a z at all. Half the effective N the session leg exists
// to guarantee — and worst exactly where the read lives, since the extreme-|z|
// buckets it hunts are produced by the same cross-name correlation that motivates
// the session leg, so those rows plausibly collapse onto 1-3 macro days. The
// fifth leg grades the population the read actually consumes.

/** Usable rows required (the promotion denominator). */
export const PCR_PROMOTION_MIN_USABLE = 200;
/** Distinct ET sessions the usable rows must span — the real effective-N leg. */
export const PCR_PROMOTION_MIN_SESSIONS = 20;
/** Distinct underlyings the usable rows must cover. */
export const PCR_PROMOTION_MIN_UNDERLYINGS = 5;
/** No single underlying may exceed this share of the usable rows. */
export const PCR_PROMOTION_MAX_NAME_SHARE_PCT = 40;
/**
 * Distinct ET sessions that must carry at least one z-BEARING row (TRA-1676).
 * The effective-N leg for the promotion read itself: 10 warm-up sessions + 20
 * z-bearing sessions = 30 ledger sessions before `promotionReady` can flip.
 */
export const PCR_PROMOTION_MIN_Z_SESSIONS = 20;

/** Each leg of the promotion bar, plus the measured value behind it. */
export interface PcrSampleSufficiency {
  usableCount: number;
  /** Distinct ET sessions represented among the usable rows. */
  sessionCount: number;
  /** Distinct underlyings represented among the usable rows. */
  underlyingCount: number;
  /** Largest single-underlying share of the usable rows, in percent (0 when empty). */
  maxNameSharePct: number;
  /** Distinct ET sessions carrying >=1 row with a non-null `pcrZ` (TRA-1676). */
  zSessionCount: number;
  legs: {
    usableCount: boolean;
    sessionCount: boolean;
    underlyingCount: boolean;
    nameConcentration: boolean;
    zSessionCount: boolean;
  };
  /** True only when ALL FIVE legs hold. */
  promotionReady: boolean;
  /** Human-readable reasons the bar is not met (empty when `promotionReady`). */
  shortfall: string[];
}

/**
 * Grade the accrued ledger against the full five-leg promotion bar. Every leg is
 * a POSITIVE assertion — an empty ledger fails all five (it does not vacuously
 * pass the concentration leg, and 0 z-sessions is not >= 20), so this fails closed.
 * Legs 1-4 are evaluated over the USABLE (non-null `pcrVolume`) rows; leg 5 is
 * evaluated over the Z-BEARING rows, which `recordPcrObservation` guarantees are
 * a subset of the usable ones — a null ratio never gets a z.
 */
export function pcrSampleSufficiency(
  records: readonly PcrShadowRecord[],
): PcrSampleSufficiency {
  const usable = records.filter((r) => typeof r.pcrVolume === 'number');
  const usableCount = usable.length;

  const sessionCount = new Set(usable.map((r) => r.session)).size;

  const zSessionCount = new Set(
    records.filter((r) => typeof r.pcrZ === 'number').map((r) => r.session),
  ).size;

  const perName = new Map<string, number>();
  for (const r of usable) perName.set(r.underlying, (perName.get(r.underlying) ?? 0) + 1);
  const underlyingCount = perName.size;
  const maxNameSharePct =
    usableCount === 0 ? 0 : (Math.max(...perName.values()) / usableCount) * 100;

  const legs = {
    usableCount: usableCount >= PCR_PROMOTION_MIN_USABLE,
    sessionCount: sessionCount >= PCR_PROMOTION_MIN_SESSIONS,
    underlyingCount: underlyingCount >= PCR_PROMOTION_MIN_UNDERLYINGS,
    // Requires rows to exist: a 0-row ledger must not satisfy "no name >40%".
    nameConcentration: usableCount > 0 && maxNameSharePct <= PCR_PROMOTION_MAX_NAME_SHARE_PCT,
    zSessionCount: zSessionCount >= PCR_PROMOTION_MIN_Z_SESSIONS,
  };

  const shortfall: string[] = [];
  if (!legs.usableCount) {
    shortfall.push(`usableCount ${usableCount} < ${PCR_PROMOTION_MIN_USABLE}`);
  }
  if (!legs.sessionCount) {
    shortfall.push(`sessionCount ${sessionCount} < ${PCR_PROMOTION_MIN_SESSIONS}`);
  }
  if (!legs.underlyingCount) {
    shortfall.push(`underlyingCount ${underlyingCount} < ${PCR_PROMOTION_MIN_UNDERLYINGS}`);
  }
  if (!legs.nameConcentration) {
    shortfall.push(
      usableCount === 0
        ? 'no usable rows'
        : `maxNameSharePct ${maxNameSharePct.toFixed(1)} > ${PCR_PROMOTION_MAX_NAME_SHARE_PCT}`,
    );
  }
  if (!legs.zSessionCount) {
    shortfall.push(`zSessionCount ${zSessionCount} < ${PCR_PROMOTION_MIN_Z_SESSIONS}`);
  }

  return {
    usableCount,
    sessionCount,
    underlyingCount,
    maxNameSharePct,
    zSessionCount,
    legs,
    promotionReady: Object.values(legs).every(Boolean),
    shortfall,
  };
}
