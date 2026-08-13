// TRA-1929 (parent TRA-1916) — DURABLE per-trade fee + slippage ledger for the
// bounded 2-day real-money options test.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The board authorized a bounded real-money options test on the live Tradier
// Production account to harvest live FEE + SLIPPAGE calibration data before the
// August go-live gate ("track Tradier fees and slippage per trade"). Every real
// fill (open AND close) writes one row here so the board and LeadDev can read the
// calibration data at `GET /api/health/live-options-fee-slippage` WITHOUT shell
// access to the box.
//
// ── THE DURABILITY CAVEAT THAT IS NOT OPTIONAL (TRA-1681 / TRA-1719) ──────────
// "A persisted file survives a reboot" is TRUE only if DATA_DIR points at a mounted
// persistent disk. With DATA_DIR unset the caller falls back to a path INSIDE the
// build bundle (`index.ts`: `process.env.DATA_DIR ?? join(__dirname,'..','data')`)
// — a real, writable directory whose bytes still evaporate on the next redeploy.
// There is NO error to catch; the only discriminator is the PATH. So
// `durability.ephemeral` (a property of the path, decisive on the very first boot
// before a single row exists) is published in the read payload and MUST be read
// FIRST: `ephemeral: true` ⇒ these records die on the next redeploy and the
// calibration is NOT durably captured — the fix is `DATA_DIR=/data` on bqb1
// (TRA-1719), not code.
//
// ── SCOPE / INVARIANT ────────────────────────────────────────────────────────
// Observe-only telemetry. NEVER places an order or mutates an account — it is a
// write-through of a fill the broker mirror ALREADY executed. `mode` is always
// 'live' (the demo book pays a MODELLED cost, not a real one, so it has nothing to
// calibrate). Unmeasured numeric fields are `null`, NEVER `0` (TRA-1707: a `0`
// slippage/fee reads as "measured, and it was zero" — a false datapoint that would
// bias the mean the board reads; `null` reads as "not measured").

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { TradierTradeHistoryFill, TradierGainLossLot } from '@trading-app/engine';
import { isEphemeralDataDir } from './data-dir.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'live-options-fee-slippage-ledger' });

export const LIVE_OPTIONS_FEE_SLIPPAGE_LOG_FILENAME = 'live-options-fee-slippage.jsonl';

/**
 * Retain this many ms of fill records on disk (compacted on boot). The bounded
 * test runs ~2 days; 30 days comfortably covers reading the calibration back well
 * after the window closes while bounding a file that takes a handful of lines per
 * trade.
 */
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Which automated sleeve fired the fill.
 *
 * TRA-2245 — the directional single-leg sleeve is `single_leg_directional`, matching
 * the journal structure label so the fee/slippage ledger and the trade journal name
 * the sleeve identically. `directional` is the pre-2245 tag for the SAME sleeve, kept
 * as a legacy alias so on-disk rows written before the rename still hydrate (forward-
 * only — old rows are not rewritten). New writes use `single_leg_directional`.
 */
export type LiveFillSleeve =
  | 'single_leg_rv'
  | 'single_leg_otm'
  | 'single_leg_directional'
  | 'directional'
  // TRA-2959 — a fill recovered from broker account-history (or a close whose
  // position carries no usable provenance) has no sleeve to inherit. Naming the
  // absence keeps the row in the ledger without mis-attributing it to a sleeve.
  | 'unattributed';

/** Order side of the fill. */
export type LiveFillSide = 'buy_to_open' | 'sell_to_close';

/**
 * TRA-2850 — provenance of a measured `fees` value:
 * - 'history_commission' — joined from `TradierTradeHistoryFill.commission`.
 *   Only written when the commission is > 0: production history reports 0 on
 *   EVERY row (fees are baked into cost/proceeds, not itemised), so a zero
 *   commission is "unmeasured", not "free".
 * - 'gainloss_derived'   — derived from the settled `/gainloss` lot totals:
 *   `cost − price×100×qty` (open leg) / `price×100×qty − proceeds` (close leg).
 */
export type LiveFeeSource = 'history_commission' | 'gainloss_derived';

function isFeeSource(v: unknown): v is LiveFeeSource {
  return v === 'history_commission' || v === 'gainloss_derived';
}

/**
 * TRA-2959 — how the row got INTO the ledger:
 * - 'fill'           — captured at fill time by an order-path chokepoint (has the
 *   submit-time quote, so slippage is measurable).
 * - 'history_import' — reconstructed by the reconcile pass from broker
 *   account-history because NO chokepoint recorded it (the 2026-08-04 shape: 7 of
 *   11 filled orders never reached the ledger and `appendErrors` stayed 0 — the
 *   writer was never CALLED, so a write-failure counter had nothing to count).
 *   Imported rows carry the broker fill price but no submit-time quote: slippage
 *   stays null (named in the slippage exclusion count), fees remain measurable
 *   via the gainloss join.
 */
export type LiveFillOrigin = 'fill' | 'history_import';

function isOrigin(v: unknown): v is LiveFillOrigin {
  return v === 'fill' || v === 'history_import';
}

/**
 * One real Tradier fill, open or close. Every price is per-contract (per-share ×
 * 1). Slippage is signed in the direction of cost: for a BUY, `filled − ask` > 0
 * means we paid up through the ask; for a SELL it is `filled − ask` in the same
 * raw arithmetic (a grader reads the sign against `side`). Unmeasured fields are
 * `null` (see the file header on why never `0`).
 */
