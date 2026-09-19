# T07 refresh rotation and installation report

Date: 2026-09-20. This report records the bounded T07 implementation on
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
  predecessors or storing response secrets. Omitted scope is distinct from a
  malformed or duplicate scope, so invalid presentations are rejected before
  replay terminalization.
- The refresh fence is independent of the original OAuth flow and installation
  deadline. A live family remains refreshable after those initial records expire,
  subject to the provider refresh, Platform family and current-authority
  limits. Platform clients reject JSON refresh bodies, including padded
  `grant_type` values, and noncanonical padded form values before Better Auth
  can perform broad provider-family cleanup.
- Successful Platform-prepared refreshes use a request-scoped Better Auth
  adapter whose `findMany` and `deleteMany` operations on provider access and
  refresh rows require the immutable ledger installation reference, including
  inside transaction callbacks. Consumed ancestors remain recognizable after
  provider-row deletion. A replay terminalizes only its installation family and
  descendants; a duplicate of the exact pending token receives a 503 fence
  response. Access credentials and introspection use the active effective
  lineage and current service catalog.
- Account HTML and same-origin session routes list installation metadata without
  secrets or provider IDs and provide an idempotent terminal revoke. Machine
  bearer requests are denied. Organization owners/admins can manage current
  organization installations; stale users can revoke their own old installation
  through the current browser session.

## Focused Worker/D1 evidence

`worker/test/oauth-refresh.test.ts` contains seventeen actual Worker/D1 tests:

- A confidential `client_secret_post` client completes PKCE and explicit
  `offline_access` consent, publishes an exact root family and credential,
  verifies through the shared client and introspection, survives deletion of
  the original flow and browser session, rotates three successive times (the
  first after its predecessor access row is expired), rejects each predecessor
  access credential, and terminalizes a replay after deleting the original
  provider rows. An excess-scope, wrong-resource, wrong-client, wrong-secret
  and foreign-token request leaves the active root and provider rows untouched.
- A refresh ledger remains usable after both its predecessor provider access
  row and Platform access credential naturally expire; its ledger deadline is
  asserted to outlive the access deadline. A public client without
  `offline_access` remains access-only, while a code-only client rejects a
  refresh request before provider handling.
- Initial publication is exercised with a real `BEFORE INSERT ... RAISE(IGNORE)`
  family-insert trigger and a separate partial-credential trigger. Both leave
  no family, lineage, credential or live provider rows. The refresh fence also
  covers one concurrent full Worker-route winner, an exact pending duplicate,
  and a consumed ancestor replay while a later token is pending; the previous
  access credential and protected-resource verification are denied during that
  pending window.
- Provider and Platform successor insert failures target the exact installation
  and family rows, capture the injected trigger text through a bounded D1 proxy
  on the tested Worker route, and assert route-specific 503 bodies without
  either response token field plus unchanged one-row lineage. The mapping case
  queries the exact returned provider access and refresh rows and proves both
  are revoked. A mapped successor is withheld when an ancestor replay wins
  after provider rows exist but before Platform mapping; the late provider rows
  are revoked.
- Current-authority checks independently cover organization suspension,
  catalog narrowing, consent deletion/restoration, user disablement and
  original-membership removal/rejoin; each begins from a fresh positive
  issuance where needed and leaves the predecessor unrevoked. A failed
  quarantine remains durably pending through a fresh D1 session and denies
  retries without reviving the predecessor. A Worker/D1 barrier changes
  installation authority after the joined current read and before the consume
  CAS; the response is 503 while the issued predecessor and provider rows stay
  intact.
- Real D1 `BEFORE INSERT` triggers abort the exact provider successor insert
  (`t07_provider_refresh_insert_failure`) and the exact Platform successor
  mapping (`t07_platform_mapping_insert_failure`). Both routes return 503;
  the winning family is quarantined with one token and no released successor.
  The mapping case also revokes both exact returned provider rows, leaving no
  active provider descendant.
- The factory-provided request-scoped adapter returns only the selected
  installation's provider refresh rows from direct and transaction reads, and
  a transaction delete targeting a sibling returns zero while the sibling
  remains refreshable.
- A malformed JSON refresh, padded JSON and form `grant_type`, duplicate scope
  and invalid capability scope are each rejected without changing the consumed
  family or sibling installation. A canonical replay still revokes only its
  bound family, while the sibling remains usable. A refresh succeeds after the
  original flow and installation deadlines are expired, and a family deadline
  still denies the same request.
- Fresh positive installations exercise organization suspension, service
  catalog narrowing, consent deletion, subject disablement and membership
  removal/rejoin at the joined-read, pending-fence, provider-row-to-mapping and
  publication authority barriers. Each route returns a structured 503 without
  token fields and leaves no usable descendant; positive controls and mutation
  restoration keep the cases independent. The real Worker route rotates once,
  pauses the successor after the consume fence, replays the original ancestor
  through the token endpoint, resumes the provider request and proves both
  responses omit access and refresh secrets, the target has no live descendant
  or provider rows, and a sibling installation remains healthy.
- Browser account controls render installation metadata, omit refresh values and
  provider-row fields, reject machine bearer and untrusted-origin requests,
  revoke the family and installation durably, and remain idempotent on repeat.

The focused run passed `1` file and `17` tests. The full Worker/D1 run passed
`12` files and `49` tests. Provider HTTP in these tests is simulated only at
the GitHub social-login boundary; OAuth provider token rows and Platform
verification are real local Better Auth/D1 rows. Existing non-Platform Better
Auth provider lifecycle tests remain on their native provider path; Platform
clients are the refresh-fenced boundary.

## Verification

- `sh scripts/format-check .` passed.
- `bun run typecheck` passed.
- `bunx vitest run --config vitest.worker.config.ts worker/test/oauth-refresh.test.ts`
  passed: 1 file, 17 tests, including the full-route concurrent fence,
  initial zero-row/partial publication, pending ancestor replay, current-read
  CAS, request-scoped adapter transaction isolation, late authority barriers
  and exact provider/Platform mapping abort triggers above.
- `bunx vitest run --config vitest.worker.config.ts` passed: 12 files, 49
  tests.
- `bun run test:restart` passed the Miniflare D1 runtime restart persistence
  probe.
- Root `bun run check` passed for all 11 workspace manifests.

The failure tests prove the local D1/provider-row fail-closed boundary; they do
not claim rollback support from an external provider deployment or deployed
browser adoption from a response-shape test. Those remain review and deployment
evidence beyond this local Worker/D1 slice.

## Aggregate acceptance

Integrated at `1d519cd` after independent Astra medium Standards and Spec
reviews and a bounded authenticated Grok 4.6 high review. The final correction
confines the pinned provider's token cleanup to the prepared installation;
the actual pre-provider ancestor-replay regression preserves sibling access.
No remaining finding was identified within the reviewed correction scope.

The parent independently ran the full Platform check on the combined tree:
twelve Worker/D1 files, forty-nine tests, formatting/typecheck and the generic
persistence restart probe passed. The separate refresh restart and Chromium
installation-control probes in [the runtime report](T07_RUNTIME_ACCEPTANCE_REPORT.md)
passed against the corrected production source. The actual Platform-to-msg
authentication and claim boundaries passed two tests with 142 assertions.

These are local production-route proofs with simulated external social-provider
HTTP. They do not close live client acceptance, Communicator adoption, remaining
Platform safeguards, deployment setup or full MVP acceptance.
