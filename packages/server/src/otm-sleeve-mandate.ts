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

// ─── TRA-4416 — THE BOARD OVERRIDE, RECORDED RATHER THAN IMPLIED ─────────────
//
// On 2026-09-09 the board answered card `439c4e46` with `widen_live_anyway`,
// with the full authorization table in view, directing the LIVE `single_leg_otm`
// selector to trade |Δ| ∈ [0.25, 0.40]. The ratified table above authorizes
// [0.495, 0.55) and classes [0.25, 0.40] as `insufficient_evidence` (n=216).
//
// That decision is accepted and is NOT re-litigated here. What TRA-4416 fixes is
// that the two numbers disagreed SILENTLY: `mandateBandFor` said one thing, the
// live selector and the contract floor did another, and nothing anywhere
// reported the disagreement. An armed selector whose band contradicts its own
// mandate is precisely the "reads identically in pass and fail" shape.
//
// ── Why this is option (b) of AC1 and not option (a) ─────────────────────────
//
// AC1 offered two shapes: (a) AMEND `authorizedBand` to match what is enforced,
// or (b) carry an explicit machine-readable override block naming the card.
// (a) is REFUSED, and the reason is AC5 ("no change to what trades"), not taste:
//
//   `mandateCeilingFor` is the sole source of the number the LIVE entry-delta
//   ceiling enforces (`option-entry-delta-ceiling-live.ts`), and that gate is
//   ARMED (`mode: 'enforce'`, measured on bqb1 `08f78eb46caa` 2026-09-22T22:30Z).
//   Amending the authorized band to [0.25, 0.40] moves the enforced ceiling from
//   0.55 to 0.40. The ceiling blocks on `|Δ| >= ceiling` while the contract
//   floor admits its `deltaMax` INCLUSIVELY, so a contract at exactly |Δ| = 0.40
//   — admitted today — would start being refused. That is a change to what
//   trades, made by a documentation ticket. Refused.
//
// So the override is recorded BESIDE the table and deliberately does NOT feed
// `mandateBandFor`, `mandateCeilingFor`, `mandateFloorFor` or `isDeAuthorizedBand`.
// Every one of those stays byte-for-byte the function it was. The override is an
// OBSERVABILITY record and a provenance anchor; moving an enforcement number is a
// separate act with its own authorization.

/** The band a board override directs the live selector at. Inclusive both ends. */
export interface MandateOverrideBand {
  from: number;
  to: number;
  label: string;
}

/**
 * A board decision that directs the live sleeve at a band the ratified table
 * does not authorize. Recorded, never applied — see the block above.
 */
export interface MandateBoardOverride {
  /** The ticket that recorded the incoherence. */
  issue: string;
  /** The board card carrying the decision. The provenance AC1 asks for. */
  card: string;
  /** The answer the board gave, verbatim. */
  decision: string;
  decidedAt: string;
  /** The band the live selector was directed at. */
  directedBand: MandateOverrideBand;
  /**
   * What the RATIFIED table says about that band, unchanged. Published beside
   * the override so a reader never has to re-derive whether the two agree.
   */
  ratifiedAuthorizationOfDirectedBand: MandateAuthorization;
  /**
   * ⛔ ALWAYS FALSE, and it is a literal rather than a comment so a future edit
   * that starts applying an override has to change a field a test asserts on.
   */
  amendsRatifiedTable: false;
  rationale: string;
}

