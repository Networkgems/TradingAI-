/**
 * TRA-3102 — is this live-calendar cell's rendered figure BROKER-SOURCED?
 *
 * `generateEodReport` computes the calendar figure as
 * `realizedPnl + optionsPnl`, and `optionsPnl` is summed from the ENGINE's own
 * `closedOptions` book (`eod-report.ts`, the `todayClosedOptions` filter). On a
 * demo book that is the only source there is and it is correct. On a LIVE book
 * it is a number the broker never confirmed: any engine-side close that never
 * corresponded to a broker fill books straight into a real-money cell, and
 * nothing in the write path compares it against the broker.
 *
 * Measured on the live production account (69 stored cells, read 2026-08-06
 * through the admin read-only report routes):
 *
 *   • **46 of 69 rows carry no `pnlSource` at all.** ⛔ THIS IS THE REACH GATE.
 *     The obvious scope test — `pnlSource === 'engine'` — reaches **zero** of
 *     them, and 20 of those 46 carry a non-zero engine options figure. It is the
 *     same trap TRA-3101 hit: a gate keyed on a field added later cannot reach
 *     the rows that predate it, and those are the broken ones. So the class is
 *     decided by ALLOW-LIST — only `tradier-balance` / `realized-backfill` are
 *     broker-derived. An absent label is its own class (`unlabelled`, TRA-5118;
 *     it used to be silently folded into `engine`) and is graded, never skipped:
 *     not knowing the measure is a reason to audit, never a reason to skip.
 *
 *   • **3 of 14 `tradier-balance` rows render a figure their own header
 *     contradicts.** 2026-07-15 states "= +0.00" in prose and carries
 *     `combinedPnl: 17`; 07-17 states "+300.00" and carries `217.50`; 07-21
 *     states "+0.00" and carries `80.50`. In all three the stored figure equals
 *     `optionsPnl` to the cent — the broker-truth override was stamped and then
 *     the engine/journal options re-source overwrote the calendar figure
 *     underneath it, leaving `pnlSource: 'tradier-balance'` and a broker header
 *     on a cell that no longer holds a broker number.
 *
 * ★ The header is why this is gradeable at all without a broker round trip. A
 * `tradier-balance` row RECORDS its own broker computation in prose, so the row
 * carries the evidence that convicts it: the audit reads the figure back out and
 * grades the JSON against it. 14 of 14 live rows parse, so the blind arm below is
 * a real fail-closed guard rather than a permanent false positive.
 *
 * ⛔ Nothing here corrects a number. As on TRA-3101, the stored figure stays
 * exactly what it was; what changes is whether the row CLAIMS it. Re-deriving a
 * P&L by inference is how the phantom-green calendar happened in the first place
 * (TRA-2864), and the broker figure a clobbered row states in prose is itself
 * only as good as the cash-flow span behind it (07-17's "+300.00" is one of the
 * ACH deposits TRA-2875 enumerated).
 *
 * TRA-5118 — three defects in THIS instrument, found by grading it against
 * TRA-3100's nine permanently-uncorrectable cells (it said `ok` to 8 of the 9,
 * and the one it flagged had the smallest gap):
 *
 *   1. The engine branch early-returned `ok` on `optionsPnl == 0` BEFORE the
 *      broker leg was read — a 2-term detector graded as "it fires" instead of
 *      as a 4-quadrant matrix. The missing quadrant (engine leg zero, broker leg
 *      NOT zero) is where 5 of the 9 lived; it now has its own status,
 *      `broker_realized_without_cell_pnl`.
 *   2. `classifyCellPnlSource(undefined)` guessed `'engine'` — the exact
 *      absence-to-guessed-source mapping TRA-5095 ruled out for the client — and
 *      the guess was load-bearing: it routed unlabelled real-money rows into the
 *      branch that early-returned `ok`. Absence is now its own class.
 *   3. `ok` serialized as NOTHING, so "ties to the broker", "the broker was
 *      never consulted" and "I guessed the source" were byte-identical on the
 *      wire. The verdict is now stamped on every graded row
 *      (`BrokerSourceAuditStamp`), `ok` included.
 */

/** The `pnlSource` labels a stored calendar row can carry. */
export type StoredPnlSource = 'engine' | 'tradier-balance' | 'realized-backfill' | 'live-intraday';

