#!/usr/bin/env node
// TRA-3387 census grader (READ-ONLY). Two modes, one instrument.
//
//   node scripts/tra3387-census-grade.mjs boot
//   node scripts/tra3387-census-grade.mjs eod --from=2026-08-14T00:50:00Z --to=2026-08-14T01:30:00Z
//
// WHY THIS EXISTS
// ---------------
// TRA-3387's whole lesson is that A REQUIREMENT ON THE READER IS NOT A CONTROL. The
// ticket's own pass condition was prose in a comment, and TRA-3468 duly found a defect
// that a human grader reading `coverage:"restored"` could rationalise away while an
// operator grepping for INTACT got a false all-clear. So the pass condition is HERE, as
// code with an exit status, not in a runbook someone has to remember to follow.
//
// [STOP] gates enforced below, both of which have silently faked a verdict before:
//   1. Liveness is RE-MEASURED every run off `/api/health/options-live` (`/api/health`
//      has NO `build` block). bqb1 restarted 9 times inside the 5 h window TRA-3468
//      graded; a remembered build is not evidence.
//   2. An unfiltered pull over the SAME window must return lines. Without that positive
//      control, "0 matching lines" is indistinguishable from "the query cannot see the
//      window at all", and every absence verdict below is a silent pass.
//
// `--from=` / `--to=` take an EQUALS SIGN. (Space-separated args are silently ignored by
// the sibling script check-restarts.mjs and it falls back to today's RTH window, which
// printed a fake BLIND for a window that had not happened yet. Here they are required.)
const args = process.argv.slice(2);
const MODE = args.find((a) => !a.startsWith('-')) ?? 'boot';
const arg = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);

const KEY = process.env.RENDER_API_KEY;
const SERVICE = process.env.SERVICE ?? 'srv-d7mb7rr7uimc73ev0chg';
const OWNER = process.env.RENDER_OWNER_ID ?? 'tea-d7macfog4nts73ai6p40';
const HOST = process.env.HOST_BASE ?? 'https://tradingai-bqb1.onrender.com';
if (!KEY) { console.error('no RENDER_API_KEY -- BLIND, this is a HOLD, not a FAIL'); process.exit(3); }

// The four sentences the dispatch can emit, keyed by the coverage they are the ONLY
// legal prose for. Mutual exclusivity is the property TRA-3468 restored.
const SENTENCE = {
  blind: 'census is BLIND',
  restored: 'census was RESTORED across an in-session restart',
  intactEmpty: 'census is EMPTY and the session state is INTACT',
  intactCovered: 'census covered the graded session',
};

const build = await (await fetch(`${HOST}/api/health/options-live`)).json().then((j) => j.build);
console.log(`LIVE  commit=${build.commitShort}  pid=${build.pid}  startedAt=${build.startedAt}  uptime=${build.uptimeSec}s`);

let START; let END;
if (MODE === 'eod') {
  START = arg('from'); END = arg('to');
  if (!START || !END) { console.error('eod mode requires --from=<iso> --to=<iso> (with = signs)'); process.exit(2); }
} else {
  const bootMs = Date.parse(build.startedAt);
  START = new Date(bootMs - 30_000).toISOString();
  END = new Date(bootMs + 300_000).toISOString();
}
console.log(`mode=${MODE}  window ${START} -> ${END}\n`);

