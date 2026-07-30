#!/usr/bin/env node
/**
 * TRA-2630 AC3 — regression guard for the T+1 options-credit lag (TRA-2629),
 * plus the per-leg drift verdicts that replace the ungradeable `drift`.
 *
 * THE SHAPE
 * ---------
 * `stockDaily` for session N equals `optionsDaily` for session N-1, TO THE CENT.
 * The equity book re-books the previous session's realized option credit into
 * this session's STOCK leg.
 *
 * Root cause (TRA-2629, fixed in `ec05639`): the 21:00 ET writer computes
 *
 *     dailyPnl = (equity - openingEquity) - (credited_now - credited_on_last_row)
 *
 * and `PaperAccountSnapshot.optionsCredited` was never declared on the DURABLE
 * type, so `importSnapshot`'s `?? 0` fired on every boot. `equity` came back
 * holding the option credits while the counter that exists to cancel them came
 * back 0. bqb1 restarts several times an hour, so every session lost the left
 * endpoint of that subtraction.
 *
 * WHY THIS SCRIPT EXISTS RATHER THAN A UNIT TEST ALONE
 * ---------------------------------------------------
 * The unit tests in `pnl-reconciliation.test.ts` pin the DETECTOR. They cannot
 * pin the WRITER, because the writer's failure mode is a durability seam — an
 * in-memory export→import round trip passes while production is broken (the
 * TRA-2629 lesson, and the reason the defect supplied a false regression signal
 * on a money ticket for 5 days). Only a live pull, over sessions that actually
 * booted and restarted, can grade it.
 *
 * THE REAL-MONEY AXIS — WHY `mode` IS PARTITIONED, NOT POOLED
 * ----------------------------------------------------------
 * On the 2026-07-30T04:19:30Z pull all 18 lag sessions were `mode: demo` across
 * 13 books, and the single `mode: live` book (`admin`) was clean. That is the
 * whole basis for TRA-2630's demo-only / $0-live-capital verdict, and with it
 * the standing decision NOT to roll back TRA-2323.
 *
 * So a live hit is not "one more row" — it is a NAV overstatement of a full
 * session of realized options P&L (~$68-$250/session at current volumes) and a
 * different severity class entirely. It therefore gets its OWN exit code, and
 * is counted separately so a noisy fixture book can never mask it. Pooling the
 * two is the TRA-2193 trap this endpoint has already been bitten by twice; the
 * 13 demo books are also clone fixtures (`ctoverify_*` / `qa_*` seeded from
 * shared values), so their COUNT overstates breadth — roughly 6 independent
 * books. The live/demo split is the axis that carries meaning.
 *
 * FAILS CLOSED
 * ------------
 * An unreachable endpoint, a non-200, unparseable JSON, or a payload with no
 * engines exits BLIND (3) — never 0. A guard that reports green because it could
 * not read anything is worse than no guard: that is exactly the "ABSENCE IS NOT
 * A PASS" failure this endpoint produced when `admin 2026-07-29` wrote a null
 * EOD row and scored `drift 0` (TRA-2637).
 *
 * EXIT CODES
 * ----------
 *   0  CLEAN     — no book shows the lag; per-leg verdicts reported for info.
 *                  Requires at least one `mode: live` book to have been graded.
 *   1  LIVE LAG  — a `mode: live` book shows it. ESCALATE. Stop netting the
 *                  credit path and re-open the TRA-2323 rollback question.
 *   2  DEMO LAG  — demo books only, live cohort NON-EMPTY and clean. Real,
 *                  $0 live capital at risk.
 *   3  BLIND     — could not grade. Never conflated with a pass. Includes the
 *                  EMPTY LIVE COHORT case: with 0 `mode: live` books the
 *                  real-money tripwire looked at nothing, so "0 live books
 *                  affected" is an absence, not a clean bill of health.
 *
 * USAGE
 * -----
 *   node scripts/check-pnl-options-lag.mjs
 *   node scripts/check-pnl-options-lag.mjs --url=https://host/api/health/pnl-reconciliation
 *   node scripts/check-pnl-options-lag.mjs --file=./recon.json   # grade a saved pull
 *   node scripts/check-pnl-options-lag.mjs --selftest            # both-direction controls
 */

import { readFile } from 'node:fs/promises';

