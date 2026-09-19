# T06 personal-harness OAuth report

Date: 2026-09-19. This report records the bounded production T06 implementation
on `codex/platform-t06` from `be92a85`. It establishes the Platform code-only
OAuth installation boundary; it does not complete T07 or the full Platform MVP.

## Delivered boundary

- `0008_oauth_installation.sql` adds deployment-controlled trusted clients,
  request-local signed-query flows and member-bound installations. It adds
  immutable OAuth-origin/provider-row fields to `platform_credential`,
  provider-row uniqueness, installation service/subject guards and immutable
  installation and credential authority bindings.
- `provisionTrustedOAuthClient` and `scripts/provision-oauth-client.ts` are the
  trusted provisioning boundary. They create an exact service resource,
  `oauthClient`, client-resource link and Platform client row in one D1 batch.
  Clients allow only `authorization_code`, `code`, S256 PKCE, exact redirect
  URIs and `none` or `client_secret_post`. Confidential secrets use the pinned
  Better Auth encrypted representation with the configured
  `BETTER_AUTH_SECRET`; the raw value is returned once.
- `/oauth2/selection`, `/oauth2/continue` and `/consent` provide a small
  browser flow. The selected organization and requested capability ceiling are
  recorded against the current user, session and membership. The signed
  provider query remains request-local, and unauthenticated users resume through
  the existing Google/GitHub sign-in page.
- Platform OAuth requests use a request-local Better Auth configuration with
  only `authorization_code` and current registered service scopes. The Worker
  rejects OAuth path aliases and unsupported management, revocation, userinfo
  and dynamic-registration routes. Metadata advertises only the enabled code,
  client-auth and S256 methods.
- The Worker wraps the direct token response. It requires the actual provider
  access row, installation reference, client/user/resource/scope/expiry,
  current membership and consent, active service/client and current capability
  catalog before inserting the normalized opaque credential. The normalized
  credential keeps Platform's hex `hashOpaque` and the provider's base64url
  token hash separately. The access row is detached from the browser session
  only in the same activation batch.
- Shared verification has an OAuth-specific branch. It joins the normalized
  credential, active installation, provider access row, registered client,
  current human membership, organization, service verifier and provider
  consent on every request. OAuth authority never falls through to the T05
  agent verifier. Browser logout therefore leaves an active installation usable,
  while membership, organization, service, client, consent, catalog or expiry
  changes deny the next check.

## Worker/D1 evidence

`worker/test/oauth-installation.test.ts` runs two real Worker/D1 tests:

- a public `none` client registered under a different operator authorizes a
  separate user through the selection and consent pages, resumes after an
  unauthenticated login redirect, exchanges the exact PKCE code, receives an
  opaque access token with no refresh token or refresh grant, authenticates
  through `createPlatformClient`, and becomes invalid after organization
  suspension;
- a separate `client_secret_post` client completes the same initial flow, and
  its provider-compatible encrypted secret is confirmed not to equal the raw
  one-time secret.

The test also fetches the Worker-owned authorization metadata and checks the
code-only grant, `none`/`client_secret_post` methods and S256 discovery. The
existing `worker/test/oauth-lifecycle.test.ts` continues to pass for its
legacy fixture, including its intentionally separate refresh-token probe.

## Validation run

- `sh scripts/format .` passed;
- `bun run typecheck` passed;
- focused `bunx vitest run --config vitest.worker.config.ts worker/test/oauth-installation.test.ts worker/test/oauth-lifecycle.test.ts` passed: 2 files, 3 tests;
- the full Platform `bun run check` and restart probe are required before
  integration and are reported with the final branch checks.

## Limits and next gate

Provider HTTP is simulated at the Google/GitHub boundary and no external
OAuth client or deployment is claimed. T06 deliberately does not issue,
store, rotate or revoke refresh tokens; T07 must add the hash-only refresh
ledger, replay handling and installation controls. DPoP, private-key JWT,
userinfo, client credentials, dynamic registration, provider revocation and
consumer-service adoption remain outside this slice. Parent review and
aggregate integration remain separate from this branch.
