// TRA-3112 — pin the Tradier env-var cred fallback to the operator for
// ACCOUNT-scoped calls, leave it OPEN for market-data.
//
// The defect (TRA-3110, parent TRA-3081): `buildTradierOptionsClientForEnv`
// took only `settings`, so it was STRUCTURALLY unable to scope its
// `process.env.TRADIER_*` fallback — there was no username to scope by. Any of
// the 62 authenticated books with blank saved creds got a client pointed at the
// SHARED operator broker account (***0154). Two routes behind plain `requireAuth`
// reached it on a real-money path:
//
//   A. `POST /api/tradier/positions/sync?env=production` — imports the operator's
//      live book as your own rows. `env` is read off the QUERY STRING, overriding
//      the caller's saved `liveTradierEnvOptions`, so `mode` is not a gate.
//   B. `POST /api/options/:id/close` — sells an imported row back out. Needs
//      neither `autoManageImportedTradierOptions` nor the engine nor any
//      background reconciler: sync-then-close was a two-POST manual path for any
//      account to trade the operator's live book.
//
// ── What "a broken one looks like" ─────────────────────────────────────────────
// This whole file is written against the recurring failure in this codebase: an
// instrument that reads IDENTICALLY in pass and fail state. Three concrete traps
// are graded here rather than assumed away:
//
//   1. The OLD code already returned NOT-200 on the exploit path — it answered a
//      generic 409. So `expect(status).not.toBe(200)` passes against the
//      unfixed build and proves nothing. Every refusal test below asserts the
//      SPECIFIC status AND code, and one test asserts the two refusals DIFFER.
//   2. A guard that refuses EVERYONE would pass every refusal test in this file.
//      The negative control (AC#4) is therefore mandatory, not decorative.
//   3. A market-data client that resolves to `null` produces an EMPTY AI Ideas
//      feed behind an HTTP 200 — the TRA-714 regression. The positive control
//      (AC#3) asserts the client RESOLVES, and is paired with a vacuity check
//      proving that answer is not trivially true on these inputs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import type { AccountSettings } from '@trading-app/shared';
import {
  resolveTradierMarketDataCreds,
  resolveTradierAccountCreds,
  decideTradierAccountRefusalResponse,
  OPERATOR_PINNED_CODE,
  NO_CREDS_CODE,
} from './tradier-client-scope.js';
import { isLiveBrokerOperator } from './signal-engine.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const OPERATOR = 'admin';
const OTHER_BOOK = 'richard';

/** bqb1's real shape: shared deployment creds present, pointed at the live book. */
const DEPLOY_ENV: NodeJS.ProcessEnv = {
  LIVE_EQUITY_BOOT_USER: OPERATOR,
  TRADIER_API_TOKEN: 'shared-operator-token',
  TRADIER_ACCOUNT_ID: '6YA10154',
};

/** No shared creds at all — a checkout with a bare .env. */
const BARE_ENV: NodeJS.ProcessEnv = { LIVE_EQUITY_BOOT_USER: OPERATOR };

/** A book that has never entered Tradier creds. Every field blank, as saved. */
const BLANK: AccountSettings = { ...DEFAULT_ACCOUNT_SETTINGS };

/** A book with its OWN production creds — the case the pin must NOT touch. */
const OWN_PROD_CREDS: AccountSettings = {
  ...DEFAULT_ACCOUNT_SETTINGS,
  liveApiKeyOptionsProduction: 'richards-own-token',
  liveAccountIdOptionsProduction: '6YA99999',
};

const allow = (username: string, env: NodeJS.ProcessEnv): boolean =>
  isLiveBrokerOperator(username, env);

