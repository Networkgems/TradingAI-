// TRA-2688 (leg 1 of TRA-2654) — WHY `pnpm check:continuity` cannot reach its own
// pre-registered controls any more, measured, and what restores them.
//
// ── The finding ───────────────────────────────────────────────────────────────
//
// `scripts/tra2634-continuity-archive-check.mjs` builds its population from
// `GET /api/reports/:date` -> `top5Movers`. Since TRA-2631 / TRA-3020 ruling A
// that route no longer serves the stored table: `annotateReportProvenance`
// (`packages/server/src/reports/mover-provenance.ts`) FILTERS it at the response
// boundary, dropping every row whose provenance verdict is `suspect`.
//
// The rows it drops are, by construction, implausible movers — which is exactly
// what the continuity checker's KNOWN-BAD controls are made of. So the checker's
// positive controls are being removed from its own input by a correct, unrelated
// fix that shipped after they were pre-registered.
//
//   ⭐ A POSITIVE CONTROL MUST *CONTAIN* WHAT THE INSTRUMENT DETECTS. Here it
//   still does — but a lens between the archive and the instrument takes it out,
//   and the resulting `abstain` is a fact about the LENS, never about the
//   detector or the archive.
//
// ── The remedy, and why it is cheap ───────────────────────────────────────────
//
// Nothing was lost. The same payload carries `moversProvenance.filtered`, the
// suppressed rows verbatim, precisely so a reader can tell a filtered report from
// a clean one. Re-uniting `top5Movers` with `moversProvenance.filtered` rebuilds
// the published table exactly.
//
// This script MEASURES that claim. It is a read-only probe and it deliberately
// does NOT edit the mandated checker — repairing a shared acceptance instrument
// is the CTO's call, and this exists so that call can be made off numbers.
//
// Exit: 0 the reunion reproduces the pre-registered population · 1 it does not ·
//       3 BLIND (nothing readable). ⛔ 3 IS A HOLD, NOT A PASS.
//
// Usage (reads ADMIN_USERNAME / ADMIN_PASSWORD from `<repo>/.env`, same as the
// checker; bqb1 auth is a BEARER TOKEN, not a cookie):
//   node scripts/tra2688-continuity-lens.mjs
//   HOST=http://localhost:4242 node scripts/tra2688-continuity-lens.mjs
//
// ⛔ Run `pnpm --filter @trading-app/shared build` first — this imports the BUILT
// bytes, and a stale-but-present symbol would grade last week's rule.
import fs from 'node:fs';
import { assessLevelContinuity } from '../packages/shared/dist/index.js';

const HOST = process.env.HOST ?? 'https://tradingai-bqb1.onrender.com';
const FOLDS = ['demo', 'live', 'sandbox'];
const DAYS = Number(process.env.DAYS ?? 100);
// Fixed anchor, never `new Date()` — the pre-registration was made against this
// window, and a default window is an argument you did not pass.
const ANCHOR = process.env.ANCHOR ?? '2026-07-30';

// The census the CTO pre-registered on TRA-2688 (AC3), measured on bqb1 on
// 2026-07-30 over this exact window.
const PREREGISTERED = { rows: 515, graded: 34, no_prior_observation: 292, republished_prior_row: 189 };

// AC2 — the six rows that must still come back `suspect`, with their residuals.
const MUST_FIRE = [
  ['TDIC', 1.0250], ['000660.KS', 1.0369], ['ABTC', 1.3021],
  ['FLYYQ', 1.3334], ['VEEE', 1.4483], ['CRNX', 1.9874],
];

const HOLIDAYS = new Set([
  '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26',
  '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
]);
function isMarketDayIso(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || HOLIDAYS.has(d)) return false;
  const [y, m, dd] = d.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
  return dow !== 0 && dow !== 6;
}
function previousMarketDayIso(d, maxLookbackDays = 10) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  let t = Date.parse(`${d}T12:00:00Z`);
  for (let i = 0; i < maxLookbackDays; i++) {
    t -= 86400000;
    const iso = new Date(t).toISOString().slice(0, 10);
    if (isMarketDayIso(iso)) return iso;
  }
  return null;
}

