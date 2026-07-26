// TRA-2416 (follow-up) — the routing decision behind `POST
// /api/notifications/report/test`, lifted OUT of `index.ts` so it can be tested.
//
// Why this file exists at all: TRA-2416 shipped the third disposition
// (`suppressed`) through the dispatcher, where it is mutation-verified — but the
// ROUTE that reports it lived inline in `index.ts`, which has no route-test
// harness. That left the exact fields TRA-2284's grading routine reads
// (`routing.attempted`, `routing.suppressed[]`, `routing.wouldScheduledDeliver`,
// and the `all_channels_suppressed` code) asserted by nothing but a post-deploy
// probe. A wiring bug there reads IDENTICALLY to a working one: every one of
// those outcomes is a plain 409 with a JSON body, and a grader keyed on the
// wrong discriminator returns a confident verdict either way.
//
// So the decision — which channels are eligible, which are refused, whether the
// SCHEDULED run would deliver — is computed here as a pure function, and the
// route does nothing but map the verdict onto a status code.
//
// THE FALSE GREEN THIS PREVENTS: `wouldScheduledDeliver` gates on ATTEMPTED, not
// on `eligible`. A recipient we refuse to mail is eligible — it is routed and
// configured — so gating on eligibility would answer "yes, the 21:00 run
// delivers" for a book that will never receive anything. That single boolean is
// what the mail-track grade is read off.

import { ALERT_CHANNELS, type AlertChannel, type AlertPreferences } from '@trading-app/shared';
import { channelSuppressionReason, type AlertEvent, type ChannelAdapter } from './dispatcher.js';

/** One channel refused before any send was attempted. */
export interface SuppressedChannel {
  channel: AlertChannel;
  reason: string;
}

/** The `routing` block returned on EVERY outcome of the report self-test. */
export interface ReportRouting {
  /** Routed for the report class AND enabled AND configured. */
  eligible: AlertChannel[];
  /** `eligible` minus the suppressed — the channels a send is tried on. */
  attempted: AlertChannel[];
  /** The third disposition: neither delivered nor failed. */
  suppressed: SuppressedChannel[];
  quietHoursActive: boolean;
  /** Would the real scheduled 21:00 run emit anything for this recipient? */
  wouldScheduledDeliver: boolean;
}

/**
 * Three outcomes that all emit nothing, and must never be conflated:
 *
 *   • `no_eligible_channel`   — MISCONFIGURED. Nothing is routed/enabled/configured.
 *   • `all_channels_suppressed` — refused BY DESIGN. Everything routed here is a
 *     recipient we deliberately will not mail (an `@qa.test` fixture book).
 *   • `attempt`               — go ahead; transport failures are the route's 502.
 *
 * A grader that cannot tell the first two apart is measuring nothing: one means
 * "fix your settings", the other means "this account can never grade mail".
 */
export type ReportRoutingVerdict = 'no_eligible_channel' | 'all_channels_suppressed' | 'attempt';

/**
 * Operator-facing text for the two blocked verdicts. Kept beside the codes so
 * the pair cannot drift, and so the remediation stays testable: each names the
 * exact call that unblocks it.
 */
export const REPORT_ROUTING_BLOCKED_MESSAGE: Record<
  Exclude<ReportRoutingVerdict, 'attempt'>,
  string
> = {
  no_eligible_channel:
    'No channel is both routed for the report class and configured — the scheduled run would emit nothing.',
  all_channels_suppressed:
    'Every routed channel is suppressed for this recipient — the scheduled run would emit ' +
    'nothing, by design. This account cannot grade mail delivery; set a real address via ' +
    'PUT /api/account/notifications {"channels":{"email":{"emailAddress":"..."}}} and retry.',
};

export interface ReportRoutingInput {
  /** Channel adapters by name; a missing adapter is never eligible. */
  adapters: Partial<Record<AlertChannel, ChannelAdapter>>;
  /** The report event actually built — suppression is per-RECIPIENT, not per-channel. */
  event: AlertEvent;
  prefs: AlertPreferences;
  /** Already computed by the caller against the dispatcher's own quiet-hours rule. */
  quietHoursActive: boolean;
  /** Does `asOfDate` genuinely close the period? `force` relaxes the probe, never this. */
  atPeriodEnd: boolean;
}

/**
 * The same three conditions `NotificationDispatcher.fanOut` applies, plus
 * TRA-2416's suppression split — using the SAME shared helper the fan-out uses,
 * so this probe cannot drift from the scheduled path it exists to predict.
 */
export function resolveReportRouting(input: ReportRoutingInput): {
  verdict: ReportRoutingVerdict;
  routing: ReportRouting;
} {
  const { adapters, event, prefs, quietHoursActive, atPeriodEnd } = input;

  const eligible = ALERT_CHANNELS.filter(ch => {
    if (!prefs.events.report[ch]) return false;
    if (!prefs.channels[ch]?.enabled) return false;
    const adapter = adapters[ch];
    return !!adapter && adapter.isConfigured(prefs);
  });

  // Suppression is decided BEFORE any send. `channelSuppressionReason` fails
  // OPEN (a throwing predicate does NOT suppress) — deliberately, so a
  // transient fault surfaces as a visible channel FAILURE rather than silently
  // dropping a real user's mail, which is the too-wide gate that reads exactly
  // like a working one.
  const suppressed = eligible.flatMap<SuppressedChannel>(ch => {
    const adapter = adapters[ch];
    if (!adapter) return [];
    const { reason } = channelSuppressionReason(adapter, event, prefs);
    return reason ? [{ channel: ch, reason }] : [];
  });
  const attempted = eligible.filter(ch => !suppressed.some(s => s.channel === ch));

  const routing: ReportRouting = {
    eligible,
    attempted,
    suppressed,
    quietHoursActive,
    // Gates on `attempted`, NOT `eligible` — see the header. Also requires the
    // real calendar boundary: `force` tests the send path, it does not change
    // what the 21:00 run would do.
    wouldScheduledDeliver: atPeriodEnd && !quietHoursActive && attempted.length > 0,
  };

  if (eligible.length === 0) return { verdict: 'no_eligible_channel', routing };
  if (attempted.length === 0) return { verdict: 'all_channels_suppressed', routing };
  return { verdict: 'attempt', routing };
}
