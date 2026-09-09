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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  readDeployHolds,
  deployHoldState,
  deployHoldBlocks,
  deployHoldCoversService,
  deployHoldOverrideTokens,
  deployHoldOverrideNames,
  deployHoldStaleness,
  renderDeployHoldStaleness,
  renderDeployHoldRefusal,
  deployHoldBaseline,
  deployHoldPinDrift,
  deployHoldPinDriftIsLoud,
  renderDeployHoldPinDrift,
  extractShaPrefix,
  gitEnumerationProbe,
  requestedServiceRef,
  DEPLOY_HOLD_FILE,
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

// ── Gate −1: the repo-resident deploy hold (TRA-4261) ────────────────────────
// Same discipline as every section above: each REFUSE case is paired with a PROCEED case
// differing by ONE variable, and the run fails if any verdict is unreachable.
//
// ⚠ THE TRA-3699 LESSON IS APPLIED HERE DELIBERATELY. That defect shipped because every
// commit-hold case INJECTED its input, so the suite never once reached the real predicate.
// So this section drives `readDeployHolds` against the REAL FILE ON DISK as well (the
// LIVE arm at the bottom) — an injected `holds` array grades the scoping and validation
// logic, and only a real read grades the reader.
const HELD_ROW = {
  ticket: 'TRA-0000',
  reason: 'fixture',
  openedAt: '2026-09-01T00:00:00Z',
  openedBy: 'fixture',
  emits: ['fixture'],
  service: { ids: ['srv-money'], names: ['MoneyHost', 'money-host'] },
};
const UNSCOPED_ROW = { ...HELD_ROW, ticket: 'TRA-0001', service: undefined };
const NO_TICKET_ROW = { ...HELD_ROW, ticket: 'the friday hold', service: undefined };
const read = (verdict, holds, why = null) => ({ verdict, holds, why, path: DEPLOY_HOLD_FILE });

const dhVerdict = (r, ref) => {
  const st = deployHoldState(r, ref);
  return deployHoldBlocks(st.verdict) ? `REFUSE_${st.verdict}` : st.verdict;
};

const REF_MONEY_ID = { kind: 'id', value: 'srv-money' };
const REF_MONEY_NAME = { kind: 'name', value: 'money-host' };
const REF_OTHER_ID = { kind: 'id', value: 'srv-elsewhere' };
const REF_OTHER_NAME = { kind: 'name', value: 'elsewhere' };

const DEPLOY_HOLD_CASES = [
  // The absent file — the state the repo was in before TRA-4261, and AC2's subject.
  [read('CLEAR', []), REF_MONEY_ID, 'CLEAR', 'no hold file at all — must be indistinguishable from before this gate existed'],
  [read('HOLDS', []), REF_MONEY_ID, 'CLEAR', 'file present with an EMPTY holds[] — the cleared state, still silent'],
  // The refusals.
  [read('HOLDS', [HELD_ROW]), REF_MONEY_ID, 'REFUSE_HELD', 'hold scoped BY ID to the host being deployed'],
  [read('HOLDS', [HELD_ROW]), REF_MONEY_NAME, 'REFUSE_HELD', 'same hold reached by NAME/slug — TRA-3743: the money host answers to three strings'],
  [read('HOLDS', [UNSCOPED_ROW]), REF_OTHER_ID, 'REFUSE_HELD', 'a hold with NO service block covers EVERY service — under-specified must hold too MUCH, not too little'],
  [read('BLIND', [], 'not valid JSON'), REF_OTHER_ID, 'REFUSE_BLIND', 'an unreadable hold file refuses even for a service no hold names — we cannot know what it said'],
  // ⚠ THE ONE-SIDEDNESS CONTROL. If these went REFUSE the gate would be a brick, and a
  // brick passes every refusal test above.
  [read('HOLDS', [HELD_ROW]), REF_OTHER_ID, 'OUT_OF_SCOPE', 'scoped hold, DIFFERENT service by id — must not refuse'],
  [read('HOLDS', [HELD_ROW]), REF_OTHER_NAME, 'OUT_OF_SCOPE', 'scoped hold, DIFFERENT service by name — must not refuse'],
];

// The override predicate. Separated because it is the half that must NOT be a brick: a
// hold that cannot be broken gets deleted instead of respected.
const OVERRIDE_CASES = [
  [[HELD_ROW], 'TRA-0000 board cleared it', true, 'names the active hold — accepted'],
  [[HELD_ROW], 'tra-0000 board cleared it', true, 'case-insensitive: the operator should not have to shout'],
  [[HELD_ROW], 'just ship it', false, 'a bare reason does NOT break a hold — name the ticket you are breaking'],
  [[HELD_ROW], 'TRA-9999 wrong ticket', false, 'naming SOME ticket is not naming THIS one'],
  [[HELD_ROW, UNSCOPED_ROW], 'TRA-0001 only this one', true, 'two holds, one named — permitted, and the WARNING lists both'],
  [[NO_TICKET_ROW], 'because the box is down', true, 'a hold whose ticket carries no TRA token states no requirement — the gate must not invent a lock it cannot print'],
];

