# Communicator Channel and Conversation Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the simulated Communicator backoffice into an identity-scoped, channel-aware all-in-one messenger shell with an All inbox, per-channel filtering, responsive navigation, safe command sending, and strict Human/Agent isolation.

**Architecture:** Treat each existing `Connection` as one user-visible channel and add a derived `ChannelSummary` read model rather than creating a second channel authority. The same-origin API and MSW simulation expose identity-scoped channel and conversation queries; TanStack Router owns deep-linkable identity/channel/conversation state, TanStack Query owns remote cache state, and a small principal-plus-identity preference module owns non-authoritative channel order. Both conversation routes render one shared shell so desktop can show channels, conversation list, and thread together while mobile shows one task at a time.

**Tech Stack:** Node.js 24 LTS, pnpm 10, TypeScript, React 19, Vite, TanStack Router, TanStack Query, Tailwind CSS, Radix/shadcn Sheet, Hono-compatible API contracts, Zod, Mock Service Worker, Vitest, React Testing Library, and Playwright.

---

## Simple outcome

After this plan is complete, choosing **Conversations** opens a Franz-style workspace. The selected identity has an **All** inbox plus one row for every connected account, such as Personal WhatsApp, Telegram, and Messenger. All shows separate conversations across those channels in recency order; choosing a channel filters the list; opening a conversation keeps the sending route fixed. Switching from Human to Agent clears the prior channel and thread before showing Agent data.

This phase remains entirely simulated. It does not connect Cloudflare storage, Matrix, mautrix, or live provider accounts, and it does not deploy anything.

## Execution rules

1. Work only in the dedicated feature worktree and branch created for this design. Confirm with:

   ```bash
   pwd
   git branch --show-current
   git status --short
   ```

   Expected: the path ends in `.worktrees/conversations-channel-shell-design`, the branch is `codex/conversations-channel-shell-design`, and only the approved documentation changes are present before Task 1.

2. Read the approved design before editing code:

   ```bash
   sed -n '1,620p' docs/superpowers/specs/2026-08-28-communicator-channel-conversation-shell-design.md
   ```

3. Preserve these boundaries:

   - `ChannelSummary.id` is the canonical `Connection.id`.
   - The URL is a view choice, never an authorization grant.
   - Never merge same-name contacts across providers.
   - Never infer a sending connection from a title, provider, or display label.
   - Never call a live messaging provider, Matrix, Cloudflare API, or deployment command.
   - Keep Connections as the lifecycle/repair surface; Conversations is the daily messaging surface.
   - Do not alter the Synapse/mautrix deployment, provider session files, backup configuration, or Telegram runtime permissions.

4. Use test-driven steps in the order written. Do not combine tasks into one large commit.

5. Known baseline condition: `pnpm test` passed 24 tests when this plan was written. The Python suite had one pre-existing Telegram file-mode failure because `scripts/init-telegram-runtime.sh` was `0775` while `tests/test_runtime_init.py::test_telegram_runtime_initializer_is_executable` expected `0755`. Record that failure if it remains, but do not change Telegram permissions in this feature.

## Locked file layout

### Shared contracts and fixtures

- Create `packages/contracts/src/channel.ts` — derived channel summary schema.
- Modify `packages/contracts/src/conversation.ts` — canonical paginated conversation result.
- Modify `packages/contracts/src/index.ts` — export the channel contract.
- Modify `packages/contracts/src/realtime.ts` — add scoped message-event context without weakening existing events.
- Modify `packages/contracts/test/schemas.test.ts` — contract and isolation examples.
- Modify `packages/test-fixtures/src/pilot-scenario.ts` — deterministic Human multi-channel and Agent single-channel scenario.
- Modify `packages/test-fixtures/test/pilot-scenario.test.ts` — fixture ownership and ordering assertions.

### API and simulation

- Modify `apps/control-plane/src/lib/api/client.ts` — identity-scoped channel/conversation methods.
- Modify `apps/control-plane/src/lib/api/query-keys.ts` — channel-aware cache keys.
- Modify `apps/control-plane/src/lib/api/client.test.ts` — URL encoding and response validation.
- Modify `apps/control-plane/src/mocks/store.ts` — derived channels, filtering, stable sort, and strict ownership.
- Create `apps/control-plane/src/mocks/conversation-pagination.ts` — opaque stable cursor encoder/decoder and page slicing.
- Create `apps/control-plane/src/mocks/conversation-pagination.test.ts` — equal-timestamp cursor proof.
- Modify `apps/control-plane/src/mocks/handlers.ts` — identity-nested simulated endpoints.
- Modify `apps/control-plane/src/mocks/handlers.test.ts` — API isolation and generic unavailable responses.

### Browser state and messenger shell

- Modify `apps/control-plane/src/routes/__root.tsx` — validate optional `channel` search state.
- Modify `apps/control-plane/src/components/identity/identity-switcher.tsx` — reset to All and clear a thread on identity switch.
- Create `apps/control-plane/src/features/conversations/channel-order.ts` — scoped session preference helper.
- Create `apps/control-plane/src/features/conversations/channel-sidebar.tsx` — All/channel navigation and accessible ordering.
- Create `apps/control-plane/src/features/conversations/channel-selector.tsx` — mobile channel Sheet.
- Create `apps/control-plane/src/features/conversations/conversations-shell.tsx` — shared responsive shell and query ownership.
- Modify `apps/control-plane/src/features/conversations/conversation-list.tsx` — channel-labelled rows and preserved search state.
- Modify `apps/control-plane/src/features/conversations/conversation-page.tsx` — thread panel with identity/channel header and safe unavailable states.
- Modify `apps/control-plane/src/features/conversations/message-composer.tsx` — explicit sending capability gate.
- Modify both conversation route files — render the shared shell.
- Create focused unit/component tests beside the new modules.

### Realtime and browser acceptance

- Modify `apps/control-plane/src/lib/realtime/simulated-client.ts` — deterministic scoped message event publisher.
- Create `apps/control-plane/src/lib/realtime/runtime-client.ts` — one shared simulated client for the current browser runtime.
- Create `apps/control-plane/src/features/conversations/apply-conversation-event.ts` — pure cache-update decision function.
- Create its focused unit test.
- Modify `apps/control-plane/src/mocks/handlers.ts` — simulated-only test event publisher.
- Modify `apps/control-plane/src/features/system/system-page.tsx` — reuse and reset the shared client.
- Create `apps/control-plane/e2e/channel-conversations.spec.ts` — approved end-to-end behavior.
- Modify existing identity, navigation, responsive, and send-command specs only where their expected layout changes.

## Contract decisions used by every task

Use these exact shapes throughout the implementation:

```ts
export type ChannelSummary = {
  id: string;                 // canonical Connection.id
  tenant_id: string;
  identity_id: string;
  provider: "whatsapp" | "telegram" | "messenger" | "linkedin";
  display_label: string;
  status: ConnectionStatus;
  capabilities: Capability[];
  unread_count: number;
  last_activity_at: string | null;
  sort_position: number;
  attention_code?: string;
};

export type ConversationSelection = {
  identity: string;
  channel?: string;           // omitted means All
};
```

The simulated endpoints are:

```text
GET /api/v1/identities/{identity_id}/channels
GET /api/v1/identities/{identity_id}/conversations
GET /api/v1/identities/{identity_id}/conversations?channel_id={connection_id}
GET /api/v1/identities/{identity_id}/conversations?limit=50&cursor={opaque_cursor}
GET /api/v1/identities/{identity_id}/conversations/{conversation_id}
GET /api/v1/conversations/{conversation_id}/messages?identity_id={identity_id}
POST /api/v1/conversations/{conversation_id}/messages
```

All conversation results sort by:

```ts
(left, right) =>
  right.last_activity_at.localeCompare(left.last_activity_at)
  || left.id.localeCompare(right.id)
```

The ID tie-breaker is mandatory so equal timestamps remain deterministic and map directly to the later Durable Object index `(identity_id, last_activity_at DESC, conversation_id)` or `(connection_id, last_activity_at DESC, conversation_id)`.

## Specification traceability

| Approved requirement | Implemented by |
|---|---|
| Connection-backed channel read model | Tasks 1–3 |
| Human WhatsApp, Telegram, Messenger; Agent WhatsApp | Task 2 |
| All plus one-channel filtering and global recency | Tasks 3, 4, 7 |
| Stable, accessible manual ordering | Task 6 |
| Deep links and identity-reset semantics | Tasks 5, 7, 8 |
| Desktop/tablet/mobile messenger shell | Tasks 7 and 10 |
| Provider/account labels and fixed sending route | Tasks 7–8 |
| Disconnected history readable, sending disabled | Task 8 |
| Realtime recency/unread without channel reordering | Task 9 |
| Symmetric Human/Agent isolation and generic unavailable | Tasks 3, 5, 8, 10 |
| Loading, empty, retry, and unavailable states | Tasks 7–8 |
| No production/live side effects | Tasks 3 and 10 |

---

### Task 1: Add the connection-backed ChannelSummary contract

**Files:**

- Create: `packages/contracts/src/channel.ts`
- Modify: `packages/contracts/src/conversation.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/schemas.test.ts`

- [ ] **Step 1: Write failing channel contract tests**

Add this focused block to `packages/contracts/test/schemas.test.ts`:

