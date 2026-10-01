import { describe, it, expect, beforeEach } from 'vitest';
import {
  tradierStructuralReason,
  isTradierSymbolNotFound,
  admitTradierSymbol,
  noteTradierSymbolNotFound,
  noteTradierSymbolServed,
  getTradierSymbolAdmissibilityState,
  __resetTradierSymbolAdmissibilityForTests,
  TRADIER_NOT_FOUND_TTL_MS,
  TRADIER_NEGATIVE_CACHE_CAP,
  US_CLASS_SHARE_SUFFIXES,
} from './tradier-symbol-admissibility.js';
import { shouldTripTradierBreaker, getTradierQuotaBudgetState } from './yahoo-feed.js';

/**
 * TRA-4987 — the capability suite for the bad-symbol suppression.
 *
 * ⛔ Acceptance 5 is the shape of this file: **the filter must be shown to both
 * ADMIT and REJECT.** A suite that only asserts rejection is green under a filter
 * that suppresses everything — which would satisfy the headline acceptance
 * (`refusalsSinceBoot` growth → 0) perfectly while un-pricing the universe. So
 * every reject case below has a named admit counterpart, and the admit cases are
 * the ones that would catch an over-broad rule.
 *
 * The live baseline these assert against (bqb1, 2026-10-01T19:59:05Z, RTH):
 * `refusalByClass.timesales.refusalsSinceBoot 29084`, `lastRefusalReason
 * "Invalid parameter, ^TNX: symbol not found."`, 20-row ring = 9 `^`-prefixed,
 * 6 `.`-suffixed foreign, 5 delisted/unknown US.
 */
describe('tradierStructuralReason — the shape layer (TRA-4987 AC5)', () => {
  it('REJECTS every ^-prefixed index spelling measured in the live ring', () => {
    // 9 of the 20 live ring rows. Tradier has no `^`-prefixed symbols at all.
    for (const sym of ['^TNX', '^VIX', '^TYX', '^N225', '^GSPC', '^NDX', '^IXIC']) {
      expect(tradierStructuralReason(sym), sym).toBe('index_prefix');
    }
    // `$`-prefixed is the same class of Yahoo/StockTwits index spelling.
    expect(tradierStructuralReason('$SPX')).toBe('index_prefix');
  });

  it('REJECTS the .-suffixed foreign listings measured in the live ring', () => {
    // 6 of the 20 live ring rows, plus the four more named on TRA-4987.
    for (const sym of ['2330.TW', 'EVO.ST', 'ARX.TO', 'VDY.TO', 'TMPV.NS', 'TSMC.BA']) {
      expect(tradierStructuralReason(sym), sym).toBe('foreign_suffix');
    }
  });

  it('ADMITS ordinary US tickers — the negative control that catches an over-broad rule', () => {
    // `SPY` is acceptance 4's named known-good symbol. The rest are the live
    // watchlist's shape variety: mega-caps, ETFs, a renamed ticker, a crypto pair.
    for (const sym of ['SPY', 'AAPL', 'QQQ', 'XYZ', 'IWM', 'BTC-USD', 'A', 'TSM']) {
      expect(tradierStructuralReason(sym), sym).toBeNull();
    }
  });

  it('ADMITS single-letter dot suffixes — `BRK.B` must not read as a foreign listing', () => {
    // The deliberate, documented trade-off: a single letter is ambiguous between a
    // US class share (served) and `.L`/`.T` (not served), so the shape layer
    // admits and the negative cache learns. Un-pricing `BRK.B` is the expensive
    // direction; one request per TTL on `AZN.L` is the cheap one.
    for (const suffix of US_CLASS_SHARE_SUFFIXES) {
      expect(tradierStructuralReason(`BRK.${suffix}`), suffix).toBeNull();
    }
    expect(tradierStructuralReason('AZN.L')).toBeNull();
  });

  it('is total — empty, blank and lower-case inputs never throw and never falsely reject', () => {
    expect(tradierStructuralReason('')).toBeNull();
    expect(tradierStructuralReason('   ')).toBeNull();
    expect(tradierStructuralReason('spy')).toBeNull();
    // Case-insensitive on the reject side too, so a lower-cased caller is covered.
    expect(tradierStructuralReason('^tnx')).toBe('index_prefix');
    expect(tradierStructuralReason('evo.st')).toBe('foreign_suffix');
  });
});

describe('isTradierSymbolNotFound — the vendor-reason discriminator', () => {
  it('matches the live message byte-for-byte as `stocks-client` builds it', () => {
    expect(
      isTradierSymbolNotFound(
        'Tradier timesales(^TNX) HTTP 400: {"errors":{"error":"Invalid parameter, ^TNX: symbol not found."}}',
      ),
    ).toBe(true);
  });

  it('does NOT match a quota refusal — the two have opposite remedies (TRA-4919)', () => {
    expect(
      isTradierSymbolNotFound('Tradier quotes(batch) HTTP 400: Quota Violation: Expires 1790883120000'),
    ).toBe(false);
    expect(isTradierSymbolNotFound('Tradier timesales(SPY) HTTP 504: Gateway Timeout')).toBe(false);
    expect(isTradierSymbolNotFound('')).toBe(false);
  });
});

