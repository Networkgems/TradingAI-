import { appendFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './observability/index.js';
import { STOP_DISTANCE_FRACTION_OF_MARK } from './option-spread-cost.js';
import type { RiskThrottleSizingPath, RiskThrottleSizingScope } from './risk-throttle-sizing.js';

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

/**
 * TRA-993 — the *grade/skill* band of the sentiment signal at entry, sourced from
 * the TRA-820 sentiment-IC study (`sentiment-ic-harness.ts` verdict / daily
 * snapshot grade), NOT the raw sentiment number. `strong` = the IC study graded
 * the signal as carrying edge, `weak` = measured but inconclusive, `none` = no
 * measurable skill. `null` when no grade is available — an open is NEVER blocked
 * on a missing grade. Distinct from {@link OptionTradeJournalOpen.sentiment},
 * which is the raw net news+social number.
 */
export type SentimentIcBand = 'strong' | 'weak' | 'none' | null;

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
  /**
   * IV-rank at entry, 0–100 (the selector's core premium gate). `null` is the
   * honest-unknown value: the high-volume RV single-leg path (TRA-1103) journals
   * without an IV-rank rather than lifting a per-symbol ATM-IV chain fetch out of
   * the exec-gated block (the bqb1 event-loop-starvation risk in TRA-1082 /
   * TRA-1087). Null rows bucket under the fold's `unknown` IV-rank band and never
   * pollute the low/mid/high learned buckets.
   */
  ivRank: number | null;
  /** Daily-trend regime the trend gate saw at entry. */
  trend: JournalTrend;
  /** Net news+social sentiment at entry, clamped [-1, +1]; null if unknown. */
  sentiment: number | null;
  /**
   * TRA-993 — TRA-820 sentiment-IC grade BAND for the symbol at entry (the
   * skill/quality of the sentiment signal, not its raw value). `null` when no
   * grade is available; never blocks the open. Optional on the line shape so
   * pre-TRA-993 rows fold back as `null`.
   */
  sentimentIcBand?: SentimentIcBand;
  /** Net |delta| of the position at entry (directional exposure). */
  entryDelta: number;
  /** Days-to-expiration at entry. */
  entryDte: number;
  /** Capital at risk (max loss), USD — the basis realized R is measured from. */
  atRiskUsd: number;
  /** Agent conviction [0,1] when an LLM advisory approved it; null otherwise. */
  agentConviction?: number | null;
  /**
   * TRA-1183 — the entry archetype that admitted this fill, e.g. `ema-pullback`
   * (Trend-Pullback) or `volume-breakout`, sourced from the live signal reason in
   * `signal-engine.ts`. Optional so pre-TRA-1183 rows (and every open that wasn't
   * gated by a swing archetype) fold back as `undefined` rather than a synthetic
   * label. Lets the fold count ema-pullback fills distinctly instead of burying
   * them in bare `single_leg_rv`. Observe-only; never gates routing.
   */
  entryArchetype?: string;
  /**
   * TRA-1600 (deliverable D) — MEASURED entry-side slippage in USD for this
   * position: signed `(fillPremium − mark) × contracts × 100`. Positive = we paid
   * WORSE than the mid (the spread-cross cost the TRA-1599 decomposition only
   * *modeled*). In demo this is the modelled `demoSlippagePct` haircut applied at
   * open; in live it is the realised broker avg-fill-vs-mid once the smart-open
   * mirror reconciles. Optional so pre-TRA-1600 rows (and opens with no available
   * mark) fold back as `undefined` and drop out of the slippage rollup rather than
   * skewing it to zero. Observe-only; the rollup is what turns the parametric cost
   * decomposition into a per-fill measurement that can feed the cost-aware gate.
   */
  entrySlippageUsd?: number;
  /**
   * TRA-1656 (TRA-1602B) — the fill-time two-sided QUOTE, retained so the option
   * spread cross can be MEASURED instead of modeled.
   *
   * The cost-aware gate (TRA-1602) charges a `makerAdjustedSpreadCrossR = 1.00R`
   * that its own comment admits is "INTERIM (modeled, not measured)", and before
   * this ticket there was no way to check it: the scanners compute `bid`/`ask` and
   * derive `mark = (bid + ask) / 2`, but only `mark` survived into the fill — the
   * quote was dropped on the floor. Worse, the open row carried no contract
   * identity either, so the 2,153 closed demo trades could not even be JOINED back
   * to the recorded chain snapshots to recover their quotes. Both gaps are closed
   * here: `optionSymbol` makes a row identifiable, and `entryBid`/`entryAsk` make
   * the round-trip cross directly measurable as
   * `(ask − bid) / (0.25 · entryMarkUsd)` (see `option-spread-cost.ts`).
   *
   * All optional: rows written before this commit fold back as `undefined` and DROP
   * OUT of the spread-cost rollup rather than being counted as zero-cost fills.
   * That means the measured `n` starts at 0 and accrues forward — the probe says so
   * explicitly rather than reporting a falsely-cheap cross over unmeasured rows.
   */
  optionSymbol?: string;
  /** TRA-1656 — per-share bid at fill. */
  entryBid?: number;
  /** TRA-1656 — per-share ask at fill. */
  entryAsk?: number;
  /** TRA-1656 — per-share mark (mid) the fill booked against. R = 0.25 × this. */
  entryMarkUsd?: number;
  /** TRA-1656 — contracts filled; the basis for the round-trip commission-in-R term. */
  contracts?: number;
  /**
   * TRA-1475 — the owning demo book's username, stamped so the firm-wide DESK
   * fold (`reports/desk-calendar.ts`) can exclude QA/test accounts (`qa*`,
   * `ctoverify*`, `monitor_qa`, …) that dominate the ~51-book demo fleet. Optional
   * for back-compat: pre-TRA-1475 rows carry no `account` and are KEPT by the
   * desk filter (they can't be classified). Bound off the per-user engine at
   * context wire-up (`PaperOptionsAccount.setOwner`) and only stamped when known,
   * so an un-owned open omits the field entirely. Observe-only; never gates
   * routing and never crosses into the `live` book's learning.
   */
  account?: string;
  /**
   * TRA-2333 (parent TRA-2331) — the risk-autopilot throttle multiplier ACTUALLY
   * APPLIED to this ticket's size, and the arming scope in force when it was
   * sized. Together they make a trimmed fill *attributable*: the trimmed sleeve
   * becomes gradeable by a plain partition on `riskThrottleMultiplier < 1`
   * against the contemporaneous `=== 1` rows, joined to this row's own R, P&L,
   * structure and archetype. Before this the multiplier existed only in the
   * since-boot `byPath` counters, which say how MANY tickets were trimmed and
   * never WHICH — and which lose everything before the last bqb1 restart.
   *
   * ALWAYS written by this build, including when the multiplier is exactly `1`.
   * If it were written only on a trim, ABSENT would collapse into "un-trimmed"
   * and a build where the stamp regressed would read identically to a calm
   * market (TRA-2302's `?? 0` lesson). Optional on the TYPE because absent is a
   * real and meaningful state in the ledger — it means exactly one thing:
   * **the row was written by a build older than TRA-2333.** Rows without it must
   * be excluded from a throttle grade, never defaulted to 1.
   *
   * Scope note: `1` is the honest value both for a consulted-but-untrimmed
   * ticket AND for a structure whose open path does not consult the throttle at
   * all (defined-risk spreads, the wheel's CSP/covered-call). Either way no trim
   * was applied to this fill, so the partition is never wrong; "did this
   * chokepoint consult?" is a different question and is answered PER ROW by
   * {@link riskThrottleSizingPath} (TRA-2375). It used to be answerable only
   * from `autopilot.sizing.byPath` on `/api/health/live`, which is a since-boot
   * counter and therefore not joinable to any individual fill.
   */
  riskThrottleMultiplier?: number;
  /** TRA-2333 — arming scope in force when this ticket was sized. */
  riskThrottleArmedScope?: RiskThrottleSizingScope;
  /**
   * TRA-2339 (parent TRA-2331) — the throttle multiplier the autopilot DECIDED
   * for this ticket: what {@link riskThrottleMultiplier} would have been had this
   * open path been armed. Same tighten-only clamp, evaluated with `armed: true`.
   *
   * `riskThrottleMultiplier` alone cannot answer the question the board's live-arm
   * step turns on, because it is the APPLIED term and is correctly 1 on every
   * unarmed path — so a de-risked week and a calm week stamp identically. The pair
   * separates them per fill:
   *
   *   • `riskThrottleDecided < 1 && riskThrottleMultiplier === 1` — this fill
   *     WOULD have been trimmed and was not. That is the dark cohort, and it is
   *     joinable to this row's own realized R, P&L, structure and archetype, which
   *     the since-boot `wouldTrims` counter can never be.
   *   • both `< 1` — trimmed. `=== 1` decided — the autopilot was at full size.
   *
   * ALWAYS written by this build, including when it is exactly `1`; optional on the
   * TYPE only because absent is a real ledger state meaning **written by a build
   * older than TRA-2339**. Exclude such rows from a throttle grade; never default
   * them to 1.
   *
   * Scope note, matching `riskThrottleMultiplier`: open paths that do not consult
   * the throttle at all (defined-risk spreads, the wheel's CSP/covered-call) stamp
   * `1` here too. The field is what THIS TICKET'S sizing path would have applied,
   * not the governor's raw reading — a path that never consults would not have been
   * trimmed at any scope, so putting the governor's 0.5 here would manufacture a
   * would-have-been-trimmed row that no arming decision could ever have trimmed.
   * The raw governor value is separately visible in `autopilot.sizing.byPath[…]
   * .lastThrottle` on `/api/health/live`.
   *
   * That decision is still right, and TRA-2375 is what makes it safe: the two
   * populations that both stamp `1` here are told apart by
   * {@link riskThrottleSizingPath}, NOT by this field. Read them together —
   * `riskThrottleDecided` alone must never be used to define the control arm.
   */
  riskThrottleDecided?: number;
  /**
   * TRA-2375 (parent TRA-2331) — WHICH sizing chokepoint produced the two terms
   * above, i.e. this fill's cohort membership for a throttle grade.
   *
   * The gap it closes: `riskThrottleDecided === 1` conflates two populations a
   * throttle grade must keep apart —
   *
   *   • **in cohort, untrimmed** — the open path DID consult the throttle and the
   *     autopilot was at full size. A true control observation.
   *   • **out of cohort** — the open path is not a chokepoint at any scope
   *     (defined-risk spreads, the wheel's CSP/covered-call, the bounded-live
   *     1-contract override), so it stamps a hardcoded `1`.
   *
   * Partition naively on `decided === 1` and every out-of-cohort row lands in the
   * CONTROL arm, where it is a trade the throttle could never have touched.
   *
   * How much of the book that is TODAY is small, and it is a *policy* variable,
   * not a constant (TRA-2385 — the shipped TRA-2375 text claimed "a large share"
   * and that magnitude was never counted). Measured 2026-07-26 against live
   * `408f06a5`, `/api/health/option-journal?rows=all`, n=2,383: **0 of the 115
   * demo desk rows** the TRA-2331 grade partitions on, 28 of 2,383 overall
   * (1.17% — `iron_condor` 16, `bear_put_spread` 8, `bear_call` 2, `bull_put` 2,
   * every one of them in the unattributed bucket the grade already drops), and
   * **zero** wheel rows (`covered_call` / `cash_secured_put`) anywhere in the
   * journal. So no live control arm is being distorted right now.
   *
   * The field exists for the moment that changes. The desk turning the wheel on,
   * or routing spreads, needs no code change here — and a `decided === 1`
   * partition would then pool those fills into the control arm SILENTLY, because
   * a contaminated control arm just looks big and healthy. Nothing in the
   * resulting numbers looks wrong. `riskThrottleArmedScope` cannot separate them
   * either: it is stamped unconditionally at the account layer and reads the same
   * on both.
   *
   * THREE distinguishable states, and the distinction is the whole point:
   *   • **absent**  — row written by a build older than TRA-2375. Basis unknown;
   *     a grade must fall back to a declared proxy or exclude the row. NEVER
   *     default it.
   *   • **`null`**  — WRITTEN by this build, and this open path is not a
   *     chokepoint. Out of cohort. Explicitly written rather than omitted so that
   *     "not a chokepoint" is a positive assertion by a known-good writer instead
   *     of the absence of one.
   *   • **a path**  — in cohort; this chokepoint consulted the throttle for this
   *     fill.
   *
   * Cohort membership is therefore a PRESENCE test (`hasOwnProperty` for "does
   * this build stamp it", then `!= null` for "was it eligible"). Deliberately not
   * a bare `isThrottleChokepoint: boolean`: `false` and "old build" would collide
   * under `?? false`, which is the exact defect class being fixed here.
   */
  riskThrottleSizingPath?: RiskThrottleSizingPath | null;
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
  /**
   * TRA-1600 (deliverable D) — MEASURED exit-side slippage in USD for this
   * position: signed `(mark − fillPremium) × contracts × 100`, i.e. positive when
   * the realised sell fill came in WORSE (lower) than the closing mid. Same
   * convention as {@link OptionTradeJournalOpen.entrySlippageUsd} (positive =
   * cost). Optional; `undefined` when no closing mark was captured. Entry + exit
   * together are the measured per-round-trip spread-cross the gate's cost model
   * can be recalibrated against.
   */
  exitSlippageUsd?: number;
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
  /** TRA-1600 (D) — measured exit-side slippage USD, folded from the CLOSE row. */
  exitSlippageUsd?: number;
}

