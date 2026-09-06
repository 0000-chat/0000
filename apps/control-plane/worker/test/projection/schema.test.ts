import { env, runInDurableObject, evictDurableObject } from "cloudflare:test";
import type {
  InitializeProjectionInput,
  ProjectionAuthorizationContext,
  ProjectionStatusInput,
} from "@communicator/contracts";
import { describe, expect, it } from "vitest";
import { getProjectionErrorCause, ProjectionError } from "../../projection/errors";
import { runProjectionMigrations } from "../../projection/schema";
import type { TenantProjectionDO } from "../../projection/tenant-projection";

const migrationName = "initial_tenant_projection";
const migrationAppliedAt = "2026-09-07T00:00:00.000Z";
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

const normalizeSql = (sql: string): string =>
  sql.replace(/\s+/g, " ").trim();

const expectedColumns: Record<
  string,
  Array<[name: string, type: string, notNull: number, primaryKey: number, defaultValue: string | null]>
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
};

const expectedChecks: Record<string, string[]> = {
  _sql_schema_migrations: ["CHECK(version >= 1)"],
  projection_meta: [
    "CHECK(singleton = 1)",
    "CHECK(state IN ('ready','rebuilding','rebuild_failed'))",
    "CHECK(generation >= 1 AND generation <= 9007199254740991)",
    "CHECK(last_rebuild_failure_code IS NULL OR last_rebuild_failure_code IN ('operator_abort','unsupported_archive','archive_gap','binding_conflict','validation_failed'))",
  ],
  completed_rebuilds: ["CHECK(generation >= 2 AND generation <= 9007199254740991)"],
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
  projection_changes: ["CHECK(generation >= 1)"],
  projection_change_floors: ["CHECK(discarded_through_sequence >= 0)"],
  projection_checkpoints: [
    "CHECK(page_digest IS NULL OR length(page_digest) = 64)",
    "CHECK(generation >= 1)",
    "CHECK(last_applied_count IS NULL OR last_applied_count >= 0)",
    "CHECK(last_duplicate_count IS NULL OR last_duplicate_count >= 0)",
    "CHECK(last_sequence IS NULL OR last_sequence >= 0)",
  ],
};

const expectedIndexes = [
  "idx_conversations_identity_activity",
  "idx_conversations_identity_connection_activity",
  "idx_messages_identity_conversation_occurred",
  "idx_messages_matrix_event",
  "idx_messages_remote_message",
  "idx_message_versions_message_order",
  "idx_participants_conversation_name",
  "idx_reactions_message_state",
  "idx_receipts_message_type_time",
  "idx_attachments_message_state",
  "idx_delivery_message_order",
  "idx_applied_events_order",
  "idx_projection_changes_identity_sequence",
  "idx_resource_tombstones_resource_order",
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
  idx_message_versions_message_order:
    "CREATE INDEX idx_message_versions_message_order ON message_versions(message_id,observed_ms DESC,event_id DESC)",
  idx_participants_conversation_name:
    "CREATE INDEX idx_participants_conversation_name ON participants(conversation_id,display_name,id)",
  idx_reactions_message_state:
    "CREATE INDEX idx_reactions_message_state ON reactions(message_id,removed_at,occurred_at)",
  idx_receipts_message_type_time:
    "CREATE INDEX idx_receipts_message_type_time ON receipts(message_id,receipt_type,occurred_at)",
  idx_attachments_message_state:
    "CREATE INDEX idx_attachments_message_state ON attachments(message_id,deleted_at,id)",
  idx_delivery_message_order:
    "CREATE INDEX idx_delivery_message_order ON message_delivery_updates(message_id,last_observed_ms,last_event_id)",
  idx_applied_events_order:
    "CREATE INDEX idx_applied_events_order ON applied_events(observed_ms,event_id)",
  idx_projection_changes_identity_sequence:
    "CREATE INDEX idx_projection_changes_identity_sequence ON projection_changes(identity_id,sequence)",
  idx_resource_tombstones_resource_order:
    "CREATE INDEX idx_resource_tombstones_resource_order ON resource_tombstones(resource_type,resource_id,observed_ms)",
};

