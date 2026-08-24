// TRA-3979 — FLEET CONCENTRATION.
//
// The tape this file is written against, measured on bqb1
// `3d0c3582cef78025dc78a2225e119513f7f64cb8` / pid 73 /
// `startedAt 2026-08-23T20:48:18.739Z`:
//
//     v0nni  NVTS261002C00012500  buy_to_open 1 ct @ 1.54  $154  14:25:07.953Z  ord 143021643
//     admin  NVTS261002C00012500  buy_to_open 1 ct @ 1.51  $151  14:44:34.991Z  ord 143032832
//                                                          ----
//                                                          $305  = 68.7% of $444
//
// Every gate passed and passed CORRECTLY (`reachableSumUsd 494.15`,
// `overageUsd 0`, `canaryCeiling within`). Nothing here is a regression test
// for a broken gate — it is the acceptance suite for the axis no gate had a
// reading on.
//
// ⚠ THE POSITIVE CONTROL IN THIS FILE IS THE `$305 IN ONE STRIKE` VS `$305
// ACROSS THREE NAMES` PAIR. A concentration fold that summed dollars and
// nothing else would pass every other assertion here and read those two
// identically — which is the exact defect the ticket is about. If that test is
// ever deleted, the rest of this suite proves the fold RUNS, not that it
// MEASURES.
import { describe, it, expect } from 'vitest';
import {
  gradeFleetConcentration,
  type FleetConcentrationBookRow,
  type FleetConcentrationPositionRow,
} from './fleet-concentration.js';
import { PaperOptionsAccount, foldOpenPremiumAtRisk } from './options-account.js';
import type { OptionPosition } from '@trading-app/shared';

const NVTS = 'NVTS261002C00012500';
const NVTS_15C = 'NVTS261002C00015000';

function row(over: Partial<FleetConcentrationPositionRow> = {}): FleetConcentrationPositionRow {
  return {
    optionSymbol: NVTS,
    symbol: 'NVTS',
    expiration: '2026-10-02',
    contracts: 1,
    atRiskUsd: 154,
    priced: true,
    ...over,
  };
}

function book(
  name: string,
  positions: FleetConcentrationPositionRow[] | null,
  gateOpen = true,
): FleetConcentrationBookRow {
  return { book: name, liveEntryGateOpen: gateOpen, positions };
}

/** The live tape, replayed. */
function liveFleet(): FleetConcentrationBookRow[] {
  return [
    book('v0nni', [row({ atRiskUsd: 154 })]),
    book('admin', [
      row({ atRiskUsd: 151 }),
      // admin's other two live rows on 08-24 ($290 total at risk, 3 rows).
      row({ optionSymbol: 'BAC260925C00063000', symbol: 'BAC', expiration: '2026-09-25', atRiskUsd: 54 }),
      row({ optionSymbol: 'XLF260925C00057500', symbol: 'XLF', expiration: '2026-09-25', contracts: 2, atRiskUsd: 85 }),
    ]),
    // Richard is `mode: 'live'` on SANDBOX with no options client — live-mode and
    // NOT gate-open. It must not reach the denominator.
    book('Richard', [], false),
    book('qa3599_1401', [], false),
  ];
}

