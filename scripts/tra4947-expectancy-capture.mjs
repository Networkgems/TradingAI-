// TRA-4947 — capture the TRA-4859 AC2/AC4 evidence read off
// /api/health/option-expectancy-table, and (with two snapshots) grade the
// DELTAS rather than the absolute levels.
//
// The window is 365d ROLLING, so an absolute level read an hour apart is a
// different number for reasons that have nothing to do with this write. Both
// snapshots have to come from the same beat as the write.
//
//   node scripts/tra4947-expectancy-capture.mjs before.json      # snapshot
//   node scripts/tra4947-expectancy-capture.mjs before.json after.json  # grade
const HOST = process.env.TRA4947_HOST ?? 'https://tradingai-bqb1.onrender.com';
const CELL = 'single_leg_otm::0.50-0.55';
// The control cell. TRA-4947's brief: it must not move AT ALL. Its rows are
// provenance `{demo: 29}` and its window ends 2026-07-08, so row 34f1ee99 is
// not in it; any movement means the write reached further than authorised.
const CONTROL = 'single_leg_otm::0.40-0.45';
const FIELDS = ['n', 'droppedUnpricedCloses', 'meanR_gate', 'sdR_gate', 'seR_gate', 'lowerCI95', 'barR'];
const ADMISSION = ['admits', 'admitsPooled', 'admitsRealFill', 'nRealFill'];

const [outPath, cmpPath] = process.argv.slice(2);

async function snap() {
  const live = await fetch(`${HOST}/api/health/options-live`).then((r) => r.json());
  const res = await fetch(`${HOST}/api/health/option-expectancy-table`);
  if (!res.ok) throw new Error(`expectancy-table ${res.status}`);
  const d = await res.json();
  const pick = (key) => d.table.cells.find((c) => c.cellKey === key) ?? null;
  return {
    readAt: new Date().toISOString(),
    // The serving commit is RE-READ in the beat that is graded. Precedent on
    // this very chain: TRA-4857 was graded on `19e18b8b` and the build restarted
    // onto `f25c77c2` 164 seconds later.
    servingCommit: live.build?.commit ?? null,
    servingPid: live.build?.pid ?? null,
    servingStartedAt: live.build?.startedAt ?? null,
    tableCommit: d.build?.commit ?? null,
    computedAt: d.table?.computedAt ?? null,
    rowsConsidered: d.table?.rowsConsidered ?? null,
    rowsUsed: d.table?.rowsUsed ?? null,
    rowsDroppedUnpriced: d.table?.rowsDroppedUnpriced ?? null,
    cell: pick(CELL),
    control: pick(CONTROL),
    underpoweredCells: d.underpoweredCells ?? null,
    heldForRealFillCells: d.heldForRealFillCells ?? null,
    admittedCells: d.admittedCells ?? null,
  };
}

function fmt(v) { return v === null || v === undefined ? 'absent' : String(v); }

