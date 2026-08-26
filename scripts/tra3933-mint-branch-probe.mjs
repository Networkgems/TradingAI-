#!/usr/bin/env node
// TRA-3933 AC1 — WHICH branch of `queueJournalImportOpen` minted `6bbc5d17`?
//
// The journal rows prove a duplicate exists; they cannot say which of the four
// terminating branches wrote it, and the remediation is DIFFERENT per branch:
//
//   ADOPT      (exactly one adoptable OPEN)  -> logs  "reconcile rebound an imported row..."
//   OWN-ROW    (an OPEN row already under this position's id) -> silent, TRA-3078
//   AMBIGUOUS  (more than one adoptable)     -> logs  "refusing to rebind an imported row..."
//   MINT       (zero adoptable)              -> SILENT. No line at all.
//
// The silence of the zero-adoptable mint is the whole problem: it is the branch
// whose remediation is ORDERING (the reconcile observed the broker's fill before
// this engine had registered its own open), and it is the only one that leaves no
// trace. So this probe does not look for a line that names the mint — there is
// none. It ESTABLISHES THE BRANCH BY ELIMINATION, over the exact window, and it
// refuses to conclude anything unless the reader is proven live on that window.
//
// ── The controls (a zero must mean "did not fire", never "did not read") ──────
// Render encodes ZERO MATCHES as `logs: null`, and a wrong `resource=` returns the
// SAME `logs: null`; `?limit=200` returns an error OBJECT at HTTP 200. Every zero
// below is therefore gated on: an unfiltered pull returning lines in this window,
// a needle lifted OUT of that sample matching itself, and an impossible needle
// matching nothing. Any control failing exits BLIND (3) and prints no verdict.
//
// ── Usage ────────────────────────────────────────────────────────────────────
//   RENDER_API_KEY=… node scripts/tra3933-mint-branch-probe.mjs
//   RENDER_API_KEY=… node scripts/tra3933-mint-branch-probe.mjs \
//       --occ=BAC260925C00063000 --at=2026-08-20T13:36:22.482Z --span=20
//
// Exit codes:
//   0  branch established        1  evidence CONTRADICTS the by-elimination read
//   2  usage/arg error           3  BLIND — a control failed; report NOTHING

const KEY = process.env.RENDER_API_KEY;
const SERVICE = process.env.RENDER_SERVICE_ID ?? 'srv-d7mb7rr7uimc73ev0chg';
const OWNER = process.env.RENDER_OWNER_ID ?? 'tea-d7macfog4nts73ai6p40';

if (!KEY) { console.error('no RENDER_API_KEY — BLIND, this is a HOLD'); process.exit(3); }

// The subject, defaulted to the filed incident so the zero-arg run reproduces it.
let occ = 'BAC260925C00063000';
let atIso = '2026-08-20T13:36:22.482Z';   // the MINTED row's openTs (broker acquiredAt)
let spanMin = 20;
for (const a of process.argv.slice(2)) {
  let m;
  if ((m = /^--occ=(.+)$/.exec(a))) occ = m[1];
  else if ((m = /^--at=(.+)$/.exec(a))) atIso = m[1];
  else if ((m = /^--span=(\d+)$/.exec(a))) spanMin = Number(m[1]);
  else { console.error(`unknown arg ${a}`); process.exit(2); }
}
const atMs = Date.parse(atIso);
if (!Number.isFinite(atMs)) { console.error(`--at is not a timestamp: ${atIso}`); process.exit(2); }
if (!(spanMin > 0 && spanMin <= 240)) { console.error('--span must be 1..240 minutes'); process.exit(2); }

// Centred on the open, not trailing it: the reconcile that minted can precede the
// broker's own `acquiredAt` stamp (that is the ordering hypothesis under test), so
// a window that starts AT the open would be blind to exactly the case we want.
const START = new Date(atMs - spanMin * 60_000).toISOString();
const END = new Date(atMs + spanMin * 60_000).toISOString();

