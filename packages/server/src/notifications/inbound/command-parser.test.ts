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
