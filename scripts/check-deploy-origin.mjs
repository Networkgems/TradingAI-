#!/usr/bin/env node
// check-deploy-origin.mjs — TRA-4789
//
// Every deploy gate we own lives INSIDE a script an operator can decline to run.
//
// `scripts/render-redeploy.mjs` carries six refusals (Gate -1 `ops/deploy-hold.json`,
// -2 the argument guard, 4 the RTH freeze, 5 the dated embargo, 6 the held commit,
// 7 the live `AUTH_SECRET`, 10 the cadence ceiling). Not one of them can see a deploy
// created from the Render DASHBOARD — the button is a different code path on somebody
// else's servers. The gate set reads "in force" IDENTICALLY whether a given deploy
// passed through it or walked around it, which is the same silent-green class the whole
// freeze sprint was about.
//
// This is not hypothetical. Measured on bqb1 2026-09-23 (TRA-4384 §2 found the first of
// them; this script's capture found the other two):
//
//   dep-daj21q7qj5pc73bvbul0  trigger=manual  b22a9999  2026-09-13T04:04:56Z
//   dep-daj2nhbm8hqs73enqj00  trigger=manual  b22a9999  2026-09-13T04:51:17Z
//   dep-daj9nl1594qs73bbhcg0  trigger=manual  b22a9999  2026-09-13T12:49:24Z
//
// Three dashboard deploys in nine hours, none of which ran a single gate. They happened
// to be harmless. That is luck, not a control.
//
// ── Why this is a DETECTOR and not a permissions change ──────────────────────────────
//
// Option (a) — take the button away with Render permissions — was measured, not assumed,
// and it is UNAVAILABLE on this account:
//
//   GET /v1/owners                                  → one owner, type `team`,
//                                                     tea-d7macfog4nts73ai6p40
//   GET /v1/owners/tea-…/members                    → exactly ONE member,
//                                                     eetiennecg@gmail.com, role ADMIN,
//                                                     status active
//
// Render's role model can only restrict members BELOW admin. The workspace's sole member
// is its admin/owner, and an owner cannot be demoted out of their own deploy button.
// There is no second seat to constrain. (a) therefore has no implementation on the
// account as it stands; the specific option that WOULD exist — stand up a second,
// non-admin Render seat for day-to-day operation and seal the admin seat — restructures
// the account, needs a new API key, and STILL leaves the admin seat's button. That is a
// board call, and it is written up on TRA-4789.
//
// So: (b). Detect it, fail closed, and name it.
//
// ── ⛔ WHAT A GREEN HERE DOES AND DOES NOT MEAN ──────────────────────────────────────
//
// `trigger: api` means Render received `POST /v1/services/{id}/deploys`. It does NOT
// mean `render-redeploy.mjs` sent it. A raw
//
//     curl -X POST -H "Authorization: Bearer $RENDER_API_KEY" .../deploys
//
// is BYTE-IDENTICAL to the script's own POST from Render's side, and no field anywhere
// in the deploy record or the event stream distinguishes them. This detector's true
// claim is therefore narrower than "every deploy passed the gates":
//
//     NO DEPLOY TOOK A PATH THAT RENDER ITSELF LABELS AS OTHER-THAN-REST.
//
// It closes the measured hole (the dashboard button, and the settings/env and
// auto-deploy paths beside it) and it cannot close the raw-curl hole. Every CLEAN run
// prints that sentence, because a green whose limits are only written in a header is a
// green that will be over-read.
//
// ── The two legs ─────────────────────────────────────────────────────────────────────
//
// 1. CLASSIFICATION — `deploy.trigger` off `GET /services/{id}/deploys`. Present on every
//    row for the full depth of the history. Only `api` is sanctioned; every other KNOWN
//    value is a bypass with a label; anything NOT in the table reads BLIND. That
//    asymmetry is deliberate: a value we guessed wrong can only ever mislabel a bypass,
//    never manufacture a pass.
//
// 2. ATTRIBUTION — `deploy_started.details.trigger` off `GET /services/{id}/events`,
//    which carries `{manual, envUpdated, rollback, deployedByRender, clearCache,
//    firstBuild, user:{email,id}}`. ⚠️ This corrects the record: TRA-4384 §2 reported
//    "Render records no actor". That is true of the DEPLOY object and FALSE of the
//    EVENT — all three 09-13 dashboard deploys carry
//    `user.email = eetiennecg@gmail.com`. The events history is shallower than the
//    deploy history, so this leg is allowed to read UNREAD per row — but UNREAD is
//    PRINTED WITH ITS REASON, never silently absent, and it is never upgraded to "fine".
//
//    ⛔ A DISAGREEMENT between the two legs is BLIND, never clean: if `deploy.trigger`
//    says `api` while the event says `manual: true` (or the reverse), one of our two
//    readings of Render is wrong and we do not know which.
//
// ── Binding: this history must be THIS box's ─────────────────────────────────────────
//
// A service id taken on faith from an env var could be another box entirely, whose clean
// history would then manufacture a confident green for bqb1. Same trap TRA-3536 hit on
// the deploy-train window, same fix: the newest deploy with status `live` must carry
// EXACTLY the SHA `/api/health/version` is serving right now. If it does not, BLIND.
//
// ── Acknowledgements ─────────────────────────────────────────────────────────────────
//
// `ops/deploy-origin-acks.json` clears an ADJUDICATED bypass from the exit code. It never
// hides one: an acked deploy is printed in full on every fire, tagged with the issue that
// settled it. `--no-acks` prints the raw truth.
//
// ⛔ These acks are NOT `scripts/boot-arm-repair-acks.json`'s acks. That ledger requires a
// `fixCommit` that made recurrence impossible. There is no such commit here and there
// cannot be one — the hole is a permissions hole on someone else's dashboard, which is
// the entire finding. An ack here means "seen, reviewed, dispositioned on a ticket",
// nothing more. Do not import the stronger ledger's semantics into this weaker one.
//
// ── ⛔ WHICH ledger — the COMMITTED one, never the working tree (TRA-4868) ────────────
//
// Until 2026-09-24 the ledger was `path.join(REPO, 'ops/deploy-origin-acks.json')` — i.e.
// whatever sat in the working tree of the checkout this happened to run from — and the
// report said only `acks  N acknowledgement(s) loaded`. No path, no HEAD, no dirty flag.
// The reader could not tell WHICH ledger was graded, and the verdict moved with it.
//
// Measured, both directions, same host and same deploy history:
//
//   shared agent checkout, HEAD 9582420a, 172 commits behind origin/main
//     → bypass=5 (acked 4, unacked 1)  VERDICT = BYPASS  exit 1
//   same run, ledger blob taken from origin/main
//     → bypass=5 (acked 5, unacked 0)  VERDICT = CLEAN   exit 0
//
// The stale checkout re-raised dep-daq028id0e5s73aka5i0 — adjudicated and acked on
// TRA-4845 fourteen hours earlier — as an unacked BYPASS. That is the CHEAP direction.
//
// ⛔ THE EXPENSIVE DIRECTION IS THE SAME DEFECT RUN THE OTHER WAY. An ack that exists only
// as an UNCOMMITTED edit in somebody's working tree silences a real, un-adjudicated
// bypass; the run reads CLEAN, exit 0, with nothing distinguishing it from a run against
// the shipped ledger. Same class as everything else in this file: the instrument reads
// IDENTICALLY in pass and fail. It is also the exact hazard `check:deploy-build` already
// refuses by construction — it grades the commit in a throwaway worktree, never the dirty
// tree, precisely because "an unstaged fix passes a broken commit".
//
// So, mirroring that rule:
//
//   • DEFAULT: the ledger is `git show origin/main:ops/deploy-origin-acks.json`, after a
//     `git fetch`. The checkout's own copy is NOT read. A failed fetch, an unresolvable
//     ref or an unreadable blob is BLIND (3) — never CLEAN.
//   • `--acks-from=worktree` grades the checkout's copy, and is LOUD about it. Any ack in
//     it that origin/main does NOT carry is INERT: it degrades to a WARNING and the row
//     still counts, exactly like an incomplete ack. An uncommitted ack cannot buy a green.
//   • `--acks=<path>` grades an explicit file. It is named on the command line, so it can
//     never be mistaken for the default the way a working-tree read could.
//   • PROVENANCE IS PRINTED ON EVERY RUN: source, blob, repo, HEAD, branch, how far behind
//     origin/main, fetch outcome, and whether the working copy is dirty. A provenance that
//     cannot be printed is BLIND, not a footnote.
//   • A bypass that alarms here while origin/main's ledger DOES acknowledge it is named as
//     STALE LEDGER, not re-raised as a new bypass. TRA-4836 lost a session to exactly that.
//
// ⛔ Do NOT "fix" staleness by having the routine `git pull` first. That makes the verdict
// depend on an unmeasured side effect — the same defect with a longer fuse.
//
// ── Exit codes — FAILS CLOSED. Precedence BLIND > BYPASS > CLEAN ─────────────────────
//
//   0  CLEAN   every deploy in the window carries `trigger: api`, and every attribution
//              that could be read agrees. (A window with no deploys prints VACUOUS and
//              its denominator; a zero you cannot tell from a quiet week is not a pass.)
//   1  BYPASS  at least one deploy reached bqb1 by a path that ran NO gate. Each one is
//              named: deploy id, sha, timestamp, trigger, actor.
//   2  USAGE   an argument was not recognised. Values attach with `=` (TRA-4420: this
//              script's sibling shipped a positive-match guard and deployed the branch
//              tip on a typo).
//   3  BLIND   a leg could not be READ, or the two legs disagree, or a trigger value is
//              one we have never seen. NEVER a pass. "I could not check" and "I checked
//              and it is fine" must not share an exit code.
//
// Usage:
//   node scripts/check-deploy-origin.mjs                  # last 30 days of bqb1
//   node scripts/check-deploy-origin.mjs --days=90
//   node scripts/check-deploy-origin.mjs --since=2026-09-01T00:00:00Z
//   node scripts/check-deploy-origin.mjs --acks-from=worktree   # grade the CHECKOUT's ledger
//   node scripts/check-deploy-origin.mjs --acks=<path>    # grade an explicit ledger file
//   node scripts/check-deploy-origin.mjs --no-acks        # raw truth, acks ignored
//   node scripts/check-deploy-origin.mjs --live=<sha>     # skip the health curl
//   node scripts/check-deploy-origin.mjs --json
//   node scripts/check-deploy-origin.mjs --selftest       # offline; grades the instrument

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const RENDER_API = 'https://api.render.com/v1';
const DEFAULT_SERVICE = 'srv-d7mb7rr7uimc73ev0chg'; // tradingai-bqb1
const DEFAULT_HOST = 'https://tradingai-bqb1.onrender.com';
export const LEDGER_REL = 'ops/deploy-origin-acks.json';
export const ACK_REF = 'origin/main';
export const ACK_SOURCES = new Set(['origin', 'worktree']);
const PAGE = 100;
const MAX_PAGES = 12; // 1200 rows; a capped page that did not reach back reads BLIND.

