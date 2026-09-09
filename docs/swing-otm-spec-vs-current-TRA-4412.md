# The proposed swing-OTM spec vs. what we actually run (TRA-4412)

**Author:** CTO · **Date:** 2026-09-09
**Measured against:** bqb1 live build `c7b452c0fc92`, routes `/api/health/live-enforce-gates`,
`/api/health/options-live`, `/api/health/rv-scan`, read 2026-09-09T00:35–00:38Z.
**Code basis:** `main` @ `cb9d594f`.

---

## 0. Bottom line

1. **The spec is not a new direction for us — it is, almost line for line, the design this desk
   already ratified in August** (board card `a29b2db8` / TRA-3944, 2026-08-22). Preferred |Δ|
   0.25–0.40, DTE 21–45, no 0DTE, hard-refuse ≤7 DTE, refuse rather than clamp, risk ~1% of equity,
   underlying-thesis stops, no same-session round trips — all of that is shipped code with tests.
2. **And we then deliberately moved OFF the spec's parameters, on measured evidence.** The live
   contract floor is env-overridden to |Δ| **[0.495, 0.55]**, not [0.25, 0.40]. The reason is
   TRA-3392: on n=1073 model-facing closes, the |Δ| band the spec prefers was *unproven* and the
   deep-OTM band below it was *significantly negative*. So the interesting question the spec raises
   is not "should we build this" but **"was moving off 0.25–0.40 right?"** — and that is a live,
   pre-registered test (TRA-4053), not an opinion.
3. **Nothing in this sleeve is trading right now, by board decision.** Live entry window is
   `03:00-03:01 ET` — a 60-second window that cannot intersect RTH. That is the executed form of the
   board's HOLD on TRA-4217 (card `ec5ba87f`). Last `buy_to_open` was **2026-09-01**. Entry-window
   refusals: 607/607 on 09-02, 671/671 on 09-03.
4. **Even if the hold lifted, the cost bar admits nothing.** All eight delta buckets read
   `admits: false` against `barR = 0.385`, including the previously-authorized 0.50–0.55 cell
   (lo95 **+0.362** < 0.385). The `directional` path admitted **0 of 17,063** decisions over four ET
   days. Our binding constraint is *cost*, and the spec has almost nothing to say about it.
5. **The genuinely net-new engineering in the spec is small and specific:** term-structure /
   cross-expiry relative value, IV *percentile* (distinct from the IV *rank* we have), relative
   strength vs SPY/QQQ/sector, and a single declared 0–100 composite score. Four items, all real.

---

## 1. Live state, as measured

| Gate | Live value | Note |
|---|---|---|
| `liveOtmArmed` / `liveOtmRouting` | `true` / `true` | sleeve armed |
| `otmEntryWindows` | `03:00-03:01 ET` (env) | **cannot intersect RTH** — the TRA-4217 hold |
| `otmContractFloor.deltaBand` | **[0.495, 0.55]** (env) | compiled/ratified default is [0.25, 0.40] |
| `otmContractFloor.dteBand` | **[10, 45]** (env) | compiled/ratified default is [21, 45] |
| `otmContractFloor.premiumMin` | $0.50 | matches the card |
| `otmContractFloor.dteHardFloor` | 7 | unspellable hard refuse |
| `admissibleStrike` selector band | [0.50, 0.55) armed | `bandIntersectsSelector: true` |
| `entryDeltaCeiling` | mode **`observe`**, ceiling 0.55 | TRA-3394 — the mandate ceiling is *still not enforced* |
| `costBar` | armed, `barR` 0.385 | `spreadCrossR` 0.235 is the dominant term |
| `costBar` ratification | `matchesLive: "unstamped"` | whether 0.1 safety margin is board-ratified is UNKNOWN from the route |
| `otmDeltaFloor` / `spread` enforce | `armed: false` / `armed: false` | |
| `universe` | unrestricted (`*`), ratified `5fc18af7` | |
| `rv_scan` / `directional` / `otm` paths | `armed_but_never_ran` since 20:49Z boot | market closed; not a defect |

### The delta tape the bar is reading (`tape_expectancy_lower_ci95`, minCellN 30)

| \|Δ\| bucket | n | mean R_gate | lo95 | admits @ 0.385 |
|---|---|---|---|---|
| 0.00–0.10 | 642 | −0.126 | −0.177 | no |
| 0.10–0.20 | 53 | −0.212 | −0.345 | no |
| **0.20–0.30** | 66 | **+0.125** | −0.063 | no |
| **0.30–0.40** | 124 | **+0.278** | −0.215 | no |
| 0.40–0.45 | 29 | −0.434 | −2.170 | no |
| 0.45–0.50 | 59 | +0.728 | −0.115 | no |
| 0.50–0.55 | 110 | +1.129 | +0.362 | no |
| 0.55–1.00 | 21 | −1.036 | −2.221 | no |

