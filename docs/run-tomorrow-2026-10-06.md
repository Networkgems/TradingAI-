# Getting the app trading on Tue 2026-10-06

This branch (`feat/trade-unblock-bcd`) adds:

- **B — live learning budget.** A capped live path for the directional sleeve (signal → call or put). Off by default.
- **C — premium selling on paper.** The demo wheel (cash-secured put → covered call) can now be armed at runtime through demo-flags.

**D (feed hygiene) was investigated and not coded.** See the bottom of this doc.

> ⚠ Leave Render **Auto-Deploy OFF** (TRA-1653/1665). Agents push to `main` many times a day. With auto-deploy on, each push would restart the real-money host, often during market hours.

## 0. Ship it (before 09:25 ET = 13:25Z)

1. Merge the PR.
2. Run `RENDER_API_KEY=… node scripts/render-redeploy.mjs --commit=<merged sha>`.

The script refuses to deploy inside 13:25–20:00Z on weekdays.

## 1. Paper: calls/puts + OTM + wheel (no further deploy)

```
POST /api/admin/demo-flags          (admin auth)
{ "flags": {
    "ENABLE_OPTION_COST_AWARE_GATE": "0",
    "OTM_DELTA_FLOOR_ENABLED": "0",
    "ENABLE_OPTION_SHORT_PREMIUM_SCANNER": "1",
    "ENABLE_OPTION_WHEEL_ROUTING": "1"
} }
```

- **Directional:** every trend-confluence signal that clears the spread and contract checks opens a paper **call** (uptrend) or **put** (downtrend).
- **OTM:** the demo delta collision clears (`OTM_DELTA_FLOOR=0.40` vs the floor's `|Δ| ≤ 0.40`).
- **Wheel:** sells paper cash-secured puts on short-premium candidates, then covered calls on assignment.
- **To revert,** post `null` for any key.
- **Check results with:**
  - `GET /api/health/rv-scan` (per-sleeve census)
  - `GET /api/health/short-premium`
  - `GET /api/health/wheel-promotion-gate`

## 2. Live: directional learning budget (B)

Write each key with the **single-key API**. A dashboard edit can self-deploy the branch tip (TRA-4820).

```
curl -X PUT -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" \
  https://api.render.com/v1/services/$RENDER_SERVICE_ID/env-vars/<KEY> -d '{"value":"<VALUE>"}'
```

| Key | Value | Notes |
|---|---|---|
| `ENABLE_OPTION_LIVE_DIRECTIONAL` | `1` | live arm for the directional sleeve |
| `ENABLE_LIVE_DIRECTIONAL_LEARNING_BUDGET` | `1` | without it, live directional stays stood down |
| `LIVE_LEARNING_BUDGET_MAX_LOSS_USD` | **your number** | default 300, hard ceiling 1000 |
| `LIVE_LEARNING_BUDGET_PER_OPEN_USD` | optional | default 100, ceiling 150 (premium at risk per trade) |
| `LIVE_LEARNING_BUDGET_MAX_OPENS` | optional | default 40 (the real-fill arm's floor), ceiling 60 |

Then apply the env with the **same** commit: `node scripts/render-redeploy.mjs --commit=<serving sha>`.

Already-required live conditions, unchanged:

- `OPTION_LIVE_TEST_UNTIL` is in the future.
- The live book has auto-trading on and Tradier live options enabled.
- `TRADIER_ENV=production`.
- `DATA_DIR` is durable. On an ephemeral dir every grant refuses.

**Hard limits, enforced in code:**

- 1 position per signal, sized to ≤ the per-open cap.
- ≤ 2 new opens per session, ≤ 2 open at a time.
- The loss cap counts realized losses **plus** everything still at risk.
- The budget disarms permanently at the loss cap, the open cap, or 40 sessions.
- It bypasses **only** the cost bar and the TRA-4750 directional stand-down entry. The canary ceiling ($300/order, $500 aggregate), hard controls, buying-power checks, the spread veto and the churn brake all still run.

**Verify:** `GET /api/health/cost-aware-gate` → `liveLearningBudget`. Expect `flagOn: true`, `durability.ephemeral: false` and `lossHeadroomUsd` equal to your budget.

**Kill switch:** set `ENABLE_LIVE_DIRECTIONAL_LEARNING_BUDGET=0` and redeploy the same sha. Positions already open are still managed and closed normally.

**Honest expectation:** the directional cells measure negative (best −0.19R). This buys real broker fills, which every promotion gate in the repo demands. It is not expected to make money. Budget for losing up to the cap.

## D — why no code tonight

The 10-02 census shows OTM `no_expirations` at 29%, against 2.5% on the directional sleeve, over the same symbols. The difference comes from the OTM DTE window being clamped to the contract floor's 21–45 days (TRA-4976). Monthly-only names whose next listed expiry falls at 46–60 DTE can't be bought under the floor rule, so the scan now refuses them at selection rather than later. Expirations are cached for 6h, so this costs almost no quota. Widening it is a rule decision, `OTM_CONTRACT_FLOOR_DTE_MAX=60`, not a bug fix. Wasted quota on dead symbols was already addressed by TRA-4987.
