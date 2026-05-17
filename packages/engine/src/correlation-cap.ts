import type { Candle } from '@trading-app/shared';

/**
 * TRA-423 — Portfolio correlation / concentration cap.
 *
 * Implements the TRA-411 `correlation-cap-spec` quant document: a correlation-
 * cluster concentration cap layered on top of the existing `maxOpen` /
 * `maxSector` portfolio caps (it does not replace them).
 *
 *   §3  rolling pairwise daily-return correlation matrix + history fallback
 *   §4  single-linkage union-find clustering at `corrClusterThreshold`
 *   §5  five config keys with recommended defaults
 *   §6  admission rule: count cap is a hard reject; risk/notional caps
 *       scale the candidate down to exact headroom, rejecting below the
 *       `minTradeRiskPct` floor
 *
 * Everything here is pure — the live engine and the backtest runner each
 * supply their own open-position snapshot, managed equity, and correlation
 * source, then act on the returned {@link ClusterCapDecision}.
 */

const MS_PER_DAY = 86_400_000;

/** §3 — trailing daily observations used for the correlation estimate (~3 months). */
export const CORRELATION_WINDOW_OBS = 90;

/**
 * §3 — minimum daily observations for a symbol before its real correlations
 * are trusted. Below this the conservative insufficient-history fallback
 * applies (assume fully correlated within an asset class).
 */
export const MIN_CORRELATION_OBS = 30;

/**
 * §5 — the five config keys. All are tunable without a code change; the
 * recommended defaults live in {@link DEFAULT_CORRELATION_CAP_CONFIG}.
 */
export interface CorrelationCapConfig {
  /** §4 — single-linkage threshold; pairs with ρ ≥ this land in one cluster. */
  corrClusterThreshold: number;
  /** §5 — max simultaneously-open positions in one correlation cluster (hard cap). */
  maxPositionsPerCluster: number;
  /** §5 — sum of open per-trade dollar risk within one cluster, as a fraction of managed equity. */
  maxClusterRiskPct: number;
  /** §5 — sum of open per-trade dollar risk across the whole book, as a fraction of managed equity. */
  maxPortfolioRiskPct: number;
  /** §5 — gross notional within one cluster, as a fraction of managed equity. */
  maxClusterNotionalPct: number;
  /** §5/§6 — scale-down floor; a candidate that would shrink below this is rejected instead. */
  minTradeRiskPct: number;
}

/** §5 — recommended defaults from the TRA-411 spec. */
export const DEFAULT_CORRELATION_CAP_CONFIG: CorrelationCapConfig = {
  corrClusterThreshold: 0.65,
  maxPositionsPerCluster: 2,
  maxClusterRiskPct: 0.02,
  maxPortfolioRiskPct: 0.06,
  maxClusterNotionalPct: 0.40,
  minTradeRiskPct: 0.0025,
};

/**
 * Merge a partial override onto the recommended defaults. Non-finite values in
 * the override are ignored so a malformed config key can never silently
 * disable a cap.
 */
