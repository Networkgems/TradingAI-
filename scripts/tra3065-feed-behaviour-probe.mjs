// TRA-3065 — which feed behaviour do we actually observe: (a) UNADJUSTED prev
// close across a corporate action, or (b) RETROACTIVELY ADJUSTED?
//
// ⛔ Run `pnpm --filter @trading-app/shared build` FIRST (imports built bytes).
//
// ── WHY THE ARCHIVE CAN ANSWER THIS ───────────────────────────────────────────
//
// The continuity residual is `max(priorClose/impliedPrev, impliedPrev/priorClose)`
// and `impliedPrevClose(today)` RECOVERS THE FEED'S OWN `prevClose` exactly (it
// inverts the same arithmetic `yahoo-feed.ts:1490-1494` used to build the row).
// So the residual is not a statement about the move at all — it measures ONE
// thing:
//
//     residual != 1  <=>  the feed's prevClose today != the close WE published
//                         for the prior session.
//
// That gives a clean separator the two branches cannot both satisfy:
//
//   (a) UNADJUSTED  feed prevClose == our published prior close  => residual = 1
//                   ...and the PRICE moved by the action factor.
//   (b) ADJUSTED    feed prevClose == priorClose / k             => residual = k
//                   ...i.e. an offender whose price ALSO moved materially.
//
// The frozen-price class (FGMC, FLYYQ) is a THIRD population and must not be
// read as (b): there the price did not move and the denominator did, which is a
// stale/republished quote, not a corporate action. So:
//
//   Evidence for (b) = an offender (residual >= tolerance) whose PRICE MOVED.
//   Evidence for (a) = a large session-clean move whose residual is ~exactly 1
//                      at a price ratio near a common action factor.
//
// This script partitions every offender in the archive on exactly that axis and
// prints the full per-symbol series for any symbol named on the command line, so
// a candidate can be read as a series rather than as one pair.
//
// Usage:
//   HOST=https://tradingai-bqb1.onrender.com node scripts/tra3065-feed-behaviour-probe.mjs UPC JEM
import {
  assessQuotePlausibility,
  assessLevelContinuity,
  CONTINUITY_RESIDUAL_TOLERANCE,
} from '../packages/shared/dist/index.js';

const HOST = process.env.HOST ?? 'https://tradingai-bqb1.onrender.com';
const FOLDS = ['demo', 'live', 'sandbox'];
const DAYS = Number(process.env.DAYS ?? 120);
const ANCHOR = process.env.ANCHOR ?? '2026-08-06';
const TRACE = process.argv.slice(2).map(s => s.toUpperCase());
/** Relative price move above which "the price moved" is not rounding. */
const PRICE_MOVED_EPS = 0.005;

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
  const [y, m, dd] = d.split('-').map(Number);
  let t = Date.UTC(y, m - 1, dd);
  for (let i = 0; i < maxLookbackDays; i++) {
    t -= 86400000;
    const iso = new Date(t).toISOString().slice(0, 10);
    if (isMarketDayIso(iso)) return iso;
  }
  return null;
}

