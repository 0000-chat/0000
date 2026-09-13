import { env, runInDurableObject, evictDurableObject } from "cloudflare:test";
import type {
  InitializeProjectionInput,
  ProjectionAuthorizationContext,
  ProjectionStatusInput,
} from "@communicator/contracts";
import { describe, expect, it } from "vitest";
import {
  getProjectionErrorCause,
  ProjectionError,
} from "../../projection/errors";
import {
  PROJECTION_MIGRATIONS,
  runProjectionMigrations,
} from "../../projection/schema";
import type { TenantProjectionDO } from "../../projection/tenant-projection";

const migrationName = "initial_tenant_projection";
const migrationAppliedAt = "2026-09-07T00:00:00.000Z";
const identitySequenceMigrationName = "identity_local_projection_sequences";
const identitySequenceMigrationAppliedAt = "2026-09-10T00:00:00.000Z";
const applicationTableNames = [
  "projection_meta",
  "connection_bindings",
  "completed_rebuilds",
  "failed_rebuilds",
  "applied_events",
  "conversations",
  "participants",
  "messages",
  "message_versions",
  "reactions",
  "receipts",
  "typing_states",
  "attachments",
  "commands",
  "message_delivery_updates",
  "event_tombstones",
  "resource_tombstones",
  "projection_changes",
  "projection_change_floors",
  "projection_checkpoints",
  "projection_identity_sequences",
] as const;

const authorization = (
  tenantId: string,
  scopes: ProjectionAuthorizationContext["scopes"],
): ProjectionAuthorizationContext => ({
  schema_version: 1,
  tenant_id: tenantId,
  principal_id: "principal_schema",
  allowed_identity_ids: [],
  scopes,
});

const initializeInput = (
  tenantId: string,
  initializedAt = "2026-09-07T01:02:03.000Z",
  scopes: ProjectionAuthorizationContext["scopes"] = ["projection.initialize"],
): InitializeProjectionInput => ({
  schema_version: 1,
  tenant_id: tenantId,
  initialized_at: initializedAt,
  authorization: authorization(tenantId, scopes),
});

const statusInput = (
  tenantId: string,
  scopes: ProjectionAuthorizationContext["scopes"] = ["projection.status"],
): ProjectionStatusInput => ({
  schema_version: 1,
  tenant_id: tenantId,
  authorization: authorization(tenantId, scopes),
});

const expectProjectionError = async (
  stub: DurableObjectStub<TenantProjectionDO>,
  operation: (instance: TenantProjectionDO) => Promise<unknown>,
  code: string,
) => {
  const result = await runInDurableObject(stub, async (instance) => {
    try {
      await operation(instance);
      return undefined;
    } catch (error) {
      return error;
    }
  });
  expect(result).toMatchObject({
    code,
    message: code,
  });
};

const normalizeSql = (sql: string): string => sql.replace(/\s+/g, " ").trim();

const expectedColumns: Record<
  string,
  Array<
    [
      name: string,
      type: string,
      notNull: number,
      primaryKey: number,
      defaultValue: string | null,
    ]
  >
