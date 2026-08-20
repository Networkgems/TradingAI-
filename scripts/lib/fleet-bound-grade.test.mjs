// TRA-3737 — control suite for the fleet-bound READER.
//
// Every scenario is built from `scripts/fixtures/tra3737-live-breach-2026-08-20.json`,
// a VERBATIM capture of bqb1 `a689158c9157` taken at 2026-08-20T03:1xZ while the
// route was serving `breach` — i.e. the positive control is the real incident, not
// numbers typed into a test. A test asserting literals it typed itself proves only
// that arithmetic works (TRA-3723).
//
// The suite has to prove the reader discriminates in BOTH directions, because a
// reader that is always red gets ignored — the same end state as no reader — and a
// reader that is never red is the empty room TRA-3737 was filed about.
//
//   pnpm check:fleet-bound:controls

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeFleetBound, EXIT } from './fleet-bound-grade.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE = path.join(HERE, '..', 'fixtures', 'tra3737-live-breach-2026-08-20.json');
// TRA-3737 §2 — the SECOND real capture: bqb1 `2e4654b142d4` at 2026-08-20T04:07Z,
// ~13 min after TRA-3879's fix went live, serving `within` with `φ_eff` BINDING
// over a complete 2/2 population. The green control is now a real reading of the
// fixed host rather than a mutation of the broken one, so "the reader goes green"
// is evidence about the system and not about my edit to a fixture.
const FIXED = path.join(HERE, '..', 'fixtures', 'tra3737-live-bound-in-force-2026-08-20.json');
const AT = '2026-08-20T03:20:00.000Z';

const capture = JSON.parse(fs.readFileSync(CAPTURE, 'utf8'));
const clone = () => JSON.parse(JSON.stringify(capture));
const grade = over => gradeFleetBound({ ...clone(), expectCommit: null, measuredAt: AT, ...over });

const fixed = JSON.parse(fs.readFileSync(FIXED, 'utf8'));
const cloneFixed = () => JSON.parse(JSON.stringify(fixed));
const gradeFixed = over => gradeFleetBound({ ...cloneFixed(), expectCommit: null, measuredAt: AT, ...over });
/** The armed rows of the post-fix capture, by reference into a fresh clone. */
const armedOf = fee => fee.aggregateExposure.filter(r => r.liveEntryGateOpen === true);

test('the capture really is the incident — otherwise every control below is vacuous', () => {
  assert.equal(capture.live.build.commitShort, 'a689158c9157');
  assert.equal(capture.fee.aggregateFleetBound.verdict, 'breach');
  assert.equal(capture.fee.aggregateCapUsd, 500, 'A tightened to $500 by TRA-3827');
  assert.equal(capture.fee.arm.otmArmed, true, 'the sleeve was ARMED — this is a real-money path');
});

test('POSITIVE CONTROL: the live breach exits 1', () => {
  const { verdict, code, out } = grade();
  assert.equal(verdict, 'BREACH');
  assert.equal(code, EXIT.BREACH);
  assert.match(out.reason, /FLEET FAIL-OPEN/);
  assert.equal(out.sumBookCapUsd, 558.68);
});

test('the client sum reproduces the server sum to the cent — two independent adders agree', () => {
  const { out } = grade();
  assert.equal(out.sumBookCapUsd, capture.fee.aggregateFleetBound.sumBookCapUsd);
  assert.ok(out.sumBookCapUsd > out.fleetCapUsd, 'Σ B_i must exceed A on this capture');
});

test('NEGATIVE CONTROL: the same rows under the OLD $750 authorization read CLEAN, exit 0', () => {
  // The pre-fix path: no served grade (old build), A back at $750. Σ B_i $558.68
  // fits, so a reader that cannot say CLEAN would page on every fire and be muted
  // inside a week.
  const fee = clone().fee;
  delete fee.aggregateFleetBound;
  fee.aggregateCapUsd = 750;
  const { verdict, code } = gradeFleetBound({ live: clone().live, fee, measuredAt: AT });
  assert.equal(verdict, 'CLEAN');
  assert.equal(code, EXIT.CLEAN);
});

test('the client fallback ALSO catches the breach on a pre-fix build — the detector is not the only witness', () => {
  const fee = clone().fee;
  delete fee.aggregateFleetBound; // an old build serves rows but no verdict
  const { verdict, code } = gradeFleetBound({ live: clone().live, fee, measuredAt: AT });
  assert.equal(verdict, 'BREACH');
  assert.equal(code, EXIT.BREACH);
});

test('a served `rounding_only` is not a breach — the disclosed slack must not page', () => {
  const fee = clone().fee;
  fee.aggregateFleetBound.verdict = 'rounding_only';
  const { verdict, code } = gradeFleetBound({ live: clone().live, fee, measuredAt: AT });
  assert.equal(verdict, 'CLEAN');
  assert.equal(code, EXIT.CLEAN);
});

