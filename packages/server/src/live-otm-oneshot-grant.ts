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
import { type EphemeralDataDirReason, ephemeralDataDirReason, resolveDataDir } from './data-dir.js';

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
  /**
   * TRA-5020 — spends whose durable write FAILED. A shot burned with no record
   * on disk: the position is real, the file does not say so, and a restart will
   * re-grant the book. Previously invisible on every surface — `commits` does
   * not increment on this path, so the failure rendered as "nothing happened".
   */
  commitsFailedDurable: 0,
  refusalsByReason: {} as Record<string, number>,
};

/**
 * TRA-5020 — what the first-touch hydrate actually DID, so the health block can
 * distinguish "the durable record says no book has spent" from "we never got a
 * durable record to read". Both render `committed: {}`.
 */
export type LiveOtmOneShotHydrateOutcome =
  /** No consult, commit or health read has touched the store yet. */
  | 'not_run'
  /** Hydrate ran; no commit file exists. A clean cold start looks like this. */
  | 'file_absent'
  /** Hydrate ran and parsed a commit file. The ONLY outcome that PROVES a read. */
  | 'loaded'
  /** A file exists and could not be trusted (torn, hand-edited, unparseable). */
  | 'unreadable';

let hydrateOutcome: LiveOtmOneShotHydrateOutcome = 'not_run';
/** Rows the hydrate actually loaded off disk — pre-boot spends, measured. */
let hydratedBooks = 0;

function commitFilePath(): string {
  return join(dataDirOverride ?? resolveDataDir(), COMMIT_STATE_FILENAME);
}

function hydrateIfNeeded(): void {
  if (hydrated) return;
  hydrated = true;
  const file = commitFilePath();
  if (!existsSync(file)) {
    // Clean cold start — normal. ⚠️ TRA-5020: this is NOT the same fact as
    // "no book has spent its shot", and it only means that at all while the
    // DATA_DIR is durable. On an ephemeral dir the file an earlier build wrote
    // is simply gone, and this branch is indistinguishable from a first boot.
    hydrateOutcome = 'file_absent';
    return;
  }
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
          // TRA-5020 — `committed` now holds the rows BEFORE the bad one, so it
          // is a PARTIAL map. Every consult fails closed on the latch, so this
          // costs no safety; it does mean the health block must never publish
          // this map as the complete record (see `commitsDurable: null`).
          hydrateOutcome = 'unreadable';
          hydratedBooks = Object.keys(committed).length;
          return;
        }
      }
      hydrateOutcome = 'loaded';
      hydratedBooks = Object.keys(committed).length;
    } else {
      stateUnreadable = true;
      hydrateOutcome = 'unreadable';
    }
  } catch {
    stateUnreadable = true;
    hydrateOutcome = 'unreadable';
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
  // TRA-5020 — count the OTHER branch too. A spend whose write failed burned a
  // real shot and left no durable trace; before this it incremented nothing and
  // read exactly like a book that never consulted.
  else tallies.commitsFailedDurable += 1;
  return durable;
}

/**
 * TRA-5020 — the grant block's own provenance verdict. Precedence is
 * `unreadable > ephemeral > durable`: the fail-closed latch dominates, because
 * while it is set every consult is refusing and `committed` may be PARTIAL.
 */
export type LiveOtmOneShotCounterProvenanceVerdict =
  /** Tallies boot-scoped; `committed` on a durable dir and trusted. The healthy read. */
  | 'tallies_boot_scoped_committed_durable'
  /**
   * `committed` is on a dir that the next redeploy/re-stage ERASES, so it is
   * boot-scoped too — there is then NO cross-boot witness on this block at all.
   */
  | 'tallies_boot_scoped_committed_ephemeral'
  /** The fail-closed latch is set: `committed` is not a record of anything. */
  | 'tallies_boot_scoped_committed_unreadable';

