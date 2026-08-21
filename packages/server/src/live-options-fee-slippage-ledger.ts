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
 * TRA-3918 — why an OPEN-EPISODE walk exists, and why "most recent
 * `buy_to_open`" was the wrong question.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * {@link lastRecordedOpenSleeve} and {@link lastRecordedOpenFill} used to walk
 * BACKWARD looking for the newest `buy_to_open` on the symbol and stop there,
 * with no regard for whether that episode had since been CLOSED. So a contract
 * the engine bought and sold in July still answered `engine` in August — for
 * an OCC that, by then, only the desk held:
 *
 *   buy_to_open  XLF …C57.5  1     <- episode A opens
 *   sell_to_close XLF …C57.5 1     <- episode A closes; we hold ZERO
 *                                     (the desk later buys 1 of the same OCC)
 *   lastRecordedOpenFill(…)  -> the episode-A buy_to_open   ⇐ WRONG
 *
 * Downstream that answer becomes `adoptionAuthority: 'engine_origin'` on the
 * desk's contract (TRA-3916's decay), which re-blends the desk's basis into the
 * engine's stop and spends the board's adoption authorization on the desk's
 * money. An OCC we ever bought was, in effect, forever ours.
 *
 * ── Why it is a running-quantity walk, not "stop at the first close" ────────
 * {@link recordedEngineOpenBasis} stops at the first `sell_to_close` it meets
 * walking backward, which truncates on a PARTIAL close. That is deliberate
 * there: its callers treat a quantity they cannot fully account for as a
 * REFUSAL, so truncation fails closed. The same rule here would fail OPEN in
 * the direction TRA-2820 is about — a partially-closed ENGINE position (buy 2,
 * close 1, still holding 1) would answer "no record", `ledgerOpenProvenance`
 * would read that as `foreign`, and a real-money contract the engine placed
 * would be handed the import sentinel with nothing minding its stop.
 *
 * So the boundary is the close that FLATTENS the position, tracked by net
 * contracts, and a new episode starts at the next `buy_to_open` off zero.
 *
 * ── Rows are ordered by `ts`, not by array position ─────────────────────────
 * `fills` is append-ordered, and `importMissingLiveOptionFills` appends
 * history-reconstructed rows at the END even though they represent OLDER fills
 * (TRA-2959). A positional walk therefore puts an imported open AFTER the close
 * that closed it and reads a flat contract as open. Position was good enough
 * for "newest buy anywhere"; it is not good enough for an episode boundary.
 *
 * ── Three "no" states, and they are not the same "no" ───────────────────────
 * `flat` (we opened this OCC and closed it — the contract at the broker is not
 * from an episode of ours) is a FINDING. `no_record` is the older finding.
 * `indeterminate` is a REFUSAL: the ledger's own arithmetic does not close, so
 * it cannot vouch for anything on this symbol, and saying `foreign` there is a
 * guess wearing a verdict's clothes. Callers must keep the refusal separate —
 * `null` from these oracles is "cannot answer", never permission (TRA-3913 AC2).
 */
export type OpenEpisodeStatus =
  /** A `buy_to_open` episode is open right now; `fills` holds its opens. */
  | 'open'
  /** The ledger holds opens for this OCC and every one of them was closed out. */
  | 'flat'
  /** The ledger holds no row at all for this OCC. */
  | 'no_record'
  /** The ledger's own quantities do not reconcile — it cannot answer. */
  | 'indeterminate';

export type OpenEpisodeIndeterminateReason =
  /**
   * A `sell_to_close` with nothing open to close (or closing more than is
   * open). The ledger is MISSING opens — 30-day retention aged them out, or the
   * history importer recovered one leg of a round trip and not the other. Every
   * episode boundary after that point is unknowable.
   */
  | 'unmatched_close'
  /**
   * A row carrying a `contracts` value that is not a positive finite number.
   * `contracts` is not validated on hydrate, so a corrupt on-disk row reaches
   * the walk. Netting `NaN` reads as a number until something compares it.
   */
  | 'unusable_quantity';

/** TRA-3918 — the currently-open `buy_to_open` episode for one OCC symbol. */
export interface OpenEpisodeWindow {
  status: OpenEpisodeStatus;
  /**
   * The `buy_to_open` rows of the CURRENTLY-OPEN episode, oldest-first. Empty
   * on every status other than `open`.
   */
  fills: LiveOptionFillRecord[];
  /** Net contracts the ledger believes are open. `0` unless `status === 'open'`. */
  netContracts: number;
  /** `sell_to_close` rows the walk consumed before it stopped. */
  closes: number;
  /** Set only on `indeterminate`. */
  reason: OpenEpisodeIndeterminateReason | null;
}

