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
//   1 EXPOSURE Σ B_i fits and the bound is in force, but the fleet's REACHABLE
//              exposure — Σ max(cap_i, atRisk_i) — is over A anyway (below)
//   Precedence BLIND > BREACH > EXPOSURE > UNBOUND > CLEAN.

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
  /**
   * Deliberately the SAME code as BREACH. An exposure overage is a DEFINITE
   * finding about live money — the fleet can reach a total the board did not
   * authorize — not a could-not-certify, so it belongs with BREACH and not with
   * BLIND/UNBOUND. Same rule as UNBOUND, applied in the other direction: reuse
   * the existing non-pass code, let the VERDICT STRING carry the discrimination.
   */
  EXPOSURE: 1,
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
 * TRA-3737 §3 — grade the fleet's REACHABLE EXPOSURE, not its unspent budget.
 *
 * `Σ B_i` answers "how much MORE is the fleet authorized to size?" It does not
 * answer "how much can the fleet be on the hook for?", and only the second
 * question is what `A` was ratified to bound. The gap between them is not
 * academic — it is signed, and it points the wrong way:
 *
 *   `capUsd` is a ceiling on a book's TOTAL at-risk, not a budget for
 *   additional entries (`fitsLiveOptionTestAggregateCap` is
 *   `atRisk + entry <= cap`), AND `capUsd = φ · availableCash`. So buying an
 *   option moves at-risk UP by `x` and the cap DOWN by `φ·x`.
 *   **`Σ B_i` therefore FALLS as the fleet takes risk, and the metric reads
 *   MORE compliant precisely when exposure grows.** (CEO, TRA-3737
 *   2026-08-20T20:33Z, measured on live money: the 03:07Z `breach` at
 *   Σ B_i $558.68 became a `within` at $327.75 with no fix shipped, because
 *   the sleeve had converted $273 of cash into open premium.)
 *
 * A book's maximum reachable exposure is `max(cap_i, atRisk_i)` — NOT the sum.
 * Below its cap a book can still size up to the cap; above it (which the cash
 * basis makes routine, see below) it can add nothing, so it stays where it is.
 * The fleet's worst case is the sum of those, and `Σ max(cap_i, atRisk_i) ≤ A`
 * is the property `A` was supposed to name.
 *
 * ⭐ THIS IS A STRICT GENERALIZATION, WHICH IS WHY IT ADDS NO FALSE-ALARM
 * SURFACE. On a flat fleet every `atRisk_i` is 0, `max(cap_i, 0) == cap_i`, and
 * the sum is `Σ B_i` exactly — i.e. it reduces to the check already shipped and
 * cannot turn a clean flat reading red. It can only fire on exposure that is
 * genuinely outstanding.
 *
 * ⚠ `headroomUsd` on the served row is `Math.max(0, cap − atRisk)`. A book over
 * its own cap publishes `0`, identical to a book exactly at it — so the overage
 * is invisible on the route. A clamped metric is a deleted alarm (TRA-3827).
 * `trueHeadroomUsd` here is UNCLAMPED and is the number to read.
 *
 * ⚠ UNGRADED, NOT RED, when any armed row omits `openPremiumAtRiskUsd`
 * (pre-TRA-3445 bytes). Same discipline as `inForce: null`: a reader that goes
 * red on every old build gets muted, and a muted reader is the empty room this
 * whole ticket exists to close.
 */
