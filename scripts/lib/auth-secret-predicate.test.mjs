// Discrimination suite for the shared AUTH_SECRET predicate (TRA-2315).
//
// The bug under test is NOT "the guard is missing". The guard existed, ran, read the
// real value out of the Render API, and reported PASS — on a value that makes
// production refuse to boot. So a suite that only asserts "good value => PASS,
// absent => FAIL" would have passed against the BROKEN guard too, and proved nothing.
//
// What makes a green run here mean something:
//
//   1. The `L-OLD-*` cases are REGRESSION CONTROLS. They replay the predicate this
//      module replaces and assert it still gets the whitespace case WRONG. If someone
//      "simplifies" `authSecretUsable` back to a length test, these go red.
//   2. `pins the predicate to auth.ts` reads the SERVER SOURCE and asserts the
//      expression is still the one this module mirrors. Every other test in this file
//      grades this module against my memory of auth.ts; that one grades it against
//      auth.ts. Without it the whole suite can stay green while the thing it mirrors
//      moves underneath it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  authSecretUsable,
  classifyAuthSecret,
  legacyNonEmptyPredicate_DO_NOT_USE,
} from './auth-secret-predicate.mjs';

const AUTH_TS = fileURLToPath(new URL('../../packages/server/src/auth.ts', import.meta.url));

// ---------------------------------------------------------------- the split cases
// Values where the OLD predicate and the SERVER disagree. This is the entire bug.
const WHITESPACE_ONLY = [' ', '   ', '\t', '\n', '\r\n', ' \t \n '];

for (const raw of WHITESPACE_ONLY) {
  test(`whitespace-only ${JSON.stringify(raw)} is UNUSABLE (server refuses to boot)`, () => {
    assert.equal(authSecretUsable(raw), false);
    const c = classifyAuthSecret(raw);
    assert.equal(c.shape, 'WHITESPACE_ONLY');
    assert.equal(c.usable, false);
    assert.equal(c.usableLength, 0);
    assert.ok(c.rawLength > 0, 'raw length is non-zero — this is why the old test passed it');
  });

  test(`L-OLD: legacy predicate WRONGLY passes ${JSON.stringify(raw)}`, () => {
    // The control that makes the fix meaningful: the old expression says "fine".
    assert.equal(legacyNonEmptyPredicate_DO_NOT_USE(raw), true);
    assert.notEqual(legacyNonEmptyPredicate_DO_NOT_USE(raw), authSecretUsable(raw));
  });
}

// ---------------------------------------------------------------- agreement cases
test('absent is UNUSABLE under both predicates', () => {
  for (const raw of [null, undefined]) {
    assert.equal(authSecretUsable(raw), false);
    assert.equal(legacyNonEmptyPredicate_DO_NOT_USE(raw), false);
    assert.equal(classifyAuthSecret(raw).shape, 'ABSENT');
  }
});

test('empty string is UNUSABLE under both predicates', () => {
  assert.equal(authSecretUsable(''), false);
  assert.equal(legacyNonEmptyPredicate_DO_NOT_USE(''), false);
  assert.equal(classifyAuthSecret('').shape, 'EMPTY');
});

test('a real 32-byte hex secret is USABLE', () => {
  const real = 'a3f1'.repeat(16); // 64 hex chars, the shape `openssl rand -hex 32` emits
  assert.equal(real.length, 64);
  assert.equal(authSecretUsable(real), true);
  const c = classifyAuthSecret(real);
  assert.equal(c.shape, 'SET');
  assert.equal(c.usableLength, 64);
});

test('a padded real secret is USABLE — trim decides usability, not the stored bytes', () => {
  // resolveAuthSecret returns `fromEnv` UNTRIMMED once it passes the trim test, so a
  // padded value boots and signs with the padding included. That is the server's
  // behaviour, so it is this module's behaviour; the guard's job is to agree with the
  // server, not to improve on it.
  const c = classifyAuthSecret('  secret  ');
  assert.equal(c.usable, true);
  assert.equal(c.rawLength, 10);
  assert.equal(c.usableLength, 6);
});

// ---------------------------------------------------------------- reachability
test('the suite exercises BOTH verdicts (an all-FAIL suite proves nothing)', () => {
  const verdicts = new Set(
    [null, '', ' ', '\t\n', 'abc', 'a3f1'.repeat(16)].map((v) => authSecretUsable(v)),
  );
  assert.deepEqual([...verdicts].sort(), [false, true]);
  const shapes = new Set(
    [null, '', ' ', 'abc'].map((v) => classifyAuthSecret(v).shape),
  );
  assert.deepEqual([...shapes].sort(), ['ABSENT', 'EMPTY', 'SET', 'WHITESPACE_ONLY']);
});

// ---------------------------------------------------------------- the ruler check
test('pins the predicate to auth.ts — the source, not my memory of it', () => {
  const src = readFileSync(AUTH_TS, 'utf8');

  // The acceptance expression this module mirrors. Whitespace-insensitive so a
  // reformat does not red the suite, but the OPERATOR (`trim`) and the COMPARISON
  // (`> 0`) are both pinned, because those are what the bug was about.
  const accepts = /if\s*\(\s*fromEnv\s*&&\s*fromEnv\.trim\(\)\.length\s*>\s*0\s*\)/.test(src);
  assert.ok(
    accepts,
    'resolveAuthSecret no longer accepts on `fromEnv.trim().length > 0`. ' +
      'The out-of-process guard in auth-secret-predicate.mjs mirrors that expression — ' +
      're-derive BOTH in this commit rather than relaxing this assertion.',
  );

  // And the production refusal must still exist, or the whole severity argument
  // ("prod refuses to boot") is stale prose.
  assert.match(
    src,
    /NODE_ENV\s*===\s*'production'/,
    'auth.ts no longer branches on NODE_ENV===production; re-check what an unusable ' +
      'AUTH_SECRET now COSTS before trusting this guard\'s failure text.',
  );
});
