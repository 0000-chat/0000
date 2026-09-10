# Authenticated Live Read API and Inbox Integration Plan

> **Execution requirement:** The primary session plans, orchestrates, reviews,
> commits, opens the pull request, and merges. Implementation and test execution
> must use ephemeral `codex exec` workers with model `gpt-5.6-luna`, reasoning
> effort `max`, service tier `fast`, and self-contained prompts. Writers use this
> isolated `codex/live-read-api` worktree one at a time. Test workers use
> `workspace-write`; static reviewers use `read-only`; reviewers never edit or
> review their own work. Verify `git diff` after every worker wave.

**Goal:** Publish the first authenticated, versioned live read API over the
existing D1 Control Directory and `TenantProjectionDO`, then make the existing
backoffice inbox consume those real paginated response contracts when
`VITE_DATA_MODE=live`.

**Architecture:** The public Hono Worker authenticates the principal, derives
the tenant and allowed identity from server-side authorization context, reads
connection metadata from a primary-consistent D1 session, and routes message
queries to `TENANT_PROJECTION.getByName(trustedTenantId)`. Durable Objects remain
private. The browser calls only same-origin `/api/v1/*` routes; simulated mode
continues to use MSW through the same `ApiClient` boundary.

**Tech Stack:** TypeScript 7, Zod 4, Hono with `@hono/zod-openapi`, D1,
SQLite-backed Durable Objects with RPC, React 19, TanStack Query, MSW,
`@cloudflare/vitest-plugin`, Playwright, Wrangler 4, pnpm 10.

---

## 1. Position in the approved delivery sequence

This is milestone 9 in
`docs/superpowers/specs/2026-08-27-communicator-cloudflare-data-plane-design.md`:

> versioned live read API replacing the corresponding UI mocks

Already merged and reused without replacement:

- product OIDC/JWKS validation and D1 tenant/identity authorization;
- ordinary-R2 archive and replay contracts;
- SQLite-backed `TenantProjectionDO`, atomic ingestion, query cursors, and
  rebuild protocol; and
- archive-first authenticated ingress and the committed-archive Queue consumer.

The persistent Matrix E2EE adapter is being merged independently in PR #12. It
is not a dependency of this phase because this phase reads the projection
boundary that already exists.

## 2. Simple outcome

After this phase, an authorized application can ask Communicator:

- who am I and which identities may I inspect;
- which provider accounts belong to one allowed identity;
- which WhatsApp, Telegram, Messenger, or LinkedIn channels that identity has;
- which conversations belong to all channels or one selected channel; and
- which messages belong to one selected conversation.

The Worker, not the browser, chooses the tenant Durable Object. Guessing another
identity or conversation returns the same generic not-found result. The inbox
UI can use these live endpoints without changing its layout.

## 3. Locked scope and non-goals

### In scope

1. `GET /api/v1/session` remains the authorization bootstrap endpoint.
2. Add authenticated read endpoints matching the current browser client:

   ```http
   GET /api/v1/identities
   GET /api/v1/connections?identity_id=...
   GET /api/v1/identities/{identity_id}/channels
   GET /api/v1/identities/{identity_id}/conversations?channel_id=...&cursor=...&limit=...
   GET /api/v1/identities/{identity_id}/conversations/{conversation_id}
   GET /api/v1/conversations/{conversation_id}/messages?identity_id=...&cursor=...&limit=...
   GET /api/v1/openapi.json
   ```

3. Identities, connections, and channels are bounded navigation collections.
   Return complete arrays after enforcing a hard maximum of 64 connections per
   identity. Conversations and messages remain seek-paginated with the existing
   opaque Durable Object cursors.
4. Add D1-owned non-secret connection metadata required by existing public
   schemas: capability rows, `last_synced_at`, `attention_code`, and
   `sort_position`.
5. Add private DO read RPCs for an exact conversation and per-connection channel
   aggregates. Do not expose DO URLs or IDs.
6. Support the existing bearer-token path. Also accept a verified
   `Cf-Access-Jwt-Assertion` as a separately configured product credential for
   the same-origin backoffice. If an Authorization header is present, it is
   authoritative and the middleware must not fall back to Access after a bearer
   failure.
7. Publish OpenAPI 3.1 JSON from the same registered route definitions.
8. Keep simulated mode available locally and visibly marked. Production still
   rejects simulated mode.

### Not in scope

- WebSockets or projection-change subscriptions (milestone 10);
- Matrix normalization, daemon supervision, gateway upload, or live ingestion
  enablement (milestone 11);
- message sends, edits, reactions, read receipts, typing, or command records
  (milestones 12–14);
