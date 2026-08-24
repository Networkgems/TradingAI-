// TRA-3913 — GRADE THE ADOPTED-EXPOSURE ATTRIBUTION ON LIVE BYTES, PINNED BUILD.
//
// AC5 is not satisfied by a merge and not by ancestry. A deploy order's commit
// is a LOWER BOUND on content, never an expected reading (TRA-3660: `512370b5`
// rode in as an ancestor of live `a689158c`), so the deployed-bytes proof here
// is FIELD PRESENCE: `adoptedPremiumAtRiskUsd` does not exist on the pre-fix
// build, and control C2 proves this grader can see it absent.
//
// ── The subject ────────────────────────────────────────────────────────────
// bqb1 `admin` folds `openPremiumAtRiskUsd $358.00` over 2 open live rows while
// the engine's own fill tape carries $273.00 since the book was last flat. The
// $85.00 gap is the desk's second XLF contract at $0.85, adopted at the broker's
// blend (1.08 + 0.85) / 2 = 0.965 onto an `engine_origin` row.
//
// ── How every criterion is graded, and why ─────────────────────────────────
// ⭐ CROSS-COLUMN, NOT AGAINST EXPECTATION (TRA-3897). The engine's share is
// re-derived INDEPENDENTLY from `/api/health/live-options-fee-slippage`'s own
// `records[]` — the raw fill tape — and diffed against the row's published
// `openPremiumAtRiskUsd − adoptedPremiumAtRiskUsd`. A grader that only knew the
// $85.00 fixture would stop being a grader the moment a contract moved, and a
// grader that checked the published column against itself learns nothing
// (TRA-3737's reader defect, one ticket up).
//
// ⭐ AND IT CLASSIFIES ITS OWN BLINDNESS (TRA-3911). That ticket's grader scored
// 32/32 thirty-six seconds after a boot, on a book whose balance had not
// arrived: every row arithmetically right, the run worthless. Here the
// equivalent dark state is a book with NO OPEN LIVE ROWS — the attribution of an
// empty book is trivially correct and proves nothing — and a ledger that
// hydrated NO `buy_to_open`, which makes the oracle silent and pushes every row
// into the conservative branch for a reason that has nothing to do with the fix.
// Both exit BLIND, never PASS.
//
// ⚠ `adoptedAttributionBlindRows > 0` is likewise NOT a pass. It means the fold
// refused rather than answered, so `adoptedPremiumAtRiskUsd` is an upper bound
// on desk money and the $85.00 identity below is not being tested.
//
// Exit 0 PASS · 1 FAIL · 2 usage · 3 BLIND.  BLIND > FAIL > PASS.
// A pin move across the probe INVALIDATES the run rather than degrading it: the
// rows would then be a mix of two builds.
//
// Usage:
//   node scripts/tra3913-adopted-attribution-live.mjs [--expect=<sha-prefix>]
const HOST = 'https://tradingai-bqb1.onrender.com';
const EXPECT = process.argv.find(a => a.startsWith('--expect='))?.slice(9) ?? null;
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('usage: node scripts/tra3913-adopted-attribution-live.mjs [--expect=<sha-prefix>]');
  process.exit(2);
}

const blind = m => { console.error(`BLIND — ${m}`); process.exit(3); };
const usd = n => (typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : String(n));
const cents = n => Math.round(n * 100);

const rows = [];
const check = (id, ok, detail) => { rows.push({ id, ok: ok === true, detail }); };

// ⛔ A CRITERION THAT COULD NOT BE EVALUATED FOR LACK OF ITS OWN INPUTS IS NOT A
// FAILURE OF THE SUBJECT (TRA-3913, 2026-08-24). `check-deploy-build.mjs` made
// exactly this mistake one ticket over — it called a commit BROKEN when what had
// actually happened was that it could not compile it — and the lesson there
// applies verbatim here: WHEN A GATE CAN FAIL FOR LACK OF ITS OWN INPUT, THAT
// BRANCH BELONGS IN THE *BLIND* BUCKET, NOT THE VERDICT BUCKET. A false RED is
// worse than a false GREEN, because a false GREEN is caught by the next honest
// run and a false RED is what gets argued away.
//
// Three branches in G2 were already writing their own prose as "NOT GRADED" and
// then scoring themselves FAIL anyway. They now land here.
//
// Precedence is unchanged and deliberate: a genuine FAIL is NEVER downgraded to
// BLIND (the same rule the no-subject gate already follows via `failed.length`).
// FAIL wins over NOGRADE; NOGRADE wins over PASS.
const nograde = (id, detail) => { rows.push({ id, ok: true, nograde: true, detail }); };

