// TRA-563 (TRA-410 A1) — notifications barrel.
// TRA-566 (TRA-410 A2) — channel adapters + shared renderer + link store added.
//
// The dispatcher core + event model, the shared event→message renderer, and the
// email / Telegram / Discord channel adapters are all re-exported from here.

export {
  NotificationDispatcher,
  initNotificationDispatcher,
  getNotificationDispatcher,
  emitAlert,
  __resetNotificationDispatcherForTest,
} from './dispatcher.js';
export type {
  AlertEvent,
  AlertMarket,
  FillAlertEvent,
  ExitAlertEvent,
  SignalAlertEvent,
  RiskHaltAlertEvent,
  ChannelAdapter,
  DispatcherDeps,
} from './dispatcher.js';

export { renderAlert } from './renderer.js';
export type { RenderedAlert } from './renderer.js';

export { buildSampleAlertEvent } from './sample-event.js';

export {
  registerChannelAdapters,
  EmailChannelAdapter,
  TelegramChannelAdapter,
  DiscordChannelAdapter,
  isValidDiscordWebhook,
} from './channels/index.js';
export type {
  ChannelAdapterDeps,
  EmailAdapterDeps,
  TelegramAdapterDeps,
  DiscordAdapterDeps,
} from './channels/index.js';

export {
  issueLinkToken,
  consumeLinkToken,
  parseStartCommand,
  pendingLinkTokenCount,
  __resetLinkTokensForTest,
  LINK_TOKEN_TTL_MS,
} from './telegram-link.js';
