#!/usr/bin/env node
// TRA-4861 — name the writer of the PERSISTED demotion that the boot-arm repaired at
// 2026-09-23T16:42:05.239Z (`origin: boot`, `repaired: ["mode","liveTradierEnvOptions"]`,
// `bodyFields: []`, `requestOrigin: null`).
//
// The boot-arm ledger records NO actor for a `boot` event by construction, so the
// ledger itself can never answer this. But `saveSettings` already logs one line per
// persist — `saveSettings: persisted` carrying BOTH `mode` and `liveTradierEnvOptions`
// (account-settings.ts `logSavePersisted`). Every writer of the persisted operator
// goes through that one funnel, including the ones that never touch the settings PUT.
// So the tape, inside the retention window, IS the attribution instrument we lack in
// the ledger — for exactly 7 days.
//
// Window: the persisted demotion reached disk between the previous boot (the 10:53Z
// deploy of 7f2904148) and the catching boot (16:42Z). Anything inside that window
// that persisted `mode=demo` for the pinned operator is the writer.
//
// ── Controls (a zero here must mean "did not fire") ───────────────────────────
// Render encodes ZERO MATCHES as `logs: null`, and a wrong `resource=` / an unindexed
// `text=` needle returns the SAME `logs: null`. A bare zero carries no information.
// Every run re-proves (1) the reader is live in THIS window and (2) the `text=` filter
// is neither dead-shut nor broken-open, before any count below is allowed to mean
// anything. Retention on this service is 7 DAYS, so a window older than that truncates
// SILENTLY with `hasMore:false` — the run refuses rather than reporting the truncation
// as an absence.
//
// Usage:
//   RENDER_API_KEY=… node scripts/tra4861-name-the-writer.mjs
//   RENDER_API_KEY=… node scripts/tra4861-name-the-writer.mjs --start=… --end=… --json=out.json
//
// Exit codes:
//   0  read cleanly (writer named OR provably absent from the tape)
//   2  usage/arg error
//   3  BLIND — reader, filter or retention control failed; NEVER report a number from this

import { writeFileSync } from 'node:fs';

const KEY = process.env.RENDER_API_KEY;
const SERVICE = process.env.RENDER_SERVICE_ID ?? 'srv-d7mb7rr7uimc73ev0chg';
const OWNER = process.env.RENDER_OWNER_ID ?? 'tea-d7macfog4nts73ai6p40';

if (!KEY) { console.error('no RENDER_API_KEY — BLIND, this is a HOLD'); process.exit(3); }

// The TRA-4861 window, to the SECOND. Render's log API silently mis-reads a
// timestamp without seconds (TRA-3800), which prints a FAKE BLIND.
let START = '2026-09-23T10:53:00Z';
let END = '2026-09-23T16:42:06Z';
let jsonOut = null;
for (const a of process.argv.slice(2)) {
  const s = /^--start=(.+)$/.exec(a);
  const e = /^--end=(.+)$/.exec(a);
  const j = /^--json=(.+)$/.exec(a);
  if (s) START = s[1];
  else if (e) END = e[1];
  else if (j) jsonOut = j[1];
  else { console.error(`unknown arg ${a}`); process.exit(2); }
}
for (const [label, v] of [['--start', START], ['--end', END]]) {
  if (!/\d{2}:\d{2}:\d{2}/.test(v)) {
    console.error(`${label} must carry SECONDS (got ${v}) — a minute-precision bound prints a FAKE BLIND`);
    process.exit(2);
  }
}

// ── Retention control ─────────────────────────────────────────────────────────
// 7 days, not 30. A window whose START predates retention truncates SILENTLY and
// still answers `hasMore:false`, which reads exactly like "nothing happened".
const RETENTION_DAYS = 7;
const ageDays = (Date.now() - Date.parse(START)) / 86_400_000;
console.log(`window   : ${START} … ${END}`);
console.log(`age      : ${ageDays.toFixed(2)} d (retention ${RETENTION_DAYS} d)`);
if (!(ageDays < RETENTION_DAYS)) {
  console.error(`window START is outside the ${RETENTION_DAYS}-day retention — the tape TRUNCATES SILENTLY here.`);
  console.error('An empty result from this window is NOT evidence of absence. BLIND, this is a HOLD.');
  process.exit(3);
}
console.log('');

