#!/usr/bin/env node
/**
 * TRA-4688 — detector for the PRE-TURN DEATH: a run that dies in the adapter
 * before the model produces turn 1, leaving the seat dark while every roster
 * surface reads healthy.
 *
 * WHY NO EXISTING SWEEP SEES IT
 * -----------------------------
 * On 2026-09-17 CFO lost 11 run slots this way (5 "You've hit your session
 * limit", 6 "Can't reach the API server (ENOTFOUND)"), the first streak leaving
 * the seat dark ~17:35Z → 21:10Z. `GET /api/agents/me` read `status: running`,
 * `errorReason: null` the whole time, because the platform only writes
 * `errorReason` when the agent itself transitions to `status: error`
 * (@paperclipai/server dist/services/heartbeat.js ~L9760), and a failed run does
 * not do that. The TRA-3300 bricked-agent detector keys on `status: error`, so
 * it is structurally blind to this shape.
 *
 * THE SIGNAL ALREADY EXISTS — ON THE RUN, NOT THE AGENT
 * -----------------------------------------------------
 * `GET /api/companies/{co}/heartbeat-runs?agentId=…&limit=…` serves, per run:
 * `status: failed`, `errorCode`, the raw `error` text, and `usageJson` (with
 * no `inputTokens`/`outputTokens` when no turn ran). What it does NOT serve is
 * a discriminating code: @paperclipai/adapter-utils dist/acpx-engine/execute.js
 * ~L3160 maps EVERY failed turn to `acpx_turn_failed` — session limit, weekly
 * limit, DNS outage, 529 and OAuth expiry all share it. The class therefore
 * comes from the `error` text, here, until the vendor splits the code
 * (board-routed on TRA-4688; no agent can patch node_modules/@paperclipai).
 *
 * PREDICATE
 * ---------
 * A run is a PRE-TURN DEATH iff `status == failed` AND it carries no token
 * usage (`usageJson` null, or both `inputTokens` and `outputTokens` absent/0).
 * A run that did real work and then failed is a different incident and is NOT
 * counted — the ask is specifically "invisible because nothing ran".
 *
 * A seat is DARK iff its newest terminal run is a pre-turn death. `darkSince` is
 * the start of that unbroken streak; `resets` is parsed from the limit text when
 * present. Running/queued runs are not terminal and do not clear a seat — a
 * queued retry into the same limit is exactly the failure mode.
 *
 * TRAPS (each has a control in --selftest)
 * ----------------------------------------
 *  1. ⛔ ZERO SEATS SCANNED IS BLIND, NOT CLEAN (auth failure, renamed route).
 *  2. ⛔ A FAILED SEAT FETCH IS BLIND — a seat we could not read must not
 *     render as a seat with no deaths.
 *  3. ⛔ A FULL PAGE WHOSE OLDEST RUN IS STILL INSIDE THE WINDOW IS BLIND
 *     (truncated): the unread tail may hold the streak's start.
 *  4. ⛔ A failed run WITH token usage is not a pre-turn death (did work).
 *  5. ⛔ An UNRECOGNISED error text is still counted, as `unclassified` —
 *     a new vendor message must not silently leave the population.
 *
 * Usage:
 *   node scripts/check-pre-turn-deaths.mjs [--hours=24] [--agent=<id|name>] [--runs] [--json]
 *   node scripts/check-pre-turn-deaths.mjs --selftest
 * Env: PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID.
 *
 * 0 CLEAN · 1 DARK (a seat is dark NOW) · 2 usage · 3 BLIND ·
 * 4 LOST (pre-turn deaths inside the window, every seat since recovered)
 * Precedence BLIND > DARK > LOST > CLEAN.
 */

export const VERDICT_EXIT = { CLEAN: 0, DARK: 1, USAGE: 2, BLIND: 3, LOST: 4 };
const PAGE = 400;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'timed_out']);
const LIVE = new Set(['queued', 'running', 'scheduled_retry']);

