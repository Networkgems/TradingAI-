// TRA-3737 — the GRADER half of the fleet-bound reader, as a pure function.
//
// TRA-3723 shipped `aggregateFleetBound` on `/api/health/live-options-fee-slippage`
// and TRA-3737 is the residual: **nothing polls it**. A detector whose verdict
// reaches no one has the operational value of no detector, with the added cost
// that it makes the system look instrumented.
//
// The reader has to live OUTSIDE the thing it grades (TRA-3529: a check written
// into a carrier only runs if somebody runs the carrier). So the network fetch
// lives in `scripts/tra3723-fleet-bound-live.mjs` and the JUDGEMENT lives here,
// where it can be exercised against captured payloads with no host, no clock and
// no market — which is the only way a control suite can prove the reader
// discriminates in BOTH directions.
//
// EXIT CODES — "could not check" never shares a code with "checked and fine":
//   0 CLEAN   Σ B_i ≤ A (or over by no more than the disclosed φ 4th-place slack)
//   1 BREACH  Σ B_i > A + slack — the fleet fail-open, live
//   3 BLIND   unreachable, unparseable, un-wired, or the pin did not match
//   Precedence BLIND > BREACH > CLEAN.

export const EXIT = { CLEAN: 0, BREACH: 1, USAGE: 2, BLIND: 3 };

/** Cent-exact sum, so 0.1+0.2 never manufactures or hides a breach. */
function sumCents(rows, key) {
  return rows.reduce((s, r) => s + (Number.isFinite(r?.[key]) ? Math.round(r[key] * 100) : 0), 0) / 100;
}

/**
 * Grade one reading of the live fleet bound.
 *
 * @param {object}  arg
 * @param {object?} arg.live          body of GET /api/health/options-live   (carries `build`)
 * @param {object?} arg.fee           body of GET /api/health/live-options-fee-slippage
 * @param {string?} arg.expectCommit  pin; a mismatch is BLIND, never a pass
 * @param {string}  arg.measuredAt    ISO stamp, injected so this stays pure
 * @returns {{verdict:'CLEAN'|'BREACH'|'BLIND', code:number, out:object}}
 */
