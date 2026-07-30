// TRA-714 — per-user Anthropic API-key store.
//
// Background: the AI Options Ideas research pass needs an Anthropic credential.
// A Claude Pro/Max *subscription* OAuth token authenticates but is rate-limited
// to near-zero for server-to-API use (it 429s on the first research pass every
// time), so the feature genuinely requires a pay-as-you-go console API key
// (`sk-ant-api03…`). The original ask on TRA-714 was: "I'm on the Max plan and
// couldn't set up the API key — give me another way." The earlier answer routed
// the key through a Render service env var, which the board repeatedly could not
// get to land in the running process.
//
// This module is the "another way": it lets the key be installed **through the
// app itself**, persisted under the per-user DATA_DIR (the same persistent disk
// that survives Render restarts/redeploys), with no Render-dashboard access
// required. Each user manages their own key, so a throwaway demo account can
// never read or clobber the board's credential.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { logger } from './observability/index.js';
import { resolveDataDir } from './data-dir.js';

const log = logger.child({ module: 'anthropic-cred-store' });

const DATA_DIR = resolveDataDir();

/** Per-user persisted store: `DATA_DIR/users/<username>/anthropic-cred.json`. */
function credFile(username: string): string {
  return join(DATA_DIR, 'users', username, 'anthropic-cred.json');
}

interface StoredCred {
  /** A console (pay-as-you-go) API key — `sk-ant-api…`. */
  apiKey: string;
}

/**
 * A console API key starts with `sk-ant-api` (e.g. `sk-ant-api03-…`). We reject
 * the subscription OAuth token (`sk-ant-oat…`) on purpose: storing it would just
 * reproduce the 429 the feature already fails on, defeating the whole point.
 */
export function isConsoleApiKey(value: string): boolean {
  return /^sk-ant-api[0-9]/.test(value.trim());
}

/** The leading credential-type marker (≤12 chars), safe to surface — no secret. */
function prefixOf(value: string): string {
  return value.trim().slice(0, 12);
}

/** Read the stored console API key for a user, or null when none is set. */
export function getUserAnthropicApiKey(username: string): string | null {
  try {
    const file = credFile(username);
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<StoredCred>;
    const key = (parsed.apiKey ?? '').trim();
    return key.length > 0 ? key : null;
  } catch (err) {
    log.warn('failed to read anthropic cred', {
      username,
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Persist a console API key for a user. Throws `Error` with a user-facing
 * message when the value is not a console key, so the route can 400 cleanly.
 */
export function setUserAnthropicApiKey(username: string, apiKey: string): void {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    throw new Error('API key is required.');
  }
  if (trimmed.startsWith('sk-ant-oat')) {
    throw new Error(
      'That is a Claude subscription OAuth token (sk-ant-oat…), which Anthropic rate-limits for server use. ' +
        'Paste a pay-as-you-go console API key from console.anthropic.com (it starts with sk-ant-api03…).',
    );
  }
  if (!isConsoleApiKey(trimmed)) {
    throw new Error('Expected a console API key starting with "sk-ant-api03…" (from console.anthropic.com → API keys).');
  }
  const file = credFile(username);
  mkdirSync(dirname(file), { recursive: true });
  // 0600 so the on-disk secret is owner-only.
  writeFileSync(file, JSON.stringify({ apiKey: trimmed } satisfies StoredCred), { encoding: 'utf-8', mode: 0o600 });
  log.info('anthropic console api key stored', { username, prefix: prefixOf(trimmed) });
}

/** Remove a user's stored API key (revert to the server env credential). */
export function clearUserAnthropicApiKey(username: string): void {
  try {
    const file = credFile(username);
    if (existsSync(file)) rmSync(file);
    log.info('anthropic console api key cleared', { username });
  } catch (err) {
    log.warn('failed to clear anthropic cred', {
      username,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Non-secret description of a user's stored key for surfacing in the UI/API. */
export function describeUserAnthropicApiKey(username: string): { present: boolean; prefix: string } {
  const key = getUserAnthropicApiKey(username);
  return { present: key != null, prefix: key ? prefixOf(key) : '' };
}