- self-service account linking or mautrix provisioning (milestones 17–19);
- search, reports, exports, deletion, or rebuild operator endpoints;
- a synthetic production data injector;
- direct browser access to D1, Durable Object SQLite, R2, Synapse, or bridges;
- R2 Data Catalog, Pipelines, Brain, or automation execution.

## 4. Security and failure invariants

1. `SessionResponse.tenant.id` is the sole tenant routing authority. Never route
   from a path, query, body, cookie, or `X-Communicator-Tenant` without the
   middleware first resolving that hint to an authorized membership.
2. Every identity parameter must match one `SessionResponse.identities` row and
   carry the required external scope:
   - `conversation.read` for channels, conversations, and messages;
   - `connection.read` for connections and channel metadata.
3. The Worker constructs the internal `ProjectionAuthorizationContext`; clients
   never submit projection scopes, tenant IDs, principal IDs, or allowed identity
   arrays.
4. Unauthorized identity, missing conversation, deleted conversation, and
   another identity's conversation all return the exact same `404 not_found`
   payload.
5. Invalid IDs, cursor length, limits, or duplicate query values return a bounded
   `400 invalid_request` payload without echoing input.
6. D1 or DO failures, uninitialized/rebuilding projections, corrupt persisted
   rows, and RPC bridge errors return `503 service_unavailable` without internal
   messages or identifiers.
7. No read handler logs message bodies, titles, participant labels, cursors,
   Matrix IDs, provider IDs, JWTs, or Access assertions. Structured logs contain
   only request ID, route name, status, trusted tenant/identity fingerprints, and
   stable error code.
8. A valid bearer token wins over the Access header. An invalid bearer token
   cannot be rescued by a valid Access assertion on the same request.
9. Connection metadata is tenant- and identity-filtered in SQL before mapping.
   Never fetch all tenant connections and filter only in JavaScript.
10. The backoffice uses the same public API as future clients and receives no
    Durable Object stub or internal identifier.

## 5. Cloudflare facts verified for this plan

- The current repository uses Wrangler `4.126.0`, JSONC configuration, a recent
  compatibility date, `nodejs_compat`, generated Worker binding types, and
  declarative Durable Object `exports`.
- Current Cloudflare documentation recommends SQLite-backed Durable Objects,
  typed RPC methods, `getByName()` for deterministic routing, synchronous SQL,
  and persistence before in-memory updates.
- Cloudflare Access supplies its application JWT in
  `Cf-Access-Jwt-Assertion`; the origin must validate signature, issuer, and
  audience rather than trust the header.
- Current Workers tests support `runInDurableObject` and
  `evictDurableObject`; this phase must prove read behavior after eviction.
- This phase adds no Queue/R2 numeric assumptions. Existing archive-first Queue
  semantics remain unchanged.

## 6. File responsibility map

### Create

- `apps/control-plane/migrations/0003_connection_read_metadata.sql` — forward-only
  D1 capability and health metadata.
- `apps/control-plane/worker/control-directory/read-repository.ts` — bounded,
  tenant-filtered identity connection reads.
- `apps/control-plane/worker/read/authorization.ts` — external-scope checks and
  construction of internal projection authorization.
- `apps/control-plane/worker/read/errors.ts` — one safe error vocabulary and
  mapping boundary for read routes.
- `apps/control-plane/worker/read/handlers.ts` — route-independent read use cases.
- `apps/control-plane/worker/routes/read.ts` — Hono OpenAPI route declarations
  and thin handlers.
- `apps/control-plane/worker/test/read/directory.test.ts` — D1 mapping, bounds,
  corruption, and tenant filters.
- `apps/control-plane/worker/test/read/projection-rpc.test.ts` — exact conversation
  and channel aggregate RPC tests.
- `apps/control-plane/worker/test/read/api.test.ts` — authenticated HTTP contract,
  isolation, pagination, and safe failure integration tests.
- `apps/control-plane/worker/test/read/openapi.test.ts` — published path/security
  contract.
- `docs/runbooks/live-read-api-local.md` — local mode, auth, seed prerequisites,
  and verification.

### Modify

- `packages/contracts/src/authorization.ts` — add `invalid_request` to the bounded
  public error code enum.
- `packages/contracts/src/projection.ts` — add internal exact-conversation and
  channel-stat RPC schemas.
- `packages/contracts/src/index.ts` — export the new schemas/types.
- `packages/contracts/test/projection.test.ts` and
  `packages/contracts/test/schemas.test.ts` — strict contract tests.
- `apps/control-plane/worker/projection/tenant-projection.ts` — implement the two
  new read RPCs without changing apply/rebuild behavior.
