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

/** Rolling recent-fills retention for the health tail (counts stay complete). */
const MAX_RECENT_FILLS = 50;

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
const recentFills: ConvictionDcaFill[] = [];

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
  recentFills.length = 0;
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
  recentFills.push(fill);
  while (recentFills.length > MAX_RECENT_FILLS) recentFills.shift();
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

    return { addCount, breachCount, firstAddAt, lastAddAt };
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
  /** Most-recent fills, oldest→newest (capped tail). */
  recent: ConvictionDcaFill[];
}

/**
 * Fold the store into the read-only gate diagnostics. When `deployAnchor` (ms
 * epoch) is given, counts/tail are restricted to fills at/after it — the
 * configurable "since deploy" window the TRA-1276 review pulls. With no anchor
 * the whole ledger is summarized (the file is created at deploy, so it IS the
 * since-deploy window). Pure — no IO, no realized PnL.
 */
export function summarizeConvictionDca(deployAnchor: number | null = null): ConvictionDcaSummary {
  if (deployAnchor == null) {
    return {
      addCount,
      breachCount,
      firstAddAt,
      lastAddAt,
      deployAnchor: null,
      recent: recentFills.slice(-MAX_RECENT_FILLS),
    };
  }
  // Anchor filter reads only the rolling tail for the recent list; the monotonic
  // counters can't be re-filtered post-cap, so re-derive over the retained tail.
  // (Add fills are rare enough that the tail holds the full anchored window in
  // practice; the monotonic all-time counts remain available at deployAnchor:null.)
  const anchored = recentFills.filter((f) => f.ts >= deployAnchor);
  let breaches = 0;
  let first: number | null = null;
  let last: number | null = null;
  for (const f of anchored) {
    if (isBreach(f)) breaches += 1;
    if (first == null || f.ts < first) first = f.ts;
    if (last == null || f.ts > last) last = f.ts;
  }
  return {
    addCount: anchored.length,
    breachCount: breaches,
    firstAddAt: first,
    lastAddAt: last,
    deployAnchor,
    recent: anchored.slice(-MAX_RECENT_FILLS),
  };
}
