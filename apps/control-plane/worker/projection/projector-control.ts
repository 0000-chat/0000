import type { ProjectionEventEnvelope } from "@communicator/contracts";
import { projectionError } from "./errors";
import type { PreparedProjectionEvent } from "./projector-types";
import { messageIsDeleted } from "./projector-deletion";
import {
  assertCanonicalResourceIdOwner,
  assertMessageTargetOwner,
  assertOwner,
  compareObservedTuple,
  ensureConversationShell,
  readConversationTombstone,
  readMessage,
  ownerFor,
  type OwnedProjectionRow,
  type ProjectionOwner,
} from "./projector-common";

type CommandUpdatedEvent = Extract<
  ProjectionEventEnvelope,
  { event_type: "command.updated" }
>;
type BridgeDeliveryUpdatedEvent = Extract<
  ProjectionEventEnvelope,
  { event_type: "bridge.delivery.updated" }
>;
type EventMarker = Extract<
  ProjectionEventEnvelope,
  { event_type: "replay.tombstone" | "correction.applied" }
>;

type CommandRow = OwnedProjectionRow & {
  id: string;
  operation: string;
  delivery_mode: string;
  status: string;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
  last_observed_ms: number;
  last_event_id: string;
};

type DeliveryRow = OwnedProjectionRow & {
  message_id: string;
  delivery_status: string;
  failure_code: string | null;
  occurred_at: string;
  last_observed_ms: number;
  last_event_id: string;
};

type EventTombstoneRow = OwnedProjectionRow & {
  target_event_id: string;
  tombstone_event_id: string;
  tombstone_type: string;
  reason_code: string;
  occurred_at: string;
  observed_ms: number;
};

const ownerMatchesRow = (
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
  if (row !== undefined && !ownerMatchesRow(row, owner)) {
    throw projectionError("projection_conflict");
  }
};

const readCommand = (
  sql: SqlStorage,
  commandId: string,
): CommandRow | undefined =>
  sql
    .exec<CommandRow>(
      "SELECT id, identity_id, account_id, connection_id, conversation_id, platform, operation, delivery_mode, status, failure_code, created_at, updated_at, last_observed_ms, last_event_id FROM commands WHERE id = ?",
      commandId,
    )
    .toArray()[0];

const readDelivery = (
  sql: SqlStorage,
  messageId: string,
): DeliveryRow | undefined =>
  sql
    .exec<DeliveryRow>(
      "SELECT message_id, identity_id, account_id, connection_id, conversation_id, platform, delivery_status, failure_code, occurred_at, last_observed_ms, last_event_id FROM message_delivery_updates WHERE message_id = ?",
      messageId,
    )
    .toArray()[0];

const readEventTombstone = (
  sql: SqlStorage,
  targetEventId: string,
): EventTombstoneRow | undefined =>
  sql
    .exec<EventTombstoneRow>(
      "SELECT target_event_id, tombstone_event_id, tombstone_type, identity_id, account_id, connection_id, conversation_id, platform, reason_code, occurred_at, observed_ms FROM event_tombstones WHERE target_event_id = ?",
      targetEventId,
    )
    .toArray()[0];

const parseOccurredMs = (timestamp: string): number => {
  const milliseconds = Date.parse(timestamp);
  if (!Number.isSafeInteger(milliseconds)) {
    throw projectionError("projection_unavailable");
  }
  return milliseconds;
};

const failureForStatus = (
  status: string,
  failureCode: string | null,
  blocked: boolean,
): string | null => (blocked || status !== "failed" ? null : failureCode);

