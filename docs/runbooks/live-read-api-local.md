# Live read API local runbook

This runbook covers the local pilot for the authenticated live read API and
the backoffice inbox. Run commands from the repository root unless a command
changes directory explicitly.

This phase uses local Worker bindings and synthetic fixtures. It does not
connect to Matrix, Synapse, a provider, or a remote Cloudflare account. It
does not create live credentials, an Access audience, production resources, or
a deployment.

## Prepare the repository

The workspace requires Node `>=24 <27` and pnpm `10.14.0`.

```bash
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm --filter @communicator/control-plane exec wrangler --version
```

The base Wrangler configuration uses the local `CONTROL_DB` binding and the
sentinel D1 ID `00000000-0000-0000-0000-000000000001`. Do not use `--remote`,
`wrangler dev --remote`, `wrangler deploy`, or a staging or production
environment command from this runbook.

## Run simulated browser mode

Simulated browser mode is the local UI path. `VITE_DATA_MODE=simulated` starts
MSW before React renders. The mock handlers return the same response shapes as
the live client, while the health request still reaches the local Worker. The
banner reads `SIMULATED DATA`, and the scenario controls operate only on
synthetic in-memory state.

Start the same Vite command used by the Playwright configuration:

```bash
cd apps/control-plane
VITE_DEPLOYMENT_ENV=local VITE_DATA_MODE=simulated pnpm vite --host 127.0.0.1 --port 4173
```

Use this mode to inspect navigation, identity isolation, channel filtering,
cursor-page rendering, and retry states. It is not a live API credential path
and must not be used to inspect live tenant data.

## Run the live API path

Live API mode means the real Hono routes, D1 reads, Durable Object reads, and
authorization middleware. It does not mean that live provider traffic exists.
The focused Worker tests run this path in the Cloudflare-compatible local
runtime. They seed deterministic D1 rows, initialize projection fixtures, and
inject a test verifier. They do not use a real bearer token, an Access
assertion, or an external service.

Run the read and authorization tests with:

```bash
pnpm --filter @communicator/control-plane test:worker -- \
  read/api.test.ts read/openapi.test.ts session.test.ts authorization.test.ts
```

The local Vite server alone does not provide an authenticated live browser
pilot. The checked-in Worker configuration uses simulated data mode and
`.invalid` OIDC and Access endpoints. A live browser requires a separately
configured Worker environment and a pre-existing, verified product or Access
credential. This phase creates neither one. Do not add a local auth bypass or
invent a token to make the browser appear live.

## Apply D1 migrations in order

Apply the checked-in D1 migrations to the local `CONTROL_DB` binding. Wrangler
reads `apps/control-plane/migrations` and applies every pending SQL file in
numeric filename order. The read route uses the earlier control-directory,
ingestion, and connection metadata migrations. The same command also applies
the current authority and lifecycle migrations.

Apply them with:

```bash
pnpm --filter @communicator/control-plane exec wrangler d1 migrations apply CONTROL_DB --local
```

Check for unapplied migration files after the apply:

```bash
pnpm --filter @communicator/control-plane exec wrangler d1 migrations list CONTROL_DB --local
```

On a current local database, this command should report no unapplied files.
The `TenantProjectionDO` SQLite schema is separate. Worker tests initialize it
through the Durable Object runtime; it is not created by a D1 migration.

Verify the read-metadata tables and columns without selecting any credential or
message data:

```bash
pnpm --filter @communicator/control-plane exec wrangler d1 execute CONTROL_DB --local --command "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('connections', 'connection_capabilities') ORDER BY name;"
pnpm --filter @communicator/control-plane exec wrangler d1 execute CONTROL_DB --local --command "SELECT name FROM pragma_table_info('connections') WHERE name IN ('last_synced_at', 'attention_code', 'sort_position') ORDER BY name;"
```

Verify the non-secret capability rows and their tenant and connection joins:

```bash
pnpm --filter @communicator/control-plane exec wrangler d1 execute CONTROL_DB --local --command "SELECT c.tenant_id, c.identity_id, c.id AS connection_id, c.provider, c.status, c.sort_position, cc.capability FROM connections AS c LEFT JOIN connection_capabilities AS cc ON cc.tenant_id = c.tenant_id AND cc.connection_id = c.id ORDER BY c.tenant_id, c.identity_id, c.sort_position, c.id, cc.capability;"
```

Each capability must belong to the same tenant and connection shown by the
row. A fresh local database can return no rows because this phase has no manual
credential or provider seed workflow. The Worker tests seed synthetic directory
rows through `apps/control-plane/worker/test/support/directory-fixtures.ts`.

## Authenticate API clients

API clients use a product OIDC JWT in the `Authorization` header:

```http
Authorization: Bearer <product-oidc-jwt>
```

For an already authorized environment, keep the value outside the repository
and pass it through a protected process environment. Do not paste a token into
this runbook, a test fixture, a query string, or a log.

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${COMMUNICATOR_BEARER_TOKEN}" \
  "${COMMUNICATOR_API_ORIGIN}/api/v1/session"
```

If the principal has more than one active membership, the session route may
require an authorized tenant selection. The `X-Communicator-Tenant` header is
only a selection hint. D1 membership resolution must authorize it before the
Worker uses the tenant:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${COMMUNICATOR_BEARER_TOKEN}" \
  -H "X-Communicator-Tenant: ${COMMUNICATOR_TENANT_ID}" \
  "${COMMUNICATOR_API_ORIGIN}/api/v1/session"
```

The Worker derives tenant and identity authorization from the verified
principal and D1. Clients must not submit tenant IDs, projection scopes, or
allowed identity lists as authority.

## Understand Cloudflare Access authentication

The same-origin backoffice can arrive through Cloudflare Access. Access places
its application JWT in `Cf-Access-Jwt-Assertion`; the Worker verifies the
assertion signature, issuer, audience, and JWKS before resolving the product
principal in D1. The Worker does not trust the header because it came from a
request.

Credential selection is deterministic:

- If `Authorization` is present, the Worker verifies the bearer token and uses
  that result.
- If `Authorization` is absent, the Worker verifies
  `Cf-Access-Jwt-Assertion`.
- An invalid bearer token is not rescued by a valid Access assertion on the
  same request.
- Access is an outer same-origin gate. It does not replace product tenant,
  membership, identity, or operation-scope authorization.

In a deployed Access-protected backoffice, the edge supplies the assertion.
Do not manufacture the header in the browser, accept an unverified value, or
use it to bypass product authorization. This phase includes only non-secret
placeholder configuration and creates no live Access audience.

## Use the read endpoints

`/api/v1/health` and `/api/v1/openapi.json` are public and disclose no tenant
data. The session and data routes use the auth middleware described above.

| Route | Authorization and result |
| --- | --- |
| `GET /api/v1/session` | Returns the resolved tenant, principal, membership, and authorized identities. |
| `GET /api/v1/identities` | Returns the identities in the authenticated session. The array is capped at 64. |
| `GET /api/v1/connections?identity_id=...` | Requires `connection.read`. Returns D1 connection metadata and capabilities. The array is capped at 64. |
| `GET /api/v1/identities/{identity_id}/channels` | Requires `conversation.read` and `connection.read`. Merges D1 connection metadata with projection unread and activity aggregates. The array is capped at 64. |
| `GET /api/v1/identities/{identity_id}/conversations?channel_id=...&cursor=...&limit=...` | Requires `conversation.read`. Returns `{ items, next_cursor }` using an opaque seek cursor. |
| `GET /api/v1/identities/{identity_id}/conversations/{conversation_id}` | Requires `conversation.read`. Returns one authorized conversation or the generic not-found response. |
| `GET /api/v1/conversations/{conversation_id}/messages?identity_id=...&cursor=...&limit=...` | Requires `conversation.read`. Returns `{ items, next_cursor }` using an opaque seek cursor. |
| `GET /api/v1/health` | Public liveness and configured data mode. |
| `GET /api/v1/openapi.json` | Public OpenAPI 3.1 document generated from the registered routes. |

