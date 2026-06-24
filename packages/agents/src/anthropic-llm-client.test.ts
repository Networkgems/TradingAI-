import { describe, it, expect, vi } from 'vitest';
import {
  AnthropicLlmClient,
  modelAcceptsTemperature,
  modelSupportsAdaptiveThinking,
  createAnthropicLlmClientFromEnv,
  type AnthropicLike,
} from './anthropic-llm-client.js';
import { completeJson, type LlmCompletionRequest } from './llm-client.js';

function fakeMessage(text: string, usage: Record<string, number> = {}) {
  return {
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      ...usage,
    },
  } as never;
}

function stubClient(create: AnthropicLike['messages']['create']): AnthropicLike {
  return { messages: { create } };
}

const req: LlmCompletionRequest = {
  tier: 'strong',
  purpose: 'test',
  temperature: 0.2,
  messages: [
    { role: 'system', content: 'you are a tester' },
    { role: 'user', content: 'emit {"ok":true}' },
  ],
};

describe('modelAcceptsTemperature', () => {
  it('rejects temperature for opus 4.7+ and accepts it elsewhere', () => {
    expect(modelAcceptsTemperature('claude-opus-4-7')).toBe(false);
    expect(modelAcceptsTemperature('claude-opus-4-8')).toBe(false);
    expect(modelAcceptsTemperature('claude-opus-4-6')).toBe(true);
    expect(modelAcceptsTemperature('claude-sonnet-4-6')).toBe(true);
    expect(modelAcceptsTemperature('claude-haiku-4-5')).toBe(true);
  });
});

describe('modelSupportsAdaptiveThinking', () => {
  it('is true for Opus 4.6+ and Sonnet 4.6, false for Haiku and older', () => {
    expect(modelSupportsAdaptiveThinking('claude-opus-4-8')).toBe(true);
    expect(modelSupportsAdaptiveThinking('claude-opus-4-6')).toBe(true);
    expect(modelSupportsAdaptiveThinking('claude-sonnet-4-6')).toBe(true);
    expect(modelSupportsAdaptiveThinking('claude-opus-4-5')).toBe(false);
    expect(modelSupportsAdaptiveThinking('claude-sonnet-4-5')).toBe(false);
    expect(modelSupportsAdaptiveThinking('claude-haiku-4-5')).toBe(false);
  });
});

