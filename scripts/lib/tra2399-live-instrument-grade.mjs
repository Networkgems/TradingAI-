// TRA-2399 — the AC7 live-instrument grade, extracted as a PURE FUNCTION over a
// `/api/health/live-capital-gate` payload.
//
// ⚠️⚠️ WHY THIS IS A MODULE AND NOT AN INLINE BLOCK IN THE CHECK SCRIPT ⚠️⚠️
//
//   The four AC7 assertions used to live inside `scripts/tra2335-feasibility-check.mjs`,
//   downstream of a `fetch`. That made them unreachable from a test, so the only way to
//   exercise them was to point the script at a server — and a server is exactly the thing
//   that cannot be made to hold a chosen degenerate payload on demand. So the ONE input
//   on which all four assertions are no-ops (`sleeves: []`) was never run, and the script
//   printed its full ✅ banner, with a build SHA stamped beside it, against a server that
//   had never evaluated a single sleeve. (Found by QuantTrader on a dev box whose DB was
//   empty; reachable in production on any fresh or failover instance.)
//
//   Everything here is a pure function of the payload so `tra2399-live-instrument-grade.test.mjs`
//   can drive BOTH directions — the empty book must NOT green, the populated one must —
//   without HTTP. A one-directional control is half a control.
//
// ── THE VACUITY RULE (TRA-2399 AC1) ──────────────────────────────────────────
//
//   An empty partition is UNGRADED, never PASSED.
//
//   All four AC7 assertions degenerate to no-ops over an empty sleeve array:
//
//     every sleeve carries `weight`     →  [].filter(...).length === 0   vacuous
//     every sleeve carries `blocking`   →  [].filter(...).length === 0   vacuous
//     sum(sleeve.n) === bookN           →  0 === 0                       passes
//     blockingSleeves is a projection   →  [] vs []                      equal
//
//   The third one is the load-bearing assertion — TRA-2361 AC2, *nothing is filtered*.
//   A partition that dropped EVERY sleeve is the maximal case of the defect it was
//   written to catch, and is the single input on which it cannot fire. A positive control
//   must CONTAIN what it detects; over `[]` this one contains nothing.
//
//   So an axis is GRADED iff it carries at least one sleeve AND sum(sleeve.n) >= 1.
//   `sum === 0` is counted vacuous even when sleeve OBJECTS are present, because the
//   partition check is equally blind at `sum=0, bookN=0` either way — it is rows, not
//   sleeve records, that give that assertion a preimage.
//
// ── ONE SLEEVE IS ENOUGH TO GRADE (TRA-2399 AC4 — decided, not inherited) ────
//
//   `sleeves.length === 1` with `bookN >= 1` is GRADED. Every one of the four assertions
//   keeps a falsifiable input there:
//
//     · field presence reads a real sleeve object — it can genuinely be missing;
//     · `sum(sleeve.n) === bookN` fires whenever that one sleeve's `n` disagrees with
//       `bookN`, which at one sleeve is the ONLY way a dropped row is observable at all;
//     · the `blockingSleeves` projection fires if the array disagrees with the one flag.
//
//   This is deliberately NOT the same call as the `axis.sleeves.length > 1` guard on the
//   AC2 headline check in the check script, and the difference is the point: that guard
//   is not a vacuity guard. At one sleeve the sleeve verdict IS the book verdict, so
//   "the book reads feasible while a sleeve inside it is infeasible" has no true instance
//   — the check is UNREACHABLE there, not merely weak. Weak-but-falsifiable is graded;
//   unreachable is skipped. Before this file the two were decided in opposite directions
//   in the same script, by accident. They are now decided on purpose, for stated reasons.
//
// ── WHAT IS GRADED, AND WHAT DELIBERATELY IS NOT ────────────────────────────
//
//   THE INSTRUMENT, never the BOOK. A live `infeasible` is not a failure, and a live R1
//   block is not a failure — those are facts about the trading book. That separation is
//   TRA-2361 AC7's and it survives intact here: the vacuity verdict is its own state with
//   its own exit code, so "the instrument cannot be graded on this server" can never be
//   confused with "the book is infeasible".

/** Exit code / severity for a graded payload. `fail` outranks `ungraded`. */
export const VERDICT = Object.freeze({
  OK: 'ok',
  FAIL: 'fail',
  UNGRADED: 'ungraded',
});