The maximum page size is 100. Cursor values are bounded opaque strings. Pass a
returned `next_cursor` back as `cursor` without decoding, editing, or creating
one from an ID. The Worker selects the tenant Durable Object from the trusted
session and never exposes a Durable Object URL or storage identifier.

## Interpret an empty live projection

The read API can be healthy while the live projection contains no conversation
or message rows. D1 connection metadata and authorized identities can exist
before any Matrix event has populated `TenantProjectionDO`.

When an initialized projection is ready but has no ingested events:

- the conversation list returns `items: []` and `next_cursor: null`;
- a channel can return `unread_count: 0` and `last_activity_at: null`; and
- a message request for a conversation that does not exist returns the generic
  `404 not_found`, not an empty message page.

An uninitialized, rebuilding, failed, or unavailable projection returns
`503 service_unavailable`. No Matrix ingestion source populates this local
pilot in this phase, so empty live reads are expected until a later phase
connects Matrix ingestion. Do not add a synthetic production injector or treat
an empty projection as proof that a provider account is disconnected.

## Diagnose bounded API failures

The public error body is intentionally generic and does not echo IDs, cursors,
JWTs, Access assertions, or internal failure details.

| Status | Public code | Meaning |
| --- | --- | --- |
| `400` | `invalid_request` or `tenant_selection_required` | The request has malformed or repeated bounded input, an invalid ID, an invalid limit or cursor, or the session needs an explicit authorized tenant selection. |
| `401` | `unauthenticated` | The bearer or Access credential is missing, malformed, rejected, or not usable for the configured verifier. |
| `404` | `not_found` | The requested tenant, identity, channel, or conversation is not visible to the authenticated principal. Missing, deleted, cross-identity, and unauthorized conversation probes intentionally share the same response. |
| `503` | `service_unavailable` | D1, Durable Object, or another read dependency is unavailable; the projection is not ready; or stored data fails closed validation. |

Do not use a `404` to infer whether another identity owns an ID. Do not retry a
malformed request or an unauthenticated request with different guessed values.
For a `503`, check migration state, connection metadata, and projection
readiness, then rerun the focused Worker test that covers the failing boundary.

## Run local verification

Run the focused Worker read contract first:

```bash
pnpm --filter @communicator/control-plane test:worker -- \
  read/api.test.ts read/openapi.test.ts session.test.ts authorization.test.ts
```

Run all Worker and Durable Object tests:

```bash
pnpm --filter @communicator/control-plane test:worker
```

Run the focused UI contract tests:

```bash
pnpm --filter @communicator/control-plane test:ui -- \
  src/lib/api/client.test.ts \
  src/components/identity/identity-switcher.test.tsx \
  src/features/conversations/conversation-page.test.tsx \
  src/features/conversations/conversations-shell.test.tsx \
  src/mocks/handlers.test.ts
```

Run all UI tests and the control-plane check:

```bash
pnpm --filter @communicator/control-plane test:ui
pnpm --filter @communicator/control-plane check
```

The focused browser test and the full browser suite both start the simulated
Vite server from `apps/control-plane`:

```bash
pnpm --filter @communicator/control-plane exec playwright test e2e/live-read-api.spec.ts --workers=1
pnpm --filter @communicator/control-plane test:e2e
```

Regenerate the checked-in Worker binding types, then require a clean generated
file diff:

```bash
pnpm --filter @communicator/control-plane types:worker
git diff --exit-code -- apps/control-plane/worker-configuration.d.ts
```

If the drift check reports a diff, inspect the generated file and the Wrangler
configuration before running other work. Never hand-edit
`apps/control-plane/worker-configuration.d.ts`.

For the repository gate, run:

```bash
pnpm check
pnpm test
pnpm test:python
git diff --check
```

## Keep this phase local-only

This phase publishes and tests read contracts. It does not implement or enable
WebSockets, Matrix ingestion, outbound commands, account linking, provider
authentication, or production deployment. Do not create live credentials,
configure a live Access audience, create production D1, R2, Queue, or Durable
Object resources, apply remote migrations, or deploy the Worker while using
this runbook.
