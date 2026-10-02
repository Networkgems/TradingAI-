#!/usr/bin/env node
// TRA-4978 item 3 — THE PER-CELL INPUT-AGE ASSERTION, so this does not need a
// human to notice `ok: false`.
//
// ── WHY A SCRIPT AND NOT JUST A FIELD ────────────────────────────────────────
// TRA-4783 published `arm.costBar.edge.freshness.inputStale`. It read `true`
// from roughly 2026-08-18 and NOTHING CONSUMED IT; it was found by hand off a
// postmarket review five weeks later. TRA-4875 then published the same verdict
// per cell, on the decision row, and flipped the route to `ok: false` — which is
// strictly better and still needs somebody to look at a route. This exits
// non-zero, so a cron/CI/heartbeat caller notices without reading JSON.
//
// ── WHAT IT GRADES, AND WHAT IT DELIBERATELY DOES NOT ────────────────────────
// It grades the `cost_bar_edge_input_stale` degradation the route already emits.
// It makes no verdict of its own about the market, the bar, or whether anything
// should be admitted — a stale estimator must keep refusing (TRA-4875 item 3),
// and nothing here can relax a gate.
//
// ⚠️ The ESCALATED case is NOT "a cell is stale". It is "a cell is stale AND the
// stale constant is actually DECIDING live refusals" — `decisionsDecidedByStaleInput
// > 0`. Measured live on `faae9388` 2026-10-01: four stale cells,
// `decisionsBlocked: 20678`, and since 2026-09-25 **zero** decisions made off the
// constant (100% `insufficient_real_fill_evidence`, refused upstream of the
// comparison). A grader that paged on staleness alone would have paged every
// beat for a condition enforcing nothing, which is how a signal earns its way to
// being ignored — the exact failure mode TRA-4875's own header describes.
//
//   0 CLEAN      no cost_bar cell is over the route's own threshold
//   1 DEGRADED   >=1 cell over threshold, the constant is deciding NOTHING, and
//                the sleeve stand-down is published. Disclosed and inert.
//   2 usage
//   3 BLIND      unreachable / unparseable / the shape changed / a coverage hole
//   5 GOVERNING  >=1 cell over threshold AND the stale constant is deciding live
//                refusals right now. The case a human must see.
//
// Precedence BLIND > GOVERNING > DEGRADED > CLEAN. "Could not check" and
// "checked and it is fine" must never share an exit code.
//
// ⛔ `degraded`/`attention`, never `alarm` (TRA-4978 AC4). TRA-3711 is the
// precedent: the live-NAV tripwire reads `alarm: false` while its own verdict is
// `blind`, so on this codebase `alarm` has already been shown to coexist with a
// dead instrument. The condition this grades is the EXPECTED steady state while
// the sleeve is stood down, and a channel whose signal value depends on being
// rare must not carry it.
//
// Usage:
//   node scripts/check-cost-bar-input-age.mjs [--host=<url>] [--fixture=<file>]
//   node scripts/check-cost-bar-input-age.mjs --selftest

import { readFileSync } from 'node:fs';

const DEFAULT_HOST = 'https://tradingai-bqb1.onrender.com';
const ROUTE = '/api/health/live-enforce-gates';
const CODE = 'cost_bar_edge_input_stale';

const EXIT = { CLEAN: 0, DEGRADED: 1, USAGE: 2, BLIND: 3, GOVERNING: 5 };

function usage(msg) {
  if (msg) console.error(`[cost-bar-input-age] ${msg}`);
  console.error(
    'usage: node scripts/check-cost-bar-input-age.mjs [--host=<url>] [--fixture=<file>] [--selftest]',
  );
  console.error('  exits: 0 CLEAN · 1 DEGRADED · 2 usage · 3 BLIND · 5 GOVERNING');
  return EXIT.USAGE;
}

/**
 * Grade one payload. PURE, so the controls below exercise the real predicate
 * rather than a second copy of it.
 *
 * Fails CLOSED on every shape it cannot read: an absent `degradations` key, a
 * non-array, a degradation missing the TRA-4978 split, or a cell whose
 * `tapeAgeDaysAtDecisionMax` is null (unknown age ⇒ the bar cannot be applied).
 */
