// TRA-4488 — THE CALLER IS THE UNIT UNDER TEST.
//
// `ws-auth.test.ts` drives real sockets, but through a harness server, because
// `index.ts` binds a port at import and cannot be loaded into a test process.
// Every assertion in that file stays green if someone re-inlines
// `searchParams.get('token')` into the production upgrade handler and stops
// calling `authenticateUpgrade` at all — which is precisely the defect this
// issue is about, restored. So this file grades the seam in `index.ts` itself.
//
// Source assertions are slices, never bare regexes over the whole file: a regex
// proves ORDER, never ADJACENCY, so a second credential read inserted between
// two anchors is invisible to it. Each check below extracts the upgrade
// handler's body and asserts on THAT text.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf-8');

/**
 * The body of `httpServer.on('upgrade', …)`, brace-matched from its opening.
 *
 * ⚠ The slice is asserted NON-EMPTY and recognisably the handler before it is
 * returned. Every `not.toContain` below passes vacuously on `''`, so a matcher
 * that silently stopped finding the handler would read as a clean bill of health
 * — the failure direction this whole file exists to avoid.
 */
function upgradeHandlerBody(): string {
  const start = SRC.indexOf("httpServer.on('upgrade'");
  expect(start, "index.ts must still install an 'upgrade' handler").toBeGreaterThan(-1);
  const open = SRC.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        const body = SRC.slice(start, i + 1);
        expect(body.length, 'extracted upgrade handler is implausibly short').toBeGreaterThan(200);
        expect(body, 'extracted slice is not the upgrade handler').toContain('wss.handleUpgrade(');
        return body;
      }
    }
  }
  throw new Error('unbalanced braces in the upgrade handler');
}

describe('TRA-4488 index.ts upgrade wiring', () => {
  it('routes the upgrade decision through authenticateUpgrade', () => {
    expect(upgradeHandlerBody()).toContain('authenticateUpgrade(');
  });

  it('does NOT read a credential out of the query string itself', () => {
    const body = upgradeHandlerBody();
    // The pre-fix handler's two lines, verbatim in shape. Either one reappearing
    // means the decision has been partly re-inlined, and `ws-auth.test.ts`
    // cannot see that.
    expect(body).not.toContain('searchParams');
    expect(body).not.toMatch(/\bverifyToken\s*\(/);
    expect(body).not.toMatch(/new URL\(/);
  });

  it('still refuses with 401 + destroy rather than handing the socket on', () => {
    const body = upgradeHandlerBody();
    expect(body).toContain('HTTP/1.1 401 Unauthorized');
    expect(body).toContain('socket.destroy()');
  });

  it('still applies the TRA-2421 account-existence check, via the injected predicate', () => {
    // The check moved INSIDE `authenticateUpgrade`, so its presence at the call
    // site is the `userExists` argument. If this argument is dropped the call
    // stops compiling (it is required on `UpgradeAuthDeps`), but a future
    // refactor could satisfy the type with a stub — assert it is `getUser`.
    const body = upgradeHandlerBody();
    expect(body).toMatch(/userExists:\s*\(\w+\)\s*=>\s*Boolean\(getUser\(\w+\)\)/);
  });

  it('stamps the username the decision returned onto the socket', () => {
    expect(upgradeHandlerBody()).toContain('decision.username');
  });

  it('exposes the ticket endpoint behind requireAuth, not unauthenticated', () => {
    // A ws-ticket route without `requireAuth` would mint a credential for anyone
    // who asked — strictly worse than the defect being fixed.
    expect(SRC).toMatch(/app\.post\('\/api\/auth\/ws-ticket',\s*requireAuth\s*,/);
  });

  it('revokes outstanding tickets when a user s sockets are closed', () => {
    const start = SRC.indexOf('function closeUserSockets');
    expect(start).toBeGreaterThan(-1);
    const body = SRC.slice(start, SRC.indexOf('\n}', start));
    expect(body).toContain('revokeWsTicketsFor(username)');
  });

  it('redacts the query string at every site that logs a request URL', () => {
    // Item 4. `originalUrl` carries the query string; both remaining references
    // must be wrapped. Counted rather than merely present, so adding a third
    // unwrapped site fails here.
    const rawUses = SRC.match(/req\.originalUrl/g) ?? [];
    const wrapped = SRC.match(/redactQueryString\(req\.originalUrl\)/g) ?? [];
    expect(rawUses.length).toBeGreaterThan(0);
    expect(wrapped.length).toBe(rawUses.length);
  });
});
