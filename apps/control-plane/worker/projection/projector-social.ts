import type { ProjectionEventEnvelope } from "@communicator/contracts";
import { projectionError } from "./errors";
import type { PreparedProjectionEvent } from "./projector-types";
import {
  attachmentIsDeleted,
  conversationIsDeleted,
  latestTombstone,
  messageIsDeleted,
  participantIsDeleted,
} from "./projector-deletion";
import {
  assertMessageTargetOwner,
  assertCanonicalResourceIdOwner,
  assertOwner,
  assertReferencedMessageOwner,
  assertReferencedParticipantOwner,
  compareObservedTuple,
  ensureConversationShell,
  ownerFor,
  readMessage,
  type OwnedProjectionRow,
  type ProjectionOwner,
  type ResourceTombstoneRow,
} from "./projector-common";

type ReactionAddedEvent = Extract<
  ProjectionEventEnvelope,
  { event_type: "reaction.added" }
>;
type ReactionRemovedEvent = Extract<
  ProjectionEventEnvelope,
  { event_type: "reaction.removed" }
>;
type ReceiptEvent = Extract<
  ProjectionEventEnvelope,
  { event_type: "receipt.read" | "receipt.delivered" }
>;
type TypingStartedEvent = Extract<
  ProjectionEventEnvelope,
  { event_type: "typing.started" }
>;
type TypingStoppedEvent = Extract<
  ProjectionEventEnvelope,
  { event_type: "typing.stopped" }
>;
type AttachmentObservedEvent = Extract<
  ProjectionEventEnvelope,
  { event_type: "attachment.observed" }
>;

type ReactionRow = OwnedProjectionRow & {
  id: string;
  message_id: string;
  participant_id: string | null;
  emoji: string | null;
  occurred_at: string;
  last_observed_ms: number;
  last_event_id: string;
  removed_at: string | null;
};

type ReceiptRow = OwnedProjectionRow & {
  message_id: string;
  participant_id: string;
  receipt_type: "read" | "delivered";
  local_identity: number;
  occurred_at: string;
  last_observed_ms: number;
  last_event_id: string;
};

type TypingRow = OwnedProjectionRow & {
  participant_id: string;
  is_typing: number;
  expires_at: string | null;
  last_observed_ms: number;
  last_event_id: string;
};

type AttachmentRow = OwnedProjectionRow & {
  id: string;
  message_id: string;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  r2_key: string | null;
  observed_at: string;
  last_observed_ms: number;
  last_event_id: string;
  deleted_at: string | null;
};

const readReaction = (sql: SqlStorage, reactionId: string): ReactionRow | undefined =>
  sql
    .exec<ReactionRow>(
      "SELECT id, message_id, identity_id, account_id, connection_id, conversation_id, platform, participant_id, emoji, occurred_at, last_observed_ms, last_event_id, removed_at FROM reactions WHERE id = ?",
      reactionId,
    )
    .toArray()[0];

const readReceipt = (
  sql: SqlStorage,
  messageId: string,
  participantId: string,
  receiptType: "read" | "delivered",
): ReceiptRow | undefined =>
  sql
    .exec<ReceiptRow>(
      "SELECT message_id, participant_id, receipt_type, identity_id, account_id, connection_id, conversation_id, platform, local_identity, occurred_at, last_observed_ms, last_event_id FROM receipts WHERE message_id = ? AND participant_id = ? AND receipt_type = ?",
      messageId,
      participantId,
      receiptType,
    )
    .toArray()[0];

const readTyping = (
  sql: SqlStorage,
  conversationId: string,
  participantId: string,
): TypingRow | undefined =>
  sql
    .exec<TypingRow>(
      "SELECT conversation_id, participant_id, identity_id, account_id, connection_id, platform, is_typing, expires_at, last_observed_ms, last_event_id FROM typing_states WHERE conversation_id = ? AND participant_id = ?",
      conversationId,
      participantId,
    )
    .toArray()[0];

const readAttachment = (
  sql: SqlStorage,
  attachmentId: string,
): AttachmentRow | undefined =>
  sql
    .exec<AttachmentRow>(
      "SELECT id, message_id, identity_id, account_id, connection_id, conversation_id, platform, file_name, mime_type, size_bytes, sha256, r2_key, observed_at, last_observed_ms, last_event_id, deleted_at FROM attachments WHERE id = ?",
      attachmentId,
    )
    .toArray()[0];

