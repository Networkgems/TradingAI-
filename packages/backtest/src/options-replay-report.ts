/**
 * TRA-376 — report builder for the option-chain replay backtest.
 *
 * Turns the closed-position log + equity curve of an `OptionsReplayAccount`
 * into the metrics the task asks for: trades, win rate, total P&L $/%, max
 * drawdown, classification hit-rate, and a per-starting-equity bucket
 * comparison. Emits both a CSV (machine-readable, one row per bucket) and a
 * markdown summary.
 */

import type { EquitySample, ReplayPosition } from './options-replay-account.js';

export interface ClassificationStat {
  classification: string;
  trades: number;
  winners: number;
  hitRate: number;
  totalPnl: number;
}

export interface BucketResult {
  /** Starting equity for this bucket (e.g. 2000, 5000, 10000). */
  startingEquity: number;
  managedAccountRatio: number;
  trades: number;
  winners: number;
  losers: number;
  winRate: number;
  totalPnl: number;
  pnlPct: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  /** Trades that never fired because sizing collapsed to 0 contracts. */
  skippedZeroSize: number;
  /** Hit-rate broken out by scanner classification. */
  byClassification: ClassificationStat[];
  /** OTM vs RV split. */
  otmTrades: number;
  rvTrades: number;
}

/** Max peak-to-trough drawdown of an equity curve, in dollars and as a fraction of the peak. */
export function maxDrawdown(curve: readonly EquitySample[]): { dollars: number; pct: number } {
  let peak = -Infinity;
  let maxDdDollars = 0;
  let maxDdPct = 0;
  for (const s of curve) {
    if (s.equity > peak) peak = s.equity;
    const dd = peak - s.equity;
    if (dd > maxDdDollars) maxDdDollars = dd;
    if (peak > 0) {
      const ddPct = dd / peak;
      if (ddPct > maxDdPct) maxDdPct = ddPct;
    }
  }
  return { dollars: maxDdDollars, pct: maxDdPct };
}

/**
 * Aggregate a single bucket's closed positions + equity curve into a
 * {@link BucketResult}. `skippedZeroSize` is supplied by the runner because
 * the account only records positions that actually opened.
 */
