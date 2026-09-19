# T06 personal-harness OAuth report

Date: 2026-09-19. This report records the bounded production T06 implementation
on `codex/platform-t06` from `be92a85`. It establishes the Platform code-only
OAuth installation boundary; it does not complete T07 or the full Platform MVP.

## Delivered boundary

- `0008_oauth_installation.sql` adds deployment-controlled trusted clients,
  request-local signed-query flows and member-bound installations. It adds
  immutable OAuth-origin/provider-row fields to `platform_credential`,
  provider-row uniqueness, installation service/subject guards and immutable
  installation and credential authority bindings. Activated flow and
  installation records retain their original browser session and membership
  identifiers as audit bindings; current membership is checked on every
  authorization decision, so browser logout and membership deletion do not
  cascade away the durable record.
- `provisionTrustedOAuthClient` and `scripts/provision-oauth-client.ts` are the
  trusted provisioning boundary. They create an exact service resource,
  `oauthClient`, client-resource link and Platform client row in one D1 batch.
  Clients allow only `authorization_code`, `code`, S256 PKCE, exact redirect
  URIs and `none` or `client_secret_post`. Confidential secrets use the pinned
  Better Auth encrypted representation with the configured
  `BETTER_AUTH_SECRET`; the raw value is returned once. The CLI reads the
  validated service catalog, renders the same parameterized statement builder
  as the Worker, and executes a temporary SQL file because the pinned
  Wrangler/D1 command path rejects `BEGIN`/`COMMIT` statements.
- `/oauth2/selection`, `/oauth2/continue` and `/consent` provide a small
  browser flow. The selected organization and requested capability ceiling are
  recorded against the current user, session and membership. The signed
  provider query remains request-local, and unauthenticated users resume through
  the existing Google/GitHub sign-in page.
- Platform OAuth requests use a request-local Better Auth configuration with
  only `authorization_code` and current registered service scopes. The Worker
  rejects OAuth path aliases and unsupported management, revocation, userinfo
  and dynamic-registration routes. Metadata advertises only the enabled code,
  client-auth and S256 methods. A registered but inactive Platform client is
  still classified as a Platform OAuth request, so it cannot fall through to
  the default Better Auth provider configuration.
- The Worker wraps the direct token response. It requires the actual provider
  access row, installation reference, client/user/resource/scope/expiry,
  current membership and consent, active service/client and current capability
  catalog before inserting the normalized opaque credential. The normalized
  credential keeps Platform's hex `hashOpaque` and the provider's base64url
  token hash separately. The access row is detached from the browser session
  only in the same activation batch. Every follow-up write is conditional on
  the credential insert, and the final authority read checks the same current
  user, organization, membership, client, service, catalog and consent
  predicates; a failed barrier invalidates the provider row, installation,
  credential and flow.
- Shared verification has an OAuth-specific branch. It joins the normalized
  credential, active installation, provider access row, registered client,
  current human membership, organization, service verifier and provider
  consent on every request. OAuth authority never falls through to the T05
  agent verifier. Browser logout therefore leaves an active installation usable,
  while membership, organization, service, client, consent, catalog or expiry
  changes deny the next check. Browser consent forms are normalized to the
  provider's boolean JSON input and their validated provider redirect is
  returned as a 303 response. Account HTML uses `strict-origin` so Chromium's
  native same-origin forms retain a non-opaque Origin; consent pages further
  scope `form-action` to the exact registered callback origin so the browser
  can follow the validated redirect without opening arbitrary form targets.

## Focused Worker/D1 evidence

`worker/test/oauth-installation.test.ts` contains five real Worker/D1 tests:

- a public `none` client registered under a different operator authorizes a
  separate user through selection, consent and unauthenticated login resume;
  the initial PKCE exchange receives an opaque access token with no refresh
  token, authenticates through `createPlatformClient`, survives browser logout,
  and is denied after organization suspension, user disablement, service
  catalog narrowing, client-capability narrowing, consent narrowing, member
  deletion and member rejoin. A separate fresh code is immediately replayed;
  the provider returns 400 and the normalized credential count does not grow;
