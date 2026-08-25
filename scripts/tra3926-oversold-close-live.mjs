// TRA-3926 — GRADE THE OVER-SELL DETECTOR *AND* THE EXIT BOUND ON LIVE BYTES, PINNED BUILD.
//
// The ticket ships two things and they are gradeable in completely different
// ways, which is the whole reason this file exists rather than a hand-read:
//
//   • the DETECTOR (`detectOversoldEngineCloses` → `oversoldCloses`) walks a
//     durable tape, so it has a subject the moment the route answers. It is
//     PASS/FAIL gradeable today.
//   • the BOUND (`boundExitContractsToEngineShare` → `exitQuantityBound`) only
//     ever runs when an IMPORTED row reaches an exit staging site. Its counters
//     reset every boot and its population is decided by a gate ABOVE it. It is
//     usually BLIND, and reporting a zeroed census as a pass would be the exact
//     failure this codebase keeps re-learning.
//
// ── Why `exitQuantityBound.checked === 0` is BLIND and never PASS ───────────
// `stageableExitContracts` increments `exitQuantityChecked` only for rows with
// `importedFromTradier === true`. That denominator is not ours to move: the
// authorisation gate one level up (TRA-3829 ruling B) refuses `adopted` rows
// outright, and `/api/health/options-live` publishes that refusal as
// `liveUnmanagedRisk.byReason.adopted_not_authorized`. So a purely-desk imported
// row NEVER reaches the bound — a tighter sibling upstream eats the population,
// which is TRA-3703's line verbatim: NAME THE GATE THAT OWNS THE DENOMINATOR.
// This grader names it, on every run, rather than letting a zero read as calm.
//
// ⚠ AND A `clean` DETECTOR READING IS NOT A PROOF OF THE BOUND EITHER. Measured
// 2026-08-21 on the PRE-fix build: `XLF260925C00057500` sold 2 having bought 1
// at 13:48:04Z, and `BAC260925C00063000` — the SAME shape, engine 1 @1.65 plus a
// `history_import` 1 @1.17 — sold exactly 1 at 17:05:10Z, three hours later, on
// the same pid and the same commit. The pre-fix path over-sells only when the
// reconcile's absorbed/excess race lands the desk contract ON the engine's row
// (TRA-3703: `absorbedChecks 186` / `excessChecks 347` on one boot). So a quiet
// tape is consistent with the fix working AND with the race simply not landing
// that way, and only the counters can tell those apart.
//
// ── How the detector is graded: an ORDER-FREE re-derivation ────────────────
// Checking a published column against a re-implementation of its own algorithm
// learns nothing (TRA-3737's reader defect). This re-derives from the raw
// `records[]` with a DIFFERENT method — per-OCC aggregate totals split by
// `origin`, with no time ordering at all — and requires the two to agree on the
// verdict, the excess, and the symbol partition. Where an ordered walk and an
// order-free fold disagree, that disagreement is itself the finding: it means
// the answer depends on interleaving, and the run exits FAIL naming both.
//
// Exit 0 PASS · 1 FAIL · 2 usage · 3 BLIND.  BLIND > FAIL > PASS.
//
// ── The grader's own controls ──────────────────────────────────────────────
// A grader nobody has seen FAIL is a claim, not an instrument, and this one has
// a blind branch that is expected to fire on almost every real run — exactly
// the shape that quietly degrades into "always BLIND, nobody reads it". So the
// route reads are redirectable to a fixture directory holding a captured
// `options-live.json` + `fee-slippage.json` pair, and
// `scripts/tra3926-oversold-close-controls.mjs` mutates a live capture to prove
// each verdict is reachable. `--fixture` is for CONTROLS ONLY: it cannot grade
// the box, so it refuses to print a PASS that could be mistaken for one.
//
// Usage:
//   node scripts/tra3926-oversold-close-live.mjs [--expect=<sha-prefix>]
//   node scripts/tra3926-oversold-close-live.mjs --fixture=<dir>   # controls only
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOST = 'https://tradingai-bqb1.onrender.com';
const EXPECT = process.argv.find(a => a.startsWith('--expect='))?.slice(9) ?? null;
const FIXTURE = process.argv.find(a => a.startsWith('--fixture='))?.slice(10) ?? null;
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('usage: node scripts/tra3926-oversold-close-live.mjs [--expect=<sha-prefix>] [--fixture=<dir>]');
  process.exit(2);
}