export interface LiveOptionFillRecord {
  /** Always 'live' — the demo book has no real fee/slippage to calibrate. */
  mode: 'live';
  /** Fill time, ms epoch. */
  ts: number;
  /** ET calendar day (America/New_York, YYYY-MM-DD). */
  etDay: string;
  /** Automated sleeve that fired the fill. */
  sleeve: LiveFillSleeve;
  /** OCC option symbol. */
  optionSymbol: string;
  /** Order side. */
  side: LiveFillSide;
  /** Contracts filled. */
  contracts: number;
  /** The limit price we submitted at (null when unknown, e.g. a market exit). */
  submittedLimit: number | null;
  /** Ask at submit (null when the quote had no usable ask, e.g. a one-sided close). */
  askAtSubmit: number | null;
  /** Midpoint at submit (null on a one-sided/ask-only quote — cannot triangulate). */
  midAtSubmit: number | null;
  /** Broker average fill price (null only if the broker omitted it AND no limit fallback). */
  filledPrice: number | null;
  /**
   * Tradier commission / fees for this fill, USD. `null` at fill time — the
   * order-status payload does NOT carry commission; it is only on the account
   * HISTORY endpoint (`TradierTradeHistoryFill.commission`). A follow-up reconcile
   * pass back-fills it; until then it is honestly UNMEASURED (never 0). (TRA-1929)
   */
  fees: number | null;
  /**
   * TRA-2850 — WHO measured `fees`. `null` whenever `fees` is null. A fee value
   * with no source is the pre-2850 poison shape (the commission join wrote a
   * broker field that is 0 on every production row, turning honest-null into a
   * confident $0) — hydrate resets `fees: 0` rows without a source back to null.
   */
  feeSource: LiveFeeSource | null;
  /** `filledPrice − askAtSubmit` (per contract), null when either side is null. */
  slippageVsAsk: number | null;
  /** `filledPrice − midAtSubmit` (per contract), null when either side is null. */
  slippageVsMid: number | null;
  /** Broker order id, when known. */
  orderId: number | null;
  /** TRA-2959 — fill-time capture vs reconcile-time history reconstruction. */
  origin: LiveFillOrigin;
}

/** The mutable inputs a caller hands {@link recordLiveOptionFill}; the module fills ts/etDay/derived slippage. */
export interface LiveOptionFillInput {
  ts: number;
  etDay: string;
  sleeve: LiveFillSleeve;
  optionSymbol: string;
  side: LiveFillSide;
  contracts: number;
  submittedLimit?: number | null;
  askAtSubmit?: number | null;
  midAtSubmit?: number | null;
  filledPrice?: number | null;
  fees?: number | null;
  feeSource?: LiveFeeSource | null;
  orderId?: number | null;
  /** Defaults to 'fill' — only the reconcile importer passes 'history_import'. */
  origin?: LiveFillOrigin;
}

// ── In-memory store (backs the durable records + the health endpoint) ─────────
//
// Module-global + observe-only. `dataDir` is set once at boot by
// hydrateLiveOptionsFeeSlippageFromDisk so the engine chokepoints can append
// without threading a path through the SignalEngine.

let dataDir: string | null = null;
/** All retained fills, oldest-first as read/appended. */
const fills: LiveOptionFillRecord[] = [];
let lastRecordAt: number | null = null;
// TRA-1681 — durability provenance.
let hydratedRecords = 0;
let appendErrors = 0;
let lastAppendError: string | null = null;

export function liveOptionsFeeSlippageLogPath(dir: string): string {
  return join(dir, LIVE_OPTIONS_FEE_SLIPPAGE_LOG_FILENAME);
}

/** Test seam — drop every record and the configured dir. */
export function clearLiveOptionsFeeSlippageLedger(): void {
  dataDir = null;
  fills.length = 0;
  lastRecordAt = null;
  hydratedRecords = 0;
  appendErrors = 0;
  lastAppendError = null;
}

function finiteOrNull(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Build a fully-derived record from a caller input (shared by record + a hydrate re-derive). */
function toRecord(input: LiveOptionFillInput): LiveOptionFillRecord {
  const filledPrice = finiteOrNull(input.filledPrice);
  const askAtSubmit = finiteOrNull(input.askAtSubmit);
  const midAtSubmit = finiteOrNull(input.midAtSubmit);
  const fees = finiteOrNull(input.fees);
  return {
    mode: 'live',
    ts: input.ts,
    etDay: input.etDay,
    sleeve: input.sleeve,
    optionSymbol: input.optionSymbol,
    side: input.side,
    contracts: input.contracts,
    submittedLimit: finiteOrNull(input.submittedLimit),
    askAtSubmit,
    midAtSubmit,
    filledPrice,
    fees,
    // Provenance travels with the value; a null fee can carry no source.
    feeSource: fees !== null && isFeeSource(input.feeSource) ? input.feeSource : null,
    // Derived slippage — null unless BOTH legs are measured (TRA-1707: never 0-as-unknown).
    slippageVsAsk: filledPrice !== null && askAtSubmit !== null ? filledPrice - askAtSubmit : null,
    slippageVsMid: filledPrice !== null && midAtSubmit !== null ? filledPrice - midAtSubmit : null,
    orderId: input.orderId ?? null,
    // Rows written before TRA-2959 carry no origin on disk; they were all
    // captured by fill-time chokepoints, so 'fill' is the honest default.
    origin: isOrigin(input.origin) ? input.origin : 'fill',
  };
}

/**
 * Record one real live option fill (open or close) against the in-memory store AND
 * append one JSONL line under the configured DATA_DIR. Best-effort on IO — a write
 * failure logs, is COUNTED (so the swallow is never silent), and is swallowed so
 * this accounting can never break the trade pass. When no dataDir is configured
 * (unit tests / CLI without boot) the in-memory record still updates; only the file
 * write is skipped.
 */
export function recordLiveOptionFill(input: LiveOptionFillInput): void {
  const rec = toRecord(input);
  fills.push(rec);
  // TRA-2959 — a history import can append a row OLDER than the newest fill;
  // `lastRecordAt` means "newest record", so it never moves backward.
  if (lastRecordAt === null || rec.ts > lastRecordAt) lastRecordAt = rec.ts;
  if (dataDir == null) return;

  const path = liveOptionsFeeSlippageLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    // Swallowed so the trade pass survives — but COUNTED, so the swallow is not silent.
    appendErrors += 1;
    lastAppendError = err instanceof Error ? err.message : String(err);
    log.warn('live-options-fee-slippage append failed', { reason: lastAppendError });
  }
}

/**
 * TRA-2811 — the sleeve the most recent `buy_to_open` row recorded for this
 * contract, or null when the ledger holds no open for it. The close-side
 * recorder MUST prefer this over re-deriving from the position object: on
 * 2026-08-03 three positions opened as `single_leg_otm` closed as
 * `single_leg_directional` because the close re-derived the sleeve from
 * `position.signalType` — a field that does not survive every path a position
 * can take between open and close (a Tradier re-import after a reboot stamps
 * `tradier_import`). The open row in THIS ledger is the authoritative
 * provenance: it was written by the code that chose the sleeve. Rows hydrate
 * from disk on boot (30-day retention), so the join survives reboots wherever
 * the ledger itself does.
 */
