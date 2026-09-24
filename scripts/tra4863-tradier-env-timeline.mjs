#!/usr/bin/env node
// TRA-4863 — read the HISTORICAL value of `TRADIER_ENV` on bqb1 off the Render tape,
// per boot, and name the deploy that carried each change.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// `CLAUDE.md` states, correctly, that Render's env surface cannot tell you which key
// a write touched: `GET /env-vars` returns `{key, value}` only — no timestamp, no
// actor, no history. Three unattributed `service_updated` env writes (TRA-4820 /
// TRA-4821 / TRA-4845) were therefore filed with the written key recorded as
// UNREADABLE.
//
// That is true of the env SURFACE. It is not true of the process. `index.ts` reads
// `process.env['TRADIER_ENV']` at module scope and logs the resolved value on every
// boot:
//
//     log.info('rv-scanner initialized', { env: redactTradierEnvLabel(tradierEnv), … })
//
// So for this ONE key the tape is a complete, per-boot history — for exactly as long
// as Render keeps the logs (7 days). This probe reads it.
//
// ── What the `env` field means (it is a TOTAL function of the arm's input) ───────
// `tradierEnv = (process.env['TRADIER_ENV'] as …) ?? 'sandbox'`, then passed through
// `redactTradierEnvLabel`. The four reachable renderings map onto
// `shouldBootArmLiveEquity`'s second condition — `(env['TRADIER_ENV'] ?? '') !==
// 'production'` — with no gaps and no ambiguity:
//
//   "production"                     → var is exactly `production`  → input (2) TRUE
//   "sandbox"                        → var is `sandbox` OR UNSET    → input (2) FALSE
//   null                             → var is set but EMPTY         → input (2) FALSE
//   "<redacted:unrecognized-value>"  → var mis-set (e.g. a token)   → input (2) FALSE
//
// The `sandbox`/unset conflation is deliberate and harmless HERE: the arm treats both
// identically. Do NOT reuse this probe to claim the var was literally `sandbox`.
//
// ── Controls (a zero must mean "did not happen", never "I could not see") ────────
// Render encodes zero matches as `logs: null`, and an unindexed `text=` needle
// returns the SAME `logs: null` (TRA-3800 / `reference_render_logs_probe_traps`).
// Retention is 7 DAYS, and a window older than that truncates SILENTLY with
// `hasMore:false`. Every run re-proves (1) the window is inside retention, (2) the
// reader returns lines in this window unfiltered, and (3) the needle is indexed,
// before any timeline below is allowed to mean anything. Timestamps MUST carry
// seconds or the API mis-reads them and prints a fake blind.
//
// Usage:
//   RENDER_API_KEY=… node scripts/tra4863-tradier-env-timeline.mjs
//   RENDER_API_KEY=… node scripts/tra4863-tradier-env-timeline.mjs \
//       --start=2026-09-17T17:30:00Z --end=2026-09-24T12:00:00Z --json=out.json
//
// Exit codes:
//   0  read cleanly (timeline below is evidence)
//   2  usage/arg error
//   3  BLIND — a control failed; NEVER report a number from this run

import { writeFileSync } from 'node:fs';

const KEY = process.env.RENDER_API_KEY;
const SERVICE = process.env.RENDER_SERVICE_ID ?? 'srv-d7mb7rr7uimc73ev0chg';
const OWNER = process.env.RENDER_OWNER_ID ?? 'tea-d7macfog4nts73ai6p40';
const NEEDLE = 'rv-scanner initialized';
const RETENTION_DAYS = 7;

if (!KEY) {
  console.error('no RENDER_API_KEY — BLIND, this is a HOLD');
  process.exit(3);
}

// ── args ─────────────────────────────────────────────────────────────────────
const args = new Map();
for (const raw of process.argv.slice(2)) {
  const m = /^--([a-z-]+)=(.*)$/.exec(raw);
  if (!m) {
    // Match NEGATIVELY (TRA-4420): an unrecognised token is an error, never a
    // silent default, or the run reports a window the operator did not ask for.
    console.error(`unrecognised argument: ${raw} (values attach with "=")`);
    process.exit(2);
  }
  args.set(m[1], m[2]);
}
const nowMs = Date.now();
const END = args.get('end') ?? new Date(nowMs).toISOString().replace(/\.\d+Z$/, 'Z');
const START = args.get('start') ?? new Date(nowMs - 6.5 * 864e5).toISOString().replace(/\.\d+Z$/, 'Z');
for (const [label, v] of [['start', START], ['end', END]]) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v)) {
    console.error(`--${label} must be an ISO instant WITH SECONDS and a trailing Z (got ${v})`);
    process.exit(2);
  }
}

async function pull({ text = null, limit = 200, startTime, endTime }) {
  const u = new URL('https://api.render.com/v1/logs');
  u.searchParams.set('resource', SERVICE); // singular; `resources=` is a different, wrong param
  if (OWNER) u.searchParams.set('ownerId', OWNER);
  u.searchParams.set('startTime', startTime);
  u.searchParams.set('endTime', endTime);
  u.searchParams.set('limit', String(limit));
  u.searchParams.set('direction', 'forward');
  if (text !== null) u.searchParams.set('text', text);
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(u, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
    if (r.ok) {
      const j = await r.json();
      // `logs: null` is Render's zero. Anything else non-array is a shape change we
      // must not silently read as zero.
      if (j.logs !== null && !Array.isArray(j.logs)) {
        throw new Error(`logs field is neither null nor an array (${typeof j.logs})`);
      }
      return { lines: j.logs ?? [], hasMore: j.hasMore === true };
    }
    // Loki 502/503s on wide spans; an aborted read is an UNDERCOUNT, not a zero.
    if (![429, 502, 503].includes(r.status)) {
      throw new Error(`logs ${r.status} ${(await r.text()).slice(0, 200)}`);
    }
    await new Promise((s) => setTimeout(s, 1500 * (attempt + 1)));
  }
  throw new Error('exhausted retries against the logs API');
}

