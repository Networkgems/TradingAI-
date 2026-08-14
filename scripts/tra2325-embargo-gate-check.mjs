#!/usr/bin/env node
// tra2325-embargo-gate-check.mjs — TRA-2325 / TRA-2322
//
// Discrimination suite for the two deploy gates in render-redeploy.mjs:
//   1. the daily RTH freeze, now opened DEPLOY_LEAD_MIN early (13:25Z, not 13:30Z),
//      because a deploy CREATED at 13:29Z BOOTS the box inside RTH;
//   2. the dated EMBARGO table (Mon 2026-07-27 13:25Z–21:00Z for the bqb1 hold; the close
//      side was extended from 20:20Z on 2026-07-26 — TRA-2306, see render-redeploy.mjs).
//
// A gate that refuses everything is not a gate, so every REFUSE case here is paired
// with a PROCEED case that differs by the one variable under test. A suite where the
// PROCEED cases cannot go green would rubber-stamp a permanently-jammed guard.
//
//   node scripts/tra2325-embargo-gate-check.mjs
//   exit 0 = all cases pass · 1 = a case failed

import { spawnSync } from 'node:child_process';
import {
  freezeState,
  embargoState,
  commitHoldState,
  envWriteHoldWarning,
  resolveTarget,
  rollbackState,
  rollbackBlocks,
  stalePinNote,
  gradeCarries,
  carriesFromVerdict,
  isShallowCheckout,
  EMBARGOES,
  COMMIT_HOLDS,
  DEPLOY_LEAD_MIN,
  FREEZE_OPEN_MIN,
  FREEZE_CLOSE_MIN,
} from './render-redeploy.mjs';

const at = iso => new Date(iso);

// The decision render-redeploy.mjs makes for the SOAK HOST with no override flags.
// Embargo is checked first there, so it is checked first here.
const verdict = now => {
  if (embargoState(now).active) return 'REFUSE_EMBARGO';
  if (freezeState(now).frozen) return 'REFUSE_FREEZE';
  return 'PROCEED';
};

