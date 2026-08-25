#!/usr/bin/env node
// check-deploy-lag.mjs — TRA-3991
//
// A merged-but-undeployed SAFETY remedy is invisible.
//
// On 2026-08-24 `a5a49717` (the second exit-quantity oracle, written that morning against
// `BAC260925C00063000`) merged to `origin/main` at 13:48Z. bqb1 has autoDeploy OFF, and
// `render-redeploy.mjs` refuses 13:25–20:00Z on the soak host, so the commit could not
// ship inside RTH without `--force-rth-override="reason"`. Nobody asked for the override,
// because nothing said there was anything to decide. At 19:31:08Z the engine sold the row
// the merged oracle would have bound to 0. The deploy landed at 20:14:44Z — 43 min late.
//
// `check-deploy-drift.mjs` (TRA-2229) already measures HOW FAR live is behind main. It is
// not path-aware: five commits behind is five commits behind whether they are CSV export
// columns or the order chokepoint. This script partitions that set by a NAMED safety set
// and turns "there is lag" into "there is a DECISION waiting":
//
//   * CURRENT     live is exactly origin/main.
//   * LAG         live is behind, and nothing behind touches the safety set. Measurement
//                 caveat only (see check-deploy-drift).
//   * SAFETY_LAG  live is behind AND at least one undeployed commit touches the safety set.
//                 An override decision must be MADE — by a person, with a written reason.
//                 THIS SCRIPT DOES NOT AUTHORIZE ONE AND DEPLOYS NOTHING.
//   * BLIND       a leg could not be READ. NEVER a pass (see below).
//
// ── The safety set ───────────────────────────────────────────────────────────
// Whole files are listed where the file IS the oracle. `signal-engine.ts` and
// `options-account.ts` change in ~20–25% of all commits (111 and 72 of 503 on main in the
// 30 days to 2026-08-25), so listing them whole would make SAFETY_LAG fire on nearly every
// deploy — and a signal that fires every day is a signal nobody reads. For those two the
// scope is the METHOD: a hunk counts when it lands inside a named method of the post-image,
// OR when the changed lines mention a named safety symbol anywhere in the file (a caller
// of the bound is as safety-critical as the bound). Attribution is per commit against
// THAT commit's post-image, so it does not drift with line numbers.
//
// ── Fails CLOSED ─────────────────────────────────────────────────────────────
// TRA-3699 / TRA-3721 / TRA-3722 spent three tickets on one shape: a shallow graft makes
// `git merge-base --is-ancestor` exit 1 for a genuine non-ancestor AND for an unreadable
// one, and the caller read both as "no". Here every unreadable leg is BLIND (exit 3):
// the health route unreachable, no SHA in the payload, a SHA this checkout cannot resolve,
// a failed fetch, a shallow repository (ancestry beyond the graft is UNKNOWABLE, not
// empty), or a file that cannot be attributed. "I could not check" is not "nothing is
// waiting".
//
// Usage:
//   node scripts/check-deploy-lag.mjs                    # live: curl bqb1, fetch, partition
//   node scripts/check-deploy-lag.mjs --live=<sha>       # grade a SHA you already have
//   node scripts/check-deploy-lag.mjs --host=https://…   # another deployment
//   node scripts/check-deploy-lag.mjs --no-fetch         # skip `git fetch` (your risk)
//   node scripts/check-deploy-lag.mjs --json             # machine-readable, one object
//   node scripts/check-deploy-lag.mjs --tape [--days=30] # replay Render's deploy history:
//                                                        # for every deploy, which safety
//                                                        # commits it shipped and how long
//                                                        # each sat merged-but-undeployed,
//                                                        # including RTH minutes. Needs
//                                                        # RENDER_API_KEY.
//   node scripts/check-deploy-lag.mjs --selftest         # controls in a synthetic repo
//
// Exit codes:
//   0  CURRENT
//   1  LAG        (also DIVERGED with no safety commit behind — see output)
//   2  SAFETY_LAG — decide, in writing. Do not default.
//   3  BLIND
//   4  a control failed (--selftest only)

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_HOST = 'https://tradingai-bqb1.onrender.com';
export const SOAK_SERVICE_ID = 'srv-d7mb7rr7uimc73ev0chg';

