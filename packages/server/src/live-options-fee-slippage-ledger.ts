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
import type { OptionAdmissionAbsentReason, OptionAdmissionBoundBy, OptionAdmissionStamp } from '@trading-app/shared';
import { isCoherentOptionAdmissionStamp } from '@trading-app/shared';
import { isEphemeralDataDir } from './data-dir.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'live-options-fee-slippage-ledger' });

export const LIVE_OPTIONS_FEE_SLIPPAGE_LOG_FILENAME = 'live-options-fee-slippage.jsonl';

/**
 * TRA-3976 — the terminal-marker log. A SEPARATE file, and separate from
 * {@link LiveOptionFillRecord}, on purpose: see
 * {@link ReconcileTerminationRecord} for why a reconcile drop must not be
 * written as a fill.
 */
export const LIVE_OPTION_RECONCILE_TERMINATION_LOG_FILENAME =
  'live-option-reconcile-terminations.jsonl';

/**
 * Retain this many ms of fill records on disk (compacted on boot). The bounded
 * test runs ~2 days; 30 days comfortably covers reading the calibration back well
 * after the window closes while bounding a file that takes a handful of lines per
 * trade.
 */
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

// ════════════════════════════════════════════════════════════════════════════
// ⭐ TRA-3977 — THIS STORE IS FLEET-WIDE AND THE NUMBER IT HANDS THE EXIT PATH
// IS SPENT PER BOOK.
//
// ── The measurement, live, 2026-08-24T14:4xZ on `3d0c3582` ──────────────────
// `/api/health/live-options-fee-slippage` carries TWO `mode: 'live'` books with
// `liveEntryGateOpen: true` — `admin` (BAC + RIG) and `v0nni` (NVTS) — and they
// are not the same broker account. `records[]` carried, in the SAME array:
//
//     NVTS261002C00012500  buy_to_open  ct=1 @1.54  oid=143021643  sleeve=single_leg_otm
//
// $154 — v0nni's entire book — sitting next to admin's BAC / RIG / XLF rows,
// with NOTHING on the row saying so. `LiveOptionFillRecord` had fields for
// mode, ts, etDay, sleeve, optionSymbol, side, contracts, four prices, fees,
// feeSource, two slippage columns, orderId and origin — and no book, user or
// account discriminator. The store is a module-global array, one per process,
// shared by every book the process serves.
//
// ── Why that is a DEFECT and not an untidiness ──────────────────────────────
// TRA-3926 shipped `boundExitContractsToEngineShare`, which sizes a live
// `sell_to_close` off two oracles keyed on the OCC ALONE:
// {@link recordedEngineOpenBasis} (the reader's half, TRA-3913) and
// {@link engineNetOpenContracts} (the write path's, TRA-3926). The row they are
// answering ABOUT belongs to one book; the rows they answered FROM belonged to
// the fleet. Two instances, pointing opposite ways:
//
//  • PERMISSIVE — book A holds one contract on OCC X that arrived as a
//    `history_import` (the desk's); book B holds one engine `buy_to_open` on
//    the same X. The oracle saw `engineOpenContracts 1`, `closedContracts 0`,
//    `netContracts 2`, answered `engineNetContracts = min(2,1) = 1`, and A's
//    exit was bounded to 1. **A sells the desk's contract, authorized by a fill
//    placed on a different book, against a different broker account** — and the
//    bound returns `bounded: false`, `blind: false`, i.e. the census records it
//    as a row that was CHECKED AND CLEAN. TRA-3926's exact defect surviving
//    TRA-3926's fix, and reported as a pass.
//  • CONSERVATIVE — B closes its own X; that `sell_to_close` nets against A's
//    share (`closedContracts` was fleet-wide too), so A is refused an exit on
//    its own contract. The TRA-2820 direction the second oracle was written to
//    avoid.
//
// ── The mechanism: a discriminator written at fill time, never re-derived ───
// `book` is stamped by the chokepoint that ALREADY KNOWS it (the per-user
// engine's `alertUsername`, the same string `OptionsAccount.setOwner` binds).
// ⛔ It is NEVER re-derived later from a position row: TRA-2811's lesson is
// that the open row is authoritative precisely because the code that CHOSE it
// wrote it, and a close-time re-derivation is what broke the open↔close sleeve
// join on 2026-08-03.
//
// ⛔ AND A ROW WITH NO DISCRIMINATOR IS A REFUSAL, NEVER A DEFAULT. Back-filling
// the retained rows to "the book that is asking" is the permissive default and
// it re-creates the defect wearing a clean-looking column. Unknown is BLIND and
// COUNTED (TRA-3913 AC2, TRA-3926 AC2), and the refusal has its own reason —
// {@link OpenEpisodeIndeterminateReason} `'book_unattributed'` — so it never
// shares a byte with `no_record` (the instrument is dark) or with `flat` (a
// finding the write path may act on).
//
// ── ⭐ AND THE REFUSAL IS CONDITIONED ON A **MEASURED** REACHABILITY ─────────
// An unattributed row is ambiguous IFF more than one book could have written
// it, which is a fact about the PROCESS, not about the row. So the scoping is
// gated on {@link bookScopingReachable}: with at most ONE book known to this
// store, an unattributed row cannot belong to anybody else and every oracle
// answers byte-for-byte as it did pre-TRA-3977 (this is AC4's negative control,
// and it is why the existing TRA-3913 / TRA-3926 fixtures did not need editing
// — a change that also rewrote them would be a behaviour rewrite wearing a
// scoping name). With TWO, the tape cannot be partitioned and the oracles
// refuse.
//
// ⚠ The reachability read has TWO sources and the second one is the one that
// cannot be un-wired: books are registered explicitly at engine wire-up
// ({@link registerLiveOptionBook}) **and** auto-registered by any row this
// store actually records or hydrates. **The array itself is the witness** — a
// process into which two distinct books have appended is reachable whether or
// not anyone remembered to wire the registry.
//
// ⚠ SAY WHAT THIS COSTS ON THE LIVE TAPE. Every one of the retained rows
// predates the discriminator, and bqb1 serves two live books, so on the first
// boot after this ships EVERY book-scoped query refuses until fills accumulate
// under the new build. For the READER that routes dollars to the desk
// (`adoptedUsd` up — the same direction TRA-3913's fix moves them). For the
// WRITER it is the BLIND branch, i.e. the pre-TRA-3926 quantity, COUNTED. That
// is the honest price of the finding: **the retained tape cannot be partitioned
// by book at all, so there is no audit of the past available here — only a
// repair going forward.**
// ════════════════════════════════════════════════════════════════════════════

/**
 * TRA-3977 — the explicit opt-out from book scoping: answer over the WHOLE
 * fleet, i.e. the pre-TRA-3977 behaviour.
 *
 * A symbol rather than a magic string so it can never be produced by a username,
 * a JSON field or a `??` fallback — every fleet-wide read is a decision somebody
 * typed, and `grep LEDGER_FLEET_WIDE` enumerates them.
 */
export const LEDGER_FLEET_WIDE: unique symbol = Symbol('tra3977.ledger-fleet-wide');

/**
 * Which book an oracle is being asked about.
 *
 * - `string`              — that book, and only that book.
 * - `null`                — the caller CANNOT NAME its book. A refusal, not a
 *   wildcard: a query that cannot say who is asking cannot be told which rows
 *   are its own.
 * - {@link LEDGER_FLEET_WIDE} — deliberately unscoped. Legal only where the
 *   question really is fleet-wide (the phantom-episode census, the fee
 *   reconcile's coverage diff), and every use carries a comment saying why.
 */
export type LedgerBookScope = string | null | typeof LEDGER_FLEET_WIDE;