```ts
import {
  ChannelSummarySchema,
  ConversationPageResultSchema,
  type ChannelSummary,
} from "../src";

describe("ChannelSummarySchema", () => {
  const channel = {
    id: "connection_human_telegram",
    tenant_id: "tenant_pilot",
    identity_id: "identity_human",
    provider: "telegram",
    display_label: "Telegram",
    status: "ready",
    capabilities: ["message.send", "typing.send"],
    unread_count: 3,
    last_activity_at: "2026-08-28T00:03:00.000Z",
    sort_position: 20,
  } satisfies ChannelSummary;

  it("uses the connection id and accepts derived navigation fields", () => {
    expect(ChannelSummarySchema.parse(channel)).toEqual(channel);
  });

  it("accepts a channel with no activity and an attention code", () => {
    expect(ChannelSummarySchema.parse({
      ...channel,
      status: "attention_required",
      last_activity_at: null,
      unread_count: 0,
      attention_code: "reauth_required",
    })).toMatchObject({ status: "attention_required", last_activity_at: null });
  });

  it("rejects negative unread totals and sort positions", () => {
    expect(ChannelSummarySchema.safeParse({ ...channel, unread_count: -1 }).success).toBe(false);
    expect(ChannelSummarySchema.safeParse({ ...channel, sort_position: -1 }).success).toBe(false);
  });
});

describe("ConversationPageResultSchema", () => {
  it("accepts one canonical page shape with an opaque continuation cursor", () => {
    expect(ConversationPageResultSchema.parse({
      items: [],
      next_cursor: "opaque-cursor",
    })).toEqual({ items: [], next_cursor: "opaque-cursor" });
    expect(ConversationPageResultSchema.parse({ items: [], next_cursor: null })).toEqual({
      items: [],
      next_cursor: null,
    });
  });
});
```

- [ ] **Step 2: Run the contract test and verify red**

Run:

```bash
pnpm --filter @communicator/contracts test
```

Expected: TypeScript/Vitest fails because `ChannelSummarySchema` and `ChannelSummary` are not exported.

- [ ] **Step 3: Create the minimal contract and export it**

Create `packages/contracts/src/channel.ts` with exactly:

```ts
import { z } from "zod";
import { CapabilitySchema, ConnectionStatusSchema, ProviderSchema } from "./connection";
import { CommunicatorIdSchema, TimestampSchema } from "./ids";

export const ChannelSummarySchema = z.object({
  id: CommunicatorIdSchema,
  tenant_id: CommunicatorIdSchema,
  identity_id: CommunicatorIdSchema,
  provider: ProviderSchema,
  display_label: z.string().min(1).max(100),
  status: ConnectionStatusSchema,
  capabilities: z.array(CapabilitySchema),
  unread_count: z.number().int().nonnegative(),
  last_activity_at: TimestampSchema.nullable(),
  sort_position: z.number().int().nonnegative(),
  attention_code: z.string().max(100).optional(),
}).strict();

export type ChannelSummary = z.infer<typeof ChannelSummarySchema>;
```

Add this export to `packages/contracts/src/index.ts` immediately after the connection export:

```ts
export * from "./channel";
```

Append this canonical result schema to `packages/contracts/src/conversation.ts` after `ConversationSummarySchema` and before `MessageSchema`:

```ts
export const ConversationPageResultSchema = z.object({
  items: z.array(ConversationSummarySchema),
  next_cursor: z.string().min(1).max(2_048).nullable(),
}).strict();

export type ConversationPageResult = z.infer<typeof ConversationPageResultSchema>;
```

Move the `ConversationSummary` type export above this declaration if TypeScript reports a duplicate or use-before-declaration problem; export each inferred type exactly once.

- [ ] **Step 4: Run contract tests and type checking**

```bash
pnpm --filter @communicator/contracts test
pnpm --filter @communicator/contracts check
```

Expected: both commands pass; no contract accepts an unknown property because the schema remains strict.

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/contracts/src/channel.ts packages/contracts/src/conversation.ts packages/contracts/src/index.ts packages/contracts/test/schemas.test.ts
git commit -m "feat: add channel summary contract"
```

---

### Task 2: Expand the deterministic pilot into multiple channels

**Files:**

- Modify: `packages/test-fixtures/src/pilot-scenario.ts`
- Modify: `packages/test-fixtures/test/pilot-scenario.test.ts`

- [ ] **Step 1: Add failing fixture invariants**

Add tests that derive facts rather than relying on array positions:

```ts
it("gives Human three channels and Agent only Agent WhatsApp", () => {
  const human = pilotScenario.connections.filter((item) => item.identity_id === "identity_human");
  const agent = pilotScenario.connections.filter((item) => item.identity_id === "identity_agent");

  expect(human.map((item) => item.display_label)).toEqual([
    "Personal WhatsApp",
    "Telegram",
    "Messenger",
  ]);
  expect(agent.map((item) => item.display_label)).toEqual(["Agent WhatsApp"]);
});

it("has multiple conversations per Human channel and keeps same-name contacts separate", () => {
  const human = pilotScenario.conversations.filter((item) => item.identity_id === "identity_human");
  const counts = new Map<string, number>();
  for (const conversation of human) {
    counts.set(conversation.connection_id, (counts.get(conversation.connection_id) ?? 0) + 1);
  }

  expect(counts).toEqual(new Map([
    ["connection_human_whatsapp", 2],
    ["connection_human_telegram", 2],
    ["connection_human_messenger", 2],
  ]));
  expect(human.filter((item) => item.title === "Alex Rivera")).toHaveLength(2);
  expect(new Set(human.filter((item) => item.title === "Alex Rivera").map((item) => item.connection_id)).size).toBe(2);
});

it("contains timestamps and unread counts that prove global ordering", () => {
  const ordered = pilotScenario.conversations
    .filter((item) => item.identity_id === "identity_human")
    .toSorted((a, b) => b.last_activity_at.localeCompare(a.last_activity_at) || a.id.localeCompare(b.id));

  expect(ordered.map((item) => item.id)).toEqual([
    "conversation_human_telegram_alex",
    "conversation_human_whatsapp_family",
    "conversation_human_messenger_studio",
    "conversation_human_whatsapp_alex",
    "conversation_human_telegram_product",
    "conversation_human_messenger_archive",
  ]);
  expect(ordered.reduce((sum, item) => sum + item.unread_count, 0)).toBe(10);
});
```

- [ ] **Step 2: Run fixture tests and verify red**

```bash
pnpm --filter @communicator/test-fixtures test
```

Expected: failures show the missing Telegram/Messenger connections and conversations.

- [ ] **Step 3: Replace the Human fixture with the locked scenario**

Keep the existing tenant and identity objects. Define these connection IDs and order in both `connections` and each `connection_variants` array:

```ts
const humanConnections: Connection[] = [
  {
    id: "connection_human_whatsapp",
    tenant_id: tenantId,
    identity_id: humanIdentityId,
    provider: "whatsapp",
    display_label: "Personal WhatsApp",
    status: "ready",
    capabilities: ["message.send", "reaction.add", "receipt.read", "typing.send"],
    last_synced_at: "2026-08-28T00:06:00.000Z",
  },
  {
    id: "connection_human_telegram",
    tenant_id: tenantId,
    identity_id: humanIdentityId,
    provider: "telegram",
    display_label: "Telegram",
    status: "ready",
    capabilities: ["message.send", "reaction.add", "receipt.read", "typing.send"],
    last_synced_at: "2026-08-28T00:05:00.000Z",
  },
  {
    id: "connection_human_messenger",
    tenant_id: tenantId,
    identity_id: humanIdentityId,
    provider: "messenger",
    display_label: "Messenger",
    status: "ready",
    capabilities: ["message.send", "reaction.add", "typing.send"],
    last_synced_at: "2026-08-28T00:04:00.000Z",
  },
];
```

Import `type Connection` from `@communicator/contracts`. The explicit `Connection[]` annotation keeps capabilities mutable and checks every provider/status literal.

Add these six Human conversation summaries and preserve the existing Agent summary:

```ts
function humanConversation(
  id: string,
  connection_id: string,
  title: string,
  last_message_preview: string,
  last_activity_at: string,
  unread_count: number,
): ConversationSummary {
  return {
    id,
    tenant_id: tenantId,
    identity_id: humanIdentityId,
    connection_id,
    title,
    last_message_preview,
    last_activity_at,
    unread_count,
  };
}

const humanConversations: ConversationSummary[] = [
  humanConversation("conversation_human_telegram_alex", "connection_human_telegram", "Alex Rivera", "I sent the outline", "2026-08-28T00:06:00.000Z", 3),
  humanConversation("conversation_human_whatsapp_family", "connection_human_whatsapp", "Family", "Dinner at seven", "2026-08-28T00:05:00.000Z", 4),
  humanConversation("conversation_human_messenger_studio", "connection_human_messenger", "Studio Team", "The render is ready", "2026-08-28T00:04:00.000Z", 2),
  humanConversation("conversation_human_whatsapp_alex", "connection_human_whatsapp", "Alex Rivera", "See you tomorrow", "2026-08-28T00:03:00.000Z", 1),
  humanConversation("conversation_human_telegram_product", "connection_human_telegram", "Product Group", "Ship the pilot", "2026-08-28T00:02:00.000Z", 0),
  humanConversation("conversation_human_messenger_archive", "connection_human_messenger", "Old Client", "Thanks again", "2026-08-28T00:01:00.000Z", 0),
];

