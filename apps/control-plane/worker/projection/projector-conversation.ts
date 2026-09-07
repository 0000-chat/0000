import type { PreparedProjectionEvent } from "./projector-types";
import { latestTombstone } from "./projector-deletion";
import {
  assertOwner,
  assertCanonicalResourceIdOwner,
  assertParticipantReferenceOwners,
  compareObservedTuple,
  ensureConversationShell,
  readParticipantTombstone,
  readConversationTombstone,
  isMetadataSentinel,
  ownerFor,
  readParticipant,
  type ConversationUpdatedEvent,
  type ParticipantUpdatedEvent,
} from "./projector-common";

export const projectConversationUpdated = (
  sql: SqlStorage,
  prepared: PreparedProjectionEvent,
): void => {
  const event = prepared.event as ConversationUpdatedEvent;
  const conversation = ensureConversationShell(sql, prepared);
  if (readConversationTombstone(sql, event.conversation_id) !== undefined) return;
  if (
    !isMetadataSentinel(conversation) &&
    compareObservedTuple(
      prepared.observedMs,
      event.event_id,
      conversation.metadata_observed_ms,
      conversation.metadata_event_id,
    ) <= 0
  ) {
    return;
  }
  const payload = event.payload;
  sql.exec(
    "UPDATE conversations SET title = ?, archived = ?, muted = ?, metadata_observed_ms = ?, metadata_event_id = ?, updated_at = ?, last_event_id = ? WHERE id = ? AND deleted_at IS NULL",
    payload.title,
    payload.archived ? 1 : 0,
    payload.muted ? 1 : 0,
    prepared.observedMs,
    event.event_id,
    conversation.shell_activity_at,
    event.event_id,
    event.conversation_id,
  );
};

export const projectParticipantUpdated = (
  sql: SqlStorage,
  prepared: PreparedProjectionEvent,
): void => {
  const event = prepared.event as ParticipantUpdatedEvent;
  ensureConversationShell(sql, prepared);
  const owner = ownerFor(prepared);
  const payload = event.payload;
  assertCanonicalResourceIdOwner(sql, "participant", payload.participant_id, owner);
  assertParticipantReferenceOwners(sql, payload.participant_id, owner);
  const existing = readParticipant(sql, payload.participant_id);
  const participantTombstone = readParticipantTombstone(sql, payload.participant_id);
  const conversationTombstone = readConversationTombstone(sql, owner.conversationId);
  const deletionTombstone = latestTombstone(participantTombstone, conversationTombstone);
  const deletedAt = deletionTombstone?.occurred_at ?? null;
  if (existing !== undefined) {
    assertOwner(
      {
        identity_id: existing.identity_id,
        account_id: existing.account_id,
        connection_id: existing.connection_id,
        conversation_id: existing.conversation_id,
        platform: existing.platform,
      },
      owner,
    );
    if (
      compareObservedTuple(
        prepared.observedMs,
        event.event_id,
        existing.last_observed_ms,
        existing.last_event_id,
      ) <= 0
    ) {
      return;
    }
    if (existing.deleted_at !== null || participantTombstone !== undefined || conversationTombstone !== undefined) {
      sql.exec(
        "UPDATE participants SET display_name = 'Deleted participant', remote_id = NULL, avatar_url = NULL, deleted_at = COALESCE(deleted_at, ?), last_observed_ms = ?, last_event_id = ? WHERE id = ?",
        deletedAt,
        prepared.observedMs,
        event.event_id,
        payload.participant_id,
      );
      return;
    }
    sql.exec(
      "UPDATE participants SET display_name = ?, remote_id = ?, avatar_url = ?, last_observed_ms = ?, last_event_id = ? WHERE id = ?",
      payload.display_name,
      payload.remote_id,
      payload.avatar_url,
      prepared.observedMs,
      event.event_id,
      payload.participant_id,
    );
    return;
  }

  sql.exec(
    "INSERT INTO participants (id, conversation_id, identity_id, account_id, connection_id, platform, display_name, remote_id, avatar_url, last_observed_ms, last_event_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    payload.participant_id,
    owner.conversationId,
    owner.identityId,
    owner.accountId,
    owner.connectionId,
    owner.platform,
    participantTombstone !== undefined || conversationTombstone !== undefined ? "Deleted participant" : payload.display_name,
    participantTombstone !== undefined || conversationTombstone !== undefined ? null : payload.remote_id,
    participantTombstone !== undefined || conversationTombstone !== undefined ? null : payload.avatar_url,
    prepared.observedMs,
    event.event_id,
    deletedAt,
  );
};
