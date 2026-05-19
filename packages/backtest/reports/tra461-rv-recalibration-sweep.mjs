/**
 * TRA-461 — RV scanner selection + risk recalibration sweep.
 *
 * Goal: quantify the penny-option failure mode the board flagged on TRA-450 and
 * pick a `minMark` floor, a `maxSpreadPct` cap, and an SL schedule (with a
 * dollar-based stop floor) under which the live RV book stops bleeding to
 * microstructure.
 *
 * Model — what makes this different from the OTM sweep:
 *   1. The OBSERVED mark is tick-quantized to $0.01. A continuous "fair" premium
 *      walks under GBM; the broker only ever prints whole-cent marks. This is
 *      the mechanism behind the -28%/-50%/-80% closes in the TRA-461 table:
 *      one $0.01 print is a huge % move on a $0.05 contract.
 *   2. Round-trip spread is paid explicitly — enter at the ask, exit at the bid.
 *   3. The RV edge is modelled as a convergence drift: a `cheap` entry is priced
 *      below fair and the fair premium drifts toward fair with probability
 *      `pConverge`. The edge in DOLLARS is what the strategy keeps — and at low
 *      premium it is smaller than the spread + a one-tick stop.
 *
 * Run:  node .tra461-sweep/rv-recalibration-sweep.mjs
 */

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rand) {
  const u1 = Math.max(rand(), 1e-9);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const TICK = 0.01;
const quantize = (x) => Math.max(TICK, Math.round(x / TICK) * TICK);

const REGIMES = [
  { name: 'Trending up', mu: +0.010, sigma: 0.070, weight: 0.30 },
  { name: 'Choppy',      mu: -0.004, sigma: 0.055, weight: 0.45 },
  { name: 'Crashy',      mu: -0.018, sigma: 0.080, weight: 0.25 },
];
const STEPS = 60;
const PATHS_PER_REGIME = 4000;

function buildPath(entryMark, spreadPct, regime, rand, edgePct, pConverge) {
  const fairTarget = entryMark * (1 + edgePct);
  const converges = rand() < pConverge;
  const convDrift = converges ? Math.log(fairTarget / entryMark) / STEPS : 0;

  const fair = [entryMark];
  for (let i = 1; i <= STEPS; i++) {
    const ret = regime.mu + convDrift + regime.sigma * gauss(rand);
    fair.push(Math.max(0.002, fair[i - 1] * Math.exp(ret)));
  }
  const marks = fair.map(quantize);
  const halfSpread = Math.max(TICK, quantize((spreadPct * entryMark) / 2));
  return { marks, halfSpread };
}

function simulate(path, p) {
  const entryMid = path.marks[0];
  const entryFill = quantize(entryMid + path.halfSpread);
  const stopDist = Math.max(entryMid * p.slPct, p.slDollarFloor);
  const slMid = entryMid - stopDist;
  const tp1Mid = entryMid * (1 + p.tp1Pct);
  const trailActMid = entryMid * (1 + p.trailActivatePct);

  let remaining = 1;
  let realised = 0;
  let peak = entryMid;
  let trailing = false;
  let tp1Hit = false;
  let exitKind = 'expiry';
  const sellFill = (mid) => quantize(Math.max(TICK, mid - path.halfSpread));

  for (let i = 1; i < path.marks.length; i++) {
    const mid = path.marks[i];
    if (mid > peak) peak = mid;
    if (!trailing && mid >= trailActMid) trailing = true;
    const trailStop = trailing ? peak * (1 - p.trailOffsetPct) : -Infinity;

    if (!tp1Hit && mid >= tp1Mid && remaining > p.partialExitRatio) {
      realised += (sellFill(mid) - entryFill) * p.partialExitRatio;
      remaining -= p.partialExitRatio;
      tp1Hit = true;
      trailing = true;
    }
    let exitMid = null;
    if (mid <= slMid) { exitMid = slMid; exitKind = 'stop'; }
    else if (trailing && mid <= trailStop) { exitMid = trailStop; exitKind = 'trail'; }
    if (exitMid !== null) {
      realised += (sellFill(exitMid) - entryFill) * remaining;
      remaining = 0;
      return { pnl: realised * 100, exitKind, entryFill };
    }
  }
  realised += (sellFill(path.marks[path.marks.length - 1]) - entryFill) * remaining;
  return { pnl: realised * 100, exitKind, entryFill };
}

function evaluate(entryMark, spreadPct, params, edgePct, pConverge) {
  let trades = 0, wins = 0, total = 0, stops = 0, worst = Infinity, best = -Infinity;
  const winsArr = [], lossArr = [];
  for (const regime of REGIMES) {
    const n = Math.round(PATHS_PER_REGIME * regime.weight * 3);
    const rand = mulberry32(
      Math.round(entryMark * 1000) * 31 + regime.name.length * 7919 + Math.round(spreadPct * 100),
    );
    for (let k = 0; k < n; k++) {
      const path = buildPath(entryMark, spreadPct, regime, rand, edgePct, pConverge);
      const out = simulate(path, params);
      trades++;
      total += out.pnl;
      if (out.pnl > 0) { wins++; winsArr.push(out.pnl); } else lossArr.push(out.pnl);
      if (out.exitKind === 'stop') stops++;
      if (out.pnl < worst) worst = out.pnl;
      if (out.pnl > best) best = out.pnl;
    }
  }
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  return {
    entryMark, spreadPct, trades,
    winRate: wins / trades,
    expectancy: total / trades,
    totalPnl: total,
    avgWin: avg(winsArr),
    avgLoss: avg(lossArr),
    stopRate: stops / trades,
    worst, best,
  };
}

const RV_CURRENT = {
  slPct: 0.25, slDollarFloor: 0, tp1Pct: 0.40,
  trailActivatePct: 0.25, trailOffsetPct: 0.15, partialExitRatio: 0.5,
};
const RV_PROPOSED = {
  slPct: 0.30, slDollarFloor: 0.10, tp1Pct: 0.40,
  trailActivatePct: 0.25, trailOffsetPct: 0.15, partialExitRatio: 0.5,
};

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const dol = (x) => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(1)}`;
const pad = (s, n) => String(s).padEnd(n);

const EDGE_PCT = 0.30;
const P_CONVERGE = 0.55;

const BUCKETS = [
  { mark: 0.05, spreadPct: 0.20 },
  { mark: 0.07, spreadPct: 0.16 },
  { mark: 0.10, spreadPct: 0.12 },
  { mark: 0.20, spreadPct: 0.10 },
  { mark: 0.30, spreadPct: 0.10 },
  { mark: 0.40, spreadPct: 0.09 },
  { mark: 0.50, spreadPct: 0.08 },
  { mark: 0.80, spreadPct: 0.07 },
];

console.log('\n' + '='.repeat(96));
console.log('  TRA-461  RV RECALIBRATION SWEEP  —  tick-quantized penny-option model');
console.log(`  ${REGIMES.map((r) => `${r.name} ${pct(r.weight)}`).join('  |  ')}   edge ${pct(EDGE_PCT)} @ ${pct(P_CONVERGE)} converge`);
console.log('='.repeat(96));

for (const [label, params] of [
  ['CURRENT  (slPct .25, no $ floor)', RV_CURRENT],
  ['PROPOSED (slPct .30, $0.10 floor)', RV_PROPOSED],
]) {
  console.log(`\n  ${label}`);
  console.log('  ' + pad('EntryMark', 11) + pad('Spread%', 9) + pad('Trades', 8) +
    pad('WinRate', 10) + pad('Expect/tkt', 12) + pad('AvgWin', 10) + pad('AvgLoss', 10) + pad('Stop%', 9) + 'Worst');
  console.log('  ' + '-'.repeat(90));
  for (const b of BUCKETS) {
    const r = evaluate(b.mark, b.spreadPct, params, EDGE_PCT, P_CONVERGE);
    console.log('  ' + pad(`$${b.mark.toFixed(2)}`, 11) + pad(pct(b.spreadPct), 9) +
      pad(r.trades, 8) + pad(pct(r.winRate), 10) + pad(dol(r.expectancy), 12) +
      pad(dol(r.avgWin), 10) + pad(dol(r.avgLoss), 10) + pad(pct(r.stopRate), 9) + dol(r.worst));
  }
}

console.log('\n' + '='.repeat(96));
console.log('  SELECTION FLOOR — mean expectancy/ticket across admitted buckets (PROPOSED risk schedule)');
console.log('='.repeat(96));
console.log('  ' + pad('minMark', 11) + pad('maxSpread%', 13) + pad('Buckets kept', 18) + pad('Mean Expect/tkt', 18) + 'Mean WinRate');
console.log('  ' + '-'.repeat(82));
for (const floor of [
  { minMark: 0.05, maxSpread: 0.20 },
  { minMark: 0.10, maxSpread: 0.15 },
  { minMark: 0.20, maxSpread: 0.12 },
  { minMark: 0.30, maxSpread: 0.10 },
  { minMark: 0.40, maxSpread: 0.10 },
  { minMark: 0.50, maxSpread: 0.10 },
]) {
  const kept = BUCKETS.filter((b) => b.mark >= floor.minMark && b.spreadPct <= floor.maxSpread);
  if (kept.length === 0) { console.log('  ' + pad(`$${floor.minMark.toFixed(2)}`, 11) + '(no buckets admitted)'); continue; }
  let eSum = 0, wSum = 0;
  for (const b of kept) {
    const r = evaluate(b.mark, b.spreadPct, RV_PROPOSED, EDGE_PCT, P_CONVERGE);
    eSum += r.expectancy; wSum += r.winRate;
  }
  console.log('  ' + pad(`$${floor.minMark.toFixed(2)}`, 11) + pad(pct(floor.maxSpread), 13) +
    pad(`${kept.length} ($${kept[0].mark.toFixed(2)}+)`, 18) +
    pad(dol(eSum / kept.length), 18) + pct(wSum / kept.length));
}
console.log('');