/** TRA-3918 — see {@link OpenEpisodeStatus}. The one walk all three oracles share. */
export function openEpisodeWindow(optionSymbol: string): OpenEpisodeWindow {
  const rows = fills.filter((f) => f.optionSymbol === optionSymbol);
  // Stable (ES2019) — same-`ts` rows keep append order, which is the order they
  // actually filled in.
  rows.sort((a, b) => a.ts - b.ts);
  if (rows.length === 0) {
    return { status: 'no_record', fills: [], netContracts: 0, closes: 0, reason: null };
  }

  const refuse = (
    reason: OpenEpisodeIndeterminateReason,
    closes: number,
  ): OpenEpisodeWindow => ({ status: 'indeterminate', fills: [], netContracts: 0, closes, reason });

  let episode: LiveOptionFillRecord[] = [];
  let net = 0;
  let closes = 0;
  for (const f of rows) {
    const qty = f.contracts;
    if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0) {
      return refuse('unusable_quantity', closes);
    }
    if (f.side === 'buy_to_open') {
      // Off zero, this opens a NEW episode — whatever came before is closed and
      // does not get to vote on what we hold now.
      if (net <= 0) episode = [];
      episode.push(f);
      net += qty;
      continue;
    }
    closes += 1;
    // A close with nothing open, or closing more than is open, means the ledger
    // is missing rows. Refuse rather than net to zero and call it flat.
    if (net <= 0 || qty > net) return refuse('unmatched_close', closes);
    net -= qty;
    if (net === 0) episode = []; // FLATTENED — the episode is over, permanently.
  }

  return episode.length > 0
    ? { status: 'open', fills: episode, netContracts: net, closes, reason: null }
    : { status: 'flat', fills: [], netContracts: 0, closes, reason: null };
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
 *
 * TRA-3918 — scoped to the CURRENTLY-OPEN episode; a closed round trip no longer
 * votes. See {@link openEpisodeWindow}. `null` is "cannot answer" and callers
 * must not read it as "the engine never bought this".
 */
export function lastRecordedOpenSleeve(optionSymbol: string): LiveFillSleeve | null {
  const window = openEpisodeWindow(optionSymbol);
  return window.status === 'open' ? window.fills[window.fills.length - 1]!.sleeve : null;
}

/**
 * TRA-3553 — the last `buy_to_open` this ledger recorded for `optionSymbol`,
 * whole, rather than just its sleeve.
 *
 * {@link lastRecordedOpenSleeve} answers the RISK-SCHEDULE question. This
 * answers the PROVENANCE question, and the extra field that matters is
 * `orderId`: it is the only durable handle tying an adopted row back to the
 * order the app itself placed. TRA-2820 names its two lost TSLA positions by
 * their broker order ids (`140022786` / `140028461`) precisely because nothing
 * left on the position row could name them.
 *
 * TRA-3918 — scoped to the CURRENTLY-OPEN episode; a closed round trip no longer
 * votes. See {@link openEpisodeWindow} for why the boundary is the close that
 * FLATTENS the position rather than the first close the walk meets, and why
 * `null` here is "cannot answer", never "the contract is the desk's".
 */
export function lastRecordedOpenFill(optionSymbol: string): LiveOptionFillRecord | null {
  const window = openEpisodeWindow(optionSymbol);
  return window.status === 'open' ? window.fills[window.fills.length - 1]! : null;
}

/**
 * TRA-3896 — what the ENGINE ITSELF paid for its current open episode on a
 * contract: quantity and quantity-weighted basis, sourced from this ledger's own
 * `buy_to_open` rows.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Tradier's `/positions` is ONE row per OCC symbol, so `cost_basis / quantity`
 * is a BLEND across every contract in the account on that symbol — the engine's
 * and anybody else's. TRA-3890 showed both directions of the damage on
 * 2026-08-20: a desk-side add of 1 BAC at $1.17 turned the engine's $1.65 fill
 * into a booked $1.41 (basis), and the same reconcile copied a 2-contract broker
 * lot onto an engine-origin XLF row that was adopted at 1 (quantity).
 *
 * Every repair for that class needs the same number — "what did WE actually buy,
 * and how much of it" — and it must come from a record the engine wrote at fill
 * time, never from the broker's blend and never from a request body. A typed-in
 * basis is a second way to get a number nobody paid onto the row, which is the
 * defect being repaired.
 *
 * ── The episode window, and why it stops at a close ─────────────────────────
 * Walks BACKWARD and stops at the first `sell_to_close` on the symbol, so the
 * result covers the CURRENT open episode only. Summing across a completed round
 * trip would blend a position we no longer hold into the basis of the one we do
 * — the same blending error one level up.
 *
 * A PARTIAL close inside the episode also truncates the window, so `contracts`
 * can come back SHORT of what the row holds. That is deliberate: every caller
 * treats a quantity it cannot fully account for as a REFUSAL, so truncation
 * fails closed (no write) rather than open (a basis derived from part of the
 * lot).
 *
 * ⚠ TRA-3918 — this is therefore a DIFFERENT walk from {@link openEpisodeWindow},
 * on purpose, and the two must not be "unified". This one answers a BASIS
 * question, where under-counting is safe and over-counting spends the board's
 * authorization on the desk's money; that one answers a PROVENANCE question,
 * where under-counting hands a real-money engine contract the import sentinel
 * and leaves it with no stop (TRA-2820). Both stop at a close; only this one
 * stops at a close that did not flatten. Verified against the closed-episode
 * shape in `tra3918-open-episode-walk.test.ts` — this function was already
 * correct for it, which is why TRA-3918 did not have to touch it.
 *
 * `unpricedFills` is the honest-null discipline this module is built on: a
 * `buy_to_open` with `filledPrice: null` is a contract we cannot price, so the
 * weighted average would silently be an average over the priced subset. Callers
 * must refuse on `unpricedFills > 0` rather than read `premiumPaid` as complete.
 */
