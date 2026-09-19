# T07 refresh rotation and installation report

Date: 2026-09-19. This report records the bounded T07 implementation on
`codex/platform-t07`, based on the accepted T06 Platform boundary. It covers
explicitly trusted personal-harness OAuth clients. It does not claim external
provider adoption, consumer integration, or full Platform MVP acceptance.

## Delivered boundary

- Migration `0010_oauth_refresh.sql` adds the explicit trusted-client refresh
  gate, one immutable refresh family per installation, hash-only Platform
  lineage with unique predecessor and consumption nonce, and the nullable
  refresh-token link on `platform_credential`. SQLite triggers enforce family
  authority snapshots, monotone lineage capabilities, the active-to-pending
  consume fence, separate root and successor publication assertions, and
  immutable refresh credential bindings. The pending slot always names the
  predecessor being consumed; one unconditional publication assertion accepts
  only a complete root mapping or a successor linked to that predecessor and
  its consumption nonce.
- Trusted provisioning accepts `--refresh` and writes the provider refresh
  grant, resource refresh lifetime and Platform mirror together. The default
  remains authorization-code access only. `offline_access` is protocol consent
  and is removed before Platform capability storage.
- `oauth-refresh.ts` authenticates public and confidential clients through the
  package-root OAuth provider API before ledger lookup or mutation. It validates
  exact client, resource, scope, provider-row and current authority bindings,
  fences one rotation with a D1 CAS plus current-authority predicates, maps
  exact returned provider rows to Platform lineage, detaches provider sessions
  only after durable mapping, revokes unbound provider rows after a mapping
  failure, and quarantines uncertain pending families without restoring
  predecessors or storing response secrets.
- Consumed ancestors remain recognizable after provider-row deletion. A replay
  terminalizes only its installation family and descendants; a duplicate of
  the exact pending token receives a 503 fence response. Access credentials and
  introspection use the active effective lineage and current service catalog.
- Account HTML and same-origin session routes list installation metadata without
  secrets or provider IDs and provide an idempotent terminal revoke. Machine
  bearer requests are denied. Organization owners/admins can manage current
  organization installations; stale users can revoke their own old installation
  through the current browser session.

## Focused Worker/D1 evidence

`worker/test/oauth-refresh.test.ts` contains four actual Worker/D1 tests:

- A confidential `client_secret_post` client completes PKCE and explicit
  `offline_access` consent, publishes an exact root family and credential,
  verifies through the shared client and introspection, survives deletion of
  the original flow and browser session, rotates three successive times (the
  first after its predecessor access row is expired), rejects each predecessor
  access credential, and terminalizes a replay after deleting the original
  provider rows. An excess-scope request leaves the active root untouched.
- A public `none` refresh-enabled client receives a normal access-only response
  when `offline_access` is omitted: no family is created, no refresh value is
  returned, and the provider access row has `refreshId = NULL`. A code-only
  Platform client rejects a refresh request with `unsupported_grant_type`.
- Real D1 `BEFORE INSERT` triggers abort the exact provider successor insert
  (`t07_provider_refresh_insert_failure`) and the exact Platform successor
  mapping (`t07_platform_mapping_insert_failure`). Both routes return 503;
  the winning family is quarantined with one token and no released successor.
  The mapping case also revokes both exact returned provider rows, leaving no
  active provider descendant.
- Browser account controls render installation metadata, omit refresh values and
  provider-row fields, reject machine bearer and untrusted-origin requests,
  revoke the family and installation durably, and remain idempotent on repeat.

The focused run passed `1` file and `4` tests. The full Worker/D1 run passed
`12` files and `36` tests. Provider HTTP in these tests is simulated only at
the GitHub social-login boundary; OAuth provider token rows and Platform
verification are real local Better Auth/D1 rows. Existing non-Platform Better
Auth provider lifecycle tests remain on their native provider path; Platform
clients are the refresh-fenced boundary.

## Verification

- `sh scripts/format-check .` passed after formatting the six changed TypeScript
  files.
- `bun run typecheck` passed.
- `bunx vitest run --config vitest.worker.config.ts worker/test/oauth-refresh.test.ts`
  passed: 1 file, 4 tests, including the provider and Platform mapping abort
  triggers above.
- `bunx vitest run --config vitest.worker.config.ts` passed: 12 files, 36
  tests.
- `bun run test:restart` passed the Miniflare D1 runtime restart persistence
  probe.
- Root `bun run check` passed for all 11 workspace manifests.

The failure tests prove the local D1/provider-row fail-closed boundary; they do
not claim rollback support from an external provider deployment or deployed
browser adoption from a response-shape test. Those remain review and deployment
evidence beyond this local Worker/D1 slice.