let pass = 0;
const failures = [];
for (const [r, ref, expected, why] of DEPLOY_HOLD_CASES) {
  const got = dhVerdict(r, ref);
  const label = `${ref.kind}=${ref.value}`;
  if (got === expected) {
    pass += 1;
    console.log(`  ok   ${label.padEnd(22)} ${got.padEnd(20)} ${why}`);
  } else {
    failures.push({ iso: `deploy-hold ${label}`, expected, got, why });
    console.log(`  FAIL ${label.padEnd(22)} expected ${expected}, got ${got}  — ${why}`);
  }
}

const dhProduced = new Set(DEPLOY_HOLD_CASES.map(([r, ref]) => dhVerdict(r, ref)));
const dhMissing = ['CLEAR', 'OUT_OF_SCOPE', 'REFUSE_HELD', 'REFUSE_BLIND'].filter(v => !dhProduced.has(v));

for (const [holds, reason, expected, why] of OVERRIDE_CASES) {
  const got = deployHoldOverrideNames(reason, deployHoldOverrideTokens(holds));
  if (got === expected) {
    pass += 1;
    console.log(`  ok   override            ${String(got).padEnd(20)} ${why}`);
  } else {
    failures.push({ iso: 'deploy-hold override', expected, got, why });
    console.log(`  FAIL override            expected ${expected}, got ${got}  — ${why}`);
  }
}

const ovProduced = new Set(OVERRIDE_CASES.map(([h, r]) => deployHoldOverrideNames(r, deployHoldOverrideTokens(h))));
const ovMissing = [true, false].filter(v => !ovProduced.has(v)).map(v => `override:${v}`);

// ── LIVE arm: the real file, the real reader, the real service ref ───────────
// Injected rows cannot grade the READER, and the reader is where a fail-open would hide
// (TRA-3699). This runs the shipped path against whatever is actually committed. It
// asserts a PROPERTY, never a specific hold — the suite must stay green after the
// TRA-4217 hold is cleared, or it becomes a reason not to clear it.
{
  const liveRead = readDeployHolds();
  const liveOk =
    ['CLEAR', 'HOLDS', 'BLIND'].includes(liveRead.verdict) &&
    Array.isArray(liveRead.holds) &&
    liveRead.verdict !== 'BLIND';
  if (liveOk) {
    pass += 1;
    console.log(
      `  ok   live-read            ${liveRead.verdict.padEnd(20)} ${DEPLOY_HOLD_FILE} parses and validates (${liveRead.holds.length} hold(s))`,
    );
  } else {
    failures.push({
      iso: 'deploy-hold live-read',
      expected: 'CLEAR|HOLDS',
      got: liveRead.verdict,
      why: liveRead.why ?? 'the committed hold file must be readable by its own reader',
    });
    console.log(`  FAIL live-read            got ${liveRead.verdict} — ${liveRead.why ?? 'unreadable'}`);
  }
  // And the ref this checkout would actually be scoped against, printed so a reader can
  // see WHICH host the live holds are being graded for.
  const ref = requestedServiceRef();
  console.log(`  note live-ref             ${ref.kind}=${ref.value} → ${deployHoldState(liveRead, ref).verdict}`);
  // Every committed hold must state a scope the coverage predicate can actually evaluate.
  for (const h of liveRead.holds) {
    const covers = deployHoldCoversService(h, ref);
    console.log(`  note live-hold            ${h.ticket} covers ${ref.kind}=${ref.value}: ${covers}`);
  }
}

// ── Gate −1b: is the hold's enumeration STILL CURRENT? (TRA-4262) ────────────
// `emits` is a snapshot of a MOVING TIP — this script ships the tip, never a pin, so the
// list goes stale the next time anybody pushes. Same discipline as every section above:
// each LOUD status is paired with the CURRENT case it differs from by one variable, and
// the run fails if any status is unreachable.
const HEAD_A = 'aaaaaaaaaaaa1111111111111111111111111111';
const HEAD_B = 'bbbbbbbbbbbb2222222222222222222222222222';
const stampedRow = tip => ({ ...HELD_ROW, enumeratedTip: tip, enumeratedAt: '2026-09-01T15:15:00Z' });

// Injected probe. `delta` is a canned answer, so these cases grade the PREDICATE.
const fakeProbe = (head, delta) => ({
  head: () => head,
  delta: () => delta,
});
const okDelta = (commits, paths, shallow = false) => ({ ok: true, shallow, commits, paths });
const C1 = [{ sha: 'c0ffee1', subject: 'feat(TRA-4255): publish admissibility' }];
const C2 = [...C1, { sha: 'dec0de2', subject: 'feat(TRA-4154): roll byEtDay' }];

