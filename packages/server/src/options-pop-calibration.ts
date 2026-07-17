// TRA-2006 (TRA-2000, proposal item 2) — POP POST-CALIBRATION / SHRINKAGE LAYER.
//
// The problem this closes (TRA-2000 diagnosis): the stated probability-of-profit
// on an AI Options Idea is the LLM's free-form estimate (`options-research.ts`
// rule 5), journaled verbatim (`options-idea-journal.ts`) and NEVER derived from
// delta / credit-width / Black-Scholes nor recalibrated against realized results.
// The forward-test measures `popCalibrationGap = hitRate − avgPredictedPop`
// (`options-forward-test.ts`) after the fact but feeds nothing back. The measured
// result on bqb1's resolved cohort is a systematic ~17-pt OVERSTATEMENT (realized
// ≈ stated − 0.17), which fails the gate's ≤0.10 `pop_calibration` band.
//
// This module is the missing feedback loop: a pure map `statedPop → calibratedPop`
// fit on the RESOLVED journal. Two modes:
//   - `flat`      — interim −0.15 haircut, used until the sample clears the fit
//                   floor. A blunt de-bias that already pulls the gap toward zero.
//   - `isotonic`  — a MONOTONE (non-decreasing) fit `realized = f(stated)` via the
//                   Pool-Adjacent-Violators Algorithm on the resolved (pop, win)
//                   set, used once n ≥ the fit floor (default 43, the TRA-2000
//                   cohort size). Monotone by construction so a higher stated POP
//                   never maps to a lower calibrated POP.
//
// REFIT CADENCE. There is no persisted model: the fit is recomputed from the
// current resolved set every time `buildForwardTestReport` runs. As the report is
// rebuilt on each probe/roll-up read, the calibrator naturally "refits weekly (as
// the sample grows)" the spec asks for, with no stale-model drift.
//
// SHADOW-FIRST, FLAG-OFF. This layer is a pure MEASUREMENT by default: the report
// always surfaces the calibrated gap ALONGSIDE the raw one (audit retains both),
// but the live-capital gate keeps scoring the RAW gap until an operator sets
// `ENABLE_POP_CALIBRATION`. Nothing here wires capital or reorders the live feed;
// the ideas-ranking / entry-gate / idea-view consumers are armed only behind that
// flag, and only after QuantTrader signs off on the fit.
//
// ── HONEST CAVEAT (read before flipping the flag) ─────────────────────────────
// The fit is IN-SAMPLE: it trains on the same resolved set the report then scores,
// so a calibrated gap near 0 is expected BY CONSTRUCTION and is NOT out-of-sample
// evidence the map generalizes. It de-biases a known systematic overstatement —
// which is real and worth doing — but the calibrated `pop_calibration` metric
// clearing ≤0.10 must NOT be read as the strategy having found an edge. The gross
// R (TRA-1965: ~+0.01, flat) is the edge question and this layer does not touch
// it. QuantTrader validates the fit (ideally on a holdout / forward slice) before
// any default flip.

/** One resolved-idea observation the calibrator trains on. */
export interface PopCalibrationSample {
  /** The model's stated probability-of-profit at surface time (0..1). */
  pop: number;
  /** Realized outcome: true iff the resolved idea was a win (P/L > 0). */
  win: boolean;
}

/** Which fit produced the calibrator. */
export type PopCalibrationMode = 'flat' | 'isotonic';

/** One breakpoint of the isotonic map (empty for `flat`). Serializable for audit. */
export interface PopCalibrationKnot {
  /** Representative stated POP for this pooled block (block-mean, ascending). */
  stated: number;
  /** Fitted realized rate for the block (non-decreasing across knots). */
  calibrated: number;
}

/**
 * A fitted calibrator. A PLAIN DATA object (no methods) so it round-trips through
 * JSON for the audit probe; apply it with {@link calibratePop}.
 */
export interface PopCalibrator {
  mode: PopCalibrationMode;
  /** Resolved samples the fit trained on. */
  n: number;
  /** The flat haircut applied when `mode === 'flat'` (and as end-clamp context). */
  haircut: number;
  /** Sample floor at/above which the isotonic fit is used instead of the haircut. */
  minFitN: number;
  /** Isotonic breakpoints (ascending by `stated`); empty when `mode === 'flat'`. */
  knots: PopCalibrationKnot[];
}

// ── env config ────────────────────────────────────────────────────────────────

/**
 * Master switch for CONSUMING the calibrated POP (gate metric / ideas ranking /
 * idea view). OFF by default: the report still MEASURES and surfaces the
 * calibrated gap regardless, but the live-capital gate keeps scoring the raw gap
 * until an operator opts in — so a deploy changes no gate verdict or feed order.
 */
