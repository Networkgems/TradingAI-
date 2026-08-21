// TRA-3911 AC3 — RECONCILE THE AT-RISK BASIS TO ITS OWN FILL TAPE.
//
// `openPremiumAtRiskUsd` is COST BASIS by code (`foldOpenPremiumAtRisk`:
// `premiumPaid × contractsRemaining × 100`), so between fills it must be INERT.
// On 2026-08-20 it was not: admin read $0 on a flat book at 03:07Z, took exactly
// two `buy_to_open` fills totalling $273.00, and then folded $358.00 over two
// rows — $85.00 with no fill behind it — and moved $334 → $358 across a boot.
//
// A bound enforced on a basis that cannot be reconciled to its own fill tape is
// a bound on a NUMBER, not on money. This script names the rows and attributes
// every dollar.
//
// Read-only. Pin read BEFORE and AFTER; a pin move BLINDs the run rather than
// degrading to a FAIL, because the rows would then be a mix of two builds.
// Exit 0 = every dollar attributed · 1 = residual · 3 = blind.
const HOST = 'https://tradingai-bqb1.onrender.com';
const SRV = 'srv-d7mb7rr7uimc73ev0chg';
const KEY = process.env.RENDER_API_KEY;

const blind = m => { console.error(`BLIND — ${m}`); process.exit(3); };
if (!KEY) blind('RENDER_API_KEY unset');

const usd = n => (typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : String(n));

async function pin() {
  const r = await fetch(`${HOST}/api/health/options-live`).then(x => x.json()).catch(() => null);
  const b = r?.build ?? null;
  return b ? { commit: b.commit, pid: b.pid, startedAt: b.startedAt } : null;
}

const before = await pin();
if (!before?.commit) blind('pin unreadable before the probe');
console.log(`# pin BEFORE  commit=${before.commit} pid=${before.pid} startedAt=${before.startedAt}`);

const vars = await fetch(`https://api.render.com/v1/services/${SRV}/env-vars?limit=100`, {
  headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
}).then(r => (r.ok ? r.json() : null)).catch(() => null);
if (!vars) blind('cannot read env vars');
const evRows = vars.map(x => x.envVar ?? x);
const pick = k => evRows.find(v => v.key === k)?.value;
const user = pick('ADMIN_USERNAME') ?? 'admin';
const pass = pick('ADMIN_PASSWORD');
if (!pass) blind('ADMIN_PASSWORD unreadable');

