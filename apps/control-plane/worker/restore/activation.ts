import {
  CanonicalResourceIdSchema,
  ProjectionAuthorizationContextSchema,
  ProjectionConnectionBindingsSchema,
  RestoreProjectionActivationResultSchema,
  TimestampSchema,
  type ProjectionAuthorizationContext,
  type ProjectionConnectionBinding,
  type RestoreProjectionActivationResult,
} from "@communicator/contracts";
import type { RemovalAuthority } from "../../../../packages/contracts/src/removals";
import { readRestoreReplayPage } from "../archive/replay";
import { listArchivePurgeOperations } from "../archive/purge";
import { getTenantProjection } from "../projection/routing";
import type { TenantProjectionDO } from "../projection/tenant-projection";
import { randomIdentifier } from "../oauth/crypto";
import { cancelPendingWebhookDeliveriesForRemoval } from "../removals/service";
import {
  createConfiguredControlledCopyAdapters,
  type ControlledCopyAdapter,
} from "../retention";
import { loadRestoreAuthority, restoreReadinessForTenant } from "./gate";
import { createRestoreAuthorityExport } from "./authority";
import {
  acquireRestoreActivationLease,
  releaseRestoreActivationLease,
  renewRestoreActivationLease,
  type RestoreActivationLease,
} from "./lease";

type RestoreActivationDatabase = D1Database | D1DatabaseSession;

type RestoreConnectionRow = {
  account_id: string;
  connection_id: string;
  identity_id: string;
  platform: string;
};

export type RestoreProjectionActivationInput = {
  database: RestoreActivationDatabase;
  bucket: R2Bucket;
  projection: DurableObjectStub<TenantProjectionDO>;
  tenantId: string;
  principalId: string;
  rebuildId: string;
  expectedGeneration: number;
  startedAt: string;
  completedAt: string;
  connections: readonly ProjectionConnectionBinding[];
  adapters?: readonly ControlledCopyAdapter[];
  canonicalArchiveFor?: (
    authority: RemovalAuthority,
  ) => Promise<"complete" | "incomplete" | "missing">;
  now?: Date;
};

const MAX_RESTORE_REPLAY_PAGES = 100_000;

const primaryDatabase = (
  database: RestoreActivationDatabase,
): D1DatabaseSession => {
  if ("withSession" in database && typeof database.withSession === "function") {
    return database.withSession("first-primary");
  }
  return database as D1DatabaseSession;
};

const projectionAuthorization = (
  tenantId: string,
  principalId: string,
  scope: "projection.rebuild" | "projection.status",
): ProjectionAuthorizationContext =>
  ProjectionAuthorizationContextSchema.parse({
    schema_version: 1,
    tenant_id: tenantId,
    principal_id: principalId,
    allowed_identity_ids: [],
    scopes: [scope],
  });

const sameAuthority = (
  left: Awaited<ReturnType<typeof loadRestoreAuthority>>,
  right: Awaited<ReturnType<typeof loadRestoreAuthority>>,
): boolean =>
  left.tenant_id === right.tenant_id &&
  left.deletion_epoch === right.deletion_epoch &&
  JSON.stringify(left.authorities) === JSON.stringify(right.authorities);

/**
 * Read the connection bindings that a tenant-wide archive replay needs.  The
 * query includes retired account rows because an old archive can still carry
 * events from a connection that is no longer active.  The projection
 * contract rejects duplicate account mappings rather than choosing one.
 */
export const readRestoreConnectionBindings = async (
  database: RestoreActivationDatabase,
  tenantId: string,
): Promise<ProjectionConnectionBinding[]> => {
  const parsedTenantId = CanonicalResourceIdSchema.parse(tenantId);
  const rows = await primaryDatabase(database)
    .prepare(
      `SELECT ca.account_id, c.id AS connection_id, c.identity_id,
              c.provider AS platform
       FROM connection_accounts AS ca
       JOIN connections AS c ON c.id = ca.connection_id
       WHERE c.tenant_id = ?
         AND ca.status IN ('active', 'retired')
       ORDER BY ca.account_id COLLATE BINARY`,
    )
    .bind(parsedTenantId)
    .all<RestoreConnectionRow>();
  return ProjectionConnectionBindingsSchema.parse(
    rows.results.map((row) => ({
      account_id: row.account_id,
      connection_id: row.connection_id,
      identity_id: row.identity_id,
      platform: row.platform,
    })),
  );
};

