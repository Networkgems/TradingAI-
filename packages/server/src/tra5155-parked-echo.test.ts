import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(new URL('./signal-engine.ts', import.meta.url), 'utf8');

describe('TRA-5155 — parked-refusal echo is tagged distinctly in the OTM census', () => {
  it('tags a parked token with its origin gate; a fresh duplicate keeps the plain label', () => {
    const at = SRC.indexOf('const otmDedupeWindows = resolveOtmEntryWindows(process.env);');
    const block = SRC.slice(at, at + 2600);
    expect(block).toMatch(/scanRun\.reject\('recent_duplicate'\)/);
    expect(block).toContain('recent_duplicate:parked_echo:${parked.signalSkipReasonCode ?? \'unclassified\'}');
    expect(block).toMatch(/continue;\s*\}/);
  });
});