- `apps/control-plane/worker/auth/middleware.ts` — deterministic bearer-or-Access
  credential selection.
- `apps/control-plane/worker/app.ts` — register protected read routes and OpenAPI.
- `apps/control-plane/wrangler.jsonc` — add non-secret Access issuer/audience/JWKS
  variables per environment; do not add real credentials.
- `apps/control-plane/worker-configuration.d.ts` — regenerate only through
  `pnpm --filter @communicator/control-plane types:worker`.
- `apps/control-plane/src/lib/api/client.ts` — use `SessionResponse`, paginated
  messages, and the live endpoints.
- `apps/control-plane/src/lib/api/query-keys.ts` — key session and paginated reads
  by trusted identity/channel/conversation inputs.
- `apps/control-plane/src/components/identity/identity-switcher.tsx` — derive
  visible identities from the authenticated session response.
- `apps/control-plane/src/features/conversations/conversation-page.tsx` — consume
  message pages and render them in chronological order.
- `apps/control-plane/src/mocks/handlers.ts`, `apps/control-plane/src/mocks/store.ts`,
  and mock tests — return the same page-shaped message contract as live mode.
- relevant UI/API tests and `docs/superpowers/specs/2026-08-27-communicator-cloudflare-data-plane-design.md`
  — record the bounded navigation collection decision and completed live-read
  seam.

## Task 1: Freeze the read and projection contracts

**Files:**

- Modify: `packages/contracts/src/authorization.ts`
- Modify: `packages/contracts/src/projection.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/projection.test.ts`
- Test: `packages/contracts/test/schemas.test.ts`

- [ ] **Step 1: Write failing strict-schema tests.**

Add tests proving:

- `ApiErrorResponseSchema` accepts `invalid_request` and rejects unknown codes;
- channel stats accept only `{ connection_id, unread_count, last_activity_at }`;
- channel stats reject negative/unsafe counts, malformed IDs, bad timestamps,
  accessors, proxies, symbol keys, extra keys, and more than 64 rows;
- exact-conversation input requires schema version 1, tenant, identity,
  conversation, and internal authorization;
- channel-stat input requires one allowed identity and `projection.read`;
- all new request and response values are structured-clone safe.

Use these exact public shapes:

```ts
export const MAX_IDENTITY_CONNECTIONS = 64;

export const ProjectionChannelStatSchema = strictObject({
  connection_id: CanonicalResourceIdSchema,
  unread_count: z.number().int().safe().nonnegative(),
  last_activity_at: TimestampSchema.nullable(),
});

export const ProjectionChannelStatsSchema = strictArray(
  ProjectionChannelStatSchema,
  MAX_IDENTITY_CONNECTIONS,
);

export const ListProjectionChannelStatsInputSchema = strictObject({
  schema_version: z.literal(1),
  tenant_id: CanonicalResourceIdSchema,
  identity_id: CanonicalResourceIdSchema,
  authorization: ProjectionAuthorizationContextSchema,
});

export const GetProjectionConversationInputSchema = strictObject({
  schema_version: z.literal(1),
  tenant_id: CanonicalResourceIdSchema,
  identity_id: CanonicalResourceIdSchema,
  conversation_id: CanonicalResourceIdSchema,
  authorization: ProjectionAuthorizationContextSchema,
});

export const GetProjectionConversationResultSchema =
  ConversationSummarySchema.nullable();
```

- [ ] **Step 2: Run the focused contract tests and record RED.**

```bash
pnpm --filter @communicator/contracts test -- projection.test.ts schemas.test.ts
```

Expected: failure because the named schemas/constant/error code do not exist.

- [ ] **Step 3: Implement only the frozen schemas and exports.**

Reuse the hostile-input snapshot helpers already used by projection contracts.
Do not add broad `z.record`, passthrough objects, `any`, or unsafe casts.

- [ ] **Step 4: Re-run focused tests and typecheck.**

```bash
pnpm --filter @communicator/contracts test -- projection.test.ts schemas.test.ts
pnpm --filter @communicator/contracts check
```

Expected: both exit 0.

- [ ] **Step 5: Parent diff review and commit.**

The worker does not commit. The parent verifies changed-file scope and commits:

```bash
git commit -m "feat: freeze live read contracts"
```

## Task 2: Add bounded D1 connection read metadata

**Files:**

- Create: `apps/control-plane/migrations/0003_connection_read_metadata.sql`
- Create: `apps/control-plane/worker/control-directory/read-repository.ts`
- Create: `apps/control-plane/worker/test/read/directory.test.ts`
- Modify: `apps/control-plane/worker/test/control-directory-schema.test.ts`
- Modify: `apps/control-plane/worker/test/support/directory-fixtures.ts`

