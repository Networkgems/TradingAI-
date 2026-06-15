import { describe, it, expect, vi } from 'vitest';
import { executeCommand, KILL_SWITCH_NOTICE, HELP_TEXT, type CommandContext, type RecommendationSummary } from './command-router.js';
import { parseCommand } from './command-parser.js';

function ctx(over: Partial<CommandContext> = {}): CommandContext {
  return {
    killSwitchEngaged: false,
    status: () => 'STATUS-BLOCK',
    scan: () => 'SCAN-BLOCK',
    positions: () => 'POSITIONS-BLOCK',
    pendingRecommendations: () => [],
    approve: () => ({ ok: true, message: 'approved' }),
    reject: () => ({ ok: true, message: 'rejected' }),
    ...over,
  };
}

async function run(text: string, over: Partial<CommandContext> = {}): Promise<string> {
  const cmd = parseCommand(text);
  if (!cmd) throw new Error(`parse returned null for ${text}`);
  return executeCommand(cmd, ctx(over));
}

describe('TRA-848 command router', () => {
  it('routes read commands to the matching accessor', async () => {
    expect(await run('status')).toBe('STATUS-BLOCK');
    expect(await run('scan')).toBe('SCAN-BLOCK');
    expect(await run('positions')).toBe('POSITIONS-BLOCK');
    expect(await run('help')).toBe(HELP_TEXT);
  });

  it('brief stitches status + scan + pending approvals', async () => {
    const recos: RecommendationSummary[] = [
      { id: 'agent-AAPL-1', symbol: 'AAPL', verdict: 'APPROVE', action: 'BUY', conviction: 0.72 },
    ];
    const out = await run('brief', { pendingRecommendations: () => recos });
    expect(out).toContain('STATUS-BLOCK');
    expect(out).toContain('SCAN-BLOCK');
    expect(out).toContain('agent-AAPL-1');
    expect(out).toContain('AAPL APPROVE/BUY');
    expect(out).toContain('72%');
  });

  it('brief reports "none" when there are no pending approvals', async () => {
    expect(await run('brief')).toContain('Pending approvals: none.');
  });

  it('calls approve with the parsed target and returns its message', async () => {
    const approve = vi.fn(() => ({ ok: true, message: 'routed AAPL order' }));
    const out = await run('approve agent-AAPL-9', { approve });
    expect(approve).toHaveBeenCalledWith('agent-AAPL-9');
    expect(out).toBe('routed AAPL order');
  });

  it('calls reject with the parsed target and returns its message', async () => {
    const reject = vi.fn(() => ({ ok: true, message: 'dropped TSLA' }));
    const out = await run('reject TSLA', { reject });
    expect(reject).toHaveBeenCalledWith('TSLA');
    expect(out).toBe('dropped TSLA');
  });

  it('awaits an async approve action', async () => {
    const approve = vi.fn(async () => ({ ok: true, message: 'async-routed' }));
    expect(await run('approve AAPL', { approve })).toBe('async-routed');
  });

  it('refuses approve/reject when the kill switch is engaged but still reads', async () => {
    const approve = vi.fn(() => ({ ok: true, message: 'should not happen' }));
    const reject = vi.fn(() => ({ ok: true, message: 'should not happen' }));
    expect(await run('approve AAPL', { killSwitchEngaged: true, approve })).toBe(KILL_SWITCH_NOTICE);
    expect(await run('reject AAPL', { killSwitchEngaged: true, reject })).toBe(KILL_SWITCH_NOTICE);
    expect(approve).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
    // read still works under the kill switch
    expect(await run('status', { killSwitchEngaged: true })).toBe('STATUS-BLOCK');
  });

  it('replies with help for an unknown verb', async () => {
    const cmd = parseCommand('frobnicate');
    const out = await executeCommand(cmd!, ctx());
    expect(out).toContain('Unknown command "frobnicate"');
    expect(out).toContain('approve');
  });
});
