#!/usr/bin/env node
// render-redeploy.mjs — TRA-1996 / TRA-1648
//
// The MISSING shared Render deploy *trigger* (companion to render-deploy-status.mjs,
// which only READS). Until now, deploys to the live public backend `tradingai-bqb1`
// (srv-d7mb7rr7uimc73ev0chg) were raw `POST /v1/services/{id}/deploys` curl calls
// with NO gate — which is exactly why the go-live soak's "no mid-RTH deploy" rule
// was a *convention with no technical enforcement* (TRA-1653 gap, flagged on
// TRA-1996). Every mid-RTH api deploy dumps bqb1's warm quote cache and resets the
// soak clock, disqualifying the session as the required clean acceptance sample.
//
// This wrapper turns that convention into a TECHNICAL GATE: it REFUSES to deploy the
// soak host during Regular Trading Hours (13:30–20:00 UTC, Mon–Fri) unless the caller
// passes an explicit, reasoned override. Any agent that routes bqb1 deploys through
// this script can no longer accidentally break the soak. Stage feed/host changes for
// the pre-open (<13:30Z) or post-close (>20:00Z) window instead.
//
// The 13:30–20:00Z bound is chosen to match the soak grader (tra1648_soak_check.mjs)
// exactly, so this gate and the acceptance check agree on the window with no DST drift.
//
// ── Auth ──────────────────────────────────────────────────────────────────────
//   RENDER_API_KEY=rnd_xxx node scripts/render-redeploy.mjs      (never commit the key)
//
// ── Options ───────────────────────────────────────────────────────────────────
//   RENDER_SERVICE_ID   (optional) `srv-…`. Default the soak host bqb1.
//   RENDER_SERVICE_NAME (optional) resolve by name instead. Default `tradingai-bqb1`.
//   --commit=<sha>      (optional) deploy a specific commit; default = tip of the
//                       service's branch (Render picks it).
//   --clear-cache       (optional) deploy with a cleared build cache.
//   --force-rth-override="reason"   deploy during the RTH freeze anyway. REQUIRES a
//                       non-empty reason; it is echoed so the breach is on the record.
//   --dry-run           print the gate decision and the intended call, POST nothing.
//
// ── Exit codes ────────────────────────────────────────────────────────────────
//   0  deploy triggered (or dry-run allowed)
//   2  usage / auth / API error
//   4  REFUSED — RTH freeze in effect on the soak host and no override given

const API = 'https://api.render.com/v1';

const API_KEY = process.env.RENDER_API_KEY;
const SERVICE_ID_ENV = process.env.RENDER_SERVICE_ID;
const SERVICE_NAME = process.env.RENDER_SERVICE_NAME ?? 'tradingai-bqb1';

// The one service under go-live soak. The freeze applies ONLY to this host; every
// other Render service deploys with no time gate.
const SOAK_HOST_ID = 'srv-d7mb7rr7uimc73ev0chg';
const SOAK_HOST_NAME = 'tradingai-bqb1';

// RTH freeze window, in UTC minutes-of-day, matching tra1648_soak_check.mjs.
const RTH_OPEN_MIN = 13 * 60 + 30; // 13:30Z
const RTH_CLOSE_MIN = 20 * 60; // 20:00Z

const argv = process.argv.slice(2);
const has = flag => argv.includes(flag);
const valOf = name => {
  const hit = argv.find(a => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
};

const COMMIT = valOf('--commit');
const CLEAR_CACHE = has('--clear-cache');
const DRY_RUN = has('--dry-run');
const OVERRIDE_REASON = valOf('--force-rth-override');
const HAS_OVERRIDE = argv.some(a => a === '--force-rth-override' || a.startsWith('--force-rth-override='));

function fail(code, msg) {
  console.error(`[render-redeploy] ERROR: ${msg}`);
  process.exit(code);
}

async function api(path, init) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    fail(2, `${init?.method ?? 'GET'} ${path} → ${r.status} ${r.statusText} ${body}`.trim());
  }
  return r.json();
}

async function resolveService() {
  if (SERVICE_ID_ENV) return api(`/services/${SERVICE_ID_ENV}`);
  const list = await api(`/services?name=${encodeURIComponent(SERVICE_NAME)}&limit=20`);
  const match = list.map(x => x.service ?? x).find(s => s?.name === SERVICE_NAME);
  if (!match) fail(2, `no service named "${SERVICE_NAME}" visible to this API key.`);
  return match;
}

// Is `now` inside the RTH freeze window? Weekend deploys are always allowed (market
// closed → no live soak session to fragment).
function freezeState(now) {
  const dow = now.getUTCDay(); // 0 Sun … 6 Sat
  const isWeekday = dow >= 1 && dow <= 5;
  const min = now.getUTCHours() * 60 + now.getUTCMinutes();
  const inWindow = min >= RTH_OPEN_MIN && min < RTH_CLOSE_MIN;
  return { frozen: isWeekday && inWindow, isWeekday, min };
}

async function main() {
  if (!API_KEY) fail(2, 'RENDER_API_KEY is required (never commit it).');

  const service = await resolveService();
  const isSoakHost = service.id === SOAK_HOST_ID || service.name === SOAK_HOST_NAME;

  const now = new Date();
  const { frozen } = freezeState(now);
  const nowZ = now.toISOString().slice(11, 16) + 'Z';

  if (isSoakHost && frozen && !HAS_OVERRIDE) {
    console.error(
      `[render-redeploy] REFUSED: ${service.name} (${service.id}) is the go-live soak host and it is ` +
        `${nowZ}, inside the RTH freeze window 13:30–20:00Z.\n` +
        `  A mid-RTH deploy dumps the warm quote cache and resets the TRA-1648 soak clock (see TRA-1996).\n` +
        `  Stage this deploy for pre-open (<13:30Z) or post-close (>20:00Z), or, if it is truly urgent,\n` +
        `  re-run with --force-rth-override="why this cannot wait" (the reason is recorded).`,
    );
    process.exit(4);
  }

  if (isSoakHost && frozen && HAS_OVERRIDE) {
    if (!OVERRIDE_REASON || !OVERRIDE_REASON.trim()) {
      fail(2, '--force-rth-override requires a non-empty reason, e.g. --force-rth-override="hotfix for X".');
    }
    console.error(
      `[render-redeploy] WARNING: overriding the RTH freeze on ${service.name} at ${nowZ}. ` +
        `Reason: ${OVERRIDE_REASON}. This resets the TRA-1648 soak clock — expect the session to be disqualified.`,
    );
  }

  const body = {};
  if (COMMIT) body.commitId = COMMIT;
  if (CLEAR_CACHE) body.clearCache = 'clear';

  console.log(`service : ${service.name} (${service.id})`);
  console.log(`window  : ${nowZ} — ${isSoakHost ? (frozen ? 'RTH FREEZE (soak host)' : 'outside freeze') : 'not the soak host'}`);
  console.log(`commit  : ${COMMIT ?? '(service branch tip)'}${CLEAR_CACHE ? ' + clear-cache' : ''}`);

  if (DRY_RUN) {
    console.log('[render-redeploy] --dry-run: would POST /services/%s/deploys %j', service.id, body);
    process.exit(0);
  }

  const deploy = await api(`/services/${service.id}/deploys`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const d = deploy.deploy ?? deploy;
  console.log(`deploy  : ${d.id ?? '(unknown id)'} — ${d.status ?? 'triggered'}`);
  console.log('[render-redeploy] deploy triggered. Poll with scripts/render-deploy-status.mjs (RENDER_WATCH_MS=…).');
  process.exit(0);
}

main().catch(e => fail(2, e?.stack ?? String(e)));
