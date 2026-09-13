import type { ProjectionEventEnvelope } from "@communicator/contracts";
import { projectionError } from "./errors";
import type { PreparedProjectionEvent } from "./projector-types";
import {
  assertMessageTargetOwner,
  assertCanonicalResourceIdOwner,
  assertNoOwnerMismatch,
  assertParticipantReferenceOwners,
  canonicalObservedAt,
  compareObservedTuple,
  ensureConversationShell,
  ownerFor,
  readAttachmentTombstone,
  readConversation,
  readConversationTombstone,
  readMessage,
  readMessageTombstone,
  readParticipant,
  readParticipantTombstone,
  readResourceTombstone,
  type OwnedProjectionRow,
  type ProjectionOwner,
  type ResourceTombstoneRow,
} from "./projector-common";

type DeletionTombstoneEvent = Extract<
  ProjectionEventEnvelope,
  { event_type: "deletion.tombstone" }
>;
type MessageDeletedEvent = Extract<
  ProjectionEventEnvelope,
  { event_type: "message.deleted" }
>;

export type DeletableResourceType =
  | "message"
  | "conversation"
  | "participant"
  | "attachment";

/** Return the effective deletion metadata under the single observed LWW order. */
export const latestTombstone = (
  left: ResourceTombstoneRow | undefined,
  right: ResourceTombstoneRow | undefined,
): ResourceTombstoneRow | undefined => {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return compareObservedTuple(
    left.observed_ms,
    left.tombstone_event_id,
    right.observed_ms,
    right.tombstone_event_id,
  ) >= 0
    ? left
    : right;
};

type AttachmentOwnerRow = OwnedProjectionRow & {
  id: string;
  message_id: string;
};

type EventTombstoneIdRow = {
  target_event_id: string;
};

const ownerMatches = (
  row: OwnedProjectionRow,
  owner: ProjectionOwner,
): boolean =>
  row.identity_id === owner.identityId &&
  row.account_id === owner.accountId &&
  row.connection_id === owner.connectionId &&
  row.conversation_id === owner.conversationId &&
  row.platform === owner.platform;

const assertOwned = (
  row: OwnedProjectionRow | undefined,
  owner: ProjectionOwner,
): void => {
  if (row !== undefined && !ownerMatches(row, owner)) {
    throw projectionError("projection_conflict");
  }
};

const readAttachment = (
  sql: SqlStorage,
  attachmentId: string,
): AttachmentOwnerRow | undefined =>
  sql
    .exec<AttachmentOwnerRow>(
      "SELECT id, message_id, identity_id, account_id, connection_id, conversation_id, platform FROM attachments WHERE id = ?",
      attachmentId,
    )
    .toArray()[0];

const assertTombstoneEventIdAvailable = (
  sql: SqlStorage,
  tombstoneEventId: string,
  resourceType: DeletableResourceType,
  resourceId: string,
): void => {
  const eventMarker = sql
    .exec<EventTombstoneIdRow>(
      "SELECT target_event_id FROM event_tombstones WHERE tombstone_event_id = ?",
      tombstoneEventId,
    )
    .toArray()[0];
  if (eventMarker !== undefined) throw projectionError("projection_conflict");

  const resourceMarker = sql
    .exec<{ resource_type: string; resource_id: string }>(
      "SELECT resource_type, resource_id FROM resource_tombstones WHERE tombstone_event_id = ?",
      tombstoneEventId,
    )
    .toArray()[0];
  if (
    resourceMarker !== undefined &&
    (resourceMarker.resource_type !== resourceType ||
      resourceMarker.resource_id !== resourceId)
  ) {
    throw projectionError("projection_conflict");
  }
};

