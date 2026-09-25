/**
 * TRA-3926 (2026-09-04) — the DURABLE CARRIER for judged excess closes.
 *
 * The detector (`detectOversoldEngineCloses`) re-derives its findings from the
 * fee/slippage tape on every read, and that tape retains 30 days
 * (`live-options-fee-slippage-ledger.ts` RETAIN_MS). The judged population is
 * historical by construction, so every judgement the detector serves is on a
 * countdown: the XLF 2026-08-21 over-sell — the fired real-money event this
 * whole ticket exists for — loses its opens ~2026-09-19 and its close a day
 * later, at which point the only live alarm for it erases itself. Measured
 * 2026-09-03: QQQ260911P00545000 (the 2026-08-05 sibling event) crossed that
 * horizon mid-day and degraded from a full finding to a `no_open_record` blind
 * on identical detector bytes.
 *
 * Same taxonomy as `PRE_STAMP_CLOSE_GRANT_ANCHORS` (durable population,
 * evaporating surface), remediated the same way as TRA-3932's provenance store
 * and the `exitQuantityBound.outstanding` half: when the judgement is made and
 * its evidence is still on the tape, write it somewhere the archive tick, the
 * restart, and the retention horizon cannot reach. Append-only JSONL on the
 * resolved DATA_DIR, never compacted — these lines are verdicts reached from
 * evidence that expires at the source, not measurements a later run can retake.
 *
 * What is captured: FINDINGS and GRANTED closes — both are judgements. A blind
 * close is deliberately NOT captured: it is an unanswered question, and
 * persisting it would freeze a shrug as testimony (the closed-world reading
 * this codebase refuses, TRA-3932).
 *
 * A judgement for a key is re-appended ONLY when it changes (finding → granted
 * or the reverse). This has already happened once for real: RIG 143384264 was
 * ACCUSED on `092d0877` and became GRANTED via the anchor on `328d9659`. The
 * summary folds newest-last and publishes `attempts`, so a changed judgement
 * reads as history, never as an overwrite. The live census OUTRANKS this store
 * wherever both can speak — `onLiveTape` says which rows the current tape
 * still corroborates and which survive only here.
 */

import { mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { isEphemeralDataDir } from './data-dir.js';
import { logger } from './observability/index.js';

import type { LiveCloseGrant } from './live-options-fee-slippage-ledger.js';
import { appendBoundedTapeLineSync } from './data-tape-bounds.js';
import type {
  GrantedClose,
  OversoldCloseCensus,
  OversoldCloseFinding,
} from './tra3926-oversold-close-detector.js';

const log = logger.child({ module: 'tra3926-judged-oversold-store' });

export const JUDGED_OVERSOLD_LOG_FILENAME = 'tra3926-judged-oversold.jsonl';

export interface JudgedOversoldLine {
  kind: 'judgement';
  /** ms epoch of the capture — when the detector served this judgement. */
  judgedAt: number;
  judgement: 'finding' | 'granted';
  row: OversoldCloseFinding;
  /** Present iff `judgement === 'granted'`. */
  grant?: LiveCloseGrant;
  grantSource?: GrantedClose['grantSource'];
}

let dataDir: string | null = null;

export function setJudgedOversoldDataDir(dir: string | null): void {
  dataDir = dir;
}

export function judgedOversoldLogPath(dir: string): string {
  return join(dir, JUDGED_OVERSOLD_LOG_FILENAME);
}

/**
 * A judged close's identity. All three parts, matching the anchor table's
 * keying: the OCC alone recurs across episodes, the order id is null-capable
 * on the type, and the fill ts survives both.
 */
export function judgedCloseKey(row: {
  optionSymbol: string;
  orderId: number | null;
  ts: number;
}): string {
  return `${row.optionSymbol}|${row.orderId ?? 'null'}|${row.ts}`;
}

/** Read every stored line. Corrupt lines are skipped here and COUNTED by the summary's `lines` vs parse delta, never folded into a clean answer. */
export function readJudgedOversold(): JudgedOversoldLine[] {
  if (dataDir == null) return [];
  let raw: string;
  try {
    raw = readFileSync(judgedOversoldLogPath(dataDir), 'utf8');
  } catch {
    return [];
  }
  const out: JudgedOversoldLine[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as JudgedOversoldLine;
      if (parsed && parsed.kind === 'judgement' && parsed.row) out.push(parsed);
    } catch {
      // surfaced by the summary as a lines/rows mismatch, not swallowed
    }
  }
  return out;
}

/**
 * Capture this read's judgements. Idempotent on content: a key whose latest
 * stored judgement already matches is skipped, so the route can call this on
 * every read and the file grows only when the detector actually says something
 * new. Best-effort on IO and COUNTED, matching the sibling ledgers.
 *
 * ⚠ This function must never be handed anything but the REAL census the route
 * is about to serve. Capturing from a spy or a filtered copy is how a durable
 * carrier diverges from the alarm it exists to preserve (TRA-3730).
 */
