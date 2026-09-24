// TRA-3401 — the board-ordered ONE-SHOT cost-bar bypass for the two fa390549
// test tickets (card `6b82a9e7`, ask_user_questions, human_only, answered by the
// board 2026-09-24T01:57Z: Q2 = `place`).
//
// The card authorizes "a one-shot, logged bypass of the cost bar for exactly two
// entries (one per account), 1 contract each, ≤$300 notional, inside the ratified
// caps". This module is that authorization's ONLY executable surface, and it is
// deliberately narrower than every knob around it:
//
//   • It bypasses the COST BAR ALONE. Every other live gate (contract floor,
//     entry window, delta floor/ceiling, per-entry cap, aggregate cap, fleet
//     reachable bound, exit-actionability interlock, hard controls, the ask-only
//     maker walk) runs unchanged on a granted candidate.
//   • It is SELF-EXPIRING. The grant carries an explicit validity window and a
//     window longer than 24h refuses to parse — this cannot be left armed as a
//     standing override, which is why it carries no PRODUCTION_ENV_INTENT row
//     (the manifest grades standing posture; this cannot become one).
//   • It is ONE-SHOT PER BOOK, DURABLY. A commit is written through to
//     DATA_DIR before it counts, so a mid-window restart cannot re-grant a book
//     that already opened its ticket (the TRA-3445 "a reset counter reads
//     identically to a flat book" rule). An unreadable/corrupt commit file
//     FAILS CLOSED: every consult refuses until an operator inspects it.
//   • Consults mutate nothing. A grant sets an in-memory pending token; only
//     the open site's explicit commit — after the broker mirror is FINAL —
//     spends the book's one shot (the TRA-4378 exploration-allowance shape:
//     grant checks, commit spends).
//
// Containment: consulted ONLY from the live flat-form branch of
// `SignalEngine.costAwareGateReject`, and ONLY after the tape verdict already
// said BLOCK — with the env var unset (the shipped default) the consult returns
// `{granted:false, refusal:'unset'}` and the path is byte-identical to before.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { resolveDataDir } from './data-dir.js';

export const LIVE_OTM_ONESHOT_GRANT_VAR = 'OPTION_LIVE_OTM_ONESHOT_COSTBAR_BYPASS';

/** Durable per-book commit record — survives restarts, which is the point. */
const COMMIT_STATE_FILENAME = 'live-otm-oneshot-grant-committed.json';

/**
 * Hard ceiling on the per-contract ask notional a grant may admit, USD. The
 * fa390549 card says "≤$300 notional"; no env value may authorize more — a
 * larger `maxPerContractUsd` clamps DOWN, matching the option-exec-flag
 * fail-safe shape.
 */
export const LIVE_OTM_ONESHOT_NOTIONAL_CEILING_USD = 300;

/**
 * Hard ceiling on the grant window's length. A "one-shot diagnostic window"
 * spanning days is a standing override wearing a costume; refuse to parse it.
 */
export const LIVE_OTM_ONESHOT_MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface LiveOtmOneShotGrantSpec {
  /** Provenance — the board card id this grant executes (logged on every grant). */
  card: string;
  /** Exact-match book usernames (the census `username` string). */
  books: string[];
  /** Per-contract ask-notional cap, USD — clamped to the compiled ceiling. */
  maxPerContractUsd: number;
  validFromMs: number;
  validUntilMs: number;
}

export interface LiveOtmOneShotConsult {
  granted: boolean;
  /** Non-null on refusal — which check said no (tallied for the health block). */
  refusal:
    | 'unset'
    | 'malformed'
    | 'window_not_open'
    | 'window_expired'
    | 'book_not_listed'
    | 'already_committed'
    | 'over_per_contract_cap'
    | 'state_unreadable'
    | null;
  /** The card id, for the caller's log line (null unless the spec parsed). */
  card: string | null;
}

interface CommitFileShape {
  /** book → ISO commit stamp + the OCC symbol the shot was spent on. */
  committed: Record<string, { atIso: string; optionSymbol: string; card: string }>;
}

// ── module state ─────────────────────────────────────────────────────────────

let dataDirOverride: string | null = null;
let hydrated = false;
/** Fail-closed latch: set when the commit file exists but cannot be trusted. */
let stateUnreadable = false;
let committed: CommitFileShape['committed'] = {};
/** In-memory pending token per book — set by a grant, spent by the commit. */
const pending = new Map<string, { atMs: number; card: string }>();
/** Since-boot observability tallies (the health block; resets on restart). */
const tallies = {
  consults: 0,
  grants: 0,
  commits: 0,
  refusalsByReason: {} as Record<string, number>,
};

