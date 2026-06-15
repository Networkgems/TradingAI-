import { describe, it, expect } from 'vitest';
import { parseCommand } from './command-parser.js';

describe('TRA-848 inbound command parser', () => {
  it('returns null for empty / whitespace / nullish text', () => {
    expect(parseCommand(undefined)).toBeNull();
    expect(parseCommand(null)).toBeNull();
    expect(parseCommand('')).toBeNull();
    expect(parseCommand('   ')).toBeNull();
  });

  it('parses the read verbs with or without a leading slash, case-insensitively', () => {
    expect(parseCommand('status')).toEqual({ kind: 'status' });
    expect(parseCommand('/status')).toEqual({ kind: 'status' });
    expect(parseCommand('  STATUS  ')).toEqual({ kind: 'status' });
    expect(parseCommand('Scan')).toEqual({ kind: 'scan' });
    expect(parseCommand('/brief')).toEqual({ kind: 'brief' });
    expect(parseCommand('positions')).toEqual({ kind: 'positions' });
    expect(parseCommand('pos')).toEqual({ kind: 'positions' });
    expect(parseCommand('help')).toEqual({ kind: 'help' });
    expect(parseCommand('commands')).toEqual({ kind: 'help' });
  });

  it('tolerates @botname group-addressing suffixes', () => {
    expect(parseCommand('/status@TradeAIbot')).toEqual({ kind: 'status' });
    expect(parseCommand('approve@TradeAIbot agent-AAPL-123')).toEqual({
      kind: 'approve',
      target: 'agent-AAPL-123',
    });
  });

  it('parses approve/reject with a target id or symbol', () => {
    expect(parseCommand('approve agent-AAPL-1700000000000')).toEqual({
      kind: 'approve',
      target: 'agent-AAPL-1700000000000',
    });
    expect(parseCommand('/reject TSLA')).toEqual({ kind: 'reject', target: 'TSLA' });
    // synonyms
    expect(parseCommand('ok AAPL')).toEqual({ kind: 'approve', target: 'AAPL' });
    expect(parseCommand('yes AAPL')).toEqual({ kind: 'approve', target: 'AAPL' });
    expect(parseCommand('no AAPL')).toEqual({ kind: 'reject', target: 'AAPL' });
    expect(parseCommand('veto AAPL')).toEqual({ kind: 'reject', target: 'AAPL' });
  });

  it('only takes the first token of a multi-word approve/reject arg', () => {
    expect(parseCommand('approve AAPL please now')).toEqual({
      kind: 'approve',
      target: 'AAPL',
    });
  });

  it('treats approve/reject with no target as unknown (so the caller can show help)', () => {
    expect(parseCommand('approve')).toEqual({ kind: 'unknown', verb: 'approve' });
    expect(parseCommand('/reject   ')).toEqual({ kind: 'unknown', verb: 'reject' });
  });

  it('routes /start to null so the linking flow owns the token', () => {
    expect(parseCommand('/start abc123')).toBeNull();
    expect(parseCommand('start')).toBeNull();
  });

  it('returns an unknown command for unrecognized verbs', () => {
    expect(parseCommand('frobnicate')).toEqual({ kind: 'unknown', verb: 'frobnicate' });
    expect(parseCommand('/foo bar')).toEqual({ kind: 'unknown', verb: 'foo' });
  });
});

describe('TRA-851 routine commands', () => {
  it('lists with the bare plural or "routine list"', () => {
    expect(parseCommand('routines')).toEqual({ kind: 'routine_list' });
    expect(parseCommand('routine')).toEqual({ kind: 'routine_list' });
    expect(parseCommand('routine list')).toEqual({ kind: 'routine_list' });
    expect(parseCommand('/routine ls')).toEqual({ kind: 'routine_list' });
  });

  it('adds via the explicit "add" subcommand', () => {
    expect(parseCommand('routine add brief me at 8:30')).toEqual({
      kind: 'routine_add',
      spec: 'brief me at 8:30',
    });
  });

  it('adds via a bare natural-language phrase after "routine"', () => {
    expect(parseCommand('routine scan semis daily')).toEqual({
      kind: 'routine_add',
      spec: 'scan semis daily',
    });
  });

  it('treats remind/every/schedule as NL routine adds', () => {
    expect(parseCommand('schedule brief me at 8:30')).toEqual({
      kind: 'routine_add',
      spec: 'brief me at 8:30',
    });
    expect(parseCommand('every day at 8:30 brief me')).toEqual({
      kind: 'routine_add',
      spec: 'day at 8:30 brief me',
    });
    expect(parseCommand('remind me to scan semis at 9')).toEqual({
      kind: 'routine_add',
      spec: 'me to scan semis at 9',
    });
  });

  it('removes / toggles by id', () => {
    expect(parseCommand('routine remove r2')).toEqual({ kind: 'routine_remove', target: 'r2' });
    expect(parseCommand('routine rm r2')).toEqual({ kind: 'routine_remove', target: 'r2' });
    expect(parseCommand('routine off r1')).toEqual({
      kind: 'routine_toggle',
      target: 'r1',
      enabled: false,
    });
    expect(parseCommand('routine on r1')).toEqual({
      kind: 'routine_toggle',
      target: 'r1',
      enabled: true,
    });
  });

  it('flags a remove/toggle with no id as unknown', () => {
    expect(parseCommand('routine remove')).toEqual({ kind: 'unknown', verb: 'routine remove' });
    expect(parseCommand('routine off')).toEqual({ kind: 'unknown', verb: 'routine off' });
  });
});
