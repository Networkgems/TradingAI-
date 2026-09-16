import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { TradierCashEvent } from '@trading-app/engine';

import {
  parseRebuildIntent,
  inventoryCashFlowRecords,
  runCashFlowRebuild,
  reconcileAgainstStored,
  netByDateUnderOldRule,
  worstOutcome,
  buildHostCashEventFetcher,
  type FetchCashEventsResult,
} from './tra2906-cash-flow-rebuild.js';

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3595 — controls for the HOST EXECUTION PATH of the TRA-2906 v1→v2
// cash-flow rebuild.
//
// The subject writes to the only surviving record of months of deposits, on the
// money host, exactly once. `netByDate` has no second copy. So the controls that
// matter here are not "does the happy path work" — they are the three ways this
// can be wrong while looking right:
//
//   1. An arming value this build does not understand falling through to a
//      WRITE. That is the TRA-4420 shape, where `render-redeploy.mjs` matched
//      its flags positively-by-omission and `--help` shipped a build to bqb1.
//   2. A fetch that never reached the broker being reported as "the broker
//      disagrees with our record" (REFUSED) rather than "we could not look"
//      (BLIND). Both produce zero events; only one is a finding about the data.
//   3. A run that touched nothing reporting CLEAN — the wrong-DATA_DIR case,
//      which on a Render one-off job (no persistent disk) is the DEFAULT
//      outcome, not an edge case.
//
// Every control below is mutated: the fixture is perturbed in the direction the
// control claims to detect, and the assertion is that the verdict CHANGES.
// ─────────────────────────────────────────────────────────────────────────────

const FILE = 'tradier-cash-flow.production.json';

/** The fixture history: a deposit day, a deposit+fee day, and a fee-only day. */
const EVENTS: TradierCashEvent[] = [
  { date: '2026-07-01', type: 'ach', amount: 500, transactionId: 'a1' },
  { date: '2026-07-07', type: 'ach', amount: 300, transactionId: 'a2' },
  { date: '2026-07-07', type: 'fee', amount: -10, transactionId: 'f1' },
  { date: '2026-08-03', type: 'fee', amount: -10, transactionId: 'f2' },
  { date: '2026-08-10', type: 'dividend', amount: 4.25, transactionId: 'd1' },
];

/** What the OLD rule stored for that history — every type in the set summed. */
const STORED_V1 = {
  netByDate: { '2026-07-01': 500, '2026-07-07': 290, '2026-08-03': -10, '2026-08-10': 4.25 },
  seenIds: ['a1', 'a2', 'f1', 'f2', 'd1'],
};

let root: string;

function bookPath(username: string): string {
  return join(root, 'users', username, FILE);
}

function seedBook(username: string, contents: unknown): void {
  mkdirSync(join(root, 'users', username), { recursive: true });
  writeFileSync(bookPath(username), JSON.stringify(contents, null, 2), 'utf-8');
}

