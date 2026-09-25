import { readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import {
  evaluateOrbOptions,
  DEFAULT_ORB_OPTIONS_PARAMS,
  type OrbOptionsParams,
  type OrbOptionsSignal,
  type OrbOptionsSignalType,
  type OrbOptionsBox,
} from '@trading-app/engine';
import { getEasternUtcOffset, type Candle, type OptionType } from '@trading-app/shared';
import { logger } from './observability/index.js';
import { resolveDataDir } from './data-dir.js';
import { appendBoundedTapeLine } from './data-tape-bounds.js';

// TRA-2173 (parent TRA-2172) — flag-gated SHADOW ledger for the ORB-for-options
// engine core (`packages/engine/src/options/orb-options.ts`).
//
// This module is the server-side seam that (a) reads the feature flag, (b) runs
// the pure `evaluateOrbOptions` directional-intent core over an intraday 5m
// series, and (c) appends a well-formed shadow record to an append-only JSONL
// ledger on a real opening-range breakout. NOTHING here routes an order, touches
// the broker client, or commits capital — this is OBSERVE-ONLY, exactly like the
// `ENABLE_OPTION_SHADOW_SELECTOR` pipeline (TRA-908/911) it is cloned from. Live
// promotion is a SEPARATE future issue gated on TRA-382 + a shadow go/no-go (like
// the Supertrend TRA-799 ledger).
//
// The record is a 0DTE directional-intent shape (optionType + break level +
// underlying entry + opening-range box) that does NOT fit the option-shadow
// selector's spread ledger (legs/strikes/delta/DTE) or the Supertrend directional
// underlying ledger — so it writes to its own file and keeps those datasets
// clean.

const log = logger.child({ module: 'orb-options-shadow-ledger' });

/**
 * Kill switch. The seam emits nothing unless this is truthy, so the shadow
 * capture is off by default and a deploy can't start writing without an explicit
 * opt-in. Accepts the usual truthy spellings. Env-armed shadow class (same as
 * `ENABLE_REVERSAL_SHADOW`): deliberately NOT in `DEMO_FLAG_ALLOWLIST`.
 */
export const ORB_OPTIONS_SHADOW_FLAG = 'ENABLE_ORB_OPTIONS_SHADOW';

export function isOrbOptionsShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ORB_OPTIONS_SHADOW_FLAG];
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** ET calendar-day string (YYYY-MM-DD) for a UTC ms instant (DST-aware). */
function etDay(utcMs: number): string {
  const shifted = utcMs + getEasternUtcOffset(utcMs) * 3_600_000;
  return new Date(shifted).toISOString().slice(0, 10);
}

/**
 * One persisted ORB-options shadow signal: the engine's directional intent (the
 * 0DTE contract INTENT — optionType + break level + underlying entry + opening-
 * range box) plus the rationale/skip reason and the params the read was taken
 * against, with a stable dedupe id.
 */
export interface OrbOptionsShadowRecord {
  /** Stable dedupe key: `${symbol}:${etDay}` — one trade a day per underlying. */
  id: string;
  symbol: string;
  /** ET calendar day of the breakout bar (YYYY-MM-DD). */
  etDay: string;
  /** Evaluation instant (ms) — when the seam ran. */
  timestamp: number;
  type: OrbOptionsSignalType;
  /** 'call' on an upside break, 'put' on a downside break. */
  optionType: OptionType | null;
  breakoutDirection: 'up' | 'down' | null;
  /** The opening-range edge that was broken (call-trigger high / put-trigger low). */
  breakLevel: number | null;
  /** Underlying price at the breakout (the breakout bar's close). */
  underlyingEntry: number | null;
  /** The opening-range box the read was taken against. */
  box: OrbOptionsBox | null;
  /** Human-readable rationale. */
  reason: string;
  /** The tunable params (config, not magic numbers) the read used. */
  params: OrbOptionsParams;
}

function defaultStoreFile(): string {
  const root = resolveDataDir();
  return join(root, 'orb-options-shadow-signals.jsonl');
}

let storeFileOverride: string | null = null;
/** Test seam — point the ledger at a temp file. Pass `null` to restore default. */
export function setOrbOptionsShadowLedgerFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
}
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

/** In-memory folded view: id -> record (latest wins; ledger is append-only). */
let cache: Map<string, OrbOptionsShadowRecord> | null = null;

