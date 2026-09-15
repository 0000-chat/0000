# Communicator agent messaging specification

## Problem Statement

ChatGPT Work and Grok need a direct way to read and communicate within the
user's own messaging accounts; computer-use workflows are slow, fragile, and
inefficient for this job. Communicator is intended to provide that agent-first
boundary. The current product has a credible receive-side archive and
projection, but the agent-facing boundary is incomplete: outbound messages are
not durably saved before dispatch, account and chat grants are not fully
enforced, contact and group operations are absent, and webhook delivery does
not yet have an independent subscription model. The administrator UI is also a
partial shell rather than the authority workflow required by the product.

The product boundary is settled: WhatsApp is first; later providers must fit
the same provider-neutral boundary; ChatGPT Work is the first proof client,
followed by supported Grok web, mobile, and Bot surfaces. Communicator reads
stored messages and saves outgoing messages before bridge dispatch. A saved
outgoing message is an outgoing message, not evidence of provider delivery.
Multiple webhook subscriptions, account and chat inheritance, stable event and
delivery identifiers, and a 24-hour retry window are required. Implementation
and live client testing remain paused by instruction while technical proof and
implementation decisions are completed.

This specification turns that scope into a coherent implementation target. It
also records proposals where the research left a mechanism open. Those
proposals are designed to preserve authorization, reconciliation, and recovery
properties; they are not claims that every implementation detail was settled
in the alignment discussion.

## Solution

Expose one authenticated messaging service through two transports: a normal
API and a remote MCP interface. Both call the same authorization resolver and
the same high-level application services, so a client cannot gain a different
permission set by changing transports. The administrator UI is the only place
that grants or expands an agent's account and chat permissions. Agents may
inspect or request permissions, but cannot grant themselves access or grant it
to another agent.

Model every connected messaging account explicitly. A chat, contact, message,
outgoing command, permission, and provider operation retain their owning
account. Replies use the chat's account. Starting a conversation or creating a
group names a connected account explicitly and never silently fails over to a
different account. The pilot should exercise two or three WhatsApp accounts;
the product has no hard account cap, and infrastructure limits must be exposed
as capacity rather than made into a product promise.

Account linking is an administrator workflow separate from OAuth agent
transport. For WhatsApp, the administrator UI starts a provider pairing
attempt, displays a short-lived QR challenge, and reports expiry, refresh,
cancellation, and provider failure. The backend verifies the provider account
identity after pairing and detects an already linked identity before creating
an account. Pairing secrets go only to the authorized administrator UI and do
not enter logs, agent responses, or message records. A newly linked account
receives no agent grant automatically. Relinking the same identity preserves
the connected-account ID, stored history, chats, grants, and immutable send
route. A different identity creates a new account that needs new grants.
Disconnect is explicit, revokes the active pairing, and preserves stored
history. A provider-neutral linking interface permits other providers to use
different authorization methods. A controlled provider mock proves this
lifecycle; live WhatsApp support requires evidence from the pinned bridge API.

Read operations use Communicator's Durable Object-backed message view. History imports reach
as far as the provider makes available, with recent messages usable while older
history imports in the background. Import progress and known gaps are visible.
Text, images, documents, and voice notes are readable; text is the initial
outbound content type, and the connected agent is responsible for transcription
or interpretation. Search supports text, contact, chat, date, and direction
filters and returns stable IDs for later context retrieval. Reading stored
messages does not mark them read with the provider. A separate explicit action
does that when the provider supports it.

Every outbound request first commits a durable outgoing message, command, and
dispatch record. A command can wait for its explicit connection, require user
confirmation after four hours, be dispatching under a reclaimable lease, become
delivery uncertain, or reach separately recorded provider stages. An uncertain
command pauses only its chat. It is reconciled without a blind resend, and a
human can explicitly resolve it by cancelling, continuing reconciliation, or
choosing a resend after acknowledging duplicate risk. A restored connection
does not reset the original age.

Read, send, and webhook-management grants are distinct. Webhook subscriptions
are first-class independent objects. Each has its own
owner, destination version, event deliveries, retry age, status, and stable
receiver-facing IDs. Global, account, and chat settings are evaluated within
each subscription, with the most specific setting winning. One subscription's
failure, override, cutover, or revocation does not suppress another. A newly
saved incoming message can fan out to eligible subscriptions; imports, own
messages, and duplicate sync events are excluded. Before the first delivery,
the service hydrates the latest current content and includes its revision. An
edit after a delivery is a separate revision event. Deletes suppress deleted
content: pending deliveries are cancelled, while a previously notified
destination receives a content-free removal event under its current settings
and grants. Payloads include text, sender, chat, timestamp, source event and
message IDs, revision, and attachment metadata; files use authenticated access.
Active reads and files are tombstoned, and no external recall is promised.

