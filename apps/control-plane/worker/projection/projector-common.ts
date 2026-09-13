import { compareOpaqueEventIds } from "@communicator/contracts";
import type { ProjectionEventEnvelope } from "@communicator/contracts";
import { projectionError } from "./errors";
import type { PreparedProjectionEvent } from "./projector-types";

export type ConversationRow = {
  id: string;
  identity_id: string;
  account_id: string;
  connection_id: string;
  platform: string;
  title: string;
  archived: number;
  muted: number;
  shell_activity_at: string;
  shell_activity_ms: number;
  shell_activity_event_id: string;
  last_activity_at: string;
  last_activity_ms: number;
  metadata_observed_ms: number;
  metadata_event_id: string;
  deleted_at: string | null;
  last_event_id: string;
  updated_at: string;
};

export type ParticipantRow = {
  id: string;
  conversation_id: string;
  identity_id: string;
  account_id: string;
  connection_id: string;
  platform: string;
  display_name: string;
  remote_id: string | null;
  avatar_url: string | null;
  last_observed_ms: number;
  last_event_id: string;
  deleted_at: string | null;
};

export type MessageRow = {
  id: string;
  identity_id: string;
  account_id: string;
  connection_id: string;
  conversation_id: string;
  platform: string;
  direction: "inbound" | "outbound";
  sender_participant_id: string | null;
  sender_label: string;
  body: string;
  reply_to_message_id: string | null;
  delivery_status: string;
  unread: number;
  local_read_at: string | null;
  occurred_at: string;
  occurred_ms: number;
  observed_at: string;
  current_observed_ms: number;
  current_event_id: string;
  matrix_room_id: string | null;
  matrix_event_id: string | null;
  remote_message_id: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  deletion_reason: string | null;
  attachment_count: number;
  delivery_failure_code: string | null;
  delivery_observed_ms: number | null;
  delivery_event_id: string | null;
};

export type MessageVersionRow = {
  event_id: string;
  message_id: string;
  identity_id: string;
  account_id: string;
  connection_id: string;
  conversation_id: string;
  platform: string;
  version_kind: "created" | "edited";
  body: string;
  editor_participant_id: string | null;
  occurred_at: string;
  observed_at: string;
  observed_ms: number;
};

export type ResourceTombstoneRow = {
  resource_type: string;
  resource_id: string;
  tombstone_event_id: string;
  identity_id: string;
  account_id: string;
  connection_id: string;
  conversation_id: string;
  platform: string;
  reason_code: string | null;
  occurred_at: string;
  observed_ms: number;
};

export type OwnedProjectionRow = {
  identity_id: string;
  account_id: string;
  connection_id: string;
  conversation_id: string;
  platform: string;
};

const OWNER_MISMATCH =
  "identity_id <> ? OR account_id <> ? OR connection_id <> ? OR conversation_id <> ? OR platform <> ?";

export type MessageCreatedEvent = Extract<
  ProjectionEventEnvelope,
  { event_type: "message.created" }
>;
export type MessageEditedEvent = Extract<
  ProjectionEventEnvelope,
  { event_type: "message.edited" }
>;
export type MessageDeletedEvent = Extract<
  ProjectionEventEnvelope,
  { event_type: "message.deleted" }
>;
export type ConversationUpdatedEvent = Extract<
  ProjectionEventEnvelope,
  { event_type: "conversation.updated" }
>;
export type ParticipantUpdatedEvent = Extract<
  ProjectionEventEnvelope,
  { event_type: "participant.updated" }
>;

export type ProjectionOwner = {
  identityId: string;
  accountId: string;
  connectionId: string;
  conversationId: string;
  platform: string;
};

export type CanonicalResourceType =
  | "conversation"
  | "participant"
  | "message"
  | "reaction"
  | "attachment"
  | "command";

const METADATA_SENTINEL_OBSERVED_MS = -9007199254740991;
const METADATA_SENTINEL_EVENT_ID = "\u0001projection_metadata_sentinel";

export const isMetadataSentinel = (conversation: ConversationRow): boolean =>
  conversation.metadata_observed_ms === METADATA_SENTINEL_OBSERVED_MS &&
  conversation.metadata_event_id === METADATA_SENTINEL_EVENT_ID;

export const ownerFor = (
  prepared: PreparedProjectionEvent,
): ProjectionOwner => ({
  identityId: prepared.event.identity_id,
  accountId: prepared.event.account_id,
  connectionId: prepared.connection.connection_id,
  conversationId: prepared.event.conversation_id,
  platform: prepared.event.platform,
});

