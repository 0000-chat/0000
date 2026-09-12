import { projectionError } from "./errors";
import type { PreparedProjectionEvent } from "./projector-types";
import {
  conversationIsDeleted,
  latestTombstone,
  messageIsDeleted,
  participantIsDeleted,
  redactMessage,
} from "./projector-deletion";
import { reconcileMessageDelivery } from "./projector-control";
import { reconcileMessageLocalRead } from "./projector-social";
import {
  assertMessageTargetOwner,
  assertReferencedMessageOwner,
  assertReferencedParticipantOwner,
  canonicalObservedAt,
  compareObservedTuple,
  ensureConversationShell,
  ownerFor,
  readLatestMessageVersion,
  readMessage,
  type MessageCreatedEvent,
  type MessageEditedEvent,
  type MessageRow,
  type MessageVersionRow,
  type ResourceTombstoneRow,
} from "./projector-common";

const insertMessageVersion = (
  sql: SqlStorage,
  prepared: PreparedProjectionEvent,
  messageId: string,
  versionKind: "created" | "edited",
  body: string,
  editorParticipantId: string | null,
): void => {
  const owner = ownerFor(prepared);
  sql.exec(
    "INSERT INTO message_versions (event_id, message_id, identity_id, account_id, connection_id, conversation_id, platform, version_kind, body, editor_participant_id, occurred_at, observed_at, observed_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    prepared.event.event_id,
    messageId,
    owner.identityId,
    owner.accountId,
    owner.connectionId,
    owner.conversationId,
    owner.platform,
    versionKind,
    body,
    editorParticipantId,
    prepared.event.occurred_at,
    prepared.event.observed_at,
    prepared.observedMs,
  );
};

const applyCurrentMessageVersion = (
  sql: SqlStorage,
  message: MessageRow,
  latest: MessageVersionRow,
  tombstone: ResourceTombstoneRow | undefined,
): void => {
  const currentIsNewer =
    compareObservedTuple(
      latest.observed_ms,
      latest.event_id,
      message.current_observed_ms,
      message.current_event_id,
    ) > 0;
  if (!currentIsNewer && tombstone === undefined) return;

  if (tombstone !== undefined) {
    redactMessage(sql, message.id, tombstone);
    if (
      currentIsNewer &&
      compareObservedTuple(
        latest.observed_ms,
        latest.event_id,
        tombstone.observed_ms,
        tombstone.tombstone_event_id,
      ) > 0
    ) {
      sql.exec(
        "UPDATE messages SET observed_at = ?, current_observed_ms = ?, current_event_id = ? WHERE id = ?",
        latest.observed_at,
        latest.observed_ms,
        latest.event_id,
        message.id,
      );
    }
    return;
  }

  if (latest.version_kind === "edited") {
    sql.exec(
      "UPDATE messages SET body = ?, edited_at = ?, observed_at = ?, current_observed_ms = ?, current_event_id = ? WHERE id = ?",
      latest.body,
      latest.occurred_at,
      latest.observed_at,
      latest.observed_ms,
      latest.event_id,
      message.id,
    );
    return;
  }

  sql.exec(
    "UPDATE messages SET body = ?, edited_at = NULL, observed_at = ?, current_observed_ms = ?, current_event_id = ? WHERE id = ?",
    latest.body,
    latest.observed_at,
    latest.observed_ms,
    latest.event_id,
    message.id,
  );
};

const readLatestCreatedVersion = (
  sql: SqlStorage,
  messageId: string,
): MessageVersionRow | undefined =>
  sql
    .exec<MessageVersionRow>(
      "SELECT event_id, message_id, identity_id, account_id, connection_id, conversation_id, platform, version_kind, body, editor_participant_id, occurred_at, observed_at, observed_ms FROM message_versions WHERE message_id = ? AND version_kind = 'created' ORDER BY observed_ms DESC, event_id COLLATE BINARY DESC LIMIT 1",
      messageId,
    )
    .toArray()[0];

/**
 * Create events carry immutable message metadata that is not duplicated in
 * message_versions. Reconcile it from the winning created event independently
 * of whichever created/edited body version currently wins the LWW tuple.
 */
