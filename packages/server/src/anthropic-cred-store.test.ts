import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// The store reads DATA_DIR once at module load, so set it to an isolated temp
// dir BEFORE the (dynamic) import. vitest gives each test file a fresh module
// registry, so this file's dynamic import picks up the override cleanly.
type Store = typeof import('./anthropic-cred-store.js');
let store: Store;

beforeAll(async () => {
  process.env['DATA_DIR'] = mkdtempSync(join(tmpdir(), 'anthropic-cred-'));
  store = await import('./anthropic-cred-store.js');
});

describe('anthropic-cred-store (TRA-714)', () => {
  const USER = 'tra714-user';

  it('recognises a console API key and rejects everything else', () => {
    expect(store.isConsoleApiKey('sk-ant-api03-abc')).toBe(true);
    expect(store.isConsoleApiKey('  sk-ant-api03-abc  ')).toBe(true);
    expect(store.isConsoleApiKey('sk-ant-oat01-abc')).toBe(false);
    expect(store.isConsoleApiKey('nope')).toBe(false);
    expect(store.isConsoleApiKey('')).toBe(false);
  });

  it('rejects a subscription OAuth token with a clear message', () => {
    expect(() => store.setUserAnthropicApiKey(USER, 'sk-ant-oat01-whatever')).toThrow(/OAuth token/i);
  });

  it('rejects a non-console value', () => {
    expect(() => store.setUserAnthropicApiKey(USER, 'random')).toThrow(/sk-ant-api03/);
    expect(() => store.setUserAnthropicApiKey(USER, '   ')).toThrow(/required/i);
  });

  it('stores, reads, describes, and clears a console key per user', () => {
    expect(store.getUserAnthropicApiKey(USER)).toBeNull();
    expect(store.describeUserAnthropicApiKey(USER)).toEqual({ present: false, prefix: '' });

    store.setUserAnthropicApiKey(USER, '  sk-ant-api03-secret-body  ');
    expect(store.getUserAnthropicApiKey(USER)).toBe('sk-ant-api03-secret-body');
    const desc = store.describeUserAnthropicApiKey(USER);
    expect(desc.present).toBe(true);
    expect(desc.prefix).toBe('sk-ant-api03'); // ≤12 chars, no secret body

    // Isolation: another user is unaffected.
    expect(store.getUserAnthropicApiKey('other-user')).toBeNull();

    store.clearUserAnthropicApiKey(USER);
    expect(store.getUserAnthropicApiKey(USER)).toBeNull();
    expect(store.describeUserAnthropicApiKey(USER).present).toBe(false);
  });
});