// Append-only line shapes (discriminated by `kind`).
type OpenLine = { kind: 'open'; rec: OptionTradeJournalOpen };
type CloseLine = { kind: 'close'; id: string; close: OptionTradeJournalClose };
// TRA-1601 — amend the OPEN row's measured entry slippage. In LIVE the true
// mark-vs-fill slippage isn't known until the smart-open mirror fills (the OPEN
// row was written at `premiumPaid == rawMark`, so entrySlippageUsd was 0). This
// line supersedes that value without an in-place rewrite.
type AmendEntrySlippageLine = { kind: 'amend_entry_slippage'; id: string; entrySlippageUsd: number };
type JournalLine = OpenLine | CloseLine | AmendEntrySlippageLine;

function defaultStoreFile(): string {
  const root = process.env['DATA_DIR'] ?? join(__dirname, '..', 'data');
  return join(root, 'option-trade-journal.jsonl');
}

let storeFileOverride: string | null = null;
/** Test seam — point the journal at a temp file. Pass `null` to restore default. */
export function setOptionTradeJournalFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
  integrity = UNMEASURED_INTEGRITY;
}
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

/**
 * TRA-1681 — what the load DROPPED, as a first-class readable.
 *
 * `ensureLoaded` skips a line it cannot parse rather than losing the whole
 * journal, and falls back to an empty book on a read error. Both were silent:
 * a journal that dropped rows and one that dropped none read identically.
 *
 * That matters beyond hygiene. A crash mid-`appendFile` leaves a torn tail
 * line, and the next append concatenates onto that fragment — so the torn line
 * swallows the NEXT record too. Nothing ever decreases, so the file stays
 * monotone; a row just never arrives. Any grade whose pass condition is "this
 * counter did not grow" (TRA-1690's negative control) therefore reads a
 * swallowed row as evidence of no leak. Counting the skips is what lets such a
 * window VOID instead of certify.
 *
 * `corruptLines: null` means NOT MEASURED (no load has run yet) — never `0`,
 * which is a real measurement of a clean file. See TRA-1707.
 */
