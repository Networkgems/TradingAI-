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
const AT = '2026-08-20T03:20:00.000Z';

const capture = JSON.parse(fs.readFileSync(CAPTURE, 'utf8'));
const clone = () => JSON.parse(JSON.stringify(capture));
const grade = over => gradeFleetBound({ ...clone(), expectCommit: null, measuredAt: AT, ...over });

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
