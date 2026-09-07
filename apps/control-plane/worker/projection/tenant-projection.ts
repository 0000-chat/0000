import {
  ApplyProjectionBatchInputSchema,
  ApplyReplayPageInputSchema,
  compareOpaqueEventIds,
  ConversationPageResultSchema,
  DEFAULT_PROJECTION_PAGE_SIZE,
  MAX_PROJECTION_CHANGES,
  MAX_PROJECTION_BATCH_BYTES,
  MAX_PROJECTION_BATCH_EVENTS,
  ListProjectionChangesInputSchema,
  ListProjectionConversationsInputSchema,
  ListProjectionMessagesInputSchema,
  MessagePageResultSchema,
  MAX_PROJECTION_PAGE_SIZE,
  ProjectionChangePageSchema,
  type ApplyProjectionBatchInput,
  type ApplyProjectionBatchResult,
  type ApplyReplayPageInput,
  type ArchiveReplayPage,
  type ConversationPageResult,
  AbortRebuildInputSchema,
  BeginRebuildInputSchema,
  CompleteRebuildInputSchema,
  type AbortRebuildInput,
  type BeginRebuildInput,
  type CompleteRebuildInput,
  InitializeProjectionInputSchema,
  type ListProjectionChangesInput,
  type ListProjectionConversationsInput,
  type ListProjectionMessagesInput,
  type MessagePageResult,
  type ProjectionChange,
  type ProjectionChangePage,
  ProjectionStatusInputSchema,
  type InitializeProjectionInput,
  type ProjectionAuthorizationContext,
  type ProjectionScope,
  type ProjectionStatus,
  type ProjectionStatusCheckpoint,
  type ProjectionStatusInput,
  type ProjectionConnectionBinding,
} from "@communicator/contracts";
import { DurableObject } from "cloudflare:workers";
import { deriveManifestPrefix } from "../archive/keys";
import { decodeReplayCursor } from "../archive/reader";
import { canonicalJsonStringify } from "../archive/canonical-json";
import { sha256Hex } from "../archive/codec";
import {
  ProjectionError,
  projectionError,
  safeProjectionError,
} from "./errors";
import {
  prepareProjectionBatch,
  projectEvent,
  recomputeConversationSummaries,
  mapArchiveFailure,
  type PreparedCheckpointMutation,
  type PreparedProjectionEvent,
} from "./projector";
import { runProjectionMigrations } from "./schema";
import {
  decodeConversationCursor,
  decodeMessageCursor,
  encodeConversationCursor,
  encodeMessageCursor,
} from "./cursor";

type ProjectionMetaRow = {
  singleton: number;
  tenant_id: string;
  state: ProjectionStatus["state"];
  generation: number;
  rebuild_id: string | null;
  rebuild_started_at: string | null;
  last_completed_rebuild_id: string | null;
  last_failed_rebuild_id: string | null;
  last_rebuild_failure_code: ProjectionStatus["last_rebuild_failure_code"];
  initialized_at: string;
  updated_at: string;
};

type ProjectionCheckpointRow = {
  kind: string;
  value: string;
  generation: number;
  updated_at: string;
  last_observed_at: string | null;
  last_event_id: string | null;
  source_cursor: string | null;
  page_digest: string | null;
};

type ProjectionCheckpointStorageRow = ProjectionCheckpointRow & {
  last_observed_ms: number | null;
  last_applied_count: number | null;
  last_duplicate_count: number | null;
  last_sequence: number | null;
};

type ConnectionBindingRow = {
  account_id: string;
  connection_id: string;
  identity_id: string;
  platform: string;
};

type AppliedEventRow = {
  event_id: string;
  event_hash: string;
  event_type: string;
  event_source: string;
  identity_id: string;
  account_id: string;
  connection_id: string;
  conversation_id: string;
  occurred_at: string;
  observed_at: string;
  observed_ms: number;
  generation: number;
};

type ProjectionChangeFloorRow = {
  identity_id: string;
  discarded_through_sequence: number;
};

type ApplyPreparedBatchInput = {
  readonly tenantId: string;
  readonly mode: "live" | "replay";
  readonly rebuildId: string | null;
  readonly preparedEvents: readonly PreparedProjectionEvent[];
  readonly checkpointMutation:
    | PreparedCheckpointMutation
    | PreparedReplayCheckpointMutation
    | null;
  readonly inputEventCount: number;
  readonly connections: readonly ProjectionConnectionBinding[];
};

type PreparedReplayCheckpointMutation = {
  readonly kind: "r2_manifest_cursor";
  readonly value: string;
  readonly sourceCursor: string | null;
  readonly pageDigest: string;
  readonly lastObservedAt: string | null;
  readonly lastObservedMs: number | null;
  readonly lastEventId: string | null;
  readonly updatedAt: string;
};

type ProjectionCountRow = {
  applied_event_count: number;
  conversation_count: number;
  message_count: number;
  latest_change_sequence: number;
};

type ProjectionSchemaGenerationRow = { schema_generation: number | null };

type ConversationQueryRow = {
  id: string;
  identity_id: string;
  connection_id: string;
  title: string;
  last_message_preview: string;
  last_activity_at: string;
  last_activity_ms: number;
  unread_count: number;
};

type MessageQueryRow = {
  id: string;
  identity_id: string;
  connection_id: string;
  conversation_id: string;
  direction: "inbound" | "outbound";
  sender_label: string;
  body: string;
  occurred_at: string;
  occurred_ms: number;
  delivery_status:
    | "unknown"
    | "accepted"
    | "sent"
    | "delivered"
    | "read"
    | "failed";
  attachment_count: number;
  deleted_at: string | null;
};

type ConversationExistsRow = { id: string };

type ProjectionChangeQueryRow = {
  sequence: number;
  event_id: string;
  event_type: ProjectionChange["event_type"];
  identity_id: string;
  connection_id: string;
  conversation_id: string;
  occurred_at: string;
  observed_at: string;
  generation: number;
};

type LatestSequenceRow = { latest_sequence: number };

type ChangeFloorQueryRow = { discarded_through_sequence: number };

const REPLAY_CHECKPOINT_KIND = "r2_manifest_cursor";

/**
 * All rows in these tables are derived from the immutable archive or live
 * events. A rebuild removes them as one transaction while retaining the
 * tenant binding, schema, and lifecycle history tables.
 */
const DERIVED_PROJECTION_TABLES = [
  "resource_tombstones",
  "event_tombstones",
  "reactions",
  "receipts",
  "typing_states",
  "attachments",
  "message_delivery_updates",
  "commands",
  "message_versions",
  "messages",
  "participants",
  "conversations",
  "applied_events",
  "projection_changes",
  "projection_change_floors",
  "projection_checkpoints",
] as const;

const clearDerivedProjectionData = (storage: DurableObjectStorage): void => {
  for (const table of DERIVED_PROJECTION_TABLES) {
    storage.sql.exec(`DELETE FROM ${table}`);
  }
  // projection_changes is the only AUTOINCREMENT table. SQLite creates
  // sqlite_sequence lazily with that table, so this is deterministic and
  // keeps a fresh generation's change sequence starting at one.
  storage.sql.exec(
    "DELETE FROM sqlite_sequence WHERE name = 'projection_changes'",
  );
};

const sameNullableString = (
  left: string | null,
  right: string | null,
): boolean => left === right;

const parseReplayCursor = (
  cursor: string | null,
  tenantId: string,
): void => {
  if (cursor === null) return;
  try {
    decodeReplayCursor(cursor, tenantId, deriveManifestPrefix(tenantId));
  } catch (error) {
    throw mapArchiveFailure(error);
  }
};

const replayPageDigest = async (
  sourceCursor: string | null,
  connections: readonly ProjectionConnectionBinding[],
  page: ArchiveReplayPage,
): Promise<string> => {
  try {
    const canonical = canonicalJsonStringify({
      source_cursor: sourceCursor,
      connections,
      page,
    });
    return await sha256Hex(new TextEncoder().encode(canonical));
  } catch (error) {
    throw mapArchiveFailure(error);
  }
};