const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
let login;
try {
  login = await fetch(`${HOST}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: env.ADMIN_USERNAME ?? 'admin', password: env.ADMIN_PASSWORD }),
  });
} catch (err) {
  // A connection refusal is BLIND, not a zero. The mandated checker CRASHES here
  // rather than exiting 3, which reads as a tooling bug instead of a HOLD.
  console.error(`cannot reach ${HOST} (${err?.cause?.code ?? err?.message}) — BLIND (this is a HOLD, not a pass)`);
  process.exit(3);
}
if (!login.ok) {
  console.error(`login ${login.status} on ${HOST} — BLIND (this is a HOLD, not a pass)`);
  process.exit(3);
}
const H = { Authorization: `Bearer ${(await login.json()).token}` };

const dates = [];
const base = Date.parse(`${ANCHOR}T12:00:00Z`);
for (let i = 0; i < DAYS; i++) dates.push(new Date(base - i * 86400000).toISOString().slice(0, 10));

// ── Two populations, from ONE fetch: SERVED (what the checker sees today) and
// PUBLISHED (served + `moversProvenance.filtered` — the stored table).
const served = new Map();     // fold -> date -> Map(sym -> row)
const published = new Map();
let unreadable = 0, files = 0, stampedFiles = 0;
let nServed = 0, nFiltered = 0, nPublishedCount = 0;
for (const fold of FOLDS) {
  const byDateS = new Map(), byDateP = new Map();
  for (const date of dates) {
    const r = await fetch(`${HOST}/api/reports/${date}?mode=${fold}`, { headers: H });
    if (r.status === 404) continue;                    // a real negative
    const text = await r.text();
    if (!r.ok) { unreadable++; continue; }             // NOT a zero
    let rep;
    try { rep = JSON.parse(text); } catch { unreadable++; continue; }
    files++;
    const s = rep?.top5Movers ?? [];
    const mp = rep?.moversProvenance;
    // ⚠️ An ABSENT `moversProvenance` means "this report never went through the
    // filter" (the module states it), which is a DIFFERENT fact from "nothing was
    // filtered". Counted separately so a bypassed filter can never masquerade as
    // a clean one.
    const filtered = Array.isArray(mp?.filtered) ? mp.filtered : [];
    if (mp) { stampedFiles++; nPublishedCount += mp.publishedCount ?? 0; }
    nServed += s.length;
    nFiltered += filtered.length;
    const toMap = rows => new Map(rows.map((m, i) => [String(m.symbol).toUpperCase(),
      { price: m.price, changePct: m.changePct, rank: i + 1 }]));
    if (s.length) byDateS.set(date, toMap(s));
    // Reunion. Order does not matter — the detector is keyed by symbol.
    const all = [...s, ...filtered];
    if (all.length) byDateP.set(date, toMap(all));
  }
  served.set(fold, byDateS);
  published.set(fold, byDateP);
}

function census(tables) {
  const out = { rows: 0, graded: 0, suspect: 0, consistent: 0, abstained: 0, reasons: {}, fired: new Map() };
  for (const [fold, byDate] of tables) {
    for (const [date, today] of byDate) {
      const pd = previousMarketDayIso(date);
      const prior = pd === null ? null : byDate.get(pd);
      for (const [sym, cur] of today) {
        const v = assessLevelContinuity(prior?.get(sym) ?? null, cur);
        out.rows++;
        if (v.verdict === 'abstain') {
          out.abstained++;
          out.reasons[v.reason ?? 'unknown'] = (out.reasons[v.reason ?? 'unknown'] ?? 0) + 1;
        } else {
          out.graded++;
          if (v.verdict === 'suspect') {
            out.suspect++;
            const prev = out.fired.get(sym);
            if (!prev) out.fired.set(sym, { fold, date, priorDate: pd, residual: v.residual });
          } else out.consistent++;
        }
      }
    }
  }
  return out;
}

const S = census(served);
const P = census(published);

console.log(`HOST ${HOST}  anchor ${ANCHOR}  window ${DAYS}d  files ${files} (with moversProvenance ${stampedFiles})  unreadable ${unreadable}`);
if (P.rows === 0) {
  console.error('no mover row readable — BLIND (this is a HOLD, not a pass)');
  process.exit(3);
}
console.log('');
console.log('THE LENS, measured:');
console.log(`  rows the route SERVES      ${nServed}`);
console.log(`  rows the filter SUPPRESSES ${nFiltered}   <- these are the checker's known-bads`);
console.log(`  rows the archive PUBLISHED ${nServed + nFiltered}` +
  `   (moversProvenance.publishedCount sum: ${nPublishedCount})`);
console.log('');
const line = (name, c) => `  ${name.padEnd(10)} rows ${String(c.rows).padStart(4)} | GRADED ${String(c.graded).padStart(3)}`
  + ` (suspect ${c.suspect}, consistent ${c.consistent}) | ABSTAINED ${String(c.abstained).padStart(3)} ${JSON.stringify(c.reasons)}`;
console.log('CENSUS:');
console.log(line('SERVED', S));
console.log(line('PUBLISHED', P));
console.log(`  PRE-REGISTERED (TRA-2688 AC3, bqb1 2026-07-30): rows ${PREREGISTERED.rows} | GRADED ${PREREGISTERED.graded}`
  + ` | ABSTAINED ${PREREGISTERED.no_prior_observation + PREREGISTERED.republished_prior_row}`
  + ` {"no_prior_observation":${PREREGISTERED.no_prior_observation},"republished_prior_row":${PREREGISTERED.republished_prior_row}}`);
console.log('');

// ── AC2, both populations. Reported per-population because the WHOLE point is
// that the same detector, on the same archive, answers differently through the
// two lenses.
console.log('AC2 — the six pre-registered positive controls:');
let acFail = 0;
for (const [sym, residual] of MUST_FIRE) {
  const inS = S.fired.get(sym.toUpperCase());
  const inP = P.fired.get(sym.toUpperCase());
  const fmt = h => (h ? `FIRES residual=${Number(h.residual).toFixed(4)} (${h.fold} ${h.priorDate}->${h.date})` : 'NOT VISIBLE');
  const ok = !!inP;
  if (!ok) acFail++;
  console.log(`  ${sym.padEnd(10)} expect ~${residual}  | served: ${fmt(inS).padEnd(52)} | published: ${fmt(inP)}`);
}

const exact = P.rows === PREREGISTERED.rows
  && P.graded === PREREGISTERED.graded
  && (P.reasons['no_prior_observation'] ?? 0) === PREREGISTERED.no_prior_observation
  && (P.reasons['republished_prior_row'] ?? 0) === PREREGISTERED.republished_prior_row;

console.log('');
console.log(exact
  ? 'PASS — the reunited population reproduces the pre-registered census EXACTLY.'
  : 'MISMATCH — the reunited population does NOT reproduce the pre-registered census (see above).');
console.log(acFail === 0
  ? 'PASS — every AC2 control is reachable in the PUBLISHED population.'
  : `FAIL — ${acFail} AC2 control(s) not reachable even after the reunion.`);
process.exit(exact && acFail === 0 ? 0 : 1);