/**
 * TRA-5020 — says WHICH FIELDS of `oneShotCostBarGrant` survive a restart.
 *
 * TRA-4879 solved this one instrument over, and that label is explicitly scoped:
 * `/api/health/live-enforce-gates` publishes `counterProvenance.scope:
 * 'top_level'` covering `decisionsRecorded` and `byGate` ONLY, so its
 * `countersDurable: true` says NOTHING about this block. This block had no label
 * at all, and rendered two classes of counter side by side:
 *
 *   • DURABLE  — `committed`, `stateUnreadable` (persisted, hydrated from disk)
 *   • SINCE-BOOT — `consults`, `grants`, `commits`, `refusalsByReason`
 *     (module-level `const tallies`; zeroed by every restart)
 *
 * bqb1 reboots ~6x/day, so `commits: 0` read after a reboot is evidence about
 * NOTHING, while rendering byte-identically to a genuine "the grant was never
 * spent". Measured on build `73ab002533bc` (a post-close boot) the block read
 * `commits: 0` beside `committed: {}`; on the build before it the same
 * process-scoped counter read `consults: 5,907` the same ET day.
 *
 * ⛔ Two fields that are NOT the same fact, deliberately kept apart (the TRA-4879
 * `countersDurable`-vs-`verdict` split):
 *
 *   • `committedDurable` describes the STORE — will the next redeploy keep this?
 *   • `committedLoadedAtBoot` describes THIS READ — did a hydrate actually parse
 *     a file into these values?
 *
 * They can disagree in both directions, and the disagreement is information: a
 * durable dir on a genuine first boot is `true`/`false`, and an ephemeral dir
 * that happened to survive a process restart is `false`/`true` — real history it
 * will lose on the next redeploy.
 *
 * ⛔ An UNKNOWN never renders as the safe value. `committedLoadedAtBoot` is
 * `true` ONLY on `hydrateOutcome: 'loaded'` — a missing file reads `false`
 * (nothing was loaded) and an untrusted one reads `false` WITH
 * `stateUnreadable: true`. `commitsDurable` is `null`, never `0`, while the
 * latch is set, because the surviving map is a prefix of a torn file.
 */
export interface LiveOtmOneShotCounterProvenance {
  issue: 'TRA-5020';
  /**
   * Which block this label covers. Named so it can never be read as the
   * TRA-4879 `top_level` label, whose `covers` does not include these fields.
   */
  scope: 'one_shot_cost_bar_grant';
  /** Per FIELD, because this block mixes two spans. Spelled out, not implied. */
  covers: { sinceBoot: string; durable: string };
  /**
   * STRUCTURAL, not measured: `tallies` is a module-level const with no load
   * path, so these four counters cannot be anything but boot-scoped.
   */
  talliesSinceBoot: true;
  /** `build.startedAt` — the instant the tallies start at. `null` ⇒ UNKNOWN. */
  talliesSinceIso: string | null;
  /** FALSE ⇒ `talliesSinceIso` is unknown, so the tallies' span has no left edge. */
  talliesSinceStamped: boolean;
  /** The STORE: resolved and not erased by the next redeploy/re-stage. */
  committedDurable: boolean;
  /** Why the store is NOT durable, or `null` when it is (TRA-4896 markers). */
  committedEphemeralReason: EphemeralDataDirReason;
  /** MEASURED — a hydrate parsed a commit file into these values. */
  committedLoadedAtBoot: boolean;
  /** A commit file was present at first touch. */
  commitFileFound: boolean;
  /** Which of the four hydrate exits this read came through. */
  hydrateOutcome: LiveOtmOneShotHydrateOutcome;
  /** Rows the hydrate loaded off disk — pre-boot spends, measured. */
  hydratedBooks: number;
  /** The resolved commit-file directory. */
  dataDir: string;
  /** DURABLE spend count: `Object.keys(committed).length`. `null` = untrusted. */
  commitsDurable: number | null;
  /** The boot-scoped tally, under a name that says so. */
  commitsSinceBoot: number;
  /**
   * Spends since boot whose durable write FAILED — a burned shot with no record
   * on disk. `> 0` is an inconsistency: the position is real and a restart will
   * re-grant that book.
   */
  commitsFailedDurableSinceBoot: number;
  /** `commitsFailedDurableSinceBoot > 0`, named for the condition it detects. */
  spentWithoutDurableRecord: boolean;
  verdict: LiveOtmOneShotCounterProvenanceVerdict;
  note: string;
}