const readProjectionMeta = (
  storage: DurableObjectStorage,
): ProjectionMetaRow | undefined =>
  storage.sql
    .exec<ProjectionMetaRow>(
      "SELECT singleton, tenant_id, state, generation, rebuild_id, rebuild_started_at, last_completed_rebuild_id, last_failed_rebuild_id, last_rebuild_failure_code, initialized_at, updated_at FROM projection_meta WHERE singleton = 1",
    )
    .toArray()[0];

const requireAuthorization = (
  inputTenantId: string,
  authorization: ProjectionAuthorizationContext,
  requiredScope: ProjectionScope,
): void => {
  if (authorization.tenant_id !== inputTenantId) {
    throw projectionError("projection_tenant_mismatch");
  }
  if (!authorization.scopes.includes(requiredScope)) {
    throw projectionError("projection_forbidden");
  }
};

const requireIdentityAuthorization = (
  authorization: ProjectionAuthorizationContext,
  identityId: string,
): void => {
  if (!authorization.allowed_identity_ids.includes(identityId)) {
    throw projectionError("projection_forbidden");
  }
};

const requireStoredTenant = (
  meta: ProjectionMetaRow,
  inputTenantId: string,
): void => {
  if (meta.tenant_id !== inputTenantId) {
    throw projectionError("projection_tenant_mismatch");
  }
};

const readStatusForMeta = (
  storage: DurableObjectStorage,
  meta: ProjectionMetaRow,
): ProjectionStatus => {
  const schemaGeneration = storage.sql
    .exec<ProjectionSchemaGenerationRow>(
      "SELECT MAX(version) AS schema_generation FROM _sql_schema_migrations",
    )
    .toArray()[0]?.schema_generation;
  if (schemaGeneration === null || schemaGeneration === undefined) {
    throw new Error("projection schema generation is missing");
  }

  const counts = storage.sql
    .exec<ProjectionCountRow>(
      "SELECT (SELECT COUNT(*) FROM applied_events) AS applied_event_count, (SELECT COUNT(*) FROM conversations) AS conversation_count, (SELECT COUNT(*) FROM messages) AS message_count, COALESCE((SELECT MAX(sequence) FROM projection_changes), 0) AS latest_change_sequence",
    )
    .toArray()[0];
  if (counts === undefined) throw new Error("projection status counts are missing");

  const checkpoints = storage.sql
    .exec<ProjectionCheckpointRow>(
      "SELECT kind, value, generation, updated_at, last_observed_at, last_event_id, source_cursor, page_digest FROM projection_checkpoints ORDER BY kind ASC",
    )
    .toArray()
    .map<ProjectionStatusCheckpoint>((checkpoint) => ({
      kind: checkpoint.kind,
      value: checkpoint.value,
      generation: checkpoint.generation,
      updated_at: checkpoint.updated_at,
      last_observed_at: checkpoint.last_observed_at,
      last_event_id: checkpoint.last_event_id,
      source_cursor: checkpoint.source_cursor,
      page_digest: checkpoint.page_digest,
    }));

  return {
    schema_version: 1,
    tenant_id: meta.tenant_id,
    schema_generation: schemaGeneration,
    state: meta.state,
    generation: meta.generation,
    rebuild_id: meta.rebuild_id,
    last_completed_rebuild_id: meta.last_completed_rebuild_id,
    last_failed_rebuild_id: meta.last_failed_rebuild_id,
    last_rebuild_failure_code: meta.last_rebuild_failure_code,
    applied_event_count: counts.applied_event_count,
    conversation_count: counts.conversation_count,
    message_count: counts.message_count,
    latest_change_sequence: counts.latest_change_sequence,
    checkpoints,
  };
};

const parseProjectionInput = <T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  input: unknown,
): T => {
  try {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw projectionError("projection_invalid");
    // Contract schemas already snapshot hostile descriptors; clone once more so
    // values returned from an RPC never share mutable nested references.
    return structuredClone(parsed.data);
  } catch (error) {
    if (error instanceof ProjectionError) throw error;
    throw projectionError("projection_invalid", error);
  }
};

/** Read an ordinary own array length without invoking a getter or Proxy trap. */
const hasOversizedApplyEventArray = (input: unknown): boolean => {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const eventsDescriptor = Object.getOwnPropertyDescriptor(input, "events");
    if (
      !eventsDescriptor ||
      !eventsDescriptor.enumerable ||
      !("value" in eventsDescriptor)
    ) {
      return false;
    }
    const events = eventsDescriptor.value;
    if (!Array.isArray(events) || Object.getPrototypeOf(events) !== Array.prototype) {
      return false;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(events, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor)) return false;
    return (
      Number.isSafeInteger(lengthDescriptor.value) &&
      lengthDescriptor.value > MAX_PROJECTION_BATCH_EVENTS
    );
  } catch {
    return false;
  }
};

/** Read a replay page's own event-array length without invoking accessors. */
const hasOversizedReplayEventArray = (input: unknown): boolean => {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return false;
    }
    const inputPrototype = Object.getPrototypeOf(input);
    if (inputPrototype !== Object.prototype && inputPrototype !== null) {
      return false;
    }
    const pageDescriptor = Object.getOwnPropertyDescriptor(input, "page");
    if (
      !pageDescriptor ||
      !pageDescriptor.enumerable ||
      !("value" in pageDescriptor) ||
      pageDescriptor.value === null ||
      typeof pageDescriptor.value !== "object" ||
      Array.isArray(pageDescriptor.value)
    ) {
      return false;
    }
    const pagePrototype = Object.getPrototypeOf(pageDescriptor.value);
    if (pagePrototype !== Object.prototype && pagePrototype !== null) {
      return false;
    }
    const eventsDescriptor = Object.getOwnPropertyDescriptor(
      pageDescriptor.value,
      "events",
    );
    if (
      !eventsDescriptor ||
      !eventsDescriptor.enumerable ||
      !("value" in eventsDescriptor)
    ) {
      return false;
    }
    const events = eventsDescriptor.value;
    if (!Array.isArray(events) || Object.getPrototypeOf(events) !== Array.prototype) {
      return false;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(events, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor)) return false;
    return (
      Number.isSafeInteger(lengthDescriptor.value) &&
      lengthDescriptor.value > MAX_PROJECTION_BATCH_EVENTS
    );
  } catch {
    return false;
  }
};

const parseApplyProjectionBatchInput = (
  input: unknown,
): ApplyProjectionBatchInput => {
  if (hasOversizedApplyEventArray(input)) {
    throw projectionError("projection_too_large");
  }
  return parseProjectionInput(ApplyProjectionBatchInputSchema, input);
};

const parseStoredMilliseconds = (timestamp: string): number => {
  const milliseconds = Date.parse(timestamp);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error("projection timestamp is not a safe integer");
  }
  return milliseconds;
};