const assertConversationChildrenOwned = (
  sql: SqlStorage,
  owner: ProjectionOwner,
): void => {
  const checks: readonly [string, string][] = [
    ["participants", "conversation_id"],
    ["messages", "conversation_id"],
    ["message_versions", "conversation_id"],
    ["reactions", "conversation_id"],
    ["receipts", "conversation_id"],
    ["typing_states", "conversation_id"],
    ["attachments", "conversation_id"],
    ["commands", "conversation_id"],
    ["message_delivery_updates", "conversation_id"],
    ["event_tombstones", "conversation_id"],
    ["resource_tombstones", "conversation_id"],
  ];
  for (const [table, key] of checks) {
    assertNoOwnerMismatch(
      sql,
      `SELECT 1 AS found FROM ${table} WHERE ${key} = ? AND (identity_id <> ? OR account_id <> ? OR connection_id <> ? OR conversation_id <> ? OR platform <> ?) LIMIT 1`,
      owner.conversationId,
      owner,
    );
  }
};

const assertTargetOwner = (
  sql: SqlStorage,
  resourceType: DeletableResourceType,
  resourceId: string,
  owner: ProjectionOwner,
): void => {
  assertCanonicalResourceIdOwner(
    sql,
    resourceType === "conversation" ? "conversation" : resourceType,
    resourceId,
    owner,
  );
  const tombstone = readResourceTombstone(sql, resourceType, resourceId);
  assertOwned(tombstone, owner);

  switch (resourceType) {
    case "message":
      assertMessageTargetOwner(sql, resourceId, owner);
      return;
    case "conversation": {
      const conversation = readConversation(sql, resourceId);
      if (conversation === undefined) {
        // Without a shell, the envelope's conversation is the only trusted
        // scope available for a missing conversation target.
        if (resourceId !== owner.conversationId) {
          throw projectionError("projection_conflict");
        }
        return;
      }
      assertOwned(
        {
          identity_id: conversation.identity_id,
          account_id: conversation.account_id,
          connection_id: conversation.connection_id,
          conversation_id: conversation.id,
          platform: conversation.platform,
        },
        owner,
      );
      assertConversationChildrenOwned(sql, {
        ...owner,
        conversationId: resourceId,
      });
      return;
    }
    case "participant": {
      assertParticipantReferenceOwners(sql, resourceId, owner);
      const participant = readParticipant(sql, resourceId);
      if (participant !== undefined) {
        assertOwned(
          {
            identity_id: participant.identity_id,
            account_id: participant.account_id,
            connection_id: participant.connection_id,
            conversation_id: participant.conversation_id,
            platform: participant.platform,
          },
          owner,
        );
      }
      return;
    }
    case "attachment": {
      const attachment = readAttachment(sql, resourceId);
      if (attachment !== undefined) {
        assertOwned(attachment, owner);
        assertMessageTargetOwner(sql, attachment.message_id, owner);
      }
      const attachmentTombstone = readAttachmentTombstone(sql, resourceId);
      assertOwned(attachmentTombstone, owner);
      return;
    }
    default:
      return;
  }
};

/**
 * Upsert one resource tombstone. Presence is permanent; only its audit
 * metadata is LWW-resolved. The caller applies the corresponding redaction
 * after this function returns, using the returned winner.
 */
export const upsertResourceTombstone = (
  sql: SqlStorage,
  prepared: PreparedProjectionEvent,
  resourceType: DeletableResourceType,
  resourceId: string,
  reasonCode: string | null,
): ResourceTombstoneRow => {
  const owner = ownerFor(prepared);
  assertTargetOwner(sql, resourceType, resourceId, owner);
  assertTombstoneEventIdAvailable(
    sql,
    prepared.event.event_id,
    resourceType,
    resourceId,
  );
  const existing = readResourceTombstone(sql, resourceType, resourceId);
  if (existing !== undefined) assertOwned(existing, owner);

  if (
    existing === undefined ||
    compareObservedTuple(
      prepared.observedMs,
      prepared.event.event_id,
      existing.observed_ms,
      existing.tombstone_event_id,
    ) > 0
  ) {
    if (existing === undefined) {
      sql.exec(
        "INSERT INTO resource_tombstones (resource_type, resource_id, tombstone_event_id, identity_id, account_id, connection_id, conversation_id, platform, reason_code, occurred_at, observed_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        resourceType,
        resourceId,
        prepared.event.event_id,
        owner.identityId,
        owner.accountId,
        owner.connectionId,
        owner.conversationId,
        owner.platform,
        reasonCode,
        prepared.event.occurred_at,
        prepared.observedMs,
      );
    } else {
      sql.exec(
        "UPDATE resource_tombstones SET tombstone_event_id = ?, reason_code = ?, occurred_at = ?, observed_ms = ? WHERE resource_type = ? AND resource_id = ?",
        prepared.event.event_id,
        reasonCode,
        prepared.event.occurred_at,
        prepared.observedMs,
        resourceType,
        resourceId,
      );
    }
  }

  const winner = readResourceTombstone(sql, resourceType, resourceId);
  if (winner === undefined) throw projectionError("projection_unavailable");
  assertOwned(winner, owner);
  return winner;
};