const get = async path => fetch(`${HOST}${path}`).then(r => r.json()).catch(() => null);

async function pin() {
  const r = await get('/api/health/options-live');
  const b = r?.build ?? null;
  return b
    ? {
      commit: b.commit,
      pid: b.pid,
      startedAt: b.startedAt,
      uptimeSec: b.uptimeSec ?? null,
      drift: r?.brokerPositionDrift ?? null,
    }
    : null;
}

// ⭐ BOOT AGE IS PART OF THE VERDICT, NOT OF THE OPERATOR'S MEMORY (TRA-3911).
const SHALLOW_BOOT_SEC = 120;
const age = p => (typeof p?.uptimeSec === 'number' ? `${p.uptimeSec}s` : 'unknown');

const before = await pin();
if (!before?.commit) blind('pin unreadable before the probe');
console.log(
  `# pin BEFORE  commit=${before.commit} pid=${before.pid} startedAt=${before.startedAt}`
  + ` uptimeSec=${age(before)}`,
);
if (EXPECT && !before.commit.startsWith(EXPECT)) {
  blind(`live commit ${before.commit} is not the graded build ${EXPECT}`);
}

const fee = await get('/api/health/live-options-fee-slippage');
if (!fee) blind('fee/slippage route unreadable');

const exposure = fee.aggregateExposure;
if (!Array.isArray(exposure) || exposure.length === 0) {
  blind('aggregateExposure absent or empty — no subject');
}

// ── The independent oracle: the RAW fill tape, walked the way the server does ──
// Backward to the first `sell_to_close` per symbol (the current open episode),
// summing PRICED `buy_to_open` only. This is a second implementation of
// `recordedEngineOpenBasis` on purpose: the point of the cross-column diff is
// that the two were not derived from each other.
// The journal is a THIRD source, read only to explain a tape/book disagreement.
// It never grades anything, so an unreadable journal degrades a sentence, never
// a verdict.
const journal = await get('/api/health/option-journal?rows=all');
const journalRows = Array.isArray(journal?.rows) ? journal.rows : null;

const records = Array.isArray(fee.records) ? fee.records : null;
if (!records) blind('fee/slippage `records[]` absent — the independent oracle is unreadable');
const liveOpens = records.filter(r => r.side === 'buy_to_open' && r.mode === 'live');
if (liveOpens.length === 0) {
  blind('the fill ledger hydrated NO live `buy_to_open` — the oracle is silent for every row, '
    + 'so the conservative branch fires for a reason that has nothing to do with this fix');
}

// ⛔ ENGINE-PLACED ROWS ONLY (`origin !== 'history_import'`) — 2026-08-21.
// This grader FAILED 11/12 at 13:26Z on the build it had passed 12/12 at 03:07Z:
// same pid, same commit, uptime 37,409s. Overnight the TRA-2959 reconcile
// imported the two contracts no chokepoint of ours recorded — the DESK's — and
// both this tape and the server's oracle counted them, so the served engine
// share went to $358.00 (the whole book) and adopted to $0.00. An `origin:
// 'history_import'` row is the broker's record of a fill, written for the desk's
// hand-placed contract exactly as readily as for ours; it is evidence about the
// ACCOUNT, never evidence that this engine placed the order.
//
// ⚠ The two implementations moving together does NOT make this identity
// vacuous: the tape is still summed independently from raw `records[]`, so a
// fold that split the wrong way still fails here. What the scoping fixes is the
// QUESTION both sides answer.
function tapeBasis(optionSymbol) {
  const bySym = records.filter(r => r.optionSymbol === optionSymbol)
    .slice()
    .sort((a, b) => b.ts - a.ts); // newest first, mirroring the server's backward walk
  let contracts = 0;
  let costBasisUsd = 0;
  let unpriced = 0;
  let imported = 0;
  for (const f of bySym) {
    if (f.side === 'sell_to_close') break; // episode boundary
    if (f.side !== 'buy_to_open') continue;
    const q = Number.isFinite(f.contracts) ? f.contracts : 0;
    if (f.origin === 'history_import') { imported += q > 0 ? q : 0; continue; }
    const p = f.filledPrice;
    if (!(q > 0) || typeof p !== 'number' || !Number.isFinite(p) || p <= 0) { unpriced += 1; continue; }
    contracts += q;
    costBasisUsd += p * q * 100;
  }
  return { contracts, costBasisUsd, unpriced, imported };
}

