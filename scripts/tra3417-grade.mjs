// TRA-3417 — the acceptance grader for the TRA-3401 armed OTM nominator.
//
// WHY A SCRIPT AND NOT A HAND-READ: every criterion on this issue has now been
// re-written once because the hand-read named an axis that does not exist
// (`byGate.cost_bar` on an ARRAY → `undefined`, byte-identical to "the gate
// recorded no cells" — which is the FAIL verdict itself). A grader that is
// written and DRY-RUN PRE-OPEN, while the honest answer is still "no scans yet",
// is the only way to find out that the instrument reads FAIL against working
// code before it is pointed at the one session that matters.
//
// ── The reads that are NOT interchangeable ──────────────────────────────────
//
// 1. `evaluated === 0`  ⇒ THREE different states, not one. See the LIVENESS
//    block: pre-open (benign) · the engine ticked but the sleeve was starved
//    upstream (a real negative) · nothing scanned at all (a defect). The first
//    draft hardcoded the benign reading, which at 14:15Z — 45 min AFTER the
//    open — is the least likely of the three.
// 2. `evaluated > 0` and the OTM cell is present ⇒ GRADEABLE.
// 3. `evaluated > 0` and the OTM cell is ABSENT ⇒ adjudicate with `byReason`,
//    never on the absence alone. See C3 below.
//
// ── Exit codes ──────────────────────────────────────────────────────────────
//   0  every gradeable criterion PASSED (the nominator bit AND it traded)
//   2  a criterion FAILED, or the instrument is DEFECTIVE
//   3  UNGRADEABLE / BLIND — pre-open, no session, or an instrument that cannot
//      see. FAIL-CLOSED: this is never collapsed into 0, 2 or 4.
//   4  REAL NEGATIVE — the instruments worked and the answer is NO TRADE.
//      Distinct from 0 on purpose: a negative result is not a pass.
//
// Usage:  node scripts/tra3417-grade.mjs            (logs read when RENDER_API_KEY is set)
//         node scripts/tra3417-grade.mjs --no-logs  (payload-only)

const HOST = process.env.HOST_BASE ?? 'https://tradingai-bqb1.onrender.com';
const KEY = process.env.RENDER_API_KEY;
const SERVICE = process.env.SERVICE ?? 'srv-d7mb7rr7uimc73ev0chg';
// `ownerId` is REQUIRED by /v1/logs — omitting it is a 400, not a filtered read.
const OWNER = process.env.RENDER_OWNER_ID ?? 'tea-d7macfog4nts73ai6p40';
const WANT_LOGS = !process.argv.includes('--no-logs') && Boolean(KEY);

// The ONLY cell the TRA-3401 arm admits. `tapeExpectancyCellKey` is
// `structure::|delta| bucket` with NO symbol axis, so the 10-name universe
// restriction does not scope it: every live candidate at |Δ|∈[0.50,0.55) lands
// here regardless of ticker.
const CELL = 'single_leg_otm::0.50-0.55';
const BAND = { min: 0.5, max: 0.55 };

// Reason codes that CANNOT be produced without a `|delta|` bucket, and therefore
// cannot be produced without a `cellKey` — pinned by the shipped test
// `otm-sleeve-mandate.test.ts` "cost_bar cell stamping (TRA-3483 I3)". If one of
// these appears while `byCell` is empty, the stamp was LOST between the verdict
// and the ledger, and that is a defect in the instrument, not a negative result.
const CELL_BEARING_REASONS = ['gross_negative', 'insufficient_evidence', 'band_deauthorized'];
// The one reason code that legitimately stamps NO cell: an unusable |delta|.
const CELL_FREE_REASON = 'gross_unknown';

const results = [];
const record = (id, verdict, detail) => {
  results.push({ id, verdict, detail });
  console.log(`${verdict.padEnd(11)} ${id} — ${detail}`);
};

const j = async (url, opts) => {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${url} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
};

// ── live build ──────────────────────────────────────────────────────────────
let ver;
try {
  ver = await j(`${HOST}/api/health/version`);
} catch (e) {
  console.error(`version unreachable — BLIND, this is a HOLD: ${e.message}`);
  process.exit(3);
}
console.log(`live commit ${ver.commitShort}  booted ${ver.startedAt}  uptime ${ver.uptimeSec}s\n`);

let gates;
try {
  gates = await j(`${HOST}/api/health/live-enforce-gates`);
} catch (e) {
  console.error(`live-enforce-gates unreachable — BLIND, this is a HOLD: ${e.message}`);
  process.exit(3);
}

