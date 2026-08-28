# Communicator Channel and Conversation Shell Design

**Status:** Approved for implementation planning

**Document type:** Explanation and implementation reference

**Audience:** Communicator product designers, frontend implementers, API
implementers, and reviewers

**Goal:** Turn the existing backoffice Conversations page into a channel-aware,
all-in-one messenger workspace while preserving tenant and identity isolation.

## Simple explanation

Communicator should feel like a unified messenger rather than an administrative
dashboard. A user first chooses an identity. That identity owns one or more
connected messaging accounts, shown in the product as channels. Each channel
contains its own conversations, and each conversation contains its own messages.

The default **All** view combines the selected identity's conversations into one
recency-sorted inbox. It does not combine threads. A conversation with Alice on
WhatsApp and a conversation with Alice on Telegram remain separate and clearly
labelled because they use different sending routes.

The desktop workspace has four conceptual regions:

```text
Primary navigation | Channels | Conversations | Active conversation
```

The primary navigation continues to contain product areas such as Overview,
Conversations, Connections, Activity, and System. Selecting Conversations opens
the channel-aware messenger shell. Connections remains the administrative place
for pairing, reconnecting, capabilities, and account health.

## Product hierarchy

The approved hierarchy is:

```text
Tenant
`-- Identity
    |-- Channel / Connection
    |   `-- Conversation
    |       `-- Message
    `-- Channel / Connection
        `-- Conversation
            `-- Message
```

A **Connection** remains the canonical backend resource representing one remote
provider account bound to one identity. A **Channel** is the messaging-facing
presentation and read model for that connection. This design does not create a
second authoritative resource with an independent lifecycle.

One identity may own multiple channels from the same provider. For example,
Personal WhatsApp and Business WhatsApp are separate channels even though both
use WhatsApp. Each has an independent connection ID, health state, capability
set, conversation set, unread total, and sending route.

The virtual **All** entry is not a connection and has no provider credentials or
sending authority. It is an identity-scoped query across the identity's real
channels.

## Locked product decisions

The following decisions are approved for implementation:

1. Conversations remains a primary-navigation item.
2. Channels appear in a secondary sidebar inside the Conversations shell.
3. All is pinned first and is the default selection.
4. All shows a flat conversation list sorted by latest activity, not channel
   sections.
5. Every conversation row in All identifies its provider and connected-account
   label.
6. Selecting a channel filters the conversation list to that connection.
7. Channels use a stable, user-controlled order and do not move when messages
   arrive.
8. Each connected account is a separate channel, including multiple accounts
   from the same provider.
9. The same contact on different channels remains in separate conversations.
10. Opening a conversation fixes its sending channel; the composer never asks
    the user to choose another provider for that thread.
11. Switching identities resets the channel selection to All and replaces the
    complete visible channel, conversation, message, and command scope.
12. Connections remains responsible for connection lifecycle management.

## Information architecture

### Primary navigation

The global sidebar remains stable:

```text
Overview
Conversations
Connections
Activity
System
```

Channels are filters and messaging workspaces, not global product areas. They
must not be inserted as a changing list of nested global-navigation pages.

### Channel sidebar

The secondary sidebar begins with All followed by the selected identity's
channels. A channel row contains:

- provider icon and accessible provider text;
- connected-account display label;
- aggregate unread count;
- connection-health indicator;
- selected state; and
- an accessible reorder action when reordering is enabled.

All displays the sum of `ConversationSummary.unread_count` across authorized
channels. A channel displays the same sum restricted to its conversations. The
value therefore represents unread messages, not merely the number of threads
that contain unread messages, and is not maintained as an unrelated counter.

Channel order is independent from message recency. The initial simulated order
is deterministic. The UI must support a keyboard-accessible manual reorder
control; drag-and-drop may be added as an enhancement but cannot be the only
method. In simulated mode, the order survives normal navigation for the current
session and returns to the fixture default after a scenario reset. A later live
phase may persist the preference per principal and identity in a non-authoritative
control-plane preference store.

### Conversation list

The All list is ordered by descending `last_activity_at`. Each row contains:

- conversation title and optional avatar;
- last-message preview;
- latest activity time;
- unread count;
- provider badge; and
- connected-account label.

