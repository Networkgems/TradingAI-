// TRA-1545 — the crypto symbol denylist must exclude USD-quoted stablecoin /
// fiat-peg products from the DEMO crypto_core DCA universe. Trend-gated DCA on a
// flat ~$1 peg is degenerate (no trend, meaningless 200-day-EMA gate), and
// PAX-USD was actually opened by demo DCA in the TRA-1538 daily review. These
// assert the confirmed Coinbase pegs are blocked while a normal alt is not.
import { describe, it, expect } from 'vitest';
import {
  isCryptoSymbolBlocked,
  CRYPTO_STABLECOIN_DENYLIST,
} from './index.js';

describe('crypto stablecoin denylist (TRA-1545)', () => {
  it('blocks every USD-quoted stablecoin peg in the list', () => {
    for (const peg of CRYPTO_STABLECOIN_DENYLIST) {
      expect(isCryptoSymbolBlocked(peg), `${peg} should be blocked`).toBe(true);
    }
  });

  it('blocks the pegs observed / online today regardless of case', () => {
    expect(isCryptoSymbolBlocked('PAX-USD')).toBe(true); // opened by demo DCA
    expect(isCryptoSymbolBlocked('USDT-USD')).toBe(true);
    expect(isCryptoSymbolBlocked('USDS-USD')).toBe(true);
    expect(isCryptoSymbolBlocked('usdt-usd')).toBe(true); // case-insensitive
  });

  it('still preserves the pre-existing operator denylist entries', () => {
    expect(isCryptoSymbolBlocked('TERMINUS-USD')).toBe(true);
    expect(isCryptoSymbolBlocked('RUNE-USD')).toBe(true);
  });

  it('does not block normal alts', () => {
    expect(isCryptoSymbolBlocked('INJ-USD')).toBe(false);
    expect(isCryptoSymbolBlocked('BTC-USD')).toBe(false);
    expect(isCryptoSymbolBlocked('ETH-USD')).toBe(false);
    expect(isCryptoSymbolBlocked('SOL-USD')).toBe(false);
  });
});