export function gradeFleetBound({ live, fee, expectCommit = null, measuredAt }) {
  const blind = (reason, extra = {}) => ({
    verdict: 'BLIND',
    code: EXIT.BLIND,
    out: { measuredAt, verdict: 'BLIND', reason, ...extra },
  });

  const build = live?.build ?? null;
  if (!build?.commitShort || !build?.startedAt) {
    // ⚠ NEVER pin on `build.pid`: it went 73 → 73 → 72 across two real deploys
    // (TRA-3718/TRA-3723), so it is misleading in BOTH directions.
    return blind('no build.commitShort / build.startedAt on /api/health/options-live — cannot pin the reading', { build });
  }
  if (expectCommit && build.commitShort !== expectCommit) {
    return blind(
      `pin MISMATCH: expected commitShort ${expectCommit}, host is serving ${build.commitShort} `
      + `(startedAt ${build.startedAt}). The change is NOT deployed — do not read this as a pass.`,
      { build },
    );
  }

  const served = fee?.aggregateFleetBound ?? null;
  const rows = Array.isArray(fee?.aggregateExposure) ? fee.aggregateExposure : null;
  if (!served && !rows) {
    return blind('neither aggregateFleetBound nor aggregateExposure is wired on this build', { build });
  }

  const armed = (rows ?? []).filter(r => r?.liveEntryGateOpen === true);
  const localSum = sumCents(armed, 'capUsd');
  const A = fee?.aggregateCapUsd ?? null;

  // COVERAGE and CORRECTNESS are different claims (TRA-3723): a pass computed one
  // book short reads exactly like a pass over the whole arm. A book whose balance
  // could not be read contributes B_i = 0 here and the order site fails closed on
  // it — so the verdict is not wrong, but the DENOMINATOR is smaller than the arm.
  const unreadable = Array.isArray(served?.unreadableBalanceBooks) ? served.unreadableBalanceBooks : [];
  const eligible = armed.length + unreadable.length;

  const out = {
    measuredAt,
    build: { commitShort: build.commitShort, startedAt: build.startedAt, pid: build.pid },
    pidIsNotARestartDiscriminator: true,
    // ⚠ THE EFFECTIVE ARM IS `arm.otmArmed` ON THE FEE-SLIPPAGE ROUTE. It does not
    // exist on /api/health/options-live — that route has no `arm` object at all, and
    // its three top-level `…Armed` fields are not the arm the order site consults
    // (TRA-3689). Reading `live.arm.otmArmed` yields null, which reads as DISARMED.
    arm: {
      otmArmed: fee?.arm?.otmArmed ?? null,
      otmFlagOn: fee?.arm?.otmFlagOn ?? null,
      windowOpen: fee?.arm?.windowOpen ?? null,
      testUntilIso: fee?.arm?.testUntilIso ?? null,
      otmRoutingOnOptionsLive: live?.liveOtmRouting ?? null,
    },
    fleetCapUsd: A,
    fleetRiskFraction: fee?.fleetRiskFraction ?? null,
    fleetCapitalBasisUsd: fee?.fleetCapitalBasisUsd ?? null,
    armedBooks: armed.map(r => ({
      book: r.book,
      capUsd: r.capUsd,
      availableCashUsd: r.availableCashUsd,
      // Published, never subtracted: flatness is a MEASUREMENT WITH A TIMESTAMP,
      // not a property, and it is not headroom against an authorization (CEO,
      // TRA-3737 2026-08-20). A flat book with an armed sleeve can be long in
      // one tick.
      openRows: r.openRows ?? null,
      openPremiumAtRiskUsd: r.openPremiumAtRiskUsd ?? null,
    })),
    sumBookCapUsd: localSum,
    coverage: {
      armedBooksCovered: armed.length,
      eligibleBooks: eligible,
      unreadableBalanceBooks: unreadable,
    },
    servedGrade: served,
    gradeSource: served ? 'server (TRA-3723 build)' : 'client fallback sum (pre-TRA-3723 build)',
  };

  let verdict;
  let code;
  if (served) {
    // Prefer the SERVER's verdict: that published field is the artifact this
    // reader exists to read. Summing the rows locally is the fallback that keeps
    // an OLD build gradeable rather than blind — and that fallback IS the pre-fix
    // control.
    verdict = served.verdict === 'blind' ? 'BLIND' : served.verdict === 'breach' ? 'BREACH' : 'CLEAN';
    code = verdict === 'BLIND' ? EXIT.BLIND : verdict === 'BREACH' ? EXIT.BREACH : EXIT.CLEAN;
    out.reason = served.reason;
    out.servedVerdict = served.verdict;
  } else if (typeof A !== 'number' || !(A > 0)) {
    verdict = 'BLIND';
    code = EXIT.BLIND;
    out.reason = 'no usable aggregateCapUsd on this build';
  } else {
    // Pre-fix build: allow the same capital-scaled φ slack the server uses, so the
    // disclosed rounding overage does not read as the defect. Scale the tolerance
    // to the thing it measures — a FLAT dollar tolerance would repeat φ's own
    // mistake (a constant fitted to one night's balances) one level up.
    const capital = sumCents(armed, 'availableCashUsd');
    const slack = Math.round(1e-4 * capital * 100) / 100;
    const overage = Math.max(0, Math.round((localSum - A) * 100) / 100);
    verdict = overage > slack ? 'BREACH' : 'CLEAN';
    code = verdict === 'BREACH' ? EXIT.BREACH : EXIT.CLEAN;
    out.reason = `client sum $${localSum.toFixed(2)} vs A $${A.toFixed(2)} (slack $${slack.toFixed(2)})`;
  }

  // The partial-coverage marker must DISCRIMINATE, or it is boilerplate. It fires
  // only when a book is genuinely unreadable, and NEVER on a breach: the overage
  // is real whatever the dark book would have added, and hedging a loud finding is
  // exactly how it gets re-read as a caveat (TRA-3723).
  if (unreadable.length > 0 && verdict !== 'BREACH') {
    out.partial = `⚠ PARTIAL: covers ${armed.length}/${eligible} of the arm — ${unreadable.join(', ')} had no readable balance`;
  }

  out.verdict = verdict;
  return { verdict, code, out };
}
