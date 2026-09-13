import { env, runInDurableObject } from "cloudflare:test";
import {
  ApiErrorResponseSchema,
  AccountGrantSchema,
  IdentitySchema,
  ConnectionSchema,
  ChannelSummarySchema,
  ConnectedAccountPageSchema,
  ConversationPageResultSchema,
  ConversationSummarySchema,
  MessagePageResultSchema,
  MessageSearchPageResultSchema,
  type ProjectionEventEnvelope,
  type SessionResponse,
} from "@communicator/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import type { VerifiedSubject } from "../../auth/oidc";
import {
  auth,
  bindingFor,
  deletionTombstone,
  event,
  initialize,
} from "../projection/projector-test-support";
import {
  clearDirectory,
  seedAccountAccess,
  seedDirectory,
} from "../support/directory-fixtures";
import {
  requireAuthorizedIdentity,
  toProjectionReadAuthorization,
} from "../../read/authorization";
import { ReadError, readErrorResponse } from "../../read/errors";

const workerEnv = env as typeof env & { CONTROL_DB: D1Database };
const tenantId = "tenant_pilot";

const createTestApp = () =>
  createApp({
    createTokenVerifier: () => ({
      verify: async (token: string): Promise<VerifiedSubject> => {
        if (token === "human-token") {
          return {
            issuer: "https://issuer.example/",
            subject: "human-subject",
          };
        }
        if (token === "agent-token") {
          return {
            issuer: "https://issuer.example/",
            subject: "agent-subject",
            token_id: "agent-token-id",
          };
        }
        throw new Error("invalid local test token");
      },
    }),
  });

