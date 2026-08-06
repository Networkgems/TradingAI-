// TRA-3065 — does a sub-2.0 corporate action evade BOTH plausibility detectors?
//
// Ship a checker, never a dated green (the TRA-2634 house rule). Everything the
// TRA-3065 comment thread claims is printed by this script, and re-running it is
// how anyone confirms the claim still holds after either threshold moves.
//
// ⛔ Run `pnpm --filter @trading-app/shared build` FIRST. This imports the BUILT
// bytes from `packages/shared/dist`; a stale-but-present symbol would grade last
// week's logic and print a confident number.
//
// ── WHAT IS BEING MEASURED ────────────────────────────────────────────────────
//
// Construct the two-row artifact a corporate action actually produces, for a
// grid of action factors, under BOTH candidate feed behaviours, and run the two
// DEPLOYED predicates over it. No re-implementation of either rule lives here —
// a harness that re-derives the thing it grades grades itself.
//
//   D-1  pre-action session. Our published close is the pre-action level P0.
//   D    ex-date. The traded price is P1 = (P0 / k) * (1 + m), where `k` is the
//        action factor (3:2 forward => k = 1.5; 1:2 reverse => k = 0.5) and `m`
//        is any GENUINE session move layered on top of the action.
//
//   (a) UNADJUSTED feed  prevClose_D = P0        (the pre-action level)
//   (b) ADJUSTED   feed  prevClose_D = P0 / k    (retroactively restated)
//
// `changePct` is then computed the way `yahoo-feed.ts:1490-1494` computes it —
// (price - prevClose)/prevClose*100 — because that arithmetic is the whole
// premise of the module under test.
//
// The `m` sweep is the load-bearing part. A single m = 0 row cannot distinguish
// "passes at this factor" from "passes at this factor ONLY because the
// economics happened to be flat", and the session rule's exposure to a
// corporate action is entirely a function of m.
import {
  assessQuotePlausibility,
  assessLevelContinuity,
  SUSPECT_MOVE_RATIO,
  CONTINUITY_RESIDUAL_TOLERANCE,
} from '../packages/shared/dist/index.js';

const P0 = 12.34;          // pre-action published close. Any positive level does.
const PRIOR_PCT = 1.23;    // D-1's own session move; the rules never read it except
                           // through the republication guard, which must not fire.

/** Action factors. `k > 1` forward split (price falls), `k < 1` reverse (price rises). */
const ACTIONS = [
  { label: '5:4 forward', k: 5 / 4 },
  { label: '4:3 forward', k: 4 / 3 },
  { label: '3:2 forward', k: 3 / 2 },
  { label: '2:1 forward', k: 2 },
  { label: '3:1 forward', k: 3 },
  { label: '2:3 reverse', k: 2 / 3 },
  { label: '1:2 reverse', k: 1 / 2 },
  { label: '1:3 reverse', k: 1 / 3 },
];

/** Genuine session move layered on top of the action, in percent. */
const GENUINE_MOVES = [-30, -25, -10, 0, +10, +25, +100, +200];

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Build the D row a feed publishes for one (action, genuine move, behaviour).
 * `changePct` is rounded to 2 dp because that is the publication grid both
 * thresholds were derived against — carrying full precision here would grade a
 * row we never store.
 */
function buildRow(k, mPct, behaviour) {
  const price = (P0 / k) * (1 + mPct / 100);
  const feedPrevClose = behaviour === 'a' ? P0 : P0 / k;
  const changePct = round2(((price - feedPrevClose) / feedPrevClose) * 100);
  return { price, changePct, feedPrevClose };
}

const prior = { price: P0, changePct: PRIOR_PCT };

let evadesBoth = 0;
let rows = 0;
const perBehaviour = { a: { session: 0, continuity: 0, either: 0, n: 0 },
                       b: { session: 0, continuity: 0, either: 0, n: 0 } };
/** Residuals seen under (a), to test the "exactly 1.000" claim empirically. */
const residualsA = [];
const abstains = new Map();