describe('TRA-3112 — account surface is operator-pinned', () => {
  it('REFUSES a non-operator with blank saved creds, and names WHY (AC#1)', () => {
    const r = resolveTradierAccountCreds(BLANK, 'production', allow(OTHER_BOOK, DEPLOY_ENV), DEPLOY_ENV);
    expect(r.ok).toBe(false);
    // Not merely "refused" — refused for the reason that separates this from a
    // genuinely unconfigured account. This is the whole discriminator.
    expect(r).toEqual({ ok: false, reason: 'operator_pinned' });
  });

  it('this is the exploit path: the SAME inputs USED to resolve the operator account', () => {
    // The pre-TRA-3112 builder is exactly `allowEnvFallback = true`. Reproducing
    // it here is the positive control ON THE DEFECT — without it, the refusal
    // above could be passing because the env fallback never had anything to lend,
    // which would make the guard vacuous.
    const unpinned = resolveTradierAccountCreds(BLANK, 'production', true, DEPLOY_ENV);
    expect(unpinned).toEqual({
      ok: true,
      creds: { apiToken: 'shared-operator-token', accountId: '6YA10154' },
    });
  });

  it('NEGATIVE CONTROL (AC#4): the operator still resolves production normally', () => {
    // A guard that refuses everyone is not a fix, and every refusal test in this
    // file would still pass under one.
    const r = resolveTradierAccountCreds(BLANK, 'production', allow(OPERATOR, DEPLOY_ENV), DEPLOY_ENV);
    expect(r).toEqual({
      ok: true,
      creds: { apiToken: 'shared-operator-token', accountId: '6YA10154' },
    });
  });

  it("a non-operator's OWN saved creds keep working — only the shared env is pinned", () => {
    const r = resolveTradierAccountCreds(
      OWN_PROD_CREDS,
      'production',
      allow(OTHER_BOOK, DEPLOY_ENV),
      DEPLOY_ENV,
    );
    expect(r).toEqual({
      ok: true,
      creds: { apiToken: 'richards-own-token', accountId: '6YA99999' },
    });
  });

  it('a non-operator with NO shared creds to borrow gets `no_creds`, not `operator_pinned`', () => {
    // Same caller, same blank settings — only the deployment differs. If this
    // returned `operator_pinned` the 403 would fire on hosts where nothing was
    // ever lendable, which is a false accusation and un-actionable advice.
    const r = resolveTradierAccountCreds(BLANK, 'production', allow(OTHER_BOOK, BARE_ENV), BARE_ENV);
    expect(r).toEqual({ ok: false, reason: 'no_creds' });
  });

  it('a PARTIAL shared fallback (token but no account id) is `no_creds`', () => {
    // Nothing complete could have been borrowed, so nothing was refused.
    const partial: NodeJS.ProcessEnv = {
      LIVE_EQUITY_BOOT_USER: OPERATOR,
      TRADIER_API_TOKEN: 'shared-operator-token',
    };
    expect(resolveTradierAccountCreds(BLANK, 'production', allow(OTHER_BOOK, partial), partial)).toEqual({
      ok: false,
      reason: 'no_creds',
    });
  });

  it('the operator with no creds anywhere still gets `no_creds` (the pin is not a mask)', () => {
    expect(resolveTradierAccountCreds(BLANK, 'production', allow(OPERATOR, BARE_ENV), BARE_ENV)).toEqual({
      ok: false,
      reason: 'no_creds',
    });
  });

  it('an UNSET operator pin disarms the fallback for everyone, including "admin"', () => {
    // TRA-857 semantics, re-asserted here because the account surface now depends
    // on them: a blank `LIVE_EQUITY_BOOT_USER` means no user is the operator.
    const unpinned: NodeJS.ProcessEnv = { ...DEPLOY_ENV, LIVE_EQUITY_BOOT_USER: '' };
    expect(resolveTradierAccountCreds(BLANK, 'production', allow(OPERATOR, unpinned), unpinned)).toEqual({
      ok: false,
      reason: 'operator_pinned',
    });
  });

  it('SANDBOX is pinned too — the leak class is the shared account, not the env name', () => {
    const sandboxEnv: NodeJS.ProcessEnv = {
      LIVE_EQUITY_BOOT_USER: OPERATOR,
      TRADIER_SANDBOX_API_TOKEN: 'shared-sandbox-token',
      TRADIER_SANDBOX_ACCOUNT_ID: 'VA00000',
    };
    expect(
      resolveTradierAccountCreds(BLANK, 'sandbox', allow(OTHER_BOOK, sandboxEnv), sandboxEnv),
    ).toEqual({ ok: false, reason: 'operator_pinned' });
    expect(resolveTradierAccountCreds(BLANK, 'sandbox', allow(OPERATOR, sandboxEnv), sandboxEnv).ok).toBe(
      true,
    );
  });
});

