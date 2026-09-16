// TRA-4609 — the journal OPEN row's `contracts` / `atRiskUsd` were frozen at the
// mint and never amended by a conviction-DCA add (TRA-964), so
// `realizedR = realizedPnlUsd / atRiskUsd` divided an ALL-LOTS P&L by
// MINTED-LOTS capital and premium R came out overstated by
// `totalContracts / mintContracts`.
//
// ── The measured cohort (prod bqb1, pin `f8f7b1855da0`, 2026-09-16) ──────────
//
// `GET /api/health/option-journal?closedSinceTs=1788466402000&rows=all` joined
// to `GET /api/health/conviction-dca` on `recent[].positionId == row.id`:
// 12 closed demo/desk rows, `integrity.corruptLines` 0. **8 of 12 carried an add
// and every one was overstated**; 3 had no add and were exact; 1 (NVTS) had
// pnl 0. Seven of the eight were 1 ct → 2 ct, i.e. exactly 2x.
//
//   symbol  rowCtr -> trueCtr   R served   R true    atRiskUsd served -> true
//   SOFI     1 -> 2              -0.2113   -0.1049    97.00 -> 195.50   ← the rig below
//   SIRI     1 -> 2               0.1975    0.0979   123.50 -> 249.22
//   NOK      2 -> 3               0.1653    0.1088   136.00 -> 206.50
//   XLF      1 -> 2              -0.1617   -0.0804   119.50 -> 240.33
//
// ── Why no existing check caught it ─────────────────────────────────────────
//
// `atRiskUsd == contracts · 100 · entryMarkUsd` and
// `realizedR == realizedPnlUsd / atRiskUsd` both held on 12/12 rows, BECAUSE all
// three quantities derive from the same frozen `contracts`. They are internally
// consistent and externally wrong together, so that identity cannot detect this
// defect by construction. The `IDENTITY` test at the bottom pins that reasoning
// so nobody re-adopts it as a control.
//
// Worse, 2 of the 8 published no marker at all: when the add fills at the mint
// price (`XLF 1.13 + 1 @ 1.13`) the blend is a no-op, so
// `entryBasisPremium == entryMarkUsd` and `stopBasisRPerPremiumR == 4.000`
// exactly — indistinguishable from a never-added row. `NO MARKER` below is that
// case, and it is the one `convictionAdds` exists for.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import { PaperOptionsAccount } from './options-account.js';
import {
  listOptionTradeJournal,
  setOptionTradeJournalFileForTests,
  recordOptionTradeOpen,
  recordOptionTradeClose,
  recordOptionTradeConvictionAdd,
  getOptionTradeConvictionAdds,
  getOptionTradeJournalRecord,
  type OptionTradeJournalRecord,
} from './option-trade-journal.js';
import type { OptionPosition } from '@trading-app/shared';

const OCC = 'SOFI260918C00030000';
const OPEN_TS = Date.parse('2026-09-15T14:02:11.000Z');
const ADD_TS = Date.parse('2026-09-15T17:41:03.000Z');
const CLOSE_TS = Date.parse('2026-09-16T15:20:44.000Z');

/** The rig, from the cohort's first SOFI row. */
const MINT_CONTRACTS = 1;
const MINT_PREMIUM = 0.97;
const MINT_AT_RISK = 97.0;
const ADD_CONTRACTS = 1;
const ADD_PREMIUM_USD = 98.5;
const TOTAL_AT_RISK = 195.5;
const REALIZED_PNL = -20.5;
/** What the row USED to publish: pnl ÷ the MINTED basis. */
const FROZEN_R = REALIZED_PNL / MINT_AT_RISK; // −0.21134…
/** What it publishes now: pnl ÷ capital actually committed. */
const TRUE_R = REALIZED_PNL / TOTAL_AT_RISK; // −0.10486…

let tmpFile: string;
let fileCounter = 0;

beforeEach(() => {
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  tmpFile = join(tmpdir(), `tra4609-journal-${process.pid}-${fileCounter++}.jsonl`);
  setOptionTradeJournalFileForTests(tmpFile);
});