/** The overrides on record, by structure. Empty for every unmandated sleeve. */
const MANDATE_BOARD_OVERRIDES: ReadonlyMap<string, readonly MandateBoardOverride[]> = new Map([
  [
    OTM_SLEEVE_MANDATE_STRUCTURE,
    Object.freeze([
      Object.freeze({
        issue: 'TRA-4416',
        card: '439c4e46',
        decision: 'widen_live_anyway',
        decidedAt: '2026-09-09',
        directedBand: Object.freeze({ from: 0.25, to: 0.40, label: '[0.25,0.40]' }),
        ratifiedAuthorizationOfDirectedBand: 'insufficient_evidence' as MandateAuthorization,
        amendsRatifiedTable: false as const,
        rationale:
          'The board answered card 439c4e46 `widen_live_anyway` on 2026-09-09 with the full '
          + 'authorization table in view, directing the live single_leg_otm selector at |delta| in '
          + '[0.25, 0.40]. The ratified table classes that band `insufficient_evidence` (n=216, zero '
          + 'rows on any of the five live-universe names, no cell clearing Bonferroni). This record '
          + 'does NOT amend the table: mandateCeilingFor() is the number the ARMED live entry-delta '
          + 'ceiling enforces, so amending it here would move an enforcement edge from 0.55 to 0.40 '
          + 'and start refusing contracts at exactly |delta| 0.40 that the contract floor admits '
          + 'today — a change to what trades, which TRA-4416 AC5 forbids. Recorded so the '
          + 'disagreement is explicit; changing what is enforced is a separate authorization.',
      }),
    ]),
  ],
]);

/** Board overrides on record for a structure. Never null — an empty list is a real answer. */
export function mandateBoardOverridesFor(structure: string): readonly MandateBoardOverride[] {
  return MANDATE_BOARD_OVERRIDES.get(structure.trim().toLowerCase()) ?? [];
}

// ─── TRA-4416 AC2 — |Δ| INTERVALS, WITH THEIR EDGE SEMANTICS CARRIED ─────────
//
// ⛔ THE TWO LIVE FILTERS DO NOT AGREE ON THEIR TOP EDGE, and the difference is
// one real contract wide. MEASURED IN THE SOURCE, not assumed:
//
//   selector  `otm-admissible-strike.ts:306`  `abs >= min && abs <  max`  ⇒ [min, max)
//   floor     `otm-contract-floor.ts:294`     `abs >= min && abs <= max`  ⇒ [min, max]
//
// Both read [0.25, 0.40] on the live box, so the ADMITTED set is their
// intersection [0.25, 0.40) — the selector's exclusive top wins and a contract
// at exactly |Δ| 0.40 is NOT admitted. A containment or coverage check that
// hard-codes one convention gets that contract wrong in one direction or the
// other, which is the entire class of bug this ticket is about. So the edge
// travels WITH the interval and is published on the wire.

/** A half-open or closed |Δ| interval. Lower edge is always inclusive. */
export interface DeltaInterval {
  from: number;
  to: number;
  /** TRUE ⇒ `[from, to]`; FALSE ⇒ `[from, to)`. Never inferred. */
  upperInclusive: boolean;
  label: string;
}

/** `[a, b)` / `[a, b]` with the label spelled to match. */
export function deltaInterval(from: number, to: number, upperInclusive: boolean): DeltaInterval {
  return {
    from,
    to,
    upperInclusive,
    label: `[${from},${to}${upperInclusive ? ']' : ')'}`,
  };
}

/** True iff the interval contains no |Δ| at all. */
export function isEmptyDeltaInterval(i: DeltaInterval): boolean {
  return i.upperInclusive ? !(i.from <= i.to) : !(i.from < i.to);
}

/**
 * The intersection of two intervals, or `null` when they do not overlap.
 * The narrower top edge wins, and on a tie the EXCLUSIVE one wins.
 */
export function intersectDeltaIntervals(a: DeltaInterval, b: DeltaInterval): DeltaInterval | null {
  const from = Math.max(a.from, b.from);
  const to = Math.min(a.to, b.to);
  const upperInclusive = a.to === b.to
    ? a.upperInclusive && b.upperInclusive
    : (a.to < b.to ? a.upperInclusive : b.upperInclusive);
  const out = deltaInterval(from, to, upperInclusive);
  return isEmptyDeltaInterval(out) ? null : out;
}

