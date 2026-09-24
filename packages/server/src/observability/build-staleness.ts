// TRA-4851 — boot staleness self-check (off the TRA-4849 incident).
//
// The box rebooted 2026-09-24T01:34Z and the SYSTEM-owned PM2 boot-resurrect
// re-served whatever HEAD the shared checkout held — a44ca2a4, ~600 commits /
// 42 days stale — and the stale instance read exactly like quiet health unless
// the reader pinned `build.commit` by hand AND knew what the tip should be.
// `/api/health/version` reports its SHA with exactly as much confidence 600
// commits behind as at the tip, so the identity alone cannot alarm.
//
// This module makes the AGE of the running commit a first-class health fact:
// how old was the commit this process bound at boot, and is that older than
// any plausible gap between deploys of this repo? It runs inside the server
// process, so it is on the exact path every resurrect exercises regardless of
// which wrapper copy the scheduled task happens to point at (the boot task's
// -File path is not readable, or editable, from an agent session — the guard
// that is guaranteed to run must live in the code PM2 restores).
//
// Per CLAUDE.md health doctrine: the git query's outcome is reported off the
// one real attempt (cached — the commit cannot change for the life of the
// process), and an unresolvable age is its own named `unknown` state with a
// reason, never a silent pass.

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Commit age above which a boot is considered stale. This repo lands multiple
 * commits per day; 7 days of HEAD age at boot means the checkout is not being
 * maintained, which is the TRA-4849 shape (42 days). Overridable for hosts
 * with a genuinely slower cadence. */
export const DEFAULT_MAX_COMMIT_AGE_DAYS = 7;

export interface BuildStaleness {
  /** `stale` = the running commit was older than `thresholdDays` at boot. */
  state: 'fresh' | 'stale' | 'unknown';
  /** ISO committer time of the running commit, or null when unresolvable. */
  commitTime: string | null;
  /** Age of the running commit at process start, in days (1 decimal). */
  ageDaysAtBoot: number | null;
  thresholdDays: number;
  /** Named reason when `state` is `unknown` — absence is an alarm, not a pass. */
  reason: 'no_commit' | 'commit_time_unresolvable' | null;
  /** ISO time the git query actually ran (it runs once, then is cached). */
  measuredAt: string;
}

export interface BuildStalenessInputs {
  /** Epoch ms of the running commit's committer time, or null if unknown. */
  commitTimeMs: number | null;
  /** Epoch ms of process start. */
  bootMs: number;
  thresholdDays: number;
  /** Why `commitTimeMs` is null, when it is. */
  unknownReason?: 'no_commit' | 'commit_time_unresolvable';
  measuredAtMs: number;
}

/** Parse the threshold env override. NaN, zero and negatives fall back to the
 * default — `Number(x) > 0` puts every non-finite value in the REJECT branch
 * (the TRA-3440 lesson: `x != null` admits NaN into the permissive arm). */
export function parseThresholdDays(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_COMMIT_AGE_DAYS;
}

/** Pure verdict assembly, unit-testable without git. */
export function computeBuildStaleness(inputs: BuildStalenessInputs): BuildStaleness {
  const measuredAt = new Date(inputs.measuredAtMs).toISOString();
  if (inputs.commitTimeMs === null) {
    return {
      state: 'unknown',
      commitTime: null,
      ageDaysAtBoot: null,
      thresholdDays: inputs.thresholdDays,
      reason: inputs.unknownReason ?? 'commit_time_unresolvable',
      measuredAt,
    };
  }
  const ageDays = Math.max(0, (inputs.bootMs - inputs.commitTimeMs) / 86_400_000);
  const rounded = Math.round(ageDays * 10) / 10;
  return {
    state: ageDays > inputs.thresholdDays ? 'stale' : 'fresh',
    commitTime: new Date(inputs.commitTimeMs).toISOString(),
    ageDaysAtBoot: rounded,
    thresholdDays: inputs.thresholdDays,
    reason: null,
    measuredAt,
  };
}

/** Resolve a commit's committer time (epoch ms) by asking git, walking up from
 * this module to find the repo root. Best-effort, never throws. */
export function resolveCommitTimeMs(commit: string): number | null {
  for (let up = 2; up <= 6; up++) {
    const root = join(__dirname, ...Array.from({ length: up }, () => '..'));
    if (!existsSync(join(root, '.git'))) continue;
    try {
      const out = execFileSync('git', ['-C', root, 'show', '-s', '--format=%ct', commit], {
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const seconds = Number(out.split('\n').pop());
      if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    } catch {
      /* fall through — repo present but git query failed */
    }
    return null;
  }
  return null;
}

// ── runtime resolver (cached — the commit is immutable for the process) ──────

let cached: BuildStaleness | null = null;

export function resolveBuildStaleness(deps: {
  commit: string | null;
  bootMs: number;
  env?: NodeJS.ProcessEnv;
}): BuildStaleness {
  if (cached !== null) return cached;
  const thresholdDays = parseThresholdDays((deps.env ?? process.env)['BUILD_MAX_COMMIT_AGE_DAYS']);
  const measuredAtMs = Date.now();
  if (!deps.commit) {
    cached = computeBuildStaleness({
      commitTimeMs: null, bootMs: deps.bootMs, thresholdDays,
      unknownReason: 'no_commit', measuredAtMs,
    });
    return cached;
  }
  const commitTimeMs = resolveCommitTimeMs(deps.commit);
  cached = computeBuildStaleness({
    commitTimeMs, bootMs: deps.bootMs, thresholdDays,
    unknownReason: commitTimeMs === null ? 'commit_time_unresolvable' : undefined,
    measuredAtMs,
  });
  return cached;
}

/** Test hook — the cache would otherwise leak one test's verdict into the next. */
export function resetBuildStalenessCacheForTest(): void {
  cached = null;
}
