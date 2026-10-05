// TRA-5127 (board ruling 2B on TRA-3925, card e550875f) — gate EVERY broker
// ORDER verb for non-operators; the per-user broker link is READ-ONLY.
//
// The defect this closes (undocumented until TRA-3925): TRA-3112 pinned the
// shared-env CRED fallback but deliberately kept SAVED per-user creds working
// for ACCOUNT verbs — orders included. A non-operator who pasted their own
// production token could `POST /api/options/:id/close` a real `sell_to_close`
// behind plain `requireAuth`. The CEO ruled that path inside the gate.
//
// Auth-boundary test class (TRA-3922 arm B): grade the exported DECISION
// directly, then grade the CALL-SITE WIRING on source — `index.ts` boots an
// HTTP server on import and has no route harness, and TRA-3110's lesson is
// that a fix on the wrong copy of a symbol reads as fixed. Three traps graded
// rather than assumed away:
//
//   1. The gate must refuse EVEN WITH valid saved creds — a build that merely
//      re-ran the TRA-3112 cred resolution would pass any "non-operator with
//      blank creds is refused" test while the pasted-token exploit stays open.
//      The creds-independence test pins this.
//   2. A gate that refuses EVERYONE would pass every refusal test here — the
//      operator positive control (AC2's second half) is mandatory.
//   3. A gate on the wrong branch breaks DEMO paper closes for all users (the
//      TRA-5126 per-user demo books need them) — the paper-path negative
//      controls pin that the demo fall-throughs carry no gate.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import type { AccountSettings } from '@trading-app/shared';
import {
  decideBrokerOrderVerbResponse,
  decideTradierAccountRefusalResponse,
  resolveTradierAccountCreds,
  BROKER_ORDER_OPERATOR_GATE_CODE,
  OPERATOR_PINNED_CODE,
  NO_CREDS_CODE,
} from './tradier-client-scope.js';
import { isLiveBrokerOperator } from './signal-engine.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const OPERATOR = 'admin';
const OTHER_BOOK = 'richard';

/** bqb1's real shape: pin set, shared deployment creds pointed at the live book. */
const DEPLOY_ENV: NodeJS.ProcessEnv = {
  LIVE_EQUITY_BOOT_USER: OPERATOR,
  TRADIER_API_TOKEN: 'shared-operator-token',
  TRADIER_ACCOUNT_ID: '6YA10154',
};

/** A role:'user' book that PASTED ITS OWN production token — the ruled-on case. */
const OWN_PROD_CREDS: AccountSettings = {
  ...DEFAULT_ACCOUNT_SETTINGS,
  liveApiKeyOptionsProduction: 'richards-own-token',
  liveAccountIdOptionsProduction: '6YA99999',
};

const gateFor = (username: string, env: NodeJS.ProcessEnv): ReturnType<typeof decideBrokerOrderVerbResponse> =>
  decideBrokerOrderVerbResponse(isLiveBrokerOperator(username, env));

describe('TRA-5127 — order verbs refuse every non-operator (AC2)', () => {
  it('a role:user book is refused 403 with the gate code', () => {
    const d = gateFor(OTHER_BOOK, DEPLOY_ENV);
    expect(d.allowed).toBe(false);
    if (d.allowed) throw new Error('unreachable');
    expect(d.status).toBe(403);
    expect(d.body.code).toBe(BROKER_ORDER_OPERATOR_GATE_CODE);
  });

  it('⛔ the refusal is about the VERB, not the creds: VALID saved creds still refuse', () => {
    // This is the discriminator against the pre-fix build. Under TRA-3112 the
    // same caller RESOLVES an account client off their own saved creds — and
    // that resolution must stay true (saved creds keep working for the
    // read-only mirror) while the ORDER verb refuses anyway.
    const creds = resolveTradierAccountCreds(
      OWN_PROD_CREDS,
      'production',
      isLiveBrokerOperator(OTHER_BOOK, DEPLOY_ENV),
      DEPLOY_ENV,
    );
    expect(creds.ok).toBe(true); // the mirror read would be served…
    expect(gateFor(OTHER_BOOK, DEPLOY_ENV).allowed).toBe(false); // …the order verb is not.
  });

  it('POSITIVE CONTROL: the operator passes the identical call', () => {
    // A gate that refuses everyone passes every refusal test in this file.
    expect(gateFor(OPERATOR, DEPLOY_ENV)).toEqual({ allowed: true });
  });

  it('a non-operator ADMIN-role name that is not the pin is still refused', () => {
    // The gate is the TRA-857 operator pin, not the role column: "non-operator"
    // includes a second admin-role login that is not LIVE_EQUITY_BOOT_USER.
    const pinnedElsewhere: NodeJS.ProcessEnv = { ...DEPLOY_ENV, LIVE_EQUITY_BOOT_USER: 'operator2' };
    expect(gateFor(OPERATOR, pinnedElsewhere).allowed).toBe(false);
    expect(gateFor('operator2', pinnedElsewhere).allowed).toBe(true);
  });
});

