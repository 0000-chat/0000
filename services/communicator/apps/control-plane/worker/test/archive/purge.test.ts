import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { CanonicalEventEnvelope } from "@communicator/contracts";
import { recordRemoval } from "../../removals/ledger";
import {
  listCommittedManifestPage,
  readCommittedArchiveBatch,
  readReplayPage,
} from "../../archive/reader";
import { purgeArchiveForRemoval } from "../../archive/purge";
import { readSanitizedArchiveBatch } from "../../archive/replay";
import { archiveCanonicalEventBatch } from "../../archive/writer";
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
  overrides: Partial<CanonicalEventEnvelope> = {},
): CanonicalEventEnvelope =>
  makeEvent({
    tenant_id: scope.tenantId,
    account_id: "account_archive",
    conversation_id: "conversation_archive",
    ...overrides,
  });

const seed = async (
  scope: ArchiveScope,
  events: readonly CanonicalEventEnvelope[],
  batchId = scope.batchId,
) =>
  archiveCanonicalEventBatch({
    bucket,
    tenantId: scope.tenantId,
    batchId,
    events,
    archivedAt: fixedNow.toISOString(),
    producerVersion: "archive-purge-test/1",
    sourceCheckpoint: null,
  });

const authorityFor = async (
  scope: ArchiveScope,
  resourceType: "message" | "attachment" | "conversation",
  resourceId: string,
  sourceObjectKey: string | null = null,
) =>
  recordRemoval(
    workerEnv.CONTROL_DB,
    {
      tenant_id: scope.tenantId,
      resource_type: resourceType,
      resource_id: resourceId,
      content_generation: resourceId,
      account_id: "account_archive",
      conversation_id: "conversation_archive",
      source_event_id: null,
      source_object_key: sourceObjectKey,
      reason: "requested",
      removed_at: fixedNow.toISOString(),
    },
    fixedNow,
  );

const manifestKeys = async (tenantId: string): Promise<string[]> => {
  const result = await listCommittedManifestPage(bucket, tenantId, {
    pageSize: 100,
  });
  return result.items.map((item) => item.key);
};

