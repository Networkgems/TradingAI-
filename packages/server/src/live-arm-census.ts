import type { AccountSettings, TradierEnv } from '@trading-app/shared';
import { isLiveTradierOptionsEnabled } from '@trading-app/shared';
import { resolveLiveOptionsCreds, isLiveBrokerOperator } from './signal-engine.js';
// TRA-3905 — the broker-OUTCOME fold. Every field this census owns is a fact
// about OUR side of the seam and all of them were true for the book the broker
// refused 25 times; the join below is the only thing on this report that can
// disagree with them.
import { summarizeBrokerSubmitCensus } from './broker-submit-census.js';
import type { BrokerSubmitCensusRow } from './broker-submit-census.js';

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
 *    `optionsClientConfigured: false` — never omitted. Before this, the only
 *    trace such a book left was
 *    `log.warn('live OTM bounded test: no balance snapshot')`, which carried no
 *    username and so could not be attributed to a book at all.
 * 3. **TRA-3119 — the per-book {@link LiveArmCensusRow.optionsAccountIdTail} is
 *    the point, not a garnish.** `liveUnmanagedRisk` was the standing candidate
 *    for "is a foreign account in play" and cannot answer it:
 *    `summarizeLiveUnmanagedRisk` walks OUR engines' book rows, so a fill
 *    sitting in the desk's Tradier account that no engine holds a row for is
 *    invisible to it by construction, and its `{total: 0}` reads identically
 *    clean either way. Nor is there a read-only way to ask the broker — both
 *    `/api/tradier/positions/sync` routes are POSTs that mutate the book. The
 *    tail is therefore the only server-side fact that separates two books both
 *    reporting `credsSaved: true`, and it must be present on EVERY row whose
 *    creds resolve.
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
  /**
   * Masked last-4 of the EFFECTIVE account id — WHICH account, where
   * {@link accountIdSource} says only WHOSE. `null` exactly when no credential
   * pair resolves, i.e. it is non-null ⇔ `accountIdSource !== null`.
   *
   * TRA-3119 promoted this from supporting detail to THE load-bearing field:
   * two live books both reporting `prodKeySaved`/`prodAccountSaved: true` are
   * the pass and the fail state of "is a second book pointed at the desk's
   * money", and nothing else on this row separates them.
   *
   * It deliberately does NOT gate on {@link optionsClientConfigured}. It did
   * until TRA-3119, on the reasoning that a tail must never imply an arm that
   * does not exist — but the arm claim lives in its own explicit booleans
   * ({@link liveEntryGateOpen}, {@link realMoneyArmed}), so the tail was never
   * carrying it. What that gate actually did was blank the tail on the ONE row
   * where the account is hardest to find and matters most: the TRA-2649
   * split-brain, durable `demo` + runtime `live`, which reports
   * `realMoneyArmed: true` and `accountIdSource: 'saved'` and, under the old
   * rule, a `null` tail — a row asserting a book is trading its own real money
   * while refusing to name the account.
   */
  optionsAccountIdTail: string | null;
  /**
   * TRA-3905 — WHAT THE BROKER ACTUALLY DID with this book's orders today.
   *
   * Every OTHER field on this row is a fact about our own side of the seam:
   * creds, client, mode, routing. On 2026-08-20 all of them were `true` for
   * `v0nni` and matched `admin` cell for cell — while Tradier rejected 25 of her
   * 25 real-money orders for `Account is restricted for option trading`. Broker
   * approval is not knowable from anything we hold, so the only server-side
   * evidence is the outcome of having asked, and `submitted` vs `filled` is the
   * pair that separates the two books.
   *
   * `null` means the join DID NOT RUN (no `etDay` was supplied) — never "clean".
   * An unread instrument and a green one must not share a value; see
   * {@link LiveArmCensusReport.brokerOutcomesEtDay}.
   */
  brokerOutcome: BrokerSubmitCensusRow | null;
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
    /**
     * TRA-3905 — live books the permission breaker has HALTED today, and live
     * books whose broker outcome grades `red` (a permission reject seen, or the
     * breaker tripped). `null` when the broker join did not run — an unread
     * count must never render as `0`.
     */
    brokerPermissionBlockedCount: number | null;
    brokerRedBookCount: number | null;
  };
  /**
   * TRA-3905 — the ET day the {@link LiveArmCensusRow.brokerOutcome} join was
   * folded for, or `null` when no `etDay` was supplied and the join did not run.
   * This is the field that says whether the broker-outcome cells on this report
   * were MEASURED at all.
   */
  brokerOutcomesEtDay: string | null;
}

