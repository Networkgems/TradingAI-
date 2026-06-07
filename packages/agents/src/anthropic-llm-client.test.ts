import { describe, it, expect, vi } from 'vitest';
import {
  AnthropicLlmClient,
  modelAcceptsTemperature,
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
  it('returns null when no key is set', () => {
    expect(createAnthropicLlmClientFromEnv({})).toBeNull();
  });
  it('builds a client when ANTHROPIC_API_KEY is present', () => {
    expect(createAnthropicLlmClientFromEnv({ ANTHROPIC_API_KEY: 'sk-test' })).not.toBeNull();
  });
});