describe('admitTradierSymbol + negative cache (TRA-4987 AC2, AC5)', () => {
  beforeEach(() => {
    __resetTradierSymbolAdmissibilityForTests();
  });

  it('admits a shape-clean symbol until Tradier refuses it, then suppresses for the TTL', () => {
    const t0 = 1_790_884_571_583;
    // `BBBY` is delisted but shape-clean: no rule could have predicted it. The
    // first request MUST go out — that is how the fact is learned.
    expect(admitTradierSymbol('BBBY', 'timesales', t0).admitted).toBe(true);

    noteTradierSymbolNotFound('BBBY', 'timesales', t0);

    const refused = admitTradierSymbol('BBBY', 'timesales', t0 + 1_000);
    expect(refused.admitted).toBe(false);
    expect(refused.reason).toBe('symbol_not_found');
    expect(refused.expiresAtMs).toBe(t0 + TRADIER_NOT_FOUND_TTL_MS);

    // Still suppressed one ms before the TTL lapses…
    expect(admitTradierSymbol('BBBY', 'timesales', t0 + TRADIER_NOT_FOUND_TTL_MS - 1).admitted).toBe(false);
    // …and re-probed the moment it does. A permanent denylist is the failure mode.
    expect(admitTradierSymbol('BBBY', 'timesales', t0 + TRADIER_NOT_FOUND_TTL_MS).admitted).toBe(true);
    expect(getTradierSymbolAdmissibilityState(t0 + TRADIER_NOT_FOUND_TTL_MS).negativeCacheExpiries).toBe(1);
  });

  it('a repeat verdict REFRESHES the window instead of stacking', () => {
    const t0 = 1_000_000;
    noteTradierSymbolNotFound('SBLX', 'timesales', t0);
    noteTradierSymbolNotFound('SBLX', 'timesales', t0 + 60_000);
    const s = getTradierSymbolAdmissibilityState(t0 + 60_000);
    expect(s.negativeCacheInserts).toBe(1);
    expect(s.negativeCacheRefreshes).toBe(1);
    expect(s.negativeCacheSize).toBe(1);
    expect(admitTradierSymbol('SBLX', 'timesales', t0 + TRADIER_NOT_FOUND_TTL_MS + 1).admitted).toBe(false);
  });

  it('a served response clears the suppression unconditionally — recovery is the default', () => {
    const t0 = 2_000_000;
    noteTradierSymbolNotFound('APGE', 'timesales', t0);
    expect(admitTradierSymbol('APGE', 'timesales', t0).admitted).toBe(false);
    noteTradierSymbolServed('APGE');
    expect(admitTradierSymbol('APGE', 'timesales', t0).admitted).toBe(true);
    expect(getTradierSymbolAdmissibilityState(t0).negativeCacheRecoveries).toBe(1);
  });

  it('is case- and whitespace-insensitive, so one spelling cannot leak past the cache', () => {
    const t0 = 3_000_000;
    noteTradierSymbolNotFound('bbby', 'timesales', t0);
    expect(admitTradierSymbol('  BBBY ', 'timesales', t0).admitted).toBe(false);
  });

  it('structural rejects never spend a request and never expire', () => {
    const t0 = 4_000_000;
    expect(admitTradierSymbol('^TNX', 'timesales', t0).admitted).toBe(false);
    // A year later it is still the wrong shape — nothing to re-probe.
    const far = admitTradierSymbol('^TNX', 'timesales', t0 + 365 * 24 * 3_600_000);
    expect(far.admitted).toBe(false);
    expect(far.expiresAtMs).toBeNull();
    // …and it did not pollute the negative cache, which exists for LEARNED facts.
    expect(getTradierSymbolAdmissibilityState(t0).negativeCacheSize).toBe(0);
  });

  it('bounds membership at the cap and COUNTS the eviction rather than hiding it', () => {
    const t0 = 5_000_000;
    for (let i = 0; i < TRADIER_NEGATIVE_CACHE_CAP + 3; i++) {
      // Distinct, shape-clean, un-aliased junk tickers, each 1ms newer.
      noteTradierSymbolNotFound(`JUNK${i}`, 'timesales', t0 + i);
    }
    const s = getTradierSymbolAdmissibilityState(t0);
    expect(s.negativeCacheSize).toBe(TRADIER_NEGATIVE_CACHE_CAP);
    expect(s.negativeCacheEvictions).toBe(3);
    // The evicted entries are the ones closest to expiry (oldest insert), so the
    // freshest fact survives — and an eviction is visible, because a capped
    // suppression is no longer a complete one.
    expect(s.negativeCacheSymbols.some(r => r.symbol === 'JUNK0')).toBe(false);
    expect(s.negativeCacheSymbols.some(r => r.symbol === `JUNK${TRADIER_NEGATIVE_CACHE_CAP + 2}`)).toBe(true);
  });
});