Retention has two layers. Active views, search, and downloadable attachments
remove deleted or expired content promptly while retaining a removal tombstone.
Every controlled recoverable copy has a hard 30-day maximum. The operational
recovery window is shorter, leaving a cleanup margin before day 30. A restore
gate loads removal authority before projection or service startup, so old snapshots cannot
resurrect content. If an archive batch mixes removed and retained data, rewrite
or segment it while preserving unrelated data. A surface that cannot prove the
cutoff is an explicit completion failure, never a silently weakened guarantee.

## User Stories

1. As an end user, I want Communicator to connect agents to my own conversations, so that an agent can help with communication without computer-use workarounds.
2. As an administrator, I want the UI to manage and debug the service, so that administration does not become the primary messaging client.
3. As an end user, I want WhatsApp supported first with later providers behind the same boundary, so that provider work can be added without changing agent behavior.
4. As an end user, I want ChatGPT Work proved first and supported Grok web, mobile, and Bot surfaces proved next, so that the first value appears in clients I use.
5. As an agent client, I want one authenticated API and one remote MCP surface over the same operations, so that transport choice cannot change my authority.
6. As an administrator, I want only the administrator UI to grant or expand agent permissions, so that access changes remain deliberate and auditable.
7. As an agent, I want to inspect or request permissions without granting them, so that I can explain what I need without escalating myself.
8. As an administrator, I want grants scoped to an explicit connected account, so that accounts never become interchangeable by accident.
9. As an administrator, I want each grant to cover all current and future chats or a selected chat set, so that project access can be broad or narrow.
10. As an administrator, I want a newly connected account to remain unexposed until granted, so that adding an account does not expand an agent's authority.
11. As an end user, I want to connect two or three WhatsApp accounts in the pilot without a product account cap, so that the pilot can cover my real account layout without promising infinite capacity.
12. As an end user, I want each chat and contact tied to its owning account, so that similarly named conversations remain distinct.
13. As an agent, I want a reply routed through the account that owns its chat, so that a response comes from the expected identity.
14. As an agent, I want new conversations and groups to require an explicit connected account, so that the service never silently chooses a different account.
15. As an agent, I want to read messages from the durable stored view, so that context remains available independently of a live provider request.
16. As an agent, I want an outgoing message saved before bridge dispatch, so that a request is recoverable even if dispatch is interrupted.
17. As an agent, I want to send text initially, so that the first outbound capability has a clear usable boundary.
18. As an agent, I want to read text, images, documents, and voice notes, so that the conversation context is not reduced to text-only history.
19. As an agent, I want attachment metadata and authenticated file access, so that I can retrieve permitted media without receiving bridge credentials.
20. As an agent, I want to transcribe or interpret media in my own workflow, so that Communicator can expose provider content without choosing an agent's model behavior.
21. As an agent, I want history imported as far back as the provider allows, so that the service does not impose an arbitrary 30-day history cap.
22. As an agent, I want recent messages available while older history imports run, so that live work does not wait for a long backfill.
23. As an agent, I want import progress and known gaps reported, so that I can distinguish unavailable provider history from an empty chat.
24. As an agent, I want message search filtered by text, contact, chat, date, and direction, so that I can retrieve relevant context efficiently.
25. As an agent, I want search and retrieval to return stable account, chat, contact, message, and event IDs, so that follow-up calls refer to exact resources.
26. As an end user, I want stored reads to avoid provider read receipts, so that inspecting history does not change my conversational state.
27. As an agent, I want marking a message read to be an explicit action, so that provider receipts occur only when authorized and requested.
28. As an agent, I want edits to update agent-facing history, so that the current message content is represented accurately.
29. As an agent, I want deletions and expiry represented by removal markers, so that stale content is not presented as current.
30. As an account data owner, I want removed content removed from active storage, search, and files while a tombstone remains, so that active privacy and anti-resurrection evidence coexist.
31. As an account data owner, I want recoverable backups to use a hard 30-day maximum with a shorter recovery window and cleanup margin, so that cleanup finishes before the retention boundary.
32. As an operator, I want a restore gate to apply removal records before old data becomes readable, so that restoring a snapshot cannot resurrect removed content.
33. As an account data owner, I want mixed archive batches rewritten or segmented while retaining unrelated records, so that removing one message does not destroy other users' data.
34. As an agent, I want name search to return stable contact candidates, so that I can select a person without treating a display name as an identity.
35. As an agent, I want an explicit phone number resolved to the account's current provider identifier, including LID changes, so that a phone number is not used as an unstable conversation key.
36. As an agent, I want ambiguous contact or phone matches returned as candidates, so that the service never guesses a recipient.
37. As an administrator, I want contacting new recipients governed by a separate permission, so that broad assistant access and project-specific access can differ.
38. As an agent, I want to create a group with a name and resolved participant IDs or phones, so that group creation has an explicit target set.
39. As an administrator, I want group creation protected by a separate create-group permission, so that messaging permission alone does not create new social boundaries.
40. As an authorized group creator, I want automatic read and send access in the newly created group, so that creation does not leave me unable to use the result.
41. As an administrator, I want rename and participant add/remove protected by manage-group permission, so that group membership changes are separately controlled.
42. As an end user, I want unsupported or unverified provider capabilities surfaced for escalation, so that required features are never silently removed from scope.
43. As an administrator, I want read, send, and webhook-management grants kept distinct, so that an agent receives only the authority needed for its work.
44. As an authorized group creator, I want a new group to inherit the applicable webhook setting while webhook management remains separate, so that creation does not grant subscription control.
45. As an agent, I want to create and manage webhook subscriptions through the API or MCP, so that configuration is available in the same agent boundary.
46. As an agent, I want multiple independent webhook subscriptions, so that different destinations can receive different authorized event streams.
47. As an agent, I want global, account, and chat inheritance evaluated within each subscription, so that the most specific setting controls that destination without affecting others.
48. As an agent, I want subscription management limited to a verifiable creator within my grants or to my shared connection, so that ownership remains enforceable when a host cannot prove Bot identity.
49. As an owner or administrator, I want to manage every subscription, so that there is a recovery path when an agent is unavailable.
50. As an authorized webhook receiver, I want only newly saved incoming messages initially delivered, so that imports, own messages, and duplicate sync events do not create noise.
51. As an authorized webhook receiver, I want the latest message content and revision used before the first delivery, so that a queued notification does not deliver stale pre-edit content.
52. As an authorized webhook receiver, I want an edit after delivery represented as a separate revision event, so that consumers can update their copy without confusing event history.
53. As an account data owner, I want deletes suppressed from webhook content and pending deliveries cancelled, so that removed message bodies do not leave Communicator after deletion.
54. As an already notified receiver, I want a content-free removal event subject to current settings and grants, so that my copy can be marked removed without receiving deleted content.
55. As an authorized webhook receiver, I want stable source event IDs and subscription delivery IDs, so that retries can be deduplicated without conflating subscriptions.
56. As an operator, I want each subscription to retry independently for up to 24 hours and then show visible failure, so that one broken endpoint does not block other destinations.
57. As an authorized owner, I want to retry a failed delivery explicitly after 24 hours while retaining its event and delivery IDs, so that recovery is deliberate and deduplication still works.
58. As an administrator, I want destination cutover to cancel old pending deliveries and send only future events to the new destination, so that changing a subscription does not replay backlog.
59. As an administrator, I want revocation to cancel unauthorized queued sends and webhook deliveries as well as block new actions, so that removed authority takes effect promptly.
60. As an end user, I want an accepted outgoing message to wait when its explicit connection is unavailable, so that temporary connectivity does not lose work or trigger silent failover.
61. As an end user, I want the four-hour confirmation age anchored to the original saved request, so that reconnecting does not reset the confirmation deadline.
62. As an end user, I want to confirm or cancel after the four-hour window with my reply recorded durably, so that continued dispatch reflects an explicit human choice.
63. As an end user, I want a delivery-uncertain chat paused without pausing other chats, so that one ambiguous provider outcome cannot stop unrelated work.
64. As an end user, I want to continue a chat explicitly while its uncertain command remains recorded, so that other work can proceed without hiding duplicate risk.
65. As an end user, I want an uncertain command resolved by reconciliation, cancellation, or an explicit resend choice, so that the service never blindly sends a possible duplicate.
66. As an agent, I want group creation reconciled from the normal response, provider events, and a group refresh, so that a delayed result can be recognized without guessing from a name alone.
67. As an end user, I want unresolved group creation to keep checking with bounded backoff and then surface uncertainty to a human, so that the service avoids blind retries and duplicate groups.
68. As an administrator, I want sync progress, grants, queued sends, webhook status, failures, and the action log visible, so that I can diagnose authority and delivery without reading internal state.
69. As an administrator, I want to start WhatsApp account pairing from the administrator UI, so that a connected identity enters Communicator through an intentional workflow.
70. As an administrator, I want pairing expiry, refresh, cancellation, and provider failure shown explicitly, so that I can recover a linking attempt without guessing its state.
71. As an administrator, I want Communicator to verify the provider account identity and detect duplicates before linking, so that one identity does not create multiple connected accounts.
72. As an administrator, I want pairing secrets protected from logs, agents, and stored message data, so that account credentials remain confined to the linking workflow.
73. As an administrator, I want a newly linked account to receive no agent grants automatically, so that linking and authorization remain separate decisions.
74. As an administrator, I want a same-identity relink to preserve stored history, chats, grants, and the immutable send route, so that a session change does not split an account.
75. As an administrator, I want a different provider identity to create a new account that needs new grants, so that histories and routes never move between identities.
76. As an administrator, I want disconnect to revoke the active pairing while preserving stored history, so that removing live access does not imply deleting records.
77. As an operator, I want linking separate from OAuth agent transport behind a provider-neutral interface, so that future providers can authenticate differently without changing agent authority.
78. As a release owner, I want live acceptance to begin with an unlinked account and pinned bridge proof, so that a preloaded session or unverified bridge behavior cannot count as support.

