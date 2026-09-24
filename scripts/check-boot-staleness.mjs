#!/usr/bin/env node
// check-boot-staleness.mjs — TRA-4851 (off the TRA-4849 incident)
//
// The PM2 boot-resurrect re-serves whatever HEAD the shared checkout
// (`_default/tradingai_repo`) happens to hold. On 2026-09-24T01:34Z that was
// a44ca2a4 — 42 days / ~600 commits stale — and the resurrected instance read
// exactly like quiet health (sandbox-default barR, empty journal) on at least
// 3 consecutive boots. Nothing on the boot path asked "how old is the thing I
// am about to bind to :4242?".
//
// This script IS that question. ops/pm2-resurrect-boot.ps1 runs it after the
// health gate; the doctrine is loud-over-silent — a confirmed-stale checkout
// turns the failure mode into no-listener/loud (the wrapper stops the process
// and fails the task) instead of stale-listener/silent.
//
// The verdict discriminates "old" from "stale". An old HEAD that origin has
// nothing newer than is a QUIET repo, not a stale checkout — refusing to serve
// it would manufacture outages out of holidays. Staleness is confirmed only
// when BOTH hold: HEAD is older than --max-age-days AND origin/main is ahead.
// When origin is unreachable (no network guarantee in the SYSTEM boot
// context), age alone cannot confirm, so the verdict downgrades to
// STALE_UNCONFIRMED — loud, but the wrapper keeps serving.
//
// Usage:
//   node scripts/check-boot-staleness.mjs [--repo=<path>] [--max-age-days=7]
//        [--fetch-attempts=3] [--fetch-wait-ms=15000] [--selftest]
//
// Exit codes — BLIND and FRESH never share one:
//   0  FRESH             — HEAD is within the age threshold, or older but
//                          origin confirms nothing newer exists (quiet repo).
//   1  STALE_CONFIRMED   — HEAD older than threshold AND origin/main is ahead.
//                          The wrapper stops trading-server: no-listener/loud.
//   2  STALE_UNCONFIRMED — HEAD older than threshold but origin unreachable.
//                          Loud banner, keep serving.
//   3  BLIND             — the local repo itself could not be read. Never a pass.