const assertOwnedRow = (
  row: OwnedProjectionRow | undefined,
  owner: ProjectionOwner,
): void => {
  if (row !== undefined) assertOwner(row, owner);
};

const assertReactionTarget = (
  sql: SqlStorage,
  messageId: string,
  owner: ProjectionOwner,
): void => {
  assertReferencedMessageOwner(sql, messageId, owner);
};

const assertReactionIdentity = (
  row: ReactionRow,
  messageId: string,
  owner: ProjectionOwner,
): void => {
  assertOwnedRow(row, owner);
  if (row.message_id !== messageId) throw projectionError("projection_conflict");
};

const messageIsRedacted = (
  sql: SqlStorage,
  messageId: string,
  conversationId: string,
): ResourceTombstoneRow | undefined =>
  latestTombstone(messageIsDeleted(sql, messageId), conversationIsDeleted(sql, conversationId));

const projectReactionAdded = (
  sql: SqlStorage,
  prepared: PreparedProjectionEvent,
): void => {
  const event = prepared.event as ReactionAddedEvent;
  const payload = event.payload;
  const owner = ownerFor(prepared);

  ensureConversationShell(sql, prepared);
  assertCanonicalResourceIdOwner(sql, "reaction", payload.reaction_id, owner);
  assertReactionTarget(sql, payload.message_id, owner);
  assertReferencedParticipantOwner(sql, payload.participant_id, owner);

  const existing = readReaction(sql, payload.reaction_id);
  if (existing !== undefined) assertReactionIdentity(existing, payload.message_id, owner);

  const tombstone = messageIsRedacted(sql, payload.message_id, owner.conversationId);
  const participantTombstone = participantIsDeleted(sql, payload.participant_id);
  if (tombstone !== undefined || participantTombstone !== undefined) {
    // Deletions remove reactions rather than retaining a row whose participant
    // or emoji could be mistaken for visible content.
    if (existing !== undefined) {
      sql.exec("DELETE FROM reactions WHERE id = ?", payload.reaction_id);
    }
    return;
  }

  if (
    existing !== undefined &&
    compareObservedTuple(
      prepared.observedMs,
      event.event_id,
      existing.last_observed_ms,
      existing.last_event_id,
    ) <= 0
  ) {
    return;
  }

  if (existing === undefined) {
    sql.exec(
      "INSERT INTO reactions (id, message_id, identity_id, account_id, connection_id, conversation_id, platform, participant_id, emoji, occurred_at, last_observed_ms, last_event_id, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
      payload.reaction_id,
      payload.message_id,
      owner.identityId,
      owner.accountId,
      owner.connectionId,
      owner.conversationId,
      owner.platform,
      payload.participant_id,
      payload.emoji,
      event.occurred_at,
      prepared.observedMs,
      event.event_id,
    );
    return;
  }

  sql.exec(
    "UPDATE reactions SET participant_id = ?, emoji = ?, occurred_at = ?, last_observed_ms = ?, last_event_id = ?, removed_at = NULL WHERE id = ?",
    payload.participant_id,
    payload.emoji,
    event.occurred_at,
    prepared.observedMs,
    event.event_id,
    payload.reaction_id,
  );
};

const projectReactionRemoved = (
  sql: SqlStorage,
  prepared: PreparedProjectionEvent,
): void => {
  const event = prepared.event as ReactionRemovedEvent;
  const payload = event.payload;
  const owner = ownerFor(prepared);

  ensureConversationShell(sql, prepared);
  assertCanonicalResourceIdOwner(sql, "reaction", payload.reaction_id, owner);
  assertReactionTarget(sql, payload.message_id, owner);
  const existing = readReaction(sql, payload.reaction_id);
  if (existing !== undefined) assertReactionIdentity(existing, payload.message_id, owner);

  const tombstone = messageIsRedacted(sql, payload.message_id, owner.conversationId);
  if (tombstone !== undefined) {
    if (existing !== undefined) sql.exec("DELETE FROM reactions WHERE id = ?", payload.reaction_id);
    return;
  }

  if (
    existing !== undefined &&
    compareObservedTuple(
      prepared.observedMs,
      event.event_id,
      existing.last_observed_ms,
      existing.last_event_id,
    ) <= 0
  ) {
    return;
  }

  if (existing === undefined) {
    sql.exec(
      "INSERT INTO reactions (id, message_id, identity_id, account_id, connection_id, conversation_id, platform, participant_id, emoji, occurred_at, last_observed_ms, last_event_id, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)",
      payload.reaction_id,
      payload.message_id,
      owner.identityId,
      owner.accountId,
      owner.connectionId,
      owner.conversationId,
      owner.platform,
      null,
      event.occurred_at,
      prepared.observedMs,
      event.event_id,
      event.occurred_at,
    );
    return;
  }

  sql.exec(
    "UPDATE reactions SET participant_id = NULL, emoji = NULL, occurred_at = ?, last_observed_ms = ?, last_event_id = ?, removed_at = ? WHERE id = ?",
    event.occurred_at,
    prepared.observedMs,
    event.event_id,
    event.occurred_at,
    payload.reaction_id,
  );
};

