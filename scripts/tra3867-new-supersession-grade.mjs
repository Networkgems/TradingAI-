#!/usr/bin/env node
/**
 * TRA-3867 — grade the "new, unruled day-cell supersession" axis on LIVE bqb1 bytes.
 *
 * TRA-3864 was ruled (b) FREEZE, so `journalDayCellAgreementOk` is `false`
 * permanently: nothing can retire the 3 ruled cells. This grader proves the
 * REPLACEMENT verdict is real — i.e. that it is green today for the right
 * reason, and that a 4th divergence would still flip it.
 *
 *   AC1  the raw identity is UNMOVED. `journalDayCellAgreementOk` is still
 *        `false`, all 3 cells still publish in the count and the date lists.
 *        The exemption must suppress a VERDICT, never a row.
 *   AC2  `journalDayCellNoNewSupersessionOk` is `true` on live bytes, and it is
 *        true because the superseded set MINUS the acknowledged set is empty —
 *        recomputed by hand off the raw `engines[].journalSupersededDates`, and
 *        compared to the published field in BOTH directions. A published set
 *        that merely restates itself passes a one-way check.
 *   AC3  THE DISCRIMINATING CONTROL. The deployed fold is replayed locally and
 *        fed a synthetic 4th divergence; the verdict must flip to `false`, the
 *        unacknowledged list must name exactly that cell, and the superseded
 *        COUNT must go 3 -> 4 (the 3 keep publishing). Admissibility of the
 *        replay is not asserted from the SHA alone: the same local function is
 *        first fed the live engine rows UNCHANGED and must reproduce every
 *        published field byte-for-byte. A replay that cannot reproduce the live
 *        object is not the deployed code and reads BLIND, not PASS.
 *   AC4  the exemption is auditable from the wire: `journalDayCellAcknowledgedCells`
 *        is published, every entry cites a ticket, and every acknowledged cell
 *        is a SUBSET of the superseded set (a stale entry is a standing
 *        pre-exemption and must show up in `journalDayCellStaleAcknowledgements`).
 *
 * Exit: 0 PASS · 1 FAIL · 3 BLIND (refusing to grade).
 */

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BQB1 = 'https://tradingai-bqb1.onrender.com';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const say = (s) => console.log(s);
const die = (code, msg) => { say(''); say(msg); process.exit(code); };
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  say(`    ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { say(`          got  ${JSON.stringify(got)}`); say(`          want ${JSON.stringify(want)}`); failed++; }
  return ok;
};

const user = process.env.TRADING_ADMIN_USERNAME;
const pass = process.env.TRADING_ADMIN_PASSWORD;
if (!user || !pass) die(3, 'BLIND: TRADING_ADMIN_USERNAME / TRADING_ADMIN_PASSWORD unset.');

const login = await fetch(`${BQB1}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass }),
});
const token = (await login.json().catch(() => ({}))).token;
if (!token) die(3, `BLIND: login ${login.status} with no bearer token.`);