// ── C1 — the arm survived the session ───────────────────────────────────────
const arm = gates.arm?.admissibleStrike;
if (!arm) {
  record('C1 arm', 'FAIL', 'arm.admissibleStrike ABSENT from the payload — the flag is not even reported');
} else if (arm.armed !== true) {
  record('C1 arm', 'FAIL', `arm.admissibleStrike.armed === ${JSON.stringify(arm.armed)} — a restart dropped the env`);
} else if (arm.band?.min !== BAND.min || arm.band?.max !== BAND.max) {
  record('C1 arm', 'FAIL', `band ${JSON.stringify(arm.band)} !== ${JSON.stringify(BAND)}`);
} else {
  record('C1 arm', 'PASS', `armed, band ${JSON.stringify(arm.band)}, boot ${ver.startedAt} (uptime ${ver.uptimeSec}s)`);
}

// ── the cost_bar gate — `byGate` IS AN ARRAY ────────────────────────────────
// Indexing it (`byGate.cost_bar`) yields `undefined`, which is byte-identical to
// the gate having recorded nothing. Find it, and assert it was FOUND before any
// zero off it is believed.
if (!Array.isArray(gates.byGate)) {
  console.error(`byGate is ${typeof gates.byGate}, not an array — the payload shape moved; BLIND`);
  process.exit(3);
}
const cb = gates.byGate.find((g) => g.gate === 'cost_bar');
if (!cb) {
  console.error(`no 'cost_bar' entry in byGate [${gates.byGate.map((g) => g.gate).join(', ')}] — BLIND`);
  process.exit(3);
}

const etDay = gates.etDay;
const lastDecisionAt = gates.lastDecisionAt ? new Date(gates.lastDecisionAt).toISOString() : 'never';
console.log(`\netDay ${etDay}  cost_bar evaluated ${cb.evaluated} blocked ${cb.blocked}  lastDecisionAt ${lastDecisionAt}`);
console.log(`decisionsRecorded ${gates.decisionsRecorded}  durability.ephemeral ${gates.durability?.ephemeral}\n`);

// The counters are TODAY's. The `retained` fold is a TRAILING WINDOW over days
// that predate the `cell`/`selection` axes entirely (1943 evaluated, byCell []),
// so it holds no positive control and must never be cited as a baseline for
// either axis. Grade the day counter or grade nothing.
const HAVE_VERDICTS = cb.evaluated > 0;

// ── LIVENESS — what a ZERO means, and why this payload cannot say ───────────
//
// ⛔ The first draft read `evaluated === 0` as "pre-open, NOT a failure" and
// stopped there. That is the same zero as two OTHER states, and at 14:15Z — 45
// minutes AFTER the open — the benign one is the least likely of the three:
//
//   (a) pre-open / no session          → benign, ungradeable
//   (b) session live, scanner returned no candidates on every name
//                                      → a REAL negative, and reportable
//   (c) session live, the scan never ran at all
//                                      → a DEFECT; grading it as (a) or (b) publishes a lie
//
// Nothing in `/api/health/live-enforce-gates` separates them. Verified against
// the LIVE bytes (c44a890) rather than the local fork:
//
//   `runOtmScan` (signal-engine.ts:9837) does
//       `if (result.reason !== 'ok' || result.candidates.length === 0) continue;`   (:9900)
//   BEFORE the nominator (:9920), before `recordLiveEnforceDecision` (:10294) and
//   before the universe gate (:10003). Every one of the seven gates in `byGate`
//   is recorded DOWNSTREAM of that `continue`, so a starve leaves no gate row, no
//   nomination line and no reason code — it is invisible on every axis this
//   payload publishes. A sibling gate is therefore NOT a usable control here.
//
// The OTM sleeve is also the only option path with no scan-run telemetry:
// `beginRvScan` is opened for 'rv_scan' (:8824) and 'directional' (:11233) and
// surfaces at /api/health/rv-scan as exactly the distinction wanted here — its
// own comment says a disarmed path must read "never ran" rather than "ran, found
// nothing". `runOtmScan` never calls it. That gap is CTO work and will not be
// deployed today, so today's grade adjudicates with what is observable now:
//
//   · marketOpen        — the server's OWN market clock (not my arithmetic)
//   · directional scans — a SIBLING path inside the same doTick. It cannot prove
//                         the OTM scan ran, but a non-zero proves the ENGINE
//                         ticked, which separates (c) from (b).
//   · tradier-chain lastFetchOkAt — the shared chain provider both paths fetch.
//
// FAIL-CLOSED: if either route is unreachable the liveness verdict is UNKNOWN and
// every zero below stays ungraded. An unreadable control must never resolve to
// the benign branch.
const softFetch = async (path) => {
  try { return await j(`${HOST}${path}`); } catch (e) { return { __err: e.message }; }
};
const [pipe, rvs] = await Promise.all([
  softFetch('/api/health/options-pipeline'),
  softFetch('/api/health/rv-scan'),
]);

