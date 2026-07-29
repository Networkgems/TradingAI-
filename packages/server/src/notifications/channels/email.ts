// TRA-566 (TRA-410 A2) — email channel adapter.
//
// Wraps the existing SMTP transport (packages/server/src/email.ts) — NO new
// email infra (§1.5). The destination is the user's per-channel override
// (`prefs.channels.email.emailAddress`) when set, else their account login
// email resolved server-side, so a fresh user needs no setup.

import type { AlertChannel, AlertPreferences } from '@trading-app/shared';
import type { AlertEvent, ChannelAdapter } from '../dispatcher.js';
import { renderAlert } from '../renderer.js';
import { isSmtpConfigured, sendNotificationEmail } from '../../email.js';
import { getUser } from '../../users.js';
import { isUndeliverableEmail } from '../../undeliverable-email.js';

/**
 * TRA-2416 — machine-readable suppression reason, shared with the transport-side
 * gate TRA-2356 put on the welcome / reset / OTP paths so the whole codebase
 * reports one string for one cause.
 */
export const TEST_RECIPIENT_SUPPRESSION_REASON = 'test_account_recipient';

export interface EmailAdapterDeps {
  /** SMTP availability probe. Defaults to the real transport check. */
  smtpConfigured?: () => boolean;
  /** Mail send fn. Defaults to the shared SMTP transport. Injectable for tests. */
  sendMail?: (opts: { to: string; subject: string; text: string; html?: string }) => Promise<void>;
  /** Resolve a user's account login email (fallback destination). */
  resolveLoginEmail?: (username: string) => string | undefined;
  /** Injectable clock for deterministic timestamps in tests. */
  now?: () => number;
}

export class EmailChannelAdapter implements ChannelAdapter {
  readonly channel: AlertChannel = 'email';

  private readonly smtpConfigured: () => boolean;
  private readonly sendMail: NonNullable<EmailAdapterDeps['sendMail']>;
  private readonly resolveLoginEmail: (username: string) => string | undefined;
  private readonly now: () => number;

  constructor(deps: EmailAdapterDeps = {}) {
    this.smtpConfigured = deps.smtpConfigured ?? isSmtpConfigured;
    this.sendMail = deps.sendMail ?? sendNotificationEmail;
    this.resolveLoginEmail = deps.resolveLoginEmail ?? ((u) => getUser(u)?.email || undefined);
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * "Configured" iff SMTP is available. The actual destination address is
   * resolved per-send (override or login email), so the channel is usable as
   * soon as mail credentials exist.
   */
  isConfigured(_prefs: AlertPreferences): boolean {
    return this.smtpConfigured();
  }

  /** Resolve the destination address for a user under their prefs. */
  resolveAddress(username: string, prefs: AlertPreferences): string | undefined {
    const override = prefs.channels.email.emailAddress?.trim();
    return override || this.resolveLoginEmail(username);
  }

  /**
   * TRA-2416 — refuse to hand a fixture address to the transport.
   *
   * `qa.test` has no MX record, so anything aimed at one hard-bounces into
   * `networkgemstore@gmail.com` — which is also `ALERT_EMAIL`, the inbox we read
   * real ops alerts out of. TRA-2356 closed the three user-addressed transport
   * paths (welcome / reset / OTP); this closes the dispatcher path, which is the
   * one that scales: `DEFAULT_ALERT_PREFERENCES` ships `channels.email.enabled:
   * true` with `fill`/`exit`/`risk_halt`/`briefing` all `email: true`, so every
   * fixture book is ALREADY opted in. The count is only ~8/day (one per signup)
   * because the dispatch path has never executed — TRA-2284's finding. The
   * moment it does, ~50 of the ~51 demo books are fixtures and `briefing` alone
   * is daily. That empirical zero is held down by a dormant caller, and it
   * expires the instant someone fixes the caller.
   *
   * ★ Keyed on the RESOLVED address, not on `isTestAccount(username)`. Two
   * reasons, and the second is load-bearing:
   *
   *   1. The harm is a property of the ADDRESS (NXDOMAIN), not of the book.
   *   2. It leaves a deliberate escape hatch. `resolveAddress` prefers the
   *      per-channel override, so a fixture book with
   *      `channels.email.emailAddress` pointed at a real, MX-backed inbox is NOT
   *      suppressed and still proves the mail path end-to-end. That matters
   *      because TRA-2284's grading routine probes `ctoverify_tra2284`, a
   *      fixture — without this hatch, deploying the gate would make the mail
   *      path ungradeable by the instrument that grades it.
   *
   * An unresolvable address is NOT suppressed — that is a genuine failure and
   * belongs in the failed ledger, which is what `send()` below already does.
   *
   * TRA-2485 — the predicate is `isUndeliverableEmail` (full RFC 2606/6761
   * reserved set), not `isTestEmail` (`@qa.test` only): the residual fixture
   * population on `@example.com` / `@qa.invalid` kept bouncing after TRA-2356.
   * Still keyed on the RESOLVED ADDRESS for both reasons above; the reason
   * string is unchanged so the TRA-2416 ledger and its readers don't move.
   */
  suppressionReason(event: AlertEvent, prefs: AlertPreferences): string | undefined {
    const to = this.resolveAddress(event.username, prefs);
    if (!to) return undefined;
    return isUndeliverableEmail(to) ? TEST_RECIPIENT_SUPPRESSION_REASON : undefined;
  }

  async send(event: AlertEvent, prefs: AlertPreferences): Promise<void> {
    const to = this.resolveAddress(event.username, prefs);
    if (!to) throw new Error(`no email address for user ${event.username}`);
    const msg = renderAlert(event, this.now());
    await this.sendMail({ to, subject: msg.subject, text: msg.text, html: msg.html });
  }
}
