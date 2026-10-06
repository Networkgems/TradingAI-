#!/usr/bin/env node
// tra4954-ac-grade.mjs — grade TRA-4954's acceptance criteria off the LIVE raw pull.
//
// TRA-4954 asked for AC1 and AC3 to be read "off the raw pull, not off a counter".
// This is that read, so that the grade is reproducible by whoever owns the readout
// (QuantTrader) and not a number pasted out of one agent's transcript.
//
// ── Why this script exists rather than a counter ──────────────────────────────
// AC1 is a statement about (slot × SYMBOL) coverage: no `(slot, underlying)` may
// hold a `budgetdrop` row and zero `candidate` rows. No published counter can
// answer it, and the obvious proxy is WRONG:
//
//   🔴 `dropsBySlotEt[slot].wholeDrops > 0` IS NOT AN AC1 FAILURE. Several BOOKS
//      of one accountClass scan the same underlying inside one slot. The second
//      such pass legitimately banks 0 once that symbol already holds its floor,
//      so `wholeDrops` counts PASSES that banked nothing while AC1 counts
//      SYMBOLS that banked nothing. On a healthy v3 session the first is
//      positive and the second is zero. Grading the proxy fails a clean session.
//
// ── The slot-derivation trap, and the control for it ─────────────────────────
// `budgetdrop` rows carry `slot`; `candidate` rows carry only `ts`. So the join
// key is half-derived, and deriving an ET 30-minute slot from an epoch is where
// a grader goes quietly wrong: a hard-coded -4h offset is correct today and
// 60 minutes wrong from 2026-11-01, which would re-bucket one slot's worth of
// candidates and manufacture an AC1 failure out of DST.
//
// So this script does not trust its own derivation. `etSlot()` replicates
// packages/server/src/otm-admission-tape.ts `otmAdmissionSlot` exactly (via
// et-clock.ts's Intl America/New_York rendering, which IS DST-correct), and then
// SLOT_CONTROL re-derives the slot of every shed row from its own `ts` and
// compares it against the `slot` that row already carries. That is a positive
// control on real data: if the derivation is off by an hour, the control fails
// loudly BEFORE any AC verdict is printed, and the script refuses to grade.
//
// ── Paging ───────────────────────────────────────────────────────────────────
// `?rows=` is capped per response and `rows=all` does NOT lift it (TRA-4628);
// an unpaged read of a fat desk day is a TAIL-CLIPPED prefix, i.e. biased
// against the day's last ET slots — which is exactly the shape of defect being
// graded. Every pull here follows `rowsNextOffset` to exhaustion and asserts
// the final page reports `rowsTruncated: false`.
//
// Usage:
//   node scripts/tra4954-ac-grade.mjs --day=2026-10-02 [--class=desk,fixture]
//                                     [--base=https://tradingai-bqb1.onrender.com]
//   node scripts/tra4954-ac-grade.mjs --selftest
//
// Exit 0 = every AC graded PASS. Exit 1 = at least one FAIL. Exit 2 = usage, or
// the slot control failed, or a day held no rows (NOT a pass — an empty day is
// unreadable, never clean; see TRA-4744's "a zero is structurally invisible").

// 🔴 DO NOT default this to `TRADING_API_BASE`. That variable FLIPS between
// shells — it is `http://localhost:4242` in an agent dev shell right now — and an
// earlier draft of this script inherited it and graded a LOCAL dev server while
// printing verdicts that read exactly like bqb1's. The subject of this grade is
// the soak host, by name, and changing it must be a typed argument.
const BQB1 = 'https://tradingai-bqb1.onrender.com';
const DEFAULT_BASE = BQB1;
const ROUTE = '/api/health/otm-admission-tape';
const SLOT_MINUTES = 30;
/** AC2: must match MAX_ROWS_PER_SLOT / MAX_ROWS_PER_SLOT_OTHER in the tape. */
const BUDGET = { desk: 1000, _other: 200 };
/** AC3 bar: |mean shed pass − mean pass| / mean pass. */
const AC3_TOLERANCE = 0.1;

const ET_CLOCK_FORMAT = {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
};

