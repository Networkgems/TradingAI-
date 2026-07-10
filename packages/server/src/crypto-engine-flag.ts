// TRA-1580 — master kill switch for the whole crypto signal engine.
//
// For the options/stock-only Monday live launch the board dropped the BTC-DCA
// pilot to post-launch (TRA-1575 crypto-OFF decision). The residual bqb1
// crash-restart cycle (TRA-1463 / TRA-1508) is driven by `crypto.doTick`'s
// ~395-symbol Coinbase fan-out: a sub-minute native-RSS/arena-fragmentation
// burst that no heap watchdog can see and that Render's cgroup OOM-kills. The
// most durable way to stabilise bqb1 for launch is simply to never run that
// sweep — not tune it.
//
// This flag is DISABLED BY DEFAULT (compiled default = crypto off), mirroring
// the RV engine's compiled-off posture. That guarantees the launch build ships
// crypto-dark regardless of Render env, and cannot be silently re-armed by a
// stray env var (the DEMO_STRATEGY_PRESET override trap, TRA-694). To re-enable
// crypto post-launch, set `CRYPTO_ENGINE_ENABLED=1` (accepts 1/true/yes/on) —
// no code change needed. The engine object is still constructed either way, so
// all `ctx.cryptoEngine.*` report/state/endpoint reads keep working (they just
// return an idle, empty snapshot); only the ticking data sweep is suppressed.

export const CRYPTO_ENGINE_FLAG = 'CRYPTO_ENGINE_ENABLED';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * True iff the crypto signal engine is enabled (accepts 1/true/yes/on). OFF by
 * default. When false the engine never schedules or runs a `doTick` sweep, so
 * the bqb1-crashing Coinbase fan-out cannot fire from any path (boot interval,
 * staggered boot tick, or a request-driven `refresh()`).
 */
export function isCryptoEngineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[CRYPTO_ENGINE_FLAG]);
}