/** True iff every |Δ| in `inner` is also in `outer`. Assumes neither is empty. */
export function deltaIntervalContains(outer: DeltaInterval, inner: DeltaInterval): boolean {
  if (inner.from < outer.from) return false;
  if (inner.to < outer.to) return true;
  if (inner.to > outer.to) return false;
  // Same top edge: an inclusive inner needs an inclusive outer.
  return outer.upperInclusive || !inner.upperInclusive;
}

/** `within` / `outside` / `empty` / `unmeasured` — four states, deliberately. */
export type MandateContainmentStatus = 'within' | 'outside' | 'empty' | 'unmeasured';

/**
 * AC2 — does the band the live sleeve actually admits sit inside the band the
 * mandate authorizes?
 *
 * ⛔ `liveBandWithinAuthorized` IS THREE-VALUED AND `null` IS NOT `true`.
 * An unreadable live band, or a structure with no ratified authorization, MUST
 * NOT render as a satisfied check — an absent instrument reading as green is the
 * failure this desk keeps eating (`UNKNOWN` ≠ `OFF`). Callers must branch on
 * `status`, and `??  true`/`!== false` on this field is a bug.
 *
 * ⛔ `empty` IS ITS OWN STATUS AND IS NOT `within`. An empty admitted set is
 * vacuously a subset of anything, so the set-theoretic answer is `true` and the
 * operational answer is "this sleeve admits nothing" — two completely different
 * situations that a bare boolean folds into one cell. That fold is what makes a
 * non-intersecting band pair read as a healthy mandate.
 */
export interface MandateBandContainment {
  structure: string;
  /** The |Δ| set the live sleeve actually admits, as measured. `null` = unreadable. */
  admittedBand: DeltaInterval | null;
  /** The ratified authorization, half-open. `null` = the structure is unmandated. */
  authorizedBand: DeltaInterval | null;
  /** ⛔ THREE-VALUED. `false` = the live band escapes the authorization. `null` = unmeasured. */
  liveBandWithinAuthorized: boolean | null;
  status: MandateContainmentStatus;
  /**
   * What the ratified table says about the admitted band's edges — so `outside`
   * carries WHICH authorization is being exceeded, not merely that one is.
   * Empty when the admitted band is unreadable.
   */
  admittedBandAuthorizations: readonly { at: number; band: string | null; authorization: MandateAuthorization | null }[];
  /** The board overrides on record that could explain an `outside`. */
  boardOverrides: readonly MandateBoardOverride[];
  reason: string;
}

/**
 * Grade the live admitted band against the ratified authorization.
 *
 * `admittedBand === null` means the caller could not READ the live band — not
 * that the band is fine. It yields `unmeasured`, which is the only honest answer
 * and is never green.
 */
