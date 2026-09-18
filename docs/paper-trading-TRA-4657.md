# Paper trading with live data — TRA-4657

The theoretical book the go-live decision is graded against. The demo book
already runs every strategy against the live feed but fills at the chain MID
with zero slippage and zero fees (TRA-4674 measured the spread at 52% of the
signal). This ledger re-prices every strategy-driven entry and exit **at the
touch** and folds a daily summary, so a week of paper history prices the edge
net of the one cost that decides whether it survives.

Module: `packages/server/src/paper-trading.ts` · tees in
`signal-engine.ts` (the alert-emitter seams) · routes in
`paper-trading-routes.ts` · ledger at `<DATA_DIR>/paper-trading.jsonl`
(append-only JSONL, corrupt lines skipped, fold survives restart).

## Acceptance-criteria mapping

| AC | Where |
| --- | --- |
| Runs continuously against live data | The tees observe the live-fed engines (incl. the `ENABLE_AUTONOMOUS_DEMO_LOOP` conductor); the ledger is process-restart-safe. |
| Every signal logged (timestamp, trigger, proposed trade) | `recordPaperSignal` inside `pushRecentSignal` — THE feed sink all 26 signal emit sites pass through; rows carry entry/stop/target/RR + skip reason/code. |
| Theoretical fills at bid/ask, not mid | `simulatePaperFill`: buy = mid + f·halfSpread, sell = mid − f·halfSpread. Spread evidence, best-first: the row's real TRA-3990 entry quote → stamped `entrySpreadPct` → `DEFAULT_MARKETABLE_HALF_SPREAD_FRAC` (0.134, TRA-2885). Equities model 2.5 bps half-spread. Never a free mid fill. |
| Slippage assumption logged | Every fill row stamps `{aggression f, halfSpreadPerShare, slippagePerShare = f × halfSpread, spreadSource}` — the "spread × fill aggression" formula as data, per row, plus `commissionUsd` ($0.65/contract, `DEFAULT_COST_MODEL`). |
| Daily summary | `GET /api/paper-trading/summary?day=YYYY-MM-DD` — signals · admitted/refused opens (by reason) · closes · theoretical realized P&L (net) beside the demo book's gross · slippage + commission totals. |
| Zero live orders | Structural: the module imports no broker client and exposes no submit path (a test greps the imports). It only *observes* decisions other seams made. |

## Born under the choke point (TRA-4655 contract)

Every paper **open** passes `admitOrderThroughHardControls` before booking —
the paper book rehearses the fleet kill switch, day-loss lockout, $300/3-position
caps, stale-quote breaker and idempotency exactly as the live seams do. A
refusal is **logged as a refusal** (`admit.reasonCode` on the row) and never
enters the book. Paper **closes do not admit** — deliberately mirroring
TRA-4650, which left the live close-path admits unwired so a control outage
can never trap an exit. Paper P&L is never fed to `recordHardControlsPnl`
(a theoretical loss must not lock the real book out); the real lockout *does*
bind paper opens, which is the rehearsal working. The `paper-book` force-close
handler is registered at boot: a mandated flatten closes every paper row
(stamped `markStale` — no live mark exists in the module, so those closes are
excluded from theoretical P&L rather than priced off a quote that isn't there).

## Population bounds (documented, not silent)

- Strategy-driven opens/exits only (the alert-emitter seams). Manual operator
  closes and broker reconciles are not strategy decisions and stay out.
- TP1 partial exits fold into the terminal close: one open fill and one close
  fill per position id, at the original contract count.
- Per-reason **skip** counts for candidates that never opened live in the
  existing funnels (`equity-entry-funnel`, scan census); signal rows here
  carry `skipReason` when it was stamped before the feed push.

## Arming for the Days 5–12 collection window

1. This commit must be **live** first — it rides the next explicit deploy
   train (`render-redeploy.mjs --commit=<sha>`; all four gates + cadence
   ceiling apply as ever; the `autoDeploy=no` pin stands).
2. Arm with a **single-key** env upsert on bqb1: `ENABLE_PAPER_TRADING=1`
   (optional `PAPER_FILL_AGGRESSION`, default 1 = taker at the touch), then a
   same-SHA redeploy to apply (`POST /restart` is NOT an env-apply path —
   `ENV_WRITE_TRUTH`).
3. Verify: `GET /api/paper-trading` → `enabled: true`, and after the first
   session `summary.signals > 0` on a trading day.
4. Routes (auth required): `/api/paper-trading` (state) ·
   `/api/paper-trading/summary?day=` · `/api/paper-trading/rows?day=`.

Tests: `packages/server/src/paper-trading.test.ts` (20 — fill math, choke-point
refusals logged + kept out of the book, net P&L settlement, daily fold,
force-close, restart survival, flag-off inertness, no-broker-import control).