/** Exit codes, mirrored in the check script's header. */
export const EXIT_CODE = Object.freeze({
  ok: 0,
  fail: 1,
  // 3 is BLIND (could not read the route at all) and is owned by the CLI, not this module.
  ungraded: 4,
});

const sleeveLine = (s) => {
  const pct = s.weight == null ? '  ?' : `${String(Math.round(s.weight * 100)).padStart(3)}`;
  const flags = [
    s.blocking ? '⛔ BLOCKING' : null,
    s.approachingBlockingThreshold ? '⚠️ approaching' : null,
    s.material ? null : '(immaterial)',
  ]
    .filter(Boolean)
    .join(' ');
  return `     ${String(s.key).padEnd(20)} n=${String(s.n).padStart(3)}  ${pct}%  ceilingNetR=${String(s.ceilingNetR).padStart(9)}  → ${s.verdict}  ${flags}`;
};

/**
 * Grade the R1 live instrument over one `/api/health/live-capital-gate` payload.
 *
 * Pure: no I/O, no clock, no `process.exit`. The caller prints `lines` and maps
 * `verdict` through `EXIT_CODE`.
 *
 * @param {object} gate the decoded payload
 * @returns {{
 *   verdict: 'ok'|'fail'|'ungraded',
 *   problems: string[],
 *   lines: string[],
 *   axes: Array<{name: string, axis: string, bookN: number|null, sleeveCount: number,
 *                sumN: number, graded: boolean, reason: string|null}>,
 *   gradedAxes: string[],
 *   vacuousAxes: string[],
 *   ungradedReason: string|null,
 * }}
 */
