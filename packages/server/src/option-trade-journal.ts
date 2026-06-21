import { appendFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './observability/index.js';

// TRA-990 (Learning A) — the option-trade JOURNAL: a durable, observe-only
// setup -> outcome ledger for option positions (calls/puts, spreads and
// single-leg longs).
//
// The strategy selector (`strategy-selector.ts`) and RV scanner
// (`relative-value.ts`) decide WHICH structure to open and the paper book
// (`options-account.ts`) opens/closes it — but nothing records, per trade, the
// SETUP we acted on (IV-rank, trend, sentiment, entry delta/DTE) alongside the
// realized OUTCOME (P&L, R-multiple). Without that pairing there is nothing for
// the firm to learn from: we cannot say "high-IV bull puts in an uptrend with
// bullish sentiment actually pay; far-OTM debit calls into a downtrend bleed".
//
// This module is the data spine that closes that gap. It is a deliberate twin of
// the reversal ledger (`reversal-shadow-ledger.ts`): append-only JSONL, two line
// shapes (open captures the setup when IV-rank/sentiment/greeks are still known;
// close labels the realized outcome), folded by `id` so the OPEN row is
// superseded by its CLOSE row without an in-place rewrite. The pure fold that
// turns this journal into bounded, min-sample-guarded scoring weights lives in
// `learned-option-weights.ts`, mirroring how `learned-signal-weights.ts` reads
// the reversal ledger.
//
// NOTHING here routes an order or touches the broker — it only records what the
// book already did. It is also default-OFF: the writer no-ops unless
// `ENABLE_OPTION_TRADE_JOURNAL` is set, so a deploy can't start writing without
// an explicit opt-in (mirrors `ENABLE_OPTION_SHADOW_SELECTOR`).

const log = logger.child({ module: 'option-trade-journal' });

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Kill switch. The journal appends nothing unless this is truthy, so capture is
 * OFF by default and a deploy can't start writing without an explicit opt-in.
 * Accepts the usual truthy spellings.
 */
export const OPTION_TRADE_JOURNAL_FLAG = 'ENABLE_OPTION_TRADE_JOURNAL';

export function isOptionTradeJournalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[OPTION_TRADE_JOURNAL_FLAG];
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** Coarse trend regime the structure was opened into. */
export type JournalTrend = 'up' | 'down' | 'sideways';

/** Realized verdict for a closed option trade. */
export type OptionTradeOutcome = 'WIN' | 'LOSS' | 'SCRATCH';

/**
 * The setup we acted on, captured at OPEN while the conditions are still live.
 * Every field here is a lever the engine actually controls or reads, so the fold
 * can attribute realized P&L back to a decision we can change.
 */
export interface OptionTradeJournalOpen {
  /** Stable dedupe key — one journal row per opened position. */
  id: string;
  /** ms-epoch the position opened. */
  openTs: number;
  symbol: string;
  /** Defined-risk / single-leg structure, e.g. `bull_put`, `single_leg_rv`. */
  structure: string;
  /** Book the trade lives in (keeps demo learning from contaminating live). */
  mode: 'demo' | 'live';
  /** IV-rank at entry, 0–100 (the selector's core premium gate). */
  ivRank: number;
  /** Daily-trend regime the trend gate saw at entry. */
  trend: JournalTrend;
  /** Net news+social sentiment at entry, clamped [-1, +1]; null if unknown. */
  sentiment: number | null;
  /** Net |delta| of the position at entry (directional exposure). */
  entryDelta: number;
  /** Days-to-expiration at entry. */
  entryDte: number;
  /** Capital at risk (max loss), USD — the basis realized R is measured from. */
  atRiskUsd: number;
  /** Agent conviction [0,1] when an LLM advisory approved it; null otherwise. */
  agentConviction?: number | null;
}

/** The realized outcome, appended when the position closes. */
export interface OptionTradeJournalClose {
  /** ms-epoch the position closed. */
  closeTs: number;
  outcome: OptionTradeOutcome;
  /** Signed realized P&L, USD. */
  realizedPnlUsd: number;
  /** realizedPnlUsd / atRiskUsd — the comparable R-multiple. */
  realizedR: number;
  /** Why the book closed it (`tp1`, `stop`, `time_stop`, `expired`, …). */
  exitReason: string;
  /** Calendar days held (open→close). */
  holdDays: number;
}

/**
 * One journalled option trade: the setup plus (once closed) its realized
 * outcome. `outcome` is `OPEN` until the close row lands.
 */
export interface OptionTradeJournalRecord extends OptionTradeJournalOpen {
  outcome: OptionTradeOutcome | 'OPEN';
  closeTs?: number;
  realizedPnlUsd?: number;
  realizedR?: number;
  exitReason?: string;
  holdDays?: number;
}

// Append-only line shapes (discriminated by `kind`).
type OpenLine = { kind: 'open'; rec: OptionTradeJournalOpen };
type CloseLine = { kind: 'close'; id: string; close: OptionTradeJournalClose };
type JournalLine = OpenLine | CloseLine;

function defaultStoreFile(): string {
  const root = process.env['DATA_DIR'] ?? join(__dirname, '..', 'data');
  return join(root, 'option-trade-journal.jsonl');
}

let storeFileOverride: string | null = null;
/** Test seam — point the journal at a temp file. Pass `null` to restore default. */
export function setOptionTradeJournalFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
}
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

