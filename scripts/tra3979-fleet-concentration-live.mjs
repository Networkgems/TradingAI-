// TRA-3979 — GRADE THE FLEET CONCENTRATION FOLD ON LIVE BYTES, on a PINNED build.
//
// AC5 is not satisfied by a merge and not by a unit test. A field that exists in
// the repo and not in the deployed payload satisfies nothing, and the two are
// INDISTINGUISHABLE from the repo (TRA-3660 — a deploy order's commit is a lower
// bound on CONTENT, not an expected reading; grade FIELD PRESENCE).
//
// The finding this grades, measured 2026-08-24 on bqb1 `3d0c3582` / pid 73:
//
//     v0nni  NVTS261002C00012500  1 ct  $154   14:25:07.953Z  ord 143021643
//     admin  NVTS261002C00012500  1 ct  $151   14:44:34.991Z  ord 143032832
//                                       ----
//                                       $305  = 68.7% of the $444 fleet at-risk
//
// ⭐ EVERY CRITERION IS AN IDENTITY OVER THE PAYLOAD'S OWN OPERANDS, NOT A
// REMEMBERED NUMBER. Positions close. `NVTS -> $305` is graded when the tape
// still carries it and reported SCOPED when it does not — a grader that only
// knows one arithmetic answer stops being a grader the moment a dollar moves.
// The `$305 / 2 ct / [admin,v0nni]` reproduction then rests on the fixture in
// `packages/server/src/fleet-concentration.test.ts`, which replays that tape.
//
// ⭐ AND THE IDENTITY CHECKER CARRIES ITS OWN POSITIVE CONTROL (C1/C2). Every
// `assert(recomputed === served)` is vacuous if the predicate cannot return
// false, so the controls feed it deliberately mutated payloads and REQUIRE a
// failure. When the controls pass and the subject passes and the controls COULD
// NOT have failed, you have learned nothing (TRA-3884).
//
// Exit 0 PASS · 1 FAIL · 2 usage · 3 BLIND. BLIND > FAIL > PASS.
// A pin move across the probe INVALIDATES the run — it does not degrade to
// FAIL, because the two reads would then be a mix of two builds.
const HOST = process.argv.find(a => a.startsWith('--host='))?.slice(7)
  ?? 'https://tradingai-bqb1.onrender.com';
const ROUTE = '/api/health/live-options-fee-slippage';

const blind = m => { console.error(`BLIND — ${m}`); process.exit(3); };
const usd = n => (typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : String(n));
const cents = n => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) : NaN);

const rows = [];
const check = (id, ok, detail) => { rows.push({ id, ok: ok === true, detail }); };

async function readRoute() {
  const r = await fetch(`${HOST}${ROUTE}`).then(x => x.json()).catch(() => null);
  return r ?? null;
}

const pinOf = b => (b
  ? { commit: b.commit, pid: b.pid, startedAt: b.startedAt, uptimeSec: b.uptimeSec ?? null }
  : null);
const age = p => (typeof p?.uptimeSec === 'number' ? `${p.uptimeSec}s` : 'unknown');
// ⭐ BOOT AGE IS PART OF THE VERDICT, NOT OF THE OPERATOR'S MEMORY (TRA-3911).
// A fold scored 36 s after a boot, over balances nothing had fetched yet, is not
// a PASS anyone can bank — and nothing in the output used to say so.
const SHALLOW_BOOT_SEC = 120;

const first = await readRoute();
if (first === null) blind(`${ROUTE} unreadable`);
const before = pinOf(first.build);
if (!before?.commit) blind('pin unreadable before the probe');
console.log(
  `# pin BEFORE  commit=${before.commit} pid=${before.pid} startedAt=${before.startedAt}`
  + ` uptimeSec=${age(before)}`,
);

const fc = first.fleetConcentration;
const bound = first.aggregateFleetBound ?? null;

// ── AC5 / deployed bytes ─────────────────────────────────────────────────────
const present = Object.prototype.hasOwnProperty.call(first, 'fleetConcentration');
check(
  'AC5 key present',
  present,
  present
    ? 'fleetConcentration IS on the deployed payload'
    : 'fleetConcentration ABSENT — this build predates TRA-3979; nothing below is gradeable',
);
if (!present) {
  console.log('\n  FAIL  AC5 key present  --  the field is not deployed.');
  console.log('FAIL — undeployed. Land the commit, then re-run.');
  process.exit(1);
}

// ── AC4 — advisory, said on the wire ─────────────────────────────────────────
check(
  'AC4 advisory',
  fc.entryPathBehavior === 'advisory_no_refusal' && fc.refuses === false,
  `entryPathBehavior=${String(fc.entryPathBehavior)} refuses=${String(fc.refuses)} `
  + '(NO order site consults this object; a refusal is a board number, TRA-3703)',
);

