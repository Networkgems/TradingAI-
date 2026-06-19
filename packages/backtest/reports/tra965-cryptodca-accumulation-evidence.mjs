// TRA-965 demo acceptance — per-fill evidence for the shipped CryptoDCA
// accumulation, at QuantTrader's signed-off caps (commit b159ee1):
//   maxSymbolNotionalFracOfManagedEquity = 0.10
//   exitMode = 'hold'  (catastrophe stop is the only auto-exit)
//
// Drives the SHIPPED `CryptoPaperAccount` (`@trading-app/server` dist) through a
// deterministic multi-week DCA cadence on ONE symbol and writes a per-fill
// ledger. It re-implements the engine's `accumulateDca` sizing + per-symbol cap
// EXACTLY (crypto-engine.ts:1496-1522) — size like a fresh entry (risk-from-stop)
// × the TRA-423 cluster-cap multiplier, clamp to the 0.10 per-symbol notional
// headroom and to cash — so the ledger reflects the production add path, not a
// re-derivation. No network, no randomness, no live Coinbase: re-run is
// byte-identical. This is the offline acceptance; the live Coinbase-sandbox demo
// (TRA-961 operator credential) only adds real-feed execution on top.
//
// Run:  node packages/backtest/reports/tra965-cryptodca-accumulation-evidence.mjs
import { writeFileSync } from 'node:fs';
import { CryptoPaperAccount } from '../../server/dist/crypto-account.js';

// Shipped values (crypto-engine.ts CRYPTO_DCA_ACCUMULATION, commit b159ee1).
const MAX_SYMBOL_NOTIONAL_FRAC = 0.1;
const EXIT_MODE = 'hold';
// TRA-423 cluster-cap multiplier the engine passes into accumulateDca. A value
// in (0,1) trims the add toward the cluster cap; 1 (or out-of-range) is a no-op.
const CLUSTER_CAP_MULTIPLIER = 1;

const SYMBOL = 'BTC-USD';
// One held DCA bracket: wide catastrophe stop (~33% below entry), 4R-ish TP.
const ENTRY_PRICE = 60_000;
const CATASTROPHE_STOP = 40_000;
const TAKE_PROFIT = 132_000;

// A weekly cadence of falling prices — a conviction pullback the strategy
// averages into, one add per weekly window (cadence/dedup live in the engine;
// here each row IS one fired cadence window).
const WEEKLY_ADD_PRICES = [58_000, 55_000, 52_000, 49_000, 46_000, 43_000, 41_000];

const acct = new CryptoPaperAccount(25_000);

// Faithful port of CryptoSignalEngine.accumulateDca (crypto-engine.ts:1496-1522).
function accumulateDca(pos, addPrice) {
  const capNotional = acct.managedEquity() * MAX_SYMBOL_NOTIONAL_FRAC;
  const currentNotional = pos.quantity * addPrice;
  const headroomNotional = capNotional - currentNotional;
  if (headroomNotional <= 0) {
    return {
      action: 'hold-at-cap',
      capNotional,
      currentNotional,
      reason: `at per-symbol cap (${currentNotional.toFixed(0)} >= ${capNotional.toFixed(0)}) — holding, no add`,
    };
  }
  let addQty = acct.sizeFromStop(addPrice, CATASTROPHE_STOP);
  if (
    Number.isFinite(CLUSTER_CAP_MULTIPLIER) &&
    CLUSTER_CAP_MULTIPLIER > 0 &&
    CLUSTER_CAP_MULTIPLIER < 1
  ) {
    addQty *= CLUSTER_CAP_MULTIPLIER;
  }
  const maxAddQtyBySymbolCap = headroomNotional / addPrice;
  const cappedBySymbol = addQty > maxAddQtyBySymbolCap;
  addQty = Math.min(addQty, maxAddQtyBySymbolCap);
  addQty = Math.round(addQty * 1_000_000) / 1_000_000;
  if (addQty <= 0) {
    return { action: 'skip-rounds-to-0', capNotional, currentNotional, reason: 'add rounds to 0 within caps' };
  }
  const updated = acct.addToPosition(pos.id, addQty, addPrice, {
    holdNoTakeProfit: EXIT_MODE === 'hold',
  });
  if (!updated) {
    return { action: 'skip-cash', capNotional, currentNotional, reason: 'addToPosition rejected (cash/invalid)' };
  }
  return {
    action: cappedBySymbol ? 'add-trimmed-to-cap' : 'add',
    capNotional,
    addQty,
    updated,
    reason: cappedBySymbol ? 'add trimmed to per-symbol headroom' : 'full risk-sized add',
  };
}

