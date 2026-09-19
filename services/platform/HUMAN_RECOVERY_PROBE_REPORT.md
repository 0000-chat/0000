# Human recovery evidence probe

This is a bounded evidence experiment for the pinned Platform Worker/D1 setup. It adds no production authentication behavior, migrations, dependencies, or acceptance claims. GitHub HTTP calls are mocked at the Worker outbound boundary; the signup, callback, session, linking, credential, logout, and revoke routes are exercised through the real Worker.

## Interrupted signup

`worker/test/human-recovery.test.ts` first proves the control path: a valid provider callback returns `302`, creates one GitHub account row, and creates one session. A temporary D1 `BEFORE INSERT` trigger then aborts only the account insert for a fresh provider subject. After that callback, the observed rows were one user, zero provider accounts, and zero sessions. The trigger is dropped before retry.

The retry creates a fresh provider state and callback. It returns `302` with `error=account_not_linked`; the database remains at one user, zero provider accounts, and zero sessions. This reproduces the orphaned-user recovery failure without email-only linking or cleanup.

Observed result:

```json
{
  "baseline": { "callbackStatus": 302, "accounts": 1, "sessions": 1 },
  "injectedFailure": { "callbackStatus": 302, "users": 1, "accounts": 0, "sessions": 0 },
  "retry": { "callbackStatus": 302, "error": "account_not_linked", "users": 1, "accounts": 0, "sessions": 0 }
}
```

## Concurrent explicit linking

The same test signs in two distinct users and verifies each current session before starting explicit GitHub linking. Each link flow gets its own state and authenticated cookie. A bounded provider mock barrier observed two overlapping `/user` lookups (`overlap: true`, `providerLookups: 2`). The callbacks returned `302` with errors `account_already_linked_to_different_user` and `null`. An exact account query found one owner, and that owner was one of the two authenticated users; both original sessions still resolved to their original users.

Observed result:

```json
{
  "overlap": true,
  "providerLookups": 2,
  "callbackStatuses": [302, 302],
  "callbackErrors": ["account_already_linked_to_different_user", null],
  "ownerCount": 1
}
```

The fixture returns an inconclusive result rather than forcing an assertion if the bounded provider barrier cannot obtain overlap. This run did obtain overlap. It does not claim a duplicate-account defect.

## Human signup across a runtime restart

`scripts/test-human-recovery-restart.mjs` builds the Worker, applies the base migrations once, registers a scoped test service, and performs an actual GitHub callback against a Miniflare outbound provider mock. It then reads the resulting session and `/api/me`, issues two scoped human API keys, and authenticates both keys through `@0000/platform-client`.

The first Miniflare runtime is disposed. A second runtime starts with the same persistent D1 directory and the script deliberately does not reapply migrations. The saved signed session cookie resolves to the same user and session, `/api/me` returns the same default organization and membership, and both keys authenticate. Revoking one key returns `200` and makes that key `invalid_credential`; the sibling key remains `authenticated`. Signing out returns `200`, the old cookie returns a null session and `401` from credential listing, while the surviving API key remains independently `authenticated`.

The script emitted these result fields on the passing run:

```json
{
  "restart": {
    "migrationsAppliedBeforeRestart": true,
    "migrationsReappliedAfterRestart": false,
    "session": "same user/session",
    "keys": "both authenticate"
  },
  "revocation": {
    "revokedKey": "invalid_credential",
    "survivorKey": "authenticated"
  },
  "logout": {
    "session": "null",
    "browserCredentialListing": 401,
    "survivorKey": "authenticated"
  }
}
```

## Verification and limits

Commands run in this worktree:

- `bunx vitest run --config vitest.worker.config.ts worker/test/human-recovery.test.ts --reporter=verbose` — 1 file, 2 tests passed.
- `bun run typecheck` — passed.
- `bun scripts/test-human-recovery-restart.mjs` — passed, including actual signup, restart, key authentication, revoke, and logout checks.

The trigger and provider barrier are test-only controls. The restart proof is local Miniflare/workerd persistence evidence and does not claim deployed-runtime behavior. The interrupted-signup result identifies the current failure transition; it does not select or implement a recovery design.