async function pull(text, limit = 100) {
  const u = new URL('https://api.render.com/v1/logs');
  u.searchParams.set('resource', SERVICE);     // NOT `resource[]=`
  u.searchParams.set('ownerId', OWNER);        // omitting it is a 400, not a filtered read
  u.searchParams.set('startTime', START);
  u.searchParams.set('endTime', END);
  u.searchParams.set('limit', String(limit));
  if (text !== null) u.searchParams.set('text', text);   // CONTIGUOUS substring, not a token query
  const r = await fetch(u, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
  if (!r.ok) { console.error(`logs ${r.status}: ${(await r.text()).slice(0, 300)}`); return null; }
  return r.json();
}

const control = await pull(null, 20);
console.log(`[control] unfiltered pull over the same window: ${control?.logs?.length ?? 'ERROR'} line(s)`);
if (!control?.logs?.length) {
  console.error('INSTRUMENT BLIND -- the query cannot see this window. No verdict may be drawn from a zero below.');
  process.exit(3);
}

function parse(lines) {
  const out = [];
  for (const l of lines) {
    const m = /\{.*\}/.exec(l.message ?? '');
    if (!m) continue;
    try { out.push({ ts: l.timestamp, j: JSON.parse(m[0]) }); } catch { /* not our line */ }
  }
  return out;
}

let failures = 0;

if (MODE === 'boot') {
  const rows = parse((await pull('TRA-3387 move-suspect session snapshot read', 100))?.logs ?? []);
  const hist = {};
  for (const { j } of rows) hist[j.outcome] = (hist[j.outcome] ?? 0) + 1;
  console.log(`\nsnapshot-read lines: ${rows.length}   outcomes: ${JSON.stringify(hist)}`);
  if (rows.length === 0) { console.error('FAIL: the store is not hydrating on this build.'); failures++; }
  for (const { ts, j } of rows.filter((r) => r.j.outcome !== 'absent')) {
    console.log(`  ${ts} ${j.username} outcome=${j.outcome} sessionDay=${j.sessionDay} fileSessionDay=${j.fileSessionDay} ` +
      `fileUpdatedAt=${j.fileUpdatedAt} restored=${j.restoredRows} dropped=${j.droppedRows} ephemeral=${j.ephemeralStore}`);
    // The inversion guard, graded rather than trusted: a row may only be restored when the
    // snapshot's session day is byte-equal to today's. A restored PRIOR-session fact would
    // condemn a CLEAN row -- a fabricated exclusion, which the ticket calls worse than the bug.
    if (j.outcome === 'restored' && j.fileSessionDay !== j.sessionDay) {
      console.error(`  FAIL: restored across a session-day boundary (${j.fileSessionDay} -> ${j.sessionDay}).`);
      failures++;
    }
  }
} else {
  const rows = parse((await pull('session-condemnation', 200))?.logs ?? []);
  console.log(`\ncensus verdict lines: ${rows.length}`);
  if (rows.length === 0) {
    // Absence is NOT a pass. BLIND is stated, never inferred from a missing line -- a
    // missing line is exactly what a reader cannot distinguish from a healthy run.
    console.error('FAIL: no verdict line in the window. The census must speak on EVERY run.');
    process.exit(1);
  }
  const hist = {};
  for (const { ts, j } of rows) {
    const key = `${j.coverage}/${j.reason}`;
    hist[key] = (hist[key] ?? 0) + 1;
    const msg = j.msg ?? '';
    // THE TRA-3468 DEFECT, as an assertion: INTACT prose is reachable ONLY from
    // coverage === 'intact'. A correct structured field under a contradicting sentence
    // is still the defect, because the log line IS the deliverable -- none of this
    // reaches the report JSON.
    if (msg.includes('INTACT') && j.coverage !== 'intact') {
      console.error(`  FAIL ${ts}: coverage=${j.coverage} but the prose says INTACT -- ${msg}`);
      failures++;
    }
    const want = j.coverage === 'blind' ? SENTENCE.blind
      : j.coverage === 'restored' ? SENTENCE.restored
        : j.excluded === 0 ? SENTENCE.intactEmpty : SENTENCE.intactCovered;
    if (!msg.includes(want)) {
      console.error(`  FAIL ${ts}: coverage=${j.coverage} excluded=${j.excluded} expected sentence ${JSON.stringify(want)}, got ${JSON.stringify(msg)}`);
      failures++;
    }
    // uncoveredMs is TRI-STATE (the TRA-3116 idiom): 0 only where there provably is no
    // gap, null -- never 0 -- wherever a gap exists whose size is unknowable.
    if (j.coverage === 'blind' && j.uncoveredMs !== null) {
      console.error(`  FAIL ${ts}: blind must carry uncoveredMs=null, got ${j.uncoveredMs}`);
      failures++;
    }
    if (j.coverage === 'intact' && j.uncoveredMs !== 0) {
      console.error(`  FAIL ${ts}: intact must carry uncoveredMs=0, got ${j.uncoveredMs}`);
      failures++;
    }
    if (j.coverage === 'restored' && typeof j.uncoveredMs !== 'number') {
      console.error(`  FAIL ${ts}: restored must carry a real uncoveredMs, got ${j.uncoveredMs}`);
      failures++;
    }
  }
  console.log(`coverage histogram: ${JSON.stringify(hist, null, 1)}`);
  const sample = rows.find((r) => r.j.coverage === 'restored') ?? rows[0];
  console.log(`sample line: ${sample.ts} ${JSON.stringify(sample.j)}`);
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL -- ${failures} violation(s)`);
process.exit(failures === 0 ? 0 : 1);
