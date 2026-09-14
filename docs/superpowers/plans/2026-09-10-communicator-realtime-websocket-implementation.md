# Resumable realtime WebSocket implementation plan

> **Execution requirement:** The primary session plans, orchestrates, reviews,
> commits, opens the pull request, and merges. Implementation and test execution
> use ephemeral `codex exec` workers with model `gpt-5.6-luna`, reasoning effort
> `max`, service tier `fast`, and self-contained prompts. Each writer uses its own
> isolated task worktree and may edit only its assigned files. Run writers in
> parallel only where the execution waves below declare their scopes independent.
> Test workers use `workspace-write`; static reviewers use `read-only`; reviewers
> never edit or review their own work. Give every worker an explicit file list and
> a 20-minute wall-clock limit. Stop and split a task that exceeds the limit.
> Verify the Git diff after every worker wave.

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:test-driven-development` and `superpowers:executing-plans` for each
> implementation task. Write the failing test first, run it and record the
> expected failure, then write the minimum production change.

> **Execution waves:** Complete Task 1 first on the integration branch. Create
> three task worktrees from that commit and run Tasks 2, 3, and 7 in parallel;
> their file lists do not overlap. Review and cherry-pick each accepted commit
> into the integration branch. From that combined commit, run Tasks 4 and 5 in
> parallel worktrees. Integrate both, then run Tasks 6 and 8 in parallel because
> Task 6 owns Worker projection files while Task 8 owns browser UI files. Complete
> Task 9 after all implementation is integrated. Task 10 is the single phase gate.
> During a task, run only its focused tests. During a wave, run affected-package
> tests. Run the full repository gate once in Task 10 and use only branch equality
> plus the documented short smoke test after a conflict-free merge.

**Goal:** Add an authenticated, tenant- and identity-isolated hibernatable
WebSocket API that resumes bounded projection changes after reconnect and makes
the live backoffice refresh from the authoritative REST API.

**Architecture:** An authenticated HTTPS endpoint issues a 30-second,
single-use opaque ticket whose SHA-256 digest and bounded subscription are held
in D1. The WebSocket upgrade consumes that ticket, rechecks current directory
authorization, and routes only by the trusted ticket tenant to the existing
tenant-named `TenantProjectionDO`. The DO uses Cloudflare's Hibernation API,
stores all per-socket authorization in serialized attachments, replays
identity-local change sequences from SQLite, and broadcasts only after the
projection transaction is durable. The browser treats WebSockets as an
invalidation signal and continues to obtain content through authenticated REST.

**Tech stack:** TypeScript 7, Zod 4, Hono with `@hono/zod-openapi`, D1,
SQLite-backed Durable Objects, Cloudflare Hibernation WebSocket API,
`@cloudflare/vitest-plugin`, React 19, TanStack Query, MSW, Playwright, Wrangler
4, and pnpm 10.

---

## 1. Position in the approved delivery sequence

This is milestone 10 in
`docs/superpowers/specs/2026-08-27-communicator-cloudflare-data-plane-design.md`:

> hibernatable WebSocket tickets, subscriptions, and resume from
> `projection_changes`

Already merged and reused:

- product bearer and Cloudflare Access verification;
- D1 tenant, membership, identity, and scope authorization;
- the authenticated live REST read API;
- one SQLite-backed `TenantProjectionDO` per tenant;
- retained `projection_changes`, generation checks, change floors, and rebuild
  behavior; and
- simulated realtime events and the backoffice cache-update seam.

This phase does not wait for live Matrix ingestion. Tests apply canonical events
directly through the existing projection boundary. Milestone 11 will connect the
persistent Matrix adapter to the already tested ingestion API.

## 2. Simple outcome

After this phase, an authorized application can:

1. request a one-time realtime ticket for one or more identities it may inspect;
2. open one `wss://` connection without putting its long-lived bearer token in
   the URL;
3. receive a small notification after a conversation projection changes;
4. reconnect with its last identity-local sequence and receive missed retained
   notifications; and
5. fall back to REST when the server says history is unavailable or the
   projection generation changed.

The notification contains no message body, preview, participant name, Matrix
identifier, provider identifier, ticket, or storage identifier. It tells the
client which authorized REST data may have changed. REST remains authoritative.

## 3. Locked protocol and scope

### 3.1 Public endpoints

```http
POST /api/v1/realtime/tickets
GET  /api/v1/realtime?ticket=rt1_<43 base64url characters>
```

`POST /api/v1/realtime/tickets` uses the existing product authentication
middleware. Its OpenAPI security declaration remains `bearerAuth`; Cloudflare
Access is an edge-injected same-origin credential and is not advertised as a
client-supplied header.

The WebSocket request must include:

```http
Upgrade: websocket
Sec-WebSocket-Protocol: communicator.realtime.v1
```

The upgrade endpoint accepts only the short-lived ticket. It does not accept a
bearer token, an Access assertion, a tenant ID, or identity IDs from query
parameters. The Worker consumes the ticket before selecting a Durable Object.

### 3.2 Ticket request

```json
{
  "schema_version": 1,
  "subscriptions": [
    {
      "identity_id": "identity_human",
      "families": ["projection"]
    }
  ],
  "resume": [
    {
      "identity_id": "identity_human",
      "generation": 1,
      "after_sequence": 42
    }
  ]
}
```

Rules:

- one through 16 unique subscription identities;
- version 1 supports only the `projection` family;
- each identity requires `conversation.read` in the current resolved session;
- `resume` is optional and contains at most one position for each subscribed
  identity;
- no resume entry may name an identity absent from `subscriptions`;
- duplicate identities or families are invalid requests; and
- the client never sends tenant, principal, membership, or internal projection
  authorization.

### 3.3 Ticket response

```json
{
  "schema_version": 1,
  "ticket": "rt1_<43 base64url characters>",
  "expires_at": "2026-09-10T10:00:30.000Z",
  "websocket_url": "wss://communicator.example/api/v1/realtime?ticket=..."
}
```

