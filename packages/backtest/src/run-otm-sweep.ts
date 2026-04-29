/**
 * OTM long-premium parameter sweep (TRA-160).
 *
 * Goal: choose the SL / TP1 / budget / trailing parameters for far-OTM long
 * tickets. The OTM payoff distribution differs from ATM directional plays —
 * most contracts decay to ~0 while a small fraction multiply, so naive ATM
 * defaults (SL=0.25, TP1=0.25, budget=0.05) are mis-tuned.
 *
 * Approach
 *   1. Generate `TICKETS_PER_REGIME` synthetic OTM premium paths under three
 *      regimes (trending up, choppy, crashy) using geometric Brownian motion
 *      with regime-tuned drift to capture theta + the empirical "most
 *      far-OTM tickets expire worthless".
 *   2. For each `OtmRiskParams` candidate, replay every path through an
 *      account-style exit machinery (hard SL → partial TP1 → trailing → final
 *      mark at expiry).
 *   3. Compare each combo against the ATM-default baseline on the same paths.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest build && \
 *     node packages/backtest/dist/run-otm-sweep.js
 */

import type { OtmRiskParams } from '@trading-app/shared';
import { OTM_RISK_PARAMS } from '@trading-app/shared';

// ── Synthetic OTM premium-path generator ────────────────────────────────────

function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Path {
  /** Per-share marks across the lifetime of the contract. marks[0] is entry. */
  marks: number[];
}

/**
 * Generate a single OTM premium path via plain GBM with regime-tuned drift +
 * vol. We clamp the floor at $0.01 (an OTM contract can asymptote to zero but
 * the mark won't print exactly 0 while bid/ask stays positive).
 */
function generatePath(
  startMark: number,
  steps: number,
  mu: number,
  sigma: number,
  rand: () => number,
): Path {
  const marks: number[] = [startMark];
  for (let i = 1; i <= steps; i++) {
    // Box-Muller for a standard normal draw.
    const u1 = Math.max(rand(), 1e-9);
    const u2 = rand();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const ret = mu + sigma * z;
    const next = Math.max(0.01, marks[i - 1] * Math.exp(ret));
    marks.push(next);
  }
  return { marks };
}

interface Regime {
  name: string;
  /** Per-step drift (log-return mean). Negative = theta-dominant. */
  mu: number;
  /** Per-step vol (log-return stddev). */
  sigma: number;
}

const REGIMES: Regime[] = [
  // Trending up: rare blowout regime — winners run.
  { name: 'Trending up',  mu: +0.012, sigma: 0.075 },
  // Choppy: most ATM/OTM tickets have flat-ish drift but vol still bites.
  { name: 'Choppy',       mu: -0.004, sigma: 0.060 },
  // Crashy / high-theta: typical short-DTE OTM, premium decays toward 0.
  { name: 'Crashy/theta', mu: -0.020, sigma: 0.080 },
];

const TICKETS_PER_REGIME = 1_000;
const STEPS_PER_TICKET = 60;        // ~60 5-minute bars ≈ one trading day
const ENTRY_MARK = 1.00;            // $1 per share, $100 per contract

// ── Exit simulation: replays a Path through the partial/SL/trail schedule ───

interface ExitOutcome {
  /** Realized P&L per contract (in dollars per contract, not premium). */
  pnlPerContract: number;
  hardStop: boolean;
  partialFired: boolean;
  trailingClosed: boolean;
  expiredAtTail: boolean;
}