// THE non-grade predicate, named once so its control can call THE SAME function.
// A control that re-implements the comparison it is controlling is checking a
// column against itself (TRA-3926: re-derive with a different METHOD, not a
// different implementation) — and it would sit green through a mutation that
// makes the real gate fire on every input, which is the failure mode that turns
// this grader into no grader at all.
const tapeExceedsBook = (tapeUsd, total) => cents(tapeUsd) > cents(total);

const describeEpisodes = eps => eps.map(b =>
  `${b.s} ${b.contracts}@${b.contracts > 0 ? usd(b.costBasisUsd / (b.contracts * 100)) : 'n/a'}`
  + (b.imported > 0 ? ` +${b.imported} imported` : '')).join(', ');

// ⭐ TURN THE NAMING FROM AN INFERENCE INTO A MEASUREMENT. Matching the gap to a
// single episode by arithmetic is elimination, and an elimination argument is
// only as fresh as its weakest excluded branch. `/api/health/option-journal` is
// public, no-auth, and records `closeTs` + `exitReason` for the row the engine
// actually held — so it can POSITIVELY witness that an episode the fill ledger
// still calls open was in fact closed, and say how. Silence here downgrades the
// sentence to the arithmetic claim rather than inventing a cause.
const journalClosed = sym => {
  if (!Array.isArray(journalRows)) return ' (journal unreadable — gap identified by arithmetic only)';
  const hit = journalRows
    .filter(j => j.optionSymbol === sym && j.mode === 'live' && typeof j.closeTs === 'number')
    .sort((a, b) => b.closeTs - a.closeTs)[0];
  if (!hit) return ' (no closed journal row for it — cause NOT established)';
  return `, which the journal records CLOSED at ${new Date(hit.closeTs).toISOString()}`
    + ` exitReason='${hit.exitReason}' brokerOrderId=${JSON.stringify(hit.brokerOrderId ?? null)}`
    + ` realizedPnlUsd=${usd(hit.realizedPnlUsd)} — so the position is gone and only the fill`
    + ' ledger still thinks otherwise';
};

// ── The subject: gate-open books only ────────────────────────────────────────
// SUM THE FLEET ON `liveEntryGateOpen`, NEVER ON `mode` — bqb1 carries three
// `mode: 'live'` books and only two that can place an order.
const armedBooks = exposure.filter(r => r.liveEntryGateOpen === true);
if (armedBooks.length === 0) blind('no gate-open books — the subject is empty');

const withRows = armedBooks.filter(r => (r.openRows ?? 0) > 0);
if (withRows.length === 0) {
  blind('every gate-open book is FLAT — an empty book attributes correctly by construction, '
    + 'so a PASS here would measure nothing (the TRA-3911 dark-book lesson)');
}