const blind = m => { console.error(`BLIND — ${m}`); process.exit(3); };
const rows = [];
const check = (id, ok, detail) => { rows.push({ id, ok: ok === true, detail }); };
const notes = [];
const FIXTURE_FILES = { '/api/health/options-live': 'options-live.json', '/api/health/live-options-fee-slippage': 'fee-slippage.json' };
const get = async path => {
  if (FIXTURE) {
    try { return JSON.parse(readFileSync(join(FIXTURE, FIXTURE_FILES[path]), 'utf8')); } catch { return null; }
  }
  return fetch(`${HOST}${path}`).then(r => r.json()).catch(() => null);
};
if (FIXTURE) console.log(`# FIXTURE MODE — reading ${FIXTURE}; this run grades the GRADER, not the box.`);
const pinOf = r => (r?.build?.commit
  ? { commit: r.build.commit, pid: r.build.pid, startedAt: r.build.startedAt, uptimeSec: r.build.uptimeSec ?? null }
  : null);
const same = (a, b) => a && b && a.commit === b.commit && a.pid === b.pid && a.startedAt === b.startedAt;

// ── pin BEFORE ─────────────────────────────────────────────────────────────
const optionsLive = await get('/api/health/options-live');
const before = pinOf(optionsLive);
if (!before) blind('pin unreadable before the probe');
console.log(`# pin BEFORE  commit=${before.commit} pid=${before.pid} startedAt=${before.startedAt} uptimeSec=${before.uptimeSec}`);
if (EXPECT && !before.commit.startsWith(EXPECT)) {
  blind(`live commit ${before.commit} is not the graded build ${EXPECT}`);
}

const fee = await get('/api/health/live-options-fee-slippage');
if (!fee) blind('fee/slippage route unreadable');
const records = Array.isArray(fee.records) ? fee.records : null;
if (!records) blind('`records[]` absent — no tape to re-derive from');
if (records.length === 0) blind('`records[]` is EMPTY — the ledger is cold, every verdict below would be vacuous');

// ── D — deployed bytes, by FIELD PRESENCE on both halves ───────────────────
// A deploy order's commit is a lower bound on content, never an expected
// reading (TRA-3660). Neither key exists on the pre-fix build.
const census = fee.oversoldCloses;
const bound = optionsLive.exitQuantityBound;
check('D1  `oversoldCloses` present on live-options-fee-slippage (detector bytes)',
  census !== undefined && census !== null, census === undefined ? 'ABSENT' : 'present');
check('D2  `exitQuantityBound` present on options-live (bound bytes)',
  bound !== undefined && bound !== null, bound === undefined ? 'ABSENT' : 'present');
const BOUND_KEYS = ['checked', 'bounded', 'refusedContracts', 'blindRows', 'suppressedExits', 'lastRefusalAt'];
const missingBoundKeys = bound ? BOUND_KEYS.filter(k => !(k in bound)) : BOUND_KEYS;
check('D3  the bound census publishes all six columns',
  missingBoundKeys.length === 0, missingBoundKeys.length ? `missing ${missingBoundKeys.join(',')}` : BOUND_KEYS.join(','));

// TRA-3926 (2026-08-24) — the SECOND oracle's deployed-bytes proof. This key
// does not exist on `3d0c3582` or on any earlier build, so D4 is what
// separates the tightening from the commit that shipped only the first
// oracle. ⚠ ITS VALUE IS NOT A GRADE: `netOfCloses` counts staging sites the
// second oracle ANSWERED, and it can only rise when an imported row actually
// reaches an exit. Read it as the PAIR `netOfCloses / blindRows` — the
// population that used to fail open, and what is left of it.
const netKeyPresent = bound !== undefined && bound !== null && 'netOfCloses' in bound;
check('D4  the census publishes `netOfCloses` (second-oracle bytes)',
  netKeyPresent,
  netKeyPresent
    ? `netOfCloses ${bound.netOfCloses} / blindRows ${bound.blindRows}`
    : 'ABSENT — this build predates the second oracle');

