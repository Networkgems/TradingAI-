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

  async send(event: AlertEvent, prefs: AlertPreferences): Promise<void> {
    const to = this.resolveAddress(event.username, prefs);
    if (!to) throw new Error(`no email address for user ${event.username}`);
    const msg = renderAlert(event, this.now());
    await this.sendMail({ to, subject: msg.subject, text: msg.text, html: msg.html });
  }
}
