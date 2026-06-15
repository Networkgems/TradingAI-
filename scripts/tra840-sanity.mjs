#!/usr/bin/env node
// TRA-840 — post-fix sanity check for the SupertrendConfluence generator.
//
// Acceptance: "short-skew no longer ~93%; long/short sense balanced across mixed
// regimes on a sanity window." The TRA-809 root cause showed the OLD generator
// fired 93% SHORT because the 1h confirm was seed-pinned `red` (the seed was
// deterministically red AND the confirm window was too short to escape it), so
// longs were structurally suppressed and shorts rubber-stamped in every regime.
//
// This drives the FIXED generator over an equal mix of clean uptrend and
// downtrend regimes, each fed a confirm window long enough to clear the TRA-840
// 30-bar guard, and tallies emitted sides. A healthy generator emits BUY in
// uptrends and SELL in downtrends — i.e. the side tracks the regime instead of
// collapsing to ~93% short. Pure + deterministic; no network, no capital.
//
//   node scripts/tra840-sanity.mjs

import { SupertrendConfluenceStrategy } from '../packages/engine/dist/index.js';

const FIVE_MIN = 5 * 60_000;

// 5m OHLCV from explicit closes: high/low straddle the running close, open = prior
// close, real 5m timestamps so the strategy's internal 1h confirm fold buckets.
function build5m(closes, spread = 0.5, base = 0) {
  return closes.map((close, i) => ({
    symbol: 'SANITY',
    timestamp: base + i * FIVE_MIN,
    open: i > 0 ? closes[i - 1] : close,
    high: Math.max(close, i > 0 ? closes[i - 1] : close) + spread,
    low: Math.min(close, i > 0 ? closes[i - 1] : close) - spread,
    close,
    volume: 1_000,
  }));
}

// Sawtooth uptrend (pullback-inside-an-uptrend): k up-bars then one down-bar, so
// periodic dips cool RSI into the [50,70] entry band while net drift keeps the
// SMA stack aligned and MACD positive — the exact confluence to BUY.
function sawUp(n, start = 100, u = 0.5, d = 1.0, k = 3) {
  const closes = [];
  let p = start;
  let i = 0;
  while (closes.length < n) {
    const inUp = i % (k + 1) !== k;
    closes.push(p);
    p += inUp ? u : -d;
    i++;
  }
  while (closes.length > 2 && closes[closes.length - 1] <= closes[closes.length - 2]) closes.pop();
  return closes;
}

// Mirror: a sawtooth downtrend (reflect around `start`). Ends on a down-bar so the
// short-side RSI/slope conditions hold.
function sawDown(n, start = 100, u = 0.5, d = 1.0, k = 3) {
  return sawUp(n, start, u, d, k).map((c) => 2 * start - c);
}

// 480 5m bars ≈ 40h ≈ 40 hourly confirm bars — comfortably past the 30-bar guard.
const BARS = 480;
const REGIMES = 20; // 20 up + 20 down = 40 balanced regimes

const strat = new SupertrendConfluenceStrategy();
const tally = { buyInUp: 0, sellInUp: 0, nullInUp: 0, sellInDown: 0, buyInDown: 0, nullInDown: 0 };

for (let g = 0; g < REGIMES; g++) {
  const base = g * BARS * FIVE_MIN; // distinct timestamp windows, deterministic
  // vary the start level a little per regime so the runs aren't identical
  const up = build5m(sawUp(BARS, 80 + g * 2), 0.5, base);
  const down = build5m(sawDown(BARS, 220 - g * 2), 0.5, base);

  const sigUp = strat.evaluate('SANITY', up);
  if (!sigUp) tally.nullInUp++;
  else if (sigUp.side === 'buy') tally.buyInUp++;
  else tally.sellInUp++;

  const sigDown = strat.evaluate('SANITY', down);
  if (!sigDown) tally.nullInDown++;
  else if (sigDown.side === 'sell') tally.sellInDown++;
  else tally.buyInDown++;
}

const buys = tally.buyInUp + tally.buyInDown;
const sells = tally.sellInUp + tally.sellInDown;
const emits = buys + sells;
const shortShare = emits ? sells / emits : NaN;

const lines = [];
lines.push('# TRA-840 — post-fix generator sanity check');
lines.push('');
lines.push(`Regimes: ${REGIMES} uptrend + ${REGIMES} downtrend, ${BARS} 5m bars each (~40 1h confirm bars).`);
lines.push('');
lines.push('## Emitted side vs regime (correct = side tracks the trend)');
lines.push(`- Uptrend regimes:   BUY ${tally.buyInUp} | SELL ${tally.sellInUp} | none ${tally.nullInUp}`);
lines.push(`- Downtrend regimes: SELL ${tally.sellInDown} | BUY ${tally.buyInDown} | none ${tally.nullInDown}`);
lines.push('');
lines.push('## Aggregate balance');
lines.push(`- Total emits: ${emits} (BUY ${buys} / SELL ${sells})`);
lines.push(`- SHORT share: ${emits ? (100 * shortShare).toFixed(1) + '%' : 'n/a'} (pre-fix was ~93%)`);
lines.push('');
const balanced = emits > 0 && shortShare > 0.3 && shortShare < 0.7 && buys > 0 && sells > 0;
const tracksRegime = tally.buyInUp > 0 && tally.sellInDown > 0 && tally.buyInDown === 0 && tally.sellInUp === 0;
lines.push(`**Verdict: ${balanced && tracksRegime ? 'PASS' : 'CHECK'}** — `
  + `${tracksRegime ? 'side tracks the regime (no cross-regime mis-fires)' : 'side does NOT cleanly track the regime'}; `
  + `short share ${balanced ? 'is balanced' : 'is NOT balanced'}.`);

process.stdout.write(lines.join('\n') + '\n');
process.exit(balanced && tracksRegime ? 0 : 1);
