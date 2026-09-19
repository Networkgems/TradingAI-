import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordLiveOptionFill,
  hydrateLiveOptionsFeeSlippageFromDisk,
  summarizeLiveOptionsFeeSlippage,
  clearLiveOptionsFeeSlippageLedger,
  liveOptionsFeeSlippageLogPath,
  liveOptionsFillArchivePath,
  liveOptionFillRecords,
  liveOptionPromotionEvidenceRecords,
  liveOptionEvidenceCoverage,
  type LiveOptionFillInput,
} from './live-options-fee-slippage-ledger.js';
import { computeValidationProgress } from './validation-progress.js';

// TRA-4727 — promotion evidence must be CUMULATIVE. The 30-day calibration
// window compacted fills away on every boot (bqb1 2026-09-19T17:21Z: fillsSeen
// 41 → 31, and closes whose OPEN aged out read `noMatchingOpen`). Aged rows now
// move to a never-pruned archive and validation-progress grades archive ∪ window.

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 7, 1, 14, 0, 0);

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'tra4727-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  clearLiveOptionsFeeSlippageLedger();
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function leg(ts: number, side: LiveOptionFillInput['side'], price: number): LiveOptionFillInput {
  return {
    ts,
    etDay: new Date(ts).toISOString().slice(0, 10),
    sleeve: 'single_leg_otm',
    book: 'admin',
    optionSymbol: 'ATEC260918C00011000',
    side,
    contracts: 1,
    submittedLimit: price,
    askAtSubmit: price,
    midAtSubmit: price,
    filledPrice: price,
    fees: 0.5,
    feeSource: 'history_commission',
    orderId: side === 'buy_to_open' ? 101 : 102,
  };
}

/** Open at T0, close at T0+31d, both written through the live append path. */
function writeAgedRoundTrip(dir: string): void {
  hydrateLiveOptionsFeeSlippageFromDisk(dir, T0);
  recordLiveOptionFill(leg(T0, 'buy_to_open', 1.0));
  recordLiveOptionFill(leg(T0 + 31 * DAY, 'sell_to_close', 1.5));
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '') : [];
}

describe('TRA-4727 — cumulative promotion evidence', () => {
  it('AC2: open at T0, close at T0+31d, reboot-hydrate at T0+32d ⇒ 1 round-trip, noMatchingOpen 0', () => {
    const dir = freshDir();
    writeAgedRoundTrip(dir);
    hydrateLiveOptionsFeeSlippageFromDisk(dir, T0 + 32 * DAY);

    const r = computeValidationProgress();
    expect(r.roundTrips).toBe(1);
    expect(r.excluded.noMatchingOpen).toBe(0);
    expect(r.fillsSeen).toBe(2);
    expect(r.sleeves.find((s) => s.sleeve === 'single_leg_otm')!.verdict.observedN).toBe(1);
  });

  it('negative control: the WINDOW alone manufactures noMatchingOpen — the defect this fixes', () => {
    // Same boot, same rows. Grading the 30-day window (what TRA-4607 shipped)
    // loses the open and books the close as unmatched. If this went green, the
    // arm above would not be proving the archive does anything.
    const dir = freshDir();
    writeAgedRoundTrip(dir);
    hydrateLiveOptionsFeeSlippageFromDisk(dir, T0 + 32 * DAY);

    const windowOnly = computeValidationProgress(liveOptionFillRecords());
    expect(windowOnly.roundTrips).toBe(0);
    expect(windowOnly.excluded.noMatchingOpen).toBe(1);
  });

  it('the calibration window itself is unchanged: the aged open leaves `fills` and the main file', () => {
    const dir = freshDir();
    writeAgedRoundTrip(dir);
    hydrateLiveOptionsFeeSlippageFromDisk(dir, T0 + 32 * DAY);

    expect(summarizeLiveOptionsFeeSlippage().n).toBe(1);
    expect(lines(liveOptionsFeeSlippageLogPath(dir))).toHaveLength(1);
    expect(lines(liveOptionsFillArchivePath(dir))).toHaveLength(1);
  });

  it('survives further reboots: both legs aged ⇒ still 1 round-trip, archive holds each row ONCE', () => {
    const dir = freshDir();
    writeAgedRoundTrip(dir);
    hydrateLiveOptionsFeeSlippageFromDisk(dir, T0 + 32 * DAY);
    hydrateLiveOptionsFeeSlippageFromDisk(dir, T0 + 100 * DAY);
    hydrateLiveOptionsFeeSlippageFromDisk(dir, T0 + 101 * DAY);

    expect(summarizeLiveOptionsFeeSlippage().n).toBe(0);
    expect(lines(liveOptionsFeeSlippageLogPath(dir))).toHaveLength(0);
    expect(lines(liveOptionsFillArchivePath(dir))).toHaveLength(2);
    expect(computeValidationProgress().roundTrips).toBe(1);
  });

  it('AC3: publishes retentionDays and the earliest fill ts, so a truncated window is visible', () => {
    const dir = freshDir();
    writeAgedRoundTrip(dir);
    hydrateLiveOptionsFeeSlippageFromDisk(dir, T0 + 32 * DAY);

    const c = computeValidationProgress().coverage!;
    expect(c.retentionDays).toBe(30);
    expect(c.earliestFillTs).toBe(T0);
    expect(c.earliestWindowFillTs).toBe(T0 + 31 * DAY);
    expect(c.windowFills).toBe(1);
    expect(c.archivedFills).toBe(1);
    expect(c.evidenceFills).toBe(2);
    expect(c.archiveErrors).toBe(0);
    // A caller-supplied fixture carries no coverage claim about the process tape.
    expect(computeValidationProgress([]).coverage).toBeNull();
  });

  it('an unwritable archive SKIPS the compaction — the aged row stays on disk, counted', () => {
    const dir = freshDir();
    writeAgedRoundTrip(dir);
    // A directory where the archive file should be ⇒ appendFileSync throws.
    mkdirSync(liveOptionsFillArchivePath(dir));
    hydrateLiveOptionsFeeSlippageFromDisk(dir, T0 + 32 * DAY);

    expect(lines(liveOptionsFeeSlippageLogPath(dir))).toHaveLength(2);
    const c = liveOptionEvidenceCoverage();
    expect(c.archiveErrors).toBe(1);
    expect(c.lastArchiveError).not.toBeNull();
    // Still graded this boot from memory, and the window still excludes it.
    expect(computeValidationProgress().roundTrips).toBe(1);
    expect(summarizeLiveOptionsFeeSlippage().n).toBe(1);
  });

  it('a row in BOTH files (archived, then compaction failed) is counted once', () => {
    const dir = freshDir();
    writeAgedRoundTrip(dir);
    const open = lines(liveOptionsFeeSlippageLogPath(dir))[0]!;
    writeFileSync(liveOptionsFillArchivePath(dir), open + '\n', 'utf8');
    // Hydrate INSIDE the window: the open is still in the main file too.
    hydrateLiveOptionsFeeSlippageFromDisk(dir, T0 + 31 * DAY + 1);

    expect(liveOptionPromotionEvidenceRecords()).toHaveLength(2);
    expect(computeValidationProgress().roundTrips).toBe(1);
    // And ageing it out later does not append a second archive copy.
    hydrateLiveOptionsFeeSlippageFromDisk(dir, T0 + 32 * DAY);
    expect(lines(liveOptionsFillArchivePath(dir))).toHaveLength(1);
    expect(liveOptionPromotionEvidenceRecords()).toHaveLength(2);
  });
});
