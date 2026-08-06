// TRA-3035 — `journalPartialCloses: 0` read IDENTICALLY for "no partial
// occurred" and "a partial occurred and was thrown away".
//
// TRA-2937 instrumented the CLOSE path: `queueJournalClose` looks the row up and
// WARNS when it misses. The PARTIAL path was left as it was — it handed the id
// straight to `recordOptionTradePartialClose`, which answers a bare `false` on a
// missing or already-closed row, and the return value was discarded. The census
// counts rows that got WRITTEN, so a dropped slice is indistinguishable from a
// day with no trims at all.
//
// Measured on prod `tradingai-bqb1`, ET day 2026-08-05, book `admin` (mode
// `live`): the day cell booked `optionsDailyPnlSource: bucket-journal-silent`,
// `optionsDaily -424.00`, `journalCloses 0`, `journalPartialCloses 0` — while
// the order tape held a genuine partial (`TSLA260911C00560000` qty 2 @ $0.25
// `kind:tp1` at 13:34:21.878Z, the same symbol re-submitted qty 2 `trail` at
// 15:13:47Z, so contracts remained). Zero `option trade journal partial close`
// lines fired all session. Telling those two states apart cost a log dig
// through the raw order tape, because the journal seam emitted NOTHING either
// way.
//
// This file pins the discriminator, and pins it as a discriminator: the two drop
// arms carry DIFFERENT messages (a writer-side hole is not a late slice), and
// the healthy path stays silent AND still writes its row — the control that
// stops the new lookup from turning every partial into a "drop".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import { PaperOptionsAccount } from './options-account.js';
import {
  listOptionTradeJournal,
  setOptionTradeJournalFileForTests,
  recordOptionTradeClose,
} from './option-trade-journal.js';
import type { TradierOpenOptionPosition } from '@trading-app/engine';

const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');
const OCC = 'TSLA260911C00560000';

function buildImport(
  overrides: Partial<TradierOpenOptionPosition> = {},
): TradierOpenOptionPosition {
  return {
    optionSymbol: OCC,
    underlying: 'TSLA',
    optionType: 'call',
    strike: 560,
    expiration: '2026-09-11',
    contracts: 4,
    premiumPaid: 1.6,
    acquiredAt: TRADING_TIME,
    ...overrides,
  };
}

let tmpFile: string;
let fileCounter = 0;
let stderrLines: string[] = [];

