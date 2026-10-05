# TRA-5145 — per-stage attrition census (universe → cost-bar arrival)

Captured 2026-10-05T06:41Z off bqb1 build `dc513fbac4f8` (booted 2026-10-05T01:11:03Z), read-only.
Generator: `scripts/tra5145-attrition-census.mjs` (re-run after each repair to show the number moved).

Sources: `/api/health/rv-scan` censusByEtDay (30d), `/api/health/equity-entry-funnel` retained (30d),
`/api/health/cost-aware-gate` retained (7d, demo ledger), `/api/health/otm-admission-tape` (per-contract
first-binding gate, desk class).

## OTM candidate-generation sub-attribution (otm-admission-tape, desk)

2026-10-02: 7,993 contract rows -> max_spread_pct 51.5% | min_open_interest 19.2% | min_abs_delta 4.5% | min_mark 1.8% | admitted 23.1%
2026-10-01: 12,119 contract rows -> max_spread_pct 56.0% | min_open_interest 19.2% | min_abs_delta 3.4% | min_mark 1.5% | admitted 19.9%

## Census: session 2026-10-02 (most recent complete session; NB: Yahoo-breaker outage day for the EQUITY sleeve)

```
TRA-5145 attrition census  2026-10-02..2026-10-02
host https://tradingai-bqb1.onrender.com  build dc513fbac4f8  read 2026-10-05T06:41:45.951Z
rv-scan verdict armed_but_never_ran  rthStaleness {"etDay":"2026-10-05","session":"session","lastScanAt":null,"ageMs":null,"thresholdMs":900000,"graceMs":900000,"sessionOpenUtc":"2026-10-05T13:30:00.000Z","sessionCloseUtc":"2026-10-05T20:00:00.000Z","state":"out_of_session","ok":true,"inRth":false,"reason":"pre-open on 2026-10-05 (session opens 2026-10-05T13:30:00.000Z) — scan silence is the clock, not an outage."}

--- directional | desk | demo
scans 72  evaluated 7200  passed 2  opensPlaced 2  blindScans 0
bar arrivals 325 (4.514% of evaluated)
  feed/scan                    205  2.847%
      scan:no_expirations                    178  2.472%
      scan:no_spot                            27  0.375%
  candidate generation         231  3.208%
      no_shadow_series                       231  3.208%
  strategy gates              5723  79.486%
      no_trend_confluence                   5722  79.472%
      recent_duplicate                         1  0.014%
  contract selection           182  2.528%
      quality_gate:min_price                 161  2.236%
      quality_gate:min_dollar_volume          21  0.292%
  spread ceiling               534  7.417%
      spread_ceiling                         534  7.417%
  cost bar                     323  4.486%
      cost_aware_bar                         323  4.486%

--- otm | desk | demo
scans 73  evaluated 7300  passed 0  opensPlaced 0  blindScans 0
bar arrivals 0 (0.000% of evaluated)
  feed/scan                   2409  33.000%
      scan:no_expirations                   2117  29.000%
      scan:no_spot                           292  4.000%
  candidate generation        2494  34.164%
      no_candidates                         2494  34.164%
  contract selection          2397  32.836%
      contract_floor_delta                  2359  32.315%
      contract_floor_premium                  38  0.521%

--- otm | desk | live
scans 221  evaluated 22100  passed 0  opensPlaced 0  blindScans 0
bar arrivals 1767 (7.995% of evaluated)
  feed/scan                   5240  23.710%
      scan:no_expirations                   4649  21.036%
      scan:no_spot                           591  2.674%
  candidate generation        6547  29.624%
      no_candidates                         6547  29.624%
  strategy gates              7029  31.805%
      recent_duplicate                      3573  16.167%
      entry_window_closed                   3456  15.638%
  contract selection          1517  6.864%
      contract_floor_delta                  1099  4.973%
      contract_floor_premium                 393  1.778%
      no_in_band_strike                       25  0.113%
  cost bar                    1767  7.995%
      cost_bar                              1767  7.995%

--- rv_scan | desk | demo
scans 73  evaluated 7300  passed 0  opensPlaced 0  blindScans 0
bar arrivals 0 (0.000% of evaluated)
  feed/scan                   1314  18.000%
      scan:no_expirations                   1022  14.000%
      scan:no_spot                           292  4.000%
  candidate generation        5081  69.603%
      no_candidates                         5081  69.603%
  strategy gates               905  12.397%
      no_trend_aligned_candidate             905  12.397%

--- rv_scan | desk | live
scans 222  evaluated 22200  passed 0  opensPlaced 0  blindScans 0
bar arrivals 8 (0.036% of evaluated)
  feed/scan                   2220  10.000%
      scan:no_expirations                   1628  7.333%
      scan:no_spot                           592  2.667%
  candidate generation       16719  75.311%
      no_candidates                        16719  75.311%
  strategy gates              3253  14.653%
      no_trend_aligned_candidate            3253  14.653%
  cost bar                       8  0.036%
      cost_aware_bar                           8  0.036%

--- equity funnel | 2026-10-02 | demo
passesFired 2861  gated 2083  iterated 778
symbolsConsidered 77800  evaluated 16212  candidates 0  admitted 0
skippedByReason {"insufficient_candles":3861,"off_swing_universe":57655,"stale_feed":72}
candidatesBySource {}  zeroedAtStage no_candidates

--- equity funnel | 2026-10-02 | live
passesFired 8596  gated 7039  iterated 1557
symbolsConsidered 155700  evaluated 32440  candidates 0  admitted 0
skippedByReason {"insufficient_candles":7263,"stale_feed":146,"off_swing_universe":115851}
candidatesBySource {}  zeroedAtStage no_candidates

--- cost-aware-gate demo ledger (7d retained: ["2026-09-28","2026-09-29","2026-09-30","2026-10-01","2026-10-02"])
armed false  admittedTotal 3  rejectedTotal 81318
  directional: admitted 3 (merit 0, bypass 3)  rejected 81299  maxRejectedGrossR -0.1912
  single_leg_rv: admitted 0 (merit 0, bypass 0)  rejected 19  maxRejectedGrossR -0.0511
```

