// TRA-3065 — measure the UNDEFENDED SURFACE in the real stored archive, and hunt
// the case-(a) corporate-action fingerprint.
//
// The companion script (`tra3065-corporate-action-evasion.mjs`) proves what the
// two rules DO with a corporate action. This one asks the other half: how much
// of the archive actually sits in the hole, and is there a real action in it.
//
// ⛔ Run `pnpm --filter @trading-app/shared build` FIRST (imports built bytes).
//
// ── WHAT COUNTS AS "EXPOSED" ──────────────────────────────────────────────────
//
// A row is EXPOSED when it publishes a large headline move that BOTH deployed
// predicates pass. That is the set a sub-2.0 unadjusted corporate action would
// land in and be invisible inside. It is deliberately NOT the set of "bad rows"
// — most of these are genuine moves. The number is the size of the blind spot,
// not a defect count, and it must be read that way.
//
// ⭐ `abstain` is counted SEPARATELY from `consistent` and is NOT treated as
// defended. A row the continuity rule was blind to is not a row it cleared —
// collapsing the two is the exact error the three-valued verdict exists to stop.
//
// ── THE FINGERPRINT ───────────────────────────────────────────────────────────
//
// Under feed behaviour (a) an unadjusted action publishes:
//   priceRatio = priorClose / todayPrice  ~= the action factor k
//   impliedPrevClose(today) == our published prior close  => residual ~= 1
// So a candidate is: continuity `consistent`, and the price ratio within
// FINGERPRINT_TOL of a common split factor. This CANNOT confirm an action on its
// own — a genuine -33% session has the identical arithmetic, which is the whole
// finding — so candidates are printed for hand-checking, never asserted.
import {
  assessQuotePlausibility,
  assessLevelContinuity,
  SUSPECT_MOVE_RATIO,
  CONTINUITY_RESIDUAL_TOLERANCE,
} from '../packages/shared/dist/index.js';

const HOST = process.env.HOST ?? 'https://tradingai-bqb1.onrender.com';
const FOLDS = ['demo', 'live', 'sandbox'];
const DAYS = Number(process.env.DAYS ?? 120);
// Fixed anchor, passed in — never `new Date()`. "No data" from a window in the
// future is a fact about the window, not about the archive.
const ANCHOR = process.env.ANCHOR ?? '2026-08-06';
/** Headline size at which a fabricated row would actually reach a reader (top5Movers sorts on |changePct|). */
const EXPOSED_PCT = Number(process.env.EXPOSED_PCT ?? 15);
const FINGERPRINT_TOL = 0.01;   // 1% around the nominal factor

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
  const [y, m, dd] = d.split('-').map(Number);
  let t = Date.UTC(y, m - 1, dd);
  for (let i = 0; i < maxLookbackDays; i++) {
    t -= 86400000;
    const iso = new Date(t).toISOString().slice(0, 10);
    if (isMarketDayIso(iso)) return iso;
  }
  return null;
}

/** Common corporate-action factors, as price ratios prior/today. */
const FACTORS = [
  { label: '5:4', k: 1.25 }, { label: '4:3', k: 4 / 3 }, { label: '3:2', k: 1.5 },
  { label: '5:3', k: 5 / 3 }, { label: '2:1', k: 2 }, { label: '3:1', k: 3 },
  { label: '4:5 rev', k: 0.8 }, { label: '3:4 rev', k: 0.75 }, { label: '2:3 rev', k: 2 / 3 },
  { label: '1:2 rev', k: 0.5 }, { label: '1:3 rev', k: 1 / 3 },
];

