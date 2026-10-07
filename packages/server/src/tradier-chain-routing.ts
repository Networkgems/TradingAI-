// Where option CHAINS (expirations + chain snapshots) are read from.
//
// Before this module the chain reader followed `TRADIER_ENV`, and the PM2
// self-host pins that to `sandbox` so it can only ever route PAPER orders. That
// pin was right for orders and wrong for data: Tradier's sandbox market data is
// 15 minutes delayed and carries NO greeks/IV, while equity quotes on the same
// host come from production in real time (yahoo-feed). The OTM/RV scanners were
// therefore pricing a live spot against a 15-minute-old chain with no vendor IV.
//
// Chains are read-only market data. Reading them with the production
// market-data token cannot place an order: the scanner's client only ever calls
// `/markets/options/expirations` and `/markets/options/chains`.
//
// Resolution (first match wins):
//   1. `TRADIER_CHAINS_ENV=sandbox`              → legacy sandbox read (explicit opt-out)
//   2. `TRADIER_ENV=production`                   → production, `TRADIER_API_TOKEN` (unchanged)
//   3. `TRADIER_MARKET_DATA_TOKEN` set            → production, that token (NEW default)
//   4. otherwise                                  → sandbox (unchanged)
//
// Only the explicit `TRADIER_MARKET_DATA_TOKEN` unlocks (3) — never the
// unprefixed `TRADIER_API_TOKEN`, which on a sandbox host may be the legacy
// single-pair SANDBOX key.

export type TradierEnvName = 'sandbox' | 'production';

export interface ChainMarketDataRoute {
  env: TradierEnvName;
  apiToken: string | undefined;
  accountId: string | undefined;
  /** Why this route was chosen — published on the RV/OTM diagnostics. */
  source: 'chains_env_opt_out' | 'tradier_env_production' | 'market_data_token' | 'tradier_env_sandbox';
  /**
   * Self-imposed upstream chain budget (req/min). Set only when chains move
   * onto a production token they SHARE with quotes and timesales (Tradier's
   * limit is 120/min per token); `null` keeps the legacy no-ceiling behaviour.
   */
  chainCallBudgetPerMin: number | null;
}

/** Default chain budget when chains share the production market-data token. */
export const DEFAULT_SHARED_CHAIN_BUDGET_PER_MIN = 20;

function parseBudget(raw: string | undefined, fallback: number | null): number | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '') return fallback;
  if (v === 'none') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function resolveChainMarketDataRoute(env: NodeJS.ProcessEnv = process.env): ChainMarketDataRoute {
  const tradierEnv: TradierEnvName = env['TRADIER_ENV'] === 'production' ? 'production' : 'sandbox';
  const optOut = (env['TRADIER_CHAINS_ENV'] ?? '').trim().toLowerCase() === 'sandbox';
  const mdToken = (env['TRADIER_MARKET_DATA_TOKEN'] ?? '').trim();
  const budgetRaw = env['TRADIER_CHAIN_BUDGET_PER_MIN'];

  const sandboxRoute = (source: ChainMarketDataRoute['source']): ChainMarketDataRoute => ({
    env: 'sandbox',
    apiToken: env['TRADIER_SANDBOX_API_TOKEN'] ?? env['TRADIER_API_TOKEN'],
    accountId: env['TRADIER_SANDBOX_ACCOUNT_ID'] ?? env['TRADIER_ACCOUNT_ID'],
    source,
    chainCallBudgetPerMin: parseBudget(budgetRaw, null),
  });

  if (optOut) return sandboxRoute('chains_env_opt_out');
  if (tradierEnv === 'production') {
    return {
      env: 'production',
      apiToken: env['TRADIER_API_TOKEN'],
      accountId: env['TRADIER_ACCOUNT_ID'],
      source: 'tradier_env_production',
      // Same token as quotes/timesales here too, but this branch is unchanged
      // behaviour unless the operator sets a budget explicitly.
      chainCallBudgetPerMin: parseBudget(budgetRaw, null),
    };
  }
  if (mdToken) {
    return {
      env: 'production',
      apiToken: mdToken,
      // Market endpoints ignore the account id; the client constructor wants one.
      accountId: env['TRADIER_ACCOUNT_ID'] || 'market-data-only',
      source: 'market_data_token',
      chainCallBudgetPerMin: parseBudget(budgetRaw, DEFAULT_SHARED_CHAIN_BUDGET_PER_MIN),
    };
  }
  return sandboxRoute('tradier_env_sandbox');
}

/** `OTM_SCAN_MAX_EXPIRATIONS` — expirations priced per OTM scan (1–6, default 1 = legacy). */
export function resolveOtmScanMaxExpirations(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number((env['OTM_SCAN_MAX_EXPIRATIONS'] ?? '').trim());
  return Number.isInteger(n) && n >= 1 ? Math.min(6, n) : 1;
}
