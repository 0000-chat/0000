import {
  AcceptTextReplyInputSchema,
  AcceptTextReplyResultSchema,
  OutboundDecisionInputSchema,
  OutboundDecisionResultSchema,
  OutboundReconcileInputSchema,
  ListOutboundCommandsInputSchema,
  ApplyProjectionBatchInputSchema,
  ApplyReplayPageInputSchema,
  compareOpaqueEventIds,
  ConversationPageResultSchema,
  CommandSchema,
  ConversationOwnerSchema,
  GetProjectionConversationInputSchema,
  GetProjectionConversationResultSchema,
  GetProjectionAttachmentInputSchema,
  GetProjectionAttachmentResultSchema,
  ProjectionAttachmentSchema,
  ListProjectionAttachmentsInputSchema,
  ListProjectionAttachmentsResultSchema,
  ResolveConversationOwnerInputSchema,
  DEFAULT_PROJECTION_PAGE_SIZE,
  ListProjectionChannelStatsInputSchema,
  MAX_PROJECTION_CHANGES,
  MAX_PROJECTION_BATCH_BYTES,
  MAX_PROJECTION_BATCH_EVENTS,
  ListProjectionChangesInputSchema,
  ListProjectionConversationsInputSchema,
  ListProjectionMessageSearchInputSchema,
  ListProjectionMessagesInputSchema,
  MessageSearchPageResultSchema,
  MessageSearchResultSchema,
  MessagePageResultSchema,
  MessageSchema,
  OutboundDispatchSchema,
  MAX_IDENTITY_CONNECTIONS,
  MAX_PROJECTION_PAGE_SIZE,
  MAX_REALTIME_ATTACHMENT_JSON_BYTES,
  MAX_REALTIME_REPLAY_CHANGES,
  MAX_REALTIME_SOCKETS_PER_PRINCIPAL,
  MAX_REALTIME_SOCKETS_PER_TENANT,
  REALTIME_SUBPROTOCOL,
  REALTIME_TICKET_TTL_MS,
  RealtimeConnectedFrameSchema,
  RealtimePositionSchema,
  RealtimeResetRequiredFrameSchema,
  type RealtimePosition,
  type RealtimeProjectionChange,
  type RealtimeResetRequiredFrame,
  ProjectionChangePageSchema,
  ProjectionChannelStatsSchema,
  type ApplyProjectionBatchInput,
  type ApplyProjectionBatchResult,
  type AcceptTextReplyInput,
  type AcceptTextReplyResult,
  type ApplyReplayPageInput,
  type ArchiveReplayPage,
  type ConversationSummary,
  type ConversationOwner,
  type ConversationPageResult,
  type GetProjectionConversationInput,
  type GetProjectionAttachmentInput,
  type ProjectionAttachment,
  type ListProjectionAttachmentsInput,
  type ListProjectionChannelStatsInput,
  AbortRebuildInputSchema,
  BeginRebuildInputSchema,
  CompleteRebuildInputSchema,
  type AbortRebuildInput,
  type BeginRebuildInput,
  type CompleteRebuildInput,
  InitializeProjectionInputSchema,
  type ListProjectionChangesInput,
  type ListProjectionConversationsInput,
  type ListProjectionMessageSearchInput,
  type ListProjectionMessagesInput,
  type MessageSearchPageResult,
  type MessageSearchResult,
  type MessagePageResult,
  type Command,
  type ResolveConversationOwnerInput,
  type OutboundDispatch,
  type OutboundDecisionInput,
  type OutboundDecisionResult,
  type OutboundReconcileInput,
  type ListOutboundCommandsInput,
  type ProjectionChannelStat,
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
import { canonicalObservedAt } from "./projector-common";
import { runProjectionMigrations } from "./schema";
import {
  decodeConversationCursor,
  decodeMessageCursor,
  decodeMessageSearchCursor,
  encodeConversationCursor,
  encodeMessageCursor,
  encodeMessageSearchCursor,
  type MessageSearchCursorContext,
} from "./cursor";
import {
  REALTIME_CONTEXT_HEADER,
  REALTIME_INTERNAL_HOST,
  REALTIME_INTERNAL_PATH,
  REALTIME_SOCKET_TAG,
  batchRealtimeChanges,
  broadcastRealtimeChanges,
  countPrincipalSockets,
  nextSocketExpiry,
  readRealtimeReplay,
  realtimeConnectionExpiry,
  resetRealtimeSocketsForRebuild,
  serializeSafeRealtimeAttachment,
  sendRealtimeFrame,
  type RealtimeBroadcastChange,
  type RealtimeReplayRow,
  tryParseRealtimeAttachment,
} from "../realtime/tenant-sockets";
import {
  logRealtimeSocketOutcome,
  realtimeSocketLoggerFromEnv,
  type RealtimeSocketOutcome,
} from "../realtime/telemetry";
import {
  parseRealtimeUpgradeContext,
  type RealtimeSocketAttachment,
  type RealtimeUpgradeContext,
} from "../realtime/contracts";
import { revalidateRealtimeSocketAuthorization } from "../realtime/authorization";
import { transitionOutboundLifecycle } from "../outbound/lifecycle";

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

type AppliedPreparedBatch = {
  readonly result: ApplyProjectionBatchResult;
  readonly changes: readonly RealtimeBroadcastChange[];
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
  account_id: string;
  connection_id: string;
  title: string;
  last_message_preview: string;
  last_activity_at: string;
  last_activity_ms: number;
  unread_count: number;
  last_event_id: string;
};

type ChannelStatQueryRow = {
  connection_id: string;
  unread_count: number;
  last_activity_at: string | null;
};

type MessageQueryRow = {
  id: string;
  identity_id: string;
  account_id: string;
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
  current_event_id: string;
  sender_participant_id: string | null;
};

type MessageSearchQueryRow = MessageQueryRow & {
  contact_id: string | null;
  edited_at: string | null;
  deletion_reason: string | null;
};

type MessageSearchAttachmentQueryRow = {
  id: string;
  message_id: string;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
};

type ProjectionAttachmentQueryRow = {
  id: string;
  message_id: string;
  identity_id: string;
  account_id: string;
  connection_id: string;
  conversation_id: string;
  platform: string;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  r2_key: string | null;
  last_event_id: string;
  expires_at: string | null;
  deleted_at: string | null;
};

type ConversationOwnerRow = {
  identity_id: string;
  account_id: string;
  connection_id: string;
  platform: string;
  deleted_at?: string | null;
};

type OutboundDispatchRow = {
  id: string;
  command_id: string;
  message_id: string;
  event_id: string;
  tenant_id: string;
  actor_principal_id: string;
  actor_identity_id: string;
  resource_identity_id: string;
  account_id: string;
  connection_id: string;
  conversation_id: string;
  platform: string;
  idempotency_key: string;
  body_digest: string;
  body: string;
  delivery_mode: "direct" | "paced";
  status:
    | "pending"
    | "waiting_for_connection"
    | "confirmation_required"
    | "wakeup_failed"
    | "dispatching"
    | "dispatched"
    | "cancelled";
  confirmation_due_at: string | null;
  confirmation_decision: "confirm" | "cancel" | null;
  confirmation_actor_principal_id: string | null;
  confirmation_actor_identity_id: string | null;
  confirmation_decided_at: string | null;
  created_at: string;
  updated_at: string;
};

type OutboundDecisionRow = {
  id: string;
  tenant_id: string;
  command_id: string;
  dispatch_id: string;
  decision: "confirm" | "cancel";
  idempotency_key: string;
  actor_principal_id: string;
  actor_identity_id: string;
  decided_at: string;
};

type OutboundCommandRow = {
  id: string;
  identity_id: string;
  account_id: string;
  connection_id: string;
  conversation_id: string;
  platform: string;
  operation: "message.send";
  delivery_mode: "direct" | "paced";
  status: Command["status"];
  failure_code: string | null;
  created_at: string;
  updated_at: string;
};

type ConversationExistsRow = { id: string };

type ProjectionChangeQueryRow = {
  identity_sequence: number;
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
 * These receive-side rows are derived from the immutable archive or live
 * events. The outbound dispatch ledger is authoritative acceptance state and
 * deliberately survives a rebuild; its message and command views are
 * reconstituted after replay.
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
  "projection_identity_sequences",
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

const parseReplayCursor = (cursor: string | null, tenantId: string): void => {
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

type ProjectionScopeFilter = {
  readonly sql: string;
  readonly bindings: readonly string[];
};

/**
 * Turn the server-resolved account/chat grant into a parameterized SQLite
 * predicate. Omitted account fields retain the projection's legacy internal
 * identity-only contract; an explicit empty list fails closed.
 */
const accountScopeFilter = (
  authorization: ProjectionAuthorizationContext,
  accountColumn: string,
  conversationColumn: string,
  accountId?: string,
): ProjectionScopeFilter => {
  const accountFilter =
    accountId === undefined
      ? { sql: "", bindings: [] as string[] }
      : { sql: ` AND ${accountColumn} = ?`, bindings: [accountId] };
  const accountIds = authorization.allowed_account_ids;
  if (accountIds === undefined) return accountFilter;

  const allAccountIds = authorization.allowed_all_account_ids ?? [];
  const selectedAccountIds = accountIds.filter(
    (accountId) => !allAccountIds.includes(accountId),
  );
  const conversationIds = authorization.allowed_conversation_ids ?? [];
  const clauses: string[] = [];
  const bindings: string[] = [];
  if (allAccountIds.length > 0) {
    clauses.push(
      `${accountColumn} IN (${allAccountIds.map(() => "?").join(",")})`,
    );
    bindings.push(...allAccountIds);
  }
  if (selectedAccountIds.length > 0 && conversationIds.length > 0) {
    clauses.push(
      `(${accountColumn} IN (${selectedAccountIds.map(() => "?").join(",")}) AND ${conversationColumn} IN (${conversationIds.map(() => "?").join(",")}))`,
    );
    bindings.push(...selectedAccountIds, ...conversationIds);
  }
  if (clauses.length === 0) {
    return {
      sql: `${accountFilter.sql} AND 1 = 0`,
      bindings: accountFilter.bindings,
    };
  }
  return {
    sql: `${accountFilter.sql} AND (${clauses.join(" OR ")})`,
    bindings: [...accountFilter.bindings, ...bindings],
  };
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
      "SELECT (SELECT COUNT(*) FROM applied_events) AS applied_event_count, (SELECT COUNT(*) FROM conversations) AS conversation_count, (SELECT COUNT(*) FROM messages) AS message_count, COALESCE((SELECT MAX(latest_sequence) FROM projection_identity_sequences), 0) AS latest_change_sequence",
    )
    .toArray()[0];
  if (counts === undefined)
    throw new Error("projection status counts are missing");

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
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
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
    if (
      !Array.isArray(events) ||
      Object.getPrototypeOf(events) !== Array.prototype
    ) {
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
    if (
      !Array.isArray(events) ||
      Object.getPrototypeOf(events) !== Array.prototype
    ) {
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

const isSafeNonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const mapConversationSummary = (
  tenantId: string,
  row: ConversationQueryRow,
) => {
  const lastActivityMs = parseStoredMilliseconds(row.last_activity_at);
  if (lastActivityMs !== row.last_activity_ms) {
    throw new Error("projection conversation activity tuple is inconsistent");
  }
  if (!isSafeNonnegativeInteger(row.unread_count)) {
    throw new Error("projection conversation unread count is invalid");
  }

  return {
    id: row.id,
    tenant_id: tenantId,
    identity_id: row.identity_id,
    account_id: row.account_id,
    connection_id: row.connection_id,
    event_id: row.last_event_id,
    title: row.title,
    last_message_preview: row.last_message_preview,
    last_activity_at: row.last_activity_at,
    unread_count: row.unread_count,
  } satisfies ConversationSummary;
};

const mapChannelStats = (
  rows: readonly ChannelStatQueryRow[],
): ProjectionChannelStat[] => {
  if (rows.length > MAX_IDENTITY_CONNECTIONS) {
    throw projectionError("projection_too_large");
  }

  return ProjectionChannelStatsSchema.parse(
    rows.map((row) => {
      if (!isSafeNonnegativeInteger(row.unread_count)) {
        throw new Error("projection channel unread count is invalid");
      }
      return {
        connection_id: row.connection_id,
        unread_count: row.unread_count,
        last_activity_at: row.last_activity_at,
      };
    }),
  );
};

const readConversationRows = (
  storage: DurableObjectStorage,
  input: ListProjectionConversationsInput,
  generation: number,
): ConversationQueryRow[] => {
  const pageSize = input.page_size ?? DEFAULT_PROJECTION_PAGE_SIZE;
  const cursor =
    input.cursor === undefined
      ? undefined
      : decodeConversationCursor(input.cursor, {
          tenant_id: input.tenant_id,
          identity_id: input.identity_id,
          connection_id: input.connection_id,
          generation,
        });
  const limit = pageSize + 1;
  const scope = accountScopeFilter(
    input.authorization,
    "account_id",
    "id",
    input.account_id,
  );

  if (input.connection_id === null) {
    if (cursor === undefined) {
      return storage.sql
        .exec<ConversationQueryRow>(
          `SELECT id, identity_id, account_id, connection_id, title, last_message_preview, last_activity_at, last_activity_ms, unread_count, last_event_id FROM conversations WHERE identity_id = ? AND deleted_at IS NULL${scope.sql} ORDER BY last_activity_ms DESC, id ASC LIMIT ?`,
          input.identity_id,
          ...scope.bindings,
          limit,
        )
        .toArray();
    }
    return storage.sql
      .exec<ConversationQueryRow>(
        `SELECT id, identity_id, account_id, connection_id, title, last_message_preview, last_activity_at, last_activity_ms, unread_count, last_event_id FROM conversations WHERE identity_id = ? AND deleted_at IS NULL${scope.sql} AND (last_activity_ms < ? OR (last_activity_ms = ? AND id > ?)) ORDER BY last_activity_ms DESC, id ASC LIMIT ?`,
        input.identity_id,
        ...scope.bindings,
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
        `SELECT id, identity_id, account_id, connection_id, title, last_message_preview, last_activity_at, last_activity_ms, unread_count, last_event_id FROM conversations WHERE identity_id = ? AND connection_id = ? AND deleted_at IS NULL${scope.sql} ORDER BY last_activity_ms DESC, id ASC LIMIT ?`,
        input.identity_id,
        input.connection_id,
        ...scope.bindings,
        limit,
      )
      .toArray();
  }
  return storage.sql
    .exec<ConversationQueryRow>(
      `SELECT id, identity_id, account_id, connection_id, title, last_message_preview, last_activity_at, last_activity_ms, unread_count, last_event_id FROM conversations WHERE identity_id = ? AND connection_id = ? AND deleted_at IS NULL${scope.sql} AND (last_activity_ms < ? OR (last_activity_ms = ? AND id > ?)) ORDER BY last_activity_ms DESC, id ASC LIMIT ?`,
      input.identity_id,
      input.connection_id,
      ...scope.bindings,
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
      account_id: row.account_id,
      connection_id: row.connection_id,
      event_id: row.last_event_id,
      title: row.title,
      last_message_preview: row.last_message_preview,
      last_activity_at: row.last_activity_at,
      unread_count: row.unread_count,
    };
  });
  const last = visibleRows.at(-1);
  const nextCursor =
    hasNext && last !== undefined
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
  const cursor =
    input.cursor === undefined
      ? undefined
      : decodeMessageCursor(input.cursor, {
          tenant_id: input.tenant_id,
          identity_id: input.identity_id,
          conversation_id: input.conversation_id,
          generation,
        });
  const limit = pageSize + 1;
  const scope = accountScopeFilter(
    input.authorization,
    "account_id",
    "conversation_id",
    input.account_id,
  );
  if (input.message_id !== undefined) {
    return storage.sql
      .exec<MessageQueryRow>(
        `SELECT id, identity_id, account_id, connection_id, conversation_id, direction, sender_participant_id, sender_label, body, occurred_at, occurred_ms, delivery_status, attachment_count, deleted_at, current_event_id FROM messages WHERE identity_id = ? AND conversation_id = ? AND id = ?${scope.sql} LIMIT 1`,
        input.identity_id,
        input.conversation_id,
        input.message_id,
        ...scope.bindings,
      )
      .toArray();
  }
  if (cursor === undefined) {
    return storage.sql
      .exec<MessageQueryRow>(
        `SELECT id, identity_id, account_id, connection_id, conversation_id, direction, sender_participant_id, sender_label, body, occurred_at, occurred_ms, delivery_status, attachment_count, deleted_at, current_event_id FROM messages WHERE identity_id = ? AND conversation_id = ?${scope.sql} ORDER BY occurred_ms DESC, id ASC LIMIT ?`,
        input.identity_id,
        input.conversation_id,
        ...scope.bindings,
        limit,
      )
      .toArray();
  }
  return storage.sql
    .exec<MessageQueryRow>(
      `SELECT id, identity_id, account_id, connection_id, conversation_id, direction, sender_participant_id, sender_label, body, occurred_at, occurred_ms, delivery_status, attachment_count, deleted_at, current_event_id FROM messages WHERE identity_id = ? AND conversation_id = ?${scope.sql} AND (occurred_ms < ? OR (occurred_ms = ? AND id > ?)) ORDER BY occurred_ms DESC, id ASC LIMIT ?`,
      input.identity_id,
      input.conversation_id,
      ...scope.bindings,
      cursor.last_occurred_ms,
      cursor.last_occurred_ms,
      cursor.last_id,
      limit,
    )
    .toArray();
};

const mapProjectionAttachment = (
  row: ProjectionAttachmentQueryRow,
): ProjectionAttachment =>
  ProjectionAttachmentSchema.parse({
    attachment_id: row.id,
    message_id: row.message_id,
    identity_id: row.identity_id,
    account_id: row.account_id,
    connection_id: row.connection_id,
    conversation_id: row.conversation_id,
    platform: row.platform,
    file_name: row.file_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    sha256: row.sha256,
    media_key: row.r2_key,
    revision: row.last_event_id,
    expires_at: row.expires_at,
    deleted_at: row.deleted_at,
  });

const attachmentSelect =
  "SELECT attachments.id, attachments.message_id, attachments.identity_id, attachments.account_id, attachments.connection_id, attachments.conversation_id, attachments.platform, attachments.file_name, attachments.mime_type, attachments.size_bytes, attachments.sha256, attachments.r2_key, attachments.last_event_id, attachments.expires_at, attachments.deleted_at FROM attachments";

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
      account_id: row.account_id,
      connection_id: row.connection_id,
      conversation_id: row.conversation_id,
      event_id: row.current_event_id,
      sender_participant_id: row.sender_participant_id,
      direction: row.direction,
      sender_label: redacted ? "Deleted sender" : row.sender_label,
      body: redacted ? "" : row.body,
      occurred_at: row.occurred_at,
      delivery_status: row.delivery_status,
      attachment_count: redacted ? 0 : row.attachment_count,
      attachments: [],
    };
  });
  const last = visibleRows.at(-1);
  const nextCursor =
    hasNext && last !== undefined
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