function simulateExit(path: Path, params: OtmRiskParams): ExitOutcome {
  const entry = path.marks[0];
  const slMark = entry * (1 - params.slPct);
  const tp1Mark = entry * (1 + params.tp1Pct);
  const trailActivate = entry * (1 + params.trailActivatePct);

  let contractsRemaining = 1; // unitised; pnlPerContract reflects multiplier later
  let realised = 0;
  let peak = entry;
  let trailingActive = false;
  let trailStop = trailActivate;
  let tp1Hit = false;
  let hardStop = false;
  let partialFired = false;
  let trailingClosed = false;

  for (let i = 1; i < path.marks.length; i++) {
    const mark = path.marks[i];

    if (mark > peak) peak = mark;

    if (!trailingActive && mark >= trailActivate) {
      trailingActive = true;
      trailStop = peak * (1 - params.trailOffsetPct);
    }
    if (trailingActive) {
      trailStop = peak * (1 - params.trailOffsetPct);
    }

    // Partial exit at TP1 — only if we still have enough size to peel.
    if (!tp1Hit && mark >= tp1Mark && contractsRemaining > params.partialExitRatio) {
      const exitFraction = params.partialExitRatio;
      realised += (mark - entry) * exitFraction;
      contractsRemaining -= exitFraction;
      tp1Hit = true;
      partialFired = true;
      trailingActive = true;
      trailStop = peak * (1 - params.trailOffsetPct);
    }

    // Hard SL or trailing breach
    let exitMark: number | null = null;
    if (mark <= slMark) {
      exitMark = slMark;
      hardStop = true;
    } else if (trailingActive && mark <= trailStop) {
      exitMark = trailStop;
      trailingClosed = true;
    }

    if (exitMark !== null) {
      realised += (exitMark - entry) * contractsRemaining;
      contractsRemaining = 0;
      return {
        pnlPerContract: realised * 100,
        hardStop,
        partialFired,
        trailingClosed,
        expiredAtTail: false,
      };
    }
  }

  const tail = path.marks[path.marks.length - 1];
  realised += (tail - entry) * contractsRemaining;
  return {
    pnlPerContract: realised * 100,
    hardStop,
    partialFired,
    trailingClosed,
    expiredAtTail: true,
  };
}

// ── Aggregation ─────────────────────────────────────────────────────────────

interface ComboResult {
  label: string;
  params: OtmRiskParams;
  totalPnl: number;
  trades: number;
  winners: number;
  losers: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  expectancy: number;
  maxDrawdown: number;
  worstTicket: number;
  bestTicket: number;
  hardStops: number;
  partials: number;
  trailing: number;
  tailExpired: number;
}

function evaluate(label: string, paths: Path[], params: OtmRiskParams): ComboResult {
  // Constant per-ticket budget: sized off mark with the params.budgetRatio.
  // Account model: $50k equity, 50% managed → managed = $25k.
  const ticketBudget = 25_000 * params.budgetRatio;
  const contractsPerTicket = Math.max(0, Math.floor(ticketBudget / (ENTRY_MARK * 100)));

  let totalPnl = 0;
  let winners = 0;
  let losers = 0;
  let cumPnl = 0;
  let peak = 0;
  let maxDd = 0;
  let worst = Infinity;
  let best = -Infinity;
  let hardStops = 0;
  let partials = 0;
  let trailing = 0;
  let tailExpired = 0;
  const wins: number[] = [];
  const losses: number[] = [];

  for (const path of paths) {
    const out = simulateExit(path, params);
    const pnl = out.pnlPerContract * contractsPerTicket;
    totalPnl += pnl;
    cumPnl += pnl;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDd) maxDd = dd;
    if (pnl < worst) worst = pnl;
    if (pnl > best) best = pnl;
    if (pnl > 0) {
      winners += 1;
      wins.push(pnl);
    } else {
      losers += 1;
      losses.push(pnl);
    }
    if (out.hardStop) hardStops += 1;
    if (out.partialFired) partials += 1;
    if (out.trailingClosed) trailing += 1;
    if (out.expiredAtTail) tailExpired += 1;
  }

  const trades = paths.length;
  const winRate = trades > 0 ? winners / trades : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, x) => s + x, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, x) => s + x, 0) / losses.length : 0;
  const expectancy = trades > 0 ? totalPnl / trades : 0;

  return {
    label,
    params,
    totalPnl,
    trades,
    winners,
    losers,
    winRate,
    avgWin,
    avgLoss,
    expectancy,
    maxDrawdown: maxDd,
    worstTicket: worst === Infinity ? 0 : worst,
    bestTicket: best === -Infinity ? 0 : best,
    hardStops,
    partials,
    trailing,
    tailExpired,
  };
}

// ── Sweep ───────────────────────────────────────────────────────────────────

const ATM_BASELINE: OtmRiskParams = {
  budgetRatio: 0.05,
  slPct: 0.25,
  tp1Pct: 0.25,
  trailActivatePct: 0.20,
  trailOffsetPct: 0.12,
  partialExitRatio: 0.5,
  dailyLimit: 4,
};

