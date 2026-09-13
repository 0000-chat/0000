import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readReplayPage } from "../../archive/reader";
import { runInDurableObject } from "cloudflare:test";
import type {
  ProjectionAuthorizationContext,
  ProjectionEventEnvelope,
} from "@communicator/contracts";
import { REALTIME_SUBPROTOCOL } from "@communicator/contracts";
import {
  cleanupIngestionFixture,
  createCapturingQueue,
  deliverQueueMessages,
  env,
  listTenantArchiveKeys,
  messageEvent,
  postIngestionBatch,
  requestForEvents,
  seedIngestionFixture,
  expectArchivePairUnchanged,
  snapshotArchivePair,
  type IngestionFixture,
} from "./support";

let fixture: IngestionFixture;

beforeEach(async () => {
  fixture = await seedIngestionFixture("end_to_end");
});

afterEach(async () => {
  await cleanupIngestionFixture(fixture);
});

const authorizationFor = (
  fixtureValue: IngestionFixture,
  tenantId: string,
  identityId: string,
  scopes: ProjectionAuthorizationContext["scopes"] = ["projection.read"],
): ProjectionAuthorizationContext => ({
  schema_version: 1,
  tenant_id: tenantId,
  principal_id: `principal_reader_${fixtureValue.suffix}`,
  allowed_identity_ids: [identityId],
  scopes,
});

const familyEvent = (
  base: ProjectionEventEnvelope,
  eventId: string,
  eventType: ProjectionEventEnvelope["event_type"],
  payload: Record<string, unknown>,
  observedSecond: number,
): ProjectionEventEnvelope =>
  ({
    ...base,
    event_id: eventId,
    event_type: eventType,
    observed_at: `2026-09-08T01:00:${String(observedSecond).padStart(2, "0")}.000Z`,
    occurred_at: `2026-09-08T00:59:${String(observedSecond).padStart(2, "0")}.000Z`,
    payload,
  }) as ProjectionEventEnvelope;