When one channel is selected, only conversations owned by that connection are
shown. The account label may be visually quieter in the filtered view, but it
remains available to assistive technology and must remain visible in the active
conversation header.

Matching titles or remote contact aliases never cause conversations to merge.
Conversation identity is determined by the canonical Communicator conversation
ID and its owning connection.

### Active conversation

The active thread header contains:

- conversation title and optional avatar;
- provider;
- connected-account label;
- selected identity label;
- connection health; and
- relevant capability or availability warnings.

The timeline renders plain text and safe attachment metadata. It does not render
untrusted message HTML. The composer submits through the active conversation's
`identity_id`, `connection_id`, and `conversation_id`.

Direct and human-paced delivery remain command modes. The browser may preview
the human-paced phases, but server-side command infrastructure remains
responsible for read, delay, typing, send, and confirmation behavior.

## Responsive behavior

Desktop presents the primary navigation, channel sidebar, conversation list,
and active thread simultaneously when space allows.

Tablet presents the channel and conversation navigation together beside the
active thread. Exact breakpoint values belong to the implementation plan and
must be verified through browser tests rather than embedded as product rules.

Mobile presents one primary task at a time:

```text
Conversation list -> Active conversation -> Back to conversation list
```

The current channel appears in a labelled selector at the top of the mobile
conversation list. Opening the channel list uses a sheet or equivalent
accessible overlay. The user can always return to All without opening the
global navigation.

## URL state and navigation

Identity, channel, and conversation selections remain deep-linkable without
making URL values authoritative for access. Representative browser routes are:

```text
/conversations?identity=identity_human
/conversations?identity=identity_human&channel=connection_human_whatsapp
/conversations/conversation_123?identity=identity_human&channel=connection_human_whatsapp
```

Omitting `channel` means All. A channel value is an opaque connection ID, not a
provider name. Opening a conversation preserves the selected channel so Back
returns to the same filtered list.

Switching identities navigates to the new identity's All view and clears the
active conversation. A stale or unauthorized channel or conversation value is
never silently reassigned to a similarly named resource. It produces the same
generic unavailable state as any other invalid ownership combination, followed
by an explicit user navigation back to the authorized All list.

## Resource contracts

### Channel summary

The UI consumes a channel read model derived from a connection. The minimum
shape is:

```text
ChannelSummary
  id                  opaque connection ID
  tenant_id           opaque tenant ID
  identity_id         owning identity ID
  provider            provider enum
  display_label       account label
  status              connection status
  capabilities        current capability set
  unread_count        aggregate unread count
  last_activity_at    nullable latest conversation activity
  sort_position       stable ordering value
  attention_code      optional safe reason code
```

`ChannelSummary.id` is the canonical connection ID. The API must not create a
second channel identifier or require callers to know Matrix, bridge, or remote
provider identifiers.

### Conversation summary

Conversation summaries continue to include tenant, identity, connection, and
conversation ownership. The All view joins each conversation's `connection_id`
to the authorized channel collection to render provider and account labels.

The API may denormalize safe channel display fields into a paginated read result
later for efficiency, but the connection ID remains the routing authority.

### Channel order preference

Manual channel order is a presentation preference, not archive truth. The
simulated phase keeps it in deterministic in-memory state. A future live
implementation may store:

```text
principal_id
identity_id
ordered_connection_ids
updated_at
```

The server must discard connection IDs the principal can no longer access and
append newly authorized channels deterministically. Reordering must never grant
access or change connection ownership.

## API behavior

Representative resource-oriented endpoints are:

```text
GET /api/v1/identities/{identity_id}/channels

GET /api/v1/identities/{identity_id}/conversations
GET /api/v1/identities/{identity_id}/conversations?channel_id={connection_id}

GET /api/v1/conversations/{conversation_id}
GET /api/v1/conversations/{conversation_id}/messages

POST /api/v1/conversations/{conversation_id}/messages
```

The unfiltered conversation endpoint implements All and orders results by
descending activity. The filtered endpoint requires the requested channel to
belong to the requested identity. Pagination must use a stable cursor composed
from activity time and opaque conversation ID so equal timestamps do not skip or
duplicate rows.

Outbound commands retain:

```text
tenant_id
principal_id
identity_id
connection_id
conversation_id
idempotency_key
operation
delivery_mode
```

The server resolves and verifies the ownership chain rather than trusting
client-supplied relationships. A conversation cannot be sent through a
different connection merely because the caller supplies both IDs.

The current simulated implementation may continue to use identity query
parameters while its routes are migrated. The implementation plan must leave
one canonical public contract and update all client, fixture, component, and
browser tests together.

## Durable Object query projection

This UI phase does not implement Durable Objects, but its contract must map
cleanly to the approved tenant projection. The tenant projection needs efficient
conversation indexes equivalent to:

```text
(identity_id, last_activity_at DESC, conversation_id)
(connection_id, last_activity_at DESC, conversation_id)
```

The identity index serves All. The connection index serves one channel. Both
queries remain tenant-scoped by the Durable Object instance and authorization
context.

Channel health and capabilities originate from connection-control events and
may be projected for reads. R2 remains the replayable archive, and neither
channel order nor UI unread aggregates become authoritative archive data.

## Realtime behavior

Realtime events used by the shell include tenant, identity, connection,
conversation, and monotonically increasing sequence context. A message event
may update only the matching authorized caches.

For a new or updated message, the client:

1. validates the event contract;
2. rejects or ignores events outside the active tenant and authorized identity;
3. updates or invalidates the matching conversation;
4. reorders the affected conversation by `last_activity_at`;
5. updates the matching channel unread aggregate;
6. updates All's aggregate unread value; and
7. leaves channel navigation order unchanged.

An event must never match conversations by title, display label, phone number,
remote contact alias, or provider alone.

Reconnect behavior continues to use the last accepted sequence or an
authenticated REST refresh. The simulated client may exercise cache updates,
but it must remain visibly labelled and must not connect to production data.

## Authorization and isolation

The selected identity is a view choice, not an authorization grant. Every API
request must derive the tenant and allowed identity set from trusted product
authentication once the live API exists.

The following ownership chain is mandatory:

```text
authorized tenant
-> authorized identity
-> connection owned by identity
-> conversation owned by connection and identity
-> message or command owned by conversation
```

Invalid, cross-tenant, cross-identity, and cross-channel route guesses return
the same generic unavailable response. Responses must not reveal whether the
resource exists under another scope.

Switching from Human to Agent or Agent to Human must:

- reset the selected channel to All;
- replace the channel collection;
- replace conversation and message queries;
- replace command activity;
- cancel or ignore stale in-flight results from the previous identity; and
- reject late realtime events that do not match the new active scope.

Break-glass access is outside this UI phase and cannot be implied by the identity
switcher.

## Connection health and failure states

A disconnected or attention-required channel remains visible so historical
conversations can be inspected. Its row shows a warning and links to the matching
Connections management surface.

The composer is disabled when:

- the connection is unavailable;
- the connection lacks `message.send`;
- the conversation is no longer sendable; or
- the current principal lacks the required command scope in a later live phase.

Required user-visible states are:

- channels loading;
- no channels for the identity;
- channel unavailable or disconnected;
- channel with no conversations;
- All with no conversations;
- conversations loading or failed with safe retry;
- conversation unavailable;
- messages loading or failed with safe retry;
- unsupported sending capability; and
- command acceptance or failure without inventing provider confirmation.

The generic unavailable state covers missing and unauthorized resources. Error
messages and diagnostics must not include provider credentials, remote IDs,
Matrix IDs, phone numbers, cookies, QR payloads, or message bodies.

Permanent unlinking and the long-term display policy for archived conversations
after unlink are deferred to the connection-lifecycle implementation. This phase
covers ready, disconnected, and attention-required channels without deleting
history.

## Simulated pilot scenario

The approved non-secret scenario contains:

```text
Human identity
|-- Personal WhatsApp
|-- Telegram
`-- Messenger

Agent identity
`-- Agent WhatsApp
```

The scenario includes multiple conversations per Human channel, at least one
same-name contact represented separately on two providers, varied unread counts,
ready and attention-required connection states, direct and human-paced command
examples, and timestamps that prove global recency ordering.

The Agent fixture remains completely separate. No Human connection,
conversation, message, or dynamic command may appear after switching to Agent,
and the symmetric rule applies when switching back to Human.

