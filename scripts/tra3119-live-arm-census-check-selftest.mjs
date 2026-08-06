// TRA-3119 — CONTROL SUITE for `tra3119-live-arm-census-check.mjs`.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// Against the live box the checker has, so far, only ever taken exit 2
// (NOT_DEPLOYED — the census is not on bqb1 yet). A checker that has only ever
// taken one exit is unproven code, and the branch a human will actually ACT on
// — the PASS, and the tail-invariant FAIL — has never run. That is the same
// class of defect TRA-3117/TRA-3119 were filed against: an instrument believed
// because it was never made to fail.
//
// The real script is run AS A SUBPROCESS, unmodified, against a stub host. What
// is graded here is the shipped file, not a re-implementation of it.
//
// ── The mutations that carry the weight ──────────────────────────────────────
// Five of these controls are deliberate MUTATIONS of a correct payload. If any
// PASSES, the PASS the checker prints against bqb1 means nothing:
//   • tail-null-with-source  — the EXACT pre-70b2f88 regression on the
//     split-brain row: `accountIdSource:'saved'`, `optionsAccountIdTail:null`.
//   • books-empty            — the census reaches nothing while the cross-check
//     names a live engine. Reads identically to a clean fleet.
//   • rollup-drift           — the aggregate disagrees with the rows it summarises.
//   • leaked-account-id      — a full account id published on a no-auth route.
//   • booksScanned-zero      — registry never built, reported as an empty cohort.
//
// Run: node scripts/tra3119-live-arm-census-check-selftest.mjs
// Exit 0 = all controls green.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// `new URL(...).pathname` yields `/C:/…` on Windows, which `spawn` resolves to a
// nonexistent `C:\C:\…`. Every control then fails identically for a reason that
// has nothing to do with the check — a false red is as useless as a false green.
const CHECK = fileURLToPath(new URL('./tra3119-live-arm-census-check.mjs', import.meta.url));

const BUILD = { commit: 'deadbeef1234567890', commitShort: 'deadbeef1234', startedAt: '2026-08-06T21:00:00.000Z' };

function row(over = {}) {
  return {
    username: 'admin',
    mode: 'live',
    runtimeMode: 'live',
    modeDisagreement: false,
    liveEntryGateOpen: true,
    clientPresent: true,
    clientDisagreement: false,
    tradierEnv: 'production',
    optionsRouted: true,
    prodKeySaved: true,
    prodAccountSaved: true,
    envFallbackAllowed: true,
    optionsClientConfigured: true,
    realMoneyArmed: true,
    accountIdSource: 'saved',
    optionsAccountIdTail: '***0154',
    ...over,
  };
}

function rollupFor(rows) {
  return {
    liveBookCount: rows.length,
    nonOperatorLiveBookCount: rows.filter(r => r.username !== 'admin').length,
    armedCount: rows.filter(r => r.liveEntryGateOpen).length,
    realMoneyArmedCount: rows.filter(r => r.realMoneyArmed).length,
    sharedAccountCount: rows.filter(r => r.accountIdSource === 'env-fallback').length,
    modeDisagreementCount: rows.filter(r => r.modeDisagreement).length,
    clientDisagreementCount: rows.filter(r => r.clientDisagreement).length,
  };
}

/** A correct two-book payload: admin on its own account, v0nni on its own. */
function goodRows() {
  return [
    row(),
    row({
      username: 'v0nni',
      envFallbackAllowed: false,
      optionsAccountIdTail: '***7766',
    }),
  ];
}

function censusOf(rows, over = {}) {
  return { booksScanned: 62, books: rows, rollup: rollupFor(rows), ...over };
}

function serve(handler) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const path = req.url.split('?')[0];
      const out = handler(path);
      if (out === undefined) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"stub has no answer"}');
        return;
      }
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function run(host) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CHECK], {
      env: { ...process.env, HOST: host, TRA3119_TIMEOUT_MS: '5000', TRA3119_SUBJECT: 'v0nni' },
    });
    let out = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (out += d));
    child.on('close', code => resolve({ code, out }));
  });
}