/** Masked last-4 only — matches the existing operator block's contract. */
function maskTail(accountId: string): string | null {
  if (accountId.length === 0) return null;
  return accountId.length >= 4 ? `***${accountId.slice(-4)}` : '***';
}

export function summarizeLiveArmCensus(
  books: LiveArmCensusBookInput[],
  env: NodeJS.ProcessEnv = process.env,
  /**
   * TRA-3905 — the ET day to fold broker outcomes for. Omitted ⇒ the join does
   * not run and every `brokerOutcome` is `null` (UNREAD), never a zero row: a
   * caller that forgot to pass it must not get a clean-looking report.
   */
  etDay: string | null = null,
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
      // TRA-3119 — tail follows the CREDS, on the same predicate as
      // `accountIdSource` above, so the two can never disagree: a row that
      // names WHOSE account always names WHICH. `credentialsResolved` already
      // requires a non-empty account id, so this is non-null exactly when
      // `accountIdSource` is.
      optionsAccountIdTail: resolved.credentialsResolved ? maskTail(resolved.accountId) : null,
      // Filled in below — the roster it folds over is not known until every row
      // has been built.
      brokerOutcome: null,
    });
  }
  // TRA-3905 — join the broker-outcome fold onto the rows. The roster is EVERY
  // row in this cohort, not just the armed ones: a book that placed orders this
  // morning and was disarmed since is exactly the history a reader needs, and
  // `summarizeBrokerSubmitCensus` unions the roster with the day's activity so
  // neither direction can erase the other.
  const brokerCensus = etDay === null ? null : summarizeBrokerSubmitCensus(etDay, rows.map(r => r.username));
  if (brokerCensus) {
    const byBook = new Map(brokerCensus.books.map(b => [b.book, b]));
    for (const row of rows) {
      // Non-null for every row: the roster above guarantees a zero-filled cell
      // exists for each. A missing one would be the absent-reads-clean shape.
      row.brokerOutcome = byBook.get(row.username) ?? null;
    }
  }
  return {
    booksScanned: books.length,
    books: rows,
    brokerOutcomesEtDay: brokerCensus?.etDay ?? null,
    rollup: {
      liveBookCount: rows.length,
      nonOperatorLiveBookCount: rows.filter(r => !isLiveBrokerOperator(r.username, env)).length,
      armedCount: rows.filter(r => r.liveEntryGateOpen).length,
      realMoneyArmedCount: rows.filter(r => r.realMoneyArmed).length,
      sharedAccountCount: rows.filter(r => r.accountIdSource === 'env-fallback').length,
      modeDisagreementCount: rows.filter(r => r.modeDisagreement).length,
      /** Rows where the derived and runtime client states disagree. */
      clientDisagreementCount: rows.filter(r => r.clientDisagreement).length,
      // TRA-3905 — `null`, not `0`, when the join did not run.
      brokerPermissionBlockedCount: brokerCensus
        ? rows.filter(r => r.brokerOutcome?.brokerPermissionBlocked === true).length
        : null,
      brokerRedBookCount: brokerCensus
        ? rows.filter(r => r.brokerOutcome?.verdict === 'red').length
        : null,
    },
  };
}
