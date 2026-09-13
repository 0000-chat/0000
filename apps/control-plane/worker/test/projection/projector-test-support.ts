import { env, runInDurableObject } from "cloudflare:test";
import type {
  ApplyProjectionBatchInput,
  ProjectionAuthorizationContext,
  ProjectionConnectionBinding,
  ProjectionEventEnvelope,
} from "@communicator/contracts";
import { expect } from "vitest";
import type { TenantProjectionDO } from "../../projection/tenant-projection";

export const tenantId = "tenant_projector";

export const auth = (
  scopes: ProjectionAuthorizationContext["scopes"],
  identities: string[] = ["identity_a"],
  tenant = tenantId,
): ProjectionAuthorizationContext => ({
  schema_version: 1,
  tenant_id: tenant,
  principal_id: "principal_projector",
  allowed_identity_ids: identities,
  scopes,
});

export const bindingFor = (
  accountId: string,
  connectionId: string,
  identityId = "identity_a",
): ProjectionConnectionBinding => ({
  account_id: accountId,
  connection_id: connectionId,
  identity_id: identityId,
  platform: "whatsapp",
});

export const ownerBOverrides = (
  tenant: string,
): Partial<ProjectionEventEnvelope> => ({
  tenant_id: tenant,
  identity_id: "identity_b",
  account_id: "account_b",
  conversation_id: "conversation_b",
});

export const event = (
  eventId: string,
  payload: Record<string, unknown>,
  eventType: ProjectionEventEnvelope["event_type"] = "message.created",
  overrides: Partial<ProjectionEventEnvelope> = {},
): ProjectionEventEnvelope =>
  ({
    schema_version: 1,
    event_id: eventId,
    event_type: eventType,
    event_source: "live",
    tenant_id: tenantId,
    identity_id: "identity_a",
    platform: "whatsapp",
    account_id: "account_a",
    conversation_id: "conversation_a",
    matrix_room_id: null,
    matrix_event_id: null,
    remote_message_id: null,
    occurred_at: "2026-09-07T01:00:00.000Z",
    observed_at: "2026-09-07T01:00:01.000Z",
    payload,
    ...overrides,
  }) as ProjectionEventEnvelope;

export const createMessage = (
  eventId = "event_message",
): ProjectionEventEnvelope =>
  event(eventId, {
    message_id: "message_a",
    direction: "inbound",
    sender_participant_id: null,
    sender_label: "Alice",
    body: "hello",
    reply_to_message_id: null,
    delivery_status: "unknown",
    unread: true,
  });

export const input = (
  events: ProjectionEventEnvelope[],
  overrides: Partial<ApplyProjectionBatchInput> = {},
): ApplyProjectionBatchInput => ({
  schema_version: 1,
  tenant_id: tenantId,
  authorization: auth(
    ["projection.write"],
    ["identity_a"],
    overrides.tenant_id ?? tenantId,
  ),
  mode: "live",
  rebuild_id: null,
  connections: [bindingFor("account_a", "connection_a")],
  events,
  checkpoint: null,
  ...overrides,
});

export const initialize = async (tenant = tenantId) => {
  const stub = env.TENANT_PROJECTION.getByName(tenant);
  await stub.initialize({
    schema_version: 1,
    tenant_id: tenant,
    initialized_at: "2026-09-07T00:00:00.000Z",
    authorization: auth(["projection.initialize"], [], tenant),
  });
  return stub;
};

export const rows = async <T extends Record<string, SqlStorageValue>>(
  stub: DurableObjectStub<TenantProjectionDO>,
  sql: string,
  ...bindings: SqlStorageValue[]
): Promise<T[]> =>
  runInDurableObject(stub, async (_instance, state) =>
    state.storage.sql.exec<T>(sql, ...bindings).toArray(),
  );

export const expectCode = async (
  stub: DurableObjectStub<TenantProjectionDO>,
  request: ApplyProjectionBatchInput,
  code: string,
) => {
  const error = await runInDurableObject(stub, async (instance) => {
    try {
      await instance.applyBatch(request);
      return undefined;
    } catch (failure) {
      return failure;
    }
  });
  expect(error).toMatchObject({ code, message: code });
};

export const created = (
  eventId: string,
  overrides: Partial<ProjectionEventEnvelope> = {},
): ProjectionEventEnvelope =>
  event(
    eventId,
    {
      message_id: "message_a",
      direction: "inbound",
      sender_participant_id: null,
      sender_label: "Alice",
      body: "hello",
      reply_to_message_id: null,
      delivery_status: "unknown",
      unread: true,
    },
    "message.created",
    overrides,
  );

export const edited = (
  eventId: string,
  messageId = "message_a",
  body = "edited",
  overrides: Partial<ProjectionEventEnvelope> = {},
): ProjectionEventEnvelope =>
  event(
    eventId,
    {
      message_id: messageId,
      body,
      editor_participant_id: null,
    },
    "message.edited",
    overrides,
  );