const CONTROLS = [
  {
    name: 'correct payload → PASS',
    want: 0,
    expect: /PASS —/,
    census: () => censusOf(goodRows()),
    engines: [{ username: 'admin', mode: 'live' }, { username: 'v0nni', mode: 'live' }],
  },
  {
    name: 'MUTATION tail-null-with-source (the pre-70b2f88 split-brain hole) → FAIL',
    want: 1,
    expect: /TAIL_INVARIANT/,
    census: () =>
      censusOf([
        row(),
        row({ username: 'v0nni', mode: 'demo', runtimeMode: 'live', modeDisagreement: true, accountIdSource: 'saved', optionsAccountIdTail: null }),
      ]),
    engines: [{ username: 'admin', mode: 'live' }, { username: 'v0nni', mode: 'live' }],
  },
  {
    name: 'MUTATION books-empty while cross-check names a live engine → FAIL (reach)',
    want: 1,
    expect: /REACH/,
    census: () => censusOf([]),
    engines: [{ username: 'admin', mode: 'live' }, { username: 'v0nni', mode: 'live' }],
  },
  {
    name: 'MUTATION rollup disagrees with rows → FAIL',
    want: 1,
    expect: /ROLLUP/,
    census: () => {
      const rows = goodRows();
      const c = censusOf(rows);
      c.rollup.armedCount = 1; // rows say 2
      return c;
    },
    engines: [{ username: 'admin', mode: 'live' }, { username: 'v0nni', mode: 'live' }],
  },
  {
    name: 'MUTATION full account id leaked on a no-auth route → FAIL',
    want: 1,
    expect: /DISCLOSURE/,
    census: () => censusOf([row({ optionsAccountIdTail: '6YA30154' }), row({ username: 'v0nni', optionsAccountIdTail: '***7766', envFallbackAllowed: false })]),
    engines: [{ username: 'admin', mode: 'live' }, { username: 'v0nni', mode: 'live' }],
  },
  {
    name: 'MUTATION booksScanned:0 (registry never built) → FAIL',
    want: 1,
    expect: /DENOMINATOR/,
    census: () => censusOf(goodRows(), { booksScanned: 0 }),
    engines: [{ username: 'admin', mode: 'live' }, { username: 'v0nni', mode: 'live' }],
  },
  {
    name: 'no liveArmCensus key → NOT_DEPLOYED, never FAIL',
    want: 2,
    expect: /NOT_DEPLOYED/,
    census: () => undefined,
    engines: [{ username: 'admin', mode: 'live' }],
  },
  {
    name: 'cross-check route 500 → BLIND, never PASS',
    want: 3,
    expect: /BLIND/,
    census: () => censusOf(goodRows()),
    engines: null, // stub answers 500 on pnl-reconciliation
  },
  {
    name: 'TAIL COLLISION is REPORTED, not graded (exit stays 0)',
    want: 0,
    expect: /TAIL COLLISION \*\*\*0154: admin \+ v0nni/,
    census: () =>
      censusOf([row(), row({ username: 'v0nni', envFallbackAllowed: false, accountIdSource: 'env-fallback', optionsAccountIdTail: '***0154' })]),
    engines: [{ username: 'admin', mode: 'live' }, { username: 'v0nni', mode: 'live' }],
  },
  {
    name: 'zero live books on BOTH surfaces → PASS but says so is not proof of safety',
    want: 0,
    expect: /not a proof of safety/,
    census: () => censusOf([]),
    engines: [{ username: 'admin', mode: 'demo' }],
  },
];

let green = 0;
for (const c of CONTROLS) {
  const census = c.census();
  const server = await serve(path => {
    if (path === '/api/health/options-live') {
      const body = { ok: true, issue: 'TRA-3117', build: BUILD };
      if (census !== undefined) body.liveArmCensus = census;
      return { body };
    }
    if (path === '/api/health/pnl-reconciliation') {
      if (c.engines === null) return { status: 500, body: { error: 'stub outage' } };
      return { body: { ok: true, engines: c.engines } };
    }
    return undefined;
  });
  const { port } = server.address();
  const { code, out } = await run(`http://127.0.0.1:${port}`);
  server.close();

  const codeOk = code === c.want;
  const textOk = c.expect.test(out);
  if (codeOk && textOk) {
    green += 1;
    console.log(`  ✓ ${c.name}`);
  } else {
    console.log(`  ✗ ${c.name}`);
    console.log(`      exit ${code} (want ${c.want})${textOk ? '' : `, output did not match ${c.expect}`}`);
    console.log(out.split('\n').map(l => `      | ${l}`).join('\n'));
  }
}

console.log('');
console.log(`${green}/${CONTROLS.length} controls green`);
process.exit(green === CONTROLS.length ? 0 : 1);