function okFetch(events: readonly TradierCashEvent[] = EVENTS) {
  return async (): Promise<FetchCashEventsResult> => ({ ok: true, events: [...events], detail: '' });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tra3595-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ── 1. The arming intent ─────────────────────────────────────────────────────

describe('TRA-3595 arming intent — positive matching, no fall-through to a write', () => {
  it('is OFF when unset, blank, or explicitly off', () => {
    expect(parseRebuildIntent(undefined).mode).toBe('off');
    expect(parseRebuildIntent('').mode).toBe('off');
    expect(parseRebuildIntent('   ').mode).toBe('off');
    expect(parseRebuildIntent('off').mode).toBe('off');
  });

  it('accepts dry-run, and dry-run alone needs no book list', () => {
    expect(parseRebuildIntent('dry-run').mode).toBe('dry-run');
    expect(parseRebuildIntent('DRY-RUN').mode).toBe('dry-run');
  });

  it('accepts apply only WITH a book list, and keeps the list verbatim', () => {
    const intent = parseRebuildIntent('apply:admin,v0nni');
    expect(intent.mode).toBe('apply');
    expect(intent.mode === 'apply' && intent.books).toEqual(['admin', 'v0nni']);
  });

  // THE TRA-4420 CONTROL. A bare verb with no target must not become "all".
  it('refuses a bare `apply` — an unstated target is never "every book"', () => {
    const intent = parseRebuildIntent('apply');
    expect(intent.mode).toBe('invalid');
    expect(intent.mode === 'invalid' && intent.reason).toMatch(/names no book/);
  });

  it('refuses `apply:` with an empty list, and every unrecognised value', () => {
    expect(parseRebuildIntent('apply:').mode).toBe('invalid');
    expect(parseRebuildIntent('apply: , ').mode).toBe('invalid');
    expect(parseRebuildIntent('true').mode).toBe('invalid');
    expect(parseRebuildIntent('1').mode).toBe('invalid');
    expect(parseRebuildIntent('--help').mode).toBe('invalid');
    expect(parseRebuildIntent('apply admin').mode).toBe('invalid');
    expect(parseRebuildIntent('applyadmin').mode).toBe('invalid');
  });

  // The mutation of the control above: `invalid` must be DISTINGUISHABLE from
  // `off`. Folding them would make "I set the var and got silence" read exactly
  // like "the deploy did not carry this code" — and the operator's next move
  // from those two readings is different.
  it('an unreadable value is INVALID, never quietly OFF', () => {
    const bad = parseRebuildIntent('aply:admin');
    expect(bad.mode).toBe('invalid');
    expect(bad.mode).not.toBe('off');
    expect(bad.mode === 'invalid' && bad.reason).toMatch(/aply:admin/);
  });
});

describe('TRA-3595 an INVALID arming value reads neither armed nor clean', () => {
  it('publishes verdict INVALID and touches nothing', async () => {
    seedBook('admin', STORED_V1);
    const before = readFileSync(bookPath('admin'), 'utf-8');
    const result = await runCashFlowRebuild({
      dataDir: root,
      env: 'production',
      intent: parseRebuildIntent('apply'),
      fetchCashEvents: async () => {
        throw new Error('the broker must not be reached on an invalid intent');
      },
    });
    expect(result.verdict).toBe('INVALID');
    expect(result.armed).toBe(false);
    expect(result.books).toEqual([]);
    expect(readFileSync(bookPath('admin'), 'utf-8')).toBe(before);
  });
});

// ── 2. Inventory — the fact that had to be inferred on 2026-09-10 ────────────

describe('TRA-3595 inventory publishes record SHAPE per book', () => {
  it('classifies v1, v2 and unreadable separately, and never invents a book', () => {
    seedBook('admin', STORED_V1);
    seedBook('v0nni', { events: EVENTS });
    mkdirSync(join(root, 'users', 'broken'), { recursive: true });
    writeFileSync(bookPath('broken'), '{ not json', 'utf-8');
    mkdirSync(join(root, 'users', 'norecord'), { recursive: true });

    const inv = inventoryCashFlowRecords(root, 'production');
    expect(inv.books.map(b => b.username)).toEqual(['admin', 'broken', 'v0nni']);
    expect(inv.books.find(b => b.username === 'admin')?.schema).toBe('v1-aggregate');
    expect(inv.books.find(b => b.username === 'admin')?.storedDateCount).toBe(4);
    expect(inv.books.find(b => b.username === 'v0nni')?.schema).toBe('v2-typed');
    expect(inv.books.find(b => b.username === 'v0nni')?.eventCount).toBe(5);
    // The discriminator TRA-4506 AC1 actually needs: how many `fee` events the
    // typed record carries. On a v1 record it is `null` — ABSENT, not 0.
    expect(inv.books.find(b => b.username === 'v0nni')?.feeEventCount).toBe(2);
    expect(inv.books.find(b => b.username === 'admin')?.feeEventCount).toBeNull();
    expect(inv.books.find(b => b.username === 'broken')?.schema).toBe('unreadable');
  });

  it('reports the pre-TRA-142 root-level record but never lists it as a book', () => {
    seedBook('admin', STORED_V1);
    writeFileSync(join(root, FILE), '{}', 'utf-8');
    const inv = inventoryCashFlowRecords(root, 'production');
    expect(inv.legacyRootPath).toBe(join(root, FILE));
    expect(inv.books.map(b => b.username)).toEqual(['admin']);
  });

  it('does not pick up a different env`s records', () => {
    seedBook('admin', STORED_V1);
    expect(inventoryCashFlowRecords(root, 'sandbox').books).toEqual([]);
  });
});

// ── 3. The reproduction control ──────────────────────────────────────────────

describe('TRA-3595 the reproduction control', () => {
  it('a faithful fetch reproduces the stored totals under the OLD rule', () => {
    expect(reconcileAgainstStored(STORED_V1.netByDate, netByDateUnderOldRule(EVENTS)).ok).toBe(true);
  });

  it('detects a TRUNCATED fetch — the deposit-deleting direction', () => {
    const verdict = reconcileAgainstStored(
      STORED_V1.netByDate,
      netByDateUnderOldRule(EVENTS.filter(e => e.date !== '2026-07-01')),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.mismatches.map(m => m.date)).toContain('2026-07-01');
  });

  it('detects a stored date the broker no longer reports — the other direction', () => {
    const verdict = reconcileAgainstStored(
      { ...STORED_V1.netByDate, '2026-06-01': 900 },
      netByDateUnderOldRule(EVENTS),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.mismatches.map(m => m.date)).toContain('2026-06-01');
  });

  it('REFUSED outranks CLEAN and BLIND outranks NOOP across books', () => {
    expect(worstOutcome(['CLEAN', 'REFUSED', 'CLEAN'])).toBe('REFUSED');
    expect(worstOutcome(['NOOP', 'BLIND', 'CLEAN'])).toBe('BLIND');
    expect(worstOutcome(['CLEAN', 'NOOP'])).toBe('NOOP');
    expect(worstOutcome(['CLEAN', 'CLEAN'])).toBe('CLEAN');
  });
});

// ── 4. The dry run ───────────────────────────────────────────────────────────

describe('TRA-3595 dry run', () => {
  it('measures the shift with the SHIPPED read-time rule and writes nothing', async () => {
    seedBook('admin', STORED_V1);
    const before = readFileSync(bookPath('admin'), 'utf-8');

    const result = await runCashFlowRebuild({
      dataDir: root,
      env: 'production',
      intent: parseRebuildIntent('dry-run'),
      fetchCashEvents: okFetch(),
      now: new Date('2026-09-16T20:30:00Z'),
    });

    expect(result.verdict).toBe('CLEAN');
    const book = result.books[0]!;
    expect(book.outcome).toBe('CLEAN');
    expect(book.applied).toBe(false);
    expect(book.reproductionOk).toBe(true);
    expect(readFileSync(bookPath('admin'), 'utf-8')).toBe(before);
    expect(existsSync(`${bookPath('admin')}.v1-backup-2026-09-16`)).toBe(false);

    // The two fee days, and only those. `2026-07-01` (deposit only) and
    // `2026-08-10` (dividend — deliberately NOT reclassified by TRA-2906) must
    // not move; if they did, the change under test would not be the fee rule.
    expect(book.movedDates?.map(m => m.date)).toEqual(['2026-07-07', '2026-08-03']);
    const jul7 = book.movedDates?.find(m => m.date === '2026-07-07')!;
    expect(jul7.before).toBe(290);
    expect(jul7.after).toBe(300);   // the fee stops being subtracted from flow…
    expect(jul7.pnlShift).toBe(-10); // …so reported P&L drops by exactly the fee
    const aug3 = book.movedDates?.find(m => m.date === '2026-08-03')!;
    expect(aug3.before).toBe(-10);
    expect(aug3.after).toBe(0);     // a fee-only day leaves netByDate entirely
    expect(aug3.pnlShift).toBe(-10);
    expect(book.totalPnlShiftUsd).toBe(-20);
    expect(book.feeEvents).toEqual([
      { date: '2026-07-07', amount: -10 },
      { date: '2026-08-03', amount: -10 },
    ]);
  });

  // The mutation: with the fees removed from history (and from the stored
  // totals they produced), NOTHING may move. A `movedDates` that is non-empty
  // here would mean the measured shift is not attributable to the fee rule.
  it('a history with no fee events moves no date at all', async () => {
    const noFeeEvents = EVENTS.filter(e => e.type !== 'fee');
    seedBook('admin', {
      netByDate: { '2026-07-01': 500, '2026-07-07': 300, '2026-08-10': 4.25 },
      seenIds: ['a1', 'a2', 'd1'],
    });
    const result = await runCashFlowRebuild({
      dataDir: root,
      env: 'production',
      intent: parseRebuildIntent('dry-run'),
      fetchCashEvents: okFetch(noFeeEvents),
    });
    expect(result.verdict).toBe('CLEAN');
    expect(result.books[0]!.movedDates).toEqual([]);
    expect(result.books[0]!.totalPnlShiftUsd).toBe(0);
  });

  it('REFUSES a truncated fetch and leaves the record byte-identical', async () => {
    seedBook('admin', STORED_V1);
    const before = readFileSync(bookPath('admin'), 'utf-8');
    const result = await runCashFlowRebuild({
      dataDir: root,
      env: 'production',
      intent: parseRebuildIntent('apply:admin'),
      fetchCashEvents: okFetch(EVENTS.filter(e => e.date !== '2026-07-01')),
    });
    expect(result.verdict).toBe('REFUSED');
    expect(result.books[0]!.applied).toBe(false);
    expect(result.books[0]!.mismatches?.map(m => m.date)).toContain('2026-07-01');
    expect(readFileSync(bookPath('admin'), 'utf-8')).toBe(before);
  });
});

// ── 5. BLIND vs REFUSED — two zero-event states that are not the same ────────

describe('TRA-3595 a fetch that never reached the broker is BLIND, not REFUSED', () => {
  it('an HTTP failure reads BLIND and names the status', async () => {
    seedBook('admin', STORED_V1);
    const result = await runCashFlowRebuild({
      dataDir: root,
      env: 'production',
      intent: parseRebuildIntent('apply:admin'),
      fetchCashEvents: async () => ({
        ok: false, events: [], detail: 'Tradier history HTTP 401 Unauthorized',
      }),
    });
    expect(result.verdict).toBe('BLIND');
    expect(result.books[0]!.outcome).toBe('BLIND');
    expect(result.books[0]!.detail).toMatch(/401/);
    expect(result.books[0]!.applied).toBe(false);
  });

  // The mutation that gives the control its teeth: the SAME zero events, this
  // time reported as a successful fetch, must read REFUSED. If both paths
  // produced the same verdict the distinction would be decorative.
  it('the SAME zero events from a SUCCESSFUL fetch read REFUSED instead', async () => {
    seedBook('admin', STORED_V1);
    const result = await runCashFlowRebuild({
      dataDir: root,
      env: 'production',
      intent: parseRebuildIntent('apply:admin'),
      fetchCashEvents: async () => ({ ok: true, events: [], detail: '' }),
    });
    expect(result.verdict).toBe('REFUSED');
    expect(result.books[0]!.applied).toBe(false);
  });

  it('the host fetcher reports missing credentials rather than returning zero events ok', async () => {
    const fetcher = buildHostCashEventFetcher({} as NodeJS.ProcessEnv);
    const out = await fetcher('2026-01-01', '2026-09-16');
    expect(out.ok).toBe(false);
    expect(out.events).toEqual([]);
    expect(out.detail).toMatch(/TRADIER_API_TOKEN/);
  });
});

// ── 6. Fail closed on an empty data dir ──────────────────────────────────────

describe('TRA-3595 a run that found nothing is BLIND, never CLEAN', () => {
  it('reports BLIND when no book carries a record', async () => {
    const result = await runCashFlowRebuild({
      dataDir: root,
      env: 'production',
      intent: parseRebuildIntent('dry-run'),
      fetchCashEvents: okFetch(),
    });
    expect(result.verdict).toBe('BLIND');
    expect(result.reason).toMatch(/unmounted DATA_DIR/);
  });
});

// ── 7. Apply ─────────────────────────────────────────────────────────────────

describe('TRA-3595 apply', () => {
  it('writes v2, backs up v1, reads back, and leaves unnamed books untouched', async () => {
    seedBook('admin', STORED_V1);
    seedBook('v0nni', STORED_V1);
    const v0nniBefore = readFileSync(bookPath('v0nni'), 'utf-8');

    const result = await runCashFlowRebuild({
      dataDir: root,
      env: 'production',
      intent: parseRebuildIntent('apply:admin'),
      fetchCashEvents: okFetch(),
      now: new Date('2026-09-16T20:30:00Z'),
    });

    expect(result.verdict).toBe('CLEAN');
    const admin = result.books.find(b => b.username === 'admin')!;
    expect(admin.outcome).toBe('CLEAN');
    expect(admin.applied).toBe(true);

    const written = JSON.parse(readFileSync(bookPath('admin'), 'utf-8'));
    expect(Array.isArray(written.events)).toBe(true);
    expect(written.events).toHaveLength(EVENTS.length);
    expect(written.netByDate).toBeUndefined(); // never HALF migrated
    expect(inventoryCashFlowRecords(root, 'production')
      .books.find(b => b.username === 'admin')?.schema).toBe('v2-typed');

    const backup = `${bookPath('admin')}.v1-backup-2026-09-16`;
    expect(admin.backupPath).toBe(backup);
    expect(JSON.parse(readFileSync(backup, 'utf-8')).netByDate).toEqual(STORED_V1.netByDate);

    // The book the operator did NOT name is bit-for-bit unchanged and is
    // reported as SKIPPED, not silently absent from the result.
    const v0nni = result.books.find(b => b.username === 'v0nni')!;
    expect(v0nni.outcome).toBe('SKIPPED');
    expect(readFileSync(bookPath('v0nni'), 'utf-8')).toBe(v0nniBefore);
  });

  it('is idempotent — a second apply over a v2 record is NOOP, not a rewrite', async () => {
    seedBook('admin', { events: EVENTS });
    const before = readFileSync(bookPath('admin'), 'utf-8');
    const result = await runCashFlowRebuild({
      dataDir: root,
      env: 'production',
      intent: parseRebuildIntent('apply:admin'),
      fetchCashEvents: async () => {
        throw new Error('a v2 record must be decided before any fetch');
      },
    });
    expect(result.verdict).toBe('NOOP');
    expect(result.books[0]!.applied).toBe(false);
    expect(readFileSync(bookPath('admin'), 'utf-8')).toBe(before);
  });

  it('refuses to name a verdict for a record it cannot parse', async () => {
    mkdirSync(join(root, 'users', 'broken'), { recursive: true });
    writeFileSync(bookPath('broken'), '{ not json', 'utf-8');
    const result = await runCashFlowRebuild({
      dataDir: root,
      env: 'production',
      intent: parseRebuildIntent('apply:broken'),
      fetchCashEvents: okFetch(),
    });
    expect(result.verdict).toBe('BLIND');
  });
});
