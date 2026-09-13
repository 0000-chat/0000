import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TenantProjectionDO } from "../../projection/tenant-projection";
import {
  decodeConversationCursor,
  encodeConversationCursor,
  encodeMessageCursor,
  decodeMessageCursor,
} from "../../projection/cursor";
import { ProjectionError } from "../../projection/errors";
import { ListProjectionConversationsInputSchema } from "@communicator/contracts";
import {
  auth,
  bindingFor,
  created,
  event,
  initialize,
  input,
  tenantId,
} from "./projector-test-support";

const queryAuth = (
  tenant: string,
  identities: string[] = ["identity_a"],
  scopes: ("projection.read" | "projection.write")[] = ["projection.read"],
) => auth(scopes, identities, tenant);

const conversationEvent = (
  tenant: string,
  eventId: string,
  conversationId: string,
  occurredAt: string,
  overrides: Record<string, unknown> = {},
) =>
  event(
    eventId,
    { title: conversationId, archived: false, muted: false },
    "conversation.updated",
    {
      tenant_id: tenant,
      conversation_id: conversationId,
      occurred_at: occurredAt,
      observed_at: new Date(Date.parse(occurredAt) + 1_000).toISOString(),
      ...overrides,
    },
  );

const messageCreatedEvent = (
  tenant: string,
  eventId: string,
  conversationId: string,
  messageId: string,
  occurredAt: string,
  overrides: Record<string, unknown> = {},
) =>
  created(eventId, {
    tenant_id: tenant,
    conversation_id: conversationId,
    occurred_at: occurredAt,
    observed_at: new Date(Date.parse(occurredAt) + 1_000).toISOString(),
    payload: {
      message_id: messageId,
      direction: "inbound",
      sender_participant_id: null,
      sender_label: "Sender",
      body: `body-${messageId}`,
      reply_to_message_id: null,
      delivery_status: "unknown",
      unread: true,
    },
    ...overrides,
  });

const readRows = async <T extends Record<string, SqlStorageValue>>(
  stub: DurableObjectStub<TenantProjectionDO>,
  sql: string,
  ...bindings: SqlStorageValue[]
): Promise<T[]> =>
  runInDurableObject(stub, async (_instance, state) =>
    state.storage.sql.exec<T>(sql, ...bindings).toArray(),
  );

const readTableSnapshots = async (
  stub: DurableObjectStub<TenantProjectionDO>,
): Promise<Record<string, Record<string, SqlStorageValue>[]>> =>
  runInDurableObject(stub, async (_instance, state) => {
    const names = state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      )
      .toArray();
    const snapshots: Record<string, Record<string, SqlStorageValue>[]> = {};
    for (const { name } of names) {
      if (!/^[A-Za-z0-9_]+$/.test(name))
        throw new Error("unexpected table name");
      snapshots[name] = state.storage.sql
        .exec<Record<string, SqlStorageValue>>(
          `SELECT * FROM "${name}" ORDER BY rowid`,
        )
        .toArray();
    }
    return snapshots;
  });

const setProjectionState = async (
  stub: DurableObjectStub<TenantProjectionDO>,
  stateValue: "ready" | "rebuilding" | "rebuild_failed",
) =>
  runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec("UPDATE projection_meta SET state = ?", stateValue);
  });

const expectQueryCode = async (
  stub: DurableObjectStub<TenantProjectionDO>,
  operation: (instance: TenantProjectionDO) => Promise<unknown>,
  code: string,
): Promise<void> => {
  const failure = await runInDurableObject(stub, async (instance) => {
    try {
      await operation(instance);
      return undefined;
    } catch (error) {
      return error;
    }
  });
  expect(failure).toMatchObject({ code, message: code });
};

const conversationCursor = {
  schema_version: 1 as const,
  query_kind: "projection.conversations" as const,
  tenant_id: "tenant_queries_cursor",
  identity_id: "identity_a",
  connection_id: null,
  generation: 1,
  last_activity_ms: 1,
  last_id: "conversation_a",
};

const encodeRawBase64Url = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

const expectProjectionCode = (operation: () => unknown, code: string): void => {
  let failure: unknown;
  try {
    operation();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ProjectionError);
  expect(failure).toMatchObject({ code, message: code });
};