export function resolveCorrelationCapConfig(
  override?: Partial<CorrelationCapConfig>,
): CorrelationCapConfig {
  const out: CorrelationCapConfig = { ...DEFAULT_CORRELATION_CAP_CONFIG };
  if (!override) return out;
  for (const key of Object.keys(out) as Array<keyof CorrelationCapConfig>) {
    const v = override[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

/**
 * §3 — asset-class bucket. `*-USD` tickers are crypto, everything else equity.
 * Used by the insufficient-history fallback: unknown same-class pairs are
 * assumed fully correlated, cross-class pairs get a mild 0.30.
 */
export function assetClassOf(symbol: string): 'crypto' | 'equity' {
  return /-USD$/i.test(symbol) ? 'crypto' : 'equity';
}

/** UTC day index for a millisecond timestamp. */
export function utcDayOf(timestamp: number): number {
  return Math.floor(timestamp / MS_PER_DAY);
}

/**
 * §3 — resample candles to one close per UTC day. Keeps the last (latest
 * timestamp) candle of each day; returns the series sorted ascending by day.
 */
export function toDailyCloses(
  candles: readonly Candle[],
): Array<{ day: number; close: number }> {
  const byDay = new Map<number, { day: number; close: number; ts: number }>();
  for (const c of candles) {
    if (!Number.isFinite(c.close) || c.close <= 0) continue;
    const day = utcDayOf(c.timestamp);
    const prev = byDay.get(day);
    if (!prev || c.timestamp >= prev.ts) {
      byDay.set(day, { day, close: c.close, ts: c.timestamp });
    }
  }
  return Array.from(byDay.values())
    .sort((a, b) => a.day - b.day)
    .map(({ day, close }) => ({ day, close }));
}

/** §3 — daily log returns `ln(C_t / C_{t-1})` keyed by the closing UTC day. */
export function dailyLogReturns(
  dailyCloses: ReadonlyArray<{ day: number; close: number }>,
): Array<{ day: number; ret: number }> {
  const out: Array<{ day: number; ret: number }> = [];
  for (let i = 1; i < dailyCloses.length; i++) {
    const prev = dailyCloses[i - 1].close;
    const cur = dailyCloses[i].close;
    if (prev > 0 && cur > 0) {
      out.push({ day: dailyCloses[i].day, ret: Math.log(cur / prev) });
    }
  }
  return out;
}

/** Pearson correlation of two equal-length series. Returns 0 when undefined. */
export function pearson(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va <= 0 || vb <= 0) return 0;
  return cov / Math.sqrt(va * vb);
}

/** A `(symbolA, symbolB) → ρ` lookup, as consumed by {@link formClusters}. */
export type CorrelationFn = (a: string, b: string) => number;

/**
 * §3 — rolling pairwise return-correlation matrix.
 *
 * Built once from a per-symbol daily-candle map; callers cache one instance
 * per UTC day (correlation among crypto majors is slow-moving — recomputing
 * per bar is wasted work). {@link correlation} applies the spec fallback and
 * the negative-clamp, so it is safe to hand straight to {@link formClusters}
 * or {@link admitUnderClusterCap}.
 */
export class CorrelationMatrix {
  /** symbol → (UTC day → log return), trimmed to the trailing window. */
  private readonly returnsBySymbol = new Map<string, Map<number, number>>();

  constructor(
    dailyCandlesBySymbol:
      | ReadonlyMap<string, readonly Candle[]>
      | Record<string, readonly Candle[]>,
    windowObs: number = CORRELATION_WINDOW_OBS,
  ) {
    const entries =
      dailyCandlesBySymbol instanceof Map
        ? Array.from(dailyCandlesBySymbol.entries())
        : Object.entries(dailyCandlesBySymbol);
    for (const [symbol, candles] of entries) {
      const returns = dailyLogReturns(toDailyCloses(candles ?? []));
      const trimmed = returns.slice(-windowObs);
      const map = new Map<number, number>();
      for (const { day, ret } of trimmed) map.set(day, ret);
      this.returnsBySymbol.set(symbol, map);
    }
  }

  /** Trailing daily-return observation count for a symbol (0 if unknown). */
  observationCount(symbol: string): number {
    return this.returnsBySymbol.get(symbol)?.size ?? 0;
  }

  /**
   * §3 — ρ for a symbol pair, with the insufficient-history fallback and the
   * negative-clamp applied. Arrow-bound so it can be passed by reference as a
   * {@link CorrelationFn}.
   *
   *   - same symbol            ⇒ 1.0
   *   - either side < 30 obs   ⇒ 1.0 within an asset class, 0.30 cross-class
   *   - overlap < 30 days      ⇒ same fallback (not enough paired data)
   *   - otherwise              ⇒ Pearson over the overlapping window,
   *                              negative correlations clamped to 0
   */
  correlation = (a: string, b: string): number => {
    if (a === b) return 1.0;
    const ra = this.returnsBySymbol.get(a);
    const rb = this.returnsBySymbol.get(b);
    const fallback = assetClassOf(a) === assetClassOf(b) ? 1.0 : 0.30;
    if (!ra || !rb) return fallback;
    if (ra.size < MIN_CORRELATION_OBS || rb.size < MIN_CORRELATION_OBS) {
      return fallback;
    }
    const sa: number[] = [];
    const sb: number[] = [];
    for (const [day, va] of ra) {
      const vb = rb.get(day);
      if (vb !== undefined) {
        sa.push(va);
        sb.push(vb);
      }
    }
    if (sa.length < MIN_CORRELATION_OBS) return fallback;
    const rho = pearson(sa, sb);
    return rho < 0 ? 0 : rho;
  };
}

/**
 * §4 — group symbols into correlation clusters by single-linkage union-find.
 * Any pair with `ρ ≥ threshold` is unioned; linkage is transitive
 * (A~B, B~C ⇒ {A,B,C}). Returns clusters with symbols sorted and the cluster
 * list itself sorted, so the output is deterministic for tests.
 */
export function formClusters(
  symbols: readonly string[],
  corr: CorrelationFn,
  threshold: number,
): string[][] {
  const uniq = Array.from(new Set(symbols));
  const parent = new Map<string, string>();
  for (const s of uniq) parent.set(s, s);

  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== cur) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (x: string, y: string): void => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };

  for (let i = 0; i < uniq.length; i++) {
    for (let j = i + 1; j < uniq.length; j++) {
      if (corr(uniq[i], uniq[j]) >= threshold) union(uniq[i], uniq[j]);
    }
  }

  const groups = new Map<string, string[]>();
  for (const s of uniq) {
    const root = find(s);
    const g = groups.get(root);
    if (g) g.push(s);
    else groups.set(root, [s]);
  }
  return Array.from(groups.values())
    .map((g) => g.sort())
    .sort((a, b) => a[0].localeCompare(b[0]));
}