export function gradeCostBarInputAge(payload) {
  if (payload === null || typeof payload !== 'object') {
    return { exit: EXIT.BLIND, reason: 'payload is not an object' };
  }
  const degradations = payload.degradations;
  if (!Array.isArray(degradations)) {
    return {
      exit: EXIT.BLIND,
      reason: '`degradations` is absent or not an array — the route shape changed',
    };
  }
  const entry = degradations.find((d) => d && d.code === CODE) ?? null;
  if (entry === null) {
    return { exit: EXIT.CLEAN, reason: `no ${CODE} degradation — every deciding cell is inside its bar` };
  }
  if (!Array.isArray(entry.cells) || entry.cells.length === 0) {
    return { exit: EXIT.BLIND, reason: `${CODE} carries no \`cells\` array` };
  }
  if (typeof entry.thresholdDays !== 'number' || !Number.isFinite(entry.thresholdDays)) {
    return { exit: EXIT.BLIND, reason: `${CODE} carries no numeric \`thresholdDays\`` };
  }
  // ⛔ Read the bar off the ROUTE, never a literal here. The threshold is the
  // route's own constant (`TAPE_INPUT_STALE_THRESHOLD_DAYS`); a copy in this file
  // would silently disagree with the thing it is grading the moment it moves.
  const bar = entry.thresholdDays;
  if (typeof entry.decisionsDecidedByStaleInput !== 'number') {
    return {
      exit: EXIT.BLIND,
      reason:
        '`decisionsDecidedByStaleInput` is absent — this build predates TRA-4978 and cannot '
        + 'distinguish a refusal MADE BY the stale constant from one made upstream of it',
    };
  }
  const over = [];
  for (const c of entry.cells) {
    if (typeof c?.tapeAgeDaysAtDecisionMax !== 'number') {
      return {
        exit: EXIT.BLIND,
        reason: `cell ${c?.cell ?? '<unnamed>'} carries no numeric tape age — unknown is NOT inside the bar`,
      };
    }
    if (c.tapeAgeDaysAtDecisionMax > bar) over.push(c);
  }
  if (over.length === 0) {
    // The route emitted the degradation but no cell is over the bar as published.
    // That is a contradiction between two of its own fields, not a pass.
    return {
      exit: EXIT.BLIND,
      reason: `${CODE} present but no cell exceeds its own ${bar} d threshold — self-inconsistent payload`,
    };
  }
  const detail = over
    .map(
      (c) =>
        `${c.cell} ${c.tapeAgeDaysAtDecisionMax} d (bar ${bar}), `
        + `${c.decisionsDecidedByStaleInput ?? '?'} decided by the stale constant / `
        + `${c.decisionsShortCircuitedUpstream ?? '?'} refused upstream`,
    )
    .join('; ');
  // ⭐ TRA-4978 (second pass) — GRADE THE RECENCY ARM, NOT THE LIFETIME ONE.
  //
  // `decisionsDecidedByStaleInput` folds the RETAINED archive, which is
  // append-only with no backfill. It went nonzero on 2026-09-09 and will stay
  // nonzero until those rows age out of the 30-day window, whatever anyone does
  // to the input. Keying GOVERNING on it makes this grader unclearable: it would
  // have paged every beat from 2026-09-25 onward for a constant that has decided
  // nothing since 2026-09-24. Same shape as TRA-3703's invariant-derived
  // `breach` — an identity built to EXPOSE a gap cannot grade its remedy.
  //
  // `recency.staleInputGovernsLatestSession` is three-valued and each value gets
  // its own exit: `true` GOVERNING, `false` DEGRADED (dormant, disclosed),
  // `null` BLIND (the latest refusing session carries no classified row, so the
  // question was not answered — and unknown is not a clean bill).
  const recency = entry.recency ?? null;
  if (recency !== null && typeof recency === 'object') {
    const governs = recency.staleInputGovernsLatestSession;
    if (governs === null || governs === undefined) {
      return {
        exit: EXIT.BLIND,
        reason:
          `${CODE} recency arm is NOT COMPUTABLE on the latest refusing session `
          + `(${recency.latestEtDayWithRefusals ?? 'unknown day'}): `
          + `${recency.latestSessionUnclassified ?? '?'} refusal(s) carry no reason code. ${detail}`,
      };
    }
    if (governs === true) {
      return {
        exit: EXIT.GOVERNING,
        reason:
          `${over.length} cell(s) over the ${bar} d bar AND the stale constant DECIDED `
          + `${recency.latestSessionDecidedByStaleInput ?? '?'} refusal(s) on the latest session `
          + `(${recency.latestEtDayWithRefusals ?? 'unknown day'}): ${detail}`,
      };
    }
  } else if (entry.decisionsDecidedByStaleInput > 0) {
    // No `recency` key: a build that predates this pass. Fall back to the
    // lifetime arm so the grader still reports SOMETHING, but say out loud that
    // the arm it fell back to cannot clear — a silent fallback to a latching
    // predicate is how the misattribution this ticket fixes survived five weeks.
    return {
      exit: EXIT.GOVERNING,
      reason:
        `recency arm ABSENT (build predates TRA-4978 second pass) — graded on the LIFETIME arm, `
        + `WHICH CANNOT CLEAR: ${over.length} cell(s) over the ${bar} d bar and the stale constant `
        + `decided ${entry.decisionsDecidedByStaleInput} refusal(s) at SOME point in the retained `
        + `fold, not necessarily recently: ${detail}`,
    };
  }
  const standDown = entry.standDown ?? null;
  if (standDown === null || typeof standDown.verdict !== 'string') {
    return {
      exit: EXIT.BLIND,
      reason: `${CODE} carries no \`standDown.verdict\` — the fail direction is unpublished`,
    };
  }
  const since = recency === null || typeof recency !== 'object'
    ? ''
    : ` DORMANT since ${recency.latestEtDayDecidedByStaleInput ?? 'never'}`
      + `${typeof recency.sessionsSinceStaleInputLastDecided === 'number' ? ` (${recency.sessionsSinceStaleInputLastDecided} refusing session(s) ago)` : ''}`
      + ' — dormant is NOT clear: the constant resumes governing the instant the upstream arm admits.';
  return {
    exit: EXIT.DEGRADED,
    reason:
      `${over.length} cell(s) over the ${bar} d bar, deciding NOTHING `
      + `(${entry.decisionsShortCircuitedUpstream ?? '?'} refused upstream of the constant). `
      + `Sleeve: ${standDown.verdict}`
      + `${standDown.bindingConstraint ? ` (binding: ${standDown.bindingConstraint})` : ''}.${since} ${detail}`,
  };
}

