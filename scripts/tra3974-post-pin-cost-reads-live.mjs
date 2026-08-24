// TRA-3974 — GRADE THE POST-PIN COST READS ON LIVE BYTES, on a PINNED build.
//
// AC5 is not satisfied by a merge and not by a unit test. A field that exists in
// the repo and not in the deployed payload satisfies nothing, and the two are
// INDISTINGUISHABLE from the repo (TRA-3660 — a deploy order's commit is a lower
// bound on CONTENT, not an expected reading; grade FIELD PRESENCE).
//
// What this grades, and what it deliberately does NOT:
//
//   • It grades that `evaluationWindow.postPinCost` and `.entryQuote` are on the
//     wire and internally consistent. That is the deliverable.
//   • It does NOT grade `postPinCost.evaluated > 0`. The window is `armed` (card
//     `cc2c36fe` on TRA-3944 is unresolved), so `startedAt` is null and the
//     accumulator's honest state is `armed: false` with a stated reason. A
//     grader that demanded a non-zero count would be demanding the window OPEN,
//     which is a different ticket's decision and not this one's to force.
//   • ⭐ AC1 IS THE ONE READING THAT IS SUPPOSED TO MOVE THE TICKET. `urgency`
//     is printed loudly and is the whole point of running this: `uninstrumented`
//     means the TRA-3945 step-2 median split is dead on arrival and the
//     pre-registration needs re-writing BEFORE the window counts; `recoverable`
//     means it needed a read path, which is what shipped.
//
// ⭐ ABSENT vs NULL IS THE ENTIRE DISCRIMINATION. `postPinCost: null` means "this
// build has the code and has nothing to say"; a MISSING `postPinCost` key means
// "this build does not have the code". They are graded apart on purpose — the
// second is the only one that is a FAIL, and a truthiness test would merge them.
//
// Exit 0 PASS · 1 FAIL · 2 usage · 3 BLIND. BLIND > FAIL > PASS.
// A pin move across the probe INVALIDATES the run — it does not degrade to FAIL,
// because the two reads would then be a mix of two builds.
const HOST = process.argv.find(a => a.startsWith('--host='))?.slice(7)
  ?? 'https://tradingai-bqb1.onrender.com';
const ROUTE = '/api/health/options-live';

const blind = m => { console.error(`BLIND — ${m}`); process.exit(3); };
const has = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const num = n => (typeof n === 'number' && Number.isFinite(n) ? n : null);

const rows = [];
const check = (id, ok, detail) => { rows.push({ id, ok: ok === true, detail }); };

const readRoute = () => fetch(`${HOST}${ROUTE}`).then(x => x.json()).catch(() => null);

const pinOf = b => (b
  ? { commit: b.commit, pid: b.pid, startedAt: b.startedAt, uptimeSec: b.uptimeSec ?? null }
  : null);
const age = p => (typeof p?.uptimeSec === 'number' ? `${p.uptimeSec}s` : 'unknown');
// A fold scored seconds after a boot is not a PASS anyone can bank (TRA-3911).
const SHALLOW_BOOT_SEC = 120;

const first = await readRoute();
if (first === null) blind(`${ROUTE} unreadable`);
const before = pinOf(first.build);
if (!before?.commit) blind('pin unreadable before the probe');
console.log(
  `# pin BEFORE  commit=${before.commit} pid=${before.pid} startedAt=${before.startedAt}`
  + ` uptimeSec=${age(before)}`,
);

const w = first.evaluationWindow;
if (!w) blind('`evaluationWindow` absent — TRA-3945 itself is not on this build, so TRA-3974 cannot be graded on it');
if (w.instrumentBlind === true) blind(`the TRA-3945 record is BLIND: ${w.blindReason ?? 'no reason given'}`);

// ── AC5 — deployed bytes, by FIELD PRESENCE ─────────────────────────────────
check(
  'AC5.marker',
  w.postPinReadsIssue === 'TRA-3974',
  `evaluationWindow.postPinReadsIssue = ${JSON.stringify(w.postPinReadsIssue ?? null)} (want "TRA-3974"; `
  + 'this single field is what separates "deployed" from "merged")',
);
check(
  'AC5.keys',
  has(w, 'postPinCost') && has(w, 'entryQuote'),
  `postPinCost key ${has(w, 'postPinCost') ? 'PRESENT' : 'ABSENT'}, entryQuote key `
  + `${has(w, 'entryQuote') ? 'PRESENT' : 'ABSENT'} — ABSENT means this build predates TRA-3974; `
  + 'null means it has the code and nothing to say. Those are different findings.',
);

