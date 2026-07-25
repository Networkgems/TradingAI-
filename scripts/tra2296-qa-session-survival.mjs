#!/usr/bin/env node
// TRA-2296 QA re-verification — does a SESSION SURVIVE A BOOT on bqb1?
//
// Companion to scripts/tra2296-auth-secret-check.mjs (CTO). That script grades
// the ENV ROW and the BOOT LOGS. This one grades the RUNNING PROCESS's actual
// signing key, which is the property users experience and the only one that
// cannot be faked by a correct-looking dashboard value.
//
// WHY A PLAIN "log in, restart, log in again" TEST IS NOT ENOUGH
// -------------------------------------------------------------
// A 200 after a restart shows *a* token worked across *that* boot. It does not
// show WHICH KEY signed it, so it cannot distinguish:
//   (a) the process is using the durable AUTH_SECRET from the environment
//       — sessions survive every future boot, which is the fix; from
//   (b) the process re-rolled an ephemeral key but you happened to re-mint the
//       token after the boot, or the boot never actually happened.
// Only (a) is the fix. So this script binds the live process's key to the env
// value DIRECTLY, in both directions:
//
//   K1  SIGN direction   — the live process mints a token via the real
//                          /api/auth/login credential path; we recompute the
//                          HMAC offline with the AUTH_SECRET read from the
//                          Render env API. Match ⇒ the process SIGNS with the
//                          durable env secret.
//   K2  VERIFY direction — we mint a token OFFLINE with the env secret and
//                          present it. 200 ⇒ the process VERIFIES with the
//                          durable env secret.
//   C1  CROSS-BOOT       — the K2 token is stamped with `iat` EARLIER than the
//                          live process's own `startedAt` (read from
//                          /api/health/version). A token that predates this
//                          process's boot and still authenticates against it IS
//                          the contract's "session survives a restart" — and it
//                          needs no new restart, so it costs no deploy.
//
// K1+K2 together are strictly stronger than an empirical restart test: the env
// value is durable by construction, so a process that both signs and verifies
// with it will accept tokens from every past and future process that does the
// same.
//
// CONTROLS — every leg must be able to FAIL, or its pass is worthless
// -------------------------------------------------------------------
//   N1  a token minted offline with a WRONG secret        must 401
//         ⇒ proves K2's 200 is not "this route accepts anything"
//   N2  the real K1 token with ONE character of its sig flipped  must 401
//         ⇒ proves HMAC verification is genuinely live
//   N3  no Authorization header at all                    must 401
//         ⇒ proves the route is actually protected
//   N4  K1's offline recomputation, redone with a WRONG secret, must NOT match
//         ⇒ proves the K1 comparison can distinguish keys at all
//         (without this, a bug that returns "equal" always would read as PASS)
//
// A leg whose control does not behave is reported BLIND, never PASS.
//
// Exit codes:  0 PASS   1 FAIL   2 usage   3 BLIND (cannot decide)
//
// Usage:
//   RENDER_API_KEY=rnd_… node scripts/tra2296-qa-session-survival.mjs [--json]
//     [--service=srv-…] [--host=https://…]

import { createHmac } from 'node:crypto';

const SRV_DEFAULT = 'srv-d7mb7rr7uimc73ev0chg'; // tradingai-bqb1
const HOST_DEFAULT = 'https://tradingai-bqb1.onrender.com';
const PROTECTED_ROUTE = '/api/auth/me'; // requireAuth, no side effects

const argv = process.argv.slice(2);
const valOf = (flag) => {
  const hit = argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
};
const JSON_OUT = argv.includes('--json');
const SRV = valOf('--service') ?? SRV_DEFAULT;
const HOST = (valOf('--host') ?? HOST_DEFAULT).replace(/\/$/, '');
const API_KEY = process.env.RENDER_API_KEY;

const out = [];
const say = (s) => { out.push(s); if (!JSON_OUT) console.log(s); };
const legs = {};

function finish(code, verdict, extra = {}) {
  if (JSON_OUT) console.log(JSON.stringify({ verdict, exitCode: code, legs, ...extra, lines: out }, null, 2));
  else say(`\nVERDICT: ${verdict}`);
  process.exit(code);
}

if (!API_KEY) {
  console.error('RENDER_API_KEY is required (never commit it).');
  process.exit(2);
}