// ── The safety set ────────────────────────────────────────────────────────────
// `scope: 'file'`   — any change to the file counts.
// `scope: 'method'` — a change counts when a hunk lands inside one of `methods` in the
//                     post-image, or when a changed line matches `symbols`.
export const SAFETY_SET = [
  {
    path: 'packages/server/src/option-exec-flag.ts',
    scope: 'file',
    why: 'live arm predicates + exit-quantity oracles (TRA-3926 a5a49717, ba0ee08a)',
  },
  {
    path: 'packages/server/src/live-options-fee-slippage-ledger.ts',
    scope: 'file',
    why: 'engineNetOpenContracts — the write-path oracle the exit bound reads',
  },
  {
    path: 'packages/engine/src/tradier/options-client.ts',
    scope: 'file',
    why: 'the Tradier options order submitter — the order chokepoint',
  },
  {
    path: 'packages/server/src/options-account.ts',
    scope: 'method',
    methods: ['stageableExitContracts', 'getExitQuantityBoundCensus'],
    why: 'PaperOptionsAccount.stageableExitContracts IS the exit quantity bound',
  },
  {
    path: 'packages/server/src/signal-engine.ts',
    scope: 'method',
    methods: ['getExitQuantityBoundCensus'],
    why: 'the engine-side exit bound census + the order path callers',
  },
];

// A changed line in a method-scoped file that names one of these is safety, whatever
// method it sits in — callers of the bound are part of the bound.
export const SAFETY_SYMBOLS =
  /\b(stageableExitContracts|engineNetOpenContracts|getExitQuantityBoundCensus|[a-zA-Z]+To(Open|Close)Contracts[A-Za-z]*|sell_to_close|buy_to_open|sell_to_open|buy_to_close)\b/;

