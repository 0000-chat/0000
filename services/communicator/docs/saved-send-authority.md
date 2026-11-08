---
repo: 0000-chat/0000
status: current
---

# Saved send authority

Communicator captures the originating actor's authority when accepting a new
text send or an explicitly audited resend. Acceptance is not provider delivery.
Confirmation and scheduler execution use the original capture, not the
confirming user or a scheduler credential.

## Capture and stored contract

The request-scoped credential reaches `captureSavedSend` through REST or MCP.
Only the [Platform saved-operation descriptor](../../platform/docs/saved-operations.md)
is persisted. Communicator does not retain the user's bearer token.

`OutboundAuthorityMetadata.saved` contains:

- `platform`: the immutable Platform descriptor, including actor, organization,
  audience, `message.send` capability, and operation identifier.
- `binding_id`: the original local Platform binding.
- `session_generation`: the selected connection's generation.
- `route_generation`: the selected connection route's generation.
- `route`: `gateway_route_id`, `bridge_instance_id`, `matrix_user_id`, and
  `matrix_room_namespace`.

The operation identifier is `communicator:message.send:<tenant>:<request_digest>`.
The digest includes the idempotency key and accepted request. A lost capture
response can be retried without creating replacement authority. The D1
acceptance row stores the snapshot immutably, and the Durable Object preserves
it across eviction. An acceptance replay never recaptures authority.

Platform's stored row is authoritative. The authenticated service registration
determines its audience. Changing descriptor fields cannot rebind an operation.
Missing legacy snapshots remain unsendable. They are not backfilled with the
current user, service, or confirmation authority.

## Supported originating actors and expiry

| Originating actor | Saved text sends |
| --- | --- |
| Human OAuth with native-session lineage | Supported while the original session, credential, installation, membership, consent, and client remain valid. |
| Personal-harness OAuth agent | Supported while its credential, delegated installation, grant, membership, consent, and client remain valid. Browser sign-out alone does not revoke the delegation. |
| Managed agent credential | Supported while its credential, enabled agent, organization-owned grant, organization, and catalog remain valid. The creator's departure does not revoke the organization's agent. |
| Human personal key without session lineage | Denied at capture, even if ordinary authentication succeeds. |
| Service or scheduler | Denied as the originating actor. A service can authenticate the final claim transport, not replace the saved actor. |
| Guest | Denied at capture. |

The registered browser OAuth access lifetime is 3600 seconds. A capture expires
with that exact originating credential, or earlier when any required lineage
expires or is revoked. Refresh does not transfer saved authority to a replacement
credential. An offline send can therefore lose authority before its four-hour
stale-offline confirmation deadline. Confirmation does not extend authority or
change that deadline. A separately audited resend needs a new valid capture.

Connection status transitions increment account-grant authorization epochs.
An account-grant send accepted before disconnect therefore fails its saved
epoch check after reconnect, even before the confirmation deadline. Recovery
does not refresh that epoch. Owner-administrator authority has separate checks.

This is a compatibility restriction for otherwise authenticated unlineaged
personal keys, services, and guests. Existing legacy commands can remain visible,
but cannot acquire provider permission. Recovery does not backfill authority.

## Final permission and pinned gateway execution

The gateway authenticates as a registered Platform service with `outbound.claim`.
Its message claim includes the saved route and session generation. Communicator
loads the acceptance row, checks operation and tuple binding, revalidates the
original Platform descriptor, and resolves the original local binding.

The one-shot D1 claim checks current membership, principal, identity, identity
scope, account and chat grants, authorization epochs, account attachment,
provider identity and capability, route, session, and local installation state.
These local checks share the claim INSERT, including checks after awaited
Platform verification. Replayed claims never grant another provider call.

The claim response echoes the pinned route and session. Its expiry is the earlier
of the gateway claim deadline and the current Platform credential expiry.
The Rust gateway rejects mismatched echoes. After the awaited claim, the gateway
rereads its protected room binding and checks claim expiry before invoking the immutable
sender for the selected room. It never resolves a replacement account, room,
route, or client. Retirement or session rotation during the claim makes no send.