/** TRA-5020 — compute the label. Pure over module state + the boot stamp. */
function describeLiveOtmOneShotCounterProvenance(
  processStartedAt: string | null,
): LiveOtmOneShotCounterProvenance {
  const dataDir = dataDirOverride ?? resolveDataDir();
  // Grade the dir the commit file ACTUALLY resolves to. When a caller pinned it
  // (tests, ops), grade that PATH — not the ambient DATA_DIR, which is not where
  // the bytes are going. `data_dir_unset` would otherwise be reported for a dir
  // chosen explicitly.
  const ephemeralEnv: NodeJS.ProcessEnv =
    dataDirOverride === null ? process.env : { ...process.env, DATA_DIR: dataDirOverride };
  const committedEphemeralReason = ephemeralDataDirReason(dataDir, ephemeralEnv);
  const committedDurable = committedEphemeralReason === null;
  const committedLoadedAtBoot = hydrateOutcome === 'loaded';
  const commitFileFound = hydrateOutcome === 'loaded' || hydrateOutcome === 'unreadable';
  const commitsDurable = stateUnreadable ? null : Object.keys(committed).length;

  const verdict: LiveOtmOneShotCounterProvenanceVerdict = stateUnreadable
    ? 'tallies_boot_scoped_committed_unreadable'
    : committedDurable
      ? 'tallies_boot_scoped_committed_durable'
      : 'tallies_boot_scoped_committed_ephemeral';

  const verdictClause =
    verdict === 'tallies_boot_scoped_committed_unreadable'
      ? `⛔ COMMIT STATE UNREADABLE (hydrate: ${hydrateOutcome}) — the fail-closed latch is SET, every consult is refusing \`state_unreadable\`, and \`committed\` may be a PARTIAL prefix of a torn file. \`commitsDurable\` is null, NOT 0. This block currently has NO trustworthy cross-boot witness; an operator must inspect ${join(dataDir, COMMIT_STATE_FILENAME)}.`
      : verdict === 'tallies_boot_scoped_committed_ephemeral'
        ? `⛔ \`committed\` IS NOT DURABLE: ${dataDir} is ephemeral (${committedEphemeralReason}), so the next redeploy/re-stage erases it with no error to catch. EVERY field on this block is then boot-scoped and NOTHING here witnesses a spend by a previous build — \`committed: {}\` does not mean the shot is unspent.`
        : `\`committed\` + \`stateUnreadable\` are DURABLE on ${dataDir} (not ephemeral), and ${
          committedLoadedAtBoot
            ? `this process hydrated ${hydratedBooks} committed row(s) off disk — pre-boot spends are already inside \`committed\`.`
            : hydrateOutcome === 'file_absent'
              ? 'no commit file exists yet, so NOTHING was loaded: `committedLoadedAtBoot` is false. On a durable dir that is a genuine "no book has spent its shot", but it is an ABSENCE, not a hydrated record.'
              : 'no hydrate has run yet on this read.'
        }`;

  return {
    issue: 'TRA-5020',
    scope: 'one_shot_cost_bar_grant',
    covers: {
      sinceBoot:
        'consults, grants, commits (= commitsSinceBoot), commitsFailedDurableSinceBoot, '
        + 'refusalsByReason — module-level `const tallies`, ZEROED BY EVERY RESTART'
        + (processStartedAt === null ? ' (start instant UNKNOWN)' : `, since ${processStartedAt}`),
      durable:
        'committed, stateUnreadable (and commitsDurable, derived from committed) — '
        + 'persisted write-through and hydrated at first touch'
        + (committedDurable ? '' : ` ⛔ BUT THE DIR IS EPHEMERAL (${committedEphemeralReason})`),
    },
    talliesSinceBoot: true,
    talliesSinceIso: processStartedAt,
    talliesSinceStamped: processStartedAt !== null,
    committedDurable,
    committedEphemeralReason,
    committedLoadedAtBoot,
    commitFileFound,
    hydrateOutcome,
    hydratedBooks,
    dataDir,
    commitsDurable,
    commitsSinceBoot: tallies.commits,
    commitsFailedDurableSinceBoot: tallies.commitsFailedDurable,
    spentWithoutDurableRecord: tallies.commitsFailedDurable > 0,
    verdict,
    note:
      `${verdictClause} ⛔ \`consults\`/\`grants\`/\`commits\`/\`refusalsByReason\` are SINCE-BOOT and MUST NOT be cited as a cross-boot zero — bqb1 reboots ~6x/day, so a post-reboot \`commits: 0\` is evidence about NOTHING while rendering byte-identically to "the grant was never spent" (TRA-2879's disarm tripwire was re-keyed onto the durable \`committed\` for exactly this reason). Read \`commitsDurable\` for the cross-boot answer. `
      + `⛔ \`committedDurable\` describes the STORE; \`committedLoadedAtBoot\` describes THIS READ. They can disagree and the disagreement is information, not a contradiction. `
      + `⛔ TRA-4879's \`counterProvenance\` on /api/health/live-enforce-gates is scoped \`top_level\` and covers \`decisionsRecorded\`/\`byGate\` ONLY — its \`countersDurable: true\` has never extended to this block. `
      + (tallies.commitsFailedDurable > 0
        ? `🔴 ${tallies.commitsFailedDurable} spend(s) since boot FAILED their durable write: a real shot was burned with no record on disk, and a restart will re-grant that book. `
        : '')
      + (processStartedAt === null
        ? '⚠️ `talliesSinceIso` is null: the boot stamp was not supplied, so the tallies are still boot-scoped but their start instant is UNKNOWN — do not substitute the read time.'
        : ''),
  };
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
  /**
   * SINCE-BOOT. Retained at its original name and original value so no existing
   * reader silently changes meaning; `counterProvenance.commitsDurable` is the
   * cross-boot integer. Prefer `commitsSinceBoot`, which says what it is.
   */
  commits: number;
  /** TRA-5020 — `commits` under a name that cannot be misread. Same value. */
  commitsSinceBoot: number;
  /** TRA-5020 — the DURABLE spend count. `null` while `stateUnreadable`. */
  commitsDurable: number | null;
  refusalsByReason: Record<string, number>;
  /** TRA-5020 — which fields here survive a restart. READ THIS FIRST. */
  counterProvenance: LiveOtmOneShotCounterProvenance;
}

