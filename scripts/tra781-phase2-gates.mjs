#!/usr/bin/env node
/**
 * TRA-781 — Phase-2 real-chain GO/NO-GO gate driver (QuantTrader).
 *
 * Reads the REAL recorded chains mirrored locally by pull-recorded-chains.mjs
 * (TRA-779 capture, 2026-05-15..2026-06-29). Runs the canonical TRA-800 replay
 * engine (`replayBucket`) and applies the TRA-781 promotion gates:
 *   G1 — per-structure real-chain expectancy / win-rate / Sharpe / maxDD.
 *   G2 — bootstrap 95% CI on per-trade expectancy; lower bound > 0 to pass
 *        (the anti-artifact gate whose absence produced TRA-431). < 30 trades
 *        => UNDERPOWERED / NO-VERDICT (TRA-550 sparsity floor).
 *   G3 — re-price defined-risk combo ENTRY fills at bid/ask + slippage +
 *        commission (held-to-expiry settlement unchanged); re-bootstrap.
 *
 * No package source is modified: we wrap the exported
 * `OptionsReplayAccount.prototype.getClosedPositions` to capture the exact
 * closed-trade array the canonical summarizer consumes — so the per-trade
 * vector is guaranteed identical to the canonical run-options-replay output.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  loadChainDays,
  replayBucket,
  runOptionsReplay,
  OptionsReplayAccount,
  DEFAULT_REPLAY_CONFIG,
} from '../packages/backtest/dist/index.js';

const DATA_DIR = process.env.DATA_DIR ?? './data/option-chains';
const EQUITIES = (process.env.EQ ? process.env.EQ.split(',').map(Number) : [2000, 5000, 10000]);
const RESAMPLES = 5000;
const PER_LEG_SLIPPAGE = Number(process.env.SLIP ?? 0.02); // $/share beyond the touch
const COMMISSION = Number(process.env.COMM ?? 0.65); // $/contract/leg
const CONTRACT = 100;

// ── deterministic PRNG (Mulberry32) — reproducible bootstrap, no Math.random ──
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function std(xs) {
  const n = xs.length; if (n < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
}
function quantile(sorted, q) {
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Bootstrap the mean (per-trade expectancy). Returns point + 95% percentile CI.
function bootstrapMeanCI(pnls, seed = 12345) {
  const n = pnls.length;
  const rng = mulberry32(seed);
  const means = new Array(RESAMPLES);
  for (let r = 0; r < RESAMPLES; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += pnls[(rng() * n) | 0];
    means[r] = s / n;
  }
  means.sort((a, b) => a - b);
  return {
    n,
    point: mean(pnls),
    lo95: quantile(means, 0.025),
    hi95: quantile(means, 0.975),
    perTradeStd: std(pnls),
  };
}

// ── capture closed trades from the canonical replayBucket, per equity bucket ──
let CAPTURE = [];
const origGetClosed = OptionsReplayAccount.prototype.getClosedPositions;
OptionsReplayAccount.prototype.getClosedPositions = function () {
  const closed = origGetClosed.call(this);
  CAPTURE = closed; // replayBucket calls this exactly once, at summarize time
  return closed;
};

// ── G3: re-price a combo's ENTRY at realistic bid/ask + slippage + commission ─
// Returns the extra entry COST (USD, positive) vs the mid-fill the engine used,
// scaled by contracts. Settlement (held to expiry) is intrinsic — no exit fill.
function entrySlippageCost(pos, entryRowsBySymbol) {
  if (!pos.isCombo || !Array.isArray(pos.legs)) return 0;
  const rows = entryRowsBySymbol.get(`${pos.openedAtDay}|${pos.symbol.toUpperCase()}`);
  if (!rows) return null; // cannot locate entry chain — flag for exclusion
  let extraPerShare = 0;
  for (const leg of pos.legs) {
    const row = rows.find(
      (r) =>
        Math.abs(r.strike - leg.strike) < 1e-6 &&
        String(r.optionType).toLowerCase() === String(leg.optionType).toLowerCase() &&
        (!leg.expiration || r.expiration === leg.expiration),
    );
    if (!row || typeof row.bid !== 'number' || typeof row.ask !== 'number' || row.ask <= 0) {
      return null; // missing quote -> exclude trade from G3 rather than guess
    }
    const half = Math.max(0, (row.ask - row.bid) / 2);
    // sell -> you receive bid (lose half-spread); buy -> you pay ask (lose half-spread)
    extraPerShare += half + PER_LEG_SLIPPAGE;
  }
  const commission = COMMISSION * pos.legs.length; // per contract
  return (extraPerShare * CONTRACT + commission) * pos.contracts;
}

async function buildEntryRowIndex(dataDir) {
  // Map "<date>|<SYMBOL>" -> rows[], for entry re-pricing.
  const index = new Map();
  const dates = (await readdir(dataDir)).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e));
  for (const date of dates) {
    const dir = join(dataDir, date);
    let files;
    try { files = await readdir(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json') || f === '_meta.json') continue;
      try {
        const snap = JSON.parse(await readFile(join(dir, f), 'utf-8'));
        if (snap && Array.isArray(snap.rows) && typeof snap.symbol === 'string') {
          index.set(`${date}|${snap.symbol.toUpperCase()}`, snap.rows);
        }
      } catch { /* skip */ }
    }
  }
  return index;
}