const readConversationRows = (
  storage: DurableObjectStorage,
  input: ListProjectionConversationsInput,
  generation: number,
): ConversationQueryRow[] => {
  const pageSize = input.page_size ?? DEFAULT_PROJECTION_PAGE_SIZE;
  const cursor = input.cursor === undefined
    ? undefined
    : decodeConversationCursor(input.cursor, {
        tenant_id: input.tenant_id,
        identity_id: input.identity_id,
        connection_id: input.connection_id,
        generation,
      });
  const limit = pageSize + 1;

  if (input.connection_id === null) {
    if (cursor === undefined) {
      return storage.sql
        .exec<ConversationQueryRow>(
          "SELECT id, identity_id, connection_id, title, last_message_preview, last_activity_at, last_activity_ms, unread_count FROM conversations WHERE identity_id = ? AND deleted_at IS NULL ORDER BY last_activity_ms DESC, id ASC LIMIT ?",
          input.identity_id,
          limit,
        )
        .toArray();
    }
    return storage.sql
      .exec<ConversationQueryRow>(
        "SELECT id, identity_id, connection_id, title, last_message_preview, last_activity_at, last_activity_ms, unread_count FROM conversations WHERE identity_id = ? AND deleted_at IS NULL AND (last_activity_ms < ? OR (last_activity_ms = ? AND id > ?)) ORDER BY last_activity_ms DESC, id ASC LIMIT ?",
        input.identity_id,
        cursor.last_activity_ms,
        cursor.last_activity_ms,
        cursor.last_id,
        limit,
      )
      .toArray();
  }

  if (cursor === undefined) {
    return storage.sql
      .exec<ConversationQueryRow>(
        "SELECT id, identity_id, connection_id, title, last_message_preview, last_activity_at, last_activity_ms, unread_count FROM conversations WHERE identity_id = ? AND connection_id = ? AND deleted_at IS NULL ORDER BY last_activity_ms DESC, id ASC LIMIT ?",
        input.identity_id,
        input.connection_id,
        limit,
      )
      .toArray();
  }
  return storage.sql
    .exec<ConversationQueryRow>(
      "SELECT id, identity_id, connection_id, title, last_message_preview, last_activity_at, last_activity_ms, unread_count FROM conversations WHERE identity_id = ? AND connection_id = ? AND deleted_at IS NULL AND (last_activity_ms < ? OR (last_activity_ms = ? AND id > ?)) ORDER BY last_activity_ms DESC, id ASC LIMIT ?",
      input.identity_id,
      input.connection_id,
      cursor.last_activity_ms,
      cursor.last_activity_ms,
      cursor.last_id,
      limit,
    )
    .toArray();
};

const mapConversationPage = (
  tenantId: string,
  generation: number,
  input: ListProjectionConversationsInput,
  rows: readonly ConversationQueryRow[],
): ConversationPageResult => {
  const pageSize = input.page_size ?? DEFAULT_PROJECTION_PAGE_SIZE;
  const hasNext = rows.length > pageSize;
  const visibleRows = rows.slice(0, pageSize);
  const items = visibleRows.map((row) => {
    const lastActivityMs = parseStoredMilliseconds(row.last_activity_at);
    if (lastActivityMs !== row.last_activity_ms) {
      throw new Error("projection conversation activity tuple is inconsistent");
    }
    return {
      id: row.id,
      tenant_id: tenantId,
      identity_id: row.identity_id,
      connection_id: row.connection_id,
      title: row.title,
      last_message_preview: row.last_message_preview,
      last_activity_at: row.last_activity_at,
      unread_count: row.unread_count,
    };
  });
  const last = visibleRows.at(-1);
  const nextCursor = hasNext && last !== undefined
    ? encodeConversationCursor({
        schema_version: 1,
        query_kind: "projection.conversations",
        tenant_id: tenantId,
        identity_id: input.identity_id,
        connection_id: input.connection_id,
        generation,
        last_activity_ms: parseStoredMilliseconds(last.last_activity_at),
        last_id: last.id,
      })
    : null;
  return ConversationPageResultSchema.parse({ items, next_cursor: nextCursor });
};

const readMessageRows = (
  storage: DurableObjectStorage,
  input: ListProjectionMessagesInput,
  generation: number,
): MessageQueryRow[] => {
  const pageSize = input.page_size ?? DEFAULT_PROJECTION_PAGE_SIZE;
  const cursor = input.cursor === undefined
    ? undefined
    : decodeMessageCursor(input.cursor, {
        tenant_id: input.tenant_id,
        identity_id: input.identity_id,
        conversation_id: input.conversation_id,
        generation,
      });
  const limit = pageSize + 1;
  if (cursor === undefined) {
    return storage.sql
      .exec<MessageQueryRow>(
        "SELECT id, identity_id, connection_id, conversation_id, direction, sender_label, body, occurred_at, occurred_ms, delivery_status, attachment_count, deleted_at FROM messages WHERE identity_id = ? AND conversation_id = ? ORDER BY occurred_ms DESC, id ASC LIMIT ?",
        input.identity_id,
        input.conversation_id,
        limit,
      )
      .toArray();
  }
  return storage.sql
    .exec<MessageQueryRow>(
      "SELECT id, identity_id, connection_id, conversation_id, direction, sender_label, body, occurred_at, occurred_ms, delivery_status, attachment_count, deleted_at FROM messages WHERE identity_id = ? AND conversation_id = ? AND (occurred_ms < ? OR (occurred_ms = ? AND id > ?)) ORDER BY occurred_ms DESC, id ASC LIMIT ?",
      input.identity_id,
      input.conversation_id,
      cursor.last_occurred_ms,
      cursor.last_occurred_ms,
      cursor.last_id,
      limit,
    )
    .toArray();
};

const mapMessagePage = (
  tenantId: string,
  generation: number,
  input: ListProjectionMessagesInput,
  rows: readonly MessageQueryRow[],
): MessagePageResult => {
  const pageSize = input.page_size ?? DEFAULT_PROJECTION_PAGE_SIZE;
  const hasNext = rows.length > pageSize;
  const visibleRows = rows.slice(0, pageSize);
  const items = visibleRows.map((row) => {
    const occurredMs = parseStoredMilliseconds(row.occurred_at);
    if (occurredMs !== row.occurred_ms) {
      throw new Error("projection message occurrence tuple is inconsistent");
    }
    const redacted = row.deleted_at !== null;
    return {
      id: row.id,
      tenant_id: tenantId,
      identity_id: row.identity_id,
      connection_id: row.connection_id,
      conversation_id: row.conversation_id,
      direction: row.direction,
      sender_label: redacted ? "Deleted sender" : row.sender_label,
      body: redacted ? "" : row.body,
      occurred_at: row.occurred_at,
      delivery_status: row.delivery_status,
      attachment_count: redacted ? 0 : row.attachment_count,
    };
  });
  const last = visibleRows.at(-1);
  const nextCursor = hasNext && last !== undefined
    ? encodeMessageCursor({
        schema_version: 1,
        query_kind: "projection.messages",
        tenant_id: tenantId,
        identity_id: input.identity_id,
        conversation_id: input.conversation_id,
        generation,
        last_occurred_ms: parseStoredMilliseconds(last.occurred_at),
        last_id: last.id,
      })
    : null;
  return MessagePageResultSchema.parse({ items, next_cursor: nextCursor });
};

const readChangePage = (
  storage: DurableObjectStorage,
  input: ListProjectionChangesInput,
  meta: ProjectionMetaRow,
): ProjectionChangePage => {
  if (input.generation !== meta.generation) {
    throw projectionError("projection_conflict");
  }

  const latestRow = storage.sql
    .exec<LatestSequenceRow>(
      "SELECT COALESCE(MAX(sequence), 0) AS latest_sequence FROM projection_changes",
    )
    .toArray()[0];
  if (latestRow === undefined) throw new Error("projection sequence is missing");

  const floorRow = storage.sql
    .exec<ChangeFloorQueryRow>(
      "SELECT discarded_through_sequence FROM projection_change_floors WHERE identity_id = ?",
      input.identity_id,
    )
    .toArray()[0];
  const floor = floorRow?.discarded_through_sequence ?? 0;
  const resetRequired = input.after_sequence < floor;
  const limit = input.limit ?? MAX_PROJECTION_PAGE_SIZE;
  const rows = resetRequired
    ? []
    : storage.sql
        .exec<ProjectionChangeQueryRow>(
          "SELECT sequence, event_id, event_type, identity_id, connection_id, conversation_id, occurred_at, observed_at, generation FROM projection_changes WHERE identity_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?",
          input.identity_id,
          input.after_sequence,
          limit,
        )
        .toArray();

  const page: ProjectionChangePage = {
    schema_version: 1,
    tenant_id: input.tenant_id,
    identity_id: input.identity_id,
    generation: meta.generation,
    items: rows.map((row) => ({
      sequence: row.sequence,
      event_id: row.event_id,
      event_type: row.event_type,
      identity_id: row.identity_id,
      connection_id: row.connection_id,
      conversation_id: row.conversation_id,
      occurred_at: row.occurred_at,
      observed_at: row.observed_at,
      generation: row.generation,
    })),
    latest_sequence: latestRow.latest_sequence,
    reset_required: resetRequired,
  };
  return ProjectionChangePageSchema.parse(page);
};

