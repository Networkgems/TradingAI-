#!/usr/bin/env node
// TRA-4991 — grade the five ACs against a LIVE host, off published surfaces only.
//
// ⛔ WHY THIS EXISTS AND NOT A HAND-CURL. Every measurement trap this ticket's own
// description lists is a trap that produced a wrong reading on this exact route:
//
//   • `?rows=all` must be URL-ENCODED. A plain `?rows=all` has returned 200 with
//     NO `rows` key and NO `rowsMode` key — the dump silently ABSENT rather than
//     empty. So `rowsMode === 'all'` and `rowsDumped === summary.total` are
//     asserted BEFORE any fold runs, and a fold is refused otherwise.
//   • Grade on `byAccountClass.desk`. Fixture books mirror one economic trade
//     into several accounts with distinct ids, so the pooled figure is inflated
//     and id-dedupe cannot see it (1,181 of 3,542 rows are fixture; TRA-4945
//     found a cited pooled chandelier loss was 91% fixture money).
//   • A `0` is only a measurement once you know the surface could have seen a
//     non-zero. AC1's population is FORWARD-ONLY — rows closed before this build
//     carry no `chandelier` object and ⛔ nothing backfills them — so a `0` here
//     is graded as `PENDING_POPULATION`, never as a FAIL and never as a PASS.
//
// Usage:  node scripts/tra4991-ac-grade.mjs [--base=https://host] [--json]
//         node scripts/tra4991-ac-grade.mjs --selftest
// Exit:   0 all gradeable ACs PASS · 1 a FAIL · 2 could not measure (BLIND)

const DEFAULT_BASE = 'https://tradingai-bqb1.onrender.com';
/** AC5's guard: the bare-`chandelier` lifetime count on an unchanged journal. */
const AC5_BARE_CHANDELIER_BASELINE = 288;
/** AC4's three labels. The FIFTH (`chandelier_deferred_breach`) is out of scope on purpose. */
const SPLIT_REASONS = ['chandelier_daily_close', 'chandelier_restarted', 'chandelier_spot_seeded'];
const CHANDELIER_FAMILY = ['chandelier', ...SPLIT_REASONS, 'chandelier_deferred_breach'];

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? dflt : hit.slice(name.length + 3);
};
const BASE = String(arg('base', DEFAULT_BASE)).replace(/\/+$/, '');
const AS_JSON = argv.includes('--json');

async function getJson(path) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

/** One graded acceptance criterion. `BLIND` is distinct from `FAIL` by design. */
function ac(id, verdict, detail) {
  return { id, verdict, detail };
}

// ── AC2 + AC3 — /api/health/option-swing-exits ───────────────────────────────