- forged redirect/resource/client/scope requests, canonical-path aliases,
  cross-session/user/origin flow selection, expired flows, repeated selection,
  and concurrent two-tab selection are denied. The concurrent test records
  which tab received 303 and asserts that the same organization's ID is the
  one persisted in the flow. A pre-selection SQLite trigger suspends the
  organization after the initial authority read; the guarded batch returns
  409 and leaves no selected flow or orphan installation. JSON denial,
  browser-form denial, browser-form approval with a real 303 redirect,
  unbound successful responses and malformed token responses are covered;
- a `client_secret_post` client completes the same initial flow, proves the
  stored Better Auth secret is encrypted, and passes provider-backed
  introspection before inactive-client/service fail-closed checks;
- the same confidential route returns `active: false` for a form introspection
  after client/service disablement; the pinned provider rejects a JSON
  introspection body with 415, so it cannot reach the default provider
  fallback. A JSON token request is still classified as the disabled Platform
  client and returns the code-only `unsupported_grant_type` response rather
  than reaching the default provider;
- the initial token completion is run with the pinned Better Auth handler and
  an interleaved D1 session. The session pauses the production completion
  function immediately after its successful current-authority `SELECT`, then
  disables the service before the guarded credential batch resumes. The
  completion returns 400, revokes the provider row, leaves the installation
  inactive and creates zero credentials. A second real SQLite trigger
  suspends the organization between the activation predicates and the active
  update; that exchange also fails closed and leaves the provider row,
  installation, credential and flow invalidated;
- two clients for one service prove that the service `oauthResource` catalog
  remains the union catalog while each client's requested scope page is its
  own ceiling. A prepared stale registration run after service narrowing
  produces four zero-change guarded statements and no Platform client row.
  The live member removal check uses `/api/account/members/leave` after
  installation and then rejoins with a new membership ID; the old credential
  remains invalid.

The first test also fetches Worker-owned authorization metadata and checks the
code-only grant, `none`/`client_secret_post` methods and S256 discovery. The
existing `worker/test/oauth-lifecycle.test.ts` remains a separate provider
fixture and its refresh-token probe is not part of this code-only boundary.

## Validation run

- `sh scripts/format .` passed;
- `bun run typecheck` passed;
- focused `bunx vitest run --config vitest.worker.config.ts worker/test/oauth-installation.test.ts` passed: 1 file, 5 tests;
- `git diff --check` passed;
- local CLI evidence passed for public and confidential registration. Invalid
  query-bearing redirects and `offline_access` were rejected before writes.
  The discriminating rollback run is recorded in
  `/tmp/platform-t06-parent-cli-rollback-proof.md`: a fresh local D1 database
  registered `parent-cli-rollback` with catalog
  `["resource:read","resource:write"]`, then seeded its resource with
  `allowedScopes='["sentinel:before"]', disabled=1, updatedAt=222` and a
  stable resource ID. The actual `provision-oauth-client` CLI, using
  `resource:read`, an exact HTTPS redirect and an absent owner, exited 1 with
  the Wrangler `--file` path's foreign-key error. Before and after snapshots
  retained all three sentinel columns and the resource ID, while the failed
  client count remained zero. Since the preceding upsert would have changed
  every sentinel if it escaped the failed transaction, this proves rollback of
  the resource write as well as the client writes;
- a real Chromium/Miniflare navigation rendered the selection and consent
  pages, sent native form POSTs with `Origin: http://localhost:18792`, and
  completed both approve and deny cases against a separate local callback
  server. Approve followed a 303 with a code and state; deny followed a 303
  with `error=access_denied` and state. The earlier `Origin: null` result was
  caused by the account page's `Referrer-Policy: no-referrer`; the matrix
  reproduced that behavior and the `strict-origin` policy removed it without
  adding a null-origin allowlist;
- package `bun run check` passed: format check, typecheck, 10 Worker/D1 files
  and 27 tests, plus the Miniflare D1 runtime restart persistence probe.

## Limits and next gate

Provider HTTP is simulated at the Google/GitHub boundary and no external
client or deployment is claimed. T06 deliberately does not issue, store,
rotate or revoke refresh tokens; T07 must add the hash-only refresh ledger,
replay handling and installation controls. Better Auth's pinned code replay
path deletes/revokes its provider access row, so replay lifecycle behavior is
left to that T07 implementation and is not inferred from the initial-binding
proof. DPoP, private-key JWT, userinfo, client credentials, dynamic
registration, provider revocation and consumer-service adoption remain
outside this slice. Parent review and aggregate integration remain separate
from this branch.