export interface OptionTradeJournalIntegrity {
  /** Unparseable lines skipped by the last load; `null` until a load has run. */
  corruptLines: number | null;
  /** Message from a failed read that forced the empty-book fallback, else `null`. */
  readError: string | null;
}

const UNMEASURED_INTEGRITY: OptionTradeJournalIntegrity = { corruptLines: null, readError: null };
let integrity: OptionTradeJournalIntegrity = UNMEASURED_INTEGRITY;

/** Load-integrity counters for the journal file. See {@link OptionTradeJournalIntegrity}. */
export function getOptionTradeJournalIntegrity(): OptionTradeJournalIntegrity {
  return { ...integrity };
}

/** In-memory folded view: id -> latest record. */
let cache: Map<string, OptionTradeJournalRecord> | null = null;

function foldLine(map: Map<string, OptionTradeJournalRecord>, line: JournalLine): void {
  if (line.kind === 'open') {
    if (!map.has(line.rec.id)) map.set(line.rec.id, { ...line.rec, outcome: 'OPEN' });
    return;
  }
  if (line.kind === 'amend_entry_slippage') {
    // TRA-1601 — supersede the measured entry slippage on the existing row. A
    // non-finite value is ignored; an amend for an unknown id is dropped (never
    // resurrects a row that has no open).
    const rec = map.get(line.id);
    if (!rec) return;
    if (typeof line.entrySlippageUsd === 'number' && Number.isFinite(line.entrySlippageUsd)) {
      map.set(line.id, { ...rec, entrySlippageUsd: line.entrySlippageUsd });
    }
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
    // TRA-1600 (D) — carry the measured exit slippage onto the folded record so
    // the summary rollup can decompose the round-trip cost. Only overwritten when
    // the close row carries a measurement (undefined leaves it absent).
    ...(line.close.exitSlippageUsd !== undefined ? { exitSlippageUsd: line.close.exitSlippageUsd } : {}),
  });
}

async function ensureLoaded(): Promise<Map<string, OptionTradeJournalRecord>> {
  if (cache) return cache;
  const map = new Map<string, OptionTradeJournalRecord>();
  const path = storeFile();
  let corruptLines = 0;
  let readError: string | null = null;
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, 'utf-8');
      for (const rawLine of raw.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        try {
          foldLine(map, JSON.parse(trimmed) as JournalLine);
        } catch {
          // Skip a single corrupt line rather than losing the whole journal — but
          // COUNT it, so a dropped row cannot pass for a clean load.
          corruptLines += 1;
        }
      }
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err);
      log.error('failed to read option trade journal, starting empty', { reason: readError });
    }
  }
  if (corruptLines > 0) {
    log.warn('option trade journal skipped unparseable lines', { corruptLines, path });
  }
  integrity = { corruptLines, readError };

  // TRA-1681 — do NOT cache a book we could not read.
  //
  // The empty map used to be memoised here unconditionally, so ONE failed read (a disk
  // flap, an EIO, a mount that came up late) permanently pinned the journal to zero rows
  // for the rest of the process lifetime. The read error was transient; the empty book
  // was forever, and it read exactly like a desk that had never traded. Leaving `cache`
  // null costs a re-read on the next call — a file read on a cold path — and buys back
  // the ability to recover the moment the disk does.
  //
  // The integrity latch above is deliberately still SET, so a reader that came in during
  // the outage can see `readError` and VOID rather than trust the zero (TRA-1690
  // assertion 9). Fail closed on the GRADE, retry on the READ.
  if (readError !== null) return map;

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

// TRA-1046 (TRA-1041c L1) — trade-close event hook. The learned-weights fold is
// recomputed on each close so live selection weights refresh intraday instead of
// only at the EOD snapshot. To keep this module dependency-free (the learner
// imports the journal, not the other way round) the close path NOTIFIES a list of
// subscribers rather than calling the cache directly. Subscribers must be cheap +
// non-throwing; a thrown listener is swallowed so a bad subscriber can never break
// the (capital-adjacent) close-recording path.
type CloseListener = (id: string, close: OptionTradeJournalClose) => void;
const closeListeners: CloseListener[] = [];

/** Register a listener fired after every successful CLOSE append. */
export function onOptionTradeClose(fn: CloseListener): void {
  closeListeners.push(fn);
}

/** Test seam — drop all close subscribers so tests don't leak across files. */
export function clearOptionTradeCloseListenersForTests(): void {
  closeListeners.length = 0;
}