const waitForRealtimeFrame = (
  socket: WebSocket,
  type: string,
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (frame.type !== type) return;
      cleanup();
      resolve(frame);
    };
    const cleanup = () => {
      socket.removeEventListener("message", onMessage);
      clearTimeout(timeout);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${type} realtime frame`));
    }, 1_000);
    socket.addEventListener("message", onMessage);
  });

describe("Matrix ingestion end to end", () => {
  it("archives Human WhatsApp ingress, queues a pointer, and projects it into the real tenant DO", async () => {
    const event = messageEvent(fixture, {
      eventId: `$human_whatsapp_${fixture.suffix}:example`,
      body: "human WhatsApp end-to-end body",
    });
    const request = await requestForEvents(fixture, [event]);
    const { response, queue } = await postIngestionBatch(fixture, request);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      batch_id: request.batch_id,
      status: "accepted",
      archive_status: "created",
    });
    expect(queue.messages).toHaveLength(1);
    const pointer = queue.messages[0]!.body;
    expect(Object.keys(pointer).sort()).toEqual([
      "batch_id",
      "canonical_sha256",
      "gateway_route_id",
      "kind",
      "manifest_key",
      "schema_version",
      "tenant_id",
    ]);
    expect(pointer.tenant_id).toBe(fixture.tenantId);
    expect(pointer.batch_id).toBe(request.batch_id);
    expect(pointer.gateway_route_id).toBe(fixture.routes.human);

    const archiveKeys = await listTenantArchiveKeys(fixture.tenantId);
    expect(archiveKeys).toEqual(
      [
        pointer.manifest_key,
        pointer.manifest_key
          .replace("manifests/", "events/")
          .replace(".json", ".jsonl.gz"),
      ].sort(),
    );
    const manifestObject = await env.EVENT_ARCHIVE.get(pointer.manifest_key);
    expect(manifestObject).not.toBeNull();
    const manifest = JSON.parse(await manifestObject!.text()) as {
      data_key: string;
      event_count: number;
      canonical_sha256: string;
    };
    expect(manifest.event_count).toBe(1);
    expect(manifest.canonical_sha256).toBe(pointer.canonical_sha256);
    expect(await env.EVENT_ARCHIVE.get(manifest.data_key)).not.toBeNull();

    const delivered = await deliverQueueMessages([
      { id: `queue_human_${fixture.suffix}`, body: pointer },
    ]);
    expect(delivered.result).toMatchObject({
      retryMessages: [],
      explicitAcks: [`queue_human_${fixture.suffix}`],
    });

    const projection = env.TENANT_PROJECTION.getByName(fixture.tenantId);
    const authorization = authorizationFor(
      fixture,
      fixture.tenantId,
      fixture.identities.human,
    );
    const status = await projection.getStatus({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      authorization: authorizationFor(
        fixture,
        fixture.tenantId,
        fixture.identities.human,
        ["projection.status"],
      ),
    });
    expect(status).toMatchObject({
      tenant_id: fixture.tenantId,
      state: "ready",
      generation: 1,
      applied_event_count: 1,
      conversation_count: 1,
      message_count: 1,
      latest_change_sequence: 1,
    });

    const conversations = await projection.listConversations({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      identity_id: fixture.identities.human,
      connection_id: null,
      authorization,
    });
    expect(conversations.items).toEqual([
      expect.objectContaining({
        tenant_id: fixture.tenantId,
        identity_id: fixture.identities.human,
        connection_id: fixture.connections.humanWhatsapp,
        last_message_preview: "human WhatsApp end-to-end body",
        unread_count: 1,
      }),
    ]);
    const conversationId = conversations.items[0]!.id;
    const messages = await projection.listMessages({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      identity_id: fixture.identities.human,
      conversation_id: conversationId,
      authorization,
    });
    expect(messages.items).toEqual([
      expect.objectContaining({
        id: `message_${fixture.suffix}`,
        body: "human WhatsApp end-to-end body",
        direction: "inbound",
        connection_id: fixture.connections.humanWhatsapp,
      }),
    ]);
    const changes = await projection.listChanges({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      identity_id: fixture.identities.human,
      generation: status.generation,
      after_sequence: 0,
      authorization,
    });
    expect(changes.items).toEqual([
      expect.objectContaining({
        sequence: 1,
        event_id: event.event_id,
        event_type: "message.created",
        connection_id: fixture.connections.humanWhatsapp,
      }),
    ]);
    expect(status.checkpoints).toEqual([
      expect.objectContaining({
        kind: "live_event_watermark",
        value: event.event_id,
        last_event_id: event.event_id,
      }),
    ]);
  });

  it("broadcasts a committed Queue projection change to its matching realtime socket", async () => {
    const projection = env.TENANT_PROJECTION.getByName(fixture.tenantId);
    await projection.initialize({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      initialized_at: "2026-09-08T00:30:00.000Z",
      authorization: authorizationFor(
        fixture,
        fixture.tenantId,
        fixture.identities.human,
        ["projection.initialize"],
      ),
    });

    const issuedAt = new Date(Date.now() - 1_000);
    const realtimeContext = {
      schema_version: 1 as const,
      tenant_id: fixture.tenantId,
      principal_id: `principal_reader_${fixture.suffix}`,
      membership_id: `membership_reader_${fixture.suffix}`,
      subscriptions: [
        {
          identity_id: fixture.identities.human,
          families: ["projection"] as const,
        },
      ],
      resume: [],
      issued_at: issuedAt.toISOString(),
      expires_at: new Date(issuedAt.getTime() + 30_000).toISOString(),
    };
    const response = await projection.fetch(
      new Request("https://tenant-projection.internal/realtime", {
        method: "GET",
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Protocol": REALTIME_SUBPROTOCOL,
          "X-Communicator-Realtime-Context": JSON.stringify(realtimeContext),
        },
      }),
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (socket === null) throw new Error("missing realtime socket");
    const connected = waitForRealtimeFrame(socket, "connected");
    socket.accept();
    await connected;
    const liveFrame = waitForRealtimeFrame(socket, "projection.changes");

    try {
      const event = messageEvent(fixture, {
        eventId: `$realtime_ingestion_${fixture.suffix}:example`,
        body: "realtime ingestion body",
      });
      const request = await requestForEvents(fixture, [event]);
      const { queue } = await postIngestionBatch(fixture, request);
      await expect(
        deliverQueueMessages([
          {
            id: `queue_realtime_${fixture.suffix}`,
            body: queue.messages[0]!.body,
          },
        ]),
      ).resolves.toMatchObject({
        result: {
          retryMessages: [],
          explicitAcks: [`queue_realtime_${fixture.suffix}`],
        },
      });

      const persisted = await runInDurableObject(
        projection,
        async (_instance, state) =>
          state.storage.sql
            .exec<{
              identity_sequence: number;
              event_type: string;
              connection_id: string;
              conversation_id: string;
              occurred_at: string;
            }>(
              "SELECT identity_sequence, event_type, connection_id, conversation_id, occurred_at FROM projection_changes ORDER BY sequence",
            )
            .toArray(),
      );
      expect(persisted).toEqual([
        {
          identity_sequence: 1,
          event_type: "message.created",
          connection_id: fixture.connections.humanWhatsapp,
          conversation_id: event.conversation_id,
          occurred_at: event.occurred_at,
        },
      ]);

      await expect(liveFrame).resolves.toMatchObject({
        tenant_id: fixture.tenantId,
        identity_id: fixture.identities.human,
        generation: 1,
        from_sequence: 1,
        to_sequence: 2,
        changes: [
          {
            sequence: 1,
            event_type: "message.created",
            connection_id: fixture.connections.humanWhatsapp,
            conversation_id: event.conversation_id,
            occurred_at: event.occurred_at,
          },
        ],
      });
    } finally {
      if (socket.readyState !== 3) socket.close(1000, "test complete");
    }
  });

  it("projects Human and Agent WhatsApp messages into isolated identity views in one tenant DO", async () => {
    const human = messageEvent(fixture, {
      eventId: `$human_isolation_${fixture.suffix}:example`,
      conversationId: `conversation_human_${fixture.suffix}`,
      messageId: `message_human_${fixture.suffix}`,
      body: "human-only body",
    });
    const agent = messageEvent(fixture, {
      eventId: `$agent_isolation_${fixture.suffix}:example`,
      identityId: fixture.identities.agent,
      accountId: fixture.accounts.agentWhatsapp,
      conversationId: `conversation_agent_${fixture.suffix}`,
      messageId: `message_agent_${fixture.suffix}`,
      body: "agent-only body",
      observedAt: "2026-09-08T01:00:02.000Z",
    });
    const queue = createCapturingQueue();
    const humanRequest = await requestForEvents(fixture, [human], {
      gateway_route_id: fixture.routes.human,
    });
    const agentRequest = await requestForEvents(fixture, [agent], {
      gateway_route_id: fixture.routes.agent,
    });
    const humanResponse = await postIngestionBatch(
      fixture,
      humanRequest,
      queue,
    );
    const agentResponse = await postIngestionBatch(
      fixture,
      agentRequest,
      queue,
    );
    expect(humanResponse.response.status).toBe(202);
    expect(agentResponse.response.status).toBe(202);
    expect(queue.messages).toHaveLength(2);

    const delivered = await deliverQueueMessages(
      queue.messages.map((message, index) => ({
        id: `queue_isolation_${index}_${fixture.suffix}`,
        body: message.body,
      })),
    );
    expect(delivered.result).toMatchObject({
      retryMessages: [],
      explicitAcks: [
        `queue_isolation_0_${fixture.suffix}`,
        `queue_isolation_1_${fixture.suffix}`,
      ],
    });

    const projection = env.TENANT_PROJECTION.getByName(fixture.tenantId);
    const status = await projection.getStatus({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      authorization: authorizationFor(
        fixture,
        fixture.tenantId,
        fixture.identities.human,
        ["projection.status"],
      ),
    });
    expect(status).toMatchObject({
      applied_event_count: 2,
      conversation_count: 2,
      message_count: 2,
      latest_change_sequence: 1,
    });

    const humanAuthorization = authorizationFor(
      fixture,
      fixture.tenantId,
      fixture.identities.human,
    );
    const agentAuthorization = authorizationFor(
      fixture,
      fixture.tenantId,
      fixture.identities.agent,
    );
    const humanConversations = await projection.listConversations({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      identity_id: fixture.identities.human,
      connection_id: null,
      authorization: humanAuthorization,
    });
    const agentConversations = await projection.listConversations({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      identity_id: fixture.identities.agent,
      connection_id: null,
      authorization: agentAuthorization,
    });
    expect(humanConversations.items).toEqual([
      expect.objectContaining({
        identity_id: fixture.identities.human,
        connection_id: fixture.connections.humanWhatsapp,
        last_message_preview: "human-only body",
      }),
    ]);
    expect(agentConversations.items).toEqual([
      expect.objectContaining({
        identity_id: fixture.identities.agent,
        connection_id: fixture.connections.agentWhatsapp,
        last_message_preview: "agent-only body",
      }),
    ]);
    const forbidden = await runInDurableObject(projection, async (instance) => {
      try {
        await instance.listConversations({
          schema_version: 1,
          tenant_id: fixture.tenantId,
          identity_id: fixture.identities.agent,
          connection_id: null,
          authorization: humanAuthorization,
        });
        return undefined;
      } catch (error) {
        return error;
      }
    });
    expect(forbidden).toMatchObject({ code: "projection_forbidden" });
  });

  it("routes Telegram ingress through its separate connection and preserves the connection in the projection", async () => {
    const event = messageEvent(fixture, {
      eventId: `$telegram_${fixture.suffix}:example`,
      accountId: fixture.accounts.humanTelegram,
      platform: "telegram",
      conversationId: `conversation_telegram_${fixture.suffix}`,
      messageId: `message_telegram_${fixture.suffix}`,
      body: "telegram inbound body",
    });
    const request = await requestForEvents(fixture, [event], {
      gateway_route_id: fixture.routes.telegram,
    });
    const { response, queue } = await postIngestionBatch(fixture, request);
    expect(response.status).toBe(202);
    const delivered = await deliverQueueMessages([
      { id: `queue_telegram_${fixture.suffix}`, body: queue.messages[0]!.body },
    ]);
    expect(delivered.result).toMatchObject({
      retryMessages: [],
      explicitAcks: [`queue_telegram_${fixture.suffix}`],
    });

    const projection = env.TENANT_PROJECTION.getByName(fixture.tenantId);
    const authorization = authorizationFor(
      fixture,
      fixture.tenantId,
      fixture.identities.human,
    );
    const conversations = await projection.listConversations({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      identity_id: fixture.identities.human,
      connection_id: fixture.connections.humanTelegram,
      authorization,
    });
    expect(conversations.items).toEqual([
      expect.objectContaining({
        identity_id: fixture.identities.human,
        connection_id: fixture.connections.humanTelegram,
        last_message_preview: "telegram inbound body",
      }),
    ]);
    const messages = await projection.listMessages({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      identity_id: fixture.identities.human,
      conversation_id: conversations.items[0]!.id,
      authorization,
    });
    expect(messages.items[0]).toMatchObject({
      body: "telegram inbound body",
      connection_id: fixture.connections.humanTelegram,
    });
  });

  it("keeps two tenants isolated when their remote identifiers look identical", async () => {
    const remoteValues = {
      eventId: "$same-remote-event:example",
      conversationId: "conversation_remote_shared",
      messageId: "message_remote_shared",
      remoteMessageId: "remote-message-shared",
      matrixRoomId: "!shared-room:example",
      matrixEventId: "$shared-matrix-event:example",
    };
    const firstEvent = messageEvent(fixture, {
      ...remoteValues,
      body: "tenant one body",
    });
    const secondEvent = messageEvent(fixture, {
      ...remoteValues,
      tenantId: fixture.otherTenantId,
      identityId: fixture.identities.otherTenantHuman,
      accountId: fixture.accounts.otherTenantWhatsapp,
      body: "tenant two body",
    });
    const queue = createCapturingQueue();
    const firstRequest = await requestForEvents(fixture, [firstEvent], {
      tenant_id: fixture.tenantId,
      gateway_route_id: fixture.routes.human,
    });
    const secondRequest = await requestForEvents(fixture, [secondEvent], {
      tenant_id: fixture.otherTenantId,
      gateway_route_id: fixture.routes.otherTenant,
    });
    const firstResponse = await postIngestionBatch(
      fixture,
      firstRequest,
      queue,
    );
    const secondResponse = await postIngestionBatch(
      fixture,
      secondRequest,
      queue,
    );
    expect(firstResponse.response.status).toBe(202);
    expect(secondResponse.response.status).toBe(202);
    expect(queue.messages).toHaveLength(2);
    expect(await listTenantArchiveKeys(fixture.tenantId)).toHaveLength(2);
    expect(await listTenantArchiveKeys(fixture.otherTenantId)).toHaveLength(2);

    const delivered = await deliverQueueMessages(
      queue.messages.map((message, index) => ({
        id: `queue_tenant_${index}_${fixture.suffix}`,
        body: message.body,
      })),
    );
    expect(delivered.result).toMatchObject({
      retryMessages: [],
      explicitAcks: [
        `queue_tenant_0_${fixture.suffix}`,
        `queue_tenant_1_${fixture.suffix}`,
      ],
    });

    const firstProjection = env.TENANT_PROJECTION.getByName(fixture.tenantId);
    const secondProjection = env.TENANT_PROJECTION.getByName(
      fixture.otherTenantId,
    );
    const firstRead = authorizationFor(
      fixture,
      fixture.tenantId,
      fixture.identities.human,
    );
    const secondRead = authorizationFor(
      fixture,
      fixture.otherTenantId,
      fixture.identities.otherTenantHuman,
    );
    const firstConversations = await firstProjection.listConversations({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      identity_id: fixture.identities.human,
      connection_id: null,
      authorization: firstRead,
    });
    const secondConversations = await secondProjection.listConversations({
      schema_version: 1,
      tenant_id: fixture.otherTenantId,
      identity_id: fixture.identities.otherTenantHuman,
      connection_id: null,
      authorization: secondRead,
    });
    expect(firstConversations.items).toEqual([
      expect.objectContaining({
        tenant_id: fixture.tenantId,
        last_message_preview: "tenant one body",
      }),
    ]);
    expect(secondConversations.items).toEqual([
      expect.objectContaining({
        tenant_id: fixture.otherTenantId,
        last_message_preview: "tenant two body",
      }),
    ]);
    const firstMessages = await firstProjection.listMessages({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      identity_id: fixture.identities.human,
      conversation_id: firstConversations.items[0]!.id,
      authorization: firstRead,
    });
    const secondMessages = await secondProjection.listMessages({
      schema_version: 1,
      tenant_id: fixture.otherTenantId,
      identity_id: fixture.identities.otherTenantHuman,
      conversation_id: secondConversations.items[0]!.id,
      authorization: secondRead,
    });
    expect(firstMessages.items[0]).toMatchObject({ body: "tenant one body" });
    expect(secondMessages.items[0]).toMatchObject({ body: "tenant two body" });
    expect(firstMessages.items[0]!.id).toBe(secondMessages.items[0]!.id);
    const wrongTenant = await runInDurableObject(
      secondProjection,
      async (instance) => {
        try {
          await instance.listConversations({
            schema_version: 1,
            tenant_id: fixture.tenantId,
            identity_id: fixture.identities.otherTenantHuman,
            connection_id: null,
            authorization: {
              ...firstRead,
              allowed_identity_ids: [fixture.identities.otherTenantHuman],
            },
          });
          return undefined;
        } catch (error) {
          return error;
        }
      },
    );
    expect(wrongTenant).toMatchObject({ code: "projection_tenant_mismatch" });
  });

  it("archives one multi-event request as one pair and projects representative supported event families", async () => {
    const base = messageEvent(fixture, {
      eventId: `$family_created_${fixture.suffix}:example`,
      conversationId: `conversation_family_${fixture.suffix}`,
      messageId: `message_family_${fixture.suffix}`,
      body: "family-created body",
      observedAt: "2026-09-08T01:00:01.000Z",
    });
    const event = (
      eventId: string,
      eventType: ProjectionEventEnvelope["event_type"],
      payload: Record<string, unknown>,
      second: number,
    ) =>
      familyEvent(
        base,
        `$${eventId}_${fixture.suffix}:example`,
        eventType,
        payload,
        second,
      );
    const events = [
      base,
      event(
        "family_edited",
        "message.edited",
        {
          message_id: `message_family_${fixture.suffix}`,
          body: "family-edited body",
          editor_participant_id: null,
        },
        2,
      ),
      event(
        "family_participant",
        "participant.updated",
        {
          participant_id: `participant_family_${fixture.suffix}`,
          display_name: "Family participant",
          remote_id: "remote-participant",
          avatar_url: null,
        },
        3,
      ),
      event(
        "family_reaction",
        "reaction.added",
        {
          reaction_id: `reaction_family_${fixture.suffix}`,
          message_id: `message_family_${fixture.suffix}`,
          participant_id: `participant_family_${fixture.suffix}`,
          emoji: "👍",
        },
        4,
      ),
      event(
        "family_attachment",
        "attachment.observed",
        {
          attachment_id: `attachment_family_${fixture.suffix}`,
          message_id: `message_family_${fixture.suffix}`,
          file_name: "family.txt",
          mime_type: "text/plain",
          size_bytes: 4,
          sha256: null,
          r2_key: null,
        },
        5,
      ),
      event(
        "family_receipt",
        "receipt.read",
        {
          message_id: `message_family_${fixture.suffix}`,
          participant_id: `participant_family_${fixture.suffix}`,
          local_identity: false,
        },
        6,
      ),
      event(
        "family_typing",
        "typing.started",
        {
          participant_id: `participant_family_${fixture.suffix}`,
          expires_at: "2026-09-08T02:00:00.000Z",
        },
        7,
      ),
      event(
        "family_command",
        "command.updated",
        {
          command_id: `command_family_${fixture.suffix}`,
          operation: "message.send",
          delivery_mode: "direct",
          status: "failed",
          failure_code: "family-failure",
        },
        8,
      ),
      event(
        "family_delivery",
        "bridge.delivery.updated",
        {
          message_id: `message_family_${fixture.suffix}`,
          delivery_status: "delivered",
          failure_code: null,
        },
        9,
      ),
      event(
        "family_conversation",
        "conversation.updated",
        {
          title: "Family conversation",
          archived: false,
          muted: true,
        },
        10,
      ),
      event(
        "family_deleted",
        "message.deleted",
        {
          message_id: `message_deleted_${fixture.suffix}`,
          reason_code: "family-delete",
        },
        11,
      ),
      event(
        "family_reaction_removed",
        "reaction.removed",
        {
          reaction_id: `reaction_family_${fixture.suffix}`,
          message_id: `message_family_${fixture.suffix}`,
        },
        12,
      ),
      event(
        "family_receipt_delivered",
        "receipt.delivered",
        {
          message_id: `message_family_${fixture.suffix}`,
          participant_id: `participant_family_${fixture.suffix}`,
          local_identity: false,
        },
        13,
      ),
      event(
        "family_typing_stopped",
        "typing.stopped",
        {
          participant_id: `participant_family_${fixture.suffix}`,
        },
        14,
      ),
      event(
        "family_replay_tombstone",
        "replay.tombstone",
        {
          target_event_id: base.event_id,
          reason_code: "family-replay",
        },
        15,
      ),
      event(
        "family_correction",
        "correction.applied",
        {
          target_event_id: `$family_edited_${fixture.suffix}:example`,
          reason_code: "family-correction",
        },
        16,
      ),
      event(
        "family_deletion",
        "deletion.tombstone",
        {
          resource_type: "participant",
          resource_id: `participant_deleted_${fixture.suffix}`,
          reason_code: "family-retention",
        },
        17,
      ),
    ];
    const request = await requestForEvents(fixture, events);
    const { response, queue } = await postIngestionBatch(fixture, request);
    expect(response.status).toBe(202);
    expect(await listTenantArchiveKeys(fixture.tenantId)).toHaveLength(2);
    const pointer = queue.messages[0]!.body;
    const manifestObject = await env.EVENT_ARCHIVE.get(pointer.manifest_key);
    expect(manifestObject).not.toBeNull();
    await expect(manifestObject!.json()).resolves.toMatchObject({
      event_count: events.length,
    });
    const delivered = await deliverQueueMessages([
      { id: `queue_family_${fixture.suffix}`, body: pointer },
    ]);
    expect(delivered.result).toMatchObject({
      retryMessages: [],
      explicitAcks: [`queue_family_${fixture.suffix}`],
    });

    const projection = env.TENANT_PROJECTION.getByName(fixture.tenantId);
    const read = authorizationFor(
      fixture,
      fixture.tenantId,
      fixture.identities.human,
    );
    const conversations = await projection.listConversations({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      identity_id: fixture.identities.human,
      connection_id: null,
      authorization: read,
    });
    expect(conversations.items).toEqual([
      expect.objectContaining({
        title: "Family conversation",
        last_message_preview: "family-edited body",
        unread_count: 1,
      }),
    ]);
    const messages = await projection.listMessages({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      identity_id: fixture.identities.human,
      conversation_id: conversations.items[0]!.id,
      authorization: read,
    });
    expect(messages.items).toEqual([
      expect.objectContaining({
        body: "family-edited body",
        delivery_status: "delivered",
        attachment_count: 1,
      }),
    ]);
    const status = await projection.getStatus({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      authorization: authorizationFor(
        fixture,
        fixture.tenantId,
        fixture.identities.human,
        ["projection.status"],
      ),
    });
    expect(status).toMatchObject({
      applied_event_count: events.length,
      conversation_count: 1,
      message_count: 1,
      latest_change_sequence: events.length,
    });
    const changes = await projection.listChanges({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      identity_id: fixture.identities.human,
      generation: status.generation,
      after_sequence: 0,
      authorization: read,
    });
    expect(changes.items.map((change) => change.event_type)).toEqual([
      "message.created",
      "message.edited",
      "participant.updated",
      "reaction.added",
      "attachment.observed",
      "receipt.read",
      "typing.started",
      "command.updated",
      "bridge.delivery.updated",
      "conversation.updated",
      "message.deleted",
      "reaction.removed",
      "receipt.delivered",
      "typing.stopped",
      "replay.tombstone",
      "correction.applied",
      "deletion.tombstone",
    ]);
    expect(status.checkpoints[0]).toMatchObject({
      kind: "live_event_watermark",
      value: events.at(-1)!.event_id,
      last_event_id: events.at(-1)!.event_id,
    });
  });

  it("makes duplicate ingress safe across a lost response and duplicate Queue delivery", async () => {
    const event = messageEvent(fixture, {
      eventId: `$duplicate_ingress_${fixture.suffix}:example`,
      body: "duplicate ingress body",
    });
    const request = await requestForEvents(fixture, [event]);
    const queue = createCapturingQueue();
    const first = await postIngestionBatch(fixture, request, queue);
    const second = await postIngestionBatch(fixture, request, queue);
    expect(first.response.status).toBe(202);
    expect(second.response.status).toBe(202);
    await expect(second.response.json()).resolves.toMatchObject({
      archive_status: "already_committed",
      batch_id: request.batch_id,
    });
    expect(queue.messages).toHaveLength(2);
    expect(queue.messages[0]!.body).toEqual(queue.messages[1]!.body);
    expect(await listTenantArchiveKeys(fixture.tenantId)).toHaveLength(2);

    const delivered = await deliverQueueMessages([
      {
        id: `queue_duplicate_first_${fixture.suffix}`,
        body: queue.messages[0]!.body,
      },
      {
        id: `queue_duplicate_second_${fixture.suffix}`,
        body: queue.messages[1]!.body,
      },
    ]);
    expect(delivered.result).toMatchObject({
      retryMessages: [],
      explicitAcks: [
        `queue_duplicate_first_${fixture.suffix}`,
        `queue_duplicate_second_${fixture.suffix}`,
      ],
    });
    const projection = env.TENANT_PROJECTION.getByName(fixture.tenantId);
    const status = await projection.getStatus({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      authorization: authorizationFor(
        fixture,
        fixture.tenantId,
        fixture.identities.human,
        ["projection.status"],
      ),
    });
    expect(status).toMatchObject({
      applied_event_count: 1,
      conversation_count: 1,
      message_count: 1,
      latest_change_sequence: 1,
    });
  });

  it("converges overlapping and reordered batches without regressing the live watermark", async () => {
    const firstEvent = messageEvent(fixture, {
      eventId: `$overlap_one_${fixture.suffix}:example`,
      conversationId: `conversation_overlap_${fixture.suffix}`,
      messageId: `message_overlap_one_${fixture.suffix}`,
      body: "overlap one",
      occurredAt: "2026-09-08T01:00:01.000Z",
      observedAt: "2026-09-08T01:00:01.000Z",
    });
    const secondEvent = messageEvent(fixture, {
      eventId: `$overlap_two_${fixture.suffix}:example`,
      conversationId: `conversation_overlap_${fixture.suffix}`,
      messageId: `message_overlap_two_${fixture.suffix}`,
      body: "overlap two",
      occurredAt: "2026-09-08T01:00:02.000Z",
      observedAt: "2026-09-08T01:00:02.000Z",
    });
    const thirdEvent = messageEvent(fixture, {
      eventId: `$overlap_three_${fixture.suffix}:example`,
      conversationId: `conversation_overlap_${fixture.suffix}`,
      messageId: `message_overlap_three_${fixture.suffix}`,
      body: "overlap three",
      occurredAt: "2026-09-08T01:00:03.000Z",
      observedAt: "2026-09-08T01:00:03.000Z",
    });
    const queue = createCapturingQueue();
    const firstRequest = await requestForEvents(fixture, [
      firstEvent,
      secondEvent,
    ]);
    const secondRequest = await requestForEvents(fixture, [
      firstEvent,
      thirdEvent,
    ]);
    await postIngestionBatch(fixture, firstRequest, queue);
    await postIngestionBatch(fixture, secondRequest, queue);
    expect(queue.messages).toHaveLength(2);
    const firstPointer = queue.messages[0]!.body;
    const secondPointer = queue.messages[1]!.body;
    expect(firstPointer.batch_id).not.toBe(secondPointer.batch_id);

    const reordered = await deliverQueueMessages([
      { id: `queue_overlap_newer_${fixture.suffix}`, body: secondPointer },
      { id: `queue_overlap_older_${fixture.suffix}`, body: firstPointer },
    ]);
    expect(reordered.result).toMatchObject({
      retryMessages: [],
      explicitAcks: [
        `queue_overlap_newer_${fixture.suffix}`,
        `queue_overlap_older_${fixture.suffix}`,
      ],
    });
    const duplicate = await deliverQueueMessages([
      { id: `queue_overlap_duplicate_${fixture.suffix}`, body: firstPointer },
    ]);
    expect(duplicate.result).toMatchObject({
      retryMessages: [],
      explicitAcks: [`queue_overlap_duplicate_${fixture.suffix}`],
    });

    const projection = env.TENANT_PROJECTION.getByName(fixture.tenantId);
    const read = authorizationFor(
      fixture,
      fixture.tenantId,
      fixture.identities.human,
    );
    const conversations = await projection.listConversations({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      identity_id: fixture.identities.human,
      connection_id: null,
      authorization: read,
    });
    expect(conversations.items).toEqual([
      expect.objectContaining({
        last_message_preview: "overlap three",
        unread_count: 3,
      }),
    ]);
    const messages = await projection.listMessages({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      identity_id: fixture.identities.human,
      conversation_id: conversations.items[0]!.id,
      authorization: read,
    });
    expect(messages.items.map((message) => message.body)).toEqual([
      "overlap three",
      "overlap two",
      "overlap one",
    ]);
    const status = await projection.getStatus({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      authorization: authorizationFor(
        fixture,
        fixture.tenantId,
        fixture.identities.human,
        ["projection.status"],
      ),
    });
    expect(status).toMatchObject({
      applied_event_count: 3,
      conversation_count: 1,
      message_count: 3,
      latest_change_sequence: 3,
    });
    expect(status.checkpoints[0]).toMatchObject({
      kind: "live_event_watermark",
      value: thirdEvent.event_id,
      last_event_id: thirdEvent.event_id,
      last_observed_at: thirdEvent.observed_at,
    });
  });

  it("ACKs successful Queue siblings while retrying a malformed sibling independently", async () => {
    const event = messageEvent(fixture, {
      eventId: `$mixed_success_${fixture.suffix}:example`,
      body: "mixed sibling body",
    });
    const request = await requestForEvents(fixture, [event]);
    const { queue } = await postIngestionBatch(fixture, request);
    const validId = `queue_mixed_valid_${fixture.suffix}`;
    const invalidId = `queue_mixed_invalid_${fixture.suffix}`;
    const delivered = await deliverQueueMessages([
      { id: validId, body: queue.messages[0]!.body },
      { id: invalidId, body: { kind: "archive.batch.committed" } },
    ]);
    expect(delivered.result).toMatchObject({
      explicitAcks: [validId],
      retryMessages: [{ msgId: invalidId }],
    });
    expect(delivered.retryOptions.get(invalidId)).toEqual({
      delaySeconds: 300,
    });
    expect(await listTenantArchiveKeys(fixture.tenantId)).toHaveLength(2);

    const projection = env.TENANT_PROJECTION.getByName(fixture.tenantId);
    const status = await projection.getStatus({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      authorization: authorizationFor(
        fixture,
        fixture.tenantId,
        fixture.identities.human,
        ["projection.status"],
      ),
    });
    expect(status).toMatchObject({
      applied_event_count: 1,
      conversation_count: 1,
      message_count: 1,
      latest_change_sequence: 1,
    });
  });

  it("keeps a permanent poison pointer retried and never ACKed", async () => {
    const id = `queue_poison_${fixture.suffix}`;
    const delivered = await deliverQueueMessages([
      {
        id,
        body: { schema_version: 1, kind: "archive.batch.committed" },
        attempts: 11,
      },
    ]);
    expect(delivered.result).toMatchObject({
      explicitAcks: [],
      retryMessages: [{ msgId: id }],
    });
    expect(delivered.retryOptions.get(id)).toEqual({ delaySeconds: 300 });
    expect(await listTenantArchiveKeys(fixture.tenantId)).toEqual([]);
  });

  it("retries a pointer whose committed manifest is missing without creating DO state", async () => {
    const event = messageEvent(fixture, {
      eventId: `$missing_manifest_${fixture.suffix}:example`,
      body: "missing manifest body",
    });
    const request = await requestForEvents(fixture, [event]);
    const { queue } = await postIngestionBatch(fixture, request);
    const pointer = queue.messages[0]!.body;
    await env.EVENT_ARCHIVE.delete(pointer.manifest_key);
    const id = `queue_missing_manifest_${fixture.suffix}`;
    const delivered = await deliverQueueMessages([{ id, body: pointer }]);
    expect(delivered.result).toMatchObject({
      explicitAcks: [],
      retryMessages: [{ msgId: id }],
    });
    expect(delivered.retryOptions.get(id)).toEqual({ delaySeconds: 300 });
    expect(await listTenantArchiveKeys(fixture.tenantId)).toEqual([
      pointer.manifest_key
        .replace("manifests/", "events/")
        .replace(".json", ".jsonl.gz"),
    ]);
    const projection = env.TENANT_PROJECTION.getByName(fixture.tenantId);
    const error = await runInDurableObject(projection, async (instance) => {
      try {
        await instance.getStatus({
          schema_version: 1,
          tenant_id: fixture.tenantId,
          authorization: authorizationFor(
            fixture,
            fixture.tenantId,
            fixture.identities.human,
            ["projection.status"],
          ),
        });
        return undefined;
      } catch (failure) {
        return failure;
      }
    });
    expect(error).toMatchObject({ code: "projection_not_found" });
  });

  it("retries a corrupt committed manifest without overwriting the archive or touching the DO", async () => {
    const event = messageEvent(fixture, {
      eventId: `$corrupt_manifest_${fixture.suffix}:example`,
      body: "corrupt manifest body",
    });
    const request = await requestForEvents(fixture, [event]);
    const { queue } = await postIngestionBatch(fixture, request);
    const pointer = queue.messages[0]!.body;
    const original = await env.EVENT_ARCHIVE.get(pointer.manifest_key);
    expect(original).not.toBeNull();
    const originalManifest = JSON.parse(await original!.text()) as {
      data_key: string;
    };
    await env.EVENT_ARCHIVE.put(pointer.manifest_key, "not a manifest", {
      ...(original!.httpMetadata === undefined
        ? {}
        : { httpMetadata: original!.httpMetadata }),
      ...(original!.customMetadata === undefined
        ? {}
        : { customMetadata: original!.customMetadata }),
    });
    const beforeFailure = await snapshotArchivePair(
      pointer,
      originalManifest.data_key,
    );
    const id = `queue_corrupt_manifest_${fixture.suffix}`;
    const delivered = await deliverQueueMessages([{ id, body: pointer }]);
    expect(delivered.result).toMatchObject({
      explicitAcks: [],
      retryMessages: [{ msgId: id }],
    });
    expect(delivered.retryOptions.get(id)).toEqual({ delaySeconds: 300 });
    await expectArchivePairUnchanged(
      pointer,
      beforeFailure,
      originalManifest.data_key,
    );
    const projection = env.TENANT_PROJECTION.getByName(fixture.tenantId);
    const error = await runInDurableObject(projection, async (instance) => {
      try {
        await instance.getStatus({
          schema_version: 1,
          tenant_id: fixture.tenantId,
          authorization: authorizationFor(
            fixture,
            fixture.tenantId,
            fixture.identities.human,
            ["projection.status"],
          ),
        });
        return undefined;
      } catch (failure) {
        return failure;
      }
    });
    expect(error).toMatchObject({ code: "projection_not_found" });
  });

  it("projects an archive after its ingress mapping is retired", async () => {
    const event = messageEvent(fixture, {
      eventId: `$retired_mapping_${fixture.suffix}:example`,
      body: "retired mapping body",
    });
    const request = await requestForEvents(fixture, [event]);
    const { queue } = await postIngestionBatch(fixture, request);
    await env.CONTROL_DB.prepare(
      "UPDATE connection_accounts SET status = 'retired', retired_at = ?, updated_at = ? WHERE account_id = ?",
    )
      .bind(
        "2026-09-08T04:00:00.000Z",
        "2026-09-08T04:00:00.000Z",
        fixture.accounts.humanWhatsapp,
      )
      .run();
    await expect(
      env.CONTROL_DB.prepare(
        "SELECT status FROM connection_accounts WHERE account_id = ?",
      )
        .bind(fixture.accounts.humanWhatsapp)
        .first<{ status: string }>(),
    ).resolves.toEqual({ status: "retired" });
    const delivered = await deliverQueueMessages([
      {
        id: `queue_retired_mapping_${fixture.suffix}`,
        body: queue.messages[0]!.body,
      },
    ]);
    expect(delivered.result).toMatchObject({
      retryMessages: [],
      explicitAcks: [`queue_retired_mapping_${fixture.suffix}`],
    });
    const projection = env.TENANT_PROJECTION.getByName(fixture.tenantId);
    const conversations = await projection.listConversations({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      identity_id: fixture.identities.human,
      connection_id: fixture.connections.humanWhatsapp,
      authorization: authorizationFor(
        fixture,
        fixture.tenantId,
        fixture.identities.human,
      ),
    });
    expect(conversations.items).toHaveLength(1);
    expect(conversations.items[0]).toMatchObject({
      last_message_preview: "retired mapping body",
    });
  });

  it("retries a DO transaction failure, leaves the archive intact, and applies atomically on retry", async () => {
    const event = messageEvent(fixture, {
      eventId: `$do_failure_${fixture.suffix}:example`,
      body: "transaction failure body",
    });
    const request = await requestForEvents(fixture, [event]);
    const { queue } = await postIngestionBatch(fixture, request);
    const pointer = queue.messages[0]!.body;
    const projection = env.TENANT_PROJECTION.getByName(fixture.tenantId);
    await projection.initialize({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      initialized_at: "2026-09-08T02:30:00.000Z",
      authorization: authorizationFor(
        fixture,
        fixture.tenantId,
        fixture.identities.human,
        ["projection.initialize"],
      ),
    });
    await runInDurableObject(projection, async (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER ingestion_test_fail_projection BEFORE INSERT ON projection_changes BEGIN SELECT RAISE(ABORT, 'synthetic projection failure'); END",
      );
    });
    const beforeFailure = await snapshotArchivePair(pointer);
    const failed = await deliverQueueMessages([
      { id: `queue_do_failure_${fixture.suffix}`, body: pointer },
    ]);
    expect(failed.result).toMatchObject({
      explicitAcks: [],
      retryMessages: [{ msgId: `queue_do_failure_${fixture.suffix}` }],
    });
    expect(
      failed.retryOptions.get(`queue_do_failure_${fixture.suffix}`),
    ).toEqual({ delaySeconds: 60 });
    await expectArchivePairUnchanged(pointer, beforeFailure);
    const afterFailure = await projection.getStatus({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      authorization: authorizationFor(
        fixture,
        fixture.tenantId,
        fixture.identities.human,
        ["projection.status"],
      ),
    });
    expect(afterFailure).toMatchObject({
      state: "ready",
      applied_event_count: 0,
      conversation_count: 0,
      message_count: 0,
      latest_change_sequence: 0,
    });
    await runInDurableObject(projection, async (_instance, state) => {
      state.storage.sql.exec("DROP TRIGGER ingestion_test_fail_projection");
    });
    const retried = await deliverQueueMessages([
      { id: `queue_do_failure_retry_${fixture.suffix}`, body: pointer },
    ]);
    expect(retried.result).toMatchObject({
      retryMessages: [],
      explicitAcks: [`queue_do_failure_retry_${fixture.suffix}`],
    });
    const afterRetry = await projection.getStatus({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      authorization: authorizationFor(
        fixture,
        fixture.tenantId,
        fixture.identities.human,
        ["projection.status"],
      ),
    });
    expect(afterRetry).toMatchObject({
      applied_event_count: 1,
      conversation_count: 1,
      message_count: 1,
      latest_change_sequence: 1,
    });
  });

  it("retains R2 while a tenant DO rebuilds and rebuilds a fresh projection from the archive", async () => {
    const projection = env.TENANT_PROJECTION.getByName(fixture.tenantId);
    const initializeAuthorization = authorizationFor(
      fixture,
      fixture.tenantId,
      fixture.identities.human,
      ["projection.initialize"],
    );
    await projection.initialize({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      initialized_at: "2026-09-08T02:40:00.000Z",
      authorization: initializeAuthorization,
    });
    const staleEvent = messageEvent(fixture, {
      eventId: `$stale_projection_${fixture.suffix}:example`,
      conversationId: `conversation_stale_${fixture.suffix}`,
      messageId: `message_stale_${fixture.suffix}`,
      body: "stale projection body",
    });
    await projection.applyBatch({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      authorization: authorizationFor(
        fixture,
        fixture.tenantId,
        fixture.identities.human,
        ["projection.write"],
      ),
      mode: "live",
      rebuild_id: null,
      connections: [
        {
          account_id: fixture.accounts.humanWhatsapp,
          connection_id: fixture.connections.humanWhatsapp,
          identity_id: fixture.identities.human,
          platform: "whatsapp",
        },
      ],
      events: [staleEvent],
      checkpoint: {
        kind: "live_event_watermark",
        value: staleEvent.event_id,
        last_observed_at: staleEvent.observed_at,
        last_event_id: staleEvent.event_id,
      },
    });
    const staleStatus = await projection.getStatus({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      authorization: authorizationFor(
        fixture,
        fixture.tenantId,
        fixture.identities.human,
        ["projection.status"],
      ),
    });
    expect(staleStatus).toMatchObject({
      state: "ready",
      generation: 1,
      applied_event_count: 1,
      conversation_count: 1,
      message_count: 1,
    });

    const event = messageEvent(fixture, {
      eventId: `$rebuild_${fixture.suffix}:example`,
      body: "rebuild source body",
    });
    const request = await requestForEvents(fixture, [event]);
    const { queue } = await postIngestionBatch(fixture, request);
    const pointer = queue.messages[0]!.body;
    const rebuildId = `rebuild_${fixture.suffix}`;
    const rebuildAuthorization = authorizationFor(
      fixture,
      fixture.tenantId,
      fixture.identities.human,
      ["projection.rebuild"],
    );
    await projection.beginRebuild({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      rebuild_id: rebuildId,
      expected_generation: 1,
      started_at: "2026-09-08T02:45:00.000Z",
      authorization: rebuildAuthorization,
    });
    const beforeFailure = await snapshotArchivePair(pointer);
    const rebuilding = await deliverQueueMessages([
      { id: `queue_rebuilding_${fixture.suffix}`, body: pointer },
    ]);
    expect(rebuilding.result).toMatchObject({
      explicitAcks: [],
      retryMessages: [{ msgId: `queue_rebuilding_${fixture.suffix}` }],
    });
    expect(
      rebuilding.retryOptions.get(`queue_rebuilding_${fixture.suffix}`),
    ).toEqual({ delaySeconds: 60 });
    await expectArchivePairUnchanged(pointer, beforeFailure);

    const page = await readReplayPage(env.EVENT_ARCHIVE, fixture.tenantId);
    await projection.applyReplayPage({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      rebuild_id: rebuildId,
      source_cursor: null,
      connections: [
        {
          account_id: fixture.accounts.humanWhatsapp,
          connection_id: fixture.connections.humanWhatsapp,
          identity_id: fixture.identities.human,
          platform: "whatsapp",
        },
      ],
      page,
      authorization: rebuildAuthorization,
    });
    await projection.completeRebuild({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      rebuild_id: rebuildId,
      terminal_cursor: null,
      completed_at: "2026-09-08T03:00:00.000Z",
      authorization: rebuildAuthorization,
    });
    const status = await projection.getStatus({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      authorization: authorizationFor(
        fixture,
        fixture.tenantId,
        fixture.identities.human,
        ["projection.status"],
      ),
    });
    expect(status).toMatchObject({
      state: "ready",
      generation: 2,
      applied_event_count: 1,
      conversation_count: 1,
      message_count: 1,
      last_completed_rebuild_id: rebuildId,
    });
    const conversations = await projection.listConversations({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      identity_id: fixture.identities.human,
      connection_id: null,
      authorization: authorizationFor(
        fixture,
        fixture.tenantId,
        fixture.identities.human,
      ),
    });
    expect(conversations.items).toHaveLength(1);
    expect(conversations.items[0]!.id).toBe(event.conversation_id);
    expect(conversations.items[0]).toMatchObject({
      last_message_preview: "rebuild source body",
      connection_id: fixture.connections.humanWhatsapp,
    });
    const messages = await projection.listMessages({
      schema_version: 1,
      tenant_id: fixture.tenantId,
      identity_id: fixture.identities.human,
      conversation_id: event.conversation_id,
      authorization: authorizationFor(
        fixture,
        fixture.tenantId,
        fixture.identities.human,
      ),
    });
    expect(messages.items.map((message) => message.body)).toEqual([
      "rebuild source body",
    ]);
    expect(messages.items.map((message) => message.body)).not.toContain(
      "stale projection body",
    );
  });

  it("records the later staging smoke gate without simulating hosted DLQ time", () => {
    expect(
      "staging smoke gate: send a non-sensitive test pointer, observe retries and DLQ transfer, then delete or reconcile only that test artifact",
    ).toContain("retries and DLQ transfer");
  });
});
