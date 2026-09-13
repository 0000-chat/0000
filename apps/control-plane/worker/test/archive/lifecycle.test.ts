import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { CanonicalEventEnvelope } from "@communicator/contracts";
import { recordRemovalWithSuppression } from "../../removals/service";
import {
  purgeRecordedRemoval,
  readArchiveStatusForRemoval,
  recordRemovalWithArchivePurge,
  runRemovalExpiryAndArchive,
} from "../../archive/lifecycle";
import { readReplayPage } from "../../archive/reader";
import { archiveCanonicalEventBatch } from "../../archive/writer";
import worker from "../../index";
import { cleanupArchiveTenant, makeArchiveScope, makeEvent } from "./support";

const workerEnv = env as Cloudflare.Env & { CONTROL_DB: D1Database };
const bucket = (env as Cloudflare.Env).EVENT_ARCHIVE;
const activeTenants: string[] = [];
const fixedNow = new Date("2026-09-14T00:00:00.000Z");

type ArchiveScope = ReturnType<typeof makeArchiveScope>;

const newScope = (): ArchiveScope => {
  const scope = makeArchiveScope();
  activeTenants.push(scope.tenantId);
  return scope;
};

const eventFor = (
  scope: ArchiveScope,
  messageId: string,
  eventId: string,
): CanonicalEventEnvelope =>
  makeEvent({
    tenant_id: scope.tenantId,
    account_id: "account_lifecycle",
    conversation_id: "conversation_lifecycle",
    event_id: eventId,
    payload: { message_id: messageId, body: `body-${messageId}` },
  });

const seed = async (
  scope: ArchiveScope,
  events: readonly CanonicalEventEnvelope[],
  batchId: string,
) =>
  archiveCanonicalEventBatch({
    bucket,
    tenantId: scope.tenantId,
    batchId,
    events,
    archivedAt: fixedNow.toISOString(),
    producerVersion: "archive-lifecycle-test/1",
    sourceCheckpoint: null,
  });

const inputFor = (
  scope: ArchiveScope,
  resourceId: string,
  removedAt = fixedNow,
) => ({
  tenant_id: scope.tenantId,
  resource_type: "message" as const,
  resource_id: resourceId,
  content_generation: resourceId,
  account_id: "account_lifecycle",
  conversation_id: "conversation_lifecycle",
  source_event_id: null,
  source_object_key: null,
  reason: "requested" as const,
  removed_at: removedAt.toISOString(),
});

const lifecycleFor = (bucketOverride: R2Bucket = bucket) => ({
  database: workerEnv.CONTROL_DB,
  bucket: bucketOverride,
  safetyWindowMs: 0,
});

const runRegisteredScheduler = async (): Promise<void> => {
  const waits: Promise<unknown>[] = [];
  const scheduled = worker.scheduled;
  if (scheduled === undefined) throw new Error("scheduler not registered");
  await scheduled({} as ScheduledController, workerEnv, {
    waitUntil(promise: Promise<unknown>) {
      waits.push(promise);
    },
  } as ExecutionContext);
  await Promise.all(waits);
};

afterEach(async () => {
  await Promise.all(
    activeTenants
      .splice(0, activeTenants.length)
      .map((tenantId) => cleanupArchiveTenant(bucket, tenantId)),
  );
  await workerEnv.CONTROL_DB.batch([
    workerEnv.CONTROL_DB.prepare(
      "DELETE FROM archive_purge_locks WHERE tenant_id LIKE 'tenant_writer_%'",
    ),
    workerEnv.CONTROL_DB.prepare(
      "DELETE FROM archive_purge_objects WHERE tenant_id LIKE 'tenant_writer_%'",
    ),
    workerEnv.CONTROL_DB.prepare(
      "DELETE FROM archive_purge_operations WHERE tenant_id LIKE 'tenant_writer_%'",
    ),
    workerEnv.CONTROL_DB.prepare(
      "DELETE FROM removal_authority WHERE tenant_id LIKE 'tenant_writer_%'",
    ),
  ]);
});