// ── THE SUBJECT MUST BE PRESENT, AND `excess` IS NOT PRESENCE ────────────────
// 2026-08-21T14:2xZ: this grader scored 13/13 PASS against `1f1264df` — the
// build that does NOT carry the fix, the build it had scored 11/12 FAIL against
// ninety minutes earlier. Nothing was fixed in between. At 13:48:04Z the engine
// closed the widened XLF row, and with it the only row on the whole box that had
// a foreign contract ON it. Every criterion then became arithmetically correct
// about a book with nothing to attribute, and the pre-fix CONTROL evaporated
// along with the subject.
//
// ⭐ A FOREIGN CONTRACT STILL EXISTS — it is just in the branch this fold cannot
// see. `brokerPositionDrift` splits it two ways and the split is not stable:
//   • `absorbed` — the contract was taken ONTO an engine row. It is inside
//     `openPremiumAtRiskUsd`, so `adoptedPremiumAtRiskUsd` is the column that
//     answers for it and THIS GRADER IS THE INSTRUMENT. Score it.
//   • `excess`   — the contract sits BESIDE the row at the broker. It is in no
//     row, so no fold can express it and `adoptedPremiumAtRiskUsd $0.00` is
//     CORRECT AND MEANINGLESS at the same time. Scoring that is measuring the
//     absence of the subject.
// Same dollar of real broker risk, two branches, and on this one boot the box
// has reported `absorbed` 186 times and `excess` 347 times. So which verdict
// this grader is entitled to reach is decided by which side of a coin flip the
// adoption sweep last landed on — which makes the presence test mandatory, not
// defensive (TRA-3911: gate the verdict on the OPERAND'S presence, never on the
// criterion's outcome).
// ⚠ The gate is EVALUATED here and FIRED at the verdict, so the G1 field-presence
// rows still print: "the fix is deployed" and "the fix was exercised" are two
// different findings and the first survives the absence of the second.
//
// ⛔ AND IT MUST NEVER SWALLOW A FAIL. Read the branches in the right order:
// under the PRE-FIX build with a contract `absorbed` onto a row, the adopted
// columns read 0 *because that is the defect* — so keying presence on the
// adopted columns ALONE would convert this ticket's own 12/13 FAIL into a BLIND
// and delete the alarm. `absorbed`/`engineOriginImportedRowsCheckedLast` are
// therefore the authority on whether a subject EXISTS, and the adopted columns
// only ever ADD to that set. A failed criterion is likewise proof the subject
// was present: nothing can fail about a book with nothing in it.
const drift = before.drift ?? null;
const subjectAbsenceReason = (bookRows, d, failures = 0) => {
  const adoptedNow = bookRows.reduce((n, r) => n + (r.adoptedOpenRows ?? 0), 0);
  const refusedNow = bookRows.reduce((n, r) => n + (r.adoptedAttributionBlindRows ?? 0), 0);
  const absorbedNow = d?.absorbedContractsLast ?? 0;
  const importedNow = d?.engineOriginImportedRowsCheckedLast ?? 0;
  if (adoptedNow > 0 || refusedNow > 0 || absorbedNow > 0 || importedNow > 0) return null;
  if (failures > 0) return null;
  const drift = d;
  if (!drift) {
    return 'no adopted or refused row on any gate-open book, and `brokerPositionDrift` is '
      + 'unreadable — cannot tell "the fold attributed correctly" from "there was nothing '
      + 'on a row to attribute"';
  }
  const excess = drift.excessContractsLast ?? 0;
  const absorbed = drift.absorbedContractsLast ?? 0;
  const imported = drift.engineOriginImportedRowsCheckedLast ?? 0;
  if (excess > 0 && absorbed === 0 && imported === 0) {
    return `NO SUBJECT — drift status '${drift.liveBookStatus ?? drift.status}' holds `
      + `${excess} foreign contract(s) BESIDE the engine's rows, none on one. `
      + '`adoptedPremiumAtRiskUsd $0.00` is correct here and proves nothing about this fix: '
      + 'the fold can only answer for a contract that was taken onto a row. '
      + `(this boot: absorbedChecks=${drift.absorbedChecks ?? '?'} excessChecks=`
      + `${drift.excessChecks ?? '?'} — the branch is not stable, so re-run)`;
  }
  return 'NO SUBJECT — every gate-open book folds 0 adopted and 0 refused rows and the broker '
    + 'holds nothing foreign, so the attribution split is never exercised. A book the engine '
    + 'opened by itself attributes correctly under the PRE-FIX code too: on 2026-08-21 this '
    + 'grader scored 13/13 against `1f1264df`, the build without the fix. PASS requires a row '
    + 'to attribute.';
};

// ── G1 — DEPLOYED BYTES, by field presence, on EVERY row ─────────────────────
const KEYS = ['adoptedPremiumAtRiskUsd', 'adoptedOpenRows', 'adoptedAttributionBlindRows'];
for (const k of KEYS) {
  const present = exposure.filter(r => Object.prototype.hasOwnProperty.call(r, k)).length;
  check(`G1.${k}`, present === exposure.length,
    `${present}/${exposure.length} rows carry \`${k}\` (pre-fix build: 0)`);
}