export function captureJudgedOversoldCloses(
  census: OversoldCloseCensus,
  nowMs: number = Date.now(),
): { appended: number; unchanged: number; appendErrors: number } {
  if (dataDir == null) return { appended: 0, unchanged: 0, appendErrors: 0 };
  const latestByKey = new Map<string, JudgedOversoldLine>();
  for (const line of readJudgedOversold()) {
    latestByKey.set(judgedCloseKey(line.row), line);
  }
  const path = judgedOversoldLogPath(dataDir);
  let appended = 0;
  let unchanged = 0;
  let appendErrors = 0;
  const writeIfChanged = (line: JudgedOversoldLine): void => {
    const prior = latestByKey.get(judgedCloseKey(line.row));
    if (prior && prior.judgement === line.judgement) {
      unchanged += 1;
      return;
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendBoundedTapeLineSync(path, JSON.stringify(line) + '\n');
      appended += 1;
    } catch (err) {
      appendErrors += 1;
      log.warn('tra3926 judged-oversold append failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  };
  for (const f of census.findings) {
    writeIfChanged({ kind: 'judgement', judgedAt: nowMs, judgement: 'finding', row: f });
  }
  for (const g of census.grantedCloses) {
    const { grant, grantSource, ...row } = g;
    writeIfChanged({
      kind: 'judgement',
      judgedAt: nowMs,
      judgement: 'granted',
      row,
      grant,
      grantSource,
    });
  }
  return { appended, unchanged, appendErrors };
}

export interface JudgedOversoldSummary {
  dataDir: string | null;
  ephemeral: boolean;
  lines: number;
  /** Distinct judged closes the store testifies to. */
  closes: number;
  rows: Array<{
    key: string;
    optionSymbol: string;
    orderId: number | null;
    ts: number;
    etDay: string;
    judgement: 'finding' | 'granted';
    grant: LiveCloseGrant | null;
    grantSource: GrantedClose['grantSource'] | null;
    soldContracts: number;
    engineOpenContracts: number;
    excessContracts: number;
    basis: OversoldCloseFinding['basis'];
    /** How many times the judgement was (re)stated. > 1 means it CHANGED. */
    attempts: number;
    firstJudgedAt: number;
    lastJudgedAt: number;
    /**
     * Whether the census served alongside this summary still reaches the same
     * conclusion from the live tape. `false` after the retention horizon rolls
     * past the row's evidence — the testimony then survives ONLY here, which
     * is this store's entire purpose, and must be read as preserved judgement,
     * never as a live re-derivation.
     */
    onLiveTape: boolean;
  }>;
}

/**
 * Fold the store, newest judgement per key wins, and mark each row against the
 * census the caller is serving in the same response. Call AFTER
 * {@link captureJudgedOversoldCloses} so a freshly served judgement is never
 * transiently absent from its own durable carrier.
 */
export function summarizeJudgedOversoldCloses(census: OversoldCloseCensus): JudgedOversoldSummary {
  const lines = readJudgedOversold();
  const byKey = new Map<string, JudgedOversoldLine[]>();
  for (const l of lines) {
    const k = judgedCloseKey(l.row);
    const g = byKey.get(k);
    if (g) g.push(l);
    else byKey.set(k, [l]);
  }
  const liveKeys = new Set<string>([
    ...census.findings.map((f) => judgedCloseKey(f)),
    ...census.grantedCloses.map((g) => judgedCloseKey(g)),
  ]);
  const rows: JudgedOversoldSummary['rows'] = [];
  for (const [key, group] of byKey) {
    const ordered = [...group].sort((a, b) => a.judgedAt - b.judgedAt);
    const latest = ordered[ordered.length - 1]!;
    rows.push({
      key,
      optionSymbol: latest.row.optionSymbol,
      orderId: latest.row.orderId,
      ts: latest.row.ts,
      etDay: latest.row.etDay,
      judgement: latest.judgement,
      grant: latest.grant ?? null,
      grantSource: latest.grantSource ?? null,
      soldContracts: latest.row.soldContracts,
      engineOpenContracts: latest.row.engineOpenContracts,
      excessContracts: latest.row.excessContracts,
      basis: latest.row.basis,
      attempts: ordered.length,
      firstJudgedAt: ordered[0]!.judgedAt,
      lastJudgedAt: latest.judgedAt,
      onLiveTape: liveKeys.has(key),
    });
  }
  rows.sort((a, b) => a.ts - b.ts || (a.key < b.key ? -1 : 1));
  return {
    dataDir,
    ephemeral: dataDir === null ? true : isEphemeralDataDir(dataDir),
    lines: lines.length,
    closes: byKey.size,
    rows,
  };
}
