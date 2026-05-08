import { describe, it, expect, beforeEach } from 'vitest';
import {
  isCoinbaseListed,
  _resetCoinbaseProductCatalogForTests,
  _seedCoinbaseProductCatalogForTests,
} from './crypto-feed.js';

// TRA-338 — the Coinbase product allowlist is the gate the crypto engine uses
// to decide whether to even consider opening a position on a symbol. Tests
// exercise it via the seed/reset hooks rather than a real /products fetch so
// they stay deterministic offline.
describe('isCoinbaseListed — Coinbase product allowlist gate (TRA-338)', () => {
  beforeEach(() => {
    _resetCoinbaseProductCatalogForTests();
  });

  it('returns null when the catalog has never been refreshed (fail-closed signal)', () => {
    // Caller must treat null as "do not open until we know" — see the engine's
    // doTick gate. Returning null instead of false lets a /products outage
    // distinguishably suppress entries without poisoning the cache.
    expect(isCoinbaseListed('BTC-USD')).toBeNull();
  });

  it('returns true for a product that is online and not trading-disabled', () => {
    _seedCoinbaseProductCatalogForTests([
      { id: 'BTC-USD', online: true, tradingDisabled: false },
    ]);
    expect(isCoinbaseListed('BTC-USD')).toBe(true);
  });

  it('returns false for a product Coinbase does not list', () => {
    _seedCoinbaseProductCatalogForTests([
      { id: 'BTC-USD', online: true, tradingDisabled: false },
    ]);
    // MEGA-USD is the TRA-337 root cause: not on Coinbase at all, and Yahoo's
    // ghost MEGA-USD ticker resolves to a delisted-2022 token.
    expect(isCoinbaseListed('MEGA-USD')).toBe(false);
  });

  it('returns false for a product whose status is not "online"', () => {
    _seedCoinbaseProductCatalogForTests([
      { id: 'FOO-USD', online: false, tradingDisabled: false },
    ]);
    expect(isCoinbaseListed('FOO-USD')).toBe(false);
  });

  it('returns false for a product whose trading is disabled', () => {
    _seedCoinbaseProductCatalogForTests([
      { id: 'BAR-USD', online: true, tradingDisabled: true },
    ]);
    expect(isCoinbaseListed('BAR-USD')).toBe(false);
  });
});
