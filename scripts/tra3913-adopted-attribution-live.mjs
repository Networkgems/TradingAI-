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

const get = async path => fetch(`${HOST}${path}`).then(r => r.json()).catch(() => null);

async function pin() {
  const r = await get('/api/health/options-live');
  const b = r?.build ?? null;
  return b
    ? { commit: b.commit, pid: b.pid, startedAt: b.startedAt, uptimeSec: b.uptimeSec ?? null }
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
    check(`G2.${r.book}.tape`, false,
      `${refused} row(s) REFUSED — adopted ${usd(adopted)} is an upper bound, identity untested`);
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
    check(`G2.${r.book}.tape`, false,
      `NOT GRADED — ${withRows.length} gate-open books hold rows, so the process-wide tape`
      + ` (${usd(tapeUsd)}) is not this book's engine share; grade per-book off the journal`);
    continue;
  }
  if (tapeUnpriced > 0) {
    check(`G2.${r.book}.tape`, false,
      `the tape itself holds ${tapeUnpriced} unpriceable fill(s) — oracle incomplete`);
    continue;
  }
  const tapeImported = contributing.reduce((sum, b) => sum + (b.imported ?? 0), 0);
  check(`G2.${r.book}.tape`,
    cents(engineServed) === cents(tapeUsd),
    `served engine share ${usd(engineServed)} === engine-placed fill tape ${usd(tapeUsd)}`
    + ` over ${contributing.length} OPEN episode(s): `
    + contributing.map(b => `${b.s} ${b.contracts}@${b.contracts > 0 ? usd(b.costBasisUsd / (b.contracts * 100)) : 'n/a'}`
      + (b.imported > 0 ? ` +${b.imported} imported` : '')).join(', ')
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
// C1 — the tape re-derivation must REJECT a row inflated by $1.00.
{
  const r = withRows[0];
  const mutated = { ...r, adoptedPremiumAtRiskUsd: (r.adoptedPremiumAtRiskUsd ?? 0) + 1 };
  const engineMutated = mutated.openPremiumAtRiskUsd - mutated.adoptedPremiumAtRiskUsd;
  const tapeUsd = [...new Set(liveOpens.map(f => f.optionSymbol))]
    .reduce((s, sym) => s + tapeBasis(sym).costBasisUsd, 0);
  check('C1.identity-can-FAIL',
    cents(engineMutated) !== cents(tapeUsd),
    'a row inflated by $1.00 is rejected by the same comparison that passed the real one');
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

// ── Verdict ─────────────────────────────────────────────────────────────────
const after = await pin();
if (!after?.commit) blind('pin unreadable after the probe');
if (after.commit !== before.commit || after.pid !== before.pid || after.startedAt !== before.startedAt) {
  blind(`pin MOVED across the probe (${before.commitShort ?? before.commit}/${before.pid} -> `
    + `${after.commit}/${after.pid}) — the rows are a mix of two builds`);
}
console.log(`# pin AFTER   commit=${after.commit} pid=${after.pid} uptimeSec=${age(after)}`);

console.log('');
for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(34)} ${r.detail}`);
const failed = rows.filter(r => !r.ok);
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
if (typeof after.uptimeSec === 'number' && after.uptimeSec < SHALLOW_BOOT_SEC) {
  blind(`graded ${after.uptimeSec}s after boot — balances and the ledger may not have arrived;`
    + ' a shallow read is cured by a second read at depth, not by a re-ship');
}
console.log(`${failed.length === 0 ? 'PASS' : 'FAIL'} — ${rows.length - failed.length}/${rows.length}`
  + ` at uptimeSec=${age(after)}`);
process.exit(failed.length === 0 ? 0 : 1);