// RTH proper, Mon–Fri. Matches render-redeploy.mjs / tra1648_soak_check.mjs.
const RTH_OPEN_MIN = 13 * 60 + 30;
const RTH_CLOSE_MIN = 20 * 60;

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = flag => argv.includes(flag);
const valOf = name => {
  const hit = argv.find(a => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
};

// ── git, with every failure surfaced ─────────────────────────────────────────
export function git(args, cwd = process.cwd()) {
  const r = spawnSync('git', args, { encoding: 'utf8', cwd, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').replace(/\r\n/g, '\n').trim(), err: (r.stderr ?? '').trim() };
}

class Blind extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'Blind';
  }
}

// ── Method attribution in a post-image ────────────────────────────────────────
// A class member header: two-space indent, optional modifiers, an identifier, an
// argument list. Rejects statements (`foo(bar);`) and control flow.
const METHOD_HEADER =
  /^ {2}(?:(?:private|public|protected|static|readonly|async|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
const NOT_A_METHOD = /^(if|for|while|switch|return|const|let|var|await|throw|new|else|catch|do|try)$/;

export function methodTable(source) {
  const table = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = METHOD_HEADER.exec(line);
    if (!m) continue;
    if (NOT_A_METHOD.test(m[1])) continue;
    if (/;\s*$/.test(line)) continue; // a call statement, not a header
    table.push({ line: i + 1, name: m[1] });
  }
  return table;
}

export function methodAt(table, line) {
  let hit = null;
  for (const row of table) {
    if (row.line <= line) hit = row.name;
    else break;
  }
  return hit;
}

// Parse `git show -U0` output for ONE path into hunks: new-side start line, new-side
// count, and the changed (+/-) text.
export function parseHunks(diffText) {
  const hunks = [];
  let cur = null;
  for (const raw of diffText.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (h) {
      cur = { newStart: Number(h[1]), newCount: h[2] === undefined ? 1 : Number(h[2]), changed: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    if ((raw.startsWith('+') && !raw.startsWith('+++')) || (raw.startsWith('-') && !raw.startsWith('---'))) {
      cur.changed.push(raw.slice(1));
    }
  }
  return hunks;
}

// Classify ONE commit against the safety set. Returns { sha, files, hits: [{path, why, how}] }.
// Throws Blind when anything it needs cannot be read — a commit that cannot be classified
// is not "not safety".
export function classifyCommit(sha, { cwd = process.cwd(), safetySet = SAFETY_SET, symbols = SAFETY_SYMBOLS } = {}) {
  const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha], cwd);
  if (!files.ok) throw new Blind(`git diff-tree ${sha.slice(0, 8)} failed: ${files.err || 'unknown'}`);
  const changed = files.out ? files.out.split('\n') : [];
  const hits = [];
  for (const entry of safetySet) {
    if (!changed.includes(entry.path)) continue;
    if (entry.scope === 'file') {
      hits.push({ path: entry.path, why: entry.why, how: 'file' });
      continue;
    }
    // method scope
    const diff = git(['show', '--format=', '-U0', sha, '--', entry.path], cwd);
    if (!diff.ok) throw new Blind(`git show ${sha.slice(0, 8)} -- ${entry.path} failed: ${diff.err || 'unknown'}`);
    const hunks = parseHunks(diff.out);
    const symbolHit = hunks.some(h => h.changed.some(l => symbols.test(l)));
    if (symbolHit) {
      hits.push({ path: entry.path, why: entry.why, how: 'symbol' });
      continue;
    }
    const post = git(['show', `${sha}:${entry.path}`], cwd);
    if (!post.ok) {
      // Deleted or unreadable post-image. A deleted oracle is the most safety-relevant
      // change there is; an unreadable one cannot be attributed. Both count.
      hits.push({ path: entry.path, why: entry.why, how: post.err.includes('does not exist') ? 'deleted' : 'unattributable' });
      continue;
    }
    const table = methodTable(post.out);
    const methodHit = hunks
      .map(h => methodAt(table, h.newStart))
      .find(name => name && entry.methods.includes(name));
    if (methodHit) hits.push({ path: entry.path, why: entry.why, how: `method:${methodHit}` });
  }
  return { sha, files: changed, hits };
}

// ── The lag partition ─────────────────────────────────────────────────────────
// Given a live SHA and a base ref, name every commit merged-but-not-running and partition
// it. Throws Blind rather than guess.
export function lagState({ liveSha, baseRef = 'origin/main', cwd = process.cwd(), classify = classifyCommit }) {
  const shallow = git(['rev-parse', '--is-shallow-repository'], cwd);
  if (!shallow.ok) throw new Blind(`git rev-parse --is-shallow-repository failed: ${shallow.err || 'unknown'}`);
  if (shallow.out === 'true') {
    throw new Blind(
      'this checkout is SHALLOW. Ancestry beyond the graft is unknowable, and a graft makes ' +
        'a genuine non-ancestor and an unreadable one exit identically (TRA-3699/3721/3722). ' +
        'Run `git fetch --unshallow` and re-run.',
    );
  }
  const baseRev = git(['rev-parse', `${baseRef}^{commit}`], cwd);
  if (!baseRev.ok) throw new Blind(`cannot resolve '${baseRef}': ${baseRev.err || 'unknown rev'}`);
  const base = baseRev.out;

  if (typeof liveSha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(liveSha)) {
    throw new Blind(`live commit is not a usable SHA (${JSON.stringify(liveSha)})`);
  }
  const liveRev = git(['rev-parse', `${liveSha}^{commit}`], cwd);
  if (!liveRev.ok) {
    throw new Blind(
      `the LIVE commit ${liveSha} is unknown to this checkout (${liveRev.err || 'unknown rev'}). ` +
        'It may predate a fetch, or live may be running a build that was never pushed here. ' +
        'The distance is UNKNOWN, not zero.',
    );
  }
  const live = liveRev.out;

  const behindList = git(['rev-list', '--reverse', `${live}..${base}`], cwd);
  const aheadList = git(['rev-list', `${base}..${live}`], cwd);
  if (!behindList.ok || !aheadList.ok) throw new Blind('git rev-list could not enumerate the distance');
  const behindShas = behindList.out ? behindList.out.split('\n') : [];
  const aheadShas = aheadList.out ? aheadList.out.split('\n') : [];

  const behind = behindShas.map(sha => {
    const meta = git(['log', '-1', '--format=%h%x00%cI%x00%s', sha], cwd);
    if (!meta.ok) throw new Blind(`git log ${sha.slice(0, 8)} failed`);
    const [short, committedAt, subject] = meta.out.split('\0');
    const cls = classify(sha, { cwd });
    return { sha, short, committedAt, subject, safety: cls.hits.length > 0, hits: cls.hits, files: cls.files };
  });

  const safetyBehind = behind.filter(c => c.safety);
  const diverged = aheadShas.length > 0;
  const verdict = behind.length === 0 && !diverged ? 'CURRENT' : safetyBehind.length > 0 ? 'SAFETY_LAG' : diverged ? 'DIVERGED' : 'LAG';
  const exitCode = verdict === 'CURRENT' ? 0 : verdict === 'SAFETY_LAG' ? 2 : 1;
  return { verdict, exitCode, live, base, baseRef, behind, ahead: aheadShas, safetyBehind, diverged };
}

// ── RTH overlap, in minutes, of [from, to) with Mon–Fri 13:30–20:00Z ─────────
export function rthOverlapMin(fromMs, toMs) {
  if (!(toMs > fromMs)) return 0;
  let total = 0;
  // Walk day by day in UTC.
  const start = new Date(fromMs);
  const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  for (let d = day.getTime(); d < toMs; d += 86_400_000) {
    const dow = new Date(d).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const open = d + RTH_OPEN_MIN * 60_000;
    const close = d + RTH_CLOSE_MIN * 60_000;
    const lo = Math.max(open, fromMs);
    const hi = Math.min(close, toMs);
    if (hi > lo) total += (hi - lo) / 60_000;
  }
  return Math.round(total);
}

// ── Live leg ─────────────────────────────────────────────────────────────────
export async function readLiveCommit(host, timeoutMs = 25_000) {
  const url = `${host.replace(/\/+$/, '')}/api/health/version`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Blind(`GET ${url} failed: ${err?.message ?? err}`);
  }
  if (!res.ok) throw new Blind(`GET ${url} returned HTTP ${res.status}`);
  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new Blind(`GET ${url} did not return JSON: ${err?.message ?? err}`);
  }
  const commit = body?.commit;
  if (typeof commit !== 'string' || !/^[0-9a-f]{7,40}$/i.test(commit)) {
    throw new Blind(
      `${url} carried no usable commit (commit=${JSON.stringify(commit)}, commitSource=${JSON.stringify(body?.commitSource)})`,
    );
  }
  return { commit, startedAt: body?.startedAt ?? null, pid: body?.pid ?? null, source: url };
}