export const redactMessage = (
  sql: SqlStorage,
  messageId: string,
  tombstone: ResourceTombstoneRow,
): void => {
  const message = readMessage(sql, messageId);
  const tombstoneWinsCurrent =
    message !== undefined &&
    compareObservedTuple(
      tombstone.observed_ms,
      tombstone.tombstone_event_id,
      message.current_observed_ms,
      message.current_event_id,
    ) > 0;
  sql.exec(
    "UPDATE message_versions SET body = '', editor_participant_id = NULL WHERE message_id = ?",
    messageId,
  );
  sql.exec("DELETE FROM reactions WHERE message_id = ?", messageId);
  sql.exec("DELETE FROM receipts WHERE message_id = ?", messageId);
  sql.exec(
    "UPDATE message_delivery_updates SET failure_code = NULL WHERE message_id = ?",
    messageId,
  );
  sql.exec(
    "UPDATE attachments SET file_name = NULL, mime_type = NULL, size_bytes = NULL, sha256 = NULL, r2_key = NULL, expires_at = NULL, deleted_at = CASE WHEN EXISTS (SELECT 1 FROM resource_tombstones AS attachment_tombstone WHERE attachment_tombstone.resource_type = 'attachment' AND attachment_tombstone.resource_id = attachments.id AND (attachment_tombstone.observed_ms > ? OR (attachment_tombstone.observed_ms = ? AND attachment_tombstone.tombstone_event_id COLLATE BINARY > ?))) THEN (SELECT attachment_tombstone.occurred_at FROM resource_tombstones AS attachment_tombstone WHERE attachment_tombstone.resource_type = 'attachment' AND attachment_tombstone.resource_id = attachments.id) ELSE ? END WHERE message_id = ?",
    tombstone.observed_ms,
    tombstone.observed_ms,
    tombstone.tombstone_event_id,
    tombstone.occurred_at,
    messageId,
  );
  sql.exec(
    "UPDATE messages SET sender_participant_id = NULL, sender_label = 'Deleted sender', body = '', reply_to_message_id = NULL, matrix_room_id = NULL, matrix_event_id = NULL, remote_message_id = NULL, unread = 0, local_read_at = NULL, edited_at = NULL, deleted_at = ?, deletion_reason = ?, attachment_count = 0, delivery_failure_code = NULL, observed_at = ?, current_observed_ms = ?, current_event_id = ? WHERE id = ?",
    tombstone.occurred_at,
    tombstone.reason_code,
    tombstoneWinsCurrent
      ? canonicalObservedAt(tombstone.observed_ms)
      : (message?.observed_at ?? canonicalObservedAt(tombstone.observed_ms)),
    tombstoneWinsCurrent
      ? tombstone.observed_ms
      : (message?.current_observed_ms ?? tombstone.observed_ms),
    tombstoneWinsCurrent
      ? tombstone.tombstone_event_id
      : (message?.current_event_id ?? tombstone.tombstone_event_id),
    messageId,
  );
};

