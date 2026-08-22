/**
 * TRA-3954 — the EOD mark on OPEN option positions: the fourth operand of the
 * stock-leg probe.
 *
 * `liveStockLegProbeOk` (TRA-3948) differences
 *
 *     closingEquity − openingEquity − optionsDaily − netCashFlowUsd
 *
 * and every operand there is REALIZED except `closingEquity`, which is the
 * broker's mark-to-market `total_equity` and carries the unrealized P&L of
 * whatever is still open at the close. So on every session a book holds an
 * option overnight the probe reads the MTM-vs-realized gap and pins RED — the
 * mirror of the false green TRA-3948 was opened to fix. TRA-3951 reconciled it
 * to the cent on Tradier account 6YB80154: 08-17 four contracts bought for
 * 691.44, marked 494.08 at the close → unrealized −197.36, exactly the probe.
 *
 * This module captures that mark on the SAME tick as the balance snapshot and
 * persists it per session in `tradier-eod-option-mark.<env>.json`, so the row
 * writer can difference it session-over-session:
 *
 *     stockLegProbeUsd = dEquity − realizedOptions − dUnrealizedOptionMark − flow
 *
 * Sourcing. Tradier `/balances` publishes `option_long_value` (the EOD market
 * value of long option positions); `/positions` publishes each position's
 * `cost_basis`. `unrealized = marketValue − Σ cost_basis`. The positions parser
 * in use drops SHORT legs, so the cost-basis side is LONG-ONLY; a non-zero
 * `option_short_value` therefore makes the figure unmeasurable (it would be
 * stated over an incomplete basis) and the capture says so rather than
 * publishing a number that is wrong by the short side. Tradier's own `open_pl`
 * is carried beside the computed figure as DIAGNOSIS only — it also contains
 * stock P&L and is not the operand.
 *
 * Pure; the caller supplies the broker payloads and the file.
 */

export const TRADIER_EOD_OPTION_MARK_FILE_PREFIX = 'tradier-eod-option-mark';

/** One session's EOD open-option mark, as persisted. */
export interface OpenOptionMarkSnapshot {
  /** EOD market value of open LONG option positions (`option_long_value`), USD. */
  marketValueUsd: number;
  /** Σ `cost_basis` over the open LONG option positions, USD. */
  costBasisUsd: number;
  /** `marketValueUsd − costBasisUsd`. The probe operand. */
  unrealizedUsd: number;
  /** Open long option positions counted into `costBasisUsd`. */
  positionCount: number;
  /** Tradier's own `open_pl`, when the payload carried one. Diagnosis, not operand. */
  brokerOpenPlUsd: number | null;
  /** ISO timestamp of the capture. */
  capturedAt: string;
}

export type OpenOptionMarkByDate = Record<string, OpenOptionMarkSnapshot>;

export type OpenOptionMarkCapture =
  | { ok: true; snapshot: OpenOptionMarkSnapshot }
  | {
      ok: false;
      reason:
        | 'no-balance'
        | 'no-option-long-value'
        | 'short-option-value-present'
        | 'positions-unreadable'
        | 'position-cost-basis-invalid';
      detail: string;
    };

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Compute the EOD open-option mark from the two broker payloads captured on one
 * tick. Every failure is a NAMED non-measurement — the probe's fourth operand
 * then reads `null` on the row, never `0`: a `0` is the "nothing was open"
 * reading and is exactly what a failed capture must not impersonate.
 */