function messagesFor(conversation: ConversationSummary): Message[] {
  const common = {
    tenant_id: conversation.tenant_id,
    identity_id: conversation.identity_id,
    connection_id: conversation.connection_id,
    conversation_id: conversation.id,
    occurred_at: conversation.last_activity_at,
    delivery_status: "delivered" as const,
    attachment_count: 0,
  };
  return [
    {
      ...common,
      id: `message_${conversation.id}_inbound`,
      direction: "inbound",
      sender_label: conversation.title,
      body: conversation.last_message_preview,
    },
    {
      ...common,
      id: `message_${conversation.id}_outbound`,
      direction: "outbound",
      sender_label: "Human",
      body: "Thanks — noted for the simulated pilot.",
      delivery_status: "sent",
    },
  ];
}

const humanMessages = humanConversations.flatMap(messagesFor);
```

Import `type ConversationSummary` and `type Message` from `@communicator/contracts`. Use `humanMessages` in the fixture so every message repeats the conversation's exact tenant, identity, and connection IDs. Keep the existing Agent messages, changing IDs only if they collide with the deterministic helper IDs.

For `connection_variants.attention_required`, change only `connection_human_messenger` to:

```ts
{
  ...humanConnections[2],
  status: "attention_required" as const,
  attention_code: "reauth_required",
}
```

- [ ] **Step 4: Run fixture and contract tests**

```bash
pnpm --filter @communicator/test-fixtures test
pnpm --filter @communicator/contracts test
```

Expected: all tests pass; the fixture has no phone numbers, credentials, QR payloads, Matrix IDs, or live account claims.

- [ ] **Step 5: Commit Task 2**

```bash
git add packages/test-fixtures/src/pilot-scenario.ts packages/test-fixtures/test/pilot-scenario.test.ts
git commit -m "test: expand simulated multi-channel inbox"
```

---

### Task 3: Derive channels and enforce identity-plus-connection ownership

**Files:**

- Modify: `apps/control-plane/src/mocks/store.ts`
- Create: `apps/control-plane/src/mocks/conversation-pagination.ts`
- Create: `apps/control-plane/src/mocks/conversation-pagination.test.ts`
- Modify: `apps/control-plane/src/mocks/handlers.ts`
- Modify: `apps/control-plane/src/mocks/handlers.test.ts`

- [ ] **Step 1: Add failing store and handler tests**

Cover the following exact cases in `handlers.test.ts`:

```ts
it("returns derived Human channels with stable order and unread totals", async () => {
  const response = await fetch("http://example.test/api/v1/identities/identity_human/channels");
  expect(response.status).toBe(200);
  const channels = await response.json() as Array<{ id: string; unread_count: number; sort_position: number }>;
  expect(channels.map((item) => [item.id, item.unread_count, item.sort_position])).toEqual([
    ["connection_human_whatsapp", 5, 10],
    ["connection_human_telegram", 3, 20],
    ["connection_human_messenger", 2, 30],
  ]);
});

it("returns All in deterministic recency order and filters one owned channel", async () => {
  const all = await fetch("http://example.test/api/v1/identities/identity_human/conversations");
  expect(((await all.json() as { items: Array<{ id: string }> }).items).map((item) => item.id)).toEqual([
    "conversation_human_telegram_alex",
    "conversation_human_whatsapp_family",
    "conversation_human_messenger_studio",
    "conversation_human_whatsapp_alex",
    "conversation_human_telegram_product",
    "conversation_human_messenger_archive",
  ]);

  const telegram = await fetch("http://example.test/api/v1/identities/identity_human/conversations?channel_id=connection_human_telegram");
  expect(((await telegram.json() as { items: Array<{ connection_id: string }> }).items).every(
    (item) => item.connection_id === "connection_human_telegram",
  )).toBe(true);
});

it("continues from an opaque stable cursor", async () => {
  const first = await fetch("http://example.test/api/v1/identities/identity_human/conversations?limit=2");
  const firstPage = await first.json() as { items: Array<{ id: string }>; next_cursor: string | null };
  expect(firstPage.items).toHaveLength(2);
  expect(firstPage.next_cursor).toEqual(expect.any(String));

  const second = await fetch(
    `http://example.test/api/v1/identities/identity_human/conversations?limit=2&cursor=${encodeURIComponent(firstPage.next_cursor!)}`,
  );
  const secondPage = await second.json() as { items: Array<{ id: string }> };
  expect(secondPage.items.map((item) => item.id)).toEqual([
    "conversation_human_messenger_studio",
    "conversation_human_whatsapp_alex",
  ]);
});

it.each([
  "/api/v1/identities/identity_human/conversations?channel_id=connection_agent_whatsapp",
  "/api/v1/identities/identity_agent/conversations/conversation_human_whatsapp_family",
  "/api/v1/identities/identity_human/conversations/conversation_agent_one",
])("returns the same unavailable shape for cross-scope guess %s", async (path) => {
  const response = await fetch(`http://example.test${path}`);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: { code: "not_found", message: "The requested resource is not available." },
  });
});
```

Create `conversation-pagination.test.ts` with a synthetic equal-timestamp case:

```ts
it("does not skip equal timestamps between pages", () => {
  const items = ["conversation_a", "conversation_b", "conversation_c"].map((id) => ({
    id,
    tenant_id: "tenant_pilot",
    identity_id: "identity_human",
    connection_id: "connection_human_whatsapp",
    title: id,
    last_message_preview: "Fixture",
    last_activity_at: "2026-08-28T00:00:00.000Z",
    unread_count: 0,
  }));
  const first = paginateConversations(items, { limit: 1 });
  expect(first.ok && first.page.items.map((item) => item.id)).toEqual(["conversation_a"]);
  expect(first.ok && first.page.next_cursor).toEqual(expect.any(String));

  const second = paginateConversations(items, {
    limit: 1,
    cursor: first.ok ? first.page.next_cursor ?? undefined : undefined,
  });
  expect(second.ok && second.page.items.map((item) => item.id)).toEqual(["conversation_b"]);
});
```

- [ ] **Step 2: Run handler tests and verify red**

```bash
pnpm --filter @communicator/control-plane test:ui -- src/mocks/conversation-pagination.test.ts src/mocks/handlers.test.ts
```

Expected: the new identity-nested endpoints return unhandled or incorrect responses.

- [ ] **Step 3: Add strict store derivations**

Import `ChannelSummary` in `store.ts` and add these helpers:

```ts
const defaultSortPosition = new Map([
  ["connection_human_whatsapp", 10],
  ["connection_human_telegram", 20],
  ["connection_human_messenger", 30],
  ["connection_agent_whatsapp", 10],
]);
```

Import `compareConversationRecency` from `./conversation-pagination` rather than maintaining a second comparator.

Replace the current broad conversation accessor and add channel lookup methods:

```ts
channels(identityId: string): ChannelSummary[] {
  const connections = this.connections(identityId);
  return connections
    .map((connection) => {
      const conversations = this.state.conversations.filter(
        (item) => item.identity_id === identityId && item.connection_id === connection.id,
      );
      return {
        id: connection.id,
        tenant_id: connection.tenant_id,
        identity_id: connection.identity_id,
        provider: connection.provider,
        display_label: connection.display_label,
        status: connection.status,
        capabilities: connection.capabilities,
        unread_count: conversations.reduce((sum, item) => sum + item.unread_count, 0),
        last_activity_at: conversations.toSorted(compareConversationRecency)[0]?.last_activity_at ?? null,
        sort_position: defaultSortPosition.get(connection.id) ?? 1_000,
        ...(connection.attention_code ? { attention_code: connection.attention_code } : {}),
      };
    })
    .toSorted((left, right) => left.sort_position - right.sort_position || left.id.localeCompare(right.id));
}

conversations(identityId: string, channelId?: string): ConversationSummary[] | null {
  if (!this.state.identities.some((item) => item.id === identityId)) return null;
  if (channelId && !this.connections(identityId).some((item) => item.id === channelId)) return null;
  return clone(this.state.conversations
    .filter((item) => item.identity_id === identityId && (!channelId || item.connection_id === channelId))
    .toSorted(compareConversationRecency));
}

conversation(identityId: string, conversationId: string): ConversationSummary | null {
  return clone(this.state.conversations.find(
    (item) => item.id === conversationId && item.identity_id === identityId
      && this.connections(identityId).some((connection) => connection.id === item.connection_id),
  ) ?? null);
}
```

Keep `messages()` and `commandForMessage()` fail-closed by additionally checking that the matching conversation's connection belongs to the same identity. Do not return a boolean or alternate error that reveals which ownership check failed.

- [ ] **Step 4: Implement the opaque stable cursor**

Create `conversation-pagination.ts`:

```ts
import { z } from "zod";
import {
  CommunicatorIdSchema,
  TimestampSchema,
  type ConversationPageResult,
  type ConversationSummary,
} from "@communicator/contracts";

const CursorSchema = z.object({
  last_activity_at: TimestampSchema,
  conversation_id: CommunicatorIdSchema,
}).strict();

export function compareConversationRecency(
  left: ConversationSummary,
  right: ConversationSummary,
) {
  return right.last_activity_at.localeCompare(left.last_activity_at)
    || left.id.localeCompare(right.id);
}

function encodeCursor(item: ConversationSummary) {
  return btoa(JSON.stringify({
    last_activity_at: item.last_activity_at,
    conversation_id: item.id,
  }));
}

function decodeCursor(cursor: string) {
  try {
    return CursorSchema.parse(JSON.parse(atob(cursor)));
  } catch {
    return null;
  }
}