The response uses `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
The raw ticket exists only in this response and the single upgrade URL. D1
stores only its SHA-256 digest. A ticket expires after 30 seconds and is deleted
atomically when consumed. A rejected or failed upgrade requires a new ticket.

### 3.4 Server frames

All JSON frames are strict and versioned. The negotiated subprotocol is
`communicator.realtime.v1`.

Connected frame:

```json
{
  "schema_version": 1,
  "type": "connected",
  "tenant_id": "tenant_pilot",
  "positions": [
    { "identity_id": "identity_human", "generation": 1, "sequence": 42 }
  ],
  "connection_expires_at": "2026-09-10T10:15:00.000Z"
}
```

Change frame, with at most 100 changes for one identity:

```json
{
  "schema_version": 1,
  "type": "projection.changes",
  "tenant_id": "tenant_pilot",
  "identity_id": "identity_human",
  "generation": 1,
  "from_sequence": 43,
  "to_sequence": 44,
  "changes": [
    {
      "sequence": 43,
      "event_type": "message.created",
      "connection_id": "connection_human_whatsapp",
      "conversation_id": "conversation_family",
      "occurred_at": "2026-09-10T10:00:01.000Z"
    }
  ]
}
```

Reset frame:

```json
{
  "schema_version": 1,
  "type": "reset_required",
  "tenant_id": "tenant_pilot",
  "identity_id": "identity_human",
  "generation": 2,
  "latest_sequence": 7,
  "reason": "generation_changed"
}
```

`reason` is one of `generation_changed`, `history_unavailable`, or
`replay_too_large`. A reset means the client invalidates the affected identity's
REST queries, accepts the supplied generation/latest sequence as its new
baseline, and keeps the socket open for later changes.

The literal text frame `ping` receives `pong` through
`setWebSocketAutoResponse()` without waking the hibernated DO. Clients cannot
change subscriptions or issue commands over this socket. Any other inbound
frame closes with policy code 1008.

### 3.5 Resume and bounds

- Public sequences are monotonically increasing per identity, not tenant-global.
  This prevents a Human subscription from inferring Agent activity from gaps in
  a shared tenant sequence.
- Projection generation is part of every position. A generation mismatch never
  replays across a rebuild.
- Replay is capped at 500 matching changes per identity per connection.
- Frames contain at most 100 changes and only projection metadata.
- A WebSocket authorization lease lasts 15 minutes. Reconnection obtains a new
  ticket and therefore rechecks membership, identity status, and scopes.
- One tenant DO accepts at most 256 concurrent realtime sockets and at most 8
  for one principal. These are Communicator pilot limits, below Cloudflare's
  platform maximum.
- A failed send never rolls back a projection write. The client reconnects and
  uses replay.

## 4. Non-goals

- No direct send, typing, reaction, edit, delete, read-receipt, or command API;
- no live Matrix-to-Queue ingestion enablement;
- no link-session, export, replay-progress, or automation events;
- no WebSocket-delivered message bodies or attachment metadata;
- no client-selected tenant or internal Durable Object name;
- no separate realtime DO class;
- no production Cloudflare deployment or Access application mutation;
- no R2 Data Catalog, Pipelines, Brain integration, analytics, or reports; and
- no guarantee that a WebSocket notification replaces a REST read.

The external protocol must not mention `TenantProjectionDO`. A later release may
move connection coordination to another DO without changing endpoint paths or
frame schemas.

## 5. Security, privacy, and failure invariants

1. Resolve the ticket request through existing product authentication. Derive
   tenant, principal, membership, identities, and scopes only from
   `SessionResponse`.
2. Use `crypto.getRandomValues()` for 32 ticket bytes and SHA-256 for the stored
   digest. Never use `Math.random()`, a UUID alone, or a reversible ticket.
3. Consume a ticket with one conditional D1 `DELETE ... RETURNING` statement.
   Concurrent upgrades cannot both obtain the row.
4. After consumption, re-read the active membership, identity, and
   `conversation.read` grants before routing. A revoked grant fails closed.
5. Route with `TENANT_PROJECTION.getByName(consumed.tenant_id)` only. Never route
   from a request query, header, host, or socket frame.
6. The parent Worker constructs the internal socket authorization object. The
   external client cannot submit or override it.
7. `TenantProjectionDO.fetch()` accepts only the internal upgrade path and
   strict bounded internal context. The public Worker never forwards an
   external internal-context header.
8. Serialized WebSocket attachments contain only tenant, principal,
   subscriptions, identity-local positions, and lease expiry. They remain below
   Cloudflare's 16,384-byte attachment limit.
9. Do not store or log raw tickets, WebSocket URLs, bearer tokens, Access
   assertions, message content, participant labels, Matrix IDs, remote IDs, or
   internal context JSON.
10. Unauthorized, expired, already-consumed, malformed, or revoked tickets all
    return the same bounded `401 unauthenticated` response before upgrade.
11. D1/DO failures and capacity rejection return bounded
    `503 service_unavailable`. Invalid protocol or non-upgrade requests return
    bounded `400 invalid_request`.
12. Parse every attachment and frame through a strict Zod schema. A corrupt
    attachment closes only that socket and does not fail projection ingestion.
13. Persist projection changes and identity sequence counters before attempting
    any `WebSocket.send()`.
14. Duplicate ingestion produces no duplicate notification. Reconnect replay
    may repeat a frame already received before disconnect, so clients reject
    sequences at or below their stored position.
15. Rebuild start sends a reset notification and closes current sockets with
    code 1012. Reconnect after rebuild uses the new generation.
16. A socket may remain physically connected while the DO hibernates. No
    authorization state may exist only in an in-memory map or class field.

## 6. Current Cloudflare facts verified for this plan

Verified from current official Cloudflare documentation on 2026-09-10:

- `DurableObjectState.acceptWebSocket()` enables hibernation; do not also call
  the standard `WebSocket.accept()` on the server endpoint.
- Incoming messages and closes wake the DO through `webSocketMessage` and
  `webSocketClose`; the constructor runs again after hibernation.
- `getWebSockets()` returns sockets after hibernation and can filter optional
  tags.
- `serializeAttachment()` survives hibernation, supports structured-clone data,
  and is limited to 16,384 bytes.
- `setWebSocketAutoResponse()` answers a matching request without waking the DO;
  each configured request and response is limited to 2,048 characters.
- Cloudflare permits at most 32,768 hibernatable sockets per DO, subject to
  lower practical CPU and memory limits. Communicator deliberately caps at 256.
- Cloudflare documents hibernation as the cost-efficient alternative to keeping
  a DO active for the whole WebSocket lifetime.
- Worker-level Access policies currently reject WebSocket upgrades. A future
  deployment must use a hostname-based Access application for the backoffice
  hostname.

Sources:

- https://developers.cloudflare.com/durable-objects/api/state/
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
- https://developers.cloudflare.com/workers/configuration/cloudflare-access/

Before implementation, use the checked-in generated Worker types and Wrangler
schema for exact signatures. Regenerate types only with the repository command.

## 7. File responsibility map

### Create

- `apps/control-plane/migrations/0004_realtime_tickets.sql` - D1 digest-only,
  single-use ticket storage and expiry index.
- `apps/control-plane/worker/realtime/contracts.ts` - internal upgrade context,
  socket attachment, and safe parsing helpers.
- `apps/control-plane/worker/realtime/token.ts` - 32-byte base64url ticket
  generation and SHA-256 digest.
- `apps/control-plane/worker/realtime/ticket-repository.ts` - D1 issue, consume,
  cleanup, and current-grant revalidation.
- `apps/control-plane/worker/realtime/authorization.ts` - subscription and resume
  validation against resolved product authorization.
- `apps/control-plane/worker/realtime/handlers.ts` - ticket issue and external
  upgrade orchestration.
- `apps/control-plane/worker/routes/realtime.ts` - ticket OpenAPI declaration and
  route schemas.
- `apps/control-plane/worker/realtime/tenant-sockets.ts` - replay selection,
  frame batching, attachment filtering, capacity, expiry, and safe send helpers.
- `apps/control-plane/worker/realtime/telemetry.ts` - closed, privacy-safe
  structured socket events used to derive pilot connection metrics.
- `apps/control-plane/worker/test/realtime/tickets.test.ts` - D1 storage,
  single-use, expiry, revocation, and redaction tests.
- `apps/control-plane/worker/test/realtime/api.test.ts` - authenticated ticket and
  upgrade route tests.
- `apps/control-plane/worker/test/realtime/socket.test.ts` - hibernation, replay,
  filters, broadcast, expiry, rebuild, and failure-isolation tests.
- `apps/control-plane/src/lib/realtime/live-client.ts` - ticket acquisition,
  WebSocket lifecycle, validation, resume storage, and reconnect.
- `apps/control-plane/src/lib/realtime/live-client.test.ts` - deterministic fake
  WebSocket and storage tests.
- `docs/runbooks/realtime-websocket-local.md` - protocol, local verification,
  Access topology, limits, and troubleshooting.

### Modify

- `packages/contracts/src/realtime.ts` and
  `packages/contracts/test/realtime.test.ts` - strict ticket, position, change,
  and server-frame contracts.
- `packages/contracts/src/projection.ts` and projection tests - document and
  enforce identity-local change sequences.
- `packages/contracts/src/index.ts` - continue exporting realtime contracts.
- `apps/control-plane/worker/projection/schema.ts` - add immutable migration 2
  for identity-local sequences without replacing version 1.
- `apps/control-plane/worker/projection/tenant-projection.ts` - use the new
  sequence, accept hibernatable sockets, replay, broadcast after commit, expire
  leases, and reset on rebuild.
- `apps/control-plane/worker/app.ts` - register ticket and upgrade routes.
- `apps/control-plane/worker/index.ts` - keep exporting the modified DO class.
- `apps/control-plane/worker/test/projection/schema.test.ts` and
  `queries.test.ts` - migration and identity-local resume behavior.
- `apps/control-plane/wrangler.jsonc` and
  `apps/control-plane/worker-configuration.d.ts` - no new binding; regenerate
  platform types only if Wrangler changes generated output.
- `apps/control-plane/src/lib/api/client.ts` and tests - ticket request method.
- `apps/control-plane/src/lib/realtime/client.ts`, `simulated-client.ts`, and
  `runtime-client.ts` - subscription-aware common client boundary.
- `apps/control-plane/src/features/conversations/conversations-shell.tsx` and
  tests - connect for the active identity and invalidate REST queries on live
  change/reset frames.
- `apps/control-plane/src/features/system/system-page.tsx` and tests - display
  connection state without exposing ticket data.
- relevant simulated handler and Playwright tests - preserve simulated mode and
  prove active-identity isolation.
- `docs/superpowers/specs/2026-08-27-communicator-cloudflare-data-plane-design.md`
  - the plan commit clarifies that externally visible resume positions are
  identity-local to avoid cross-identity activity leakage before implementation.

## Task 1: Freeze public and internal realtime contracts

**Files:**

- Modify: `packages/contracts/src/realtime.ts`
- Create: `packages/contracts/test/realtime.test.ts`
- Modify: `packages/contracts/test/schemas.test.ts`
- Modify: `packages/contracts/src/index.ts` only if the existing wildcard export
  is removed or insufficient
- Create: `apps/control-plane/worker/realtime/contracts.ts`
- Create: `apps/control-plane/worker/test/realtime/contracts.test.ts`

- [ ] **Step 1: Write strict failing contract tests.**

Test the exact request and frame examples from section 3. Add rejection cases
for duplicate subscription identities, an empty subscription list, more than 16
identities, unknown families, duplicate families, resume identities absent from
subscriptions, duplicate resume entries, negative/unsafe sequences, generation
zero, extra keys, malformed tickets, more than 100 changes in a frame, identity
IDs longer than 255 characters, and non-structured-clone-safe parsed results.

Add Worker tests for strict internal upgrade context and socket attachment
schemas. Prove that tenant, principal, membership, and identity IDs are bounded
to 255 characters; subscriptions remain capped at 16 identities; the JSON byte
size check rejects attachments above 12,000 bytes; the largest schema-valid
attachment remains below that limit; and no parser error contains the rejected
context or attachment value.

- [ ] **Step 2: Run RED.**

```bash
pnpm --filter @communicator/contracts test -- realtime.test.ts
pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/realtime/contracts.test.ts
```

Expected: fail because the new public exports and internal schemas do not exist.

- [ ] **Step 3: Implement the exact constants and schemas.**

Use these names and values:

```ts
export const REALTIME_SUBPROTOCOL = "communicator.realtime.v1";
export const REALTIME_TICKET_TTL_MS = 30_000;
export const REALTIME_CONNECTION_TTL_MS = 15 * 60_000;
export const MAX_REALTIME_IDENTITIES = 16;
export const MAX_REALTIME_CHANGES_PER_FRAME = 100;
export const MAX_REALTIME_REPLAY_CHANGES = 500;
export const MAX_REALTIME_SOCKETS_PER_TENANT = 256;
export const MAX_REALTIME_SOCKETS_PER_PRINCIPAL = 8;
export const MAX_REALTIME_ID_LENGTH = 255;
export const MAX_REALTIME_ATTACHMENT_JSON_BYTES = 12_000;
```

Create and export:

```ts
RealtimeEventFamilySchema             // literal "projection"
RealtimeSubscriptionSchema            // identity_id + unique families
RealtimeResumePositionSchema          // identity_id + generation + after_sequence
RealtimeTicketRequestSchema
RealtimeTicketResponseSchema
RealtimePositionSchema                // identity_id + generation + sequence
RealtimeProjectionChangeSchema        // no event_id or content-bearing fields
RealtimeConnectedFrameSchema
RealtimeProjectionChangesFrameSchema
RealtimeResetRequiredFrameSchema
RealtimeServerFrameSchema             // discriminated union on type
```

Use `.strict()` throughout. Implement one reusable `uniqueBy` super-refinement
inside this file; errors must not include raw ticket values. Use a dedicated
realtime identity ID schema derived from `CommunicatorIdSchema` with the
255-character bound in every public realtime position and subscription.

Create `worker/realtime/contracts.ts` with strict schemas and inferred types for
the server-generated internal upgrade context and serialized socket attachment.
It also owns safe parsers and a `TextEncoder` plus `JSON.stringify` byte-size
guard capped at `MAX_REALTIME_ATTACHMENT_JSON_BYTES`. These values contain only
bounded IDs, subscriptions, identity-local positions, issue/expiry timestamps,
and a resume flag. They never contain tickets, headers, message data, labels,
Matrix IDs, remote IDs, or arbitrary records. Task 4 constructs the internal
context; Task 5 converts it to and parses the socket attachment. Neither later
parallel task may modify this shared file.

- [ ] **Step 4: Run GREEN and the contract package.**

```bash
pnpm --filter @communicator/contracts test -- realtime.test.ts
pnpm --filter @communicator/contracts test
pnpm --filter @communicator/contracts check
pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/realtime/contracts.test.ts
```

- [ ] **Step 5: Parent verifies the diff and commits.**

```bash
git add packages/contracts/src/realtime.ts packages/contracts/test/realtime.test.ts packages/contracts/test/schemas.test.ts packages/contracts/src/index.ts apps/control-plane/worker/realtime/contracts.ts apps/control-plane/worker/test/realtime/contracts.test.ts
git commit -m "feat: define resumable realtime protocol"
```

## Task 2: Make projection change sequences identity-local

**Files:**

- Modify: `apps/control-plane/worker/projection/schema.ts`
- Modify: `apps/control-plane/worker/projection/tenant-projection.ts`
- Modify: `packages/contracts/src/projection.ts`
- Modify: `apps/control-plane/worker/test/projection/schema.test.ts`
- Modify: `apps/control-plane/worker/test/projection/queries.test.ts`
- Modify: `apps/control-plane/worker/test/projection/rebuild.test.ts`
- Modify: `apps/control-plane/worker/test/projection/projector-convergence-proof.test.ts`
- Modify: `packages/contracts/test/projection.test.ts`

- [ ] **Step 1: Write failing migration and query tests.**

Add tests proving:

1. migration history contains immutable version 1 followed by version 2 named
   `identity_local_projection_sequences` with fixed timestamp
   `2026-09-10T00:00:00.000Z`;
2. a version-1 database with interleaved Human and Agent rows migrates without
   changing global row order, event IDs, or projection data;
3. `identity_sequence` starts at 1 independently for Human and Agent;
4. `listChanges(identity_human)` exposes no gaps caused by Agent rows;
5. duplicate events do not advance either identity counter;
6. trimming updates each affected identity's local floor;
7. a request below one identity's floor returns `reset_required` without
   affecting another identity; and
8. rebuild clear/reset restarts local sequences only in the new generation.

- [ ] **Step 2: Run RED.**

```bash
pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/projection/schema.test.ts worker/test/projection/queries.test.ts
pnpm --filter @communicator/contracts test -- projection.test.ts
```

Expected: assertions fail because `identity_sequence` and its counter table do
not exist.

- [ ] **Step 3: Append migration 2; never edit migration 1.**

Migration 2 must transactionally:

1. create `projection_changes_v2` with all current columns plus
   `identity_sequence INTEGER NOT NULL CHECK(identity_sequence >= 1)`;
2. copy retained rows ordered by global `sequence`, assigning
   `ROW_NUMBER() OVER (PARTITION BY identity_id ORDER BY sequence)` plus an
   offset of 1 when that identity already has a floor row;
3. run `DROP INDEX IF EXISTS idx_projection_changes_identity_sequence` and
   `DROP INDEX IF EXISTS idx_projection_changes_global_sequence`, drop the old
   table, rename the v2 table, and recreate both
   `idx_projection_changes_identity_sequence` on
   `(identity_id, identity_sequence)` and
   `idx_projection_changes_global_sequence` on `(sequence)`;
4. convert every existing floor row to identity-local floor 1;
5. create `projection_identity_sequences(identity_id TEXT PRIMARY KEY,
   latest_sequence INTEGER NOT NULL CHECK(latest_sequence >= 0)) STRICT`;
6. seed counters with the maximum retained local sequence, or the converted
   floor when no retained row remains; and
7. insert the migration metadata row last.

This preserves retained pre-feature changes. Because no public realtime client
existed before this migration, no valid public cursor is invalidated.

- [ ] **Step 4: Update insert, list, trim, clear, and status logic.**

For each newly applied non-duplicate event, synchronously increment or insert
the event identity's counter, read the resulting value, and write it as
`identity_sequence` in the same storage turn. `listChanges()` filters and orders
on identity-local sequence. `latest_sequence` comes from the identity counter,
not tenant-global `MAX(sequence)`. Trim selection may remain global, but floor
updates use `MAX(identity_sequence)` per affected identity.

Do not add an `await` between related SQLite statements. Do not change canonical
event idempotency or projection generation behavior.

- [ ] **Step 5: Run GREEN and projection regression suites.**

```bash
pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/projection/schema.test.ts worker/test/projection/queries.test.ts worker/test/projection/rebuild.test.ts worker/test/projection/projector-convergence-proof.test.ts
pnpm --filter @communicator/contracts test
```

- [ ] **Step 6: Parent verifies no version-1 statement changed and commits.**

```bash
git add apps/control-plane/worker/projection/schema.ts apps/control-plane/worker/projection/tenant-projection.ts apps/control-plane/worker/test/projection/schema.test.ts apps/control-plane/worker/test/projection/queries.test.ts apps/control-plane/worker/test/projection/rebuild.test.ts apps/control-plane/worker/test/projection/projector-convergence-proof.test.ts packages/contracts/src/projection.ts packages/contracts/test/projection.test.ts
git commit -m "feat: isolate realtime change sequences by identity"
```

## Task 3: Add digest-only single-use ticket storage

**Files:**

- Create: `apps/control-plane/migrations/0004_realtime_tickets.sql`
- Create: `apps/control-plane/worker/realtime/token.ts`
- Create: `apps/control-plane/worker/realtime/ticket-repository.ts`
- Create: `apps/control-plane/worker/realtime/authorization.ts`
- Create: `apps/control-plane/worker/test/realtime/tickets.test.ts`
- Modify: `apps/control-plane/worker/test/control-directory-schema.test.ts`
- Modify: `tests/test_repository_contract.py`

- [ ] **Step 1: Write failing D1 and token tests.**

Cover exact 32-byte ticket generation, the `rt1_` 43-character base64url body,
stable SHA-256 digest, no raw token in D1, 30-second expiry, atomic single-use
under two concurrent consumers, expired cleanup, malformed stored JSON, wrong
tenant references, revoked membership, disabled identity, removed
`conversation.read`, and generic safe error serialization.

The concurrency test must assert exactly one consume call succeeds. It must not
accept two sequential calls as sufficient proof.

- [ ] **Step 2: Run RED.**

```bash
pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/realtime/tickets.test.ts worker/test/control-directory-schema.test.ts
python3 -m unittest tests.test_repository_contract -v
```

- [ ] **Step 3: Create migration 0004.**

Use this bounded structure:

```sql
CREATE TABLE realtime_tickets (
  ticket_digest TEXT PRIMARY KEY CHECK(length(ticket_digest) = 64),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  membership_id TEXT NOT NULL,
  subscriptions_json TEXT NOT NULL CHECK(json_valid(subscriptions_json)),
  resume_json TEXT NOT NULL CHECK(json_valid(resume_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= 0),
  FOREIGN KEY (tenant_id, membership_id)
    REFERENCES memberships(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX realtime_tickets_expiry_idx
  ON realtime_tickets(expires_at_ms, ticket_digest);
```

Never add a token, URL, bearer, Access assertion, provider credential, or message
field.

- [ ] **Step 4: Implement token and repository boundaries.**

Expose these dependency-injectable functions:

```ts
generateRealtimeTicket(randomValues?: (bytes: Uint8Array) => Uint8Array): string
digestRealtimeTicket(ticket: string): Promise<string>
issueRealtimeTicket(db, authorizedRequest, now): Promise<IssuedRealtimeTicket>
consumeRealtimeTicket(db, ticket, now): Promise<ConsumedRealtimeAuthorization | null>
```

Issue performs expiry cleanup and insert through a primary D1 session. Consume
uses one conditional `DELETE ... WHERE ticket_digest = ? AND expires_at_ms > ?
RETURNING ...` statement, then rechecks current directory rows and grants. Parse
both JSON columns with Task 1 schemas. Return `null` for every invalid,
expired, consumed, revoked, disabled, or no-longer-authorized case. Throw one
safe internal availability error for D1 corruption or service failure.

- [ ] **Step 5: Run GREEN.**

```bash
pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/realtime/tickets.test.ts worker/test/control-directory-schema.test.ts
python3 -m unittest tests.test_repository_contract -v
```

- [ ] **Step 6: Parent inspects the migration and commits.**

```bash
git add apps/control-plane/migrations/0004_realtime_tickets.sql apps/control-plane/worker/realtime/token.ts apps/control-plane/worker/realtime/ticket-repository.ts apps/control-plane/worker/realtime/authorization.ts apps/control-plane/worker/test/realtime/tickets.test.ts apps/control-plane/worker/test/control-directory-schema.test.ts tests/test_repository_contract.py
git commit -m "feat: add single-use realtime tickets"
```

## Task 4: Publish the authenticated ticket endpoint and upgrade boundary

**Files:**

- Create: `apps/control-plane/worker/realtime/handlers.ts`
- Create: `apps/control-plane/worker/routes/realtime.ts`
- Create: `apps/control-plane/worker/test/realtime/api.test.ts`
- Modify: `apps/control-plane/worker/app.ts`
- Modify: `apps/control-plane/worker/test/read/openapi.test.ts`

- [ ] **Step 1: Write failing HTTP tests.**

Test authenticated issue, no-store headers, correct `ws:`/`wss:` URL conversion,
bearer precedence, Access-backed same-origin issue, unauthorized identities,
missing scopes, duplicates, extra keys, malformed JSON, D1 failure, non-upgrade
GET, wrong subprotocol, missing/expired/reused ticket, tenant selection, and
Human/Agent isolation. Assert that all ticket failures are byte-identical and no
response/log contains a token digest, raw ticket, internal context, or DO name.

- [ ] **Step 2: Run RED.**

```bash
pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/realtime/api.test.ts worker/test/read/openapi.test.ts
```

- [ ] **Step 3: Implement ticket authorization and route.**

Create one product authorization middleware instance in `app.ts`. Mount it on
`/api/v1/session`, `/api/v1/realtime/tickets`, and the existing read paths before
registering their handlers. Do not mount it on `GET /api/v1/realtime`: that
upgrade accepts only the short-lived ticket and revalidates the stored grant.
`POST /api/v1/realtime/tickets` receives the resulting `authorization` context.
`authorizeRealtimeRequest()` finds every requested identity in
`session.identities`, requires `conversation.read`, and returns a server-owned
object containing tenant, principal, membership, normalized subscriptions, and
resume positions. Missing identity and missing scope use the same `404`.

Register the route with bearer OpenAPI security and bounded 400/401/404/503
responses. Return 201 with Task 1's response schema and no-store headers.
Register the upgrade with a plain `app.get("/api/v1/realtime", ...)` route. The
OpenAPI document intentionally contains only the authenticated ticket POST,
because the generated OpenAPI response model cannot describe the runtime 101
upgrade. Assert that the GET operation is absent from OpenAPI and document the
upgrade contract in the runbook.

- [ ] **Step 4: Implement the external upgrade handler.**

Validate method, `Upgrade`, exact subprotocol, the single `ticket` query key,
and ticket syntax before D1. Consume and revalidate the ticket. Construct a new
internal request to `https://tenant-projection.internal/realtime` containing
only the exact upgrade headers and one bounded server-generated internal context
header. Route using:

```ts
const stub = env.TENANT_PROJECTION.getByName(consumed.tenant_id);
return stub.fetch(internalRequest);
```

Never forward caller headers or the raw external URL. Remove the ticket before
calling the DO. Preserve the selected subprotocol in the 101 response.

- [ ] **Step 5: Run GREEN and the full HTTP read regression suite.**

```bash
pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/realtime/api.test.ts worker/test/read/openapi.test.ts worker/test/read/api.test.ts worker/test/session.test.ts
```

- [ ] **Step 6: Parent verifies route ordering and commits.**

```bash
git add apps/control-plane/worker/realtime/handlers.ts apps/control-plane/worker/routes/realtime.ts apps/control-plane/worker/test/realtime/api.test.ts apps/control-plane/worker/app.ts apps/control-plane/worker/test/read/openapi.test.ts
git commit -m "feat: publish realtime ticket boundary"
```

## Task 5: Add hibernatable sockets and bounded replay to the tenant DO

**Files:**

- Create: `apps/control-plane/worker/realtime/tenant-sockets.ts`
- Create: `apps/control-plane/worker/realtime/telemetry.ts`
- Create: `apps/control-plane/worker/test/realtime/socket.test.ts`
- Create: `apps/control-plane/worker/test/realtime/telemetry.test.ts`
- Modify: `apps/control-plane/worker/projection/tenant-projection.ts`
- Modify: `apps/control-plane/worker/index.ts` only if export shape changes

- [ ] **Step 1: Write failing socket lifecycle tests.**

Use the Workers runtime and real `WebSocketPair`. Cover:

- valid internal upgrade returns 101 and negotiated subprotocol;
- external-shaped or malformed internal context fails before acceptance;
- fresh connect receives `connected` positions without replay;
- same-generation resume receives retained changes in identity-local order;
- interleaved Agent changes never appear or create Human sequence gaps;
- generation mismatch, floor miss, and more than 500 replay rows each produce
  the exact reset frame and keep the socket usable;
- replay is chunked into frames of at most 100 changes;
- attachments survive `evictDurableObject(..., { webSockets: "hibernate" })`;
- `ping` receives `pong` after eviction without relying on class memory;
- other text and every binary message closes with 1008;
- the 257th tenant socket and ninth principal socket are rejected;
- a corrupt attachment closes only that socket;
- the earliest lease alarm closes expired sockets and reschedules for the next;
  and
- no frame contains event ID, body, preview, Matrix ID, remote ID, ticket, or
  internal context; and
- structured socket events report accepted, resumed, closed, lease-expired, and
  capacity-rejected outcomes with active counts and privacy-safe tenant and
  identity IDs, while rejecting or omitting message data and secret fields.

- [ ] **Step 2: Run RED.**

```bash
pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/realtime/socket.test.ts worker/test/realtime/telemetry.test.ts
```

- [ ] **Step 3: Implement stateless socket helpers.**

`tenant-sockets.ts` owns:

```ts
parseRealtimeAttachment(value)
readRealtimeReplay(sql, identityId, generation, afterSequence, limit)
batchRealtimeChanges(changes, 100)
sendRealtimeFrame(socket, frame)
countPrincipalSockets(sockets, principalId)
nextSocketExpiry(sockets)
```

Every helper returns schemas from Task 1 or internal strict schemas. Replay SQL
uses `(identity_id, identity_sequence)` and never reads message/content tables.
Return 501 rows internally to distinguish a valid 500-row replay from a reset.
Before `serializeAttachment`, apply Task 1's 12,000-byte JSON guard. Close or
reject only the affected socket if a restored attachment is invalid or exceeds
the bound.

`telemetry.ts` owns a closed set of structured socket event builders and one
injected logger. Emit one versioned JSON event per subscribed identity with
`tenant_id`, `identity_id`, outcome, active tenant socket count, resume flag,
and timestamp. Do not accept arbitrary labels. Tests must prove that raw ticket,
digest, internal context, bearer/Access token, message body, preview, Matrix ID,
and remote ID values can never enter an event. These structured events are the
pilot source for active/resumed connection and reconnect-demand metrics.

- [ ] **Step 4: Add the platform handlers to `TenantProjectionDO`.**

Implement:

```ts
async fetch(request: Request): Promise<Response>
webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void
webSocketClose(socket: WebSocket, code: number, reason: string, wasClean: boolean): void
webSocketError(socket: WebSocket, error: unknown): void
async alarm(): Promise<void>
```

The constructor calls:

```ts
this.ctx.setWebSocketAutoResponse(
  new WebSocketRequestResponsePair("ping", "pong"),
);
```

`fetch()` verifies the internal path/context and ready projection state before
creating a pair. It calls only `this.ctx.acceptWebSocket(server, ["realtime"])`,
serializes the full attachment, schedules the earliest lease alarm, sends the
connected/reset/replay frames, and returns the client endpoint. Do not call
`server.accept()` and do not add a socket map.

- [ ] **Step 5: Run GREEN and eviction regression tests.**

```bash
pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/realtime/contracts.test.ts worker/test/realtime/socket.test.ts worker/test/realtime/telemetry.test.ts worker/test/projection/schema.test.ts worker/test/projection/queries.test.ts
```

- [ ] **Step 6: Parent reviews all platform API calls against generated types and commits.**

```bash
git add apps/control-plane/worker/realtime/tenant-sockets.ts apps/control-plane/worker/realtime/telemetry.ts apps/control-plane/worker/test/realtime/socket.test.ts apps/control-plane/worker/test/realtime/telemetry.test.ts apps/control-plane/worker/projection/tenant-projection.ts apps/control-plane/worker/index.ts
git commit -m "feat: add hibernatable tenant subscriptions"
```

## Task 6: Broadcast persisted live changes and reset rebuild clients

**Files:**

- Modify: `apps/control-plane/worker/realtime/tenant-sockets.ts`
- Modify: `apps/control-plane/worker/projection/tenant-projection.ts`
- Modify: `apps/control-plane/worker/test/realtime/socket.test.ts`
- Modify: `apps/control-plane/worker/test/projection/rebuild.test.ts`
- Modify: `apps/control-plane/worker/test/ingestion/end-to-end.test.ts`

- [ ] **Step 1: Write failing persist-first broadcast tests.**

Prove:

1. one newly applied event broadcasts once to the matching identity socket;
2. a duplicate retry advances no sequence and broadcasts nothing;
3. a Human event reaches no Agent-only socket and vice versa;
4. a socket subscribed to no matching identity receives nothing;
5. a 201-event apply produces three frames sized 100, 100, and 1;
6. throwing `socket.send()` does not roll back projection state or make
   `applyBatch()` fail;
7. a reconnect after such a send failure replays the durable row;
8. `applyReplayPage()` during rebuild does not emit historical live frames; and
9. `beginRebuild()` sends a reset and closes current sockets with 1012.

Inspect SQLite inside `runInDurableObject` before accepting the broadcast as
proof of persist-first ordering.

- [ ] **Step 2: Run RED.**

```bash
pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/realtime/socket.test.ts worker/test/projection/rebuild.test.ts worker/test/ingestion/end-to-end.test.ts
```

- [ ] **Step 3: Implement post-persistence broadcasting.**

Collect only newly inserted change metadata during the existing synchronous
apply transaction. After all projection writes, summary recomputation, trim,
and checkpoint writes have completed, group those safe rows by socket attachment
and identity, then send Task 1 frames. Catch send/attachment errors per socket,
close that socket, and continue. Never include payloads or re-read message bodies.

On rebuild start, send `reset_required` with the next generation information
available from durable meta, close code 1012, and proceed with the existing
rebuild transaction. Replay-page methods never broadcast.

- [ ] **Step 4: Run GREEN and projection convergence.**

```bash
pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/realtime/socket.test.ts worker/test/projection/rebuild.test.ts worker/test/ingestion/end-to-end.test.ts worker/test/projection/projector-convergence-proof.test.ts
```

- [ ] **Step 5: Parent verifies duplicate/rebuild behavior and commits.**

```bash
git add apps/control-plane/worker/realtime/tenant-sockets.ts apps/control-plane/worker/projection/tenant-projection.ts apps/control-plane/worker/test/realtime/socket.test.ts apps/control-plane/worker/test/projection/rebuild.test.ts apps/control-plane/worker/test/ingestion/end-to-end.test.ts
git commit -m "feat: broadcast durable projection changes"
```

## Task 7: Implement the live browser realtime client

**Files:**

- Create: `apps/control-plane/src/lib/realtime/live-client.ts`
- Create: `apps/control-plane/src/lib/realtime/live-client.test.ts`
- Modify: `apps/control-plane/src/lib/realtime/client.ts`
- Modify: `apps/control-plane/src/lib/realtime/simulated-client.ts`
- Modify: `apps/control-plane/src/lib/realtime/runtime-client.ts`
- Modify: `apps/control-plane/src/lib/api/client.ts`
- Modify: `apps/control-plane/src/lib/api/client.test.ts`

- [ ] **Step 1: Write failing deterministic client tests.**

Inject a fake WebSocket constructor, clock, timer scheduler, and Storage object.
Test ticket POST shape, exact subprotocol, no bearer/ticket persistence, connected
resolution, valid frame delivery, malformed-frame rejection, sequence duplicate
suppression, identity-local resume storage, reset baseline replacement, close,
15-minute server lease reconnect, abnormal-close reconnect delays of 250, 500,
1000, 2000, then 5000 milliseconds, fresh ticket per attempt, timer cleanup, and
no reconnect after explicit close.

- [ ] **Step 2: Run RED.**

```bash
pnpm --filter @communicator/control-plane exec vitest run --config vitest.ui.config.ts src/lib/realtime/live-client.test.ts src/lib/api/client.test.ts
```

- [ ] **Step 3: Extend the shared client boundary.**

Use this public shape:

```ts
type RealtimeConnectOptions = {
  tenantId: string;
  principalId: string;
  identityIds: string[];
  families: ["projection"];
};

interface RealtimeClient {
  connect(options: RealtimeConnectOptions): Promise<void>;
  subscribe(listener: RealtimeListener): () => void;
  subscribeStatus(listener: RealtimeStatusListener): () => void;
  close(): void;
  reset(): void;
}
```

Statuses are `idle`, `connecting`, `connected`, and `reconnecting`. Do not expose
the ticket or URL through state/listeners.

- [ ] **Step 4: Implement ticket and socket lifecycle.**

`ApiClient.createRealtimeTicket()` validates Task 1's response schema. The live
client stores resume positions under a key containing tenant, principal, and
identity; it never stores tickets. It requests a new ticket for every socket,
uses the exact returned URL and subprotocol, validates every JSON frame, emits
only authorized requested identities, and suppresses sequences at or below the
stored position. Reset frames replace the relevant baseline before listeners
invalidate REST.

Use fixed bounded reconnect delays rather than random jitter so behavior is
testable. A successful connection resets the delay. Explicit `close()` cancels
all timers and closes the socket.

- [ ] **Step 5: Keep simulated mode behavior-compatible.**

Update `SimulatedRealtimeClient.connect(options)` to retain its current message
and command events while filtering to requested identities. It must not pretend
to create tickets or WebSockets. `runtime-client.ts` instantiates simulated mode
only for simulated builds and `LiveRealtimeClient` for live builds.

- [ ] **Step 6: Run GREEN and all UI unit tests.**

```bash
pnpm --filter @communicator/control-plane exec vitest run --config vitest.ui.config.ts src/lib/realtime/live-client.test.ts src/lib/api/client.test.ts src/lib/realtime src/mocks/handlers.test.ts
pnpm --filter @communicator/control-plane test:ui
```

- [ ] **Step 7: Parent checks browser storage isolation and commits.**

```bash
git add apps/control-plane/src/lib/realtime/live-client.ts apps/control-plane/src/lib/realtime/live-client.test.ts apps/control-plane/src/lib/realtime/client.ts apps/control-plane/src/lib/realtime/simulated-client.ts apps/control-plane/src/lib/realtime/runtime-client.ts apps/control-plane/src/lib/api/client.ts apps/control-plane/src/lib/api/client.test.ts
git commit -m "feat: add resumable live realtime client"
```

## Task 8: Connect the backoffice to authoritative realtime invalidation

**Files:**

- Modify: `apps/control-plane/src/features/conversations/conversations-shell.tsx`
- Modify: `apps/control-plane/src/features/conversations/conversations-shell.test.tsx`
- Modify: `apps/control-plane/src/features/conversations/apply-conversation-event.ts`
- Modify: `apps/control-plane/src/features/conversations/apply-conversation-event.test.ts`
- Modify: `apps/control-plane/src/features/system/system-page.tsx`
- Modify: relevant system-page test
- Modify: `apps/control-plane/e2e/live-read-api.spec.ts`
- Modify: `apps/control-plane/e2e/channel-conversations.spec.ts`

- [ ] **Step 1: Write failing UI and browser tests.**

Cover active-identity connect arguments, no connection without an identity,
cleanup on identity switch/unmount, Human notification isolation, projection
change invalidation of channels/all conversations/channel conversations/exact
conversation/messages, reset invalidation of every identity query, duplicate
sequence suppression, simulated direct cache update preservation, connection
status display, and no ticket/URL text in the UI.

- [ ] **Step 2: Run RED.**

```bash
pnpm --filter @communicator/control-plane exec vitest run --config vitest.ui.config.ts src/features/conversations/conversations-shell.test.tsx src/features/conversations/apply-conversation-event.test.ts src/features/system/system-page.test.tsx
```

- [ ] **Step 3: Wire one active-identity subscription.**

Connect with the authenticated session tenant/principal and active identity.
Keep the existing scoped direct update for simulated `message.created` events.
For a live `projection.changes` frame matching the current tenant and identity,
invalidate only:

```ts
queryKeys.channels(identityId)
queryKeys.conversations(identityId, undefined)
queryKeys.conversations(identityId, changedConnectionId)
queryKeys.conversation(identityId, changedConversationId)
queryKeys.messages(identityId, changedConversationId)
```

If connection or conversation IDs are unavailable, invalidate the bounded
identity-level prefixes instead. For `reset_required`, invalidate all queries
whose key contains that identity. Never update Agent caches while Human is
active.

- [ ] **Step 4: Run GREEN and browser scenarios.**

```bash
pnpm --filter @communicator/control-plane test:ui
pnpm --filter @communicator/control-plane exec playwright test e2e/live-read-api.spec.ts e2e/channel-conversations.spec.ts --workers=1
```

- [ ] **Step 5: Parent visually confirms the existing multi-panel layout is unchanged and commits.**

```bash
git add apps/control-plane/src/features/conversations/conversations-shell.tsx apps/control-plane/src/features/conversations/conversations-shell.test.tsx apps/control-plane/src/features/conversations/apply-conversation-event.ts apps/control-plane/src/features/conversations/apply-conversation-event.test.ts apps/control-plane/src/features/system/system-page.tsx apps/control-plane/e2e/live-read-api.spec.ts apps/control-plane/e2e/channel-conversations.spec.ts
git commit -m "feat: refresh backoffice from realtime changes"
```

## Task 9: Document operation and lock repository contracts

**Files:**

- Create: `docs/runbooks/realtime-websocket-local.md`
- Modify: `tests/test_repository_contract.py`
- Modify: `apps/control-plane/wrangler.jsonc` only if generated types require a
  compatibility adjustment supported by current docs
- Regenerate: `apps/control-plane/worker-configuration.d.ts`

- [ ] **Step 1: Write documentation/repository contract failures first.**

The Python contract must require the new migration, runbook, route, ticket
storage prohibition, Hibernation API calls, identity-local sequence wording, and
hostname-based Access warning. It must reject raw-ticket columns and standard
`server.accept()` use in the DO.

- [ ] **Step 2: Run RED.**

```bash
python3 -m unittest tests.test_repository_contract -v
```

- [ ] **Step 3: Write the runbook.**

Include exact local setup, D1 migration order, simulated versus live behavior,
ticket and upgrade examples using placeholders, subprotocol, all frame examples,
resume/reset client rules, hibernation and lease behavior, limits, generic
errors, safe diagnostics, no-secret logging, structured socket event names and
metric derivation, the intentional OpenAPI exclusion of the GET/101 upgrade,
Worker-level Access WebSocket limitation, hostname-based Access requirement, and
explicit statement that no production resource or credential was created in
this phase.

Never include a real domain, token, Access audience, account ID, D1 ID, or
ticket. Explain that the projection may remain empty until milestone 11 enables
live ingestion.

- [ ] **Step 4: Verify the approved system spec correction.**

Verify that the plan commit already states that the storage DO may retain its
internal tenant ordering while external resume positions are identity-local.
The Task 9 writer must not modify that decision or broaden the design spec.

- [ ] **Step 5: Regenerate and verify.**

```bash
pnpm --filter @communicator/control-plane types:worker
git diff --exit-code -- apps/control-plane/worker-configuration.d.ts
python3 -m unittest tests.test_repository_contract -v
pnpm --filter @communicator/control-plane check
git diff --check
```

If platform types change because production source now uses hibernation methods,
commit only deterministic Wrangler output. Do not hand-edit the generated file.

- [ ] **Step 6: Parent reviews documentation and commits.**

```bash
git add docs/runbooks/realtime-websocket-local.md tests/test_repository_contract.py apps/control-plane/wrangler.jsonc apps/control-plane/worker-configuration.d.ts
git commit -m "docs: add realtime WebSocket operations"
```

## Task 10: Full validation, independent review, PR, and merge

- [ ] **Step 1: Run affected gates in parallel through independent test workers.**

Worker A, contract and UI:

```bash
pnpm --filter @communicator/contracts test
pnpm --filter @communicator/control-plane test:ui
pnpm --filter @communicator/control-plane exec playwright test e2e/live-read-api.spec.ts e2e/channel-conversations.spec.ts --workers=1
```

Worker B, Worker runtime:

```bash
pnpm --filter @communicator/control-plane test:worker
```

Worker C, static and repository:

```bash
pnpm check
python3 -m unittest discover -s tests -v
pnpm --filter @communicator/control-plane types:worker
git diff --exit-code -- apps/control-plane/worker-configuration.d.ts
git diff --check origin/main...HEAD
git status --short
```

Do not run the 11-minute exact 256 MiB Rust boundary test because this phase
changes no Rust or archive-size logic. Retain the passing evidence from PR #13.
If any Rust file changes unexpectedly, stop and run the full Rust gate including
that boundary test.

- [ ] **Step 2: Use two disjoint read-only Luna reviewers.**

Reviewer A checks ticket entropy/digest storage, atomic single use, expiry,
current-grant revalidation, route ordering, tenant routing, safe errors,
redaction, and Access/WebSocket topology.

Reviewer B checks identity-local migration correctness, replay/floor/generation
semantics, persist-before-broadcast, duplicate behavior, Hibernation API usage,
attachments after eviction, socket capacity/expiry, browser cache isolation, and
simulated/live parity.

Each reviewer receives an explicit file list and returns exactly `PASS` or a
P1/P2 finding with `file:line` evidence. Stop a reviewer after 10 minutes if it
has no usable result and relaunch with a smaller file set.

- [ ] **Step 3: Correct all confirmed P1/P2 findings once.**

Use one bounded writer only when findings touch the same files. Otherwise use
parallel isolated fix worktrees and cherry-pick non-overlapping commits. Require
RED to GREEN proof for every behavior fix. Parent verifies the combined diff,
runs only affected focused suites, then runs one final complete phase gate.

- [ ] **Step 4: Audit every acceptance item below.**

Treat missing or indirect evidence as incomplete. Confirm the current branch,
not a worker report alone.

- [ ] **Step 5: Push and create the PR.**

```bash
git push -u origin codex/realtime-websocket
gh pr create --base main --head codex/realtime-websocket \
  --title "feat: add resumable realtime WebSockets"
```

- [ ] **Step 6: Merge only after the PR is mergeable and required checks pass.**

If GitHub has no configured checks, record that fact and use the local full gate
plus both independent reviews. Do not merge with unresolved P1/P2 findings.

- [ ] **Step 7: Perform a short conflict-free post-merge proof.**

After a conflict-free merge, do not repeat the whole suite. Verify:

```bash
git pull --ff-only
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/realtime/api.test.ts worker/test/realtime/socket.test.ts
pnpm --filter @communicator/control-plane exec vitest run --config vitest.ui.config.ts src/lib/realtime/live-client.test.ts src/features/conversations/conversations-shell.test.tsx
git diff --check
git status --short --branch
```

If the merge required conflict resolution, rerun the complete phase gate instead.

## 8. Phase acceptance checklist

### Ticket and authentication

- [ ] Authenticated HTTPS issues a 30-second one-time opaque ticket.
- [ ] D1 stores only a 64-character SHA-256 digest and bounded authorization.
- [ ] Exactly one concurrent consumer can use a ticket.
- [ ] Consume rechecks active membership, identity status, and
  `conversation.read`.
- [ ] Every invalid ticket state is indistinguishable and cache-disabled.
- [ ] Long-lived bearer and Access credentials never enter the WebSocket URL.

### Tenant and identity isolation

- [ ] DO routing uses only the consumed ticket tenant.
- [ ] Subscriptions contain only identities granted to the current principal.
- [ ] Human frames contain no Agent data or sequence gaps caused by Agent data.
- [ ] Public positions are identity-local and generation-bound.
- [ ] Public and internal IDs are bounded; socket attachments pass the 12,000-byte
  JSON guard and contain no content or credentials.

### Hibernation, replay, and failure recovery

- [ ] The DO uses `acceptWebSocket`, attachments, handlers, and auto-response;
  it has no in-memory connection map.
- [ ] Connections and authorization survive hibernation eviction.
- [ ] Same-generation reconnect replays retained changes in order.
- [ ] Generation change, retention floor, and replay overflow require REST reset.
- [ ] Projection writes commit before broadcast; send failure never loses data.
- [ ] Duplicate ingestion never creates a duplicate stored change or broadcast.
- [ ] Rebuild does not stream archive history as live traffic.
- [ ] Socket count, frame size, replay count, inbound frames, and lease lifetime
  are bounded.
- [ ] Versioned structured events expose accepted, resumed, closed, expired, and
  capacity-rejected socket outcomes with active counts and privacy-safe tenant
  and identity IDs, without content or credential fields.

### Browser and protocol

- [ ] Live mode requests a fresh ticket and opens the exact v1 subprotocol.
- [ ] OpenAPI documents the authenticated ticket POST and intentionally excludes
  the raw GET/101 upgrade, which the runbook documents instead.
- [ ] Resume state is partitioned by tenant, principal, and identity.
- [ ] Tickets are never stored, rendered, or logged.
- [ ] Projection frames invalidate authoritative REST queries.
- [ ] Reset frames replace baselines and invalidate the full identity cache.
- [ ] Identity switches close/re-scope realtime without cross-cache updates.
- [ ] Simulated realtime and the existing multi-panel UI still work.

### Verification and integration

- [ ] Focused RED-to-GREEN evidence exists for Tasks 1 through 9.
- [ ] Contract, Worker, UI, browser, Python, and static suites pass.
- [ ] Generated Worker types and the full branch diff are clean.
- [ ] Both independent reviewers return `PASS` after fixes.
- [ ] The runbook documents hostname-based Cloudflare Access for WebSockets.
- [ ] PR is merged, local main equals `origin/main`, short post-merge tests pass,
  and the main worktree is clean.

## 9. Next phase after merge

Milestone 11 connects the persistent Matrix E2EE adapter to normalization, the
encrypted local upload outbox, and authenticated ingestion. It must use the
realtime behavior built here without changing the public ticket, position, or
frame contracts.
