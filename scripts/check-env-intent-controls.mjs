#!/usr/bin/env node
// check-env-intent-controls.mjs — TRA-4474
//
// The checker is an instrument too. Before trusting its green, prove what a
// broken world looks like through it: each control below feeds it a fixture of
// a known state and asserts the EXACT exit code. A control that cannot fail is
// not a control.
//
// Exit: 0 all controls hold · 1 a control landed on the wrong exit code.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHECKER = join(import.meta.dirname, 'check-env-intent.mjs');
const dir = mkdtempSync(join(tmpdir(), 'env-intent-controls-'));

// TRA-4862 — the declared leg is ALWAYS ON and fails closed, so every control
// below must feed it a declaration too; otherwise each one would be graded
// against this checkout's real manifest (7 levers) and go red for a reason the
// control is not about. Unless a case says otherwise, the declaration is
// exactly what its route fixture publishes — i.e. "the build is current", which
// is the state every pre-TRA-4862 control implicitly assumed.
const declaredFromBody = (body) => (body?.envIntent?.levers ?? []).map((l) => ({ key: l.key, intended: l.intended }));

const lever = (key, intended, effective, present = true, raw = undefined) => ({
  key,
  intended,
  raw: present ? (raw ?? effective) : null,
  present,
  effective,
  matches: effective === intended,
  provenance: 'control fixture',
});

const GOOD = {
  policy: 'refuse',
  envIntent: {
    source: 'packages/server/src/env-intent.ts',
    applies: true,
    nodeEnv: 'production',
    levers: [
      lever('DURABILITY_POLICY', 'refuse', 'refuse'),
      lever('ENABLE_ORDER_QUOTE_GUARD', 'off', 'off', false),
      // The stood-down live-OTM lever, in the shape the live box reads today:
      // present, stored 'false', resolving off (TRA-4785 / TRA-4750 item 3).
      lever('ENABLE_OPTION_LIVE_OTM', 'off', 'off', true, 'false'),
    ],
    mismatches: [],
    ok: true,
  },
};

// THE INCIDENT: the key wiped, the default deciding, effective != intended.
const WIPED = structuredClone(GOOD);
WIPED.policy = 'observe';
WIPED.envIntent.levers[0] = lever('DURABILITY_POLICY', 'refuse', 'observe', false);
WIPED.envIntent.mismatches = ['DURABILITY_POLICY'];
WIPED.envIntent.ok = false;

// The pre-TRA-4474 build: effective-only payload, no second term at all.
const PRE_4474 = { policy: 'observe', violations: [], unmeasured: [] };

/** Same payload with one extra lever appended. */
const withExtraLever = (body, l) => {
  const c = structuredClone(body);
  c.envIntent.levers.push(l);
  return c;
};
/** Same payload with the lever of the same key REPLACED. */
const withLever = (body, l) => {
  const c = structuredClone(body);
  c.envIntent.levers = c.envIntent.levers.map((x) => (x.key === l.key ? l : x));
  return c;
};

// A box that cannot prove it is production: graded nothing, must not pass.
const UNGRADED = structuredClone(GOOD);
UNGRADED.envIntent.applies = false;
UNGRADED.envIntent.nodeEnv = null;
UNGRADED.envIntent.levers = UNGRADED.envIntent.levers.map((l) => ({ ...l, matches: null }));
UNGRADED.envIntent.ok = null;

// ── TRA-4803: the env-list arm's own controls ────────────────────────────────
// That arm used to grade NOTHING on an `intended:'off'` lever, so a stored
// `ENABLE_OPTION_LIVE_OTM=1` awaiting a boot exited 0 MATCH. Its PASS and its
// SKIP rendered identically, which is the whole reason these exist: each case
// below pins the exit code AND a string only the intended branch can print.
const storedList = (pairs) => Object.entries(pairs).map(([key, value]) => ({ key, value }));

// The live stored set on bqb1, measured 2026-09-22 (93 keys; only the graded
// ones matter — the rest cannot change any verdict).
const STORED_LIVE = { DURABILITY_POLICY: 'refuse', ENABLE_OPTION_LIVE_OTM: 'false' };

// TRA-4862 — bqb1 as the serving build `7f290414` published it on 2026-09-23,
// the boot that reverted the stand-down: TRADIER_ENV graded, intended and
// effective 'production', every lever matching. Nothing on this wire is wrong;
// the declaration that disagreed with it was sitting undeployed in the repo.
const TRADIER_LIVE = withExtraLever(GOOD, lever('TRADIER_ENV', 'production', 'production', true, 'production'));