function blind(msg) {
  console.error(`BLIND: ${msg}`);
  process.exit(3);
}

// ── CONTROL 1: retention ─────────────────────────────────────────────────────
const retentionFloor = new Date(nowMs - RETENTION_DAYS * 864e5).toISOString();
const insideRetention = START > retentionFloor;
console.log(`CONTROL retention   : start=${START} floor=${retentionFloor} → ${insideRetention ? 'PASS' : 'FAIL'}`);
if (!insideRetention) blind('window starts before the 7-day retention floor; it would truncate SILENTLY with hasMore:false');

// Slice into <=6h chunks — Loki 502s on multi-day spans.
const slices = [];
for (let t = new Date(START); t < new Date(END); ) {
  const next = new Date(Math.min(t.getTime() + 6 * 36e5, new Date(END).getTime()));
  slices.push([t.toISOString().replace(/\.\d+Z$/, 'Z'), next.toISOString().replace(/\.\d+Z$/, 'Z')]);
  t = next;
}

let unfilteredLines = 0;
const hits = [];
let truncated = false;
for (const [s, e] of slices) {
  const bare = await pull({ startTime: s, endTime: e, limit: 3 });
  unfilteredLines += bare.lines.length;
  const got = await pull({ text: NEEDLE, startTime: s, endTime: e, limit: 200 });
  if (got.hasMore) truncated = true;
  hits.push(...got.lines);
}

// ── CONTROL 2: the reader is live in THIS window ─────────────────────────────
console.log(`CONTROL reader-live : ${unfilteredLines} unfiltered lines across ${slices.length} slices → ${unfilteredLines > 0 ? 'PASS' : 'FAIL'}`);
if (unfilteredLines === 0) blind('the unfiltered reader returned nothing in this window — cannot distinguish "quiet" from "unreadable"');

// ── CONTROL 3: the needle is indexed ─────────────────────────────────────────
console.log(`CONTROL needle      : text="${NEEDLE}" → ${hits.length} hits → ${hits.length > 0 ? 'PASS' : 'FAIL'}`);
if (hits.length === 0) blind(`the needle returned zero over a window the reader can see — an unindexed needle and a real absence are the SAME response`);
if (truncated) blind('a slice reported hasMore — the boot list is INCOMPLETE and a transition could be hidden inside the gap');

// ── the timeline ─────────────────────────────────────────────────────────────
const boots = [];
for (const l of hits) {
  let m;
  try {
    m = JSON.parse((l.message ?? '').trim());
  } catch {
    blind(`a matched line did not parse as JSON, so its env cannot be read: ${(l.message ?? '').slice(0, 160)}`);
  }
  const env = m.env === undefined ? null : m.env;
  boots.push({
    at: l.timestamp,
    env,
    // This is the arm's actual second condition, not a paraphrase of it.
    armInput2: env === 'production',
    configured: m.configured === true,
  });
}
boots.sort((a, b) => a.at.localeCompare(b.at));

console.log(`\nTRADIER_ENV per boot — ${boots.length} boots, ${START} → ${END}\n`);
console.log('  BOOT (UTC)                   env as the process read it   shouldBootArmLiveEquity input (2)');
let prev = null;
const transitions = [];
for (const b of boots) {
  const flip = prev !== null && b.env !== prev;
  if (flip) transitions.push({ from: prev, to: b.env, firstBootAt: b.at });
  console.log(
    `  ${b.at.slice(0, 23).padEnd(28)}${String(b.env === null ? '(empty)' : b.env).padEnd(29)}` +
      `${b.armInput2 ? 'TRUE' : 'FALSE'}${flip ? '   <<< CHANGED' : ''}`,
  );
  prev = b.env;
}

console.log(`\n${transitions.length} transition(s):`);
for (const t of transitions) {
  console.log(`  ${t.from} → ${t.to}, first observed at boot ${t.firstBootAt}`);
}

// ── attribute each transition to a deploy ────────────────────────────────────
// A boot's env comes from its deploy's env snapshot. The WRITE itself is not
// observable, so the honest bound is the open interval between the last boot that
// read the old value and the first boot that read the new one.
let deploys = [];
try {
  const r = await fetch(`https://api.render.com/v1/services/${SERVICE}/deploys?limit=50`, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
  });
  if (r.ok) deploys = (await r.json()).map((row) => row.deploy ?? row);
} catch {
  /* deploy attribution is a nicety; its absence must not blind the timeline */
}
if (deploys.length && transitions.length) {
  console.log('\nDeploy that carried each change (the boot falls inside its create→finish span):');
  for (const t of transitions) {
    const d = deploys.find((x) => x.createdAt <= t.firstBootAt && (x.finishedAt ?? '9999') >= t.firstBootAt);
    const prevBoot = [...boots].reverse().find((b) => b.at < t.firstBootAt);
    console.log(
      `  ${t.from} → ${t.to}: ${d ? `${d.id}  created=${d.createdAt}  trigger=${d.trigger}  commit=${(d.commit?.id ?? '').slice(0, 8)}` : '(no deploy spans that boot)'}`,
    );
    console.log(`      write is bounded to (${prevBoot ? prevBoot.at : '<before window>'}, ${d ? d.createdAt : t.firstBootAt}]`);
  }
} else if (transitions.length) {
  console.log('\n(deploy history unreadable — transitions are reported without deploy attribution)');
}

if (args.has('json')) {
  writeFileSync(args.get('json'), JSON.stringify({ window: { START, END }, boots, transitions }, null, 2));
  console.log(`\nwrote ${args.get('json')}`);
}
