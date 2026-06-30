/**
 * TRA-822 (TRA-820 Step 1) — offline IC / flow measurement harness.
 *
 * Pure metrics core for the StockTwits-sentiment (+ options-flow confirmation)
 * signal study pre-registered in `docs/stocktwits-signal-study-TRA-820.md`. It
 * joins the forward-collected sentiment snapshots (TRA-822 recorder) with the
 * TRA-376 option-chain snapshots and daily candles, then emits the §3 tables and
 * grades them against the §4 verdict gate.
 *
 * Two nested signals (TRA-820 §1):
 *   S1 — sentiment alone:  daily per-symbol StockTwits `netScore` vs forward ret.
 *   S2 — sentiment + flow: S1 conditioned on options flow agreeing (net OTM
 *                          call-vs-put volume points the same way as netScore).
 *
 * Everything here is PURE (no IO, no clock) so it is unit-tested with fixtures;
 * the join/IO lives in `run-tra822-sentiment-ic.ts`. Forward returns use no
 * look-ahead: the signal is known at 15:55 ET on day t, entry is day t+1 open.
 */

import type { OptionChainRow } from '@trading-app/engine';

export type Tilt = 'bullish' | 'neutral' | 'bearish';
export type Horizon = '1d' | '5d' | '20d';
export const HORIZONS: readonly Horizon[] = ['1d', '5d', '20d'];

/** §2 quality filter — only days where `tilt` was allowed to be non-neutral. */
export const MIN_TAGGED = 5;
export const MAX_FRESHNESS_MIN = 720;
/** §2 flow-confirmation floors. */
export const NETSCORE_FLOOR = 0.25;
export const NETOTMFLOW_FLOOR = 0.1;
/** §2 OTM-flow DTE window (the recorder's confirmation window). */
export const FLOW_MIN_DTE = 14;
export const FLOW_MAX_DTE = 35;

/** §4 sample bar. */
export const MIN_TRADING_DAYS = 20;
export const MIN_USABLE_SYMBOL_DAYS = 300;
/**
 * TRA-1182 — minimum option-chain days before S2 (flow-confirmed) can be graded
 * at all. With ZERO captured chain-days the S2 IC is *unmeasured* (TRA-826 has
 * not provisioned `TRADIER_API_TOKEN`), not "measured and dead", so the gate must
 * return PENDING_FLOW rather than killing the direction off absent flow data.
 */
export const MIN_CHAIN_DAYS = 1;
/** §4 S2 thresholds. */
export const IC_FLOOR = 0.03;
export const ICIR_FLOOR = 0.3;
export const S2_BEATS_S1_FLOOR = 0.02;
/** Minimum cross-section width for a daily Spearman to count. */
export const MIN_CROSS_SECTION = 4;

// ── primitive stats ──────────────────────────────────────────────────────────

export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function std(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** Fractional ranks (average ties) — the basis for Spearman. */
function rank(xs: readonly number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    const avg = (i + j) / 2 + 1; // 1-based average rank across the tie block
    for (let k = i; k <= j; k++) ranks[idx[k].i] = avg;
    i = j + 1;
  }
  return ranks;
}

/** Pearson correlation; null when undefined (n<2 or a zero-variance side). */
export function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Spearman rank correlation; null when undefined. */
export function spearman(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length < 2 || ys.length !== xs.length) return null;
  return pearson(rank(xs), rank(ys));
}