> = {
  _sql_schema_migrations: [
    ["version", "INTEGER", 0, 1, null],
    ["name", "TEXT", 1, 0, null],
    ["applied_at", "TEXT", 1, 0, null],
  ],
  projection_meta: [
    ["singleton", "INTEGER", 0, 1, null],
    ["tenant_id", "TEXT", 1, 0, null],
    ["state", "TEXT", 1, 0, null],
    ["generation", "INTEGER", 1, 0, null],
    ["rebuild_id", "TEXT", 0, 0, null],
    ["rebuild_started_at", "TEXT", 0, 0, null],
    ["last_completed_rebuild_id", "TEXT", 0, 0, null],
    ["last_failed_rebuild_id", "TEXT", 0, 0, null],
    ["last_rebuild_failure_code", "TEXT", 0, 0, null],
    ["initialized_at", "TEXT", 1, 0, null],
    ["updated_at", "TEXT", 1, 0, null],
  ],
  connection_bindings: [
    ["account_id", "TEXT", 1, 1, null],
    ["connection_id", "TEXT", 1, 0, null],
    ["identity_id", "TEXT", 1, 0, null],
    ["platform", "TEXT", 1, 0, null],
  ],
  completed_rebuilds: [
    ["rebuild_id", "TEXT", 1, 1, null],
    ["generation", "INTEGER", 1, 0, null],
    ["completed_at", "TEXT", 1, 0, null],
  ],
  failed_rebuilds: [
    ["rebuild_id", "TEXT", 1, 1, null],
    ["generation", "INTEGER", 1, 0, null],
    ["failed_at", "TEXT", 1, 0, null],
    ["failure_code", "TEXT", 1, 0, null],
  ],
  applied_events: [
    ["event_id", "TEXT", 1, 1, null],
    ["event_hash", "TEXT", 1, 0, null],
    ["event_type", "TEXT", 1, 0, null],
    ["event_source", "TEXT", 1, 0, null],
    ["identity_id", "TEXT", 1, 0, null],
    ["account_id", "TEXT", 1, 0, null],
    ["connection_id", "TEXT", 1, 0, null],
    ["conversation_id", "TEXT", 1, 0, null],
    ["occurred_at", "TEXT", 1, 0, null],
    ["observed_at", "TEXT", 1, 0, null],
    ["observed_ms", "INTEGER", 1, 0, null],
    ["generation", "INTEGER", 1, 0, null],
  ],
  conversations: [
    ["id", "TEXT", 1, 1, null],
    ["identity_id", "TEXT", 1, 0, null],
    ["account_id", "TEXT", 1, 0, null],
    ["connection_id", "TEXT", 1, 0, null],
    ["platform", "TEXT", 1, 0, null],
    ["title", "TEXT", 1, 0, null],
    ["archived", "INTEGER", 1, 0, null],
    ["muted", "INTEGER", 1, 0, null],
    ["last_message_preview", "TEXT", 1, 0, "''"],
    ["shell_activity_at", "TEXT", 1, 0, null],
    ["shell_activity_ms", "INTEGER", 1, 0, null],
    ["shell_activity_event_id", "TEXT", 1, 0, null],
    ["last_activity_at", "TEXT", 1, 0, null],
    ["last_activity_ms", "INTEGER", 1, 0, null],
    ["unread_count", "INTEGER", 1, 0, "0"],
    ["message_count", "INTEGER", 1, 0, "0"],
    ["attachment_count", "INTEGER", 1, 0, "0"],
    ["metadata_observed_ms", "INTEGER", 1, 0, null],
    ["metadata_event_id", "TEXT", 1, 0, null],
    ["deleted_at", "TEXT", 0, 0, null],
    ["last_event_id", "TEXT", 1, 0, null],
    ["updated_at", "TEXT", 1, 0, null],
  ],
  participants: [
    ["id", "TEXT", 1, 1, null],
    ["conversation_id", "TEXT", 1, 0, null],
    ["identity_id", "TEXT", 1, 0, null],
    ["account_id", "TEXT", 1, 0, null],
    ["connection_id", "TEXT", 1, 0, null],
    ["platform", "TEXT", 1, 0, null],
    ["display_name", "TEXT", 1, 0, null],
    ["remote_id", "TEXT", 0, 0, null],
    ["avatar_url", "TEXT", 0, 0, null],
    ["last_observed_ms", "INTEGER", 1, 0, null],
    ["last_event_id", "TEXT", 1, 0, null],
    ["deleted_at", "TEXT", 0, 0, null],
  ],
  messages: [
    ["id", "TEXT", 1, 1, null],
    ["identity_id", "TEXT", 1, 0, null],
    ["account_id", "TEXT", 1, 0, null],
    ["connection_id", "TEXT", 1, 0, null],
    ["conversation_id", "TEXT", 1, 0, null],
    ["platform", "TEXT", 1, 0, null],
    ["direction", "TEXT", 1, 0, null],
    ["sender_participant_id", "TEXT", 0, 0, null],
    ["sender_label", "TEXT", 1, 0, null],
    ["body", "TEXT", 1, 0, null],
    ["reply_to_message_id", "TEXT", 0, 0, null],
    ["delivery_status", "TEXT", 1, 0, null],
    ["unread", "INTEGER", 1, 0, null],
    ["local_read_at", "TEXT", 0, 0, null],
    ["occurred_at", "TEXT", 1, 0, null],
    ["occurred_ms", "INTEGER", 1, 0, null],
    ["observed_at", "TEXT", 1, 0, null],
    ["current_observed_ms", "INTEGER", 1, 0, null],
    ["current_event_id", "TEXT", 1, 0, null],
    ["matrix_room_id", "TEXT", 0, 0, null],
    ["matrix_event_id", "TEXT", 0, 0, null],
    ["remote_message_id", "TEXT", 0, 0, null],
    ["edited_at", "TEXT", 0, 0, null],
    ["deleted_at", "TEXT", 0, 0, null],
    ["deletion_reason", "TEXT", 0, 0, null],
    ["attachment_count", "INTEGER", 1, 0, "0"],
    ["delivery_failure_code", "TEXT", 0, 0, null],
    ["delivery_observed_ms", "INTEGER", 0, 0, null],
    ["delivery_event_id", "TEXT", 0, 0, null],
  ],
  message_versions: [
    ["event_id", "TEXT", 1, 1, null],
    ["message_id", "TEXT", 1, 0, null],
    ["identity_id", "TEXT", 1, 0, null],
    ["account_id", "TEXT", 1, 0, null],
    ["connection_id", "TEXT", 1, 0, null],
    ["conversation_id", "TEXT", 1, 0, null],
    ["platform", "TEXT", 1, 0, null],
    ["version_kind", "TEXT", 1, 0, null],
    ["body", "TEXT", 1, 0, null],
    ["editor_participant_id", "TEXT", 0, 0, null],
    ["occurred_at", "TEXT", 1, 0, null],
    ["observed_at", "TEXT", 1, 0, null],
    ["observed_ms", "INTEGER", 1, 0, null],
  ],
  reactions: [
    ["id", "TEXT", 1, 1, null],
    ["message_id", "TEXT", 1, 0, null],
    ["identity_id", "TEXT", 1, 0, null],
    ["account_id", "TEXT", 1, 0, null],
    ["connection_id", "TEXT", 1, 0, null],
    ["conversation_id", "TEXT", 1, 0, null],
    ["platform", "TEXT", 1, 0, null],
    ["participant_id", "TEXT", 0, 0, null],
    ["emoji", "TEXT", 0, 0, null],
    ["occurred_at", "TEXT", 1, 0, null],
    ["last_observed_ms", "INTEGER", 1, 0, null],
    ["last_event_id", "TEXT", 1, 0, null],
    ["removed_at", "TEXT", 0, 0, null],
  ],
  receipts: [
    ["message_id", "TEXT", 1, 1, null],
    ["participant_id", "TEXT", 1, 2, null],
    ["receipt_type", "TEXT", 1, 3, null],
    ["identity_id", "TEXT", 1, 0, null],
    ["account_id", "TEXT", 1, 0, null],
    ["connection_id", "TEXT", 1, 0, null],
    ["conversation_id", "TEXT", 1, 0, null],
    ["platform", "TEXT", 1, 0, null],
    ["local_identity", "INTEGER", 1, 0, null],
    ["occurred_at", "TEXT", 1, 0, null],
    ["last_observed_ms", "INTEGER", 1, 0, null],
    ["last_event_id", "TEXT", 1, 0, null],
  ],
  typing_states: [
    ["conversation_id", "TEXT", 1, 1, null],
    ["participant_id", "TEXT", 1, 2, null],
    ["identity_id", "TEXT", 1, 0, null],
    ["account_id", "TEXT", 1, 0, null],
    ["connection_id", "TEXT", 1, 0, null],
    ["platform", "TEXT", 1, 0, null],
    ["is_typing", "INTEGER", 1, 0, null],
    ["expires_at", "TEXT", 0, 0, null],
    ["last_observed_ms", "INTEGER", 1, 0, null],
    ["last_event_id", "TEXT", 1, 0, null],
  ],
  attachments: [
    ["id", "TEXT", 1, 1, null],
    ["message_id", "TEXT", 1, 0, null],
    ["identity_id", "TEXT", 1, 0, null],
    ["account_id", "TEXT", 1, 0, null],
    ["connection_id", "TEXT", 1, 0, null],
    ["conversation_id", "TEXT", 1, 0, null],
    ["platform", "TEXT", 1, 0, null],
    ["file_name", "TEXT", 0, 0, null],
    ["mime_type", "TEXT", 0, 0, null],
    ["size_bytes", "INTEGER", 0, 0, null],
    ["sha256", "TEXT", 0, 0, null],
    ["r2_key", "TEXT", 0, 0, null],
    ["observed_at", "TEXT", 1, 0, null],
    ["last_observed_ms", "INTEGER", 1, 0, null],
    ["last_event_id", "TEXT", 1, 0, null],
    ["deleted_at", "TEXT", 0, 0, null],
  ],
  commands: [
    ["id", "TEXT", 1, 1, null],
    ["identity_id", "TEXT", 1, 0, null],
    ["account_id", "TEXT", 1, 0, null],
    ["connection_id", "TEXT", 1, 0, null],
    ["conversation_id", "TEXT", 1, 0, null],
    ["platform", "TEXT", 1, 0, null],
    ["operation", "TEXT", 1, 0, null],
    ["delivery_mode", "TEXT", 1, 0, null],
    ["status", "TEXT", 1, 0, null],
    ["failure_code", "TEXT", 0, 0, null],
    ["created_at", "TEXT", 1, 0, null],
    ["updated_at", "TEXT", 1, 0, null],
    ["last_observed_ms", "INTEGER", 1, 0, null],
    ["last_event_id", "TEXT", 1, 0, null],
  ],
  message_delivery_updates: [
    ["message_id", "TEXT", 1, 1, null],
    ["identity_id", "TEXT", 1, 0, null],
    ["account_id", "TEXT", 1, 0, null],
    ["connection_id", "TEXT", 1, 0, null],
    ["conversation_id", "TEXT", 1, 0, null],
    ["platform", "TEXT", 1, 0, null],
    ["delivery_status", "TEXT", 1, 0, null],
    ["failure_code", "TEXT", 0, 0, null],
    ["occurred_at", "TEXT", 1, 0, null],
    ["last_observed_ms", "INTEGER", 1, 0, null],
    ["last_event_id", "TEXT", 1, 0, null],
  ],
  event_tombstones: [
    ["target_event_id", "TEXT", 1, 1, null],
    ["tombstone_event_id", "TEXT", 1, 0, null],
    ["tombstone_type", "TEXT", 1, 0, null],
    ["identity_id", "TEXT", 1, 0, null],
    ["account_id", "TEXT", 1, 0, null],
    ["connection_id", "TEXT", 1, 0, null],
    ["conversation_id", "TEXT", 1, 0, null],
    ["platform", "TEXT", 1, 0, null],
    ["reason_code", "TEXT", 1, 0, null],
    ["occurred_at", "TEXT", 1, 0, null],
    ["observed_ms", "INTEGER", 1, 0, null],
  ],
  resource_tombstones: [
    ["resource_type", "TEXT", 1, 1, null],
    ["resource_id", "TEXT", 1, 2, null],
    ["tombstone_event_id", "TEXT", 1, 0, null],
    ["identity_id", "TEXT", 1, 0, null],
    ["account_id", "TEXT", 1, 0, null],
    ["connection_id", "TEXT", 1, 0, null],
    ["conversation_id", "TEXT", 1, 0, null],
    ["platform", "TEXT", 1, 0, null],
    ["reason_code", "TEXT", 0, 0, null],
    ["occurred_at", "TEXT", 1, 0, null],
    ["observed_ms", "INTEGER", 1, 0, null],
  ],
  projection_changes: [
    ["sequence", "INTEGER", 0, 1, null],
    ["event_id", "TEXT", 1, 0, null],
    ["event_type", "TEXT", 1, 0, null],
    ["identity_id", "TEXT", 1, 0, null],
    ["account_id", "TEXT", 1, 0, null],
    ["connection_id", "TEXT", 1, 0, null],
    ["conversation_id", "TEXT", 1, 0, null],
    ["occurred_at", "TEXT", 1, 0, null],
    ["observed_at", "TEXT", 1, 0, null],
    ["generation", "INTEGER", 1, 0, null],
    ["identity_sequence", "INTEGER", 1, 0, null],
  ],
  projection_change_floors: [
    ["identity_id", "TEXT", 1, 1, null],
    ["discarded_through_sequence", "INTEGER", 1, 0, null],
  ],
  projection_checkpoints: [
    ["kind", "TEXT", 1, 1, null],
    ["value", "TEXT", 1, 0, null],
    ["source_cursor", "TEXT", 0, 0, null],
    ["page_digest", "TEXT", 0, 0, null],
    ["last_observed_at", "TEXT", 0, 0, null],
    ["last_observed_ms", "INTEGER", 0, 0, null],
    ["last_event_id", "TEXT", 0, 0, null],
    ["generation", "INTEGER", 1, 0, null],
    ["updated_at", "TEXT", 1, 0, null],
    ["last_applied_count", "INTEGER", 0, 0, null],
    ["last_duplicate_count", "INTEGER", 0, 0, null],
    ["last_sequence", "INTEGER", 0, 0, null],
  ],
  projection_identity_sequences: [
    ["identity_id", "TEXT", 1, 1, null],
    ["latest_sequence", "INTEGER", 1, 0, null],
  ],
};