const compareProjectionTuple = (
  leftMs: number,
  leftEventId: string,
  rightMs: number,
  rightEventId: string,
): number => {
  if (leftMs < rightMs) return -1;
  if (leftMs > rightMs) return 1;
  return compareOpaqueEventIds(leftEventId, rightEventId);
};

/** LWW ordering for observed event state. */
export const compareObservedTuple = compareProjectionTuple;

/** Canonical lifecycle timestamp for a stored observed tuple without its raw envelope. */
export const canonicalObservedAt = (observedMs: number): string =>
  new Date(observedMs).toISOString();

/** Presentation ordering for occurred activity tuples. */
export const compareOccurredTuple = (
  leftMs: number,
  leftEventId: string,
  rightMs: number,
  rightEventId: string,
): number => compareProjectionTuple(leftMs, leftEventId, rightMs, rightEventId);

export const ownerMatches = (
  row: OwnedProjectionRow,
  owner: ProjectionOwner,
): boolean =>
  row.identity_id === owner.identityId &&
  row.account_id === owner.accountId &&
  row.connection_id === owner.connectionId &&
  row.conversation_id === owner.conversationId &&
  row.platform === owner.platform;

/**
 * Resource identifiers are tenant-global even though SQLite stores each
 * resource family in its own table. Check the family primary keys and any
 * existing tombstone before a new/pending resource is touched.
 */
export const assertCanonicalResourceIdOwner = (
  sql: SqlStorage,
  resourceType: CanonicalResourceType,
  resourceId: string,
  owner: ProjectionOwner,
): void => {
  const tables: readonly [CanonicalResourceType, string][] = [
    ["conversation", "conversations"],
    ["participant", "participants"],
    ["message", "messages"],
    ["reaction", "reactions"],
    ["attachment", "attachments"],
    ["command", "commands"],
  ];
  for (const [tableType, table] of tables) {
    const row = sql
      .exec<OwnedProjectionRow>(
        tableType === "conversation"
          ? "SELECT identity_id, account_id, connection_id, id AS conversation_id, platform FROM conversations WHERE id = ?"
          : `SELECT identity_id, account_id, connection_id, conversation_id, platform FROM ${table} WHERE id = ?`,
        resourceId,
      )
      .toArray()[0];
    if (row === undefined) continue;
    if (tableType !== resourceType || !ownerMatches(row, owner)) {
      throw projectionError("projection_conflict");
    }
  }

  // Out-of-order child rows establish an owner claim even before the
  // canonical primary resource arrives. A claim from the same resource
  // family and exact owner is compatible with later primary materialization;
  // every cross-family claim, or any owner mismatch, is corruption.
  const unresolvedClaims: readonly [CanonicalResourceType, string, string][] = [
    ["message", "message_versions", "message_id"],
    ["message", "messages", "reply_to_message_id"],
    ["participant", "messages", "sender_participant_id"],
    ["participant", "message_versions", "editor_participant_id"],
    ["message", "reactions", "message_id"],
    ["participant", "reactions", "participant_id"],
    ["message", "receipts", "message_id"],
    ["participant", "receipts", "participant_id"],
    ["participant", "typing_states", "participant_id"],
    ["message", "attachments", "message_id"],
    ["message", "message_delivery_updates", "message_id"],
  ];
  for (const [claimType, table, column] of unresolvedClaims) {
    if (claimType !== resourceType) {
      const claim = sql
        .exec<{ found: number }>(
          `SELECT 1 AS found FROM ${table} WHERE ${column} = ? LIMIT 1`,
          resourceId,
        )
        .toArray()[0];
      if (claim !== undefined) throw projectionError("projection_conflict");
      continue;
    }

    const mismatch = sql
      .exec<{ found: number }>(
        `SELECT 1 AS found FROM ${table} WHERE ${column} = ? AND (${OWNER_MISMATCH}) LIMIT 1`,
        resourceId,
        owner.identityId,
        owner.accountId,
        owner.connectionId,
        owner.conversationId,
        owner.platform,
      )
      .toArray()[0];
    if (mismatch !== undefined) throw projectionError("projection_conflict");
  }

  const tombstones = sql
    .exec<ResourceTombstoneRow>(
      "SELECT resource_type, resource_id, tombstone_event_id, identity_id, account_id, connection_id, conversation_id, platform, reason_code, occurred_at, observed_ms FROM resource_tombstones WHERE resource_id = ?",
      resourceId,
    )
    .toArray();
  for (const tombstone of tombstones) {
    if (
      tombstone.resource_type !== resourceType ||
      !ownerMatches(tombstone, owner)
    ) {
      throw projectionError("projection_conflict");
    }
  }
};

