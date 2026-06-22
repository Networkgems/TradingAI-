#!/usr/bin/env node
// redeploy-trading-server.mjs — TRA-793
//
// Self-serve redeploy for the NON-ELEVATED agent fleet. Historically, adopting a
// freshly built `dist` on the self-hosted `trading-server` (localhost:4242)
// required Administrator / LOCAL_SYSTEM to `pm2 restart` the SYSTEM-owned PM2
// daemon (ops/install-pm2-autostart.ps1, TRA-605) — the fleet user
// PRIMEROGA\eetienne gets EPERM. This script removes that dependency by driving
// the authenticated `POST /api/admin/restart` control route (added in TRA-793),
// which triggers the same graceful shutdown SIGTERM does and lets PM2
// (autorestart:true) relaunch the worker onto the current build.
//
// Flow:
//   1. (optional) build `dist`  — `pnpm --filter @trading-app/server build`
//   2. POST /api/admin/restart  — admin-only; process exits, PM2 relaunches
//   3. poll GET /api/health      — wait for the new process to answer
//   4. assert acceptance         — /api/research/shadow-signals == 200 AND
//                                  /api/state includes `supertrendShadowSignals`
//
// Auth mirrors scripts/post-research-report.mjs: pass ADMIN_TOKEN, or
// ADMIN_PASSWORD (+ optional ADMIN_USERNAME, default `admin`) to log in. A
// pre-issued ADMIN_TOKEN that has expired is transparently re-minted from the
// password if one is available.
//
// Usage:
//   ADMIN_PASSWORD=… node scripts/redeploy-trading-server.mjs
//   ADMIN_PASSWORD=… node scripts/redeploy-trading-server.mjs --no-build
//   API_BASE=http://localhost:4242 ADMIN_TOKEN=… node scripts/redeploy-trading-server.mjs
//
// Exit codes: 0 ok · 2 usage · 3 auth · 4 restart call failed · 5 health
// timeout · 6 acceptance check failed.

import { spawnSync } from 'node:child_process';

function fail(code, msg) {
  console.error(`[redeploy] ERROR: ${msg}`);
  process.exit(code);
}

const argv = new Set(process.argv.slice(2));
const NO_BUILD = argv.has('--no-build');
const REASON =
  process.argv.slice(2).find(a => a.startsWith('--reason='))?.slice('--reason='.length) ??
  'fleet redeploy (TRA-793)';

const API_BASE = (process.env.API_BASE ?? 'http://localhost:4242').replace(/\/+$/, '');
const HEALTH_TIMEOUT_MS = Number(process.env.HEALTH_TIMEOUT_MS ?? 60_000);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 1. Build dist (so the relaunch adopts a fresh build) ──────────────────────
if (!NO_BUILD) {
  console.log('[redeploy] building @trading-app/server dist…');
  const build = spawnSync('pnpm', ['--filter', '@trading-app/server', 'build'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (build.status !== 0) fail(2, `build failed (exit ${build.status})`);

  // TRA-959: also rebuild the served web bundle (apps/desktop). The server
  // serves apps/desktop/dist as its static frontend, and that dist is
  // git-ignored (built per-clone). Without this step a redeploy adopts fresh
  // BACKEND code but strands the OLD frontend bundle — which is exactly how the
  // TRA-974 marketing-copy fix (e0a6b96) shipped to source yet kept advertising
  // archived "Reversal, MACD" strategies on the live Stocks card. Keep this in
  // lockstep with the server build so source UI fixes actually reach users.
  console.log('[redeploy] building desktop web bundle (apps/desktop dist)…');
  const webBuild = spawnSync('pnpm', ['--filter', 'desktop', 'vite:build'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (webBuild.status !== 0) fail(2, `web bundle build failed (exit ${webBuild.status})`);
} else {
  console.log('[redeploy] --no-build: skipping build, restarting onto existing dist.');
}

// ── 2. Authenticate ───────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const canPasswordLogin = typeof ADMIN_PASSWORD === 'string' && ADMIN_PASSWORD.length > 0;

async function loginWithPassword() {
  const username = process.env.ADMIN_USERNAME ?? 'admin';
  const r = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: ADMIN_PASSWORD }),
  });
  if (!r.ok) fail(3, `Login failed: ${r.status} ${await r.text().catch(() => '')}`);
  const body = await r.json();
  if (!body || typeof body.token !== 'string') fail(3, 'Login response missing token');
  return body.token;
}

let token;
let fromToken = false;
if (process.env.ADMIN_TOKEN) {
  token = process.env.ADMIN_TOKEN;
  fromToken = true;
} else if (canPasswordLogin) {
  token = await loginWithPassword();
} else {
  fail(3, 'No ADMIN_TOKEN and no ADMIN_PASSWORD — cannot authenticate.');
}

// ── 3. Trigger the restart ────────────────────────────────────────────────────
async function postRestart(bearer) {
  return fetch(`${API_BASE}/api/admin/restart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ reason: REASON }),
  });
}

console.log(`[redeploy] POST ${API_BASE}/api/admin/restart …`);
let r = await postRestart(token).catch(e => fail(4, `restart request errored: ${e.message}`));
// Self-heal a stale static token, same as post-research-report.mjs.
if ((r.status === 401 || r.status === 403) && fromToken && canPasswordLogin) {
  console.error(`[redeploy] static ADMIN_TOKEN rejected (${r.status}); re-authenticating.`);
  token = await loginWithPassword();
  r = await postRestart(token).catch(e => fail(4, `restart request errored: ${e.message}`));
}
if (r.status !== 202 && !r.ok) {
  fail(4, `POST /api/admin/restart failed: ${r.status} ${await r.text().catch(() => '')}`);
}
console.log(`[redeploy] restart accepted (${r.status}); the process is exiting for PM2 relaunch.`);

// ── 4. Wait for the relaunched process to report healthy ──────────────────────
// Give PM2 its restart_delay (3s) plus margin before we start polling, so we
// don't immediately see the OLD process still answering on the way down.
await sleep(4_000);
const deadline = Date.now() + HEALTH_TIMEOUT_MS;
let healthy = false;
while (Date.now() < deadline) {
  try {
    const h = await fetch(`${API_BASE}/api/health`);
    if (h.ok) {
      healthy = true;
      break;
    }
  } catch {
    /* process still down — keep polling */
  }
  await sleep(1_000);
}
if (!healthy) fail(5, `server did not report healthy within ${HEALTH_TIMEOUT_MS}ms after restart`);
console.log('[redeploy] server is healthy again.');

// ── 5. Acceptance check (TRA-793) ─────────────────────────────────────────────
const authHeaders = { Authorization: `Bearer ${token}` };

const shadow = await fetch(`${API_BASE}/api/research/shadow-signals`, { headers: authHeaders });
if (shadow.status !== 200) {
  fail(6, `/api/research/shadow-signals returned ${shadow.status} (expected 200)`);
}
console.log('[redeploy] ✓ /api/research/shadow-signals → 200');

const state = await fetch(`${API_BASE}/api/state`, { headers: authHeaders });
if (!state.ok) fail(6, `/api/state returned ${state.status}`);
const stateBody = await state.json().catch(() => null);
if (!stateBody || !('supertrendShadowSignals' in stateBody)) {
  fail(6, '/api/state did not include `supertrendShadowSignals`');
}
console.log('[redeploy] ✓ /api/state includes `supertrendShadowSignals`');

console.log('[redeploy] DONE — trading-server is running the fresh dist with no SYSTEM action.');