const expectedChecks: Record<string, string[]> = {
  _sql_schema_migrations: ["CHECK(version >= 1)"],
  projection_meta: [
    "CHECK(singleton = 1)",
    "CHECK(state IN ('ready','rebuilding','rebuild_failed'))",
    "CHECK(generation >= 1 AND generation <= 9007199254740991)",
    "CHECK(last_rebuild_failure_code IS NULL OR last_rebuild_failure_code IN ('operator_abort','unsupported_archive','archive_gap','binding_conflict','validation_failed'))",
  ],
  completed_rebuilds: [
    "CHECK(generation >= 2 AND generation <= 9007199254740991)",
  ],
  failed_rebuilds: [
    "CHECK(generation >= 2 AND generation <= 9007199254740991)",
    "CHECK(failure_code IN ('operator_abort','unsupported_archive','archive_gap','binding_conflict','validation_failed'))",
  ],
  applied_events: [
    "CHECK(length(event_hash) = 64)",
    "CHECK(observed_ms BETWEEN -9007199254740991 AND 9007199254740991)",
    "CHECK(generation >= 1)",
  ],
  conversations: [
    "CHECK(archived IN (0,1))",
    "CHECK(muted IN (0,1))",
    "CHECK(unread_count >= 0)",
    "CHECK(message_count >= 0)",
    "CHECK(attachment_count >= 0)",
    "CHECK(metadata_observed_ms BETWEEN -9007199254740991 AND 9007199254740991)",
  ],
  messages: [
    "CHECK(direction IN ('inbound','outbound'))",
    "CHECK(delivery_status IN ('unknown','accepted','sent','delivered','read','failed'))",
    "CHECK(unread IN (0,1))",
    "CHECK(attachment_count >= 0)",
  ],
  message_versions: ["CHECK(version_kind IN ('created','edited'))"],
  receipts: [
    "CHECK(receipt_type IN ('read','delivered'))",
    "CHECK(local_identity IN (0,1))",
  ],
  typing_states: ["CHECK(is_typing IN (0,1))"],
  attachments: [
    "CHECK(size_bytes IS NULL OR size_bytes >= 0)",
    "CHECK(sha256 IS NULL OR length(sha256) = 64)",
  ],
  commands: [
    "CHECK(operation = 'message.send')",
    "CHECK(delivery_mode IN ('direct','paced'))",
    "CHECK(status IN ('accepted','scheduled','reading','typing','submitted_to_matrix','matrix_confirmed','bridged','delivered','cancelled','unsupported','failed'))",
  ],
  message_delivery_updates: [
    "CHECK(delivery_status IN ('unknown','accepted','sent','delivered','read','failed'))",
  ],
  event_tombstones: [
    "CHECK(tombstone_type IN ('replay.tombstone','correction.applied'))",
  ],
  resource_tombstones: [
    "CHECK(resource_type IN ('message','conversation','participant','attachment'))",
  ],
  projection_changes: [
    "CHECK(generation >= 1)",
    "CHECK(identity_sequence >= 1)",
  ],
  projection_change_floors: ["CHECK(discarded_through_sequence >= 0)"],
  projection_checkpoints: [
    "CHECK(page_digest IS NULL OR length(page_digest) = 64)",
    "CHECK(generation >= 1)",
    "CHECK(last_applied_count IS NULL OR last_applied_count >= 0)",
    "CHECK(last_duplicate_count IS NULL OR last_duplicate_count >= 0)",
    "CHECK(last_sequence IS NULL OR last_sequence >= 0)",
  ],
  projection_identity_sequences: ["CHECK(latest_sequence >= 0)"],
};

const expectedIndexes = [
  "idx_conversations_identity_activity",
  "idx_conversations_identity_connection_activity",
  "idx_messages_identity_conversation_occurred",
  "idx_messages_matrix_event",
  "idx_messages_remote_message",
  "idx_messages_reply_target",
  "idx_messages_sender_participant",
  "idx_messages_conversation_owner",
  "idx_message_versions_message_order",
  "idx_message_versions_editor_participant",
  "idx_message_versions_conversation_owner",
  "idx_participants_conversation_name",
  "idx_reactions_message_state",
  "idx_reactions_participant",
  "idx_reactions_conversation_owner",
  "idx_receipts_message_type_time",
  "idx_receipts_participant",
  "idx_receipts_conversation_owner",
  "idx_typing_participant",
  "idx_attachments_message_state",
  "idx_attachments_conversation_owner",
  "idx_delivery_message_order",
  "idx_delivery_conversation_owner",
  "idx_commands_conversation_owner",
  "idx_event_tombstones_conversation_owner",
  "idx_applied_events_order",
  "idx_projection_changes_identity_sequence",
  "idx_projection_changes_global_sequence",
  "idx_resource_tombstones_resource_order",
  "idx_resource_tombstones_id",
  "idx_resource_tombstones_conversation_owner",
];

