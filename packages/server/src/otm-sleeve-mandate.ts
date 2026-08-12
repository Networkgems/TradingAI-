// TRA-3394 (authorization: TRA-3392, `docs/otm-sleeve-mandate-TRA-3392.md`) —
// the RATIFIED band table, as data.
//
// ── Why this file exists at all ──────────────────────────────────────────────
//
// Before it, the `[0.00, 0.20)` band was closed by ALGEBRAIC ACCIDENT. The cost
// bar worked out to a 0.495 delta floor (`modeledGrossR = 3·|Δ| − 1 ≥ 0.485`)
// and that floor happened to exclude the deep-OTM band. NOTHING IN THE TREE KNEW
// THAT BAND WAS A MEASURED LOSER. Any future bar / k / multiplier change — which
// is exactly the change TRA-3272 was opened to make — would have reopened the
// single most significantly negative cell on the tape (n=638, t=−4.45) with real
// money, and no code would have objected.
//
// So the authorization is stated HERE, independently of the bar, sourced from the
// ratified document, and consulted BEFORE any bar-derived arithmetic. A retune of
// the cost side cannot reach it. Changing an authorization is a code change with a
// CTO ruling behind it — which is the intended cost.
//
// ── Why the table is bounded ABOVE as well as below ──────────────────────────
//
// `[0.495, ∞)` pools one passing cell with two failing ones. The mandate is
// `[0.495, 0.55)`, and the `[0.55, ∞)` tail is the second-most-negative cell in
// the table (n=20, E=−1.072 R_gate). The cost bar is algebraically a FLOOR and
// therefore structurally incapable of cutting a top end; the ceiling in
// `option-exec-flag.ts` (`ENABLE_OPTION_ENTRY_DELTA_CEILING_LIVE`) is the
// mechanism that can, and it reads its number from {@link mandateCeilingFor}
// rather than from an operator's env, so the enforced ceiling and the ratified
// authorization cannot drift apart.
//
// ── Naming (§7 of the doc) ───────────────────────────────────────────────────
//
// The board-facing mandate is renamed to **"Near-ATM Single-Leg (long)"**. The
// internal key `single_leg_otm` is FROZEN: it is the join column of the journal
// tape, of `OPTIONS_PRODUCTION_STRATEGIES` and of the gate ledger's `byScope`.
// Renaming it would silently restate every published per-structure number — the
// read-time-reclassification failure `test-accounts.ts` / TRA-2948 documents. New
// label ({@link OTM_SLEEVE_MANDATE_LABEL}) over the old key, in UI/report strings
// only.
//
// PURE — no env, no I/O, no clock. Every number below is a transcription of the
// ratified doc; the provenance string travels with it so a reader never has to
// take the transcription on trust.

/** Board-facing name of the sleeve. The KEY stays `single_leg_otm` (§7). */
export const OTM_SLEEVE_MANDATE_LABEL = 'Near-ATM Single-Leg (long)';

/** The frozen journal / ledger / strategy-registry key the label sits over. */
export const OTM_SLEEVE_MANDATE_STRUCTURE = 'single_leg_otm';

/** The ruling that ratified the table below. */
export const OTM_SLEEVE_MANDATE_ISSUE = 'TRA-3392';

/** Where the numbers came from, verbatim enough to re-read. */
export const OTM_SLEEVE_MANDATE_PROVENANCE =
  'docs/otm-sleeve-mandate-TRA-3392.md (CTO, ratified 2026-08-12) — measured on bqb1 '
  + '`eb1dcf0c8a6f`, /api/health/option-journal?rows=all, model-facing basis (QA fixtures '
  + 'excluded per test-accounts.ts), structure=single_leg_otm, closed only, n=1073, '
  + 'unit R_gate = realizedR / 0.25';

/**
 * What the sleeve may do in a band. FOUR states, deliberately — the board could
 * not previously tell them apart, and each wants a different response:
 *
 *   `authorized`             — trade it (provisionally; §4 of the doc, §6 lapses it).
 *   `de_authorized`          — MEASURED LOSER, permanently closed by evidence. No bar,
 *                              no `k` and no multiplier may reopen it. This is the
 *                              state that used to be indistinguishable from an
 *                              algebraic side-effect.
 *   `insufficient_evidence`  — NEVER MEASURED (or n below the admission minimum).
 *                              Closed, but the honest reason is ignorance, and §5
 *                              pre-registers what would reopen it.
 *   `not_authorized`         — measured, adequately powered, and it FAILS the
 *                              admission rule (`mean − 1.96·SE ≥ bar`).
 */
export type MandateAuthorization =
  | 'authorized'
  | 'de_authorized'
  | 'insufficient_evidence'
  | 'not_authorized';

