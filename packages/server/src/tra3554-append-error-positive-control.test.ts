import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordLiveOptionFill,
  hydrateLiveOptionsFeeSlippageFromDisk,
  summarizeLiveOptionsFeeSlippage,
  clearLiveOptionsFeeSlippageLedger,
  liveOptionsFeeSlippageLogPath,
  backfillLiveOptionFeesFromGainLoss,
} from './live-options-fee-slippage-ledger.js';
import type { TradierGainLossLot } from '@trading-app/engine';

// TRA-3554 (TRA-2819 ask 4, part B) — POSITIVE CONTROL for the ledger's
// append-failure counter.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
// `durability.appendErrors` / `lastAppendError` are the ONLY signal that a
// swallowed ledger write lost a real fill. On 2026-08-04 they read
// `0` / `null` while 64% of filled orders were missing from the ledger, and that
// clean reading was consumed as health. TRA-2959 correctly diagnosed THAT
// incident as a different failure class — the writer was never CALLED, so a
// write-failure counter had nothing to count — and shipped the broker-history
// coverage cross-check to catch it.
//
// But that diagnosis left an unexamined premise: it assumed the counter WORKS
// when the writer *is* called and the write *does* fail. Before this file, no
// test in the repo touched `appendErrors` at all. The counter had only ever been
// observed at 0 in production. A counter observed only at 0 has not been shown
// to work — it has been shown to be QUIET, and those two readings are identical
// from the outside. That is precisely the shape ask 4 refuses to accept.
//
// ── WHAT A HONEST CONTROL REQUIRES ───────────────────────────────────────────
// 1. The failure must be forced through the REAL production line
//    (`appendFileSync` inside `recordLiveOptionFill`), not a stubbed module. We
//    make the append target a DIRECTORY, so the real call throws a real errno.
//    The control CONTAINS the thing it detects.
// 2. The counter must be controlled in BOTH directions. A counter that only ever
//    increments is exactly as useless as one that never does, and a positive
//    control alone cannot tell those apart — so a clean append must be shown to
//    leave it at 0 in the same file.
// 3. The counter's CLAIM must be checked, not just its value. `appendErrors > 0`
//    advertises "the record counts above overstate what is on disk". We assert
//    that divergence directly (in-memory n vs on-disk lines); otherwise the
//    counter could increment and still be telling a lie.
//
// Errno is deliberately NOT asserted: writing to a directory is EISDIR on Linux
// and EPERM/EACCES on Windows. Asserting a non-empty message keeps the control
// portable while still proving `lastAppendError` is populated rather than null.

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'tra3554-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  clearLiveOptionsFeeSlippageLedger();
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

/** One live fill input; `ts`/`optionSymbol` line up with {@link lot} for the back-fill leg. */
function fill(over: Partial<Parameters<typeof recordLiveOptionFill>[0]> = {}) {
  return {
    ts: 1000,
    etDay: '2026-07-16',
    sleeve: 'single_leg_otm' as const,
    optionSymbol: 'AAPL240705C00210000',
    side: 'buy_to_open' as const,
    contracts: 1,
    submittedLimit: 0.82,
    askAtSubmit: 0.82,
    midAtSubmit: 0.8,
    filledPrice: 0.83,
    fees: null,
    orderId: 42,
    ...over,
  };
}

/** Settled lot matching {@link fill}: 83.00 gross + 0.11 open-side fee. */
function lot(over: Partial<TradierGainLossLot> = {}): TradierGainLossLot {
  return {
    symbol: 'AAPL240705C00210000',
    quantity: 1,
    cost: 83.11,
    proceeds: 199.87,
    gainLoss: 116.76,
    openDate: '2026-07-16',
    closeDate: '2026-07-20',
    ...over,
  };
}

/** Make the ledger's append target un-writable by putting a DIRECTORY where the file goes. */
function jamAppendTarget(dir: string): string {
  const path = liveOptionsFeeSlippageLogPath(dir);
  try { rmSync(path, { force: true }); } catch { /* may not exist yet */ }
  mkdirSync(path, { recursive: true });
  expect(statSync(path).isDirectory()).toBe(true); // the jam is real, not assumed
  return path;
}

/** Durable lines currently on disk (0 when the target is jammed/absent). */
function diskLines(dir: string): number {
  try {
    const raw = readFileSync(liveOptionsFeeSlippageLogPath(dir), 'utf8');
    return raw.split('\n').filter((l) => l.trim() !== '').length;
  } catch {
    return 0;
  }
}