export function lastRecordedOpenSleeve(optionSymbol: string): LiveFillSleeve | null {
  for (let i = fills.length - 1; i >= 0; i--) {
    const f = fills[i]!;
    if (f.side === 'buy_to_open' && f.optionSymbol === optionSymbol) return f.sleeve;
  }
  return null;
}

/** What {@link hydrateLiveOptionsFeeSlippageFromDisk} recovered (for the boot log line). */
export interface LiveOptionsFeeSlippageHydration {
  records: number;
  /** TRA-2850 — pre-2850 `fees: 0` rows (no feeSource) reset to honest-null this boot. */
  migrated: number;
}

function isSleeve(v: unknown): v is LiveFillSleeve {
  // TRA-2245 — accept both the new `single_leg_directional` and the legacy
  // `directional` alias so pre-rename on-disk rows still hydrate.
  return (
    v === 'single_leg_rv' ||
    v === 'single_leg_otm' ||
    v === 'single_leg_directional' ||
    v === 'directional' ||
    v === 'unattributed'
  );
}
function isSide(v: unknown): v is LiveFillSide {
  return v === 'buy_to_open' || v === 'sell_to_close';
}

/**
 * Rebuild the in-memory records from disk on boot and remember `dir` for subsequent
 * appends. Idempotent: CLEARS first, so it is safe to call exactly once at startup
 * before any live pass. Only records within {@link RETAIN_MS} of `now` are kept, and
 * the file is COMPACTED to exactly those lines (bounding growth). Best-effort: a
 * missing/corrupt file yields an empty hydration; a torn trailing line is skipped
 * rather than throwing.
 */