/** Ordered: first match wins. `error` text first, `errorCode` fallback. */
const CLASSES = [
  ['session_limit', (r) => /hit your session limit/i.test(r.error ?? '')],
  ['weekly_limit', (r) => /hit your (weekly|monthly|usage|spend)[^.]*limit/i.test(r.error ?? '')],
  ['provider_unreachable', (r) => /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|Can.t reach the API server/i.test(r.error ?? '')],
  ['provider_overloaded', (r) => /\b529\b|Overloaded/i.test(r.error ?? '')],
  ['auth_expired', (r) => /authenticate|OAuth|auth_required/i.test(`${r.error ?? ''} ${r.errorCode ?? ''}`)],
  ['session_config', (r) => r.errorCode === 'acpx_session_config_failed'],
  ['process_lost', (r) => r.errorCode === 'process_lost'],
];

export function classify(run) {
  for (const [name, test] of CLASSES) if (test(run)) return name;
  return 'unclassified';
}

export function isPreTurnDeath(run) {
  if (run.status !== 'failed') return false;
  const u = run.usageJson;
  if (!u) return true;
  return !(Number(u.inputTokens) > 0 || Number(u.outputTokens) > 0);
}

function parseReset(error) {
  const m = /resets ([^·\n]+?)(?:\s*$|\s*·)/i.exec(error ?? '');
  return m ? m[1].trim() : null;
}

const tOf = (r) => Date.parse(r.startedAt ?? r.createdAt);
const endOf = (r) => r.finishedAt ?? r.updatedAt ?? r.startedAt ?? r.createdAt;

/** Grade one seat. `runs` any order; returns null-safe summary. */
export function gradeSeat(agent, runs, { now, hours, pageFull }) {
  const since = now - hours * 3600e3;
  const sorted = [...runs].sort((a, b) => tOf(b) - tOf(a));
  const unknownStatus = sorted.find((r) => !TERMINAL.has(r.status) && !LIVE.has(r.status));
  const oldest = sorted[sorted.length - 1];
  const truncated = pageFull && oldest && tOf(oldest) >= since;
  const inWindow = sorted.filter((r) => tOf(r) >= since);
  const deaths = inWindow.filter(isPreTurnDeath).map((r) => ({
    id: r.id,
    endedAt: endOf(r),
    cls: classify(r),
    errorCode: r.errorCode ?? null,
    error: (r.error ?? '').slice(0, 140),
  }));

  const terminal = sorted.filter((r) => TERMINAL.has(r.status));
  let dark = null;
  if (terminal.length && isPreTurnDeath(terminal[0])) {
    let i = 0;
    while (i < terminal.length && isPreTurnDeath(terminal[i])) i += 1;
    const streak = terminal.slice(0, i);
    const first = streak[streak.length - 1];
    dark = {
      since: first.startedAt ?? first.createdAt,
      streak: streak.length,
      streakTruncated: i === terminal.length && pageFull,
      cls: classify(terminal[0]),
      resets: parseReset(terminal[0].error),
      lastError: (terminal[0].error ?? '').slice(0, 140),
    };
  }
  const byClass = {};
  for (const d of deaths) byClass[d.cls] = (byClass[d.cls] ?? 0) + 1;
  return {
    agentId: agent.id,
    name: agent.name,
    agentStatus: agent.status,
    agentErrorReason: agent.errorReason ?? null,
    scanned: sorted.length,
    blind: truncated ? `page full (${sorted.length}) and oldest run is inside the ${hours}h window` : unknownStatus ? `unrecognised run status '${unknownStatus.status}'` : null,
    deaths,
    byClass,
    dark,
  };
}

