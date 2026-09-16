// TRA-3980 — FOLD THE TAPE INTO THE DISTRIBUTION THE BOARD WOULD SET A CEILING
// AGAINST, and say whether the tape supports one AT ALL.
//
// ⛔ THIS SCRIPT DOES NOT PROPOSE A CEILING VALUE. That is a board number
// (TRA-3979 scope note): a refusal at the `buy_to_open` path is a change to a
// ratified arm. What it reports is whether the observation is strong enough to
// carry one — sessions observed vs AC1's floor of 5, how much of the tape is a
// LOWER BOUND, and whether the hazard reproduced.
//
// Exit 0 report rendered · 2 usage · 3 BLIND (no readable tape).
import fs from 'node:fs';
import path from 'node:path';
import { foldTape, renderReport } from './lib/tra3980-concentration-tape.mjs';

const ARG = k => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const TAPE = ARG('tape')
  ?? path.join(process.cwd(), 'evidence', 'tra3980', 'fleet-concentration-tape.jsonl');
const MIN_SESSIONS = Number(ARG('min-sessions') ?? 5); // AC1

if (!fs.existsSync(TAPE)) {
  console.error(`BLIND — no tape at ${TAPE}. Run tra3980-fleet-concentration-sample.mjs first.`);
  process.exit(3);
}

const lines = [];
let malformed = 0;
for (const raw of fs.readFileSync(TAPE, 'utf8').split('\n')) {
  const s = raw.trim();
  if (s === '') continue;
  try { lines.push(JSON.parse(s)); } catch { malformed += 1; }
}
if (malformed > 0) console.error(`# WARN ${malformed} malformed tape line(s) skipped`);
if (lines.length === 0) {
  console.error(`BLIND — tape at ${TAPE} holds no parseable line.`);
  process.exit(3);
}

const fold = foldTape(lines);
const c = fold.census;

// ── The verdict on the OBSERVATION, never on the ceiling ──────────────────────
// ⭐ THREE INDEPENDENT WAYS THE TAPE CAN FAIL TO CARRY A CEILING, AND THEY ARE
// NOT INTERCHANGEABLE: too few sessions (AC1), too much of it soft (§3), or the
// hazard never reproduced. A report that collapsed them into one boolean would
// let "we watched and it never happened" read the same as "we could not watch".
const softFrac = c.samplesGraded > 0 ? c.samplesLowerBound / c.samplesGraded : 1;
const verdict = [];
if (c.sessionsObserved < MIN_SESSIONS) {
  verdict.push(`⛔ **AC1 NOT MET** — ${c.sessionsObserved} session(s) observed, floor is `
    + `${MIN_SESSIONS}. The window is still open; this is an interim reading.`);
} else {
  verdict.push(`✅ AC1 met — ${c.sessionsObserved} sessions observed.`);
}
if (c.samplesGraded === 0) {
  verdict.push('⛔ **Nothing was graded.** Every sample is a refusal — see the census. '
    + 'The tape carries no distribution and therefore supports no ceiling.');
} else if (softFrac >= 0.5) {
  verdict.push(`⚠ **${c.samplesLowerBound}/${c.samplesGraded} graded samples are LOWER BOUNDS** `
    + `(${(softFrac * 100).toFixed(0)}%). The shares are soft in the PERMISSIVE direction, so a `
    + 'ceiling reasoned from the ALL rows would be set too HIGH. Cite the HARD rows.');
} else {
  verdict.push(`✅ ${c.samplesHard}/${c.samplesGraded} graded samples are HARD readings.`);
}
// ⭐ A FOURTH, AND IT IS *NOT* THE SOFT/HARD SPLIT ABOVE. `concentrationIsLowerBound`
// grades the ROWS a probe could see; this grades WHETHER THE PROBE LOOKED WHILE
// THE ENGINE WAS TRADING. A session sampled only pre-open is a fully HARD reading
// of yesterday's book, and it will report `samplesHard == samplesGraded` while
// having observed nothing the entry window did. Kept separate so a clean soft
// census cannot vouch for coverage it never measured.
if (c.sessionsObserved > 0 && c.sessionsPreOpenOnly > 0) {
  verdict.push(`⚠ **${c.sessionsPreOpenOnly}/${c.sessionsObserved} observed session(s) have NO `
    + 'sample at or after their own 09:30 ET open** — a pre-open probe sees only positions that '
    + 'already existed, so those sessions did not observe the entry window the 08-24 event '
    + 'happened inside. Their peaks are floors on the session. This is coverage, not row '
    + 'softness: it is invisible to `concentrationIsLowerBound`.');
} else if (c.sessionsObserved > 0) {
  verdict.push(`✅ All ${c.sessionsObserved} observed session(s) were sampled at or after the open.`);
}
// ⭐ A FIFTH, AND THE ONLY ONE THAT BIASES THE DISTRIBUTION *DOWN*. The four
// above all make a reading look SAFER than it is by understating a share or a
// peak. This one is about the population: flat sessions are legitimately in the
// denominator, but they answer "did the engine open anything" and a board
// reading the pooled p50 will hear "concentration is typically nil" when what
// the tape says is "the engine typically opened nothing". State the split and
// the conditional n, so the strength claim below is scoped to the sessions that
// could have exhibited concentration at all.
if (c.sessionsFlat > 0) {
  verdict.push(`⚠ **${c.sessionsFlat}/${c.sessionsObserved} observed session(s) were FLAT** `
    + '(every sample `empty` — the fleet held nothing). They are correctly IN the denominator, '
    + `but only **${c.sessionsHoldingPositions}** session(s) held a position and could exhibit `
    + 'concentration at all. The pooled per-session p0–p50 is therefore a reading of ENTRY FLOW, '
    + 'not of concentration; the HELD-POSITIONS rows are the population a ceiling would bind.');
} else if (c.sessionsObserved > 0) {
  verdict.push(`✅ All ${c.sessionsObserved} observed session(s) held at least one position — no `
    + 'flat session dilutes the per-session rows.');
}
if (fold.multiBook.sessions > 0) {
  verdict.push(`🔴 **The hazard reproduced in ${fold.multiBook.sessions} of `
    + `${c.sessionsObserved} observed session(s)** — one contract held by more than one `
    + 'gate-open book. Each occurrence is named below.');
} else if (c.samplesGraded > 0) {
  verdict.push('The hazard did NOT reproduce in the observed tape — `multiBookContracts` was '
    + 'empty in every graded sample. Note this is evidence about the OBSERVED sessions, not '
    + 'about the mechanism: the fleet bound still counts dollars, so nothing prevents it.');
}