/** The health block — published beside the OTM `arm` state so tomorrow's
 * verification reads grant + spend off deployed state instead of logs. */
export function getLiveOtmOneShotGrantState(
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
  /**
   * TRA-5020 — `build.startedAt`, the instant the since-boot tallies start at.
   * The module cannot know it, so the ROUTE supplies it. Omitted/null renders
   * `talliesSinceStamped: false` and says the span's left edge is UNKNOWN; it is
   * never back-filled from the read time.
   */
  opts?: { processStartedAt?: string | null },
): LiveOtmOneShotGrantPublicState {
  hydrateIfNeeded();
  const spec = parseLiveOtmOneShotGrant(env[LIVE_OTM_ONESHOT_GRANT_VAR]);
  const counterProvenance = describeLiveOtmOneShotCounterProvenance(opts?.processStartedAt ?? null);
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
    commitsSinceBoot: tallies.commits,
    commitsDurable: counterProvenance.commitsDurable,
    refusalsByReason: { ...tallies.refusalsByReason },
    counterProvenance,
  };
}

/** Test seam — mirrors `__resetHardControlsForTest`. */
export function __resetLiveOtmOneShotGrantForTest(opts?: { dataDir?: string }): void {
  dataDirOverride = opts?.dataDir ?? null;
  hydrated = false;
  stateUnreadable = false;
  committed = {};
  pending.clear();
  hydrateOutcome = 'not_run';
  hydratedBooks = 0;
  tallies.consults = 0;
  tallies.grants = 0;
  tallies.commits = 0;
  tallies.commitsFailedDurable = 0;
  tallies.refusalsByReason = {};
}