afterEach(async () => {
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

async function seedMint(id = 'SOFI-1', over: Record<string, unknown> = {}): Promise<void> {
  expect(await recordOptionTradeOpen({
    id,
    openTs: OPEN_TS,
    symbol: 'SOFI',
    structure: 'single_leg_otm',
    mode: 'demo',
    ivRank: null,
    trend: 'up',
    sentiment: null,
    entryDelta: 0.31,
    entryDte: 3,
    atRiskUsd: MINT_AT_RISK,
    optionSymbol: OCC,
    contracts: MINT_CONTRACTS,
    entryMarkUsd: MINT_PREMIUM,
    ...over,
  } as Parameters<typeof recordOptionTradeOpen>[0])).toBe(true);
}

async function addOnce(id = 'SOFI-1', ts = ADD_TS): Promise<{ applied: boolean; refusal: unknown }> {
  return recordOptionTradeConvictionAdd(
    id,
    { addedContracts: ADD_CONTRACTS, addedPremiumUsd: ADD_PREMIUM_USD, contracts: MINT_CONTRACTS + ADD_CONTRACTS },
    { reason: 'conviction_dca_add', issue: 'TRA-4609' },
    ts,
  );
}

// ⚠️ `contractsAtClose` takes `null` for "the close stamped none", NOT
// `undefined`: a default parameter REPLACES an explicitly-passed `undefined`, so
// `closeRow(id, undefined)` would silently stamp the default and the
// pre-TRA-4609-close fixture would test nothing.
async function closeRow(id = 'SOFI-1', contractsAtClose: number | null = 2): Promise<void> {
  const rec = (await getOptionTradeJournalRecord(id))!;
  const realizedR = REALIZED_PNL / rec.atRiskUsd;
  expect(await recordOptionTradeClose(id, {
    closeTs: CLOSE_TS,
    outcome: realizedR > 0.05 ? 'WIN' : realizedR < -0.05 ? 'LOSS' : 'SCRATCH',
    realizedPnlUsd: REALIZED_PNL,
    realizedR,
    exitReason: 'time_stop',
    holdDays: (CLOSE_TS - OPEN_TS) / 86_400_000,
    ...(contractsAtClose === null ? {} : { contractsAtClose }),
  })).toBe('written');
}

async function row(id = 'SOFI-1'): Promise<OptionTradeJournalRecord> {
  const r = (await listOptionTradeJournal()).find((x) => x.id === id);
  expect(r).toBeDefined();
  return r!;
}

/** Drop the in-memory fold and rebuild it from the FILE alone. */
async function reload(): Promise<void> {
  setOptionTradeJournalFileForTests(tmpFile);
}

// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-4609 (1) — the add GROWS the OPEN row, and the close divides by committed capital', () => {
  it('amends contracts + atRiskUsd and publishes the mint figures it moved off', async () => {
    await seedMint();
    expect(await addOnce()).toEqual({ applied: true, refusal: null });

    const r = await row();
    expect(r.outcome).toBe('OPEN');
    expect(r.contracts).toBe(2);
    expect(r.atRiskUsd).toBeCloseTo(TOTAL_AT_RISK, 9);
    expect(r.convictionAdds).toEqual({
      adds: 1,
      mintContracts: MINT_CONTRACTS,
      mintAtRiskUsd: MINT_AT_RISK,
      addedContracts: ADD_CONTRACTS,
      addedPremiumUsd: ADD_PREMIUM_USD,
      firstAddTs: ADD_TS,
      lastAddTs: ADD_TS,
    });
    // The whole pre-add basis is kept beside the TRA-4028 amendments, so the
    // move is auditable from the row with no ledger join.
    expect(r.supersededOpenBasis).toHaveLength(1);
    expect(r.supersededOpenBasis![0]).toMatchObject({
      atRiskUsd: MINT_AT_RISK, realizedR: null, outcome: 'OPEN', issue: 'TRA-4609', reason: 'conviction_dca_add',
    });
  });

  it('THE DEFECT — the close R is now pnl ÷ committed, not pnl ÷ minted (the 2x)', async () => {
    await seedMint();
    await addOnce();
    await closeRow();

    const r = await row();
    expect(r.realizedR).toBeCloseTo(TRUE_R, 9);
    // ⚠️ The overstatement factor is the CAPITAL ratio `total/mint atRiskUsd`,
    // NOT the contract ratio TRA-4609's description quotes. The two coincide
    // only when the add fills at the mint price. Here 195.50/97.00 = 2.0155 on
    // a 1 → 2 add, and the cohort says the same thing: SOFI's own served/true
    // pair is 2.014, SIRI's is 2.017 against a contract ratio of 2, and NOK's
    // 2 → 3 row reads 1.518 against a contract ratio of 1.5. "2x" is the
    // headline, the capital ratio is the arithmetic.
    expect(FROZEN_R / r.realizedR!).toBeCloseTo(TOTAL_AT_RISK / MINT_AT_RISK, 9);
    expect(FROZEN_R / r.realizedR!).toBeCloseTo(2.0155, 4);
    expect(r.realizedR).toBeCloseTo(-0.1049, 4); // the cohort's published "true" figure
    // …and the OLD reading is still reconstructible from the row alone.
    expect(r.realizedPnlUsd! / r.convictionAdds!.mintAtRiskUsd).toBeCloseTo(FROZEN_R, 9);
  });

  it('the outcome bucket moves with it — a 2x error crosses the sleeve-cell bin edges', async () => {
    // The sleeve histogram edges sit exactly on −1.00R and −0.50R, so this is
    // not a cosmetic column: `outcomeForR` re-buckets.
    await seedMint('BIN', { atRiskUsd: 100 });
    expect(await recordOptionTradeConvictionAdd(
      'BIN', { addedContracts: 1, addedPremiumUsd: 100, contracts: 2 },
      { reason: 'conviction_dca_add', issue: 'TRA-4609' }, ADD_TS,
    )).toEqual({ applied: true, refusal: null });
    const rec = (await getOptionTradeJournalRecord('BIN'))!;
    expect(rec.atRiskUsd).toBe(200);
    // −$120 is −1.20R on the minted basis (past the −1.00R edge) and −0.60R on
    // the committed one.
    expect(-120 / rec.convictionAdds!.mintAtRiskUsd).toBeCloseTo(-1.2, 9);
    expect(-120 / rec.atRiskUsd).toBeCloseTo(-0.6, 9);
  });

  it('two adds: the MINT figures latch at the first and the totals accumulate', async () => {
    await seedMint();
    await addOnce();
    expect(await recordOptionTradeConvictionAdd(
      'SOFI-1', { addedContracts: 2, addedPremiumUsd: 210.5, contracts: 4 },
      { reason: 'conviction_dca_add', issue: 'TRA-4609' }, ADD_TS + 60_000,
    )).toEqual({ applied: true, refusal: null });

    const r = await row();
    expect(r.contracts).toBe(4);
    expect(r.atRiskUsd).toBeCloseTo(406.0, 9); // 97 + 98.5 + 210.5
    expect(r.convictionAdds).toMatchObject({
      adds: 2,
      mintContracts: MINT_CONTRACTS,
      mintAtRiskUsd: MINT_AT_RISK, // NOT 195.50 — the second add must not adopt the first's total as "the mint"
      addedContracts: 3,
      addedPremiumUsd: 309.0,
      firstAddTs: ADD_TS,
      lastAddTs: ADD_TS + 60_000,
    });
    expect(r.supersededOpenBasis).toHaveLength(2);
  });
});