/** ET 30-minute slot index (0–47). Mirrors `otmAdmissionSlot` in the tape. */
export function etSlot(ms) {
  const rendered = new Date(ms).toLocaleString('en-US', ET_CLOCK_FORMAT);
  const m = rendered.match(/(\d+)\/(\d+)\/(\d+),\s+(\d+):(\d+)/);
  if (!m) return null;
  // h24 renders midnight as 24:00–24:59; fold onto 00:00–00:59, as et-clock does.
  const hour = Number(m[4]) % 24;
  const minute = Number(m[5]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return Math.floor((hour * 60 + minute) / SLOT_MINUTES);
}

function slotLabel(slot) {
  const mins = slot * SLOT_MINUTES;
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

function budgetFor(cls) {
  return BUDGET[cls] ?? BUDGET._other;
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/** Page the raw pull to exhaustion. Returns {rows, pages}; throws if still truncated. */
async function pullAll(base, day, cls, kind) {
  const rows = [];
  let offset = 0;
  let pages = 0;
  for (;;) {
    const url = `${base}${ROUTE}?rows=20000&day=${day}&class=${cls}&kind=${kind}&offset=${offset}`;
    const d = await getJson(url);
    const page = d.rows ?? [];
    rows.push(...page);
    pages += 1;
    if (!d.rowsTruncated) return { rows, pages };
    const next = d.rowsNextOffset;
    // No forward progress would spin forever; a missing cursor under
    // rowsTruncated:true means the surface cannot be read exhaustively, and a
    // prefix is tail-clipped — refuse rather than grade a biased sample.
    if (typeof next !== 'number' || next <= offset) {
      throw new Error(
        `raw pull for ${cls}/${day}/${kind} reports rowsTruncated after ${pages} page(s) ` +
          `but gave no advancing rowsNextOffset (got ${JSON.stringify(next)} at offset ${offset}). ` +
          `Refusing to grade a tail-clipped prefix.`,
      );
    }
    offset = next;
    if (pages > 500) throw new Error(`raw pull for ${cls}/${day}/${kind} exceeded 500 pages`);
  }
}

/**
 * The slot-derivation positive control. Shed rows carry BOTH `ts` and `slot`,
 * so they are a free oracle for `etSlot`. Returns {checked, mismatches}.
 */
function slotControl(shedRows) {
  let checked = 0;
  const mismatches = [];
  for (const r of shedRows) {
    if (typeof r.ts !== 'number' || typeof r.slot !== 'number') continue;
    checked += 1;
    const derived = etSlot(r.ts);
    if (derived !== r.slot) {
      mismatches.push({ ts: r.ts, carried: r.slot, derived });
      if (mismatches.length > 5) break;
    }
  }
  return { checked, mismatches };
}

function mean(xs) {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function gradeClass(cls, day, candidates, shed, summaryDay) {
  const out = { cls, day, verdicts: [], notes: [] };
  const budget = budgetFor(cls);

  // Policy split. A day holding both v2 and v3 candidate rows is BLENDED and
  // must not be graded as either — the deploy landed mid-session.
  const policies = new Map();
  for (const r of candidates) {
    const p = typeof r.samplingPolicy === 'number' ? r.samplingPolicy : 1;
    policies.set(p, (policies.get(p) ?? 0) + 1);
  }
  const policyList = [...policies.entries()].sort((a, b) => a[0] - b[0]);
  out.policies = policyList;
  // v4 (TRA-5211) is v3 thinning with a decaying forward expectation — same
  // floors, same budgets, so every AC here grades identically on a pure-v4
  // day. A day holding BOTH is still a mid-session deploy and still blended.
  const v3Only = policyList.length === 1 && policyList[0][0] >= 3;

  // ── AC1: every symbol presenting in a slot banks >= 1 candidate row ───────
  const bankedCells = new Set();
  for (const r of candidates) {
    const slot = etSlot(r.ts);
    if (slot == null || !r.underlying) continue;
    bankedCells.add(`${slot}|${r.underlying}`);
  }
  const shedCells = new Set();
  for (const r of shed) {
    if (typeof r.slot !== 'number' || !r.underlying) continue;
    shedCells.add(`${r.slot}|${r.underlying}`);
  }
  const starved = [...shedCells].filter((k) => !bankedCells.has(k)).sort();
  out.verdicts.push({
    ac: 'AC1',
    what: 'no (slot, underlying) sheds rows and banks zero',
    pass: starved.length === 0,
    detail:
      `${starved.length} starved cell(s) of ${shedCells.size} that shed ` +
      `(banked cells: ${bankedCells.size})` +
      (starved.length
        ? ` — e.g. ${starved
            .slice(0, 8)
            .map((k) => {
              const [s, u] = k.split('|');
              return `${slotLabel(Number(s))}/${u}`;
            })
            .join(', ')}`
        : ''),
  });

  // wholeDrops is reported for context ONLY — see the header. Never a verdict.
  let wholeDrops = 0;
  let shedPasses = 0;
  for (const cell of Object.values(summaryDay?.dropsBySlotEt ?? {})) {
    wholeDrops += cell.wholeDrops ?? 0;
    shedPasses += cell.passes ?? 0;
  }
  out.notes.push(
    `context (NOT a verdict): ${wholeDrops}/${shedPasses} shed passes banked nothing — ` +
      `legitimate when a second book of this class re-scans a symbol already holding its floor`,
  );

  // ── AC2: the budget is thinned, not raised ────────────────────────────────
  const rowsBySlot = summaryDay?.rowsBySlotEt ?? {};
  const sumSlots = Object.values(rowsBySlot).reduce((a, b) => a + b, 0);
  const candRows = summaryDay?.candidateRows;
  const maxSlot = Object.values(rowsBySlot).length ? Math.max(...Object.values(rowsBySlot)) : 0;
  const overBudget = Object.entries(rowsBySlot).filter(([, v]) => v > budget);
  out.verdicts.push({
    ac: 'AC2',
    what: 'sum(rowsBySlotEt) == candidateRows, and every slot <= budget',
    pass: sumSlots === candRows && overBudget.length === 0,
    detail:
      `sum=${sumSlots} candidateRows=${candRows} (${sumSlots === candRows ? 'identity holds' : 'MISMATCH'}), ` +
      `maxSlot=${maxSlot}/${budget}` +
      (overBudget.length ? ` — OVER in ${overBudget.map(([k, v]) => `${k}=${v}`).join(', ')}` : ''),
  });

  // ── AC3: the size filter is gone ──────────────────────────────────────────
  // Graded as mean SHED-pass size vs mean of ALL passes. The ticket wrote
  // "shed vs BANKED", but once nothing is starved nearly every pass both banks
  // and sheds, so those two populations are not disjoint and the ratio is not
  // well defined. Mean-of-all-passes is the strict reading of the same question
  // ("does pass size predict being shed from?") and is what is reported here.
  // 🔴 AC3 NEEDS BOTH DENOMINATORS, and neither alone is sufficient.
  //
  //   AC3a  shed vs ALL passes. Well defined before AND after the fix, but it
  //         goes BLIND as starvation approaches totality: on fixture 2026-10-01
  //         1,566 of 1,665 passes are shed, so "all passes" IS "shed passes"
  //         and the ratio collapses to +2.6% on a day the defect report
  //         measured at +94.5%. Reported, but it cannot fail a starved day.
  //   AC3b  shed vs UNTOUCHED passes (a pass with no `budgetdrop` row at all).
  //         This is the ticket's "shed vs banked" comparison made durable: the
  //         ticket's wording breaks after the fix, because a thinned pass both
  //         banks and sheds and so belongs to both populations. "Untouched" is
  //         disjoint from "shed" by construction, so the ratio stays defined on
  //         either side of the change. This is the reading that DETECTS the
  //         size filter, and it is the binding one.
  const shedKeys = new Set();
  const shedSizes = [];
  for (const r of shed) {
    const full = typeof r.passRows === 'number' ? r.passRows : r.rows;
    if (typeof full === 'number' && full > 0) shedSizes.push(full);
    if (typeof r.slot === 'number' && r.underlying) {
      shedKeys.add(`${r.slot}|${r.underlying}|${r.ts}`);
    }
  }
  // Pass size for banked passes: group candidates by (slot, symbol, ts).
  const passRows = new Map();
  for (const r of candidates) {
    const slot = etSlot(r.ts);
    if (slot == null) continue;
    const k = `${slot}|${r.underlying}|${r.ts}`;
    passRows.set(k, (passRows.get(k) ?? 0) + 1);
  }
  const untouchedSizes = [];
  for (const [k, n] of passRows) if (!shedKeys.has(k)) untouchedSizes.push(n);
  const allSizes = [...passRows.values()];
  for (const r of shed) {
    const banked = typeof r.banked === 'number' ? r.banked : 0;
    const full = typeof r.passRows === 'number' ? r.passRows : r.rows;
    // A v2 whole-drop banked nothing, so its pass is absent from `passRows`.
    if (banked === 0 && typeof full === 'number' && full > 0) allSizes.push(full);
  }
  const mShed = mean(shedSizes);
  const mAll = mean(allSizes);
  const mUntouched = mean(untouchedSizes);
  const ratioA = mShed != null && mAll ? mShed / mAll - 1 : null;
  const ratioB = mShed != null && mUntouched ? mShed / mUntouched - 1 : null;
  const pct = (r) => `${r >= 0 ? '+' : ''}${(r * 100).toFixed(1)}%`;
  out.verdicts.push({
    ac: 'AC3a',
    what: `mean shed-pass size within +/-${AC3_TOLERANCE * 100}% of mean of ALL passes`,
    pass: ratioA != null && Math.abs(ratioA) <= AC3_TOLERANCE,
    detail:
      mShed == null
        ? 'no shed rows — rule 3 never bit, AC3 is VACUOUS (not a pass)'
        : `mean shed ${mShed.toFixed(1)} vs mean pass ${mAll.toFixed(1)} = ${pct(ratioA)} ` +
          `(n_shed=${shedSizes.length}, n_pass=${allSizes.length})` +
          (shedSizes.length / Math.max(1, allSizes.length) > 0.5
            ? '  ⚠ >50% of passes shed — this denominator is near-degenerate here, AC3b binds'
            : ''),
    vacuous: mShed == null,
  });
  out.verdicts.push({
    ac: 'AC3b',
    what: `mean shed-pass size within +/-${AC3_TOLERANCE * 100}% of mean UNTOUCHED pass (binding)`,
    pass: ratioB != null && Math.abs(ratioB) <= AC3_TOLERANCE,
    detail:
      mShed == null
        ? 'no shed rows — VACUOUS'
        : mUntouched == null
          ? `every pass shed something — no untouched population, VACUOUS (n_shed=${shedSizes.length})`
          : `mean shed ${mShed.toFixed(1)} vs mean untouched ${mUntouched.toFixed(1)} = ${pct(ratioB)} ` +
            `(n_shed=${shedSizes.length}, n_untouched=${untouchedSizes.length})`,
    vacuous: mShed == null || mUntouched == null,
  });

  // ── AC5: `ordered` is never budgeted ──────────────────────────────────────
  // Read as presence, which is all the raw pull can say: ordered rows exist on
  // a day whose slots saturated. It cannot prove the negative (that none was
  // ever dropped) — that is the unit test's job, asserted under a deliberately
  // saturated slot.
  out.notes.push(
    `AC5 (route-side half): ordered=${summaryDay?.ordered ?? 0} ranked=${summaryDay?.ranked ?? 0} ` +
      `on a day whose max slot is ${maxSlot}/${budget}` +
      (v3Only ? '' : ' — day is NOT v3-only'),
  );

  out.blended = policyList.length > 1;
  out.v3Only = v3Only;
  return out;
}

function selftest() {
  const fails = [];
  const ck = (name, got, want) => {
    if (got !== want) fails.push(`${name}: got ${got}, want ${want}`);
  };
  // EDT (UTC-4): 09:30 ET == 13:30Z -> slot 19.
  ck('EDT 09:30 ET', etSlot(Date.parse('2026-10-02T13:30:00Z')), 19);
  ck('EDT 09:59 ET', etSlot(Date.parse('2026-10-02T13:59:00Z')), 19);
  ck('EDT 10:00 ET', etSlot(Date.parse('2026-10-02T14:00:00Z')), 20);
  // EST (UTC-5) after 2026-11-01: 09:30 ET == 14:30Z, still slot 19. This is
  // the case a hard-coded offset gets wrong, so it is the load-bearing case.
  ck('EST 09:30 ET', etSlot(Date.parse('2026-11-05T14:30:00Z')), 19);
  ck('EST 09:30 ET is not 20', etSlot(Date.parse('2026-11-05T14:30:00Z')) === 20, false);
  // A naive -4h offset would read 13:30Z on 2026-11-05 as 09:30 ET; ET is 08:30.
  ck('EST 13:30Z is 08:30 ET', etSlot(Date.parse('2026-11-05T13:30:00Z')), 17);
  // Midnight folding (h24 renders 24:00).
  ck('ET midnight', etSlot(Date.parse('2026-10-02T04:00:00Z')), 0);
  ck('slotLabel 19', slotLabel(19), '09:30');
  ck('slotLabel 0', slotLabel(0), '00:00');
  ck('budget desk', budgetFor('desk'), 1000);
  ck('budget fixture', budgetFor('fixture'), 200);
  if (fails.length) {
    console.error('[tra4954-grade] SELFTEST FAILED');
    for (const f of fails) console.error('  -', f);
    process.exit(1);
  }
  console.log(`[tra4954-grade] SELFTEST CLEAN — ${11 - fails.length} checks, incl. the post-2026-11-01 EST case.`);
  process.exit(0);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) selftest();
  const arg = (name, dflt) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : dflt;
  };
  const day = arg('day');
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    console.error('usage: node scripts/tra4954-ac-grade.mjs --day=YYYY-MM-DD [--class=desk,fixture] [--base=URL]');
    console.error('       node scripts/tra4954-ac-grade.mjs --selftest');
    process.exit(2);
  }
  const base = (arg('base', DEFAULT_BASE) || '').replace(/\/$/, '');
  const classes = (arg('class', 'desk,fixture') || '').split(',').filter(Boolean);

  console.log(`[tra4954-grade] base    : ${base}${base === BQB1 ? ' (bqb1, the default)' : ' (OVERRIDDEN via --base)'}`);
  const envBase = (process.env.TRADING_API_BASE ?? '').replace(/\/$/, '');
  if (envBase && envBase !== base) {
    console.log(
      `[tra4954-grade] ⚠ TRADING_API_BASE is set to ${envBase} and is being IGNORED. ` +
        `This grade is of ${base}. Pass --base=${envBase} if you meant that host.`,
    );
  }
  console.log(`[tra4954-grade] day     : ${day} (ET)`);
  const summary = await getJson(`${base}${ROUTE}`);
  const live = summary.build?.commitShort ?? summary.build?.commit ?? 'unknown';
  console.log(
    `[tra4954-grade] live    : ${live} pid=${summary.build?.pid} startedAt=${summary.build?.startedAt}`,
  );
  console.log(
    `[tra4954-grade] policy  : samplingPolicy=${summary.policy?.samplingPolicy} ` +
      `floorRowsPerSymbol=${summary.policy?.floorRowsPerSymbol} ` +
      `budgets=${summary.policy?.maxRowsPerSlotDesk}/${summary.policy?.maxRowsPerSlotOther} ` +
      `maxFileBytes=${summary.policy?.maxFileBytes}`,
  );
  console.log(`[tra4954-grade] bytes   : fileBytes=${summary.durability?.fileBytes}`);
  console.log('');

  let anyFail = false;
  let anyVacuous = false;
  for (const cls of classes) {
    const byClass = (summary.byClass ?? []).find((c) => c.accountClass === cls);
    const summaryDay = (byClass?.days ?? []).find((d) => d.etDay === day);
    if (!summaryDay) {
      console.log(`── ${cls} ${day}: NO SUCH DAY on the tape — unreadable, NOT clean.`);
      anyFail = true;
      continue;
    }
    const [{ rows: candidates, pages: cp }, { rows: shed, pages: sp }] = [
      await pullAll(base, day, cls, 'candidate'),
      await pullAll(base, day, cls, 'budgetdrop'),
    ];

    // The control runs BEFORE any verdict and gates all of them.
    const ctl = slotControl(shed);
    if (ctl.mismatches.length) {
      console.error(`── ${cls} ${day}: SLOT CONTROL FAILED — refusing to grade.`);
      console.error(
        `   ${ctl.mismatches.length}+ of ${ctl.checked} shed rows disagree with the derived ET slot:`,
      );
      for (const m of ctl.mismatches.slice(0, 5)) {
        console.error(`     ts=${m.ts} carries slot ${m.carried}, derived ${m.derived}`);
      }
      process.exit(2);
    }

    console.log(`── ${cls} ${day}`);
    console.log(
      `   pulled  : ${candidates.length} candidate rows (${cp} page(s)), ` +
        `${shed.length} budgetdrop rows (${sp} page(s))`,
    );
    const g = gradeClass(cls, day, candidates, shed, summaryDay);
    console.log(
      `   slotctl : CLEAN — ${ctl.checked} shed rows re-derive to their own carried slot`,
    );
    console.log(
      `   policy  : ${g.policies.map(([p, n]) => `v${p}=${n}`).join(' ')}` +
        (g.blended ? '  🔴 BLENDED DAY — discard, do not grade (deploy landed mid-session)' : ''),
    );
    for (const v of g.verdicts) {
      const tag = v.vacuous ? 'VACUOUS' : v.pass ? 'PASS' : 'FAIL';
      if (!v.pass || v.vacuous) anyFail = anyFail || !v.pass;
      if (v.vacuous) anyVacuous = true;
      console.log(`   ${v.ac} ${tag.padEnd(7)} ${v.what}`);
      console.log(`        ${v.detail}`);
    }
    for (const n of g.notes) console.log(`   note    : ${n}`);
    console.log('');
  }

  if (anyVacuous) console.log('[tra4954-grade] at least one AC is VACUOUS — a vacuous AC is not a pass.');
  console.log(`[tra4954-grade] ${anyFail ? 'FAIL' : 'ALL GRADED AC PASS'}`);
  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => {
  console.error(`[tra4954-grade] ERROR: ${e.message}`);
  process.exit(2);
});
