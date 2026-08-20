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

// ⚠ RE-BASED onto the GREEN capture by TRA-3737 §3. It used to relabel the
// BREACH capture, whose rows sum to $558.68 against A $500 — and §3 reads the
// ROWS, so that premise became self-contradictory ("the served label says fine"
// vs "the books plainly reach past A") and the reader correctly refused it. The
// claim under test here is the SERVED-VERDICT MAPPING, so it belongs on a
// fixture whose rows genuinely fit. The behaviour that flipped is asserted
// deliberately in the next test rather than deleted with the premise.
test('a served `rounding_only` is not a breach — the disclosed slack must not page', () => {
  const fee = cloneFixed().fee;
  fee.aggregateFleetBound.verdict = 'rounding_only';
  const { verdict, code } = gradeFleetBound({ live: cloneFixed().live, fee, measuredAt: AT });
  assert.equal(verdict, 'CLEAN');
  assert.equal(code, EXIT.CLEAN);
});

test('a soothing LABEL does not buy silence over rows that reach past A', () => {
  // TRA-3881's rule, applied to the new verdict: suppress on ARITHMETIC, never
  // on a reason name. Relabelling a $558.68 fleet `rounding_only` must not make
  // it read clean, or a regression at the order site can purchase its own quiet
  // by renaming itself.
  const fee = clone().fee;
  fee.aggregateFleetBound.verdict = 'rounding_only';
  const { verdict, code, out } = gradeFleetBound({ live: clone().live, fee, measuredAt: AT });
  assert.equal(verdict, 'EXPOSURE');
  assert.equal(code, 1);
  assert.equal(out.priorVerdict, 'CLEAN', 'the served label DID map to a pass — the rows overrode it');
  assert.ok(out.reachableExposure.reachableUsd > out.reachableExposure.fleetCapUsd);
});