const cost = w.postPinCost ?? null;
const eq = w.entryQuote ?? null;

// ── AC2 — the window-scoped accumulator ─────────────────────────────────────
check(
  'AC2.published',
  cost !== null && cost.issue === 'TRA-3974' && cost.readOnly === true,
  cost === null
    ? 'postPinCost is NULL — the tick could not build it (see the server log line "TRA-3974 post-pin reads failed")'
    : `issue=${cost.issue} readOnly=${cost.readOnly} armed=${cost.armed}`,
);
if (cost !== null && cost.armed === true) {
  check(
    'AC2.postPinByConstruction',
    cost.postPinByConstruction === true && typeof cost.startedAt === 'string'
    && Array.isArray(cost.cellKeys) && cost.cellKeys.length > 0,
    `startedAt=${cost.startedAt} cellKeys=${JSON.stringify(cost.cellKeys)} armLagMs=${cost.armLagMs}`
    + (num(cost.armLagMs) > 0
      ? ' ⚠ NON-ZERO ARM LAG — this accumulator shipped AFTER the pin and the gap is NOT recoverable from it.'
      : ''),
  );
  check(
    'AC2.refusalsNamed',
    cost.refused !== undefined && typeof cost.refused === 'object'
    && ['notArmed', 'prePin', 'otherGate', 'otherCell', 'noCell', 'noCost', 'replayDuplicate']
      .every(k => typeof cost.refused[k] === 'number'),
    `refused=${JSON.stringify(cost.refused ?? null)} — every refusal countable, so a zero `
    + 'evaluated count can be told apart from a silently-filtered one',
  );
  check(
    'AC2.quantilesRepresentative',
    cost.quantiles !== undefined
    && typeof cost.quantiles.sampled === 'number'
    && typeof cost.quantiles.capacity === 'number'
    && typeof cost.quantiles.sampling === 'boolean'
    && cost.exact !== undefined && typeof cost.exact.spreadR.n === 'number',
    `evaluated=${cost.evaluated} exact.spreadR.n=${cost.exact?.spreadR?.n} `
    + `reservoir sampled=${cost.quantiles?.sampled}/${cost.quantiles?.capacity} `
    + `sampling=${cost.quantiles?.sampling} replaced=${cost.quantiles?.replaced} `
    + `spreadR p50=${cost.quantiles?.spreadR?.p50}`,
  );
  // The identity the whole ticket is about: nothing before the pin is in here.
  const first2 = cost.firstTs === null ? null : Date.parse(cost.firstTs);
  check(
    'AC2.noPrePinRow',
    cost.firstTs === null || first2 >= Date.parse(cost.startedAt),
    cost.firstTs === null
      ? 'no rows accrued yet — vacuously post-pin'
      : `firstTs=${cost.firstTs} >= startedAt=${cost.startedAt}`,
  );
} else if (cost !== null) {
  // The expected state while TRA-3944 card `cc2c36fe` is unresolved.
  check(
    'AC2.armedRestingState',
    cost.armed === false && typeof cost.note === 'string' && cost.note.includes('NOT ARMED'),
    `armed=false with a stated reason — correct while the TRA-3945 window is \`${w.status}\` `
    + `and startedAt is ${w.startedAt}. This is the resting state, NOT a fault.`,
  );
}