describe('TRA-4609 (2) — the row is self-diagnosing from ONE surface', () => {
  it('NO MARKER — an add at the mint price leaves the blend a no-op, and only convictionAdds knows', async () => {
    // The XLF `1.13 + 1 @ 1.13` shape. `entryBasisPremium == entryMarkUsd` and
    // `stopBasisRPerPremiumR == 4.000` exactly, so every price-derived tell is
    // silent; the only other surface that knew was /api/health/conviction-dca,
    // a bounded ring, which is why a join against it is not durable evidence.
    await seedMint('XLF', { atRiskUsd: 113, contracts: 1, entryMarkUsd: 1.13, symbol: 'XLF' });
    expect(await recordOptionTradeConvictionAdd(
      'XLF', { addedContracts: 1, addedPremiumUsd: 113, contracts: 2 },
      { reason: 'conviction_dca_add', issue: 'TRA-4609' }, ADD_TS,
    )).toEqual({ applied: true, refusal: null });
    const r = await row('XLF');
    // The price columns are byte-identical to a never-added row…
    expect(r.entryMarkUsd).toBe(1.13);
    // …and the row still says, unambiguously, that it was added to.
    expect(r.convictionAdds).toMatchObject({ adds: 1, addedContracts: 1, mintContracts: 1 });
    expect(r.contracts).toBe(2);
  });

  it('IDENTITY — `atRiskUsd == contracts·100·entryMarkUsd` now FAILS on an added row, by design', async () => {
    await seedMint();
    await addOnce();
    const r = await row();
    // Pre-TRA-4609 this identity held on 12/12 rows INCLUDING the 8 wrong ones,
    // because all three sides derived from the same frozen `contracts`. It was
    // never a control on this defect; it is now a DETECTOR of one, and
    // `convictionAdds` is what says the failure was intentional.
    expect(r.contracts! * 100 * r.entryMarkUsd!).not.toBeCloseTo(r.atRiskUsd, 2);
    expect(r.convictionAdds).toBeDefined();
    // CONTROL — on a row with no add the identity still holds exactly.
    await seedMint('NOADD', { atRiskUsd: 97, contracts: 1, entryMarkUsd: 0.97 });
    const clean = await row('NOADD');
    expect(clean.contracts! * 100 * clean.entryMarkUsd!).toBeCloseTo(clean.atRiskUsd, 9);
    expect(clean.convictionAdds).toBeUndefined();
  });

  it('contractsAtClose stamps the size that SETTLED, and is absent when the close did not stamp one', async () => {
    await seedMint();
    await addOnce();
    await closeRow();
    expect((await row()).contractsAtClose).toBe(2);

    await seedMint('LEGACY');
    await closeRow('LEGACY', null);
    expect((await row('LEGACY')).contractsAtClose).toBeUndefined();
  });
});

