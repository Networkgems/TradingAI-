// TRA-4914 — the SCHEDULED ARTIFACT side of the options evaluation report.
//
// `options-evaluation-report.ts` is the pure fold; this file is the only part
// that touches a clock, a disk or the journal store. Split so the statistics are
// testable against a bare row array with no filesystem and no flag — the same
// separation TRA-4912 drew between `option-entry-provenance.ts` and the journal.
//
// ── What class of thing this is ─────────────────────────────────────────────
//
// A WRITE-ONLY OBSERVER. Nothing reads a snapshot to make a decision; no capital
// path, no order path, no live behaviour change (TRA-4914 AC). The report is
// recomputed from the journal on every run, so a stale or missing snapshot can
// never reach anything.
//
// ── SURFACE CLASS B, and it matters ─────────────────────────────────────────
//
// The source is the append-only option trade journal. It is not destroyed by the
// window closing, it accumulates monotonically, and a LATE read is therefore a
// strict SUPERSET of the on-time read — the verdict stays VALID and the lateness
// is recorded beside it (`lateForEtDate`), never used to refuse. That is the
// class-B arm of the TRA-4153 window guard, and it is why CATCH-UP IS SAFE HERE
// in a way it explicitly is not for `learned-weights-history.ts`: a learned-
// weights snapshot is only meaningful stamped with the fold that existed on that
// date, whereas this report is an exact recomputation off rows that never move.
// (`from`/`to` are honoured so a backfill grades the right window rather than
// stamping today's book under yesterday's date.)

import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { resolveDataDir } from './data-dir.js';
import { logger } from './observability/index.js';
import {
  MODEL_FACING_JOURNAL_BASIS,
  MODEL_FACING_JOURNAL_MODE,
  loadModelFacingFold,
} from './model-facing-journal.js';
import {
  buildOptionsEvaluationReport,
  type EvalJournalModeBasis,
  type OptionsEvaluationReport,
} from './options-evaluation-report.js';

const log = logger.child({ module: 'options-evaluation-report' });

/**
 * Kill switch, checked BEFORE the journal is read so the tick is provably
 * zero-IO while off. Env-armed observer class, mirroring
 * `ENABLE_LEARNED_WEIGHTS_SNAPSHOT` / `ENABLE_ORB_OPTIONS_SHADOW`: deliberately
 * NOT in `DEMO_FLAG_ALLOWLIST`, so arming it is an operator env action rather
 * than a demo-flag UI click.
 */
export const OPTIONS_EVAL_REPORT_FLAG = 'ENABLE_OPTIONS_EVAL_REPORT';

export function isOptionsEvalReportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[OPTIONS_EVAL_REPORT_FLAG];
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** Directory the daily artifacts land in, under the resolved data root. */
export const OPTIONS_EVAL_REPORT_DIR = 'options-evaluation';

/** Retention, in daily files. ~1 trading year; a report is a few KB. */
export const OPTIONS_EVAL_REPORT_RETENTION = 400;

const FILE_RE = /^options-evaluation-(\d{4}-\d{2}-\d{2})\.json$/;

function reportDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDataDir(env), OPTIONS_EVAL_REPORT_DIR);
}

function reportPath(asOfDate: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(reportDir(env), `options-evaluation-${asOfDate}.json`);
}

/**
 * The artifact as written: the report plus the provenance a reader needs to know
 * whether to trust the row beside it.
 */
export interface OptionsEvaluationArtifact {
  report: OptionsEvaluationReport;
  /**
   * TRUE when the run was executed on a LATER ET date than the one it is filed
   * under — a replayed/missed scheduler slot (the TRA-4141 shape).
   *
   * Recorded, not acted on. This surface is CLASS B: the journal is append-only,
   * so a late read sees a superset and the verdict is valid. The flag exists so a
   * reader can tell a same-day artifact from a backfilled one without having to
   * diff mtimes — absent that tell, the two are byte-indistinguishable, which is
   * exactly the condition TRA-4141 turned into 28 vacuous reads.
   */
  lateForEtDate: boolean;
  /** ET date the process believed it was when it wrote this. */
  writtenOnEtDate: string;
}

export interface RecordOptionsEvaluationReportDeps {
  /** ET date the report is filed under. */
  asOfDate: string;
  /** ET date the process believes it is now. Differs from `asOfDate` on a replayed slot. */
  todayEtDate?: string;
  /** Upper bound on `closeTs` (ms). Defaults to unbounded. */
  to?: number;
  /** Lower bound on `closeTs` (ms). Defaults to unbounded. */
  from?: number;
  env?: NodeJS.ProcessEnv;
  now?: number;
  /**
   * Test seam — defaults to the model-facing (demo-pinned, QA fixtures removed)
   * fold.
   *
   * TRA-5001 — this is `loadModelFacingFold`, not `loadModelFacingJournalRows`,
   * for one reason: it returns `modeExcluded`. The rows are identical either way
   * (same pin, same predicate); the difference is that the count of LIVE rows the
   * pin dropped is measurable here and therefore publishable beside the basis.
   */
  loadFold?: typeof loadModelFacingFold;
}

