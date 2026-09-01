// TRA-4144 (parent TRA-3703, axis 4) — the underlying ASSET CLASS classifier,
// the default-OFF entry refusal, and the census folds.
//
// The measured fact these fixtures reproduce: on 2026-08-25 the OTM sleeve
// opened `ETHA261002C00019000` (spot-ether ETF) for $128.00 in the production
// `admin` book — 37.21% of the $344.00 fleet at-risk — against a ratified
// "crypto OFF" posture, and NOTHING BREACHED, because no control in the
// options entry path keyed on the underlying's asset class.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  classifyUnderlyingAssetClass,
  classifyOccUnderlyingAssetClass,
  assetClassRefusalReason,
  assetClassEntryPathBehavior,
  isOptionEntryAssetClassRefusalEnabled,
  gradeUnderlyingAssetClassHealth,
  recordEntrySiteAssetClassEvaluation,
  clearEntrySiteAssetClassCensus,
  OPTION_ENTRY_ASSET_CLASS_REFUSAL_FLAG,
  REFUSED_ASSET_CLASSES,
} from './underlying-asset-class.js';

const FLAG = OPTION_ENTRY_ASSET_CLASS_REFUSAL_FLAG;

beforeEach(() => {
  delete process.env[FLAG];
  clearEntrySiteAssetClassCensus();
});
afterEach(() => {
  delete process.env[FLAG];
  clearEntrySiteAssetClassCensus();
});

describe('TRA-4144 AC1 — the classifier, and never default to permissive', () => {
  it('ETHA — the measured wrapper — classifies crypto_proxy_etf off the static list', () => {
    expect(classifyUnderlyingAssetClass('ETHA')).toEqual({
      underlying: 'ETHA', assetClass: 'crypto_proxy_etf', source: 'static_list',
    });
    // Its siblings read the same: the posture is about the class, not one ticker.
    for (const s of ['IBIT', 'BITO', 'GBTC', 'FBTC', 'ETHE']) {
      expect(classifyUnderlyingAssetClass(s).assetClass).toBe('crypto_proxy_etf');
    }
  });

  it('the OCC root classifies identically to the bare underlying', () => {
    expect(classifyOccUnderlyingAssetClass('ETHA261002C00019000')).toEqual({
      underlying: 'ETHA', assetClass: 'crypto_proxy_etf', source: 'static_list',
    });
    expect(classifyOccUnderlyingAssetClass('NVTS261002C00012500').assetClass).toBe('equity');
  });

  it('each vocabulary class resolves off the static list, with the source named', () => {
    expect(classifyUnderlyingAssetClass('AAPL').assetClass).toBe('equity');
    expect(classifyUnderlyingAssetClass('SPY').assetClass).toBe('equity_etf');
    expect(classifyUnderlyingAssetClass('GLD').assetClass).toBe('commodity_etf');
    expect(classifyUnderlyingAssetClass('TLT').assetClass).toBe('bond_etf');
    expect(classifyUnderlyingAssetClass('VXX').assetClass).toBe('volatility_etp');
    // The wrapper one level down: crypto exposure in a COMMON-STOCK wrapper is
    // published as its own class, distinct from both `equity` and the ETPs.
    expect(classifyUnderlyingAssetClass('MSTR').assetClass).toBe('crypto_adjacent_equity');
    // GDX holds miner EQUITIES — it must not read as the metal.
    expect(classifyUnderlyingAssetClass('GDX').assetClass).toBe('equity_etf');
  });

  it('⭐ a miss is `unknown`/`none` — NEVER equity (the TRA-3440 permissive-branch shape)', () => {
    expect(classifyUnderlyingAssetClass('ZZZQX')).toEqual({
      underlying: 'ZZZQX', assetClass: 'unknown', source: 'none',
    });
    expect(classifyUnderlyingAssetClass('')).toMatchObject({ assetClass: 'unknown', source: 'none' });
    expect(classifyUnderlyingAssetClass(null).assetClass).toBe('unknown');
    expect(classifyUnderlyingAssetClass(undefined).assetClass).toBe('unknown');
    expect(classifyOccUnderlyingAssetClass(null).assetClass).toBe('unknown');
  });

  it('normalizes case and whitespace before looking anything up', () => {
    expect(classifyUnderlyingAssetClass('  etha ').assetClass).toBe('crypto_proxy_etf');
  });
});