const escapeSearchLikeTerm = (term: string): string =>
  term.replace(/[\\%_]/gu, (character) => `\\${character}`);

const messageSearchTerms = (text: string | undefined): string[] =>
  text === undefined
    ? []
    : text
        .split(/\s+/u)
        .map((term) => term.toLocaleLowerCase())
        .filter((term) => term.length > 0);

const searchCursorContext = (
  input: ListProjectionMessageSearchInput,
  generation: number,
): MessageSearchCursorContext => ({
  tenant_id: input.tenant_id,
  identity_id: input.identity_id,
  account_id: input.account_id ?? null,
  conversation_id: input.conversation_id ?? null,
  text: input.text ?? null,
  contact: input.contact ?? null,
  from: input.from ?? null,
  to: input.to ?? null,
  direction: input.direction ?? null,
  generation,
});

const readMessageSearchRows = (
  storage: DurableObjectStorage,
  input: ListProjectionMessageSearchInput,
  generation: number,
): MessageSearchQueryRow[] => {
  const pageSize = input.page_size ?? DEFAULT_PROJECTION_PAGE_SIZE;
  const cursor =
    input.cursor === undefined
      ? undefined
      : decodeMessageSearchCursor(
          input.cursor,
          searchCursorContext(input, generation),
        );
  const predicates = ["messages.identity_id = ?"];
  const bindings: Array<string | number> = [input.identity_id];
  const selectBindings: Array<string | number> = [];
  let contactSelection = "messages.sender_participant_id AS contact_id";
  const scope = accountScopeFilter(
    input.authorization,
    "messages.account_id",
    "messages.conversation_id",
    input.account_id,
  );
  if (scope.sql.length > 0) {
    predicates.push(scope.sql.replace(/^ AND /u, ""));
    bindings.push(...scope.bindings);
  }
  if (input.conversation_id !== undefined) {
    predicates.push("messages.conversation_id = ?");
    bindings.push(input.conversation_id);
  }
  for (const term of messageSearchTerms(input.text)) {
    predicates.push("LOWER(messages.body) LIKE ? ESCAPE '\\'");
    bindings.push(`%${escapeSearchLikeTerm(term)}%`);
  }
  if (input.contact !== undefined) {
    const pattern = `%${escapeSearchLikeTerm(input.contact.toLocaleLowerCase())}%`;
    contactSelection =
      "COALESCE(messages.sender_participant_id, (SELECT search_contact.id FROM participants AS search_contact WHERE search_contact.identity_id = messages.identity_id AND search_contact.account_id = messages.account_id AND search_contact.connection_id = messages.connection_id AND search_contact.conversation_id = messages.conversation_id AND search_contact.deleted_at IS NULL AND (LOWER(search_contact.display_name) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(search_contact.remote_id, '')) LIKE ? ESCAPE '\\') ORDER BY search_contact.id ASC LIMIT 1)) AS contact_id";
    selectBindings.push(pattern, pattern);
    predicates.push(
      "(LOWER(messages.sender_label) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM participants AS search_participant WHERE search_participant.identity_id = messages.identity_id AND search_participant.account_id = messages.account_id AND search_participant.connection_id = messages.connection_id AND search_participant.conversation_id = messages.conversation_id AND search_participant.deleted_at IS NULL AND (LOWER(search_participant.display_name) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(search_participant.remote_id, '')) LIKE ? ESCAPE '\\')))",
    );
    bindings.push(pattern, pattern, pattern);
  }
  if (input.from !== undefined) {
    predicates.push("messages.occurred_ms >= ?");
    bindings.push(parseStoredMilliseconds(input.from));
  }
  if (input.to !== undefined) {
    predicates.push("messages.occurred_ms <= ?");
    bindings.push(parseStoredMilliseconds(input.to));
  }
  if (input.direction !== undefined) {
    predicates.push("messages.direction = ?");
    bindings.push(input.direction);
  }
  if (cursor !== undefined) {
    predicates.push(
      "(messages.occurred_ms < ? OR (messages.occurred_ms = ? AND messages.id > ?))",
    );
    bindings.push(
      cursor.last_occurred_ms,
      cursor.last_occurred_ms,
      cursor.last_id,
    );
  }

  return storage.sql
    .exec<MessageSearchQueryRow>(
      `SELECT messages.id, messages.identity_id, messages.account_id, messages.connection_id, messages.conversation_id, messages.direction, messages.sender_label, messages.body, messages.occurred_at, messages.occurred_ms, messages.delivery_status, messages.attachment_count, messages.deleted_at, messages.current_event_id, ${contactSelection}, messages.edited_at, messages.deletion_reason FROM messages WHERE ${predicates.join(" AND ")} ORDER BY messages.occurred_ms DESC, messages.id ASC LIMIT ?`,
      ...selectBindings,
      ...bindings,
      pageSize + 1,
    )
    .toArray();
};

