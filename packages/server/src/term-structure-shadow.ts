import type { TermStructureDislocation } from '@trading-app/engine';
import { logger } from './observability/index.js';
import type { DtePrefs, RelativeValueScannerService } from './relative-value-scanner.js';

// TRA-4413 item 4 (parent TRA-4412) — flag-gated SHADOW wiring for the
// cross-expiration term-structure pass.
//
// The engine fold (`findTermStructureDislocations`) and its scanner transport
// (`scanTermStructure`) are both pure/observe-only; this module is the server
// seam that (a) reads the sub-flag, (b) throttles captures so the extra
// per-symbol chain fetches stay a rounding error against the Tradier budget,
// and (c) accumulates the COUNTERS the ticket's acceptance bar demands — every
// suppression and every finding lands in a low-cardinality bucket, because a
// suppression that ships no counter is unmeasurable. NOTHING here routes an
// order, touches sizing, or influences an exit: $0 live, default OFF.
//
// Negative-control discipline (the `otm-theo-arbitrage.ts` TRA-2669 pattern):
// a scan whose mark-surface calendar control reports ANY violation has proven
// its own inputs incoherent, so its dislocations are counted under
// `invalidatedScans` and NOT folded into the finding counters. The violation
// count and a latch timestamp are published either way — a control that fires
// silently is no control.

const log = logger.child({ module: 'term-structure-shadow' });

/**
 * Sub-flag, default OFF (ships dark; the board's TRA-4421 policy card governs
 * anything beyond observe). Independent of the exec flag on purpose: this
 * capture grades chains, not entries, so it must be armable while every
 * entry path stays cold.
 */
export const TERM_STRUCTURE_SHADOW_FLAG = 'ENABLE_TERM_STRUCTURE_SHADOW';

export function isTermStructureShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[TERM_STRUCTURE_SHADOW_FLAG];
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * Per-symbol capture cadence. Term-structure dislocation is a slow read (the
 * √T fit moves with the surface, not the tape) and each capture costs up to
 * MAX_TERM_EXPIRATIONS−1 extra chain fetches beyond the scan that triggered
 * it, so one capture per symbol per 15 minutes bounds the upstream cost at
 * ~0.2 calls/min for a 15-symbol roster — noise against the 60/min sandbox cap.
 */
export const TERM_SHADOW_MIN_INTERVAL_MS = 15 * 60_000;

/** Bounded sample so the health surface can show WHAT flagged, not just counts. */
const MAX_RECENT_DISLOCATIONS = 20;

interface TermShadowState {
  scans: number;
  /** Scan-level outcomes, incl. 'ok' — the denominator publishes itself. */
  scansByReason: Record<string, number>;
  /** Captures suppressed by the per-symbol throttle (not scans — never fetched). */
  throttledSkips: number;
  /** Captures dropped because the wired scanner lacks `scanTermStructure`. */
  unsupportedScanner: number;
  /** Unexpected throws out of the capture path (the module never rethrows). */
  errors: number;
  rowsEvaluated: number;
  bucketsFitted: number;
  dislocationsByClass: { term_cheap: number; term_rich: number };
  bucketSkipsByReason: { insufficient_expirations: number; degenerate_time_axis: number };
  calendarPairsTested: number;
  markCalendarViolations: number;
  /** Scans voided by a non-zero mark-calendar control; their findings are NOT counted. */
  invalidatedScans: number;
  lastViolationAt: number | null;
  lastScan: {
    symbol: string;
    at: number;
    reason: string;
    expirations: string[];
    rowsEvaluated: number;
    dislocations: number;
    markCalendarViolations: number;
  } | null;
  recentDislocations: Array<TermStructureDislocation & { capturedAt: number }>;
  lastCaptureAtBySymbol: Map<string, number>;
}

function freshState(): TermShadowState {
  return {
    scans: 0,
    scansByReason: {},
    throttledSkips: 0,
    unsupportedScanner: 0,
    errors: 0,
    rowsEvaluated: 0,
    bucketsFitted: 0,
    dislocationsByClass: { term_cheap: 0, term_rich: 0 },
    bucketSkipsByReason: { insufficient_expirations: 0, degenerate_time_axis: 0 },
    calendarPairsTested: 0,
    markCalendarViolations: 0,
    invalidatedScans: 0,
    lastViolationAt: null,
    lastScan: null,
    recentDislocations: [],
    lastCaptureAtBySymbol: new Map(),
  };
}

let state = freshState();

/** Test seam. */
export function __resetTermStructureShadow(): void {
  state = freshState();
}