const DEFAULT_URL = 'https://tradingai-bqb1.onrender.com/api/health/pnl-reconciliation';
/** Same penny tolerance the reconciler uses — "to the cent" is the signature. */
const TOLERANCE_USD = 0.01;

const EXIT_CLEAN = 0;
const EXIT_LIVE_LAG = 1;
const EXIT_DEMO_LAG = 2;
const EXIT_BLIND = 3;

/**
 * THE PREDICATE. Returns the lag dates for one book's day list.
 *
 * `days` must be ascending by date. Two terms, both load-bearing:
 *
 *  - exact equality within a cent — the production signature is an exact credit
 *    re-book, so a near-miss is honest trading and must read clean;
 *  - `stockDaily` itself non-zero — without it every quiet day (`stockDaily 0`
 *    after `optionsDaily 0`) satisfies "equal to the cent" and the check fires
 *    on 127 of the 167 clean sessions in the live pull. A predicate that is true
 *    in the passing state has no failing state and measures nothing (the
 *    TRA-2301 / TRA-2642 lesson).
 */
export function findPriorOptionsLagDates(days) {
  const sorted = [...days].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const hits = [];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const prev = sorted[i - 1];
    const sd = Number(cur?.stockDaily);
    const priorOd = Number(prev?.optionsDaily);
    if (!Number.isFinite(sd) || !Number.isFinite(priorOd)) continue;
    if (Math.abs(sd) <= TOLERANCE_USD) continue;
    if (Math.abs(sd - priorOd) <= TOLERANCE_USD) {
      hits.push({ date: cur.date, stockDaily: sd, priorDate: prev.date, priorOptionsDaily: priorOd });
    }
  }
  return hits;
}

/** Grade a whole payload. Pure — no I/O, so `--selftest` can drive it. */
export function gradePayload(payload) {
  const engines = Array.isArray(payload?.engines) ? payload.engines : null;
  if (engines == null || engines.length === 0) {
    return { verdict: 'BLIND', reason: 'payload carried no engines[] array', live: [], demo: [] };
  }
  const live = [];
  const demo = [];
  for (const e of engines) {
    const days = Array.isArray(e?.days) ? e.days : [];
    const hits = findPriorOptionsLagDates(days);
    if (hits.length === 0) continue;
    const row = { username: e.username ?? '(unnamed)', mode: e.mode ?? '(unknown)', hits };
    if (e.mode === 'live') live.push(row);
    else demo.push(row);
  }
  // TRA-2630 follow-up — THE COHORT MUST BE NON-EMPTY BEFORE "no live hit" MEANS
  // ANYTHING. `live.length === 0` has two causes that are indistinguishable from
  // the hit list alone: every live book passed, or there was no live book to
  // grade. Only the second one was true on bqb1 at 2026-07-30T05:16Z — 58/58
  // books resolved `mode: demo` after the TRA-713/TRA-1652 boot-arm failed to
  // converge (`bootArmDrift: ['mode']`), having carried `admin` as `mode: live`
  // three hours earlier. Reporting "0 live books" as reassurance in that state is
  // the same manufactured green as scoring an absent EOD row `drift 0` (TRA-2637).
  const liveBookCount = engines.filter((e) => e?.mode === 'live').length;
  const verdict =
    live.length > 0
      ? 'LIVE_LAG'
      : liveBookCount === 0
        ? 'LIVE_UNMEASURABLE'
        : demo.length > 0
          ? 'DEMO_LAG'
          : 'CLEAN';
  return { verdict, live, demo, engineCount: engines.length, liveBookCount };
}