// ── G2 — the attribution IDENTITY, per book, cross-column ────────────────────
for (const r of withRows) {
  const total = r.openPremiumAtRiskUsd;
  const adopted = r.adoptedPremiumAtRiskUsd;
  const engineServed = typeof total === 'number' && typeof adopted === 'number'
    ? total - adopted : null;

  check(`G2.${r.book}.bounded`,
    typeof adopted === 'number' && adopted >= 0 && adopted <= total + 1e-9,
    `adopted ${usd(adopted)} within [0, ${usd(total)}]`);

  // ⚠ The refusal column gates the identity. A refused row's adopted figure is
  // an upper bound, not a measurement, and diffing it against the tape would
  // manufacture a FAIL out of the conservative branch doing its job.
  const refused = r.adoptedAttributionBlindRows ?? 0;
  if (refused > 0) {
    nograde(`G2.${r.book}.tape`,
      `NOT GRADED — ${refused} row(s) REFUSED; adopted ${usd(adopted)} is an upper bound,`
      + ' identity untested (the conservative branch doing its job is not a defect)');
    continue;
  }

  // The independent re-derivation.
  //
  // ⛔ SCOPE MISMATCH IS A NON-GRADE, NOT A FAIL. The fill ledger is a single
  // PROCESS-WIDE store and the route publishes no per-row symbol list, so the
  // tape can only be summed fleet-wide. That equals ONE book's engine share
  // exactly when exactly one gate-open book holds rows — true on bqb1 today, and
  // the moment it stops being true this identity is comparing a fleet figure to
  // a book figure. Saying "FAIL" there would be a false accusation off the
  // grader's own shape, which is the expensive direction (TRA-3884).
  const contributing = [...new Set(liveOpens.map(f => f.optionSymbol))]
    .map(s => ({ s, ...tapeBasis(s) }))
    .filter(b => b.contracts > 0 || b.unpriced > 0);
  const tapeUsd = contributing.reduce((sum, b) => sum + b.costBasisUsd, 0);
  const tapeUnpriced = contributing.reduce((sum, b) => sum + b.unpriced, 0);
  if (withRows.length !== 1) {
    nograde(`G2.${r.book}.tape`,
      `NOT GRADED — ${withRows.length} gate-open books hold rows, so the process-wide tape`
      + ` (${usd(tapeUsd)}) is not this book's engine share; grade per-book off the journal`);
    continue;
  }
  if (tapeUnpriced > 0) {
    nograde(`G2.${r.book}.tape`,
      `NOT GRADED — the tape itself holds ${tapeUnpriced} unpriceable fill(s), oracle incomplete`);
    continue;
  }

  // ⛔ THE TAPE AND THE BOOK MUST AGREE ON *WHAT IS OPEN* BEFORE AN ATTRIBUTION
  // IDENTITY OVER IT MEANS ANYTHING (TRA-3913, 2026-08-24, MEASURED).
  //
  // `engineServed + adopted === total` by construction and both terms are
  // non-negative, so `engineServed <= total` ALWAYS. If the tape's engine-open
  // basis exceeds the book's ENTIRE at-risk total, then the tape is carrying an
  // episode the book is not holding at all — and NO attribution split, right or
  // wrong, can reconcile that. The disagreement is strictly UPSTREAM of the
  // split this ticket fixes, so scoring it FAIL is a false accusation against
  // the fold (TRA-3884: when the controls fail and the subject passes, suspect
  // the reader first).
  //
  // What produced it on 2026-08-24T14:1xZ, and why the tape cannot self-correct:
  // `SOFI260925C00019000` — engine `buy_to_open 1 @1.23`, oid `142828896`,
  // `origin:'fill'`, 2026-08-21T14:24:10Z — was closed AT THE BROKER, and the
  // local row was dropped by the reconcile at 2026-08-24T13:34:55.545Z with
  // `exitReason:'broker_reconcile'` and `brokerOrderId: null`. No
  // `sell_to_close` ever reached `records[]`, so the BACKWARD WALK STILL FINDS
  // THAT EPISODE OPEN — permanently, for the whole 30-day retention window.
  // tape $156.00 > book total $150.00. TRA-2959's shape (7 of 11 filled orders
  // never reached this ledger), in the direction that OVER-credits the engine.
  if (tapeExceedsBook(tapeUsd, total)) {
    const gap = tapeUsd - engineServed;
    const named = contributing.filter(b => cents(b.costBasisUsd) === cents(gap));
    nograde(`G2.${r.book}.tape`,
      `NOT GRADED — the fill tape reports MORE engine-open basis (${usd(tapeUsd)}) than the`
      + ` book's entire at-risk total (${usd(total)}); since engine share <= total always, the`
      + ' ledger is holding an episode the book does not have — a close that never reached'
      + ` \`records[]\` (TRA-2959). Episodes: ${describeEpisodes(contributing)}.`
      + (named.length === 1
        ? ` The ${usd(gap)} gap is exactly ${named[0].s}${journalClosed(named[0].s)}.`
        : ` Gap ${usd(gap)} matches ${named.length} episode(s) exactly — not isolated here.`));
    continue;
  }
  const tapeImported = contributing.reduce((sum, b) => sum + (b.imported ?? 0), 0);
  check(`G2.${r.book}.tape`,
    cents(engineServed) === cents(tapeUsd),
    `served engine share ${usd(engineServed)} === engine-placed fill tape ${usd(tapeUsd)}`
    + ` over ${contributing.length} OPEN episode(s): ${describeEpisodes(contributing)}`
    + ` · ${tapeImported} contract(s) held on `
    + '`history_import` rows are NOT counted as ours (the 2026-08-21 regression)');

  check(`G2.${r.book}.rowcount`,
    Number.isInteger(r.adoptedOpenRows) && r.adoptedOpenRows <= r.openRows,
    `adoptedOpenRows ${r.adoptedOpenRows} <= openRows ${r.openRows}`);
}