const reconcileWinningCreatedFields = (
  sql: SqlStorage,
  messageId: string,
  prepared: PreparedProjectionEvent,
  tombstone: ResourceTombstoneRow | undefined,
  senderTombstone: ResourceTombstoneRow | undefined,
): void => {
  const event = prepared.event as MessageCreatedEvent;
  const winner = readLatestCreatedVersion(sql, messageId);
  if (winner?.event_id !== event.event_id) return;

  const payload = event.payload;
  const pendingDelivery = sql
    .exec<{ message_id: string }>(
      "SELECT message_id FROM message_delivery_updates WHERE message_id = ?",
      messageId,
    )
    .toArray()[0];
  const metadataBindings = [
    tombstone !== undefined || senderTombstone !== undefined
      ? null
      : payload.sender_participant_id,
    tombstone !== undefined || senderTombstone !== undefined
      ? "Deleted sender"
      : payload.sender_label,
    tombstone !== undefined ? null : payload.reply_to_message_id,
    tombstone !== undefined ? 0 : payload.unread ? 1 : 0,
    event.occurred_at,
    prepared.occurredMs,
    tombstone !== undefined ? null : event.matrix_room_id,
    tombstone !== undefined ? null : event.matrix_event_id,
    tombstone !== undefined ? null : event.remote_message_id,
    messageId,
  ] as const;
  if (pendingDelivery === undefined) {
    sql.exec(
      "UPDATE messages SET sender_participant_id = ?, sender_label = ?, reply_to_message_id = ?, delivery_status = ?, unread = ?, occurred_at = ?, occurred_ms = ?, matrix_room_id = ?, matrix_event_id = ?, remote_message_id = ? WHERE id = ?",
      metadataBindings[0],
      metadataBindings[1],
      metadataBindings[2],
      payload.delivery_status,
      metadataBindings[3],
      metadataBindings[4],
      metadataBindings[5],
      metadataBindings[6],
      metadataBindings[7],
      metadataBindings[8],
      metadataBindings[9],
    );
  } else {
    sql.exec(
      "UPDATE messages SET sender_participant_id = ?, sender_label = ?, reply_to_message_id = ?, unread = ?, occurred_at = ?, occurred_ms = ?, matrix_room_id = ?, matrix_event_id = ?, remote_message_id = ? WHERE id = ?",
      ...metadataBindings,
    );
  }
};

const effectiveMessageTombstone = (
  sql: SqlStorage,
  messageId: string,
  conversationId: string,
): ResourceTombstoneRow | undefined =>
  latestTombstone(messageIsDeleted(sql, messageId), conversationIsDeleted(sql, conversationId));

const initializeCreatedDeliveryTuple = (
  sql: SqlStorage,
  messageId: string,
): void => {
  const delivery = sql
    .exec<{ message_id: string }>(
      "SELECT message_id FROM message_delivery_updates WHERE message_id = ?",
      messageId,
    )
    .toArray()[0];
  if (delivery !== undefined) {
    reconcileMessageDelivery(sql, messageId);
  }
};

