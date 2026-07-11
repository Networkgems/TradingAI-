# Options Directional (calls/puts) — Live Promotion Validation

**Owner:** LeadDev · **Issue:** [TRA-1490](/TRA/issues/TRA-1490) (parent
[TRA-1479](/TRA/issues/TRA-1479) "Demo → Live", board family
`options-directional`) · **Live host:** `tradingai-bqb1` (sole production-Tradier
instance).

> **Board authorization scope.** The TRA-1479 checkbox interaction (accepted
> 2026-07-08 by `local-board`) authorizes *building* the live directional order
> path. It does **NOT** arm real capital. Arming is a **separate**
> `request_board_approval` with a per-name cap, gated on the phases below.

## Current shipped state (Phase 1 — DARK build)

`ENABLE_OPTION_LIVE_DIRECTIONAL` is shipped **OFF** (default; declared `"0"` in
`render.yaml`). With it off:

- The directional pass (`SignalEngine.evaluateDemoDirectional`, the TRA-1114
  near-ATM single-leg call/put entry) **never runs in live** — the caller gate and
  the method's own guard both require the armed flag in live mode.
- No live-book position is created and **no Tradier order is placed** — zero
  real-capital risk.
- **Demo is byte-for-byte unchanged** (the demo pass still keys off
  `ENABLE_OPTION_DEMO_DIRECTIONAL`; the live gate is live-mode only).

The flag is **secret-adjacent** (it authorizes real orders): it is read from the
**process env only**, is **not** on the `demo-flags.json` allowlist, and cannot be
flipped from the demo-flag file override.

### Where the code lives

| Concern | Location |
| --- | --- |
| Flag + accessor | `packages/server/src/option-exec-flag.ts` → `OPTION_LIVE_DIRECTIONAL_FLAG`, `isOptionLiveDirectionalEnabled()` |
| Live directional entry + broker mirror | `packages/server/src/signal-engine.ts` → `evaluateDemoDirectional()` (caller gate + method guard + `liveEquity` sizing + `mirrorLiveOptionOpen`) |
| Shared broker seam | `packages/server/src/signal-engine.ts` → `mirrorLiveOptionOpen()` (OBP/DTBP pre-checks + TRA-374 smart-open limit walk + void-on-reject). Shared with the RV long path (TRA-1491). |
| Deploy declaration | `render.yaml` → `ENABLE_OPTION_LIVE_DIRECTIONAL: "0"` |
| Secrets-free observability | `GET /api/health/options-live` → `liveDirectionalArmed`, `liveRvLongArmed`, `optionsBrokerConfigured` |

### How to confirm the dark state (no admin login, no secrets)

```
GET https://tradingai-bqb1.onrender.com/api/health/options-live
```

Expected on the shipped build: `"liveDirectionalArmed": false`. An armed flag with
no live broker (`optionsBrokerConfigured: false`) still places **no** order.

## Phased promotion plan (each phase gates the next)

| Phase | Gate | Owner | Status |
| --- | --- | --- | --- |
| **1. Build (dark, OFF)** | Live directional order path shipped behind `ENABLE_OPTION_LIVE_DIRECTIONAL`, default OFF; unit tests lock the dark gate + the armed order path; this doc. | LeadDev | **DONE (this issue)** |
| **2. Data / eligibility** | Option-chain capture window [TRA-382](/TRA/issues/TRA-382) resolved (≥30 trading-day partitions) so live entries have validated chain liquidity/spreads. | CTO / data | Blocked on TRA-382 |
| **3. Sandbox forward-validation** | Route through the sandbox promotion gate [TRA-1436](/TRA/issues/TRA-1436); prove live-representative fill quality on paper before any real route. | QuantTrader | Blocked on TRA-1436 |
| **4. Board arm** | `request_board_approval` with a per-name capital cap. Only then set the flag `"1"` on `tradingai-bqb1`. | Board | Not started |

## Phase-1 acceptance criteria (this issue) — all met

1. **Ships OFF / inert in live.** With the flag unset, `evaluateDemoDirectional`
   in live mode opens nothing and never calls the broker. *Covered by:*
   `signal-engine.test.ts` → "live + flag OFF — opens nothing and never calls the
   broker (DARK, zero capital)".
2. **Armed path is real, not a stub.** With the flag set and a live broker
   configured, the pass opens a live-book directional long **and** mirrors a real
   `buy_to_open` through the smart-open walk. *Covered by:* "live + flag ON
   (armed) — opens a live directional long AND mirrors a real buy_to_open".
3. **No phantom fills on broker rejection.** When Tradier cancels/rejects the
   mirror, the paper open is rolled back, the daily slot is freed, and a live
   skip-reason signal is surfaced (never silently dropped). *Covered by:* "live +
   flag ON but broker rejects — voids the open and surfaces a live skip-reason".
4. **Demo unchanged.** The existing TRA-1114/1123/1153 demo directional tests
   still pass with the live seam in place.
5. **Secret-adjacent containment.** The flag is process-env-only and absent from
   the demo-flag allowlist (`demo-flags.ts`); `render.yaml` declares it `"0"`.

## Arming procedure (Phase 4 — DO NOT run without board approval)

1. Confirm Phases 2–3 signed off (TRA-382 chain window + TRA-1436 sandbox fill
   quality) and a `request_board_approval` with a per-name cap is **accepted**.
2. Set `ENABLE_OPTION_LIVE_DIRECTIONAL=1` on `tradingai-bqb1` (env / `render.yaml`
   → redeploy; blueprint sync ≠ autoDeploy per TRA-1289).
3. Verify via `GET /api/health/options-live` that `liveDirectionalArmed: true`
   **and** `optionsBrokerConfigured: true`.
4. Watch the first live fills on the Signals feed; any suppressed entry surfaces a
   `liveSkipReason`. Revert = clear the env value.