const STALENESS_CASES = [
  [
    stampedRow(HEAD_A),
    fakeProbe({ sha: HEAD_A, source: 'local origin/main' }, okDelta([], [])),
    'CURRENT',
    'the enumeration was taken against exactly what would ship — the ONE silent status',
  ],
  [
    { ...stampedRow(HEAD_A), enumeratedTip: HEAD_A.slice(0, 12) },
    fakeProbe({ sha: HEAD_A, source: 'local origin/main' }, okDelta(C1, ['packages/server/src/x.ts'])),
    'CURRENT',
    'an ABBREVIATED stamp against the same commit is CURRENT — a stamp that only matched at 40 chars would read stale against its own tip',
  ],
  [
    stampedRow(HEAD_A),
    fakeProbe({ sha: HEAD_B, source: 'local origin/main' }, okDelta(C2, ['packages/server/src/rv-scan-telemetry.ts', 'ops/deploy-hold.json'])),
    'STALE',
    'two commits landed since the enumeration — the defect TRA-4262 filed',
  ],
  [
    { ...HELD_ROW, enumeratedTip: undefined },
    fakeProbe({ sha: HEAD_B, source: 'local origin/main' }, okDelta(C2, [])),
    'UNSTAMPED',
    'a hold with no stamp: staleness is undetectable by inspection, which is the pre-TRA-4262 state of the file',
  ],
  [
    stampedRow(HEAD_A),
    fakeProbe({ sha: HEAD_B, source: 'local origin/main' }, okDelta([], ['packages/server/src/x.ts'])),
    'DIVERGED',
    'shas differ but nothing is in tip..head — the stamp is not an ancestor of what would ship, so CURRENT cannot be claimed',
  ],
  [
    stampedRow(HEAD_A),
    fakeProbe({ sha: HEAD_B, source: 'local origin/main' }, { ok: false, shallow: false, error: 'git log failed (status 128)' }),
    'BLIND',
    'git could not answer — "cannot tell" must NEVER collapse into CURRENT',
  ],
  [
    stampedRow(HEAD_A),
    fakeProbe({ sha: HEAD_B, source: 'local origin/main' }, okDelta([], [], true)),
    'BLIND',
    'an EMPTY tip..head in a SHALLOW checkout is a graft, not currency (TRA-3699) — the same input reads DIVERGED when the history is complete',
  ],
  [
    stampedRow(HEAD_A),
    fakeProbe({ sha: null, error: 'could not resolve origin/main' }, okDelta(C2, [])),
    'BLIND',
    'the sha that would ship is unresolvable — no comparison exists to make',
  ],
];

for (const [hold, probe, expected, why] of STALENESS_CASES) {
  const got = deployHoldStaleness(hold, probe).status;
  if (got === expected) {
    pass += 1;
    console.log(`  ok   staleness            ${got.padEnd(20)} ${why}`);
  } else {
    failures.push({ iso: 'deploy-hold staleness', expected, got, why });
    console.log(`  FAIL staleness            expected ${expected}, got ${got}  — ${why}`);
  }
}

const stProduced = new Set(STALENESS_CASES.map(([h, p]) => deployHoldStaleness(h, p).status));
const stMissing = ['CURRENT', 'STALE', 'UNSTAMPED', 'DIVERGED', 'BLIND'].filter(v => !stProduced.has(v));

// The one-sidedness control on the RENDERER: only CURRENT is silent, and every loud status
// must actually reach the refusal text. A staleness grader nobody can read is not a gate.
{
  const silent = renderDeployHoldStaleness(deployHoldStaleness(STALENESS_CASES[0][0], STALENESS_CASES[0][1]));
  if (silent.length === 0) {
    pass += 1;
    console.log(`  ok   staleness-render     ${'CURRENT'.padEnd(20)} a current enumeration prints NOTHING — a line on every read is a line nobody reads`);
  } else {
    failures.push({ iso: 'staleness-render CURRENT', expected: '0 lines', got: `${silent.length} lines`, why: 'CURRENT must be silent' });
    console.log(`  FAIL staleness-render     CURRENT printed ${silent.length} line(s)`);
  }
}