export interface TermStructureShadowCaptureArgs {
  symbol: string;
  scanner: RelativeValueScannerService;
  dtePrefs?: DtePrefs;
  /** The spot the triggering scan just resolved — saves the second quote call. */
  spot?: number | null;
  env?: NodeJS.ProcessEnv;
  now?: number;
}

/**
 * Fire one flag-gated, throttled term-structure shadow capture. Never throws
 * and never blocks the caller's decision path — scan loops `void` it.
 */
export async function maybeCaptureTermStructureShadow(
  args: TermStructureShadowCaptureArgs,
): Promise<void> {
  try {
    if (!isTermStructureShadowEnabled(args.env)) return;
    const scanner = args.scanner;
    if (typeof scanner.scanTermStructure !== 'function') {
      state.unsupportedScanner += 1;
      return;
    }
    const now = args.now ?? Date.now();
    const symbol = args.symbol.trim().toUpperCase();
    const lastAt = state.lastCaptureAtBySymbol.get(symbol);
    if (lastAt != null && now - lastAt < TERM_SHADOW_MIN_INTERVAL_MS) {
      state.throttledSkips += 1;
      return;
    }
    // Stamp BEFORE the await so two overlapping ticks cannot double-capture.
    state.lastCaptureAtBySymbol.set(symbol, now);

    const result = await scanner.scanTermStructure(symbol, args.dtePrefs, { spot: args.spot });
    state.scans += 1;
    state.scansByReason[result.reason] = (state.scansByReason[result.reason] ?? 0) + 1;
    const report = result.reason === 'ok' ? result.report : null;
    state.lastScan = {
      symbol,
      at: now,
      reason: result.reason,
      expirations: result.expirations,
      rowsEvaluated: report?.rowsEvaluated ?? 0,
      dislocations: report?.dislocations.length ?? 0,
      markCalendarViolations: report?.markCalendarViolations.length ?? 0,
    };
    if (!report) return;

    state.rowsEvaluated += report.rowsEvaluated;
    state.bucketsFitted += report.bucketsFitted;
    state.calendarPairsTested += report.calendarPairsTested;
    for (const skip of report.bucketsSkipped) {
      state.bucketSkipsByReason[skip.reason] += 1;
    }

    if (report.markCalendarViolations.length > 0) {
      // Control fired ⇒ the scan's own inputs are incoherent; report loudly,
      // count nothing as a finding.
      state.markCalendarViolations += report.markCalendarViolations.length;
      state.invalidatedScans += 1;
      state.lastViolationAt = now;
      log.warn('term-structure shadow scan INVALIDATED by mark-calendar control', {
        symbol,
        violations: report.markCalendarViolations.length,
        dislocationsDiscarded: report.dislocations.length,
      });
      return;
    }

    for (const d of report.dislocations) {
      state.dislocationsByClass[d.classification] += 1;
      state.recentDislocations.push({ ...d, capturedAt: now });
    }
    if (state.recentDislocations.length > MAX_RECENT_DISLOCATIONS) {
      state.recentDislocations.splice(
        0,
        state.recentDislocations.length - MAX_RECENT_DISLOCATIONS,
      );
    }
  } catch (err) {
    state.errors += 1;
    log.warn('term-structure shadow capture failed', {
      symbol: args.symbol,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The health-route read surface (`/api/health/term-structure-shadow`). */
export function summarizeTermStructureShadow(env: NodeJS.ProcessEnv = process.env) {
  return {
    flag: TERM_STRUCTURE_SHADOW_FLAG,
    enabled: isTermStructureShadowEnabled(env),
    minIntervalMs: TERM_SHADOW_MIN_INTERVAL_MS,
    scans: state.scans,
    scansByReason: { ...state.scansByReason },
    throttledSkips: state.throttledSkips,
    unsupportedScanner: state.unsupportedScanner,
    errors: state.errors,
    rowsEvaluated: state.rowsEvaluated,
    bucketsFitted: state.bucketsFitted,
    dislocationsByClass: { ...state.dislocationsByClass },
    bucketSkipsByReason: { ...state.bucketSkipsByReason },
    calendarPairsTested: state.calendarPairsTested,
    markCalendarViolations: state.markCalendarViolations,
    invalidatedScans: state.invalidatedScans,
    lastViolationAt:
      state.lastViolationAt == null ? null : new Date(state.lastViolationAt).toISOString(),
    lastScan:
      state.lastScan == null
        ? null
        : { ...state.lastScan, at: new Date(state.lastScan.at).toISOString() },
    recentDislocations: state.recentDislocations.map((d) => ({
      ...d,
      capturedAt: new Date(d.capturedAt).toISOString(),
    })),
  };
}
