// TRA-4826 — controls for the /api/health/quotes verdict.
//
// The route imports `computeQuotesHealthVerdict` (index.ts, buildQuotesHealthPayload),
// so these grade the SHIPPED symbol, not a local copy. The incident fixture below is
// the live 2026-09-23T14:34:21Z payload, transcribed field-for-field — the control
// "fails before the fix" in the literal sense that the pre-TRA-4826 formula is
// asserted GREEN on these same bytes (first test), and the shipped verdict is
// asserted RED on them (second test). A fixture on which both formulas agree would
// discriminate nothing.

import { describe, expect, it } from 'vitest';
import {
  computeQuotesHealthVerdict,
  type QuotesProviderInput,
  type QuotesProviderKey,
} from './quotes-health-verdict.js';

const provider = (
  probeOk: boolean,
  probeCached: boolean,
  breakerOpen: boolean | null,
): QuotesProviderInput => ({ probeOk, probeCached, breakerOpen });

// The 2026-09-23T14:34:21Z incident, verbatim from the live payload:
//   tradierBreakerOpen: true (reason "quota"), yahooBreakerOpen: true (crumb 429),
//   results.tradier answered (direct client call, breaker bypassed),
//   results.yahooFinance: { error: "Failed to get crumb, status 429..." },
//   results.yahooChartQuote: { error: "...no price for AAPL" },
//   results.twelveData: { error: "...(reason=breaker_open)" },
//   downstream: sweep BLIND 68/68, starvedBreakerOpen 21356/21356, 0 signals, 0 cards.
const INCIDENT: Record<QuotesProviderKey, QuotesProviderInput> = {
  tradier: provider(true, false, true),
  yahooFinance: provider(false, false, true),
  yahooChartQuote: provider(false, false, false),
  twelveData: provider(false, false, true),
};

describe('computeQuotesHealthVerdict (TRA-4826)', () => {
  it('CONTROL — the pre-fix formula reads GREEN on the incident bytes (the defect)', () => {
    // stocksOk = ok(tradier) || ok(yahooFinance) || ok(yahooChartQuote); ok = stocksOk.
    // This is what shipped until TRA-4826: it consults NO breaker and NO cache flag.
    const preFixStocksOk =
      INCIDENT.tradier.probeOk || INCIDENT.yahooFinance.probeOk || INCIDENT.yahooChartQuote.probeOk;
    expect(preFixStocksOk).toBe(true); // the fixture discriminates: old green...
  });

  it('the incident reads ok:false, degraded, with every open breaker named', () => {
    const v = computeQuotesHealthVerdict(INCIDENT); // ...new red, same bytes.
    expect(v.ok).toBe(false);
    expect(v.stocksOk).toBe(false); // tradier's probe answered, but its breaker was open
    expect(v.degraded).toBe(true);
    expect(v.degradedProviders).toEqual(['tradier', 'yahooFinance', 'twelveData']);
  });

  it('a healthy fleet reads ok:true (the fix is not a hardcoded red)', () => {
    const v = computeQuotesHealthVerdict({
      tradier: provider(true, false, false),
      yahooFinance: provider(true, false, false),
      yahooChartQuote: provider(true, false, false),
      twelveData: provider(true, false, false),
    });
    expect(v.ok).toBe(true);
    expect(v.stocksOk).toBe(true);
    expect(v.degraded).toBe(false);
    expect(v.degradedProviders).toEqual([]);
  });

  it('a cache-served probe can NEVER alone produce a pass (acceptance #1, clause 2)', () => {
    // Every breaker closed; the only green evidence is cache-served.
    const v = computeQuotesHealthVerdict({
      tradier: provider(true, true, false),
      yahooFinance: provider(false, false, false),
      yahooChartQuote: provider(false, false, false),
      twelveData: provider(false, false, false),
    });
    expect(v.stocksOk).toBe(false);
    expect(v.ok).toBe(false);
    expect(v.probeCached.tradier).toBe(true); // and the cache hit is visible top-level
    // Same shape with the evidence LIVE passes — cached-ness is the discriminating term.
    const live = computeQuotesHealthVerdict({
      tradier: provider(true, false, false),
      yahooFinance: provider(false, false, false),
      yahooChartQuote: provider(false, false, false),
      twelveData: provider(false, false, false),
    });
    expect(live.stocksOk).toBe(true);
    expect(live.ok).toBe(true);
  });

  it('a single open breaker fails ok even when stocks are fine (any-provider clause)', () => {
    const v = computeQuotesHealthVerdict({
      tradier: provider(true, false, false),
      yahooFinance: provider(true, false, false),
      yahooChartQuote: provider(true, false, false),
      twelveData: provider(false, false, true), // twelveData latched to midnight
    });
    expect(v.stocksOk).toBe(true); // stock-only monitors (TRA-783) must not page
    expect(v.ok).toBe(false); // but the route can no longer read green
    expect(v.degraded).toBe(true);
    expect(v.degradedProviders).toEqual(['twelveData']);
  });

  it('an UNREADABLE breaker degrades and cannot contribute a pass (UNKNOWN is not OFF)', () => {
    const v = computeQuotesHealthVerdict({
      tradier: provider(true, false, null), // probe green, breaker state unreadable
      yahooFinance: provider(false, false, false),
      yahooChartQuote: provider(false, false, false),
      twelveData: provider(false, false, false),
    });
    expect(v.stocksOk).toBe(false); // tradier's green probe is not usable evidence
    expect(v.ok).toBe(false);
    expect(v.degradedProviders).toEqual(['tradier:breaker-unreadable']);
  });
});
