// TRA-954 acceptance #1 — per-fill log evidence for the risk-capped conviction DCA.
//
// Drives the SHIPPED pure core (`@trading-app/shared` dist, commits 0d56029 +
// d305bfb incl. TRA-958 gates A/B/C) through deterministic equity + options
// scenarios and writes a per-fill ledger. Every line records the decision, the
// post-add blended risk vs R (proving the invariant holds), and which gate fired
// on a skip. No network, no randomness — re-run yields byte-identical output.
//
// Run:  node packages/backtest/reports/tra954-dca-perfill-evidence.mjs
import { writeFileSync } from 'node:fs';
import {
  CONVICTION_DCA,
  evaluateEquityDcaAdd,
  evaluateOptionDcaAdd,
} from '../../shared/dist/conviction-dca.js';

const ON = { ...CONVICTION_DCA, enabled: true };
const R = 100; // per-position risk budget (dollars) for the equity scenario
const OR = 500; // per-position premium budget for the options scenario

const ledger = [];
function record(scenario, step, kind, ctxNote, verdict) {
  ledger.push({
    scenario,
    step,
    kind,
    note: ctxNote,
    action: verdict.action,
    qty: verdict.qty,
    blendedAvg: verdict.blendedAvg ?? null,
    projectedRisk: verdict.projectedRisk ?? null,
    riskBudget: verdict.riskBudget,
    withinBudget:
      verdict.projectedRisk == null ? true : verdict.projectedRisk <= verdict.riskBudget + 1e-9,
    reason: verdict.reason,
  });
}

// ── Scenario E: equity long, conviction pullback ladder ───────────────────────
// Entry 100 (5 sh, stop 90 → risk $50 = 0.5R). Price pulls back; we add on the
// ladder, then hit the gates one by one.
{
  const stop = 90;
  const baseEq = {
    side: 'long',
    stop,
    riskBudget: R,
    atr: 2, // 1.0-ATR ladder rung = 2 points → rungs stay above the stop
    trendRef: 92,
    signalStillValid: true,
    barsSinceLastFill: 3,
    minutesToSessionClose: 120,
    grossExposureBreached: false,
    dailyLossLimitBreached: false,
    tradingDaysToEarnings: null,
    addsToday: 0,
  };

  // Add #1 — eligible 1.5-ATR pullback to 97, no adds yet today.
  let tranches = [{ qty: 5, price: 100 }];
  let v = evaluateEquityDcaAdd({ ...baseEq, tranches, addPrice: 97 }, ON);
  record('E equity ladder', 1, 'add@97 (1.5 ATR pullback)', 'first add of day', v);
  if (v.action !== 'skip') tranches = [...tranches, { qty: v.qty, price: 97 }];

  // Add #2 attempt SAME day → gate C blocks (max 1 add/name/day).
  v = evaluateEquityDcaAdd({ ...baseEq, tranches, addPrice: 95, addsToday: 1 }, ON);
  record('E equity ladder', 2, 'add@95 same session', 'gate C: 2nd add same day', v);

  // Next day, further 1.25-ATR pullback to 94.5 (still above the 90 stop) → add #2,
  // R re-checked: blended risk lands at 80 <= R=100.
  v = evaluateEquityDcaAdd({ ...baseEq, tranches, addPrice: 94.5, addsToday: 0 }, ON);
  record('E equity ladder', 3, 'add@94.5 next day', 'ladder add #2, R cap re-verified', v);
  if (v.action !== 'skip') tranches = [...tranches, { qty: v.qty, price: 94.5 }];

  // Earnings in 1 trading day → gate B blackout blocks any further add.
  v = evaluateEquityDcaAdd(
    { ...baseEq, tranches, addPrice: 93, addsToday: 0, tradingDaysToEarnings: 1 },
    ON,
  );
  record('E equity ladder', 4, 'add@93 pre-earnings', 'gate B: earnings blackout', v);

  // Independent probe: a not-yet-full position (entry + 1 add) whose price has
  // broken below the SMA-50 ref → trend break is an EXIT, not an add (acceptance #3).
  v = evaluateEquityDcaAdd(
    {
      ...baseEq,
      tranches: [{ qty: 5, price: 100 }, { qty: 3, price: 97 }],
      addPrice: 91,
      addsToday: 0,
      trendRef: 95,
    },
    ON,
  );
  record('E equity ladder', 5, 'add@91 below SMA-50', 'acceptance #3: trend break is an exit', v);
}

