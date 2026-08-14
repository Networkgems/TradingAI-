#!/usr/bin/env node
/**
 * TRA-3727 (parent TRA-2946) — counterfactual replay of `chandelier` option
 * exits: would HOLDING have beaten CUTTING?
 *
 * The parent asks "don't close positions the next day without context". The
 * measured early exit is `chandelier` (live `avgHoldDays 0.91`), and its
 * expectancy is negative in both cohorts (live `avgR −0.101` n=3, demo
 * `avgR −0.105` n=129). A negative avgR does NOT prove holding would have been
 * better — chandelier may be correctly cutting real losers. This script is the
 * replay that decides it.
 *
 * ── What it does ────────────────────────────────────────────────────────────
 *
 *   TREATMENT  every closed journal row with `exitReason == 'chandelier'`
 *   CONTROL    every closed journal row with `exitReason == 'trail'`
 *
 * `trail` is the REQUIRED positive control, not a nicety. It is a profitable
 * exit; if the replay reports that holding beats `trail` too, the harness is
 * measuring forward drift / market beta rather than exit quality and the
 * chandelier number must be discarded. Strata (`mode` × `exitReason`) are never
 * pooled into one scalar — a live n=3 and a demo n=129 are different cohorts on
 * different time scales (demo is intraday: `time_stop avgHoldDays 0.05`).
 *
 * For each row the counterfactual removes ONLY the chandelier clause and leaves
 * every other guard armed, then walks forward from the actual close to the
 * earlier of (a) the 4-trading-day swing stop or (b) another hard exit firing.
 *
 * ── The mark source ─────────────────────────────────────────────────────────
 *
 * The engine prices single-leg options at the Tradier chain MID, `(bid+ask)/2`.
 * The only historical record of that same quantity is the daily option-chain
 * recorder (TRA-376/TRA-380), which writes real Tradier chains to the box's
 * persistent disk at `/data/option-chains/<YYYY-MM-DD>/<SYMBOL>.json` and serves
 * them read-only from `/api/health/chain-capture/partition/:date`. This script
 * reads THAT — the engine's own mark basis, recorded, not re-derived.
 *
 * It never falls back to the underlying. A 4-day option decay path is not
 * recoverable from spot, so a spot-derived premium would be a fabricated mark
 * indistinguishable from a measured one. When the marks are not there the row is
 * DROPPED WITH A NAMED REASON and the drop is printed even when it is zero — a
 * silent drop biases the sample toward whatever happened to have data, which is
 * the exact failure the parent already hit once.
 *
 * ── Known, stated limitations (these are caveats, not silent assumptions) ────
 *
 *  L1. The recorder captures ONE snapshot per trading day at ~15:55 ET. The
 *      counterfactual therefore evaluates its guards on DAILY closes, while the
 *      live engine evaluates them per tick. A guard that would have fired
 *      intraday and recovered by 15:55 is invisible here. Direction of bias is
 *      not signable a priori, so it is reported, not corrected.
 *  L2. The ACTUAL arm's exit is the real fill/mark at the real (intraday) close
 *      time; the COUNTERFACTUAL arm's exit is a 15:55 ET mid. The pair is
 *      therefore not clock-aligned. Reported per row as `markTimingMismatch`.
 *  L3. `take_profit_early` is NOT modelled as armed: `TAKE_PROFIT_EARLY_LIVE_ENABLED`
 *      reads false on the live host, so on the live stratum it genuinely was not
 *      in the ladder. Stated in the output rather than assumed.
 *  L4. Fees and exit slippage are IDENTICAL in both arms (same contracts, one
 *      exit either way), so the paired difference is computed purely on exit
 *      PRICE and the cost terms cancel exactly. This is why ΔR is defined as
 *      `(cfExit − actualExit) × contracts × 100 / atRiskUsd` rather than as a
 *      difference of two separately-costed P&Ls.
 *
 * ── Pre-registered decision rule (fixed on the ticket before any number) ─────
 *
 * Retune/gate `chandelier` only if the chandelier stratum's mean paired ΔR is
 * > +0.05R with a 95% CI excluding 0, AND the `trail` control stratum does not
 * show a comparable positive ΔR. Anything else ⇒ leave `chandelier` alone.
 * A stratum with no replayable rows is BLIND, never "no effect".
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   node scripts/tra3727-chandelier-counterfactual.mjs
 *   node scripts/tra3727-chandelier-counterfactual.mjs --json=out.json
 *   node scripts/tra3727-chandelier-counterfactual.mjs --controls
 *
 *   --base=URL     server base (default https://tradingai-bqb1.onrender.com)
 *   --cache=DIR    partition/journal cache (default .tra3727-cache)
 *   --horizon=N    swing-stop horizon in trading days (default 4, the live
 *                  `OPTION_SWING_TIME_STOP_TRADING_DAYS`)
 *   --json=FILE    also write the full machine-readable result
 *   --controls     run the self-test suite and exit
 *
 * Exit codes:  0 CLEAN (rule evaluated) · 3 BLIND (rule not evaluable) · 2 usage
 *
 * BLIND > CLEAN. "Could not measure" and "measured, no effect" must never share
 * an exit code.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ── Shipped constants, restated with their source of truth ──────────────────
// Kept as literals (this is a plain .mjs run against a JS-free checkout) but
// each one names the module it mirrors so a drift is greppable.
const SHIPPED = {
  // packages/shared/src/index.ts
  OTM: { slPct: 0.20, tp1Pct: 0.50, trailActivatePct: 0.30, trailOffsetPct: 0.20, partialExitRatio: 0.4 },
  RV: { slPct: 0.25, slDollarFloor: 0.10, tp1Pct: 0.40, trailActivatePct: 0.25, trailOffsetPct: 0.15, partialExitRatio: 0.5 },
  PROFIT_LOCK_ARM_R: 1.0,
  PROFIT_LOCK_GIVEBACK_R: 1.0,
  PROFIT_LOCK_TIGHTEN_PEAK_R: 2.0,
  PROFIT_LOCK_TIGHTEN_GIVEBACK_R: 0.5,
};

/** Which risk bundle a journal `structure` was opened under. */
function riskParamsFor(structure) {
  // `single_leg_otm` and the directional sleeve run the OTM bundle; the RV
  // scanner runs its own. Anything else is refused rather than guessed.
  if (structure === 'single_leg_otm' || structure === 'single_leg_directional') return { name: 'OTM', ...SHIPPED.OTM };
  if (structure === 'single_leg_rv') return { name: 'RV', ...SHIPPED.RV };
  return null;
}

