// TRA-3933 — the reconciler MINTs a phantom TWIN when it adopts a residual lot
// AFTER the engine's own row on that OCC has already closed.
//
// ── The measured incident (bqb1, BAC260925C00063000) ─────────────────────────
//
// Reconstructed from the live journal (`/api/health/option-journal?rows=all`)
// and the Render log tape, both re-runnable:
//   `node scripts/tra3933-mint-branch-probe.mjs`      (which branch minted)
//   `node scripts/tra3933-duplicate-close-census.mjs` (how many rows like it)
//
//   2026-08-20T13:36:22.482Z  engine buys 1 ct @ 1.65 (order 142603649).
//                             Journal row A `0e180e8c` single_leg_otm, OPEN.
//   2026-08-20T19:36Z         the DESK buys 1 ct @ 1.17 (order 142769192) on the
//                             SAME OCC, outside this engine.
//   2026-08-20T20:52Z →       every reconcile logs the TRA-3890 refusal
//                             (engine 1 ct vs broker 2 ct, blend 1.41). 1521 lines.
//   2026-08-21T17:05:10.473Z  the engine exits ITS contract. Row A closes,
//                             `chandelier_restarted`, realized −$74.
//   2026-08-21T17:06:09.831Z  ~59 s later the next reconcile sees ONE broker
//                             contract — the desk's residual — and no book row
//                             on that OCC. It takes the `added` branch and mints
//                             journal row B `6bbc5d17` `tradier_import`.
//
// Row B is stamped from the broker's OCC-level aggregate, so it inherits the
// FIRST lot's identity: `openedAt = incoming.acquiredAt` = 13:36:22.761Z — 279 ms
// from row A's openTs — and `premiumPaid` = the 1.41 BLEND (later restated to the
// desk's true 1.17 by the operator under TRA-3958). The TRA-3472 reconstruction
// then landed the ENGINE's exit millisecond and the ENGINE's −$74 onto it, and
// every journal fold has been reading one close as two ever since.
//
// ── Which of the four branches wrote it, and why that decides the fix ────────
//
// `queueJournalImportOpen` has four terminating branches. Established by
// elimination on the log tape with all three reader controls passing:
//   • OWN-ROW identity — writes nothing, so it cannot be the author of a row;
//   • no-`optionSymbol` mint — row B CARRIES an `optionSymbol`;
//   • AMBIGUOUS (adoptable > 1) — logs a warn; fired 0× on this OCC;
//   • ADOPT (adoptable === 1) — logs an info; fired 0× on this OCC.
// ⇒ the ZERO-ADOPTABLE fall-through, which is SILENT.
//
// And it is zero-adoptable for a structural reason, not a matching one:
// `findOpenOptionTradeJournalRecordsByOptionSymbol` returns only rows whose
// outcome is still OPEN, and row A had closed 59 seconds earlier. As the ticket
// put it — a reconcile that runs after the close has no OPEN row to adopt and
// will mint every time. So the remedy is ORDERING/lifecycle, not the adopt rule.
//
// ── What each leg is for ─────────────────────────────────────────────────────
//
// `reaches the mint` is a CHARACTERIZATION test: it passes today and pins the
// branch, so a future refactor that moves the mint somewhere else has to say so.
// `does not manufacture a phantom twin` is the DEFECT and FAILS on this build.
//
// The failing assertion is deliberately remedy-agnostic. It does not require the
// mint to be refused, or re-stamped, or tombstoned — only that the reconciler
// must not leave two journal rows on one `mode|optionSymbol` that a reader
// joining on entry identity cannot tell apart. Refusing the mint, stamping the
// residual lot's own fill time, or marking the row all satisfy it.
//
// Negative control, run 2026-08-26 before this landed: relaxing the 1000 ms
// threshold to −1 (so the assertion can no longer fail) turns the `it.fails` leg
// RED. The ratchet is therefore armed, not decorative.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import { PaperOptionsAccount } from './options-account.js';
import {
  listOptionTradeJournal,
  setOptionTradeJournalFileForTests,
  TRADIER_IMPORT_STRUCTURE,
} from './option-trade-journal.js';
import type { RelativeValueSignal } from '@trading-app/shared';
import type { TradierOpenOptionPosition } from '@trading-app/engine';

const OCC = 'BAC260925C00063000';
/** 2026-08-20T13:36:22.482Z — the engine's fill, to the millisecond. */
const ENGINE_OPEN = Date.parse('2026-08-20T13:36:22.482Z');
/** The broker's `date_acquired` for the OCC: 279 ms later, and it never moves. */
const BROKER_ACQUIRED = ENGINE_OPEN + 279;
/** 2026-08-20T19:36Z — when the DESK actually bought its contract. */
const DESK_OPEN = Date.parse('2026-08-20T19:36:00.000Z');
/** 2026-08-21T17:05:10.473Z — the engine's exit. */
const ENGINE_CLOSE = Date.parse('2026-08-21T17:05:10.473Z');