test('a served `blind` is BLIND, never CLEAN — could-not-check must not share a code with fine', () => {
  const fee = clone().fee;
  fee.aggregateFleetBound.verdict = 'blind';
  const { code } = gradeFleetBound({ live: clone().live, fee, measuredAt: AT });
  assert.equal(code, EXIT.BLIND);
  assert.notEqual(EXIT.BLIND, EXIT.CLEAN);
});

test('BLIND: no build block — an unpinned reading of a money host is not evidence', () => {
  const { code, out } = gradeFleetBound({ live: {}, fee: clone().fee, measuredAt: AT });
  assert.equal(code, EXIT.BLIND);
  assert.match(out.reason, /cannot pin the reading/);
});

test('BLIND: a pin mismatch never reads as a pass', () => {
  const { code, out } = grade({ expectCommit: 'deadbeef0000' });
  assert.equal(code, EXIT.BLIND);
  assert.match(out.reason, /pin MISMATCH/);
});

test('BLIND beats BREACH: a stale build serving a breach is still BLIND under a pin', () => {
  // Precedence matters — a mismatched pin means we do not know WHAT we measured,
  // and a breach attributed to the wrong build is a false accusation.
  const { verdict } = grade({ expectCommit: 'notthebuild1' });
  assert.equal(verdict, 'BLIND');
});

test('BLIND: neither aggregateFleetBound nor aggregateExposure wired', () => {
  const { code, out } = gradeFleetBound({ live: clone().live, fee: {}, measuredAt: AT });
  assert.equal(code, EXIT.BLIND);
  assert.match(out.reason, /neither aggregateFleetBound nor aggregateExposure/);
});

test('BLIND: pre-fix build with no usable aggregateCapUsd', () => {
  const fee = clone().fee;
  delete fee.aggregateFleetBound;
  fee.aggregateCapUsd = 0;
  const { code, out } = gradeFleetBound({ live: clone().live, fee, measuredAt: AT });
  assert.equal(code, EXIT.BLIND);
  assert.match(out.reason, /no usable aggregateCapUsd/);
});

test('BLIND: the host is unreachable — the fetch throws, and the caller must not read 0', () => {
  // The reader's fetch failure path exits 3 in the CLI; here we assert the grader
  // cannot be handed `undefined` and produce a pass.
  const { code } = gradeFleetBound({ live: undefined, fee: undefined, measuredAt: AT });
  assert.equal(code, EXIT.BLIND);
});

test('COVERAGE is graded separately from CORRECTNESS — a pass one book short says so', () => {
  const fee = clone().fee;
  fee.aggregateFleetBound.verdict = 'within';
  fee.aggregateFleetBound.unreadableBalanceBooks = ['v0nni'];
  const { verdict, out } = gradeFleetBound({ live: clone().live, fee, measuredAt: AT });
  assert.equal(verdict, 'CLEAN');
  assert.match(out.partial, /covers 2\/3 of the arm/);
  assert.equal(out.coverage.eligibleBooks, 3);
});

test('the partial marker DISCRIMINATES: absent when every book was readable', () => {
  const fee = clone().fee;
  fee.aggregateFleetBound.verdict = 'within';
  const { out } = gradeFleetBound({ live: clone().live, fee, measuredAt: AT });
  assert.equal(out.partial, undefined, 'a marker that fires on every verdict is boilerplate');
});

test('the partial marker NEVER hedges a breach — the overage is real whatever the dark book adds', () => {
  const fee = clone().fee;
  fee.aggregateFleetBound.unreadableBalanceBooks = ['v0nni'];
  const { verdict, out } = gradeFleetBound({ live: clone().live, fee, measuredAt: AT });
  assert.equal(verdict, 'BREACH');
  assert.equal(out.partial, undefined);
});

test('FLATNESS IS NOT HEADROOM: both books flat, and the verdict is still BREACH', () => {
  // CEO, 2026-08-20: "Do not treat the book is flat as headroom. Flatness is a
  // measurement with a timestamp, not a property." The capture HAS openRows 0 on
  // both armed books, so this is the live shape, not a constructed one.
  const { out, verdict } = grade();
  assert.ok(out.armedBooks.every(b => b.openRows === 0 && b.openPremiumAtRiskUsd === 0));
  assert.equal(verdict, 'BREACH');
});

test('the arm is read off the FEE-SLIPPAGE route, not options-live', () => {
  // /api/health/options-live has NO `arm` object at all; reading `live.arm.otmArmed`
  // yields null, which reads exactly like DISARMED and is not (TRA-3689).
  assert.equal(capture.live.arm, undefined);
  const { out } = grade();
  assert.equal(out.arm.otmArmed, true);
});

