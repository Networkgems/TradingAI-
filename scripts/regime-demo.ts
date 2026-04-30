#!/usr/bin/env tsx
/**
 * Demo: feed a year of synthetic BTC candles through the RegimeDetector and
 * print the regime distribution. Useful as a smoke test that the detector
 * produces a sensible spread of labels on a realistic-looking series rather
 * than parking in `flat`.
 *
 * Usage:
 *   pnpm --filter @trading-app/engine build
 *   node --experimental-strip-types scripts/regime-demo.ts            # 365 bars, seed=1
 *   node --experimental-strip-types scripts/regime-demo.ts 365 7      # custom bars/seed
 */
import type { Candle } from '../packages/shared/dist/index.js';
import { RegimeDetector, type Regime } from '../packages/engine/dist/index.js';

function seededRandom(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

/**
 * Generate a year of synthetic BTC daily candles by stitching together a
 * sequence of regime "scenes":
 *   - quiet sideways drift (range/flat)
 *   - sustained uptrend
 *   - sustained downtrend
 *   - volatility expansion (alternating large bars)
 *
 * The series is deterministic for a given seed so detector behaviour is
 * reproducible bar-for-bar across runs.
 */
function syntheticBtcYear(bars: number, seed: number): Candle[] {
  const rng = seededRandom(seed);
  const out: Candle[] = [];
  let price = 30_000;
  let prev = price;

  // Longer scenes give ADX time to decay between regime transitions, so we
  // actually observe `range` and `high_vol` instead of staying stuck on the
  // previous trend's residual ADX.
  type Scene = { kind: 'range' | 'trend_up' | 'trend_down' | 'vol'; len: number };
  const scenes: Scene[] = [
    { kind: 'range', len: 60 },
    { kind: 'trend_up', len: 60 },
    { kind: 'range', len: 50 },
    { kind: 'trend_down', len: 60 },
    { kind: 'range', len: 40 },
    { kind: 'vol', len: 25 },
    { kind: 'range', len: 40 },
    { kind: 'trend_up', len: 40 },
  ];
  const sceneTotal = scenes.reduce((a, s) => a + s.len, 0);
  for (const s of scenes) s.len = Math.max(20, Math.round((s.len / sceneTotal) * bars));

  let scene = 0;
  let inScene = 0;
  let rangeMid = price;

  for (let i = 0; i < bars; i++) {
    if (inScene >= scenes[scene].len && scene < scenes.length - 1) {
      scene += 1;
      inScene = 0;
      rangeMid = price;
    }
    const kind = scenes[scene].kind;
    const noise = (rng() - 0.5) * 0.01;

    let drift = 0;
    let range = price * 0.012;
    if (kind === 'trend_up') {
      drift = 0.01;
    } else if (kind === 'trend_down') {
      drift = -0.01;
    } else if (kind === 'vol') {
      drift = (i % 2 === 0 ? 1 : -1) * 0.05;
      range = price * 0.05;
    } else {
      // Mean-reverting drift toward `rangeMid` keeps ADX low while still
      // exposing meaningful per-bar volatility (≈1% ATR/close → above floor).
      drift = (rangeMid - price) / price * 0.5;
      range = price * 0.012;
    }

    const next = price * (1 + drift + noise);
    const high = Math.max(next, prev) + range / 2;
    const low = Math.min(next, prev) - range / 2;
    out.push({
      symbol: 'BTC-USD',
      timestamp: i * 86_400_000,
      open: prev,
      high,
      low,
      close: next,
      volume: 1_000,
    });
    prev = next;
    price = next;
    inScene += 1;
  }

  return out;
}

function main(): void {
  const bars = Number(process.argv[2] ?? 365);
  const seed = Number(process.argv[3] ?? 1);
  const candles = syntheticBtcYear(bars, seed);

  const detector = new RegimeDetector();
  const counts: Record<Regime, number> = {
    trend_up: 0,
    trend_down: 0,
    range: 0,
    high_vol: 0,
    flat: 0,
  };

  // Need enough warm-up for ADX (period * 2 = 28) and ATR median window (90).
  // Below that the detector returns flat regardless, so we still count those
  // bars — that's a real, observable regime decision.
  const minBars = 30;
  for (let i = minBars; i <= candles.length; i++) {
    const label = detector.update(candles.slice(0, i));
    counts[label] += 1;
  }

  const total = bars - minBars + 1;
  console.log(`Regime distribution over ${total} bars (seed=${seed}):`);
  const labels: Regime[] = ['trend_up', 'trend_down', 'range', 'high_vol', 'flat'];
  for (const label of labels) {
    const n = counts[label];
    const pct = total === 0 ? 0 : (n / total) * 100;
    console.log(`  ${label.padEnd(11)} ${String(n).padStart(4)}  ${pct.toFixed(1)}%`);
  }
  console.log(`Final regime: ${detector.current()}`);
}

main();