/**
 * How the row's calendar figure was SOURCED, as opposed to what it is labelled.
 *
 *  - `broker`     — derived from broker data (a balance delta, or FIFO-matched fills).
 *  - `engine`     — derived from the engine's own book. Needs reconciling on a
 *                   live account.
 *  - `intraday`   — today's unsettled running figure; labelled as such and not
 *                   yet a claim about a closed day.
 *  - `unlabelled` — the row carries NO `pnlSource` at all (TRA-5118). TRA-5095
 *                   ruled that the correct per-cell label for a no-`pnlSource`
 *                   row is an explicit `unlabelled` state, never an inferred
 *                   source; the client (`pnl-day.tsx`, `UNLABELLED_MEASURE`)
 *                   already complies, and until TRA-5118 this module contradicted
 *                   it by guessing `engine`. The grading rule for the class is
 *                   decided explicitly, not inherited by fall-through: an
 *                   unlabelled row is graded on the same options-leg-vs-broker
 *                   4-quadrant comparison as an engine row — whatever the
 *                   rendered figure measures, `optionsPnl` comes off the engine's
 *                   own book, so that leg is comparable — but the class is
 *                   PUBLISHED as `unlabelled` and no detail string claims the
 *                   row is engine-sourced.
 */
export type CellSourceClass = 'broker' | 'engine' | 'intraday' | 'unlabelled';

/**
 * ⛔ THE REACH GATE. Allow-list, deliberately.
 *
 * A denylist (`pnlSource === 'engine'`) reaches 0 of the 46 unlabelled live rows.
 * An unknown or absent label means the row's provenance was never recorded, and
 * "not recorded" is not evidence of broker truth — it is exactly the population
 * that predates broker sourcing.
 *
 * TRA-5118 — an ABSENT label is `unlabelled`, its own class, graded by the same
 * broker comparison as `engine` but never published as a guessed source. An
 * unrecognised FUTURE label stays `engine`: a label we do not recognise is not
 * broker evidence, and "engine until proven otherwise" is the allow-list.
 */
export function classifyCellPnlSource(pnlSource: string | undefined): CellSourceClass {
  if (pnlSource === 'tradier-balance' || pnlSource === 'realized-backfill') return 'broker';
  if (pnlSource === 'live-intraday') return 'intraday';
  if (pnlSource === undefined || pnlSource === '') return 'unlabelled';
  return 'engine';
}

/**
 * Pull the broker-truth figure a `tradier-balance` row states in its own header.
 *
 * Matches the TRA-359 header written by `decideBalanceCellDisposition`, whose
 * final term is the computed delta: `… − net cash flow (+0.00) = **+0.00**.`
 * Anchored on the header's own sentinel so the intraday (TRA-1192) and backfill
 * (TRA-244) headers — which have the same `= **X**` shape but a different
 * meaning — can never be read as a settled broker delta.
 *
 * Returns `null` when there is no such header or it does not parse. The caller
 * must treat `null` as BLIND, never as agreement.
 */