export function hydrateLiveOptionsFeeSlippageFromDisk(
  dir: string,
  now: number = Date.now(),
): LiveOptionsFeeSlippageHydration {
  clearLiveOptionsFeeSlippageLedger();
  dataDir = dir;

  let raw = '';
  try {
    raw = readFileSync(liveOptionsFeeSlippageLogPath(dir), 'utf8');
  } catch {
    raw = '';
  }

  const cutoff = now - RETAIN_MS;
  const kept: string[] = [];
  let migrated = 0; // TRA-2850 — `fees: 0` rows with no feeSource reset to null
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let rec: LiveOptionFillRecord;
    try {
      rec = JSON.parse(trimmed) as LiveOptionFillRecord;
    } catch {
      continue; // skip a torn/partial line rather than abort the hydrate
    }
    if (typeof rec.ts !== 'number' || !Number.isFinite(rec.ts) || rec.ts < cutoff) continue;
    if (typeof rec.etDay !== 'string' || rec.etDay === '') continue;
    if (!isSleeve(rec.sleeve) || !isSide(rec.side)) continue;
    if (typeof rec.optionSymbol !== 'string' || rec.optionSymbol === '') continue;
    // TRA-2850 — repair the pre-2850 poison: the commission join back-filled
    // `fees: 0` from a broker field that is 0 on EVERY production history row,
    // converting honest-null ("unmeasured") into a confident $0 ("measured, and
    // it was free"). Those rows carry no `feeSource`. Reset them to null so
    // `feesMeasured` stops counting fees nobody measured; the gainloss-derived
    // reconcile re-measures them with real numbers. A `fees: 0` WITH a source
    // is a genuine measured zero and is kept.
    const sourced = isFeeSource(rec.feeSource);
    const fees = rec.fees === 0 && !sourced ? null : rec.fees;
    if (fees === null && rec.fees === 0) migrated += 1;
    // Re-derive through toRecord so the disk copy and a live record are byte-identical
    // in shape and the slippage invariants hold even if an old line was hand-edited.
    const clean = toRecord({
      ts: rec.ts,
      etDay: rec.etDay,
      sleeve: rec.sleeve,
      optionSymbol: rec.optionSymbol,
      side: rec.side,
      contracts: typeof rec.contracts === 'number' && Number.isFinite(rec.contracts) ? rec.contracts : 0,
      submittedLimit: rec.submittedLimit,
      askAtSubmit: rec.askAtSubmit,
      midAtSubmit: rec.midAtSubmit,
      filledPrice: rec.filledPrice,
      fees,
      feeSource: sourced ? rec.feeSource : null,
      orderId: rec.orderId,
      origin: rec.origin,
    });
    fills.push(clean);
    kept.push(JSON.stringify(clean));
    if (clean.ts > (lastRecordAt ?? 0)) lastRecordAt = clean.ts;
  }

  // Compact: rewrite the file to the retained lines only (best-effort). Skipped when
  // there is nothing to drop AND nothing was migrated, to avoid a needless rewrite on
  // every clean boot. A TRA-2850 poison repair (fees:0 → null) changes content without
  // changing the count, so it forces the rewrite too — otherwise the poison would sit
  // on disk and be re-migrated every boot.
  const nonEmptyLines = raw.split('\n').filter((l) => l.trim() !== '').length;
  if (kept.length < nonEmptyLines || migrated > 0) {
    const path = liveOptionsFeeSlippageLogPath(dir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8');
    } catch (err) {
      log.warn('live-options-fee-slippage compaction failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  hydratedRecords = kept.length;
  if (migrated > 0) {
    log.info('live-options-fee-slippage hydrate reset unsourced fees:0 rows to null (TRA-2850)', {
      migrated,
    });
  }
  return { records: kept.length, migrated };
}

// ── TRA-1954: fee back-fill reconcile ────────────────────────────────────────
//
// Fees are the ONE calibration field the fill-time path cannot capture: Tradier's
// order-status payload carries no commission, so `recordLiveOptionFill` always
// writes `fees: null` (honest-unmeasured, TRA-1707). Commission is only on the
// account-HISTORY endpoint (`TradierTradeHistoryFill.commission`). This pass joins
// the two AFTER the fills land and back-fills `fees` where an unambiguous match
// exists.
//
// THE JOIN HAS NO CLEAN KEY. History fills carry no `orderId`, so we match on the
// composite (optionSymbol==symbol, etDay==date, side↔description, contracts==quantity).
// Collisions (two identical symbol/day/side/qty fills) are paired DETERMINISTICALLY —
// ledger rows ascending by ts, history fills ascending by transactionId, zipped — and
// a history fill is NEVER assigned to two ledger rows. A ledger row with no unconsumed
// history fill keeps `fees: null` (never 0 — an unmatched row is UNMEASURED, not a
// measured zero — TRA-1707).
//
// CAVEAT the reader must hold: `parseTradierHistory` coerces an ABSENT commission to 0
// (it cannot tell absent from a genuine $0). Sandbox history reports no commission, so
// a sandbox reconcile back-fills `fees: 0` on matched rows — a real number for a real
// (zero-fee) sandbox fill, but NOT production calibration. Real fee numbers only exist
// after PRODUCTION fills (TRA-1929 scope note); read the arm/durability context before
// trusting a `totalFees` harvested off sandbox.

/** Result of a back-fill pass: how many rows gained a fee + the full re-derived set. */
export interface FeeBackfillResult {
  /** Ledger rows that went from `fees: null` to a measured commission this pass. */
  updated: number;
  /** The full record set, re-derived through {@link toRecord} (slippage invariants hold). */
  records: LiveOptionFillRecord[];
}

/**
 * Map a history fill's `description` to the ledger side it can back-fill, or null.
 * When the description contains action keywords ("Buy to Open" / "Sell to Close"),
 * those are authoritative. When the description is instrument-only (e.g. Tradier
 * production returns "CALL AMZN   09/04/26   295" without an action prefix), we
 * fall back to the `amount` sign: negative = cash outflow = buy_to_open,
 * positive = cash inflow = sell_to_close. `amount` of exactly 0 is ambiguous
 * and returns null.
 */
export function historyFillSide(description: string, amount?: number): LiveFillSide | null {
  const s = description.toLowerCase();
  if (s.includes('buy to open')) return 'buy_to_open';
  if (s.includes('sell to close')) return 'sell_to_close';
  // amount-based fallback for instrument-only descriptions (production Tradier format)
  if (typeof amount === 'number' && Number.isFinite(amount) && amount !== 0) {
    return amount < 0 ? 'buy_to_open' : 'sell_to_close';
  }
  return null; // Buy-to-Close / Sell-to-Open short legs aren't in the live sleeves.
}

/** Composite join key. ` ` separator can't collide with an OCC symbol / date. */
function feeMatchKey(symbol: string, day: string, side: LiveFillSide, qty: number): string {
  return `${symbol} ${day} ${side} ${qty}`;
}

/** Reverse a record into the input shape {@link toRecord} consumes (optionally overriding fees + source). */
function recordToInput(
  rec: LiveOptionFillRecord,
  feesOverride?: number | null,
  feeSourceOverride?: LiveFeeSource | null,
): LiveOptionFillInput {
  return {
    ts: rec.ts,
    etDay: rec.etDay,
    sleeve: rec.sleeve,
    optionSymbol: rec.optionSymbol,
    side: rec.side,
    contracts: rec.contracts,
    submittedLimit: rec.submittedLimit,
    askAtSubmit: rec.askAtSubmit,
    midAtSubmit: rec.midAtSubmit,
    filledPrice: rec.filledPrice,
    fees: feesOverride !== undefined ? feesOverride : rec.fees,
    feeSource: feesOverride !== undefined ? feeSourceOverride ?? null : rec.feeSource,
    orderId: rec.orderId,
    origin: rec.origin,
  };
}

/**
 * PURE back-fill: given ledger `records` and Tradier account-history `historyFills`,
 * return a new record set with `fees` populated on every ledger row that has an
 * unambiguous history match. See the section header for the join key + collision
 * rule. Deterministic and idempotent: an already-populated row still CONSUMES its
 * matched history fill (so a duplicate null row can't steal it) but is not re-counted
 * as `updated`. Unmatched rows keep `fees: null` (never 0). No IO — fully fixture-testable.
 */
export function reconcileLedgerFees(
  records: readonly LiveOptionFillRecord[],
  historyFills: readonly TradierTradeHistoryFill[],
): FeeBackfillResult {
  // Two-path join. orderId (when both sides carry it) is the primary; composite
  // key (symbol + etDay + side + qty) is the fallback that handles the current
  // production state where Tradier account-history does NOT return order_id.
  // A fill is tracked in `consumed` once assigned so it can never back-fill
  // two ledger rows, regardless of which path matched it.
  const consumed = new Set<TradierTradeHistoryFill>();

  // Group ALL eligible history fills by composite key so the composite path
  // can find any fill (even those whose orderId already matched another row).
  const historyByOrderId = new Map<number, TradierTradeHistoryFill>();
  const historyByKey = new Map<string, TradierTradeHistoryFill[]>();
  for (const f of historyFills) {
    if (f.tradeType !== 'option') continue;
    const side = historyFillSide(f.description, f.amount);
    if (side === null) continue;
    if (typeof f.quantity !== 'number' || !Number.isFinite(f.quantity) || f.quantity <= 0) continue;
    // TRA-2850 — commission must be POSITIVE, not merely finite. Production Tradier
    // history reports `commission: 0` on every row (fees are baked into the event
    // amount, not itemised), so back-filling a 0 converts honest-null ("unmeasured")
    // into a false "measured, and it was free". A zero-commission fill is simply not
    // a fee measurement; the gainloss-derived pass measures those rows instead.
    if (typeof f.commission !== 'number' || !Number.isFinite(f.commission) || f.commission <= 0) continue;
    if (f.orderId != null) historyByOrderId.set(f.orderId, f);
    const key = feeMatchKey(f.symbol, f.date, side, f.quantity);
    const q = historyByKey.get(key);
    if (q) q.push(f);
    else historyByKey.set(key, [f]);
  }
  for (const q of historyByKey.values()) {
    q.sort((a, b) =>
      a.transactionId < b.transactionId ? -1 : a.transactionId > b.transactionId ? 1 : 0,
    );
  }

  // Walk ledger rows in deterministic order (ts asc, then original index) so the
  // ascending-ts pairing the collision rule promises is exactly what runs.
  const order = records
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.ts - b.r.ts || a.i - b.i);

  const cursor = new Map<string, number>(); // composite key → next unconsumed fill index
  const feeByIndex = new Map<number, number>(); // original record index → back-filled commission
  for (const { r, i } of order) {
    let matched: TradierTradeHistoryFill | undefined;

    // orderId path — unambiguous when Tradier includes order_id in history.
    if (r.orderId != null) {
      const f = historyByOrderId.get(r.orderId);
      if (f && !consumed.has(f)) matched = f;
    }

    // Composite-key path — fallback for fills without orderId (current production)
    // and for ledger rows whose orderId didn't resolve above.
    if (!matched) {
      const key = feeMatchKey(r.optionSymbol, r.etDay, r.side, r.contracts);
      const q = historyByKey.get(key);
      if (q) {
        let c = cursor.get(key) ?? 0;
        while (c < q.length && consumed.has(q[c]!)) c++; // skip already-consumed fills
        cursor.set(key, c);
        if (c < q.length) {
          matched = q[c]!;
          cursor.set(key, c + 1);
        }
      }
    }

    if (matched) {
      consumed.add(matched);
      if (r.fees === null) feeByIndex.set(i, matched.commission);
    }
  }

  let updated = 0;
  const out = records.map((r, i) => {
    if (feeByIndex.has(i)) {
      updated += 1;
      return toRecord(recordToInput(r, feeByIndex.get(i)!, 'history_commission'));
    }
    return toRecord(recordToInput(r));
  });
  return { updated, records: out };
}

// ── TRA-2850: gainloss-derived fee back-fill ─────────────────────────────────
//
// TRA-2810's commission join shipped, changed the reported number, and measured
// nothing: production Tradier account-history reports `orderId: null` AND
// `commission: 0` on EVERY row, so the join either never matched or — worse —
// back-filled a confident $0 onto rows whose fee was real. The fees ARE
// observable, one endpoint over: a settled `/gainloss` lot states `cost`
// (fees-included) and `proceeds` (fees-net), so against the ledger's own fill
// prices:   openFee  = cost     − filledPrice×100×qty
//           closeFee = filledPrice×100×qty − proceeds
// (measured 2026-08-05 on the live ***0154 account: ~$0.10–0.13/contract/leg).
//
// THE JOIN: lots and ledger rows are grouped by (symbol, ET day, side) — a
// lot's open leg keys on `openDate` against `buy_to_open` rows, its close leg
// on `closeDate` against `sell_to_close` rows. Tradier splits lots FIFO, so a
// single 4-contract fill can settle as 1+3 lots (and vice versa); requiring a
// per-lot qty==contracts match would silently skip those. Instead the group's
// LOT total must equal the group's ROW total; the group fee is then derived on
// the totals and apportioned pro-rata by contracts (fees are per-contract to
// first order). Totals that don't reconcile ⇒ the whole group stays null —
// honest-unmeasured, never a guess.
//
// SANITY BOUND: a derived fee is only written when 0 ≤ fee ≤ $0.90/contract.
// Tradier's published equity-option fee stack (≤$0.35 commission + ORF/OCC/
// SEC/TAF pennies) tops out well under $0.60/contract, while the smallest
// possible mis-pairing artifact — a 1-cent price mismatch — is $1.00/contract.
// The bound sits between the two populations, so it admits every plausible fee
// and rejects every join artifact. Negative ⇒ the lot didn't come from these
// fills ⇒ skip (null), never clamp.

/** Per-contract ceiling a gainloss-derived fee must clear to be written (see above). */
const GAINLOSS_FEE_MAX_PER_CONTRACT_USD = 0.9;

/**
 * TRA-3558 — WHY one (symbol, ET day, side) group holding an unmeasured row did
 * not derive a fee. A bare `no-match` is unactionable: it collapses "the lot
 * never came back from the broker" into "the lot came back and the join rejected
 * it", and those need opposite fixes. Each reason below is ONE test in the join,
 * in the order the join applies them:
 * - 'no-lot'        — nothing in the fetched lots keys to this group at all.
 * - 'priceless-row' — a row in the group has no `filledPrice` (or no contracts),
 *                     so the group's gross is not computable.
 * - 'qty-mismatch'  — lots and rows both exist but their contract totals differ.
 * - 'negative-fee'  — the derived fee is below 0 (the lot is not these fills).
 * - 'above-bound'   — the derived fee exceeds $0.90/contract (a join artifact).
 */
export type GainLossRejectionReason =
  | 'no-lot'
  | 'priceless-row'
  | 'qty-mismatch'
  | 'negative-fee'
  | 'above-bound';

/**
 * TRA-3558 — one rejected group, with THE TWO NUMBERS that decided it. `observed`
 * and `expected` are in the reason's own units (contracts for the qty tests, USD
 * for the fee tests, rows for 'priceless-row'); `detail` renders them so a reader
 * of the health route needs no source access to act on it.
 */
export interface GainLossRejection {
  symbol: string;
  /** ET day of the ledger rows in this group. */
  day: string;
  side: LiveFillSide;
  reason: GainLossRejectionReason;
  /** Rows this rejection keeps at `fees: null`. */
  unmeasuredRows: number;
  observed: number;
  expected: number;
  detail: string;
}

/** {@link FeeBackfillResult} plus the named reason for every group that did NOT derive. */
export interface GainLossBackfillResult extends FeeBackfillResult {
  /**
   * One entry per (symbol, day, side) group that still holds an unmeasured row
   * after this pass. Empty ⇒ every unmeasured row was measured. Ordered most
   * recent ET day first, so the ACTIONABLE groups lead (aged rows sort last).
   */
  rejections: GainLossRejection[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * PURE gainloss-derived back-fill: populate `fees` on unmeasured ledger rows from
 * settled Tradier `/gainloss` lots (see the section header for the join + bound).
 * Idempotent: rows already measured keep their value and their group still
 * reconciles around them. No IO — fully fixture-testable.
 */
export function reconcileLedgerFeesFromGainLoss(
  records: readonly LiveOptionFillRecord[],
  lots: readonly TradierGainLossLot[],
): GainLossBackfillResult {
  // Lot totals per (symbol, day, side): the basis is fees-INCLUSIVE cost for the
  // open leg and fees-NET proceeds for the close leg.
  const lotTotals = new Map<string, { qty: number; basis: number }>();
  const addLot = (key: string, qty: number, basis: number): void => {
    const t = lotTotals.get(key);
    if (t) {
      t.qty += qty;
      t.basis += basis;
    } else lotTotals.set(key, { qty, basis });
  };
  for (const lot of lots) {
    addLot(feeMatchKey(lot.symbol, lot.openDate, 'buy_to_open', 0), lot.quantity, lot.cost);
    addLot(feeMatchKey(lot.symbol, lot.closeDate, 'sell_to_close', 0), lot.quantity, lot.proceeds);
  }

  // ALL ledger rows per group — measured rows participate in the totals (their
  // contracts are inside the lot totals too); only null rows are written.
  const rowGroups = new Map<string, number[]>();
  records.forEach((r, i) => {
    const key = feeMatchKey(r.optionSymbol, r.etDay, r.side, 0);
    const g = rowGroups.get(key);
    if (g) g.push(i);
    else rowGroups.set(key, [i]);
  });

  const feeByIndex = new Map<number, number>();
  const rejections: GainLossRejection[] = [];
  for (const [key, indices] of rowGroups) {
    const unmeasuredRows = indices.filter((i) => records[i]!.fees === null).length;
    if (unmeasuredRows === 0) continue; // nothing to measure — not a rejection
    const first = records[indices[0]!]!;
    // TRA-3558 — every `continue` below MUST route through this, so a group can
    // never leave the loop unmeasured AND unexplained.
    const reject = (
      reason: GainLossRejectionReason,
      observed: number,
      expected: number,
      detail: string,
    ): void => {
      rejections.push({
        symbol: first.optionSymbol,
        day: first.etDay,
        side: first.side,
        reason,
        unmeasuredRows,
        observed,
        expected,
        detail,
      });
    };

    // Group totals. `groupContracts` counts EVERY row (so a no-lot group can be
    // described honestly); `rowQty`/`rowGross` only the priced ones.
    let groupContracts = 0;
    let rowQty = 0;
    let rowGross = 0;
    let pricedRows = 0;
    for (const i of indices) {
      const r = records[i]!;
      groupContracts += r.contracts;
      if (r.filledPrice === null || !(r.contracts > 0)) continue;
      pricedRows += 1;
      rowQty += r.contracts;
      rowGross += r.filledPrice * 100 * r.contracts;
    }

    const lotTotal = lotTotals.get(key);
    if (!lotTotal) {
      reject(
        'no-lot',
        0,
        groupContracts,
        `no settled gainloss lot keys to ${key}: the ledger holds ${groupContracts} contract(s), the fetched lots hold 0 — the lot is either ABSENT from the fetch (unsettled, or outside the window) or keyed to a different symbol, date or side; compare against lastGainLossSample`,
      );
      continue;
    }
    if (pricedRows !== indices.length) {
      reject(
        'priceless-row',
        pricedRows,
        indices.length,
        `${indices.length - pricedRows} of ${indices.length} row(s) in this group carry no filledPrice (or no contracts), so the group gross is not computable — the whole group stays null rather than derive a fee off a partial gross`,
      );
      continue;
    }
    if (rowQty !== lotTotal.qty) {
      reject(
        'qty-mismatch',
        rowQty,
        lotTotal.qty,
        `ledger holds ${rowQty} contract(s) for ${key} but the settled lots total ${lotTotal.qty} — totals must reconcile exactly before a fee is apportioned`,
      );
      continue;
    }

    const side = first.side;
    const groupFee = round2(side === 'buy_to_open' ? lotTotal.basis - rowGross : rowGross - lotTotal.basis);
    if (groupFee < 0) {
      reject(
        'negative-fee',
        groupFee,
        0,
        `derived fee ${groupFee} is negative (lot basis ${round2(lotTotal.basis)} vs row gross ${round2(rowGross)}) — the lot did not come from these fills; never clamped to 0`,
      );
      continue;
    }
    const bound = round2(GAINLOSS_FEE_MAX_PER_CONTRACT_USD * rowQty);
    if (groupFee > bound) {
      reject(
        'above-bound',
        groupFee,
        bound,
        `derived fee ${groupFee} exceeds the ${GAINLOSS_FEE_MAX_PER_CONTRACT_USD}/contract sanity bound (${bound} for ${rowQty} contract(s)) — a mis-pairing artifact, not a fee`,
      );
      continue;
    }

    for (const i of indices) {
      const r = records[i]!;
      if (r.fees !== null) continue; // keep an existing measurement
      feeByIndex.set(i, round2((groupFee * r.contracts) / rowQty));
    }
  }
  // Most recent ET day first: the ACTIONABLE groups are the newest, and a
  // truncated publish must not drop them in favour of aged ones.
  rejections.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  let updated = 0;
  const out = records.map((r, i) => {
    if (feeByIndex.has(i)) {
      updated += 1;
      return toRecord(recordToInput(r, feeByIndex.get(i)!, 'gainloss_derived'));
    }
    return toRecord(recordToInput(r));
  });
  return { updated, records: out, rejections };
}

/** Swap a reconcile result into the store and, when rows changed, REWRITE the durable JSONL. */
function applyBackfillResult(result: FeeBackfillResult): void {
  fills.length = 0;
  for (const r of result.records) fills.push(r);

  if (dataDir !== null && result.updated > 0) {
    const path = liveOptionsFeeSlippageLogPath(dataDir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        fills.length > 0 ? fills.map((r) => JSON.stringify(r)).join('\n') + '\n' : '',
        'utf8',
      );
    } catch (err) {
      // Swallowed so the reconcile pass survives — but COUNTED, so the swallow is not silent.
      appendErrors += 1;
      lastAppendError = err instanceof Error ? err.message : String(err);
      log.warn('live-options-fee-slippage back-fill rewrite failed', { reason: lastAppendError });
    }
  }
}

/**
 * Apply {@link reconcileLedgerFees} against the module's in-memory store, replace it
 * with the reconciled records, and REWRITE the durable JSONL so a redeploy keeps the
 * back-filled fees. The rewrite reuses the compaction write shape and is best-effort +
 * COUNTED (a failure logs, bumps `appendErrors`, and is swallowed so the reconcile can
 * never throw). Only rewrites when at least one row changed. When no dataDir is
 * configured (unit tests / CLI without boot) only the in-memory store updates.
 */
export function backfillLiveOptionFees(
  historyFills: readonly TradierTradeHistoryFill[],
): FeeBackfillResult {
  const result = reconcileLedgerFees(fills, historyFills);
  applyBackfillResult(result);
  return result;
}

/**
 * TRA-2850 — apply {@link reconcileLedgerFeesFromGainLoss} against the in-memory
 * store with the same durable-rewrite semantics as {@link backfillLiveOptionFees}.
 */
export function backfillLiveOptionFeesFromGainLoss(
  lots: readonly TradierGainLossLot[],
): GainLossBackfillResult {
  const result = reconcileLedgerFeesFromGainLoss(fills, lots);
  applyBackfillResult(result);
  return result;
}

// ── TRA-2959: fill-coverage cross-check + history import ─────────────────────
//
// 2026-08-04 exposed the failure class `appendErrors` structurally cannot see:
// 7 of 11 filled orders never produced a ledger row because the close went
// through the pending-close reconcile sweep, which booked the broker fill
// without CALLING the recorder. A write-failure counter reads 0 when the writer
// is never invoked — silence that a coverage gate then consumes as health.
//
// The independent denominator is the broker's own account history: every filled
// order is an event there regardless of which code path (or no code path)
// observed it. This pass compares CONTRACT TOTALS per (symbol, ET day, side)
// between history and the ledger and APPENDS a `history_import` row for any
// shortfall, so the ledger converges on the broker's record even when a future
// code path forgets to record — and the gap is COUNTED, not silent.
//
// Two deliberate exclusions:
// - Same-ET-day fills are NOT imported. The fill-time chokepoints (and the
//   sweep, instrumented in TRA-2959) record within a tick; importing intraday
//   would race them and double-count. A gap heals on the first pass of the
//   next ET day.
// - History rows whose side cannot be classified (`historyFillSide` null) are
//   skipped, same as the fee joins.
//
// Imported rows have no submit-time quote: slippage stays null and the row is
// counted in the slippage exclusion bucket. `filledPrice` comes from the
// history event, so the gainloss fee join measures the row's fees — which also
// repairs the group-total reconciliation that a MISSING row was breaking (a
// gainloss group only derives fees when ledger qty == lot qty, so one silent
// fill poisoned its whole symbol/day/side group).

/** Coverage of broker history by the ledger, contract-denominated. */
export interface LedgerCoverageResult {
  /** Option contracts filled at the broker in the window (classifiable rows). */
  brokerContracts: number;
  /** Contracts the ledger held for those same (symbol, day, side) groups BEFORE import. */
  ledgerContracts: number;
  /** Shortfall found this pass (brokerContracts − matched ledger contracts, prior days only). */
  missingContracts: number;
  /** Rows appended this pass to close the shortfall. */
  importedRows: number;
}

/**
 * PURE diff: which history fills (prior ET days only, `< todayEt`) are not
 * covered by ledger contract totals, returned as ready-to-append inputs.
 * Deterministic and idempotent — once imported, the totals match and the next
 * pass returns nothing.
 */
export function diffMissingFillsFromHistory(
  records: readonly LiveOptionFillRecord[],
  historyFills: readonly TradierTradeHistoryFill[],
  todayEt: string,
): { inputs: LiveOptionFillInput[]; coverage: LedgerCoverageResult } {
  // History contract totals + per-fill detail per (symbol, day, side).
  const histGroups = new Map<string, { qty: number; fills: TradierTradeHistoryFill[]; side: LiveFillSide }>();
  let brokerContracts = 0;
  for (const f of historyFills) {
    if (f.tradeType !== 'option') continue;
    const side = historyFillSide(f.description, f.amount);
    if (side === null) continue;
    if (typeof f.quantity !== 'number' || !Number.isFinite(f.quantity) || f.quantity <= 0) continue;
    brokerContracts += f.quantity;
    const key = feeMatchKey(f.symbol, f.date, side, 0);
    const g = histGroups.get(key);
    if (g) {
      g.qty += f.quantity;
      g.fills.push(f);
    } else histGroups.set(key, { qty: f.quantity, fills: [f], side });
  }

  // Ledger contract totals for the SAME groups (only groups history knows about —
  // ledger-only rows, e.g. pre-account-migration fills, are not a coverage gap).
  let ledgerContracts = 0;
  const ledgerQtyByKey = new Map<string, number>();
  for (const r of records) {
    const key = feeMatchKey(r.optionSymbol, r.etDay, r.side, 0);
    if (!histGroups.has(key)) continue;
    ledgerQtyByKey.set(key, (ledgerQtyByKey.get(key) ?? 0) + r.contracts);
    ledgerContracts += r.contracts;
  }

  const inputs: LiveOptionFillInput[] = [];
  let missingContracts = 0;
  for (const [key, g] of histGroups) {
    const day = g.fills[0]!.date;
    if (day >= todayEt) continue; // intraday fills belong to the fill-time recorders
    let shortfall = g.qty - (ledgerQtyByKey.get(key) ?? 0);
    if (shortfall <= 0) continue;
    missingContracts += shortfall;
    // Attribute the shortfall to the LAST executions of the group (transactionId
    // order): the recorded rows were recorded as they filled, so the uncovered
    // tail is the best deterministic guess — and for fee/coverage purposes only
    // the contract totals and prices matter, not the pairing.
    const ordered = [...g.fills].sort((a, b) =>
      a.transactionId < b.transactionId ? 1 : a.transactionId > b.transactionId ? -1 : 0,
    );
    for (const f of ordered) {
      if (shortfall <= 0) break;
      const qty = Math.min(shortfall, f.quantity);
      shortfall -= qty;
      inputs.push({
        // History carries only the ET calendar day; noon-ET-ish is honest enough
        // for retention/ordering (17:00Z is 12:00/13:00 ET year-round).
        ts: Date.parse(`${day}T17:00:00Z`),
        etDay: day,
        // A close inherits its sleeve from the ledger's own open row when one
        // exists; anything else is honestly unattributed.
        sleeve:
          g.side === 'sell_to_close'
            ? sleeveOfLastOpenIn(records, f.symbol) ?? 'unattributed'
            : 'unattributed',
        optionSymbol: f.symbol,
        side: g.side,
        contracts: qty,
        submittedLimit: null,
        askAtSubmit: null,
        midAtSubmit: null,
        filledPrice: typeof f.price === 'number' && Number.isFinite(f.price) && f.price > 0 ? f.price : null,
        fees: null,
        orderId: f.orderId ?? null,
        origin: 'history_import',
      });
    }
  }
  return {
    inputs,
    coverage: { brokerContracts, ledgerContracts, missingContracts, importedRows: inputs.length },
  };
}

/** {@link lastRecordedOpenSleeve} against an explicit record set (pure helper). */
function sleeveOfLastOpenIn(
  records: readonly LiveOptionFillRecord[],
  optionSymbol: string,
): LiveFillSleeve | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const f = records[i]!;
    if (f.side === 'buy_to_open' && f.optionSymbol === optionSymbol) return f.sleeve;
  }
  return null;
}