async function ensureLoaded(): Promise<Map<string, OrbOptionsShadowRecord>> {
  if (cache) return cache;
  const map = new Map<string, OrbOptionsShadowRecord>();
  const path = storeFile();
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, 'utf-8');
      for (const rawLine of raw.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed) as OrbOptionsShadowRecord;
          if (rec && typeof rec.id === 'string') map.set(rec.id, rec);
        } catch {
          // Skip a single corrupt line rather than losing the whole ledger.
        }
      }
    } catch (err) {
      log.error('failed to read orb-options shadow ledger, starting empty', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  cache = map;
  return cache;
}

/** Eagerly load the ledger so reads have data right after boot. */
export async function initOrbOptionsShadowLedger(): Promise<void> {
  await ensureLoaded();
}

async function appendRecord(rec: OrbOptionsShadowRecord): Promise<void> {
  const path = storeFile();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await appendBoundedTapeLine(path, `${JSON.stringify(rec)}\n`);
}

/**
 * Append an ORB-options shadow record, deduped by `${symbol}:${etDay}`: because
 * the strategy is one-trade-a-day, a re-fire on the same underlying in the same
 * ET session is a no-op so a per-tick pass can't inflate the sample. Returns true
 * iff a new row was written.
 */
export async function recordOrbOptionsShadowSignal(
  rec: OrbOptionsShadowRecord,
): Promise<boolean> {
  const map = await ensureLoaded();
  if (map.has(rec.id)) return false;
  map.set(rec.id, rec);
  await appendRecord(rec);
  log.info('orb-options shadow signal recorded', {
    id: rec.id, symbol: rec.symbol, type: rec.type, breakLevel: rec.breakLevel,
  });
  return true;
}

/** All persisted shadow records, ascending by evaluation time. */
export async function listOrbOptionsShadowSignals(): Promise<OrbOptionsShadowRecord[]> {
  const map = await ensureLoaded();
  return [...map.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** The intraday series + context the seam evaluates a single underlying against. */
export interface OrbOptionsEmitInput {
  symbol: string;
  /** Intraday bars in ascending timestamp order (the 5m shadow series). */
  candles: Candle[];
  /** Evaluation instant (ms). */
  now: number;
  /**
   * Optional param override (config, not magic numbers). Merged over the engine
   * defaults (15m OR / 0.2% min / 0.8% max width / noon ET cutoff / both
   * directions / one-trade-a-day), so a downstream sweep can tune the read.
   */
  params?: Partial<OrbOptionsParams>;
}

export interface OrbOptionsEmitResult {
  emitted: boolean;
  /** Why nothing was written (when `emitted` is false). */
  reason?: 'flag_off' | 'none' | 'duplicate';
  /** The engine's directional read (present whenever the flag was on). */
  signal?: OrbOptionsSignal;
}

/**
 * The entry seam: re-check the flag, run the pure `evaluateOrbOptions` core, and
 * persist a well-formed shadow record when (and only when) it produces a
 * `call_breakout` / `put_breakout`. Returns a structured result. NEVER routes an
 * order. On a `none` read nothing is written and the skip reason is returned.
 */
export async function emitOrbOptionsShadowSignal(
  input: OrbOptionsEmitInput,
): Promise<OrbOptionsEmitResult> {
  if (!isOrbOptionsShadowEnabled()) return { emitted: false, reason: 'flag_off' };

  const params: OrbOptionsParams = { ...DEFAULT_ORB_OPTIONS_PARAMS, ...input.params };
  const signal = evaluateOrbOptions(input.candles, params);
  if (signal.type === 'none') return { emitted: false, reason: 'none', signal };

  // Fires only on the breakout bar (the engine enforces one-trade-a-day), so the
  // ET day is anchored to that last bar.
  const breakoutBar = input.candles[input.candles.length - 1]!;
  const day = etDay(breakoutBar.timestamp);
  const rec: OrbOptionsShadowRecord = {
    id: `${input.symbol}:${day}`,
    symbol: input.symbol,
    etDay: day,
    timestamp: input.now,
    type: signal.type,
    optionType: signal.optionType,
    breakoutDirection: signal.breakoutDirection,
    breakLevel: signal.breakLevel,
    underlyingEntry: signal.underlyingEntry,
    box: signal.box,
    reason: signal.reason,
    params,
  };
  const wrote = await recordOrbOptionsShadowSignal(rec);
  return { emitted: wrote, reason: wrote ? undefined : 'duplicate', signal };
}
