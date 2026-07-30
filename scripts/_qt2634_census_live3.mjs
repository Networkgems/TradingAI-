// TRA-2634 — rev 3. Two things to separate, and rev 2 conflated them:
//   (a) does `text=` tolerate a HYPHEN? "level" hits, "level-continuity" nulls,
//       "exit-cadence" is definitely in the stream — so control the hyphen with a
//       token I KNOW is present, before reading any hyphenated null as a zero.
//   (b) does the census line fire? Drive a report generation on bqb1 THIS BEAT
//       (`/api/reports/{today}` regenerates for the current ET date), then probe
//       with PLAIN-WORD tokens taken from the census line's own payload.
const KEY = process.env.RENDER_API_KEY;
const SERVICE = process.env.SERVICE ?? 'srv-d7mb7rr7uimc73ev0chg';
const OWNER = process.env.RENDER_OWNER_ID ?? 'tea-d7macfog4nts73ai6p40';
const HOST = 'https://tradingai-bqb1.onrender.com';
import fs from 'node:fs';
if (!KEY) { console.error('no RENDER_API_KEY — BLIND, HOLD'); process.exit(3); }

async function pull(text, { limit = 20, sinceMs = 30 * 60 * 1000 } = {}) {
  const u = new URL('https://api.render.com/v1/logs');
  u.searchParams.set('resource', SERVICE);
  u.searchParams.set('ownerId', OWNER);
  u.searchParams.set('startTime', new Date(Date.now() - sinceMs).toISOString());
  u.searchParams.set('endTime', new Date().toISOString());
  u.searchParams.set('limit', String(limit));
  if (text !== null) u.searchParams.set('text', text);
  const r = await fetch(u, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`logs ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j.logs;                                     // null === UNREADABLE, never 0
}
const show = (label, logs) =>
  console.log(`  ${label.padEnd(28)} -> ${logs === null ? 'NULL (unreadable)' : `${logs.length} hit(s)`}`);

// ── (a) hyphen control: both halves of a token I can see in the stream.
console.log('== (a) is a hyphen readable by text= ? controls from lines already read ==');
for (const t of ['cadence', 'exit-cadence', 'timing', 'phase-timing', 'signal-engine', 'engine']) {
  show(JSON.stringify(t), await pull(t));
}

// ── (b) drive a real report generation, then look for the census.
console.log('\n== (b) drive generateAndSaveReport on bqb1, then probe plain-word tokens ==');
const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const login = await fetch(`${HOST}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: env.ADMIN_USERNAME ?? 'admin', password: env.ADMIN_PASSWORD }) });
if (!login.ok) { console.error(`login ${login.status} — BLIND, HOLD`); process.exit(3); }
const H = { Authorization: `Bearer ${(await login.json()).token}` };
// Current ET date — the only one the route regenerates live.
const etDate = new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10);
const t0 = new Date().toISOString();
for (const fold of ['live', 'demo']) {
  const r = await fetch(`${HOST}/api/reports/${etDate}?mode=${fold}`, { headers: H });
  const j = r.ok ? await r.json() : null;
  console.log(`  GET /api/reports/${etDate}?mode=${fold} -> ${r.status}`
    + ` generatedAt=${j?.generatedAt ?? 'n/a'} movers=${(j?.top5Movers ?? []).length}`);
}
console.log(`  (requests issued after ${t0})`);
await new Promise(res => setTimeout(res, 12000));    // log ingestion lag

for (const t of ['census', 'continuity', 'abstained', 'priorRowsAvailable', 'abstainReasons',
                 'movers', 'implausible', 'discontinu']) {
  show(JSON.stringify(t), await pull(t, { limit: 5, sinceMs: 10 * 60 * 1000 }));
}