// ── AC3 — the denominator is named, and the counts are explicit ──────────────
check(
  'AC3 gate named',
  fc.populationGate === 'liveEntryGateOpen' && typeof fc.populationOwner === 'string'
    && fc.populationOwner.length > 0,
  `populationGate=${String(fc.populationGate)}; owner=${String(fc.populationOwner).slice(0, 60)}...`,
);
check(
  'AC3 checked/evaluated',
  Number.isInteger(fc.booksChecked) && Number.isInteger(fc.booksEvaluated)
    && Number.isInteger(fc.positionsChecked) && Number.isInteger(fc.positionsEvaluated)
    && fc.booksEvaluated <= fc.booksChecked && fc.positionsEvaluated <= fc.positionsChecked,
  `books ${fc.booksEvaluated}/${fc.booksChecked} evaluated/checked; `
  + `positions ${fc.positionsEvaluated}/${fc.positionsChecked}; blind books ${fc.booksBlind}`,
);
// A `0` from an empty population must not read as a `0` meaning no concentration.
const zeroUnambiguous = fc.status === 'measured'
  ? fc.positionsEvaluated > 0 && fc.maxContract !== null
  : fc.maxContract === null;
check(
  'AC3 zeros unambiguous',
  ['unwired', 'empty', 'measured'].includes(fc.status) && zeroUnambiguous,
  `status=${fc.status}; maxContract=${fc.maxContract === null ? 'null' : fc.maxContract.key} `
  + '(status distinguishes unwired / empty / measured; max is null, never a synthetic 0 bucket)',
);

// ── The cross-fold identity: same dollars, sliced differently ────────────────
// ⭐ THIS IS THE LOAD-BEARING ONE. It is what makes the concentration report a
// re-slice of the ENFORCED number rather than a second plausible figure wearing
// the same units. Both go through `rowOpenPremiumAtRisk`; if they ever diverge,
// one is reading a population the other is not — grade that, do not average it.
function identityAgainstBound(conc, bnd) {
  if (!bnd || typeof bnd.fleetAtRiskUsd !== 'number') return null;
  return cents(conc.fleetAtRiskUsd) === cents(bnd.fleetAtRiskUsd);
}
const idOk = identityAgainstBound(fc, bound);
check(
  'IDENTITY vs aggregateFleetBound',
  idOk === true,
  idOk === null
    ? 'aggregateFleetBound unreadable — cannot cross-check'
    : `fleetConcentration ${usd(fc.fleetAtRiskUsd)} vs bound ${usd(bound.fleetAtRiskUsd)} `
      + `over books [${(bound.books ?? []).join(', ')}]`,
);

// ── AC1 — the contract fold ──────────────────────────────────────────────────
const contracts = Array.isArray(fc.byContract) ? fc.byContract : [];
const shapeOk = contracts.every(b =>
  typeof b.key === 'string' && typeof b.atRiskUsd === 'number'
  && Number.isFinite(b.contracts) && Array.isArray(b.books) && b.bookCount === b.books.length);
check(
  'AC1 contract fold shape',
  shapeOk,
  `${contracts.length} contract bucket(s), each carrying atRiskUsd + contracts + books`,
);
// Σ buckets + unkeyed === the fleet total. The fold cannot lose or mint dollars.
const sumContracts = contracts.reduce((s, b) => s + b.atRiskUsd, 0);
check(
  'AC1 conservation',
  cents(sumContracts + (fc.unkeyedContractAtRiskUsd ?? 0)) === cents(fc.fleetAtRiskUsd),
  `Σ byContract ${usd(sumContracts)} + unkeyed ${usd(fc.unkeyedContractAtRiskUsd ?? 0)} `
  + `= ${usd(fc.fleetAtRiskUsd)}`,
);

// The 08-24 finding itself — graded when the tape still carries it.
const NVTS = 'NVTS261002C00012500';
const nvts = contracts.find(b => b.key === NVTS) ?? null;
if (nvts) {
  check(
    'AC1 live finding (NVTS)',
    cents(nvts.atRiskUsd) === cents(305) && nvts.contracts === 2 && nvts.bookCount === 2,
    `${NVTS} -> ${usd(nvts.atRiskUsd)}, ${nvts.contracts} ct, [${nvts.books.join(', ')}], `
    + `${((nvts.shareOfFleetAtRisk ?? 0) * 100).toFixed(1)}% of fleet at-risk`,
  );
} else {
  console.log(
    `\n# SCOPED — ${NVTS} is no longer on the live tape. The $305 / 2 ct / [admin,v0nni]`
    + ' reproduction is graded on the fixture in packages/server/src/fleet-concentration.test.ts.'
    + ' Every criterion below is still an identity over the CURRENT tape.',
  );
}
// The hazard column, whatever it holds today.
const multi = Array.isArray(fc.multiBookContracts) ? fc.multiBookContracts : [];
check(
  'AC1 multi-book column',
  Array.isArray(fc.multiBookContracts)
    && multi.every(b => b.bookCount > 1)
    && contracts.filter(b => b.bookCount > 1).length === multi.length,
  multi.length === 0
    ? 'no contract is held by more than one gate-open book RIGHT NOW (a finding, not an absence: '
      + `${contracts.length} bucket(s) were evaluated)`
    : multi.map(b => `${b.key} ${usd(b.atRiskUsd)} x${b.bookCount}`).join(' | '),
);