## Implementation Decisions

The following are implementation proposals for the next agent. They preserve the
settled product behavior while leaving provider and credential facts behind
explicit proof gates.

The API/MCP boundary should use an OAuth-compatible, resource-bound transport.
The authenticated principal and client installation prove the connection; a
separate logical agent record can label a workflow. The resolver intersects
transport scopes with administrator grants for connected accounts and all or
selected chats. Read, send, and webhook-management grants are distinct. If a
host cannot prove a Bot's identity, use connection-wide grants and subscription
ownership for that installation. Strong per-agent isolation requires separate
authenticated connections or users; a caller-supplied Bot name is not proof.
Both transports call the same resolver, and neither forwards its credential to a
provider.

Account linking should use a separate administrator-owned lifecycle with
provider-neutral operations for starting, refreshing, observing, cancelling,
verifying identity, relinking, and disconnecting. A provider may implement
those operations with a QR challenge, device code, OAuth flow, or another
method. The lifecycle records provider, attempt generation, expiry, actor,
redacted status, and proof status. Pairing data is a short-lived secret sent
only to the authorized administrator UI. If a provider requires temporary
state, encrypt it, expire it, and keep it out of agent-visible and message
storage. A callback must include the active attempt generation; expired,
cancelled, revoked, or superseded callbacks cannot attach an account.