function fmtCommit(c) {
  const mark = c.safety ? '⛔' : '  ';
  const how = c.safety ? `  [${c.hits.map(h => `${h.path.split('/').pop()}:${h.how}`).join(', ')}]` : '';
  return `${mark} ${c.short}  ${c.committedAt}  ${c.subject.slice(0, 96)}${how}`;
}

async function runLive() {
  const host = (valOf('--host') ?? process.env.DRIFT_HOST ?? DEFAULT_HOST).replace(/\/+$/, '');
  const baseRef = valOf('--base') ?? 'origin/main';
  const json = has('--json');
  const now = new Date();
  try {
    const live = valOf('--live') ? { commit: valOf('--live'), startedAt: null, pid: null, source: '--live argument' } : await readLiveCommit(host);
    if (!has('--no-fetch')) {
      const f = git(['fetch', 'origin', '--quiet']);
      if (!f.ok) throw new Blind(`git fetch origin failed: ${f.err || 'unknown'} — ${baseRef} may be stale`);
    }
    const state = lagState({ liveSha: live.commit, baseRef });
    const nowMs = now.getTime();
    for (const c of state.behind) {
      const t = Date.parse(c.committedAt);
      c.lagMin = Number.isFinite(t) ? Math.round((nowMs - t) / 60_000) : null;
      c.rthMin = Number.isFinite(t) ? rthOverlapMin(t, nowMs) : null;
    }
    const inRth = rthOverlapMin(nowMs - 1, nowMs) > 0;
    const out = {
      script: 'check-deploy-lag',
      ticket: 'TRA-3991',
      at: now.toISOString(),
      host,
      live: { commit: state.live, startedAt: live.startedAt, pid: live.pid, source: live.source },
      base: { ref: baseRef, commit: state.base, fetched: !has('--no-fetch') },
      verdict: state.verdict,
      inRthNow: inRth,
      behind: state.behind.length,
      ahead: state.ahead.length,
      safetyBehind: state.safetyBehind.map(c => ({ sha: c.sha, short: c.short, committedAt: c.committedAt, lagMin: c.lagMin, rthMin: c.rthMin, subject: c.subject, hits: c.hits })),
      commits: state.behind.map(c => ({ sha: c.sha, short: c.short, committedAt: c.committedAt, lagMin: c.lagMin, rthMin: c.rthMin, safety: c.safety, subject: c.subject })),
      decision:
        state.verdict === 'SAFETY_LAG'
          ? 'An override decision is DUE: a safety-path commit is merged and not running. Decide it in writing (render-redeploy.mjs --force-rth-override="reason") or decide to wait — do not default. This script authorizes nothing and deploys nothing.'
          : null,
    };
    if (json) {
      console.log(JSON.stringify(out, null, 2));
      process.exit(state.exitCode);
    }
    console.log(`[deploy-lag] host   : ${host}`);
    console.log(`[deploy-lag] live   : ${state.live.slice(0, 8)}  started ${live.startedAt ?? '?'}  pid ${live.pid ?? '?'}  (${live.source})`);
    console.log(`[deploy-lag] ${baseRef.padEnd(6)} : ${state.base.slice(0, 8)}  ${has('--no-fetch') ? 'NOT re-derived (--no-fetch)' : 're-derived via fetch'}`);
    console.log(`[deploy-lag] now    : ${now.toISOString()}  ${inRth ? 'INSIDE RTH — the freeze is holding whatever is below' : 'outside RTH — the freeze is not holding anything'}`);
    console.log('');
    console.log(`[deploy-lag] LAG = ${state.behind.length} behind${state.ahead.length ? `, ${state.ahead.length} ahead` : ''}; SAFETY = ${state.safetyBehind.length}  → ${state.verdict}`);
    console.log('');
    if (state.behind.length) {
      console.log('[deploy-lag] merged but NOT running (oldest first; ⛔ = touches the safety set):');
      for (const c of state.behind) console.log(`[deploy-lag]   ${fmtCommit(c)}  lag ${c.lagMin ?? '?'} min, ${c.rthMin ?? '?'} in RTH`);
      console.log('');
    }
    if (state.diverged) {
      console.log(`[deploy-lag] DIVERGED — live carries ${state.ahead.length} commit(s) not on ${baseRef}. Land them before grading anything.`);
    }
    if (state.verdict === 'SAFETY_LAG') {
      console.log('[deploy-lag] ⛔ SAFETY_LAG — a safety-path remedy is merged and NOT running.');
      for (const c of state.safetyBehind) for (const h of c.hits) console.log(`[deploy-lag]      ${c.short} ${h.path} — ${h.why}`);
      console.log('[deploy-lag] This is a DECISION, not a default. Either');
      console.log('[deploy-lag]   RENDER_API_KEY=… node scripts/render-redeploy.mjs --commit=<sha> --force-rth-override="<why it cannot wait>"');
      console.log('[deploy-lag] or write down why it CAN wait on the ticket that owns the remedy. This script authorizes');
      console.log('[deploy-lag] nothing and deploys nothing. (Outside RTH the freeze is open: just deploy.)');
    } else if (state.verdict === 'LAG') {
      console.log('[deploy-lag] LAG without a safety-path commit: a measurement caveat (see check-deploy-drift), not a decision.');
    } else if (state.verdict === 'CURRENT') {
      console.log('[deploy-lag] CURRENT — nothing is waiting.');
    }
    process.exit(state.exitCode);
  } catch (err) {
    if (err instanceof Blind) {
      if (json) {
        console.log(JSON.stringify({ script: 'check-deploy-lag', ticket: 'TRA-3991', at: now.toISOString(), host, verdict: 'BLIND', why: err.message }, null, 2));
      } else {
        console.error(`[deploy-lag] BLIND: ${err.message}`);
        console.error('[deploy-lag] A leg could not be READ. This is never a pass — "I could not check" is not "nothing is waiting".');
      }
      process.exit(3);
    }
    throw err;
  }
}

