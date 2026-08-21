/**
 * TRA-3805 (measure 3 of TRA-3800) — the `unmatched_symbols` dedupe was keyed on
 * the SET, and sharded batches flipped the key on every call.
 *
 * The acceptance fixture is the three consecutive shards recorded on bqb1 at
 * 2026-08-16T18:11:27.4 / :28.9 / :29.7 — 2.3 seconds end to end, one tick.
 *
 * ⚠ The ticket's own acceptance line says "**1** line, not 3". Its fixture cannot
 * produce 1: shard C carries `ASML.AS`, which the ticket itself states "appears in
 * neither of the other two", and a per-symbol ledger is *required* (by the ticket's
 * own scope item 1, and by the sibling acceptance bullet "a genuinely new
 * un-servable ticker still produces its own line") to announce it. The correct
 * count for this fixture is **2**, and the third shard's line must name ASML.AS
 * and nothing else. Asserting 1 would only be reachable by dropping a first-sight
 * ticker on the floor, which is the failure mode TRA-3385 exists to prevent.
 *
 * The number that actually settles the incident is the SECOND tick: replaying the
 * same three shards again emits **0**. The live tape read ~10.9 lines/minute
 * because every tick paid three lines forever; under the fix a steady universe
 * pays nothing after first sight.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  announceSymbols,
  announceSymbolOnce,
  getSymbolLogSuppressionState,
  __resetSymbolLogDedupeForTests,
  SYMBOL_ANNOUNCE_TTL_MS,
} from './symbol-log-dedupe.js';
import { recordTradierUnmatched, __resetTradierUnmatchedForTests } from './yahoo-feed.js';

const HERE = join(fileURLToPath(import.meta.url), '..');

// The 24 foreign tickers that are unmatched by the primary on EVERY tick and are
// priced perfectly well by the Yahoo secondary (see `unservable-symbols.ts`
// header, point 2). Reconstructed to the shape the tape recorded — the sizes
// (26 / 24 / 14), the subset relations, and ASML.AS unique to shard C are the
// load-bearing properties; the ticket quotes the shard sizes but truncates the
// membership, so the individual names below stand in for it.
const FOREIGN_24 = [
  'AZN.L', 'ARX.TO', '2330.TW', 'BAYN.DE', 'BB.TO', 'SAP.DE', 'SHEL.L', 'BP.L',
  'RY.TO', 'TD.TO', 'ENB.TO', 'CNQ.TO', 'SIE.DE', 'ALV.DE', 'MC.PA', 'OR.PA',
  'NESN.SW', 'ROG.SW', '7203.T', '6758.T', '005930.KS', '0700.HK', 'RIO.L', 'GLEN.L',
];
// 18:11:27.4 — shard 1, 26/26: the foreign names PLUS the two delisted US tickers.
const SHARD_A = [...FOREIGN_24, 'SBLX', 'SELX'];
// 18:11:28.9 — shard 2, 24/596: the same list MINUS SBLX, SELX.
const SHARD_B = [...FOREIGN_24];
// 18:11:29.7 — shard 3, 14/140: 14 names, including ASML.AS which is in neither
// of the other two.
const SHARD_C = [...FOREIGN_24.slice(0, 13), 'ASML.AS'];

beforeEach(() => {
  __resetSymbolLogDedupeForTests();
});

describe('TRA-3805 acceptance — the three-shard replay', () => {
  it('emits 2 lines for the three shards (the ticket says 1; its own fixture says 2 — see header)', () => {
    const lines = [
      recordTradierUnmatched(SHARD_A, 26),
      recordTradierUnmatched(SHARD_B, 596),
      recordTradierUnmatched(SHARD_C, 140),
    ];
    const emitted = lines.filter((l): l is string => l !== null);
    expect(emitted).toHaveLength(2);

    // Shard B is wholly-announced ⇒ silent. This is the assertion the old
    // set-keyed guard failed: B differs from A, so its key differed, so it logged.
    expect(lines[1]).toBeNull();

    // Shard C is not silent, and it must name ONLY the newly-seen ticker — the
    // other 13 rode along in shard A and must not be repeated.
    expect(lines[2]).toContain('ASML.AS');
    for (const sym of FOREIGN_24) expect(lines[2]).not.toContain(sym);
  });

  it('emits 0 lines on the next tick — the ~10.9 lines/minute incident', () => {
    recordTradierUnmatched(SHARD_A, 26);
    recordTradierUnmatched(SHARD_B, 596);
    recordTradierUnmatched(SHARD_C, 140);
    // Tick 2, same three shards, same membership.
    expect(recordTradierUnmatched(SHARD_A, 26)).toBeNull();
    expect(recordTradierUnmatched(SHARD_B, 596)).toBeNull();
    expect(recordTradierUnmatched(SHARD_C, 140)).toBeNull();
    // And a re-shard on tick 3 — different sizes, same union — is still silent.
    expect(recordTradierUnmatched([...SHARD_C, 'SBLX'], 300)).toBeNull();
    expect(recordTradierUnmatched([...FOREIGN_24.slice(5), 'SELX'], 41)).toBeNull();
  });

  it('a genuinely new un-servable ticker on shard 4 still produces its own line', () => {
    recordTradierUnmatched(SHARD_A, 26);
    recordTradierUnmatched(SHARD_B, 596);
    recordTradierUnmatched(SHARD_C, 140);
    const line = recordTradierUnmatched([...FOREIGN_24.slice(0, 5), 'NEWDEAD'], 88);
    expect(line).not.toBeNull();
    expect(line).toContain('NEWDEAD');
    expect(line).toContain('1 newly un-servable');
  });

  it('keeps the TRA-3385 guarantee: the FULL membership, never a capped prefix', () => {
    const line = recordTradierUnmatched(SHARD_A, 26)!;
    expect(line).not.toBeNull();
    for (const sym of SHARD_A) expect(line).toContain(sym);
    expect(line).toContain('26 newly un-servable');
    // and the batch census survives, so a reader still sees how big the set was
    expect(line).toContain('26/26 unmatched in this batch');
    // The union of what was emitted is the membership: nothing is dropped, so the
    // published set matches what the shard actually carried.
    expect(getSymbolLogSuppressionState().tradierUnmatched.announcedKeys).toEqual([...SHARD_A].sort());
  });

  it('is order-insensitive and stays silent on an empty set without consuming a slot', () => {
    expect(recordTradierUnmatched([], 670)).toBeNull();
    expect(recordTradierUnmatched(['ARX.TO', 'BB.TO'], 670)).not.toBeNull();
    expect(recordTradierUnmatched(['BB.TO', 'ARX.TO'], 671)).toBeNull();
  });
});

describe('TRA-3805 — the ledger itself', () => {
  it('announces each key once and re-announces only after the TTL lapses', () => {
    const t0 = 1_700_000_000_000;
    expect(announceSymbols('tradierUnmatched', ['SBLX', 'SELX'], t0)).toEqual(['SBLX', 'SELX']);
    expect(announceSymbols('tradierUnmatched', ['SELX', 'SBLX'], t0 + 30_000)).toEqual([]);
    // One millisecond short of the window: still suppressed.
    expect(announceSymbols('tradierUnmatched', ['SBLX'], t0 + SYMBOL_ANNOUNCE_TTL_MS - 1)).toEqual([]);
    expect(announceSymbols('tradierUnmatched', ['SBLX'], t0 + SYMBOL_ANNOUNCE_TTL_MS)).toEqual(['SBLX']);
    // …and the re-statement is counted as such, not as a new arrival.
    const s = getSymbolLogSuppressionState(t0 + SYMBOL_ANNOUNCE_TTL_MS);
    expect(s.tradierUnmatched.reAnnouncements).toBe(1);
  });

  it('collapses a key repeated inside one call', () => {
    expect(announceSymbols('tradierUnmatched', ['SBLX', 'SBLX', 'SELX'], 1)).toEqual(['SBLX', 'SELX']);
    expect(getSymbolLogSuppressionState(1).tradierUnmatched.mentionsSuppressed).toBe(1);
  });

  it('keeps the families separate — a quiet stooq cannot read as a quiet tradier', () => {
    announceSymbols('tradierUnmatched', ['ARX.TO'], 1);
    const s = getSymbolLogSuppressionState(1);
    expect(s.tradierUnmatched.calls).toBe(1);
    expect(s.stooqNonOk.calls).toBe(0);
    expect(s.stooqNonOk.announcedKeys).toEqual([]);
  });

  it('keys stooq on (symbol, status) so a 404 cannot swallow a later 429', () => {
    expect(announceSymbolOnce('stooqNonOk', 'SBLX#404', 1)).toBe(true);
    expect(announceSymbolOnce('stooqNonOk', 'SBLX#404', 2)).toBe(false);
    expect(announceSymbolOnce('stooqNonOk', 'SBLX#429', 3)).toBe(true);
    expect(announceSymbolOnce('stooqNonOk', 'SBLX#unparseable', 4)).toBe(true);
  });
});

describe('TRA-3805 — the suppression ships a counter with a failing state', () => {
  it('separates "suppressed 11k lines" from "the emitter died"', () => {
    // The emitter never ran.
    expect(getSymbolLogSuppressionState(1).tradierUnmatched).toMatchObject({
      calls: 0,
      linesEmitted: 0,
      linesSuppressed: 0,
    });

    // It ran, and stayed quiet on purpose.
    recordTradierUnmatched(SHARD_A, 26);
    for (let tick = 0; tick < 10; tick++) {
      recordTradierUnmatched(SHARD_A, 26);
      recordTradierUnmatched(SHARD_B, 596);
    }
    const s = getSymbolLogSuppressionState().tradierUnmatched;
    expect(s.calls).toBe(21);
    expect(s.linesEmitted).toBe(1);
    expect(s.linesSuppressed).toBe(20);
    expect(s.mentionsSuppressed).toBe(26 * 10 + 24 * 10);
    expect(s.announcedCount).toBe(26);
    expect(s.ttlMs).toBe(SYMBOL_ANNOUNCE_TTL_MS);
  });

  it('publishes every counter as a REAL field — presence, never `?? 0`', () => {
    const s = getSymbolLogSuppressionState(1);
    for (const family of ['tradierUnmatched', 'stooqNonOk'] as const) {
      for (const field of [
        'calls', 'linesEmitted', 'linesSuppressed', 'mentionsSeen',
        'mentionsSuppressed', 'reAnnouncements', 'announcedCount', 'ttlMs',
      ]) {
        expect(Object.prototype.hasOwnProperty.call(s[family], field)).toBe(true);
      }
      expect(Array.isArray(s[family].announcedKeys)).toBe(true);
    }
  });
});

describe('TRA-3805 — the health ROUTE publishes it (field name checked in index.ts)', () => {
  // The rule this encodes: check the field name in the ROUTE file, not just the
  // emitter — an emitter with perfect counters that nothing serialises reads
  // exactly like a deploy that predates the change. Both sides are derived: the
  // family list comes from the shipped function, not from a literal retyped here.
  const indexSrc = readFileSync(join(HERE, 'index.ts'), 'utf8');

  it('wires `logSuppression` to the shipped getter inside the health payload', () => {
    expect(indexSrc).toContain('logSuppression: getSymbolLogSuppressionState(),');
    expect(indexSrc).toContain("await import('./symbol-log-dedupe.js')");
  });

  it('sits in the same payload literal as the TRA-3804 block it is a sibling of', () => {
    const unservableAt = indexSrc.indexOf('unservableSymbols: getUnservableSymbolsState(),');
    const suppressionAt = indexSrc.indexOf('logSuppression: getSymbolLogSuppressionState(),');
    expect(unservableAt).toBeGreaterThan(-1);
    expect(suppressionAt).toBeGreaterThan(unservableAt);
    // `bootEnv,` / `results,` close that literal; being between the TRA-3804 block
    // and them proves same-object membership without executing the route (which
    // needs a live app + live provider probes).
    const bootEnvAt = indexSrc.indexOf('    bootEnv,', suppressionAt);
    expect(bootEnvAt).toBeGreaterThan(suppressionAt);
    expect(indexSrc.indexOf('    results,', bootEnvAt)).toBeGreaterThan(bootEnvAt);
  });

  it('names every family the shipped getter actually returns', () => {
    for (const family of Object.keys(getSymbolLogSuppressionState(1))) {
      expect(family).toMatch(/^(tradierUnmatched|stooqNonOk)$/);
    }
  });
});

describe('TRA-3805 — the stooq emitter calls the ledger', () => {
  const stooqSrc = readFileSync(join(HERE, 'stooq-feed.ts'), 'utf8');

  it('guards the non-OK-status warn (the line the ticket names)', () => {
    expect(stooqSrc).toContain("announceSymbolOnce('stooqNonOk', `${symbol}#${resp.status}`)");
  });

  it('leaves the transport-fault warn UNGUARDED — transient faults must recur', () => {
    const catchAt = stooqSrc.indexOf("log.warn('quote fetch failed'");
    expect(catchAt).toBeGreaterThan(-1);
    const line = stooqSrc.slice(stooqSrc.lastIndexOf('\n', catchAt), catchAt);
    expect(line).not.toContain('announceSymbolOnce');
  });
});

describe('TRA-3805 — the old set-keyed dedupe is gone, not merely bypassed', () => {
  const yahooSrc = readFileSync(join(HERE, 'yahoo-feed.ts'), 'utf8');

  it('no per-call membership key survives in recordTradierUnmatched', () => {
    const at = yahooSrc.indexOf('export function recordTradierUnmatched');
    expect(at).toBeGreaterThan(-1);
    const body = yahooSrc.slice(at, yahooSrc.indexOf('\n}', at));
    expect(body).toContain("announceSymbols('tradierUnmatched'");
    // The exact shape that thrashed: a sorted join used as the dedupe key.
    expect(body).not.toMatch(/lastUnmatchedLoggedKey/);
    expect(body).not.toMatch(/=== *last\w*Key/);
  });

  it('the test seam clears the ledger (a stale seam leaves cross-test bleed)', () => {
    recordTradierUnmatched(SHARD_A, 26);
    expect(getSymbolLogSuppressionState().tradierUnmatched.announcedCount).toBe(26);
    __resetTradierUnmatchedForTests();
    expect(getSymbolLogSuppressionState().tradierUnmatched.announcedCount).toBe(0);
    expect(recordTradierUnmatched(SHARD_A, 26)).not.toBeNull();
  });
});
