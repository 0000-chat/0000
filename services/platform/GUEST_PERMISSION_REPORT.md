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

After the correction and follow-up proof additions:

- `bunx vitest run --config vitest.worker.config.ts worker/test/guest-permissions.test.ts` — 1 file, 5 tests passed. The suite reconstructs the 0007 schema, seeds a live default grant and credential, applies the real 0009 migration, then authenticates and renews that same grant through the Worker/shared client. It also covers participant public/management assertions and no-widening against a service that permits both read and write.
- `bun run check` — formatting, Platform typecheck, 10 Worker test files, and 27 tests passed; the Miniflare D1 runtime restart persistence probe also passed.
- `bun run check` in `packages/contracts` — typecheck and 3 tests passed.
- `bun run check` in `packages/platform-client` — typecheck and 5 tests passed.
- `sh scripts/format-check src/guest-state.ts worker/test/guest-permissions.test.ts` — clean.
- `git diff --check HEAD` — clean.

The implementation is limited to the shared contracts assertion type,
`guest-state.ts`, migration `0009_guest_permission_grants.sql`, this focused
Worker/D1 test, and this report. No Worker route, client transport, auth,
message, root lockfile, or unrelated worktree files were changed.