const SWEEP_GRID: Array<{ label: string; params: OtmRiskParams }> = [
  { label: 'OTM proposed (chosen)',           params: OTM_RISK_PARAMS },
  { label: 'OTM tighter SL (0.18)',           params: { ...OTM_RISK_PARAMS, slPct: 0.18 } },
  { label: 'OTM looser SL (0.25)',            params: { ...OTM_RISK_PARAMS, slPct: 0.25 } },
  { label: 'OTM TP1 0.40',                    params: { ...OTM_RISK_PARAMS, tp1Pct: 0.40 } },
  { label: 'OTM TP1 0.60',                    params: { ...OTM_RISK_PARAMS, tp1Pct: 0.60 } },
  { label: 'OTM budget 0.02',                 params: { ...OTM_RISK_PARAMS, budgetRatio: 0.02 } },
  { label: 'OTM budget 0.03',                 params: { ...OTM_RISK_PARAMS, budgetRatio: 0.03 } },
  { label: 'OTM partial 0.25',                params: { ...OTM_RISK_PARAMS, partialExitRatio: 0.25 } },
  { label: 'OTM partial 0.50',                params: { ...OTM_RISK_PARAMS, partialExitRatio: 0.5 } },
  { label: 'OTM trail-act 0.20',              params: { ...OTM_RISK_PARAMS, trailActivatePct: 0.20 } },
  { label: 'OTM trail-off 0.15',              params: { ...OTM_RISK_PARAMS, trailOffsetPct: 0.15 } },
  { label: 'ATM baseline (current defaults)', params: ATM_BASELINE },
];

function buildPaths(): Path[] {
  const paths: Path[] = [];
  for (const regime of REGIMES) {
    const rand = mulberry32(regime.name.length * 7919 + 31);
    for (let i = 0; i < TICKETS_PER_REGIME; i++) {
      paths.push(generatePath(ENTRY_MARK, STEPS_PER_TICKET, regime.mu, regime.sigma, rand));
    }
  }
  return paths;
}

function fmt(n: number, d = 1): string {
  return n.toFixed(d);
}

function pad(s: string, len: number): string {
  return s.padEnd(len);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function main(): void {
  const paths = buildPaths();
  const totalPaths = paths.length;
  console.log('\n' + '═'.repeat(110));
  console.log(`  OTM RISK PARAMETER SWEEP (TRA-160)  —  ${totalPaths.toLocaleString()} synthetic premium paths across 3 regimes`);
  console.log('  Account model: $50k equity, 50% managed → $25k managed equity. Entry mark = $1.00 per share.');
  console.log('═'.repeat(110));
  console.log(
    pad('  Variant', 36) +
    pad('Trades',  8) +
    pad('WinRate', 10) +
    pad('Total P&L', 14) +
    pad('Expect/trade', 14) +
    pad('Avg Win', 11) +
    pad('Avg Loss', 11) +
    pad('Max DD', 11) +
    'HardSL%',
  );
  console.log('  ' + '·'.repeat(108));

  const results: ComboResult[] = [];
  for (const combo of SWEEP_GRID) {
    const r = evaluate(combo.label, paths, combo.params);
    results.push(r);
    const hardSlPct = r.trades > 0 ? r.hardStops / r.trades : 0;
    console.log(
      `  ${pad(combo.label, 34)}` +
      pad(String(r.trades), 8) +
      pad(pct(r.winRate), 10) +
      pad(`$${fmt(r.totalPnl)}`, 14) +
      pad(`$${fmt(r.expectancy)}`, 14) +
      pad(`$${fmt(r.avgWin)}`, 11) +
      pad(`$${fmt(r.avgLoss)}`, 11) +
      pad(`$${fmt(r.maxDrawdown)}`, 11) +
      pct(hardSlPct),
    );
  }

  const baseline = results.find((r) => r.label.startsWith('ATM baseline'))!;
  console.log('\n' + '─'.repeat(110));
  console.log('  DELTA VS ATM BASELINE  (positive ΔP&L / lower ΔMaxDD = OTM combo improves over ATM defaults)');
  console.log('─'.repeat(110));
  for (const r of results) {
    if (r === baseline) continue;
    const dPnl = r.totalPnl - baseline.totalPnl;
    const dExpect = r.expectancy - baseline.expectancy;
    const dDd = r.maxDrawdown - baseline.maxDrawdown;
    const dWinRate = r.winRate - baseline.winRate;
    console.log(
      `  ${pad(r.label, 34)}` +
      `ΔP&L ${dPnl >= 0 ? '+' : ''}$${fmt(dPnl)}   ` +
      `ΔE/trade ${dExpect >= 0 ? '+' : ''}$${fmt(dExpect)}   ` +
      `ΔWinRate ${dWinRate >= 0 ? '+' : ''}${fmt(dWinRate * 100)}%   ` +
      `ΔMaxDD ${dDd >= 0 ? '+' : ''}$${fmt(dDd)}`,
    );
  }
  console.log('');
}

main();