describe("tenant projection SQLite schema", () => {
  it("creates the exact version-one tables, columns, checks, and named indexes", async () => {
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
    expect(tableObjects).toHaveLength(21);

    for (const [table, columns] of Object.entries(expectedColumns)) {
      const rows = catalog.tableInfo[table] as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
        dflt_value: string | null;
      }>;
      expect(
        rows.map((row) => [row.name, row.type, row.notnull, row.pk, row.dflt_value]),
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
    expect(indexNames).toHaveLength(14);
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

  it("records one fixed migration row and remains idempotent across re-entry", async () => {
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
    ]);

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

  it("fails closed on an unknown newer migration without changing stored schema", async () => {
    const stub = env.TENANT_PROJECTION.getByName("tenant_schema_unknown_version");
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
        2,
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
      expect(Object.getOwnPropertyNames(failure as object)).not.toContain("cause");
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
      state.storage.sql.exec("DELETE FROM _sql_schema_migrations WHERE version = 1");
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
      expect(Object.getOwnPropertyNames(failure as object)).not.toContain("cause");
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
    const stub = env.TENANT_PROJECTION.getByName("tenant_schema_transaction_rollback");
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
        state.storage.sql.exec(`DROP TABLE ${table}`);
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
      expect(Object.getOwnPropertyNames(failure as object)).not.toContain("cause");
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
    const stub = env.TENANT_PROJECTION.getByName("tenant_status_not_initialized");
    await expectProjectionError(
      stub,
      (instance) => instance.getStatus(statusInput("tenant_status_not_initialized")),
      "projection_not_found",
    );
  });

  it("initializes generation one with caller timestamps and null rebuild metadata", async () => {
    const tenantId = "tenant_lifecycle";
    const stub = env.TENANT_PROJECTION.getByName(tenantId);
    const initializedAt = "2026-09-07T04:05:06.000Z";
    const status = await stub.initialize(initializeInput(tenantId, initializedAt));

    expect(status).toEqual({
      schema_version: 1,
      tenant_id: tenantId,
      schema_generation: 1,
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
    await stub.initialize(initializeInput(tenantId, "2026-09-07T05:00:00.000Z"));
    const repeat = await stub.initialize(
      initializeInput(tenantId, "2026-09-07T06:00:00.000Z"),
    );
    expect(repeat).toMatchObject({ tenant_id: tenantId, generation: 1, state: "ready" });

    const timestamps = await runInDurableObject(stub, async (_instance, state) =>
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
      (instance) => instance.initialize(initializeInput("tenant_other_on_same_stub")),
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
    const otherRows = await runInDurableObject(otherStub, async (_instance, state) =>
      state.storage.sql
        .exec<{ tenant_id: string }>("SELECT tenant_id FROM projection_meta")
        .toArray(),
    );
    expect(otherRows).toEqual([{ tenant_id: otherTenant }]);
  });

  it("denies missing or wrong scopes before data access", async () => {
    const uninitializedTenant = "tenant_scope_before_storage";
    const uninitializedStub = env.TENANT_PROJECTION.getByName(uninitializedTenant);
    await expectProjectionError(
      uninitializedStub,
      (instance) => instance.getStatus(
        statusInput(uninitializedTenant, ["projection.read"]),
      ),
      "projection_forbidden",
    );
    await expectProjectionError(
      uninitializedStub,
      (instance) => instance.initialize(
        initializeInput(uninitializedTenant, undefined, ["projection.status"]),
      ),
      "projection_forbidden",
    );

    const initializedTenant = "tenant_scope_after_storage";
    const initializedStub = env.TENANT_PROJECTION.getByName(initializedTenant);
    await initializedStub.initialize(initializeInput(initializedTenant));
    await expectProjectionError(
      initializedStub,
      (instance) => instance.getStatus(
        statusInput(initializedTenant, ["projection.read"]),
      ),
      "projection_forbidden",
    );
  });

  it("maps malformed hostile input to projection_invalid", async () => {
    const stub = env.TENANT_PROJECTION.getByName("tenant_hostile_status");
    const hostile = Object.defineProperty(
      {},
      "tenant_id",
      {
        enumerable: true,
        get() {
          throw new Error("tenant getter must not run");
        },
      },
    );
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
      (await import("../../projection/tenant-projection")).TenantProjectionDO.prototype,
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