/** Every warn the journal seam emitted for a DROPPED partial, parsed. */
function dropWarns(): Array<Record<string, unknown>> {
  return stderrLines
    .flatMap((chunk) => chunk.split('\n'))
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((rec): rec is Record<string, unknown> => rec !== null)
    .filter((rec) => String(rec['msg'] ?? '').includes('journal partial close dropped'));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  tmpFile = join(tmpdir(), `tra3035-journal-${process.pid}-${fileCounter++}.jsonl`);
  setOptionTradeJournalFileForTests(tmpFile);
  stderrLines = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderrLines.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

/**
 * A position whose journal OPEN row does not exist — the shape the live book was
 * in on 2026-08-05. Produced the way prod produces it, by opening while the
 * journal is not writing (pre-TRA-2937 build, or a row opened before the flag
 * flipped on) and trimming after it is. The account book does not care either
 * way; only the journal has the hole.
 */
function accountWithUnjournalledImport(): { acct: PaperOptionsAccount; id: string } {
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
  acct.reconcileTradierPositions([buildImport()], 'live');
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  return { acct, id: acct.getStateForMode('live').openOptions[0]!.id };
}

describe('TRA-3035 — a dropped partial close is no longer silent', () => {
  it('warns, naming the contract and the dollars, when no OPEN row exists for the id', async () => {
    const { acct, id } = accountWithUnjournalledImport();

    // The live shape: 2 of 4 contracts out, position survives.
    expect(acct.bookPartialClose(id, 'ord-1', 2, 0.25)).not.toBeNull();
    await acct.flushOptionTradeJournal();

    const warns = dropWarns();
    expect(warns).toHaveLength(1);
    const warn = warns[0]!;
    expect(String(warn['msg'])).toContain('no OPEN row for this id');
    expect(warn['issue']).toBe('TRA-3035');
    expect(warn['optionSymbol']).toBe(OCC);
    expect(warn['contracts']).toBe(2);
    // (0.25 − 1.60) × 2 × 100 — the slice the census never saw.
    expect(warn['realizedPnlUsd']).toBeCloseTo(-270, 5);

    // And the census still sees nothing, because there is genuinely no row to
    // count. The warn is the ONLY thing that separates this from a quiet day.
    expect(await listOptionTradeJournal()).toHaveLength(0);
  });

  it('warns with a DIFFERENT message when the row is already closed', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    acct.reconcileTradierPositions([buildImport()], 'live');
    const id = acct.getStateForMode('live').openOptions[0]!.id;
    await acct.flushOptionTradeJournal();

    // Settle the journal row behind the book's back — the ordering the recorder
    // refuses (a slice subtracted from a total that never contained it).
    await recordOptionTradeClose(id, {
      closeTs: TRADING_TIME,
      outcome: 'LOSS',
      realizedPnlUsd: -160,
      realizedR: -0.25,
      exitReason: 'manual',
      holdDays: 0,
    });

    expect(acct.bookPartialClose(id, 'ord-1', 2, 0.25)).not.toBeNull();
    await acct.flushOptionTradeJournal();

    const warns = dropWarns();
    expect(warns).toHaveLength(1);
    expect(String(warns[0]!['msg'])).toContain('already closed');
    expect(warns[0]!['outcome']).toBe('LOSS');

    // The refusal itself is unchanged — no slice was folded into the settled row.
    const row = (await listOptionTradeJournal())[0]!;
    expect(row.partials ?? []).toHaveLength(0);
  });

  it('stays silent — and still writes the row — on a healthy partial', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    acct.reconcileTradierPositions([buildImport()], 'live');
    const id = acct.getStateForMode('live').openOptions[0]!.id;
    await acct.flushOptionTradeJournal();

    expect(acct.bookPartialClose(id, 'ord-1', 2, 0.25)).not.toBeNull();
    await acct.flushOptionTradeJournal();

    expect(dropWarns()).toHaveLength(0);
    const row = (await listOptionTradeJournal())[0]!;
    expect(row.partials ?? []).toHaveLength(1);
    expect(row.partials![0]!.realizedPnlUsd).toBeCloseTo(-270, 5);
    expect(row.partials![0]!.contracts).toBe(2);
  });

  it('is the ONLY signal separating a dropped slice from a day with no trims', async () => {
    // Arm A — a real partial, thrown away.
    const dropped = accountWithUnjournalledImport();
    expect(dropped.acct.bookPartialClose(dropped.id, 'ord-1', 2, 0.25)).not.toBeNull();
    await dropped.acct.flushOptionTradeJournal();
    const censusAfterDrop = (await listOptionTradeJournal()).flatMap((r) => r.partials ?? []);
    const warnsAfterDrop = dropWarns().length;

    // Arm B — same book, same journal, no trim at all.
    stderrLines = [];
    await rm(tmpFile, { force: true });
    const quiet = accountWithUnjournalledImport();
    expect(quiet.id).toBeTruthy();
    await quiet.acct.flushOptionTradeJournal();
    const censusAfterQuiet = (await listOptionTradeJournal()).flatMap((r) => r.partials ?? []);
    const warnsAfterQuiet = dropWarns().length;

    // What the day cell reads is IDENTICAL across the two — that is the defect,
    // and it is not fixed here, because the row genuinely does not exist.
    expect(censusAfterDrop).toHaveLength(0);
    expect(censusAfterQuiet).toHaveLength(0);
    // What separates them is the warn, and only the warn.
    expect(warnsAfterDrop).toBe(1);
    expect(warnsAfterQuiet).toBe(0);
  });
});