const fmt = (x, d = 2) => (x == null || Number.isNaN(x) ? 'n/a' : x.toFixed(d));

async function main() {
  const days = await loadChainDays(DATA_DIR);
  if (!days.length) { console.error(`no chains under ${DATA_DIR}`); process.exit(2); }
  console.log(`[TRA-781] loaded ${days.length} day(s) ${days[0].date}..${days[days.length - 1].date}`);
  const entryIndex = await buildEntryRowIndex(DATA_DIR);

  const cfg = { ...DEFAULT_REPLAY_CONFIG, equityBuckets: EQUITIES };
  const canonical = runOptionsReplay(days, cfg); // for cross-check
  const STRUCTURES = ['put_write', 'call_debit_spread'];
  const out = { generatedAt: new Date(days[days.length - 1].date).toISOString(), buckets: [] };

  for (let bi = 0; bi < EQUITIES.length; bi++) {
    const eq = EQUITIES[bi];
    CAPTURE = [];
    replayBucket(days, eq, cfg);
    const closed = CAPTURE.slice();

    // fidelity cross-check: my captured aggregates must equal canonical byStructure
    const canon = canonical[bi];
    const checkRows = [];
    const byStruct = {};
    for (const s of STRUCTURES) {
      const tr = closed.filter((p) => p.signalType === s);
      const pnls = tr.map((p) => p.pnl);
      const canonStat = (canon.byStructure || []).find((x) => x.structure === s);
      const totalPnl = pnls.reduce((a, b) => a + b, 0);
      checkRows.push({
        s, n: pnls.length, canonN: canonStat?.trades ?? 0,
        totalPnl, canonTotal: canonStat?.totalPnl ?? 0,
      });

      // G2 — bootstrap on raw mid-fill per-trade pnl
      const g2 = pnls.length >= 2 ? bootstrapMeanCI(pnls, 1000 + bi * 7 + s.length) : null;

      // G3 — slippage-stressed per-trade pnl (entry re-priced at bid/ask)
      let g3pnls = [];
      let excluded = 0;
      for (const p of tr) {
        const cost = entrySlippageCost(p, entryIndex);
        if (cost == null) { excluded += 1; continue; }
        g3pnls.push(p.pnl - cost);
      }
      const g3 = g3pnls.length >= 2 ? bootstrapMeanCI(g3pnls, 7000 + bi * 7 + s.length) : null;

      byStruct[s] = {
        trades: pnls.length,
        winRate: pnls.length ? tr.filter((p) => p.pnl > 0).length / pnls.length : null,
        totalPnl,
        expectancy: pnls.length ? totalPnl / pnls.length : null,
        g2_mid: g2,
        g3_slip: g3,
        g3_excludedTrades: excluded,
      };
    }

    out.buckets.push({ equity: eq, byStructure: byStruct, fidelity: checkRows });

    // ── console report ──
    console.log(`\n================ $${eq} bucket ================`);
    for (const r of checkRows) {
      const okN = r.n === r.canonN;
      const okP = Math.abs(r.totalPnl - r.canonTotal) < 0.5;
      console.log(
        `  [fidelity] ${r.s}: n=${r.n} (canon ${r.canonN} ${okN ? 'OK' : 'MISMATCH'}), ` +
          `totalPnl=${fmt(r.totalPnl)} (canon ${fmt(r.canonTotal)} ${okP ? 'OK' : 'MISMATCH'})`,
      );
    }
    for (const s of STRUCTURES) {
      const b = byStruct[s];
      console.log(`\n  --- ${s} ---`);
      console.log(`    trades=${b.trades}  winRate=${b.winRate == null ? 'n/a' : (b.winRate * 100).toFixed(1) + '%'}  expectancy/trade=$${fmt(b.expectancy)}`);
      if (b.trades < 30) {
        console.log(`    G2: UNDERPOWERED (n=${b.trades} < 30) -> NO-VERDICT (cannot GO)`);
      } else {
        console.log(`    G2 mid-fill: expectancy=$${fmt(b.g2_mid.point)}  95% CI [$${fmt(b.g2_mid.lo95)}, $${fmt(b.g2_mid.hi95)}]  perTradeStd=$${fmt(b.g2_mid.perTradeStd)}  -> ${b.g2_mid.lo95 > 0 ? 'PASS (lower>0)' : 'FAIL (CI straddles/below 0)'}`);
        console.log(`    G3 +slip:    expectancy=$${fmt(b.g3_slip.point)}  95% CI [$${fmt(b.g3_slip.lo95)}, $${fmt(b.g3_slip.hi95)}]  (excluded ${b.g3_excludedTrades})  -> ${b.g3_slip.lo95 > 0 ? 'PASS (lower>0)' : 'FAIL'}`);
      }
    }
  }

  // pooled-across-buckets view for the primary structures (more power)
  console.log(`\n================ POOLED across $2k/$5k/$10k ================`);
  CAPTURE = [];
  const pooled = {};
  for (const s of STRUCTURES) pooled[s] = { mid: [], slip: [], excl: 0 };
  for (const eq of EQUITIES) {
    CAPTURE = [];
    replayBucket(days, eq, cfg);
    for (const p of CAPTURE) {
      if (!STRUCTURES.includes(p.signalType)) continue;
      pooled[p.signalType].mid.push(p.pnl);
      const cost = entrySlippageCost(p, entryIndex);
      if (cost == null) pooled[p.signalType].excl += 1;
      else pooled[p.signalType].slip.push(p.pnl - cost);
    }
  }
  out.pooled = {};
  for (const s of STRUCTURES) {
    const mid = pooled[s].mid, slip = pooled[s].slip;
    const g2 = mid.length >= 2 ? bootstrapMeanCI(mid, 4242) : null;
    const g3 = slip.length >= 2 ? bootstrapMeanCI(slip, 9999) : null;
    out.pooled[s] = { trades: mid.length, g2_mid: g2, g3_slip: g3, excluded: pooled[s].excl };
    console.log(`\n  --- ${s} (pooled, n=${mid.length}) ---`);
    if (mid.length < 30) { console.log(`    UNDERPOWERED (n=${mid.length} < 30) -> NO-VERDICT`); continue; }
    console.log(`    G2 mid-fill: expectancy=$${fmt(g2.point)}  95% CI [$${fmt(g2.lo95)}, $${fmt(g2.hi95)}]  -> ${g2.lo95 > 0 ? 'PASS' : 'FAIL (straddles 0)'}`);
    console.log(`    G3 +slip:    expectancy=$${fmt(g3.point)}  95% CI [$${fmt(g3.lo95)}, $${fmt(g3.hi95)}]  -> ${g3.lo95 > 0 ? 'PASS' : 'FAIL'}`);
  }

  const { writeFile } = await import('node:fs/promises');
  await writeFile('./data/replay-reports/tra781-phase2-gates.json', JSON.stringify(out, null, 2));
  console.log(`\n[TRA-781] wrote ./data/replay-reports/tra781-phase2-gates.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
