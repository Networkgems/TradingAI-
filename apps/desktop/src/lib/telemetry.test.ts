// TRA-413 — tests for the desktop error-telemetry module.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  captureClientError,
  newTraceId,
  getSessionTraceId,
  installTraceHeader,
} from './telemetry';
import { HTTP_URL } from '../server-url';

describe('telemetry (TRA-413)', () => {
  beforeEach(() => {
    // jsdom has no sendBeacon; stub it so delivery is observable and inert.
    Object.defineProperty(navigator, 'sendBeacon', {
      value: vi.fn(() => true),
      configurable: true,
    });
  });

  it('newTraceId returns a unique id each call', () => {
    expect(newTraceId()).not.toBe(newTraceId());
  });

  it('getSessionTraceId is stable within a session', () => {
    expect(getSessionTraceId()).toBe(getSessionTraceId());
  });

  it('captureClientError delivers a text/plain report and returns the trace id', () => {
    const id = captureClientError('unit', new Error('boom'));
    expect(id).toMatch(/^[0-9a-f-]{8,}/i);

    const beacon = navigator.sendBeacon as unknown as ReturnType<typeof vi.fn>;
    expect(beacon).toHaveBeenCalledOnce();
    const [url, blob] = beacon.mock.calls[0] as [string, Blob];
    expect(url).toContain('/api/client-error');
    // text/plain keeps the cross-origin sendBeacon CORS-safelisted (TRA-400).
    expect(blob.type).toBe('text/plain');
  });

  it('captureClientError files under an explicit trace id when given one', () => {
    expect(
      captureClientError('unit', new Error('x'), { traceId: 'explicit-trace-id-0001' }),
    ).toBe('explicit-trace-id-0001');
  });

  it('captureClientError never throws on a non-Error value', () => {
    expect(() => captureClientError('unit', { weird: true })).not.toThrow();
  });

  it('installTraceHeader stamps X-Trace-Id on requests to the server', async () => {
    const seen: Array<{ init?: RequestInit }> = [];
    window.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ init });
      return Promise.resolve({ ok: true } as Response);
    }) as unknown as typeof fetch;

    installTraceHeader();
    await window.fetch(`${HTTP_URL}/api/health`);

    const headers = new Headers(seen[0]?.init?.headers);
    expect(headers.get('X-Trace-Id')).toBe(getSessionTraceId());
  });
});