const expectedIndexSql: Record<string, string> = {
  idx_conversations_identity_activity:
    "CREATE INDEX idx_conversations_identity_activity ON conversations(identity_id,last_activity_ms DESC,id ASC)",
  idx_conversations_identity_connection_activity:
    "CREATE INDEX idx_conversations_identity_connection_activity ON conversations(identity_id,connection_id,last_activity_ms DESC,id ASC)",
  idx_messages_identity_conversation_occurred:
    "CREATE INDEX idx_messages_identity_conversation_occurred ON messages(identity_id,conversation_id,occurred_ms DESC,id ASC)",
  idx_messages_matrix_event:
    "CREATE INDEX idx_messages_matrix_event ON messages(matrix_event_id) WHERE matrix_event_id IS NOT NULL",
  idx_messages_remote_message:
    "CREATE INDEX idx_messages_remote_message ON messages(remote_message_id) WHERE remote_message_id IS NOT NULL",
  idx_messages_reply_target:
    "CREATE INDEX idx_messages_reply_target ON messages(reply_to_message_id) WHERE reply_to_message_id IS NOT NULL",
  idx_messages_sender_participant:
    "CREATE INDEX idx_messages_sender_participant ON messages(sender_participant_id) WHERE sender_participant_id IS NOT NULL",
  idx_messages_conversation_owner:
    "CREATE INDEX idx_messages_conversation_owner ON messages(conversation_id,identity_id,account_id,connection_id,platform)",
  idx_message_versions_message_order:
    "CREATE INDEX idx_message_versions_message_order ON message_versions(message_id,observed_ms DESC,event_id DESC)",
  idx_message_versions_editor_participant:
    "CREATE INDEX idx_message_versions_editor_participant ON message_versions(editor_participant_id) WHERE editor_participant_id IS NOT NULL",
  idx_message_versions_conversation_owner:
    "CREATE INDEX idx_message_versions_conversation_owner ON message_versions(conversation_id,identity_id,account_id,connection_id,platform)",
  idx_participants_conversation_name:
    "CREATE INDEX idx_participants_conversation_name ON participants(conversation_id,display_name,id)",
  idx_reactions_message_state:
    "CREATE INDEX idx_reactions_message_state ON reactions(message_id,removed_at,occurred_at)",
  idx_reactions_participant:
    "CREATE INDEX idx_reactions_participant ON reactions(participant_id) WHERE participant_id IS NOT NULL",
  idx_reactions_conversation_owner:
    "CREATE INDEX idx_reactions_conversation_owner ON reactions(conversation_id,identity_id,account_id,connection_id,platform)",
  idx_receipts_message_type_time:
    "CREATE INDEX idx_receipts_message_type_time ON receipts(message_id,receipt_type,occurred_at)",
  idx_receipts_participant:
    "CREATE INDEX idx_receipts_participant ON receipts(participant_id)",
  idx_receipts_conversation_owner:
    "CREATE INDEX idx_receipts_conversation_owner ON receipts(conversation_id,identity_id,account_id,connection_id,platform)",
  idx_typing_participant:
    "CREATE INDEX idx_typing_participant ON typing_states(participant_id)",
  idx_attachments_message_state:
    "CREATE INDEX idx_attachments_message_state ON attachments(message_id,deleted_at,id)",
  idx_attachments_conversation_owner:
    "CREATE INDEX idx_attachments_conversation_owner ON attachments(conversation_id,identity_id,account_id,connection_id,platform)",
  idx_delivery_message_order:
    "CREATE INDEX idx_delivery_message_order ON message_delivery_updates(message_id,last_observed_ms,last_event_id)",
  idx_delivery_conversation_owner:
    "CREATE INDEX idx_delivery_conversation_owner ON message_delivery_updates(conversation_id,identity_id,account_id,connection_id,platform)",
  idx_commands_conversation_owner:
    "CREATE INDEX idx_commands_conversation_owner ON commands(conversation_id,identity_id,account_id,connection_id,platform)",
  idx_event_tombstones_conversation_owner:
    "CREATE INDEX idx_event_tombstones_conversation_owner ON event_tombstones(conversation_id,identity_id,account_id,connection_id,platform)",
  idx_applied_events_order:
    "CREATE INDEX idx_applied_events_order ON applied_events(observed_ms,event_id)",
  idx_projection_changes_identity_sequence:
    "CREATE INDEX idx_projection_changes_identity_sequence ON projection_changes(identity_id,identity_sequence)",
  idx_projection_changes_global_sequence:
    "CREATE INDEX idx_projection_changes_global_sequence ON projection_changes(sequence)",
  idx_resource_tombstones_resource_order:
    "CREATE INDEX idx_resource_tombstones_resource_order ON resource_tombstones(resource_type,resource_id,observed_ms)",
  idx_resource_tombstones_id:
    "CREATE INDEX idx_resource_tombstones_id ON resource_tombstones(resource_id,resource_type)",
  idx_resource_tombstones_conversation_owner:
    "CREATE INDEX idx_resource_tombstones_conversation_owner ON resource_tombstones(conversation_id,identity_id,account_id,connection_id,platform)",
};

const restoreVersionOneProjectionChanges = (
  state: DurableObjectState,
): void => {
  state.storage.sql.exec(
    "DROP INDEX IF EXISTS idx_projection_changes_identity_sequence",
  );
  state.storage.sql.exec(
    "DROP INDEX IF EXISTS idx_projection_changes_global_sequence",
  );
  state.storage.sql.exec("DROP TABLE IF EXISTS projection_identity_sequences");
  state.storage.sql.exec("DROP TABLE projection_changes");
  state.storage.sql.exec(`CREATE TABLE projection_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 1)
) STRICT`);
  state.storage.sql.exec(
    "CREATE INDEX idx_projection_changes_identity_sequence ON projection_changes(identity_id,sequence)",
  );
  state.storage.sql.exec(
    "DELETE FROM _sql_schema_migrations WHERE version = 2",
  );
};

