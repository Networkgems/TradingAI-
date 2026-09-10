/**
 * TRA-4476 — the DURABLE half: does a halt survive a process restart?
 *
 * The engine's suite proves the state machine against an in-memory journal. That
 * cannot answer the question this file exists for, because the scenario is
 * "the process died" and an in-memory journal dies with it. These fixtures go
 * through a real file on a real temp dir.
 *
 * Every all-clear assertion here is paired with the discriminator that makes it
 * mean something: `journalAbsent` and `journalInstalled` are asserted alongside
 * `latchedCount`, because "nothing is halted" and "nothing is recording" both
 * report zero halts and only one of them is good news.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  __resetUnknownIntentBreakerForTest,
  getOrderIntentJournal,
  getUnknownIntentBreaker,
  type OrderIntent,
} from '@trading-app/engine';
import {
  FileOrderIntentJournal,
  ORDER_INTENT_LOG_FILENAME,
  __resetOrderIntentJournalForTest,
  compactAtBoot,
  installOrderIntentJournal,
  orderIntentHealth,
  orderIntentLogPath,
  readOpenIntents,
} from './tra4476-order-intent-journal.js';

let dir: string;

function intent(over: Partial<OrderIntent> = {}): OrderIntent {
  return {
    intentId: 'oi_test_1',
    accountId: 'A1',
    env: 'production',
    submitStartedAt: 1_757_000_000_000,
    shape: {
      orderClass: 'equity', side: 'buy', symbol: 'AAPL',
      optionSymbol: null, quantity: 10, limitPrice: null,
    },
    status: 'submitting',
    updatedAt: 1_757_000_000_000,
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tra4476-'));
  __resetUnknownIntentBreakerForTest();
  __resetOrderIntentJournalForTest();
});

afterEach(() => {
  __resetOrderIntentJournalForTest();
  __resetUnknownIntentBreakerForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe('TRA-4476 durable journal', () => {
  it('writes one line per transition and folds to the latest state per intent', () => {
    const j = new FileOrderIntentJournal(orderIntentLogPath(dir));
    j.record(intent({ status: 'submitting' }));
    j.update(intent({ status: 'acknowledged', orderId: 555 }));
    const read = readOpenIntents(orderIntentLogPath(dir));
    expect(read.absent).toBe(false);
    expect(read.latest).toHaveLength(1);
    expect(read.latest[0].status).toBe('acknowledged');
    expect(read.latest[0].orderId).toBe(555);
    // Settled, so nothing is outstanding.
    expect(read.open).toHaveLength(0);
    // …but the full transition history is still on disk for the operator.
    expect(readFileSync(orderIntentLogPath(dir), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('AN ABSENT JOURNAL IS NOT AN EMPTY ONE', () => {
    const read = readOpenIntents(orderIntentLogPath(dir));
    expect(read.absent).toBe(true);
    expect(read.open).toHaveLength(0);
    // The pair is the point: a caller that only looked at `open.length` would
    // read a first boot as a clean all-clear.
    const j = new FileOrderIntentJournal(orderIntentLogPath(dir));
    j.record(intent({ status: 'acknowledged' }));
    const after = readOpenIntents(orderIntentLogPath(dir));
    expect(after.absent).toBe(false);
    expect(after.open).toHaveLength(0);
  });

  it('counts corrupt lines rather than dropping them silently', () => {
    writeFileSync(
      orderIntentLogPath(dir),
      `${JSON.stringify(intent({ status: 'unknown' }))}\nnot json at all\n{"no":"intentId"}\n`,
      'utf8',
    );
    const read = readOpenIntents(orderIntentLogPath(dir));
    expect(read.corrupt).toBe(2);
    expect(read.open).toHaveLength(1);
  });
});

describe('TRA-4476 restart mid-intent', () => {
  it('a `submitting` line left by a dead process RE-LATCHES the shape on the next boot', () => {
    // Boot 1 died here — the pre-submit line is all that exists.
    writeFileSync(
      orderIntentLogPath(dir),
      `${JSON.stringify(intent({ intentId: 'oi_lost', status: 'submitting' }))}\n`,
      'utf8',
    );

    // Boot 2.
    const result = installOrderIntentJournal(dir);
    expect(result.installed).toBe(true);
    expect(result.rehydrated).toBe(1);
    expect(getUnknownIntentBreaker().size).toBe(1);

    const health = orderIntentHealth();
    expect(health.journalInstalled).toBe(true);
    expect(health.latchedCount).toBe(1);
    expect(health.latched[0].reason).toBe('rehydrated_from_journal');
    expect(health.latched[0].shape.symbol).toBe('AAPL');
    expect(health.openOnDisk).toBe(1);
  });

  it('an `unknown` line re-latches too', () => {
    writeFileSync(
      orderIntentLogPath(dir),
      `${JSON.stringify(intent({ intentId: 'oi_unk', status: 'unknown', unknownReason: 'timeout' }))}\n`,
      'utf8',
    );
    expect(installOrderIntentJournal(dir).rehydrated).toBe(1);
    expect(getUnknownIntentBreaker().size).toBe(1);
  });

  it('NEGATIVE CONTROL — a journal of SETTLED intents re-latches nothing, and says so', () => {
    writeFileSync(
      orderIntentLogPath(dir),
      [
        JSON.stringify(intent({ intentId: 'a', status: 'acknowledged', orderId: 1 })),
        JSON.stringify(intent({ intentId: 'b', status: 'refused' })),
        JSON.stringify(intent({ intentId: 'c', status: 'not_placed' })),
      ].join('\n') + '\n',
      'utf8',
    );
    const result = installOrderIntentJournal(dir);
    expect(result.rehydrated).toBe(0);
    expect(getUnknownIntentBreaker().size).toBe(0);
    const health = orderIntentHealth();
    // Zero halts AND the journal is installed and non-absent. Both halves are
    // required before this reads as an all-clear.
    expect(health.latchedCount).toBe(0);
    expect(health.journalInstalled).toBe(true);
    expect(health.journalAbsent).toBe(false);
    expect(health.openOnDisk).toBe(0);
  });

  it('the transition history resolves a lost intent that a LATER line settled', () => {
    // Same intent id: pre-submit line, then the settle. Last line wins.
    writeFileSync(
      orderIntentLogPath(dir),
      [
        JSON.stringify(intent({ intentId: 'x', status: 'submitting' })),
        JSON.stringify(intent({ intentId: 'x', status: 'acknowledged', orderId: 9 })),
      ].join('\n') + '\n',
      'utf8',
    );
    expect(installOrderIntentJournal(dir).rehydrated).toBe(0);
  });
});

describe('TRA-4476 health readout', () => {
  it('WITHOUT an install, it reports NOT INSTALLED rather than a clean zero', () => {
    const health = orderIntentHealth();
    expect(health.journalInstalled).toBe(false);
    expect(health.journalAbsent).toBe(true);
    expect(health.latchedCount).toBe(0);
    // This is the discriminator the route exists for: `latchedCount: 0` here
    // means "nothing is watching", and `journalInstalled: false` is what says so.
  });

  it('a null data dir does not install, and does not pretend to', () => {
    const result = installOrderIntentJournal(null);
    expect(result.installed).toBe(false);
    expect(orderIntentHealth().journalInstalled).toBe(false);
  });

  it('installing points the engine singleton at the file', () => {
    installOrderIntentJournal(dir);
    getOrderIntentJournal().record(intent({ intentId: 'oi_via_singleton', status: 'unknown' }));
    expect(existsSync(orderIntentLogPath(dir))).toBe(true);
    expect(readOpenIntents(orderIntentLogPath(dir)).open.map((i) => i.intentId))
      .toContain('oi_via_singleton');
  });

  it('journal write failures are COUNTED, and never throw into the order path', () => {
    // A path inside a file, not a directory — every append fails.
    const bad = path.join(orderIntentLogPath(dir), 'nested', ORDER_INTENT_LOG_FILENAME);
    const j = new FileOrderIntentJournal(bad);
    expect(() => j.record(intent())).not.toThrow();
    expect(j.stats().failures).toBe(1);
    expect(j.stats().writes).toBe(0);
  });
});

describe('TRA-4476 retention', () => {
  it('compaction ARCHIVES, never deletes', () => {
    const j = new FileOrderIntentJournal(orderIntentLogPath(dir));
    j.record(intent({ status: 'acknowledged' }));
    const archived = compactAtBoot(dir, Date.parse('2026-09-09T22:00:00Z'));
    expect(archived).not.toBeNull();
    expect(existsSync(archived as string)).toBe(true);
    expect(existsSync(orderIntentLogPath(dir))).toBe(false);
    // The evidence still exists — it moved, it did not go away.
    expect(readFileSync(archived as string, 'utf8')).toContain('oi_test_1');
  });

  it('compacting an absent journal is a no-op, not an error', () => {
    expect(compactAtBoot(dir)).toBeNull();
  });
});