export const deleted = (
  eventId: string,
  messageId = "message_a",
  reason_code: string | null = "removed",
  overrides: Partial<ProjectionEventEnvelope> = {},
): ProjectionEventEnvelope =>
  event(
    eventId,
    {
      message_id: messageId,
      reason_code,
    },
    "message.deleted",
    overrides,
  );

export const conversationUpdated = (
  eventId: string,
  payload: Record<string, unknown> = {
    title: "Updated title",
    archived: true,
    muted: true,
  },
  overrides: Partial<ProjectionEventEnvelope> = {},
): ProjectionEventEnvelope =>
  event(eventId, payload, "conversation.updated", overrides);

export const participantUpdated = (
  eventId: string,
  participantId = "participant_a",
  overrides: Partial<ProjectionEventEnvelope> = {},
): ProjectionEventEnvelope =>
  event(
    eventId,
    {
      participant_id: participantId,
      display_name: "Alice Updated",
      remote_id: "remote-a",
      avatar_url: "https://example.test/avatar.png",
    },
    "participant.updated",
    overrides,
  );

export const reactionAdded = (
  eventId: string,
  reactionId = "reaction_a",
  messageId = "message_a",
  participantId = "participant_a",
  emoji = "👍",
  overrides: Partial<ProjectionEventEnvelope> = {},
): ProjectionEventEnvelope =>
  event(
    eventId,
    {
      reaction_id: reactionId,
      message_id: messageId,
      participant_id: participantId,
      emoji,
    },
    "reaction.added",
    overrides,
  );

export const reactionRemoved = (
  eventId: string,
  reactionId = "reaction_a",
  messageId = "message_a",
  overrides: Partial<ProjectionEventEnvelope> = {},
): ProjectionEventEnvelope =>
  event(
    eventId,
    {
      reaction_id: reactionId,
      message_id: messageId,
    },
    "reaction.removed",
    overrides,
  );

export const receipt = (
  eventId: string,
  receiptType: "read" | "delivered",
  messageId = "message_a",
  participantId = "participant_a",
  localIdentity = false,
  overrides: Partial<ProjectionEventEnvelope> = {},
): ProjectionEventEnvelope =>
  event(
    eventId,
    {
      message_id: messageId,
      participant_id: participantId,
      local_identity: localIdentity,
    },
    receiptType === "read" ? "receipt.read" : "receipt.delivered",
    overrides,
  );

export const typingStarted = (
  eventId: string,
  participantId = "participant_typing",
  expiresAt = "2026-09-07T01:30:00.000Z",
  overrides: Partial<ProjectionEventEnvelope> = {},
): ProjectionEventEnvelope =>
  event(
    eventId,
    {
      participant_id: participantId,
      expires_at: expiresAt,
    },
    "typing.started",
    overrides,
  );

export const typingStopped = (
  eventId: string,
  participantId = "participant_typing",
  overrides: Partial<ProjectionEventEnvelope> = {},
): ProjectionEventEnvelope =>
  event(
    eventId,
    { participant_id: participantId },
    "typing.stopped",
    overrides,
  );

export const attachmentObserved = (
  eventId: string,
  attachmentId = "attachment_a",
  messageId = "message_a",
  overrides: Partial<ProjectionEventEnvelope> = {},
): ProjectionEventEnvelope =>
  event(
    eventId,
    {
      attachment_id: attachmentId,
      message_id: messageId,
      file_name: "photo.jpg",
      mime_type: "image/jpeg",
      size_bytes: 42,
      sha256: null,
      r2_key: null,
    },
    "attachment.observed",
    overrides,
  );

export const commandUpdated = (
  eventId: string,
  commandId = "command_a",
  overrides: Partial<ProjectionEventEnvelope> = {},
): ProjectionEventEnvelope =>
  event(
    eventId,
    {
      command_id: commandId,
      operation: "message.send",
      delivery_mode: "direct",
      status: "failed",
      failure_code: "temporary",
    },
    "command.updated",
    overrides,
  );

export const deliveryUpdated = (
  eventId: string,
  messageId = "message_delivery_a",
  overrides: Partial<ProjectionEventEnvelope> = {},
): ProjectionEventEnvelope =>
  event(
    eventId,
    {
      message_id: messageId,
      delivery_status: "failed",
      failure_code: "bridge_failed",
    },
    "bridge.delivery.updated",
    overrides,
  );

export const eventMarker = (
  eventId: string,
  markerType: "replay.tombstone" | "correction.applied",
  targetEventId = "target_event_a",
  overrides: Partial<ProjectionEventEnvelope> = {},
): ProjectionEventEnvelope =>
  event(
    eventId,
    {
      target_event_id: targetEventId,
      reason_code: "operator_review",
    },
    markerType,
    overrides,
  );

export const deletionTombstone = (
  eventId: string,
  resourceType: "message" | "conversation" | "participant" | "attachment",
  resourceId: string,
  overrides: Partial<ProjectionEventEnvelope> = {},
): ProjectionEventEnvelope =>
  event(
    eventId,
    {
      resource_type: resourceType,
      resource_id: resourceId,
      reason_code: "retention",
    },
    "deletion.tombstone",
    overrides,
  );