const serverNow = new Date(gates.time ?? Date.now());
// RTH is 13:30–20:00Z (CLAUDE.md). Used only to place `now` in the session; the
// server's `marketOpen` is authoritative for whether it is open RIGHT NOW.
const openZ = new Date(`${etDay}T13:30:00Z`);
const closeZ = new Date(`${etDay}T20:00:00Z`);
const beforeOpen = serverNow < openZ;
const afterClose = serverNow >= closeZ;
const minsSinceOpen = Math.round((serverNow - openZ) / 60_000);

// `engines` is the DEMO set (`demoEngineCount === engines.length`) — the absence
// of a live-mode row here says nothing about live books. `marketOpen` is a
// market-wide fact, so reading it off a demo engine is sound; reading anything
// ELSE off this array is not.
const engines = Array.isArray(pipe?.engines) ? pipe.engines : [];
const openFlags = [...new Set(engines.map((e) => e.marketOpen))];
const marketOpen = openFlags.length === 1 ? openFlags[0] : null;
const blockedBy = [...new Set(engines.map((e) => e.blockedBy).filter(Boolean))];

const rvPaths = Array.isArray(rvs?.paths) ? rvs.paths : [];
const dirPath = rvPaths.find((p) => p.path === 'directional');
const siblingScans = dirPath?.scanCountSinceBoot ?? null;
const chainFetchOkAt = rvs?.dataSource?.lastFetchOkAt ?? null;
// `scanCountSinceBoot` is SINCE BOOT, not per ET day (TRA-2945). It only covers
// today's session while the process booted BEFORE the open; a mid-session restart
// resets it to 0 and would forge state (c) out of a perfectly healthy session.
const bootMs = Date.parse(ver.startedAt);
const bootBeforeOpen = Number.isFinite(bootMs) && bootMs < openZ.getTime();

console.log('LIVENESS');
console.log(`  server now ${serverNow.toISOString()}  (open ${openZ.toISOString()}, ${minsSinceOpen >= 0 ? `T+${minsSinceOpen}` : `T${minsSinceOpen}`} min)`);
console.log(`  marketOpen ${JSON.stringify(marketOpen)}${blockedBy.length ? `  blockedBy ${JSON.stringify(blockedBy)}` : ''}${pipe?.__err ? `  ⛔ options-pipeline: ${pipe.__err}` : ''}`);
console.log(`  sibling 'directional' scansSinceBoot ${JSON.stringify(siblingScans)}  lastScanAt ${JSON.stringify(dirPath?.lastScanAt ?? null)}  chain lastFetchOkAt ${JSON.stringify(chainFetchOkAt)}${rvs?.__err ? `  ⛔ rv-scan: ${rvs.__err}` : ''}`);
console.log(`  boot ${ver.startedAt} — ${bootBeforeOpen ? 'BEFORE the open, since-boot counters cover the session' : '⛔ AT/AFTER the open: since-boot counters were RESET mid-session, the sibling control is VOID'}`);
console.log(`  live universe (${gates.arm?.universe?.symbols?.length ?? '?'} names) ${JSON.stringify(gates.arm?.universe?.symbols ?? null)}  restricted ${gates.arm?.universe?.restricted}`);

const engineTicked = (siblingScans ?? 0) > 0 || Boolean(chainFetchOkAt);
const controlsReadable = !pipe?.__err && !rvs?.__err && marketOpen !== null;