// ── controls ────────────────────────────────────────────────────────────────
// One per arm, including both BLIND directions. A grader with no negative
// control cannot tell "the predicate holds" from "the predicate never ran".

function cell(over = {}) {
  return {
    cell: 'single_leg_otm::0.30-0.40',
    tapeAgeDaysAtDecisionMax: 57.9,
    decisionsBlocked: 600,
    decisionsEvaluated: 600,
    decisionsDecidedByStaleInput: 0,
    decisionsShortCircuitedUpstream: 600,
    ...over,
  };
}
function payload(over = {}) {
  return {
    degradations: [
      {
        code: CODE,
        thresholdDays: 10,
        cells: [cell()],
        decisionsBlocked: 600,
        decisionsDecidedByStaleInput: 0,
        decisionsShortCircuitedUpstream: 600,
        standDown: { verdict: 'NOT_TRADEABLE', bindingConstraint: 'insufficient_real_fill_evidence' },
        ...over,
      },
    ],
  };
}

const CONTROLS = [
  ['CLEAN — no degradation at all', { degradations: [] }, EXIT.CLEAN],
  ['CLEAN — some other degradation', { degradations: [{ code: 'something_else' }] }, EXIT.CLEAN],
  ['DEGRADED — the live 2026-10-01 shape: stale and deciding nothing', payload(), EXIT.DEGRADED],
  [
    'GOVERNING — the pre-2026-09-25 shape: the constant is deciding refusals',
    payload({
      decisionsDecidedByStaleInput: 4226,
      cells: [cell({ decisionsDecidedByStaleInput: 4226, decisionsShortCircuitedUpstream: 4248 })],
    }),
    EXIT.GOVERNING,
  ],
  // ── the TRA-4978 second-pass arms ─────────────────────────────────────────
  // ⭐ THE CONTROL THAT MATTERS. Lifetime 7,179 (nonzero, and it will stay
  // nonzero for the whole retention window) beside a latest session that is
  // 100% upstream. The old predicate paged GOVERNING here forever; the recency
  // arm correctly reports a disclosed, inert condition.
  [
    'DEGRADED — lifetime arm nonzero but DORMANT 5 sessions (the live 2026-10-01 shape)',
    payload({
      decisionsDecidedByStaleInput: 7179,
      cells: [cell({ decisionsDecidedByStaleInput: 4226, decisionsShortCircuitedUpstream: 4373 })],
      recency: {
        latestEtDayWithRefusals: '2026-10-01',
        latestEtDayDecidedByStaleInput: '2026-09-24',
        sessionsSinceStaleInputLastDecided: 5,
        staleInputGovernsLatestSession: false,
        latestSessionDecidedByStaleInput: 0,
        latestSessionShortCircuitedUpstream: 1926,
        latestSessionUnclassified: 0,
      },
    }),
    EXIT.DEGRADED,
  ],
  [
    'GOVERNING — recency says the constant decided on the latest session',
    payload({
      decisionsDecidedByStaleInput: 7219,
      recency: {
        latestEtDayWithRefusals: '2026-10-02',
        latestEtDayDecidedByStaleInput: '2026-10-02',
        sessionsSinceStaleInputLastDecided: 0,
        staleInputGovernsLatestSession: true,
        latestSessionDecidedByStaleInput: 40,
        latestSessionShortCircuitedUpstream: 60,
        latestSessionUnclassified: 0,
      },
    }),
    EXIT.GOVERNING,
  ],
  // The lifetime arm reads ZERO here, which under the old predicate was a clean
  // DEGRADED. It must not be: the latest session is wholly unclassified, so
  // nobody measured whether the constant decided it.
  [
    'BLIND — recency NOT COMPUTABLE: the latest refusing session is unstamped',
    payload({
      recency: {
        latestEtDayWithRefusals: '2026-10-01',
        latestEtDayDecidedByStaleInput: null,
        sessionsSinceStaleInputLastDecided: null,
        staleInputGovernsLatestSession: null,
        latestSessionDecidedByStaleInput: 0,
        latestSessionShortCircuitedUpstream: 0,
        latestSessionUnclassified: 500,
      },
    }),
    EXIT.BLIND,
  ],
  ['BLIND — not an object', null, EXIT.BLIND],
  ['BLIND — no degradations key', {}, EXIT.BLIND],
  ['BLIND — degradations is not an array', { degradations: {} }, EXIT.BLIND],
  ['BLIND — no cells', payload({ cells: [] }), EXIT.BLIND],
  ['BLIND — no threshold', payload({ thresholdDays: null }), EXIT.BLIND],
  [
    'BLIND — pre-TRA-4978 build: no split, so staleness cannot be attributed',
    payload({ decisionsDecidedByStaleInput: undefined }),
    EXIT.BLIND,
  ],
  ['BLIND — a cell with an unknown tape age', payload({ cells: [cell({ tapeAgeDaysAtDecisionMax: null })] }), EXIT.BLIND],
  [
    'BLIND — self-inconsistent: degradation present, no cell over its own bar',
    payload({ cells: [cell({ tapeAgeDaysAtDecisionMax: 1.5 })] }),
    EXIT.BLIND,
  ],
  [
    'BLIND — the fail direction is unpublished',
    payload({ standDown: undefined }),
    EXIT.BLIND,
  ],
];

