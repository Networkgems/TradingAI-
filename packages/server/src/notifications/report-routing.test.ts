// TRA-2416 (follow-up) — the routing decision behind `POST
// /api/notifications/report/test`.
//
// TRA-2416 shipped the third disposition through the dispatcher, where it is
// mutation-verified, and stated a known gap on the issue rather than papering
// over it: the ROUTE that reports it lived inline in `index.ts`, which has no
// route-test harness. This file closes that gap. `resolveReportRouting` now owns
// the decision; the route only maps a verdict onto a status code.
//
// Two failing states this file exists to keep visible — same shape as
// `suppression.test.ts`, deliberately:
//
//   1. A suppression gate that is too WIDE reads EXACTLY like one that works.
//      Every suppression assertion is paired with a negative control through the
//      SAME call — including a CROSS-CHANNEL control, because a gate that killed
//      "everything" would satisfy the email assertion on its own.
//   2. `wouldScheduledDeliver` gating on `eligible` instead of `attempted` reads
//      IDENTICALLY on a healthy account and answers "yes, the 21:00 run
//      delivers" for a book that will never receive anything. That boolean is
//      what TRA-2284's mail-track grade is read off, so it gets its own mutant.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ALERT_PREFERENCES,
  type AlertChannel,
  type AlertPreferences,
} from '@trading-app/shared';
import type { AlertEvent, ChannelAdapter } from './dispatcher.js';
import {
  resolveReportRouting,
  REPORT_ROUTING_BLOCKED_MESSAGE,
  type ReportRoutingInput,
} from './report-routing.js';
import { EmailChannelAdapter } from './channels/email.js';

process.env['LOG_NO_FILE'] = '1';

const FIXTURE = 'ctoverify_tra2284@qa.test';
const REAL = 'trader@example.com';