/**
 * Per-leg drift roll-up, reported alongside the tripwire.
 *
 * ONLY `optionsLeg` IS GRADEABLE (TRA-2633). This function used to present both
 * legs as "the gradeable fields that replace `drift`", which is the instruction
 * TRA-2633 retracted from the endpoint caveat in `32dac46` — that commit touched
 * `pnl-reconciliation.ts` only, so the retracted sentence survived HERE, in the
 * tool the AC2 grader is told to run. Fixed in TRA-2630.
 *
 * The stock leg is options-vs-nothing: `eodStockPnl` is the EOD report's
 * `realizedPnl`, summed from `allClosedPositions` — the list the TRA-219 archive
 * clears at the SAME 21:00 ET the report is written. Measured live on 167/167
 * post-baseline rows, `eodStockPnl == 0`, so `stockLegDrift == -stockDaily` and
 * `stockBad` is a restatement of "the equity delta moved". No fix to stock
 * reconciliation can move it, so a red there is NOT a defect signal.
 *
 * Hence `stockMeasurable`: the count of present rows whose report figure is
 * actually non-zero. When it is 0 the stock leg graded NOTHING and the verdict is
 * tri-state `null` = NOT MEASURED, matching the endpoint's own `stockLegOk`.
 *
 * ABSENCE IS NOT A PASS. `present` counts the rows that actually CARRY
 * `stockLegDrift` / `optionsLegDrift`. A build predating TRA-2630 serves neither
 * field, and counting `undefined` as "not over tolerance" would print
 * `0 offending` — a green that measures nothing, which is the exact failure this
 * endpoint already produced when `admin 2026-07-29` wrote a null EOD row and
 * scored `drift 0` (TRA-2637). The caller must check `present` before reading
 * the counts.
 */
function summarizeLegs(payload) {
  const engines = Array.isArray(payload?.engines) ? payload.engines : [];
  let stockBad = 0;
  let optionsBad = 0;
  let maxStock = 0;
  let maxOptions = 0;
  let graded = 0;
  let present = 0;
  let stockMeasurable = 0;
  for (const e of engines) {
    for (const d of e?.days ?? []) {
      if (d?.belowBaseline) continue;
      graded++;
      const sl = Number(d?.stockLegDrift);
      const ol = Number(d?.optionsLegDrift);
      const hasLegs =
        d?.stockLegDrift !== undefined && d?.optionsLegDrift !== undefined
        && Number.isFinite(sl) && Number.isFinite(ol);
      if (!hasLegs) continue;
      present++;
      // A zeroed report figure means the archive race ate the operand, not that
      // the leg reconciled. Only a non-zero `eodStockPnl` is evidence either way.
      const esp = Number(d?.eodStockPnl);
      if (Number.isFinite(esp) && esp !== 0) stockMeasurable++;
      if (Math.abs(sl) > TOLERANCE_USD) {
        stockBad++;
        maxStock = Math.max(maxStock, Math.abs(sl));
      }
      if (Math.abs(ol) > TOLERANCE_USD) {
        optionsBad++;
        maxOptions = Math.max(maxOptions, Math.abs(ol));
      }
    }
  }
  // Tri-state, deliberately NOT a boolean: `null` = NOT MEASURED. Treating that
  // null as a pass is the bug TRA-2633 exists to stop.
  const stockLegOk = present === 0 || stockMeasurable === 0
    ? null
    : stockBad === 0;
  return {
    graded, present, stockBad, optionsBad, maxStock, maxOptions,
    stockMeasurable, stockLegOk,
    optionsLegOk: present === 0 ? null : optionsBad === 0,
  };
}