describe("tenant projection SQLite schema", () => {
  it("creates the exact migrated tables, columns, checks, and named indexes", async () => {
    const stub = env.TENANT_PROJECTION.getByName("tenant_schema_catalog");
    const catalog = await runInDurableObject(stub, async (_instance, state) => {
      const objects = state.storage.sql
        .exec<{ type: string; name: string; sql: string }>(
          "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .toArray();
      const tableInfo = Object.fromEntries(
        Object.keys(expectedColumns).map((table) => [
          table,
          state.storage.sql
            .exec<{
              name: string;
              type: string;
              notnull: number;
              pk: number;
              dflt_value: string | null;
            }>(`PRAGMA table_info(${table})`)
            .toArray(),
        ]),
      );
      return { objects, tableInfo };
    });

    const tableObjects = catalog.objects.filter((row) => row.type === "table");
    expect(tableObjects.map((row) => row.name).sort()).toEqual(
      Object.keys(expectedColumns).sort(),
    );
    expect(tableObjects).toHaveLength(22);

    for (const [table, columns] of Object.entries(expectedColumns)) {
      const rows = catalog.tableInfo[table] as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
        dflt_value: string | null;
      }>;
      expect(
        rows.map((row) => [
          row.name,
          row.type,
          row.notnull,
          row.pk,
          row.dflt_value,
        ]),
      ).toEqual(columns);

      const createSql = normalizeSql(
        tableObjects.find((row) => row.name === table)?.sql ?? "",
      );
      for (const check of expectedChecks[table] ?? []) {
        expect(createSql).toContain(normalizeSql(check));
      }
      expect(createSql).toContain("STRICT");
    }

    const indexNames = catalog.objects
      .filter((row) => row.type === "index" && row.name.startsWith("idx_"))
      .map((row) => row.name)
      .sort();
    expect(indexNames).toEqual([...expectedIndexes].sort());
    expect(indexNames).toHaveLength(31);
    for (const indexName of expectedIndexes) {
      const index = catalog.objects.find((row) => row.name === indexName);
      expect(normalizeSql(index?.sql ?? "")).toBe(
        normalizeSql(expectedIndexSql[indexName] ?? ""),
      );
    }

    const allColumnNames = Object.values(catalog.tableInfo)
      .flat()
      .map((row) => String((row as { name: string }).name).toLowerCase());
    for (const forbidden of [
      "secret",
      "secret_key",
      "media_bytes",
      "bytes",
      "e2ee_key",
      "provider_token",
      "access_token",
      "session_token",
      "cookie",
      "bridge_secret",
      "auth_claims",
    ]) {
      expect(allColumnNames).not.toContain(forbidden);
    }
  });

  it("records fixed migrations in order and remains idempotent across re-entry", async () => {
    const stub = env.TENANT_PROJECTION.getByName("tenant_schema_idempotence");
    const first = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.sql
        .exec<{ version: number; name: string; applied_at: string }>(
          "SELECT version, name, applied_at FROM _sql_schema_migrations ORDER BY version",
        )
        .toArray(),
    );
    expect(first).toEqual([
      { version: 1, name: migrationName, applied_at: migrationAppliedAt },
      {
        version: 2,
        name: identitySequenceMigrationName,
        applied_at: identitySequenceMigrationAppliedAt,
      },
    ]);
    expect(
      PROJECTION_MIGRATIONS.map(({ version, name, appliedAt }) => ({
        version,
        name,
        applied_at: appliedAt,
      })),
    ).toEqual(first);

    await evictDurableObject(stub);
    const second = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.sql
        .exec<{ version: number; name: string; applied_at: string }>(
          "SELECT version, name, applied_at FROM _sql_schema_migrations ORDER BY version",
        )
        .toArray(),
    );
    expect(second).toEqual(first);
  });

  it("migrates interleaved version-one changes without altering global order or projection data", async () => {
    const tenant = "tenant_schema_identity_sequence_migration";
    const stub = env.TENANT_PROJECTION.getByName(tenant);
    const result = await runInDurableObject(stub, async (_instance, state) => {
      restoreVersionOneProjectionChanges(state);

      const changes = [
        [1, "event_human_one", "identity_human"],
        [2, "event_agent_one", "identity_agent"],
        [3, "event_human_two", "identity_human"],
        [4, "event_agent_two", "identity_agent"],
        [5, "event_floored_one", "identity_floored"],
        [6, "event_floored_two", "identity_floored"],
      ] as const;
      for (const [sequence, eventId, identityId] of changes) {
        const accountId = `account_${identityId}`;
        const connectionId = `connection_${identityId}`;
        const conversationId = `conversation_${identityId}`;
        state.storage.sql.exec(
          "INSERT INTO projection_changes (sequence, event_id, event_type, identity_id, account_id, connection_id, conversation_id, occurred_at, observed_at, generation) VALUES (?, ?, 'conversation.updated', ?, ?, ?, ?, '2026-09-10T01:00:00.000Z', '2026-09-10T01:00:01.000Z', 1)",
          sequence,
          eventId,
          identityId,
          accountId,
          connectionId,
          conversationId,
        );
        state.storage.sql.exec(
          "INSERT INTO applied_events (event_id, event_hash, event_type, event_source, identity_id, account_id, connection_id, conversation_id, occurred_at, observed_at, observed_ms, generation) VALUES (?, ?, 'conversation.updated', 'live', ?, ?, ?, ?, '2026-09-10T01:00:00.000Z', '2026-09-10T01:00:01.000Z', 1789002001000, 1)",
          eventId,
          "a".repeat(64),
          identityId,
          accountId,
          connectionId,
          conversationId,
        );
      }
      state.storage.sql.exec(
        "INSERT INTO projection_change_floors (identity_id, discarded_through_sequence) VALUES (?, ?), (?, ?)",
        "identity_floored",
        9,
        "identity_empty",
        12,
      );

      const beforeChanges = state.storage.sql
        .exec<Record<string, SqlStorageValue>>(
          "SELECT sequence, event_id, event_type, identity_id, account_id, connection_id, conversation_id, occurred_at, observed_at, generation FROM projection_changes ORDER BY sequence",
        )
        .toArray();
      const beforeAppliedEvents = state.storage.sql
        .exec<Record<string, SqlStorageValue>>(
          "SELECT event_id, event_hash, event_type, event_source, identity_id, account_id, connection_id, conversation_id, occurred_at, observed_at, observed_ms, generation FROM applied_events ORDER BY event_id",
        )
        .toArray();

      runProjectionMigrations(state.storage);

      return {
        beforeChanges,
        beforeAppliedEvents,
        afterChanges: state.storage.sql
          .exec<Record<string, SqlStorageValue>>(
            "SELECT sequence, event_id, event_type, identity_id, account_id, connection_id, conversation_id, occurred_at, observed_at, generation, identity_sequence FROM projection_changes ORDER BY sequence",
          )
          .toArray(),
        afterAppliedEvents: state.storage.sql
          .exec<Record<string, SqlStorageValue>>(
            "SELECT event_id, event_hash, event_type, event_source, identity_id, account_id, connection_id, conversation_id, occurred_at, observed_at, observed_ms, generation FROM applied_events ORDER BY event_id",
          )
          .toArray(),
        floors: state.storage.sql
          .exec<Record<string, SqlStorageValue>>(
            "SELECT identity_id, discarded_through_sequence FROM projection_change_floors ORDER BY identity_id",
          )
          .toArray(),
        counters: state.storage.sql
          .exec<Record<string, SqlStorageValue>>(
            "SELECT identity_id, latest_sequence FROM projection_identity_sequences ORDER BY identity_id",
          )
          .toArray(),
      };
    });

    expect(
      result.afterChanges.map(
        ({ identity_sequence: _identitySequence, ...row }) => row,
      ),
    ).toEqual(result.beforeChanges);
    expect(result.afterAppliedEvents).toEqual(result.beforeAppliedEvents);
    expect(
      result.afterChanges.map((row) => [
        row.identity_id,
        row.identity_sequence,
      ]),
    ).toEqual([
      ["identity_human", 1],
      ["identity_agent", 1],
      ["identity_human", 2],
      ["identity_agent", 2],
      ["identity_floored", 2],
      ["identity_floored", 3],
    ]);
    expect(result.floors).toEqual([
      { identity_id: "identity_empty", discarded_through_sequence: 1 },
      { identity_id: "identity_floored", discarded_through_sequence: 1 },
    ]);
    expect(result.counters).toEqual([
      { identity_id: "identity_agent", latest_sequence: 2 },
      { identity_id: "identity_empty", latest_sequence: 1 },
      { identity_id: "identity_floored", latest_sequence: 3 },
      { identity_id: "identity_human", latest_sequence: 2 },
    ]);
  });

  it("uses the required access-path indexes for summary and reverse ownership lookups", async () => {
    const stub = env.TENANT_PROJECTION.getByName("tenant_schema_query_plans");
    const plans = await runInDurableObject(stub, async (_instance, state) => {
      type QueryPlanRow = { detail: string };
      const explain = (query: string, ...params: unknown[]): string[] =>
        state.storage.sql
          .exec<QueryPlanRow>(`EXPLAIN QUERY PLAN ${query}`, ...params)
          .toArray()
          .map((row) => row.detail.toLowerCase());

      const summaryUpdate = explain(
        "UPDATE messages SET attachment_count = (SELECT COUNT(*) FROM attachments WHERE attachments.message_id = messages.id AND attachments.deleted_at IS NULL) WHERE identity_id = ? AND conversation_id = ? AND deleted_at IS NULL",
        "identity_query",
        "conversation_query",
      );
      const summaryCount = explain(
        "SELECT COUNT(*) FROM messages WHERE identity_id = ? AND conversation_id = ? AND deleted_at IS NULL",
        "identity_query",
        "conversation_query",
      );
      const latestMessage = explain(
        "SELECT id, body, occurred_at, occurred_ms FROM messages WHERE identity_id = ? AND conversation_id = ? AND deleted_at IS NULL ORDER BY occurred_ms DESC, id ASC LIMIT 1",
        "identity_query",
        "conversation_query",
      );
      const replyTarget = explain(
        "SELECT 1 AS found FROM messages WHERE reply_to_message_id = ? AND (identity_id <> ? OR account_id <> ? OR connection_id <> ? OR conversation_id <> ? OR platform <> ?) LIMIT 1",
        "reply_query",
        "identity_query",
        "account_query",
        "connection_query",
        "conversation_query",
        "platform_query",
      );
      const resourceTombstoneId = explain(
        "SELECT resource_type, identity_id, account_id, connection_id, conversation_id, platform FROM resource_tombstones WHERE resource_id = ?",
        "resource_query",
      );
      const conversationAttachmentTombstones = explain(
        "SELECT attachments.id, attachment_tombstone.occurred_at, message_tombstone.occurred_at FROM attachments LEFT JOIN resource_tombstones AS attachment_tombstone ON attachment_tombstone.resource_type = 'attachment' AND attachment_tombstone.resource_id = attachments.id LEFT JOIN resource_tombstones AS message_tombstone ON message_tombstone.resource_type = 'message' AND message_tombstone.resource_id = attachments.message_id WHERE attachments.conversation_id = ?",
        "conversation_query",
      );

      const reverseLookups = Object.fromEntries(
        [
          [
            "message_versions",
            "message_id",
            "idx_message_versions_message_order",
          ],
          [
            "messages",
            "sender_participant_id",
            "idx_messages_sender_participant",
          ],
          [
            "message_versions",
            "editor_participant_id",
            "idx_message_versions_editor_participant",
          ],
          ["reactions", "message_id", "idx_reactions_message_state"],
          ["reactions", "participant_id", "idx_reactions_participant"],
          ["receipts", "message_id", "idx_receipts_message_type_time"],
          ["receipts", "participant_id", "idx_receipts_participant"],
          ["typing_states", "participant_id", "idx_typing_participant"],
          ["attachments", "message_id", "idx_attachments_message_state"],
          [
            "message_delivery_updates",
            "message_id",
            "idx_delivery_message_order",
          ],
        ].map(([table, column, index]) => [
          index,
          explain(
            `SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`,
            "participant_query",
          ),
        ]),
      );
      const ownerMismatchParams = [
        "conversation_query",
        "identity_query",
        "account_query",
        "connection_query",
        "conversation_query",
        "platform_query",
      ];
      const conversationOwnerPreflight = Object.fromEntries(
        [
          "participants",
          "messages",
          "message_versions",
          "reactions",
          "receipts",
          "typing_states",
          "attachments",
          "commands",
          "message_delivery_updates",
          "event_tombstones",
          "resource_tombstones",
        ].map((table) => [
          table,
          explain(
            `SELECT 1 AS found FROM ${table} WHERE conversation_id = ? AND (identity_id <> ? OR account_id <> ? OR connection_id <> ? OR conversation_id <> ? OR platform <> ?) LIMIT 1`,
            ...ownerMismatchParams,
          ),
        ]),
      );
      const conversationCascadeQueries = [
        [
          "participants",
          "UPDATE participants SET display_name = 'Deleted participant' WHERE conversation_id = ?",
        ],
        [
          "messages",
          "UPDATE messages SET body = '', delivery_failure_code = NULL WHERE conversation_id = ?",
        ],
        [
          "message_versions",
          "UPDATE message_versions SET body = '', editor_participant_id = NULL WHERE conversation_id = ?",
        ],
        ["reactions", "DELETE FROM reactions WHERE conversation_id = ?"],
        ["receipts", "DELETE FROM receipts WHERE conversation_id = ?"],
        [
          "typing_states",
          "DELETE FROM typing_states WHERE conversation_id = ?",
        ],
        [
          "attachments",
          "UPDATE attachments SET file_name = NULL, mime_type = NULL, size_bytes = NULL, sha256 = NULL, r2_key = NULL, deleted_at = NULL WHERE conversation_id = ?",
        ],
        [
          "commands",
          "UPDATE commands SET failure_code = NULL WHERE conversation_id = ?",
        ],
        [
          "message_delivery_updates",
          "UPDATE message_delivery_updates SET failure_code = NULL WHERE conversation_id = ?",
        ],
      ] as const;
      const conversationCascadePredicates = conversationCascadeQueries.map(
        ([table, query]) =>
          [table, explain(query, "conversation_query")] as const,
      );
      return {
        summaryUpdate,
        summaryCount,
        latestMessage,
        replyTarget,
        resourceTombstoneId,
        conversationAttachmentTombstones,
        conversationOwnerPreflight,
        conversationCascadePredicates: Object.fromEntries(
          conversationCascadePredicates,
        ),
        reverseLookups,
      };
    });

    for (const summaryPlan of [
      plans.summaryUpdate,
      plans.summaryCount,
      plans.latestMessage,
    ]) {
      expect(
        summaryPlan.some(
          (detail) =>
            detail.includes("idx_messages_identity_conversation_occurred") ||
            detail.includes("idx_messages_conversation_owner"),
        ),
      ).toBe(true);
    }
    expect(
      plans.latestMessage.some((detail) => detail.includes("use temp b-tree")),
    ).toBe(false);
    expect(
      plans.replyTarget.some((detail) =>
        detail.includes("idx_messages_reply_target"),
      ),
    ).toBe(true);
    expect(plans.resourceTombstoneId).toEqual(
      expect.arrayContaining([
        expect.stringContaining("idx_resource_tombstones_id"),
      ]),
    );
    expect(plans.conversationAttachmentTombstones).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /idx_resource_tombstones_(id|resource_order)|sqlite_autoindex_resource_tombstones_2/,
        ),
      ]),
    );
    const conversationIndexes = {
      participants: "idx_participants_conversation_name",
      messages: "idx_messages_conversation_owner",
      message_versions: "idx_message_versions_conversation_owner",
      reactions: "idx_reactions_conversation_owner",
      receipts: "idx_receipts_conversation_owner",
      typing_states: "sqlite_autoindex_typing_states_1",
      attachments: "idx_attachments_conversation_owner",
      commands: "idx_commands_conversation_owner",
      message_delivery_updates: "idx_delivery_conversation_owner",
      event_tombstones: "idx_event_tombstones_conversation_owner",
      resource_tombstones: "idx_resource_tombstones_conversation_owner",
    } as const;
    for (const [table, index] of Object.entries(conversationIndexes)) {
      expect(plans.conversationOwnerPreflight[table]).toEqual(
        expect.arrayContaining([expect.stringContaining(index)]),
      );
    }
    const cascadeIndexes = {
      participants: "idx_participants_conversation_name",
      messages: "idx_messages_conversation_owner",
      message_versions: "idx_message_versions_conversation_owner",
      reactions: "idx_reactions_conversation_owner",
      receipts: "idx_receipts_conversation_owner",
      typing_states: "sqlite_autoindex_typing_states_1",
      attachments: "idx_attachments_conversation_owner",
      commands: "idx_commands_conversation_owner",
      message_delivery_updates: "idx_delivery_conversation_owner",
    } as const;
    for (const [table, index] of Object.entries(cascadeIndexes)) {
      expect(plans.conversationCascadePredicates[table]).toEqual(
        expect.arrayContaining([expect.stringContaining(index)]),
      );
    }
    for (const index of [
      "idx_message_versions_message_order",
      "idx_messages_sender_participant",
      "idx_message_versions_editor_participant",
      "idx_reactions_message_state",
      "idx_reactions_participant",
      "idx_receipts_message_type_time",
      "idx_receipts_participant",
      "idx_typing_participant",
      "idx_attachments_message_state",
    ]) {
      expect(plans.reverseLookups[index]).toEqual(
        expect.arrayContaining([expect.stringContaining(index)]),
      );
    }
    expect(plans.reverseLookups.idx_delivery_message_order).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /idx_delivery_message_order|sqlite_autoindex_message_delivery_updates_1/,
        ),
      ]),
    );
  });

  it("fails closed on an unknown newer migration without changing stored schema", async () => {
    const stub = env.TENANT_PROJECTION.getByName(
      "tenant_schema_unknown_version",
    );
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const schemaSnapshot = () =>
        state.storage.sql
          .exec<{ type: string; name: string; sql: string }>(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .toArray();
      const migrationSnapshot = () =>
        state.storage.sql
          .exec<{ version: number; name: string; applied_at: string }>(
            "SELECT version, name, applied_at FROM _sql_schema_migrations ORDER BY version",
          )
          .toArray();

      const schemaBefore = schemaSnapshot();
      state.storage.sql.exec(
        "INSERT INTO _sql_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        3,
        "future_projection_schema",
        migrationAppliedAt,
      );
      const migrationsBeforeFailure = migrationSnapshot();

      let failure: unknown;
      try {
        runProjectionMigrations(state.storage);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(ProjectionError);
      expect(failure).toMatchObject({
        code: "projection_unavailable",
        message: "projection_unavailable",
      });
      expect(Object.getOwnPropertyNames(failure as object)).not.toContain(
        "cause",
      );
      expect(getProjectionErrorCause(failure as ProjectionError)).toBeDefined();

      return {
        schemaBefore,
        schemaAfter: schemaSnapshot(),
        migrationsBeforeFailure,
        migrationsAfter: migrationSnapshot(),
      };
    });

    expect(result.schemaAfter).toEqual(result.schemaBefore);
    expect(result.migrationsAfter).toEqual(result.migrationsBeforeFailure);
  });

  it("fails closed on a version-name mismatch without changing stored schema", async () => {
    const stub = env.TENANT_PROJECTION.getByName("tenant_schema_name_mismatch");
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const schemaSnapshot = () =>
        state.storage.sql
          .exec<{ type: string; name: string; sql: string }>(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .toArray();
      const migrationSnapshot = () =>
        state.storage.sql
          .exec<{ version: number; name: string; applied_at: string }>(
            "SELECT version, name, applied_at FROM _sql_schema_migrations ORDER BY version",
          )
          .toArray();

      const schemaBefore = schemaSnapshot();
      state.storage.sql.exec(
        "DELETE FROM _sql_schema_migrations WHERE version = 1",
      );
      state.storage.sql.exec(
        "INSERT INTO _sql_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        1,
        "renamed_projection_schema",
        migrationAppliedAt,
      );
      const migrationsBeforeFailure = migrationSnapshot();

      let failure: unknown;
      try {
        runProjectionMigrations(state.storage);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(ProjectionError);
      expect(failure).toMatchObject({
        code: "projection_unavailable",
        message: "projection_unavailable",
      });
      expect(Object.getOwnPropertyNames(failure as object)).not.toContain(
        "cause",
      );
      expect(getProjectionErrorCause(failure as ProjectionError)).toBeDefined();

      return {
        schemaBefore,
        schemaAfter: schemaSnapshot(),
        migrationsBeforeFailure,
        migrationsAfter: migrationSnapshot(),
      };
    });

    expect(result.schemaAfter).toEqual(result.schemaBefore);
    expect(result.migrationsAfter).toEqual(result.migrationsBeforeFailure);
  });

  it("rolls back every DDL effect when migration metadata insertion fails", async () => {
    const stub = env.TENANT_PROJECTION.getByName(
      "tenant_schema_transaction_rollback",
    );
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const schemaSnapshot = () =>
        state.storage.sql
          .exec<{ type: string; name: string; sql: string }>(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .toArray();
      const migrationSnapshot = () =>
        state.storage.sql
          .exec<{ version: number; name: string; applied_at: string }>(
            "SELECT version, name, applied_at FROM _sql_schema_migrations ORDER BY version",
          )
          .toArray();

      state.storage.sql.exec("DELETE FROM _sql_schema_migrations");
      // The version-one DDL intentionally uses CREATE TABLE (without
      // IF NOT EXISTS) for application tables. Remove the complete
      // application schema so the normal runner reaches its final metadata
      // insert, where the trigger forces the transaction to abort.
      for (const table of applicationTableNames) {
        state.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      const schemaBeforeFailure = schemaSnapshot();
      state.storage.sql.exec(
        "CREATE TRIGGER projection_test_abort_migration BEFORE INSERT ON _sql_schema_migrations BEGIN SELECT RAISE(ABORT, 'migration metadata write blocked'); END",
      );

      let failure: unknown;
      try {
        runProjectionMigrations(state.storage);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(ProjectionError);
      expect(failure).toMatchObject({
        code: "projection_unavailable",
        message: "projection_unavailable",
      });
      expect(Object.getOwnPropertyNames(failure as object)).not.toContain(
        "cause",
      );
      expect(getProjectionErrorCause(failure as ProjectionError)).toBeDefined();

      state.storage.sql.exec("DROP TRIGGER projection_test_abort_migration");
      return {
        schemaBeforeFailure,
        schemaAfterFailure: schemaSnapshot(),
        migrationsAfterFailure: migrationSnapshot(),
        checkpointsAfterFailure: state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_checkpoints'",
          )
          .toArray(),
      };
    });

    expect(result.schemaAfterFailure).toEqual(result.schemaBeforeFailure);
    expect(result.migrationsAfterFailure).toEqual([]);
    expect(result.checkpointsAfterFailure).toEqual([]);
  });
});