// ── Tape mode: replay Render's deploy history ─────────────────────────────────
// For every SUCCESSFUL deploy (status live|deactivated) in the window, the commits it
// shipped are `prevDeploy.commit..thisDeploy.commit`; each commit's lag is
// `deploy.finishedAt - committedAt`, and its RTH minutes are the overlap of that interval
// with Mon–Fri 13:30–20:00Z. The question this answers before proposing a wake: how often
// does SAFETY_LAG actually happen, and for how long?
async function fetchDeployTape({ serviceId, sinceMs, apiKey, maxPages = 10 }) {
  const rows = [];
  let cursor;
  for (let page = 0; page < maxPages; page += 1) {
    const q = new URLSearchParams({ limit: '100' });
    if (cursor) q.set('cursor', cursor);
    const url = `https://api.render.com/v1/services/${serviceId}/deploys?${q}`;
    let r;
    try {
      r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } });
    } catch (e) {
      throw new Blind(`GET ${url} threw: ${e?.message ?? e}`);
    }
    if (!r.ok) throw new Blind(`GET ${url} → ${r.status} ${r.statusText}`);
    const json = await r.json();
    if (!Array.isArray(json)) throw new Blind(`GET ${url} returned ${typeof json}, expected an array`);
    let oldest = Infinity;
    for (const entry of json) {
      const d = entry?.deploy ?? entry;
      rows.push(d);
      const t = Date.parse(d?.createdAt ?? '');
      if (Number.isFinite(t)) oldest = Math.min(oldest, t);
      cursor = entry?.cursor ?? cursor;
    }
    if (json.length < 100 || oldest < sinceMs || !cursor) return rows;
  }
  return rows;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[idx];
}

