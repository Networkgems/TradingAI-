#!/usr/bin/env node
// TRA-3917 — GRADE THE TRA-3905 BROKER-REJECT CENSUS AGAINST A SESSION THAT ACTUALLY SUBMITTED.
//
// TRA-3905 shipped `16ee36d`: a per-book `submitted`/`filled`/reject-class fold
// plus a 3-consecutive-permission-reject breaker. TRA-3914 deployed it and read
// it — and every STRUCTURAL cell passed while the one that discriminates read a
// NO-RUN, because the build booted 2026-08-21T03:03:30Z = 23:03 ET, seven hours
// after the 08-20 close. The census is `Process-lifetime + per-ET-day state,
// deliberately not durable`, so `etDay 2026-08-20` is zero on every book and is
// permanently unreadable.
//
// ⛔ AN ALL-ZERO CENSUS IS BYTE-IDENTICAL TO A FOLD WIRED TO NOTHING. That is
// TRA-3905's own defect one layer down, and it is the reason this script exists
// rather than a paragraph telling a reader what to look at:
//
//   · `verdict:'idle'` on every book is a NO-RUN. It is NOT a pass, and the
//     health surface cannot tell "quiet Thursday" from "recorder never called".
//   · `brokerOutcomesEtDay: null` is UNREAD, not clean. A STALE day (yesterday's
//     fold, correctly zero) reads exactly as clean as today's.
//   · the attribution check filters `voids.recent[]` by `ts >= build.startedAt`.
//     `ts` is EPOCH MILLISECONDS (a number); `build.startedAt` is an ISO STRING.
//     `1786620307496 >= '2026-08-21T03:03:30.762Z'` coerces to NaN and is FALSE
//     FOR EVERY ROW — an always-empty subset over which "all rows carry a book"
//     is VACUOUSLY TRUE. I made exactly that comparison by hand while scoping
//     this ticket and got the right answer for the wrong reason. See CONTROL T.
//
// So: no check here may pass on an empty subset, and every skipped arm is
// PRINTED with its reason. "Not applicable" and "passed" never share a line.
//
// ── THE BAR (TRA-3917) ───────────────────────────────────────────────────────
// GATE 0, checked first, everything below void without it:
//   · `liveArmCensus.brokerOutcomesEtDay` non-null AND == the session being read
//   · at least one book with `submitted > 0`
// Then:
//   · `admin`  → verdict `green`, submitted > 0, filled > 0
//   · `v0nni`  (while armed and unapproved) → verdict `red`,
//     brokerPermissionBlocked, blockedSince non-null, permissionRejects >= 3,
//     consecutivePermissionRejects >= 3, submissionsRefusedByBreaker > 0, and
//     `submitted` PINNED at the trip count (3). The pin is the whole point: it
//     separates an instrument that NOTICES from one that merely REPORTS.
//   · rollup brokerPermissionBlockedCount >= 1, brokerRedBookCount >= 1, numeric
//   · every live book carries a non-null `brokerOutcome` (roster union intact
//     UNDER LOAD, not just when quiet)
//   · `voids.recent[]` rows with `ts >= build.startedAt` carry non-null `book`
//     and `reasonCode`. Pre-`16ee36d` rows carry null BY DESIGN — filtered out
//     by ts, never by eyeball.
//
// ── EXIT CODES — precedence BLIND > FORFEIT > NO-RUN > FAIL > CLEAN ──────────
//   0 CLEAN    the census moved and every criterion held
//   1 FAIL     the census moved and a criterion did not — the finding
//   2 usage
//   3 BLIND    could not check (shape changed, wrong day, two different reads)
//   4 NO-RUN   nothing submitted — the 08-20 outcome. Re-arm, do not grade.
//   5 FORFEIT  the process restarted mid-session — the fold is partial
//
// FORFEIT outranks NO-RUN deliberately: a restart at 15:00Z EXPLAINS an idle
// fold, and reporting NO-RUN there would send the next reader hunting a defect
// in the recorder. ⚠️ The pm2 memory watchdog's self-restart writes NO deploy
// record, so `check:deploy-drift` reads CURRENT straight through one —
// `build.startedAt` is the only tell.
//
// Usage:
//   node scripts/check-broker-census.mjs                       # live bqb1, today ET
//   node scripts/check-broker-census.mjs --session=2026-08-21
//   node scripts/check-broker-census.mjs --census=c.json --journal=j.json
//   node scripts/check-broker-census.mjs --selftest

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXIT = { CLEAN: 0, FAIL: 1, USAGE: 2, BLIND: 3, NORUN: 4, FORFEIT: 5 };
const PERMISSION_BREAKER_THRESHOLD = 3; // == broker-submit-census.ts:135

const argv = process.argv.slice(2);
const arg = (k) => argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const has = (k) => argv.includes(`--${k}`);