describe('TRA-4144 AC3 — the refusal ships DISARMED, and arming it is one env write', () => {
  it('flag absent ⇒ advisory: even ETHA gets a null reason, and the behavior field says so', () => {
    expect(isOptionEntryAssetClassRefusalEnabled(process.env)).toBe(false);
    expect(assetClassEntryPathBehavior(process.env)).toBe('advisory_no_refusal');
    expect(assetClassRefusalReason('ETHA', process.env).reason).toBeNull();
    expect(assetClassRefusalReason('ZZZQX', process.env).reason).toBeNull();
  });

  it('armed ⇒ crypto_proxy_etf refuses, with the class, source, flag and ruling in the reason', () => {
    process.env[FLAG] = '1';
    expect(assetClassEntryPathBehavior(process.env)).toBe('enforcing');
    const { classification, reason } = assetClassRefusalReason('ETHA', process.env);
    expect(classification.assetClass).toBe('crypto_proxy_etf');
    expect(reason).toContain('ETHA');
    expect(reason).toContain('crypto_proxy_etf');
    expect(reason).toContain('static_list');
    expect(reason).toContain('TRA-3703 Q5');
  });

  it('⭐ armed ⇒ `unknown` refuses too — a denylist that admits what it cannot classify is a denylist a new wrapper walks through', () => {
    process.env[FLAG] = '1';
    expect(REFUSED_ASSET_CLASSES).toContain('unknown');
    const { reason } = assetClassRefusalReason('ZZZQX', process.env);
    expect(reason).toContain('unknown');
    expect(reason).toContain('never be admitted as the permissive class');
  });

  it('armed ⇒ equity and equity_etf still admit, and crypto_adjacent_equity is published-not-refused by default', () => {
    process.env[FLAG] = '1';
    expect(assetClassRefusalReason('AAPL', process.env).reason).toBeNull();
    expect(assetClassRefusalReason('SPY', process.env).reason).toBeNull();
    expect(assetClassRefusalReason('MSTR', process.env).reason).toBeNull();
  });
});