export interface RecordedEngineOpenBasis {
  /** Contracts the engine's own priced fills account for in this episode. */
  contracts: number;
  /** Quantity-weighted average `filledPrice` over those fills, per contract. */
  premiumPaid: number;
  /** `premiumPaid × contracts × 100` — the engine's own cost basis, USD. */
  costBasisUsd: number;
  /** How many `buy_to_open` records went into the average. */
  fills: number;
  /** Broker order ids seen, oldest-first. The durable handle back to the order. */
  orderIds: number[];
  /**
   * `buy_to_open` rows in the episode carrying `filledPrice: null`. Non-zero
   * means the basis above is INCOMPLETE — refuse, do not round.
   */
  unpricedFills: number;
  /** Whether the backward walk stopped at a `sell_to_close` (episode boundary). */
  stoppedAtClose: boolean;
  /** Fill time of the newest `buy_to_open` in the episode, ms epoch. */
  lastTs: number;
}

/**
 * TRA-3896 — see {@link RecordedEngineOpenBasis}. `null` when this ledger holds
 * no `buy_to_open` for the symbol at all, which is the "oracle cannot answer"
 * state and must NOT be read as "the engine bought nothing" (see
 * {@link recordedOpenFillCount} for why those two are different).
 */
export function recordedEngineOpenBasis(optionSymbol: string): RecordedEngineOpenBasis | null {
  const episode: LiveOptionFillRecord[] = [];
  let stoppedAtClose = false;
  for (let i = fills.length - 1; i >= 0; i--) {
    const f = fills[i]!;
    if (f.optionSymbol !== optionSymbol) continue;
    if (f.side === 'sell_to_close') {
      stoppedAtClose = true;
      break;
    }
    if (f.side === 'buy_to_open') episode.push(f);
  }
  if (episode.length === 0) return null;
  episode.reverse(); // oldest-first, so `orderIds` reads in fill order

  let contracts = 0;
  let costBasisUsd = 0;
  let unpricedFills = 0;
  let lastTs = 0;
  const orderIds: number[] = [];
  for (const f of episode) {
    const qty = typeof f.contracts === 'number' && Number.isFinite(f.contracts) ? f.contracts : 0;
    const price = f.filledPrice;
    if (typeof f.orderId === 'number' && Number.isFinite(f.orderId)) orderIds.push(f.orderId);
    if (f.ts > lastTs) lastTs = f.ts;
    if (!(qty > 0) || typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      unpricedFills += 1;
      continue;
    }
    contracts += qty;
    costBasisUsd += price * qty * 100;
  }
  return {
    contracts,
    // Guard the divide rather than emit NaN: `contracts === 0` means every fill
    // in the episode was unpriced, and a NaN basis downstream reads as a number
    // until something compares it.
    premiumPaid: contracts > 0 ? costBasisUsd / (contracts * 100) : 0,
    costBasisUsd,
    fills: episode.length,
    orderIds,
    unpricedFills,
    stoppedAtClose,
    lastTs,
  };
}

/**
 * TRA-3553 — how many `buy_to_open` rows the ledger currently holds.
 *
 * This is the ORACLE-HEALTH probe, and it exists because
 * {@link lastRecordedOpenSleeve} returns `null` for two states that must not be
 * treated alike:
 *
 *   - the ledger is POPULATED and holds no row for this contract => the
 *     contract is genuinely foreign inventory, and the import schedule is the
 *     right answer;
 *   - the ledger is EMPTY — never hydrated, `DATA_DIR` unreadable, a reconcile
 *     that ran before `hydrateLiveOptionsFeeSlippageFromDisk`, or a retention
 *     window that aged every row out => the oracle cannot answer AT ALL, and
 *     reading its silence as "foreign" declares EVERY engine-placed contract
 *     foreign. That is a fail-OPEN, and it is the state in which TRA-2820's 8
 *     live contracts / $216 of real premium were handed the RV sub-floor
 *     sentinel and left with no stop for a whole session.
 *
 * A discriminator that cannot tell "no" from "I do not know" is not a
 * discriminator. Callers pair this with the sleeve lookup so the second case is
 * reported as UNRESOLVED rather than silently absorbed into the first.
 *
 * Deliberately a COUNT of the side actually consulted, not `fills.length`: a
 * ledger holding only `sell_to_close` rows can answer no open-provenance
 * question either, and a non-zero total would call that oracle healthy.
 */