// The adjudicated meaning of a cost_bar zero. Consumed by C2/C3/C4/C7 in place of
// the old bare `evaluated > 0`.
let ZERO_STATE;
if (HAVE_VERDICTS) ZERO_STATE = { kind: 'GRADEABLE', why: `cost_bar evaluated ${cb.evaluated} on ${etDay}` };
else if (!controlsReadable) ZERO_STATE = { kind: 'BLIND', why: `cost_bar evaluated 0 and the liveness controls are unreadable (marketOpen ${JSON.stringify(marketOpen)}${pipe?.__err ? `, pipeline ${pipe.__err}` : ''}${rvs?.__err ? `, rv-scan ${rvs.__err}` : ''}) — this zero CANNOT be attributed` };
else if (marketOpen === false && beforeOpen) ZERO_STATE = { kind: 'PRE-OPEN', why: `market not yet open (T${minsSinceOpen} min) — a zero here is expected and is NOT a negative` };
else if (marketOpen === false && !afterClose) ZERO_STATE = { kind: 'NO-SESSION', why: `it is T+${minsSinceOpen} min past the nominal open yet the server reports marketOpen=false${blockedBy.length ? ` (blockedBy ${blockedBy.join('/')})` : ''} — holiday/half-day/halt. Benign, but it means TODAY CANNOT GRADE THIS; do not re-arm anything on the strength of it` };
else if (!bootBeforeOpen) ZERO_STATE = { kind: 'BLIND', why: `the process booted ${ver.startedAt}, AT OR AFTER the open — since-boot scan counters were reset mid-session, so 'the engine never ticked' is unprovable. Re-read after the next clean session` };
else if (!engineTicked) ZERO_STATE = { kind: 'ENGINE-SILENT', why: `session ${afterClose ? 'has CLOSED' : `live (T+${minsSinceOpen} min)`} and NOTHING scanned: sibling 'directional' scansSinceBoot ${JSON.stringify(siblingScans)}, chain lastFetchOkAt ${JSON.stringify(chainFetchOkAt)}. The engine did not run — this is a DEFECT, not a nominator result, and must NOT be reported as 'the band was empty'` };
else ZERO_STATE = { kind: 'STARVED-UPSTREAM', why: `session ${afterClose ? 'closed' : `live (T+${minsSinceOpen} min)`}, the engine DID tick (directional scansSinceBoot ${siblingScans}, chain lastFetchOkAt ${JSON.stringify(chainFetchOkAt)}) yet cost_bar recorded nothing. Every gate sits downstream of signal-engine.ts:9900, so the candidates died at 'result.reason !== ok || candidates.length === 0' — UPSTREAM of the nominator. A REAL negative, attributable to the scanner, NOT to the band` };

console.log(`  ⇒ ZERO-STATE: ${ZERO_STATE.kind} — ${ZERO_STATE.why}\n`);
const GRADEABLE = ZERO_STATE.kind === 'GRADEABLE';

// How a non-gradeable zero scores. The three states are NOT interchangeable and
// none of them may quietly become "PASS".
const ZERO_VERDICT = {
  'PRE-OPEN': 'UNGRADEABLE',
  'NO-SESSION': 'UNGRADEABLE',
  BLIND: 'BLIND',
  'ENGINE-SILENT': 'DEFECT',
  'STARVED-UPSTREAM': 'REAL-NEGATIVE',
}[ZERO_STATE.kind] ?? 'BLIND';

// ── C2 — the nominator is biting ────────────────────────────────────────────
// It is a SELECTOR: it records NO gate verdict and can never appear in byGate's
// verdict axis. Its axis is `bySelection`, stamped ONLY on rows that carry a
// nominator. An empty `bySelection` with `evaluated > 0` is therefore NOT a
// defect on its own — a row written before the axis existed, or a non-OTM
// (RV / directional) row, simply lacks it.
const bySel = Object.fromEntries((cb.bySelection ?? []).map((s) => [s.selection ?? s.key, s]));
const selKeys = Object.keys(bySel);
if (!GRADEABLE) {
  record('C2 nominator', ZERO_VERDICT, `${ZERO_STATE.kind} — ${ZERO_STATE.why}`);
} else if (selKeys.length === 0) {
  record('C2 nominator', 'UNKNOWN', `evaluated ${cb.evaluated} but bySelection is EMPTY — no row carried a nominator; cross-read the log line before calling this either way`);
} else if (bySel.in_band) {
  record('C2 nominator', 'PASS', `selection in_band on ${bySel.in_band.evaluated ?? bySel.in_band.blocked} row(s) — the nominator reached the gate. full split ${JSON.stringify(selKeys)}`);
} else if (selKeys.length === 1 && selKeys[0] === 'fallback_top_mispricing') {
  record('C2 nominator', 'REAL-NEGATIVE', `only fallback_top_mispricing — the band was empty on every name in the universe. This is a genuine negative result, report it as one; it is NOT a bug`);
} else if (selKeys.length === 1 && selKeys[0] === 'legacy') {
  record('C2 nominator', 'FAIL', `only 'legacy' — the selector never ran, which CONTRADICTS C1's armed read. Instrument disagreement ⇒ escalate, do not publish either side`);
} else {
  record('C2 nominator', 'REVIEW', `selection split ${JSON.stringify(selKeys)} with no in_band row — read the per-selection counts by hand`);
}