function commitFilePath(): string {
  return join(dataDirOverride ?? resolveDataDir(), COMMIT_STATE_FILENAME);
}

function hydrateIfNeeded(): void {
  if (hydrated) return;
  hydrated = true;
  const file = commitFilePath();
  if (!existsSync(file)) return; // clean cold start — normal
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<CommitFileShape>;
    if (raw && typeof raw === 'object' && raw.committed && typeof raw.committed === 'object') {
      committed = {};
      for (const [book, rec] of Object.entries(raw.committed)) {
        if (rec && typeof rec.atIso === 'string' && typeof rec.optionSymbol === 'string') {
          committed[book] = { atIso: rec.atIso, optionSymbol: rec.optionSymbol, card: String(rec.card ?? '') };
        } else {
          // A half-shaped row means the file was hand-edited or torn: refuse
          // to guess which books already spent their shot.
          stateUnreadable = true;
          return;
        }
      }
    } else {
      stateUnreadable = true;
    }
  } catch {
    stateUnreadable = true;
  }
}

/**
 * Write-through persist, hard-controls shape (tmp + rename). Unlike that
 * module this FAILS CLOSED on a write error: a commit that could not be made
 * durable flips `stateUnreadable`, so a restart cannot resurrect the shot the
 * in-memory set thinks was spent.
 */
function persistCommitted(): boolean {
  try {
    const dir = dataDirOverride ?? resolveDataDir();
    mkdirSync(dir, { recursive: true });
    const tmp = commitFilePath() + '.tmp';
    writeFileSync(tmp, JSON.stringify({ committed } satisfies CommitFileShape, null, 2), 'utf8');
    renameSync(tmp, commitFilePath());
    return true;
  } catch {
    stateUnreadable = true;
    return false;
  }
}

/**
 * Strict parse of the env grant. Anything missing, extra-shaped, out of range
 * or over a compiled ceiling ⇒ null (the consult refuses `malformed`) — an env
 * typo must shrink the grant to nothing, never widen it.
 */
export function parseLiveOtmOneShotGrant(raw: string | undefined): LiveOtmOneShotGrantSpec | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o['card'] !== 'string' || o['card'].trim() === '') return null;
  if (!Array.isArray(o['books']) || o['books'].length === 0) return null;
  const books: string[] = [];
  for (const b of o['books']) {
    if (typeof b !== 'string' || b.trim() === '') return null;
    books.push(b.trim());
  }
  const maxRaw = o['maxPerContractUsd'];
  if (typeof maxRaw !== 'number' || !Number.isFinite(maxRaw) || maxRaw <= 0) return null;
  const maxPerContractUsd = Math.min(maxRaw, LIVE_OTM_ONESHOT_NOTIONAL_CEILING_USD);
  const from = Date.parse(typeof o['validFromIso'] === 'string' ? o['validFromIso'] : '');
  const until = Date.parse(typeof o['validUntilIso'] === 'string' ? o['validUntilIso'] : '');
  if (!Number.isFinite(from) || !Number.isFinite(until)) return null;
  if (until <= from) return null;
  if (until - from > LIVE_OTM_ONESHOT_MAX_WINDOW_MS) return null;
  return { card: o['card'].trim(), books, maxPerContractUsd, validFromMs: from, validUntilMs: until };
}

function refuse(reason: NonNullable<LiveOtmOneShotConsult['refusal']>, card: string | null): LiveOtmOneShotConsult {
  tallies.refusalsByReason[reason] = (tallies.refusalsByReason[reason] ?? 0) + 1;
  return { granted: false, refusal: reason, card };
}

/**
 * Ask the grant to bypass a flat cost-bar BLOCK for one live `single_leg_otm`
 * candidate on `book`. Pure check + pending token; spends nothing (commit does).
 *
 * `perContractUsd` is the candidate's ask notional for ONE contract (ask × 100)
 * — the number the ticket will actually pay, not the mark.
 */
