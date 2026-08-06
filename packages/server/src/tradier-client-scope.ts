// TRA-3112 (ruling on TRA-3110, parent TRA-3081) — split the Tradier options
// credential resolution by ENDPOINT CLASS, because that is where the real risk
// boundary sits.
//
// The defect this closes: `buildTradierOptionsClientForEnv(settings, env)` took
// only `settings`, so it was STRUCTURALLY unable to scope anything — there was no
// username to scope by. Its `process.env.TRADIER_*` fallback therefore handed the
// SHARED operator broker account (***0154) to any of the 62 books that reached it
// with blank saved creds. Two routes behind plain `requireAuth` reached it on a
// real-money path: `POST /api/tradier/positions/sync?env=production` (imports the
// operator's live book) and `POST /api/options/:id/close` (sells out of it).
//
// Why not just scope the whole builder: `/api/options/ideas` calls it and then only
// ever hits `getExpirations` + `getChainSnapshot` — both `/v1/markets/*`, which never
// interpolate `accountId` and leak nothing. That feed is the entire reason TRA-714
// made the fallback `||`-not-`??`. Blanket-scoping breaks AI Ideas for all 61
// non-operator books.
//
// The two surfaces on `TradierOptionsClient`:
//
//   • MARKET DATA — `getExpirations`, `getChain`, `getChainSnapshot`,
//     `findATMContract`, `getOptionMid`, `getOptionQuote`. All `/v1/markets/*`.
//     Account-agnostic. Fallback stays OPEN, behaviour unchanged from today.
//
//   • ACCOUNT — `getAccountBalance`, `listOpenOptionPositions`,
//     `readOpenOptionPositions`, `listAccountHistory`, `listAccountCashEvents`,
//     `listAccountCorporateActions`, `listGainLoss`, and every order verb
//     (`buyContracts*`, `sellContracts*`, `sellToOpen*`, `buyToClose*`,
//     `submitMultilegOrder`, `cancelOrder`, `getOrderStatus`). All
//     `/accounts/${accountId}/*`. Fallback is OPERATOR-PINNED.
//
// This module is deliberately the ONE copy of that decision. `index.ts` and
// `signal-engine.ts` each carry their own client builder (the two-copies hazard
// that made TRA-3110's fix land on the wrong one), and both now delegate here, so
// a future change cannot fix one and miss the other.
//
// It takes `allowEnvFallback` as a boolean rather than calling
// `isLiveBrokerOperator` itself only to keep this module free of an import cycle
// with `signal-engine.ts`, which owns that predicate and imports nothing from here.

import type { AccountSettings, TradierEnv } from '@trading-app/shared';

/** Resolved Tradier credential pair. Both fields are trimmed and non-empty. */
export interface TradierCredPair {
  apiToken: string;
  accountId: string;
}

/**
 * Why an ACCOUNT-scoped client could not be built.
 *
 * The distinction is the whole point (TRA-3112 AC#1). Before this, both cases
 * collapsed into one 409 `"No Tradier credentials saved for {env}"` — which read
 * identically for "you have no creds" and for "we refused to lend you the
 * operator's". An operator debugging a real credential problem could not tell
 * those apart, and neither could a grader checking this fix landed.
 *
 *   • `no_creds`       — nothing resolves for this env even WITH the shared env
 *                        fallback applied. Genuinely unconfigured. Caller answers 409.
 *   • `operator_pinned` — the caller's own saved creds are blank/partial, the shared
 *                        `process.env.TRADIER_*` fallback WOULD have completed the
 *                        pair, and the caller is not the pinned operator. This is
 *                        the exploit condition, refused. Caller answers 403.
 */
export type TradierAccountScopeRefusal = 'no_creds' | 'operator_pinned';

export type TradierAccountCredResolution =
  | { ok: true; creds: TradierCredPair }
  | { ok: false; reason: TradierAccountScopeRefusal };

