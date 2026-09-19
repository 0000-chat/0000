# T11 first-party browser transport report

This report records the Platform-side first-party human browser prerequisite.
It covers trusted `first_party_browser` purpose binding, the shared
server-side browser OAuth helper, and a local consumer fixture. Communicator
adoption, deployed provisioning and full T11 acceptance remain separate work.

The real browser proof is runnable from the repository root with the installed
Playwright module:

```sh
T07_PLAYWRIGHT_MODULE=/home/ubuntu/0000-full/worktrees/platform-mvp/services/communicator/apps/control-plane/node_modules/@playwright/test/index.mjs \
  bun services/platform/scripts/test-first-party-browser-chromium.mjs
```

The probe starts a Miniflare Worker with persistent D1, applies Platform and
consumer-fixture migrations, and serves a separate local consumer HTTP origin.
Platform uses `127.0.0.1`; the consumer uses `localhost`, so the test does not
mistake two ports on one hostname for host-only cookie isolation. Chromium
navigates the real Platform account/session, organization selection, consent,
consumer callback and fixture API. The only external substitute is the
explicitly labelled GitHub HTTP provider stub.

The passing Chromium run proves:

- trusted confidential first-party registration with PKCE, exact redirect and
  consent produces a human principal for the selected organization;
- the shared SDK callback uses the consumer fixture's atomic D1
  `DELETE ... RETURNING` transaction store and the fixture API authenticates
  with the issued `Secure; HttpOnly; SameSite=Lax` host cookie;
- the browser rejects an explicit invalid `Authorization` value even when a
  valid cookie is present, denies cross-origin unsafe logout, and clears only
  the service cookie on same-origin logout;
- the credential cookie's observed Chromium expiry is no later than the
  Platform access expiry, and the actual issued access token, cookie value and
  confidential client secret are absent from the DOM, URL, `localStorage` and
  `sessionStorage`;
- a distinct value typed into the mounted consumer input survives an in-place
  shared-client authority outage (503) and real verifier 401 responses after
  D1 expiry or account-UI installation revocation; 401 offers sign-in again
  while 503 keeps the sign-in control hidden, with no navigation;
- the callback outage is separately classified as `authority_unavailable` and
  preserves its return draft; no browser page errors occur.

The shared-client unit suite passes 18 tests and 140 assertions, including
malformed, duplicate, mixed and configuration-mismatch callback rejection;
rejected human, agent-principal, authority, audience, capability, expiry,
invalid-grant and refresh responses; callback body-delay, redirect and late
transport regressions; a delayed callback regression for post-verification
cookie expiry; and the default consumer-origin CSRF rule. The Worker/D1
acceptance suite passes 10 tests across the OAuth installation and browser
OAuth fixtures. It proves first-party provisioning constraints, request and
purpose binding, selection races and stale-authority rejection, PKCE/audience
rejection, immutable-purpose enforcement and both directions of request-purpose
spoof resistance, two-audience and two-organization isolation, provider-client,
platform-client, user, organization, service/catalog and consent invalidation
with inactive introspection, the final publication authority boundary, and
manual API-key rotation and revocation alongside a live OAuth credential. It
also covers consent copy and the
rejection of OAuth credentials by ordinary human-key controls. The separate
`bun scripts/test-oauth-refresh-restart.mjs` probe exits 0 after reusing its
persistent D1 directory and proves the injected refresh write failure remains
pending across restart, a healthy sibling remains usable, and reauthorization
creates a new active family without resurrecting the old pending family.

The refresh probe is a separate restart regression; the browser script does
not claim to prove refresh-token issuance.

The evidence is local Worker/Miniflare/D1 and simulated-provider evidence. It
does not claim live provider behavior, deployed cookie behavior behind a
reverse proxy, Communicator wiring, production consumer adoption or full MVP
acceptance.