/** One measured cell, in R_gate. `null` where the doc does not publish the stat. */
export interface MandateEvidence {
  /** Closed rows on the model-facing basis. */
  n: number;
  meanR_gate: number | null;
  seR_gate: number | null;
  /** `mean − 1.96·SE`. */
  lowerCI95: number | null;
  /** `mean / SE`. Bonferroni over 8 buckets needs |t| ≥ 2.73 (doc §2). */
  t: number | null;
}

export interface MandateBand {
  /** Inclusive lower edge of the band, in |entry delta|. */
  from: number;
  /** EXCLUSIVE upper edge; `null` means unbounded above. */
  to: number | null;
  /** Stable wire/label key, e.g. `[0.495,0.55)`. */
  label: string;
  authorization: MandateAuthorization;
  /** The band's own aggregate evidence. */
  evidence: MandateEvidence;
  /**
   * The measured cells the band is composed of, where the doc publishes a finer
   * split than the band edges. Present so a reader gets n / SE / lo95 PER CELL
   * and never has to trust an aggregate whose SE the doc does not state.
   */
  cells?: readonly (MandateEvidence & { label: string })[];
  /** Why this band has this authorization, in one sentence a board can read. */
  rationale: string;
}

/**
 * §1 + §2 + §3 of the ratified doc, transcribed. Ascending, contiguous, and the
 * last band is unbounded above — {@link mandateBandFor} relies on all three.
 *
 * ⚠ The band edges are NOT the tape's bucket edges. `option-tape-expectancy.ts`
 * buckets at hundredths (…0.45, 0.50, 0.55…); the authorization turns at 0.495,
 * which is where the retired cost bar's algebraic floor happened to land and which
 * §3 kept deliberately (`|Δ| ≥ 0.45` and `|Δ| ≥ 0.495` both DECLINE as half-lines;
 * only the bounded `[0.495, 0.55)` passes). The two axes are allowed to disagree
 * and the disagreement is one-directional: the tape declines `[0.45, 0.50)`, which
 * is TIGHTER than the mandate over `[0.495, 0.50)`. Tighter is safe; the mandate
 * never admits anything the tape declines.
 */
export const OTM_SLEEVE_MANDATE_BANDS: readonly MandateBand[] = [
  {
    from: 0,
    to: 0.2,
    label: '[0.00,0.20)',
    authorization: 'de_authorized',
    evidence: { n: 691, meanR_gate: -0.1245, seR_gate: null, lowerCI95: null, t: null },
    cells: [
      { label: '0.00-0.10', n: 638, meanR_gate: -0.117, seR_gate: 0.026, lowerCI95: -0.169, t: -4.45 },
      { label: '0.10-0.20', n: 53, meanR_gate: -0.212, seR_gate: 0.068, lowerCI95: -0.345, t: -3.11 },
    ],
    rationale:
      'The band the sleeve was historically authorized to hunt (|Δ| 0.02-0.07) is the single most '
      + 'significantly negative cell on the tape. BOTH constituent cells clear the Bonferroni bar '
      + '(|t| >= 2.73 over 8 buckets) and both are NEGATIVE. De-authorized by evidence, permanently: '
      + 'the mandate was wrong, not the gate. No bar, k or win-prob multiplier may reopen it — the '
      + 'multiplier the tape would require is 8.21, outside its own [0,5] clamp.',
  },
  {
    from: 0.2,
    to: 0.45,
    label: '[0.20,0.45)',
    authorization: 'insufficient_evidence',
    evidence: { n: 216, meanR_gate: null, seR_gate: null, lowerCI95: null, t: null },
    cells: [
      { label: '0.20-0.30', n: 64, meanR_gate: 0.093, seR_gate: 0.045, lowerCI95: 0.006, t: 2.1 },
      { label: '0.30-0.40', n: 123, meanR_gate: 0.268, seR_gate: 0.254, lowerCI95: -0.229, t: 1.06 },
      { label: '0.40-0.45', n: 29, meanR_gate: -0.434, seR_gate: 0.886, lowerCI95: -2.17, t: -0.49 },
    ],
    rationale:
      'ZERO rows on the five live-universe names, ever — the 216 rows are entirely other symbols, '
      + 'and no cell clears Bonferroni. Doc §5 pre-registers the reopening test (demo-only, five '
      + 'names, n >= 100, PASS iff lo95 >= 0.485) and records that it CANNOT currently fire: zero '
      + 'in-band rows on any symbol in 30 days. Closed for ignorance, not for failure.',
  },
  {
    from: 0.45,
    to: 0.495,
    label: '[0.45,0.495)',
    authorization: 'not_authorized',
    evidence: { n: 59, meanR_gate: 0.728, seR_gate: 0.43, lowerCI95: -0.115, t: 1.69 },
    rationale:
      'Measured and adequately powered, and it FAILS the admission rule: lo95 -0.115 < 0.485 bar. '
      + 'This is the band TRA-3388 Ruling 4 recommended authorizing; doc §3 declines it on the '
      + 'admission rule Ruling 2 itself adopted.',
  },
  {
    from: 0.495,
    to: 0.55,
    label: '[0.495,0.55)',
    authorization: 'authorized',
    evidence: { n: 100, meanR_gate: 1.626, seR_gate: 0.422, lowerCI95: 0.799, t: 3.85 },
    rationale:
      'The ONLY construction that passes: lo95 +0.799 >= 0.485 bar. PROVISIONAL (doc §4) — the '
      + 'evidence is TRANSFERRED, not native: the live universe [AAPL,SPY,QQQ,PLTR,TSLA] holds 471 '
      + 'OTM rows and every one is |Δ| < 0.20, so ZERO of the authorizing rows come from a name the '
      + 'sleeve may trade. It is also concentrated (NKE n=15 alone contributes +0.848R of the '
      + '+0.994R at |Δ| >= 0.45) and exit-dependent (a trailing-stop tail, not a take-profit edge). '
      + 'Doc §6 lapses it rather than retuning it.',
  },
  {
    from: 0.55,
    to: null,
    label: '[0.55,inf)',
    authorization: 'insufficient_evidence',
    evidence: { n: 20, meanR_gate: -1.072, seR_gate: 0.634, lowerCI95: -2.316, t: -1.69 },
    rationale:
      'Underpowered (n=20 < 30) AND negative on the point estimate. The authorization is '
      + '`insufficient_evidence` because n is what forecloses it under the admission rule, but the '
      + 'sign is why the CEILING exists: an open half-line above 0.495 admits this cell, and the '
      + 'cost bar — a floor by construction — cannot reach it. See ENABLE_OPTION_ENTRY_DELTA_CEILING_LIVE.',
  },
];