/** Deterministic PRNG (mulberry32) so bootstrap CIs are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile bootstrap CI of the mean. Returns [lo, hi] at the given level. */
export function bootstrapMeanCI(
  xs: readonly number[],
  opts: { iterations?: number; level?: number; seed?: number } = {},
): [number, number] | null {
  const n = xs.length;
  if (n < 2) return null;
  const iterations = opts.iterations ?? 2000;
  const level = opts.level ?? 0.95;
  const rng = mulberry32(opts.seed ?? 0x5eed);
  const means: number[] = [];
  for (let b = 0; b < iterations; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += xs[Math.floor(rng() * n)];
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const loIdx = Math.floor(((1 - level) / 2) * iterations);
  const hiIdx = Math.min(iterations - 1, Math.ceil((1 - (1 - level) / 2) * iterations) - 1);
  return [means[loIdx], means[hiIdx]];
}

// ── flow signal ──────────────────────────────────────────────────────────────

/** Calendar days between two YYYY-MM-DD dates (b − a), UTC. */
export function daysBetween(aIso: string, bIso: string): number {
  const a = Date.parse(`${aIso}T00:00:00Z`);
  const b = Date.parse(`${bIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return Math.round((b - a) / 86_400_000);
}

/**
 * TRA-820 §2 net OTM options flow ∈ [−1, +1] for a symbol-day:
 *   (Σ OTM-call vol − Σ OTM-put vol) / (Σ OTM-call vol + Σ OTM-put vol)
 * over contracts in the [minDte, maxDte] window. OTM call = strike > spot,
 * OTM put = strike < spot. Null when spot is unknown or no OTM volume exists.
 */
export function netOTMflow(
  rows: readonly OptionChainRow[],
  spot: number | null,
  snapshotDate: string,
  opts: { minDte?: number; maxDte?: number } = {},
): number | null {
  if (!(spot != null && spot > 0)) return null;
  const minDte = opts.minDte ?? FLOW_MIN_DTE;
  const maxDte = opts.maxDte ?? FLOW_MAX_DTE;
  let callVol = 0;
  let putVol = 0;
  for (const r of rows) {
    const dte = daysBetween(snapshotDate, r.expiration);
    if (!Number.isFinite(dte) || dte < minDte || dte > maxDte) continue;
    const vol = r.volume ?? 0;
    if (vol <= 0) continue;
    if (r.optionType === 'call' && r.strike > spot) callVol += vol;
    else if (r.optionType === 'put' && r.strike < spot) putVol += vol;
  }
  const denom = callVol + putVol;
  if (denom <= 0) return null;
  return (callVol - putVol) / denom;
}

// ── assembled records ────────────────────────────────────────────────────────

export interface SentimentSymbolDay {
  /** Signal day t (YYYY-MM-DD). */
  date: string;
  symbol: string;
  netScore: number;
  tilt: Tilt;
  taggedCount: number;
  curatedCount: number;
  messageCount: number;
  freshnessMinutes: number;
  /** Net OTM flow for the same symbol-day; null when no chain snapshot joined. */
  netOTMflow: number | null;
  /** §2 quality filter passed (tagged ≥ 5 and fresh ≤ 720m). */
  usable: boolean;
  /** De-market forward returns by horizon; null when not enough forward candles. */
  fwd: Record<Horizon, number | null>;
}

/** True when the symbol-day is in the S2 flow-confirmed subset (§2). */
export function isConfirmed(d: SentimentSymbolDay): boolean {
  if (d.netOTMflow == null) return false;
  if (Math.abs(d.netScore) < NETSCORE_FLOOR || Math.abs(d.netOTMflow) < NETOTMFLOW_FLOOR) return false;
  return Math.sign(d.netScore) === Math.sign(d.netOTMflow);
}

// ── forward returns (pure; no look-ahead) ────────────────────────────────────

export interface DatedBar {
  date: string; // YYYY-MM-DD
  open: number;
  close: number;
}

const HORIZON_DAYS: Record<Horizon, number> = { '1d': 1, '5d': 5, '20d': 20 };

/**
 * Raw forward returns for one symbol's signal days against its own daily bars.
 * Signal known at close of day t ⇒ entry at day t+1 open, exit at close of the
 * bar `h` trading days after t. Returns a map date → {horizon → raw return|null}.
 * Bars must be ascending and unique by date.
 */
export function rawForwardReturns(
  signalDates: readonly string[],
  bars: readonly DatedBar[],
): Map<string, Record<Horizon, number | null>> {
  const idxByDate = new Map<string, number>();
  bars.forEach((b, i) => idxByDate.set(b.date, i));
  const out = new Map<string, Record<Horizon, number | null>>();

  for (const date of signalDates) {
    const t = idxByDate.get(date);
    const fwd: Record<Horizon, number | null> = { '1d': null, '5d': null, '20d': null };
    if (t != null) {
      const entryBar = bars[t + 1];
      if (entryBar && entryBar.open > 0) {
        for (const h of HORIZONS) {
          const exitBar = bars[t + HORIZON_DAYS[h]];
          if (exitBar && exitBar.close > 0) fwd[h] = exitBar.close / entryBar.open - 1;
        }
      }
    }
    out.set(date, fwd);
  }
  return out;
}

/**
 * De-market raw returns: subtract the equal-weight cross-sectional mean for each
 * (date, horizon) cohort, so we measure cross-sectional skill, not beta (§2).
 * Mutates a copy; input map keyed `${date}|${symbol}` → raw return record.
 */
export function deMarket(
  raw: ReadonlyMap<string, Record<Horizon, number | null>>,
): Map<string, Record<Horizon, number | null>> {
  // Collect per (date, horizon) the present returns.
  const cohort = new Map<string, number[]>(); // `${date}|${h}` → returns
  for (const [key, rec] of raw) {
    const date = key.split('|')[0];
    for (const h of HORIZONS) {
      const v = rec[h];
      if (v != null) {
        const ck = `${date}|${h}`;
        const arr = cohort.get(ck);
        if (arr) arr.push(v);
        else cohort.set(ck, [v]);
      }
    }
  }
  const marketMean = new Map<string, number>();
  for (const [ck, arr] of cohort) marketMean.set(ck, mean(arr));

  const out = new Map<string, Record<Horizon, number | null>>();
  for (const [key, rec] of raw) {
    const date = key.split('|')[0];
    const adj: Record<Horizon, number | null> = { '1d': null, '5d': null, '20d': null };
    for (const h of HORIZONS) {
      const v = rec[h];
      if (v != null) adj[h] = v - (marketMean.get(`${date}|${h}`) ?? 0);
    }
    out.set(key, adj);
  }
  return out;
}

// ── IC / ICIR ────────────────────────────────────────────────────────────────

export interface IcStat {
  horizon: Horizon;
  /** Mean of the per-day Spearman ICs. */
  meanIC: number;
  icStd: number;
  /** Information ratio = meanIC / icStd. */
  icir: number;
  /** Number of trading days with a usable cross-section. */
  nDays: number;
  /** Pooled Spearman across all (signal, return) pairs. */
  pooledIC: number | null;
  nPairs: number;
}

/**
 * Per-horizon IC stats over a subset of symbol-days. For each day, Spearman of
 * `netScore` against the de-market forward return across the symbol cross-section
 * (≥ {@link MIN_CROSS_SECTION} symbols required); then mean / std / ICIR across
 * days. Pooled Spearman reported alongside as a second view (§3.1).
 */
export function computeIc(days: readonly SentimentSymbolDay[]): Record<Horizon, IcStat> {
  const byDate = new Map<string, SentimentSymbolDay[]>();
  for (const d of days) {
    const arr = byDate.get(d.date);
    if (arr) arr.push(d);
    else byDate.set(d.date, [d]);
  }

  const result = {} as Record<Horizon, IcStat>;
  for (const h of HORIZONS) {
    const dailyICs: number[] = [];
    const pooledSig: number[] = [];
    const pooledRet: number[] = [];
    for (const arr of byDate.values()) {
      const sig: number[] = [];
      const ret: number[] = [];
      for (const d of arr) {
        const r = d.fwd[h];
        if (r != null) {
          sig.push(d.netScore);
          ret.push(r);
        }
      }
      pooledSig.push(...sig);
      pooledRet.push(...ret);
      if (sig.length >= MIN_CROSS_SECTION) {
        const ic = spearman(sig, ret);
        if (ic != null) dailyICs.push(ic);
      }
    }
    const m = mean(dailyICs);
    const s = std(dailyICs);
    result[h] = {
      horizon: h,
      meanIC: m,
      icStd: s,
      icir: s > 0 ? m / s : 0,
      nDays: dailyICs.length,
      pooledIC: spearman(pooledSig, pooledRet),
      nPairs: pooledSig.length,
    };
  }
  return result;
}

// ── bucketed returns ─────────────────────────────────────────────────────────

export interface BucketStat {
  bucket: string;
  n: number;
  meanRet: number;
  medianRet: number;
  ci95: [number, number] | null;
}

function bucketStat(bucket: string, rets: number[], seed: number): BucketStat {
  return {
    bucket,
    n: rets.length,
    meanRet: mean(rets),
    medianRet: median(rets),
    ci95: bootstrapMeanCI(rets, { seed }),
  };
}

/** Bucketed forward returns by `tilt` for one horizon (§3.2). */
export function bucketByTilt(days: readonly SentimentSymbolDay[], h: Horizon): BucketStat[] {
  const order: Tilt[] = ['bearish', 'neutral', 'bullish'];
  return order.map((t, i) =>
    bucketStat(
      t,
      days.filter((d) => d.tilt === t && d.fwd[h] != null).map((d) => d.fwd[h] as number),
      0x1000 + i,
    ),
  );
}

/** Bucketed forward returns by netScore quintile for one horizon (§3.2). */
export function bucketByQuintile(days: readonly SentimentSymbolDay[], h: Horizon): BucketStat[] {
  const withRet = days.filter((d) => d.fwd[h] != null);
  if (withRet.length === 0) return [];
  const sorted = [...withRet].sort((a, b) => a.netScore - b.netScore);
  const buckets: number[][] = [[], [], [], [], []];
  sorted.forEach((d, i) => {
    const q = Math.min(4, Math.floor((i * 5) / sorted.length));
    buckets[q].push(d.fwd[h] as number);
  });
  return buckets.map((rets, i) => bucketStat(`Q${i + 1}`, rets, 0x2000 + i));
}

/** True when bucket means rise monotonically Q1→Q5 (the expected direction). */
export function isMonotoneIncreasing(buckets: readonly BucketStat[]): boolean {
  const nonEmpty = buckets.filter((b) => b.n > 0);
  if (nonEmpty.length < 2) return false;
  for (let i = 1; i < nonEmpty.length; i++) {
    if (nonEmpty[i].meanRet < nonEmpty[i - 1].meanRet) return false;
  }
  return true;
}

// ── study + §4 gate ──────────────────────────────────────────────────────────

/**
 * Gate verdict. `PENDING_FLOW` (TRA-1182) is distinct from `FAIL`: it means the
 * flow-confirmed (S2) leg could not be measured because no option-chain days were
 * captured yet — NOT that the signal was measured and found dead.
 */
export type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'PENDING_FLOW';

export interface StudyReport {
  sample: {
    nSymbolDays: number;
    nUsableSymbolDays: number;
    nTradingDays: number;
    /** Distinct trading days with at least one joined option-chain (flow) snapshot. */
    nChainDays: number;
    nConfirmedSymbolDays: number;
    nBuzzOnlySymbolDays: number;
    perSymbol: Record<string, number>;
  };
  /** S1 — sentiment alone, over all usable symbol-days. */
  s1Ic: Record<Horizon, IcStat>;
  /** S2 — confirmed subset. */
  s2Ic: Record<Horizon, IcStat>;
  /** IC(S2 confirmed) − IC(S1 all) per horizon (§3.3 headline). */
  confirmedVsAloneDelta: Record<Horizon, number>;
  s1BucketsByQuintile: Record<Horizon, BucketStat[]>;
  s2BucketsByQuintile: Record<Horizon, BucketStat[]>;
  s2BucketsByTilt: Record<Horizon, BucketStat[]>;
  verdict: Verdict;
  verdictReasons: string[];
}

/**
 * Run the full §3 measurement and grade it against the §4 pre-registered gate.
 * `days` is the assembled, de-market symbol-day set (all quality cohorts). The
 * §2 quality filter is applied here: S1/S2 ICs use only `usable` days; untagged
 * "buzz-only" days are counted but excluded from the IC.
 */
export function runSentimentStudy(days: readonly SentimentSymbolDay[]): StudyReport {
  const usable = days.filter((d) => d.usable);
  const buzzOnly = days.filter((d) => !d.usable);
  const confirmed = usable.filter(isConfirmed);

  const tradingDays = new Set(usable.map((d) => d.date));
  // §4 / TRA-1182 — option-chain (flow) coverage: distinct days where a chain
  // snapshot joined (netOTMflow present). 0 ⇒ S2 is unmeasured, not dead.
  const chainDays = new Set(days.filter((d) => d.netOTMflow != null).map((d) => d.date));
  const perSymbol: Record<string, number> = {};
  for (const d of usable) perSymbol[d.symbol] = (perSymbol[d.symbol] ?? 0) + 1;

  const s1Ic = computeIc(usable);
  const s2Ic = computeIc(confirmed);

  const confirmedVsAloneDelta = {} as Record<Horizon, number>;
  for (const h of HORIZONS) confirmedVsAloneDelta[h] = s2Ic[h].meanIC - s1Ic[h].meanIC;

  const s1BucketsByQuintile = {} as Record<Horizon, BucketStat[]>;
  const s2BucketsByQuintile = {} as Record<Horizon, BucketStat[]>;
  const s2BucketsByTilt = {} as Record<Horizon, BucketStat[]>;
  for (const h of HORIZONS) {
    s1BucketsByQuintile[h] = bucketByQuintile(usable, h);
    s2BucketsByQuintile[h] = bucketByQuintile(confirmed, h);
    s2BucketsByTilt[h] = bucketByTilt(confirmed, h);
  }

  const sample = {
    nSymbolDays: days.length,
    nUsableSymbolDays: usable.length,
    nTradingDays: tradingDays.size,
    nChainDays: chainDays.size,
    nConfirmedSymbolDays: confirmed.length,
    nBuzzOnlySymbolDays: buzzOnly.length,
    perSymbol,
  };

  const { verdict, verdictReasons } = gradeGate({
    sample,
    s1Ic,
    s2Ic,
    confirmedVsAloneDelta,
    s1BucketsByQuintile,
    s2BucketsByQuintile,
  });

  return {
    sample,
    s1Ic,
    s2Ic,
    confirmedVsAloneDelta,
    s1BucketsByQuintile,
    s2BucketsByQuintile,
    s2BucketsByTilt,
    verdict,
    verdictReasons,
  };
}

/**
 * TRA-1182 — grade ONE signal's IC set (here S1, sentiment-alone) against the §4
 * thresholds, standalone (no "beats S1" leg, which only applies to S2). Returns a
 * real PASS/FAIL/INCONCLUSIVE so the study still produces a usable verdict while
 * S2 flow data is absent. Mirrors the S2 logic minus the flow-edge comparison.
 */
function gradeSignalAlone(
  label: string,
  sample: { nTradingDays: number; nUsableSymbolDays: number },
  ic: Record<Horizon, IcStat>,
  bucketsByQuintile: Record<Horizon, BucketStat[]>,
): { verdict: Verdict; reason: string } {
  if (sample.nTradingDays < MIN_TRADING_DAYS || sample.nUsableSymbolDays < MIN_USABLE_SYMBOL_DAYS) {
    return {
      verdict: 'INCONCLUSIVE',
      reason:
        `${label} sample below the §4 bar (${sample.nTradingDays}/${MIN_TRADING_DAYS} trading days, ` +
        `${sample.nUsableSymbolDays}/${MIN_USABLE_SYMBOL_DAYS} usable symbol-days) — ${label} INCONCLUSIVE, keep collecting.`,
    };
  }
  const passing = HORIZONS.filter((h) => Math.abs(ic[h].meanIC) >= IC_FLOOR && ic[h].icir >= ICIR_FLOOR);
  const signs = new Set(passing.map((h) => Math.sign(ic[h].meanIC)));
  const consistentSign = passing.length >= 2 && signs.size === 1;
  const monotone =
    isMonotoneIncreasing(bucketsByQuintile['5d']) || isMonotoneIncreasing(bucketsByQuintile['20d']);

  if (consistentSign && monotone) {
    return {
      verdict: 'PASS',
      reason:
        `${label} clears the §4 bar on horizons [${passing.join(', ')}] ` +
        `(|IC|≥${IC_FLOOR}, ICIR≥${ICIR_FLOOR}, consistent sign, monotone buckets) — ${label} PASS.`,
    };
  }
  const anySignal = HORIZONS.some((h) => Math.abs(ic[h].meanIC) >= IC_FLOOR);
  if (!anySignal) {
    return {
      verdict: 'FAIL',
      reason: `${label} IC indistinguishable from zero on every horizon — ${label} FAIL (dead signal).`,
    };
  }
  return {
    verdict: 'INCONCLUSIVE',
    reason:
      `${label} shows IC but not decisively (passing [${passing.join(', ') || 'none'}], ` +
      `consistentSign=${consistentSign}, monotone=${monotone}) — ${label} INCONCLUSIVE, keep collecting.`,
  };
}

/**
 * §4 pre-registered verdict gate. The thresholds are fixed in the study doc so a
 * result can't be rationalised after the fact.
 *
 * TRA-1182: before grading S2, guard on flow coverage. With ZERO captured
 * option-chain days the S2 IC is *unmeasured* (TRA-826 has not provisioned
 * `TRADIER_API_TOKEN`), so returning a FAIL here would kill the direction off
 * absent flow data — a structural false negative. Instead the verdict is
 * `PENDING_FLOW` and S1 (sentiment-alone) is graded so the run is still usable.
 */
export function gradeGate(args: {
  sample: { nTradingDays: number; nUsableSymbolDays: number; nChainDays: number };
  s1Ic: Record<Horizon, IcStat>;
  s2Ic: Record<Horizon, IcStat>;
  confirmedVsAloneDelta: Record<Horizon, number>;
  s1BucketsByQuintile: Record<Horizon, BucketStat[]>;
  s2BucketsByQuintile: Record<Horizon, BucketStat[]>;
}): { verdict: Verdict; verdictReasons: string[] } {
  const { sample, s1Ic, s2Ic, confirmedVsAloneDelta, s1BucketsByQuintile, s2BucketsByQuintile } = args;
  const reasons: string[] = [];

  // ── TRA-1182 flow-coverage guard ────────────────────────────────────────────
  // No option-chain days ⇒ S2 cannot be measured. Do NOT fall through to the
  // S2-driven FAIL path (which would fire on `anyS2Signal=false` = absent data).
  // Return PENDING_FLOW + a real S1-only grade. Takes precedence over the sample
  // bar so the accruing sentiment-only sample reports PENDING, never a spurious
  // FAIL, before TRA-826 lands.
  if (sample.nChainDays < MIN_CHAIN_DAYS) {
    const s1 = gradeSignalAlone('S1 (sentiment-alone)', sample, s1Ic, s1BucketsByQuintile);
    reasons.push(
      `S2 (flow-confirmed) unmeasured: ${sample.nChainDays} option-chain day(s) captured ` +
        `(< ${MIN_CHAIN_DAYS}; TRA-826 TRADIER_API_TOKEN not yet provisioned) — verdict PENDING_FLOW, ` +
        `not FAIL (S2 is unmeasured, not a measured-dead signal).`,
    );
    reasons.push(s1.reason);
    return { verdict: 'PENDING_FLOW', verdictReasons: reasons };
  }

  // Sample bar first — too small ⇒ INCONCLUSIVE regardless of point estimates.
  if (sample.nTradingDays < MIN_TRADING_DAYS || sample.nUsableSymbolDays < MIN_USABLE_SYMBOL_DAYS) {
    reasons.push(
      `Sample below the §4 bar: ${sample.nTradingDays}/${MIN_TRADING_DAYS} trading days, ` +
        `${sample.nUsableSymbolDays}/${MIN_USABLE_SYMBOL_DAYS} usable symbol-days — keep collecting.`,
    );
    return { verdict: 'INCONCLUSIVE', verdictReasons: reasons };
  }

  // S2 confirmed: |meanIC| ≥ 0.03 AND ICIR ≥ 0.3 on ≥ 2 horizons, consistent sign.
  const passingHorizons = HORIZONS.filter(
    (h) => Math.abs(s2Ic[h].meanIC) >= IC_FLOOR && s2Ic[h].icir >= ICIR_FLOOR,
  );
  const signs = new Set(passingHorizons.map((h) => Math.sign(s2Ic[h].meanIC)));
  const consistentSign = passingHorizons.length >= 2 && signs.size === 1;

  // S2 beats S1 on the passing horizon(s).
  const beatsS1 = passingHorizons.every((h) => confirmedVsAloneDelta[h] >= S2_BEATS_S1_FLOOR)
    && passingHorizons.length >= 2;

  // Monotone bucketed returns on the 5d or 20d horizon.
  const monotone =
    isMonotoneIncreasing(s2BucketsByQuintile['5d']) ||
    isMonotoneIncreasing(s2BucketsByQuintile['20d']);

  if (passingHorizons.length >= 2 && consistentSign && beatsS1 && monotone) {
    reasons.push(
      `S2 confirmed clears the §4 bar on horizons [${passingHorizons.join(', ')}] ` +
        `(|IC|≥${IC_FLOOR}, ICIR≥${ICIR_FLOOR}, consistent sign), beats S1 by ≥${S2_BEATS_S1_FLOOR}, ` +
        `and bucketed returns are monotone — PASS.`,
    );
    return { verdict: 'PASS', verdictReasons: reasons };
  }

  // Distinguish a clean FAIL (signal is dead / no flow edge) from INCONCLUSIVE.
  // Reachable only with ≥1 captured chain-day (the TRA-1182 guard returns
  // PENDING_FLOW above when flow data is absent), so this is a *measured* dead
  // signal, not a false negative off missing data.
  const anyS2Signal = HORIZONS.some((h) => Math.abs(s2Ic[h].meanIC) >= IC_FLOOR);
  if (!anyS2Signal) {
    reasons.push(
      `S2 confirmed IC indistinguishable from zero on every horizon over ` +
        `${sample.nChainDays} captured chain-day(s) — FAIL (kill the direction).`,
    );
    return { verdict: 'FAIL', verdictReasons: reasons };
  }
  if (passingHorizons.length >= 2 && consistentSign && !beatsS1) {
    reasons.push('S2 shows IC but does not beat S1 by the §4 margin — flow confirmation carries no edge: FAIL.');
    return { verdict: 'FAIL', verdictReasons: reasons };
  }

  reasons.push(
    `Sample met but the S2 edge is not yet decisive (passing horizons: ` +
      `[${passingHorizons.join(', ') || 'none'}], consistentSign=${consistentSign}, beatsS1=${beatsS1}, ` +
      `monotone=${monotone}) — INCONCLUSIVE, keep collecting.`,
  );
  return { verdict: 'INCONCLUSIVE', verdictReasons: reasons };
}
