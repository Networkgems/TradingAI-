import { describe, it, expect, vi } from 'vitest';
import { selectDueRoutines, RoutineRunner, type RoutineRunnerDeps } from './routine-runner.js';
import type { StoredRoutine } from './routine-store.js';

function routine(over: Partial<StoredRoutine> = {}): StoredRoutine {
  return {
    id: 'r1',
    raw: 'brief me at 8:30',
    action: 'brief',
    timeEt: '08:30',
    marketDaysOnly: true,
    enabled: true,
    createdAt: '2026-06-14T00:00:00Z',
    ...over,
  };
}

describe('TRA-851 selectDueRoutines', () => {
  it('fires only routines whose time matches', () => {
    const rs = [routine({ id: 'r1', timeEt: '08:30' }), routine({ id: 'r2', timeEt: '09:00' })];
    expect(selectDueRoutines(rs, '08:30', true).map((r) => r.id)).toEqual(['r1']);
  });

  it('skips disabled routines', () => {
    const rs = [routine({ enabled: false })];
    expect(selectDueRoutines(rs, '08:30', true)).toHaveLength(0);
  });

  it('skips market-day-only routines on a non-trading day', () => {
    const rs = [routine({ marketDaysOnly: true }), routine({ id: 'r2', marketDaysOnly: false })];
    expect(selectDueRoutines(rs, '08:30', false).map((r) => r.id)).toEqual(['r2']);
  });
});

function deps(over: Partial<RoutineRunnerDeps> = {}): RoutineRunnerDeps {
  return {
    nowEt: { hour: 8, minute: 30, date: '2026-06-15' },
    isMarketDay: () => true,
    users: () => ['alice'],
    listRoutines: () => [routine()],
    execute: async () => ({ title: 'Routine: morning brief', body: 'body' }),
    emit: vi.fn(),
    ...over,
  };
}

describe('TRA-851 RoutineRunner.tick', () => {
  it('executes + emits a due routine once', async () => {
    const emit = vi.fn();
    const runner = new RoutineRunner();
    await runner.tick(deps({ emit }));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![2]).toEqual({ title: 'Routine: morning brief', body: 'body' });
  });

  it('does not re-fire the same routine on a later tick the same ET day', async () => {
    const emit = vi.fn();
    const runner = new RoutineRunner();
    const d = deps({ emit });
    await runner.tick(d);
    await runner.tick(d); // second poll lands on the same minute
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('fires again on a new ET day', async () => {
    const emit = vi.fn();
    const runner = new RoutineRunner();
    await runner.tick(deps({ emit, nowEt: { hour: 8, minute: 30, date: '2026-06-15' } }));
    await runner.tick(deps({ emit, nowEt: { hour: 8, minute: 30, date: '2026-06-16' } }));
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('does not emit when the executor returns null (no active session)', async () => {
    const emit = vi.fn();
    const runner = new RoutineRunner();
    await runner.tick(deps({ emit, execute: async () => null }));
    expect(emit).not.toHaveBeenCalled();
  });

  it('isolates a throwing routine from the rest', async () => {
    const emit = vi.fn();
    const runner = new RoutineRunner();
    await runner.tick(
      deps({
        emit,
        listRoutines: () => [routine({ id: 'r1' }), routine({ id: 'r2', timeEt: '08:30' })],
        execute: async (_u, r) => {
          if (r.id === 'r1') throw new Error('boom');
          return { title: 't', body: 'b' };
        },
      }),
    );
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![1].id).toBe('r2');
  });
});