const CASES = [
  // ── The edges TRA-2325 named, on the embargoed Monday ────────────────────────
  ['2026-07-27T13:20:00Z', 'PROCEED', 'Mon 13:20Z — pre-open and pre-embargo: the ticket says this slot is fine'],
  ['2026-07-27T13:24:59Z', 'PROCEED', 'Mon 13:24:59Z — last clear instant before the embargo'],
  ['2026-07-27T13:25:00Z', 'REFUSE_EMBARGO', 'Mon 13:25:00Z sharp — embargo opens, half-open [from,to)'],
  ['2026-07-27T13:29:00Z', 'REFUSE_EMBARGO', 'Mon 13:29Z — the exact hole: old gate said exit 0, box boots in RTH'],
  ['2026-07-27T17:00:00Z', 'REFUSE_EMBARGO', 'Mon 17:00Z — mid-RTH, routine 0a9e7abc fires here'],
  ['2026-07-27T20:00:00Z', 'REFUSE_EMBARGO', 'Mon 20:00:00Z — the bell; old gate was FULLY OPEN from here'],
  ['2026-07-27T20:19:59Z', 'REFUSE_EMBARGO', 'Mon 20:19:59Z — still held'],

  // ── Close side, EXTENDED to 21:00Z on 2026-07-26 (CTO, TRA-2306) ─────────────
  // The old row closed at 20:20Z — the exact instant 0bb90f24 (TRA-2306) and dcedeb43
  // (TRA-2171) fire, and 5 min before the TRA-1648 soak check this embargo names. A deploy
  // CREATED at 20:20:00Z BOOTS ~2-3 min later, inside all of them: the created-vs-boots gap
  // DEPLOY_LEAD_MIN fixes on the open side, left unfixed on the close side.
  ['2026-07-27T20:20:00Z', 'REFUSE_EMBARGO', 'Mon 20:20:00Z sharp — 0bb90f24 (TRA-2306) + dcedeb43 fire HERE; was PROCEED'],
  ['2026-07-27T20:25:00Z', 'REFUSE_EMBARGO', 'Mon 20:25Z — 7d30dcfc TRA-1648 soak check, the read this embargo names'],
  ['2026-07-27T20:30:00Z', 'REFUSE_EMBARGO', 'Mon 20:30Z — f97baf3b TRA-2339 run check'],
  ['2026-07-27T20:45:00Z', 'REFUSE_EMBARGO', 'Mon 20:45Z — 7c3af47e TRA-2331 / e3e69d35 TRA-1585 grades'],
  ['2026-07-27T20:59:59Z', 'REFUSE_EMBARGO', 'Mon 20:59:59Z — last held instant'],
  ['2026-07-27T21:00:00Z', 'PROCEED', 'Mon 21:00:00Z sharp — embargo clear, half-open [from,to)'],
  ['2026-07-27T22:00:00Z', 'PROCEED', 'Mon 22:00Z — post-embargo, post-close'],

  // ── The daily freeze on an UN-embargoed weekday (the lead-time fix, isolated) ─
  ['2026-07-28T13:19:00Z', 'PROCEED', 'Tue 13:19Z — pre-open, outside the lead buffer'],
  ['2026-07-28T13:24:59Z', 'PROCEED', 'Tue 13:24:59Z — last clear instant before the freeze'],
  ['2026-07-28T13:25:00Z', 'REFUSE_FREEZE', 'Tue 13:25:00Z — freeze opens 5 min early (this is the fix)'],
  ['2026-07-28T13:29:00Z', 'REFUSE_FREEZE', 'Tue 13:29Z — the boot lands in RTH; old gate returned exit 0'],
  ['2026-07-28T13:30:00Z', 'REFUSE_FREEZE', 'Tue 13:30Z — RTH proper'],
  ['2026-07-28T19:59:59Z', 'REFUSE_FREEZE', 'Tue 19:59:59Z — last frozen instant'],
  ['2026-07-28T20:00:00Z', 'PROCEED', 'Tue 20:00:00Z — freeze closes at the bell, no late buffer'],

  // ── Weekend / off-hours: the freeze must NOT fire (direction control, TRA-2313) ─
  ['2026-07-25T17:00:00Z', 'PROCEED', 'Sat 17:00Z — weekend, clock inside RTH: freeze must NOT fire'],
  ['2026-07-26T17:00:00Z', 'PROCEED', 'Sun 17:00Z — weekend, clock inside RTH: freeze must NOT fire'],
  ['2026-07-27T02:00:00Z', 'PROCEED', 'Mon 02:00Z — weekday, pre-open, before the embargo'],

  // ── The 2026-08-13 post-close row (TRA-3625) ───────────────────────────────
  // This row exists to collapse three deploy carriers into ONE boot, so the cases that
  // matter are the three carrier instants themselves: two must be refused, the last must
  // NOT be. A row that also swallowed the 21:50Z carrier would strand TRA-3619's number
  // for Friday's RTH, which is the failure this is trying to avoid, not cause.
  ['2026-08-13T19:59:59Z', 'REFUSE_FREEZE', 'Thu 19:59:59Z — still the RTH freeze; the row is contiguous with it'],
  ['2026-08-13T20:00:00Z', 'REFUSE_EMBARGO', 'Thu 20:00:00Z sharp — freeze hands off to the embargo with NO gap'],
  ['2026-08-13T20:25:00Z', 'REFUSE_EMBARGO', 'Thu 20:25Z — 7d30dcfc TRA-1648 soak gate, the read a 20:30Z boot lands under'],
  ['2026-08-13T20:30:00Z', 'REFUSE_EMBARGO', 'Thu 20:30Z — fc05a69f TRA-3547 carrier fires HERE; must be held'],
  ['2026-08-13T21:00:00Z', 'REFUSE_EMBARGO', 'Thu 21:00Z — 31a25426 TRA-3387 carrier fires HERE; must be held'],
  ['2026-08-13T21:40:00Z', 'REFUSE_EMBARGO', 'Thu 21:40Z — 5293f29f TRA-2220, the last graded read of the cluster'],
  ['2026-08-13T21:45:00Z', 'PROCEED', 'Thu 21:45:00Z sharp — row spent, half-open [from,to)'],
  ['2026-08-13T21:50:00Z', 'PROCEED', 'Thu 21:50Z — e7ccfe59 TRA-3619 tip deploy: the ONE boot everything funnels into'],
  ['2026-08-14T13:24:59Z', 'PROCEED', 'Fri pre-open — the row is spent and does not leak into the next day'],
];

