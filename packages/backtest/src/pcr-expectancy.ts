import {
  deflatedSharpeRatio,
  probabilityOfBacktestOverfitting,
  type DeflatedSharpeResult,
  type PboResult,
} from './overfitting-stats.js';

// TRA-1664 (parent TRA-1609) — OFFLINE expectancy harness for the PCR shadow
// ledger. Reads `DATA_DIR/pcr-shadow-signals.jsonl`, joins a forward outcome the
// ledger deliberately does not carry, and grades the TRA-532 promotion bar.
//
// Nothing here is imported by the server, the engine, or `doTick`. No live path,
// no order surface, no broker call. It is analysis code that runs by hand.
//
// The pre-registration (locked 2026-07-12, before any row accrued) is encoded as
// CONSTANTS in this file rather than left in a comment thread, because the whole
// point of pre-registering is that the bar cannot move after the data is seen.
// If you are changing a number below AFTER looking at a result, you are p-hacking.

/** Incremental expectancy uplift the PCR overlay must clear, in R. */
export const PCR_UPLIFT_BAR_R = 0.05;
/** Bootstrap confidence level — the binding CI is the session-clustered one. */
export const PCR_BOOTSTRAP_CONFIDENCE = 0.9;
/** Bootstrap resamples. Fixed so a run is reproducible from the seed alone. */
export const PCR_BOOTSTRAP_ITERS = 5000;
/** Deterministic seed — a pre-registered test may not vary run to run. */
export const PCR_BOOTSTRAP_SEED = 1664;
/** |z| beyond which the z-delta carrier calls a side. */
export const PCR_Z_SIDE_THRESHOLD = 1.0;
/** TRA-540's floor: below this many independent units, no verdict is possible. */
export const MIN_INDEPENDENT_SESSIONS = 20;

/** PRIMARY horizon. The verdict is read off this one. */
export const PRIMARY_HORIZON = 5;
/** Pre-declared robustness horizons. Publishing all three is mandatory. */
export const HORIZONS = [3, 5, 10] as const;

/**
 * The two carriers of the PCR read (bar point 4 — reported separately).
 * - `raw`   — the face-value ratio level (its regime bucket).
 * - `zDelta`— the trailing-20-session z-score of the ratio. Only defined on
 *             MATURE-z rows (trailing n >= 10), which the ledger already encodes
 *             by nulling `pcrZ` below that floor (TRA-1663).
 */
export type PcrCarrier = 'raw' | 'zDelta';

/**
 * The two interpretations of the read (bar point 6 — reported separately).
 * These call OPPOSITE sides from the same number, so they can never be collapsed
 * into one cohort: heavy put flow is face-value `bearish` and contrarian `bullish`.
 */
export type PcrInterpretation = 'confirming' | 'contrarian';

export type Side = 'call' | 'put';

/** The ledger row, structurally — see packages/server/src/pcr-shadow-ledger.ts. */
export interface PcrShadowRow {
  id: string;
  session: string;
  underlying: string;
  asof: number;
  pcrVolume: number | null;
  pcrZ: number | null;
  pcrRegime: 'bullish' | 'neutral' | 'bearish' | null;
  contrarian: 'bullish' | 'bearish' | null;
  trio: {
    side: 'call' | 'put' | 'none';
    trioFired: boolean;
  } | null;
}

/** One daily OHLC bar for an underlying. The outcome + ATR both come from these. */
export interface DailyBar {
  underlying: string;
  /** ET session key, YYYY-MM-DD. Must match the ledger's `session`. */
  session: string;
  high: number;
  low: number;
  close: number;
}

/**
 * Wilder ATR over daily bars, indexed by session, using ONLY bars STRICTLY AT OR
 * BEFORE that session. The ATR at the capture session is a denominator, not an
 * outcome — if it could see the forward window it would leak the answer into the
 * normalizer and manufacture edge out of nothing.
 *
 * Returns null for a session until `period` true ranges exist behind it.
 */
export function atrBySession(
  bars: readonly DailyBar[],
  period = 14,
): Map<string, number | null> {
  const sorted = [...bars].sort((a, b) => a.session.localeCompare(b.session));
  const out = new Map<string, number | null>();
  const trs: number[] = [];
  let atr: number | null = null;

  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i];
    const prevClose = i > 0 ? sorted[i - 1].close : null;
    const tr =
      prevClose === null
        ? b.high - b.low
        : Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
    trs.push(tr);

    if (trs.length < period) {
      out.set(b.session, null);
      continue;
    }
    if (atr === null) {
      atr = trs.slice(0, period).reduce((s, x) => s + x, 0) / period;
    } else {
      atr = (atr * (period - 1) + tr) / period;
    }
    out.set(b.session, atr > 0 ? atr : null);
  }
  return out;
}

