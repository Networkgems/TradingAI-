/**
 * TRA-171 — Fixed-pct vs ATR-based stop comparison.
 *
 * Runs each strategy twice (once with the ATR-adaptive stop/target enabled,
 * once forced onto the legacy fixed-pct or structural path) over a synthetic
 * equity scenario and a synthetic 24/7 scenario, and prints which variant
 * wins per asset class.
 *
 *   Equity scenario: ranging+trending mixed 1-min SPY candles.
 *   24/7 scenario: 90-day rolling 1h synthetic `*-USD` tape with 4 regime segments.
 *
 * Run with:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-atr-comparison.ts
 *
 * The "fixed-pct" config disables both the ATR stop multiplier and the
 * dead-tape volatility gate so the result reflects the legacy behaviour;
 * the "ATR" config uses the new defaults shipped with TRA-171.
 */

import { BacktestRunner } from './runner.js';
import { mixedRegimeCandles, syntheticCryptoSeries } from './synthetic.js';
import type {
  BacktestConfig,
  BacktestMacdBollingerOpts,
  BacktestResult,
  BacktestReversalOpts,
} from './types.js';
import type { ScalpingOptions, SwingOptions } from '@trading-app/engine';

const INITIAL_EQUITY = 25_000;

interface Variant {
  name: 'fixed-pct' | 'ATR';
  scalping: ScalpingOptions;
  swing: SwingOptions;
  reversal: BacktestReversalOpts;
  macd: BacktestMacdBollingerOpts;
}

const VARIANTS: Variant[] = [
  {
    name: 'fixed-pct',
    // Force every strategy onto the fixed-pct / structural-stop path and
    // disable the dead-tape filter so the legacy behaviour is preserved.
    scalping: { atrStopMultiplier: 0, volatilityFloorPct: 0 },
    swing: { atrStopMultiplier: 0, volatilityFloorPct: 0 },
    reversal: { atrStopMultiplier: 0, volatilityFloorPct: 0 },
    macd: { atrStopMultiplier: 0, volatilityFloorPct: 0 },
  },
  {
    name: 'ATR',
    // TRA-171 defaults: scalping 1.5×ATR, swing 2×ATR; reversal/macd-trend
    // opt into 2×ATR stops (defaults leave them on structural stops).
    scalping: {},
    swing: {},
    reversal: { atrStopMultiplier: 2 },
    macd: { atrStopMultiplier: 2 },
  },
];

const STRATEGIES: Array<BacktestConfig['strategyType']> = [
  'reversal',
  'macd_trend',
  'scalping',
  'swing',
];

interface AssetClass {
  label: string;
  symbol: string;
  candles: ReturnType<typeof mixedRegimeCandles>;
}

const ASSETS: AssetClass[] = [
  {
    label: 'Equity (SPY synthetic, 1-min)',
    symbol: 'SPY',
    candles: mixedRegimeCandles(800, 'SPY', 450, 13),
  },
  {
    label: '24/7 (SYN-USD synthetic, 1h)',
    symbol: 'SYN-USD',
    candles: syntheticCryptoSeries(90, 'SYN-USD', 30_000, 60, 31),
  },
];

const runner = new BacktestRunner();

function fmt(n: number, d = 2): string {
  return Number.isFinite(n) ? n.toFixed(d) : '—';
}
function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}
function pad(s: string, n: number): string {
  return s.padEnd(n);
}

async function runOne(asset: AssetClass, variant: Variant, strategy: BacktestConfig['strategyType']): Promise<BacktestResult> {
  const start = asset.candles[0].timestamp;
  const end = asset.candles[asset.candles.length - 1].timestamp;
  const is247 = /-USD$/i.test(asset.symbol);
  return runner.run(
    {
      symbol: asset.symbol,
      startDate: start,
      endDate: end,
      initialEquity: INITIAL_EQUITY,
      strategyType: strategy,
      reversalOpts: { ...variant.reversal, enforceTimeFilter: !is247 },
      macdBollingerOpts: { ...variant.macd, enforceTimeFilter: !is247 },
      scalpingOpts: { ...variant.scalping, enforceTimeFilter: false },
      swingOpts: variant.swing,
    },
    asset.candles,
  );
}

function score(r: BacktestResult): number {
  if (r.totalTrades === 0) return 0;
  const pf = Number.isFinite(r.profitFactor) ? r.profitFactor : 0;
  return r.totalPnl + pf * 100; // PnL dominates; PF acts as a tiebreaker.
}

async function main() {
  console.log('\n' + '═'.repeat(108));
  console.log('  TRA-171 — Fixed-pct vs ATR stop/target backtest comparison');
  console.log(`  Initial equity: $${INITIAL_EQUITY.toLocaleString()}`);
  console.log('═'.repeat(108));

  for (const asset of ASSETS) {
    console.log('\n' + '─'.repeat(108));
    console.log(`  Asset class: ${asset.label}  |  bars: ${asset.candles.length}`);
    console.log('─'.repeat(108));
    console.log(
      pad('  Strategy', 14) +
      pad('Variant', 12) +
      pad('Trades', 8) +
      pad('Win %', 8) +
      pad('PF', 8) +
      pad('Avg R:R', 9) +
      pad('Total P&L', 12) +
      pad('MaxDD', 8) +
      'Verdict',
    );
    console.log('  ' + '·'.repeat(105));

    for (const strategy of STRATEGIES) {
      const results: { variant: Variant; result: BacktestResult }[] = [];
      for (const variant of VARIANTS) {
        const result = await runOne(asset, variant, strategy);
        results.push({ variant, result });
      }
      const [fixed, atr] = results;
      // Don't pick a "winner" when neither variant fired — claiming ATR wins
      // on a 0-vs-0 row is misleading and obscures the real signal.
      const bothZero = fixed.result.totalTrades === 0 && atr.result.totalTrades === 0;
      const winner: 'ATR' | 'fixed-pct' | null = bothZero
        ? null
        : score(atr.result) >= score(fixed.result) ? 'ATR' : 'fixed-pct';

      for (const { variant, result } of results) {
        const star = variant.name === winner ? '★' : ' ';
        const noTrades = result.totalTrades === 0;
        const verdict = winner === null
          ? (variant.name === 'fixed-pct' ? 'no fires (smoke test only)' : '')
          : variant.name === winner ? `wins on ${asset.symbol}` : '';
        console.log(
          `  ${star} ${pad(strategy.toUpperCase(), 11)} ` +
          pad(variant.name, 12) +
          pad(String(result.totalTrades), 8) +
          pad(noTrades ? '—' : pct(result.winRate), 8) +
          pad(noTrades ? '—' : (Number.isFinite(result.profitFactor) ? fmt(result.profitFactor) : '∞'), 8) +
          pad(noTrades ? '—' : fmt(result.avgRiskReward), 9) +
          pad(noTrades ? '—' : `$${fmt(result.totalPnl)}`, 12) +
          pad(noTrades ? '—' : pct(result.maxDrawdown), 8) +
          verdict,
        );
      }
    }
  }

  console.log('\n' + '─'.repeat(108));
  console.log('  Notes:');
  console.log('  • The synthetic series use seeded PRNGs so rerunning produces identical numbers.');
  console.log('  • Real-data verdicts will differ; treat this as a smoke test for the wiring.');
  console.log('  • "fixed-pct" disables both the ATR stop multiplier and the dead-tape gate.');
  console.log('  • Per-trade sizing now compounds with running equity (RiskManager change).');
  console.log('─'.repeat(108) + '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
