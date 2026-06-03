import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ACCOUNT_SETTINGS,
  DEFAULT_RV_DTE_MAX,
  DEFAULT_RV_DTE_MIN,
  DEFAULT_RV_DTE_TARGET,
  HARD_MAX_RISK_PER_TRADE,
  managedAccountRatioField,
  resolveManagedAccountRatio,
  resolveRiskPerTrade,
  resolveRvDtePrefs,
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
    // Sub-cap values (≤ HARD_MAX_RISK_PER_TRADE) so this test exercises bucket
    // isolation only — the TRA-526 hard cap is covered separately below.
    const s = makeSettings({
      riskPerTrade: 0.01,
      riskPerTradeLiveCrypto: 0.015,
    });
    expect(resolveRiskPerTrade(s, 'crypto', 'live')).toBe(0.015);
    expect(resolveRiskPerTrade(s, 'crypto', 'demo')).toBe(0.01);
    expect(resolveRiskPerTrade(s, 'stocks', 'demo')).toBe(0.01);
    expect(resolveRiskPerTrade(s, 'stocks', 'live')).toBe(0.01);
  });
});

// TRA-526 — deterministic per-trade risk hard cap. The operator knobs (and the
// route clamp, which admits up to 0.5) are a soft preference; resolveRiskPerTrade
// is the chokepoint that the engine sizes from, so the hard ceiling lives here.
describe('resolveRiskPerTrade — TRA-526 hard cap', () => {
  it('caps any resolved value at HARD_MAX_RISK_PER_TRADE (2%)', () => {
    const s = makeSettings({
      riskPerTradeLiveStocks: 0.5,   // 50% — what the route clamp would admit
      riskPerTradeLiveCrypto: 0.25,
      riskPerTradeDemoStocks: 0.03,  // just over the cap
    });
    expect(resolveRiskPerTrade(s, 'stocks', 'live')).toBe(HARD_MAX_RISK_PER_TRADE);
    expect(resolveRiskPerTrade(s, 'crypto', 'live')).toBe(HARD_MAX_RISK_PER_TRADE);
    expect(resolveRiskPerTrade(s, 'stocks', 'demo')).toBe(HARD_MAX_RISK_PER_TRADE);
  });

  it('leaves sub-cap values untouched, including the 1% default', () => {
    expect(resolveRiskPerTrade(makeSettings(), 'stocks', 'live')).toBe(0.01);
    expect(resolveRiskPerTrade(makeSettings({ riskPerTradeLiveStocks: 0.018 }), 'stocks', 'live')).toBe(0.018);
    expect(resolveRiskPerTrade(makeSettings({ riskPerTradeLiveStocks: HARD_MAX_RISK_PER_TRADE }), 'stocks', 'live')).toBe(HARD_MAX_RISK_PER_TRADE);
  });

  it('falls back to the default for corrupt (non-finite / non-positive) saves rather than disabling sizing', () => {
    expect(resolveRiskPerTrade(makeSettings({ riskPerTradeLiveStocks: 0 }), 'stocks', 'live')).toBe(DEFAULT_ACCOUNT_SETTINGS.riskPerTrade);
    expect(resolveRiskPerTrade(makeSettings({ riskPerTradeLiveStocks: -0.01 }), 'stocks', 'live')).toBe(DEFAULT_ACCOUNT_SETTINGS.riskPerTrade);
    expect(resolveRiskPerTrade(makeSettings({ riskPerTradeLiveStocks: NaN }), 'stocks', 'live')).toBe(DEFAULT_ACCOUNT_SETTINGS.riskPerTrade);
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
          [riskKey]: 0.017, // sub-cap (≤ HARD_MAX_RISK_PER_TRADE) so this asserts key consistency, not the TRA-526 cap
        } as Partial<AccountSettings>);
        expect(resolveManagedAccountRatio(s, market, mode)).toBe(0.99);
        expect(resolveRiskPerTrade(s, market, mode)).toBe(0.017);
      }
    }
  });
});

describe('resolveRvDtePrefs (TRA-373)', () => {
  it('returns the spec defaults (21 / 60 / 35) when no fields are saved', () => {
    // Saved-before-TRA-373 snapshot: rvDte* fields are absent. Every read
    // must surface the spec defaults so the user keeps the new wider window
    // until they edit it.
    const s: AccountSettings = {
      ...DEFAULT_ACCOUNT_SETTINGS,
      rvDteMin: undefined,
      rvDteMax: undefined,
      rvDteTarget: undefined,
    };
    expect(resolveRvDtePrefs(s)).toEqual({
      min: DEFAULT_RV_DTE_MIN,
      max: DEFAULT_RV_DTE_MAX,
      target: DEFAULT_RV_DTE_TARGET,
    });
  });

  it('honours saved overrides verbatim when they are well-formed', () => {
    const s = { ...DEFAULT_ACCOUNT_SETTINGS, rvDteMin: 30, rvDteMax: 90, rvDteTarget: 50 };
    expect(resolveRvDtePrefs(s)).toEqual({ min: 30, max: 90, target: 50 });
  });

  it('reverts to spec defaults when min > max (fat-finger swap)', () => {
    const s = { ...DEFAULT_ACCOUNT_SETTINGS, rvDteMin: 60, rvDteMax: 21, rvDteTarget: 35 };
    expect(resolveRvDtePrefs(s)).toEqual({
      min: DEFAULT_RV_DTE_MIN,
      max: DEFAULT_RV_DTE_MAX,
      target: DEFAULT_RV_DTE_TARGET,
    });
  });

  it('clamps target into the saved [min, max] range', () => {
    const tooLow = { ...DEFAULT_ACCOUNT_SETTINGS, rvDteMin: 30, rvDteMax: 90, rvDteTarget: 10 };
    expect(resolveRvDtePrefs(tooLow).target).toBe(30);
    const tooHigh = { ...DEFAULT_ACCOUNT_SETTINGS, rvDteMin: 30, rvDteMax: 90, rvDteTarget: 200 };
    expect(resolveRvDtePrefs(tooHigh).target).toBe(90);
  });

  it('coerces non-finite / non-positive saves back to the spec defaults', () => {
    const s = {
      ...DEFAULT_ACCOUNT_SETTINGS,
      rvDteMin: 0,
      rvDteMax: Number.NaN,
      rvDteTarget: -5,
    };
    expect(resolveRvDtePrefs(s)).toEqual({
      min: DEFAULT_RV_DTE_MIN,
      max: DEFAULT_RV_DTE_MAX,
      target: DEFAULT_RV_DTE_TARGET,
    });
  });
});
