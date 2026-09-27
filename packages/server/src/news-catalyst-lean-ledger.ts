import { readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import type { DirectionalLean, LeanBand, LeanStructure, LeanVerdict } from '@trading-app/shared';
import { logger } from './observability/index.js';
import { etDateKey } from './options-chain-recorder.js';
import type { NameLeanInput } from './news-catalyst-lean.js';
import { resolveDataDir } from './data-dir.js';
import { appendBoundedTapeLine } from './data-tape-bounds.js';

// TRA-1632 (TRA-1623A, parent TRA-1630/TRA-1623) — durable, flag-gated SHADOW
// ledger for the D2 calls-vs-puts directional lean.
//
// Why this exists: the D2 lean (`news-catalyst-lean.ts assembleNameLeans`) was
// ephemeral — `renderLeanMarkdown` wrote the resolved CALL/PUT/NO-TRADE verdict
// into the report body / `ReviewBlock.leaders` only, never a ledger. The lean is
// a composite of the news-sentiment tilt + the PCR contrarian read + the OI
// quadrant + the trend gate, and PCR/OI are POINT-IN-TIME captures — they cannot
// be reconstructed retroactively. So without persisting the resolved lean AT
// CAPTURE TIME, QuantTrader's TRA-1630 lean-hit-rate metric (lean vs realized
// next-day / next-3-day underlying direction) is ungradeable.
//
// This module is the persistence seam: it appends one row per name per ET session
// (first capture of the session wins; later reviews that session are no-ops),
// exactly mirroring the D1 `news-catalyst-ledger.ts` cadence. It records the
// resolved lean (verdict + directional blend + confidence/band/structure) AND its
// driver components (the sentiment tilt, PCR contrarian, OI quadrant/price dir,
// trend state, IV-Rank that fed the blend) so the attribution can be measured
// cleanly offline. NOTHING here routes an order, touches sizing, or alters an
// exit: it is observe-only, $0 live — the same class as the D1 ledger it parallels.

const log = logger.child({ module: 'news-catalyst-lean-ledger' });

/** The driver components that fed the resolved lean (persisted for attribution). */
export interface CatalystLeanDrivers {
  sentimentTilt: 'bullish' | 'bearish' | 'neutral';
  pcrContrarian: 'bullish' | 'bearish' | null;
  oiQuadrant: 'strong' | 'weak' | 'weakening' | null;
  oiPriceDirection: 'up' | 'down' | 'flat' | null;
  trendState: 'up' | 'down' | 'unknown';
  ivRank: number | null;
}

/** One persisted D2 lean observation. */
export interface CatalystLeanRecord {
  /** Stable dedupe key: `${symbol}:${session}`. */
  id: string;
  symbol: string;
  /** ET trading day (YYYY-MM-DD) the lean belongs to. */
  session: string;
  /** ms-epoch of the capture. */
  asof: number;
  /** Resolved directional lean verdict — `CALL` | `PUT` | `NO-TRADE`. */
  lean: LeanVerdict;
  /** Weighted blend in [-1,+1]: +calls / −puts. */
  directional: number;
  /** 1–10 = scaled |directional| × input agreement. */
  confidence: number;
  band: LeanBand;
  /** IV-Rank STRUCTURE overlay — spread vs single-leg. */
  structure: LeanStructure;
  /** How many of the non-zero inputs agreed in sign with the net direction. */
  agreement: { agree: number; total: number };
  /** The point-in-time driver inputs that produced this lean. */
  drivers: CatalystLeanDrivers;
}

function defaultStoreFile(): string {
  const root = resolveDataDir();
  return join(root, 'news-catalyst-lean.jsonl');
}

let storeFileOverride: string | null = null;
/** Test seam — point the ledger at a temp file. Pass `null` to restore default. */
export function setNewsCatalystLeanLedgerFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
}
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

/** In-memory folded view: id -> record (append-only file, latest line wins). */
let cache: Map<string, CatalystLeanRecord> | null = null;

async function ensureLoaded(): Promise<Map<string, CatalystLeanRecord>> {
  if (cache) return cache;
  const map = new Map<string, CatalystLeanRecord>();
  const path = storeFile();
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, 'utf-8');
      for (const rawLine of raw.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed) as CatalystLeanRecord;
          if (rec && typeof rec.id === 'string') map.set(rec.id, rec);
        } catch {
          // Skip a single corrupt line rather than losing the whole ledger.
        }
      }
    } catch (err) {
      log.error('failed to read news-catalyst lean ledger, starting empty', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  cache = map;
  return cache;
}

/** Eagerly load the ledger so reads have data right after boot. */
export async function initNewsCatalystLeanLedger(): Promise<void> {
  await ensureLoaded();
}

async function appendRecord(rec: CatalystLeanRecord): Promise<void> {
  const path = storeFile();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await appendBoundedTapeLine(path, `${JSON.stringify(rec)}\n`);
}

/** Result of a lean-capture attempt. */
export interface CatalystLeanRecordResult {
  written: boolean;
  /** Why nothing was written, when `written` is false. */
  reason?: 'duplicate';
  /** The record (the newly-written one, or the pre-existing row on a duplicate). */
  record?: CatalystLeanRecord;
}

/**
 * Persist one resolved D2 lean into the shadow lean ledger. Deduped to one row
 * per symbol per ET session (see module header). NEVER routes an order. Callers
 * are already flag-gated (`isNewsCatalystEnabled`) at the D2 assembly site, so this
 * does not re-check the flag — it only records what the report already annotated.
 * Returns whether a new row was written.
 */
export async function recordCatalystLean(
  input: NameLeanInput,
  lean: DirectionalLean,
  asof: number,
): Promise<CatalystLeanRecordResult> {
  const map = await ensureLoaded();
  const session = etDateKey(asof);
  const symbol = input.symbol.toUpperCase();
  const id = `${symbol}:${session}`;
  const existing = map.get(id);
  if (existing) return { written: false, reason: 'duplicate', record: existing };

  const rec: CatalystLeanRecord = {
    id,
    symbol,
    session,
    asof,
    lean: lean.verdict,
    directional: lean.directional,
    confidence: lean.confidence,
    band: lean.band,
    structure: lean.structure,
    agreement: lean.agreement,
    drivers: {
      sentimentTilt: input.sentimentTilt,
      pcrContrarian: input.pcrContrarian,
      oiQuadrant: input.oiQuadrant,
      oiPriceDirection: input.oiPriceDirection,
      trendState: input.trendState,
      ivRank: input.ivRank,
    },
  };
  map.set(id, rec);
  await appendRecord(rec);
  log.info('news-catalyst lean recorded', {
    id,
    lean: rec.lean,
    directional: rec.directional,
    confidence: rec.confidence,
  });
  return { written: true, record: rec };
}

/** All persisted D2 lean observations, ascending by capture time. */
export async function listCatalystLeans(): Promise<CatalystLeanRecord[]> {
  const map = await ensureLoaded();
  return [...map.values()].sort((a, b) => a.asof - b.asof);
}

/** Verdict breakdown across persisted lean rows — the gradeability roll-up. */
export interface CatalystLeanBreakdown {
  CALL: number;
  PUT: number;
  'NO-TRADE': number;
}

export function leanBreakdown(records: readonly CatalystLeanRecord[]): CatalystLeanBreakdown {
  const out: CatalystLeanBreakdown = { CALL: 0, PUT: 0, 'NO-TRADE': 0 };
  for (const r of records) out[r.lean] += 1;
  return out;
}