/** packages/engine/src/exit-rules.ts — profitLockDecision, long-premium only. */
function profitLockShouldExit(entry, initialStop, peak, current) {
  const R = Math.abs(entry - initialStop);
  if (!(R > 0)) return false;
  const peakR = (peak - entry) / R;
  const currentR = (current - entry) / R;
  const armed = peakR >= SHIPPED.PROFIT_LOCK_ARM_R;
  const giveBackR = peakR >= SHIPPED.PROFIT_LOCK_TIGHTEN_PEAK_R
    ? SHIPPED.PROFIT_LOCK_TIGHTEN_GIVEBACK_R
    : SHIPPED.PROFIT_LOCK_GIVEBACK_R;
  return armed && currentR <= peakR - giveBackR;
}

// ── Statistics ──────────────────────────────────────────────────────────────

/**
 * Paired one-sample summary. `se`/`ci` are `null` at n<2 — a single pair has no
 * dispersion, and printing 0 there would read as an infinitely tight interval.
 */
function pairedStats(deltas) {
  const n = deltas.length;
  if (n === 0) return { n: 0, mean: null, sd: null, se: null, ci95: null, t: null };
  const mean = deltas.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { n, mean, sd: null, se: null, ci95: null, t: null };
  const sd = Math.sqrt(deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  // Two-sided 95% t critical value. Table for small n (df = n−1), 1.96 beyond.
  const T = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306,
    9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131, 16: 2.120,
    17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086, 25: 2.060, 30: 2.042, 40: 2.021, 60: 2.000 };
  const df = n - 1;
  const keys = Object.keys(T).map(Number).sort((a, b) => a - b);
  const tcrit = T[df] ?? T[keys.filter((k) => k <= df).pop()] ?? 1.96;
  return {
    n, mean, sd, se,
    ci95: [mean - tcrit * se, mean + tcrit * se],
    t: se > 0 ? mean / se : null,
  };
}