/**
 * Apply {@link diffMissingFillsFromHistory} against the in-memory store,
 * appending one durable JSONL line per imported row (the same counted,
 * best-effort append semantics as a fill-time record).
 */
export function importMissingLiveOptionFills(
  historyFills: readonly TradierTradeHistoryFill[],
  todayEt: string,
): LedgerCoverageResult {
  const { inputs, coverage } = diffMissingFillsFromHistory(fills, historyFills, todayEt);
  for (const input of inputs) recordLiveOptionFill(input);
  if (inputs.length > 0) {
    log.warn('live-options fee-slippage ledger imported broker fills NO chokepoint recorded (TRA-2959)', {
      importedRows: inputs.length,
      missingContracts: coverage.missingContracts,
    });
  }
  return coverage;
}

// ── Health summary ───────────────────────────────────────────────────────────

/** TRA-1681 — is anything this module reports actually ON DISK? Read `ephemeral` FIRST. */
export interface LiveOptionsFeeSlippageDurability {
  /** Resolved append target. `null` = memory-only: no boot hydrate ran, NOTHING is durable. */
  dataDir: string | null;
  /**
   * TRUE ⇒ every record in this payload dies on the next redeploy. The calibration is
   * NOT durably captured — the fix is `DATA_DIR=/data` on bqb1 (TRA-1719), not code.
   */
  ephemeral: boolean;
  /** Records recovered FROM DISK at boot. Distinguishes a real ledger from this-uptime-only. */
  hydratedRecords: number;
  /** Appends that threw and were SWALLOWED. > 0 ⇒ the counts above overstate disk. */
  appendErrors: number;
  /** Message from the most recent swallowed append (null when none). */
  lastAppendError: string | null;
}

