// TRA-1322 — reproducible Phase-1 report for the guarded covered-call recovery
// branch. Deterministic: runs the ported state machine over the committed OHLC
// fixture (`fixtures/tra1146-wheel-ohlc.json`, the same Yahoo window as the
// TRA-1146 reference) — no network, no live wiring.
//
// It prints, per VRP factor, the BARE wheel (guards off; matches the reference)
// vs the GUARDED wheel (board-required guards on) for both the full 25-name
// universe and the TRA-592 quality sub-universe, so the tail-capping effect of
// the guards is directly legible against the reference numbers.
//
//   pnpm --filter @trading-app/backtest exec tsx src/run-tra1322-wheel-recovery.ts
//
// Guard parameters are the Phase-1 defaults proposed to QuantTrader for sign-off:
//   • stockStopPct = 0.15  (hard stock-side stop 15% below cost basis)
//   • maxCcCycles  = 3     (≤ 3 covered-call cycles, then liquidate)
// These are the paper/backtest screen values; the live promotion values are set
// only after the G1–G4 real-chain gate (TRA-1143), which is out of scope here.

import { createRequire } from 'module';
import {
  runWheel, metrics, restrictUniverse,
  WHEEL_QUALITY_UNIVERSE, type PriceSeries, type WheelGuards,
} from './wheel-recovery.js';

const require = createRequire(import.meta.url);
const OHLC = require('../fixtures/tra1146-wheel-ohlc.json') as Record<string, PriceSeries>;

const GUARDS: WheelGuards = { stockStopPct: 0.15, maxCcCycles: 3 };
const FACTORS = [1.0, 1.1, 1.2];

function row(data: Record<string, PriceSeries>, ivFactor: number, guards?: WheelGuards) {
  const r = runWheel(data, { ivFactor, guards });
  const m = metrics(r.cycles);
  return {
    n: m.n,
    winRate: m.winRate,
    annRetColl: m.annRetColl,
    sharpe: m.sharpe,
    maxDD: m.maxDD,
    worst: m.worst,
    assigned: r.assignedCount,
    stopped: r.stoppedCount,
    windowLiquidated: r.windowLiquidatedCount,
  };
}

function report(label: string, data: Record<string, PriceSeries>) {
  console.log(`\n=== ${label} (${Object.keys(data).length} names) ===`);
  for (const f of FACTORS) {
    const bare = row(data, f);
    const guarded = row(data, f, GUARDS);
    const pct = (x?: number) => (x == null ? 'n/a' : (x * 100).toFixed(1) + '%');
    console.log(`VRP ${f.toFixed(2)}`);
    console.log(
      `  bare    n=${bare.n} sharpe=${bare.sharpe?.toFixed(2)} maxDD=${pct(bare.maxDD)} ` +
      `annRet=${pct(bare.annRetColl)} worst=${pct(bare.worst)} assigned=${bare.assigned}`,
    );
    console.log(
      `  guarded n=${guarded.n} sharpe=${guarded.sharpe?.toFixed(2)} maxDD=${pct(guarded.maxDD)} ` +
      `annRet=${pct(guarded.annRetColl)} worst=${pct(guarded.worst)} ` +
      `assigned=${guarded.assigned} stopped=${guarded.stopped} windowLiq=${guarded.windowLiquidated}`,
    );
  }
}

report('FULL 25-name universe', OHLC);
report('TRA-592 quality sub-universe', restrictUniverse(OHLC, WHEEL_QUALITY_UNIVERSE));