- [ ] **Step 1: Write the forward-only migration.**

The migration must add nullable `last_synced_at` and `attention_code`, plus a
nonnegative `sort_position` default, and create a normalized capability table:

```sql
ALTER TABLE connections ADD COLUMN last_synced_at TEXT;
ALTER TABLE connections ADD COLUMN attention_code TEXT
  CHECK (attention_code IS NULL OR length(attention_code) BETWEEN 1 AND 100);
ALTER TABLE connections ADD COLUMN sort_position INTEGER NOT NULL DEFAULT 0
  CHECK (sort_position >= 0);

CREATE TABLE connection_capabilities (
  tenant_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (capability IN (
    'message.send', 'message.edit', 'message.delete',
    'reaction.add', 'reaction.remove', 'receipt.read',
    'typing.send', 'attachment.send'
  )),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, connection_id, capability),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES connections(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX connection_capabilities_connection_idx
  ON connection_capabilities(connection_id, capability);
```

Do not backfill guessed capabilities in the migration. Existing deployed
connections remain valid with an empty capability list until an operator or
later Connection Gateway writes verified capabilities.

- [ ] **Step 2: Write RED migration/repository tests.**

Prove:

- migrations 0001→0002→0003 apply once and re-running the migration harness is
  harmless;
- invalid capability, negative sort position, cross-tenant capability row, and
  overlong attention code fail;
- Human and Agent connections cannot cross filters;
- disconnected and attention-required rows remain visible;
- capability arrays are sorted and duplicate-free;
- 65 visible connections fail closed with stable `read_directory_too_large`;
- malformed/corrupt D1 rows fail with stable `read_directory_invalid` and do not
  leak the row.

- [ ] **Step 3: Run focused tests and record RED.**

```bash
pnpm --filter @communicator/control-plane test:worker -- \
  control-directory-schema.test.ts read/directory.test.ts
```

- [ ] **Step 4: Implement `listConnectionsForIdentity`.**

The repository accepts `D1DatabaseSession`, trusted `tenantId`, and trusted
`identityId`. SQL must include both filters and sort by
`sort_position ASC, connection_id ASC, capability ASC`. Group rows by
connection and finish every result through `ConnectionSchema.parse`.

Use `updated_at` only as directory metadata; never mislabel it as
`last_synced_at`. Preserve `null` until a real sync timestamp is recorded.

- [ ] **Step 5: Seed deterministic test capabilities.**

Add `message.send`, `receipt.read`, and `typing.send` for the Human WhatsApp
fixture; add only `message.send` for the Agent fixture. Keep fixture timestamps
fixed and non-secret.

- [ ] **Step 6: Re-run focused tests and worker typecheck.**

```bash
pnpm --filter @communicator/control-plane test:worker -- \
  control-directory-schema.test.ts read/directory.test.ts
pnpm --filter @communicator/control-plane check
```

- [ ] **Step 7: Parent diff review and commit.**

```bash
git commit -m "feat: add connection read metadata"
```

## Task 3: Add exact-conversation and channel-stat Durable Object RPCs

**Files:**

- Modify: `apps/control-plane/worker/projection/tenant-projection.ts`
- Create: `apps/control-plane/worker/test/read/projection-rpc.test.ts`
- Reuse: `apps/control-plane/worker/test/projection/projector-test-support.ts`

- [ ] **Step 1: Write RED RPC tests.**

Initialize a tenant projection and apply deterministic Human and Agent events.
Prove:

- `getConversation` returns one `ConversationSummary` for the exact authorized
  tenant/identity/conversation;
- missing, deleted, and other-identity conversation IDs all return `null`;
- `listChannelStats` returns one row per connection, sorted by connection ID,
  with unread sums and the latest activity timestamp;
- zero-message connections are omitted by the DO and later filled by D1 mapping;
- wrong tenant, missing `projection.read`, or an unauthorized identity fails
  through the existing safe projection error boundary;
- uninitialized, rebuilding, and corrupt projections fail closed;
- results survive `evictDurableObject` unchanged;
- no method mutates `projection_changes`, checkpoints, or event markers.

- [ ] **Step 2: Run the focused test and record RED.**

```bash
pnpm --filter @communicator/control-plane test:worker -- \
  read/projection-rpc.test.ts
```

- [ ] **Step 3: Implement the two RPCs.**

Required signatures:

```ts
async getConversation(
  input: GetProjectionConversationInput,
): Promise<ConversationSummary | null>

async listChannelStats(
  input: ListProjectionChannelStatsInput,
): Promise<ProjectionChannelStat[]>
```