// ── C3 — the gate verdict moved, under the admitted cell ────────────────────
const cells = Object.fromEntries((cb.byCell ?? []).map((c) => [c.cell, c]));
const otm = cells[CELL];
const reasons = Object.fromEntries((cb.byReason ?? []).map((r) => [r.reasonCode, r]));
if (!GRADEABLE) {
  record('C3 verdict', ZERO_VERDICT, `${ZERO_STATE.kind} — byCell [] is this zero, and it is ${ZERO_STATE.kind === 'PRE-OPEN' || ZERO_STATE.kind === 'NO-SESSION' ? 'benign' : 'NOT benign'}: ${ZERO_STATE.why}`);
} else if (otm) {
  const admits = (otm.evaluated ?? 0) - (otm.blocked ?? 0);
  record('C3 verdict', admits > 0 ? 'PASS' : 'REAL-NEGATIVE',
    `${CELL}: evaluated ${otm.evaluated}, blocked ${otm.blocked}, ADMITS ${admits}` +
    (admits > 0 ? ' — the nominator reached the gate AND cleared the bar' : ' — reached the gate, blocked at it; report which reason'));
} else {
  // byCell is stamped IFF `tape.cellKey` is non-null, and `cellKey` is null IFF
  // the candidate's |delta| was unusable (NaN/±Inf/|d|>1) — which declines under
  // `gross_unknown`. So an absent cell alongside a cell-BEARING reason code is
  // the stamp being lost, not the cell never being reached.
  const bearing = CELL_BEARING_REASONS.filter((r) => reasons[r]);
  if (bearing.length > 0) {
    record('C3 verdict', 'DEFECT', `byCell has no ${CELL} row, yet byReason carries ${bearing.join('/')} — those codes REQUIRE a |delta| bucket, so a cellKey existed and the ledger dropped it. Instrument defect; the grade is VOID, not a FAIL`);
  } else if (reasons[CELL_FREE_REASON]) {
    record('C3 verdict', 'REAL-NEGATIVE', `byCell empty and every decline is ${CELL_FREE_REASON} — the candidates had no usable |delta|. Consistent, and a genuine negative`);
  } else {
    record('C3 verdict', 'UNKNOWN', `evaluated ${cb.evaluated} but no ${CELL} row and no adjudicating reason code (byReason ${JSON.stringify(Object.keys(reasons))}) — do not score this`);
  }
}
if (GRADEABLE && (cb.byCell ?? []).length > 0) {
  console.log(`             cells seen: ${(cb.byCell ?? []).map((c) => `${c.cell}(${c.evaluated}/${c.blocked})`).join(', ')}`);
}

// ── the denominator, stated every time ──────────────────────────────────────
// `byReason[].share` is denominated on ALL blocked rows INCLUDING
// `blockedUnclassified`. The 08-12 "100% gross_negative" baseline was over the
// ATTRIBUTED books only. Quoting one against the other reports a collapse that
// never happened, so print both and never publish `share` alone.
const books = (cb.byBook ?? []).filter((b) => b.book && b.book !== 'unattributed');
const attributedBlocked = books.reduce((n, b) => n + (b.blocked ?? 0), 0);
console.log(`\nDENOMINATORS — blocked ${cb.blocked}, blockedUnclassified ${cb.blockedUnclassified ?? 0}, attributed-book blocked ${attributedBlocked}`);
console.log(`  byBook: ${(cb.byBook ?? []).map((b) => `${b.book} ${b.evaluated}/${b.blocked}`).join(' · ') || '(none)'}`);
console.log(`  byReason: ${(cb.byReason ?? []).map((r) => `${r.reasonCode} ${r.blocked} (share ${r.share} — of ALL blocked, unclassified included)`).join(' · ') || '(none)'}`);

// ── C4 — a fill, or an honest zero, per book ────────────────────────────────
// An order that never filled writes NO ledger row; a journal OPEN row is not a
// fill. The per-book axis that IS readable here is cost_bar admits: an admitted
// verdict is the NECESSARY PRECONDITION to a fill, so zero admits on a book is a
// sound honest zero, while non-zero admits demands the fill tape before anyone
// says "traded".
const WANT_BOOKS = ['admin', 'v0nni'];
if (!GRADEABLE) {
  record('C4 fills', ZERO_VERDICT, `no cost_bar verdict on any book today — a book cannot have filled under a gate that recorded nothing. ${ZERO_STATE.kind}: ${ZERO_STATE.why}`);
} else {
  const per = WANT_BOOKS.map((name) => {
    const b = books.find((x) => x.book === name);
    if (!b) return `${name}: NO ROW (the gate recorded no verdict for this book — UNKNOWN, not zero)`;
    return `${name}: evaluated ${b.evaluated}, blocked ${b.blocked}, admits ${(b.evaluated ?? 0) - (b.blocked ?? 0)}`;
  });
  const anyAdmit = WANT_BOOKS.some((name) => {
    const b = books.find((x) => x.book === name);
    return b && (b.evaluated ?? 0) - (b.blocked ?? 0) > 0;
  });
  record('C4 fills', anyAdmit ? 'REVIEW' : 'HONEST-ZERO',
    anyAdmit
      ? `${per.join(' | ')} — admits exist; GO TO THE FILL TAPE before reporting a trade`
      : `${per.join(' | ')} — zero admits, so zero fills is sound. Report which of C2/C3 produced it`);
}