export function brokerFigureFromHeader(markdown: string | undefined): number | null {
  if (typeof markdown !== 'string' || markdown === '') return null;
  // FIRST matching line, not last: `applyTradierBalanceOverride` PREPENDS its
  // header, so on a row whose override ran more than once the newest computation
  // is on top and is the one the stored figure should correspond to.
  const line = markdown
    .split('\n')
    .find(l => l.includes('Live P&L source: Tradier broker balance (TRA-359).'));
  if (line == null) return null;
  // The header's other dollar figures (equity, prev snapshot, cash flow) are
  // parenthesised inputs; only the computed delta is written as `= **…**`, so
  // this term is unambiguous on the sentinel line.
  const match = /=\s*\*\*([+-]?[\d,]+\.\d{2})\*\*/.exec(line);
  if (match === null) return null;
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

/** Which evidence carried the broker leg of the comparison (TRA-5118). */
export type BrokerEvidenceSource = 'sidecar' | 'fifo_row' | 'sidecar_quiet';

/**
 * What we could establish about broker activity on the report date.
 *
 * `known: false` is a read that FAILED, and it is a different claim from a read
 * that succeeded and found nothing (`known: true` with `realizedUsd: 0`).
 * Collapsing the two is the failure-blind-read shape this whole cluster is
 * about — see TRA-3073.
 *
 * ⚠️ SCOPE, stated because a partial comparison that does not say so reads as a
 * full one: `realizedUsd` is the broker's realized **options** P&L for the date
 * (the `tradier-options-pnl.<env>.json` sidecar, or the row's own TRA-4201 FIFO
 * reconstruction — `source` says which). The audit therefore grades the OPTIONS
 * leg — which is the leg sourced from `closedOptions` and the whole mechanism of
 * this ticket — and never claims to have graded equity realized.
 */
export type BrokerDayEvidence =
  | { known: true; realizedUsd: number; source?: BrokerEvidenceSource }
  | { known: false; reason: string };

/**
 * TRA-5118 — assemble the broker leg for one date WITHOUT letting `?? 0`
 * manufacture "the broker was quiet" out of a windowed sidecar.
 *
 * The `tradier-options-pnl.<env>.json` sidecar only covers the reconcile
 * window; the June 2026 cells TRA-3100 enumerated have long since rolled out of
 * it, so `totals[date] ?? 0` reads as a quiet day on exactly the rows the
 * fourth-quadrant check exists to catch — the fix would be structurally unable
 * to reach the wrong cells (TRA-2864's trap, one layer down). Precedence:
 *
 *   1. a sidecar ENTRY for the date — the live reconcile wins when it speaks;
 *   2. the row's own TRA-4201 `brokerRealized` block — FIFO-matched per date
 *      from the broker's trade history and stored beside the figure. Its
 *      `optionsPnl` leg is the one used, matching this audit's stated scope;
 *   3. a READABLE sidecar with no entry and no FIFO block — quiet as far as
 *      anything here can see, carried as `sidecar_quiet` so a sweep can count
 *      the weaker basis separately;
 *   4. an unreadable sidecar and no FIFO block — `known: false`. Fails closed.
 */
export function resolveBrokerDayEvidence(
  totals: { ok: true; totals: Record<string, number> } | { ok: false; reason: string },
  date: string,
  brokerRealized: { optionsPnl: number } | undefined,
): BrokerDayEvidence {
  if (totals.ok && totals.totals[date] !== undefined) {
    return { known: true, realizedUsd: totals.totals[date], source: 'sidecar' };
  }
  if (brokerRealized && Number.isFinite(brokerRealized.optionsPnl)) {
    return { known: true, realizedUsd: brokerRealized.optionsPnl, source: 'fifo_row' };
  }
  if (totals.ok) return { known: true, realizedUsd: 0, source: 'sidecar_quiet' };
  return { known: false, reason: totals.reason };
}

/**
 * TRA-5270 — how a `tradier-balance` cell was treated by the balance-vs-realized
 * grade. Serialized on the stamp so a sweep reads the DENOMINATOR (how many cells
 * the grade actually reached) and a gate that excludes most of its population
 * cannot read as a working one.
 *  - `graded` — compared to a sidecar-backed broker realized figure.
 *  - `ungraded_fifo_basis` — the only broker leg is the row's own FIFO block; a
 *    reconstruction that found no closes is an absence, not a measured broker zero.
 *  - `ungraded_no_broker_figure` — no readable broker figure for the date.
 */
export type BalanceGrade = 'graded' | 'ungraded_fifo_basis' | 'ungraded_no_broker_figure';

export type LiveCellSourceStatus =
  | 'ok'
  /**
   * TRA-5278 — option P&L dated BEFORE the book's `liveOptionsOnsetDate`. The book
   * held zero live options then, so the figure is its own DEMO-mode P&L booked
   * into a live cell, whatever label or header the row carries.
   */
  | 'pre_onset_demo_option_pnl'
  /** A broker-tagged row whose stored figure contradicts the broker figure it states. */
  | 'broker_figure_overwritten'
  /**
   * TRA-5270 — a flat-book `tradier-balance` cell whose header and figure agree
   * with each other but not with the broker's realized figure for the date.
   */
  | 'balance_cell_off_broker_realized'
  /** A broker-tagged row that no longer carries a readable broker computation. BLIND. */
  | 'broker_provenance_unreadable'
  /** Engine-sourced options P&L on a date the broker shows no realized options P&L. */
  | 'engine_close_without_broker_fill'
  /** Engine-sourced options P&L that disagrees with the broker's figure for the date. */
  | 'engine_options_diverges_from_broker'
  /**
   * TRA-5118 — the FOURTH quadrant: the broker booked realized options P&L on a
   * date the cell booked none, and the rendered figure does not tie to it. The
   * mirror of `engine_close_without_broker_fill`, and the quadrant where 5 of
   * TRA-3100's 9 uncorrectable cells lived while the audit said `ok`.
   */
  | 'broker_realized_without_cell_pnl'
  /** The broker tape could not be read, so the comparison could not run. BLIND. */
  | 'broker_evidence_unreadable';

export interface LiveCellSourceVerdict {
  status: LiveCellSourceStatus;
  sourceClass: CellSourceClass;
  /** The figure the calendar renders for this day. */
  renderedPnl: number;
  /** The engine's own options figure on the row. */
  engineOptionsPnl: number;
  /** Broker figure for the comparison, or `null` when unknown/blind. */
  brokerPnl: number | null;
  /** TRA-5118 — which evidence carried the broker leg; `null` when blind/unused. */
  brokerEvidenceSource: BrokerEvidenceSource | null;
  /** TRA-5270 — set only on a `tradier-balance` cell: was it graded against broker realized? */
  balanceGrade?: BalanceGrade;
  /** Operator-facing sentence. Never a number the caller should trade on. */
  detail: string;
}

export interface LiveCellSourceInput {
  reportDate: string;
  pnlSource: string | undefined;
  combinedPnl: number;
  realizedPnl: number;
  optionsPnl: number;
  markdown: string | undefined;
  /** Broker realized options P&L for the date. Omit only on a non-live book. */
  broker: BrokerDayEvidence;
  /**
   * TRA-5278 — ET date the book first opened a LIVE option. `undefined` = the
   * caller did not supply it (arm skipped); `null` = supplied but the book has no
   * recorded onset, which is UNMEASURED for this arm, never "clean".
   */
  liveOptionsOnsetDate?: string | null;
}

/** Dollar tolerance. Both sides are rounded currency, so a cent is the floor. */
const TOLERANCE_USD = 0.011;

/**
 * TRA-5270 — tolerance for a `tradier-balance` cell vs broker realized. NOT the
 * 0.011 above: that is right for header-vs-figure self-consistency (same number,
 * two renderings). The cell's options leg is GROSS (round dollars) and the sidecar
 * figure is NET of commissions, so a systematic cents-level basis gap exists on
 * every cell with option activity. Measured on the live store, those gaps are
 * 0.24–3.11; $5 clears them and still catches the material ones (08-04 −157.75,
 * 08-21 −121.30, 08-24 +84.72).
 */
const BALANCE_VS_REALIZED_TOLERANCE_USD = 5;

function usd(n: number): string {
  if (!Number.isFinite(n)) return '$—';
  return `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signed(n: number): string {
  return (n >= 0 ? '+' : '-') + usd(n).slice(1);
}

function brokerEvidenceSourceOf(input: LiveCellSourceInput): BrokerEvidenceSource | null {
  return input.broker.known ? input.broker.source ?? null : null;
}

function ok(input: LiveCellSourceInput, sourceClass: CellSourceClass, detail: string): LiveCellSourceVerdict {
  return {
    status: 'ok',
    sourceClass,
    renderedPnl: input.combinedPnl,
    engineOptionsPnl: input.optionsPnl,
    brokerPnl: input.broker.known ? input.broker.realizedUsd : null,
    brokerEvidenceSource: brokerEvidenceSourceOf(input),
    detail,
  };
}

function withGrade(v: LiveCellSourceVerdict, balanceGrade: BalanceGrade): LiveCellSourceVerdict {
  return { ...v, balanceGrade };
}

/**
 * TRA-5270 — the coverage floor. How many `tradier-balance` stamps the
 * balance-vs-realized grade reached vs excluded, by reason. A sweep must print
 * this beside any "N flagged" count: a grade that excludes most of its population
 * is otherwise indistinguishable from one that found nothing.
 */
export function balanceGradeCoverage(
  stamps: ReadonlyArray<{ balanceGrade?: BalanceGrade | null }>,
): { total: number; graded: number; ungraded_fifo_basis: number; ungraded_no_broker_figure: number; unstamped: number } {
  const c = { total: 0, graded: 0, ungraded_fifo_basis: 0, ungraded_no_broker_figure: 0, unstamped: 0 };
  for (const s of stamps) {
    c.total++;
    if (s.balanceGrade === 'graded') c.graded++;
    else if (s.balanceGrade === 'ungraded_fifo_basis') c.ungraded_fifo_basis++;
    else if (s.balanceGrade === 'ungraded_no_broker_figure') c.ungraded_no_broker_figure++;
    else c.unstamped++;
  }
  return c;
}

/**
 * Grade ONE live-calendar cell on the single question this ticket asks: is the
 * number the grid renders one the broker confirmed?
 *
 * Pure. Reads no files, makes no network calls, and never proposes a corrected
 * P&L.
 */
export function auditLiveCellSource(input: LiveCellSourceInput): LiveCellSourceVerdict {
  const sourceClass = classifyCellPnlSource(input.pnlSource);

  // An unsettled running cell is labelled as an estimate and recomputed on every
  // load; it makes no claim about a closed day, so there is nothing to reconcile.
  if (sourceClass === 'intraday') {
    return ok(input, sourceClass, 'Intraday running cell — not a settled claim about the day.');
  }

  // TRA-5278 — the onset guard. Outranks the label: a `tradier-balance` row whose
  // figure equals its engine options figure (07-15/17/21) is graded here before the
  // header-vs-figure arm can wave it through. A null onset skips the arm (UNMEASURED).
  const onset = input.liveOptionsOnsetDate;
  if (
    typeof onset === 'string'
    && input.pnlSource !== 'realized-backfill' // FIFO-from-broker-fills: engine onset says nothing about provenance (07-01/07-08 tie to broker)
    && input.reportDate < onset
    && Math.abs(input.optionsPnl) > TOLERANCE_USD
  ) {
    return {
      status: 'pre_onset_demo_option_pnl',
      sourceClass,
      // The arm never consults the broker evidence it echoes in `brokerPnl`.
      brokerEvidenceSource: null,
      renderedPnl: input.combinedPnl,
      engineOptionsPnl: input.optionsPnl,
      brokerPnl: input.broker.known ? input.broker.realizedUsd : null,
      detail:
        `${input.reportDate} carries ${signed(input.optionsPnl)} of options P&L but this book's first live `
        + `option opened ${onset}. The book held no live option on this date, so the figure is its own `
        + `DEMO-mode P&L booked into a live cell — not money that moved.`,
    };
  }

  if (sourceClass === 'broker') {
    // A `realized-backfill` row IS the FIFO reconstruction from broker fills, so
    // it is broker-sourced by construction and has no separate broker figure to
    // be graded against. Grading it on the TRA-359 header would flag all 8 live
    // backfill rows every time — a guaranteed false positive, which is the
    // scope error TRA-3101 caught in its own first draft.
    if (input.pnlSource === 'realized-backfill') {
      return ok(input, sourceClass, 'Reconstructed from broker fills (FIFO) — broker-sourced by construction.');
    }
    const stated = brokerFigureFromHeader(input.markdown);
    if (stated === null) {
      // ⛔ FAILS CLOSED. A `tradier-balance` row is written together with the
      // header that records its computation; a row carrying the label without
      // the computation was rewritten by something that dropped it, and we
      // cannot tell whether the figure survived. 14 of 14 live rows parse, so
      // this arm is a guard and not a standing false positive.
      return {
        status: 'broker_provenance_unreadable',
        sourceClass,
        renderedPnl: input.combinedPnl,
        engineOptionsPnl: input.optionsPnl,
        brokerPnl: null,
        brokerEvidenceSource: null,
        detail:
          `${input.reportDate} is labelled a broker balance-delta cell but carries no readable broker `
          + `computation, so the rendered ${signed(input.combinedPnl)} cannot be tied back to the broker. `
          + `Provenance unreadable — treat the figure as unconfirmed, not as agreed.`,
      };
    }
    if (Math.abs(stated - input.combinedPnl) > TOLERANCE_USD) {
      const matchesEngine = Math.abs(input.combinedPnl - input.optionsPnl) <= TOLERANCE_USD;
      return {
        status: 'broker_figure_overwritten',
        sourceClass,
        renderedPnl: input.combinedPnl,
        engineOptionsPnl: input.optionsPnl,
        brokerPnl: stated,
        brokerEvidenceSource: null,
        detail:
          `${input.reportDate} states a broker-truth P&L of ${signed(stated)} in its own header but `
          + `renders ${signed(input.combinedPnl)}. `
          + (matchesEngine
            ? `The rendered figure equals the ENGINE options figure (${signed(input.optionsPnl)}) to the cent, `
              + `so the broker override was stamped and then overwritten from the engine book underneath it. `
            : `The two disagree and the rendered figure is not the broker's. `)
          + `The calendar is showing a number the broker did not produce.`,
      };
    }
    // TRA-5270 — the header check above is SELF-consistency: header and figure can
    // agree and both be off the broker (07-01 +74.30, 07-08 +168.15). Grade the
    // figure against SIDECAR-backed broker realized. The ungraded arms say so in
    // the detail AND in `balanceGrade`, so `ok` here never reads the same as
    // "tied to the broker".
    //
    // Deliberately NOT gated on the row's open-position count: it is 0 on 55/55
    // live `tradier-balance` rows (a gate excluding nothing), and today's archive
    // count is 0 exactly in the case that matters (a position carried from the
    // previous snapshot and closed today). A `fifo_row` basis is ungraded: its
    // realized of 0.00 is "no closes reconstructed", not a broker zero.
    const headerOk = `Broker balance delta, confirmed against the row's own header (${signed(stated)}).`;
    const ev = brokerEvidenceSourceOf(input);
    if (!input.broker.known || ev === 'sidecar_quiet' || ev === null) {
      return withGrade(
        ok(input, sourceClass, `${headerOk} Header only — not graded against broker realized: no broker realized figure was recorded for the date.`),
        'ungraded_no_broker_figure',
      );
    }
    if (ev === 'fifo_row') {
      return withGrade(
        ok(input, sourceClass, `${headerOk} Header only — not graded against broker realized: the only broker leg is the row's own FIFO reconstruction (${signed(input.broker.realizedUsd)}), an absence of reconstructed closes rather than a measured broker figure.`),
        'ungraded_fifo_basis',
      );
    }
    // Graded on the OPTIONS leg, like every other arm: `broker.realizedUsd` is the broker's
    // realized OPTIONS P&L (see `BrokerDayEvidence`), while a balance delta (`combinedPnl`) also
    // carries the equity leg and MTM — 14 of the 26 cells the first draft flipped tied to the
    // cent on the options leg and differed only by equity.
    const brokerRealized = input.broker.realizedUsd;
    const optionsGap = input.optionsPnl - brokerRealized;
    if (Math.abs(optionsGap) > BALANCE_VS_REALIZED_TOLERANCE_USD) {
      return {
        status: 'balance_cell_off_broker_realized',
        sourceClass,
        renderedPnl: input.combinedPnl,
        engineOptionsPnl: input.optionsPnl,
        brokerPnl: brokerRealized,
        brokerEvidenceSource: ev,
        balanceGrade: 'graded',
        detail:
          `${input.reportDate} is a broker balance-delta cell (renders ${signed(input.combinedPnl)}), `
          + `but its options leg is ${signed(input.optionsPnl)} against the broker's realized options P&L of `
          + `${signed(brokerRealized)}, a gap of ${usd(optionsGap)} (tolerance ${usd(BALANCE_VS_REALIZED_TOLERANCE_USD)}). `
          + `Its own header agrees with the rendered figure, so the header check could not see it. `
          + `Equity realized is not graded here.`,
      };
    }
    return withGrade(
      ok(input, sourceClass, `${headerOk} Options leg ties to broker realized options P&L (${signed(brokerRealized)}); equity leg not graded.`),
      'graded',
    );
  }

  // ── engine-sourced or unlabelled ──────────────────────────────────────────
  //
  // The graded quantity is the OPTIONS leg: `optionsPnl` is what comes off
  // `closedOptions`, and it is what a phantom engine close inflates. That leg is
  // engine-book-derived whatever the row is labelled, so the `unlabelled` class
  // is graded on the same comparison — but its prose never claims the row IS
  // engine-sourced, and its class is published as `unlabelled` (TRA-5118).
  //
  // ⛔ TRA-5118 — this is a 4-QUADRANT matrix on (engine leg zero?, broker leg
  // zero?), and the broker leg is read FIRST. The pre-fix code early-returned
  // `ok` on a zero engine leg before ever reading the broker, which made the
  // quadrant (engine == 0, broker != 0) — where 5 of TRA-3100's 9 uncorrectable
  // cells live — grade as confirmed.
  const provenanceNote = sourceClass === 'unlabelled'
    ? ' This row carries no `pnlSource` (provenance never recorded — TRA-5095), so nothing is assumed about what the rendered figure measures.'
    : '';
  const engineZero = Math.abs(input.optionsPnl) <= TOLERANCE_USD;
  if (!input.broker.known) {
    // ⛔ FAILS CLOSED — on BOTH engine quadrants. An unreadable broker tape must
    // never resolve to "agrees"; and with the fourth quadrant closed, the broker
    // leg is load-bearing even when the cell booked nothing, because the broker
    // may have booked closes the cell never recorded. Pre-TRA-5118 this arm
    // returned `ok` when `optionsPnl == 0`.
    return {
      status: 'broker_evidence_unreadable',
      sourceClass,
      renderedPnl: input.combinedPnl,
      engineOptionsPnl: input.optionsPnl,
      brokerPnl: null,
      brokerEvidenceSource: null,
      detail: engineZero
        ? `${input.reportDate} books no engine options P&L, and the broker tape could not be read `
          + `(${input.broker.reason}), so whether the broker booked realized closes this day cannot be `
          + `established. Unconfirmed, not agreed.${provenanceNote}`
        : `${input.reportDate} books ${signed(input.optionsPnl)} of options P&L from the engine's own closed-options `
          + `book, and the broker tape could not be read (${input.broker.reason}), so it could not be `
          + `reconciled. Unconfirmed, not agreed.${provenanceNote}`,
    };
  }
  const brokerUsd = input.broker.realizedUsd;
  const brokerZero = Math.abs(brokerUsd) <= TOLERANCE_USD;
  if (engineZero) {
    if (brokerZero) {
      return ok(
        input,
        sourceClass,
        `No engine options P&L booked and the broker shows no realized options P&L for ${input.reportDate} — `
        + `quiet on both books.${provenanceNote}`,
      );
    }
    // The broker moved real money and the cell booked none of it. If the
    // rendered figure happens to tie the broker's realized figure to the cent,
    // the NUMBER is broker-confirmed even though the options leg is empty;
    // anything else is the fourth quadrant.
    if (Math.abs(input.combinedPnl - brokerUsd) <= TOLERANCE_USD) {
      return ok(
        input,
        sourceClass,
        `The rendered ${signed(input.combinedPnl)} ties the broker's realized options P&L for `
        + `${input.reportDate} (${signed(brokerUsd)}) to the cent, although the cell's own options leg is `
        + `empty.${provenanceNote}`,
      );
    }
    return {
      status: 'broker_realized_without_cell_pnl',
      sourceClass,
      renderedPnl: input.combinedPnl,
      engineOptionsPnl: input.optionsPnl,
      brokerPnl: brokerUsd,
      brokerEvidenceSource: brokerEvidenceSourceOf(input),
      detail:
        `${input.reportDate} renders ${signed(input.combinedPnl)} with no options P&L booked on the cell, `
        + `while the broker's realized options P&L for the date is ${signed(brokerUsd)} — a gap of `
        + `${signed(input.combinedPnl - brokerUsd)}. The broker moved money this cell never recorded, so the `
        + `rendered figure is not broker-confirmed.${provenanceNote}`,
    };
  }
  if (brokerZero) {
    return {
      status: 'engine_close_without_broker_fill',
      sourceClass,
      renderedPnl: input.combinedPnl,
      engineOptionsPnl: input.optionsPnl,
      brokerPnl: brokerUsd,
      brokerEvidenceSource: brokerEvidenceSourceOf(input),
      detail:
        `${input.reportDate} books ${signed(input.optionsPnl)} of options P&L from the engine's own `
        + `closed-options book while the broker shows NO realized options P&L for that date. An engine `
        + `close with no broker fill is not a P&L event on a live account — this figure is not money `
        + `that moved.${provenanceNote}`,
    };
  }
  if (Math.abs(brokerUsd - input.optionsPnl) > TOLERANCE_USD) {
    return {
      status: 'engine_options_diverges_from_broker',
      sourceClass,
      renderedPnl: input.combinedPnl,
      engineOptionsPnl: input.optionsPnl,
      brokerPnl: brokerUsd,
      brokerEvidenceSource: brokerEvidenceSourceOf(input),
      detail:
        `${input.reportDate} books ${signed(input.optionsPnl)} of options P&L from the engine's own `
        + `closed-options book; the broker's realized options P&L for that date is ${signed(brokerUsd)}, a `
        + `difference of ${signed(input.optionsPnl - brokerUsd)}. Broker truth wins — the rendered figure is `
        + `the engine's.${provenanceNote}`,
    };
  }
  return ok(
    input,
    sourceClass,
    `Engine options figure ties to the broker's realized options P&L (${signed(brokerUsd)}).${provenanceNote}`,
  );
}