export class TenantProjectionDO extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      runProjectionMigrations(this.ctx.storage);
    });
  }

  async initialize(input: InitializeProjectionInput): Promise<ProjectionStatus> {
    try {
      const parsed = parseProjectionInput(
        InitializeProjectionInputSchema,
        input,
      );
      requireAuthorization(
        parsed.tenant_id,
        parsed.authorization,
        "projection.initialize",
      );

      const existing = readProjectionMeta(this.ctx.storage);
      if (existing !== undefined) {
        requireStoredTenant(existing, parsed.tenant_id);
        return readStatusForMeta(this.ctx.storage, existing);
      }

      this.ctx.storage.transactionSync(() => {
        // initialize is intentionally the only creator of projection_meta.
        this.ctx.storage.sql.exec(
          "INSERT INTO projection_meta (singleton, tenant_id, state, generation, rebuild_id, rebuild_started_at, last_completed_rebuild_id, last_failed_rebuild_id, last_rebuild_failure_code, initialized_at, updated_at) VALUES (1, ?, 'ready', 1, NULL, NULL, NULL, NULL, NULL, ?, ?)",
          parsed.tenant_id,
          parsed.initialized_at,
          parsed.initialized_at,
        );
      });

      const created = readProjectionMeta(this.ctx.storage);
      if (created === undefined) throw new Error("projection metadata was not created");
      requireStoredTenant(created, parsed.tenant_id);
      return readStatusForMeta(this.ctx.storage, created);
    } catch (error) {
      throw safeProjectionError(error, "projection_unavailable");
    }
  }

  async getStatus(input: ProjectionStatusInput): Promise<ProjectionStatus> {
    try {
      const parsed = parseProjectionInput(ProjectionStatusInputSchema, input);
      requireAuthorization(
        parsed.tenant_id,
        parsed.authorization,
        "projection.status",
      );

      const meta = readProjectionMeta(this.ctx.storage);
      if (meta === undefined) throw projectionError("projection_not_found");
      requireStoredTenant(meta, parsed.tenant_id);
      return readStatusForMeta(this.ctx.storage, meta);
    } catch (error) {
      throw safeProjectionError(error, "projection_unavailable");
    }
  }

  /**
   * Apply one bounded live batch. Parsing, cross-field validation, canonical
   * serialization, and all asynchronous hashes complete before the private
   * transaction helper is entered.
   */
  async applyBatch(
    input: ApplyProjectionBatchInput,
  ): Promise<ApplyProjectionBatchResult> {
    try {
      const parsed = parseApplyProjectionBatchInput(input);
      requireAuthorization(
        parsed.tenant_id,
        parsed.authorization,
        "projection.write",
      );

      const meta = readProjectionMeta(this.ctx.storage);
      if (meta === undefined) throw projectionError("projection_not_found");
      requireStoredTenant(meta, parsed.tenant_id);
      this.#requireReadyState(meta);

      const prepared = await prepareProjectionBatch(parsed);
      return this.#applyPreparedBatch({
        tenantId: prepared.tenantId,
        mode: "live",
        rebuildId: null,
        preparedEvents: prepared.events,
        checkpointMutation: prepared.checkpointMutation,
        inputEventCount: prepared.inputEventCount,
        connections: prepared.connections,
      });
    } catch (error) {
      throw safeProjectionError(error, "projection_unavailable");
    }
  }

  /**
   * Start one resumable rebuild. Lifecycle timestamps are supplied by the
   * trusted caller; the projection never consults a wall clock.
   */
  async beginRebuild(input: BeginRebuildInput): Promise<ProjectionStatus> {
    try {
      const parsed = parseProjectionInput(BeginRebuildInputSchema, input);
      requireAuthorization(
        parsed.tenant_id,
        parsed.authorization,
        "projection.rebuild",
      );

      const meta = readProjectionMeta(this.ctx.storage);
      if (meta === undefined) throw projectionError("projection_not_found");
      requireStoredTenant(meta, parsed.tenant_id);

      if (meta.state === "rebuilding") {
        if (
          meta.rebuild_id !== parsed.rebuild_id ||
          meta.rebuild_started_at !== parsed.started_at ||
          parsed.expected_generation !== meta.generation - 1
        ) {
          throw projectionError("projection_rebuild_mismatch");
        }
        return readStatusForMeta(this.ctx.storage, meta);
      }

      if (meta.state !== "ready" && meta.state !== "rebuild_failed") {
        throw projectionError("projection_unavailable");
      }
      if (parsed.expected_generation !== meta.generation) {
        throw projectionError("projection_rebuild_mismatch");
      }

      const history = this.ctx.storage.sql
        .exec<{ rebuild_id: string }>(
          "SELECT rebuild_id FROM completed_rebuilds WHERE rebuild_id = ? UNION ALL SELECT rebuild_id FROM failed_rebuilds WHERE rebuild_id = ?",
          parsed.rebuild_id,
          parsed.rebuild_id,
        )
        .toArray()[0];
      if (history !== undefined) {
        throw projectionError("projection_rebuild_mismatch");
      }

      const nextGeneration = meta.generation + 1;
      if (!Number.isSafeInteger(nextGeneration)) {
        throw projectionError("projection_unavailable");
      }

      this.ctx.storage.transactionSync(() => {
        // Re-check lifecycle state inside the transaction so all destructive
        // deletes and metadata changes roll back together on any failure.
        const current = readProjectionMeta(this.ctx.storage);
        if (current === undefined) throw projectionError("projection_not_found");
        requireStoredTenant(current, parsed.tenant_id);
        // A duplicate begin can have read the old ready/failed row just
        // before the first caller committed. Treat the now-active identical
        // lifecycle request as the same idempotent retry.
        if (
          current.state === "rebuilding" &&
          current.rebuild_id === parsed.rebuild_id &&
          current.rebuild_started_at === parsed.started_at &&
          parsed.expected_generation === current.generation - 1
        ) {
          return;
        }
        if (current.state !== meta.state || current.generation !== meta.generation) {
          throw projectionError("projection_rebuild_mismatch");
        }

        clearDerivedProjectionData(this.ctx.storage);
        this.ctx.storage.sql.exec(
          "UPDATE projection_meta SET state = 'rebuilding', generation = ?, rebuild_id = ?, rebuild_started_at = ?, last_rebuild_failure_code = NULL, updated_at = ? WHERE singleton = 1",
          nextGeneration,
          parsed.rebuild_id,
          parsed.started_at,
          parsed.started_at,
        );
      });

      const started = readProjectionMeta(this.ctx.storage);
      if (started === undefined) throw new Error("projection metadata disappeared");
      return readStatusForMeta(this.ctx.storage, started);
    } catch (error) {
      throw safeProjectionError(error, "projection_unavailable");
    }
  }

  /**
   * Mark the active rebuild complete only after its current-generation replay
   * checkpoint has reached the terminal marker.
   */
  async completeRebuild(input: CompleteRebuildInput): Promise<ProjectionStatus> {
    try {
      const parsed = parseProjectionInput(CompleteRebuildInputSchema, input);
      requireAuthorization(
        parsed.tenant_id,
        parsed.authorization,
        "projection.rebuild",
      );

      const meta = readProjectionMeta(this.ctx.storage);
      if (meta === undefined) throw projectionError("projection_not_found");
      requireStoredTenant(meta, parsed.tenant_id);

      if (meta.state === "ready") {
        if (meta.last_completed_rebuild_id !== parsed.rebuild_id) {
          throw projectionError("projection_rebuild_mismatch");
        }
        return readStatusForMeta(this.ctx.storage, meta);
      }
      if (meta.state !== "rebuilding" || meta.rebuild_id !== parsed.rebuild_id) {
        throw projectionError("projection_rebuild_mismatch");
      }

      this.ctx.storage.transactionSync(() => {
        const current = readProjectionMeta(this.ctx.storage);
        if (current === undefined) throw projectionError("projection_not_found");
        requireStoredTenant(current, parsed.tenant_id);
        // If the first completion won between the preflight read and this
        // transaction, the exact same completion is already durable.
        if (
          current.state === "ready" &&
          current.last_completed_rebuild_id === parsed.rebuild_id
        ) {
          return;
        }
        if (
          current.state !== "rebuilding" ||
          current.rebuild_id !== parsed.rebuild_id
        ) {
          throw projectionError("projection_rebuild_mismatch");
        }
        const terminal = this.ctx.storage.sql
          .exec<ProjectionCheckpointStorageRow>(
            "SELECT kind, value, updated_at, last_observed_at, last_observed_ms, last_event_id, source_cursor, page_digest, generation, last_applied_count, last_duplicate_count, last_sequence FROM projection_checkpoints WHERE kind = ?",
            REPLAY_CHECKPOINT_KIND,
          )
          .toArray()[0];
        if (
          terminal === undefined ||
          terminal.generation !== current.generation ||
          terminal.value !== "terminal"
        ) {
          throw projectionError("projection_rebuild_mismatch");
        }

        this.ctx.storage.sql.exec(
          "INSERT INTO completed_rebuilds (rebuild_id, generation, completed_at) VALUES (?, ?, ?)",
          parsed.rebuild_id,
          current.generation,
          parsed.completed_at,
        );
        this.ctx.storage.sql.exec(
          "UPDATE projection_meta SET state = 'ready', rebuild_id = NULL, rebuild_started_at = NULL, last_completed_rebuild_id = ?, last_rebuild_failure_code = NULL, updated_at = ? WHERE singleton = 1",
          parsed.rebuild_id,
          parsed.completed_at,
        );
      });

      const completed = readProjectionMeta(this.ctx.storage);
      if (completed === undefined) throw new Error("projection metadata disappeared");
      return readStatusForMeta(this.ctx.storage, completed);
    } catch (error) {
      throw safeProjectionError(error, "projection_unavailable");
    }
  }

  /**
   * Atomically discard partial replay state and record only bounded failure
   * metadata. The immutable connection and rebuild histories are retained.
   */
  async abortRebuild(input: AbortRebuildInput): Promise<ProjectionStatus> {
    try {
      const parsed = parseProjectionInput(AbortRebuildInputSchema, input);
      requireAuthorization(
        parsed.tenant_id,
        parsed.authorization,
        "projection.rebuild",
      );

      const meta = readProjectionMeta(this.ctx.storage);
      if (meta === undefined) throw projectionError("projection_not_found");
      requireStoredTenant(meta, parsed.tenant_id);

      if (meta.state === "rebuild_failed") {
        if (meta.last_failed_rebuild_id !== parsed.rebuild_id) {
          throw projectionError("projection_rebuild_mismatch");
        }
        const failure = this.ctx.storage.sql
          .exec<{ failed_at: string; failure_code: ProjectionStatus["last_rebuild_failure_code"] }>(
            "SELECT failed_at, failure_code FROM failed_rebuilds WHERE rebuild_id = ?",
            parsed.rebuild_id,
          )
          .toArray()[0];
        if (
          failure === undefined ||
          failure.failed_at !== parsed.failed_at ||
          failure.failure_code !== parsed.failure_code
        ) {
          throw projectionError("projection_rebuild_mismatch");
        }
        return readStatusForMeta(this.ctx.storage, meta);
      }

      if (meta.state !== "rebuilding" || meta.rebuild_id !== parsed.rebuild_id) {
        throw projectionError("projection_rebuild_mismatch");
      }

      this.ctx.storage.transactionSync(() => {
        const current = readProjectionMeta(this.ctx.storage);
        if (current === undefined) throw projectionError("projection_not_found");
        requireStoredTenant(current, parsed.tenant_id);
        // Mirror the public failed-state retry semantics for two concurrent
        // abort callers. The failure row is checked before treating it as an
        // idempotent success so mismatched details still fail closed.
        if (current.state === "rebuild_failed") {
          if (current.last_failed_rebuild_id !== parsed.rebuild_id) {
            throw projectionError("projection_rebuild_mismatch");
          }
          const failure = this.ctx.storage.sql
            .exec<{ failed_at: string; failure_code: ProjectionStatus["last_rebuild_failure_code"] }>(
              "SELECT failed_at, failure_code FROM failed_rebuilds WHERE rebuild_id = ?",
              parsed.rebuild_id,
            )
            .toArray()[0];
          if (
            failure === undefined ||
            failure.failed_at !== parsed.failed_at ||
            failure.failure_code !== parsed.failure_code
          ) {
            throw projectionError("projection_rebuild_mismatch");
          }
          return;
        }
        if (
          current.state !== "rebuilding" ||
          current.rebuild_id !== parsed.rebuild_id
        ) {
          throw projectionError("projection_rebuild_mismatch");
        }

        clearDerivedProjectionData(this.ctx.storage);
        this.ctx.storage.sql.exec(
          "INSERT INTO failed_rebuilds (rebuild_id, generation, failed_at, failure_code) VALUES (?, ?, ?, ?)",
          parsed.rebuild_id,
          current.generation,
          parsed.failed_at,
          parsed.failure_code,
        );
        this.ctx.storage.sql.exec(
          "UPDATE projection_meta SET state = 'rebuild_failed', rebuild_id = NULL, rebuild_started_at = NULL, last_failed_rebuild_id = ?, last_rebuild_failure_code = ?, updated_at = ? WHERE singleton = 1",
          parsed.rebuild_id,
          parsed.failure_code,
          parsed.failed_at,
        );
      });

      const failed = readProjectionMeta(this.ctx.storage);
      if (failed === undefined) throw new Error("projection metadata disappeared");
      return readStatusForMeta(this.ctx.storage, failed);
    } catch (error) {
      throw safeProjectionError(error, "projection_unavailable");
    }
  }

  /**
   * Apply one immutable archive replay page. The trusted R2 reader remains
   * outside this object; this RPC accepts only a validated page and advances
   * its adjacent source cursor in the same transaction as derived state.
   */
  async applyReplayPage(
    input: ApplyReplayPageInput,
  ): Promise<ApplyProjectionBatchResult> {
    try {
      if (hasOversizedReplayEventArray(input)) {
        throw projectionError("projection_too_large");
      }
      const parsed = parseProjectionInput(ApplyReplayPageInputSchema, input);
      requireAuthorization(
        parsed.tenant_id,
        parsed.authorization,
        "projection.rebuild",
      );
      // Validate the page's tenant before consulting SQLite. The page is a
      // detached archive value; a mismatched page must not even reach the
      // lifecycle/state checks for this object.
      if (parsed.page.tenant_id !== parsed.tenant_id) {
        throw projectionError("projection_tenant_mismatch");
      }

      const meta = readProjectionMeta(this.ctx.storage);
      if (meta === undefined) throw projectionError("projection_not_found");
      requireStoredTenant(meta, parsed.tenant_id);
      if (meta.state === "rebuild_failed") {
        throw projectionError("projection_rebuild_failed");
      }
      if (meta.state !== "rebuilding" || meta.rebuild_id !== parsed.rebuild_id) {
        throw projectionError("projection_rebuild_mismatch");
      }
      parseReplayCursor(parsed.source_cursor, parsed.tenant_id);
      parseReplayCursor(parsed.page.next_cursor, parsed.tenant_id);
      if (
        parsed.source_cursor !== null &&
        parsed.page.next_cursor !== null &&
        parsed.source_cursor === parsed.page.next_cursor
      ) {
        throw projectionError("projection_conflict");
      }

      const isEmptyTerminal =
        parsed.page.manifests.length === 0 &&
        parsed.page.events.length === 0 &&
        parsed.page.next_cursor === null;
      if (parsed.page.events.length === 0) {
        if (!isEmptyTerminal || parsed.connections.length !== 0) {
          throw projectionError("projection_invalid");
        }
      } else {
        if (parsed.page.manifests.length === 0) {
          throw projectionError("projection_invalid");
        }
        if (parsed.page.events.length > MAX_PROJECTION_BATCH_EVENTS) {
          throw projectionError("projection_too_large");
        }
        let manifestEventCount = 0;
        let manifestBytes = 0;
        for (const manifest of parsed.page.manifests) {
          manifestEventCount += manifest.event_count;
          manifestBytes += manifest.uncompressed_bytes;
          if (
            !Number.isSafeInteger(manifestEventCount) ||
            !Number.isSafeInteger(manifestBytes)
          ) {
            throw projectionError("projection_too_large");
          }
        }
        if (manifestEventCount !== parsed.page.events.length) {
          throw projectionError("projection_invalid");
        }
        if (manifestBytes > MAX_PROJECTION_BATCH_BYTES) {
          throw projectionError("projection_too_large");
        }
      }

      const digest = await replayPageDigest(
        parsed.source_cursor,
        parsed.connections,
        parsed.page,
      );

      let preparedEvents: readonly PreparedProjectionEvent[] = [];
      let inputEventCount = 0;
      let connections: readonly ProjectionConnectionBinding[] = parsed.connections;
      if (!isEmptyTerminal) {
        inputEventCount = parsed.page.events.length;
        // Replay is tenant-wide and intentionally ignores allowed_identity_ids.
        // prepareProjectionBatch still supplies the shared descriptor-safe
        // event/binding/hash preflight, using an internal identity set only for
        // that helper's structural check.
        const identities = [...new Set(parsed.page.events.map((event) => event.identity_id))].sort();
        const prepared = await prepareProjectionBatch({
          schema_version: 1,
          tenant_id: parsed.tenant_id,
          authorization: {
            ...parsed.authorization,
            allowed_identity_ids: identities,
          },
          mode: "live",
          rebuild_id: null,
          connections: parsed.connections,
          events: parsed.page.events,
          checkpoint: null,
        });
        preparedEvents = prepared.events;
        connections = prepared.connections;
      }

      const pageGreatest = preparedEvents.at(-1);
      const replayCheckpoint: PreparedReplayCheckpointMutation = {
        kind: REPLAY_CHECKPOINT_KIND,
        value: parsed.page.next_cursor ?? "terminal",
        sourceCursor: parsed.source_cursor,
        pageDigest: digest,
        lastObservedAt: pageGreatest?.event.observed_at ?? null,
        lastObservedMs: pageGreatest?.observedMs ?? null,
        lastEventId: pageGreatest?.event.event_id ?? null,
        // updatedAt is finalized against the previously retained tuple inside
        // the transaction; this value is only a page-local fallback.
        updatedAt: pageGreatest?.event.observed_at ?? meta.rebuild_started_at ?? meta.updated_at,
      };

      return this.#applyPreparedBatch({
        tenantId: parsed.tenant_id,
        mode: "replay",
        rebuildId: parsed.rebuild_id,
        preparedEvents,
        checkpointMutation: replayCheckpoint,
        inputEventCount,
        connections,
      });
    } catch (error) {
      throw safeProjectionError(error, "projection_unavailable");
    }
  }

  async listConversations(
    input: ListProjectionConversationsInput,
  ): Promise<ConversationPageResult> {
    try {
      const parsed = parseProjectionInput(
        ListProjectionConversationsInputSchema,
        input,
      );
      requireAuthorization(
        parsed.tenant_id,
        parsed.authorization,
        "projection.read",
      );
      requireIdentityAuthorization(parsed.authorization, parsed.identity_id);

      const meta = readProjectionMeta(this.ctx.storage);
      if (meta === undefined) throw projectionError("projection_not_found");
      requireStoredTenant(meta, parsed.tenant_id);
      this.#requireReadyState(meta);

      const rows = readConversationRows(this.ctx.storage, parsed, meta.generation);
      return structuredClone(
        mapConversationPage(parsed.tenant_id, meta.generation, parsed, rows),
      );
    } catch (error) {
      throw safeProjectionError(error, "projection_unavailable");
    }
  }

  async listMessages(
    input: ListProjectionMessagesInput,
  ): Promise<MessagePageResult> {
    try {
      const parsed = parseProjectionInput(
        ListProjectionMessagesInputSchema,
        input,
      );
      requireAuthorization(
        parsed.tenant_id,
        parsed.authorization,
        "projection.read",
      );
      requireIdentityAuthorization(parsed.authorization, parsed.identity_id);

      const meta = readProjectionMeta(this.ctx.storage);
      if (meta === undefined) throw projectionError("projection_not_found");
      requireStoredTenant(meta, parsed.tenant_id);
      this.#requireReadyState(meta);

      // A message query is only valid for an active conversation owned by the
      // requested identity. Returning one generic denial for all misses avoids
      // revealing whether another identity owns the conversation ID.
      const conversation = this.ctx.storage.sql
        .exec<ConversationExistsRow>(
          "SELECT id FROM conversations WHERE id = ? AND identity_id = ? AND deleted_at IS NULL",
          parsed.conversation_id,
          parsed.identity_id,
        )
        .toArray()[0];
      if (conversation === undefined) {
        throw projectionError("projection_forbidden");
      }

      const rows = readMessageRows(this.ctx.storage, parsed, meta.generation);
      return structuredClone(
        mapMessagePage(parsed.tenant_id, meta.generation, parsed, rows),
      );
    } catch (error) {
      throw safeProjectionError(error, "projection_unavailable");
    }
  }

  async listChanges(
    input: ListProjectionChangesInput,
  ): Promise<ProjectionChangePage> {
    try {
      const parsed = parseProjectionInput(
        ListProjectionChangesInputSchema,
        input,
      );
      requireAuthorization(
        parsed.tenant_id,
        parsed.authorization,
        "projection.read",
      );
      requireIdentityAuthorization(parsed.authorization, parsed.identity_id);

      const meta = readProjectionMeta(this.ctx.storage);
      if (meta === undefined) throw projectionError("projection_not_found");
      requireStoredTenant(meta, parsed.tenant_id);
      this.#requireReadyState(meta);

      return structuredClone(readChangePage(this.ctx.storage, parsed, meta));
    } catch (error) {
      throw safeProjectionError(error, "projection_unavailable");
    }
  }

  /** The sole owner of every multi-table live or replay projection transaction. */
  #applyPreparedBatch(
    input: ApplyPreparedBatchInput,
  ): ApplyProjectionBatchResult {
    try {
      return this.ctx.storage.transactionSync(() => {
        const meta = readProjectionMeta(this.ctx.storage);
        if (meta === undefined) throw projectionError("projection_not_found");
        requireStoredTenant(meta, input.tenantId);
        if (input.mode === "live") {
          if (input.rebuildId !== null) {
            throw projectionError("projection_invalid");
          }
          this.#requireReadyState(meta);
        } else {
          if (
            meta.state === "rebuild_failed"
          ) {
            throw projectionError("projection_rebuild_failed");
          }
          if (
            meta.state !== "rebuilding" ||
            meta.rebuild_id !== input.rebuildId ||
            input.rebuildId === null
          ) {
            throw projectionError("projection_rebuild_mismatch");
          }
        }

        this.#ensurePersistentBindings(input.connections);

        if (input.mode === "replay") {
          const replayCheckpoint = input.checkpointMutation as PreparedReplayCheckpointMutation | null;
          if (
            replayCheckpoint === null ||
            replayCheckpoint.kind !== REPLAY_CHECKPOINT_KIND
          ) {
            throw projectionError("projection_invalid");
          }
          const existing = this.ctx.storage.sql
            .exec<ProjectionCheckpointStorageRow>(
              "SELECT kind, value, updated_at, last_observed_at, last_observed_ms, last_event_id, source_cursor, page_digest, generation, last_applied_count, last_duplicate_count, last_sequence FROM projection_checkpoints WHERE kind = ?",
              REPLAY_CHECKPOINT_KIND,
            )
            .toArray()[0];

          if (existing !== undefined) {
            if (existing.generation !== meta.generation) {
              throw projectionError("projection_conflict");
            }
            if (sameNullableString(existing.source_cursor, replayCheckpoint.sourceCursor)) {
              if (existing.page_digest === replayCheckpoint.pageDigest) {
                return {
                  schema_version: 1,
                  tenant_id: input.tenantId,
                  generation: meta.generation,
                  applied_count: existing.last_applied_count ?? 0,
                  duplicate_count: existing.last_duplicate_count ?? 0,
                  last_sequence: existing.last_sequence ?? this.#readLastSequence(),
                };
              }
              throw projectionError("projection_conflict");
            }
            if (
              existing.value === "terminal" ||
              existing.value !== replayCheckpoint.sourceCursor
            ) {
              throw projectionError("projection_conflict");
            }
          } else if (replayCheckpoint.sourceCursor !== null) {
            throw projectionError("projection_conflict");
          }

          const result = this.#projectPreparedEvents(
            input.preparedEvents,
            input.inputEventCount,
            meta,
          );
          this.#writeReplayCheckpoint(
            replayCheckpoint,
            existing,
            result.appliedCount,
            result.duplicateCount,
            result.lastSequence,
            meta,
          );
          return {
            schema_version: 1,
            tenant_id: input.tenantId,
            generation: meta.generation,
            applied_count: result.appliedCount,
            duplicate_count: result.duplicateCount,
            last_sequence: result.lastSequence,
          };
        }

        const liveCheckpoint = input.checkpointMutation as PreparedCheckpointMutation | null;
        if (liveCheckpoint !== null && liveCheckpoint.kind === REPLAY_CHECKPOINT_KIND) {
          throw projectionError("projection_invalid");
        }
        const result = this.#projectPreparedEvents(
          input.preparedEvents,
          input.inputEventCount,
          meta,
        );
        const lastSequence = result.lastSequence;
        this.#applyLiveCheckpoint(liveCheckpoint, meta, lastSequence);

        return {
          schema_version: 1,
          tenant_id: input.tenantId,
          generation: meta.generation,
          applied_count: result.appliedCount,
          duplicate_count: result.duplicateCount,
          last_sequence: lastSequence,
        };
      });
    } catch (error) {
      if (error instanceof ProjectionError) throw error;
      throw projectionError("projection_unavailable", error);
    }
  }

  #projectPreparedEvents(
    preparedEvents: readonly PreparedProjectionEvent[],
    inputEventCount: number,
    meta: ProjectionMetaRow,
  ): {
    appliedCount: number;
    duplicateCount: number;
    lastSequence: number;
  } {
    const storedEvents = this.#readAppliedEvents(preparedEvents);
    let appliedCount = 0;
    const touchedConversations = new Set<string>();
    for (const prepared of preparedEvents) {
      const stored = storedEvents.get(prepared.event.event_id);
      if (stored !== undefined) {
        this.#assertStoredEventMatches(stored, prepared);
        continue;
      }

      projectEvent(
        prepared,
        this.ctx.storage.sql,
        touchedConversations,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO applied_events (event_id, event_hash, event_type, event_source, identity_id, account_id, connection_id, conversation_id, occurred_at, observed_at, observed_ms, generation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        prepared.event.event_id,
        prepared.eventHash,
        prepared.event.event_type,
        prepared.event.event_source,
        prepared.event.identity_id,
        prepared.event.account_id,
        prepared.connection.connection_id,
        prepared.event.conversation_id,
        prepared.event.occurred_at,
        prepared.event.observed_at,
        prepared.observedMs,
        meta.generation,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO projection_changes (event_id, event_type, identity_id, account_id, connection_id, conversation_id, occurred_at, observed_at, generation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        prepared.event.event_id,
        prepared.event.event_type,
        prepared.event.identity_id,
        prepared.event.account_id,
        prepared.connection.connection_id,
        prepared.event.conversation_id,
        prepared.event.occurred_at,
        prepared.event.observed_at,
        meta.generation,
      );
      appliedCount += 1;
    }

    recomputeConversationSummaries(
      this.ctx.storage.sql,
      touchedConversations,
    );

    this.#trimProjectionChanges();
    const lastSequence = this.#readLastSequence();
    return {
      appliedCount,
      duplicateCount: inputEventCount - appliedCount,
      lastSequence,
    };
  }

  #writeReplayCheckpoint(
    checkpoint: PreparedReplayCheckpointMutation,
    existing: ProjectionCheckpointStorageRow | undefined,
    appliedCount: number,
    duplicateCount: number,
    lastSequence: number,
    meta: ProjectionMetaRow,
  ): void {
    let lastObservedAt = checkpoint.lastObservedAt;
    let lastObservedMs = checkpoint.lastObservedMs;
    let lastEventId = checkpoint.lastEventId;
    let updatedAt = checkpoint.updatedAt;

    if (existing !== undefined) {
      const existingHasTuple =
        existing.last_observed_ms !== null && existing.last_event_id !== null;
      const incomingHasTuple =
        checkpoint.lastObservedMs !== null && checkpoint.lastEventId !== null;
      const incomingIsNewer = incomingHasTuple && (
        !existingHasTuple ||
        checkpoint.lastObservedMs! > existing.last_observed_ms! ||
        (checkpoint.lastObservedMs === existing.last_observed_ms &&
          compareOpaqueEventIds(
            checkpoint.lastEventId!,
            existing.last_event_id!,
          ) > 0)
      );
      if (!incomingIsNewer && existingHasTuple) {
        lastObservedAt = existing.last_observed_at;
        lastObservedMs = existing.last_observed_ms;
        lastEventId = existing.last_event_id;
        updatedAt = existing.updated_at;
      }
      if (!incomingHasTuple && existingHasTuple) {
        lastObservedAt = existing.last_observed_at;
        lastObservedMs = existing.last_observed_ms;
        lastEventId = existing.last_event_id;
        updatedAt = existing.updated_at;
      }
      if (!incomingHasTuple && !existingHasTuple) {
        lastObservedAt = existing.last_observed_at;
        lastObservedMs = existing.last_observed_ms;
        lastEventId = existing.last_event_id;
        updatedAt = existing.updated_at;
      }
    }

    if (lastObservedAt === null && lastObservedMs !== null) {
      throw projectionError("projection_conflict");
    }
    if (lastObservedAt !== null && lastObservedMs === null) {
      throw projectionError("projection_conflict");
    }

    if (existing === undefined) {
      this.ctx.storage.sql.exec(
        "INSERT INTO projection_checkpoints (kind, value, source_cursor, page_digest, last_observed_at, last_observed_ms, last_event_id, generation, updated_at, last_applied_count, last_duplicate_count, last_sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        checkpoint.kind,
        checkpoint.value,
        checkpoint.sourceCursor,
        checkpoint.pageDigest,
        lastObservedAt,
        lastObservedMs,
        lastEventId,
        meta.generation,
        updatedAt,
        appliedCount,
        duplicateCount,
        lastSequence,
      );
      return;
    }

    this.ctx.storage.sql.exec(
      "UPDATE projection_checkpoints SET value = ?, source_cursor = ?, page_digest = ?, last_observed_at = ?, last_observed_ms = ?, last_event_id = ?, generation = ?, updated_at = ?, last_applied_count = ?, last_duplicate_count = ?, last_sequence = ? WHERE kind = ?",
      checkpoint.value,
      checkpoint.sourceCursor,
      checkpoint.pageDigest,
      lastObservedAt,
      lastObservedMs,
      lastEventId,
      meta.generation,
      updatedAt,
      appliedCount,
      duplicateCount,
      lastSequence,
      checkpoint.kind,
    );
  }

  #requireReadyState(meta: ProjectionMetaRow): void {
    if (meta.state === "rebuilding") {
      throw projectionError("projection_rebuilding");
    }
    if (meta.state === "rebuild_failed") {
      throw projectionError("projection_rebuild_failed");
    }
    if (meta.state !== "ready") {
      throw projectionError("projection_unavailable");
    }
  }

  #ensurePersistentBindings(
    bindings: readonly ProjectionConnectionBinding[],
  ): void {
    for (const binding of bindings) {
      const accountRow = this.ctx.storage.sql
        .exec<ConnectionBindingRow>(
          "SELECT account_id, connection_id, identity_id, platform FROM connection_bindings WHERE account_id = ?",
          binding.account_id,
        )
        .toArray()[0];
      const connectionRow = this.ctx.storage.sql
        .exec<ConnectionBindingRow>(
          "SELECT account_id, connection_id, identity_id, platform FROM connection_bindings WHERE connection_id = ?",
          binding.connection_id,
        )
        .toArray()[0];

      if (accountRow !== undefined) {
        if (
          accountRow.connection_id !== binding.connection_id ||
          accountRow.identity_id !== binding.identity_id ||
          accountRow.platform !== binding.platform
        ) {
          throw projectionError("projection_conflict");
        }
      }
      if (
        connectionRow !== undefined &&
        (connectionRow.account_id !== binding.account_id ||
          connectionRow.connection_id !== binding.connection_id ||
          connectionRow.identity_id !== binding.identity_id ||
          connectionRow.platform !== binding.platform)
      ) {
        throw projectionError("projection_conflict");
      }
      if (accountRow === undefined && connectionRow === undefined) {
        this.ctx.storage.sql.exec(
          "INSERT INTO connection_bindings (account_id, connection_id, identity_id, platform) VALUES (?, ?, ?, ?)",
          binding.account_id,
          binding.connection_id,
          binding.identity_id,
          binding.platform,
        );
      }
    }
  }

  #readAppliedEvents(
    events: readonly PreparedProjectionEvent[],
  ): Map<string, AppliedEventRow> {
    const result = new Map<string, AppliedEventRow>();
    const chunkSize = 90;
    for (let offset = 0; offset < events.length; offset += chunkSize) {
      const chunk = events.slice(offset, offset + chunkSize);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.ctx.storage.sql
        .exec<AppliedEventRow>(
          `SELECT event_id, event_hash, event_type, event_source, identity_id, account_id, connection_id, conversation_id, occurred_at, observed_at, observed_ms, generation FROM applied_events WHERE event_id IN (${placeholders})`,
          ...chunk.map((event) => event.event.event_id),
        )
        .toArray();
      for (const row of rows) result.set(row.event_id, row);
    }
    return result;
  }

  #assertStoredEventMatches(
    stored: AppliedEventRow,
    prepared: PreparedProjectionEvent,
  ): void {
    const event = prepared.event;
    if (
      stored.event_hash !== prepared.eventHash ||
      stored.event_type !== event.event_type ||
      stored.event_source !== event.event_source ||
      stored.identity_id !== event.identity_id ||
      stored.account_id !== event.account_id ||
      stored.connection_id !== prepared.connection.connection_id ||
      stored.conversation_id !== event.conversation_id ||
      stored.occurred_at !== event.occurred_at ||
      stored.observed_at !== event.observed_at ||
      stored.observed_ms !== prepared.observedMs
    ) {
      throw projectionError("projection_conflict");
    }
  }

  #readLastSequence(): number {
    const row = this.ctx.storage.sql
      .exec<{ last_sequence: number }>(
        "SELECT COALESCE(MAX(sequence), 0) AS last_sequence FROM projection_changes",
      )
      .toArray()[0];
    if (row === undefined) throw new Error("projection sequence is missing");
    return row.last_sequence;
  }

  #trimProjectionChanges(): void {
    const boundary = this.ctx.storage.sql
      .exec<{ sequence: number }>(
        `SELECT sequence FROM projection_changes ORDER BY sequence DESC LIMIT 1 OFFSET ${MAX_PROJECTION_CHANGES}`,
      )
      .toArray()[0];
    if (boundary === undefined) return;

    const affectedIdentities = this.ctx.storage.sql
      .exec<ProjectionChangeFloorRow>(
        "SELECT identity_id, MAX(sequence) AS discarded_through_sequence FROM projection_changes WHERE sequence <= ? GROUP BY identity_id",
        boundary.sequence,
      )
      .toArray();
    for (const row of affectedIdentities) {
      const existing = this.ctx.storage.sql
        .exec<ProjectionChangeFloorRow>(
          "SELECT identity_id, discarded_through_sequence FROM projection_change_floors WHERE identity_id = ?",
          row.identity_id,
        )
        .toArray()[0];
      if (existing === undefined) {
        this.ctx.storage.sql.exec(
          "INSERT INTO projection_change_floors (identity_id, discarded_through_sequence) VALUES (?, ?)",
          row.identity_id,
          row.discarded_through_sequence,
        );
      } else if (
        row.discarded_through_sequence > existing.discarded_through_sequence
      ) {
        this.ctx.storage.sql.exec(
          "UPDATE projection_change_floors SET discarded_through_sequence = ? WHERE identity_id = ?",
          row.discarded_through_sequence,
          row.identity_id,
        );
      }
    }
    this.ctx.storage.sql.exec(
      "DELETE FROM projection_changes WHERE sequence <= ?",
      boundary.sequence,
    );
  }

  #applyLiveCheckpoint(
    checkpoint: PreparedCheckpointMutation | null,
    meta: ProjectionMetaRow,
    lastSequence: number,
  ): void {
    if (checkpoint === null) return;
    const existing = this.ctx.storage.sql
      .exec<ProjectionCheckpointStorageRow>(
        "SELECT kind, value, updated_at, last_observed_at, last_observed_ms, last_event_id, source_cursor, page_digest, generation, last_applied_count, last_duplicate_count, last_sequence FROM projection_checkpoints WHERE kind = ?",
        checkpoint.kind,
      )
      .toArray()[0];

    if (existing === undefined) {
      this.ctx.storage.sql.exec(
        "INSERT INTO projection_checkpoints (kind, value, source_cursor, page_digest, last_observed_at, last_observed_ms, last_event_id, generation, updated_at, last_applied_count, last_duplicate_count, last_sequence) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL, ?)",
        checkpoint.kind,
        checkpoint.value,
        checkpoint.lastObservedAt,
        checkpoint.lastObservedMs,
        checkpoint.lastEventId,
        meta.generation,
        checkpoint.lastObservedAt,
        lastSequence,
      );
      return;
    }

    if (existing.last_observed_ms === null || existing.last_event_id === null) {
      throw projectionError("projection_conflict");
    }
    const incomingIsNewer =
      checkpoint.lastObservedMs > existing.last_observed_ms ||
      (checkpoint.lastObservedMs === existing.last_observed_ms &&
        compareOpaqueEventIds(
          checkpoint.lastEventId,
          existing.last_event_id,
        ) > 0);
    const incomingIsEqual =
      checkpoint.lastObservedMs === existing.last_observed_ms &&
      compareOpaqueEventIds(
        checkpoint.lastEventId,
        existing.last_event_id,
      ) === 0;

    if (incomingIsEqual) {
      if (
        existing.value !== checkpoint.value ||
        existing.last_observed_at !== checkpoint.lastObservedAt
      ) {
        throw projectionError("projection_conflict");
      }
      return;
    }
    if (!incomingIsNewer) return;

    this.ctx.storage.sql.exec(
      "UPDATE projection_checkpoints SET value = ?, source_cursor = NULL, page_digest = NULL, last_observed_at = ?, last_observed_ms = ?, last_event_id = ?, generation = ?, updated_at = ?, last_applied_count = NULL, last_duplicate_count = NULL, last_sequence = ? WHERE kind = ?",
      checkpoint.value,
      checkpoint.lastObservedAt,
      checkpoint.lastObservedMs,
      checkpoint.lastEventId,
      meta.generation,
      checkpoint.lastObservedAt,
      lastSequence,
      checkpoint.kind,
    );
  }

}