export const EXIT = { CLEAN: 0, BYPASS: 1, USAGE: 2, BLIND: 3 };

// ── The trigger table ────────────────────────────────────────────────────────────────
// ⛔ ONLY `api` is sanctioned, and `api` is the one value in here that was MEASURED on
// this service (46 of 50 rows on 2026-09-23). The rest are labels for bypasses. A label
// we got wrong mislabels a refusal; it cannot create a pass. Anything absent from this
// table is BLIND — an unknown trigger is not an `api` trigger.
export const TRIGGERS = {
  api: { sanctioned: true, label: 'REST POST /deploys (the render-redeploy.mjs path — see the caveat above)' },
  manual: { sanctioned: false, label: 'RENDER DASHBOARD BUTTON — no gate ran' },
  deploy_hook: { sanctioned: false, label: 'deploy hook URL — no gate ran' },
  new_commit: { sanctioned: false, label: 'autoDeploy fired on a commit — this ALSO contradicts the autoDeploy=no pin (TRA-1653/TRA-1665)' },
  blueprint_sync: { sanctioned: false, label: 'render.yaml blueprint sync — no gate ran' },
  rollback: { sanctioned: false, label: 'dashboard rollback — no gate ran' },
  service_updated: { sanctioned: false, label: 'a settings/env write materialised a deploy — no gate ran (cf. ENV_WRITE_TRUTH, TRA-3724)' },
  service_resumed: { sanctioned: false, label: 'service resumed — no gate ran' },
  deployed_by_render: { sanctioned: false, label: 'Render-initiated (platform maintenance) — no gate ran' },
  other: { sanctioned: false, label: 'Render says "other" — no gate ran' },
};

export function classifyTrigger(trigger) {
  if (typeof trigger !== 'string' || trigger === '') {
    return { kind: 'unknown', label: `deploy record carries no \`trigger\` (${JSON.stringify(trigger)})` };
  }
  const hit = TRIGGERS[trigger];
  if (!hit) return { kind: 'unknown', label: `trigger \`${trigger}\` is not in the known table` };
  return { kind: hit.sanctioned ? 'sanctioned' : 'bypass', label: hit.label };
}

