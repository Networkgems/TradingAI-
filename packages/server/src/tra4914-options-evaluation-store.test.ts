import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OPTIONS_EVAL_REPORT_FLAG,
  isOptionsEvalReportEnabled,
  listOptionsEvaluationReportDates,
  readLatestOptionsEvaluationReport,
  recordOptionsEvaluationReport,
} from './options-evaluation-report-store.js';
import { applyModelFacingFoldBasis } from './model-facing-journal.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';

// TRA-4914 — the SCHEDULED ARTIFACT. What is under test is the contract that
// makes the artifact readable rather than the statistics inside it (those are
// covered in tra4914-options-evaluation-report.test.ts): the flag must be a true
// zero-IO no-op, an absent artifact must read as ABSENT rather than as an empty
// report, and a late (replayed-slot) write must be labelled as late.

let dataDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'tra4914-'));
  env = { DATA_DIR: dataDir, [OPTIONS_EVAL_REPORT_FLAG]: '1' };
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function closedRow(
  id: string,
  closeTs: number,
  pnl: number,
  mode: 'demo' | 'live' = 'demo',
): OptionTradeJournalRecord {
  return {
    id,
    openTs: 1,
    symbol: 'AAPL',
    structure: 'single_leg_rv',
    mode,
    ivRank: null,
    trend: 'up',
    sentiment: null,
    entryDelta: 0.5,
    entryDte: 40,
    atRiskUsd: 100,
    outcome: pnl > 0 ? 'WIN' : 'LOSS',
    closeTs,
    realizedPnlUsd: pnl,
    realizedR: pnl / 100,
    exitReason: 'trail',
    holdDays: 1,
    contracts: 1,
    entrySlippageUsd: 1,
    exitSlippageUsd: 1,
  };
}

const rows = [closedRow('a', 10, 20), closedRow('b', 20, -5)];

/**
 * The fold seam, driven through the REAL `applyModelFacingFoldBasis` over a
 * pooled row list rather than hand-stubbed.
 *
 * TRA-5001 — `modeExcluded` is the number this ticket exists to publish, so a
 * stub that just asserts whatever integer the test wants would pass while the
 * production pin counted something else. Running the real predicate means the
 * count under test is the count the pin produces.
 */
const foldOf = (pooled: readonly OptionTradeJournalRecord[]) => async () =>
  applyModelFacingFoldBasis(pooled, { env: {} });

const loadFold = foldOf(rows);

