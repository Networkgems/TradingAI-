import { appendFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  selectShadowOptionSignal,
  type ShadowOptionSignal,
  type StrategySelectorInput,
  type StrategySelectorParams,
  type StrategySelectorResult,
} from '@trading-app/engine';
import { logger } from './observability/index.js';

// TRA-911 (TRA-908 Phase A) — flag-gated SHADOW option-trade signal ledger.
//
// The engine's strategy selector (`strategy-selector.ts`) is pure decision
// logic; this module is the server-side seam that (a) reads the feature flag,
// (b) runs the selector, and (c) appends well-formed shadow signals to an
// append-only JSONL ledger. NOTHING here routes an order, touches the broker
// client, or commits capital — Phase A is observe-only. Short-leg / multi-leg
// execution is Phase B (TRA-912); the advisory→capital bridge is Phase C
// (TRA-913).
//
// The signal selector deliberately writes to its OWN ledger file rather than the
// Supertrend `shadow-signal-ledger.ts`: that ledger's record is a single-leg
// directional underlying signal with entryRef/stop/target and a forward-R
// resolver (TRA-791/840), a shape an option spread (legs/strikes/delta/DTE)
// does not fit. Keeping them separate avoids contaminating the TRA-734 go/no-go
// dataset and its TRA-840 re-baseline.

const log = logger.child({ module: 'option-shadow-ledger' });

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Phase-A kill switch. The selector emits nothing unless this is truthy, so the
 * shadow capture is off by default and a deploy can't start writing without an
 * explicit opt-in. Accepts the usual truthy spellings.
 */
export const OPTION_SHADOW_FLAG = 'ENABLE_OPTION_SHADOW_SELECTOR';

// TRA-937 (2026-06-18) — EMERGENCY OUTAGE MITIGATION (now REVERTED, see TRA-942).
// prod `tradingai-bqb1` was crash-looping during RTH (all routes 502;
// ~2h-stable-then-crash = OOM signature on the 512MB `starter` plan; confirmed via
// Render events: repeated `server_failed nonZeroExit:134` SIGABRT/OOM aborts until
// the gate deploy stabilized it). The expanded per-tick option-shadow pass
// (TRA-908/917 et al.) is the leading memory-footprint driver, so this code-level
// hard off-switch let a plain `git push` auto-deploy a lighter build that dropped
// the per-tick option-structure pass and recovered memory while the durable fix
// was arranged.
//
// TRA-942 (2026-06-18, board approval `8fb26954`) — DURABLE FIX APPLIED, gate
// reverted to `false`. The Render plan was bumped `starter` (512MB) -> `standard`
// (2GB) via the management API (4x memory headroom), and `ENABLE_OPTION_SHADOW_
// SELECTOR=true` was synced into the live service env (the blueprint value had
// never been applied, so it read `false` live). With headroom proven, Phase-A
// shadow-evidence accrual is restored: the per-tick pass runs again only when the
// env flag is on AND market hours, gated/throttled as before.
//
// Consumed at the engine hot-loop call site (`signal-engine.ts` per-tick pass)
// and the `/api/health/option-shadow-signals` readout — NOT inside
// `isOptionShadowEnabled` itself, so the pure flag logic and the ledger
// emit-path unit tests stay intact. Phase A is observe-only: it routes NO order
// and cannot affect live trading. If prod memory pressure ever returns, flip this
// back to `true` for an instant `git push` recovery while re-profiling.
export const OPTION_SHADOW_EMERGENCY_OFF = false;

export function isOptionShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[OPTION_SHADOW_FLAG];
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function defaultStoreFile(): string {
  const root = process.env['DATA_DIR'] ?? join(__dirname, '..', 'data');
  return join(root, 'option-shadow-signals.jsonl');
}

let storeFileOverride: string | null = null;
/** Test seam — point the ledger at a temp file. Pass `null` to restore default. */
export function setOptionShadowLedgerFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
}
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

/** One persisted shadow option signal (the engine signal + a stable dedupe id). */
export interface OptionShadowRecord extends ShadowOptionSignal {
  /** Stable dedupe key: `${symbol}:${strategy}:${expiration}:${utcDay}`. */
  id: string;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function recordId(s: ShadowOptionSignal): string {
  return `${s.symbol}:${s.strategy}:${s.expiration}:${utcDay(s.timestamp)}`;
}

/** In-memory folded view: id -> record (latest wins; ledger is append-only). */
let cache: Map<string, OptionShadowRecord> | null = null;

async function ensureLoaded(): Promise<Map<string, OptionShadowRecord>> {
  if (cache) return cache;
  const map = new Map<string, OptionShadowRecord>();
  const path = storeFile();
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, 'utf-8');
      for (const rawLine of raw.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed) as OptionShadowRecord;
          if (rec && typeof rec.id === 'string') map.set(rec.id, rec);
        } catch {
          // Skip a single corrupt line rather than losing the whole ledger.
        }
      }
    } catch (err) {
      log.error('failed to read option shadow ledger, starting empty', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  cache = map;
  return cache;
}

/** Eagerly load the ledger so reads have data right after boot. */
export async function initOptionShadowLedger(): Promise<void> {
  await ensureLoaded();
}

async function appendRecord(rec: OptionShadowRecord): Promise<void> {
  const path = storeFile();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await appendFile(path, `${JSON.stringify(rec)}\n`, 'utf-8');
}

/**
 * Append a shadow option signal, deduped by {@link recordId}: a re-fire on the
 * same symbol/strategy/expiration/day is a no-op so a per-tick pass can't inflate
 * the sample. Returns true iff a new row was written.
 */
export async function recordOptionShadowSignal(signal: ShadowOptionSignal): Promise<boolean> {
  const map = await ensureLoaded();
  const id = recordId(signal);
  if (map.has(id)) return false;
  const rec: OptionShadowRecord = { id, ...signal };
  map.set(id, rec);
  await appendRecord(rec);
  log.info('option shadow signal recorded', {
    id, symbol: signal.symbol, strategy: signal.strategy, legs: signal.legs.length,
  });
  return true;
}

/** All persisted shadow option signals, ascending by signal time. */
export async function listOptionShadowSignals(): Promise<OptionShadowRecord[]> {
  const map = await ensureLoaded();
  return [...map.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export interface EmitResult {
  emitted: boolean;
  /** Why nothing was emitted (when `emitted` is false). */
  reason?: 'flag_off' | 'stand_down' | 'no_structure' | 'duplicate';
  /** The selector's decision (present whenever the flag was on). */
  result?: StrategySelectorResult;
}

/**
 * The Phase-A entry point: gate on the feature flag, run the pure selector, and
 * persist a well-formed shadow signal when (and only when) one is produced.
 * Returns a structured result describing what happened. NEVER routes an order.
 */
export async function emitShadowOptionSignal(
  input: StrategySelectorInput,
  params?: StrategySelectorParams,
): Promise<EmitResult> {
  if (!isOptionShadowEnabled()) return { emitted: false, reason: 'flag_off' };

  const result = selectShadowOptionSignal(input, params);
  if (result.decision !== 'signal') {
    return { emitted: false, reason: result.decision, result };
  }
  const wrote = await recordOptionShadowSignal(result.signal);
  return { emitted: wrote, reason: wrote ? undefined : 'duplicate', result };
}