async function runTape() {
  const days = Number(valOf('--days') ?? 30);
  const serviceId = valOf('--service') ?? process.env.RENDER_SERVICE_ID ?? SOAK_SERVICE_ID;
  const apiKey = process.env.RENDER_API_KEY;
  const json = has('--json');
  const now = Date.now();
  const sinceMs = now - days * 86_400_000;
  try {
    if (!apiKey) throw new Blind('RENDER_API_KEY is required for --tape');
    if (!has('--no-fetch')) {
      const f = git(['fetch', 'origin', '--quiet']);
      if (!f.ok) throw new Blind(`git fetch origin failed: ${f.err || 'unknown'}`);
    }
    const shallow = git(['rev-parse', '--is-shallow-repository']);
    if (!shallow.ok || shallow.out === 'true') throw new Blind('shallow or unreadable checkout — ancestry is unknowable');

    const all = await fetchDeployTape({ serviceId, sinceMs, apiKey });
    const ok = all
      .filter(d => d?.status === 'live' || d?.status === 'deactivated')
      .filter(d => Number.isFinite(Date.parse(d.finishedAt ?? '')))
      .sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt));
    const failed = all.filter(d => !(d?.status === 'live' || d?.status === 'deactivated')).length;

    const intervals = [];
    let blindIntervals = 0;
    for (let i = 1; i < ok.length; i += 1) {
      const prev = ok[i - 1];
      const cur = ok[i];
      const finishedMs = Date.parse(cur.finishedAt);
      if (finishedMs < sinceMs) continue;
      const prevSha = prev?.commit?.id;
      const curSha = cur?.commit?.id;
      if (!prevSha || !curSha) {
        blindIntervals += 1;
        intervals.push({ deploy: cur.id, finishedAt: cur.finishedAt, blind: 'deploy record carries no commit id' });
        continue;
      }
      if (prevSha === curSha) {
        intervals.push({ deploy: cur.id, finishedAt: cur.finishedAt, commit: curSha.slice(0, 8), commits: [], restart: true });
        continue;
      }
      let state;
      try {
        state = lagState({ liveSha: prevSha, baseRef: curSha });
      } catch (e) {
        if (!(e instanceof Blind)) throw e;
        blindIntervals += 1;
        intervals.push({ deploy: cur.id, finishedAt: cur.finishedAt, commit: curSha.slice(0, 8), blind: e.message });
        continue;
      }
      const commits = state.behind.map(c => {
        const t = Date.parse(c.committedAt);
        return {
          short: c.short,
          committedAt: c.committedAt,
          subject: c.subject,
          safety: c.safety,
          hits: c.hits,
          lagMin: Math.round((finishedMs - t) / 60_000),
          rthMin: rthOverlapMin(t, finishedMs),
        };
      });
      intervals.push({ deploy: cur.id, finishedAt: cur.finishedAt, commit: curSha.slice(0, 8), prev: prevSha.slice(0, 8), commits, diverged: state.diverged });
    }

    const shipped = intervals.flatMap(iv => iv.commits ?? []);
    const safety = shipped.filter(c => c.safety);
    const lagSorted = safety.map(c => c.lagMin).sort((a, b) => a - b);
    const rthSorted = safety.map(c => c.rthMin).sort((a, b) => a - b);
    const deploysWithSafety = intervals.filter(iv => (iv.commits ?? []).some(c => c.safety));
    const safetyInRth = safety.filter(c => c.rthMin > 0);
    const safetyInRth60 = safety.filter(c => c.rthMin >= 60);
    // Distinct RTH days on which at least one safety commit sat undeployed for ≥1 RTH minute.
    const rthDays = new Set();
    for (const c of safetyInRth) {
      const from = Date.parse(c.committedAt);
      const to = from + c.lagMin * 60_000;
      for (let d = from; d < to; d += 86_400_000) {
        const day = new Date(d);
        const dayStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
        if (rthOverlapMin(Math.max(from, dayStart), Math.min(to, dayStart + 86_400_000)) > 0) rthDays.add(new Date(dayStart).toISOString().slice(0, 10));
      }
    }
    const weekdaysInWindow = (() => {
      let n = 0;
      for (let d = sinceMs; d < now; d += 86_400_000) {
        const dow = new Date(d).getUTCDay();
        if (dow >= 1 && dow <= 5) n += 1;
      }
      return n;
    })();

    const summary = {
      script: 'check-deploy-lag --tape',
      ticket: 'TRA-3991',
      at: new Date(now).toISOString(),
      serviceId,
      windowDays: days,
      since: new Date(sinceMs).toISOString(),
      deploysRead: all.length,
      deploysSucceeded: ok.length,
      deploysFailed: failed,
      intervalsGraded: intervals.length,
      intervalsBlind: blindIntervals,
      commitsShipped: shipped.length,
      safetyCommits: safety.length,
      deploysCarryingSafety: deploysWithSafety.length,
      safetyLagMin: { median: quantile(lagSorted, 0.5), p90: quantile(lagSorted, 0.9), max: quantile(lagSorted, 1) },
      safetyRthMin: { median: quantile(rthSorted, 0.5), p90: quantile(rthSorted, 0.9), max: quantile(rthSorted, 1) },
      safetyWithAnyRth: safetyInRth.length,
      safetyWithRthGe60: safetyInRth60.length,
      rthDaysWithSafetyLag: [...rthDays].sort(),
      weekdaysInWindow,
      worst: safety
        .slice()
        .sort((a, b) => b.rthMin - a.rthMin || b.lagMin - a.lagMin)
        .slice(0, 12)
        .map(c => ({ short: c.short, committedAt: c.committedAt, lagMin: c.lagMin, rthMin: c.rthMin, subject: c.subject.slice(0, 100), hits: c.hits.map(h => `${h.path.split('/').pop()}:${h.how}`) })),
      intervals,
    };
    if (json) {
      console.log(JSON.stringify(summary, null, 2));
      process.exit(blindIntervals ? 3 : 0);
    }
    console.log(`[deploy-lag --tape] service ${serviceId}, last ${days} d (since ${summary.since})`);
    console.log(`[deploy-lag --tape] deploys read ${all.length}: ${ok.length} succeeded, ${failed} failed/other; intervals graded ${intervals.length}, BLIND ${blindIntervals}`);
    console.log(`[deploy-lag --tape] commits shipped ${shipped.length}; SAFETY commits ${safety.length} across ${deploysWithSafety.length} deploys`);
    console.log(`[deploy-lag --tape] safety lag (merge→live) min: median ${summary.safetyLagMin.median} p90 ${summary.safetyLagMin.p90} max ${summary.safetyLagMin.max}`);
    console.log(`[deploy-lag --tape] safety RTH minutes undeployed:  median ${summary.safetyRthMin.median} p90 ${summary.safetyRthMin.p90} max ${summary.safetyRthMin.max}`);
    console.log(`[deploy-lag --tape] safety commits with ANY RTH exposure: ${safetyInRth.length}; with ≥60 RTH min: ${safetyInRth60.length}`);
    console.log(`[deploy-lag --tape] RTH days on which a safety remedy sat undeployed: ${rthDays.size} of ${weekdaysInWindow} weekdays → ${[...rthDays].sort().join(', ') || '(none)'}`);
    console.log('');
    console.log('[deploy-lag --tape] worst by RTH minutes:');
    for (const w of summary.worst) console.log(`[deploy-lag --tape]   ${w.short}  merged ${w.committedAt}  lag ${w.lagMin} min, ${w.rthMin} in RTH  ${w.subject.slice(0, 70)}  [${w.hits.join(', ')}]`);
    if (blindIntervals) {
      console.log('');
      console.log(`[deploy-lag --tape] ⚠ ${blindIntervals} interval(s) BLIND — the counts above are a LOWER BOUND, not a total.`);
      for (const iv of intervals.filter(i => i.blind)) console.log(`[deploy-lag --tape]   ${iv.finishedAt} ${iv.commit ?? '?'}: ${iv.blind}`);
    }
    process.exit(blindIntervals ? 3 : 0);
  } catch (err) {
    if (err instanceof Blind) {
      console.error(`[deploy-lag --tape] BLIND: ${err.message}`);
      process.exit(3);
    }
    throw err;
  }
}

