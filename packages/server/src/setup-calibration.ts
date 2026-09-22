// TRA-4779 (parent TRA-4645) — Setup Scoring & Confidence Calibration.
//
// Ranks setups by HISTORICAL EXPECTANCY AFTER FEES/SLIPPAGE, not by indicator
// agreement, and produces the calibrated confidence verdict the TRA-4649 card
// reserved (`TradeOpportunityCard.confidence`, null by construction until this
// module says otherwise).
//
// DESIGN CONSTRAINTS (the traps this module exists to not re-create):
//  - COSTS ARE CHARGED PER ROW, INSIDE THE FOLD (TRA-4578). A cost charged to a
//    subset of rows moves the SE, not just the mean, so `mean − c·(charged/n)`
//    at render time gets the deciding half of `mean − 1.96·SE` wrong. Every
//    record carries its own `grossR`/`costR`; `netR = grossR − costR` is formed
//    while the individual values still exist, and every downstream statistic is
//    folded over the per-row nets.
//  - A ROW WITHOUT A READABLE COST IS EXCLUDED AND COUNTED, NEVER ZERO-CHARGED.
//    Demo realized R is GROSS of spread (`demoSlippagePct: 0`), so treating an
//    uncharged row as cost 0 reproduces exactly the defect this issue closes
//    (a "net" number byte-identical to the gross one). Same rule as the
//    cost-aware ledger's zero-fill lesson (TRA-4439): no silent substitution —
//    `excluded.unchargedCost` is the counter, and absent is not zero.
//  - WIN IS DECIDED ON NET R, not gross. A +0.30R gross winner with 0.40R of
//    round-trip cost is a LOSS. Win rates computed on gross R overstate every
//    setup whose edge is smaller than its costs.
//  - CONFIDENCE IS SHOWN ONLY WHEN VALIDATED. `confidenceFor` returns a verdict
//    only when the backing cell (a) clears the ≥30-instance acceptance floor,
//    (b) survives a CHRONOLOGICAL out-of-sample split (the held-out tail's win
//    rate falls inside the training window's Wilson 95% interval), and (c) the
//    stated win probabilities, where the records carry any, are honest out of
//    sample (|mean stated − realized| ≤ 0.10 on the held-out tail — the same
//    band the live-capital gate's `pop_calibration` metric uses). Anything
//    less returns null with named reasons. The DISPLAYED number is the Wilson
//    LOWER bound of the measured win rate — a conservative, measured claim —
//    never the model's own stated probability (the TRA-2006 lesson: stated POP
//    ran ~17 pts hot; the PAVA recalibration layer in options-pop-calibration
//    maps stated→realized, this module simply refuses to display stated).
//  - REGIME CONDITIONING FAILS CLOSED TO POOLED. A regime cell is used only
//    when that cell independently clears the floor and its own OOS validation;
//    otherwise the pooled cell (if IT validates) with `basis: 'pooled'` stamped
//    on the verdict, so a consumer can always see which population backed the
//    number.
//  - Statistics conventions match the shipped tape-expectancy fold
//    (option-tape-expectancy.ts): sample SD (n−1), SE = sd/√n (null at n<2),
//    lowerCI95 = mean − 1.96·SE, and `calibrated ⟺ n ≥ 30` — the acceptance
//    floor stated on TRA-4779 verbatim.
//
// This module DECIDES NOTHING about capital. It measures, ranks and labels;
// admission stays with the cost bar and the TRA-4651 lifecycle gates.

// ── Input record ────────────────────────────────────────────────────────────

export type CostSource = 'sampled' | 'modelled';

/**
 * One resolved historical instance of a setup. The adapter that extracts these
 * from a journal is responsible for stating where the cost number came from —
 * a record that cannot name a `costSource` is an UNCHARGED row and will be
 * excluded (and counted), because its gross R is not comparable to a net one.
 */
export interface SetupOutcomeRecord {
  /** Setup identity — the signal `type` (registry key of the card system). */
  setupKey: string;
  /** Resolution wall-clock (epoch ms) — the chronological OOS split key. */
  closedAt: number;
  /** Realized R multiple BEFORE costs. */
  grossR: number | null;
  /** Round-trip cost (fees + slippage/spread) in the trade's own R units. */
  costR: number | null;
  /** Where `costR` came from. null ⇒ the row is uncharged ⇒ excluded+counted. */
  costSource: CostSource | null;
  /** Reward/risk predicted at emission (card `targets` field), if recorded. */
  predictedRR: number | null;
  /** Stated win probability at emission (0..1), if the setup emits one. */
  predictedWinProb: number | null;
  /** Market regime label at entry (adapter-defined vocabulary), if known. */
  regime: string | null;
}