async function loadPayload(argv) {
  const fileArg = argv.find((a) => a.startsWith('--file='));
  if (fileArg) {
    const path = fileArg.slice('--file='.length);
    return JSON.parse(await readFile(path, 'utf-8'));
  }
  const urlArg = argv.find((a) => a.startsWith('--url='));
  const url = urlArg ? urlArg.slice('--url='.length) : DEFAULT_URL;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function main(argv) {
  let payload;
  try {
    payload = await loadPayload(argv);
  } catch (err) {
    console.error(`BLIND — could not read the reconciliation payload: ${err.message}`);
    console.error('Exiting 3. This is NOT a pass: an unreadable endpoint grades nothing.');
    return EXIT_BLIND;
  }

  const g = gradePayload(payload);
  if (g.verdict === 'BLIND') {
    console.error(`BLIND — ${g.reason}. Exiting 3; this is NOT a pass.`);
    return EXIT_BLIND;
  }

  const legs = summarizeLegs(payload);
  console.log(`pulled ${payload.time ?? '(no timestamp)'} — ${g.engineCount} engine books`);
  console.log('');
  console.log('TRA-2630 Defect A — per-leg drift. GRADE `optionsLeg` ONLY (TRA-2633):');
  console.log(`  graded sessions (post-baseline) : ${legs.graded}`);
  if (legs.present === 0) {
    console.log('  per-leg drift              : NOT MEASURED — this build serves no');
    console.log('    `stockLegDrift`/`optionsLegDrift`, i.e. it predates TRA-2630. Reporting');
    console.log('    "0 offending" here would be a green over an absent field. Deploy first.');
  } else {
    if (legs.present < legs.graded) {
      console.log(`  WARNING: only ${legs.present}/${legs.graded} graded sessions carry the per-leg fields.`);
    }
    console.log(`  optionsLeg  GRADEABLE           : ${legs.optionsLegOk ? 'OK' : 'RED'} — ${legs.optionsBad}/${legs.present} offending (max |drift| $${legs.maxOptions.toFixed(2)})`);
    const stockVerdict = legs.stockLegOk === null
      ? 'NOT MEASURED'
      : legs.stockLegOk ? 'OK' : 'RED';
    console.log(`  stockLeg    NOT gradeable       : ${stockVerdict} — ${legs.stockBad}/${legs.present} offending (max |drift| $${legs.maxStock.toFixed(2)}),`);
    console.log(`    only ${legs.stockMeasurable}/${legs.present} rows carry a non-zero \`eodStockPnl\`.`);
    if (legs.stockLegOk === null) {
      console.log('    NOT MEASURED is NOT a pass and NOT a defect. `eodStockPnl` is zeroed by the');
      console.log('    TRA-219 21:00 ET archive race, so `stockLegDrift` == -`stockDaily` and the red');
      console.log('    count above just restates "the equity delta moved". No stock-reconciliation');
      console.log('    fix can move it. Do not open a regression off this line (TRA-2633).');
    }
    // The endpoint computes its own `stockLegOk`; if we disagree, one of us is
    // stale and the grader must not silently pick a side.
    if (payload?.stockLegOk !== undefined && payload.stockLegOk !== legs.stockLegOk) {
      console.log(`  WARNING: endpoint stockLegOk=${JSON.stringify(payload.stockLegOk)} but this guard computed`);
      console.log(`    ${JSON.stringify(legs.stockLegOk)} from the same rows. Guard and endpoint disagree — treat BOTH as unread.`);
    }
  }
  console.log(`  NOT gradeable, shown for continuity: ok=${payload.ok} maxDriftUsd=${payload.maxDriftUsd}`);
  console.log('');
  console.log('TRA-2630 AC3 — T+1 options-credit lag (stockDaily == prior session optionsDaily):');

  if (g.verdict === 'CLEAN') {
    console.log(`  CLEAN — 0 books show the lag, on either mode (${g.liveBookCount} live book(s) graded).`);
    return EXIT_CLEAN;
  }

  for (const row of [...g.live, ...g.demo]) {
    console.log(`  ${row.mode === 'live' ? 'LIVE ' : 'demo '} ${row.username}`);
    for (const h of row.hits) {
      console.log(
        `      ${h.date} stockDaily ${h.stockDaily.toFixed(2)} == ${h.priorDate} optionsDaily ${h.priorOptionsDaily.toFixed(2)}`,
      );
    }
  }
  const lagRows = [...g.live, ...g.demo].reduce((n, r) => n + r.hits.length, 0);
  console.log('');

  if (g.live.length > 0) {
    console.error(`LIVE LAG — ${g.live.length} mode:live book(s), ${lagRows} lag session(s) total.`);
    console.error('ESCALATE IMMEDIATELY. This is a real-money NAV overstatement of one session');
    console.error('of realized options P&L. Stop netting the credit path and re-open the');
    console.error('TRA-2323 rollback question — TRA-2630\'s demo-only verdict is now falsified.');
    return EXIT_LIVE_LAG;
  }
  // Ordered ABOVE the demo verdict deliberately. With no live book in the fleet
  // the sentence "0 live books, so $0 live capital is at risk" is not a finding —
  // it is the absence of one, and it must not be printed as reassurance.
  if (g.verdict === 'LIVE_UNMEASURABLE') {
    console.error(
      `BLIND — the real-money tripwire graded NOTHING: 0 of ${g.engineCount} books resolved \`mode: live\`.`,
    );
    console.error('"No live book was affected" and "there was no live book" are the same reading');
    console.error('here, so this is NOT a pass and NOT evidence for the demo-only verdict.');
    if (g.demo.length > 0) {
      console.error(`(${g.demo.length} demo book(s) / ${lagRows} lag session(s) listed above still stand.)`);
    }
    console.error('');
    console.error('DIAGNOSE FIRST — the cohort is usually empty because the operator boot-arm');
    console.error('did not converge, not because the fleet is genuinely all-demo:');
    console.error('  curl -s https://tradingai-bqb1.onrender.com/api/health/options-live');
    console.error('  -> bootArmEligible:true + bootArmDrift:["mode"] means admin SHOULD be live');
    console.error('     and is not (TRA-713 / TRA-1652). Re-arm, then re-run this check.');
    return EXIT_BLIND;
  }
  console.error(
    `DEMO LAG — ${g.demo.length} demo book(s), ${lagRows} lag session(s). ${g.liveBookCount} live book(s) graded, 0 affected.`,
  );
  console.error('Real, but $0 live trading capital at risk. TRA-2630 Defect B / TRA-2629.');
  console.error('Note: ctoverify_* / qa_* are clone fixtures, so book COUNT overstates breadth.');
  return EXIT_DEMO_LAG;
}

/**
 * Both-direction controls. Every one of these is a state the live pull actually
 * produced or a mutation of the predicate that must not pass silently.
 */
function selftest() {
  const cases = [];
  const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    cases.push({ name, ok, actual, expected });
  };

  // POSITIVE — the live Richard sequence: two consecutive exact re-books.
  check(
    'fires on the live Richard 07-28/07-29 lag',
    findPriorOptionsLagDates([
      { date: '2026-07-27', stockDaily: 0, optionsDaily: 67.5 },
      { date: '2026-07-28', stockDaily: 67.5, optionsDaily: 22.5 },
      { date: '2026-07-29', stockDaily: 22.5, optionsDaily: -5.11 },
    ]).map((h) => h.date),
    ['2026-07-28', '2026-07-29'],
  );

  // NEGATIVE — the clean live `admin` book. Both sessions have a non-zero
  // stockDaily AND a non-zero prior optionsDaily, so this is a real pass and
  // not an absence artifact.
  check(
    'stays clean on the live admin book (the demo-only verdict rests on this)',
    findPriorOptionsLagDates([
      { date: '2026-07-27', stockDaily: 0, optionsDaily: 140 },
      { date: '2026-07-28', stockDaily: -0.94, optionsDaily: 68 },
      { date: '2026-07-29', stockDaily: -17.87, optionsDaily: 250.01 },
    ]),
    [],
  );

  // NEGATIVE — the mutation that matters. Quiet days are "equal to the cent".
  check(
    'MUTATION: quiet days (0 == 0) do NOT fire',
    findPriorOptionsLagDates([
      { date: '2026-07-27', stockDaily: 0, optionsDaily: 0 },
      { date: '2026-07-28', stockDaily: 0, optionsDaily: 0 },
      { date: '2026-07-29', stockDaily: 0, optionsDaily: 140 },
    ]),
    [],
  );

  // NEGATIVE — a cent of separation is honest trading.
  check(
    'MUTATION: a near-miss (67.51 vs 67.50) does NOT fire',
    findPriorOptionsLagDates([
      { date: '2026-07-27', stockDaily: 0, optionsDaily: 67.5 },
      { date: '2026-07-28', stockDaily: 67.51, optionsDaily: 0 },
    ]),
    [],
  );

  // ORDERING — an unsorted day list must not change the verdict.
  check(
    'sorts before comparing — verdict is order-independent',
    findPriorOptionsLagDates([
      { date: '2026-07-28', stockDaily: 67.5, optionsDaily: 22.5 },
      { date: '2026-07-27', stockDaily: 0, optionsDaily: 67.5 },
    ]).map((h) => h.date),
    ['2026-07-28'],
  );

  // MODE PARTITION — a live hit must not be absorbed by demo noise.
  check(
    'a LIVE hit outranks demo hits',
    gradePayload({
      engines: [
        { username: 'qa_x', mode: 'demo', days: [
          { date: '2026-07-27', stockDaily: 0, optionsDaily: 450 },
          { date: '2026-07-28', stockDaily: 450, optionsDaily: 0 },
        ] },
        { username: 'admin', mode: 'live', days: [
          { date: '2026-07-27', stockDaily: 0, optionsDaily: 68 },
          { date: '2026-07-28', stockDaily: 68, optionsDaily: 0 },
        ] },
      ],
    }).verdict,
    'LIVE_LAG',
  );

  check(
    'demo-only hits grade DEMO_LAG, not LIVE_LAG',
    gradePayload({
      engines: [
        { username: 'qa_x', mode: 'demo', days: [
          { date: '2026-07-27', stockDaily: 0, optionsDaily: 450 },
          { date: '2026-07-28', stockDaily: 450, optionsDaily: 0 },
        ] },
        { username: 'admin', mode: 'live', days: [
          { date: '2026-07-27', stockDaily: 0, optionsDaily: 140 },
          { date: '2026-07-28', stockDaily: -0.94, optionsDaily: 68 },
        ] },
      ],
    }).verdict,
    'DEMO_LAG',
  );

  // FAILS CLOSED — AN EMPTY LIVE COHORT IS BLIND, NEVER CLEAN OR DEMO_LAG.
  // This is the bqb1 2026-07-30T05:16Z state: 58 demo books, 0 live, because the
  // boot-arm left `bootArmDrift: ['mode']`. The pre-fix code read `true` here.
  check(
    'an all-demo fleet with NO lag is LIVE_UNMEASURABLE, not CLEAN',
    gradePayload({
      engines: [
        { username: 'qa_x', mode: 'demo', days: [
          { date: '2026-07-27', stockDaily: 0, optionsDaily: 140 },
          { date: '2026-07-28', stockDaily: -0.94, optionsDaily: 68 },
        ] },
      ],
    }).verdict,
    'LIVE_UNMEASURABLE',
  );

  check(
    'an all-demo fleet WITH demo lag is LIVE_UNMEASURABLE, not DEMO_LAG',
    gradePayload({
      engines: [
        { username: 'Richard', mode: 'demo', days: [
          { date: '2026-07-27', stockDaily: 0, optionsDaily: 67.5 },
          { date: '2026-07-28', stockDaily: 67.5, optionsDaily: 22.5 },
        ] },
      ],
    }).verdict,
    'LIVE_UNMEASURABLE',
  );

  // POSITIVE CONTROL for the same predicate — the ONLY difference from the case
  // above is that a live book exists and is clean. Without this pair the new
  // verdict could be hardwired on and nothing would notice.
  check(
    'the SAME demo lag grades DEMO_LAG once one clean live book is present',
    gradePayload({
      engines: [
        { username: 'Richard', mode: 'demo', days: [
          { date: '2026-07-27', stockDaily: 0, optionsDaily: 67.5 },
          { date: '2026-07-28', stockDaily: 67.5, optionsDaily: 22.5 },
        ] },
        { username: 'admin', mode: 'live', days: [
          { date: '2026-07-27', stockDaily: 0, optionsDaily: 140 },
          { date: '2026-07-28', stockDaily: -0.94, optionsDaily: 68 },
        ] },
      ],
    }).verdict,
    'DEMO_LAG',
  );

  // `sandbox` is a THIRD mode (stockModeKey: 'demo' | 'live' | 'sandbox'). A book
  // armed live but pointed at the Tradier sandbox routes paper fills, so it is
  // correctly OUTSIDE the real-money tripwire — and it must not be mistaken for
  // live coverage either.
  check(
    'a sandbox-mode book does NOT satisfy the live cohort',
    gradePayload({
      engines: [
        { username: 'admin', mode: 'sandbox', days: [
          { date: '2026-07-27', stockDaily: 0, optionsDaily: 140 },
          { date: '2026-07-28', stockDaily: -0.94, optionsDaily: 68 },
        ] },
      ],
    }).verdict,
    'LIVE_UNMEASURABLE',
  );

  check(
    'liveBookCount counts only mode:live',
    gradePayload({
      engines: [
        { username: 'a', mode: 'demo', days: [] },
        { username: 'b', mode: 'sandbox', days: [] },
        { username: 'c', mode: 'live', days: [] },
      ],
    }).liveBookCount,
    1,
  );

  // FAILS CLOSED — an empty payload is BLIND, never CLEAN.
  check('an engine-less payload is BLIND, not CLEAN', gradePayload({ engines: [] }).verdict, 'BLIND');
  check('a malformed payload is BLIND, not CLEAN', gradePayload({}).verdict, 'BLIND');

  // ABSENCE IS NOT A PASS — a pre-TRA-2630 payload must report the per-leg
  // fields as NOT MEASURED, never as 0 offending.
  check(
    'per-leg fields absent ⇒ present:0, NOT a clean count',
    summarizeLegs({
      engines: [{ username: 'admin', mode: 'live', days: [
        { date: '2026-07-28', stockDaily: -0.94, optionsDaily: 68, drift: 0.94 },
      ] }],
    }),
    {
      graded: 1, present: 0, stockBad: 0, optionsBad: 0, maxStock: 0, maxOptions: 0,
      stockMeasurable: 0, stockLegOk: null, optionsLegOk: null,
    },
  );

  // TRA-2633 — the stock leg is structurally zero, so a red count there is a
  // restatement of `stockDaily`, not a defect. This is the LIVE shape: the row
  // carries a non-zero equity delta and an `eodStockPnl` the archive race zeroed.
  check(
    'stock leg with a ZEROED eodStockPnl ⇒ stockLegOk null (NOT MEASURED), not false',
    summarizeLegs({
      engines: [{ username: 'admin', mode: 'live', days: [
        { date: '2026-07-28', stockDaily: 22.5, eodStockPnl: 0, stockLegDrift: -22.5, optionsLegDrift: 0 },
      ] }],
    }),
    {
      graded: 1, present: 1, stockBad: 1, optionsBad: 0, maxStock: 22.5, maxOptions: 0,
      stockMeasurable: 0, stockLegOk: null, optionsLegOk: true,
    },
  );

  // MUTATION — if `eodStockPnl` is ever genuinely reported, the leg becomes
  // measurable and MUST go back to a hard boolean. Guards against "always null".
  check(
    'MUTATION: a non-zero eodStockPnl makes the stock leg measurable again ⇒ false',
    summarizeLegs({
      engines: [{ username: 'admin', mode: 'live', days: [
        { date: '2026-07-28', stockDaily: 22.5, eodStockPnl: 10, stockLegDrift: -12.5, optionsLegDrift: 0 },
      ] }],
    }),
    {
      graded: 1, present: 1, stockBad: 1, optionsBad: 0, maxStock: 12.5, maxOptions: 0,
      stockMeasurable: 1, stockLegOk: false, optionsLegOk: true,
    },
  );

  // The gradeable leg must stay falsifiable in BOTH directions.
  check(
    'options leg over tolerance ⇒ optionsLegOk false (the one gradeable signal)',
    summarizeLegs({
      engines: [{ username: 'admin', mode: 'live', days: [
        { date: '2026-07-17', stockDaily: 0, eodStockPnl: 0, stockLegDrift: 0, optionsLegDrift: 217.5 },
      ] }],
    }),
    {
      graded: 1, present: 1, stockBad: 0, optionsBad: 1, maxStock: 0, maxOptions: 217.5,
      stockMeasurable: 0, stockLegOk: null, optionsLegOk: false,
    },
  );

  // A book with no lag at all contributes nothing.
  check(
    'a fully clean payload grades CLEAN',
    gradePayload({
      engines: [{ username: 'admin', mode: 'live', days: [
        { date: '2026-07-27', stockDaily: 12.5, optionsDaily: 68 },
        { date: '2026-07-28', stockDaily: -0.94, optionsDaily: 22.5 },
      ] }],
    }).verdict,
    'CLEAN',
  );

  let failed = 0;
  for (const c of cases) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
    if (!c.ok) {
      failed++;
      console.log(`        expected ${JSON.stringify(c.expected)}`);
      console.log(`        actual   ${JSON.stringify(c.actual)}`);
    }
  }
  console.log('');
  console.log(`${cases.length - failed}/${cases.length} controls passed`);
  return failed === 0 ? EXIT_CLEAN : EXIT_DEMO_LAG;
}

const argv = process.argv.slice(2);
const run = argv.includes('--selftest') ? Promise.resolve(selftest()) : main(argv);
run
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`BLIND — unexpected failure: ${err?.stack ?? err}`);
    process.exit(EXIT_BLIND);
  });