/** Exact two-sided sign test. Zeros are discarded (the standard convention). */
function signTest(deltas) {
  const nz = deltas.filter((d) => d !== 0);
  const pos = nz.filter((d) => d > 0).length;
  const n = nz.length;
  if (n === 0) return { n: 0, pos: 0, neg: 0, zeros: deltas.length, p: null };
  const C = (a, b) => { let r = 1; for (let i = 0; i < b; i++) r = (r * (a - i)) / (i + 1); return r; };
  let tail = 0;
  const k = Math.min(pos, n - pos);
  for (let i = 0; i <= k; i++) tail += C(n, i);
  const p = Math.min(1, 2 * tail / 2 ** n);
  return { n, pos, neg: n - pos, zeros: deltas.length - n, p };
}

// ── Trading-day arithmetic over the RECORDED partitions ─────────────────────
//
// The horizon is counted in trading days, and the only trading days that exist
// for this replay are the ones the recorder actually captured. Counting off a
// calendar (or off a holiday table) would silently stretch the horizon across a
// gap the marks cannot cover.

function forwardCapturedDays(capturedDates, closeEtDay, horizon) {
  return capturedDates.filter((d) => d > closeEtDay).slice(0, horizon);
}

// ── The replay ──────────────────────────────────────────────────────────────

const DROP = {
  NO_OPTION_SYMBOL: 'no_option_symbol',
  UNDERLYING_NOT_RECORDED: 'underlying_not_recorded',
  UNKNOWN_RISK_BUNDLE: 'unknown_risk_bundle',
  NO_ENTRY_MARK: 'no_entry_mark',
  NO_FORWARD_MARKS: 'no_forward_marks',
};

/**
 * Replay ONE row forward with the chandelier clause removed.
 *
 * Returns `{ ok: false, reason }` for a drop, or `{ ok: true, ... }` with the
 * counterfactual exit and the paired ΔR. Every drop reason is one of `DROP`, so
 * the census below can enumerate them exhaustively.
 */