/** The engine's ask-limit fill. The row's at-risk is booked off the MARK below. */
const ENGINE_PREMIUM = 1.65;
/** The desk's true basis: (282 − 165) / (2 − 1), order 142769192, TRA-3958. */
const DESK_PREMIUM = 1.17;
/**
 * What Tradier reports for the 2-lot OCC — the blend, verbatim off the tape
 * (`brokerBlendedPremium: 1.41`), not re-derived here. A fixture that recomputes
 * the broker's number from its own inputs stops being able to disagree with it.
 */
const BLEND = 1.41;
/**
 * The engine's fill-time mark, which is what `atRiskUsd` is booked from — the
 * live row carries `atRiskUsd: 151`, i.e. one contract at 1.51.
 */
const ENGINE_MARK = 1.51;
/**
 * Sized so the RV path buys exactly ONE contract, as it did on the day. The
 * budget is a fraction of equity, so this is the knob that controls the count;
 * at 50k it sizes 3 and the fixture stops being the incident.
 */
const EQUITY = 20_000;

/**
 * Tradier's `/positions` is ONE row per OCC. Quantity is the LOT SUM, price is
 * the LOT BLEND, and `date_acquired` describes whichever lot the broker chose —
 * on the incident, the first. That aggregation is the whole reason the residual
 * lot cannot be identified from this payload alone.
 */
function brokerRow(contracts: number, premiumPaid: number): TradierOpenOptionPosition {
  return {
    optionSymbol: OCC,
    underlying: 'BAC',
    optionType: 'call',
    strike: 63,
    expiration: '2026-09-25',
    contracts,
    premiumPaid,
    acquiredAt: BROKER_ACQUIRED,
  };
}

function engineSignal(): RelativeValueSignal {
  return {
    id: 'rv-3933',
    symbol: 'BAC',
    type: 'relative_value',
    side: 'buy',
    entryPrice: ENGINE_PREMIUM,
    stopLoss: 1.32,
    takeProfit: 2.475,
    riskRewardRatio: 2,
    timestamp: ENGINE_OPEN,
    optionSymbol: OCC,
    optionType: 'call',
    strike: 63,
    expiration: '2026-09-25',
    mark: ENGINE_MARK,
    fairPrice: 1.9,
    mispricingPct: -0.2,
    zScore: -2.1,
    ivFitted: 0.25,
    ivUsed: 0.22,
    delta: 0.5277755827232543,
    reason: 'TRA-3933 fixture',
  };
}

const SETUP = {
  ivRank: null,
  trend: 'sideways' as const,
  sentiment: null,
  riskThrottleMultiplier: 1,
  riskThrottleDecided: 1,
  riskThrottleSizingPath: 'options_single_leg' as const,
};

let tmpFile: string;
let fileCounter = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(ENGINE_OPEN);
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  tmpFile = join(tmpdir(), `tra3933-journal-${process.pid}-${fileCounter++}.jsonl`);
  setOptionTradeJournalFileForTests(tmpFile);
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

/**
 * The incident's lifecycle, up to and including the reconcile that minted:
 * engine opens 1 → desk adds 1 outside us → engine exits its own → the next
 * reconcile sees the desk's residual and no book row on the OCC.
 */
async function runIncidentLifecycle(): Promise<{
  acct: PaperOptionsAccount;
  engineJournalId: string;
}> {
  const acct = new PaperOptionsAccount({ initialEquity: EQUITY, tradierEnv: 'sandbox' });

  const pos = acct.openOptionFromRvCandidate(engineSignal(), 'live', undefined, undefined, SETUP);
  expect(pos).not.toBeNull();
  const engineJournalId = pos!.id;
  await acct.flushOptionTradeJournal();

  // The desk's contract arrives. The engine row is `existing` and not imported,
  // so this is the TRA-3890 refusal path: nothing is minted, nothing is copied.
  vi.setSystemTime(DESK_OPEN);
  acct.reconcileTradierPositions([brokerRow(2, BLEND)], 'live');
  await acct.flushOptionTradeJournal();
  expect(await listOptionTradeJournal()).toHaveLength(1);

  // The engine exits ITS contract. Row A closes; the book row goes away.
  vi.setSystemTime(ENGINE_CLOSE);
  expect(acct.closeOption(engineJournalId, 0.91, 'chandelier_restarted')).not.toBeNull();
  await acct.flushOptionTradeJournal();
  const afterClose = await listOptionTradeJournal();
  expect(afterClose).toHaveLength(1);
  expect(afterClose[0]!.outcome).not.toBe('OPEN');

  // 59 seconds later: the broker still holds the desk's contract, and there is
  // no book row on this OCC any more.
  vi.setSystemTime(ENGINE_CLOSE + 59_000);
  acct.reconcileTradierPositions([brokerRow(1, BLEND)], 'live');
  await acct.flushOptionTradeJournal();

  return { acct, engineJournalId };
}