const table = [];
for (const { label, k } of ACTIONS) {
  for (const behaviour of ['a', 'b']) {
    for (const m of GENUINE_MOVES) {
      const cur = buildRow(k, m, behaviour);
      const session = assessQuotePlausibility({ price: cur.price, changePct: cur.changePct });
      const cont = assessLevelContinuity(prior, cur);

      const sessionFires = session.suspect;
      // ⛔ 'abstain' is NOT 'consistent'. A blind instrument does not defend a row.
      const contFires = cont.verdict === 'suspect';
      const caught = sessionFires || contFires;

      rows++;
      const b = perBehaviour[behaviour];
      b.n++;
      if (sessionFires) b.session++;
      if (contFires) b.continuity++;
      if (caught) b.either++;
      if (!caught) evadesBoth++;
      if (behaviour === 'a' && cont.residual !== null) residualsA.push(cont.residual);
      if (cont.verdict === 'abstain') {
        abstains.set(cont.reason, (abstains.get(cont.reason) ?? 0) + 1);
      }

      table.push({
        action: label,
        feed: behaviour === 'a' ? 'unadjusted' : 'adjusted',
        genuineMovePct: m,
        price: Number(cur.price.toFixed(4)),
        publishedPct: cur.changePct,
        sessionRatio: session.ratio === null ? null : Number(session.ratio.toFixed(4)),
        sessionFires,
        residual: cont.residual === null ? null : Number(cont.residual.toFixed(6)),
        contVerdict: cont.verdict,
        caught,
      });
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`TRA-3065 — corporate-action evasion grid`);
console.log(`  SUSPECT_MOVE_RATIO = ${SUSPECT_MOVE_RATIO}`
  + `   CONTINUITY_RESIDUAL_TOLERANCE = ${CONTINUITY_RESIDUAL_TOLERANCE}`);
console.log(`  P0 = ${P0}  actions = ${ACTIONS.length}  genuine-move sweep = ${GENUINE_MOVES.join(',')}%`);
console.log('');

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
console.log([pad('action', 12), pad('feed', 11), lpad('m%', 5), lpad('price', 9),
  lpad('pubPct', 10), lpad('sessR', 8), lpad('sess', 5), lpad('resid', 10),
  pad('  continuity', 13), 'CAUGHT?'].join(' '));
console.log('-'.repeat(104));
for (const r of table) {
  console.log([pad(r.action, 12), pad(r.feed, 11), lpad(r.genuineMovePct, 5),
    lpad(r.price, 9), lpad(r.publishedPct, 10),
    lpad(r.sessionRatio ?? 'n/a', 8), lpad(r.sessionFires ? 'FIRE' : '.', 5),
    lpad(r.residual ?? 'n/a', 10), pad('  ' + r.contVerdict, 13),
    r.caught ? 'caught' : '*** EVADES BOTH ***'].join(' '));
}

console.log('');
console.log(`rows=${rows}  evade-both=${evadesBoth}`);
for (const beh of ['a', 'b']) {
  const b = perBehaviour[beh];
  console.log(`  feed (${beh}) ${beh === 'a' ? 'UNADJUSTED' : 'ADJUSTED  '}:`
    + ` n=${b.n} sessionFires=${b.session} continuityFires=${b.continuity}`
    + ` caughtByEither=${b.either} evades=${b.n - b.either}`);
}
if (abstains.size > 0) {
  console.log(`  continuity abstains: ${[...abstains].map(([k, v]) => `${k}=${v}`).join(' ')}`);
} else {
  console.log(`  continuity abstains: none (the republication guard never fired — good,`
    + ` an abstain here would have made the grid ungradeable rather than clean)`);
}

// ── The two claims this script exists to settle, asserted, not narrated. ───────
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
console.log('');

// CLAIM 1 — under (a) the continuity residual is ALGEBRAICALLY FORCED to 1, for
// every action factor and every genuine move. impliedPrevClose(today) recovers
// the feed's own prevClose, and under (a) that IS our published prior close.
//
// The residual is not EXACTLY 1 only because `changePct` is published on a 2-dp
// grid. The bound is derived, not fitted — it is the same expression the
// CONTINUITY_RESIDUAL_TOLERANCE docblock uses: a half-grid of 0.005 pct points
// gives d(impliedPrev)/impliedPrev = 0.005 / |100 + pct|. Asserting against a
// hand-picked constant would have let a real residual hide inside my slack.
const worstA = residualsA.length ? Math.max(...residualsA) : NaN;
const roundingBound = 1 + Math.max(...table
  .filter(r => r.feed === 'unadjusted')
  .map(r => 0.005 / Math.abs(100 + r.publishedPct)));
check('(a) continuity residual is 1 to within the 2-dp publication grid, always',
  residualsA.length > 0 && worstA <= roundingBound,
  `n=${residualsA.length} max residual=${worstA.toFixed(9)}`
  + ` <= derived rounding bound ${roundingBound.toFixed(9)}`
  + ` (tolerance ${CONTINUITY_RESIDUAL_TOLERANCE} is ${((CONTINUITY_RESIDUAL_TOLERANCE - 1) / (worstA - 1)).toFixed(0)}x further away)`);

// CLAIM 2 — the continuity rule NEVER fires under (a), at ANY action factor.
const contFiresUnderA = table.filter(r => r.feed === 'unadjusted' && r.contVerdict === 'suspect');
check('(a) continuity rule never fires on an unadjusted corporate action',
  contFiresUnderA.length === 0,
  `fired on ${contFiresUnderA.length} of ${perBehaviour.a.n} rows`);

// CLAIM 3 — the gap is real: at least one sub-2.0 action evades BOTH under (a).
const gapRows = table.filter(r => r.feed === 'unadjusted' && !r.caught);
const flat32 = table.find(r => r.action === '3:2 forward' && r.feed === 'unadjusted' && r.genuineMovePct === 0);
check('(a) a flat 3:2 forward split evades BOTH detectors',
  flat32 !== undefined && !flat32.caught,
  flat32 ? `published ${flat32.publishedPct}% at ratio ${flat32.sessionRatio},`
    + ` residual ${flat32.residual} => ${flat32.contVerdict}` : 'row not built');
check('(a) the evasion set is non-empty across the grid',
  gapRows.length > 0,
  `${gapRows.length} of ${perBehaviour.a.n} unadjusted rows evade both`);

// CLAIM 4 — under (b) the continuity rule DOES fire (so the fork genuinely has
// opposite outcomes and the question is not vacuous).
const contFiresUnderB = table.filter(r => r.feed === 'adjusted' && r.contVerdict === 'suspect');
check('(b) continuity rule fires on an adjusted feed across the action',
  contFiresUnderB.length === perBehaviour.b.n,
  `fired on ${contFiresUnderB.length} of ${perBehaviour.b.n} rows`);

// CLAIM 5 — the SESSION rule's exposure under (a) is a pure function of the
// action factor and the genuine move, and 2:1 is the smallest factor caught FLAT.
const flatUnadjusted = table.filter(r => r.feed === 'unadjusted' && r.genuineMovePct === 0);
const smallestCaughtFlat = flatUnadjusted.filter(r => r.caught).map(r => r.sessionRatio).sort((x, y) => x - y)[0];
check('(a) the smallest FLAT action factor caught at all is exactly 2.000',
  smallestCaughtFlat !== undefined && Math.abs(smallestCaughtFlat - 2) < 1e-9,
  `smallest caught flat ratio = ${smallestCaughtFlat}`);

// CLAIM 6 — ⭐ "2:1 is caught" is a KNIFE EDGE, not a floor. Under (a) the
// session ratio is max((1+m)/k, k/(1+m)) — a function of the genuine move too,
// not of the action factor alone. r = 2.000 exactly is the m = 0 case, and the
// comparison is `>=`, so ANY genuine move in the direction that partially
// offsets the action drops a 2:1 back under the bar.
const caught21 = table.filter(r => r.action === '2:1 forward' && r.feed === 'unadjusted' && r.caught);
const evades21 = table.filter(r => r.action === '2:1 forward' && r.feed === 'unadjusted' && !r.caught);
check('(a) a 2:1 forward split is caught only on a knife edge, not as a class',
  evades21.length > 0,
  `caught ${caught21.length}/${caught21.length + evades21.length} of the sweep;`
  + ` it evades at genuine moves of ${evades21.map(r => `${r.genuineMovePct > 0 ? '+' : ''}${r.genuineMovePct}%`).join(', ')}`);

// CLAIM 7 — how far the price must ALSO genuinely move for the session rule to
// reach an action of factor k. Printed as the size of the hole, not just its
// existence: `caught <=> m <= k/R - 1 or m >= R*k - 1`.
console.log('');
console.log(`SIZE OF THE HOLE under feed (a), by action factor. The session rule (R = ${SUSPECT_MOVE_RATIO})`);
console.log(`reaches an action ONLY when the stock ALSO genuinely moves outside this window;`);
console.log(`inside it the fabricated headline ships with both verdicts clean:`);
console.log('');
console.log([pad('  action', 14), lpad('k', 7), lpad('needs m <=', 12), lpad('or m >=', 12),
  lpad('flat-day r', 12), '  flat day'].join(' '));
console.log('-'.repeat(72));
for (const { label, k } of ACTIONS) {
  const down = (k / SUSPECT_MOVE_RATIO - 1) * 100;
  const up = (SUSPECT_MOVE_RATIO * k - 1) * 100;
  const flatR = Math.max(1 / k, k);
  console.log([pad('  ' + label, 14), lpad(k.toFixed(4), 7),
    lpad(`${down.toFixed(2)}%`, 12), lpad(`+${up.toFixed(2)}%`, 12),
    lpad(flatR.toFixed(4), 12),
    '  ' + (flatR >= SUSPECT_MOVE_RATIO ? 'caught' : 'EVADES')].join(' '));
}

console.log('');
console.log(failures === 0 ? 'ALL CLAIMS PASS' : `${failures} CLAIM(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
