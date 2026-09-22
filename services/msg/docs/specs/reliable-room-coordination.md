# Reliable room access and shared coordination state

## Problem Statement

People and agents using msg for ongoing coordination must reconstruct what is currently true and what happens next from long room transcripts. Requests, corrections, proposals, approvals, and implementation updates are mixed together. A partial reply can look complete, a superseded proposal can look current, and an agent recommendation can look like participant agreement.

A user-supplied account of sustained use also reports a transcript exceeding an agent tool's output limit, repetitive requests for listening permission, contradictory service instructions, and conversational keepalive messages used solely to prevent expiration. These are reported experiences, not a live-production audit.

The inspected workspace already implements incremental reads using `after`, stored message IDs and sequences, POST receipts with timestamps, retry identifiers, `reply_to`, cursor-based WebSocket waiting with an optional CLI timeout, expiration metadata, and JSON/Markdown export. The problem is therefore partly incomplete contracts and discoverability, rather than the absence of all these capabilities. The workspace contains ongoing changes; implementation must recheck this baseline before changing it.

## Solution

Deliver both reliable conversation access and structured coordination in staged increments. People and agents can read a bounded portion of a room, verify a cited message, post with a dependable receipt, and resume waiting without losing their place. Instructions respect the agent's existing user authorization and clearly distinguish protocol documentation from participant requests.

Add explicit tracked requests and a compact, versioned state panel showing purpose, phase, accepted-decision records, open questions, canonical documents, corrections, and next actions. Every substantive state claim retains its source and revision history. An agent-generated suggestion cannot silently become an accepted decision. The interface distinguishes reported approvals from authenticated identity and never infers acceptance from silence.

Make retention visible and extendable through owner authority without posting a message. Export the full coordination record alongside messages. Rooms remain temporary in this release; structured state shares the room's lifecycle.

## User Stories

1. As a user inspecting msg, I want agents to read documentation without creating a room, so that inspection has no unintended side effects.
2. As a participant, I want an agent to reuse a supplied room, so that collaboration stays in the right conversation.
3. As an agent, I want a clear transport preference and supported fallbacks, so that instructions do not contradict one another.
4. As an agent, I want protocol documentation separated from participant content and subordinate to host and user instructions, so that authority is clear.
5. As a participant, I want agents to consider my messages within their user's authorized task, so that useful collaboration remains possible.
6. As a user, I want previously granted listening authorization respected within its scope, so that agents do not repeatedly ask the same permission question.
7. As a new participant, I want a complete invitation explaining how to join, so that I can start successfully.
8. As a returning participant, I want concise room links and delivery confirmations, so that repeated onboarding does not obscure the conversation.
9. As an agent, I want to retrieve only messages after my saved cursor, so that checking for updates is inexpensive.
10. As an agent, I want bounded pages and explicit continuation metadata, so that I can detect incomplete history.
11. As an agent, I want a stable snapshot boundary while paging, so that concurrent messages do not make my read ambiguous.
12. As a participant, I want to retrieve one cited message or a bounded sequence range, so that I can verify a claim directly.
13. As an agent, I want empty reads to preserve a usable cursor, so that I can resume safely.
14. As a sender, I want a receipt containing the stored message ID, sequence, and timestamp, so that I can confirm delivery without rereading the room.
15. As a sender, I want retries to return the original receipt, so that uncertain network outcomes do not create duplicate messages.
16. As a participant, I want replies linked to the request or message they answer, so that their context is clear.
17. As an agent drafting a reply, I want to detect messages arriving since my last read before my reply is stored, so that I can review changed context.
18. As an agent, I want waiting to end with an event or an explicit timeout and resume cursor, so that bounded tasks can continue reliably.
19. As a participant, I want a compact overview separate from the full transcript, so that I can understand the room quickly.
20. As a participant, I want the room's purpose and current phase visible, so that I understand the work underway.
21. As a requester, I want a request ID, owner, requested output, unknowns, and completion criteria, so that another participant can act without reconstructing my intent.
22. As a request owner, I want open, in-progress, blocked, done, and withdrawn statuses, so that others can see progress.
23. As a request owner, I want to retrieve requests assigned to my stated participant label, so that I can find work awaiting me without claiming that the label proves identity.
24. As a requester, I want completion evidence and unresolved blockers recorded, so that a claim of completion can be checked.
25. As a participant, I want requests to state their decision impact, so that providing information is not mistaken for approving a proposal.
26. As a participant, I want recommendations, reported positions, explicit approvals, and accepted-decision records displayed distinctly, so that evidence is not overstated.
27. As a participant, I want approval tied to an exact proposal revision, so that agreement in principle does not approve later details.
28. As a participant, I want disputed accounts attributed to their sources, so that the state panel does not present one account as undisputed truth.
29. As a participant, I want corrections to identify the earlier claim they correct, so that I can follow changes without losing history.
30. As a participant, I want superseded proposals retained and visibly marked, so that obsolete terms do not appear current.
31. As a participant, I want canonical document links and their stated roles, so that I know which artifact controls which part of the work.
32. As a participant, I want the next action and its owner visible, so that coordination can continue.
33. As a room owner, I want to review proposed state changes and their supporting messages before publishing them, so that generated summaries do not become authority automatically.
34. As a participant, I want state revisions and confirmation provenance available, so that I can audit how the overview changed.
35. As a concurrent editor, I want stale state updates rejected, so that I do not overwrite newer work.
36. As a room owner, I want the temporary retention policy and expiry visible when people join, so that nobody assumes indefinite storage.
37. As a room owner, I want to extend retention without a conversational message, so that maintenance does not become unread activity.
38. As a participant, I want exports to include messages, requests, decisions, evidence references, and state history, so that coordination can be preserved outside the room.
39. As a participant, I want unavailable or expired evidence represented honestly, so that missing information is not silently treated as confirmation.
40. As an existing client user, I want compatible access to my existing rooms during rollout, so that these improvements do not interrupt conversations.

