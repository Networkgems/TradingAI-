// TRA-4947 — the HARD GATE. Enumerate, from the LIVE tape on the serving
// commit, every closed live journal row the new `unmeasure` branch would match,
// and refuse to proceed unless it is exactly `34f1ee99`.
//
// Reads the FULL plan off the dry-run route (`?apply` omitted => nothing is
// written), not the `closeBasisSweep.lastRows` projection on
// /api/health/option-journal: that projection carries only 10 keys and does NOT
// carry `exitReason` at all, so `exitReason: null` read there is an ABSENT KEY,
// not a null on the row. The predicate under test is conjunctive on
// `exitReason`, so grading it off the projection would have read 0 matches for
// the right answer and 0 matches for the wrong one.
const HOST = process.env.TRA4947_HOST ?? 'https://tradingai-bqb1.onrender.com';
const user = process.env.TRADING_ADMIN_USERNAME ?? 'admin';
const pass = process.env.TRADING_ADMIN_PASSWORD;
if (!pass) { console.error('BLIND — TRADING_ADMIN_PASSWORD unset'); process.exit(3); }

const ver = await fetch(`${HOST}/api/health/options-live`).then((r) => r.json());
console.log(`# serving commit ${ver.build?.commit} pid ${ver.build?.pid} startedAt ${ver.build?.startedAt}`);
console.log(`# read at ${new Date().toISOString()}`);

const login = await fetch(`${HOST}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass }),
});
const lb = await login.json().catch(() => ({}));
if (!login.ok || !lb.token) {
  console.error(`login ${login.status} — ${JSON.stringify(lb).slice(0, 300)}`);
  process.exit(3);
}

// DRY RUN. `apply` omitted entirely; the route's own guard additionally requires
// confirm=TRA-2819 before it writes anything.
const res = await fetch(`${HOST}/api/health/option-journal/close-basis-repair`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${lb.token}` },
});
const body = await res.json();
console.log(`# POST close-basis-repair (DRY RUN) -> ${res.status}`);
if (!res.ok) { console.error(JSON.stringify(body).slice(0, 600)); process.exit(3); }
console.log(`# applied=${body.applied} (must be false)`);
console.log(`# plan.scanned=${body.plan.scanned} counts=${JSON.stringify(body.plan.counts)}`);
console.log(`# skipsByReason=${JSON.stringify(body.plan.skipsByReason)}`);

const rows = body.plan.rows;
const TARGET = '34f1ee99-0207-4fb6-9884-cca2e5d47fdc';

// The candidate predicate, spelled exactly as the new branch will spell it.
// Deliberately evaluated in four nested widths so the report shows how much of
// the tape each loosening would have swept in.
const isReconcile = (r) => r.exitReason === 'broker_reconcile';
const noOrder = (r) => r.brokerOrderId === null || r.brokerOrderId === undefined;
const unbacked = (r) => r.realizedPnlUsdBefore === 0;
const noBasis = (r) => r.treatment === 'skip'
  && (r.skipReason === 'no_entry_fill_in_window' || r.skipReason === 'fills_claimed_by_sibling');

const widths = [
  ['W1  brokerOrderId===null ALONE                (the 7b2f9b50 defect)', (r) => noOrder(r)],
  ['W2  exitReason===broker_reconcile ALONE', (r) => isReconcile(r)],
  ['W3  CONJUNCTION (TRA-4857 predicate)', (r) => isReconcile(r) && noOrder(r)],
  ['W4  + no establishable broker basis', (r) => isReconcile(r) && noOrder(r) && noBasis(r)],
  ['W5  + existing number is itself unbacked (0)  <= THE SHIPPED BRANCH', (r) => isReconcile(r) && noOrder(r) && noBasis(r) && unbacked(r)],
];
console.log(`\n# population widths over ${rows.length} planned live closed rows`);
for (const [label, p] of widths) {
  const m = rows.filter(p);
  console.log(`${String(m.length).padStart(3)}  ${label}`);
  for (const r of m) console.log(`        ${r.id}  ${r.optionSymbol}  before=${r.realizedPnlUsdBefore}  exitReason=${r.exitReason}  brokerOrderId=${JSON.stringify(r.brokerOrderId)}  skip=${r.skipReason}`);
}

const matched = rows.filter(widths[widths.length - 1][1]);
console.log('\n# per-row exitReason / brokerOrderId census (all planned rows)');
for (const r of rows) {
  console.log(`  ${r.id.slice(0, 8)} ${String(r.optionSymbol).padEnd(22)} treat=${String(r.treatment).padEnd(7)} skip=${String(r.skipReason)} exitReason=${JSON.stringify(r.exitReason)} brokerOrderId=${JSON.stringify(r.brokerOrderId)} before=${r.realizedPnlUsdBefore}`);
}

const ok = matched.length === 1 && matched[0].id === TARGET;
console.log(`\n# GATE ${ok ? 'PASS' : 'FAIL'} — matched ${matched.length} row(s); require exactly 1 == ${TARGET}`);
process.exit(ok ? 0 : 1);