/** Normalise any caller-supplied book value to the stored shape. Never guesses. */
function normalizeBook(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

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
 * TRA-3926 (2026-08-26) — the AUTHORITY the row carried when this engine
 * closed it, stamped by the close chokepoint from the row's own durable fields:
 * - 'desk_add'    — `adoptionAuthority: 'desk_add'`, the board's TRA-3909
 *   exemption ("the bot should manage added positions"; card `d4f622fb`).
 * - 'handed_over' — a well-formed per-row `engineHandover` (TRA-3829 ruling B).
 * - 'none'        — the chokepoint LOOKED and the row carried neither.
 * `null` on the record ⇒ UNSTAMPED: a line written before this field existed,
 * or a caller that could not see the row (the reconcile importer).
 *
 * Why it exists: on 2026-08-26T13:45:31Z the engine sold the desk's
 * `RIG260925C00006000` contract under the exemption — exactly as the board
 * instructed and as the exit bound admitted (`desk_add_exempt`) — and the
 * over-sell detector charged it as a finding, because a fill record could not
 * say WHY the engine sold a contract its own opens did not cover. A granted
 * sale and an unauthorised one were the same bytes. This is the discriminator;
 * the detector partitions on it and never on the count alone.
 */
export type LiveCloseGrant = 'desk_add' | 'handed_over';
export type LiveCloseGrantStamp = LiveCloseGrant | 'none';

function isCloseGrantStamp(v: unknown): v is LiveCloseGrantStamp {
  return v === 'desk_add' || v === 'handed_over' || v === 'none';
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
  /**
   * ⭐ TRA-3977 — the BOOK this fill was placed on: the owning per-user engine's
   * `alertUsername`, stamped by the order-path chokepoint at fill time.
   *
   * `null` means UNATTRIBUTED — a row written before this field existed, or a
   * caller that could not name its book. ⛔ It is NOT "the book that is asking":
   * every book-scoped oracle treats `null` as a REFUSAL when more than one book
   * is known to this store (see the file's TRA-3977 block). Never re-derive it
   * from a position row.
   */
  book: string | null;
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
  /**
   * TRA-4143 — TRUE when `ts` is a SYNTHESISED constant, not an observed fill
   * time. Broker account-history carries the trade DATE only (basis verified
   * trade-date, not settlement, on 2026-09-01: `/history` dated the
   * engine-anchored PLTR 08-04T13:43Z buy 08-04 — settlement would read 08-05),
   * so every `history_import` row is stamped `<etDay>T17:00:00Z` — date
   * resolution ONLY. The confirmed 08-04 PLTR same-day round trip hid behind
   * exactly this: a fabricated 17:00Z read like a measured afternoon close.
   * ⛔ A reader must NEVER order a `tsSynthetic` row intraday against any other
   * row on the same day — the comparison has no meaning. `toRecord` always
   * writes it (derived from `origin` when the caller is silent, which also
   * retrofits pre-cut lines at hydrate); optional on the TYPE only so
   * pre-existing fixtures compile — a reader treats an absent key as
   * `origin === 'history_import'`.
   */
  tsSynthetic?: boolean;
  /**
   * TRA-3997 (parent TRA-3703) — THE BOUND SIDE of the entry decision, beside
   * the price side this row has always kept. What the order site READ when it
   * admitted a `buy_to_open`: the pre-order at-risk, the cap in force, the
   * admissible figure, which operand bound it, and the terms the cap came from
   * (see `OptionAdmissionStamp`). Copied VERBATIM from the row by the mirror.
   *
   * `null` ⇒ no reading on this row, and `admissionReason` says why. ALWAYS
   * written by this build (`toRecord` never omits the pair), so a hydrated
   * pre-cut line reads `null` + `unstamped` rather than an absent key. Optional
   * on the TYPE only so fixtures and record literals written before this cut
   * still compile; a reader must treat an absent key exactly as `unstamped`.
   *
   * ⛔ BACKFILL IS OUT OF SCOPE (AC5). A row with `admission: null` is BLIND —
   * "was it admitted inside its headroom?" has no answer — and blind must never
   * be graded as compliant. Instrumentation only: nothing here feeds a bound.
   */
  admission?: OptionAdmissionStamp | null;
  /** TRA-3997 — WHY `admission` is `null`; `null` whenever `admission` is an object. */
  admissionReason?: OptionAdmissionAbsentReason | null;
  /**
   * TRA-3926 — see {@link LiveCloseGrantStamp}. Meaningful on `sell_to_close`
   * rows only; a `buy_to_open` carries `null`. ALWAYS written by this build
   * (`toRecord` never omits it); optional on the TYPE only so fixtures and
   * pre-cut record literals compile. A reader treats an absent key as `null`.
   */
  exitGrant?: LiveCloseGrantStamp | null;
}

/** The mutable inputs a caller hands {@link recordLiveOptionFill}; the module fills ts/etDay/derived slippage. */
export interface LiveOptionFillInput {
  ts: number;
  etDay: string;
  sleeve: LiveFillSleeve;
  /**
   * TRA-3977 — the owning book (`alertUsername`). Optional at the type level
   * ONLY so pre-existing fixtures and the hydrate path compile; a live
   * order-path chokepoint that omits it writes an UNATTRIBUTED row, which every
   * oracle refuses to answer from once a second book is known.
   */
  book?: string | null;
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
  /** TRA-4143 — see {@link LiveOptionFillRecord.tsSynthetic}; derived from origin when absent. */
  tsSynthetic?: boolean;
  /**
   * TRA-3997 — the row's admission stamp, or `null`/absent when the caller has
   * none. An object that fails `isCoherentOptionAdmissionStamp` is refused
   * WHOLE and recorded as `malformed_stamp` — never half-applied.
   */
  admission?: OptionAdmissionStamp | null;
  /**
   * TRA-3997 — why the caller has no stamp. Only consulted when `admission` is
   * not a coherent object; a caller that passes neither is recorded `unstamped`.
   */
  admissionReason?: OptionAdmissionAbsentReason | null;
  /**
   * TRA-3926 — the row's authority at close time (see {@link LiveCloseGrantStamp}).
   * The close chokepoint passes `resolveCloseGrant(row)`; anything else is
   * recorded `null` (UNSTAMPED), never coerced to `'none'`.
   */
  exitGrant?: LiveCloseGrantStamp | null;
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

// ── TRA-3977 — the book registry ─────────────────────────────────────────────
//
// Two sources, deliberately, because the failure mode of a registry is that
// nobody wires it:
//   • `wiredBooks`  — declared at engine wire-up. Present BEFORE any fill, so a
//     fresh process serving two books refuses on its hydrated legacy tape from
//     the first tick rather than after the first fill of each.
//   • `observedBooks` — every distinct non-null `book` this store has recorded
//     or hydrated. THE ARRAY ITSELF IS THE WITNESS: a process into which two
//     books have demonstrably appended is reachable whether or not the wire-up
//     ran. This is the half that cannot be un-wired.
const wiredBooks = new Set<string>();
const observedBooks = new Set<string>();

/**
 * TRA-3977 — declare that this process serves `book`'s options book.
 *
 * Called from the per-user engine wire-up alongside `OptionsAccount.setOwner`,
 * with the same `alertUsername`. Idempotent and cheap. Registering ONE book is
 * a no-op for every oracle (see {@link bookScopingReachable}); registering a
 * SECOND is what turns an unattributed row from an answer into a refusal.
 */
export function registerLiveOptionBook(book: string): void {
  const clean = normalizeBook(book);
  if (clean !== null) wiredBooks.add(clean);
}

/** TRA-3977 — every book known to this store, from either source, sorted. */
export function knownLiveOptionBooks(): string[] {
  return [...new Set([...wiredBooks, ...observedBooks])].sort();
}

/**
 * TRA-4028 — every retained fill on ONE OCC contract, oldest-first, as copies.
 *
 * The raw material for a SIBLING-CLAIM allocation (`claimFillsBySiblingRows`,
 * TRA-3986): the import mint needs to know which `buy_to_open` on the contract
 * is already some other journal row's entry before it may price its own row off
 * the remainder. Neither episode oracle above answers that — `openEpisodeWindow`
 * is a provenance walk and `recordedEngineOpenBasis` a basis walk, and both are
 * scoped to the ENGINE's own episode, while the row being minted is precisely
 * the one the engine did not place. Unscoped by book on purpose: the claim
 * pass attributes by journal row, and a fill that belongs to a sibling book's
 * row is excluded by that row's claim, not by a scope guess here.
 *
 * Observe-only; returns copies so a caller cannot mutate the store.
 */
export function liveOptionFillsForContract(optionSymbol: string): LiveOptionFillRecord[] {
  return fills
    .filter((f) => f.optionSymbol === optionSymbol)
    .map((f) => ({ ...f }))
    .sort((a, b) => a.ts - b.ts);
}

/**
 * TRA-4144 — the WHOLE retained tape, for the asset-class census (AC2b): the
 * historical half of "which classes has real money actually reached", folded by
 * `gradeUnderlyingAssetClassHealth`. Same contract as the per-contract reader
 * above: observe-only, copies, never the live array.
 */
export function liveOptionFillRecords(): LiveOptionFillRecord[] {
  return fills.map((f) => ({ ...f })).sort((a, b) => a.ts - b.ts);
}

/**
 * TRA-3977 — is the book-attribution question REACHABLE in this process?
 *
 * ⭐ This is the measured condition AC4's negative control rests on. With at
 * most one book known, an unattributed row cannot belong to anybody else, so
 * scoping is a strict no-op and every oracle answers exactly as it did before
 * this ticket. With two or more, the tape genuinely cannot be partitioned and
 * an unattributed row is a refusal.
 *
 * ⚠ It is a property of the PROCESS, and it is READ, never assumed — the same
 * discipline as `instrumentBlind` vs an empty population: "a criterion that
 * cannot fail on this run's data is not a pass". `crossBookOpenEpisodeCensus`
 * publishes it so a reader can tell a quiet tape from one nobody can read.
 */
export function bookScopingReachable(): boolean {
  return knownLiveOptionBooks().length > 1;
}

export function liveOptionsFeeSlippageLogPath(dir: string): string {
  return join(dir, LIVE_OPTIONS_FEE_SLIPPAGE_LOG_FILENAME);
}

/**
 * Test seam — drop every record, the configured dir AND the book registry.
 *
 * ⛔ TRA-3977 (2026-08-27) — this is the TEST seam, not the hydrate's reset.
 * The production boot runs `initAllUserContexts()` (which declares every live
 * book via `registerLiveOptionBook`) BEFORE `hydrateLiveOptionsFeeSlippageFromDisk`,
 * and the hydrate used to call this function — wiping `wiredBooks` and leaving
 * the "early half of the two-source read" empty on every boot. Measured on
 * bqb1 `56804e1a` pid 52: two live books served, `books: ["admin"]` (admin
 * only via a hydrated termination marker), `scopingReachable: false` ⇒ every
 * book-scoped oracle answered fleet-wide, i.e. the whole fix was a no-op on
 * the box it was written for. The hydrate now uses {@link resetStoreRows},
 * which leaves the wire-up declarations alone: they are a property of the
 * PROCESS, not of the rows on disk.
 */
export function clearLiveOptionsFeeSlippageLedger(): void {
  resetStoreRows();
  // TRA-3977 — the registry is part of this store's answer too. A suite that
  // left `admin` + `v0nni` registered from the previous case would make the
  // NEXT case's single-book fixture refuse, which is the exact false-negative
  // the reachability gate exists to avoid.
  wiredBooks.clear();
}

/**
 * Drop every row-derived fact (fills, markers, observed books, counters) but
 * NOT the wire-up registry. This is what a re-hydrate from disk owes the
 * process: the rows are about to be re-read from the file, the observed books
 * are re-derived from those rows, and the books the engines DECLARED are not
 * on the file at all — a reset that dropped them would have to wait for each
 * book's next fill (or a termination marker) to learn what it already knew.
 */
function resetStoreRows(): void {
  dataDir = null;
  fills.length = 0;
  lastRecordAt = null;
  hydratedRecords = 0;
  appendErrors = 0;
  lastAppendError = null;
  // TRA-3976 — the terminal markers are part of this ledger's answer, so the
  // test seam has to drop them too. Leaving them behind would make a suite's
  // "empty ledger" fixture silently carry the previous case's refusals.
  terminations.length = 0;
  hydratedTerminations = 0;
  terminationAppendErrors = 0;
  lastTerminationAppendError = null;
  // TRA-3977 — `observedBooks` is derived from the rows, so it resets with
  // them; the hydrate re-populates it from every row it keeps. `wiredBooks`
  // is deliberately NOT here (see `clearLiveOptionsFeeSlippageLedger`).
  observedBooks.clear();
}

function finiteOrNull(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

const ADMISSION_ABSENT_REASONS: readonly OptionAdmissionAbsentReason[] = ['not_evaluated_on_path', 'unstamped', 'malformed_stamp'];
function isAdmissionAbsentReason(v: unknown): v is OptionAdmissionAbsentReason {
  return typeof v === 'string' && (ADMISSION_ABSENT_REASONS as readonly string[]).includes(v);
}

/**
 * TRA-3997 — resolve the (stamp, reason) pair a record carries. Exactly one of
 * the two is non-null. A coherent object wins; an incoherent object is refused
 * whole as `malformed_stamp` (the refusal IS the finding — a half-applied stamp
 * would read as a partial reading); no object ⇒ the caller's reason, or
 * `unstamped` when the caller gave none (the hydrate path for every pre-cut line).
 */
function resolveAdmission(input: Pick<LiveOptionFillInput, 'admission' | 'admissionReason'>): {
  admission: OptionAdmissionStamp | null;
  admissionReason: OptionAdmissionAbsentReason | null;
} {
  if (isCoherentOptionAdmissionStamp(input.admission)) {
    return { admission: { ...input.admission }, admissionReason: null };
  }
  if (input.admission !== null && input.admission !== undefined) {
    return { admission: null, admissionReason: 'malformed_stamp' };
  }
  return {
    admission: null,
    admissionReason: isAdmissionAbsentReason(input.admissionReason) ? input.admissionReason : 'unstamped',
  };
}

/** Build a fully-derived record from a caller input (shared by record + a hydrate re-derive). */
function toRecord(input: LiveOptionFillInput): LiveOptionFillRecord {
  const filledPrice = finiteOrNull(input.filledPrice);
  const askAtSubmit = finiteOrNull(input.askAtSubmit);
  const midAtSubmit = finiteOrNull(input.midAtSubmit);
  const fees = finiteOrNull(input.fees);
  // TRA-3997 — resolved once, written unconditionally (both keys, always).
  const { admission, admissionReason } = resolveAdmission(input);
  // Rows written before TRA-2959 carry no origin on disk; they were all
  // captured by fill-time chokepoints, so 'fill' is the honest default.
  const origin = isOrigin(input.origin) ? input.origin : 'fill';
  return {
    mode: 'live',
    ts: input.ts,
    etDay: input.etDay,
    sleeve: input.sleeve,
    // TRA-3977 — normalised, never defaulted. An absent/blank book is honestly
    // UNATTRIBUTED; substituting a caller's identity here is the permissive
    // back-fill AC3 refuses.
    book: normalizeBook(input.book),
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
    origin,
    // TRA-4143 — a caller's explicit stamp is honoured; otherwise derived from
    // origin. Every writer of a 'history_import' row synthesises its ts from a
    // date-only broker record, so the derivation is exact today AND retrofits
    // pre-cut import lines at hydrate (they re-enter through this function).
    tsSynthetic: input.tsSynthetic === true || origin === 'history_import',
    // TRA-3997 — the bound side of the entry decision. A pre-cut line hydrates
    // as `null` + `unstamped`: BLIND, never back-filled (AC5).
    admission,
    admissionReason,
    // TRA-3926 — the row's authority at close time. A pre-cut line or a caller
    // with no row hydrates `null` (UNSTAMPED); never back-filled to `'none'`,
    // because "we looked and there was no grant" is a statement only the
    // chokepoint that saw the row can make.
    exitGrant: isCloseGrantStamp(input.exitGrant) ? input.exitGrant : null,
  };
}

/**
 * TRA-3997 — census of the admission stamp over the `buy_to_open` fills on the
 * tape, for `/api/health/live-options-fee-slippage`. Answers "is the stamp
 * being exercised, and does `admissibleBoundBy` DISCRIMINATE?" (AC4) without
 * a reader having to fold `records` by hand.
 *
 * `rows` is the `buy_to_open` population; `stamped + Σ absent = rows`.
 * `byBoundBy` is keyed on the full vocabulary so a key that reads `0` is a
 * measured zero and a missing key is impossible. `lastStampedAt` is `null`
 * until the first stamped open — never-exercised, not clean.
 */
export function summarizeLiveOptionAdmissionStamps(
  records: readonly LiveOptionFillRecord[],
): {
  rows: number;
  stamped: number;
  byBoundBy: Record<OptionAdmissionBoundBy, number>;
  absent: Record<OptionAdmissionAbsentReason, number>;
  /** Stamped opens whose `entryNotionalUsd ≤ admissibleEntryUsd` — the one comparison the stamp exists to make. */
  insideHeadroom: number;
  lastStampedAt: number | null;
} {
  const byBoundBy: Record<OptionAdmissionBoundBy, number> = {
    book: 0, fleet_reachable: 0, both: 0, fleet_unreadable: 0, none: 0,
  };
  const absent: Record<OptionAdmissionAbsentReason, number> = {
    not_evaluated_on_path: 0, unstamped: 0, malformed_stamp: 0,
  };
  let rows = 0;
  let stamped = 0;
  let insideHeadroom = 0;
  let lastStampedAt: number | null = null;
  for (const r of records) {
    if (r.side !== 'buy_to_open') continue;
    rows += 1;
    if (isCoherentOptionAdmissionStamp(r.admission)) {
      stamped += 1;
      byBoundBy[r.admission.admissibleBoundBy] += 1;
      if (Math.round(r.admission.entryNotionalUsd * 100) <= Math.round(r.admission.admissibleEntryUsd * 100)) {
        insideHeadroom += 1;
      }
      if (lastStampedAt === null || r.ts > lastStampedAt) lastStampedAt = r.ts;
    } else {
      // An absent key on a record that never went through `toRecord` (a
      // fixture) is the pre-cut shape: `unstamped`.
      absent[isAdmissionAbsentReason(r.admissionReason) ? r.admissionReason : 'unstamped'] += 1;
    }
  }
  return { rows, stamped, byBoundBy, absent, insideHeadroom, lastStampedAt };
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
  // TRA-3977 — the array is the witness. A second book appending here makes the
  // attribution question reachable even in a process whose registry wire-up
  // never ran.
  if (rec.book !== null) observedBooks.add(rec.book);
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

// ════════════════════════════════════════════════════════════════════════════
// TRA-3976 — A CLOSE THIS LEDGER NEVER SAW.
//
// ── The event, live, real money ─────────────────────────────────────────────
// `SOFI260925C00019000` — an ordinary engine row, `buy_to_open 1 @1.23`, oid
// `142828896`, `origin: 'fill'`, 2026-08-21T14:24:10.277Z. It was closed AT THE
// BROKER; on 2026-08-24T13:34:55.545Z the reconcile saw the OCC gone from
// `/positions` and dropped the local row (`exitReason: 'broker_reconcile'`).
//
// **No `sell_to_close` was ever written here** — there was no fill of ours to
// write. So the ledger held exactly one SOFI row, the open, and every oracle in
// this module went on reporting that episode OPEN, 1 contract, basis $123.00,
// for the whole 30-day retention window. Three separate callers were wrong in
// three different directions off the same silence:
//
//   • {@link recordedEngineOpenBasis} → 1 contract ⇒ `foldOpenPremiumAtRisk`
//     would credit the ENGINE with a contract it does not hold the moment any
//     SOFI row returns to the book. TRA-3913's exact defect, re-entering
//     through a door that fix does not close: it assumed the ledger's silence
//     UNDER-counts (safe), and a missing CLOSE makes it OVER-count.
//   • `ledgerOpenProvenance` → `engine`, sleeve `single_leg_otm` ⇒ a returning
//     desk contract gets stamped `adoptionAuthority: 'engine_origin'`.
//   • {@link engineNetOpenContracts} → `engineNetContracts: 1` ⇒
//     `boundExitContractsToEngineShare` would PERMIT selling it. TRA-3926's
//     over-sell, seeded.
//
// Measured over the whole retained tape on 2026-08-24: 19 live closed journal
// rows, 21 distinct ledger symbols, 19 carrying a `sell_to_close`, and exactly
// ONE phantom-open episode — SOFI. This is the FIRST `broker_reconcile` close
// on the live book and it produced a phantom immediately.
//
// ── The mechanism: a terminal marker, written at drop time ──────────────────
// The reconcile is the only actor that KNOWS the position left our book. It
// writes one marker here as it drops the row, and the marker is EVIDENCE ABOUT
// OUR BOOK ("we stopped holding this, and no fill of ours accounts for it"),
// never an inference about the broker's fills.
//
// ⛔ IT IS NOT A `sell_to_close` AND MUST NEVER BE WRITTEN AS ONE. There was no
// fill: no price, no order id, no quote. A `sell_to_close` row would be a
// FABRICATED FILL — the exact class this module's honest-null rule exists to
// refuse (see the file header: unmeasured is `null`, never `0`) — and it would
// leak into every consumer of `records[]`: `detectOversoldEngineCloses` would
// count it as an engine close, `diffMissingFillsFromHistory` would grade it
// against broker history, the fee reconcile would hunt a commission for it, and
// `summarizeLiveOptionsFeeSlippage().closes` would report a close that never
// happened. A separate store with a separate file is the containment.
//
// ⛔ AND IT IS A REFUSAL, NOT A COUNT. After a marker the episode's answer is
// `indeterminate` / `reconcile_terminal` — "this ledger cannot state a net
// position for this OCC" — never `flat` (a FINDING: we opened it and our own
// records closed it out). The two want different remedies and must not share a
// column; `flat` would let the write path read a phantom as a settled fact.
// ════════════════════════════════════════════════════════════════════════════

/** TRA-3976 — which drop path wrote the marker. */
export type ReconcileTerminationSource =
  /**
   * `OptionsAccount.closeBrokerFlatPosition` — the broker stopped reporting the
   * OCC across `BROKER_MISSING_SWEEPS_TO_CLOSE` consecutive reconcile sweeps
   * and the local row was closed at break-even.
   */
  'broker_flat_reconcile';

function isTerminationSource(v: unknown): v is ReconcileTerminationSource {
  return v === 'broker_flat_reconcile';
}

/**
 * TRA-3976 — one record that OUR BOOK stopped holding an OCC through a route
 * that produced no fill for this ledger to record.
 *
 * Deliberately NOT a {@link LiveOptionFillRecord}: there is no price, no order
 * id and no quote, so every numeric field a fill carries would have to be
 * fabricated or null-padded, and the row would join populations it is not a
 * member of. See the block comment above.
 */
export interface ReconcileTerminationRecord {
  /** Always 'live' — the demo book has no broker counterpart to go flat at. */
  mode: 'live';
  /** Drop time, ms epoch. */
  ts: number;
  /** ET calendar day (America/New_York, YYYY-MM-DD). */
  etDay: string;
  /**
   * TRA-3977 — the BOOK whose row the reconcile dropped. Scoped identically to
   * {@link LiveOptionFillRecord.book} and for a sharper reason: a marker is an
   * EPISODE BOUNDARY, so a sibling book's drop would otherwise truncate this
   * book's live episode and refuse its exit (`reconcile_terminal` binds to
   * `exitContracts: 0`). Cross-book, that is a refusal manufactured out of
   * somebody else's position leaving somebody else's account.
   */
  book: string | null;
  /** OCC option symbol whose episode this terminates. */
  optionSymbol: string;
  /**
   * `contractsRemaining` on the local row at drop time. Published as EVIDENCE
   * (how much left the book unaccounted), never netted against the ledger's
   * arithmetic — the whole premise is that the two do not agree.
   */
  contractsDropped: number;
  /** Local position id — the durable handle back to the journal row. */
  positionId: string | null;
  source: ReconcileTerminationSource;
}

export interface ReconcileTerminationInput {
  ts: number;
  etDay: string;
  /** TRA-3977 — the dropping book. Absent ⇒ UNATTRIBUTED, never "the asker". */
  book?: string | null;
  optionSymbol: string;
  contractsDropped: number;
  positionId?: string | null;
  source: ReconcileTerminationSource;
}

/** All retained terminal markers, append-ordered. */
const terminations: ReconcileTerminationRecord[] = [];
let terminationAppendErrors = 0;
let lastTerminationAppendError: string | null = null;
let hydratedTerminations = 0;

export function liveOptionReconcileTerminationLogPath(dir: string): string {
  return join(dir, LIVE_OPTION_RECONCILE_TERMINATION_LOG_FILENAME);
}

/**
 * TRA-3976 — record that the reconcile dropped a live row for `optionSymbol`
 * without this ledger ever seeing the close.
 *
 * Idempotent per (symbol, ts, positionId): the reconcile sweep runs repeatedly
 * and a duplicate marker would inflate the census without changing any verdict.
 * Returns whether a NEW marker was appended, so the caller can count real
 * events rather than sweeps.
 *
 * Best-effort on IO, exactly like {@link recordLiveOptionFill}: a write failure
 * is COUNTED and swallowed so a reconcile pass can never be broken by this
 * accounting. ⚠ The in-memory marker still lands — an unwritten marker would
 * mean the oracle silently returns to reporting the phantom after a reboot, so
 * the durability of THIS file is published beside the fill ledger's.
 */
export function recordReconcileTermination(input: ReconcileTerminationInput): boolean {
  if (typeof input.optionSymbol !== 'string' || input.optionSymbol === '') return false;
  if (typeof input.ts !== 'number' || !Number.isFinite(input.ts)) return false;
  if (!isTerminationSource(input.source)) return false;
  const positionId = typeof input.positionId === 'string' && input.positionId !== '' ? input.positionId : null;
  // TRA-3977 — `book` is part of the dedupe key. Two books dropping the same OCC
  // in the same millisecond with no position id are two events, and collapsing
  // them would let one book's drop silently stand in for the other's.
  const book = normalizeBook(input.book);
  const already = terminations.some(
    (t) =>
      t.optionSymbol === input.optionSymbol &&
      t.ts === input.ts &&
      t.positionId === positionId &&
      t.book === book,
  );
  if (already) return false;
  const rec: ReconcileTerminationRecord = {
    mode: 'live',
    ts: input.ts,
    etDay: input.etDay,
    // TRA-3977 — normalised, never defaulted (see `toRecord`).
    book,
    optionSymbol: input.optionSymbol,
    // `!(x > 0)` rather than `x <= 0` — a NaN reads as a number until something
    // compares it (TRA-3486), and this figure is published.
    contractsDropped:
      typeof input.contractsDropped === 'number' &&
      Number.isFinite(input.contractsDropped) &&
      input.contractsDropped > 0
        ? input.contractsDropped
        : 0,
    positionId,
    source: input.source,
  };
  terminations.push(rec);
  // TRA-3977 — same witness rule as `recordLiveOptionFill`.
  if (rec.book !== null) observedBooks.add(rec.book);
  if (dataDir == null) return true;
  const path = liveOptionReconcileTerminationLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    terminationAppendErrors += 1;
    lastTerminationAppendError = err instanceof Error ? err.message : String(err);
    log.warn('live-option reconcile-termination append failed', {
      reason: lastTerminationAppendError,
    });
  }
  return true;
}

/** TRA-3976 — every retained terminal marker, newest first. */
export function reconcileTerminations(): ReconcileTerminationRecord[] {
  return [...terminations].sort((a, b) => b.ts - a.ts);
}

/** TRA-3976 — what {@link backfillReconcileTerminationsFromJournal} did. */
export interface ReconcileTerminationBackfillResult {
  /** LIVE journal rows closed with `exitReason: 'broker_reconcile'`. The denominator. */
  candidates: number;
  /** Candidates carrying no OCC symbol or no `closeTs` — UNASKABLE, not clean. */
  unaskable: number;
  /** Candidates whose OCC the ledger does not report open (nothing to terminate). */
  alreadyAccounted: number;
  /** Candidates whose marker was already on disk. */
  duplicates: number;
  /** Markers written this pass. */
  written: number;
}

/**
 * TRA-3976 — write the markers for drops that happened BEFORE this code shipped.
 *
 * `closeBrokerFlatPosition` marks every drop from here on. It cannot mark the
 * one already on the live tape: `SOFI260925C00019000` was dropped on
 * 2026-08-24T13:34:55.545Z, and without this pass its phantom sits in the
 * ledger until the 30-day retention window closes it — reported by the census
 * every beat and read by all three oracles in between.
 *
 * ⛔ THE SOURCE IS OUR OWN JOURNAL, WHICH IS THE WHOLE POINT. Journal row
 * `34f1ee99` carries `exitReason: 'broker_reconcile'` and `closeTs`: that is
 * OUR durable record that OUR book stopped holding the OCC, written by the same
 * drop this marker describes. It is evidence about our book, exactly as AC1
 * requires — NOT an inference from the broker's `/positions` being empty, and
 * NOT the book-vs-ledger diff the census takes (which is TRA-2820's shape read
 * backwards: a row we really did place, whose local row was lost to a reboot,
 * presents identically and would lose its stop).
 *
 * Idempotent three ways: by the (symbol, ts, positionId) dedupe in
 * {@link recordReconcileTermination}, by skipping any OCC the ledger does not
 * currently report OPEN, and because a redundant marker is a no-op in the walk
 * anyway (it only terminates an episode with contracts still on it).
 */
export function backfillReconcileTerminationsFromJournal(
  rows: ReadonlyArray<{
    id?: string;
    mode?: string;
    optionSymbol?: string | null;
    contracts?: number | null;
    closeTs?: number | null;
    exitReason?: string | null;
    /**
     * TRA-3977 — the journal's own `account` column (TRA-1475), i.e. the book
     * that held the dropped row. Absent on rows written before that column, and
     * absent stays UNATTRIBUTED — this pass reconstructs the PAST, and the past
     * is exactly what cannot be attributed after the fact.
     */
    account?: string | null;
  }>,
): ReconcileTerminationBackfillResult {
  const out: ReconcileTerminationBackfillResult = {
    candidates: 0,
    unaskable: 0,
    alreadyAccounted: 0,
    duplicates: 0,
    written: 0,
  };
  for (const r of rows) {
    if (r.mode !== 'live') continue;
    if (r.exitReason !== 'broker_reconcile') continue;
    out.candidates += 1;
    const occ = typeof r.optionSymbol === 'string' ? r.optionSymbol : '';
    const closeTs = typeof r.closeTs === 'number' && Number.isFinite(r.closeTs) ? r.closeTs : null;
    if (occ === '' || closeTs === null) {
      // UNASKABLE, and counted as such: a row we cannot key is not a row we
      // have cleared. Synthesising a symbol or a timestamp here would put a
      // marker on the wrong episode.
      out.unaskable += 1;
      continue;
    }
    // ⭐ TRA-3977 — FLEET_WIDE here on purpose, and it is the conservative
    // direction. This gate only asks "does the ledger still report anything
    // open on this OCC", i.e. is a marker worth writing at all; a book-scoped
    // read of the legacy tape REFUSES (`book_unattributed`), which is not
    // `open`, which would silently stop TRA-3976's back-fill from ever writing
    // the marker it exists to write. Fleet-wide over-counts what is open, so it
    // writes FEWER markers, never more.
    if (openEpisodeWindow(occ, LEDGER_FLEET_WIDE).status !== 'open') {
      out.alreadyAccounted += 1;
      continue;
    }
    const wrote = recordReconcileTermination({
      ts: closeTs,
      etDay: new Date(closeTs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
      book: typeof r.account === 'string' && r.account !== '' ? r.account : null,
      optionSymbol: occ,
      contractsDropped:
        typeof r.contracts === 'number' && Number.isFinite(r.contracts) ? r.contracts : 0,
      positionId: typeof r.id === 'string' && r.id !== '' ? r.id : null,
      source: 'broker_flat_reconcile',
    });
    if (wrote) out.written += 1;
    else out.duplicates += 1;
  }
  return out;
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
  /**
   * The ledger cannot state a net position for this OCC — its own quantities do
   * not reconcile, or (TRA-3976) the reconcile recorded that our book dropped
   * the OCC through a close this ledger never saw. Read `reason`.
   */
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
  | 'unusable_quantity'
  /**
   * TRA-3976 — the reconcile dropped this OCC from our book while the ledger
   * still showed contracts open, and wrote a terminal marker saying so. The
   * arithmetic here is not broken; the ledger simply never saw the close, so it
   * cannot state a net position for this symbol.
   *
   * ⛔ This is a REFUSAL, not `flat`. `flat` says "we opened it and our own
   * records closed it out" — a FINDING, which the write path is entitled to act
   * on. Here the close is exactly the thing we have no record of.
   */
  | 'reconcile_terminal'
  /**
   * ⭐ TRA-3977 — this process serves MORE THAN ONE book, and at least one row
   * on this OCC carries no book discriminator. The ledger cannot say whether
   * those contracts are the asking book's or a sibling's, so it cannot state a
   * net position FOR THE BOOK THAT ASKED.
   *
   * ⛔ A REFUSAL, and it must not be silently narrowed either way. Dropping the
   * unattributed rows is PERMISSIVE in the close direction (a sibling's
   * `sell_to_close` vanishing inflates our engine share); keeping them is the
   * fleet-wide behaviour this ticket exists to end. Refuse, and COUNT it —
   * `crossBookOpenEpisodeCensus` publishes the population.
   *
   * ⚠ Gated on {@link bookScopingReachable}: with at most one book known to
   * this store an unattributed row cannot be anybody else's, and this reason is
   * unreachable by construction.
   */
  | 'book_unattributed';

/**
 * TRA-3977 — the rows of ONE OCC, narrowed to the book that asked.
 *
 * The whole scoping decision lives here, once, so the three walks that read
 * this store cannot drift apart on it.
 */
interface ScopedOccRows {
  rows: LiveOptionFillRecord[];
  marks: ReconcileTerminationRecord[];
  /** True ⇒ the tape cannot be partitioned for this OCC; the caller must REFUSE. */
  refuse: boolean;
}

function scopeOccRows(optionSymbol: string, scope: LedgerBookScope): ScopedOccRows {
  const rows = fills.filter((f) => f.optionSymbol === optionSymbol);
  const marks = terminations.filter((t) => t.optionSymbol === optionSymbol);
  // Deliberately unscoped — the caller's question really is fleet-wide.
  if (scope === LEDGER_FLEET_WIDE) return { rows, marks, refuse: false };
  // ⭐ AC4's NEGATIVE CONTROL, and it is a MEASURED condition, not an
  // assumption. With at most one book known to this store there is nothing to
  // scope: an unattributed row cannot belong to a sibling that does not exist,
  // and every oracle below returns byte-for-byte what it returned before
  // TRA-3977. This is the branch every pre-existing fixture takes.
  if (!bookScopingReachable()) return { rows, marks, refuse: false };
  // ⛔ AC3 — an unattributed row is a REFUSAL, never "the book that is asking".
  if (rows.some((r) => r.book === null) || marks.some((m) => m.book === null)) {
    return { rows: [], marks: [], refuse: true };
  }
  // Every row names a book, and the caller cannot name itself ⇒ none of them is
  // provably the caller's. Same refusal, from the other side.
  if (scope === null) {
    return rows.length > 0 || marks.length > 0
      ? { rows: [], marks: [], refuse: true }
      : { rows: [], marks: [], refuse: false };
  }
  return {
    rows: rows.filter((r) => r.book === scope),
    marks: marks.filter((m) => m.book === scope),
    refuse: false,
  };
}

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
  /**
   * TRA-3976 — terminal markers the walk consumed. Counted separately from
   * `closes` because a marker is NOT a close: it is our own record that the
   * position left the book through a route that produced no fill.
   */
  terminations: number;
  /** Set only on `indeterminate`. */
  reason: OpenEpisodeIndeterminateReason | null;
}

/**
 * TRA-3918 — see {@link OpenEpisodeStatus}. The one walk all three oracles share.
 *
 * @param book TRA-3977 — WHICH BOOK is asking. Required, and with no default:
 *   this store is process-wide and two live books append to it, so "the rows for
 *   this OCC" is not a well-formed question without one. Pass
 *   {@link LEDGER_FLEET_WIDE} where the question genuinely is fleet-wide, and
 *   say why at the call site.
 */
export function openEpisodeWindow(optionSymbol: string, book: LedgerBookScope): OpenEpisodeWindow {
  const scoped = scopeOccRows(optionSymbol, book);
  if (scoped.refuse) {
    return {
      status: 'indeterminate',
      fills: [],
      netContracts: 0,
      closes: 0,
      terminations: 0,
      reason: 'book_unattributed',
    };
  }
  const rows = scoped.rows;
  // Stable (ES2019) — same-`ts` rows keep append order, which is the order they
  // actually filled in.
  rows.sort((a, b) => a.ts - b.ts);
  if (rows.length === 0) {
    // ⚠ TRA-3976 — gated on FILLS, deliberately, and terminal markers do not
    // widen it. A marker with no `buy_to_open` behind it says our book stopped
    // holding an OCC whose opens this ledger never held either (retention aged
    // them out, or no chokepoint ever recorded them); that is `no_record`'s
    // question and `recordedOpenFillCount` is still the right discriminator for
    // it. Returning a refusal here would convert an unrelated silence into a
    // finding about a drop.
    return { status: 'no_record', fills: [], netContracts: 0, closes: 0, terminations: 0, reason: null };
  }

  // TRA-3976 — walk the fills and the terminal markers as ONE ts-ordered event
  // stream. A marker is an episode boundary exactly as a flattening close is,
  // and it has to be ordered against the fills rather than applied afterwards:
  // an engine re-entry AFTER a drop opens a genuinely new episode the marker
  // has no business truncating (see the `buy_to_open` branch below).
  type EpisodeEvent =
    | { ts: number; order: 0; fill: LiveOptionFillRecord; marker?: undefined }
    | { ts: number; order: 1; marker: ReconcileTerminationRecord; fill?: undefined };
  const events: EpisodeEvent[] = rows.map((f) => ({ ts: f.ts, order: 0 as const, fill: f }));
  // TRA-3977 — the SCOPED markers, from the same narrowing as the fills. A
  // sibling book's drop is not an episode boundary on this book's position.
  for (const t of scoped.marks) events.push({ ts: t.ts, order: 1 as const, marker: t });
  // `order` breaks a ts tie in favour of the FILL: a marker stamped at the same
  // millisecond as a fill is the drop that followed it, never the drop that
  // preceded it. Stable sort keeps same-ts fills in append order (above).
  if (events.length > rows.length) events.sort((a, b) => a.ts - b.ts || a.order - b.order);

  const refuse = (
    reason: OpenEpisodeIndeterminateReason,
    closes: number,
    terminationCount: number,
  ): OpenEpisodeWindow => ({
    status: 'indeterminate',
    fills: [],
    netContracts: 0,
    closes,
    terminations: terminationCount,
    reason,
  });

  let episode: LiveOptionFillRecord[] = [];
  let net = 0;
  let closes = 0;
  let terminationCount = 0;
  // TRA-3976 — sticky only until the next episode opens off zero. A drop
  // terminates the episode it dropped and NOTHING after it.
  let terminated = false;
  for (const ev of events) {
    if (ev.marker !== undefined) {
      terminationCount += 1;
      // ⛔ The marker is NOT netted against `net`. The premise of the whole
      // mechanism is that the ledger's arithmetic and the book disagree, so
      // subtracting `contractsDropped` would be arithmetic on a number we have
      // just declared unreliable — and a marker for MORE than the ledger shows
      // would land in `unmatched_close`, filing a reconcile drop as ledger
      // corruption.
      if (net > 0) {
        terminated = true;
        net = 0;
        episode = [];
      }
      // `net === 0` ⇒ the ledger ALREADY accounts for this OCC being closed (a
      // real `sell_to_close`, or one the history importer recovered). The
      // marker is redundant and must not downgrade that clean `flat` FINDING to
      // a refusal — which is also how this self-heals if the importer later
      // recovers the broker-side close.
      continue;
    }
    const f = ev.fill;
    const qty = f.contracts;
    if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0) {
      return refuse('unusable_quantity', closes, terminationCount);
    }
    if (f.side === 'buy_to_open') {
      // Off zero, this opens a NEW episode — whatever came before is closed and
      // does not get to vote on what we hold now.
      if (net <= 0) {
        episode = [];
        // TRA-3976 — and neither does an earlier drop. An engine entry on an
        // OCC we were once dropped out of is an ordinary open with its own fill
        // record; refusing on it forever would strand the engine's own new
        // position (AC4's regression, one episode further on).
        terminated = false;
      }
      episode.push(f);
      net += qty;
      continue;
    }
    closes += 1;
    // A close with nothing open, or closing more than is open, means the ledger
    // is missing rows. Refuse rather than net to zero and call it flat.
    if (net <= 0 || qty > net) return refuse('unmatched_close', closes, terminationCount);
    net -= qty;
    if (net === 0) episode = []; // FLATTENED — the episode is over, permanently.
  }

  if (episode.length > 0) {
    return { status: 'open', fills: episode, netContracts: net, closes, terminations: terminationCount, reason: null };
  }
  // TRA-3976 — REFUSAL before FINDING. The episode ended because we dropped it
  // out of the book, not because our own records closed it out.
  if (terminated) return refuse('reconcile_terminal', closes, terminationCount);
  return { status: 'flat', fills: [], netContracts: 0, closes, terminations: terminationCount, reason: null };
}

/**
 * TRA-3926 (2026-08-24) — how many of an OCC's currently-open contracts THIS
 * ENGINE's own records account for, netted against the closes we have already
 * taken. The WRITE path's oracle; {@link recordedEngineOpenBasis} is the
 * reader's and they must not be swapped.
 *
 * ── Why the reader's oracle cannot answer this, measured on live money ──────
 * `recordedEngineOpenBasis` walks BACKWARD and stops at the first
 * `sell_to_close` it meets, then returns `null` on an empty episode. The
 * docblock above says that truncation "fails closed" — and it does, FOR A
 * READER, whose refusal routes the dollars to the desk. On the WRITE path the
 * same `null` becomes `oracleRefused` and
 * {@link boundExitContractsToEngineShare}'s BLIND branch, which exits at the
 * ROW's quantity. **The identical byte is conservative for the reader and
 * permissive for the writer.**
 *
 * Live on bqb1 `3d0c3582`, 2026-08-24T13:26Z, with the TRA-3926 fix DEPLOYED:
 *
 *     BAC260925C00063000  08-20 13:36:23Z  buy_to_open   1 @1.65  origin=fill
 *                         08-20 17:00:00Z  buy_to_open   1 @1.17  origin=history_import
 *                         08-21 17:05:10Z  sell_to_close 1 @0.91  origin=fill
 *
 * `recordedEngineOpenBasis('BAC…')` → `null` (episode empty, stopped at the
 * close), so the bound went BLIND over a row `foldOpenPremiumAtRisk` was
 * simultaneously attributing 100% to the desk ($117.00 of `adoptedUsd`, on the
 * operator's own basis pin). One contract left, bought by the desk, and the
 * fix shipped to stop exactly that could not see it.
 *
 * ── The rule: our own closes are charged against our own lots FIRST ─────────
 * Built on {@link openEpisodeWindow}, not on a fourth walk — that one is
 * `ts`-ordered (imports append out of order, TRA-2959), tracks the boundary by
 * NET contracts rather than by the first close, and already separates its three
 * "no" states. Within the currently-open episode:
 *
 *     closedContracts = Σ(episode opens) − netContracts
 *     engineNetContracts = min(netContracts, max(0, engineOpenContracts − closedContracts))
 *
 * Charging our closes to our own lots first is the only assignment that can
 * never let us sell somebody else's contract, and the ledger cannot tell us
 * which lot an exit consumed (TRA-3703 — `adopted` is the ledger echoing its own
 * convention). BAC → `1 − 1 = 0` ⇒ the engine may sell NOTHING. A TP1 partial
 * (open 2, close 1) → `2 − 1 = 1` ⇒ it still exits its own remainder, which is
 * the case the naive "a closed episode means we hold zero" rule breaks and
 * which the live tape carries three times over (`TSLA260911C00560000`,
 * `AAPL260904P00280000`, `SPY260904C00816000` each hold two closes).
 *
 * ── What it refuses to answer, and why each refusal is load-bearing ─────────
 * `no_record` — TRA-2820's shape exactly: a row this app really did place whose
 * local row was lost to a reboot. Binding on it re-creates that incident (8 live
 * contracts, $216, unstopped for a session). `indeterminate` — the ledger's own
 * arithmetic does not close. `flat` — the ledger's records are exhausted and the
 * broker still shows contracts, i.e. the TRA-2959 shape (7 of 11 filled orders
 * never reached the ledger), so the residue is as likely ours as the desk's.
 * `engineOpenContracts === 0` — an import-only episode says the BROKER bought
 * this OCC, never that the DESK did (TRA-3932 refuted the fetch that could tell
 * them apart: Tradier's order surface is a one-trading-day window).
 *
 * Each of those keeps the caller BLIND, which is the pre-fix quantity. This
 * oracle can only ever LOWER what the engine submits; there is no input on which
 * it widens one.
 */
export interface EngineNetOpenAccount {
  /** {@link openEpisodeWindow}'s verdict, passed through unchanged. */
  status: OpenEpisodeStatus;
  /** Contracts the ledger believes are open on this OCC right now. */
  netContracts: number;
  /** Of the open episode's `buy_to_open` rows, the ones the ENGINE placed. */
  engineOpenContracts: number;
  /** Of the same rows, the ones whose only evidence is a `history_import`. */
  importedOpenContracts: number;
  /** Contracts the episode's closes consumed: `Σ opens − netContracts`. */
  closedContracts: number;
  /**
   * The bound's answer: `min(netContracts, max(0, engineOpen − closed))`.
   * `0` on every refusing status, which is why callers MUST branch on `status`
   * and never on this number alone — 0-because-we-hold-none and
   * 0-because-we-cannot-say are the same bytes here (TRA-3913 AC2).
   */
  engineNetContracts: number;
  /** Set only on `indeterminate`. */
  reason: OpenEpisodeIndeterminateReason | null;
}

export function engineNetOpenContracts(
  optionSymbol: string,
  /**
   * ⭐ TRA-3977 — the book whose exit is being sized. Required. Before this
   * parameter existed, a fill placed on `v0nni` could authorize an exit on
   * `admin`'s row against a different broker account, and the bound reported it
   * `bounded: false` / `blind: false` — a row the census recorded as CHECKED AND
   * CLEAN. See the TRA-3977 block at the top of this file.
   */
  book: LedgerBookScope,
): EngineNetOpenAccount {
  const window = openEpisodeWindow(optionSymbol, book);
  const blank = {
    status: window.status,
    netContracts: 0,
    engineOpenContracts: 0,
    importedOpenContracts: 0,
    closedContracts: 0,
    engineNetContracts: 0,
    reason: window.reason,
  };
  if (window.status !== 'open') return blank;

  let openContracts = 0;
  let engineOpenContracts = 0;
  let importedOpenContracts = 0;
  for (const f of window.fills) {
    const qty = f.contracts;
    // `openEpisodeWindow` already refused every non-positive-finite quantity,
    // so this cannot fire — re-checked rather than asserted because a silent
    // `NaN` here would propagate into an order quantity (TRA-3486).
    if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0) return blank;
    openContracts += qty;
    // Same `!== 'history_import'` test as `recordedEngineOpenBasis`, and for the
    // same reason: pre-TRA-2959 rows hydrate as `origin: 'fill'`, and an
    // unrecognised future origin must not silently fall out of OUR share — on
    // this path "ours" is the side that lets us keep exiting our own position.
    if (f.origin !== 'history_import') engineOpenContracts += qty;
    else importedOpenContracts += qty;
  }
  const closedContracts = openContracts - window.netContracts;
  return {
    status: 'open',
    netContracts: window.netContracts,
    engineOpenContracts,
    importedOpenContracts,
    closedContracts,
    engineNetContracts: Math.min(
      window.netContracts,
      Math.max(0, engineOpenContracts - closedContracts),
    ),
    reason: null,
  };
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
export function lastRecordedOpenSleeve(
  optionSymbol: string,
  /** TRA-3977 — the asking book; see {@link openEpisodeWindow}. */
  book: LedgerBookScope,
): LiveFillSleeve | null {
  const window = openEpisodeWindow(optionSymbol, book);
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
export function lastRecordedOpenFill(
  optionSymbol: string,
  /** TRA-3977 — the asking book; see {@link openEpisodeWindow}. */
  book: LedgerBookScope,
): LiveOptionFillRecord | null {
  const window = openEpisodeWindow(optionSymbol, book);
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
  /**
   * TRA-3976 — whether the backward walk was bounded by a reconcile TERMINAL
   * MARKER rather than by a close. Distinct from `stoppedAtClose` because the
   * two are different facts about the tape: one says our own close ended the
   * episode, the other says the episode ended without our ever seeing a close.
   */
  stoppedAtTermination: boolean;
  /** Fill time of the newest `buy_to_open` in the episode, ms epoch. */
  lastTs: number;
  /**
   * ── TRA-3913 (regression, 2026-08-21) — THE SAME EPISODE, SCOPED TO ROWS THE
   * ENGINE ITSELF PLACED (`origin: 'fill'`). ─────────────────────────────────
   *
   * The four fields below exist because the ones above answer a question this
   * module's own importer can put a foreign answer into. `origin:
   * 'history_import'` rows are the RECONCILE's reconstruction of fills the
   * broker reports and NO chokepoint of ours recorded (TRA-2959) — they carry
   * the broker's price, `orderId: null` and `sleeve: 'unattributed'`, and they
   * are written for the DESK's hand-placed contracts exactly as readily as for
   * ours. They are evidence about the ACCOUNT, never evidence that this engine
   * placed the order.
   *
   * ⚠ MEASURED, LIVE, ON REAL MONEY. TRA-3913 shipped on `1f1264df` and graded
   * 12/12 at 03:07Z with the live XLF row splitting $108.00 engine / $85.00
   * desk. By 13:26Z the same build on the same pid served `adoptedUsd $0.00`
   * again — no deploy, no code change. Overnight the importer had appended
   * `XLF260925C00057500 1 @0.85 origin:'history_import'` (the desk's contract)
   * and `BAC260925C00063000 1 @1.17`, and `contracts` above dutifully counted
   * them. The oracle for "what did WE pay, and for how many" had absorbed the
   * desk's fill and answered 2, so the fold attributed the whole lot to the
   * engine. ⇒ **AN ORACLE THAT INGESTS THE BROKER'S RECORD OF SOMEBODY ELSE'S
   * TRADE CANNOT ANSWER A PROVENANCE QUESTION**, and the defect re-entered a
   * ticket that had already been graded PASS on live bytes, through the DATA,
   * with the fixed code still running.
   *
   * ⛔ The wide fields are NOT deprecated and must not be redefined in terms of
   * these. `importedFromTradier` rows aside, the wide basis is what a RETENTION
   * or restart gap leaves us — and TRA-2820 measured what happens when a
   * provenance reader under-counts: 8 live contracts / $216 of real premium
   * handed the sub-floor sentinel with no stop for a session. Under-counting is
   * safe for an ATTRIBUTION caller (it over-reports the desk's share and moves
   * no cap) and dangerous for a PROVENANCE caller. Each caller picks the scope
   * that fails closed FOR IT; that choice is the whole point of publishing both.
   */
  /** Contracts backed by PRICED `buy_to_open` rows this engine placed itself. */
  enginePlacedContracts: number;
  /** Quantity-weighted `filledPrice` over those engine-placed fills only. */
  enginePlacedPremiumPaid: number;
  /** Engine-placed `buy_to_open` rows in the episode we could not price. */
  enginePlacedUnpricedFills: number;
  /**
   * Contracts in the episode whose ONLY evidence is a `history_import` row.
   * `enginePlacedContracts === 0 && importedContracts > 0` is the state above:
   * the ledger holds rows for this OCC and not one of them says we placed it.
   */
  importedContracts: number;
}

/**
 * TRA-3896 — see {@link RecordedEngineOpenBasis}. `null` when this ledger holds
 * no `buy_to_open` for the symbol at all, which is the "oracle cannot answer"
 * state and must NOT be read as "the engine bought nothing" (see
 * {@link recordedOpenFillCount} for why those two are different).
 */
export function recordedEngineOpenBasis(
  optionSymbol: string,
  /**
   * ⭐ TRA-3977 — the book the row belongs to. Required, and its refusal shape
   * is this function's existing one: `null`. A sibling book's `buy_to_open` is
   * not evidence about THIS book's contract, and counting it is the
   * double-attribution hazard `splitEngineExposureContracts` rule 3 already
   * names — two rows on one OCC each claiming the same recorded contracts.
   */
  book: LedgerBookScope,
): RecordedEngineOpenBasis | null {
  // TRA-3977 — narrowed ONCE, up front, so the ts-cutoff below and the backward
  // walk can never disagree about which rows are in scope.
  const scoped = scopeOccRows(optionSymbol, book);
  if (scoped.refuse) return null;
  const episode: LiveOptionFillRecord[] = [];
  let stoppedAtClose = false;
  // ── TRA-3976 — the SECOND episode boundary: a reconcile terminal marker ────
  // Applied as a ts CUTOFF rather than as a stop-at-this-row, because this walk
  // is deliberately in ARRAY order (the history importer appends OLDER fills at
  // the end, TRA-2959) and a marker has no position in that order to stop at.
  // Any fill at or before the newest marker belongs to an episode our book has
  // already dropped; only fills strictly AFTER it are the current one.
  //
  // A fill stamped at the marker's exact millisecond is treated as PRE-drop.
  // That is the direction that fails closed here: this oracle answers a BASIS
  // question, where under-counting over-reports the desk's share and moves no
  // cap, and over-counting spends the board's authorization on somebody else's
  // money (see the `enginePlacedContracts` note above).
  let terminalTs = -Infinity;
  for (const t of scoped.marks) {
    if (t.ts > terminalTs) terminalTs = t.ts;
  }
  let stoppedAtTermination = false;
  for (let i = scoped.rows.length - 1; i >= 0; i--) {
    const f = scoped.rows[i]!;
    if (f.ts <= terminalTs) {
      stoppedAtTermination = true;
      continue;
    }
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
  // TRA-3913 — the same walk, scoped to rows we placed. Accumulated HERE rather
  // than in a second pass over a filtered copy so the two answers can never be
  // computed over different episode windows.
  let enginePlacedContracts = 0;
  let enginePlacedCostBasisUsd = 0;
  let enginePlacedUnpricedFills = 0;
  let importedContracts = 0;
  for (const f of episode) {
    const qty = typeof f.contracts === 'number' && Number.isFinite(f.contracts) ? f.contracts : 0;
    const price = f.filledPrice;
    // `!== 'history_import'` rather than `=== 'fill'`: rows written before
    // TRA-2959 hydrate with `origin: 'fill'` (see `recordLiveOptionFill`), and a
    // future origin tag must not silently fall out of the engine's own share —
    // an unrecognised value belongs on the side that fails closed for the
    // PROVENANCE readers, which is "ours". The importer is the one thing that
    // demonstrably writes somebody else's trade into this ledger; name it.
    const enginePlaced = f.origin !== 'history_import';
    if (typeof f.orderId === 'number' && Number.isFinite(f.orderId)) orderIds.push(f.orderId);
    if (f.ts > lastTs) lastTs = f.ts;
    if (!(qty > 0) || typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      unpricedFills += 1;
      if (enginePlaced) enginePlacedUnpricedFills += 1;
      continue;
    }
    contracts += qty;
    costBasisUsd += price * qty * 100;
    if (enginePlaced) {
      enginePlacedContracts += qty;
      enginePlacedCostBasisUsd += price * qty * 100;
    } else {
      importedContracts += qty;
    }
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
    stoppedAtTermination,
    lastTs,
    enginePlacedContracts,
    // Same divide guard as above, and for the same reason: 0 engine-placed
    // contracts must not mint a NaN that reads as a number until compared.
    enginePlacedPremiumPaid:
      enginePlacedContracts > 0 ? enginePlacedCostBasisUsd / (enginePlacedContracts * 100) : 0,
    enginePlacedUnpricedFills,
    importedContracts,
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
  /** TRA-3976 — reconcile terminal markers recovered this boot. */
  terminations: number;
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
  // ⛔ TRA-3977 — rows only. `clearLiveOptionsFeeSlippageLedger()` here wiped
  // the books the engines had declared at `initAllUserContexts()` (which runs
  // BEFORE this hydrate at boot), so `bookScopingReachable()` was false on a
  // box serving two live books and every book-scoped oracle answered
  // fleet-wide. Measured 2026-08-27 on bqb1 `56804e1a`.
  resetStoreRows();
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
      // ⛔ TRA-3977 — a line written before this field existed hydrates
      // UNATTRIBUTED and stays that way. There is no back-fill here, and there
      // must not be: the only book we could name is the one whose process is
      // reading the file, which is exactly the permissive default AC3 refuses.
      book: rec.book,
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
      // TRA-4143 — pass an explicit stamp through; an absent one re-derives
      // from origin inside toRecord (which is what retrofits pre-cut lines).
      tsSynthetic: rec.tsSynthetic,
      // TRA-3997 — pass the pair through untouched. A line with neither key
      // resolves to `null` + `unstamped` inside `toRecord`; there is NO
      // back-fill here and there must not be (AC5).
      admission: rec.admission,
      admissionReason: rec.admissionReason,
      // TRA-3926 — pass the close grant through untouched; a line with no key
      // hydrates `null` (UNSTAMPED) and there is no back-fill.
      exitGrant: rec.exitGrant,
    });
    fills.push(clean);
    // TRA-3977 — a hydrated row is a witness too: a file carrying two books'
    // fills makes the attribution question reachable from the first tick, before
    // this boot has recorded anything.
    if (clean.book !== null) observedBooks.add(clean.book);
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
  // TRA-3976 — the terminal markers hydrate in the SAME call, from the same
  // dir, under the same retention. A boot that recovered the fills and not the
  // markers would silently resume publishing the phantom the markers exist to
  // refuse, and nothing on the wire would say so.
  hydratedTerminations = hydrateReconcileTerminationsFromDisk(dir, now);
  return { records: kept.length, migrated, terminations: hydratedTerminations };
}

/** TRA-3976 — see {@link hydrateLiveOptionsFeeSlippageFromDisk}; compacts the same way. */
function hydrateReconcileTerminationsFromDisk(dir: string, now: number): number {
  let raw = '';
  try {
    raw = readFileSync(liveOptionReconcileTerminationLogPath(dir), 'utf8');
  } catch {
    raw = '';
  }
  const cutoff = now - RETAIN_MS;
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let rec: ReconcileTerminationRecord;
    try {
      rec = JSON.parse(trimmed) as ReconcileTerminationRecord;
    } catch {
      continue; // a torn trailing line is skipped, never thrown on
    }
    if (typeof rec.ts !== 'number' || !Number.isFinite(rec.ts) || rec.ts < cutoff) continue;
    if (typeof rec.optionSymbol !== 'string' || rec.optionSymbol === '') continue;
    if (!isTerminationSource(rec.source)) continue;
    const clean: ReconcileTerminationRecord = {
      mode: 'live',
      ts: rec.ts,
      etDay: typeof rec.etDay === 'string' ? rec.etDay : '',
      // TRA-3977 — same no-back-fill rule as the fill hydrate.
      book: normalizeBook(rec.book),
      optionSymbol: rec.optionSymbol,
      contractsDropped:
        typeof rec.contractsDropped === 'number' &&
        Number.isFinite(rec.contractsDropped) &&
        rec.contractsDropped > 0
          ? rec.contractsDropped
          : 0,
      positionId: typeof rec.positionId === 'string' && rec.positionId !== '' ? rec.positionId : null,
      source: rec.source,
    };
    terminations.push(clean);
    if (clean.book !== null) observedBooks.add(clean.book); // TRA-3977 — witness
    kept.push(JSON.stringify(clean));
  }
  const nonEmptyLines = raw.split('\n').filter((l) => l.trim() !== '').length;
  if (kept.length < nonEmptyLines) {
    const path = liveOptionReconcileTerminationLogPath(dir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8');
    } catch (err) {
      log.warn('live-option reconcile-termination compaction failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return kept.length;
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
    // ⛔ TRA-3977 / TRA-3926 (2026-08-26) — THE BOOK MUST SURVIVE A BACK-FILL.
    // This converter omitted `book`, so every fee / price reconcile pass
    // re-derived the row through `toRecord` with `book: undefined` and wrote
    // it back UNATTRIBUTED. That is the `book: null` on 5/5 post-deploy fills
    // TRA-3977 measured on 2026-08-25: the chokepoint stamped the book and the
    // next gainloss pass stripped it. A stamp is a fact about the fill, not
    // about the fee; every stamp on the row rides through here verbatim.
    book: rec.book,
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
    // TRA-3997 — a fee back-fill re-derives the row; the admission stamp must
    // survive it verbatim (it is a fact about the admit, not about the fee).
    admission: rec.admission,
    admissionReason: rec.admissionReason,
    // TRA-3926 — and so must the close grant (a fact about the close).
    exitGrant: rec.exitGrant,
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
//
// ── TRA-4408: WASH-SALE-ADJUSTED COST BASIS ──────────────────────────────────
// Tradier's `/gainloss` reports the TAX basis, not the trade basis: when a lot
// is closed at a loss and a substantially-identical lot is bought within the
// wash window, the disallowed loss is ADDED to the replacement lot's `cost`.
// Measured live 2026-09-09 on ***: three open-side groups (NOK/RIG/BAC) each
// held one lot whose cost exceeded its execution gross by EXACTLY the realized
// loss of a same-symbol lot closed within days — e.g. BAC260925C00063000:
// replacement bought 08-20 @ $117.11, sibling lot closed 08-21 at a $74.24
// loss, reported cost 117.11 + 74.24 = 191.35. The open-side derivation
// (cost − gross) then reads fee ≈ loss and the sanity bound rejects it — the
// bound working as designed, but the rows would sit unmeasured forever.
//
// The fee is still recoverable, because the adjustment is itself in the fetch:
// the loss lot's raw cost/proceeds ARE reported (only the replacement's cost
// is inflated). So for an above-bound OPEN-side group, subtract candidate
// realized losses of same-symbol lots closed within the wash window; iff
// EXACTLY ONE candidate lands the fee inside [0, bound], that is the fee (on
// the live incident all three groups resolve to the $0.11/contract every
// other measured open carries). Ambiguity or no candidate ⇒ reject exactly as
// before — the recovery only ever narrows the rejection, never the bound.
// Close-side groups are untouched: proceeds are reported fees-net and raw.
// Every recovery is PUBLISHED as a {@link GainLossWashRepair} — a rewrite in
// a money path must be visible, not merely correct.

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

/**
 * TRA-4408 — one open-side group whose fee was recovered from under a
 * wash-sale-adjusted cost basis (see the section header). `rawDerived` is what
 * the naive derivation read (the number the bound rejected), `washAdjustment`
 * the disallowed loss subtracted, `fee` what was written. `lossCloseDays`
 * names the ET close day(s) of the loss lot(s) whose realized loss supplied
 * the adjustment — the reader's path to verifying it against the lot sample.
 */
export interface GainLossWashRepair {
  symbol: string;
  day: string;
  side: LiveFillSide;
  contracts: number;
  rawDerived: number;
  washAdjustment: number;
  fee: number;
  lossCloseDays: string[];
}

/** How close (in calendar days) a loss lot's close must sit to the group's open
 * day to be a wash-sale adjustment candidate. The IRS window is ±30 days;
 * 31 absorbs date-boundary noise without admitting unrelated history. */
const WASH_SALE_WINDOW_DAYS = 31;

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
  /**
   * TRA-4408 — open-side groups whose fee was recovered from under a
   * wash-sale-adjusted cost basis this pass. Empty on a payload with no
   * adjusted lots (the common case).
   */
  washRepairs: GainLossWashRepair[];
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
  // TRA-4408 — realized losses per (close-resolved) symbol: the wash-recovery
  // candidates. Only closed lots appear in `/gainloss`, so `cost − proceeds > 0`
  // IS the realized loss; the loss lot's own cost/proceeds are reported raw
  // (only the REPLACEMENT lot's cost carries the adjustment).
  const lossLotsBySymbol = new Map<string, Array<{ loss: number; closeDay: string }>>();
  for (const lot of lots) {
    const openSymbol = resolveLotSymbol(lot.symbol, lot.openDate, 'buy_to_open');
    const closeSymbol = resolveLotSymbol(lot.symbol, lot.closeDate, 'sell_to_close');
    addLot(feeMatchKey(openSymbol, lot.openDate, 'buy_to_open', 0), lot.quantity, lot.cost);
    addLot(feeMatchKey(closeSymbol, lot.closeDate, 'sell_to_close', 0), lot.quantity, lot.proceeds);
    const loss = round2(lot.cost - lot.proceeds);
    if (loss > 0) {
      const entry = { loss, closeDay: lot.closeDate.slice(0, 10) };
      const g = lossLotsBySymbol.get(closeSymbol);
      if (g) g.push(entry);
      else lossLotsBySymbol.set(closeSymbol, [entry]);
    }
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
  const washRepairs: GainLossWashRepair[] = [];
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
    let writeFee = groupFee;
    if (groupFee > bound) {
      // TRA-4408 — before rejecting an OPEN-side group, try the wash-sale
      // recovery (see the section header): iff EXACTLY ONE candidate realized
      // loss of a same-symbol lot closed inside the wash window lands the fee
      // in [0, bound], the excess was the broker's basis adjustment, not a
      // mis-pairing. Candidates are each single loss plus (when several) their
      // sum — multiple same-symbol wash lots stack onto one replacement.
      let recovered: { fee: number; adjustment: number; lossCloseDays: string[] } | null = null;
      let ambiguous = false;
      if (side === 'buy_to_open') {
        const groupDayMs = Date.parse(first.etDay);
        const eligible = (lossLotsBySymbol.get(first.optionSymbol) ?? []).filter(
          (l) =>
            Number.isFinite(groupDayMs)
            && Number.isFinite(Date.parse(l.closeDay))
            && Math.abs(Date.parse(l.closeDay) - groupDayMs) <= WASH_SALE_WINDOW_DAYS * 86_400_000,
        );
        const candidates: Array<{ fee: number; adjustment: number; lossCloseDays: string[] }> = [];
        for (const l of eligible) {
          const fee = round2(groupFee - l.loss);
          if (fee >= 0 && fee <= bound) candidates.push({ fee, adjustment: l.loss, lossCloseDays: [l.closeDay] });
        }
        if (eligible.length > 1) {
          const total = round2(eligible.reduce((s, l) => s + l.loss, 0));
          const fee = round2(groupFee - total);
          if (fee >= 0 && fee <= bound) {
            candidates.push({ fee, adjustment: total, lossCloseDays: eligible.map((l) => l.closeDay) });
          }
        }
        const distinctFees = new Set(candidates.map((c) => c.fee));
        if (distinctFees.size === 1) recovered = candidates[0]!;
        else if (distinctFees.size > 1) ambiguous = true;
      }
      if (recovered === null) {
        reject(
          'above-bound',
          groupFee,
          bound,
          `derived fee ${groupFee} exceeds the ${GAINLOSS_FEE_MAX_PER_CONTRACT_USD}/contract sanity bound (${bound} for ${rowQty} contract(s)) — a mis-pairing artifact, not a fee${
            ambiguous ? '; wash-sale recovery found MULTIPLE candidate adjustments and refused to choose (TRA-4408)' : ''
          }`,
        );
        continue;
      }
      washRepairs.push({
        symbol: first.optionSymbol,
        day: first.etDay,
        side,
        contracts: rowQty,
        rawDerived: groupFee,
        washAdjustment: recovered.adjustment,
        fee: recovered.fee,
        lossCloseDays: recovered.lossCloseDays,
      });
      writeFee = recovered.fee;
    }

    for (const i of indices) {
      const r = records[i]!;
      if (r.fees !== null) continue; // keep an existing measurement
      feeByIndex.set(i, round2((writeFee * r.contracts) / rowQty));
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
  return { updated, records: out, rejections, prefixRepairs, washRepairs };
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
  /**
   * ⭐ TRA-3977 — the BOOK whose Tradier account this history was fetched from.
   * An imported row is the broker's record of a fill on ONE account, so it is
   * attributable exactly as far as the caller's account resolution is: the fee
   * reconcile resolves `resolveLiveBrokerOperator()`, so its imports carry that
   * operator's book. Absent ⇒ UNATTRIBUTED, never "whoever asks".
   */
  book: string | null = null,
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
        inputs.push(importedInput(fill, day, qty, g.side, records, book));
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
        book, // TRA-3977 — the account this history came from
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
        tsSynthetic: true, // TRA-4143 — the 17:00Z above is a constant, not a measurement
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
  /** TRA-3977 — the account this history was fetched from; null ⇒ unattributed. */
  book: string | null,
): LiveOptionFillInput {
  return {
    // History carries only the ET calendar day; noon-ET-ish is honest enough
    // for retention/ordering (17:00Z is 12:00/13:00 ET year-round).
    ts: Date.parse(`${day}T17:00:00Z`),
    etDay: day,
    book,
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
    tsSynthetic: true, // TRA-4143 — the 17:00Z above is a constant, not a measurement
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
/**
 * TRA-4408 — coverage of the UNION of every account's history by the ledger,
 * each ledger row counted ONCE. The per-account results this replaces as the
 * publishable fold double-counted `book: null` rows: a (symbol, day, side)
 * group with fills on TWO accounts (live NVTS261002C00012500, 1 contract on
 * each of admin/v0nni, both rows pre-attribution `book: null`) had its ledger
 * rows counted against BOTH accounts' broker qty, so the summed fold read
 * ledgerContracts 40 vs brokerContracts 36 — "4 contracts over-recorded" —
 * against a ledger that holds exactly the broker's 36. That phantom overage
 * was cited as corroboration on TRA-4408's own filing. Read-only: computes
 * the diff against the live store and discards its would-be imports (the
 * per-account import pass remains the writer, since only it knows which
 * account a missing fill belongs to).
 */
export function ledgerCoverageAgainstHistory(
  historyFills: readonly TradierTradeHistoryFill[],
  todayEt: string,
): LedgerCoverageResult {
  return diffMissingFillsFromHistory(fills, historyFills, todayEt, null).coverage;
}

export function importMissingLiveOptionFills(
  historyFills: readonly TradierTradeHistoryFill[],
  todayEt: string,
  /** TRA-3977 — see {@link diffMissingFillsFromHistory}. */
  book: string | null = null,
): LedgerCoverageResult {
  const { inputs, coverage } = diffMissingFillsFromHistory(fills, historyFills, todayEt, book);
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

// ── TRA-3976 (AC5) — THE CENSUS ─────────────────────────────────────────────
//
// The marker fixes every phantom created FROM NOW ON. It cannot fix the one
// already on the tape (SOFI was dropped on 2026-08-24T13:34:55.545Z, before any
// build carrying this code), and it cannot prove there is not a second route
// into the same shape. So the population is COUNTED on the wire.
//
// ⛔ THE CENSUS IS AN OBSERVATION, NEVER A WRITER. It is tempting to close the
// loop — "the ledger says open, the book holds nothing, write a marker" — and
// that is TRA-2820 with the sign flipped: a row this app really did place whose
// LOCAL row was lost to a reboot presents identically, and marking it would
// take the provenance away from a real engine position and leave it at the
// broker with no stop (8 live contracts, $216, unstopped for a session). The
// marker has exactly one writer, and it is the one actor holding evidence:
// the reconcile, at the moment it drops the row, having watched the OCC leave
// the broker's book across consecutive sweeps.
//
// ⚠ AND IT FAILS TO BLIND, NEVER TO CLEAN. With no held-symbol set wired, a
// phantom and a healthy book are the same bytes — `wired: false` / `blind`, so
// the absence of the instrument can never read as the absence of the defect.

/** TRA-3976 — one OCC the ledger reports OPEN that our book does not hold. */
export interface PhantomOpenEpisodeRow {
  optionSymbol: string;
  /** Contracts the ledger believes are open. */
  netContracts: number;
  /** Of those, the ones backed by a `buy_to_open` the ENGINE placed. */
  engineOpenContracts: number;
  /** Of those, the ones whose only evidence is a `history_import` row. */
  importedOpenContracts: number;
  /** Fill time of the newest open in the episode, ms epoch. */
  lastOpenTs: number;
}

export interface PhantomOpenEpisodeCensus {
  /** False ⇒ no held-symbol set was supplied; the verdict is `blind`. */
  wired: boolean;
  /**
   * `clean`   — every OCC the ledger reports open is held by the book.
   * `phantom` — at least one is not. THE DEFECT, and the only value that pages.
   * `blind`   — not wired. Never folded to `clean`.
   */
  verdict: 'clean' | 'phantom' | 'blind';
  /** Size of the held-symbol set, or null when unwired. */
  heldSymbols: number | null;
  /** Distinct OCCs whose ledger episode reads `open`. The denominator. */
  ledgerOpenEpisodes: number;
  /** Of those, the ones the book does not hold. `null` when unwired. */
  phantomEpisodes: number | null;
  /** Contracts across `rows`. `null` when unwired. */
  phantomContracts: number | null;
  rows: PhantomOpenEpisodeRow[] | null;
  /** Terminal markers retained (the REMEDIATED population, all-time in window). */
  terminalMarkers: number;
  /** Distinct OCCs currently answering `indeterminate`/`reconcile_terminal`. */
  terminatedEpisodes: number;
  /**
   * TRA-1681's discipline, applied to the marker file: `ephemeral: true` ⇒ the
   * markers die at the next redeploy and every terminated episode silently
   * reverts to reporting its phantom.
   */
  durability: {
    path: string | null;
    ephemeral: boolean;
    hydrated: number;
    appendErrors: number;
    lastAppendError: string | null;
  };
}

/**
 * TRA-3976 (AC5) — count episodes this ledger reports OPEN that the local book
 * does not hold.
 *
 * @param heldLiveOptionSymbols every OCC symbol on the fleet's LIVE open book
 *   right now, or `null` when the caller cannot supply one. `null` is the BLIND
 *   verdict; an EMPTY ARRAY is a real, held-nothing book and grades normally.
 */
export function phantomOpenEpisodeCensus(
  heldLiveOptionSymbols: readonly string[] | null,
): PhantomOpenEpisodeCensus {
  const durability = {
    path: dataDir === null ? null : liveOptionReconcileTerminationLogPath(dataDir),
    ephemeral: isEphemeralDataDir(dataDir),
    hydrated: hydratedTerminations,
    appendErrors: terminationAppendErrors,
    lastAppendError: lastTerminationAppendError,
  };
  const symbols = new Set<string>();
  for (const f of fills) symbols.add(f.optionSymbol);
  let ledgerOpenEpisodes = 0;
  let terminatedEpisodes = 0;
  const open: Array<{ symbol: string; window: OpenEpisodeWindow }> = [];
  for (const symbol of symbols) {
    // ⭐ TRA-3977 — FLEET_WIDE on purpose. This census grades the ledger against
    // the FLEET's held symbols (`liveOpenOptionSymbols` walks every user
    // context), so both sides of the comparison must be fleet-wide or the diff
    // manufactures a phantom out of a scoping mismatch. Book-scoping this one
    // would ALSO be a silent regression on the legacy tape: every episode would
    // answer `book_unattributed`, `ledgerOpenEpisodes` would fall to 0, and a
    // census whose whole value is that it reads zero would read zero for the
    // wrong reason.
    const window = openEpisodeWindow(symbol, LEDGER_FLEET_WIDE);
    if (window.status === 'open') {
      ledgerOpenEpisodes += 1;
      open.push({ symbol, window });
    } else if (window.status === 'indeterminate' && window.reason === 'reconcile_terminal') {
      terminatedEpisodes += 1;
    }
  }
  if (heldLiveOptionSymbols === null) {
    return {
      wired: false,
      verdict: 'blind',
      heldSymbols: null,
      ledgerOpenEpisodes,
      phantomEpisodes: null,
      phantomContracts: null,
      rows: null,
      terminalMarkers: terminations.length,
      terminatedEpisodes,
      durability,
    };
  }
  const held = new Set(heldLiveOptionSymbols);
  const rows: PhantomOpenEpisodeRow[] = [];
  for (const { symbol, window } of open) {
    if (held.has(symbol)) continue;
    let engineOpenContracts = 0;
    let importedOpenContracts = 0;
    let lastOpenTs = 0;
    for (const f of window.fills) {
      const qty = typeof f.contracts === 'number' && Number.isFinite(f.contracts) ? f.contracts : 0;
      // Same `!== 'history_import'` test as the oracles, and for the same
      // reason: an unrecognised future origin must not fall silently out of the
      // engine's column.
      if (f.origin !== 'history_import') engineOpenContracts += qty;
      else importedOpenContracts += qty;
      if (f.ts > lastOpenTs) lastOpenTs = f.ts;
    }
    rows.push({
      optionSymbol: symbol,
      netContracts: window.netContracts,
      engineOpenContracts,
      importedOpenContracts,
      lastOpenTs,
    });
  }
  rows.sort((a, b) => b.lastOpenTs - a.lastOpenTs);
  return {
    wired: true,
    verdict: rows.length > 0 ? 'phantom' : 'clean',
    heldSymbols: held.size,
    ledgerOpenEpisodes,
    phantomEpisodes: rows.length,
    phantomContracts: rows.reduce((s, r) => s + r.netContracts, 0),
    rows,
    terminalMarkers: terminations.length,
    terminatedEpisodes,
    durability,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// ⭐ TRA-3977 AC5 — THE CROSS-BOOK CENSUS.
//
// The repair above is only worth what its reachability is, and "today's book
// has no overlap" is an argument, not a measurement. The two live books run the
// SAME OTM sleeve over the SAME universe with the SAME contract floor, so an
// OCC held by both is an ordinary Tuesday.
//
// ⚠ AND A QUIET TAPE MUST BE DISTINGUISHABLE FROM A TAPE NOBODY CAN READ
// (TRA-3926's own standing hook). Three verdicts, and `clean` is the only one
// that means "measured, and there is no overlap":
//   • `clean`         — every book is named and no OCC is open on two of them.
//   • `overlap`       — at least one OCC is open on two or more books. THE
//     reachability of the permissive branch, MEASURED. Not itself a defect —
//     the scoping fix is what makes it safe — but it is the number that says
//     the fix is load-bearing today rather than theoretical.
//   • `unattributed`  — the tape carries rows with no book. The overlap
//     question CANNOT BE ANSWERED for those symbols, and folding them into
//     `clean` is the exact lie this census exists to refuse.
// ════════════════════════════════════════════════════════════════════════════

/** TRA-3977 — one OCC with an open episode on more than one book. */
export interface CrossBookOpenEpisodeRow {
  optionSymbol: string;
  /** The books holding an open episode on it, sorted. */
  books: string[];
  /** Net open contracts per book, index-aligned with `books`. */
  netContracts: number[];
}

export interface CrossBookOpenEpisodeCensus {
  /**
   * ⭐ The measured condition every refusal in this module is gated on: does
   * this process serve more than one book? `false` ⇒ scoping is a strict no-op
   * and every oracle answers exactly as it did before TRA-3977.
   */
  scopingReachable: boolean;
  /** Every book known to this store (wired at engine boot ∪ seen in a row). */
  books: string[];
  /**
   * TRA-3977 (2026-08-27) — the two sources SEPARATELY, so a reader can tell
   * "the engines declared it" from "a row happened to carry it". On bqb1
   * `56804e1a` the boot hydrate wiped the first set and `books` read
   * `["admin"]` off one termination marker while two live books were being
   * served: `booksWired: []` would have named that in one read.
   */
  booksWired: string[];
  booksObserved: string[];
  /** `clean` | `overlap` | `unattributed` — see the block above. */
  verdict: 'clean' | 'overlap' | 'unattributed';
  /** Distinct OCCs carrying at least one row. The denominator. */
  symbols: number;
  /** Of those, the ones open on ≥2 books. */
  overlappingSymbols: number;
  rows: CrossBookOpenEpisodeRow[];
  /**
   * Rows in the whole store carrying no book discriminator. `> 0` with
   * `scopingReachable` ⇒ every oracle REFUSES on those symbols, which is the
   * pre-TRA-3926 quantity on the write path and the desk's dollars on the
   * reader's. **This is the population the fix cannot repair retroactively.**
   */
  unattributedRows: number;
  /** Distinct OCCs carrying at least one unattributed row. */
  unattributedSymbols: number;
}

/** TRA-3977 AC5 — see the block above. Pure; no IO. */
export function crossBookOpenEpisodeCensus(): CrossBookOpenEpisodeCensus {
  const books = knownLiveOptionBooks();
  const symbols = new Set<string>();
  for (const f of fills) symbols.add(f.optionSymbol);
  let unattributedRows = 0;
  const unattributedSymbolSet = new Set<string>();
  for (const f of fills) {
    if (f.book === null) {
      unattributedRows += 1;
      unattributedSymbolSet.add(f.optionSymbol);
    }
  }
  for (const t of terminations) {
    if (t.book === null) {
      unattributedRows += 1;
      unattributedSymbolSet.add(t.optionSymbol);
    }
  }
  const rows: CrossBookOpenEpisodeRow[] = [];
  for (const symbol of symbols) {
    // Only symbols we CAN partition are askable per-book; the rest are counted
    // in the unattributed columns and must not be scored as clean.
    if (unattributedSymbolSet.has(symbol)) continue;
    const holders: string[] = [];
    const nets: number[] = [];
    for (const book of books) {
      const w = openEpisodeWindow(symbol, book);
      if (w.status === 'open' && w.netContracts > 0) {
        holders.push(book);
        nets.push(w.netContracts);
      }
    }
    if (holders.length > 1) rows.push({ optionSymbol: symbol, books: holders, netContracts: nets });
  }
  rows.sort((a, b) => (a.optionSymbol < b.optionSymbol ? -1 : a.optionSymbol > b.optionSymbol ? 1 : 0));
  // ⛔ PRECEDENCE: an unreadable tape outranks a quiet one. A census that
  // reported `clean` while holding rows it cannot attribute would be exactly
  // the "checked and clean" byte this ticket was filed about.
  const verdict: CrossBookOpenEpisodeCensus['verdict'] =
    unattributedRows > 0 ? 'unattributed' : rows.length > 0 ? 'overlap' : 'clean';
  return {
    scopingReachable: bookScopingReachable(),
    books,
    booksWired: [...wiredBooks].sort(),
    booksObserved: [...observedBooks].sort(),
    verdict,
    symbols: symbols.size,
    overlappingSymbols: rows.length,
    rows,
    unattributedRows,
    unattributedSymbols: unattributedSymbolSet.size,
  };
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
  /**
   * TRA-3976 — the reconcile terminal markers, most-recent first. Published
   * beside `records` and NOT inside it: a marker is not a fill, and folding it
   * into `records` would put a close that never happened into `closes`, into
   * the oversold-close census and into the history-coverage diff.
   */
  reconcileTerminations: ReconcileTerminationRecord[];
  /**
   * ⭐ TRA-3977 AC5 — can the rows above be partitioned by book at all, and is
   * any OCC open on two of them right now? Read `verdict` and
   * `unattributedRows` BEFORE reading any per-book claim off `records[]`.
   */
  crossBook: CrossBookOpenEpisodeCensus;
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
    reconcileTerminations: reconcileTerminations(),
    crossBook: crossBookOpenEpisodeCensus(),
  };
}