export function assessMandateBandContainment(
  structure: string,
  admittedBand: DeltaInterval | null,
): MandateBandContainment {
  const overrides = mandateBoardOverridesFor(structure);
  const floor = mandateFloorFor(structure);
  const ceiling = mandateCeilingFor(structure);
  // The authorized band is half-open — `[0.495, 0.55)`, upper edge EXCLUSIVE.
  const authorizedBand = floor === null || ceiling === null
    ? null
    : deltaInterval(floor, ceiling, false);

  const authorizationsAt = (i: DeltaInterval) => {
    // Sample the edges, not the whole line: the band table is a partition, so the
    // authorization can only change at a band edge, and the admitted interval's own
    // two edges are what a reader needs to see named.
    const probes = [i.from, i.upperInclusive ? i.to : Math.max(i.from, i.to - 1e-9)];
    const seen = new Set<string>();
    const out: { at: number; band: string | null; authorization: MandateAuthorization | null }[] = [];
    for (const at of probes) {
      const band = mandateBandFor(structure, at);
      const key = band?.label ?? 'null';
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ at, band: band?.label ?? null, authorization: band?.authorization ?? null });
    }
    return out;
  };

  if (admittedBand === null) {
    return {
      structure,
      admittedBand: null,
      authorizedBand,
      liveBandWithinAuthorized: null,
      status: 'unmeasured',
      admittedBandAuthorizations: [],
      boardOverrides: overrides,
      reason:
        'UNMEASURED — the live admitted |delta| band could not be read, so this check has no subject. '
        + 'This is NOT a pass: an absent instrument and a satisfied one must never share a cell.',
    };
  }

  if (authorizedBand === null) {
    return {
      structure,
      admittedBand,
      authorizedBand: null,
      liveBandWithinAuthorized: null,
      status: 'unmeasured',
      admittedBandAuthorizations: authorizationsAt(admittedBand),
      boardOverrides: overrides,
      reason:
        `UNMEASURED — ${structure} has no ratified authorized band (no band in the table is `
        + '`authorized`, or the structure is unmandated), so there is nothing for the live band to be '
        + 'inside of. Not a pass — the TRA-1689 rule keeps an unmandated sleeve uncapped rather than '
        + 'inheriting an extrapolated number, and that is a statement about the CEILING, not a clean bill.',
    };
  }

  if (isEmptyDeltaInterval(admittedBand)) {
    return {
      structure,
      admittedBand,
      authorizedBand,
      liveBandWithinAuthorized: null,
      status: 'empty',
      admittedBandAuthorizations: [],
      boardOverrides: overrides,
      reason:
        `EMPTY — the live sleeve admits NO |delta| at all (${admittedBand.label}). An empty set is `
        + 'vacuously a subset of the authorization, so the set-theoretic answer is `true` and it is '
        + 'meaningless here; the field is `null` rather than `true` so a non-intersecting band pair can '
        + 'never read as a healthy mandate. See `bandIntersectsSelector` on /api/health/options-live.',
    };
  }

  const within = deltaIntervalContains(authorizedBand, admittedBand);
  const auths = authorizationsAt(admittedBand);
  return {
    structure,
    admittedBand,
    authorizedBand,
    liveBandWithinAuthorized: within,
    status: within ? 'within' : 'outside',
    admittedBandAuthorizations: auths,
    boardOverrides: overrides,
    reason: within
      ? `WITHIN — the live admitted band ${admittedBand.label} is a subset of the ${OTM_SLEEVE_MANDATE_ISSUE} `
        + `authorization ${authorizedBand.label}. The selector and the mandate agree.`
      : `OUTSIDE — the live admitted band ${admittedBand.label} is NOT a subset of the `
        + `${OTM_SLEEVE_MANDATE_ISSUE} authorization ${authorizedBand.label}. The sleeve is admitting `
        + `|delta| the ratified table does not authorize (${auths.map((a) => `${a.band ?? 'unmandated'}: `
        + `${a.authorization ?? 'no authorization'}`).join('; ')}). `
        + (overrides.length > 0
          ? `This is EXPECTED and ACCOUNTED FOR: board card ${overrides.map((o) => o.card).join(', ')} `
            + `(${overrides.map((o) => o.decision).join(', ')}) directs it. The override is recorded in `
            + '`boardOverrides` and does NOT amend the ratified table — see mandateBoardOverridesFor().'
          : '⛔ NO BOARD OVERRIDE IS ON RECORD for this structure. The live selector is outside its '
            + 'ratified authorization with nothing authorizing it. Escalate — do not widen the table.'),
  };
}

