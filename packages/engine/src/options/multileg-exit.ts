import type { OptionType } from '@trading-app/shared';

/**
 * TRA-1418 (TRA-1417 build — QuantTrader spec comment d481a38d; parent TRA-1406
 * / TRA-1410 option (a)) — the pure defined-risk-spread exit policy for
 * multi-leg combos.
 *
 * A combo (bull put / bear call / iron condor / debit vertical) carries a
 * synthetic (non-OCC) `optionSymbol`, so the per-symbol mark refresh never
 * matches it and the per-tick single-leg exit engine skips it. In the always-on
 * demo book there is no manual close, so the only resolution is a force-scratch
 * near entry → exactly $0. This module gives the structure a real premium/DTE
 * space exit so it resolves to a non-$0 WIN/LOSS instead.
 *
 * All arithmetic is on fields already persisted on the position (`netUsd`,
 * `maxProfitUsd`, `maxLossUsd`, expiration → DTE) plus the one runtime input the
 * caller must produce each tick: `markNetNow` — the structure's current net
 * liquidation value (`Σ_legs legSign(leg) · legMark · 100 · contracts`). The
 * decision itself is deterministic and side-effect free so it can be unit tested
 * against the worked examples in the spec.
 */

/** Params keyed to the QuantTrader spec block (demo-first, v1). */
export interface MultiLegExitParams {
  /** Take profit at this fraction of `maxProfitUsd` captured (credit AND debit) → WIN. */
  tpCapture: number;
  /** Credit: cut when open loss ≤ −`slCreditMult` × credit, clamped to maxLoss → LOSS. */
  slCreditMult: number;
  /** Debit: cut when open loss ≤ −`slDebitFrac` × debit paid → LOSS. */
  slDebitFrac: number;
  /** Time-stop: close at ≤ this many DTE (gamma-risk exit). */
  dteStop: number;
  /** Weekly floor so short-dated combos (entry DTE ≤ dteStop) still resolve pre-expiry. */
  dteStopFloor: number;
  /** Never scratch on the same tick as entry (bars-held must be ≥ this). */
  minHoldBars: number;
}

/** QuantTrader spec defaults (TRA-1417 comment d481a38d, param block). */
export const DEFAULT_MULTILEG_EXIT_PARAMS: MultiLegExitParams = {
  tpCapture: 0.5,
  slCreditMult: 2.0,
  slDebitFrac: 0.5,
  dteStop: 21,
  dteStopFloor: 1,
  minHoldBars: 1,
};

export type MultiLegExitReason =
  | 'tp_capture'
  | 'sl_credit'
  | 'sl_debit'
  | 'dte_time_stop'
  | 'expiry_settle';

export interface MultiLegExitInput {
  /** Entry net premium, +credit / −debit, USD across all contracts. */
  netUsd: number;
  /** Capped max profit, USD across all contracts (> 0). */
  maxProfitUsd: number;
  /** Capped max loss (capital at risk), USD across all contracts (> 0). */
  maxLossUsd: number;
  /**
   * Current net liquidation value of the structure, USD across all contracts:
   * `Σ_legs legSign(leg) · legMark · 100 · contracts` (credit → negative
   * liability, debit → positive asset). Baseline `markNet(entry) = -netUsd`.
   */
  markNetNow: number;
  /** Current days-to-expiration of the (soonest) leg. */
  dte: number;
  /** Days-to-expiration at entry — decides whether the weekly floor applies. */
  entryDte: number;
  /** Per-tick evaluations already applied (0 on the entry tick). */
  barsHeld: number;
}

export interface MultiLegExitDecision {
  shouldExit: boolean;
  reason: MultiLegExitReason | null;
  /**
   * Realized P&L, USD, clamped to the defined-risk band `[-maxLossUsd,
   * +maxProfitUsd]` so a close never books more than the structure can lose or
   * make. Only meaningful when `shouldExit` is true.
   */
  realizedPnlUsd: number;
  /**
   * Open P&L at the evaluated mark (pre-clamp): `markNetNow + netUsd`. Exposed
   * for logging / journalling the raw structure P&L.
   */
  openPnlUsd: number;
}

const HOLD: MultiLegExitDecision = {
  shouldExit: false,
  reason: null,
  realizedPnlUsd: 0,
  openPnlUsd: 0,
};

function clampToBand(pnl: number, maxProfitUsd: number, maxLossUsd: number): number {
  return Math.max(-maxLossUsd, Math.min(maxProfitUsd, pnl));
}

