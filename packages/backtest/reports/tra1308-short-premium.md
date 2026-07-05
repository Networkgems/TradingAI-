# TRA-1308 Phase A — Short-premium demo-routing GO/NO-GO

**Generated:** 2026-07-04T00:00:00Z
**Engine:** findShortPremiumStructures (packages/engine) — live scanner code
**Data:** 32 days 2026-05-15..2026-07-02 (recorded Tradier chains, TRA-1049 mirror)
**Gates:** ivRank>=50, short|Δ|0.15-0.30, IV/RV>=1, credit/width>=0.10, DTE 7-60, liquidity OI>=500/vol>=100
**Fills:** maker=mid credit; taker=sell@bid/buy@ask credit; managed exit closes maker@mid / taker@ask-bid

## Verdict (primary bar = routed / taker / managed)

- **Routed · taker · managed (50% TP):** **INSUFFICIENT** — n=12 < 20
- Routed · taker · hold-to-expiry: INSUFFICIENT — n=12 < 20

> Primary bar = routed / taker / managed (what demo routing would actually earn). GO requires taker expectancy >=0.05R and PF >=1.2 at n>=20.

## Coverage

- Symbol-days scanned (ivRank≥50, RV available): **547**; produced ≥1 candidate: **135**
- Settleable structures opened: **403**; routed (top-per-symbol, one-open): **13**
- Skipped — no IV-rank: 225; no realised-vol: 0
- Top entries dropped as **unsettleable** (expiry beyond capture window): 109

## Routing proxy (top structure per symbol-day, one open per symbol)

| view | fill | result |
|---|---|---|
| hold-to-expiry | maker | n=13 exp=-0.098R med=0.127R WR=77% PF=0.58 worst=-1.00R p05=-1.00R maxLossHit=23% [estPoP=79% cr/w=16% dte=17] |
| hold-to-expiry | taker | n=12 exp=-0.150R med=0.099R WR=75% PF=0.40 worst=-1.00R p05=-1.00R maxLossHit=25% [estPoP=79% cr/w=17% dte=18] |
| managed 50% TP | maker | n=13 exp=-0.041R med=0.119R WR=85% PF=0.73 worst=-1.00R p05=-1.00R maxLossHit=15% [estPoP=79% cr/w=16% dte=17] |
| managed 50% TP | taker | n=12 exp=-0.166R med=0.062R WR=75% PF=0.34 worst=-1.00R p05=-1.00R maxLossHit=25% [estPoP=79% cr/w=17% dte=18] |

### Routed · taker, by structure

| structure | managed 50% TP | hold-to-expiry |
|---|---|---|
| put_credit_spread | n=9 exp=-0.245R med=0.062R WR=67% PF=0.26 worst=-1.00R p05=-1.00R maxLossHit=33% [estPoP=79% cr/w=19% dte=18] | n=9 exp=-0.230R med=0.103R WR=67% PF=0.31 worst=-1.00R p05=-1.00R maxLossHit=33% [estPoP=79% cr/w=19% dte=18] |
| call_credit_spread | n=3 exp=0.074R med=0.082R WR=100% PF=∞ worst=0.06R p05=0.06R maxLossHit=0% [estPoP=79% cr/w=12% dte=17] | n=3 exp=0.088R med=0.082R WR=100% PF=∞ worst=0.07R p05=0.07R maxLossHit=0% [estPoP=79% cr/w=12% dte=17] |
| iron_condor | n=0 | n=0 |

## All candidates (every settleable structure the scanner surfaced)

| view | fill | result |
|---|---|---|
| hold-to-expiry | maker | n=403 exp=0.040R med=0.133R WR=81% PF=1.32 worst=-1.00R p05=-1.00R maxLossHit=6% [estPoP=72% cr/w=17% dte=17] |
| hold-to-expiry | taker | n=401 exp=0.001R med=0.116R WR=80% PF=1.01 worst=-1.00R p05=-1.00R maxLossHit=6% [estPoP=72% cr/w=18% dte=17] |
| managed 50% TP | maker | n=403 exp=0.038R med=0.116R WR=85% PF=1.38 worst=-1.00R p05=-0.99R maxLossHit=5% [estPoP=72% cr/w=17% dte=17] |
| managed 50% TP | taker | n=401 exp=-0.004R med=0.095R WR=84% PF=0.97 worst=-1.00R p05=-1.00R maxLossHit=6% [estPoP=72% cr/w=18% dte=17] |

## Caveats

- **Forward window is short** (2026-05-15..2026-07-02, IV-rank only populated from 2026-05-29). Sample is trade-level, not independent: consecutive-day same-symbol entries are correlated; the routing proxy applies a one-open-per-symbol filter to reduce this.
- **Settlement bias:** only structures expiring within the capture window are scored, tilting the sample toward shorter DTE. Longer-dated candidates (109 top entries) are excluded.
- Held-to-expiry ignores pin/assignment risk and early-assignment on American options; managed exit assumes daily (not intraday) monitoring at the recorder's ~15:55 ET mark.
- No commissions modelled (≈$0.65/contract/leg would shave taker expectancy further).
