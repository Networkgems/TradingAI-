# External read-only audit, 2026-09-08 (verbatim text extract)

> Source: `TradingAI-Read-Only-Audit-2026-09-08.docx`, attached to TRA-4473 by the board
> (sha256 `76234a7c0c0fc3d45e3f390bb511e8dfe7eda696e93ea5b04e75d8811a9ed390`, 57,210 bytes).
> Produced against `main @ 8b44289ae95f`. Extracted from `word/document.xml` paragraph-wise so the
> findings are greppable in-repo; tables flatten to one cell per line, which is why some rows read as
> loose fragments. The docx on the issue is authoritative.
>
> **CTO review of this audit: `docs/external-audit-review-TRA-4473.md`.** Several findings here are
> already remediated or measured differently against production — do not action this file without
> reading the review beside it.

---

READ-ONLY REPOSITORY AUDIT
TradingAI- options trading application
Repository: Networkgems/TradingAI- (private)
Snapshot: main @ 8b44289ae95f (committed 2026-09-08 22:11 EDT)
Audit time: 2026-09-08 22:20 EDT request; CI observed through 22:25 EDT
Mode: GitHub read-only; no branches, commits, issues, PRs, reviews, or workflow runs changed
Audience: Product owner, engineering lead, trading-risk reviewer
BOTTOM LINE  Research/paper-ready; not ready for unattended live options. Keep both live options entry flags off until the Critical packages in this report are complete and independently validated in sandbox and paper trading.

This is a code and operational-readiness assessment, not financial advice and not proof that the system is safe for live capital.

# Executive Summary
The repository is an actively developed TypeScript monorepo for equities, crypto, and options. It has unusually broad characterization coverage and many explicit fail-closed instruments, but its release controls and several foundational identity, durability, and broker-order guarantees lag the sophistication of its monitoring. The result is a system that can diagnose many failures after the fact while still allowing unsafe states to be created or deployed.
Dimension
Current assessment
Readiness
Architecture
Single Node process; React/Tauri client; five workspaces; broker/data adapters; file + SQLite durability
Research / paper
Options live entry
RV-long and directional entry flags are explicitly 0 in the blueprint
Not released
Trading evidence
Repository study reports 0/10 strategy-cost pools passed; fee-aware harness defect remains documented
No proven edge
Build / CI
Snapshot CI failed at lint; tests were skipped; Pages deployed successfully
Red
Order safety
No request timeout/idempotency key; cancel ambiguity can be followed by another submit
Stop-ship
Durability
Production code can fail open; default policy is observe and blueprint does not declare refuse
Stop-ship
Security / identity
Anonymous signup accepts raw path-bearing usernames; admin rename changes only registry identity
Stop-ship
Operations
Rich health routes and ledgers; one process, one disk, no failover, runtime env drift acknowledged
Fragile

## Highest-Priority Decisions
Freeze live options promotion. Keep ENABLE_OPTION_LIVE_RV_LONG=0 and ENABLE_OPTION_LIVE_DIRECTIONAL=0.
Disable public username creation/rename temporarily or restrict usernames to a canonical safe grammar before any more account operations.
Make broker submit outcomes explicit: acknowledged, refused, or unknown; never treat a transport error as proof the broker did not accept an order.
Require cancel confirmation and residual-quantity reconciliation before any replacement order.
Make CI and durable-state health blocking for deploy/release; do not publish a Pages build or live server build from red CI.
Replace the hard-coded 2025-2026 market calendar before 2027 sessions are evaluated.
## Audit Boundary
Facts are tied to snapshot 8b44289ae95. The repository advanced to c353c26b8bab after the user's stated audit time; that later commit is outside the source snapshot. The CI run for the audited snapshot completed after the request and is included because it directly tests the snapshot. No local checkout was available, so no tests were re-run; GitHub Actions job steps and logs are the validation evidence.
# Architecture And Product Flow
The system is a pnpm monorepo. A React/Vite UI runs on GitHub Pages or inside Tauri. It sends authenticated REST commands and receives per-user state snapshots over WebSocket. A long-lived Express process creates one equity engine, one crypto engine, and two P&L trackers per user, drives one-minute scheduling, persists files beneath DATA_DIR, and uses a shared SQLite database for selected hot state.
Layer
Primary areas
Observed responsibility
Client
apps/desktop
React dashboard, auth, settings, account mode, options panels, REST + WebSocket
Shared contracts
packages/shared
Types, presets, risk constants, promotion and quote contracts
Trading core
packages/engine
Strategies, indicators, sizing, Alpaca/Tradier/Coinbase clients and feeds
Research
packages/backtest
Replay, walk-forward, bootstrap/Monte Carlo, sweep runners and reports
Runtime
packages/server
Express/WS, per-user engines, market scanners, order orchestration, reconciliation, persistence, observability
Operations
render.yaml, ecosystem.config.cjs, scripts, .github
Render/PM2 deployment, health graders, CI, releases, GitHub Pages