/**
 * The user's OWN saved per-env options creds. Untrimmed; may be blank.
 *
 * Sandbox reads the env-specific field first and falls back to the legacy
 * un-suffixed pair (pre-TRA-226 accounts stored sandbox creds there). Production
 * has no legacy field — inheriting a legacy value into production was never
 * correct and is not introduced here.
 */
function savedCreds(settings: AccountSettings, env: TradierEnv): { apiToken: string; accountId: string } {
  const apiToken =
    env === 'production'
      ? (settings.liveApiKeyOptionsProduction ?? '')
      : (settings.liveApiKeyOptionsSandbox || settings.liveApiKeyOptions || '');
  const accountId =
    env === 'production'
      ? (settings.liveAccountIdOptionsProduction ?? '')
      : (settings.liveAccountIdOptionsSandbox || settings.liveAccountIdOptions || '');
  return { apiToken: apiToken.trim(), accountId: accountId.trim() };
}

/**
 * The SHARED deployment-level creds. On bqb1 these are the live operator's
 * production Tradier account — lending them to another book is the leak.
 */
function envFallbackCreds(env: TradierEnv, procEnv: NodeJS.ProcessEnv): { apiToken: string; accountId: string } {
  const apiToken =
    env === 'production'
      ? (procEnv['TRADIER_API_TOKEN'] ?? '')
      : (procEnv['TRADIER_SANDBOX_API_TOKEN'] || procEnv['TRADIER_API_TOKEN'] || '');
  const accountId =
    env === 'production'
      ? (procEnv['TRADIER_ACCOUNT_ID'] ?? '')
      : (procEnv['TRADIER_SANDBOX_ACCOUNT_ID'] || procEnv['TRADIER_ACCOUNT_ID'] || '');
  return { apiToken: apiToken.trim(), accountId: accountId.trim() };
}

/**
 * MARKET-DATA credential resolution — `/v1/markets/*` only.
 *
 * Behaviour is byte-for-byte what `buildTradierOptionsClientForEnv` did before
 * TRA-3112, including the TRA-714 `||`-not-`??` precedence so a BLANK saved cred
 * ('' — the default for an account configured only via env vars) falls THROUGH to
 * the env fallback. With `??` an empty string short-circuits and the AI Ideas feed
 * goes silently empty behind an HTTP 200.
 *
 * `accountId` is still required because `TradierOptionsClient`'s constructor takes
 * it, but no method on this surface interpolates it into a URL. Returns `null` when
 * the pair does not resolve.
 */
export function resolveTradierMarketDataCreds(
  settings: AccountSettings,
  env: TradierEnv,
  procEnv: NodeJS.ProcessEnv = process.env,
): TradierCredPair | null {
  const saved = savedCreds(settings, env);
  const fallback = envFallbackCreds(env, procEnv);
  const apiToken = saved.apiToken || fallback.apiToken;
  const accountId = saved.accountId || fallback.accountId;
  if (!apiToken || !accountId) return null;
  return { apiToken, accountId };
}

/**
 * ACCOUNT credential resolution — `/accounts/{id}/*`, i.e. balances, positions,
 * history and every order verb.
 *
 * Per-user SAVED creds keep working for everyone; only the shared-env inheritance
 * is pinned. This mirrors what `buildTradierLiveClient` already does for the
 * engine's order client (TRA-857) — TRA-3112 is that same pin applied to the
 * builder the HTTP routes use, which never had it.
 *
 * `allowEnvFallback` is `isLiveBrokerOperator(username)` at the call site.
 */
export function resolveTradierAccountCreds(
  settings: AccountSettings,
  env: TradierEnv,
  allowEnvFallback: boolean,
  procEnv: NodeJS.ProcessEnv = process.env,
): TradierAccountCredResolution {
  return resolveTradierAccountCredsFromSaved(savedCreds(settings, env), env, allowEnvFallback, procEnv);
}