const request = async (
  path: string,
  token = "human-token",
  init: RequestInit = {},
) =>
  createTestApp().request(
    `http://example.test${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    },
    workerEnv,
  );

const readEvent = (
  eventId: string,
  payload: Record<string, unknown>,
  eventType: ProjectionEventEnvelope["event_type"],
  overrides: Partial<ProjectionEventEnvelope>,
): ProjectionEventEnvelope =>
  event(eventId, payload, eventType, {
    tenant_id: tenantId,
    ...overrides,
  });

const readFixtures = async () => {
  const stub = workerEnv.TENANT_PROJECTION.getByName(tenantId);
  await initialize(tenantId);
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec("UPDATE projection_meta SET state = 'ready'");
  });
  await stub.applyBatch({
    schema_version: 1,
    tenant_id: tenantId,
    authorization: auth(
      ["projection.write"],
      ["identity_agent", "identity_human"],
      tenantId,
    ),
    mode: "live",
    rebuild_id: null,
    connections: [
      bindingFor(
        "account_agent",
        "connection_agent_whatsapp",
        "identity_agent",
      ),
      bindingFor(
        "account_human",
        "connection_human_whatsapp",
        "identity_human",
      ),
    ],
    events: [
      readEvent(
        "event_api_human_shell",
        { title: "Human conversation", archived: false, muted: false },
        "conversation.updated",
        {
          identity_id: "identity_human",
          account_id: "account_human",
          conversation_id: "conversation_human_one",
          occurred_at: "2026-09-07T01:00:00.000Z",
          observed_at: "2026-09-07T01:00:01.000Z",
        },
      ),
      readEvent(
        "event_api_human_message",
        {
          message_id: "message_human_one",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "Human contact",
          body: "human message body",
          reply_to_message_id: null,
          delivery_status: "delivered",
          unread: true,
        },
        "message.created",
        {
          identity_id: "identity_human",
          account_id: "account_human",
          conversation_id: "conversation_human_one",
          occurred_at: "2026-09-07T02:00:00.000Z",
          observed_at: "2026-09-07T02:00:01.000Z",
        },
      ),
      readEvent(
        "event_api_human_deleted_shell",
        { title: "Deleted conversation", archived: false, muted: false },
        "conversation.updated",
        {
          identity_id: "identity_human",
          account_id: "account_human",
          conversation_id: "conversation_human_deleted",
          occurred_at: "2026-09-07T03:00:00.000Z",
          observed_at: "2026-09-07T03:00:01.000Z",
        },
      ),
      readEvent(
        "event_api_human_second_shell",
        { title: "Second human conversation", archived: false, muted: false },
        "conversation.updated",
        {
          identity_id: "identity_human",
          account_id: "account_human",
          conversation_id: "conversation_human_two",
          occurred_at: "2026-09-07T01:30:00.000Z",
          observed_at: "2026-09-07T01:30:01.000Z",
        },
      ),
      deletionTombstone(
        "event_api_human_deleted",
        "conversation",
        "conversation_human_deleted",
        {
          tenant_id: tenantId,
          identity_id: "identity_human",
          account_id: "account_human",
          conversation_id: "conversation_human_deleted",
          occurred_at: "2026-09-07T04:00:00.000Z",
          observed_at: "2026-09-07T04:00:01.000Z",
        },
      ),
      readEvent(
        "event_api_agent_shell",
        { title: "Agent conversation", archived: false, muted: false },
        "conversation.updated",
        {
          identity_id: "identity_agent",
          account_id: "account_agent",
          conversation_id: "conversation_agent_one",
          occurred_at: "2026-09-07T05:00:00.000Z",
          observed_at: "2026-09-07T05:00:01.000Z",
        },
      ),
      readEvent(
        "event_api_agent_message",
        {
          message_id: "message_agent_one",
          direction: "inbound",
          sender_participant_id: null,
          sender_label: "Agent contact",
          body: "agent message body",
          reply_to_message_id: null,
          delivery_status: "delivered",
          unread: true,
        },
        "message.created",
        {
          identity_id: "identity_agent",
          account_id: "account_agent",
          conversation_id: "conversation_agent_one",
          occurred_at: "2026-09-07T06:00:00.000Z",
          observed_at: "2026-09-07T06:00:01.000Z",
        },
      ),
    ],
    checkpoint: null,
  });
  return stub;
};

const expectErrorResponse = async (response: Response, status: number) => {
  expect(response.status).toBe(status);
  const body = await response.json();
  expect(ApiErrorResponseSchema.parse(body)).toEqual(body);
  return body;
};

describe("read authorization helpers", () => {
  const session: SessionResponse = {
    tenant: { id: "tenant_pilot", slug: "pilot", display_name: "Pilot" },
    principal: { id: "principal_human", type: "human", display_name: "Human" },
    membership: { id: "membership_human", role: "owner" },
    identities: [
      {
        identity_id: "identity_human",
        kind: "human",
        display_name: "Human",
        scopes: ["conversation.read", "connection.read"],
      },
    ],
  };

  it("returns an identity only when the requested external scope is granted", () => {
    expect(
      requireAuthorizedIdentity(session, "identity_human", "conversation.read"),
    ).toEqual(session.identities[0]);
    expect(() =>
      requireAuthorizedIdentity(session, "identity_agent", "conversation.read"),
    ).toThrowError(ReadError);
    expect(() =>
      requireAuthorizedIdentity(
        {
          ...session,
          identities: [
            { ...session.identities[0]!, scopes: ["conversation.read"] },
          ],
        },
        "identity_human",
        "connection.read",
      ),
    ).toThrowError(ReadError);
  });

  it("builds the exact server-owned projection authorization context", () => {
    expect(toProjectionReadAuthorization(session, "identity_human")).toEqual({
      schema_version: 1,
      tenant_id: "tenant_pilot",
      principal_id: "principal_human",
      allowed_identity_ids: ["identity_human"],
      scopes: ["projection.read"],
    });
  });

  it("maps only bounded public read errors", () => {
    expect(readErrorResponse(new ReadError("invalid_request"))).toEqual({
      status: 400,
      body: { error: { code: "invalid_request", message: "Invalid request" } },
    });
    expect(readErrorResponse(new ReadError("not_found"))).toEqual({
      status: 404,
      body: { error: { code: "not_found", message: "Resource not found" } },
    });
    expect(readErrorResponse(new Error("secret internal failure"))).toEqual({
      status: 503,
      body: {
        error: { code: "service_unavailable", message: "Service unavailable" },
      },
    });
  });
});

describe("authenticated live read API", () => {
  beforeEach(async () => {
    await clearDirectory(workerEnv.CONTROL_DB);
    await seedDirectory(workerEnv.CONTROL_DB);
    await seedAccountAccess(workerEnv.CONTROL_DB);
  });

  it("returns only identities from the authenticated session and tenant-filtered connections", async () => {
    const identitiesResponse = await request("/api/v1/identities");
    expect(identitiesResponse.status).toBe(200);
    expect(
      IdentitySchema.array().parse(await identitiesResponse.json()),
    ).toEqual([
      {
        id: "identity_human",
        tenant_id: tenantId,
        kind: "human",
        display_name: "Human",
      },
    ]);

    const connectionsResponse = await request(
      "/api/v1/connections?identity_id=identity_human",
    );
    expect(connectionsResponse.status).toBe(200);
    const connections = ConnectionSchema.array().parse(
      await connectionsResponse.json(),
    );
    expect(connections.map((connection) => connection.id)).toEqual([
      "connection_human_whatsapp",
    ]);
    expect(connections[0]).not.toHaveProperty("sort_position");

    const agentResponse = await request(
      "/api/v1/connections?identity_id=identity_agent",
      "agent-token",
    );
    const agentConnections = ConnectionSchema.array().parse(
      await agentResponse.json(),
    );
    expect(agentConnections.map((connection) => connection.id)).toEqual([
      "connection_agent_whatsapp",
    ]);
  });

  it("merges D1 channel metadata with one projection aggregate and fills missing stats", async () => {
    await readFixtures();
    const response = await request(
      "/api/v1/identities/identity_human/channels",
    );
    expect(response.status).toBe(200);
    const channels = ChannelSummarySchema.array().parse(await response.json());

    expect(channels.map((channel) => channel.id)).toEqual([
      "connection_human_whatsapp",
    ]);
    expect(channels[0]).toMatchObject({
      id: "connection_human_whatsapp",
      unread_count: 1,
      last_activity_at: "2026-09-07T02:00:00.000Z",
      sort_position: 0,
      capabilities: ["message.send", "receipt.read", "typing.send"],
    });
  });

  it("preserves opaque seek cursors for conversations and messages", async () => {
    await readFixtures();
    const firstConversationResponse = await request(
      "/api/v1/identities/identity_human/conversations?limit=1",
    );
    const firstConversationPage = ConversationPageResultSchema.parse(
      await firstConversationResponse.json(),
    );
    expect(firstConversationResponse.status).toBe(200);
    expect(firstConversationPage.items.map((item) => item.id)).toEqual([
      "conversation_human_one",
    ]);
    expect(firstConversationPage.next_cursor).toEqual(expect.any(String));

    const secondConversationResponse = await request(
      `/api/v1/identities/identity_human/conversations?limit=1&cursor=${encodeURIComponent(firstConversationPage.next_cursor!)}`,
    );
    const secondConversationPage = ConversationPageResultSchema.parse(
      await secondConversationResponse.json(),
    );
    expect(secondConversationPage.items.map((item) => item.id)).toEqual([
      "conversation_human_two",
    ]);

    const exactResponse = await request(
      "/api/v1/identities/identity_human/conversations/conversation_human_one",
    );
    expect(
      ConversationSummarySchema.parse(await exactResponse.json()),
    ).toMatchObject({
      id: "conversation_human_one",
    });

    const firstMessageResponse = await request(
      "/api/v1/conversations/conversation_human_one/messages?identity_id=identity_human&limit=1",
    );
    const firstMessagePage = MessagePageResultSchema.parse(
      await firstMessageResponse.json(),
    );
    expect(firstMessageResponse.status).toBe(200);
    expect(firstMessagePage.items.map((item) => item.id)).toEqual([
      "message_human_one",
    ]);
    expect(firstMessagePage.next_cursor).toBeNull();

    const exactMessageResponse = await request(
      "/api/v1/conversations/conversation_human_one/messages?identity_id=identity_human&message_id=message_human_one&limit=1",
    );
    const exactMessagePage = MessagePageResultSchema.parse(
      await exactMessageResponse.json(),
    );
    expect(exactMessageResponse.status).toBe(200);
    expect(exactMessagePage).toMatchObject({
      items: [{ id: "message_human_one", body: "human message body" }],
      next_cursor: null,
    });

    const wrongConversationResponse = await request(
      "/api/v1/conversations/conversation_human_two/messages?identity_id=identity_human&message_id=message_human_one&limit=1",
    );
    const wrongConversationPage = MessagePageResultSchema.parse(
      await wrongConversationResponse.json(),
    );
    expect(wrongConversationResponse.status).toBe(200);
    expect(wrongConversationPage).toEqual({ items: [], next_cursor: null });
  });

  it("maps a delegated identity to a human-owned account for list, detail, and messages", async () => {
    await readFixtures();
    const beforeAccounts = await request(
      "/api/v1/accounts?identity_id=identity_agent",
      "agent-token",
    );
    expect(beforeAccounts.status).toBe(200);
    expect(
      ConnectedAccountPageSchema.parse(await beforeAccounts.json()).items.map(
        (item) => item.account_id,
      ),
    ).toEqual(["account_agent"]);
    const beforeGrantRead = await request(
      "/api/v1/accounts/account_human/conversations?identity_id=identity_agent",
      "agent-token",
    );
    expect(beforeGrantRead.status).toBe(404);

    const createGrant = await request("/api/v1/grants", "human-token", {
      method: "POST",
      body: JSON.stringify({
        membership_id: "membership_agent",
        identity_id: "identity_agent",
        account_id: "account_human",
        operation_scope: "conversation.read",
        chat_scope: "all_chats",
        chat_ids: [],
        idempotency_key: `cross-owner-${crypto.randomUUID()}`,
      }),
    });
    expect(createGrant.status).toBe(201);
    const grant = AccountGrantSchema.parse(await createGrant.json());
    expect(grant).toMatchObject({
      membership_id: "membership_agent",
      identity_id: "identity_agent",
      account_id: "account_human",
      chat_scope: "all_chats",
    });

    const accountsResponse = await request(
      "/api/v1/accounts?identity_id=identity_agent",
      "agent-token",
    );
    expect(accountsResponse.status).toBe(200);
    expect(
      ConnectedAccountPageSchema.parse(await accountsResponse.json()).items.map(
        (item) => item.account_id,
      ),
    ).toEqual(["account_agent", "account_human"]);

    const listResponse = await request(
      "/api/v1/accounts/account_human/conversations?identity_id=identity_agent",
      "agent-token",
    );
    expect(listResponse.status).toBe(200);
    expect(
      ConversationPageResultSchema.parse(await listResponse.json()).items.map(
        (item) => item.id,
      ),
    ).toEqual(["conversation_human_one", "conversation_human_two"]);

    const detailResponse = await request(
      "/api/v1/identities/identity_agent/conversations/conversation_human_one?account_id=account_human",
      "agent-token",
    );
    expect(detailResponse.status).toBe(200);
    expect(
      ConversationSummarySchema.parse(await detailResponse.json()).id,
    ).toBe("conversation_human_one");

    const messagesResponse = await request(
      "/api/v1/conversations/conversation_human_one/messages?identity_id=identity_agent&account_id=account_human",
      "agent-token",
    );
    expect(messagesResponse.status).toBe(200);
    expect(
      MessagePageResultSchema.parse(await messagesResponse.json()).items.map(
        (item) => item.id,
      ),
    ).toEqual(["message_human_one"]);

    const revokeGrant = await request(
      `/api/v1/grants/${grant.id}`,
      "human-token",
      {
        method: "DELETE",
        headers: {
          "Idempotency-Key": `cross-owner-revoke-${crypto.randomUUID()}`,
        },
      },
    );
    expect(revokeGrant.status).toBe(200);
    expect(AccountGrantSchema.parse(await revokeGrant.json()).status).toBe(
      "revoked",
    );
    const afterRevoke = await request(
      "/api/v1/accounts/account_human/conversations?identity_id=identity_agent",
      "agent-token",
    );
    expect(afterRevoke.status).toBe(404);
  });

  it("maps a channel filter to the trusted projection connection", async () => {
    await readFixtures();
    const response = await request(
      "/api/v1/identities/identity_human/conversations?channel_id=connection_human_whatsapp",
    );
    const page = ConversationPageResultSchema.parse(await response.json());
    expect(response.status).toBe(200);
    expect(page.items).toHaveLength(2);
    expect(page.items.map((item) => item.connection_id)).toEqual([
      "connection_human_whatsapp",
      "connection_human_whatsapp",
    ]);
  });

  it("searches stored messages with composed filters, bounded cursors, and tombstones", async () => {
    const stub = await readFixtures();
    await stub.applyBatch({
      schema_version: 1,
      tenant_id: tenantId,
      authorization: auth(
        ["projection.write"],
        ["identity_agent", "identity_human"],
        tenantId,
      ),
      mode: "live",
      rebuild_id: null,
      connections: [
        bindingFor(
          "account_agent",
          "connection_agent_whatsapp",
          "identity_agent",
        ),
        bindingFor(
          "account_human",
          "connection_human_whatsapp",
          "identity_human",
        ),
      ],
      events: [
        readEvent(
          "event_search_contact",
          {
            participant_id: "participant_search_contact",
            display_name: "Shared Contact",
            remote_id: "shared-contact",
            avatar_url: null,
          },
          "participant.updated",
          {
            identity_id: "identity_human",
            account_id: "account_human",
            conversation_id: "conversation_human_one",
            occurred_at: "2026-09-07T07:00:00.000Z",
            observed_at: "2026-09-07T07:00:01.000Z",
          },
        ),
        readEvent(
          "event_search_first",
          {
            message_id: "message_search_first",
            direction: "inbound",
            sender_participant_id: "participant_search_contact",
            sender_label: "Shared Contact",
            body: "alpha first",
            reply_to_message_id: null,
            delivery_status: "delivered",
            unread: true,
          },
          "message.created",
          {
            identity_id: "identity_human",
            account_id: "account_human",
            conversation_id: "conversation_human_one",
            occurred_at: "2026-09-07T08:00:00.000Z",
            observed_at: "2026-09-07T08:00:01.000Z",
          },
        ),
        readEvent(
          "event_search_second",
          {
            message_id: "message_search_second",
            direction: "outbound",
            sender_participant_id: null,
            sender_label: "Human owner",
            body: "beta reply",
            reply_to_message_id: null,
            delivery_status: "sent",
            unread: false,
          },
          "message.created",
          {
            identity_id: "identity_human",
            account_id: "account_human",
            conversation_id: "conversation_human_one",
            occurred_at: "2026-09-07T09:00:00.000Z",
            observed_at: "2026-09-07T09:00:01.000Z",
          },
        ),
        readEvent(
          "event_search_deleted",
          {
            message_id: "message_search_deleted",
            direction: "inbound",
            sender_participant_id: "participant_search_contact",
            sender_label: "Shared Contact",
            body: "secret old text",
            reply_to_message_id: null,
            delivery_status: "delivered",
            unread: false,
          },
          "message.created",
          {
            identity_id: "identity_human",
            account_id: "account_human",
            conversation_id: "conversation_human_one",
            occurred_at: "2026-09-07T10:00:00.000Z",
            observed_at: "2026-09-07T10:00:01.000Z",
          },
        ),
        deletionTombstone(
          "event_search_deleted_tombstone",
          "message",
          "message_search_deleted",
          {
            tenant_id: tenantId,
            identity_id: "identity_human",
            account_id: "account_human",
            conversation_id: "conversation_human_one",
            occurred_at: "2026-09-07T11:00:00.000Z",
            observed_at: "2026-09-07T11:00:01.000Z",
          },
        ),
        readEvent(
          "event_search_other_contact",
          {
            participant_id: "participant_search_other_contact",
            display_name: "Shared Contact",
            remote_id: "other-shared-contact",
            avatar_url: null,
          },
          "participant.updated",
          {
            identity_id: "identity_agent",
            account_id: "account_agent",
            conversation_id: "conversation_agent_one",
            occurred_at: "2026-09-07T12:00:00.000Z",
            observed_at: "2026-09-07T12:00:01.000Z",
          },
        ),
        readEvent(
          "event_search_other_message",
          {
            message_id: "message_search_other",
            direction: "inbound",
            sender_participant_id: "participant_search_other_contact",
            sender_label: "Shared Contact",
            body: "other account body",
            reply_to_message_id: null,
            delivery_status: "delivered",
            unread: true,
          },
          "message.created",
          {
            identity_id: "identity_agent",
            account_id: "account_agent",
            conversation_id: "conversation_agent_one",
            occurred_at: "2026-09-07T13:00:00.000Z",
            observed_at: "2026-09-07T13:00:01.000Z",
          },
        ),
      ],
      checkpoint: null,
    });

    const empty = await request(
      "/api/v1/search/messages?identity_id=identity_human&text=missing",
    );
    expect(empty.status).toBe(200);
    expect(MessageSearchPageResultSchema.parse(await empty.json())).toEqual({
      items: [],
      next_cursor: null,
    });

    const composed = await request(
      "/api/v1/search/messages?identity_id=identity_human&account_id=account_human&conversation_id=conversation_human_one&contact=Shared%20Contact&direction=outbound&from=2026-09-07T08:00:00.000Z&to=2026-09-07T10:00:00.000Z",
    );
    expect(composed.status).toBe(200);
    const composedPage = MessageSearchPageResultSchema.parse(
      await composed.json(),
    );
    expect(composedPage.items.map((item) => item.id)).toEqual([
      "message_search_second",
    ]);
    expect(composedPage.items[0]).toMatchObject({
      account_id: "account_human",
      conversation_id: "conversation_human_one",
      contact_id: "participant_search_contact",
      revision: "event_search_second",
      removed: false,
      attachments: [],
    });

    const crossAccountContact = await request(
      "/api/v1/search/messages?identity_id=identity_agent&account_id=account_agent&contact=Shared%20Contact",
      "agent-token",
    );
    expect(crossAccountContact.status).toBe(200);
    expect(
      MessageSearchPageResultSchema.parse(
        await crossAccountContact.json(),
      ).items.map((item) => item.id),
    ).toEqual(["message_search_other", "message_agent_one"]);

    const first = await request(
      "/api/v1/search/messages?identity_id=identity_human&account_id=account_human&limit=1",
    );
    const firstPage = MessageSearchPageResultSchema.parse(await first.json());
    expect(first.status).toBe(200);
    expect(firstPage.next_cursor).toEqual(expect.any(String));
    const reused = await request(
      `/api/v1/search/messages?identity_id=identity_human&account_id=account_human&text=alpha&cursor=${encodeURIComponent(firstPage.next_cursor!)}`,
    );
    await expectErrorResponse(reused, 400);

    // A rebuild generation change is the projection's established cursor
    // expiry signal; no wall-clock expiry is claimed for opaque seek cursors.
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE projection_meta SET generation = generation + 1 WHERE singleton = 1",
      );
    });
    const expired = await request(
      `/api/v1/search/messages?identity_id=identity_human&account_id=account_human&limit=1&cursor=${encodeURIComponent(firstPage.next_cursor!)}`,
    );
    await expectErrorResponse(expired, 400);

    const tombstones = await request(
      "/api/v1/search/messages?identity_id=identity_human&account_id=account_human&conversation_id=conversation_human_one",
    );
    const tombstonePage = MessageSearchPageResultSchema.parse(
      await tombstones.json(),
    );
    expect(tombstones.status).toBe(200);
    expect(
      tombstonePage.items.find((item) => item.id === "message_search_deleted"),
    ).toMatchObject({
      body: "",
      removed: true,
      removed_at: "2026-09-07T11:00:00.000Z",
      removal_reason: "retention",
      attachments: [],
    });

    await expectErrorResponse(
      await request(
        "/api/v1/search/messages?identity_id=identity_human&from=not-a-date",
      ),
      400,
    );
    await expectErrorResponse(
      await request(
        "/api/v1/search/messages?identity_id=identity_human&text=alpha%20alpha",
      ),
      400,
    );
  });

  it("uses byte-identical not-found responses for identity, missing, deleted, and cross-identity probes", async () => {
    await readFixtures();
    const paths = [
      "/api/v1/identities/identity_human/conversations/conversation_missing",
      "/api/v1/identities/identity_human/conversations/conversation_human_deleted",
      "/api/v1/identities/identity_human/conversations/conversation_agent_one",
      "/api/v1/identities/identity_agent/conversations/conversation_human_one",
    ];
    const bodies: string[] = [];
    for (const path of paths) {
      const response = await request(
        path,
        path.includes("identity_agent") ? "agent-token" : "human-token",
      );
      expect(response.status).toBe(404);
      bodies.push(await response.text());
    }
    expect(new Set(bodies)).toHaveLength(1);
    expect(bodies[0]).toBe(
      JSON.stringify({
        error: { code: "not_found", message: "Resource not found" },
      }),
    );
  });

  it("uses byte-identical invalid-request responses for malformed bounded inputs", async () => {
    const paths = [
      "/api/v1/identities/not-an-id/channels",
      `/api/v1/identities/identity_${"a".repeat(121)}/channels`,
      "/api/v1/identities/identity_human/conversations?limit=0",
      "/api/v1/identities/identity_human/conversations?limit=1&limit=2",
      "/api/v1/conversations/conversation_human_one/messages?identity_id=identity_human&cursor=",
    ];
    const bodies: string[] = [];
    for (const path of paths) {
      const response = await request(path);
      expect(response.status).toBe(400);
      bodies.push(await response.text());
    }
    expect(new Set(bodies)).toHaveLength(1);
    expect(bodies[0]).toBe(
      JSON.stringify({
        error: { code: "invalid_request", message: "Invalid request" },
      }),
    );
  });

  it("maps rebuilding projections and corrupt directory rows to generic 503 responses", async () => {
    const stub = await readFixtures();
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE projection_meta SET state = 'rebuilding'");
    });
    try {
      const response = await request(
        "/api/v1/identities/identity_human/channels",
      );
      await expectErrorResponse(response, 503);
    } finally {
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec("UPDATE projection_meta SET state = 'ready'");
      });
    }

    await workerEnv.CONTROL_DB.prepare(
      "UPDATE connections SET display_label = ? WHERE id = ?",
    )
      .bind("x".repeat(101), "connection_human_whatsapp")
      .run();
    const corruptResponse = await request(
      "/api/v1/connections?identity_id=identity_human",
    );
    await expectErrorResponse(corruptResponse, 503);
  });
});