describe('gradeFleetConcentration — AC1: the contract fold', () => {
  it('reproduces the live 08-24 finding: NVTS…C00012500 -> $305, 2 ct, [admin, v0nni]', () => {
    const r = gradeFleetConcentration(liveFleet());
    expect(r.status).toBe('measured');
    const nvts = r.byContract.find(b => b.key === NVTS);
    expect(nvts).toBeDefined();
    expect(nvts!.atRiskUsd).toBe(305);
    expect(nvts!.contracts).toBe(2);
    expect(nvts!.books).toEqual(['admin', 'v0nni']);
    expect(nvts!.bookCount).toBe(2);
    // 305 / 444 — the CEO's 68.7%.
    expect(nvts!.shareOfFleetAtRisk).toBeCloseTo(0.6869, 4);
    expect(r.fleetAtRiskUsd).toBe(444);
    // The hazard column: one OCC, more than one gate-open book.
    expect(r.multiBookContracts.map(b => b.key)).toEqual([NVTS]);
    expect(r.maxContract!.key).toBe(NVTS);
  });

  it('POSITIVE CONTROL — $305 in one strike and $305 across three names are DIFFERENT bytes', () => {
    const concentrated = gradeFleetConcentration([
      book('v0nni', [row({ atRiskUsd: 154 })]),
      book('admin', [row({ atRiskUsd: 151 })]),
    ]);
    const spread = gradeFleetConcentration([
      book('v0nni', [row({ atRiskUsd: 154 })]),
      book('admin', [row({
        optionSymbol: 'SPY261002C00700000', symbol: 'SPY', expiration: '2026-10-02', atRiskUsd: 151,
      })]),
    ]);
    // The DOLLAR reading — what the fleet bound sees — is identical.
    expect(spread.fleetAtRiskUsd).toBe(concentrated.fleetAtRiskUsd);
    // The CONCENTRATION reading is not.
    expect(concentrated.maxContract!.shareOfFleetAtRisk).toBe(1);
    expect(spread.maxContract!.shareOfFleetAtRisk).toBeCloseTo(0.5049, 4);
    expect(concentrated.multiBookContracts).toHaveLength(1);
    expect(spread.multiBookContracts).toHaveLength(0);
  });
});

describe('gradeFleetConcentration — AC2: the underlying fold', () => {
  it('two strikes on one name are ONE bucket by underlying and TWO by contract', () => {
    const r = gradeFleetConcentration([
      book('v0nni', [row({ atRiskUsd: 154 })]),
      book('admin', [row({ optionSymbol: NVTS_15C, atRiskUsd: 151 })]),
    ]);
    // ⚠ An optionSymbol-only fold reads this as diversified. It is one bet on NVTS.
    expect(r.byContract.map(b => b.key).sort()).toEqual([NVTS, NVTS_15C]);
    expect(r.multiBookContracts).toHaveLength(0);
    const name = r.byUnderlying.find(b => b.key === 'NVTS');
    expect(name!.atRiskUsd).toBe(305);
    expect(name!.contracts).toBe(2);
    expect(name!.books).toEqual(['admin', 'v0nni']);
    expect(name!.distinctContracts).toBe(2);
    expect(name!.shareOfFleetAtRisk).toBe(1);
    expect(r.multiBookUnderlyings.map(b => b.key)).toEqual(['NVTS']);
    // The underlying fold spans expiries by design, so it carries no single one.
    expect(name!.expiration).toBeNull();
  });

  it('rolls the live tape to 3 names and keeps NVTS on top', () => {
    const r = gradeFleetConcentration(liveFleet());
    expect(r.byUnderlying.map(b => b.key)).toEqual(['NVTS', 'XLF', 'BAC']);
    expect(r.maxUnderlying!.key).toBe('NVTS');
    expect(r.maxUnderlying!.atRiskUsd).toBe(305);
  });
});