// ── Controls ──────────────────────────────────────────────────────────────────
function selftest() {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), 'tra3991-'));
  const repo = join(root, 'full');
  mkdirSync(repo, { recursive: true });
  const g = args => {
    const r = git(args, repo);
    if (!r.ok) throw new Error(`git ${args.join(' ')} failed in control repo: ${r.err}`);
    return r.out;
  };
  const write = (rel, text) => {
    const p = join(repo, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
  };
  const commit = msg => {
    g(['add', '-A']);
    g(['-c', 'user.name=tra3991', '-c', 'user.email=tra3991@local', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg]);
    return g(['rev-parse', 'HEAD']);
  };
  const ACCOUNT = (bound, other) =>
    `export class PaperOptionsAccount {\n` +
    `  constructor() {\n    this.x = 1;\n  }\n\n` +
    `  private stageableExitContracts(opt, requested) {\n    ${bound}\n    return requested;\n  }\n\n` +
    `  unrelatedReport() {\n    ${other}\n    return 1;\n  }\n}\n`;

  g(['init', '-q', '-b', 'main']);
  write('README.md', 'control\n');
  write('packages/server/src/options-account.ts', ACCOUNT('const a = 1;', 'const b = 1;'));
  const c0 = commit('c0 base');
  write('packages/server/src/option-exec-flag.ts', 'export const oracle = 1;\n');
  const c1 = commit('c1 touches option-exec-flag.ts (whole-file safety)');
  write('docs/x.md', 'docs\n');
  const c2 = commit('c2 docs only');
  write('packages/server/src/options-account.ts', ACCOUNT('const a = 1;', 'const b = 2; // report tweak'));
  const c3 = commit('c3 options-account.ts, unrelated method');
  write('packages/server/src/options-account.ts', ACCOUNT('const a = 2; // bound change', 'const b = 2; // report tweak'));
  const c4 = commit('c4 options-account.ts, INSIDE stageableExitContracts');
  write('packages/server/src/options-account.ts', ACCOUNT('const a = 2; // bound change', 'const b = this.stageableExitContracts(o, 1); // caller'));
  const c5 = commit('c5 options-account.ts, unrelated method but names the bound symbol');
  // A side branch off c2 for DIVERGED.
  g(['checkout', '-q', '-b', 'side', c2]);
  write('docs/y.md', 'side\n');
  const cSide = commit('side commit');
  g(['checkout', '-q', 'main']);

  const results = [];
  const check = (name, expect, fn) => {
    let got;
    try {
      got = fn();
    } catch (e) {
      got = e instanceof Blind ? `BLIND(${e.message.slice(0, 60)}…)` : `THREW ${e.message}`;
    }
    const pass = typeof expect === 'function' ? expect(got) : got === expect;
    results.push({ name, pass, expect: typeof expect === 'function' ? '(predicate)' : expect, got: typeof got === 'string' ? got : JSON.stringify(got) });
  };
  const verdictOf = (live, base) => lagState({ liveSha: live, baseRef: base, cwd: repo }).verdict;

  check('CURRENT: live == base', 'CURRENT', () => verdictOf(c5, c5));
  check('LAG: only a docs commit behind', 'LAG', () => verdictOf(c1, c2));
  check('SAFETY_LAG: whole-file safety path behind', 'SAFETY_LAG', () => verdictOf(c0, c1));
  check('method scope: unrelated method in options-account.ts is NOT safety', 'LAG', () => verdictOf(c2, c3));
  check('method scope: hunk inside stageableExitContracts IS safety', 'SAFETY_LAG', () => verdictOf(c3, c4));
  check('symbol scope: caller naming the bound IS safety (conservative)', 'SAFETY_LAG', () => verdictOf(c4, c5));
  check('attribution names the method', 'method:stageableExitContracts', () => lagState({ liveSha: c3, baseRef: c4, cwd: repo }).safetyBehind[0].hits[0].how);
  check('attribution names the symbol', 'symbol', () => lagState({ liveSha: c4, baseRef: c5, cwd: repo }).safetyBehind[0].hits[0].how);
  check('DIVERGED: live on a side branch, nothing safety behind', 'DIVERGED', () => verdictOf(cSide, c3));
  check('DIVERGED with a safety commit behind is still SAFETY_LAG', 'SAFETY_LAG', () => verdictOf(cSide, c4));
  check('BLIND: unknown live sha', s => s.startsWith('BLIND('), () => verdictOf('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', c5));
  check('BLIND: malformed live sha', s => s.startsWith('BLIND('), () => verdictOf('(service branch tip)', c5));
  check('BLIND: unknown base ref', s => s.startsWith('BLIND('), () => verdictOf(c0, 'origin/nope'));
  check('BLIND: a classifier that cannot read is never "not safety"', s => s.startsWith('BLIND('), () =>
    lagState({ liveSha: c0, baseRef: c2, cwd: repo, classify: () => { throw new Blind('diff unreadable'); } }).verdict,
  );

  // Shallow graft: a depth-1 clone resolves BOTH shas it holds, and the naive ancestry read
  // would return a number. It must be BLIND.
  const shallow = join(root, 'shallow');
  const cl = git(['clone', '-q', '--depth', '2', '--no-local', pathToFileURL(repo).href, shallow]);
  if (!cl.ok) throw new Error(`shallow clone failed: ${cl.err}`);
  check('BLIND: shallow checkout (graft) even when both shas resolve', s => s.startsWith('BLIND(') && s.includes('SHALLOW'), () =>
    lagState({ liveSha: c4, baseRef: 'HEAD', cwd: shallow }).verdict,
  );
  // And the naive read the ticket warns about, for contrast: it produces a NUMBER here.
  const naive = git(['rev-list', '--count', `${c4}..HEAD`], shallow);
  check('control of the control: the naive count in the shallow clone is a number, not a refusal', true, () => naive.ok && /^\d+$/.test(naive.out));

  // rthOverlapMin
  check('rth: Mon 2026-08-24 13:48Z→20:14Z = 372 min', 372, () => rthOverlapMin(Date.parse('2026-08-24T13:48:00Z'), Date.parse('2026-08-24T20:14:44Z')));
  check('rth: Sat→Sun = 0', 0, () => rthOverlapMin(Date.parse('2026-08-22T00:00:00Z'), Date.parse('2026-08-23T23:59:00Z')));
  check('rth: Fri 19:00Z→Mon 14:00Z = 60 + 30', 90, () => rthOverlapMin(Date.parse('2026-08-21T19:00:00Z'), Date.parse('2026-08-24T14:00:00Z')));
  check('rth: empty interval = 0', 0, () => rthOverlapMin(5, 5));

  // methodTable rejects statements and control flow.
  check('methodTable: statements and control flow are not headers', 'stageableExitContracts,unrelatedReport', () =>
    methodTable(ACCOUNT('if (x) {\n  }\n  healPersistedThresholds(opt);', 'while (y) {}')).map(r => r.name).filter(n => n !== 'constructor').join(','),
  );

  rmSync(root, { recursive: true, force: true });

  const failed = results.filter(r => !r.pass);
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `  (expected ${r.expect}, got ${r.got})`}`);
  console.log(`\n[deploy-lag --selftest] ${results.length - failed.length}/${results.length} controls pass`);
  process.exit(failed.length ? 4 : 0);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  if (has('--selftest')) selftest();
  else if (has('--tape')) runTape().catch(e => { console.error(e?.stack ?? String(e)); process.exit(3); });
  else runLive().catch(e => { console.error(e?.stack ?? String(e)); process.exit(3); });
}