function replayRow(row, marks, horizon) {
  const rp = riskParamsFor(row.structure);
  if (!rp) return { ok: false, reason: DROP.UNKNOWN_RISK_BUNDLE };

  const entry = row.entryFillPremium ?? row.entryMarkUsd;
  if (!(entry > 0)) return { ok: false, reason: DROP.NO_ENTRY_MARK };
  if (marks.length === 0) return { ok: false, reason: DROP.NO_FORWARD_MARKS };

  // Contracts: stamped on live rows; on older demo rows recover it from the
  // R denominator, which the journal defines as full premium at risk
  // (atRiskUsd = entryMark × 100 × contracts — verified on all three live rows).
  const contracts = row.contracts ?? (row.atRiskUsd > 0 ? row.atRiskUsd / (entry * 100) : null);
  if (!(contracts > 0)) return { ok: false, reason: DROP.NO_ENTRY_MARK };

  // The ACTUAL exit price. Live rows carry the broker fill; demo rows do not, so
  // it is inverted out of the booked R (atRisk = entry × 100 × contracts).
  const actualExit = row.exitFillPremium ?? entry * (1 + row.realizedR);

  // Guards, chandelier REMOVED. Long the premium throughout (single-leg).
  const stopLossPremium = rp.name === 'RV'
    ? entry - Math.max(entry * rp.slPct, rp.slDollarFloor)
    : entry * (1 - rp.slPct);
  const tp1Premium = entry * (1 + rp.tp1Pct);

  // Seed the peak at the actual close mark: the position genuinely reached it,
  // and seeding at `entry` instead would under-arm both the trail and the
  // give-back lock in the counterfactual's favour.
  let peak = Math.max(entry, actualExit);
  let trailingActive = false;

  for (let i = 0; i < marks.length; i++) {
    const { etDay, mid } = marks[i];
    peak = Math.max(peak, mid);

    // 1. hard premium stop — exempt from every window, fires first.
    if (mid <= stopLossPremium) {
      return finish(etDay, stopLossPremium, 'sl', i + 1);
    }
    // 2. profit-lock give-back cap (Rule 2).
    if (profitLockShouldExit(entry, stopLossPremium, peak, mid)) {
      return finish(etDay, mid, 'profit_lock', i + 1);
    }
    // 3. TP1 arms the premium trail (the partial itself is not modelled — see
    //    the header; it does not move the REMAINDER's exit price, which is what
    //    ΔR is computed on).
    if (mid >= tp1Premium) trailingActive = true;
    if (mid >= entry * (1 + rp.trailActivatePct)) trailingActive = true;
    // 4. premium trail on the remainder.
    if (trailingActive) {
      const trailStop = peak * (1 - rp.trailOffsetPct);
      if (mid <= trailStop) return finish(etDay, trailStop, 'trail', i + 1);
    }
    // 5. the 4-trading-day swing time stop — the horizon itself.
    if (i === horizon - 1) return finish(etDay, mid, 'time_stop', i + 1);
  }

  // Ran out of recorded marks before the horizon closed. This is NOT a
  // time-stop: the hold was truncated by the data, not by the policy. Mark it
  // so the census can separate "held to the stop" from "held as far as the
  // tape goes".
  const last = marks[marks.length - 1];
  return finish(last.etDay, last.mid, 'horizon_truncated_by_data', marks.length, true);

  function finish(etDay, exitPremium, reason, daysHeld, truncated = false) {
    const deltaR = ((exitPremium - actualExit) * contracts * 100) / row.atRiskUsd;
    return {
      ok: true,
      cfExitEtDay: etDay,
      cfExitPremium: exitPremium,
      cfExitReason: reason,
      cfTradingDaysHeld: daysHeld,
      truncated,
      contracts,
      entryPremium: entry,
      actualExitPremium: actualExit,
      actualR: row.realizedR,
      cfR: row.realizedR + deltaR,
      deltaR,
      markTimingMismatch: true, // L2 — always true; the actual leg is intraday.
    };
  }
}

// ── I/O ─────────────────────────────────────────────────────────────────────