test('pid is published but flagged as a non-discriminator', () => {
  const { out } = grade();
  assert.equal(out.pidIsNotARestartDiscriminator, true);
  assert.ok(out.build.startedAt, 'startedAt + commitShort are the pin');
});

// --------------------------------------------------------------------------
// TRA-3737 §2 — "Σ B_i fits" and "the bound that makes it fit is in force" are
// TWO CLAIMS, and until now the reader only ever asked the first. The states
// below all serve `within`; the reader has to separate them.
// --------------------------------------------------------------------------

test('the post-fix capture really is the fixed host — otherwise every green control below is vacuous', () => {
  assert.equal(fixed.live.build.commitShort, '2e4654b142d4');
  assert.equal(fixed.fee.aggregateFleetBound.verdict, 'within');
  assert.equal(fixed.fee.aggregateFleetBound.sumBookCapUsd, 499.99);
  assert.equal(fixed.fee.aggregateCapUsd, 500);
  assert.equal(fixed.fee.arm.otmArmed, true, 'still a real-money armed path — the fix did not dark the sleeve');
  const armed = armedOf(fixed.fee);
  assert.equal(armed.length, 2, 'coverage 2/2 — a fix graded one book short is the §x80 trap');
  assert.ok(armed.every(r => r.fleetSizingReason === 'phi_fleet_derived'));
});

test('GREEN CONTROL: the fixed host reads CLEAN and the bound is IN FORCE', () => {
  const { verdict, code, out } = gradeFixed();
  assert.equal(verdict, 'CLEAN');
  assert.equal(code, EXIT.CLEAN);
  assert.equal(out.boundInForce.inForce, true);
  assert.deepEqual(out.boundInForce.sizingReasons, ['phi_fleet_derived']);
});

test('the in-force test is ARITHMETIC: φ_eff · Σ E_i lands on A to the cent on the real capture', () => {
  // This is the invariant, restated as the assertion. If it ever stops holding on
  // a live reading, `Σ B_i ≤ φ_eff · Σ E_i ≤ A` stops being derivable.
  const armed = armedOf(cloneFixed().fee);
  const phi = armed[0].fleetRiskFractionEffective;
  const capital = armed[0].fleetCapitalUsd;
  assert.equal(Math.round(phi * capital * 100) / 100, 500);
  assert.equal(capital, 1150.04);
});

test('UNBOUND: `fleet_capital_unreadable` is NOT a pass, even though Σ B_i fits', () => {
  // The one state TRA-3879 explicitly leaves the sum unbounded in. The server is
  // honest about it and still serves `within`, because today's balances fit.
  const fee = cloneFixed().fee;
  for (const r of armedOf(fee)) {
    r.fleetSizingReason = 'fleet_capital_unreadable';
    r.fleetCapitalUsd = null;
    r.fleetCapitalBooks = 0;
    r.fleetRiskFractionEffective = r.fleetRiskFraction;
  }
  const { verdict, code, out } = gradeFleetBound({ live: cloneFixed().live, fee, measuredAt: AT });
  assert.equal(verdict, 'UNBOUND');
  assert.equal(code, EXIT.UNBOUND);
  assert.notEqual(EXIT.UNBOUND, EXIT.CLEAN, 'a non-pass must never share the pass code');
  assert.equal(out.servedVerdict, 'within', 'the SERVER still said within — that is the whole point');
  assert.match(out.reason, /BOUND NOT IN FORCE/);
  assert.match(out.boundInForce.reason, /fleet read was unusable/);
});

test('UNBOUND: a PARTIAL fleet read — the §x80 trap, measured 28s after the real boot', () => {
  // v0nni had no balance snapshot, so `Σ E_i` was admin alone, `A/Σ E_i` did not
  // bind, φ did — and the route published `within` on the FIXED build with the fix
  // doing nothing. Understating `Σ E_i` always loosens the bound.
  const fee = cloneFixed().fee;
  for (const r of armedOf(fee)) {
    r.fleetCapitalUsd = 750.04; // admin only
    r.fleetCapitalBooks = 1;
    r.fleetRiskFractionEffective = r.fleetRiskFraction; // 0.4858 — φ won
    r.fleetSizingReason = 'phi_configured'; // a REASSURING name for the failure
  }
  const { verdict, code, out } = gradeFleetBound({ live: cloneFixed().live, fee, measuredAt: AT });
  assert.equal(verdict, 'UNBOUND');
  assert.equal(code, EXIT.UNBOUND);
  assert.match(out.boundInForce.reason, /BELOW the \$1150\.04 this reader can see/);
});

