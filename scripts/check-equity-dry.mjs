#!/usr/bin/env node
// check-equity-dry.mjs — TRA-5089
//
// On ET day 2026-10-02 the equity swing sleeve ran a full session (778/1,557
// iterated passes, 48,652 symbol-evaluations across demo+live) and generated
// ZERO candidates — and nothing paged. `zeroedAtStage: no_candidates` was
// published on /api/health/equity-entry-funnel and watched by nobody: every
// health route read `ok: true` all day, and /api/health/live-equity cheerfully
// reported the sleeve armed. While the sleeve is dry it accrues zero
// observations, so every acceptance arm that needs admits stays unfalsifiable
// — a forward test that is not testing anything, on instruments that read
// healthy (the recurring shape: an instrument that reads identically in pass
// and fail).
//
// The 10-02 mechanism, for the next reader of a RED: the Yahoo breaker was
// open the whole session, `fetchDailyCandles` is Yahoo-ONLY, so the SMA200
// daily sweep read `evaluated: 0 / starvedBreakerOpen: 100` on all four
// engines (TRA-4457 census, log line `sma200 scan swept`) — the primary swing
// router starved on DATA while the funnel stamped the day `no_candidates`,
// which its own read rule calls a STRATEGY verdict. First diagnostic steps on
// a RED: (1) the `sma200 scan swept` census lines for the day, (2)
// `feedDegradation.yahoo.open` on /api/health/quotes, (3) the churn-brake
// `opensPresented` denominator (a collapse there says candidate ARRIVALS died
// upstream, not that a guardrail ate them).
//
// What this grades — the DURABLE per-ET-day funnel ledger
// (`retained.byEtDay` on /api/health/equity-entry-funnel, TRA-4998), not the
// since-boot counters (bqb1 reboots ~6x/day). Target day = the most recent ET
// day with an ITERATED pass (sessions where every pass was gated — weekends,
// holidays — are not gradeable and are skipped, never graded green).
//
//   DRY (per mode row) ⇔ passesIterated ≥ --min-passes (50)
//                      AND symbolsEvaluated ≥ --min-symbols (1000)
//                      AND candidates == 0
//
// `symbolsEvaluated ≥ floor` is what keeps this from colliding with the
// opposite failure: a session whose SWEEP was starved (symbolsEvaluated ~0)
// is a DATA outage wearing different clothes and must read UNREAD here, not
// DRY — the funnel's own symbolReadRule draws exactly this line.
//
// Usage:
//   node scripts/check-equity-dry.mjs                   # grade the live box
//   node scripts/check-equity-dry.mjs --host=https://…  # another deployment
//   node scripts/check-equity-dry.mjs --fixture=f.json  # grade a saved payload
//   node scripts/check-equity-dry.mjs --day=2026-10-02  # pin the target day
//   node scripts/check-equity-dry.mjs --selftest        # control suite
//
// Exit codes — FAILS CLOSED, "could not check" never shares a code with
// "checked and it is fine":
//   0  CLEAR   — the most recent iterated session produced candidates on every
//                gradeable mode row.
//   1  DRY     — a mode row met the thresholds with candidates == 0. The RED
//                names the sleeve, mode, ET day and the numbers.
//   2  usage   — bad flags.
//   3  UNREAD  — route unreachable / malformed payload / no retained rows /
//                no iterated session in the lookback / no row met the
//                thresholds. NEVER a pass.
//   6  control suite failure (--selftest found a control off its pin).

