// TRA-528 — deploy-version pinning.
//
// The recurring "nothing works in Live" incidents have repeatedly traced back to
// the running PM2 binary being an OLDER build than `origin/main` — an operator
// pulls + restarts the wrong clone, or forgets to rebuild, and the process keeps
// serving stale code while everyone reasons about the latest source. There was
// no way to ask the running process "what commit are you actually on?".
//
// This module resolves that identity from three sources, in priority order:
//   1. Environment variables baked at deploy time (`GIT_COMMIT`, `BUILD_TIME`),
//      which is the canonical, tamper-proof source on a real deploy.
//   2. The repo's `.git` files (HEAD + refs), a best-effort fallback so the
//      answer is still correct when the deploy pipeline didn't bake the env.
//   3. `package.json` version for the human-facing semver.
//
// The commit is immutable for the life of the process, so it is resolved once
// and cached; only the uptime is recomputed per call.

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// The server is built as ESM (`"type": "module"`), so the CommonJS `__dirname`
// global does not exist at runtime — referencing it throws `ReferenceError:
// __dirname is not defined`. Derive the module directory from `import.meta.url`
// instead so the `.git` / `package.json` walk-up fallbacks actually work on the
// live PM2 box (where neither `GIT_COMMIT` nor `npm_package_version` is set).
// Matches the `__dirname` idiom used across the rest of the server package.
const __dirname = dirname(fileURLToPath(import.meta.url));

export interface BuildInfo {
  /** Semver from package.json (currently 0.0.0 — placeholder until released). */
  version: string;
  /** Full 40-char commit SHA the process is running, or null if unknown. */
  commit: string | null;
  /** First 12 chars of `commit`, or null. Convenient for log lines / UI chips. */
  commitShort: string | null;
  /** Branch name when resolvable from `.git/HEAD` (detached HEAD → null). */
  branch: string | null;
  /** ISO build/deploy timestamp from `BUILD_TIME`, or null if not baked. */
  buildTime: string | null;
  /** Source the commit was resolved from — for debugging a wrong answer. */
  commitSource: 'env' | 'git' | 'none';
  nodeVersion: string;
  pid: number;
  /** ISO timestamp of process start. */
  startedAt: string;
  /** Whole seconds since process start. */
  uptimeSec: number;
}

/**
 * Interpret a `.git/HEAD` payload plus a ref resolver into `{ branch, commit }`.
 * Pure so the parsing is unit-testable without a real `.git` directory.
 *
 *  - `ref: refs/heads/main\n`  → branch `main`, commit = `refLookup('refs/heads/main')`.
 *  - a bare 40-hex SHA         → detached HEAD: branch null, commit = the SHA.
 */
export function interpretGitHead(
  head: string,
  refLookup: (ref: string) => string | null,
): { branch: string | null; commit: string | null } {
  const trimmed = head.trim();
  const refMatch = /^ref:\s*(.+)$/.exec(trimmed);
  if (refMatch) {
    const ref = refMatch[1]!.trim();
    const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    return { branch, commit: refLookup(ref) };
  }
  if (/^[0-9a-f]{40}$/i.test(trimmed)) {
    return { branch: null, commit: trimmed.toLowerCase() };
  }
  return { branch: null, commit: null };
}

/** Read a ref's SHA from `.git`, falling back to `packed-refs`. Best-effort. */
function readGitRef(gitDir: string, ref: string): string | null {
  try {
    const direct = readFileSync(join(gitDir, ref), 'utf-8').trim();
    if (/^[0-9a-f]{40}$/i.test(direct)) return direct.toLowerCase();
  } catch {
    /* not a loose ref — try packed-refs below */
  }
  try {
    const packed = readFileSync(join(gitDir, 'packed-refs'), 'utf-8');
    for (const line of packed.split('\n')) {
      if (line.startsWith('#') || !line.trim()) continue;
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && sha && /^[0-9a-f]{40}$/i.test(sha)) return sha.toLowerCase();
    }
  } catch {
    /* no packed-refs */
  }
  return null;
}

/** Resolve `{ branch, commit }` from a `.git` directory. Best-effort, never throws. */
function resolveFromGit(gitDir: string): { branch: string | null; commit: string | null } {
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf-8');
    return interpretGitHead(head, (ref) => readGitRef(gitDir, ref));
  } catch {
    return { branch: null, commit: null };
  }
}

