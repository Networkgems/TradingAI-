#!/usr/bin/env node
// TRA-3060 — all four boot witnesses on ONE timeline. The OVERLAP question. Do the 39 external-kill lines land ON TOP of the
// existing witnesses (⇒ clusterBoots absorbs them, delta 0) or BESIDE them (⇒ new boots)?
//
// The failing direction for this ticket is an OVER-count, so this prints every candidate instant
// from all four witnesses on one timeline and lets a human read the collapse.
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
    last = `HTTP ${r.status} ${(await r.text()).slice(0, 200)}`;
    if (r.status !== 503 && r.status !== 429) break;
    await sleep(1500 * (i + 1));
  }
  throw new Error(`UNREADABLE ${url} :: ${last}`);
}
async function logs({ owner, text, from, to, limit = 300 }) {
  const j = await get(`${API}/logs?ownerId=${owner}&resource=${SVC}`
    + `&startTime=${encodeURIComponent(from)}&endTime=${encodeURIComponent(to)}`
    + `&direction=backward&limit=${limit}&text=${encodeURIComponent(text)}`);
  if (j.logs === null) throw new Error(`logs:null for text=${text} — HELD, not a zero`);
  return { lines: j.logs, hasMore: j.hasMore };
}

const svc = await get(`${API}/services/${SVC}`);
const owner = svc.ownerId;
const FROM = '2026-08-01T00:00:00Z';
const TO = '2026-08-06T06:00:00Z';

const ek = await logs({ owner, text: 'external kill', from: FROM, to: TO });
await sleep(400);
const sr = await logs({ owner, text: 'self-restarting', from: FROM, to: TO });
await sleep(400);
const dep = await get(`${API}/services/${SVC}/deploys?limit=50`);
await sleep(300);
const evs = await get(`${API}/services/${SVC}/events?limit=100`
  + `&startTime=${encodeURIComponent(FROM)}&endTime=${encodeURIComponent(TO)}`);

const msgOf = (l) => { try { return JSON.parse(l.message).msg; } catch { return String(l.message).slice(0, 80); } };
const rows = [];
for (const l of ek.lines) rows.push({ at: l.timestamp, src: 'EXTKILL', d: msgOf(l).slice(0, 46) });
for (const l of sr.lines) {
  const m = msgOf(l);
  rows.push({ at: l.timestamp, src: /detected on boot/i.test(m) ? 'WD-BOOT' : /suppress/i.test(m) ? 'WD-SUPP' : 'WD-TRIP', d: m.slice(0, 46) });
}
const inSpan = (t) => t >= FROM && t <= TO;
for (const d0 of (dep.deploys ?? dep)) {
  const d = d0.deploy ?? d0;
  if (d.finishedAt && inSpan(d.finishedAt)) rows.push({ at: d.finishedAt, src: 'DEPLOY', d: `${d.id} ${d.status}` });
}
const RESTART_EVENT_RE = /restart|crash|oom|server_failed|health_check_failed/i;
for (const e0 of (evs.events ?? evs)) {
  const e = e0.event ?? e0;
  if (e.timestamp && inSpan(e.timestamp) && RESTART_EVENT_RE.test(String(e.type ?? ''))) rows.push({ at: e.timestamp, src: 'EVENT', d: String(e.type) });
}
rows.sort((a, b) => (a.at < b.at ? -1 : 1));

console.log(`ek=${ek.lines.length} hasMore=${ek.hasMore} | selfrestarting=${sr.lines.length} hasMore=${sr.hasMore} | rows=${rows.length}\n`);
let prev = null;
for (const r of rows) {
  const gap = prev ? Math.round((new Date(r.at).getTime() - new Date(prev).getTime()) / 1000) : 0;
  console.log(`${r.at.slice(0, 23).padEnd(23)} ${String(gap).padStart(7)}s  ${r.src.padEnd(8)} ${r.d}`);
  prev = r.at;
}