// ── The COMMIT HOLD (TRA-2306 / TRA-2355) ────────────────────────────────────
// A gate on WHAT ships, not WHEN. It is checked before the two time gates in
// render-redeploy.mjs because it fires while the calendar is wide open — which is the
// entire hole it was added to close: from the instant 204f298 landed on main until the
// embargo opens Mon 13:25Z, ~33 hours, every gate read PROCEED and the branch tip was
// the held commit.
//
// `carries` is injected, so these cases exercise the predicate without touching git or the
// network. HELD/CLEAN/UNKNOWN below stand for the three answers the real gitCarries gives.
const HELD = '204f2984896d62447d6a480c7f7c346b5071a5f6';
const holdVerdict = (now, target) => {
  const s = commitHoldState(at(now), target);
  return s.verdict === 'CLEAR' ? 'PROCEED' : `REFUSE_HOLD_${s.verdict}`;
};

// A target that carries the held commit / one that predates it / one we cannot test.
const carrying = sha => ({ sha, source: 'test', carries: h => h === HELD });
const clean = sha => ({ sha, source: 'test', carries: () => false });
const untestable = sha => ({ sha, source: 'test', carries: () => null });
const unresolved = { sha: null, source: 'test', error: 'ls-remote failed', carries: () => null };

const HOLD_CASES = [
  // While the hold is live — the ~33h window in which BOTH time gates said PROCEED.
  ['2026-07-26T04:45:00Z', carrying(HELD), 'REFUSE_HOLD_CARRIES', 'Sun 04:45Z — the hole: weekend, no embargo, tip IS the held commit'],
  ['2026-07-26T04:45:00Z', clean('88a072e'), 'PROCEED', 'Sun 04:45Z — SAME instant, a commit predating the hold: must NOT be refused'],
  ['2026-07-27T02:00:00Z', carrying('deadbee'), 'REFUSE_HOLD_CARRIES', 'Mon 02:00Z pre-open — a LATER commit that carries it is held too'],
  ['2026-07-27T13:20:00Z', carrying(HELD), 'REFUSE_HOLD_CARRIES', 'Mon 13:20Z — the slot the embargo deliberately leaves open'],
  ['2026-07-27T13:20:00Z', clean('408f06a'), 'PROCEED', 'Mon 13:20Z — same slot, clean commit: the pre-open window still works'],

  // Fails CLOSED. An unresolvable tip is not evidence of a clean tip.
  ['2026-07-26T04:45:00Z', unresolved, 'REFUSE_HOLD_BLIND', 'tip unresolvable (ls-remote down) — must refuse, not assume clean'],
  ['2026-07-26T04:45:00Z', untestable('c0ffee'), 'REFUSE_HOLD_BLIND', 'object missing from checkout — "cannot tell" is not "no"'],

  // SELF-EXPIRY. Without these the suite would pass a permanently-jammed gate.
  ['2026-07-27T21:00:00Z', carrying(HELD), 'PROCEED', 'Mon 21:00:00Z sharp — hold spent, the held commit ships (half-open)'],
  ['2026-07-27T21:00:00Z', unresolved, 'PROCEED', 'Mon 21:00:00Z — no active hold, so BLIND cannot fire either'],
  ['2026-07-28T09:00:00Z', carrying(HELD), 'PROCEED', 'Tue — expired row is inert, left in place as a record'],
];

