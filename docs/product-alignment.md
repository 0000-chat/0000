# Product alignment interview

**Status:** Shared understanding confirmed on 2026-09-13. Implementation remains paused by explicit user instruction.

## Current agreed scope

This is the confirmed product boundary. The technical verification and architecture questions below remain open; they are not implied to be solved by this scope.

- **Purpose and clients:** Communicator is an agent-first service for the user's own conversations. The UI is secondary for administration and debugging. WhatsApp is first, with later providers; ChatGPT Work is the first proof client, followed by Grok web/mobile/Bot wherever supported. Future autonomous-agent behavior is not authorized by this scope.
- **Access and authority:** One authenticated API and one remote MCP interface expose the same messaging operations and permission grants, with ChatGPT plugin packages connecting through MCP. Only the user administrator UI grants or expands agent permissions. Agents can inspect or request permissions but cannot self-grant or grant others. Grants are explicit per connected account and cover all current/future chats or selected chats; newly connected accounts are never exposed automatically. Clients without a verified Bot identity use shared connection permissions; distinct permission sets require separately verifiably isolated connections.
- **Accounts, chats, and messages:** There is no hard product account cap; the pilot initially connects two or three WhatsApp accounts without promising infinite capacity. Chats, contacts, and permissions stay tied to their connected account. Replies use the chat-owning account; new conversations and group creation require an explicit `connectedAccountID` with no silent failover. Contact search returns stable IDs, explicit phone sending is supported, and ambiguous matches are never guessed. Group creation, rename, participant add/remove where provider permissions permit, and manage-group permission are in the pilot, with the group creator receiving automatic read/send access.
- **Read, send, and history:** The application reads stored durable-object messages and saves outgoing messages before bridge dispatch; saving is not successful provider delivery. Text sending is initial; text, images, documents, and voice notes are readable, with transcription and interpretation handled by the connected agent. History imports reach as far back as provider availability allows without a 30-day product cap; recent messages remain available during background import with progress and known gaps. Search supports text, contact, chat, date, and direction filters and returns IDs for context retrieval. Stored reads do not create provider read receipts; marking read is explicit. Edits update content in agent-facing history; deletions and expiry show removal markers instead of stale content, with backups capped at 30 days and removal records reapplied before restore. The separate four-hour outgoing confirmation window remains as recorded at Q35.
- **Webhook subscriptions:** Multiple independent webhook subscriptions are required. Global, account, and chat settings are evaluated within each subscription, with the most specific setting winning; a chat override does not suppress other subscriptions. Each subscription has independent delivery status and retries, and one failure does not block others. Agents manage subscriptions they created within their permissions where creator ownership is verifiable; otherwise connection grants govern, and the owner/admin can manage all. Initial notifications are only newly received incoming messages after save, excluding historical imports, own messages, and duplicate sync events. Initial delivery carries latest content and its revision; edits after delivery are separate events, and removed content is suppressed. Edits/removals for previously notified messages follow current destination settings and permissions. Destinations carry the agreed message fields, IDs, and attachment metadata; attachment files use an authenticated file API. Destination changes do not forward backlog/history, and revocation blocks unauthorized reads, dispatch, queued sends, and deliveries.
- **Pilot status:** The pilot plan is accepted for alignment purposes only; real messages are not authorized to run while implementation remains paused.

## Agreed direction

**Q1 — Who is Communicator for?**

Personal own-conversations first.

**Q2 — What is the initial product shape?**

A unified inbox for reading and replying across messaging providers, with WhatsApp first and later providers to follow.

**Q3 — What is the precise current requirement?**

> today, just the ability to read and send messages in the durable object database as opposed to directly in mautrix. And optionally webhook events when new messages are received, toggle-able for all messages, or on a per-chat basis

**Q4 — What is the agreed message storage and dispatch behavior?**

The application reads stored messages from the durable object database and saves an outgoing message before bridge dispatch. Saving an outgoing message does not mean that it was successfully sent.

This does not settle removal of the existing R2 archive or the rebuildability and source-of-truth architecture.

**Q5 — What is the agreed webhook toggle behavior?**

There is a global webhook default. Each chat can inherit that default, be explicitly enabled, or be explicitly disabled.

**Q6 — Which messages produce webhook notifications?**

Notify only for newly received incoming messages after the message has been saved. Exclude historical imports, the user's own messages, and duplicate sync events.

**Q7 — What is Communicator's primary product purpose?**

