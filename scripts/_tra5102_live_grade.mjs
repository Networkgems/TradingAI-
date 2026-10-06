// TRA-5102 — grade the OPEN-row reconstruction contract off the live host.
//
// Contract (commit 2517d3b8): every open chandelier row either
//   (a) recomposes chandelierStop from its own live peakUnderlying + basis
//       inputs exactly (chandelierStopBasis present, matching), or
//   (b) carries chandelierStopNonReconstructionReason, with the basis beside a
//       `ratchet_held_prior_level` reconstructing to full precision.
// A row with a stop but neither basis-match nor reason has NOT yet been
// touched by a post-deploy maintenance pass (needs spot+ATR served) — that is
// PENDING_POPULATION, not a FAIL: nothing backfills, the pass stamps it.
//
// Credentials: Render env API GET only (never PUT — TRA-2136).
const HOST = 'https://tradingai-bqb1.onrender.com';
const SRV = 'srv-d7mb7rr7uimc73ev0chg';
const KEY = process.env.RENDER_API_KEY;
if (!KEY) { console.error('BLIND — RENDER_API_KEY unset'); process.exit(3); }

const vars = await fetch(`https://api.render.com/v1/services/${SRV}/env-vars?limit=100`, {
  headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
}).then(r => (r.ok ? r.json() : null)).catch(() => null);
if (!vars) { console.error('BLIND — cannot read env vars'); process.exit(3); }
const rows = vars.map(x => x.envVar || x);
const pick = k => rows.find(v => v.key === k)?.value;
const user = pick('ADMIN_USERNAME') ?? 'admin';
const pass = pick('ADMIN_PASSWORD');
if (!pass) { console.error('BLIND — ADMIN_PASSWORD unreadable'); process.exit(3); }

const ver = await fetch(`${HOST}/api/health/version`).then(r => r.json());
console.log(`# live commit ${ver.commit} pid ${ver.pid ?? '?'} startedAt ${ver.startedAt}`);

const login = await fetch(`${HOST}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass }),
});
const lb = await login.json().catch(() => ({}));
if (!login.ok || !lb.token) {
  console.error(`login ${login.status} — ${JSON.stringify(lb).slice(0, 200)}`);
  process.exit(3);
}

const sres = await fetch(`${HOST}/api/state`, {
  headers: { Authorization: `Bearer ${lb.token}`, Accept: 'application/json' },
});
const stext = await sres.text();
console.log(`# GET /api/state -> ${sres.status} ${sres.headers.get('content-type')}`);
let state;
try { state = JSON.parse(stext); } catch {
  console.error(`# non-JSON body (first 200): ${stext.slice(0, 200)}`);
  process.exit(3);
}
const open = state?.options?.openOptions ?? state?.openOptions ?? [];
// ⛔ WRONG-DENOMINATOR GUARD (2026-10-06). `/api/state` is viewMode-SCOPED:
// it renders the DASHBOARD's book (`viewMode` override, else routing mode),
// not "the open options". On 10-06 admin read `viewMode: "demo"` while the
// engine routed LIVE — this script printed `open options 0` over a live book
// holding a ratcheting row, a vacuous pass. `hiddenBookExposure` (TRA-4502)
// names the other book's row count; a non-empty hidden book over an empty
// shown book means the denominator is WRONG, not quiet. To read the hidden
// book: PUT /api/account/view-mode {"viewMode":"live"}, GET, restore —
// display-only (TRA-3910, routing untouched), restore in a finally.
const hidden = state?.hiddenBookExposure;
if (open.length === 0 && hidden != null && (hidden.openOptionRows ?? 0) > 0) {
  console.error(`# WRONG DENOMINATOR — shown book (${hidden.shownBook}) is empty but hidden book (${hidden.book}) holds ${hidden.openOptionRows} open row(s). Flip viewMode and re-run; a 0-row read here is NOT a pass.`);
  process.exit(2);
}
const trailRows = open.filter(o => o.chandelierStop !== undefined);
console.log(`# open options ${open.length}, with chandelierStop ${trailRows.length}`);

let pass_ = 0, held = 0, predates = 0, pending = 0, fail = 0;
for (const o of trailRows) {
  const b = o.chandelierStopBasis;
  const reason = o.chandelierStopNonReconstructionReason;
  const side = o.optionType === 'call' ? 'buy' : 'sell';
  const basisRecon = b === undefined ? null
    : (side === 'buy' ? b.peakUnderlying - b.atrMult * b.atr : b.peakUnderlying + b.atrMult * b.atr);
  const basisExact = basisRecon !== null && basisRecon === o.chandelierStop;
  let verdict;
  if (reason === 'ratchet_held_prior_level') {
    verdict = basisExact ? (held++, 'HELD+BASIS_EXACT') : (fail++, 'FAIL basis does not recompose');
  } else if (reason === 'stop_predates_basis_stamp') {
    verdict = b === undefined ? (predates++, 'PREDATES (no basis, as contracted)') : (fail++, 'FAIL reason says no basis but basis present');
  } else if (b !== undefined) {
    verdict = basisExact ? (pass_++, 'RECONSTRUCTS') : (fail++, 'FAIL basis present+stale with NO reason');
  } else {
    verdict = (pending++, 'PENDING_POPULATION (no pass since deploy)');
  }
  console.log(`${(o.symbol ?? '?').padEnd(6)} stop ${o.chandelierStop} peak ${o.peakUnderlying} basis ${b ? JSON.stringify(b) : 'absent'} reason ${reason ?? 'none'} -> ${verdict}`);
}
console.log(`# verdicts: reconstructs ${pass_}, held+exact ${held}, predates ${predates}, pending ${pending}, FAIL ${fail}`);
process.exit(fail > 0 ? 1 : 0);