async function renderApi(path) {
  const r = await fetch(`https://api.render.com/v1${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' },
  });
  if (!r.ok) return { __err: `${r.status} ${(await r.text()).slice(0, 200)}` };
  return r.json();
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const signWith = (secret, encodedPayload) =>
  createHmac('sha256', secret).update(encodedPayload).digest('base64url');

// Mirrors packages/server/src/auth.ts createToken().
function mintOffline(secret, username, issuedAt) {
  const payload = b64url(JSON.stringify({ sub: username, iat: issuedAt }));
  return `${payload}.${signWith(secret, payload)}`;
}

async function authed(token) {
  const headers = token === null ? {} : { Authorization: `Bearer ${token}` };
  const r = await fetch(`${HOST}${PROTECTED_ROUTE}`, { headers });
  return r.status;
}

// ------------------------------------------------------------------ setup
// The secret and the admin credentials both come from the Render env API.
// Graded by VALUE, never presence — "present" was true for the whole outage.
const varsRes = await renderApi(`/services/${SRV}/env-vars?limit=100`);
if (varsRes.__err) finish(3, `BLIND — cannot read env vars: ${varsRes.__err}`);
const rows = varsRes.map((x) => x.envVar || x);
const pick = (k) => rows.find((v) => v.key === k)?.value;

const secret = pick('AUTH_SECRET');
const adminUser = pick('ADMIN_USERNAME') ?? 'admin';
const adminPass = pick('ADMIN_PASSWORD');

say(`env AUTH_SECRET     : ${secret === undefined ? 'ABSENT' : `present, length ${secret.length}`}`);
say(`env keys total      : ${rows.length}, empty-valued: ${JSON.stringify(rows.filter((v) => (v.value ?? '') === '').map((v) => v.key))}`);
legs.envSecretLength = secret === undefined ? -1 : secret.length;

if (!secret || secret.trim().length === 0) {
  finish(1, 'FAIL — AUTH_SECRET is absent or empty; every boot re-rolls the signing key.');
}
if (!adminPass) finish(3, 'BLIND — ADMIN_PASSWORD unreadable, cannot exercise the real login path.');

// Process identity. `startedAt` is the per-process witness we anchor C1 on.
const verRes = await fetch(`${HOST}/api/health/version`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
if (!verRes?.startedAt) finish(3, 'BLIND — /api/health/version did not report startedAt; no process witness.');
const startedAt = Date.parse(verRes.startedAt);
say(`live process        : pid ${verRes.pid}, commit ${String(verRes.commitShort ?? '').slice(0, 7)}, startedAt ${verRes.startedAt}, uptime ${verRes.uptimeSec}s`);
legs.process = { pid: verRes.pid, commit: verRes.commit, startedAt: verRes.startedAt, uptimeSec: verRes.uptimeSec };

// ------------------------------------------------------------------ K1
// SIGN direction: does the live process sign with the durable env secret?
say('');
say('K1  SIGN direction — live /api/auth/login token, recomputed offline');
const loginRes = await fetch(`${HOST}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: adminUser, password: adminPass }),
});
const loginBody = await loginRes.json().catch(() => ({}));
if (loginRes.status !== 200 || !loginBody.token) {
  const why = loginBody.twoFactorRequired ? '2FA required — no session token issued' : `status ${loginRes.status}`;
  finish(3, `BLIND — could not mint a token via the real login path (${why}).`);
}
const liveToken = loginBody.token;
const dot = liveToken.lastIndexOf('.');
const livePayload = liveToken.slice(0, dot);
const liveSig = liveToken.slice(dot + 1);
const recomputed = signWith(secret, livePayload);
const k1Match = recomputed === liveSig;

// N4 — the comparison must be able to say "different".
const wrongSecret = `${secret}-wrong`;
const n4Differs = signWith(wrongSecret, livePayload) !== liveSig;

const claims = JSON.parse(Buffer.from(livePayload, 'base64url').toString());
say(`  token payload     : sub=${claims.sub} iat=${new Date(claims.iat).toISOString()}`);
say(`  sig recomputed with env AUTH_SECRET matches : ${k1Match}`);
say(`  N4 control — recomputed with a WRONG secret differs : ${n4Differs}`);
legs.K1 = { match: k1Match, controlDiffers: n4Differs };

if (!n4Differs) finish(3, 'BLIND — N4 control failed: the offline comparison cannot distinguish keys.');
if (!k1Match) {
  finish(1, 'FAIL — the live process is NOT signing with the AUTH_SECRET in the environment (ephemeral or stale key).');
}

// ------------------------------------------------------------------ K2 + C1
// VERIFY direction, with an `iat` that PREDATES this process's own boot.
say('');
say('K2/C1  VERIFY direction — offline-minted token, iat BEFORE this process booted');
const preBootIat = startedAt - 60_000; // one minute before this process existed
const offlineToken = mintOffline(secret, adminUser, preBootIat);
const k2Status = await authed(offlineToken);
const c1Ok = preBootIat < startedAt;
say(`  token iat         : ${new Date(preBootIat).toISOString()}  (process startedAt ${verRes.startedAt})`);
say(`  iat predates boot : ${c1Ok}`);
say(`  ${PROTECTED_ROUTE} -> ${k2Status}   (expect 200)`);
legs.K2 = { status: k2Status, iat: new Date(preBootIat).toISOString(), predatesBoot: c1Ok };

// ------------------------------------------------------------------ controls
say('');
say('Negative controls — each MUST be 401 or the 200s above prove nothing');
const n1 = await authed(mintOffline(wrongSecret, adminUser, Date.now()));
const flipped = liveSig[0] === 'A' ? `B${liveSig.slice(1)}` : `A${liveSig.slice(1)}`;
const n2 = await authed(`${livePayload}.${flipped}`);
const n3 = await authed(null);
const n0 = await authed(liveToken); // positive: the real live token
say(`  N1 wrong-secret token   -> ${n1}   (expect 401)`);
say(`  N2 tampered signature   -> ${n2}   (expect 401)`);
say(`  N3 no Authorization     -> ${n3}   (expect 401)`);
say(`  P0 real live token      -> ${n0}   (expect 200)`);
legs.controls = { wrongSecret: n1, tampered: n2, noAuth: n3, realToken: n0 };

const controlsOk = n1 === 401 && n2 === 401 && n3 === 401 && n0 === 200;
if (!controlsOk) {
  finish(3, 'BLIND — negative controls did not behave; a 200 on this route is not evidence of anything.');
}
if (k2Status !== 200) {
  finish(1, `FAIL — a token signed with the durable AUTH_SECRET was REJECTED (${k2Status}); the process is not verifying with the env secret.`);
}
if (!c1Ok) finish(3, 'BLIND — could not stamp an iat before the process boot.');

finish(
  0,
  'PASS — the live process both signs and verifies with the durable AUTH_SECRET from the environment, ' +
    'and accepts a token stamped before its own boot. Sessions survive restarts.',
);
