#!/usr/bin/env node
// render-deploy-status.mjs — TRA-893
//
// "Is there a way to check if a build is deployed and, if it failed, pull the
// logs automatically?" — yes, this is that tool.
//
// It drives the Render REST API to:
//   1. resolve the service (by RENDER_SERVICE_ID, or by name/slug — default the live
//      public backend, whose Render `name` is `TradingAI-` and whose `slug` — and
//      therefore hostname — is `tradingai-bqb1`; see render.yaml / docs/runbook.md §1),
//   2. read the LATEST deploy and print its status / commit / timings,
//   3. if that deploy FAILED, automatically pull the build/deploy logs for the
//      deploy's time window and print them so the failure is diagnosable
//      without opening the Render dashboard.
//
// It exits non-zero on a failed deploy, so it can also be wired into a routine /
// cron / CI step as a deploy-health gate (poll after every push to main).
//
// ── Auth ──────────────────────────────────────────────────────────────────────
// Needs a Render API key (Render dashboard → Account Settings → API Keys), held
// ONLY in the environment — never commit it:
//   RENDER_API_KEY=rnd_xxx node scripts/render-deploy-status.mjs
//
// ── Options (env) ─────────────────────────────────────────────────────────────
//   RENDER_API_KEY     (required) Render API key, `rnd_…`.
//   RENDER_SERVICE_ID  (optional) `srv-…`. Skips the name lookup when set.
//   RENDER_SERVICE_NAME(optional) service name OR slug to resolve. Default `TradingAI-`.
//                      It read `tradingai-bqb1` — the SLUG — which resolves to `[]`, and
//                      the refusal blamed the API key for it (TRA-3743).
//   RENDER_LOG_LIMIT   (optional) max log lines to pull on failure. Default 200.
//   RENDER_WATCH_MS    (optional) when set, poll every N ms until the deploy
//                      reaches a terminal state (live / failed / canceled),
//                      then report. Useful right after a push.
//
// ── Exit codes ────────────────────────────────────────────────────────────────
//   0  latest deploy is live (or otherwise succeeded)
//   1  latest deploy FAILED (build/update/pre-deploy failed or canceled) — logs printed
//   2  usage / auth / API error
//   3  latest deploy is still in progress (non-terminal) and we are not watching

// The shared service resolver (TRA-3743) — one implementation, one message, for this
// script and render-redeploy.mjs.
import {
  DEFAULT_SERVICE_NAME,
  resolveServiceByName,
  explainUnresolved,
} from './lib/render-service-resolve.mjs';

const API = 'https://api.render.com/v1';

const API_KEY = process.env.RENDER_API_KEY;
const SERVICE_ID_ENV = process.env.RENDER_SERVICE_ID;
const SERVICE_NAME = process.env.RENDER_SERVICE_NAME ?? DEFAULT_SERVICE_NAME;
const LOG_LIMIT = Number(process.env.RENDER_LOG_LIMIT ?? 200);
const WATCH_MS = process.env.RENDER_WATCH_MS ? Number(process.env.RENDER_WATCH_MS) : 0;

const FAILED = new Set([
  'build_failed',
  'update_failed',
  'pre_deploy_failed',
  'canceled',
]);
const TERMINAL = new Set([...FAILED, 'live', 'deactivated']);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function fail(code, msg) {
  console.error(`[render-status] ERROR: ${msg}`);
  process.exit(code);
}

async function api(path, params) {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (Array.isArray(v)) v.forEach(item => url.searchParams.append(k, item));
    else if (v != null) url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    fail(2, `${path} → ${r.status} ${r.statusText} ${body}`.trim());
  }
  return r.json();
}