// ─── TRA-4416 AC4 — THE REOPENING COHORT IS KEYED ON MODE, NOT ON BAND ───────
//
// ⛔ THE BAND DOES NOT SEPARATE THESE TWO POPULATIONS, AND IT LOOKS LIKE IT DOES.
//
// Doc §5 pre-registers the ONLY test that may reopen `[0.20, 0.45)`: a DEMO-ONLY
// forward test on the five live-universe names, n >= 100 closes, PASS iff
// `mean(R_gate) − 1.96·SE >= 0.485` (TRA-4053). It was written when `[0.20, 0.45)`
// had no accrual path at all — zero rows on the five names, ever.
//
// Board card `439c4e46` then pointed the LIVE selector at [0.25, 0.40], and
// `[0.25, 0.40] ⊂ [0.20, 0.45)`. So a live population is now accruing INSIDE the
// pre-registered band, and any cohort query keyed on the band alone silently
// pools real-money fills into a demo-only acceptance test. That test would then
// "pass" on rows it was explicitly written to exclude, and the reopening would be
// self-authorizing: the band reopens itself using trades the override permitted.
//
// The key is therefore `mode` AND `structure` AND band — with `mode` doing the
// actual separating work, because it is the only one of the three that differs.
// A row that cannot PROVE it is demo is not in the cohort (fail-closed): an
// unknown `mode` is excluded, never admitted, because the expensive direction
// here is admitting a live fill.

/** The pre-registered reopening cohort of doc §5 / TRA-4053, as data. */
export const MANDATE_REOPENING_COHORT = Object.freeze({
  issue: 'TRA-4053',
  authorization: `${OTM_SLEEVE_MANDATE_ISSUE} doc §5, ratified verbatim from TRA-3388 Ruling 4`,
  structure: OTM_SLEEVE_MANDATE_STRUCTURE,
  /** ⛔ THE DISCRIMINATOR. Live rows are not cohort members at ANY delta. */
  mode: 'demo' as const,
  band: Object.freeze({ from: 0.20, to: 0.45, upperInclusive: false, label: '[0.20,0.45)' }),
  symbols: Object.freeze(['AAPL', 'SPY', 'QQQ', 'PLTR', 'TSLA']),
  minN: 100,
  passIfLower95AtLeast: 0.485,
  fixtureRowsCount: false,
  note:
    'Demo-only forward test, five live-universe names, |delta| in [0.20,0.45), exit policy unchanged, '
    + 'n >= 100 closes, PASS iff mean(R_gate) - 1.96*SE >= 0.485. No fixture rows count, no fold '
    + 'across other symbols.',
});

/** A row as the cohort filter sees it. `mode`/`symbol` may be absent — that is the point. */
export interface MandateCohortRow {
  mode?: string | null;
  structure?: string | null;
  symbol?: string | null;
  absDelta?: number | null;
}

/** Why a row is not in the cohort. `null` when it IS. */
export type MandateCohortExclusion =
  | 'mode_not_demo'
  | 'mode_unknown'
  | 'structure_mismatch'
  | 'symbol_not_in_universe'
  | 'delta_unreadable'
  | 'delta_out_of_band';

/**
 * AC4 — is this row a member of TRA-4053's pre-registered reopening cohort?
 *
 * FAIL-CLOSED on every unreadable field. In particular a row whose `mode` cannot
 * be read is excluded with `mode_unknown` rather than admitted: pooling one live
 * fill into a demo-only acceptance test is the failure this function exists to
 * prevent, and "we could not tell" must land on the safe side of it.
 */