export const assertOwner = (
  row: OwnedProjectionRow | undefined,
  owner: ProjectionOwner,
): void => {
  if (row !== undefined && !ownerMatches(row, owner)) {
    throw projectionError("projection_conflict");
  }
};

export const assertNoOwnerMismatch = (
  sql: SqlStorage,
  query: string,
  resourceId: string,
  owner: ProjectionOwner,
): void => {
  const mismatch = sql
    .exec<{ found: number }>(
      query,
      resourceId,
      owner.identityId,
      owner.accountId,
      owner.connectionId,
      owner.conversationId,
      owner.platform,
    )
    .toArray()[0];
  if (mismatch !== undefined) throw projectionError("projection_conflict");
};

export const readConversation = (
  sql: SqlStorage,
  conversationId: string,
): ConversationRow | undefined =>
  sql
    .exec<ConversationRow>(
      "SELECT id, identity_id, account_id, connection_id, platform, title, archived, muted, shell_activity_at, shell_activity_ms, shell_activity_event_id, last_activity_at, last_activity_ms, metadata_observed_ms, metadata_event_id, deleted_at, last_event_id, updated_at FROM conversations WHERE id = ?",
      conversationId,
    )
    .toArray()[0];

export const ensureConversationShell = (
  sql: SqlStorage,
  prepared: PreparedProjectionEvent,
): ConversationRow => {
  const conversationId = prepared.event.conversation_id;
  const owner = ownerFor(prepared);
  assertCanonicalResourceIdOwner(sql, "conversation", conversationId, owner);
  const existing = readConversation(sql, conversationId);
  const conversationTombstone = readConversationTombstone(sql, conversationId);
  if (conversationTombstone !== undefined) {
    assertOwner(
      {
        identity_id: conversationTombstone.identity_id,
        account_id: conversationTombstone.account_id,
        connection_id: conversationTombstone.connection_id,
        conversation_id: conversationTombstone.conversation_id,
        platform: conversationTombstone.platform,
      },
      owner,
    );
  }
  if (existing === undefined) {
    let title = conversationId;
    let archived = 0;
    let muted = 0;
    const metadataObservedMs =
      prepared.event.event_type === "conversation.updated"
        ? prepared.observedMs
        : METADATA_SENTINEL_OBSERVED_MS;
    const metadataEventId =
      prepared.event.event_type === "conversation.updated"
        ? prepared.event.event_id
        : METADATA_SENTINEL_EVENT_ID;
    if (prepared.event.event_type === "conversation.updated") {
      const payload = (prepared.event as ConversationUpdatedEvent).payload;
      title = payload.title;
      archived = payload.archived ? 1 : 0;
      muted = payload.muted ? 1 : 0;
    }
    sql.exec(
      "INSERT INTO conversations (id, identity_id, account_id, connection_id, platform, title, archived, muted, last_message_preview, shell_activity_at, shell_activity_ms, shell_activity_event_id, last_activity_at, last_activity_ms, unread_count, message_count, attachment_count, metadata_observed_ms, metadata_event_id, deleted_at, last_event_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, NULL, ?, ?)",
      conversationId,
      owner.identityId,
      owner.accountId,
      owner.connectionId,
      owner.platform,
      title,
      archived,
      muted,
      prepared.event.occurred_at,
      prepared.occurredMs,
      prepared.event.event_id,
      prepared.event.occurred_at,
      prepared.occurredMs,
      metadataObservedMs,
      metadataEventId,
      prepared.event.event_id,
      prepared.event.occurred_at,
    );
    const inserted = readConversation(sql, conversationId);
    if (inserted === undefined) throw projectionError("projection_unavailable");
    return inserted;
  }

  assertOwner(
    {
      identity_id: existing.identity_id,
      account_id: existing.account_id,
      connection_id: existing.connection_id,
      conversation_id: existing.id,
      platform: existing.platform,
    },
    owner,
  );

  if (
    compareOccurredTuple(
      prepared.occurredMs,
      prepared.event.event_id,
      existing.shell_activity_ms,
      existing.shell_activity_event_id,
    ) > 0
  ) {
    sql.exec(
      "UPDATE conversations SET shell_activity_at = ?, shell_activity_ms = ?, shell_activity_event_id = ?, last_event_id = ?, updated_at = ? WHERE id = ?",
      prepared.event.occurred_at,
      prepared.occurredMs,
      prepared.event.event_id,
      prepared.event.event_id,
      prepared.event.occurred_at,
      conversationId,
    );
  }
  const updated = readConversation(sql, conversationId);
  if (updated === undefined) throw projectionError("projection_unavailable");
  return updated;
};