Two readings matter here.

**(a) The spec's preferred band is *unproven*, not *disproven*.** 0.20–0.40 is n=190 with positive
point estimates in both cells. Neither clears the bar, but neither is the disaster cell. The band we
have real evidence *against* is 0.00–0.20 (n=695, significantly negative) — which is the band the
sleeve used to hunt under the old "OTM Mispricing" mandate. The spec is directionally correct to
move away from far-OTM; it just lands in a band we cannot yet justify with money.

**(b) The authorized cell has degraded.** TRA-3392 §1 authorized [0.495, 0.55) on lo95 **+0.799**
at n=100 (2026-08-12). The same cell today reads lo95 **+0.362** at n=110. Ten more closes roughly
halved the lower bound. ⚠️ This is *not* a §6 tripwire firing — §6 tripwire 2 is scoped to the
**LIVE cohort**, and the health route's cell is the full model-facing tape. But it is close enough
to the tripwire's threshold (0.485) that someone should compute the tripwire on its own basis before
the next arm decision. Flagged, not concluded.

---

## 2. Scorecard, section by section

Legend: ✅ shipped · 🟡 partial / shipped-but-off · ❌ absent

### Option parameters
| Spec | Us |
|---|---|
| DTE 21–60 (pref 25–45) | 🟡 ratified default [21,45] ✅; **live env is [10,45]** — looser than both the spec and our own card |
| No 0DTE, no 1–7 DTE | ✅ `DAY_TRADING_GUARDRAIL.minEntryDteDays=7`, `minIdeaDteDays=21`, plus `dteHardFloor: 7` that is not env-spellable |
| \|Δ\| 0.25–0.40 | 🟡 ratified default ✅ (`otm-contract-floor.ts`), **live env [0.495,0.55]** on TRA-3392 evidence |
| Avoid extremely far OTM | ✅ and better than the spec — we have the tape proving why (n=695) |
| Avoid illiquid / wide spread | 🟡 `option-spread-cost.ts`, `liquidity-gate.ts`, `pre-trade-liquidity` exist; `ENABLE_OPTION_LIQUIDITY_LIVE_ENFORCE` is **`armed: false`** |

### Swing setups (calls / puts)
| Spec | Us |
|---|---|
| Uptrend / pullback to support | 🟡 `options/swing-entries.ts` EMA-pullback archetype — shipped, flag `ENABLE_OPTION_EMA_PULLBACK` **off** |
| Breakout from consolidation + volume confirmation | 🟡 `volumeConfirmedBreakout` (Donchian + above-average volume) — shipped, flag **off** |
| HH/HL structure, MA reclaim/failure | ✅ `indicators/` (patterns, donchian, ema/ma, supertrend, ichimoku, support-resistance, adx, mtf) |
| Relative strength vs SPY/QQQ or sector | ❌ **absent** — no cross-sectional RS anywhere on the options path |
| Momentum expansion / deterioration | ✅ `macd`, `rsi`, `efficiency-ratio`, `choppiness`, `adx` |