/** Structures the mandate governs. Frozen key (§7) — the LABEL is what changed. */
const MANDATED_STRUCTURES: ReadonlyMap<string, readonly MandateBand[]> = new Map([
  [OTM_SLEEVE_MANDATE_STRUCTURE, OTM_SLEEVE_MANDATE_BANDS],
]);

/** The ratified band table for a structure, or `null` when it has no mandate. */
export function mandateBandsFor(structure: string): readonly MandateBand[] | null {
  return MANDATED_STRUCTURES.get(structure.trim().toLowerCase()) ?? null;
}

/**
 * The band a candidate's |delta| falls in, or `null` when the structure has no
 * mandate or the delta is unusable.
 *
 * `null` is NOT "authorized" and it is NOT "de-authorized" — it means the table
 * has nothing to say, and every caller must decide on its own axis. Returning a
 * band for an unmeasurable delta would be the TRA-1691 `unknown ≠ lt0.20` error.
 */
export function mandateBandFor(structure: string, delta: number): MandateBand | null {
  const bands = mandateBandsFor(structure);
  if (bands === null) return null;
  const d = Math.abs(delta);
  if (!Number.isFinite(d)) return null;
  for (const band of bands) {
    if (d >= band.from && (band.to === null || d < band.to)) return band;
  }
  return null;
}

/**
 * True iff this candidate sits in a band closed PERMANENTLY BY EVIDENCE.
 *
 * This is the predicate that must be consulted BEFORE any bar arithmetic, and it
 * is deliberately narrower than "not authorized": only `de_authorized` bands
 * answer true. An `insufficient_evidence` band is closed too, but it is closed by
 * ignorance and §5 says what would reopen it — collapsing the two back into one
 * boolean is the exact conflation TRA-3394 item 2 exists to end.
 */
export function isDeAuthorizedBand(structure: string, delta: number): boolean {
  return mandateBandFor(structure, delta)?.authorization === 'de_authorized';
}

/**
 * The upper edge of the AUTHORIZED band for a structure — the number the live
 * entry-delta ceiling enforces — or `null` when the structure has no mandate (and
 * therefore no ceiling: an unmandated sleeve stays uncapped rather than inheriting
 * an extrapolated number, the TRA-1689 rule).
 *
 * Derived from the table rather than written down twice on purpose: an operator
 * cannot arm a ceiling that disagrees with the ratified authorization, because
 * there is no second place to state it.
 */
export function mandateCeilingFor(structure: string): number | null {
  const bands = mandateBandsFor(structure);
  if (bands === null) return null;
  const authorized = bands.filter((b) => b.authorization === 'authorized');
  if (authorized.length === 0) return null;
  // Unbounded-above authorized band ⇒ no ceiling exists to enforce.
  if (authorized.some((b) => b.to === null)) return null;
  return Math.max(...authorized.map((b) => b.to as number));
}

/** The lower edge of the authorized band, for the readout. Null when unmandated. */
export function mandateFloorFor(structure: string): number | null {
  const bands = mandateBandsFor(structure);
  if (bands === null) return null;
  const authorized = bands.filter((b) => b.authorization === 'authorized');
  if (authorized.length === 0) return null;
  return Math.min(...authorized.map((b) => b.from));
}
