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
  gradeAssetClassArmPrecondition,
  setAssetClassWatchlistProvider,
} from './underlying-asset-class.js';
import { OPTION_LIVE_OTM_UNIVERSE_VAR as UNIVERSE_VAR } from './otm-live-universe-flag.js';

const FLAG = OPTION_ENTRY_ASSET_CLASS_REFUSAL_FLAG;

beforeEach(() => {
  delete process.env[FLAG];
  clearEntrySiteAssetClassCensus();
});
afterEach(() => {
  delete process.env[FLAG];
  clearEntrySiteAssetClassCensus();
  setAssetClassWatchlistProvider(null);
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

// ─────────────────────────────────────────────────────────────────────────────
// TRA-4144 — THE ARM PRECONDITION (CEO ask, 2026-09-01)
//
// "What does the classifier emit for an ordinary equity? If unclassified
// underlyings fall through to `unknown`, then refusing `unknown` does not refuse
// crypto wrappers -- it refuses the entire sleeve, and we ship a full stop-trade
// believing we shipped a narrow carve-out."
//
// Measured that day: 3 of the 10 names in the PRODUCTION allowlist (GIS, TFC,
// MO) classified `unknown`. The registry gap is closed; these fixtures pin BOTH
// the closure and the instrument that keeps it closed after the next env edit,
// because `OPTION_LIVE_OTM_UNIVERSE` is an env var and a list patch expires.
describe('TRA-4144 — the arm precondition (what the gate emits on the MODAL world)', () => {
  // The value in force on bqb1, board-ratified 2026-08-13 (TRA-3417).
  const PROD_UNIVERSE = 'AAPL,SPY,QQQ,PLTR,TSLA,GIS,TFC,MO,VZ,UPS';
  const envWith = (universe?: string): NodeJS.ProcessEnv =>
    (universe === undefined ? {} : { [UNIVERSE_VAR]: universe }) as NodeJS.ProcessEnv;

  it('the measured 2026-09-01 defect is CLOSED: all 10 production names classify, none refused in error', () => {
    const p = gradeAssetClassArmPrecondition(envWith(PROD_UNIVERSE));
    expect(p.universeSource).toBe('env');
    expect(p.evaluated).toBe(10);
    // The three that used to fall through. Named individually: a count cannot
    // tell a closed gap from a shrunken universe.
    for (const sym of ['GIS', 'TFC', 'MO']) {
      expect(classifyUnderlyingAssetClass(sym)).toEqual({
        underlying: sym, assetClass: 'equity', source: 'static_list',
      });
    }
    expect(p.unknownUnderlyings).toEqual([]);
    expect(p.unknownCount).toBe(0);
    expect(p.coverage).toBe(1);
    expect(p.satisfied).toBe(true);
    expect(p.blockers).toEqual([]);
    expect(p.statement).toContain('SAFE TO ARM');
  });

  it('POSITIVE CONTROL — an unclassifiable name in the allowlist BLOCKS the arm and is named', () => {
    // The exact pre-fix state, reproduced with a synthetic name so the control
    // cannot be silently voided by a later registry addition.
    const p = gradeAssetClassArmPrecondition(envWith('AAPL,SPY,ZZQQ'));
    expect(p.evaluated).toBe(3);
    expect(p.unknownUnderlyings).toEqual(['ZZQQ']);
    expect(p.coverage).toBeCloseTo(0.6667, 4);
    expect(p.satisfied).toBe(false);
    expect(p.blockers.join(' ')).toContain('ZZQQ');
    expect(p.blockers.join(' ')).toContain('REFUSED IN ERROR');
    expect(p.statement).toContain('NOT SAFE TO ARM');
    // …and the remedy named on the wire is the list, never the fallback.
    expect(p.blockers.join(' ')).toContain('never widen the fallback');
  });

  it('an INTENDED refusal is not a blocker — refusing the wrapper is the deliverable', () => {
    // A crypto wrapper inside the allowlist is exactly what this ticket exists
    // to reject. It must NOT read as collateral damage, or the instrument would
    // refuse to arm the very gate it is grading.
    const p = gradeAssetClassArmPrecondition(envWith('AAPL,ETHA,SPY'));
    expect(p.intendedRefusals).toEqual(['ETHA']);
    expect(p.unknownUnderlyings).toEqual([]);
    expect(p.coverage).toBe(1);
    expect(p.satisfied).toBe(true);
    expect(p.symbols.find((s) => s.underlying === 'ETHA')).toMatchObject({
      assetClass: 'crypto_proxy_etf', wouldRefuse: true,
    });
    expect(p.statement).toContain('ETHA');
  });

  it('an UNRESTRICTED universe with NO watchlist read is NOT a pass — the denominator is unmeasurable', () => {
    for (const sentinel of ['*', 'ALL', 'all']) {
      const p = gradeAssetClassArmPrecondition(envWith(sentinel));
      expect(p.universeRestricted).toBe(false);
      expect(p.universeSource).toBe('env_unrestricted');
      expect(p.population).toBe('unenumerable');
      expect(p.watchlistProviderWired).toBe(false);
      expect(p.evaluated).toBe(0);
      // A share of an unenumerable population is not 100% — it is unknown.
      expect(p.coverage).toBeNull();
      expect(p.satisfied).toBe(false);
      expect(p.blockers.join(' ')).toContain('UNRESTRICTED');
      expect(p.blockers.join(' ')).toContain('UNMEASURED');
      expect(p.blockers.join(' ')).toContain('NOT WIRED');
    }
  });

  it('CEO a86d95de — an UNRESTRICTED universe grades the RUNTIME WATCHLIST when the provider is wired', () => {
    // Production is `*`: the gate above (`universe`) admits the full watchlist,
    // so the precondition's denominator is the watchlist, not any allowlist —
    // and the read publishes the COUNT of unplaceables, not a bare false.
    setAssetClassWatchlistProvider(() => ['aapl', 'AAPL', ' spy ', 'ETHA', 'ZZQQ', 'QQZZ', '']);
    const p = gradeAssetClassArmPrecondition(envWith('*'));
    expect(p.universeRestricted).toBe(false);
    expect(p.population).toBe('runtime_watchlist');
    expect(p.watchlistProviderWired).toBe(true);
    expect(p.evaluated).toBe(5); // deduped, trimmed, uppercased, empties dropped
    expect(p.unknownUnderlyings.slice().sort()).toEqual(['QQZZ', 'ZZQQ']);
    expect(p.unknownCount).toBe(2);
    expect(p.coverage).toBeCloseTo(0.6, 4);
    expect(p.satisfied).toBe(false);
    expect(p.blockers.join(' ')).toContain('2 of 5');
    expect(p.blockers.join(' ')).toContain('runtime watchlist');
    // The intended refusal stays a deliverable, never a blocker, on this population too.
    expect(p.intendedRefusals).toEqual(['ETHA']);
    // Per-name rows are allowlist-only wire; the watchlist is counts + lists.
    expect(p.symbols).toEqual([]);
  });

  it('a fully-classifiable wired watchlist CAN satisfy the precondition — and says it graded a snapshot', () => {
    setAssetClassWatchlistProvider(() => ['AAPL', 'SPY', 'ETHA']);
    const p = gradeAssetClassArmPrecondition(envWith('*'));
    expect(p.population).toBe('runtime_watchlist');
    expect(p.unknownCount).toBe(0);
    expect(p.coverage).toBe(1);
    expect(p.satisfied).toBe(true);
    expect(p.statement).toContain('SAFE TO ARM');
    expect(p.statement).toContain('SNAPSHOT');
  });

  it('a provider that THROWS or returns an EMPTY watchlist never reads as a pass', () => {
    setAssetClassWatchlistProvider(() => { throw new Error('engine dark'); });
    const threw = gradeAssetClassArmPrecondition(envWith('*'));
    // Unreadable ≠ empty: a throw is `unenumerable`, wired-but-unreadable.
    expect(threw.population).toBe('unenumerable');
    expect(threw.watchlistProviderWired).toBe(true);
    expect(threw.satisfied).toBe(false);
    expect(threw.blockers.join(' ')).toContain('UNREADABLE');

    setAssetClassWatchlistProvider(() => []);
    const empty = gradeAssetClassArmPrecondition(envWith('*'));
    expect(empty.population).toBe('runtime_watchlist');
    expect(empty.evaluated).toBe(0);
    expect(empty.coverage).toBeNull();
    expect(empty.satisfied).toBe(false);
    expect(empty.blockers.join(' ')).toContain('empty');
  });

  it('the published unknown list is CAPPED but the count never is', () => {
    const names = Array.from({ length: 60 }, (_, i) => `ZZQ${String(i).padStart(3, '0')}`);
    setAssetClassWatchlistProvider(() => names);
    const p = gradeAssetClassArmPrecondition(envWith('*'));
    expect(p.unknownCount).toBe(60);
    expect(p.unknownUnderlyings).toHaveLength(50);
    expect(p.unknownUnderlyingsTruncated).toBe(true);
    expect(p.blockers.join(' ')).toContain('60 of 60');
    expect(p.blockers.join(' ')).toContain('+10 more');
  });

  it('a RESTRICTED universe ignores the watchlist provider — the allowlist is the enforced population', () => {
    setAssetClassWatchlistProvider(() => ['ZZQQ', 'QQZZ']); // would fail if consulted
    const p = gradeAssetClassArmPrecondition(envWith(PROD_UNIVERSE));
    expect(p.population).toBe('resolved_allowlist');
    expect(p.evaluated).toBe(10);
    expect(p.satisfied).toBe(true);
  });

  it('an unset / malformed universe grades the RESTRICTIVE fallback the gate would actually enforce', () => {
    const unset = gradeAssetClassArmPrecondition(envWith());
    expect(unset.universeSource).toBe('default');
    expect(unset.evaluated).toBe(5);
    expect(unset.satisfied).toBe(true);

    const invalid = gradeAssetClassArmPrecondition(envWith(',,,'));
    expect(invalid.universeSource).toBe('env_invalid');
    // Same five names as `default`, and the source discriminates the two: an
    // operator who set an unparseable value believes something else is live.
    expect(invalid.symbols.map((s) => s.underlying)).toEqual(unset.symbols.map((s) => s.underlying));
    expect(invalid.satisfied).toBe(true);
  });

  it('THE INSTRUMENT AGREES WITH THE GATE — `wouldRefuse` is checked against the real refusal path', () => {
    // An instrument that can disagree with its gate is not an instrument. For
    // every allowlisted name the predicted verdict must equal what
    // `assetClassRefusalReason` ACTUALLY does with the flag armed.
    const universe = 'AAPL,SPY,QQQ,PLTR,TSLA,GIS,TFC,MO,VZ,UPS,ETHA,IBIT,COIN,ZZQQ';
    const p = gradeAssetClassArmPrecondition(envWith(universe));
    const armed = { [FLAG]: '1' } as NodeJS.ProcessEnv;
    expect(p.symbols).toHaveLength(14);
    for (const s of p.symbols) {
      const { reason } = assetClassRefusalReason(s.underlying, armed);
      expect({ sym: s.underlying, refused: s.wouldRefuse }).toEqual({
        sym: s.underlying, refused: reason !== null,
      });
    }
    // …and the two refusal REASONS stay separated on that mixed universe.
    expect(p.intendedRefusals).toEqual(['ETHA', 'IBIT']);
    expect(p.unknownUnderlyings).toEqual(['ZZQQ']);
    // COIN is published, NOT refused — widening to it is a board edit (header).
    expect(p.symbols.find((s) => s.underlying === 'COIN')).toMatchObject({
      assetClass: 'crypto_adjacent_equity', wouldRefuse: false,
    });
  });

  it('the DEFAULT BRANCH is unchanged by the registry patch — a name with no rule is still `unknown`', () => {
    // The gap was closed by NAMING five symbols, not by making misses permissive.
    for (const sym of ['ZZQQ', 'QQZZ', 'NOTATICKER']) {
      expect(classifyUnderlyingAssetClass(sym)).toEqual({
        underlying: sym, assetClass: 'unknown', source: 'none',
      });
    }
    expect(REFUSED_ASSET_CLASSES).toContain('unknown');
  });

  it('the precondition rides the health payload, so the arm question is a READ', () => {
    const h = gradeUnderlyingAssetClassHealth([], [], envWith(PROD_UNIVERSE));
    expect(h.armPrecondition.satisfied).toBe(true);
    expect(h.armPrecondition.universeVar).toBe(UNIVERSE_VAR);
    expect(h.reason).toContain('ARM PRECONDITION SATISFIED');

    const blocked = gradeUnderlyingAssetClassHealth([], [], envWith('AAPL,ZZQQ'));
    expect(blocked.armPrecondition.satisfied).toBe(false);
    expect(blocked.reason).toContain('ARM PRECONDITION NOT SATISFIED');
    expect(blocked.reason).toContain('1 unknown');
  });
});