// TRA-3926 (2026-08-25) — the `desk_add` carve-out's deployed-bytes proof, and
// the refusal REASON on the wire. Measured on `07cc4ba4`: `checked 245 /
// refused 245 / suppressedExits 245` on the desk's `RIG260925C00006000`
// (`desk_add`, trailing stop breached), every one of them `foreign_authority`
// — the board's TRA-3909 exemption made inert by the bound, on real money —
// and this grader printed PASS, because "exercised" was all the census could
// say. Neither key exists on `07cc4ba4` or earlier.
const deskKeysPresent = bound !== undefined && bound !== null
  && 'deskAddExempt' in bound && 'lastRefusalReason' in bound;
check('D5  the census publishes `deskAddExempt` + `lastRefusalReason` (desk_add carve-out bytes)',
  deskKeysPresent,
  deskKeysPresent
    ? `deskAddExempt ${bound.deskAddExempt} / lastRefusalReason ${bound.lastRefusalReason}`
    : 'ABSENT — this build predates the desk_add carve-out');

if (!census) {
  print();
  console.error('FAIL — the detector is not on this build; nothing below is gradeable.');
  process.exit(1);
}

// ── the ORDER-FREE re-derivation ───────────────────────────────────────────
// Deliberately not the shipped walk: per-OCC totals, no sort, no interleaving.
const agg = new Map();
for (const f of records) {
  const s = f?.optionSymbol;
  if (typeof s !== 'string' || s.length === 0) continue;
  // `!(q > 0)` and never `q <= 0`: the latter admits NaN into the usable branch (TRA-3486).
  const q = typeof f.contracts === 'number' && Number.isFinite(f.contracts) ? f.contracts : 0;
  if (!(q > 0)) continue;
  const enginePlaced = f.origin !== 'history_import';
  const a = agg.get(s) ?? { engineBuy: 0, importBuy: 0, engineSell: 0, importSell: 0 };
  if (f.side === 'buy_to_open') { if (enginePlaced) a.engineBuy += q; else a.importBuy += q; }
  else if (f.side === 'sell_to_close') { if (enginePlaced) a.engineSell += q; else a.importSell += q; }
  agg.set(s, a);
}
// A SHORTFALL IS ONLY CHARGED AFTER A POSITIVE STATEMENT (`engineBuy > 0`).
// With `engineBuy === 0` the whole open leg is an import, and our own chokepoint
// has demonstrably missed our own fills (TRA-2959: 7 of 11), so accusing there
// is a false accusation — it is the branch the detector's first version got
// wrong against this very tape.
const derivedExcess = new Map();
const derivedImportOnly = new Map();
for (const [s, a] of agg) {
  if (!(a.engineSell > 0)) continue;
  if (a.engineBuy === 0) { derivedImportOnly.set(s, a.engineSell); continue; }
  if (a.engineSell > a.engineBuy) derivedExcess.set(s, a.engineSell - a.engineBuy);
}
const derivedExcessTotal = [...derivedExcess.values()].reduce((x, y) => x + y, 0);
const setEq = (a, b) => a.size === b.size && [...a].every(k => b.has(k));

const findings = Array.isArray(census.findings) ? census.findings : [];
const blinds = Array.isArray(census.blindCloses) ? census.blindCloses : [];
const publishedExcess = new Map(findings.map(f => [f.optionSymbol, f.excessContracts]));
const publishedImportOnly = new Set(blinds.filter(b => b.reason === 'import_only').map(b => b.optionSymbol));

// ── G — the detector against the independent fold ──────────────────────────
const derivedStatus = derivedExcess.size > 0 ? 'oversold' : (census.judgedCloses > 0 ? 'clean' : 'vacuous');
check(`G1  status agrees with the order-free fold  (served ${census.status})`,
  census.status === derivedStatus, `derived ${derivedStatus}`);
check(`G2  excessContracts agrees  (served ${census.excessContracts})`,
  census.excessContracts === derivedExcessTotal, `derived ${derivedExcessTotal}`);
check('G3  the ACCUSED symbol set agrees exactly',
  setEq(new Set(publishedExcess.keys()), new Set(derivedExcess.keys())),
  `served [${[...publishedExcess.keys()].join(' ')}] vs derived [${[...derivedExcess.keys()].join(' ')}]`);