The primary purpose is to connect AI agents ('ChatGPT work and grok') to read and send messages, replacing slow, inefficient computer-use workflows. Future dedicated agents can handle communication-heavy projects by following up and answering questions. The UI is secondary, for administration and debugging. The initial audience remains the user's own conversations. Nothing here grants autonomous authority to future agents. Agent access is in scope now; Communicator running autonomous agents later is outside today's scope.

**Q8 — How do agents configure webhook destinations?**

Agents configure webhook destinations through the API or MCP, both globally and per thread. This extends the previously agreed global default and per-chat override behavior. Q47–Q49 supersede the earlier single-effective-destination assumption: these settings and permissions apply within each independent webhook subscription. Creator ownership is relied on only where the creating connection is verifiable; otherwise the explicit connection permission governs.

**Q9 — What delivery guarantees apply to webhook notifications?**

Webhook notifications remain durably pending, retry automatically for up to 24 hours, expose visible failures after that window, and carry stable event IDs so receivers can deduplicate after a lost acknowledgement. An explicit authorized retry may be requested after failure. This is separate from the four-hour outgoing confirmation window.

**Q10 — Where should the first proof of value land?**

Prioritize proof in the user's daily agent clients. Q39 accepts ChatGPT Work first, followed by Grok web/mobile/Bot wherever supported. The exercise is accepted; actual client setup and support verification remain technical questions.

**Q11 — What permissions can each agent receive?**

Each agent can be granted an allowed set of chats and separate permissions to read, send, and manage webhooks. Within those grants, Communicator does not require approval for each operation. The authentication mechanism and detailed API consumer model remain open.

**Q12 — How does a chat-specific webhook destination interact with the global destination?**

Global, account, and chat inheritance remains the scope model for each destination. Q47–Q49 clarify that the hierarchy is evaluated within each independent subscription, and a chat override does not suppress other subscriptions. The earlier single-destination limitation is superseded.

**Q13 — Which daily agent clients are in scope for the first proof?**

ChatGPT Work, Grok web/mobile, and Grok Bot.

**Q14 — Which fields and attachment access are agreed for webhook messages?**

Webhook messages include message text, sender, chat, timestamp, stable event/message IDs, revision, and attachment metadata. Initial delivery uses the latest available content; attachment files are accessed through an authenticated file API.

**Q15 — What is a chat?**

A chat is a separate provider conversation, including group conversations. Chats are not automatically merged.

**Q16 — What access boundary should agent clients use?**

Provide one authenticated API and a remote MCP interface over the same messaging operations and permission grants. ChatGPT plugin packages connect through MCP. This does not choose the detailed credential model or named-Bot isolation model.

**Q17 — What does first-release webhook delivery promise?**

First release promises reliable delivery to a configured endpoint. Specific ChatGPT/Grok wake-up behavior is a separate integration to verify and is not promised.

**Q18 — How much conversation history should the pilot import?**

Import as far back as the provider allows. There is no arbitrary 30-day product cap. Provider availability may limit coverage, so Communicator does not promise complete history.

**Q19 — What message content must the pilot read and send?**

The pilot must read text, images, documents, and voice notes. It sends text initially. Transcription and interpretation are the responsibility of the connected agent.

**Q20 — Must the pilot start new conversations?**

Yes. Starting new conversations is in the pilot and is not deferred. The contact, permission, and group-creation details are recorded in Q21–Q27.

**Q21 — How should the pilot resolve recipients?**

Contact search by name returns a stable contact ID. Sending to an explicitly supplied phone number is supported. Ambiguous matches return candidates for selection and are never guessed.

**Q22 — What permission is needed to contact new recipients?**

Contacting new recipients has a separate permission. It can be granted broadly to a general assistant or limited to specific contacts and chats for a project agent.

**Q23 — Must the pilot create group chats?**

Yes. Creating group chats is required in the pilot.

**Q24 — When should recent messages be available during history import?**

Recent messages must be available while older history imports run in the background as far back as the provider allows. Import reports progress and known gaps.

**Q25 — What is required to create a group chat?**

Creating a group requires a separate explicit create-group permission. The request supplies a group name and resolved participant IDs or phone numbers; ambiguous participants are never guessed. No further approval is required within the grant.

**Q26 — What group management belongs in the pilot?**

The pilot supports renaming groups and adding or removing participants where provider permissions permit. These actions use a separate manage-group permission.

**Q27 — What permissions and webhook defaults apply to a new group?**

The creator automatically has read and send permission in the new group. Webhook management still requires a separate permission. A new group inherits the global webhook setting and destination.

