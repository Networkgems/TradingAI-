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
// DIRECTION, stated once so it cannot be read backwards (TRA-2313): this is a FREEZE.
// It REFUSES *inside* the window and is OPEN pre-open, post-close, and all weekend.
//
// The 13:30–20:00Z bound is chosen to match the soak grader (tra1648_soak_check.mjs)
// exactly, so this gate and the acceptance check agree on the window with no DST drift.
// The freeze itself starts DEPLOY_LEAD_MIN earlier than that, because the thing that
// breaks the soak is the BOOT, not the API call — see below.
//
// ── What this gate does NOT cover (TRA-2325) ──────────────────────────────────
// It intercepts DEPLOYS. It does not — and structurally cannot — intercept an
// ENV/SETTINGS write, and an env write on this service redeploys it anyway with
// `trigger: service_updated`, *despite* `autoDeploy: no` (measured on bqb1:
// dep-d9h1j5nlk1mc738s57qg, 13:39:34Z, 9.5 min into RTH — TRA-2186). Nor does it see
// the memory watchdog's own pm2 self-restart, which writes no deploy record at all
// (TRA-2203/TRA-2261).
// ⇒ A GREEN RUN OF THIS SCRIPT IS NOT EVIDENCE THAT THE HOST IS SAFE TO TOUCH.
//   It is evidence about one of the three paths that can boot the box.
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
//   --force-embargo-override="reason"  deploy during a DATED EMBARGO anyway. Separate
//                       from --force-rth-override on purpose: an embargo is a specific
//                       board-ratified hold on a named day, so authorisation to break
//                       the routine freeze is not authorisation to break that hold.
//   --dry-run           print the gate decision and the intended call, POST nothing.
//
// ── Exit codes ────────────────────────────────────────────────────────────────
//   0  deploy triggered (or dry-run allowed)
//   2  usage / auth / API error
//   4  REFUSED — RTH freeze in effect on the soak host and no override given
//   5  REFUSED — a dated embargo covers this instant and no override given

import { pathToFileURL } from 'node:url';

const API = 'https://api.render.com/v1';

const API_KEY = process.env.RENDER_API_KEY;
const SERVICE_ID_ENV = process.env.RENDER_SERVICE_ID;
const SERVICE_NAME = process.env.RENDER_SERVICE_NAME ?? 'tradingai-bqb1';

// The one service under go-live soak. The freeze applies ONLY to this host; every
// other Render service deploys with no time gate.
const SOAK_HOST_ID = 'srv-d7mb7rr7uimc73ev0chg';
const SOAK_HOST_NAME = 'tradingai-bqb1';

// RTH window, in UTC minutes-of-day, matching tra1648_soak_check.mjs.
const RTH_OPEN_MIN = 13 * 60 + 30; // 13:30Z
const RTH_CLOSE_MIN = 20 * 60; // 20:00Z

// What fragments the soak is the BOOT, not the POST. A deploy created at 13:29Z on this
// service finishes and restarts the process ~2–3 min later, i.e. INSIDE RTH — and the
// old gate returned exit 0 for it, so a green run read as "outside the freeze" while the
// box booted mid-session (TRA-2325). The freeze therefore opens a lead time EARLY.
// It does NOT close late: a deploy created at 19:59Z boots after the bell, which is fine
// for RTH itself. (Post-close READS are protected by dated embargoes instead — a general
// close-side buffer would refuse deploys on every day of the year to protect grades that
// only exist on specific days.)
export const DEPLOY_LEAD_MIN = 5;
export const FREEZE_OPEN_MIN = RTH_OPEN_MIN - DEPLOY_LEAD_MIN; // 13:25Z
export const FREEZE_CLOSE_MIN = RTH_CLOSE_MIN; // 20:00Z