const DEFAULT_HOST = 'https://tradingai-bqb1.onrender.com';
const ROUTE = '/api/health/equity-entry-funnel';

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const valOf = name => {
  const hit = argv.find(a => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
};

const HOST = (valOf('--host') ?? process.env.EQUITY_DRY_HOST ?? DEFAULT_HOST).replace(/\/+$/, '');
const FIXTURE = valOf('--fixture');
const DAY = valOf('--day');
const MIN_PASSES = Number(valOf('--min-passes') ?? 50);
const MIN_SYMBOLS = Number(valOf('--min-symbols') ?? 1000);
const LOOKBACK_DAYS = Number(valOf('--lookback-days') ?? 7);
const TIMEOUT_MS = Number(valOf('--timeout-ms') ?? 25_000);

const known = ['--selftest'];
for (const a of argv) {
  const name = a.split('=')[0];
  if (!known.includes(name) && !['--host', '--fixture', '--day', '--min-passes', '--min-symbols', '--lookback-days', '--timeout-ms'].includes(name)) {
    console.error(`[equity-dry] unknown argument: ${a} (exit 2 — an unrecognized flag must never be silently ignored, TRA-4420)`);
    process.exit(2);
  }
}
if ([MIN_PASSES, MIN_SYMBOLS, LOOKBACK_DAYS, TIMEOUT_MS].some(n => !Number.isFinite(n) || n < 0)) {
  console.error('[equity-dry] numeric flag did not parse (exit 2)');
  process.exit(2);
}

/**
 * Pure grader. Returns { code, verdict, lines[] } — no I/O, so the control
 * suite exercises the exact function the live path runs.
 */
export function gradeEquityDry(payload, opts = {}) {
  const minPasses = opts.minPasses ?? 50;
  const minSymbols = opts.minSymbols ?? 1000;
  const lookbackDays = opts.lookbackDays ?? 7;
  const pinnedDay = opts.day;

  const rows = payload?.retained?.byEtDay;
  if (!Array.isArray(rows) || rows.length === 0) {
    return { code: 3, verdict: 'UNREAD', lines: ['retained.byEtDay is missing or empty — the durable ledger could not be read. UNREAD, not clear.'] };
  }

  const byDay = new Map();
  for (const r of rows) {
    if (typeof r?.etDay !== 'string') continue;
    if (!byDay.has(r.etDay)) byDay.set(r.etDay, []);
    byDay.get(r.etDay).push(r);
  }
  const days = [...byDay.keys()].sort().reverse();
  if (days.length === 0) {
    return { code: 3, verdict: 'UNREAD', lines: ['no etDay-keyed rows in retained.byEtDay. UNREAD.'] };
  }

  let targetDay = null;
  if (pinnedDay) {
    if (!byDay.has(pinnedDay)) {
      return { code: 3, verdict: 'UNREAD', lines: [`--day=${pinnedDay} has no row in the ledger (ledger spans ${days[days.length - 1]}..${days[0]}). UNREAD.`] };
    }
    targetDay = pinnedDay;
  } else {
    for (const d of days.slice(0, lookbackDays)) {
      if (byDay.get(d).some(r => (r.passesIterated ?? 0) > 0)) { targetDay = d; break; }
    }
    if (targetDay === null) {
      return {
        code: 3, verdict: 'UNREAD',
        lines: [`no ET day with an iterated pass in the newest ${lookbackDays} ledger days (${days.slice(0, lookbackDays).join(', ')}) — all passes gated (weekend/holiday shape, or the engine never iterated). Nothing gradeable. UNREAD, not clear.`],
      };
    }
  }

  const dry = [];
  const flowing = [];
  const thin = [];
  const starved = [];
  for (const r of byDay.get(targetDay)) {
    const mode = r.mode ?? 'unknown';
    const iter = r.passesIterated ?? 0;
    const evald = r.symbolsEvaluated ?? 0;
    const cand = r.candidates ?? 0;
    if (iter >= minPasses && evald < minSymbols) {
      // A full session of iterated passes that evaluated ~no symbols is the
      // SWEEP-starved DATA state, not a dry strategy. Do not label it DRY.
      starved.push({ mode, iter, evald, cand });
    } else if (iter >= minPasses && evald >= minSymbols && cand === 0) {
      dry.push({ mode, iter, evald, cand, stage: r.zeroedAtStage ?? null });
    } else if (iter >= minPasses && evald >= minSymbols) {
      flowing.push({ mode, iter, evald, cand });
    } else {
      thin.push({ mode, iter, evald, cand });
    }
  }

  const lines = [`target ET day ${targetDay} (thresholds: passesIterated>=${minPasses}, symbolsEvaluated>=${minSymbols})`];
  for (const f of flowing) lines.push(`  ${f.mode}: FLOWING — ${f.cand} candidates over ${f.iter} iterated passes / ${f.evald} symbol-evaluations`);
  for (const d of dry) lines.push(`  ${d.mode}: DRY — equity sleeve generated ZERO candidates over ${d.iter} iterated passes / ${d.evald} symbol-evaluations (zeroedAtStage: ${d.stage})`);
  for (const s of starved) lines.push(`  ${s.mode}: SWEEP-STARVED — ${s.iter} iterated passes but only ${s.evald} symbol-evaluations: a DATA outage, not a dry strategy (check the feed, not the signals)`);
  for (const t of thin) lines.push(`  ${t.mode}: thin (${t.iter} iterated passes / ${t.evald} evaluations) — below thresholds, not gradeable`);

  if (dry.length > 0) {
    lines.push('');
    lines.push(`RED: the equity sleeve was DRY on ${targetDay} on mode(s): ${dry.map(d => d.mode).join(', ')}.`);
    lines.push('While dry, the sleeve accrues zero observations and every admit-dependent acceptance arm is unfalsifiable.');
    lines.push("First steps: grep the day's `sma200 scan swept` census (starvedBreakerOpen?), read feedDegradation.yahoo.open on /api/health/quotes, and compare churn-brake opensPresented against its ~45-62k/session baseline.");
    return { code: 1, verdict: 'DRY', lines };
  }
  if (flowing.length > 0) {
    return { code: 0, verdict: 'CLEAR', lines };
  }
  lines.push('');
  lines.push(starved.length > 0
    ? 'UNREAD: every gradeable row is in the sweep-starved DATA state — this alarm cannot certify the strategy side, and the day is NOT healthy. Investigate the feed.'
    : 'UNREAD: no mode row met the thresholds — nothing gradeable on the target day.');
  return { code: 3, verdict: 'UNREAD', lines };
}

function emit(result, source) {
  console.log(`[equity-dry] source: ${source}`);
  for (const l of result.lines) console.log(`[equity-dry] ${l}`);
  console.log(`[equity-dry] verdict: ${result.verdict} (exit ${result.code})`);
  return result.code;
}

async function runLiveOrFixture() {
  let payload;
  let source;
  if (FIXTURE) {
    source = `fixture ${FIXTURE}`;
    try {
      const { readFileSync } = await import('node:fs');
      payload = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    } catch (err) {
      console.log(`[equity-dry] fixture unreadable: ${err instanceof Error ? err.message : String(err)}`);
      console.log('[equity-dry] verdict: UNREAD (exit 3)');
      return 3;
    }
  } else {
    const url = `${HOST}${ROUTE}`;
    source = url;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const resp = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!resp.ok) {
        console.log(`[equity-dry] ${url} answered HTTP ${resp.status} — cannot read the ledger.`);
        console.log('[equity-dry] verdict: UNREAD (exit 3)');
        return 3;
      }
      payload = await resp.json();
    } catch (err) {
      console.log(`[equity-dry] ${url} unreachable: ${err instanceof Error ? err.message : String(err)}`);
      console.log('[equity-dry] verdict: UNREAD (exit 3)');
      return 3;
    }
  }
  const result = gradeEquityDry(payload, { minPasses: MIN_PASSES, minSymbols: MIN_SYMBOLS, lookbackDays: LOOKBACK_DAYS, day: DAY });
  return emit(result, source);
}

