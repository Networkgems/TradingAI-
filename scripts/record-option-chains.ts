#!/usr/bin/env tsx
/**
 * TRA-376 — daily option-chain snapshot recorder CLI.
 *
 * Standalone entry point so the recorder can run from a host crontab (or a
 * scheduled GitHub Action / PM2 cron job) at ~3:55 PM ET on trading days
 * without needing the rest of the server process up.
 *
 * Requires the live Tradier production credentials in the environment:
 *   TRADIER_API_TOKEN     production-tier API token
 *   TRADIER_ACCOUNT_ID    Tradier account id (only used for option order endpoints; harmless for read-only)
 *
 * Optional:
 *   TRADIER_ENV           'production' (default) or 'sandbox'
 *   CHAINS_OUT_DIR        output root (default: ./data/option-chains)
 *   CHAINS_WATCHLIST      comma-separated symbol list (default: shared WATCHLIST)
 *   CHAINS_MIN_DTE        min DTE in days (default: 14)
 *   CHAINS_MAX_DTE        max DTE in days (default: 35)
 *
 * Usage:
 *   pnpm --filter @trading-app/server build
 *   tsx scripts/record-option-chains.ts
 */
import { TradierOptionsClient } from '../packages/engine/dist/index.js';
import { recordOptionChains } from '../packages/server/dist/options-chain-recorder.js';
import { WATCHLIST } from '../packages/shared/dist/index.js';

function envOr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

async function main(): Promise<void> {
  const apiToken = process.env.TRADIER_API_TOKEN ?? '';
  const accountId = process.env.TRADIER_ACCOUNT_ID ?? '';
  if (!apiToken) {
    console.error('TRA-376 recorder: missing TRADIER_API_TOKEN');
    process.exit(2);
  }

  const env = envOr('TRADIER_ENV', 'production') as 'sandbox' | 'production';
  const outDir = envOr('CHAINS_OUT_DIR', './data/option-chains');
  const minDteDays = Number(envOr('CHAINS_MIN_DTE', '14'));
  const maxDteDays = Number(envOr('CHAINS_MAX_DTE', '35'));

  const rawWatchlist = process.env.CHAINS_WATCHLIST;
  const symbols = rawWatchlist
    ? rawWatchlist.split(',').map((s) => s.trim()).filter(Boolean)
    : [...WATCHLIST];

  const client = new TradierOptionsClient(apiToken, accountId || 'recorder-readonly', env);

  console.log(
    `[TRA-376 recorder] env=${env} symbols=${symbols.length} dte=[${minDteDays},${maxDteDays}] outDir=${outDir}`,
  );

  const result = await recordOptionChains({
    symbols,
    client,
    outDir,
    minDteDays,
    maxDteDays,
  });

  const written = result.symbols.filter((s) => s.outcome === 'written').length;
  const errored = result.symbols.filter((s) => s.outcome === 'error');
  console.log(`[TRA-376 recorder] date=${result.date} written=${written}/${result.symbols.length}`);
  for (const s of errored) {
    console.warn(`  - ${s.symbol}: ${s.errorMessage}`);
  }
  console.log(`[TRA-376 recorder] dir=${result.outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
