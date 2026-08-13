// TRA-3368 (parent TRA-2346) — the pre-fix/post-fix differential for the POWER criterion.
//
// The acceptance says the criterion must be MONOTONE NON-INCREASING on the existing
// fixture set (`passed′ ≤ passed` pointwise). That is a claim about the RELATION BETWEEN
// TWO BUILDS, so a green suite on either build alone cannot see it. This script is the
// instrument: run it on the PRE-fix build to record the OLD column, then on THIS build
// to record the NEW one, over the byte-identical fixtures in
// `gate-sleeve-blocking-fixtures.ts` (which is why those fixtures are a shared module and
// not two copies — see its header).
//
//   cd packages/server && node --import tsx/esm ../../scripts/tra3368-monotonicity-matrix.mjs
//
// (run from `packages/server` — `tsx` is that package's devDependency, not the root's).
//
// It prints a JSON object `{ [caseKey]: passed }`. The recorded PRE column lives in
// `gate-power.test.ts` as `PRE_TRA3368_PASSED`; re-derive it with this script on the
// pre-fix tree, NEVER by reasoning about the old source — that substitution is exactly
// what TRA-2361 AC5 forbids, and the reason is that the old code is the thing under test.

import { MONOTONICITY_CASES } from '../packages/server/src/gate-sleeve-blocking-fixtures.ts';
import { buildForwardTestReport } from '../packages/server/src/options-forward-test.ts';
import {
  evaluateLiveCapitalGate,
  resolveLiveCapitalGateCriteria,
} from '../packages/server/src/live-capital-gate.ts';

// The same bar the shipped suite grades these fixtures against (`BAR = 0.2`, the live
// cost-aware safety margin) — a differential measured against a different bar would be a
// comparison of two different questions.
const CRITERIA = resolveLiveCapitalGateCriteria({ ENABLE_OPTION_COST_AWARE_GATE: '1' });
const AS_OF = Date.parse('2026-02-23T16:00:00.000Z');

const out = {};
for (const c of MONOTONICITY_CASES()) {
  const report = buildForwardTestReport(c.outcomes, { asOf: AS_OF });
  out[c.key] = evaluateLiveCapitalGate(report, CRITERIA).passed;
}
console.log(JSON.stringify(out, null, 2));
