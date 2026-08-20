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
//   0 CLEAN    Σ B_i ≤ A (or over by no more than the disclosed φ 4th-place slack)
//   1 BREACH   Σ B_i > A + slack — the fleet fail-open, live
//   3 BLIND    unreachable, unparseable, un-wired, or the pin did not match
//   3 UNBOUND  Σ B_i fits, but the BOUND THAT MAKES IT FIT IS NOT IN FORCE (below)
//   Precedence BLIND > BREACH > CLEAN; UNBOUND only ever upgrades a CLEAN.

export const EXIT = {
  CLEAN: 0,
  BREACH: 1,
  USAGE: 2,
  BLIND: 3,
  /**
   * Deliberately the SAME code as BLIND. The scheduler's contract is binary —
   * "0 is a pass, anything else is not" — and UNBOUND is squarely a could-not-
   * certify, so it must not need a new branch in any existing caller. The
   * distinct VERDICT STRING is what a human needs; the code is what the routine
   * needs.
   */
  UNBOUND: 3,
};

/** Cent-exact sum, so 0.1+0.2 never manufactures or hides a breach. */
function sumCents(rows, key) {
  return rows.reduce((s, r) => s + (Number.isFinite(r?.[key]) ? Math.round(r[key] * 100) : 0), 0) / 100;
}

const usable = v => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * TRA-3737 §2 — is the fleet bound ACTUALLY IN FORCE on this reading?
 *
 * TRA-3879 shipped `φ_eff = min(φ, A / Σ E_i)`, which makes `Σ B_i ≤ A`
 * structural instead of fitted. But `Σ E_i` is a READ, and the read has failure
 * modes that do not announce themselves:
 *
 *   - `fleet_capital_unreadable` — the cross-engine read was unwired or threw.
 *     Sizing falls back to `min(φ·E_i, A)`, the PRE-TRA-3879 bound, and the sum
 *     is unbounded again. The server publishes this honestly and the served
 *     `verdict` still says `within` whenever balances happen to fit.
 *   - A PARTIAL population. Measured for real 28s after the TRA-3879 boot: v0nni
 *     had no balance snapshot, `Σ E_i` was admin alone, `A/Σ E_i` did not bind,
 *     φ did, and the route published `within` — a pass on the fixed build with
 *     the fix doing nothing. Understating `Σ E_i` LOOSENS the bound, so this
 *     failure is always in the permissive direction.
 *
 * In both states `Σ B_i ≤ A` is a coincidence of today's balances. A reader that
 * cannot tell that apart from "the bound held" is only half a reader — which is
 * the exact criticism TRA-3737 was filed to answer one level down.
 *
 * ⚠ THE TEST IS A PROPERTY, NOT A LIST OF REASON STRINGS. `fleetSizingReason` is
 * reported as evidence and never branched on: a ban list is names, and the
 * invariant is arithmetic. What must hold, per armed row:
 *
 *   1. `fleetCapitalUsd` is a usable number       — the fleet read produced something
 *   2. `fleetCapitalUsd ≥ Σ E_i we can see ourselves` — computed from a DIFFERENT
 *      column, so a fleet read that silently missed a book is caught even if it
 *      reports its own coverage honestly-but-wrongly
 *   3. `fleetCapitalBooks ≥ eligible armed books` — the coverage claim itself
 *   4. `φ_eff · fleetCapitalUsd ≤ A`              — the published φ_eff actually
 *      delivers the bound, since `Σ B_i ≤ φ_eff · Σ E_i` by construction
 *
 * @returns {{inForce: boolean|null, reason: string, ...}} `inForce: null` ⇒ this
 *   build does not publish the block at all (pre-TRA-3879). That is NOT graded
 *   as a failure — on such a build the sum genuinely is unbounded, but that is
 *   the TRA-3723 world the served `verdict` already covers, and flipping every
 *   old build red would mute the reader. It is published loudly instead.
 */