/** A ledger row that successfully carries an outcome. */
export interface JoinedRow {
  session: string;
  underlying: string;
  /** The trio's directional side (the tradable direction). */
  side: Side;
  trioFired: boolean;
  pcrRegime: 'bullish' | 'neutral' | 'bearish' | null;
  contrarian: 'bullish' | 'bearish' | null;
  pcrZ: number | null;
  /** Signed forward move over H sessions, normalized by capture-session ATR. */
  rMultiple: number;
  /**
   * The underlying's own TRAILING H-session fractional return, ending at capture.
   * Carries no forward information. It exists only to build the placebo — see
   * `placeboSidesBySession` — and it is never an input to a cohort.
   */
  trailingReturn: number;
}

/** Why rows fell out of the join. Silent drops are how a harness lies. */
export interface JoinDiagnostics {
  ledgerRows: number;
  joined: number;
  droppedNoTrioSide: number;
  droppedNoBars: number;
  droppedNoForwardBar: number;
  droppedNoAtr: number;
  droppedNoTrailingBar: number;
  droppedUnusablePcr: number;
}

export interface JoinResult {
  rows: JoinedRow[];
  diagnostics: JoinDiagnostics;
}

/**
 * Join the underlying's forward close-to-close return onto each ledger row, in R.
 *
 * H is measured in the UNDERLYING'S OWN sessions (its sorted bar list), not in
 * calendar days — a holiday must not silently shorten the horizon.
 *
 * A row that cannot be joined is DROPPED AND COUNTED. It is never imputed, and
 * never silently skipped: an unexplained denominator is indistinguishable from a
 * favourable one.
 */
export function joinForwardReturns(
  ledger: readonly PcrShadowRow[],
  bars: readonly DailyBar[],
  horizon: number,
): JoinResult {
  const byName = new Map<string, DailyBar[]>();
  for (const b of bars) {
    const list = byName.get(b.underlying) ?? [];
    list.push(b);
    byName.set(b.underlying, list);
  }
  const atrByName = new Map<string, Map<string, number | null>>();
  const idxByName = new Map<string, Map<string, number>>();
  for (const [name, list] of byName) {
    list.sort((a, b) => a.session.localeCompare(b.session));
    atrByName.set(name, atrBySession(list));
    const idx = new Map<string, number>();
    list.forEach((b, i) => idx.set(b.session, i));
    idxByName.set(name, idx);
  }

  const diagnostics: JoinDiagnostics = {
    ledgerRows: ledger.length,
    joined: 0,
    droppedNoTrioSide: 0,
    droppedNoBars: 0,
    droppedNoForwardBar: 0,
    droppedNoAtr: 0,
    droppedNoTrailingBar: 0,
    droppedUnusablePcr: 0,
  };
  const rows: JoinedRow[] = [];

  for (const r of ledger) {
    // The whole bar is written about the incremental value of PCR ON a trio
    // signal. A row with no directional side has no outcome to attribute.
    const side = r.trio?.side;
    if (side !== 'call' && side !== 'put') {
      diagnostics.droppedNoTrioSide++;
      continue;
    }
    if (typeof r.pcrVolume !== 'number') {
      diagnostics.droppedUnusablePcr++;
      continue;
    }
    const list = byName.get(r.underlying);
    const idx = idxByName.get(r.underlying)?.get(r.session);
    if (!list || idx === undefined) {
      diagnostics.droppedNoBars++;
      continue;
    }
    const fwd = list[idx + horizon];
    if (!fwd) {
      diagnostics.droppedNoForwardBar++;
      continue;
    }
    const atr = atrByName.get(r.underlying)?.get(r.session) ?? null;
    if (atr === null || !(atr > 0)) {
      diagnostics.droppedNoAtr++;
      continue;
    }
    // The placebo needs a trailing window of the SAME length as the forward one.
    const back = list[idx - horizon];
    if (!back || !(back.close > 0)) {
      diagnostics.droppedNoTrailingBar++;
      continue;
    }

    const move = fwd.close - list[idx].close;
    const signed = side === 'call' ? move : -move;
    rows.push({
      session: r.session,
      underlying: r.underlying,
      side,
      trioFired: r.trio?.trioFired === true,
      pcrRegime: r.pcrRegime,
      contrarian: r.contrarian,
      pcrZ: r.pcrZ,
      rMultiple: signed / atr,
      trailingReturn: (list[idx].close - back.close) / back.close,
    });
    diagnostics.joined++;
  }

  return { rows, diagnostics };
}

/**
 * The side the PCR read calls, for one (carrier, interpretation) cell.
 * Returns null when the read is silent — which is NOT the same as disagreeing.
 */