import { spawnSync } from 'node:child_process';
import { statSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const has = flag => argv.includes(flag);
const valOf = name => {
  const hit = argv.find(a => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
};

const SELFTEST = has('--selftest');
const REPO = valOf('--repo') ?? join(import.meta.dirname, '..');
const MAX_AGE_DAYS = Number(valOf('--max-age-days') ?? 7);
const FETCH_ATTEMPTS = Number(valOf('--fetch-attempts') ?? 3);
const FETCH_WAIT_MS = Number(valOf('--fetch-wait-ms') ?? 15_000);

const DAY_MS = 86_400_000;

/** Every git call pins safe.directory: the boot context is LOCAL_SYSTEM while
 * the checkout is owned by eetienne, and git's dubious-ownership refusal would
 * otherwise turn every boot-time verdict into BLIND. Prompts are disabled so
 * a credential challenge can never hang the boot task (the repo is public). */
function git(repo, args, { timeoutMs = 60_000 } = {}) {
  const r = spawnSync('git', ['-c', `safe.directory=${repo}`, '-C', repo, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
  console.log(`[boot-staleness] ${msg}`);
}

async function grade({ repo, maxAgeDays, fetchAttempts, fetchWaitMs, quiet = false }) {
  const say = quiet ? () => {} : log;

  const head = git(repo, ['log', '-1', '--format=%H %ct', 'HEAD']);
  if (!head.ok) {
    say(`BLIND: cannot read HEAD of ${repo}: ${head.err || 'git failed'}`);
    return { verdict: 'BLIND', code: 3 };
  }
  const [sha, ctRaw] = head.out.split(/\s+/);
  const commitMs = Number(ctRaw) * 1000;
  if (!Number.isFinite(commitMs) || commitMs <= 0) {
    say(`BLIND: unparseable commit time for ${sha}: ${JSON.stringify(ctRaw)}`);
    return { verdict: 'BLIND', code: 3 };
  }
  const ageDays = Math.round(((Date.now() - commitMs) / DAY_MS) * 10) / 10;
  say(`HEAD ${sha.slice(0, 12)} committed ${new Date(commitMs).toISOString()} (${ageDays}d ago; threshold ${maxAgeDays}d)`);

  // Secondary, report-only: a dist older than HEAD means pulled-but-not-rebuilt —
  // the health route would then report a SHA the served bytes do not carry.
  try {
    const dist = statSync(join(repo, 'packages', 'server', 'dist', 'index.js'));
    if (dist.mtimeMs < commitMs) {
      say(`WARN: packages/server/dist/index.js (built ${dist.mtime.toISOString()}) is OLDER than HEAD — the built bytes predate the checkout. Rebuild before trusting /api/health/version's SHA.`);
    }
  } catch {
    say('WARN: packages/server/dist/index.js does not exist — nothing built to serve.');
  }

  // Age within threshold: fresh regardless of what origin holds. Being a few
  // commits behind a same-week tip is the normal state of a manual-deploy box.
  if (ageDays <= maxAgeDays) {
    say(`FRESH: HEAD is ${ageDays}d old, within the ${maxAgeDays}d threshold.`);
    return { verdict: 'FRESH', code: 0 };
  }

  // Old HEAD — is origin actually ahead, or is the repo just quiet?
  let fetched = false;
  let fetchErr = '';
  for (let attempt = 1; attempt <= fetchAttempts && !fetched; attempt++) {
    const f = git(repo, ['fetch', '--quiet', 'origin', 'main']);
    if (f.ok) {
      fetched = true;
    } else {
      fetchErr = f.err || 'git fetch failed';
      say(`fetch attempt ${attempt}/${fetchAttempts} failed: ${fetchErr}`);
      if (attempt < fetchAttempts) await sleep(fetchWaitMs);
    }
  }

  if (!fetched) {
    say(`STALE_UNCONFIRMED: HEAD is ${ageDays}d old (over the ${maxAgeDays}d threshold) but origin is unreachable, so "stale" cannot be told from "quiet". Serving continues — investigate loudly.`);
    return { verdict: 'STALE_UNCONFIRMED', code: 2 };
  }

  const behindQ = git(repo, ['rev-list', '--count', 'HEAD..FETCH_HEAD']);
  if (!behindQ.ok) {
    say(`BLIND: fetch succeeded but rev-list failed: ${behindQ.err}`);
    return { verdict: 'BLIND', code: 3 };
  }
  const behind = Number(behindQ.out);

  if (behind > 0) {
    say(`STALE_CONFIRMED: HEAD is ${ageDays}d old AND origin/main is ${behind} commit(s) ahead. This is the TRA-4849 shape — refuse to serve it silently.`);
    say('Remedy: git pull && pnpm --filter @trading-app/server build && pm2 restart trading-server && pm2 save');
    return { verdict: 'STALE_CONFIRMED', code: 1 };
  }

  say(`FRESH: HEAD is ${ageDays}d old but origin/main has nothing newer (behind=0) — a quiet repo, not a stale checkout.`);
  return { verdict: 'FRESH', code: 0 };
}

// ── selftest — discriminating controls, each in a throwaway temp repo ────────

function sh(cwd, args, env = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

const GIT_ID = ['-c', 'user.email=selftest@tra4851', '-c', 'user.name=tra4851-selftest'];

function commitAt(repo, name, isoDate) {
  const env = isoDate ? { GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate } : {};
  sh(repo, [...GIT_ID, 'commit', '--allow-empty', '-m', name], env);
}

async function selftest() {
  const root = mkdtempSync(join(tmpdir(), 'tra4851-'));
  const failures = [];
  const expect = async (label, dir, expectedCode, opts = {}) => {
    const { verdict, code } = await grade({
      repo: dir,
      maxAgeDays: 7,
      fetchAttempts: 1,
      fetchWaitMs: 0,
      quiet: true,
      ...opts,
    });
    const ok = code === expectedCode;
    console.log(`[selftest] ${ok ? 'PASS' : 'FAIL'} ${label}: verdict=${verdict} exit=${code} (expected ${expectedCode})`);
    if (!ok) failures.push(label);
  };

  try {
    const old = new Date(Date.now() - 40 * DAY_MS).toISOString();

    // Origin: an old commit, then a fresh tip.
    const origin = join(root, 'origin');
    sh(root, ['init', '-b', 'main', origin]);
    commitAt(origin, 'old base', old);
    commitAt(origin, 'fresh tip');

    // C0 FRESH — clone at the fresh tip.
    const fresh = join(root, 'fresh');
    sh(root, ['clone', '-q', origin, fresh]);
    await expect('C0 fresh clone at tip', fresh, 0);

    // C1 STALE_CONFIRMED — clone rolled back to the 40d-old commit; origin ahead.
    const stale = join(root, 'stale');
    sh(root, ['clone', '-q', origin, stale]);
    sh(stale, ['reset', '--hard', '-q', 'HEAD~1']);
    await expect('C1 old HEAD + origin ahead (the incident)', stale, 1);

    // C2 STALE_UNCONFIRMED — same old HEAD, origin unreachable.
    const dark = join(root, 'dark');
    sh(root, ['clone', '-q', origin, dark]);
    sh(dark, ['reset', '--hard', '-q', 'HEAD~1']);
    sh(dark, ['remote', 'set-url', 'origin', join(root, 'no-such-remote')]);
    await expect('C2 old HEAD + origin unreachable', dark, 2);

    // C3 BLIND — not a repo at all. Must never read as FRESH.
    const blind = join(root, 'blind');
    sh(root, ['init', '-b', 'main', blind]); // repo with zero commits: HEAD unreadable
    await expect('C3 unreadable HEAD', blind, 3);

    // C4 FRESH — old HEAD but origin has nothing newer: a quiet repo must not
    // refuse to serve (the false-positive arm the AND predicate exists for).
    const quietOrigin = join(root, 'quiet-origin');
    sh(root, ['init', '-b', 'main', quietOrigin]);
    commitAt(quietOrigin, 'only commit, long ago', old);
    const quiet = join(root, 'quiet');
    sh(root, ['clone', '-q', quietOrigin, quiet]);
    await expect('C4 old HEAD but origin quiet', quiet, 0);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* temp dir */ }
  }

  if (failures.length > 0) {
    console.error(`[selftest] ${failures.length} control(s) FAILED: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('[selftest] all controls pass');
  process.exit(0);
}

if (SELFTEST) {
  await selftest();
} else {
  const { verdict, code } = await grade({
    repo: REPO,
    maxAgeDays: MAX_AGE_DAYS,
    fetchAttempts: FETCH_ATTEMPTS,
    fetchWaitMs: FETCH_WAIT_MS,
  });
  log(`verdict: ${verdict} (exit ${code})`);
  process.exit(code);
}