function gradeBoundInForce(armed, A, eligibleBooks) {
  const published = armed.filter(r => 'fleetRiskFractionEffective' in (r ?? {}));
  if (armed.length === 0 || published.length === 0) {
    return {
      inForce: null,
      reason:
        'this build does not publish the TRA-3879 fleet-sizing block '
        + '(fleetRiskFractionEffective / fleetCapitalUsd / fleetCapitalBooks) — '
        + 'pre-TRA-3879 bytes, so Σ B_i is bounded only by the fitted precondition',
      sizingReasons: [],
    };
  }

  const observedFleetCapitalUsd = sumCents(armed, 'availableCashUsd');
  const failures = [];
  for (const r of armed) {
    const who = r?.book ?? '<unnamed>';
    const phiEff = r?.fleetRiskFractionEffective;
    const capital = r?.fleetCapitalUsd;
    const books = r?.fleetCapitalBooks;

    if (!usable(capital)) {
      failures.push(`${who}: fleetCapitalUsd ${capital === null ? 'null' : capital} — the fleet read was unusable, so sizing fell back to the per-book bound min(φ·E_i, A) and the SUM is unbounded`);
      continue;
    }
    if (Math.round(capital * 100) < Math.round(observedFleetCapitalUsd * 100)) {
      failures.push(`${who}: fleetCapitalUsd $${capital.toFixed(2)} is BELOW the $${observedFleetCapitalUsd.toFixed(2)} this reader can see across the armed books — the fleet read missed capital, which loosens φ_eff`);
      continue;
    }
    if (!Number.isFinite(books) || books < eligibleBooks) {
      failures.push(`${who}: fleetCapitalBooks ${books} covers fewer than the ${eligibleBooks} eligible armed book(s) — φ_eff was derived one book short`);
      continue;
    }
    if (!usable(phiEff)) {
      failures.push(`${who}: fleetRiskFractionEffective ${phiEff} is not a usable fraction`);
      continue;
    }
    // Float slack only, scaled to A — a FLAT dollar tolerance here would repeat
    // φ's own mistake (a constant fitted to one night's numbers) one level up.
    if (phiEff * capital > A + Math.abs(A) * 1e-9) {
      failures.push(`${who}: φ_eff ${phiEff} × Σ E_i $${capital.toFixed(2)} = $${(phiEff * capital).toFixed(2)} EXCEEDS A $${A.toFixed(2)} — the published fraction does not deliver the bound`);
    }
  }

  const sizingReasons = [...new Set(armed.map(r => r?.fleetSizingReason ?? null))];
  return {
    inForce: failures.length === 0,
    reason: failures.length === 0
      ? `φ_eff · Σ E_i ≤ A holds on all ${armed.length} armed book(s) over a fleet read covering ${eligibleBooks}`
      : failures.join(' | '),
    observedFleetCapitalUsd,
    // Evidence, never the test.
    sizingReasons,
    failures,
  };
}

