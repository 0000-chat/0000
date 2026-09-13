import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import {
  type GetProjectionConversationInput,
  type ListProjectionChannelStatsInput,
} from "@communicator/contracts";
import { describe, expect, it } from "vitest";
import { ProjectionError } from "../../projection/errors";
import { TenantProjectionDO } from "../../projection/tenant-projection";
import {
  auth,
  bindingFor,
  created,
  deletionTombstone,
  event,
  initialize,
  input,
} from "../projection/projector-test-support";

const expectCode = async (
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
  expect(failure).toBeInstanceOf(ProjectionError);
  expect(failure).toMatchObject({ code, message: code });
};

const tenant = "tenant_read_rpc";
const identity = "identity_a";
const readAuthorization = auth(["projection.read"], [identity], tenant);

const conversationInput = (
  conversationId: string,
  authorization = readAuthorization,
): GetProjectionConversationInput => ({
  schema_version: 1,
  tenant_id: tenant,
  identity_id: identity,
  conversation_id: conversationId,
  authorization,
});

const statsInput = (
  authorization = readAuthorization,
): ListProjectionChannelStatsInput => ({
  schema_version: 1,
  tenant_id: tenant,
  identity_id: identity,
  authorization,
});

const applyReadFixtures = async () => {
  const stub = env.TENANT_PROJECTION.getByName(tenant);
  await initialize(tenant);
  await stub.applyBatch(
    input(
      [
        event(
          "event_read_conversation_shell",
          { title: "Conversation A", archived: false, muted: false },
          "conversation.updated",
          {
            tenant_id: tenant,
            identity_id: identity,
            account_id: "account_a",
            conversation_id: "conversation_a",
            occurred_at: "2026-09-07T01:00:00.000Z",
            observed_at: "2026-09-07T01:00:01.000Z",
          },
        ),
        created("event_read_message_a", {
          tenant_id: tenant,
          identity_id: identity,
          account_id: "account_a",
          conversation_id: "conversation_a",
          occurred_at: "2026-09-07T02:00:00.000Z",
          observed_at: "2026-09-07T02:00:01.000Z",
          payload: {
            message_id: "message_a",
            direction: "inbound",
            sender_participant_id: null,
            sender_label: "Alice",
            body: "hello",
            reply_to_message_id: null,
            delivery_status: "unknown",
            unread: true,
          },
        }),
        created("event_read_message_c", {
          tenant_id: tenant,
          identity_id: identity,
          account_id: "account_c",
          conversation_id: "conversation_c",
          occurred_at: "2026-09-07T03:00:00.000Z",
          observed_at: "2026-09-07T03:00:01.000Z",
          payload: {
            message_id: "message_c",
            direction: "inbound",
            sender_participant_id: null,
            sender_label: "Carol",
            body: "later",
            reply_to_message_id: null,
            delivery_status: "unknown",
            unread: false,
          },
        }),
        created("event_read_agent_message", {
          tenant_id: tenant,
          identity_id: "identity_b",
          account_id: "account_b",
          conversation_id: "conversation_b",
          occurred_at: "2026-09-07T04:00:00.000Z",
          observed_at: "2026-09-07T04:00:01.000Z",
          payload: {
            message_id: "message_b",
            direction: "inbound",
            sender_participant_id: null,
            sender_label: "Agent contact",
            body: "agent-only",
            reply_to_message_id: null,
            delivery_status: "unknown",
            unread: true,
          },
        }),
        created("event_read_message_a_two", {
          tenant_id: tenant,
          identity_id: identity,
          account_id: "account_a",
          conversation_id: "conversation_a_two",
          occurred_at: "2026-09-07T05:00:00.000Z",
          observed_at: "2026-09-07T05:00:01.000Z",
          payload: {
            message_id: "message_a_two",
            direction: "inbound",
            sender_participant_id: null,
            sender_label: "Alice two",
            body: "second hello",
            reply_to_message_id: null,
            delivery_status: "unknown",
            unread: true,
          },
        }),
        created("event_read_deleted_message", {
          tenant_id: tenant,
          identity_id: identity,
          account_id: "account_a",
          conversation_id: "conversation_deleted",
          occurred_at: "2026-09-07T05:00:00.000Z",
          observed_at: "2026-09-07T05:00:01.000Z",
          payload: {
            message_id: "message_deleted",
            direction: "inbound",
            sender_participant_id: null,
            sender_label: "Deleted contact",
            body: "deleted body",
            reply_to_message_id: null,
            delivery_status: "unknown",
            unread: true,
          },
        }),
        deletionTombstone(
          "event_read_deleted_conversation",
          "conversation",
          "conversation_deleted",
          {
            tenant_id: tenant,
            identity_id: identity,
            account_id: "account_a",
            conversation_id: "conversation_deleted",
            occurred_at: "2026-09-07T06:00:00.000Z",
            observed_at: "2026-09-07T06:00:01.000Z",
          },
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
          bindingFor("account_c", "connection_c", "identity_a"),
        ],
      },
    ),
  );
  return stub;
};