export function paginateConversations(
  source: ConversationSummary[],
  options: { limit?: number; cursor?: string },
): { ok: true; page: ConversationPageResult } | { ok: false } {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { ok: false };

  const items = source.toSorted(compareConversationRecency);
  let start = 0;
  if (options.cursor) {
    const decoded = decodeCursor(options.cursor);
    if (!decoded) return { ok: false };
    const cursorIndex = items.findIndex((item) =>
      item.last_activity_at === decoded.last_activity_at
      && item.id === decoded.conversation_id);
    if (cursorIndex < 0) return { ok: false };
    start = cursorIndex + 1;
  }

  const pageItems = items.slice(start, start + limit);
  const hasMore = start + pageItems.length < items.length;
  return {
    ok: true,
    page: {
      items: pageItems,
      next_cursor: hasMore && pageItems.length > 0
        ? encodeCursor(pageItems.at(-1)!)
        : null,
    },
  };
}
```

The cursor exposes no ownership authority. It is accepted only when its exact `(last_activity_at, conversation_id)` tuple exists inside the already-authorized and optionally channel-filtered result.

- [ ] **Step 5: Add identity-nested MSW handlers**

Add these handlers before the generic conversation-message route:

```ts
http.get("*/api/v1/identities/:identityId/channels", ({ params }) => {
  const identityId = String(params.identityId);
  if (!simulatedStore.identities().some((item) => item.id === identityId)) {
    return errorResponse(404, "not_found");
  }
  return HttpResponse.json(simulatedStore.channels(identityId));
}),

http.get("*/api/v1/identities/:identityId/conversations", ({ request, params }) => {
  const identityId = String(params.identityId);
  const search = new URL(request.url).searchParams;
  const channelId = search.get("channel_id") ?? undefined;
  const cursor = search.get("cursor") ?? undefined;
  const rawLimit = search.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  const conversations = simulatedStore.conversations(identityId, channelId);
  if (!conversations) return errorResponse(404, "not_found");
  const result = paginateConversations(conversations, { limit, cursor });
  return result.ok
    ? HttpResponse.json(result.page)
    : errorResponse(400, "bad_request");
}),

http.get("*/api/v1/identities/:identityId/conversations/:conversationId", ({ params }) => {
  const conversation = simulatedStore.conversation(
    String(params.identityId),
    String(params.conversationId),
  );
  return conversation
    ? HttpResponse.json(conversation)
    : errorResponse(404, "not_found");
}),
```

Leave the old query-parameter conversation endpoint temporarily available for unchanged screens during this task; Task 4 moves all UI calls to the nested endpoints.

- [ ] **Step 6: Run pagination, handler, fixture, and contract tests**

```bash
pnpm --filter @communicator/control-plane test:ui -- src/mocks/conversation-pagination.test.ts src/mocks/handlers.test.ts
pnpm --filter @communicator/test-fixtures test
pnpm --filter @communicator/contracts test
```

Expected: all pass, including symmetric Human/Agent guesses.

- [ ] **Step 7: Commit Task 3**

```bash
git add apps/control-plane/src/mocks/store.ts apps/control-plane/src/mocks/conversation-pagination.ts apps/control-plane/src/mocks/conversation-pagination.test.ts apps/control-plane/src/mocks/handlers.ts apps/control-plane/src/mocks/handlers.test.ts
git commit -m "feat: expose identity-scoped channel queries"
```

---

### Task 4: Make the API client and cache keys channel-aware

**Files:**

- Modify: `apps/control-plane/src/lib/api/client.ts`
- Modify: `apps/control-plane/src/lib/api/query-keys.ts`
- Modify: `apps/control-plane/src/lib/api/client.test.ts`

- [ ] **Step 1: Write failing client tests**

Use a fetch spy that records URLs and returns contract-valid data:

```ts
it("encodes identity and channel IDs in scoped channel queries", async () => {
  const urls: string[] = [];
  const client = new ApiClient(async (input) => {
    const url = String(input);
    urls.push(url);
    const body = url.endsWith("/channels")
      ? []
      : { items: [], next_cursor: null };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }, "https://communicator.test");

  await client.getChannels("identity/a");
  await client.getConversations("identity/a", "connection?a=b");

  expect(urls).toEqual([
    "https://communicator.test/api/v1/identities/identity%2Fa/channels",
    "https://communicator.test/api/v1/identities/identity%2Fa/conversations?limit=50&channel_id=connection%3Fa%3Db",
  ]);
});
```

Add a second test that returns a `ChannelSummary` with `unread_count: -1` and expects `getChannels()` to reject with `ApiError` status 502.

- [ ] **Step 2: Run the client test and verify red**

```bash
pnpm --filter @communicator/control-plane test:ui -- src/lib/api/client.test.ts
```

Expected: `getChannels` is missing and `getConversations` has the old signature.

- [ ] **Step 3: Implement the scoped client methods**

Import `ChannelSummarySchema`, `ConversationPageResultSchema`, `ConversationSummarySchema`, and their types. Use these exact methods:

```ts
getChannels(identityId: string): Promise<ChannelSummary[]> {
  return this.request(
    `/api/v1/identities/${encodeURIComponent(identityId)}/channels`,
    ChannelSummarySchema.array(),
  );
}

getConversations(
  identityId: string,
  channelId?: string,
  cursor?: string,
): Promise<ConversationPageResult> {
  const search = new URLSearchParams({ limit: "50" });
  if (channelId) search.set("channel_id", channelId);
  if (cursor) search.set("cursor", cursor);
  return this.request(
    `/api/v1/identities/${encodeURIComponent(identityId)}/conversations?${search}`,
    ConversationPageResultSchema,
  );
}

getConversation(identityId: string, conversationId: string): Promise<ConversationSummary> {
  return this.request(
    `/api/v1/identities/${encodeURIComponent(identityId)}/conversations/${encodeURIComponent(conversationId)}`,
    ConversationSummarySchema,
  );
}
```

Replace query keys with:

```ts
channels: (identityId: string) => ["channels", identityId] as const,
conversations: (identityId: string, channelId?: string) =>
  ["conversations", identityId, channelId ?? "all"] as const,
conversation: (identityId: string, conversationId: string) =>
  ["conversation", identityId, conversationId] as const,
messages: (identityId: string, conversationId: string) =>
  ["messages", identityId, conversationId] as const,
