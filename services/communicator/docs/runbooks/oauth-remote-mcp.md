---
repo: 0000-chat/0000
status: current
---

# Prepare Platform-backed API and MCP authentication

Use this guide to review a controlled Communicator target before client
acceptance. It does not authorize deployment, registration, pairing, provider
sends, or webhook calls. Use synthetic data for local checks.

Communicator uses `0000-platform` as the production credential authority.
[`auth/platform.ts`](../../apps/control-plane/worker/auth/platform.ts) creates
the Platform client. Communicator resolves the authenticated principal through
its immutable local binding and applies its own tenant, identity, account,
chat, and administrator checks. A Platform capability is a ceiling, not a
replacement for local grants. Permission requests remain pending until an
administrator acts. They never grant access themselves.

The maintained [MCP topology](../../../../docs/architecture/mcp-topology.md#communicator-discovery-and-authentication)
defines the standalone target `https://communicator.0000.chat/mcp`, with
`https://communicator.0000.chat` as its registered resource and audience.
An implemented handler and a target contract are not a deployed endpoint.
Do not infer a public route, Gateway catalog entry, approved external client,
or deployed authority from this guide or from checked-in hostnames.

## Review the target configuration

Have the deployment owner confirm the intended target and its Platform
registration. Do not change live configuration as part of an acceptance run.

The production verifier requires these settings:

- `COMMUNICATOR_PLATFORM_BASE_URL`: the Platform service base URL.
- `COMMUNICATOR_PLATFORM_AUTHORITY`: the expected Platform authority.
- `COMMUNICATOR_PLATFORM_AUDIENCE`: the registered Communicator audience.
- `COMMUNICATOR_PLATFORM_SERVICE_VERIFIER`: the protected service verifier.

Browser login additionally requires the `COMMUNICATOR_PLATFORM_BROWSER_`
settings `CLIENT_ID`, `CLIENT_SECRET`, `REDIRECT_URI`, `RESOURCE`, and `SCOPES`.
Treat both the service verifier and the browser client secret as secrets.
Never put them in source, client configuration JSON, evidence, or logs.

[`auth/browser-routes.ts`](../../apps/control-plane/worker/auth/browser-routes.ts)
owns the browser configuration. It checks that the request origin matches the
configured redirect origin. Missing or invalid configuration fails closed.
The checked-in Wrangler settings describe configuration, not live deployment
evidence or permission to create a registration.

## Check the current login and metadata flow

For an approved controlled target, inspect the following behavior:

1. Open `/auth/login` through the configured application origin. Communicator
   starts the Platform browser authorization flow.
2. Complete the approved Platform flow. `/auth/callback` validates the
   transaction through the Platform browser client and sets the credential
   cookie. A valid credential still needs a local principal binding.
3. Inspect `/.well-known/oauth-protected-resource` and its `/mcp` alias.
   `resource` must equal `COMMUNICATOR_PLATFORM_BROWSER_RESOURCE`.
   `authorization_servers` must name the configured Platform base URL.
4. Inspect `/.well-known/oauth-authorization-server`. With browser
   configuration available, it advertises Platform's
   `/api/auth/oauth2/authorize` and `/api/auth/oauth2/token` endpoints and
   authorization-code PKCE S256. Communicator does not issue those tokens.
5. Check unauthenticated, wrong-authority/resource, expired, and revoked
   credentials. API and MCP requests must fail authentication. For an
   authenticated credential, compare each operation's capability ceiling and
   local resource checks across transports.

The exact resource comes from the registration and metadata. It is not
necessarily a URL ending in `/mcp`. Production verification goes through
Platform on each request. The local verifier injection in component tests is
not a production fallback. `/auth/logout` clears the local credential and
browser-binding cookies after an origin check. It does not imply global
Platform credential revocation.

The MCP handler uses the installed SDK's Streamable HTTP transport and the
existing origin policy. Do not widen supported origins to make an external
client test pass. Obtain any external-client registration and routing decision
from the integration owner rather than inventing one here.

## Keep legacy issuer preparation out of production

Worker-local `/oauth/authorize`, `/oauth/token`, and `/oauth/revoke` issuance
routes are retired. Do not provision a local signing secret or bootstrap a
local D1 OAuth client to enable production authentication.

The legacy `scripts/validate-control-plane-oauth.py`,
`scripts/bootstrap-control-plane-oauth-client.py`, and
`deploy/cloudflare/control-plane-oauth.env.example` still describe that former
issuer. A consumer audit finds the bootstrap script imports the validator and
`tests/test_validate_control_plane_oauth.py` exercises both. They remain for
historical fixture checks, not as the current operator workflow. This guide
does not delete them or authorize running their remote execution mode.

## Record evidence without overstating it

Run the [client acceptance runner](client-acceptance.md) only against an
approved controlled service or separately authorized external client. Review
the exact registered resource, client surface/version, and authority before
supplying a credential through a protected file or environment source.

Local Platform fixtures and SDK tests prove only controlled behavior. They do
not prove a real ChatGPT Work, Grok web/mobile/Bot integration, public routing,
issuer cryptography, provider delivery, or receiver behavior. Keep missing
evidence `unverified` and explicit unavailable capabilities `unsupported`.

Stop if the registration, origin, authority, audience, resource, callback, or
credential owner is unknown. Do not fall back to the retired local issuer.
