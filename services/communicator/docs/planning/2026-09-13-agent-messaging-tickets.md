# Agent messaging tickets

Parent: GitHub issue [#11, "Spec: WhatsApp-first agent messaging through shared API and MCP"](https://github.com/0000-chat/0000/issues/11)

Status: published to GitHub with `ready-for-agent` after the user's approval.
The issue bodies preserve this breakdown, with planning references resolved to
GitHub links and native parent/blocking relationships. Building remains paused.

Published issue index (stable planning ID → GitHub issue):

| Planning ID | GitHub issue |
| --- | --- |
| T01 | [Account-scoped reads and grants #12](https://github.com/0000-chat/0000/issues/12) |
| T02 | [OAuth remote MCP #13](https://github.com/0000-chat/0000/issues/13) |
| T24 | [WhatsApp account linking #14](https://github.com/0000-chat/0000/issues/14) |
| T03 | [Capabilities and history #15](https://github.com/0000-chat/0000/issues/15) |
| T04 | [Incoming attachments #16](https://github.com/0000-chat/0000/issues/16) |
| T05 | [Search and context #17](https://github.com/0000-chat/0000/issues/17) |
| T06 | [Durable reply acceptance #18](https://github.com/0000-chat/0000/issues/18) |
| T07 | [Offline waits and confirmation #19](https://github.com/0000-chat/0000/issues/19) |
| T08 | [Uncertain-send recovery #20](https://github.com/0000-chat/0000/issues/20) |
| T09 | [WhatsApp dispatch #21](https://github.com/0000-chat/0000/issues/21) |
| T10 | [Contacts and new conversations #22](https://github.com/0000-chat/0000/issues/22) |
| T11 | [Group creation #23](https://github.com/0000-chat/0000/issues/23) |
| T12 | [Group management #24](https://github.com/0000-chat/0000/issues/24) |
| T13 | [Webhook configuration #25](https://github.com/0000-chat/0000/issues/25) |
| T14 | [Incoming webhook delivery #26](https://github.com/0000-chat/0000/issues/26) |
| T15 | [Webhook reliability #27](https://github.com/0000-chat/0000/issues/27) |
| T16 | [Active deletion and expiry #28](https://github.com/0000-chat/0000/issues/28) |
| T17 | [Edit/removal notifications #29](https://github.com/0000-chat/0000/issues/29) |
| T18 | [Explicit read receipts #30](https://github.com/0000-chat/0000/issues/30) |
| T19 | [Archive purge #31](https://github.com/0000-chat/0000/issues/31) |
| T20 | [Controlled-copy retention #32](https://github.com/0000-chat/0000/issues/32) |
| T21 | [Safe restore #33](https://github.com/0000-chat/0000/issues/33) |
| T25 | [Relink and disconnect #34](https://github.com/0000-chat/0000/issues/34) |
| T22 | [ChatGPT Work acceptance #35](https://github.com/0000-chat/0000/issues/35) |
| T23 | [Grok connector proof #36](https://github.com/0000-chat/0000/issues/36) |

Every `Parent: #11` field below refers to that shared approved specification.
Issue #1 is the coordination map for this work, not a second parent. Existing
issue #10 is the historical predecessor for durable sends, not a second parent
for T06-T08 or the linking tickets. This order is the proposed implementation
order. Ticket IDs T01-T25 are stable references; their physical order follows
the current dependency map and does not renumber existing tickets. Each ticket is one vertical
behavior through the storage and application boundary, API/MCP transport, or
administrator UI where that behavior needs it. The acceptance lists are
contract evidence, including failure cases. Existing issue #5 health work and
issue #9 runtime work remain in place and are not changed by this breakdown.

## Ticket map

| ID | Short name | Blocked by |
| --- | --- | --- |
| T01 | Account-scoped stored reads and grants | none |
| T02 | OAuth remote MCP read authority | T01 |
| T24 | WhatsApp account linking and initial pairing | T01, existing #9; #9 remains blocked by #5 |
| T03 | Provider capability and history import progress | T24; T01 and existing #9 are transitive; #9 remains blocked by #5 |
| T04 | Authenticated incoming attachments | T03, T02 |
| T05 | Scoped message search and context retrieval | T02 |
| T06 | Durable idempotent text reply acceptance | T02 |
| T07 | Offline wait and four-hour confirmation | T06 |
| T08 | Uncertain send reconciliation and chat pause | T06 |
| T09 | WhatsApp text dispatch and evidence | T03, T07, T08 |
| T10 | Contact resolution and new one-to-one chats | T09 |
| T11 | Group creation and automatic reconciliation | T10 |
| T12 | Group rename and membership changes | T11 |
| T13 | Independent subscription configuration and inheritance | T02 |
| T14 | Post-storage incoming webhook delivery | T04, T13 |
| T15 | Independent retry, cutover, and manual retry | T14 |
| T16 | Active deletion, expiry, and anti-resurrection | T05, T14 |
| T17 | Edit and removal webhook revisions | T16 |
| T18 | Explicit mark-read receipts | T09 |
| T19 | Archive purge and mixed-batch preservation | T16 |
| T20 | Controlled-copy retention ceiling | T16 |
| T21 | Safe restore and stale-work rejection | T19, T20, T07, T08, T15 |
| T25 | Relink and explicit WhatsApp disconnect | T24, T07, T08 |
| T22 | ChatGPT Work acceptance | T12, T17, T18, T21, T25 |
| T23 | Grok connector proof | T09 |

Existing issue #10 should be retained as the historical parent for its current
scope until tracker reconciliation is approved. T06, T07, and T08 are the
proposed successor slices for its durable send work. This document does not
close, rewrite, or create competing ownership for #10. Existing issue #7
capability research and #8 proof planning are reference material for T03, T09,
T22, and T23. They are not automatic open blockers.

## T01: Account-scoped stored reads and administrator grants

**Parent:** #11

**What to build.** Add the first live application behavior for reading stored
messages under explicit connected-account ownership. A read request resolves
the authenticated principal, the selected logical agent when present, the
connected account, and either all current and future chats or an explicit chat
set. The resolver returns only messages, chats, contacts, and attachment
metadata owned by granted accounts and chats. Add administrator-only grant
creation, update, and revocation, plus agent inspection and permission-request
records that cannot mutate grants. Provide the administrator UI for those grant
changes, with account and chat selectors, audit feedback, and pagination. Keep
read, send, and webhook-management permissions separate even when one
administrator grants more than one.

**Scope boundaries.** This ticket covers stored reads and grant authority. It
does not add OAuth remote MCP, provider history import, outbound commands,
files, search, webhooks, or provider calls. A newly connected account remains
unavailable until an administrator grants it. Account count has no product cap;
an infrastructure limit must be reported as capacity.

**Existing work reuse.** Reuse the existing OIDC subject and token-revocation
concepts, directory membership and audit records, tenant/account/chat ownership
bindings, and the archive-backed stored projection. Treat those as module
concepts, not as proof that account/chat grants already work.

**Acceptance.**

- [ ] A granted account with an all-chats grant can read current and newly
  created chats owned by that account.
- [ ] A selected-chat grant can read only its selected chats and stable account,
  chat, contact, message, and event identifiers are returned.
- [ ] A request for another account, an unselected chat, or a newly connected
  ungranted account returns a clear authorization failure and writes no data.
- [ ] An agent can inspect or request permission, but the same principal cannot
  create, widen, or revoke a grant.
- [ ] Revocation blocks a subsequent read and records an audit event.
- [ ] The administrator UI can create, narrow, revoke, and inspect account and
  chat grants, and an agent-facing request cannot mutate them.
- [ ] Account and chat lists paginate without an arbitrary 64-account product
  cap; infrastructure capacity is reported as a capacity result.
- [ ] API-level authorization tests cover all-chats, selected-chat, account
  mismatch, revoked grant, and cross-tenant cases.

**Blocked by:** none.

## T02: OAuth remote MCP read authority

**Parent:** #11

**What to build.** Add the authenticated remote MCP read transport and make it
call the same authorization resolver as the API. Complete a usable OAuth
authorization-code onboarding flow with PKCE S256 through the chosen existing
or configured authorization server, then validate resource-bound bearer
requests, protected-resource and authorization-server metadata, operation scope
challenges, and 401 versus 403 behavior. Model the OAuth installation
separately from a logical named agent. Validate issuer, subject, audience or
resource, expiry, token revocation, installation state, and the local
account/chat grant on every request. Include runnable Cloudflare public API and
MCP ingress configuration for a controlled environment. The transport must
never forward its credential to a provider. Preserve the exact stored-read
behavior from T01.

**Scope boundaries.** This ticket proves remote MCP read access and shared
authority. It does not add send, webhooks, or per-Bot identity that the host
cannot prove. Select an OAuth server or vendor only as needed to make the
configured onboarding flow runnable. A scope upgrade can satisfy transport
consent but cannot expand an administrator grant. Keep the API and MCP resource
identifier choice explicit in the configuration and tests.

**Existing work reuse.** Reuse T01's resolver, directory revocation and audit
concepts, existing OIDC issuer/subject/jti verification, and the shared API/MCP
boundary decision. The MCP protocol is a transport adapter, not a second
permission implementation.

**Acceptance.**

- [ ] A valid OAuth installation can read the same granted account and chat
  through MCP and API, with equivalent identifiers and redactions.
- [ ] A fresh client completes authorization-code PKCE onboarding, including
  state, code-verifier, resource, redirect, token exchange, and installation
  persistence; a bad state or verifier creates no installation.
- [ ] A controlled environment can deploy and reach the public Cloudflare API
  and MCP ingress with the documented metadata and health checks.
- [ ] A token for another resource, wrong issuer, expired token, revoked token,
  or revoked installation gets 401 with the required resource metadata.
- [ ] A valid principal lacking a local account or chat grant gets 403, even
  after requesting an additional OAuth scope.
- [ ] A caller-supplied agent name cannot select a different grant or owner.
- [ ] Tests prove MCP and API use one resolver and that no provider request
  receives the inbound bearer token.
- [ ] Metadata and scope-challenge tests cover a fresh client installation.

**Blocked by:** T01.

## T24: WhatsApp account linking and initial pairing

**Parent:** #11

**What to build.** Add administrator-only WhatsApp linking through a
provider-neutral lifecycle and the real adapter path for the pinned bridge
contract. The administrator UI starts an attempt; the backend records provider,
generation, expiry, actor, and redacted status; and the adapter returns a QR or
other challenge. Support refresh, expiry, cancellation, provider failure, and
retry. On success, verify the stable provider identity before creating an
account. An existing identity returns `relink_required` for T25. Pairing data
goes only to the administrator UI, never to logs, agent calls, or message
records. A new account creates no agent grant; T01 remains the grant authority.

**Scope boundaries.** Linking is separate from OAuth agent transport. The
shared interface allows QR, device-code, OAuth, or other provider-specific
authorization. Controlled mocks cover deterministic tests, while this ticket
implements and verifies the pinned WhatsApp bridge path. An unknown bridge API
blocks completion and is recorded for escalation. Relink and disconnect are
T25.

**Existing work reuse.** Reuse T01's administrator grant UI and audit model,
the #9 connection seam, provider capability status, and secret handling. Do
not modify #9 or grant agents as a pairing side effect.

**Acceptance.**

- [ ] An authorized administrator starts an attempt, receives a controlled QR
  challenge, and sees provider, actor, expiry, and status; logs, API/MCP calls,
  and durable records contain no pairing secret or provider credential.
- [ ] Expiry and refresh create distinct generations, and cancellation or a
  stale callback cannot create or activate an account.
- [ ] Provider authentication failure is visible, retryable, and leaves no
  partial connected-account record; the action is auditable.
- [ ] Pairing verifies the stable provider identity, detects a duplicate as
  `relink_required`, and creates a new account with no agent grant until T01.
- [ ] Pairing does not create an OAuth installation, and an agent OAuth request
  cannot start or complete administrator account linking.
- [ ] Controlled mocks cover lifecycle failures, and a pinned-bridge test
  covers the real adapter path; unknown API behavior blocks completion instead
  of becoming an unverified support claim.

**Blocked by:** T01 and existing #9. Existing #9 remains blocked by #5.

## T03: Provider capability and history import progress

**Parent:** #11

**What to build.** Add a provider-neutral capability record and an account-scoped
history import workflow for the WhatsApp pilot. The provider adapter reports
which history, media, contact, group, and receipt capabilities it can prove,
with status values that distinguish supported, conditional, unverified, and
unsupported. Start a bounded import for a granted connected account, keep live
messages readable while older history loads when the provider permits it, and
persist progress, source ranges, completed ranges, and known gaps. Expose the
state through the stored-read API and the administrator view. Record provider
evidence separately from a product claim.

**Scope boundaries.** This ticket does not send a message, resolve contacts,
create groups, expose files, or promise unlimited history. It does not modify
existing health issue #5 or runtime issue #9. T03 can consume the runtime's
account connection and receive-side events when those existing tickets provide
them; the import behavior must report a blocked or unavailable runtime rather
than silently inventing progress.

**Existing work reuse.** Reuse the provider adapter boundary, account and
connection ownership tuple, canonical live/backfill event concepts, archive and
projection progress records, and existing issue #7 capability research and #8
proof plan as references. The local WhatsApp history-disabled configuration is
evidence of current state, not proof of a permanent provider limit.

**Acceptance.**

- [ ] A capability response identifies the account, provider version or proof
  source, capability, and status without claiming unverified behavior works.
- [ ] A history import persists started, active, completed, partial, failed,
  and known-gap states with stable import and range identifiers.
- [ ] Recent live messages remain readable during a simulated slow import, and
  the response distinguishes an empty chat from a not-yet-imported range.
- [ ] Provider refusal, missing runtime, malformed range, duplicate event, and
  interrupted worker leave an honest resumable or failed state.
- [ ] Tests prove account isolation, idempotent progress updates, bounded retry,
  and no silent fallback to another account.
- [ ] Administrator and API read views show progress and known gaps.

**Blocked by:** T24. T01 and existing #9 are transitive; existing #9 remains
blocked by #5.

## T04: Authenticated incoming attachments

**Parent:** #11

**What to build.** Add authenticated access to incoming image, document, and
voice-note content represented in the stored message view. Return attachment
metadata with stable message and attachment identifiers, MIME type, filename,
size, hash, revision, and a short-lived or otherwise scoped download grant.
The file endpoint checks the same account/chat read authority as T01 and
rechecks removal state immediately before reading bytes. The provider adapter
may fetch Matrix or bridge media and handle encryption, but the agent receives
only Communicator's response and never a bridge credential.

**Scope boundaries.** This ticket covers incoming files only. It does not add
outgoing media, transcription, interpretation, or a provider-side recall
promise. Expired or unverified provider media must produce an explicit
unavailable result. Active deletion and full retention purge are T16 and later.

**Existing work reuse.** Reuse T03's capability and account state, T01/T02
authorization, existing attachment metadata and encrypted-media concepts, and
the current receive-side E2EE handling. Treat Matrix media support as a route
to prove, not as proof that every WhatsApp media case works.

**Acceptance.**

- [ ] An authorized reader receives metadata and downloads an allowed fixture
  with the expected content hash and MIME type.
- [ ] A reader without the account/chat grant, with a revoked installation, or
  with an expired download grant receives 401/403 and no bytes.
- [ ] A deleted, expired, missing, or provider-rejected file returns a stable
  unavailable/removal result and never returns stale bytes.
- [ ] The response contains no provider access token, bridge secret, or
  unbounded upstream URL.
- [ ] Tests cover encrypted metadata, malformed attachment records, size limit,
  revision mismatch, authorization race, and provider timeout.
- [ ] Capability evidence marks media as unverified until a pinned-account test
  proves the required read path.

**Blocked by:** T03 and T02.

## T05: Scoped message search and context retrieval

**Parent:** #11

**What to build.** Add account- and chat-scoped search over stored messages with
text, contact, chat, date, and direction filters. Return stable identifiers and
enough message revision, sender, timestamp, attachment metadata, and removal
state for an agent to request exact context later. Apply the T01 grant
intersection before query execution and again when fetching context. Define
bounded pagination, deterministic ordering, and a clear result for a tombstoned
message. Make the API and remote MCP query shapes equivalent.

**Scope boundaries.** Search reads stored state only. It does not query a live
provider, mark messages read, send replies, perform contact resolution, or
remove data. It cannot broaden an all-chats or selected-chat grant. Search
indexes may be rebuilt from the stored view, but a rebuild must preserve account,
chat, revision, and tombstone filtering.

**Existing work reuse.** Reuse T01's resolver and account/chat ownership, T02's
shared MCP authority, projection message ordering and revision concepts, and
the existing seek-pagination approach. Existing projection tests remain
regression evidence; add only the search contract cases needed here.

**Acceptance.**

- [ ] Text, contact, chat, date, and incoming/outgoing filters compose within
  the caller's granted accounts and chats.
- [ ] Results have deterministic pagination, stable IDs, current revision, and
  an explicit removal marker where applicable.
- [ ] A selected-chat caller cannot infer or retrieve matches from another chat,
  even through a broad text query or cursor.
- [ ] API and MCP return equivalent results and authorization errors.
- [ ] Tests cover empty results, malformed date range, duplicate terms, cursor
  reuse, expired cursor, cross-account contact name, and tombstoned message.
- [ ] Search never calls a provider and never changes read-receipt state.

**Blocked by:** T02. T01 is transitive through T02.

## T06: Durable idempotent text reply acceptance

**Parent:** #11

**What to build.** Add the live text-reply acceptance command. Resolve the
target chat's owning account, require the distinct send grant, validate a
client idempotency key and text-only payload, then commit the outgoing message,
command, and dispatch record atomically before any provider or bridge I/O. Keep
the saved outgoing message distinct from Matrix, bridge, and provider delivery.
Expose the durable command state and stable command/message/event IDs through
API and MCP. Repeating the same authorized idempotency key returns the same
command; a different payload or chat with that key is rejected.

**Scope boundaries.** This ticket stops at durable acceptance and controlled
provider-adapter dispatch hooks. It does not claim WhatsApp delivery, implement
the four-hour wait, reconcile uncertain sends, or add group commands. It does
not silently choose another account if the chat's account is unavailable.

**Existing work reuse.** This is the detailed successor slice for existing #10,
whose current issue remains unchanged until tracker reconciliation is approved.
Reuse the Matrix room/account ownership tuple, canonical command and delivery
event concepts, Durable Object transactional storage, existing directory
authorization, and the provider adapter seam. Existing issue #9 runtime remains
the connection source; this ticket does not modify it.

**Acceptance.**

- [ ] One authorized text request commits outgoing message, command, and
  dispatch row in one transaction before the adapter is called.
- [ ] A repeated idempotency key returns the original command without a second
  outgoing message or provider transaction.
- [ ] Same key with changed text, chat, account, or actor is rejected.
- [ ] Missing send grant, unknown or ungranted account, revoked grant,
  attachment payload, or empty text fails without a partial row; an unavailable
  explicit connection is accepted durably for T07 instead of rejected.
- [ ] A saved command is reported as saved/accepted, never provider delivered.
- [ ] Crash-injection tests cover before commit, after commit, and before
  dispatch wakeup, with recovery leaving one command.

**Blocked by:** T02. Existing #10 is the historical issue; T06-T08 are its
proposed successor slices.

## T07: Offline wait and four-hour confirmation

**Parent:** #11

**What to build.** Extend T06 for a command whose explicit connected account has
no usable connection. Keep it in `waiting_for_connection` without account
failover. Anchor the four-hour confirmation due time to the original saved
command timestamp, even across reconnects, restarts, alarm retries, and lease
recovery. Once due, require an authorized durable confirmation or cancellation
reply. Store the reply actor, timestamp, decision, and original age. A confirmed
command can become dispatch-eligible; a cancelled command remains a durable
terminal record.

**Scope boundaries.** This ticket covers offline waiting and confirmation. It
does not send to WhatsApp, resolve provider uncertainty, or apply the rule to
group creation. Reconnection may wake a command, but it cannot reset its age or
skip confirmation.

**Existing work reuse.** Reuse T06 command records and the controlled clock,
Durable Object transaction/alarm concepts, connection status from the existing
runtime, and the audit event model. The four-hour requirement is product scope,
not a provider claim.

**Acceptance.**

- [ ] An accepted reply for an unavailable explicit account waits and records
  the account identity without trying another account.
- [ ] The due time and original age remain unchanged after reconnect, restart,
  repeated alarms, and stale-lease recovery.
- [ ] Before due, confirmation is rejected or recorded as not required without
  dispatch; after due, dispatch remains blocked until an authorized choice.
- [ ] Confirm and cancel are idempotent, retain actor and timestamp, and reject
  unauthorized or conflicting choices without overwriting history.
- [ ] Tests use a controllable clock and cover four-hour boundary, clock replay,
  duplicate alarm, reconnect, cancellation before dispatch, and revocation.
- [ ] The administrator view distinguishes waiting, confirmation required, and
  cancelled from provider failure or delivery.

**Blocked by:** T06. This is the second proposed successor slice for existing #10.

## T08: Uncertain send reconciliation and chat pause

**Parent:** #11

**What to build.** Extend T06/T07 with a first-class `delivery_uncertain` state
when dispatch may have reached Matrix or the bridge without a definitive result.
Persist one stable transaction identifier and request digest for reconciliation.
Pause new sends for only the affected chat. Add reconciliation by provider
response, Matrix remote echo, bridge status, or targeted refresh. Add explicit
human actions to cancel, continue the chat while retaining the uncertain
command, or choose a resend after duplicate risk is shown. Reclaim stale
dispatch leases without creating a fresh transaction automatically.

**Scope boundaries.** This ticket does not claim provider delivery, add a
universal group-create idempotency key, or perform blind retries. Continuing a
chat does not erase or silently resolve the uncertain command. It does not add
the real WhatsApp adapter proof in T09.

**Existing work reuse.** Reuse T06/T07 durable commands, Matrix transaction and
remote-echo concepts, bridge delivery update concepts, tenant account/chat
ownership, controlled clock, and administrator action log. The existing
receive-only runtime remains unchanged.

**Acceptance.**

- [ ] A timeout or ambiguous adapter result creates one uncertain command with
  stable transaction ID and pauses only its chat.
- [ ] A matching response, remote echo, bridge status, or targeted refresh can
  reconcile the command without creating a second provider transaction.
- [ ] Unrelated chats continue to accept sends, while new sends in the paused
  chat receive a visible pause reason.
- [ ] Cancel, continue, and explicit resend require authorization and record the
  human choice; resend displays duplicate risk and uses a new deliberate action.
- [ ] Tests cover timeout after provider acceptance, duplicate response, late
  echo, stale lease, wrong-chat echo, revoked grant, and restart recovery.
- [ ] The UI/API distinguishes Matrix confirmation, bridge acceptance, provider
  evidence, and uncertainty.

**Blocked by:** T06. This is the third proposed successor slice for existing #10.

## T09: WhatsApp text dispatch and evidence

**Parent:** #11

**What to build.** Bind the controlled text command path to the pinned WhatsApp
provider through the provider-neutral adapter. Route every reply through the
chat's owning account and explicit connected session. Record separate Matrix,
bridge, and provider stages, provider message identifiers, observed timestamps,
and evidence source. Pass timeouts and ambiguous responses to T08 rather than
starting a second transaction. Record provider capability and proof status for
text send, account routing, and delivery/read evidence. Provide a documented
staging proof command and administrator evidence view using a sacrificial linked
account.

**Scope boundaries.** This is text outbound only. It does not add contacts,
groups, outgoing media, or client acceptance. A saved or Matrix-accepted
message remains distinct from WhatsApp delivery. Live proof stays behind the
approved implementation and provider test gate; unsupported evidence is shown
as unsupported or unverified.

**Existing work reuse.** Reuse T03 capability records and #7 research, T06-T08
command states, T09's existing runtime/account binding from issue #9, the
receive-side bridge adapter, and #8 proof planning. Do not modify issue #5 or
#9 as part of this ticket.

**Acceptance.**

- [ ] An authorized text command reaches the selected WhatsApp account and the
  record contains distinct stage evidence and provider ID when available.
- [ ] A disconnected or wrong account produces waiting/failure with no silent
  failover; timeout produces T08 uncertainty rather than blind resend.
- [ ] Duplicate command delivery reuses the stable transaction and does not
  create two sends when the provider evidence supports reconciliation.
- [ ] Provider rejection, expired session, rate limit, and missing capability
  remain visible and do not become a false delivered state.
- [ ] Controlled-provider tests cover success, timeout, late outcome, duplicate
  event, account mismatch, and revoked send authorization immediately before I/O.
- [ ] Evidence records identify what was tested and avoid claiming unsupported
  history, media, group, or receipt behavior.

**Blocked by:** T03, T07, and T08.

## T10: Contact resolution and new one-to-one chats

**Parent:** #11

**What to build.** Add account-scoped contact search and one-to-one chat
creation. Name search returns stable contact candidates with provider ID,
current LID or equivalent identifier, account, display name, and match reason.
An explicit phone number resolves through the selected account to the current
provider identifier before creating a chat. Ambiguous results require an
explicit candidate choice. New chat creation requires a separate permission,
names the connected account, records the selected contact, and returns the new
chat only after provider or bridge evidence identifies it.

**Scope boundaries.** A name alone never selects a recipient. This ticket does
not create groups, send the first message, or infer account failover. Provider
resolution that cannot be proven returns candidates or an explicit unsupported
result.

**Existing work reuse.** Reuse T09's verified account routing, T01/T02 grants,
T03 capability status, and the contact/provider-ID concepts from the pinned
WhatsApp research. Existing issue #7 capability research is reference evidence,
not an automatic pass.

**Acceptance.**

- [ ] Name search returns zero, one, or multiple account-bound candidates with
  stable IDs; it never guesses from a display name.
- [ ] Phone resolution stores the current provider ID/LID and rejects an
  account mismatch, malformed number, or unresolved number without creating a
  chat.
- [ ] New-chat permission is checked separately from ordinary send permission,
  and a missing grant returns a clear authorization error.
- [ ] A created one-to-one chat is tied to the requested account and cannot be
  routed through another account.
- [ ] Tests cover duplicate names, changed LID, stale contact ID, provider
  timeout, duplicate create response, and unauthorized candidate selection.
- [ ] Administrator and API responses expose the chosen account and provider
  evidence needed to audit recipient selection.

**Blocked by:** T09.

## T11: Group creation and automatic reconciliation

**Parent:** #11

**What to build.** Add explicit-account group creation with a requested name and
resolved participant IDs or phones. Require a distinct create-group grant,
persist the operation before provider I/O, and reconcile in this order: normal
provider response, provider event, then bounded group refresh. Match by account,
provider identifiers, participants, and operation correlation. A name alone
cannot identify the result. When the group is positively identified, grant its
creator read and send access while keeping create-group and manage-group
permissions separate. Apply each webhook subscription's inherited global and
account defaults to the new chat, without granting webhook-management access.
If evidence cannot identify the result, pause and present duplicate risk for
human resolution.

**Scope boundaries.** This ticket does not promise a provider idempotency key,
blindly retry group creation, rename groups, or manage participants. The four-
hour message confirmation rule does not automatically apply to group creation.

**Existing work reuse.** Reuse T10 contact resolution, T09 account routing,
T08 uncertainty and human-choice records, T01/T02 grant authority, T03
provider capability statuses, and the subscription registry contract from T13.
The pinned provisioning and group capability research remains conditional until
a controlled test proves the exact behavior. T13's generic inheritance rules
do not need to block this group operation.

**Acceptance.**

- [ ] The request requires an explicit account, resolved participants, valid
  name, and create-group grant; missing inputs cause no provider call.
- [ ] A normal response, matching event, and refresh can each identify the same
  group under the documented evidence rules.
- [ ] A delayed or ambiguous result performs bounded checks, never a blind create
  retry, and ends in a visible human decision state when unresolved.
- [ ] Positive identification grants the creator read/send access only to the
  new group and records the grant source.
- [ ] Each existing subscription evaluates its global/account defaults for the
  new group, while the creator receives no webhook-management grant as a side
  effect.
- [ ] Tests cover participant ambiguity, duplicate group names, delayed event,
  refresh timeout, mismatched account, revoked grant, and restart recovery.
- [ ] Administrator evidence shows the operation, evidence path, and any
  unresolved duplicate risk.

**Blocked by:** T10.

## T12: Group rename and membership changes

**Parent:** #11

**What to build.** Add account-bound group rename and participant add/remove
operations. Require a distinct manage-group permission, verify the current
group account and provider identifier, persist the requested operation and
correlation, then apply provider changes through the controlled adapter. Return
the resulting group revision and member identifiers. Reconcile delayed provider
events and refresh results without applying an event for another account or an
older operation. Preserve creator read/send access unless an explicit grant
revocation removes it.

**Scope boundaries.** This ticket does not create groups, resolve a phone into a
new contact, or change webhook settings. It does not claim that Matrix room
membership alone proves a WhatsApp membership change. Unsupported provider
operations return an explicit result.

**Existing work reuse.** Reuse T11's identified group record and reconciliation
correlation, T09 account routing, T01/T02 grant checks, T03 capability evidence,
and existing provider event ordering and audit concepts. #7 capability research
is reference material only.

**Acceptance.**

- [ ] Rename and add/remove each require manage-group authority in addition to
  account/chat access.
- [ ] Operations target the exact group account and provider ID and persist a
  stable operation ID before provider I/O.
- [ ] Duplicate responses and delayed events converge on one group revision;
  stale or wrong-account events are ignored and audited.
- [ ] Invalid participant, non-member removal, provider permission denial,
  timeout, and revoked grant leave no false success.
- [ ] Tests cover owner and non-owner behavior, duplicate events, refresh after
  timeout, concurrent membership changes, and account mismatch.
- [ ] The administrator UI shows operation status, provider evidence, and the
  current member revision.

**Blocked by:** T11.

## T13: Independent subscription configuration and inheritance

**Parent:** #11

**What to build.** Add first-class webhook subscription definitions and the API
and MCP operations to create, inspect, update, cut over, and revoke them. Each
subscription has an owner installation, optional logical agent, destination
credential version, event filter, status, and global/account/chat settings.
Evaluate the most specific setting within that subscription, with chat over
account over global. Keep read, send, and webhook-management grants distinct.
Allow a creator with current webhook-management authority to manage its own
subscription, and allow the owner or administrator to manage every
subscription. Record an ownership decision for shared client connections where
the host cannot prove a Bot identity.

**Scope boundaries.** This ticket defines subscriptions and permission rules.
It does not deliver an HTTP event, retry a failed delivery, or turn existing
realtime sockets into webhooks. Its inheritance registry must accept a new chat
from T11 after group creation, but does not grant webhook-management authority.

**Existing work reuse.** Reuse T02 OAuth installation identity, T01 grant and
revocation authority, audit records, and provider-neutral account/chat ownership.
Use the auth research decision record to keep connection-wide versus per-agent
ownership explicit rather than treating a caller-supplied Bot name as proof.

**Acceptance.**

- [ ] Authorized API and MCP callers can create and inspect subscriptions with
  stable IDs and destination versions.
- [ ] A subscription can set global, account, and chat rules; the most specific
  rule wins within that subscription only.
- [ ] A caller with read or send permission but no webhook-management grant is
  denied, and an OAuth scope cannot widen the local grant.
- [ ] Creator, shared-installation, owner, administrator, revoked, and deleted
  installation cases are explicit and audited.
- [ ] After T11 creates a group, the generic subscription registry evaluates its
  global/account defaults without adding webhook-management authority; this
  compatibility test can run after the group ticket while T13 remains
  independently usable.
- [ ] Destination update increments its version and marks old pending work for
  cancellation without changing another subscription.
- [ ] Tests cover two subscriptions with conflicting settings, account/chat
  inheritance, ownership transfer rules, and revocation races.

**Blocked by:** T02.

## T14: Post-storage incoming webhook delivery

**Parent:** #11

**What to build.** Fan out a newly saved eligible incoming message to active
subscriptions after the authoritative message save. Create one durable delivery
record per subscription and source event, with stable event and delivery IDs,
source revision, destination version, pending time, and current status. Exclude
imports, own messages, and duplicate sync events. Before the first HTTP call,
recheck subscription status, current account/chat grant, destination version,
tombstone state, and latest message revision. Hydrate current content only after
that check. Include text, sender, chat, timestamp, source IDs, revision, and
attachment metadata, with authenticated file references.

**Scope boundaries.** This ticket covers initial delivery and durable fan-out.
It does not add edit/removal events, 24-hour retry policy, destination cutover
behavior, or physical retention purge. A queue wakeup is not delivery evidence.

**Existing work reuse.** Reuse T03 stored incoming events, T13 subscription
definitions, T01/T02 grant resolution, transaction/outbox patterns, and T04
attachment authorization. Keep the product webhook ledger separate from
realtime ticket subscriptions and ingestion queue state.

**Acceptance.**

- [ ] One newly saved incoming message creates at most one pending delivery per
  eligible subscription, with stable IDs.
- [ ] Imports, own messages, duplicate sync events, disabled subscriptions,
  denied grants, and tombstoned messages create no content delivery.
- [ ] Two subscriptions receive independent payloads according to their own
  inheritance and event filters.
- [ ] An edit before the first call hydrates the latest allowed revision, while
  a removal cancels pending content without exposing the old body.
- [ ] Tests cover transaction retry, duplicate fan-out, attachment metadata,
  grant revocation immediately before send, and destination version mismatch.
- [ ] A failed HTTP attempt leaves a visible durable delivery state for T15.

**Blocked by:** T04 and T13. T03 is transitive through T04.

## T15: Independent retry, cutover, and manual retry

**Parent:** #11

**What to build.** Add independent webhook delivery retry state through the
24-hour deadline. Each subscription delivery stores first-pending time, retry
deadline, attempt count, next attempt, last response, destination version, and
terminal status. Retry with bounded backoff without resetting the original age.
After 24 hours, mark the delivery visibly failed. Destination cutover cancels
old-version pending rows and sends only future events to the new version. An
authorized owner or administrator can retry a failed delivery explicitly while
retaining event and delivery IDs. In-flight old-version results are recorded as
uncertain and are not sent again automatically.

**Scope boundaries.** This ticket does not change event eligibility, message
revision semantics, or deletion rules. Queue retry settings alone do not count
as the product guarantee. One subscription's endpoint failure must not pause
another subscription.

**Existing work reuse.** Reuse T14 delivery records, T13 destination ownership
and versioning, controllable clock, queue wakeups, audit records, and the
delivery research model. Treat queue/DLQ state as transport support for the
durable ledger, not its source of truth.

**Acceptance.**

- [ ] A failing subscription retries independently and its first-pending age
  remains fixed through restarts and backoff.
- [ ] A second healthy subscription delivers while the first fails.
- [ ] The 24-hour deadline produces visible failure; no retry silently extends
  it or loses the source/event IDs.
- [ ] Cutover cancels old pending rows, prevents old backlog replay, and routes
  future events to the new destination version.
- [ ] Manual retry is authorized, retains event and delivery IDs, and records
  the actor; duplicate receiver responses remain deduplicable.
- [ ] Tests cover timeout, 4xx/5xx, duplicate queue wakeup, clock boundary,
  cutover race, revocation immediately before send, and in-flight uncertainty.

**Blocked by:** T14.

## T16: Active deletion, expiry, and anti-resurrection

**Parent:** #11

**What to build.** Add a durable removal authority outside rebuildable message
projections. A delete or expiry records the resource, content generation,
account/chat scope, event/object keys, deletion time, and completion state before
redacting active message and attachment views. Search, context retrieval, file
access, and pending webhook work consult the removal authority. Keep a removal
tombstone and revision while suppressing deleted content. Add expiry scheduling
for the agreed active-view behavior and advance a deletion epoch that later
restore and dispatch work can check.

**Scope boundaries.** This ticket covers active stores, search/files, queued
webhook suppression, and the authority record. It does not physically purge
archives, backups, bridge databases, or media. It does not promise recall from a
provider or third-party destination. T17 owns post-delivery removal events.

**Existing work reuse.** Reuse T04 file authorization, T05 search filtering,
existing projection redaction and tombstone concepts, canonical event ordering,
T14 pending delivery records, and account/chat ownership. The retention
research's external removal ledger is the design reference.

**Acceptance.**

- [ ] Deletion and expiry write removal authority before active redaction or
  delivery cancellation, with an idempotent resource generation.
- [ ] Active reads, search, context, and file download hide content promptly
  while returning a stable removal marker where the contract permits.
- [ ] Pending webhook content is cancelled and a worker that sees a new removal
  epoch cannot send the deleted body.
- [ ] A stale projection replay cannot clear the removal marker or restore the
  body during normal operation.
- [ ] Tests cover duplicate delete, expiry scheduling, race with search/file
  read, race with webhook send, revision mismatch, and cross-account access.
- [ ] Administrator status exposes incomplete removal work without claiming
  physical purge completion.

**Blocked by:** T05 and T14. T04 is transitive through T14.

## T17: Edit and removal webhook revisions

**Parent:** #11

**What to build.** Extend T14/T15 for edits after initial webhook delivery and
for removals. An edit creates a separate revision event with stable source and
subscription delivery identifiers, after current grants and subscription rules
are evaluated. A removal suppresses content, cancels pending deliveries, and
creates a content-free removal event only for a destination that already
received the message, under its current settings and grants. Do not resurrect a
disabled subscription or replay a backlog after an edit, cutover, or revocation.

**Scope boundaries.** This ticket does not alter active redaction authority,
physical purge, retry age, or provider-side recall. Attachment removal events
carry metadata needed to identify the file without including its bytes or
provider token.

**Existing work reuse.** Reuse T14 delivery fan-out, T15 destination version and
retry ledger, T16 removal authority/tombstones, T04 attachment metadata, and
projection message revisions. Use the specification's current-content-before-
first-delivery rule and content-free removal rule as the contract.

**Acceptance.**

- [ ] An edit before first delivery results in only the latest allowed revision
  in the initial payload.
- [ ] An edit after delivery creates a separate revision event with stable
  source message/event IDs and a new subscription delivery ID.
- [ ] A deletion cancels pending content, emits no body or attachment bytes,
  and sends a removal event only to a previously notified eligible receiver.
- [ ] Current grant, chat setting, destination version, and tombstone checks run
  before each revision or removal call.
- [ ] Tests cover edit bursts, edit/delete ordering, duplicate revision event,
  cutover, revocation, disabled chat override, and in-flight deletion.
- [ ] Receiver payload tests prove stable IDs and no stale content leak.

**Blocked by:** T16. T14 is transitive through T16.

## T18: Explicit mark-read receipts

**Parent:** #11

**What to build.** Add an explicit mark-read action for an authorized agent. The
action names the account, chat, and message or receipt position, checks a
separate read/receipt permission immediately before provider I/O, records the
requested and observed stages, and returns a stable operation ID. Stored reads,
search, attachment reads, and webhook delivery never invoke this action. A
provider that cannot prove a receipt response returns conditional or unverified
evidence rather than a false success.

**Scope boundaries.** This ticket covers explicit receipt requests and evidence.
It does not mark messages read as a side effect, claim that Matrix receipt
acceptance means WhatsApp receipt acceptance, or add automatic read behavior to
clients or webhooks.

**Existing work reuse.** Reuse T09 account/session routing, T01/T02 grant and
revocation checks, T03 provider capability status, existing receipt records and
audit concepts, and the provider adapter. The WhatsApp receipt capability
research is evidence to verify, not a completed live proof.

**Acceptance.**

- [ ] A caller with explicit receipt authority can request a mark-read on the
  owning account and exact chat, with a durable operation ID.
- [ ] A stored read or webhook delivery leaves receipt state unchanged.
- [ ] Wrong account/chat, revoked grant, stale message, unsupported provider,
  timeout, and duplicate request produce explicit results without false success.
- [ ] Matrix, bridge, and provider receipt observations remain separate, with
  provider evidence marked unverified until the controlled test passes.
- [ ] Tests cover authorization immediately before I/O, duplicate operation,
  provider rejection, late response, and account mismatch.
- [ ] The administrator view distinguishes requested, accepted, observed, and
  unknown receipt states.

**Blocked by:** T09.

## T19: Archive purge and mixed-batch preservation

**Parent:** #11

**What to build.** Implement the archive side of the removal authority. Locate
controlled archive objects and manifests containing removed or expired content,
rewrite them into sanitized batches or segment them into purgeable units, and
preserve unrelated retained records. Record lineage, replacement hashes, object
deletion state, and completion evidence. Coordinate direct deletion and
eventual-lifecycle behavior with a safety window. A batch that cannot be safely
rewritten or segmented must remain explicitly incomplete and block a claim of
retention completion.

**Scope boundaries.** This ticket covers canonical archive objects and their
manifests. It does not purge Synapse, bridge databases, media, or restic
backups, and it does not weaken the existing archive validation contract without
recording new lineage rules. External copies and already delivered messages are
outside direct control.

**Existing work reuse.** Reuse T16 removal generations and deletion epochs,
archive writer/reader validation concepts, canonical event ranges, manifest
hashes, and retention research Option B. Preserve unrelated retained records in
mixed batches; do not solve this by deleting an entire tenant archive.

**Acceptance.**

- [ ] A mixed archive batch containing removed and retained records produces a
  sanitized replacement or an explicit segmented purge unit.
- [ ] Retained records replay with their original identity and order, while the
  removed body and attachment references no longer appear in the purgeable
  archive unit.
- [ ] Replacement lineage, hashes, event ranges, and deletion completion are
  durable and auditable.
- [ ] A locked, missing, malformed, or unrewritable object remains incomplete;
  the system does not report a false 30-day guarantee.
- [ ] Tests cover one-record, mixed-batch, duplicate purge, crash after
  replacement, lifecycle delay, and replay of the sanitized archive.
- [ ] No unrelated tenant or account archive data is deleted.

**Blocked by:** T16.

## T20: Controlled-copy retention ceiling

**Parent:** #11

**What to build.** Apply the removal authority and hard 30-day ceiling to
controlled recoverable copies outside the canonical archive. Inventory and
purge or age out message content and attachment copies in projection backups,
Synapse, bridge databases, media stores, queues, and restic snapshots where
Communicator controls the copy. Give each copy a retention deadline, cleanup
margin, completion state, and evidence source. Remove or quarantine content
according to the store's real semantics, and report unknown behavior as an
incomplete retention result.

**Scope boundaries.** This ticket does not restore data, implement anti-
resurrection startup ordering, or delete external receiver/provider copies. It
does not treat a 14-day queue setting or R2 lifecycle as proof that all other
copies expire. Session credentials and account keys need separate lifecycle
handling and must not be removed accidentally with message data.

**Existing work reuse.** Reuse T16 removal ledger and epochs, backup/restore
inventory concepts, and the retention
research's per-store constraints. Existing backup scripts and runbooks are
starting boundaries, not evidence of a finished deletion policy.

**Acceptance.**

- [ ] Every controlled recoverable copy has an owner, content class, deletion
  method, deadline no later than 30 days, cleanup margin, and visible status.
- [ ] A removal request produces per-store purge or expiry work linked to the
  same resource generation and deletion epoch.
- [ ] Copy-specific failure, missing permission, lifecycle lag, or unknown
  provider behavior leaves the result incomplete and pages the administrator
  view without weakening the stated ceiling.
- [ ] Tests cover backup age boundary, duplicate worker, media reference,
  bridge mapping, queue item, restic snapshot, and session-key separation.
- [ ] The system proves completion before the deadline in a controllable-clock
  test or reports the specific missing evidence.
- [ ] No external delivered message or third-party cache is described as purged.

**Blocked by:** T16.

## T21: Safe restore and stale-work rejection

**Parent:** #11

**What to build.** Add a restore gate that loads removal authority and deletion
epochs before a projection, archive replay, bridge service, or message service
becomes readable. Filter pre-removal records, reapply tombstones, and reject
stale outgoing commands, webhook deliveries, and file pointers that cross a
removal epoch. Reconcile T07/T08 command states and T15 delivery states during
restore without resetting original ages or retry deadlines. Make mixed-batch
archive replacements from T19 and controlled-copy status from T20 part of the
restore report.

**Scope boundaries.** This ticket covers restore ordering and stale-work gates.
It does not create a new backup system, physically purge a store, or claim that
an external destination can be recalled. A restore that cannot prove removal
application remains blocked or explicitly incomplete.

**Existing work reuse.** Reuse T16 removal authority, T19 archive lineage, T20
copy statuses, T07 immutable command age, T08 uncertain command records, T15
delivery IDs and deadlines, and existing isolated restore validation concepts.
The migration handoff's preserved receive-side history remains regression input;
it is not rewritten by this ticket.

**Acceptance.**

- [ ] Restore loads removal records before projection or service startup and
  filters all pre-removal content from active reads and files.
- [ ] A stale archive replay, command, webhook delivery, or attachment pointer
  cannot resurrect or send removed content.
- [ ] Retained records from mixed archive replacements restore with identity,
  order, and revision intact.
- [ ] Waiting commands retain original four-hour age; uncertain commands retain
  pause and human-resolution state; webhook deadlines and IDs remain stable.
- [ ] Tests inject restore crashes before and after each gate, stale pointers,
  missing removal ledger, duplicate tombstone, and partial store availability.
- [ ] An unverifiable store blocks completion and reports the exact store and
  generation at issue.

**Blocked by:** T19, T20, T07, T08, and T15.

## T25: Relink and explicit WhatsApp disconnect

**Parent:** #11

**What to build.** Add administrator-only same-identity relink and explicit
disconnect, integrated with the durable send ledger and the pinned WhatsApp
bridge relink/disconnect adapter path. A verified same-identity relink reuses
the account, stored history, chats, grants, and immutable send route while
replacing the active session. A different identity creates a new account with
no history, route, or grant transfer. Disconnect revokes pairing, blocks new
provider dispatch, and retains records. An in-flight call keeps its actual
Matrix, bridge, and provider evidence; Communicator makes no recall promise.
Stale pairing callbacks cannot attach an account. Unavailable sends follow
T07; relink cannot reset age, bypass four-hour confirmation, or resolve a T08
uncertain send.

**Scope boundaries.** This ticket does not delete history, reassign chats or
commands, grant agents, or claim provider delivery. It covers the administrator
UI, backend lifecycle, and adapter behavior that distinguish an unavailable
account from an explicit disconnect. Controlled tests are required, but the
pinned bridge relink and disconnect contract must be verified for completion;
unknown API behavior blocks completion and is escalated.

**Existing work reuse.** Reuse T24 identity verification and pairing
generation, T01 grants and audit, T06 account-owned commands, and T07/T08
clock, confirmation, uncertainty, and lease rules. Keep #9 unchanged.

**Acceptance.**

- [ ] Same-identity relink preserves account, chat, history, grant, and
  immutable send-route identifiers while recording the new session.
- [ ] A different identity creates a separate ungranted account; history,
  chats, grants, and queued routes cannot transfer or merge.
- [ ] Disconnect revokes pairing, blocks new provider dispatch, preserves
  records, and records an audit action; in-flight calls retain actual evidence.
- [ ] Cancellation or revocation invalidates stale pairing callbacks; a late
  success cannot reactivate an account or create a duplicate identity.
- [ ] A temporarily unavailable send remains in T07 waiting; disconnect starts
  no new call, and an in-flight result cannot start another dispatch.
- [ ] Relink keeps the saved age; after four hours it requires existing
  confirmation, and a T08 uncertain command stays uncertain with no auto-resend.
- [ ] API/MCP agents cannot relink or disconnect, and no relink path creates or
  expands an agent grant.
- [ ] Controlled tests cover identities, duplicate pairing, callback races,
  unavailable versus disconnected state, in-flight evidence, and audit; the
  pinned bridge relink/disconnect adapter contract is verified or blocked with
  an explicit escalation.

**Blocked by:** T24, T07, and T08.

## T22: ChatGPT Work acceptance

**Parent:** #11

**What to build.** Run the first end-to-end client acceptance against the live
Communicator backend through the documented ChatGPT Work OAuth/MCP connector,
starting with an unlinked administrator state. Use the administrator UI to
link an approved sacrificial WhatsApp account, then prove same-identity relink,
explicit disconnect, and a different-identity account before recording
secret-free evidence for stored history and context, attachment read, text
reply, new one-to-one chat, group create/rename/member changes, webhook
configuration and receiver behavior, explicit read receipt, deletion/removal,
and restore-safe state. Verify API/MCP authority and administrator grant
boundaries through the same flow. Record exact client, provider, version, and
capability evidence.

**Scope boundaries.** This is a proof and acceptance ticket, not a client-
specific product fork. It does not promise wake-up behavior outside observed
ChatGPT Work surfaces, add provider capabilities that failed proof, or run
unapproved real messages. It does not replace automated contract tests from
T01-T21, T24, and T25.

**Existing work reuse.** Reuse T12 group operations, T17 revisions/removals,
T18 receipts, T21 restore gates, T24/T25 linking lifecycle, T02 OAuth MCP,
T04/T05 read paths, T09 send evidence, and existing #8 proof planning. Record
a failed or unsupported proof
as a product escalation with the evidence, not as a pass.

**Acceptance.**

- [ ] From the initially unlinked state, the administrator links the first
  account, verifies its identity, grants it through T01, relinks that identity
  without changing stored IDs, disconnects it without deleting history, and
  proves a different identity needs a separate account and grant.
- [ ] ChatGPT Work completes the documented OAuth/MCP connection and reads only
  administrator-granted accounts and chats.
- [ ] The proof reads stored history/context and an authenticated attachment,
  sends text with separate delivery evidence, and proves no silent account
  failover.
- [ ] The proof resolves a new one-to-one recipient, creates and manages a
  group, and records provider evidence for each operation.
- [ ] The proof configures two subscription cases and verifies initial,
  revision/removal, retry, cutover, and receiver ID behavior.
- [ ] The proof requests an explicit read receipt and verifies its result class,
  then verifies active removal and restore anti-resurrection evidence.
- [ ] All failures include the client surface, provider version, evidence, and
  whether the result is unsupported, unverified, or an implementation defect.

**Blocked by:** T12, T17, T18, T21, and T25. These are the minimum direct gates for
the full acceptance; earlier prerequisites are transitive.

## T23: Grok connector proof

**Parent:** #11

**What to build.** Prove core stored read and text-send behavior through each
supported Grok web, mobile, and Bot connector surface that can reach the
documented remote MCP server. Verify OAuth/resource binding, account/chat grant
enforcement, account-owned routing, saved-before-dispatch state, and the
observed WhatsApp provider evidence from T09. For shared Grok Bots, record the
authenticated member/installation as the actor and make connection-wide
ownership explicit if the host cannot prove Bot identity. Capture surface-
specific connector limits and client wake-up behavior.

**Scope boundaries.** This ticket proves core read/send connector behavior. It
does not make per-Bot identity claims the host cannot prove, add a separate
credential product, or require the full ChatGPT acceptance sequence. A surface
that cannot meet the OAuth/MCP contract is an explicit unsupported result.

**Existing work reuse.** Reuse T02 remote MCP authority, T09 WhatsApp text
dispatch and evidence, the agent-auth research on xAI Bot identity, and the
ChatGPT proof format where useful. Existing #7 capability research is a
reference, not a claim that Grok works.

**Acceptance.**

- [ ] Each supported Grok surface tested can authenticate to MCP and read only
  its administrator-granted account/chat scope.
- [ ] Each passing surface can submit text, observe durable saved/dispatch
  state, and distinguish provider evidence from acceptance.
- [ ] Wrong resource, expired/revoked installation, missing grant, and account
  mismatch fail with the documented authorization result.
- [ ] Shared Bot behavior records the signed-in member/installation and does not
  invent per-Bot subscription ownership or permissions.
- [ ] Tests or controlled proof cover duplicate request, timeout/uncertainty,
  reconnect, and provider rejection where the connector permits them.
- [ ] The final evidence names the exact Grok surface and records unsupported
  or unverified results without widening the product promise.

**Blocked by:** T09. T02 is transitive through T09. T22 is a scheduling priority, not a technical
prerequisite for this proof.
