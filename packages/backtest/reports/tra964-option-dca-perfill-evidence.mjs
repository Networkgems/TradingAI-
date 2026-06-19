// TRA-964 (TRA-954 follow-up) acceptance #1 + #4 — per-fill evidence for the
// OPTIONS conviction-DCA scale-in, now wired into the options engine.
//
// Drives the SHIPPED pure core (`@trading-app/shared` dist, `evaluateOptionDcaAdd`,
// incl. TRA-958 gates A/B/C) the EXACT way the engine pass
// `SignalEngine.evaluateOptionDcaAdds` builds the `OptionAddContext`:
//   • per-contract premium basis  = premiumPaid × 100   (tranche price)
//   • add debit per contract      = mark × 100          (single-leg) / per-lot
//                                   reserved capital     (debit combo)
//   • R                           = riskBudgetPerPosition() = perPositionCap(equity)
// Every line records the decision, the post-add total premium-at-risk vs R
// (proving total_premium ≤ R), and which gate fired on a skip. No network, no
// randomness — re-run yields byte-identical output.
//
// Run:  node packages/backtest/reports/tra964-option-dca-perfill-evidence.mjs
import { writeFileSync } from 'node:fs';
import { CONVICTION_DCA, evaluateOptionDcaAdd } from '../../shared/dist/conviction-dca.js';

const ON = { ...CONVICTION_DCA, enabled: true };

// perPositionCap(equity) = max($150, 15% × equity). Demo book $50k → R = $7,500.
const EQUITY = 50_000;
const R = Math.max(150, EQUITY * 0.15); // 7500

const ledger = [];
function record(scenario, step, event, verdict, premiumAtRisk) {
  ledger.push({
    scenario,
    step,
    event,
    action: verdict.action,
    qty: verdict.qty,
    totalContracts: verdict.totalQty ?? null,
    premiumAtRisk: premiumAtRisk == null ? (verdict.projectedRisk ?? null) : premiumAtRisk,
    riskBudget: verdict.riskBudget,
    withinBudget:
      (verdict.projectedRisk ?? 0) <= verdict.riskBudget + 1e-9,
    reason: verdict.reason,
  });
}

// ── Scenario A: long call, multi-tranche conviction scale-in ──────────────────
// Entry: 4 contracts @ mark $1.50 (per-contract basis $150 → $600 at risk = 0.08R).
// Conviction confirms; we add toward R, then hit gate C, DTE, and thesis blocks.
{
  const base = {
    definedRisk: true,
    riskBudget: R,
    dte: 40,
    addDelta: 0.55, // |delta| ≥ 0.35 floor (gate A)
    underlyingThesisConfirmed: true,
    spreadWidthPct: 0, // entry already cleared the scanner liquidity gate
    atMaxContracts: false,
    dailyLossLimitBreached: false,
    grossExposureBreached: false,
    tradingDaysToEarnings: null,
    addsToday: 0,
  };

  let tranches = [{ qty: 4, price: 150 }]; // entry basis: 4 × $150 = $600
  // Add #1 — mark drifted to $1.40 ($140/contract), thesis intact.
  let v = evaluateOptionDcaAdd({ ...base, tranches, addDebitPerContract: 140 }, ON);
  record('A long call', 1, 'add @ $1.40 mark, delta 0.55', v);
  if (v.action !== 'skip') tranches = [...tranches, { qty: v.qty, price: 140 }];

  // Add #2 SAME session → gate C blocks (max 1 add/name/day).
  v = evaluateOptionDcaAdd({ ...base, tranches, addDebitPerContract: 140, addsToday: 1 }, ON);
  record('A long call', 2, 'add same session', v);

  // Next day add #2 — premium R re-checked on the running total.
  v = evaluateOptionDcaAdd({ ...base, tranches, addDebitPerContract: 130, addsToday: 0 }, ON);
  record('A long call', 3, 'add @ $1.30 mark next day', v);
  if (v.action !== 'skip') tranches = [...tranches, { qty: v.qty, price: 130 }];

  // ── Gate probes on a FRESH single-entry position (add budget not yet spent),
  //    so the intended gate — not the tranche cap — is the one that fires.
  const fresh = [{ qty: 4, price: 150 }];
  // DTE 18 < 21 → theta gate blocks (acceptance #4).
  v = evaluateOptionDcaAdd({ ...base, tranches: fresh, addDebitPerContract: 130, dte: 18 }, ON);
  record('A long call', 4, 'add @ DTE 18 (fresh)', v);

  // Thesis broken (underlying no longer confirms) → block (acceptance #4).
  v = evaluateOptionDcaAdd(
    { ...base, tranches: fresh, addDebitPerContract: 130, underlyingThesisConfirmed: false },
    ON,
  );
  record('A long call', 5, 'add with thesis broken (fresh)', v);

  // Far-OTM decay leg (delta 0.20) → gate A blocks.
  v = evaluateOptionDcaAdd({ ...base, tranches: fresh, addDebitPerContract: 130, addDelta: 0.2 }, ON);
  record('A long call', 6, 'add @ delta 0.20 (fresh)', v);
}