export async function run(transport, { now = Date.now(), hours = 24, agent: pick = null } = {}) {
  const res = { verdict: 'BLIND', hours, seats: [], blind: [] };
  let agents;
  try {
    agents = await transport.getAgents();
  } catch (e) {
    res.blind.push(`agents list: ${e.message}`);
    return res;
  }
  agents = (agents ?? []).filter((a) => a.status !== 'terminated');
  if (pick) agents = agents.filter((a) => a.id === pick || a.id.startsWith(pick) || a.name === pick);
  if (!agents.length) {
    res.blind.push('zero seats scanned');
    return res;
  }
  for (const a of agents) {
    let runs;
    try {
      runs = await transport.getRuns(a.id, PAGE);
    } catch (e) {
      res.blind.push(`${a.name}: runs fetch ${e.message}`);
      continue;
    }
    if (!Array.isArray(runs)) {
      res.blind.push(`${a.name}: runs payload is not an array`);
      continue;
    }
    const foreign = runs.find((r) => r.agentId && r.agentId !== a.id);
    if (foreign) {
      res.blind.push(`${a.name}: agentId filter ignored (got a run for ${foreign.agentId})`);
      continue;
    }
    const g = gradeSeat(a, runs, { now, hours, pageFull: runs.length >= PAGE });
    if (g.blind) res.blind.push(`${a.name}: ${g.blind}`);
    res.seats.push(g);
  }
  if (res.blind.length) res.verdict = 'BLIND';
  else if (res.seats.some((s) => s.dark)) res.verdict = 'DARK';
  else if (res.seats.some((s) => s.deaths.length)) res.verdict = 'LOST';
  else res.verdict = 'CLEAN';
  return res;
}

export function render(res, { runs = false } = {}) {
  const out = [`pre-turn deaths — window ${res.hours}h — verdict ${res.verdict}`];
  for (const b of res.blind) out.push(`  BLIND  ${b}`);
  // Fleet line: the session limit is per ACCOUNT, so it lands on every seat at
  // once (2026-09-17: 6 seats, same minutes) — a per-seat read understates it.
  const fleet = {};
  let total = 0;
  for (const s of res.seats) for (const [k, v] of Object.entries(s.byClass)) { fleet[k] = (fleet[k] ?? 0) + v; total += v; }
  const hit = res.seats.filter((s) => s.deaths.length).length;
  out.push(`  fleet  ${total} slot(s) lost across ${hit} seat(s) [${Object.entries(fleet).map(([k, v]) => `${k}=${v}`).join(' ')}]`);
  for (const s of res.seats) {
    if (!s.deaths.length && !s.dark) continue;
    const cls = Object.entries(s.byClass).map(([k, v]) => `${k}=${v}`).join(' ');
    out.push(`  ${s.dark ? 'DARK ' : 'lost '} ${s.name.padEnd(16)} ${s.deaths.length} slot(s) [${cls}]  roster reads status=${s.agentStatus} errorReason=${s.agentErrorReason ?? 'null'}`);
    if (s.dark) {
      out.push(`         dark since ${s.dark.since} (streak ${s.dark.streak}${s.dark.streakTruncated ? '+' : ''}, ${s.dark.cls}${s.dark.resets ? `, resets ${s.dark.resets}` : ''})`);
    }
    if (!runs && s.deaths.length) {
      out.push(`         first ${s.deaths[s.deaths.length - 1].endedAt}  last ${s.deaths[0].endedAt}  (--runs for each)`);
      continue;
    }
    for (const d of s.deaths) out.push(`         ${d.endedAt}  ${d.id.slice(0, 8)}  ${d.cls.padEnd(20)} ${d.error}`);
  }
  const clean = res.seats.filter((s) => !s.deaths.length && !s.dark).length;
  out.push(`  ${clean}/${res.seats.length} seat(s) with no pre-turn death in window`);
  return out.join('\n');
}

/* ------------------------------- selftest ------------------------------- */

