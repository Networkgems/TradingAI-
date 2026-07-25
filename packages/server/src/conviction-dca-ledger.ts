// TRA-1278 (parent TRA-1276 → TRA-971) — persistent conviction-DCA add ledger.
//
// The TRA-971 forward-evidence gate (TRA-1276 weekly review) has to pull the
// demo/paper conviction-DCA scale-in fills accrued since the a255c2d deploy and
// verify each fill's blended R-cap. Today those fills exist ONLY as ephemeral
// `log.info('TRA-954 conviction-DCA add filled (demo)', …)` lines and an
// in-memory `dcaTranches` Map that is re-seeded from book state on every boot —
// so the canonical host (Render demo `tradingai-bqb1`, reboots ~daily) loses the
// entire add history each restart. The gate therefore reads a structural "0" it
// cannot distinguish from lost evidence.
//
// This module is the durable source of truth. Mirrors the TRA-1216 funding-history
// JSONL + TRA-1264/1271 hydrate-on-boot pattern:
//   • one JSONL line per add fill (equity `addToPosition` demo path + option
//     scale-in) under DATA_DIR — a write-through of values ALREADY computed at the
//     log site, so it adds no new decision;
//   • counts rebuilt from the full JSONL on boot (survive restart — do NOT reset);
//   • a read-only `GET /api/health/conviction-dca` folds the store into the gate's
//     addCount / breachCount / lastAddAt / recent tail.
//
// OBSERVE-ONLY: this is pure accounting. NO entry/exit/scale-in decision is read
// or changed here. Unlike the funding-history / ignition logs this ledger is NOT
// rotated — it IS the promotion evidence and must stay complete; add fills are
// rare (the gate reads ~0), so the file stays tiny and a full-read hydrate is
// exact. A full read on boot also means counts need no separate snapshot: each
// line is one terminal fill, so `addCount === lines`.

import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from './observability/index.js';
import { timeSyncPhase } from './phase-timing.js';

const log = logger.child({ module: 'conviction-dca-ledger' });

export const CONVICTION_DCA_LOG_FILENAME = 'conviction-dca-fills.jsonl';

/** R-cap slack — a fill is a breach only when it clears the budget by > this. */
const BREACH_EPSILON = 1e-6;

/** Size of the `recent` tail the health route projects (a DISPLAY cap only). */
const MAX_RECENT_FILLS = 50;

/**
 * TRA-2303 — how many parsed fills are retained in memory.
 *
 * This used to be `MAX_RECENT_FILLS` (50): the retained array was both the health
 * tail AND the only thing the anchored branch of {@link summarizeConvictionDca}
 * could re-derive over. That made setting `CONVICTION_DCA_DEPLOY_ANCHOR` silently
 * drop `byClass.equity.addCount` from 3 to 0 — all 3 equity fills landed on
 * 2026-07-06 and were evicted from a 50-fill tail within two days at the observed
 * rate. It failed HONESTLY (the sums still reconciled) which is exactly what made
 * it dangerous: a truncated count read byte-identical to a complete one.
 *
 * The fix is to retain enough to make the anchored branch EXACT. Sizing, measured
 * off live bqb1 on 2026-07-25 (`/api/health/conviction-dca`): 600 fills over 18.27
 * days = 32.8 fills/day, ~600 bytes/fill retained. 25 000 ⇒ ~2.1 years of headroom
 * at that rate for ~15 MB — and the boot hydrate already reads the whole file into
 * one string regardless, so this is not a new order of cost.
 *
 * The cap is a backstop, not a working limit. When it IS hit the summary says so
 * (`countsExact: false` / `countsBasis: 'retained-truncated'`) instead of quietly
 * serving a short count — the failing state the 50-fill version never had.
 */
const MAX_RETAINED_FILLS = 25_000;

/**
 * One durable conviction-DCA add fill — the gate's per-fill R evidence. Every
 * value is a write-through of what the signal-engine already computed at the fill
 * site (equity ~L5659 / option ~L5788), so appending one is free of new logic.
 */