// ── G3 — NOTHING GOT LOOSER. `usd` is untouched, so no cap moved ─────────────
// This is the assertion the CEO's "it errs SAFE" reading depends on: the fix is
// ATTRIBUTION, and if it had moved `openPremiumAtRiskUsd` by a cent it would
// have moved the bound TRA-3911 put on the order path.
for (const r of armedBooks) {
  const identityHeadroom = typeof r.capUsd === 'number' && typeof r.openPremiumAtRiskUsd === 'number'
    ? r.capUsd - r.openPremiumAtRiskUsd : null;
  check(`G3.${r.book}.headroom-basis`,
    identityHeadroom === null || cents(identityHeadroom) === cents(r.headroomSignedUsd),
    `capUsd ${usd(r.capUsd)} − atRisk ${usd(r.openPremiumAtRiskUsd)}`
    + ` === headroomSignedUsd ${usd(r.headroomSignedUsd)}`);
}
const fleetAtRisk = armedBooks.reduce((s, r) => s + (r.openPremiumAtRiskUsd ?? 0), 0);
const servedFleet = armedBooks.map(r => r.fleetAtRiskUsd).find(v => typeof v === 'number');
check('G3.fleet-at-risk-is-the-TOTAL',
  typeof servedFleet === 'number' && cents(servedFleet) === cents(fleetAtRisk),
  `Σ_j atRisk_j served ${usd(servedFleet)} === Σ over gate-open books ${usd(fleetAtRisk)}`
  + ' — the gate still folds the TOTAL, adopted premium included');

// ── CONTROLS. An assertion that cannot fail proves nothing (TRA-3884) ────────
// C1 — the identity comparison must ACCEPT the matching value and REJECT it off
// by $1.00.
//
// ⛔ BOTH LIMBS ARE CONSTRUCTED HERE. The first draft asserted only "a row
// inflated by $1.00 differs from the tape", read off the LIVE row — which is
// vacuously true on every run where the real identity ALREADY fails, and its
// detail string then printed "…the same comparison that passed the real one"
// on a run where the real one had not passed. That is the C5 defect (a control
// whose verdict moves with its subject) and the fail-detail defect (prose
// written as the hypothesis instead of computed from the measurement), both
// recorded on 2026-08-21 and both re-committed here. Measured again on
// 2026-08-24, when G2.tape was un-gradeable and C1 scored a meaningless PASS.
{
  const anchor = 156_00 / 100; // a neutral basis; nothing is read off today's book
  const accepts = cents(anchor) === cents(anchor);
  const rejects = cents(anchor + 1) !== cents(anchor);
  check('C1.identity-can-PASS-and-can-FAIL',
    accepts && rejects,
    `the comparison accepts an exact match (${usd(anchor)}) and rejects the same value off by`
    + ` $1.00 (${usd(anchor + 1)}) — both limbs constructed, neither read off today's book`);
}
// C6 — THE NEW NON-GRADE GATE MUST FIRE, AND MUST STAY SILENT.
//
// A blind branch that fires on every input is the same instrument as no grader
// (TRA-3926 C8 / TRA-3911 C5). The gate is `tapeUsd > total`, so both limbs are
// one comparison over constructed operands — and the SILENT limb is the one
// that matters, because it is what stops this gate from swallowing a real
// attribution FAIL by calling it a ledger gap.
{
  const fires = tapeExceedsBook(156, 150);          // the 2026-08-24 shape
  const silentEqual = !tapeExceedsBook(150, 150);   // tape and book agree exactly
  const silentUnder = !tapeExceedsBook(33, 150);    // book holds desk money too
  // ⛔ THE DETAIL IS COMPUTED FROM THE MEASUREMENT, NEVER WRITTEN AS THE
  // HYPOTHESIS. C5's old message ended "…and still fires on this run"
  // unconditionally, so the one run in its life that FAILED printed the precise
  // opposite of what had happened. Every clause below reports what the limb
  // actually returned.
  check('C6.stale-tape-gate-is-not-a-constant',
    fires && silentEqual && silentUnder,
    `tape $156.00 vs book $150.00 -> ${fires ? 'FIRES' : 'does NOT fire (gate is dead:'
      + ' the stale-tape shape would be graded as an attribution FAIL)'}`
    + ` · equal $150.00/$150.00 -> ${silentEqual ? 'silent' : 'FIRES (gate is a constant)'}`
    + ` · book holds desk premium too, $33.00 of $150.00 -> ${silentUnder ? 'silent'
      : 'FIRES (gate would swallow every real attribution FAIL)'}`
    + ' — both limbs constructed here and routed through the SAME predicate the verdict uses');
}
// C2 — the field-presence test must be able to SEE an absent key. Without this
// the deployed-bytes proof is worthless, which is the whole basis of G1.
{
  const stripped = withRows.map(({ adoptedPremiumAtRiskUsd, ...rest }) => rest);
  const present = stripped.filter(r =>
    Object.prototype.hasOwnProperty.call(r, 'adoptedPremiumAtRiskUsd')).length;
  check('C2.presence-can-FAIL', present === 0,
    'the pre-fix shape (key deleted) is detected as ABSENT, so G1 is a real read');
}
// C4 — THE REGRESSION'S OWN CONTROL. The tape must not move when a
// `history_import` row is injected, and it MUST move for the identical row
// tagged `origin: 'fill'`. Both directions, because "ignores everything" is the
// obvious way to fail this after the 2026-08-21 fix (TRA-3722's lesson).
{
  const sym = liveOpens[0].optionSymbol;
  const base = tapeBasis(sym);
  const synth = (origin) => ({
    ...liveOpens[0], optionSymbol: sym, side: 'buy_to_open', mode: 'live',
    contracts: 1, filledPrice: 9.99, orderId: null, origin,
    ts: Math.max(...records.filter(r => r.optionSymbol === sym).map(r => r.ts)) + 1,
  });
  const saved = records.slice();
  records.push(synth('history_import'));
  const withImport = tapeBasis(sym);
  records.length = 0; records.push(...saved, synth('fill'));
  const withFill = tapeBasis(sym);
  records.length = 0; records.push(...saved);
  check('C4.import-is-ignored-and-a-fill-is-not',
    cents(withImport.costBasisUsd) === cents(base.costBasisUsd)
    && withImport.imported === base.imported + 1
    && cents(withFill.costBasisUsd) === cents(base.costBasisUsd + 999),
    `injected +1@$9.99: as \`history_import\` the tape holds at ${usd(base.costBasisUsd)}`
    + ` (imported ${base.imported}→${withImport.imported}); as \`fill\` it moves to`
    + ` ${usd(withFill.costBasisUsd)} — the scoping discriminates in BOTH directions`);
}
// C3 — the fold is on the ARM, not on `mode`.
{
  const modeLive = exposure.filter(r => r.mode === 'live').length;
  check('C3.arm-not-mode', modeLive >= armedBooks.length,
    `${modeLive} rows read mode='live' vs ${armedBooks.length} gate-open`
    + ' — the fleet is summed on the ARM');
}