function selftest() {
  let failed = 0;
  for (const [name, input, want] of CONTROLS) {
    const got = gradeCostBarInputAge(input);
    const ok = got.exit === want;
    if (!ok) failed += 1;
    console.log(`[cost-bar-input-age] ${ok ? 'PASS' : 'FAIL'} ${name} — want ${want}, got ${got.exit} (${got.reason})`);
  }
  console.log(`[cost-bar-input-age] controls: ${CONTROLS.length - failed}/${CONTROLS.length} passed`);
  return failed === 0 ? EXIT.CLEAN : EXIT.BLIND;
}

async function main(argv) {
  let host = process.env.BQB1_HOST ?? DEFAULT_HOST;
  let fixture = null;
  for (const arg of argv) {
    if (arg === '--selftest' || arg === '--controls') return selftest();
    if (arg === '--help' || arg === '-h') {
      usage();
      return EXIT.CLEAN;
    }
    // Values attach with `=` — the TRA-4420 lesson: a positively-matched flag
    // parser silently ignores what it does not recognise and runs anyway.
    if (arg.startsWith('--host=')) host = arg.slice('--host='.length);
    else if (arg.startsWith('--fixture=')) fixture = arg.slice('--fixture='.length);
    else return usage(`unrecognised argument \`${arg}\``);
  }
  let json;
  if (fixture !== null) {
    try {
      json = JSON.parse(readFileSync(fixture, 'utf8'));
    } catch (e) {
      console.error(`[cost-bar-input-age] BLIND — cannot read fixture ${fixture}: ${e.message}`);
      return EXIT.BLIND;
    }
  } else {
    const url = `${host.replace(/\/$/, '')}${ROUTE}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) {
        console.error(`[cost-bar-input-age] BLIND — ${url} returned HTTP ${res.status}`);
        return EXIT.BLIND;
      }
      json = await res.json();
    } catch (e) {
      console.error(`[cost-bar-input-age] BLIND — ${url} unreachable: ${e.message}`);
      return EXIT.BLIND;
    }
    console.log(`[cost-bar-input-age] read ${url} — serving ${json?.build?.commitShort ?? '<unknown commit>'}`);
  }
  const verdict = gradeCostBarInputAge(json);
  const label =
    Object.entries(EXIT).find(([, v]) => v === verdict.exit)?.[0] ?? String(verdict.exit);
  console.log(`[cost-bar-input-age] ${label} — ${verdict.reason}`);
  if (verdict.exit === EXIT.GOVERNING) {
    console.error(
      '[cost-bar-input-age] ⛔ The expectancy constant is DECIDING live refusals off a tape past its '
      + 'bar. Do NOT relax the gate on account of this — a stale estimator should keep refusing. '
      + 'Refresh or re-derive the input, or stand the sleeve down explicitly (TRA-4978).',
    );
  }
  return verdict.exit;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`[cost-bar-input-age] BLIND — unhandled: ${e?.stack ?? e}`);
    process.exit(EXIT.BLIND);
  },
);
