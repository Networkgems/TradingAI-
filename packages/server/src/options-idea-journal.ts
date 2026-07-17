import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { DefinedRiskStrategy } from '@trading-app/agents';
import { logger } from './observability/index.js';
import { etDateKey } from './options-chain-recorder.js';
import { costEfficiencyRatio } from './options-cost-model.js';
import type { OptionsIdeaView, IdeaLeg } from './options-ideas-feed.js';

// TRA-601 (TRA-595 C6) — the forward-test idea journal.
//
// This is the validation backbone's *capture* layer. Every time the live
// `GET /api/options/ideas` pass surfaces a ranked, defined-risk idea, we append
// an immutable entry record here. The journal is the persistent, append-only
// log of "what the engine claimed, when" — joinable to the point-in-time option
// chains the recorder writes (`options-chain-recorder.ts`) by `(ticker, etDate)`
// — so the forward-test harness can re-price each idea against subsequently
// recorded chains and compute a real hit-rate / expectancy with NO look-ahead.
//
// Why a single global journal (not per-user): we are validating the IDEA ENGINE
// itself, not any one user's paper ledger. A surfaced idea is the same idea
// regardless of whose watchlist produced it, so we dedupe to one entry per
// (ticker, strategy, expiration, ET surfaced-date). This matches the global
// grain of the chain recorder and the IV-history store.
//
// Nothing here touches live capital. The journal records *paper-fill* entry
// terms (chain-priced net / max-loss the panel already shows); the live-capital
// gate (`live-capital-gate.ts`) reads the report this feeds, and that gate is an
// evidence report for a human decision — it wires no orders.

const log = logger.child({ module: 'options-idea-journal' });

const __dirname = dirname(fileURLToPath(import.meta.url));

function defaultStoreFile(): string {
  const root = process.env['DATA_DIR'] ?? join(__dirname, '..', 'data');
  return join(root, 'options-idea-journal.json');
}

let storeFileOverride: string | null = null;
/** Test seam — point the journal at a temp file. Pass `null` to restore default. */
export function setIdeaJournalFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
}
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

/** Hard cap on journal size so the file can't grow unbounded (oldest dropped). */
const MAX_ENTRIES = 5000;

/**
 * One surfaced idea, captured at generation time. All payoff fields are the
 * chain-priced terms the C5 panel showed the user (a paper "fill" at the mid),
 * so the forward-test marks against the SAME basis the user would have entered.
 */
export interface IdeaJournalEntry {
  /** Stable dedupe key: `${etDate}:${ticker}:${strategy}:${expiration}`. */
  key: string;
  /** ms-epoch the idea was surfaced. */
  surfacedAt: number;
  /** ET trading day the idea was surfaced (joins to the chain recorder partition). */
  surfacedDate: string;
  /** ISO week the idea was surfaced (e.g. `2026-W23`) — the report's grouping key. */
  surfacedWeek: string;
  ticker: string;
  /** Engine strategy id (defined-risk only). */
  strategy: DefinedRiskStrategy;
  thesis: string;
  /** Model probability-of-profit, 0–1. */
  pop: number;
  /** Days-to-expiration at surface time. */
  dte: number;
  /** Nearest-leg expiration (YYYY-MM-DD) — when the idea resolves. */
  expiration: string;
  /** The modeled legs (the structure whose P/L we forward-test). */
  legs: IdeaLeg[];
  /** + = net credit received, − = net debit paid (USD per 1-lot) at entry. */
  entryNetUsd: number;
  /** Defined max loss (USD per 1-lot) the panel showed — the risk denominator. */
  maxLossUsd: number;
  /** Modeled max profit (USD per 1-lot). */
  maxProfitUsd: number;
  /** Breakeven underlying prices. */
  breakevens: number[];
  /** Underlying spot at surface time. */
  spotAtEntry: number | null;
  /** IV-rank at surface time (0–100), when known. */
  ivRank: number | null;
  /**
   * TRA-678 (F2) — false iff this idea's structure was the thin-chain FALLBACK
   * placeholder (legs not priced off real marks; `entryNetUsd = ±maxLoss` on a
   * fabricated basis). The forward-test EXCLUDES fallback-priced entries from the
   * gate metrics. Optional/absent on legacy entries → treated as priced (true).
   */
  priced?: boolean;
  /**
   * TRA-1991 — cost-efficiency ratio = modeled round-trip cost ÷ defined max-loss
   * (F1 cost model), lot-invariant. Stamped at capture for auditability; the
   * forward-test EXCLUDES entries whose ratio exceeds `COST_EFFICIENCY_MAX` as
   * `cost_uneconomic`. Null when max-loss is non-positive; absent on legacy
   * entries (the scorer recomputes it from leg-count + max-loss regardless).
   */
  costEfficiencyRatio?: number | null;
}

interface StoreFile {
  version: 1;
  updatedAt: number;
  entries: IdeaJournalEntry[];
}

let cache: IdeaJournalEntry[] | null = null;

/**
 * ISO-8601 week label (`YYYY-Www`) for an ET trading day. We group the weekly
 * report on the day the idea was *surfaced* so an idea always lands in a fixed
 * week regardless of when it resolves. Pure — exported for the report + tests.
 */
