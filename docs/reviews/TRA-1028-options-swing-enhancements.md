# TRA-1028 — Options swing enhancements (EMA-pullback + volume breakout + DTE review)

Author: LeadDev (agent d3355d6d)
Date: 2026-06-23
Parent review: docs/reviews/TRA-1026-options-swing-playbook-review.md
Depends on (shipped): TRA-1024 (IVR ceiling + high-IVR spread routing + earnings
gate), TRA-1025 (structure-aware exits). Both already landed on the executing RV
path behind `ENABLE_OPTION_EXEC_SELECTOR`, so the IV-aware / structure-exit-aware
foundation this issue layers onto is in place.

## Scope delivered

All three net-new playbook items from the TRA-1026 review, each flag-gated and
OFF by default, layered on top of the exec flag so neither prod nor the baseline
exec path changes until QuantTrader signs off on the shadow/paper readout.

### 1. EMA-pullback (Trend-Pullback) entry archetype

- Pure engine trigger `emaPullbackTrigger(candles, side)` in
  `packages/engine/src/options/swing-entries.ts`. A call fires only when: last
  close is above the 21 EMA AND the 9 EMA is above the 21 EMA (uptrend
  structure), a bar within the last 3 has pulled back to the 9 EMA band, and the
  latest bar is a bullish reversal candle (hammer / bullish-engulfing, or a
  simple up-close reclaim). Mirror inverse for puts.
- Wired into `runRelativeValueScan` (signal-engine.ts) behind
  `isOptionEmaPullbackEnabled()` (= exec flag AND `ENABLE_OPTION_EMA_PULLBACK`).
  When on, the bare RV long must ALSO pass the Trend-Pullback trigger on the
  trend side before opening; otherwise the symbol stands down. The fill is tagged
  on the signal `reason` (`… | ema-pullback: …`) and logged so the ledger readout
  can attribute fills to the archetype.
- Reads the same cached 5m shadow series the trend confluence already uses — no
  new I/O.

### 2. Volume-confirmed breakout