// ── Attribution ──────────────────────────────────────────────────────────────────────
// Reads the `deploy_started` event for a deploy id. Returns `state: 'unread'` — with a
// reason — when the events history does not reach that deploy. UNREAD is a real answer
// here (the events route is shallower than the deploys route); it is never "clean".
export function readAttribution(deployId, events, { eventsReachedMs } = {}) {
  const rows = Array.isArray(events) ? events : [];
  const ev = rows
    .map((e) => e?.event ?? e)
    .find((e) => e?.type === 'deploy_started' && e?.details?.deployId === deployId);
  if (!ev) {
    return {
      state: 'unread',
      why:
        eventsReachedMs == null
          ? 'no deploy_started event for this deploy in the fetched events'
          : `the events history reaches back only to ${new Date(eventsReachedMs).toISOString()}`,
    };
  }
  const t = ev?.details?.trigger;
  if (!t || typeof t !== 'object') {
    return { state: 'unread', why: 'the deploy_started event carried no `details.trigger` object' };
  }
  return {
    state: 'read',
    manual: t.manual === true,
    envUpdated: t.envUpdated === true,
    rollback: t.rollback === true,
    deployedByRender: t.deployedByRender === true,
    clearCache: t.clearCache === true,
    // ⛔ `user` is ABSENT on the service_updated deploy measured 2026-09-21T02:08Z. An
    // absent actor is reported as absent, never as "nobody did it".
    actor: t.user?.email ?? null,
    actorId: t.user?.id ?? null,
  };
}

// ── Acks ─────────────────────────────────────────────────────────────────────────────
// A MISSING file is "no acknowledgements" and is said out loud. A file that exists and
// does not parse, or whose shape is wrong, is BLIND — an unreadable ledger must not read
// as an empty one, or a corrupt ack file silently turns every bypass back into an alarm
// (permissive in the other direction: a malformed file could equally be read as "acks
// everywhere" by a sloppier parser). Fail closed on both.
export function loadAcks(file, { readFile = fs.readFileSync, exists = fs.existsSync } = {}) {
  if (!exists(file)) return { acks: [], note: `no ack ledger at ${path.relative(REPO, file)} — nothing is acknowledged` };
  let raw;
  try {
    raw = readFile(file, 'utf8');
  } catch (e) {
    return { blind: `could not read ${file}: ${e?.message ?? e}` };
  }
  const parsed = parseLedgerText(raw, file);
  if (parsed.blind) return { blind: parsed.blind };
  return { acks: parsed.acks, note: `${parsed.acks.length} acknowledgement(s) loaded` };
}

// ONE parser for BOTH shapes — a file on disk and a blob out of `git cat-file`. Two
// parsers is two chances for the committed ledger and the working copy to be judged by
// different rules, which is this ticket's bug one layer down.
export function parseLedgerText(raw, whence) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { blind: `${whence} does not parse as JSON: ${e?.message ?? e}` };
  }
  if (!parsed || !Array.isArray(parsed.acks)) {
    return { blind: `${whence} has no \`acks\` array` };
  }
  return { acks: parsed.acks };
}

// ── WHICH ledger, and where it came from (TRA-4868) ──────────────────────────────────
//
// ⛔ ALL OF THIS LIVES IN THIS FILE ON PURPOSE. The sanctioned way to grade a SHIPPED
// detector rather than a local fork is
//     git show origin/main:scripts/check-deploy-origin.mjs > <scratch>/x.mjs && node <scratch>/x.mjs
// (TRA-4821, TRA-4867). An `import './lib/…'` here would make that one-file extraction die
// with ERR_MODULE_NOT_FOUND — it would break the very discipline this fix exists to serve.
// One blob, node builtins only.

export function makeRunGit(cwd, spawn = spawnSync) {
  return (args) => {
    const r = spawn('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true });
    if (r?.error) return { ok: false, status: null, stdout: '', stderr: String(r.error.message ?? r.error) };
    return { ok: r?.status === 0, status: r?.status ?? null, stdout: r?.stdout ?? '', stderr: String(r?.stderr ?? '').trim() };
  };
}

// Everything the report must PRINT about the ledger, and everything the modes below need
// in order to decide. Every field is independently nullable and every failure is RECORDED:
// a probe that could not read a field must never let that field read as a benign default.
export function probeGit({ repo, runGit, rel = LEDGER_REL, ref = ACK_REF, doFetch = true }) {
  const p = {
    repo, ref, rel, isRepo: false, errors: [],
    fetched: null, head: null, branch: null, behind: null,
    refSha: null, refBlob: null, refText: null, worktreeBlob: null, dirty: null,
  };
  const run = (args, { soft = false } = {}) => {
    const r = runGit(args);
    if (!r.ok && !soft) p.errors.push(`git ${args.join(' ')} → ${r.stderr || `exit ${r.status}`}`);
    return r;
  };

  if (!run(['rev-parse', '--show-toplevel']).ok) return p;
  p.isRepo = true;

  const head = run(['rev-parse', 'HEAD']);
  if (head.ok) p.head = head.stdout.trim();
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch.ok) p.branch = branch.stdout.trim();

  // ⛔ NOT optional. A stale `origin/main` grades a stale ledger, which is this ticket one
  // level down. A failed fetch is RECORDED and reads BLIND upstream — never CLEAN.
  if (doFetch) p.fetched = run(['fetch', '--quiet', 'origin', 'main']).ok;

  const refSha = run(['rev-parse', ref]);
  if (refSha.ok) p.refSha = refSha.stdout.trim();
  const behind = run(['rev-list', '--count', `HEAD..${ref}`]);
  if (behind.ok && /^\d+$/.test(behind.stdout.trim())) p.behind = Number(behind.stdout.trim());
  const refBlob = run(['rev-parse', `${ref}:${rel}`]);
  if (refBlob.ok) p.refBlob = refBlob.stdout.trim();
  if (p.refBlob) {
    const text = run(['cat-file', 'blob', p.refBlob]);
    if (text.ok) p.refText = text.stdout;
  }

  const status = run(['status', '--porcelain', '--', rel]);
  if (status.ok) p.dirty = status.stdout.trim() !== '';
  // A ledger ABSENT from the working tree is a real state — this file post-dates plenty of
  // checkouts — not a probe failure. Soft, and reported as ABSENT rather than as an error.
  const ho = run(['hash-object', rel], { soft: true });
  if (ho.ok) p.worktreeBlob = ho.stdout.trim();

  return p;
}

export function provenanceLine(probe, repo) {
  if (!probe.isRepo) return `repo    ${repo} — NOT a readable git checkout, so this ledger has NO provenance`;
  const wt = probe.worktreeBlob
    ? `${probe.worktreeBlob.slice(0, 8)} ${probe.dirty === null ? '(dirty=UNREADABLE)' : probe.dirty ? 'DIRTY vs HEAD' : 'clean vs HEAD'}`
    : 'ABSENT from the working tree';
  return (
    `repo    ${repo}  HEAD ${probe.head ? probe.head.slice(0, 8) : 'UNREADABLE'} (${probe.branch ?? '?'})  ` +
    `${probe.behind == null ? `behind-${probe.ref}=UNREADABLE` : `${probe.behind} commit(s) behind ${probe.ref}`}  ` +
    `fetch=${probe.fetched === null ? 'not attempted' : probe.fetched ? 'ok' : 'FAILED'}  ` +
    `worktree-ledger ${wt}`
  );
}