console.log(`TRA-3933 mint-branch probe`);
console.log(`  contract ${occ}`);
console.log(`  window   ${START} -> ${END}  (+/- ${spanMin} min around ${atIso})`);
console.log(`  service  ${SERVICE}`);
console.log('');

async function pull({ text = null, limit = 100, endTime = END } = {}) {
  const u = new URL('https://api.render.com/v1/logs');
  u.searchParams.set('resource', SERVICE);           // NOT `resource[]=`
  if (OWNER) u.searchParams.set('ownerId', OWNER);
  u.searchParams.set('startTime', START);
  u.searchParams.set('endTime', endTime);
  u.searchParams.set('limit', String(limit));        // MAX 100 — larger 200s with an error OBJECT
  if (text !== null) u.searchParams.set('text', text);
  const r = await fetch(u, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
  if (r.status === 429) throw new Error('429 rate limited — an aborted read is an UNDERCOUNT, not a zero');
  if (!r.ok) throw new Error(`logs ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  if (j.logs !== null && !Array.isArray(j.logs)) {
    throw new Error(`logs field is neither null nor an array (${typeof j.logs}) — refusing to read it as zero`);
  }
  return { lines: j.logs ?? [], hasMore: j.hasMore === true, nextEndTime: j.nextEndTime ?? null };
}

// Render paginates BACKWARD: `nextEndTime` is the oldest line just returned, so the
// next page is the same window with `endTime` moved back to it. Reading page 1 as
// the total is how an undercount gets published as a census.
async function pullAll({ text = null, cap = 2000 } = {}) {
  const out = [];
  let endTime = END;
  for (let page = 0; page < 40 && out.length < cap; page += 1) {
    const p = await pull({ text, endTime });
    out.push(...p.lines);
    if (!p.hasMore || !p.nextEndTime || p.nextEndTime === endTime) break;
    endTime = p.nextEndTime;
  }
  return out;
}

// ── Controls ─────────────────────────────────────────────────────────────────
const c1 = await pull({ limit: 5 });
console.log(`CONTROL 1 (unfiltered)         : ${c1.lines.length} line(s) — reader ${c1.lines.length > 0 ? 'LIVE' : 'BLIND'}`);
if (c1.lines.length === 0) {
  console.error('reader returned 0 unfiltered over the window — BLIND (retention? wrong resource?). This is a HOLD.');
  process.exit(3);
}

// Calibrate the needle OUT of the sample rather than hardcoding one: a hardcoded
// needle decays the moment someone suppresses that emitter (TRA-3800 did exactly
// that to the census's probe), and then the control is a permanent false alarm.
// ⚠️ Render splits `text=` on commas — token on letters only so it cannot happen.
function pickNeedle(lines) {
  let best = null;
  for (const l of lines) {
    for (const tok of String(l.message ?? '').split(/[^A-Za-z]+/)) {
      if (tok.length >= 8 && (best === null || tok.length > best.length)) best = tok;
    }
  }
  return best;
}
const needle = pickNeedle(c1.lines);
if (needle === null) { console.error('CONTROL 2 UNCALIBRATED — no >=8-char alpha token in the sample. BLIND.'); process.exit(3); }
const c2 = await pull({ text: needle, limit: 5 });
const c2hits = c2.lines.filter(l => String(l.message ?? '').includes(needle)).length;
console.log(`CONTROL 2 (calibrated text=)   : ${c2hits} line(s) for "${needle}" — filter ${c2hits > 0 ? 'WORKS' : 'SUSPECT'}`);
if (c2hits === 0) { console.error('a token lifted from a line INSIDE this window matched nothing — text= is not filtering. BLIND.'); process.exit(3); }

const c3 = await pull({ text: 'tra3933needlethatcannotexist', limit: 5 });
console.log(`CONTROL 3 (impossible text=)   : ${c3.lines.length} line(s) — filter ${c3.lines.length === 0 ? 'not broken-open' : 'BROKEN-OPEN'}`);
if (c3.lines.length !== 0) { console.error('an impossible needle matched — text= is ignored, every zero below is UNREAD. BLIND.'); process.exit(3); }
console.log('');

// ── The branch signatures ────────────────────────────────────────────────────
// Needles are single alpha tokens for the same comma-splitting reason; the phrase
// match is applied client-side against the full message.
const BRANCHES = [
  {
    key: 'ADOPT',
    needle: 'rebound',
    phrase: 'reconcile rebound an imported row onto its existing journal row',
    means: 'the reconciler DID find exactly one adoptable OPEN and rebound onto it',
  },
  {
    key: 'AMBIGUOUS',
    needle: 'refusing',
    phrase: 'refusing to rebind an imported row: multiple OPEN journal rows',
    means: 'two or more OPEN rows on this OCC — the refuse-and-mint branch',
  },
];

const occHits = await pullAll({ text: occ });
const occLines = occHits.filter(l => String(l.message ?? '').includes(occ));
console.log(`lines naming ${occ} in window: ${occLines.length}`);
for (const l of occLines.slice(-40)) {
  let msg = String(l.message ?? '');
  try {
    const o = JSON.parse(msg);
    msg = `${o.level ?? '?'} ${o.msg ?? ''} ${o.issue ? '[' + o.issue + ']' : ''} ${o.positionId ?? ''} ${o.journalId ?? ''}`.trim();
  } catch { msg = msg.slice(0, 200); }
  console.log(`  ${l.timestamp}  ${msg}`);
}
console.log('');

const found = {};
for (const b of BRANCHES) {
  const lines = (await pullAll({ text: b.needle }))
    .filter(l => String(l.message ?? '').includes(b.phrase));
  const onOcc = lines.filter(l => String(l.message ?? '').includes(occ));
  found[b.key] = { any: lines.length, onOcc: onOcc.length };
  console.log(`${b.key.padEnd(10)} "${b.phrase.slice(0, 52)}…"`);
  console.log(`  ${lines.length} line(s) in window, ${onOcc.length} of them on ${occ}`);
  for (const l of onOcc.slice(0, 5)) console.log(`    ${l.timestamp}  ${String(l.message).slice(0, 220)}`);
}
console.log('');

// ── Verdict ──────────────────────────────────────────────────────────────────
// The OWN-ROW branch is excluded by the ROW, not by the tape: it resolves to
// identity and writes nothing, so it cannot be the author of a row that exists.
// The no-`optionSymbol` mint is excluded by the row too — the minted row CARRIES
// an `optionSymbol`, which that branch by construction omits.
const adopt = found.ADOPT.onOcc;
const ambig = found.AMBIGUOUS.onOcc;

if (adopt > 0 && ambig === 0) {
  console.log('VERDICT: the reconciler REBOUND on this OCC in this window.');
  console.log('  That CONTRADICTS a zero-adoptable mint being the author of the duplicate.');
  console.log('  Re-open AC1: the duplicate came from somewhere this probe does not model.');
  process.exit(1);
}
if (ambig > 0) {
  console.log('VERDICT: AMBIGUOUS branch (adoptable.length > 1) — the refuse-and-mint path.');
  console.log('  Remediation is MATCHING, not ordering: two OPEN rows already existed on this OCC.');
  process.exit(0);
}
console.log('VERDICT: MINT via the ZERO-ADOPTABLE fall-through (adoptable.length === 0).');
console.log('  Established by elimination, on a window proven readable by three controls:');
console.log('    • the row exists, so the OWN-ROW identity branch (writes nothing) is not it;');
console.log('    • the row carries an optionSymbol, so the no-OCC mint is not it;');
console.log(`    • AMBIGUOUS logs a warn and fired ${ambig}x on this OCC;`);
console.log(`    • ADOPT logs an info and fired ${adopt}x on this OCC.`);
console.log('  => `findOpenOptionTradeJournalRecordsByOptionSymbol` returned NOTHING to adopt,');
console.log('     i.e. the engine had not yet written its own OPEN row when the reconcile ran.');
console.log('  The fix is ORDERING (and the mint being silent), not the matching rule.');
process.exit(0);
