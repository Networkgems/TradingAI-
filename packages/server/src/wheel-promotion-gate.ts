// TRA-2028 (parent TRA-1966, spec TRA-2026) — the WHEEL PROMOTION GATE readout.
//
// This is the single place that combines the TRA-2026 promotion-gate criteria
// into a pass/fail/pending status the board reads before premium selling is ever
// allowed to touch live capital. It is a PURE report: it decides NOTHING, routes
// NOTHING, and flips NOTHING — live routing stays gated on TRA-382 regardless of
// what this says. It exists so "is the wheel allowed to scale?" has one auditable
// answer instead of a scatter of ledgers.
//
// The gate rule (TRA-2026 Part A + Part B), each criterion pass / fail / pending
// (pending = the forward book has not yet produced the evidence — an HONEST
// not-yet, never a silent pass):
//
//   A. IV-filter edge — the entered set's cost-net R-expectancy must beat the
//      unfiltered set on the forward book.
//   B1. Forward window contains a qualifying vol event (VIX ≥ 25 on ≥ 3 sessions
//       OR VIX up ≥ 30% peak-to-trough in a 5-session window) OR the synthetic +
//       historical-replay stress completed with ZERO defined-risk breaches.
//   B2. Synthetic shocks produced no position exceeding its defined-risk max and
//       no book-level breach of the 6% risk cap / 1× notional cap.
//   B3. ≥ 8 resolved LOSING trades logged, realized-vs-modeled max-loss ratio ≤ 1.0.
//   B4. Cost-net R-expectancy positive across the full window INCLUDING the
//       stressed stretch.
//
// `promotionEligible` is true only when EVERY criterion is `pass`. A single
// `fail` or `pending` keeps it false.

import type { WheelStressSuiteResult } from './wheel-vol-stress-harness.js';

// ── vol-event detection (TRA-2026 B1) ────────────────────────────────────────

/** One VIX close in the forward window. */
export interface VixSession {
  /** UTC calendar day `YYYY-MM-DD` (ascending order not required — sorted here). */
  day: string;
  close: number;
}

export interface VolEventConfig {
  /** VIX close at/above which a session counts as elevated. Default 25. */
  vixThreshold: number;
  /** Minimum elevated sessions for the threshold rule. Default 3. */
  minSessionsAtThreshold: number;
  /** Peak-to-trough rise fraction within the window for the spike rule. Default 0.30. */
  riseFraction: number;
  /** Trailing session window for the rise rule. Default 5. */
  riseWindowSessions: number;
}

export const DEFAULT_VOL_EVENT_CONFIG: VolEventConfig = {
  vixThreshold: 25,
  minSessionsAtThreshold: 3,
  riseFraction: 0.3,
  riseWindowSessions: 5,
};

export interface VolEventResult {
  qualifying: boolean;
  sessionsAtOrAboveThreshold: number;
  maxWindowRiseFraction: number;
  detail: string;
}

/**
 * Detect a qualifying vol event in the forward VIX window (TRA-2026 B1): VIX
 * closing ≥ threshold on ≥ N sessions, OR VIX rising ≥ `riseFraction`
 * peak-to-trough (trough BEFORE peak) within any `riseWindowSessions`-session
 * window. Pure.
 */
export function detectVolEvent(
  sessions: readonly VixSession[],
  config: VolEventConfig = DEFAULT_VOL_EVENT_CONFIG,
): VolEventResult {
  const closes = [...sessions]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((s) => s.close)
    .filter((c) => Number.isFinite(c) && c > 0);

  const sessionsAtOrAboveThreshold = closes.filter((c) => c >= config.vixThreshold).length;

  // Peak-to-trough rise within a sliding window: within each window, the largest
  // (later peak / earlier trough − 1). Only troughs that precede their peak count
  // as a genuine spike.
  let maxWindowRiseFraction = 0;
  const w = Math.max(2, config.riseWindowSessions);
  for (let i = 0; i < closes.length; i++) {
    const end = Math.min(closes.length, i + w);
    let trough = Infinity;
    for (let j = i; j < end; j++) {
      const c = closes[j]!;
      if (c < trough) trough = c;
      if (trough > 0 && Number.isFinite(trough)) {
        const rise = c / trough - 1;
        if (rise > maxWindowRiseFraction) maxWindowRiseFraction = rise;
      }
    }
  }

  const byThreshold = sessionsAtOrAboveThreshold >= config.minSessionsAtThreshold;
  const bySpike = maxWindowRiseFraction >= config.riseFraction;
  const qualifying = byThreshold || bySpike;

  const detail = qualifying
    ? `qualifying: ${byThreshold ? `${sessionsAtOrAboveThreshold} sessions ≥ ${config.vixThreshold}` : ''}${byThreshold && bySpike ? '; ' : ''}${bySpike ? `${Math.round(maxWindowRiseFraction * 100)}% ${config.riseWindowSessions}-session rise` : ''}`
    : `no qualifying vol event (${sessionsAtOrAboveThreshold}/${config.minSessionsAtThreshold} sessions ≥ ${config.vixThreshold}; max ${Math.round(maxWindowRiseFraction * 100)}% rise vs ${Math.round(config.riseFraction * 100)}% needed)`;

  return { qualifying, sessionsAtOrAboveThreshold, maxWindowRiseFraction: Math.round(maxWindowRiseFraction * 10_000) / 10_000, detail };
}