// ⛔ THE SUBJECT IS THE COMMITTED LEDGER, NEVER THE WORKING TREE (TRA-4868). Returns the
// acks to grade, the COMMITTED acks to compare them against, the provenance lines to
// print, and `blind` when provenance the chosen mode DEPENDS ON could not be read.
export function resolveAckLedger({
  mode,
  explicitPath = null,
  repo,
  runGit = null,
  rel = LEDGER_REL,
  ref = ACK_REF,
  readFile = fs.readFileSync,
  exists = fs.existsSync,
} = {}) {
  const out = { mode, blind: null, acks: [], committedAcks: null, note: null, lines: [], label: null, probe: null };

  if (mode === 'none') {
    out.note = 'acks IGNORED (--no-acks) — this is the raw truth';
    out.label = '(none)';
    out.lines.push('source  --no-acks — NOTHING is acknowledged; every bypass in the window counts');
    return out;
  }

  const git = runGit ?? makeRunGit(repo);
  const probe = probeGit({ repo, runGit: git, rel, ref, doFetch: mode !== 'path' });
  out.probe = probe;
  const why = (missing) =>
    `LEDGER PROVENANCE UNREADABLE — ${missing.join('; ')}.` +
    (probe.errors.length ? ` git said: ${probe.errors.join(' | ')}.` : '') +
    ' A ledger whose provenance cannot be printed is BLIND, not a footnote.';

  if (mode === 'origin') {
    const missing = [];
    if (!probe.isRepo) missing.push(`${repo} is not a git checkout, so ${ref}:${rel} cannot be read`);
    if (probe.fetched === false) missing.push(`\`git fetch origin main\` failed, so ${ref} may not be origin's main`);
    if (!probe.refBlob) missing.push(`${ref}:${rel} does not resolve`);
    else if (probe.refText == null) missing.push(`${ref}:${rel} could not be read`);
    if (missing.length) {
      out.blind = why(missing);
      out.lines.push(`source  ${ref}:${rel} — UNREADABLE`);
      out.lines.push(provenanceLine(probe, repo));
      return out;
    }
    const parsed = parseLedgerText(probe.refText, `${ref}:${rel}`);
    if (parsed.blind) {
      out.blind = `LEDGER: ${parsed.blind}`;
      out.lines.push(provenanceLine(probe, repo));
      return out;
    }
    out.acks = parsed.acks;
    out.committedAcks = parsed.acks;
    out.label = `${ref}:${rel}`;
    out.note = `${parsed.acks.length} acknowledgement(s) from ${ref}:${rel} (blob ${probe.refBlob.slice(0, 8)})`;
    out.lines.push(
      `source  ${ref}:${rel}  blob ${probe.refBlob.slice(0, 8)}  ${parsed.acks.length} ack(s) — ` +
        `the SHIPPED ledger. The working tree's copy was NOT graded.`,
    );
    out.lines.push(provenanceLine(probe, repo));
    if (probe.worktreeBlob && probe.worktreeBlob !== probe.refBlob) {
      out.lines.push(
        `note    the working tree's ${rel} DIFFERS from ${ref}'s and was IGNORED ` +
          `(${probe.worktreeBlob.slice(0, 8)} ≠ ${probe.refBlob.slice(0, 8)}); \`--acks-from=worktree\` grades it instead`,
      );
    }
    return out;
  }

  if (mode === 'worktree') {
    const missing = [];
    if (!probe.isRepo) missing.push(`${repo} is not a git checkout, so a working-tree ledger has no provenance at all`);
    if (probe.fetched === false) missing.push('`git fetch origin main` failed');
    if (probe.refText == null) missing.push(`${ref}:${rel} could not be read, so an UNCOMMITTED ack cannot be told from a committed one`);
    if (missing.length) {
      out.blind = why(missing);
      out.lines.push('source  ⚠ OVERRIDE --acks-from=worktree — but its provenance is UNREADABLE');
      out.lines.push(provenanceLine(probe, repo));
      return out;
    }
    const main = parseLedgerText(probe.refText, `${ref}:${rel}`);
    if (main.blind) {
      out.blind = `LEDGER: ${main.blind}`;
      out.lines.push(provenanceLine(probe, repo));
      return out;
    }
    const file = path.join(repo, rel);
    const wt = loadAcks(file, { readFile, exists });
    if (wt.blind) {
      out.blind = `ACKS: ${wt.blind}`;
      out.lines.push(provenanceLine(probe, repo));
      return out;
    }
    const mainIds = new Set(main.acks.map((a) => a?.deployId).filter((v) => typeof v === 'string'));
    const wtIds = new Set(wt.acks.map((a) => a?.deployId).filter((v) => typeof v === 'string'));
    const onlyHere = [...wtIds].filter((id) => !mainIds.has(id));
    const missingHere = [...mainIds].filter((id) => !wtIds.has(id));
    // ⛔ THE EXPENSIVE DIRECTION. An ack that exists only as an edit in somebody's checkout
    // must not silence a real bypass. Marked so `ackFor` refuses it — a WARNING and a
    // COUNTED row, exactly like an incomplete ack, and never a BLIND that would swallow the
    // unacked count of every other row in the window behind one "could not check".
    out.acks = wt.acks.map((a) => (a && mainIds.has(a.deployId) ? a : { ...(a ?? {}), __uncommitted: true }));
    out.committedAcks = main.acks;
    out.label = `${rel} (WORKING TREE)`;
    out.note = `${wt.acks.length} acknowledgement(s) from the WORKING TREE's ${rel}; ${onlyHere.length} of them are NOT in ${ref} and do NOT apply`;
    out.lines.push(`source  ⚠ OVERRIDE --acks-from=worktree: grading ${file}, which is NOT the shipped ledger`);
    out.lines.push(provenanceLine(probe, repo));
    out.lines.push(
      `x-check vs ${ref}:${rel} (blob ${probe.refBlob ? probe.refBlob.slice(0, 8) : '?'}): ` +
        `${onlyHere.length} ack(s) present ONLY here and therefore INERT${onlyHere.length ? ` [${onlyHere.join(', ')}]` : ''}; ` +
        `${missingHere.length} ack(s) ${ref} carries that this ledger LACKS${missingHere.length ? ` [${missingHere.join(', ')}]` : ''}`,
    );
    return out;
  }

  // mode === 'path' — an EXPLICIT operator override. It is named on the command line, so it
  // can never be mistaken for the default the way a working-tree read could. The git
  // cross-check here is DECORATION (no fetch is run) and never moves the verdict.
  const file = path.resolve(explicitPath ?? '');
  const r = loadAcks(file, { readFile, exists });
  out.label = file;
  out.lines.push(`source  ⚠ OVERRIDE --acks=${file} — provenance is whatever you pointed this at, NOT ${ref}`);
  if (r.blind) {
    out.blind = `ACKS: ${r.blind}`;
    return out;
  }
  out.acks = r.acks;
  out.note = `${r.acks.length} acknowledgement(s) from ${file} (EXPLICIT --acks= override)`;
  if (probe.isRepo) {
    const main = probe.refText ? parseLedgerText(probe.refText, `${ref}:${rel}`) : { blind: `${ref}:${rel} is unreadable from ${repo}` };
    if (!main.blind) out.committedAcks = main.acks;
    out.lines.push(provenanceLine(probe, repo));
    out.lines.push(
      `x-check ${
        main.blind
          ? `NOT possible — ${main.blind}`
          : `${ref}:${rel} carries ${main.acks.length} ack(s) — informational only; NO fetch was run, so ${ref} is only as fresh as this checkout`
      }`,
    );
  } else {
    out.lines.push(`repo    ${repo} — not a git checkout, so no cross-check against ${ref} was possible`);
  }
  return out;
}

