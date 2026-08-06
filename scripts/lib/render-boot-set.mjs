// TRA-2261 — "did this box restart during my window?", answered from ALL the sources.
//
// ⛔ THE DEPLOYS API CANNOT ANSWER THIS QUESTION, AND IT ANSWERS IT ANYWAY.
//
//   THREE THINGS BOOT THIS PROCESS. ONLY TWO OF THEM WRITE A DEPLOY RECORD:
//     1. git push               -> deploy record   (killed by `autoDeploy: no` on bqb1)
//     2. env/settings write     -> deploy record   (`service_updated`; gated by NOTHING — TRA-2186)
//     3. WATCHDOG SELF-RESTART  -> ***NO RECORD*** (pm2 relaunch inside the container, not a Render
//                                  deploy. `POST /api/admin/restart` takes the same path.)
//
// So `deploys.length === 0` is a confident, checkable-looking, FALSE all-clear. Measured on bqb1
// during Fri 2026-07-24 RTH (13:30–20:00Z): FOUR boots, of which the deploys API can see TWO.
//
// ⭐ POSITIVE CONTROL for what that costs: over 19:50–20:05Z a deploys-only detector printed
//   `RESTARTS: none in this window — the grade above is steady-state ✓` on a window that is 49.6%
//   BOOT TRANSIENT. A boot-exclusion pass whose boot list is incomplete does not degrade gracefully;
//   it stamps a transient-dominated window as steady state. (TRA-2205: several doTick sinks throttle
//   off a `lastXAt` that initialises to 0, so they ALL fire on the first tick of every process.)
//
// This module is the ONE implementation of the boot set. It was proven as the C0 leg of the TRA-1648
// soak checker (rev 3, 07-24) and is lifted here verbatim in behaviour so that every other consumer —
// the doTick tape (TRA-2203/2262), the TRA-2213 clean-RTH precondition, any future cadence grader —
// stops asking the deploys API a question it structurally cannot answer.
//
// FAIL-CLOSED CONTRACT, and it is the whole point: when a source is unreadable this returns
// `blind: true` and REFUSES to report a count. It does NOT fall back to the deploy list, because
// falling back to the deploy list IS the bug. Callers must branch on `blind` BEFORE `bootCount`;
// `assertContinuous()` below does that for you.
//
// ⚠️ STATED RESIDUAL, not fixed: `POST /api/admin/restart` on a box that has NEVER tripped emits no
// watchdog echo and writes no deploy record, and (empirically, not by guarantee) may not surface a
// container-death event either. Every restart path OBSERVED on this service to date leaves one of the
// three witnesses — that is an observation, not a proof. Do not read `bootCount === 0` as "no process
// on earth restarted this box"; read it as "none of the three witnesses saw one".

export const BOOT_CLUSTER_MS = 90_000;

// Render event types that mean the container died. `server_failed` is the one bqb1 actually emits
// (`{evicted:false, nonZeroExit:1}` for a watchdog `process.exit(1)`).
export const RESTART_EVENT_RE = /restart|crash|oom|server_failed|health_check_failed/i;

