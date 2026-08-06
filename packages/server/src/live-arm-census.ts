import type { AccountSettings, TradierEnv } from '@trading-app/shared';
import { isLiveTradierOptionsEnabled } from '@trading-app/shared';
import { resolveLiveOptionsCreds, isLiveBrokerOperator } from './signal-engine.js';

/**
 * TRA-3117 — the per-book LIVE-ARM CENSUS.
 *
 * ## Why this exists
 *
 * On 2026-08-06 a second book (`v0nni`) was running `mode:'live'` against the
 * PRODUCTION Tradier env with `liveOtmArmed:true` fleet-wide, and **no
 * instrument on the box could say whether its order client was armed, or whose
 * Tradier account it pointed at** (TRA-3087 established the book existed;
 * TRA-3081 needed the arm state and could not get it). Every existing surface
 * answers a different question:
 *
 *   • `/api/health/options-live` resolved `resolveLiveBrokerOperator()` and read
 *     THAT USER ONLY — every field on it was the operator's.
 *   • `/api/health/live-equity` published
 *     `liveEquityClientConfigured: snapshots.some(s => …)`. `admin` pins that
 *     `true` permanently, so it CANNOT go false for a second book: it
 *     discriminates nothing. This is the instrument that actually failed.
 *   • `/api/health/pnl-reconciliation` names engines and their `mode` but
 *     carries no credential or client state at all.
 *
 * ## The two properties that are the whole point
 *
 * 1. **No aggregate may stand in for the rows.** An `.some()`/`.any()` over a
 *    cohort containing the operator is PINNED TRUE by the operator. Rollup
 *    counts here are published ALONGSIDE {@link LiveArmCensusReport.books},
 *    never instead of them.
 * 2. **An absent row and a safe row must not read the same.** A live book whose
 *    client does not resolve is emitted as a ROW with
 *    `optionsClientConfigured: false` and a `null` tail — never omitted. Before
 *    this, the only trace such a book left was
 *    `log.warn('live OTM bounded test: no balance snapshot')`, which carried no
 *    username and so could not be attributed to a book at all.
 *
 * ## Disclosure contract (TRA-2163)
 *
 * This feeds a NO-AUTH route. It publishes presence booleans, an env LABEL, and
 * a MASKED last-4 account tail — never a token, secret, or full account id. That
 * is the same class `/api/health/options-live` already published for the
 * operator, and `username` + `mode` are already published per-engine by the
 * no-auth `/api/health/pnl-reconciliation`, so no new class of fact is exposed
 * here — only the same facts for more than one book.
 */
export interface LiveArmCensusBookInput {
  username: string;
  /**
   * DURABLE settings — from `loadSettings`, NEVER `getSettings`. TRA-2761: a
   * `getSettings` cache miss serves `DEFAULT_ACCOUNT_SETTINGS` (mode `demo`),
   * which silently EMPTIES the live cohort and makes this census read clean
   * for exactly the reason it must not.
   */
  settings: AccountSettings;
  /**
   * The engine's IN-MEMORY arm state — `SignalEngine.getLiveOptionsArmState()`,
   * i.e. the three fields the live entry gate itself evaluates.
   *
   * Carried separately because it can disagree with disk: TRA-2649 documents a
   * boot-arm whose force-persist threw, leaving the engine Live in memory while
   * the durable store stayed demoted. The engine trades off THIS, so a census
   * keyed on disk alone would omit the very book that is placing orders.
   */
  runtime: {
    mode: 'live' | 'demo';
    optionsRouted: boolean;
    clientPresent: boolean;
  };
}

export interface LiveArmCensusRow {
  username: string;
  /** Durable mode (`loadSettings`). */
  mode: 'live' | 'demo';
  /** Engine in-memory mode. */
  runtimeMode: 'live' | 'demo';
  /**
   * Durable and runtime mode disagree — the TRA-2649 split-brain. `true` on any
   * row is worth a human: one of the two views of this book is wrong, and the
   * engine trades off `runtimeMode`.
   */
  modeDisagreement: boolean;
  /**
   * THE ANSWER TO "IS THIS BOOK ARMED". The live entry gate as the engine
   * actually holds it: `mode === 'live' && optionsRouted && client !== null`.
   * Everything else on this row explains WHY it reads the way it does.
   */
  liveEntryGateOpen: boolean;
  /** The engine's in-memory options order client is non-null. */
  clientPresent: boolean;
  /** Tradier env these creds address. `production` is the real-money one. */
  tradierEnv: TradierEnv;
  /** Would options signals route at all (`liveTradierMarkets`)? */
  optionsRouted: boolean;
  /** Per-user SAVED production creds — presence only, never values. */
  prodKeySaved: boolean;
  prodAccountSaved: boolean;
  /**
   * TRA-857 — may this user fall back to the shared `process.env` TRADIER_*
   * creds? True ONLY for the pinned operator. This is the discriminator that
   * makes {@link optionsClientConfigured} meaningful: it is the difference
   * between "armed with their own account" and "armed with the desk's".
   */
  envFallbackAllowed: boolean;
  /**
   * Would `buildTradierLiveClient` return a NON-NULL client for this book?
   * Replicates its resolution exactly (via the shared
   * {@link resolveLiveOptionsCreds}) WITHOUT constructing a client or touching
   * any order path.
   */
  optionsClientConfigured: boolean;
  /**
   * The derived answer ({@link optionsClientConfigured}) and the engine's actual
   * client ({@link clientPresent}) disagree. Either the durable store and the
   * running engine hold different creds, or a client was built and later torn
   * down. Like {@link modeDisagreement} this is surfaced rather than resolved —
   * an instrument that silently picks a winner is how the original defect hid.
   */
  clientDisagreement: boolean;
  /**
   * {@link liveEntryGateOpen} AND the env is `production` — i.e. this book can
   * move REAL money right now. A sandbox-armed book is armed but plays with
   * nothing. Keyed off the RUNTIME gate, not the derived one: this field is
   * the one a reader acts on, so it tracks what the engine will actually do.
   */
  realMoneyArmed: boolean;
  /**
   * Where the effective account id came from. THIS is the field that answers
   * "whose money":
   *   • `'saved'`        — the user's own per-user production/sandbox creds.
   *   • `'env-fallback'` — the SHARED desk account off `process.env`. Only ever
   *                        reachable by the pinned operator.
   *   • `null`           — nothing resolved; no client constructs.
   */
  accountIdSource: 'saved' | 'env-fallback' | null;
  /** Masked last-4 of the EFFECTIVE account id; `null` when none resolves. */
  optionsAccountIdTail: string | null;
}