describe('gradeFleetConcentration — AC3: the denominator, and unambiguous zeros', () => {
  it('names the gate that owns the population and reports checked vs evaluated', () => {
    const r = gradeFleetConcentration(liveFleet());
    expect(r.populationGate).toBe('liveEntryGateOpen');
    expect(r.populationOwner).toContain('getLiveOtmFleetCapitalRow');
    expect(r.booksChecked).toBe(4);   // everything the provider offered
    expect(r.booksEvaluated).toBe(2); // what the gate admitted
    expect(r.positionsChecked).toBe(4);
    expect(r.positionsEvaluated).toBe(4);
    expect(r.booksBlind).toBe(0);
  });

  it('a gate-CLOSED book holding rows never reaches the denominator', () => {
    const r = gradeFleetConcentration([
      book('admin', [row({ atRiskUsd: 151 })]),
      book('Richard', [row({ atRiskUsd: 9_999 })], false),
    ]);
    expect(r.booksChecked).toBe(2);
    expect(r.booksEvaluated).toBe(1);
    expect(r.fleetAtRiskUsd).toBe(151);
    expect(r.maxContract!.shareOfFleetAtRisk).toBe(1);
  });

  it('UNWIRED, EMPTY and MEASURED-with-no-concentration are three different readings', () => {
    const unwired = gradeFleetConcentration(null);
    expect(unwired.status).toBe('unwired');
    expect(unwired.maxContract).toBeNull();
    expect(unwired.booksEvaluated).toBe(0);
    expect(unwired.reason).toContain('NOT a reading of zero concentration');

    const empty = gradeFleetConcentration([book('admin', []), book('v0nni', [])]);
    expect(empty.status).toBe('empty');
    expect(empty.booksEvaluated).toBe(2); // the gate DID admit books
    expect(empty.positionsChecked).toBe(0);
    expect(empty.maxContract).toBeNull(); // never a synthetic zero bucket
    expect(empty.fleetAtRiskUsd).toBe(0);

    const flat = gradeFleetConcentration([
      book('admin', [row({ atRiskUsd: 151 })]),
      book('v0nni', [row({
        optionSymbol: 'SPY261002C00700000', symbol: 'SPY', expiration: '2026-10-02', atRiskUsd: 151,
      })]),
    ]);
    expect(flat.status).toBe('measured');
    expect(flat.multiBookContracts).toHaveLength(0); // no concentration ACROSS books
    expect(flat.maxContract!.atRiskUsd).toBe(151);

    // The three must not share a byte on the field a reader would grade.
    expect(new Set([unwired.status, empty.status, flat.status]).size).toBe(3);
  });

  it('a share against an empty denominator is null, never 0', () => {
    const r = gradeFleetConcentration([book('admin', [row({ atRiskUsd: 0, priced: true })])]);
    expect(r.fleetAtRiskUsd).toBe(0);
    expect(r.byContract[0]!.shareOfFleetAtRisk).toBeNull();
  });
});

describe('gradeFleetConcentration — AC4: advisory', () => {
  it('says so on the wire rather than leaving it to be inferred', () => {
    for (const r of [gradeFleetConcentration(null), gradeFleetConcentration(liveFleet())]) {
      expect(r.entryPathBehavior).toBe('advisory_no_refusal');
      expect(r.refuses).toBe(false);
    }
    expect(gradeFleetConcentration(liveFleet()).reason).toContain('ADVISORY');
  });
});

describe('gradeFleetConcentration — refusals never share a column with findings', () => {
  it('a BLIND book is not an empty book, and it makes the reading a lower bound', () => {
    const r = gradeFleetConcentration([
      book('admin', [row({ atRiskUsd: 151 })]),
      book('v0nni', null),
    ]);
    expect(r.booksEvaluated).toBe(2);
    expect(r.booksBlind).toBe(1);
    expect(r.blindBooks).toEqual(['v0nni']);
    expect(r.concentrationIsLowerBound).toBe(true);
    // …and the dollars it could not read are NOT in the total.
    expect(r.fleetAtRiskUsd).toBe(151);
  });

  it('an UNPRICED row is counted, never bucketed, and flags the lower bound', () => {
    const r = gradeFleetConcentration([
      book('admin', [row({ atRiskUsd: 151 }), row({ priced: false, atRiskUsd: 0, contracts: 0 })]),
    ]);
    expect(r.positionsChecked).toBe(2);
    expect(r.positionsEvaluated).toBe(1);
    expect(r.unpricedRows).toBe(1);
    expect(r.byContract[0]!.rows).toBe(1);
    expect(r.concentrationIsLowerBound).toBe(true);
  });

  it('an UNKEYED (multi-leg) row dilutes every share, and says so', () => {
    const r = gradeFleetConcentration([
      book('admin', [row({ atRiskUsd: 151 })]),
      book('v0nni', [row({ optionSymbol: null, symbol: null, atRiskUsd: 100 })]),
    ]);
    expect(r.fleetAtRiskUsd).toBe(251); // its dollars ARE fleet risk
    expect(r.unkeyedContractRows).toBe(1);
    expect(r.unkeyedContractAtRiskUsd).toBe(100);
    expect(r.unkeyedUnderlyingRows).toBe(1);
    expect(r.byContract).toHaveLength(1); // and are in NO bucket
    expect(r.byContract[0]!.shareOfFleetAtRisk).toBeCloseTo(0.6016, 4);
    expect(r.concentrationIsLowerBound).toBe(true);
  });

  it('a NaN at-risk lands in the refusing branch and cannot poison the fleet total', () => {
    // `x <= 0` admits NaN; `!(x > 0)` does not (TRA-3486). One NaN here would
    // make `fleetAtRiskUsd` NaN and every share NaN, and it would read as a
    // number until something compared it.
    const r = gradeFleetConcentration([
      book('admin', [row({ atRiskUsd: 151 }), row({ atRiskUsd: Number.NaN })]),
    ]);
    expect(Number.isFinite(r.fleetAtRiskUsd)).toBe(true);
    expect(r.fleetAtRiskUsd).toBe(151);
    expect(r.unpricedRows).toBe(1);
  });
});