// ── Dated embargoes ───────────────────────────────────────────────────────────
// Specific, board-ratified holds on named instants — for when a scarce measurement
// needs a wider or differently-shaped window than the routine daily freeze. Absolute
// UTC instants, so there is no weekday/timezone reasoning to get backwards.
// SELF-EXPIRING: an entry whose `to` is past is inert. Leave expired rows in place as
// a record; delete them only when the ticket is closed.
export const EMBARGOES = [
  {
    from: '2026-07-27T13:25:00Z',
    // EXTENDED 20:20Z -> 21:00Z on 2026-07-26 (CTO, TRA-2306). See the note below the table:
    // the old close opened the window at the exact instant three graded reads fire.
    to: '2026-07-27T21:00:00Z',
    ticket: 'TRA-2322 (CTO-ratified) / TRA-2325 / TRA-2306',
    why:
      'TRA-2213 leg 1 (exit-cadence p99), the TRA-1648 soak sign-off and TRA-2306 all need ONE ' +
      'zero-restart RTH on bqb1, AND an undisturbed post-close read window. A boot resets the ' +
      "doTick tape and the soak clock outright; for TRA-2306 the hazard is different and worse " +
      '(see the rationale note below). Runs to 21:00Z because the graded post-close reads land ' +
      'at 20:10Z / 20:20Z / 20:25Z / 20:30Z / 20:45Z and take minutes to execute.',
  },
];

// ── Why the 2026-07-27 row closes at 21:00Z, not 20:20Z (TRA-2306, CTO 2026-07-26) ──
//
// TWO defects in the previous row, one of shape and one of rationale. Both are fixed above;
// this note exists so neither gets "corrected" back by someone re-deriving the old reason.
//
// 1. SHAPE — the old 20:20Z close opened the deploy window at the exact instant the reads it
//    exists to protect begin. Derived from the live routine table on 2026-07-26, the graded
//    post-close reads on Mon 2026-07-27 are:
//      20:10Z  d017b173  TRA-2277 parity-reconcile dailySeries
//      20:20Z  0bb90f24  TRA-2306 spread-ceiling grade   <- the first session under the gate
//      20:20Z  dcedeb43  TRA-2171/2213 doTick tape grade
//      20:25Z  7d30dcfc  TRA-1648 soak check             <- named in this very embargo
//      20:30Z  f97baf3b  TRA-2339 decided-throttle run check
//      20:45Z  7c3af47e  TRA-2331 · e3e69d35 TRA-1585
//    A deploy CREATED at 20:20:00Z BOOTS the box ~2-3 min later — i.e. inside all of them. That
//    is the same created-vs-boots confusion DEPLOY_LEAD_MIN fixes on the open side (TRA-2325),
//    left unfixed on the close side. The old row's stated derivation ("reads land at 20:02Z and
//    20:15Z") matches no routine in the table.
//
// 2. RATIONALE — "TRA-2306 is graded off in-memory counters that reset on boot" is FALSE on this
//    host. Do not cite it, and do not let its falseness be read as "the TRA-2306 hold is
//    unfounded" (it is exactly the kind of dead premise that invites --force-embargo-override).
//    hydrateCostAwareGateFromDisk re-apply()s every /data record inside the 7-day retention back
//    into the same byDay map, with no exclude-today filter — so the CURRENT day's counters are
//    rebuilt by the boot. What actually threatens the read:
//      a. the hydrate COMPACTS — it rewrites the JSONL to only the lines it kept. A boot onto a
//         wiped or repointed DATA_DIR hydrates empty and then rewrites the file to empty,
//         destroying `retained` PERMANENTLY rather than zeroing a day view (TRA-2319, and the
//         TRA-2136 env-wipe class is the live way to get there). Every health field reads like an
//         ordinary deploy either way.
//      b. a build swap mid-read: 502 on every route while it is in flight, and the grader cannot
//         tell that from an outage.
//      c. TRA-2355 changes the cost-aware-gate counters themselves — the instrument TRA-2306 is
//         grading. Landing it on main is safe (autoDeploy: no); shipping it into the graded
//         session is not.
//
// This row is spent at 21:00Z on 2026-07-27. Grades are published from the reads above, so if you
// need a deploy that evening, take it after 21:00Z rather than overriding.

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
const EMBARGO_OVERRIDE_REASON = valOf('--force-embargo-override');
const HAS_EMBARGO_OVERRIDE = argv.some(
  a => a === '--force-embargo-override' || a.startsWith('--force-embargo-override='),
);

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
export function freezeState(now) {
  const dow = now.getUTCDay(); // 0 Sun … 6 Sat
  const isWeekday = dow >= 1 && dow <= 5;
  const min = now.getUTCHours() * 60 + now.getUTCMinutes();
  const inWindow = min >= FREEZE_OPEN_MIN && min < FREEZE_CLOSE_MIN;
  return { frozen: isWeekday && inWindow, isWeekday, min };
}

