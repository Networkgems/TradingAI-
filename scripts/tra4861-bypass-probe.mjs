#!/usr/bin/env node
// TRA-4861 — follow-up to `tra4861-name-the-writer.mjs`.
//
// That probe established, with three green controls, that the ~5h49m window in which
// the persisted demotion reached disk contains exactly ONE `saveSettings: persisted`
// line — the boot-arm's own repair write at 16:41:56.100Z, `mode=live env=production`.
//
// `saveSettings` is one of only TWO callers of `writeSettingsRow` (the single durable
// writer of the `account_settings` row). So if the demotion did not pass through
// `saveSettings`, it passed through the other caller: `loadSettingsViaDb`'s one-time
// JSON→SQLite import (account-settings.ts:149), which calls `writeSettingsRow`
// DIRECTLY and emits no `saveSettings: persisted` line — only
// `TRA-1052 one-time import`.
//
// This probe does two things:
//   (A) CALIBRATION — proves the `saveSettings` needle is genuinely indexed, by
//       counting it over a WIDER window. "1 line in 5h49m" is only evidence of
//       absence if the same needle returns many lines when many writes happened.
//       Without this, (1) is indistinguishable from an unindexed needle.
//   (B) BYPASS — searches the window for every OTHER log line any non-`saveSettings`
//       durable writer would emit.
//
// Exit codes: 0 read cleanly · 2 usage · 3 BLIND (control failed)

const KEY = process.env.RENDER_API_KEY;
const SERVICE = process.env.RENDER_SERVICE_ID ?? 'srv-d7mb7rr7uimc73ev0chg';
const OWNER = process.env.RENDER_OWNER_ID ?? 'tea-d7macfog4nts73ai6p40';
if (!KEY) { console.error('no RENDER_API_KEY — BLIND, this is a HOLD'); process.exit(3); }

const RETENTION_DAYS = 7;