// ── the gate ─────────────────────────────────────────────────────────────────

export type CriterionStatus = 'pass' | 'fail' | 'pending';

export interface GateCriterion {
  key: string;
  status: CriterionStatus;
  detail: string;
}

export interface WheelPromotionGateConfig {
  /** Minimum resolved LOSING trades before scaling (TRA-2026 B3). Default 8. */
  minResolvedLosers: number;
  /** Max realized-vs-modeled max-loss ratio (TRA-2026 B3). Default 1.0. */
  maxRealizedModeledRatio: number;
}

export const DEFAULT_WHEEL_PROMOTION_GATE_CONFIG: WheelPromotionGateConfig = {
  minResolvedLosers: 8,
  maxRealizedModeledRatio: 1.0,
};

export interface WheelPromotionGateInputs {
  /** The stress-harness suite result over the current book. */
  stress: WheelStressSuiteResult;
  /** Forward-window vol-event detection. */
  volEvent: VolEventResult;
  /** Resolved losing-trade sufficiency (TRA-2026 B3). */
  resolvedLosers: {
    /** Count of resolved LOSING wheel trades. */
    count: number;
    /** realized max loss / modeled defined-risk max, averaged over losers; null when none. */
    realizedVsModeledMaxLossRatio: number | null;
  };
  /** Cost-net R-expectancy across the FULL window including the stressed stretch (null = not yet). */
  costNetRExpectancy: number | null;
  /** Part-A edge: entered-set vs unfiltered-set cost-net R on the forward book (null = not yet). */
  partA: {
    enteredCostNetR: number | null;
    unfilteredCostNetR: number | null;
  };
  config?: WheelPromotionGateConfig;
}

export interface WheelPromotionGateReport {
  /** True only when EVERY criterion is `pass`. */
  promotionEligible: boolean;
  criteria: GateCriterion[];
  note: string;
}

const GATE_NOTE =
  'TRA-2028 wheel promotion gate (TRA-2026). Observe-only readout: it decides and flips NOTHING — live ' +
  'premium-selling routing stays gated on TRA-382. `promotionEligible` requires EVERY criterion to pass; a ' +
  '`pending` means the forward book has not yet produced that evidence (an honest not-yet, never a silent ' +
  'pass). Criterion A is the IV-filter edge (entered beats unfiltered); B1/B2 are the vol-event/stress bar; ' +
  'B3 is loss-distribution sufficiency; B4 is positive cost-net R across the stressed window.';

/**
 * Build the promotion-gate report from the assembled evidence. Pure. Any missing
 * forward-book metric (null) yields `pending` for its criterion, so the gate can
 * never read `eligible` off absent data.
 */