These values are fictional, deterministic, and credential-free. They do not
claim that the real Telegram, Messenger, or WhatsApp accounts are connected to
the Cloudflare data plane.

## Testing and acceptance

### Contract and adapter tests

Tests must prove:

- ChannelSummary accepts data-driven providers, status, capabilities, unread
  totals, and stable positions;
- a channel ID is the connection ID rather than a provider or Matrix ID;
- All returns only conversations authorized for the identity;
- channel filtering enforces the full identity/connection relationship;
- equal activity timestamps paginate deterministically;
- manual ordering does not alter ownership or authorization;
- dynamic conversations and commands remain identity- and connection-scoped;
- same-name contacts do not merge; and
- generic not-found behavior is symmetric across identity and channel guesses.

### Component tests

Tests must prove:

- All is selected by default;
- channels render in stable order with correct unread totals and status;
- the All list is globally ordered by recency and includes channel labels;
- selecting one channel filters the conversation list;
- manual reorder controls are keyboard accessible;
- switching identities resets to All and clears stale content;
- the active header identifies identity, provider, and connected account;
- unhealthy channels keep history readable and disable unsupported sends; and
- loading, empty, error, unavailable, and retry states are accessible.

### Browser acceptance tests

Browser journeys must cover:

1. All displays every Human conversation in descending recency order.
2. Selecting Telegram displays only Telegram conversations.
3. Every All row identifies its channel.
4. Channel order remains stable when message activity changes.
5. Manual channel reordering is preserved during normal navigation.
6. Channel and All unread totals update correctly.
7. Switching to Agent replaces the entire channel and conversation set.
8. Human and Agent cannot access each other's resources through guessed URLs.
9. Same-name contacts on different channels remain separate.
10. Direct and human-paced commands retain the conversation's connection ID.
11. Desktop, tablet, and mobile navigation remain usable.
12. Disconnected-channel history is readable while sending is disabled.
13. Production plus simulated mode fails closed.
14. No real messaging or provider operation occurs.

All selectors should use accessible roles, names, and labels. Browser tests run
without retries so product failures are not hidden by the test runner.

## Scope boundaries

This design includes:

- channel-aware Conversations information architecture;
- ChannelSummary and conversation-query contract changes;
- simulated multi-provider fixtures;
- channel filtering and All recency behavior;
- responsive messenger-shell UI;
- stable manual channel ordering in simulation;
- realtime client-boundary behavior;
- failure states; and
- automated acceptance coverage.

This design explicitly excludes:

- product authentication implementation;
- D1 control-directory implementation;
- Durable Object or Queue implementation;
- R2 archive changes;
- live Matrix ingestion;
- real provider account linking;
- real WhatsApp, Telegram, Messenger, or LinkedIn traffic;
- production deployment or Cloudflare resource mutation;
- contact identity resolution across providers;
- merged cross-channel threads;
- archived-conversation behavior after permanent unlink; and
- break-glass UI.

## Alternatives considered

### Expand channels under the global Conversations navigation item

This keeps channels visible everywhere but mixes product-area navigation with a
dynamic identity-scoped filter list. It becomes cluttered as accounts increase,
is awkward on mobile, and handles multiple accounts from one provider poorly.
It is not selected.

### Use only a flat unified inbox

This minimizes navigation but hides account boundaries and makes the sending
route less obvious. It does not satisfy the requested Franz-like channel model.
It is not selected.

### Merge matching contacts across providers

This can create an attractive contact-centric view but requires a separate
identity-resolution system and creates a material wrong-channel-send risk. It is
explicitly out of scope. Cross-provider conversations remain separate.

### Selected approach

Use Conversations as the stable global destination and place a channel sidebar
inside a dedicated messenger shell. Provide All as a virtual identity-wide view,
keep channels stable and manually ordered, and preserve explicit connection
ownership on every conversation and command.

## Implementation gate

No implementation begins from this document until the user reviews the written
specification and approves it. After approval, create a separate detailed
implementation plan suitable for GPT-5.6 Luna at extra-high reasoning effort.
The plan must use an isolated worktree, red-green testing, task-boundary commits,
and the existing no-deployment safety boundary.