export function isoWeek(etDate: string): string {
  // Parse the ET calendar date at UTC midnight; ISO week math is calendar-only.
  const d = new Date(`${etDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return 'invalid';
  // ISO week: Thursday of the current week determines the year.
  const day = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - day + 3); // move to Thursday
  const thursday = d.getTime();
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.floor((thursday - yearStart.getTime()) / 86_400_000 / 7) + 1;
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function isValidEntry(e: unknown): e is IdeaJournalEntry {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o['key'] === 'string' &&
    typeof o['ticker'] === 'string' &&
    typeof o['strategy'] === 'string' &&
    typeof o['expiration'] === 'string' &&
    typeof o['surfacedDate'] === 'string' &&
    typeof o['entryNetUsd'] === 'number' &&
    typeof o['maxLossUsd'] === 'number' &&
    Array.isArray(o['legs'])
  );
}

async function ensureLoaded(): Promise<IdeaJournalEntry[]> {
  if (cache) return cache;
  const path = storeFile();
  if (!existsSync(path)) {
    cache = [];
    return cache;
  }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as Partial<StoreFile>;
    const entries = Array.isArray(parsed.entries) ? parsed.entries.filter(isValidEntry) : [];
    entries.sort((a, b) => a.surfacedAt - b.surfacedAt);
    cache = entries;
  } catch (err) {
    log.error('failed to read idea journal, starting empty', {
      reason: err instanceof Error ? err.message : String(err),
    });
    cache = [];
  }
  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  const path = storeFile();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const payload: StoreFile = { version: 1, updatedAt: Date.now(), entries: cache };
  await writeFile(path, JSON.stringify(payload), 'utf-8');
}

/** Eagerly load the journal so the report read has data right after boot. */
export async function initIdeaJournal(): Promise<void> {
  await ensureLoaded();
}

/** Stable dedupe key for a surfaced idea. */
export function journalKey(
  surfacedDate: string,
  ticker: string,
  strategy: string,
  expiration: string,
): string {
  return `${surfacedDate}:${ticker.toUpperCase()}:${strategy}:${expiration}`;
}

/** Map a panel idea view + its engine strategy id to a journal entry. */
function toEntry(
  idea: OptionsIdeaView,
  strategy: DefinedRiskStrategy,
  surfacedAt: number,
): IdeaJournalEntry | null {
  const expiration = idea.legs[0]?.expiration;
  if (!expiration) return null;
  const surfacedDate = etDateKey(surfacedAt);
  // TRA-1356 — the panel view now carries SIZED dollar totals (per-lot × the
  // sized lot count). The forward-test scores structure P/L PER 1-LOT against
  // these as the risk denominator, so divide back to per-lot before journaling
  // (lot count defaults to 1 for preview / single-leg / legacy views).
  const lots =
    Number.isInteger(idea.contracts) && (idea.contracts as number) >= 1
      ? (idea.contracts as number)
      : 1;
  const perLot = (usd: number): number => Math.round((usd / lots) * 100) / 100;
  const maxLossUsd = perLot(idea.maxLossUsd);
  return {
    key: journalKey(surfacedDate, idea.ticker, strategy, expiration),
    surfacedAt,
    surfacedDate,
    surfacedWeek: isoWeek(surfacedDate),
    ticker: idea.ticker.toUpperCase(),
    strategy,
    thesis: idea.thesis,
    pop: idea.pop,
    dte: idea.dte,
    expiration,
    legs: idea.legs,
    entryNetUsd: perLot(idea.netUsd),
    maxLossUsd,
    maxProfitUsd: perLot(idea.maxProfitUsd),
    breakevens: idea.breakevens,
    spotAtEntry: idea.underlyingPrice ?? null,
    ivRank: idea.ivRank ?? null,
    // TRA-678 (F2) — capture whether the structure was really priced; absent
    // on a non-live view defaults to priced (true).
    priced: idea.priced ?? true,
    // TRA-1991 — stamp the (per-lot, lot-invariant) cost-efficiency ratio for
    // auditability. Computed off the SAME F1 cost model the forward-test scorer
    // uses, so a journaled stamp and the scorer's recompute agree.
    costEfficiencyRatio: costEfficiencyRatio(idea.legs.length, maxLossUsd),
  };
}

/**
 * Append the surfaced ideas to the journal, deduped by {@link journalKey}. An
 * idea re-surfaced the same ET day for the same (ticker, strategy, expiration)
 * is a no-op — the first capture's entry terms win, so a polled feed can't
 * inflate the sample. Returns the count of NEW entries written.
 *
 * `strategyById` maps each idea's panel id → its engine `DefinedRiskStrategy`
 * (the panel view only carries the display string; the journal needs the enum
 * so the forward-test prices the right structure class). Ideas absent from the
 * map are skipped.
 */
export async function recordSurfacedIdeas(
  ideas: readonly OptionsIdeaView[],
  strategyById: ReadonlyMap<string, DefinedRiskStrategy>,
  surfacedAt: number = Date.now(),
): Promise<number> {
  const entries = await ensureLoaded();
  const existing = new Set(entries.map((e) => e.key));
  let added = 0;
  for (const idea of ideas) {
    const strategy = strategyById.get(idea.id);
    if (!strategy) continue;
    const entry = toEntry(idea, strategy, surfacedAt);
    if (!entry || existing.has(entry.key)) continue;
    entries.push(entry);
    existing.add(entry.key);
    added++;
  }
  if (added === 0) return 0;
  entries.sort((a, b) => a.surfacedAt - b.surfacedAt);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  cache = entries;
  await persist();
  log.info('idea journal updated', { added, total: entries.length });
  return added;
}

/** Snapshot of all journaled entries (ascending by surface time). */
export async function listJournalEntries(): Promise<IdeaJournalEntry[]> {
  return [...(await ensureLoaded())];
}

/** Synchronous read of the loaded journal (empty until {@link initIdeaJournal}). */
export function journalEntriesSync(): IdeaJournalEntry[] {
  return cache ? [...cache] : [];
}