describe('TRA-4144 AC2 — the census, live and historical', () => {
  const MEASURED_BOOK = [
    {
      book: 'admin',
      positions: [
        // The measured row: $128 ETHA, 37.21% of $344.00.
        { symbol: 'ETHA', optionSymbol: 'ETHA261002C00019000', atRiskUsd: 128, priced: true },
        { symbol: 'NVTS', optionSymbol: 'NVTS261002C00012500', atRiskUsd: 151, priced: true },
      ],
    },
    {
      book: 'v0nni',
      positions: [
        { symbol: 'KO', optionSymbol: 'KO261002C00090000', atRiskUsd: 65, priced: true },
      ],
    },
  ];

  it('reads the measured book: ETHA $128.00 as crypto_proxy_etf, 1 row, 37.21% of $344.00', () => {
    const h = gradeUnderlyingAssetClassHealth(MEASURED_BOOK, [], process.env);
    expect(h.openRows.status).toBe('measured');
    expect(h.openRows.fleetAtRiskUsd).toBe(344);
    const crypto = h.openRows.byClass.find((b) => b.assetClass === 'crypto_proxy_etf')!;
    expect(crypto).toMatchObject({ rows: 1, atRiskUsd: 128, shareOfAtRisk: 0.3721 });
    expect(crypto.underlyings).toEqual(['ETHA']);
    // AC1 — every row carries its class and its source.
    const etha = h.openRows.rows.find((r) => r.underlying === 'ETHA')!;
    expect(etha).toMatchObject({
      book: 'admin', assetClass: 'crypto_proxy_etf', source: 'static_list', atRiskUsd: 128,
    });
    expect(h.openRows.censusIsLowerBound).toBe(false);
    expect(h.entryPathBehavior).toBe('advisory_no_refusal');
    expect(h.refuses).toBe(false);
    expect(h.unknownNeverReadsAsEquity).toBe(true);
  });

  it('an unknown row is COUNTED and forces the lower bound — never folded into equity', () => {
    const h = gradeUnderlyingAssetClassHealth(
      [{ book: 'admin', positions: [{ symbol: 'ZZZQX', optionSymbol: null, atRiskUsd: 50, priced: true }] }],
      [],
      process.env,
    );
    expect(h.openRows.unknownRows).toBe(1);
    expect(h.openRows.censusIsLowerBound).toBe(true);
    expect(h.openRows.byClass.find((b) => b.assetClass === 'unknown')).toMatchObject({ atRiskUsd: 50 });
    expect(h.openRows.byClass.find((b) => b.assetClass === 'equity')).toBeUndefined();
    expect(h.reason).toContain('LOWER BOUND');
  });

  it('a row with no underlying string classifies off its OCC root', () => {
    const h = gradeUnderlyingAssetClassHealth(
      [{ book: 'admin', positions: [{ symbol: null, optionSymbol: 'ETHA261002C00019000', atRiskUsd: 128, priced: true }] }],
      [],
      process.env,
    );
    expect(h.openRows.rows[0]).toMatchObject({ underlying: 'ETHA', assetClass: 'crypto_proxy_etf' });
  });

  it('a blind book and an unpriced/NaN row force the lower bound without poisoning the sum', () => {
    const h = gradeUnderlyingAssetClassHealth(
      [
        { book: 'admin', positions: [{ symbol: 'KO', optionSymbol: null, atRiskUsd: Number.NaN, priced: true }] },
        { book: 'v0nni', positions: null },
      ],
      [],
      process.env,
    );
    expect(h.openRows.unpricedRows).toBe(1);
    expect(h.openRows.blindBooks).toEqual(['v0nni']);
    expect(h.openRows.censusIsLowerBound).toBe(true);
    expect(h.openRows.fleetAtRiskUsd).toBe(0);
  });

  it('unwired ≠ empty ≠ measured — a build without a provider must not read "no crypto"', () => {
    expect(gradeUnderlyingAssetClassHealth(null, null, process.env).openRows.status).toBe('unwired');
    expect(gradeUnderlyingAssetClassHealth(null, null, process.env).tape.status).toBe('unwired');
    expect(gradeUnderlyingAssetClassHealth([], [], process.env).openRows.status).toBe('empty');
    expect(gradeUnderlyingAssetClassHealth([], [], process.env).tape.status).toBe('empty');
  });

  it('the retained tape folds buy_to_open fills by class: the ETHA fill reads $128.00 crypto_proxy_etf', () => {
    const h = gradeUnderlyingAssetClassHealth([], [
      { optionSymbol: 'ETHA261002C00019000', side: 'buy_to_open', contracts: 1, filledPrice: 1.28, book: 'admin' },
      { optionSymbol: 'ETHA261002C00019000', side: 'sell_to_close', contracts: 1, filledPrice: 1.27, book: 'admin' },
      { optionSymbol: 'NVTS261002C00012500', side: 'buy_to_open', contracts: 1, filledPrice: 1.51, book: 'v0nni' },
    ], process.env);
    expect(h.tape.status).toBe('measured');
    expect(h.tape.opens).toBe(2); // the close is not an open
    expect(h.tape.openPremiumUsd).toBe(279);
    expect(h.tape.byClass.find((b) => b.assetClass === 'crypto_proxy_etf')).toMatchObject({
      rows: 1, atRiskUsd: 128,
    });
    expect(h.tape.censusIsLowerBound).toBe(false);
  });

  it('a tape open with no usable fill price is counted unpriced and bounds the census from below', () => {
    const h = gradeUnderlyingAssetClassHealth([], [
      { optionSymbol: 'ETHA261002C00019000', side: 'buy_to_open', contracts: 1, filledPrice: null, book: 'admin' },
    ], process.env);
    expect(h.tape.unpricedOpens).toBe(1);
    expect(h.tape.censusIsLowerBound).toBe(true);
  });
});

describe('TRA-4144 AC1 — the entry-site census', () => {
  it('folds evaluations by class and keeps the recent ring, disclosed as ephemeral', () => {
    recordEntrySiteAssetClassEvaluation(classifyUnderlyingAssetClass('ETHA'), false, 'admin', 1_000);
    recordEntrySiteAssetClassEvaluation(classifyUnderlyingAssetClass('AAPL'), false, 'admin', 2_000);
    recordEntrySiteAssetClassEvaluation(classifyUnderlyingAssetClass('ETHA'), true, 'admin', 3_000);
    const h = gradeUnderlyingAssetClassHealth([], [], process.env);
    expect(h.entrySite.evaluated).toBe(3);
    expect(h.entrySite.refused).toBe(1);
    expect(h.entrySite.byClass.find((c) => c.assetClass === 'crypto_proxy_etf'))
      .toMatchObject({ evaluated: 2, refused: 1 });
    expect(h.entrySite.recent[0]).toMatchObject({
      underlying: 'ETHA', refused: true, book: 'admin', ts: 3_000,
    });
    expect(h.entrySite.durability).toBe('ephemeral_since_boot');
  });
});