export interface ConvictionDcaFill {
  /** Fill time, ms epoch. */
  ts: number;
  /** Book mode the add executed on — demo/paper today (live add-order path is gated). */
  mode: 'demo' | 'live';
  assetClass: 'equity' | 'option';
  symbol: string;
  /** Engine position/option id the tranche was added to. */
  positionId: string;
  /** DCA core verdict — 'add' | 'shrink'. */
  action: string;
  /** Shares (equity) or contracts (option) added this fill. */
  addQty: number;
  /** Fill price — share price (equity) or per-contract debit in $ (option). */
  addPrice: number;
  /** Blended avg cost after the add (equity); per-contract premium basis (option). */
  blendedAvg: number;
  /** Position stop after the add (equity); null for defined-risk options. */
  stop: number | null;
  /** Total shares/contracts held after the add. */
  totalQty: number;
  /** Realized dollar risk after the add: (blended−stop)·qty (equity) / Σ premium (option). */
  realizedRiskDollars: number;
  /** Per-position risk budget R the fill is checked against. */
  riskBudget: number;
  /** realizedRiskDollars ≤ riskBudget + ε — the R-cap invariant at fill time. */
  withinBudget: boolean;
  /** DCA core reason string. */
  reason: string;
}

// ── Partitioned counters (TRA-2265) ──────────────────────────────────────────
//
// The pooled addCount/breachCount above fold the equity and option add legs into
// ONE number — but the two legs are checked by DIFFERENT rules at the fill site:
//   • equity (signal-engine `evaluateConvictionDcaAdds`)       → (blended−stop)·qty ≤ R
//   • option (signal-engine `evaluateOptionConvictionDcaAdds`) → Σ premium ≤ R, stop null
// The TRA-971 promotion gate reads these numbers as evidence about the EQUITY
// R-cap. With 100/100 retained fills `assetClass:"option"`, a pooled
// `breachCount: 0` reads byte-identical whether the equity cap held across
// hundreds of fills or the equity add path never executed once — the pooled
// counter has no failing state for the leg that never fires.
//
// These per-class / per-mode buckets are the separator. Every bucket key is
// ALWAYS present, so an equity zero is a STATED zero (`addCount: 0`) rather than
// an absent key a reader could mistake for "not partitioned yet".
//
// STRICTLY OBSERVE-ONLY: no entry/exit/scale-in path reads them.

/** Per-partition counters — the same four fields the pooled summary reports. */
export interface ConvictionDcaBucket {
  addCount: number;
  breachCount: number;
  firstAddAt: number | null;
  lastAddAt: number | null;
}

/**
 * `unknown` is deliberate. A JSONL line predating (or violating) the assetClass
 * contract must NOT be silently folded into `equity` — that would manufacture
 * exactly the false positive this partition exists to kill. It lands in its own
 * bucket instead, so `equity + option + unknown === addCount` always holds and a
 * dropped/malformed class is VISIBLE rather than absorbed.
 */
export type ConvictionDcaClassKey = 'equity' | 'option' | 'unknown';
export type ConvictionDcaModeKey = 'demo' | 'live' | 'unknown';

export type ConvictionDcaClassBuckets = Record<ConvictionDcaClassKey, ConvictionDcaBucket>;
export type ConvictionDcaModeBuckets = Record<ConvictionDcaModeKey, ConvictionDcaBucket>;

function emptyBucket(): ConvictionDcaBucket {
  return { addCount: 0, breachCount: 0, firstAddAt: null, lastAddAt: null };
}

function emptyClassBuckets(): ConvictionDcaClassBuckets {
  return { equity: emptyBucket(), option: emptyBucket(), unknown: emptyBucket() };
}

function emptyModeBuckets(): ConvictionDcaModeBuckets {
  return { demo: emptyBucket(), live: emptyBucket(), unknown: emptyBucket() };
}

function classKeyOf(fill: ConvictionDcaFill): ConvictionDcaClassKey {
  return fill.assetClass === 'equity' || fill.assetClass === 'option' ? fill.assetClass : 'unknown';
}

function modeKeyOf(fill: ConvictionDcaFill): ConvictionDcaModeKey {
  return fill.mode === 'demo' || fill.mode === 'live' ? fill.mode : 'unknown';
}

/** Fold one fill into one bucket — same arithmetic as the pooled counters. */
function foldIntoBucket(bucket: ConvictionDcaBucket, fill: ConvictionDcaFill): void {
  bucket.addCount += 1;
  if (isBreach(fill)) bucket.breachCount += 1;
  if (bucket.firstAddAt == null || fill.ts < bucket.firstAddAt) bucket.firstAddAt = fill.ts;
  if (bucket.lastAddAt == null || fill.ts > bucket.lastAddAt) bucket.lastAddAt = fill.ts;
}