// ── LIVE arm: REAL ancestry out of THIS repo, through the REAL refusal renderer ──
// AC4 of TRA-4262: the staleness must be proven against a hold whose enumeratedTip is an
// actual ancestor of HEAD, not a hand-written fixture sha — an injected probe grades the
// predicate and can never grade `gitEnumerationProbe`. This drives the shipped probe
// against the shipped renderer and asserts the REFUSAL NAMES the drift.
let staleLiveArms = 0;
{
  const headSha = (spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim();
  const ancestor = (spawnSync('git', ['rev-parse', 'HEAD~1'], { encoding: 'utf8' }).stdout ?? '').trim();
  if (!headSha || !ancestor) {
    // A shallow or graftless checkout cannot supply an ancestor. That is not a failure of
    // the gate — but it must not read as a pass either, so it prints and is not counted.
    console.log(`  note staleness-live       SKIPPED — this checkout cannot resolve HEAD~1 (shallow?), so no real ancestry is available`);
    stProduced.add('STALE'); // covered by the injected arm above; do not fail reachability on a shallow CI box
  } else {
    staleLiveArms = 2;
    const liveHold = { ...HELD_ROW, ticket: 'TRA-4262', enumeratedTip: ancestor, enumeratedAt: '2026-09-01T15:15:00Z' };
    const st = deployHoldStaleness(liveHold, gitEnumerationProbe(headSha));
    const text = renderDeployHoldRefusal(
      { verdict: 'HELD', applicable: [liveHold], skipped: [], why: null, ref: REF_MONEY_ID },
      { staleness: new Map([[liveHold, st]]) },
    );
    const namesIt =
      st.status === 'STALE' &&
      st.commits.length >= 1 &&
      text.includes('ENUMERATION IS STALE') &&
      text.includes(ancestor.slice(0, 12)) &&
      text.includes(headSha.slice(0, 12)) &&
      text.includes(`${st.commits.length} commit(s) have landed since`) &&
      st.commits.every(c => text.includes(c.sha));
    if (namesIt) {
      pass += 1;
      console.log(
        `  ok   staleness-live       ${'STALE'.padEnd(20)} real ancestry ${ancestor.slice(0, 7)}..${headSha.slice(0, 7)}: ${st.commits.length} commit(s), ${st.serverPaths.length}/${st.paths.length} server-byte path(s), and the refusal names them`,
      );
    } else {
      failures.push({
        iso: 'staleness-live',
        expected: 'STALE, named in the refusal text',
        got: `${st.status}${st.why ? ` (${st.why})` : ''}`,
        why: 'a real ancestor of HEAD must grade STALE and the refusal must print the drift',
      });
      console.log(`  FAIL staleness-live       got ${st.status} — ${st.why ?? 'refusal did not name the drift'}`);
    }
    // The paired PROCEED case, one variable apart: the SAME probe, stamped at HEAD itself.
    const currentHold = { ...liveHold, enumeratedTip: headSha };
    const stCur = deployHoldStaleness(currentHold, gitEnumerationProbe(headSha));
    const curText = renderDeployHoldRefusal(
      { verdict: 'HELD', applicable: [currentHold], skipped: [], why: null, ref: REF_MONEY_ID },
      { staleness: new Map([[currentHold, stCur]]) },
    );
    // Not `!includes('TRA-4262')` — the fixture's own TICKET is TRA-4262 and the refusal
    // prints it. Assert on the staleness HEADLINES, which is what must be absent.
    const STALE_MARKERS = ['ENUMERATION IS STALE', 'CARRIES NO enumeratedTip', 'NOT AN ANCESTOR OF WHAT WOULD SHIP', 'COULD NOT TELL WHETHER'];
    const quiet = stCur.status === 'CURRENT' && !STALE_MARKERS.some(m => curText.includes(m));
    if (quiet) {
      pass += 1;
      console.log(`  ok   staleness-live-ctl   ${'CURRENT'.padEnd(20)} same probe, stamp moved to HEAD — the refusal says NOTHING about staleness`);
    } else {
      failures.push({ iso: 'staleness-live-ctl', expected: 'CURRENT and silent', got: stCur.status, why: 'the grader must not be a brick that shouts on every hold' });
      console.log(`  FAIL staleness-live-ctl   got ${stCur.status} — a stamp AT the tip must be silent`);
    }
  }
}

// ── The REQUIRED-FIELD arm: the two stamps are BOTH required (TRA-4262/TRA-4268) ──
// Driven through the REAL reader against a REAL file, because that is the half an injected
// `holds` array cannot reach — and every REFUSE paired with the file one variable away.
//
// TRA-4268 AC1 asked for the "does it join DEPLOY_HOLD_REQUIRED_FIELDS" call to be
// deliberate. It does, and these are the cases that pin the consequence: a hold with no
// live-pin baseline REFUSES, and — the one an operator will actually hit — a baseline that
// is PRESENT but carries no leading sha refuses too, with a `why` that says which mistake
// it is. A field that may be prose is a field nobody can check.
let requiredFieldArms = 0;
{
  const tmp = mkdtempSync(join(tmpdir(), 'tra4262-hold-'));
  const PIN = 'fedcba9876543210fedcba9876543210fedcba98';
  const row = {
    ticket: 'TRA-4262',
    reason: 'fixture',
    openedAt: '2026-09-01T15:15:00Z',
    openedBy: 'fixture',
    emits: ['fixture'],
  };
  const stamped = { ...row, enumeratedTip: HEAD_A, enumeratedFromLivePin: PIN };
  const cases = [
    [
      { ...row, enumeratedFromLivePin: PIN },
      'BLIND',
      /enumeratedTip/,
      'no enumeratedTip REFUSES — an emits[] with no tip beside it enumerates A deploy, not THIS one (TRA-4262)',
    ],
    [
      { ...row, enumeratedTip: HEAD_A },
      'BLIND',
      /enumeratedFromLivePin/,
      'no enumeratedFromLivePin REFUSES — a list with a head and no START describes a window nobody stated (TRA-4268)',
    ],
    [
      { ...row, enumeratedTip: HEAD_A, enumeratedFromLivePin: 'the sha bqb1 is running, I checked, honest' },
      'BLIND',
      /PRESENT but carries no leading commit sha/,
      'a baseline that is PROSE ONLY refuses, and says so as a DIFFERENT mistake from absent — a field that may be prose cannot be checked',
    ],
    [
      { ...stamped, enumeratedFromLivePin: `${PIN} — bqb1 pid 52, startedAt 2026-09-01T18:04:59.811Z, re-read off /api/health/options-live` },
      'HOLDS',
      null,
      'sha FIRST then provenance reads normally — the prose is load bearing (which boot, off what route) and must not have to be dropped to satisfy the gate',
    ],
    [stamped, 'HOLDS', null, 'both stamps present, bare shas — one variable from every refusal above'],
  ];
  requiredFieldArms = cases.length;
  for (const [h, expected, whyRe, why] of cases) {
    const name = `hold-${expected}-${requiredFieldArms--}.json`;
    writeFileSync(join(tmp, name), JSON.stringify({ holds: [h] }));
    const got = readDeployHolds(tmp, name);
    const ok = got.verdict === expected && (!whyRe || whyRe.test(got.why ?? ''));
    if (ok) {
      pass += 1;
      console.log(`  ok   staleness-required   ${got.verdict.padEnd(20)} ${why}`);
    } else {
      failures.push({ iso: 'staleness-required', expected, got: `${got.verdict} (${got.why ?? '—'})`, why });
      console.log(`  FAIL staleness-required   expected ${expected}, got ${got.verdict} — ${why}`);
    }
  }
  requiredFieldArms = cases.length;
  rmSync(tmp, { recursive: true, force: true });
}

// ── Gate −1c: WHICH WINDOW does emits[] cover? (TRA-4268) ────────────────────
// Gate −1b grades the list's HEAD. This grades its START. The defect: four consecutive
// correct re-takes all measured `<a tip>..origin/main` while a deploy ships
// `<the live pin>..origin/main`, and on the TRA-4217 hold those differed by 22 commits, 13
// of them shipping server bytes. Same discipline as every section above: each LOUD status
// paired with the quiet case it differs from by one variable, and the run fails if any
// status is unreachable.
const PIN_A = '092d087775dc3e4cbb1724427c4bae8df303740f';
const PIN_B = '4e0f4438aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ancProbe = answer => ({ head: () => ({ sha: HEAD_A }), delta: () => ({ ok: true, commits: [], paths: [] }), ancestor: () => answer });
const baseRow = (pin, tip) => ({ ...HELD_ROW, enumeratedFromLivePin: pin, enumeratedTip: tip });

const BASELINE_CASES = [
  [
    baseRow(PIN_A, HEAD_A),
    ancProbe(true),
    'WINDOW',
    'the baseline is an ancestor of the stamped head — the window emits[] claims to cover EXISTS',
  ],
  [
    baseRow(PIN_A, PIN_A.slice(0, 12)),
    ancProbe(null),
    'WINDOW',
    'baseline === head (abbreviated on one side) is a legitimate EMPTY window — the box is already at the head, so the deploy is a restart. Answered without git, so the null probe is never consulted',
  ],
  [
    { ...HELD_ROW, enumeratedTip: HEAD_A },
    ancProbe(true),
    'UNSTAMPED',
    'no enumeratedFromLivePin at all — this is the pre-TRA-4268 state of every hold in the file, and it read as coverage',
  ],
  [
    baseRow('the commit bqb1 is running', HEAD_A),
    ancProbe(true),
    'UNSTAMPED',
    'a baseline that is PROSE with no leading sha is UNSTAMPED, not "probably fine" — the parse fails CLOSED',
  ],
  [
    baseRow(PIN_B, HEAD_A),
    ancProbe(false),
    'NOT_ANCESTOR',
    'the baseline is NOT an ancestor of the head, so `git log base..head` is empty and the stamped window does not exist',
  ],
  [
    baseRow(PIN_B, HEAD_A),
    ancProbe(null),
    'BLIND',
    'ancestry unanswerable (a graft, TRA-3699) — "cannot tell" must NEVER collapse into WINDOW, and it is the SAME input that reads NOT_ANCESTOR when git can answer',
  ],
  [
    { ...HELD_ROW, enumeratedFromLivePin: PIN_A },
    ancProbe(true),
    'BLIND',
    'a baseline with no usable head has nothing to be tested against — the window has one end',
  ],
];

for (const [hold, probe, expected, why] of BASELINE_CASES) {
  const got = deployHoldBaseline(hold, probe).status;
  if (got === expected) {
    pass += 1;
    console.log(`  ok   baseline             ${got.padEnd(20)} ${why}`);
  } else {
    failures.push({ iso: 'deploy-hold baseline', expected, got, why });
    console.log(`  FAIL baseline             expected ${expected}, got ${got}  — ${why}`);
  }
}

const blProduced = new Set(BASELINE_CASES.map(([h, p]) => deployHoldBaseline(h, p).status));
const blMissing = ['WINDOW', 'UNSTAMPED', 'NOT_ANCESTOR', 'BLIND'].filter(v => !blProduced.has(v));

// AC2: the refusal must PRINT THE WINDOW, not only its head. Unlike the staleness renderer
// this one is never silent — the window IS the header of the list under it, and a reader
// who sees only the head cannot tell a complete enumeration from one that is 22 commits
// short. Driven through the REAL refusal renderer, not the line builder, because "it is in
// the array" and "it reaches the operator" are different claims.
{
  const hold = baseRow(PIN_A, HEAD_A);
  const st = deployHoldBaseline(hold, ancProbe(true));
  const text = renderDeployHoldRefusal(
    { verdict: 'HELD', applicable: [hold], skipped: [], why: null, ref: REF_MONEY_ID },
    { baselines: new Map([[hold, st]]) },
  );
  const window = `${PIN_A.slice(0, 12)}..${HEAD_A.slice(0, 12)}`;
  if (text.includes(window) && text.indexOf(window) < text.indexOf('WHAT A DEPLOY WOULD EMIT')) {
    pass += 1;
    console.log(`  ok   baseline-render      ${'WINDOW'.padEnd(20)} the refusal prints ${window} ABOVE emits[] — the list's start point is readable without opening the file`);
  } else {
    failures.push({ iso: 'baseline-render', expected: `${window} above emits[]`, got: text.includes(window) ? 'printed BELOW emits[]' : 'not printed at all', why: 'AC2: the refusal must state the window, not only its head' });
    console.log(`  FAIL baseline-render      the refusal did not print ${window} above emits[]`);
  }
  // …and the loud case actually reaches the operator through the same path.
  const blind = baseRow(PIN_B, HEAD_A);
  const blindText = renderDeployHoldRefusal(
    { verdict: 'HELD', applicable: [blind], skipped: [], why: null, ref: REF_MONEY_ID },
    { baselines: new Map([[blind, deployHoldBaseline(blind, ancProbe(false))]]) },
  );
  if (blindText.includes('THAT WINDOW DOES NOT EXIST')) {
    pass += 1;
    console.log(`  ok   baseline-render      ${'NOT_ANCESTOR'.padEnd(20)} the loud status reaches the refusal text — a grader nobody can read is not a gate`);
  } else {
    failures.push({ iso: 'baseline-render', expected: 'THAT WINDOW DOES NOT EXIST in the refusal', got: 'absent', why: 'every loud baseline status must reach the operator' });
    console.log(`  FAIL baseline-render      NOT_ANCESTOR did not reach the refusal text`);
  }
}

// ── LIVE arm: REAL ancestry out of THIS repo (AC3) ──────────────────────────
// The injected cases above grade the predicate and can never grade `gitEnumerationProbe`'s
// new `ancestor()` leg. This drives the SHIPPED probe against real shas, both ways round:
// HEAD~2..HEAD~1 is a window that exists, and the same two shas SWAPPED is one that does
// not. An ancestry check that answered `true` unconditionally would pass the first and
// fail the second.
let baselineLiveArms = 0;
{
  const older = (spawnSync('git', ['rev-parse', 'HEAD~2'], { encoding: 'utf8' }).stdout ?? '').trim();
  const newer = (spawnSync('git', ['rev-parse', 'HEAD~1'], { encoding: 'utf8' }).stdout ?? '').trim();
  if (!older || !newer) {
    console.log(`  note baseline-live        SKIPPED — this checkout cannot resolve HEAD~2 (shallow?), so no real ancestry is available`);
    blProduced.add('WINDOW');
    blProduced.add('NOT_ANCESTOR');
  } else {
    baselineLiveArms = 2;
    const probe = gitEnumerationProbe();
    const fwd = deployHoldBaseline(baseRow(older, newer), probe);
    if (fwd.status === 'WINDOW') {
      pass += 1;
      console.log(`  ok   baseline-live        ${'WINDOW'.padEnd(20)} real ancestry ${older.slice(0, 7)}..${newer.slice(0, 7)} out of this repo — the window exists`);
    } else {
      failures.push({ iso: 'baseline-live', expected: 'WINDOW', got: `${fwd.status} (${fwd.why ?? '—'})`, why: 'a real ancestor must grade WINDOW through the shipped probe' });
      console.log(`  FAIL baseline-live        got ${fwd.status} — ${fwd.why ?? 'real ancestry misgraded'}`);
    }
    const rev = deployHoldBaseline(baseRow(newer, older), probe);
    if (rev.status === 'NOT_ANCESTOR') {
      pass += 1;
      console.log(`  ok   baseline-live-ctl    ${'NOT_ANCESTOR'.padEnd(20)} the SAME two shas swapped — a stamp taken in the wrong order describes a window that does not exist`);
    } else {
      failures.push({ iso: 'baseline-live-ctl', expected: 'NOT_ANCESTOR', got: `${rev.status} (${rev.why ?? '—'})`, why: 'an ancestry check that cannot say NO is not a check' });
      console.log(`  FAIL baseline-live-ctl    got ${rev.status} — swapping the stamps must be caught`);
    }
  }
}

// ── The NETWORK half: is the stamped baseline STILL what the box runs? (AC4) ─
// Lives at Gate 4, which has already resolved the live pin for the rollback test — NOT at
// gate −1, whose offline-ness is why its refusal precedes any byte on the wire. Read-only:
// it warns, it never refuses. `live` is the shape `fetchLiveCommit()` returns, injected.
const PIN_DRIFT_CASES = [
  [
    baseRow(PIN_A, HEAD_A),
    { sha: PIN_A, reported: PIN_A.slice(0, 12), startedAt: '2026-09-01T18:04:59.811Z' },
    'MATCHES',
    'baseline present and CURRENT — the box is running the sha emits[] was enumerated from, so the list describes this deploy',
  ],
  [
    baseRow(PIN_A, HEAD_A),
    { sha: PIN_B, reported: PIN_B.slice(0, 12), startedAt: '2026-09-01T22:10:00.000Z' },
    'REBOOTED',
    'baseline present but the box has since REBOOTED onto a different sha — emits[] covers a window that is not the one this deploy ships (TRA-4158: this host restarts itself)',
  ],
  [
    { ...HELD_ROW, enumeratedTip: HEAD_A },
    { sha: PIN_A, startedAt: '2026-09-01T18:04:59.811Z' },
    'UNSTAMPED',
    'baseline MISSING — nothing to compare, and the box being readable does not supply it',
  ],
  [
    baseRow(PIN_A, HEAD_A),
    { sha: null, error: 'GET /api/health/version failed: timeout' },
    'BLIND',
    'the live pin is unreadable — "cannot tell" must never collapse into MATCHES',
  ],
];

for (const [hold, live, expected, why] of PIN_DRIFT_CASES) {
  const st = deployHoldPinDrift(hold, live);
  const loudOk = deployHoldPinDriftIsLoud(st.status) === (expected !== 'MATCHES');
  if (st.status === expected && loudOk) {
    pass += 1;
    console.log(`  ok   pin-drift            ${st.status.padEnd(20)} ${why}`);
  } else {
    failures.push({ iso: 'pin-drift', expected, got: `${st.status}${loudOk ? '' : ' (loudness inverted)'}`, why });
    console.log(`  FAIL pin-drift            expected ${expected}, got ${st.status}  — ${why}`);
  }
}

const pdProduced = new Set(PIN_DRIFT_CASES.map(([h, l]) => deployHoldPinDrift(h, l).status));
const pdMissing = ['MATCHES', 'REBOOTED', 'UNSTAMPED', 'BLIND'].filter(v => !pdProduced.has(v));

// The REBOOTED notice must name BOTH shas and the boot it read them from — a warning that
// says "drift" without saying drift from WHAT to WHAT sends the operator back to the file.
{
  const hold = baseRow(PIN_A, HEAD_A);
  const st = deployHoldPinDrift(hold, { sha: PIN_B, reported: PIN_B.slice(0, 12), startedAt: '2026-09-01T22:10:00.000Z' });
  const text = renderDeployHoldPinDrift(hold, st);
  const names =
    text.includes(PIN_A.slice(0, 12)) &&
    text.includes(PIN_B.slice(0, 12)) &&
    text.includes('2026-09-01T22:10:00.000Z') &&
    text.includes('startedAt');
  if (names) {
    pass += 1;
    console.log(`  ok   pin-drift-render     ${'REBOOTED'.padEnd(20)} the notice names the stamped baseline, the live sha and the boot it was read from`);
  } else {
    failures.push({ iso: 'pin-drift-render', expected: 'both shas + startedAt', got: 'incomplete', why: 'a drift warning that does not say drift from WHAT is not readable' });
    console.log(`  FAIL pin-drift-render     the REBOOTED notice did not name both shas and the boot`);
  }
  // Paired quiet control: MATCHES must NOT carry the loud headline.
  const quiet = renderDeployHoldPinDrift(hold, deployHoldPinDrift(hold, { sha: PIN_A, startedAt: 'x' }));
  if (!quiet.includes('NO LONGER WHAT THE BOX IS RUNNING')) {
    pass += 1;
    console.log(`  ok   pin-drift-render     ${'MATCHES'.padEnd(20)} same hold, box on the stamped sha — the notice confirms, it does not shout`);
  } else {
    failures.push({ iso: 'pin-drift-render', expected: 'no drift headline', got: 'shouted on a MATCHES', why: 'a grader that shouts on every read is a brick' });
    console.log(`  FAIL pin-drift-render     MATCHES printed the drift headline`);
  }
}

// The sha parser, one line apart in each direction. It is the single point where a stamp
// stops being prose and becomes checkable, so a silent widening here would re-open the
// whole hole under a green suite.
const SHA_PARSE_CASES = [
  [PIN_A, PIN_A, 'a bare 40-char sha'],
  [`${PIN_A} — bqb1 pid 52, startedAt …`, PIN_A, 'sha FIRST, provenance after — the shape the live file uses'],
  ['`092d0877` off /api/health/options-live', '092d0877', 'a backticked short sha, as pasted from a ticket'],
  ['the commit bqb1 is running is 092d0877', null, 'sha NOT first is NOT accepted — a field whose sha can be anywhere is a field that needs a parser nobody audits'],
  ['092d08', null, 'six hex chars is too short to name a commit unambiguously'],
  [undefined, null, 'absent'],
  ['', null, 'empty'],
];
for (const [input, expected, why] of SHA_PARSE_CASES) {
  const got = extractShaPrefix(input);
  if (got === expected) {
    pass += 1;
    console.log(`  ok   sha-parse            ${String(got ?? 'null').slice(0, 20).padEnd(20)} ${why}`);
  } else {
    failures.push({ iso: 'sha-parse', expected: String(expected), got: String(got), why });
    console.log(`  FAIL sha-parse            expected ${expected}, got ${got}  — ${why}`);
  }
}

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
  CASES.length +
  HOLD_CASES.length +
  WARN_CASES.length +
  ROLLBACK_CASES.length +
  NOTE_CASES.length +
  CARRY_CASES.length +
  DEPLOY_HOLD_CASES.length +
  OVERRIDE_CASES.length +
  STALENESS_CASES.length + // TRA-4262
  1 + // the CURRENT-is-silent renderer control
  staleLiveArms + // the real-ancestry live arm + its paired CURRENT control (0 in a shallow checkout)
  requiredFieldArms + // both stamps are REQUIRED: the BLIND files and their one-variable-apart pairs
  BASELINE_CASES.length + // TRA-4268, gate −1c: which WINDOW does emits[] cover
  2 + // the baseline renderer: the window prints ABOVE emits[], and a loud status reaches the text
  baselineLiveArms + // real ancestry through the shipped probe, both ways round (0 in a shallow checkout)
  PIN_DRIFT_CASES.length + // TRA-4268, the network half at Gate 4
  2 + // the pin-drift renderer: REBOOTED names both shas + the boot, MATCHES stays quiet
  SHA_PARSE_CASES.length + // the stamp parser, the point where prose becomes checkable
  1 + // the blind-shallow composition case
  1; // the deploy-hold LIVE read
const allMissing = [
  ...missing,
  ...holdMissing,
  ...warnMissing,
  ...rbMissing,
  ...noteMissing,
  ...carryMissing,
  ...dhMissing,
  ...ovMissing,
  ...stMissing.map(v => `staleness:${v}`),
  ...blMissing.map(v => `baseline:${v}`),
  ...pdMissing.map(v => `pin-drift:${v}`),
];

console.log('');
console.log(`freeze  : ${FREEZE_OPEN_MIN}–${FREEZE_CLOSE_MIN} UTC min-of-day (lead ${DEPLOY_LEAD_MIN} min)`);
console.log(`embargos: ${EMBARGOES.length} row(s) — ${EMBARGOES.map(e => `${e.from}→${e.to}`).join(', ')}`);
console.log(
  `holds   : ${COMMIT_HOLDS.length} row(s) — ${COMMIT_HOLDS.map(h => `${h.commit.slice(0, 7)}→${h.until} (${h.ticket})`).join(', ')}`,
);
console.log(`dholds  : ${DEPLOY_HOLD_FILE} — ${readDeployHolds().holds.map(h => h.ticket).join(', ') || 'none'} (TRA-4261)`);
console.log(`cases   : ${pass}/${TOTAL} pass`);
console.log(
  `verdicts: reached ${[...new Set([...produced, ...holdProduced, ...warnProduced, ...rbProduced, ...noteProduced, ...carryProduced, ...dhProduced])].sort().join(', ')}`,
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
console.log(
  `baseline: emits[] window graded ${[...blProduced].sort().join('/')} · live-pin drift ${[...pdProduced].sort().join('/')} (TRA-4268)`,
);
console.log('[tra2325] PASS — freeze, embargo, commit-hold, rollback, stale-pin and deploy-hold all discriminate,');
console.log('[tra2325] and every verdict is reachable.');
process.exit(0);
