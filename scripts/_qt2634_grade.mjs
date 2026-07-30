// TRA-2634 — QuantTrader's INDEPENDENT grade of the shipped level-continuity
// detector. Deliberately NOT a re-run of scripts/tra2634-continuity-archive-check.mjs:
// that script's control sets are the author's own, so re-running it grades the
// grader's agreement with itself. This one asks four questions the author's
// checker does not:
//
//   Q1  Is FGMC 07-28 GENUINELY the symbol's first appearance in the archive?
//       The whole "blind to day 1 by construction" scope claim rests on it. If
//       FGMC appears on 07-27 anywhere, the abstain is a MISS, not a limit.
//   Q2  Run MY OWN filed predicate ("price identical AND changePct materially
//       different") over the same archive and count what it condemns that the
//       shipped residual form passes — i.e. measure the correction the author
//       made to my spec, from my side, instead of taking the argument on trust.
//   Q3  Does the shipped instrument reach a row that MATTERS — #1 in a table a
//       human reads — or only low ranks? The ticket's complaint was about #1.
//   Q4  The mirror of Q2: does my predicate catch anything the residual form
//       MISSES? If yes, the correction lost coverage and must be said out loud.
//
// Reads the archive over HTTP the same way (bearer token, per-fold), caches it,
// and executes the DEPLOYED built bytes from packages/shared/dist.
import fs from 'node:fs';
import path from 'node:path';
import {
  assessQuotePlausibility,
  assessLevelContinuity,
  CONTINUITY_RESIDUAL_TOLERANCE,
  SUSPECT_MOVE_RATIO,
} from '../packages/shared/dist/index.js';

const HOST = process.env.HOST ?? 'http://localhost:4242';
const FOLDS = ['demo', 'live', 'sandbox'];
const DAYS = Number(process.env.DAYS ?? 100);
const ANCHOR = process.env.ANCHOR ?? '2026-07-30';
const CACHE = process.env.CACHE ?? null;

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
function previousMarketDayIso(d) {
  const [y, m, dd] = d.split('-').map(Number);
  let t = Date.UTC(y, m - 1, dd);
  for (let i = 0; i < 10; i++) {
    t -= 86400000;
    const iso = new Date(t).toISOString().slice(0, 10);
    if (isMarketDayIso(iso)) return iso;
  }
  return null;
}

