// TRA-3911 — GRADE THE REACHABLE BOUND ON LIVE BYTES, on a PINNED build.
//
// AC5 is not satisfied by a merge. It is satisfied by the order path ENFORCING
// `entry <= min(cap_i - atRisk_i, A - Sum_j atRisk_j)` on the build bqb1 is
// actually serving, before the 2026-08-22 open (13:30Z).
//
// ── How this grader is built, and why ──────────────────────────────────────
//
// The ACs are stated against ONE fleet reading (admin $358 at risk / cap
// $306.32, v0nni flat / cap $193.67 => admissible $142.00, reachable $500.00).
// Balances move. So every criterion below is graded as an IDENTITY recomputed
// CROSS-COLUMN from the row's own published operands, and the fixture numbers
// are reported beside it rather than asserted as the test. A grader that only
// knows one arithmetic answer stops being a grader the moment a dollar moves.
//
// ⭐ AND THE IDENTITY CHECKER CARRIES ITS OWN POSITIVE CONTROL. Every
// `assert(recomputed === served)` row is vacuous if the predicate cannot return
// false, so control C1 feeds it a deliberately mutated row and REQUIRES a
// failure. That is the check TRA-3884 was written about: when the controls pass
// and the subject passes, you have learned nothing unless the controls could
// have failed.
//
// Exit 0 PASS · 1 FAIL · 2 usage · 3 BLIND. BLIND > FAIL > PASS.
// A pin move across the probe INVALIDATES the run — it does not degrade to FAIL,
// because the rows would then be a mix of two builds.
const HOST = 'https://tradingai-bqb1.onrender.com';
const EXPECT = process.argv.find(a => a.startsWith('--expect='))?.slice(9) ?? null;

const blind = m => { console.error(`BLIND — ${m}`); process.exit(3); };
const usd = n => (typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : String(n));
const cents = n => Math.round(n * 100);

const rows = [];
const check = (id, ok, detail) => { rows.push({ id, ok, detail }); };

async function pin() {
  const r = await fetch(`${HOST}/api/health/options-live`).then(x => x.json()).catch(() => null);
  const b = r?.build ?? null;
  return b ? { commit: b.commit, pid: b.pid, startedAt: b.startedAt } : null;
}

const before = await pin();
if (!before?.commit) blind('pin unreadable before the probe');
console.log(`# pin BEFORE  commit=${before.commit} pid=${before.pid} startedAt=${before.startedAt}`);
if (EXPECT && !before.commit.startsWith(EXPECT)) {
  blind(`live commit ${before.commit} is not the graded build ${EXPECT}`);
}

const fee = await fetch(`${HOST}/api/health/live-options-fee-slippage`).then(r => r.json()).catch(() => null);
if (!fee) blind('fee/slippage route unreadable');

const A = fee.aggregateCapUsd;
const bound = fee.aggregateFleetBound;
const armed = (fee.aggregateExposure ?? []).filter(r => r.liveEntryGateOpen === true);
if (!bound) blind('aggregateFleetBound absent — nothing to grade');
if (armed.length === 0) blind('no gate-open books — the subject is empty, so no verdict here means anything');

// ⭐ A PASS COMPUTED ONE BOOK SHORT IS NOT A PASS OVER THE ARM (TRA-3723).
//
// Measured on THIS ticket's own first grading run: 36 seconds after the
// 00:45:58Z boot, `v0nni` had no balance yet and served `capUsd 0`,
// `headroomSignedUsd null`. Every criterion below still passed — because a dark
// book admits nothing, so the arithmetic is genuinely correct — and the run
// would have reported the reachable bound PROVEN while the only book the fleet
// term can actually bind was contributing zero. `admissibleEntryUsd 0` from
// `no_balance_snapshot` and `admissibleEntryUsd 0` from the fleet term are the
// same bytes and completely different evidence.
//
// BLIND, not FAIL: nothing is wrong, we simply cannot see the arm yet. Re-run
// once balances read.
const dark = armed.filter(
  r => typeof r.availableCashUsd !== 'number' || !Number.isFinite(r.availableCashUsd),
);
if (dark.length > 0) {
  blind(
    `${dark.length}/${armed.length} armed book(s) have NO BALANCE SNAPSHOT (${dark.map(r => r.book ?? '<unnamed>').join(', ')})`
    + ' — they contribute capUsd 0 and admit nothing, so every criterion below would pass on an arm'
    + ' this run cannot see. Typically the first ~1-2 min after a boot. Re-run.',
  );
}

// ---------------------------------------------------------------------------
// AC1 — the ORDER PATH publishes, and honours, the admissible bound.
// ---------------------------------------------------------------------------
// ⭐ DEPLOYED-BYTES PROOF FIRST. Field PRESENCE, via hasOwnProperty — a deploy
// order's commit is a lower bound on CONTENT, not an expected reading
// (TRA-3660). `undefined` and "absent" must not share a test.
const AC1_KEYS = [
  'admissibleEntryUsd', 'admissibleBoundBy', 'bookHeadroomSignedUsd',
  'fleetHeadroomSignedUsd', 'fleetAtRiskUsd', 'fleetAtRiskBooks',
];
for (const k of AC1_KEYS) {
  const missing = armed.filter(r => !Object.prototype.hasOwnProperty.call(r, k)).map(r => r.book);
  check(`AC1 presence ${k}`, missing.length === 0,
    missing.length === 0 ? `on all ${armed.length} armed row(s)` : `ABSENT on: ${missing.join(', ')}`);
}