const latestLocalRead = (
  sql: SqlStorage,
  messageId: string,
): { occurred_at: string; last_observed_ms: number; last_event_id: string } | undefined =>
  sql
    .exec<{ occurred_at: string; last_observed_ms: number; last_event_id: string }>(
      "SELECT occurred_at, last_observed_ms, last_event_id FROM receipts WHERE message_id = ? AND receipt_type = 'read' AND local_identity = 1 ORDER BY last_observed_ms DESC, last_event_id COLLATE BINARY DESC LIMIT 1",
      messageId,
    )
    .toArray()[0];

/** Reconcile a message with the newest local read receipt, including pending receipts. */
export const reconcileMessageLocalRead = (
  sql: SqlStorage,
  messageId: string,
): void => {
  const message = readMessage(sql, messageId);
  if (message === undefined || messageIsRedacted(sql, messageId, message.conversation_id) !== undefined) return;
  const localRead = latestLocalRead(sql, messageId);
  if (localRead === undefined) return;
  sql.exec(
    "UPDATE messages SET local_read_at = ?, unread = 0 WHERE id = ?",
    localRead.occurred_at,
    messageId,
  );
};

const projectReceipt = (
  sql: SqlStorage,
  prepared: PreparedProjectionEvent,
): void => {
  const event = prepared.event as ReceiptEvent;
  const payload = event.payload;
  const owner = ownerFor(prepared);
  const receiptType = event.event_type === "receipt.read" ? "read" : "delivered";

  ensureConversationShell(sql, prepared);
  assertReferencedMessageOwner(sql, payload.message_id, owner);
  assertReferencedParticipantOwner(sql, payload.participant_id, owner);

  const existing = readReceipt(
    sql,
    payload.message_id,
    payload.participant_id,
    receiptType,
  );
  assertOwnedRow(existing, owner);
  if (
    existing !== undefined &&
    existing.local_identity !== (payload.local_identity ? 1 : 0)
  ) {
    // A receipt's local/remote classification is part of its stable scoped
    // key. It cannot be changed by a newer event or hidden by an older one.
    throw projectionError("projection_conflict");
  }

  const tombstone = messageIsRedacted(sql, payload.message_id, owner.conversationId);
  const participantTombstone = participantIsDeleted(sql, payload.participant_id);
  if (tombstone !== undefined || participantTombstone !== undefined) {
    // Receipts are removed when a message is tombstoned and remain blocked
    // for any later observations, including an older tuple arriving late.
    if (existing !== undefined) {
      sql.exec(
        "DELETE FROM receipts WHERE message_id = ? AND participant_id = ? AND receipt_type = ?",
        payload.message_id,
        payload.participant_id,
        receiptType,
      );
    }
    return;
  }

  if (
    existing !== undefined &&
    compareObservedTuple(
      prepared.observedMs,
      event.event_id,
      existing.last_observed_ms,
      existing.last_event_id,
    ) <= 0
  ) {
    return;
  }

  if (existing === undefined) {
    sql.exec(
      "INSERT INTO receipts (message_id, participant_id, receipt_type, identity_id, account_id, connection_id, conversation_id, platform, local_identity, occurred_at, last_observed_ms, last_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      payload.message_id,
      payload.participant_id,
      receiptType,
      owner.identityId,
      owner.accountId,
      owner.connectionId,
      owner.conversationId,
      owner.platform,
      payload.local_identity ? 1 : 0,
      event.occurred_at,
      prepared.observedMs,
      event.event_id,
    );
  } else {
    sql.exec(
      "UPDATE receipts SET identity_id = ?, account_id = ?, connection_id = ?, conversation_id = ?, platform = ?, local_identity = ?, occurred_at = ?, last_observed_ms = ?, last_event_id = ? WHERE message_id = ? AND participant_id = ? AND receipt_type = ?",
      owner.identityId,
      owner.accountId,
      owner.connectionId,
      owner.conversationId,
      owner.platform,
      payload.local_identity ? 1 : 0,
      event.occurred_at,
      prepared.observedMs,
      event.event_id,
      payload.message_id,
      payload.participant_id,
      receiptType,
    );
  }

  if (receiptType === "read" && payload.local_identity) {
    reconcileMessageLocalRead(sql, payload.message_id);
  }
};