/** Copy the module buckets so a summary caller can never mutate ledger state. */
function cloneBuckets<K extends string>(
  buckets: Record<K, ConvictionDcaBucket>,
): Record<K, ConvictionDcaBucket> {
  const out = {} as Record<K, ConvictionDcaBucket>;
  for (const key of Object.keys(buckets) as K[]) out[key] = { ...buckets[key] };
  return out;
}

/** Re-derive both partitions over an explicit fill list (the anchored path). */
function foldBuckets(fills: readonly ConvictionDcaFill[]): {
  byClass: ConvictionDcaClassBuckets;
  byMode: ConvictionDcaModeBuckets;
} {
  const cls = emptyClassBuckets();
  const mode = emptyModeBuckets();
  for (const f of fills) {
    foldIntoBucket(cls[classKeyOf(f)], f);
    foldIntoBucket(mode[modeKeyOf(f)], f);
  }
  return { byClass: cls, byMode: mode };
}

// ── In-memory store (backs GET /api/health/conviction-dca) ───────────────────
//
// Module-global + observe-only. `dataDir` is set once at boot by
// hydrateConvictionDcaFromDisk so the deep fill site can append without threading
// a path through the SignalEngine. Counts are monotonic across the process life
// and are rebuilt from the full JSONL on boot, so they survive restart.

let dataDir: string | null = null;
let addCount = 0;
let breachCount = 0;
let firstAddAt: number | null = null;
let lastAddAt: number | null = null;
/**
 * TRA-2303 — ALL fills, capped at {@link MAX_RETAINED_FILLS}. The anchored branch
 * of the summary derives its counts from here, so this array's depth is what makes
 * an anchored count exact. The health `recent` tail is a 50-fill PROJECTION of it.
 */
const retainedFills: ConvictionDcaFill[] = [];
/** Fills evicted by the retention cap. > 0 ⇒ an anchored count may under-report. */
let droppedFills = 0;
let byClass = emptyClassBuckets();
let byMode = emptyModeBuckets();

export function convictionDcaLogPath(dir: string): string {
  return join(dir, CONVICTION_DCA_LOG_FILENAME);
}

/** Test seam — drop every fill + counter and the configured dir. */
export function clearConvictionDcaLedger(): void {
  dataDir = null;
  addCount = 0;
  breachCount = 0;
  firstAddAt = null;
  lastAddAt = null;
  retainedFills.length = 0;
  droppedFills = 0;
  byClass = emptyClassBuckets();
  byMode = emptyModeBuckets();
}

function isBreach(fill: ConvictionDcaFill): boolean {
  return fill.realizedRiskDollars > fill.riskBudget + BREACH_EPSILON;
}

/** Fold one fill into the in-memory counters + rolling tail (no IO). */
function applyFill(fill: ConvictionDcaFill): void {
  addCount += 1;
  if (isBreach(fill)) breachCount += 1;
  if (firstAddAt == null || fill.ts < firstAddAt) firstAddAt = fill.ts;
  if (lastAddAt == null || fill.ts > lastAddAt) lastAddAt = fill.ts;
  foldIntoBucket(byClass[classKeyOf(fill)], fill);
  foldIntoBucket(byMode[modeKeyOf(fill)], fill);
  retainedFills.push(fill);
  while (retainedFills.length > MAX_RETAINED_FILLS) {
    retainedFills.shift();
    droppedFills += 1;
    if (droppedFills === 1) {
      // Loud once: from here on an anchored summary reports countsExact:false, and
      // the TRA-971 gate must not be graded off it until retention is resized.
      log.warn('conviction-dca retention cap reached — anchored counts now inexact', {
        cap: MAX_RETAINED_FILLS,
        addCount,
      });
    }
  }
}

/**
 * Record one conviction-DCA add fill: update the in-memory store AND append one
 * JSONL line under the configured DATA_DIR. Best-effort on IO — a write failure
 * logs and is swallowed so this accounting can never break the trade pass. When
 * no dataDir is configured (unit tests / CLI without boot) the counters still
 * update; only the file write is skipped.
 */