describe('TRA-3112 — market-data surface stays OPEN (AC#3 positive control)', () => {
  it('a non-operator book with BLANK saved creds STILL resolves a market-data client', () => {
    // ⛔ This is the control that catches over-scoping. `/api/options/ideas` calls
    // only `getExpirations` + `getChainSnapshot` — both `/v1/markets/*`, which never
    // interpolate `accountId`. If this returned null the feed would come back EMPTY
    // behind an HTTP 200 for all 61 non-operator books: the exact TRA-714 regression,
    // and a false pass for anyone asserting only "HTTP 200".
    const creds = resolveTradierMarketDataCreds(BLANK, 'production', DEPLOY_ENV);
    expect(creds).not.toBeNull();
    expect(creds).toEqual({ apiToken: 'shared-operator-token', accountId: '6YA10154' });
  });

  it('...and that control is NOT vacuous: the same inputs are refused on the account surface', () => {
    // Without this pairing, the test above would keep passing if someone deleted
    // the pin entirely — "market data works" is also what NO GUARD looks like.
    expect(resolveTradierMarketDataCreds(BLANK, 'production', DEPLOY_ENV)).not.toBeNull();
    expect(
      resolveTradierAccountCreds(BLANK, 'production', allow(OTHER_BOOK, DEPLOY_ENV), DEPLOY_ENV).ok,
    ).toBe(false);
  });

  it('preserves TRA-714: a BLANK saved cred falls THROUGH to the env fallback', () => {
    // `||` not `??`. With `??` an empty-string field short-circuits, the fallback
    // never runs, and the feed is stuck on "no Tradier options credentials" even
    // with TRADIER_* set. `DEFAULT_ACCOUNT_SETTINGS` stores '' (not undefined),
    // which is precisely the case `??` gets wrong.
    expect(BLANK.liveApiKeyOptionsProduction).toBe('');
    expect(resolveTradierMarketDataCreds(BLANK, 'production', DEPLOY_ENV)?.apiToken).toBe(
      'shared-operator-token',
    );
  });

  it('sandbox market-data falls back through the legacy un-suffixed pair', () => {
    const legacy: AccountSettings = {
      ...DEFAULT_ACCOUNT_SETTINGS,
      liveApiKeyOptions: 'legacy-token',
      liveAccountIdOptions: 'VA12345',
    };
    expect(resolveTradierMarketDataCreds(legacy, 'sandbox', BARE_ENV)).toEqual({
      apiToken: 'legacy-token',
      accountId: 'VA12345',
    });
  });

  it('returns null when nothing resolves at all', () => {
    expect(resolveTradierMarketDataCreds(BLANK, 'production', BARE_ENV)).toBeNull();
  });
});

describe('TRA-3112 — the two refusals are DISTINGUISHABLE (AC#1)', () => {
  const pinned = decideTradierAccountRefusalResponse('operator_pinned', 'production', 'syncing');
  const none = decideTradierAccountRefusalResponse('no_creds', 'production', 'syncing');

  it('operator_pinned is a 403 with its own code', () => {
    expect(pinned.status).toBe(403);
    expect(pinned.body.code).toBe(OPERATOR_PINNED_CODE);
    expect(pinned.body.env).toBe('production');
  });

  it('no_creds keeps the 409 and its own code', () => {
    expect(none.status).toBe(409);
    expect(none.body.code).toBe(NO_CREDS_CODE);
  });

  it('⛔ they differ in status, code AND text — "not 200" would pass on the OLD build', () => {
    // The pre-fix code answered 409 `"No Tradier credentials saved for production
    // — set them in Settings before syncing."` on BOTH. A grader (or an operator
    // debugging a real credential problem) could not tell them apart. That is the
    // defect; this assertion is the fix.
    expect(pinned.status).not.toBe(none.status);
    expect(pinned.body.code).not.toBe(none.body.code);
    expect(pinned.body.error).not.toBe(none.body.error);
  });

  it('the 403 explains it is the OPERATOR pin, not a missing-cred problem', () => {
    expect(pinned.body.error).toMatch(/live broker operator/i);
    expect(pinned.body.error).toMatch(/not lent/i);
  });

  it('the 409 keeps the original actionable text, per route verb', () => {
    expect(none.body.error).toBe(
      'No Tradier credentials saved for production — set them in Settings before syncing.',
    );
    expect(
      decideTradierAccountRefusalResponse('no_creds', 'sandbox', 'closing imported positions').body.error,
    ).toBe(
      'No Tradier credentials saved for sandbox — set them in Settings before closing imported positions.',
    );
  });

  it('the 403 is NOT route-flavoured — it is a statement about the account', () => {
    const a = decideTradierAccountRefusalResponse('operator_pinned', 'production', 'syncing');
    const b = decideTradierAccountRefusalResponse(
      'operator_pinned',
      'production',
      'closing imported positions',
    );
    expect(a.body.error).toBe(b.body.error);
  });
});