export function recordedOpenFillCount(): number {
  let n = 0;
  for (const f of fills) if (f.side === 'buy_to_open') n += 1;
  return n;
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

/**
 * TRA-3558 — a lot whose broker-reported `symbol` was TRUNCATED and which this
 * pass re-keyed onto the full ledger symbol. Measured live on 2026-08-13: the
 * ***0154 `/gainloss` payload returned `KVYO260918C0` / `TROW260918C0` (12
 * chars, cut one digit into the strike) for two lots while every other lot in
 * the same response carried its full 18–19 char OCC symbol. The lots were
 * PRESENT, correctly priced, and simply keyed to a symbol no ledger row has —
 * so four rows sat unmeasured for six days reading as `no-match`.
 *
 * A rewrite of a symbol in a money path must never be silent, so every repair
 * is recorded and republished on the health route.
 */
export interface GainLossPrefixRepair {
  /** The truncated symbol exactly as the broker sent it. */
  lotSymbol: string;
  /** The full ledger symbol it was uniquely resolved to. */
  resolvedSymbol: string;
  day: string;
  side: LiveFillSide;
}

/**
 * A symbol that LOOKS like an OCC option symbol cut short: root, 6-digit expiry,
 * C/P, then FEWER than the 8 strike digits. A complete symbol cannot be a strict
 * prefix of another complete one (same-root strikes are all 8 digits), so this
 * pattern plus the exact-match test below means a well-formed lot never enters
 * the repair path at all.
 */
const TRUNCATED_OCC_SYMBOL = /^[A-Z]{1,6}\d{6}[CP]\d{0,7}$/;

/** {@link FeeBackfillResult} plus the named reason for every group that did NOT derive. */
export interface GainLossBackfillResult extends FeeBackfillResult {
  /**
   * One entry per (symbol, day, side) group that still holds an unmeasured row
   * after this pass. Empty ⇒ every unmeasured row was measured. Ordered most
   * recent ET day first, so the ACTIONABLE groups lead (aged rows sort last).
   */
  rejections: GainLossRejection[];
  /**
   * TRA-3558 — lots re-keyed off a TRUNCATED broker symbol this pass. Empty on
   * a healthy payload; non-empty means the broker sent a short symbol and this
   * pass resolved it, which the reader is entitled to see.
   */
  prefixRepairs: GainLossPrefixRepair[];
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
  // TRA-3558 — the broker truncates a symbol occasionally (see
  // {@link GainLossPrefixRepair}). Resolve such a lot onto the ONE ledger symbol
  // it can belong to, and only when that one is unambiguous: same ET day, same
  // side, strict prefix, EXACTLY one candidate. Two strikes of the same root and
  // expiry traded the same day/side leave it unresolved — the group then reports
  // 'no-lot' and `lastGainLossSample` shows the short symbol, which is a correct
  // honest-unmeasured, not a guess. The qty reconciliation and the per-contract
  // sanity bound below still apply to every repaired lot.
  const ledgerSymbols = new Set(records.map((r) => r.optionSymbol));
  const symbolsByDaySide = new Map<string, Set<string>>();
  for (const r of records) {
    const k = `${r.etDay} ${r.side}`;
    const g = symbolsByDaySide.get(k);
    if (g) g.add(r.optionSymbol);
    else symbolsByDaySide.set(k, new Set([r.optionSymbol]));
  }
  const prefixRepairs: GainLossPrefixRepair[] = [];
  const resolveLotSymbol = (symbol: string, day: string, side: LiveFillSide): string => {
    if (ledgerSymbols.has(symbol)) return symbol; // exact match — never repaired
    if (!TRUNCATED_OCC_SYMBOL.test(symbol)) return symbol;
    const candidates = [...(symbolsByDaySide.get(`${day} ${side}`) ?? [])].filter(
      (s) => s.length > symbol.length && s.startsWith(symbol),
    );
    if (candidates.length !== 1) return symbol; // absent or ambiguous — do not guess
    const resolvedSymbol = candidates[0]!;
    prefixRepairs.push({ lotSymbol: symbol, resolvedSymbol, day, side });
    return resolvedSymbol;
  };
  for (const lot of lots) {
    const openSymbol = resolveLotSymbol(lot.symbol, lot.openDate, 'buy_to_open');
    const closeSymbol = resolveLotSymbol(lot.symbol, lot.closeDate, 'sell_to_close');
    addLot(feeMatchKey(openSymbol, lot.openDate, 'buy_to_open', 0), lot.quantity, lot.cost);
    addLot(feeMatchKey(closeSymbol, lot.closeDate, 'sell_to_close', 0), lot.quantity, lot.proceeds);
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
  return { updated, records: out, rejections, prefixRepairs };
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
//
// ── TRA-3563: WHICH history execution's price the imported row inherits ──────
//
// The original attribution copied `f.price` off whichever execution the
// shortfall walk landed on (the LAST ones in `transactionId` order). When a
// group's executions filled at DIFFERENT prices that is a GUESS, and on
// 2026-08-04 it guessed wrong: `QQQ260911P00545000 buy_to_open` filled 4 @ 0.58
// and 1 @ 0.53, the ledger held only the 4, and the minted 1-contract row was
// written at 0.58. Contract TOTALS still reconciled (5 == 5) — which is all the
// coverage cross-check grades, so `missingContracts: 0` read clean — while the
// ledger gross overstated the broker by $5.00 and the gainloss join derived a
// fee of -4.47 for six days. `filledPrice` on an imported row also feeds the
// slippage and P&L reads, so a borrowed price is wrong in three places.
//
// The attribution below derives the price instead of guessing it: CANCEL the
// contracts the ledger already holds against the executions that share their
// price, and what remains IS the uncovered execution, at its own price. When
// the cancellation does not come out exactly (a ledger row priced at something
// no execution filled at), no attribution is determinable and the row is
// written `filledPrice: null` — honest-unmeasured, which the gainloss join
// names 'priceless-row' instead of silently deriving a negative fee. A wrong
// price is worse than an absent one: absent is already handled.

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
  /**
   * TRA-3890 — what `missingContracts: 0` actually rests on. On 2026-08-20 the
   * broker took 4 fills, the ledger held 2, and this read `{0,0,0,0}`: same-day
   * groups are skipped by design and `/history` had not yet published the day,
   * so the zero was an EMPTY DENOMINATOR, not a complete ledger.
   *   • `unmeasured` — no prior-day broker contracts in the window; nothing was
   *     compared and the zero proves nothing.
   *   • `complete`   — prior-day groups compared and every contract is covered.
   *   • `missing`    — a shortfall was found (and imported).
   */
  verdict: 'unmeasured' | 'complete' | 'missing';
  /** Prior-day broker contracts actually compared (the denominator of `verdict`). */
  comparedContracts: number;
  /** Same-day broker contracts deliberately left to the fill-time recorders. */
  sameDayContractsExcluded: number;
}

/** A price the ledger already holds, for the cancellation below. `null` = row carries no price. */
interface CoveredContracts {
  price: number | null;
  contracts: number;
}

/**
 * TRA-3563 — bucket a price so two equal prices from different JSON parses
 * compare equal. Option prices carry at most 4 decimals (0.4575); 1e-6 is two
 * orders finer than anything a broker quotes and coarse enough to absorb the
 * float noise a round-trip through JSON cannot introduce but arithmetic can.
 */
function priceBucket(price: number): number {
  return Math.round(price * 1e6);
}

/** A history execution's price, or null when the broker sent nothing usable. */
function executionPrice(f: TradierTradeHistoryFill): number | null {
  return typeof f.price === 'number' && Number.isFinite(f.price) && f.price > 0 ? f.price : null;
}

/**
 * TRA-3563 — the shared attribution core (see the section header). Cancel the
 * contracts the ledger already holds against the executions that filled at the
 * SAME price; what survives is the uncovered volume, still carrying its own
 * execution's price.
 *
 * `determinable` is the honesty flag: it is true only when EVERY covered
 * contract found a same-priced execution to cancel against. A ledger row priced
 * at something no execution filled at (or carrying no price at all) leaves a
 * remainder, and then the residual below is arithmetic, not evidence — the
 * caller must fall back rather than write a price it cannot source.
 *
 * PURE. `executions` is consumed in the order given, which is the order the
 * residual is reported in.
 */
function attributeUncoveredExecutions(
  executions: readonly TradierTradeHistoryFill[],
  covered: readonly CoveredContracts[],
): { residual: Array<{ fill: TradierTradeHistoryFill; qty: number }>; determinable: boolean } {
  const remaining = new Map<number, number>();
  let unpriced = 0;
  for (const c of covered) {
    if (!(c.contracts > 0)) continue;
    if (c.price === null) {
      unpriced += c.contracts;
      continue;
    }
    const b = priceBucket(c.price);
    remaining.set(b, (remaining.get(b) ?? 0) + c.contracts);
  }
  const residual: Array<{ fill: TradierTradeHistoryFill; qty: number }> = [];
  for (const fill of executions) {
    const price = executionPrice(fill);
    let qty = fill.quantity;
    if (price !== null) {
      const b = priceBucket(price);
      const take = Math.min(qty, remaining.get(b) ?? 0);
      if (take > 0) {
        remaining.set(b, (remaining.get(b) ?? 0) - take);
        qty -= take;
      }
    }
    if (qty > 0) residual.push({ fill, qty });
  }
  let leftover = unpriced;
  for (const q of remaining.values()) leftover += q;
  return { residual, determinable: leftover === 0 };
}

/**
 * TRA-3563 — the ONE price every execution in the group filled at, or null when
 * they differ (or any is unusable). A group whose executions all filled at the
 * same price needs no cancellation: the shortfall's price is that price no
 * matter which executions the ledger already covers.
 */
function soleExecutionPrice(executions: readonly TradierTradeHistoryFill[]): number | null {
  let sole: number | null = null;
  for (const f of executions) {
    const price = executionPrice(f);
    if (price === null) return null;
    if (sole === null) sole = price;
    else if (priceBucket(sole) !== priceBucket(price)) return null;
  }
  return sole;
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
  // TRA-3563 — the PRICES are carried alongside the totals: the shortfall's price
  // is derived by cancelling these against the executions, not copied off one.
  let ledgerContracts = 0;
  const ledgerQtyByKey = new Map<string, number>();
  const ledgerPricesByKey = new Map<string, CoveredContracts[]>();
  for (const r of records) {
    const key = feeMatchKey(r.optionSymbol, r.etDay, r.side, 0);
    if (!histGroups.has(key)) continue;
    ledgerQtyByKey.set(key, (ledgerQtyByKey.get(key) ?? 0) + r.contracts);
    ledgerContracts += r.contracts;
    const priced = ledgerPricesByKey.get(key);
    const entry: CoveredContracts = { price: r.filledPrice, contracts: r.contracts };
    if (priced) priced.push(entry);
    else ledgerPricesByKey.set(key, [entry]);
  }

  const inputs: LiveOptionFillInput[] = [];
  let missingContracts = 0;
  let comparedContracts = 0;
  let sameDayContractsExcluded = 0;
  for (const [key, g] of histGroups) {
    const day = g.fills[0]!.date;
    if (day >= todayEt) {
      // intraday fills belong to the fill-time recorders — counted, not dropped
      sameDayContractsExcluded += g.qty;
      continue;
    }
    comparedContracts += g.qty;
    let shortfall = g.qty - (ledgerQtyByKey.get(key) ?? 0);
    if (shortfall <= 0) continue;
    missingContracts += shortfall;
    // Attribute the shortfall to the LAST executions of the group (transactionId
    // order): the recorded rows were recorded as they filled, so the uncovered
    // tail is the best deterministic guess for WHICH contracts are missing — and
    // for fee/coverage purposes only the contract totals matter, not the pairing.
    const ordered = [...g.fills].sort((a, b) =>
      a.transactionId < b.transactionId ? 1 : a.transactionId > b.transactionId ? -1 : 0,
    );
    // TRA-3563 — the PRICE is a different question, and the guess above is not an
    // answer to it. Cancel what the ledger holds against the same-priced
    // executions; the residual is the uncovered volume at its OWN price. Use it
    // only when the cancellation came out exactly AND accounts for the whole
    // shortfall (the second test is arithmetically implied by the first — it is
    // asserted anyway, because writing a price off a broken invariant is the
    // defect this replaces).
    const attributed = attributeUncoveredExecutions(ordered, ledgerPricesByKey.get(key) ?? []);
    const attributedQty = attributed.residual.reduce((sum, r) => sum + r.qty, 0);
    if (attributed.determinable && attributedQty === shortfall) {
      for (const { fill, qty } of attributed.residual) {
        inputs.push(importedInput(fill, day, qty, g.side, records));
      }
      continue;
    }
    // Not determinable. One case still is: every execution in the group filled at
    // the SAME price, so there is nothing to choose between. Otherwise the price
    // is unknown and says so — `null`, never a sibling's.
    const sole = soleExecutionPrice(g.fills);
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
        filledPrice: sole,
        fees: null,
        orderId: f.orderId ?? null,
        origin: 'history_import',
      });
    }
  }
  return {
    inputs,
    coverage: {
      brokerContracts,
      ledgerContracts,
      missingContracts,
      importedRows: inputs.length,
      verdict: comparedContracts === 0 ? 'unmeasured' : missingContracts > 0 ? 'missing' : 'complete',
      comparedContracts,
      sameDayContractsExcluded,
    },
  };
}

