// TRA-4711 — a demo journal row whose position was lost across a restart stays
// OPEN forever. The sweep retracts it once the contract is dead and no book
// holds it — and must NOT touch a row a book still holds, a live-mode row, a
// not-yet-expired contract, or anything at all when no books have booted.
import { describe, it, expect, beforeEach } from 'vitest';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';
import {
  DTE_BOUND_MARGIN_DAYS,
  dteBoundExpiryDate,
  EXPIRED_DEMO_ORPHAN_DTE_BOUND_REASON,
  EXPIRED_DEMO_ORPHAN_REASON,
  occExpiryDate,
  planExpiredDemoOrphans,
  resetExpiredDemoOrphanSweepStateForTests,
  runExpiredDemoOrphanSweep,
  type ExpiredDemoOrphanSweepDeps,
} from './expired-demo-orphan-sweep.js';

// 2026-09-18 16:40 ET.
const NOW = Date.parse('2026-09-18T20:40:00Z');

function row(overrides: Partial<OptionTradeJournalRecord>): OptionTradeJournalRecord {
  return {
    id: 'row',
    openTs: Date.parse('2026-07-21T17:06:57Z'),
    symbol: 'GIS',
    optionSymbol: 'GIS260821P00037500',
    structure: 'single_leg_rv',
    mode: 'demo',
    outcome: 'OPEN',
    ivRank: null,
    trend: 'down',
    sentiment: null,
    sentimentIcBand: null,
    entryDelta: 0.51,
    entryDte: 31,
    atRiskUsd: 142.5,
    agentConviction: null,
    account: 'admin',
    ...overrides,
  } as OptionTradeJournalRecord;
}

function deps(
  rows: OptionTradeJournalRecord[],
  books: Array<Array<{ id: string; journalId?: string }>>,
  overrides: Partial<ExpiredDemoOrphanSweepDeps> = {},
): ExpiredDemoOrphanSweepDeps & { voids: Array<{ id: string; reason: string; book: string | null }> } {
  const voids: Array<{ id: string; reason: string; book: string | null }> = [];
  return {
    voids,
    journalEnabled: () => true,
    listDemoJournalRows: async () => rows,
    listBookOpenPositions: () => books,
    recordVoid: async (id, reason, book) => {
      voids.push({ id, reason, book });
      return true;
    },
    now: () => NOW,
    observeOnly: () => false,
    ...overrides,
  };
}

beforeEach(() => resetExpiredDemoOrphanSweepStateForTests());

describe('occExpiryDate', () => {
  it('reads the expiry off the fixed OCC tail, whatever the root length', () => {
    expect(occExpiryDate('GIS260821P00037500')).toBe('2026-08-21');
    expect(occExpiryDate('SPXW261023C05800000')).toBe('2026-10-23');
    expect(occExpiryDate('A260102C00100000')).toBe('2026-01-02');
  });

  it('returns null rather than guessing on a non-OCC symbol', () => {
    expect(occExpiryDate(undefined)).toBeNull();
    expect(occExpiryDate('')).toBeNull();
    expect(occExpiryDate('GIS')).toBeNull();
    expect(occExpiryDate('GIS261321P00037500')).toBeNull();
  });
});

describe('planExpiredDemoOrphans', () => {
  it('partitions the 2026-09-18 bqb1 population', () => {
    const plan = planExpiredDemoOrphans(
      [
        row({ id: 'gis', optionSymbol: 'GIS260821P00037500' }),
        row({ id: 'run', symbol: 'RUN', optionSymbol: 'RUN260828C00012000' }),
        row({ id: 'xlf', symbol: 'XLF', optionSymbol: 'XLF261023C00056000' }),
        row({ id: 'imp', symbol: 'QQQ', optionSymbol: undefined, structure: 'tradier_import' }),
        row({ id: 'held', optionSymbol: 'GIS260821P00037500' }),
        row({ id: 'closed', outcome: 'LOSS' }),
        row({ id: 'live', mode: 'live' }),
      ],
      new Set(['held']),
      '2026-09-18',
    );
    expect(plan).toMatchObject({ demoOpenRows: 5, orphans: 2, heldExpired: 1, live: 1, unparseable: 1 });
    expect(plan.rows.map((r) => [r.id, r.treatment])).toEqual([
      ['gis', 'void'],
      ['run', 'void'],
      ['held', 'held_expired'],
    ]);
  });

  it('keeps a contract on its own expiry day — it can still be exited that session', () => {
    const plan = planExpiredDemoOrphans([row({ optionSymbol: 'GIS260918P00037500' })], new Set(), '2026-09-18');
    expect(plan.orphans).toBe(0);
    expect(plan.live).toBe(1);
  });
});