// ── Control suite ───────────────────────────────────────────────────────────
// Three states the issue demanded — green, red-that-names-the-sleeve, and
// UNREAD-on-absent-data — plus the two collisions this grader must NOT make:
// an all-gated (weekend) ledger must not read green, and a sweep-starved DATA
// day must not read DRY.
function selftest() {
  const mk = rows => ({ retained: { byEtDay: rows } });
  const healthyDemo = { etDay: '2026-10-01', mode: 'demo', passesIterated: 760, symbolsEvaluated: 15800, candidates: 37, zeroedAtStage: null };
  const healthyLive = { etDay: '2026-10-01', mode: 'live', passesIterated: 1500, symbolsEvaluated: 31000, candidates: 81, zeroedAtStage: null };
  // C1 is the 10-02 incident row, verbatim shape.
  const dryDemo = { etDay: '2026-10-02', mode: 'demo', passesIterated: 778, symbolsEvaluated: 16212, candidates: 0, zeroedAtStage: 'no_candidates' };
  const dryLive = { etDay: '2026-10-02', mode: 'live', passesIterated: 1557, symbolsEvaluated: 32440, candidates: 0, zeroedAtStage: 'no_candidates' };
  const gatedSat = { etDay: '2026-10-03', mode: 'demo', passesIterated: 0, symbolsEvaluated: 0, candidates: 0, zeroedAtStage: 'all_passes_gated' };
  const starvedRow = { etDay: '2026-10-02', mode: 'demo', passesIterated: 778, symbolsEvaluated: 12, candidates: 0, zeroedAtStage: 'all_symbols_skipped' };

  const controls = [
    {
      name: 'C0 GREEN — healthy session reads CLEAR',
      payload: mk([healthyDemo, healthyLive]),
      opts: {},
      wantCode: 0,
      wantText: 'FLOWING',
    },
    {
      name: 'C1 RED — the 10-02 incident rows read DRY and NAME the sleeve/mode/day',
      payload: mk([healthyDemo, healthyLive, dryDemo, dryLive, gatedSat]),
      opts: {},
      wantCode: 1,
      wantText: 'DRY on 2026-10-02 on mode(s): demo, live',
    },
    {
      name: 'C2 UNREAD — absent/malformed ledger is exit 3, never 0',
      payload: { ok: true, retained: {} },
      opts: {},
      wantCode: 3,
      wantText: 'UNREAD',
    },
    {
      name: 'C3 UNREAD — an all-gated (weekend) window is not gradeable and must not read green',
      payload: mk([gatedSat, { ...gatedSat, mode: 'live' }]),
      opts: {},
      wantCode: 3,
      wantText: 'all passes gated',
    },
    {
      name: 'C4 — a sweep-starved DATA day must not read DRY (different alarm, different fix)',
      payload: mk([starvedRow]),
      opts: { day: '2026-10-02' },
      wantCode: 3,
      wantText: 'SWEEP-STARVED',
    },
  ];

  let failed = 0;
  for (const c of controls) {
    const r = gradeEquityDry(c.payload, c.opts);
    const text = r.lines.join('\n');
    const codeOk = r.code === c.wantCode;
    const textOk = text.includes(c.wantText);
    const ok = codeOk && textOk;
    if (!ok) failed++;
    console.log(`[equity-dry:controls] ${ok ? 'PASS' : 'FAIL'} ${c.name}`);
    if (!codeOk) console.log(`[equity-dry:controls]   expected exit ${c.wantCode}, got ${r.code}`);
    if (!textOk) console.log(`[equity-dry:controls]   expected output to contain ${JSON.stringify(c.wantText)}; got:\n${text.split('\n').map(l => '    ' + l).join('\n')}`);
  }
  if (failed > 0) {
    console.log(`[equity-dry:controls] ${failed}/${controls.length} controls FAILED — the alarm itself is off its pin (exit 6)`);
    return 6;
  }
  console.log(`[equity-dry:controls] all ${controls.length} controls pass`);
  return 0;
}

const code = has('--selftest') ? selftest() : await runLiveOrFixture();
process.exit(code);