// Is `now` inside a dated embargo? Half-open [from, to): an embargo that ends at 20:20Z
// is OPEN at 20:20:00Z exactly, which is the instant the ticket names as clear.
export function embargoState(now, table = EMBARGOES) {
  const t = now.getTime();
  const active = table.find(e => t >= Date.parse(e.from) && t < Date.parse(e.to)) ?? null;
  const upcoming = table
    .filter(e => Date.parse(e.from) > t)
    .sort((a, b) => Date.parse(a.from) - Date.parse(b.from))[0] ?? null;
  const minsToUpcoming = upcoming ? Math.round((Date.parse(upcoming.from) - t) / 60000) : null;
  return { active, upcoming, minsToUpcoming };
}

async function main() {
  if (!API_KEY) fail(2, 'RENDER_API_KEY is required (never commit it).');

  const service = await resolveService();
  const isSoakHost = service.id === SOAK_HOST_ID || service.name === SOAK_HOST_NAME;

  const now = new Date();
  const { frozen } = freezeState(now);
  const { active: embargo, upcoming, minsToUpcoming } = embargoState(now);
  const nowZ = now.toISOString().slice(11, 16) + 'Z';

  if (isSoakHost && embargo && !HAS_EMBARGO_OVERRIDE) {
    console.error(
      `[render-redeploy] REFUSED: ${service.name} (${service.id}) is under a DATED EMBARGO ` +
        `(${embargo.from} → ${embargo.to}, ${embargo.ticket}).\n` +
        `  ${embargo.why}\n` +
        `  Deploy before ${embargo.from} or after ${embargo.to}, or, if it is truly urgent, re-run with\n` +
        `  --force-embargo-override="why this cannot wait" (the reason is recorded).\n` +
        `  NOTE: this refusal covers DEPLOYS ONLY. An env/settings write redeploys the service too\n` +
        `  (trigger: service_updated, TRA-2186) and no guard intercepts it — hold those by hand.`,
    );
    process.exit(5);
  }

  if (isSoakHost && embargo && HAS_EMBARGO_OVERRIDE) {
    if (!EMBARGO_OVERRIDE_REASON || !EMBARGO_OVERRIDE_REASON.trim()) {
      fail(2, '--force-embargo-override requires a non-empty reason, e.g. --force-embargo-override="P0 hotfix".');
    }
    console.error(
      `[render-redeploy] WARNING: breaking the ${embargo.ticket} embargo on ${service.name} at ${nowZ}. ` +
        `Reason: ${EMBARGO_OVERRIDE_REASON}. This restart destroys — not degrades — every in-memory ` +
        `counter the embargoed reads depend on. Tell the ticket owner.`,
    );
  }

  if (isSoakHost && frozen && !HAS_OVERRIDE) {
    console.error(
      `[render-redeploy] REFUSED: ${service.name} (${service.id}) is the go-live soak host and it is ` +
        `${nowZ}, inside the RTH freeze window 13:25–20:00Z (RTH is 13:30–20:00Z; the freeze opens ` +
        `${DEPLOY_LEAD_MIN} min early because a deploy created now BOOTS the box inside RTH).\n` +
        `  A mid-RTH deploy dumps the warm quote cache and resets the TRA-1648 soak clock (see TRA-1996).\n` +
        `  Stage this deploy for pre-open (<13:25Z) or post-close (>20:00Z), or, if it is truly urgent,\n` +
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
  console.log(
    `embargo : ${
      embargo
        ? `ACTIVE ${embargo.from}→${embargo.to} (${embargo.ticket}) — OVERRIDDEN`
        : upcoming
          ? `none now; next ${upcoming.from}→${upcoming.to} (${upcoming.ticket}), in ${minsToUpcoming} min`
          : 'none scheduled'
    }`,
  );
  if (isSoakHost && !embargo && upcoming && minsToUpcoming <= 60) {
    console.log(
      `          ⚠ that embargo starts in ${minsToUpcoming} min and a deploy created now boots the box ` +
        `~${DEPLOY_LEAD_MIN} min from now. If this can wait, wait for ${upcoming.to}.`,
    );
  }
  console.log(`commit  : ${COMMIT ?? '(service branch tip)'}${CLEAR_CACHE ? ' + clear-cache' : ''}`);
  console.log('note    : this gate sees DEPLOYS only — env/settings writes redeploy the box unguarded (TRA-2186).');

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

// Run only when invoked directly, so the gate predicates above can be imported and
// exercised by scripts/tra2325-embargo-gate-check.mjs. `process.argv[1]` is absent when
// this module is imported.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch(e => fail(2, e?.stack ?? String(e)));
}
