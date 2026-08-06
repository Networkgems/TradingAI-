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
 *     broker-derived; everything else, INCLUDING an absent label, is
 *     engine-sourced until proven otherwise. Not knowing the measure is a reason
 *     to audit, never a reason to skip.
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
 */

/** The `pnlSource` labels a stored calendar row can carry. */
export type StoredPnlSource = 'engine' | 'tradier-balance' | 'realized-backfill' | 'live-intraday';

/**
 * How the row's calendar figure was SOURCED, as opposed to what it is labelled.
 *
 *  - `broker`   — derived from broker data (a balance delta, or FIFO-matched fills).
 *  - `engine`   — derived from the engine's own book. Needs reconciling on a live
 *                 account. **An unlabelled row lands here.**
 *  - `intraday` — today's unsettled running figure; labelled as such and not yet
 *                 a claim about a closed day.
 */
export type CellSourceClass = 'broker' | 'engine' | 'intraday';

/**
 * ⛔ THE REACH GATE. Allow-list, deliberately.
 *
 * A denylist (`pnlSource === 'engine'`) reaches 0 of the 46 unlabelled live rows.
 * An unknown or absent label means the row's provenance was never recorded, and
 * "not recorded" is not evidence of broker truth — it is exactly the population
 * that predates broker sourcing.
 */
export function classifyCellPnlSource(pnlSource: string | undefined): CellSourceClass {
  if (pnlSource === 'tradier-balance' || pnlSource === 'realized-backfill') return 'broker';
  if (pnlSource === 'live-intraday') return 'intraday';
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
 * (the `tradier-options-pnl.<env>.json` sidecar). The audit therefore grades the
 * OPTIONS leg — which is the leg sourced from `closedOptions` and the whole
 * mechanism of this ticket — and never claims to have graded equity realized.
 */
export type BrokerDayEvidence =
  | { known: true; realizedUsd: number }
  | { known: false; reason: string };

export type LiveCellSourceStatus =
  | 'ok'
  /** A broker-tagged row whose stored figure contradicts the broker figure it states. */
  | 'broker_figure_overwritten'
  /** A broker-tagged row that no longer carries a readable broker computation. BLIND. */
  | 'broker_provenance_unreadable'
  /** Engine-sourced options P&L on a date the broker shows no realized options P&L. */
  | 'engine_close_without_broker_fill'
  /** Engine-sourced options P&L that disagrees with the broker's figure for the date. */
  | 'engine_options_diverges_from_broker'
  /** Engine-sourced options P&L and the broker tape could not be read. BLIND. */
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
}

/** Dollar tolerance. Both sides are rounded currency, so a cent is the floor. */
const TOLERANCE_USD = 0.011;

function usd(n: number): string {
  if (!Number.isFinite(n)) return '$—';
  return `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signed(n: number): string {
  return (n >= 0 ? '+' : '-') + usd(n).slice(1);
}

function ok(input: LiveCellSourceInput, sourceClass: CellSourceClass, detail: string): LiveCellSourceVerdict {
  return {
    status: 'ok',
    sourceClass,
    renderedPnl: input.combinedPnl,
    engineOptionsPnl: input.optionsPnl,
    brokerPnl: input.broker.known ? input.broker.realizedUsd : null,
    detail,
  };
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
    return ok(input, sourceClass, `Broker balance delta, confirmed against the row's own header (${signed(stated)}).`);
  }

  // ── engine-sourced ────────────────────────────────────────────────────────
  //
  // The graded quantity is the OPTIONS leg: `optionsPnl` is what comes off
  // `closedOptions`, and it is what a phantom engine close inflates.
  if (Math.abs(input.optionsPnl) <= TOLERANCE_USD) {
    return ok(input, sourceClass, 'No engine options P&L booked on this day — nothing sourced from the engine book.');
  }
  if (!input.broker.known) {
    // ⛔ FAILS CLOSED. An unreadable broker tape must never resolve to "agrees".
    return {
      status: 'broker_evidence_unreadable',
      sourceClass,
      renderedPnl: input.combinedPnl,
      engineOptionsPnl: input.optionsPnl,
      brokerPnl: null,
      detail:
        `${input.reportDate} books ${signed(input.optionsPnl)} of options P&L from the engine's own closed-options `
        + `book, and the broker tape could not be read (${input.broker.reason}), so it could not be `
        + `reconciled. Unconfirmed, not agreed.`,
    };
  }
  const brokerUsd = input.broker.realizedUsd;
  if (Math.abs(brokerUsd) <= TOLERANCE_USD) {
    return {
      status: 'engine_close_without_broker_fill',
      sourceClass,
      renderedPnl: input.combinedPnl,
      engineOptionsPnl: input.optionsPnl,
      brokerPnl: brokerUsd,
      detail:
        `${input.reportDate} books ${signed(input.optionsPnl)} of options P&L from the engine's own `
        + `closed-options book while the broker shows NO realized options P&L for that date. An engine `
        + `close with no broker fill is not a P&L event on a live account — this figure is not money `
        + `that moved.`,
    };
  }
  if (Math.abs(brokerUsd - input.optionsPnl) > TOLERANCE_USD) {
    return {
      status: 'engine_options_diverges_from_broker',
      sourceClass,
      renderedPnl: input.combinedPnl,
      engineOptionsPnl: input.optionsPnl,
      brokerPnl: brokerUsd,
      detail:
        `${input.reportDate} books ${signed(input.optionsPnl)} of options P&L from the engine's own `
        + `closed-options book; the broker's realized options P&L for that date is ${signed(brokerUsd)}, a `
        + `difference of ${signed(input.optionsPnl - brokerUsd)}. Broker truth wins — the rendered figure is `
        + `the engine's.`,
    };
  }
  return ok(input, sourceClass, `Engine options figure ties to the broker's realized options P&L (${signed(brokerUsd)}).`);
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

export interface LiveCellSourceDisposition {
  /** Non-null exactly when the rendered figure is not broker-confirmed. */
  pnlUnreconciled: PnlUnreconciledBlock | null;
  /** The markdown header the row carries. Empty string when there is nothing to say. */
  header: string;
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
  if (!isUnreconciled(verdict)) return { pnlUnreconciled: null, header: '' };
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
  };
}