/** Mean/median of the measured (non-null) values, or null when none measured. */
function stats(values: number[]): { n: number; mean: number | null; median: number | null } {
  if (values.length === 0) return { n: 0, mean: null, median: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { n: sorted.length, mean, median };
}

function round(n: number | null, dp = 4): number | null {
  if (n === null) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export interface SlippageSummary {
  /** Count of fills with a MEASURED slippage-vs-ask (denominator is measured, not total). */
  nMeasured: number;
  /**
   * TRA-2959 — the DENOMINATOR, stated next to the numerator: total fills in the
   * ledger, measured or not. `nMeasured < nTotal` ⇒ the means/medians below are a
   * SUBSET — and a structurally biased one: the excluded fills are exactly the
   * market/emergency exits with no submit-time quote, where slippage is worst.
   * Never read `medianVsAsk` without reading this pair.
   */
  nTotal: number;
  /**
   * TRA-2959 — the named exclusion: fills with NO usable submit-time ask quote
   * (market orders, one-sided books, and `history_import` reconstructions).
   * Slippage-vs-ask is structurally unmeasurable for these; they are excluded
   * BY NAME with a count, not silently absent. `nMeasured + excludedNoAskQuote
   * === nTotal` always.
   */
  excludedNoAskQuote: number;
  meanVsAsk: number | null;
  medianVsAsk: number | null;
  meanVsMid: number | null;
  medianVsMid: number | null;
}

export interface LiveOptionsFeeSlippageSummary {
  /** Total fills recorded (open + close, live + hydrated). */
  n: number;
  /** Fills split by side. */
  opens: number;
  closes: number;
  /** Slippage summary over all fills (measured legs only). */
  slippage: SlippageSummary;
  /**
   * Total measured Tradier fees, USD, and how many fills had a measured (non-null)
   * fee. `feesMeasured < n` ⇒ some fills' commission is not yet back-filled — do NOT
   * read `totalFees` as complete (TRA-1929 fee reconcile is a follow-up).
   */
  totalFees: number | null;
  feesMeasured: number;
  /**
   * TRA-2850 — `feesMeasured` split by WHO measured it. A pre-2850 build counted
   * rows whose fee "happened to equal 0" as measured; every counted row now has
   * a provenance (`history_commission` join or `gainloss_derived`), so the sum
   * of this object always equals `feesMeasured`.
   */
  feesBySource: { historyCommission: number; gainlossDerived: number };
  /** How many days back the ledger retains. */
  retentionDays: number;
  /** TRA-1681 — whether ANY of the above survives a reboot. Check BEFORE trusting a count. */
  durability: LiveOptionsFeeSlippageDurability;
  /** ms epoch of the last recorded fill (null if none yet). */
  lastRecordAt: number | null;
  /** The full record set, most-recent first. */
  records: LiveOptionFillRecord[];
}

/**
 * Fold the store into the read-only fee/slippage calibration diagnostics. Pure — no
 * IO. Records are returned most-recent first. Read `durability.ephemeral` FIRST: if
 * true, every record below is wiped at the next reboot and the calibration is not
 * durably captured (TRA-1719).
 */
export function summarizeLiveOptionsFeeSlippage(): LiveOptionsFeeSlippageSummary {
  const vsAsk: number[] = [];
  const vsMid: number[] = [];
  const feeValues: number[] = [];
  let opens = 0;
  let closes = 0;
  let feesFromCommission = 0;
  let feesFromGainLoss = 0;
  for (const f of fills) {
    if (f.side === 'buy_to_open') opens += 1;
    else closes += 1;
    if (f.slippageVsAsk !== null) vsAsk.push(f.slippageVsAsk);
    if (f.slippageVsMid !== null) vsMid.push(f.slippageVsMid);
    if (f.fees !== null) {
      feeValues.push(f.fees);
      if (f.feeSource === 'gainloss_derived') feesFromGainLoss += 1;
      else feesFromCommission += 1;
    }
  }
  const askStats = stats(vsAsk);
  const midStats = stats(vsMid);
  const records = [...fills].sort((a, b) => b.ts - a.ts);
  return {
    n: fills.length,
    opens,
    closes,
    slippage: {
      nMeasured: askStats.n,
      nTotal: fills.length,
      excludedNoAskQuote: fills.length - askStats.n,
      meanVsAsk: round(askStats.mean),
      medianVsAsk: round(askStats.median),
      meanVsMid: round(midStats.mean),
      medianVsMid: round(midStats.median),
    },
    totalFees: feeValues.length > 0 ? round(feeValues.reduce((s, v) => s + v, 0), 2) : null,
    feesMeasured: feeValues.length,
    feesBySource: { historyCommission: feesFromCommission, gainlossDerived: feesFromGainLoss },
    retentionDays: RETAIN_MS / (24 * 60 * 60 * 1000),
    durability: {
      dataDir,
      ephemeral: isEphemeralDataDir(dataDir),
      hydratedRecords,
      appendErrors,
      lastAppendError,
    },
    lastRecordAt,
    records,
  };
}