const fleetAtRisk = armed.reduce((a, r) => a + cents(r.openPremiumAtRiskUsd ?? 0), 0) / 100;

/**
 * The AC1 identity, recomputed from the row's OWN operands and compared to what
 * the row served. Cross-column on purpose (TRA-3881: read one column twice and
 * the check is vacuous) — `capUsd` and `openPremiumAtRiskUsd` are the columns
 * the order site sized from, `admissibleEntryUsd` is what it concluded.
 */
const admissibleIdentity = (r, sigmaAtRisk) => {
  const bookHead = (cents(r.capUsd) - cents(r.openPremiumAtRiskUsd)) / 100;
  const fleetHead = sigmaAtRisk === null ? null : (cents(A) - cents(sigmaAtRisk)) / 100;
  const binding = fleetHead === null ? bookHead : Math.min(bookHead, fleetHead);
  return {
    expected: Math.max(0, Math.floor(binding * 100) / 100),
    bookHead,
    fleetHead,
  };
};

for (const r of armed) {
  const id = admissibleIdentity(r, r.fleetAtRiskUsd === null ? null : fleetAtRisk);
  check(
    `AC1 identity ${r.book}`,
    cents(r.admissibleEntryUsd) === cents(id.expected)
      && cents(r.bookHeadroomSignedUsd) === cents(id.bookHead),
    `served ${usd(r.admissibleEntryUsd)} vs max(0, min(cap ${usd(r.capUsd)} - atRisk `
    + `${usd(r.openPremiumAtRiskUsd)} = ${usd(id.bookHead)}, A ${usd(A)} - SumAtRisk `
    + `${usd(fleetAtRisk)} = ${usd(id.fleetHead)})) = ${usd(id.expected)} `
    + `[boundBy ${r.admissibleBoundBy}]`,
  );
  // The fleet fold must SEE the whole arm. A fold one book short bounds the
  // fleet on a subset and calls it the fleet — the same defect one level up.
  check(
    `AC1 coverage ${r.book}`,
    r.fleetAtRiskBooks === armed.length && cents(r.fleetAtRiskUsd ?? -1) === cents(fleetAtRisk),
    `row folded ${r.fleetAtRiskBooks} book(s) / ${usd(r.fleetAtRiskUsd)}; the arm is `
    + `${armed.length} book(s) / ${usd(fleetAtRisk)}`,
  );
  // ⚠ `fleet_unreadable` is an ADMIT and it is the ONE state where the fleet
  // term is not in force. It must never pass as enforcement.
  check(
    `AC1 in force ${r.book}`,
    r.admissibleBoundBy !== 'fleet_unreadable' && r.admissibleBoundBy != null,
    `boundBy = ${r.admissibleBoundBy}`,
  );
}

// ⭐ THE AC1 PASS ITSELF: the bound DELIVERS. Not "the numbers match today" —
// `Sum atRisk + Sum admissible <= A` is the property `Sum B_i <= A` could never
// state, and it is what the CEO ruling asked for.
const reachable = Math.round(
  (cents(fleetAtRisk) + armed.reduce((a, r) => a + cents(r.admissibleEntryUsd ?? 0), 0)) ,
) / 100;
check('AC1 reachable <= A', cents(reachable) <= cents(A),
  `reachable ${usd(reachable)} = SumAtRisk ${usd(fleetAtRisk)} + SumAdmissible `
  + `${usd(reachable - fleetAtRisk)} vs A ${usd(A)}`);

// ---------------------------------------------------------------------------
// AC2 — the VERDICT consumes the signed column and publishes reachable.
// ---------------------------------------------------------------------------
const AC2_KEYS = [
  'reachableSumUsd', 'reachableOverageUsd', 'grandfatheredExcessUsd',
  'fleetAtRiskUsd', 'sumAdmissibleEntryUsd', 'reachableBoundEnforced',
];
for (const k of AC2_KEYS) {
  check(`AC2 presence ${k}`, Object.prototype.hasOwnProperty.call(bound, k),
    Object.prototype.hasOwnProperty.call(bound, k) ? `= ${JSON.stringify(bound[k])}` : 'ABSENT');
}
check('AC2 sumBookCapUsd is still published alongside', typeof bound.sumBookCapUsd === 'number',
  `Sum B_i = ${usd(bound.sumBookCapUsd)} (the two quantities must never again be confused)`);
check('AC2 reachableSumUsd identity', cents(bound.reachableSumUsd ?? -1) === cents(reachable),
  `served ${usd(bound.reachableSumUsd)} vs recomputed ${usd(reachable)}`);