/** True when the verdict means the rendered figure is not broker-confirmed. */
export function isUnreconciled(verdict: LiveCellSourceVerdict): boolean {
  return verdict.status !== 'ok';
}

/** The block stamped onto a row. Mirrors `EodReport['pnlUnreconciled']`. */
export interface PnlUnreconciledBlock {
  reason: Exclude<LiveCellSourceStatus, 'ok'>;
  renderedPnl: number;
  brokerPnl: number | null;
  engineOptionsPnl: number;
  detail: string;
  at: string;
}

/**
 * TRA-5118 — the verdict as it is SERIALIZED, on every graded row, `ok`
 * included. Mirrors `EodReport['brokerSourceAudit']`.
 *
 * Before this existed, an `ok` verdict wrote nothing, so three different states
 * shared one wire representation (absence): a real pass, a cell the broker was
 * never consulted about, and a guessed source routed into the pass branch. A
 * sweep over served rows can now read the DENOMINATOR — how many rows reached
 * each status, including the not-graded arms — instead of counting flags raised.
 */
export interface BrokerSourceAuditStamp {
  /** The verdict, or `not_graded` with the reason beside it. */
  status: LiveCellSourceStatus | 'not_graded';
  /**
   * Present exactly when `status === 'not_graded'`.
   *  - `pnl_unknown_precedence` — TRA-3101 already says something strictly
   *    stronger about this row ("the day was never measured"); the broker-source
   *    audit does not run on it.
   *  - `audit_error` — the audit itself threw. The row is served/written
   *    unaudited, and this stamp is what keeps that distinguishable from a pass.
   */
  notGradedReason?: 'pnl_unknown_precedence' | 'audit_error';
  sourceClass?: CellSourceClass;
  renderedPnl?: number;
  engineOptionsPnl?: number;
  brokerPnl?: number | null;
  brokerEvidenceSource?: BrokerEvidenceSource | null;
  /** TRA-5270 — present on `tradier-balance` cells only. */
  balanceGrade?: BalanceGrade;
  detail: string;
  at: string;
}