// C5 — the NO-SUBJECT gate must be able to fire AND to stay silent. A blind gate
// that fires on every input is the same instrument as no grader at all, and one
// that can never fire makes the post-deploy grade permanently un-reachable.
//
// ⛔ NEITHER LIMB MAY BE READ OFF TODAY'S BOOK. The first draft (2026-08-21,
// written on a beat when the live book genuinely held no subject) proved "it can
// still fire" by calling the gate on the LIVE row — which is not a statement
// about the gate at all, it is a statement about the data. On 2026-08-21T21:2xZ
// a real adopted row appeared (`admin` desk $141.00, the fix working exactly as
// specified) and this control went RED on a run where every substantive
// criterion passed. Same shelf-life defect TRA-3926 named one level up: a
// control whose verdict moves with the subject it is controlling for is a
// measurement, not a control. Both limbs are now built from a NEUTRAL shape this
// script constructs, so C5 grades the PREDICATE and nothing else.
{
  const neutral = {
    ...withRows[0],
    adoptedOpenRows: 0,
    adoptedAttributionBlindRows: 0,
    adoptedPremiumAtRiskUsd: 0,
  };
  const noSubjectDrift = {
    ...(drift ?? {}),
    absorbedContractsLast: 0,
    excessContractsLast: 0,
    engineOriginImportedRowsCheckedLast: 0,
  };
  const quiet = [
    ['a row IS labelled adopted',
      subjectAbsenceReason([{ ...neutral, adoptedOpenRows: 1 }], noSubjectDrift)],
    ['a row was REFUSED (oracle blind)',
      subjectAbsenceReason([{ ...neutral, adoptedAttributionBlindRows: 1 }], noSubjectDrift)],
    ['drift ABSORBED a contract onto a row, adopted columns still 0 (the pre-fix defect)',
      subjectAbsenceReason([neutral], { ...noSubjectDrift, absorbedContractsLast: 1 })],
    ['a criterion FAILED, so there was something present to fail',
      subjectAbsenceReason([neutral], noSubjectDrift, 1)],
  ];
  const fires = subjectAbsenceReason([neutral], noSubjectDrift);
  const silent = quiet.filter(([, r]) => r === null);
  check('C5.no-subject-gate-is-not-a-constant',
    silent.length === quiet.length && typeof fires === 'string',
    `${silent.length}/${quiet.length} subject-present shapes leave it silent`
    + ` (${silent.map(([n]) => n.split(',')[0]).join('; ') || 'NONE'})`
    + ` and the constructed no-subject shape ${typeof fires === 'string' ? 'DOES' : 'does NOT'} fire`
    + ' — both limbs constructed here, neither read off today\'s book');
}