## Census: the CEO ruling's window 2026-09-14..2026-09-18 (retained, 30d surface)

```
TRA-5145 attrition census  2026-09-14..2026-09-18
host https://tradingai-bqb1.onrender.com  build dc513fbac4f8  read 2026-10-05T06:41:46.658Z
rv-scan verdict armed_but_never_ran  rthStaleness {"etDay":"2026-10-05","session":"session","lastScanAt":null,"ageMs":null,"thresholdMs":900000,"graceMs":900000,"sessionOpenUtc":"2026-10-05T13:30:00.000Z","sessionCloseUtc":"2026-10-05T20:00:00.000Z","state":"out_of_session","ok":true,"inRth":false,"reason":"pre-open on 2026-10-05 (session opens 2026-10-05T13:30:00.000Z) — scan silence is the clock, not an outage."}

--- directional | desk | demo
scans 366  evaluated 151665  passed 11  opensPlaced 10  blindScans 0
bar arrivals 286 (0.189% of evaluated)
  feed/scan                  10793  7.116%
      scan:no_spot                          6754  4.453%
      scan:no_expirations                   3613  2.382%
      scan:no_chain                          352  0.232%
      scan:breaker_open                       74  0.049%
  candidate generation       16740  11.037%
      no_shadow_series                     16740  11.037%
  strategy gates            122889  81.027%
      no_trend_confluence                 122881  81.021%
      churn_brake                              7  0.005%
      recent_duplicate                         1  0.001%
  contract selection           166  0.109%
      quality_gate:min_price                 131  0.086%
      quality_gate:min_dollar_volume          31  0.020%
      no_liquid_contract                       4  0.003%
  spread ceiling               791  0.522%
      spread_ceiling                         791  0.522%
  cost bar                     275  0.181%
      cost_aware_bar                         275  0.181%

--- directional | fixture | demo
scans 23300  evaluated 6649755  passed 0  opensPlaced 0  blindScans 197
bar arrivals 19969 (0.300% of evaluated)
  feed/scan                 458248  6.891%
      scan:no_spot                        235143  3.536%
      scan:no_expirations                 202709  3.048%
      scan:no_chain                        18036  0.271%
      scan:breaker_open                     2360  0.035%
  candidate generation      153912  2.315%
      no_shadow_series                    153912  2.315%
  strategy gates           5963485  89.680%
      no_trend_confluence                5962827  89.670%
      churn_brake                            658  0.010%
  contract selection          7005  0.105%
      quality_gate:min_price                5293  0.080%
      quality_gate:min_dollar_volume        1632  0.025%
      quality_gate:per_name_cap               80  0.001%
  spread ceiling             47136  0.709%
      spread_ceiling                       47136  0.709%
  cost bar                   19969  0.300%
      cost_aware_bar                       19969  0.300%

--- otm | desk | demo
scans 433  evaluated 147402  passed 0  opensPlaced 0  blindScans 119
bar arrivals 0 (0.000% of evaluated)
  feed/scan                 138482  93.949%
      scan:no_spot                         89378  60.636%
      scan:no_expirations                  45386  30.791%
      scan:no_chain                         3302  2.240%
      scan:breaker_open                      416  0.282%
  candidate generation        4601  3.121%
      no_candidates                         4601  3.121%
  contract selection          4319  2.930%
      contract_floor_delta                  4214  2.859%
      contract_floor_premium                 105  0.071%

--- otm | desk | live
scans 1268  evaluated 553246  passed 0  opensPlaced 0  blindScans 388
bar arrivals 3633 (0.657% of evaluated)
  feed/scan                 530208  95.836%
      scan:no_spot                        399770  72.259%
      scan:no_expirations                 121449  21.952%
      scan:no_chain                         8204  1.483%
      scan:breaker_open                      785  0.142%
  candidate generation        8722  1.577%
      no_candidates                         8722  1.577%
  strategy gates              7884  1.425%
      entry_window_closed                   6499  1.175%
      recent_duplicate                      1385  0.250%
  contract selection          2799  0.506%
      contract_floor_delta                  2082  0.376%
      contract_floor_premium                 635  0.115%
      no_in_band_strike                       82  0.015%
  cost bar                    3633  0.657%
      cost_bar                              3633  0.657%

--- otm | fixture | demo
scans 24515  evaluated 6610768  passed 0  opensPlaced 0  blindScans 6570
bar arrivals 0 (0.000% of evaluated)
  feed/scan                6122656  92.616%
      scan:no_spot                       3129320  47.337%
      scan:no_expirations                2785068  42.129%
      scan:no_chain                       189912  2.873%
      scan:breaker_open                    18356  0.278%
  candidate generation      221385  3.349%
      no_candidates                       221385  3.349%
  contract selection        266727  4.035%
      contract_floor_delta                263572  3.987%
      contract_floor_premium                3155  0.048%

--- rv_scan | desk | demo
scans 371  evaluated 153756  passed 0  opensPlaced 0  blindScans 79
bar arrivals 1 (0.001% of evaluated)
  feed/scan                 143270  93.180%
      scan:no_spot                         71985  46.818%
      scan:no_expirations                  66618  43.327%
      scan:no_chain                         4251  2.765%
      scan:breaker_open                      416  0.271%
  candidate generation        9040  5.879%
      no_candidates                         9040  5.879%
  strategy gates              1445  0.940%
      no_trend_aligned_candidate            1445  0.940%
  cost bar                       1  0.001%
      cost_aware_bar                           1  0.001%

--- rv_scan | desk | live
scans 1120  evaluated 580448  passed 0  opensPlaced 0  blindScans 241
bar arrivals 9 (0.002% of evaluated)
  feed/scan                 544184  93.752%
      scan:no_spot                        313082  53.938%
      scan:no_expirations                 216504  37.299%
      scan:no_chain                        13041  2.247%
      scan:breaker_open                     1557  0.268%
  candidate generation       30670  5.284%
      no_candidates                        30670  5.284%
  strategy gates              5585  0.962%
      no_trend_aligned_candidate            5585  0.962%
  cost bar                       9  0.002%
      cost_aware_bar                           9  0.002%

--- rv_scan | fixture | demo
scans 23523  evaluated 6714300  passed 0  opensPlaced 0  blindScans 5032
bar arrivals 117 (0.002% of evaluated)
  feed/scan                6053778  90.162%
      scan:no_expirations                3176383  47.308%
      scan:no_spot                       2622277  39.055%
      scan:no_chain                       236551  3.523%
      scan:breaker_open                    18566  0.277%
      scan:fetch_error                         1  0.000%
  candidate generation      550226  8.195%
      no_candidates                       550226  8.195%
  strategy gates            110179  1.641%
      no_trend_aligned_candidate          110179  1.641%
  cost bar                     117  0.002%
      cost_aware_bar                         117  0.002%

--- cost-aware-gate demo ledger (7d retained: ["2026-09-28","2026-09-29","2026-09-30","2026-10-01","2026-10-02"])
armed false  admittedTotal 3  rejectedTotal 81318
  directional: admitted 3 (merit 0, bypass 3)  rejected 81299  maxRejectedGrossR -0.1912
  single_leg_rv: admitted 0 (merit 0, bypass 0)  rejected 19  maxRejectedGrossR -0.0511
```
