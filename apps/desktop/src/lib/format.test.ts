import { describe, it, expect } from 'vitest';

describe('optionSourceLabel — names the sleeve that actually opened the row', () => {
  it('directional rows reuse relative_value but must not read "Relative Value"', async () => {
    const { optionSourceLabel } = await import('./format');
    expect(optionSourceLabel('relative_value', { journalStructure: 'single_leg_directional' })).toBe('Directional (trend)');
    expect(optionSourceLabel('relative_value', { sleeve: 'directional' })).toBe('Directional (trend)');
  });
  it('true RV and other types are unchanged', async () => {
    const { optionSourceLabel } = await import('./format');
    expect(optionSourceLabel('relative_value', { journalStructure: 'single_leg_rv' })).toBe('Relative Value');
    expect(optionSourceLabel('relative_value')).toBe('Relative Value');
    expect(optionSourceLabel('otm_mispricing', { journalStructure: 'single_leg_directional' })).toBe('OTM Mispricing');
  });
});
