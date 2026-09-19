// TRA-4729 — moved verbatim out of SettingsPage.tsx; no behaviour change.
import type { AccountSettings, BrokerageType, LiveTradierMarkets, TradierEnv } from '@trading-app/shared';

// TRA-221 — Tradier (Options) live credentials. Stored on a dedicated set of
// fields.
export function readLiveBrokerageTypeOptions(s: AccountSettings): BrokerageType {
  return s.liveBrokerageTypeOptions ?? 'tradier';
}
export function readLiveTradierEnvOptions(s: AccountSettings): TradierEnv {
  return s.liveTradierEnvOptions ?? 'sandbox';
}
// TRA-226 — Sandbox and Production credentials are stored on separate fields
// so flipping the Environment dropdown no longer clobbers the other env's API
// token / account number. The reader returns whichever pair matches the
// currently selected env. Sandbox falls back to the legacy un-suffixed fields
// for users who saved before the split (production never does — production
// creds must be entered explicitly to avoid leaking sandbox tokens).
export function readLiveApiKeyOptions(s: AccountSettings, env: TradierEnv): string {
  if (env === 'production') return s.liveApiKeyOptionsProduction ?? '';
  return s.liveApiKeyOptionsSandbox ?? s.liveApiKeyOptions ?? '';
}
export function readLiveAccountIdOptions(s: AccountSettings, env: TradierEnv): string {
  if (env === 'production') return s.liveAccountIdOptionsProduction ?? '';
  return s.liveAccountIdOptionsSandbox ?? s.liveAccountIdOptions ?? '';
}
export function liveApiKeyOptionsField(
  env: TradierEnv,
): 'liveApiKeyOptionsSandbox' | 'liveApiKeyOptionsProduction' {
  return env === 'production' ? 'liveApiKeyOptionsProduction' : 'liveApiKeyOptionsSandbox';
}
export function liveAccountIdOptionsField(
  env: TradierEnv,
): 'liveAccountIdOptionsSandbox' | 'liveAccountIdOptionsProduction' {
  return env === 'production' ? 'liveAccountIdOptionsProduction' : 'liveAccountIdOptionsSandbox';
}
// TRA-336 / TRA-370 — markets selector for Tradier Live. Default ('both')
// mirrors Demo's signal flow so a Live account trades both equity positions
// and options out of the box; matches the server-side resolver fallback.
export function readLiveTradierMarkets(s: AccountSettings): LiveTradierMarkets {
  return s.liveTradierMarkets ?? 'both';
}