describe('the concentration fold and the ENFORCED fold read the same dollars', () => {
  // ⭐ The invariant that makes `fleetConcentration.fleetAtRiskUsd` comparable
  // to `aggregateFleetBound.fleetAtRiskUsd` instead of being a second number
  // wearing the same units. It holds by construction — both go through
  // `rowOpenPremiumAtRisk` — and this is the control that keeps it true.
  function livePos(over: Partial<OptionPosition> = {}): OptionPosition {
    return {
      id: 'p1',
      symbol: 'NVTS',
      optionSymbol: NVTS,
      optionType: 'call',
      strike: 12.5,
      expiration: '2026-10-02',
      contracts: 1,
      contractsRemaining: 1,
      premiumPaid: 1.51,
      currentPremium: 1.51,
      tp1Premium: 1.8875,
      tp1Hit: false,
      stopLossPremium: 1.208,
      peakPremium: 1.51,
      trailingActive: false,
      trailingStopPremium: 1.33,
      underlyingEntryPrice: 11.8,
      openedAt: Date.parse('2026-08-24T14:44:34.991Z'),
      signalId: 'sig-3979',
      signalType: 'otm_mispricing',
      mode: 'live',
      ...over,
    } as OptionPosition;
  }

  function acctWith(positions: OptionPosition[]): PaperOptionsAccount {
    const acct = new PaperOptionsAccount({ initialEquity: 1_017.21, tradierEnv: 'production' });
    acct.importSnapshot({
      openOptions: positions,
      closedOptions: [],
      optionsPnl: 0,
      dailyCount: 0,
      currentDayKey: '2026-08-24',
      cash: 1_017.21,
      equity: 1_017.21,
    });
    return acct;
  }

  it('Σ concentrationRowsForMode(live).atRiskUsd === openPremiumAtRiskForMode(live).usd', () => {
    const positions = [
      livePos(),
      livePos({ id: 'p2', premiumPaid: 1.54, currentPremium: 1.54 }),
      livePos({
        id: 'p3', symbol: 'XLF', optionSymbol: 'XLF260925C00057500', strike: 57.5,
        expiration: '2026-09-25', contracts: 2, contractsRemaining: 2, premiumPaid: 0.425,
      }),
      // A demo row: real on the book, NOT fleet risk. Must appear in neither.
      livePos({ id: 'p4', mode: 'demo', premiumPaid: 9.99 }),
      // An unpriced row: $0 to both folds, counted by both.
      livePos({ id: 'p5', premiumPaid: 0 }),
    ];
    const acct = acctWith(positions);
    const enforced = acct.openPremiumAtRiskForMode('live');
    const rows = acct.concentrationRowsForMode('live');
    const summed = rows.reduce((s, r) => s + r.atRiskUsd, 0);
    expect(Math.round(summed * 100) / 100).toBe(enforced.usd);
    expect(rows.filter(r => !r.priced)).toHaveLength(enforced.unpricedRows);
    expect(rows).toHaveLength(4); // 5 positions, 1 demo

    const report = gradeFleetConcentration([book('admin', rows)]);
    expect(report.fleetAtRiskUsd).toBe(enforced.usd);
    expect(report.byContract.find(b => b.key === NVTS)!.atRiskUsd).toBe(305);
  });

  it('and the same holds against the bare fold, so neither reader can drift alone', () => {
    const positions = [livePos(), livePos({ id: 'p2', premiumPaid: 1.54 })];
    const bare = foldOpenPremiumAtRisk(positions, false, () => null);
    const rows = acctWith(positions).concentrationRowsForMode('live');
    expect(Math.round(rows.reduce((s, r) => s + r.atRiskUsd, 0) * 100) / 100).toBe(bare.usd);
    expect(bare.usd).toBe(305);
  });
});