/**
 * Grade one reading of the live fleet bound.
 *
 * @param {object}  arg
 * @param {object?} arg.live          body of GET /api/health/options-live   (carries `build`)
 * @param {object?} arg.fee           body of GET /api/health/live-options-fee-slippage
 * @param {string?} arg.expectCommit  pin; a mismatch is BLIND, never a pass
 * @param {string}  arg.measuredAt    ISO stamp, injected so this stays pure
 * @returns {{verdict:'CLEAN'|'BREACH'|'BLIND'|'UNBOUND', code:number, out:object}}
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

  // TRA-3737 §2 — grade the BOUND, not just the SUM. Published on every verdict,
  // because "the bound was in force" is evidence a CLEAN reading needs and a
  // BREACH reading is entitled to be judged against.
  out.boundInForce = gradeBoundInForce(armed, typeof A === 'number' ? A : NaN, eligible);

  // TRA-3881 — WHICH CAPITAL INSTRUMENT GOVERNS THIS READING.
  //
  // The escalation checklist in this reader's carrier (routine 2b3b32bc) used to
  // quote `fleetCapitalUsd / fleetCapitalCeilingUsd / fleetCapitalHeadroomUsd`
  // flat. After TRA-3879 the fitted ceiling `A/φ` describes a precondition that
  // no longer governs, so on a perfectly healthy fleet it served −$120.81 beside
  // its own `within` — every reading, by construction. A permanent false alarm
  // gets muted and a muted alarm is a deleted alarm, so the reader now says
  // WHICH number to read instead of printing both and hoping.
  out.fleetCapital = (() => {
    const fitted = served?.fleetCapitalCeilingUsd ?? null;
    const fittedHeadroom = served?.fleetCapitalHeadroomUsd ?? null;
    const sizedHeadroom = served?.fleetSizedHeadroomUsd ?? null;
    const basis = served?.fleetCapitalCeilingBasis ?? null;
    // A pre-TRA-3881 build publishes the fitted pair unconditionally. When the
    // rows say the TRA-3879 bound WAS in force, a negative fitted headroom on
    // such a build is the known artifact — not a finding, and explicitly not an
    // escalation. Naming it here is what stops the next reader from paging on it.
    const staleFittedCeiling =
      basis === null
      && typeof fittedHeadroom === 'number'
      && fittedHeadroom < 0
      && out.boundInForce.inForce === true;
    return {
      fleetCapitalUsd: served?.fleetCapitalUsd ?? null,
      // ⭐ READ THIS FIRST. Present ⇒ TRA-3881 bytes; the server itself says
      // whether the fitted pair below means anything on this reading.
      ceilingBasis: basis,
      fittedCeilingUsd: fitted,
      fittedHeadroomUsd: fittedHeadroom,
      // The bound TRA-3879 actually installed: `φ_eff · Σ E_i` against `A`.
      sizedMaxSumUsd: served?.fleetSizedMaxSumUsd ?? null,
      sizedHeadroomUsd: sizedHeadroom,
      governing:
        basis === null
          ? 'UNKNOWN — pre-TRA-3881 bytes publish no ceiling basis'
          : fitted === null
            ? 'φ_eff · Σ E_i ≤ A (the TRA-3879 bound); the fitted A/φ precondition is withheld and does NOT apply here'
            : 'Σ E_i ≤ A/φ (the fitted precondition) — the server says it still governs this reading',
      staleFittedCeiling,
      ...(staleFittedCeiling
        ? {
          doNotEscalate:
            `⚠ fleetCapitalHeadroomUsd $${fittedHeadroom.toFixed(2)} is NEGATIVE on a build that predates `
            + 'TRA-3881, while the TRA-3879 bound IS in force on these rows. That is the KNOWN STALE-φ '
            + 'artifact (A/φ against a φ that no longer sizes anything), NOT a fleet over its limit. Do '
            + 'not escalate on this field; read sizedHeadroomUsd, or the verdict.',
        }
        : {}),
    };
  })();

  // UNBOUND only ever upgrades a CLEAN. It must NOT touch a BREACH: the overage
  // is already real and unconditional, and re-labelling a live fail-open with a
  // more procedural word is how a loud finding gets read as a caveat — the same
  // discipline the partial marker follows above. It must not touch a BLIND
  // either: we do not know what we measured, so we cannot claim to know the
  // bound was off.
  if (verdict === 'CLEAN' && out.boundInForce.inForce === false) {
    out.servedReason = out.reason;
    verdict = 'UNBOUND';
    code = EXIT.UNBOUND;
    out.reason =
      `BOUND NOT IN FORCE — Σ B_i $${localSum.toFixed(2)} fits A $${Number(A).toFixed(2)}, but that is a `
      + 'coincidence of today\'s balances, not a guarantee: the TRA-3879 fleet bound did not bind on this '
      + `reading. ${out.boundInForce.reason}. `
      + `Sizing reason(s) served: ${out.boundInForce.sizingReasons.map(r => r ?? 'absent').join(', ')}. `
      + 'A deposit — or nothing at all, as on 2026-08-20 — puts Σ B_i past the authorization with no '
      + 'further warning. This is exit 3, NOT a pass.';
  }

  out.verdict = verdict;
  return { verdict, code, out };
}
