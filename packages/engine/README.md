# @trading-app/engine

Trading engine sidecar — signal generation, order management, position tracking,
and broker integrations.

Currently supported brokers:

- **Alpaca** (equities + options) — REST orders + WebSocket data feed.
- **Tradier** (equities + options) — REST orders + polling data feed (Phase 1).

## Tradier integration

Tradier is the second broker integration, added under [TRA-151](../../). The
classes are shape-compatible with the Alpaca clients so a strategy can swap
brokers without changing call sites.

### Environment variables

| Var                   | Required | Notes                                                                   |
| --------------------- | -------- | ----------------------------------------------------------------------- |
| `TRADIER_API_TOKEN`   | yes      | Bearer token. Sandbox tokens are issued from the Tradier dashboard.     |
| `TRADIER_ACCOUNT_ID`  | yes (orders) | Account number used in the `/accounts/{id}/orders` path.            |
| `TRADIER_ENV`         | no       | `sandbox` (default) or `production`. Flip to `production` only after the sandbox smoke test passes. |

### Usage

```ts
import {
  TradierOrderClient,
  TradierOptionsClient,
  TradierFeed,
} from '@trading-app/engine';

const orders = new TradierOrderClient(
  process.env.TRADIER_API_TOKEN!,
  process.env.TRADIER_ACCOUNT_ID!,
  (process.env.TRADIER_ENV as 'sandbox' | 'production') ?? 'sandbox',
);

const options = new TradierOptionsClient(
  process.env.TRADIER_API_TOKEN!,
  process.env.TRADIER_ACCOUNT_ID!,
  'sandbox',
);

// Find an ATM call expiring 2-5 weeks out and buy 1 contract.
const contract = await options.findATMContract('AAPL', 'call', 150);
if (contract) {
  await options.buyContracts(contract.optionSymbol, 1);
}

// Phase-1 polling feed — emits `quote` and `trade` events with the same shape
// as `AlpacaFeed`, so strategies can swap data sources.
const feed = new TradierFeed({
  apiToken: process.env.TRADIER_API_TOKEN!,
  symbols: ['AAPL', 'SPY'],
  env: 'sandbox',
});
feed.on('quote', (q) => console.log(q));
feed.start();
```

### Sandbox smoke test

Before flipping `TRADIER_ENV=production`, a sandbox round-trip should succeed
end to end:

1. `getExpirations('AAPL')` returns at least one date.
2. `findATMContract('AAPL', 'call', <spot>)` resolves a contract.
3. `buyContracts(contract.optionSymbol, 1)` returns an order id.
4. `getOptionMid(contract.optionSymbol)` returns a number.
5. `sellContracts(contract.optionSymbol, 1)` returns an order id.

A scripted version of this lives in the PR description for [TRA-151].

### Phase 2 (not in this ticket)

- Replace `TradierFeed`'s polling loop with the long-poll
  `https://stream.tradier.com/v1/markets/events` session endpoint.
- Introduce a `BrokerOrderClient` interface once both Alpaca and Tradier are
  running side-by-side in production.

## Tests

```bash
pnpm --filter @trading-app/engine test
```

Network is mocked via `globalThis.fetch = vi.fn()` — no live API calls are made.