// ── AC2 — the underlying fold ────────────────────────────────────────────────
const names = Array.isArray(fc.byUnderlying) ? fc.byUnderlying : [];
const sumNames = names.reduce((s, b) => s + b.atRiskUsd, 0);
check(
  'AC2 underlying fold',
  names.length > 0 || contracts.length === 0,
  `${names.length} underlying bucket(s): `
  + (names.slice(0, 5).map(b => `${b.key} ${usd(b.atRiskUsd)} (${b.distinctContracts} ct-key(s), `
    + `${b.bookCount} book(s))`).join(' | ') || 'none'),
);
check(
  'AC2 conservation',
  cents(sumNames + (fc.unkeyedUnderlyingAtRiskUsd ?? 0)) === cents(fc.fleetAtRiskUsd),
  `Σ byUnderlying ${usd(sumNames)} + unkeyed ${usd(fc.unkeyedUnderlyingAtRiskUsd ?? 0)} `
  + `= ${usd(fc.fleetAtRiskUsd)}`,
);
// The reason both folds ship: two strikes on one name are the same hazard.
const strikesPerName = names.filter(b => b.distinctContracts > 1);
check(
  'AC2 not contract-only',
  names.every(b => b.distinctContracts >= 1),
  strikesPerName.length === 0
    ? 'no name currently carries >1 strike — the fold is the instrument for when one does'
    : strikesPerName.map(b => `${b.key} spans ${b.distinctContracts} contracts`).join(' | '),
);

// ── Controls: the identity checker must be able to FAIL ─────────────────────
const c1 = identityAgainstBound({ ...fc, fleetAtRiskUsd: (fc.fleetAtRiskUsd ?? 0) + 1 }, bound);
check(
  'C1 control (identity can fail)',
  c1 === false,
  'a fleet total mutated by $1.00 is REJECTED by the cross-fold identity',
);
const mutated = contracts.length > 0
  ? [{ ...contracts[0], atRiskUsd: contracts[0].atRiskUsd + 1 }, ...contracts.slice(1)]
  : [];
const c2 = contracts.length > 0
  && cents(mutated.reduce((s, b) => s + b.atRiskUsd, 0) + (fc.unkeyedContractAtRiskUsd ?? 0))
     !== cents(fc.fleetAtRiskUsd);
check(
  'C2 control (conservation can fail)',
  contracts.length === 0 ? false : c2,
  contracts.length === 0
    ? 'VACUOUS — no buckets to mutate, so the conservation check proved nothing this run'
    : 'a bucket inflated by $1.00 breaks conservation, as it must',
);

// ── Pin AFTER ────────────────────────────────────────────────────────────────
const second = await readRoute();
const after = pinOf(second?.build);
if (!after?.commit) blind('pin unreadable after the probe');
console.log(
  `# pin AFTER   commit=${after.commit} pid=${after.pid} startedAt=${after.startedAt}`
  + ` uptimeSec=${age(after)}`,
);
if (before.commit !== after.commit || before.pid !== after.pid
  || before.startedAt !== after.startedAt) {
  blind('THE PIN MOVED ACROSS THE PROBE — the rows are a mix of two builds. Re-run.');
}

console.log(`\n# ${fc.reason}`);
console.log(
  `  status=${fc.status} lowerBound=${String(fc.concentrationIsLowerBound)} `
  + `unpriced=${fc.unpricedRows} unkeyed=${fc.unkeyedContractRows} blindBooks=${fc.booksBlind}`,
);

console.log('');
let failed = 0;
for (const r of rows) {
  if (!r.ok) failed += 1;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  --  ${r.detail}`);
}
console.log(`\n${rows.length - failed}/${rows.length} criteria pass.`);

const shallow = typeof after.uptimeSec === 'number' && after.uptimeSec < SHALLOW_BOOT_SEC;
const depth = `boot age ${age(before)} -> ${age(after)}`;
if (failed > 0) { console.log(`FAIL  (${depth})`); process.exit(1); }
if (shallow) {
  console.log(
    `SHALLOW — scored under ${SHALLOW_BOOT_SEC}s of uptime (${depth}). NOT blind, but re-read at`
    + ' depth before citing it. The cure is a SECOND READ, never a re-ship.',
  );
}
console.log(
  `PASS — fleet concentration is PUBLISHED and ADVISORY on this pinned build (${depth}).`,
);
process.exit(0);