Platform verification, the D1 claim, and provider I/O are separate operations,
not one distributed transaction. Revocation after its final authority check
cannot recall an already authorized external call. Local gateway checks do not
hold the journal lock over network I/O; concurrent requests can observe pending
work without issuing another send.

## Denied, unavailable, and ambiguous outcomes

- Denied or revoked authority gives an explicit no-send failure. Missing or
  mismatched saved metadata fails closed.
- A known pre-claim dependency failure returns HTTP 503 with
  `{status: "authority_unavailable", provider_allowed: false}`. The adapter
  defers the command, keeps it pending and unpaused, and releases its lease.
  The gateway removes only its newly prepared, still-unclaimed journal entry.
- Generic errors, a lost claim response, or a lost provider response remain
  uncertain. They never authorize an automatic retry or replacement claim.

Only a newly acquired dispatch lease invokes the adapter. Request acceptance,
confirmation, explicit resend, and the combined alarm use one executor with no
request session. A replay observes the saved result without owning execution.

## Bounded recovery

The projection commits outbound rows and their next alarm together. Before
reading D1, the executor persists its next retry. It repairs acceptance
finalization from the saved reservation tuple, command, dispatch, message,
transaction, body digest, and request digest. Missing or mismatched reservations
block acquisition and sending. Repair does not create replacement authority.

Pre-I/O attempts use delays of 1, 2, 4, 8, 16, 32, 60, and 60 seconds. A command
gets at most eight attempts and a four-hour horizon from its first eligible
attempt, whichever ends first. Exhaustion fails the command without sending.
Explicit confirmation starts a new retry budget but preserves the captured
authority and original credential expiry. Offline waiting preserves its
independent four-hour confirmation deadline. A paused chat defers pending work
without consuming an attempt. No lease acquisition occurs while that chat has
an unresolved ambiguous attempt.

The alarm revalidates realtime first, then selects at most 32 due rows in indexed
deadline order. Each failed preparation advances its persisted cursor so an old
row cannot continually take the first turn. The inherited one-second budget
bounds waiting for connection observations and whether another row starts.
It does not bound total alarm duration: D1 repair awaits the runtime, and an
acquired adapter has its own gateway deadline. A permanently stalled D1 call
has no application-level cancellation guarantee. Connection observations remain
single-flight until their underlying read settles, including after a timeout.

A crash after save but before acquisition leaves eligible work discoverable.
A crash after acquisition, after a provider call, or before outcome persistence
leaves a lease that expires into uncertainty. Repeated alarms and restarts do
not make that attempt pending. Only an explicit, audited resend with duplicate
risk acknowledged creates a distinct attempt. Recovery execution does not
provide trusted provider reconciliation. The independent webhook retry window,
removal safeguards, and original actor capture remain unchanged.

## Local verification surfaces

`COMMUNICATOR_SAVED_SEND_COMPOSITION=1 pnpm --filter @communicator/control-plane test:worker`
runs a real local Platform Worker with its own D1 database, Communicator D1,
and the Durable Object. Its controlled gateway fixture calls the deployed claim
handler before a counted local provider endpoint. It covers capture response
loss, eviction, repeated claims, legacy metadata, tampering, revocation, rotation,
and pre-claim unavailability. Recovery cases count provider calls across lost
save, confirmation, resend, and finalization responses, interrupted owners,
backoff, horizon exhaustion, offline deadlines, and independent-chat progress.
Decision restart cases enter the trusted Durable Object decision contract;
the HTTP tests separately cover public decision authorization. No real provider
is used, and Matrix confirmation is not proof of WhatsApp delivery.

The Rust `authority` tests exercise HTTP claim echo validation. The provisioning
tests exercise the protected gateway store, unavailable retry, ambiguous
non-retry, expiry, and room retirement or session rotation during a claim.
The old opt-in T11 service-origin live-HTTP fixture requires a lineaged actor
capture before it can authorize text sends; a service credential alone is no
longer an accepted originating actor.
