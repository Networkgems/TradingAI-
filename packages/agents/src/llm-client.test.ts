import { describe, it, expect } from 'vitest';
import { validateAnalystReport, type AnalystReport } from '@trading-app/shared';
import {
  StubLlmClient,
  completeJson,
  extractJson,
  LlmSchemaError,
  type LlmCompletionRequest,
} from './llm-client.js';

const req: LlmCompletionRequest = {
  tier: 'fast',
  purpose: 'test',
  messages: [{ role: 'user', content: 'emit an AnalystReport' }],
};

const validReport: AnalystReport = {
  kind: 'technical',
  stance: 0.3,
  confidence: 0.6,
  horizonDays: 5,
  keyLevels: { support: 90, resistance: 110 },
  drivers: ['ok'],
  notes: 'fine',
};

describe('extractJson', () => {
  it('unwraps a ```json fenced block', () => {
    expect(JSON.parse(extractJson('```json\n{"a":1}\n```'))).toEqual({ a: 1 });
  });
  it('pulls a balanced object out of surrounding prose', () => {
    expect(JSON.parse(extractJson('Sure! {"a":{"b":2}} hope that helps'))).toEqual({ a: { b: 2 } });
  });
});

describe('completeJson (TRA-529 §3 schema-validate + retry)', () => {
  it('returns the parsed value on the first valid response', async () => {
    const llm = new StubLlmClient(() => JSON.stringify(validReport));
    const out = await completeJson<AnalystReport>(llm, req, { validate: validateAnalystReport });
    expect(out.value.stance).toBe(0.3);
    expect(out.attempts).toBe(1);
    expect(out.costUsd).toBe(0);
    expect(llm.requests).toHaveLength(1);
  });

  it('retries malformed JSON then succeeds, feeding the error back to the model', async () => {
    const llm = new StubLlmClient((_r, i) => (i === 0 ? 'not json at all' : JSON.stringify(validReport)));
    const out = await completeJson<AnalystReport>(llm, req, { validate: validateAnalystReport });
    expect(out.attempts).toBe(2);
    // The retry prompt must carry the model's bad answer + a correction.
    expect(llm.requests).toHaveLength(2);
    const retried = llm.requests[1]!.messages;
    expect(retried.some(m => m.role === 'assistant' && m.content === 'not json at all')).toBe(true);
    expect(retried.some(m => m.role === 'user' && /schema validator/i.test(m.content))).toBe(true);
  });

  it('retries schema-invalid JSON (out-of-range stance) then succeeds', async () => {
    const bad = JSON.stringify({ ...validReport, stance: 9 });
    const llm = new StubLlmClient((_r, i) => (i === 0 ? bad : JSON.stringify(validReport)));
    const out = await completeJson<AnalystReport>(llm, req, { validate: validateAnalystReport });
    expect(out.attempts).toBe(2);
    expect(llm.requests[1]!.messages.some(m => /stance/.test(m.content))).toBe(true);
  });

  it('throws LlmSchemaError after exhausting attempts', async () => {
    const llm = new StubLlmClient(() => '{"broken":true}');
    await expect(
      completeJson<AnalystReport>(llm, req, { validate: validateAnalystReport, maxAttempts: 2 }),
    ).rejects.toBeInstanceOf(LlmSchemaError);
    expect(llm.requests).toHaveLength(2);
  });
});