/** TRA-5118 — the stamp for a row the audit deliberately or accidentally skipped. */
export function notGradedAuditStamp(
  reason: 'pnl_unknown_precedence' | 'audit_error',
  detail: string,
  at: string,
): BrokerSourceAuditStamp {
  return { status: 'not_graded', notGradedReason: reason, detail, at };
}

/**
 * TRA-5118 — derive the stamp from a stored write-time `pnlUnreconciled` block,
 * so a row whose write-time verdict stands still serializes a verdict instead of
 * relying on the block's presence alone.
 */
export function auditStampFromStoredBlock(block: PnlUnreconciledBlock): BrokerSourceAuditStamp {
  return {
    status: block.reason,
    renderedPnl: block.renderedPnl,
    engineOptionsPnl: block.engineOptionsPnl,
    brokerPnl: block.brokerPnl,
    ...(block.reason === 'balance_cell_off_broker_realized' ? { balanceGrade: 'graded' as const } : {}),
    detail: block.detail,
    at: block.at,
  };
}

export interface LiveCellSourceDisposition {
  /** Non-null exactly when the rendered figure is not broker-confirmed. */
  pnlUnreconciled: PnlUnreconciledBlock | null;
  /** The markdown header the row carries. Empty string when there is nothing to say. */
  header: string;
  /** TRA-5118 — stamped on EVERY graded row, `ok` included. */
  audit: BrokerSourceAuditStamp;
}