### OTM mispricing engine (the spec's 10 measurements)
| # | Spec | Us |
|---|---|---|
| 1 | Current IV | ✅ `smvVol → midIv → BS-implied` fallback chain |
| 2 | Historical IV percentile | ❌ **absent** — see note below |
| 3 | IV rank | ✅ `iv-rank-store.ts`, 366-day window, `MIN_IV_SAMPLES=20`, honest `null` when cold |
| 4 | IV vs neighbouring strikes | ✅ `options/relative-value.ts` — quadratic IV(log-moneyness) OLS fit + residual z-score |
| 5 | IV vs same delta, other expirations | ❌ **absent** — the fit is grouped by `(expiration, type)`; there is no term-structure dimension anywhere |
| 6 | IV vs historical vol | ✅ `options/iv-rv-mispricing.ts` (VRP read, BUY/SELL_PREMIUM) |
| 7 | IV vs expected forward vol | ❌ absent |
| 8 | IV-surface residual | ✅ `ivResidual` / `zScore` — but within-expiration only (see #5) |
| 9 | Expected underlying move | 🟡 ATR + realised vol are computed and used for stops/sizing; no published "expected move" field on a card |
| 10 | Break-even probability | ✅ `options-pop-calibration.ts` — and it is *calibrated*, not just modelled |

> ⚠️ **#2 and #3 are different statistics and we should not conflate them.** `iv-rank-store.ts`
> implements IV **rank** — `(IV − min)/(max − min)` over the trailing window, the tastytrade
> definition. IV **percentile** — the fraction of trailing days below today's IV — is a different
> number and is more robust to a single spike setting the window max. The spec asks for both. We
> have the samples on disk to compute percentile; it is a small pure function, not a data project.

### Fair-value model
✅ Shipped and slightly stronger than the spec asks. `relative-value.ts` fits the skew, derives
`ivFitted`, prices `fairPrice` off it, emits `mispricingPct` and a z-score, and ranks by statistical
significance — exactly the spec's "IV Mispricing = Fair IV − Actual IV, ranked by magnitude and
significance". On top of that `otm-mispricing.ts` applies a **PAVA monotone repair** to the theo
surface and `otm-theo-arbitrage.ts` runs a static no-arbitrage detector with `mark` as a negative
control. The spec has no equivalent of that last piece and it is the thing that caught our model
being incoherent 11 times in 143 rows.

**Constraint:** the fit is per `(expiration, optionType)`. The spec's own worked AAPL example —
"comparable 30Δ calls across expirations: 34–37%" — is precisely the comparison we cannot make.

### Swing score
❌ No 0–100 composite with declared weights. What we rank on today is a mix of `|mispricingPct|`,
the RV z-score, and bounded learned multipliers (`learned-option-weights.ts`, folded from realised
journal outcomes by structure / IV-rank band / trend regime / sentiment band / DTE band).

Worth knowing before adopting the spec's scorer: **ranking on `|mispricingPct|` is a mechanism we
have already caught misfiring.** TRA-3942 found 15 of 17 live entries filled 13:35–13:51Z, because
the overnight gap is the largest mispricing print on the chain — the scanner was ranking the gap,
not the setup. A composite that puts 25% weight on mispricing needs that failure mode designed out.

Also: the spec's "only consider trades scoring ≥75" is an *unratified threshold*. Under TRA-3392 §6
we do not pick thresholds — we pre-register them and let evidence set them. A 75 chosen up front is
exactly the kind of number that later gets retuned to fit the result.

### Holding period / entry / exit / profit-taking / stops
| Spec | Us |
|---|---|
| 3–20 day hold, never close just because the day ended | ✅ `blockSameSessionRoundTrip: true` (risk exits exempt); overnight/weekend holds are the default |
| Enter only on confirmation | 🟡 archetypes shipped, flags off; **plus** a time gate the spec lacks: TRA-3942 restricts opens to 10:15–11:30 and 15:00–15:45 ET |
| Underlying price action as primary exit | ✅ `otmAtrInvalidationLevel` stamped at entry (`underlyingEntryPrice ∓ atrMult × ATR(14)`) — this *is* the structural-invalidation stop |
| Profit target ladder, tested not assumed | ✅ `otm-profit-schedule.ts` — TP1 50%, profit-lock arm 0.75R, give-back 0.40R, tighten 0.25R, all env-recuttable with whole-set fail-closed |
| Trailing stop on underlying | ✅ chandelier / trail exits (TRA-3941) |
| Re-evaluate after 7–10 trading days | ⚠️ **we run 4.** `OPTION_SWING_TIME_STOP_TRADING_DAYS` defaults to **4** trading days — materially tighter than the spec, and tighter than our own 3–20 day target hold |
| Never decay into final 14 DTE without reason | ❌ no explicit min-DTE exit rule |
| Absolute max loss | ✅ premium stop −35% intraday from day one (TRA-3943) + −20% daily-close backstop |

### Position sizing
✅ `DEFAULT_RISK_PER_TRADE = 0.01` (1%), sized from stop distance (`risk.sizeFromStop`), vol-scaled
(`vol-kelly-sizer.ts`), correlation-capped (`correlation-cap.ts`, `correlated-exposure-ledger.ts`),
fleet-capped, with hard caps ($300/$500) and a drawdown brake. Max 2 contracts per entry, max 1 open
row per underlying. No martingale, no automatic averaging down (`option-average-down-shadow.ts` is
shadow-only). The spec wants 0.5–1.0%; we sit at the top of that range — worth a conscious choice
rather than a default.

### Event filter
🟡 The pieces exist but they are not wired into *this* sleeve.
- `strategy-selector.ts` has a **hard** earnings gate for long premium — but the OTM/RV nomination
  path does not route through it.
- `catalyst-gate.ts` (earnings + FOMC/CPI/NFP proximity) is **equity-only and observe-only**
  (`ENABLE_CATALYST_EARNINGS_GATE` off, awaiting a D2 out-of-sample grade).
- `supertrend-options.ts` has `catalystInsideExpiry` logic.
- Earnings and macro calendars are plumbed and today mostly decorate cards as badges.

The spec's sharpest single idea is here: **"reject a trade if the option is cheap for a legitimate
reason."** We have no such rejector on the OTM path. Today a cheap contract is cheap; we never ask
why. That is a real hole and it is cheap to close.

### Liquidity, market regime, agent structure
- Liquidity: modules exist, **live enforcement is off** (`spread.armed: false`).
- Regime: ✅ `regime.ts` (ADX/ATR/MA-slope → trend_up/trend_down/range/high_vol/flat), VIX and macro
  plumbed. ❌ no breadth, ❌ no correlation-to-regime check on the options entry.
- Agents: 6 of the spec's 8 exist in recognisable form. `packages/agents/graph.ts` runs
  analysts → debate → trader → **risk panel last**, so "no agent may bypass the Risk Agent" is
  already structural. Missing as *owned* components: a **Volatility Agent** that owns a surface
  (today vol logic is spread across three modules with no term structure), and a consolidated
  **Trade Card**.

### Trade card
🟡 Most of the ~30 fields exist somewhere. Not assembled into one artifact. Absent entirely:
Fair IV, IV mispricing, IV percentile, expected move, catalyst, and — the one I would fight for —
**"reasons NOT to enter."** A card that only argues for the trade is a card that cannot be
audited afterwards.

### Backtesting posture
✅ Strong, and ahead of the spec. `packages/backtest` has walk-forward (`run-optimization.ts`),
out-of-sample harness (`oos-option-weights-harness.ts`), bootstrap, Monte Carlo,
`overfitting-stats.ts`, options chain replay against recorded Tradier chains, realistic fee/slippage
modelling (`options-cost-model.ts`, `live-options-fee-slippage-ledger.ts`), and pre-registered
evaluation windows with a named human verdict owner (TRA-3945). Paper mirrors live by construction.

---

## 3. What we should actually take from this

**Adopt (high value, low cost):**

1. **"Cheap for a legitimate reason" rejector on the OTM/RV path.** Route the nomination through the
   existing earnings/macro calendars before it can be ranked. This is the spec's best idea and we
   have the data already loaded.
2. **IV percentile alongside IV rank.** Small pure function over samples already on disk. Two
   independent reads of the same question are worth more than one, and percentile degrades more
   gracefully than rank.
3. **The consolidated trade card, including "reasons NOT to enter."** Makes every nomination
   auditable after the fact, which is what we keep wishing we had when a cohort goes wrong.

**Build (real engineering, worth doing):**

4. **Term structure / cross-expiry relative value.** This is the spec's genuine addition to our
   model. It is also the safer of the two edges — comparing a 30Δ call to other 30Δ calls needs far
   less model trust than comparing it to a theoretical fair value, which is exactly the argument the
   spec makes in its closing section, and I agree with it.
5. **Relative strength vs SPY/QQQ/sector.** Currently absent. Cheap to compute, and it is the
   dimension most likely to separate a good swing setup from a mediocre one.

**Decide (not build):**

6. **The 4-day vs 7–10-day time stop.** Direct contradiction between shipped behaviour and both the
   spec and our own stated 3–20 day hold. Env-recuttable, no code change. QuantTrader's call.
7. **Live DTE floor 10 vs ratified 21.** The live env is looser than the board card. Either
   re-ratify 10 or restore 21; today they silently disagree.
8. **Risk per trade 1.0% vs the spec's 0.5–1.0%.** We sit at the ceiling by default.
9. **`entryDeltaCeiling` still `observe`.** TRA-3392 §3 called arming this "the first item of the
   implementation ticket" on 2026-08-12. It is still observe-only, so the live admitted set exceeds
   its authorization at the top end.

**Do NOT adopt:**

10. **The ≥75 score threshold as written.** Pick thresholds by pre-registration, per TRA-3392 §6.
11. **A composite that ranks on mispricing magnitude without a gap guard.** See TRA-3942.
12. **The spec's silence on cost.** It treats "positive EV after spread, slippage and fees" as one
    bullet. For us it is *the* binding constraint: `barR` 0.385 of which `spreadCross` is 0.235, and
    zero of eight delta buckets clear it. Any adoption of this spec that does not lead with cost
    will produce a scanner that nominates beautifully and never fills profitably.

---

## 4. The honest summary for the board

We are not behind this spec on design. We are ahead of it on cost modelling, no-arbitrage checking,
calibration, pre-registration discipline and backtest rigour, and level with it on parameters — we
ratified its exact numbers three weeks ago.

Where we are behind is **evidence**. The sleeve is held closed, the cost bar admits nothing, and the
band this spec prefers (0.20–0.40) has 190 closes with positive means and no significance. TRA-4053
is the pre-registered demo forward test that resolves precisely that question, and it armed
2026-09-08. The most useful thing this spec can do for us is not to become a build ticket — it is to
sharpen what TRA-4053 has to prove.

Under the TRA-4383 feature freeze (to 2026-09-18) nothing here is code work today. Items 1–5 are
post-freeze; items 6–9 are decisions that can be taken now.
