import { projectionError } from "./errors";
import type { PreparedProjectionEvent } from "./projector-types";
import {
  projectConversationUpdated,
  projectParticipantUpdated,
} from "./projector-conversation";
import {
  projectMessageCreated,
  projectMessageEdited,
} from "./projector-messages";
import {
  projectBridgeDeliveryUpdated,
  projectCommandUpdated,
  projectEventMarker,
} from "./projector-control";
import {
  projectDeletionTombstone,
  projectMessageDeleted,
} from "./projector-deletion";
import {
  assertEventTombstoneOwner,
  readConversation,
} from "./projector-common";
import {
  projectAttachmentObservedEvent,
  projectReactionAddedEvent,
  projectReactionRemovedEvent,
  projectReceiptEvent,
  projectTypingStartedEvent,
  projectTypingStoppedEvent,
} from "./projector-social";

const assertNeverEventType = (eventType: never): never => {
  throw new Error(`Unhandled projection event type: ${String(eventType)}`);
};

/**
 * Apply the conversation, participant, message, and Stage B interaction
 * families. Control and deletion families are kept in bounded responsibility
 * modules but share this one exhaustive dispatch and transaction boundary.
 */
export const projectEvent = (
  prepared: PreparedProjectionEvent,
  sql: SqlStorage,
  touchedConversations: Set<string>,
): void => {
  assertEventTombstoneOwner(sql, prepared.event.event_id, {
    identityId: prepared.event.identity_id,
    accountId: prepared.event.account_id,
    connectionId: prepared.connection.connection_id,
    conversationId: prepared.event.conversation_id,
    platform: prepared.event.platform,
  });
  switch (prepared.event.event_type) {
    case "conversation.updated":
      projectConversationUpdated(sql, prepared);
      touchedConversations.add(prepared.event.conversation_id);
      return;
    case "participant.updated":
      projectParticipantUpdated(sql, prepared);
      touchedConversations.add(prepared.event.conversation_id);
      return;
    case "message.created":
      projectMessageCreated(sql, prepared);
      touchedConversations.add(prepared.event.conversation_id);
      return;
    case "message.edited":
      projectMessageEdited(sql, prepared);
      touchedConversations.add(prepared.event.conversation_id);
      return;
    case "message.deleted":
      projectMessageDeleted(sql, prepared);
      touchedConversations.add(prepared.event.conversation_id);
      return;
    case "reaction.added":
      projectReactionAddedEvent(sql, prepared);
      touchedConversations.add(prepared.event.conversation_id);
      return;
    case "reaction.removed":
      projectReactionRemovedEvent(sql, prepared);
      touchedConversations.add(prepared.event.conversation_id);
      return;
    case "receipt.read":
    case "receipt.delivered":
      projectReceiptEvent(sql, prepared);
      touchedConversations.add(prepared.event.conversation_id);
      return;
    case "typing.started":
      projectTypingStartedEvent(sql, prepared);
      touchedConversations.add(prepared.event.conversation_id);
      return;
    case "typing.stopped":
      projectTypingStoppedEvent(sql, prepared);
      touchedConversations.add(prepared.event.conversation_id);
      return;
    case "attachment.observed":
      projectAttachmentObservedEvent(sql, prepared);
      touchedConversations.add(prepared.event.conversation_id);
      return;
    case "command.updated":
      projectCommandUpdated(sql, prepared);
      touchedConversations.add(prepared.event.conversation_id);
      return;
    case "bridge.delivery.updated":
      projectBridgeDeliveryUpdated(sql, prepared);
      touchedConversations.add(prepared.event.conversation_id);
      return;
    case "replay.tombstone":
    case "correction.applied":
      projectEventMarker(sql, prepared);
      touchedConversations.add(prepared.event.conversation_id);
      return;
    case "deletion.tombstone":
      projectDeletionTombstone(sql, prepared);
      touchedConversations.add(prepared.event.conversation_id);
      return;
    default:
      return assertNeverEventType(prepared.event);
  }
};

type ActiveMessageRow = {
  id: string;
  body: string;
  occurred_at: string;
  occurred_ms: number;
};

/** Recompute summaries once per touched conversation in deterministic order. */
export const recomputeConversationSummaries = (
  sql: SqlStorage,
  touchedConversations: ReadonlySet<string>,
): void => {
  const conversationIds = [...touchedConversations].sort();
  for (const conversationId of conversationIds) {
    const conversation = readConversation(sql, conversationId);
    if (conversation === undefined) continue;

    if (conversation.deleted_at !== null) {
      sql.exec(
        "UPDATE conversations SET last_message_preview = '', last_activity_at = ?, last_activity_ms = ?, unread_count = 0, message_count = 0, attachment_count = 0, last_event_id = ? WHERE id = ?",
        conversation.shell_activity_at,
        conversation.shell_activity_ms,
        conversation.shell_activity_event_id,
        conversationId,
      );
      continue;
    }

    sql.exec(
      "UPDATE messages SET attachment_count = (SELECT COUNT(*) FROM attachments WHERE attachments.message_id = messages.id AND attachments.deleted_at IS NULL) WHERE identity_id = ? AND conversation_id = ? AND deleted_at IS NULL",
      conversation.identity_id,
      conversationId,
    );

    const counts = sql
      .exec<{
        message_count: number;
        unread_count: number;
        attachment_count: number;
      }>(
        "SELECT COUNT(*) AS message_count, COALESCE(SUM(CASE WHEN direction = 'inbound' AND unread = 1 THEN 1 ELSE 0 END), 0) AS unread_count, COALESCE(SUM(attachment_count), 0) AS attachment_count FROM messages WHERE identity_id = ? AND conversation_id = ? AND deleted_at IS NULL",
        conversation.identity_id,
        conversationId,
      )
      .toArray()[0];
    if (counts === undefined) throw projectionError("projection_unavailable");

    const latest = sql
      .exec<ActiveMessageRow>(
        "SELECT id, body, occurred_at, occurred_ms FROM messages WHERE identity_id = ? AND conversation_id = ? AND deleted_at IS NULL ORDER BY occurred_ms DESC, id ASC LIMIT 1",
        conversation.identity_id,
        conversationId,
      )
      .toArray()[0];
    const preview = latest?.body.slice(0, 280) ?? "";
    const activityAt = latest?.occurred_at ?? conversation.shell_activity_at;
    const activityMs = latest?.occurred_ms ?? conversation.shell_activity_ms;
    const lastEventId = conversation.shell_activity_event_id;

    sql.exec(
      "UPDATE conversations SET last_message_preview = ?, last_activity_at = ?, last_activity_ms = ?, unread_count = ?, message_count = ?, attachment_count = ?, last_event_id = ? WHERE id = ?",
      preview,
      activityAt,
      activityMs,
      counts.unread_count,
      counts.message_count,
      counts.attachment_count,
      lastEventId,
      conversationId,
    );
  }
};