const redactParticipant = (
  sql: SqlStorage,
  participantId: string,
  tombstone: ResourceTombstoneRow,
): void => {
  sql.exec(
    "UPDATE participants SET display_name = 'Deleted participant', remote_id = NULL, avatar_url = NULL, deleted_at = ? WHERE id = ?",
    tombstone.occurred_at,
    participantId,
  );
  sql.exec(
    "UPDATE message_versions SET editor_participant_id = NULL WHERE editor_participant_id = ?",
    participantId,
  );
  sql.exec(
    "UPDATE messages SET sender_participant_id = NULL, sender_label = 'Deleted sender' WHERE sender_participant_id = ?",
    participantId,
  );
  sql.exec("DELETE FROM reactions WHERE participant_id = ?", participantId);
  sql.exec("DELETE FROM receipts WHERE participant_id = ?", participantId);
  sql.exec("DELETE FROM typing_states WHERE participant_id = ?", participantId);
};

const redactAttachment = (
  sql: SqlStorage,
  attachmentId: string,
  tombstone: ResourceTombstoneRow,
): void => {
  sql.exec(
    "UPDATE attachments SET file_name = NULL, mime_type = NULL, size_bytes = NULL, sha256 = NULL, r2_key = NULL, expires_at = NULL, deleted_at = ? WHERE id = ?",
    tombstone.occurred_at,
    attachmentId,
  );
};

