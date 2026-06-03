// TRA-566 (TRA-410 A2) — channel adapter barrel + registration helper.

import type { NotificationDispatcher } from '../dispatcher.js';
import { EmailChannelAdapter, type EmailAdapterDeps } from './email.js';
import { TelegramChannelAdapter, type TelegramAdapterDeps } from './telegram.js';
import { DiscordChannelAdapter, type DiscordAdapterDeps } from './discord.js';

export { EmailChannelAdapter } from './email.js';
export type { EmailAdapterDeps } from './email.js';
export { TelegramChannelAdapter } from './telegram.js';
export type { TelegramAdapterDeps } from './telegram.js';
export { DiscordChannelAdapter, isValidDiscordWebhook } from './discord.js';
export type { DiscordAdapterDeps } from './discord.js';

export interface ChannelAdapterDeps {
  email?: EmailAdapterDeps;
  telegram?: TelegramAdapterDeps;
  discord?: DiscordAdapterDeps;
}

/**
 * Build + register the three channel adapters on a dispatcher. Called once at
 * server boot (after `initNotificationDispatcher`). Returns the constructed
 * adapters so callers (e.g. the test-send endpoint) can deliver through a
 * single channel directly, bypassing routing/prefs gating.
 */
export function registerChannelAdapters(
  dispatcher: NotificationDispatcher,
  deps: ChannelAdapterDeps = {},
): {
  email: EmailChannelAdapter;
  telegram: TelegramChannelAdapter;
  discord: DiscordChannelAdapter;
} {
  const email = new EmailChannelAdapter(deps.email);
  const telegram = new TelegramChannelAdapter(deps.telegram);
  const discord = new DiscordChannelAdapter(deps.discord);
  dispatcher.registerAdapter(email);
  dispatcher.registerAdapter(telegram);
  dispatcher.registerAdapter(discord);
  return { email, telegram, discord };
}