describe('TRA-5127 — operator pin unset disarms everyone (AC6)', () => {
  it('an explicitly EMPTY pin refuses the order verb for every caller, "admin" included', () => {
    const unpinned: NodeJS.ProcessEnv = { ...DEPLOY_ENV, LIVE_EQUITY_BOOT_USER: '' };
    expect(gateFor(OPERATOR, unpinned).allowed).toBe(false);
    expect(gateFor(OTHER_BOOK, unpinned).allowed).toBe(false);
  });

  it('an ABSENT pin keeps the board-ratified `admin` default (TRA-857) — AC6 is the explicit kill-switch', () => {
    // `LIVE_EQUITY_BOOT_USER=""` is the documented "clear this value" disarm;
    // an absent key defaults to `admin` (render.yaml, approval 979c77c1). If
    // this ever flips, AC6's meaning changed and this file must be re-ruled.
    expect(gateFor(OPERATOR, { TRADIER_API_TOKEN: 'x' }).allowed).toBe(true);
    expect(gateFor(OTHER_BOOK, { TRADIER_API_TOKEN: 'x' }).allowed).toBe(false);
  });
});

describe('TRA-5127 — the gate is distinguishable from both TRA-3112 refusals', () => {
  it('its code differs from operator_pinned AND no_creds', () => {
    expect(BROKER_ORDER_OPERATOR_GATE_CODE).not.toBe(OPERATOR_PINNED_CODE);
    expect(BROKER_ORDER_OPERATOR_GATE_CODE).not.toBe(NO_CREDS_CODE);
  });

  it('the 403 text says the link is read-only and names where reads still work', () => {
    const d = gateFor(OTHER_BOOK, DEPLOY_ENV);
    if (d.allowed) throw new Error('unreachable');
    expect(d.body.error).toMatch(/read-only/i);
    expect(d.body.error).toMatch(/positions sync|balances/i);
  });
});

describe('TRA-5127 — the kept verbs keep their TRA-3112 refusals (AC4 + AC5)', () => {
  it('AC4: env-fallback refusal stays 403 operator_pinned for a non-operator on ?env=production', () => {
    const r = resolveTradierAccountCreds(
      { ...DEFAULT_ACCOUNT_SETTINGS },
      'production',
      isLiveBrokerOperator(OTHER_BOOK, DEPLOY_ENV),
      DEPLOY_ENV,
    );
    expect(r).toEqual({ ok: false, reason: 'operator_pinned' });
    const resp = decideTradierAccountRefusalResponse('operator_pinned', 'production', 'syncing');
    expect(resp.status).toBe(403);
    expect(resp.body.code).toBe(OPERATOR_PINNED_CODE);
  });

  it('AC5: blank creds with nothing lendable stays 409 no_creds — never a borrowed operator client', () => {
    const bare: NodeJS.ProcessEnv = { LIVE_EQUITY_BOOT_USER: OPERATOR };
    const r = resolveTradierAccountCreds(
      { ...DEFAULT_ACCOUNT_SETTINGS },
      'production',
      isLiveBrokerOperator(OTHER_BOOK, bare),
      bare,
    );
    expect(r).toEqual({ ok: false, reason: 'no_creds' });
    const resp = decideTradierAccountRefusalResponse('no_creds', 'production', 'syncing');
    expect(resp.status).toBe(409);
    expect(resp.body.code).toBe(NO_CREDS_CODE);
  });
});