const redactConversation = (
  sql: SqlStorage,
  conversationId: string,
  tombstone: ResourceTombstoneRow,
  owner: ProjectionOwner,
): void => {
  // Check every affected row before the first cascade mutation. This also
  // prevents a malformed row from being silently scrubbed across owners.
  assertConversationChildrenOwned(sql, { ...owner, conversationId });
  sql.exec(
    "UPDATE conversations SET title = 'Deleted conversation', last_message_preview = '', archived = 0, muted = 0, unread_count = 0, message_count = 0, attachment_count = 0, deleted_at = ?, last_event_id = ?, updated_at = shell_activity_at WHERE id = ?",
    tombstone.occurred_at,
    tombstone.tombstone_event_id,
    conversationId,
  );
  sql.exec(
    "UPDATE message_versions SET body = '', editor_participant_id = NULL WHERE conversation_id = ?",
    conversationId,
  );
  sql.exec(
    "UPDATE messages SET sender_participant_id = NULL, sender_label = 'Deleted sender', body = '', reply_to_message_id = NULL, matrix_room_id = NULL, matrix_event_id = NULL, remote_message_id = NULL, unread = 0, local_read_at = NULL, edited_at = NULL, deleted_at = CASE WHEN EXISTS (SELECT 1 FROM resource_tombstones AS message_tombstone WHERE message_tombstone.resource_type = 'message' AND message_tombstone.resource_id = messages.id AND (message_tombstone.observed_ms > ? OR (message_tombstone.observed_ms = ? AND message_tombstone.tombstone_event_id COLLATE BINARY > ?))) THEN (SELECT message_tombstone.occurred_at FROM resource_tombstones AS message_tombstone WHERE message_tombstone.resource_type = 'message' AND message_tombstone.resource_id = messages.id) ELSE ? END, deletion_reason = CASE WHEN EXISTS (SELECT 1 FROM resource_tombstones AS message_tombstone WHERE message_tombstone.resource_type = 'message' AND message_tombstone.resource_id = messages.id AND (message_tombstone.observed_ms > ? OR (message_tombstone.observed_ms = ? AND message_tombstone.tombstone_event_id COLLATE BINARY > ?))) THEN (SELECT message_tombstone.reason_code FROM resource_tombstones AS message_tombstone WHERE message_tombstone.resource_type = 'message' AND message_tombstone.resource_id = messages.id) ELSE ? END, attachment_count = 0, delivery_failure_code = NULL WHERE conversation_id = ?",
    tombstone.observed_ms,
    tombstone.observed_ms,
    tombstone.tombstone_event_id,
    tombstone.occurred_at,
    tombstone.observed_ms,
    tombstone.observed_ms,
    tombstone.tombstone_event_id,
    tombstone.reason_code,
    conversationId,
  );
  // A conversation tombstone is an effective state transition for every
  // message. Advance the current observed tuple set-wise when it wins so a
  // tombstone-before-target stream converges with target-before-tombstone.
  sql.exec(
    "UPDATE messages SET observed_at = ?, current_observed_ms = ?, current_event_id = ? WHERE conversation_id = ? AND (current_observed_ms < ? OR (current_observed_ms = ? AND current_event_id COLLATE BINARY < ?))",
    canonicalObservedAt(tombstone.observed_ms),
    tombstone.observed_ms,
    tombstone.tombstone_event_id,
    conversationId,
    tombstone.observed_ms,
    tombstone.observed_ms,
    tombstone.tombstone_event_id,
  );
  sql.exec(
    "UPDATE participants SET display_name = 'Deleted participant', remote_id = NULL, avatar_url = NULL, deleted_at = CASE WHEN EXISTS (SELECT 1 FROM resource_tombstones AS participant_tombstone WHERE participant_tombstone.resource_type = 'participant' AND participant_tombstone.resource_id = participants.id AND (participant_tombstone.observed_ms > ? OR (participant_tombstone.observed_ms = ? AND participant_tombstone.tombstone_event_id COLLATE BINARY > ?))) THEN (SELECT participant_tombstone.occurred_at FROM resource_tombstones AS participant_tombstone WHERE participant_tombstone.resource_type = 'participant' AND participant_tombstone.resource_id = participants.id) ELSE ? END WHERE conversation_id = ?",
    tombstone.observed_ms,
    tombstone.observed_ms,
    tombstone.tombstone_event_id,
    tombstone.occurred_at,
    conversationId,
  );
  sql.exec(
    "WITH conversation_tombstone(observed_ms, tombstone_event_id, occurred_at) AS (VALUES (?, ?, ?)), effective_attachment_tombstones AS (SELECT attachments.id, CASE WHEN attachment_tombstone.observed_ms IS NOT NULL AND (message_tombstone.observed_ms IS NULL OR attachment_tombstone.observed_ms > message_tombstone.observed_ms OR (attachment_tombstone.observed_ms = message_tombstone.observed_ms AND attachment_tombstone.tombstone_event_id COLLATE BINARY > message_tombstone.tombstone_event_id COLLATE BINARY)) AND (attachment_tombstone.observed_ms > conversation_tombstone.observed_ms OR (attachment_tombstone.observed_ms = conversation_tombstone.observed_ms AND attachment_tombstone.tombstone_event_id COLLATE BINARY > conversation_tombstone.tombstone_event_id COLLATE BINARY)) THEN attachment_tombstone.occurred_at WHEN message_tombstone.observed_ms IS NOT NULL AND (attachment_tombstone.observed_ms IS NULL OR message_tombstone.observed_ms > attachment_tombstone.observed_ms OR (message_tombstone.observed_ms = attachment_tombstone.observed_ms AND message_tombstone.tombstone_event_id COLLATE BINARY > attachment_tombstone.tombstone_event_id COLLATE BINARY)) AND (message_tombstone.observed_ms > conversation_tombstone.observed_ms OR (message_tombstone.observed_ms = conversation_tombstone.observed_ms AND message_tombstone.tombstone_event_id COLLATE BINARY > conversation_tombstone.tombstone_event_id COLLATE BINARY)) THEN message_tombstone.occurred_at ELSE conversation_tombstone.occurred_at END AS deleted_at FROM attachments CROSS JOIN conversation_tombstone LEFT JOIN resource_tombstones AS attachment_tombstone ON attachment_tombstone.resource_type = 'attachment' AND attachment_tombstone.resource_id = attachments.id LEFT JOIN resource_tombstones AS message_tombstone ON message_tombstone.resource_type = 'message' AND message_tombstone.resource_id = attachments.message_id WHERE attachments.conversation_id = ?) UPDATE attachments SET file_name = NULL, mime_type = NULL, size_bytes = NULL, sha256 = NULL, r2_key = NULL, expires_at = NULL, deleted_at = (SELECT effective_attachment_tombstones.deleted_at FROM effective_attachment_tombstones WHERE effective_attachment_tombstones.id = attachments.id) WHERE conversation_id = ?",
    tombstone.observed_ms,
    tombstone.tombstone_event_id,
    tombstone.occurred_at,
    conversationId,
    conversationId,
  );
  sql.exec("DELETE FROM reactions WHERE conversation_id = ?", conversationId);
  sql.exec("DELETE FROM receipts WHERE conversation_id = ?", conversationId);
  sql.exec(
    "DELETE FROM typing_states WHERE conversation_id = ?",
    conversationId,
  );
  sql.exec(
    "UPDATE message_delivery_updates SET failure_code = NULL WHERE conversation_id = ?",
    conversationId,
  );
  sql.exec(
    "UPDATE commands SET failure_code = NULL WHERE conversation_id = ?",
    conversationId,
  );
};