const cases = [
  { name: 'CLEAN — armed as ruled', body: GOOD, want: 0 },
  { name: 'BROKEN — the incident (key wiped, default deciding)', body: WIPED, want: 1 },
  { name: 'BLIND — running build publishes no envIntent', body: PRE_4474, want: 3 },
  { name: 'BLIND — box cannot prove it is production (applies:false)', body: UNGRADED, want: 3 },
  {
    name: 'arm OFF — no RENDER_API_KEY: the stored set is NOT graded, and says so',
    body: GOOD,
    want: 0,
    wants: ['env-list arm: OFF', 'EFFECTIVE only; env-list arm OFF'],
    // A pass with the arm off must never render like a pass with it on.
    wantsNot: ['EFFECTIVE and STORED'],
  },
  {
    name: 'arm ON, live shape — stored `false`, effective off ⇒ MATCH on both legs',
    body: GOOD,
    stored: STORED_LIVE,
    want: 0,
    wants: ['EFFECTIVE and STORED'],
  },
  {
    name: 'arm ON, absent ⇒ 0 — absent IS the intent for an `off` lever (must not go permanently red)',
    body: GOOD,
    // Every `intended:'off'` key absent, exactly as bqb1 reads for three of them.
    stored: { DURABILITY_POLICY: 'refuse' },
    want: 0,
    wants: ['EFFECTIVE and STORED'],
  },
  {
    name: 'THE GAP (TRA-4803) — stored ENABLE_OPTION_LIVE_OTM=1 awaiting a boot ⇒ STAGED, non-zero',
    body: GOOD,
    stored: { ...STORED_LIVE, ENABLE_OPTION_LIVE_OTM: '1' },
    want: 1,
    // Labelled so it can never be read as an in-force arm.
    wants: ['ENABLE_OPTION_LIVE_OTM: STAGED', 'NOT YET IN FORCE', "still 'off'"],
  },
  {
    name: 'STAGED, multi-key — quote guard armed + enforce staged ⇒ resolves `enforce`, non-zero',
    body: GOOD,
    stored: { ...STORED_LIVE, ENABLE_ORDER_QUOTE_GUARD: '1', ORDER_QUOTE_GUARD_ENFORCE: 'true' },
    want: 1,
    wants: ['ENABLE_ORDER_QUOTE_GUARD: STAGED', "resolves 'enforce'"],
  },
  {
    name: 'STAGED WIPE — DURABILITY_POLICY gone from the stored set while still in force ⇒ non-zero',
    body: GOOD,
    stored: { ENABLE_OPTION_LIVE_OTM: 'false' },
    want: 1,
    wants: ['DURABILITY_POLICY: STAGED', 'key ABSENT', "resolves 'observe'"],
  },
  {
    name: 'STAGED FIX — route still wrong, stored already restored ⇒ exit 1 (route) + an explicit note',
    body: WIPED,
    stored: STORED_LIVE,
    want: 1,
    wants: ['note DURABILITY_POLICY:', 'the fix is STAGED'],
    // A staged FIX is not a staged breach — it must not be reported as one.
    wantsNot: ['DURABILITY_POLICY: STAGED ('],
  },
  {
    name: 'BLIND — the manifest grew a lever this checker cannot resolve',
    body: withExtraLever(GOOD, lever('ENABLE_SOMETHING_NEW', 'off', 'off', false)),
    stored: STORED_LIVE,
    want: 3,
    wants: ['no stored resolver'],
  },
  {
    name: 'BLIND — a stored value that is not a string cannot be resolved',
    body: GOOD,
    storedRaw: [{ key: 'DURABILITY_POLICY', value: 'refuse' }, { key: 'ENABLE_OPTION_LIVE_OTM', value: 1 }],
    want: 3,
    wants: ['not a string'],
  },
  {
    name: 'BLIND — the local resolver port disagrees with the SHIPPED one on an observed pair',
    // The running build says raw '1' resolved to 'off'. This script says '1' is
    // on. One of them is stale, and it is not the box: refuse to grade.
    body: withLever(GOOD, lever('ENABLE_OPTION_LIVE_OTM', 'off', 'off', true, '1')),
    stored: { ...STORED_LIVE, ENABLE_OPTION_LIVE_OTM: '1' },
    want: 3,
    wants: ['local resolver disagrees with the shipped one'],
  },

  // ── TRA-4862: the declared leg's own controls ──────────────────────────────
  // Both legs above read `intended` off the wire, so a manifest edit that is
  // COMMITTED BUT NOT DEPLOYED was invisible to both. The 2026-09-23 stand-down
  // defeated them, and ARM 0 / 0b / 0c are the three states of it byte-for-byte.
  //
  // TIMELINE — measured directly off the Render tape by TRA-4863
  // (`scripts/tra4863-tradier-env-timeline.mjs`, which reads the `rv-scanner
  // initialized {env}` line `index.ts` logs at module scope off
  // `process.env['TRADIER_ENV']`, so the lever's value is on the tape at every
  // boot). This SUPERSEDES the "held ~15.5h" reading that stood here until
  // 2026-09-24: that span was dated from the 01:15Z persisted demotion on
  // 09-23, which is when ineligibility was first REVEALED, not when the lever
  // moved. The lever had already moved ~47h earlier.
  //
  //   09-20T22:07:07Z  last boot reading 'production'
  //   09-21T02:08:37Z  unattributed env write dep-dao939egekts73bbv9cg → sandbox
  //   09-21T02:09:14Z  first boot reading 'sandbox'   ─┐
  //   09-23T11:35:26Z  f183e601 DECLARES sandbox       │ stand-down in force,
  //   09-23T16:41:06Z  env write dep-daq028id0e5s73aka5i0 → production
  //   09-23T16:41:55Z  boot reads 'production' again  ─┘ 62h32m41s boot-to-boot
  //   09-23T16:42:05Z  boot-arm reconverges the operator to live+production
  //
  // So the declaration TRAILED the lever by ~57h26m; it did not precede it.
  // Which leg catches which write is NOT the same for the two ends of that
  // window, and each arm below pins one of the three states:
  //
  //   0c  09-21T02:09Z→09-23T11:35Z (~57h26m) — declared 'production' (the
  //       d98c411d standing mismatch), stored 'sandbox'. The ENV-LIST arm is
  //       the only detector; the declared leg is silent because the manifest
  //       and the wire agree. That arm is OFF without RENDER_API_KEY.
  //   0b  09-23T11:35Z→16:41Z (~5h06m) — declaration lands. The wire-reading
  //       legs now invert and accuse the live stand-down.
  //   0   09-23T16:41Z onward — the revert. The stored value returns to what
  //       the undeployed wire expects, so the env-list arm goes QUIET and the
  //       DECLARED leg is the only thing left that can see it.
  //
  // That asymmetry is the argument for the declared leg: the env-list arm
  // covers the risk-DECREASING write, and only the declared leg covers the
  // risk-INCREASING one.
  {
    name: 'ARM 0 (THE INCIDENT, post-revert) — declared sandbox, lever back at production, never deployed ⇒ non-zero',
    // The serving build 7f290414 predates the declaration, so the wire still
    // says 'production' and the stored value is 'production' again. Legs 1 and 2
    // agree with each other and with the box. Only the repo disagrees.
    body: TRADIER_LIVE,
    stored: { ...STORED_LIVE, TRADIER_ENV: 'production' },
    declared: [
      { key: 'DURABILITY_POLICY', intended: 'refuse' },
      { key: 'ENABLE_OPTION_LIVE_OTM', intended: 'off' },
      { key: 'TRADIER_ENV', intended: 'sandbox' },
    ],
    want: 1,
    wants: [
      'TRADIER_ENV: DECLARED',
      "manifest intends 'sandbox'",
      'NOT DEPLOYED',
      'which DISAGREES with the declaration',
      'AS OF THIS READ',
      'the TRA-4862 shape',
      // The remedy is the same either way, but the HISTORY is not measured here
      // and must not be asserted: this state is reached both by a declaration
      // that was never applied and by one that was applied and then reverted,
      // and 09-23 was the second. Inventing the first from one sample is the
      // attribution-from-silence failure the repo rule exists to stop.
      'NEVER APPLIED from APPLIED AND SINCE REVERTED',
    ],
    // The stand-down is not in force AT THIS READ; it must not render as one.
    wantsNot: ['IN FORCE', 'STAGED ('],
  },
  {
    name: 'ARM 0b (THE INCIDENT, stand-down IN FORCE, declaration landed) — the pre-fix legs invert and accuse the stand-down itself',
    // 2026-09-23 11:35Z→16:41Z: the declaration is correct AND applied; only the
    // build lags. The two wire-reading legs grade the stored 'sandbox' against
    // the SUPERSEDED wire intent 'production' and report the live stand-down as
    // the defect — an operator following that reading undoes it. The declared
    // leg must name the real fault (undeployed build) and must NOT claim the
    // lever failed to take.
    body: TRADIER_LIVE,
    stored: { ...STORED_LIVE, TRADIER_ENV: 'sandbox' },
    declared: [
      { key: 'DURABILITY_POLICY', intended: 'refuse' },
      { key: 'ENABLE_OPTION_LIVE_OTM', intended: 'off' },
      { key: 'TRADIER_ENV', intended: 'sandbox' },
    ],
    want: 1,
    wants: [
      'TRADIER_ENV: DECLARED',
      'NOT DEPLOYED',
      'which AGREES with the declaration',
      'only the build lags',
      // The STAGED row for the SAME key must not be left telling the operator to
      // "fix the STORED value" — that is the instruction that undoes the
      // stand-down. It is re-pointed at deploying the declaration.
      'TRADIER_ENV: STAGED (',
      'the remedy is to DEPLOY the declaration',
      'the TRA-4862 inversion',
    ],
    wantsNot: ['which DISAGREES with the declaration', 'the TRA-4862 shape'],
  },
  {
    name: 'ARM 0c (THE INCIDENT, first ~57h26m) — lever already sandbox, manifest still says production ⇒ the ENV-LIST arm is the only detector',
    // 2026-09-21T02:09Z→09-23T11:35Z. The longest of the three states and the
    // one the corrected timeline added. `d98c411d` had deliberately left the
    // row at intended:'production' as a standing mismatch "until someone
    // rules", so the manifest and the serving wire AGREE and the declared leg
    // has nothing to say. The whole verdict rests on the env-list arm reading
    // the stored 'sandbox' — which is exactly the arm that reads OFF when
    // RENDER_API_KEY is absent. A runner without that key would have graded
    // this 57h window a clean MATCH.
    body: TRADIER_LIVE,
    stored: { ...STORED_LIVE, TRADIER_ENV: 'sandbox' },
    declared: [
      { key: 'DURABILITY_POLICY', intended: 'refuse' },
      { key: 'ENABLE_OPTION_LIVE_OTM', intended: 'off' },
      { key: 'TRADIER_ENV', intended: 'production' },
    ],
    want: 1,
    wants: ['TRADIER_ENV: STAGED (', "not the intended 'production'"],
    // The declared leg must stay silent here: nothing is undeployed, and this
    // state must not be confused with either of the two 09-23 ones.
    wantsNot: ['TRADIER_ENV: DECLARED', 'the TRA-4862 shape', 'the TRA-4862 inversion'],
  },
  {
    name: 'ARM 0c WITHOUT the env-list arm — the same 57h26m state grades a FALSE all-clear ⇒ exit 0',
    // Identical to ARM 0c except no stored fixture, i.e. no RENDER_API_KEY.
    // This is the control for the routine's own instruction that an arm-OFF run
    // is "a half-measurement, not a pass": with the key absent, the state that
    // held for 57 hours over the real-money option book exits 0 MATCH. A
    // cadence that runs this checker keyless is worse than no cadence, because
    // it manufactures a green.
    body: TRADIER_LIVE,
    declared: [
      { key: 'DURABILITY_POLICY', intended: 'refuse' },
      { key: 'ENABLE_ORDER_QUOTE_GUARD', intended: 'off' },
      { key: 'ENABLE_OPTION_LIVE_OTM', intended: 'off' },
      { key: 'TRADIER_ENV', intended: 'production' },
    ],
    want: 0,
    // The pass must carry its own caveat, so it can never be quoted as a full
    // grade of the lever the incident turned on.
    wants: ['env-list arm: OFF', 'EFFECTIVE only; env-list arm OFF'],
    wantsNot: ['EFFECTIVE and STORED'],
  },
  {
    name: 'declared, env-list arm OFF — reach is UNGRADED and must say so, never assumed applied',
    body: TRADIER_LIVE,
    declared: [
      { key: 'DURABILITY_POLICY', intended: 'refuse' },
      { key: 'ENABLE_OPTION_LIVE_OTM', intended: 'off' },
      { key: 'TRADIER_ENV', intended: 'sandbox' },
    ],
    want: 1,
    wants: ['TRADIER_ENV: DECLARED', 'NOT GRADED (env-list arm OFF)'],
    wantsNot: ['which AGREES with the declaration', 'which DISAGREES with the declaration'],
  },
  {
    name: 'declared — a lever ADDED to the manifest but not deployed ⇒ non-zero (nothing grades it on-box)',
    body: GOOD,
    declared: [...declaredFromBody(GOOD), { key: 'ENABLE_OPTION_LIVE_DIRECTIONAL', intended: 'off' }],
    want: 1,
    wants: ['ENABLE_OPTION_LIVE_DIRECTIONAL: DECLARED', 'does not publish this lever at all'],
  },
  {
    name: 'declared — a lever DROPPED from the manifest but still deployed ⇒ non-zero',
    body: GOOD,
    declared: declaredFromBody(GOOD).filter((r) => r.key !== 'ENABLE_ORDER_QUOTE_GUARD'),
    want: 1,
    wants: ['ENABLE_ORDER_QUOTE_GUARD: DECLARED', 'no longer declares it'],
  },
  {
    name: 'declared leg is ON in the MATCH line — a pass must not render like the pre-TRA-4862 one',
    body: GOOD,
    want: 0,
    wants: ['declared leg: ON', 'DECLARES exactly what the running build grades against'],
  },
  {
    name: 'BLIND — the declaration is unreadable (fail closed; an unread declaration is not an absent one)',
    body: GOOD,
    declaredRaw: '{"not":"an array"}',
    want: 3,
    wants: ['not a non-empty array'],
  },
  {
    name: 'BLIND — a declared row is not {key,intended}',
    body: GOOD,
    declaredRaw: '[{"key":"DURABILITY_POLICY"}]',
    want: 3,
    wants: ['is not {key:string,intended:string}'],
  },
];