if (has('help')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf-8')
    .split('\n').filter(l => l.startsWith('//')).join('\n'));
  process.exit(EXIT.USAGE);
}

const HOST = arg('host') ?? process.env.HOST_BASE ?? 'https://tradingai-bqb1.onrender.com';

// ─────────────────────────────────────────────────────────────────────────────
// ET. Cron fires in ET, the census keys by ET day, the window is written in UTC.
// Nothing here may guess: 09:30 ET is 13:30Z only while EDT is in force.
// ─────────────────────────────────────────────────────────────────────────────
const ET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
function etParts(ms) {
  const p = Object.fromEntries(ET_FMT.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { ...p, hour: p.hour === '24' ? '00' : p.hour };
}
export function etDayOf(ms) {
  const p = etParts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}
/** The UTC instant of a wall-clock time in America/New_York on `isoDay`. */
export function etWallToUtc(isoDay, hh, mm) {
  const guess = Date.parse(`${isoDay}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
  const p = etParts(guess);
  const offset = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`) - guess;
  return guess - offset;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE GRADE — pure. No IO, no clock: `now` is passed in so the selftest can put
// the reader after the close without waiting for one.
// ─────────────────────────────────────────────────────────────────────────────
export function grade({ census, journal, session, now }) {
  const out = [];
  const say = (s) => out.push(s);
  const done = (code, headline) => ({ code, headline, lines: out });

  let failures = 0;
  const check = (label, ok, detail = '') => {
    if (ok !== true) failures += 1;
    say(`  ${ok === true ? 'PASS  ' : '**FAIL**'}  ${label}${detail ? `  — ${detail}` : ''}`);
    return ok === true;
  };
  const skip = (label, why) => say(`  SKIP  ${label}  — ${why}`);
  const unread = (label, why) => { failures += 1; say(`  UNREAD  ${label}  — ${why}  (UNREAD is not a pass)`); };

  // ── CONTROL A — is the instrument even on this build? ──────────────────────
  const lac = census?.liveArmCensus;
  if (!lac || !Array.isArray(lac.books)) {
    return done(EXIT.BLIND, 'payload has no `liveArmCensus.books[]` — wrong route or a shape change');
  }
  if (!('brokerOutcomesEtDay' in lac)) {
    return done(EXIT.BLIND, 'live build predates `16ee36d` — `brokerOutcomesEtDay` is ABSENT, not null. Nothing to grade.');
  }
  const build = census?.build ?? {};
  const bootMs = Date.parse(build.startedAt ?? '');
  if (!Number.isFinite(bootMs)) {
    return done(EXIT.BLIND, `build.startedAt unparsable (${JSON.stringify(build.startedAt)}) — the FORFEIT arm and the void ts filter both key off it`);
  }
  say(`build     ${String(build.commit ?? '?').slice(0, 7)}  pid ${build.pid}  booted ${build.startedAt}  (${etDayOf(bootMs)} ET)`);
  say(`session   ${session}   open ${new Date(etWallToUtc(session, 9, 30)).toISOString()}   close ${new Date(etWallToUtc(session, 16, 0)).toISOString()}`);
  say(`read at   ${new Date(now).toISOString()}`);

  // ── CONTROL B — the two payloads must be ONE read of ONE process. ──────────
  // Attribution is graded against `build.startedAt` from the census while the
  // rows come from the journal. If those are two different processes the ts
  // filter is meaningless in either direction.
  const jb = journal?.build ?? {};
  if (jb.startedAt !== build.startedAt || jb.commit !== build.commit) {
    return done(EXIT.BLIND, `census and journal came from different processes (census ${String(build.commit).slice(0, 7)}@${build.startedAt} vs journal ${String(jb.commit).slice(0, 7)}@${jb.startedAt}) — re-read both`);
  }

  // ── FORFEIT — a restart inside the session truncates the fold. ─────────────
  const openMs = etWallToUtc(session, 9, 30);
  const closeMs = etWallToUtc(session, 16, 0);
  if (bootMs > openMs) {
    say('');
    const covered = Math.max(0, Math.round((closeMs - bootMs) / 60000));
    return done(EXIT.FORFEIT, covered === 0
      // The 08-20 case exactly: booted 23:03 ET, seven hours after the close.
      // Process-lifetime state means that ET day is not "partial", it is GONE.
      ? `process booted ${build.startedAt}, entirely AFTER the ${new Date(closeMs).toISOString()} close — 0 min of ${session} is in this fold, and process-lifetime state makes that day PERMANENTLY unreadable. Nothing was lost; it can only be re-read on a later session.`
      : `process booted ${build.startedAt}, AFTER the ${new Date(openMs).toISOString()} open — the fold covers only ${covered} min of the session. Partial, not gradeable. Re-arm for the next session.`);
  }
  const partial = now < closeMs;
  if (partial) say(`⚠️  PARTIAL — read ${Math.round((closeMs - now) / 60000)} min BEFORE the 16:00 ET close; counters may still move.`);

  // ── GATE 0 — the positive control. ─────────────────────────────────────────
  say('');
  say('GATE 0 — the positive control');
  const etDay = lac.brokerOutcomesEtDay;
  if (etDay === null || etDay === undefined) {
    return done(EXIT.NORUN, 'brokerOutcomesEtDay is null — UNREAD, not clean. The fold has never been keyed.');
  }
  if (etDay !== session) {
    return done(EXIT.BLIND, `brokerOutcomesEtDay is "${etDay}" but the session being graded is "${session}" — a stale day is correctly zero and reads exactly as clean as a live one. Grading refused.`);
  }
  say(`  PASS    brokerOutcomesEtDay == "${session}"`);

  const rows = lac.books.map(b => ({ ...b, o: b.brokerOutcome ?? null }));
  const submitters = rows.filter(r => Number(r.o?.submitted) > 0);
  if (submitters.length === 0) {
    say(`  **NO-RUN**  0 of ${rows.length} books submitted anything. Every verdict: ${rows.map(r => `${r.username}:${r.o?.verdict ?? 'null'}`).join(' ')}`);
    return done(EXIT.NORUN,
      `NO-RUN — an all-idle fleet. \`idle\` is 0 submitted; it is deliberately NOT \`green\` and it is NOT a pass. Identical to 08-20. Re-arm for the next session${partial ? ' (and this read was pre-close — it is not final)' : ''}.`);
  }
  say(`  PASS    ${submitters.length} book(s) submitted: ${submitters.map(r => `${r.username}=${r.o.submitted}`).join(' ')}`);

  // ── ROSTER UNION under load. ───────────────────────────────────────────────
  say('');
  say('ROSTER UNION — an absent cell must not read like a clean one');
  const missing = rows.filter(r => r.o === null || r.o === undefined);
  check(`all ${rows.length} census books carry a non-null brokerOutcome`,
    missing.length === 0, missing.length ? `null on: ${missing.map(r => r.username).join(', ')}` : `${rows.length}/${rows.length}`);
  const wrongDay = rows.filter(r => r.o && r.o.etDay !== session);
  check('every brokerOutcome row is keyed to the graded session',
    wrongDay.length === 0, wrongDay.length ? wrongDay.map(r => `${r.username}:${r.o.etDay}`).join(', ') : session);

  const rowOf = (name) => rows.find(r => r.username === name);
  const fmt = (r) => r?.o
    ? `submitted=${r.o.submitted} filled=${r.o.filled} brokerRejects=${r.o.brokerRejects} perm=${r.o.permissionRejects} consec=${r.o.consecutivePermissionRejects} refusedByBreaker=${r.o.submissionsRefusedByBreaker} blocked=${r.o.brokerPermissionBlocked} verdict=${r.o.verdict}`
    : '(no row)';
  say('');
  say('rows');
  for (const r of rows) say(`  ${String(r.username).padEnd(10)} armed=${String(r.realMoneyArmed).padEnd(5)} gate=${String(r.liveEntryGateOpen).padEnd(5)} ${fmt(r)}`);

  // ── admin — the GREEN arm. ─────────────────────────────────────────────────
  say('');
  say('admin — the green arm');
  const admin = rowOf('admin');
  if (!admin?.o) {
    check('admin has a brokerOutcome row', false, 'absent from the census entirely');
  } else {
    check("admin verdict == 'green'", admin.o.verdict === 'green', `verdict=${admin.o.verdict}`);
    check('admin submitted > 0', Number(admin.o.submitted) > 0, `submitted=${admin.o.submitted}`);
    check('admin filled > 0', Number(admin.o.filled) > 0, `filled=${admin.o.filled}`);
  }

  // ── v0nni — the RED arm, and the breaker PIN. ──────────────────────────────
  say('');
  say('v0nni — the red arm (graded only while armed AND unapproved)');
  const v = rowOf('v0nni');
  let redArmActive = false;
  if (!v) {
    skip('v0nni red arm', 'no v0nni row in the census — book is off the roster');
  } else if (v.realMoneyArmed !== true) {
    skip('v0nni red arm', `realMoneyArmed=${v.realMoneyArmed} — disarmed between sessions, the red expectation is void`);
  } else if (Number(v.o?.filled) > 0) {
    say(`  NOTE  v0nni FILLED ${v.o.filled} order(s) — the options approval LANDED off-platform.`);
    say('        The red expectation is void by approval, not by defect. This is the good outcome;');
    say('        it needs a human to confirm the approval rather than a green from this script.');
    check("v0nni verdict is not 'idle' once it filled", v.o.verdict !== 'idle', `verdict=${v.o.verdict}`);
  } else if (!v.o) {
    check('v0nni carries a brokerOutcome', false, 'armed book with a null row');
  } else {
    redArmActive = true;
    const o = v.o;
    check("v0nni verdict == 'red'", o.verdict === 'red', `verdict=${o.verdict}`);
    check('v0nni brokerPermissionBlocked == true', o.brokerPermissionBlocked === true, `${o.brokerPermissionBlocked}`);
    check('v0nni brokerPermissionBlockedSince non-null', o.brokerPermissionBlockedSince !== null && o.brokerPermissionBlockedSince !== undefined,
      o.brokerPermissionBlockedSince ? new Date(o.brokerPermissionBlockedSince).toISOString() : String(o.brokerPermissionBlockedSince));
    check(`v0nni permissionRejects >= ${PERMISSION_BREAKER_THRESHOLD}`, Number(o.permissionRejects) >= PERMISSION_BREAKER_THRESHOLD, `permissionRejects=${o.permissionRejects}`);
    check(`v0nni consecutivePermissionRejects >= ${PERMISSION_BREAKER_THRESHOLD}`, Number(o.consecutivePermissionRejects) >= PERMISSION_BREAKER_THRESHOLD, `consec=${o.consecutivePermissionRejects}`);
    check('v0nni submissionsRefusedByBreaker > 0', Number(o.submissionsRefusedByBreaker) > 0,
      `refusedByBreaker=${o.submissionsRefusedByBreaker}${Number(o.submissionsRefusedByBreaker) === 0 ? ' — the breaker never REFUSED anything, so nothing proves it is more than a label' : ''}`);
    // THE PIN. Everything above can be true of an instrument that merely
    // REPORTS. Only this says the breaker STOPPED the book asking.
    check(`v0nni submitted PINNED at the trip count (${PERMISSION_BREAKER_THRESHOLD})`,
      Number(o.submitted) === PERMISSION_BREAKER_THRESHOLD,
      Number(o.submitted) > PERMISSION_BREAKER_THRESHOLD
        ? `submitted=${o.submitted} — the breaker is NOT holding; ${o.submitted - PERMISSION_BREAKER_THRESHOLD} real order(s) went to the broker past the trip. THIS IS THE FINDING.`
        : `submitted=${o.submitted}`);
    check('v0nni every submission came back a permission reject', Number(o.submitted) === Number(o.permissionRejects),
      `submitted=${o.submitted} permissionRejects=${o.permissionRejects}`);
  }

  // ── rollup. ────────────────────────────────────────────────────────────────
  say('');
  say('rollup');
  const rollup = lac.rollup ?? {};
  const numeric = (k) => check(`rollup.${k} is numeric (not null/absent)`, typeof rollup[k] === 'number', `${k}=${JSON.stringify(rollup[k])}`);
  numeric('brokerPermissionBlockedCount');
  numeric('brokerRedBookCount');
  if (redArmActive) {
    check('rollup.brokerPermissionBlockedCount >= 1', Number(rollup.brokerPermissionBlockedCount) >= 1, `=${rollup.brokerPermissionBlockedCount}`);
    check('rollup.brokerRedBookCount >= 1', Number(rollup.brokerRedBookCount) >= 1, `=${rollup.brokerRedBookCount}`);
  } else {
    skip('rollup >= 1 arms', 'no book is expected red this session (v0nni disarmed or approved) — a zero here is correct, not clean');
  }

  // ── ATTRIBUTION — and the vacuity guard that makes it mean anything. ───────
  say('');
  say('attribution — voids.recent[] rows minted by THIS process');
  const voids = journal?.voids ?? {};
  const recent = Array.isArray(voids.recent) ? voids.recent : null;
  if (!recent) {
    return done(EXIT.BLIND, 'option-journal has no `voids.recent[]` array');
  }
  const badTs = recent.filter(r => typeof r.ts !== 'number' || !Number.isFinite(r.ts));
  if (badTs.length) {
    return done(EXIT.BLIND, `${badTs.length} void row(s) carry a non-numeric \`ts\` (${JSON.stringify(badTs[0]?.ts)}) — the unit changed under the filter, and a filter that matches nothing passes vacuously. Grading refused.`);
  }
  const postBoot = recent.filter(r => r.ts >= bootMs);
  const preBoot = recent.length - postBoot.length;
  say(`  ledger: ${recent.length} rows retained, ${voids.dropped ?? '?'} evicted · ${preBoot} pre-boot (null book/reasonCode BY DESIGN) · ${postBoot.length} post-boot`);
  if (postBoot.length === 0) {
    if (redArmActive) {
      check('post-boot void rows exist for the rejects the census counted', false,
        `census counted ${v?.o?.permissionRejects ?? 0} permission reject(s) this process, journal holds 0 void rows at or after ${build.startedAt}. Two ledgers of the same event disagree — one of them is not wired.`);
    } else {
      unread('attribution', `0 rows at or after ${build.startedAt}; "every row carries a book" over an empty set is vacuously true`);
    }
  } else {
    const nullBook = postBoot.filter(r => r.book === null || r.book === undefined);
    const nullCode = postBoot.filter(r => r.reasonCode === null || r.reasonCode === undefined);
    check(`all ${postBoot.length} post-boot void rows carry a non-null \`book\``, nullBook.length === 0,
      nullBook.length ? `${nullBook.length} null: ${nullBook.slice(0, 3).map(r => r.optionSymbol ?? r.id).join(', ')}` : '');
    check(`all ${postBoot.length} post-boot void rows carry a non-null \`reasonCode\``, nullCode.length === 0,
      nullCode.length ? `${nullCode.length} null: ${nullCode.slice(0, 3).map(r => r.optionSymbol ?? r.id).join(', ')}` : '');
    const byBook = {};
    for (const r of postBoot) byBook[String(r.book)] = (byBook[String(r.book)] ?? 0) + 1;
    say(`  post-boot by book: ${Object.entries(byBook).map(([k, n]) => `${k}=${n}`).join(' ')}`);
    const codes = {};
    for (const r of postBoot) codes[String(r.reasonCode)] = (codes[String(r.reasonCode)] ?? 0) + 1;
    say(`  post-boot by reasonCode: ${Object.entries(codes).map(([k, n]) => `${k}=${n}`).join(' ')}`);
  }

  say('');
  if (failures > 0) {
    return done(EXIT.FAIL, `${failures} criterion(s) did not hold against a session that DID submit. This is a finding in \`16ee36d\`, not a quiet day.`);
  }
  return done(EXIT.CLEAN,
    `every criterion held against a session that submitted${partial ? ' — but this was a PRE-CLOSE read, so it is provisional' : ''}. TRA-3905 acceptance is READ.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURES for the controls. `happy()` is the shape a passing session has; each
// arm mutates ONE field of it, so a control that goes green proves the mutation
// is what moved the verdict.
// ─────────────────────────────────────────────────────────────────────────────
const BOOT = '2026-08-21T10:02:00.000Z';   // before the 13:30Z open
const BOOT_MS = Date.parse(BOOT);
const SESSION = '2026-08-21';

function book(username, o, extra = {}) {
  return { username, mode: 'live', realMoneyArmed: true, liveEntryGateOpen: true, ...extra, brokerOutcome: o };
}
function outcome(o) {
  return {
    book: o.book, etDay: SESSION, observed: true, submitted: 0, filled: 0, brokerRejects: 0, preSubmitAborts: 0,
    rejects: { permission: 0, buying_power: 0, no_quote: 0, walk_exhausted: 0, spread_veto: 0, policy: 0, client_unavailable: 0, throw: 0, permission_blocked: 0, other: 0 },
    permissionRejects: 0, consecutivePermissionRejects: 0, brokerPermissionBlocked: false,
    brokerPermissionBlockedSince: null, brokerPermissionBlockedReason: null, submissionsRefusedByBreaker: 0,
    verdict: 'idle', ...o,
  };
}
function happy() {
  const census = {
    build: { commit: 'deadbeefcafe', pid: 73, startedAt: BOOT },
    liveArmCensus: {
      booksScanned: 67,
      brokerOutcomesEtDay: SESSION,
      books: [
        book('admin', outcome({ book: 'admin', submitted: 4, filled: 3, verdict: 'green' })),
        book('Richard', outcome({ book: 'Richard' }), { realMoneyArmed: false, liveEntryGateOpen: false }),
        book('v0nni', outcome({
          book: 'v0nni', submitted: 3, filled: 0, brokerRejects: 3, permissionRejects: 3,
          consecutivePermissionRejects: 3, brokerPermissionBlocked: true,
          brokerPermissionBlockedSince: BOOT_MS + 3_600_000, brokerPermissionBlockedReason: 'Account is restricted for option trading.',
          submissionsRefusedByBreaker: 7, verdict: 'red',
          rejects: { permission: 3, buying_power: 0, no_quote: 0, walk_exhausted: 0, spread_veto: 0, policy: 0, client_unavailable: 0, throw: 0, permission_blocked: 7, other: 0 },
        })),
      ],
      rollup: { liveBookCount: 3, realMoneyArmedCount: 2, brokerPermissionBlockedCount: 1, brokerRedBookCount: 1 },
    },
  };
  const journal = {
    build: { commit: 'deadbeefcafe', pid: 73, startedAt: BOOT },
    voids: {
      total: 34, dropped: 0, applied: 34, refused: 0, live: 34,
      recent: [
        { id: 'old-1', ts: Date.parse('2026-08-20T19:22:10.143Z'), reason: 'Tradier order 142763096 rejected: Account is restricted for option trading.', book: null, reasonCode: null, applied: true, mode: 'live', symbol: 'QQQ', optionSymbol: 'QQQ260904C00765000' },
        { id: 'new-1', ts: BOOT_MS + 3_500_000, reason: 'Tradier order 142900001 rejected: Account is restricted for option trading.', book: 'v0nni', reasonCode: 'permission', applied: true, mode: 'live', symbol: 'SPY', optionSymbol: 'SPY260904C00700000' },
        { id: 'new-2', ts: BOOT_MS + 3_550_000, reason: 'Tradier order 142900002 rejected: Account is restricted for option trading.', book: 'v0nni', reasonCode: 'permission', applied: true, mode: 'live', symbol: 'QQQ', optionSymbol: 'QQQ260904C00765000' },
        { id: 'new-3', ts: BOOT_MS + 3_600_000, reason: 'permission breaker refused submission', book: 'v0nni', reasonCode: 'permission_blocked', applied: true, mode: 'live', symbol: 'IWM', optionSymbol: 'IWM260904C00230000' },
      ],
    },
  };
  return { census, journal };
}
const AFTER_CLOSE = Date.parse('2026-08-21T20:10:00.000Z');
const clone = (x) => JSON.parse(JSON.stringify(x));
const run = (f, now = AFTER_CLOSE) => {
  const { census, journal } = f ?? happy();
  return grade({ census, journal, session: SESSION, now });
};

async function selftest() {
  let failed = 0;
  const arm = (label, got, want, extra) => {
    const ok = got.code === want;
    console.log(`  ${ok ? 'PASS' : '** FAIL **'}  ${label}  → ${nameOf(got.code)}${ok ? '' : ` (wanted ${nameOf(want)})`}`);
    if (!ok) { failed += 1; console.log(`        headline: ${got.headline}`); }
    if (extra) {
      const ok2 = extra.re.test(got.headline + '\n' + got.lines.join('\n'));
      console.log(`        ${ok2 ? 'PASS' : '** FAIL **'}  …and it says why: /${extra.re.source}/`);
      if (!ok2) { failed += 1; console.log(got.lines.join('\n')); }
    }
  };
  const nameOf = (c) => Object.entries(EXIT).find(([, v]) => v === c)?.[0] ?? c;

  console.log('\nBASELINE — the shape a passing session has');
  arm('happy path', run(), EXIT.CLEAN);

  console.log('\nGATE 0 — the arm that 08-20 actually tripped');
  const idle = clone(happy());
  for (const b of idle.census.liveArmCensus.books) { b.brokerOutcome.submitted = 0; b.brokerOutcome.filled = 0; b.brokerOutcome.verdict = 'idle'; b.brokerOutcome.permissionRejects = 0; b.brokerOutcome.brokerPermissionBlocked = false; }
  arm('an all-idle fleet is NO-RUN, never CLEAN', run(idle), EXIT.NORUN, { re: /idle.*NOT.*green|all-idle/i });

  const stale = clone(happy());
  stale.census.liveArmCensus.brokerOutcomesEtDay = '2026-08-20';
  arm('a STALE etDay is BLIND, not clean', run(stale), EXIT.BLIND, { re: /stale day/i });

  const nulled = clone(happy());
  nulled.census.liveArmCensus.brokerOutcomesEtDay = null;
  arm('a NULL etDay is UNREAD (NO-RUN), not clean', run(nulled), EXIT.NORUN, { re: /UNREAD, not clean/i });

  const absent = clone(happy());
  delete absent.census.liveArmCensus.brokerOutcomesEtDay;
  arm('an ABSENT etDay key is BLIND — the build predates the instrument', run(absent), EXIT.BLIND, { re: /predates/i });

  console.log('\nFORFEIT — the pm2 self-restart that leaves no deploy record');
  const restarted = clone(happy());
  restarted.census.build.startedAt = '2026-08-21T17:00:00.000Z';
  restarted.journal.build.startedAt = '2026-08-21T17:00:00.000Z';
  arm('a mid-session boot is FORFEIT, and outranks the idle fold it explains', run(restarted), EXIT.FORFEIT, { re: /AFTER the .* open/ });
  const restartedIdle = clone(restarted);
  for (const b of restartedIdle.census.liveArmCensus.books) { b.brokerOutcome.submitted = 0; b.brokerOutcome.verdict = 'idle'; }
  arm('  …even when the fold is ALSO empty (precedence FORFEIT > NO-RUN)', run(restartedIdle), EXIT.FORFEIT);
  // The 08-20 read itself, replayed: a boot AFTER the close is not "partial",
  // it is a day that process-lifetime state can never hold. Distinct wording,
  // and no negative minute count.
  const afterClose = clone(happy());
  afterClose.census.build.startedAt = '2026-08-21T22:03:30.762Z';
  afterClose.journal.build.startedAt = '2026-08-21T22:03:30.762Z';
  arm('a boot entirely after the close is FORFEIT and says PERMANENTLY unreadable',
    run(afterClose, Date.parse('2026-08-21T23:00:00Z')), EXIT.FORFEIT, { re: /0 min of .* PERMANENTLY unreadable/s });

  console.log('\nTHE BREAKER PIN — an instrument that NOTICES vs one that REPORTS');
  const unpinned = clone(happy());
  unpinned.census.liveArmCensus.books[2].brokerOutcome.submitted = 9;
  unpinned.census.liveArmCensus.books[2].brokerOutcome.permissionRejects = 9;
  unpinned.census.liveArmCensus.books[2].brokerOutcome.rejects.permission = 9;
  arm('submitted climbing past 3 is a FAIL even though every other red cell is set', run(unpinned), EXIT.FAIL, { re: /breaker is NOT holding/ });
  const neverRefused = clone(happy());
  neverRefused.census.liveArmCensus.books[2].brokerOutcome.submissionsRefusedByBreaker = 0;
  arm('a breaker that never REFUSED anything is a FAIL', run(neverRefused), EXIT.FAIL, { re: /never REFUSED/ });
  const labelOnly = clone(happy());
  labelOnly.census.liveArmCensus.books[2].brokerOutcome.brokerPermissionBlocked = false;
  arm('verdict red with brokerPermissionBlocked false is a FAIL', run(labelOnly), EXIT.FAIL);

  console.log('\nROSTER UNION — under load, not just when quiet');
  const dropped = clone(happy());
  dropped.census.liveArmCensus.books[1].brokerOutcome = null;
  arm('a book losing its brokerOutcome row is a FAIL', run(dropped), EXIT.FAIL, { re: /null on: Richard/ });

  console.log('\nadmin GREEN arm');
  const noFill = clone(happy());
  noFill.census.liveArmCensus.books[0].brokerOutcome.filled = 0;
  noFill.census.liveArmCensus.books[0].brokerOutcome.verdict = 'degraded';
  arm('admin submitting and never filling is a FAIL', run(noFill), EXIT.FAIL);

  console.log('\nv0nni SKIP arms — "not applicable" must never read as "passed"');
  const disarmed = clone(happy());
  disarmed.census.liveArmCensus.books[2].realMoneyArmed = false;
  disarmed.census.liveArmCensus.books[2].brokerOutcome = outcome({ book: 'v0nni' });
  disarmed.census.liveArmCensus.rollup.brokerPermissionBlockedCount = 0;
  disarmed.census.liveArmCensus.rollup.brokerRedBookCount = 0;
  disarmed.journal.voids.recent = disarmed.journal.voids.recent.filter(r => r.ts < BOOT_MS);
  arm('a DISARMED v0nni skips the red arm and the >=1 rollups', run(disarmed), EXIT.FAIL, { re: /SKIP  v0nni red arm/ });
  console.log('        ↑ FAIL is correct here: the attribution subset went EMPTY, which reads UNREAD, not pass.');

  const approved = clone(happy());
  approved.census.liveArmCensus.books[2].brokerOutcome.filled = 2;
  approved.census.liveArmCensus.books[2].brokerOutcome.verdict = 'red';
  arm('an APPROVAL landing is reported, not failed', run(approved), EXIT.CLEAN, { re: /approval LANDED/ });

  console.log('\n★ CONTROL T — THE ts UNIT. The bug I nearly shipped into this grader.');
  // The scoping read compared a NUMBER ts against an ISO STRING. NaN coercion
  // makes the predicate false for EVERY row, so the post-boot subset is empty
  // and "all rows carry a book" is vacuously true — on a payload where three
  // rows are RIGHT THERE. Both arms below run on the SAME happy fixture.
  const h = happy();
  const brokenFilter = h.journal.voids.recent.filter(r => r.ts >= h.census.build.startedAt);
  const rightFilter = h.journal.voids.recent.filter(r => r.ts >= Date.parse(h.census.build.startedAt));
  const t1 = brokenFilter.length === 0 && rightFilter.length === 3;
  console.log(`  ${t1 ? 'PASS' : '** FAIL **'}  string-vs-number filter finds ${brokenFilter.length} rows where the numeric one finds ${rightFilter.length}`);
  if (!t1) failed += 1;
  const t2 = brokenFilter.every(r => r.book !== null); // vacuously true over []
  console.log(`  ${t2 ? 'PASS' : '** FAIL **'}  …and "every row carries a book" is VACUOUSLY TRUE over the empty one`);
  if (!t2) failed += 1;
  const stringTs = clone(happy());
  stringTs.journal.voids.recent[1].ts = '2026-08-21T11:00:00.000Z';
  arm('a ts that turns into a STRING is BLIND, never a vacuous pass', run(stringTs), EXIT.BLIND, { re: /unit changed under the filter/ });

  console.log('\nATTRIBUTION');
  const noAttribution = clone(happy());
  for (const r of noAttribution.journal.voids.recent) if (r.ts >= BOOT_MS) r.book = null;
  arm('post-boot rows with a null book are a FAIL', run(noAttribution), EXIT.FAIL, { re: /non-null `book`/ });
  const noCode = clone(happy());
  for (const r of noCode.journal.voids.recent) if (r.ts >= BOOT_MS) r.reasonCode = null;
  arm('post-boot rows with a null reasonCode are a FAIL', run(noCode), EXIT.FAIL, { re: /non-null `reasonCode`/ });
  const preBootOnly = clone(happy());
  preBootOnly.journal.voids.recent = preBootOnly.journal.voids.recent.filter(r => r.ts < BOOT_MS);
  arm('rejects counted but ZERO void rows ⇒ the two ledgers disagree ⇒ FAIL', run(preBootOnly), EXIT.FAIL, { re: /one of them is not wired/ });
  const preBootNull = clone(happy());
  arm('pre-16ee36d rows carrying null are NOT read as a defect', run(preBootNull), EXIT.CLEAN);

  console.log('\nCONTROL B — two payloads, one process');
  const mixed = clone(happy());
  mixed.journal.build.startedAt = '2026-08-21T17:44:00.000Z';
  arm('census and journal from different boots is BLIND', run(mixed), EXIT.BLIND, { re: /different processes/ });

  console.log('\nPARTIAL — a pre-close read is provisional, not final');
  arm('a CLEAN read before 16:00 ET says so', run(null, Date.parse('2026-08-21T18:00:00Z')), EXIT.CLEAN, { re: /PRE-CLOSE read, so it is provisional/ });

  console.log('\nET ARITHMETIC — 09:30 ET is 13:30Z only while EDT is in force');
  const etOk = new Date(etWallToUtc('2026-08-21', 9, 30)).toISOString() === '2026-08-21T13:30:00.000Z'
    && new Date(etWallToUtc('2026-08-21', 16, 0)).toISOString() === '2026-08-21T20:00:00.000Z'
    && new Date(etWallToUtc('2026-01-15', 9, 30)).toISOString() === '2026-01-15T14:30:00.000Z'
    && etDayOf(Date.parse('2026-08-21T03:03:30Z')) === '2026-08-20';
  console.log(`  ${etOk ? 'PASS' : '** FAIL **'}  EDT open/close, EST open, and the 23:03 ET boot that landed on the PREVIOUS ET day`);
  if (!etOk) failed += 1;

  console.log(`\n${failed === 0 ? 'CONTROLS PASS' : `** ${failed} CONTROL(S) FAILED **`}`);
  process.exit(failed === 0 ? EXIT.CLEAN : EXIT.BLIND);
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  if (has('selftest')) return selftest();

  const now = Date.now();
  const session = arg('session') ?? etDayOf(now);
  let census, journal;
  const cf = arg('census'), jf = arg('journal');
  if (cf || jf) {
    if (!cf || !jf) { console.error('BLIND — --census and --journal must be given together'); process.exit(EXIT.BLIND); }
    try { census = JSON.parse(readFileSync(cf, 'utf-8')); journal = JSON.parse(readFileSync(jf, 'utf-8')); }
    catch (e) { console.error(`BLIND — fixture unreadable (${e.message})`); process.exit(EXIT.BLIND); }
    console.log(`source    fixtures ${cf} + ${jf}`);
  } else {
    const get = async (p) => {
      const r = await fetch(`${HOST}${p}`).catch(e => ({ ok: false, status: e.message }));
      if (!r.ok) { console.error(`BLIND — ${p} ${r.status}`); process.exit(EXIT.BLIND); }
      return r.json();
    };
    // Census FIRST, journal second: the journal can only grow between the two,
    // so a row minted in the gap is post-boot on both and cannot manufacture a
    // false attribution failure.
    census = await get('/api/health/options-live');
    journal = await get('/api/health/option-journal');
    console.log(`source    live ${HOST}`);
    const dir = process.env.PAPERCLIP_RUN_SCRATCH_DIR;
    if (dir) {
      try {
        writeFileSync(`${dir}/tra3917-census.json`, JSON.stringify(census, null, 1));
        writeFileSync(`${dir}/tra3917-journal.json`, JSON.stringify(journal, null, 1));
        console.log(`captured  ${dir}/tra3917-{census,journal}.json`);
      } catch { /* capture is a convenience, never a gate */ }
    }
  }

  const r = grade({ census, journal, session, now });
  console.log(r.lines.join('\n'));
  const label = Object.entries(EXIT).find(([, v]) => v === r.code)[0];
  console.log(`${label} — ${r.headline}`);
  process.exit(r.code);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { console.error(`BLIND — ${e?.stack ?? String(e)}`); process.exit(EXIT.BLIND); });
}