const projectTypingStarted = (
  sql: SqlStorage,
  prepared: PreparedProjectionEvent,
): void => {
  const event = prepared.event as TypingStartedEvent;
  const payload = event.payload;
  const owner = ownerFor(prepared);

  ensureConversationShell(sql, prepared);
  assertReferencedParticipantOwner(sql, payload.participant_id, owner);
  const existing = readTyping(sql, owner.conversationId, payload.participant_id);
  assertOwnedRow(existing, owner);
  if (
    conversationIsDeleted(sql, owner.conversationId) !== undefined ||
    participantIsDeleted(sql, payload.participant_id) !== undefined
  ) {
    if (existing !== undefined) {
      sql.exec(
        "DELETE FROM typing_states WHERE conversation_id = ? AND participant_id = ?",
        owner.conversationId,
        payload.participant_id,
      );
    }
    return;
  }
  if (
    existing !== undefined &&
    compareObservedTuple(
      prepared.observedMs,
      event.event_id,
      existing.last_observed_ms,
      existing.last_event_id,
    ) <= 0
  ) {
    return;
  }

  if (existing === undefined) {
    sql.exec(
      "INSERT INTO typing_states (conversation_id, participant_id, identity_id, account_id, connection_id, platform, is_typing, expires_at, last_observed_ms, last_event_id) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
      owner.conversationId,
      payload.participant_id,
      owner.identityId,
      owner.accountId,
      owner.connectionId,
      owner.platform,
      payload.expires_at,
      prepared.observedMs,
      event.event_id,
    );
    return;
  }
  sql.exec(
    "UPDATE typing_states SET identity_id = ?, account_id = ?, connection_id = ?, platform = ?, is_typing = 1, expires_at = ?, last_observed_ms = ?, last_event_id = ? WHERE conversation_id = ? AND participant_id = ?",
    owner.identityId,
    owner.accountId,
    owner.connectionId,
    owner.platform,
    payload.expires_at,
    prepared.observedMs,
    event.event_id,
    owner.conversationId,
    payload.participant_id,
  );
};

const projectTypingStopped = (
  sql: SqlStorage,
  prepared: PreparedProjectionEvent,
): void => {
  const event = prepared.event as TypingStoppedEvent;
  const payload = event.payload;
  const owner = ownerFor(prepared);

  ensureConversationShell(sql, prepared);
  assertReferencedParticipantOwner(sql, payload.participant_id, owner);
  const existing = readTyping(sql, owner.conversationId, payload.participant_id);
  assertOwnedRow(existing, owner);
  if (
    conversationIsDeleted(sql, owner.conversationId) !== undefined ||
    participantIsDeleted(sql, payload.participant_id) !== undefined
  ) {
    if (existing !== undefined) {
      sql.exec(
        "DELETE FROM typing_states WHERE conversation_id = ? AND participant_id = ?",
        owner.conversationId,
        payload.participant_id,
      );
    }
    return;
  }
  if (
    existing !== undefined &&
    compareObservedTuple(
      prepared.observedMs,
      event.event_id,
      existing.last_observed_ms,
      existing.last_event_id,
    ) <= 0
  ) {
    return;
  }

  if (existing === undefined) {
    sql.exec(
      "INSERT INTO typing_states (conversation_id, participant_id, identity_id, account_id, connection_id, platform, is_typing, expires_at, last_observed_ms, last_event_id) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)",
      owner.conversationId,
      payload.participant_id,
      owner.identityId,
      owner.accountId,
      owner.connectionId,
      owner.platform,
      prepared.observedMs,
      event.event_id,
    );
    return;
  }
  sql.exec(
    "UPDATE typing_states SET identity_id = ?, account_id = ?, connection_id = ?, platform = ?, is_typing = 0, expires_at = NULL, last_observed_ms = ?, last_event_id = ? WHERE conversation_id = ? AND participant_id = ?",
    owner.identityId,
    owner.accountId,
    owner.connectionId,
    owner.platform,
    prepared.observedMs,
    event.event_id,
    owner.conversationId,
    payload.participant_id,
  );
};