Both methods must:

1. parse with the strict shared schema;
2. require trusted tenant, `projection.read`, and identity authorization;
3. require an initialized ready projection;
4. query SQLite synchronously;
5. parse/map through shared response schemas; and
6. return `structuredClone(...)` values across RPC.

Use one aggregate query:

```sql
SELECT connection_id,
       SUM(unread_count) AS unread_count,
       MAX(last_activity_at) AS last_activity_at
FROM conversations
WHERE identity_id = ? AND deleted_at IS NULL
GROUP BY connection_id
ORDER BY connection_id ASC
LIMIT 65
```

The extra row is a fail-closed bound check. Reject unsafe aggregate integers.
Do not add a second SQLite transaction, cache, or table.

- [ ] **Step 4: Run focused and existing projection query tests.**

```bash
pnpm --filter @communicator/control-plane test:worker -- \
  read/projection-rpc.test.ts projection/queries.test.ts projection/rebuild.test.ts
```

- [ ] **Step 5: Parent diff review and commit.**

```bash
git commit -m "feat: add projection read RPCs"
```

## Task 4: Harden browser and machine authentication selection

**Files:**

- Modify: `apps/control-plane/worker/auth/middleware.ts`
- Modify: `apps/control-plane/worker/app.ts`
- Modify: `apps/control-plane/wrangler.jsonc`
- Modify: `apps/control-plane/worker/test/session.test.ts`
- Modify: `apps/control-plane/worker-configuration.d.ts` through generation only

- [ ] **Step 1: Write RED authentication tests.**

Add cases proving:

- bearer authentication remains unchanged;
- absent bearer plus valid `Cf-Access-Jwt-Assertion` uses the Access verifier;
- malformed or invalid Access assertion returns the same generic 401 body;
- an invalid bearer plus a valid Access assertion is still 401 and never calls
  the Access verifier;
- no token/assertion/issuer/subject appears in response, logs, or errors;
- missing Access configuration fails closed rather than trusting the header.

- [ ] **Step 2: Run session tests and record RED.**

```bash
pnpm --filter @communicator/control-plane test:worker -- session.test.ts
```

- [ ] **Step 3: Implement deterministic credential selection.**

Extend middleware options with `getAccessVerifier`. Use this exact order:

```ts
const authorization = context.req.header("Authorization");
const accessAssertion = context.req.header("Cf-Access-Jwt-Assertion");

const subject = authorization !== undefined
  ? await options.getVerifier(context.env).verify(parseBearerToken(authorization))
  : await options.getAccessVerifier(context.env).verify(
      parseAccessAssertion(accessAssertion),
    );
```

`parseAccessAssertion` accepts exactly one nonempty ASCII JWT-shaped string with
the same maximum used for bearer tokens. It must not trim, log, decode, or echo
the token. If both headers exist, bearer wins.

Add only non-secret variables:

```jsonc
"COMMUNICATOR_ACCESS_ISSUER": "https://access-team-name.cloudflareaccess.com",
"COMMUNICATOR_ACCESS_AUDIENCE": "replace-at-deploy-time",
"COMMUNICATOR_ACCESS_JWKS_URL": "https://access-team-name.cloudflareaccess.com/cdn-cgi/access/certs"
```

Use explicit `.invalid` placeholders in local/staging/production configuration
until the deployment phase supplies real values. Never commit a JWT, service
token, client secret, or real audience tag in this phase.

- [ ] **Step 4: Generate Worker types and re-run tests.**

```bash
pnpm --filter @communicator/control-plane types:worker
pnpm --filter @communicator/control-plane test:worker -- session.test.ts
git diff --check
```

- [ ] **Step 5: Parent confirms generated-type-only drift and commits.**

```bash
git commit -m "feat: accept verified Access assertions"
```

## Task 5: Implement the authenticated live read routes and OpenAPI document

**Files:**

- Create: `apps/control-plane/worker/read/authorization.ts`
- Create: `apps/control-plane/worker/read/errors.ts`
- Create: `apps/control-plane/worker/read/handlers.ts`
- Create: `apps/control-plane/worker/routes/read.ts`
- Create: `apps/control-plane/worker/test/read/api.test.ts`
- Create: `apps/control-plane/worker/test/read/openapi.test.ts`
- Modify: `apps/control-plane/worker/app.ts`

- [ ] **Step 1: Freeze authorization helpers with RED tests.**

Implement tests before code for these pure decisions:

```ts
requireAuthorizedIdentity(session, identityId, requiredScope)
toProjectionReadAuthorization(session, identityId)
readErrorResponse(error)
```

