# Guest permission correction

This delivery adds an optional, service-selected `permissionId` to the shared
guest grant assertion. An omitted field normalizes to `default`; an explicit
invalid value is rejected. Guest grants are unique by
`guest_id/service_id/resource_id/permission_id`, while renewal binds the exact
stored permission and revocation remains grant-ID scoped. Existing principal
wire fields, the Worker route, and the platform client transport are unchanged.

The required red proof was captured before the correction:

```text
pnpm exec vitest run --config vitest.worker.config.ts worker/test/guest-permissions.test.ts
1 failed: the second same-resource permission grant returned conflict instead of success
```

After the correction:

- `bunx vitest run --config vitest.worker.config.ts worker/test/guest-permissions.test.ts` — 1 file, 3 tests passed.
- `bunx vitest run --config vitest.worker.config.ts --no-file-parallelism` — 10 files, 25 tests passed.
- `bun run test:restart` — Miniflare D1 runtime restart persistence probe passed.
- `bun run check` — formatting and Platform typecheck passed. Its default parallel Worker run reached 9 files and 24 tests before the existing account membership-render race returned the sign-in page; the account test passes alone, and the deterministic no-file-parallelism run above passes all 25 tests.
- `bun run check` in `packages/contracts` — typecheck and 3 tests passed.
- `bun run check` in `packages/platform-client` — typecheck and 5 tests passed.
- `sh scripts/format-check src/guest-state.ts worker/test/guest-permissions.test.ts` — clean.
- `git diff --check HEAD` — clean.

The implementation is limited to the shared contracts assertion type,
`guest-state.ts`, migration `0009_guest_permission_grants.sql`, this focused
Worker/D1 test, and this report. No Worker route, client transport, auth,
message, root lockfile, or unrelated worktree files were changed.