export function summarizeBucket(args: {
  startingEquity: number;
  managedAccountRatio: number;
  closed: readonly ReplayPosition[];
  equityCurve: readonly EquitySample[];
  skippedZeroSize: number;
}): BucketResult {
  const { closed, equityCurve, startingEquity, managedAccountRatio, skippedZeroSize } = args;

  const trades = closed.length;
  let winners = 0;
  let totalPnl = 0;
  let otmTrades = 0;
  let rvTrades = 0;
  const byClass = new Map<string, { trades: number; winners: number; pnl: number }>();

  for (const p of closed) {
    totalPnl += p.pnl;
    if (p.pnl > 0) winners += 1;
    if (p.signalType === 'otm_mispricing') otmTrades += 1;
    else rvTrades += 1;

    const cls = p.classification;
    const slot = byClass.get(cls) ?? { trades: 0, winners: 0, pnl: 0 };
    slot.trades += 1;
    if (p.pnl > 0) slot.winners += 1;
    slot.pnl += p.pnl;
    byClass.set(cls, slot);
  }

  const losers = trades - winners;
  const winRate = trades > 0 ? winners / trades : 0;
  const dd = maxDrawdown(equityCurve);

  const byClassification: ClassificationStat[] = Array.from(byClass.entries())
    .map(([classification, s]) => ({
      classification,
      trades: s.trades,
      winners: s.winners,
      hitRate: s.trades > 0 ? s.winners / s.trades : 0,
      totalPnl: s.pnl,
    }))
    .sort((a, b) => b.trades - a.trades);

  return {
    startingEquity,
    managedAccountRatio,
    trades,
    winners,
    losers,
    winRate,
    totalPnl,
    pnlPct: startingEquity > 0 ? totalPnl / startingEquity : 0,
    maxDrawdown: dd.dollars,
    maxDrawdownPct: dd.pct,
    skippedZeroSize,
    byClassification,
    otmTrades,
    rvTrades,
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function dollars(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

/** CSV — one row per equity bucket, plus the per-classification breakdown rows. */
export function buildCsv(buckets: readonly BucketResult[]): string {
  const lines: string[] = [];
  lines.push(
    'section,startingEquity,managedAccountRatio,classification,trades,winners,losers,winRate,totalPnl,pnlPct,maxDrawdown,maxDrawdownPct,skippedZeroSize,otmTrades,rvTrades',
  );
  for (const b of buckets) {
    lines.push(
      [
        'bucket',
        b.startingEquity,
        b.managedAccountRatio,
        'ALL',
        b.trades,
        b.winners,
        b.losers,
        b.winRate.toFixed(4),
        b.totalPnl.toFixed(2),
        b.pnlPct.toFixed(4),
        b.maxDrawdown.toFixed(2),
        b.maxDrawdownPct.toFixed(4),
        b.skippedZeroSize,
        b.otmTrades,
        b.rvTrades,
      ].join(','),
    );
    for (const c of b.byClassification) {
      lines.push(
        [
          'classification',
          b.startingEquity,
          b.managedAccountRatio,
          c.classification,
          c.trades,
          c.winners,
          c.trades - c.winners,
          c.hitRate.toFixed(4),
          c.totalPnl.toFixed(2),
          '',
          '',
          '',
          '',
          '',
          '',
        ].join(','),
      );
    }
  }
  return lines.join('\n') + '\n';
}

/** Markdown summary — human-readable bucket comparison + classification hit-rate. */
export function buildMarkdown(args: {
  buckets: readonly BucketResult[];
  daysReplayed: number;
  symbolsCount: number;
  generatedAt: number;
}): string {
  const { buckets, daysReplayed, symbolsCount, generatedAt } = args;
  const md: string[] = [];

  md.push('# Option-chain replay backtest — TRA-376');
  md.push('');
  md.push(
    `Replayed **${daysReplayed} day(s)** of recorded option chains across ` +
      `**${symbolsCount} symbol(s)**. Generated ${new Date(generatedAt).toISOString()}.`,
  );
  md.push('');
  md.push(
    'Entries are sized through the same OTM / RV budget formula as the live ' +
      '`PaperOptionsAccount` (`equity × managedAccountRatio × budgetRatio`, ' +
      'floored to whole contracts, skip-on-zero). Open positions are marked to ' +
      'the next-day chain row for the same `optionSymbol`; contracts close on ' +
      'partial-TP1 / hard-SL / trailing-stop or are force-closed at expiration.',
  );
  md.push('');

  md.push('## Per-starting-equity bucket comparison');
  md.push('');
  md.push(
    '| Starting equity | mgdRatio | Trades | Win rate | Total P&L | P&L % | Max DD | Max DD % | Skipped (0-size) | OTM / RV |',
  );
  md.push('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const b of buckets) {
    md.push(
      `| ${dollars(b.startingEquity)} | ${b.managedAccountRatio.toFixed(2)} | ${b.trades} | ` +
        `${pct(b.winRate)} | ${dollars(b.totalPnl)} | ${pct(b.pnlPct)} | ` +
        `${dollars(b.maxDrawdown)} | ${pct(b.maxDrawdownPct)} | ${b.skippedZeroSize} | ` +
        `${b.otmTrades} / ${b.rvTrades} |`,
    );
  }
  md.push('');

  md.push('## Hit-rate by scanner classification');
  md.push('');
  for (const b of buckets) {
    md.push(`### ${dollars(b.startingEquity)} bucket`);
    md.push('');
    if (b.byClassification.length === 0) {
      md.push('_No trades fired in this bucket — sizing collapsed to 0 contracts on every candidate._');
      md.push('');
      continue;
    }
    md.push('| Classification | Trades | Winners | Hit rate | Total P&L |');
    md.push('|---|---:|---:|---:|---:|');
    for (const c of b.byClassification) {
      md.push(
        `| ${c.classification} | ${c.trades} | ${c.winners} | ${pct(c.hitRate)} | ${dollars(c.totalPnl)} |`,
      );
    }
    md.push('');
  }

  return md.join('\n') + '\n';
}