const readMessageSearchAttachments = (
  storage: DurableObjectStorage,
  rows: readonly MessageSearchQueryRow[],
): Map<string, MessageSearchAttachmentQueryRow[]> => {
  const messageIds = rows.map((row) => row.id);
  const attachmentsByMessage = new Map<
    string,
    MessageSearchAttachmentQueryRow[]
  >();
  if (messageIds.length === 0) return attachmentsByMessage;

  const attachments = storage.sql
    .exec<MessageSearchAttachmentQueryRow>(
      `SELECT attachments.id, attachments.message_id, attachments.file_name, attachments.mime_type, attachments.size_bytes, attachments.sha256 FROM attachments JOIN messages ON messages.id = attachments.message_id AND messages.identity_id = attachments.identity_id AND messages.account_id = attachments.account_id AND messages.connection_id = attachments.connection_id AND messages.conversation_id = attachments.conversation_id WHERE attachments.message_id IN (${messageIds.map(() => "?").join(",")}) AND attachments.deleted_at IS NULL ORDER BY attachments.message_id ASC, attachments.id ASC`,
      ...messageIds,
    )
    .toArray();
  for (const attachment of attachments) {
    const current = attachmentsByMessage.get(attachment.message_id) ?? [];
    current.push(attachment);
    if (current.length > 500) {
      throw projectionError("projection_too_large");
    }
    attachmentsByMessage.set(attachment.message_id, current);
  }
  return attachmentsByMessage;
};

const mapMessageSearchPage = (
  tenantId: string,
  generation: number,
  input: ListProjectionMessageSearchInput,
  rows: readonly MessageSearchQueryRow[],
  attachmentsByMessage: ReadonlyMap<
    string,
    readonly MessageSearchAttachmentQueryRow[]
  >,
): MessageSearchPageResult => {
  const pageSize = input.page_size ?? DEFAULT_PROJECTION_PAGE_SIZE;
  const hasNext = rows.length > pageSize;
  const visibleRows = rows.slice(0, pageSize);
  const items: MessageSearchResult[] = visibleRows.map((row) => {
    const occurredMs = parseStoredMilliseconds(row.occurred_at);
    if (occurredMs !== row.occurred_ms) {
      throw new Error("projection message occurrence tuple is inconsistent");
    }
    const removed = row.deleted_at !== null;
    if (row.edited_at !== null) parseStoredMilliseconds(row.edited_at);
    if (row.deleted_at !== null) parseStoredMilliseconds(row.deleted_at);
    if (!isSafeNonnegativeInteger(row.attachment_count)) {
      throw new Error("projection message attachment count is invalid");
    }
    const attachments = removed
      ? []
      : (attachmentsByMessage.get(row.id) ?? []).map((attachment) => ({
          id: attachment.id,
          file_name: attachment.file_name,
          mime_type: attachment.mime_type,
          size_bytes: attachment.size_bytes,
          sha256: attachment.sha256,
        }));
    return MessageSearchResultSchema.parse({
      id: row.id,
      tenant_id: tenantId,
      identity_id: row.identity_id,
      account_id: row.account_id,
      connection_id: row.connection_id,
      conversation_id: row.conversation_id,
      contact_id: removed ? null : row.contact_id,
      event_id: row.current_event_id,
      revision: row.current_event_id,
      direction: row.direction,
      sender_label: removed ? "Deleted sender" : row.sender_label,
      body: removed ? "" : row.body,
      occurred_at: row.occurred_at,
      edited_at: removed ? null : row.edited_at,
      attachment_count: removed ? 0 : row.attachment_count,
      attachments,
      removed,
      removed_at: row.deleted_at,
      removal_reason: row.deletion_reason,
      delivery_status: row.delivery_status,
    });
  });
  const last = visibleRows.at(-1);
  const nextCursor =
    hasNext && last !== undefined
      ? encodeMessageSearchCursor({
          schema_version: 1,
          query_kind: "projection.message_search",
          ...searchCursorContext(input, generation),
          last_occurred_ms: parseStoredMilliseconds(last.occurred_at),
          last_id: last.id,
        })
      : null;
  return MessageSearchPageResultSchema.parse({
    items,
    next_cursor: nextCursor,
  });
};

const readOutboundDispatchByKey = (
  storage: DurableObjectStorage,
  idempotencyKey: string,
): OutboundDispatchRow | undefined =>
  storage.sql
    .exec<OutboundDispatchRow>(
      "SELECT id, command_id, message_id, event_id, tenant_id, actor_principal_id, actor_identity_id, resource_identity_id, account_id, connection_id, conversation_id, platform, idempotency_key, body_digest, body, delivery_mode, status, confirmation_due_at, confirmation_decision, confirmation_actor_principal_id, confirmation_actor_identity_id, confirmation_decided_at, created_at, updated_at FROM outbound_dispatches WHERE idempotency_key = ? LIMIT 1",
      idempotencyKey,
    )
    .toArray()[0];

const readOutboundDispatchByCommand = (
  storage: DurableObjectStorage,
  commandId: string,
): OutboundDispatchRow | undefined =>
  storage.sql
    .exec<OutboundDispatchRow>(
      "SELECT id, command_id, message_id, event_id, tenant_id, actor_principal_id, actor_identity_id, resource_identity_id, account_id, connection_id, conversation_id, platform, idempotency_key, body_digest, body, delivery_mode, status, confirmation_due_at, confirmation_decision, confirmation_actor_principal_id, confirmation_actor_identity_id, confirmation_decided_at, created_at, updated_at FROM outbound_dispatches WHERE command_id = ? LIMIT 1",
      commandId,
    )
    .toArray()[0];

const readOutboundDecisionByCommand = (
  storage: DurableObjectStorage,
  commandId: string,
): OutboundDecisionRow | undefined =>
  storage.sql
    .exec<OutboundDecisionRow>(
      "SELECT id, tenant_id, command_id, dispatch_id, decision, idempotency_key, actor_principal_id, actor_identity_id, decided_at FROM outbound_command_decisions WHERE command_id = ? LIMIT 1",
      commandId,
    )
    .toArray()[0];

const readOutboundCommand = (
  storage: DurableObjectStorage,
  commandId: string,
): OutboundCommandRow | undefined =>
  storage.sql
    .exec<OutboundCommandRow>(
      "SELECT id, identity_id, account_id, connection_id, conversation_id, platform, operation, delivery_mode, status, failure_code, created_at, updated_at FROM commands WHERE id = ? LIMIT 1",
      commandId,
    )
    .toArray()[0];

const readOutboundMessage = (
  storage: DurableObjectStorage,
  messageId: string,
): MessageQueryRow | undefined =>
  storage.sql
    .exec<MessageQueryRow>(
      "SELECT id, identity_id, account_id, connection_id, conversation_id, direction, sender_participant_id, sender_label, body, occurred_at, occurred_ms, delivery_status, attachment_count, deleted_at, current_event_id FROM messages WHERE id = ? LIMIT 1",
      messageId,
    )
    .toArray()[0];

const mapOutboundDispatch = (row: OutboundDispatchRow): OutboundDispatch =>
  OutboundDispatchSchema.parse({
    id: row.id,
    tenant_id: row.tenant_id,
    command_id: row.command_id,
    message_id: row.message_id,
    event_id: row.event_id,
    actor_principal_id: row.actor_principal_id,
    actor_identity_id: row.actor_identity_id,
    resource_identity_id: row.resource_identity_id,
    account_id: row.account_id,
    connection_id: row.connection_id,
    conversation_id: row.conversation_id,
    idempotency_key: row.idempotency_key,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    confirmation_due_at: row.confirmation_due_at,
    ...(row.confirmation_decision === null
      ? {}
      : { confirmation_decision: row.confirmation_decision }),
    ...(row.confirmation_actor_principal_id === null
      ? {}
      : {
          confirmation_actor_principal_id: row.confirmation_actor_principal_id,
        }),
    ...(row.confirmation_actor_identity_id === null
      ? {}
      : { confirmation_actor_identity_id: row.confirmation_actor_identity_id }),
    ...(row.confirmation_decided_at === null
      ? {}
      : { confirmation_decided_at: row.confirmation_decided_at }),
  });

const mapOutboundCommand = (
  tenantId: string,
  row: OutboundCommandRow,
  dispatch: OutboundDispatchRow,
): Command =>
  CommandSchema.parse({
    id: row.id,
    tenant_id: tenantId,
    identity_id: row.identity_id,
    conversation_id: row.conversation_id,
    operation: row.operation,
    delivery_mode: row.delivery_mode,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.failure_code === null ? {} : { failure_code: row.failure_code }),
    account_id: row.account_id,
    connection_id: row.connection_id,
    resource_identity_id: dispatch.resource_identity_id,
    message_id: dispatch.message_id,
    event_id: dispatch.event_id,
    dispatch_id: dispatch.id,
    actor_principal_id: dispatch.actor_principal_id,
    actor_identity_id: dispatch.actor_identity_id,
    ...(dispatch.confirmation_due_at === null
      ? {}
      : { confirmation_due_at: dispatch.confirmation_due_at }),
    ...(dispatch.confirmation_decision === null
      ? {}
      : { confirmation_decision: dispatch.confirmation_decision }),
    ...(dispatch.confirmation_actor_principal_id === null
      ? {}
      : {
          confirmation_actor_principal_id:
            dispatch.confirmation_actor_principal_id,
        }),
    ...(dispatch.confirmation_actor_identity_id === null
      ? {}
      : {
          confirmation_actor_identity_id:
            dispatch.confirmation_actor_identity_id,
        }),
    ...(dispatch.confirmation_decided_at === null
      ? {}
      : { confirmation_decided_at: dispatch.confirmation_decided_at }),
  });

const mapOutboundMessage = (tenantId: string, row: MessageQueryRow) =>
  MessageSchema.parse({
    id: row.id,
    tenant_id: tenantId,
    identity_id: row.identity_id,
    account_id: row.account_id,
    connection_id: row.connection_id,
    conversation_id: row.conversation_id,
    event_id: row.current_event_id,
    sender_participant_id: row.sender_participant_id,
    direction: row.direction,
    sender_label: row.deleted_at === null ? row.sender_label : "Deleted sender",
    body: row.deleted_at === null ? row.body : "",
    occurred_at: row.occurred_at,
    delivery_status: row.delivery_status,
    attachment_count: row.deleted_at === null ? row.attachment_count : 0,
    attachments: [],
  });

/**
 * Rebuilds discard receive-side rows, but accepted outbound work is already
 * authoritative. Restore its message and command views from the ledger before
 * the rebuild becomes readable again.
 */
