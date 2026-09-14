# Pre-spec research brief

**Status: research synthesis completed 2026-09-13.** This is a research handoff,
not an architecture specification or implementation plan. Building and
specification work have not started. The cited literature and local evidence are
reviewed; pinned-binary/live-phone proof and the remaining product choices are
still unresolved. Proposed approaches and decision prompts are inputs for later
product/spec review; they do not settle those choices.

The product boundary is already agreed and is not reopened here: one authenticated
API and one remote MCP surface share messaging operations and grants; only the
administrator UI expands grants; access is scoped per connected account and to all
current/future or selected chats; WhatsApp comes first; ChatGPT Work is the first
proof client followed by supported Grok surfaces; real messages remain paused. The
same applies to save-before-dispatch, the four-hour outgoing confirmation window,
multiple independent webhooks, 24-hour webhook retry, stable event IDs, and
revocation blocking reads, dispatch, queued sends, and deliveries. See
[product alignment](../product-alignment.md) and the [gap assessment](2026-09-13-built-vs-agreed-scope.md).

Research inputs:
[agent auth](2026-09-13-agent-auth-research.md),
[delivery model](2026-09-13-delivery-model-research.md),
[WhatsApp capability](2026-09-13-whatsapp-capability-research.md), and
[retention](2026-09-13-retention-research.md).

## 1. Shared client authentication and agent identity

**Factual finding.** The repository verifies OIDC issuer, subject, optional token
ID (`jti`), directory membership, and revocation, but remote MCP and account/chat
grants are absent. OpenAI’s plugin flow uses OAuth authorization code plus PKCE
and resource-bound bearer tokens. The reviewed MCP version requires
audience/resource validation. xAI says Grok Bot has no identity of its own and
acts as the signed-in member, so multiple Bots can share a connector grant. See the
[auth research](2026-09-13-agent-auth-research.md) and its [OpenAI](https://developers.openai.com/plugins/build/auth),
[MCP](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization),
and [xAI security](https://docs.x.ai/grok-bot/security) sources.

**Proposed approach.** Treat an OAuth installation as the transport identity,
retain a separate logical named-agent record, and enforce OAuth scope intersected
with administrator-granted account/chat permissions through one API/MCP resolver.
Keep the identity-provider choice open.

**Decision needed — USER DECISION REQUIRED.** The shared-Grok fact requires a
choice between connection-wide grants/subscription ownership and separate users
or connections for per-agent isolation. Also choose one canonical API/MCP
resource or separate resources, and the OAuth authorization-server host.

## 2. Durable outgoing delivery and provider reconciliation

**Factual finding.** Save-before-dispatch is not implemented: canonical command
and delivery events are projections, not an outbound store. Matrix supplies a
stable transaction ID and event ID for reconciliation, but that does not prove
WhatsApp delivery. The [delivery research](2026-09-13-delivery-model-research.md)
identifies saved, waiting, confirmation-required, dispatching, uncertain,
confirmed, failed, and cancelled states.

The four-hour confirmation window, cancellation before dispatch, no blind resend
after uncertainty, and per-chat pause are already agreed requirements. They are
not open questions in this brief. The research leaves their durable transitions
and recovery behavior to the future specification while separating Matrix
acceptance from downstream bridge or WhatsApp outcome.

**Proposed approach.** Commit the outgoing message, command, and durable outbox
row atomically in the tenant Durable Object. Dispatch outside that transaction
under a compare-and-set lease and final authorization check. Keep one Matrix
transaction ID, reconcile remote echo or bridge status, pause uncertain chats,
and never blind-resend under a new provider transaction ID. Use alarms or a
sweeper for deadlines and stale leases; separate Matrix acceptance from bridge
delivery.

**Decision needed.** Define what bridge or provider evidence is sufficient
for `confirmed`, and the idempotency/outcome contract for group creation. The
four-hour confirmation and pause requirements are already agreed; this research
does not reopen them. These remaining choices are product/provider decisions, not
implied by the state model.

## 3. Independent webhook subscriptions

**Factual finding.** Multiple subscriptions with at-least-once delivery,
per-subscription status, and retries up to 24 hours are agreed, but no webhook
model exists. One control outbox marker cannot represent independent destinations,
versions, and retry ages.

**Proposed approach.** Store subscription definitions separately from event
deliveries. Fan out eligible incoming messages in the authoritative transaction,
use `(subscription_id, event_id)` uniqueness, retain stable receiver IDs across
retries, version destinations, and cancel old rows on cutover or revocation.
Recheck grants, destination version, and tombstones before each HTTP call; never
replay backlog after a destination change.

**Decision needed.** Resolve shared-client ownership, choose save-time
snapshots or current-at-delivery content for edits, and choose UI treatment of an
in-flight result unknown after revocation or cutover.

## 4. WhatsApp capabilities and client proof

**Factual finding.** The pinned bridge is mautrix-whatsapp v26.08, but its image
digest is not independently mapped to the upstream release commit. Upstream
describes a one-time history blob, defaulting to about three months and optionally
requesting about one year; phone/session size and provider limits constrain it.
This is not proof of unlimited or arbitrary history. Initial history/backfill are
disabled locally, and no linked-phone test proves live import, media, contacts,
groups, or receipts. Current Element-fork source does not prove the pinned
binary. Direct/public bridge media paths are disabled; authenticated Matrix media
and E2EE handling are separate. See the [WhatsApp capability
research](2026-09-13-whatsapp-capability-research.md) for pin-validation limits.

**Proposed approach.** Gate each capability on the pinned image and a sacrificial
linked phone, preserve connected-account routing, and report gaps rather than
claiming complete history. Keep external clients behind the Communicator backend
adapter; do not give them Matrix credentials. Validate Matrix media/E2EE and
client wake-up separately from webhook delivery.

**Verification gate, not a new product decision.** Verify the agreed WhatsApp
capability claims and Grok/ChatGPT surfaces against the pinned deployment. The
history, media, group, and receipt limits are documented blockers or material
tradeoffs if proof fails; record that evidence before revising an existing promise.
This is not permission to run real messages while implementation is paused.

## 5. Retention, deletion, and source-of-truth boundaries

**Factual finding.** The repository has archive-first ingestion, a Durable Object
projection, and tombstone/redaction seams, but physical purge and restore
reapplication are unresolved. The agreed requirement is prompt active removal;
controlled recoverable copies, including backups, have a 30-day ceiling. R2
preserves immutable bytes; DO point-in-time recovery, Synapse, bridge databases,
media, and restic have separate retention behavior. R2 lifecycle deletion is
asynchronous, and the queue's 14-day retention does not bound other copies. The
[retention research](2026-09-13-retention-research.md) records the evidence.

**Proposed approach.** Keep source, projection, media, bridge state, and backups
explicit, with an external removal ledger applied before restored access. The
ledger is necessary but not sufficient for physical purge: preserving unrelated
records in a mixed R2 batch may require archive segmentation or rewriting, plus
per-store purge jobs. File authorization and webhook hydration must honor
tombstones; active-view redaction alone cannot satisfy the retention policy.

**Decision needed.** Choose the source-of-truth/rebuild contract, backup
window within 30 days, and the physical-purge strategy across R2, Synapse, DOs,
media, bridge databases, and backups. No current seam proves a hard 30-day
physical-erasure guarantee.

The outcome is a bounded research route toward a future specification. Shared
client ownership, provider proof, delivery confirmation, and retention semantics
remain explicit decision or verification gates. This brief is not architecture
binding.