describe("tenant projection query RPCs", () => {
  it("round-trips only canonical, strict conversation cursors", () => {
    const cursor = encodeConversationCursor(conversationCursor);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain("=");
    expect(decodeConversationCursor(cursor)).toEqual(conversationCursor);
    expectProjectionCode(
      () => decodeConversationCursor(""),
      "projection_invalid",
    );
    expectProjectionCode(
      () => decodeConversationCursor(`${cursor}=`),
      "projection_invalid",
    );
    expectProjectionCode(
      () => decodeConversationCursor("!"),
      "projection_invalid",
    );
    expectProjectionCode(
      () => decodeConversationCursor("A"),
      "projection_invalid",
    );
    expectProjectionCode(
      () => decodeConversationCursor("AB"),
      "projection_invalid",
    );
    expectProjectionCode(
      () => decodeConversationCursor("A".repeat(2_049)),
      "projection_invalid",
    );
    expectProjectionCode(
      () => decodeConversationCursor(encodeRawBase64Url("\xff")),
      "projection_invalid",
    );

    const noncanonical = JSON.stringify({
      schema_version: 1,
      query_kind: "projection.conversations",
      tenant_id: "tenant_queries_cursor",
      identity_id: "identity_a",
      connection_id: null,
      generation: 1,
      last_activity_ms: 1,
      last_id: "conversation_a",
    });
    expectProjectionCode(
      () => decodeConversationCursor(encodeRawBase64Url(noncanonical)),
      "projection_invalid",
    );
    expectProjectionCode(
      () =>
        decodeConversationCursor(
          encodeRawBase64Url(
            '{"schema_version":1,"query_kind":"projection.conversations","tenant_id":"tenant_queries_cursor","identity_id":"identity_a","connection_id":null,"generation":1,"last_activity_ms":1,"last_id":"conversation_a","last_id":"conversation_a"}',
          ),
        ),
      "projection_invalid",
    );
    expectProjectionCode(
      () => decodeConversationCursor(encodeRawBase64Url("[]")),
      "projection_invalid",
    );
    expectProjectionCode(
      () => decodeConversationCursor(encodeRawBase64Url("{")),
      "projection_invalid",
    );
    expectProjectionCode(
      () =>
        decodeConversationCursor(
          encodeRawBase64Url(
            '{"schema_version":1,"query_kind":"projection.conversations","tenant_id":"tenant_queries_cursor","identity_id":"identity_a","connection_id":null,"generation":1,"last_activity_ms":1,"last_id":"conversation_a","extra":true}',
          ),
        ),
      "projection_invalid",
    );
    expectProjectionCode(
      () => decodeConversationCursor(`${cursor} `),
      "projection_invalid",
    );
    for (const malformed of [
      '{"schema_version":2,"query_kind":"projection.conversations","tenant_id":"tenant_queries_cursor","identity_id":"identity_a","connection_id":null,"generation":1,"last_activity_ms":1,"last_id":"conversation_a"}',
      '{"schema_version":1,"query_kind":"projection.messages","tenant_id":"tenant_queries_cursor","identity_id":"identity_a","connection_id":null,"generation":1,"last_activity_ms":1,"last_id":"conversation_a"}',
      '{"schema_version":1,"query_kind":"projection.conversations","tenant_id":"not-an-id","identity_id":"identity_a","connection_id":null,"generation":1,"last_activity_ms":1,"last_id":"conversation_a"}',
      '{"schema_version":1,"query_kind":"projection.conversations","tenant_id":"tenant_queries_cursor","identity_id":"identity_a","connection_id":null,"generation":0,"last_activity_ms":1,"last_id":"conversation_a"}',
      '{"schema_version":1,"query_kind":"projection.conversations","tenant_id":"tenant_queries_cursor","identity_id":"identity_a","connection_id":null,"generation":1,"last_activity_ms":1.5,"last_id":"conversation_a"}',
      '{"schema_version":1,"query_kind":"projection.conversations","tenant_id":"tenant_queries_cursor","identity_id":"identity_a","connection_id":null,"generation":1,"last_activity_ms":9007199254740992,"last_id":"conversation_a"}',
      '{"schema_version":1,"query_kind":"projection.conversations","tenant_id":"tenant_queries_cursor","identity_id":"identity_a","connection_id":false,"generation":1,"last_activity_ms":1,"last_id":"conversation_a"}',
      '{"schema_version":1,"query_kind":"projection.conversations","tenant_id":"tenant_queries_cursor","identity_id":"identity_a","connection_id":null,"generation":1,"last_activity_ms":1,"last_id":4}',
      '{"schema_version":1,"query_kind":"projection.conversations","tenant_id":"tenant_queries_cursor","identity_id":"identity_a","connection_id":null,"generation":1,"last_activity_ms":1}',
    ]) {
      expectProjectionCode(
        () => decodeConversationCursor(encodeRawBase64Url(malformed)),
        "projection_invalid",
      );
    }

    expectProjectionCode(
      () =>
        decodeConversationCursor(cursor, {
          tenant_id: "tenant_other",
          identity_id: "identity_a",
          connection_id: null,
          generation: 1,
        }),
      "projection_tenant_mismatch",
    );
    expectProjectionCode(
      () =>
        decodeConversationCursor(cursor, {
          tenant_id: "tenant_queries_cursor",
          identity_id: "identity_b",
          connection_id: null,
          generation: 1,
        }),
      "projection_conflict",
    );
    expectProjectionCode(
      () =>
        decodeConversationCursor(cursor, {
          tenant_id: "tenant_queries_cursor",
          identity_id: "identity_a",
          connection_id: "connection_a",
          generation: 1,
        }),
      "projection_conflict",
    );
    expectProjectionCode(
      () =>
        decodeConversationCursor(cursor, {
          tenant_id: "tenant_queries_cursor",
          identity_id: "identity_a",
          connection_id: null,
          generation: 2,
        }),
      "projection_conflict",
    );
    const message = {
      schema_version: 1 as const,
      query_kind: "projection.messages" as const,
      tenant_id: "tenant_queries_cursor",
      identity_id: "identity_a",
      conversation_id: "conversation_a",
      generation: 1,
      last_occurred_ms: -1,
      last_id: "message_a",
    };
    const messageEncoded = encodeMessageCursor(message);
    expect(
      decodeMessageCursor(
        messageEncoded,
        "tenant_queries_cursor",
        "identity_a",
        "conversation_a",
        1,
      ),
    ).toEqual(message);
    expectProjectionCode(
      () =>
        decodeMessageCursor(
          messageEncoded,
          "tenant_other",
          "identity_a",
          "conversation_a",
          1,
        ),
      "projection_tenant_mismatch",
    );
    expectProjectionCode(
      () =>
        decodeMessageCursor(
          messageEncoded,
          "tenant_queries_cursor",
          "identity_b",
          "conversation_a",
          1,
        ),
      "projection_conflict",
    );
    expectProjectionCode(
      () =>
        decodeMessageCursor(
          messageEncoded,
          "tenant_queries_cursor",
          "identity_a",
          "conversation_b",
          1,
        ),
      "projection_conflict",
    );
    expectProjectionCode(
      () =>
        decodeMessageCursor(
          messageEncoded,
          "tenant_queries_cursor",
          "identity_a",
          "conversation_a",
          2,
        ),
      "projection_conflict",
    );
    expectProjectionCode(
      () => decodeConversationCursor(messageEncoded),
      "projection_invalid",
    );
  });

  it("lists a message-less conversation shell with a canonical seek cursor", async () => {
    const tenant = "tenant_queries_red";
    const stub = env.TENANT_PROJECTION.getByName(tenant);
    await initialize(tenant);

    const shellEvent = event(
      "event_queries_shell",
      { title: "Shell", archived: false, muted: false },
      "conversation.updated",
      {
        tenant_id: tenant,
        account_id: "account_a",
        conversation_id: "conversation_shell",
      },
    );
    await stub.applyBatch(
      input([shellEvent], {
        tenant_id: tenant,
        authorization: auth(["projection.write"], ["identity_a"], tenant),
        connections: [bindingFor("account_a", "connection_a")],
      }),
    );

    const page = await stub.listConversations({
      schema_version: 1,
      tenant_id: tenant,
      identity_id: "identity_a",
      connection_id: null,
      authorization: auth(["projection.read"], ["identity_a"], tenant),
    });

    expect(page.items).toEqual([
      {
        id: "conversation_shell",
        tenant_id: tenant,
        identity_id: "identity_a",
        account_id: "account_a",
        connection_id: "connection_a",
        event_id: "event_queries_shell",
        title: "Shell",
        last_message_preview: "",
        last_activity_at: shellEvent.occurred_at,
        unread_count: 0,
      },
    ]);
    expect(Object.keys(page.items[0]!).sort()).toEqual([
      "account_id",
      "connection_id",
      "event_id",
      "id",
      "identity_id",
      "last_activity_at",
      "last_message_preview",
      "tenant_id",
      "title",
      "unread_count",
    ]);
    expect(page.next_cursor).toBeNull();
    expect(tenantId).toBe("tenant_projector");

    const callerInput = {
      schema_version: 1 as const,
      tenant_id: tenant,
      identity_id: "identity_a",
      connection_id: null as string | null,
      authorization: auth(["projection.read"], ["identity_a"], tenant),
    };
    const callerMutationResult = await runInDurableObject(
      stub,
      async (instance) => {
        const pending = instance.listConversations(callerInput);
        callerInput.identity_id = "identity_b";
        callerInput.connection_id = "connection_b";
        callerInput.authorization = auth(
          ["projection.read"],
          ["identity_b"],
          tenant,
        );
        return pending;
      },
    );
    expect(callerMutationResult.items.map((item) => item.id)).toEqual([
      "conversation_shell",
    ]);
  });

  it("selects channel activity by epoch milliseconds with a deterministic tie-break", async () => {
    const tenant = "tenant_queries_channel_stats";
    const stub = env.TENANT_PROJECTION.getByName(tenant);
    await initialize(tenant);
    await stub.applyBatch(
      input(
        [
          conversationEvent(
            tenant,
            "event_channel_early",
            "conversation_channel_early",
            "2026-09-07T02:00:00.000+02:00",
          ),
          conversationEvent(
            tenant,
            "event_channel_latest_a",
            "conversation_channel_latest_a",
            "2026-09-07T01:30:00.000Z",
          ),
          conversationEvent(
            tenant,
            "event_channel_latest_b",
            "conversation_channel_latest_b",
            "2026-09-07T03:30:00.000+02:00",
          ),
        ],
        { tenant_id: tenant },
      ),
    );

    await expect(
      stub.listChannelStats({
        schema_version: 1,
        tenant_id: tenant,
        identity_id: "identity_a",
        authorization: queryAuth(tenant),
      }),
    ).resolves.toEqual([
      {
        connection_id: "connection_a",
        unread_count: 0,
        last_activity_at: "2026-09-07T01:30:00.000Z",
      },
    ]);
  });

  it("enforces read scope, identity grants, tenant binding, and lifecycle state", async () => {
    const tenant = "tenant_queries_auth";
    const stub = env.TENANT_PROJECTION.getByName(tenant);
    const uninitializedTenant = "tenant_queries_auth_uninitialized";
    await expectQueryCode(
      env.TENANT_PROJECTION.getByName(uninitializedTenant),
      (instance) =>
        instance.listConversations({
          schema_version: 1,
          tenant_id: uninitializedTenant,
          identity_id: "identity_a",
          connection_id: null,
          authorization: queryAuth(uninitializedTenant),
        }),
      "projection_not_found",
    );
    await initialize(tenant);
    const base = {
      schema_version: 1 as const,
      tenant_id: tenant,
      identity_id: "identity_a",
      connection_id: null,
      authorization: queryAuth(tenant),
    };

    await expectQueryCode(
      stub,
      (instance) =>
        instance.listConversations({
          ...base,
          authorization: queryAuth(
            tenant,
            ["identity_a"],
            ["projection.write"],
          ),
        }),
      "projection_forbidden",
    );
    await expectQueryCode(
      stub,
      (instance) =>
        instance.listConversations({
          ...base,
          authorization: queryAuth(tenant, ["identity_b"]),
        }),
      "projection_forbidden",
    );
    await expectQueryCode(
      stub,
      (instance) =>
        instance.listConversations({
          ...base,
          authorization: queryAuth("tenant_other"),
        }),
      "projection_tenant_mismatch",
    );

    await setProjectionState(stub, "rebuilding");
    await expectQueryCode(
      stub,
      (instance) => instance.listConversations(base),
      "projection_rebuilding",
    );
    await setProjectionState(stub, "rebuild_failed");
    await expectQueryCode(
      stub,
      (instance) => instance.listConversations(base),
      "projection_rebuild_failed",
    );
  });

  it("paginates conversations by the exact descending activity and ascending ID tuple", async () => {
    const tenant = "tenant_queries_conversations";
    const stub = env.TENANT_PROJECTION.getByName(tenant);
    await initialize(tenant);
    const sameTime = "2026-09-07T02:00:00.000Z";
    const events = [
      conversationEvent(tenant, "event_conv_c", "conversation_c", sameTime),
      conversationEvent(tenant, "event_conv_a", "conversation_a", sameTime),
      conversationEvent(tenant, "event_conv_b", "conversation_b", sameTime),
      conversationEvent(
        tenant,
        "event_conv_old",
        "conversation_old",
        "2026-09-07T01:00:00.000Z",
      ),
      conversationEvent(
        tenant,
        "event_conv_conn",
        "conversation_conn",
        sameTime,
        {
          account_id: "account_b",
        },
      ),
      conversationEvent(
        tenant,
        "event_conv_other",
        "conversation_other",
        sameTime,
        {
          identity_id: "identity_b",
          account_id: "account_c",
        },
      ),
      conversationEvent(
        tenant,
        "event_conv_deleted",
        "conversation_deleted",
        sameTime,
      ),
      event(
        "event_conv_delete_tombstone",
        {
          resource_type: "conversation",
          resource_id: "conversation_deleted",
          reason_code: "retention",
        },
        "deletion.tombstone",
        {
          tenant_id: tenant,
          conversation_id: "conversation_deleted",
          occurred_at: "2026-09-07T03:00:00.000Z",
          observed_at: "2026-09-07T03:00:01.000Z",
        },
      ),
    ];
    await stub.applyBatch(
      input(events, {
        tenant_id: tenant,
        authorization: auth(
          ["projection.write"],
          ["identity_a", "identity_b"],
          tenant,
        ),
        connections: [
          bindingFor("account_a", "connection_a", "identity_a"),
          bindingFor("account_b", "connection_b", "identity_a"),
          bindingFor("account_c", "connection_c", "identity_b"),
        ],
      }),
    );

    const allIds: string[] = [];
    let cursor: string | undefined;
    let firstCursor: string | null = null;
    do {
      const page = await stub.listConversations({
        schema_version: 1,
        tenant_id: tenant,
        identity_id: "identity_a",
        connection_id: null,
        page_size: 2,
        ...(cursor === undefined ? {} : { cursor }),
        authorization: queryAuth(tenant),
      });
      allIds.push(...page.items.map((item) => item.id));
      if (firstCursor === null) firstCursor = page.next_cursor;
      cursor = page.next_cursor ?? undefined;
      if (page.next_cursor !== null) {
        expect(page.items).toHaveLength(2);
      }
    } while (cursor !== undefined);

    expect(allIds).toEqual([
      "conversation_a",
      "conversation_b",
      "conversation_c",
      "conversation_conn",
      "conversation_old",
    ]);
    expect(new Set(allIds).size).toBe(allIds.length);

    expect(firstCursor).not.toBeNull();
    const reused = await stub.listConversations({
      schema_version: 1,
      tenant_id: tenant,
      identity_id: "identity_a",
      connection_id: null,
      page_size: 2,
      cursor: firstCursor!,
      authorization: queryAuth(tenant),
    });
    expect(reused.items.map((item) => item.id)).toEqual([
      "conversation_c",
      "conversation_conn",
    ]);
    await expectQueryCode(
      stub,
      (instance) =>
        instance.listConversations({
          schema_version: 1,
          tenant_id: tenant,
          identity_id: "identity_b",
          connection_id: null,
          page_size: 2,
          cursor: firstCursor!,
          authorization: queryAuth(tenant, ["identity_a", "identity_b"]),
        }),
      "projection_conflict",
    );
    await expectQueryCode(
      stub,
      (instance) =>
        instance.listConversations({
          schema_version: 1,
          tenant_id: tenant,
          identity_id: "identity_a",
          connection_id: "connection_b",
          page_size: 2,
          cursor: firstCursor!,
          authorization: queryAuth(tenant),
        }),
      "projection_conflict",
    );
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE projection_meta SET generation = 2");
    });
    await expectQueryCode(
      stub,
      (instance) =>
        instance.listConversations({
          schema_version: 1,
          tenant_id: tenant,
          identity_id: "identity_a",
          connection_id: null,
          page_size: 2,
          cursor: firstCursor!,
          authorization: queryAuth(tenant),
        }),
      "projection_conflict",
    );

    const filtered = await stub.listConversations({
      schema_version: 1,
      tenant_id: tenant,
      identity_id: "identity_a",
      connection_id: "connection_b",
      page_size: 100,
      authorization: queryAuth(tenant),
    });
    expect(filtered.items.map((item) => item.id)).toEqual([
      "conversation_conn",
    ]);
    expect(filtered.items[0]?.connection_id).toBe("connection_b");

    const accountAsConnection = await stub.listConversations({
      schema_version: 1,
      tenant_id: tenant,
      identity_id: "identity_a",
      connection_id: "account_b",
      authorization: queryAuth(tenant),
    });
    expect(accountAsConnection.items).toEqual([]);
    await expectQueryCode(
      stub,
      (instance) =>
        instance.listMessages({
          schema_version: 1,
          tenant_id: tenant,
          identity_id: "identity_a",
          conversation_id: "conversation_deleted",
          authorization: queryAuth(tenant),
        }),
      "projection_forbidden",
    );

    const pageSizeOne = await stub.listConversations({
      schema_version: 1,
      tenant_id: tenant,
      identity_id: "identity_a",
      connection_id: null,
      page_size: 1,
      authorization: queryAuth(tenant),
    });
    expect(pageSizeOne.items).toHaveLength(1);
    expect(pageSizeOne.next_cursor).not.toBeNull();
    const pageSizeFifty = await stub.listConversations({
      schema_version: 1,
      tenant_id: tenant,
      identity_id: "identity_a",
      connection_id: null,
      page_size: 50,
      authorization: queryAuth(tenant),
    });
    expect(pageSizeFifty.items).toHaveLength(5);
    expect(pageSizeFifty.next_cursor).toBeNull();
    const pageSizeHundred = await stub.listConversations({
      schema_version: 1,
      tenant_id: tenant,
      identity_id: "identity_a",
      connection_id: null,
      page_size: 100,
      authorization: queryAuth(tenant),
    });
    expect(pageSizeHundred.items).toHaveLength(5);
    expect(pageSizeHundred.next_cursor).toBeNull();
    await expectQueryCode(
      stub,
      (instance) =>
        instance.listConversations({
          schema_version: 1,
          tenant_id: tenant,
          identity_id: "identity_a",
          connection_id: null,
          page_size: 0,
          authorization: queryAuth(tenant),
        }),
      "projection_invalid",
    );
    await expectQueryCode(
      stub,
      (instance) =>
        instance.listConversations({
          schema_version: 1,
          tenant_id: tenant,
          identity_id: "identity_a",
          connection_id: null,
          page_size: 101,
          authorization: queryAuth(tenant),
        }),
      "projection_invalid",
    );
  });

  it("returns redacted deleted messages and isolates message pagination by conversation identity", async () => {
    const tenant = "tenant_queries_messages";
    const stub = env.TENANT_PROJECTION.getByName(tenant);
    await initialize(tenant);
    const messages = [
      messageCreatedEvent(
        tenant,
        "event_message_a",
        "conversation_messages",
        "message_a",
        "2026-09-07T02:00:00.000Z",
        {
          matrix_room_id: "!room:test",
          matrix_event_id: "$event:test",
          remote_message_id: "remote-secret",
        },
      ),
      messageCreatedEvent(
        tenant,
        "event_message_b",
        "conversation_messages",
        "message_b",
        "2026-09-07T02:00:00.000Z",
      ),
      messageCreatedEvent(
        tenant,
        "event_message_c",
        "conversation_messages",
        "message_c",
        "2026-09-07T01:00:00.000Z",
      ),
      event(
        "event_message_delete",
        { message_id: "message_b", reason_code: "retention" },
        "message.deleted",
        {
          tenant_id: tenant,
          conversation_id: "conversation_messages",
          occurred_at: "2026-09-07T03:00:00.000Z",
          observed_at: "2026-09-07T03:00:01.000Z",
        },
      ),
      messageCreatedEvent(
        tenant,
        "event_other_identity",
        "conversation_other_identity",
        "message_other",
        "2026-09-07T04:00:00.000Z",
        {
          identity_id: "identity_b",
          account_id: "account_b",
        },
      ),
    ];
    await stub.applyBatch(
      input(messages, {
        tenant_id: tenant,
        authorization: auth(
          ["projection.write"],
          ["identity_a", "identity_b"],
          tenant,
        ),
        connections: [
          bindingFor("account_a", "connection_a", "identity_a"),
          bindingFor("account_b", "connection_b", "identity_b"),
        ],
      }),
    );

    const page = await stub.listMessages({
      schema_version: 1,
      tenant_id: tenant,
      identity_id: "identity_a",
      conversation_id: "conversation_messages",
      page_size: 1,
      authorization: queryAuth(tenant),
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: "message_a",
      connection_id: "connection_a",
      body: "body-message_a",
      sender_label: "Sender",
    });
    expect(Object.keys(page.items[0]!).sort()).toEqual([
      "account_id",
      "attachment_count",
      "attachments",
      "body",
      "connection_id",
      "conversation_id",
      "delivery_status",
      "direction",
      "event_id",
      "id",
      "identity_id",
      "occurred_at",
      "sender_label",
      "sender_participant_id",
      "tenant_id",
    ]);
    expect(page.next_cursor).not.toBeNull();

    const second = await stub.listMessages({
      schema_version: 1,
      tenant_id: tenant,
      identity_id: "identity_a",
      conversation_id: "conversation_messages",
      page_size: 2,
      cursor: page.next_cursor!,
      authorization: queryAuth(tenant),
    });
    expect(second.items.map((item) => item.id)).toEqual([
      "message_b",
      "message_c",
    ]);
    expect(second.items[0]).toMatchObject({
      id: "message_b",
      body: "",
      sender_label: "Deleted sender",
      attachment_count: 0,
    });
    expect(second.next_cursor).toBeNull();

    for (const pageSize of [50, 100]) {
      const complete = await stub.listMessages({
        schema_version: 1,
        tenant_id: tenant,
        identity_id: "identity_a",
        conversation_id: "conversation_messages",
        page_size: pageSize,
        authorization: queryAuth(tenant),
      });
      expect(complete.items.map((item) => item.id)).toEqual([
        "message_a",
        "message_b",
        "message_c",
      ]);
      expect(complete.next_cursor).toBeNull();
    }
    await expectQueryCode(
      stub,
      (instance) =>
        instance.listMessages({
          schema_version: 1,
          tenant_id: tenant,
          identity_id: "identity_a",
          conversation_id: "conversation_messages",
          page_size: 0,
          authorization: queryAuth(tenant),
        }),
      "projection_invalid",
    );
    await expectQueryCode(
      stub,
      (instance) =>
        instance.listMessages({
          schema_version: 1,
          tenant_id: tenant,
          identity_id: "identity_a",
          conversation_id: "conversation_messages",
          page_size: 101,
          authorization: queryAuth(tenant),
        }),
      "projection_invalid",
    );

    await expectQueryCode(
      stub,
      (instance) =>
        instance.listMessages({
          schema_version: 1,
          tenant_id: tenant,
          identity_id: "identity_a",
          conversation_id: "conversation_other_identity",
          authorization: queryAuth(tenant),
        }),
      "projection_forbidden",
    );
  });

  it("resumes identity-filtered changes with identity-local latest sequence and exact floor boundaries", async () => {
    const tenant = "tenant_queries_changes";
    const stub = env.TENANT_PROJECTION.getByName(tenant);
    await initialize(tenant);
    const events = [
      conversationEvent(
        tenant,
        "event_change_a",
        "conversation_change_a",
        "2026-09-07T01:00:00.000Z",
      ),
      conversationEvent(
        tenant,
        "event_change_b",
        "conversation_change_b",
        "2026-09-07T01:01:00.000Z",
        {
          identity_id: "identity_b",
          account_id: "account_b",
        },
      ),
    ];
    await stub.applyBatch(
      input(events, {
        tenant_id: tenant,
        authorization: auth(
          ["projection.write"],
          ["identity_a", "identity_b"],
          tenant,
        ),
        connections: [
          bindingFor("account_a", "connection_a", "identity_a"),
          bindingFor("account_b", "connection_b", "identity_b"),
        ],
      }),
    );

    const identityA = await stub.listChanges({
      schema_version: 1,
      tenant_id: tenant,
      identity_id: "identity_a",
      generation: 1,
      after_sequence: 0,
      authorization: queryAuth(tenant),
    });
    expect(identityA.latest_sequence).toBe(1);
    expect(identityA.reset_required).toBe(false);
    expect(identityA.items.map((item) => item.sequence)).toEqual([1]);
    expect(Object.keys(identityA.items[0]!).sort()).toEqual([
      "connection_id",
      "conversation_id",
      "event_id",
      "event_type",
      "generation",
      "identity_id",
      "observed_at",
      "occurred_at",
      "sequence",
    ]);

    const identityB = await stub.listChanges({
      schema_version: 1,
      tenant_id: tenant,
      identity_id: "identity_b",
      generation: 1,
      after_sequence: 0,
      authorization: queryAuth(tenant, ["identity_b"]),
    });
    expect(identityB.latest_sequence).toBe(1);
    expect(identityB.items.map((item) => item.sequence)).toEqual([1]);

    await expect(
      readRows<{
        sequence: number;
        identity_sequence: number;
        identity_id: string;
      }>(
        stub,
        "SELECT sequence, identity_sequence, identity_id FROM projection_changes ORDER BY sequence",
      ),
    ).resolves.toEqual([
      { sequence: 1, identity_sequence: 1, identity_id: "identity_a" },
      { sequence: 2, identity_sequence: 1, identity_id: "identity_b" },
    ]);
    await expect(
      readRows<{ identity_id: string; latest_sequence: number }>(
        stub,
        "SELECT identity_id, latest_sequence FROM projection_identity_sequences ORDER BY identity_id",
      ),
    ).resolves.toEqual([
      { identity_id: "identity_a", latest_sequence: 1 },
      { identity_id: "identity_b", latest_sequence: 1 },
    ]);

    const floorRows = await readRows<{ identity_sequence: number }>(
      stub,
      "SELECT identity_sequence FROM projection_changes WHERE identity_id = ? ORDER BY identity_sequence",
      "identity_a",
    );
    expect(floorRows).toHaveLength(1);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO projection_change_floors (identity_id, discarded_through_sequence) VALUES (?, ?)",
        "identity_a",
        1,
      );
    });

    await expect(
      stub.listChanges({
        schema_version: 1,
        tenant_id: tenant,
        identity_id: "identity_a",
        generation: 1,
        after_sequence: 0,
        authorization: queryAuth(tenant),
      }),
    ).resolves.toMatchObject({
      items: [],
      latest_sequence: 1,
      reset_required: true,
    });
    await expect(
      stub.listChanges({
        schema_version: 1,
        tenant_id: tenant,
        identity_id: "identity_a",
        generation: 1,
        after_sequence: 1,
        authorization: queryAuth(tenant),
      }),
    ).resolves.toMatchObject({ latest_sequence: 1, reset_required: false });
    await expect(
      stub.listChanges({
        schema_version: 1,
        tenant_id: tenant,
        identity_id: "identity_a",
        generation: 1,
        after_sequence: 2,
        authorization: queryAuth(tenant),
      }),
    ).resolves.toMatchObject({
      items: [],
      latest_sequence: 1,
      reset_required: false,
    });
    await expectQueryCode(
      stub,
      (instance) =>
        instance.listChanges({
          schema_version: 1,
          tenant_id: tenant,
          identity_id: "identity_a",
          generation: 2,
          after_sequence: 1,
          authorization: queryAuth(tenant),
        }),
      "projection_conflict",
    );
  });

  it("keeps status latest change sequence after the highest identity counter rows are deleted", async () => {
    const tenant = "tenant_queries_status_sequence";
    const stub = env.TENANT_PROJECTION.getByName(tenant);
    await initialize(tenant);
    await stub.applyBatch(
      input(
        [
          conversationEvent(
            tenant,
            "event_status_sequence_a_1",
            "conversation_status_sequence_a_1",
            "2026-09-07T01:00:00.000Z",
          ),
          conversationEvent(
            tenant,
            "event_status_sequence_b_1",
            "conversation_status_sequence_b_1",
            "2026-09-07T01:01:00.000Z",
            { identity_id: "identity_b", account_id: "account_b" },
          ),
          conversationEvent(
            tenant,
            "event_status_sequence_a_2",
            "conversation_status_sequence_a_2",
            "2026-09-07T01:02:00.000Z",
          ),
        ],
        {
          tenant_id: tenant,
          authorization: auth(
            ["projection.write"],
            ["identity_a", "identity_b"],
            tenant,
          ),
          connections: [
            bindingFor("account_a", "connection_a", "identity_a"),
            bindingFor("account_b", "connection_b", "identity_b"),
          ],
        },
      ),
    );

    const statusInput = {
      schema_version: 1 as const,
      tenant_id: tenant,
      authorization: auth(["projection.status"], [], tenant),
    };
    const before = await stub.getStatus(statusInput);
    expect(before.latest_change_sequence).toBe(2);

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM projection_changes WHERE identity_id = ?",
        "identity_a",
      );
    });

    await expect(
      readRows<{ identity_id: string; latest_sequence: number }>(
        stub,
        "SELECT identity_id, latest_sequence FROM projection_identity_sequences ORDER BY identity_id",
      ),
    ).resolves.toEqual([
      { identity_id: "identity_a", latest_sequence: 2 },
      { identity_id: "identity_b", latest_sequence: 1 },
    ]);
    await expect(stub.getStatus(statusInput)).resolves.toMatchObject({
      latest_change_sequence: before.latest_change_sequence,
    });
  });

  it("returns zero latest sequence for an empty tenant and caps changes at 100", async () => {
    const emptyTenant = "tenant_queries_changes_empty";
    const emptyStub = env.TENANT_PROJECTION.getByName(emptyTenant);
    await initialize(emptyTenant);
    await expect(
      emptyStub.listChanges({
        schema_version: 1,
        tenant_id: emptyTenant,
        identity_id: "identity_a",
        generation: 1,
        after_sequence: 0,
        authorization: queryAuth(emptyTenant),
      }),
    ).resolves.toMatchObject({
      items: [],
      latest_sequence: 0,
      reset_required: false,
    });
    await expectQueryCode(
      emptyStub,
      (instance) =>
        instance.listChanges({
          schema_version: 1,
          tenant_id: emptyTenant,
          identity_id: "identity_a",
          generation: 1,
          after_sequence: 0,
          limit: 0,
          authorization: queryAuth(emptyTenant),
        }),
      "projection_invalid",
    );
    await expectQueryCode(
      emptyStub,
      (instance) =>
        instance.listChanges({
          schema_version: 1,
          tenant_id: emptyTenant,
          identity_id: "identity_a",
          generation: 1,
          after_sequence: 0,
          limit: 101,
          authorization: queryAuth(emptyTenant),
        }),
      "projection_invalid",
    );

    const tenant = "tenant_queries_changes_limit";
    const stub = env.TENANT_PROJECTION.getByName(tenant);
    await initialize(tenant);
    await runInDurableObject(stub, async (_instance, state) => {
      for (let index = 0; index < 101; index += 1) {
        state.storage.sql.exec(
          "INSERT INTO projection_changes (event_id, event_type, identity_id, account_id, connection_id, conversation_id, occurred_at, observed_at, generation, identity_sequence) VALUES (?, 'conversation.updated', ?, 'account_a', 'connection_a', ?, '2026-09-07T01:00:00.000Z', '2026-09-07T01:00:01.000Z', 1, ?)",
          `event_change_${String(index).padStart(3, "0")}`,
          "identity_a",
          `conversation_change_${String(index).padStart(3, "0")}`,
          index + 1,
        );
      }
      state.storage.sql.exec(
        "INSERT INTO projection_identity_sequences (identity_id, latest_sequence) VALUES (?, ?)",
        "identity_a",
        101,
      );
    });
    const page = await stub.listChanges({
      schema_version: 1,
      tenant_id: tenant,
      identity_id: "identity_a",
      generation: 1,
      after_sequence: 0,
      limit: 100,
      authorization: queryAuth(tenant),
    });
    expect(page.items).toHaveLength(100);
    expect(page.latest_sequence).toBe(101);
  });

  it("does not expose query helpers on the Durable Object prototype and does not mutate tables", async () => {
    expect(Object.getOwnPropertyNames(TenantProjectionDO.prototype)).toEqual([
      "constructor",
      "fetch",
      "webSocketMessage",
      "webSocketClose",
      "webSocketError",
      "alarm",
      "initialize",
      "getStatus",
      "applyBatch",
      "beginRebuild",
      "completeRebuild",
      "abortRebuild",
      "applyReplayPage",
      "resolveConversationOwner",
      "acceptTextReply",
      "claimOutboundDispatch",
      "reconcileOutbound",
      "decideOutbound",
      "listOutboundCommands",
      "listConversations",
      "getConversation",
      "listChannelStats",
      "getAttachment",
      "listAttachments",
      "listMessages",
      "searchMessages",
      "listChanges",
    ]);

    const tenant = "tenant_queries_read_only";
    const stub = env.TENANT_PROJECTION.getByName(tenant);
    await initialize(tenant);
    await stub.applyBatch(
      input(
        [
          conversationEvent(
            tenant,
            "event_read_only_conversation",
            "conversation_read_only",
            "2026-09-07T01:00:00.000Z",
          ),
          messageCreatedEvent(
            tenant,
            "event_read_only_message",
            "conversation_read_only",
            "message_read_only",
            "2026-09-07T01:01:00.000Z",
          ),
        ],
        { tenant_id: tenant },
      ),
    );
    const before = await readTableSnapshots(stub);
    await stub.listConversations({
      schema_version: 1,
      tenant_id: tenant,
      identity_id: "identity_a",
      connection_id: null,
      authorization: queryAuth(tenant),
    });
    await stub.listChanges({
      schema_version: 1,
      tenant_id: tenant,
      identity_id: "identity_a",
      generation: 1,
      after_sequence: 0,
      authorization: queryAuth(tenant),
    });
    await stub.listMessages({
      schema_version: 1,
      tenant_id: tenant,
      identity_id: "identity_a",
      conversation_id: "conversation_read_only",
      authorization: queryAuth(tenant),
    });
    const after = await readTableSnapshots(stub);
    expect(after).toEqual(before);
  });

  it("snapshots strict options and rejects accessor/symbol/prototype inputs", async () => {
    const tenant = "tenant_queries_hostile";
    await initialize(tenant);
    const getterInput: Record<string, unknown> = {
      schema_version: 1,
      tenant_id: tenant,
      identity_id: "identity_a",
      connection_id: null,
      authorization: queryAuth(tenant),
    };
    Object.defineProperty(getterInput, "page_size", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("page size getter must not run");
      },
    });
    expect(
      ListProjectionConversationsInputSchema.safeParse(getterInput).success,
    ).toBe(false);

    const symbolInput = {
      schema_version: 1,
      tenant_id: tenant,
      identity_id: "identity_a",
      connection_id: null,
      page_size: 1,
      authorization: queryAuth(tenant),
      [Symbol("bad")]: true,
    };
    expect(
      ListProjectionConversationsInputSchema.safeParse(symbolInput).success,
    ).toBe(false);

    const prototypeInput = Object.assign(
      Object.create({ page_size: 1 }) as Record<string, unknown>,
      {
        schema_version: 1,
        tenant_id: tenant,
        identity_id: "identity_a",
        connection_id: null,
        page_size: 1,
        authorization: queryAuth(tenant),
      },
    );
    expect(
      ListProjectionConversationsInputSchema.safeParse(prototypeInput).success,
    ).toBe(false);
  });

  it("uses the intended compound indexes for populated query shapes", async () => {
    const tenant = "tenant_queries_plans";
    const stub = env.TENANT_PROJECTION.getByName(tenant);
    await initialize(tenant);
    await stub.applyBatch(
      input(
        [
          conversationEvent(
            tenant,
            "event_plan_conv",
            "conversation_plan",
            "2026-09-07T01:00:00.000Z",
          ),
          messageCreatedEvent(
            tenant,
            "event_plan_message",
            "conversation_plan",
            "message_plan",
            "2026-09-07T01:00:00.000Z",
          ),
        ],
        {
          tenant_id: tenant,
          authorization: auth(["projection.write"], ["identity_a"], tenant),
          connections: [bindingFor("account_a", "connection_a")],
        },
      ),
    );
    const plans = await runInDurableObject(stub, async (_instance, state) => ({
      conversations: state.storage.sql
        .exec<{ detail: string }>(
          "EXPLAIN QUERY PLAN SELECT id FROM conversations WHERE identity_id = ? AND deleted_at IS NULL ORDER BY last_activity_ms DESC, id ASC LIMIT ?",
          "identity_a",
          51,
        )
        .toArray()
        .map((row) => row.detail),
      conversationsByConnection: state.storage.sql
        .exec<{ detail: string }>(
          "EXPLAIN QUERY PLAN SELECT id FROM conversations WHERE identity_id = ? AND connection_id = ? AND deleted_at IS NULL ORDER BY last_activity_ms DESC, id ASC LIMIT ?",
          "identity_a",
          "connection_a",
          51,
        )
        .toArray()
        .map((row) => row.detail),
      conversationsByConnectionSeek: state.storage.sql
        .exec<{ detail: string }>(
          "EXPLAIN QUERY PLAN SELECT id FROM conversations WHERE identity_id = ? AND connection_id = ? AND deleted_at IS NULL AND (last_activity_ms < ? OR (last_activity_ms = ? AND id > ?)) ORDER BY last_activity_ms DESC, id ASC LIMIT ?",
          "identity_a",
          "connection_a",
          1,
          1,
          "conversation_plan",
          51,
        )
        .toArray()
        .map((row) => row.detail),
      conversationsSeek: state.storage.sql
        .exec<{ detail: string }>(
          "EXPLAIN QUERY PLAN SELECT id FROM conversations WHERE identity_id = ? AND deleted_at IS NULL AND (last_activity_ms < ? OR (last_activity_ms = ? AND id > ?)) ORDER BY last_activity_ms DESC, id ASC LIMIT ?",
          "identity_a",
          1,
          1,
          "conversation_plan",
          51,
        )
        .toArray()
        .map((row) => row.detail),
      messages: state.storage.sql
        .exec<{ detail: string }>(
          "EXPLAIN QUERY PLAN SELECT id FROM messages WHERE identity_id = ? AND conversation_id = ? ORDER BY occurred_ms DESC, id ASC LIMIT ?",
          "identity_a",
          "conversation_plan",
          51,
        )
        .toArray()
        .map((row) => row.detail),
      messagesSeek: state.storage.sql
        .exec<{ detail: string }>(
          "EXPLAIN QUERY PLAN SELECT id FROM messages WHERE identity_id = ? AND conversation_id = ? AND (occurred_ms < ? OR (occurred_ms = ? AND id > ?)) ORDER BY occurred_ms DESC, id ASC LIMIT ?",
          "identity_a",
          "conversation_plan",
          1,
          1,
          "message_plan",
          51,
        )
        .toArray()
        .map((row) => row.detail),
      changes: state.storage.sql
        .exec<{ detail: string }>(
          "EXPLAIN QUERY PLAN SELECT identity_sequence FROM projection_changes WHERE identity_id = ? AND identity_sequence > ? ORDER BY identity_sequence ASC LIMIT ?",
          "identity_a",
          0,
          100,
        )
        .toArray()
        .map((row) => row.detail),
    }));
    expect(plans.conversations.join(" ")).toContain(
      "idx_conversations_identity_activity",
    );
    expect(plans.conversationsByConnection.join(" ")).toContain(
      "idx_conversations_identity_connection_activity",
    );
    expect(plans.conversationsByConnectionSeek.join(" ")).toContain(
      "idx_conversations_identity_connection_activity",
    );
    expect(plans.conversationsSeek.join(" ")).toContain(
      "idx_conversations_identity_activity",
    );
    expect(plans.messages.join(" ")).toContain(
      "idx_messages_identity_conversation_occurred",
    );
    expect(plans.messagesSeek.join(" ")).toContain(
      "idx_messages_identity_conversation_occurred",
    );
    expect(plans.changes.join(" ")).toContain(
      "idx_projection_changes_identity_sequence",
    );
    for (const details of Object.values(plans)) {
      expect(details.join(" ")).not.toMatch(
        /SCAN (conversations|messages|projection_changes)/i,
      );
      expect(details.join(" ")).not.toMatch(/USE TEMP B-TREE/i);
    }
  });
});