// ── Call-site wiring ─────────────────────────────────────────────────────────
// Source-graded for the same reason as the TRA-3112 block: there is no route
// harness, and "the decider is correct" is also what a build that never calls
// it looks like.
describe('TRA-5127 — call-site wiring (the gate sits on every order verb and ONLY there)', () => {
  const indexSrc = readFileSync(join(HERE, 'index.ts'), 'utf-8');
  const engineSrc = readFileSync(join(HERE, 'signal-engine.ts'), 'utf-8');
  const routeSlice = (marker: string, end: string): string => {
    const start = indexSrc.indexOf(marker);
    expect(start, `route ${marker} is gone — the published enumeration on TRA-5127 has drifted`).toBeGreaterThan(-1);
    const slice = indexSrc.slice(start);
    const stop = slice.indexOf(end);
    expect(stop, `terminator ${end} not found after ${marker}`).toBeGreaterThan(-1);
    return slice.slice(0, stop);
  };

  it('the helper is keyed on the TRA-857 operator pin, nothing else', () => {
    expect(indexSrc).toMatch(/decideBrokerOrderVerbResponse\(isLiveBrokerOperator\(username\)\)/);
    // A hard-coded verdict would compile and pass every decider test above.
    expect(indexSrc).not.toMatch(/decideBrokerOrderVerbResponse\(\s*(true|false)\s*\)/);
  });

  it('options close, IMPORTED branch: gated before the account client resolves', () => {
    const seg = routeSlice("app.post('/api/options/:id/close'", 'resolveTradierAccountClientForEnv(settings, imported.env');
    expect(seg).toMatch(/if \(imported\) \{[\s\S]*refuseBrokerOrderVerbForNonOperator\(res, username\)/);
  });

  it('options close, ENGINE-OPENED LIVE branch: gated before the manual close submits', () => {
    const seg = routeSlice("app.post('/api/options/:id/close'", 'submitManualOptionClose(');
    expect(seg).toMatch(/if \(liveMirror\) \{\s*\n[\s\S]{0,400}refuseBrokerOrderVerbForNonOperator\(res, username\)/);
  });

  it('options close, DEMO fall-through: the paper close is NOT gated (TRA-5126 demo books)', () => {
    const route = routeSlice("app.post('/api/options/:id/close'", "app.post('/api/options/:id/cancel-pending-exit'");
    const paper = route.slice(route.indexOf('manualCloseOption(id)') - 600, route.indexOf('manualCloseOption(id)'));
    expect(route).toMatch(/manualCloseOption\(id\)/);
    expect(paper).not.toMatch(/refuseBrokerOrderVerbForNonOperator/);
    // Exactly two gates in this route: imported + liveMirror.
    expect(route.match(/refuseBrokerOrderVerbForNonOperator\(/g)?.length).toBe(2);
  });

  it('cancel-pending-exit: gated whole-route before the engine cancel runs', () => {
    const seg = routeSlice("app.post('/api/options/:id/cancel-pending-exit'", 'cancelManualPendingExit(');
    expect(seg).toMatch(/refuseBrokerOrderVerbForNonOperator\(res, username\)/);
  });

  it('equity close: gated on the engine\'s own broker-mirror predicate, paper closes open', () => {
    const seg = routeSlice("app.post('/api/positions/:id/close'", 'manualClosePosition(');
    expect(seg).toMatch(/wouldMirrorEquityCloseToBroker\(id\)\s*\n?\s*&& refuseBrokerOrderVerbForNonOperator\(/);
  });

  it("…and that predicate is the SAME decision manualClosePosition makes internally", () => {
    // A predicate that drifted from the mirror branch would gate the wrong rows.
    const pred = engineSrc.slice(engineSrc.indexOf('wouldMirrorEquityCloseToBroker(positionId: string)'));
    expect(pred.slice(0, 200)).toMatch(/liveEquityPositions\.has\(positionId\) && this\.tradierLiveEquityClient !== null/);
    const branch = engineSrc.slice(engineSrc.indexOf('const liveOpen = this.liveEquityPositions.get(positionId);'));
    expect(branch.slice(0, 120)).toMatch(/if \(liveOpen && this\.tradierLiveEquityClient\)/);
  });

  it('exactly FOUR call sites — the enumeration is checkable against the code (CEO condition b)', () => {
    // 2x /api/options/:id/close + 1x cancel-pending-exit + 1x /api/positions/:id/close.
    // A fifth is an undocumented verb (update the TRA-5127 enumeration); three is a hole.
    // `(res, ` is the CALL form; the definition's parameter list breaks the line
    // after `(` and so is deliberately not counted.
    const calls = indexSrc.match(/refuseBrokerOrderVerbForNonOperator\(res, /g) ?? [];
    expect(calls.length).toBe(4);
  });

  it('NEGATIVE CONTROL: the kept read-only mirror verbs carry NO gate', () => {
    for (const [marker, end] of [
      ["app.post('/api/tradier/positions/sync'", 'positions = await client.listOpenOptionPositions()'],
      ["app.post('/api/tradier/equity-positions/sync'", 'reconcileLiveEquityPortfolio('],
      ["app.post('/api/options/tradier/test-connection'", 'profileResp = await fetch('],
    ] as const) {
      expect(routeSlice(marker, end), `${marker} must stay open to per-user creds (ruling 2B keeps the mirror)`)
        .not.toMatch(/refuseBrokerOrderVerbForNonOperator/);
    }
  });

  it('AC3 ownership shape: the close route resolves rows per-user and 404s a foreign :id', () => {
    const route = routeSlice("app.post('/api/options/:id/close'", "app.post('/api/options/:id/cancel-pending-exit'");
    // Both lookups go through the CALLER's ctx — user Y's :id misses both and
    // falls to the 404, for operators and non-operators alike.
    expect(route).toMatch(/ctx\.engine\.findImportedOption\(id\)/);
    expect(route).toMatch(/ctx\.engine\.findEngineOpenedOption\(id\)/);
    expect(route).toMatch(/res\.status\(404\)\.json\(\{ error: 'Option position not found' \}\)/);
  });
});