// ── Open the held DCA position (fill #1) ──────────────────────────────────────
const entrySignal = {
  id: 'tra965-entry',
  symbol: SYMBOL,
  type: 'dca',
  side: 'buy',
  entryPrice: ENTRY_PRICE,
  stopLoss: CATASTROPHE_STOP,
  takeProfit: TAKE_PROFIT,
  riskRewardRatio: 4,
  timestamp: 0,
};
const pos = acct.openPosition(entrySignal, ENTRY_PRICE, 'coinbase');
if (!pos) throw new Error('entry openPosition returned null');
pos.dcaFills = 1;
if (EXIT_MODE === 'hold') pos.dcaHold = true;

const ledger = [];
const origStop = pos.stopLoss;
function snapshot(week, addPrice, res) {
  const notional = pos.quantity * addPrice;
  // The engine rounds addQty to 6 dp (crypto-engine.ts:1518), which can round the
  // trimmed add UP by < 1e-6 BTC and overshoot the cap by a fraction of a cent.
  // Tolerate exactly that 6-dp rounding step (= addPrice × 1e-6) — anything beyond
  // it would be a genuine cap breach.
  const capTol = addPrice * 1e-6;
  const overshoot = Math.max(0, notional - res.capNotional);
  ledger.push({
    week,
    addPrice,
    action: res.action,
    addQty: res.addQty ?? 0,
    totalQty: pos.quantity,
    blendedEntry: pos.entryPrice,
    stopLoss: pos.stopLoss,
    fills: pos.dcaFills ?? 1,
    notional,
    capNotional: res.capNotional,
    overshootUsd: overshoot,
    withinCap: overshoot <= capTol,
    reason: res.reason,
  });
}
// Week 0 = the opening fill.
snapshot(0, ENTRY_PRICE, { action: 'open', capNotional: acct.managedEquity() * MAX_SYMBOL_NOTIONAL_FRAC, reason: 'initial held DCA tranche' });

// ── Weekly accumulation cadence ───────────────────────────────────────────────
for (let i = 0; i < WEEKLY_ADD_PRICES.length; i++) {
  const addPrice = WEEKLY_ADD_PRICES[i];
  // `addToPosition` bumps pos.dcaFills itself (crypto-account.ts:325) — don't double-count here.
  const res = accumulateDca(pos, addPrice);
  snapshot(i + 1, addPrice, res);
}

// ── Hold-mode exit behavior: TP is dropped, only the catastrophe stop exits ────
const tpProbe = acct.checkExits(new Map([[SYMBOL, TAKE_PROFIT + 5_000]]));
const stopProbe = acct.checkExits(new Map([[SYMBOL, CATASTROPHE_STOP - 1_000]]));

// ── Invariants ────────────────────────────────────────────────────────────────
const capBreaches = ledger.filter((l) => !l.withinCap);
const maxOvershootUsd = ledger.reduce((m, l) => Math.max(m, l.overshootUsd), 0);
const stopMoved = ledger.some((l) => l.stopLoss !== origStop);
const adds = ledger.filter((l) => l.action.startsWith('add')).length;
const capReached = ledger.some((l) => l.action === 'hold-at-cap' || l.action === 'add-trimmed-to-cap');
const tpHeld = tpProbe.length === 0; // 'hold' drops the per-leg TP
const stopExits = stopProbe.length === 1; // catastrophe stop is the only auto-exit
const invariantHeld = capBreaches.length === 0 && !stopMoved && tpHeld && stopExits && adds >= 2 && capReached;