/** An open position reduced to the fields the cluster cap reasons about. */
export interface ClusterCapPosition {
  symbol: string;
  /** Per-trade dollar risk = `|entry − stop| × qty`. */
  risk: number;
  /** Gross dollar notional = `entryPrice × qty`. */
  notional: number;
}

/** A candidate entry reduced to the fields the cluster cap reasons about. */
export type ClusterCapCandidate = ClusterCapPosition;

/** Which scale-down cap (§6.3–6.5) bound the candidate, if any. */
export type ClusterCapBinding =
  | 'cluster_risk'
  | 'portfolio_risk'
  | 'cluster_notional';

/** Outcome of {@link admitUnderClusterCap}. */
export interface ClusterCapDecision {
  /** True when the trade may open (possibly scaled down). */
  admitted: boolean;
  /**
   * Position-size multiplier in (0, 1]. `1` ⇒ full size; `< 1` ⇒ scaled down
   * to exact headroom; `0` ⇒ rejected (see {@link reason}).
   */
  scale: number;
  /** Set when `admitted` is false. */
  reason?: 'max_positions_per_cluster' | 'below_min_trade_risk';
  /** The cap that bound the candidate's size, or `null` when none did. */
  bindingCap: ClusterCapBinding | null;
  /** The correlation cluster the candidate symbol landed in (sorted). */
  clusterSymbols: string[];
}

/**
 * §6 — admission rule for a new entry.
 *
 * Forms clusters over `{open symbols} ∪ {candidate}` (§4), then evaluates the
 * caps against the cluster containing the candidate:
 *
 *   §6.2  position-count cap — hard reject when the cluster is already full.
 *   §6.3  cluster risk cap   ┐
 *   §6.4  portfolio risk cap ├ scale the candidate down to the most-binding
 *   §6.5  cluster notional   ┘ headroom; reject below `minTradeRiskPct`.
 *
 * Risk and notional scale together for a fixed stop, so the notional headroom
 * is converted to risk units and all three scale-down caps compare on one
 * axis. The caller multiplies its sized quantity by {@link ClusterCapDecision.scale}.
 */
