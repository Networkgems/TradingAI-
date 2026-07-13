import { defineConfig } from 'vitest/config';

// TRA-1677 — the server suite previously ran on bare vitest defaults, including a
// 10 s hook budget.
//
// Several suites (trade-store, user-context, promotion-service, …) must set
// `process.env.DATA_DIR` BEFORE the module under test reads it at import time, so
// they pull the module in via a dynamic `await import()` inside `beforeAll`. That
// import is a COLD transform + load of a large module graph. Run alone it is fast;
// run with N workers competing for CPU it intermittently crossed 10 s and the file
// died with `Hook timed out in 10000ms` — never the same file twice, which is the
// signature of a budget that is too tight rather than a hang. It kept CI red at
// random regardless of whether anything was actually broken.
//
// 30 s is sized for a cold import under contention, not for a hang: a genuinely
// stuck hook still fails, it just no longer fails on a slow machine. This does not
// paper over a deadlock — the previous timeouts were all in import-only hooks with
// no I/O to block on.
export default defineConfig({
  test: {
    hookTimeout: 30_000,
  },
});
