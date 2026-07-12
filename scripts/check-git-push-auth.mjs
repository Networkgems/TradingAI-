#!/usr/bin/env node
// TRA-1675 — fail fast when the host has no GitHub credential, instead of hanging.
//
// THE HAZARD
// ----------
// `origin` is a private HTTPS remote. When no github.com credential is available,
// Git Credential Manager tries to PROMPT for one. In a headless agent session
// nothing can answer that prompt, so `git push` does not fail — it BLOCKS, until
// something kills it (observed: >8 minutes, no output).
//
// A hang is worse than an error. `AGENTS.md` requires every agent to push after
// committing and then verify the push landed. An agent whose push is killed
// mid-hang can conclude the work shipped when the commit is still sitting in the
// local tree — the same silent false-GREEN class that check-stale-js.mjs exists to
// stop, and the reason commit 42c0867 sat unpushed while its ticket read complete.
//
// This check is the fast, loud failure that a hang denies you: it answers "can I
// push?" in well under a second, BEFORE any push is attempted.
//
// WHY IT DOES NOT TOUCH GIT CONFIG
// --------------------------------
// The obvious fix — set `credential.interactive=false` so GCM errors instead of
// prompting — would also block a human from seeding the credential store
// interactively, which is one of the sanctioned ways to fix the underlying
// problem. So this is a preflight, not a config change: it makes agents fail fast
// while leaving the human's repair path intact.
//
// Usage:
//   node scripts/check-git-push-auth.mjs        # exit 0 if a push could authenticate
//   pnpm check:push-auth
import { execFileSync } from 'node:child_process';

const REMOTE = process.argv.find((a) => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]) ?? 'origin';

const git = (args, opts = {}) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();

let remoteUrl;
try {
  remoteUrl = git(['remote', 'get-url', REMOTE]);
} catch {
  console.error(`[check-push-auth] FAIL — no remote named '${REMOTE}'.`);
  process.exit(1);
}

// SSH remotes authenticate with keys, not the credential store. Nothing to check.
if (!/^https?:\/\//i.test(remoteUrl)) {
  console.log(`[check-push-auth] OK — '${REMOTE}' is not an HTTPS remote (${remoteUrl}); credential store not used.`);
  process.exit(0);
}

const host = new URL(remoteUrl).host;

// An embedded token in the remote URL is itself a credential.
if (new URL(remoteUrl).password || new URL(remoteUrl).username) {
  console.log(`[check-push-auth] OK — '${REMOTE}' carries credentials in its URL.`);
  process.exit(0);
}

// A token in the environment is the durable headless path; git can be pointed at it.
const envToken = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_PAT'].find((k) => (process.env[k] ?? '').trim() !== '');
if (envToken) {
  console.log(`[check-push-auth] OK — $${envToken} is set for ${host}.`);
  process.exit(0);
}

// Otherwise: ask the credential helper, NON-INTERACTIVELY and with a hard bound, so
// this check can never inherit the very hang it exists to detect.
let filled = '';
try {
  filled = execFileSync('git', ['credential', 'fill'], {
    input: `protocol=https\nhost=${host}\n\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 15_000,
    killSignal: 'SIGKILL',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
} catch (err) {
  // A helper that tried to prompt exits non-zero here rather than blocking. Either
  // way we have no credential — fall through to the failure report.
  filled = err.stdout ?? '';
}

// Presence only. The secret is never read, logged, or compared.
if (/^password=.+$/m.test(filled)) {
  console.log(`[check-push-auth] OK — a credential for ${host} is available; push can authenticate.`);
  process.exit(0);
}

let unpushed = '';
try {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  unpushed = git(['log', '--oneline', `${REMOTE}/${branch}..HEAD`]);
} catch {
  /* no upstream ref cached — not important to the diagnosis */
}

console.error(
  `\n[check-push-auth] FAIL — no credential for ${host}, so a push to '${REMOTE}' cannot authenticate.\n\n` +
    'DO NOT retry the push. It will not error — it will HANG, because Git Credential Manager\n' +
    'blocks waiting for a prompt that a headless session can never answer.\n',
);

if (unpushed) {
  const n = unpushed.split('\n').length;
  console.error(`${n} commit(s) are already stranded locally and are NOT on the remote:\n`);
  for (const line of unpushed.split('\n')) console.error(`  ${line}`);
  console.error('');
}

console.error(
  'This is a HUMAN action — issuing a credential for a private repo is secret issuance,\n' +
    'and no agent on this host can do it. Tracked as TRA-1675.\n\n' +
    'Fix (any one), then re-run this check:\n' +
    `  1. export GH_TOKEN=<PAT with 'repo' scope>       # most durable for headless agents\n` +
    `  2. seed the store once, interactively:  git push ${REMOTE} HEAD\n` +
    '  3. use a token-embedded remote or deploy key\n\n' +
    'Runbook: docs/runbook.md  §8 "GitHub credential for agent pushes"\n',
);
process.exit(1);
