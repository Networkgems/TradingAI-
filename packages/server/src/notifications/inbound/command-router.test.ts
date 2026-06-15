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
    listRoutines: () => [],
    addRoutine: () => ({ ok: true, message: 'added' }),
    removeRoutine: () => ({ ok: true, message: 'removed' }),
    setRoutineEnabled: () => ({ ok: true, message: 'toggled' }),
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

  it('lists routines, or nudges when there are none', async () => {
    expect(await run('routines')).toContain('No routines.');
    const out = await run('routines', {
      listRoutines: () => [
        { id: 'r1', action: 'brief', timeEt: '08:30', filter: 'all', enabled: true, marketDaysOnly: true },
        { id: 'r2', action: 'scan', timeEt: '09:30', filter: 'semis', enabled: false, marketDaysOnly: true },
      ],
    });
    expect(out).toContain('r1  brief @ 08:30 ET (market days)');
    expect(out).toContain('r2  scan semis @ 09:30 ET (market days) [off]');
  });

  it('adds a routine via the injected accessor and returns its message', async () => {
    const addRoutine = vi.fn(async () => ({ ok: true, message: 'Scheduled r1: brief @ 08:30 ET (market days)' }));
    const out = await run('routine brief me at 8:30', { addRoutine });
    expect(addRoutine).toHaveBeenCalledWith('brief me at 8:30');
    expect(out).toContain('Scheduled r1');
  });

  it('removes / toggles a routine through the accessors', async () => {
    const removeRoutine = vi.fn(async () => ({ ok: true, message: 'Removed routine r2.' }));
    const setRoutineEnabled = vi.fn(async () => ({ ok: true, message: 'Routine r1 disabled.' }));
    expect(await run('routine remove r2', { removeRoutine })).toBe('Removed routine r2.');
    expect(removeRoutine).toHaveBeenCalledWith('r2');
    expect(await run('routine off r1', { setRoutineEnabled })).toBe('Routine r1 disabled.');
    expect(setRoutineEnabled).toHaveBeenCalledWith('r1', false);
  });

  it('replies "not available" when a routine accessor is unwired', async () => {
    const cmd = parseCommand('routine brief me at 8:30')!;
    const bare = ctx();
    delete (bare as Partial<CommandContext>).addRoutine;
    expect(await executeCommand(cmd, bare)).toBe('Routines are not available on this session.');
  });
});