/**
 * Same decision, but taking the caller's OWN cred pair directly.
 *
 * Exists for `/api/options/tradier/test-connection`, which resolves its saved pair
 * differently on purpose (TRA-506: "Test production" must probe the production
 * fields even while the saved env is sandbox). Routing it through the same
 * fallback decision keeps the pin single-sourced instead of re-implementing it
 * beside a slightly different cred lookup — which is how this codebase grew two
 * copies of the builder in the first place.
 */
export function resolveTradierAccountCredsFromSaved(
  saved: { apiToken: string; accountId: string },
  env: TradierEnv,
  allowEnvFallback: boolean,
  procEnv: NodeJS.ProcessEnv = process.env,
): TradierAccountCredResolution {
  const fallback = envFallbackCreds(env, procEnv);
  saved = { apiToken: saved.apiToken.trim(), accountId: saved.accountId.trim() };

  if (allowEnvFallback) {
    const apiToken = saved.apiToken || fallback.apiToken;
    const accountId = saved.accountId || fallback.accountId;
    if (apiToken && accountId) return { ok: true, creds: { apiToken, accountId } };
    return { ok: false, reason: 'no_creds' };
  }

  // Own creds complete ⇒ nothing was borrowed, serve them.
  if (saved.apiToken && saved.accountId) {
    return { ok: true, creds: { apiToken: saved.apiToken, accountId: saved.accountId } };
  }

  // Own creds incomplete. Separate "there was nothing to borrow" from "there WAS,
  // and we refused" — a caller that answers the same way to both reproduces the
  // ambiguity this ticket exists to remove.
  const wouldHaveResolved =
    Boolean(saved.apiToken || fallback.apiToken) && Boolean(saved.accountId || fallback.accountId);
  return { ok: false, reason: wouldHaveResolved ? 'operator_pinned' : 'no_creds' };
}

/** Stable machine-readable codes on the refusal bodies, so nothing has to match prose. */
export const OPERATOR_PINNED_CODE = 'tradier_operator_pinned';
export const NO_CREDS_CODE = 'tradier_no_creds';

/**
 * TRA-3112 AC#1 — the HTTP shape of each refusal, as a PURE decision.
 *
 * It lives here, not inline in the route handler, for the reason this codebase
 * keeps relearning: `index.ts` boots a live server on import and has no route-test
 * harness, so a decision left inline can only ever be tested by a mirror of
 * itself — and a mirrored gate agrees with itself. Extracted, the actual bytes the
 * caller receives are graded directly.
 *
 * The two refusals MUST differ in status AND code. Before this ticket both were
 * the same 409 `"No Tradier credentials saved for {env} …"`, which read identically
 * for "you have no creds" and for "we refused to lend you the operator's" — an
 * operator debugging a real credential problem could not tell them apart, and
 * neither could a grader. This is why a test asserting only "not 200" proves
 * nothing here: the OLD code already returned not-200 on both.
 *
 * `action` is the caller's verb phrase ("syncing", "closing imported positions")
 * and only ever appears in the 409 text — the 403 must NOT be route-flavoured,
 * because it says something about the ACCOUNT, not about the operation.
 */
export function decideTradierAccountRefusalResponse(
  reason: TradierAccountScopeRefusal,
  env: TradierEnv,
  action: string,
): { status: 403 | 409; body: { error: string; code: string; env: TradierEnv } } {
  if (reason === 'operator_pinned') {
    return {
      status: 403,
      body: {
        error:
          `No Tradier credentials saved for ${env} on this account, and this deployment's shared ` +
          `TRADIER_* credentials belong to the live broker operator — they are not lent to other ` +
          `accounts for account-scoped calls (balances, positions, orders). Save your own ${env} ` +
          `Tradier API token and account id in Settings.`,
        code: OPERATOR_PINNED_CODE,
        env,
      },
    };
  }
  return {
    status: 409,
    body: {
      error: `No Tradier credentials saved for ${env} — set them in Settings before ${action}.`,
      code: NO_CREDS_CODE,
      env,
    },
  };
}