// ── The ancestry grader underneath the hold (TRA-3699) ───────────────────────
// Every HOLD_CASE above INJECTS `carries`, so none of them reaches the real predicate.
// That is what let the shallow-graft hole live under a green suite: `gitCarries` collapsed
// a grafted `rc=1` into a confident `false`, the hold read CLEAR, and the deploy PROCEEDED.
//
// These drive the pure grader directly, in BOTH directions — a table that only ever
// produced "blind" would jam the gate shut and pass just as vacuously as the bug did.
const CARRY_CASES = [
  // [name, input, expected verdict, expected true/false/null]
  ['a true carry, full clone', { rc: 0, isShallow: false, mergeBaseEmpty: false }, 'carries', true],
  // rc 0 is PROVEN by objects that are present. A graft hides history, it cannot invent it,
  // so this must stay trustworthy — re-grading it would break every shallow CI deploy.
  ['a true carry, SHALLOW clone', { rc: 0, isShallow: true, mergeBaseEmpty: false }, 'carries', true],
  ['a genuine non-carry, full clone', { rc: 1, isShallow: false, mergeBaseEmpty: false }, 'not-carried', false],
  // THE TRA-3699 BUG. Before the fix this row returned `false` and the hold was lifted.
  ['THE BUG: negative + SHALLOW', { rc: 1, isShallow: true, mergeBaseEmpty: true }, 'blind-shallow', null],
  ['negative + shallow, merge-base present', { rc: 1, isShallow: true, mergeBaseEmpty: false }, 'blind-shallow', null],
  ['re-rooted history on a full clone', { rc: 1, isShallow: false, mergeBaseEmpty: true }, 'blind-unrelated', null],
  ['git could not decide (128)', { rc: 128, isShallow: false, mergeBaseEmpty: false }, 'blind-undecidable', null],
  ['git could not spawn (null rc)', { rc: null, isShallow: false, mergeBaseEmpty: false }, 'blind-undecidable', null],
];

// ── Gate 0's env-write warning (TRA-2306) ────────────────────────────────────
// The AUTH_SECRET gate (exit 7) fires BEFORE both gates above and its printed FIX is an env
// write, which redeploys from BRANCH TIP unguarded (TRA-2186). So the hold and the embargo
// have to be REPORTED inside that refusal or they are never seen. These cases pin that the
// warning is present exactly when there is something to warn about — a warner that is always
// on is noise a deployer learns to skip, and one that is always off is the original defect.
const warnVerdict = (now, target, isSoakHost = true) =>
  envWriteHoldWarning({
    holdCheck: commitHoldState(at(now), target),
    embargo: embargoState(at(now)).active,
    isSoakHost,
  }) === ''
    ? 'SILENT'
    : 'WARNED';

const WARN_CASES = [
  // The Monday this ticket protects: exit 7 here, and the FIX would ship the held commit
  // into the session whose 20:20Z read the hold exists to keep measurable.
  ['2026-07-27T14:00:00Z', carrying(HELD), true, 'WARNED', 'Mon mid-RTH — embargo AND held tip: both must be named'],
  ['2026-07-27T14:00:00Z', clean('408f06a'), true, 'WARNED', 'Mon mid-RTH, clean tip — the embargo alone still forbids the write'],
  ['2026-07-26T04:45:00Z', carrying(HELD), true, 'WARNED', 'Sun 04:45Z — the ~33h hole: no embargo, but the tip IS the held commit'],

  // Fails CLOSED, like the gate it speaks for: "cannot tell" is not "safe to write".
  ['2026-07-26T04:45:00Z', unresolved, true, 'WARNED', 'tip unresolvable — BLIND must warn, not stay silent'],
  ['2026-07-26T04:45:00Z', untestable('c0ffee'), true, 'WARNED', 'object missing from checkout — still BLIND, still warns'],

  // The paired negatives. Without these the suite would pass a warning that is simply
  // always printed, which tells a deployer nothing.
  ['2026-07-26T04:45:00Z', clean('88a072e'), true, 'SILENT', 'SAME instant, clean tip, no embargo — nothing to warn about'],
  ['2026-07-27T21:00:00Z', carrying(HELD), true, 'SILENT', 'Mon 21:00:00Z — hold and embargo both spent: self-expires with the tables'],
  ['2026-07-27T14:00:00Z', carrying(HELD), false, 'SILENT', 'not the soak host — the hold/embargo are bqb1-scoped'],
];

