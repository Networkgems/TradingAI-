// TRA-2233 (parent TRA-2174) — marketable(bid) valuation for the demo/paper book.
//
// The paper book marks OPEN options at the chain MID `(bid+ask)/2` and, in demo,
// books CLOSES at MID too (`demoSlippagePct = 0` today). A real long exit fills at
// the BID, a real short buy-back at the ASK. Measured bias on the live demo
// journal: mid-vs-bid half-spread mean 13.4% of premium, p90 37.8% — so the MID
// mark systematically OVERSTATES realizable P&L by about the half-spread.
//
// Principle (the whole ticket): **a realizable gain is one you can sell at the
// bid** — value open longs at the bid, shorts at the ask; keep MID only as a
// display/reference field. This module is the pure valuation kernel; the account
// wires it behind a DARK flag (default = today's MID behavior) and a
// forward-validation harness checks the modeled mark against real Tradier
// sandbox fills before it is ever allowed to drive a grade / cap / halt.
//
// ── Where the bid comes from ─────────────────────────────────────────────────
// The live book carries only a single MID mark per position (`currentPremium`;
// the engine's `optionMarks` feed is `Map<string, number>` — a mid, with no
// two-sided quote threaded into the per-tick exit path). So v1 DERIVES the
// marketable mark from the mid via a modeled HALF-SPREAD FRACTION
// `h = (mid − bid) / mid`, defaulting to the measured mean (0.134). When a caller
// DOES have a live/entry two-sided quote it passes it explicitly and the exact
// bid/ask is used instead of the model — that path is what the forward-validation
// harness exercises against recorded sandbox fills. An unusable/absent input
// folds back to the mid (no haircut) rather than inventing a worse number.
//
// Pure: no IO, no clock, no globals. Every function is total and deterministic.

/** Which side of the book the position sits on. Longs realize at the bid, shorts at the ask. */
export type MarketableSide = 'long' | 'short';

/**
 * The measured mid-vs-bid half-spread mean on the live demo journal, expressed as
 * a fraction of the mid (`(mid − bid) / mid`). This is the DEFAULT model when no
 * live two-sided quote is available. DARK: only ever consulted when the marketable
 * flag is on, which stays off until the forward-validation harness confirms the
 * model against real sandbox fills.
 */
export const DEFAULT_MARKETABLE_HALF_SPREAD_FRAC = 0.134;

/**
 * A half-spread fraction above this is treated as a corrupt/illiquid input and
 * clamped — a 50%-of-mid half-spread already means the bid is at HALF the mid
 * (a 100%-wide quoted market), past which "value at the bid" degenerates. The
 * clamp keeps a garbage `entrySpread` from zeroing an otherwise live position.
 */
export const MAX_MARKETABLE_HALF_SPREAD_FRAC = 0.5;

/** Clamp a half-spread fraction into `[0, MAX_MARKETABLE_HALF_SPREAD_FRAC]`; non-finite ⇒ 0 (no haircut). */
export function clampHalfSpreadFrac(frac: number): number {
  if (typeof frac !== 'number' || !Number.isFinite(frac) || frac <= 0) return 0;
  return Math.min(frac, MAX_MARKETABLE_HALF_SPREAD_FRAC);
}

/**
 * Derive the half-spread fraction `(mid − bid) / mid` from a two-sided quote.
 * Returns `null` (caller should fall back to a modeled default) when the quote is
 * unusable — non-finite, non-positive mid, or a crossed book (`ask < bid`) — so a
 * corrupt quote never manufactures a mark. Mirrors the guards in
 * `option-spread-cost.ts::measureSpreadCross` so the two stay consistent.
 */
