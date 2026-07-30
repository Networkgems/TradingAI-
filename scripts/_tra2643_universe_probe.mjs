// TRA-2643 — is `^VIX` actually IN the fetchQuotes universe?
//
// The ticket's motivating example is "the budget-exhausted tick dropped ^VIX".
// But `readVix()` in market-review.ts calls `fetchQuote(VIX_SYMBOL)` (SINGULAR),
// which has no secondary fan-out and no `FEED_FANOUT_BUDGET_MS` deadline. The
// only path the 8s ceiling truncates is `fetchQuotes(getActiveSymbols())`.
//
// So before designing a priority tier for "index/risk inputs" I have to read
// whether ^VIX is in that array at all. `GET /api/state` returns
// `engine.getState().symbols`, which is built by `applyQuotes(quotes,
// activeSymbols)` — i.e. one row per active symbol, in universe order.
//
// Exit 3 = BLIND (never report a zero from an unreadable read).
const HOST = process.env.BQB1_HOST ?? 'https://tradingai-bqb1.onrender.com';
const USER = process.env.TRADING_ADMIN_USERNAME ?? 'admin';
const PASS = process.env.TRADING_ADMIN_PASSWORD;
if (!PASS) { console.error('no TRADING_ADMIN_PASSWORD — BLIND, HOLD'); process.exit(3); }

// bqb1 auth is a BEARER token off POST /api/auth/login — a cookie jar logs in
// 200 and then 401s on every subsequent route.
const login = await fetch(`${HOST}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
});
if (!login.ok) { console.error(`login ${login.status} — BLIND, HOLD`); process.exit(3); }
const H = { Authorization: `Bearer ${(await login.json()).token}` };

const r = await fetch(`${HOST}/api/state`, { headers: H });
if (!r.ok) { console.error(`/api/state ${r.status} — BLIND, HOLD`); process.exit(3); }
const state = await r.json();
const rows = state.symbols ?? null;
if (!Array.isArray(rows)) { console.error('state.symbols not an array — BLIND, HOLD'); process.exit(3); }

const syms = rows.map(s => s.symbol);
console.log(`universe size (state.symbols) = ${syms.length}`);
console.log(`first 30  : ${syms.slice(0, 30).join(' ')}`);
console.log(`last  30  : ${syms.slice(-30).join(' ')}`);

// Positive control FIRST: a token I know must be present. If AAPL is missing
// the read is wrong and an absent ^VIX proves nothing.
for (const probe of ['AAPL', 'SPY', '^VIX', 'VIX', '^GSPC', '^TNX', 'USO', 'XOM', 'CVX', 'OXY', 'XLE']) {
  const i = syms.indexOf(probe);
  console.log(`  ${probe.padEnd(7)} -> ${i < 0 ? 'ABSENT' : `index ${i} (of ${syms.length})`}`);
}

// Where do the open-position underlyings sit? getActiveSymbols() appends them
// LAST, after the whole discovery tail — i.e. first to be truncated.
const openEq = (state.account?.openPositions ?? []).map(p => p.symbol);
const openOpt = (state.options?.openOptions ?? []).map(o => o.symbol);
const held = [...new Set([...openEq, ...openOpt])];
console.log(`\nheld underlyings (${held.length}): ${held.join(' ') || '(none)'}`);
for (const h of held) {
  const i = syms.indexOf(h);
  console.log(`  ${h.padEnd(7)} -> ${i < 0 ? 'ABSENT' : `index ${i}`}${i >= 200 ? '   <-- BEYOND THE 200 CEILING' : ''}`);
}
console.log(`\nceiling = 200; symbols at index >= 200: ${Math.max(0, syms.length - 200)}`);