test('the φ-rounding slack is honoured: A + 5¢ on a FLAT fleet is not an exposure finding', () => {
  // The bug this pair caught. On a flat fleet `reachable ≡ Σ B_i`, so a float
  // epsilon here would page on exactly the disclosed 5¢ that `rounding_only`
  // exists to keep un-spendable in either direction.
  const fee = cloneFixed().fee;
  const A = fee.aggregateCapUsd;
  const armed = armedOf(fee);
  armed[0].capUsd = Math.round((armed[0].capUsd + (A + 0.05 - fee.aggregateFleetBound.sumBookCapUsd)) * 100) / 100;
  const { out } = gradeFleetBound({ live: cloneFixed().live, fee, measuredAt: AT });
  assert.equal(out.reachableExposure.reachableUsd, A + 0.05, 'set up 5¢ over A');
  assert.ok(out.reachableExposure.slackUsd >= 0.05, `slack ${out.reachableExposure.slackUsd} must cover the disclosed rounding`);
  assert.equal(out.reachableExposure.breach, false);
  // …and the slack is SCALED, not flat: a dollar over is still a finding.
  armed[0].capUsd = Math.round((armed[0].capUsd + 1) * 100) / 100;
  const g2 = gradeFleetBound({ live: cloneFixed().live, fee, measuredAt: AT });
  assert.equal(g2.out.reachableExposure.breach, true, 'the tolerance must not swallow a real dollar');
  assert.equal(g2.verdict, 'EXPOSURE');
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

// ⚠ RE-BASED onto the GREEN capture by TRA-3737 §3, same reason as the
// `rounding_only` control above: the claim under test is the PARTIAL MARKER, and
// riding a row set that reaches $558.68 past A made the expected CLEAN
// self-contradictory once the reader started reading rows.
test('COVERAGE is graded separately from CORRECTNESS — a pass one book short says so', () => {
  const fee = cloneFixed().fee;
  fee.aggregateFleetBound.verdict = 'within';
  fee.aggregateFleetBound.unreadableBalanceBooks = ['ghost'];
  // The third eligible book must also be inside the fleet read's own coverage
  // claim, or TRA-3880's `fleetCapitalBooks >= eligibleBooks` fires and the
  // reading is UNBOUND for a reason that has nothing to do with the marker under
  // test. Isolating the claim, not weakening it — the coverage check has its own
  // controls above.
  for (const r of armedOf(fee)) r.fleetCapitalBooks = 3;
  const { verdict, out } = gradeFleetBound({ live: cloneFixed().live, fee, measuredAt: AT });
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

// ---------------------------------------------------------------------------
// TRA-3881 — the reader has to say WHICH capital instrument governs.
//
// The 2026-08-20T04:06Z reading was healthy in every way that matters — `within`,
// φ_eff binding, 2/2 coverage — and it published `fleetCapitalHeadroomUsd
// −$120.81`, because `A/φ` describes a precondition TRA-3879 retired. That
// number was in this reader's own escalation checklist. A permanent false alarm
// and a deleted alarm end in the same place.
//
// Every scenario below is built from a REAL capture. The `phi_fleet_derived`
// branch is the live 04:07Z payload untouched; the other branches are the same
// bytes with the server's TRA-3881 fields grafted on, because bqb1 has not shipped
// them yet — which is exactly what the deployed-bytes AC1 grade is for.
// ---------------------------------------------------------------------------

test('TRA-3881 — the FIXED capture really carries the false alarm this ticket is about', () => {
  const served = cloneFixed().fee.aggregateFleetBound;
  assert.equal(served.verdict, 'within', 'a healthy reading');
  assert.ok(served.fleetCapitalHeadroomUsd < 0, 'and a negative headroom beside it');
  assert.ok(armedOf(cloneFixed().fee).every(r => r.fleetSizingReason === 'phi_fleet_derived'));
  assert.equal(gradeFixed().verdict, 'CLEAN');
});

test('TRA-3881 — on PRE-3881 bytes the stale negative headroom is labelled DO-NOT-ESCALATE, not paged', () => {
  const g = gradeFixed();
  assert.equal(g.verdict, 'CLEAN', 'the verdict must not move — this is a labelling fix, not a grade');
  assert.equal(g.code, EXIT.CLEAN);
  assert.equal(g.out.boundInForce.inForce, true, 'the TRA-3879 bound WAS in force on this reading');
  assert.equal(g.out.fleetCapital.ceilingBasis, null, 'these bytes predate TRA-3881');
  assert.equal(g.out.fleetCapital.staleFittedCeiling, true);
  assert.match(g.out.fleetCapital.doNotEscalate, /KNOWN STALE-φ artifact/);
  assert.match(g.out.fleetCapital.governing, /UNKNOWN/);
});

test('TRA-3881 — the DO-NOT-ESCALATE label DISCRIMINATES: it stays off when the bound is not in force', () => {
  // A marker that fires on every reading is boilerplate (TRA-3723). Same negative
  // headroom, but the fleet read is unusable — so the sum really IS unbounded and
  // the negative number is a finding, not an artifact. The label must vanish.
  const fee = cloneFixed().fee;
  for (const r of armedOf(fee)) {
    r.fleetCapitalUsd = null;
    r.fleetSizingReason = 'fleet_capital_unreadable';
  }
  const g = gradeFleetBound({ live: cloneFixed().live, fee, measuredAt: AT });
  assert.ok(fee.aggregateFleetBound.fleetCapitalHeadroomUsd < 0, 'still negative');
  assert.equal(g.out.boundInForce.inForce, false);
  assert.equal(g.out.fleetCapital.staleFittedCeiling, false);
  assert.equal(g.out.fleetCapital.doNotEscalate, undefined);
  assert.equal(g.verdict, 'UNBOUND', 'and it is a real finding — exit 3, not a pass');
});

test('TRA-3881 — AC1 branch: TRA-3881 bytes withhold the fitted pair and the reader names the bound in force', () => {
  const fee = cloneFixed().fee;
  const A = fee.aggregateCapUsd;
  const capital = fee.aggregateFleetBound.fleetCapitalUsd;
  // The server bytes AC1 pre-registers: ceiling/headroom null under phi_fleet_derived.
  Object.assign(fee.aggregateFleetBound, {
    fleetCapitalCeilingUsd: null,
    fleetCapitalHeadroomUsd: null,
    fleetCapitalCeilingBasis: 'withheld — every armed book is sizing on φ_eff = A/Σ E_i (phi_fleet_derived)…',
    fleetSizingReason: 'phi_fleet_derived',
    fleetRiskFractionEffective: A / capital,
    fleetSizedMaxSumUsd: A,
    fleetSizedHeadroomUsd: 0,
  });
  const g = gradeFleetBound({ live: cloneFixed().live, fee, measuredAt: AT });
  assert.equal(g.verdict, 'CLEAN');
  assert.equal(g.out.fleetCapital.fittedHeadroomUsd, null);
  assert.equal(g.out.fleetCapital.staleFittedCeiling, false, 'nothing stale is being served any more');
  assert.equal(g.out.fleetCapital.sizedHeadroomUsd, 0);
  assert.match(g.out.fleetCapital.governing, /TRA-3879 bound/);
  assert.match(g.out.fleetCapital.governing, /does NOT apply/);
  // AC1 restated at the reader: nothing it surfaces implies an over-limit fleet.
  for (const [k, v] of Object.entries(g.out.fleetCapital)) {
    assert.ok(typeof v !== 'number' || v >= 0, `${k} must not be negative on a healthy derived reading, got ${v}`);
  }
});

test('TRA-3881 — AC3 branch: fleet_capital_unreadable keeps the pair AND keeps it negative', () => {
  const fee = cloneFixed().fee;
  const stale = fee.aggregateFleetBound.fleetCapitalHeadroomUsd;
  Object.assign(fee.aggregateFleetBound, {
    fleetCapitalCeilingBasis: 'IN FORCE — at least one armed book sized with an UNUSABLE fleet read…',
    fleetSizingReason: 'fleet_capital_unreadable',
    fleetSizedHeadroomUsd: -1,
    fleetSizedMaxSumUsd: fee.aggregateCapUsd + 1,
  });
  for (const r of armedOf(fee)) { r.fleetCapitalUsd = null; r.fleetSizingReason = 'fleet_capital_unreadable'; }
  const g = gradeFleetBound({ live: cloneFixed().live, fee, measuredAt: AT });
  assert.equal(g.out.fleetCapital.fittedHeadroomUsd, stale, 'the pair still publishes');
  assert.ok(g.out.fleetCapital.fittedHeadroomUsd < 0, 'and can still go negative — the evidence stays');
  assert.match(g.out.fleetCapital.governing, /fitted precondition/);
  assert.equal(g.out.fleetCapital.staleFittedCeiling, false, 'not an artifact here — the sum IS unbounded');
  assert.equal(g.verdict, 'UNBOUND');
});

test('TRA-3881 — the fleetCapital block is published on EVERY verdict, breach included', () => {
  // Same discipline as boundInForce: a field that appears only when it is bad
  // cannot be asserted on, and its absence reads as "fine" rather than "not measured".
  for (const g of [grade(), gradeFixed()]) {
    assert.ok(Object.prototype.hasOwnProperty.call(g.out, 'fleetCapital'));
    for (const k of ['ceilingBasis', 'fittedCeilingUsd', 'fittedHeadroomUsd', 'sizedMaxSumUsd', 'sizedHeadroomUsd', 'governing', 'staleFittedCeiling']) {
      assert.ok(k in g.out.fleetCapital, `${k} missing on the ${g.verdict} reading`);
    }
  }
  // ⚠ AND IT NEVER MUTES A BREACH. The overage is unconditional; re-labelling a
  // live fail-open with a more procedural word is how a loud finding gets re-read
  // as a caveat (TRA-3723).
  assert.equal(grade().verdict, 'BREACH');
  assert.equal(grade().out.fleetCapital.doNotEscalate, undefined);
});

// ---------------------------------------------------------------------------
// TRA-3737 §3 — REACHABLE EXPOSURE.
//
// The THIRD real capture: bqb1 `1fed3f51c65c` at 2026-08-20T20:5xZ, serving
// `within` at Σ B_i $327.75 while the fleet could reach $528.32 against a $500
// authorization. The CEO's 20:33Z finding is that the 03:07Z breach "cleared"
// with no fix shipped, because the sleeve converted $273 of cash into open
// premium and the basis is cash-only — so the metric moved the WRONG WAY as
// risk was taken. This capture is that state, verbatim.
// ---------------------------------------------------------------------------

const EXPOSED = path.join(HERE, '..', 'fixtures', 'tra3737-live-exposure-2026-08-20.json');
const exposed = JSON.parse(fs.readFileSync(EXPOSED, 'utf8'));
const cloneExposed = () => JSON.parse(JSON.stringify(exposed));
const gradeExposed = over => gradeFleetBound({ ...cloneExposed(), expectCommit: null, measuredAt: AT, ...over });

test('the exposure capture really is the state the CEO measured — otherwise the controls below are vacuous', () => {
  assert.equal(exposed.live.build.commitShort, '1fed3f51c65c');
  assert.equal(exposed.fee.aggregateFleetBound.verdict, 'within', 'the ROUTE calls this healthy — that is the defect');
  assert.equal(exposed.fee.aggregateFleetBound.sumBookCapUsd, 327.75);
  assert.equal(exposed.fee.aggregateCapUsd, 500);
  assert.equal(exposed.fee.arm.otmArmed, true, 'ARMED — real-money path');
  const admin = exposed.fee.aggregateExposure.find(r => r.book === 'admin');
  assert.equal(admin.openPremiumAtRiskUsd, 334, 'the $334 the CEO measured, outside the basis');
  assert.equal(admin.headroomUsd, 0, 'CLAMPED — max(0, cap - atRisk) deletes a $200.57 overage');
});

test('POSITIVE CONTROL: a served `within` over a fleet that can reach past A exits 1 as EXPOSURE', () => {
  const { verdict, code, out } = gradeExposed();
  assert.equal(verdict, 'EXPOSURE');
  assert.equal(code, EXIT.EXPOSURE);
  assert.equal(code, 1, 'reuses the BREACH code — a definite finding, not a could-not-certify');
  assert.equal(out.priorVerdict, 'CLEAN', 'the reader used to pass this reading');
  assert.equal(out.reachableExposure.reachableUsd, 528.32);
  assert.equal(out.reachableExposure.overageUsd, 28.32);
  assert.match(out.reason, /REACHABLE EXPOSURE/);
  assert.match(out.reason, /NOT a pass/);
});

test('the served verdict AND the bound both say healthy — so neither pre-existing check could have caught this', () => {
  // This is the whole argument for the new verdict. If either existing signal
  // already flagged it, §3 would be redundant.
  const { out } = gradeExposed();
  assert.equal(out.servedVerdict, 'within');
  assert.equal(out.boundInForce.inForce, true, 'TRA-3879/TRA-3880 grade this as FINE');
  assert.equal(out.coverage.armedBooksCovered, out.coverage.eligibleBooks, '2/2 — not a coverage artifact');
  assert.equal(out.reachableExposure.perBook.find(b => b.book === 'admin').trueHeadroomUsd, -200.57);
});

test('NEGATIVE CONTROL: on a FLAT fleet the new check reduces to Σ B_i exactly and stays green', () => {
  // ⭐ The strict-generalization property, demonstrated on a REAL capture rather
  // than asserted in prose: every atRisk_i is 0, so Σ max(cap_i, 0) ≡ Σ B_i and
  // the reader cannot turn a clean flat reading red. This is what stops the new
  // verdict from becoming a permanent alarm — and a permanent alarm is a deleted
  // alarm (TRA-3881).
  const { verdict, code, out } = gradeFixed();
  assert.equal(verdict, 'CLEAN');
  assert.equal(code, EXIT.CLEAN);
  for (const b of out.reachableExposure.perBook) assert.equal(b.openPremiumAtRiskUsd, 0);
  assert.equal(out.reachableExposure.reachableUsd, out.sumBookCapUsd, 'identical, to the cent');
  assert.equal(out.reachableExposure.breach, false);
});

test('EXPOSURE never hedges a BREACH — the overage is unconditional', () => {
  // Same discipline as UNBOUND and the partial marker: re-labelling a live
  // fail-open with a longer word is how a loud finding gets re-read as a caveat.
  const { verdict, out } = grade();
  assert.equal(verdict, 'BREACH');
  assert.equal(out.reachableExposure.breach, true, 'reachable exposure IS also over on the breach capture');
  assert.equal(out.priorVerdict, undefined, 'and it did NOT rewrite the verdict');
  assert.match(out.reason, /FLEET FAIL-OPEN/);
});

test('EXPOSURE outranks UNBOUND — a definite finding beats a could-not-certify', () => {
  const fee = cloneExposed().fee;
  for (const r of armedOf(fee)) r.fleetCapitalUsd = null;   // force bound-not-in-force
  const g = gradeFleetBound({ live: cloneExposed().live, fee, measuredAt: AT });
  assert.equal(g.out.boundInForce.inForce, false, 'the UNBOUND precondition really is met here');
  assert.equal(g.verdict, 'EXPOSURE');
  assert.equal(g.out.priorVerdict, 'UNBOUND');
  assert.equal(g.code, 1, 'and it escalates 3 -> 1, never the reverse');
});

test('EXPOSURE never touches a BLIND — we do not know what we measured', () => {
  const g = gradeFleetBound({ live: cloneExposed().live, fee: cloneExposed().fee, expectCommit: 'deadbeef0000', measuredAt: AT });
  assert.equal(g.verdict, 'BLIND');
  assert.equal(g.code, EXIT.BLIND);
});

test('the fold is max(cap, atRisk), NOT cap + atRisk — capUsd is a ceiling on TOTAL at-risk', () => {
  // `fitsLiveOptionTestAggregateCap` is `atRisk + entry <= cap`, so a book above
  // its cap can add nothing and a book below it can only climb TO the cap.
  // Summing the two would double-count and manufacture an overage on any healthy
  // fleet that happens to hold something — the false-alarm direction.
  const { out } = gradeExposed();
  const byBook = Object.fromEntries(out.reachableExposure.perBook.map(b => [b.book, b]));
  assert.equal(byBook.admin.reachableUsd, 334, 'over its cap -> pinned at at-risk');
  assert.equal(byBook.v0nni.reachableUsd, 194.32, 'under its cap -> can still climb to the cap');
  const naiveSum = out.reachableExposure.perBook.reduce((s, b) => s + b.capUsd + b.openPremiumAtRiskUsd, 0);
  assert.ok(naiveSum > out.reachableExposure.reachableUsd, 'cap+atRisk would overstate');
});

test('UNGRADED, not red, when a build publishes no openPremiumAtRiskUsd', () => {
  // Pre-TRA-3445 bytes. A reader that goes red on every old build gets muted,
  // and a muted reader is the empty room this ticket exists to close.
  const fee = cloneFixed().fee;
  for (const r of armedOf(fee)) delete r.openPremiumAtRiskUsd;
  const g = gradeFleetBound({ live: cloneFixed().live, fee, measuredAt: AT });
  assert.equal(g.out.reachableExposure.graded, false);
  assert.match(g.out.reachableExposure.reason, /pre-TRA-3445/);
  assert.equal(g.verdict, 'CLEAN', 'not graded is not a finding');
  assert.equal(g.code, EXIT.CLEAN);
});

test('the reachableExposure block is published on EVERY verdict, breach included', () => {
  // A field that appears only when it is bad cannot be asserted on, and its
  // absence reads as "fine" rather than "not measured".
  for (const g of [grade(), gradeFixed(), gradeExposed()]) {
    assert.ok(Object.prototype.hasOwnProperty.call(g.out, 'reachableExposure'), `missing on ${g.verdict}`);
    assert.ok('graded' in g.out.reachableExposure);
  }
});