## Implementation Decisions

These decisions define the proposed implementation, not claims about deployed behavior.

### Delivery and boundaries

- Stage 1: correct instructions and finish reliable reading, receipts, reply validation, and bounded wait contracts. Stage 2: tracked requests and compact overview. Stage 3: reviewable decision state, corrections, canonical documents, and state-panel editing. Stage 4: retention extension and complete coordination exports. Each stage must leave the room usable independently.
- Extend the existing Worker routing, room service, ConversationRoom Durable Object, protocol representations, CLI, and browser interface. Keep room messages and coordination state together in the room's persistence and transaction boundary. D1 operations metadata must not become a second store of conversation content.
- Do not add a runtime dependency on Brain, Streams, Database, or Platform as part of this spec. Shared identity architecture remains a separate integration decision; this release must not invent participant credentials or a competing identity issuer. Current account-free room semantics and `identity_verified: false` remain explicit.
- Preserve the accepted opt-in GET posting ADR: public reads remain non-mutating; delegated GET posting stays separately enabled and revocable with its existing retry namespace. Do not extend that capability to management or state publication.

### Instructions and representation

- Create a room only for an authorized new conversation; reuse supplied rooms. Prefer HTTP or CLI for agents, document the existing delegated GET option for fetch-only agents, and permit the ordinary browser form as a fallback when the host supports it and user authorization covers the action. Remove categorical browser prohibitions that contradict supported behavior.
- Describe service instructions as protocol documentation, subordinate to host and user instructions. Treat participant messages as external requests and evidence actionable only within the agent's granted task and authority.
- Listening requires user authorization, but existing authorization within the active task satisfies that requirement. Do not remove the consent requirement or interpret it as a mandatory fresh question on every wait. Preserve existing protocol fields while clarifying their meaning.
- Retain complete invitations for new handoffs; allow concise room links and receipts during ongoing work. Teach attribution, exact-revision approval, correction references, and the prohibition on treating silence as acceptance.

### Read, post, and wait contracts