export function admitUnderClusterCap(
  candidate: ClusterCapCandidate,
  open: readonly ClusterCapPosition[],
  managedEquity: number,
  corr: CorrelationFn,
  config: CorrelationCapConfig = DEFAULT_CORRELATION_CAP_CONFIG,
): ClusterCapDecision {
  const symbols = [candidate.symbol, ...open.map((p) => p.symbol)];
  const clusters = formClusters(symbols, corr, config.corrClusterThreshold);
  const cluster =
    clusters.find((c) => c.includes(candidate.symbol)) ?? [candidate.symbol];
  const clusterSet = new Set(cluster);
  const openInCluster = open.filter((p) => clusterSet.has(p.symbol));

  // §6.2 — position-count cap is always a hard reject; you cannot half-open
  // a position.
  if (openInCluster.length >= config.maxPositionsPerCluster) {
    return {
      admitted: false,
      scale: 0,
      reason: 'max_positions_per_cluster',
      bindingCap: null,
      clusterSymbols: cluster,
    };
  }

  // A candidate with no measurable risk cannot be scaled — reject it rather
  // than divide by zero below.
  if (!(candidate.risk > 0)) {
    return {
      admitted: false,
      scale: 0,
      reason: 'below_min_trade_risk',
      bindingCap: null,
      clusterSymbols: cluster,
    };
  }

  const clusterOpenRisk = openInCluster.reduce((s, p) => s + p.risk, 0);
  const clusterOpenNotional = openInCluster.reduce((s, p) => s + p.notional, 0);
  const portfolioOpenRisk = open.reduce((s, p) => s + p.risk, 0);

  const clusterRiskHeadroom =
    config.maxClusterRiskPct * managedEquity - clusterOpenRisk;
  const portfolioRiskHeadroom =
    config.maxPortfolioRiskPct * managedEquity - portfolioOpenRisk;
  // §6.5 — notional and risk scale together for a fixed stop, so express the
  // cluster-notional headroom in risk units and compare it on the same axis.
  const notionalHeadroom =
    config.maxClusterNotionalPct * managedEquity - clusterOpenNotional;
  const notionalRiskHeadroom =
    candidate.notional > 0
      ? notionalHeadroom * (candidate.risk / candidate.notional)
      : Number.POSITIVE_INFINITY;

  // riskAllowed = min headroom across the three scale-down caps, never above
  // the candidate's intended risk.
  let riskAllowed = candidate.risk;
  let bindingCap: ClusterCapBinding | null = null;
  const consider = (headroom: number, cap: ClusterCapBinding): void => {
    if (headroom < riskAllowed) {
      riskAllowed = headroom;
      bindingCap = cap;
    }
  };
  consider(clusterRiskHeadroom, 'cluster_risk');
  consider(portfolioRiskHeadroom, 'portfolio_risk');
  consider(notionalRiskHeadroom, 'cluster_notional');

  // No cap bound the candidate — admit at full size.
  if (bindingCap === null) {
    return { admitted: true, scale: 1, bindingCap: null, clusterSymbols: cluster };
  }

  // §6 — below the floor, reject instead of shrinking to a token size.
  if (riskAllowed < config.minTradeRiskPct * managedEquity) {
    return {
      admitted: false,
      scale: 0,
      reason: 'below_min_trade_risk',
      bindingCap,
      clusterSymbols: cluster,
    };
  }
  return {
    admitted: true,
    scale: riskAllowed / candidate.risk,
    bindingCap,
    clusterSymbols: cluster,
  };
}
