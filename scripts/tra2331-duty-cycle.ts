/**
 * TRA-2331 — measure the DUTY CYCLE `p` of the risk-autopilot throttle.
 *
 * `p` = the fraction of option ENTRIES that were taken while the governor's
 * combined `riskThrottle` read < 1. It is the whole spread in the ETA for the
 * TRA-2331 grade: the grade needs n(T) >= 135 TRIMMED eligible fills, and
 *
 *     sessions_to_verdict = 135 / (p * eligible_fills_per_session)
 *
 * so p = 0.5 puts the verdict ~3 weeks out and p = 0.02 puts it ~5 years out.
 * Until now p was quoted as UNMEASURED (see the throttle-cluster notes); this
 * script measures the only trigger that CAN fire off option tape, and states
 * plainly which triggers it does not model.
 *
 * ── WHICH TRIGGER THIS MODELS, AND WHY ONLY ONE ──────────────────────────────
 * `evaluateRiskAutopilot` has four throttle triggers. Their live drivers:
 *
 *   1. loss_streak      — `DailyRiskGovernor.consecutiveLosses`
 *   2. daily_drawdown   — `DailyRiskGovernor.dailyPnl`
 *   3. high_vol regime  — `cachedMarketReview.regime === 'red'` (premarket review)
 *   4. edge_decay       — `computeStrategyIntrospection(...).degradingStrategies`
 *
 * (1) and (2) are fed ONLY by `riskGovernor.recordTrade(...)`, and every call
 * site of it closes an EQUITY position (`signal-engine.ts` :3981 equity
 * checkExits, :7669 equity flatten-on-halt, :11968 live equity, :11979 demo
 * equity manual close). Option closes go to `optionsBreaker.recordClose(...)`,
 * a different breaker. So no amount of option tape can move triggers 1-2.
 * (3) is an external label with no journal representation.
 *
 * (4) is a PURE function of the model-facing journal, which is served publicly,
 * so it is exactly replayable as-of any past instant. That is what this does.
 *
 * ⇒ every number printed here is a LOWER BOUND on p, and it is the bound that
 * matters for the option sleeve the grade actually consumes.
 *
 * ── METHOD ──────────────────────────────────────────────────────────────────
 * The decay list is refreshed on a cadence inside the session, so a session is
 * not a single state. We evaluate each ET session at its FIRST entry and at its
 * LAST entry and report a BRACKET:
 *   p_lo — entries in sessions flagged at BOTH ends / all entries
 *   p_hi — entries in sessions flagged at EITHER end / all entries
 * A session where the two disagree is reported as AMBIGUOUS, never averaged
 * away. If p_lo == p_hi the bracket is a point estimate.
 *
 * Usage:
 *   pnpm -C packages/server exec tsx ../../scripts/tra2331-duty-cycle.ts [--json] [--file=path]
 */
import { excludeTestAccountRows } from '../packages/server/src/test-accounts.js';
import {
  computeStrategyIntrospection,
  optionJournalToStrategyRows,
} from '../packages/server/src/strategy-introspection.js';
import type { OptionTradeJournalRecord } from '../packages/server/src/option-trade-journal.js';

const BASE = process.env.TRA_BASE ?? 'https://tradingai-bqb1.onrender.com';
const JSON_OUT = process.argv.includes('--json');
const FILE = process.argv.find((a) => a.startsWith('--file='))?.slice('--file='.length);

/** Mirrors `risk-autopilot.ts`: each decaying strategy multiplies 0.5, floored at 0.1. */
const EDGE_DECAY_THROTTLE = 0.5;
const MIN_RISK_THROTTLE = 0.1;
const throttleFor = (k: number): number =>
  k === 0 ? 1 : Math.max(MIN_RISK_THROTTLE, EDGE_DECAY_THROTTLE ** k);

/** ET session date key for a ms timestamp (the same roll the governor uses). */
function etDayKey(ts: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts));
}