// ── Gate 4: the stale-pin ROLLBACK guard (TRA-3625) ──────────────────────────
// Driven off a fake linear history so the suite needs no git and no network. The chain is
// the real one from the night the bug was found:
//   4cac8b70 (serving) → 8713331 (TRA-3547) → 070a188 (TRA-3589) → 229af6d (tip, TRA-3619)
// `hotfix` is deliberately OFF the chain, so neither contains the other.
// Full 40-char shas, matched by PREFIX — because the bug this suite has to be able to see
// is a short/long mismatch. `resolveTarget` passes --commit through verbatim, so the real
// gate routinely compares a 7-char pin against a 40-char tip; a fake harness that only ever
// holds 7-char shas on both sides cannot reach that branch at all.
const CHAIN = [
  '4cac8b70ee3c206306bd17d6a836ff60374895fc',
  '8713331d0a49b1a37b9e8f0c4a6d2e5b1f3c7a90',
  '070a188c5e2b9d4f6a1c8e3b7d0f2a5c9e4b6d81',
  '229af6d6e985609c2b2204b4202c7d3b20a9419c',
];
const idxOf = s => CHAIN.findIndex(full => full.startsWith(s));
const chainAncestry = (a, b) => {
  if (a === 'nosuch' || b === 'nosuch') return null; // object missing from this checkout
  const ia = idxOf(a);
  const ib = idxOf(b);
  if (ia === -1 || ib === -1) return idxOf(a) === idxOf(b) && a === b; // off-chain: related only to itself
  return ia <= ib; // reflexive, like `merge-base --is-ancestor`
};
const FULL = { A: CHAIN[0], B: CHAIN[1], C: CHAIN[2], D: CHAIN[3] };

const pin = sha => ({ sha, source: '--commit' });
const tip = sha => ({ sha, source: 'origin/main tip (no --commit given)' });
const at_ = sha => ({ sha });
const unreadable = { sha: null, error: '/api/health/version timed out' };

// The decision main() makes: anything rollbackBlocks() refuses, everything else proceeds.
const rbVerdict = (target, live) => {
  const v = rollbackState(target, live, chainAncestry).verdict;
  return rollbackBlocks(v) ? `REFUSE_${v}` : v;
};

const ROLLBACK_CASES = [
  // The bug, exactly as measured. A carrier pinned to 8713331 executed after 070a188 shipped.
  [pin('8713331'), at_('070a188'), 'REFUSE_ROLLBACK', 'TRA-3547 pin executed after TRA-3589 shipped — reverts the equity-source-era marker'],
  [pin('4cac8b70'), at_('229af6d'), 'REFUSE_ROLLBACK', 'the oldest pin against the tip — three commits removed at once'],

  // The paired PROCEEDs. Each differs from a REFUSE above by exactly one variable; without
  // them a gate jammed shut would pass this suite and no deploy would ever leave again.
  [pin('229af6d'), at_('070a188'), 'FORWARD', 'SAME shape, pin is NEWER than live — the ordinary pinned deploy must still ship'],
  [tip('229af6d'), at_('4cac8b70'), 'FORWARD', 'no --commit, tip ahead of live — the default path is untouched'],
  [pin('070a188'), at_('070a188'), 'NOOP', 'pin IS the serving build — a reboot, not a rollback, and must not be refused'],
  [pin('8713331'), at_('4cac8b70'), 'FORWARD', 'an OLD pin that is still ahead of live: under-ships, but removes nothing'],

  // Divergence removes serving code too, and it is the one case the default (tip) path can
  // hit on its own — live ahead of main is a hotfix nobody landed.
  [tip('229af6d'), at_('hotfix'), 'REFUSE_DIVERGED', 'live is a hotfix that never landed — deploying the tip drops it'],

  // FAILS CLOSED. "I could not check" is never "it is not a rollback".
  [pin('8713331'), unreadable, 'REFUSE_BLIND', 'health route down — must refuse, not assume forward'],
  [pin('nosuch'), at_('070a188'), 'REFUSE_BLIND', 'target object missing from this checkout — cannot tell is not no'],
  [pin('8713331'), at_('nosuch'), 'REFUSE_BLIND', 'live sha unknown to this checkout — same, from the other side'],
  [{ sha: null, source: '--commit', error: 'ls-remote failed' }, at_('070a188'), 'REFUSE_BLIND', 'target unresolvable'],
];

// The non-blocking half. A note that is always printed is noise; one that never prints is
// the original defect. Pin-behind-tip NOTES, everything else stays QUIET.
const noteVerdict = (target, tipSha) => (stalePinNote(target, tipSha, chainAncestry) === '' ? 'QUIET' : 'NOTED');