## Options Lifecycle Map
Market data: Yahoo, Tradier, Coinbase, CoinMarketCap and Twelve Data feed shared and per-engine caches; Tradier option-chain fetches drive scanners and recording.
Selection and signals: signal-engine.ts coordinates directional, relative-value, OTM, spread and shadow paths; strategy and risk settings come from shared contracts and environment flags.
Risk and sizing: engine/risk.ts applies managed-equity risk, drawdown brake and notional caps; server-level gates add day-trading, correlation, give-back, quality and promotion controls.
Order entry/exit: TradierOptionsClient posts orders; smart-open/smart-close walk limit prices, poll, cancel and replace; the submit observer records acknowledged broker IDs.
Reconciliation: broker-position drift, fill/slippage ledgers, order provenance, option journal and P&L reconciliation compare local and broker state.
Persistence and UI: per-user files plus state.db survive restarts; REST mutates state and WebSocket broadcasts snapshots to the owning username.
CONCENTRATION  The largest runtime files are signal-engine.ts (~1.21 MB), index.ts (~0.96 MB), options-account.ts (~0.83 MB), and health-routes.ts (~0.44 MB). This is a material reviewability and change-isolation risk on the live-capital path.

## Repository Inventory
Area
Files
Non-test source
Test files
packages/server
784
339
440
packages/backtest
223
101
26
packages/engine
156
89
63
apps/desktop
148
91
28
packages/agents
25
14
9
packages/shared
34
13
19
scripts
205
179
7
Whole tree
1,633
1,145 .ts + 80 .tsx + 191 .mjs
approximately 592


# Critical Findings
## C1. Raw Usernames Reach Filesystem Paths
VERIFIED DEFECT  Anonymous signup accepts any non-empty trimmed username. userDataDir(), trade-store and other stores place that raw string under DATA_DIR/users using path.join. Names containing ../ or path separators can normalize onto another directory; the pre-signup orphan-retirement step can then act on that aliased path.

Evidence: index.ts validates only non-empty username, users.ts repeats no safe-character rule, and user-context.ts returns join(DATA_DIR, 'users', username). Multiple other stores repeat the same construction. The admin rename endpoint accepts newUsername and updateUser changes only users.json.
Impact: unauthenticated account creation can target unintended storage locations or alias an existing book. A rename can detach credentials from files, SQLite rows, journal scope, contexts and existing sockets. The exact write/delete reach depends on process filesystem permissions, but cross-account data loss and isolation failure are credible from the code path alone.
## C2. Broker Submit/Cancel Outcomes Are Not Safe To Retry
VERIFIED DEFECT  postOrder() has no request timeout or idempotency key. isTransportOrderFailure() classifies fetch TypeError/5xx/429/408 as meaning the broker never decided, although a connection can fail after the broker accepts the order. smart-open then continues after cancel failures; cancelOrder() treats 404 and 422 as success without confirming terminal state.

The option entry ladder can therefore submit a replacement while the previous order remains live or has partially filled. The submit observer is valuable, but it runs only after a response carrying an order ID; it cannot record an accepted order whose response was lost.
Required invariant: an unknown submit or cancel outcome must halt that intent, reconcile by broker account/order history, and resume only after remaining quantity is known. Replacement quantity must be net of confirmed fills.
## C3. Durable State Is Fail-Open By Default
VERIFIED CONFIGURATION RISK  durability.ts explicitly defaults to observe. The Render blueprint does not declare DURABILITY_POLICY=refuse. Missing SQLite, ephemeral DATA_DIR, unreadable journal, corrupt lines, and swallowed ledger writes can therefore be reported while the process continues unless the live dashboard has an out-of-repo override.

