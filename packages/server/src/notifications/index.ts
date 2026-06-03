// TRA-563 (TRA-410 A1) — notifications barrel.
//
// The dispatcher core + event model live here. Channel adapters
// (email / Telegram / Discord) and the shared renderer land in A2 and will be
// re-exported from this barrel as they arrive.

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
