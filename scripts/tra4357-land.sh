#!/usr/bin/env bash
# TRA-4357 stage-and-land. Written 2026-09-08T18:5xZ from an `on_demand` board wake,
# which carries no `contextSnapshot.issueId` and therefore 403s on every issue write
# (`cross_issue_influence_run_context_required`, probed once this run -- the
# `X-Paperclip-Run-Id` remedy in that error body is a known trap, do not retry it).
#
# Run this from the NEXT ISSUE-BOUND wake. It is idempotent in both halves:
#   1. posts the AC3 comment on TRA-4357 exactly once (guarded by a marker string
#      searched in the existing comments, not by a local flag file -- a local flag
#      cannot see a comment that landed from a different checkout);
#   2. deploys 97b7c2d to bqb1 only if the drift check still says it is behind AND
#      the freeze gate lets it through. It does NOT hardcode "the freeze is over by
#      now" -- render-redeploy.mjs re-evaluates the window itself and exit 4 is a
#      clean, expected no-op, not a failure.
#
# Nothing here is an unattended executor: it runs only when a human/heartbeat wakes
# the agent (CLAUDE.md, "Do not fix this by giving the trains an unattended executor").
set -uo pipefail

# ⛔ NOT $PAPERCLIP_WORKSPACE_CWD. That variable points at
# projects/<companyId>/<projectId>/_default, which on this seat is an EMPTY directory --
# the checkout lives under workspaces/<agentId>/ instead. The 2026-09-08T18:5xZ draft of
# this script cd'd there, so BOTH halves would have failed silently: no .tra4357-ac3.md
# to post and no package.json to run the drift check from. Derive the repo root from the
# script's OWN location, which is true in every checkout regardless of seat layout.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 3
cd "$REPO_ROOT" || exit 3
[ -f package.json ] || { echo "[land] $REPO_ROOT is not the repo root"; exit 3; }

ISSUE_ID=12726290-bd16-4b4c-8f76-3b4e3306f46b   # TRA-4357
BODY_FILE=.tra4357-ac3.md

# The FLOOR: the AC3 commit. Anything at or above this carries AC1-AC4.
# Pinning the deploy to it exactly would be self-defeating -- committing this
# script already moved the tip past it, and every later fix would need a re-pin.
# So resolve the tip at run time and assert the floor is an ancestor of it, which
# is the property that actually matters. A tip that does NOT contain the floor
# means someone rewrote history; refuse rather than deploy something unexpected.
FLOOR=97b7c2dd619d35392704be5a160a5ef985d942d0
MARKER='AC3 GRADED, and it does not reproduce as filed'

BASE="${PAPERCLIP_API_URL%/}"; BASE="${BASE%/api}"

echo "== TRA-4357 land =="

# ---- 1. comment ------------------------------------------------------------
# ⛔ NO curl. The Bash tool on this seat ships git-bash WITHOUT curl, so the original
# `existing=$(curl ...)` did not merely fail -- it failed OPEN: an empty $existing makes
# the marker grep miss, and the guard then re-posts a DUPLICATE of a 6 KB comment. node
# is guaranteed present here (the deploy half already depends on it), so both the read
# and the write go through node's own fetch. A read that ERRORS is treated as "unknown",
# which SKIPS the post -- an unposted comment is recoverable, a double-post is not.
if [ ! -f "$BODY_FILE" ]; then
  echo "[land] MISSING $BODY_FILE -- comment half cannot run"
else
  node -e '
    const fs = require("fs");
    const [base, issueId, bodyFile, marker] = process.argv.slice(1);
    const key = process.env.PAPERCLIP_API_KEY;
    const auth = { Authorization: "Bearer " + key };
    (async () => {
      let existing;
      try {
        const r = await fetch(`${base}/api/issues/${issueId}/comments?limit=50`, { headers: auth });
        if (!r.ok) throw new Error("HTTP " + r.status);
        existing = JSON.stringify(await r.json());
      } catch (e) {
        console.log("[land] comment READ FAILED (" + e.message + ") -- SKIPPING the post rather than risking a duplicate.");
        return;
      }
      if (existing.includes(marker)) {
        console.log("[land] comment ALREADY POSTED -- skipping (idempotent)");
        return;
      }
      const r = await fetch(`${base}/api/issues/${issueId}/comments`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json",
                   "X-Paperclip-Run-Id": process.env.PAPERCLIP_RUN_ID ?? "" },
        body: JSON.stringify({ body: fs.readFileSync(bodyFile, "utf8") }),
      });
      console.log("[land] comment POST -> HTTP " + r.status);
      if (r.status === 403) console.log("[land] still walled: this wake is not issue-bound either. Re-run next wake.");
    })();
  ' "$BASE" "$ISSUE_ID" "$BODY_FILE" "$MARKER"
fi

# ---- 2. deploy -------------------------------------------------------------
# Drift first: if the box already serves this commit or newer, deploying again
# would dump the warm quote cache for nothing (TRA-1996).
pnpm check:deploy-drift
drift=$?
echo "[land] check:deploy-drift exit=$drift  (0 CURRENT / 1 STALE / 3 BLIND)"

if [ "$drift" = "0" ]; then
  echo "[land] live is CURRENT -- nothing to deploy."
elif [ "$drift" = "3" ]; then
  echo "[land] BLIND -- refusing to deploy against an unmeasured host. Investigate first."
else
  git fetch origin main --quiet
  COMMIT=$(git rev-parse origin/main)
  if ! git merge-base --is-ancestor "$FLOOR" "$COMMIT"; then
    echo "[land] REFUSING: origin/main ($COMMIT) does not contain the AC3 floor $FLOOR."
    echo "[land] History was rewritten. Do not deploy blind -- re-derive by hand."
    exit 3
  fi
  echo "[land] deploying origin/main tip $COMMIT (contains floor $FLOOR)"
  if [ -z "${RENDER_API_KEY:-}" ]; then
    echo "[land] RENDER_API_KEY unset -- cannot deploy from this wake."
  else
    node scripts/render-redeploy.mjs --commit="$COMMIT"
    rc=$?
    case "$rc" in
      0) echo "[land] DEPLOY TRIGGERED. Poll /api/health/version until commitShort==97b7c2dd, then re-run check:deploy-drift." ;;
      4) echo "[land] RTH FREEZE still closed (exit 4) -- expected no-op, retry after 20:00Z. NOT a failure." ;;
      5) echo "[land] dated EMBARGO (exit 5) -- read the EMBARGOES table before overriding." ;;
      6) echo "[land] HELD COMMIT (exit 6)." ;;
      7) echo "[land] AUTH_SECRET gate (exit 7) -- deploying would take the box DOWN. Do not override casually." ;;
      *) echo "[land] render-redeploy exit $rc" ;;
    esac
  fi
fi

echo "== after a successful deploy, AC5 is QuantTrader's to grade in an RTH window =="
