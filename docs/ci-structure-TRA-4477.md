# CI structure (TRA-4477) — independent jobs, one verdict, SHA-exact promotion

External audit C4 / Package 5 (`docs/external-audit-review-TRA-4473.md` §3). The prior shape was one
`ts-checks` job with **Test as the final step**; TRA-4440 measured `main` red for **6.5 weeks (runs
#1063–#1777)** behind a fail-fast step 7 with typecheck, lint and the 9,084-test suite never executing once.

## The shape since `9210f23a` (2026-09-09)

`.github/workflows/ci.yml` runs six jobs. **lint / typecheck / test are independent** — the first failure
hides nothing behind it. The guard family stays grouped (cheap, ordered on purpose) and **gates nothing
downstream**:

| job id | display name (== status-check context) | what |
|---|---|---|
| `rust-lint` | `Rust lint (cargo clippy)` | unchanged |
| `guards` | `Guards (stale-js / data-dir / cycles / deploy-build gate / prover)` | TRA-1660/2603/1684/3695/2372 guards + their controls |
| `lint` | `Lint (eslint)` | `pnpm lint`, no build needed (eslint config is not type-aware) |
| `typecheck` | `Typecheck (tsc)` | `pnpm typecheck` (self-provisioning) |
| `test` | `Test (vitest)` | build packages, then `pnpm test` |
| `ci-verdict` | `CI verdict` | the single **required** status; see below |

## How CI is graded — never by the run conclusion

TRA-4440's lesson is baked into the instruments, not left as advice:

- **`ci-verdict`** (`scripts/ci-verdict.mjs`) grades two independent surfaces and fails closed on both:
  `needs.*.result` for every expected job (**skipped/cancelled = BROKEN**, the 6.5-week state itself), and
  the run's **own `/jobs` step list**: every expected job present *by display name* with conclusion
  `success` (a silently dropped/renamed job = **BLIND**, because `needs` cannot see what the YAML no longer
  names), plus the `Test` step's wall-clock **≥ 60s** — a 9,084-test suite that "passed" faster did not run.
  Exit `0 CLEAN · 1 BROKEN · 2 usage · 3 BLIND`; BLIND > BROKEN > CLEAN.
- **Promotion** (`scripts/require-green-ci.mjs`): Pages now fires off **CI completion** (not the push) and
  refuses any SHA without a CI run verified green **by the same job-level grader** (`gradeJobs` is imported
  from `ci-verdict.mjs` — one grader, two call sites). The Pages build then checks out **that exact SHA**.
  `release.yml` (which carried no lint/typecheck/test at all) gains the same gate at the **tagged SHA**.
  No CI run at the SHA reads **BLIND and refuses** — no evidence is not green. Pre-split runs (≤ #1778)
  cannot vouch under the new job map, by design.

## The gates are measured, not assumed

Both scripts carry mutation controls (**22 arms, both directions**) that run **on every CI fire** in the
`ci-verdict` job: a planted failure, a *skipped* result, a job dropped from the run, a Test step under the
duration floor, an unreadable API and a no-runs SHA must each be shown to refuse with the exact exit code —
and the all-green arms must pass, because a gate hardwired to refuse passes every one-sided control.

## Branch protection on `main`

Applied 2026-09-09 via the REST API and verified by read-back:

- `required_status_checks: { strict: false, contexts: ["CI verdict"] }`
- `enforce_admins: false` — **deliberate**: agents push directly to `main` by standing policy with an
  admin-scoped token, and the pre-`main` defence is the `.githooks/pre-push` deploy-build gate (TRA-3695),
  which grades the pushed commit in a throwaway worktree and refuses on BROKEN **and** BLIND. The required
  check therefore binds every non-admin path and every PR merge without creating a gate no agent can
  satisfy (a fresh direct-push SHA has no checks yet, so `enforce_admins: true` would reject every push —
  the exact review-shaped gate §3 of the audit review pushes back on).
- **No** required PR review, no force pushes, no deletions.

The commit adding this file was pushed **after** protection was enabled and landed — the live positive
control that the push flow survives the rule.

## Freshness

`scripts/ci-verdict.mjs`'s `EXPECTED_JOBS` map is the machine-readable claim of what a complete run
contains. Renaming or adding a load-bearing job in `ci.yml` **must** update that map — a mismatch reads
BLIND on the very next run, which is the point.