const restoreOutboundProjectionRows = (
  storage: DurableObjectStorage,
  tenantId: string,
): void => {
  const ledgerRows = storage.sql
    .exec<OutboundDispatchRow>(
      "SELECT id, command_id, message_id, event_id, tenant_id, actor_principal_id, actor_identity_id, resource_identity_id, account_id, connection_id, conversation_id, platform, idempotency_key, body_digest, body, delivery_mode, status, confirmation_due_at, confirmation_decision, confirmation_actor_principal_id, confirmation_actor_identity_id, confirmation_decided_at, created_at, updated_at FROM outbound_dispatches WHERE tenant_id = ? ORDER BY created_at ASC, id ASC",
      tenantId,
    )
    .toArray();
  const touchedConversations = new Set<string>();

  for (const row of ledgerRows) {
    const owner = storage.sql
      .exec<ConversationOwnerRow>(
        "SELECT identity_id, account_id, connection_id, platform, deleted_at FROM conversations WHERE id = ? LIMIT 1",
        row.conversation_id,
      )
      .toArray()[0];
    if (
      owner === undefined ||
      owner.identity_id !== row.resource_identity_id ||
      owner.account_id !== row.account_id ||
      owner.connection_id !== row.connection_id ||
      owner.platform !== row.platform
    ) {
      throw projectionError("projection_conflict");
    }

    const tombstone = storage.sql
      .exec<{
        occurred_at: string;
        reason_code: string | null;
        observed_ms: number;
        tombstone_event_id: string;
      }>(
        "SELECT occurred_at, reason_code, observed_ms, tombstone_event_id FROM resource_tombstones WHERE (resource_type = 'message' AND resource_id = ?) OR (resource_type = 'conversation' AND resource_id = ?) ORDER BY observed_ms DESC, tombstone_event_id COLLATE BINARY DESC LIMIT 1",
        row.message_id,
        row.conversation_id,
      )
      .toArray()[0];

    const existingMessage = readOutboundMessage(storage, row.message_id);
    if (existingMessage === undefined) {
      const occurredMs = parseStoredMilliseconds(row.created_at);
      storage.sql.exec(
        "INSERT INTO messages (id, identity_id, account_id, connection_id, conversation_id, platform, direction, sender_participant_id, sender_label, body, reply_to_message_id, delivery_status, unread, local_read_at, occurred_at, occurred_ms, observed_at, current_observed_ms, current_event_id, matrix_room_id, matrix_event_id, remote_message_id, edited_at, deleted_at, deletion_reason, attachment_count, delivery_failure_code, delivery_observed_ms, delivery_event_id) VALUES (?, ?, ?, ?, ?, ?, 'outbound', NULL, ?, ?, NULL, 'accepted', 0, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 0, NULL, NULL, NULL)",
        row.message_id,
        row.resource_identity_id,
        row.account_id,
        row.connection_id,
        row.conversation_id,
        row.platform,
        tombstone === undefined ? "Communicator" : "Deleted sender",
        tombstone === undefined ? row.body : "",
        tombstone === undefined ? row.created_at : tombstone.occurred_at,
        tombstone === undefined
          ? occurredMs
          : parseStoredMilliseconds(tombstone.occurred_at),
        tombstone === undefined
          ? row.created_at
          : canonicalObservedAt(tombstone.observed_ms),
        tombstone === undefined ? occurredMs : tombstone.observed_ms,
        tombstone === undefined ? row.event_id : tombstone.tombstone_event_id,
        tombstone?.occurred_at ?? null,
        tombstone?.reason_code ?? null,
      );
    } else if (
      existingMessage.identity_id !== row.resource_identity_id ||
      existingMessage.account_id !== row.account_id ||
      existingMessage.connection_id !== row.connection_id ||
      existingMessage.conversation_id !== row.conversation_id ||
      existingMessage.direction !== "outbound"
    ) {
      throw projectionError("projection_conflict");
    }

    const existingCommand = readOutboundCommand(storage, row.command_id);
    if (existingCommand === undefined) {
      const observedMs = parseStoredMilliseconds(row.created_at);
      const restoredStatus =
        row.status === "waiting_for_connection" ||
        row.status === "confirmation_required" ||
        row.status === "cancelled"
          ? row.status
          : "accepted";
      storage.sql.exec(
        "INSERT INTO commands (id, identity_id, account_id, connection_id, conversation_id, platform, operation, delivery_mode, status, failure_code, created_at, updated_at, last_observed_ms, last_event_id) VALUES (?, ?, ?, ?, ?, ?, 'message.send', ?, ?, NULL, ?, ?, ?, ?)",
        row.command_id,
        row.actor_identity_id,
        row.account_id,
        row.connection_id,
        row.conversation_id,
        row.platform,
        row.delivery_mode,
        restoredStatus,
        row.created_at,
        row.updated_at,
        observedMs,
        row.event_id,
      );
    } else if (
      existingCommand.identity_id !== row.actor_identity_id ||
      existingCommand.account_id !== row.account_id ||
      existingCommand.connection_id !== row.connection_id ||
      existingCommand.conversation_id !== row.conversation_id ||
      existingCommand.platform !== row.platform ||
      existingCommand.operation !== "message.send" ||
      existingCommand.delivery_mode !== row.delivery_mode
    ) {
      throw projectionError("projection_conflict");
    }

    touchedConversations.add(row.conversation_id);
  }

  recomputeConversationSummaries(storage.sql, touchedConversations);
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
      "SELECT COALESCE((SELECT latest_sequence FROM projection_identity_sequences WHERE identity_id = ?), 0) AS latest_sequence",
      input.identity_id,
    )
    .toArray()[0];
  if (latestRow === undefined)
    throw new Error("projection sequence is missing");

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
          "SELECT identity_sequence, event_id, event_type, identity_id, connection_id, conversation_id, occurred_at, observed_at, generation FROM projection_changes WHERE identity_id = ? AND identity_sequence > ? ORDER BY identity_sequence ASC LIMIT ?",
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
      sequence: row.identity_sequence,
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

type RealtimeLatestSequenceRow = { latest_sequence: number };
type RealtimeFloorRow = { discarded_through_sequence: number };

type RealtimeReplayAction = {
  readonly identityId: string;
  readonly latestSequence: number;
  readonly resetReason: RealtimeResetRequiredFrame["reason"] | null;
  readonly changes: readonly RealtimeProjectionChange[];
};

const REALTIME_ERROR_MESSAGES = {
  invalid_request: "Invalid realtime request",
  service_unavailable: "Realtime service unavailable",
} as const;

const realtimeResponse = (
  code: keyof typeof REALTIME_ERROR_MESSAGES,
): Response =>
  new Response(
    JSON.stringify({
      error: {
        code,
        message: REALTIME_ERROR_MESSAGES[code],
      },
    }),
    {
      status: code === "invalid_request" ? 400 : 503,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      },
    },
  );

const REALTIME_INTERNAL_HEADER_NAMES = new Set([
  "connection",
  "upgrade",
  "sec-websocket-protocol",
  REALTIME_CONTEXT_HEADER.toLowerCase(),
]);
const realtimeTextEncoder = new TextEncoder();

const isInternalRealtimeUpgrade = (request: Request): boolean => {
  try {
    const url = new URL(request.url);
    if (
      request.method !== "GET" ||
      url.protocol !== "https:" ||
      url.hostname !== REALTIME_INTERNAL_HOST ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== REALTIME_INTERNAL_PATH ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return false;
    }

    const headerNames = new Set<string>();
    for (const [name] of request.headers) {
      const normalizedName = name.toLowerCase();
      if (
        !REALTIME_INTERNAL_HEADER_NAMES.has(normalizedName) ||
        headerNames.has(normalizedName)
      ) {
        return false;
      }
      headerNames.add(normalizedName);
    }
    return (
      headerNames.size === REALTIME_INTERNAL_HEADER_NAMES.size &&
      request.headers.get("Upgrade") === "websocket" &&
      request.headers.get("Connection") === "Upgrade" &&
      request.headers.get("Sec-WebSocket-Protocol") === REALTIME_SUBPROTOCOL &&
      request.headers.get(REALTIME_CONTEXT_HEADER) !== null
    );
  } catch {
    return false;
  }
};

const parseInternalRealtimeContext = (
  request: Request,
): RealtimeUpgradeContext | null => {
  if (!isInternalRealtimeUpgrade(request)) return null;
  const serialized = request.headers.get(REALTIME_CONTEXT_HEADER);
  if (serialized === null) return null;
  if (
    realtimeTextEncoder.encode(serialized).byteLength >
    MAX_REALTIME_ATTACHMENT_JSON_BYTES
  ) {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    return null;
  }

  try {
    const context = parseRealtimeUpgradeContext(value);
    const issuedAt = Date.parse(context.issued_at);
    const expiresAt = Date.parse(context.expires_at);
    const now = Date.now();
    if (
      !Number.isSafeInteger(issuedAt) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt - issuedAt !== REALTIME_TICKET_TTL_MS ||
      issuedAt > now ||
      expiresAt <= now
    ) {
      return null;
    }
    return context;
  } catch {
    return null;
  }
};

const readRealtimeLatestSequence = (
  storage: DurableObjectStorage,
  identityId: string,
): number => {
  const row = storage.sql
    .exec<RealtimeLatestSequenceRow>(
      "SELECT COALESCE((SELECT latest_sequence FROM projection_identity_sequences WHERE identity_id = ?), 0) AS latest_sequence",
      identityId,
    )
    .toArray()[0];
  if (row === undefined || !isSafeNonnegativeInteger(row.latest_sequence)) {
    throw new Error("realtime sequence is invalid");
  }
  return row.latest_sequence;
};

const readRealtimeFloor = (
  storage: DurableObjectStorage,
  identityId: string,
): number => {
  const row = storage.sql
    .exec<RealtimeFloorRow>(
      "SELECT discarded_through_sequence FROM projection_change_floors WHERE identity_id = ?",
      identityId,
    )
    .toArray()[0];
  if (row === undefined) return 0;
  if (!isSafeNonnegativeInteger(row.discarded_through_sequence)) {
    throw new Error("realtime change floor is invalid");
  }
  return row.discarded_through_sequence;
};

const changesFromReplayRows = (
  rows: readonly RealtimeReplayRow[],
): RealtimeProjectionChange[] =>
  rows.map((row) => ({
    sequence: row.sequence,
    event_type: row.event_type,
    connection_id: row.connection_id,
    conversation_id: row.conversation_id,
    occurred_at: row.occurred_at,
  }));

