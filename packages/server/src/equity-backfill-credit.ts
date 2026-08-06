// TRA-3009 (parent TRA-2297) — the one-time equity backfill credit path.
//
// Before this module there was NO way to apply a one-time credit to a book's
// tradeable equity. `POST /api/account/reset-demo` is `requireAuth` and per-user
// and it RESETS rather than credits; the only equity mutators were
// `PaperAccount.applyEquity` (via a settings save, i.e. the target user's own
// session) and the TRA-2323 forward bridge (which only ever books P&L realized
// AFTER it landed). Option P&L earned before the bridge shipped therefore had no
// route into equity at all.
//
// ── Why this credits through `creditRealizedOptionsPnl`, not `applyEquity` ────
//
// `applyEquity` REBASES `initialEquity` and shifts equity/cash by the delta. Two
// disqualifying consequences:
//
//   1. It is UNATTRIBUTED. `pnl-reconciliation` names it by name as the benign
//      cause of an anonymous `unbookedEquityMoveUsd` (the TRA-2658 caveat), so a
//      backfill applied that way lands in `unbookedEquityMoveDates` and is
//      indistinguishable from the drift that field exists to catch.
//   2. It rebases the compounding basis TRA-2323 just delivered.
//
// `creditRealizedOptionsPnl` moves equity AND cash by the same signed delta (so
// `cashInvariant.gap` is left exactly as it was found — TRA-2301) and increments
// the durable `optionsCredited` counter, which is precisely the attribution
// channel `pnl-reconciliation` reads as `optionsCreditedCumulative`. The credit
// therefore shows up as CREDITED, not as an unbooked move.
//
// ── ⚠ THE MODE GUARD READS RAW `AccountSettings.mode`, NEVER `stockModeKey` ───
//
// This is the whole point of the guard and it is the trap TRA-3009's own scoping
// walked into, so it is pinned by test rather than left to a comment.
//
//   `stockModeKey(settings)` = settings.mode !== 'live'          -> 'demo'
//                              liveTradierEnvOptions=production  -> 'live'
//                              otherwise                         -> 'sandbox'
//
// A book running `settings.mode: 'live'` against the Tradier SANDBOX env resolves
// `stockModeKey` = `'sandbox'`. A guard phrased as "refuse when the mode reads
// `live`" therefore ACCEPTS that book — it reads `'sandbox'`, which is not
// `'live'`, and the reader concludes "not live, therefore safe paper money". It
// is not safe: `index.ts` gates the TRA-359 broker-truth `combinedPnl` override
// on `settings.mode === 'live'` (NOT on the env), so a sandbox-env live book has
// its calendar slaved to a broker balance that knows nothing about a credit we
// inject into `PaperAccount`. That is the same double-count hazard that put
// `admin` out of scope, and it is invisible at the `stockModeKey` layer.
//
// So: the ONLY accepted value is a raw `mode` of exactly `'demo'`. `'live'` is
// refused whichever env backs it, and any unrecognised value is refused too —
// an UNKNOWN mode is never an OFF mode.

import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { resolveDataDir } from './data-dir.js';

/** Why a backfill was refused. Every one is a hard stop; none is a warning. */
export type EquityBackfillRefusal =
  /** `amountUsd` was NaN / Infinity / zero. */
  | 'amount-not-usable'
  /** `backfillId` / `username` / `reason` was blank. A credit must be attributable. */
  | 'request-incomplete'
  /**
   * The same `backfillId` was already applied with a DIFFERENT amount or to a
   * DIFFERENT book. Loud on purpose: a silent replay-as-no-op would let a caller
   * believe an amended figure landed when the original one is what is on the book.
   */
  | 'replay-mismatch'
  /** No resident book with that username. */
  | 'book-not-found'
  /** The book's raw `AccountSettings.mode` is not exactly `'demo'`. */
  | 'book-mode-not-demo';

/** The durable audit row written for every APPLIED credit. */
export interface EquityBackfillLedgerRow {
  backfillId: string;
  username: string;
  /** Raw `AccountSettings.mode` at apply time, recorded so the guard is auditable. */
  bookMode: string;
  amountUsd: number;
  equityBefore: number;
  equityAfter: number;
  optionsCreditedBefore: number;
  optionsCreditedAfter: number;
  /** TRA-2301 cash invariant either side of the credit; both must be equal. */
  cashInvariantGapBefore: number | null;
  cashInvariantGapAfter: number | null;
  /** Provenance: issue id + how the figure was derived. Never blank. */
  reason: string;
  appliedAtIso: string;
}

export type EquityBackfillOutcome =
  | { ok: true; applied: true; row: EquityBackfillLedgerRow }
  /** Idempotent replay — the identical request already landed. Nothing moved. */
  | { ok: true; applied: false; replayOf: EquityBackfillLedgerRow }
  | { ok: false; refusal: EquityBackfillRefusal; detail: string };

export interface EquityBackfillRequest {
  /** Named explicitly. This path never infers "the demo book" from a count of one. */
  username: string;
  /** Signed USD added to `totalEquity`. Additive, never a rebase. */
  amountUsd: number;
  /** One-shot key. Re-issuing it is a no-op; changing the amount under it is an error. */
  backfillId: string;
  reason: string;
}

/**
 * The book port. `mode` is the RAW `AccountSettings.mode` — see the module header
 * for why a `stockModeKey` value must never be passed here.
 */
export interface EquityBackfillBook {
  username: string;
  mode: string;
  getTotalEquity(): number;
  getOptionsCredited(): number;
  /** TRA-2301 `cashInvariant.gap`; `null` when the book cannot report one. */
  getCashInvariantGap(): number | null;
  /** Wraps `PaperAccount.creditRealizedOptionsPnl`. */
  credit(delta: number): void;
}