function notifyClose(id: string, close: OptionTradeJournalClose): void {
  for (const fn of closeListeners) {
    try {
      fn(id, close);
    } catch (err) {
      log.warn('option trade close listener threw (ignored)', {
        id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
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
 * TRA-1601 — amend the MEASURED entry-side slippage on an already-open row.
 * Used by the LIVE smart-open mirror: the OPEN row is written at
 * `premiumPaid == rawMark` (entrySlippageUsd = 0) before the broker fill is
 * known; once the smart-open walk fills we know the real avgFillPrice-vs-mid
 * slippage and reconcile it back here. No-op (returns false) when the flag is
 * off, the row is unknown, or it is already closed (an amend must not rewrite a
 * settled round trip). Idempotent-safe: re-amending an open row with the same
 * value is harmless.
 */
export async function recordOptionTradeEntrySlippage(
  id: string,
  entrySlippageUsd: number,
): Promise<boolean> {
  if (!isOptionTradeJournalEnabled()) return false;
  if (!Number.isFinite(entrySlippageUsd)) return false;
  const map = await ensureLoaded();
  const existing = map.get(id);
  if (!existing || existing.outcome !== 'OPEN') return false;
  foldLine(map, { kind: 'amend_entry_slippage', id, entrySlippageUsd });
  await appendLine({ kind: 'amend_entry_slippage', id, entrySlippageUsd });
  log.info('option trade journal entry-slippage amended', { id, entrySlippageUsd });
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
  // TRA-1046 — a realized close changes the learned-weights fold; notify the
  // refresh subscribers so the next selection read recomputes (intraday) rather
  // than waiting for the EOD snapshot.
  notifyClose(id, close);
}

/** Classify a signed R-multiple into a WIN/LOSS/SCRATCH verdict. */
export function outcomeForR(realizedR: number, scratchBand = 0.1): OptionTradeOutcome {
  if (realizedR > scratchBand) return 'WIN';
  if (realizedR < -scratchBand) return 'LOSS';
  return 'SCRATCH';
}

/** The DTE bands the close-row rollup splits on. */
export type EntryDteBand = 'lt30' | '30to45' | 'gt45';

/**
 * TRA-1200 — entry-DTE → band around the engine's [30,45] preferred entry
 * window. `30to45` is the current executing window; `gt45` isolates the wider
 * TRA-1028 item-3 DTE-window swing fills (45–90 DTE) so the theta-vs-realized
 * trade-off between the two can be measured per closed cohort. Canonical home
 * for the band vocabulary — `learned-option-weights.ts` re-exports this as
 * `dteBand` so the journal summary and the learned-weights fold can never split
 * DTE on different thresholds.
 */
export function entryDteBand(dte: number): EntryDteBand {
  if (dte < 30) return 'lt30';
  if (dte > 45) return 'gt45';
  return '30to45';
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

/**
 * TRA-991 — the folded record for one id (or undefined if never opened). The
 * close emitter reads it to recover the SAME `atRiskUsd` captured at OPEN, so
 * `realizedR = realizedPnlUsd / atRiskUsd` divides by the entry basis even after
 * a DCA scale-in mutated the live position. Reads the in-memory fold, so it sees
 * an open row appended earlier in the same process without a disk round-trip.
 */
export async function getOptionTradeJournalRecord(
  id: string,
): Promise<OptionTradeJournalRecord | undefined> {
  const map = await ensureLoaded();
  return map.get(id);
}

/** TRA-991 — per-structure rollup row in {@link OptionTradeJournalSummary}. */
export interface OptionTradeJournalStructureStat {
  structure: string;
  closed: number;
  realizedPnlUsd: number;
  winRate: number | null;
  avgR: number | null;
}

/**
 * TRA-1183 — per-archetype rollup row in {@link OptionTradeJournalSummary}.
 * Unlike {@link OptionTradeJournalStructureStat}, `total` counts ALL rows (open +
 * closed) for the archetype so the ema-pullback go/no-go ("fill count vs bare
 * single_leg_rv rate") is measurable from the first fill, before any trade
 * resolves. P&L / win-rate / avg-R remain over RESOLVED rows only. Rows with no
 * archetype tag bucket under `unspecified` (the bare-RV baseline to compare
 * against).
 */
export interface OptionTradeJournalArchetypeStat {
  archetype: string;
  /** All rows (open + closed) carrying this archetype — the headline count. */
  total: number;
  closed: number;
  /**
   * TRA-1200 — WIN/LOSS/SCRATCH split over this archetype's RESOLVED rows, the
   * same columns `byExitReason` carries. Lets the per-item A/B re-test of the
   * TRA-1028 sub-flags read win/loss/scratch by archetype (ema-pullback vs the
   * bare `unspecified` baseline) instead of only a blended avg-R.
   */
  win: number;
  loss: number;
  scratch: number;
  /** scratch / closed for this archetype; null when none closed. */
  scratchRate: number | null;
  realizedPnlUsd: number;
  winRate: number | null;
  avgR: number | null;
}

/**
 * TRA-1200 — per-entry-DTE-band rollup over RESOLVED rows. Splits closed trades
 * on {@link entryDteBand} (`lt30` / `30to45` / `gt45`) so the DTE-window
 * sub-flag's theta-vs-realized trade-off — the wider `gt45` swing window vs the
 * `30to45` default — is measurable per closed cohort rather than blended into
 * one book number. Same WIN/LOSS/SCRATCH/avgR/P&L columns as `byExitReason`;
 * `avgEntryDte` exposes where inside each band the fills actually clustered.
 * Observe-only.
 */
export interface OptionTradeJournalDteBandStat {
  band: EntryDteBand;
  closed: number;
  win: number;
  loss: number;
  scratch: number;
  scratchRate: number | null;
  winRate: number | null;
  avgR: number | null;
  realizedPnlUsd: number;
  /** Mean days-to-expiration at entry across this band's closed rows. */
  avgEntryDte: number | null;
}

/**
 * TRA-1187 — per-exit-reason rollup over RESOLVED rows. The book's headline
 * scratch rate (closes that land inside the ±scratchBand R window) is diluting
 * a thin positive edge; this bucketing pins WHICH exit closes the scratches
 * (`time_stop` vs `supertrend_flip` / `ma20_close_through` structural vs hard
 * `stop` / `expired`) so an exit-tuning change can target the right lever
 * instead of guessing. `scratchRate` is the share of this reason's closes that
 * scratched; `avgHoldDays` / `avgEntryDte` expose the hold-time-vs-DTE mismatch
 * (a multi-week-DTE thesis force-closed after a few bars is the structural
 * scratch driver). Observe-only — does not gate any routing or exit.
 */
export interface OptionTradeJournalExitReasonStat {
  exitReason: string;
  closed: number;
  win: number;
  loss: number;
  scratch: number;
  /** scratch / closed for this reason; null when none closed. */
  scratchRate: number | null;
  winRate: number | null;
  avgR: number | null;
  realizedPnlUsd: number;
  /** Mean calendar days held under this exit reason; null when unknown. */
  avgHoldDays: number | null;
  /** Mean days-to-expiration at entry for rows closed by this reason. */
  avgEntryDte: number | null;
}

// ── TRA-1661 (TRA-1647A) — the byDelta rollup ────────────────────────────────
//
// The cost-aware gate's estimator is `modeledGrossR = winProb·rewardR − (1−winProb)`
// with `winProb = |delta|` and `rewardR ≡ 2.0` (both open sites hard-code
// `stop = mark·0.75`, `target = mark·1.5`), so it collapses to `3·|delta| − 1`.
// Its ENTIRE content is therefore one claim: **realized gross R rises with entry
// delta.** Nothing had ever tested that claim — the gate was armed on it anyway.
//
// The realized book contradicts it. Demo pays ZERO spread (`demoSlippagePct = 0`),
// so demo realized R IS gross R, which makes the journal a valid calibration set
// for a gross model. Across sleeves, the LOWER-delta sleeve realizes MORE gross R:
// `single_leg_rv` at Δ∈[0.30,0.40] models +0.050R and realizes +0.111R (understated
// ~2×), while `single_leg_otm` at Δ∈[0.40,0.50) models +0.350R and realizes +0.062R
// (overstated ~5.6×). The slope points the wrong way.
//
// But that is a CONFOUNDED cross-sleeve comparison — different scanners, signals and
// exit logic — so it refutes "trust the slope" without establishing the true slope.
// Only a WITHIN-sleeve measurement can do that. This rollup is that measurement, and
// it is why the split is per-structure and NEVER pooled: pooling re-introduces the
// exact confound the comparison died of.
//
// ⚠ TWO R BASES, and they differ by 4× (TRA-1656 finding #5). The journal's
// `realizedR` divides by `atRiskUsd` = the FULL PREMIUM. The gate's R is the STOP
// distance = 0.25·premium. Reporting one number would invite exactly the
// silent-unit-mismatch that produced the phantom 1.00R cost input, so every stat
// below is emitted in BOTH bases, explicitly labelled. See {@link GATE_R_BASIS_STRUCTURES}.

/**
 * The structures whose journal `atRiskUsd` is the full premium AND whose stop is
 * `mark·0.75` — i.e. the ones where the gate's R (the stop distance) is exactly
 * `0.25 × the journal's R`, so the premium→gate basis conversion is a clean 4×.
 * These are the long single-leg debit sleeves, which are also precisely the sleeves
 * the cost-aware gate governs.
 *
 * Everything else (credit spreads, iron condors: `atRiskUsd` = width − credit, no
 * `mark·0.75` stop) has NO valid conversion, so its gate-basis stats are emitted as
 * `null` rather than as a wrong number scaled by a factor that does not apply there.
 */
export const GATE_R_BASIS_STRUCTURES: ReadonlySet<string> = new Set([
  'single_leg',
  'single_leg_otm',
  'single_leg_rv',
  // TRA-2245 — the directional single-leg sleeve, renamed out of the shared
  // `single_leg_rv` label. Same instrument as the others here (full-premium
  // atRiskUsd, `mark·0.75` stop) so it keeps the clean 4× premium→gate R basis.
  // `directional` is the legacy live-fill-ledger tag for the same sleeve, kept
  // for hydration back-compat.
  'single_leg_directional',
  'directional',
]);

/** Ratio between the two R bases: gateR = premiumR / 0.25 = 4 × premiumR. */
const GATE_R_PER_PREMIUM_R = 1 / STOP_DISTANCE_FRACTION_OF_MARK;

// Entry-|delta| bucket edges: width 0.05 across [0.20, 0.70], plus catch-alls.
//
// ⚠ Edges are derived by INTEGER arithmetic (hundredths ÷ 100), never by repeated
// float addition or by `(d − min) / width`. Both of those misassign a delta sitting
// EXACTLY on a boundary: in IEEE-754, `0.35 − 0.20 = 0.1499999999999999`, so
// `floor(that / 0.05)` yields 2, not 3, and a 0.35-delta row lands in the [0.30,0.35)
// band. That is not a hypothetical — the RV entry-greeks gate admits Δ∈[0.30,0.40]
// and the OTM floor is exactly 0.40, so real rows pile up ON the edges this rollup
// buckets by. Dividing an integer by 100 reproduces the same double the label prints,
// so `d >= from` compares exactly.
export const DELTA_BUCKET_MIN = 0.2;
export const DELTA_BUCKET_MAX = 0.7;
export const DELTA_BUCKET_WIDTH = 0.05;
const DELTA_BUCKET_MIN_HUNDREDTHS = 20;
const DELTA_BUCKET_MAX_HUNDREDTHS = 70;
const DELTA_BUCKET_WIDTH_HUNDREDTHS = 5;

const LOW_CATCH_ALL = `lt${DELTA_BUCKET_MIN.toFixed(2)}`;
const HIGH_CATCH_ALL = `gte${DELTA_BUCKET_MAX.toFixed(2)}`;

/**
 * TRA-1691 — rows whose entry |delta| was never MEASURED. Distinct from `lt0.20`,
 * and the distinction is load-bearing: `lt0.20` is not an inert catch-all, it is the
 * exact band the OTM entry-delta FLOOR (TRA-1407) exists to cut. Folding an unmeasured
 * row in there grades a missing measurement as evidence against low delta, and drags
 * the band's mean toward the book mean — the same "a counter must report the effective
 * reality, not a convenient default" failure as TRA-1682's `admitRate: null ≠ 0`.
 * Currently n=0 on the live book (every row carries a finite delta); this keeps it
 * that way *observably* rather than by assumption.
 */
const UNKNOWN_DELTA = 'unknown';

/** The half-open `[from, to)` bands, with exactly-representable edges. */
const DELTA_BANDS: ReadonlyArray<{ from: number; to: number; label: string }> = (() => {
  const bands: Array<{ from: number; to: number; label: string }> = [];
  for (
    let e = DELTA_BUCKET_MIN_HUNDREDTHS;
    e < DELTA_BUCKET_MAX_HUNDREDTHS;
    e += DELTA_BUCKET_WIDTH_HUNDREDTHS
  ) {
    const from = e / 100;
    const to = (e + DELTA_BUCKET_WIDTH_HUNDREDTHS) / 100;
    bands.push({ from, to, label: `${from.toFixed(2)}-${to.toFixed(2)}` });
  }
  return bands;
})();

/**
 * TRA-1661 — bucket an entry |delta| into a 0.05-wide band over [0.20, 0.70], with
 * `lt0.20` / `gte0.70` catch-alls so no closed row is silently dropped from the
 * slope fit. Bands are half-open `[from, to)`. Sign is folded (the estimator's
 * winProb is `|delta|`). Labels are stable strings so they survive JSON round-trips
 * as object keys / chart categories.
 *
 * TRA-1691 — a non-finite delta goes to `unknown`, NOT to `lt0.20`. It used to go to
 * `lt0.20`, which made an unmeasured row indistinguishable from a genuine 0.15-delta
 * row inside the one band the delta floor is aimed at. See {@link UNKNOWN_DELTA}.
 */
export function entryDeltaBucket(delta: number): string {
  const d = Math.abs(delta);
  if (!Number.isFinite(d)) return UNKNOWN_DELTA;
  if (d < DELTA_BUCKET_MIN) return LOW_CATCH_ALL;
  if (d >= DELTA_BUCKET_MAX) return HIGH_CATCH_ALL;
  const band = DELTA_BANDS.find((b) => d >= b.from && d < b.to);
  return band?.label ?? HIGH_CATCH_ALL;
}

/**
 * The canonical bucket order: ascending in delta, catch-alls at the ends, with
 * `unknown` LAST — it is not a point on the delta axis, so it must never render as
 * the leftmost (lowest-delta) band of a slope chart.
 */
export function deltaBucketOrder(): string[] {
  return [LOW_CATCH_ALL, ...DELTA_BANDS.map((b) => b.label), HIGH_CATCH_ALL, UNKNOWN_DELTA];
}

/**
 * TRA-1661 — one entry-|delta| band's realized outcome, WITHIN a single structure.
 *
 * `sdRealizedR` is not garnish: with only a point estimate per bucket, a slope fit
 * over these buckets cannot be distinguished from noise, which is precisely the
 * TRA-992 / TRA-1585 coin-flip trap (a positive-looking mean whose CI straddles 0).
 * The dispersion is what lets the re-grade put a confidence interval on the verdict.
 */
export interface OptionTradeJournalDeltaBucketStat {
  /** Band label, e.g. `0.40-0.45`; `lt0.20` / `gte0.70` are the catch-alls. */
  bucket: string;
  /** Inclusive lower edge; null for the low catch-all. */
  deltaFrom: number | null;
  /** Exclusive upper edge; null for the high catch-all. */
  deltaTo: number | null;
  closed: number;
  win: number;
  /** WIN / closed within this band; null when none closed. */
  winRate: number | null;
  /** Σ realized P&L, USD, within this band. */
  realizedPnlUsd: number;
  /** Mean entry |delta| of the band's closed rows — where the mass actually sits. */
  avgEntryDelta: number | null;
  /** Mean realized R in the JOURNAL's basis (÷ atRiskUsd = full premium). */
  avgRealizedR_premiumBasis: number | null;
  /** Mean realized R in the GATE's basis (÷ stop distance = 0.25·premium) = 4×. Null when the structure has no valid conversion. */
  avgRealizedR_gateBasis: number | null;
  /** Sample SD (n−1) of realized R, premium basis; null when closed < 2. */
  sdRealizedR_premiumBasis: number | null;
  /** Sample SD (n−1) of realized R, gate basis; null when closed < 2 or no conversion. */
  sdRealizedR_gateBasis: number | null;
  /** Standard error of the mean (sd/√n), premium basis; null when closed < 2. */
  seRealizedR_premiumBasis: number | null;
  /** Standard error of the mean (sd/√n), gate basis; null when closed < 2 or no conversion. */
  seRealizedR_gateBasis: number | null;
}

/**
 * TRA-1691 — one COHORT of the delta rollup: a `structure × entryArchetype` pair.
 *
 * TRA-1661 shipped this keyed on `structure` alone, on the stated principle that
 * "the sleeves are the confound; pooling them measures the sleeve mix, not the delta
 * slope" — and then pooled three sleeves anyway, because `structure` is not the sleeve.
 * `openOptionFromRvCandidate` historically journaled `structure: 'single_leg_rv'`
 * unconditionally for all of its callers (TRA-1682), so that one label carried the gated
 * RV long, the ungated demo directional churner, and the IV-vs-RV premium buyer.
 * TRA-2245 split the two directional callers out onto `single_leg_directional`, so the
 * `single_leg_rv` label is now reserved for the (compile-time-OFF) RV scan only —
 * forward-only, historical rows keep the old shared label — but keying on `structure`
 * alone is STILL wrong for pre-2245 history, hence the archetype key below.
 *
 * That is not a theoretical confound. On the live book the |Δ| ≥ 0.65 tail — the exact
 * population TRA-1690 grades — is **n=94, of which 37 are `iv-rv-buy-premium`**: a
 * different scanner, different signal, different exit logic, wearing the same structure
 * label. A per-structure read hands the RV-long verdict a 40% dose of another sleeve.
 *
 * `entryArchetype` is the sleeve. Keying on it is what makes the rollup measure what its
 * own comment always claimed to.
 */
export interface OptionTradeJournalDeltaCohortStat {
  /** The journal `structure` label — the R-basis axis (see `gateBasisValid`). */
  structure: string;
  /**
   * The sleeve WITHIN that structure. `unspecified` = untagged, which for the RV
   * structure is the pre-TRA-1682 blend and is NOT a gradeable sleeve: it is history.
   * Tagging is forward-only (rows cannot be back-attributed), so a grade over a tagged
   * sleeve must be scoped with `?sinceTs=` to the tagging deploy — and post-deploy the
   * `single_leg_rv × unspecified` cohort must STOP GROWING. If it doesn't, tagging is
   * broken, and this rollup is the place that shows it.
   */
  entryArchetype: string;
  /** Stable `structure::entryArchetype` key, for use as a chart series / map key. */
  cohort: string;
  closed: number;
  /**
   * Whether `avgRealizedR_gateBasis` etc. are populated — true iff the STRUCTURE's
   * `atRiskUsd` is the full premium and its stop is `mark·0.75`, so the 4× premium→
   * gate conversion holds. False (⇒ gate-basis fields null) for credit spreads. Keyed
   * on structure, not archetype: the R basis is a property of the instrument, not of
   * the scanner that picked it.
   */
  gateBasisValid: boolean;
  /** Bands ascending in delta, catch-alls at the ends. Empty bands are omitted. */
  buckets: OptionTradeJournalDeltaBucketStat[];
}

/**
 * TRA-1600 (deliverable D) — MEASURED per-fill slippage decomposition. Turns the
 * TRA-1599 *parametric* cost model (spread cross ~0.70–0.78R, modeled from the
 * wedge) into a measurement: the mean signed mark-vs-fill cost, in USD and in R
 * (÷ atRiskUsd), for the entry side, the exit side, and the full round trip.
 * `avgRoundTripCostR` is the number the cost-aware gate's per-structure cost
 * model can be recalibrated against once enough fills carry a measurement.
 *
 * Sample counts are surfaced separately from the means so a thin sample reads as
 * "n=3 measured", not a confident average — only rows that actually carry a
 * slippage field contribute; unmeasured rows drop out rather than dragging the
 * mean toward zero. Positive R = COST (we paid worse than mid).
 */
export interface OptionTradeJournalSlippageStat {
  /** Rows (open or closed) carrying an entry-slippage measurement. */
  entrySampled: number;
  /** Closed rows carrying an exit-slippage measurement. */
  exitSampled: number;
  /** Closed rows carrying BOTH entry and exit measurements (a full round trip). */
  roundTripSampled: number;
  /** Mean entry slippage USD over entrySampled; null when none. Positive = cost. */
  avgEntrySlippageUsd: number | null;
  /** Mean exit slippage USD over exitSampled; null when none. Positive = cost. */
  avgExitSlippageUsd: number | null;
  /** Mean entry slippage R (÷ atRiskUsd) over entrySampled; null when none. */
  avgEntrySlippageR: number | null;
  /** Mean exit slippage R over exitSampled; null when none. */
  avgExitSlippageR: number | null;
  /** Mean round-trip (entry+exit) slippage R over roundTripSampled; null when none. */
  avgRoundTripCostR: number | null;
  /** Σ of all measured entry+exit slippage USD across the row set. */
  totalSlippageUsd: number;
}

/**
 * TRA-991 — headline rollup over journal rows, shared by the
 * `/api/health/option-journal` readout and the EOD report section. Counts cover
 * all rows (open + closed); P&L / win-rate / avg-R are over RESOLVED (closed)
 * rows only, so a book full of still-open trades reads as 0 realized, not a
 * misleading win rate.
 */
export interface OptionTradeJournalSummary {
  total: number;
  open: number;
  closed: number;
  win: number;
  loss: number;
  scratch: number;
  /** WIN / closed over resolved rows; null when none resolved. */
  winRate: number | null;
  /** Σ realizedPnlUsd over resolved rows. */
  realizedPnlUsd: number;
  /** Mean realizedR over resolved rows; null when none resolved. */
  avgR: number | null;
  /** Per-structure rollup, descending by closed count then |P&L|. */
  byStructure: OptionTradeJournalStructureStat[];
  /**
   * TRA-1183 — per-entry-archetype rollup, descending by total fills then
   * |P&L|. Counts all fills (open + closed) per archetype so ema-pullback is
   * countable distinctly from the bare-RV `unspecified` baseline.
   */
  byArchetype: OptionTradeJournalArchetypeStat[];
  /**
   * TRA-1187 — per-exit-reason rollup over resolved rows, descending by closed
   * count then scratch count. Lets the readout attribute the headline scratch
   * population to its closing exit (time_stop vs structural vs hard stop) and
   * surface the hold-time-vs-DTE mismatch behind it.
   */
  byExitReason: OptionTradeJournalExitReasonStat[];
  /**
   * TRA-1200 — per-entry-DTE-band rollup over resolved rows, in canonical band
   * order (lt30, 30to45, gt45). Quantifies the DTE-window sub-flag's trade-off
   * so the wider swing window can earn (or fail) a promote-to-default verdict on
   * attributed outcomes instead of a single blended book number.
   */
  byDte: OptionTradeJournalDteBandStat[];
  /**
   * TRA-1661 (TRA-1647A), re-keyed by TRA-1691 — `structure × entryArchetype` ×
   * entry-|delta| rollup over RESOLVED rows. The WITHIN-SLEEVE measurement of the cost
   * gate estimator's one load-bearing claim ("realized gross R rises with entry delta"),
   * which the cross-sleeve read contradicts but cannot cleanly refute. Carries SD/SE so
   * a re-grade can put a CI on the slope instead of a point estimate, and both R bases
   * so the gate's stop-distance R is never silently compared against the journal's
   * premium R. Keyed on the ARCHETYPE because `structure` is not the sleeve — see
   * {@link OptionTradeJournalDeltaCohortStat}.
   */
  byDelta: OptionTradeJournalDeltaCohortStat[];
  /**
   * TRA-1600 (D) — measured mark-vs-fill slippage decomposition over the row set.
   * The spine that makes the TRA-1599 cost attribution *measured* rather than
   * modeled; `avgRoundTripCostR` is the live-cost read the cost-aware gate can be
   * recalibrated against.
   */
  slippage: OptionTradeJournalSlippageStat;
}

/**
 * TRA-1200 — the WIN/LOSS/SCRATCH/avgR/P&L columns over a set of already
 * RESOLVED rows. byArchetype, byExitReason, and byDte all need the identical
 * resolved-row columns; folding them here is the single source so the three
 * rollups can never drift on how a scratch rate or avg-R is computed.
 */
interface ResolvedRollup {
  closed: number;
  win: number;
  loss: number;
  scratch: number;
  scratchRate: number | null;
  winRate: number | null;
  avgR: number | null;
  realizedPnlUsd: number;
}
function rollupResolved(resolved: OptionTradeJournalRecord[]): ResolvedRollup {
  const c = resolved.length;
  const win = resolved.filter((r) => r.outcome === 'WIN').length;
  const loss = resolved.filter((r) => r.outcome === 'LOSS').length;
  const scratch = resolved.filter((r) => r.outcome === 'SCRATCH').length;
  const realizedPnlUsd = resolved.reduce((acc, r) => acc + (r.realizedPnlUsd ?? 0), 0);
  const avgR = c > 0 ? resolved.reduce((acc, r) => acc + (r.realizedR ?? 0), 0) / c : null;
  return {
    closed: c,
    win,
    loss,
    scratch,
    scratchRate: c > 0 ? scratch / c : null,
    winRate: c > 0 ? win / c : null,
    avgR,
    realizedPnlUsd,
  };
}

/** TRA-991 — fold journal rows into the headline summary. Pure. */
export function summarizeOptionTradeJournal(
  rows: OptionTradeJournalRecord[],
): OptionTradeJournalSummary {
  const closedRows = rows.filter((r) => r.outcome !== 'OPEN');
  const closed = closedRows.length;
  const win = closedRows.filter((r) => r.outcome === 'WIN').length;
  const loss = closedRows.filter((r) => r.outcome === 'LOSS').length;
  const scratch = closedRows.filter((r) => r.outcome === 'SCRATCH').length;
  const realizedPnlUsd = closedRows.reduce((acc, r) => acc + (r.realizedPnlUsd ?? 0), 0);
  const avgR =
    closed > 0 ? closedRows.reduce((acc, r) => acc + (r.realizedR ?? 0), 0) / closed : null;

  const byKey = new Map<string, OptionTradeJournalRecord[]>();
  for (const r of closedRows) {
    const list = byKey.get(r.structure) ?? [];
    list.push(r);
    byKey.set(r.structure, list);
  }
  const byStructure: OptionTradeJournalStructureStat[] = [...byKey.entries()]
    .map(([structure, list]) => {
      const c = list.length;
      const wins = list.filter((r) => r.outcome === 'WIN').length;
      const pnl = list.reduce((acc, r) => acc + (r.realizedPnlUsd ?? 0), 0);
      const r = c > 0 ? list.reduce((acc, x) => acc + (x.realizedR ?? 0), 0) / c : null;
      return { structure, closed: c, realizedPnlUsd: pnl, winRate: c > 0 ? wins / c : null, avgR: r };
    })
    .sort((a, b) => b.closed - a.closed || Math.abs(b.realizedPnlUsd) - Math.abs(a.realizedPnlUsd));

  // TRA-1183 — per-archetype rollup. Buckets over ALL rows (open + closed) so a
  // fresh, still-open ema-pullback fill is counted immediately; the bare-RV
  // baseline (no archetype tag) folds under `unspecified`. Resolved-only stats
  // mirror byStructure.
  const byArch = new Map<string, OptionTradeJournalRecord[]>();
  for (const r of rows) {
    const key = r.entryArchetype ?? 'unspecified';
    const list = byArch.get(key) ?? [];
    list.push(r);
    byArch.set(key, list);
  }
  const byArchetype: OptionTradeJournalArchetypeStat[] = [...byArch.entries()]
    .map(([archetype, list]) => {
      const resolved = list.filter((r) => r.outcome !== 'OPEN');
      // TRA-1200 — same WIN/LOSS/SCRATCH/avgR/P&L columns as byExitReason so the
      // per-item A/B re-test reads archetype outcomes, not just a blended avg-R.
      return { archetype, total: list.length, ...rollupResolved(resolved) };
    })
    .sort((a, b) => b.total - a.total || Math.abs(b.realizedPnlUsd) - Math.abs(a.realizedPnlUsd));

  // TRA-1187 — per-exit-reason rollup over RESOLVED rows. Unlabelled closes fold
  // under `unknown` rather than being dropped, so the bucket counts reconcile to
  // `closed`. `avgHoldDays` / `avgEntryDte` are averaged only over rows that
  // carry the field (pre-instrumentation rows fold back as null without skewing
  // the mean toward zero).
  const byReason = new Map<string, OptionTradeJournalRecord[]>();
  for (const r of closedRows) {
    const key = r.exitReason ?? 'unknown';
    const list = byReason.get(key) ?? [];
    list.push(r);
    byReason.set(key, list);
  }
  const meanOf = (list: OptionTradeJournalRecord[], pick: (r: OptionTradeJournalRecord) => number | undefined) => {
    const vals = list.map(pick).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return vals.length > 0 ? vals.reduce((a, v) => a + v, 0) / vals.length : null;
  };
  const byExitReason: OptionTradeJournalExitReasonStat[] = [...byReason.entries()]
    .map(([exitReason, list]) => ({
      exitReason,
      ...rollupResolved(list),
      avgHoldDays: meanOf(list, (x) => x.holdDays),
      avgEntryDte: meanOf(list, (x) => x.entryDte),
    }))
    .sort((a, b) => b.closed - a.closed || b.scratch - a.scratch);

  // TRA-1200 — per-entry-DTE-band rollup over RESOLVED rows. Splits the closed
  // book on `entryDteBand` so the DTE-window sub-flag's wider `gt45` swing
  // window can be measured against the `30to45` default instead of blended into
  // one number. Emitted in canonical band order (lt30, 30to45, gt45) so the
  // readout reads ascending in DTE rather than by count.
  const byDteMap = new Map<EntryDteBand, OptionTradeJournalRecord[]>();
  for (const r of closedRows) {
    const band = entryDteBand(r.entryDte);
    const list = byDteMap.get(band) ?? [];
    list.push(r);
    byDteMap.set(band, list);
  }
  const dteBandOrder: EntryDteBand[] = ['lt30', '30to45', 'gt45'];
  const byDte: OptionTradeJournalDteBandStat[] = [...byDteMap.entries()]
    .map(([band, list]) => ({
      band,
      ...rollupResolved(list),
      avgEntryDte: meanOf(list, (x) => x.entryDte),
    }))
    .sort((a, b) => dteBandOrder.indexOf(a.band) - dteBandOrder.indexOf(b.band));

  // TRA-1661, re-keyed by TRA-1691 — per-COHORT × entry-|delta| rollup over RESOLVED
  // rows. The cohort is `structure × entryArchetype`, because the sleeve is the confound
  // and `structure` is NOT the sleeve: one `single_leg_rv` label carries the gated RV
  // long, the ungated demo directional churner and the IV-vs-RV premium buyer (TRA-1682).
  // Grouping on structure alone re-introduced, one rollup over, the exact pooling this
  // rollup's own comment was written to forbid. Then bucketed on entry |delta| in
  // 0.05-wide bands.
  //
  // Both R bases are emitted per bucket: the journal divides by the full premium, the
  // gate by the stop distance (0.25·premium), a 4× unit gap that has already produced one
  // phantom cost input (TRA-1656 #5). SD is the SAMPLE sd (n−1) so a 1-row bucket reports
  // null rather than a fake-confident 0 dispersion.
  const byDeltaMap = new Map<string, OptionTradeJournalRecord[]>();
  for (const r of closedRows) {
    const cohort = `${r.structure}::${r.entryArchetype ?? 'unspecified'}`;
    const list = byDeltaMap.get(cohort) ?? [];
    list.push(r);
    byDeltaMap.set(cohort, list);
  }
  const bucketOrder = deltaBucketOrder();
  const byDelta: OptionTradeJournalDeltaCohortStat[] = [...byDeltaMap.entries()]
    .map(([cohort, structRows]) => {
      // Read the axes back off a representative row rather than splitting the key: an
      // archetype label is free-form and could itself contain the separator.
      const structure = structRows[0]!.structure;
      const entryArchetype = structRows[0]!.entryArchetype ?? 'unspecified';
      const gateBasisValid = GATE_R_BASIS_STRUCTURES.has(structure);
      const buckets = new Map<string, OptionTradeJournalRecord[]>();
      for (const r of structRows) {
        const key = entryDeltaBucket(r.entryDelta);
        const list = buckets.get(key) ?? [];
        list.push(r);
        buckets.set(key, list);
      }
      const bucketStats: OptionTradeJournalDeltaBucketStat[] = [...buckets.entries()]
        .map(([bucket, list]) => {
          const n = list.length;
          const rs = list.map((r) => r.realizedR ?? 0);
          const mean = n > 0 ? rs.reduce((a, v) => a + v, 0) / n : null;
          // Sample SD (n−1 denominator): the unbiased estimator of the population
          // dispersion, which is what a CI on the mean needs. Undefined at n=1.
          const sd =
            n > 1 && mean !== null
              ? Math.sqrt(rs.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1))
              : null;
          const se = sd !== null && n > 1 ? sd / Math.sqrt(n) : null;
          const toGate = (v: number | null): number | null =>
            gateBasisValid && v !== null ? v * GATE_R_PER_PREMIUM_R : null;
          // Surface the band edges so a consumer never has to parse the label. Read
          // off the same exact band table the bucketing used — the catch-alls are
          // open-ended on their outer side, hence the nulls.
          const band = DELTA_BANDS.find((b) => b.label === bucket);
          return {
            bucket,
            deltaFrom: band ? band.from : bucket === HIGH_CATCH_ALL ? DELTA_BUCKET_MAX : null,
            deltaTo: band ? band.to : bucket === LOW_CATCH_ALL ? DELTA_BUCKET_MIN : null,
            closed: n,
            win: list.filter((r) => r.outcome === 'WIN').length,
            winRate: n > 0 ? list.filter((r) => r.outcome === 'WIN').length / n : null,
            realizedPnlUsd: list.reduce((a, r) => a + (r.realizedPnlUsd ?? 0), 0),
            avgEntryDelta: meanOf(list, (x) => x.entryDelta),
            avgRealizedR_premiumBasis: mean,
            avgRealizedR_gateBasis: toGate(mean),
            sdRealizedR_premiumBasis: sd,
            sdRealizedR_gateBasis: toGate(sd),
            seRealizedR_premiumBasis: se,
            seRealizedR_gateBasis: toGate(se),
          };
        })
        .sort((a, b) => bucketOrder.indexOf(a.bucket) - bucketOrder.indexOf(b.bucket));
      return {
        structure,
        entryArchetype,
        cohort,
        closed: structRows.length,
        gateBasisValid,
        buckets: bucketStats,
      };
    })
    .sort((a, b) => b.closed - a.closed || a.cohort.localeCompare(b.cohort));

  // TRA-1600 (D) — measured slippage decomposition. Only rows carrying a
  // measurement contribute (unmeasured rows drop out rather than dragging the
  // mean to zero); R is USD ÷ the entry-time atRiskUsd basis, guarded against a
  // zero/negative basis. Entry side spans ALL rows (open + closed) since entry
  // slippage is known at open; exit/round-trip span closed rows only.
  const entrySlipRows = rows.filter(
    (r) => typeof r.entrySlippageUsd === 'number' && Number.isFinite(r.entrySlippageUsd) && r.atRiskUsd > 0,
  );
  const exitSlipRows = closedRows.filter(
    (r) => typeof r.exitSlippageUsd === 'number' && Number.isFinite(r.exitSlippageUsd) && r.atRiskUsd > 0,
  );
  const roundTripRows = closedRows.filter(
    (r) =>
      typeof r.entrySlippageUsd === 'number' &&
      Number.isFinite(r.entrySlippageUsd) &&
      typeof r.exitSlippageUsd === 'number' &&
      Number.isFinite(r.exitSlippageUsd) &&
      r.atRiskUsd > 0,
  );
  const meanOrNull = (vals: number[]): number | null =>
    vals.length > 0 ? vals.reduce((a, v) => a + v, 0) / vals.length : null;
  const totalSlippageUsd =
    entrySlipRows.reduce((a, r) => a + (r.entrySlippageUsd ?? 0), 0) +
    exitSlipRows.reduce((a, r) => a + (r.exitSlippageUsd ?? 0), 0);
  const slippage: OptionTradeJournalSlippageStat = {
    entrySampled: entrySlipRows.length,
    exitSampled: exitSlipRows.length,
    roundTripSampled: roundTripRows.length,
    avgEntrySlippageUsd: meanOrNull(entrySlipRows.map((r) => r.entrySlippageUsd as number)),
    avgExitSlippageUsd: meanOrNull(exitSlipRows.map((r) => r.exitSlippageUsd as number)),
    avgEntrySlippageR: meanOrNull(entrySlipRows.map((r) => (r.entrySlippageUsd as number) / r.atRiskUsd)),
    avgExitSlippageR: meanOrNull(exitSlipRows.map((r) => (r.exitSlippageUsd as number) / r.atRiskUsd)),
    avgRoundTripCostR: meanOrNull(
      roundTripRows.map((r) => ((r.entrySlippageUsd as number) + (r.exitSlippageUsd as number)) / r.atRiskUsd),
    ),
    totalSlippageUsd,
  };

  return {
    total: rows.length,
    open: rows.length - closed,
    closed,
    win,
    loss,
    scratch,
    winRate: closed > 0 ? win / closed : null,
    realizedPnlUsd,
    avgR,
    byStructure,
    byArchetype,
    byExitReason,
    byDte,
    byDelta,
    slippage,
  };
}