export function gradeSwingExits(payload) {
  const out = [];
  const c = payload?.chandelier;
  if (c === undefined || c === null) {
    return [ac('AC2', 'FAIL', 'no `chandelier` block on /api/health/option-swing-exits — this build predates TRA-4991')];
  }
  const numeric = ['atrMult', 'atrMultHighBeta', 'highBetaAtrPct', 'atrPeriod', 'atrTimeframeMs'];
  const missing = numeric.filter((k) => typeof c[k] !== 'number' || !Number.isFinite(c[k]));
  const rule = c.otmSleeveExitRule ?? {};
  if (typeof rule.rule !== 'string' || typeof rule.source !== 'string') missing.push('otmSleeveExitRule.{rule,source}');
  if (c.multSource !== 'compiled') missing.push(`multSource (got ${JSON.stringify(c.multSource)})`);
  out.push(
    missing.length === 0
      ? ac('AC2', 'PASS',
        `atrMult ${c.atrMult} / highBeta ${c.atrMultHighBeta} @ atrPct>${c.highBetaAtrPct}, `
        + `ATR(${c.atrPeriod}) on ${c.atrTimeframeMs}ms (${c.atrSeries}), multSource ${c.multSource}; `
        + `OTM_SLEEVE_EXIT_RULE=${rule.rule} source=${rule.source} chandelierRetired=${rule.chandelierRetired}`)
      : ac('AC2', 'FAIL', `missing/invalid: ${missing.join(', ')}`),
  );

  const r = c.ratchets;
  if (r === undefined || r === null) {
    out.push(ac('AC3', 'FAIL', 'no `chandelier.ratchets` census on the route'));
    return out;
  }
  const cells = [['live', r.byMode?.live], ['demo', r.byMode?.demo], ['all', r.all]];
  const broken = cells.filter(([, t]) =>
    !t || t.highBeta + t.base + t.baseAtrPctAbsent !== t.ratchets);
  if (broken.length > 0) {
    out.push(ac('AC3', 'FAIL',
      `the three cells do not partition \`ratchets\` on: ${broken.map(([n]) => n).join(', ')}`));
    return out;
  }
  // The DENOMINATOR must partition too, or `rowsSeen` is not the denominator.
  const skipSum = (t) => Object.values(t.skipped ?? {}).reduce((a, n) => a + n, 0);
  const denomBroken = cells.filter(([, t]) =>
    typeof t.rowsSeen !== 'number' || t.rowsSeen !== t.ratchets + skipSum(t));
  if (denomBroken.length > 0) {
    out.push(ac('AC3', 'FAIL',
      `\`rowsSeen\` !== ratchets + sum(skipped) on: ${denomBroken.map(([n]) => n).join(', ')}`
      + ' — the denominator does not account for every row the pass looked at'));
    return out;
  }

  const master = c.exitRiskMaster ?? {};
  const say = ([n, t]) =>
    `${n} seen=${t.rowsSeen} ratch=${t.ratchets} highBeta=${t.highBeta} base=${t.base} `
    + `atrPctAbsent=${t.baseAtrPctAbsent} maxAtrPct=${t.maxAtrPct} skipped=${JSON.stringify(t.skipped)}`;
  const all = r.all;
  const why = JSON.stringify(all.skipped);
  // ⛔ THREE different zeros, and they license different conclusions.
  if (all.rowsSeen === 0) {
    // The pass looked at NO row. Every number below it is a 0/0.
    out.push(ac('AC3', 'PENDING_NO_DENOMINATOR',
      `census live, rowsSeen 0 since boot ${new Date(r.sinceBootAt).toISOString()} — the exit pass `
      + 'evaluated no row at all (flat book, or no pass has run yet), so `ratchets: 0` is a 0/0 and '
      + 'not a reading about the trail.'));
  } else if (all.ratchets === 0) {
    // Rows were looked at and NONE ratcheted — now attributable.
    out.push(ac('AC3', master.live === true || master.demo === true ? 'PENDING_POPULATION' : 'PENDING_MASTER_DARK',
      `census live, rowsSeen ${all.rowsSeen} but 0 ratchets, attributed: ${why} `
      + `(exitRiskMaster live=${master.live} demo=${master.demo}). The instrument is on the wire and `
      + 'now says WHY the trail did not run; the high-beta question needs an eligible single-leg row.'));
  } else {
    out.push(ac('AC3', 'PASS', `${cells.map(say).join(' | ')} (since ${new Date(r.sinceBootAt).toISOString()})`));
  }
  return out;
}

// ── AC1 + AC4 + AC5 — /api/health/option-journal?rows=all ────────────────────

