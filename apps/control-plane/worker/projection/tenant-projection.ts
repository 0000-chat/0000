import {
  InitializeProjectionInputSchema,
  ProjectionStatusInputSchema,
  type InitializeProjectionInput,
  type ProjectionAuthorizationContext,
  type ProjectionScope,
  type ProjectionStatus,
  type ProjectionStatusCheckpoint,
  type ProjectionStatusInput,
} from "@communicator/contracts";
import { DurableObject } from "cloudflare:workers";
import {
  ProjectionError,
  projectionError,
  safeProjectionError,
} from "./errors";
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