export function pcrSideFor(
  row: Pick<JoinedRow, 'pcrRegime' | 'contrarian' | 'pcrZ'>,
  carrier: PcrCarrier,
  interpretation: PcrInterpretation,
  zThreshold = PCR_Z_SIDE_THRESHOLD,
): Side | null {
  if (carrier === 'raw') {
    if (interpretation === 'confirming') {
      // Face value: low PCR (call-heavy) = bullish = call.
      if (row.pcrRegime === 'bullish') return 'call';
      if (row.pcrRegime === 'bearish') return 'put';
      return null; // neutral bucket is silent
    }
    // Contrarian is only populated at a regime extreme, and already inverted.
    if (row.contrarian === 'bullish') return 'call';
    if (row.contrarian === 'bearish') return 'put';
    return null;
  }

  // z-delta carrier — mature-z rows only (the ledger nulls pcrZ below n=10).
  const z = row.pcrZ;
  if (typeof z !== 'number' || Math.abs(z) < zThreshold) return null;
  // z > 0 = put flow surging vs its own trailing base = face-value bearish.
  const faceValue: Side = z > 0 ? 'put' : 'call';
  if (interpretation === 'confirming') return faceValue;
  return faceValue === 'put' ? 'call' : 'put';
}

export interface Cohorts {
  /** The incumbent baseline: every fired-trio row, PCR ignored. */
  trioAlone: JoinedRow[];
  /** Fired trio AND the PCR read confirms the trio's side. */
  agreeing: JoinedRow[];
  /** Fired trio AND the PCR read opposes it. */
  disagreeing: JoinedRow[];
  /** Fired trio, PCR read silent — in NEITHER overlay cohort. Reported, not hidden. */
  silent: JoinedRow[];
}

