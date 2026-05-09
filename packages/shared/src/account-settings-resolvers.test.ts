import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ACCOUNT_SETTINGS,
  managedAccountRatioField,
  resolveManagedAccountRatio,
  resolveRiskPerTrade,
  riskPerTradeField,
} from './index.js';
import type { AccountMode, AccountSettings } from './index.js';

// TRA-349 — regression-lock the four-bucket scoping introduced by TRA-346.
// Pre-346 every (mode × dashboard) pair read the same `managedAccountRatio` /
// `riskPerTrade` field, so a Demo edit silently widened Live order sizing on
// Coinbase / Tradier. The resolvers below own the new (mode × market) read
// path; if a future refactor rewires any sub-account back to the un-suffixed
// field or the wrong bucket, these tests fail before the regression ships.

const MODES: AccountMode[] = ['demo', 'live'];
const MARKETS: Array<'crypto' | 'stocks'> = ['crypto', 'stocks'];

function makeSettings(overrides: Partial<AccountSettings> = {}): AccountSettings {
  return { ...DEFAULT_ACCOUNT_SETTINGS, ...overrides };
}

describe('resolveManagedAccountRatio (TRA-346)', () => {
  it('falls back to the legacy un-suffixed field when the scoped bucket is undefined', () => {
    // Saved-before-TRA-346 snapshot: only `managedAccountRatio` is set; all
    // four scoped fields are undefined. Every (mode × market) combo must
    // surface the legacy value so existing users keep sizing the way they did.
    const s = makeSettings({ managedAccountRatio: 0.42 });
    for (const mode of MODES) {
      for (const market of MARKETS) {
        expect(resolveManagedAccountRatio(s, market, mode)).toBe(0.42);
      }
    }
  });

  it('returns the scoped value when the matching bucket is set', () => {
    const s = makeSettings({
      managedAccountRatio: 0.5,
      managedAccountRatioDemoStocks: 0.10,
      managedAccountRatioLiveStocks: 0.20,
      managedAccountRatioDemoCrypto: 0.30,
      managedAccountRatioLiveCrypto: 0.40,
    });
    expect(resolveManagedAccountRatio(s, 'stocks', 'demo')).toBe(0.10);
    expect(resolveManagedAccountRatio(s, 'stocks', 'live')).toBe(0.20);
    expect(resolveManagedAccountRatio(s, 'crypto', 'demo')).toBe(0.30);
    expect(resolveManagedAccountRatio(s, 'crypto', 'live')).toBe(0.40);
  });

  it('isolates each (market, mode) bucket — touching one never bleeds into another', () => {
    // Set only `managedAccountRatioDemoCrypto`. The other three combos must
    // still fall through to the legacy field; this is the headline TRA-346
    // invariant — Demo crypto edits must not pull Live or Stocks sizing along.
    const s = makeSettings({
      managedAccountRatio: 0.5,
      managedAccountRatioDemoCrypto: 0.07,
    });
    expect(resolveManagedAccountRatio(s, 'crypto', 'demo')).toBe(0.07);
    expect(resolveManagedAccountRatio(s, 'crypto', 'live')).toBe(0.5);
    expect(resolveManagedAccountRatio(s, 'stocks', 'demo')).toBe(0.5);
    expect(resolveManagedAccountRatio(s, 'stocks', 'live')).toBe(0.5);
  });
});

describe('resolveRiskPerTrade (TRA-346)', () => {
  it('falls back to the legacy un-suffixed field when the scoped bucket is undefined', () => {
    const s = makeSettings({ riskPerTrade: 0.013 });
    for (const mode of MODES) {
      for (const market of MARKETS) {
        expect(resolveRiskPerTrade(s, market, mode)).toBe(0.013);
      }
    }
  });

  it('returns the scoped value when the matching bucket is set', () => {
    const s = makeSettings({
      riskPerTrade: 0.01,
      riskPerTradeDemoStocks: 0.002,
      riskPerTradeLiveStocks: 0.004,
      riskPerTradeDemoCrypto: 0.006,
      riskPerTradeLiveCrypto: 0.008,
    });
    expect(resolveRiskPerTrade(s, 'stocks', 'demo')).toBe(0.002);
    expect(resolveRiskPerTrade(s, 'stocks', 'live')).toBe(0.004);
    expect(resolveRiskPerTrade(s, 'crypto', 'demo')).toBe(0.006);
    expect(resolveRiskPerTrade(s, 'crypto', 'live')).toBe(0.008);
  });

  it('isolates each (market, mode) bucket — touching one never bleeds into another', () => {
    const s = makeSettings({
      riskPerTrade: 0.01,
      riskPerTradeLiveCrypto: 0.05,
    });
    expect(resolveRiskPerTrade(s, 'crypto', 'live')).toBe(0.05);
    expect(resolveRiskPerTrade(s, 'crypto', 'demo')).toBe(0.01);
    expect(resolveRiskPerTrade(s, 'stocks', 'demo')).toBe(0.01);
    expect(resolveRiskPerTrade(s, 'stocks', 'live')).toBe(0.01);
  });
});

describe('field-name resolvers (TRA-346)', () => {
  it('managedAccountRatioField maps every (market, mode) to the scoped key the UI must write', () => {
    expect(managedAccountRatioField('stocks', 'demo')).toBe('managedAccountRatioDemoStocks');
    expect(managedAccountRatioField('stocks', 'live')).toBe('managedAccountRatioLiveStocks');
    expect(managedAccountRatioField('crypto', 'demo')).toBe('managedAccountRatioDemoCrypto');
    expect(managedAccountRatioField('crypto', 'live')).toBe('managedAccountRatioLiveCrypto');
  });

  it('riskPerTradeField maps every (market, mode) to the scoped key the UI must write', () => {
    expect(riskPerTradeField('stocks', 'demo')).toBe('riskPerTradeDemoStocks');
    expect(riskPerTradeField('stocks', 'live')).toBe('riskPerTradeLiveStocks');
    expect(riskPerTradeField('crypto', 'demo')).toBe('riskPerTradeDemoCrypto');
    expect(riskPerTradeField('crypto', 'live')).toBe('riskPerTradeLiveCrypto');
  });

  it('field-name resolvers and value resolvers agree for every (market, mode) pair', () => {
    // Belt-and-suspenders cross-check: the field name returned by
    // `managedAccountRatioField` is the same field the value resolver reads
    // when populated. If a future refactor rewires either resolver to a
    // different key, the values will diverge here.
    for (const market of MARKETS) {
      for (const mode of MODES) {
        const ratioKey = managedAccountRatioField(market, mode);
        const riskKey = riskPerTradeField(market, mode);
        const s = makeSettings({
          managedAccountRatio: 0.5,
          riskPerTrade: 0.01,
          [ratioKey]: 0.99,
          [riskKey]: 0.07,
        } as Partial<AccountSettings>);
        expect(resolveManagedAccountRatio(s, market, mode)).toBe(0.99);
        expect(resolveRiskPerTrade(s, market, mode)).toBe(0.07);
      }
    }
  });
});