export function gradeLiveSleeveInstrument(gate) {
  const problems = [];
  const lines = [];
  const axes = [];

  const f = (gate && gate.feasibility) ?? {};
  lines.push(`  book verdict        : ${f.verdict}`);
  lines.push(`  book ceilingGrossR  : ${f.ceilingGrossR}`);
  lines.push(`  book avgCostR       : ${f.avgCostR}`);
  lines.push(`  book ceilingNetR    : ${f.ceilingR}   vs bar ${f.barR}R`);
  lines.push(`  reward provenance   : ${JSON.stringify(f.ceilingSources)}`);

  const sf = gate ? gate.sleeveFeasibility : null;
  if (sf == null) {
    // The exact TRA-2335 trap, one ticket later: `index.ts` maps this payload field by
    // field. A new field that is not added there is dropped in silence.
    problems.push(
      'the route carries NO `sleeveFeasibility` block — either the build predates TRA-2353 or the field-by-field payload whitelist in index.ts dropped it',
    );
  } else {
    for (const [name, axis] of Object.entries(sf)) {
      // `sleeveFeasibility` is NOT all-axes: `BookSleeveFeasibility` also carries
      // `note: string | null` (the headline sentence), and the live payload does emit it.
      // So skip non-axis siblings by SHAPE rather than by "is it truthy and does it have
      // `sleeves`" — the old `.filter(([, a]) => a && a.sleeves)` conflated "not an axis"
      // with "an axis carrying no partition", and the second one is a defect.
      if (axis == null || typeof axis !== 'object' || Array.isArray(axis)) continue;
      const looksLikeAxis = 'axis' in axis || 'sleeves' in axis || 'bookN' in axis;
      if (!looksLikeAxis) continue;

      // An axis object that carries no `sleeves` ARRAY used to be dropped by that same
      // filter and graded nothing, in silence — the same vacuity class as `sleeves: []`,
      // just one level up. R1's payload contract always carries the array, so a
      // well-formed payload cannot trip this.
      if (!Array.isArray(axis.sleeves)) {
        problems.push(
          `${name}: the axis is present but carries no \`sleeves\` array — nothing on this axis can be graded, and an axis that grades nothing must not be skipped in silence`,
        );
        axes.push({
          name,
          axis: axis.axis ?? null,
          bookN: axis.bookN ?? null,
          sleeveCount: 0,
          sumN: 0,
          graded: false,
          reason: 'no `sleeves` array',
        });
        continue;
      }

      lines.push('');
      lines.push(`  ── ${name} (${axis.axis}, bookN=${axis.bookN}) ──`);
      for (const s of axis.sleeves) lines.push(sleeveLine(s));

      const sumN = axis.sleeves.reduce((a, s) => a + (Number(s.n) || 0), 0);
      const graded = axis.sleeves.length >= 1 && sumN >= 1;
      axes.push({
        name,
        axis: axis.axis ?? null,
        bookN: axis.bookN ?? null,
        sleeveCount: axis.sleeves.length,
        sumN,
        graded,
        reason: graded
          ? null
          : axis.sleeves.length === 0
            ? 'sleeves: [] — no partition to grade'
            : `${axis.sleeves.length} sleeve(s) but sum(sleeve.n) = 0 — no graded rows`,
      });
      if (!graded) {
        lines.push(
          `     ⚠️ VACUOUS — ${axes[axes.length - 1].reason}. Every AC7 assertion below is a no-op on this axis.`,
        );
      }

      // ── TRA-2361 AC7 — grade the R1 INSTRUMENT on this axis ────────────────
      //
      // ⚠️ Still grading the INSTRUMENT, never the BOOK: a live block is a fact about the
      // trading book and must NOT red the exit code. What is graded here is whether the
      // route can EXPRESS a block honestly — the fields present, the partition complete,
      // and the axis summary agreeing with the per-sleeve flags.
      //
      // These still RUN on a vacuous axis (they are harmless there and a stray field
      // defect is worth reporting wherever it appears); what changes is that a vacuous
      // axis no longer COUNTS as evidence — see the verdict at the bottom of this file.
      const missingWeight = axis.sleeves.filter((s) => !('weight' in s));
      const missingBlocking = axis.sleeves.filter((s) => !('blocking' in s));
      if (missingWeight.length) {
        problems.push(
          `${name}: ${missingWeight.length} sleeve(s) carry no \`weight\` — R1 is graded on weight, so a sleeve without one cannot be graded at all`,
        );
      }
      if (missingBlocking.length) {
        problems.push(
          `${name}: ${missingBlocking.length} sleeve(s) carry no \`blocking\` flag — the build predates TRA-2361, or the payload whitelist dropped it (the TRA-2335 field-map trap, third time)`,
        );
      }
      // THE PARTITION CHECK — this is the one that proves NOTHING WAS FILTERED. A sleeve
      // dropped BECAUSE it is infeasible is strictly worse than one that reads
      // `infeasible`, and it is invisible in every other field on this payload.
      if (axis.bookN != null && sumN !== axis.bookN) {
        problems.push(
          `${name}: sum(sleeve.n) = ${sumN} but bookN = ${axis.bookN} — ${axis.bookN - sumN} graded row(s) are in NO sleeve. Either the partition became a filter, or it is re-deriving its own population.`,
        );
      }
      // `blockingSleeves` must be a DERIVED PROJECTION of the per-sleeve flags. Two
      // computations that must agree is the shape that silently drifts; assert it against
      // the deployed bytes rather than trusting the module's own docstring.
      if (Array.isArray(axis.blockingSleeves)) {
        const derived = axis.sleeves.filter((s) => s.blocking).map((s) => s.key);
        if (JSON.stringify(axis.blockingSleeves) !== JSON.stringify(derived)) {
          problems.push(
            `${name}: \`blockingSleeves\` = [${axis.blockingSleeves.join(', ')}] disagrees with the per-sleeve \`blocking\` flags [${derived.join(', ')}] — the gate reads the former, an operator reads the latter`,
          );
        }
        lines.push(
          `     R1 blockingSleeves: ${axis.blockingSleeves.length ? axis.blockingSleeves.map((k) => `⛔ ${k}`).join(', ') : '(none)'}`,
        );
      } else if (!missingBlocking.length) {
        problems.push(
          `${name}: sleeves carry \`blocking\` but the axis carries no \`blockingSleeves\` array — the gate's own predicate reads that array, so a consumer cannot reproduce the stop`,
        );
      }

      if (axis.worstSleeve) {
        lines.push(
          `     ⚠️ worst: ${axis.worstSleeve.key} — infeasible, carrying ${Math.round((axis.infeasibleWeight ?? 0) * 100)}% of the graded book`,
        );
      }
      const fr = axis.fragility ?? {};
      lines.push(
        `     fragility: flipsOnSingleSleeveRemoval=${fr.flipsOnSingleSleeveRemoval}${fr.flippingSleeves?.length ? ` via [${fr.flippingSleeves.join(', ')}]` : ''}`,
      );
      for (const l of fr.leaveOneOut ?? []) {
        lines.push(
          `        without ${String(l.excludedKey).padEnd(20)} (n=${String(l.excludedN).padStart(3)}) → ceilingNetR=${String(l.ceilingNetR).padStart(9)}  ${l.verdict}${l.flipsBookVerdict ? '  ⚠️ FLIPS' : ''}`,
        );
      }

      // AC2, graded against the LIVE bytes: a book that is feasible in aggregate while a
      // sleeve inside it is infeasible MUST say so where an operator will see it.
      //
      // ⚠️ The `length > 1` guard is NOT a vacuity guard — see the AC4 note in this
      // file's header. At one sleeve the sleeve verdict IS the book verdict, so the
      // conflict this check looks for has no true instance; skipping an UNREACHABLE
      // check is a different decision from declining to count a WEAK one as evidence.
      if (f.verdict === 'feasible' && axis.worstSleeve && axis.sleeves.length > 1) {
        if (!String(gate.summary ?? '').includes(axis.worstSleeve.key)) {
          problems.push(
            `the book reads \`feasible\` while sleeve \`${axis.worstSleeve.key}\` (${Math.round((axis.worstSleeve.weight ?? 0) * 100)}% of the book) is infeasible, and the headline summary does not name it`,
          );
        }
      }
    }
  }

  // TRA-2361 AC7, graded against the LIVE bytes — R1 END TO END.
  //
  // ⚠️ A LIVE BLOCK IS NOT A FAILURE OF THIS CHECK. What IS a failure is a block that the
  // route reports in one field and contradicts in another: a payload where sleeves are
  // flagged `blocking` while criterion 3 reads PASS/FAIL, or a headline that stops the
  // capital path without naming what stopped it. Those are instrument defects and they
  // are exactly what an operator would act on wrongly.
  const c3 = ((gate && gate.criteria) ?? []).find((c) => c.name === 'positive_expectancy');
  const liveBlocking =
    sf == null
      ? []
      : Object.values(sf)
          .filter((a) => a && Array.isArray(a.blockingSleeves))
          .flatMap((a) => a.blockingSleeves);
  if (liveBlocking.length > 0) {
    lines.push('');
    lines.push(`  ⛔ R1 IS BITING LIVE — blocking sleeve(s): ${[...new Set(liveBlocking)].join(', ')}`);
    if (c3 && c3.status !== 'INFEASIBLE') {
      problems.push(
        `a sleeve is flagged \`blocking\` but criterion 3 reads ${c3.status}, not INFEASIBLE — the payload contradicts itself and the gate is not applying R1`,
      );
    }
    if (c3 && c3.pass !== false) {
      problems.push('a sleeve is flagged `blocking` and criterion 3 still reads pass:true');
    }
    const named = [...new Set(liveBlocking)].filter((k) => String(gate.summary ?? '').includes(k));
    if (named.length === 0) {
      problems.push(
        `the gate is blocked by sleeve(s) [${[...new Set(liveBlocking)].join(', ')}] and the headline summary names NONE of them — a stop whose cause is not in the headline reads as an unexplained hold`,
      );
    }
  }

  // AC4 of TRA-2353, graded against the LIVE bytes.
  if (c3 && c3.status === 'FAIL' && f.verdict === 'unknown') {
    if (!String(gate.summary ?? '').includes('REACHABILITY UNKNOWN')) {
      problems.push(
        'criterion 3 reads a bare FAIL while the ceiling is `unknown`, and the headline does not say so — a FAIL there asserts "the book underperformed", which is exactly the conflation this gate exists to prevent',
      );
    }
  }

  const gradedAxes = axes.filter((a) => a.graded).map((a) => a.name);
  const vacuousAxes = axes.filter((a) => !a.graded).map((a) => a.name);

  // ── THE VERDICT ──────────────────────────────────────────────────────────
  //
  // Precedence is deliberate: FAIL outranks UNGRADED. A payload with no
  // `sleeveFeasibility` block at all is both broken AND ungradable, and it must keep
  // reading as the hard instrument failure it already was (that is the negative control
  // QuantTrader ran against bqb1 — it stays exit 1, unchanged by this ticket).
  let verdict = VERDICT.OK;
  let ungradedReason = null;
  if (problems.length > 0) {
    verdict = VERDICT.FAIL;
  } else if (sf != null && gradedAxes.length === 0) {
    verdict = VERDICT.UNGRADED;
    ungradedReason =
      axes.length === 0
        ? '`sleeveFeasibility` is present but carries NO axes — there was nothing for the AC7 assertions to read'
        : `every axis is empty (${axes.map((a) => `${a.name}: ${a.reason}`).join(' · ')}) — all four AC7 assertions were no-ops`;
  }

  return { verdict, problems, lines, axes, gradedAxes, vacuousAxes, ungradedReason };
}
