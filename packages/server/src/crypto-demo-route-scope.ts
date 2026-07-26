// TRA-2411 — WHO may receive the PROCESS-GLOBAL regime-TSMOM demo-route book in
// their PERSONAL crypto view.
//
// TRA-1317 built a dedicated `CryptoPaperAccount` "route book" for the regime-gated
// TSMOM scanner and surfaced its open longs on the Crypto dashboard so "the board
// sees the routed movement". That book is a MODULE-LEVEL SINGLETON with no user key
// at all (`crypto-regime-tsmom-demo-route.ts:119-122`), driven by a process-global
// hourly pass and persisted under DATA_DIR — not under any user's directory. But the
// provider was bound for EVERY user context (`index.ts`, `attachBroadcastHandlers`),
// and `CryptoSignalEngine.buildState()`'s demo branch pushes whatever it returns
// straight into the returned `account.openPositions`. So the firm's paper book was
// rendered to every demo account as THEIR OWN position — the same shape TRA-2407
// closed for the demo calendar fold, on a different surface.
//
// ⚠️ It was reported (and lands here) as LATENT, on an EMPIRICAL zero: the route book
// is currently empty because the crypto program is parked (TRA-1210) and TSMOM was
// killed at n=18 (TRA-1440), so a live probe of a fresh account returned
// `openPositions: []` and looked correct. The injection code was live and
// unconditional — only the emptiness of the singleton held it closed. That is the
// `EXIT_RISK` bare-call-site shape (safe only by `liveEngineCount:0`): an empirical
// zero expires the moment anything opens a position, a structural one does not.
// Gating the WIRING on the route flag being armed would NOT have fixed this — it
// would have made re-arming the route the trigger for a fleet-wide leak, which is
// precisely what the ticket asks to prevent. So the scope is on the OWNER, and it
// holds with the route fully armed and the book full.
//
// Pure predicate + one scoped accessor. Reads no secret, routes no order, no I/O.

import type { Position } from '@trading-app/shared';
import { getRegimeTsmomDemoRoutePositions } from './crypto-regime-tsmom-demo-route.js';
import { mayViewFirmWideDemoFold } from './reports/demo-calendar-fill-scope.js';

/**
 * TRA-2411 — MAY this account be shown the firm-wide TSMOM demo-route book?
 *
 * Delegates to TRA-2407's {@link mayViewFirmWideDemoFold}, deliberately. Both
 * questions are the SAME question — "is this an operator book, i.e. one of the
 * accounts the board's firm-wide demo artifacts were built for?" — and TRA-2407
 * already worked out the answer the hard way: default-deny, `role === 'admin'` OR an
 * explicit case-insensitive allowlist (`admin`, `Richard`) that env can WIDEN but
 * never empty. Re-deriving a second operator set here is how the front door and the
 * side door drift apart, which is the whole of TRA-2407 and now of this ticket.
 *
 * ⚠️ NOT `isLiveBrokerOperator()` (TRA-857), despite it being the other "operator"
 * predicate already in `crypto-engine.ts`. That one resolves `LIVE_EQUITY_BOOT_USER`,
 * whose documented kill-switch is setting it EMPTY to disarm the LIVE equity boot-arm.
 * Gating a DEMO display on it would mean pulling the live kill-switch silently blanks
 * the board's demo dashboard — coupling two levers that must stay independent.
 *
 * ⚠️ NOT `classifySpreadCeilingAccount()` either, for the reason TRA-2407 documents at
 * length: it is `isTestAccount(x) ? 'fixture' : 'desk'`, so every ordinary username
 * falls through to `'desk'` and the gate admits everyone while looking closed.
 *
 * @param username the AUTHENTICATED account (`ctx.username`), never a position's owner label.
 * @param role     that user's stored role, or `undefined` when the lookup failed (→ deny).
 */
export function mayViewFirmWideDemoRouteBook(
  username: string | null | undefined,
  role: 'admin' | 'user' | undefined | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return mayViewFirmWideDemoFold(username, role, env);
}

/**
 * TRA-2411 — the route book's open paper longs, scoped to the caller.
 *
 * This is what `index.ts` binds as the engine's external demo-positions provider,
 * as a per-context closure re-evaluated on every `getState()`. Two consequences,
 * both deliberate:
 *
 *  - The check CANNOT go stale. Binding the provider only for operator contexts at
 *    attach time would have been simpler, but `attachBroadcastHandlers` runs once
 *    per context creation, so a role change afterwards would leave a demoted account
 *    still receiving the book (or a promoted one never receiving it).
 *  - Both transports are covered by construction. `GET /api/crypto/state` and the WS
 *    `crypto_state` broadcast both render `CryptoSignalEngine.getState()`, so scoping
 *    the provider — rather than filtering at one route — closes the second door that
 *    TRA-2421 had to be taught about separately.
 *
 * A denied caller gets `[]`, i.e. exactly the engine's own book, unchanged.
 */
export function demoRoutePositionsFor(
  username: string | null | undefined,
  role: 'admin' | 'user' | undefined | null,
  env: NodeJS.ProcessEnv = process.env,
): Position[] {
  if (!mayViewFirmWideDemoRouteBook(username, role, env)) return [];
  return getRegimeTsmomDemoRoutePositions();
}