After pairing succeeds, the adapter must verify the stable provider account
identity. A matching identity uses the existing account and immutable
account-owned send route. A new identity creates a new account with no grants
and no history or route transfer. Disconnect revokes the active pairing and
prevents new provider dispatch while retaining stored account and message
records. An unavailable connection follows the existing waiting-send rule; a
relink does not reset the saved age, bypass confirmation after four hours, or
resolve an uncertain send. A provider call already in flight keeps its actual
Matrix, bridge, and provider evidence; Communicator makes no recall promise.
The controlled provider mock proves these transitions. The pinned WhatsApp
bridge API must be tested before live QR, relink, or disconnect behavior is
called supported.

The account and chat registry is the ownership authority for provider routing.
All message, command, contact, group, and webhook decisions carry account and
chat scope. Contact resolution stores the provider's stable identifier and
account binding. A phone number is resolved to the current provider ID or LID;
multiple matches produce a choice. A name alone never selects a recipient.

The inbound message projection should remain separate from the outbound command
ledger. It should expose current content, revisions, removal markers,
attachment metadata, and import status while preserving existing archive and
replay behavior. The provider adapter reports capability and proof status for
history, media, groups, and receipts. Failure to prove a required capability is
an escalation or explicit unsupported result; it does not silently narrow the
specification.