// ── Fetch (or reuse a cache from a prior run of this script).
let raw;
if (CACHE && fs.existsSync(CACHE)) {
  raw = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  console.log(`(cache ${CACHE})`);
} else {
  const env = Object.fromEntries(
    fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)
      .filter(l => l.includes('=') && !l.startsWith('#'))
      .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  );
  const login = await fetch(`${HOST}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: env.ADMIN_USERNAME ?? 'admin', password: env.ADMIN_PASSWORD }),
  });
  if (!login.ok) { console.error(`login ${login.status} on ${HOST} — BLIND, this is a HOLD`); process.exit(3); }
  const H = { Authorization: `Bearer ${(await login.json()).token}` };
  const dates = [];
  const base = new Date(`${ANCHOR}T12:00:00Z`).getTime();
  for (let i = 0; i < DAYS; i++) dates.push(new Date(base - i * 86400000).toISOString().slice(0, 10));
  raw = { host: HOST, anchor: ANCHOR, unreadable: 0, folds: {} };
  for (const fold of FOLDS) {
    raw.folds[fold] = {};
    for (const date of dates) {
      const r = await fetch(`${HOST}/api/reports/${date}?mode=${fold}`, { headers: H });
      if (r.status === 404) continue;
      const text = await r.text();
      if (!r.ok) { raw.unreadable++; continue; }
      let rep; try { rep = JSON.parse(text); } catch { raw.unreadable++; continue; }
      const movers = rep?.top5Movers ?? [];
      if (movers.length === 0) continue;
      raw.folds[fold][date] = movers.map((m, i) => ({
        symbol: String(m.symbol).toUpperCase(), price: m.price, changePct: m.changePct, rank: i + 1,
      }));
    }
  }
  if (CACHE) { fs.mkdirSync(path.dirname(CACHE), { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(raw)); }
}
// ⛔ A zero row count is a fact about the FETCH, never about the archive.
const totalRows = Object.values(raw.folds).flatMap(d => Object.values(d)).flat().length;
if (totalRows === 0) { console.error(`0 rows read from ${HOST} — BLIND, this is a HOLD`); process.exit(3); }
console.log(`HOST ${raw.host}  anchor ${raw.anchor}  rows ${totalRows}  unreadable ${raw.unreadable}`);

// ── Q1: FGMC's complete appearance history, every fold, every date.
console.log(`\n== Q1  every archived appearance of the ticket's headline symbol ==`);
for (const sym of ['FGMC', 'FLYYQ']) {
  const hits = [];
  for (const [fold, byDate] of Object.entries(raw.folds)) {
    for (const [date, rows] of Object.entries(byDate)) {
      for (const r of rows) if (r.symbol === sym) hits.push({ fold, date, ...r });
    }
  }
  hits.sort((a, b) => a.date.localeCompare(b.date) || a.fold.localeCompare(b.fold));
  console.log(`  ${sym}: ${hits.length} appearance(s)` + (hits.length ? '' : ' — ABSENT on this box'));
  for (const h of hits) console.log(`    ${h.date}  ${h.fold}\t#${h.rank}\t${h.price} / ${h.changePct}%`);
  if (hits.length) {
    const first = hits[0];
    const pd = previousMarketDayIso(first.date);
    const priorHas = (raw.folds[first.fold][pd] ?? []).some(r => r.symbol === sym);
    console.log(`    -> first appearance ${first.date} (${first.fold}); prior market day ${pd}`
      + ` contains ${sym}? ${priorHas ? 'YES — the abstain would be a MISS' : 'NO — no prior observation exists'}`);
  }
}

// ── Build every adjacent-session pair and run BOTH predicates on it.
// MY filed predicate, verbatim from the ticket:
//   "fire on `price identical AND changePct materially different`"
// "materially different" is not a number in the ticket, so grade it at the two
// readings that bracket any honest one: 0.01pp (any published difference at all)
// and 1.00pp (a full point).
function qtPredicate(prior, cur, materialPp) {
  if (!prior) return null;                       // no prior => not expressible either
  if (prior.price !== cur.price) return false;
  if (typeof prior.changePct !== 'number' || typeof cur.changePct !== 'number') return null;
  return Math.abs(cur.changePct - prior.changePct) > materialPp;
}

const pairs = [];
for (const [fold, byDate] of Object.entries(raw.folds)) {
  for (const [date, rows] of Object.entries(byDate)) {
    const pd = previousMarketDayIso(date);
    const priorRows = pd ? byDate[pd] ?? null : null;
    for (const cur of rows) {
      const prior = priorRows ? priorRows.find(r => r.symbol === cur.symbol) ?? null : null;
      const v = assessLevelContinuity(prior, cur);
      const s = assessQuotePlausibility({ price: cur.price, changePct: cur.changePct });
      pairs.push({
        fold, date, priorDate: pd, sym: cur.symbol, rank: cur.rank, cur, prior,
        verdict: v.verdict, reason: v.reason, residual: v.residual,
        sessionSuspect: s.suspect, sessionRatio: s.ratio,
        qt001: qtPredicate(prior, cur, 0.01),
        qt100: qtPredicate(prior, cur, 1.00),
      });
    }
  }
}

// ── Q2/Q4: my predicate vs the shipped one, both directions.
console.log(`\n== Q2/Q4  MY filed predicate vs the shipped residual form (tolerance ${CONTINUITY_RESIDUAL_TOLERANCE}) ==`);
for (const [label, field] of [['|Δpct| > 0.01pp', 'qt001'], ['|Δpct| > 1.00pp', 'qt100']]) {
  const mine = pairs.filter(p => p[field] === true);
  const mineNotShipped = mine.filter(p => p.verdict !== 'suspect');
  const shippedNotMine = pairs.filter(p => p.verdict === 'suspect' && p[field] !== true);
  console.log(`  my predicate (${label}): fires on ${mine.length} row(s)`);
  console.log(`    ...of which the SHIPPED form does NOT flag: ${mineNotShipped.length}  <- rows my spec would have condemned`);
  for (const p of mineNotShipped.slice(0, 12)) {
    console.log(`      ${p.sym}\t${p.fold}\t${p.priorDate}->${p.date}\t#${p.rank}`
      + `\tprior=${p.prior.price}/${p.prior.changePct}\ttoday=${p.cur.price}/${p.cur.changePct}`
      + `\tverdict=${p.verdict}${p.reason ? `(${p.reason})` : ''}`
      + `\tresidual=${p.residual === null ? 'n/a' : p.residual.toFixed(6)}`);
  }
  console.log(`    SHIPPED fires where mine does NOT: ${shippedNotMine.length}  <- coverage my spec would have LOST`);
  for (const p of shippedNotMine.slice(0, 12)) {
    console.log(`      ${p.sym}\t${p.fold}\t${p.priorDate}->${p.date}\t#${p.rank}`
      + `\tprior=${p.prior.price}/${p.prior.changePct}\ttoday=${p.cur.price}/${p.cur.changePct}`
      + `\tresidual=${p.residual.toFixed(6)}\tsessionR=${p.sessionRatio === null ? 'n/a' : p.sessionRatio.toFixed(4)}`);
  }
}

// ── Q3: does it reach a rank a human reads? The ticket's whole complaint was #1.
const newCatch = pairs.filter(p => p.verdict === 'suspect' && !p.sessionSuspect);
console.log(`\n== Q3  ranks of the rows this instrument adds over r>=${SUSPECT_MOVE_RATIO} ==`);
const byRank = {};
for (const p of newCatch) byRank[p.rank] = (byRank[p.rank] ?? 0) + 1;
console.log(`  ${newCatch.length} added row(s), rank histogram ${JSON.stringify(byRank)}`);
for (const p of newCatch.sort((a, b) => a.rank - b.rank)) {
  console.log(`    #${p.rank}\t${p.sym}\t${p.fold}\t${p.priorDate}->${p.date}`
    + `\tresidual=${p.residual.toFixed(6)}\tsessionR=${p.sessionRatio === null ? 'n/a' : p.sessionRatio.toFixed(4)}`);
}

// ── Named scope check: the FGMC 07-28 row the ticket is titled after.
console.log(`\n== the ticket's headline row, verdict read off the deployed bytes ==`);
for (const p of pairs.filter(p => p.sym === 'FGMC')) {
  console.log(`  FGMC ${p.fold} ${p.priorDate}->${p.date} #${p.rank} ${p.cur.price}/${p.cur.changePct}%`
    + ` -> ${p.verdict}${p.reason ? `(${p.reason})` : ''}`
    + ` residual=${p.residual === null ? 'n/a' : p.residual.toFixed(6)}`
    + ` sessionSuspect=${p.sessionSuspect}`);
}