const user = process.env.ADMIN_USERNAME ?? process.env.TRADING_ADMIN_USERNAME ?? 'admin';
const pass = process.env.ADMIN_PASSWORD ?? process.env.TRADING_ADMIN_PASSWORD;
const login = await fetch(`${HOST}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass }),
});
if (!login.ok) {
  console.error(`login ${login.status} on ${HOST} — BLIND (a HOLD, not a pass)`);
  process.exit(3);
}
const H = { Authorization: `Bearer ${(await login.json()).token}` };

const dates = [];
const base = new Date(`${ANCHOR}T12:00:00Z`).getTime();
for (let i = 0; i < DAYS; i++) dates.push(new Date(base - i * 86400000).toISOString().slice(0, 10));

let unreadable = 0, reports = 0;
const tables = new Map();
for (const fold of FOLDS) {
  const byDate = new Map();
  for (const date of dates) {
    const r = await fetch(`${HOST}/api/reports/${date}?mode=${fold}`, { headers: H });
    if (r.status === 404) continue;
    const text = await r.text();
    if (!r.ok) { unreadable++; continue; }
    let rep;
    try { rep = JSON.parse(text); } catch { unreadable++; continue; }
    const movers = rep?.top5Movers ?? [];
    if (movers.length === 0) continue;
    reports++;
    byDate.set(date, new Map(movers.map((m, i) => [String(m.symbol).toUpperCase(),
      { price: m.price, changePct: m.changePct, rank: i + 1 }])));
  }
  tables.set(fold, byDate);
}

const pairs = [];
for (const [fold, byDate] of tables) {
  for (const [date, today] of byDate) {
    const pd = previousMarketDayIso(date);
    const prior = pd === null ? null : byDate.get(pd);
    for (const [sym, cur] of today) {
      const p = prior?.get(sym) ?? null;
      const cont = assessLevelContinuity(p, cur);
      const sess = assessQuotePlausibility({ price: cur.price, changePct: cur.changePct });
      pairs.push({ fold, date, priorDate: pd, sym, rank: cur.rank, cur, prior: p, cont, sess });
    }
  }
}

if (pairs.length === 0) {
  console.error(`no rows over ${DAYS}d on ${HOST} (reports=${reports}, unreadable=${unreadable})`
    + ` — BLIND (a HOLD, not a pass)`);
  process.exit(3);
}

console.log(`TRA-3065 — archive exposure, HOST=${HOST} ANCHOR=${ANCHOR} DAYS=${DAYS}`);
console.log(`  reports=${reports} unreadable=${unreadable} symbol-rows=${pairs.length}`);
console.log(`  thresholds: SUSPECT_MOVE_RATIO=${SUSPECT_MOVE_RATIO}`
  + ` CONTINUITY_RESIDUAL_TOLERANCE=${CONTINUITY_RESIDUAL_TOLERANCE} EXPOSED_PCT=${EXPOSED_PCT}`);
console.log('');

// ── The undefended surface.
const big = pairs.filter(p => Number.isFinite(p.cur.changePct) && Math.abs(p.cur.changePct) >= EXPOSED_PCT);
const bySess = big.filter(p => !p.sess.suspect);
const exposedConsistent = bySess.filter(p => p.cont.verdict === 'consistent');
const exposedAbstain = bySess.filter(p => p.cont.verdict === 'abstain');
const caught = big.filter(p => p.sess.suspect || p.cont.verdict === 'suspect');

console.log(`UNDEFENDED SURFACE — rows publishing |changePct| >= ${EXPOSED_PCT}%:`);
console.log(`  total                            ${big.length}`);
console.log(`  caught by either rule            ${caught.length}`);
console.log(`  passed session rule              ${bySess.length}`);
console.log(`    -> continuity 'consistent'     ${exposedConsistent.length}   (graded clean; a sub-2.0 action here is INVISIBLE)`);
console.log(`    -> continuity 'abstain'        ${exposedAbstain.length}   (NOT defended — the rule was blind)`);
const abstainWhy = new Map();
for (const p of exposedAbstain) abstainWhy.set(p.cont.reason, (abstainWhy.get(p.cont.reason) ?? 0) + 1);
if (abstainWhy.size) console.log(`       abstain reasons: ${[...abstainWhy].map(([k, v]) => `${k}=${v}`).join(' ')}`);
console.log('');

// ── The fingerprint hunt.
const cands = [];
for (const p of bySess) {
  if (!p.prior || !Number.isFinite(p.prior.price) || p.prior.price <= 0) continue;
  if (!Number.isFinite(p.cur.price) || p.cur.price <= 0) continue;
  if (p.cont.verdict !== 'consistent') continue;       // (a)'s signature is residual ~= 1
  const priceRatio = p.prior.price / p.cur.price;
  for (const f of FACTORS) {
    if (Math.abs(priceRatio / f.k - 1) <= FINGERPRINT_TOL) {
      cands.push({ ...p, priceRatio, factor: f.label, k: f.k });
      break;
    }
  }
}
console.log(`CASE-(a) FINGERPRINT CANDIDATES (continuity 'consistent', session-clean,`);
console.log(`price ratio within ${(FINGERPRINT_TOL * 100).toFixed(0)}% of a common action factor): ${cands.length}`);
console.log(`  ⚠️ A genuine session move has the IDENTICAL arithmetic. These are candidates for`);
console.log(`  hand-checking against a corporate-action calendar, never a confirmed action.`);
if (cands.length) {
  console.log('');
  const pad = (s, n) => String(s).padEnd(n);
  const lpad = (s, n) => String(s).padStart(n);
  console.log([pad('  fold', 10), pad('sym', 12), pad('priorDate->date', 24), lpad('prior', 10),
    lpad('price', 10), lpad('pct', 10), lpad('ratio', 9), pad('  ~factor', 10), lpad('rank', 5)].join(' '));
  console.log('-'.repeat(108));
  for (const c of cands.sort((a, b) => Math.abs(b.cur.changePct) - Math.abs(a.cur.changePct))) {
    console.log([pad('  ' + c.fold, 10), pad(c.sym, 12), pad(`${c.priorDate}->${c.date}`, 24),
      lpad(c.prior.price, 10), lpad(c.cur.price, 10), lpad(c.cur.changePct, 10),
      lpad(c.priceRatio.toFixed(4), 9), pad('  ' + c.factor, 10), lpad(c.rank, 5)].join(' '));
  }
}

// ── The worst exposed rows, so the surface has faces and not just a count.
console.log('');
console.log(`LARGEST EXPOSED HEADLINES (both rules clean or blind), top 15 by |changePct|:`);
const pad2 = (s, n) => String(s).padEnd(n);
const lpad2 = (s, n) => String(s).padStart(n);
console.log([pad2('  fold', 10), pad2('sym', 12), pad2('date', 12), lpad2('price', 10),
  lpad2('pct', 11), lpad2('sessR', 9), pad2('  continuity', 26), lpad2('rank', 5)].join(' '));
console.log('-'.repeat(102));
for (const p of bySess.sort((a, b) => Math.abs(b.cur.changePct) - Math.abs(a.cur.changePct)).slice(0, 15)) {
  console.log([pad2('  ' + p.fold, 10), pad2(p.sym, 12), pad2(p.date, 12), lpad2(p.cur.price, 10),
    lpad2(p.cur.changePct, 11), lpad2(p.sess.ratio === null ? 'n/a' : p.sess.ratio.toFixed(4), 9),
    pad2('  ' + p.cont.verdict + (p.cont.reason ? `(${p.cont.reason})` : ''), 26),
    lpad2(p.rank, 5)].join(' '));
}

// ── Threshold sensitivity: the false-positive cost of lowering the bar.
//
// TRA-3065 forbids proposing a lower SUSPECT_MOVE_RATIO without measuring this
// first. The cost is the count of rows the lower bar newly condemns — and since
// the archive holds no confirmed corporate action, EVERY newly-condemned row is
// a candidate false positive until shown otherwise. Printed as a curve rather
// than one number so the shape of the population is visible, not just a verdict.
console.log('');
console.log(`THRESHOLD SENSITIVITY — what lowering SUSPECT_MOVE_RATIO would newly condemn.`);
console.log(`Population: all ${pairs.length} symbol-rows. "newly flagged" is relative to the`);
console.log(`deployed bar of ${SUSPECT_MOVE_RATIO}. The archive contains NO confirmed corporate action,`);
console.log(`so every newly-flagged row is a candidate FALSE POSITIVE.`);
console.log('');
const ratios = pairs
  .map(p => assessQuotePlausibility({ price: p.cur.price, changePct: p.cur.changePct }).ratio)
  .filter(r => r !== null && Number.isFinite(r));
const deployedFlagged = ratios.filter(r => r >= SUSPECT_MOVE_RATIO).length;
const padT = (s, n) => String(s).padEnd(n);
const lpadT = (s, n) => String(s).padStart(n);
console.log([padT('  candidate R', 15), lpadT('flagged', 9), lpadT('newly', 8),
  lpadT('% of rows', 11), '  reaches action factor'].join(' '));
console.log('-'.repeat(70));
for (const R of [2.0, 1.9, 1.75, 1.6, 1.5, 1.4, 1.3333, 1.25, 1.2]) {
  const f = ratios.filter(r => r >= R).length;
  console.log([padT('  ' + R.toFixed(4), 15), lpadT(f, 9), lpadT(f - deployedFlagged, 8),
    lpadT(((f / ratios.length) * 100).toFixed(1) + '%', 11),
    '  ' + (R <= 1.25 ? '5:4 and coarser' : R <= 4 / 3 ? '4:3 and coarser'
      : R <= 1.5 ? '3:2 and coarser' : R <= 2 ? '2:1 and coarser' : '2:1 only')].join(' '));
}
console.log('');
console.log(`⛔ Note what this curve CANNOT do: a lower bar reaches a 3:2 action only when the`);
console.log(`   ex-date economics are flat. The evasion grid shows the session ratio is`);
console.log(`   max((1+m)/k, k/(1+m)) — a function of the genuine move too — so no value of R`);
console.log(`   closes the class, it only trades blind spot for false positives.`);

console.log('');
console.log(`Exit 0 = measured. This script asserts NOTHING about whether an action occurred;`);
console.log(`it sizes the blind spot and lists what would hide in it.`);