export const projectMessageDeleted = (
  sql: SqlStorage,
  prepared: PreparedProjectionEvent,
): void => {
  const event = prepared.event as MessageDeletedEvent;
  const owner = ownerFor(prepared);
  ensureConversationShell(sql, prepared);
  const tombstone = upsertResourceTombstone(
    sql,
    prepared,
    "message",
    event.payload.message_id,
    event.payload.reason_code,
  );
  const effectiveTombstone = latestTombstone(
    tombstone,
    readConversationTombstone(sql, owner.conversationId),
  );
  if (effectiveTombstone === undefined)
    throw projectionError("projection_unavailable");
  redactMessage(sql, event.payload.message_id, effectiveTombstone);
};

export const projectDeletionTombstone = (
  sql: SqlStorage,
  prepared: PreparedProjectionEvent,
): void => {
  const event = prepared.event as DeletionTombstoneEvent;
  const owner = ownerFor(prepared);
  ensureConversationShell(sql, prepared);
  const resourceType = event.payload.resource_type;
  const resourceId = event.payload.resource_id;
  const tombstone = upsertResourceTombstone(
    sql,
    prepared,
    resourceType,
    resourceId,
    event.payload.reason_code,
  );

  switch (resourceType) {
    case "message": {
      const effectiveTombstone = latestTombstone(
        tombstone,
        readConversationTombstone(sql, owner.conversationId),
      );
      if (effectiveTombstone === undefined)
        throw projectionError("projection_unavailable");
      redactMessage(sql, resourceId, effectiveTombstone);
      return;
    }
    case "conversation":
      redactConversation(sql, resourceId, tombstone, owner);
      return;
    case "participant": {
      const effectiveTombstone = latestTombstone(
        tombstone,
        readConversationTombstone(sql, owner.conversationId),
      );
      if (effectiveTombstone === undefined)
        throw projectionError("projection_unavailable");
      redactParticipant(sql, resourceId, effectiveTombstone);
      return;
    }
    case "attachment": {
      const attachment = readAttachment(sql, resourceId);
      const effectiveTombstone = latestTombstone(
        latestTombstone(
          tombstone,
          attachment === undefined
            ? undefined
            : readMessageTombstone(sql, attachment.message_id),
        ),
        readConversationTombstone(sql, owner.conversationId),
      );
      if (effectiveTombstone === undefined)
        throw projectionError("projection_unavailable");
      redactAttachment(sql, resourceId, effectiveTombstone);
      return;
    }
    default:
      return;
  }
};

export const conversationIsDeleted = (
  sql: SqlStorage,
  conversationId: string,
): ResourceTombstoneRow | undefined =>
  readConversationTombstone(sql, conversationId);

export const participantIsDeleted = (
  sql: SqlStorage,
  participantId: string,
): ResourceTombstoneRow | undefined =>
  readParticipantTombstone(sql, participantId);

export const attachmentIsDeleted = (
  sql: SqlStorage,
  attachmentId: string,
): ResourceTombstoneRow | undefined =>
  readAttachmentTombstone(sql, attachmentId);

export const messageIsDeleted = (
  sql: SqlStorage,
  messageId: string,
): ResourceTombstoneRow | undefined => readMessageTombstone(sql, messageId);