describe('runExpiredDemoOrphanSweep', () => {
  it('voids an expired row no book holds, naming the book, and leaves a held one alone', async () => {
    const d = deps(
      [row({ id: 'gis' }), row({ id: 'held-row', account: 'Richard' })],
      [[{ id: 'pos-1', journalId: 'held-row' }], []],
    );
    const s = await runExpiredDemoOrphanSweep(d);
    expect(d.voids).toEqual([{ id: 'gis', reason: EXPIRED_DEMO_ORPHAN_REASON, book: 'admin' }]);
    expect(s.lastOutcome).toBe('repaired');
    expect(s.checked).toBe(true);
    expect(s.booksScanned).toBe(2);
    expect(s.counts).toMatchObject({ orphans: 1, heldExpired: 1 });
    expect(s.lastRows.find((r) => r.id === 'held-row')).toMatchObject({ applied: false, treatment: 'held_expired' });
  });

  it('matches a held position by its own id when it carries no journalId', async () => {
    const d = deps([row({ id: 'pos-9' })], [[{ id: 'pos-9' }]]);
    const s = await runExpiredDemoOrphanSweep(d);
    expect(d.voids).toEqual([]);
    expect(s.lastOutcome).toBe('held-expired');
  });

  it('writes nothing when no book has booted — "held by none" is then a fact about boot order', async () => {
    const d = deps([row({ id: 'gis' })], []);
    const s = await runExpiredDemoOrphanSweep(d);
    expect(d.voids).toEqual([]);
    expect(s.lastOutcome).toBe('no-books');
    expect(s.checked).toBe(false);
  });

  it('measures but does not write under observe-only', async () => {
    const d = deps([row({ id: 'gis' })], [[]], { observeOnly: () => true });
    const s = await runExpiredDemoOrphanSweep(d);
    expect(d.voids).toEqual([]);
    expect(s.lastOutcome).toBe('observe-only');
    expect(s.counts?.orphans).toBe(1);
  });

  it('reports a fold refusal distinctly', async () => {
    const d = deps([row({ id: 'gis' })], [[]], { recordVoid: async () => false });
    const s = await runExpiredDemoOrphanSweep(d);
    expect(s.lastOutcome).toBe('refused');
    expect(s.lastApplied).toEqual({ voided: 0, refused: 1 });
  });

  it('reads clean, and checked, when nothing is expired', async () => {
    const d = deps([row({ id: 'xlf', optionSymbol: 'XLF261023C00056000' })], [[]]);
    const s = await runExpiredDemoOrphanSweep(d);
    expect(s.lastOutcome).toBe('clean');
    expect(s.checked).toBe(true);
    expect(s.counts?.orphans).toBe(0);
  });

  it('never throws', async () => {
    const d = deps([], [[]], { listDemoJournalRows: async () => { throw new Error('disk'); } });
    const s = await runExpiredDemoOrphanSweep(d);
    expect(s.lastOutcome).toBe('error');
    expect(s.lastError).toBe('disk');
  });
});

