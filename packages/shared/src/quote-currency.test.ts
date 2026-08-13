// TRA-3390 (impl child of TRA-2628) — AC5: TWO-DIRECTIONAL controls.
//
// "A guard that refuses everything and a guard that refuses nothing both pass a
// one-directional test." So every block below asserts BOTH directions, and the
// positive control CONTAINS what it detects: the fixtures are the real rows
// measured live on bqb1 (build eb1dcf0c8a6f, pid 73) on 2026-08-12 —
//
//   005930.KS = 255500   KRW   (Samsung Electronics)
//   AZN.L     = 11714    GBp   (AstraZeneca — PENCE, not pounds)
//   2330.TW   = 2415     TWD
//   RHM.DE    = 1173.8   EUR
//   DSV.CO    = 1365     DKK
//   EVO.ST    = 738.2    SEK
//
// not invented placeholders. A fixture of `{ symbol: 'FOO', currency: 'XXX' }`
// would pass every assertion here while proving nothing about the 16 rows that
// are actually in the live universe.

import { describe, it, expect } from 'vitest';
import {
  normalizeQuoteCurrency,
  formatQuoteLevel,
  isUsdQuote,
  quoteCurrencySizingVerdict,
  hasForeignListingSuffix,
  PENCE_CURRENCY,
} from './quote-currency.js';

/** The live exemplars, verbatim. */
const LIVE_FOREIGN_ROWS = [
  { symbol: '005930.KS', price: 255500, raw: 'KRW', code: 'KRW' },
  { symbol: 'AZN.L', price: 11714, raw: 'GBp', code: 'GBX' },
  { symbol: '2330.TW', price: 2415, raw: 'TWD', code: 'TWD' },
  { symbol: 'RHM.DE', price: 1173.8, raw: 'EUR', code: 'EUR' },
  { symbol: 'DSV.CO', price: 1365, raw: 'DKK', code: 'DKK' },
  { symbol: 'EVO.ST', price: 738.2, raw: 'SEK', code: 'SEK' },
] as const;

describe('normalizeQuoteCurrency (TRA-3390 AC1)', () => {
  it('canonicalizes every live adapter string', () => {
    for (const row of LIVE_FOREIGN_ROWS) {
      expect(normalizeQuoteCurrency(row.raw), row.symbol).toBe(row.code);
    }
    expect(normalizeQuoteCurrency('USD')).toBe('USD');
  });

  // THE 100x TEST. `GBp` (pence) and `GBP` (pounds) differ by two orders of
  // magnitude and differ ONLY in the case of the last letter. A `.toUpperCase()`
  // normalizer collapses them and silently re-introduces the class of error the
  // whole ticket is about, and it would pass a test that only checked `GBp`.
  it('keeps GBp (pence) and GBP (pounds) DISTINCT', () => {
    expect(normalizeQuoteCurrency('GBp')).toBe(PENCE_CURRENCY);
    expect(normalizeQuoteCurrency('GBX')).toBe(PENCE_CURRENCY);
    expect(normalizeQuoteCurrency('GBx')).toBe(PENCE_CURRENCY);
    // The other direction: pounds must NOT be folded into pence.
    expect(normalizeQuoteCurrency('GBP')).toBe('GBP');
    expect(normalizeQuoteCurrency('GBP')).not.toBe(PENCE_CURRENCY);
  });

  it('returns undefined — never USD — for an absent or unusable value', () => {
    for (const bad of [undefined, null, '', '   ', 42, {}, 'US', 'USDT', 'dollars']) {
      expect(normalizeQuoteCurrency(bad as unknown), String(bad)).toBeUndefined();
    }
  });
});

describe('formatQuoteLevel (TRA-3390 AC1 + AC2)', () => {
  // ── DIRECTION 1: a real non-USD row must render with NO dollar sign ─────────
  it('renders every live foreign row without a `$`', () => {
    for (const row of LIVE_FOREIGN_ROWS) {
      const rendered = formatQuoteLevel(row.price, normalizeQuoteCurrency(row.raw));
      expect(rendered, row.symbol).not.toContain('$');
      expect(rendered, row.symbol).toContain(row.code);
    }
  });

  it('renders the two named exemplars exactly', () => {
    expect(formatQuoteLevel(255500, 'KRW')).toBe('255,500.00 KRW');
    // Pence stay pence. Not silently divided by 100 into pounds — a converted
    // number is a different datum and would need its own provenance.
    expect(formatQuoteLevel(11714, PENCE_CURRENCY)).toBe('11,714.00 GBX');
  });

  // ── DIRECTION 2: a USD row must STILL render with a `$` ─────────────────────
  it('still renders a USD row with `$`, unchanged from the old formatter', () => {
    expect(formatQuoteLevel(1550000, 'USD')).toBe('$1,550,000.00');
    expect(formatQuoteLevel(8.3, 'USD')).toBe('$8.30');
    expect(formatQuoteLevel(-0.19, 'USD', { signed: true })).toBe('-$0.19');
    expect(formatQuoteLevel(0.19, 'USD', { signed: true })).toBe('+$0.19');
  });

  // ── The unknown case, which is the one a USD default would have swallowed ───
  it('renders an UNKNOWN currency bare — no symbol, and specifically not `$`', () => {
    const rendered = formatQuoteLevel(1234.56, undefined);
    expect(rendered).toBe('1,234.56');
    expect(rendered).not.toContain('$');
  });

  it('returns the em-dash sentinel for a non-finite level', () => {
    for (const bad of [null, undefined, NaN, Infinity, -Infinity]) {
      expect(formatQuoteLevel(bad as number, 'USD')).toBe('—');
      expect(formatQuoteLevel(bad as number, 'KRW')).toBe('—');
    }
  });

  it('isUsdQuote is true for USD only', () => {
    expect(isUsdQuote('USD')).toBe(true);
    for (const c of ['KRW', 'GBX', 'GBP', 'EUR', undefined]) {
      expect(isUsdQuote(c), String(c)).toBe(false);
    }
  });
});