The internal projection authorization must be exactly:

```ts
{
  schema_version: 1,
  tenant_id: session.tenant.id,
  principal_id: session.principal.id,
  allowed_identity_ids: [identityId],
  scopes: ["projection.read"],
}
```

It is constructed only after the external `conversation.read` or
`connection.read` grant is proven. Unknown identity and missing scope produce
the same internal not-found result.

- [ ] **Step 2: Declare strict Hono OpenAPI routes.**

Path/query schemas use `CommunicatorIdSchema`, strict single-value cursor strings,
and a coerced integer limit from 1 through `MAX_PROJECTION_PAGE_SIZE`. Reject
arrays/repeated query parameters explicitly before Zod coercion.

Every protected route declares bearer security and the bounded 400, 401, 404,
and 503 response schemas. Do not document internal projection error codes.

- [ ] **Step 3: Write the HTTP integration tests and record RED.**

Seed two authorized principals and two identities, then initialize/apply both
projection views. Cover:

- identities contain only the authenticated session identities;
- connections are filtered in D1 by trusted tenant and identity;
- channel rows merge D1 connection metadata with DO unread/activity stats and
  fill zero/null for connections without conversations;
- all-channel conversations sort by recency and channel filter maps to
  `connection_id`;
- exact conversation and message pages preserve opaque cursors;
- Human cannot probe Agent and Agent cannot probe Human;
- unauthorized, missing, deleted, and guessed IDs have byte-identical 404 bodies;
- malformed IDs/cursors/limits have byte-identical 400 bodies;
- rebuilding/unavailable/corrupt DO state produces generic 503;
- no response outside the requested message endpoint contains message body,
  Matrix ID, provider remote ID, gateway route, bridge instance, JWT, or cursor
  from another request;
- the Worker uses `TENANT_PROJECTION.getByName(session.tenant.id)` and never a
  caller tenant value.

Run RED:

```bash
pnpm --filter @communicator/control-plane test:worker -- \
  read/api.test.ts read/openapi.test.ts
```

- [ ] **Step 4: Implement thin route-independent handlers.**

Handlers receive `{ env, authorization }` plus parsed route input. They call only
the D1 read repository and the tenant projection stub. Route modules own HTTP;
handlers return contract values or `ReadError`. Do not place SQL, RPC routing,
or scope checks directly in JSX or Hono registration code.

For channels:

1. list D1 connections for the authorized identity;
2. fetch DO channel stats once;
3. index stats by `connection_id`;
4. map each connection to `ChannelSummary` with `id = connection.id`;
5. parse the final array with `ChannelSummarySchema.array().max(64)`.

For messages, the API returns `MessagePageResult`, not a bare array.

- [ ] **Step 5: Register middleware and routes.**

Register health before protected middleware. Apply product authorization to
every read route and session. Do not apply product middleware to
`/internal/v1/ingestion/batches`, which keeps its dedicated service audience.

Publish:

```ts
app.doc("/api/v1/openapi.json", {
  openapi: "3.1.0",
  info: { title: "Communicator API", version: "1.0.0" },
});
```

- [ ] **Step 6: Run focused and complete Worker tests.**

```bash
pnpm --filter @communicator/control-plane test:worker -- \
  read/api.test.ts read/openapi.test.ts session.test.ts authorization.test.ts
pnpm --filter @communicator/control-plane test:worker
```

- [ ] **Step 7: Parent diff review and commit.**

```bash
git commit -m "feat: publish authenticated live read API"
```

## Task 6: Switch the backoffice client to session and message-page contracts

**Files:**

- Modify: `apps/control-plane/src/lib/api/client.ts`
- Modify: `apps/control-plane/src/lib/api/query-keys.ts`
- Modify: `apps/control-plane/src/components/identity/identity-switcher.tsx`
- Modify: `apps/control-plane/src/features/conversations/conversations-shell.tsx`
- Modify: `apps/control-plane/src/features/conversations/conversation-page.tsx`
- Modify: `apps/control-plane/src/mocks/handlers.ts`
- Modify: `apps/control-plane/src/mocks/store.ts`
- Modify: relevant UI and API client tests

- [ ] **Step 1: Write RED API client tests.**

Prove the client:

- loads `/api/v1/session` with `SessionResponseSchema`;
- derives `Identity[]` from `session.identities` plus trusted tenant ID;
- parses connection/channel arrays strictly;
- parses both conversation and message pages strictly;
- sends encoded cursor/limit exactly once;
- rejects malformed server responses with generic `ApiError(502)` without
  including response data;