The source documents prior production loss of durable evidence from ENOSPC and acknowledges that selected stores fall back to memory or JSON. A 1 GB persistent disk backs the production blueprint. Runtime health may be better than repository defaults, but the repo cannot prove it.
## C4. Red CI Does Not Block Publication Or Live Build
VERIFIED PROCESS DEFECT  CI for the snapshot failed during lint with 15 errors and 2 warnings; the Test step was skipped. The paired GitHub Pages run succeeded. render-build explicitly converts lint failure into a non-blocking message, and main is unprotected.

The failing lint includes unused live-path imports/variables in options-account.ts and signal-engine.ts plus errors in safety graders. TypeScript, deploy-build controls and Rust clippy passed. The result is not a compilation failure, but a red branch with no test execution can still produce a deployable artifact.
# High Findings
## H1. Market calendar expires at 2026
scheduler.ts hard-codes only 2025 and 2026 NYSE holidays. Starting in 2027, holidays will be treated as market days. The scheduler also embeds exchange policy in application code instead of using a versioned exchange calendar. Replace before year-end and add future-year/half-day fixtures.
## H2. Quote-freshness protection is off by default
tradier-smart-open.ts resolves the order quote guard to off unless ENABLE_ORDER_QUOTE_GUARD is set; render.yaml contains no declaration. Current live RV and directional option entry flags are off, so this is a promotion blocker rather than evidence of current option exposure.
## H3. Account rename is non-atomic and incomplete
updateUser() changes the registry string only. It does not stop/move the UserContext, move DATA_DIR trees/backups, migrate SQLite/settings rows, re-key journals/tokens, close sockets, or issue a new session. Disable rename until a transactional migration exists.
## H4. Authentication has avoidable weak states
Reset codes use Math.random, are stored plaintext, and passwords need only six characters. WebSocket bearer tokens travel in URL query strings. Two-factor authentication explicitly fails open when enabled but the email field is absent. These are distinct hardening packages; none should be mixed with trading logic.
## H5. No validated strategy edge is ready for promotion
The repository's strategy-turnaround report states 0 of 10 strategy/cost pools passed and identifies a fee-aware sweep whose pooled metric did not change across cost arms. Archived strategies remain publicly exported for backtest use. Do not convert paper activity into a live-release signal until the fee harness is repaired and OOS results pass pre-registered gates.
## H6. Single-process per-user fan-out is the scalability limit
Every existing user is initialized at boot with equity and crypto engines and two P&L trackers. Source comments cite 67 users and a 2.0-2.2 GB RTH working set. One process also owns HTTP, WebSockets, schedulers, scanning, reconciliation, backups and alerts, so event-loop stalls and memory pressure share the order path.
## H7. Runtime desired state is not reproducible from the repository
The runbook and render.yaml repeatedly state that blueprint env sync and code auto-deploy are different and dashboard-created services can ignore blueprint values. TRADIER_ENV and credentials are sync:false. The current production SHA, env flags, alert delivery and broker reconciliation cannot be verified from GitHub alone.
# Medium And Low Findings
## M1. Monoliths impede safety review
index.ts is ~19,623 lines and options-account.ts ~16,512 lines; signal-engine.ts is ~1.21 MB. Extract route modules, order intent state machines and persistence ports behind characterization tests.
## M2. Operational scripts are an unmanaged product surface
The tree contains 192 executable script files. Only 62 are directly referenced by package scripts, CI or render.yaml; 130 are not directly wired, including 17 underscore-prefixed ad hoc probes. This proves lack of command wiring, not non-use. Classify each as supported, evidence-only, or removable.
## M3. Branch and review hygiene is weak
There are no open issues or PRs and no PR history returned, while main receives frequent direct commits. Eight non-main branches are fully behind main; two diverged branches are 987 and 1,784 commits behind. main is unprotected. Retire merged branches and adjudicate divergent work.
## M4. Documentation contradicts current configuration
Archived-strategy documentation says LIVE_STRATEGY_PRESET=no_trade, while render.yaml at the snapshot sets it to an empty string and explains that live falls through to per-user settings. The runbook carries multiple superseding topology notes. Create one generated current-state page and keep history elsewhere.
## M5. One dependency is a removal candidate
The desktop npm dependency @tauri-apps/plugin-shell appears only in package.json/lockfile; frontend code imports @tauri-apps/api/core, while shell use is via the Rust tauri-plugin-shell crate. Verify web and native builds without the npm package before removal.
## M6. Observability migration remains incomplete
docs/observability.md records approximately 320 console calls and 45 bare catches as remaining work. The critical broker paths have structured logging, but persistence/auth still contain swallowed corrupt-file and best-effort writes. Recount on the final cleanup PR and prioritize capital/audit state.
## L1. Package metadata is overloaded
package.json is ~66 KB because many //-prefixed script keys contain long ticket narratives. Move durable rationale into ADRs or docs and keep executable metadata compact, while preserving links from commands to decisions.
# Stale And Unused Inventory
Item
Evidence
Disposition
Eight fully-behind branches
0 commits ahead; 198-1,829 commits behind
Delete after owner/history check
fix/TRA-1472-calendar-scope
2 ahead, 987 behind, 12 changed files
Rebase/adjudicate or archive; do not merge directly
master
1 ahead, 1,784 behind, UI-only delta
Adjudicate and retire legacy default candidate
130 unwired scripts
Not named by package scripts, CI, or render blueprint
Inventory; quarantine before deletion
Archived strategies
Not in selectable presets, but exported and instantiated by backtests
Keep research-only; narrow public export boundary
@tauri-apps/plugin-shell npm
No frontend import; Rust crate is used
Removal candidate with native build proof
Root .land-*.md / evidence notes
Ticket-specific landing artifacts at repository root
Move to dated evidence archive; keep history