export const readParticipant = (
  sql: SqlStorage,
  participantId: string,
): ParticipantRow | undefined =>
  sql
    .exec<ParticipantRow>(
      "SELECT id, conversation_id, identity_id, account_id, connection_id, platform, display_name, remote_id, avatar_url, last_observed_ms, last_event_id, deleted_at FROM participants WHERE id = ?",
      participantId,
    )
    .toArray()[0];

export const readMessage = (
  sql: SqlStorage,
  messageId: string,
): MessageRow | undefined =>
  sql
    .exec<MessageRow>(
      "SELECT id, identity_id, account_id, connection_id, conversation_id, platform, direction, sender_participant_id, sender_label, body, reply_to_message_id, delivery_status, unread, local_read_at, occurred_at, occurred_ms, observed_at, current_observed_ms, current_event_id, matrix_room_id, matrix_event_id, remote_message_id, edited_at, deleted_at, deletion_reason, attachment_count, delivery_failure_code, delivery_observed_ms, delivery_event_id FROM messages WHERE id = ?",
      messageId,
    )
    .toArray()[0];

export const readLatestMessageVersion = (
  sql: SqlStorage,
  messageId: string,
): MessageVersionRow | undefined =>
  sql
    .exec<MessageVersionRow>(
      "SELECT event_id, message_id, identity_id, account_id, connection_id, conversation_id, platform, version_kind, body, editor_participant_id, occurred_at, observed_at, observed_ms FROM message_versions WHERE message_id = ? ORDER BY observed_ms DESC, event_id COLLATE BINARY DESC LIMIT 1",
      messageId,
    )
    .toArray()[0];

export const readMessageTombstone = (
  sql: SqlStorage,
  messageId: string,
): ResourceTombstoneRow | undefined =>
  sql
    .exec<ResourceTombstoneRow>(
      "SELECT resource_type, resource_id, tombstone_event_id, identity_id, account_id, connection_id, conversation_id, platform, reason_code, occurred_at, observed_ms FROM resource_tombstones WHERE resource_type = 'message' AND resource_id = ?",
      messageId,
    )
    .toArray()[0];

export const readResourceTombstone = (
  sql: SqlStorage,
  resourceType: string,
  resourceId: string,
): ResourceTombstoneRow | undefined =>
  sql
    .exec<ResourceTombstoneRow>(
      "SELECT resource_type, resource_id, tombstone_event_id, identity_id, account_id, connection_id, conversation_id, platform, reason_code, occurred_at, observed_ms FROM resource_tombstones WHERE resource_type = ? AND resource_id = ?",
      resourceType,
      resourceId,
    )
    .toArray()[0];

export const readConversationTombstone = (
  sql: SqlStorage,
  conversationId: string,
): ResourceTombstoneRow | undefined =>
  readResourceTombstone(sql, "conversation", conversationId);

export const readParticipantTombstone = (
  sql: SqlStorage,
  participantId: string,
): ResourceTombstoneRow | undefined =>
  readResourceTombstone(sql, "participant", participantId);

export const readAttachmentTombstone = (
  sql: SqlStorage,
  attachmentId: string,
): ResourceTombstoneRow | undefined =>
  readResourceTombstone(sql, "attachment", attachmentId);

export const assertMessageOwner = (
  sql: SqlStorage,
  messageId: string,
  owner: ProjectionOwner,
): MessageRow | undefined => {
  assertCanonicalResourceIdOwner(sql, "message", messageId, owner);
  assertNoOwnerMismatch(
    sql,
    `SELECT 1 AS found FROM messages WHERE id = ? AND (${OWNER_MISMATCH}) LIMIT 1`,
    messageId,
    owner,
  );
  assertNoOwnerMismatch(
    sql,
    `SELECT 1 AS found FROM message_versions WHERE message_id = ? AND (${OWNER_MISMATCH}) LIMIT 1`,
    messageId,
    owner,
  );
  assertNoOwnerMismatch(
    sql,
    `SELECT 1 AS found FROM resource_tombstones WHERE resource_type = 'message' AND resource_id = ? AND (${OWNER_MISMATCH}) LIMIT 1`,
    messageId,
    owner,
  );
  return readMessage(sql, messageId);
};