describe('append-failure counter positive control (TRA-3554 / TRA-2819 ask 4B)', () => {
  // ── Direction 1: the counter is not stuck ON ────────────────────────────────

  it('NEGATIVE control: a clean append leaves appendErrors 0 and lastAppendError null', () => {
    const dir = freshDir();
    hydrateLiveOptionsFeeSlippageFromDisk(dir, 1000);
    recordLiveOptionFill(fill());

    const s = summarizeLiveOptionsFeeSlippage();
    expect(s.n).toBe(1);
    expect(s.durability.appendErrors).toBe(0);
    expect(s.durability.lastAppendError).toBeNull();
    // The clean reading is BACKED: the row really is on disk. Without this the
    // "0 errors" assertion would pass just as happily against a silent no-write.
    expect(diskLines(dir)).toBe(1);
  });

  // ── Direction 2: the counter is not stuck OFF ───────────────────────────────

  it('POSITIVE control: a forced append failure increments appendErrors and populates lastAppendError', () => {
    const dir = freshDir();
    hydrateLiveOptionsFeeSlippageFromDisk(dir, 1000);
    jamAppendTarget(dir);

    recordLiveOptionFill(fill());

    const s = summarizeLiveOptionsFeeSlippage();
    expect(s.durability.appendErrors).toBe(1);
    expect(typeof s.durability.lastAppendError).toBe('string');
    expect(s.durability.lastAppendError).not.toBe('');
    expect(s.durability.lastAppendError).not.toBeNull();
  });

  it('the swallow protects the trade pass: the fill is still recorded in memory after the append fails', () => {
    const dir = freshDir();
    hydrateLiveOptionsFeeSlippageFromDisk(dir, 1000);
    jamAppendTarget(dir);

    expect(() => recordLiveOptionFill(fill())).not.toThrow();

    const s = summarizeLiveOptionsFeeSlippage();
    expect(s.n).toBe(1);
    expect(s.records[0]!.optionSymbol).toBe('AAPL240705C00210000');
    expect(s.lastRecordAt).toBe(1000);
  });

  it("the counter's CLAIM holds: appendErrors > 0 means the in-memory count really does overstate disk", () => {
    const dir = freshDir();
    hydrateLiveOptionsFeeSlippageFromDisk(dir, 1000);
    recordLiveOptionFill(fill({ ts: 1000 }));      // lands on disk
    expect(diskLines(dir)).toBe(1);

    jamAppendTarget(dir);                          // disk now holds NOTHING
    recordLiveOptionFill(fill({ ts: 2000 }));      // memory-only
    recordLiveOptionFill(fill({ ts: 3000 }));      // memory-only

    const s = summarizeLiveOptionsFeeSlippage();
    expect(s.durability.appendErrors).toBe(2);     // one per failed append, not one per episode
    expect(s.n).toBe(3);
    // The divergence the counter exists to advertise, asserted rather than trusted.
    expect(diskLines(dir)).toBeLessThan(s.n);
  });

  it('the back-fill REWRITE path is counted too — the second swallow site (TRA-2850)', () => {
    const dir = freshDir();
    hydrateLiveOptionsFeeSlippageFromDisk(dir, 1000);
    recordLiveOptionFill(fill());
    expect(summarizeLiveOptionsFeeSlippage().durability.appendErrors).toBe(0);

    // Jam AFTER the fill lands, so the failure is isolated to the rewrite.
    jamAppendTarget(dir);
    const { updated } = backfillLiveOptionFeesFromGainLoss([lot()]);
    expect(updated).toBe(1); // the derivation itself must still succeed...

    const s = summarizeLiveOptionsFeeSlippage();
    expect(s.durability.appendErrors).toBe(1); // ...and its lost durable write is COUNTED
    expect(typeof s.durability.lastAppendError).toBe('string');
    // In-memory fee is applied even though it never reached disk — which is exactly
    // why the counter has to be read next to it.
    expect(s.records[0]!.fees).toBeCloseTo(0.11, 6);
    expect(s.feesMeasured).toBe(1);
  });

  // ── The counter must not carry a stale alarm across a boot ──────────────────

  it('a hydrate clears the counter — a fresh boot does not inherit the previous run alarm', () => {
    const dir = freshDir();
    hydrateLiveOptionsFeeSlippageFromDisk(dir, 1000);
    const path = jamAppendTarget(dir);
    recordLiveOptionFill(fill());
    expect(summarizeLiveOptionsFeeSlippage().durability.appendErrors).toBe(1);

    // Un-jam and re-boot: the ledger re-reads disk and the alarm resets to the
    // state of THIS process, not the last one.
    rmSync(path, { recursive: true, force: true });
    hydrateLiveOptionsFeeSlippageFromDisk(dir, 2000);

    const s = summarizeLiveOptionsFeeSlippage();
    expect(s.durability.appendErrors).toBe(0);
    expect(s.durability.lastAppendError).toBeNull();
    // ...and the loss is still visible in the honest place: the row never made disk.
    expect(s.n).toBe(0);
    expect(s.durability.hydratedRecords).toBe(0);
  });
});