No other dependency is called unused: better-sqlite3, undici, nodemailer, yahoo-finance2, ws, Anthropic SDK and concurrently all have direct source or command usage. Vulnerability/advisory status was not assessed because no dependency-scanning result is present in the repository evidence.
# CI, Test And Release Health
Check
Snapshot result
Interpretation
Install / frozen lockfile
Pass; 691 packages
Reproducible dependency graph at this snapshot
Stale JS, DATA_DIR controls, cycles
Pass
No shadow output, unguarded resolver regression, or import cycles detected
Deploy build + controls
Pass
The configured package/web build chains compiled
TypeScript
Pass
Type-level build and package typechecks passed
ESLint
Fail: 15 errors, 2 warnings
Branch red; includes live-path unused code and grader errors
Vitest
Skipped
No current full test result for snapshot
Rust clippy
Pass
Tauri Rust lint clean
GitHub Pages
Success
Frontend published independently of red CI
Release workflow
Not exercised
Tag build publishes draft installers but contains no lint/typecheck/test job

There are roughly 592 test files, with 440 in packages/server. This is a strength, but file count is not a coverage result. Many tests are ticket-specific regression harnesses; the snapshot's full suite did not run in CI.
# Unfinished Product Capabilities
Live options entry is intentionally unreleased: ENABLE_OPTION_LIVE_RV_LONG and ENABLE_OPTION_LIVE_DIRECTIONAL are 0.
The order quote freshness gate is not enforced by repository configuration.
Tradier market data remains Phase-1 polling; the engine README still lists long-poll streaming as future work.
A common BrokerOrderClient interface remains absent; broker compatibility is convention/shape based.
No current strategy has repository-backed evidence sufficient for live promotion; the fee-aware evaluation path needs repair.
Production configuration, alert delivery, current live SHA, durable-state verdict and broker reconciliation need an operator-run acceptance record.
The application is not multi-instance safe and has no failover; broker credential ownership is an operational convention plus configuration.
The 2027 exchange calendar and early-close policy are not present.
Release notes reference a CHANGELOG, but no CHANGELOG appears at repository root in the audited tree.

# Prioritized Backlog
Priority
Work
Critical
C1 identity/path containment; C2 order outcome + cancel/replace state machine; C3 durability fail-closed; C4 blocking CI/deploy policy
High
2027 calendar; quote guard; auth hardening; rename migration; fee-harness repair/OOS gate; runtime configuration acceptance
Medium
Break up server monolith; script inventory; branch cleanup; documentation current-state generation; dependency removal proof
Low
Package metadata cleanup, naming/style normalization, historical evidence relocation