const NOW = Date.parse('2026-09-18T00:00:00Z');
const at = (h) => new Date(NOW - h * 3600e3).toISOString();
const ok = (id, h) => ({ id, status: 'succeeded', startedAt: at(h), finishedAt: at(h), usageJson: { inputTokens: 100, outputTokens: 10 } });
const die = (id, h, error, errorCode = 'acpx_turn_failed', usageJson = { costUsd: 0 }) => ({ id, status: 'failed', startedAt: at(h), finishedAt: at(h), error, errorCode, usageJson });
const SL = "Internal error: You've hit your session limit · resets 5:10pm (America/New_York)";
const DNS = "Internal error: API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)";
const A = { id: 'a1', name: 'CFO', status: 'running', errorReason: null };
const B = { id: 'b1', name: 'CTO', status: 'idle', errorReason: null };

const CASES = [
  {
    name: 'FIXTURE 2026-09-17 — DNS streak is the newest terminal => DARK, 11 slots, 2 classes',
    agents: [A],
    runs: {
      a1: [
        { id: 'q', status: 'queued', startedAt: null, createdAt: at(0.1) },
        ...[1, 1.05, 1.1, 1.15, 1.2, 1.25].map((h, i) => die(`dns${i}`, h, DNS)),
        ok('ok1', 2),
        ...[6, 6.02, 6.04, 5, 3.3].map((h, i) => die(`sl${i}`, h, SL, 'acpx_turn_failed', null)),
        ok('ok0', 10),
      ],
    },
    expect: { verdict: 'DARK', deaths: 11, darkStreak: 6, cls: 'provider_unreachable' },
  },
  {
    name: 'recovered seat => LOST, not CLEAN and not DARK',
    agents: [A],
    runs: { a1: [ok('ok', 1), die('d', 2, SL)] },
    expect: { verdict: 'LOST', deaths: 1 },
  },
  {
    name: 'TRAP 4 — failed WITH token usage is not a pre-turn death => CLEAN',
    agents: [A],
    runs: { a1: [die('d', 1, 'Internal error: something mid-run', 'acpx_turn_failed', { inputTokens: 5000, outputTokens: 300 })] },
    expect: { verdict: 'CLEAN', deaths: 0 },
  },
  {
    name: 'TRAP 5 — unrecognised text still counts, as unclassified',
    agents: [A],
    runs: { a1: [die('d', 1, 'Internal error: brand new vendor message')] },
    expect: { verdict: 'DARK', deaths: 1, cls: 'unclassified' },
  },
  {
    name: 'death outside the window => CLEAN (but seat still DARK if it is the newest terminal)',
    agents: [A, B],
    runs: { a1: [ok('ok', 1), die('d', 30, SL)], b1: [ok('ok', 2)] },
    expect: { verdict: 'CLEAN', deaths: 0 },
  },
  { name: 'TRAP 1 — zero seats => BLIND', agents: [], runs: {}, expect: { verdict: 'BLIND' } },
  { name: 'TRAP 2 — a seat fetch throws => BLIND', agents: [A, B], runs: { b1: [ok('ok', 1)] }, expect: { verdict: 'BLIND' } },
  {
    name: 'TRAP 3 — full page still inside the window => BLIND (truncated)',
    agents: [A],
    runs: { a1: Array.from({ length: PAGE }, (_, i) => ok(`r${i}`, 0.01 * i)) },
    expect: { verdict: 'BLIND' },
  },
  {
    name: 'agentId filter ignored by the server => BLIND, never another seat\'s runs graded',
    agents: [A],
    runs: { a1: [{ ...die('d', 1, SL), agentId: 'zz' }] },
    expect: { verdict: 'BLIND' },
  },
];