- Extend the existing incremental read contract with an explicit bounded mode: `after` is exclusive, `limit` defaults to 20 and is capped at 100, and `through` is an inclusive snapshot boundary. On the first page, capture `through` from the room's current latest message sequence. Return `next_after`, `has_more`, `through`, and `latest_message`. Reject malformed, negative, reversed, or future bounds; permit `after=0` for the beginning of the room.
- Page in ascending sequence order and impose a serialized-message budget of 128 KiB in addition to the count limit. A valid existing message larger than that budget may occupy a page alone, clearly identified as oversized; it must never be silently omitted. `next_after` is the last returned sequence, or the input cursor on an empty page. `has_more` concerns messages remaining within `through`, not later arrivals.
- Offer bounded mode explicitly under protocol version 1 and move updated CLI and agent-facing clients to it. Preserve the legacy unbounded response contract for existing clients until a separately documented protocol migration; never silently cap a legacy response that cannot communicate continuation. CLI output shows page status and does not automatically print the entire history.
- Provide room-scoped single-message lookup by stored ID and bounded sequence-range reads using the same pagination rules. Cross-room and nonexistent references produce a not-found result without revealing other rooms. The implementation may choose route spelling within existing routing conventions; the semantics above are required.
- Preserve `reply_to` as the canonical reply field rather than adding a synonymous `in_reply_to`. Validate new references against the same room. Preserve legacy stored values without claiming they were validated retrospectively.
- Preserve existing POST receipts and retry behavior; make ID, sequence, timestamp, and replay status consistently available to the CLI and delegated GET receipt. Same retry identifier and same logical payload return the original stored receipt; changed payload conflicts.
- Add optional `based_on_sequence` as an opt-in atomic precondition for message posting. If the room has advanced, return a conflict with the current latest sequence and a review cursor without storing the message or consuming the retry identifier. Clients read the intervening messages and explicitly resubmit against the new sequence. Clients omitting the field retain existing posting behavior. Resolve a successful idempotent replay before checking this precondition so a network retry still succeeds after later messages arrive.
- Give CLI waits a finite default timeout of 60 seconds and allow an explicit positive override up to 5 minutes. Return structured event or timeout results with a resume cursor; distinguish timeout from transport failure. A timeout never advances past undelivered messages. Preserve WebSocket reconnect and read-before-subscribe recovery behavior and ensure page continuation cannot skip messages.

### Requests and shared state

- Store requests with stable room-local IDs, source message references, title or purpose, owner label, requested output, explicit unknowns, completion criteria, decision impact, status, blockers, and completion evidence. Artifact evidence includes URL, affected tab/range or equivalent location when relevant, verification result, and who reported it. The service records evidence; it does not claim to have verified an external document.
- Request status is one of open, in progress, blocked, done, or withdrawn. A done report requires completion evidence or an explicit explanation that completion is self-reported and unverified. Preserve status history; reopening done or withdrawn work requires a reason. Ownership filters are label-based convenience filters, not authenticated inboxes.
- The overview contains purpose, phase, published state revision, pending request counts and bounded request summaries, decision summaries, canonical artifact references and their roles, corrections/supersession links, next actions, latest message sequence, and expiry. Each collection is bounded and exposes continuation or a detail link. It never embeds an unbounded transcript or revision history. Empty coordination state is shown explicitly rather than invented from chat.
- Public room participants may submit attributed state-change proposals and request-progress reports using existing room participation authority. These remain visibly proposed or reported. The management capability publishes canonical panel changes, including canonical request status. This is an explicit initial authority model for an account-free room, not proof of any participant's identity or agreement.
- Each proposal and revision records the submitting label, authority class, source message IDs, base state revision, and timestamp. Management capability values are never stored in public history. Publish updates atomically only when the submitted base revision matches; otherwise return a conflict and current revision. Require retry identifiers for structured mutations and preserve replay semantics.
- Model a recommendation, reported position, explicit approval record, and accepted-decision record separately. A decision proposal identifies the exact revision and required approving participant labels. Acceptance publication requires explicit supporting approval-message references for every required label, an unchanged proposal revision, and an owner attestation that those messages approve that revision. Empty required-approver sets cannot produce accepted decisions. Display this as owner-recorded acceptance backed by participant messages whose identity is not authenticated; do not imply authenticated consent.
- An owner cannot manufacture participant approval by publishing a summary. The interface requires the evidence and attestation above and shows the original approval text and identity limitation. Unverifiable claims remain reported positions. Silence, an agent recommendation, a historical account, or completing an information request is insufficient acceptance evidence.
- A new substantive proposal revision invalidates its earlier approval association. Retain original accepted records and link later decisions that supersede them. A correction references the exact earlier message or state claim, retains its attribution, and does not erase the earlier account. Record disputes and withdrawal of reported approval as new evidence and mark the affected decision contested until reviewed; preserve the historical acceptance record.
- The browser panel and HTTP/CLI representations expose the same revision and provenance. Cache validators for representations containing state or expiry must change when those values change, even when message sequence is unchanged. Reading a room does not trigger automatic summarization. Agents may propose summaries through the same review path; there is no background LLM or autonomous acceptance engine in this release.
- Apply room byte limits, mutation rate limits, same-room reference validation, and lifecycle deletion to requests, proposals, and revision history. If capacity is exhausted, reject mutations explicitly rather than pruning evidence silently. State publication does not create a chat message or increment the message sequence; expose state revision independently. Do not silently broaden existing message-only notifications to every coordination edit.

### Retention and export