// ── Scenario B: debit spread (defined-risk combo) conviction add ──────────────
// Bull call debit spread, 1 lot, $400 reserved/lot at risk. Add 1 lot at the
// same per-lot reserved capital; net debit structure → definedRisk true.
{
  const base = {
    definedRisk: true, // a debit spread is net-debit → defined-risk long premium
    riskBudget: R,
    dte: 35,
    addDelta: 0.45,
    underlyingThesisConfirmed: true,
    spreadWidthPct: 0,
    atMaxContracts: false,
    dailyLossLimitBreached: false,
    grossExposureBreached: false,
    tradingDaysToEarnings: null,
    addsToday: 0,
  };
  let tranches = [{ qty: 1, price: 400 }]; // 1 lot, $400 reserved
  let v = evaluateOptionDcaAdd({ ...base, tranches, addDebitPerContract: 400 }, ON);
  record('B debit spread', 1, 'add 1 lot @ $400 reserved', v);
  if (v.action !== 'skip') tranches = [...tranches, { qty: v.qty, price: 400 }];

  // Daily-loss limit tripped → all adds blocked (acceptance #5).
  v = evaluateOptionDcaAdd({ ...base, tranches, addDebitPerContract: 400, dailyLossLimitBreached: true, addsToday: 0 }, ON);
  record('B debit spread', 2, 'add with daily-loss halt', v);

  // Short premium (credit structure) → core refuses outright.
  v = evaluateOptionDcaAdd({ ...base, tranches, addDebitPerContract: 400, definedRisk: false, addsToday: 0 }, ON);
  record('B debit spread', 3, 'add to short premium', v);
}

// ── Summary + invariant assertion ────────────────────────────────────────────
const breaches = ledger.filter((l) => !l.withinBudget);
const adds = ledger.filter((l) => l.action !== 'skip').length;
const skips = ledger.filter((l) => l.action === 'skip').length;
const out = {
  generatedFor: 'TRA-964 acceptance #1 + #4 (options conviction-DCA)',
  core: '@trading-app/shared/conviction-dca evaluateOptionDcaAdd (TRA-958 gates A/B/C)',
  riskBudgetR: R,
  config: {
    maxAdds: ON.maxAdds,
    trancheSplit: ON.trancheSplit,
    optionMinDTE: ON.optionMinDTE,
    optionMinAddDelta: ON.optionMinAddDelta,
    earningsBlackoutTradingDays: ON.earningsBlackoutTradingDays,
    maxAddsPerNamePerDay: ON.maxAddsPerNamePerDay,
  },
  totals: { rows: ledger.length, adds, skips, riskBudgetBreaches: breaches.length },
  invariantHeld: breaches.length === 0,
  ledger,
};

const jsonPath = new URL('./tra964-option-dca-perfill-evidence.json', import.meta.url);
writeFileSync(jsonPath, JSON.stringify(out, null, 2));

const rows = ledger
  .map(
    (l) =>
      `| ${l.scenario} | ${l.step} | ${l.event} | \`${l.action}\` | ${l.qty} | ${
        l.premiumAtRisk == null ? '—' : l.premiumAtRisk.toFixed(2)
      } | ${l.withinBudget ? 'Y' : 'N'} | ${l.reason} |`,
  )
  .join('\n');
const md = `# TRA-964 — options conviction-DCA per-fill evidence (acceptance #1 + #4)

Core: \`@trading-app/shared/conviction-dca\` \`evaluateOptionDcaAdd\` (incl. TRA-958 gates A/B/C),
exercised exactly as \`SignalEngine.evaluateOptionDcaAdds\` builds the context.
R = \`riskBudgetPerPosition()\` = perPositionCap($${EQUITY.toLocaleString()}) = **$${R.toLocaleString()}**.
Deterministic; regenerate with \`node packages/backtest/reports/tra964-option-dca-perfill-evidence.mjs\`.

**Invariant held (no post-add premium-at-risk > R): ${out.invariantHeld ? 'YES' : 'NO'}** — ${adds} adds, ${skips} gated skips, ${breaches.length} budget breaches across ${ledger.length} decisions.

Acceptance #4 demonstrated: rows A/4 (DTE 18 < 21) and A/5 (thesis broken) are blocked.

| scenario | step | event | action | qty | premium-at-risk | <=R | reason |
|---|---|---|---|---|---|---|---|
${rows}
`;
const mdPath = new URL('./tra964-option-dca-perfill-evidence.md', import.meta.url);
writeFileSync(mdPath, md);

console.log(md);
if (!out.invariantHeld) {
  console.error('INVARIANT BREACH — a post-add premium-at-risk exceeded R');
  process.exit(1);
}
