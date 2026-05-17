import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import {
  CorrelationMatrix,
  admitUnderClusterCap,
  formClusters,
  resolveCorrelationCapConfig,
  pearson,
  DEFAULT_CORRELATION_CAP_CONFIG,
  type CorrelationFn,
  type ClusterCapPosition,
} from './correlation-cap.js';

const MS_PER_DAY = 86_400_000;

/** Build a daily candle series for `symbol` from a list of closes. */
function dailyCandles(symbol: string, closes: number[], startDay = 20_000): Candle[] {
  return closes.map((close, i) => ({
    symbol,
    timestamp: (startDay + i) * MS_PER_DAY,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  }));
}

/** A correlation fn driven by an explicit pair table (symmetric, ρ=1 on the diagonal). */
function tableCorr(pairs: Record<string, number>): CorrelationFn {
  return (a, b) => {
    if (a === b) return 1;
    return pairs[`${a}|${b}`] ?? pairs[`${b}|${a}`] ?? 0;
  };
}

describe('pearson', () => {
  it('is +1 for a perfectly increasing relationship', () => {
    expect(pearson([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 10);
  });
  it('is -1 for a perfectly inverse relationship', () => {
    expect(pearson([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 10);
  });
  it('returns 0 when a series has no variance', () => {
    expect(pearson([5, 5, 5], [1, 2, 3])).toBe(0);
  });
});

describe('formClusters — single-linkage union-find (spec §4)', () => {
  it('groups a transitively-linked chain A~B~C into one cluster', () => {
    // A~B and B~C are above threshold; A~C is not — single linkage still
    // unions all three transitively.
    const corr = tableCorr({ 'A|B': 0.7, 'B|C': 0.7, 'A|C': 0.1 });
    const clusters = formClusters(['A', 'B', 'C'], corr, 0.65);
    expect(clusters).toEqual([['A', 'B', 'C']]);
  });

  it('keeps uncorrelated symbols in separate clusters', () => {
    const corr = tableCorr({ 'A|B': 0.2, 'A|C': 0.1, 'B|C': 0.3 });
    const clusters = formClusters(['A', 'B', 'C'], corr, 0.65);
    expect(clusters).toEqual([['A'], ['B'], ['C']]);
  });

  it('forms two distinct clusters when linkage splits the universe', () => {
    const corr = tableCorr({ 'A|B': 0.9, 'C|D': 0.8, 'B|C': 0.1 });
    const clusters = formClusters(['A', 'B', 'C', 'D'], corr, 0.65);
    expect(clusters).toEqual([['A', 'B'], ['C', 'D']]);
  });

  it('treats a pair exactly at the threshold as linked', () => {
    const corr = tableCorr({ 'A|B': 0.65 });
    expect(formClusters(['A', 'B'], corr, 0.65)).toEqual([['A', 'B']]);
  });
});

describe('CorrelationMatrix — estimation + fallback (spec §3)', () => {
  it('estimates ρ ≈ 1 for two symbols with identical daily returns', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 * 1.01 ** i);
    const m = new CorrelationMatrix({
      'BTC-USD': dailyCandles('BTC-USD', closes),
      'ETH-USD': dailyCandles('ETH-USD', closes),
    });
    expect(m.correlation('BTC-USD', 'ETH-USD')).toBeCloseTo(1, 6);
  });

  it('clamps a negative correlation to 0 for clustering purposes', () => {
    // ETH zig-zags inversely to BTC — raw Pearson is negative, clamped to 0.
    const btc: number[] = [];
    const eth: number[] = [];
    let b = 100;
    let e = 100;
    for (let i = 0; i < 50; i++) {
      const up = i % 2 === 0;
      b *= up ? 1.02 : 0.98;
      e *= up ? 0.98 : 1.02;
      btc.push(b);
      eth.push(e);
    }
    const m = new CorrelationMatrix({
      'BTC-USD': dailyCandles('BTC-USD', btc),
      'ETH-USD': dailyCandles('ETH-USD', eth),
    });
    expect(m.correlation('BTC-USD', 'ETH-USD')).toBe(0);
  });

  it('falls back to ρ=1.0 for same-asset-class pairs with insufficient history', () => {
    // Both crypto symbols, < 30 daily observations each.
    const m = new CorrelationMatrix({
      'BTC-USD': dailyCandles('BTC-USD', [100, 101, 102]),
      'SOL-USD': dailyCandles('SOL-USD', [10, 11]),
    });
    expect(m.correlation('BTC-USD', 'SOL-USD')).toBe(1.0);
  });

  it('falls back to ρ=0.30 for a cross-asset-class pair with missing data', () => {
    const m = new CorrelationMatrix({
      'BTC-USD': dailyCandles('BTC-USD', [100, 101]),
      AAPL: dailyCandles('AAPL', [150, 151]),
    });
    expect(m.correlation('BTC-USD', 'AAPL')).toBe(0.30);
  });

  it('falls back when a symbol is entirely unknown to the matrix', () => {
    const m = new CorrelationMatrix({});
    expect(m.correlation('BTC-USD', 'SOL-USD')).toBe(1.0);
    expect(m.correlation('BTC-USD', 'AAPL')).toBe(0.30);
  });

  it('reports ρ=1.0 for a symbol against itself', () => {
    const m = new CorrelationMatrix({});
    expect(m.correlation('BTC-USD', 'BTC-USD')).toBe(1.0);
  });
});

describe('resolveCorrelationCapConfig', () => {
  it('returns the spec defaults when no override is supplied', () => {
    expect(resolveCorrelationCapConfig()).toEqual(DEFAULT_CORRELATION_CAP_CONFIG);
  });
  it('applies finite overrides and ignores non-finite ones', () => {
    const cfg = resolveCorrelationCapConfig({
      maxPositionsPerCluster: 3,
      maxClusterRiskPct: Number.NaN,
    });
    expect(cfg.maxPositionsPerCluster).toBe(3);
    expect(cfg.maxClusterRiskPct).toBe(DEFAULT_CORRELATION_CAP_CONFIG.maxClusterRiskPct);
  });
});

describe('admitUnderClusterCap — admission rule (spec §6)', () => {
  const EQUITY = 100_000;
  // Recommended defaults → cluster risk cap $2,000, portfolio risk cap $6,000,
  // cluster notional cap $40,000, scale-down floor $250.
  const cfg = DEFAULT_CORRELATION_CAP_CONFIG;
  // Everything correlates — the whole book is a single cluster.
  const oneCluster: CorrelationFn = () => 1;
  // Nothing correlates — every symbol is its own cluster.
  const noCluster: CorrelationFn = (a, b) => (a === b ? 1 : 0);

  it('admits the first entry in an empty book at full size', () => {
    const d = admitUnderClusterCap(
      { symbol: 'BTC-USD', risk: 1_000, notional: 20_000 },
      [],
      EQUITY,
      oneCluster,
      cfg,
    );
    expect(d.admitted).toBe(true);
    expect(d.scale).toBe(1);
    expect(d.bindingCap).toBeNull();
  });

  it('hard-rejects when the cluster already holds maxPositionsPerCluster (spec §6.2)', () => {
    const open: ClusterCapPosition[] = [
      { symbol: 'BTC-USD', risk: 100, notional: 1_000 },
      { symbol: 'SOL-USD', risk: 100, notional: 1_000 },
    ];
    const d = admitUnderClusterCap(
      { symbol: 'ETH-USD', risk: 100, notional: 1_000 },
      open,
      EQUITY,
      oneCluster,
      cfg,
    );
    expect(d.admitted).toBe(false);
    expect(d.reason).toBe('max_positions_per_cluster');
  });

  it('scales the candidate down to exact cluster-risk headroom (spec §6.3)', () => {
    // One open position uses $1,500 of the $2,000 cluster budget → $500 left.
    const open: ClusterCapPosition[] = [
      { symbol: 'BTC-USD', risk: 1_500, notional: 10_000 },
    ];
    const d = admitUnderClusterCap(
      { symbol: 'SOL-USD', risk: 1_000, notional: 10_000 },
      open,
      EQUITY,
      oneCluster,
      cfg,
    );
    expect(d.admitted).toBe(true);
    expect(d.scale).toBeCloseTo(0.5, 10); // $500 / $1,000 intended
    expect(d.bindingCap).toBe('cluster_risk');
  });

  it('hard-rejects when scale-down would fall below minTradeRiskPct (spec §6)', () => {
    // $1,900 of the $2,000 cluster budget used → only $100 headroom, below the
    // $250 floor.
    const open: ClusterCapPosition[] = [
      { symbol: 'BTC-USD', risk: 1_900, notional: 10_000 },
    ];
    const d = admitUnderClusterCap(
      { symbol: 'SOL-USD', risk: 1_000, notional: 10_000 },
      open,
      EQUITY,
      oneCluster,
      cfg,
    );
    expect(d.admitted).toBe(false);
    expect(d.reason).toBe('below_min_trade_risk');
    expect(d.bindingCap).toBe('cluster_risk');
  });

  it('binds on the portfolio risk cap across separate clusters (spec §6.4)', () => {
    // $5,300 open risk in its own cluster → $700 of the $6,000 portfolio
    // budget left. The candidate is in a different (empty) cluster, so the
    // cluster risk cap does not bind — only the portfolio cap does.
    const open: ClusterCapPosition[] = [
      { symbol: 'BTC-USD', risk: 5_300, notional: 10_000 },
    ];
    const d = admitUnderClusterCap(
      { symbol: 'AAPL', risk: 1_000, notional: 10_000 },
      open,
      EQUITY,
      noCluster,
      cfg,
    );
    expect(d.admitted).toBe(true);
    expect(d.scale).toBeCloseTo(0.7, 10); // $700 / $1,000
    expect(d.bindingCap).toBe('portfolio_risk');
  });

  it('binds on the cluster notional cap when risk is small but notional is large (spec §6.5)', () => {
    // $38,000 of the $40,000 cluster-notional budget used → $2,000 headroom.
    // The candidate has a tight stop: $1,000 risk on $5,000 notional, so the
    // notional headroom converts to $2,000 × (1,000/5,000) = $400 of risk.
    const open: ClusterCapPosition[] = [
      { symbol: 'BTC-USD', risk: 100, notional: 38_000 },
    ];
    const d = admitUnderClusterCap(
      { symbol: 'SOL-USD', risk: 1_000, notional: 5_000 },
      open,
      EQUITY,
      oneCluster,
      cfg,
    );
    expect(d.admitted).toBe(true);
    expect(d.scale).toBeCloseTo(0.4, 10); // $400 / $1,000
    expect(d.bindingCap).toBe('cluster_notional');
  });

  it('admits at full size when every cap has headroom', () => {
    const open: ClusterCapPosition[] = [
      { symbol: 'BTC-USD', risk: 500, notional: 5_000 },
    ];
    const d = admitUnderClusterCap(
      { symbol: 'SOL-USD', risk: 1_000, notional: 10_000 },
      open,
      EQUITY,
      oneCluster,
      cfg,
    );
    expect(d.admitted).toBe(true);
    expect(d.scale).toBe(1);
  });

  it('rejects a candidate with no measurable risk', () => {
    const d = admitUnderClusterCap(
      { symbol: 'BTC-USD', risk: 0, notional: 10_000 },
      [],
      EQUITY,
      oneCluster,
      cfg,
    );
    expect(d.admitted).toBe(false);
    expect(d.reason).toBe('below_min_trade_risk');
  });
});