const abortRebuild = async (
  projection: DurableObjectStub<TenantProjectionDO>,
  input: {
    tenantId: string;
    rebuildId: string;
    principalId: string;
    failedAt: string;
  },
): Promise<void> => {
  try {
    await projection.abortRebuild({
      schema_version: 1,
      tenant_id: input.tenantId,
      rebuild_id: input.rebuildId,
      failed_at: input.failedAt,
      failure_code: "validation_failed",
      authorization: projectionAuthorization(
        input.tenantId,
        input.principalId,
        "projection.rebuild",
      ),
    });
  } catch {
    // Preserve the original restore failure.  The projection's own lifecycle
    // state remains observable if an abort itself cannot be committed.
  }
};

/**
 * Run the real archive-to-projection restore path.  Authority and controlled
 * store readiness are loaded before beginRebuild; every page is read through
 * readRestoreReplayPage, which rechecks the primary authority after R2 I/O;
 * completeRebuild fences restored outbound rows before publishing ready.
 */
export const restoreProjectionFromArchive = async (
  input: RestoreProjectionActivationInput,
): Promise<RestoreProjectionActivationResult> => {
  const tenantId = CanonicalResourceIdSchema.parse(input.tenantId);
  const principalId = CanonicalResourceIdSchema.parse(input.principalId);
  const rebuildId = CanonicalResourceIdSchema.parse(input.rebuildId);
  const startedAt = TimestampSchema.parse(input.startedAt);
  const completedAt = TimestampSchema.parse(input.completedAt);
  if (
    !Number.isSafeInteger(input.expectedGeneration) ||
    input.expectedGeneration < 1
  ) {
    throw new Error("restore expected generation is invalid");
  }
  const connections = ProjectionConnectionBindingsSchema.parse([
    ...input.connections,
  ]);
  const database = primaryDatabase(input.database);
  const initialAuthority = await loadRestoreAuthority(database, tenantId);
  const readiness = await restoreReadinessForTenant({
    database,
    tenantId,
    ...(input.canonicalArchiveFor === undefined
      ? {}
      : { canonicalArchiveFor: input.canonicalArchiveFor }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  if (readiness.state !== "ready") {
    throw new Error("restore readiness is incomplete");
  }
  if (readiness.deletion_epoch !== initialAuthority.deletion_epoch) {
    throw new Error("restore authority changed before projection rebuild");
  }
  const authorityExport = await createRestoreAuthorityExport(
    database,
    tenantId,
    input.now ?? new Date(completedAt),
    input.adapters ?? [],
  );
  if (authorityExport.deletion_epoch !== initialAuthority.deletion_epoch) {
    throw new Error("restore authority changed before projection rebuild");
  }
  const activationLease = await acquireRestoreActivationLease(
    database,
    {
      tenantId,
      leaseId: randomIdentifier("restore_activation"),
      expectedDeletionEpoch: initialAuthority.deletion_epoch,
      expectedLedgerHead: authorityExport.ledger_head,
    },
  );
  const rebuildAuthorization = projectionAuthorization(
    tenantId,
    principalId,
    "projection.rebuild",
  );
  let begun = false;
  try {
    const status = await input.projection.getStatus({
      schema_version: 1,
      tenant_id: tenantId,
      authorization: projectionAuthorization(
        tenantId,
        principalId,
        "projection.status",
      ),
    });
    const expectedGenerationMatches =
      status.state === "rebuilding"
        ? status.rebuild_id === rebuildId &&
          status.generation === input.expectedGeneration + 1
        : status.generation === input.expectedGeneration;
    if (!expectedGenerationMatches) {
      throw new Error("projection generation changed before restore");
    }
    const replayCheckpoint =
      status.state === "rebuilding"
        ? status.checkpoints.find(
            (checkpoint) => checkpoint.kind === "r2_manifest_cursor",
          )
        : undefined;
    const replayAlreadyTerminal =
      status.state === "rebuilding" && replayCheckpoint?.value === "terminal";
    await input.projection.beginRebuild({
      schema_version: 1,
      tenant_id: tenantId,
      rebuild_id: rebuildId,
      expected_generation: input.expectedGeneration,
      started_at: startedAt,
      authorization: rebuildAuthorization,
    });
    begun = true;

    let sourceCursor: string | null =
      replayCheckpoint === undefined || replayAlreadyTerminal
        ? null
        : replayCheckpoint.value;
    let pageCount = 0;
    const removedEventIds = new Set<string>();
    const changedEventIds = new Set<string>();
    while (!replayAlreadyTerminal) {
      if (pageCount >= MAX_RESTORE_REPLAY_PAGES) {
        throw new Error("restore replay page limit exceeded");
      }
      if (
        !(await renewRestoreActivationLease(database, {
          tenantId,
          leaseId: activationLease.lease_id,
          leaseToken: activationLease.lease_token,
        }))
      ) {
        throw new Error("restore activation lease expired during replay");
      }
      const page = await readRestoreReplayPage(
        input.bucket,
        database,
        tenantId,
        sourceCursor === null ? undefined : { cursor: sourceCursor },
      );
      pageCount += 1;
      for (const eventId of page.evidence.removed_event_ids)
        removedEventIds.add(eventId);
      for (const eventId of page.evidence.changed_event_ids)
        changedEventIds.add(eventId);
      const pageAccountIds = new Set(
        page.events.map((event) => event.account_id),
      );
      const pageConnections = connections.filter((connection) =>
        pageAccountIds.has(connection.account_id),
      );
      await input.projection.applyReplayPage({
        schema_version: 1,
        tenant_id: tenantId,
        rebuild_id: rebuildId,
        source_cursor: sourceCursor,
        connections: pageConnections,
        page: {
          schema_version: 1,
          replay_mode: "projection_only",
          tenant_id: tenantId,
          manifests: page.manifests,
          events: page.events,
          next_cursor: page.next_cursor,
        },
        authorization: rebuildAuthorization,
      });
      if (page.next_cursor === null) break;
      sourceCursor = page.next_cursor;
    }

    if (
      !(await renewRestoreActivationLease(database, {
        tenantId,
        leaseId: activationLease.lease_id,
        leaseToken: activationLease.lease_token,
      }))
    ) {
      throw new Error("restore activation lease expired before activation");
    }
    const finalAuthority = await loadRestoreAuthority(database, tenantId);
    if (!sameAuthority(initialAuthority, finalAuthority)) {
      throw new Error("restore authority changed before projection activation");
    }
    const suppressionNow = input.now ?? new Date(completedAt);
    if (!Number.isFinite(suppressionNow.getTime())) {
      throw new Error("restore suppression clock is invalid");
    }
    for (const authority of finalAuthority.authorities) {
      await cancelPendingWebhookDeliveriesForRemoval(
        database,
        authority,
        suppressionNow,
      );
    }
    await input.projection.completeRebuild({
      schema_version: 1,
      tenant_id: tenantId,
      rebuild_id: rebuildId,
      terminal_cursor: null,
      completed_at: completedAt,
      authorization: rebuildAuthorization,
    });
    const projection = await input.projection.getStatus({
      schema_version: 1,
      tenant_id: tenantId,
      authorization: projectionAuthorization(
        tenantId,
        principalId,
        "projection.status",
      ),
    });
    return RestoreProjectionActivationResultSchema.parse({
      tenant_id: tenantId,
      rebuild_id: rebuildId,
      deletion_epoch: finalAuthority.deletion_epoch,
      page_count: pageCount,
      removed_event_ids: [...removedEventIds],
      changed_event_ids: [...changedEventIds],
      readiness,
      projection: structuredClone(projection),
    });
  } catch (error) {
    if (begun) {
      await abortRebuild(input.projection, {
        tenantId,
        rebuildId,
        principalId,
        failedAt: completedAt,
      });
    }
    throw error;
  } finally {
    await releaseRestoreActivationLease(database, {
      tenantId,
      leaseId: activationLease.lease_id,
      leaseToken: activationLease.lease_token,
    });
  }
};

/** Convenience entry point used by the administrator restore route. */
export const restoreTenantProjectionFromArchive = async (input: {
  env: Pick<
    Cloudflare.Env,
    "CONTROL_DB" | "EVENT_ARCHIVE" | "TENANT_PROJECTION"
  >;
  tenantId: string;
  principalId: string;
  rebuildId: string;
  expectedGeneration: number;
  startedAt: string;
  completedAt: string;
  now?: Date;
}): Promise<RestoreProjectionActivationResult> => {
  const database = input.env.CONTROL_DB;
  if (database === undefined || typeof database.withSession !== "function") {
    throw new Error("restore control database unavailable");
  }
  const tenantId = CanonicalResourceIdSchema.parse(input.tenantId);
  const operations = await listArchivePurgeOperations(
    database.withSession("first-primary"),
    tenantId,
  );
  const connections = await readRestoreConnectionBindings(database, tenantId);
  const adapters = createConfiguredControlledCopyAdapters(
    input.env as unknown as Record<string, unknown>,
  );
  return restoreProjectionFromArchive({
    database,
    bucket: input.env.EVENT_ARCHIVE,
    projection: getTenantProjection(input.env, tenantId),
    tenantId,
    principalId: input.principalId,
    rebuildId: input.rebuildId,
    expectedGeneration: input.expectedGeneration,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    connections,
    adapters,
    canonicalArchiveFor: async (authority) => {
      const operation = operations.find(
        (candidate) => candidate.removal_id === authority.id,
      );
      return operation?.status === "complete"
        ? "complete"
        : operation === undefined
          ? "missing"
          : "incomplete";
    },
    ...(input.now === undefined ? {} : { now: input.now }),
  });
};