describe('options evaluation report store (TRA-4914)', () => {
  it('is a zero-IO no-op while the flag is off, and never writes an artifact', async () => {
    let touched = false;
    const out = await recordOptionsEvaluationReport({
      asOfDate: '2026-09-25',
      env: { DATA_DIR: dataDir },
      loadFold: async () => {
        touched = true;
        return applyModelFacingFoldBasis(rows, { env: {} });
      },
    });
    expect(out).toBeNull();
    // The flag is checked BEFORE the journal is read — that is what makes the
    // no-op provable rather than merely cheap.
    expect(touched).toBe(false);
    expect(await listOptionsEvaluationReportDates({ DATA_DIR: dataDir })).toEqual([]);
  });

  it('reads an ABSENT artifact as null, never as an empty report', async () => {
    // The distinction this asserts is the whole reason the reader returns null:
    // "no artifact" and "a report that measured nothing" must not collide.
    expect(await readLatestOptionsEvaluationReport({ DATA_DIR: dataDir })).toBeNull();
  });

  it('writes one dated artifact and reads it back', async () => {
    const out = await recordOptionsEvaluationReport({
      asOfDate: '2026-09-25',
      env,
      loadFold,
      now: 1_700_000_000_000,
    });
    expect(out).not.toBeNull();
    expect(out!.report.asOfDate).toBe('2026-09-25');
    expect(out!.report.ticket).toBe('TRA-4914');
    expect(out!.report.coverage.graded).toBe(2);
    // Folded on the model-facing basis, echoed so a reader knows which book it is.
    expect(out!.report.journalBasis).toBe('desk+unattributed');

    const back = await readLatestOptionsEvaluationReport(env);
    // The basis block survives the JSON round-trip to disk — a field that only
    // exists in the returned object would miss the on-host artifact, which is the
    // surface the TRA-5001 AC names first.
    expect(back?.report.journalModeBasis.mode).toBe('demo');
    expect(back?.report.journalBasisLabel).toContain('mode=demo');
    expect(back?.report.generatedAt).toBe(1_700_000_000_000);
    expect(await listOptionsEvaluationReportDates(env)).toEqual(['2026-09-25']);
  });

  it('labels a REPLAYED slot as late without refusing it (SURFACE CLASS B)', async () => {
    // The journal is append-only, so a late read is a strict superset and the
    // verdict stays valid. The lateness is recorded, not acted on — but it MUST
    // be recorded, or a backfilled artifact is byte-indistinguishable from a
    // same-day one (the TRA-4141 shape).
    const late = await recordOptionsEvaluationReport({
      asOfDate: '2026-09-24',
      todayEtDate: '2026-09-25',
      env,
      loadFold,
    });
    expect(late!.lateForEtDate).toBe(true);
    expect(late!.writtenOnEtDate).toBe('2026-09-25');
    expect(late!.report.headline.status).not.toBe('OK'); // n=2, still honestly thin

    const onTime = await recordOptionsEvaluationReport({ asOfDate: '2026-09-25', env, loadFold });
    expect(onTime!.lateForEtDate).toBe(false);
  });

  it('keeps one file per ET date and lists them ascending, gaps left as gaps', async () => {
    await recordOptionsEvaluationReport({ asOfDate: '2026-09-21', env, loadFold });
    await recordOptionsEvaluationReport({ asOfDate: '2026-09-25', env, loadFold });
    await recordOptionsEvaluationReport({ asOfDate: '2026-09-25', env, loadFold }); // same date ⇒ overwrite
    expect(await listOptionsEvaluationReportDates(env)).toEqual(['2026-09-21', '2026-09-25']);
    expect((await readLatestOptionsEvaluationReport(env))!.report.asOfDate).toBe('2026-09-25');
  });

  it('returns null instead of throwing when the fold fails — it must not break the archive tick', async () => {
    const out = await recordOptionsEvaluationReport({
      asOfDate: '2026-09-25',
      env,
      loadFold: async () => {
        throw new Error('journal unreadable');
      },
    });
    expect(out).toBeNull();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TRA-5001 — the published basis must not be silent about `mode`.
  // ───────────────────────────────────────────────────────────────────────────

  it('publishes the mode pin and the COUNT of live rows it removed', async () => {
    // The measured bqb1 shape in miniature: live rows present in the pooled
    // population, dropped by the pin, and — before this ticket — dropped with no
    // tell whatsoever on the wire.
    const pooled = [
      closedRow('a', 10, 20),
      closedRow('b', 20, -5),
      closedRow('live-1', 30, 40, 'live'),
      closedRow('live-2', 40, -7, 'live'),
      closedRow('live-3', 50, 3, 'live'),
    ];
    const out = await recordOptionsEvaluationReport({
      asOfDate: '2026-10-01',
      env,
      loadFold: foldOf(pooled),
    });

    // The pin itself is unchanged — the two demo rows, and ONLY those, are graded.
    expect(out!.report.coverage.graded).toBe(2);
    // ...and now it says so, with the number it dropped.
    expect(out!.report.journalModeBasis.mode).toBe('demo');
    expect(out!.report.journalModeBasis.excludedRows).toBe(3);
    expect(out!.report.journalBasisLabel).toBe(
      'desk+unattributed;mode=demo;modeExcludedRows=3',
    );
    // The note must name the consequence, not just the fact. A reader holding
    // only this artifact has to learn that `broker_fill` cannot appear in it.
    expect(out!.report.journalModeBasis.note).toContain('broker_fill');
  });

  it('states the mode axis even when the pin removed nothing — 0 is not absent', async () => {
    // The direction that would re-open the hole quietly: on a book with no live
    // rows the count is a legitimate 0, and a field that only appeared when
    // non-zero would be missing on exactly the days nobody is watching.
    const out = await recordOptionsEvaluationReport({ asOfDate: '2026-10-01', env, loadFold });
    expect(out!.report.journalModeBasis.excludedRows).toBe(0);
    expect(out!.report.journalBasisLabel).toContain('mode=demo');
  });

  it('REFUSES to publish an account-class-only basis — the TRA-5001 defect verbatim', async () => {
    // This is the regression the AC asks for, stated as the property rather than
    // as a field name: whatever the basis block is called, the published report
    // must not be readable as a basis statement that omits `mode`. Asserting over
    // the SERIALIZED artifact rather than over one field means a future rename or
    // restructure cannot satisfy it by moving the mode axis somewhere a reader
    // does not look.
    const out = await recordOptionsEvaluationReport({ asOfDate: '2026-10-01', env, loadFold });
    const onDisk = (await readLatestOptionsEvaluationReport(env))!;

    // The account-class axis alone is NOT a sufficient basis statement...
    expect(out!.report.journalBasis).not.toContain('mode');
    // ...so the artifact must carry the mode axis beside it, naming the pin.
    const basisFields = JSON.stringify({
      journalBasis: onDisk.report.journalBasis,
      journalModeBasis: onDisk.report.journalModeBasis,
      journalBasisLabel: onDisk.report.journalBasisLabel,
    });
    expect(basisFields).toContain('mode');
    expect(basisFields).toContain('demo');
    // And the composite label must differ from the bare account-class string —
    // if they are ever equal, the mode axis has been dropped again.
    expect(onDisk.report.journalBasisLabel).not.toBe(onDisk.report.journalBasis);
    // The schema bump is the tell for a v1 artifact, which carries NEITHER field.
    expect(onDisk.report.version).toBe(2);
  });

  it('the flag predicate accepts the standard truthy spellings and nothing else', () => {
    for (const v of ['1', 'true', 'YES', ' on ']) {
      expect(isOptionsEvalReportEnabled({ [OPTIONS_EVAL_REPORT_FLAG]: v })).toBe(true);
    }
    for (const v of ['0', 'false', '', 'enabled']) {
      expect(isOptionsEvalReportEnabled({ [OPTIONS_EVAL_REPORT_FLAG]: v })).toBe(false);
    }
    expect(isOptionsEvalReportEnabled({})).toBe(false);
  });
});
