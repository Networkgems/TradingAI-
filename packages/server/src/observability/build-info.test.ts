// TRA-528 — build-info / deploy-version pinning tests.

import { describe, it, expect } from 'vitest';
import { interpretGitHead, computeBuildInfo, resolveBuildInfo } from './build-info.js';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

describe('interpretGitHead', () => {
  it('resolves a branch ref to its short branch name + looked-up commit', () => {
    const out = interpretGitHead('ref: refs/heads/main\n', (ref) =>
      ref === 'refs/heads/main' ? SHA : null,
    );
    expect(out).toEqual({ branch: 'main', commit: SHA });
  });

  it('treats a bare 40-hex HEAD as a detached commit (no branch)', () => {
    const out = interpretGitHead(`${SHA}\n`, () => null);
    expect(out).toEqual({ branch: null, commit: SHA });
  });

  it('returns null commit when the ref cannot be looked up', () => {
    const out = interpretGitHead('ref: refs/heads/feature\n', () => null);
    expect(out).toEqual({ branch: 'feature', commit: null });
  });

  it('returns nulls for an unrecognised HEAD payload', () => {
    expect(interpretGitHead('garbage', () => null)).toEqual({ branch: null, commit: null });
  });
});

describe('computeBuildInfo', () => {
  const base = {
    gitResolver: () => ({ branch: 'main' as string | null, commit: SHA2 }),
    version: '1.2.3',
    nodeVersion: 'v20.0.0',
    pid: 4242,
    startMs: 1_000_000,
    nowMs: 1_000_000 + 90_000,
  };

  it('prefers the env-baked commit over the git-derived one', () => {
    const info = computeBuildInfo({ ...base, env: { GIT_COMMIT: SHA } });
    expect(info.commit).toBe(SHA);
    expect(info.commitShort).toBe(SHA.slice(0, 12));
    expect(info.commitSource).toBe('env');
    // branch still comes from git even when the commit came from env
    expect(info.branch).toBe('main');
  });

  it('accepts a short (7-char) env commit', () => {
    const info = computeBuildInfo({ ...base, env: { GIT_SHA: 'abc1234' } });
    expect(info.commit).toBe('abc1234');
    expect(info.commitSource).toBe('env');
  });

  it('falls back to the git commit when no env var is set', () => {
    const info = computeBuildInfo({ ...base, env: {} });
    expect(info.commit).toBe(SHA2);
    expect(info.commitSource).toBe('git');
  });

  it('reports commitSource "none" when neither env nor git resolves', () => {
    const info = computeBuildInfo({
      ...base,
      env: {},
      gitResolver: () => ({ branch: null, commit: null }),
    });
    expect(info.commit).toBeNull();
    expect(info.commitShort).toBeNull();
    expect(info.commitSource).toBe('none');
  });

  it('ignores a malformed env commit and falls through to git', () => {
    const info = computeBuildInfo({ ...base, env: { GIT_COMMIT: 'not-a-sha!!' } });
    expect(info.commit).toBe(SHA2);
    expect(info.commitSource).toBe('git');
  });

  it('surfaces BUILD_TIME and computes whole-second uptime + startedAt', () => {
    const info = computeBuildInfo({
      ...base,
      env: { BUILD_TIME: '2026-06-02T00:00:00.000Z' },
    });
    expect(info.buildTime).toBe('2026-06-02T00:00:00.000Z');
    expect(info.uptimeSec).toBe(90);
    expect(info.startedAt).toBe(new Date(1_000_000).toISOString());
    expect(info.version).toBe('1.2.3');
    expect(info.nodeVersion).toBe('v20.0.0');
    expect(info.pid).toBe(4242);
  });

  it('clamps negative uptime (clock skew) to 0', () => {
    const info = computeBuildInfo({ ...base, env: {}, nowMs: 999_000 });
    expect(info.uptimeSec).toBe(0);
  });
});

// Regression guard for the live-deploy incident where `/api/health/version` and
// `/api/health/live` 500'd with `ReferenceError: __dirname is not defined`: the
// server runs as ESM, so the module's `.git` / `package.json` walk-up fallbacks
// must not reference the (nonexistent) CommonJS `__dirname` global. The earlier
// tests all inject `gitResolver`/`version`, so they never exercised those
// fallback paths — this calls the *real* runtime resolver end-to-end.
describe('resolveBuildInfo (real runtime resolver)', () => {
  it('does not throw and returns a well-formed BuildInfo under ESM', () => {
    const info = resolveBuildInfo();
    expect(typeof info.version).toBe('string');
    expect(['env', 'git', 'none']).toContain(info.commitSource);
    expect(info.nodeVersion).toBe(process.version);
    expect(info.pid).toBe(process.pid);
    expect(info.uptimeSec).toBeGreaterThanOrEqual(0);
    // Running inside the repo with no baked env, the `.git` walk-up (the path
    // that previously threw on `__dirname`) resolves a real 40-hex commit.
    expect(info.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});
