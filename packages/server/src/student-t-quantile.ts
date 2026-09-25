/**
 * TRA-4894 (spec TRA-4887 §5) — the two-sided 97.5% Student-t quantile, as a
 * function of df, for the real-fill promotion bound.
 *
 * ── Why this module exists at all ───────────────────────────────────────────
 *
 * The tape gate's existing bound uses `z = 1.96` ({@link TAPE_EXPECTANCY_Z95}).
 * At the dispersion the cell under audit actually carries (`sd = 4.10660` gate
 * R, measured live on `single_leg_otm::0.50-0.55`), the z-for-t substitution
 * error is **4.35% of the half-width at n=30 = 0.0639 R**. The bar move being
 * debated on TRA-4890 is **0.0464 R**. A gate whose own normal-approximation
 * error is larger than the bar move it is being asked to resolve cannot resolve
 * it — so the real-fill arm uses `t`, and the error is GONE rather than
 * absorbed.
 *
 * ⚠ This does NOT replace `TAPE_EXPECTANCY_Z95`. The pooled `lowerCI95` column
 * stays a normal interval: it is the number every prior verdict, ledger row and
 * ruling was written against, and re-cutting it here would silently restate
 * history. The `t` lives on the NEW column only. Two intervals, two multipliers,
 * both labelled — the TRA-3945 `studentT`-beside-`lowerCi95` discipline.
 *
 * ── The two regimes, and why the seam is where it is ────────────────────────
 *
 * TRA-4887 §5 sanctioned "a table for df 1..200 plus a normal fallback above".
 * This ships something strictly tighter and measurably so:
 *
 *   • **df 1..30 — exact table**, to 6 dp. The series below is weak here: at
 *     df=2 it returns 4.2698 against a true 4.302653 (−0.033), and at df=1 it
 *     is meaningless. These are also the df at which a multiplier error is
 *     largest in absolute terms, so they get published values, not a series.
 *   • **df > 30 — the Cornish–Fisher expansion** in `1/df` about the normal
 *     quantile, carried to the `1/df⁴` term. Measured against published values:
 *     df=31 →3e-5, df=40 →1.7e-5, df=44 →1.3e-5, df=60 →9e-6, df=120 →4e-6,
 *     df=200 →3e-6, and it converges to `z` from above. That is ~2 orders of
 *     magnitude better than the sanctioned 3-dp table would have been, and it
 *     has no 200-row cliff for a cell that one day holds more.
 *
 * The seam at 30/31 is therefore not a fallback in the "we gave up" sense — it
 * is the point below which the series stops being the better instrument. The
 * boundary is asserted in `tra4894-real-fill-promotion-gate.test.ts`: both sides
 * agree at the seam, the function is strictly decreasing across it, and it never
 * dips below `z`. An unasserted seam is exactly the kind of discontinuity that
 * reads identically to a correct one.
 *
 * PURE — no env, no I/O, no clock.
 */

/**
 * `Φ⁻¹(0.975)` to full double precision. The `1.96` everything else in the
 * tape gate rounds to; spelled exactly here because it is the expansion's
 * anchor and a 3-dp anchor would dominate the expansion's own error.
 */
export const NORMAL_QUANTILE_975 = 1.959963984540054;

/** Highest df served from {@link T_QUANTILE_975_EXACT}; above it the series runs. */
export const T_QUANTILE_975_EXACT_MAX_DF = 30;

/**
 * Two-sided 95% (= one-sided 97.5%) Student-t critical values, df 1..30, 6 dp.
 *
 * ⚠ 6 dp, not the 3 dp of `otm-evaluation-window.ts`'s `T_CRIT_95_TWO_SIDED`.
 * That table is a DESCRIPTIVE companion on a pre-registered normal interval and
 * 3 dp is fine there; this one sits inside a promotion predicate with real money
 * on the other side, where a 5e-4 multiplier error is a 2e-3 R error on a bound
 * that decides at the 2e-2 R scale. Do not "deduplicate" the two by pointing
 * this at that one — the precision difference is the point.
 */
const T_QUANTILE_975_EXACT: readonly number[] = [
  12.706205, 4.302653, 3.182446, 2.776445, 2.570582, 2.446912, 2.364624, 2.306004, 2.262157,
  2.228139, 2.200985, 2.178813, 2.160369, 2.144787, 2.131450, 2.119905, 2.109816, 2.100922,
  2.093024, 2.085963, 2.079614, 2.073873, 2.068658, 2.063899, 2.059539, 2.055529, 2.051831,
  2.048407, 2.045230, 2.042272,
];

/**
 * The two-sided 97.5% t quantile at `df` degrees of freedom.
 *
 * `null` — never a number — below df=1. A caller with no df has no interval,
 * and a silently-substituted `z` there is the fail-zero this whole ticket is
 * about. Non-integer df is floored (a sample size is a count).
 */
export function tQuantile975(df: number): number | null {
  if (!Number.isFinite(df)) return null;
  const d = Math.floor(df);
  if (d < 1) return null;
  if (d <= T_QUANTILE_975_EXACT_MAX_DF) return T_QUANTILE_975_EXACT[d - 1] as number;

  // Cornish–Fisher expansion in 1/df about the normal quantile. Terms are
  // spelled in ascending order of 1/df so the shrinking contribution of each is
  // visible on the page; each denominator is the standard 4/96/384/92160.
  const z = NORMAL_QUANTILE_975;
  const z2 = z * z;
  const z3 = z2 * z;
  const z5 = z3 * z2;
  const z7 = z5 * z2;
  const z9 = z7 * z2;
  const t1 = (z3 + z) / (4 * d);
  const t2 = (5 * z5 + 16 * z3 + 3 * z) / (96 * d * d);
  const t3 = (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * d * d * d);
  const t4 = (79 * z9 + 776 * z7 + 1482 * z5 - 1920 * z3 - 945 * z) / (92160 * d * d * d * d);
  return z + t1 + t2 + t3 + t4;
}