export interface EquityBackfillLedgerPort {
  find(backfillId: string): EquityBackfillLedgerRow | undefined;
  append(row: EquityBackfillLedgerRow): Promise<void>;
}

const blank = (s: unknown): boolean => typeof s !== 'string' || s.trim() === '';

/**
 * Apply a one-time, additive, attributed equity credit to a named demo book.
 *
 * Refusal order is deliberate. Idempotency is resolved BEFORE the book is
 * touched, so a replay is a stable pure read of the ledger and stays correct even
 * if the book has since changed mode or left memory. Everything else is checked
 * before the single mutation, so a refusal never leaves a half-applied credit.
 */
export async function applyEquityBackfill(
  req: EquityBackfillRequest,
  books: readonly EquityBackfillBook[],
  ledger: EquityBackfillLedgerPort,
  nowIso: string,
): Promise<EquityBackfillOutcome> {
  if (blank(req.backfillId) || blank(req.username) || blank(req.reason)) {
    return {
      ok: false,
      refusal: 'request-incomplete',
      detail: 'backfillId, username and reason are all required and must be non-blank',
    };
  }
  if (!Number.isFinite(req.amountUsd) || req.amountUsd === 0) {
    return {
      ok: false,
      refusal: 'amount-not-usable',
      detail: `amountUsd must be finite and non-zero, got ${String(req.amountUsd)}`,
    };
  }

  // ── One-shot, resolved first ────────────────────────────────────────────────
  const prior = ledger.find(req.backfillId);
  if (prior) {
    if (prior.username !== req.username || prior.amountUsd !== req.amountUsd) {
      return {
        ok: false,
        refusal: 'replay-mismatch',
        detail:
          `backfillId ${req.backfillId} already applied ${prior.amountUsd} to ${prior.username}; ` +
          `this request carries ${req.amountUsd} for ${req.username}. Refusing — a credit is not ` +
          'reversible, so an amended figure needs a NEW backfillId and an explicit offset row.',
      };
    }
    return { ok: true, applied: false, replayOf: prior };
  }

  const book = books.find(b => b.username === req.username);
  if (!book) {
    return {
      ok: false,
      refusal: 'book-not-found',
      detail: `no resident book named ${req.username}`,
    };
  }

  // ── The mode guard. Exact string equality against `'demo'`, nothing else. ────
  if (book.mode !== 'demo') {
    return {
      ok: false,
      refusal: 'book-mode-not-demo',
      detail:
        `book ${req.username} has raw AccountSettings.mode '${book.mode}', not 'demo'. ` +
        "Refusing: a non-demo book's calendar combinedPnl is overridden from the broker " +
        'balance (TRA-359, gated on settings.mode === \'live\' regardless of Tradier env), so ' +
        'an injected paper credit double-counts against it.',
    };
  }

  const equityBefore = book.getTotalEquity();
  const optionsCreditedBefore = book.getOptionsCredited();
  const cashInvariantGapBefore = book.getCashInvariantGap();

  book.credit(req.amountUsd);

  const row: EquityBackfillLedgerRow = {
    backfillId: req.backfillId,
    username: req.username,
    bookMode: book.mode,
    amountUsd: req.amountUsd,
    equityBefore,
    equityAfter: book.getTotalEquity(),
    optionsCreditedBefore,
    optionsCreditedAfter: book.getOptionsCredited(),
    cashInvariantGapBefore,
    cashInvariantGapAfter: book.getCashInvariantGap(),
    reason: req.reason,
    appliedAtIso: nowIso,
  };
  await ledger.append(row);
  return { ok: true, applied: true, row };
}

// ── File-backed one-shot ledger ──────────────────────────────────────────────
//
// A JSON array under the durable data dir. Loaded once and held in memory so
// `find` is synchronous (the applier resolves idempotency before any await that
// could interleave a second request). A read failure is NOT swallowed to an empty
// ledger — that would re-arm every spent backfillId and re-credit the book.

let cache: EquityBackfillLedgerRow[] | null = null;
let fileOverride: string | null = null;

/** Test seam — point the ledger at a temp file. `null` restores the default. */
export function setEquityBackfillLedgerFileForTests(path: string | null): void {
  fileOverride = path;
  cache = null;
}

function ledgerFile(): string {
  return fileOverride ?? join(resolveDataDir(), 'equity-backfill-ledger.json');
}

/**
 * Load the ledger. THROWS on an unreadable/corrupt file rather than returning
 * `[]`: an empty ledger reads identically to "nothing has ever been credited",
 * which is exactly the state that lets a one-shot fire twice.
 */
export async function loadEquityBackfillLedger(): Promise<EquityBackfillLedgerRow[]> {
  if (cache) return cache;
  const path = ledgerFile();
  if (!existsSync(path)) {
    cache = [];
    return cache;
  }
  const raw = await readFile(path, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`equity-backfill ledger at ${path} is not an array — refusing to treat as empty`);
  }
  cache = parsed as EquityBackfillLedgerRow[];
  return cache;
}

/** The file-backed port. Call {@link loadEquityBackfillLedger} first. */
export function fileEquityBackfillLedger(rows: EquityBackfillLedgerRow[]): EquityBackfillLedgerPort {
  return {
    find: (id: string) => rows.find(r => r.backfillId === id),
    append: async (row: EquityBackfillLedgerRow) => {
      rows.push(row);
      const path = ledgerFile();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(rows, null, 2)}\n`, 'utf-8');
    },
  };
}