// ── Scenario O: defined-risk long call, conviction adds + gate A ──────────────
{
  const baseOpt = {
    definedRisk: true,
    riskBudget: OR,
    addDebitPerContract: 150,
    dte: 40,
    addDelta: 0.55,
    underlyingThesisConfirmed: true,
    spreadWidthPct: 0.05,
    atMaxContracts: false,
    dailyLossLimitBreached: false,
    grossExposureBreached: false,
    tradingDaysToEarnings: null,
    addsToday: 0,
  };

  // Entry: 1 contract @ $150 premium. Add #1 — delta 0.55, premium budget has room.
  let tranches = [{ qty: 1, price: 150 }];
  let v = evaluateOptionDcaAdd({ ...baseOpt, tranches }, ON);
  record('O option call', 1, 'add 1x @ delta 0.55', 'conviction add within premium R', v);
  if (v.action !== 'skip') tranches = [...tranches, { qty: v.qty, price: 150 }];

  // Add attempt on a far-OTM leg (delta 0.20) → gate A blocks.
  v = evaluateOptionDcaAdd({ ...baseOpt, tranches, addDelta: 0.2, addsToday: 0 }, ON);
  record('O option call', 2, 'add @ delta 0.20', 'gate A: |delta| < 0.35 floor', v);

  // Add attempt with DTE 18 → DTE gate blocks (theta).
  v = evaluateOptionDcaAdd({ ...baseOpt, tranches, dte: 18, addsToday: 0 }, ON);
  record('O option call', 3, 'add @ DTE 18', 'acceptance #4: DTE < 21', v);
}

// ── Summary + invariant assertion ────────────────────────────────────────────
const breaches = ledger.filter((l) => !l.withinBudget);
const adds = ledger.filter((l) => l.action !== 'skip').length;
const skips = ledger.filter((l) => l.action === 'skip').length;
const out = {
  generatedFor: 'TRA-954 acceptance #1',
  core: '@trading-app/shared/conviction-dca (commits 0d56029 + d305bfb)',
  config: {
    maxAdds: ON.maxAdds,
    trancheSplit: ON.trancheSplit,
    optionMinAddDelta: ON.optionMinAddDelta,
    earningsBlackoutTradingDays: ON.earningsBlackoutTradingDays,
    maxAddsPerNamePerDay: ON.maxAddsPerNamePerDay,
    optionMinDTE: ON.optionMinDTE,
  },
  totals: { rows: ledger.length, adds, skips, riskBudgetBreaches: breaches.length },
  invariantHeld: breaches.length === 0,
  ledger,
};

const jsonPath = new URL('./tra954-dca-perfill-evidence.json', import.meta.url);
writeFileSync(jsonPath, JSON.stringify(out, null, 2));

const rows = ledger
  .map(
    (l) =>
      `| ${l.scenario} | ${l.step} | ${l.kind} | \`${l.action}\` | ${l.qty} | ${
        l.projectedRisk == null ? '—' : l.projectedRisk.toFixed(2)
      } | ${l.withinBudget ? 'Y' : 'N'} | ${l.reason} |`,
  )
  .join('\n');
const md = `# TRA-954 acceptance #1 — DCA per-fill evidence

Core: \`@trading-app/shared/conviction-dca\` (commits 0d56029 + d305bfb, incl. TRA-958 gates A/B/C).
Deterministic; regenerate with \`node packages/backtest/reports/tra954-dca-perfill-evidence.mjs\`.

**Invariant held (no post-add risk > R): ${out.invariantHeld ? 'YES' : 'NO'}** — ${adds} adds, ${skips} gated skips, ${breaches.length} budget breaches across ${ledger.length} decisions.

| scenario | step | event | action | qty | post-add risk | <=R | reason |
|---|---|---|---|---|---|---|---|
${rows}
`;
const mdPath = new URL('./tra954-dca-perfill-evidence.md', import.meta.url);
writeFileSync(mdPath, md);

console.log(md);
if (!out.invariantHeld) {
  console.error('INVARIANT BREACH — a post-add risk exceeded R');
  process.exit(1);
}
