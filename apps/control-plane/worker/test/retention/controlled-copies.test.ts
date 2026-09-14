import { env } from "cloudflare:workers";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  CONTROLLED_COPY_CLEANUP_MARGIN_MS,
  CONTROLLED_COPY_MAX_AGE_MS,
  type ControlledCopyEvidenceInput,
} from "@communicator/contracts";
import {
  createBridgeDatabaseAdapter,
  createMediaStoreAdapter,
  createProjectionBackupAdapter,
  createQueueAdapter,
  createResticSnapshotAdapter,
  createSessionCredentialAdapter,
  createSynapseAdapter,
  type ControlledCopyAdapter,
  type RetentionStoreBackend,
} from "../../retention/adapters";
import { CONTROLLED_COPY_RETENTION_SCHEMA } from "../../retention/schema";
import {
  createControlledCopyRetentionPlan,
  controlledCopyDeadlines,
  evaluateControlledCopyCompletion,
  readControlledCopyEvidence,
  readControlledCopyOperations,
  runControlledCopyRetentionWorker,
} from "../../retention/service";

const workerEnv = env as typeof env & { CONTROL_DB: D1Database };
const fixedNow = new Date("2026-09-14T00:00:00.000Z");
const lineage = {
  tenant_id: "tenant_pilot",
  removal_id: "removal_message_one",
  resource_type: "message",
  resource_id: "message_one",
  content_generation: "message_one_generation",
  deletion_epoch: 7,
};

const fixtureAt = (fixtures: Fixture[], index: number): Fixture => {
  const fixture = fixtures[index];
  if (fixture === undefined) throw new Error(`missing fixture ${index}`);
  return fixture;
};

type Fixture = {
  backend: RetentionStoreBackend;
  references: Set<string>;
  cleanup: ReturnType<typeof vi.fn>;
};

const fixtureBackend = ({
  reference,
  copyCreatedAt = new Date(fixedNow.getTime() - 2 * 24 * 60 * 60 * 1_000),
  outcome = {
    status: "deleted",
    content_present: false,
    evidence_source: "controlled_fixture",
    object_reference: reference,
    detail: "fixture verified the copy is absent",
  } satisfies ControlledCopyEvidenceInput,
  delayMs = 0,
}: {
  reference: string;
  copyCreatedAt?: Date;
  outcome?: ControlledCopyEvidenceInput;
  delayMs?: number;
}): Fixture => {
  const references = new Set([reference]);
  const cleanup = vi.fn(async () => {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (outcome.status === "deleted") references.delete(reference);
    return outcome;
  });
  return {
    references,
    cleanup,
    backend: {
      inventory: async () => ({
        complete: true,
        copies: [
          {
            reference,
            copy_created_at: copyCreatedAt,
            resource_id: lineage.resource_id,
            content_generation: lineage.content_generation,
          },
        ],
        evidence_source: "controlled_fixture_inventory",
      }),
      cleanup,
    },
  };
};

const requiredAdapters = ({
  copyCreatedAt,
  delayMs = 0,
  resticOutcome,
}: {
  copyCreatedAt?: Date;
  delayMs?: number;
  resticOutcome?: ControlledCopyEvidenceInput;
} = {}): {
  adapters: ControlledCopyAdapter[];
  fixtures: Fixture[];
} => {
  const copyDate =
    copyCreatedAt ?? new Date(fixedNow.getTime() - 2 * 24 * 60 * 60 * 1_000);
  const fixtures = [
    fixtureBackend({
      reference: "projection_backup:message_one",
      copyCreatedAt: copyDate,
      delayMs,
    }),
    fixtureBackend({
      reference: "synapse:message_one",
      copyCreatedAt: copyDate,
      delayMs,
    }),
    fixtureBackend({
      reference: "bridge_mapping:message_one",
      copyCreatedAt: copyDate,
      delayMs,
    }),
    fixtureBackend({
      reference: "media:attachment_one",
      copyCreatedAt: copyDate,
      delayMs,
    }),
    fixtureBackend({
      reference: "queue:item_one",
      copyCreatedAt: copyDate,
      delayMs,
    }),
    fixtureBackend({
      reference: "restic:snapshot_one",
      copyCreatedAt: copyDate,
      ...(resticOutcome === undefined ? {} : { outcome: resticOutcome }),
      delayMs,
    }),
  ];
  return {
    fixtures,
    adapters: [
      createProjectionBackupAdapter(fixtureAt(fixtures, 0).backend),
      createSynapseAdapter(fixtureAt(fixtures, 1).backend),
      createBridgeDatabaseAdapter(fixtureAt(fixtures, 2).backend),
      createMediaStoreAdapter(fixtureAt(fixtures, 3).backend),
      createQueueAdapter(fixtureAt(fixtures, 4).backend),
      createResticSnapshotAdapter(fixtureAt(fixtures, 5).backend),
    ],
  };
};