export function computeOpenOptionMark(args: {
  balance: {
    optionLongValue?: number | null;
    optionShortValue?: number | null;
    /** Tradier `open_pl`, if the client surfaced it. */
    openPl?: number | null;
  } | null;
  /** `ok: false` = the positions read failed; `positions: []` = a real empty book. */
  positions:
    | { ok: true; positions: ReadonlyArray<{ contracts: number; premiumPaid: number }> }
    | { ok: false; detail: string };
  capturedAt: string;
}): OpenOptionMarkCapture {
  const { balance, positions, capturedAt } = args;
  if (!balance) return { ok: false, reason: 'no-balance', detail: 'balances payload absent' };
  const mv = balance.optionLongValue;
  if (typeof mv !== 'number' || !Number.isFinite(mv)) {
    return { ok: false, reason: 'no-option-long-value', detail: 'option_long_value absent' };
  }
  const sv = balance.optionShortValue;
  if (typeof sv === 'number' && Number.isFinite(sv) && Math.abs(sv) > 0.004) {
    return {
      ok: false,
      reason: 'short-option-value-present',
      detail: `option_short_value ${sv} — the cost basis here is long-only`,
    };
  }
  if (!positions.ok) {
    return { ok: false, reason: 'positions-unreadable', detail: positions.detail };
  }
  let costBasisUsd = 0;
  for (const p of positions.positions) {
    // `premiumPaid` is per-share (`cost_basis ÷ contracts ÷ 100`), so this
    // inverts the parser exactly.
    const cb = p.premiumPaid * p.contracts * 100;
    if (!Number.isFinite(cb) || p.contracts <= 0) {
      return {
        ok: false,
        reason: 'position-cost-basis-invalid',
        detail: `contracts=${p.contracts} premiumPaid=${p.premiumPaid}`,
      };
    }
    costBasisUsd += cb;
  }
  const openPl = balance.openPl;
  return {
    ok: true,
    snapshot: {
      marketValueUsd: round2(mv),
      costBasisUsd: round2(costBasisUsd),
      unrealizedUsd: round2(mv - costBasisUsd),
      positionCount: positions.positions.length,
      brokerOpenPlUsd: typeof openPl === 'number' && Number.isFinite(openPl) ? round2(openPl) : null,
      capturedAt,
    },
  };
}

/** Parse the on-disk file. Malformed entries are dropped, never coerced to 0. */
export function parseOpenOptionMarkFile(raw: unknown): OpenOptionMarkByDate {
  const out: OpenOptionMarkByDate = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [date, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const s = v as Record<string, unknown>;
    const num = (k: string): number | null =>
      typeof s[k] === 'number' && Number.isFinite(s[k] as number) ? (s[k] as number) : null;
    const marketValueUsd = num('marketValueUsd');
    const costBasisUsd = num('costBasisUsd');
    const unrealizedUsd = num('unrealizedUsd');
    const positionCount = num('positionCount');
    if (
      marketValueUsd === null || costBasisUsd === null || unrealizedUsd === null
      || positionCount === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    ) continue;
    out[date] = {
      marketValueUsd,
      costBasisUsd,
      unrealizedUsd,
      positionCount,
      brokerOpenPlUsd: num('brokerOpenPlUsd'),
      capturedAt: typeof s['capturedAt'] === 'string' ? (s['capturedAt'] as string) : '',
    };
  }
  return out;
}

/** Collapse the file to the probe operand per session. */
export function openOptionMarkUsdByDate(marks: OpenOptionMarkByDate): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [d, s] of Object.entries(marks)) out[d] = s.unrealizedUsd;
  return out;
}

/**
 * The session-over-session change in the open-option mark, over the SAME span
 * the equity delta covers: `(prevDate, date]`. Both endpoints must have been
 * CAPTURED — an absent prior mark is NOT MEASURED, not 0, even though 0 is what
 * a flat prior book would have marked: the first session after this operand
 * ships has no prior capture, and inventing one would turn the first overnight
 * position into a probe that is exact by coincidence.
 */
export function resolveOpenOptionMarkDelta(
  markUsdByDate: Record<string, number> | null | undefined,
  date: string,
  prevDate: string | null,
): { markUsd: number | null; deltaUsd: number | null } {
  if (!markUsdByDate) return { markUsd: null, deltaUsd: null };
  const today = markUsdByDate[date];
  const markUsd = typeof today === 'number' && Number.isFinite(today) ? round2(today) : null;
  if (markUsd === null || prevDate === null) return { markUsd, deltaUsd: null };
  const prev = markUsdByDate[prevDate];
  if (typeof prev !== 'number' || !Number.isFinite(prev)) return { markUsd, deltaUsd: null };
  return { markUsd, deltaUsd: round2(markUsd - prev) };
}
