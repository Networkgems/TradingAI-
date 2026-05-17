/**
 * TRA-185 — spread-aware cost model.
 *
 * Per-fill cost (commission + slippage, both expressed in basis points of
 * notional) keyed by symbol. Used by the backtest runner to drop the flat
 * 40 bps + 5 bps assumption that over-charges majors and under-charges
 * small-cap alts. See `docs/cost-model.md` for tier sourcing.
 */

/** Per-fill commission and slippage, both in basis points of notional. */
export interface FillCost {
  commissionBps: number;
  slippageBps: number;
}

/**
 * Strategy-agnostic per-fill cost lookup. The runner calls `resolve(symbol)`
 * once per backtest (each `BacktestConfig` is single-symbol) and reuses the
 * answer for every fill — entry and exit, every position.
 */
export interface CostModel {
  resolve(symbol: string): FillCost;
}

/**
 * Crypto liquidity tiers. The labels are diagnostic — the runner only uses
 * the per-fill bps; tier names show up in harness output so reviewers can see
 * which tier a symbol landed in without re-reading the table.
 */
export type CryptoSpreadTier = 'major' | 'high_liq' | 'mid' | 'small';

export interface CryptoTierEntry {
  tier: CryptoSpreadTier;
  fill: FillCost;
}

/**
 * Per-fill cost split per tier. Round-trip = 2 × (commissionBps + slippageBps)
 * because both fire on entry AND exit. The numbers below match the issue's
 * cited ranges (TRA-185 description):
 *
 *   - majors:         5–15  bps round-trip → 6 bps × 2 = 12 bps RT
 *   - high-liq alts:  ~30   bps round-trip (SOL sits between majors and mid)
 *   - mid-cap alts:   25–40 bps round-trip → 30 bps × 2 = 60 bps RT
 *   - small-cap alts: 60–120 bps round-trip → 50 bps × 2 = 100 bps RT
 *
 * Commission vs. slippage split is informed by Coinbase Advanced Trade taker
 * fees (~10–25 bps depending on volume tier) plus realized impact; the runner
 * only cares about the sum since both apply per fill.
 */
export const CRYPTO_TIER_FILLS: Record<CryptoSpreadTier, FillCost> = {
  major:    { commissionBps: 4,  slippageBps: 2 },   // 12 bps round-trip
  high_liq: { commissionBps: 10, slippageBps: 8 },   // 36 bps round-trip
  mid:      { commissionBps: 20, slippageBps: 10 },  // 60 bps round-trip
  small:    { commissionBps: 35, slippageBps: 15 },  // 100 bps round-trip
};

/**
 * Default crypto symbol → tier assignment. Sourced from realized round-trip
 * spread quartiles on Coinbase / Binance during 2024–2025; see
 * `docs/cost-model.md` for the methodology and any reviewer challenges.
 *
 * Symbols not listed default to `small` — small-caps are the conservative
 * assumption when the universe is unknown, and over-charging an unlisted
 * major shows up as a quiet drag in the next sweep rather than a silent pass.
 */
export const DEFAULT_CRYPTO_TIERS: ReadonlyMap<string, CryptoSpreadTier> = new Map([
  ['BTC-USD',  'major'],
  ['ETH-USD',  'major'],
  ['SOL-USD',  'high_liq'],
  ['LINK-USD', 'mid'],
  ['AVAX-USD', 'mid'],
  ['ADA-USD',  'small'],
  // TRA-445 — MATIC rebranded to POL (Polygon token migration). The cost
  // tier is unchanged (small-cap alt); the key follows the watchlist rename.
  ['POL-USD',  'small'],
  ['DOGE-USD', 'small'],
]);

const DEFAULT_FALLBACK_TIER: CryptoSpreadTier = 'small';

export interface CryptoTieredCostModelOptions {
  /** Override or extend the symbol → tier table. Merged on top of defaults. */
  tiers?: ReadonlyMap<string, CryptoSpreadTier>;
  /** Tier returned when a symbol is unknown. Defaults to `small`. */
  fallbackTier?: CryptoSpreadTier;
  /** Override the per-tier fill cost. Useful for sensitivity sweeps. */
  fills?: Partial<Record<CryptoSpreadTier, FillCost>>;
}

/**
 * Build a {@link CostModel} that resolves crypto symbols to their tiered
 * fill cost. Pure data: no I/O, no rolling-window candle proxy. The data
 * inputs in {@link DEFAULT_CRYPTO_TIERS} and {@link CRYPTO_TIER_FILLS} are
 * the only knobs to refute when the model is challenged.
 */
export function cryptoTieredCostModel(opts: CryptoTieredCostModelOptions = {}): CostModel {
  const tiers = new Map<string, CryptoSpreadTier>(DEFAULT_CRYPTO_TIERS);
  if (opts.tiers) for (const [k, v] of opts.tiers) tiers.set(k, v);
  const fallback = opts.fallbackTier ?? DEFAULT_FALLBACK_TIER;
  const fills: Record<CryptoSpreadTier, FillCost> = { ...CRYPTO_TIER_FILLS, ...opts.fills };

  return {
    resolve(symbol: string): FillCost {
      const tier = tiers.get(symbol) ?? fallback;
      return fills[tier];
    },
  };
}

/**
 * Return the tier a symbol resolves to under the default crypto tier table.
 * Exposed so harness scripts can label per-symbol output rows without
 * duplicating the table.
 */
export function cryptoTierOf(
  symbol: string,
  tiers: ReadonlyMap<string, CryptoSpreadTier> = DEFAULT_CRYPTO_TIERS,
  fallback: CryptoSpreadTier = DEFAULT_FALLBACK_TIER,
): CryptoSpreadTier {
  return tiers.get(symbol) ?? fallback;
}

/**
 * Convenience flat cost model — keeps existing flat-cost callers convertible
 * to the `CostModel` interface without rewriting them.
 */
export function flatCostModel(fill: FillCost): CostModel {
  return { resolve: () => fill };
}