// An ack applies only on EXACT deploy id and only when it is complete. A half-written ack
// does not apply — it alarms, and says why. Never ack by class ("manual is fine"); that
// re-creates the unenforced convention this whole issue rejected.
export function ackFor(deployId, acks) {
  const rows = Array.isArray(acks) ? acks : [];
  const hit = rows.find((a) => a && a.deployId === deployId);
  if (!hit) return null;
  // ⛔ TRA-4868. Set by `resolveAckLedger` in worktree mode for an ack `origin/main` does
  // NOT carry. An ack that is not committed is not an adjudication anybody else can see, so
  // it must not buy a green. Same disposition as an incomplete ack: warn, and COUNT the row.
  if (hit.__uncommitted) {
    return {
      invalid:
        `ack for ${deployId} exists ONLY in the graded working-tree ledger — ${ACK_REF}:${LEDGER_REL} does ` +
        'not carry it, so it does NOT apply. Adjudicate it on a ticket and COMMIT it.',
    };
  }
  const missing = ['issue', 'reviewedAt', 'why'].filter((k) => typeof hit[k] !== 'string' || hit[k].trim() === '');
  if (missing.length) return { invalid: `ack for ${deployId} is missing ${missing.join(', ')} — it does NOT apply` };
  return hit;
}

// ── Binding ──────────────────────────────────────────────────────────────────────────
export function bindHistory({ deploys, liveSha }) {
  const rows = (Array.isArray(deploys) ? deploys : []).map((e) => e?.deploy ?? e);
  if (rows.length === 0) return { ok: false, why: 'the deploys route returned no rows at all — this history was not read' };
  if (!liveSha) return { ok: false, why: 'no live SHA to bind against' };
  const newestLive = rows.find((d) => d?.status === 'live');
  if (!newestLive) {
    return { ok: false, why: `no deploy with status \`live\` in the newest ${rows.length} rows — cannot bind this history to the box` };
  }
  if (newestLive?.commit?.id !== liveSha) {
    return {
      ok: false,
      why:
        `the newest \`live\` deploy carries ${String(newestLive?.commit?.id).slice(0, 8)} but the health route ` +
        `served ${String(liveSha).slice(0, 8)} — this is not this box's history, so nothing is asserted about it`,
    };
  }
  return { ok: true, newestLive: newestLive.id };
}

// ── The grade ────────────────────────────────────────────────────────────────────────
export function grade({
  deploys,
  events = [],
  sinceMs,
  nowMs,
  acks = [],
  useAcks = true,
  liveSha = null,
  historyComplete = true,
  historyIncompleteWhy = null,
  eventsReachedMs = null,
  preBlind = [],
  // TRA-4868 — the acks `origin/main` carries, whatever ledger is actually being GRADED.
  // Used only to name a stale-ledger alarm; it can never clear one.
  committedAcks = null,
}) {
  const blind = [...preBlind];
  const warnings = [];
  const rows = [];
  const committedIndex = new Map(
    (Array.isArray(committedAcks) ? committedAcks : [])
      .filter((a) => a && typeof a.deployId === 'string')
      .map((a) => [a.deployId, a]),
  );

  const bind = bindHistory({ deploys, liveSha });
  if (!bind.ok) blind.push(`BINDING: ${bind.why}`);
  if (!historyComplete) blind.push(`HISTORY: ${historyIncompleteWhy ?? 'the deploy history did not reach back to the start of the window'}`);

  const all = (Array.isArray(deploys) ? deploys : []).map((e) => e?.deploy ?? e);
  for (const d of all) {
    const createdMs = Date.parse(d?.createdAt ?? '');
    if (!Number.isFinite(createdMs)) {
      // ⛔ An unreadable timestamp is INCLUDED and BLIND. Dropping it would let a row
      // with a mangled date leave the population unnoticed.
      blind.push(`deploy ${d?.id ?? '(no id)'} has an unreadable createdAt ${JSON.stringify(d?.createdAt)} — it cannot be placed in or out of the window`);
      continue;
    }
    if (createdMs < sinceMs || createdMs > nowMs) continue;

    const cls = classifyTrigger(d?.trigger);
    const attr = readAttribution(d?.id, events, { eventsReachedMs });

    // Leg-disagreement. Only assertable when the attribution was actually read.
    let disagreement = null;
    if (attr.state === 'read') {
      const triggerSaysManual = d?.trigger === 'manual';
      if (triggerSaysManual !== attr.manual) {
        disagreement =
          `deploy.trigger=${JSON.stringify(d?.trigger)} but deploy_started.details.trigger.manual=${attr.manual} — ` +
          'the two readings of Render disagree and we do not know which is right';
        blind.push(`deploy ${d?.id}: ${disagreement}`);
      }
    }

    // ⛔ An INCOMPLETE ack is a WARNING, not a BLIND. BLIND means "I could not check";
    // here we checked and read a fact — the ack does not apply — so the deploy alarms
    // as an ordinary bypass. Blinding on it would let one typo'd ack swallow the
    // unacked COUNT of every other row in the window behind a single "could not check".
    const ack = cls.kind === 'bypass' && useAcks ? ackFor(d?.id, acks) : null;
    if (ack?.invalid) warnings.push(`ACK: ${ack.invalid}`);

    if (cls.kind === 'unknown') {
      blind.push(`deploy ${d?.id} (${d?.createdAt}): ${cls.label} — an unknown trigger is not an \`api\` trigger`);
    }

    const applied = Boolean(ack && !ack.invalid);
    const counted = cls.kind === 'bypass' && !applied;
    // ⛔ TRA-4868. A bypass that alarms HERE while the COMMITTED ledger acknowledges it is
    // not a new bypass — it is the graded ledger being STALE. Say which, or the reader
    // re-adjudicates a settled deploy: TRA-4836 did exactly that off a 172-behind checkout.
    const committed = counted ? committedIndex.get(d?.id) ?? null : null;

    rows.push({
      id: d?.id ?? null,
      createdAt: d?.createdAt ?? null,
      status: d?.status ?? null,
      commit: d?.commit?.id ? String(d.commit.id).slice(0, 8) : null,
      trigger: d?.trigger ?? null,
      kind: cls.kind,
      label: cls.label,
      attribution: attr,
      disagreement,
      ack: applied ? { issue: ack.issue, reviewedAt: ack.reviewedAt, why: ack.why } : null,
      staleAck: committed ? { issue: committed.issue ?? null, reviewedAt: committed.reviewedAt ?? null } : null,
      counted,
    });
  }

  rows.sort((a, b) => Date.parse(b.createdAt ?? 0) - Date.parse(a.createdAt ?? 0));

  const counts = {
    n: rows.length,
    sanctioned: rows.filter((r) => r.kind === 'sanctioned').length,
    bypass: rows.filter((r) => r.kind === 'bypass').length,
    unknown: rows.filter((r) => r.kind === 'unknown').length,
    acked: rows.filter((r) => r.ack).length,
    unacked: rows.filter((r) => r.counted).length,
    attributionUnread: rows.filter((r) => r.attribution?.state === 'unread').length,
    // TRA-4868 — unacked HERE, but acknowledged in the committed ledger. A staleness
    // reading, not a bypass reading. Printed so the two can never be confused again.
    staleAlarms: rows.filter((r) => r.staleAck).length,
  };

  const verdict = blind.length ? 'BLIND' : counts.unacked > 0 ? 'BYPASS' : 'CLEAN';
  const exitCode = verdict === 'BLIND' ? EXIT.BLIND : verdict === 'BYPASS' ? EXIT.BYPASS : EXIT.CLEAN;
  return { verdict, exitCode, rows, counts, blind, warnings, bind, vacuous: counts.n === 0 };
}

