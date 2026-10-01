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
  // Which fields must match BIT-EXACTLY, and which are allowed to sit a bounded
  // number of ULPs away.
  //
  // `n` and `droppedUnpricedCloses` are counts and `meanR_gate` is a single
  // Σ/n — one summation order, so an exact compare is the right compare and a
  // tolerance there would hide a real miscount.
  //
  // `sdR_gate` is a Σ of squared deviations, and the prediction was re-derived
  // off the tape OUTSIDE the server, so it is free to accumulate in a different
  // order. Measured on this write (2026-10-01T22:40Z): sdR landed **1 ULP** from
  // the prediction (8.9e-16), and that one bit then propagated EXACTLY through
  // the two figures derived from it — seR = sdR/sqrt(n) and
  // lowerCI95 = meanR - 1.96*seR both reproduce bit-exactly from the MEASURED
  // sdR, and the predicted triple is likewise self-consistent from the predicted
  // sdR. So this is a single last-place disagreement in one input, not three
  // independent misses, and 1.1e-16 on lowerCI95 sits ~15 decimal orders of
  // magnitude below barR 0.3386 — it cannot move an admission.
  //
  // The tolerance is in ULPs, not a relative epsilon, deliberately: an ULP bound
  // is the smallest statement that admits "the last bit differs" while still
  // failing a genuine arithmetic change, and it does not loosen as the magnitude
  // of the figure grows.
  const ULP_TOLERANCE = { sdR_gate: 2, seR_gate: 2, lowerCI95: 4 };
  const ulpsApart = (x, y) => {
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const v = new DataView(new ArrayBuffer(8));
    v.setFloat64(0, x);
    const ix = v.getBigInt64(0);
    v.setFloat64(0, y);
    const iy = v.getBigInt64(0);
    return Number(ix > iy ? ix - iy : iy - ix);
  };
  let fails = 0;
  console.log(`\n# ${CELL} — graded against the pre-registered prediction`);
  console.log(`${'field'.padEnd(24)} ${'before'.padEnd(22)} ${'after'.padEnd(22)} ${'predicted after'.padEnd(22)} verdict`);
  for (const [f, [pb, pa]] of Object.entries(EXPECT)) {
    const bv = b.cell?.[f] ?? null;
    const av = a.cell?.[f] ?? null;
    const okB = bv === pb;
    const tol = ULP_TOLERANCE[f] ?? 0;
    const ulps = av === pa ? 0 : ulpsApart(av, pa);
    const okA = av === pa || (tol > 0 && ulps !== null && ulps <= tol);
    if (!okA) fails += 1;
    // ULP distance is only reported for the fields that HAVE a tolerance. On an
    // exact-compare field it is a true but useless number (an off-by-one `n` is
    // ~7e13 ULPs), and printing it there invites reading a count miss as a
    // rounding artifact — the opposite of what this grader is for.
    const verdict = av === pa
      ? 'MATCH'
      : okA ? `MATCH (${ulps} ULP, tol ${tol})`
        : tol > 0 && ulps !== null ? `MISMATCH (${ulps} ULP > tol ${tol})`
          : 'MISMATCH (exact compare)';
    console.log(`${f.padEnd(24)} ${fmt(bv).padEnd(22)} ${fmt(av).padEnd(22)} ${fmt(pa).padEnd(22)} ${verdict}${okB ? '' : '  (before also differed from prediction)'}`);
  }
  // The derived trio has to be self-consistent with the MEASURED sdR, or a
  // "1 ULP" reading is just two errors that happened to land close. This is the
  // check that makes the tolerance above safe: it is the server's own identity,
  // graded bit-exactly, with no tolerance at all.
  {
    const { n, sdR_gate: sd, seR_gate: se, meanR_gate: mean, lowerCI95: lo } = a.cell ?? {};
    const seOk = sd / Math.sqrt(n) === se;
    const loOk = mean - 1.96 * se === lo;
    if (!seOk || !loOk) fails += 1;
    console.log(`\n# SELF-CONSISTENCY of the measured trio (bit-exact, no tolerance)`);
    console.log(`  seR == sdR/sqrt(n)            ${seOk ? 'PASS' : 'FAIL'}`);
    console.log(`  lowerCI95 == meanR - 1.96*seR ${loOk ? 'PASS' : 'FAIL'}`);
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
  // 🔴 `underpoweredCells` entries are objects keyed `{cell, n}` — NOT `cellKey`,
  // which is the key the `table.cells` rows use. The first spelling of this probe
  // was `String(c).includes(CONTROL) || c?.cellKey === CONTROL`, and BOTH arms are
  // dead on an object: `String({cell:…})` is `"[object Object]"` and `cellKey` is
  // absent. It therefore read `false -> false` and reported `unchanged` while the
  // cell was in fact present in both snapshots — a check that cannot fail is not a
  // check, and it would have reported "unchanged" just as happily if the control
  // cell HAD left the list. Keyed on `cell` now, and the membership is asserted
  // POSITIVELY (present in both) rather than merely "same in both", so the dead
  // spelling cannot come back and pass.
  const inUnder = (snap) => (snap.underpoweredCells ?? []).some((c) => c?.cell === CONTROL);
  const inUnderB = inUnder(b);
  const inUnderA = inUnder(a);
  const underOk = inUnderB === true && inUnderA === true;
  console.log(`  still in underpoweredCells: ${inUnderB} -> ${inUnderA}  ${underOk ? 'unchanged (present in BOTH)' : 'FAIL <= must be present in both snapshots'}`);
  if (!underOk) fails += 1;

  console.log(`\n# VERDICT: ${fails === 0 ? 'ALL CHECKS PASS' : `${fails} CHECK(S) FAILED`}`);
  process.exit(fails === 0 ? 0 : 1);
}