export const POP_CALIBRATION_FLAG = 'ENABLE_POP_CALIBRATION';
/** Operator-tunable interim haircut (default 0.15). */
export const POP_CALIBRATION_HAIRCUT_VAR = 'POP_CALIBRATION_HAIRCUT';
/** Operator-tunable isotonic fit floor (default 43 — the TRA-2000 cohort size). */
export const POP_CALIBRATION_MIN_FIT_N_VAR = 'POP_CALIBRATION_MIN_FIT_N';

/** Interim flat de-bias until the sample clears the isotonic fit floor. */
export const DEFAULT_POP_CALIBRATION_HAIRCUT = 0.15;
/** Resolved-sample floor at/above which the monotone isotonic fit kicks in. */
export const DEFAULT_POP_CALIBRATION_MIN_FIT_N = 43;

/** Fully-resolved calibration config (env-free; pure inputs to the fit). */
export interface PopCalibrationConfig {
  haircut: number;
  minFitN: number;
}

/** The shipped reference config. */
export const DEFAULT_POP_CALIBRATION_CONFIG: PopCalibrationConfig = {
  haircut: DEFAULT_POP_CALIBRATION_HAIRCUT,
  minFitN: DEFAULT_POP_CALIBRATION_MIN_FIT_N,
};

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** True iff calibrated POP should be CONSUMED (gate/ranking). Default false. */
export function isPopCalibrationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[POP_CALIBRATION_FLAG]);
}

function parseFloatIn(raw: string | undefined, lo: number, hi: number): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= lo && n <= hi ? n : undefined;
}

function parseIntAtLeast(raw: string | undefined, min: number): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= min ? n : undefined;
}

/**
 * Resolve the calibration config from env, each knob falling back to the shipped
 * default so an unset/malformed value preserves the reference behaviour. Haircut
 * is clamped to [0,1); fit floor to an integer ≥ 1.
 */
export function resolvePopCalibrationConfig(
  env: NodeJS.ProcessEnv = process.env,
): PopCalibrationConfig {
  return {
    haircut: parseFloatIn(env[POP_CALIBRATION_HAIRCUT_VAR], 0, 1) ?? DEFAULT_POP_CALIBRATION_HAIRCUT,
    minFitN: parseIntAtLeast(env[POP_CALIBRATION_MIN_FIT_N_VAR], 1) ?? DEFAULT_POP_CALIBRATION_MIN_FIT_N,
  };
}

// ── fit ─────────────────────────────────────────────────────────────────────

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const r4 = (v: number): number => Math.round(v * 10_000) / 10_000;

interface PavaBlock {
  sumX: number;
  sumY: number;
  n: number;
}

const blockValue = (b: PavaBlock): number => b.sumY / b.n;

/**
 * Isotonic (non-decreasing) regression by the Pool-Adjacent-Violators Algorithm.
 * `points` need not be pre-sorted. Returns pooled blocks in ascending-x order with
 * non-decreasing fitted values, collapsed to one knot per block (block-mean x →
 * block-mean y). Pure.
 */
function isotonicKnots(points: readonly { x: number; y: number }[]): PopCalibrationKnot[] {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const blocks: PavaBlock[] = [];
  for (const p of sorted) {
    blocks.push({ sumX: p.x, sumY: p.y, n: 1 });
    // Merge back while the previous block's fitted value exceeds this one's — the
    // adjacent-violators condition for a non-DECREASING fit.
    while (blocks.length >= 2 && blockValue(blocks[blocks.length - 2]!) > blockValue(blocks[blocks.length - 1]!)) {
      const last = blocks.pop()!;
      const prev = blocks[blocks.length - 1]!;
      prev.sumX += last.sumX;
      prev.sumY += last.sumY;
      prev.n += last.n;
    }
  }
  return blocks.map((b) => ({ stated: r4(b.sumX / b.n), calibrated: r4(clamp01(b.sumY / b.n)) }));
}

/**
 * Fit a POP calibrator on the resolved sample. Below `minFitN` (or when the fit
 * would collapse to a single degenerate knot) the calibrator is the interim flat
 * haircut; at/above it, the monotone isotonic map. Pure given `samples` +
 * `config`.
 */
export function fitPopCalibration(
  samples: readonly PopCalibrationSample[],
  config: PopCalibrationConfig = DEFAULT_POP_CALIBRATION_CONFIG,
): PopCalibrator {
  const usable = samples.filter((s) => Number.isFinite(s.pop));
  const n = usable.length;
  const base: PopCalibrator = {
    mode: 'flat',
    n,
    haircut: config.haircut,
    minFitN: config.minFitN,
    knots: [],
  };
  if (n < config.minFitN) return base;
  const knots = isotonicKnots(usable.map((s) => ({ x: clamp01(s.pop), y: s.win ? 1 : 0 })));
  // A single-knot fit carries no monotone signal (every stated POP maps to the
  // same base rate) — fall back to the flat haircut, which at least preserves the
  // stated ordering the ranking relies on.
  if (knots.length < 2) return base;
  return { ...base, mode: 'isotonic', knots };
}

// ── apply ─────────────────────────────────────────────────────────────────────