// ── Transport ────────────────────────────────────────────────────────────────────────
class Blind extends Error {}

async function realTransport(url, headers) {
  let r;
  try {
    r = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new Blind(`GET ${url} threw: ${e?.message ?? e}`);
  }
  if (!r.ok) throw new Blind(`GET ${url} → ${r.status} ${r.statusText}`);
  let json;
  try {
    json = await r.json();
  } catch (e) {
    throw new Blind(`GET ${url} did not return JSON: ${e?.message ?? e}`);
  }
  return json;
}

// Pages until the oldest row predates `stopBeforeMs`, or the list is exhausted.
// `reachedBack` is TRUE when either happened. It is FALSE only when the page cap bit —
// i.e. when there is more history we did not look at, which is exactly the case where a
// silence means nothing.
export async function fetchPaged({ route, serviceId, key, stopBeforeMs, transport = realTransport, maxPages = MAX_PAGES }) {
  const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
  const rows = [];
  let cursor = null;
  let pages = 0;
  let oldestMs = Infinity;
  let exhausted = false;
  while (pages < maxPages) {
    const url = `${RENDER_API}/services/${serviceId}/${route}?limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page = await transport(url, headers);
    if (!Array.isArray(page)) throw new Blind(`GET ${url} returned ${typeof page}, expected an array`);
    pages += 1;
    if (page.length === 0) {
      exhausted = true;
      break;
    }
    for (const item of page) {
      const o = item?.deploy ?? item?.event ?? item;
      rows.push(item);
      const t = Date.parse(o?.createdAt ?? o?.timestamp ?? '');
      if (Number.isFinite(t)) oldestMs = Math.min(oldestMs, t);
    }
    cursor = page[page.length - 1]?.cursor ?? null;
    if (page.length < PAGE || !cursor) {
      exhausted = true;
      break;
    }
    if (oldestMs < stopBeforeMs) break;
  }
  const reachedBack = exhausted || oldestMs < stopBeforeMs;
  return { rows, pages, oldestMs: Number.isFinite(oldestMs) ? oldestMs : null, reachedBack, exhausted };
}

// ── Arg guard (TRA-4420) ─────────────────────────────────────────────────────────────
// ⛔ Matched NEGATIVELY. render-redeploy.mjs matched its flags positively, so `--commmit=`
// and `--commit <sha>` read as "no commit given" and shipped the branch tip to the money
// host, exit 0. Anything not on this list is exit 2 naming the offender.
const FLAGS = new Set(['--selftest', '--json', '--no-acks', '--verbose', '--help', '-h']);
const VALUED = new Set(['--days', '--since', '--service', '--live', '--host', '--acks', '--acks-from']);

export function parseArgs(argv) {
  const out = { flags: new Set(), values: {} };
  for (const a of argv) {
    if (FLAGS.has(a)) {
      out.flags.add(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0 && VALUED.has(a.slice(0, eq))) {
      out.values[a.slice(0, eq)] = a.slice(eq + 1);
      continue;
    }
    if (VALUED.has(a)) {
      return { usage: `\`${a}\` needs its value attached with \`=\` (e.g. ${a}=…). A detached value is how TRA-4420 shipped the wrong commit.` };
    }
    return { usage: `unrecognised argument \`${a}\`` };
  }
  return out;
}

const USAGE = `check-deploy-origin.mjs — TRA-4789

  node scripts/check-deploy-origin.mjs [--days=30 | --since=<iso>] [--service=srv-…]
                                       [--live=<sha>] [--host=https://…]
                                       [--acks-from=origin|worktree] [--acks=<path>]
                                       [--no-acks] [--verbose] [--json] [--selftest]

  0 CLEAN   every deploy in the window was created by REST
  1 BYPASS  a deploy reached the host by a path that ran no gate
  2 USAGE   unrecognised argument (values attach with \`=\`)
  3 BLIND   a leg was unreadable, the legs disagree, a trigger value is unknown, or the
            ack ledger's PROVENANCE could not be read

THE ACK LEDGER (TRA-4868). By default it is \`git show ${ACK_REF}:${LEDGER_REL}\`, read after a
\`git fetch\` — NOT the working tree's copy, which moves with whatever checkout you happen to
be in. \`--acks-from=worktree\` grades the checkout's copy instead and is LOUD about it: any
ack in it that ${ACK_REF} does not carry is INERT and cannot clear a bypass. \`--acks=<path>\`
grades an explicit file. Provenance is printed on every run; unreadable provenance is BLIND.

Needs RENDER_API_KEY. Precedence: BLIND > BYPASS > CLEAN.`;

// ── Report ───────────────────────────────────────────────────────────────────────────
function printRow(r, log) {
  const tag = r.kind === 'sanctioned' ? 'ok    ' : r.kind === 'unknown' ? 'BLIND ' : r.ack ? 'acked ' : 'BYPASS';
  log(`[deploy-origin] ${tag} ${r.createdAt}  ${r.id}  ${r.commit ?? '(no sha)'}  trigger=${r.trigger}`);
  if (r.kind !== 'sanctioned') log(`[deploy-origin]          ${r.label}`);
  if (r.attribution?.state === 'read') {
    const a = r.attribution;
    const bits = [`manual=${a.manual}`, `envUpdated=${a.envUpdated}`, `rollback=${a.rollback}`, `deployedByRender=${a.deployedByRender}`];
    log(`[deploy-origin]          actor: ${a.actor ?? 'NONE RECORDED'}   ${bits.join(' ')}`);
  } else if (r.kind !== 'sanctioned') {
    log(`[deploy-origin]          actor: UNREAD — ${r.attribution?.why}`);
  }
  if (r.disagreement) log(`[deploy-origin]          ⛔ ${r.disagreement}`);
  if (r.ack) log(`[deploy-origin]          acknowledged on ${r.ack.issue} (${r.ack.reviewedAt}): ${r.ack.why}`);
  if (r.staleAck) {
    log(`[deploy-origin]          ⛔ STALE LEDGER: ${ACK_REF}:${LEDGER_REL} DOES acknowledge this deploy`);
    log(`[deploy-origin]             (${r.staleAck.issue ?? 'no issue'}, reviewed ${r.staleAck.reviewedAt ?? 'unstamped'}) — the ledger graded here`);
    log('[deploy-origin]             does NOT. This alarm is the graded ledger\'s STALENESS, not a new bypass.');
  }
}