export function halfSpreadFracFromQuote(quote: {
  bid?: number;
  ask?: number;
  mark?: number;
}): number | null {
  const { bid, ask, mark } = quote;
  if (![bid, ask, mark].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const b = bid as number;
  const a = ask as number;
  const m = mark as number;
  if (m <= 0 || b < 0 || a <= 0) return null;
  if (a < b) return null; // crossed / corrupt book
  // Half-spread relative to the mid. For a symmetric book mid = (bid+ask)/2 this
  // equals (ask−bid)/(2·mid); we compute it from the bid directly so an
  // asymmetric recorded mid still yields the true mid→bid haircut.
  const frac = (m - b) / m;
  return clampHalfSpreadFrac(frac);
}

/** Inputs for a single per-share marketable mark. */
export interface MarketableMarkInput {
  /** The reference MID mark, per share (`currentPremium`). Must be > 0 to haircut. */
  midPerShare: number;
  /** Long realizes at the bid, short at the ask. */
  side: MarketableSide;
  /**
   * Explicit two-sided quote, if the caller has a live/recorded one. When present
   * and usable it is authoritative: long → `bid`, short → `ask`. Overrides the
   * modeled fraction entirely.
   */
  quote?: { bid?: number; ask?: number; mark?: number };
  /**
   * Modeled half-spread fraction `(mid − bid)/mid` used when no usable `quote` is
   * supplied. Defaults to {@link DEFAULT_MARKETABLE_HALF_SPREAD_FRAC}. Clamped.
   */
  halfSpreadFrac?: number;
}

/**
 * The realizable per-share mark for one position: the price you could actually
 * transact at right now (long → bid, short → ask). Never negative. When the mid
 * is unusable (≤ 0 / non-finite) returns 0 — matching the paper book's "no mark,
 * no value" convention rather than synthesising a price.
 *
 * Resolution order: an explicit usable `quote` wins (exact bid/ask); else the mid
 * is haircut by the modeled half-spread fraction (long: `mid·(1−h)`; short:
 * `mid·(1+h)`).
 */
export function marketableMarkPerShare(input: MarketableMarkInput): number {
  const { midPerShare, side } = input;
  if (typeof midPerShare !== 'number' || !Number.isFinite(midPerShare) || midPerShare <= 0) {
    return 0;
  }

  // 1) Explicit two-sided quote is authoritative when usable.
  if (input.quote) {
    const { bid, ask } = input.quote;
    if (side === 'long' && typeof bid === 'number' && Number.isFinite(bid) && bid >= 0) {
      return bid;
    }
    if (side === 'short' && typeof ask === 'number' && Number.isFinite(ask) && ask > 0) {
      return ask;
    }
    // Quote present but the relevant side is missing/bad — fall through to model.
  }

  // 2) Model the marketable price from the mid via the half-spread fraction.
  const h = clampHalfSpreadFrac(
    input.halfSpreadFrac ?? DEFAULT_MARKETABLE_HALF_SPREAD_FRAC,
  );
  const marketable = side === 'long' ? midPerShare * (1 - h) : midPerShare * (1 + h);
  return Math.max(0, marketable);
}

/** The minimal open-position shape the valuation needs (a structural subset of `OptionPosition`). */
export interface MarketableValuablePosition {
  premiumPaid: number;
  currentPremium: number;
  contracts: number;
  contractsRemaining?: number;
  /** Present ⇒ a SHORT credit position (covered write); absent ⇒ long. */
  coveredWrite?: unknown;
}

/** Side of a position for marketable valuation: a covered write is short, everything else long. */
export function positionSide(pos: { coveredWrite?: unknown }): MarketableSide {
  return pos.coveredWrite != null ? 'short' : 'long';
}

/**
 * Realizable unrealized P&L (USD) for ONE open long position, valued at the
 * marketable mark instead of the mid: `(marketableMark − premiumPaid) ×
 * contractsRemaining × 100`. Mirrors the account's MID `unrealizedPnlForMode`
 * per-position formula so the two agree except for the mark used. Contributes 0
 * when there is no usable mark or no remaining contracts (matches the panel's
 * "no mark, no contribution" rule). Pure.
 *
 * `halfSpreadFrac` / `quote` are threaded through to {@link marketableMarkPerShare}.
 */
export function marketableUnrealizedUsd(
  pos: MarketableValuablePosition,
  opts: { halfSpreadFrac?: number; quote?: { bid?: number; ask?: number; mark?: number } } = {},
): number {
  if (!Number.isFinite(pos.currentPremium) || pos.currentPremium <= 0) return 0;
  if (!Number.isFinite(pos.premiumPaid) || pos.premiumPaid <= 0) return 0;
  const remaining = pos.contractsRemaining ?? pos.contracts;
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;

  const side = positionSide(pos);
  const mark = marketableMarkPerShare({
    midPerShare: pos.currentPremium,
    side,
    ...(opts.quote ? { quote: opts.quote } : {}),
    ...(opts.halfSpreadFrac !== undefined ? { halfSpreadFrac: opts.halfSpreadFrac } : {}),
  });
  if (mark <= 0) return 0;
  // P&L sign convention matches the existing long-shaped `unrealizedPnlForMode`
  // (mark − paid). For a short credit position the marketable mark is the ASK
  // (higher than mid), so this yields a MORE-negative unrealized than the mid —
  // the honest realizable value of a short you'd have to buy back.
  return (mark - pos.premiumPaid) * remaining * 100;
}

/** Config the account stores to drive the marketable path. Default = disabled (MID behavior). */
export interface MarketableOpenMtmConfig {
  /** When false (default) every marketable path is inert and the book uses the MID. */
  enabled: boolean;
  /** Modeled half-spread fraction used when no live two-sided quote is available. */
  halfSpreadFrac: number;
}

/** The DARK default: disabled, modeled fraction seeded from the measured mean. */
export const DEFAULT_MARKETABLE_OPEN_MTM_CONFIG: MarketableOpenMtmConfig = {
  enabled: false,
  halfSpreadFrac: DEFAULT_MARKETABLE_HALF_SPREAD_FRAC,
};

/**
 * Normalize a partial config into a complete {@link MarketableOpenMtmConfig},
 * clamping the fraction and defaulting missing fields to the DARK baseline.
 */
export function normalizeMarketableConfig(
  partial: Partial<MarketableOpenMtmConfig> | undefined,
): MarketableOpenMtmConfig {
  return {
    enabled: partial?.enabled === true,
    halfSpreadFrac:
      partial?.halfSpreadFrac !== undefined && Number.isFinite(partial.halfSpreadFrac)
        ? clampHalfSpreadFrac(partial.halfSpreadFrac)
        : DEFAULT_MARKETABLE_HALF_SPREAD_FRAC,
  };
}