- does not add tenant, principal, projection scope, or Authorization data from
  browser-controlled query state.

Delete the private `MeResponseSchema`; use the shared `SessionResponseSchema`.

- [ ] **Step 2: Update simulated handlers to the live shapes.**

The message mock must return:

```ts
{
  items: Message[],
  next_cursor: string | null,
}
```

Use the same deterministic cursor helpers as conversation mocks. Preserve
identity and conversation isolation. Do not make simulated mode more permissive
than live mode.

- [ ] **Step 3: Convert the message timeline to an infinite query.**

Use `MessagePageResult`, `initialPageParam: null`, and
`getNextPageParam: page => page.next_cursor`. The DO/API returns newest-first
pages; render the combined set chronologically by reversing a copied flattened
array. Never mutate TanStack Query cache arrays in place.

Add a bounded “Load older messages” control at the top of the scrollable
timeline. Preserve the composer at the anchored bottom and preserve the current
conversation three-panel layout.

- [ ] **Step 4: Derive identity state from session.**

`IdentityProvider` makes one session query, maps only authorized identities, and
keeps the existing identity-switch cancellation behavior. Channel order storage
uses `session.principal.id`; it must not need a separate `/me` request.

- [ ] **Step 5: Run focused UI tests and record GREEN.**

```bash
pnpm --filter @communicator/control-plane test:ui -- \
  src/lib/api/client.test.ts \
  src/components/identity/identity-switcher.test.tsx \
  src/features/conversations/conversation-page.test.tsx \
  src/features/conversations/conversations-shell.test.tsx \
  src/mocks/handlers.test.ts
```

Expected: exit 0 with tests for page merging, chronological rendering, loading
older messages, identity switching, and simulated/live contract parity.

- [ ] **Step 6: Run all UI tests and build.**

```bash
pnpm --filter @communicator/control-plane test:ui
pnpm --filter @communicator/control-plane check
```

- [ ] **Step 7: Parent diff review and commit.**

```bash
git commit -m "feat: connect inbox to live read contracts"
```

## Task 7: Add end-to-end isolation and browser checkpoints

**Files:**

- Create or modify: `apps/control-plane/e2e/live-read-api.spec.ts`
- Modify only if necessary: existing Playwright support and deterministic mock
  fixtures

- [ ] **Step 1: Write the browser acceptance test.**

In simulated mode, prove the UI contract still works:

1. Human sees only Human channels and conversations.
2. Switching to Agent clears the Human thread and query caches.
3. Direct navigation to a Human conversation while Agent is active displays the
   generic unavailable state.
4. Channel filtering preserves recency order and pagination.
5. Older message pages prepend chronologically without moving the composer.
6. API failures show bounded retry UI and never render raw error payloads.

Do not introduce a browser-only bypass around API authorization.

- [ ] **Step 2: Run the focused browser test.**

```bash
pnpm --filter @communicator/control-plane test:e2e -- live-read-api.spec.ts
```

- [ ] **Step 3: Run full browser acceptance.**

```bash
pnpm --filter @communicator/control-plane test:e2e
```

- [ ] **Step 4: Parent diff review and commit if files changed.**

```bash
git commit -m "test: verify live read inbox isolation"
```

## Task 8: Documentation, phase gates, and independent review

**Files:**

- Create: `docs/runbooks/live-read-api-local.md`
- Modify: `docs/superpowers/specs/2026-08-27-communicator-cloudflare-data-plane-design.md`

- [ ] **Step 1: Write the runbook.**

Document separately:

- simulated browser mode versus live API mode;
- bearer authentication for API clients;
- Cloudflare Access assertion validation for the same-origin backoffice;
- required D1 migration order and verified connection capabilities;
- the fact that live APIs may return an empty projection until Matrix ingestion
  exists;
- generic 400/401/404/503 failure meanings;
- local Worker test commands and generated-type drift check;
- no live credential, Access audience, or production deployment in this phase.

- [ ] **Step 2: Update the system spec.**

Record that identities/connections/channels are bounded navigation collections
and conversations/messages are cursor-paginated. Do not weaken tenant,
identity, retention, encryption, or provider-risk requirements.

- [ ] **Step 3: Run one complete test/quality gate through a Luna test worker.**