// ── The watchdog log filter, and why it needs a classifier ───────────────────────────────────────
//
// A Render logs query with `text=self-restarting` returns THREE materially different kinds of line,
// because all three carry the same `detail` sentence ("… self-restarting before the platform
// hard-kill"). The `msg` field is what separates them, and READING THAT FIELD IS THE WHOLE TRICK:
//
//   TRIP        `WATCHDOG TRIP — self-restarting to clear starved event loop`        (level=error)
//                 The DYING process. One line per genuine incident. NOT a boot — the boot is the
//                 echo the relaunched process emits a few seconds later.
//   BOOT        `prior watchdog self-restart detected on boot`                       (level=warn)
//                 The NEWLY BOOTED process echoing the DURABLE `lastTrip` breadcrumb. ONE PER BOOT —
//                 and it re-echoes the SAME trip on every later boot, so (lag,rss) legitimately
//                 repeats across genuinely different boots.
//   SUPPRESSED  `watchdog trip suppressed during boot grace — warmup loop block …`   (level=warn)
//                 The watchdog DECLINING to restart. NOT an incident and NOT a boot — it is the
//                 OPPOSITE of one. Measured 2026-07-24T20:03:28Z carrying a 12717 ms lag; filed as a
//                 fourth self-restart by a reader who counted lines.
//
// ⭐⭐⭐ A naive /WATCHDOG TRIP/i matches "watchdog trip SUPPRESSED", because a substring filter
// selects on the WORD, and the text describing an action contains the word for that action —
// INCLUDING in the lines that say the action did not happen.
//
// ⛔⭐⭐⭐ TRA-3049 (2026-08-06) — THE SAME USE-VS-MENTION CLASS, TWICE MORE, QUARANTINED AT THE
// SOURCE INSTEAD OF BY A CALLER'S PRECONDITION. The block above documents the trap for SUPPRESSED
// and then the very next `if` re-commits it:
//
//   EXTERNAL_KILL     `prior process died WITHOUT a watchdog trip — external kill (SIGKILL 137 /
//                      health-check SIGTERM) suspected`                              (level=warn)
//                       `event-loop-watchdog.ts:961`. A line whose WHOLE JOB is to report the
//                       ABSENCE of a trip, scored as a trip. MEASURED (LeadDev, TRA-3042 §3,
//                       `text=external kill` over 07-30..08-06T06:00Z): 55 lines, classifier kinds
//                       {"TRIP": 55}, `distinctTrips` 1 ⇒ a caller that saw these REDS EVERY DAY.
//   BREADCRUMB_ERROR  `failed to persist watchdog trip breadcrumb`                   (level=warn)
//                       `event-loop-watchdog.ts:245`. Found by ENUMERATING all ten `log.*` calls in
//                       the emitting module rather than treating the ticket's one line as the whole
//                       population. Same class — the subject is a FILE WRITE, not the loop — and it
//                       carries no `lagMaxMs`/`rssMB`, so it dedupes on `?|?` and would add a
//                       PHANTOM SECOND distinct trip beside the real one it fires next to.
//
// Neither is reachable from any shipped call site today: every one of them pre-filters on
// `self-restarting` (which neither payload contains) or reads `level=error` (both are warn). That is
// PRECISELY why they are fixed here — **a defect quarantined by a caller-side precondition is one
// refactor away from being live, and a precondition in a JSDoc is not a control.**
//
// ⚠️ THE QUARANTINE IS DIRECTIONAL AND MUST STAY THAT WAY: it must never swallow a REAL trip.
// `without a watchdog trip` is inherently a negation-of-trip phrase and cannot occur in a line
// ASSERTING one. Both arms are asserted in `render-boot-set.test.mjs` (trap not counted **and** a
// real `WATCHDOG TRIP — self-restarting…` line still scores TRIP) — a quarantine that swallows the
// real trip is worse than the bug it fixes.
//
// ⚠️ DELIBERATELY NOT CHANGED, AND WORTH A FOLLOW-UP: an EXTERNAL_KILL line is emitted AT BOOT by
// the newly-started process, so it is a FOURTH boot witness — the one that would cover this module's
// own STATED RESIDUAL above (`POST /api/admin/restart` on a box that never tripped writes no deploy
// record and emits no watchdog echo). Feeding it into `buildBootSet` CHANGES VERDICTS, so it is
// recorded here rather than smuggled into a hardening ticket.
//
// Order matters: SUPPRESSED, EXTERNAL_KILL and BREADCRUMB_ERROR must all be tested BEFORE TRIP.
// Anything unrecognised is UNCLASSIFIED, which blinds the caller: a new log variant must make this
// say "I do not know what I am looking at", never silently pick whichever bucket the regexes happen
// to leave open. The two new kinds are NAMED rather than left UNCLASSIFIED on purpose — they are
// known shapes with a known NON-incident meaning, so blinding on them would trade a false RED for a
// false HELD every time one appeared.
export function classifyWatchdogLine(line) {
  let rec;
  try { rec = JSON.parse(line.message); } catch { rec = {}; }
  const detail = rec.detail ?? String(line.message ?? '');
  const msg = String(rec.msg ?? line.message ?? '');
  const kind = /prior watchdog self-restart detected on boot/i.test(msg) ? 'BOOT'
    : /suppress/i.test(msg) ? 'SUPPRESSED'
      : /without a watchdog trip/i.test(msg) ? 'EXTERNAL_KILL'
        : /failed to persist watchdog (trip|liveness) breadcrumb/i.test(msg) ? 'BREADCRUMB_ERROR'
          : /WATCHDOG TRIP/i.test(msg) ? 'TRIP'
            : 'UNCLASSIFIED';
  return {
    at: line.timestamp,
    kind,
    lag: rec.lagMaxMs ?? /max lag (\d+)ms/.exec(detail)?.[1] ?? '?',
    rss: rec.rssMB ?? '?',
  };
}

