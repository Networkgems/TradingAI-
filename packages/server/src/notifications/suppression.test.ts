// TRA-2416 — a suppressed notification recipient is a THIRD disposition:
// neither `delivered` nor `failed`.
//
// TRA-2356 closed the three user-addressed transport paths (welcome / reset /
// OTP). This closes the dispatcher path, which is the one that SCALES:
// `DEFAULT_ALERT_PREFERENCES` ships `channels.email.enabled: true` with
// fill/exit/risk_halt/briefing all `email: true`, so every fixture book is
// already opted in. The bounce count is only ~8/day because the dispatch path
// has never executed (TRA-2284's finding) — an empirical zero held down by a
// dormant caller, which expires the moment someone fixes the caller.
//
// Two failing states this file exists to keep visible:
//
//   1. A suppression gate that is too WIDE reads EXACTLY like one that works —
//      "no bounce arrived" is satisfied just as well by "we stopped mailing
//      everyone". Every suppression assertion below is therefore paired with a
//      negative control on a real address through the SAME call.
//   2. A suppressed send that RESOLVES reads exactly like a delivered one. The
//      dispatcher's ledger is throw-vs-resolve, and `POST
//      /api/notifications/report/test` reports a channel as `delivered`
//      precisely when `send` resolves — so silently resolving would manufacture
//      a false green inside the surface TRA-2284 grades. The suppression
//      assertions below check that `send` was NOT CALLED, not merely that it
//      did not throw.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_ALERT_PREFERENCES,
  type AccountSettings,
  type AlertChannel,
  type AlertPreferences,
} from '@trading-app/shared';
import {
  NotificationDispatcher,
  channelSuppressionReason,
  type AlertEvent,
  type ChannelAdapter,
} from './dispatcher.js';
import { EmailChannelAdapter } from './channels/email.js';

process.env['LOG_NO_FILE'] = '1';

const tick = () => new Promise((r) => setTimeout(r, 0));

const FIXTURE = 'ctoverify_tra2284@qa.test';
const REAL = 'trader@example.com';

const fillEvent: AlertEvent = {
  kind: 'fill',
  username: 'ctoverify_tra2284',
  timestamp: Date.parse('2026-07-26T18:00:00Z'),
  symbol: 'AAPL',
  market: 'stocks',
  mode: 'demo',
  side: 'buy',
  quantity: 10,
  price: 210.5,
};

function prefs(mutate: (p: AlertPreferences) => void = () => {}): AlertPreferences {
  const p = structuredClone(DEFAULT_ALERT_PREFERENCES);
  p.quietHours.enabled = false;
  for (const ch of ['email', 'telegram', 'discord'] as AlertChannel[]) {
    p.channels[ch].enabled = true;
  }
  for (const ev of Object.keys(p.events) as (keyof typeof p.events)[]) {
    p.events[ev] = { email: true, telegram: true, discord: true };
  }
  mutate(p);
  return p;
}

// ── Part A — the predicate ──────────────────────────────────────────────────

describe('EmailChannelAdapter.suppressionReason', () => {
  const adapterFor = (loginEmail: string | undefined) =>
    new EmailChannelAdapter({
      smtpConfigured: () => true,
      resolveLoginEmail: () => loginEmail,
      sendMail: async () => {},
    });

  it('suppresses a fixture LOGIN email', () => {
    expect(adapterFor(FIXTURE).suppressionReason(fillEvent, prefs())).toBe(
      'test_account_recipient',
    );
  });

  it('CONTROL — does NOT suppress a real login email', () => {
    expect(adapterFor(REAL).suppressionReason(fillEvent, prefs())).toBeUndefined();
  });

  it('CONTROL — a fixture book with a REAL per-channel override is NOT suppressed', () => {
    // The documented escape hatch. `resolveAddress` prefers the override, and
    // suppression keys off the RESOLVED address — so a fixture account can still
    // prove the mail path end-to-end. TRA-2284's grading routine probes
    // `ctoverify_tra2284`; without this branch, deploying the gate would make the
    // mail path ungradeable by the very instrument that grades it.
    const p = prefs((x) => {
      x.channels.email.emailAddress = REAL;
    });
    expect(adapterFor(FIXTURE).suppressionReason(fillEvent, p)).toBeUndefined();
  });

  it('suppresses a REAL book whose override points at a fixture address', () => {
    // The mirror of the case above, and the reason this is address-keyed rather
    // than `isTestAccount(username)`-keyed: the harm is NXDOMAIN, a property of
    // the address, not of the book.
    const p = prefs((x) => {
      x.channels.email.emailAddress = FIXTURE;
    });
    expect(adapterFor(REAL).suppressionReason(fillEvent, p)).toBe('test_account_recipient');
  });

  it('CONTROL — the rule is a SUFFIX, not a substring', () => {
    expect(adapterFor('qa.test.user@example.com').suppressionReason(fillEvent, prefs())).toBe(
      undefined,
    );
  });

  it('CONTROL — an UNRESOLVABLE address is not suppressed (it is a genuine failure)', () => {
    // Must stay in the FAILED ledger, not the suppressed one: "we have no address
    // for this user" is a bug to fix, and hiding it as an intentional refusal is
    // exactly the false-green shape this issue is about.
    expect(adapterFor(undefined).suppressionReason(fillEvent, prefs())).toBeUndefined();
  });
});