const supported = c.sessionsObserved >= MIN_SESSIONS && c.samplesGraded > 0;

console.log(renderReport(fold, {
  note: [
    '',
    '#### Does the tape support a fleet-concentration ceiling?',
    '',
    ...verdict.map(v => `- ${v}`),
    '',
    supported
      ? '**The observation is strong enough to carry a board ceiling decision.** '
        + 'This report does NOT propose a value — a refusal at the `buy_to_open` path is a '
        + 'change to a ratified arm and the number is the board\'s (TRA-3979 scope note).'
        + (c.sessionsPreOpenOnly > 0
          ? ` ⚠ Qualified: ${c.sessionsPreOpenOnly} of those sessions were sampled only pre-open `
            + '(see the coverage line above), so the per-SESSION rows are floors for those days.'
          : '')
        // ⛔ AC1's floor counts SESSIONS, and a flat session is a valid one — so
        // the floor can be met on a tape carrying very few readings OF
        // CONCENTRATION. Say the conditional n on the same line as the strength
        // claim; a qualification further up the report is one a board member
        // quoting this sentence will not carry with them.
        + (c.sessionsFlat > 0
          ? ` ⚠ Qualified on n: AC1's floor counts sessions and ${c.sessionsFlat} of the `
            + `${c.sessionsObserved} were FLAT, so the calibration population is `
            + `**${c.sessionsHoldingPositions} session(s)**, not ${c.sessionsObserved}. The tape `
            + 'establishes that concentration is REACHABLE at the observed levels; it is thin '
            + 'evidence for where in that range a value belongs.'
          : '')
      : '**The observation is NOT yet strong enough to carry a ceiling decision.** '
        + 'No value is proposed and none should be inferred from the rows above.',
    '',
    `_Tape: \`${path.relative(process.cwd(), TAPE).replace(/\\/g, '/')}\` · `
      + `${lines.length} line(s) · folded by \`scripts/tra3980-fleet-concentration-report.mjs\`._`,
  ].join('\n'),
}));
process.exit(0);
