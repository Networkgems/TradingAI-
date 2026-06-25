/**
 * TRA-1133 (TRA-992 Step 1) — CLI runner for the OOS learned-option-weights
 * validation harness. Loads resolved demo journal rows, folds them out of sample
 * via the REAL `computeOptionLearnedWeights` / `optionSetupMultiplier`, and emits a
 * compact text report + JSON under `packages/server/reports/`. Observe-only.
 *
 * Run (on the box that holds the journal, e.g. bqb1):
 *   node --import tsx packages/server/scripts/run-tra1133-oos-option-weights.ts
 * Or against an offline rows dump (the `?rows=demo` export, see Part 1):
 *   node --import tsx packages/server/scripts/run-tra1133-oos-option-weights.ts --rows-file ./demo-rows.json
 *
 * Flags:
 *   --rows-file <path>   read rows from a JSON array (the /api/health/option-journal?rows=demo
 *                        dump or `{ rows: [...] }`) instead of the on-disk journal.
 *   --time-split <ms>    score rows closed >= <ms> trained on rows closed < <ms>
 *                        (default leave-one-out).
 *   --shrinkage          use the Beta-Binomial shrinkage multiplier (default hard-gate).
 *   --mode demo|live     journal mode to load when reading the on-disk journal (default demo).
 *
 * Env:
 *   DATA_DIR   journal root holding option-trade-journal.jsonl (server default otherwise).
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listOptionTradeJournal, type OptionTradeJournalRecord } from '../src/option-trade-journal.js';
import { buildOosReport, renderOosReport, type SplitMode } from '../src/oos-option-weights-harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function loadRows(): Promise<OptionTradeJournalRecord[]> {
  const file = argValue('--rows-file');
  if (file) {
    const parsed = JSON.parse(readFileSync(resolve(file), 'utf-8')) as
      | OptionTradeJournalRecord[]
      | { rows?: OptionTradeJournalRecord[] };
    const rows = Array.isArray(parsed) ? parsed : (parsed.rows ?? []);
    console.log(`  loaded ${rows.length} row(s) from ${file}`);
    return rows;
  }
  const mode = (argValue('--mode') as 'demo' | 'live' | undefined) ?? 'demo';
  const rows = await listOptionTradeJournal({ mode });
  console.log(`  loaded ${rows.length} ${mode} row(s) from on-disk journal`);
  return rows;
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  console.log('TRA-1133 OOS learned-option-weights validation harness');

  const rows = await loadRows();
  const splitRaw = argValue('--time-split');
  const mode: SplitMode = splitRaw ? 'time-split' : 'loo';
  const splitTs = splitRaw ? Number(splitRaw) : undefined;
  if (mode === 'time-split' && (splitTs === undefined || !Number.isFinite(splitTs))) {
    throw new Error(`--time-split expects a numeric ms-epoch, got: ${splitRaw}`);
  }
  const useShrinkage = hasFlag('--shrinkage');

  const report = buildOosReport(rows, { mode, splitTs, useShrinkage });
  const text = renderOosReport(report, generatedAt);

  mkdirSync(REPORT_DIR, { recursive: true });
  const jsonPath = resolve(REPORT_DIR, 'tra1133-oos-option-weights.json');
  const mdPath = resolve(REPORT_DIR, 'tra1133-oos-option-weights.md');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt, ...report }, null, 2), 'utf-8');
  writeFileSync(mdPath, text, 'utf-8');

  console.log(`\n${text}`);
  console.log(`wrote ${jsonPath}`);
  console.log(`wrote ${mdPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