// ── Call-site wiring ─────────────────────────────────────────────────────────
//
// ⛔ These read SOURCE, deliberately. `index.ts` boots an HTTP server on import
// and there is no route-test harness in this package, so the resolver tests above
// cannot see which builder a route actually calls — and "the resolver is correct"
// is exactly what a build with the ideas route repointed at the ACCOUNT builder
// (empty feed, HTTP 200) would also look like. TRA-3110's whole lesson is that a
// fix on the wrong copy of a symbol reads as fixed; these assertions are what
// makes that visible instead of silent.
describe('TRA-3112 — call sites are wired to the right surface (AC#5)', () => {
  const src = (f: string): string => readFileSync(join(HERE, f), 'utf-8');
  const indexSrc = src('index.ts');
  const engineSrc = src('signal-engine.ts');

  it('the un-scoped builder is GONE from both copies', () => {
    // Comments and doc references are allowed; a definition or a call is not.
    expect(indexSrc).not.toMatch(/^\s*(?:const\s+\w+\s*=\s*)?buildTradierOptionsClientForEnv\(/m);
    expect(indexSrc).not.toMatch(/^function buildTradierOptionsClientForEnv\(/m);
    expect(engineSrc).not.toMatch(/^function buildTradierOptionsClientForEnv\(/m);
    expect(engineSrc).not.toMatch(/buildTradierOptionsClientForEnv\(/);
  });

  it('no un-pinned `process.env[\'TRADIER_*\']` CRED read survives on an account path (AC#5)', () => {
    // AC#5's grep, as an assertion — with an explicit, justified allow-list rather
    // than a blanket zero, because several remaining reads are legitimately
    // account-agnostic and a test that demanded zero would be wrong and would get
    // deleted. Anything NOT on this list is a new un-pinned cred read and fails.
    //
    // Running this grep is what surfaced the THIRD leaking route
    // (`/api/options/tradier/test-connection`), which TRA-3110's write-up and this
    // ticket's ruling both missed. That is the point of grading the grep instead of
    // grading the two known call sites.
    const ALLOWED: { file: 'index.ts' | 'signal-engine.ts'; near: string; why: string }[] = [
      {
        file: 'index.ts',
        near: 'TradierRelativeValueScannerService',
        why: 'deployment-level RV scanner singleton — no per-user boundary exists on it at all',
      },
      {
        file: 'index.ts',
        near: 'runChainRecord',
        why: "market-data chain recorder; accountId is the literal placeholder 'recorder-readonly'",
      },
      {
        file: 'index.ts',
        near: 'resolveSandboxTradierCreds',
        why: 'sandbox-pinned by construction and documented as NEVER falling back to the production pair',
      },
      {
        file: 'signal-engine.ts',
        near: 'buildTradierLiveClient',
        why: 'already operator-pinned via allowEnvFallback (TRA-857)',
      },
      {
        file: 'signal-engine.ts',
        near: 'buildTradierLiveEquityClient',
        why: 'already operator-pinned via allowEnvFallback (TRA-857)',
      },
      {
        file: 'index.ts',
        near: 'allowEnvFallback',
        why: 'the TRA-857 replication in the live-broker arm-drift diagnostic; already pinned',
      },
    ];
    // Cred reads only. `TRADIER_ENV` is a label, and a PRESENCE PROBE
    // (`!!process.env[…]`, `Boolean(…)`, `.trim().length > 0`) yields a boolean —
    // it cannot construct a client and leaks nothing but "configured: true".
    const isCredRead = (l: string): boolean =>
      /process\.env\['TRADIER_(API_TOKEN|ACCOUNT_ID|SANDBOX_API_TOKEN|SANDBOX_ACCOUNT_ID)'\]/.test(l)
      && !/!!process\.env|Boolean\(process\.env|_set:|\.length > 0/.test(l);

    for (const [name, text] of [
      ['index.ts', indexSrc],
      ['signal-engine.ts', engineSrc],
    ] as const) {
      const lines = text.split('\n');
      const unexplained: string[] = [];
      for (const [i, line] of lines.entries()) {
        if (!isCredRead(line)) continue;
        // Attribute the hit to the nearest allow-listed construct. The window spans
        // BOTH directions: the RV-scanner pair is read into module-level consts a
        // few lines ABOVE the service that consumes them, so a backward-only scan
        // would report it as unexplained.
        const window = lines.slice(Math.max(0, i - 60), i + 20).join('\n');
        const excused = ALLOWED.some((a) => a.file === name && window.includes(a.near));
        if (!excused) unexplained.push(`${name}:${i + 1}  ${line.trim()}`);
      }
      expect(
        unexplained,
        `${name} has an un-pinned TRADIER_* cred read with no allow-list entry`,
      ).toEqual([]);
    }
  });

  it('/api/options/tradier/test-connection is pinned too (the third route, found by AC#5)', () => {
    // It GETs /v1/user/profile then `getAccountBalance()` and answers with the
    // account number, status, classification and BUYING POWER IN DOLLARS — behind
    // `requireAuth` alone. Read-only, which is why it stayed open: nothing about
    // the response looks unusual.
    const route = indexSrc.slice(indexSrc.indexOf("app.post('/api/options/tradier/test-connection'"));
    const body = route.slice(0, route.indexOf('profileResp = await fetch('));
    expect(body).toMatch(/resolveTradierAccountCredsFromSaved\(/);
    expect(body).toMatch(/isLiveBrokerOperator\(username\)/);
  });

  it('BOTH account builders actually apply the pin (not just import the resolver)', () => {
    // The resolver takes `allowEnvFallback` as a plain boolean, so a builder that
    // passed `true` would compile, typecheck, and behave EXACTLY like the pre-fix
    // code — while every resolver test above kept passing, because those pass the
    // flag themselves. This is the assertion that ties the two together.
    expect(indexSrc).toMatch(
      /resolveTradierAccountCreds\(settings, env, isLiveBrokerOperator\(username\)\)/,
    );
    expect(engineSrc).toMatch(
      /resolveTradierAccountCreds\(settings, env, isLiveBrokerOperator\(username\)\)/,
    );
    for (const [name, text] of [
      ['index.ts', indexSrc],
      ['signal-engine.ts', engineSrc],
    ] as const) {
      expect(text, `${name} hard-codes an allowEnvFallback=true on the account surface`).not.toMatch(
        /resolveTradierAccountCreds(FromSaved)?\([^)]*,\s*true\s*[,)]/,
      );
    }
  });

  it('/api/options/ideas uses the MARKET-DATA builder (AC#3, the over-scoping trap)', () => {
    const route = indexSrc.slice(indexSrc.indexOf("app.get('/api/options/ideas'"));
    const body = route.slice(0, route.indexOf('buildIdeasFeed('));
    expect(body).toMatch(/buildTradierMarketDataClientForEnv\(/);
    expect(body).not.toMatch(/buildTradierAccountClientForEnv\(|resolveTradierAccountClientForEnv\(/);
  });

  it('/api/tradier/positions/sync uses the ACCOUNT resolver (item A)', () => {
    const route = indexSrc.slice(indexSrc.indexOf("app.post('/api/tradier/positions/sync'"));
    const body = route.slice(0, route.indexOf('positions = await client.listOpenOptionPositions()'));
    expect(body).toMatch(/resolveTradierAccountClientForEnv\(settings, env, username\)/);
    expect(body).toMatch(/respondTradierAccountRefusal\(/);
    expect(body).not.toMatch(/buildTradierMarketDataClientForEnv\(/);
  });

  it('/api/options/:id/close uses the ACCOUNT resolver on the imported path (item B)', () => {
    const route = indexSrc.slice(indexSrc.indexOf("app.post('/api/options/:id/close'"));
    const body = route.slice(0, route.indexOf('submitSmartSellToClose('));
    expect(body).toMatch(/resolveTradierAccountClientForEnv\(settings, imported\.env, username\)/);
    expect(body).toMatch(/respondTradierAccountRefusal\(/);
    expect(body).not.toMatch(/buildTradierMarketDataClientForEnv\(/);
  });

  it("the engine's per-env clients are rebuilt once the username binds (AC#4 code path)", () => {
    // Built at construction, `alertUsername` is undefined ⇒ non-operator ⇒ null.
    // Without the rebuild in `setAlertUsername` the OPERATOR's own reconcilers sit
    // dark until the next settings save — a guard that refuses everyone, which
    // every refusal test above would happily pass.
    const bind = engineSrc.slice(engineSrc.indexOf('setAlertUsername(username: string): void {'));
    const scope = bind.slice(0, bind.indexOf('private alertMode()'));
    expect(scope).toMatch(/this\.tradierOptionsClientByEnv = buildTradierOptionsClientsByEnv\(\s*this\.lastSettings,\s*username,?\s*\)/);
  });

  it('every buildTradierOptionsClientsByEnv call passes a username', () => {
    const calls = engineSrc.match(/buildTradierOptionsClientsByEnv\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) {
      if (c.includes('username: string')) continue; // the declaration's params
      expect(c, `${c} drops the username and silently un-pins`).toMatch(/,/);
    }
  });
});

// ── Item 3: the unconditional `'live'` stamp ─────────────────────────────────
describe("TRA-3112 item 3 — a sandbox import is distinguishable from a production one", () => {
  it("the sync route still stamps mode 'live' unconditionally — option (a) was NOT taken", () => {
    const indexSrc = readFileSync(join(HERE, 'index.ts'), 'utf-8');
    expect(indexSrc).toMatch(/ctx\.engine\.reconcileTradierPositions\(env, positions, 'live'\)/);
  });

  it("...and the row carries the resolved env as `tradierEnv`, which is the partition key", () => {
    // Option (b), satisfied by the field that already exists rather than by a
    // duplicate. `reconcileTradierPositions` mints every imported row with
    // `tradierEnv: this.tradierEnv`, and `this.tradierEnv` is fixed per bucket
    // ('sandbox' / 'production') at engine construction — the same `env` the sync
    // route resolved and indexed `optionsAccounts[env]` with.
    //
    // Graded on source for the same reason as the block above: constructing a live
    // `SignalEngine` here would boot timers and quote feeds. The behavioural half
    // (`tradierEnv` present on a minted import) is already covered by
    // `options-account.test.ts`; what is NOT otherwise asserted anywhere is that
    // the two facts sit on the same row, which is what makes `mode` unusable as a
    // census key and `tradierEnv` usable.
    const acct = readFileSync(join(HERE, 'options-account.ts'), 'utf-8');
    const mint = acct.slice(acct.indexOf('importedFromTradier: true,'));
    expect(mint.slice(0, 200)).toMatch(/tradierEnv \? \{ tradierEnv: this\.tradierEnv \}/);

    const engineSrc = readFileSync(join(HERE, 'signal-engine.ts'), 'utf-8');
    expect(engineSrc).toMatch(/tradierEnv: 'sandbox',/);
    expect(engineSrc).toMatch(/tradierEnv: 'production',/);
  });

  it('the trap is written down where a census author will hit it', () => {
    // A census partitioning imported rows on `mode` reads perfectly clean while
    // production imports sit on non-operator books. The warning lives on the field
    // itself, not in a ticket nobody re-reads.
    const shared = readFileSync(
      join(HERE, '..', '..', 'shared', 'src', 'index.ts'),
      'utf-8',
    );
    expect(shared).toMatch(/TRA-3112 item 3 — ON AN IMPORTED ROW THIS IS THE ONLY HONEST ENV FIELD/);
    expect(shared).toMatch(/never on `mode`/);
  });
});