const grandfathered = armed.reduce(
  (a, r) => a + Math.max(0, -cents(r.headroomSignedUsd ?? 0)), 0,
) / 100;
check('AC2 grandfatheredExcessUsd identity', cents(bound.grandfatheredExcessUsd ?? -1) === cents(grandfathered),
  `served ${usd(bound.grandfatheredExcessUsd)} vs Sum max(0, -headroomSignedUsd) = ${usd(grandfathered)}`);
check('AC2 reachableBoundEnforced', bound.reachableBoundEnforced === true,
  `= ${bound.reachableBoundEnforced}`);
check('AC2 verdict is about REACHABLE', cents(bound.reachableOverageUsd ?? -1) === 0
  ? bound.verdict === 'within'
  : bound.verdict === 'breach' || bound.verdict === 'rounding_only',
  `verdict ${bound.verdict} at reachableOverage ${usd(bound.reachableOverageUsd)}`);

// ---------------------------------------------------------------------------
// AC4 — what must NOT have moved.
// ---------------------------------------------------------------------------
check('AC4 notionalCapUsd $300', fee.notionalCapUsd === 300, `= ${fee.notionalCapUsd}`);
check('AC4 aggregateCapUsd $500', fee.aggregateCapUsd === 500, `= ${fee.aggregateCapUsd}`);
check('AC4 ratificationMatchesLive', fee.ratificationMatchesLive === true, `= ${fee.ratificationMatchesLive}`);
check('AC4 horizon 2026-12-31T21:00:00.000Z', fee.arm?.testUntilIso === '2026-12-31T21:00:00.000Z',
  `= ${fee.arm?.testUntilIso}`);
check('AC4 otmArmed unchanged (true)', fee.arm?.otmArmed === true, `= ${fee.arm?.otmArmed}`);

// ---------------------------------------------------------------------------
// CONTROLS — every assertion above is vacuous unless these can fail.
// ---------------------------------------------------------------------------
// C1 — the identity checker MUST reject a mutated row. Without this, "served
// equals recomputed" could be true because both sides read the same field.
const victim = armed[0];
const mutated = { ...victim, admissibleEntryUsd: (victim.admissibleEntryUsd ?? 0) + 1 };
const mid = admissibleIdentity(mutated, fleetAtRisk);
check('C1 identity checker rejects a row inflated by $1.00',
  cents(mutated.admissibleEntryUsd) !== cents(mid.expected),
  `mutated ${usd(mutated.admissibleEntryUsd)} vs identity ${usd(mid.expected)} — the predicate fires`);

// C2 — the presence test must be able to see an absent key, or every "present"
// row above proves nothing about deployed bytes.
check('C2 presence test sees an absent key',
  !Object.prototype.hasOwnProperty.call(victim, '__tra3911_control_absent__'),
  'hasOwnProperty returns false for a key nobody publishes');

// C3 — the fleet fold must be taken on `liveEntryGateOpen`, never on `mode`.
// bqb1 carries three `mode: 'live'` books and two armed ones (TRA-3445).
const byMode = (fee.aggregateExposure ?? []).filter(r => r.mode === 'live');
check('C3 gate-open != mode-live on this host (the fold is on the right field)',
  byMode.length >= armed.length,
  `mode:'live' rows ${byMode.length}, gate-open rows ${armed.length}`
  + (byMode.length > armed.length ? ' — a mode-based fold would overstate the arm' : ''));

// ---------------------------------------------------------------------------
const after = await pin();
console.log(`# pin AFTER   commit=${after?.commit} pid=${after?.pid} startedAt=${after?.startedAt}`);
if (!after || after.commit !== before.commit || after.pid !== before.pid || after.startedAt !== before.startedAt) {
  blind('pin MOVED across the probe — the rows would be a mix of two builds');
}

console.log(`\n# FLEET AS READ (route stamp ${fee.time})`);
for (const r of armed) {
  console.log(
    `  ${r.book}  cap ${usd(r.capUsd)}  atRisk ${usd(r.openPremiumAtRiskUsd)}  `
    + `headroomSigned ${usd(r.headroomSignedUsd)}  admissible ${usd(r.admissibleEntryUsd)} `
    + `[${r.admissibleBoundBy}]`,
  );
}
console.log(
  `  Sum B_i ${usd(bound.sumBookCapUsd)} | Sum atRisk ${usd(bound.fleetAtRiskUsd)} | `
  + `Sum admissible ${usd(bound.sumAdmissibleEntryUsd)} | REACHABLE ${usd(bound.reachableSumUsd)} `
  + `vs A ${usd(A)} | grandfathered ${usd(bound.grandfatheredExcessUsd)} | verdict ${bound.verdict}`,
);

console.log('');
let failed = 0;
for (const r of rows) {
  if (!r.ok) failed += 1;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  --  ${r.detail}`);
}
console.log(`\n${rows.length - failed}/${rows.length} criteria pass.`);
if (failed > 0) { console.log('FAIL'); process.exit(1); }
console.log('PASS — the reachable bound is ENFORCING on this pinned build.');
process.exit(0);