async function pull({ text = null, limit = 100, startTime, endTime }) {
  const u = new URL('https://api.render.com/v1/logs');
  u.searchParams.set('resource', SERVICE);
  if (OWNER) u.searchParams.set('ownerId', OWNER);
  u.searchParams.set('startTime', startTime);
  u.searchParams.set('endTime', endTime);
  u.searchParams.set('limit', String(limit));
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

// Loki 502s on a multi-day span (surfaced as HTTP 503 from Render's proxy), so a
// wide read MUST be chunked. Retry each chunk: a transient 502/503 is an
// UNDERCOUNT, and silently swallowing it would publish it as an absence.
async function pullWindow({ text, startTime, endTime, cap = 3000 }) {
  const out = [];
  let end = endTime;
  for (let page = 0; page < 40 && out.length < cap; page++) {
    let p = null;
    for (let attempt = 0; attempt < 4 && !p; attempt++) {
      try { p = await pull({ text, startTime, endTime: end }); }
      catch (err) {
        if (attempt === 3) throw err;
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    out.push(...p.lines);
    if (!p.hasMore || !p.nextEndTime || p.nextEndTime === end) break;
    end = p.nextEndTime;
  }
  return out;
}

/** Chunked read — `chunkHours` slices keep each Loki query inside what it will serve. */
async function pullAll({ text, startTime, endTime, cap = 3000, chunkHours = 12 }) {
  const t0 = Date.parse(startTime), t1 = Date.parse(endTime);
  const step = chunkHours * 3_600_000;
  const out = [];
  for (let a = t0; a < t1; a += step) {
    const b = Math.min(a + step, t1);
    const s = new Date(a).toISOString().replace(/\.\d+Z$/, 'Z');
    const e = new Date(b).toISOString().replace(/\.\d+Z$/, 'Z');
    out.push(...await pullWindow({ text, startTime: s, endTime: e, cap }));
  }
  return out;
}

// ── (A) CALIBRATION ───────────────────────────────────────────────────────────
// Widest window retention allows, clipped to a whole-second bound.
const wideStart = new Date(Date.now() - (RETENTION_DAYS - 0.2) * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');
const wideEnd = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
console.log(`CALIBRATION window : ${wideStart} … ${wideEnd}`);
const wide = await pullAll({ text: 'saveSettings', startTime: wideStart, endTime: wideEnd });
console.log(`  \`saveSettings\` lines over ~${(RETENTION_DAYS - 0.2).toFixed(1)}d : ${wide.length}`);
if (wide.length === 0) {
  console.error('the `saveSettings` needle returns 0 over the WHOLE retention window.');
  console.error('It is therefore not indexed, and "1 line in the incident window" was a FALSE ZERO. HOLD.');
  process.exit(3);
}
const byDay = new Map();
for (const l of wide) {
  const d = String(l.timestamp).slice(0, 10);
  byDay.set(d, (byDay.get(d) ?? 0) + 1);
}
console.log('  per-day:');
for (const d of [...byDay.keys()].sort()) console.log(`    ${d}  ${byDay.get(d)}`);
console.log(`  ⇒ needle INDEXED (${wide.length} hits across ${byDay.size} day(s)). A low count inside the`);
console.log('    incident window is a real absence, not a filter artifact.');
console.log('');

// Show every persisted line over the wide window with its mode/env, so a demoting
// write ANYWHERE in retention is visible even if it fell outside the stated window.
const field = (msg, name) => {
  const m = new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`).exec(msg) ?? new RegExp(`${name}=([^\\s",]+)`).exec(msg);
  return m ? m[1] : null;
};
const persisted = wide
  .map(l => ({ at: l.timestamp, msg: String(l.message ?? '') }))
  .filter(r => r.msg.includes('persisted'))
  .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
console.log(`ALL \`saveSettings: persisted\` in retention : ${persisted.length}`);
for (const r of persisted) {
  const mode = field(r.msg, 'mode'), env = field(r.msg, 'liveTradierEnvOptions'), user = field(r.msg, 'username');
  const flag = (mode === 'demo' || env === 'sandbox') ? '   <<< DEMOTING WRITE' : '';
  console.log(`  ${r.at}  user=${user} mode=${mode} env=${env}${flag}`);
}
console.log('');

// ── (B) BYPASS WRITERS ────────────────────────────────────────────────────────
// Every other line a durable writer of (or a destroyer of) the row would emit.
const START = '2026-09-23T10:53:00Z';
const END = '2026-09-23T16:42:06Z';
console.log(`BYPASS scan window : ${START} … ${END}`);
const needles = [
  ['TRA-1052',            'one-time JSON→SQLite import — writeSettingsRow WITHOUT saveSettings'],
  ['one-time import',     'same, by message text'],
  ['account_settings',    'row dropped / probe failures'],
  ['SQLite write failed', 'saveSettings fell back to the JSON file'],
  ['falling back',        'loadSettings fell back to defaults or to JSON'],
  ['migration',           'legacy in-place migration persisted'],
  ['TRA-485',             'corrupt-settings → DEFAULT_ACCOUNT_SETTINGS served'],
  ['TRA-165',             'legacy live-cred migration'],
  ['TRA-229',             'auto-trading flag split migration'],
  ['orphaned-books',      'orphan retirement touched the settings row'],
  ['recycled',            'settings row retired at signup'],
];
for (const [needle, why] of needles) {
  const hits = await pullAll({ text: needle, startTime: START, endTime: END });
  const mark = hits.length > 0 ? 'HIT' : ' — ';
  console.log(`  [${mark}] ${String(hits.length).padStart(4)}  "${needle}"  (${why})`);
  for (const h of hits.slice(0, 6)) console.log(`         ${h.timestamp}  ${String(h.message ?? '').slice(0, 170)}`);
}
console.log('');
console.log('Read a row of zeros here together with the CALIBRATION block above: the needles');
console.log('are literal substrings of lines this service demonstrably emits, so a zero is an');
console.log('absence. A needle that has never fired in retention proves nothing on its own —');
console.log('cite it only alongside the `saveSettings` calibration, which HAS fired.');