describe("tenant projection initialization and status", () => {
  it("returns projection_not_found before initialize", async () => {
    const stub = env.TENANT_PROJECTION.getByName(
      "tenant_status_not_initialized",
    );
    await expectProjectionError(
      stub,
      (instance) =>
        instance.getStatus(statusInput("tenant_status_not_initialized")),
      "projection_not_found",
    );
  });

  it("initializes generation one with caller timestamps and null rebuild metadata", async () => {
    const tenantId = "tenant_lifecycle";
    const stub = env.TENANT_PROJECTION.getByName(tenantId);
    const initializedAt = "2026-09-07T04:05:06.000Z";
    const status = await stub.initialize(
      initializeInput(tenantId, initializedAt),
    );

    expect(status).toEqual({
      schema_version: 1,
      tenant_id: tenantId,
      schema_generation: 2,
      state: "ready",
      generation: 1,
      rebuild_id: null,
      last_completed_rebuild_id: null,
      last_failed_rebuild_id: null,
      last_rebuild_failure_code: null,
      applied_event_count: 0,
      conversation_count: 0,
      message_count: 0,
      latest_change_sequence: 0,
      checkpoints: [],
    });

    const meta = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.sql.exec("SELECT * FROM projection_meta").toArray(),
    );
    expect(meta).toEqual([
      {
        singleton: 1,
        tenant_id: tenantId,
        state: "ready",
        generation: 1,
        rebuild_id: null,
        rebuild_started_at: null,
        last_completed_rebuild_id: null,
        last_failed_rebuild_id: null,
        last_rebuild_failure_code: null,
        initialized_at: initializedAt,
        updated_at: initializedAt,
      },
    ]);
  });

  it("is idempotent for the same tenant without changing original timestamps", async () => {
    const tenantId = "tenant_initialize_idempotent";
    const stub = env.TENANT_PROJECTION.getByName(tenantId);
    await stub.initialize(
      initializeInput(tenantId, "2026-09-07T05:00:00.000Z"),
    );
    const repeat = await stub.initialize(
      initializeInput(tenantId, "2026-09-07T06:00:00.000Z"),
    );
    expect(repeat).toMatchObject({
      tenant_id: tenantId,
      generation: 1,
      state: "ready",
    });

    const timestamps = await runInDurableObject(
      stub,
      async (_instance, state) =>
        state.storage.sql
          .exec<{ initialized_at: string; updated_at: string }>(
            "SELECT initialized_at, updated_at FROM projection_meta",
          )
          .toArray(),
    );
    expect(timestamps).toEqual([
      {
        initialized_at: "2026-09-07T05:00:00.000Z",
        updated_at: "2026-09-07T05:00:00.000Z",
      },
    ]);
  });

  it("rejects another tenant against the same object and isolates a distinct name", async () => {
    const firstTenant = "tenant_same_stub";
    const firstStub = env.TENANT_PROJECTION.getByName(firstTenant);
    await firstStub.initialize(initializeInput(firstTenant));

    await expectProjectionError(
      firstStub,
      (instance) =>
        instance.initialize(initializeInput("tenant_other_on_same_stub")),
      "projection_tenant_mismatch",
    );

    const otherTenant = "tenant_distinct_stub";
    const otherStub = env.TENANT_PROJECTION.getByName(otherTenant);
    await expectProjectionError(
      otherStub,
      (instance) => instance.getStatus(statusInput(otherTenant)),
      "projection_not_found",
    );
    await otherStub.initialize(initializeInput(otherTenant));

    const rows = await runInDurableObject(firstStub, async (_instance, state) =>
      state.storage.sql
        .exec<{ tenant_id: string }>("SELECT tenant_id FROM projection_meta")
        .toArray(),
    );
    expect(rows).toEqual([{ tenant_id: firstTenant }]);
    const otherRows = await runInDurableObject(
      otherStub,
      async (_instance, state) =>
        state.storage.sql
          .exec<{ tenant_id: string }>("SELECT tenant_id FROM projection_meta")
          .toArray(),
    );
    expect(otherRows).toEqual([{ tenant_id: otherTenant }]);
  });

  it("denies missing or wrong scopes before data access", async () => {
    const uninitializedTenant = "tenant_scope_before_storage";
    const uninitializedStub =
      env.TENANT_PROJECTION.getByName(uninitializedTenant);
    await expectProjectionError(
      uninitializedStub,
      (instance) =>
        instance.getStatus(
          statusInput(uninitializedTenant, ["projection.read"]),
        ),
      "projection_forbidden",
    );
    await expectProjectionError(
      uninitializedStub,
      (instance) =>
        instance.initialize(
          initializeInput(uninitializedTenant, undefined, [
            "projection.status",
          ]),
        ),
      "projection_forbidden",
    );

    const initializedTenant = "tenant_scope_after_storage";
    const initializedStub = env.TENANT_PROJECTION.getByName(initializedTenant);
    await initializedStub.initialize(initializeInput(initializedTenant));
    await expectProjectionError(
      initializedStub,
      (instance) =>
        instance.getStatus(statusInput(initializedTenant, ["projection.read"])),
      "projection_forbidden",
    );
  });

  it("maps malformed hostile input to projection_invalid", async () => {
    const stub = env.TENANT_PROJECTION.getByName("tenant_hostile_status");
    const hostile = Object.defineProperty({}, "tenant_id", {
      enumerable: true,
      get() {
        throw new Error("tenant getter must not run");
      },
    });
    const rejection = await runInDurableObject(stub, async (instance) => {
      try {
        await instance.getStatus(hostile as unknown as ProjectionStatusInput);
        return undefined;
      } catch (error) {
        return error;
      }
    });
    expect(rejection).toMatchObject({
      code: "projection_invalid",
      message: "projection_invalid",
    });
  });

  it("maps unexpected storage errors to sanitized unavailable errors with private causes", async () => {
    const projection = Object.create(
      (await import("../../projection/tenant-projection")).TenantProjectionDO
        .prototype,
    ) as unknown as TenantProjectionDO;
    const rawCause = new Error("secret SQL binding and payload");
    (projection as unknown as { ctx: DurableObjectState }).ctx = {
      storage: {
        sql: {
          exec() {
            throw rawCause;
          },
        },
      },
    } as unknown as DurableObjectState;

    let caught: unknown;
    try {
      await projection.getStatus(statusInput("tenant_storage_failure"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProjectionError);
    expect(caught).toMatchObject({
      code: "projection_unavailable",
      message: "projection_unavailable",
    });
    expect(Object.getOwnPropertyNames(caught as object)).not.toContain("cause");
    expect(getProjectionErrorCause(caught as ProjectionError)).toBe(rawCause);
  });

  it("returns copy-safe SQLite status after object re-entry", async () => {
    const tenantId = "tenant_status_reentry";
    const stub = env.TENANT_PROJECTION.getByName(tenantId);
    await stub.initialize(initializeInput(tenantId));
    const first = await stub.getStatus(statusInput(tenantId));
    first.checkpoints.push({
      kind: "local-only",
      value: "mutation",
      generation: 1,
      updated_at: "2026-09-07T00:00:00.000Z",
      last_observed_at: null,
      last_event_id: null,
      source_cursor: null,
      page_digest: null,
    });
    await evictDurableObject(stub);
    const second = await stub.getStatus(statusInput(tenantId));
    expect(second.checkpoints).toEqual([]);
    expect(second).not.toBe(first);
  });
});