const NOTE_CASES = [
  [pin('8713331'), FULL.D, 'NOTED', 'pinned behind the tip — the under-ship worth naming'],
  // ⚠ THE REGRESSION CASE. A 7-char pin of the tip against the 40-char tip: the shas are
  // EQUAL but the strings are not, and ancestry is reflexive, so a `===` equality guard
  // reports the tip as a stale pin. Caught on the live arm 2026-08-13, not by the fakes.
  [pin('229af6d'), FULL.D, 'QUIET', 'SHORT pin of the tip vs the FULL tip — equal, so nothing to say'],
  [pin(FULL.D), FULL.D, 'QUIET', 'full-length pin AT the tip — nothing to say'],
  [tip('229af6d'), FULL.D, 'QUIET', 'no --commit at all — this note is about pins only'],
  [pin('hotfix'), FULL.D, 'QUIET', 'off-chain pin — not behind the tip, so not this note subject'],
  [pin('nosuch'), FULL.D, 'QUIET', 'unanswerable ancestry must not manufacture a note'],
];

let pass = 0;
const failures = [];
for (const [iso, target, isSoak, expected, why] of WARN_CASES) {
  const got = warnVerdict(iso, target, isSoak);
  if (got === expected) {
    pass += 1;
    console.log(`  ok   ${iso}  ${got.padEnd(20)} ${why}`);
  } else {
    failures.push({ iso, expected, got, why });
    console.log(`  FAIL ${iso}  expected ${expected}, got ${got}  — ${why}`);
  }
}

const warnProduced = new Set(WARN_CASES.map(([iso, target, isSoak]) => warnVerdict(iso, target, isSoak)));
const warnMissing = ['WARNED', 'SILENT'].filter(v => !warnProduced.has(v));

for (const [iso, target, expected, why] of HOLD_CASES) {
  const got = holdVerdict(iso, target);
  if (got === expected) {
    pass += 1;
    console.log(`  ok   ${iso}  ${got.padEnd(20)} ${why}`);
  } else {
    failures.push({ iso, expected, got, why });
    console.log(`  FAIL ${iso}  expected ${expected}, got ${got}  — ${why}`);
  }
}

const holdProduced = new Set(HOLD_CASES.map(([iso, target]) => holdVerdict(iso, target)));
const holdMissing = ['PROCEED', 'REFUSE_HOLD_CARRIES', 'REFUSE_HOLD_BLIND'].filter(v => !holdProduced.has(v));

for (const [name, input, expectedVerdict, expectedAnswer] of CARRY_CASES) {
  const got = gradeCarries(input);
  const answer = carriesFromVerdict(got);
  const ok = got === expectedVerdict && answer === expectedAnswer;
  if (ok) {
    pass += 1;
    console.log(`  ok   ancestry  ${got.padEnd(17)} ${name}`);
  } else {
    failures.push({ iso: 'ancestry', expected: `${expectedVerdict}/${expectedAnswer}`, got: `${got}/${answer}`, why: name });
    console.log(`  FAIL ancestry  expected ${expectedVerdict}/${expectedAnswer}, got ${got}/${answer}  — ${name}`);
  }
}

// COMPOSITION, not assumption. The grader returning `null` is only half the fix: the null
// has to reach the gate's cannot-tell branch AND that branch has to REFUSE. Feed the real
// grader's blind-shallow output through the real hold gate and assert the deploy is refused.
const shallowAnswer = carriesFromVerdict(gradeCarries({ rc: 1, isShallow: true, mergeBaseEmpty: true }));
const composed = holdVerdict('2026-07-26T04:45:00Z', { sha: 'c0ffee', source: 'test', carries: () => shallowAnswer });
if (composed === 'REFUSE_HOLD_BLIND') {
  pass += 1;
  console.log(`  ok   ancestry  ${composed.padEnd(17)} grafted-shallow negative routes to the hold gate's REFUSE branch`);
} else {
  failures.push({ iso: 'ancestry', expected: 'REFUSE_HOLD_BLIND', got: composed, why: 'blind-shallow must REFUSE end to end' });
  console.log(`  FAIL ancestry  expected REFUSE_HOLD_BLIND, got ${composed}  — a null that also fails open fixes nothing`);
}

const carryProduced = new Set(CARRY_CASES.map(([, i]) => gradeCarries(i)));
const carryMissing = ['carries', 'not-carried', 'blind-shallow', 'blind-unrelated', 'blind-undecidable'].filter(
  v => !carryProduced.has(v),
);

