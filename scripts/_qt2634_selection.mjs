// TRA-2634 — the one load-bearing claim in the delivery I had not measured:
//
//   "The hazard is self-selecting (a re-derived denominator recurs every session,
//    so a row about to take #1 was usually #1 yesterday)"
//
// If true, the ~8% overall gradeable rate understates coverage of the population
// that actually carries the defect. If false, the coverage number IS ~8% on the
// hazard too and the board should be told that instead.
//
// PROXY for "a row carrying the defect": the rows the DEPLOYED r>=2 session rule
// already flags. It is an independent instrument, it is the one TRA-2610 shipped,
// and it does not consult prior artifacts at all — so it cannot be confounded by
// the very availability I am measuring. Stated as a proxy, not as truth.
import fs from 'node:fs';
import { assessQuotePlausibility, assessLevelContinuity } from '../packages/shared/dist/index.js';

const HOLIDAYS = new Set([
  '2025-01-01','2025-01-20','2025-02-17','2025-04-18','2025-05-26','2025-06-19','2025-07-04',
  '2025-09-01','2025-11-27','2025-12-25','2026-01-01','2026-01-19','2026-02-16','2026-04-03',
  '2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25']);
const isMkt = d => { if (HOLIDAYS.has(d)) return false;
  const [y,m,dd]=d.split('-').map(Number); const w=new Date(Date.UTC(y,m-1,dd)).getUTCDay(); return w!==0&&w!==6; };
function prevMkt(d) { const [y,m,dd]=d.split('-').map(Number); let t=Date.UTC(y,m-1,dd);
  for (let i=0;i<10;i++){ t-=86400000; const iso=new Date(t).toISOString().slice(0,10); if (isMkt(iso)) return iso; } return null; }

const files = process.argv.slice(2);
if (files.length === 0) { console.error('usage: node _qt2634_selection.mjs <cache.json> [...]'); process.exit(2); }

const all = [];
for (const f of files) {
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const [fold, byDate] of Object.entries(raw.folds)) {
    for (const [date, rows] of Object.entries(byDate)) {
      const pd = prevMkt(date);
      const priorRows = pd ? byDate[pd] ?? null : null;
      for (const cur of rows) {
        const prior = priorRows ? priorRows.find(r => r.symbol === cur.symbol) ?? null : null;
        const v = assessLevelContinuity(prior, cur);
        const s = assessQuotePlausibility({ price: cur.price, changePct: cur.changePct });
        all.push({ box: raw.host.includes('localhost') ? 'localhost' : 'bqb1', fold, date, sym: cur.symbol,
          rank: cur.rank, verdict: v.verdict, reason: v.reason, sessionSuspect: s.suspect });
      }
    }
  }
}
if (all.length === 0) { console.error('0 rows — BLIND, HOLD'); process.exit(3); }

const pct = (n, d) => d === 0 ? 'n/a' : `${(100 * n / d).toFixed(1)}%`;
const tab = rows => {
  const graded = rows.filter(r => r.verdict !== 'abstain');
  const why = {};
  for (const r of rows.filter(r => r.verdict === 'abstain')) why[r.reason ?? '?'] = (why[r.reason ?? '?'] ?? 0) + 1;
  return `${String(graded.length).padStart(4)}/${String(rows.length).padStart(4)} = ${pct(graded.length, rows.length).padStart(6)}   ${JSON.stringify(why)}`;
};

console.log(`rows ${all.length} (bqb1 ${all.filter(r=>r.box==='bqb1').length}, localhost ${all.filter(r=>r.box==='localhost').length})\n`);
console.log('GRADEABLE RATE — the coverage question, sliced by whether the row carries the hazard proxy');
console.log(`  ALL published mover rows        ${tab(all)}`);
console.log(`  rows r>=2 flags (hazard proxy)  ${tab(all.filter(r => r.sessionSuspect))}`);
console.log(`  rows r>=2 passes               ${tab(all.filter(r => !r.sessionSuspect))}`);
console.log(`\n  #1-RANKED rows only — the slot the ticket is about`);
console.log(`  ALL #1 rows                    ${tab(all.filter(r => r.rank === 1))}`);
console.log(`  #1 rows r>=2 flags             ${tab(all.filter(r => r.rank === 1 && r.sessionSuspect))}`);

// The verdict distribution on the hazard proxy — the actionable half.
const haz = all.filter(r => r.sessionSuspect);
const d = {};
for (const r of haz) d[r.verdict === 'abstain' ? `abstain:${r.reason}` : r.verdict] = (d[r.verdict === 'abstain' ? `abstain:${r.reason}` : r.verdict] ?? 0) + 1;
console.log(`\n  continuity verdict on the ${haz.length} hazard-proxy rows: ${JSON.stringify(d)}`);