export function mandateReopeningCohortMembership(
  row: MandateCohortRow,
): { member: boolean; excludedBecause: MandateCohortExclusion | null } {
  const no = (excludedBecause: MandateCohortExclusion) => ({ member: false, excludedBecause });

  const mode = typeof row.mode === 'string' ? row.mode.trim().toLowerCase() : null;
  if (mode === null || mode === '') return no('mode_unknown');
  // ⛔ THE LINE THAT MAKES THE TWO POPULATIONS DISJOINT. Do not relax it to
  // "not a fixture" or to a band check — [0.25,0.40] sits inside [0.20,0.45).
  if (mode !== MANDATE_REOPENING_COHORT.mode) return no('mode_not_demo');

  const structure = typeof row.structure === 'string' ? row.structure.trim().toLowerCase() : null;
  if (structure !== MANDATE_REOPENING_COHORT.structure) return no('structure_mismatch');

  const symbol = typeof row.symbol === 'string' ? row.symbol.trim().toUpperCase() : null;
  if (symbol === null || !MANDATE_REOPENING_COHORT.symbols.includes(symbol)) {
    return no('symbol_not_in_universe');
  }

  const d = typeof row.absDelta === 'number' ? Math.abs(row.absDelta) : Number.NaN;
  if (!Number.isFinite(d)) return no('delta_unreadable');
  const { from, to } = MANDATE_REOPENING_COHORT.band;
  if (!(d >= from && d < to)) return no('delta_out_of_band');

  return { member: true, excludedBecause: null };
}

/**
 * AC4's published proof: the live band directed by a board override is disjoint
 * from the reopening cohort, and WHY — so the claim is checkable on the wire and
 * does not rest on someone remembering that the cohort is demo-only.
 */
export interface MandateCohortDisjointness {
  cohort: typeof MANDATE_REOPENING_COHORT;
  /** The live band the override directs, if any. */
  liveBand: MandateOverrideBand | null;
  /** ⛔ TRUE, and NOT because the bands miss each other. Read `bandsOverlap`. */
  disjointFromLivePopulation: boolean;
  /** TRUE today — the live band is INSIDE the cohort band. The trap, published. */
  bandsOverlap: boolean;
  /** The field that actually separates them. */
  separatedBy: 'mode';
  reason: string;
}

/** Grade the cohort against whatever board override is on record for a structure. */
export function assessMandateCohortDisjointness(structure: string): MandateCohortDisjointness {
  const override = mandateBoardOverridesFor(structure)[0] ?? null;
  const liveBand = override?.directedBand ?? null;
  const { from, to } = MANDATE_REOPENING_COHORT.band;
  const bandsOverlap = liveBand !== null && liveBand.from < to && liveBand.to >= from;

  // The disjointness is proven by the FILTER, not asserted: a live row at the
  // live band's own edges is run through the real membership function.
  const probes = liveBand === null ? [] : [liveBand.from, (liveBand.from + liveBand.to) / 2, liveBand.to];
  const anyLiveMember = probes.some((absDelta) =>
    MANDATE_REOPENING_COHORT.symbols.some((symbol) =>
      mandateReopeningCohortMembership({ mode: 'live', structure, symbol, absDelta }).member));

  return {
    cohort: MANDATE_REOPENING_COHORT,
    liveBand,
    disjointFromLivePopulation: !anyLiveMember,
    bandsOverlap,
    separatedBy: 'mode',
    reason: liveBand === null
      ? `No board override is on record for ${structure}, so no live population has been directed `
        + `into the cohort band ${MANDATE_REOPENING_COHORT.band.label}.`
      : bandsOverlap
        ? `⛔ THE BANDS OVERLAP: the board-directed live band ${liveBand.label} sits INSIDE the `
          + `pre-registered cohort band ${MANDATE_REOPENING_COHORT.band.label}, so a cohort query keyed `
          + 'on the band alone would pool real-money fills into a DEMO-ONLY acceptance test and let '
          + `${MANDATE_REOPENING_COHORT.issue} reopen the band using the very trades the override `
          + `permitted. They are disjoint ONLY because membership requires \`mode === 'demo'\` — `
          + `verified here by running live rows at ${probes.map((p) => p.toFixed(2)).join(' / ')} through `
          + `mandateReopeningCohortMembership(), all excluded (\`mode_not_demo\`). Never key this cohort `
          + 'on band alone.'
        : `The board-directed live band ${liveBand.label} does not meet the cohort band `
          + `${MANDATE_REOPENING_COHORT.band.label}; membership additionally requires \`mode === 'demo'\`.`,
  };
}