// ⛔ THE TWO DEDUPE RULES ARE OPPOSITE, AND BOTH ARE CORRECT — FOR DIFFERENT QUESTIONS.
//
//   COUNTING TRIPS (an incident rate) -> dedupe on (lag, rss). Identical pairs are replays of ONE
//     event: 13 lines across 07-22→24 all carry `lag=5788ms rssMB=787` and describe a single trip.
//     Counting the raw lines reports "13 trips this week", which is a FABRICATED INCIDENT RATE.
//   BUILDING A BOOT SET -> do NOT dedupe on (lag, rss). Two DIFFERENT boots legitimately echo the
//     SAME durable trip: measured 07-24, the identical `lag=5788ms rssMB=787` pair appears at
//     15:59:44Z and 16:15:25Z — ONE trip, TWO boots. Collapsing them DELETES A REAL BOOT.
//
// The boot set below therefore clusters by TIME instead. The discriminator is the MESSAGE and the
// INSTANT, never the magnitude.
export function distinctTrips(classified) {
  const seen = new Set();
  return classified.filter(l => l.kind === 'TRIP').filter(t => {
    const k = `${t.lag}|${t.rss}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Collapse boot candidates from several witnesses into one boot per cluster. Candidates must be
 * `{ at, src, label }`; the result carries every witness that saw each boot, which is what lets a
 * caller say "this boot was invisible to the deploys API".
 */
export function clusterBoots(candidates, clusterMs = BOOT_CLUSTER_MS) {
  const sorted = [...candidates].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const boots = [];
  for (const c of sorted) {
    const last = boots[boots.length - 1];
    if (last && new Date(c.at).getTime() - new Date(last.at).getTime() <= clusterMs) {
      if (!last.srcs.includes(c.src)) last.srcs.push(c.src);
      last.labels.push(c.label);
      continue;
    }
    boots.push({ at: c.at, srcs: [c.src], labels: [c.label] });
  }
  return boots;
}

/**
 * PURE core. Give it the already-fetched payloads plus an honest ok-flag per source; it decides
 * blindness and builds the boot set. Kept separate from the IO shell so the discrimination suite
 * exercises THE CODE THE GRADERS RUN, not a copy of it.
 *
 * @param {object} a
 * @param {string} a.from  window open  (ISO)
 * @param {string} a.to    window close (ISO)
 * @param {number} [a.preWindowMs]  also report boots this long BEFORE `from` — a deploy that lands
 *   just outside the left edge still projects its boot transient INTO the window. These are returned
 *   in `bootsWithPreWindow` and NEVER counted in `bootCount`.
 * @param {{timestamp:string,message:string}[]} a.watchdogLines  logs, `text=self-restarting`
 * @param {boolean} a.watchdogOk        that fetch succeeded
 * @param {number}  a.coverageLineCount UNFILTERED log lines over the same window (existence control)
 * @param {boolean} a.coverageOk        that fetch succeeded
 * @param {object[]} a.deploys          /services/{id}/deploys entries (need `finishedAt`)
 * @param {boolean} a.deploysOk         that fetch succeeded
 * @param {object[]} a.events           /services/{id}/events entries (need `timestamp`, `type`)
 * @param {boolean} a.eventsOk          that fetch succeeded
 * @param {string}  [a.eventsQueryFrom] if the events read was TIME-BOUNDED, the `startTime` it asked
 *   for. Coverage of a bounded query cannot be judged by "how old is the oldest record I hold" — a
 *   quiet service legitimately holds no event older than the window, and that reads IDENTICAL to a
 *   page that stopped short. Supply this and coverage is judged on what was ASKED FOR + saturation.
 * @param {boolean} [a.eventsTruncated] the bounded events read came back at its `limit` ⇒ there may
 *   be older events inside the window that were never fetched.
 * @param {boolean} [a.watchdogTruncated] the `text=self-restarting` read reported more pages ⇒ trips
 *   inside the window were never fetched. A truncated trip page UNDER-counts, which is the direction
 *   that reads as "clean".
 * @param {(d:object)=>string} [a.deployLabel]  optional attribution ("why did this deploy happen")
 */
export function buildBootSet({
  from, to, preWindowMs = 0,
  watchdogLines = [], watchdogOk = true, watchdogTruncated = false,
  coverageLineCount = 0, coverageOk = true,
  deploys = [], deploysOk = true,
  events = [], eventsOk = true, eventsQueryFrom = null, eventsTruncated = false,
  clusterMs = BOOT_CLUSTER_MS, deployLabel,
}) {
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  const leftEdgeMs = fromMs - preWindowMs;
  const inSpan = (t) => {
    const ms = new Date(t).getTime();
    return Number.isFinite(ms) && ms >= leftEdgeMs && ms <= toMs;
  };

  const classified = watchdogLines.map(classifyWatchdogLine)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const unclassified = classified.filter(l => l.kind === 'UNCLASSIFIED');
  const suppressed = classified.filter(l => l.kind === 'SUPPRESSED' && inSpan(l.at));
  const trips = distinctTrips(classified.filter(l => inSpan(l.at)));

  // ⛔ A DEPLOY'S BOOT INSTANT IS `finishedAt` — NEVER the `deploy_started` event timestamp. They are
  // ~100 s apart on this service, which is WIDER than the 90 s cluster, so keying on the event makes
  // each deploy's own boot echo fail to collapse into it and get counted as a second, PHANTOM,
  // "invisible" boot. Measured: that one field inflated 07-24 from 4 boots (2 invisible) to 6 (4) —
  // i.e. it re-committed the exact over-count this module exists to prevent. It also catches the
  // converse fail-open: a deploy that STARTS before the window and FINISHES inside it boots the
  // process mid-session while its `deploy_started` sits outside the filter entirely.
  const deployBoots = deploys
    .map(d => d.deploy ?? d)
    .filter(d => d.finishedAt && inSpan(d.finishedAt))
    .map(d => ({
      at: d.finishedAt,
      src: 'DEPLOY',
      label: `[${d.id}] ${deployLabel ? deployLabel(d) : `trigger=${typeof d.trigger === 'string' ? d.trigger : JSON.stringify(d.trigger)}`}`,
    }));

  const normEvents = events.map(e => e.event ?? e);
  const deathBoots = normEvents
    .filter(e => e.timestamp && inSpan(e.timestamp) && RESTART_EVENT_RE.test(String(e.type ?? '')))
    .map(e => ({ at: e.timestamp, src: 'EVENT', label: `${e.type} (container death — Render event stream)` }));

  const echoBoots = classified
    .filter(l => l.kind === 'BOOT' && inSpan(l.at))
    .map(l => ({
      at: l.at,
      src: 'WATCHDOG',
      label: `boot after self-restart (echoes trip lag=${l.lag}ms rss=${l.rss}MB) — a pm2 relaunch, `
        + 'which on its own writes NO deploy record',
    }));

  // Did each paged source reach back far enough to have SEEN the window open? If the oldest record we
  // hold is still newer than `from`, there may be boots inside the window we simply never fetched —
  // that is blind, not clean. (Fourth time on the soak gate that absence of FETCHED evidence was read
  // as absence of EVENTS: C-1's idle host, C1's single-page fetch, C4's self-clearing flag, C0's
  // single source. The fix is the same every time: enumerate the sources, fail closed on an unread one.)
  const oldest = (arr, pick) => arr.map(pick).filter(Boolean).sort()[0] ?? null;
  const oldestDeploy = oldest(deploys.map(d => d.deploy ?? d), d => d.finishedAt || d.createdAt);
  const oldestEvent = oldest(normEvents, e => e.timestamp);

  const blindReasons = [];
  if (!watchdogOk) blindReasons.push('watchdog log probe (text=self-restarting) FAILED');
  else if (watchdogTruncated) blindReasons.push('the watchdog log page was TRUNCATED (more matching lines exist than were fetched) — the trip count and the echo-boot set are both lower bounds, and a lower bound reads as "clean"');
  if (!coverageOk) blindReasons.push('log coverage probe FAILED');
  // The existence control that makes a zero honest: a `text=self-restarting` query returning nothing
  // is the answer we most want to trust and can least afford to trust naively, so it is paired with an
  // UNFILTERED read over the same window. If that is empty too, the stream is unreadable, not quiet.
  else if (coverageLineCount === 0) blindReasons.push('log coverage probe returned ZERO lines over a window this box logs continuously through — the stream is unreadable, not quiet');
  if (unclassified.length) blindReasons.push(`${unclassified.length} watchdog line(s) matched the filter but fit no known shape — a new log variant must blind this leg, never pick a bucket`);
  if (!deploysOk) blindReasons.push('deploys API FAILED');
  else if (!oldestDeploy || new Date(oldestDeploy).getTime() > fromMs) blindReasons.push('the deploys page did not reach back past the window open — deploys inside it may never have been fetched');
  if (!eventsOk) blindReasons.push('events API FAILED');
  // TWO coverage rules, because there are two ways to ask. An UNBOUNDED page (`?limit=N`, newest
  // first) is only known to cover the window if the oldest record it returned predates the window
  // open. A TIME-BOUNDED page (`?startTime=&endTime=`) is covered by construction — unless it came
  // back saturated, in which case older matches inside the range were dropped. Applying the
  // unbounded rule to a bounded read produces a FALSE BLIND on every quiet window (there is simply
  // no event older than `from` to be found), and applying the bounded rule to an unbounded read
  // would produce a FALSE CLEAN. The caller says which question it asked; it does not get inferred.
  else if (eventsQueryFrom) {
    if (new Date(eventsQueryFrom).getTime() > leftEdgeMs) blindReasons.push('the events query asked for a startTime AFTER the window open — it cannot have seen the whole window');
    else if (eventsTruncated) blindReasons.push('the time-bounded events page came back SATURATED at its limit — older container deaths inside the window may never have been fetched');
  } else if (!oldestEvent || new Date(oldestEvent).getTime() > fromMs) blindReasons.push('the events page did not reach back past the window open — container deaths inside it may never have been fetched');

  const bootsWithPreWindow = clusterBoots([...deployBoots, ...deathBoots, ...echoBoots], clusterMs)
    .map(b => ({ ...b, inWindow: new Date(b.at).getTime() >= fromMs }));
  const boots = bootsWithPreWindow.filter(b => b.inWindow);
  const blind = blindReasons.length > 0;

  return {
    window: { from, to, preWindowMs },
    blind,
    blindReasons,
    // ⛔ NULL WHEN BLIND, ON PURPOSE. A blind detector must not hand a consumer a number that reads
    // like a measurement; `0` is exactly the value that gets quoted as "clean".
    bootCount: blind ? null : boots.length,
    invisibleToDeploys: blind ? null : boots.filter(b => !b.srcs.includes('DEPLOY')).length,
    boots,
    bootsWithPreWindow,
    trips,
    suppressed,
    unclassified,
    sources: {
      deploy: { ok: deploysOk, candidates: deployBoots.length },
      event: { ok: eventsOk, candidates: deathBoots.length },
      watchdog: { ok: watchdogOk, candidates: echoBoots.length, coverageLineCount },
    },
  };
}

/** IO shell: pull all four reads, then hand them to the pure core. Never throws on a bad source — it
 * reports it as an ok:false and lets `buildBootSet` turn that into BLIND. */
export async function pullBootSet({
  from, to, serviceId, apiKey, ownerId, preWindowMs = 0,
  api = 'https://api.render.com/v1', fetchImpl = fetch, deployLabel,
}) {
  const rh = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
  const leftEdge = new Date(new Date(from).getTime() - preWindowMs).toISOString();
  const get = async (url) => {
    try {
      const r = await fetchImpl(url, { headers: rh });
      if (!r.ok) return { ok: false, body: null };
      return { ok: true, body: await r.json() };
    } catch { return { ok: false, body: null }; }
  };

  let owner = ownerId;
  if (!owner) {
    const svc = await get(`${api}/services/${serviceId}`);
    owner = svc.body?.ownerId ?? null;
  }
  const logUrl = (extra) => `${api}/logs?ownerId=${owner}&resource=${serviceId}`
    + `&startTime=${encodeURIComponent(leftEdge)}&endTime=${encodeURIComponent(to)}${extra}`;

  // ⛔ THE EVENTS READ MUST BE TIME-BOUNDED, NOT "the newest 100". `/events?limit=100` is ordered
  // newest-first from NOW, so on a service that deploys a few times a day it stops reaching back
  // after ~2 days — and the honest coverage check then blinds EVERY historical window. Measured
  // 2026-07-25 (TRA-2294): the 07-20, 07-21 and 07-22 RTH sessions were all unreadable for this one
  // reason, which is the whole week of prior sessions a recurrence question needs. `startTime`/
  // `endTime` are supported on this route and were verified against 07-20 before this change.
  const EVENTS_LIMIT = 100;
  const WATCHDOG_LIMIT = 100;
  const eventsUrl = `${api}/services/${serviceId}/events?limit=${EVENTS_LIMIT}`
    + `&startTime=${encodeURIComponent(leftEdge)}&endTime=${encodeURIComponent(to)}`;

  const [wd, cov, dep, ev] = await Promise.all([
    owner ? get(logUrl(`&text=${encodeURIComponent('self-restarting')}&limit=${WATCHDOG_LIMIT}`)) : { ok: false, body: null },
    owner ? get(logUrl('&limit=5')) : { ok: false, body: null },
    get(`${api}/services/${serviceId}/deploys?limit=50`),
    get(eventsUrl),
  ]);

  const arr = (b, k) => (Array.isArray(b) ? b : b?.[k] ?? []);
  const events = arr(ev.body, 'events');
  // ⚠️ `logs: null` on this route means NO MATCH, not "unreadable" — verified 2026-07-25 with a
  // nonsense `text=` filter over a window that is provably readable (it also returns null), and with
  // a `text=doTick` positive control over 07-22 (5 lines, hasMore) on a day whose self-restarting
  // query returns null. The `?? []` below is therefore a correct coercion and not a fail-open; the
  // thing that makes the zero honest is the UNFILTERED coverage probe next to it, which is why it
  // exists. Do not "harden" this into a blind — it would blind every quiet session.
  const wdLogs = wd.body?.logs ?? [];
  return buildBootSet({
    from, to, preWindowMs, deployLabel,
    watchdogLines: wdLogs.map(l => ({ timestamp: l.timestamp, message: String(l.message ?? '') })),
    watchdogOk: wd.ok,
    watchdogTruncated: wd.ok && (wd.body?.hasMore === true || wdLogs.length >= WATCHDOG_LIMIT),
    coverageLineCount: (cov.body?.logs ?? []).length,
    coverageOk: cov.ok,
    deploys: arr(dep.body, 'deploys'),
    deploysOk: dep.ok,
    events,
    eventsOk: ev.ok,
    eventsQueryFrom: leftEdge,
    eventsTruncated: events.length >= EVENTS_LIMIT,
  });
}

/**
 * The guard every "zero-restart" gate should call. Returns a verdict object rather than a bare
 * boolean so a caller cannot accidentally read BLIND as PASS.
 *   { verdict: 'CONTINUOUS' | 'RESTARTED' | 'BLIND', reason }
 */
export function assertContinuous(result) {
  if (result.blind) {
    return { verdict: 'BLIND', reason: `boot set incomplete — ${result.blindReasons.join('; ')}. `
      + 'HOLD the grade; do NOT fall back to the deploy list.' };
  }
  if (result.bootCount > 0) {
    return { verdict: 'RESTARTED', reason: `${result.bootCount} boot(s) in window, `
      + `${result.invisibleToDeploys} of them invisible to the deploys API: `
      + result.boots.map(b => `${b.at} [${b.srcs.join('+')}]`).join(', ') };
  }
  return { verdict: 'CONTINUOUS', reason: 'no boot seen by deploys, container-death events, or watchdog echoes '
    + `(log coverage probe: ${result.sources.watchdog.coverageLineCount} line(s), so the zero is an observation, not a silence)` };
}

/** Human-readable block for a grader's output. */
export function formatBootSet(result) {
  const v = assertContinuous(result);
  const lines = [`RESTARTS ${result.window.from} → ${result.window.to}: ${v.verdict} — ${v.reason}`];
  for (const b of result.bootsWithPreWindow) {
    lines.push(`  ${b.inWindow ? '•' : '(pre-window)'} ${b.at} [${b.srcs.join('+')}]`);
    // Print EVERY witness, not just the first. A cluster seen by both the deploys API and a watchdog
    // echo is one boot with two accounts of itself, and showing only one of them mislabels it —
    // "NO DEPLOY RECORD" on a boot that has a deploy record reads as a contradiction of the leg.
    for (const l of b.labels) lines.push(`      ${l}`);
  }
  if (result.trips.length) {
    lines.push(`  distinct watchdog TRIPS (deduped on (lag,rss) — an INCIDENT RATE, a different number `
      + `from the boot count): ${result.trips.length} — ${result.trips.map(t => `${t.at} lag=${t.lag}ms rss=${t.rss}MB`).join(', ')}`);
  }
  if (result.suppressed.length) {
    lines.push(`  watchdog trips SUPPRESSED during boot grace (matched the log filter, restarted NOTHING, `
      + `NOT boots): ${result.suppressed.length} — ${result.suppressed.map(t => `${t.at} lag=${t.lag}ms`).join(', ')}`);
  }
  return lines.join('\n');
}
