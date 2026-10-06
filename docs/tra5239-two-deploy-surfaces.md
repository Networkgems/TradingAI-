# TRA-5239 — bqb1 has two live deploy surfaces; only one is gated

## Surfaces

| surface | Render `trigger` | gated? | detected? |
|---|---|---|---|
| `scripts/render-redeploy.mjs` (REST `POST /deploys`) | `api` | **yes** — exits 4/5/6/7/9/10 | n/a |
| Render dashboard Deploy button (and rollback / settings / env paths) | `manual`, `rollback`, `service_updated`, … | **NO** | `pnpm check:deploy-origin` |

Measured 2026-10-06: 3 of 8 deploys were `manual` (01:23Z `52d74583`, 12:45Z `19287586`,
14:31Z `c3a2d337` — the last inside the 13:25–20:00Z freeze). The replay of that table is a
shipped control (`TRA-5239 ARM A/B`).

## Item 2 — can the dashboard be closed from our side? **No.**

`GET /v1/owners/tea-d7macfog4nts73ai6p40/members` returns one member, ADMIN (TRA-4789). Render
roles only restrict members below admin; an owner cannot be demoted off their own button. The
only structural option — a second non-admin seat for day-to-day use, admin seat sealed —
restructures the account, still leaves the admin button, and is a board call. Nobody should plan
around a permission control that does not exist.

## Item 1 — promptness: `--minutes=N`

`pnpm check:deploy-origin -- --minutes=15` grades only deploys created in the last N minutes and
prints `PAGE: GATE-FREE DEPLOY ON bqb1` on BYPASS (exit 1). Choose N >= 2x the scheduler cadence.
Bound by live-SHA identity (never by service name), BLIND on any unreadable leg, as before.
Negative control: `--selftest` ARM C (3-min-old manual row ⇒ BYPASS; same row, `--minutes=1` ⇒ no page).

**Open:** the *scheduler*. The detector needs `RENDER_API_KEY`, which no unattended process on
this side holds. Options: (a) Paperclip routine every 5–10 min (each fire is an LLM heartbeat —
costly, and needs the birth clauses); (b) Task Scheduler on the operator machine running the
one-liner, notifying on non-zero exit; (c) a bqb1-side self-check at boot — rejected, it needs
the key on the money host and still only observes after the boot. Recommendation: (b), with (a)
at 15-min cadence as the fallback. Needs an owner decision.

## Item 3 — census: real-money keys invisible to BOTH instruments

Method: every env name read by non-test `packages/{server,engine}/src` on `origin/main`, constants
resolved to their string values, narrowed to names that arm/route/size/bound live orders, minus
keys declared in `render.yaml` (env-drift's universe) minus the 14 `envIntent` levers.
`env-drift` is blind to an undeclared key; `envIntent` only covers its 14 rows.

**Blind to both (no `render.yaml` row, no `envIntent` row)** — loosening any of these is invisible:

- *Arming / routing:* `ENABLE_OPTION_IDEAS_AUTO_EXECUTE`, `OPTION_IDEAS_AUTO_EXECUTE_TOP_N`,
  `ENABLE_LIVE_CANARY`, `OPTION_LIVE_TEST_UNTIL`, `OPTION_LIVE_OTM_UNIVERSE` (+`_RATIFIED`,`_RATIFIED_BY`),
  `OPTION_LIVE_OTM_ONESHOT_COSTBAR_BYPASS`, `ENABLE_ORDER_SPLITTING`, `LIVE_EQUITY_STOP_MODIFY_ENABLED`,
  `ENABLE_ENGINE_ACT_ON_ADOPTED_BROKER_OPTIONS`, `ENABLE_OPTION_IV_RV_ROUTING`, `ENABLE_OPTION_WHEEL_ROUTING`
- *Caps / sizing:* `LIVE_OPTION_TEST_NOTIONAL_CAP_USD`, `LIVE_OPTION_TEST_AGGREGATE_CAP_USD`,
  `LIVE_OPTION_TEST_MAX_CONTRACTS`, `LIVE_OPTION_TEST_FLEET_RISK_FRACTION`, `LIVE_OPTION_CANARY_CEILING_USD`,
  `OPTION_LIVE_AVERAGE_DOWN_{ENABLED,MAX_ADD_USD,BAND_MIN_PCT,BAND_MAX_PCT,MIN_DTE}`,
  `OPTIONS_RISK_THROTTLE_SIZING_ENABLED`, `RISK_THROTTLE_SIZING_ENABLED`, `WHEEL_IV_FILTER_MARGINAL_SIZE_MULT`,
  `TRADING_AGENTS_OPUS_NOTIONAL_USD`
- *Enforcement / stops (a flip to off or a looser value removes a guard):* `ENABLE_OPTION_COST_GATE_LIVE_ENFORCE`,
  `ENABLE_OPTION_LIQUIDITY_LIVE_ENFORCE`, `ORDER_QUOTE_GUARD_ENFORCE`, `ORDER_MAX_SLIPPAGE`,
  `ORDER_MAX_QUOTE_AGE_MS`, `OPTION_SPREAD_CEILING_ENFORCE`, `ENABLE_OPTION_ENTRY_DELTA_CEILING_LIVE`,
  `OPTION_ENTRY_DELTA_CEILING`, `ENABLE_OPTION_OTM_DELTA_FLOOR_LIVE`, `OPTION_OTM_DELTA_FLOOR_LIVE`,
  `ENABLE_SHADOW_EXPECTANCY_GUARD_ENFORCE`, `OPTION_LIVE_STOP_{POLICY,CATASTROPHIC_PCT,CLOSE_WINDOW_MIN}`,
  `OPTIONS_HALT_SCOPE`, `TAKE_PROFIT_EARLY_LIVE_ENABLED`, `RV_EXIT_RETUNE_LIVE_ENABLED`

**Declared in `render.yaml` but without an `envIntent` row** (drift sees a *change from the yaml*, not
a change from *authorised intent*): `EXIT_RISK_RULES_ENABLED`, `ENABLE_CHURN_LOSS_BRAKE`,
`BOOK_GIVEBACK_ARM_FLOOR_ENABLED`, `ENABLE_OPTION_COST_AWARE_GATE`, `TRADIER_ACCOUNT_ID`,
`TRADIER_API_TOKEN` (which account/credential the money host trades).

Caveats: the name-narrowing is by pattern, so it is a superset in places (some listed keys are
observe-only) and may miss a lever with an unremarkable name; `ENABLE_OPTION_LIVE_OTM` itself *is* in
`envIntent` (that is what caught it). Several of the above are already carried by the `LIVE_LEARNING_BUDGET_*`
family's sibling levers in intent — re-verify per key before adding rows.

**Recommendation (finding, not built here):** make `envIntent` row-coverage a CI-enforced property —
any key that a `*_LIVE_*`/`*_ENFORCE`/`*_CAP_*`/`*_ARM_*` read resolves to must appear in `render.yaml`
or `envIntent`, else `check:env-intent` fails. That converts this one-time census into a guard; it
is a separate card because each new `envIntent` row needs an owner-ratified expected value.
