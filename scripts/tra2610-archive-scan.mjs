// TRA-2610 residual — the fix repairs report GENERATION. It does not rewrite the
// report FILES already on disk, and those files are still being SERVED. Scan the
// archive and count how many stored top-movers tables carry a row the deployed rule
// calls fabricated, using the rule itself rather than eyeballing the percentages.
import fs from 'node:fs';
import { assessQuotePlausibility, SUSPECT_MOVE_RATIO } from '../packages/shared/dist/index.js';
const HOST = process.env.HOST ?? 'https://tradingai-bqb1.onrender.com';
const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const login = await fetch(`${HOST}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: env.ADMIN_USERNAME ?? 'admin', password: env.ADMIN_PASSWORD }),
});
if (!login.ok) { console.error(`login ${login.status}`); process.exit(3); }
const token = (await login.json()).token;

const dates = [];
for (let i = 0; i < 21; i++) {
  const d = new Date(Date.UTC(2026, 6, 29) - i * 86_400_000);
  dates.push(d.toISOString().slice(0, 10));
}
let scanned = 0, dirty = 0, dirtyFirst = 0;
const rows = [];
for (const date of dates) {
  for (const mode of ['demo', 'live']) {
    const r = await fetch(`${HOST}/api/reports/${date}?mode=${mode}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) continue;
    const rep = await r.json();
    const mv = rep.top5Movers;
    if (!Array.isArray(mv) || mv.length === 0) continue;
    scanned++;
    const flagged = mv
      .map((m, i) => ({ i, m, v: assessQuotePlausibility({ price: m.price, changePct: m.changePct }) }))
      .filter(x => x.v.suspect);
    if (flagged.length === 0) continue;
    dirty++;
    if (flagged.some(x => x.i === 0)) dirtyFirst++;
    rows.push(`${date} ${mode.padEnd(4)} ${flagged.length}/${mv.length} suspect  ${flagged
      .map(x => `#${x.i + 1} ${x.m.symbol} $${x.m.price} ${Number(x.m.changePct).toFixed(2)}% r=${x.v.ratio?.toFixed(2)}`).join('  ')}`);
  }
}
console.log(`threshold          : SUSPECT_MOVE_RATIO = ${SUSPECT_MOVE_RATIO}`);
console.log(`stored tables read : ${scanned} (non-empty, last 21 calendar days, both modes)`);
console.log(`carrying a fabricated row : ${dirty}`);
console.log(`with it at #1             : ${dirtyFirst}`);
if (scanned === 0) { console.error('BLIND — no non-empty stored table was readable; a zero here means nothing.'); process.exit(3); }
console.log('');
for (const line of rows) console.log(line);