function gradeReachableExposure(armed, A) {
  if (armed.length === 0 || !usable(A)) {
    return { graded: false, reason: 'no armed books, or no usable A on this build', perBook: [] };
  }
  const missing = armed.filter(r => !Number.isFinite(r?.openPremiumAtRiskUsd));
  if (missing.length > 0) {
    return {
      graded: false,
      reason:
        `${missing.map(r => r?.book ?? '<unnamed>').join(', ')} publish no openPremiumAtRiskUsd — `
        + 'pre-TRA-3445 bytes, so reachable exposure cannot be summed on this reading',
      perBook: [],
    };
  }

  const perBook = armed.map(r => {
    const cap = Number.isFinite(r.capUsd) ? r.capUsd : 0;
    const atRisk = r.openPremiumAtRiskUsd;
    return {
      book: r.book ?? '<unnamed>',
      capUsd: cap,
      openPremiumAtRiskUsd: atRisk,
      reachableUsd: Math.max(cap, atRisk),
      // UNCLAMPED — the served `headroomUsd` floors at 0 and deletes this.
      trueHeadroomUsd: Math.round((cap - atRisk) * 100) / 100,
      overCapUsd: Math.round(Math.max(0, atRisk - cap) * 100) / 100,
      servedHeadroomUsd: r.headroomUsd ?? null,
    };
  });

  const reachableUsd = sumCents(perBook, 'reachableUsd');
  // ⚠ THE SAME φ-ROUNDING SLACK THE Σ B_i CHECK USES, OR THIS RE-PAGES ON THE
  // DISCLOSED 5¢. On a flat fleet `reachable ≡ Σ B_i`, so a float epsilon here
  // would fire EXPOSURE on exactly the `rounding_only` reading that verdict
  // exists to keep un-spendable in either direction — caught by the pre-existing
  // control, which is what a control suite is for.
  //
  // Scaled to `Σ E_i` and NOT to `reachable`: φ's 4th-place rounding is
  // multiplied by cash (`cap_i = φ · E_i`), and at-risk dollars are actual fills
  // carrying no φ error at all, so including them would inflate the tolerance
  // with the very quantity this check exists to catch. Never a FLAT dollar
  // figure — that would repeat φ's own mistake (a constant fitted to one night's
  // balances) one level up.
  //
  // Computed, never read off the served `roundingAllowanceUsd`: a suppression
  // that trusts a served field can be bought by inflating that field
  // (TRA-3881 — suppress on arithmetic, never on a name).
  const slack = Math.round(1e-4 * sumCents(armed, 'availableCashUsd') * 100) / 100;
  const overageUsd = Math.round(Math.max(0, reachableUsd - A) * 100) / 100;
  const breach = reachableUsd > A + slack;
  const overCap = perBook.filter(b => b.overCapUsd > 0);

  return {
    graded: true,
    breach,
    reachableUsd,
    fleetCapUsd: A,
    overageUsd,
    slackUsd: slack,
    perBook,
    booksOverOwnCap: overCap.map(b => `${b.book} at-risk $${b.openPremiumAtRiskUsd.toFixed(2)} vs cap $${b.capUsd.toFixed(2)} (over by $${b.overCapUsd.toFixed(2)}, route publishes headroom ${b.servedHeadroomUsd})`),
    reason: breach
      ? `REACHABLE EXPOSURE $${reachableUsd.toFixed(2)} = Σ max(cap_i, atRisk_i) EXCEEDS A $${A.toFixed(2)} by $${overageUsd.toFixed(2)}`
      : `Σ max(cap_i, atRisk_i) $${reachableUsd.toFixed(2)} fits A $${A.toFixed(2)}`,
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

  // TRA-3737 §3 — published on EVERY verdict, for the same reason boundInForce
  // is: "what can the fleet reach" is evidence a CLEAN reading needs, and a
  // BREACH reading is entitled to be judged against it too.
  out.reachableExposure = gradeReachableExposure(armed, typeof A === 'number' ? A : NaN);

  // EXPOSURE upgrades a CLEAN **and an UNBOUND** — it outranks UNBOUND because
  // it is a DEFINITE finding ("the fleet can reach $X > A") against a
  // could-not-certify ("the bound that makes Σ B_i fit was not binding"). It
  // must NOT touch a BREACH: Σ B_i is already over and unconditionally so, and
  // re-labelling a live fail-open with a longer word is how a loud finding gets
  // re-read as a caveat. It must not touch a BLIND either — we do not know what
  // we measured. Same discipline as UNBOUND and the partial marker.
  if ((verdict === 'CLEAN' || verdict === 'UNBOUND') && out.reachableExposure.breach === true) {
    out.priorVerdict = verdict;
    out.priorReason = out.reason;
    verdict = 'EXPOSURE';
    code = EXIT.EXPOSURE;
    const re = out.reachableExposure;
    out.reason =
      `${re.reason}. Σ B_i $${localSum.toFixed(2)} fits A, but Σ B_i is the fleet's UNSPENT BUDGET, not its `
      + 'EXPOSURE: capUsd is a ceiling on TOTAL at-risk and is itself φ · availableCash, so buying moves '
      + `at-risk up by x and the cap down by φ·x. ${re.booksOverOwnCap.length > 0 ? `Over own cap: ${re.booksOverOwnCap.join('; ')}. ` : ''}`
      + 'The route publishes a clamped headroom (max(0, cap - atRisk)) and therefore shows none of this. '
      + 'This is exit 1, NOT a pass.';
  }

  out.verdict = verdict;
  return { verdict, code, out };
}