describe('TRA-4609 (3) — refusals are WITNESSED, never swallowed', () => {
  it('an add to a CLOSED row is refused and changes nothing on the row', async () => {
    await seedMint();
    await closeRow('SOFI-1', 1); // closes on the MINTED basis
    const before = await row();

    expect(await addOnce()).toEqual({ applied: false, refusal: 'already_closed' });

    const after = await row();
    expect(after.atRiskUsd).toBe(before.atRiskUsd);
    expect(after.contracts).toBe(before.contracts);
    expect(after.realizedR).toBe(before.realizedR);
    expect(after.convictionAdds).toBeUndefined();

    const w = getOptionTradeConvictionAdds();
    expect(w.refused).toBe(1);
    expect(w.applied).toBe(0);
    expect(w.recent.at(-1)).toMatchObject({
      id: 'SOFI-1', applied: false, refusal: 'already_closed', mode: 'demo', symbol: 'SOFI',
      addedContracts: ADD_CONTRACTS, addedPremiumUsd: ADD_PREMIUM_USD,
      contractsAfter: null, atRiskUsdAfter: null,
    });
  });

  it('an unknown id never resurrects a row; a malformed figure is refused by name', async () => {
    expect(await addOnce('ghost')).toEqual({ applied: false, refusal: 'unknown_row' });
    expect(await listOptionTradeJournal()).toHaveLength(0);

    await seedMint();
    expect(await recordOptionTradeConvictionAdd(
      'SOFI-1', { addedContracts: 0, addedPremiumUsd: 98.5, contracts: 2 },
      { reason: 'conviction_dca_add', issue: 'TRA-4609' }, ADD_TS,
    )).toEqual({ applied: false, refusal: 'malformed' });
    expect((await row()).atRiskUsd).toBe(MINT_AT_RISK);

    expect(getOptionTradeConvictionAdds().recent.map((r) => r.refusal)).toEqual(['unknown_row', 'malformed']);
  });

  it('a REFUSED add appends nothing, so a cold load does not re-refuse it', async () => {
    await seedMint();
    await closeRow('SOFI-1', 1);
    await addOnce();
    expect(getOptionTradeConvictionAdds().refused).toBe(1);

    await reload();
    await listOptionTradeJournal();
    expect(getOptionTradeConvictionAdds().total).toBe(0);
  });
});