afterEach(async () => {
  await Promise.all(
    activeTenants
      .splice(0, activeTenants.length)
      .map((tenantId) => cleanupArchiveTenant(bucket, tenantId)),
  );
  await workerEnv.CONTROL_DB.batch([
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

describe("canonical archive purge", () => {
  it("rewrites a one-record batch and replays through the real archive reader", async () => {
    const scope = newScope();
    const removed = eventFor(scope, {
      event_id: "$archive-remove:server",
      payload: { message_id: "message_archive_remove", body: "secret body" },
    });
    const committed = await seed(scope, [removed]);
    const authority = await authorityFor(
      scope,
      "message",
      "message_archive_remove",
    );

    const result = await purgeArchiveForRemoval({
      database: workerEnv.CONTROL_DB,
      bucket,
      tenantId: scope.tenantId,
      removalId: authority.id,
      now: fixedNow,
      safetyWindowMs: 0,
    });

    expect(result.operation.status).toBe("complete");
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0]).toMatchObject({
      state: "data_deleted",
      removed_event_ids: [removed.event_id],
      retained_event_ids: [],
      replacement_manifest_key: null,
    });
    expect(await bucket.head(committed.manifestKey)).toBeNull();
    expect(await bucket.head(committed.manifest.data_key)).toBeNull();
    expect(await manifestKeys(scope.tenantId)).toHaveLength(0);
    await expect(readReplayPage(bucket, scope.tenantId)).resolves.toMatchObject(
      {
        events: [],
        manifests: [],
      },
    );
  });

  it("preserves retained identity, order, and tenant isolation in a mixed batch", async () => {
    const scope = newScope();
    const other = newScope();
    const retained = eventFor(scope, {
      event_id: "$archive-retained:server",
      observed_at: "2026-09-07T01:02:01.000Z",
      occurred_at: "2026-09-07T01:02:01.000Z",
      payload: { message_id: "message_archive_keep", body: "keep body" },
    });
    const removed = eventFor(scope, {
      event_id: "$archive-removed:server",
      observed_at: "2026-09-07T01:02:02.000Z",
      occurred_at: "2026-09-07T01:02:02.000Z",
      payload: { message_id: "message_archive_remove_mixed", body: "secret" },
    });
    await seed(scope, [retained, removed]);
    const otherCommitted = await seed(
      other,
      [
        eventFor(other, {
          event_id: "$archive-other:server",
          payload: { message_id: "message_other", body: "other tenant" },
        }),
      ],
      "batch_other_archive",
    );
    const authority = await authorityFor(
      scope,
      "message",
      "message_archive_remove_mixed",
    );

    const result = await purgeArchiveForRemoval({
      database: workerEnv.CONTROL_DB,
      bucket,
      tenantId: scope.tenantId,
      removalId: authority.id,
      now: fixedNow,
      safetyWindowMs: 0,
    });
    expect(result.operation.status).toBe("complete");
    const replacementKey = result.objects[0]?.replacement_manifest_key;
    expect(replacementKey).toEqual(expect.any(String));
    const replayed = await readCommittedArchiveBatch(
      bucket,
      scope.tenantId,
      replacementKey!,
    );
    expect(replayed.events.map((event) => event.event_id)).toEqual([
      retained.event_id,
    ]);
    expect(replayed.events[0]?.payload).toEqual(retained.payload);
    expect(await bucket.head(otherCommitted.manifestKey)).not.toBeNull();
    await expect(
      readCommittedArchiveBatch(
        bucket,
        other.tenantId,
        otherCommitted.manifestKey,
      ),
    ).resolves.toMatchObject({
      events: [expect.objectContaining({ event_id: "$archive-other:server" })],
    });
  });

  it("converges on duplicate purge without creating another replacement", async () => {
    const scope = newScope();
    const removed = eventFor(scope, {
      event_id: "$archive-duplicate:server",
      payload: { message_id: "message_archive_duplicate", body: "secret" },
    });
    await seed(scope, [removed]);
    const authority = await authorityFor(
      scope,
      "message",
      "message_archive_duplicate",
    );
    const input = {
      database: workerEnv.CONTROL_DB,
      bucket,
      tenantId: scope.tenantId,
      removalId: authority.id,
      now: fixedNow,
      safetyWindowMs: 0,
    } as const;
    const first = await purgeArchiveForRemoval(input);
    const second = await purgeArchiveForRemoval(input);
    expect(second.operation.id).toBe(first.operation.id);
    expect(second.operation.status).toBe("complete");
    expect(await manifestKeys(scope.tenantId)).toEqual([]);
    expect(
      await workerEnv.CONTROL_DB.prepare(
        "SELECT COUNT(*) AS count FROM archive_purge_objects WHERE operation_id = ?",
      )
        .bind(first.operation.id)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it("does not purge a same-id event from another account or generation", async () => {
    const scope = newScope();
    const foreignAccount = eventFor(scope, {
      event_id: "$archive-foreign-account:server",
      account_id: "account_other_archive",
      payload: {
        message_id: "message_archive_scoped",
        body: "other account body",
        content_generation: "message_archive_scoped",
      },
    });
    const newerGeneration = eventFor(scope, {
      event_id: "$archive-new-generation:server",
      payload: {
        message_id: "message_archive_scoped",
        body: "new generation body",
        content_generation: "message_archive_scoped_new",
      },
    });
    const removed = eventFor(scope, {
      event_id: "$archive-scoped:server",
      payload: {
        message_id: "message_archive_scoped",
        body: "remove this body",
        content_generation: "message_archive_scoped",
      },
    });
    await seed(scope, [foreignAccount, newerGeneration, removed]);
    const authority = await authorityFor(
      scope,
      "message",
      "message_archive_scoped",
    );
    const result = await purgeArchiveForRemoval({
      database: workerEnv.CONTROL_DB,
      bucket,
      tenantId: scope.tenantId,
      removalId: authority.id,
      now: fixedNow,
      safetyWindowMs: 0,
    });
    const replacement = result.objects[0]?.replacement_manifest_key;
    expect(replacement).toEqual(expect.any(String));
    const replayed = await readCommittedArchiveBatch(
      bucket,
      scope.tenantId,
      replacement!,
    );
    expect(replayed.events.map((event) => event.event_id)).toEqual([
      foreignAccount.event_id,
      newerGeneration.event_id,
    ]);
    expect(JSON.stringify(replayed.events)).not.toContain("remove this body");
  });

  it("resumes after a crash immediately after durable replacement evidence", async () => {
    const scope = newScope();
    const retained = eventFor(scope, {
      event_id: "$archive-crash-retained:server",
      payload: { message_id: "message_archive_crash_keep", body: "keep" },
    });
    const removed = eventFor(scope, {
      event_id: "$archive-crash-removed:server",
      payload: { message_id: "message_archive_crash_remove", body: "secret" },
    });
    const committed = await seed(scope, [retained, removed]);
    const authority = await authorityFor(
      scope,
      "message",
      "message_archive_crash_remove",
    );
    let shouldFail = true;
    const first = await purgeArchiveForRemoval({
      database: workerEnv.CONTROL_DB,
      bucket,
      tenantId: scope.tenantId,
      removalId: authority.id,
      now: fixedNow,
      safetyWindowMs: 0,
      hooks: {
        afterReplacement: () => {
          if (shouldFail) {
            shouldFail = false;
            throw new Error("simulated worker crash");
          }
        },
      },
    });
    expect(first.operation.status).toBe("incomplete");
    expect(first.objects[0]).toMatchObject({ state: "incomplete" });
    expect(await bucket.head(committed.manifestKey)).not.toBeNull();

    const resumed = await purgeArchiveForRemoval({
      database: workerEnv.CONTROL_DB,
      bucket,
      tenantId: scope.tenantId,
      removalId: authority.id,
      now: fixedNow,
      safetyWindowMs: 0,
    });
    expect(resumed.operation.status).toBe("complete");
    const replacement = resumed.objects[0]?.replacement_manifest_key;
    expect(replacement).toEqual(expect.any(String));
    await expect(
      readCommittedArchiveBatch(bucket, scope.tenantId, replacement!),
    ).resolves.toMatchObject({
      events: [expect.objectContaining({ event_id: retained.event_id })],
    });
    expect(await bucket.head(committed.manifestKey)).toBeNull();
  });

  it("keeps lifecycle or delete lag visibly incomplete, then resumes from lineage", async () => {
    const scope = newScope();
    const removed = eventFor(scope, {
      event_id: "$archive-delay:server",
      payload: { message_id: "message_archive_delay", body: "secret" },
    });
    const committed = await seed(scope, [removed]);
    const authority = await authorityFor(
      scope,
      "message",
      "message_archive_delay",
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
    const incomplete = await purgeArchiveForRemoval({
      database: workerEnv.CONTROL_DB,
      bucket: delayedBucket,
      tenantId: scope.tenantId,
      removalId: authority.id,
      now: fixedNow,
      safetyWindowMs: 0,
    });
    expect(incomplete.operation.status).toBe("incomplete");
    expect(incomplete.objects[0]).toMatchObject({
      state: "incomplete",
      manifest_deleted_at: fixedNow.toISOString(),
    });
    expect(await bucket.head(committed.manifestKey)).toBeNull();
    expect(await bucket.head(committed.manifest.data_key)).not.toBeNull();

    const resumed = await purgeArchiveForRemoval({
      database: workerEnv.CONTROL_DB,
      bucket,
      tenantId: scope.tenantId,
      removalId: authority.id,
      now: fixedNow,
      safetyWindowMs: 0,
    });
    expect(resumed.operation.status).toBe("complete");
    expect(await bucket.head(committed.manifest.data_key)).toBeNull();
  });

  it("removes attachment metadata while retaining the message body and no object reference", async () => {
    const scope = newScope();
    const message = eventFor(scope, {
      event_id: "$archive-attachment-message:server",
      payload: {
        message_id: "message_archive_attachment",
        body: "keep body",
        attachments: [
          {
            attachment_id: "attachment_archive_remove",
            r2_key: "media/archive/remove",
          },
        ],
      } as never,
    });
    const attachment = eventFor(scope, {
      event_id: "$archive-attachment-observed:server",
      event_type: "attachment.observed",
      payload: {
        attachment_id: "attachment_archive_remove",
        message_id: "message_archive_attachment",
        r2_key: "media/archive/remove",
      },
    });
    await seed(scope, [message, attachment]);
    const authority = await authorityFor(
      scope,
      "attachment",
      "attachment_archive_remove",
      "media/archive/remove",
    );
    const result = await purgeArchiveForRemoval({
      database: workerEnv.CONTROL_DB,
      bucket,
      tenantId: scope.tenantId,
      removalId: authority.id,
      now: fixedNow,
      safetyWindowMs: 0,
    });
    const replacement = result.objects[0]?.replacement_manifest_key;
    expect(replacement).toEqual(expect.any(String));
    const replayed = await readSanitizedArchiveBatch(
      bucket,
      scope.tenantId,
      replacement!,
      authority,
    );
    expect(replayed.events).toHaveLength(1);
    expect(replayed.events[0]?.event_id).toBe(message.event_id);
    expect(replayed.events[0]?.payload).toMatchObject({
      message_id: "message_archive_attachment",
      body: "keep body",
      attachments: [],
    });
    expect(JSON.stringify(replayed.events)).not.toContain(
      "media/archive/remove",
    );
    expect(JSON.stringify(replayed.events)).not.toContain(
      "attachment_archive_remove",
    );
  });
});