export const projectMessageCreated = (
  sql: SqlStorage,
  prepared: PreparedProjectionEvent,
): void => {
  const event = prepared.event as MessageCreatedEvent;
  const owner = ownerFor(prepared);
  const payload = event.payload;
  assertReferencedParticipantOwner(sql, payload.sender_participant_id, owner);
  assertReferencedMessageOwner(sql, payload.reply_to_message_id, owner);
  const messageId = payload.message_id;
  const message = assertMessageTargetOwner(sql, messageId, owner);
  if (message !== undefined && message.direction !== payload.direction) {
    throw projectionError("projection_conflict");
  }
  ensureConversationShell(sql, prepared);
  const tombstone = effectiveMessageTombstone(sql, messageId, owner.conversationId);
  const senderTombstone = payload.sender_participant_id === null
    ? undefined
    : participantIsDeleted(sql, payload.sender_participant_id);
  const redacted = tombstone !== undefined;
  insertMessageVersion(
    sql,
    prepared,
    messageId,
    "created",
    redacted ? "" : payload.body,
    null,
  );
  const latest = readLatestMessageVersion(sql, messageId);
  if (latest === undefined) throw projectionError("projection_unavailable");

  if (message === undefined) {
    const currentIsTombstone =
      tombstone !== undefined &&
      compareObservedTuple(
        tombstone.observed_ms,
        tombstone.tombstone_event_id,
        latest.observed_ms,
        latest.event_id,
      ) > 0;
    sql.exec(
      "INSERT INTO messages (id, identity_id, account_id, connection_id, conversation_id, platform, direction, sender_participant_id, sender_label, body, reply_to_message_id, delivery_status, unread, local_read_at, occurred_at, occurred_ms, observed_at, current_observed_ms, current_event_id, matrix_room_id, matrix_event_id, remote_message_id, edited_at, deleted_at, deletion_reason, attachment_count, delivery_failure_code, delivery_observed_ms, delivery_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL)",
      messageId,
      owner.identityId,
      owner.accountId,
      owner.connectionId,
      owner.conversationId,
      owner.platform,
      payload.direction,
      redacted || senderTombstone !== undefined ? null : payload.sender_participant_id,
      redacted || senderTombstone !== undefined ? "Deleted sender" : payload.sender_label,
      latest.body,
      redacted ? null : payload.reply_to_message_id,
      payload.delivery_status,
      redacted ? 0 : payload.unread ? 1 : 0,
      event.occurred_at,
      prepared.occurredMs,
      currentIsTombstone ? canonicalObservedAt(tombstone!.observed_ms) : latest.observed_at,
      currentIsTombstone ? tombstone!.observed_ms : latest.observed_ms,
      currentIsTombstone ? tombstone!.tombstone_event_id : latest.event_id,
      redacted ? null : event.matrix_room_id,
      redacted ? null : event.matrix_event_id,
      redacted ? null : event.remote_message_id,
      latest.version_kind === "edited" && !redacted ? latest.occurred_at : null,
      tombstone?.occurred_at ?? null,
      tombstone?.reason_code ?? null,
    );
    initializeCreatedDeliveryTuple(sql, messageId);
  } else {
    applyCurrentMessageVersion(sql, message, latest, tombstone);
    reconcileWinningCreatedFields(sql, messageId, prepared, tombstone, senderTombstone);
    initializeCreatedDeliveryTuple(sql, messageId);
  }

  if (tombstone !== undefined) {
    const current = readMessage(sql, messageId);
    if (current !== undefined) redactMessage(sql, messageId, tombstone);
  }

  // Receipts and attachments may legitimately precede message creation. The
  // summary pass reconciles attachment counts; this pass applies the newest
  // local read before the message becomes visible to callers.
  reconcileMessageLocalRead(sql, messageId);
};

export const projectMessageEdited = (
  sql: SqlStorage,
  prepared: PreparedProjectionEvent,
): void => {
  const event = prepared.event as MessageEditedEvent;
  const owner = ownerFor(prepared);
  const payload = event.payload;
  assertReferencedParticipantOwner(sql, payload.editor_participant_id, owner);
  const message = assertMessageTargetOwner(sql, payload.message_id, owner);
  ensureConversationShell(sql, prepared);
  const tombstone = effectiveMessageTombstone(sql, payload.message_id, owner.conversationId);
  const editorTombstone = payload.editor_participant_id === null
    ? undefined
    : participantIsDeleted(sql, payload.editor_participant_id);
  insertMessageVersion(
    sql,
    prepared,
    payload.message_id,
    "edited",
    tombstone === undefined ? payload.body : "",
    tombstone === undefined && editorTombstone === undefined
      ? payload.editor_participant_id
      : null,
  );
  if (message === undefined) return;
  const latest = readLatestMessageVersion(sql, payload.message_id);
  if (latest === undefined) throw projectionError("projection_unavailable");
  applyCurrentMessageVersion(sql, message, latest, tombstone);
  reconcileMessageLocalRead(sql, payload.message_id);
};