// ⛔ THE POSITIVE STATEMENT IS THE LIFETIME COUNT, NOT THE BALANCE. This check
// read `engineOpenContracts > 0` until 2026-08-24, which is the same running
// balance the detector's `import_only` branch was using — so a grader and the
// instrument it grades shared one blind spot, and the live BAC over-sell at
// 19:31:08Z sat inside it. The order-free fold above never did (`engineBuy` is a
// lifetime total), which is exactly why it disagreed and why it is a DIFFERENT
// method rather than a re-implementation. `basis: 'exhausted'` findings carry
// `engineOpenContracts: 0` BY CONSTRUCTION and must still rest on a witness.
check('G4  every finding rests on a POSITIVE statement (engineOpensSeenContracts > 0)',
  findings.every(f => f.engineOpensSeenContracts > 0 &&
    (f.basis === 'exhausted' ? f.engineOpenContracts === 0 : f.engineOpenContracts > 0)),
  findings.length
    ? findings.map(f => `${f.optionSymbol}:${f.basis}:seen=${f.engineOpensSeenContracts}/out=${f.engineOpenContracts}`).join(' ')
    : 'no findings');
check('G5  every finding is self-consistent (excess === sold − engineOpen)',
  findings.every(f => f.excessContracts === f.soldContracts - f.engineOpenContracts),
  findings.map(f => `${f.optionSymbol} ${f.soldContracts}-${f.engineOpenContracts}=${f.excessContracts}`).join(' | ') || 'no findings');
check('G6  the import-only BLIND set agrees exactly (the false-accusation guard)',
  setEq(publishedImportOnly, new Set(derivedImportOnly.keys())),
  `served [${[...publishedImportOnly].join(' ')}] vs derived [${[...derivedImportOnly.keys()].join(' ')}]`);
check('G7  the census closes over its own population (judged + blind === engineCloses)',
  census.judgedCloses + blinds.length === census.engineCloses,
  `${census.judgedCloses} + ${blinds.length} === ${census.engineCloses}`);
check('G8  every blind carries a reason this build knows',
  blinds.every(b => ['no_open_record', 'unusable_quantity', 'import_only'].includes(b.reason)),
  [...new Set(blinds.map(b => b.reason))].join(',') || 'none');
// ⛔ THE TWO GATES MUST AGREE. After the carve-outs, `foreign_authority` can
// reach the bound ONLY through a row `engineMayActOnAdoptedRow` should have
// refused upstream (`foreign` / `unresolved` / absent, no hand-over) — so a
// refusal with that reason on the wire is the authorisation gate and the
// quantity bound disagreeing about the same row, which is the 2026-08-25 RIG
// defect exactly. Graded only where D5 has the key; D5 carries the absence.
check('G9  no refusal on this boot names a population the authorisation gate admits (`foreign_authority` at the bound = the gates disagree)',
  !deskKeysPresent || bound.lastRefusalReason !== 'foreign_authority',
  deskKeysPresent ? `lastRefusalReason ${bound.lastRefusalReason}` : 'key absent — see D5');

// ── R — the two events the ticket was filed on. A REGRESSION ANCHOR. ───────
// Both are inside the ledger's 30-day retention as of 2026-08-21. When
// retention rolls them out the anchor stops being assertable, and that is a
// BLIND about the anchor, not a pass — so it is checked against the TAPE's own
// reach rather than against the calendar.
// ⛔ THE THIRD ANCHOR IS THE ONE THAT FIRED WITH THE REMEDY ALREADY MERGED.
// `BAC260925C00063000` order 143160792, 2026-08-24T19:31:08Z, real money: the
// engine's second close on an OCC it bought ONE of. `a5a49717` — the second
// oracle that binds exactly this row to 0 — was merged 13:48Z the same day and
// did not reach the box until the 20:14:44Z deploy, because `render-redeploy`
// refuses 13:25–20:00Z. It is anchored as `ours: 0` / `basis: exhausted`: the
// engine's own 08-21 close had already consumed its own lot, so a check written
// against the running balance CANNOT see it. That is the whole finding.
const KNOWN = [
  { symbol: 'XLF260925C00057500', orderId: 142806015, sold: 2, ours: 1, basis: 'outstanding' },
  { symbol: 'QQQ260911P00545000', orderId: 140287732, sold: 5, ours: 4, basis: 'outstanding' },
  { symbol: 'BAC260925C00063000', orderId: 143160792, sold: 1, ours: 0, basis: 'exhausted' },
];
const oldestTs = Math.min(...records.map(r => r.ts).filter(t => Number.isFinite(t)));
for (const k of KNOWN) {
  const closeInTape = records.some(r => r.orderId === k.orderId);
  if (!closeInTape) {
    notes.push(`R  ${k.symbol} order ${k.orderId} has aged out of the tape (oldest record ${new Date(oldestTs).toISOString()}) — anchor NOT assertable, not a pass`);
    continue;
  }
  const f = findings.find(x => x.orderId === k.orderId);
  check(`R  ${k.symbol} order ${k.orderId} is still reported (sold ${k.sold} / ours ${k.ours} / ${k.basis})`,
    !!f && f.soldContracts === k.sold && f.engineOpenContracts === k.ours && f.basis === k.basis,
    f ? `sold ${f.soldContracts} ours ${f.engineOpenContracts} excess ${f.excessContracts} basis ${f.basis}` : 'NOT REPORTED');
}