// ── logs: C2's fallback discriminator and C7's over-cap skip ────────────────
//
// ⛔ `text=` IS NOT A PLAIN CONTIGUOUS SUBSTRING MATCH. Measured against this
// service on 2026-08-13: Render splits the query on COMMAS and ORs the pieces,
// each piece matched as a contiguous substring. Nothing else splits it.
//
//     text="live OTM bounded test: over cap, skipped"  → 20 hits, ALL of them
//                                     `tradier-reconcile skipped: no account…`
//     text="live OTM bounded test"                     →  0
//     text="zzz,skipped"                               → 20   ← comma ORs
//     text="zzz: skipped"                              →  0   ← colon does not
//     text="zzz skipped" / "zzz;skipped" / "zzz|skipped" → 0
//
// So a comma anywhere in the query manufactures FALSE POSITIVES off whichever
// clause happens to contain a common word — and the failure is silent and
// asymmetric: it inflates, it never zeroes. The first draft of this grader asked
// for the C7 line verbatim (it has a comma) and got 65 unrelated
// `tradier-reconcile skipped` lines, which would have published a FABRICATED
// "C7 OBSERVED" against a sizer that had not run.
//
// The usual three controls do NOT catch this — all three use comma-free strings
// and all three passed while the C7 read was garbage. Two defences instead:
//   (a) REFUSE to send a query containing a comma, and
//   (b) RE-VERIFY every returned line client-side with `.includes(query)`, so
//       the count is correct even if the server's semantics move again.
//
// `{"logs":null}` remains Render's encoding of ZERO MATCHES — and it is ALSO
// what a wrong `resource=` returns, so it carries no information until the
// controls below have adjudicated it.
if (!WANT_LOGS) {
  console.log('\n(logs skipped — no RENDER_API_KEY or --no-logs; C2 fallback + C7 not read)');
} else {
  const START = new Date(Date.parse(ver.startedAt) - 60_000).toISOString();
  const END = new Date().toISOString();
  // `allowComma` exists for CONTROL 4 alone, which must send a comma on purpose
  // to prove the OR is still there. No measurement may set it.
  const rawPull = async (text, limit = 100, allowComma = false) => {
    // (a) a comma turns the query into an OR — refuse rather than silently inflate.
    if (text !== null && !allowComma && text.includes(',')) {
      throw new Error(`text=${JSON.stringify(text)} contains a COMMA — Render ORs comma-separated clauses; pass the longest comma-free fragment instead`);
    }
    const u = new URL('https://api.render.com/v1/logs');
    u.searchParams.set('resource', SERVICE);
    u.searchParams.set('ownerId', OWNER);
    u.searchParams.set('startTime', START);
    u.searchParams.set('endTime', END);
    u.searchParams.set('limit', String(limit));
    if (text !== null) u.searchParams.set('text', text);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
    if (r.status === 429) throw new Error('429 rate limited — an aborted read is an UNDERCOUNT, not a zero');
    if (!r.ok) throw new Error(`logs ${r.status} ${(await r.text()).slice(0, 200)}`);
    const b = await r.json();
    return b.logs ?? [];
  };
  // (b) trust only lines that actually contain the query. `served` vs `verified`
  // diverging is itself the tell that the server-side filter is not doing what
  // the query says.
  const pull = async (text, limit = 100) => {
    const served = await rawPull(text, limit);
    if (text === null) return { served: served.length, verified: served.length, lines: served };
    const lines = served.filter((l) => typeof l.message === 'string' && l.message.includes(text));
    return { served: served.length, verified: lines.length, lines };
  };
  console.log(`\nlog window ${START} → ${END}`);
  try {
    const c1 = await pull(null, 5);
    console.log(`  CONTROL 1 (unfiltered)      : ${c1.verified} line(s) — reader ${c1.verified > 0 ? 'LIVE' : 'BLIND'}`);
    if (c1.verified === 0) throw new Error('reader returned 0 unfiltered — BLIND, this is a HOLD');
    // CONTROL 2 — the `text=` filter itself works. Any substring certain to be
    // present this boot; a filter that matches nothing on a known-present string
    // is a broken filter, and every zero below it would be a lie.
    const c2 = await pull('http', 5);
    console.log(`  CONTROL 2 (text= known hit) : ${c2.verified} line(s) — filter ${c2.verified > 0 ? 'WORKS' : 'BROKEN — every zero below is uninterpretable'}`);
    if (c2.verified === 0) throw new Error('text= filter matched a known-present substring 0 times — BLIND');
    // CONTROL 3 — a substring certain to be ABSENT, proving a zero is readable.
    const c3 = await pull('zzz-tra3417-never-emitted', 5);
    console.log(`  CONTROL 3 (text= known miss): ${c3.verified} line(s) — a zero is ${c3.verified === 0 ? 'READABLE' : 'NOT trustworthy (matched an impossible string)'}`);
    // CONTROL 4 — the comma-OR control the other three cannot see. A query whose
    // ONLY matching clause sits behind a comma must come back served>0 and
    // verified==0. If served==0 the semantics moved; if verified>0 the
    // client-side check is broken. Either way the log reads below are void.
    const c4 = await rawPull('zzz-tra3417-never-emitted,http', 5, true);
    const c4v = c4.filter((l) => (l.message ?? '').includes('zzz-tra3417-never-emitted')).length;
    console.log(`  CONTROL 4 (comma-OR)        : served ${c4.length}, verified ${c4v} — comma splitting ${c4.length > 0 && c4v === 0 ? 'CONFIRMED (and neutralised)' : 'NOT as measured — treat every log read below as VOID'}`);

    // ── C2b — the nominator's OWN evidence, SCORED ──────────────────────────
    //
    // Criterion 2 was pre-registered against THIS log line (`selection` and
    // `cheapInBand`), not against `bySelection`. The first draft printed the
    // lines and graded C2 off the ledger anyway, so the empty-`bySelection`
    // branch punted to "cross-read the log line by hand" — which is the exact
    // hand-read this grader exists to remove. Score it.
    //
    // The logger emits ONE JSON OBJECT PER LINE with the fields spread at top
    // level (observability/logger.ts:118 `JSON.stringify(record)`), so parse it
    // rather than regex it. A line that will not parse is NOT scored as absent —
    // it is counted and reported, because "unparseable" and "not emitted" are
    // different states and only one of them is a negative result.
    const nom = await pull('OTM strike nomination (TRA-3401)');
    console.log(`  nomination lines            : served ${nom.served}, verified ${nom.verified}`);
    for (const l of nom.lines.slice(0, 6)) console.log(`    ${(l.timestamp ?? '')} ${(l.message ?? '').slice(0, 260)}`);

    const parsed = [];
    let unparseable = 0;
    for (const l of nom.lines) {
      const m = typeof l.message === 'string' ? l.message.slice(l.message.indexOf('{')) : '';
      try {
        const r = JSON.parse(m);
        if (r && typeof r === 'object' && typeof r.selection === 'string') parsed.push(r);
        else unparseable += 1;
      } catch { unparseable += 1; }
    }
    const selCount = {};
    for (const r of parsed) selCount[r.selection] = (selCount[r.selection] ?? 0) + 1;
    const inBand = parsed.filter((r) => r.selection === 'in_band');
    const maxCheapInBand = parsed.reduce((n, r) => Math.max(n, Number(r.cheapInBand) || 0), 0);
    const symsSeen = [...new Set(parsed.map((r) => r.sym).filter(Boolean))];
    // `user` is stamped from the trace context, so the line carries the BOOK.
    const booksSeen = [...new Set(parsed.map((r) => r.user).filter(Boolean))];
    if (nom.verified > 0) {
      console.log(`    parsed ${parsed.length}/${nom.verified} (unparseable ${unparseable})  selections ${JSON.stringify(selCount)}  maxCheapInBand ${maxCheapInBand}`);
      console.log(`    symbols ${JSON.stringify(symsSeen)}  books ${JSON.stringify(booksSeen)}`);
    }

    if (nom.verified === 0) {
      // The line is emitted on BOTH nominator branches and suppressed only when
      // `selection === 'legacy'` (signal-engine.ts:9940) — i.e. only when the
      // selector is disarmed. C1 says it is ARMED, so zero lines cannot mean
      // "armed but quiet": it means no symbol ever reached the nominator, which
      // is the :9900 starve. Attribute it to the SCANNER, never to the band.
      record('C2b nomination log', ZERO_STATE.kind === 'PRE-OPEN' || ZERO_STATE.kind === 'NO-SESSION' ? 'UNGRADEABLE' : ZERO_VERDICT,
        `ZERO nomination lines this boot while C1 reads ARMED. The line is suppressed only for selection==='legacy' (disarmed), so this is not a quiet nominator — no candidate ever reached it. ${ZERO_STATE.kind}: ${ZERO_STATE.why}`);
    } else if (parsed.length === 0) {
      record('C2b nomination log', 'BLIND',
        `${nom.verified} nomination line(s) but NONE parsed as JSON — the log shape moved; the selection axis is unreadable, do not score C2 either way`);
    } else if (inBand.length > 0) {
      record('C2b nomination log', 'PASS',
        `selection 'in_band' on ${inBand.length}/${parsed.length} nomination(s), maxCheapInBand ${maxCheapInBand}, symbols ${JSON.stringify([...new Set(inBand.map((r) => r.sym))])} — THE NOMINATOR BIT${unparseable ? ` (⚠ ${unparseable} line(s) unparseable, count is a FLOOR)` : ''}`);
    } else if (Object.keys(selCount).length === 1 && selCount.fallback_top_mispricing) {
      record('C2b nomination log', 'REAL-NEGATIVE',
        `${parsed.length} nomination(s), ALL 'fallback_top_mispricing', maxCheapInBand ${maxCheapInBand} across ${symsSeen.length} symbol(s) ${JSON.stringify(symsSeen)} — the scanner DID produce candidates and NONE fell in [0.50,0.55). A genuine empty-band negative, denominated on the symbols that actually produced a chain, NOT on the ${gates.arm?.universe?.symbols?.length ?? '?'}-name universe`);
    } else {
      record('C2b nomination log', 'REVIEW',
        `selection split ${JSON.stringify(selCount)} with no in_band — read by hand`);
    }

    // C7 — at $150/1 contract the bounded-test sizer SKIPS names whose premium
    // is over cap, so those names never reach the expected path at all. Grade
    // C7 off THESE LINES, never off the absence of fills.
    //
    // Comma-free fragments only (see the header). The per-book cap and the
    // TRA-3445 AGGREGATE cap are DIFFERENT skips and must not be pooled: the
    // per-book fragment is not a substring of the aggregate line ("over
    // AGGREGATE cap"), so they separate cleanly.
    const OUTCOME_LINES = [
      ['over cap (per-book)', 'live OTM bounded test: over cap'],
      ['over AGGREGATE cap ', 'live OTM bounded test: over AGGREGATE cap'],
      ['no ask             ', 'live OTM bounded test: no ask'],
      ['no balance snapshot', 'live OTM bounded test: no balance snapshot'],
      ['paper open null    ', 'live OTM bounded test: paper open null'],
    ];
    const outcomes = {};
    for (const [label, frag] of OUTCOME_LINES) {
      const hit = await pull(frag);
      outcomes[label.trim()] = hit.verified;
      console.log(`  ${label}        : served ${hit.served}, verified ${hit.verified}`);
      for (const l of hit.lines.slice(0, 3)) console.log(`    ${(l.timestamp ?? '')} ${(l.message ?? '').slice(0, 260)}`);
    }

    if (!GRADEABLE) {
      record('C7 over-cap', ZERO_VERDICT, `the sizer recorded no gate verdict — ${ZERO_STATE.kind}: ${ZERO_STATE.why}`);
    } else {
      const capN = outcomes['over cap (per-book)'] + outcomes['over AGGREGATE cap'];
      record('C7 over-cap', capN > 0 ? 'OBSERVED' : 'NOT-OBSERVED',
        `per-book ${outcomes['over cap (per-book)']} · aggregate ${outcomes['over AGGREGATE cap']} skip line(s) — a skipped name is NOT a gate block and must not be scored as one`);
    }
  } catch (e) {
    record('logs', 'BLIND', e.message);
  }
}