async function cachedJson(cacheDir, name, url) {
  const path = join(cacheDir, name);
  if (existsSync(path)) {
    const raw = await readFile(path, 'utf-8');
    if (raw.length > 0) return JSON.parse(raw);
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  const body = await res.text();
  if (!res.ok && res.status !== 404) throw new Error(`${url} -> HTTP ${res.status}`);
  await writeFile(path, body, 'utf-8');
  return JSON.parse(body);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(argv) {
  const arg = (k, d) => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : d;
  };
  const base = (arg('base', 'https://tradingai-bqb1.onrender.com')).replace(/\/+$/, '');
  const cacheDir = arg('cache', '.tra3727-cache');
  const horizon = Number(arg('horizon', '4'));
  const jsonOut = arg('json', null);
  if (!Number.isInteger(horizon) || horizon < 1) {
    console.error('--horizon must be a positive integer');
    return 2;
  }
  await mkdir(cacheDir, { recursive: true });

  console.log(`[tra3727] base=${base} horizon=${horizon} trading days`);

  const journal = await cachedJson(cacheDir, 'journal.json', `${base}/api/health/option-journal?rows=all`);
  const capture = await cachedJson(cacheDir, 'chain-capture.json', `${base}/api/health/chain-capture`);
  if (journal.rowsMode !== 'all') {
    console.error(`[tra3727] BLIND: journal served rowsMode=${journal.rowsMode}, not 'all'`);
    return 3;
  }

  const universe = new Set(capture.configuredUniverse ?? []);
  const capturedDates = (capture.storage?.perPartition ?? [])
    .filter((p) => p.files > 0)
    .map((p) => p.date)
    .sort();
  console.log(
    `[tra3727] chain corpus: ${capturedDates.length} non-empty partitions `
    + `${capturedDates[0]}..${capturedDates[capturedDates.length - 1]}, `
    + `universe=${universe.size} symbols`,
  );
  console.log(`[tra3727] recorded universe: ${[...universe].join(' ')}`);

  const closed = (journal.rows ?? []).filter((r) => r.closeTs != null);
  const strata = [
    { key: 'live/chandelier', mode: 'live', exitReason: 'chandelier', arm: 'TREATMENT' },
    { key: 'demo/chandelier', mode: 'demo', exitReason: 'chandelier', arm: 'TREATMENT' },
    { key: 'live/trail', mode: 'live', exitReason: 'trail', arm: 'CONTROL' },
    { key: 'demo/trail', mode: 'demo', exitReason: 'trail', arm: 'CONTROL' },
  ];

  // Which (date, symbol) partitions do we actually need? Fetch only those.
  const needed = new Set();
  for (const s of strata) {
    for (const r of closed.filter((r) => r.mode === s.mode && r.exitReason === s.exitReason)) {
      if (!r.optionSymbol || !universe.has(r.symbol)) continue;
      for (const d of forwardCapturedDays(capturedDates, r.closeEtDay, horizon)) needed.add(d);
    }
  }
  const partitions = new Map();
  for (const d of [...needed].sort()) {
    const p = await cachedJson(cacheDir, `partition-${d}.json`, `${base}/api/health/chain-capture/partition/${d}`);
    partitions.set(d, p);
  }
  console.log(`[tra3727] pulled ${partitions.size} forward partitions`);

  function midFor(etDay, underlying, occ) {
    const p = partitions.get(etDay);
    if (!p || p.error) return null;
    const snap = (p.symbols ?? []).find((x) => x.symbol === underlying);
    if (!snap) return null;
    const row = (snap.rows ?? []).find((x) => x.optionSymbol === occ);
    if (!row) return null;
    if (typeof row.bid !== 'number' || typeof row.ask !== 'number') return null;
    // A zero bid with a live ask is a real, tradable-nowhere quote. The engine's
    // mark basis is the mid regardless, so it is used — not silently repaired.
    const mid = (row.bid + row.ask) / 2;
    return mid > 0 ? mid : null;
  }

  const report = { issue: 'TRA-3727', generatedAt: new Date().toISOString(), base, horizon, strata: {} };

  for (const s of strata) {
    const rows = closed.filter((r) => r.mode === s.mode && r.exitReason === s.exitReason);
    const drops = Object.fromEntries(Object.values(DROP).map((d) => [d, 0]));
    const replayed = [];
    const truncatedRows = [];

    for (const r of rows) {
      if (!r.optionSymbol) { drops[DROP.NO_OPTION_SYMBOL] += 1; continue; }
      if (!universe.has(r.symbol)) { drops[DROP.UNDERLYING_NOT_RECORDED] += 1; continue; }
      const days = forwardCapturedDays(capturedDates, r.closeEtDay, horizon);
      const marks = [];
      for (const d of days) {
        const mid = midFor(d, r.symbol, r.optionSymbol);
        if (mid != null) marks.push({ etDay: d, mid });
      }
      const out = replayRow(r, marks, horizon);
      if (!out.ok) { drops[out.reason] += 1; continue; }
      if (out.truncated) truncatedRows.push(r.id);
      replayed.push({ id: r.id, symbol: r.symbol, optionSymbol: r.optionSymbol, closeEtDay: r.closeEtDay,
        accountClass: r.accountClass, structure: r.structure, ...out });
    }

    // TRA-2193/TRA-3715 house rule — a QA FIXTURE book mirrors ONE economic
    // trade into several accounts under distinct `id`s, so pooling them inflates
    // n without adding an independent observation. The graded population is
    // `desk`. Both are reported; the verdict below reads `desk`.
    const desk = replayed.filter((x) => x.accountClass === 'desk');
    const byAccountClass = replayed.reduce(
      (a, x) => ((a[x.accountClass] = (a[x.accountClass] ?? 0) + 1), a), {});

    const deltas = desk.map((x) => x.deltaR);
    const stats = pairedStats(deltas);
    const sign = signTest(deltas);
    const nDropped = Object.values(drops).reduce((a, b) => a + b, 0);

    report.strata[s.key] = {
      arm: s.arm,
      nTotal: rows.length,
      /** Rows the replay could price at all, INCLUDING mirrored fixture books. */
      nReplayableAnyClass: replayed.length,
      nReplayableByAccountClass: byAccountClass,
      /** The graded population — `desk` only. Every stat below is over this. */
      nReplayable: desk.length,
      nDropped,
      // Printed even at 0 — a silent drop biases the sample toward whatever
      // happened to have data.
      dropReasons: drops,
      nTruncatedByData: desk.filter((x) => x.truncated).length,
      nTruncatedByDataAnyClass: truncatedRows.length,
      meanDeltaR: stats.mean,
      sd: stats.sd,
      se: stats.se,
      ci95: stats.ci95,
      t: stats.t,
      signTest: sign,
      distinctContracts: new Set(desk.map((x) => x.optionSymbol)).size,
      distinctContractsAnyClass: new Set(replayed.map((x) => x.optionSymbol)).size,
      cfExitReasons: desk.reduce((a, x) => ((a[x.cfExitReason] = (a[x.cfExitReason] ?? 0) + 1), a), {}),
      rows: replayed,
    };
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const f = (v, d = 4) => (v == null ? 'n/a' : v.toFixed(d));
  console.log('');
  for (const s of strata) {
    const r = report.strata[s.key];
    console.log(`── ${s.key}  [${s.arm}] ────────────────────────────────`);
    console.log(`   n_total=${r.nTotal}  n_priceable=${r.nReplayableAnyClass} `
      + `${JSON.stringify(r.nReplayableByAccountClass)}  n_replayable(desk)=${r.nReplayable}  n_dropped=${r.nDropped}`);
    for (const [k, v] of Object.entries(r.dropReasons)) console.log(`     drop ${k.padEnd(26)} ${v}`);
    console.log(`   distinct desk contracts: ${r.distinctContracts}   desk rows truncated by data: ${r.nTruncatedByData}`);
    if (r.nReplayable === 0) {
      console.log('   mean paired ΔR: BLIND (no replayable DESK rows)');
    } else {
      console.log(`   mean paired ΔR = ${f(r.meanDeltaR)}  SE ${f(r.se)}  `
        + `95% CI ${r.ci95 ? `[${f(r.ci95[0])}, ${f(r.ci95[1])}]` : 'n/a (n<2)'}`);
      console.log(`   sign test: ${r.signTest.pos}+ / ${r.signTest.neg}−  `
        + `zeros ${r.signTest.zeros}  p=${r.signTest.p == null ? 'n/a' : r.signTest.p.toFixed(4)}`);
      console.log(`   counterfactual exit reasons: ${JSON.stringify(r.cfExitReasons)}`);
      for (const x of r.rows.filter((y) => y.accountClass === 'desk')) {
        console.log(`     ${x.optionSymbol.padEnd(22)} close ${x.closeEtDay} → cf ${x.cfExitEtDay} `
          + `(${x.cfExitReason}, ${x.cfTradingDaysHeld}d)  actual ${f(x.actualExitPremium, 3)} `
          + `→ cf ${f(x.cfExitPremium, 3)}  ΔR ${f(x.deltaR)}`);
      }
    }
    console.log('');
  }

  // ── Pre-registered rule ───────────────────────────────────────────────────
  //
  // Evaluated per MODE, because the strata are never pooled: a treatment
  // stratum can only be ruled on against the control stratum from the SAME
  // mode. A mode whose treatment or control arm has no replayable rows is
  // BLIND for that mode — not "no effect".
  const verdicts = {};
  for (const mode of ['live', 'demo']) {
    const t = report.strata[`${mode}/chandelier`];
    const c = report.strata[`${mode}/trail`];
    if (t.nReplayable === 0 || c.nReplayable === 0) {
      verdicts[mode] = {
        verdict: 'BLIND',
        why: `treatment desk n_replayable=${t.nReplayable} (any class ${t.nReplayableAnyClass}), `
          + `control desk n_replayable=${c.nReplayable} (any class ${c.nReplayableAnyClass}); `
          + 'the control is required to make the treatment falsifiable, so a stratum missing '
          + 'either arm cannot be ruled on.',
      };
      continue;
    }
    const tSig = t.ci95 != null && t.meanDeltaR > 0.05 && t.ci95[0] > 0;
    const cPositive = c.meanDeltaR != null && c.meanDeltaR > 0.05;
    verdicts[mode] = {
      verdict: tSig && !cPositive ? 'RETUNE_JUSTIFIED' : 'NO_CHANGE',
      why: !tSig
        ? 'chandelier mean ΔR did not clear +0.05R with a 95% CI excluding 0'
        : cPositive
          ? 'the trail control shows a comparable positive ΔR ⇒ confounded by forward drift; result discarded'
          : 'chandelier ΔR cleared the bar and the trail control is flat',
    };
  }
  report.verdicts = verdicts;

  console.log('══ PRE-REGISTERED DECISION RULE ══');
  for (const [mode, v] of Object.entries(verdicts)) console.log(`   ${mode}: ${v.verdict} — ${v.why}`);

  const blind = Object.values(verdicts).every((v) => v.verdict === 'BLIND');
  report.overall = blind ? 'BLIND' : 'CLEAN';
  console.log(`\n   OVERALL: ${report.overall}`);

  if (jsonOut) {
    await writeFile(jsonOut, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`   wrote ${jsonOut}`);
  }
  return blind ? 3 : 0;
}

// ── Controls ────────────────────────────────────────────────────────────────
//
// The point of this suite: BLIND must be distinguishable from BROKEN. A harness
// that returns "no replayable rows" because its replay is inert reads exactly
// like one that returns it because the marks are missing. These cases drive the
// replay with synthetic marks and assert it produces the right number, so the
// BLIND verdict on the real corpus is evidence about the CORPUS, not about this
// file.

function controls() {
  let failed = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
    if (!ok) failed += 1;
  };
  const near = (name, got, want, tol = 1e-9) => {
    const ok = got != null && Math.abs(got - want) < tol;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got ${got} want ${want}`}`);
    if (!ok) failed += 1;
  };

  const base = {
    id: 'x', mode: 'live', exitReason: 'chandelier', structure: 'single_leg_otm',
    symbol: 'AAPL', optionSymbol: 'AAPL260904C00300000',
    entryFillPremium: 1.00, contracts: 1, atRiskUsd: 100, realizedR: -0.10,
    exitFillPremium: 0.90, closeEtDay: '2026-08-04',
  };
  const day = (d, mid) => ({ etDay: d, mid });

  // 1. Holding to the swing stop with a recovering mark: ΔR is positive and is
  //    exactly the exit-price difference in R units.
  const up = replayRow(base, [day('a', 0.95), day('b', 1.00), day('c', 1.05), day('d', 1.10)], 4);
  check('rides to the time stop', [up.ok, up.cfExitReason, up.cfTradingDaysHeld], [true, 'time_stop', 4]);
  near('ΔR = (1.10 − 0.90) × 1 × 100 / 100', up.deltaR, 0.20);

  // 2. The hard premium stop still fires with the chandelier removed — the
  //    counterfactual removes ONE clause, not the ladder.
  const down = replayRow(base, [day('a', 0.85), day('b', 0.60), day('c', 1.50), day('d', 2.00)], 4);
  check('hard SL fires (OTM slPct 0.20 ⇒ stop 0.80)', [down.cfExitReason, down.cfTradingDaysHeld], ['sl', 2]);
  near('ΔR at the stop = (0.80 − 0.90)/1.00', down.deltaR, -0.10);

  // 3. A row with marks running out before the horizon is TRUNCATED, not a
  //    time stop. Conflating them would report a 4-day hold that never happened.
  const trunc = replayRow(base, [day('a', 0.95), day('b', 0.97)], 4);
  check('truncated by data ≠ time_stop', [trunc.cfExitReason, trunc.truncated], ['horizon_truncated_by_data', true]);

  // 4. No forward marks ⇒ a NAMED drop, never a zero ΔR.
  check('no marks ⇒ named drop', replayRow(base, [], 4), { ok: false, reason: DROP.NO_FORWARD_MARKS });

  // 5. An unknown structure is refused rather than defaulted onto a bundle.
  check('unknown structure refused',
    replayRow({ ...base, structure: 'bull_put' }, [day('a', 1.0)], 4),
    { ok: false, reason: DROP.UNKNOWN_RISK_BUNDLE });

  // 6. The peak seeds at the actual close mark, so a give-back that was already
  //    earned is not handed back to the counterfactual for free.
  const lock = replayRow(
    { ...base, exitFillPremium: 2.50, realizedR: 1.50 },
    [day('a', 2.60), day('b', 1.30), day('c', 3.00), day('d', 3.00)], 4);
  check('profit-lock give-back fires off the seeded peak', lock.cfExitReason, 'profit_lock');

  // 7. Stats: SE/CI are null at n=1 rather than 0 (a lone pair has no spread).
  check('n=1 has no CI', pairedStats([0.3]).ci95, null);
  const st = pairedStats([0.1, 0.2, 0.3]);
  near('mean of [.1,.2,.3]', st.mean, 0.2, 1e-12);
  near('sd of [.1,.2,.3]', st.sd, 0.1, 1e-12);

  // 8. Sign test discards zeros and is two-sided.
  check('sign test drops zeros', signTest([1, 1, 1, 0]).n, 3);
  near('sign test p for 3/3', signTest([1, 1, 1]).p, 0.25, 1e-12);

  // 9. RV rows use the RV bundle and its dollar stop floor, not the OTM one.
  const rv = replayRow(
    { ...base, structure: 'single_leg_rv', entryFillPremium: 0.30, atRiskUsd: 30, exitFillPremium: 0.28, realizedR: -0.0667 },
    [day('a', 0.19)], 4);
  check('RV slDollarFloor 0.10 ⇒ stop 0.20, fires', rv.cfExitReason, 'sl');

  // 10. Trading days come off the CAPTURED partitions, so a gap cannot be
  //     silently walked over as if it were a session.
  check('horizon walks captured days only',
    forwardCapturedDays(['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07'], '2026-08-04', 2),
    ['2026-08-05', '2026-08-06']);

  // 11. Mirrored QA fixture books must not enter the graded population. Two
  //     accounts holding the SAME contract are one economic observation, and
  //     counting them twice halves the SE of a sample that never grew.
  const mirrored = [
    { accountClass: 'fixture', deltaR: 0.5 },
    { accountClass: 'fixture', deltaR: 0.5 },
    { accountClass: 'desk', deltaR: 0.1 },
  ];
  const graded = mirrored.filter((x) => x.accountClass === 'desk');
  check('fixture mirrors excluded from the graded n', [graded.length, pairedStats(graded.map((x) => x.deltaR)).n], [1, 1]);

  console.log(failed === 0 ? '\nALL CONTROLS PASS' : `\n${failed} CONTROL(S) FAILED`);
  return failed === 0 ? 0 : 1;
}

const argv = process.argv.slice(2);
if (argv.includes('--controls')) {
  process.exit(controls());
} else {
  main(argv).then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(3); });
}
