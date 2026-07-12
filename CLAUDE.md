# TradingAI — repo conventions

## Never type-check a single file with `tsc <file>`

```bash
npx tsc packages/server/src/demo-flags.ts   # ← NEVER. Poisons the tree.
```

When `tsc` is given explicit file arguments it **does not read `tsconfig.json`**. `outDir` and
`noEmit` are silently dropped and it emits the compiled `.js` **next to the input** — leaving
`src/demo-flags.js` sitting beside `src/demo-flags.ts`.

That stale sibling then wins module resolution, and vitest exercises the **compiled copy instead
of the source**:

- **server** — sources import with explicit ESM extensions (`./demo-flags.js`). Vite normally maps
  that back to `./demo-flags.ts`, but only while no real `.js` exists. When one does, it wins.
- **desktop** — imports are extensionless, and Vite's default `resolve.extensions` lists `.js`
  *before* `.ts`. Same outcome.

The failure mode that matters is the silent one. If the stale `.js` holds an **older, passing**
build while the current `.ts` is broken, the suite goes **GREEN against code you are not
shipping** — and sails straight through a verification gate. (TRA-1660; first hit on TRA-1515,
where it surfaced as six bogus `renderInfraDefaults is not a function` failures against a source
file that plainly exported it.)

Use instead:

```bash
pnpm typecheck   # tsc --noEmit, honours tsconfig
pnpm build       # tsc -b, emits to dist/
```

Both read `tsconfig.json` and emit to `dist/`, never into `src/`.

### The guard

```bash
pnpm check:stale-js          # fails if any emit shadows a TS source
pnpm check:stale-js -- --fix # delete the offending artifacts
```

It runs automatically in `pretest` and in CI ahead of build/test, so a poisoned tree fails loudly
instead of passing quietly. `.gitignore` also covers `packages/*/src` and `apps/desktop/src`, but
that only stops a stray `git add -A` from committing the emit — **it does not stop the shadowing**.
The guard is the part that does.