Run sequentially in one worker so build caches are reused:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
chmod 0755 scripts/init-telegram-runtime.sh
pnpm test:python
pnpm --filter @communicator/control-plane types:worker
git diff --exit-code -- apps/control-plane/worker-configuration.d.ts
git diff --check
git status --short
```

The test worker must report exact exit statuses and first actionable failure. It
must not edit source to fix a failure.

- [ ] **Step 4: Run independent reviews in parallel only after the diff is stable.**

Use two read-only Luna reviewers with disjoint scopes:

1. **Authorization/API reviewer:** bearer/Access precedence, D1 tenant filters,
   identity scopes, generic denial equivalence, route/OpenAPI contract, and
   secret/log redaction.
2. **DO/UI reviewer:** private DO routing, read-only RPCs, bounds/cursors,
   eviction behavior, message order, query-cache isolation, and mock/live parity.

Each reviewer returns either PASS or severity-ordered P1/P2 findings with exact
file:line evidence. Reviewers do not run tests or modify files.

- [ ] **Step 5: Consolidate fixes once.**

If findings exist, dispatch one Luna writer for non-overlapping confirmed fixes,
run only affected focused tests, then rerun the full gate once and obtain a
targeted re-review. Do not launch repeated broad review loops.

- [ ] **Step 6: Parent completion audit and final commit.**

The parent reads every production diff, verifies every acceptance item below,
and commits documentation/fixes with:

```bash
git commit -m "docs: add live read API operations"
```

## Task 9: Pull request, merge, and merged-main proof

- [ ] Push `codex/live-read-api` and open a private-repository PR summarizing
  routes, authorization, D1/DO ownership, pagination, UI behavior, tests, and
  deferred scope.
- [ ] Wait for GitHub checks; inspect and fix failures rather than assuming local
  tests cover them.
- [ ] Merge only when checks pass and the branch is current with `origin/main`.
- [ ] Fast-forward the local main worktree to `origin/main`.
- [ ] Run the same complete gate on merged main.
- [ ] Confirm the PR is `MERGED`, local main equals `origin/main`, generated
  Worker types have no drift, and `git status --short` is clean.
- [ ] Do not mark the overall Communicator goal complete. Continue with milestone
  10, hibernatable WebSocket tickets and resumable subscriptions.

## 7. Phase acceptance checklist

### API and authorization

- [ ] All seven read/OpenAPI endpoints exist at the exact paths above.
- [ ] Every data endpoint authenticates; health and OpenAPI disclose no tenant
  data.
- [ ] Bearer and Access credentials are independently verified; bearer precedence
  is deterministic.
- [ ] Tenant routing comes only from resolved authorization context.
- [ ] Identity scopes are checked before D1 or DO reads.
- [ ] Cross-tenant and Human/Agent probes return generic, indistinguishable 404s.
- [ ] Malformed input returns bounded 400; infrastructure failure returns bounded
  503.

### D1 and Durable Object boundaries

- [ ] D1 owns non-secret connection metadata and filters by tenant plus identity
  in SQL.
- [ ] Capability values are normalized, bounded, and schema-validated.
- [ ] `TenantProjectionDO` remains the only conversation/message query store.
- [ ] The Worker uses one tenant-named DO and sends one-identity internal auth.
- [ ] Exact conversation and channel-stat RPCs are read-only and eviction-safe.
- [ ] Rebuild/uninitialized/corrupt state fails closed.

### Pagination and browser behavior

- [ ] Identities/connections/channels are bounded to 64.
- [ ] Conversations and messages preserve existing opaque seek cursors.
- [ ] Message pages render chronologically without mutating cached pages.
- [ ] Identity switching cancels and isolates relevant query caches.
- [ ] Simulated and live modes use identical response schemas.
- [ ] The current multi-panel conversation layout and anchored composer remain
  intact.

### Privacy and operational safety

- [ ] No logs/errors expose content, cursors, JWTs, Access assertions, Matrix IDs,
  remote IDs, gateway routes, or bridge placement.
- [ ] No browser receives internal projection authorization or storage handles.
- [ ] No production credentials, Cloudflare resources, or provider actions are
  created in this phase.
- [ ] The runbook states the empty-live-projection behavior honestly.

### Verification

- [ ] Focused RED→GREEN evidence exists for every implementation task.
- [ ] Contract, Worker, UI, browser, Rust, and Python suites pass.
- [ ] `pnpm check`, generated Worker types, formatting, and diff checks pass.
- [ ] Both independent reviewers report PASS after any fixes.
- [ ] PR checks pass, PR is merged, and post-merge main verification passes.

## 8. Next phases after merge

1. Milestone 10: hibernatable WebSocket tickets, subscriptions, and resume from
   `projection_changes`.
2. Milestone 11: connect the persistent Matrix adapter to normalization, the
   encrypted local upload outbox, and authenticated ingestion.
3. Milestones 12–14: `IdentityCommandDO`, direct send, paced typing/read/send,
   cancellation, reactions, edits, deletes, and capability negotiation.