export function gradeJournal(payload) {
  const out = [];
  // THE TRAP, FIRST: an absent dump reads as an empty one.
  if (payload?.rowsMode !== 'all') {
    return [ac('AC1', 'BLIND',
      `rowsMode is ${JSON.stringify(payload?.rowsMode)}, not "all" — the dump is ABSENT, not empty. Refusing to fold.`)];
  }
  const total = payload?.summary?.total;
  if (!Array.isArray(payload.rows) || payload.rowsDumped !== total) {
    return [ac('AC1', 'BLIND',
      `rowsDumped ${payload.rowsDumped} !== summary.total ${total} — a partial dump cannot ground a lifetime count.`)];
  }

  const rows = payload.rows;
  const family = rows.filter((r) => CHANDELIER_FAMILY.includes(r.exitReason));
  const stamped = family.filter((r) => r.chandelier !== undefined && r.chandelier !== null);
  const REQUIRED = ['peakUnderlying', 'chandelierStop', 'underlyingEntryPrice', 'spotAtFire', 'atr', 'atrPeriod', 'atrTimeframeMs'];
  const incomplete = stamped.filter((r) => REQUIRED.some((k) => r.chandelier[k] === undefined));
  // A trail whose own arithmetic does not close is a fabricated column, not a trail.
  const unreconciled = stamped.filter((r) => {
    const c = r.chandelier;
    if (typeof c.atrMult !== 'number' || typeof c.atr !== 'number') return false;
    const expect = c.side === 'buy'
      ? c.peakUnderlying - c.atrMult * c.atr
      : c.peakUnderlying + c.atrMult * c.atr;
    // The persisted stop is a RATCHET (never loosens), so the fired level may be
    // TIGHTER than this tick's raw width — never looser. That is the invariant.
    return c.side === 'buy' ? c.chandelierStop < expect - 1e-6 : c.chandelierStop > expect + 1e-6;
  });
  // ⛔ A zeroed ATR is the shape AC1 forbids: it reads as "no volatility".
  const zeroed = stamped.filter((r) => r.chandelier.atr === 0 || r.chandelier.atrTimeframeMs === 0);
  const nonFamilyStamped = rows.filter(
    (r) => !CHANDELIER_FAMILY.includes(r.exitReason) && r.chandelier !== undefined,
  );

  if (incomplete.length > 0) {
    out.push(ac('AC1', 'FAIL', `${incomplete.length} stamped row(s) missing a required field: ${incomplete.slice(0, 3).map((r) => r.id).join(', ')}`));
  } else if (zeroed.length > 0) {
    out.push(ac('AC1', 'FAIL', `${zeroed.length} row(s) carry a ZEROED atr/atrTimeframeMs — absent is the contract, never 0`));
  } else if (unreconciled.length > 0) {
    out.push(ac('AC1', 'FAIL', `${unreconciled.length} row(s) whose stop is LOOSER than peak -/+ mult x atr — the ratchet invariant is broken`));
  } else if (nonFamilyStamped.length > 0) {
    out.push(ac('AC1', 'FAIL', `${nonFamilyStamped.length} NON-chandelier row(s) carry a \`chandelier\` object`));
  } else if (stamped.length === 0) {
    // FORWARD-ONLY. Not a FAIL: nothing backfills a closed row's spot-space state.
    out.push(ac('AC1', 'PENDING_POPULATION',
      `${family.length} chandelier-family row(s) lifetime, 0 carry the stamp — all closed on a pre-TRA-4991 build. `
      + 'Forward-only by contract; the next chandelier close is the first gradeable row.'));
  } else {
    out.push(ac('AC1', 'PASS', `${stamped.length} of ${family.length} chandelier-family row(s) carry a complete, self-reconciling stamp`));
  }

  // AC4 — the fold.
  const grid = payload.sleeveCells;
  if (!grid) {
    out.push(ac('AC4', 'BLIND', 'no `sleeveCells` on the payload'));
  } else {
    const stillUnclassified = SPLIT_REASONS.filter((r) => (grid.unclassifiedExitReasons ?? []).includes(r));
    const table = new Map((grid.exitOwnerTable ?? []).map((t) => [t.reason, t.owner]));
    const wrongOwner = SPLIT_REASONS.filter((r) => table.get(r) !== 'strategy');
    if (stillUnclassified.length > 0) {
      out.push(ac('AC4', 'FAIL', `still unclassified: ${stillUnclassified.join(', ')}`));
    } else if (wrongOwner.length > 0) {
      out.push(ac('AC4', 'FAIL', `on the table but not strategy-owned: ${wrongOwner.map((r) => `${r}=${table.get(r)}`).join(', ')}`));
    } else if (grid.cellsSumToClosed !== true || grid.residual !== 0) {
      out.push(ac('AC4', 'FAIL', `cell counts stopped reconciling: cellsSumToClosed=${grid.cellsSumToClosed} residual=${grid.residual}`));
    } else {
      // Separately foldable, on the DESK class — the only class a sleeve grade
      // may be read from.
      const desk = (grid.cells ?? []).filter((c) => c.accountClass === 'desk');
      const perReason = new Map();
      for (const cell of desk) {
        for (const s of cell.byExitReason ?? []) {
          if (!CHANDELIER_FAMILY.includes(s.exitReason)) continue;
          perReason.set(s.exitReason, (perReason.get(s.exitReason) ?? 0) + s.closed);
        }
      }
      out.push(ac('AC4', 'PASS',
        `all three on the table as strategy, gone from unclassifiedExitReasons, cellsSumToClosed=true residual=0; `
        + `desk byExitReason keeps them SEPARATE: ${[...perReason.entries()].map(([k, v]) => `${k}=${v}`).join(' ') || '(none on desk)'}; `
        + `remaining unclassified (out of scope): ${JSON.stringify(grid.unclassifiedExitReasons)}`));
    }
  }

  // AC5 — the read-only guard.
  const bare = rows.filter((r) => r.exitReason === 'chandelier').length;
  out.push(
    bare === AC5_BARE_CHANDELIER_BASELINE
      ? ac('AC5', 'PASS', `bare \`chandelier\` lifetime count ${bare} === ${AC5_BARE_CHANDELIER_BASELINE} baseline — no exit behaviour moved`)
      : ac('AC5', bare > AC5_BARE_CHANDELIER_BASELINE ? 'ADVANCED' : 'FAIL',
        `bare \`chandelier\` lifetime count ${bare} vs ${AC5_BARE_CHANDELIER_BASELINE} baseline`
        + (bare > AC5_BARE_CHANDELIER_BASELINE
          ? ' — HIGHER, i.e. new chandelier closes landed since the baseline was taken. That is the book trading, not this ticket; re-baseline and re-read.'
          : ' — LOWER. A lifetime count cannot fall; something rewrote history.')),
  );
  return out;
}