export const assertParticipantReferenceOwners = (
  sql: SqlStorage,
  participantId: string,
  owner: ProjectionOwner,
): void => {
  assertNoOwnerMismatch(
    sql,
    `SELECT 1 AS found FROM messages WHERE sender_participant_id = ? AND (${OWNER_MISMATCH}) LIMIT 1`,
    participantId,
    owner,
  );
  assertNoOwnerMismatch(
    sql,
    `SELECT 1 AS found FROM message_versions WHERE editor_participant_id = ? AND (${OWNER_MISMATCH}) LIMIT 1`,
    participantId,
    owner,
  );
  assertNoOwnerMismatch(
    sql,
    `SELECT 1 AS found FROM reactions WHERE participant_id = ? AND (${OWNER_MISMATCH}) LIMIT 1`,
    participantId,
    owner,
  );
  assertNoOwnerMismatch(
    sql,
    `SELECT 1 AS found FROM receipts WHERE participant_id = ? AND (${OWNER_MISMATCH}) LIMIT 1`,
    participantId,
    owner,
  );
  assertNoOwnerMismatch(
    sql,
    `SELECT 1 AS found FROM typing_states WHERE participant_id = ? AND (${OWNER_MISMATCH}) LIMIT 1`,
    participantId,
    owner,
  );
  assertNoOwnerMismatch(
    sql,
    `SELECT 1 AS found FROM resource_tombstones WHERE resource_type = 'participant' AND resource_id = ? AND (${OWNER_MISMATCH}) LIMIT 1`,
    participantId,
    owner,
  );
};

export const assertReferencedParticipantOwner = (
  sql: SqlStorage,
  participantId: string | null,
  owner: ProjectionOwner,
): void => {
  if (participantId === null) return;
  assertCanonicalResourceIdOwner(sql, "participant", participantId, owner);
  assertParticipantReferenceOwners(sql, participantId, owner);
  const participant = readParticipant(sql, participantId);
  if (participant === undefined) return;
  assertOwner(
    {
      identity_id: participant.identity_id,
      account_id: participant.account_id,
      connection_id: participant.connection_id,
      conversation_id: participant.conversation_id,
      platform: participant.platform,
    },
    owner,
  );
};

export const assertReferencedMessageOwner = (
  sql: SqlStorage,
  messageId: string | null,
  owner: ProjectionOwner,
): void => {
  if (messageId === null) return;
  assertMessageTargetOwner(sql, messageId, owner);
};

/** A marker may arrive before its target; when the target arrives, its scope
 * must still agree with the marker's recorded scope. */
export const assertEventTombstoneOwner = (
  sql: SqlStorage,
  eventId: string,
  owner: ProjectionOwner,
): void => {
  const marker = sql
    .exec<OwnedProjectionRow>(
      "SELECT identity_id, account_id, connection_id, conversation_id, platform FROM event_tombstones WHERE target_event_id = ?",
      eventId,
    )
    .toArray()[0];
  assertOwner(marker, owner);
};

export const assertReplyReferenceOwners = (
  sql: SqlStorage,
  messageId: string,
  owner: ProjectionOwner,
): void => {
  assertNoOwnerMismatch(
    sql,
    `SELECT 1 AS found FROM messages WHERE reply_to_message_id = ? AND (${OWNER_MISMATCH}) LIMIT 1`,
    messageId,
    owner,
  );
};

export const assertMessageTargetOwner = (
  sql: SqlStorage,
  messageId: string,
  owner: ProjectionOwner,
): MessageRow | undefined => {
  const message = assertMessageOwner(sql, messageId, owner);
  assertReplyReferenceOwners(sql, messageId, owner);
  for (const [table, column] of [
    ["reactions", "message_id"],
    ["receipts", "message_id"],
    ["attachments", "message_id"],
    ["message_delivery_updates", "message_id"],
  ] as const) {
    assertNoOwnerMismatch(
      sql,
      `SELECT 1 AS found FROM ${table} WHERE ${column} = ? AND (${OWNER_MISMATCH}) LIMIT 1`,
      messageId,
      owner,
    );
  }
  assertNoOwnerMismatch(
    sql,
    `SELECT 1 AS found FROM resource_tombstones AS attachment_tombstone JOIN attachments ON attachments.id = attachment_tombstone.resource_id WHERE attachment_tombstone.resource_type = 'attachment' AND attachments.message_id = ? AND (attachment_tombstone.identity_id <> ? OR attachment_tombstone.account_id <> ? OR attachment_tombstone.connection_id <> ? OR attachment_tombstone.conversation_id <> ? OR attachment_tombstone.platform <> ?) LIMIT 1`,
    messageId,
    owner,
  );
  return message;
};