export function recordConvictionDcaFill(fill: ConvictionDcaFill): void {
  applyFill(fill);
  if (dataDir == null) return;
  const path = convictionDcaLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendFileSync(path, JSON.stringify(fill) + '\n', 'utf8');
  } catch (err) {
    log.warn('conviction-dca fill append failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/** What {@link hydrateConvictionDcaFromDisk} recovered (for the boot log line). */
export interface ConvictionDcaHydration {
  addCount: number;
  breachCount: number;
  firstAddAt: number | null;
  lastAddAt: number | null;
  /** TRA-2265 — the same counts partitioned, rebuilt from the FULL JSONL. */
  byClass: ConvictionDcaClassBuckets;
  byMode: ConvictionDcaModeBuckets;
}

/**
 * Rebuild the in-memory store from disk on boot and remember `dir` for subsequent
 * appends. Idempotent: CLEARS first, so it is safe to call exactly once at startup
 * before any live pass. Reads the ENTIRE JSONL — each line is one terminal fill,
 * so `addCount` is exact and no snapshot is needed. Best-effort: a missing/corrupt
 * file yields an empty hydration (and a torn trailing line is skipped) rather than
 * throwing.
 */
export function hydrateConvictionDcaFromDisk(dir: string): ConvictionDcaHydration {
  clearConvictionDcaLedger();
  dataDir = dir;

  // TRA-1463 — boot-hydrate synchronous read+parse; wrap so a stall here is NAMED
  // in the watchdog trip breadcrumb (`slowPhase`).
  return timeSyncPhase('hydrate.convictionDca', () => {
    let raw = '';
    try {
      raw = readFileSync(convictionDcaLogPath(dir), 'utf8');
    } catch {
      raw = '';
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const fill = JSON.parse(trimmed) as ConvictionDcaFill;
        if (typeof fill.ts === 'number' && Number.isFinite(fill.realizedRiskDollars)) {
          applyFill(fill);
        }
      } catch {
        // skip a torn/partial trailing line rather than abort the hydrate
      }
    }

    return {
      addCount,
      breachCount,
      firstAddAt,
      lastAddAt,
      byClass: cloneBuckets(byClass),
      byMode: cloneBuckets(byMode),
    };
  });
}

/**
 * Resolve the configurable "since deploy" anchor (ms epoch) from
 * `CONVICTION_DCA_DEPLOY_ANCHOR` — an ISO string or a ms-epoch number. Unset or
 * unparseable ⇒ null (all-time counts; the ledger is created at deploy, so the
 * whole file already IS the since-deploy window). Env-driven so the TRA-1276
 * review can re-anchor without a redeploy.
 */
export function resolveConvictionDcaDeployAnchor(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env['CONVICTION_DCA_DEPLOY_ANCHOR'];
  if (raw == null || raw.trim() === '') return null;
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum > 0) return asNum;
  const asDate = Date.parse(raw);
  return Number.isFinite(asDate) ? asDate : null;
}

// ── Health summary ───────────────────────────────────────────────────────────

/**
 * TRA-2303 — what the reported counts were derived FROM. A reader grading the
 * TRA-971 promotion gate must be able to tell a complete count from a truncated
 * one; before this the two were indistinguishable.
 *   • `monotonic-full`     — no anchor: the boot-hydrated all-time counters (exact).
 *   • `retained-full`      — anchored, re-derived over retained fills, none evicted (exact).
 *   • `retained-truncated` — anchored, but the retention cap evicted fills that may
 *                            fall inside the window. Counts may UNDER-report.
 */
export type ConvictionDcaCountBasis = 'monotonic-full' | 'retained-full' | 'retained-truncated';