async function selftest() {
  let failed = 0;
  for (const c of CASES) {
    const transport = {
      getAgents: async () => c.agents,
      getRuns: async (id) => {
        if (!(id in c.runs)) throw new Error('HTTP 500');
        return c.runs[id];
      },
    };
    const res = await run(transport, { now: NOW, hours: 24 });
    const deaths = res.seats.reduce((n, s) => n + s.deaths.length, 0);
    const darkSeat = res.seats.find((s) => s.dark);
    const e = c.expect;
    const good =
      res.verdict === e.verdict &&
      (e.deaths === undefined || deaths === e.deaths) &&
      (e.darkStreak === undefined || darkSeat?.dark.streak === e.darkStreak) &&
      (e.cls === undefined || darkSeat?.dark.cls === e.cls);
    if (!good) failed += 1;
    console.log(`${good ? 'PASS' : 'FAIL'}  ${c.name}\n      got verdict=${res.verdict} deaths=${deaths} streak=${darkSeat?.dark.streak ?? '-'} cls=${darkSeat?.dark.cls ?? '-'}`);
  }
  // classifier table against the verbatim 2026-09-17 / CFO-history texts
  const table = [
    [SL, 'session_limit'],
    [DNS, 'provider_unreachable'],
    ["Internal error: You've hit your weekly limit · resets Sep 15, 1pm (America/New_York)", 'weekly_limit'],
    ['Internal error: API Error: 529 Overloaded. This is a server-side issue', 'provider_overloaded'],
    ['Internal error: Failed to authenticate: OAuth session expired', 'auth_expired'],
  ];
  for (const [text, want] of table) {
    const got = classify({ error: text, errorCode: 'acpx_turn_failed' });
    const good = got === want;
    if (!good) failed += 1;
    console.log(`${good ? 'PASS' : 'FAIL'}  classify → ${want}${good ? '' : ` (got ${got})`}`);
  }
  const reset = parseReset(SL);
  if (reset !== '5:10pm (America/New_York)') { failed += 1; console.log(`FAIL  parseReset got ${reset}`); }
  else console.log('PASS  parseReset');
  const total = CASES.length + table.length + 1;
  console.log(`\n${total - failed}/${total} controls pass`);
  return failed === 0 ? 0 : 1;
}

/* --------------------------------- main --------------------------------- */

function argOf(name, dflt = null) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest();
  const known = /^--(selftest|json|runs|hours=.+|agent=.+)$/;
  const bad = process.argv.slice(2).find((a) => a !== '--' && !known.test(a)); // pnpm forwards the `--`
  if (bad) {
    console.error(`USAGE: unrecognised argument ${bad}`);
    return VERDICT_EXIT.USAGE;
  }
  const hours = Number(argOf('hours', 24));
  if (!Number.isFinite(hours) || hours <= 0) {
    console.error(`USAGE: --hours must be a positive number, got ${argOf('hours')}`);
    return VERDICT_EXIT.USAGE;
  }
  const BASE = (process.env.PAPERCLIP_API_URL ?? '').replace(/\/$/, '').replace(/\/api$/, '');
  const KEY = process.env.PAPERCLIP_API_KEY;
  const CO = process.env.PAPERCLIP_COMPANY_ID;
  if (!BASE || !KEY || !CO) {
    console.error('FATAL: PAPERCLIP_API_URL, PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID must all be set.');
    console.error('Refusing to report a zero we did not measure.');
    return VERDICT_EXIT.BLIND;
  }
  const auth = { headers: { Authorization: `Bearer ${KEY}` } };
  const get = async (path) => {
    const r = await fetch(`${BASE}${path}`, auth);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  const transport = {
    getAgents: () => get(`/api/companies/${CO}/agents`),
    getRuns: (id, limit) => get(`/api/companies/${CO}/heartbeat-runs?agentId=${id}&limit=${limit}`),
  };
  const result = await run(transport, { hours, agent: argOf('agent') });
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 1));
  else console.log(render(result, { runs: process.argv.includes('--runs') }));
  return VERDICT_EXIT[result.verdict] ?? VERDICT_EXIT.BLIND;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`FATAL: ${err?.stack ?? err}`);
      process.exit(VERDICT_EXIT.BLIND);
    });
}