```

- [ ] **Step 4: Run client tests and control-plane check**

```bash
pnpm --filter @communicator/control-plane test:ui -- src/lib/api/client.test.ts
pnpm --filter @communicator/control-plane check
```

Expected: client tests pass. The check may expose old `queryKeys.conversations(identityId)` call sites; update their calls to pass `undefined` explicitly only when TypeScript requires it, without changing UI behavior yet.

- [ ] **Step 5: Commit Task 4**

```bash
git add apps/control-plane/src/lib/api/client.ts apps/control-plane/src/lib/api/query-keys.ts apps/control-plane/src/lib/api/client.test.ts
git commit -m "feat: add channel-aware API client"
```

---

### Task 5: Make identity and channel URL state fail closed

**Files:**

- Modify: `apps/control-plane/src/routes/__root.tsx`
- Modify: `apps/control-plane/src/components/identity/identity-switcher.tsx`
- Create: `apps/control-plane/src/components/identity/identity-switcher.test.tsx`

- [ ] **Step 1: Write the identity-switch regression test**

```ts
it("switches a thread to the new identity All inbox", async () => {
  const user = userEvent.setup();
  const { router } = renderApp(
    "/conversations/conversation_human_whatsapp_family?identity=identity_human&channel=connection_human_whatsapp",
  );

  await user.selectOptions(await screen.findByLabelText("Active identity"), "identity_agent");

  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/conversations");
    expect(router.state.location.search).toEqual({ identity: "identity_agent" });
  });
  expect(screen.queryByText("Family")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test and verify red**

```bash
pnpm --filter @communicator/control-plane test:ui -- src/components/identity/identity-switcher.test.tsx
```

Expected: the old conversation path and/or channel search value remain.

- [ ] **Step 3: Validate channel search and reset navigation**

Change root search validation to:

```ts
validateSearch: z.object({
  identity: z.string().optional(),
  channel: z.string().optional(),
}),
```

In `switchIdentity`, cancel identity-scoped work before navigation and compute the destination explicitly:

```ts
const switchIdentity = async (identityId: string) => {
  if (!identities.some((item) => item.id === identityId)) return;

  const pathname = router.state.location.pathname;
  const inConversationThread = pathname.startsWith("/conversations/");
  await queryClient.cancelQueries({
    predicate: (query) => ["channels", "conversations", "conversation", "messages", "commands"]
      .includes(String(query.queryKey[0])),
  });

  await router.navigate({
    to: inConversationThread ? "/conversations" : pathname as "/",
    search: { identity: identityId },
  });
};
```

Update the context type so `switchIdentity` returns `Promise<void>`, and call it with `void switchIdentity(...)` from the select handler. The existing effect that repairs a missing/invalid identity must preserve a valid channel only when the identity did not change; when it selects a fallback identity, navigate with `{ identity: activeIdentity.id }` so a guessed channel is dropped.

- [ ] **Step 4: Run focused and shell tests**

```bash
pnpm --filter @communicator/control-plane test:ui -- src/components/identity/identity-switcher.test.tsx src/components/layout/app-shell.test.tsx
```

Expected: both pass and no stale Human title appears after Agent selection.

- [ ] **Step 5: Commit Task 5**

```bash
git add apps/control-plane/src/routes/__root.tsx apps/control-plane/src/components/identity/identity-switcher.tsx apps/control-plane/src/components/identity/identity-switcher.test.tsx
git commit -m "fix: reset conversation scope on identity switch"
```

---

### Task 6: Build accessible channel ordering and navigation

**Files:**

- Create: `apps/control-plane/src/features/conversations/channel-order.ts`
- Create: `apps/control-plane/src/features/conversations/channel-order.test.ts`
- Create: `apps/control-plane/src/features/conversations/channel-sidebar.tsx`
- Create: `apps/control-plane/src/features/conversations/channel-sidebar.test.tsx`

- [ ] **Step 1: Write failing preference and sidebar tests**

The preference test must prove scope and malformed-storage recovery:

```ts
describe("channel order preferences", () => {
  beforeEach(() => sessionStorage.clear());

  it("scopes order to principal plus identity", () => {
    saveChannelOrder("principal_pilot", "identity_human", ["connection_human_telegram", "connection_human_whatsapp"]);
    expect(loadChannelOrder("principal_pilot", "identity_human")).toEqual([
      "connection_human_telegram",
      "connection_human_whatsapp",
    ]);
    expect(loadChannelOrder("principal_pilot", "identity_agent")).toEqual([]);
  });

  it("returns an empty order for malformed storage", () => {
    sessionStorage.setItem("communicator:channel-order:principal_pilot:identity_human", "not-json");
    expect(loadChannelOrder("principal_pilot", "identity_human")).toEqual([]);
  });
});
```

The component test must render All first, render channels by supplied order, select a channel by opaque ID, and activate **Move Telegram up** using the keyboard.

- [ ] **Step 2: Run tests and verify red**

```bash
pnpm --filter @communicator/control-plane test:ui -- src/features/conversations/channel-order.test.ts src/features/conversations/channel-sidebar.test.tsx
```

Expected: imports fail because the modules do not exist.

- [ ] **Step 3: Implement the scoped preference helper**

Create `channel-order.ts`:

```ts
const prefix = "communicator:channel-order";

function key(principalId: string, identityId: string) {
  return `${prefix}:${principalId}:${identityId}`;
}

export function loadChannelOrder(principalId: string, identityId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(key(principalId, identityId)) ?? "[]");
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? [...new Set(parsed)]
      : [];
  } catch {
    return [];
  }
}

export function saveChannelOrder(principalId: string, identityId: string, ids: string[]) {
  sessionStorage.setItem(key(principalId, identityId), JSON.stringify([...new Set(ids)]));
}

export function clearChannelOrderPreferences() {
  for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
    const item = sessionStorage.key(index);
    if (item?.startsWith(`${prefix}:`)) sessionStorage.removeItem(item);
  }
}

export function applyChannelOrder<T extends { id: string; sort_position: number }>(
  channels: T[],
  preferredIds: string[],
): T[] {
  const preferred = new Map(preferredIds.map((id, index) => [id, index]));
  return channels.toSorted((left, right) => {
    const leftIndex = preferred.get(left.id);
    const rightIndex = preferred.get(right.id);
    if (leftIndex !== undefined || rightIndex !== undefined) {
      return (leftIndex ?? Number.MAX_SAFE_INTEGER) - (rightIndex ?? Number.MAX_SAFE_INTEGER);
    }
    return left.sort_position - right.sort_position || left.id.localeCompare(right.id);
  });
}
```

- [ ] **Step 4: Implement ChannelSidebar as a controlled component**

Use this public interface:

```ts
type ChannelSidebarProps = {
  channels: ChannelSummary[];
  identityId: string;
  selectedChannelId?: string;
  allUnreadCount: number;
  onSelect: (channelId?: string) => void;
  onReorder: (orderedIds: string[]) => void;
};
```

The component must:

- render `<nav aria-label="Conversation channels">`;
- render an All button first with `aria-current={!selectedChannelId ? "page" : undefined}`;
- render channel buttons with provider, display label, unread badge, and status warning;
- render an attention/disconnected **Manage connection** link to `/connections` with `search={{ identity: identityId }}`;
- give each channel row **Move {display_label} up** and **Move {display_label} down** buttons;
- disable up on the first channel and down on the last;
- call `onReorder` with a copied, swapped ID array;
- never sort by `last_activity_at`; and
- expose an attention link to `/connections?identity=...` from the parent rather than embedding secret or remote identifiers.

Use one pure helper for swapping:

```ts
export function moveChannel(ids: string[], id: string, direction: -1 | 1) {
  const from = ids.indexOf(id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= ids.length) return ids;
  const next = [...ids];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
```

- [ ] **Step 5: Run focused tests and accessibility assertions**

```bash
pnpm --filter @communicator/control-plane test:ui -- src/features/conversations/channel-order.test.ts src/features/conversations/channel-sidebar.test.tsx
```

Expected: All is first, unread totals are visible, keyboard click reorders, and channel selection passes the exact connection ID.

- [ ] **Step 6: Commit Task 6**

```bash
git add apps/control-plane/src/features/conversations/channel-order.ts apps/control-plane/src/features/conversations/channel-order.test.ts apps/control-plane/src/features/conversations/channel-sidebar.tsx apps/control-plane/src/features/conversations/channel-sidebar.test.tsx
git commit -m "feat: add ordered channel navigation"
```

---

### Task 7: Assemble the responsive All and channel conversation shell

**Files:**

- Create: `apps/control-plane/src/features/conversations/channel-selector.tsx`
- Create: `apps/control-plane/src/features/conversations/conversations-shell.tsx`
- Create: `apps/control-plane/src/features/conversations/conversations-shell.test.tsx`
- Modify: `apps/control-plane/src/features/conversations/conversation-list.tsx`
- Modify: `apps/control-plane/src/routes/conversations.index.tsx`
- Modify: `apps/control-plane/src/routes/conversations.$conversationId.tsx`

- [ ] **Step 1: Write failing shell tests**

Cover these exact behaviors with `renderApp()` and `userEvent`:

```ts
it("defaults to All and renders every Human conversation in global recency order", async () => {
  renderApp("/conversations?identity=identity_human");
  expect(await screen.findByRole("button", { name: /All/ })).toHaveAttribute("aria-current", "page");
  expect(screen.getAllByTestId("conversation-row").map((row) => row.getAttribute("data-conversation-id"))).toEqual([
    "conversation_human_telegram_alex",
    "conversation_human_whatsapp_family",
    "conversation_human_messenger_studio",
    "conversation_human_whatsapp_alex",
    "conversation_human_telegram_product",
    "conversation_human_messenger_archive",
  ]);
});

it("filters by the selected opaque channel and preserves it in the URL", async () => {
  const user = userEvent.setup();
  const { router } = renderApp("/conversations?identity=identity_human");
  await user.click(await screen.findByRole("button", { name: /Telegram/ }));
  await waitFor(() => expect(router.state.location.search).toEqual({
    identity: "identity_human",
    channel: "connection_human_telegram",
  }));
  expect(screen.getAllByTestId("conversation-row")).toHaveLength(2);
  expect(screen.queryByText("Family")).not.toBeInTheDocument();
});

it("keeps same-name contacts as separate channel-labelled rows in All", async () => {
  renderApp("/conversations?identity=identity_human");
  const alexRows = await screen.findAllByRole("link", { name: /Alex Rivera/ });
  expect(alexRows).toHaveLength(2);
  expect(alexRows[0]).toHaveTextContent(/Telegram|Personal WhatsApp/);
  expect(alexRows[1]).toHaveTextContent(/Telegram|Personal WhatsApp/);
});
```

Add tests for channel loading, no channels, selected channel with no conversations, All with no conversations, and retry after a simulated 500. Use accessible `role="status"` or `role="alert"` and a named Retry button.

- [ ] **Step 2: Run shell tests and verify red**

```bash
pnpm --filter @communicator/control-plane test:ui -- src/features/conversations/conversations-shell.test.tsx
```

Expected: the shared shell and channel controls are missing.

- [ ] **Step 3: Make ConversationList controlled and channel-labelled**

Use this interface:

```ts
type ConversationListProps = {
  conversations: ConversationSummary[];
  channelsById: ReadonlyMap<string, ChannelSummary>;
  identityId: string;
  selectedChannelId?: string;
  activeConversationId?: string;
};
```

For each row, resolve `channelsById.get(conversation.connection_id)`. If absent, do not guess; render the generic unavailable row state. The link must be:

```tsx
<Link
  to="/conversations/$conversationId"
  params={{ conversationId: conversation.id }}
  search={{ identity: identityId, ...(selectedChannelId ? { channel: selectedChannelId } : {}) }}
  data-testid="conversation-row"
  data-conversation-id={conversation.id}
  aria-current={activeConversationId === conversation.id ? "page" : undefined}
>
```

Every All row visibly renders both `channel.provider` and `channel.display_label`. A filtered row still renders the account label so the fixed sending route remains obvious.

- [ ] **Step 4: Implement the shared ConversationsShell**

Public interface:

```ts
export function ConversationsShell({ conversationId }: { conversationId?: string })
```

Inside the component:

1. Read `activeIdentity` and the root search object.
2. Query `getMe()` and `getChannels(identityId)` normally. Query conversations with `useInfiniteQuery`, `queryKeys.conversations(identityId, search.channel)`, `initialPageParam: undefined as string | undefined`, `queryFn: ({ pageParam }) => apiClient.getConversations(identityId, search.channel, pageParam)`, and `getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined`. Flatten `data.pages.flatMap((page) => page.items)` only for presentation. When `conversationId` is present, also query `getConversation(identityId, conversationId)` with `queryKeys.conversation(identityId, conversationId)`; do not infer a detail resource from a partial list.
3. Treat omitted channel as All.
4. If a channel search value is not present in the returned channel list, show a generic unavailable alert plus **Return to All**. Do not silently switch.
5. Load, apply, and save manual order using `me.principal_id` plus `identityId`.
6. Compute All unread as `conversations from the unfiltered All cache`, not from the filtered list. Either run an always-enabled All query or derive totals from channels; use `channels.reduce((sum, item) => sum + item.unread_count, 0)` to avoid a duplicate request.
7. Selecting a channel navigates to `/conversations` with `{ identity, channel }`; selecting All uses `{ identity }`.
8. Pass the same controlled sidebar content to desktop navigation and the mobile selector.
9. When `hasNextPage` is true, render a **Load older conversations** button that calls `fetchNextPage()`, disables while `isFetchingNextPage`, and appends rather than replaces rows. A page failure uses the same safe Retry surface and preserves already loaded rows.

Use this responsive structure as the implementation skeleton:

```tsx
<section aria-labelledby="conversations-heading" className="min-h-[calc(100vh-8rem)]">
  <h1 id="conversations-heading" className="sr-only">Conversations</h1>
  <div className="mb-3 md:hidden">
    <ChannelSelector>{channelNavigation}</ChannelSelector>
  </div>
  <div className="grid min-h-[38rem] overflow-hidden rounded-xl border bg-card md:grid-cols-[14rem_minmax(18rem,22rem)_minmax(0,1fr)]">
    <aside className="hidden border-r bg-muted/30 md:block">{channelNavigation}</aside>
    <div className={conversationId ? "hidden border-r md:block" : "border-r md:block"}>
      {conversationListState}
    </div>
    <main className={conversationId ? "block min-w-0" : "hidden min-w-0 md:block"}>
      {conversationId ? threadPanel : emptyThreadPanel}
    </main>
  </div>
</section>
```

The desktop breakpoint is `md` (768px), matching `useIsMobile`. At tablet widths the global primary sidebar is already hidden, leaving channel/list/thread space. The shell must not add a second primary navigation.

- [ ] **Step 5: Implement the mobile ChannelSelector**

Use the existing Sheet primitives. The closed trigger must announce the selected label, for example **Channel: All** or **Channel: Telegram**. The Sheet uses `side="left"`, title **Channels**, description **Choose a connected account or view every conversation**, and closes after selection. Reuse ChannelSidebar rather than duplicating channel rows.

- [ ] **Step 6: Route both conversation URLs through the shell**

`conversations.index.tsx` becomes:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { ConversationsShell } from "@/features/conversations/conversations-shell";

export const Route = createFileRoute("/conversations/")({
  component: ConversationsShell,
});
```

`conversations.$conversationId.tsx` reads the param and passes it:

```tsx
function ConversationRoute() {
  const { conversationId } = Route.useParams();
  return <ConversationsShell conversationId={conversationId} />;
}
```

- [ ] **Step 7: Run shell, router, and shell-layout tests**

```bash
pnpm --filter @communicator/control-plane test:ui -- src/features/conversations/conversations-shell.test.tsx src/components/layout/app-shell.test.tsx
pnpm --filter @communicator/control-plane check
```

Expected: All and Telegram tests pass, generated route typing passes, and no route renders two unrelated conversation page trees.

- [ ] **Step 8: Commit Task 7**

```bash
git add apps/control-plane/src/features/conversations/channel-selector.tsx apps/control-plane/src/features/conversations/conversations-shell.tsx apps/control-plane/src/features/conversations/conversations-shell.test.tsx apps/control-plane/src/features/conversations/conversation-list.tsx apps/control-plane/src/routes/conversations.index.tsx 'apps/control-plane/src/routes/conversations.$conversationId.tsx' apps/control-plane/src/routeTree.gen.ts
git commit -m "feat: build responsive conversation shell"
```

---

### Task 8: Bind the active thread and composer to one safe channel

**Files:**

- Modify: `apps/control-plane/src/features/conversations/conversation-page.tsx`
- Modify: `apps/control-plane/src/features/conversations/conversation-page.test.tsx`
- Modify: `apps/control-plane/src/features/conversations/message-composer.tsx`
- Create: `apps/control-plane/src/features/conversations/message-composer.test.tsx`

- [ ] **Step 1: Add failing thread and capability tests**

Cover:

```ts
it("labels the active thread with identity, provider, and account", async () => {
  renderApp("/conversations/conversation_human_telegram_alex?identity=identity_human&channel=connection_human_telegram");
  expect(await screen.findByRole("heading", { name: "Alex Rivera" })).toBeVisible();
  expect(screen.getByText("Human · telegram · Telegram")).toBeVisible();
});

it("keeps attention-required history readable and disables sending", async () => {
  await apiClient.resetSimulation("attention_required");
  renderApp("/conversations/conversation_human_messenger_studio?identity=identity_human&channel=connection_human_messenger");
  expect(await screen.findByText("The render is ready")).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
  expect(screen.getByText("Sending is unavailable until this connection is repaired.")).toBeVisible();
});

it("shows one generic unavailable state for a cross-channel URL guess", async () => {
  renderApp("/conversations/conversation_human_whatsapp_family?identity=identity_human&channel=connection_human_telegram");
  expect(await screen.findByRole("alert")).toHaveTextContent("This conversation is unavailable.");
  expect(screen.queryByText("Family")).not.toBeInTheDocument();
});
```

The composer unit test passes `canSend={false}` and asserts the textarea, delivery mode, and submit button are disabled and that no request occurs.

- [ ] **Step 2: Run focused tests and verify red**

```bash
pnpm --filter @communicator/control-plane test:ui -- src/features/conversations/conversation-page.test.tsx src/features/conversations/message-composer.test.tsx
```

Expected: missing channel header/capability props or incorrect cross-channel behavior.

- [ ] **Step 3: Make ConversationPage a controlled thread panel**

Replace internal identity/conversation-list discovery with this public interface:

```ts
type ConversationPageProps = {
  identity: Identity;
  channel: ChannelSummary;
  conversation: ConversationSummary;
  selectedChannelId?: string;
};
```

Before rendering the component, `ConversationsShell` must verify all of:

```ts
conversation.identity_id === identity.id
conversation.connection_id === channel.id
channel.identity_id === identity.id
conversation.tenant_id === channel.tenant_id
```

If `selectedChannelId` exists, also require `selectedChannelId === conversation.connection_id`. Failure renders the generic unavailable state and does not request messages.

The header subtitle is:

```tsx
<p className="text-sm text-muted-foreground">
  {identity.display_name} · {channel.provider} · {channel.display_label}
</p>
```

The Back link preserves `{ identity: identity.id, ...(selectedChannelId ? { channel: selectedChannelId } : {}) }`.

- [ ] **Step 4: Gate MessageComposer explicitly**

Change the interface to:

```ts
type MessageComposerProps = {
  identityId: string;
  conversationId: string;
  canSend: boolean;
  unavailableReason?: string;
};
```

Compute in the parent:

```ts
const canSend = channel.status === "ready"
  && channel.capabilities.includes("message.send");
```

Use `const isDisabled = mutation.isPending || !canSend`, disable all controls, and render the safe reason. The POST body remains identity-scoped; the server derives the connection from the owned conversation. Do not add a client-supplied connection override to the send API. After command acceptance, preserve the existing direct/paced behavior and confirmation wording.

- [ ] **Step 5: Add safe loading, retry, and unavailable states**

Messages loading uses `role="status"`. A messages error uses `role="alert"` plus a Retry button calling `messagesQuery.refetch()`. Conversation 404/cross-scope uses exactly **This conversation is unavailable.** and a **Return to All** link. Diagnostics never render request bodies, remote IDs, Matrix IDs, phone numbers, cookies, or provider credentials.

- [ ] **Step 6: Run focused tests and all UI tests**

```bash
pnpm --filter @communicator/control-plane test:ui -- src/features/conversations/conversation-page.test.tsx src/features/conversations/message-composer.test.tsx
pnpm --filter @communicator/control-plane test:ui
```

Expected: all UI tests pass and no existing direct/paced test loses its idempotency behavior.

- [ ] **Step 7: Commit Task 8**

```bash
git add apps/control-plane/src/features/conversations/conversation-page.tsx apps/control-plane/src/features/conversations/conversation-page.test.tsx apps/control-plane/src/features/conversations/message-composer.tsx apps/control-plane/src/features/conversations/message-composer.test.tsx apps/control-plane/src/features/conversations/conversations-shell.tsx
git commit -m "feat: bind message composer to channel capability"
```

---

### Task 9: Apply scoped realtime message updates without moving channels

**Files:**

- Modify: `packages/contracts/src/realtime.ts`
- Modify: `packages/contracts/test/schemas.test.ts`
- Modify: `apps/control-plane/src/lib/realtime/simulated-client.ts`
- Create: `apps/control-plane/src/lib/realtime/runtime-client.ts`
- Create: `apps/control-plane/src/features/conversations/apply-conversation-event.ts`
- Create: `apps/control-plane/src/features/conversations/apply-conversation-event.test.ts`
- Modify: `apps/control-plane/src/mocks/handlers.ts`
- Modify: `apps/control-plane/src/mocks/handlers.test.ts`
- Modify: `apps/control-plane/src/features/system/system-page.tsx`
- Modify: `apps/control-plane/src/features/conversations/conversations-shell.tsx`

- [ ] **Step 1: Write failing scoped-event tests**

Add a `message.created` contract example carrying:

```ts
{
  sequence: 7,
  type: "message.created",
  tenant_id: "tenant_pilot",
  identity_id: "identity_human",
  connection_id: "connection_human_telegram",
  conversation_id: "conversation_human_telegram_alex",
  occurred_at: "2026-08-28T00:07:00.000Z",
  data: {
    last_message_preview: "New reply",
    last_activity_at: "2026-08-28T00:07:00.000Z",
    unread_delta: 1,
  },
}
```

The pure update test must prove an active Human event updates the matching conversation in both All and Telegram cached arrays, recomputes recency and unread, and leaves the channel array order unchanged. Add separate tests rejecting wrong tenant, wrong identity, wrong connection ownership, a repeated/lower sequence, and malformed data.

- [ ] **Step 2: Run tests and verify red**

```bash
pnpm --filter @communicator/contracts test
pnpm --filter @communicator/control-plane test:ui -- src/features/conversations/apply-conversation-event.test.ts
```

Expected: the realtime contract lacks scoped IDs and the cache helper is missing.

- [ ] **Step 3: Strengthen the realtime contract**

Keep existing event types compatible, but add optional top-level fields:

```ts
connection_id: CommunicatorIdSchema.optional(),
conversation_id: CommunicatorIdSchema.optional(),
```

Add and export a strict data schema used only when `type === "message.created"`:

```ts
export const MessageCreatedDataSchema = z.object({
  last_message_preview: z.string().max(280),
  last_activity_at: TimestampSchema,
  unread_delta: z.number().int(),
}).strict();
```

The application helper must require both IDs and successfully parse `MessageCreatedDataSchema`; optional fields on other event types do not make message handling permissive.

- [ ] **Step 4: Implement a pure, fail-closed cache decision**

Use this interface:

```ts
type ActiveScope = {
  tenantId: string;
  identityId: string;
  lastSequence: number;
  channels: ChannelSummary[];
};

type ConversationCacheUpdate = {
  acceptedSequence: number;
  channelId: string;
  conversationId: string;
  updatePages: (
    pages: ConversationPageResult[] | undefined,
  ) => ConversationPageResult[] | undefined;
  updateChannels: (items: ChannelSummary[] | undefined) => ChannelSummary[] | undefined;
};

export function prepareConversationEvent(
  scope: ActiveScope,
  event: RealtimeEvent,
): ConversationCacheUpdate | null
```

Return null unless sequence increases, tenant and identity match, type is `message.created`, both scoped IDs exist, and the channel list proves `channel.id === event.connection_id && channel.identity_id === event.identity_id`. Import `ConversationPageResult` for the page updater. When the cache is a complete single page (`next_cursor === null`), the updater matches only by conversation ID plus connection ID plus identity ID, changes preview/activity/unread, and re-sorts that page with the locked comparator. If the cache has multiple pages or a continuation cursor, return it unchanged and let the shell invalidate that query because a server cursor cannot safely be rewritten client-side. The channel updater changes only the matching channel's unread/activity fields and returns the array in its existing order.

- [ ] **Step 5: Publish deterministic simulated message events**

Add `publishMessage()` to `SimulatedRealtimeClient` with explicit tenant, identity, connection, conversation, preview, activity, and unread delta arguments. Parse through `RealtimeEventSchema` before notifying listeners. Never create an interval, network socket, or live provider call.

Use this exact signature and event body:

```ts
publishMessage(input: {
  tenantId: string;
  identityId: string;
  connectionId: string;
  conversationId: string;
  lastMessagePreview: string;
  lastActivityAt: string;
  unreadDelta: number;
}) {
  if (!this.connected) return;
  const event = RealtimeEventSchema.parse({
    sequence: ++this.sequence,
    type: "message.created",
    tenant_id: input.tenantId,
    identity_id: input.identityId,
    connection_id: input.connectionId,
    conversation_id: input.conversationId,
    occurred_at: input.lastActivityAt,
    data: {
      last_message_preview: input.lastMessagePreview,
      last_activity_at: input.lastActivityAt,
      unread_delta: input.unreadDelta,
    },
  });
  for (const listener of this.listeners) listener(event);
}
```

- [ ] **Step 6: Share one simulated client and expose a simulated-only event trigger**

Create `apps/control-plane/src/lib/realtime/runtime-client.ts`:

```ts
import { SimulatedRealtimeClient } from "./simulated-client";

const simulatedBuild = import.meta.env.VITE_DATA_MODE === "simulated"
  || (!import.meta.env.VITE_DATA_MODE && !import.meta.env.PROD);

export const runtimeRealtimeClient = simulatedBuild
  ? new SimulatedRealtimeClient()
  : null;
```

Change SystemPage to use `runtimeRealtimeClient` instead of constructing its own client. Its reset action still calls `.reset()`. Components subscribe and unsubscribe their own listeners, but they must not construct competing client instances.

In the MSW handler module, add this strict request schema:

```ts
const simulatedMessageEventSchema = z.object({
  tenant_id: CommunicatorIdSchema,
  identity_id: CommunicatorIdSchema,
  connection_id: CommunicatorIdSchema,
  conversation_id: CommunicatorIdSchema,
  last_message_preview: z.string().max(280),
  last_activity_at: z.string().datetime({ offset: true }),
  unread_delta: z.number().int(),
}).strict();
```

Add `POST /api/v1/testing/realtime/message`. Parse the body, reject invalid input with the existing generic 400 response, verify the identity/connection/conversation ownership through `simulatedStore.conversation()`, call `await runtimeRealtimeClient?.connect()`, then call `runtimeRealtimeClient?.publishMessage(...)` and return `{ status: "published" }`. If the ownership chain fails, return the same generic 404 response. This route exists only in the browser's simulated MSW handlers; do not add it to the production Worker router.

Add handler tests for valid publication, cross-identity rejection, cross-channel rejection, and malformed input. Subscribe a test listener before the request and unsubscribe in `finally` so tests do not leak listeners.

- [ ] **Step 7: Subscribe from the shell**

Use `runtimeRealtimeClient`; it is null outside a simulated build. Connect it, subscribe while the shell is mounted, and unsubscribe during cleanup. Keep the last accepted sequence in a ref reset when tenant or identity changes. For an accepted update, call `queryClient.setQueryData` for:

```ts
queryKeys.conversations(identityId, undefined)
queryKeys.conversations(identityId, event.connection_id)
queryKeys.channels(identityId)
```

Conversation queries are TanStack `InfiniteData<ConversationPageResult>`. Preserve `pageParams` and replace only `pages` when `updatePages` returns a changed complete page. If a conversation cache has multiple pages or any non-null continuation cursor, invalidate that exact query instead of locally reordering it. This avoids duplicating or skipping rows under an obsolete cursor.

Do not update caches for a previous identity. Do not use provider/display label/title matching. Cleanup unsubscribes this shell listener on unmount or scope change. Do not close the shared client from ConversationsShell because SystemPage or a later mounted shell may use it; application/test reset owns `.reset()`.

- [ ] **Step 8: Run focused and complete TypeScript tests**

```bash
pnpm --filter @communicator/contracts test
pnpm --filter @communicator/control-plane test:ui -- src/features/conversations/apply-conversation-event.test.ts
pnpm --filter @communicator/control-plane test:ui -- src/mocks/handlers.test.ts src/features/system/system-page.test.tsx
pnpm test
```

Expected: all TypeScript tests pass; simulated realtime reorders conversations but not channel navigation.

- [ ] **Step 9: Commit Task 9**

```bash
git add packages/contracts/src/realtime.ts packages/contracts/test/schemas.test.ts apps/control-plane/src/lib/realtime/simulated-client.ts apps/control-plane/src/lib/realtime/runtime-client.ts apps/control-plane/src/features/conversations/apply-conversation-event.ts apps/control-plane/src/features/conversations/apply-conversation-event.test.ts apps/control-plane/src/mocks/handlers.ts apps/control-plane/src/mocks/handlers.test.ts apps/control-plane/src/features/system/system-page.tsx apps/control-plane/src/features/conversations/conversations-shell.tsx
git commit -m "feat: scope realtime inbox updates"
```

---

### Task 10: Prove the messenger shell through browser acceptance

**Files:**

- Create: `apps/control-plane/e2e/channel-conversations.spec.ts`
- Modify: `apps/control-plane/e2e/identity-isolation.spec.ts`
- Modify: `apps/control-plane/e2e/navigation.spec.ts`
- Modify: `apps/control-plane/e2e/responsive.spec.ts`
- Modify: `apps/control-plane/e2e/send-command.spec.ts`
- Modify: `apps/control-plane/src/features/system/system-page.tsx`
- Modify: `apps/control-plane/src/features/system/system-page.test.tsx`
- Modify: `docs/superpowers/specs/2026-08-28-communicator-channel-conversation-shell-design.md`

- [ ] **Step 1: Add browser journeys for the approved acceptance matrix**

Create one `beforeEach` that resets the ready simulation and confirms the visible simulated-data banner. Add focused tests for:

```ts
test("All and channel views preserve recency, labels, and separate contacts", async ({ page }) => {
  await page.goto("/conversations?identity=identity_human");
  const rows = page.getByTestId("conversation-row");
  await expect(rows).toHaveCount(6);
  await expect(rows.nth(0)).toContainText("Alex Rivera");
  await expect(rows.nth(0)).toContainText("Telegram");
  await expect(page.getByRole("link", { name: /Alex Rivera/ })).toHaveCount(2);

  await page.getByRole("button", { name: /Telegram/ }).click();
  await expect(page).toHaveURL(/channel=connection_human_telegram/);
  await expect(rows).toHaveCount(2);
});

test("identity and channel URL guesses fail symmetrically", async ({ page }) => {
  await page.goto("/conversations/conversation_agent_one?identity=identity_human&channel=connection_human_whatsapp");
  await expect(page.getByRole("alert")).toContainText("This conversation is unavailable.");
  await expect(page.getByText(/Agent WhatsApp/)).toHaveCount(0);

  await page.goto("/conversations/conversation_human_whatsapp_family?identity=identity_agent&channel=connection_agent_whatsapp");
  await expect(page.getByRole("alert")).toContainText("This conversation is unavailable.");
  await expect(page.getByText(/Personal WhatsApp/)).toHaveCount(0);
});
```

Add the realtime/order journey using the simulated-only endpoint:

```ts
test("message activity updates All without moving channel navigation", async ({ page }) => {
  await page.goto("/conversations?identity=identity_human");
  const channelNavigation = page.getByRole("navigation", { name: "Conversation channels" });
  await expect(channelNavigation.getByRole("button")).toHaveText([
    /All.*10/,
    /Personal WhatsApp.*5/,
    /Telegram.*3/,
    /Messenger.*2/,
    /Move Personal WhatsApp up/,
    /Move Personal WhatsApp down/,
    /Move Telegram up/,
    /Move Telegram down/,
    /Move Messenger up/,
    /Move Messenger down/,
  ]);

  const status = await page.evaluate(async () => {
    const response = await fetch("/api/v1/testing/realtime/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenant_id: "tenant_pilot",
        identity_id: "identity_human",
        connection_id: "connection_human_messenger",
        conversation_id: "conversation_human_messenger_archive",
        last_message_preview: "Newest simulated event",
        last_activity_at: "2026-08-28T00:08:00.000Z",
        unread_delta: 1,
      }),
    });
    return response.status;
  });
  expect(status).toBe(200);

  await expect(page.getByTestId("conversation-row").first()).toContainText("Old Client");
  await expect(channelNavigation.getByRole("button", { name: /All.*11/ })).toBeVisible();
  await expect(channelNavigation.getByRole("button", { name: /Messenger.*3/ })).toBeVisible();
  const labels = await channelNavigation.locator("[data-channel-id]").evaluateAll(
    (rows) => rows.map((row) => row.getAttribute("data-channel-id")),
  );
  expect(labels).toEqual([
    "connection_human_whatsapp",
    "connection_human_telegram",
    "connection_human_messenger",
  ]);
});
```

Give each channel row `data-channel-id={channel.id}` so the final order assertion is provider-independent.

Add these remaining browser tests as separate `test()` blocks with the named assertions shown:

| Test name | Required assertions |
|---|---|
| `manual channel order survives ordinary navigation` | Click **Move Telegram up**; navigate to Activity and back to Conversations; channel IDs remain Telegram, WhatsApp, Messenger. |
| `identity switch replaces every scoped surface` | Start on a Human Telegram thread; select Agent; URL becomes `/conversations?identity=identity_agent`; only Agent WhatsApp and Agent conversations remain; no Human labels remain. |
| `direct and paced sends stay on the opened connection` | Open one Telegram conversation, send Direct then Human-paced, inspect `/api/v1/commands?identity_id=identity_human`, and correlate both commands to that conversation whose fixture `connection_id` is Telegram. |
| `attention history remains readable but unsendable` | Reset `attention_required`; open Messenger history; timeline visible; textarea and delivery select disabled; repair link points to Connections with Human identity. |
| `mobile channel selection and back navigation work` | At 390×844, open **Channel: All**, select Telegram, open a thread, use **Back to conversations**, and observe the Telegram filter remains. |
| `tablet and desktop expose the intended panes` | At 1024px, channels/list/thread are visible and primary sidebar is hidden; at 1440px, primary navigation plus all three conversation panes are visible. |
| `production plus simulation fails closed` | Preserve the existing production-mode configuration test and assert the app refuses simulated handlers rather than displaying fixture data. |
| `simulated browser never contacts a live service` | Register the request guard described below and complete All, channel select, open, Direct send, and paced send without an unexpected host/path. |

The identity-guess test already proves both directions. The All test proves every row is channel-labelled and same-name contacts remain separate. Together with the realtime journey, this covers all 14 browser criteria without one giant test.

For the last proof, attach `page.on("request", ...)` before navigation. Collect only `${request.method()} ${new URL(request.url()).origin}${pathname}`. Fail if a request host is not the configured local Playwright origin or if an application fetch path is outside `/api/v1/`; allow Vite static assets and document navigation on the local origin. The assertion must not inspect or print request bodies, query values, protected headers, or response bodies.

- [ ] **Step 2: Make simulation reset clear channel-order preferences**

Import `clearChannelOrderPreferences` into SystemPage. In the existing successful reset callback, call it before invalidating queries. Add a test that saves a reordered preference, clicks reset, and expects `loadChannelOrder(...)` to return `[]`. This satisfies deterministic reset without making UI order authoritative server data.

- [ ] **Step 3: Run browser tests without retries**

```bash
pnpm --filter @communicator/control-plane test:e2e -- --retries=0
```

Expected: all browser tests pass at configured desktop, tablet, and mobile projects. If Playwright browsers are absent, install only the repository-pinned browser dependency with `pnpm exec playwright install chromium`, then rerun. Do not deploy or call an external provider.

- [ ] **Step 4: Run the complete repository verification**

```bash
pnpm test
pnpm check
python3 -m unittest discover -s tests -v
git diff --check
git status --short
```

Expected:

- all TypeScript unit, worker, UI, and browser tests pass;
- all package checks/builds pass;
- Python is either green or has only the documented pre-existing Telegram mode mismatch;
- `git diff --check` is silent; and
- status lists only intentional Task 10 changes.

If Python has any additional failure, stop and diagnose it before committing. Do not classify new failures as baseline.

- [ ] **Step 5: Mark the approved design implemented**

Change only the design status line to:

```markdown
**Status:** Implemented and verified in simulation
```

Do not claim live Matrix, provider, Cloudflare, or deployment integration.

- [ ] **Step 6: Commit Task 10**

```bash
git add apps/control-plane/e2e/channel-conversations.spec.ts apps/control-plane/e2e/identity-isolation.spec.ts apps/control-plane/e2e/navigation.spec.ts apps/control-plane/e2e/responsive.spec.ts apps/control-plane/e2e/send-command.spec.ts apps/control-plane/src/features/system/system-page.tsx apps/control-plane/src/features/system/system-page.test.tsx docs/superpowers/specs/2026-08-28-communicator-channel-conversation-shell-design.md
git commit -m "test: verify channel conversation workspace"
```

---

## Final implementation checkpoint

- [ ] Confirm the commit series is task-scoped:

```bash
git log --oneline --decorate main..HEAD
```

Expected implementation commit subjects, in chronological order after the already-approved design and plan documentation commits:

```text
feat: add channel summary contract
test: expand simulated multi-channel inbox
feat: expose identity-scoped channel queries
feat: add channel-aware API client
fix: reset conversation scope on identity switch
feat: add ordered channel navigation
feat: build responsive conversation shell
feat: bind message composer to channel capability
feat: scope realtime inbox updates
test: verify channel conversation workspace
```

Documentation commits such as `docs: design channel-aware conversation shell` and `docs: plan channel-aware conversation shell` remain in the branch and are not implementation-task failures.

- [ ] Confirm scope remained local and simulated:

```bash
git diff --name-only main...HEAD
git diff main...HEAD -- . ':!docs/superpowers/specs/2026-08-28-communicator-channel-conversation-shell-design.md' | rg -n 'wrangler deploy|cloudflare api|matrix\.communicator|mautrix|169\.58\.160\.23|ssh |scp '
```

Expected: the file list matches this plan. The risk-pattern scan has no matches from new implementation content.

- [ ] Confirm final quality gates one last time:

```bash
pnpm test
pnpm check
pnpm --filter @communicator/control-plane test:e2e -- --retries=0
git diff --check
git status --short --branch
```

Expected: every TypeScript and browser gate is green, diff check is silent, and the branch is clean and ahead of its base by the task commits.

## Explicitly deferred work

The following is outside this implementation and must remain absent from its commits:

- production authentication and principal scopes;
- account-linking or QR/login flows;
- D1 control directory;
- Durable Object SQLite and Cloudflare Queue consumers;
- R2 archive or Brain connector changes;
- live Matrix/mautrix ingestion;
- live WhatsApp, Telegram, Messenger, or LinkedIn traffic;
- merged contacts or cross-provider threads;
- break-glass UI;
- permanent unlink/archive policy; and
- production deployment or Cloudflare resource mutation.

The read models and query keys deliberately leave clean seams for those later systems: connection IDs remain canonical, tenant/identity/connection ownership is explicit, All and channel indexes map to the Durable Object projection, and realtime updates carry the scope needed for authenticated cache application.
