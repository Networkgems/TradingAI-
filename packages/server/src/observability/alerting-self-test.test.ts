// TRA-2284 — the ops-alert path's missing failing state.
//
// `/api/health/alerting` reported `channels.email.configured: true` on bqb1 for
// weeks while NO alert had ever been dispatched. That field is
// `isSmtpConfigured() && recipientCount > 0` — credential PRESENCE — so it reads
// identically on a box that mails reliably and on one whose transport is dead.
// `runAlertingSelfTest` is the probe that can actually come back red, and these
// tests pin the ways it must refuse to come back green:
//
//   • no SMTP creds        → NOT delivered (and no send attempted)
//   • empty ALERT_EMAIL    → NOT delivered (`sendOpsAlertEmail` returns silently
//                            in this case, which is the exact false green)
//   • transport throws     → NOT delivered, error surfaced (route answers 502)
//
// plus the two behaviours that keep the probe safe to expose on an auth-gated
// route: it throttles, and it does not burn a real alert key's throttle window.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const sendOpsAlertEmail = vi.fn<(subject: string, text: string) => Promise<void>>();
const isSmtpConfigured = vi.fn<() => boolean>();

vi.mock('../email.js', () => ({
  sendOpsAlertEmail: (subject: string, text: string) => sendOpsAlertEmail(subject, text),
  isSmtpConfigured: () => isSmtpConfigured(),
}));

const {
  runAlertingSelfTest,
  dispatchAlert,
  getRecentAlerts,
  getAlertingPosture,
  __resetAlertsForTest,
} = await import('./alerts.js');

describe('TRA-2284 alerting self-test', () => {
  beforeEach(() => {
    __resetAlertsForTest();
    sendOpsAlertEmail.mockReset();
    sendOpsAlertEmail.mockResolvedValue(undefined);
    isSmtpConfigured.mockReset();
    isSmtpConfigured.mockReturnValue(true);
    process.env['ALERT_EMAIL'] = 'ops@example.com';
  });

  it('delivers through the real transport and records the probe in the ring', async () => {
    const result = await runAlertingSelfTest('cto');

    expect(result.fired).toBe(true);
    expect(result.emailDelivered).toBe(true);
    expect(result.recipientCount).toBe(1);
    expect(result.error).toBeUndefined();
    expect(sendOpsAlertEmail).toHaveBeenCalledTimes(1);

    // The subject must be unmistakable in the ops inbox — a probe that reads
    // like a real incident is a worse instrument than no probe.
    const [subject] = sendOpsAlertEmail.mock.calls[0]!;
    expect(subject).toContain('SELF-TEST');

    // Durable trace: `/api/health/alerting` is no-auth, so a successful probe is
    // independently confirmable from the posture route afterwards.
    expect(getRecentAlerts().at(-1)?.key).toBe('self-test');
    const posture = getAlertingPosture();
    expect(posture.recent.newestKey).toBe('self-test');
    expect(posture.recent.byKey['self-test']).toBe(1);
  });

  it('does NOT report delivery when SMTP is unconfigured', async () => {
    isSmtpConfigured.mockReturnValue(false);

    const result = await runAlertingSelfTest('cto');

    expect(result.fired).toBe(true);
    expect(result.emailDelivered).toBe(false);
    expect(result.smtpConfigured).toBe(false);
    expect(result.error).toMatch(/SMTP/i);
    // Not merely "reported false" — the send is never attempted, so a resolved
    // promise cannot be misread as proof.
    expect(sendOpsAlertEmail).not.toHaveBeenCalled();
  });

  it('does NOT report delivery when ALERT_EMAIL is empty', async () => {
    process.env['ALERT_EMAIL'] = '';

    const result = await runAlertingSelfTest('cto');

    expect(result.fired).toBe(true);
    expect(result.recipientCount).toBe(0);
    expect(result.emailDelivered).toBe(false);
    expect(result.error).toMatch(/ALERT_EMAIL/);
    expect(sendOpsAlertEmail).not.toHaveBeenCalled();
  });

  it('surfaces a transport failure instead of swallowing it', async () => {
    sendOpsAlertEmail.mockRejectedValue(new Error('535 auth failed'));

    const result = await runAlertingSelfTest('cto');

    expect(result.fired).toBe(true);
    expect(result.emailDelivered).toBe(false);
    expect(result.error).toContain('535 auth failed');
  });

  it('throttles a repeat probe without sending again', async () => {
    const first = await runAlertingSelfTest('cto');
    expect(first.fired).toBe(true);

    const second = await runAlertingSelfTest('cto');
    expect(second.fired).toBe(false);
    expect(second.throttledForMs).toBeGreaterThan(0);
    expect(second.emailDelivered).toBe(false);
    expect(second.alert).toBeUndefined();
    expect(sendOpsAlertEmail).toHaveBeenCalledTimes(1);
    // A throttled probe records nothing — the ring still holds exactly one.
    expect(getRecentAlerts().filter(a => a.key === 'self-test')).toHaveLength(1);
  });

  it('does not consume a real alert key’s throttle window', async () => {
    await runAlertingSelfTest('cto');
    // A genuine incident immediately after a probe must still fire; the probe
    // owns its own key precisely so it cannot mask one.
    expect(dispatchAlert('health-check', 'critical', 'simulated outage')).toBe(true);
    expect(getRecentAlerts().map(a => a.key)).toEqual(['self-test', 'health-check']);
  });
});