export interface LiveArmCensusReport {
  /**
   * Every resident book considered — the DENOMINATOR. Without it an empty
   * `books` array reads identically for "no live books on this host" and "the
   * context registry was empty / not built yet", which is the same
   * absence-has-no-state failure this census was filed against.
   */
  booksScanned: number;
  /** Rows: one per book resolving live on EITHER axis. Never elided. */
  books: LiveArmCensusRow[];
  /**
   * Rollups — published ALONGSIDE the rows, never instead. Each is a plain
   * count over `books`, so a reader can check it against the rows themselves.
   */
  rollup: {
    liveBookCount: number;
    /** Live books that are NOT the pinned operator — the cohort with no instrument before this. */
    nonOperatorLiveBookCount: number;
    /** Live books whose entry gate is OPEN — they can place an options order now. */
    armedCount: number;
    /** …of those, the ones pointed at the PRODUCTION env (real money). */
    realMoneyArmedCount: number;
    /** Live books drawing on the SHARED desk account rather than their own. */
    sharedAccountCount: number;
    /** Books whose durable and runtime mode disagree (TRA-2649 split-brain). */
    modeDisagreementCount: number;
    /** Books whose derived and runtime client states disagree. */
    clientDisagreementCount: number;
  };
}

/** Masked last-4 only — matches the existing operator block's contract. */
function maskTail(accountId: string): string | null {
  if (accountId.length === 0) return null;
  return accountId.length >= 4 ? `***${accountId.slice(-4)}` : '***';
}

export function summarizeLiveArmCensus(
  books: LiveArmCensusBookInput[],
  env: NodeJS.ProcessEnv = process.env,
): LiveArmCensusReport {
  const rows: LiveArmCensusRow[] = [];
  for (const book of books) {
    const mode = book.settings.mode === 'live' ? 'live' : 'demo';
    // Cohort selection is deliberately the UNION of the two mode axes, never
    // the durable one alone. A book live on either axis is a book that may
    // place an order, and this census must never be the reason one is missed.
    if (mode !== 'live' && book.runtime.mode !== 'live') continue;
    const resolved = resolveLiveOptionsCreds(book.settings, book.username, env);
    // `optionsClientConfigured` mirrors buildTradierLiveClient, which gates on
    // the settings mode it is handed — not on the runtime mode.
    const optionsClientConfigured = mode === 'live' && resolved.credentialsResolved;
    // The gate the engine actually evaluates, from the engine's own state.
    const liveEntryGateOpen =
      book.runtime.mode === 'live' && book.runtime.optionsRouted && book.runtime.clientPresent;
    const accountIdSource: LiveArmCensusRow['accountIdSource'] = !resolved.credentialsResolved
      ? null
      : resolved.savedAccount
        ? 'saved'
        : 'env-fallback';
    rows.push({
      username: book.username,
      mode,
      runtimeMode: book.runtime.mode,
      modeDisagreement: mode !== book.runtime.mode,
      liveEntryGateOpen,
      clientPresent: book.runtime.clientPresent,
      clientDisagreement: optionsClientConfigured !== book.runtime.clientPresent,
      tradierEnv: resolved.env,
      optionsRouted: isLiveTradierOptionsEnabled(book.settings),
      prodKeySaved: (book.settings.liveApiKeyOptionsProduction ?? '').trim().length > 0,
      prodAccountSaved: (book.settings.liveAccountIdOptionsProduction ?? '').trim().length > 0,
      envFallbackAllowed: resolved.allowEnvFallback,
      optionsClientConfigured,
      realMoneyArmed: liveEntryGateOpen && resolved.env === 'production',
      accountIdSource,
      // Tail follows the CLIENT, not the creds: a book whose client would not
      // construct reports `null` even if a stray cred half-resolved, so the tail
      // never implies an arm that does not exist.
      optionsAccountIdTail: optionsClientConfigured ? maskTail(resolved.accountId) : null,
    });
  }
  return {
    booksScanned: books.length,
    books: rows,
    rollup: {
      liveBookCount: rows.length,
      nonOperatorLiveBookCount: rows.filter(r => !isLiveBrokerOperator(r.username, env)).length,
      armedCount: rows.filter(r => r.liveEntryGateOpen).length,
      realMoneyArmedCount: rows.filter(r => r.realMoneyArmed).length,
      sharedAccountCount: rows.filter(r => r.accountIdSource === 'env-fallback').length,
      modeDisagreementCount: rows.filter(r => r.modeDisagreement).length,
      /** Rows where the derived and runtime client states disagree. */
      clientDisagreementCount: rows.filter(r => r.clientDisagreement).length,
    },
  };
}
