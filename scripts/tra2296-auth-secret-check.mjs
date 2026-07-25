#!/usr/bin/env node
// TRA-2296 — verify prod is NOT running on an ephemeral HMAC signing key.
//
// Background: bqb1 had AUTH_SECRET present-but-EMPTY, and resolveAuthSecret()
// treats empty as unset, so every boot re-rolled the signing key and silently
// signed out every logged-in user (~8 boots/day).
//
// The naive check — "grep the logs for the ephemeral warning, assert zero" — is
// FAIL-OPEN in two independent ways, and this script refuses to report PASS on
// either of them:
//
//   1. THE ZERO MIGHT MEAN "NOTHING BOOTED". The warning is emitted at boot and
//      nowhere else. If the service has not restarted since the cutover, zero
//      warnings is guaranteed regardless of whether the fix works. A positive
//      control must CONTAIN what the instrument detects, so we require at least
//      one boot in the window before a zero counts as evidence.
//
//   2. THE ZERO MIGHT MEAN "WARNINGS WERE NOT RETAINED". The line is level=warn,
//      and bqb1 has had windows retaining only level=error (TRA-2294). A log
//      query that cannot see ANY warn-level line from this service in the window
//      cannot see this one either, so its zero is a fact about the log level,
//      not about the world.
//
// Exit codes:  0 PASS   1 FAIL   2 usage/missing key   3 BLIND (cannot decide)
//
// Usage:
//   RENDER_API_KEY=rnd_xxx node scripts/tra2296-auth-secret-check.mjs --since=<ISO>
//   [--service=srv-…] [--json]
//
// --since defaults to the finishedAt of the most recent live deploy (i.e. "has
// prod been clean since the last time it booted").

import { pullBootSet } from './lib/render-boot-set.mjs';

const SRV_DEFAULT = 'srv-d7mb7rr7uimc73ev0chg'; // tradingai-bqb1
const EPHEMERAL_TEXT = 'ephemeral random secret';

const argv = process.argv.slice(2);
const valOf = (flag) => {
  const hit = argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
};
const JSON_OUT = argv.includes('--json');
const SRV = valOf('--service') ?? SRV_DEFAULT;
const API_KEY = process.env.RENDER_API_KEY;