- Pure engine trigger `volumeConfirmedBreakout(candles, side)` — a Donchian
  breakout *close* beyond the channel (excluding the current bar so the break is
  not a tautology) that also clears `avgVolume * 1.5`, where the average excludes
  the breakout bar itself (so one huge bar can't clear its own threshold).
- Wired into the TRA-1024 high-IVR spread-routing block behind
  `isOptionVolumeBreakoutEnabled()` (= exec flag AND
  `ENABLE_OPTION_VOLUME_BREAKOUT`). When on, the `highConvictionBreakout` signal
  fed to the disciplined selector requires volume confirmation; off, it falls
  back to the existing volume-blind Donchian close. This makes a volume-confirmed
  breakout eligible on the EXECUTING path (the high-IVR routing runs there post
  TRA-1024), not just the shadow/paper selector.

### 3. DTE-window review (tunable, not hard-changed)

- The engine selector `selectRvLongCandidate` already accepts
  `dteEntryMin`/`dteEntryMax` (defaults 30/45 = `RV_LONG_DTE_ENTRY_*`, TRA-970).
- `resolveRvLongDteOverride()` exposes `OPTION_RV_LONG_DTE_ENTRY_MIN` /
  `OPTION_RV_LONG_DTE_ENTRY_MAX` env overrides, plumbed into the selector call.
  Absent/invalid values pass `undefined` → the 30/45 default stands, so current
  behaviour is unchanged until tuned. An inverted min>max pair is rejected as a
  unit (both fall back) so the window can never invert.
- **NOT hard-changed.** Per the issue, the default stays 30/45 pending
  QuantTrader sign-off.

#### Theta / leverage trade-off (the requested report)

The playbook recommends 45–90 DTE for pullback swings (30–60 for breakouts) vs
our current 30–45. The trade-off of widening the long window toward 45–90:

- **Theta (in our favour to widen).** Theta decay accelerates non-linearly into
  expiry; the steepest bleed is the last ~30 days. A 30-DTE long sits squarely in
  the accelerating zone, so a swing that takes 1–2 weeks to play out pays a large
  time premium even when the directional thesis is right. 45–90 DTE keeps the
  position on the flatter part of the decay curve, so a slow-but-correct swing is
  not bled out before it works — exactly the failure mode a trend-pullback entry
  is exposed to.
- **Leverage / cost (against widening).** Longer-dated contracts cost more
  premium for the same delta, so per-contract notional rises and the per-ticket
  dollar cap admits fewer contracts — lower leverage per dollar of risk. Absolute
  dollar risk per ticket is unchanged (sizing is budget-ratio based), but the
  capital efficiency (delta exposure per premium dollar) falls.
- **Vega (context-dependent).** Longer-dated longs carry more vega, so they
  benefit more from an IV expansion and suffer more from IV contraction. Post
  TRA-1024 the executing long path is IVR-gated (≤25), i.e. we only buy bare
  longs when IV is already low — which makes the added vega a tailwind on average
  (more room for IV to expand than contract), reducing the usual objection to
  longer-dated longs.
- **Net.** Widening toward 45–60 DTE is the low-risk first step: it captures most
  of the theta relief while keeping leverage and bid/ask drag reasonable.
  Pushing to 90 DTE is a larger leverage/cost concession that should be justified
  by the readout, not assumed. **Recommendation to QuantTrader:** A/B 30–45
  (control) vs 45–60 (treatment) first; only extend to 45–90 if the readout shows
  the longer window improves realised P&L per theta paid.

## Before / after validation framework (shadow/paper)

Each item is a flag, so the before/after readout is a flag-off vs flag-on
comparison in the shadow/paper ledger — no default behaviour changes meanwhile.

1. Baseline (control): exec flag on, all three sub-flags OFF, default 30/45 DTE.
   Accrue the existing RV-long fills for the comparison window.
2. Treatment, one flag at a time (isolate the effect):
   - `ENABLE_OPTION_EMA_PULLBACK=1` — expect FEWER, higher-quality fills
     (entries gated to trend-pullback setups). Compare fill count, win rate, and
     avg P&L per fill vs control.
   - `ENABLE_OPTION_VOLUME_BREAKOUT=1` — expect fewer high-IVR spread routes
     (volume-blind pokes filtered out). Compare spread-route count and outcome.
   - `OPTION_RV_LONG_DTE_ENTRY_MIN=45` / `_MAX=60` — compare theta paid and
     realised P&L per ticket vs the 30/45 control per the trade-off above.
3. Sign-off gate: QuantTrader reviews the readout; only an approved item is
   promoted to default-on. Live-capital promotion of anything here stays gated on
   TRA-382 regardless.

## Tests

- `packages/engine/src/options/swing-entries.test.ts` — 8 tests (EMA-pullback
  fire/no-fire across trend/pullback/reversal legs; volume-breakout fire on
  above-avg volume, no-fire on below-avg volume / inside-channel; put breakdown).
- `packages/server/src/option-exec-flag.test.ts` — 8 tests (sub-flags require the
  exec flag; DTE override parse / reject non-positive / reject inverted pair /
  one-sided).
- Engine `tsc --noEmit`: clean. Server `tsc --noEmit`: only the two pre-existing
  baseline errors (`DEFAULT_4H_SYMBOLS`, `reviewBlock`), zero new.
- `signal-engine.test.ts`: 21 pre-existing failures (documented baseline on clean
  main), 150 passing — zero new failures from this change (all new gates default
  OFF).

## Disposition

Code shipped flag-gated + tested. The remaining acceptance step — the
shadow/paper before/after readout and the promote-to-default decision — is owned
by QuantTrader (sign-off gate above). Handing to QuantTrader for that
validation; no default prod behaviour changes until then.