const addRetentionSchema = async (): Promise<void> => {
  await workerEnv.CONTROL_DB.batch(
    CONTROLLED_COPY_RETENTION_SCHEMA.map((statement) =>
      workerEnv.CONTROL_DB.prepare(statement),
    ),
  );
  await workerEnv.CONTROL_DB.batch([
    workerEnv.CONTROL_DB.prepare("DELETE FROM controlled_copy_evidence"),
    workerEnv.CONTROL_DB.prepare("DELETE FROM controlled_copy_operations"),
  ]);
};

describe("controlled-copy retention", () => {
  beforeEach(async () => {
    await addRetentionSchema();
  });

  it("inventories and deletes every controlled store with durable evidence", async () => {
    const { adapters, fixtures } = requiredAdapters();
    const plan = await createControlledCopyRetentionPlan({
      database: workerEnv.CONTROL_DB,
      lineage,
      adapters,
      now: fixedNow,
    });

    expect(plan.operations).toHaveLength(8);
    expect(plan.operations.map((operation) => operation.store).sort()).toEqual([
      "account_keys",
      "bridge_database",
      "media_store",
      "projection_backup",
      "queue",
      "restic_snapshot",
      "session_credentials",
      "synapse",
    ]);
    for (const operation of plan.operations) {
      expect(operation.removal_id).toBe(lineage.removal_id);
      expect(operation.content_generation).toBe(lineage.content_generation);
      expect(operation.deletion_epoch).toBe(lineage.deletion_epoch);
      expect(Date.parse(operation.retention_deadline)).toBe(
        Date.parse(operation.copy_created_at) + CONTROLLED_COPY_MAX_AGE_MS,
      );
      expect(operation.cleanup_margin_ms).toBe(
        CONTROLLED_COPY_CLEANUP_MARGIN_MS,
      );
      expect(Date.parse(operation.retention_deadline)).toBeGreaterThan(
        Date.parse(operation.cleanup_deadline),
      );
    }

    const worker = await runControlledCopyRetentionWorker({
      database: workerEnv.CONTROL_DB,
      adapters,
      now: fixedNow,
    });
    expect(worker.claimed).toBe(8);
    expect(worker.complete).toHaveLength(6);
    expect(worker.incomplete).toHaveLength(2);
    expect(fixtures.every((fixture) => fixture.references.size === 0)).toBe(
      true,
    );

    const evidence = await readControlledCopyEvidence(
      workerEnv.CONTROL_DB,
      lineage.tenant_id,
      lineage.removal_id,
    );
    expect(evidence).toHaveLength(10);
    expect(new Set(evidence.map((item) => item.operation_id)).size).toBe(8);
    const requiredStoreNames = new Set([
      "projection_backup",
      "synapse",
      "bridge_database",
      "media_store",
      "queue",
      "restic_snapshot",
    ]);
    expect(
      evidence
        .filter((item) => requiredStoreNames.has(item.store))
        .every((item) => item.content_present === false),
    ).toBe(true);
    expect(
      evidence
        .filter((item) => !requiredStoreNames.has(item.store))
        .every((item) => item.content_present === true),
    ).toBe(true);

    const withoutArchive = await evaluateControlledCopyCompletion({
      database: workerEnv.CONTROL_DB,
      tenantId: lineage.tenant_id,
      removalId: lineage.removal_id,
      resourceId: lineage.resource_id,
      contentGeneration: lineage.content_generation,
      deletionEpoch: lineage.deletion_epoch,
      canonicalArchive: "missing",
      now: fixedNow,
    });
    expect(withoutArchive.status).toBe("incomplete");
    expect(withoutArchive.alerts).toContain(
      "canonical_archive_evidence_missing",
    );

    const complete = await evaluateControlledCopyCompletion({
      database: workerEnv.CONTROL_DB,
      tenantId: lineage.tenant_id,
      removalId: lineage.removal_id,
      resourceId: lineage.resource_id,
      contentGeneration: lineage.content_generation,
      deletionEpoch: lineage.deletion_epoch,
      canonicalArchive: "complete",
      now: fixedNow,
    });
    expect(complete.status).toBe("complete");
    expect(complete.completed_stores).toHaveLength(6);
  });

  it("keeps the cleanup margin and hard age boundary visible", async () => {
    const atCleanupBoundary = new Date(
      fixedNow.getTime() -
        (CONTROLLED_COPY_MAX_AGE_MS - CONTROLLED_COPY_CLEANUP_MARGIN_MS),
    );
    expect(
      controlledCopyDeadlines(atCleanupBoundary.toISOString()),
    ).toMatchObject({
      cleanup_deadline: fixedNow.toISOString(),
    });
    const lateCopy = new Date(atCleanupBoundary.getTime() - 1_000);
    const { adapters } = requiredAdapters({ copyCreatedAt: lateCopy });
    await createControlledCopyRetentionPlan({
      database: workerEnv.CONTROL_DB,
      lineage,
      adapters,
      now: fixedNow,
    });
    await runControlledCopyRetentionWorker({
      database: workerEnv.CONTROL_DB,
      adapters,
      now: fixedNow,
    });
    const late = await evaluateControlledCopyCompletion({
      database: workerEnv.CONTROL_DB,
      tenantId: lineage.tenant_id,
      removalId: lineage.removal_id,
      resourceId: lineage.resource_id,
      contentGeneration: lineage.content_generation,
      deletionEpoch: lineage.deletion_epoch,
      canonicalArchive: "complete",
      now: fixedNow,
    });
    expect(late.status).toBe("incomplete");
    expect(late.alerts).toContain(
      "controlled_copy_projection_backup_cleanup_deadline_missed",
    );
    expect(late.incomplete_stores).toContain("projection_backup");

    const pastHardDeadline = new Date(
      fixedNow.getTime() - CONTROLLED_COPY_MAX_AGE_MS - 1_000,
    );
    const hardLineage = { ...lineage, removal_id: "removal_hard_deadline" };
    const hard = requiredAdapters({ copyCreatedAt: pastHardDeadline });
    await createControlledCopyRetentionPlan({
      database: workerEnv.CONTROL_DB,
      lineage: hardLineage,
      adapters: hard.adapters,
      now: fixedNow,
    });
    const hardWorker = await runControlledCopyRetentionWorker({
      database: workerEnv.CONTROL_DB,
      adapters: hard.adapters,
      now: fixedNow,
    });
    expect(hardWorker.failed).toHaveLength(6);
    const hardResult = await evaluateControlledCopyCompletion({
      database: workerEnv.CONTROL_DB,
      tenantId: hardLineage.tenant_id,
      removalId: hardLineage.removal_id,
      resourceId: hardLineage.resource_id,
      contentGeneration: hardLineage.content_generation,
      deletionEpoch: hardLineage.deletion_epoch,
      canonicalArchive: "complete",
      now: fixedNow,
    });
    expect(hardResult.status).toBe("incomplete");
    expect(hardResult.alerts).toContain(
      "controlled_copy_projection_backup_hard_deadline_missed",
    );
  });

  it("claims a duplicate worker only once per copy", async () => {
    const { adapters, fixtures } = requiredAdapters({ delayMs: 20 });
    await createControlledCopyRetentionPlan({
      database: workerEnv.CONTROL_DB,
      lineage,
      adapters,
      now: fixedNow,
    });
    const [first, second] = await Promise.all([
      runControlledCopyRetentionWorker({
        database: workerEnv.CONTROL_DB,
        adapters,
        now: fixedNow,
      }),
      runControlledCopyRetentionWorker({
        database: workerEnv.CONTROL_DB,
        adapters,
        now: fixedNow,
      }),
    ]);
    expect(first.claimed + second.claimed).toBe(8);
    expect(
      fixtures.every((fixture) => fixture.cleanup.mock.calls.length === 1),
    ).toBe(true);
    const operations = await readControlledCopyOperations(
      workerEnv.CONTROL_DB,
      lineage.tenant_id,
      lineage.removal_id,
    );
    expect(
      operations
        .filter((operation) => operation.required)
        .every((operation) => operation.status === "complete"),
    ).toBe(true);
    expect(
      operations
        .filter((operation) => !operation.required)
        .every((operation) => operation.status === "incomplete"),
    ).toBe(true);
  });

  it("keeps unavailable stores incomplete and reports provider lifecycle lag", async () => {
    const lifecyclePending: ControlledCopyEvidenceInput = {
      status: "lifecycle_pending",
      content_present: true,
      evidence_source: "restic_fixture",
      object_reference: "restic:snapshot_one",
      detail: "Restic forget was requested but prune evidence is unavailable",
    };
    const { adapters } = requiredAdapters({ resticOutcome: lifecyclePending });
    const withoutRestic = adapters.slice(0, 5);
    const plan = await createControlledCopyRetentionPlan({
      database: workerEnv.CONTROL_DB,
      lineage,
      adapters: withoutRestic,
      now: fixedNow,
    });
    expect(plan.inventory_errors).toContainEqual({
      store: "restic_snapshot",
      error: "No controlled cleanup adapter is configured",
    });
    await runControlledCopyRetentionWorker({
      database: workerEnv.CONTROL_DB,
      adapters: withoutRestic,
      now: fixedNow,
    });
    const unavailable = await evaluateControlledCopyCompletion({
      database: workerEnv.CONTROL_DB,
      tenantId: lineage.tenant_id,
      removalId: lineage.removal_id,
      resourceId: lineage.resource_id,
      contentGeneration: lineage.content_generation,
      deletionEpoch: lineage.deletion_epoch,
      canonicalArchive: "complete",
      now: fixedNow,
    });
    expect(unavailable.status).toBe("incomplete");
    expect(unavailable.incomplete_stores).toContain("restic_snapshot");
    expect(unavailable.alerts).toContain(
      "controlled_copy_restic_snapshot_incomplete",
    );

    const lagLineage = { ...lineage, removal_id: "removal_restic_lag" };
    const lag = requiredAdapters({ resticOutcome: lifecyclePending });
    await createControlledCopyRetentionPlan({
      database: workerEnv.CONTROL_DB,
      lineage: lagLineage,
      adapters: lag.adapters,
      now: fixedNow,
    });
    await runControlledCopyRetentionWorker({
      database: workerEnv.CONTROL_DB,
      adapters: lag.adapters,
      now: fixedNow,
    });
    const evidence = await readControlledCopyEvidence(
      workerEnv.CONTROL_DB,
      lagLineage.tenant_id,
      lagLineage.removal_id,
    );
    expect(
      evidence.find((item) => item.store === "restic_snapshot"),
    ).toMatchObject({ status: "lifecycle_pending", content_present: true });
  });

  it("refuses to age out a restic snapshot that mixes message and key material", async () => {
    const fixture = fixtureBackend({ reference: "restic:mixed_snapshot" });
    const mixedRestic = createResticSnapshotAdapter({
      ...fixture.backend,
      inventory: async () => ({
        complete: true,
        copies: [
          {
            reference: "restic:mixed_snapshot",
            copy_created_at: new Date(
              fixedNow.getTime() - 2 * 24 * 60 * 60 * 1_000,
            ),
            resource_id: lineage.resource_id,
            content_generation: lineage.content_generation,
            content_classes: ["message", "account_key"],
          },
        ],
        evidence_source: "restic_mixed_snapshot_inventory",
      }),
    });
    const { adapters } = requiredAdapters();
    const withMixedRestic = [
      ...adapters.filter((adapter) => adapter.store !== "restic_snapshot"),
      mixedRestic,
    ];
    const plan = await createControlledCopyRetentionPlan({
      database: workerEnv.CONTROL_DB,
      lineage,
      adapters: withMixedRestic,
      now: fixedNow,
    });
    expect(plan.inventory_errors).toContainEqual({
      store: "restic_snapshot",
      error:
        "controlled copy inventory must isolate content classes per reference",
    });
    await runControlledCopyRetentionWorker({
      database: workerEnv.CONTROL_DB,
      adapters: withMixedRestic,
      now: fixedNow,
    });
    expect(fixture.cleanup).not.toHaveBeenCalled();
    const result = await evaluateControlledCopyCompletion({
      database: workerEnv.CONTROL_DB,
      tenantId: lineage.tenant_id,
      removalId: lineage.removal_id,
      resourceId: lineage.resource_id,
      contentGeneration: lineage.content_generation,
      deletionEpoch: lineage.deletion_epoch,
      canonicalArchive: "complete",
      now: fixedNow,
    });
    expect(result.status).toBe("incomplete");
    expect(result.incomplete_stores).toContain("restic_snapshot");
  });

  it("does not infer missing copy lineage from the requested removal", async () => {
    const fixture = fixtureBackend({ reference: "synapse:missing-lineage" });
    const missingLineage = createSynapseAdapter({
      ...fixture.backend,
      inventory: async () => ({
        complete: true,
        copies: [
          {
            reference: "synapse:missing-lineage",
            copy_created_at: fixedNow,
          },
        ],
        evidence_source: "synapse_missing_lineage_inventory",
      }),
    });
    const { adapters } = requiredAdapters();
    const plan = await createControlledCopyRetentionPlan({
      database: workerEnv.CONTROL_DB,
      lineage,
      adapters: [
        ...adapters.filter((adapter) => adapter.store !== "synapse"),
        missingLineage,
      ],
      now: fixedNow,
    });
    expect(plan.inventory_errors).toContainEqual({
      store: "synapse",
      error:
        "controlled copy inventory copy must publish exact resource lineage",
    });
  });

  it("keeps an incomplete inventory gap visible after known copies are cleaned", async () => {
    const fixture = fixtureBackend({ reference: "media:attachment_one" });
    const mediaAdapter = createMediaStoreAdapter({
      ...fixture.backend,
      inventory: async () => ({
        complete: false,
        copies: [
          {
            reference: "media:attachment_one",
            copy_created_at: new Date(
              fixedNow.getTime() - 2 * 24 * 60 * 60 * 1_000,
            ),
            resource_id: lineage.resource_id,
            content_generation: lineage.content_generation,
          },
        ],
        evidence_source: "media_partial_inventory",
        detail: "The provider could not enumerate every media prefix",
      }),
    });
    const { adapters } = requiredAdapters();
    const plan = await createControlledCopyRetentionPlan({
      database: workerEnv.CONTROL_DB,
      lineage,
      adapters: [
        ...adapters.filter((adapter) => adapter.store !== "media_store"),
        mediaAdapter,
      ],
      now: fixedNow,
    });
    expect(plan.inventory_errors).toContainEqual({
      store: "media_store",
      error: "The provider could not enumerate every media prefix",
    });
    expect(
      plan.operations.filter((operation) => operation.store === "media_store"),
    ).toHaveLength(2);

    await runControlledCopyRetentionWorker({
      database: workerEnv.CONTROL_DB,
      adapters: [
        ...adapters.filter((adapter) => adapter.store !== "media_store"),
        mediaAdapter,
      ],
      now: fixedNow,
    });
    const result = await evaluateControlledCopyCompletion({
      database: workerEnv.CONTROL_DB,
      tenantId: lineage.tenant_id,
      removalId: lineage.removal_id,
      resourceId: lineage.resource_id,
      contentGeneration: lineage.content_generation,
      deletionEpoch: lineage.deletion_epoch,
      canonicalArchive: "complete",
      now: fixedNow,
    });
    expect(result.status).toBe("incomplete");
    expect(result.incomplete_stores).toContain("media_store");
    expect(fixture.cleanup).toHaveBeenCalledTimes(1);
  });

  it("preserves session credentials as a separate auxiliary lifecycle", async () => {
    const { adapters } = requiredAdapters();
    const session = fixtureBackend({
      reference: "session:key_one",
      outcome: {
        status: "preserved",
        content_present: true,
        evidence_source: "session_key_store",
        object_reference: "session:key_one",
        detail: "Session key lifecycle is independent of message removal",
      },
    });
    const sessionAdapter = createSessionCredentialAdapter(session.backend);
    const withSession = [...adapters, sessionAdapter];
    await createControlledCopyRetentionPlan({
      database: workerEnv.CONTROL_DB,
      lineage,
      adapters: withSession,
      now: fixedNow,
    });
    await runControlledCopyRetentionWorker({
      database: workerEnv.CONTROL_DB,
      adapters: withSession,
      now: fixedNow,
    });
    expect(session.references).toEqual(new Set(["session:key_one"]));
    const result = await evaluateControlledCopyCompletion({
      database: workerEnv.CONTROL_DB,
      tenantId: lineage.tenant_id,
      removalId: lineage.removal_id,
      resourceId: lineage.resource_id,
      contentGeneration: lineage.content_generation,
      deletionEpoch: lineage.deletion_epoch,
      canonicalArchive: "complete",
      now: fixedNow,
    });
    expect(result.status).toBe("complete");
    expect(result.auxiliary_operations).toHaveLength(2);
    expect(
      result.auxiliary_operations.find(
        (operation) => operation.store === "session_credentials",
      ),
    ).toMatchObject({
      store: "session_credentials",
      status: "preserved",
      required: false,
      deletion_method: "preserve",
    });
    expect(
      result.auxiliary_operations.find(
        (operation) => operation.store === "account_keys",
      ),
    ).toMatchObject({
      store: "account_keys",
      status: "incomplete",
      required: false,
      deletion_method: "preserve",
    });
    expect(
      (
        await readControlledCopyEvidence(
          workerEnv.CONTROL_DB,
          lineage.tenant_id,
          lineage.removal_id,
        )
      ).find((item) => item.store === "session_credentials"),
    ).toMatchObject({ status: "preserved", content_present: true });
  });
});