- Joining exposes retention mode `temporary`, current expiry, and the policy governing extension. Structured state is not advertised as durable merely because it is versioned.
- Add an idempotent management-authorized extension action with an absolute requested expiry. Accept an expiry no earlier than the current expiry and no later than the greater of current expiry and now plus the configured room inactivity window. Replaying an extension must not extend it again. Reject expired or deleted rooms; extension does not resurrect them.
- Record extension metadata separately from messages. It does not increment message sequence, count as unread chat, or send a new-message WebSocket/webhook/push notification. State and messages expire together under the existing deletion lifecycle.
- Extend JSON and Markdown export with requests, published state, proposals, revisions, acceptance evidence, correction/supersession links, canonical artifact references, and retention metadata. Export captures an explicit message and state snapshot boundary. Stream or page the export so size cannot silently omit records. Exclude management and delegated posting capabilities, authorization data, and internal operational secrets.

## Testing Decisions

- Prefer the existing Worker HTTP/WebSocket integration seam backed by the Miniflare ConversationRoom fixture. It exercises routing, protocol representations, persistence, capability checks, and live delivery together. Existing room creation/post/read, retry, expiry, export, and delegated GET tests provide prior art. Avoid creating parallel mocked acceptance suites for each internal helper.
- Test externally observable behavior: what a client can read, post, resume, review, publish, and export. Do not assert private SQL layout or implementation call order.
- Cover multi-page reads, byte limits, zero and empty cursors, concurrent arrivals during paging, exact message lookup, invalid bounds, same-room reference checks, legacy-client compatibility, and continuation without gaps or duplicates.
- Cover original receipts after ambiguous-network retries, changed-payload retry conflicts, stale `based_on_sequence` rejection with no stored message, and successful replay after the room has advanced. Preserve delegated GET disable/rotate and idempotency regression coverage.
- Exercise requests from creation through blocked, done, withdrawn, and reopened states; verify evidence, ownership filters, decision-impact text, and pending versus published state. Verify stale revisions cannot overwrite newer state, retries do not duplicate revisions, and state persists across room runtime restart.
- Test that recommendations, silence, incomplete approvals, superseded proposal approvals, and owner summaries alone cannot publish accepted-decision records. Verify exact-revision evidence, the visible identity limitation, correction attribution, disputes, and preserved history through public reads and export.
- Prove retention extension requires management authority, is idempotent, cannot resurrect an expired room, and causes no message, unread increment, or new-message delivery. Verify coordination evidence is deleted with its room and secrets never appear in exports or public state.
- Use existing CLI command tests for pagination presentation, receipt parsing, authorization wording, finite timeout, transport errors, reconnects, and cursor preservation. Use existing browser view/controller tests for the pinned panel, pending/published distinctions, evidence navigation, and conflict presentation. These are focused client seams for behavior the Worker tests cannot observe.
- No new full-browser end-to-end harness is required. Use the existing integration and client seams above.
- During implementation run `bun run check` from the msg service before handoff. Root workspace checks are required only if workspace integration changes. Production deployment is not part of validation for this spec.

## Out of Scope

- An MCP server, background agent orchestration, automatic task execution, or autonomous negotiation.
- Authenticated participant identity, new credentials, legal-signature claims, or a new account/login system. Recorded approval remains explicitly limited by the current identity model.
- Automatic extraction of authoritative state from legacy transcripts. Existing rooms begin with empty structured state and may receive reviewed proposals referencing their existing messages.
- Editing external spreadsheets/documents or verifying their contents automatically. msg records links and attributed completion evidence.
- Indefinite durable-room storage, new retention tiers, billing, or automatic retention extension. This release makes temporary retention explicit and removes the need for conversational keepalives.
- Rebuilding the separate room-notification feature. This spec preserves message-notification semantics and specifies that retention maintenance must not generate new-message events.
- Changing the old source repository, deployment workflow, production route, production cutover, or the service family's dependency architecture.

## Further Notes

The user authorized both reliable conversation infrastructure and structured coordination after reviewing the agent's feedback. This spec deliberately ships reliable access first, then requests and reviewable decision state, rather than requiring a large orchestration system.

The agent's negotiation examples motivate provenance and correction behavior; they are not data to import into another room. No real participant's financial details or disputed account is included here.

The current local service is a migrated, account-free temporary relay. Controller architecture documents describe a broader shared-identity direction and contain older repository-layout descriptions. This spec preserves the service's inspected behavior and records the identity limitation rather than treating the broader direction as an implemented msg integration.

Implementation should recheck in-flight room-notification and delegated GET changes before editing shared protocol surfaces. Existing functionality listed in the baseline must be extended and tested, not recreated under duplicate APIs.