/** One imported row, priced from the execution it was actually attributed to (TRA-3563). */
function importedInput(
  f: TradierTradeHistoryFill,
  day: string,
  qty: number,
  side: LiveFillSide,
  records: readonly LiveOptionFillRecord[],
): LiveOptionFillInput {
  return {
    // History carries only the ET calendar day; noon-ET-ish is honest enough
    // for retention/ordering (17:00Z is 12:00/13:00 ET year-round).
    ts: Date.parse(`${day}T17:00:00Z`),
    etDay: day,
    // A close inherits its sleeve from the ledger's own open row when one
    // exists; anything else is honestly unattributed.
    sleeve: side === 'sell_to_close' ? sleeveOfLastOpenIn(records, f.symbol) ?? 'unattributed' : 'unattributed',
    optionSymbol: f.symbol,
    side,
    contracts: qty,
    submittedLimit: null,
    askAtSubmit: null,
    midAtSubmit: null,
    filledPrice: executionPrice(f),
    fees: null,
    orderId: f.orderId ?? null,
    origin: 'history_import',
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

/**
 * TRA-3563 — one `history_import` row whose `filledPrice` this pass RE-DERIVED
 * from the broker's own executions. A price rewrite inside the path that feeds
 * fees, slippage and P&L must be VISIBLE, not merely correct (the TRA-3558
 * lesson, one field over), so every repair is published on the health route.
 *
 * `to: null` is a repair too, and the intended one when the attribution is not
 * determinable: it converts a silent wrong number into a named `priceless-row`.
 */
export interface ImportedPriceRepair {
  optionSymbol: string;
  day: string;
  side: LiveFillSide;
  contracts: number;
  /** The price the row carried — a sibling execution's, under the old attribution. */
  from: number | null;
  /** The price the broker's executions actually support. `null` = honest-unmeasured. */
  to: number | null;
}

/**
 * TRA-3563 — PURE repair pass for rows ALREADY written with a borrowed price.
 * Fixing the attribution forward does nothing for the rows the old one minted:
 * the import is idempotent on contract TOTALS, so a wrong price never re-enters
 * the diff and sits in the ledger forever (the live `QQQ260911P00545000`
 * 2026-08-04 row: 0.58 borrowed off the 4-contract leg, broker filled it at
 * 0.53, group fee derived -4.47 for six days).
 *
 * Deliberately narrow — this rewrites settled money numbers, so it only fires
 * where the broker's own record decides the answer:
 * - only `origin: 'history_import'` rows move. A `fill` row's price came from
 *   the fill itself and is authoritative; it is INPUT here, never output.
 * - the group must hold NO measured row. A derived fee was computed off these
 *   prices; re-pricing underneath it would silently invalidate a settled number.
 * - ledger and history contract totals for the group must match exactly. Below
 *   that, the import pass has work to do first and its rows are the answer.
 * - the cancellation must come out exactly ({@link attributeUncoveredExecutions}
 *   `determinable`), and each row's contracts must land inside ONE price. A row
 *   spanning two prices has no single execution price and is written `null` —
 *   never a blended one no execution filled at.
 *
 * When the cancellation does NOT come out, a second arm still applies: a price
 * that matches NO execution in the group is provably not the broker's, and is
 * nulled. Everything else is left exactly as it is — an undeterminable group is
 * not a licence to overwrite a row that may well be right.
 *
 * Idempotent: once repaired, the ledger prices cancel against the executions and
 * the next pass computes the same values, so `updated` is 0 and nothing rewrites.
 */
export function repriceImportedFillsFromHistory(
  records: readonly LiveOptionFillRecord[],
  historyFills: readonly TradierTradeHistoryFill[],
): { records: LiveOptionFillRecord[]; updated: number; repairs: ImportedPriceRepair[] } {
  const histGroups = new Map<string, { qty: number; fills: TradierTradeHistoryFill[] }>();
  for (const f of historyFills) {
    if (f.tradeType !== 'option') continue;
    const side = historyFillSide(f.description, f.amount);
    if (side === null) continue;
    if (typeof f.quantity !== 'number' || !Number.isFinite(f.quantity) || f.quantity <= 0) continue;
    const key = feeMatchKey(f.symbol, f.date, side, 0);
    const g = histGroups.get(key);
    if (g) {
      g.qty += f.quantity;
      g.fills.push(f);
    } else histGroups.set(key, { qty: f.quantity, fills: [f] });
  }

  const rowGroups = new Map<string, number[]>();
  records.forEach((r, i) => {
    const key = feeMatchKey(r.optionSymbol, r.etDay, r.side, 0);
    const g = rowGroups.get(key);
    if (g) g.push(i);
    else rowGroups.set(key, [i]);
  });

  const priceByIndex = new Map<number, number | null>();
  const repairs: ImportedPriceRepair[] = [];
  for (const [key, indices] of rowGroups) {
    const hist = histGroups.get(key);
    if (!hist) continue;
    const importIndices = indices.filter((i) => records[i]!.origin === 'history_import');
    if (importIndices.length === 0) continue;
    if (indices.some((i) => records[i]!.fees !== null)) continue; // a settled fee owns these prices
    let ledgerQty = 0;
    for (const i of indices) ledgerQty += records[i]!.contracts;
    if (ledgerQty !== hist.qty) continue; // coverage gap — the import pass runs first

    const ordered = [...hist.fills].sort((a, b) =>
      a.transactionId < b.transactionId ? 1 : a.transactionId > b.transactionId ? -1 : 0,
    );
    // The TRUSTED rows are the input: what the executions still hold after they
    // cancel is exactly what the imported rows represent.
    const trusted: CoveredContracts[] = indices
      .filter((i) => records[i]!.origin !== 'history_import')
      .map((i) => ({ price: records[i]!.filledPrice, contracts: records[i]!.contracts }));
    const attributed = attributeUncoveredExecutions(ordered, trusted);
    const residualQty = attributed.residual.reduce((sum, r) => sum + r.qty, 0);
    let importQty = 0;
    for (const i of importIndices) importQty += records[i]!.contracts;
    if (!attributed.determinable || residualQty !== importQty) {
      // ARM 2 — nothing is derivable, but one thing is still PROVABLE: a price no
      // execution in the group filled at cannot have come from the broker's
      // record, so it is wrong whatever the right answer is. Null it (the group
      // then reports 'priceless-row' instead of a silent gross error). This
      // cannot destroy a good price — a correctly attributed row always carries
      // SOME execution's price, including the single-price case — and it is
      // gated on the same full-coverage precondition, so a partially fetched
      // group can never make a legitimate price look foreign.
      const executionPrices = new Set<number>();
      for (const f of ordered) {
        const p = executionPrice(f);
        if (p !== null) executionPrices.add(priceBucket(p));
      }
      for (const i of importIndices) {
        const rec = records[i]!;
        if (rec.filledPrice === null) continue;
        if (executionPrices.has(priceBucket(rec.filledPrice))) continue;
        priceByIndex.set(i, null);
        repairs.push({
          optionSymbol: rec.optionSymbol,
          day: rec.etDay,
          side: rec.side,
          contracts: rec.contracts,
          from: rec.filledPrice,
          to: null,
        });
      }
      continue;
    }

    // Walk the imported rows against the residual. A row consuming contracts at
    // one price takes it; a row straddling two different prices takes null.
    const pool = attributed.residual.map((r) => ({ price: executionPrice(r.fill), qty: r.qty }));
    let cursor = 0;
    for (const i of importIndices) {
      const rec = records[i]!;
      let need = rec.contracts;
      let price: number | null = null;
      let straddled = false;
      let first = true;
      while (need > 0 && cursor < pool.length) {
        const slot = pool[cursor]!;
        const take = Math.min(need, slot.qty);
        if (first) price = slot.price;
        else if (price === null || slot.price === null || priceBucket(price) !== priceBucket(slot.price)) {
          straddled = true;
        }
        first = false;
        slot.qty -= take;
        need -= take;
        if (slot.qty === 0) cursor += 1;
      }
      const resolved = straddled ? null : price;
      const before = rec.filledPrice;
      const same =
        before === null ? resolved === null : resolved !== null && priceBucket(before) === priceBucket(resolved);
      if (same) continue;
      priceByIndex.set(i, resolved);
      repairs.push({
        optionSymbol: rec.optionSymbol,
        day: rec.etDay,
        side: rec.side,
        contracts: rec.contracts,
        from: before,
        to: resolved,
      });
    }
  }

  let updated = 0;
  const out = records.map((r, i) => {
    if (priceByIndex.has(i)) {
      updated += 1;
      return toRecord({ ...recordToInput(r), filledPrice: priceByIndex.get(i)! });
    }
    return toRecord(recordToInput(r));
  });
  return { records: out, updated, repairs };
}

/**
 * TRA-3563 — apply {@link repriceImportedFillsFromHistory} against the in-memory
 * store with the same durable-rewrite semantics as the fee back-fills.
 */
export function repriceImportedLiveOptionFills(
  historyFills: readonly TradierTradeHistoryFill[],
): { updated: number; repairs: ImportedPriceRepair[] } {
  const result = repriceImportedFillsFromHistory(fills, historyFills);
  applyBackfillResult({ updated: result.updated, records: result.records });
  if (result.repairs.length > 0) {
    log.warn('live-options fee-slippage ledger RE-PRICED imported rows off broker executions (TRA-3563)', {
      repairs: result.repairs.map((r) => `${r.optionSymbol} ${r.day} ${r.side} x${r.contracts}: ${r.from} -> ${r.to}`),
    });
  }
  return { updated: result.updated, repairs: result.repairs };
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
