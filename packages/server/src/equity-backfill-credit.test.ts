import { describe, it, expect } from 'vitest';
import {
  applyEquityBackfill,
  type EquityBackfillBook,
  type EquityBackfillLedgerPort,
  type EquityBackfillLedgerRow,
} from './equity-backfill-credit.js';
import { PaperAccount } from './paper-account.js';
import { stockModeKey } from './user-context.js';
import type { AccountSettings } from '@trading-app/shared';

const NOW = '2026-08-06T01:30:00.000Z';

function memLedger(seed: EquityBackfillLedgerRow[] = []): EquityBackfillLedgerPort & {
  rows: EquityBackfillLedgerRow[];
} {
  const rows = [...seed];
  return {
    rows,
    find: (id: string) => rows.find(r => r.backfillId === id),
    append: async (row: EquityBackfillLedgerRow) => {
      rows.push(row);
    },
  };
}

/** A book backed by the REAL `PaperAccount`, so the credit exercises production code. */
function realBook(username: string, mode: string, startingEquity: number): EquityBackfillBook {
  const acct = new PaperAccount({ initialEquity: startingEquity });
  return {
    username,
    mode,
    getTotalEquity: () => acct.getState().totalEquity,
    getOptionsCredited: () => acct.getOptionsCredited(),
    // Flat book ⇒ the TRA-2301 invariant is `cash === equity`.
    getCashInvariantGap: () => acct.getState().availableCash - acct.getState().totalEquity,
    credit: (d: number) => acct.creditRealizedOptionsPnl(d),
  };
}

const req = (over: Partial<Parameters<typeof applyEquityBackfill>[0]> = {}) => ({
  username: 'demoguy',
  amountUsd: 400.29,
  backfillId: 'tra-3009-richard-v1',
  reason: 'TRA-3009 backfill of pre-bridge option P&L',
  ...over,
});

describe('applyEquityBackfill', () => {
  it('credits a demo book additively and leaves the cash invariant untouched', async () => {
    const book = realBook('demoguy', 'demo', 2317);
    const ledger = memLedger();
    const out = await applyEquityBackfill(req(), [book], ledger, NOW);

    expect(out.ok).toBe(true);
    if (!out.ok || !out.applied) throw new Error('expected an applied credit');
    expect(out.row.equityBefore).toBeCloseTo(2317, 10);
    // ADDITIVE, not a rebase: after == before + amount, to the cent.
    expect(out.row.equityAfter - out.row.equityBefore).toBeCloseTo(400.29, 10);
    // ATTRIBUTED: the credit lands on the `optionsCredited` counter that
    // `pnl-reconciliation` publishes as `optionsCreditedCumulative`, so it can
    // never read as an anonymous `unbookedEquityMove`.
    expect(out.row.optionsCreditedAfter - out.row.optionsCreditedBefore).toBeCloseTo(400.29, 10);
    // TRA-2301: gap before === gap after.
    expect(out.row.cashInvariantGapAfter).toBeCloseTo(out.row.cashInvariantGapBefore ?? 0, 10);
    expect(ledger.rows).toHaveLength(1);
  });

  it('is one-shot: a replay of the identical request moves nothing', async () => {
    const book = realBook('demoguy', 'demo', 2317);
    const ledger = memLedger();
    await applyEquityBackfill(req(), [book], ledger, NOW);
    const equityAfterFirst = book.getTotalEquity();

    const replay = await applyEquityBackfill(req(), [book], ledger, NOW);
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error('unreachable');
    expect(replay.applied).toBe(false);
    expect(book.getTotalEquity()).toBeCloseTo(equityAfterFirst, 10);
    expect(ledger.rows).toHaveLength(1);
  });

  it('refuses a replay that changes the amount under a spent id, rather than silently no-opping', async () => {
    const book = realBook('demoguy', 'demo', 2317);
    const ledger = memLedger();
    await applyEquityBackfill(req(), [book], ledger, NOW);

    const amended = await applyEquityBackfill(req({ amountUsd: 405.4 }), [book], ledger, NOW);
    expect(amended.ok).toBe(false);
    if (amended.ok) throw new Error('unreachable');
    expect(amended.refusal).toBe('replay-mismatch');
  });

  // ── The discriminator this module exists for ────────────────────────────────
  it('REFUSES a live-mode book backed by the Tradier SANDBOX env, whose stockModeKey reads "sandbox"', async () => {
    const settings = {
      mode: 'live',
      liveTradierEnvOptions: 'sandbox',
    } as unknown as AccountSettings;
    // The trap, stated as an assertion: this book does NOT read `live` through
    // `stockModeKey`, so a guard phrased against that value would let it through.
    expect(stockModeKey(settings)).toBe('sandbox');
    expect(stockModeKey(settings)).not.toBe('live');

    const book = realBook('sandboxguy', settings.mode, 2317);
    const equityBefore = book.getTotalEquity();
    const out = await applyEquityBackfill(
      req({ username: 'sandboxguy' }),
      [book],
      memLedger(),
      NOW,
    );

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('a sandbox-env live book must be refused');
    expect(out.refusal).toBe('book-mode-not-demo');
    expect(book.getTotalEquity()).toBe(equityBefore);
  });

  it('refuses a production-live book and an unrecognised mode alike — UNKNOWN is never OFF', async () => {
    for (const mode of ['live', 'sandbox', 'paper', '']) {
      const book = realBook('u', mode, 2000);
      const out = await applyEquityBackfill(req({ username: 'u' }), [book], memLedger(), NOW);
      expect(out.ok, `mode ${JSON.stringify(mode)} must be refused`).toBe(false);
      if (out.ok) throw new Error('unreachable');
      expect(out.refusal).toBe('book-mode-not-demo');
      expect(book.getTotalEquity()).toBe(2000);
    }
  });

  it('refuses an unnamed book rather than picking the only demo book present', async () => {
    const book = realBook('demoguy', 'demo', 2317);
    const out = await applyEquityBackfill(req({ username: 'Richard' }), [book], memLedger(), NOW);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.refusal).toBe('book-not-found');
    expect(book.getTotalEquity()).toBe(2317);
  });

  it('refuses a zero / non-finite amount and a blank reason', async () => {
    const book = realBook('demoguy', 'demo', 2317);
    for (const amountUsd of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = await applyEquityBackfill(req({ amountUsd }), [book], memLedger(), NOW);
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('unreachable');
      expect(out.refusal).toBe('amount-not-usable');
    }
    const noReason = await applyEquityBackfill(req({ reason: '  ' }), [book], memLedger(), NOW);
    expect(noReason.ok).toBe(false);
    if (noReason.ok) throw new Error('unreachable');
    expect(noReason.refusal).toBe('request-incomplete');
  });

  it('resolves idempotency before touching the book, so a replay survives the book leaving memory', async () => {
    const ledger = memLedger([
      {
        backfillId: 'tra-3009-richard-v1',
        username: 'demoguy',
        bookMode: 'demo',
        amountUsd: 400.29,
        equityBefore: 2317,
        equityAfter: 2717.29,
        optionsCreditedBefore: 0,
        optionsCreditedAfter: 400.29,
        cashInvariantGapBefore: 0,
        cashInvariantGapAfter: 0,
        reason: 'seeded',
        appliedAtIso: NOW,
      },
    ]);
    // No books at all — a replay must still report the prior row, not `book-not-found`.
    const out = await applyEquityBackfill(req(), [], ledger, NOW);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('unreachable');
    expect(out.applied).toBe(false);
  });
});
