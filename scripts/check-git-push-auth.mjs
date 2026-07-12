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

// NOTHING BELOW SHORT-CIRCUITS TO OK.
// -----------------------------------
// Every source here establishes only that a credential is PRESENT. Presence is not
// validity — that is the whole lesson of this file — so none of them may pass on their
// own. They gate the "no credential at all" failure; the ls-remote probe further down is
// the sole arbiter of "can I actually push?", because it exercises exactly what `git
// push` exercises.
//
// $GH_TOKEN in particular used to exit 0 here, and that was actively dangerous: git does
// NOT read $GH_TOKEN. It is a `gh` CLI convention, and `gh` is not installed on this host
// (credential.helper=manager, GCM only). Verified: with the helper disabled and the token
// set, git reports `could not read Username` — it never looks at the variable. So the old
// early exit meant that following this script's OWN advice ("export GH_TOKEN=<PAT>")
// pinned the preflight GREEN forever while git quietly fell back to the rotating GCM
// token — reinstating the original TRA-1675 hang behind a green light.

// An embedded token in the remote URL is a credential git will genuinely use.
const urlCred = Boolean(new URL(remoteUrl).password || new URL(remoteUrl).username);

// An env token is NOT wired into git by default — see above. Tracked only so the failure
// report can tell you the difference between "you set no token" and "you set a token git
// cannot see".
const envToken = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_PAT'].find((k) => (process.env[k] ?? '').trim() !== '');

// Ask the credential helper, NON-INTERACTIVELY and with a hard bound, so this check can
// never inherit the very hang it exists to detect.
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
const present = urlCred || /^password=.+$/m.test(filled);

// A PAT is the durable headless fix — it does not rotate — but ONLY once git can see it.
// Exporting it and stopping there is a no-op: git has no $GH_TOKEN convention.
const PAT_REMEDY =
  `  git config --global credential.https://github.com.helper '!f(){ echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'\n` +
  `  export GH_TOKEN=<PAT with 'repo' scope>   # the helper above is what makes git read this\n`;

const stranded = () => {
  try {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    return git(['log', '--oneline', `${REMOTE}/${branch}..HEAD`]);
  } catch {
    /* no upstream ref cached — not important to the diagnosis */
    return '';
  }
};

const reportStranded = () => {
  const unpushed = stranded();
  if (!unpushed) return;
  const n = unpushed.split('\n').length;
  console.error(`${n} commit(s) are already stranded locally and are NOT on the remote:\n`);
  for (const line of unpushed.split('\n')) console.error(`  ${line}`);
  console.error('');
};

if (!present) {
  console.error(
    `\n[check-push-auth] FAIL — no credential for ${host}, so a push to '${REMOTE}' cannot authenticate.\n\n` +
      'DO NOT retry the push. It will not error — it will HANG, because Git Credential Manager\n' +
      'blocks waiting for a prompt that a headless session can never answer.\n',
  );
  reportStranded();
  if (envToken) {
    console.error(
      `NOTE: $${envToken} IS set — but git cannot see it. $${envToken} is a \`gh\` CLI convention, and git\n` +
        'has no such convention; it reads only credential.helper, a token-embedded remote URL, or\n' +
        'GIT_ASKPASS. Exporting the token without wiring it in leaves you with no credential at all.\n',
    );
  }
  console.error(
    'Issuing a credential for a private repo is secret issuance, which no agent on this host\n' +
      'can do. Tracked as TRA-1675.\n\n' +
      'Fix (any one), then re-run this check:\n' +
      '  1. wire a PAT into git — most durable for headless agents:\n' +
      PAT_REMEDY +
      `  2. seed the store once, interactively:  git push ${REMOTE} HEAD\n` +
      '  3. use a token-embedded remote or deploy key\n\n' +
      'Runbook: docs/runbook.md  §8 "GitHub credential for agent pushes"\n',
  );
  process.exit(1);
}

// PRESENCE IS NOT VALIDITY.
// -------------------------
// The store on this host holds a `gho_` GitHub OAuth access token, which EXPIRES on a
// clock (GCM refreshes it from a companion refresh token). An expired-but-still-stored
// token fills perfectly happily above — so a presence-only check prints OK and the push
// then dies on a 401. That is the same false-GREEN shape this script exists to kill,
// just moved one step down the pipe.
//
// So actually authenticate. `ls-remote` is the cheapest request that exercises the
// credential end-to-end (~1s), and it is bounded and non-interactive here for the same
// reason `credential fill` is: this check must never inherit the hang it detects.
let probeErr = null;
try {
  git(['ls-remote', '--heads', REMOTE], {
    timeout: 30_000,
    killSignal: 'SIGKILL',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
} catch (err) {
  probeErr = err;
}

if (!probeErr) {
  console.log(`[check-push-auth] OK — the credential for ${host} authenticated against '${REMOTE}'; push can proceed.`);
  process.exit(0);
}

const stderr = String(probeErr.stderr ?? '');
const authFailed = /authentication failed|invalid username or password|could not read (username|password)|403|401|bad credentials|terminal prompts disabled/i.test(
  stderr,
);

// An UNREACHABLE remote is not a bad credential, and must not be reported as one. Failing
// closed on a network blip would block every push on the host for a cause a new token
// cannot fix. It is also safe to pass here: a network error makes `git push` fail LOUDLY
// and quickly. The hazard this guard exists for is the credential PROMPT, which hangs
// silently — and a reachability failure cannot produce it.
if (!authFailed) {
  console.warn(
    `[check-push-auth] WARN — a credential for ${host} is present, but '${REMOTE}' could not be reached, so\n` +
      'it could not be verified. This is a reachability failure, not an auth failure; a push will\n' +
      'fail loudly rather than hang. Proceeding.\n' +
      `  ${stderr.trim().split('\n')[0] ?? probeErr.message}`,
  );
  process.exit(0);
}

console.error(
  `\n[check-push-auth] FAIL — the stored credential for ${host} is present but REJECTED by '${REMOTE}'.\n\n` +
    'It is stale, not missing: an expired or revoked token still sits in the credential store and\n' +
    'fills on request, so "a credential exists" is true and worthless. A push will 401.\n',
);
reportStranded();
console.error(
  'This host authenticates with a `gho_` OAuth access token, which expires by design — so this\n' +
    'state is EXPECTED to recur and is usually self-healing:\n\n' +
    '  1. Wait and re-run. Git Credential Manager mints a fresh token from its refresh token;\n' +
    '     the 2026-07-12 outage recovered on its own this way (TRA-1675).\n' +
    `  2. Still failing? The refresh token is expired too. Re-seed interactively: git push ${REMOTE} HEAD\n` +
    '  3. Durable headless fix — a PAT does not rotate. Exporting it is NOT enough; git has no\n' +
    '     $GH_TOKEN convention, so it must be wired into a credential helper:\n' +
    PAT_REMEDY +
    '\n' +
    'Do NOT report work as shipped while this fails. Your commits are still local.\n' +
    'Runbook: docs/runbook.md  §8 "GitHub credential for agent pushes"\n',
);
process.exit(1);