const login = await fetch(`${HOST}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass }),
});
const lb = await login.json().catch(() => ({}));
if (!login.ok || !lb.token) blind(`login ${login.status} — ${JSON.stringify(lb).slice(0, 160)}`);
const AUTH = { Authorization: `Bearer ${lb.token}` };

const getJson = async path => {
  const res = await fetch(`${HOST}${path}`, { headers: AUTH });
  if (!res.ok) return { status: res.status, body: null };
  return { status: res.status, body: await res.json().catch(() => null) };
};

// ---------------------------------------------------------------- the tape
const fee = await fetch(`${HOST}/api/health/live-options-fee-slippage`).then(r => r.json()).catch(() => null);
if (!fee) blind('fee/slippage route unreadable');
const tape = (fee.records ?? []).filter(r => r.mode === 'live');
const exposure = (fee.aggregateExposure ?? []).filter(r => r.liveEntryGateOpen === true);

// ---------------------------------------------------------------- the rows
//
// ⚠ `/api/options/alerts` ALSO publishes `openOptions`, and on this build it
// serves `[]` while the same book's `aggregateExposure` row says `openRows 2`.
// The first draft of this script read it, folded $0.00 against a $0.00 tape, and
// printed **PASS** — a grader whose subject was empty scoring itself clean. The
// authoritative read is `/api/state` → `options.openOptions`, and the
// row-count cross-check below is what makes the difference LOUD instead of
// green (TRA-3884: when the subject reads empty, suspect the READER first).
const state = await getJson('/api/state');
if (state.status !== 200) blind(`/api/state ${state.status}`);
const open = (state.body?.options?.openOptions ?? []).filter(p => (p.mode ?? 'demo') === 'live');

const restate = await getJson('/api/options/basis-restatements');

console.log(`\n# ROUTE SAYS (aggregateExposure, gate-open books)`);
for (const r of exposure) {
  console.log(
    `  ${r.book}  atRisk ${usd(r.openPremiumAtRiskUsd)}  openRows ${r.openRows}  `
    + `unpriced ${r.unpricedOpenRows}  cap ${usd(r.capUsd)}  headroomSigned ${usd(r.headroomSignedUsd)}`,
  );
}

console.log(`\n# THE ROWS THE CAP IS ACTUALLY ENFORCED AGAINST (admin book, mode=live)`);
let fold = 0;
const attributed = [];
for (const p of open) {
  const remaining = p.contractsRemaining ?? p.contracts;
  const rowUsd = Math.round(p.premiumPaid * remaining * 100 * 100) / 100;
  fold += rowUsd;
  // Attribute against the tape: sum of `buy_to_open` premium for this symbol.
  const opens = tape.filter(t => t.optionSymbol === p.optionSymbol && t.side === 'buy_to_open');
  const tapeUsd = Math.round(opens.reduce((a, t) => a + t.filledPrice * t.contracts * 100, 0) * 100) / 100;
  attributed.push({ sym: p.optionSymbol, rowUsd, tapeUsd, opens: opens.length });
  console.log(
    `  ${p.optionSymbol}  premiumPaid ${p.premiumPaid}  contracts ${p.contracts} `
    + `remaining ${remaining}  ⇒ row ${usd(rowUsd)}`,
  );
  console.log(
    `      importedFromTradier=${p.importedFromTradier ?? false}  openedAt=${p.openedAt ?? p.entryTime ?? '?'}  `
    + `id=${p.id}  sleeve=${p.strategy ?? p.source ?? '?'}`,
  );
  console.log(
    `      TAPE buy_to_open for this symbol: ${opens.length} record(s), ${usd(tapeUsd)}`
    + (opens.length ? `  [${opens.map(t => `${t.contracts}@${t.filledPrice} ${t.origin} oid=${t.orderId ?? 'none'}`).join(' · ')}]` : '  ⇒ NO FILL BEHIND THIS ROW'),
  );
}
fold = Math.round(fold * 100) / 100;

// The book this login's engine actually is — `/api/state` is scoped to it, so
// the row we reconcile against must be the SAME book or the whole comparison is
// cross-book. Falls back to the only book carrying premium.
const selfBook = state.body?.username ?? user;
const routeAtRisk = exposure.find(r => r.book === selfBook)?.openPremiumAtRiskUsd
  ?? exposure.find(r => (r.openPremiumAtRiskUsd ?? 0) > 0)?.openPremiumAtRiskUsd ?? null;

console.log(`\n# RECONCILIATION`);
console.log(`  Σ over the rows above          ${usd(fold)}`);
console.log(`  route openPremiumAtRiskUsd     ${usd(routeAtRisk)}`);
const tapeTotal = Math.round(attributed.reduce((a, x) => a + x.tapeUsd, 0) * 100) / 100;
console.log(`  Σ tape buy_to_open (same syms) ${usd(tapeTotal)}`);
const residual = Math.round((fold - tapeTotal) * 100) / 100;
console.log(`  RESIDUAL (row basis − tape)    ${usd(residual)}`);

if (restate.status === 200 && restate.body) {
  // ⚠ `durable.restatements`, NOT a bare array and NOT `restatements` at the
  // root — the first draft guessed both and printed `0`, i.e. "no restatements
  // ever happened", on a log holding six. A key you never confirmed exists is a
  // READER bug, not a finding (TRA-3874).
  const list = restate.body.durable?.restatements
    ?? (Array.isArray(restate.body) ? restate.body : restate.body.restatements ?? []);
  console.log(`\n# BASIS RESTATEMENTS (TRA-3010 durable witness log): ${list.length}`);
  for (const r of list.slice(-10)) {
    console.log(
      `  ${new Date(r.ts).toISOString()}  ${r.optionSymbol}  ${r.contracts}ct  `
      + `premiumPaid ${r.premiumPaidBefore} -> ${r.premiumPaidAfter}  `
      + `brokerCostBasis ${usd(r.brokerCostBasisUsd)}`,
    );
  }
} else {
  console.log(`\n# BASIS RESTATEMENTS — route ${restate.status}`);
}

const after = await pin();
console.log(`\n# pin AFTER   commit=${after?.commit} pid=${after?.pid} startedAt=${after?.startedAt}`);
if (!after || after.commit !== before.commit || after.pid !== before.pid || after.startedAt !== before.startedAt) {
  blind('pin MOVED across the probe — the rows would be a mix of two builds');
}

// ⭐ THE CONTROL ON THE GRADER ITSELF. A fold over ZERO rows reconciles to $0.00
// against a $0.00 tape and reads PASS — which is exactly what the first draft of
// this script did while the route was serving $358.00 over 2 rows. The subject
// must be proven present before its verdict means anything.
if (routeAtRisk === null) blind('no gate-open book published openPremiumAtRiskUsd');
const routeRows = exposure.find(r => (r.openPremiumAtRiskUsd ?? 0) > 0)?.openRows ?? 0;
if (open.length !== routeRows) {
  blind(
    `READER MISMATCH — the route folds ${routeRows} open row(s) but this probe can see `
    + `${open.length}. A reconciliation over rows the grader cannot see is not a reconciliation.`,
  );
}
if (Math.abs(fold - (routeAtRisk ?? 0)) > 0.005) {
  blind(
    `READER MISMATCH — Σ over the rows this probe sees is $${fold.toFixed(2)} but the route enforces `
    + `$${(routeAtRisk ?? 0).toFixed(2)}. These must agree BEFORE any residual is attributed.`,
  );
}

if (Math.abs(residual) <= 0.005) {
  console.log('\nPASS — every dollar of the enforced basis is attributed to a fill on the tape.');
  process.exit(0);
}
console.log(`\nFAIL — ${usd(Math.abs(residual))} of the enforced basis has no fill behind it.`);
process.exit(1);
