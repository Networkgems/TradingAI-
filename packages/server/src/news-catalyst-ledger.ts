import { appendFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import type { CatalystScoreComponents } from '@trading-app/shared';
import { logger } from './observability/index.js';
import { etDateKey } from './options-chain-recorder.js';
import { resolveDataDir } from './data-dir.js';

// TRA-1629 (TRA-1623A, parent TRA-1623) — durable, flag-gated SHADOW ledger for
// the news-catalyst watchlist source.
//
// The pure catalyst score (`shared/news-catalyst.ts computeCatalystScore`) folds
// per-name news + price inputs into a discovery score. This module is the server
// seam that (a) reads the feature flag, (b) dedupes to one row per name per ET
// session, and (c) appends well-formed observations to an append-only JSONL
// ledger — exactly mirroring `pcr-shadow-ledger.ts`. NOTHING here routes an
// order, touches sizing, or alters an exit: it is observe-only, $0 live.
//
// This is the dataset QuantTrader (bf0ae543) forward-validates on the TRA-532
// promotion gate — a ≥100–200 name-day window measuring the incremental option
// expectancy of catalyst names vs the current watchlist. Each row therefore
// records both the score AND whether the name was chosen (injected into the
// watchlist) or dropped + why, so the attribution can be measured cleanly.
//
// Cadence: ONE row per symbol per ET session (the first capture of the session
// for a symbol wins; later ticks that session are no-ops), matching the option-
// and PCR-shadow ledgers.

const log = logger.child({ module: 'news-catalyst-ledger' });

/**
 * Phase-1 kill switch. OFF by default so a deploy can't start discovering /
 * injecting catalyst names or writing shadow rows without an explicit operator
 * opt-in. Accepts the usual truthy spellings. This single flag gates BOTH D1
 * (the `news_catalyst` watchlist source) and D2 (the report lean), so the whole
 * Phase-1 feature is dark until QuantTrader turns it on for the shadow window.
 */
export const NEWS_CATALYST_FLAG = 'ENABLE_NEWS_CATALYST_WATCHLIST';

export function isNewsCatalystEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[NEWS_CATALYST_FLAG];
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * Why a scored candidate was not injected into the watchlist.
 *
 * TRA-4585 (parent TRA-4222) — `no_quote` and `below_min_price` are DIFFERENT
 * diagnoses and must never share a token. `below_min_price` is a measurement:
 * we priced the name and it is under the floor. `no_quote` is the ABSENCE of a
 * measurement: the metrics feed answered with null / NaN / 0, so the name was
 * dropped without ever being screened. Folding the two together is what let the
 * 2026-08-31 price-feed outage enter the forward-test cohort as an ordinary
 * 0-catalyst session — that day rejected SPY, DIA, TSLA, NFLX, AVGO, ORCL, CRM,
 * ADBE, MSTR, COIN, QCOM, AMD, INTC and PYPL as `below_min_price` (14 drops,
 * against 1 across the 25 prior sessions) while the run ledger read
 * `fetch_degraded / queriesSucceeded: 0`. A reader had to already know that SPY
 * is not a penny stock to spot it.
 *
 * The token is `no_quote` and NOT a new third vocabulary: `premarket-watchlist.ts`
 * `filterByPriceFloor` already splits its `dropped[]` exactly this way, with the
 * identical predicate (`price == null || !Number.isFinite(price) || price <= 0`).
 * Both surfaces now mean the same thing by the same word — see
 * {@link hasUsableQuote}, which is the single shared predicate.
 */
export type CatalystDropReason =
  | 'stale' // newest headline older than the freshness gate
  | 'neutral_tilt' // sentiment tilt neutral (no directional catalyst)
  | 'earnings_demote' // earnings within one session — manual look only
  | 'below_min_price' // priced, and under WATCHLIST_MIN_PRICE
  | 'no_quote' // TRA-4585 — NOT priced at all (null/NaN/≤0); never screened
  | 'below_liquidity' // avg $-vol under the directional floor
  | 'hidden' // on the user hidden list
  | 'not_tradable' // not a tradable US equity
  | 'below_cap'; // ranked outside the top-8 cap

/**
 * TRA-4585 — the single predicate for "this quote is a MEASUREMENT, not an
 * absence". Lives here, next to the drop-reason vocabulary, because the whole
 * point of the `no_quote` / `below_min_price` split is that both surfaces that
 * emit those tokens agree on where the boundary is.
 *
 * All three clauses are load-bearing and the 2026-08-31 feed proved it: it
 * returned nulls AND zeros. A bare `price == null` check passes the zeros
 * straight through to the `< minPrice` comparison, where `0 < 5` is true — so
 * half the outage reproduces as `below_min_price` and the bug survives the fix.
 * `!Number.isFinite` additionally catches `NaN`, for which BOTH `< minPrice`
 * and `>= minPrice` are false.
 */
export function hasUsableQuote(price: number | null | undefined): price is number {
  return price != null && Number.isFinite(price) && price > 0;
}

/** What the caller hands the ledger for one capture. */
export interface CatalystObservationInput {
  symbol: string;
  /** ms-epoch of the capture. */
  asof: number;
  /** The pure composite score from `computeCatalystScore`. */
  catalystScore: number;
  components: CatalystScoreComponents;
  /** Per-symbol news `netScore` in [-1,+1]. */
  sentimentNetScore: number;
  sentimentTilt: 'bullish' | 'bearish' | 'neutral';
  /** Raw relative-volume z-score (pre-clamp). */
  rvolZ: number;
  /** Signed open-vs-prior-close gap percent. */
  gapPct: number;
  freshHeadlineCount: number;
  freshnessMinutes: number;
  /** True ↔ injected into the watchlist as a `news_catalyst` source this run. */
  chosen: boolean;
  /** Present when `chosen` is false — why it was dropped. */
  dropReason: CatalystDropReason | null;
  /** Advisory tags (e.g. `EARNINGS_IV_CRUSH_RISK`). */
  tags: string[];
  /**
   * TRA-4585 — was the run that WROTE this row degraded (news feed dead, or no
   * candidate got a usable quote)? See `isCatalystRunDegraded`.
   *
   * ⚠️ TRI-STATE, and the third state is the important one. Every row written
   * from this commit on carries an explicit `true` or `false`. A row with the
   * key ABSENT predates the field and is **UNKNOWN** — never read it as `false`.
   * (`news-catalyst-run-ledger.ts` makes the same distinction for
   * `queriesAttempted` and states why; this follows that precedent. The reader
   * that must not collapse it is {@link CatalystShadowRecord.degradedRun}'s
   * `?? null` unwrap, not a `?:`.)
   *
   * Why it is stamped per-ROW rather than derived at read time: the shadow
   * ledger dedupes one row per symbol per ET session, FIRST WRITE WINS. So a
   * degraded early run permanently owns that session's rows even if a later
   * healthy run that day would have priced the same names. The provenance has
   * to travel with the row it poisoned.
   */
  degradedRun?: boolean;
}

/** One persisted news-catalyst shadow observation. */
export interface CatalystShadowRecord extends CatalystObservationInput {
  /** Stable dedupe key: `${symbol}:${session}`. */
  id: string;
  /** ET trading day (YYYY-MM-DD) the observation belongs to. */
  session: string;
}

function defaultStoreFile(): string {
  const root = resolveDataDir();
  return join(root, 'news-catalyst-signals.jsonl');
}

let storeFileOverride: string | null = null;
/** Test seam — point the ledger at a temp file. Pass `null` to restore default. */
export function setNewsCatalystLedgerFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
}
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

