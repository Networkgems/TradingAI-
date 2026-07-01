// TRA-1008 — file-backed override for non-secret DEMO-sandbox feature flags.
//
// Why this exists: the self-hosted `trading-server` (PG-DEVOPS14) has NO dotenv
// loader — its environment lives only in PM2's saved process env (dump.pm2). The
// PM2 daemon runs in session 0 as SYSTEM, so the fleet (non-admin) user cannot
// reach the daemon pipe (`connect EPERM \\.\pipe\rpc.sock`) to run
// `pm2 restart --update-env` / `pm2 save`. That made it impossible for a
// non-admin operator/agent to set a NEW demo toggle such as
// ENABLE_AUTONOMOUS_DEMO_LOOP without elevation — the exact wall hit on
// TRA-1008 (which blocked TRA-1007's forward-validation of the TRA-1004 loop):
// editing `.env` and admin-restarting re-execs the worker with the SAME saved
// env, so the flag never appeared (`enabled:false`).
//
// This module adds a writable, daemon-free path: a small JSON file under
// DATA_DIR (`demo-flags.json`) whose values are layered OVER process.env when
// resolving demo-loop flags. It is STRICTLY allowlisted to non-secret DEMO
// toggles — secrets (ADMIN_PASSWORD, AUTH_SECRET, TRADIER_*, etc.) are NEVER
// read from this file and continue to live only in the saved process env. The
// file is read on each resolve, so a flip is picked up on the next tick without
// any PM2 / SYSTEM elevation (and survives a non-admin `redeploy --no-build`).

import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Non-secret DEMO-sandbox flags an operator may set via `demo-flags.json`.
 * Anything not on this list in the file is ignored — this is the guardrail that
 * keeps the file from ever injecting a secret or a non-demo setting.
 */
export const DEMO_FLAG_ALLOWLIST = [
  'ENABLE_AUTONOMOUS_DEMO_LOOP',
  'AUTONOMOUS_DEMO_LOOP_INTERVAL_MS',
  // TRA-1216 — observe-only perp funding-carry scanner + forward funding-history
  // accrual. Non-secret, read-only, no order path — safe for the file override so
  // a non-admin operator can arm the forward series on the self-hosted host.
  'ENABLE_PERP_FUNDING_CARRY_OBSERVE',
] as const;

export const DEMO_FLAGS_FILENAME = 'demo-flags.json';

/**
 * Read allowlisted demo flags from `<dataDir>/demo-flags.json`. Returns an empty
 * object when the file is absent or malformed — the default, zero-override path.
 * Values are coerced to strings so they slot straight into a `ProcessEnv`.
 */
export function loadDemoFlagFile(dataDir: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(join(dataDir, DEMO_FLAGS_FILENAME), 'utf8');
  } catch {
    return {}; // absent file ⇒ no overrides
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {}; // malformed JSON ⇒ ignore rather than crash the loop
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const key of DEMO_FLAG_ALLOWLIST) {
    const v = (parsed as Record<string, unknown>)[key];
    if (typeof v === 'string') out[key] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[key] = String(v);
  }
  return out;
}

/**
 * Effective env for demo-loop flag resolution: `baseEnv` (process.env by
 * default) with allowlisted `demo-flags.json` values layered on top. The FILE
 * WINS so an operator's local override is authoritative — it is the only
 * writable switch a non-admin agent has on this host. Pass the result to
 * `isAutonomousDemoLoopEnabled` / `getAutonomousDemoStatus` / the schedule.
 */
export function resolveDemoFlagEnv(
  dataDir: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const file = loadDemoFlagFile(dataDir);
  if (Object.keys(file).length === 0) return baseEnv;
  return { ...baseEnv, ...file };
}
