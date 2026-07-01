/**
 * TRA-1211 — fee-sensitivity probe (fast strategies only).
 * Contrasts gross (feeBps 0) vs realistic Coinbase taker (60bps) per regime,
 * to show whether a strategy has real gross edge that better execution could
 * capture, or is just unprofitable. QuantTrader research harness; consumes only
 * exported APIs. Skips the slow regime-detector strategies (momentum/breakout).
 *
 *   TRA1211_CACHED_ONLY=1 TRA1211_END=2026-06-03T00:00:00Z \
 *     pnpm --filter @trading-app/backtest exec tsx src/run-tra1211-feeprobe.ts
 */
import { existsSync } from 'node:fs';
import type { Candle } from '@trading-app/shared';
import { BacktestRunner } from './runner.js';
import { loadOrFetch4hBars, cachePathFor4h } from './fetch-tra266-data.js';
import type { BacktestConfig } from './types.js';

const DATA_START_MS = Date.UTC(2023, 4, 1);
const BULL_END_MS = Date.UTC(2025, 9, 6);
const BEAR_START_MS = Date.UTC(2025, 9, 6);
const BEAR_END_MS = process.env['TRA1211_END'] ? Date.parse(process.env['TRA1211_END']!) : Date.now();
const INITIAL_EQUITY = 25_000;

const UNIVERSE = ['BTC-USD','ETH-USD','SOL-USD','XRP-USD','ADA-USD','DOGE-USD','AVAX-USD','LINK-USD','DOT-USD','LTC-USD','BCH-USD','ATOM-USD'];
const STRATS: { name: string; type: BacktestConfig['strategyType']; extra: Partial<BacktestConfig> }[] = [
  { name: 'tsmom_majors', type: 'tsmom_majors', extra: { tsmomOpts: {} } },
  { name: 'mean_reversion', type: 'mean_reversion', extra: { meanReversionOpts: {}, meanReversionRiskPct: 0.01 } },
  { name: 'bb_fade', type: 'bb_fade', extra: { macdBollingerOpts: { enforceTimeFilter: false } } },
];
const REGIMES = [
  { name: 'bull', start: DATA_START_MS, end: BULL_END_MS },
  { name: 'bear', start: BEAR_START_MS, end: BEAR_END_MS },
];
const ARMS = [{ name: 'gross_0', fee: 0 }, { name: 'taker_60', fee: 60 }];

function mean(xs: number[]) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function pf(xs: number[]) { let g = 0, l = 0; for (const r of xs) { if (r > 0) g += r; else l += Math.abs(r); } return l > 0 ? g / l : g > 0 ? Infinity : 0; }

async function main() {
  const runner = new BacktestRunner();
  const cachedOnly = process.env['TRA1211_CACHED_ONLY'] === '1';
  const candlesBySym = new Map<string, Candle[]>();
  for (const s of UNIVERSE) {
    if (cachedOnly && !existsSync(cachePathFor4h(s))) continue;
    candlesBySym.set(s, await loadOrFetch4hBars(s, DATA_START_MS, BEAR_END_MS));
  }
  console.log('strategy        regime  arm         n     exp(R)   PF');
  for (const st of STRATS) {
    for (const reg of REGIMES) {
      for (const arm of ARMS) {
        const rs: number[] = [];
        for (const [sym, candles] of candlesBySym) {
          const res = await runner.run({
            symbol: sym, warmupStartDate: DATA_START_MS, startDate: reg.start, endDate: reg.end,
            initialEquity: INITIAL_EQUITY, strategyType: st.type, feeBps: arm.fee, executionMode: 'market',
            slippageBps: 3, fractionalQuantity: true, ...st.extra,
          } as BacktestConfig, candles);
          rs.push(...res.tradeRsNet);
        }
        console.log(`${st.name.padEnd(15)} ${reg.name.padEnd(6)} ${arm.name.padEnd(10)} ${String(rs.length).padStart(4)}  ${mean(rs).toFixed(3).padStart(7)}  ${pf(rs).toFixed(3)}`);
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
