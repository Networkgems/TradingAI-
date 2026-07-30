import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PaperAccount } from './paper-account.js';
import { PnlTracker } from './pnl-tracker.js';
import { toDurableAccountSnapshot, restoreDurableAccountSnapshot } from './trade-store.js';
import type { StocksTradeSnapshot } from './trade-store.js';

/**
 * TRA-2629 — `optionsCredited` must survive the durability seam.
 *
 * TRA-2323 routed realized option P&L into `PaperAccount` equity and kept the
 * reconciliation identity intact by having the EOD writer recover the STOCK-only
 * leg as
 *
 *     dailyPnl = (equity − openingEquity) − (credited_now − credited_on_last_row)
 *
 * That is exact ONLY while both endpoints of the subtraction survive a restart.
 * They did not. `PaperAccountSnapshot.optionsCredited` was added, but the durable
 * `StocksTradeSnapshot.account` type and the two hand-written literals in
 * `user-context.ts` never carried it — so `importSnapshot`'s `?? 0` fired on
 * every boot. `equity` came back holding the option credits; the counter that
 * exists to cancel them came back 0. bqb1 restarts several times an hour, so
 * every session lost its left endpoint and the writer put the PREVIOUS session's
 * option credit into the stock leg.
 *
 * Measured on live prod 2026-07-30T03:52Z — `stockDaily == prior session
 * optionsDaily` to the cent on 13 books / 18 sessions, on exactly the two
 * sessions after the fix shipped and none of the 15 before it. The clean
 * discriminator was `ctoverify_tra2331`, reproduced verbatim below: 07-29 had
 * `journalCloses: 0` and source `journal` (never touched by the TRA-2314 repair)
 * yet still read `stockDaily 765.00` — the prior day's `optionsDaily`. Nothing
 * about the repair backfill can produce that; only a zeroed counter can.
 */

const OPENING_EQUITY = 2_000;
/** `ctoverify_tra2331`'s single 2026-07-28 option close, to the cent. */
const CREDIT_765 = 765;

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'tra2629-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * The EOD writer's stock-leg recovery, verbatim from `generateAndSaveReport`
 * (`index.ts`). Kept as one expression so the test measures the production
 * formula rather than a paraphrase of it.
 */
function writeEodRow(tracker: PnlTracker, account: PaperAccount, date: string): number {
  const equity = account.getState().totalEquity;
  const creditedInWindow = account.getOptionsCredited() - tracker.getLastOptionsCreditedCumulative();
  const stockOnlyDailyPnl = (equity - tracker.getOpeningEquity()) - creditedInWindow;
  tracker.saveSnapshot({
    date,
    closingEquity: equity,
    openingEquity: tracker.getOpeningEquity(),
    dailyPnl: stockOnlyDailyPnl,
    optionsPnl: 0,
    combinedPnl: stockOnlyDailyPnl,
    optionsCreditedCumulative: account.getOptionsCredited(),
    trades: 0,
  });
  return stockOnlyDailyPnl;
}

/**
 * A process restart: the account is rebuilt from what is actually on disk, via
 * the same seam `user-context` uses on both sides. This is the hop that dropped
 * the field — a test that hands `exportSnapshot()` straight to `importSnapshot()`
 * passes while production is broken, because the durable projection in between
 * is where the loss happened.
 */
function restart(account: PaperAccount, tracker: PnlTracker): PaperAccount {
  const durable = toDurableAccountSnapshot(account.exportSnapshot());
  // Survives the JSON round trip to disk and back.
  const onDisk = JSON.parse(JSON.stringify(durable)) as StocksTradeSnapshot['account'];
  const revived = new PaperAccount({ initialEquity: OPENING_EQUITY });
  revived.importSnapshot(
    restoreDurableAccountSnapshot(onDisk, [], tracker.getLastOptionsCreditedCumulative()),
  );
  return revived;
}

describe('TRA-2629 — optionsCredited across the durability seam', () => {
  it('carries optionsCredited through the durable projection in both directions', () => {
    const account = new PaperAccount({ initialEquity: OPENING_EQUITY });
    account.creditRealizedOptionsPnl(CREDIT_765);

    const durable = toDurableAccountSnapshot(account.exportSnapshot());
    expect(durable.optionsCredited).toBe(CREDIT_765);

    const revived = restoreDurableAccountSnapshot(durable, [], 0);
    expect(revived.optionsCredited).toBe(CREDIT_765);
  });

  it('keeps the stock leg at 0 on a zero-close session after a restart (ctoverify_tra2331)', () => {
    const tracker = new PnlTracker(dataDir, OPENING_EQUITY);
    tracker.syncOpeningEquity(OPENING_EQUITY, 0);

    let account: PaperAccount = new PaperAccount({ initialEquity: OPENING_EQUITY });

    // 2026-07-28 — one option closes for +765. The credit lands in equity.
    account.creditRealizedOptionsPnl(CREDIT_765);
    expect(writeEodRow(tracker, account, '2026-07-28')).toBe(0);

    // bqb1 restarts between sessions.
    account = restart(account, tracker);

    // 2026-07-29 — NOTHING closes. journalCloses: 0. The stock leg must be 0.
    // Pre-fix this read +765: the prior session's optionsDaily, re-applied.
    expect(writeEodRow(tracker, account, '2026-07-29')).toBe(0);
  });

  it('keeps a genuine stock move readable and does not absorb the option credit', () => {
    const tracker = new PnlTracker(dataDir, OPENING_EQUITY);
    tracker.syncOpeningEquity(OPENING_EQUITY, 0);

    let account: PaperAccount = new PaperAccount({ initialEquity: OPENING_EQUITY });
    account.creditRealizedOptionsPnl(CREDIT_765);
    writeEodRow(tracker, account, '2026-07-28');

    account = restart(account, tracker);

    // A real +40 stock close plus a +22.50 option close on the same session:
    // the stock leg must report 40, not 40 + 22.50 and not 40 + 765.
    account.creditRealizedOptionsPnl(22.5);
    const stockOnly = account.getState().totalEquity + 40;
    account.importSnapshot({ ...account.exportSnapshot(), equity: stockOnly, cash: stockOnly });
    expect(writeEodRow(tracker, account, '2026-07-29')).toBe(40);
  });

  it('seeds a legacy snapshot from the last EOD row, not 0', () => {
    const tracker = new PnlTracker(dataDir, OPENING_EQUITY);
    tracker.syncOpeningEquity(OPENING_EQUITY, 0);

    const account = new PaperAccount({ initialEquity: OPENING_EQUITY });
    account.creditRealizedOptionsPnl(CREDIT_765);
    writeEodRow(tracker, account, '2026-07-28');

    // A snapshot written before this fix: `equity` holds the 765, the field does
    // not exist. Collapsing to 0 would re-strand the transition session; seeding
    // from the row the writer differences against makes it exact.
    const legacy = toDurableAccountSnapshot(account.exportSnapshot());
    delete legacy.optionsCredited;

    const revived = new PaperAccount({ initialEquity: OPENING_EQUITY });
    revived.importSnapshot(
      restoreDurableAccountSnapshot(legacy, [], tracker.getLastOptionsCreditedCumulative()),
    );
    expect(revived.getOptionsCredited()).toBe(CREDIT_765);
    expect(writeEodRow(tracker, revived, '2026-07-29')).toBe(0);
  });
});