describe('TRA-4609 (4) — the amendment is DURABLE: a cold replay rebuilds it', () => {
  it('the row and the witness survive a reload from the file alone', async () => {
    await seedMint();
    await addOnce();
    await closeRow();
    const before = await row();

    await reload();
    const after = await row();

    expect(after.contracts).toBe(2);
    expect(after.atRiskUsd).toBeCloseTo(TOTAL_AT_RISK, 9);
    expect(after.realizedR).toBeCloseTo(TRUE_R, 9);
    expect(after.contractsAtClose).toBe(2);
    expect(after.convictionAdds).toEqual(before.convictionAdds);
    expect(after.supersededOpenBasis).toEqual(before.supersededOpenBasis);

    const w = getOptionTradeConvictionAdds();
    expect(w.applied).toBe(1);
    expect(w.refused).toBe(0);
    expect(w.recent[0]).toMatchObject({
      id: 'SOFI-1', applied: true, refusal: null,
      contractsBefore: 1, contractsAfter: 2,
      atRiskUsdBefore: MINT_AT_RISK, atRiskUsdAfter: TOTAL_AT_RISK,
    });
  });
});

describe('TRA-4609 (5) — the ENGINE path: addToOptionPosition tells the journal', () => {
  const ID = 'ENG-1';

  function position(over: Partial<OptionPosition> = {}): OptionPosition {
    return {
      id: ID,
      symbol: 'SOFI',
      optionSymbol: OCC,
      optionType: 'call',
      strike: 30,
      expiration: '2026-09-18',
      contracts: MINT_CONTRACTS,
      contractsRemaining: MINT_CONTRACTS,
      premiumPaid: MINT_PREMIUM,
      currentPremium: MINT_PREMIUM,
      tp1Premium: Number.POSITIVE_INFINITY,
      tp1Hit: false,
      stopLossPremium: MINT_PREMIUM * 0.8,
      peakPremium: MINT_PREMIUM,
      trailingActive: false,
      underlyingEntryPrice: 30,
      openedAt: OPEN_TS,
      signalId: 'tra4609-fixture',
      signalType: 'single_leg_otm',
      mode: 'demo',
      ...over,
    } as OptionPosition;
  }

  function book(): PaperOptionsAccount {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    acct.importSnapshot({
      openOptions: [position()], closedOptions: [], optionsPnl: 0, dailyCount: 0,
      currentDayKey: '2026-09-15', cash: 50_000, equity: 50_000,
    });
    return acct;
  }

  it('a book add amends the row it will later be closed against', async () => {
    await seedMint(ID);
    const acct = book();

    const updated = acct.addToOptionPosition(ID, ADD_CONTRACTS, ADD_PREMIUM_USD);
    expect(updated!.contracts).toBe(2);
    await acct.flushOptionTradeJournal();

    const r = await row(ID);
    expect(r.contracts).toBe(2);
    expect(r.atRiskUsd).toBeCloseTo(TOTAL_AT_RISK, 9);
    expect(r.convictionAdds).toMatchObject({ adds: 1, addedContracts: 1, addedPremiumUsd: ADD_PREMIUM_USD });
    // The book's own premium-at-risk and the journal's agree after the add —
    // the thing that was NOT true before this ticket.
    expect(updated!.premiumPaid * 100 * updated!.contracts).toBeCloseTo(r.atRiskUsd, 6);
  });

  it('a refused BOOK add (cash) writes no journal line — the two never diverge', async () => {
    await seedMint(ID);
    const acct = book();
    expect(acct.addToOptionPosition(ID, 10_000, 100)).toBeNull();
    await acct.flushOptionTradeJournal();

    expect((await row(ID)).atRiskUsd).toBe(MINT_AT_RISK);
    expect((await row(ID)).convictionAdds).toBeUndefined();
    expect(getOptionTradeConvictionAdds().total).toBe(0);
  });

  it('the CLOSE path stamps contractsAtClose off the post-add size', async () => {
    await seedMint(ID);
    const acct = book();
    acct.addToOptionPosition(ID, ADD_CONTRACTS, ADD_PREMIUM_USD);
    const closed = acct.closeOption(ID, 0.87, 'time_stop');
    expect(closed).not.toBeNull();
    await acct.flushOptionTradeJournal();

    const r = await row(ID);
    expect(r.outcome).not.toBe('OPEN');
    expect(r.contractsAtClose).toBe(2);
    // …and the R it published divides by the grown basis, not the mint's.
    expect(r.realizedR).toBeCloseTo(r.realizedPnlUsd! / TOTAL_AT_RISK, 9);
  });
});