for (const [iso, expected, why] of CASES) {
  const got = verdict(at(iso));
  if (got === expected) {
    pass += 1;
    console.log(`  ok   ${iso}  ${got.padEnd(15)} ${why}`);
  } else {
    failures.push({ iso, expected, got, why });
    console.log(`  FAIL ${iso}  expected ${expected}, got ${got}  — ${why}`);
  }
}

// Reachability: a suite in which one verdict never appears has not exercised that branch,
// and its greens would mean nothing (a jammed-open or jammed-shut gate passes a one-sided
// suite). Assert all three verdicts are actually produced.
const produced = new Set(CASES.map(([iso]) => verdict(at(iso))));
const missing = ['PROCEED', 'REFUSE_FREEZE', 'REFUSE_EMBARGO'].filter(v => !produced.has(v));

// ── LIVE arm (--live) ────────────────────────────────────────────────────────
// The cases above inject `carries`, so they prove the PREDICATE discriminates — they do
// not prove the real resolver reaches git, nor that the guard refuses TODAY'S actual tip.
// A suite of fakes passing while the live path is broken is exactly the reads-identically
// failure this repo keeps hitting. Opt-in because it needs the network.
//   node scripts/tra2325-embargo-gate-check.mjs --live
if (process.argv.includes('--live')) {
  console.log('');
  console.log('live    : resolving the real origin/main tip and re-running the gate against it');
  const liveTarget = resolveTarget('main', undefined);
  const live = commitHoldState(new Date(), liveTarget);
  console.log(`  tip     : ${liveTarget.sha ?? '(unresolved)'}  [${liveTarget.source}]`);
  if (liveTarget.error) console.log(`  error   : ${liveTarget.error}`);
  console.log(`  verdict : ${live.verdict}${live.hold ? ` (${live.hold.ticket})` : ''}`);
  const active = COMMIT_HOLDS.filter(h => Date.now() < Date.parse(h.until));
  if (active.length && live.verdict === 'CLEAR') {
    console.log('  note    : a hold is active and the current tip does NOT carry it — deploying tip is allowed.');
  }
  // Negative control: the SAME live resolver against a commit that predates every hold must
  // come back CLEAR. Without it, a resolver jammed at "CARRIES" would look like a working guard.
  const control = commitHoldState(new Date(), resolveTarget('main', '408f06a5ef819564c7b144673cda0c59024675af'));
  console.log(`  control : 408f06a5 (predates every hold) -> ${control.verdict}  ${control.verdict === 'CLEAR' ? 'ok' : 'FAIL — guard is jammed shut'}`);
  if (control.verdict !== 'CLEAR') {
    console.error('[tra2325] FAIL: the live resolver refuses a commit that carries no hold — jammed shut.');
    process.exit(1);
  }

  // ── Rollback gate, live arm (TRA-3625) ────────────────────────────────────
  // Not optional colour. The fake chain above ran 68/68 green while stalePinNote reported
  // the TIP as a stale pin, because every fake sha was 7 chars on BOTH sides and the real
  // resolver passes --commit through verbatim against a 40-char tip. This arm is what
  // found it. If the fakes and this disagree again, believe this one.
  const liveUrl = process.env.ROLLBACK_LIVE_URL ?? 'https://tradingai-bqb1.onrender.com/api/health/version';
  let liveSha = null;
  try {
    const r = await fetch(liveUrl, { signal: AbortSignal.timeout(25_000) });
    const b = r.ok ? await r.json() : null;
    if (typeof b?.commit === 'string' && /^[0-9a-f]{7,40}$/i.test(b.commit)) {
      const rev = spawnSync('git', ['rev-parse', `${b.commit}^{commit}`], { encoding: 'utf8' });
      if (rev.status === 0) liveSha = rev.stdout.trim();
    }
  } catch {
    /* leave null — reported as BLIND below, which is the correct reading */
  }
  const liveTip = liveTarget.sha;
  console.log('');
  console.log(`rollback: live ${liveSha ? liveSha.slice(0, 12) : '(unreadable)'} · tip ${liveTip?.slice(0, 12) ?? '(unresolved)'}`);
  const liveOperand = liveSha ? { sha: liveSha } : { sha: null, error: 'health route unreachable' };

  // The tip must ALWAYS be deployable — if this ever refuses, the gate is jammed shut and
  // nobody can ship. This is the negative control, and it is the one that matters.
  const tipRb = rollbackState(resolveTarget('main', undefined), liveOperand);
  console.log(`  tip     : ${tipRb.verdict}  ${rollbackBlocks(tipRb.verdict) ? 'REFUSE' : 'proceed'}`);
  if (liveSha && rollbackBlocks(tipRb.verdict)) {
    console.error(`[tra2325] FAIL: deploying the TIP is refused (${tipRb.verdict}) — the rollback gate is jammed shut.`);
    process.exit(1);
  }
  // And pinning the tip must be identical to taking it, AND must not print a stale-pin note.
  const pinnedTip = resolveTarget('main', liveTip);
  const pinNote = stalePinNote(pinnedTip, liveTip);
  console.log(`  tip pin : ${rollbackState(pinnedTip, liveOperand).verdict}  stale-pin note ${pinNote ? 'PRINTED' : 'quiet'}`);
  if (pinNote) {
    console.error('[tra2325] FAIL: --commit=<the tip> printed a STALE PIN note. Pinning the tip is not stale.');
    process.exit(1);
  }
}