// ── controls ─────────────────────────────────────────────────────────────────
// Each asserts the grader REFUSES a shape that must not pass. A grader that has
// never been shown failing is not evidence about the thing it grades.

function selftest() {
  const fails = [];
  const check = (name, cond) => { if (!cond) fails.push(name); };
  const verdictOf = (list, id) => list.find((a) => a.id === id)?.verdict;

  // The silent-absent dump: 200, no rows key. MUST be BLIND, never a PASS/FAIL.
  check('absent dump ⇒ BLIND',
    verdictOf(gradeJournal({ summary: { total: 10 } }), 'AC1') === 'BLIND');
  check('partial dump ⇒ BLIND',
    verdictOf(gradeJournal({ rowsMode: 'all', rowsDumped: 3, summary: { total: 10 }, rows: [] }), 'AC1') === 'BLIND');

  const base = (rows, grid) => ({
    rowsMode: 'all', rowsDumped: rows.length, summary: { total: rows.length }, rows,
    sleeveCells: grid ?? {
      unclassifiedExitReasons: [], cellsSumToClosed: true, residual: 0, cells: [],
      exitOwnerTable: SPLIT_REASONS.map((reason) => ({ reason, owner: 'strategy' })),
    },
  });
  const goodStamp = {
    side: 'buy', peakUnderlying: 210, chandelierStop: 198, underlyingEntryPrice: 200,
    spotAtFire: 197, atr: 4, atrPct: null, atrPeriod: 14, atrTimeframeMs: 300_000, atrMult: 3,
  };
  check('complete stamp ⇒ PASS',
    verdictOf(gradeJournal(base([{ id: 'a', exitReason: 'chandelier', chandelier: goodStamp }])), 'AC1') === 'PASS');
  check('no stamped rows ⇒ PENDING_POPULATION (forward-only), never FAIL',
    verdictOf(gradeJournal(base([{ id: 'a', exitReason: 'chandelier' }])), 'AC1') === 'PENDING_POPULATION');
  check('missing required field ⇒ FAIL',
    verdictOf(gradeJournal(base([{ id: 'a', exitReason: 'chandelier', chandelier: { ...goodStamp, atrPeriod: undefined } }])), 'AC1') === 'FAIL');
  check('ZEROED atr ⇒ FAIL (a 0 reads as "no volatility")',
    verdictOf(gradeJournal(base([{ id: 'a', exitReason: 'chandelier', chandelier: { ...goodStamp, atr: 0 } }])), 'AC1') === 'FAIL');
  check('LOOSER-than-width stop ⇒ FAIL',
    verdictOf(gradeJournal(base([{ id: 'a', exitReason: 'chandelier', chandelier: { ...goodStamp, chandelierStop: 190 } }])), 'AC1') === 'FAIL');
  check('TIGHTER stop (a real ratchet) ⇒ PASS',
    verdictOf(gradeJournal(base([{ id: 'a', exitReason: 'chandelier', chandelier: { ...goodStamp, chandelierStop: 205 } }])), 'AC1') === 'PASS');
  check('stamp on a NON-chandelier row ⇒ FAIL',
    verdictOf(gradeJournal(base([{ id: 'a', exitReason: 'sl', chandelier: goodStamp }])), 'AC1') === 'FAIL');

  const grid = (over) => ({
    unclassifiedExitReasons: [], cellsSumToClosed: true, residual: 0, cells: [],
    exitOwnerTable: SPLIT_REASONS.map((reason) => ({ reason, owner: 'strategy' })), ...over,
  });
  check('split still unclassified ⇒ FAIL',
    verdictOf(gradeJournal(base([], grid({ unclassifiedExitReasons: ['chandelier_restarted'] }))), 'AC4') === 'FAIL');
  check('split owned `unknown` ⇒ FAIL',
    verdictOf(gradeJournal(base([], grid({ exitOwnerTable: SPLIT_REASONS.map((reason) => ({ reason, owner: 'unknown' })) }))), 'AC4') === 'FAIL');
  check('cells stopped reconciling ⇒ FAIL',
    verdictOf(gradeJournal(base([], grid({ residual: 2 }))), 'AC4') === 'FAIL');
  check('out-of-scope reasons left unclassified ⇒ still PASS',
    verdictOf(gradeJournal(base([], grid({ unclassifiedExitReasons: ['broker_reconcile'] }))), 'AC4') === 'PASS');

  const bareRows = (n) => Array.from({ length: n }, (_, i) => ({ id: `b${i}`, exitReason: 'chandelier' }));
  check('AC5 at baseline ⇒ PASS',
    verdictOf(gradeJournal(base(bareRows(AC5_BARE_CHANDELIER_BASELINE))), 'AC5') === 'PASS');
  check('AC5 BELOW baseline ⇒ FAIL (a lifetime count cannot fall)',
    verdictOf(gradeJournal(base(bareRows(AC5_BARE_CHANDELIER_BASELINE - 1))), 'AC5') === 'FAIL');
  check('AC5 ABOVE baseline ⇒ ADVANCED, not FAIL (the book traded)',
    verdictOf(gradeJournal(base(bareRows(AC5_BARE_CHANDELIER_BASELINE + 1))), 'AC5') === 'ADVANCED');

  check('no chandelier block ⇒ AC2 FAIL',
    verdictOf(gradeSwingExits({}), 'AC2') === 'FAIL');
  const params = {
    atrMult: 3, atrMultHighBeta: 3.5, highBetaAtrPct: 0.05, atrPeriod: 14,
    atrTimeframeMs: 300_000, atrSeries: 'supertrend_shadow_5m', multSource: 'compiled',
    otmSleeveExitRule: { rule: 'trail', source: 'default', chandelierRetired: true },
  };
  const noSkips = { retired: 0, multi_leg: 0, covered_write: 0, no_exit_risk: 0, no_spot_or_atr: 0 };
  const tally = (over = {}) => ({
    rowsSeen: 0, ratchets: 0, skipped: { ...noSkips },
    highBeta: 0, base: 0, baseAtrPctAbsent: 0, maxAtrPct: null, ...over,
  });
  const census = (live, demo, all, master = { live: true, demo: true }) => ({
    chandelier: { ...params, exitRiskMaster: master, ratchets: { byMode: { live, demo }, all, sinceBootAt: 0 } },
  });
  const oneHighBeta = tally({ rowsSeen: 1, ratchets: 1, highBeta: 1, maxAtrPct: 0.09 });
  check('full params ⇒ AC2 PASS',
    verdictOf(gradeSwingExits(census(oneHighBeta, tally(), oneHighBeta)), 'AC2') === 'PASS');
  check('a live high-beta ratchet ⇒ AC3 PASS',
    verdictOf(gradeSwingExits(census(oneHighBeta, tally(), oneHighBeta)), 'AC3') === 'PASS');
  const badMult = tally({ rowsSeen: 5, ratchets: 5, highBeta: 1, base: 1, baseAtrPctAbsent: 1, maxAtrPct: 0.1 });
  check('a non-partitioning MULTIPLIER census ⇒ AC3 FAIL',
    verdictOf(gradeSwingExits(census(badMult, tally(), badMult)), 'AC3') === 'FAIL');
  // The denominator is itself under control: a `rowsSeen` that does not account
  // for every row is not a denominator, it is a second unexplained number.
  const badDenom = tally({ rowsSeen: 9, ratchets: 1, highBeta: 1, maxAtrPct: 0.1 });
  check('a non-partitioning DENOMINATOR ⇒ AC3 FAIL',
    verdictOf(gradeSwingExits(census(badDenom, tally(), badDenom)), 'AC3') === 'FAIL');
  // ⛔ The three different zeros, each licensing a different conclusion.
  check('rowsSeen 0 ⇒ PENDING_NO_DENOMINATOR (a 0/0, the live 2026-10-02 shape)',
    verdictOf(gradeSwingExits(census(tally(), tally(), tally())), 'AC3') === 'PENDING_NO_DENOMINATOR');
  const allCombos = tally({ rowsSeen: 2, skipped: { ...noSkips, multi_leg: 2 } });
  check('rows seen but all skipped, master ON ⇒ PENDING_POPULATION',
    verdictOf(gradeSwingExits(census(allCombos, tally(), allCombos)), 'AC3') === 'PENDING_POPULATION');
  const masterOff = tally({ rowsSeen: 3, skipped: { ...noSkips, no_exit_risk: 3 } });
  check('rows seen, all `no_exit_risk`, master DARK ⇒ PENDING_MASTER_DARK (structural)',
    verdictOf(gradeSwingExits(census(masterOff, tally(), masterOff, { live: false, demo: false })), 'AC3') === 'PENDING_MASTER_DARK');
  check('a census with no `skipped` key at all ⇒ AC3 FAIL (pre-denominator build)',
    verdictOf(gradeSwingExits({ chandelier: { ...params, ratchets: { byMode: { live: { ratchets: 0, highBeta: 0, base: 0, baseAtrPctAbsent: 0, maxAtrPct: null }, demo: { ratchets: 0, highBeta: 0, base: 0, baseAtrPctAbsent: 0, maxAtrPct: null } }, all: { ratchets: 0, highBeta: 0, base: 0, baseAtrPctAbsent: 0, maxAtrPct: null }, sinceBootAt: 0 } } }), 'AC3') === 'FAIL');

  if (fails.length > 0) {
    console.error(`[tra4991] CONTROLS FAILED (${fails.length}):`);
    for (const f of fails) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log('[tra4991] controls OK — every refusal shape exercised, including the three distinct zeros.');
}

async function main() {
  if (argv.includes('--selftest')) return selftest();

  const live = await getJson('/api/health/options-live');
  const build = live.build ?? {};
  // ⚠ `rows=all` URL-ENCODED. The unencoded form has served 200 with no dump.
  const [swing, journal] = await Promise.all([
    getJson('/api/health/option-swing-exits'),
    getJson(`/api/health/option-journal?${new URLSearchParams({ rows: 'all' }).toString()}`),
  ]);

  const graded = [...gradeSwingExits(swing), ...gradeJournal(journal)]
    .sort((a, b) => a.id.localeCompare(b.id));
  const report = {
    at: new Date().toISOString(),
    base: BASE,
    // Pinned so the grade is attributable to ONE process, not to "the host".
    build: {
      commit: build.commit, commitShort: build.commitShort,
      pid: build.pid, startedAt: build.startedAt, uptimeSec: build.uptimeSec,
    },
    graded,
  };
  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`host    : ${BASE}`);
    console.log(`build   : ${build.commitShort} pid ${build.pid} booted ${build.startedAt} (${build.uptimeSec}s)`);
    for (const g of graded) console.log(`${g.id.padEnd(4)}: ${g.verdict.padEnd(21)} ${g.detail}`);
  }
  if (graded.some((g) => g.verdict === 'FAIL')) process.exit(1);
  if (graded.some((g) => g.verdict === 'BLIND')) process.exit(2);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  await main();
}