describe("TenantProjectionDO read RPCs", () => {
  it("returns an exact authorized conversation and null for every miss", async () => {
    const stub = await applyReadFixtures();

    await expect(
      stub.getConversation(conversationInput("conversation_a")),
    ).resolves.toMatchObject({
      id: "conversation_a",
      tenant_id: tenant,
      identity_id: identity,
      connection_id: "connection_a",
      title: "Conversation A",
      last_message_preview: "hello",
      last_activity_at: "2026-09-07T02:00:00.000Z",
      unread_count: 1,
    });
    await expect(
      stub.getConversation(conversationInput("conversation_missing")),
    ).resolves.toBeNull();
    await expect(
      stub.getConversation(conversationInput("conversation_deleted")),
    ).resolves.toBeNull();
    await expect(
      stub.getConversation(conversationInput("conversation_b")),
    ).resolves.toBeNull();
  });

  it("returns one sorted aggregate per active connection for the identity", async () => {
    const stub = await applyReadFixtures();

    await expect(stub.listChannelStats(statsInput())).resolves.toEqual([
      {
        connection_id: "connection_a",
        unread_count: 2,
        last_activity_at: "2026-09-07T05:00:00.000Z",
      },
      {
        connection_id: "connection_c",
        unread_count: 0,
        last_activity_at: "2026-09-07T03:00:00.000Z",
      },
    ]);
  });

  it("does not mutate projection state while serving reads", async () => {
    const stub = await applyReadFixtures();
    const before = await runInDurableObject(stub, async (_instance, state) => ({
      changes: state.storage.sql
        .exec("SELECT * FROM projection_changes ORDER BY sequence")
        .toArray(),
      checkpoints: state.storage.sql
        .exec("SELECT * FROM projection_checkpoints ORDER BY kind")
        .toArray(),
      events: state.storage.sql
        .exec("SELECT * FROM applied_events ORDER BY event_id")
        .toArray(),
    }));

    await stub.getConversation(conversationInput("conversation_a"));
    await stub.listChannelStats(statsInput());

    const after = await runInDurableObject(stub, async (_instance, state) => ({
      changes: state.storage.sql
        .exec("SELECT * FROM projection_changes ORDER BY sequence")
        .toArray(),
      checkpoints: state.storage.sql
        .exec("SELECT * FROM projection_checkpoints ORDER BY kind")
        .toArray(),
      events: state.storage.sql
        .exec("SELECT * FROM applied_events ORDER BY event_id")
        .toArray(),
    }));
    expect(after).toEqual(before);
  });

  it("preserves read results after Durable Object eviction", async () => {
    const stub = await applyReadFixtures();
    const before = await stub.listChannelStats(statsInput());
    await evictDurableObject(stub);
    const after = await stub.listChannelStats(statsInput());
    expect(after).toEqual(before);
  });

  it("fails closed for missing, unauthorized, wrong-tenant, and non-ready state", async () => {
    const uninitialized = env.TENANT_PROJECTION.getByName(
      "tenant_read_uninitialized",
    );
    await expectCode(
      uninitialized,
      (instance) =>
        instance.getConversation({
          ...conversationInput("conversation_a"),
          tenant_id: "tenant_read_uninitialized",
          authorization: auth(
            ["projection.read"],
            [identity],
            "tenant_read_uninitialized",
          ),
        }),
      "projection_not_found",
    );

    const stub = await applyReadFixtures();
    await expectCode(
      stub,
      (instance) =>
        instance.getConversation(
          conversationInput(
            "conversation_a",
            auth(["projection.write"], [identity], tenant),
          ),
        ),
      "projection_forbidden",
    );
    await expectCode(
      stub,
      (instance) =>
        instance.getConversation(
          conversationInput(
            "conversation_a",
            auth(["projection.read"], ["identity_b"], tenant),
          ),
        ),
      "projection_forbidden",
    );
    await expectCode(
      stub,
      (instance) =>
        instance.getConversation(
          conversationInput(
            "conversation_a",
            auth(["projection.read"], [identity], "tenant_other"),
          ),
        ),
      "projection_tenant_mismatch",
    );

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE projection_meta SET state = 'rebuilding'");
    });
    await expectCode(
      stub,
      (instance) => instance.listChannelStats(statsInput()),
      "projection_rebuilding",
    );
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE projection_meta SET state = 'ready'");
    });
  });

  it("maps persisted corruption to the generic unavailable projection error", async () => {
    const stub = await applyReadFixtures();
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE conversations SET last_activity_at = ? WHERE id = ?",
        "not-a-timestamp",
        "conversation_a",
      );
    });

    await expectCode(
      stub,
      (instance) =>
        instance.getConversation(conversationInput("conversation_a")),
      "projection_unavailable",
    );
  });
});