export class TenantProjectionDO extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    this.ctx.blockConcurrencyWhile(async () => {
      runProjectionMigrations(this.ctx.storage);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const context = parseInternalRealtimeContext(request);
    if (context === null) return realtimeResponse("invalid_request");

    try {
      const meta = readProjectionMeta(this.ctx.storage);
      if (meta === undefined || meta.tenant_id !== context.tenant_id) {
        return realtimeResponse("service_unavailable");
      }
      this.#requireReadyState(meta);

      const resumeByIdentity = new Map(
        context.resume.map((position) => [position.identity_id, position]),
      );
      const positions: RealtimePosition[] = [];
      const replayActions: RealtimeReplayAction[] = [];

      for (const subscription of context.subscriptions) {
        const latestSequence = readRealtimeLatestSequence(
          this.ctx.storage,
          subscription.identity_id,
        );
        const resume = resumeByIdentity.get(subscription.identity_id);
        const position = RealtimePositionSchema.parse({
          identity_id: subscription.identity_id,
          generation: resume?.generation ?? meta.generation,
          sequence: resume?.after_sequence ?? latestSequence,
        });
        positions.push(position);

        if (resume === undefined) {
          replayActions.push({
            identityId: subscription.identity_id,
            latestSequence,
            resetReason: null,
            changes: [],
          });
          continue;
        }

        if (resume.generation !== meta.generation) {
          replayActions.push({
            identityId: subscription.identity_id,
            latestSequence,
            resetReason: "generation_changed",
            changes: [],
          });
          continue;
        }

        const floor = readRealtimeFloor(
          this.ctx.storage,
          subscription.identity_id,
        );
        if (
          resume.after_sequence < floor ||
          resume.after_sequence > latestSequence
        ) {
          replayActions.push({
            identityId: subscription.identity_id,
            latestSequence,
            resetReason: "history_unavailable",
            changes: [],
          });
          continue;
        }

        const replayRows = readRealtimeReplay(
          this.ctx.storage.sql,
          subscription.identity_id,
          meta.generation,
          resume.after_sequence,
          MAX_REALTIME_REPLAY_CHANGES + 1,
        );
        if (replayRows.length > MAX_REALTIME_REPLAY_CHANGES) {
          replayActions.push({
            identityId: subscription.identity_id,
            latestSequence,
            resetReason: "replay_too_large",
            changes: [],
          });
          continue;
        }

        const contiguous = replayRows.every(
          (row, index) => row.sequence === resume.after_sequence + index + 1,
        );
        if (
          replayRows.length !== latestSequence - resume.after_sequence ||
          !contiguous ||
          replayRows.some((row) => row.generation !== meta.generation)
        ) {
          replayActions.push({
            identityId: subscription.identity_id,
            latestSequence,
            resetReason: "history_unavailable",
            changes: [],
          });
          continue;
        }

        replayActions.push({
          identityId: subscription.identity_id,
          latestSequence,
          resetReason: null,
          changes: changesFromReplayRows(replayRows),
        });
      }

      // Existing sockets are revalidated before replay delivery and on every
      // broadcast/alarm. A fresh upgrade without replay only needs a bounded
      // attachment parse, so a tenant with many sockets does not turn each
      // new upgrade into an O(n²) directory read.
      const validSockets =
        context.resume.length > 0
          ? await this.#revalidateRealtimeSockets()
          : this.#validSocketsForAdmission();
      const activeTenantSocketCount = validSockets.length;
      if (
        activeTenantSocketCount >= MAX_REALTIME_SOCKETS_PER_TENANT ||
        countPrincipalSockets(validSockets, context.principal_id) >=
          MAX_REALTIME_SOCKETS_PER_PRINCIPAL
      ) {
        this.#emitSocketOutcome(
          {
            tenant_id: context.tenant_id,
            subscriptions: context.subscriptions,
            resumed: context.resume.length > 0,
          },
          "capacity_rejected",
          activeTenantSocketCount,
        );
        return realtimeResponse("service_unavailable");
      }

      const connectionExpiresAt = realtimeConnectionExpiry();
      let attachment = serializeSafeRealtimeAttachment({
        schema_version: 1,
        tenant_id: context.tenant_id,
        principal_id: context.principal_id,
        membership_id: context.membership_id,
        subscriptions: context.subscriptions,
        positions,
        lease_expires_at: connectionExpiresAt,
        resumed: context.resume.length > 0,
      });
      const connectedFrame = RealtimeConnectedFrameSchema.parse({
        schema_version: 1,
        type: "connected",
        tenant_id: context.tenant_id,
        positions,
        connection_expires_at: connectionExpiresAt,
      });

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server, [REALTIME_SOCKET_TAG]);
      try {
        server.serializeAttachment(attachment);
        await this.#scheduleRealtimeSocketAlarm();
        sendRealtimeFrame(server, connectedFrame);

        for (const action of replayActions) {
          if (action.resetReason !== null) {
            const resetFrame: RealtimeResetRequiredFrame =
              RealtimeResetRequiredFrameSchema.parse({
                schema_version: 1,
                type: "reset_required",
                tenant_id: context.tenant_id,
                identity_id: action.identityId,
                generation: meta.generation,
                latest_sequence: action.latestSequence,
                reason: action.resetReason,
              });
            sendRealtimeFrame(server, resetFrame);
            attachment = this.#persistSocketPosition(
              server,
              attachment,
              action.identityId,
              meta.generation,
              action.latestSequence,
            );
            continue;
          }

          for (const changes of batchRealtimeChanges(action.changes)) {
            const first = changes[0];
            const last = changes.at(-1);
            if (first === undefined || last === undefined) continue;
            sendRealtimeFrame(server, {
              schema_version: 1,
              type: "projection.changes",
              tenant_id: context.tenant_id,
              identity_id: action.identityId,
              generation: meta.generation,
              from_sequence: first.sequence,
              to_sequence: last.sequence + 1,
              changes,
            });
            attachment = this.#persistSocketPosition(
              server,
              attachment,
              action.identityId,
              meta.generation,
              last.sequence,
            );
          }
        }

        this.#emitSocketOutcome(
          {
            tenant_id: attachment.tenant_id,
            subscriptions: attachment.subscriptions,
            resumed: attachment.resumed,
          },
          attachment.resumed ? "resumed" : "accepted",
          this.#activeTenantSocketCount(),
        );
      } catch {
        this.#closeSocket(server, 1011, "realtime socket unavailable");
        return realtimeResponse("service_unavailable");
      }

      return new Response(null, {
        status: 101,
        headers: { "Sec-WebSocket-Protocol": REALTIME_SUBPROTOCOL },
        webSocket: client,
      });
    } catch {
      return realtimeResponse("service_unavailable");
    }
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const attachment = tryParseRealtimeAttachment(socket);
    if (attachment === null) {
      this.#closeSocket(socket, 1008, "invalid realtime attachment");
      return;
    }
    if (message === "ping") return;
    this.#closeSocket(socket, 1008, "unsupported realtime message");
  }

  webSocketClose(
    socket: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): void {
    const attachment = tryParseRealtimeAttachment(socket);
    if (attachment === null) return;
    this.#emitSocketOutcome(
      {
        tenant_id: attachment.tenant_id,
        subscriptions: attachment.subscriptions,
        resumed: attachment.resumed,
      },
      "closed",
      this.#activeTenantSocketCount(),
    );
  }

  webSocketError(socket: WebSocket, _error: unknown): void {
    this.#closeSocket(socket, 1011, "realtime socket error");
  }

  async #processOutboundAlarm(now: number): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec<OutboundDispatchRow>(
        "SELECT id, command_id, message_id, event_id, tenant_id, actor_principal_id, actor_identity_id, resource_identity_id, account_id, connection_id, conversation_id, platform, idempotency_key, body_digest, body, delivery_mode, status, confirmation_due_at, confirmation_decision, confirmation_actor_principal_id, confirmation_actor_identity_id, confirmation_decided_at, created_at, updated_at FROM outbound_dispatches WHERE status IN ('waiting_for_connection', 'pending', 'confirmation_required') ORDER BY confirmation_due_at ASC, id ASC",
      )
      .toArray();
    for (const row of rows) {
      const available = await this.#connectionAvailable(
        row.tenant_id,
        row.connection_id,
      );
      this.ctx.storage.transactionSync(() => {
        const current = readOutboundDispatchByCommand(
          this.ctx.storage,
          row.command_id,
        );
        const command = current
          ? readOutboundCommand(this.ctx.storage, current.command_id)
          : undefined;
        if (
          current === undefined ||
          command === undefined ||
          current.status !== "waiting_for_connection"
        ) {
          return;
        }
        const transition = transitionOutboundLifecycle({
          dispatchStatus: current.status,
          commandStatus: command.status,
          confirmationDecision: current.confirmation_decision,
          confirmationDueAt: current.confirmation_due_at,
          createdAt: current.created_at,
          now: new Date(now).toISOString(),
          connectionAvailable: available,
        });
        if (
          transition.dispatchStatus === current.status &&
          transition.commandStatus === command.status &&
          transition.confirmationDueAt === current.confirmation_due_at
        ) {
          return;
        }
        const updatedAt = new Date(now).toISOString();
        this.ctx.storage.sql.exec(
          "UPDATE outbound_dispatches SET status = ?, confirmation_due_at = ?, updated_at = ? WHERE id = ? AND status = ?",
          transition.dispatchStatus,
          transition.confirmationDueAt,
          updatedAt,
          current.id,
          current.status,
        );
        if (transition.commandStatus !== command.status) {
          this.ctx.storage.sql.exec(
            "UPDATE commands SET status = ?, updated_at = ? WHERE id = ? AND status = ?",
            transition.commandStatus,
            updatedAt,
            command.id,
            command.status,
          );
        }
      });
    }
  }

  #nextOutboundAlarm(): number | null {
    const rows = this.ctx.storage.sql
      .exec<{ confirmation_due_at: string | null }>(
        "SELECT confirmation_due_at FROM outbound_dispatches WHERE status IN ('waiting_for_connection', 'pending') AND confirmation_decision IS NULL AND confirmation_due_at IS NOT NULL ORDER BY confirmation_due_at ASC",
      )
      .toArray();
    const now = Date.now();
    for (const row of rows) {
      if (row.confirmation_due_at === null) continue;
      const dueMs = Date.parse(row.confirmation_due_at);
      if (Number.isSafeInteger(dueMs) && dueMs > now) return dueMs;
    }
    return null;
  }

  async #scheduleCombinedAlarm(
    sockets: readonly WebSocket[] = this.ctx.getWebSockets(REALTIME_SOCKET_TAG),
  ): Promise<void> {
    const socketExpiry = nextSocketExpiry(sockets);
    const outboundExpiry = this.#nextOutboundAlarm();
    const candidates = [socketExpiry, outboundExpiry].filter(
      (value): value is number => value !== null,
    );
    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...candidates));
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    await this.#processOutboundAlarm(now);
    const remaining: WebSocket[] = [];
    const sockets = await this.#revalidateRealtimeSockets();
    const activeTenantSocketCount = Math.min(
      MAX_REALTIME_SOCKETS_PER_TENANT,
      sockets.length,
    );

    for (const socket of sockets) {
      const attachment = tryParseRealtimeAttachment(socket);
      if (attachment === null) {
        this.#closeSocket(socket, 1008, "invalid realtime attachment");
        continue;
      }
      const expiry = Date.parse(attachment.lease_expires_at);
      if (!Number.isSafeInteger(expiry)) {
        this.#closeSocket(socket, 1008, "invalid realtime attachment");
        continue;
      }
      if (expiry <= now) {
        this.#emitSocketOutcome(
          {
            tenant_id: attachment.tenant_id,
            subscriptions: attachment.subscriptions,
            resumed: attachment.resumed,
          },
          "lease_expired",
          activeTenantSocketCount,
        );
        this.#closeSocket(socket, 1000, "realtime lease expired");
        continue;
      }
      remaining.push(socket);
    }

    await this.#scheduleCombinedAlarm(remaining);
  }

  #activeTenantSocketCount(): number {
    return Math.min(
      MAX_REALTIME_SOCKETS_PER_TENANT,
      this.ctx.getWebSockets(REALTIME_SOCKET_TAG).length,
    );
  }

  #validSocketsForAdmission(): WebSocket[] {
    const valid: WebSocket[] = [];
    for (const socket of this.ctx.getWebSockets(REALTIME_SOCKET_TAG)) {
      if (tryParseRealtimeAttachment(socket) === null) {
        this.#closeSocket(socket, 1008, "invalid realtime attachment");
        continue;
      }
      valid.push(socket);
    }
    return valid;
  }

  async #revalidateRealtimeSockets(): Promise<WebSocket[]> {
    const sockets = this.ctx.getWebSockets(REALTIME_SOCKET_TAG);
    const database = this.env.CONTROL_DB;
    if (database === undefined || typeof database.withSession !== "function") {
      for (const socket of sockets) {
        this.#closeSocket(socket, 1008, "realtime authorization unavailable");
      }
      return [];
    }

    let db: D1DatabaseSession;
    try {
      db = database.withSession("first-primary");
    } catch {
      for (const socket of sockets) {
        this.#closeSocket(socket, 1008, "realtime authorization unavailable");
      }
      return [];
    }

    const valid: WebSocket[] = [];
    for (const socket of sockets) {
      const attachment = tryParseRealtimeAttachment(socket);
      if (attachment === null) {
        this.#closeSocket(socket, 1008, "invalid realtime attachment");
        continue;
      }
      try {
        if (!(await revalidateRealtimeSocketAuthorization(db, attachment))) {
          this.#closeSocket(socket, 1008, "realtime authorization revoked");
          continue;
        }
      } catch {
        this.#closeSocket(socket, 1008, "realtime authorization unavailable");
        continue;
      }
      valid.push(socket);
    }
    return valid;
  }

  #emitSocketOutcome(
    subject: {
      readonly tenant_id: string;
      readonly subscriptions: RealtimeSocketAttachment["subscriptions"];
      readonly resumed: boolean;
    },
    outcome: RealtimeSocketOutcome,
    activeTenantSocketCount: number,
  ): void {
    try {
      logRealtimeSocketOutcome(
        realtimeSocketLoggerFromEnv(this.env),
        subject,
        outcome,
        Math.max(
          0,
          Math.min(MAX_REALTIME_SOCKETS_PER_TENANT, activeTenantSocketCount),
        ),
      );
    } catch {
      // Telemetry must never change socket or projection behavior.
    }
  }

  #closeSocket(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // A socket may already be closed when an hibernated callback runs.
    }
  }

  async #scheduleRealtimeSocketAlarm(): Promise<void> {
    await this.#scheduleCombinedAlarm();
  }

  #persistSocketPosition(
    socket: WebSocket,
    attachment: RealtimeSocketAttachment,
    identityId: string,
    generation: number,
    sequence: number,
  ): RealtimeSocketAttachment {
    const positions = attachment.positions.map((position) =>
      position.identity_id === identityId
        ? RealtimePositionSchema.parse({
            identity_id: identityId,
            generation,
            sequence,
          })
        : position,
    );
    const nextAttachment = serializeSafeRealtimeAttachment({
      ...attachment,
      positions,
    });
    socket.serializeAttachment(nextAttachment);
    return nextAttachment;
  }

  async initialize(
    input: InitializeProjectionInput,
  ): Promise<ProjectionStatus> {
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
      if (created === undefined)
        throw new Error("projection metadata was not created");
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
      const applied = await this.#applyPreparedBatch({
        tenantId: prepared.tenantId,
        mode: "live",
        rebuildId: null,
        preparedEvents: prepared.events,
        checkpointMutation: prepared.checkpointMutation,
        inputEventCount: prepared.inputEventCount,
        connections: prepared.connections,
      });
      return applied.result;
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
        if (current === undefined)
          throw projectionError("projection_not_found");
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
        if (
          current.state !== meta.state ||
          current.generation !== meta.generation
        ) {
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

      try {
        resetRealtimeSocketsForRebuild(
          this.ctx.getWebSockets(REALTIME_SOCKET_TAG),
          parsed.tenant_id,
          nextGeneration,
        );
      } catch {
        // Rebuild lifecycle state remains authoritative if socket cleanup fails.
      }

      const started = readProjectionMeta(this.ctx.storage);
      if (started === undefined)
        throw new Error("projection metadata disappeared");
      return readStatusForMeta(this.ctx.storage, started);
    } catch (error) {
      throw safeProjectionError(error, "projection_unavailable");
    }
  }

  /**
   * Mark the active rebuild complete only after its current-generation replay
   * checkpoint has reached the terminal marker.
   */
  async completeRebuild(
    input: CompleteRebuildInput,
  ): Promise<ProjectionStatus> {
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
      if (
        meta.state !== "rebuilding" ||
        meta.rebuild_id !== parsed.rebuild_id
      ) {
        throw projectionError("projection_rebuild_mismatch");
      }

      this.ctx.storage.transactionSync(() => {
        const current = readProjectionMeta(this.ctx.storage);
        if (current === undefined)
          throw projectionError("projection_not_found");
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

        restoreOutboundProjectionRows(this.ctx.storage, parsed.tenant_id);

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
      if (completed === undefined)
        throw new Error("projection metadata disappeared");
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
          .exec<{
            failed_at: string;
            failure_code: ProjectionStatus["last_rebuild_failure_code"];
          }>(
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

      if (
        meta.state !== "rebuilding" ||
        meta.rebuild_id !== parsed.rebuild_id
      ) {
        throw projectionError("projection_rebuild_mismatch");
      }

      this.ctx.storage.transactionSync(() => {
        const current = readProjectionMeta(this.ctx.storage);
        if (current === undefined)
          throw projectionError("projection_not_found");
        requireStoredTenant(current, parsed.tenant_id);
        // Mirror the public failed-state retry semantics for two concurrent
        // abort callers. The failure row is checked before treating it as an
        // idempotent success so mismatched details still fail closed.
        if (current.state === "rebuild_failed") {
          if (current.last_failed_rebuild_id !== parsed.rebuild_id) {
            throw projectionError("projection_rebuild_mismatch");
          }
          const failure = this.ctx.storage.sql
            .exec<{
              failed_at: string;
              failure_code: ProjectionStatus["last_rebuild_failure_code"];
            }>(
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
      if (failed === undefined)
        throw new Error("projection metadata disappeared");
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
      if (
        meta.state !== "rebuilding" ||
        meta.rebuild_id !== parsed.rebuild_id
      ) {
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
      let connections: readonly ProjectionConnectionBinding[] =
        parsed.connections;
      if (!isEmptyTerminal) {
        inputEventCount = parsed.page.events.length;
        // Replay is tenant-wide and intentionally ignores allowed_identity_ids.
        // prepareProjectionBatch still supplies the shared descriptor-safe
        // event/binding/hash preflight, using an internal identity set only for
        // that helper's structural check.
        const identities = [
          ...new Set(parsed.page.events.map((event) => event.identity_id)),
        ].sort();
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
        updatedAt:
          pageGreatest?.event.observed_at ??
          meta.rebuild_started_at ??
          meta.updated_at,
      };

      const applied = await this.#applyPreparedBatch({
        tenantId: parsed.tenant_id,
        mode: "replay",
        rebuildId: parsed.rebuild_id,
        preparedEvents,
        checkpointMutation: replayCheckpoint,
        inputEventCount,
        connections,
      });
      return applied.result;
    } catch (error) {
      throw safeProjectionError(error, "projection_unavailable");
    }
  }

  /**
   * Resolve ownership without exposing the conversation body. The API uses
   * this narrow lookup to check an account grant before accepting a reply for
   * an agent whose identity differs from the account's resource identity.
   */
  async resolveConversationOwner(
    input: ResolveConversationOwnerInput,
  ): Promise<ConversationOwner | null> {
    try {
      const parsed = parseProjectionInput(
        ResolveConversationOwnerInputSchema,
        input,
      );
      const meta = readProjectionMeta(this.ctx.storage);
      if (meta === undefined) throw projectionError("projection_not_found");
      requireStoredTenant(meta, parsed.tenant_id);
      this.#requireReadyState(meta);
      const row = this.ctx.storage.sql
        .exec<ConversationOwnerRow>(
          "SELECT identity_id, account_id, connection_id, platform FROM conversations WHERE id = ? AND deleted_at IS NULL LIMIT 1",
          parsed.conversation_id,
        )
        .toArray()[0];
      if (row === undefined) return null;
      return ConversationOwnerSchema.parse({
        tenant_id: parsed.tenant_id,
        conversation_id: parsed.conversation_id,
        identity_id: row.identity_id,
        account_id: row.account_id,
        connection_id: row.connection_id,
        platform: row.platform,
      });
    } catch (error) {
      throw safeProjectionError(error, "projection_unavailable");
    }
  }

  /**
   * Accept one text reply into the tenant-local outbound ledger. The caller
   * resolves directory grants before entering this RPC; this method remains
   * responsible for binding the request to the immutable conversation owner
   * and for making the message, command, and dispatch rows one transaction.
   */
  async acceptTextReply(
    input: AcceptTextReplyInput,
  ): Promise<AcceptTextReplyResult> {
    try {
      const parsed = parseProjectionInput(AcceptTextReplyInputSchema, input);
      const meta = readProjectionMeta(this.ctx.storage);
      if (meta === undefined) throw projectionError("projection_not_found");
      requireStoredTenant(meta, parsed.tenant_id);
      this.#requireReadyState(meta);

      const owner = this.ctx.storage.sql
        .exec<ConversationOwnerRow>(
          "SELECT identity_id, account_id, connection_id, platform FROM conversations WHERE id = ? AND deleted_at IS NULL LIMIT 1",
          parsed.conversation_id,
        )
        .toArray()[0];
      if (owner === undefined) throw projectionError("projection_forbidden");
      if (
        parsed.account_id !== undefined &&
        parsed.account_id !== owner.account_id
      ) {
        throw projectionError("projection_conflict");
      }

      const binding = this.ctx.storage.sql
        .exec<ProjectionConnectionBinding>(
          "SELECT account_id, connection_id, identity_id, platform FROM connection_bindings WHERE account_id = ? LIMIT 1",
          owner.account_id,
        )
        .toArray()[0];
      if (
        binding === undefined ||
        binding.connection_id !== owner.connection_id ||
        binding.identity_id !== owner.identity_id ||
        binding.platform !== owner.platform
      ) {
        throw projectionError("projection_conflict");
      }

      const bodyDigest = await sha256Hex(
        new TextEncoder().encode(
          canonicalJsonStringify({
            actor_principal_id: parsed.actor_principal_id,
            actor_identity_id: parsed.actor_identity_id,
            conversation_id: parsed.conversation_id,
            account_id: owner.account_id,
            body: parsed.body,
            delivery_mode: parsed.delivery_mode,
          }),
        ),
      );
      const requestDigest = await sha256Hex(
        new TextEncoder().encode(
          canonicalJsonStringify({
            body_digest: bodyDigest,
            idempotency_key: parsed.idempotency_key,
          }),
        ),
      );
      const commandId = `command_outbound_${requestDigest.slice(0, 48)}`;
      const messageId = `message_outbound_${requestDigest.slice(0, 48)}`;
      const eventId = `event_outbound_${requestDigest.slice(0, 48)}`;
      const dispatchId = `dispatch_outbound_${requestDigest.slice(0, 48)}`;
      const occurredMs = parseStoredMilliseconds(parsed.accepted_at);
      const initialDispatchStatus = parsed.initial_dispatch_status ?? "pending";
      const initialCommandStatus =
        initialDispatchStatus === "waiting_for_connection"
          ? "waiting_for_connection"
          : "accepted";
      const confirmationDueAt = parsed.confirmation_due_at ?? null;

      const result = this.ctx.storage.transactionSync(() => {
        // Hashing happens outside the synchronous transaction. Re-read every
        // mutable projection boundary after hashing so a rebuild, deletion,
        // or rebinding that completes while hashing cannot turn stale owner
        // data into an accepted outbound row.
        const transactionMeta = readProjectionMeta(this.ctx.storage);
        if (transactionMeta === undefined) {
          throw projectionError("projection_not_found");
        }
        requireStoredTenant(transactionMeta, parsed.tenant_id);
        this.#requireReadyState(transactionMeta);

        const transactionOwner = this.ctx.storage.sql
          .exec<ConversationOwnerRow>(
            "SELECT identity_id, account_id, connection_id, platform FROM conversations WHERE id = ? AND deleted_at IS NULL LIMIT 1",
            parsed.conversation_id,
          )
          .toArray()[0];
        if (transactionOwner === undefined) {
          throw projectionError("projection_forbidden");
        }
        if (
          parsed.account_id !== undefined &&
          parsed.account_id !== transactionOwner.account_id
        ) {
          throw projectionError("projection_conflict");
        }
        if (
          transactionOwner.identity_id !== owner.identity_id ||
          transactionOwner.account_id !== owner.account_id ||
          transactionOwner.connection_id !== owner.connection_id ||
          transactionOwner.platform !== owner.platform
        ) {
          throw projectionError("projection_conflict");
        }

        const transactionBinding = this.ctx.storage.sql
          .exec<ProjectionConnectionBinding>(
            "SELECT account_id, connection_id, identity_id, platform FROM connection_bindings WHERE account_id = ? LIMIT 1",
            transactionOwner.account_id,
          )
          .toArray()[0];
        if (
          transactionBinding === undefined ||
          transactionBinding.connection_id !== transactionOwner.connection_id ||
          transactionBinding.identity_id !== transactionOwner.identity_id ||
          transactionBinding.platform !== transactionOwner.platform
        ) {
          throw projectionError("projection_conflict");
        }

        const current = readOutboundDispatchByKey(
          this.ctx.storage,
          parsed.idempotency_key,
        );
        if (current !== undefined) {
          if (
            current.body_digest !== bodyDigest ||
            current.actor_principal_id !== parsed.actor_principal_id ||
            current.actor_identity_id !== parsed.actor_identity_id ||
            current.conversation_id !== parsed.conversation_id ||
            current.account_id !== owner.account_id ||
            current.delivery_mode !== parsed.delivery_mode
          ) {
            throw projectionError("projection_conflict");
          }
          const command = readOutboundCommand(
            this.ctx.storage,
            current.command_id,
          );
          const message = readOutboundMessage(
            this.ctx.storage,
            current.message_id,
          );
          if (command === undefined || message === undefined) {
            throw projectionError("projection_conflict");
          }
          return AcceptTextReplyResultSchema.parse({
            command: mapOutboundCommand(parsed.tenant_id, command, current),
            message: mapOutboundMessage(parsed.tenant_id, message),
            dispatch: mapOutboundDispatch(current),
            replayed: true,
          });
        }

        this.ctx.storage.sql.exec(
          "INSERT INTO messages (id, identity_id, account_id, connection_id, conversation_id, platform, direction, sender_participant_id, sender_label, body, reply_to_message_id, delivery_status, unread, local_read_at, occurred_at, occurred_ms, observed_at, current_observed_ms, current_event_id, matrix_room_id, matrix_event_id, remote_message_id, edited_at, deleted_at, deletion_reason, attachment_count, delivery_failure_code, delivery_observed_ms, delivery_event_id) VALUES (?, ?, ?, ?, ?, ?, 'outbound', NULL, 'Communicator', ?, NULL, 'accepted', 0, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL)",
          messageId,
          owner.identity_id,
          owner.account_id,
          owner.connection_id,
          parsed.conversation_id,
          owner.platform,
          parsed.body,
          parsed.accepted_at,
          occurredMs,
          parsed.accepted_at,
          occurredMs,
          eventId,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO commands (id, identity_id, account_id, connection_id, conversation_id, platform, operation, delivery_mode, status, failure_code, created_at, updated_at, last_observed_ms, last_event_id) VALUES (?, ?, ?, ?, ?, ?, 'message.send', ?, ?, NULL, ?, ?, ?, ?)",
          commandId,
          parsed.actor_identity_id,
          owner.account_id,
          owner.connection_id,
          parsed.conversation_id,
          owner.platform,
          parsed.delivery_mode,
          initialCommandStatus,
          parsed.accepted_at,
          parsed.accepted_at,
          occurredMs,
          eventId,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO outbound_dispatches (id, command_id, message_id, event_id, tenant_id, actor_principal_id, actor_identity_id, resource_identity_id, account_id, connection_id, conversation_id, platform, idempotency_key, body_digest, body, delivery_mode, status, confirmation_due_at, confirmation_decision, confirmation_actor_principal_id, confirmation_actor_identity_id, confirmation_decided_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)",
          dispatchId,
          commandId,
          messageId,
          eventId,
          parsed.tenant_id,
          parsed.actor_principal_id,
          parsed.actor_identity_id,
          owner.identity_id,
          owner.account_id,
          owner.connection_id,
          parsed.conversation_id,
          owner.platform,
          parsed.idempotency_key,
          bodyDigest,
          parsed.body,
          parsed.delivery_mode,
          initialDispatchStatus,
          confirmationDueAt,
          parsed.accepted_at,
          parsed.accepted_at,
        );
        recomputeConversationSummaries(
          this.ctx.storage.sql,
          new Set([parsed.conversation_id]),
        );
        const dispatch = readOutboundDispatchByKey(
          this.ctx.storage,
          parsed.idempotency_key,
        );
        const command = readOutboundCommand(this.ctx.storage, commandId);
        const message = readOutboundMessage(this.ctx.storage, messageId);
        if (
          dispatch === undefined ||
          command === undefined ||
          message === undefined
        ) {
          throw projectionError("projection_conflict");
        }
        return AcceptTextReplyResultSchema.parse({
          command: mapOutboundCommand(parsed.tenant_id, command, dispatch),
          message: mapOutboundMessage(parsed.tenant_id, message),
          dispatch: mapOutboundDispatch(dispatch),
          replayed: false,
        });
      });
      if (result.dispatch.status === "waiting_for_connection") {
        await this.#scheduleCombinedAlarm();
      }
      return structuredClone(result);
    } catch (error) {
      throw safeProjectionError(error, "projection_unavailable");
    }
  }

  async #connectionAvailable(
    tenantId: string,
    connectionId: string,
  ): Promise<boolean> {
    const database = this.env.CONTROL_DB;
    if (database === undefined || typeof database.withSession !== "function") {
      return false;
    }
    try {
      const row = await database
        .withSession("first-primary")
        .prepare(
          "SELECT status FROM connections WHERE tenant_id = ? AND id = ? LIMIT 1",
        )
        .bind(tenantId, connectionId)
        .first<{ status: string }>();
      return (
        row !== null &&
        (row.status === "connected" ||
          row.status === "syncing" ||
          row.status === "ready")
      );
    } catch {
      return false;
    }
  }

  /**
   * Reconcile a waiting command against the immutable deadline and current
   * connection state. Repeated calls are harmless and never rewrite
   * created_at or confirmation_due_at.
   */
  async reconcileOutbound(
    input: OutboundReconcileInput,
  ): Promise<OutboundDecisionResult> {
    try {
      const parsed = parseProjectionInput(OutboundReconcileInputSchema, input);
      const meta = readProjectionMeta(this.ctx.storage);
      if (meta === undefined) throw projectionError("projection_not_found");
      requireStoredTenant(meta, parsed.tenant_id);
      this.#requireReadyState(meta);
      const available =
        parsed.connection_available ??
        (await this.#connectionAvailable(
          parsed.tenant_id,
          readOutboundDispatchByCommand(this.ctx.storage, parsed.command_id)
            ?.connection_id ?? "",
        ));
      const result = this.ctx.storage.transactionSync(() => {
        const dispatch = readOutboundDispatchByCommand(
          this.ctx.storage,
          parsed.command_id,
        );
        const command = dispatch
          ? readOutboundCommand(this.ctx.storage, dispatch.command_id)
          : undefined;
        if (dispatch === undefined || command === undefined) {
          throw projectionError("projection_not_found");
        }

        const transition = transitionOutboundLifecycle({
          dispatchStatus: dispatch.status,
          commandStatus: command.status,
          confirmationDecision: dispatch.confirmation_decision,
          confirmationDueAt: dispatch.confirmation_due_at,
          createdAt: dispatch.created_at,
          now: parsed.now,
          connectionAvailable: available,
        });

        if (
          transition.dispatchStatus !== dispatch.status ||
          transition.commandStatus !== command.status ||
          transition.confirmationDueAt !== dispatch.confirmation_due_at
        ) {
          this.ctx.storage.sql.exec(
            "UPDATE outbound_dispatches SET status = ?, confirmation_due_at = ?, updated_at = ? WHERE id = ? AND status = ?",
            transition.dispatchStatus,
            transition.confirmationDueAt,
            parsed.now,
            dispatch.id,
            dispatch.status,
          );
          if (transition.commandStatus !== command.status) {
            this.ctx.storage.sql.exec(
              "UPDATE commands SET status = ?, updated_at = ? WHERE id = ? AND status = ?",
              transition.commandStatus,
              parsed.now,
              command.id,
              command.status,
            );
          }
        }
        const updatedDispatch = readOutboundDispatchByCommand(
          this.ctx.storage,
          parsed.command_id,
        );
        const updatedCommand = readOutboundCommand(
          this.ctx.storage,
          parsed.command_id,
        );
        if (updatedDispatch === undefined || updatedCommand === undefined) {
          throw projectionError("projection_conflict");
        }
        return OutboundDecisionResultSchema.parse({
          command: mapOutboundCommand(
            parsed.tenant_id,
            updatedCommand,
            updatedDispatch,
          ),
          dispatch: mapOutboundDispatch(updatedDispatch),
          replayed: false,
        });
      });
      return structuredClone(result);
    } catch (error) {
      throw safeProjectionError(error, "projection_unavailable");
    }
  }

  /**
   * Persist exactly one human confirmation or cancellation decision. The
   * decision row is the idempotency record; the dispatch and command status
   * transition happen in the same SQLite transaction.
   */
  async decideOutbound(
    input: OutboundDecisionInput,
  ): Promise<OutboundDecisionResult> {
    try {
      const parsed = parseProjectionInput(OutboundDecisionInputSchema, input);
      const meta = readProjectionMeta(this.ctx.storage);
      if (meta === undefined) throw projectionError("projection_not_found");
      requireStoredTenant(meta, parsed.tenant_id);
      this.#requireReadyState(meta);

      const available =
        parsed.connection_available ??
        (await this.#connectionAvailable(
          parsed.tenant_id,
          readOutboundDispatchByCommand(this.ctx.storage, parsed.command_id)
            ?.connection_id ?? "",
        ));
      const result = this.ctx.storage.transactionSync(() => {
        const dispatch = readOutboundDispatchByCommand(
          this.ctx.storage,
          parsed.command_id,
        );
        const command = dispatch
          ? readOutboundCommand(this.ctx.storage, dispatch.command_id)
          : undefined;
        if (dispatch === undefined || command === undefined) {
          throw projectionError("projection_not_found");
        }
        const existingDecision = readOutboundDecisionByCommand(
          this.ctx.storage,
          parsed.command_id,
        );
        if (existingDecision !== undefined) {
          if (
            existingDecision.idempotency_key !== parsed.idempotency_key ||
            existingDecision.decision !== parsed.decision ||
            existingDecision.actor_principal_id !== parsed.actor_principal_id ||
            existingDecision.actor_identity_id !== parsed.actor_identity_id
          ) {
            throw projectionError("projection_conflict");
          }
          return OutboundDecisionResultSchema.parse({
            command: mapOutboundCommand(parsed.tenant_id, command, dispatch),
            dispatch: mapOutboundDispatch(dispatch),
            replayed: true,
          });
        }

        const decidedMs = parseStoredMilliseconds(parsed.decided_at);
        const dueMs =
          dispatch.confirmation_due_at === null
            ? Number.NaN
            : Date.parse(dispatch.confirmation_due_at);
        if (parsed.decision === "confirm") {
          const due =
            dispatch.status === "confirmation_required" ||
            (dispatch.status === "waiting_for_connection" &&
              Number.isSafeInteger(dueMs) &&
              decidedMs >= dueMs);
          if (!due) throw projectionError("projection_conflict");
        } else if (
          dispatch.status !== "waiting_for_connection" &&
          dispatch.status !== "confirmation_required" &&
          dispatch.status !== "pending"
        ) {
          throw projectionError("projection_conflict");
        }

        const transition = transitionOutboundLifecycle({
          dispatchStatus: dispatch.status,
          commandStatus: command.status,
          confirmationDecision: parsed.decision,
          confirmationDueAt: dispatch.confirmation_due_at,
          createdAt: dispatch.created_at,
          now: parsed.decided_at,
          connectionAvailable: available,
        });
        const decisionId = `decision_outbound_${parsed.command_id}`;
        this.ctx.storage.sql.exec(
          "INSERT INTO outbound_command_decisions (id, tenant_id, command_id, dispatch_id, decision, idempotency_key, actor_principal_id, actor_identity_id, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          decisionId,
          parsed.tenant_id,
          dispatch.command_id,
          dispatch.id,
          parsed.decision,
          parsed.idempotency_key,
          parsed.actor_principal_id,
          parsed.actor_identity_id,
          parsed.decided_at,
        );
        this.ctx.storage.sql.exec(
          "UPDATE outbound_dispatches SET status = ?, confirmation_due_at = ?, confirmation_decision = ?, confirmation_actor_principal_id = ?, confirmation_actor_identity_id = ?, confirmation_decided_at = ?, updated_at = ? WHERE id = ?",
          transition.dispatchStatus,
          transition.confirmationDueAt,
          parsed.decision,
          parsed.actor_principal_id,
          parsed.actor_identity_id,
          parsed.decided_at,
          parsed.decided_at,
          dispatch.id,
        );
        this.ctx.storage.sql.exec(
          "UPDATE commands SET status = ?, updated_at = ? WHERE id = ?",
          transition.commandStatus,
          parsed.decided_at,
          command.id,
        );
        const updatedDispatch = readOutboundDispatchByCommand(
          this.ctx.storage,
          parsed.command_id,
        );
        const updatedCommand = readOutboundCommand(
          this.ctx.storage,
          parsed.command_id,
        );
        if (updatedDispatch === undefined || updatedCommand === undefined) {
          throw projectionError("projection_conflict");
        }
        return OutboundDecisionResultSchema.parse({
          command: mapOutboundCommand(
            parsed.tenant_id,
            updatedCommand,
            updatedDispatch,
          ),
          dispatch: mapOutboundDispatch(updatedDispatch),
          replayed: false,
        });
      });
      return structuredClone(result);
    } catch (error) {
      throw safeProjectionError(error, "projection_unavailable");
    }
  }

  async listOutboundCommands(
    input: ListOutboundCommandsInput,
  ): Promise<Command[]> {
    try {
      const parsed = parseProjectionInput(
        ListOutboundCommandsInputSchema,
        input,
      );
      const meta = readProjectionMeta(this.ctx.storage);
      if (meta === undefined) throw projectionError("projection_not_found");
      requireStoredTenant(meta, parsed.tenant_id);
      this.#requireReadyState(meta);
      const dispatches = this.ctx.storage.sql
        .exec<OutboundDispatchRow>(
          "SELECT id, command_id, message_id, event_id, tenant_id, actor_principal_id, actor_identity_id, resource_identity_id, account_id, connection_id, conversation_id, platform, idempotency_key, body_digest, body, delivery_mode, status, confirmation_due_at, confirmation_decision, confirmation_actor_principal_id, confirmation_actor_identity_id, confirmation_decided_at, created_at, updated_at FROM outbound_dispatches WHERE tenant_id = ? ORDER BY created_at DESC, id DESC",
          parsed.tenant_id,
        )
        .toArray();
      return structuredClone(
        dispatches.flatMap((dispatch) => {
          const command = readOutboundCommand(
            this.ctx.storage,
            dispatch.command_id,
          );
          return command === undefined
            ? []
            : [mapOutboundCommand(parsed.tenant_id, command, dispatch)];
        }),
      );
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

      const rows = readConversationRows(
        this.ctx.storage,
        parsed,
        meta.generation,
      );
      return structuredClone(
        mapConversationPage(parsed.tenant_id, meta.generation, parsed, rows),
      );
    } catch (error) {
      throw safeProjectionError(error, "projection_unavailable");
    }
  }

  async getConversation(
    input: GetProjectionConversationInput,
  ): Promise<ConversationSummary | null> {
    try {
      const parsed = parseProjectionInput(
        GetProjectionConversationInputSchema,
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

      const scope = accountScopeFilter(
        parsed.authorization,
        "account_id",
        "id",
        parsed.account_id,
      );
      const row = this.ctx.storage.sql
        .exec<ConversationQueryRow>(
          `SELECT id, identity_id, account_id, connection_id, title, last_message_preview, last_activity_at, last_activity_ms, unread_count, last_event_id FROM conversations WHERE id = ? AND identity_id = ? AND deleted_at IS NULL${scope.sql} LIMIT 1`,
          parsed.conversation_id,
          parsed.identity_id,
          ...scope.bindings,
        )
        .toArray()[0];
      const result =
        row === undefined
          ? null
          : mapConversationSummary(parsed.tenant_id, row);
      return structuredClone(
        GetProjectionConversationResultSchema.parse(result),
      );
    } catch (error) {
      throw safeProjectionError(error, "projection_unavailable");
    }
  }

  async listChannelStats(
    input: ListProjectionChannelStatsInput,
  ): Promise<ProjectionChannelStat[]> {
    try {
      const parsed = parseProjectionInput(
        ListProjectionChannelStatsInputSchema,
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

      const scope = accountScopeFilter(
        parsed.authorization,
        "conversations.account_id",
        "conversations.id",
      );
      const channelScope = accountScopeFilter(
        parsed.authorization,
        "conversations.account_id",
        "conversations.id",
      );
      const rows = this.ctx.storage.sql
        .exec<ChannelStatQueryRow>(
          `WITH channel_stats AS (SELECT connection_id, SUM(unread_count) AS unread_count, MAX(last_activity_ms) AS last_activity_ms FROM conversations WHERE identity_id = ? AND deleted_at IS NULL${scope.sql} GROUP BY connection_id) SELECT channel_stats.connection_id, channel_stats.unread_count, (SELECT conversations.last_activity_at FROM conversations WHERE conversations.identity_id = ? AND conversations.connection_id = channel_stats.connection_id AND conversations.deleted_at IS NULL AND conversations.last_activity_ms = channel_stats.last_activity_ms${channelScope.sql} ORDER BY conversations.id ASC LIMIT 1) AS last_activity_at FROM channel_stats ORDER BY channel_stats.connection_id ASC LIMIT 10001`,
          parsed.identity_id,
          ...scope.bindings,
          parsed.identity_id,
          ...channelScope.bindings,
        )
        .toArray();
      return structuredClone(mapChannelStats(rows));
    } catch (error) {
      throw safeProjectionError(error, "projection_unavailable");
    }
  }

  async getAttachment(
    input: GetProjectionAttachmentInput,
  ): Promise<ProjectionAttachment | null> {
    try {
      const parsed = parseProjectionInput(
        GetProjectionAttachmentInputSchema,
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

      const scope = accountScopeFilter(
        parsed.authorization,
        "attachments.account_id",
        "attachments.conversation_id",
        parsed.account_id,
      );
      const row = this.ctx.storage.sql
        .exec<ProjectionAttachmentQueryRow>(
          `${attachmentSelect} WHERE attachments.id = ? AND attachments.identity_id = ?${scope.sql} LIMIT 1`,
          parsed.attachment_id,
          parsed.identity_id,
          ...scope.bindings,
        )
        .toArray()[0];
      return structuredClone(
        GetProjectionAttachmentResultSchema.parse(
          row === undefined ? null : mapProjectionAttachment(row),
        ),
      );
    } catch (error) {
      throw safeProjectionError(error, "projection_unavailable");
    }
  }

  async listAttachments(
    input: ListProjectionAttachmentsInput,
  ): Promise<ProjectionAttachment[]> {
    try {
      const parsed = parseProjectionInput(
        ListProjectionAttachmentsInputSchema,
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
      if (parsed.message_ids.length === 0) return [];

      const scope = accountScopeFilter(
        parsed.authorization,
        "attachments.account_id",
        "attachments.conversation_id",
        parsed.account_id,
      );
      const rows = this.ctx.storage.sql
        .exec<ProjectionAttachmentQueryRow>(
          `${attachmentSelect} JOIN messages ON messages.id = attachments.message_id AND messages.identity_id = attachments.identity_id AND messages.account_id = attachments.account_id AND messages.connection_id = attachments.connection_id AND messages.conversation_id = attachments.conversation_id WHERE attachments.identity_id = ? AND attachments.conversation_id = ? AND attachments.message_id IN (${parsed.message_ids.map(() => "?").join(",")}) AND attachments.deleted_at IS NULL AND messages.deleted_at IS NULL${scope.sql} ORDER BY attachments.message_id ASC, attachments.id ASC LIMIT ?`,
          parsed.identity_id,
          parsed.conversation_id,
          ...parsed.message_ids,
          ...scope.bindings,
          100 * MAX_PROJECTION_PAGE_SIZE + 1,
        )
        .toArray();
      if (rows.length > 100 * MAX_PROJECTION_PAGE_SIZE) {
        throw projectionError("projection_too_large");
      }
      return structuredClone(
        ListProjectionAttachmentsResultSchema.parse(
          rows.map(mapProjectionAttachment),
        ),
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
          `SELECT id FROM conversations WHERE id = ? AND identity_id = ? AND deleted_at IS NULL${accountScopeFilter(parsed.authorization, "account_id", "id", parsed.account_id).sql}`,
          parsed.conversation_id,
          parsed.identity_id,
          ...accountScopeFilter(
            parsed.authorization,
            "account_id",
            "id",
            parsed.account_id,
          ).bindings,
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

  async searchMessages(
    input: ListProjectionMessageSearchInput,
  ): Promise<MessageSearchPageResult> {
    try {
      const parsed = parseProjectionInput(
        ListProjectionMessageSearchInputSchema,
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

      const rows = readMessageSearchRows(
        this.ctx.storage,
        parsed,
        meta.generation,
      );
      const attachmentsByMessage = readMessageSearchAttachments(
        this.ctx.storage,
        rows,
      );
      return structuredClone(
        mapMessageSearchPage(
          parsed.tenant_id,
          meta.generation,
          parsed,
          rows,
          attachmentsByMessage,
        ),
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
  async #applyPreparedBatch(
    input: ApplyPreparedBatchInput,
  ): Promise<AppliedPreparedBatch> {
    try {
      const applied = this.ctx.storage.transactionSync<AppliedPreparedBatch>(
        () => {
          const meta = readProjectionMeta(this.ctx.storage);
          if (meta === undefined) throw projectionError("projection_not_found");
          requireStoredTenant(meta, input.tenantId);
          if (input.mode === "live") {
            if (input.rebuildId !== null) {
              throw projectionError("projection_invalid");
            }
            this.#requireReadyState(meta);
          } else {
            if (meta.state === "rebuild_failed") {
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
            const replayCheckpoint =
              input.checkpointMutation as PreparedReplayCheckpointMutation | null;
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
              if (
                sameNullableString(
                  existing.source_cursor,
                  replayCheckpoint.sourceCursor,
                )
              ) {
                if (existing.page_digest === replayCheckpoint.pageDigest) {
                  return {
                    result: {
                      schema_version: 1,
                      tenant_id: input.tenantId,
                      generation: meta.generation,
                      applied_count: existing.last_applied_count ?? 0,
                      duplicate_count: existing.last_duplicate_count ?? 0,
                      last_sequence:
                        existing.last_sequence ?? this.#readLastSequence(),
                    },
                    changes: [],
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
              result: {
                schema_version: 1,
                tenant_id: input.tenantId,
                generation: meta.generation,
                applied_count: result.appliedCount,
                duplicate_count: result.duplicateCount,
                last_sequence: result.lastSequence,
              },
              changes: [],
            };
          }

          const liveCheckpoint =
            input.checkpointMutation as PreparedCheckpointMutation | null;
          if (
            liveCheckpoint !== null &&
            liveCheckpoint.kind === REPLAY_CHECKPOINT_KIND
          ) {
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
            result: {
              schema_version: 1,
              tenant_id: input.tenantId,
              generation: meta.generation,
              applied_count: result.appliedCount,
              duplicate_count: result.duplicateCount,
              last_sequence: lastSequence,
            },
            changes: result.changes,
          };
        },
      );
      if (input.mode === "live" && applied.changes.length > 0) {
        try {
          const sockets = await this.#revalidateRealtimeSockets();
          broadcastRealtimeChanges(sockets, input.tenantId, applied.changes);
        } catch {
          // A live notification failure must never change the durable result.
        }
      }
      return applied;
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
    changes: RealtimeBroadcastChange[];
  } {
    const storedEvents = this.#readAppliedEvents(preparedEvents);
    let appliedCount = 0;
    const changes: RealtimeBroadcastChange[] = [];
    const touchedConversations = new Set<string>();
    for (const prepared of preparedEvents) {
      const stored = storedEvents.get(prepared.event.event_id);
      if (stored !== undefined) {
        this.#assertStoredEventMatches(stored, prepared);
        continue;
      }

      projectEvent(prepared, this.ctx.storage.sql, touchedConversations);
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
        "INSERT INTO projection_identity_sequences (identity_id, latest_sequence) VALUES (?, 1) ON CONFLICT(identity_id) DO UPDATE SET latest_sequence = latest_sequence + 1",
        prepared.event.identity_id,
      );
      const identitySequenceRow = this.ctx.storage.sql
        .exec<{ identity_sequence: number }>(
          "SELECT latest_sequence AS identity_sequence FROM projection_identity_sequences WHERE identity_id = ?",
          prepared.event.identity_id,
        )
        .toArray()[0];
      if (identitySequenceRow === undefined) {
        throw new Error("projection identity sequence is missing");
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO projection_changes (event_id, event_type, identity_id, account_id, connection_id, conversation_id, occurred_at, observed_at, generation, identity_sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        prepared.event.event_id,
        prepared.event.event_type,
        prepared.event.identity_id,
        prepared.event.account_id,
        prepared.connection.connection_id,
        prepared.event.conversation_id,
        prepared.event.occurred_at,
        prepared.event.observed_at,
        meta.generation,
        identitySequenceRow.identity_sequence,
      );
      changes.push({
        identity_id: prepared.event.identity_id,
        generation: meta.generation,
        sequence: identitySequenceRow.identity_sequence,
        event_type: prepared.event.event_type,
        connection_id: prepared.connection.connection_id,
        conversation_id: prepared.event.conversation_id,
        occurred_at: prepared.event.occurred_at,
      });
      appliedCount += 1;
    }

    recomputeConversationSummaries(this.ctx.storage.sql, touchedConversations);

    this.#trimProjectionChanges();
    const lastSequence = this.#readLastSequence();
    return {
      appliedCount,
      duplicateCount: inputEventCount - appliedCount,
      lastSequence,
      changes,
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
      const incomingIsNewer =
        incomingHasTuple &&
        (!existingHasTuple ||
          checkpoint.lastObservedMs! > existing.last_observed_ms! ||
          (checkpoint.lastObservedMs === existing.last_observed_ms &&
            compareOpaqueEventIds(
              checkpoint.lastEventId!,
              existing.last_event_id!,
            ) > 0));
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
        "SELECT identity_id, MAX(identity_sequence) AS discarded_through_sequence FROM projection_changes WHERE sequence <= ? GROUP BY identity_id",
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
        compareOpaqueEventIds(checkpoint.lastEventId, existing.last_event_id) >
          0);
    const incomingIsEqual =
      checkpoint.lastObservedMs === existing.last_observed_ms &&
      compareOpaqueEventIds(checkpoint.lastEventId, existing.last_event_id) ===
        0;

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