**Q28 — How should agents search permitted history?**

Agents can search text across permitted chats, filtering by contact, chat, date, and direction. Results return IDs that agents can use to retrieve context.

**Q29 — Does reading stored history mark messages read with the provider?**

Reading stored messages has no provider read-receipt effect. Marking a message read is an explicit action.

**Q30 — How should edits, deletions, and expiry appear in agent-facing history?**

Edits update content in agent-facing history. Deletions and expiry show removal markers instead of stale content.

**Q31 — What happens to deleted or expired content?**

Deleted or expired content is removed from active storage, search, and downloadable attachments, while a removal record is retained. Backups age out under a defined retention policy capped at 30 days. Restores must not resurrect removed content. This records the agreed behavior and does not claim implementation.

**Q32 — What happens to webhook delivery when content is removed?**

Pending webhooks for removed content are canceled. If the content was already delivered, Communicator sends a removal event without exposing the removed content; external deletion is not guaranteed.

**Q33 — Which later changes produce webhook events?**

This extends Q6: initial new-message notifications remain limited to newly received incoming messages and continue to exclude historical imports, the user's own messages, and duplicate sync events. The initial event carries the latest available content and its revision. An edit after delivery is a separate event. Removed content is suppressed from content payloads; a removal event can signal the removal under the current webhook settings and permissions for that destination.

### Decisions recorded 2026-09-13

**Q34 — How long can backups retain removed content?**

The intended backup recovery window is no more than 30 days; earlier cleanup is necessary. The restoration ledger of removal records is reapplied before restored access, so restores must not make removed content available again.

**Q35 — What happens when webhook delivery continues to fail?**

Failed webhooks retry automatically for up to 24 hours, then become visibly failed. An explicit authorized retry may be requested after failure. This is separate from the four-hour outgoing confirmation window.

**Q36 — What does permission revocation do?**

Revocation immediately blocks further reads, rechecks authorization before dispatch, and cancels queued sends or webhook deliveries that are no longer authorized. Actions already accepted by a provider may not be recallable.

**Q37 — How many connected accounts should the pilot support?**

The pilot has no fixed product account cap and initially supports connecting two or three WhatsApp accounts. This does not promise infinite infrastructure capacity. Chats, contacts, and permissions are scoped to their connected account.

**Q38 — Who can grant or expand agent permissions?**

Only the user administrator UI can grant or expand agent permissions. Agents can inspect and request permissions, but cannot self-grant or grant permissions to other agents.

**Q39 — What is the accepted first-proof sequence?**

Start with ChatGPT Work: verify historical context, reading attachments, replying, starting conversations, creating and managing groups, configuring webhooks, and WhatsApp delivery and event-receiver behavior. Then verify core read/send for Grok web/mobile/Bot wherever supported. This is planning acceptance only and does not authorize running real messages now.

**Q40 — Which connected account handles a reply or new conversation?**

Replies use the account that owns the chat. New conversations and group creation require an explicit `connectedAccountID` and never silently fail over to another account.

**Q41 — How are webhook defaults scoped and overridden?**

The global default applies across accounts. Optional account overrides apply next, followed by chat overrides; the most specific setting wins within each independent subscription and does not affect other subscriptions.

**Q42 — How are agent grants scoped across connected accounts and chats?**

Each agent receives an explicit per-account grant, and a newly connected account is never exposed automatically. Within an allowed account, a grant covers all current and future chats or only selected chats. The agreed group-creator exception grants automatic read and send permission in the new group.

**Q43 — What limits apply when agents configure webhooks?**

Agent-configured webhooks, including the global configuration, remain within the agent's authorized accounts and chats and require the applicable read and webhook-management permissions. There is no webhook bypass.

**Q44 — What happens when a webhook destination changes?**

Changing a destination for one subscription stops that subscription's pending deliveries to the old destination. Its new destination receives future events only; Communicator does not automatically forward backlog or history, and other subscriptions are unaffected.

**Q45 — What must the administrator UI expose?**

The administrator UI exposes connected accounts, sync progress, conversations, agent permissions, queued sends, webhook settings and failures, and an action log. The action log identifies the authorized connection requesting sends and configuration changes.

**Q46 — How many webhook destinations must the pilot support?**

The pilot must support multiple independent webhook subscriptions now. This supersedes the earlier single-effective-destination limitation. The global, account, and chat inheritance intent is defined within each subscription by Q47–Q49.

**Q47 — How do independent webhook subscriptions behave?**

Each webhook destination is an independent subscription with its own retry state and delivery status. Failure in one subscription does not block the others.