if (!cmpPath) {
  const s = await snap();
  const { writeFileSync } = await import('fs');
  writeFileSync(outPath, JSON.stringify(s, null, 1));
  console.log(`# snapshot -> ${outPath}`);
  console.log(`# serving ${s.servingCommit} pid ${s.servingPid}  table commit ${s.tableCommit}`);
  console.log(`# computedAt ${new Date(s.computedAt).toISOString()}  rowsConsidered ${s.rowsConsidered} rowsUsed ${s.rowsUsed} rowsDroppedUnpriced ${s.rowsDroppedUnpriced}`);
  console.log(`\n# ${CELL}`);
  for (const f of [...FIELDS, ...ADMISSION]) console.log(`  ${f.padEnd(24)} ${fmt(s.cell?.[f])}`);
  console.log(`\n# ${CONTROL} (control — must not move)`);
  for (const f of FIELDS) console.log(`  ${f.padEnd(24)} ${fmt(s.control?.[f])}`);
  console.log(`\n# underpoweredCells: ${JSON.stringify(s.underpoweredCells)}`);
  console.log(`# heldForRealFillCells: ${JSON.stringify(s.heldForRealFillCells)}`);
} else {
  const { readFileSync } = await import('fs');
  const b = JSON.parse(readFileSync(outPath, 'utf8'));
  const a = JSON.parse(readFileSync(cmpPath, 'utf8'));
  console.log(`# BEFORE ${b.readAt} serving ${b.servingCommit?.slice(0, 12)} pid ${b.servingPid}`);
  console.log(`# AFTER  ${a.readAt} serving ${a.servingCommit?.slice(0, 12)} pid ${a.servingPid}`);
  const sameProc = b.servingPid === a.servingPid && b.servingCommit === a.servingCommit;
  console.log(`# same serving process across both reads: ${sameProc}${sameProc ? '' : '  <= a restart sits between them; the deltas below are NOT attributable to the write alone'}`);
  console.log(`# computedAt moved ${new Date(b.computedAt).toISOString()} -> ${new Date(a.computedAt).toISOString()} (365d rolling window; grade DELTAS, not levels)`);

  // The pre-registered predictions from TRA-4947's brief, which the CFO
  // re-derived from live and reproduced to 7 dp.
  const EXPECT = {
    n: [110, 109],
    droppedUnpricedCloses: [0, 1],
    meanR_gate: [1.1291136476289005, 1.1394724884328353],
    sdR_gate: [4.106600511465177, 4.12412470173045],
    seR_gate: [0.39154899566588613, 0.39501950428472654],
    lowerCI95: [0.3616776161237637, 0.36523426003477133],
  };
  let fails = 0;
  console.log(`\n# ${CELL} — graded against the pre-registered prediction`);
  console.log(`${'field'.padEnd(24)} ${'before'.padEnd(22)} ${'after'.padEnd(22)} ${'predicted after'.padEnd(22)} verdict`);
  for (const [f, [pb, pa]] of Object.entries(EXPECT)) {
    const bv = b.cell?.[f] ?? null;
    const av = a.cell?.[f] ?? null;
    const okB = bv === pb;
    const okA = av === pa;
    if (!okA) fails += 1;
    console.log(`${f.padEnd(24)} ${fmt(bv).padEnd(22)} ${fmt(av).padEnd(22)} ${fmt(pa).padEnd(22)} ${okA ? 'MATCH' : 'MISMATCH'}${okB ? '' : '  (before also differed from prediction)'}`);
  }
  // Mandatory, and called out separately because the brief says the acceptance
  // FAILS on this alone even when every other figure matches exactly.
  const dropped = a.cell?.droppedUnpricedCloses;
  console.log(`\n# MANDATORY  droppedUnpricedCloses == 1 after: ${dropped === 1 ? 'PASS' : `FAIL (reads ${fmt(dropped)})`}`);
  if (dropped !== 1) fails += 1;

  console.log('\n# ADMISSION must not move');
  for (const f of ADMISSION) {
    const bv = b.cell?.[f] ?? null;
    const av = a.cell?.[f] ?? null;
    const moved = JSON.stringify(bv) !== JSON.stringify(av);
    if (moved) fails += 1;
    console.log(`  ${f.padEnd(20)} ${fmt(bv)} -> ${fmt(av)}  ${moved ? 'MOVED <= STOP' : 'unchanged'}`);
  }

  console.log(`\n# CONTROL ${CONTROL} must not move at all`);
  for (const f of FIELDS) {
    const bv = b.control?.[f] ?? null;
    const av = a.control?.[f] ?? null;
    const moved = JSON.stringify(bv) !== JSON.stringify(av);
    if (moved) fails += 1;
    console.log(`  ${f.padEnd(24)} ${fmt(bv)} -> ${fmt(av)}  ${moved ? 'MOVED <= FAIL' : 'unchanged'}`);
  }
  const inUnderB = (b.underpoweredCells ?? []).some((c) => String(c).includes(CONTROL) || c?.cellKey === CONTROL);
  const inUnderA = (a.underpoweredCells ?? []).some((c) => String(c).includes(CONTROL) || c?.cellKey === CONTROL);
  console.log(`  still in underpoweredCells: ${inUnderB} -> ${inUnderA}  ${inUnderB === inUnderA ? 'unchanged' : 'MOVED <= FAIL'}`);
  if (inUnderB !== inUnderA) fails += 1;

  console.log(`\n# VERDICT: ${fails === 0 ? 'ALL CHECKS PASS' : `${fails} CHECK(S) FAILED`}`);
  process.exit(fails === 0 ? 0 : 1);
}