/**
 * TRA-5001 — the mode axis of the basis, built off what the fold actually
 * removed.
 *
 * The note is written for a reader who has the artifact and not this file. It has
 * to say the thing the old label did not: that a `broker_fill` cost basis — the
 * only one derived from a real executed price — cannot appear in this report at
 * all, so a G1/G2/G3 gate read off it can never be satisfied by live evidence.
 */
function modeBasisFor(modeExcluded: number): EvalJournalModeBasis {
  return {
    mode: MODEL_FACING_JOURNAL_MODE,
    excludedRows: modeExcluded,
    note:
      `Rows are PINNED to mode='${MODEL_FACING_JOURNAL_MODE}' by model-facing-journal.ts; `
      + `${modeExcluded} live row(s) were removed before grading. This report therefore CANNOT `
      + 'contain a live fill, and no `broker_fill` cost basis can ever appear in it. A promotion '
      + 'gate read off this surface is not satisfiable by live evidence — grade live fills elsewhere.',
  };
}

/**
 * TRA-4914 — build and persist ONE options evaluation report for `asOfDate`.
 *
 * Returns the artifact it wrote, or `null` when the flag is off (the zero-IO
 * no-op). Throws nothing: a write failure is logged and surfaces as `null`,
 * because a scheduled observer must never be able to take down the archive tick
 * it is chained onto.
 */
export async function recordOptionsEvaluationReport(
  deps: RecordOptionsEvaluationReportDeps,
): Promise<OptionsEvaluationArtifact | null> {
  const env = deps.env ?? process.env;
  if (!isOptionsEvalReportEnabled(env)) return null;

  try {
    const load = deps.loadFold ?? loadModelFacingFold;
    const fold = await load({ from: deps.from, to: deps.to, env });
    const report = buildOptionsEvaluationReport(fold.rows, {
      asOfDate: deps.asOfDate,
      journalBasis: MODEL_FACING_JOURNAL_BASIS,
      journalModeBasis: modeBasisFor(fold.modeExcluded),
      now: deps.now,
    });
    const writtenOnEtDate = deps.todayEtDate ?? deps.asOfDate;
    const artifact: OptionsEvaluationArtifact = {
      report,
      lateForEtDate: writtenOnEtDate > deps.asOfDate,
      writtenOnEtDate,
    };

    const dir = reportDir(env);
    await mkdir(dir, { recursive: true });
    await writeFile(reportPath(deps.asOfDate, env), JSON.stringify(artifact, null, 2), 'utf8');
    await pruneOldReports(env);

    log.info('options evaluation report written', {
      asOfDate: deps.asOfDate,
      graded: report.coverage.graded,
      closedRows: report.coverage.closedRows,
      // TRA-5001 — the mode axis in the log line too, so a boot's worth of Render
      // tape answers "was this demo-only?" without reading the artifact back.
      journalBasisLabel: report.journalBasisLabel,
      headlineStatus: report.headline.status,
      constraints: report.constraints.overall,
      lateForEtDate: artifact.lateForEtDate,
    });
    return artifact;
  } catch (err) {
    log.error('options evaluation report failed', {
      asOfDate: deps.asOfDate,
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Delete the oldest artifacts beyond {@link OPTIONS_EVAL_REPORT_RETENTION}. */
async function pruneOldReports(env: NodeJS.ProcessEnv): Promise<void> {
  const dir = reportDir(env);
  const names = (await readdir(dir)).filter((n) => FILE_RE.test(n)).sort();
  if (names.length <= OPTIONS_EVAL_REPORT_RETENTION) return;
  const { unlink } = await import('fs/promises');
  for (const name of names.slice(0, names.length - OPTIONS_EVAL_REPORT_RETENTION)) {
    await unlink(join(dir, name)).catch(() => undefined);
  }
}

/**
 * Read back the most recent artifact, or `null` when none exists.
 *
 * ⚠ `null` here means NO ARTIFACT — never "an empty report". A caller rendering
 * this must say `NOT MEASURED`, not zero. That distinction is the whole reason
 * this returns `null` rather than a default-constructed report.
 */
export async function readLatestOptionsEvaluationReport(
  env: NodeJS.ProcessEnv = process.env,
): Promise<OptionsEvaluationArtifact | null> {
  try {
    const dir = reportDir(env);
    const names = (await readdir(dir)).filter((n) => FILE_RE.test(n)).sort();
    const newest = names[names.length - 1];
    if (!newest) return null;
    return JSON.parse(await readFile(join(dir, newest), 'utf8')) as OptionsEvaluationArtifact;
  } catch {
    return null;
  }
}

/** Every artifact date currently on disk, ascending. Gaps are gaps — do not interpolate. */
export async function listOptionsEvaluationReportDates(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  try {
    const names = await readdir(reportDir(env));
    return names
      .map((n) => FILE_RE.exec(n)?.[1])
      .filter((d): d is string => typeof d === 'string')
      .sort();
  } catch {
    return [];
  }
}