describe('TRA-3933 — the reconcile mint after the engine row has closed', () => {
  // CHARACTERIZATION. Passes on this build; it exists to pin WHICH branch runs,
  // because the four branches have four different remedies.
  it('reaches the zero-adoptable MINT, not ADOPT — the OPEN row it needed was already closed', async () => {
    const { engineJournalId } = await runIncidentLifecycle();

    const rows = await listOptionTradeJournal();
    const minted = rows.filter(r => r.id !== engineJournalId);
    expect(minted).toHaveLength(1);
    // A mint, by its structure — the ADOPT branch writes no row at all, and the
    // OWN-ROW branch resolves to identity.
    expect(minted[0]!.structure).toBe(TRADIER_IMPORT_STRUCTURE);
    // And the row it "should" have adopted was not adoptable: it had closed.
    expect(rows.find(r => r.id === engineJournalId)!.outcome).not.toBe('OPEN');
  });

  // ── THE DEFECT ─────────────────────────────────────────────────────────────
  // `it.fails` — the first use of it in this repo, so it is worth saying why.
  //
  // AC4 asks for a test that FAILS on the current code, because a suite that only
  // pins the post-fix answer cannot show the mint was ever reachable. Landing a
  // plainly red `it` would do that, and would also redden `main` for everyone
  // until the fix ships — which gets a test deleted, not fixed.
  //
  // `it.fails` asserts THE DEFECT IS STILL PRESENT. It is green today for exactly
  // the reason the ticket is open, and it turns RED the moment the behaviour
  // changes — including if someone half-fixes it — naming this file. Whoever
  // lands the remedy flips these two back to `it`, and that flip is the AC4
  // evidence: the same assertion, unedited, failing before and passing after.
  //
  // ⚠️ Do NOT "repair" a red `it.fails` here by loosening the assertion. Red here
  // means the mint behaviour moved; either the fix landed (flip to `it`) or
  // something else changed it (which is the finding).
  it.fails('does not manufacture a phantom twin of the row it just closed', async () => {
    const { engineJournalId } = await runIncidentLifecycle();

    const rows = await listOptionTradeJournal();
    const engineRow = rows.find(r => r.id === engineJournalId)!;
    const minted = rows.filter(r => r.id !== engineJournalId);
    if (minted.length === 0) return; // a fix that refuses the mint satisfies this

    // The desk bought its contract ~6 hours after the engine bought its own. A
    // row stamped within a second of a lot this engine has already closed is
    // describing that closed lot, not the one the broker is still reporting —
    // and it is indistinguishable from it to every reader that joins on entry
    // identity. That is what turned one close into two records.
    for (const row of minted) {
      expect(
        Math.abs(row.openTs - engineRow.openTs),
        `minted row ${row.id} carries openTs ${row.openTs}, ${Math.abs(row.openTs - engineRow.openTs)} ms `
        + `from the CLOSED engine row ${engineRow.id} on the same contract — it has inherited the `
        + 'identity of a lot that is gone, which is TRA-3933',
      ).toBeGreaterThan(1_000);
    }
  });

  // The same defect measured on the MONEY rather than on the identity, and it is
  // a separate leg on purpose: a fix that only re-stamps `openTs` would turn the
  // leg above green while leaving `realizedR` computed against a basis no single
  // lot ever paid (the two-lot blend, 141 — the desk actually paid 117). Same
  // `it.fails` contract as above.
  it.fails('does not price the residual lot at the two-lot blend', async () => {
    const { engineJournalId } = await runIncidentLifecycle();

    const rows = await listOptionTradeJournal();
    const minted = rows.filter(r => r.id !== engineJournalId);
    if (minted.length === 0) return;

    for (const row of minted) {
      expect(
        row.atRiskUsd,
        `minted row ${row.id} priced at the blend ${BLEND} × 100 = ${BLEND * 100}; the desk lot `
        + `actually paid ${DESK_PREMIUM} (operator restatement, TRA-3958)`,
      ).not.toBeCloseTo(BLEND * 100, 5);
    }
  });
});