# Recommended Pull-Request Sequence
## Package 1: Canonical Identity And Path Containment
Priority: Critical. Raw usernames can alias filesystem paths and rename is incomplete.
Evidence: index.ts signup/admin rename; users.ts create/update; user-context.ts and trade-store.ts path construction.
Suggested approach: First add negative characterization tests for separators, dot segments, Unicode normalization and case collisions. Introduce a single canonical username parser and a stable immutable userId for storage. Immediately reject unsafe signup/admin writes and disable rename until migration is complete.
Affected areas: packages/server/src/index.ts, users.ts, user-context.ts, trade-store.ts, all per-user stores, account deletion/orphan retirement tests.
Validation: Anonymous signup attempts cannot escape a temporary users root; existing valid names still load; rename either returns 409 disabled or atomically migrates every keyed store. Add adversarial filesystem tests.
Risks: Changing normalization may collide existing accounts. Inventory existing usernames before enforcement.
Rollback: Revert parser wiring while keeping rename disabled; no data migration in the containment PR.
Remaining gaps: A separate, reviewed data migration is required to move legacy name-keyed files/rows to userId.
## Package 2: Order Intent Ledger And Unknown-Outcome Reconciliation
Priority: Critical. A lost submit response is classified as no broker decision, and there is no client idempotency key.
Evidence: TradierOrderClient.postOrder(), isTransportOrderFailure(), submit observer, broker provenance and reconciliation modules.
Suggested approach: Define an order-intent ID and durable pre-submit record. Classify outcomes as acknowledged/refused/unknown. On unknown, stop the intent and query broker orders/history by bounded time/account/shape before any retry. Persist the resolution.
Affected areas: packages/engine/src/tradier/order-client.ts; packages/server order provenance, broker census, signal-engine/options-account call sites.
Validation: Deterministic fixtures for response-lost-after-accept, 429/5xx, process restart, duplicated tick and reconciliation. Sandbox test proves one economic order per intent.
Risks: Broker APIs may not expose a native idempotency key; matching can be ambiguous.
Rollback: Feature flag new intent ledger; on rollback, keep live options disabled and retain ledger records.
Remaining gaps: Confirm Tradier's exact partner/client ID semantics with broker documentation/support.
## Package 3: Cancel-Confirm-Replace State Machine
Priority: Critical. Smart-open proceeds after cancel failure/ambiguity and does not net replacement quantity against partial fills.
Evidence: cancelOrder() accepts 404/422; smart-open catch logs and continues; partial-fill telemetry exists but is not the replacement authority.
Suggested approach: Require a terminal canceled/rejected/filled state before replacement. Treat 404/422 as unknown, poll order and account state, compute remaining quantity, and latch a per-intent breaker on ambiguity.
Affected areas: tradier-smart-open.ts, tradier-smart-close.ts, tradier-smart-multileg.ts, options-client/order-client, execution-quality telemetry.
Validation: Tests for cancel race, partial fill during cancel, cancel timeout, already-filled order and restart. Sandbox walk must never exceed requested aggregate quantity.
Risks: May reduce fill rate and increase latency; that is preferable to duplicate exposure.
Rollback: Flag the new walker; rollback to no-new-entry mode, not the previous permissive ladder.
Remaining gaps: Extend the same invariant to equity OTOCO and Coinbase replace paths.
## Package 4: Durability Admission Gate
Priority: Critical. Known-broken durable state can serve because observe is the default and the blueprint does not declare refuse.
Evidence: durability.ts, sqlite.ts, index boot gate, render.yaml 1 GB disk and missing policy declaration.
Suggested approach: Add a preflight that performs atomic write/fsync/read/delete on DATA_DIR, opens SQLite and validates journal/ledger sinks. Set production policy to refuse only after a staged observe read is green. Keep disk-low as drain/halt rather than crash-loop.
Affected areas: durability.ts, data-dir.ts, sqlite.ts, option journal/ledgers, health routes, render.yaml, runbook.
Validation: Ephemeral/no-space/native-module/corrupt-journal fixtures; Render staging boot; restart and restore drill; verify health cannot be green with an unmeasured axis.
Risks: A strict boot refusal can reduce availability. Pair with clear operator recovery and avoid restart storms.
Rollback: One-variable policy rollback to observe, while holding new live entries and preserving alerts.
Remaining gaps: Size disk/retention from measured file and inode growth before changing capacity.
## Package 5: Blocking CI And Release Promotion
Priority: Critical. Tests are skipped after lint failure; Pages and deploy builds can succeed independently; main is unprotected.
Evidence: CI run 34302365045, ci.yml order, deploy-pages.yml, release.yml, render-build lint suppression.
Suggested approach: Fix current lint. Run lint/typecheck/tests as independent jobs so all evidence is collected. Make Pages, release and Render promotion depend on a green required workflow at the exact SHA. Enable branch protection and PR review.
Affected areas: .github/workflows, package.json, repository rules, Render deployment procedure.
Validation: Mutant/failure controls prove each gate blocks; tag a fixture commit and confirm no artifact publish on a red prerequisite.
Risks: Long suites may slow delivery. Use sharding/caching, not bypasses.
Rollback: Workflow-only rollback while retaining required compile/test checks; emergency process must record an explicit reviewed override.
Remaining gaps: GitHub branch-protection administration was not readable through the connector beyond branches reporting protected=false.
## Package 6: Exchange Calendar Service
Priority: High. NYSE holidays end at 2026 in source.
Evidence: scheduler.ts MARKET_HOLIDAYS set and its 2025-2026 comment.
Suggested approach: Adopt a versioned exchange-calendar source or generate checked-in annual calendars with a freshness alarm. Model early closes explicitly and make market-open, EOD and risk-day keys consume one interface.
Affected areas: scheduler.ts, et-clock.ts, market-hours gates, EOD/report tests, deploy checks.
Validation: Fixtures for 2027 holidays, DST boundaries, Thanksgiving early close, weekend observations and stale-calendar refusal.
Risks: External calendar outages must not open trading. Cache and fail closed for entry while allowing exits.
Rollback: Retain last validated calendar bundle; rollback only if its coverage includes the active date.
Remaining gaps: Confirm asset-specific calendars for crypto, equities and options.
## Package 7: Auth And Session Hardening
Priority: High. Password reset and session transport have weaker primitives than the 2FA implementation.
Evidence: auth.ts Math.random/plaintext reset codes; index.ts six-character passwords and 2FA missing-email fail-open; WS query token.
Suggested approach: Use crypto.randomInt/randomBytes and store only keyed hashes; add per-user reset throttles and attempt caps; enforce stronger password policy; fail closed on inconsistent 2FA; move WS auth to a short-lived one-time ticket or subprotocol and redact query logs.
Affected areas: auth.ts, two-factor.ts, users.ts, index.ts, desktop WebSocket client, email flows.
Validation: Brute-force, replay, restart, log-leak, missing-email and token-expiry tests. Verify existing sessions migrate or expire intentionally.
Risks: Auth changes can lock users out. Stage with backup-code and admin recovery drills.
Rollback: Feature-gate WS ticketing; retain bearer HTTP auth. Reset-token format can support old+new during one TTL window.
Remaining gaps: Independent security review remains recommended.
## Package 8: Quote Guard And Live-Options Promotion Checklist
Priority: High. Order-time quote freshness is off, and live option entry remains intentionally disabled.
Evidence: tradier-smart-open.ts; order-quote-guard.ts; render.yaml flags at 0; options live validation docs.
Suggested approach: Run the guard in shadow on sandbox, measure timestamp coverage/false rejects, then enforce for live opens. Make any live option flag require freshness, durability, order-intent, broker reconciliation and per-name/fleet caps in one monotonic gate.
Affected areas: quote guard, option exec flags, signal engine, health routes, render config, runbook.
Validation: Deterministic stale/missing timestamp tests; sandbox forward samples; paper soak; attended canary with hard notional and kill switch only after prior Critical packages.
Risks: Overly strict freshness can suppress valid trades; never relax exits based on stale entry data.
Rollback: Clear live entry flags and return quote guard to shadow; open positions retain exit management.
Remaining gaps: No recommendation here authorizes live capital.
## Package 9: Repair Research Truth And Promotion Evidence
Priority: High. No evaluated strategy passed the documented keeper gate, and fee costs did not affect a pooled metric.
Evidence: docs/strategy-turnaround-TRA-814.md and archived strategy headers.
Suggested approach: Write a failing fixture proving costs reduce P&L/expectancy, repair the metric flow, pre-register train/OOS windows and selection rules, and regenerate results. Keep archived strategies unreachable from runtime presets and mark research exports explicitly.
Affected areas: packages/backtest runners/cost models/reports; promotion service/store; engine archived exports.
Validation: Golden trade ledger reconciles gross, fees and net; sensitivity monotonicity; untouched OOS; paper forward sample with minimum count and kill criteria.
Risks: Corrected evidence may invalidate current product assumptions. Treat that as the result, not a test problem.
Rollback: Keep live options flags off; restore prior report artifact only for comparison, never as promotion evidence.
Remaining gaps: Profitability cannot be established from unit tests alone.
## Package 10: Runtime Decomposition And Workload Bounds
Priority: Medium. One process and very large modules couple HTTP, feeds, per-user engines, persistence and trading actions.
Evidence: architecture.md; index.ts/user-context.ts; heap census comments and Render resource notes.
Suggested approach: First add workload/cadence metrics. Extract auth/routes, broker-order coordinator and reconciliation services without behavior changes. Move observe-only research jobs off the capital path or behind a bounded queue. Lazy-start dormant user engines.
Affected areas: server index/signal-engine/options-account/health routes, scheduler, user contexts, scripts.
Validation: State snapshot compatibility, event-loop lag, RSS per active user, broker-call counts, shutdown/restart reconciliation and soak tests.
Risks: Refactors can alter order timing. Split by boundary, keep fixtures, and avoid changing risk logic in the same PR.
Rollback: Revert one extracted boundary at a time; retain metrics and characterization tests.
Remaining gaps: Performance gains require a before/after benchmark; none are claimed here.
## Package 11: Repository Hygiene And Evidence Retention
Priority: Medium. Branches, scripts, root evidence files and docs have accumulated without a lifecycle.
Evidence: 11 branches, 130 scripts not directly wired, contradictory live-preset prose, package.json narrative volume.
Suggested approach: Create an inventory with owner, purpose, command, inputs, write effects and retention class. Deprecate for one release before deletion. Resolve two divergent branches, delete fully merged branches, move history to a dated evidence tree, and generate current runtime configuration docs from code.
Affected areas: scripts, docs, root evidence files, package.json, branches, engine public exports, desktop package.
Validation: Every retained tool has a smoke/self-test or explicit manual status; rg/import/package/CI/history proof for deletions; build native/web without npm plugin-shell.
Risks: Deleting a one-off grader may erase operational knowledge. Archive evidence before removal.
Rollback: Restore an archived tool or dependency in a small revert; branch tips remain recoverable in repository history during the retention window.
Remaining gaps: Unwired does not mean unused; owner confirmation is required.
# Explicit Unknowns And Access Blockers
Production Render service settings are not guaranteed to match render.yaml; the repository explicitly documents dashboard/env-sync drift.
The live deployment SHA, current health/durability payload, alert delivery, account balances, open orders/positions and broker reconciliation were not queried.
No GitHub issues or PRs were open, and the connector returned no PR history; TRA ticket state appears to live outside GitHub and was unavailable.
No full test run completed for the audited snapshot because CI stopped at lint. Local re-execution was not possible without a checkout.
Dependency vulnerability status, secret-scanning results, code coverage, performance benchmarks and disaster-recovery drill evidence were not present in the inspected GitHub evidence.
Exact runtime use of the 130 unwired scripts is unknown; they may be invoked manually or by an external scheduler.
Broker-specific guarantees for idempotency, partner IDs, cancel 404/422 semantics and order-history latency require confirmation against current Tradier documentation and sandbox tests.
# Evidence Index
E1  Audited snapshot commit
E2  Repository tree at snapshot
E3  Root package scripts and dependencies
E4  CI workflow
E5  Snapshot CI run (failed)
E6  Prior failing CI log with lint details
E7  GitHub Pages workflow
E8  Release workflow
E9  Render blueprint
E10  Architecture documentation
E11  Operations runbook
E12  Server entry point
E13  User registry and password storage
E14  Per-user context and storage path
E15  Trade store
E16  Auth tokens and password reset
E17  Two-factor challenge store
E18  Durability policy
E19  SQLite fail-soft store
E20  Tradier order client
E21  Smart option open
E22  Order quote guard
E23  Broker-position drift reconciler
E24  Market scheduler/calendar
E25  Engine integration README / Phase 2
E26  Strategy turnaround report
E27  Archived strategy status
E28  Observability status
E29  PM2 process configuration
E30  Diverged calendar branch comparison
E31  Diverged master comparison
# Method And Confidence
The audit enumerated the full recursive tree (1,633 files), package/workspace manifests, workflows, deployment definitions, branches, open PRs/issues, recent commits and Actions runs. It then traced identity/auth, market calendar, durability, risk, options order entry/cancel/reconciliation, persistence, observability and strategy evidence through targeted full-file and line-range reads. Dead-code claims were limited to direct wiring evidence; uncertain items are labeled candidates or unknowns.
Confidence is high for the verified source/configuration defects and CI conclusions at the named SHA. Confidence is medium for workload/scalability implications because no benchmark was run. Production runtime health and broker state remain unverified.