// ── Config ──────────────────────────────────────────────────────────────────

export interface SetupCalibrationConfig {
  /** Acceptance floor: a cell is `calibrated` only at n ≥ this. */
  minInstances: number;
  /** Chronological tail share held out for validation. */
  oosFraction: number;
  /** The held-out tail must have at least this many rows to validate. */
  minOosInstances: number;
  /** Max |mean stated winProb − realized win rate| on the held-out tail. */
  maxOosCalibrationGap: number;
  /** Two-sided 95% z — matches the tape-expectancy fold. */
  z95: number;
  /** predictedRR floor below which realized/predicted ratios are not formed. */
  minPredictedRR: number;
}

export const DEFAULT_SETUP_CALIBRATION_CONFIG: SetupCalibrationConfig = {
  minInstances: 30,
  oosFraction: 0.3,
  minOosInstances: 9,
  maxOosCalibrationGap: 0.1,
  z95: 1.96,
  minPredictedRR: 0.05,
};

// ── Exclusion counters (fail-null bookkeeping, never silent) ────────────────

export interface SetupExclusionCounters {
  /** grossR absent/non-finite. */
  nonFiniteGrossR: number;
  /** costR present-but-non-finite while a source was claimed. */
  nonFiniteCostR: number;
  /** No `costSource` — the demo-gross trap; NEVER charged as zero. */
  unchargedCost: number;
  /** closedAt non-finite — unplaceable in time ⇒ cannot join an OOS split. */
  nonFiniteClosedAt: number;
}

function emptyExclusions(): SetupExclusionCounters {
  return { nonFiniteGrossR: 0, nonFiniteCostR: 0, unchargedCost: 0, nonFiniteClosedAt: 0 };
}

// ── Admitted row (internal) ─────────────────────────────────────────────────

interface AdmittedRow {
  closedAt: number;
  netR: number;
  grossR: number;
  costR: number;
  predictedRR: number | null;
  predictedWinProb: number | null;
  regime: string | null;
}

function fin(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Admit/exclude one record; excluded rows increment exactly one counter. */
function admit(rec: SetupOutcomeRecord, excl: SetupExclusionCounters): AdmittedRow | null {
  if (!fin(rec.closedAt)) {
    excl.nonFiniteClosedAt += 1;
    return null;
  }
  if (!fin(rec.grossR)) {
    excl.nonFiniteGrossR += 1;
    return null;
  }
  if (rec.costSource === null || rec.costSource === undefined) {
    excl.unchargedCost += 1;
    return null;
  }
  if (!fin(rec.costR)) {
    excl.nonFiniteCostR += 1;
    return null;
  }
  return {
    closedAt: rec.closedAt,
    // THE fold step of TRA-4578: the charge lands on the individual value.
    netR: rec.grossR - rec.costR,
    grossR: rec.grossR,
    costR: rec.costR,
    predictedRR: fin(rec.predictedRR) ? rec.predictedRR : null,
    predictedWinProb:
      fin(rec.predictedWinProb) && rec.predictedWinProb >= 0 && rec.predictedWinProb <= 1
        ? rec.predictedWinProb
        : null,
    regime: typeof rec.regime === 'string' && rec.regime.length > 0 ? rec.regime : null,
  };
}

// ── Statistics helpers ──────────────────────────────────────────────────────

function meanOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, v) => a + v, 0) / values.length;
}

interface MeanStats {
  n: number;
  mean: number | null;
  sd: number | null;
  se: number | null;
  lowerCI95: number | null;
}

/** Sample-SD mean stats, identical conventions to the tape-expectancy fold. */
function meanStats(values: readonly number[], z95: number): MeanStats {
  const n = values.length;
  const mean = meanOf(values);
  if (mean === null) return { n, mean: null, sd: null, se: null, lowerCI95: null };
  const sd =
    n > 1 ? Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : null;
  const se = sd !== null ? sd / Math.sqrt(n) : null;
  return { n, mean, sd, se, lowerCI95: se !== null ? mean - z95 * se : null };
}