export const projectCommandUpdated = (
  sql: SqlStorage,
  prepared: PreparedProjectionEvent,
): void => {
  const event = prepared.event as CommandUpdatedEvent;
  const owner = ownerFor(prepared);
  ensureConversationShell(sql, prepared);
  assertCanonicalResourceIdOwner(
    sql,
    "command",
    event.payload.command_id,
    owner,
  );
  const existing = readCommand(sql, event.payload.command_id);
  assertOwned(existing, owner);
  const conversationTombstone = readConversationTombstone(
    sql,
    owner.conversationId,
  );

  if (existing !== undefined) {
    // created_at describes the command's first observed occurrence, not the
    // first LWW winner. A late older observation may therefore move it back.
    const existingCreatedMs = parseOccurredMs(existing.created_at);
    if (prepared.occurredMs < existingCreatedMs) {
      sql.exec(
        "UPDATE commands SET created_at = ? WHERE id = ?",
        event.occurred_at,
        event.payload.command_id,
      );
    }

    if (conversationTombstone !== undefined && existing.failure_code !== null) {
      sql.exec(
        "UPDATE commands SET failure_code = NULL WHERE id = ?",
        event.payload.command_id,
      );
    }

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

    sql.exec(
      "UPDATE commands SET operation = ?, delivery_mode = ?, status = ?, failure_code = ?, updated_at = ?, last_observed_ms = ?, last_event_id = ? WHERE id = ?",
      event.payload.operation,
      event.payload.delivery_mode,
      event.payload.status,
      failureForStatus(
        event.payload.status,
        event.payload.failure_code,
        conversationTombstone !== undefined,
      ),
      event.occurred_at,
      prepared.observedMs,
      event.event_id,
      event.payload.command_id,
    );
    return;
  }

  sql.exec(
    "INSERT INTO commands (id, identity_id, account_id, connection_id, conversation_id, platform, operation, delivery_mode, status, failure_code, created_at, updated_at, last_observed_ms, last_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    event.payload.command_id,
    owner.identityId,
    owner.accountId,
    owner.connectionId,
    owner.conversationId,
    owner.platform,
    event.payload.operation,
    event.payload.delivery_mode,
    event.payload.status,
    failureForStatus(
      event.payload.status,
      event.payload.failure_code,
      conversationTombstone !== undefined,
    ),
    event.occurred_at,
    event.occurred_at,
    prepared.observedMs,
    event.event_id,
  );
};

const applyDeliveryToMessage = (
  sql: SqlStorage,
  messageId: string,
  delivery: DeliveryRow,
): void => {
  const message = readMessage(sql, messageId);
  if (message === undefined) return;
  assertOwner(
    {
      identity_id: message.identity_id,
      account_id: message.account_id,
      connection_id: message.connection_id,
      conversation_id: message.conversation_id,
      platform: message.platform,
    },
    {
      identityId: delivery.identity_id,
      accountId: delivery.account_id,
      connectionId: delivery.connection_id,
      conversationId: delivery.conversation_id,
      platform: delivery.platform,
    },
  );

  const conversationTombstone = readConversationTombstone(
    sql,
    message.conversation_id,
  );
  const messageTombstone = messageIsDeleted(sql, message.id);
  const currentIsOlder =
    message.delivery_observed_ms === null ||
    message.delivery_event_id === null ||
    compareObservedTuple(
      delivery.last_observed_ms,
      delivery.last_event_id,
      message.delivery_observed_ms,
      message.delivery_event_id,
    ) > 0;
  const failureCode = failureForStatus(
    delivery.delivery_status,
    delivery.failure_code,
    conversationTombstone !== undefined ||
      messageTombstone !== undefined ||
      message.deleted_at !== null,
  );

  if (!currentIsOlder) {
    if (
      conversationTombstone !== undefined ||
      messageTombstone !== undefined ||
      message.deleted_at !== null
    ) {
      sql.exec(
        "UPDATE messages SET delivery_failure_code = NULL WHERE id = ?",
        messageId,
      );
    }
    return;
  }

  sql.exec(
    "UPDATE messages SET delivery_status = ?, delivery_failure_code = ?, delivery_observed_ms = ?, delivery_event_id = ? WHERE id = ?",
    delivery.delivery_status,
    failureCode,
    delivery.last_observed_ms,
    delivery.last_event_id,
    messageId,
  );
};

/** Reconcile a pending delivery observation when its message arrives. */
export const reconcileMessageDelivery = (
  sql: SqlStorage,
  messageId: string,
): void => {
  const delivery = readDelivery(sql, messageId);
  if (delivery !== undefined) applyDeliveryToMessage(sql, messageId, delivery);
};

