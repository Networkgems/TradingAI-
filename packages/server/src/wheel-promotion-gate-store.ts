// TRA-2028 (parent TRA-1966, spec TRA-2026) — the process-global store + summary
// builder backing `GET /api/health/wheel-promotion-gate`.
//
// Mirrors the observe-only in-memory store pattern used by the short-premium /
// IV-RV scanners: the wheel cycle records the CURRENT paper book snapshot each
// pass (positions + equity), and the read-only health surface folds that with the
// IV-filter ledger and the promotion-gate rule into one auditable readout. Holds
// no balances/PII beyond the demo book's own defined-risk figures; carries no
// order path. Live premium selling stays gated on TRA-382.

import {
  runWheelStressSuite,
  DEFAULT_STRESS_CAPS,
  type StressCaps,
  type WheelBookPosition,
  type WheelStressSuiteResult,
} from './wheel-vol-stress-harness.js';
import {
  buildWheelPromotionGate,
  detectVolEvent,
  DEFAULT_VOL_EVENT_CONFIG,
  DEFAULT_WHEEL_PROMOTION_GATE_CONFIG,
  type VixSession,
  type VolEventConfig,
  type WheelPromotionGateConfig,
  type WheelPromotionGateReport,
} from './wheel-promotion-gate.js';
import {
  summarizeWheelIvEntries,
  type WheelIvEntrySummary,
} from './wheel-iv-entry-filter.js';

// ── snapshot store ────────────────────────────────────────────────────────────

interface BookSnapshot {
  positions: WheelBookPosition[];
  equityUsd: number;
  recordedAt: number;
}

/** Snapshots older than this read as "no fresh book" (the wheel pass is idle). */
const SNAPSHOT_TTL_MS = 30 * 60_000;

let snapshot: BookSnapshot | null = null;

/**
 * Record the latest wheel book snapshot (latest-wins). Called once per wheel
 * cycle with the account's current covered writes + assigned lots mapped to the
 * harness shape, and its equity. Observe-only — no snapshot means the surface
 * reports an empty book (honest pending), never a 404.
 */
export function recordWheelBookSnapshot(
  positions: readonly WheelBookPosition[],
  equityUsd: number,
  now: number = Date.now(),
): void {
  snapshot = { positions: [...positions], equityUsd, recordedAt: now };
}

/** Test seam — drop the recorded snapshot. */
export function clearWheelBookSnapshot(): void {
  snapshot = null;
}

/** The fresh (within-TTL) book snapshot, or an empty book when idle/absent. */
function freshSnapshot(now: number): { positions: WheelBookPosition[]; equityUsd: number; ageMs: number | null } {
  if (snapshot && now - snapshot.recordedAt < SNAPSHOT_TTL_MS) {
    return { positions: snapshot.positions, equityUsd: snapshot.equityUsd, ageMs: now - snapshot.recordedAt };
  }
  return { positions: [], equityUsd: 0, ageMs: null };
}

// ── resolved-book metrics (injected; default pending) ─────────────────────────

/**
 * The forward-book metrics the gate needs but that only exist once resolved wheel
 * trades accrue: the Part-A entered-vs-unfiltered edge, the ≥8-loser sufficiency,
 * and the cost-net R across the stressed window. Sourced from the option trade
 * journal (wheel archetypes) by the caller; all default to the honest not-yet
 * (null / 0) so the gate reads `pending` on an empty forward book rather than
 * fabricating a pass. Wiring the journal join is a follow-up; the mechanism is
 * here so it drops in without touching the gate logic.
 */
export interface WheelResolvedBookMetrics {
  vixSessions: readonly VixSession[];
  resolvedLosers: { count: number; realizedVsModeledMaxLossRatio: number | null };
  costNetRExpectancy: number | null;
  partA: { enteredCostNetR: number | null; unfilteredCostNetR: number | null };
}

export const EMPTY_RESOLVED_BOOK_METRICS: WheelResolvedBookMetrics = {
  vixSessions: [],
  resolvedLosers: { count: 0, realizedVsModeledMaxLossRatio: null },
  costNetRExpectancy: null,
  partA: { enteredCostNetR: null, unfilteredCostNetR: null },
};

// ── summary ───────────────────────────────────────────────────────────────────

export interface WheelPromotionGateSummary {
  /** True iff the IV-entry filter is ENFORCING (else observe-only). */
  ivFilterEnabled: boolean;
  /** Book snapshot age in ms, or null when no fresh book (wheel pass idle/off). */
  bookSnapshotAgeMs: number | null;
  ivEntries: WheelIvEntrySummary;
  stress: WheelStressSuiteResult;
  gate: WheelPromotionGateReport;
}

export interface WheelPromotionGateSummaryOptions {
  now?: number;
  ivFilterEnabled?: boolean;
  caps?: StressCaps;
  volEventConfig?: VolEventConfig;
  gateConfig?: WheelPromotionGateConfig;
  resolved?: WheelResolvedBookMetrics;
}

/**
 * Fold the IV-filter ledger, the stress suite over the recorded book, and the
 * promotion-gate rule into the health readout. Pure beyond the injected clock and
 * the process-global stores. On an empty/idle book the stress suite is a
 * zero-breach empty result and the gate criteria are `pending` — an honest
 * not-yet, never a silent pass.
 */
export function buildWheelPromotionGateSummary(
  options: WheelPromotionGateSummaryOptions = {},
): WheelPromotionGateSummary {
  const now = options.now ?? Date.now();
  const ivFilterEnabled = options.ivFilterEnabled ?? false;
  const caps = options.caps ?? DEFAULT_STRESS_CAPS;
  const resolved = options.resolved ?? EMPTY_RESOLVED_BOOK_METRICS;

  const { positions, equityUsd, ageMs } = freshSnapshot(now);
  const stress = runWheelStressSuite(positions, equityUsd, caps);
  const volEvent = detectVolEvent(resolved.vixSessions, options.volEventConfig ?? DEFAULT_VOL_EVENT_CONFIG);

  const gate = buildWheelPromotionGate({
    stress,
    volEvent,
    resolvedLosers: resolved.resolvedLosers,
    costNetRExpectancy: resolved.costNetRExpectancy,
    partA: resolved.partA,
    config: options.gateConfig ?? DEFAULT_WHEEL_PROMOTION_GATE_CONFIG,
  });

  return {
    ivFilterEnabled,
    bookSnapshotAgeMs: ageMs,
    ivEntries: summarizeWheelIvEntries(ivFilterEnabled, now),
    stress,
    gate,
  };
}