// ── disposition ─────────────────────────────────────────────────────────────
console.log('\n──────── DISPOSITION ────────');
for (const r of results) console.log(`  ${r.verdict.padEnd(13)} ${r.id}`);
const anyFail = results.some((r) => r.verdict === 'FAIL' || r.verdict === 'DEFECT');
const anyUngradeable = results.some((r) => ['UNGRADEABLE', 'UNKNOWN', 'BLIND', 'REVIEW'].includes(r.verdict));
// ⛔ REAL-NEGATIVE and HONEST-ZERO used to fall through to exit 0 — so "the band
// was empty on every name all session" would have printed `⇒ PASS` and exited
// GREEN. A negative result is not a pass. It gets its own code so the wake that
// reads this can tell "the nominator traded" from "the nominator correctly did
// nothing", which is precisely the distinction criterion 4 was written to force
// ("do NOT report 'armed' as if it were 'traded'").
const anyNegative = results.some((r) => ['REAL-NEGATIVE', 'HONEST-ZERO', 'NOT-OBSERVED'].includes(r.verdict));
if (anyFail) {
  console.log('  ⇒ FAIL — a criterion produced a negative or the instrument is defective.');
  process.exit(2);
}
if (anyUngradeable) {
  console.log('  ⇒ UNGRADEABLE — fail-closed. Do NOT publish this as a pass or a fail.');
  process.exit(3);
}
if (anyNegative) {
  console.log('  ⇒ REAL NEGATIVE — the instruments worked and the answer is NO TRADE.');
  console.log('    Report it as a negative result with its attribution. This is NOT a pass');
  console.log('    and NOT a defect; do not re-arm or re-grade on the strength of it.');
  process.exit(4);
}
console.log('  ⇒ PASS');
process.exit(0);
