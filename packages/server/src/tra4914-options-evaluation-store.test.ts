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

function closedRow(id: string, closeTs: number, pnl: number): OptionTradeJournalRecord {
  return {
    id,
    openTs: 1,
    symbol: 'AAPL',
    structure: 'single_leg_rv',
    mode: 'demo',
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
const loadRows = async () => rows;

describe('options evaluation report store (TRA-4914)', () => {
  it('is a zero-IO no-op while the flag is off, and never writes an artifact', async () => {
    let touched = false;
    const out = await recordOptionsEvaluationReport({
      asOfDate: '2026-09-25',
      env: { DATA_DIR: dataDir },
      loadRows: async () => {
        touched = true;
        return rows;
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
      loadRows,
      now: 1_700_000_000_000,
    });
    expect(out).not.toBeNull();
    expect(out!.report.asOfDate).toBe('2026-09-25');
    expect(out!.report.ticket).toBe('TRA-4914');
    expect(out!.report.coverage.graded).toBe(2);
    // Folded on the model-facing basis, echoed so a reader knows which book it is.
    expect(out!.report.journalBasis).toBe('desk+unattributed');

    const back = await readLatestOptionsEvaluationReport(env);
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
      loadRows,
    });
    expect(late!.lateForEtDate).toBe(true);
    expect(late!.writtenOnEtDate).toBe('2026-09-25');
    expect(late!.report.headline.status).not.toBe('OK'); // n=2, still honestly thin

    const onTime = await recordOptionsEvaluationReport({ asOfDate: '2026-09-25', env, loadRows });
    expect(onTime!.lateForEtDate).toBe(false);
  });

  it('keeps one file per ET date and lists them ascending, gaps left as gaps', async () => {
    await recordOptionsEvaluationReport({ asOfDate: '2026-09-21', env, loadRows });
    await recordOptionsEvaluationReport({ asOfDate: '2026-09-25', env, loadRows });
    await recordOptionsEvaluationReport({ asOfDate: '2026-09-25', env, loadRows }); // same date ⇒ overwrite
    expect(await listOptionsEvaluationReportDates(env)).toEqual(['2026-09-21', '2026-09-25']);
    expect((await readLatestOptionsEvaluationReport(env))!.report.asOfDate).toBe('2026-09-25');
  });

  it('returns null instead of throwing when the fold fails — it must not break the archive tick', async () => {
    const out = await recordOptionsEvaluationReport({
      asOfDate: '2026-09-25',
      env,
      loadRows: async () => {
        throw new Error('journal unreadable');
      },
    });
    expect(out).toBeNull();
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
