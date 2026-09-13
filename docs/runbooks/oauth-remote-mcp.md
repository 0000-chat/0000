# OAuth remote MCP deployment runbook

This runbook describes the controlled Cloudflare configuration for the
Communicator OAuth authorization server, shared API/MCP resource, and stored
read tools. It is a preparation and validation guide. It does not register a
real client, deploy a Worker, configure an external identity provider, or send
a message.

The Worker is the OAuth authorization server and resource server. The
configured external OIDC provider is used only to authenticate the human at
the browser authorization step. Its token is exchanged and verified by the
Worker; it is never accepted as delegated API/MCP authority. A client
installation creates a separate non-admin agent principal with zero account
grants. An administrator must grant an account before any stored read works.

## Configuration boundary

The checked-in `apps/control-plane/wrangler.jsonc` contains only non-secret
development or `.invalid` placeholders. The deployable environments already
declare the public Worker, D1, Durable Object, R2, Queue, and OAuth variable
names. Replace the placeholders in an environment-specific file outside the
repository before a controlled deployment.

Start from
`deploy/cloudflare/control-plane-oauth.env.example` and copy it to protected
operator storage. The required non-secret values are:

| Variable | Purpose |
| --- | --- |
| `COMMUNICATOR_OAUTH_ISSUER` | Canonical HTTPS issuer for local access tokens. |
| `COMMUNICATOR_OAUTH_RESOURCE` | Canonical HTTPS resource, ending in `/mcp`, shared by API and MCP. |
| `COMMUNICATOR_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | Access-token lifetime, bounded to 60–3600 seconds. |
| `COMMUNICATOR_OAUTH_HUMAN_AUTHORIZE_URL` | External IdP authorization endpoint. |
| `COMMUNICATOR_OAUTH_HUMAN_CLIENT_ID` | Communicator’s upstream OIDC client identifier. |
| `COMMUNICATOR_OAUTH_HUMAN_REDIRECT_URI` | Exact public `https://host/oauth/callback` URI. |
| `COMMUNICATOR_OAUTH_HUMAN_SCOPE` | Least upstream scope needed for human sign-in. |
| `COMMUNICATOR_OAUTH_HUMAN_TOKEN_URL` | External IdP token endpoint; HTTPS and no redirects. |
| `COMMUNICATOR_OAUTH_HUMAN_ISSUER` | Issuer claim expected in the upstream ID token. |
| `COMMUNICATOR_OAUTH_HUMAN_AUDIENCE` | ID-token audience; defaults to the upstream client ID when omitted. |
| `COMMUNICATOR_OAUTH_HUMAN_JWKS_URL` | HTTPS JWKS endpoint for upstream ID-token verification. |

Supply `COMMUNICATOR_OAUTH_SIGNING_SECRET` with `wrangler secret put` or in
the validator process environment. It must be at least 32 random characters.
Supply `COMMUNICATOR_OAUTH_HUMAN_CLIENT_SECRET` the same way only when the
external provider requires a confidential client. Never put either secret in
`wrangler.jsonc`, a checked-in env file, a client registration JSON, logs, or
the bootstrap SQL.

The external IdP registration is an operator-owned prerequisite. It must
allow exactly the configured callback URI, issue an ID token containing
`iss`, `sub`, `aud`, `nonce`, `iat`, and `exp`, publish the configured JWKS,
and refuse token-endpoint redirects. The provider’s client registration and
credentials are not created by this repository task.

## Validate without network access

The validator parses only the supplied non-secret env file and bootstrap client
JSON. It makes no Cloudflare request and does not print secret values. A local
placeholder check is explicit:

```sh
python3 scripts/validate-control-plane-oauth.py \
  --env-file deploy/cloudflare/control-plane-oauth.env.example \
  --client-file deploy/cloudflare/oauth-client.example.json \
  --environment local \
  --allow-placeholders
```

For a reviewed staging or production file, run the stricter check with the
signing secret provided only to the process:

```sh
COMMUNICATOR_OAUTH_SIGNING_SECRET="$OAUTH_SIGNING_SECRET" \
python3 scripts/validate-control-plane-oauth.py \
  --env-file /protected/communicator/staging/oauth.env \
  --client-file /protected/communicator/staging/oauth-client.json \
  --environment staging \
  --require-signing-secret
```

Production and staging reject `.invalid`, `.example`, and replacement values
unless `--allow-placeholders` is supplied. Never use that override with
`--execute` or a real deployment. The checked-in example intentionally passes
only the explicit local dry-run command above.

Validation reads the external file; it does not change the checked-in
`wrangler.jsonc` or automatically load these values into a Worker bundle. For a
controlled deployment, pass every reviewed non-secret OAuth value explicitly as
a Wrangler `--var` override. The upstream human callback and the downstream MCP
client callback are different OAuth legs: `COMMUNICATOR_OAUTH_HUMAN_REDIRECT_URI`
must point to the Worker’s `/oauth/callback`, while the client JSON’s
`redirect_uri` must remain the exact callback registered by ChatGPT Work, Grok,
or another MCP client.

After sourcing the protected file, review the rendered command before running
it. The command below is the complete OAuth variable set; it leaves secrets to
Wrangler secret bindings and uses `--dry-run`, so it only builds and checks the
bundle:

```sh
set -a
. /protected/communicator/staging/oauth.env
set +a
pnpm --filter @communicator/control-plane exec wrangler deploy \
  --env staging --dry-run \
  --var "COMMUNICATOR_OAUTH_ISSUER:${COMMUNICATOR_OAUTH_ISSUER}" \
  --var "COMMUNICATOR_OAUTH_RESOURCE:${COMMUNICATOR_OAUTH_RESOURCE}" \
  --var "COMMUNICATOR_OAUTH_ACCESS_TOKEN_TTL_SECONDS:${COMMUNICATOR_OAUTH_ACCESS_TOKEN_TTL_SECONDS}" \
  --var "COMMUNICATOR_OAUTH_HUMAN_AUTHORIZE_URL:${COMMUNICATOR_OAUTH_HUMAN_AUTHORIZE_URL}" \
  --var "COMMUNICATOR_OAUTH_HUMAN_CLIENT_ID:${COMMUNICATOR_OAUTH_HUMAN_CLIENT_ID}" \
  --var "COMMUNICATOR_OAUTH_HUMAN_REDIRECT_URI:${COMMUNICATOR_OAUTH_HUMAN_REDIRECT_URI}" \
  --var "COMMUNICATOR_OAUTH_HUMAN_SCOPE:${COMMUNICATOR_OAUTH_HUMAN_SCOPE}" \
  --var "COMMUNICATOR_OAUTH_HUMAN_TOKEN_URL:${COMMUNICATOR_OAUTH_HUMAN_TOKEN_URL}" \
  --var "COMMUNICATOR_OAUTH_HUMAN_ISSUER:${COMMUNICATOR_OAUTH_HUMAN_ISSUER}" \
  --var "COMMUNICATOR_OAUTH_HUMAN_AUDIENCE:${COMMUNICATOR_OAUTH_HUMAN_AUDIENCE}" \
  --var "COMMUNICATOR_OAUTH_HUMAN_JWKS_URL:${COMMUNICATOR_OAUTH_HUMAN_JWKS_URL}"
```

Use the same reviewed `--var` list for an explicitly approved deployment after
the dry run. The local example can exercise the identical bundle path without
remote access by omitting `--env staging`, adding
`--config apps/control-plane/wrangler.jsonc`, and using the checked-in example
values with `--allow-placeholders` only for validation. This task runs only the
local dry run and performs no upload.

## Prepare the bootstrap client

Client registrations are exact `(client_id, redirect_uri)` rows in D1.
Dynamic registration is disabled. Copy
`deploy/cloudflare/oauth-client.example.json` outside the repository and set
the client ID, display name, and exact callback URI that the external MCP
client has been configured to use. The bootstrap helper is dry-run by default:

```sh
python3 scripts/bootstrap-control-plane-oauth-client.py \
  --env-file /protected/communicator/staging/oauth.env \
  --client-file /protected/communicator/staging/oauth-client.json \
  --environment staging
```

Review the printed `INSERT ... ON CONFLICT` statement. It contains only the
client registration and never an access token, upstream secret, or human
subject. A later, explicitly approved operator may execute the same helper
with `--execute`; that command uses the named environment’s remote D1 binding:

```sh
python3 scripts/bootstrap-control-plane-oauth-client.py \
  --env-file /protected/communicator/staging/oauth.env \
  --client-file /protected/communicator/staging/oauth-client.json \
  --environment staging \
  --execute
```

This runbook does not run that command. Before execution, confirm the target
Cloudflare account, Worker environment, D1 database, callback hostname, and
external IdP registration with the deployment owner. The helper refuses the
placeholder override when `--execute` is present.

## Secret and migration order

After the non-secret values pass validation, an approved operator applies the
checked-in D1 migrations to the selected environment and sets secrets without
printing them:

```sh
pnpm --filter @communicator/control-plane exec wrangler d1 migrations apply \
  CONTROL_DB --env staging --remote
pnpm --filter @communicator/control-plane exec wrangler secret put \
  COMMUNICATOR_OAUTH_SIGNING_SECRET --env staging
pnpm --filter @communicator/control-plane exec wrangler secret put \
  COMMUNICATOR_OAUTH_HUMAN_CLIENT_SECRET --env staging
```

The upstream client secret command is needed only for providers that require
one. Secret rotation invalidates locally signed access tokens when the signing
secret changes; plan a fresh client authorization after rotation. Installation
and token revocation are checked on every API/MCP request, and revocation
records remain in the control directory.

No command in this implementation session applies a remote migration, writes
a secret, or registers a real client.

## Metadata, health, and controlled ingress checks

Cloudflare is the public ingress. The Worker exposes the liveness endpoint and
the OAuth metadata endpoints without a bearer token:

```sh
curl --fail https://<approved-host>/api/v1/health
curl --fail https://<approved-host>/.well-known/oauth-authorization-server
curl --fail https://<approved-host>/.well-known/oauth-protected-resource
curl --fail https://<approved-host>/.well-known/oauth-protected-resource/mcp
```

The protected-resource document must advertise the configured `/mcp` resource
and the local authorization-server issuer. An unauthenticated API or MCP
request must return `401` with a `WWW-Authenticate` resource-metadata
challenge. A valid installation without an administrator account grant must
return `403`; a wrong issuer, resource, expired token, revoked token, or
revoked installation must return `401`. The Streamable HTTP MCP endpoint is
`POST /mcp`; it validates `Origin` and uses the official SDK transport.

After a controlled deployment, the operator can use a pre-registered test
client to complete browser authorization-code PKCE, approve the displayed
consent, redeem the code, and verify that the installation appears as a
non-admin target with zero account grants. Grant one fixture account through
the administrator path, then compare API and MCP stored reads by stable
conversation and message identifiers. Provider requests must never receive
the inbound Communicator bearer.

## Pending live proof and stop conditions

The local and controlled fixtures prove protocol behavior, default upstream
token/JWKS wiring, identity separation, and API/MCP authority reuse. They do
not prove an external IdP’s registration, a Cloudflare account’s DNS or Access
policy, or a real ChatGPT Work, Grok web/mobile, or Bot client. Those are later
live proofs requiring explicit operator approval and real external setup.

Stop before deployment or client registration if any hostname, issuer,
audience, JWKS URL, callback URI, D1 binding, Access policy, or secret owner is
uncertain. Do not enable simulated data for a live provider, do not place
provider credentials in the Worker test environment, and do not infer that a
successful local OAuth test authorizes sending, webhooks, search, attachments,
or other provider behavior.
