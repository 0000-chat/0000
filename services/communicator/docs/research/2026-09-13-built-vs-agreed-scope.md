# Built versus agreed scope

Assessment date: 2026-09-13. Baseline: `codex/migration-communicator` at
`0a9455d`, with the pre-existing dirty alignment documents
[`CONTEXT.md`](../../CONTEXT.md#L1),
[`product-alignment.md`](../product-alignment.md#L1), and
[`ADR-0001`](../adr/0001-shared-api-mcp-boundary.md#L1).

This is a read-only gap assessment. “Implemented (static; tests identified)” means that
the contract, code path, or test exists in the tree; it does not mean that the
path was freshly run or verified against a live binding. “Partial” means that a
useful boundary exists but the agreed behavior is incomplete. “Simulated” means
the browser, MSW handlers, or fixtures demonstrate a shape without a live
provider action. “Missing” means no current product path was found. “Conflict”
means a current bound or setting contradicts the agreed behavior.

## Outcome

Communicator has a credible receive-side data foundation. The repository
describes Synapse as the operational record, R2 as the immutable replay archive,
and one SQLite Durable Object per tenant as a rebuildable projection
([`README.md`](../../README.md#L3)). The private ingestion route commits a
canonical batch to R2, queues a pointer, and the consumer applies the verified
batch to the tenant projection ([`ingestion/route.ts`](../../apps/control-plane/worker/ingestion/route.ts#L29),
[`ingestion/consumer.ts`](../../apps/control-plane/worker/ingestion/consumer.ts#L460)).
The authenticated Worker exposes session, identity, connection, conversation,
message, and realtime-ticket reads ([`app.ts`](../../apps/control-plane/worker/app.ts#L116));
the read API has focused contract tests ([`openapi.test.ts`](../../apps/control-plane/worker/test/read/openapi.test.ts#L39)).

That foundation is materially narrower than the agreed product. There is no
live outbound command route, no remote MCP interface, no contact or
conversation-creation API, no search API, no authenticated file API, no
webhook subscription model, and no administrator permission UI. The visible
send flow is explicitly simulated: the browser client calls a POST path
([`client.ts`](../../apps/control-plane/src/lib/api/client.ts#L149)), but the
live Worker registers no command route ([`app.ts`](../../apps/control-plane/worker/app.ts#L135));
MSW fabricates `202 Accepted` commands ([`handlers.ts`](../../apps/control-plane/src/mocks/handlers.ts#L177)).
The UI labels its data mode “SIMULATED DATA — no provider actions are
performed” ([`environment-banner.tsx`](../../apps/control-plane/src/components/layout/environment-banner.tsx#L3)).

The assessment recommends reusing and extending useful existing boundaries.
R2 archive-first ingestion, canonical events, tenant projection, directory
authorization, and the Matrix room/account binding are useful seams pending the
open source-of-truth and retention decisions. The current Matrix gateway is
receive-only: its transport fetches sync and handles Matrix crypto, while its crypto outbox is for SDK key requests
([`matrix.rs`](../../services/matrix-gateway/src/matrix.rs#L573),
[`crypto_outbox.rs`](../../services/matrix-gateway/src/crypto_outbox.rs#L16)).
It does not submit user messages to a provider. Product-stored reads, replay
projection state, and saved outgoing command state are distinct concerns that
still need an explicit boundary; the current projection cannot by itself be
treated as a finished outbound command store.

## Q1–Q49 coverage

The classifications below cover every agreed question. The scope authority is
the current product-alignment document; the older WhatsApp boundary report at
`/tmp/communicator-provider-research/docs/research/whatsapp-provider-boundaries.md`
(ref `fdac312`) is preserved code research and does not override that scope.

### Purpose, clients, and shared access boundary

- **Q1, Q2, Q7 — Documented; implementation missing.** The agent-first,
  own-conversations purpose and unified-inbox shape are settled in the alignment
  record ([`product-alignment.md`](../product-alignment.md#L18)). Current UI
  work is an administration/debugging shell, while client data is simulated.
- **Q10, Q13, Q39 — Planning only.** ChatGPT Work first, then supported Grok
  surfaces, is an accepted proof sequence ([`product-alignment.md`](../product-alignment.md#L56),
  [`product-alignment.md`](../product-alignment.md#L174)); no client setup,
  MCP connection, wake-up behavior, or live event receiver is present.
- **Q16 — Partial.** The authenticated API/read boundary and OIDC verifier
  exist, but the accepted shared remote MCP surface is absent. ADR-0001 records
  the intended API/MCP relationship ([`0001-shared-api-mcp-boundary.md`](../adr/0001-shared-api-mcp-boundary.md#L1));
  the OpenAPI document currently lists read and realtime paths only
  ([`openapi.test.ts`](../../apps/control-plane/worker/test/read/openapi.test.ts#L39)).
- **Q11, Q36, Q38, Q42 — Partial.** Identity grants, roles, revocation
  records, and audit/outbox tables provide a static authority foundation
  ([`authorization.ts`](../../packages/contracts/src/authorization.ts#L5),
  [`0001_control_directory.sql`](../../apps/control-plane/migrations/0001_control_directory.sql#L49)).
  Grants are identity/operation scoped; they do not yet select connected
  accounts or chats. There is no administrator UI that grants permissions, no
  agent request/inspection flow, and no live send/webhook queue on which
  revocation can operate. Realtime tickets recheck read grants, but they are
  WebSocket subscriptions, not product webhook authorization
  ([`realtime/authorization.ts`](../../apps/control-plane/worker/realtime/authorization.ts#L57)).

### Read, send, history, and message state

- **Q3 — Partial / simulated.** Stored conversation and message reads are
  implemented through the authenticated projection API
  ([`read/handlers.ts`](../../apps/control-plane/worker/read/handlers.ts#L230)).
  Sending is only a browser/MSW simulation; no live command endpoint or
  dispatch exists.
- **Q4 — Partial.** Archive-first R2 commit and DO projection are present in
  the tree, with ingestion/projection tests identified. The required
  “save outgoing message before bridge dispatch” lifecycle is missing because
  the live command path is missing. The R2/rebuild path is a useful candidate
  for preservation while source-of-truth and retention decisions remain open;
  it does not implement saved outgoing command state.
- **Q15 — Implemented (static; tests identified).** Conversations retain provider and
  connection ownership; projection queries keep separate conversation IDs and
  do not merge chats ([`schema.ts`](../../apps/control-plane/worker/projection/schema.ts#L67)).
- **Q18, Q24 — Partial, with a current provider conflict.** Canonical events
  distinguish live and backfill sources, and projection rebuild/checkpoint
  machinery exists. The WhatsApp renderer currently sets history sync and
  backfill limits to zero and disables both features
  ([`render-whatsapp-config.py`](../../scripts/render-whatsapp-config.py#L62));
  validation enforces the disabled state ([`validate-whatsapp.sh`](../../scripts/validate-whatsapp.sh#L37)).
  No provider import progress, known-gap reporting, or recent-while-importing
  behavior is wired.
- **Q19 — Partial.** Canonical message events carry bounded bodies and
  attachment metadata ([`canonical-event.ts`](../../packages/contracts/src/canonical-event.ts#L173));
  the projection stores attachment filename, MIME, size, hash, and optional R2
  key ([`schema.ts`](../../apps/control-plane/worker/projection/schema.ts#L194)).
  There is no authenticated file API, provider media proof, or transcription
  path. Text sending remains absent.
- **Q20, Q21, Q22, Q23, Q25, Q26, Q27 — Missing.** No contact search,
  stable recipient-selection API, explicit phone send, new conversation,
  group creation, group rename, participant management, creator auto-grant,
  webhook inheritance for new groups, or corresponding
  contact/create/manage-group permissions exist. The current operation scope
  enum has no such operations ([`authorization.ts`](../../packages/contracts/src/authorization.ts#L7)).
- **Q28 — Missing.** Read routes provide seek-paginated conversations and
  messages, but no text/contact/date/direction search route or contract
  ([`read.ts`](../../apps/control-plane/worker/routes/read.ts#L79)).
- **Q29 — Partial.** Stored reads do not call a provider, and the projection
  has receipt records and a `receipt.send` scope. An explicit mark-read command
  and provider action are absent.
- **Q30 — Partial (static; tests identified for edits and deletion markers).** Edits
  update the current projected body and versions; deletion events redact body,
  sender, reactions, receipts, and attachment metadata while retaining tombstone records
  ([`projector-messages.ts`](../../apps/control-plane/worker/projection/projector-messages.ts#L296),
  [`projector-deletion.ts`](../../apps/control-plane/worker/projection/projector-deletion.ts#L286)).
  Public reads return a deleted sender, empty body, and zero attachments
  ([`tenant-projection.ts`](../../apps/control-plane/worker/projection/tenant-projection.ts#L740)).
  Expiry is not scheduled or independently verified, so the full
  edit/deletion/expiry promise is incomplete.
- **Q31, Q34 — Partial and unresolved.** Active projection redaction and
  restore-safe tombstones are statically exercised, but the immutable archive
  still contains replay originals. The archive runbook explicitly excludes
  deletion/erasure and defers retention, object locks, and cleanup
  ([`r2-archive-local.md`](../runbooks/r2-archive-local.md#L321)). No expiry
  scheduler, physical purge, 30-day backup policy, or restore reapplication
  across all stores was verified.
- **Separate four-hour outgoing-confirmation window — Missing.** The agreed
  scope summary records a four-hour outgoing confirmation window
  ([`product-alignment.md`](../product-alignment.md#L12)), but no
  runtime state or timer implements it. Q35 itself is webhook failure timing
  and is classified in the webhook section below.
- **Q40 — Partial.** Projection bindings persist account and connection IDs
  ([`schema.ts`](../../apps/control-plane/worker/projection/schema.ts#L36)),
  but reads do not expose an explicit connected-account selector and no new
  conversation/group command resolves one. Silent-failover prevention is not
  implemented.

### Accounts and provider boundary

- **Q37 — Partial, with a bound that conflicts with the product wording.** D1
  stores one immutable account binding per connection
  ([`0002_ingestion_routing.sql`](../../apps/control-plane/migrations/0002_ingestion_routing.sql#L18)),
  and fixtures model multiple providers. The product has no hard account cap,
  while the current read-directory guard rejects more than 64 identity
  connections ([`read-repository.ts`](../../apps/control-plane/worker/control-directory/read-repository.ts#L122),
  [`projection.ts`](../../packages/contracts/src/projection.ts#L28)); this is an
  implementation limit that must not become the product promise.
- The gateway’s protected room binding preserves tenant, identity, connection,
  account, provider, and conversation ownership
  ([`registry.rs`](../../services/matrix-gateway/src/registry.rs#L31)). This is
  a good boundary to reuse. The pinned WhatsApp, Messenger, and Telegram
  Compose services are deployment seams, not provider adapters or live proof
  ([`compose.yaml`](../../compose.yaml#L35)); no live provider invocation was
  run.

### Webhook subscriptions

- **Q5, Q6, Q8, Q9, Q12, Q14, Q17, Q32, Q33, Q35, Q41, Q43, Q44, Q46,
  Q47, Q48, Q49 — Missing.** No webhook table, API/MCP operation, destination
  hierarchy, subscription ownership, event filter, authenticated attachment
  file route, delivery outbox, 24-hour retry window, visible failure state,
  authorized retry, independent subscription cutover, revocation cancellation,
  or edit/removal event fan-out exists. `realtime_tickets` stores WebSocket
  ticket subscriptions ([`0004_realtime_tickets.sql`](../../apps/control-plane/migrations/0004_realtime_tickets.sql#L1));
  it is not a webhook implementation. The agreed behavior is explicit:
  multiple independent subscriptions, global/account/chat inheritance, stable
  event IDs, and independent retries ([`product-alignment.md`](../product-alignment.md#L202)).

### Administrator UI

- **Q45 — Simulated/partial.** Connections, conversation reads, activity, and
  system views exist, but the connections page says account pairing is
  unavailable and its controls are disabled ([`connections-page.tsx`](../../apps/control-plane/src/features/connections/connections-page.tsx#L19),
  [`connection-card.tsx`](../../apps/control-plane/src/features/connections/connection-card.tsx#L60)).
  The required sync progress, agent grant management, queued sends, webhook
  settings/failures, and action-log presentation are absent from the product
  UI. Directory mutation and audit tables are reusable backend foundations,
  not an administrator workflow.

## Preservation and verification boundary

The migration handoff records a complete source bundle with 120 matching
preservation refs and a verified SHA-256 ([`migration handoff`](../migration/2026-09-12-communicator-migration.md#L35)).
The root workspace started at `0a9455d` with the pre-existing alignment
documents and ADR uncommitted; this report is the new research artifact. The
separate health worktree is at `bac77da` and has final
dirty edits to `services/matrix-gateway/src/health.rs` and
`services/matrix-gateway/tests/healthcheck.rs`; the last 19 health checks were
historical passes, not a verification of that final dirty state. The handoff
and its preserved patch/archive are authoritative for the original migration
only; they do not capture later health-worktree commits or dirty edits. That
additional health state remains preserved in its worktree and is untouched
([`migration handoff`](../migration/2026-09-12-communicator-migration.md#L112)).
The provider research worktree is `fdac312`.

The parent freshly ran `./scripts/check` successfully. That check covers
metadata, tracked-file policy, README identity, and diff hygiene; it does not
execute application tests. No full build, application test suite, deployment,
live Cloudflare call, Matrix call, or live provider proof was run for this
assessment. No application code, existing dirty document, commit, GitHub issue,
or external system was changed.

## Decisions and research to settle before a specification

1. Translate the already-agreed outbound rules into an implementable state
   model: accepted/saved, waiting for a connection, delivery uncertain,
   confirmed, and failed. The four-hour rule requires user confirmation after
   four hours, an immutable record of that reply and age, no blind resend when
   delivery is uncertain, and cancellation before dispatch when requested.
   Reuse the canonical `command.updated` and `bridge.delivery.updated` event
   families and the Matrix account binding; the account target and confirmation
   transitions still need a concrete authenticated command contract and durable
   outbox.
2. Define webhook ownership and delivery semantics as a first-class model:
   subscription identity, global/account/chat overrides, incoming-only event
   selection, stable event IDs, independent retry state, destination cutover,
   revocation, and attachment-file authorization. This is a separate boundary
   from realtime sockets and ingestion retries.
3. Select the credential and agent-consumer model for the shared API/MCP
   surface, then extend grants from identity operations to connected accounts
   and selected/all current-and-future chats. Verify ChatGPT Work and the
   supported Grok surfaces before promising client wake-up behavior.
4. Verify WhatsApp capabilities and limits with controlled provider research:
   history import, media retrieval, contacts, new chats, groups, account count,
   and provider delivery uncertainty. The existing renderer’s disabled history
   and backfill settings are a current conflict with the accepted pilot
   behavior.
5. Decide deletion and retention across Synapse, R2, Durable Objects, media,
   bridge databases, and backups. The current projection redaction is reusable,
   but archive purge and restore reapplication remain open privacy work.

The recommended direction is to reuse the archive, canonical event, projection,
directory, and provider deployment seams; extend them with explicit product
boundaries for outbound commands, account/chat grants, search, media access,
groups, and webhooks; and replace the simulated browser transport only when the
live API contracts are selected. A rewrite would discard the strongest tested
assets, while treating the current mock command path or DO projection as the
finished product would overstate what is built.