async function get(p) {
  const r = await fetch(`${BQB1}${p}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) die(3, `BLIND: GET ${p} -> ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------- build pin
// /api/health is a 45-byte {ok,time} with no build block, so a pin taken there
// reads BLIND on a healthy box (TRA-3718). Pin off options-live, and re-pin at
// the END so every number below is provably from ONE process.
const pinOf = (h) => ({ pid: h?.build?.pid, startedAt: h?.build?.startedAt, commit: h?.build?.commit ?? null });
const pin0 = pinOf(await get('/api/health/options-live'));
say('=== BUILD PIN (from /api/health/options-live, re-measured this run)');
say(`    pid ${pin0.pid}  startedAt ${pin0.startedAt}  commit ${pin0.commit}`);
if (pin0.pid === undefined || !pin0.startedAt || !pin0.commit) {
  die(3, 'BLIND: no build.pid/startedAt/commit — cannot pin the bytes being graded.');
}

const rec = await get('/api/health/pnl-reconciliation?detail=1');
const engines = rec.engines ?? rec.books ?? [];
if (!Array.isArray(engines) || engines.length === 0) die(3, 'BLIND: no engines[] on the reconciliation payload.');
if (rec.journalDayCellNoNewSupersessionOk === undefined) {
  die(3, `BLIND: the live build (${pin0.commit?.slice(0, 12)}) does not publish `
    + 'journalDayCellNoNewSupersessionOk — TRA-3867 is NOT deployed here.');
}

// -------------------------------------------------------------------- AC1
say('');
say('=== AC1 the raw identity is UNMOVED — the ruled cells still publish');
const handSuperseded = engines
  .filter(e => (e.journalSupersededDates ?? []).length > 0)
  .flatMap(e => e.journalSupersededDates.map(d => `${e.username}|${e.mode}|${d}`))
  .sort();
say(`    hand-recomputed superseded cells: ${handSuperseded.length}`);
for (const k of handSuperseded) say(`      ${k}`);
check('journalDayCellAgreementOk is still the raw identity (false)', rec.journalDayCellAgreementOk, false);
check('liveJournalDayCellAgreementOk is still the raw identity (false)', rec.liveJournalDayCellAgreementOk, false);
check('journalDayCellSupersededCount == hand count', rec.journalDayCellSupersededCount, handSuperseded.length);
const publishedSuperseded = (rec.journalDayCellSupersededBooks ?? [])
  .flatMap(b => b.dates.map(d => `${b.username}|${b.mode}|${d}`)).sort();
check('published superseded set == hand set (BOTH directions)', publishedSuperseded, handSuperseded);

// -------------------------------------------------------------------- AC2
say('');
say('=== AC2 the gateable verdict is green, and green for the RIGHT reason');
const ackCells = rec.journalDayCellAcknowledgedCells ?? [];
const ackKeys = new Set(ackCells.map(a => `${a.username}|${a.mode}|${a.date}`));
const handUnack = handSuperseded.filter(k => !ackKeys.has(k)).sort();
const publishedUnack = (rec.journalDayCellUnacknowledgedBooks ?? [])
  .flatMap(b => b.dates.map(d => `${b.username}|${b.mode}|${d}`)).sort();
say(`    hand-recomputed UNACKNOWLEDGED residue: ${handUnack.length} ${JSON.stringify(handUnack)}`);
check('published unacknowledged set == hand set (BOTH directions)', publishedUnack, handUnack);
check('journalDayCellUnacknowledgedCount == hand count', rec.journalDayCellUnacknowledgedCount, handUnack.length);
check('journalDayCellNoNewSupersessionOk', rec.journalDayCellNoNewSupersessionOk, handUnack.length === 0 ? true : false);
check('liveJournalDayCellNoNewSupersessionOk', rec.liveJournalDayCellNoNewSupersessionOk,
  handUnack.some(k => k.split('|')[1] === 'live') ? false : true);
// A green over an EMPTY cohort is the manufactured pass this endpoint has
// shipped twice (TRA-2924, TRA-2630 AC2). The denominator has to be stated.
say(`    denominator: ${rec.journalDayCellGradeableCount} gradeable cells over `
  + `${rec.journalDayCellGradeableBookCount} books (${rec.liveJournalDayCellGradeableBookCount} live)`);
if (!(rec.journalDayCellGradeableCount > 0) || !(rec.liveJournalDayCellGradeableBookCount > 0)) {
  say('    FAIL  the cohort is empty — a green here says nothing was looked at.');
  failed++;
}

// -------------------------------------------------------------------- AC3
say('');
say('=== AC3 DISCRIMINATING CONTROL — replay the deployed fold and inject a 4th cell');
const localSha = execSync('git rev-parse HEAD', { cwd: REPO, encoding: 'utf8' }).trim();
say(`    live commit  ${pin0.commit}`);
say(`    local HEAD   ${localSha}`);
if (localSha !== pin0.commit) {
  say('    (SHA differs — admissibility is decided by the byte-for-byte replay below, not by this line.)');
}
let summarize;
try {
  ({ summarizeJournalDayCellAgreement: summarize } =
    await import(path.join(REPO, 'packages/server/dist/pnl-reconciliation.js')));
} catch {
  try {
    ({ summarizeJournalDayCellAgreement: summarize } =
      await import(path.join(REPO, 'packages/server/src/pnl-reconciliation.ts')));
  } catch (e) {
    die(3, `BLIND: cannot load the fold to replay it (${e.message}). Run \`pnpm --filter @trading-app/server build\`.`);
  }
}
const rows = engines.map(e => ({
  username: e.username,
  mode: e.mode,
  journalAgreementOk: e.journalAgreementOk,
  journalSupersededDates: e.journalSupersededDates ?? [],
  journalAgreementGradeableCount: e.journalAgreementGradeableCount ?? 0,
  maxJournalSupersessionUsd: e.maxJournalSupersessionUsd ?? null,
}));
// ADMISSIBILITY: the local fold must reproduce the live object exactly, or it
// is not the code that served these bytes and this control proves nothing.
const replay = summarize(rows);
const FOLD_FIELDS = Object.keys(replay);
const mismatched = FOLD_FIELDS.filter(k => JSON.stringify(replay[k]) !== JSON.stringify(rec[k]));
if (mismatched.length > 0) {
  say(`    BLIND: the local fold does not reproduce the live object on ${JSON.stringify(mismatched)}.`);
  for (const k of mismatched) {
    say(`           ${k}: live ${JSON.stringify(rec[k])} vs replay ${JSON.stringify(replay[k])}`);
  }
  die(3, 'BLIND: refusing to grade a control against a fold that is not the deployed one.');
}
say(`    admissible: the local fold reproduces all ${FOLD_FIELDS.length} published fields byte-for-byte.`);

// Now the injection. A 4th cell on the LIVE money book, a date nobody ruled.
const liveBook = rows.find(r => r.mode === 'live' && r.journalAgreementGradeableCount > 0);
if (!liveBook) die(3, 'BLIND: no gradeable live book to inject into.');
const SYNTH = '1999-12-31'; // provably outside any ruled set
const perturbed = rows.map(r => (r === liveBook
  ? { ...r, journalAgreementOk: false, journalSupersededDates: [...r.journalSupersededDates, SYNTH] }
  : r));
const after = summarize(perturbed);
say(`    injected a 4th divergence: ${liveBook.username}|${liveBook.mode}|${SYNTH}`);
check('the RAW identity cannot tell the two states apart (this is the defect)',
  after.journalDayCellAgreementOk, rec.journalDayCellAgreementOk);
check('journalDayCellNoNewSupersessionOk FLIPS to false', after.journalDayCellNoNewSupersessionOk, false);
check('liveJournalDayCellNoNewSupersessionOk FLIPS to false', after.liveJournalDayCellNoNewSupersessionOk, false);
check('the unacknowledged list names exactly the injected cell',
  after.journalDayCellUnacknowledgedBooks.flatMap(b => b.dates.map(d => `${b.username}|${b.mode}|${d}`)),
  [`${liveBook.username}|${liveBook.mode}|${SYNTH}`]);
check('the 3 ruled cells STILL publish — the count goes 3 -> 4, it is not clamped',
  after.journalDayCellSupersededCount, rec.journalDayCellSupersededCount + 1);
// The other direction: emptying the acknowledged set must turn the new verdict
// back into the raw identity. A verdict that is green whatever the set contains
// is the old vacuous pass wearing a new name.
const noAck = summarize(rows, []);
check('with an EMPTY acknowledged set the new verdict degenerates to the raw identity',
  noAck.journalDayCellNoNewSupersessionOk, rec.journalDayCellAgreementOk);
check('...and the residue is then the full superseded set',
  noAck.journalDayCellUnacknowledgedCount, rec.journalDayCellSupersededCount);

// -------------------------------------------------------------------- AC4
say('');
say('=== AC4 the exemption is auditable from the wire');
check('journalDayCellAcknowledgedCount == published cell count', rec.journalDayCellAcknowledgedCount, ackCells.length);
say(`    acknowledged cells (${ackCells.length}):`);
for (const a of ackCells) say(`      ${a.username}|${a.mode}|${a.date}  ${a.ticket}`);
const uncited = ackCells.filter(a => !/^TRA-\d+$/.test(a.ticket ?? ''));
check('every acknowledged cell cites its ruling ticket', uncited, []);
const stale = ackCells.filter(a => !handSuperseded.includes(`${a.username}|${a.mode}|${a.date}`))
  .map(a => `${a.username}|${a.mode}|${a.date}`).sort();
const publishedStale = (rec.journalDayCellStaleAcknowledgements ?? [])
  .map(a => `${a.username}|${a.mode}|${a.date}`).sort();
check('published stale acknowledgements == hand set (a dead entry pre-exempts that cell)', publishedStale, stale);
if (stale.length > 0) say(`    NOTE: ${stale.length} acknowledgement(s) name a cell that no longer diverges.`);

// ------------------------------------------------------------------- re-pin
const pin1 = pinOf(await get('/api/health/options-live'));
say('');
say('=== RE-PIN');
say(`    pid ${pin1.pid}  startedAt ${pin1.startedAt}  commit ${pin1.commit}`);
if (pin1.pid !== pin0.pid || pin1.startedAt !== pin0.startedAt || pin1.commit !== pin0.commit) {
  die(3, 'BLIND: the box moved under the grade — every number above spans two processes.');
}

say('');
if (failed > 0) die(1, `FAIL — ${failed} check(s) failed on live bytes ${pin0.commit?.slice(0, 12)} pid ${pin0.pid}.`);
die(0, `PASS — all checks green on live bytes ${pin0.commit?.slice(0, 12)} pid ${pin0.pid}.`);