export function buildWheelPromotionGate(inputs: WheelPromotionGateInputs): WheelPromotionGateReport {
  const cfg = inputs.config ?? DEFAULT_WHEEL_PROMOTION_GATE_CONFIG;
  const criteria: GateCriterion[] = [];

  // A — IV-filter edge: entered set beats the unfiltered set.
  {
    const { enteredCostNetR, unfilteredCostNetR } = inputs.partA;
    if (enteredCostNetR == null || unfilteredCostNetR == null) {
      criteria.push({
        key: 'A_iv_filter_edge',
        status: 'pending',
        detail: 'entered-vs-unfiltered cost-net R not yet measurable on the forward book',
      });
    } else {
      const pass = enteredCostNetR > unfilteredCostNetR;
      criteria.push({
        key: 'A_iv_filter_edge',
        status: pass ? 'pass' : 'fail',
        detail: `entered cost-net R ${enteredCostNetR} ${pass ? '>' : '≤'} unfiltered ${unfilteredCostNetR}`,
      });
    }
  }

  // B1 — qualifying vol event OR zero-breach synthetic+replay stress. Zero
  // breaches on an EMPTY book is vacuous (nothing was stressed), so a real
  // zero-breach pass requires positions — same bar as B2.
  {
    const stressComplete = inputs.stress.scenarios.length > 0;
    const hasBook = inputs.stress.positionCount > 0;
    const zeroBreach = stressComplete && hasBook && !inputs.stress.anyBreach;
    if (inputs.volEvent.qualifying) {
      criteria.push({ key: 'B1_vol_event_or_stress', status: 'pass', detail: `vol event ${inputs.volEvent.detail}` });
    } else if (zeroBreach) {
      criteria.push({ key: 'B1_vol_event_or_stress', status: 'pass', detail: 'no live vol event, but synthetic+replay stress completed with zero breaches' });
    } else if (!stressComplete || !hasBook) {
      criteria.push({ key: 'B1_vol_event_or_stress', status: 'pending', detail: 'no qualifying vol event and no book yet stressed (empty/idle)' });
    } else {
      criteria.push({ key: 'B1_vol_event_or_stress', status: 'fail', detail: `no vol event and stress tripped ${inputs.stress.definedRiskBreachCount} defined-risk breach(es) / a cap breach` });
    }
  }

  // B2 — synthetic shocks: no defined-risk breach, no cap breach.
  {
    const stressComplete = inputs.stress.scenarios.length > 0;
    if (!stressComplete) {
      criteria.push({ key: 'B2_defined_risk_holds', status: 'pending', detail: 'stress suite not yet run' });
    } else if (inputs.stress.positionCount === 0) {
      // Empty book — nothing to stress. Not proof of resilience; keep it pending.
      criteria.push({ key: 'B2_defined_risk_holds', status: 'pending', detail: 'book empty — no positions to stress (not evidence of resilience)' });
    } else {
      const pass = !inputs.stress.anyBreach;
      criteria.push({
        key: 'B2_defined_risk_holds',
        status: pass ? 'pass' : 'fail',
        detail: pass
          ? `all ${inputs.stress.positionCount} positions held defined risk across ${inputs.stress.scenarios.length} scenarios`
          : `${inputs.stress.definedRiskBreachCount} defined-risk breach(es) / cap breach across the suite`,
      });
    }
  }

  // B3 — ≥ 8 resolved losers, realized/modeled max-loss ratio ≤ 1.0.
  {
    const { count, realizedVsModeledMaxLossRatio } = inputs.resolvedLosers;
    if (count < cfg.minResolvedLosers || realizedVsModeledMaxLossRatio == null) {
      criteria.push({
        key: 'B3_loss_distribution',
        status: 'pending',
        detail: `${count}/${cfg.minResolvedLosers} resolved losers${realizedVsModeledMaxLossRatio == null ? ' (max-loss ratio not yet measurable)' : ''}`,
      });
    } else {
      const pass = realizedVsModeledMaxLossRatio <= cfg.maxRealizedModeledRatio;
      criteria.push({
        key: 'B3_loss_distribution',
        status: pass ? 'pass' : 'fail',
        detail: `${count} resolved losers, realized/modeled max-loss ratio ${realizedVsModeledMaxLossRatio} ${pass ? '≤' : '>'} ${cfg.maxRealizedModeledRatio}`,
      });
    }
  }

  // B4 — positive cost-net R across the stressed window.
  {
    const r = inputs.costNetRExpectancy;
    if (r == null) {
      criteria.push({ key: 'B4_cost_net_r_positive', status: 'pending', detail: 'cost-net R across the stressed window not yet measurable' });
    } else {
      const pass = r > 0;
      criteria.push({ key: 'B4_cost_net_r_positive', status: pass ? 'pass' : 'fail', detail: `cost-net R-expectancy ${r} across the stressed window` });
    }
  }

  const promotionEligible = criteria.every((c) => c.status === 'pass');
  return { promotionEligible, criteria, note: GATE_NOTE };
}