export function consultLiveOtmOneShotGrant(
  env: NodeJS.ProcessEnv,
  book: string | undefined | null,
  perContractUsd: number,
  nowMs: number = Date.now(),
): LiveOtmOneShotConsult {
  tallies.consults += 1;
  const raw = env[LIVE_OTM_ONESHOT_GRANT_VAR];
  if (typeof raw !== 'string' || raw.trim() === '') return refuse('unset', null);
  const spec = parseLiveOtmOneShotGrant(raw);
  if (!spec) return refuse('malformed', null);
  if (nowMs < spec.validFromMs) return refuse('window_not_open', spec.card);
  if (nowMs > spec.validUntilMs) return refuse('window_expired', spec.card);
  const owner = (book ?? '').trim();
  if (owner === '' || !spec.books.includes(owner)) return refuse('book_not_listed', spec.card);
  hydrateIfNeeded();
  if (stateUnreadable) return refuse('state_unreadable', spec.card);
  if (committed[owner]) return refuse('already_committed', spec.card);
  if (!(perContractUsd > 0) || perContractUsd > spec.maxPerContractUsd) {
    return refuse('over_per_contract_cap', spec.card);
  }
  pending.set(owner, { atMs: nowMs, card: spec.card });
  tallies.grants += 1;
  return { granted: true, refusal: null, card: spec.card };
}

/** Is a grant pending (issued, not yet spent) for this book? The open site uses
 * this to clamp the ticket to the card's 1 contract regardless of the
 * ops-settable bounded-test ceiling. */
export function hasPendingLiveOtmOneShotGrant(book: string | undefined | null): boolean {
  const owner = (book ?? '').trim();
  return owner !== '' && pending.has(owner);
}

/**
 * Spend the book's one shot. Called by the open site ONLY once the broker
 * mirror is FINAL (a rolled-back paper open must not burn the shot). Returns
 * false when nothing was pending or the durable write failed — the caller
 * logs; the position itself is already real either way.
 */
export function commitLiveOtmOneShotGrant(
  book: string | undefined | null,
  optionSymbol: string,
  nowMs: number = Date.now(),
): boolean {
  const owner = (book ?? '').trim();
  const token = owner === '' ? undefined : pending.get(owner);
  if (!token) return false;
  pending.delete(owner);
  hydrateIfNeeded();
  committed[owner] = { atIso: new Date(nowMs).toISOString(), optionSymbol, card: token.card };
  const durable = persistCommitted();
  if (durable) tallies.commits += 1;
  return durable;
}

export interface LiveOtmOneShotGrantPublicState {
  /** Whether the env var is set AND parses — NOT whether anything was granted. */
  armed: boolean;
  card: string | null;
  books: string[];
  maxPerContractUsd: number | null;
  validFromIso: string | null;
  validUntilIso: string | null;
  windowOpenNow: boolean;
  stateUnreadable: boolean;
  committed: Record<string, { atIso: string; optionSymbol: string; card: string }>;
  pendingBooks: string[];
  consults: number;
  grants: number;
  commits: number;
  refusalsByReason: Record<string, number>;
}

/** The health block — published beside the OTM `arm` state so tomorrow's
 * verification reads grant + spend off deployed state instead of logs. */
export function getLiveOtmOneShotGrantState(
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): LiveOtmOneShotGrantPublicState {
  hydrateIfNeeded();
  const spec = parseLiveOtmOneShotGrant(env[LIVE_OTM_ONESHOT_GRANT_VAR]);
  return {
    armed: spec !== null,
    card: spec?.card ?? null,
    books: spec?.books ?? [],
    maxPerContractUsd: spec?.maxPerContractUsd ?? null,
    validFromIso: spec ? new Date(spec.validFromMs).toISOString() : null,
    validUntilIso: spec ? new Date(spec.validUntilMs).toISOString() : null,
    windowOpenNow: spec !== null && nowMs >= spec.validFromMs && nowMs <= spec.validUntilMs,
    stateUnreadable,
    committed: { ...committed },
    pendingBooks: [...pending.keys()],
    consults: tallies.consults,
    grants: tallies.grants,
    commits: tallies.commits,
    refusalsByReason: { ...tallies.refusalsByReason },
  };
}

/** Test seam — mirrors `__resetHardControlsForTest`. */
export function __resetLiveOtmOneShotGrantForTest(opts?: { dataDir?: string }): void {
  dataDirOverride = opts?.dataDir ?? null;
  hydrated = false;
  stateUnreadable = false;
  committed = {};
  pending.clear();
  tallies.consults = 0;
  tallies.grants = 0;
  tallies.commits = 0;
  tallies.refusalsByReason = {};
}