// TRA-4721 — 28 demo rows from 2026-06-25..07-10 carry no OCC and no account.
// Their own openTs + entryDte bounds the expiry; past bound + margin and held by
// no book ⇒ voided under a distinct reason. Anything the bound cannot prove
// stays `unparseable`.
describe('TRA-4721 DTE bound for rows with no OCC', () => {
  const legacy = (overrides: Partial<OptionTradeJournalRecord>) =>
    row({ optionSymbol: undefined, account: undefined, ...overrides });

  it('bounds expiry at ET open date + entryDte + margin', () => {
    // 2026-06-25T13:35Z is 09:35 ET on 06-25; +52d = 08-16; +7d margin = 08-23.
    expect(DTE_BOUND_MARGIN_DAYS).toBe(7);
    expect(dteBoundExpiryDate(legacy({ openTs: Date.parse('2026-06-25T13:35:00Z'), entryDte: 52 }))).toBe('2026-08-23');
    // 02:00Z is still the PREVIOUS ET day — the bound anchors on the ET date.
    expect(dteBoundExpiryDate(legacy({ openTs: Date.parse('2026-07-11T02:00:00Z'), entryDte: 0 }))).toBe('2026-07-17');
    // A fractional DTE rounds UP (the conservative direction).
    expect(dteBoundExpiryDate(legacy({ openTs: Date.parse('2026-07-10T13:50:00Z'), entryDte: 21.2 }))).toBe('2026-08-08');
  });

  it('refuses to bound an import, a multi-expiry structure, or a missing/negative field', () => {
    const base = { openTs: Date.parse('2026-06-25T13:35:00Z'), entryDte: 30 };
    expect(dteBoundExpiryDate(legacy({ ...base, structure: 'tradier_import' }))).toBeNull();
    expect(dteBoundExpiryDate(legacy({ ...base, structure: 'put_calendar' }))).toBeNull();
    expect(dteBoundExpiryDate(legacy({ ...base, structure: 'diagonal_call' }))).toBeNull();
    expect(dteBoundExpiryDate(legacy({ ...base, entryDte: -1 }))).toBeNull();
    expect(dteBoundExpiryDate(legacy({ ...base, entryDte: Number.NaN }))).toBeNull();
    expect(dteBoundExpiryDate(legacy({ ...base, entryDte: undefined as unknown as number }))).toBeNull();
    expect(dteBoundExpiryDate(legacy({ ...base, openTs: 0 }))).toBeNull();
  });

  it('partitions the 2026-09-19 bqb1 residual: past-bound rows void, the rest stay unparseable', () => {
    const plan = planExpiredDemoOrphans(
      [
        legacy({ id: 'rv', structure: 'single_leg_rv', openTs: Date.parse('2026-06-25T13:35:00Z'), entryDte: 52 }),
        legacy({ id: 'ic', structure: 'iron_condor', openTs: Date.parse('2026-07-10T13:50:00Z'), entryDte: 22 }),
        legacy({ id: 'held-ic', structure: 'iron_condor', openTs: Date.parse('2026-07-10T13:50:00Z'), entryDte: 22 }),
        // Opened 09-01 at 10 DTE: bound = 09-18, which is today — not yet proven dead.
        legacy({ id: 'edge', openTs: Date.parse('2026-09-01T14:00:00Z'), entryDte: 10 }),
        legacy({ id: 'imp', structure: 'tradier_import', openTs: Date.parse('2026-06-25T13:35:00Z'), entryDte: 5 }),
        row({ id: 'gis', optionSymbol: 'GIS260821P00037500' }),
      ],
      new Set(['held-ic']),
      '2026-09-18',
    );
    expect(plan).toMatchObject({
      demoOpenRows: 6,
      orphans: 3,
      dteBoundOrphans: 2,
      heldExpired: 1,
      live: 0,
      unparseable: 2,
    });
    expect(plan.rows.map((r) => [r.id, r.treatment, r.expiry])).toEqual([
      ['rv', 'void_dte_bound', '2026-08-23'],
      ['ic', 'void_dte_bound', '2026-08-08'],
      ['held-ic', 'held_expired', '2026-08-08'],
      ['gis', 'void', '2026-08-21'],
    ]);
  });

  it('voids a past-bound row under its own reason and never touches a held one', async () => {
    const d = deps(
      [
        legacy({ id: 'rv', openTs: Date.parse('2026-06-25T13:35:00Z'), entryDte: 52 }),
        legacy({ id: 'held-rv', openTs: Date.parse('2026-06-25T13:35:00Z'), entryDte: 52 }),
        row({ id: 'gis' }),
      ],
      [[{ id: 'p', journalId: 'held-rv' }]],
    );
    const s = await runExpiredDemoOrphanSweep(d);
    expect(d.voids).toEqual([
      { id: 'rv', reason: EXPIRED_DEMO_ORPHAN_DTE_BOUND_REASON, book: null },
      { id: 'gis', reason: EXPIRED_DEMO_ORPHAN_REASON, book: 'admin' },
    ]);
    expect(EXPIRED_DEMO_ORPHAN_DTE_BOUND_REASON).not.toBe(EXPIRED_DEMO_ORPHAN_REASON);
    expect(s.lastOutcome).toBe('repaired');
    expect(s.counts).toMatchObject({ orphans: 2, dteBoundOrphans: 1, heldExpired: 1, unparseable: 0 });
    expect(s.lastRows.find((r) => r.id === 'rv')?.reason).toMatch(/no OCC; openTs \+ entryDte \+ 7d = 2026-08-23/);
  });
});
