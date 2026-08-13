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
// ── The three reads that are NOT interchangeable ────────────────────────────
//
// 1. `evaluated === 0`  ⇒ UNGRADEABLE. No scan has recorded a cost_bar verdict
//    on this ET day. This is the PRE-OPEN state and it is NOT a failure.
// 2. `evaluated > 0` and the OTM cell is present ⇒ GRADEABLE.
// 3. `evaluated > 0` and the OTM cell is ABSENT ⇒ adjudicate with `byReason`,
//    never on the absence alone. See C3 below.
//
// ── Exit codes ──────────────────────────────────────────────────────────────
//   0  every gradeable criterion PASSED
//   2  a criterion FAILED (a real negative result, reportable as such)
//   3  UNGRADEABLE / BLIND — pre-open, no scans, or an instrument that cannot
//      see. FAIL-CLOSED: this is never collapsed into 0 or 2.
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
const GRADEABLE = cb.evaluated > 0;

// ── C2 — the nominator is biting ────────────────────────────────────────────
// It is a SELECTOR: it records NO gate verdict and can never appear in byGate's
// verdict axis. Its axis is `bySelection`, stamped ONLY on rows that carry a
// nominator. An empty `bySelection` with `evaluated > 0` is therefore NOT a
// defect on its own — a row written before the axis existed, or a non-OTM
// (RV / directional) row, simply lacks it.
const bySel = Object.fromEntries((cb.bySelection ?? []).map((s) => [s.selection ?? s.key, s]));
const selKeys = Object.keys(bySel);
if (!GRADEABLE) {
  record('C2 nominator', 'UNGRADEABLE', `cost_bar evaluated 0 on ${etDay} — no scan has run; pre-open, NOT a negative`);
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
  record('C3 verdict', 'UNGRADEABLE', `cost_bar evaluated 0 on ${etDay} — nothing to grade; byCell [] here is the PRE-OPEN zero, not a FAIL`);
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
  record('C4 fills', 'UNGRADEABLE', 'no cost_bar verdicts today — a book cannot have filled under a gate that never ran');
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

    const nom = await pull('OTM strike nomination (TRA-3401)');
    console.log(`  nomination lines            : served ${nom.served}, verified ${nom.verified}`);
    for (const l of nom.lines.slice(0, 6)) console.log(`    ${(l.timestamp ?? '')} ${(l.message ?? '').slice(0, 260)}`);

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
      record('C7 over-cap', 'UNGRADEABLE', 'pre-open — the sizer has not run');
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
if (anyFail) {
  console.log('  ⇒ FAIL — a criterion produced a negative or the instrument is defective.');
  process.exit(2);
}
if (anyUngradeable) {
  console.log('  ⇒ UNGRADEABLE — fail-closed. Do NOT publish this as a pass or a fail.');
  process.exit(3);
}
console.log('  ⇒ PASS');
process.exit(0);