// ── the residual fail-open, always printed ─────────────────────────────────
const blindContracts = blinds.reduce((n, b) => n + (b.soldContracts ?? 0), 0);
notes.push(`RESIDUAL  ${blinds.length} blind close(s) / ${blindContracts} contract(s) the detector could not judge — `
  + `${blinds.map(b => `${b.optionSymbol}(${b.soldContracts},${b.reason})`).join(' ')}`);
notes.push('RESIDUAL  a blind close is an UNANSWERED QUESTION, not a clean one. These bytes cannot separate '
  + 'the desk\'s contract from an engine fill our chokepoint missed; only the broker\'s order history can.');

// ── pin AFTER — a move INVALIDATES rather than degrades ────────────────────
const after = pinOf(await get('/api/health/options-live'));
if (!same(before, after)) {
  print();
  blind(`the pin MOVED across the probe (${before.commit}/${before.pid}/${before.startedAt} → `
    + `${after?.commit}/${after?.pid}/${after?.startedAt}) — the rows above mix two builds`);
}

print();

// ── verdict, with the bound's blindness ranked ABOVE the detector's pass ───
const failed = rows.filter(r => !r.ok);
const boundExercised = !!bound && typeof bound.checked === 'number' && bound.checked > 0;
const unauthorizedAdopted = optionsLive?.liveUnmanagedRisk?.byReason?.adopted_not_authorized ?? 0;

console.log('');
console.log(`# BOUND CENSUS (this boot only, ${before.uptimeSec}s):  ${JSON.stringify(bound)}`);
console.log(`# the gate that owns the denominator:  liveUnmanagedRisk.byReason.adopted_not_authorized = ${unauthorizedAdopted}`);

if (failed.length > 0) {
  console.error(`\nFAIL — ${failed.length}/${rows.length}: ${failed.map(r => r.id).join(' | ')}`);
  process.exit(1);
}
if (!boundExercised) {
  console.error(`\nBLIND — the DETECTOR passed ${rows.length}/${rows.length}, but the BOUND is UNEXERCISED on this boot `
    + `(exitQuantityBound.checked = ${bound?.checked}). Not one imported row reached an exit staging site, so AC1–AC4 `
    + `are proven by the unit suite and by deployed bytes ONLY, never by this reading.`
    + (unauthorizedAdopted > 0
      ? `\n        And the population is currently held UPSTREAM: ${unauthorizedAdopted} adopted row(s) sit `
        + `\`adopted_not_authorized\`, refused by ruling B's gate before the bound is ever consulted.`
      : ''));
  process.exit(3);
}
console.log(`\nPASS${FIXTURE ? ' (FIXTURE — proves the pass branch is REACHABLE; says nothing about the box)' : ''}`
  + ` — ${rows.length}/${rows.length}; the bound was exercised ${bound.checked}× on this boot `
  + `(bounded ${bound.bounded}, contracts refused ${bound.refusedContracts}, blind ${bound.blindRows}, `
  + `desk_add exempt ${bound.deskAddExempt ?? '—'}, last refusal ${bound.lastRefusalReason ?? 'none'}).`);
process.exit(0);

function print() {
  console.log('');
  for (const r of rows) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.id}${r.detail ? `  — ${r.detail}` : ''}`);
  for (const n of notes) console.log(`--    ${n}`);
}