The outbound command ledger commits the outgoing message, command, and durable
dispatch record atomically. Its states are saved, waiting for connection,
confirmation required, dispatching, delivery uncertain, and separately
observed Matrix, bridge, and provider outcomes, with failed or cancelled
terminal records where appropriate. The four-hour timer records the original
saved age permanently. Reconnection can make a waiting command eligible but
cannot erase that age. A stale dispatch lease is reclaimable. Authorization is
checked immediately before provider I/O and again for queued work.

Provider uncertainty is a first-class result. A timeout or ambiguous response
does not create a new provider transaction automatically. The affected chat is
paused, while other chats continue. Reconciliation may use the normal provider
response, a provider event, a matching remote echo, or a targeted refresh. A
human can cancel, explicitly continue the chat while the original remains
recorded, or choose a resend after duplicate risk is shown. No universal
create-key idempotency promise is made for group creation; the provider's actual
contract must be verified before one is introduced.

Group creation should accept explicit account and resolved participants, record
the requested name, and reconcile in this order: normal response, provider
events, then a bounded group refresh. Matching requires account and provider
identifiers plus an appropriate participant or operation correlation; a group
name alone is insufficient. Retries are bounded checks, not blind create calls.
Automatic reconciliation is intended behavior; the exact pinned-provider
matching proof remains pending. Only when response, event, and refresh evidence
cannot identify the result should a human decision be surfaced with duplicate
risk. Once the group is positively identified, grant its creator read and send
access; create-group and manage-group permissions remain separate.

The webhook subscription manager owns definitions, inheritance rules, and
ownership. The delivery ledger owns one record per subscription and stable
source-event and subscription-delivery identifiers, destination version,
attempts, first-pending time, next retry, and visible terminal status. Fan-out
is committed with the saved incoming message. Before the first HTTP call,
recheck current grants, subscription status, destination version, tombstone
state, and latest message revision. Hydrate latest content for the initial
delivery. Payloads include text, sender, chat, timestamp, source event and
message IDs, revision, and attachment metadata; files require authenticated
access. An edit after a delivery creates a separate revision event. Deletion
suppresses webhook content, cancels pending work, and emits a content-free
removal event for a previously notified destination under current settings and
grants. Destination cutover and revocation cancel old pending rows; an
in-flight result is recorded as uncertain. Retry age ends at 24 hours; an
explicit authorized retry after failure retains stable IDs and does not reset
the original age.

The retention manager records removal authority outside rebuildable projections.
It tombstones active message and media views promptly, cancels pending delivery,
and coordinates purge of every controlled recoverable copy: archives,
projections, bridge data, media, queues, and backups. Every such copy has a
hard 30-day maximum; the operational recovery window is shorter, leaving a
cleanup margin. Any copy that cannot meet or prove it is a blocking failure.
Restore must load removals first and block stale commands and
webhook pointers. Mixed archive batches require rewrite or a purgeable
segmentation scheme that preserves unrelated data. External copies and already
delivered messages remain observable as uncertain when Communicator cannot
recall them.

The administrator UI is the authority surface for connections, import status,
grants, subscriptions, outgoing states, failures, retention progress, and the
audit log. A client proof harness should exercise the same live application
backend through API and MCP, with no bridge credential exposed to clients.

## Testing Decisions

The primary test seam is high-level and application-facing: the shared live
backend is driven once through the API and once through MCP, with a controllable
provider adapter, controllable clock, and webhook receiver that can inject
timeouts, duplicate responses, late events, revocation races, and endpoint
failures from outside the application. This seam is preferred because it tests
the actual authorization and state transitions without requiring real messages.
It must not become a second fake product implementation. Reuse existing
createApp().request, D1, and runInDurableObject patterns plus the gateway's
injected Clock and WireMock; the browser MSW transport is useful UI coverage but
is not conformance evidence.

Linking tests use the same application seam with a controlled provider adapter.
They start unlinked and cover administrator-only start, QR or provider-specific
challenge delivery, secret redaction, expiry and refresh generations,
cancellation, authentication failure, identity verification, duplicate
detection, same-identity relink, different-identity account creation, explicit
disconnect, stale callback rejection, and the absence of automatic grants.
They also prove the real pinned WhatsApp adapter path, while recording an
unknown bridge contract as a block or escalation. The tests prove that linking
does not create an OAuth installation and that agent OAuth cannot perform
administrator linking.