describe('the published counter (TRA-4987 AC2)', () => {
  beforeEach(() => {
    __resetTradierSymbolAdmissibilityForTests();
  });

  it('separates "nothing was bad" from "the gate never ran"', () => {
    // Boot state: the gate has not been consulted. `suppressed: 0` here is NOT an
    // all-clear and `evaluations` is the field that says so.
    expect(getTradierSymbolAdmissibilityState(1).evaluations).toBe(0);
    expect(getTradierSymbolAdmissibilityState(1).suppressed).toBe(0);

    // A healthy universe: consulted, nothing suppressed. Distinguishable.
    admitTradierSymbol('SPY', 'timesales', 2);
    const healthy = getTradierSymbolAdmissibilityState(2);
    expect(healthy.evaluations).toBe(1);
    expect(healthy.suppressed).toBe(0);
    expect(healthy.lastSuppressed).toBeNull();
  });

  it('attributes `suppressed` to a layer, so a moved number is explainable', () => {
    const t0 = 6_000_000;
    admitTradierSymbol('^TNX', 'timesales', t0);
    admitTradierSymbol('ARX.TO', 'timesales', t0);
    noteTradierSymbolNotFound('BBBY', 'timesales', t0);
    admitTradierSymbol('BBBY', 'timesales', t0);

    const s = getTradierSymbolAdmissibilityState(t0);
    // Three gate consultations; `noteTradierSymbolNotFound` is a write, not a read.
    expect(s.evaluations).toBe(3);
    expect(s.suppressed).toBe(3);
    expect(s.structuralSkips).toBe(2);
    expect(s.structuralSkipsByReason).toEqual({ index_prefix: 1, foreign_suffix: 1 });
    expect(s.negativeCacheSkips).toBe(1);
    expect(s.notFoundObserved).toBe(1);
    // The partition closes: every suppression belongs to exactly one layer.
    expect(s.structuralSkips + s.negativeCacheSkips).toBe(s.suppressed);
    expect(s.lastSuppressed).toMatchObject({ symbol: 'BBBY', reason: 'symbol_not_found', endpointClass: 'timesales' });
  });

  it('names its own scope so a reader cannot over-read it as account-wide', () => {
    expect(getTradierSymbolAdmissibilityState(1).scope).toBe('tradier_bar_paths_only');
    expect(getTradierSymbolAdmissibilityState(1).ttlMs).toBe(TRADIER_NOT_FOUND_TTL_MS);
  });

  it('rides on the health payload the grade is read from, UNCONDITIONALLY', () => {
    // AC2 is read off `/api/health/quotes` →
    // `results.tradierQuotaBudget.admissibility`. Assert the KEY'S PRESENCE, not a
    // truthy value: `suppressed: 0` on a healthy box is falsy-adjacent and an
    // `?? 0` reader would render a pre-TRA-4987 build identically to a working one.
    const s = getTradierQuotaBudgetState();
    expect(Object.prototype.hasOwnProperty.call(s, 'admissibility')).toBe(true);
    expect(s.admissibility.scope).toBe('tradier_bar_paths_only');
    expect(typeof s.admissibility.evaluations).toBe('number');
    expect(s.admissibility.evaluations).not.toBeNull();
  });
});

describe('shouldTripTradierBreaker — a bad symbol must not open the breaker (TRA-4987 remedy 4)', () => {
  it('does not trip on the live bad-symbol body', () => {
    expect(
      shouldTripTradierBreaker(
        'Tradier timesales(^TNX) HTTP 400: {"errors":{"error":"Invalid parameter, ^TNX: symbol not found."}}',
      ),
    ).toBe(false);
  });

  it('still trips on a real quota violation, a 429 and a 5xx', () => {
    // The carve-out must not become a hole: these are the degradations the breaker
    // exists for, and one of them is a 400 too.
    expect(shouldTripTradierBreaker('Tradier quotes(batch) HTTP 400: Quota Violation: Expires 1790883120000')).toBe(true);
    expect(shouldTripTradierBreaker('Tradier timesales(SPY) HTTP 429: too many requests')).toBe(true);
    expect(shouldTripTradierBreaker('Tradier history(SPY) HTTP 504: Gateway Timeout')).toBe(true);
    // Pathological both-at-once body: quota wins, because a missed real quota
    // violation is the expensive direction.
    expect(shouldTripTradierBreaker('HTTP 400: Quota Violation; symbol not found')).toBe(true);
  });
});