/**
 * Map a stated POP through the calibrator to its calibrated POP (0..1). `flat`
 * subtracts the haircut; `isotonic` piecewise-linearly interpolates between knots
 * with flat extrapolation past the ends. Pure; always returns a value in [0,1].
 */
export function calibratePop(calibrator: PopCalibrator, statedPop: number): number {
  const s = clamp01(Number.isFinite(statedPop) ? statedPop : 0);
  if (calibrator.mode === 'flat' || calibrator.knots.length < 2) {
    return clamp01(s - calibrator.haircut);
  }
  const knots = calibrator.knots;
  const first = knots[0]!;
  const last = knots[knots.length - 1]!;
  if (s <= first.stated) return clamp01(first.calibrated);
  if (s >= last.stated) return clamp01(last.calibrated);
  for (let i = 0; i < knots.length - 1; i++) {
    const a = knots[i]!;
    const b = knots[i + 1]!;
    if (s >= a.stated && s <= b.stated) {
      const span = b.stated - a.stated;
      const t = span > 0 ? (s - a.stated) / span : 0;
      return clamp01(a.calibrated + t * (b.calibrated - a.calibrated));
    }
  }
  return clamp01(last.calibrated); // unreachable given the guards above
}

// ── report summary (audit) ─────────────────────────────────────────────────────

/**
 * The audit block the forward-test report surfaces so raw-vs-calibrated POP is
 * inspectable and QuantTrader can sign off on the fit. Every field is diagnostic;
 * none of it changes a gate verdict unless `ENABLE_POP_CALIBRATION` is set.
 */
export interface PopCalibrationSummary {
  mode: PopCalibrationMode;
  /** Resolved samples the fit trained on. */
  n: number;
  /** Sample floor at/above which the isotonic fit replaces the flat haircut. */
  minFitN: number;
  /** The interim flat haircut in effect. */
  haircut: number;
  /** Mean RAW stated POP over the resolved set (null when none resolved). */
  avgStatedPop: number | null;
  /** Mean CALIBRATED POP over the resolved set (null when none resolved). */
  avgCalibratedPop: number | null;
  /** Realized hit-rate (null when none resolved). */
  hitRate: number | null;
  /** hitRate − avgStatedPop — the RAW gap the shipped gate scores. */
  rawGap: number | null;
  /** hitRate − avgCalibratedPop — the calibrated gap (SHADOW unless flag on). */
  calibratedGap: number | null;
  /** Isotonic breakpoints (empty for `flat`) — the fitted map, for audit. */
  knots: PopCalibrationKnot[];
  /** Reconciliation + honest in-sample caveat. */
  note: string;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

const CALIBRATION_NOTE =
  'TRA-2006 POP post-calibration. `avgCalibratedPop` maps each resolved idea\'s stated POP through the ' +
  'fit (flat −haircut below minFitN, else a monotone isotonic map) and averages it; `calibratedGap` = ' +
  'hitRate − avgCalibratedPop. Raw `avgStatedPop`/`rawGap` are retained for audit and the shipped gate. ' +
  'SHADOW: the gate scores the RAW gap unless ENABLE_POP_CALIBRATION is set. IN-SAMPLE CAVEAT: the fit ' +
  'trains on the same resolved set it is scored against, so a small calibrated gap is expected by ' +
  'construction and is NOT out-of-sample proof the map generalizes, nor proof of gross edge (TRA-1965).';

/**
 * Build the audit summary: fit the calibrator on the resolved samples and report
 * raw-vs-calibrated aggregate POP + gap. Pure given the samples + config.
 */
export function buildPopCalibrationSummary(
  samples: readonly PopCalibrationSample[],
  config: PopCalibrationConfig = DEFAULT_POP_CALIBRATION_CONFIG,
): PopCalibrationSummary {
  const calibrator = fitPopCalibration(samples, config);
  const usable = samples.filter((s) => Number.isFinite(s.pop));
  const n = usable.length;
  const wins = usable.filter((s) => s.win).length;
  const hitRate = n ? wins / n : null;
  const avgStatedPop = n ? usable.reduce((a, s) => a + clamp01(s.pop), 0) / n : null;
  const avgCalibratedPop = n
    ? usable.reduce((a, s) => a + calibratePop(calibrator, s.pop), 0) / n
    : null;
  return {
    mode: calibrator.mode,
    n,
    minFitN: config.minFitN,
    haircut: config.haircut,
    avgStatedPop: avgStatedPop == null ? null : r2(avgStatedPop),
    avgCalibratedPop: avgCalibratedPop == null ? null : r2(avgCalibratedPop),
    hitRate: hitRate == null ? null : r2(hitRate),
    rawGap: hitRate != null && avgStatedPop != null ? r2(hitRate - avgStatedPop) : null,
    calibratedGap: hitRate != null && avgCalibratedPop != null ? r2(hitRate - avgCalibratedPop) : null,
    knots: calibrator.knots,
    note: CALIBRATION_NOTE,
  };
}
