import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetLogSinks, addLogSink, logError, logger, normalizeError } from './logger';

describe('normalizeError', () => {
  it('extracts name, message and stack from an Error', () => {
    const err = new TypeError('boom');
    const norm = normalizeError(err);
    expect(norm.name).toBe('TypeError');
    expect(norm.message).toBe('boom');
    expect(typeof norm.stack).toBe('string');
  });

  it('wraps a string thrown value', () => {
    expect(normalizeError('plain failure')).toEqual({ name: 'NonError', message: 'plain failure' });
  });

  it('serializes a non-error object', () => {
    expect(normalizeError({ code: 42 })).toEqual({ name: 'NonError', message: '{"code":42}' });
  });

  it('falls back to String() for unserializable values', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(normalizeError(circular).name).toBe('NonError');
  });
});

describe('logger sinks', () => {
  afterEach(() => {
    _resetLogSinks();
    vi.restoreAllMocks();
  });

  it('forwards every entry to a registered sink', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: string[] = [];
    addLogSink(entry => seen.push(`${entry.level}:${entry.scope}:${entry.message}`));
    logger.warn('ws', 'socket closed');
    expect(seen).toEqual(['warn:ws:socket closed']);
  });

  it('stops delivering after unsubscribe', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const seen: unknown[] = [];
    const off = addLogSink(entry => seen.push(entry));
    off();
    logger.info('http', 'poll ok');
    expect(seen).toHaveLength(0);
  });

  it('isolates a throwing sink so the caller is not affected', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    addLogSink(() => { throw new Error('sink exploded'); });
    expect(() => logError('close-order', 'failed', new Error('x'))).not.toThrow();
  });

  it('logError normalizes the error into the entry detail', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let captured: unknown;
    addLogSink(entry => { captured = entry.detail; });
    logError('http', 'request failed', new Error('timeout'));
    expect(captured).toMatchObject({ name: 'Error', message: 'timeout' });
  });

  it('writes to the matching console method', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('ws', 'parse failed', { raw: '{' });
    expect(errorSpy).toHaveBeenCalledWith('[ws] parse failed', { raw: '{' });
  });
});