async function resolveService() {
  if (SERVICE_ID_ENV) {
    const svc = await api(`/services/${SERVICE_ID_ENV}`);
    return svc;
  }
  const r = await resolveServiceByName(SERVICE_NAME, path => api(path));
  if (!r.service) fail(2, explainUnresolved(SERVICE_NAME, r));
  if (r.matchedOn === 'slug') {
    console.log(
      `[render-status] resolved "${SERVICE_NAME}" by SLUG -> ${r.service.id} ` +
        `(Render name="${r.service.name}")`,
    );
  }
  return r.service;
}

async function latestDeploy(serviceId) {
  const list = await api(`/services/${serviceId}/deploys`, { limit: 1 });
  const d = (list[0]?.deploy ?? list[0]) || null;
  if (!d) fail(2, `service ${serviceId} has no deploys`);
  return d;
}

async function pullLogs(service, deploy) {
  // Render Logs API: requires ownerId + resource; scope to the deploy window and
  // build/deploy log types so we get the failure output, not request noise.
  const ownerId = service.ownerId ?? service.owner?.id;
  if (!ownerId) {
    console.error(
      '[render-status] could not determine ownerId; cannot query the Logs API. ' +
        'Open the deploy in the Render dashboard for logs.',
    );
    return;
  }
  const startTime = deploy.createdAt ?? deploy.created_at;
  const endTime = deploy.finishedAt ?? deploy.finished_at ?? new Date(Date.parse(startTime) + 30 * 60_000).toISOString();
  let res;
  try {
    res = await api('/logs', {
      ownerId,
      resource: [service.id],
      type: ['build', 'app'],
      startTime,
      endTime,
      limit: LOG_LIMIT,
      direction: 'backward',
    });
  } catch {
    return; // api() already reported the error
  }
  const logs = res.logs ?? res ?? [];
  if (!logs.length) {
    console.error('[render-status] no log lines returned for the deploy window.');
    return;
  }
  console.error(`\n──── build/deploy logs (${logs.length} lines, newest last) ────`);
  // `backward` returns newest-first; reverse so the terminal failure reads last.
  for (const line of [...logs].reverse()) {
    const ts = line.timestamp ?? '';
    const msg = line.message ?? JSON.stringify(line);
    console.error(`${ts} ${msg}`);
  }
  console.error('──── end logs ────');
}

function report(service, deploy) {
  const id = deploy.id;
  const status = deploy.status;
  const commit = deploy.commit?.id?.slice(0, 9) ?? '—';
  const msg = (deploy.commit?.message ?? '').split('\n')[0];
  console.log(`service : ${service.name} (${service.id})`);
  console.log(`deploy  : ${id}`);
  console.log(`status  : ${status}`);
  console.log(`commit  : ${commit} ${msg}`);
  console.log(`created : ${deploy.createdAt ?? deploy.created_at ?? '—'}`);
  console.log(`finished: ${deploy.finishedAt ?? deploy.finished_at ?? '—'}`);
}

async function main() {
  if (!API_KEY) {
    fail(
      2,
      'RENDER_API_KEY is required (Render dashboard → Account Settings → API Keys). ' +
        'Set it in the environment; never commit it.',
    );
  }
  const service = await resolveService();

  let deploy = await latestDeploy(service.id);
  if (WATCH_MS) {
    while (!TERMINAL.has(deploy.status)) {
      console.error(`[render-status] deploy ${deploy.id} is ${deploy.status}; waiting ${WATCH_MS}ms…`);
      await sleep(WATCH_MS);
      deploy = await latestDeploy(service.id);
    }
  }

  report(service, deploy);

  if (FAILED.has(deploy.status)) {
    console.error(`\n[render-status] deploy FAILED (${deploy.status}) — pulling logs…`);
    await pullLogs(service, deploy);
    process.exit(1);
  }
  if (!TERMINAL.has(deploy.status)) {
    console.error(`[render-status] deploy still in progress (${deploy.status}).`);
    process.exit(3);
  }
  console.log('[render-status] OK — latest deploy succeeded.');
  process.exit(0);
}

main().catch(e => fail(2, e?.stack ?? String(e)));