describe('the 2026-07-28 regression row (TRA-2628)', () => {
  // The literal string that got filed. It must not be producible any more from a
  // KRW row, and must still be producible from a USD one — otherwise this test
  // would pass on a formatter that simply stopped printing money.
  it('cannot render `$1,550,000.00` for a KRW level, but can for a USD one', () => {
    expect(formatQuoteLevel(1550000, 'KRW')).toBe('1,550,000.00 KRW');
    expect(formatQuoteLevel(1550000, 'USD')).toBe('$1,550,000.00');
  });
});

describe('hasForeignListingSuffix (refusal input only)', () => {
  it('matches the live foreign tickers, INCLUDING the single-letter `.L`', () => {
    for (const row of LIVE_FOREIGN_ROWS) {
      expect(hasForeignListingSuffix(row.symbol), row.symbol).toBe(true);
    }
    // `.L` is the one a suffix-length heuristic gets wrong, so it is asserted
    // by name as well as inside the loop.
    expect(hasForeignListingSuffix('AZN.L')).toBe(true);
  });

  it('does not match plain US tickers or hyphenated crypto pairs', () => {
    for (const s of ['AAPL', 'SPY', 'QQQ', 'FGMC', 'BTC-USD', 'ETH-USD', '']) {
      expect(hasForeignListingSuffix(s), s).toBe(false);
    }
  });
});

describe('quoteCurrencySizingVerdict (TRA-3390 AC4) — BOTH directions', () => {
  // AC5, explicitly: "prove it CAN admit a USD signal AND can refuse a non-USD
  // one. A filter that reduces nothing may simply have had nothing to reduce."

  // ── It CAN admit ───────────────────────────────────────────────────────────
  it('ADMITS a USD-quoted US listing', () => {
    expect(quoteCurrencySizingVerdict({ symbol: 'AAPL', currency: 'USD' }))
      .toEqual({ allowed: true });
    expect(quoteCurrencySizingVerdict({ symbol: 'SPY', currency: 'USD' }))
      .toEqual({ allowed: true });
  });

  it('ADMITS a US listing whose source carried no currency at all (Stooq)', () => {
    // Not taking the book dark is a property, not an oversight: the Stooq
    // fallback reports no currency and it serves US names.
    expect(quoteCurrencySizingVerdict({ symbol: 'AAPL', currency: undefined }))
      .toEqual({ allowed: true });
  });

  // ── It CAN refuse ──────────────────────────────────────────────────────────
  it('REFUSES every live foreign row, and names the currency in the reason', () => {
    for (const row of LIVE_FOREIGN_ROWS) {
      const v = quoteCurrencySizingVerdict({
        symbol: row.symbol,
        currency: normalizeQuoteCurrency(row.raw),
      });
      expect(v.allowed, row.symbol).toBe(false);
      if (v.allowed) throw new Error('unreachable');
      expect(v.reason, row.symbol).toContain(row.code);
      expect(v.reason, row.symbol).toContain('TRA-3390');
    }
  });

  it('REFUSES the live `ENR.DE` EUR buy — the row AC4 was written about', () => {
    // `entryPrice 165.70 / stopLoss 139.11 / takeProfit 218.89`, all EUR,
    // `mode: "live"`, held today only by an UNRELATED strategy-registration gate.
    const v = quoteCurrencySizingVerdict({ symbol: 'ENR.DE', currency: 'EUR' });
    expect(v.allowed).toBe(false);
  });

  it('REFUSES a foreign-suffixed listing whose currency is UNKNOWN', () => {
    // The absent case must not fall through to "allowed" on a foreign listing —
    // that is the sizing-side version of defaulting the render to USD.
    const v = quoteCurrencySizingVerdict({ symbol: '005930.KS', currency: undefined });
    expect(v.allowed).toBe(false);
    if (v.allowed) throw new Error('unreachable');
    expect(v.reason).toContain('unknown quote currency');
  });

  it('REFUSES GBP as well as GBX — pounds are no more the book currency than pence', () => {
    expect(quoteCurrencySizingVerdict({ symbol: 'AZN.L', currency: 'GBP' }).allowed).toBe(false);
    expect(quoteCurrencySizingVerdict({ symbol: 'AZN.L', currency: PENCE_CURRENCY }).allowed).toBe(false);
  });
});