const H = { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' };
const out = [];
const say = (s) => { out.push(s); if (!JSON_OUT) console.log(s); };

function finish(code, verdict, extra = {}) {
  if (JSON_OUT) console.log(JSON.stringify({ verdict, exitCode: code, ...extra, lines: out }, null, 2));
  else say(`\nVERDICT: ${verdict}`);
  process.exit(code);
}

if (!API_KEY) {
  console.error('RENDER_API_KEY is required (never commit it).');
  process.exit(2);
}

async function api(path) {
  const r = await fetch(`https://api.render.com/v1${path}`, { headers: H });
  if (!r.ok) return { __err: `${r.status} ${(await r.text()).slice(0, 200)}` };
  return r.json();
}

// ---------------------------------------------------------------- check 1
// The env var itself. Graded by VALUE LENGTH, never by presence — presence is
// exactly what was true while prod was broken.
const varsRes = await api(`/services/${SRV}/env-vars?limit=100`);
if (varsRes.__err) finish(3, `BLIND — cannot read env vars: ${varsRes.__err}`);
const rows = varsRes.map((x) => x.envVar || x);
const authVar = rows.find((v) => v.key === 'AUTH_SECRET');
const authLen = authVar ? (authVar.value ?? '').length : -1;

say(`env AUTH_SECRET : ${authVar ? `present, length ${authLen}` : 'ABSENT'}`);
if (!authVar || authLen === 0) {
  finish(1, `FAIL — AUTH_SECRET is ${authVar ? 'present but EMPTY' : 'absent'}; prod will re-roll its signing key on every boot.`);
}

// ---------------------------------------------------------------- window
let since = valOf('--since');
if (!since) {
  const deploys = await api(`/services/${SRV}/deploys?limit=20`);
  if (deploys.__err) finish(3, `BLIND — cannot read deploys: ${deploys.__err}`);
  const live = deploys.map((d) => d.deploy || d).find((d) => d.status === 'live' && d.finishedAt);
  if (!live) finish(3, 'BLIND — no live deploy with a finishedAt to anchor the window; pass --since=<ISO>.');
  // ⛔ ANCHOR ON createdAt, *NOT* finishedAt. The ephemeral-secret warning is
  // emitted when the auth module loads, which is EARLY in process startup and
  // therefore BEFORE the deploy is marked live: measured 2026-07-25, the warning
  // landed at 18:32:56.086Z on a deploy whose finishedAt is 18:33:07.820Z — 11.7s
  // earlier. Anchoring on finishedAt excludes exactly the line this script hunts
  // for, i.e. it returns a confident FALSE PASS on a still-broken host. The old
  // process running between createdAt and finishedAt cannot contaminate the
  // window: it logged its own warning at its own boot, long before this one.
  since = live.createdAt;
  say(`window anchor   : live deploy ${live.id} createdAt ${since} (finished ${live.finishedAt})`);
} else {
  say(`window anchor   : --since=${since}`);
}
const to = new Date().toISOString();

const owners = await api('/owners?limit=10');
if (owners.__err) finish(3, `BLIND — cannot resolve ownerId: ${owners.__err}`);
const ownerId = (owners[0]?.owner || owners[0])?.id;

async function logs({ text, level }) {
  const u = new URLSearchParams({ ownerId, resource: SRV, startTime: since, endTime: to, limit: '100' });
  if (text) u.set('text', text);
  if (level) u.set('level', level);
  const r = await fetch(`https://api.render.com/v1/logs?${u}`, { headers: H });
  if (!r.ok) return { __err: `${r.status} ${(await r.text()).slice(0, 200)}` };
  return r.json();
}

// ---------------------------------------------------------------- check 2
// Retention control: can this query see ANY warn-level line from this service
// in this window? If not, a zero below is uninformative.
const warnProbe = await logs({ level: 'warning' });
if (warnProbe.__err) finish(3, `BLIND — log query failed: ${warnProbe.__err}`);
const warnCount = (warnProbe.logs || []).length;
say(`warn-level lines: ${warnCount} in window (retention control)`);

// ---------------------------------------------------------------- check 3
// Boot control: the warning is emitted at boot and nowhere else, so a window
// containing no boot cannot produce it either way.
//
// Use the shared TRA-2261 detector rather than grepping for a boot banner. A
// hand-rolled probe here is precisely the fail-open this whole script exists to
// avoid: the first version of this file grepped text='Server listening', which
// returns 0 hits on this service because no such line is logged — so the boot
// control would have read "0 boots" forever and blinded every run. pullBootSet
// unions deploys ∪ container-death events ∪ watchdog echoes and returns
// bootCount:null (not 0) when a source is unreadable.
const bootSet = await pullBootSet({
  from: since, to, serviceId: SRV, apiKey: API_KEY, ownerId,
});
if (bootSet.blind || bootSet.bootCount === null) {
  finish(3, `BLIND — the boot detector could not read the window (${(bootSet.blindReasons || []).join('; ') || 'unknown'}), so "0 ephemeral warnings" cannot be graded against a known boot count.`, { authSecretLength: authLen, since, to, warnCount });
}
const boots = bootSet.bootCount;
say(`boots in window : ${boots}`);

// ---------------------------------------------------------------- check 4
const ephem = await logs({ text: EPHEMERAL_TEXT });
if (ephem.__err) finish(3, `BLIND — ephemeral-warning query failed: ${ephem.__err}`);
const hits = (ephem.logs || []).length;
say(`"${EPHEMERAL_TEXT}" hits: ${hits}`);

const common = { authSecretLength: authLen, since, to, warnCount, boots, ephemeralHits: hits };

if (hits > 0) {
  const ts = (ephem.logs || []).map((l) => l.timestamp).sort();
  say(`  first ${ts[0]}  last ${ts[ts.length - 1]}`);
  finish(1, `FAIL — prod emitted the ephemeral-secret warning ${hits}× after ${since}. The signing key is still per-process.`, common);
}

// hits === 0 from here. Decide whether that zero is load-bearing.
if (boots === 0) {
  finish(3, `BLIND — 0 ephemeral warnings, but also 0 boots since ${since}. The warning only fires at boot, so this window could not have produced one either way. Restart the service, or widen --since, and re-run.`, common);
}
if (warnCount === 0) {
  finish(3, `BLIND — 0 ephemeral warnings, but 0 warn-level lines of ANY kind in this window, so the query cannot be shown to retain level=warn here. The zero is a fact about the log level, not about the world.`, common);
}

finish(0, `PASS — AUTH_SECRET is ${authLen} chars, prod booted ${boots}× since ${since}, warn-level logging is demonstrably retained (${warnCount} lines), and ZERO ephemeral-secret warnings were emitted. The signing key is stable across restarts.`, common);