Preserve existing lower-level projection, archive replay, event ordering,
tombstone, and authentication tests as regression coverage. Add new tests only
where the high-level contract needs evidence: account/chat grant intersections;
administrator-only grant changes; account-owned routing; contact ambiguity and
LID resolution; save-before-dispatch; four-hour age persistence across
reconnection; cancellation; uncertain delivery pause and human resolution;
group response/event/refresh reconciliation; and independent webhook cutover,
revision, retry, and revocation behavior.

The controllable clock must prove that the four-hour rule is based on the saved
age, that a waiting command does not reset on reconnect, and that webhook retry
deadlines remain anchored for 24 hours. Provider failures must prove that no
blind resend occurs, that only the affected chat pauses, and that a visible
uncertain result remains available for a human choice.

Webhook tests must cover two subscriptions with different settings, global,
account, and chat inheritance, one failing while the other succeeds, duplicate
delivery attempts, latest content before first delivery, separate edits after
delivery, suppressed deletes, destination cutover without backlog, and
revocation immediately before send. Attachment tests must verify metadata and
authorization without exposing provider credentials.

Retention tests must cover prompt active redaction, tombstone-aware search and
files, mixed archive rewrite or segmentation preserving retained records,
backup completion before the 30-day ceiling, and restore ordering that applies
removals before projection startup. A physical purge that cannot be proven must
produce an explicit incomplete or uncertain result.

Provider and client proof is a separate gate. Start the live acceptance with an
unlinked administrator state. Against a pinned WhatsApp image and a sacrificial
account, prove the bridge pairing API and record the available history range,
live messages during import, media and E2EE reads, expired-media behavior,
contact and LID resolution, one-to-one and group creation, rename and
participant permissions, same-identity relink, explicit disconnect, a
different identity, two or three sessions, and receipt outcomes. The ChatGPT
Work proof then reads history and context, reads an attachment, replies through
verified WhatsApp delivery, starts a one-to-one conversation, creates and
manages a group, configures a subscription, and verifies the receiver. After
that, verify core read/send for supported Grok web, mobile, and Bot surfaces.
If the pinned bridge API or provider behavior cannot be proved, record it as
unsupported or unverified rather than treating the preloaded or controlled
state as live support.
No live client actions or real messages are authorized while implementation is
paused.

## Out of Scope

- Autonomous agents that decide or act beyond explicit administrator grants.
- A hard product cap on connected accounts or a promise of infinite provider capacity.
- Complete or unlimited provider history, arbitrary on-demand WhatsApp backfill, or unverified media, group, or receipt behavior.
- A promise that Matrix acceptance, bridge acceptance, or a saved outgoing message means WhatsApp delivery.
- Blind retries after delivery uncertainty, silent account failover, recipient selection from a name alone, or a universal group-create idempotency key.
- Outgoing media; the initial outbound content type is text.
- Implementing providers other than the WhatsApp pilot in this work.
- Provider-side recall of a message already accepted or delivered, deletion of third-party caches, or deletion of external copies Communicator cannot control.
- Transcription, media interpretation, or agent model behavior inside Communicator.
- Autonomous orchestration inside Communicator beyond explicit granted operations.
- A product-specific named Bot identity when the host cannot prove one; strong isolation requires separate connections or users.
- Client-specific wake-up guarantees for ChatGPT or Grok beyond proving the documented connector path.
- Replacing the existing archive, replay, projection, authentication, migration, or paused health history without a separately authorized decision.

## Further Notes

This document is a specification proposal prepared after the alignment and
research records; no additional user interview was run. The 49 aligned product
questions remain the scope authority. The detailed state transitions,
subscription ledger, retention executor, restore gate, and high-level testing
seam above are ready for implementation review, with provider-dependent claims
kept behind explicit proof gates.

The pinned provider image, client surfaces, history behavior, media behavior,
group matching, and provider receipt behavior must be verified before they are
described as working. An unsupported proof result escalates to an explicit
product decision. Required capabilities are not silently dropped to make a
build pass.

The migration handoff, preserved source refs, dirty health work, and paused
receive-side histories remain part of the repository context. This spec does
not authorize rewriting or discarding that work. The existing lower-level
projection, replay, and authentication coverage remains valuable regression
material.

Testing-seam approval: confirmed by the user on 2026-09-13. No implementation is authorized by this
document, and the ready-for-agent label means ready for implementation review;
it does not mean resume the build or run live messaging actions.