/**
 * Evaluate the defined-risk-spread exit policy for one combo at the current
 * mark. Classify by `netUsd` sign (credit > 0 / debit < 0) and apply, in
 * precedence order: profit-take at `tpCapture` of max profit → WIN; the
 * structure-specific stop → LOSS (clamped to maxLoss); the DTE time-stop /
 * expiry settle → WIN or LOSS by the sign of open P&L.
 *
 * Returns HOLD (`shouldExit: false`) when the min-hold guard is not yet met or
 * no rule fires. Degenerate inputs (non-finite / non-positive max profit or
 * loss) also HOLD rather than emit a spurious close.
 */
export function evaluateMultiLegExit(
  input: MultiLegExitInput,
  params: MultiLegExitParams = DEFAULT_MULTILEG_EXIT_PARAMS,
): MultiLegExitDecision {
  const { netUsd, maxProfitUsd, maxLossUsd, markNetNow, dte, entryDte, barsHeld } = input;

  if (!Number.isFinite(maxProfitUsd) || maxProfitUsd <= 0) return HOLD;
  if (!Number.isFinite(maxLossUsd) || maxLossUsd <= 0) return HOLD;
  if (!Number.isFinite(markNetNow) || !Number.isFinite(netUsd)) return HOLD;

  const openPnlUsd = markNetNow + netUsd;

  // min_hold_bars — never scratch on the same tick as entry (kills the
  // $0-near-entry pathology directly).
  if (barsHeld < params.minHoldBars) return { ...HOLD, openPnlUsd };

  const captureFraction = openPnlUsd / maxProfitUsd;
  const isCredit = netUsd > 0;

  // 1) Profit-take at `tpCapture` of max profit (credit AND debit) → WIN.
  if (captureFraction >= params.tpCapture) {
    return {
      shouldExit: true,
      reason: 'tp_capture',
      realizedPnlUsd: clampToBand(openPnlUsd, maxProfitUsd, maxLossUsd),
      openPnlUsd,
    };
  }

  // 2) Structure-specific stop-loss → LOSS (clamped to defined risk).
  if (isCredit) {
    // Cut at `slCreditMult` × credit loss, clamped to maxLoss.
    if (openPnlUsd <= -params.slCreditMult * netUsd) {
      return {
        shouldExit: true,
        reason: 'sl_credit',
        realizedPnlUsd: clampToBand(openPnlUsd, maxProfitUsd, maxLossUsd),
        openPnlUsd,
      };
    }
  } else {
    // Debit: cut at `slDebitFrac` of the debit paid (`debit = -netUsd`).
    const debit = -netUsd;
    if (openPnlUsd <= -params.slDebitFrac * debit) {
      return {
        shouldExit: true,
        reason: 'sl_debit',
        realizedPnlUsd: clampToBand(openPnlUsd, maxProfitUsd, maxLossUsd),
        openPnlUsd,
      };
    }
  }

  // 3) Time-stop / expiry settle. Weeklies (entry DTE ≤ dteStop) use the floor
  // so the structure still resolves before expiry instead of a force-scratch.
  const effectiveStop = entryDte <= params.dteStop ? params.dteStopFloor : params.dteStop;
  if (dte <= effectiveStop) {
    return {
      shouldExit: true,
      // At/after expiry (DTE ≤ 0) settle at intrinsic — still a real WIN/LOSS.
      reason: dte <= 0 ? 'expiry_settle' : 'dte_time_stop',
      realizedPnlUsd: clampToBand(openPnlUsd, maxProfitUsd, maxLossUsd),
      openPnlUsd,
    };
  }

  return { ...HOLD, openPnlUsd };
}

/**
 * Reconstruct a leg's OCC option symbol deterministically from its
 * `(underlying, expiration, strike, optionType)` so the combo mark path can look
 * it up in the same per-symbol mark map single-legs use. OCC format is
 * `ROOT + YYMMDD + C|P + strike×1000 zero-padded to 8 digits`
 * (e.g. `AAPL260717C00170000`). The persisted `OptionLeg` carries no OCC symbol,
 * so this is the deterministic bridge back to the mark map.
 *
 * Returns `null` for a malformed expiration or non-positive strike so the caller
 * falls through to the Black-Scholes backstop rather than querying a bogus key.
 */
export function buildOccSymbol(
  underlying: string,
  expirationIso: string,
  strike: number,
  optionType: OptionType,
): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expirationIso);
  if (!m) return null;
  if (!Number.isFinite(strike) || strike <= 0) return null;
  const root = underlying.toUpperCase();
  const yymmdd = `${m[1].slice(2)}${m[2]}${m[3]}`;
  const cp = optionType === 'call' ? 'C' : 'P';
  // Strike in thousandths of a dollar, zero-padded to 8 digits. Round to avoid
  // binary-float drift (e.g. 172.5 × 1000 = 172499.999…).
  const strikeThousandths = Math.round(strike * 1000);
  const strikeField = String(strikeThousandths).padStart(8, '0');
  return `${root}${yymmdd}${cp}${strikeField}`;
}