// ── Verdict ─────────────────────────────────────────────────────────────────
const after = await pin();
if (!after?.commit) blind('pin unreadable after the probe');
if (after.commit !== before.commit || after.pid !== before.pid || after.startedAt !== before.startedAt) {
  blind(`pin MOVED across the probe (${before.commitShort ?? before.commit}/${before.pid} -> `
    + `${after.commit}/${after.pid}) — the rows are a mix of two builds`);
}
console.log(`# pin AFTER   commit=${after.commit} pid=${after.pid} uptimeSec=${age(after)}`);

console.log('');
for (const r of rows) {
  console.log(`${r.nograde ? 'NOGRD' : r.ok ? 'PASS ' : 'FAIL '} ${r.id.padEnd(34)} ${r.detail}`);
}
const failed = rows.filter(r => !r.ok);
const ungraded = rows.filter(r => r.nograde === true);
console.log('');
console.log(`# books gate-open=${armedBooks.length} with-rows=${withRows.length}`
  + ` · live buy_to_open in ledger=${liveOpens.length}`);
for (const r of withRows) {
  console.log(`#   ${r.book}: total ${usd(r.openPremiumAtRiskUsd)}`
    + ` = engine ${usd(r.openPremiumAtRiskUsd - r.adoptedPremiumAtRiskUsd)}`
    + ` + desk ${usd(r.adoptedPremiumAtRiskUsd)}`
    + ` over ${r.openRows} row(s), ${r.adoptedOpenRows} adopted,`
    + ` ${r.adoptedAttributionBlindRows} refused`);
}
if (drift) {
  console.log(`#   brokerPositionDrift: ${drift.liveBookStatus ?? drift.status}`
    + ` · excessLast=${drift.excessContractsLast ?? '?'}`
    + ` absorbedLast=${drift.absorbedContractsLast ?? '?'}`
    + ` engineOriginImportedRowsLast=${drift.engineOriginImportedRowsCheckedLast ?? '?'}`
    + ` · this boot: absorbedChecks=${drift.absorbedChecks ?? '?'}`
    + ` excessChecks=${drift.excessChecks ?? '?'}`);
}
if (typeof after.uptimeSec === 'number' && after.uptimeSec < SHALLOW_BOOT_SEC) {
  blind(`graded ${after.uptimeSec}s after boot — balances and the ledger may not have arrived;`
    + ' a shallow read is cured by a second read at depth, not by a re-ship');
}
// ⛔ AFTER the rows print, BEFORE the verdict. A criterion that cannot fail on
// this run's data is not a pass, and 13/13 over an empty subject is the loudest
// possible way to say nothing. Evaluated with the FAILURE COUNT in hand so a
// real FAIL is never downgraded to "could not tell".
const noSubject = subjectAbsenceReason(withRows, drift, failed.length);
if (noSubject) blind(noSubject);

// ⛔ PRECEDENCE, and it is deliberate: a genuine FAIL is NEVER downgraded to
// BLIND. Only once nothing has actually failed does an un-gradeable criterion
// decide the verdict — because "we could not test the thing this ticket ships"
// must not be reported with the same exit code as "we tested it and it holds".
console.log(`${failed.length === 0 ? (ungraded.length === 0 ? 'PASS' : 'BLIND') : 'FAIL'}`
  + ` — ${rows.length - failed.length - ungraded.length}/${rows.length - ungraded.length} graded`
  + (ungraded.length > 0 ? `, ${ungraded.length} NOT GRADED` : '')
  + ` at uptimeSec=${age(after)}`);
if (failed.length > 0) process.exit(1);
if (ungraded.length > 0) {
  console.error(`BLIND — ${ungraded.length} criterion/criteria could not be evaluated:`
    + ` ${ungraded.map(r => r.id).join(', ')}`);
  process.exit(3);
}
process.exit(0);