const user = process.env.ADMIN_USERNAME ?? process.env.TRADING_ADMIN_USERNAME ?? 'admin';
const pass = process.env.ADMIN_PASSWORD ?? process.env.TRADING_ADMIN_PASSWORD;
const login = await fetch(`${HOST}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass }),
});
if (!login.ok) { console.error(`login ${login.status} — BLIND (a HOLD, not a pass)`); process.exit(3); }
const H = { Authorization: `Bearer ${(await login.json()).token}` };

const dates = [];
const base = new Date(`${ANCHOR}T12:00:00Z`).getTime();
for (let i = 0; i < DAYS; i++) dates.push(new Date(base - i * 86400000).toISOString().slice(0, 10));

const tables = new Map();
let unreadable = 0;
for (const fold of FOLDS) {
  const byDate = new Map();
  for (const date of dates) {
    const r = await fetch(`${HOST}/api/reports/${date}?mode=${fold}`, { headers: H });
    if (r.status === 404) continue;
    const text = await r.text();
    if (!r.ok) { unreadable++; continue; }
    let rep; try { rep = JSON.parse(text); } catch { unreadable++; continue; }
    const movers = rep?.top5Movers ?? [];
    if (movers.length === 0) continue;
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
      pairs.push({
        fold, date, priorDate: pd, sym, rank: cur.rank, cur, prior: p,
        cont: assessLevelContinuity(p, cur),
        sess: assessQuotePlausibility({ price: cur.price, changePct: cur.changePct }),
      });
    }
  }
}
if (pairs.length === 0) { console.error('no rows — BLIND (a HOLD, not a pass)'); process.exit(3); }

console.log(`TRA-3065 — feed-behaviour probe, HOST=${HOST} ANCHOR=${ANCHOR} DAYS=${DAYS}`);
console.log(`  symbol-rows=${pairs.length} unreadable=${unreadable}`);
console.log('');

// ── Partition every OFFENDER against the case-(b) SIGNATURE.
//
// ⛔ "The price moved" is NOT the (b) test, and an earlier revision of this
// script used it and mislabelled four stale-quote rows as (b) candidates. Under
// (b) the feed restates prevClose to `priorClose / k`, so:
//
//     residual == k EXACTLY (a plausible corporate-action factor), and
//     `changePct` is then the TRUE session move — an ORDINARY number, because
//     the whole premise of (b) is that the arithmetic came out right.
//
// Both legs are required. A row with a big residual AND a fabricated-looking
// headline is the denominator-flip class, not an adjustment: (b) cannot produce
// a +1,102% published move, because under (b) nothing is fabricated.
const COMMON_FACTORS = [
  { label: '5:4', k: 1.25 }, { label: '4:3', k: 4 / 3 }, { label: '3:2', k: 1.5 },
  { label: '5:3', k: 5 / 3 }, { label: '2:1', k: 2 }, { label: '5:2', k: 2.5 },
  { label: '3:1', k: 3 }, { label: '4:1', k: 4 }, { label: '5:1', k: 5 },
  { label: '10:1', k: 10 }, { label: '20:1', k: 20 },
];
const FACTOR_TOL = 0.01;      // 1% around the nominal factor
const ORDINARY_PCT = 50;      // above this, the published headline is not an ordinary session

const offenders = pairs.filter(p => p.cont.verdict === 'suspect');
const priceMoveOf = (p) => {
  if (!p.prior || !Number.isFinite(p.prior.price) || p.prior.price <= 0) return null;
  return Math.abs(p.cur.price / p.prior.price - 1);
};
const classify = (p) => {
  const mv = priceMoveOf(p);
  const res = p.cont.residual;
  const near = res === null ? null
    : COMMON_FACTORS.find(f => Math.abs(res / f.k - 1) <= FACTOR_TOL);
  const ordinary = Number.isFinite(p.cur.changePct) && Math.abs(p.cur.changePct) <= ORDINARY_PCT;

  // ⭐ FROZEN PRICE IS TESTED FIRST, AND IT IS DISPOSITIVE. A corporate action
  // moves the traded price BY the factor — that is what a split IS — so a price
  // that did not move cannot be one under EITHER behaviour. Testing the (b)
  // signature ahead of this let FLYYQ (`0.02 -> 0.02`, the known stale positive
  // control) match "residual ~ 4:3 + ordinary headline" and be labelled a
  // retroactive adjustment, which is precisely backwards.
  if (mv !== null && mv <= PRICE_MOVED_EPS) {
    return { mv, near, cls: 'stale/frozen price — the TRA-2610 denominator-flip class (price did not move: NOT an action)' };
  }
  if (near && ordinary) return { mv, near, cls: `CASE (b) — residual ~ ${near.label} and an ordinary headline` };
  const why = near ? `headline ${p.cur.changePct}% is not an ordinary session` : 'residual matches no common action factor';
  return { mv, near, cls: `neither — ${why}` };
};

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const classed = offenders.map(p => ({ ...p, ...classify(p) }));
console.log(`CONTINUITY OFFENDERS (residual >= ${CONTINUITY_RESIDUAL_TOLERANCE}): ${offenders.length}`);
console.log([pad('  fold', 9), pad('sym', 11), pad('priorDate->date', 24), lpad('prior', 9),
  lpad('price', 9), lpad('pct', 10), lpad('|dPrice|', 10), lpad('residual', 10), '  classification'].join(' '));
console.log('-'.repeat(122));
for (const p of classed.sort((a, b) => (b.cont.residual ?? 0) - (a.cont.residual ?? 0))) {
  console.log([pad('  ' + p.fold, 9), pad(p.sym, 11), pad(`${p.priorDate}->${p.date}`, 24),
    lpad(p.prior?.price ?? 'n/a', 9), lpad(p.cur.price, 9), lpad(p.cur.changePct, 10),
    lpad(p.mv === null ? 'n/a' : (p.mv * 100).toFixed(2) + '%', 10),
    lpad(p.cont.residual === null ? 'n/a' : p.cont.residual.toFixed(6), 10), '  ' + p.cls].join(' '));
}
const caseB = classed.filter(p => p.cls.startsWith('CASE (b)'));
console.log('');
console.log(`  confirmed CASE (b) rows: ${caseB.length}`);
if (caseB.length === 0) {
  console.log(`  => ZERO observed instances of behaviour (b) in this archive. Every row where the`);
  console.log(`     feed's prevClose disagreed with our published close carries a fabricated-looking`);
  console.log(`     headline, i.e. it is the stale / denominator-flip class TRA-2610 was filed on —`);
  console.log(`     NOT a retroactive adjustment.`);
  console.log(`  ⚠️ This is an empirical zero over an archive containing no confirmed corporate`);
  console.log(`     action of ANY factor, so it is weak evidence against (b) and NOT proof of (a).`);
  console.log(`     The derivation, not this count, is what settles the ticket — see the note on`);
  console.log(`     TRA-3065: the continuity rule has no defensive value in EITHER branch.`);
}

// ── Per-symbol series for anything named on the command line.
for (const sym of TRACE) {
  console.log('');
  console.log(`SERIES — ${sym}`);
  const rows = pairs.filter(p => p.sym === sym)
    .sort((a, b) => (a.fold + a.date).localeCompare(b.fold + b.date));
  if (rows.length === 0) { console.log('  not present in the archive window'); continue; }
  console.log([pad('  fold', 9), pad('date', 12), lpad('price', 10), lpad('changePct', 11),
    lpad('impliedPrev', 12), lpad('sessR', 8), lpad('residual', 11), pad('  continuity', 30), lpad('rank', 5)].join(' '));
  console.log('-'.repeat(112));
  for (const p of rows) {
    console.log([pad('  ' + p.fold, 9), pad(p.date, 12), lpad(p.cur.price, 10),
      lpad(p.cur.changePct, 11),
      lpad(p.cont.impliedPrevClose === null ? 'n/a' : p.cont.impliedPrevClose.toFixed(4), 12),
      lpad(p.sess.ratio === null ? 'n/a' : p.sess.ratio.toFixed(4), 8),
      lpad(p.cont.residual === null ? 'n/a' : p.cont.residual.toFixed(6), 11),
      pad('  ' + p.cont.verdict + (p.cont.reason ? `(${p.cont.reason})` : ''), 30),
      lpad(p.rank, 5)].join(' '));
  }
}