/** In-memory folded view: id -> latest record. */
let cache: Map<string, OptionTradeJournalRecord> | null = null;

function foldLine(map: Map<string, OptionTradeJournalRecord>, line: JournalLine): void {
  if (line.kind === 'open') {
    if (!map.has(line.rec.id)) map.set(line.rec.id, { ...line.rec, outcome: 'OPEN' });
    return;
  }
  const existing = map.get(line.id);
  if (!existing) return; // a close with no open is ignored, never resurrected
  map.set(line.id, {
    ...existing,
    outcome: line.close.outcome,
    closeTs: line.close.closeTs,
    realizedPnlUsd: line.close.realizedPnlUsd,
    realizedR: line.close.realizedR,
    exitReason: line.close.exitReason,
    holdDays: line.close.holdDays,
  });
}

async function ensureLoaded(): Promise<Map<string, OptionTradeJournalRecord>> {
  if (cache) return cache;
  const map = new Map<string, OptionTradeJournalRecord>();
  const path = storeFile();
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, 'utf-8');
      for (const rawLine of raw.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        try {
          foldLine(map, JSON.parse(trimmed) as JournalLine);
        } catch {
          // Skip a single corrupt line rather than losing the whole journal.
        }
      }
    } catch (err) {
      log.error('failed to read option trade journal, starting empty', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  cache = map;
  return cache;
}

async function appendLine(line: JournalLine): Promise<void> {
  const path = storeFile();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await appendFile(path, `${JSON.stringify(line)}\n`, 'utf-8');
}

/** Eagerly load the journal so reads have data right after boot. */
export async function initOptionTradeJournal(): Promise<void> {
  await ensureLoaded();
}

/**
 * Append an OPEN row for a freshly opened option position. Deduped by `id`: a
 * re-record of an already-open position is a no-op. Returns true iff a new row
 * was written. No-op (returns false) when the journal flag is off.
 */
export async function recordOptionTradeOpen(open: OptionTradeJournalOpen): Promise<boolean> {
  if (!isOptionTradeJournalEnabled()) return false;
  const map = await ensureLoaded();
  if (map.has(open.id)) return false;
  map.set(open.id, { ...open, outcome: 'OPEN' });
  await appendLine({ kind: 'open', rec: open });
  log.info('option trade journal opened', {
    id: open.id, symbol: open.symbol, structure: open.structure, mode: open.mode,
  });
  return true;
}

/**
 * Append a CLOSE row, labelling a previously opened trade with its realized
 * outcome. No-op when the trade is unknown or already closed, or when the flag
 * is off.
 */
export async function recordOptionTradeClose(
  id: string,
  close: OptionTradeJournalClose,
): Promise<void> {
  if (!isOptionTradeJournalEnabled()) return;
  const map = await ensureLoaded();
  const existing = map.get(id);
  if (!existing || existing.outcome !== 'OPEN') return;
  foldLine(map, { kind: 'close', id, close });
  await appendLine({ kind: 'close', id, close });
  log.info('option trade journal closed', {
    id, outcome: close.outcome, realizedR: close.realizedR, pnl: close.realizedPnlUsd,
  });
}

/** Classify a signed R-multiple into a WIN/LOSS/SCRATCH verdict. */
export function outcomeForR(realizedR: number, scratchBand = 0.1): OptionTradeOutcome {
  if (realizedR > scratchBand) return 'WIN';
  if (realizedR < -scratchBand) return 'LOSS';
  return 'SCRATCH';
}

/** Journalled trades, ascending by open time, optionally windowed by open ts. */
export async function listOptionTradeJournal(
  opts: { from?: number; to?: number; mode?: 'demo' | 'live' } = {},
): Promise<OptionTradeJournalRecord[]> {
  const map = await ensureLoaded();
  const { from, to, mode } = opts;
  return [...map.values()]
    .filter(
      (r) =>
        (from === undefined || r.openTs >= from) &&
        (to === undefined || r.openTs <= to) &&
        (mode === undefined || r.mode === mode),
    )
    .sort((a, b) => a.openTs - b.openTs);
}