for (const [target, live, expected, why] of ROLLBACK_CASES) {
  const got = rbVerdict(target, live);
  if (got === expected) {
    pass += 1;
    console.log(`  ok   rollback  ${got.padEnd(17)} ${why}`);
  } else {
    failures.push({ iso: 'rollback', expected, got, why });
    console.log(`  FAIL rollback  expected ${expected}, got ${got}  — ${why}`);
  }
}

for (const [target, tipSha, expected, why] of NOTE_CASES) {
  const got = noteVerdict(target, tipSha);
  if (got === expected) {
    pass += 1;
    console.log(`  ok   stalepin  ${got.padEnd(17)} ${why}`);
  } else {
    failures.push({ iso: 'stalepin', expected, got, why });
    console.log(`  FAIL stalepin  expected ${expected}, got ${got}  — ${why}`);
  }
}

const rbProduced = new Set(ROLLBACK_CASES.map(([t, l]) => rbVerdict(t, l)));
const rbMissing = ['FORWARD', 'NOOP', 'REFUSE_ROLLBACK', 'REFUSE_DIVERGED', 'REFUSE_BLIND'].filter(
  v => !rbProduced.has(v),
);
const noteProduced = new Set(NOTE_CASES.map(([t, s]) => noteVerdict(t, s)));
const noteMissing = ['NOTED', 'QUIET'].filter(v => !noteProduced.has(v));

const TOTAL =
  CASES.length + HOLD_CASES.length + WARN_CASES.length + ROLLBACK_CASES.length + NOTE_CASES.length + CARRY_CASES.length + 1;
const allMissing = [...missing, ...holdMissing, ...warnMissing, ...rbMissing, ...noteMissing, ...carryMissing];

console.log('');
console.log(`freeze  : ${FREEZE_OPEN_MIN}–${FREEZE_CLOSE_MIN} UTC min-of-day (lead ${DEPLOY_LEAD_MIN} min)`);
console.log(`embargos: ${EMBARGOES.length} row(s) — ${EMBARGOES.map(e => `${e.from}→${e.to}`).join(', ')}`);
console.log(
  `holds   : ${COMMIT_HOLDS.length} row(s) — ${COMMIT_HOLDS.map(h => `${h.commit.slice(0, 7)}→${h.until} (${h.ticket})`).join(', ')}`,
);
console.log(`cases   : ${pass}/${TOTAL} pass`);
console.log(
  `verdicts: reached ${[...new Set([...produced, ...holdProduced, ...warnProduced, ...rbProduced, ...noteProduced, ...carryProduced])].sort().join(', ')}`,
);
console.log(`checkout: ${isShallowCheckout() ? 'SHALLOW — a negative ancestry answer is BLIND here (TRA-3699)' : 'complete'}`);

if (allMissing.length) {
  console.error(`[tra2325] FAIL: verdict(s) never reached by any case: ${allMissing.join(', ')} — suite is one-sided.`);
  process.exit(1);
}
if (failures.length) {
  console.error(`[tra2325] FAIL: ${failures.length} case(s) failed.`);
  process.exit(1);
}
console.log('[tra2325] PASS — freeze, embargo, commit-hold, rollback and stale-pin all discriminate,');
console.log('[tra2325] and every verdict is reachable.');
process.exit(0);