describe('AnthropicLlmClient.complete', () => {
  it('folds system messages into the system param and passes user/assistant turns', async () => {
    const create = vi.fn().mockResolvedValue(fakeMessage('{"ok":true}'));
    const llm = new AnthropicLlmClient({ client: stubClient(create) });
    const res = await llm.complete(req);
    expect(res.text).toBe('{"ok":true}');
    const body = create.mock.calls[0]![0];
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.system).toBe('you are a tester');
    expect(body.messages).toEqual([{ role: 'user', content: 'emit {"ok":true}' }]);
    // sonnet 4.6 accepts temperature → forwarded
    expect(body.temperature).toBe(0.2);
  });

  it('omits temperature when the mapped model rejects it (opus 4.7+)', async () => {
    const create = vi.fn().mockResolvedValue(fakeMessage('{}'));
    const llm = new AnthropicLlmClient({
      client: stubClient(create),
      models: { strong: 'claude-opus-4-8' },
    });
    await llm.complete(req);
    expect(create.mock.calls[0]![0].temperature).toBeUndefined();
  });

  it('applies adaptive thinking on a supporting model: thinking+effort on, temperature dropped, max_tokens lifted to the floor', async () => {
    const create = vi.fn().mockResolvedValue(fakeMessage('{}'));
    const llm = new AnthropicLlmClient({ client: stubClient(create) }); // strong → sonnet-4-6
    await llm.complete({ ...req, maxTokens: 900, thinking: { effort: 'high' } });
    const body = create.mock.calls[0]![0];
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'high' });
    expect(body.temperature).toBeUndefined(); // dropped even though sonnet accepts it
    expect(body.max_tokens).toBe(2500); // lifted from 900 to the thinking floor
  });

  it('does NOT apply thinking on the fast/Haiku tier (effort would 400) and keeps temperature', async () => {
    const create = vi.fn().mockResolvedValue(fakeMessage('{}'));
    const llm = new AnthropicLlmClient({ client: stubClient(create) });
    await llm.complete({ ...req, tier: 'fast', maxTokens: 700, thinking: { effort: 'high' } });
    const body = create.mock.calls[0]![0];
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
    expect(body.temperature).toBe(0.2); // haiku accepts temperature → still forwarded
    expect(body.max_tokens).toBe(700); // floor not applied when thinking is off
  });

  it('omits thinking entirely when the caller does not request it (default behavior unchanged)', async () => {
    const create = vi.fn().mockResolvedValue(fakeMessage('{}'));
    const llm = new AnthropicLlmClient({ client: stubClient(create) });
    await llm.complete(req);
    const body = create.mock.calls[0]![0];
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
    expect(body.temperature).toBe(0.2);
  });

  it('computes costUsd from usage at the model price', async () => {
    const create = vi
      .fn()
      .mockResolvedValue(fakeMessage('{}', { input_tokens: 1_000_000, output_tokens: 1_000_000 }));
    const llm = new AnthropicLlmClient({ client: stubClient(create) });
    const res = await llm.complete(req);
    // sonnet 4.6 = $3 in + $15 out per 1M → $18 for 1M each
    expect(res.costUsd).toBeCloseTo(18, 6);
  });

  it('prices cache reads at 0.1x input rate', async () => {
    const create = vi
      .fn()
      .mockResolvedValue(fakeMessage('{}', { cache_read_input_tokens: 1_000_000 }));
    const llm = new AnthropicLlmClient({ client: stubClient(create) });
    const res = await llm.complete(req);
    expect(res.costUsd).toBeCloseTo(0.3, 6); // 3 * 0.1
  });

  it('routes through completeJson and accumulates cost across retries', async () => {
    let n = 0;
    const create = vi.fn().mockImplementation(async () =>
      fakeMessage(n++ === 0 ? 'not json' : '{"v":1}', { output_tokens: 1_000_000 }),
    );
    const llm = new AnthropicLlmClient({ client: stubClient(create) });
    const out = await completeJson<{ v: number }>(llm, req, {
      validate: (val) => (typeof (val as { v?: unknown }).v === 'number' ? [] : ['v required']),
    });
    expect(out.value.v).toBe(1);
    expect(out.attempts).toBe(2);
    expect(out.costUsd).toBeCloseTo(30, 6); // two calls, $15 output each
  });
});

describe('createAnthropicLlmClientFromEnv', () => {
  it('returns null when no credential is set', () => {
    expect(createAnthropicLlmClientFromEnv({})).toBeNull();
  });
  it('builds a client when ANTHROPIC_API_KEY is present', () => {
    expect(createAnthropicLlmClientFromEnv({ ANTHROPIC_API_KEY: 'sk-test' })).not.toBeNull();
  });
  it('builds a client from a subscription OAuth token (no API key) — TRA-714', () => {
    // Claude Pro/Max path: ANTHROPIC_AUTH_TOKEN (or CLAUDE_CODE_OAUTH_TOKEN) and
    // no API key is enough to bring the feed live.
    expect(
      createAnthropicLlmClientFromEnv({ ANTHROPIC_AUTH_TOKEN: 'sk-ant-oat01-test' }),
    ).not.toBeNull();
    expect(
      createAnthropicLlmClientFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' }),
    ).not.toBeNull();
  });
  it('configures the SDK client with the bearer token (not x-api-key) on the OAuth path', () => {
    const llm = createAnthropicLlmClientFromEnv({ ANTHROPIC_AUTH_TOKEN: 'sk-ant-oat01-test' });
    // The SDK records the resolved credentials on the client instance: authToken
    // is set and apiKey is null (so only Authorization: Bearer is sent).
    const sdk = (llm as unknown as { client: { apiKey: string | null; authToken: string | null } })
      .client;
    expect(sdk.authToken).toBe('sk-ant-oat01-test');
    expect(sdk.apiKey).toBeNull();
  });
});