const out = {
  generatedFor: 'TRA-965 demo acceptance (offline per-fill evidence)',
  core: '@trading-app/server CryptoPaperAccount; accumulateDca port of crypto-engine.ts:1496-1522 (commit b159ee1)',
  config: { maxSymbolNotionalFracOfManagedEquity: MAX_SYMBOL_NOTIONAL_FRAC, exitMode: EXIT_MODE, clusterCapMultiplier: CLUSTER_CAP_MULTIPLIER },
  totals: {
    rows: ledger.length,
    adds,
    finalTotalQty: pos.quantity,
    finalBlendedEntry: pos.entryPrice,
    finalFills: pos.dcaFills,
    capBreaches: capBreaches.length,
    maxCapOvershootUsd: maxOvershootUsd,
  },
  invariants: {
    notionalNeverExceedsCap: capBreaches.length === 0,
    stopHeldFixed: !stopMoved,
    perLegTpDroppedUnderHold: tpHeld,
    catastropheStopStillExits: stopExits,
    multipleFillsAveragingOneGrowingPosition: adds >= 2,
    perSymbolCapBinds: capReached,
  },
  invariantHeld,
  ledger,
};

const jsonPath = new URL('./tra965-cryptodca-accumulation-evidence.json', import.meta.url);
writeFileSync(jsonPath, JSON.stringify(out, null, 2));

const rows = ledger
  .map(
    (l) =>
      `| ${l.week} | ${l.addPrice} | \`${l.action}\` | ${l.addQty.toFixed(6)} | ${l.totalQty.toFixed(6)} | ${l.blendedEntry.toFixed(2)} | ${l.stopLoss} | ${l.fills} | ${l.notional.toFixed(2)} | ${l.capNotional.toFixed(2)} | ${l.withinCap ? 'Y' : 'N'} | ${l.reason} |`,
  )
  .join('\n');
const md = `# TRA-965 demo acceptance — CryptoDCA accumulation per-fill evidence

Caps (QuantTrader sign-off, commit \`b159ee1\`): \`maxSymbolNotionalFracOfManagedEquity = 0.10\`, \`exitMode = 'hold'\`.
Core: shipped \`CryptoPaperAccount\`; \`accumulateDca\` ported verbatim from \`crypto-engine.ts:1496-1522\`.
Deterministic; regenerate with \`node packages/backtest/reports/tra965-cryptodca-accumulation-evidence.mjs\`.

**Acceptance held: ${invariantHeld ? 'YES' : 'NO'}** — ${adds} averaging adds onto ONE growing position; final blended entry ${pos.entryPrice.toFixed(2)} over ${pos.dcaFills} fills, total qty ${pos.quantity.toFixed(6)}; ${capBreaches.length} cap breaches (max overshoot $${maxOvershootUsd.toFixed(4)}, within the 6-dp qty rounding step).

Invariants: notional ≤ 0.10 cap = **${out.invariants.notionalNeverExceedsCap ? 'PASS' : 'FAIL'}**; stop held fixed (average SIZE never STOP) = **${out.invariants.stopHeldFixed ? 'PASS' : 'FAIL'}**; per-leg TP dropped under hold = **${out.invariants.perLegTpDroppedUnderHold ? 'PASS' : 'FAIL'}**; catastrophe stop still exits = **${out.invariants.catastropheStopStillExits ? 'PASS' : 'FAIL'}**; per-symbol cap binds = **${out.invariants.perSymbolCapBinds ? 'PASS' : 'FAIL'}**.

| week | add price | action | add qty | total qty | blended entry | stop | fills | notional | 0.10 cap | ≤cap | reason |
|---|---|---|---|---|---|---|---|---|---|---|---|
${rows}
`;
const mdPath = new URL('./tra965-cryptodca-accumulation-evidence.md', import.meta.url);
writeFileSync(mdPath, md);

console.log(md);
if (!invariantHeld) {
  console.error('ACCEPTANCE FAILED — see invariants above');
  process.exit(1);
}