describe("authorized archive removal lifecycle", () => {
  it("records suppression, purges through the application lifecycle, and exposes durable completion", async () => {
    const scope = newScope();
    const removed = eventFor(
      scope,
      "message_lifecycle_complete",
      "$lifecycle-complete:server",
    );
    await seed(scope, [removed], "batch_lifecycle_complete");

    const result = await recordRemovalWithArchivePurge(
      lifecycleFor(),
      inputFor(scope, "message_lifecycle_complete"),
      fixedNow,
    );

    expect(result.authority.status).toBe("active");
    expect(result.archive.operation.status).toBe("complete");
    await expect(
      readArchiveStatusForRemoval(
        lifecycleFor(),
        scope.tenantId,
        result.authority.id,
      ),
    ).resolves.toMatchObject({ operation: { status: "complete" } });
    await expect(readReplayPage(bucket, scope.tenantId)).resolves.toMatchObject(
      { events: [], manifests: [] },
    );
  });

  it("keeps archive work visibly incomplete after storage lag and resumes it from the scheduler seam", async () => {
    const scope = newScope();
    const retained = eventFor(
      scope,
      "message_lifecycle_retained",
      "$lifecycle-retained:server",
    );
    const removed = eventFor(
      scope,
      "message_lifecycle_delayed",
      "$lifecycle-delayed:server",
    );
    const committed = await seed(
      scope,
      [retained, removed],
      "batch_lifecycle_delayed",
    );
    const delayedBucket = new Proxy(bucket, {
      get(target, property, receiver) {
        if (property === "delete") {
          return async (key: string | string[]) => {
            if (key === committed.manifest.data_key) return;
            return target.delete(key);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as R2Bucket;

    const first = await recordRemovalWithArchivePurge(
      lifecycleFor(delayedBucket),
      inputFor(scope, "message_lifecycle_delayed"),
      fixedNow,
    );
    expect(first.archive.operation.status).toBe("incomplete");
    await expect(
      readArchiveStatusForRemoval(
        lifecycleFor(),
        scope.tenantId,
        first.authority.id,
      ),
    ).resolves.toMatchObject({
      operation: { status: "incomplete" },
      objects: [
        { state: "incomplete", manifest_deleted_at: fixedNow.toISOString() },
      ],
    });

    const resumed = await runRemovalExpiryAndArchive(
      lifecycleFor(),
      fixedNow,
      100,
    );
    expect(
      resumed.archived.find(
        ({ authority }) => authority.id === first.authority.id,
      ),
    ).toMatchObject({ archive: { operation: { status: "complete" } } });
    await expect(readReplayPage(bucket, scope.tenantId)).resolves.toMatchObject(
      {
        events: [expect.objectContaining({ event_id: retained.event_id })],
      },
    );
  });

  it("rescans a completed operation when a late archive batch arrives", async () => {
    const scope = newScope();
    const first = eventFor(
      scope,
      "message_lifecycle_late",
      "$lifecycle-late-first:server",
    );
    await seed(scope, [first], "batch_lifecycle_late_initial");
    const removalNow = new Date("2026-09-01T00:00:00.000Z");
    const result = await recordRemovalWithArchivePurge(
      lifecycleFor(),
      inputFor(scope, "message_lifecycle_late", removalNow),
      removalNow,
    );
    expect(result.archive.operation.status).toBe("complete");

    const late = eventFor(
      scope,
      "message_lifecycle_late",
      "$lifecycle-late-second:server",
    );
    await seed(scope, [late], "batch_lifecycle_late");
    await runRegisteredScheduler();
    const wakeup = await readArchiveStatusForRemoval(
      lifecycleFor(),
      scope.tenantId,
      result.authority.id,
    );
    expect(wakeup).toMatchObject({
      operation: { status: "complete" },
      objects: expect.arrayContaining([
        expect.objectContaining({ removed_event_ids: [first.event_id] }),
        expect.objectContaining({ removed_event_ids: [late.event_id] }),
      ]),
    });
    await expect(readReplayPage(bucket, scope.tenantId)).resolves.toMatchObject(
      { events: [], manifests: [] },
    );
  });

  it("serializes different removals targeting one batch and removes both bodies", async () => {
    const scope = newScope();
    const first = eventFor(
      scope,
      "message_lifecycle_overlap_a",
      "$lifecycle-overlap-a:server",
    );
    const second = eventFor(
      scope,
      "message_lifecycle_overlap_b",
      "$lifecycle-overlap-b:server",
    );
    await seed(scope, [first, second], "batch_lifecycle_overlap");
    const firstAuthority = await recordRemovalWithSuppression(
      workerEnv.CONTROL_DB,
      inputFor(scope, "message_lifecycle_overlap_a"),
      fixedNow,
    );
    const secondAuthority = await recordRemovalWithSuppression(
      workerEnv.CONTROL_DB,
      inputFor(scope, "message_lifecycle_overlap_b"),
      fixedNow,
    );

    await Promise.all([
      purgeRecordedRemoval(lifecycleFor(), firstAuthority, fixedNow),
      purgeRecordedRemoval(lifecycleFor(), secondAuthority, fixedNow),
    ]);
    await purgeRecordedRemoval(lifecycleFor(), firstAuthority, fixedNow);
    await purgeRecordedRemoval(lifecycleFor(), secondAuthority, fixedNow);

    await expect(readReplayPage(bucket, scope.tenantId)).resolves.toMatchObject(
      { events: [], manifests: [] },
    );
  });
});