const CAVEAT = [
  '`trigger: api` means Render received POST /deploys. It does NOT prove render-redeploy.mjs',
  'sent it — a raw curl with the API key is indistinguishable from the script from Render\'s',
  'side. What is asserted is narrower: no deploy took a path Render labels other-than-REST.',
];

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.usage) {
    console.error(`[deploy-origin] USAGE: ${parsed.usage}`);
    console.error('');
    console.error(USAGE);
    process.exit(EXIT.USAGE);
  }
  if (parsed.flags.has('--help') || parsed.flags.has('-h')) {
    console.log(USAGE);
    process.exit(EXIT.CLEAN);
  }
  if (parsed.flags.has('--selftest')) {
    const { runControls } = await import('./lib/deploy-origin-controls.mjs');
    process.exit(runControls());
  }

  const json = parsed.flags.has('--json');
  const useAcks = !parsed.flags.has('--no-acks');
  const serviceId = parsed.values['--service'] ?? process.env.RENDER_SERVICE_ID ?? DEFAULT_SERVICE;
  const host = (parsed.values['--host'] ?? DEFAULT_HOST).replace(/\/+$/, '');
  const nowMs = Date.now();

  // ── Which ledger (TRA-4868) ────────────────────────────────────────────────────────
  // Matched NEGATIVELY like every other argument here: an --acks-from value we do not
  // recognise is exit 2 naming it, never a silent fall-back to some default ledger.
  const ackFrom = parsed.values['--acks-from'];
  if (ackFrom !== undefined && !ACK_SOURCES.has(ackFrom)) {
    console.error(`[deploy-origin] USAGE: --acks-from=${ackFrom} is not one of ${[...ACK_SOURCES].join('|')}`);
    process.exit(EXIT.USAGE);
  }
  if (ackFrom !== undefined && parsed.values['--acks'] !== undefined) {
    console.error('[deploy-origin] USAGE: --acks= and --acks-from= are mutually exclusive — say which ledger you mean');
    process.exit(EXIT.USAGE);
  }
  const ackMode = !useAcks
    ? 'none'
    : parsed.values['--acks'] !== undefined
      ? 'path'
      : ackFrom === 'worktree'
        ? 'worktree'
        : 'origin';

  let sinceMs;
  if (parsed.values['--since']) {
    sinceMs = Date.parse(parsed.values['--since']);
    if (!Number.isFinite(sinceMs)) {
      console.error(`[deploy-origin] USAGE: --since=${parsed.values['--since']} did not parse as a date`);
      process.exit(EXIT.USAGE);
    }
  } else {
    const days = Number(parsed.values['--days'] ?? 30);
    if (!Number.isFinite(days) || days <= 0) {
      console.error(`[deploy-origin] USAGE: --days=${parsed.values['--days']} is not a positive number`);
      process.exit(EXIT.USAGE);
    }
    sinceMs = nowMs - days * 86_400_000;
  }

  const preBlind = [];
  const key = process.env.RENDER_API_KEY;

  const emit = (state) => {
    if (json) {
      console.log(JSON.stringify({ script: 'check-deploy-origin', ticket: 'TRA-4789', at: new Date(nowMs).toISOString(), service: serviceId, since: new Date(sinceMs).toISOString(), ...state }, null, 2));
    }
  };

  if (!key) {
    const why = 'RENDER_API_KEY is not set — the deploy history cannot be read. An unread history is not a clean one.';
    emit({ verdict: 'BLIND', blind: [why] });
    if (!json) console.error(`[deploy-origin] BLIND: ${why}`);
    process.exit(EXIT.BLIND);
  }

  // ── The ledger, resolved and its PROVENANCE captured BEFORE anything is graded ──────
  // ⛔ TRA-4868. This is local + git only, so it runs before the network legs: a run that
  // cannot say WHICH ledger it graded has nothing to say about the deploys either.
  const ledger = resolveAckLedger({
    mode: ackMode,
    explicitPath: parsed.values['--acks'] ?? null,
    repo: REPO,
  });
  if (ledger.blind) preBlind.push(ledger.blind);

  // Leg 0 — what is the box actually running. This is what binds the history to it.
  let liveSha = parsed.values['--live'] ?? null;
  if (!liveSha) {
    try {
      const r = await fetch(`${host}/api/health/version`, { signal: AbortSignal.timeout(25_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      liveSha = typeof body?.commit === 'string' && /^[0-9a-f]{7,40}$/i.test(body.commit) ? body.commit : null;
      if (!liveSha) preBlind.push(`GET ${host}/api/health/version carried no usable commit (${JSON.stringify(body?.commit)})`);
    } catch (e) {
      preBlind.push(`GET ${host}/api/health/version failed: ${e?.message ?? e} — without the served SHA this history cannot be bound to this box`);
    }
  }

  let deploys = [];
  let events = [];
  let historyComplete = true;
  let historyIncompleteWhy = null;
  let eventsReachedMs = null;

  try {
    const d = await fetchPaged({ route: 'deploys', serviceId, key, stopBeforeMs: sinceMs });
    deploys = d.rows;
    if (!d.reachedBack) {
      historyComplete = false;
      historyIncompleteWhy = `paged ${d.pages}×${PAGE} deploys back only to ${d.oldestMs ? new Date(d.oldestMs).toISOString() : 'an unreadable date'}, which does not cover the window start ${new Date(sinceMs).toISOString()} — there is history here we did not look at`;
    }
  } catch (e) {
    preBlind.push(e instanceof Blind ? e.message : `deploys: ${e?.message ?? e}`);
  }

  try {
    const ev = await fetchPaged({ route: 'events', serviceId, key, stopBeforeMs: sinceMs });
    events = ev.rows;
    eventsReachedMs = ev.reachedBack ? null : ev.oldestMs;
  } catch (e) {
    // ⚠️ The events route is the ATTRIBUTION leg, and attribution is allowed to be
    // UNREAD. An events outage therefore degrades attribution to UNREAD (printed) —
    // it does not blind the classification leg, which is complete on its own.
    events = [];
    eventsReachedMs = nowMs;
    console.error(`[deploy-origin] attribution leg UNREAD: ${e instanceof Blind ? e.message : e?.message ?? e}`);
  }

  const state = grade({
    deploys,
    events,
    sinceMs,
    nowMs,
    acks: ledger.acks ?? [],
    useAcks,
    liveSha,
    historyComplete,
    historyIncompleteWhy,
    eventsReachedMs,
    preBlind,
    committedAcks: ledger.committedAcks,
  });

  if (json) {
    emit({
      verdict: state.verdict,
      counts: state.counts,
      blind: state.blind,
      warnings: state.warnings,
      rows: state.rows,
      acks: ledger.note ?? null,
      ledger: {
        mode: ackMode,
        label: ledger.label,
        provenance: ledger.lines,
        committedAckCount: Array.isArray(ledger.committedAcks) ? ledger.committedAcks.length : null,
        git: ledger.probe
          ? {
              isRepo: ledger.probe.isRepo,
              head: ledger.probe.head,
              branch: ledger.probe.branch,
              behind: ledger.probe.behind,
              fetched: ledger.probe.fetched,
              refBlob: ledger.probe.refBlob,
              worktreeBlob: ledger.probe.worktreeBlob,
              dirty: ledger.probe.dirty,
              errors: ledger.probe.errors,
            }
          : null,
      },
      liveSha,
    });
    process.exit(state.exitCode);
  }

  const log = console.log;
  log(`[deploy-origin] service ${serviceId}  host ${host}`);
  log(`[deploy-origin] window  ${new Date(sinceMs).toISOString()} .. ${new Date(nowMs).toISOString()}`);
  log(`[deploy-origin] live    ${liveSha ? liveSha.slice(0, 8) : 'UNREAD'}${state.bind.ok ? `  (history bound via ${state.bind.newestLive})` : '  (NOT BOUND)'}`);
  log(`[deploy-origin] acks    ${ledger.note ?? '— UNREADABLE'}`);
  // ⛔ Provenance is printed on EVERY run, not only when it is interesting. The defect this
  // answers was that `acks  N acknowledgement(s) loaded` read identically whichever ledger
  // it had loaded — from the shipped one, from a 172-behind checkout, or from an
  // uncommitted edit. (TRA-4868.)
  for (const l of ledger.lines) log(`[deploy-origin]         ${l}`);
  log('');
  // Default is COMPACT: every non-`api` row in full, and the REST rows as one counted
  // line. ⛔ The count is printed either way — a report that hides its denominator is how
  // "n=0 because nothing happened" and "n=0 because I filtered everything out" come to
  // read the same. `--verbose` prints all 94-odd rows.
  const verbose = parsed.flags.has('--verbose');
  const shown = verbose ? state.rows : state.rows.filter((r) => r.kind !== 'sanctioned');
  for (const r of shown) printRow(r, log);
  if (!verbose && state.counts.sanctioned > 0) {
    log(`[deploy-origin] ok     ${state.counts.sanctioned} further deploy(s), all trigger=api — rerun with --verbose to list them`);
  }
  if (state.rows.length === 0) log('[deploy-origin] (no deploys in the window)');
  log('');
  log(
    `[deploy-origin] n=${state.counts.n}  rest=${state.counts.sanctioned}  bypass=${state.counts.bypass} ` +
      `(acked ${state.counts.acked}, unacked ${state.counts.unacked})  unknown=${state.counts.unknown}  ` +
      `attribution-unread=${state.counts.attributionUnread}  stale-ledger=${state.counts.staleAlarms}`,
  );
  log(`[deploy-origin] VERDICT = ${state.verdict}`);
  for (const w of state.warnings) log(`[deploy-origin] WARNING: ${w}`);
  log('');

  if (state.verdict === 'BLIND') {
    for (const b of state.blind) console.error(`[deploy-origin] BLIND: ${b}`);
    console.error('[deploy-origin] A leg could not be READ, or the legs disagree. This is never a pass —');
    console.error('[deploy-origin] "I could not check" and "I checked and it is fine" are different answers.');
    process.exit(EXIT.BLIND);
  }

  if (state.verdict === 'BYPASS') {
    console.error(`[deploy-origin] BYPASS — ${state.counts.unacked} deploy(s) above reached this host by a path that`);
    console.error('[deploy-origin] ran NONE of render-redeploy.mjs\'s gates: the deploy hold, the argument guard,');
    console.error('[deploy-origin] the RTH freeze, the dated embargo, the commit hold, the live AUTH_SECRET check,');
    console.error('[deploy-origin] and the cadence ceiling. Adjudicate each on a ticket, then record it in');
    console.error(`[deploy-origin] ${ACK_REF}:${LEDGER_REL} by deploy id — never by class.`);
    if (state.counts.staleAlarms > 0) {
      console.error('');
      console.error(`[deploy-origin] ⛔ BUT ${state.counts.staleAlarms} of those ${state.counts.unacked} ARE already acknowledged in ${ACK_REF}:${LEDGER_REL}`);
      console.error(`[deploy-origin] and are alarming only because the ledger graded here (${ledger.label}) is STALE.`);
      console.error('[deploy-origin] Do NOT re-adjudicate them. Grade the committed ledger — that is the default.');
    }
    process.exit(EXIT.BYPASS);
  }

  if (state.vacuous) {
    log('[deploy-origin] CLEAN — but VACUOUS: the window holds ZERO deploys. That is a denominator,');
    log('[deploy-origin] not a pass. Widen --days if you meant to grade a period that had deploys in it.');
  } else {
    log(`[deploy-origin] CLEAN — all ${state.counts.n} deploy(s) in the window were created by REST.`);
  }
  for (const line of CAVEAT) log(`[deploy-origin] ${line}`);
  process.exit(EXIT.CLEAN);
}

// ⛔ NOT `await main()`. The controls module imports this one, and `--selftest` imports the
// controls module — a top-level await here never lets this module finish evaluating, so the
// ESM cycle deadlocks and node exits 13 having printed NOTHING. A controls suite that dies
// silently with a non-zero code is a controls suite nobody reads.
//
// ⛔ THE ENTRY TEST IS IDENTITY FIRST, FILENAME ONLY AS A FALLBACK (TRA-4821, 2026-09-24).
// It used to be `argv[1].endsWith('check-deploy-origin.mjs')` alone. That is a test of the
// file's NAME, and this repo's own grading discipline renames it: the sanctioned way to grade
// a shipped blob rather than a local fork is
//     git show origin/main:scripts/check-deploy-origin.mjs > <scratch>/graded.mjs && node <scratch>/graded.mjs
// Under the name-keyed guard that run evaluated the module, called NOTHING, printed NOT ONE
// LINE and exited 0 — indistinguishable at the call site from `VERDICT = CLEAN`, on the one
// detector standing between bqb1 and an ungated deploy. Measured, not theorised: it is how
// this was found. The identity arm makes a renamed copy run; the `endsWith` arm is kept OR'd
// in so the fix cannot be strictly less permissive than what shipped (a realpath that fails to
// compare — case-folding, a junction, an odd argv[1] — must not silence the canonical call).
const isEntrypoint = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    if (fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url))) return true;
  } catch { /* unreadable argv[1] — fall through to the name test */ }
  return argv1.endsWith('check-deploy-origin.mjs');
})();

if (isEntrypoint) {
  main().catch((e) => {
    console.error(`[deploy-origin] BLIND: unhandled ${e?.stack ?? e}`);
    process.exit(EXIT.BLIND);
  });
}
