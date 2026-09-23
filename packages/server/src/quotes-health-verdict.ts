// TRA-4826 — the /api/health/quotes verdict, as ONE pure function, so the shipped
// symbol and the tested symbol are the same thing (the route imports THIS).
//
// The incident (2026-09-23, 10:31-10:34 ET, RTH): all three quote providers were
// breaker-open at once — Tradier (reason "quota", cycling ~60s), Yahoo (crumb 429),
// Twelve Data (latched to midnight) — the SMA200 sweep was starved 21356/21356,
// the engine produced zero signals and zero cards all session... and the route said
// `ok: true, stocksOk: true`, because its verdict was
//
//     stocksOk = ok(tradier) || ok(yahooFinance) || ok(yahooChartQuote);
//     ok       = stocksOk;
//
// i.e. "some AAPL probe answered". Two ways a probe answers while the engine starves:
//   - the tradier probe calls the engine client DIRECTLY, bypassing the breaker the
//     real fetch path honours — one direct request succeeding says nothing about a
//     path that is quota-blocked for the ~782-symbol universe;
//   - probe legs can be served from caches (the minute-bar probe carried
//     `cached: true` in the incident payload) — cached bytes prove the cache works,
//     not that the feed is up.
//
// The contract (TRA-4826 acceptance #1):
//   - `ok` can NEVER be true while any provider breaker is open — or unreadable:
//     "could not check" must not share a verdict with "checked and it is fine";
//   - a cache-served probe can never, alone, produce a pass: cached evidence does
//     not count toward `stocksOk`;
//   - `stocksOk` keeps its TRA-783 job for stock-only monitors: true iff at least
//     one STOCK provider has live, non-cached probe evidence AND a closed breaker.
//     A twelveData-only degradation therefore reads `stocksOk: true, ok: false,
//     degraded: true` — degraded, not a stock outage.

export type QuotesProviderKey = 'tradier' | 'yahooFinance' | 'yahooChartQuote' | 'twelveData';

/** The three providers whose probes can evidence that STOCKS are priceable. */
const STOCK_PROVIDER_KEYS: readonly QuotesProviderKey[] = ['tradier', 'yahooFinance', 'yahooChartQuote'];

export interface QuotesProviderInput {
  /** The provider's health probe produced a usable result (no error, no skip). */
  probeOk: boolean;
  /** The probe evidence was served from a cache rather than a live upstream call. */
  probeCached: boolean;
  /**
   * The provider's circuit breaker is open. `null` = the breaker state could not
   * be read — which fails CLOSED: an unreadable breaker degrades the verdict and
   * never counts as "closed" (UNKNOWN is not OFF).
   */
  breakerOpen: boolean | null;
}

export interface QuotesHealthVerdict {
  /** Overall feed health: live stock evidence AND no provider degraded. */
  ok: boolean;
  /** At least one stock provider: probe ok, NOT cached, breaker measurably closed. */
  stocksOk: boolean;
  /** True iff any provider breaker is open or unreadable. */
  degraded: boolean;
  /** Which providers degrade the verdict, `<key>` or `<key>:breaker-unreadable`. */
  degradedProviders: string[];
  /** Per-provider: was the probe evidence cache-served? (surfaced top-level so a
   * cache hit is visible without digging into `results.*`). */
  probeCached: Record<QuotesProviderKey, boolean>;
}

export function computeQuotesHealthVerdict(
  providers: Record<QuotesProviderKey, QuotesProviderInput>,
): QuotesHealthVerdict {
  const degradedProviders: string[] = [];
  for (const key of Object.keys(providers) as QuotesProviderKey[]) {
    const p = providers[key];
    if (p.breakerOpen === true) degradedProviders.push(key);
    else if (p.breakerOpen === null) degradedProviders.push(`${key}:breaker-unreadable`);
  }
  // Live, non-cached evidence with a measurably CLOSED breaker. `=== false` (not
  // `!breakerOpen`) so an unreadable breaker can never contribute a pass.
  const stocksOk = STOCK_PROVIDER_KEYS.some((key) => {
    const p = providers[key];
    return p.probeOk && !p.probeCached && p.breakerOpen === false;
  });
  const probeCached = Object.fromEntries(
    (Object.keys(providers) as QuotesProviderKey[]).map((key) => [key, providers[key].probeCached]),
  ) as Record<QuotesProviderKey, boolean>;
  return {
    ok: stocksOk && degradedProviders.length === 0,
    stocksOk,
    degraded: degradedProviders.length > 0,
    degradedProviders,
    probeCached,
  };
}