export function cohortize(
  rows: readonly JoinedRow[],
  carrier: PcrCarrier,
  interpretation: PcrInterpretation,
  zThreshold = PCR_Z_SIDE_THRESHOLD,
): Cohorts {
  const trioAlone = rows.filter((r) => r.trioFired);
  const agreeing: JoinedRow[] = [];
  const disagreeing: JoinedRow[] = [];
  const silent: JoinedRow[] = [];
  for (const r of trioAlone) {
    const s = pcrSideFor(r, carrier, interpretation, zThreshold);
    if (s === null) silent.push(r);
    else if (s === r.side) agreeing.push(r);
    else disagreeing.push(r);
  }
  return { trioAlone, agreeing, disagreeing, silent };
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Deterministic PRNG. A pre-registered result must reproduce from the seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Ci {
  lo: number;
  hi: number;
  /** The point estimate on the observed sample (not a bootstrap mean). */
  point: number;
  /** Resamples that produced a defined statistic. */
  effective: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * BLOCK BOOTSTRAP CLUSTERED BY ET SESSION — the binding inference.
 *
 * The sample is ~25 watchlist names x N sessions. Those names are heavily
 * cross-correlated: SPY/QQQ/IWM/DIA are four near-duplicate index exposures, and
 * the mega-cap tech block is one beta factor. On a market-wide fear day every
 * name's PCR lifts TOGETHER. So 200 rows is not 200 independent observations; it
 * is closer to ~8-20 independent SESSIONS.
 *
 * Resampling rows iid would shrink the interval by ~sqrt(25) ≈ 5x and let pure
 * noise clear a "CI lower bound > 0" test. That is exactly the failure mode that
 * made Supertrend look promotable (TRA-1334; it washed out at E[R] -0.047R over
 * 2098 signals). So: resample WHOLE SESSIONS with replacement, keeping every name
 * within a session together. Never resample rows iid.
 */
export function sessionClusteredBootstrap(
  rows: readonly JoinedRow[],
  stat: (sample: readonly JoinedRow[]) => number,
  opts: { iters?: number; confidence?: number; seed?: number; blockLength?: number } = {},
): Ci {
  const iters = opts.iters ?? PCR_BOOTSTRAP_ITERS;
  const confidence = opts.confidence ?? PCR_BOOTSTRAP_CONFIDENCE;
  const rng = mulberry32(opts.seed ?? PCR_BOOTSTRAP_SEED);

  const bySession = new Map<string, JoinedRow[]>();
  for (const r of rows) {
    const list = bySession.get(r.session) ?? [];
    list.push(r);
    bySession.set(r.session, list);
  }
  // Chronological — a MOVING-BLOCK bootstrap needs the sessions in order.
  const sessions = [...bySession.keys()].sort().map((s) => bySession.get(s)!);
  const point = stat(rows);
  if (sessions.length === 0) return { lo: Number.NaN, hi: Number.NaN, point, effective: 0 };

  // Blocks of CONSECUTIVE sessions, not single sessions.
  //
  // An H-session forward return at session i and one at session i+1 share H-1 of
  // their forward days. Sessions are therefore serially dependent by construction,
  // and resampling them INDEPENDENTLY destroys that dependence and understates the
  // variance — measured at 1.43x too narrow on synthetic data at H=5. A block
  // length >= H keeps overlapping windows together in the same draw.
  const L = Math.max(1, Math.min(opts.blockLength ?? PRIMARY_HORIZON, sessions.length));

  // FAIL CLOSED on a degenerate resample. When the block length covers (half or
  // more of) the sample, every circular draw is just a ROTATION of the whole
  // session set: the statistic is identical in every resample, the interval
  // collapses to zero width, and a zero-width interval sitting above zero reports
  // `lo > 0` — a CONFIDENT-LOOKING PASS backed by no variance at all. Caught on the
  // thin-ledger dry run, where H=10 over 6 sessions printed a CI of [0.918, 0.918].
  // Fewer than two whole blocks means the bootstrap cannot resample, so there is no
  // interval to report.
  if (sessions.length < 2 * L) {
    return { lo: Number.NaN, hi: Number.NaN, point, effective: 0 };
  }
  const nBlocks = Math.ceil(sessions.length / L);

  const stats: number[] = [];
  for (let i = 0; i < iters; i++) {
    const sample: JoinedRow[] = [];
    for (let b = 0; b < nBlocks; b++) {
      const start = Math.floor(rng() * sessions.length);
      for (let k = 0; k < L; k++) {
        // Circular so every session has equal probability of appearing.
        sample.push(...sessions[(start + k) % sessions.length]);
      }
    }
    const v = stat(sample);
    if (Number.isFinite(v)) stats.push(v);
  }
  stats.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  return {
    lo: percentile(stats, alpha),
    hi: percentile(stats, 1 - alpha),
    point,
    effective: stats.length,
  };
}

/**
 * The NAIVE row-level bootstrap. Reported ONLY to show the size of the illusion —
 * it is never the binding number. If this interval is much tighter than the
 * clustered one, that gap IS the cross-name correlation you would have been
 * fooled by.
 */
export function naiveRowBootstrap(
  rows: readonly JoinedRow[],
  stat: (sample: readonly JoinedRow[]) => number,
  opts: { iters?: number; confidence?: number; seed?: number } = {},
): Ci {
  const iters = opts.iters ?? PCR_BOOTSTRAP_ITERS;
  const confidence = opts.confidence ?? PCR_BOOTSTRAP_CONFIDENCE;
  const rng = mulberry32(opts.seed ?? PCR_BOOTSTRAP_SEED);
  const point = stat(rows);
  if (rows.length === 0) return { lo: Number.NaN, hi: Number.NaN, point, effective: 0 };

  const stats: number[] = [];
  for (let i = 0; i < iters; i++) {
    const sample: JoinedRow[] = [];
    for (let k = 0; k < rows.length; k++) sample.push(rows[Math.floor(rng() * rows.length)]);
    const v = stat(sample);
    if (Number.isFinite(v)) stats.push(v);
  }
  stats.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  return {
    lo: percentile(stats, alpha),
    hi: percentile(stats, 1 - alpha),
    point,
    effective: stats.length,
  };
}

/**
 * The RAW statistic exactly as pre-registered: incremental E[R] of the
 * PCR-agreeing cohort over the trio-alone baseline.
 *
 * ⚠️  THIS NUMBER IS BIASED UPWARD ON A SHORT SAMPLE AND MUST NOT BE PROMOTED ON.
 * It is computed and published because the pre-registration named it, and because
 * the gap between it and the bias-adjusted statistic IS the artifact — see
 * `placeboUpliftStat`. The binding number is `adjustedUpliftStat`.
 */
export function rawUpliftStat(
  carrier: PcrCarrier,
  interpretation: PcrInterpretation,
  zThreshold = PCR_Z_SIDE_THRESHOLD,
): (sample: readonly JoinedRow[]) => number {
  return (sample) => {
    const c = cohortize(sample, carrier, interpretation, zThreshold);
    if (c.agreeing.length === 0 || c.trioAlone.length === 0) return Number.NaN;
    return mean(c.agreeing.map((r) => r.rMultiple)) - mean(c.trioAlone.map((r) => r.rMultiple));
  };
}

/**
 * THE PLACEBO — a signal with provably ZERO forward information that nonetheless
 * carries the SAME mechanical bias as the real PCR read.
 *
 * ## Why this exists (the finding that reshaped this harness)
 *
 * Over ONE finite price path, a backward-looking window and a forward-looking
 * window are MECHANICALLY NEGATIVELY CORRELATED: the realized sum over the sample
 * is fixed, so sessions whose trailing return was unusually low are necessarily
 * followed by above-average returns *within that sample*. Any contrarian signal
 * built from recent returns therefore shows FAKE forward edge in-sample.
 *
 * Measured on synthetic ledgers with EXACTLY ZERO true edge, the raw
 * pre-registered uplift comes out at:
 *
 *     30 sessions  -> +0.23 R      (the ~4-week window this study plans to read)
 *     60 sessions  -> +0.07 R
 *    120 sessions  -> +0.03 R
 *    960 sessions  -> ~0.00 R
 *
 * — tracking the within-path corr(backward, forward) as it decays to zero. At the
 * planned window the artifact is ~5x the +0.05R promotion bar. A session-clustered
 * CI does NOT save you: it puts an interval around a BIASED POINT ESTIMATE. Nor
 * does a permutation null, which would randomise away the very selection that
 * causes the bias and so come out centred on zero.
 *
 * The fix is to calibrate against a signal that has the bias and nothing else.
 * The placebo is a dumb SESSION-LEVEL "buy the dip" contrarian: on each session,
 * take the cross-sectional mean trailing H-session return across the names in the
 * sample; if it is negative the placebo calls `call`, else `put`. It is a pure
 * function of the past. It cannot know anything. Whatever uplift it "earns" is
 * exactly the artifact.
 *
 * Session-level, not name-level: the bias lives in the shared market factor, so a
 * per-name placebo under-absorbs it (measured: it leaves +0.055R on the table,
 * still above the bar, while the session-level placebo leaves +0.002R).
 */
export function placeboSidesBySession(sample: readonly JoinedRow[]): Map<string, Side> {
  const trailing = new Map<string, number[]>();
  for (const r of sample) {
    const list = trailing.get(r.session) ?? [];
    list.push(r.trailingReturn);
    trailing.set(r.session, list);
  }
  const out = new Map<string, Side>();
  for (const [session, list] of trailing) {
    out.set(session, mean(list) < 0 ? 'call' : 'put');
  }
  return out;
}

/** The uplift the PLACEBO earns — i.e. the size of the finite-sample artifact. */
export function placeboUpliftStat(): (sample: readonly JoinedRow[]) => number {
  return (sample) => {
    const trioAlone = sample.filter((r) => r.trioFired);
    if (trioAlone.length === 0) return Number.NaN;
    const sides = placeboSidesBySession(trioAlone);
    const agreeing = trioAlone.filter((r) => sides.get(r.session) === r.side);
    if (agreeing.length === 0) return Number.NaN;
    return mean(agreeing.map((r) => r.rMultiple)) - mean(trioAlone.map((r) => r.rMultiple));
  };
}

/**
 * THE BINDING STATISTIC — the PCR overlay's uplift NET of the placebo's.
 *
 * Reads as: "how much does the real PCR read beat a signal that knows nothing but
 * is wired into the same finite-sample trap?" On a zero-edge ledger this is ~0
 * (measured +0.0025R, SE 0.021 over 300 synthetic worlds at 30 sessions). On a
 * genuinely predictive ledger it retains the real signal (+1.38R of a +1.64R raw).
 *
 * Both cohorts and the placebo are recomputed INSIDE each resample, so the whole
 * contrast is bootstrapped jointly — they are drawn from the same sessions and are
 * not independent samples.
 */
export function adjustedUpliftStat(
  carrier: PcrCarrier,
  interpretation: PcrInterpretation,
  zThreshold = PCR_Z_SIDE_THRESHOLD,
): (sample: readonly JoinedRow[]) => number {
  const raw = rawUpliftStat(carrier, interpretation, zThreshold);
  const placebo = placeboUpliftStat();
  return (sample) => {
    const r = raw(sample);
    const p = placebo(sample);
    if (!Number.isFinite(r) || !Number.isFinite(p)) return Number.NaN;
    return r - p;
  };
}

export interface SampleShape {
  rows: number;
  sessionCount: number;
  underlyingCount: number;
  maxNameSharePct: number;
  /** Rows carrying a MATURE z (trailing n >= 10) — bar point 4 is only readable here. */
  matureZRows: number;
}

export function sampleShape(rows: readonly JoinedRow[]): SampleShape {
  const perName = new Map<string, number>();
  for (const r of rows) perName.set(r.underlying, (perName.get(r.underlying) ?? 0) + 1);
  return {
    rows: rows.length,
    sessionCount: new Set(rows.map((r) => r.session)).size,
    underlyingCount: perName.size,
    maxNameSharePct:
      rows.length === 0 ? 0 : (Math.max(...perName.values(), 0) / rows.length) * 100,
    matureZRows: rows.filter((r) => typeof r.pcrZ === 'number').length,
  };
}

/** One (carrier x interpretation x horizon) cell of the pre-registered grid. */
export interface CellResult {
  horizon: number;
  carrier: PcrCarrier;
  interpretation: PcrInterpretation;
  n: { trioAlone: number; agreeing: number; disagreeing: number; silent: number };
  meanR: { trioAlone: number; agreeing: number; disagreeing: number };
  /** RAW uplift as pre-registered. BIASED on a short sample — published, not binding. */
  rawUpliftR: number;
  /** What a zero-information placebo earns on this same sample = the artifact. */
  placeboUpliftR: number;
  /** BINDING: raw uplift NET of the placebo's. This is the promotable number. */
  adjustedUpliftR: number;
  /** BINDING: session-clustered, moving-block 90% CI on the ADJUSTED uplift. */
  clustered: Ci;
  /** Reported only to expose the illusion. Never binding. */
  naive: Ci;
  legs: {
    /** ADJUSTED uplift clears the pre-registered +0.05R bar. */
    upliftBar: boolean;
    /** Session-clustered 90% CI lower bound on the ADJUSTED uplift > 0. */
    clusteredCiPositive: boolean;
    /** TRA-540 n<20 floor, measured in SESSIONS (independent units), not rows. */
    sessionFloor: boolean;
  };
  /** True only when every leg holds. Fails closed on a NaN / empty cohort. */
  pass: boolean;
  notes: string[];
}

export function evaluateCell(
  rows: readonly JoinedRow[],
  horizon: number,
  carrier: PcrCarrier,
  interpretation: PcrInterpretation,
  opts: { zThreshold?: number; seed?: number; iters?: number } = {},
): CellResult {
  const z = opts.zThreshold ?? PCR_Z_SIDE_THRESHOLD;
  const c = cohortize(rows, carrier, interpretation, z);
  const adjusted = adjustedUpliftStat(carrier, interpretation, z);
  // Block length tracks the horizon — that is where the window overlap comes from.
  const boot = { seed: opts.seed, iters: opts.iters, blockLength: horizon };

  const clustered = sessionClusteredBootstrap(rows, adjusted, boot);
  const naive = naiveRowBootstrap(rows, adjusted, boot);
  const sessionCount = new Set(rows.map((r) => r.session)).size;

  const rawUpliftR = rawUpliftStat(carrier, interpretation, z)(rows);
  const placeboUpliftR = placeboUpliftStat()(rows);
  const adjustedUpliftR = adjusted(rows);

  const notes: string[] = [];
  if (c.agreeing.length === 0) notes.push('no PCR-agreeing rows — uplift undefined');
  if (sessionCount < MIN_INDEPENDENT_SESSIONS) {
    notes.push(
      `session floor: ${sessionCount} < ${MIN_INDEPENDENT_SESSIONS} independent sessions (TRA-540)`,
    );
  }
  if (Number.isFinite(placeboUpliftR) && Math.abs(placeboUpliftR) >= PCR_UPLIFT_BAR_R) {
    notes.push(
      `placebo earns ${placeboUpliftR.toFixed(3)}R on this sample — a zero-information signal ` +
        `clears the raw bar, so the RAW uplift is not readable here`,
    );
  }

  const legs = {
    upliftBar: Number.isFinite(adjustedUpliftR) && adjustedUpliftR >= PCR_UPLIFT_BAR_R,
    clusteredCiPositive: Number.isFinite(clustered.lo) && clustered.lo > 0,
    sessionFloor: sessionCount >= MIN_INDEPENDENT_SESSIONS,
  };

  return {
    horizon,
    carrier,
    interpretation,
    n: {
      trioAlone: c.trioAlone.length,
      agreeing: c.agreeing.length,
      disagreeing: c.disagreeing.length,
      silent: c.silent.length,
    },
    meanR: {
      trioAlone: mean(c.trioAlone.map((r) => r.rMultiple)),
      agreeing: mean(c.agreeing.map((r) => r.rMultiple)),
      disagreeing: mean(c.disagreeing.map((r) => r.rMultiple)),
    },
    rawUpliftR,
    placeboUpliftR,
    adjustedUpliftR,
    clustered,
    naive,
    legs,
    pass: Object.values(legs).every(Boolean),
    notes,
  };
}

/** The DSR/PBO overfitting guards, wired to the REAL multiplicity of this study. */
export interface OverfittingGuards {
  /**
   * Number of pre-registered configurations searched. DSR must deflate by the
   * multiplicity we ACTUALLY looked at (carriers x interpretations x horizons),
   * not by 1 — reporting the single best cell as if it were the only one tried is
   * the definition of the bias DSR exists to remove.
   */
  trials: number;
  dsr: DeflatedSharpeResult | null;
  pbo: PboResult | null;
  /**
   * PBO is NOT EVALUABLE on a thin ledger (fewer columns than partitions).
   * `probabilityOfBacktestOverfitting` degrades to `{pbo: 0, pass: true}` in that
   * case — a FAIL-OPEN. We refuse to count that as a cleared guard: not-evaluable
   * is HELD, never PASS.
   */
  pboEvaluable: boolean;
  dsrEvaluable: boolean;
  notes: string[];
}

/**
 * Grade the DSR/PBO guards across the pre-registered grid.
 *
 * The per-session mean R of the winning cell's agreeing cohort is the return
 * series DSR reads; the trial matrix for PBO is one row per grid cell, one column
 * per session. Sessions — not rows — are the observation unit throughout, for the
 * same clustering reason the bootstrap exists.
 */
export function overfittingGuards(
  rows: readonly JoinedRow[],
  cells: readonly CellResult[],
  primary: CellResult,
  /** Joined rows per horizon — the trial set spans horizons, not just the primary. */
  rowsByHorizon: Record<number, readonly JoinedRow[]> = {},
  /** Total configurations looked at across the whole grid (the multiplicity penalty). */
  gridSize = cells.length,
): OverfittingGuards {
  const notes: string[] = [];
  const sessions = [...new Set(rows.map((r) => r.session))].sort();
  const trials = gridSize;

  // Per-session mean R for one cohort, NET OF THE PLACEBO's — the observation
  // series. It has to be the bias-adjusted quantity for the same reason the CI is:
  // a Sharpe measured on the raw series inherits the finite-sample artifact.
  const seriesOf = (
    src: readonly JoinedRow[],
    carrier: PcrCarrier,
    interpretation: PcrInterpretation,
  ): number[] => {
    const bySession = new Map<string, JoinedRow[]>();
    for (const r of src) {
      const list = bySession.get(r.session) ?? [];
      list.push(r);
      bySession.set(r.session, list);
    }
    const placeboSides = placeboSidesBySession(src.filter((r) => r.trioFired));
    return [...bySession.keys()].sort().map((s) => {
      const day = bySession.get(s) ?? [];
      const c = cohortize(day, carrier, interpretation);
      const pcr = mean(c.agreeing.map((r) => r.rMultiple));
      const placebo = mean(
        c.trioAlone.filter((r) => placeboSides.get(r.session) === r.side).map((r) => r.rMultiple),
      );
      return (Number.isFinite(pcr) ? pcr : 0) - (Number.isFinite(placebo) ? placebo : 0);
    });
  };
  const seriesFor = (cell: CellResult): number[] =>
    seriesOf(rows, cell.carrier, cell.interpretation);

  const sharpe = (xs: readonly number[]): number => {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
    return sd > 0 ? m / sd : 0;
  };

  const primarySeries = seriesFor(primary);
  const dsrEvaluable = primarySeries.length >= MIN_INDEPENDENT_SESSIONS;
  let dsr: DeflatedSharpeResult | null = null;
  if (dsrEvaluable) {
    // The DSR trial set must be the DISTINCT configurations searched — one per
    // (carrier x horizon), all read at the pre-registered PRIMARY interpretation.
    //
    // It must NOT include both the `confirming` and `contrarian` cells. Those are
    // the SAME read with the sign flipped, so a mirrored pair enters Var[SR] as a
    // spread of +SR against -SR. The consequence is perverse and was caught here on
    // the positive control: the STRONGER the genuine edge, the wider the mirrored
    // trial spread, the higher SR* climbs — and a real +1.6R edge could never clear
    // its own deflation benchmark at ANY sample size. A guard that no true signal
    // can pass is not conservative, it is broken; it refuses everything and so
    // certifies nothing.
    //
    // `trialCount` still carries the FULL grid multiplicity (every cell we looked
    // at), so the multiple-testing penalty is not softened — only the dispersion
    // estimate is de-mirrored.
    const trialSharpes: number[] = [];
    for (const carrier of ['raw', 'zDelta'] as const) {
      for (const h of HORIZONS) {
        const src = rowsByHorizon[h] ?? (h === primary.horizon ? rows : []);
        if (src.length > 0) trialSharpes.push(sharpe(seriesOf(src, carrier, primary.interpretation)));
      }
    }
    dsr = deflatedSharpeRatio({
      returns: primarySeries,
      trialSharpes: trialSharpes.length >= 2 ? trialSharpes : [sharpe(primarySeries), 0],
      trialCount: trials,
    });
  } else {
    notes.push(
      `DSR not evaluable: ${primarySeries.length} sessions < ${MIN_INDEPENDENT_SESSIONS} floor — HELD, not passed`,
    );
  }

  const matrix = cells.map(seriesFor);
  // CSCV needs at least 2 trials and >= `partitions` columns; below that the
  // implementation returns pass:true vacuously. Grade evaluability OURSELVES.
  const pboPartitions = 4;
  const pboEvaluable = trials >= 2 && sessions.length >= pboPartitions;
  let pbo: PboResult | null = null;
  if (pboEvaluable) {
    pbo = probabilityOfBacktestOverfitting({ matrix, partitions: pboPartitions, threshold: 0.25 });
  } else {
    notes.push(
      `PBO not evaluable: ${trials} trials x ${sessions.length} sessions — HELD, not passed (the underlying CSCV would fail OPEN here)`,
    );
  }

  return { trials, dsr, pbo, pboEvaluable, dsrEvaluable, notes };
}

export interface PcrExpectancyReport {
  diagnostics: Record<number, JoinDiagnostics>;
  shape: SampleShape;
  cells: CellResult[];
  primary: CellResult | null;
  guards: OverfittingGuards | null;
  /**
   * The pre-registered verdict. PASS demands EVERY leg: the primary cell's uplift
   * bar, its session-clustered CI, the session floor, AND both overfitting guards
   * EVALUABLE and passing. Anything not evaluable is HELD — never a pass.
   */
  verdict: 'PASS' | 'FAIL' | 'HELD';
  reasons: string[];
}

/**
 * Run the whole pre-registered study. The verdict is read off the PRIMARY cell
 * (H=5, raw carrier, contrarian interpretation is NOT assumed — the primary is
 * whichever cell the caller pre-registers; we default to H=5 and report all).
 *
 * Every horizon and every carrier x interpretation cell is computed and returned
 * whether or not it clears. Publishing all of them is mandatory: a result that is
 * only visible at one horizon is a horizon-cherry-pick, and hiding the other
 * eleven cells is how that gets laundered into a promotion.
 */
export function runPcrExpectancy(
  ledger: readonly PcrShadowRow[],
  bars: readonly DailyBar[],
  opts: {
    primaryCarrier?: PcrCarrier;
    primaryInterpretation?: PcrInterpretation;
    zThreshold?: number;
    seed?: number;
    iters?: number;
  } = {},
): PcrExpectancyReport {
  const primaryCarrier = opts.primaryCarrier ?? 'raw';
  const primaryInterpretation = opts.primaryInterpretation ?? 'contrarian';

  const diagnostics: Record<number, JoinDiagnostics> = {};
  const cells: CellResult[] = [];
  const rowsByHorizon: Record<number, JoinedRow[]> = {};
  let primaryRows: JoinedRow[] = [];

  for (const h of HORIZONS) {
    const { rows, diagnostics: d } = joinForwardReturns(ledger, bars, h);
    diagnostics[h] = d;
    rowsByHorizon[h] = rows;
    if (h === PRIMARY_HORIZON) primaryRows = rows;
    for (const carrier of ['raw', 'zDelta'] as const) {
      for (const interpretation of ['confirming', 'contrarian'] as const) {
        cells.push(evaluateCell(rows, h, carrier, interpretation, opts));
      }
    }
  }

  const shape = sampleShape(primaryRows);
  const primary =
    cells.find(
      (c) =>
        c.horizon === PRIMARY_HORIZON &&
        c.carrier === primaryCarrier &&
        c.interpretation === primaryInterpretation,
    ) ?? null;

  const reasons: string[] = [];
  if (!primary) {
    return {
      diagnostics,
      shape,
      cells,
      primary: null,
      guards: null,
      verdict: 'HELD',
      reasons: ['primary cell not computed'],
    };
  }

  const primaryHorizonCells = cells.filter((c) => c.horizon === PRIMARY_HORIZON);
  const guards = overfittingGuards(
    primaryRows,
    primaryHorizonCells,
    primary,
    rowsByHorizon,
    cells.length, // full grid multiplicity — every cell we looked at
  );

  reasons.push(...primary.notes, ...guards.notes);

  const guardsPass =
    guards.dsrEvaluable &&
    guards.pboEvaluable &&
    guards.dsr?.pass === true &&
    guards.pbo?.pass === true;
  const evaluable = guards.dsrEvaluable && guards.pboEvaluable && primary.legs.sessionFloor;

  let verdict: 'PASS' | 'FAIL' | 'HELD';
  if (!evaluable) {
    // Not enough independent sessions to answer the question. This is NOT a FAIL
    // (the overlay may yet be good) and it is emphatically NOT a PASS.
    verdict = 'HELD';
  } else if (primary.pass && guardsPass) {
    verdict = 'PASS';
  } else {
    verdict = 'FAIL';
    if (!primary.legs.upliftBar) {
      reasons.push(
        `bias-adjusted uplift ${primary.adjustedUpliftR.toFixed(4)}R < ${PCR_UPLIFT_BAR_R}R bar ` +
          `(raw ${primary.rawUpliftR.toFixed(4)}R, of which ${primary.placeboUpliftR.toFixed(4)}R ` +
          `is earned by a zero-information placebo)`,
      );
    }
    if (!primary.legs.clusteredCiPositive) {
      reasons.push(
        `session-clustered 90% CI lower bound ${primary.clustered.lo.toFixed(4)} <= 0`,
      );
    }
    if (guards.dsr && !guards.dsr.pass) reasons.push('DSR guard failed');
    if (guards.pbo && !guards.pbo.pass) reasons.push('PBO guard failed');
  }

  return { diagnostics, shape, cells, primary, guards, verdict, reasons };
}