async function pull({ text = null, limit = 100, endTime = END, startTime = START } = {}) {
  const u = new URL('https://api.render.com/v1/logs');
  u.searchParams.set('resource', SERVICE);           // NOT `resource[]=`
  if (OWNER) u.searchParams.set('ownerId', OWNER);
  u.searchParams.set('startTime', startTime);
  u.searchParams.set('endTime', endTime);
  u.searchParams.set('limit', String(limit));        // MAX 100 — larger 200s with an error OBJECT
  if (text !== null) u.searchParams.set('text', text);
  const r = await fetch(u, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
  if (r.status === 429) throw new Error('429 rate limited — an aborted read is an UNDERCOUNT, not a zero');
  if (!r.ok) throw new Error(`logs ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  if (j.logs !== null && !Array.isArray(j.logs)) {
    throw new Error(`logs field is neither null nor an array (${typeof j.logs}) — refusing to read it as zero`);
  }
  return { lines: j.logs ?? [], hasMore: j.hasMore === true, nextEndTime: j.nextEndTime ?? null };
}

// Page BACKWARD: `nextEndTime` is the timestamp of the OLDEST line just returned.
// Reading page 1 as the total is how an undercount gets published as a census.
async function pullAll({ text = null, cap = 4000 } = {}) {
  const out = [];
  let endTime = END;
  for (let page = 0; page < 60 && out.length < cap; page++) {
    const p = await pull({ text, endTime });
    out.push(...p.lines);
    if (!p.hasMore || !p.nextEndTime || p.nextEndTime === endTime) break;
    endTime = p.nextEndTime;
  }
  return out;
}

// ── CONTROL 1 — reader live IN THIS WINDOW ────────────────────────────────────
const c1 = await pull({ limit: 5 });
console.log(`CONTROL 1 (no text filter)       : ${c1.lines.length} line(s) — reader ${c1.lines.length > 0 ? 'LIVE' : 'BLIND'}`);
if (c1.lines.length === 0) {
  console.error('reader returned 0 unfiltered inside the window — BLIND, this is a HOLD');
  process.exit(3);
}

// ── CONTROL 2 — `text=` is neither dead-shut nor broken-open ──────────────────
// Calibrate off a line CONTROL 1 just returned, never a hardcoded needle: a
// hardcoded needle decays the moment someone suppresses that emitter (TRA-3800),
// turning a healthy box into a permanent false alarm.
const sample = String(c1.lines[0]?.message ?? '');
const needle = (sample.match(/[A-Za-z][A-Za-z-]{5,}/g) ?? []).find(w => !/^\d+$/.test(w));
if (!needle) {
  console.error('could not calibrate CONTROL 2 off a live line — BLIND, this is a HOLD');
  process.exit(3);
}
const c2 = await pull({ text: needle, limit: 5 });
console.log(`CONTROL 2 (text="${needle}") : ${c2.lines.length} line(s) — filter ${c2.lines.length > 0 ? 'PASSES' : 'DEAD-SHUT'}`);
if (c2.lines.length === 0) {
  console.error(`a needle taken from a line INSIDE this window returned 0 — the \`text=\` filter is not indexing it.`);
  console.error('Every count below would be a false zero. BLIND, this is a HOLD.');
  process.exit(3);
}
const c3 = await pull({ text: 'zzz-tra4861-should-never-match-zzz', limit: 5 });
console.log(`CONTROL 3 (impossible needle)    : ${c3.lines.length} line(s) — filter ${c3.lines.length === 0 ? 'DISCRIMINATES' : 'BROKEN-OPEN'}`);
if (c3.lines.length !== 0) {
  console.error('an impossible needle matched — the filter is broken-open, counts are meaningless. HOLD.');
  process.exit(3);
}
console.log('');

// ── The read ──────────────────────────────────────────────────────────────────
// `saveSettings: persisted` is the single funnel EVERY writer of the persisted
// operator passes through — PUT handler, non-PUT route, boot-arm write-through and
// the one-time JSON→SQLite import alike. It logs `mode` and `liveTradierEnvOptions`
// by name, which is exactly the pair the boot-arm repaired.
const persists = await pullAll({ text: 'saveSettings' });
console.log(`saveSettings lines in window     : ${persists.length}`);

const rows = persists
  .map(l => ({ at: l.timestamp, msg: String(l.message ?? '') }))
  .filter(r => r.msg.includes('persisted'))
  .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

const field = (msg, name) => {
  const m = new RegExp(`${name}=([^\\s"]+)`).exec(msg) ?? new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`).exec(msg);
  return m ? m[1] : null;
};

console.log(`  of which "persisted"           : ${rows.length}`);
console.log('');
const demotions = [];
for (const r of rows) {
  const user = field(r.msg, 'username');
  const mode = field(r.msg, 'mode');
  const env = field(r.msg, 'liveTradierEnvOptions');
  const demoted = mode === 'demo' || env === 'sandbox';
  if (demoted) demotions.push({ at: r.at, username: user, mode, liveTradierEnvOptions: env, raw: r.msg });
  console.log(`  ${r.at}  user=${user} mode=${mode} env=${env}${demoted ? '   <<< DEMOTED' : ''}`);
}

console.log('');
console.log('── VERDICT ───────────────────────────────────────────────────────────');
if (rows.length === 0) {
  console.log('NO `saveSettings: persisted` line in the window, with all three controls green.');
  console.log('⇒ The demotion did NOT reach disk through `saveSettings` inside this window.');
  console.log('  Remaining durable writers of the row: `loadSettingsViaDb`\'s one-time');
  console.log('  JSON→SQLite import (account-settings.ts:149), which calls `writeSettingsRow`');
  console.log('  DIRECTLY and therefore logs NO `saveSettings: persisted` line at all.');
} else if (demotions.length === 0) {
  console.log(`${rows.length} persist(s) in the window, NONE carrying mode=demo / env=sandbox.`);
  console.log('⇒ Same conclusion: the demotion bypassed the `saveSettings` funnel.');
} else {
  console.log(`WRITER NAMED — ${demotions.length} demoting persist(s):`);
  for (const d of demotions) console.log(`  ${d.at}  user=${d.username}  mode=${d.mode}  env=${d.liveTradierEnvOptions}`);
}

// Boot-arm write-through, for correlation — this is the REPAIR, not the demotion.
const bootArm = await pullAll({ text: 'boot-arm' });
console.log('');
console.log(`boot-arm lines in window         : ${bootArm.length}`);
for (const l of bootArm.slice(-12)) console.log(`  ${l.timestamp}  ${String(l.message ?? '').slice(0, 190)}`);

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({
    window: { start: START, end: END }, ageDays,
    controls: { unfiltered: c1.lines.length, needle, needleHits: c2.lines.length, impossibleHits: c3.lines.length },
    persists: rows, demotions, bootArm: bootArm.map(l => ({ at: l.timestamp, msg: String(l.message ?? '') })),
  }, null, 2));
  console.log(`\nwrote ${jsonOut}`);
}