let failed = 0;
for (const [i, c] of cases.entries()) {
  const file = join(dir, `c${i}.json`);
  writeFileSync(file, JSON.stringify(c.body));
  const args = [CHECKER, `--fixture=${file}`];
  if (c.stored || c.storedRaw) {
    const sf = join(dir, `c${i}-stored.json`);
    writeFileSync(sf, JSON.stringify(c.storedRaw ?? storedList(c.stored)));
    args.push(`--stored-fixture=${sf}`);
  }
  // TRA-4862 — always fed: the declared leg has no off switch, so a control that
  // omitted it would be graded against this checkout's real manifest.
  const df = join(dir, `c${i}-declared.json`);
  writeFileSync(df, c.declaredRaw ?? JSON.stringify(c.declared ?? declaredFromBody(c.body)));
  args.push(`--declared-fixture=${df}`);
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    // The env-list arm must never reach the REAL service from a control: a real
    // key here would grade the live env against a fixture's lever list.
    env: { ...process.env, RENDER_API_KEY: '' },
  });
  const got = r.status;
  const out = r.stdout + r.stderr;
  const missing = (c.wants ?? []).filter((w) => !out.includes(w));
  const present = (c.wantsNot ?? []).filter((w) => out.includes(w));
  const ok = got === c.want && missing.length === 0 && present.length === 0;
  if (!ok) failed++;
  console.log(`[controls] ${ok ? 'PASS' : 'FAIL'} — ${c.name}: want exit ${c.want}, got ${got}`);
  if (missing.length > 0) console.log(`           missing from output: ${JSON.stringify(missing)}`);
  if (present.length > 0) console.log(`           must NOT be in output: ${JSON.stringify(present)}`);
  if (!ok) console.log(out.trim().split('\n').map((l) => `           ${l}`).join('\n'));
}

// Usage control: an unrecognized flag must be exit 2, never a silent grade.
{
  const r = spawnSync(process.execPath, [CHECKER, '--fixtuer=typo.json'], { encoding: 'utf8' });
  const ok = r.status === 2;
  if (!ok) failed++;
  console.log(`[controls] ${ok ? 'PASS' : 'FAIL'} — usage: unrecognized flag: want exit 2, got ${r.status}`);
}

rmSync(dir, { recursive: true, force: true });
if (failed > 0) {
  console.error(`[controls] ${failed} control(s) FAILED — the checker cannot be trusted until they hold.`);
  process.exit(1);
}
console.log('[controls] all controls hold.');