export interface ConvictionDcaSummary {
  /** Total add fills recorded since the deploy anchor (or all-time when unset). */
  addCount: number;
  /** Fills where realizedRiskDollars > riskBudget + ε — the R-cap breach count. */
  breachCount: number;
  /** ms epoch of the first / last recorded add (within the anchor window). */
  firstAddAt: number | null;
  lastAddAt: number | null;
  /** The deploy anchor applied to the counts (ms epoch), or null for all-time. */
  deployAnchor: number | null;
  /**
   * TRA-2265 — the SAME counts partitioned by asset class / book mode. Every key
   * is always present, so `byClass.equity.addCount: 0` is a stated zero. Sums
   * reconcile against the pooled counts in both branches:
   *   Σ byClass[*].addCount === addCount === Σ byMode[*].addCount
   * Observe-only: no decision path reads these.
   */
  byClass: ConvictionDcaClassBuckets;
  byMode: ConvictionDcaModeBuckets;
  /** TRA-2303 — what these counts were derived from. */
  countsBasis: ConvictionDcaCountBasis;
  /**
   * TRA-2303 — `false` ⇒ the retention cap evicted fills that may fall inside the
   * anchored window, so every count above is a LOWER BOUND. Do NOT grade the
   * TRA-971 gate off an inexact summary; resize retention (or drop the anchor,
   * which reads the exact monotonic counters) first.
   */
  countsExact: boolean;
  /** Fills held in memory (the anchored derivation's population). */
  retainedFillCount: number;
  /** Fills evicted by the retention cap — non-zero is what makes counts inexact. */
  droppedFillCount: number;
  /** Most-recent fills, oldest→newest — a DISPLAY tail, never a count basis. */
  recent: ConvictionDcaFill[];
}

/**
 * Fold the store into the read-only gate diagnostics. When `deployAnchor` (ms
 * epoch) is given, counts/tail are restricted to fills at/after it — the
 * configurable "since deploy" window the TRA-1276 review pulls. With no anchor
 * the whole ledger is summarized (the file is created at deploy, so it IS the
 * since-deploy window). Pure — no IO, no realized PnL.
 *
 * TRA-2303 — BOTH branches are exact over the full ledger. Check `countsExact`
 * before grading anything off an anchored result.
 */
export function summarizeConvictionDca(deployAnchor: number | null = null): ConvictionDcaSummary {
  if (deployAnchor == null) {
    // Both the pooled counts AND the partitions come from the monotonic
    // boot-hydrated counters here — i.e. the FULL JSONL, not the 50-fill tail.
    // Re-deriving byClass from `recentFills` would reproduce the very blindness
    // this partition exists to remove, at a new name.
    return {
      addCount,
      breachCount,
      firstAddAt,
      lastAddAt,
      deployAnchor: null,
      byClass: cloneBuckets(byClass),
      byMode: cloneBuckets(byMode),
      countsBasis: 'monotonic-full',
      countsExact: true,
      retainedFillCount: retainedFills.length,
      droppedFillCount: droppedFills,
      recent: retainedFills.slice(-MAX_RECENT_FILLS),
    };
  }
  // TRA-2303 — the monotonic counters can't be re-filtered by ts, so the anchored
  // branch re-derives. It derives over ALL retained fills, NOT the 50-fill display
  // tail: that tail spans ~1.5 days at the observed rate, so re-deriving over it
  // silently dropped every equity fill (all 3 landed on the ledger's first day) the
  // moment an anchor was set — reinstating, behind an env var, exactly the blindness
  // the TRA-2265 partition exists to remove. When retention itself has truncated,
  // `countsExact:false` below says so rather than serving a short count as complete.
  const anchored = retainedFills.filter((f) => f.ts >= deployAnchor);
  let breaches = 0;
  let first: number | null = null;
  let last: number | null = null;
  for (const f of anchored) {
    if (isBreach(f)) breaches += 1;
    if (first == null || f.ts < first) first = f.ts;
    if (last == null || f.ts > last) last = f.ts;
  }
  // Partitions re-derive over the SAME anchored population the pooled counts above
  // use, so the sum reconciliation holds in this branch too.
  const { byClass: anchoredByClass, byMode: anchoredByMode } = foldBuckets(anchored);
  return {
    addCount: anchored.length,
    breachCount: breaches,
    firstAddAt: first,
    lastAddAt: last,
    deployAnchor,
    byClass: anchoredByClass,
    byMode: anchoredByMode,
    countsBasis: droppedFills === 0 ? 'retained-full' : 'retained-truncated',
    // Deliberately conservative: ANY eviction marks the anchored counts inexact,
    // even though an anchor after the eviction boundary would still be exact.
    // That would rely on the JSONL being ts-ordered; a wrong "exact" is far worse
    // than a pessimistic one, so this fails closed on the retention question.
    countsExact: droppedFills === 0,
    retainedFillCount: retainedFills.length,
    droppedFillCount: droppedFills,
    recent: anchored.slice(-MAX_RECENT_FILLS),
  };
}