const projectAttachmentObserved = (
  sql: SqlStorage,
  prepared: PreparedProjectionEvent,
): void => {
  const event = prepared.event as AttachmentObservedEvent;
  const payload = event.payload;
  const owner = ownerFor(prepared);

  ensureConversationShell(sql, prepared);
  assertCanonicalResourceIdOwner(sql, "attachment", payload.attachment_id, owner);
  assertReferencedMessageOwner(sql, payload.message_id, owner);
  const existing = readAttachment(sql, payload.attachment_id);
  assertOwnedRow(existing, owner);
  if (existing !== undefined && existing.message_id !== payload.message_id) {
    throw projectionError("projection_conflict");
  }

  const messageTombstone = messageIsRedacted(sql, payload.message_id, owner.conversationId);
  const attachmentTombstone = attachmentIsDeleted(sql, payload.attachment_id);
  if (attachmentTombstone !== undefined) assertOwnedRow(attachmentTombstone, owner);
  // A containing message/conversation tombstone and the attachment tombstone
  // are one effective redaction stream. Presence gates content permanently;
  // metadata follows the tuple-maximal tombstone regardless of arrival order.
  const redactionTombstone = latestTombstone(attachmentTombstone, messageTombstone);
  const deletionTombstone = redactionTombstone;
  if (redactionTombstone !== undefined && existing !== undefined) {
    // Redaction is a standing invariant, not another LWW candidate: even an
    // older observation must not expose metadata left by an earlier path.
    sql.exec(
      "UPDATE attachments SET file_name = NULL, mime_type = NULL, size_bytes = NULL, sha256 = NULL, r2_key = NULL, deleted_at = ? WHERE id = ?",
      deletionTombstone!.occurred_at,
      payload.attachment_id,
    );
  }

  if (
    existing !== undefined &&
    compareObservedTuple(
      prepared.observedMs,
      event.event_id,
      existing.last_observed_ms,
      existing.last_event_id,
    ) <= 0
  ) {
    return;
  }

  const redacted = redactionTombstone !== undefined;
  const fileName = redacted ? null : payload.file_name;
  const mimeType = redacted ? null : payload.mime_type;
  const sizeBytes = redacted ? null : payload.size_bytes;
  const sha256 = redacted ? null : payload.sha256;
  const r2Key = redacted ? null : payload.r2_key;
  const deletedAt = deletionTombstone?.occurred_at ?? null;

  if (existing === undefined) {
    sql.exec(
      "INSERT INTO attachments (id, message_id, identity_id, account_id, connection_id, conversation_id, platform, file_name, mime_type, size_bytes, sha256, r2_key, observed_at, last_observed_ms, last_event_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      payload.attachment_id,
      payload.message_id,
      owner.identityId,
      owner.accountId,
      owner.connectionId,
      owner.conversationId,
      owner.platform,
      fileName,
      mimeType,
      sizeBytes,
      sha256,
      r2Key,
      event.observed_at,
      prepared.observedMs,
      event.event_id,
      deletedAt,
    );
    return;
  }

  sql.exec(
    "UPDATE attachments SET identity_id = ?, account_id = ?, connection_id = ?, conversation_id = ?, platform = ?, file_name = ?, mime_type = ?, size_bytes = ?, sha256 = ?, r2_key = ?, observed_at = ?, last_observed_ms = ?, last_event_id = ?, deleted_at = ? WHERE id = ?",
    owner.identityId,
    owner.accountId,
    owner.connectionId,
    owner.conversationId,
    owner.platform,
    fileName,
    mimeType,
    sizeBytes,
    sha256,
    r2Key,
    event.observed_at,
    prepared.observedMs,
    event.event_id,
    deletedAt,
    payload.attachment_id,
  );
};

export const projectReactionAddedEvent = projectReactionAdded;
export const projectReactionRemovedEvent = projectReactionRemoved;
export const projectReceiptEvent = projectReceipt;
export const projectTypingStartedEvent = projectTypingStarted;
export const projectTypingStoppedEvent = projectTypingStopped;
export const projectAttachmentObservedEvent = projectAttachmentObserved;
