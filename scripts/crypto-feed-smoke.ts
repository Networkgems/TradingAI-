#!/usr/bin/env tsx
/**
 * Smoke script: subscribe to live BTC-USD bars on the Coinbase Advanced Trade
 * WebSocket and print whatever comes back for ~30 seconds. Used to confirm the
 * feed runs end-to-end against the public market-data endpoint.
 *
 * Usage:
 *   pnpm --filter @trading-app/engine build
 *   tsx scripts/crypto-feed-smoke.ts            # public/anonymous mode
 *   COINBASE_API_KEY=... COINBASE_API_SECRET=... tsx scripts/crypto-feed-smoke.ts
 */
import { CoinbaseFeed } from '../packages/engine/dist/index.js';

const SYMBOLS = ['BTC-USD'];
const DURATION_MS = 30_000;

async function main(): Promise<void> {
  const apiKey = process.env.COINBASE_API_KEY;
  const apiSecret = process.env.COINBASE_API_SECRET;

  const feed = new CoinbaseFeed({
    symbols: SYMBOLS,
    apiKey: apiKey || undefined,
    apiSecret: apiSecret || undefined,
  });

  feed.on('connected', () => console.log('[coinbase-feed] connected'));
  feed.on('authenticated', () => console.log('[coinbase-feed] authenticated (CDP)'));
  feed.on('subscribed', (s) => console.log('[coinbase-feed] subscribed:', s));
  feed.on('disconnected', (code, reason) => console.log('[coinbase-feed] disconnected', code, reason));
  feed.on('error', (e) => console.error('[coinbase-feed] error:', e.message));
  feed.on('bar', (b) => {
    console.log(
      `[bar] ${b.symbol} @ ${new Date(b.timestamp).toISOString()} ` +
      `O=${b.open} H=${b.high} L=${b.low} C=${b.close} V=${b.volume.toFixed(4)}`,
    );
  });
  feed.on('quote', (q) => {
    console.log(`[quote] ${q.symbol} bid=${q.bidPrice}@${q.bidSize} ask=${q.askPrice}@${q.askSize}`);
  });
  feed.on('trade', (t) => {
    console.log(`[trade] ${t.symbol} ${t.conditions[0]} ${t.size}@${t.price}`);
  });

  console.log(`[coinbase-feed] starting; will run for ${DURATION_MS / 1000}s`);
  feed.start();
  await new Promise<void>((r) => setTimeout(r, DURATION_MS));
  console.log('[coinbase-feed] stopping');
  feed.stop();
}

main().catch((err) => {
  console.error('smoke run failed:', err);
  process.exit(1);
});
