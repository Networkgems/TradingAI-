#!/usr/bin/env node
// check-restarts.mjs — "did bqb1 restart during this window?", answered from ALL the sources.
//
// TRA-2261. Every zero-restart gate on this box used to ask the Render deploys API, which can only
// see two of the three things that boot the process. On Fri 2026-07-24 RTH that check would have
// reported 2 boots where there were 4 — and over the 19:50–20:05Z tape window it reported NONE, on a
// window that is ~50% boot transient.
//
// This is the CLI in front of scripts/lib/render-boot-set.mjs, so a grader that is a shell script, a
// routine, or a human does not have to reimplement the union to get an honest answer.
//
// ── Usage ────────────────────────────────────────────────────────────────────────────────────────
//   RENDER_API_KEY=rnd_… node scripts/check-restarts.mjs                       # today's RTH
//   RENDER_API_KEY=rnd_… node scripts/check-restarts.mjs \
//       --from=2026-07-24T13:30:00Z --to=2026-07-24T20:00:00Z [--json] [--pre-window-ms=120000]
//
// ── Exit codes (a gate can branch on these; BLIND is NOT a pass) ─────────────────────────────────
//   0  CONTINUOUS — no boot seen by deploys, container-death events, or watchdog echoes
//   1  RESTARTED  — at least one boot in the window (the boots are listed)
//   2  usage / missing RENDER_API_KEY
//   3  BLIND      — a source was unreadable, so the boot set is incomplete. HOLD the grade.
import { pullBootSet, formatBootSet, assertContinuous } from './lib/render-boot-set.mjs';

const OWNER_ID = 'tea-d7macfog4nts73ai6p40';
const SERVICE_ID = 'srv-d7mb7rr7uimc73ev0chg';

const argv = process.argv.slice(2);
const valOf = n => { const h = argv.find(a => a.startsWith(`${n}=`)); return h ? h.slice(n.length + 1) : undefined; };

const API_KEY = process.env.RENDER_API_KEY;
if (!API_KEY) {
  console.error('RENDER_API_KEY is required.');
  process.exit(2);
}

const day = new Date().toISOString().slice(0, 10);

// ── Reject a malformed --from/--to HERE, loudly, instead of letting it become BLIND ────────────
// The Render logs API parses against `2006-01-02T15:04:05Z07:00` and HTTP 400s anything missing
// the SECONDS field — `--from=2026-08-12T13:30Z` is rejected. That 400 kills every log probe in
// `pullBootSet`, which degrades to an incomplete boot set and reports **BLIND**. The operator then
// reads "a source was unreadable — HOLD the grade" and holds a grade that was perfectly gradeable:
// the identical window with `:00` appended returns CONTINUOUS. That is exactly backwards — BLIND is
// meant to mean "the box would not tell us", not "you typed the flag wrong", and the two demand
// opposite responses (re-arm and wait vs. fix the argument and re-run immediately).
//
// This bit TRA-3019: its grading runbook wrote `--from=2026-08-07T13:30Z`, so the Fri 08-07 grade
// would have reported BLIND no matter how healthy the tape was. Same family as this gate's own
// `logs:null` rule — an error must never be allowed to wear the costume of an observation.
const RFC3339_UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const requireInstant = (flag, raw) => {
  if (raw === undefined) return undefined;
  if (!RFC3339_UTC_SECONDS.test(raw) || Number.isNaN(Date.parse(raw))) {
    console.error(
      `${flag}=${raw} is not a valid RFC3339 instant.\n` +
      `  The Render logs API requires the SECONDS field and a zone: 2026-08-12T13:30:00Z\n` +
      `  (a bare 2026-08-12T13:30Z is HTTP 400 -> every log probe fails -> this gate reports BLIND).\n` +
      `  Exiting 2 (operator error), NOT 3 (BLIND) — the window is not un-gradeable, the flag is wrong.`,
    );
    process.exit(2);
  }
  return raw;
};

const from = requireInstant('--from', valOf('--from')) ?? `${day}T13:30:00Z`;
const to = requireInstant('--to', valOf('--to')) ?? `${day}T20:00:00Z`;
if (Date.parse(to) <= Date.parse(from)) {
  console.error(`--to (${to}) must be strictly after --from (${from}). Exiting 2 (operator error).`);
  process.exit(2);
}
const preWindowMs = Number(valOf('--pre-window-ms') ?? 0);

const result = await pullBootSet({
  from, to, preWindowMs,
  serviceId: valOf('--service') ?? SERVICE_ID,
  ownerId: valOf('--owner') ?? OWNER_ID,
  apiKey: API_KEY,
});
const { verdict } = assertContinuous(result);

if (argv.includes('--json')) console.log(JSON.stringify({ verdict, ...result }, null, 2));
else console.log(formatBootSet(result));

process.exit(verdict === 'CONTINUOUS' ? 0 : verdict === 'RESTARTED' ? 1 : 3);