const reportEvent: AlertEvent = {
  kind: 'report',
  username: 'ctoverify_tra2284',
  timestamp: Date.parse('2026-07-26T21:00:00Z'),
  cadence: 'weekly',
  periodLabel: 'Weekly — 2026-07-20 to 2026-07-26',
  periodStart: '2026-07-20',
  periodEnd: '2026-07-26',
  stats: {
    totalPnl: 125.5,
    stockPnl: 125.5,
    optionsPnl: 0,
    totalTrades: 4,
    tradingDays: 5,
    winDays: 3,
    lossDays: 2,
    startEquity: 100_000,
    endEquity: 100_125.5,
  },
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

/** Configured, always deliverable, no `suppressionReason` — the cross-channel control. */
class PlainAdapter implements ChannelAdapter {
  constructor(
    readonly channel: AlertChannel,
    private readonly configured = true,
  ) {}
  isConfigured(): boolean {
    return this.configured;
  }
  async send(): Promise<void> {}
}

const emailAdapter = (loginEmail: string | undefined) =>
  new EmailChannelAdapter({
    smtpConfigured: () => true,
    resolveLoginEmail: () => loginEmail,
    sendMail: async () => {},
  });

/** Default scenario: at a real period end, quiet hours off, email + discord live. */
function routing(
  loginEmail: string | undefined,
  over: Partial<ReportRoutingInput> = {},
  mutatePrefs: (p: AlertPreferences) => void = () => {},
) {
  return resolveReportRouting({
    adapters: { email: emailAdapter(loginEmail), discord: new PlainAdapter('discord') },
    event: reportEvent,
    prefs: prefs(mutatePrefs),
    quietHoursActive: false,
    atPeriodEnd: true,
    ...over,
  });
}

// ── The third disposition, and its paired controls ──────────────────────────

describe('resolveReportRouting — suppression is its own state', () => {
  it('reports a fixture recipient as SUPPRESSED, and drops it from `attempted`', () => {
    const { routing: r } = routing(FIXTURE);

    expect(r.suppressed).toContainEqual({ channel: 'email', reason: 'test_account_recipient' });
    // `eligible` still contains it — it IS routed and configured. The whole
    // point is that eligibility and attemptability are different questions.
    expect(r.eligible).toContain('email');
    expect(r.attempted).not.toContain('email');
    // Deliberately `toContainEqual` and not `toEqual([...])`: an exact-array
    // assertion here would ALSO fail under the always-suppress mutant, which
    // would merge this suppression assertion into the control set and destroy
    // the property that makes the mutation record readable — the two kill sets
    // must stay DISJOINT, or a run cannot tell a dead gate from a too-wide one.
  });

  it('CONTROL — a real login email is attempted, and nothing is suppressed', () => {
    const { verdict, routing: r } = routing(REAL);

    expect(verdict).toBe('attempt');
    expect(r.attempted).toContain('email');
    expect(r.suppressed).toEqual([]);
  });

  it('CROSS-CHANNEL CONTROL — Discord still runs on the fan-out where email is refused', () => {
    // A gate that stopped "everything" passes the email assertion above on its
    // own. This is the assertion it cannot pass.
    const { verdict, routing: r } = routing(FIXTURE);

    expect(verdict).toBe('attempt');
    expect(r.attempted).toContain('discord');
    expect(r.wouldScheduledDeliver).toBe(true);
  });

  it('CONTROL — a fixture book with a REAL per-channel override is attempted', () => {
    // The load-bearing escape hatch: TRA-2284's grading routine probes
    // `ctoverify_tra2284`, a fixture. Without this branch the gate would make
    // the mail path ungradeable by the instrument that grades it.
    const { verdict, routing: r } = routing(FIXTURE, {}, p => {
      p.channels.email.emailAddress = REAL;
    });

    expect(verdict).toBe('attempt');
    expect(r.attempted).toContain('email');
    expect(r.suppressed).toEqual([]);
  });

  it('CONTROL — an UNRESOLVABLE address is NOT suppressed (it stays a real failure)', () => {
    // "We have no address for this user" is a bug to fix. Filing it as an
    // intentional refusal is exactly the false-green this issue is about — it
    // would leave `attempted` empty and read as `all_channels_suppressed`.
    const { routing: r } = routing(undefined);

    expect(r.suppressed).toEqual([]);
    expect(r.attempted).toContain('email');
  });

  it('a throwing predicate FAILS OPEN to the send, never to a silent drop', () => {
    const exploding: ChannelAdapter = {
      channel: 'email',
      isConfigured: () => true,
      suppressionReason: () => {
        throw new Error('lookup blew up');
      },
      send: async () => {},
    };
    const { verdict, routing: r } = routing(FIXTURE, {
      adapters: { email: exploding },
    });

    // Suppressing on error would silently kill a real user's mail on a transient
    // fault — the too-wide gate. Attempting surfaces the same fault as a visible
    // channel FAILURE, because `send` re-resolves and hits it again.
    expect(verdict).toBe('attempt');
    expect(r.attempted).toEqual(['email']);
    expect(r.suppressed).toEqual([]);
  });
});

// ── The three "emits nothing" outcomes must stay distinguishable ─────────────

describe('resolveReportRouting — verdicts', () => {
  it('all_channels_suppressed when every routed channel is refused by design', () => {
    const { verdict, routing: r } = routing(FIXTURE, {
      adapters: { email: emailAdapter(FIXTURE) },
    });

    expect(verdict).toBe('all_channels_suppressed');
    expect(r.attempted).toEqual([]);
    expect(r.suppressed).toEqual([{ channel: 'email', reason: 'test_account_recipient' }]);
    expect(r.wouldScheduledDeliver).toBe(false);
  });

  it('no_eligible_channel when nothing is routed — and it is DISCRIMINABLE from suppression', () => {
    // Both emit nothing and both are a 409. The discriminator is `suppressed[]`:
    // misconfiguration leaves it empty, refusal-by-design does not. A grader
    // that keys on `attempted.length === 0` alone cannot tell "fix your
    // settings" from "this account can never grade mail".
    const { verdict, routing: r } = routing(REAL, {}, p => {
      p.channels.email.enabled = false;
      p.channels.discord.enabled = false;
      p.channels.telegram.enabled = false;
    });

    expect(verdict).toBe('no_eligible_channel');
    expect(r.eligible).toEqual([]);
    expect(r.attempted).toEqual([]);
    expect(r.suppressed).toEqual([]);
  });

  it('an unconfigured adapter is not eligible, and an absent one is skipped', () => {
    const { verdict, routing: r } = routing(REAL, {
      adapters: { email: new PlainAdapter('email', false) },
    });

    expect(verdict).toBe('no_eligible_channel');
    expect(r.eligible).toEqual([]);
  });

  it('the report CLASS routes it — an account opted out of report mail is not eligible', () => {
    const { routing: r } = routing(REAL, {}, p => {
      p.events.report.email = false;
    });

    expect(r.eligible).not.toContain('email');
    expect(r.eligible).toContain('discord');
  });

  it('the two blocked verdicts carry distinct operator text naming the remedy', () => {
    expect(REPORT_ROUTING_BLOCKED_MESSAGE.all_channels_suppressed).not.toBe(
      REPORT_ROUTING_BLOCKED_MESSAGE.no_eligible_channel,
    );
    // The suppressed message must name the call that unblocks it — that is the
    // documented way a fixture book still proves the mail path.
    expect(REPORT_ROUTING_BLOCKED_MESSAGE.all_channels_suppressed).toContain(
      'PUT /api/account/notifications',
    );
  });
});

// ── wouldScheduledDeliver — the boolean the mail-track grade is read off ─────

describe('resolveReportRouting — wouldScheduledDeliver', () => {
  it('gates on ATTEMPTED, not on ELIGIBLE', () => {
    // The false green this whole change exists to prevent: email is eligible
    // (routed + enabled + configured) and refused. Answering `true` here would
    // report that the 21:00 run delivers to a book we will never mail.
    const { routing: r } = routing(FIXTURE, {
      adapters: { email: emailAdapter(FIXTURE) },
    });

    expect(r.eligible).toEqual(['email']);
    expect(r.attempted).toEqual([]);
    expect(r.wouldScheduledDeliver).toBe(false);
  });

  it('CONTROL — true on a deliverable recipient at a period end', () => {
    expect(routing(REAL).routing.wouldScheduledDeliver).toBe(true);
  });

  it('false during quiet hours even though the channel is attemptable', () => {
    const { routing: r } = routing(REAL, { quietHoursActive: true });

    expect(r.attempted).toContain('email');
    expect(r.wouldScheduledDeliver).toBe(false);
  });

  it('false off a period boundary — `force` tests the send, it does not move the calendar', () => {
    const { routing: r } = routing(REAL, { atPeriodEnd: false });

    expect(r.attempted).toContain('email');
    expect(r.wouldScheduledDeliver).toBe(false);
  });
});