/** In-memory folded view: id -> record (append-only file, latest line wins). */
let cache: Map<string, CatalystShadowRecord> | null = null;

async function ensureLoaded(): Promise<Map<string, CatalystShadowRecord>> {
  if (cache) return cache;
  const map = new Map<string, CatalystShadowRecord>();
  const path = storeFile();
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, 'utf-8');
      for (const rawLine of raw.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed) as CatalystShadowRecord;
          if (rec && typeof rec.id === 'string') map.set(rec.id, rec);
        } catch {
          // Skip a single corrupt line rather than losing the whole ledger.
        }
      }
    } catch (err) {
      log.error('failed to read news-catalyst ledger, starting empty', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  cache = map;
  return cache;
}

/** Eagerly load the ledger so reads have data right after boot. */
export async function initNewsCatalystLedger(): Promise<void> {
  await ensureLoaded();
}

async function appendRecord(rec: CatalystShadowRecord): Promise<void> {
  const path = storeFile();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await appendFile(path, `${JSON.stringify(rec)}\n`, 'utf-8');
}

/** Result of a capture attempt. */
export interface CatalystRecordResult {
  written: boolean;
  /** Why nothing was written, when `written` is false. */
  reason?: 'flag_off' | 'duplicate';
  /** The record (the newly-written one, or the pre-existing row on a duplicate). */
  record?: CatalystShadowRecord;
}

/**
 * Capture one news-catalyst observation into the shadow ledger. Flag-gated and
 * deduped to one row per symbol per ET session (see module header). NEVER routes
 * an order. Returns whether a new row was written.
 */
export async function recordCatalystObservation(
  obs: CatalystObservationInput,
): Promise<CatalystRecordResult> {
  if (!isNewsCatalystEnabled()) return { written: false, reason: 'flag_off' };

  const map = await ensureLoaded();
  const session = etDateKey(obs.asof);
  const symbol = obs.symbol.toUpperCase();
  const id = `${symbol}:${session}`;
  const existing = map.get(id);
  if (existing) return { written: false, reason: 'duplicate', record: existing };

  const rec: CatalystShadowRecord = { ...obs, symbol, id, session };
  map.set(id, rec);
  await appendRecord(rec);
  log.info('news-catalyst observation recorded', {
    id,
    catalystScore: obs.catalystScore,
    tilt: obs.sentimentTilt,
    chosen: obs.chosen,
    ...(obs.dropReason ? { dropReason: obs.dropReason } : {}),
  });
  return { written: true, record: rec };
}

/** All persisted news-catalyst observations, ascending by capture time. */
export async function listNewsCatalystSignals(): Promise<CatalystShadowRecord[]> {
  const map = await ensureLoaded();
  return [...map.values()].sort((a, b) => a.asof - b.asof);
}

/**
 * Count of CHOSEN rows (names actually injected into the watchlist) — the
 * promotion numerator for QuantTrader's forward-validation window. Dropped
 * candidates are still persisted for attribution but don't count toward the
 * "name-days" the TRA-532 gate measures.
 */
export function chosenSignalCount(records: readonly CatalystShadowRecord[]): number {
  return records.filter((r) => r.chosen).length;
}