// ── Part B — the dispatcher's third disposition ─────────────────────────────

/** Adapter that records sends; no `suppressionReason` — the cross-channel control. */
class RecordingAdapter implements ChannelAdapter {
  readonly sent: AlertEvent[] = [];
  constructor(readonly channel: AlertChannel) {}
  isConfigured(): boolean {
    return true;
  }
  async send(event: AlertEvent): Promise<void> {
    this.sent.push(event);
  }
}

describe('NotificationDispatcher — suppressed channels', () => {
  const lines: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
  const rec = (level: string) => (msg: string, fields: Record<string, unknown> = {}) =>
    void lines.push({ level, msg, fields });
  const fakeLogger = {
    child: () => ({
      info: rec('info'),
      warn: rec('warn'),
      error: rec('error'),
      debug: rec('debug'),
    }),
  };
  const said = (msg: string) => lines.some((l) => l.msg === msg);

  const sendMail = vi.fn(async (_o: { to: string; subject: string; text: string }) => {});

  function build(loginEmail: string | undefined, p: AlertPreferences) {
    const email = new EmailChannelAdapter({
      smtpConfigured: () => true,
      resolveLoginEmail: () => loginEmail,
      sendMail,
    });
    const discord = new RecordingAdapter('discord');
    const d = new NotificationDispatcher({
      loadSettings: (): AccountSettings => ({ alertPreferences: p }) as AccountSettings,
      logger: fakeLogger as never,
    });
    d.registerAdapter(email);
    d.registerAdapter(discord);
    return { d, discord };
  }

  beforeEach(() => {
    lines.length = 0;
    sendMail.mockClear();
  });

  it('does not hand a fixture address to the transport, but still delivers other channels', async () => {
    const { d, discord } = build(FIXTURE, prefs());
    d.emit(fillEvent);
    await tick();

    // Suppressed: the transport was never called at all.
    expect(sendMail).not.toHaveBeenCalled();
    // CROSS-CHANNEL CONTROL — a gate that stopped "everything" would also have
    // silenced Discord, and would read identically on the email assertion alone.
    expect(discord.sent).toHaveLength(1);
  });

  it('CONTROL — a real address IS handed to the transport', async () => {
    const { d, discord } = build(REAL, prefs());
    d.emit({ ...fillEvent, username: 'alice' });
    await tick();

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0]?.[0].to).toBe(REAL);
    expect(discord.sent).toHaveLength(1);
  });

  it('records suppression as its OWN state — not delivered, not failed', async () => {
    const { d } = build(FIXTURE, prefs());
    d.emit(fillEvent);
    await tick();

    const line = lines.find((l) => l.msg === 'alert channels suppressed');
    expect(line?.fields['disposition']).toBe('suppressed');
    expect(line?.fields['suppressed']).toEqual(['email:test_account_recipient']);
    // Neither of the two pre-existing ledgers may claim it.
    expect(said('alert channel send failed')).toBe(false);
    expect(lines.find((l) => l.msg === 'dispatching alert')?.fields['channels']).toEqual([
      'discord',
    ]);
  });

  it('distinguishes "everything suppressed" from "nothing configured"', async () => {
    // Same silence, different causes — and conflating them is how a too-wide gate
    // reads exactly like a working one.
    const emailOnly = prefs((p) => {
      p.channels.discord.enabled = false;
      p.channels.telegram.enabled = false;
    });
    const { d } = build(FIXTURE, emailOnly);
    d.emit(fillEvent);
    await tick();

    expect(said('alert fully suppressed — no channel attempted')).toBe(true);
    expect(said('alert has no eligible channels')).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('a THROWING suppression predicate attempts the send (fails open to a visible red)', async () => {
    // Failing the other way would silently stop real users' mail on a transient
    // fault — the too-wide gate again. Attempting instead surfaces the same fault
    // as a channel FAILURE, because send() re-resolves and hits it too.
    const boom = new EmailChannelAdapter({
      smtpConfigured: () => true,
      resolveLoginEmail: () => REAL,
      sendMail,
    });
    boom.suppressionReason = () => {
      throw new Error('user store unavailable');
    };
    const d = new NotificationDispatcher({
      loadSettings: (): AccountSettings => ({ alertPreferences: prefs() }) as AccountSettings,
      logger: fakeLogger as never,
    });
    d.registerAdapter(boom);
    d.emit({ ...fillEvent, username: 'alice' });
    await tick();

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(said('suppression check errored — attempting the send')).toBe(true);
    expect(said('alert channels suppressed')).toBe(false);
  });
});

// ── Part C — the shared helper ──────────────────────────────────────────────

describe('channelSuppressionReason', () => {
  it('an adapter with no implementation is never suppressed', () => {
    const verdict = channelSuppressionReason(new RecordingAdapter('discord'), fillEvent, prefs());
    expect(verdict).toEqual({});
  });

  it('reports a thrown predicate as `errored`, never as a reason', () => {
    const a = new RecordingAdapter('discord') as ChannelAdapter;
    a.suppressionReason = () => {
      throw new Error('nope');
    };
    const verdict = channelSuppressionReason(a, fillEvent, prefs());
    expect(verdict.reason).toBeUndefined();
    expect(verdict.errored).toBe('nope');
  });
});
