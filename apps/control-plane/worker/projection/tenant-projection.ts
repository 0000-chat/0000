import {
  ApplyProjectionBatchInputSchema,
  compareOpaqueEventIds,
  MAX_PROJECTION_CHANGES,
  MAX_PROJECTION_BATCH_EVENTS,
  type ApplyProjectionBatchInput,
  type ApplyProjectionBatchResult,
  InitializeProjectionInputSchema,
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
import {
  ProjectionError,
  projectionError,
  safeProjectionError,
} from "./errors";
import {
  prepareProjectionBatch,
  projectEvent,
  type PreparedCheckpointMutation,
  type PreparedProjectionEvent,
} from "./projector";
import { runProjectionMigrations } from "./schema";

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
  readonly checkpointMutation: PreparedCheckpointMutation | null;
  readonly inputEventCount: number;
  readonly connections: readonly ProjectionConnectionBinding[];
};

type ProjectionCountRow = {
  applied_event_count: number;
  conversation_count: number;
  message_count: number;
  latest_change_sequence: number;
};

type ProjectionSchemaGenerationRow = { schema_generation: number | null };

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

const parseApplyProjectionBatchInput = (
  input: unknown,
): ApplyProjectionBatchInput => {
  if (hasOversizedApplyEventArray(input)) {
    throw projectionError("projection_too_large");
  }
  return parseProjectionInput(ApplyProjectionBatchInputSchema, input);
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
      this.requireAuthorization(
        parsed.tenant_id,
        parsed.authorization,
        "projection.initialize",
      );

      const existing = this.readProjectionMeta();
      if (existing !== undefined) {
        this.requireStoredTenant(existing, parsed.tenant_id);
        return this.readStatusForMeta(existing);
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

      const created = this.readProjectionMeta();
      if (created === undefined) throw new Error("projection metadata was not created");
      this.requireStoredTenant(created, parsed.tenant_id);
      return this.readStatusForMeta(created);
    } catch (error) {
      throw safeProjectionError(error, "projection_unavailable");
    }
  }

  async getStatus(input: ProjectionStatusInput): Promise<ProjectionStatus> {
    try {
      const parsed = parseProjectionInput(ProjectionStatusInputSchema, input);
      this.requireAuthorization(
        parsed.tenant_id,
        parsed.authorization,
        "projection.status",
      );

      const meta = this.readProjectionMeta();
      if (meta === undefined) throw projectionError("projection_not_found");
      this.requireStoredTenant(meta, parsed.tenant_id);
      return this.readStatusForMeta(meta);
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
      this.requireAuthorization(
        parsed.tenant_id,
        parsed.authorization,
        "projection.write",
      );

      const meta = this.readProjectionMeta();
      if (meta === undefined) throw projectionError("projection_not_found");
      this.requireStoredTenant(meta, parsed.tenant_id);
      this.requireReadyState(meta);

      const prepared = await prepareProjectionBatch(parsed);
      return this.applyPreparedBatch({
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
   * The sole owner of a multi-table projection transaction. Replay will use
   * this private path in a later task; the public applyBatch schema remains
   * deliberately live-only in this phase.
   */
  private applyPreparedBatch(
    input: ApplyPreparedBatchInput,
  ): ApplyProjectionBatchResult {
    try {
      return this.ctx.storage.transactionSync(() => {
        if (input.mode !== "live" || input.rebuildId !== null) {
          throw projectionError("projection_invalid");
        }

        const meta = this.readProjectionMeta();
        if (meta === undefined) throw projectionError("projection_not_found");
        this.requireStoredTenant(meta, input.tenantId);
        this.requireReadyState(meta);

        this.ensurePersistentBindings(input.connections);

        const storedEvents = this.readAppliedEvents(
          input.preparedEvents,
        );
        let appliedCount = 0;
        for (const prepared of input.preparedEvents) {
          const stored = storedEvents.get(prepared.event.event_id);
          if (stored !== undefined) {
            this.assertStoredEventMatches(stored, prepared);
            continue;
          }

          projectEvent(prepared, this.ctx.storage.sql);
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

        this.trimProjectionChanges();
        const lastSequence = this.readLastSequence();
        this.applyLiveCheckpoint(input.checkpointMutation, meta, lastSequence);

        return {
          schema_version: 1,
          tenant_id: input.tenantId,
          generation: meta.generation,
          applied_count: appliedCount,
          duplicate_count: input.inputEventCount - appliedCount,
          last_sequence: lastSequence,
        };
      });
    } catch (error) {
      if (error instanceof ProjectionError) throw error;
      throw projectionError("projection_unavailable", error);
    }
  }

  private requireReadyState(meta: ProjectionMetaRow): void {
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

  private ensurePersistentBindings(
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

  private readAppliedEvents(
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

  private assertStoredEventMatches(
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

  private readLastSequence(): number {
    const row = this.ctx.storage.sql
      .exec<{ last_sequence: number }>(
        "SELECT COALESCE(MAX(sequence), 0) AS last_sequence FROM projection_changes",
      )
      .toArray()[0];
    if (row === undefined) throw new Error("projection sequence is missing");
    return row.last_sequence;
  }

  private trimProjectionChanges(): void {
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

  private applyLiveCheckpoint(
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

  /** Synchronous guard used by every RPC entry point as it is added. */
  private requireAuthorization(
    inputTenantId: string,
    authorization: ProjectionAuthorizationContext,
    requiredScope: ProjectionScope,
  ): void {
    if (authorization.tenant_id !== inputTenantId) {
      throw projectionError("projection_tenant_mismatch");
    }
    if (!authorization.scopes.includes(requiredScope)) {
      throw projectionError("projection_forbidden");
    }
  }

  /** Synchronous guard for the durable tenant binding. */
  private requireStoredTenant(
    meta: ProjectionMetaRow,
    inputTenantId: string,
  ): void {
    if (meta.tenant_id !== inputTenantId) {
      throw projectionError("projection_tenant_mismatch");
    }
  }

  private readProjectionMeta(): ProjectionMetaRow | undefined {
    return this.ctx.storage.sql
      .exec<ProjectionMetaRow>(
        "SELECT singleton, tenant_id, state, generation, rebuild_id, rebuild_started_at, last_completed_rebuild_id, last_failed_rebuild_id, last_rebuild_failure_code, initialized_at, updated_at FROM projection_meta WHERE singleton = 1",
      )
      .toArray()[0];
  }

  private readStatusForMeta(meta: ProjectionMetaRow): ProjectionStatus {
    const schemaGeneration = this.ctx.storage.sql
      .exec<ProjectionSchemaGenerationRow>(
        "SELECT MAX(version) AS schema_generation FROM _sql_schema_migrations",
      )
      .toArray()[0]?.schema_generation;
    if (schemaGeneration === null || schemaGeneration === undefined) {
      throw new Error("projection schema generation is missing");
    }

    const counts = this.ctx.storage.sql
      .exec<ProjectionCountRow>(
        "SELECT (SELECT COUNT(*) FROM applied_events) AS applied_event_count, (SELECT COUNT(*) FROM conversations) AS conversation_count, (SELECT COUNT(*) FROM messages) AS message_count, COALESCE((SELECT MAX(sequence) FROM projection_changes), 0) AS latest_change_sequence",
      )
      .toArray()[0];
    if (counts === undefined) throw new Error("projection status counts are missing");

    const checkpoints = this.ctx.storage.sql
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
  }
}