**Q48 — How do overrides apply across subscriptions?**

Global, account, and chat overrides are evaluated within each subscription. A per-chat override applies within that subscription and does not disable other subscriptions.

**Q49 — Who manages webhook subscriptions?**

Agents can manage subscriptions they created within their permissions where creator ownership is verifiable; otherwise the explicit connection permission governs. The owner or administrator can manage all subscriptions.

### Post-research decisions — 2026-09-13

**Connection permissions:** Clients without a verified Bot identity use shared connection permissions. Distinct permission sets require separately verifiably isolated connections. This does not assert that a shared connector carries a distinct named-Bot identity.

**Webhook content semantics:** The initial webhook carries the latest available content and its revision. An edit after delivery is a separate event. Removed content is suppressed from content payloads; the accepted removal-event behavior signals removal without exposing the removed content.

**Backup recovery:** The 30-day period is an intended maximum recovery window, not a promise that content remains for the full window. Earlier cleanup is necessary, and the restoration ledger must be reapplied before restored access.

**Group reconciliation — proposed, not accepted:** Automatic reconciliation is the desired direction. After a creation response or group-creation notification, the available group ID/key would be persisted, matched against joined-group state, and refreshed; only a genuinely ambiguous result would stop automatic reconciliation to avoid a duplicate. Manual confirmation has not been accepted. The exact mechanism remains research pending.

Research evidence: [WhatsMeow `GetJoinedGroups`](https://pkg.go.dev/go.mau.fi/whatsmeow#Client.GetJoinedGroups) exposes the current joined-group list, and the [current group parser](https://raw.githubusercontent.com/tulir/whatsmeow/main/group.go) surfaces an optional group-create key and parsed group information. These sources do not prove idempotent `CreateGroup` retries or pin-confirmed behavior, so neither is recorded as settled.

## Remaining technical verification and architecture questions

No further product-scope decision is recorded as open here. The following technical and architecture questions remain unresolved:

- The authentication mechanism, API consumer model, and concrete way to provide verifiable connection isolation remain unresolved; the product requires distinct permission sets to use separately verifiably isolated connections.
- Supported Grok surfaces and specific ChatGPT/Grok wake-up or event-receiver integrations remain to be verified and are not first-release promises.
- Provider availability and capacity limits still require verification, including retrievable history, supported media/actions, and account/infrastructure capacity. The scope promises neither complete history nor infinite capacity.
- The archive physical-purge mechanism, exact backup-retention duration (capped at 30 days), and broader source-of-truth/rebuildability architecture remain open.
- The exact automatic group-reconciliation mechanism remains research pending; manual confirmation, idempotent creation retries, and pin-confirmed behavior are not accepted decisions.

ADR-0001 records the shared API/MCP permission boundary. The broader source-of-truth architecture and remaining delivery details remain open.

## Researched references — 2026-09-12

These references inform client feasibility only; they do not select a deployment or authentication model.

- [ChatGPT MCP documentation](https://learn.chatgpt.com/docs/extend/mcp): hosted Work installs a plugin with bundled remote MCP tools; ChatGPT web does not read local configuration.
- [ChatGPT plugins documentation](https://learn.chatgpt.com/docs/plugins): plugins support Chat and Work on web, desktop, and mobile; desktop-only plugins are unavailable on mobile.
- [Grok connectors documentation](https://docs.x.ai/grok/connectors): Grok supports a custom connector through `New Connector > Custom` with a public MCP URL, authentication, and exposed tools.
- [Grok overview](https://docs.x.ai/grok/overview): Grok is available on web, iOS, and Android with synced conversations and settings; custom-MCP mobile parity still needs live proof.
- [Grok Bot computer and apps](https://docs.x.ai/grok-bot/computer-and-apps): plugins/connectors are account-wide and are not isolated per Bot.
- [Grok Bot overview](https://docs.x.ai/grok-bot/overview): the overview documents Bot and connector support, but does not prove arbitrary private-MCP onboarding.
- [Grok Bot skills, routines, and automations](https://docs.x.ai/grok-bot/skills-routines-and-automations): documented event triggers are separate from plugins and cover Slack/GitHub; arbitrary webhook wake-up is unverified.

The research preserves the distinction between permission granted to a server through a credential and an actual named-Bot identity. Whether a connector is presented as a named Bot or a shared connector remains unknown.

Q16 accepts the shared authenticated API/remote-MCP boundary. It does not select a concrete credential model, named-Bot isolation, or client-specific deployment.