/**
 * Wilson score 95% interval for a binomial proportion — well-behaved at the
 * small n this fold actually sees, unlike the normal approximation.
 */
export function wilson95(wins: number, n: number, z = 1.96): [number, number] | null {
  if (n <= 0 || wins < 0 || wins > n) return null;
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

// ── Per-cell fold ───────────────────────────────────────────────────────────

export interface SetupExpectancyCell {
  n: number;
  wins: number;
  /** Win decided on NET R (> 0), never gross. null at n = 0. */
  winRate: number | null;
  winRateCI95: [number, number] | null;
  meanGrossR: number | null;
  /** Mean per-row cost actually charged — the fees/slippage impact readout. */
  meanCostR: number | null;
  meanNetR: number | null;
  sdNetR: number | null;
  seNetR: number | null;
  /** `meanNetR − 1.96·seNetR` — the ranking score and the conservative claim. */
  lowerCI95NetR: number | null;
  /** Realized-vs-predicted R/R: per-row netR/predictedRR where predicted ≥ floor. */
  meanRealizedOverPredictedRR: number | null;
  nRealizedOverPredictedRR: number;
  meanPredictedRR: number | null;
  nPredictedRR: number;
  /** THE acceptance floor: n ≥ config.minInstances. */
  calibrated: boolean;
}

function foldCell(rows: readonly AdmittedRow[], cfg: SetupCalibrationConfig): SetupExpectancyCell {
  const nets = rows.map((r) => r.netR);
  const stats = meanStats(nets, cfg.z95);
  const wins = rows.filter((r) => r.netR > 0).length;
  const predicted = rows.map((r) => r.predictedRR).filter(fin);
  const ratios = rows
    .filter((r) => r.predictedRR !== null && r.predictedRR >= cfg.minPredictedRR)
    .map((r) => r.netR / (r.predictedRR as number));
  return {
    n: rows.length,
    wins,
    winRate: rows.length > 0 ? wins / rows.length : null,
    winRateCI95: wilson95(wins, rows.length, cfg.z95),
    meanGrossR: meanOf(rows.map((r) => r.grossR)),
    meanCostR: meanOf(rows.map((r) => r.costR)),
    meanNetR: stats.mean,
    sdNetR: stats.sd,
    seNetR: stats.se,
    lowerCI95NetR: stats.lowerCI95,
    meanRealizedOverPredictedRR: meanOf(ratios),
    nRealizedOverPredictedRR: ratios.length,
    meanPredictedRR: meanOf(predicted),
    nPredictedRR: predicted.length,
    calibrated: rows.length >= cfg.minInstances,
  };
}

// ── Out-of-sample validation ────────────────────────────────────────────────

export interface OosValidation {
  /** False when the cell was too small to even attempt a split. */
  attempted: boolean;
  trainN: number;
  testN: number;
  trainWinRate: number | null;
  trainWinRateCI95: [number, number] | null;
  /** Held-out chronological tail — the only rows the fit never saw. */
  testWinRate: number | null;
  /** Test win rate inside the train Wilson interval. null when not attempted. */
  winRateStable: boolean | null;
  /** |mean stated winProb − test win rate| on test rows carrying a stated prob. */
  oosCalibrationGap: number | null;
  /** gap ≤ config.maxOosCalibrationGap; null when no test row states a prob. */
  oosCalibrationGapOk: boolean | null;
  /** The verdict: attempted ∧ stable ∧ (gapOk ≠ false). */
  validated: boolean;
  /** Named reasons whenever `validated` is false — the fail-closed audit. */
  reasons: string[];
}

function validateOos(
  rowsChrono: readonly AdmittedRow[],
  cfg: SetupCalibrationConfig,
): OosValidation {
  const n = rowsChrono.length;
  const reasons: string[] = [];
  const testN = Math.floor(n * cfg.oosFraction);
  const trainN = n - testN;
  const base: OosValidation = {
    attempted: false,
    trainN,
    testN,
    trainWinRate: null,
    trainWinRateCI95: null,
    testWinRate: null,
    winRateStable: null,
    oosCalibrationGap: null,
    oosCalibrationGapOk: null,
    validated: false,
    reasons,
  };
  if (n < cfg.minInstances) {
    reasons.push(`n ${n} < ${cfg.minInstances} instance floor`);
    return base;
  }
  if (testN < cfg.minOosInstances) {
    reasons.push(`out-of-sample tail n ${testN} < ${cfg.minOosInstances} floor`);
    return base;
  }
  const train = rowsChrono.slice(0, trainN);
  const test = rowsChrono.slice(trainN);
  const trainWins = train.filter((r) => r.netR > 0).length;
  const testWins = test.filter((r) => r.netR > 0).length;
  const trainWinRate = trainWins / train.length;
  const trainCI = wilson95(trainWins, train.length, cfg.z95);
  const testWinRate = testWins / test.length;
  const winRateStable =
    trainCI !== null && testWinRate >= trainCI[0] && testWinRate <= trainCI[1];
  if (!winRateStable) {
    reasons.push(
      `out-of-sample win rate ${testWinRate.toFixed(3)} outside train Wilson 95% [${
        trainCI ? `${trainCI[0].toFixed(3)}, ${trainCI[1].toFixed(3)}` : 'unavailable'
      }]`,
    );
  }
  // Honesty check on STATED probabilities, out of sample, when any exist. A
  // test tail with no stated prob simply has nothing to be dishonest about —
  // the displayed confidence is empirical either way.
  const statedOnTest = test.map((r) => r.predictedWinProb).filter(fin);
  let oosCalibrationGap: number | null = null;
  let oosCalibrationGapOk: boolean | null = null;
  if (statedOnTest.length > 0) {
    const meanStated = statedOnTest.reduce((a, v) => a + v, 0) / statedOnTest.length;
    oosCalibrationGap = Math.abs(meanStated - testWinRate);
    oosCalibrationGapOk = oosCalibrationGap <= cfg.maxOosCalibrationGap;
    if (!oosCalibrationGapOk) {
      reasons.push(
        `out-of-sample stated-probability gap ${oosCalibrationGap.toFixed(3)} > ${cfg.maxOosCalibrationGap} band`,
      );
    }
  }
  const validated = winRateStable && oosCalibrationGapOk !== false;
  return {
    ...base,
    attempted: true,
    trainWinRate,
    trainWinRateCI95: trainCI,
    testWinRate,
    winRateStable,
    oosCalibrationGap,
    oosCalibrationGapOk,
    validated,
  };
}

// ── Per-setup calibration ───────────────────────────────────────────────────

export interface RegimeCalibration {
  cell: SetupExpectancyCell;
  oos: OosValidation;
}

export interface SetupCalibration {
  setupKey: string;
  pooled: SetupExpectancyCell;
  oos: OosValidation;
  byRegime: Record<string, RegimeCalibration>;
  excluded: SetupExclusionCounters;
  /** Pooled cell may back a confidence verdict: floor + OOS both cleared. */
  confidenceEligible: boolean;
}

export interface SetupCalibrationIndex {
  setups: Record<string, SetupCalibration>;
  summary: SetupCalibrationSummary;
}

/** The acceptance instrument: what clears the ≥30 floor and what does not. */
export interface SetupCalibrationSummary {
  setupCount: number;
  recordsSeen: number;
  recordsAdmitted: number;
  /** Setups whose pooled cell clears the instance floor. */
  calibrated: string[];
  /** setupKey → admitted n, for every setup still under the floor. */
  belowFloor: Record<string, number>;
  /** Calibrated AND out-of-sample validated — the only confidence-bearing set. */
  validated: string[];
  excludedTotals: SetupExclusionCounters;
}

/**
 * Fold every record into per-setup (and per-regime) calibrations. Pure; order
 * of the input does not matter — OOS splits are chronological on `closedAt`.
 */
export function calibrateSetups(
  records: readonly SetupOutcomeRecord[],
  cfg: SetupCalibrationConfig = DEFAULT_SETUP_CALIBRATION_CONFIG,
): SetupCalibrationIndex {
  const rowsByKey = new Map<string, AdmittedRow[]>();
  const exclByKey = new Map<string, SetupExclusionCounters>();
  for (const rec of records) {
    const key = typeof rec.setupKey === 'string' && rec.setupKey.length > 0 ? rec.setupKey : '';
    if (key === '') continue; // no identity, no cell — nothing to mis-attribute it to
    let excl = exclByKey.get(key);
    if (!excl) {
      excl = emptyExclusions();
      exclByKey.set(key, excl);
    }
    const row = admit(rec, excl);
    if (!row) continue;
    const rows = rowsByKey.get(key);
    if (rows) rows.push(row);
    else rowsByKey.set(key, [row]);
  }

  const setups: Record<string, SetupCalibration> = {};
  const calibrated: string[] = [];
  const validated: string[] = [];
  const belowFloor: Record<string, number> = {};
  const excludedTotals = emptyExclusions();
  let recordsAdmitted = 0;

  const allKeys = new Set<string>([...rowsByKey.keys(), ...exclByKey.keys()]);
  for (const key of [...allKeys].sort()) {
    const rows = (rowsByKey.get(key) ?? []).slice().sort((a, b) => a.closedAt - b.closedAt);
    const excl = exclByKey.get(key) ?? emptyExclusions();
    recordsAdmitted += rows.length;
    excludedTotals.nonFiniteGrossR += excl.nonFiniteGrossR;
    excludedTotals.nonFiniteCostR += excl.nonFiniteCostR;
    excludedTotals.unchargedCost += excl.unchargedCost;
    excludedTotals.nonFiniteClosedAt += excl.nonFiniteClosedAt;

    const pooled = foldCell(rows, cfg);
    const oos = validateOos(rows, cfg);

    const byRegime: Record<string, RegimeCalibration> = {};
    const regimes = new Map<string, AdmittedRow[]>();
    for (const row of rows) {
      if (row.regime === null) continue;
      const bucket = regimes.get(row.regime);
      if (bucket) bucket.push(row);
      else regimes.set(row.regime, [row]);
    }
    for (const [regime, regimeRows] of [...regimes.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      byRegime[regime] = {
        cell: foldCell(regimeRows, cfg),
        oos: validateOos(regimeRows, cfg),
      };
    }

    const confidenceEligible = pooled.calibrated && oos.validated;
    setups[key] = { setupKey: key, pooled, oos, byRegime, excluded: excl, confidenceEligible };
    if (pooled.calibrated) calibrated.push(key);
    else belowFloor[key] = pooled.n;
    if (confidenceEligible) validated.push(key);
  }

  return {
    setups,
    summary: {
      setupCount: allKeys.size,
      recordsSeen: records.length,
      recordsAdmitted,
      calibrated,
      belowFloor,
      validated,
      excludedTotals,
    },
  };
}

// ── Confidence verdict (the card's reserved slot) ───────────────────────────

/**
 * A confidence verdict that may be shown to a human. Existence implies
 * validation: this object is only ever constructed from a cell that cleared
 * the instance floor AND out-of-sample validation — there is no
 * `validated: false` variant.
 */
export interface SetupConfidence {
  setupKey: string;
  /** Which population backed the number — never guess, always stamped. */
  basis: 'regime' | 'pooled';
  regime: string | null;
  n: number;
  winRate: number;
  winRateCI95: [number, number];
  /**
   * The number a UI may print as "NN% confidence": the Wilson LOWER bound of
   * the measured net-R win rate, in whole percent. Conservative by
   * construction — never the point estimate, never a stated model prob.
   */
  displayWinRatePct: number;
  expectancyNetR: number;
  lowerCI95NetR: number;
  validated: true;
}

/**
 * TRA-4788 — which gate the lookup landed on. This is what `confidence: null`
 * cannot say by itself: 'no_instances' (the index holds no history for this
 * setup), 'below_floor' (rows exist, the instance floor was tested and
 * missed), 'oos_failed' (floor cleared, out-of-sample validation did not).
 * The state where no index was ever built cannot be expressed here — this
 * function requires an index to run — so the card layer stamps that one
 * 'not_run' without calling in.
 */
export type CalibrationOutcome = 'no_instances' | 'below_floor' | 'oos_failed' | 'calibrated';

export interface ConfidenceLookup {
  confidence: SetupConfidence | null;
  /** TRA-4788 — the gate verdict; `confidence` is non-null iff 'calibrated'. */
  status: CalibrationOutcome;
  /** Why null, when null — one line per failed gate. */
  reasons: string[];
}

function cellVerdict(
  setupKey: string,
  basis: 'regime' | 'pooled',
  regime: string | null,
  cell: SetupExpectancyCell,
): SetupConfidence | null {
  if (
    cell.winRate === null ||
    cell.winRateCI95 === null ||
    cell.meanNetR === null ||
    cell.lowerCI95NetR === null
  ) {
    return null;
  }
  return {
    setupKey,
    basis,
    regime,
    n: cell.n,
    winRate: cell.winRate,
    winRateCI95: cell.winRateCI95,
    displayWinRatePct: Math.round(cell.winRateCI95[0] * 100),
    expectancyNetR: cell.meanNetR,
    lowerCI95NetR: cell.lowerCI95NetR,
    validated: true,
  };
}

/**
 * Resolve the confidence verdict for one setup, optionally conditioned on the
 * CURRENT market regime. Regime cell first (only if that cell independently
 * clears floor + OOS); pooled as the fail-closed fallback; null with reasons
 * when neither qualifies.
 */
export function confidenceFor(
  index: SetupCalibrationIndex,
  setupKey: string,
  currentRegime: string | null = null,
): ConfidenceLookup {
  const setup = index.setups[setupKey];
  if (!setup) {
    return {
      confidence: null,
      status: 'no_instances',
      reasons: [`no historical instances for setup '${setupKey}'`],
    };
  }
  const reasons: string[] = [];
  if (currentRegime !== null) {
    const rc = setup.byRegime[currentRegime];
    if (!rc) {
      reasons.push(`no instances in regime '${currentRegime}' — falling back to pooled`);
    } else if (!rc.cell.calibrated || !rc.oos.validated) {
      reasons.push(
        `regime '${currentRegime}' cell not confidence-eligible (n ${rc.cell.n}${
          rc.oos.reasons.length > 0 ? `; ${rc.oos.reasons.join('; ')}` : ''
        }) — falling back to pooled`,
      );
    } else {
      const verdict = cellVerdict(setupKey, 'regime', currentRegime, rc.cell);
      if (verdict) return { confidence: verdict, status: 'calibrated', reasons };
    }
  }
  if (!setup.confidenceEligible) {
    // Floor first: an uncalibrated pooled cell means the floor itself was
    // missed; OOS is only the verdict when the floor was actually cleared.
    const status: CalibrationOutcome = !setup.pooled.calibrated ? 'below_floor' : 'oos_failed';
    if (!setup.pooled.calibrated) {
      reasons.push(`pooled n ${setup.pooled.n} < instance floor — not calibrated`);
    }
    reasons.push(...setup.oos.reasons);
    if (setup.oos.attempted && !setup.oos.validated && setup.oos.reasons.length === 0) {
      reasons.push('out-of-sample validation failed');
    }
    return { confidence: null, status, reasons };
  }
  const verdict = cellVerdict(setupKey, 'pooled', null, setup.pooled);
  if (!verdict) {
    // A calibrated cell with null statistics should be unreachable; grade it
    // as the floor gate (the cell could not produce a validated number) and
    // let the reason line carry the exact cause.
    reasons.push('pooled cell statistics unavailable');
    return { confidence: null, status: 'below_floor', reasons };
  }
  return { confidence: verdict, status: 'calibrated', reasons };
}

// ── Ranking ─────────────────────────────────────────────────────────────────

export interface RankedSetup {
  rank: number;
  setupKey: string;
  /** `lowerCI95NetR` of the pooled cell; null (and ranked last) when uncalibrated. */
  score: number | null;
  n: number;
  calibrated: boolean;
  validated: boolean;
  meanNetR: number | null;
  winRate: number | null;
}

/**
 * Rank setups by conservative net expectancy: calibrated cells by
 * `lowerCI95NetR` descending; every uncalibrated cell BELOW every calibrated
 * one (a shiny mean on n=5 is noise, not rank), ordered among themselves by n
 * descending then key.
 */
export function rankSetups(index: SetupCalibrationIndex): RankedSetup[] {
  const rows = Object.values(index.setups).map((s) => ({
    setupKey: s.setupKey,
    score: s.pooled.calibrated ? s.pooled.lowerCI95NetR : null,
    n: s.pooled.n,
    calibrated: s.pooled.calibrated,
    validated: s.confidenceEligible,
    meanNetR: s.pooled.meanNetR,
    winRate: s.pooled.winRate,
  }));
  rows.sort((a, b) => {
    if (a.score !== null && b.score !== null) return b.score - a.score;
    if (a.score !== null) return -1;
    if (b.score !== null) return 1;
    if (a.n !== b.n) return b.n - a.n;
    return a.setupKey.localeCompare(b.setupKey);
  });
  return rows.map((r, i) => ({ rank: i + 1, ...r }));
}