export interface BuildInfoInputs {
  env: NodeJS.ProcessEnv;
  /** Resolves the repo's `.git` `{ branch, commit }`. Injectable for tests. */
  gitResolver: () => { branch: string | null; commit: string | null };
  version: string;
  nodeVersion: string;
  pid: number;
  startMs: number;
  nowMs: number;
}

/**
 * Pure assembly of {@link BuildInfo} from already-resolved inputs. Env commit
 * wins over the git-derived one (a deploy can bake a commit even from a shallow
 * checkout with no usable `.git`); the git answer is the fallback.
 */
export function computeBuildInfo(inputs: BuildInfoInputs): BuildInfo {
  const envCommitRaw = inputs.env['GIT_COMMIT'] ?? inputs.env['GIT_SHA'] ?? inputs.env['SOURCE_COMMIT'];
  const envCommit =
    typeof envCommitRaw === 'string' && /^[0-9a-f]{7,40}$/i.test(envCommitRaw.trim())
      ? envCommitRaw.trim().toLowerCase()
      : null;

  const git = inputs.gitResolver();
  const commit = envCommit ?? git.commit;
  const commitSource: BuildInfo['commitSource'] = envCommit ? 'env' : git.commit ? 'git' : 'none';

  const buildTimeRaw = inputs.env['BUILD_TIME'] ?? inputs.env['DEPLOY_TIME'];
  const buildTime =
    typeof buildTimeRaw === 'string' && buildTimeRaw.trim().length > 0 ? buildTimeRaw.trim() : null;

  const uptimeSec = Math.max(0, Math.floor((inputs.nowMs - inputs.startMs) / 1000));

  return {
    version: inputs.version,
    commit,
    commitShort: commit ? commit.slice(0, 12) : null,
    branch: git.branch,
    buildTime,
    commitSource,
    nodeVersion: inputs.nodeVersion,
    pid: inputs.pid,
    startedAt: new Date(inputs.startMs).toISOString(),
    uptimeSec,
  };
}

// ── runtime resolver (cached) ────────────────────────────────────────────────

let cachedVersion: string | null = null;
let cachedGit: { branch: string | null; commit: string | null } | null = null;
const PROCESS_START_MS = Date.now() - Math.round(process.uptime() * 1000);

function resolvePackageVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  const envVersion = process.env['npm_package_version'];
  if (typeof envVersion === 'string' && envVersion.length > 0) {
    cachedVersion = envVersion;
    return cachedVersion;
  }
  // dist/observability/build-info.js → ../../package.json; src is one level
  // shallower, so try both.
  for (const rel of [['..', '..', 'package.json'], ['..', '..', '..', 'package.json']]) {
    try {
      const raw = readFileSync(join(__dirname, ...rel), 'utf-8');
      const v = (JSON.parse(raw) as { version?: string }).version;
      if (typeof v === 'string' && v.length > 0) {
        cachedVersion = v;
        return cachedVersion;
      }
    } catch {
      /* try next candidate */
    }
  }
  cachedVersion = '0.0.0';
  return cachedVersion;
}

function resolveGitOnce(): { branch: string | null; commit: string | null } {
  if (cachedGit !== null) return cachedGit;
  // Walk up from this module looking for a `.git` directory. The server runs
  // from `dist/` so the repo root is a few levels up; try a generous range.
  for (let up = 2; up <= 6; up++) {
    const parts = Array.from({ length: up }, () => '..');
    const candidate = join(__dirname, ...parts, '.git');
    const resolved = resolveFromGit(candidate);
    if (resolved.commit) {
      cachedGit = resolved;
      return cachedGit;
    }
  }
  cachedGit = { branch: null, commit: null };
  return cachedGit;
}

/** Resolve the running process's build identity. Commit/version are cached. */
export function resolveBuildInfo(): BuildInfo {
  return computeBuildInfo({
    env: process.env,
    gitResolver: resolveGitOnce,
    version: resolvePackageVersion(),
    nodeVersion: process.version,
    pid: process.pid,
    startMs: PROCESS_START_MS,
    nowMs: Date.now(),
  });
}