test('the in-force test is a PROPERTY, not a ban list of reason strings', () => {
  // A future `fleetSizingReason` nobody has written yet must still be caught if the
  // arithmetic does not hold. Name it something soothing and check it still fails.
  const fee = cloneFixed().fee;
  for (const r of armedOf(fee)) {
    r.fleetSizingReason = 'phi_reconciled_ok';
    r.fleetRiskFractionEffective = 0.4858; // φ_eff · Σ E_i = $558.68 > A $500
  }
  const { verdict, out } = gradeFleetBound({ live: cloneFixed().live, fee, measuredAt: AT });
  assert.equal(verdict, 'UNBOUND');
  assert.match(out.boundInForce.reason, /does not deliver the bound/);
  assert.deepEqual(out.boundInForce.sizingReasons, ['phi_reconciled_ok'], 'reported as evidence, never branched on');
});

test('`phi_configured` over a COMPLETE fleet read is genuinely in force — the reader must not cry wolf', () => {
  // The pre-TRA-3879 posture is SAFE whenever `Σ E_i ≤ A/φ` actually holds. If the
  // reader flagged it anyway it would be red on the correct state, and a reader
  // that is always red is muted inside a week — the empty room again.
  const fee = cloneFixed().fee;
  for (const r of armedOf(fee)) {
    r.availableCashUsd = 500; // Σ E_i = $1000 ≤ A/φ $1029.23
    r.capUsd = 242.9;
    r.fleetCapitalUsd = 1000;
    r.fleetCapitalBooks = 2;
    r.fleetRiskFractionEffective = 0.4858;
    r.fleetSizingReason = 'phi_configured';
  }
  fee.aggregateFleetBound.sumBookCapUsd = 485.8;
  const { verdict, out } = gradeFleetBound({ live: cloneFixed().live, fee, measuredAt: AT });
  assert.equal(verdict, 'CLEAN');
  assert.equal(out.boundInForce.inForce, true);
});

test('UNBOUND NEVER hedges a BREACH — the overage is unconditional', () => {
  // Same discipline as the partial marker. Re-labelling a live fail-open with a
  // more procedural word is how a loud finding gets re-read as a caveat.
  const fee = cloneFixed().fee;
  fee.aggregateFleetBound.verdict = 'breach';
  fee.aggregateFleetBound.reason = 'FLEET FAIL-OPEN: synthetic';
  for (const r of armedOf(fee)) {
    r.fleetSizingReason = 'fleet_capital_unreadable';
    r.fleetCapitalUsd = null;
    r.fleetCapitalBooks = 0;
  }
  const { verdict, code, out } = gradeFleetBound({ live: cloneFixed().live, fee, measuredAt: AT });
  assert.equal(verdict, 'BREACH');
  assert.equal(code, EXIT.BREACH);
  assert.equal(out.boundInForce.inForce, false, 'still PUBLISHED — it just does not change the verdict');
  assert.equal(out.servedReason, undefined);
});

test('UNBOUND never hedges a BLIND either — we do not know what we measured', () => {
  const fee = cloneFixed().fee;
  for (const r of armedOf(fee)) { r.fleetCapitalUsd = null; r.fleetCapitalBooks = 0; }
  const { verdict, code } = gradeFleetBound({ live: cloneFixed().live, fee, expectCommit: 'deadbeef0000', measuredAt: AT });
  assert.equal(verdict, 'BLIND');
  assert.equal(code, EXIT.BLIND);
});

test('a PRE-TRA-3879 build reports `inForce: null` and does NOT flip red', () => {
  // The 2026-08-20 breach capture predates the fleet-sizing block entirely. On such
  // bytes the sum genuinely is unbounded — but that is the TRA-3723 world the served
  // `verdict` already covers, and flipping every old build red would mute the reader.
  // It is published loudly instead of graded silently.
  const armed = armedOf(clone().fee);
  assert.ok(armed.every(r => !('fleetRiskFractionEffective' in r)), 'the breach capture must predate the block');
  const fee = clone().fee;
  delete fee.aggregateFleetBound;
  fee.aggregateCapUsd = 750; // the old authorization ⇒ $558.68 fits
  const { verdict, code, out } = gradeFleetBound({ live: clone().live, fee, measuredAt: AT });
  assert.equal(verdict, 'CLEAN');
  assert.equal(code, EXIT.CLEAN);
  assert.equal(out.boundInForce.inForce, null);
  assert.match(out.boundInForce.reason, /pre-TRA-3879 bytes/);
});

test('the in-force block is published on EVERY verdict, including the untouched breach', () => {
  // A field that only appears when it is bad cannot be asserted on by anyone
  // downstream, and its absence reads as "fine" rather than "not measured".
  for (const g of [grade(), gradeFixed()]) {
    assert.ok(Object.prototype.hasOwnProperty.call(g.out, 'boundInForce'));
    assert.ok('inForce' in g.out.boundInForce);
  }
});