export const projectBridgeDeliveryUpdated = (
  sql: SqlStorage,
  prepared: PreparedProjectionEvent,
): void => {
  const event = prepared.event as BridgeDeliveryUpdatedEvent;
  const owner = ownerFor(prepared);
  ensureConversationShell(sql, prepared);

  // This checks the message, all pending child rows, and any existing
  // resource tombstone before the delivery row is read or changed.
  assertMessageTargetOwner(sql, event.payload.message_id, owner);
  const existing = readDelivery(sql, event.payload.message_id);
  assertOwned(existing, owner);
  const conversationTombstone = readConversationTombstone(
    sql,
    owner.conversationId,
  );
  const messageTombstone = sql
    .exec<{ occurred_at: string }>(
      "SELECT occurred_at FROM resource_tombstones WHERE resource_type = 'message' AND resource_id = ?",
      event.payload.message_id,
    )
    .toArray()[0];
  const blocked =
    conversationTombstone !== undefined || messageTombstone !== undefined;
  const failureCode = failureForStatus(
    event.payload.delivery_status,
    event.payload.failure_code,
    blocked,
  );

  if (
    existing !== undefined &&
    compareObservedTuple(
      prepared.observedMs,
      event.event_id,
      existing.last_observed_ms,
      existing.last_event_id,
    ) <= 0
  ) {
    if (existing.failure_code !== null && blocked) {
      sql.exec(
        "UPDATE message_delivery_updates SET failure_code = NULL WHERE message_id = ?",
        event.payload.message_id,
      );
    }
    reconcileMessageDelivery(sql, event.payload.message_id);
    return;
  }

  if (existing === undefined) {
    sql.exec(
      "INSERT INTO message_delivery_updates (message_id, identity_id, account_id, connection_id, conversation_id, platform, delivery_status, failure_code, occurred_at, last_observed_ms, last_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      event.payload.message_id,
      owner.identityId,
      owner.accountId,
      owner.connectionId,
      owner.conversationId,
      owner.platform,
      event.payload.delivery_status,
      failureCode,
      event.occurred_at,
      prepared.observedMs,
      event.event_id,
    );
  } else {
    sql.exec(
      "UPDATE message_delivery_updates SET identity_id = ?, account_id = ?, connection_id = ?, conversation_id = ?, platform = ?, delivery_status = ?, failure_code = ?, occurred_at = ?, last_observed_ms = ?, last_event_id = ? WHERE message_id = ?",
      owner.identityId,
      owner.accountId,
      owner.connectionId,
      owner.conversationId,
      owner.platform,
      event.payload.delivery_status,
      failureCode,
      event.occurred_at,
      prepared.observedMs,
      event.event_id,
      event.payload.message_id,
    );
  }
  reconcileMessageDelivery(sql, event.payload.message_id);
};

const assertEventMarkerTargetOwner = (
  sql: SqlStorage,
  targetEventId: string,
  owner: ProjectionOwner,
): void => {
  const target = sql
    .exec<OwnedProjectionRow>(
      "SELECT applied.identity_id, applied.account_id, applied.connection_id, applied.conversation_id, bindings.platform FROM applied_events AS applied JOIN connection_bindings AS bindings ON bindings.account_id = applied.account_id WHERE applied.event_id = ?",
      targetEventId,
    )
    .toArray()[0];
  assertOwned(target, owner);
};

const assertTombstoneEventIdAvailable = (
  sql: SqlStorage,
  tombstoneEventId: string,
  targetEventId: string,
): void => {
  const marker = sql
    .exec<{ target_event_id: string }>(
      "SELECT target_event_id FROM event_tombstones WHERE tombstone_event_id = ?",
      tombstoneEventId,
    )
    .toArray()[0];
  if (marker !== undefined && marker.target_event_id !== targetEventId) {
    throw projectionError("projection_conflict");
  }
  const resource = sql
    .exec<{ resource_type: string; resource_id: string }>(
      "SELECT resource_type, resource_id FROM resource_tombstones WHERE tombstone_event_id = ?",
      tombstoneEventId,
    )
    .toArray()[0];
  if (resource !== undefined) throw projectionError("projection_conflict");
};

export const projectEventMarker = (
  sql: SqlStorage,
  prepared: PreparedProjectionEvent,
): void => {
  const event = prepared.event as EventMarker;
  const owner = ownerFor(prepared);
  ensureConversationShell(sql, prepared);
  assertEventMarkerTargetOwner(sql, event.payload.target_event_id, owner);
  const existing = readEventTombstone(sql, event.payload.target_event_id);
  assertOwned(existing, owner);
  assertTombstoneEventIdAvailable(
    sql,
    event.event_id,
    event.payload.target_event_id,
  );

  if (
    existing !== undefined &&
    compareObservedTuple(
      prepared.observedMs,
      event.event_id,
      existing.observed_ms,
      existing.tombstone_event_id,
    ) <= 0
  ) {
    return;
  }

  if (existing === undefined) {
    sql.exec(
      "INSERT INTO event_tombstones (target_event_id, tombstone_event_id, tombstone_type, identity_id, account_id, connection_id, conversation_id, platform, reason_code, occurred_at, observed_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      event.payload.target_event_id,
      event.event_id,
      event.event_type,
      owner.identityId,
      owner.accountId,
      owner.connectionId,
      owner.conversationId,
      owner.platform,
      event.payload.reason_code,
      event.occurred_at,
      prepared.observedMs,
    );
  } else {
    sql.exec(
      "UPDATE event_tombstones SET tombstone_event_id = ?, tombstone_type = ?, reason_code = ?, occurred_at = ?, observed_ms = ? WHERE target_event_id = ?",
      event.event_id,
      event.event_type,
      event.payload.reason_code,
      event.occurred_at,
      prepared.observedMs,
      event.payload.target_event_id,
    );
  }
};

export type { DeliveryRow, EventTombstoneRow };
