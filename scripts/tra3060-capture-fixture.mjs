#!/usr/bin/env node
// TRA-3060 — capture the VERBATIM co-located pair (BOOT echo + external-kill line) for the suite.
// Hand-written approximations are exactly the bug class this suite exists to catch.
import { writeFileSync } from 'node:fs';
const API = 'https://api.render.com/v1';
const KEY = process.env.RENDER_API_KEY;
const SVC = process.env.RENDER_SERVICE_ID || 'srv-d7mb7rr7uimc73ev0chg';
const rh = { Authorization: `Bearer ${KEY}`, Accept: 'application/json' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function get(url, tries = 4) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: rh });
    if (r.ok) return r.json();
    last = `HTTP ${r.status}`;
    if (r.status !== 503 && r.status !== 429) break;
    await sleep(1500 * (i + 1));
  }
  throw new Error(`UNREADABLE ${url} :: ${last}`);
}
const svc = await get(`${API}/services/${SVC}`);
const owner = svc.ownerId;
const FROM = '2026-08-04T20:30:00Z', TO = '2026-08-04T20:45:00Z';
const q = async (text) => {
  const j = await get(`${API}/logs?ownerId=${owner}&resource=${SVC}`
    + `&startTime=${encodeURIComponent(FROM)}&endTime=${encodeURIComponent(TO)}`
    + `&direction=backward&limit=100&text=${encodeURIComponent(text)}`);
  if (j.logs === null) throw new Error(`logs:null for ${text} — HELD, not a zero`);
  return j.logs;
};
const ek = await q('external kill');
await sleep(400);
const sr = await q('self-restarting');
const deploys = await get(`${API}/services/${SVC}/deploys?limit=50`);
await sleep(300);
const events = await get(`${API}/services/${SVC}/events?limit=100`
  + `&startTime=${encodeURIComponent(FROM)}&endTime=${encodeURIComponent(TO)}`);

const pick = (l) => ({ timestamp: l.timestamp, message: String(l.message) });
const out = {
  _comment: 'TRA-3060 — VERBATIM Render /v1/logs + /deploys + /events for tradingai-bqb1, '
    + `${FROM}..${TO}. Captured 2026-08-06. The BOOT echo and the external-kill line are the SAME `
    + 'boot, ~1ms apart; this is the fixture that proves clusterBoots absorbs the overlap.',
  window: { from: FROM, to: TO },
  externalKillLogs: ek.map(pick),
  watchdogLogs: sr.map(pick),
  // UNFILTERED on purpose: `buildBootSet` judges deploy-page coverage by whether the OLDEST record
  // predates the window open, so a fixture pre-filtered to the window would false-BLIND every test.
  deploys: (deploys.deploys ?? deploys).map(d => d.deploy ?? d)
    .map(d => ({ id: d.id, status: d.status, finishedAt: d.finishedAt, createdAt: d.createdAt, trigger: d.trigger ?? null })),
  events: (events.events ?? events).map(e => e.event ?? e).map(e => ({ id: e.id, type: e.type, timestamp: e.timestamp })),
};
const path = new URL('./lib/__fixtures__/bqb1-2026-08-04-external-kill.json', import.meta.url);
writeFileSync(path, JSON.stringify(out, null, 2));
console.log(`wrote ${path.pathname}`);
console.log(`externalKillLogs=${out.externalKillLogs.length} watchdogLogs=${out.watchdogLogs.length} `
  + `deploys=${out.deploys.length} events=${out.events.length}`);
for (const l of [...out.externalKillLogs, ...out.watchdogLogs].sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1))) {
  console.log(`  ${l.timestamp}  ${JSON.parse(l.message).msg.slice(0, 70)}`);
}