// ── AC1 — live-mode fill-quote coverage. THE reading. ───────────────────────
check(
  'AC1.published',
  eq !== null && eq.mode === 'live' && eq.readOnly === true && eq.allLive !== undefined,
  eq === null ? 'entryQuote is NULL' : `mode=${eq.mode} readOnly=${eq.readOnly} sleeve=${eq.sleeve}`,
);
if (eq !== null) {
  const a = eq.allLive;
  check(
    'AC1.coverage',
    typeof a?.rowsTotal === 'number' && typeof a?.rowsWithQuote === 'number'
    && (a.rowsTotal === 0 ? a.coverage === null : num(a.coverage) !== null),
    `rowsWithQuote/rowsTotal = ${a?.rowsWithQuote}/${a?.rowsTotal} `
    + `coverage=${a?.coverage} (null on an EMPTY population, never 0 — "never measured" `
    + 'is not "measured and uninstrumented")',
  );
  check(
    'AC1.missesSeparated',
    a?.misses !== undefined
    && ['no_stamp', 'partial_stamp', 'unusable_quote'].every(k => typeof a.misses[k] === 'number'),
    `misses=${JSON.stringify(a?.misses ?? null)} — no_stamp is a RECORDER gap (fixable forward), `
    + 'unusable_quote is a MARKET-DATA gap on a row the recorder did reach (never fixable)',
  );
  check(
    'AC1.urgencyStated',
    ['uninstrumented', 'partial', 'recoverable', 'no_population'].includes(eq.urgency),
    `urgency=${eq.urgency}`,
  );
  // ── AC3 — the median split ────────────────────────────────────────────────
  check(
    'AC3.splitPublished',
    eq.split !== undefined && typeof eq.split.computable === 'boolean'
    && typeof eq.split.minN === 'number' && eq.split.tiesGoTo === 'cheap'
    && (eq.split.computable === true || typeof eq.split.blindReason === 'string'),
    `split n=${eq.split?.n} computable=${eq.split?.computable} `
    + `median=${eq.split?.medianEntrySpreadR} cheap.n=${eq.split?.cheap?.n} rich.n=${eq.split?.rich?.n} `
    + `avgRDelta=${eq.split?.avgRDelta}`
    + (eq.split?.computable === false ? ` blind: ${eq.split?.blindReason}` : ''),
  );
}

// ── AC4 — additive and read-only: nothing the record already published moved ─
check(
  'AC4.recordIntact',
  typeof w.status === 'string' && typeof w.n === 'number'
  && has(w, 'populationCell') && has(w, 'thresholds') && has(w, 'excludedCloses')
  && w.onFail === 'REPORT ONLY - drop the arm, do not re-tune; QuantTrader files the verdict to the board',
  `status=${w.status} n=${w.n} targetCloses=${w.targetCloses} criteria=${w.criteria} `
  + `populationCell=${w.populationCell === null ? 'null' : `[${w.populationCell.deltaAbsMin},${w.populationCell.deltaAbsMax}) frozen=${w.populationCell.frozen}`}`,
);

const second = await readRoute();
if (second === null) blind(`${ROUTE} unreadable on the re-read`);
const after = pinOf(second.build);
if (!after?.commit) blind('pin unreadable after the probe');
console.log(
  `# pin AFTER   commit=${after.commit} pid=${after.pid} startedAt=${after.startedAt}`
  + ` uptimeSec=${age(after)}`,
);
if (before.commit !== after.commit || before.pid !== after.pid
  || before.startedAt !== after.startedAt) {
  blind('THE PIN MOVED ACROSS THE PROBE — the rows are a mix of two builds. Re-run.');
}

console.log('');
if (eq !== null) console.log(`# AC1 ${eq.urgency.toUpperCase()} — ${eq.note}`);
if (cost !== null) console.log(`# AC2 ${cost.note}`);

console.log('');
let failed = 0;
for (const r of rows) {
  if (!r.ok) failed += 1;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  --  ${r.detail}`);
}
console.log(`\n${rows.length - failed}/${rows.length} criteria pass.`);

const shallow = typeof after.uptimeSec === 'number' && after.uptimeSec < SHALLOW_BOOT_SEC;
const depth = `boot age ${age(before)} -> ${age(after)}`;
if (failed > 0) { console.log(`FAIL  (${depth})`); process.exit(1); }
if (shallow) {
  console.log(
    `SHALLOW — scored under ${SHALLOW_BOOT_SEC}s of uptime (${depth}). NOT blind, but re-read at`
    + ' depth before citing it. The cure is a SECOND READ, never a re-ship.',
  );
}
console.log(
  `PASS — the TRA-3974 post-pin cost reads are PUBLISHED and READ-ONLY on this pinned build (${depth}).`,
);
process.exit(0);