async function loadRows(): Promise<OptionTradeJournalRecord[]> {
  if (FILE) {
    const fs = await import('node:fs/promises');
    const body = JSON.parse(await fs.readFile(FILE, 'utf8'));
    return (body.rows ?? body) as OptionTradeJournalRecord[];
  }
  const res = await fetch(`${BASE}/api/health/option-journal?rows=all`);
  if (!res.ok) throw new Error(`option-journal ${res.status}`);
  const body = (await res.json()) as { rows?: OptionTradeJournalRecord[] };
  if (!Array.isArray(body.rows)) throw new Error('no rows[] on the journal payload');
  return body.rows;
}

function main(rows: OptionTradeJournalRecord[]) {
  const demo = rows.filter((r) => r.mode === 'demo');
  // Same basis the autopilot trains on: QA/test books out, unattributed kept.
  const modelFacing = excludeTestAccountRows(demo);
  const strategyRows = optionJournalToStrategyRows(modelFacing).sort((a, b) => a.closeTs - b.closeTs);

  /** Degrading-cohort count using only trades CLOSED strictly before `ts`. */
  const decayAt = (ts: number): string[] => {
    const asOf = strategyRows.filter((r) => r.closeTs < ts);
    return computeStrategyIntrospection(asOf).degradingStrategies;
  };

  // Entries, grouped by ET session.
  const entries = modelFacing
    .filter((r) => typeof r.openTs === 'number')
    .sort((a, b) => a.openTs - b.openTs);
  const bySession = new Map<string, number[]>();
  for (const e of entries) {
    const k = etDayKey(e.openTs);
    (bySession.get(k) ?? bySession.set(k, []).get(k)!).push(e.openTs);
  }

  const sessions = [...bySession.entries()].sort(([a], [b]) => a.localeCompare(b));
  const perSession = sessions.map(([day, ts]) => {
    const first = decayAt(ts[0]!);
    const last = decayAt(ts[ts.length - 1]!);
    return {
      day,
      entries: ts.length,
      firstFlagged: first.length,
      lastFlagged: last.length,
      firstThrottle: throttleFor(first.length),
      lastThrottle: throttleFor(last.length),
      state:
        first.length > 0 && last.length > 0
          ? 'THROTTLED'
          : first.length === 0 && last.length === 0
            ? 'FULL'
            : 'AMBIGUOUS',
      cohorts: [...new Set([...first, ...last])],
    };
  });

  const totalEntries = perSession.reduce((a, s) => a + s.entries, 0);
  const lo = perSession.filter((s) => s.state === 'THROTTLED').reduce((a, s) => a + s.entries, 0);
  const hi = perSession
    .filter((s) => s.state !== 'FULL')
    .reduce((a, s) => a + s.entries, 0);
  const pLo = totalEntries > 0 ? lo / totalEntries : 0;
  const pHi = totalEntries > 0 ? hi / totalEntries : 0;

  // Current state — the negative control against the live `autopilot.riskThrottle`.
  const nowDecay = computeStrategyIntrospection(strategyRows);
  const judged = nowDecay.edgeDecay.filter((e) => e.decayThresholdR !== null);

  // ETA arithmetic against the TRA-2331 power floor.
  const N_FLOOR = 135;
  const sessionsWithEntries = perSession.filter((s) => s.entries > 0);
  const recent = sessionsWithEntries.slice(-10);
  const eligiblePerSession =
    recent.length > 0 ? recent.reduce((a, s) => a + s.entries, 0) / recent.length : 0;
  const eta = (p: number) =>
    p <= 0 || eligiblePerSession <= 0 ? Infinity : N_FLOOR / (p * eligiblePerSession);
  // The ENTRY-weighted p above is inflated whenever the throttled sessions were
  // busier than average (they were: 07-02 carried 220 entries against a 17.8
  // current run-rate). The SESSION-weighted rate — how often a session is
  // throttled at all — priced at TODAY's per-session volume is the conservative
  // companion. Report both; the truth is bracketed by them.
  const throttledSessions = perSession.filter((s) => s.state === 'THROTTLED').length;
  const pSession = perSession.length > 0 ? throttledSessions / perSession.length : 0;
  const etaSessionWeighted = eta(pSession);

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          base: FILE ?? BASE,
          rows: rows.length,
          demoRows: demo.length,
          modelFacingRows: modelFacing.length,
          closedStrategyRows: strategyRows.length,
          totalEntries,
          pLo,
          pHi,
          pSession,
          throttledSessions,
          sessions: perSession.length,
          eligiblePerSession,
          etaSessionsLo: eta(pHi),
          etaSessionsHi: eta(pLo),
          etaSessionWeighted,
          nowDegrading: nowDecay.degradingStrategies,
          judgedCohorts: judged.map((e) => ({
            strategy: e.strategy,
            degrading: e.degrading,
            recentExpectancy: e.recentExpectancy,
            decayThresholdR: e.decayThresholdR,
            recentTrades: e.recentTrades,
            baselineTrades: e.baselineTrades,
          })),
          perSession,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log('TRA-2331 — risk-throttle DUTY CYCLE (edge-decay trigger only)');
  console.log(`source ${FILE ?? BASE}  rows=${rows.length} demo=${demo.length} modelFacing=${modelFacing.length}`);
  console.log(`closed strategy rows ${strategyRows.length}  entries ${totalEntries}  sessions ${perSession.length}`);
  console.log('');
  console.log('CURRENT STATE (negative control — compare to /api/health/live autopilot.riskThrottle)');
  console.log(`  degradingStrategies = ${JSON.stringify(nowDecay.degradingStrategies)}`);
  console.log(`  implied riskThrottle from edge decay = ${throttleFor(nowDecay.degradingStrategies.length)}`);
  console.log(`  judged cohorts (enough trades to fire): ${judged.length}`);
  for (const e of judged) {
    console.log(
      `    ${e.strategy}  recent ${e.recentExpectancy?.toFixed(4)}R over ${e.recentTrades}` +
        `  floor ${e.decayThresholdR?.toFixed(4)}R  baseline n=${e.baselineTrades}  ${e.degrading ? 'DEGRADING' : 'intact'}`,
    );
  }
  console.log('');
  console.log('PER-SESSION (state at first entry -> last entry)');
  for (const s of perSession) {
    console.log(
      `  ${s.day}  entries ${String(s.entries).padStart(4)}  ${s.state.padEnd(9)}` +
        `  throttle ${s.firstThrottle} -> ${s.lastThrottle}` +
        (s.cohorts.length > 0 ? `  ${JSON.stringify(s.cohorts)}` : ''),
    );
  }
  console.log('');
  console.log(`DUTY CYCLE  p in [${(pLo * 100).toFixed(2)}%, ${(pHi * 100).toFixed(2)}%]  (entry-weighted)`);
  console.log(`  entries in THROTTLED sessions ${lo} / ${totalEntries}   (+AMBIGUOUS -> ${hi})`);
  console.log(`  eligible entries per session (last 10 active sessions) = ${eligiblePerSession.toFixed(1)}`);
  const etaHi = eta(pLo);
  const etaLo = eta(pHi);
  console.log(
    `  sessions to n(T)=${N_FLOOR}: ` +
      (Number.isFinite(etaHi)
        ? `${etaLo.toFixed(0)} — ${etaHi.toFixed(0)}`
        : Number.isFinite(etaLo)
          ? `${etaLo.toFixed(0)} — NEVER (p_lo = 0)`
          : 'NEVER at either bound (p = 0 on this trigger)'),
  );
  console.log(
    `  session-weighted: ${throttledSessions}/${perSession.length} sessions throttled = ${(pSession * 100).toFixed(2)}%` +
      `  ⇒ ${Number.isFinite(etaSessionWeighted) ? etaSessionWeighted.toFixed(0) : 'NEVER'} sessions at today's volume`,
  );
  console.log(
    '  ⇒ HEADLINE: the grade needs ~' +
      (Number.isFinite(etaHi) ? `${Math.round(etaLo)}–${Math.round(etaSessionWeighted)}` : 'INF') +
      ' more RTH sessions of tape at the current run-rate.',
  );
  console.log('');
  console.log('⚠ LOWER BOUND. Triggers NOT modelled: loss_streak + daily_drawdown (fed only by');
  console.log('  EQUITY closes via riskGovernor.recordTrade — option tape cannot move them) and');
  console.log('  high_vol (a `red` premarket market-review label, no journal representation).');
}

loadRows()
  .then(main)
  .catch((err) => {
    console.error(`BLIND — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(3);
  });