/**
 * Decide how one live cell presents itself given its verdict.
 *
 * Note what this does NOT do: it does not change `combinedPnl`. See the module
 * docblock — the stored number stays what it was, and what changes is whether
 * the row claims it. The header leads with the answer so an operator reading the
 * cell top-to-bottom cannot miss it (the pre-fix rows printed a broker figure in
 * prose and an engine figure in the table with nothing saying which was live).
 *
 * @param at ISO timestamp, injected so the decision is a pure function.
 */
export function decideLiveCellSourceDisposition(
  verdict: LiveCellSourceVerdict,
  at: string,
): LiveCellSourceDisposition {
  const audit: BrokerSourceAuditStamp = {
    status: verdict.status,
    sourceClass: verdict.sourceClass,
    renderedPnl: Number(verdict.renderedPnl.toFixed(2)),
    engineOptionsPnl: Number(verdict.engineOptionsPnl.toFixed(2)),
    brokerPnl: verdict.brokerPnl === null ? null : Number(verdict.brokerPnl.toFixed(2)),
    brokerEvidenceSource: verdict.brokerEvidenceSource,
    ...(verdict.balanceGrade ? { balanceGrade: verdict.balanceGrade } : {}),
    detail: verdict.detail,
    at,
  };
  if (!isUnreconciled(verdict)) return { pnlUnreconciled: null, header: '', audit };
  const reason = verdict.status as Exclude<LiveCellSourceStatus, 'ok'>;
  return {
    pnlUnreconciled: {
      reason,
      renderedPnl: Number(verdict.renderedPnl.toFixed(2)),
      brokerPnl: verdict.brokerPnl === null ? null : Number(verdict.brokerPnl.toFixed(2)),
      engineOptionsPnl: Number(verdict.engineOptionsPnl.toFixed(2)),
      detail: verdict.detail,
      at,
    },
    header:
      `> **⚠ The P&L shown for this day is NOT broker-confirmed (TRA-3102).** ${verdict.detail} `
      + `The figure is left exactly as it was recorded — this row is flagged, not corrected — and it is `
      + `EXCLUDED from the monthly totals. \`reason: ${reason}\`.`,
    audit,
  };
}
