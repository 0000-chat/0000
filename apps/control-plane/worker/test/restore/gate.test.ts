import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordRemoval } from "../../removals/ledger";
import {
  loadRestoreAuthority,
  restoreReadinessForTenant,
  validateRestoreStoreEvidence,
} from "../../restore/gate";
import { readRestoreReplayPage } from "../../archive/replay";
import { createRestoreAuthorityExport } from "../../restore/authority";
import { archiveCanonicalEventBatch } from "../../archive/writer";
import { cleanupArchiveTenant, makeEvent } from "../archive/support";
import type { RestoreStoreStatus } from "@communicator/contracts";
import type { ControlledCopyAdapter } from "../../retention/adapters";

const workerEnv = env as Cloudflare.Env & { CONTROL_DB: D1Database };
const bucket = (env as Cloudflare.Env).EVENT_ARCHIVE;
const tenantIds: string[] = [];
const fixedNow = new Date("2026-09-14T00:00:00.000Z");

const tenant = (suffix: string): string => {
  const value = `tenant_restore33_${suffix}`;
  tenantIds.push(value);
  return value;
};

beforeEach(async () => {
  await workerEnv.CONTROL_DB.batch([
    workerEnv.CONTROL_DB.prepare(
      "DELETE FROM controlled_copy_evidence WHERE tenant_id LIKE 'tenant_restore33_%'",
    ),
    workerEnv.CONTROL_DB.prepare(
      "DELETE FROM controlled_copy_operations WHERE tenant_id LIKE 'tenant_restore33_%'",
    ),
    workerEnv.CONTROL_DB.prepare(
      "DELETE FROM removal_authority WHERE tenant_id LIKE 'tenant_restore33_%'",
    ),
  ]);
});

afterEach(async () => {
  await Promise.all(
    tenantIds.splice(0).map((id) => cleanupArchiveTenant(bucket, id)),
  );
  await workerEnv.CONTROL_DB.batch([
    workerEnv.CONTROL_DB.prepare(
      "DELETE FROM controlled_copy_evidence WHERE tenant_id LIKE 'tenant_restore33_%'",
    ),
    workerEnv.CONTROL_DB.prepare(
      "DELETE FROM controlled_copy_operations WHERE tenant_id LIKE 'tenant_restore33_%'",
    ),
    workerEnv.CONTROL_DB.prepare(
      "DELETE FROM removal_authority WHERE tenant_id LIKE 'tenant_restore33_%'",
    ),
  ]);
});

const inputFor = (tenantId: string, resourceId: string) => ({
  tenant_id: tenantId,
  resource_type: "message" as const,
  resource_id: resourceId,
  content_generation: resourceId,
  account_id: "account_restore33",
  conversation_id: "conversation_restore33",
  source_event_id: null,
  source_object_key: null,
  reason: "requested" as const,
  removed_at: fixedNow.toISOString(),
});

describe("restore authority gate", () => {
  it("exports the current primary ledger head and explicit store evidence", async () => {
    const tenantId = tenant("export");
    const exported = await createRestoreAuthorityExport(
      workerEnv.CONTROL_DB,
      tenantId,
      fixedNow,
    );
    expect(exported).toMatchObject({
      version: 1,
      tenant_id: tenantId,
      deletion_epoch: 0,
      authority_ids: [],
      authority_count: 0,
      ledger_head: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(exported.stores).toHaveLength(8);
    expect(exported.archive.status).toBe("complete");
    expect(Date.parse(exported.expires_at)).toBeGreaterThan(
      Date.parse(exported.issued_at),
    );
  });

  it("loads the current authority before any replay and reports incomplete stores", async () => {
    const tenantId = tenant("authority");
    const authority = await recordRemoval(
      workerEnv.CONTROL_DB,
      inputFor(tenantId, "message_restore33_removed"),
      fixedNow,
    );

    await expect(
      loadRestoreAuthority(workerEnv.CONTROL_DB, tenantId),
    ).resolves.toMatchObject({
      tenant_id: tenantId,
      deletion_epoch: 1,
      authority_ids: [authority.id],
    });
    const exported = await createRestoreAuthorityExport(
      workerEnv.CONTROL_DB,
      tenantId,
      fixedNow,
    );
    expect(exported.authorities[0]?.targets).toEqual([]);
    expect(
      exported.stores.filter((store) => store.status === "incomplete"),
    ).toHaveLength(8);
    await expect(
      restoreReadinessForTenant({
        database: workerEnv.CONTROL_DB,
        tenantId,
        now: fixedNow,
      }),
    ).resolves.toMatchObject({
      state: "incomplete",
      incomplete_stores: expect.arrayContaining(["projection_backup", "queue"]),
      deletion_epoch: 1,
    });
  });

  it("keeps unavailable store inventory incomplete even with one exact target", async () => {
    const tenantId = tenant("per_store_inventory");
    await recordRemoval(
      workerEnv.CONTROL_DB,
      inputFor(tenantId, "message_restore33_inventory"),
      fixedNow,
    );
    const synapseAdapter: ControlledCopyAdapter = {
      store: "synapse",
      owner: "restore-test-synapse",
      default_content_class: "message",
      deletion_method: "delete",
      required: true,
      inventory: async () => ({
        complete: true,
        evidence_source: "restore-test-synapse-inventory",
        copies: [
          {
            reference: "synapse:message_restore33_inventory",
            copy_created_at: fixedNow.toISOString(),
            resource_id: "message_restore33_inventory",
            content_generation: "message_restore33_inventory",
            restore_target: {
              database: "synapse",
              contract: "synapse-event-json-v1",
              resource_id: "message_restore33_inventory",
              content_generation: "message_restore33_inventory",
              room_id: "!restore:example.test",
              event_id: "$restore33-inventory:example.test",
              event_type: "m.room.message",
              media_paths: [],
              media_paths_complete: true,
            },
          },
        ],
      }),
      cleanup: async () => ({
        status: "deleted",
        content_present: false,
        evidence_source: "restore-test-synapse-cleanup",
        object_reference: "synapse:message_restore33_inventory",
        detail: null,
      }),
    };
    const exported = await createRestoreAuthorityExport(
      workerEnv.CONTROL_DB,
      tenantId,
      fixedNow,
      [synapseAdapter],
    );
    expect(exported.authorities[0]?.targets).toHaveLength(1);
    expect(
      exported.stores.find((store) => store.store === "synapse"),
    ).toMatchObject({
      status: "incomplete",
      evidence_source: "synapse_inventory",
    });
    expect(
      exported.stores.find((store) => store.store === "queue"),
    ).toMatchObject({
      status: "incomplete",
      evidence_source: "queue_inventory_unavailable",
      detail: "No configured inventory adapter is available",
    });
    expect(
      exported.stores.find((store) => store.store === "restic_snapshot"),
    ).toMatchObject({
      status: "incomplete",
      evidence_source: "restic_snapshot_inventory_unavailable",
    });
  });

  it("rejects inventory copies that omit their exact lineage", async () => {
    const tenantId = tenant("missing_copy_lineage");
    await recordRemoval(
      workerEnv.CONTROL_DB,
      inputFor(tenantId, "message_restore33_missing_copy_lineage"),
      fixedNow,
    );
    const incompleteSynapseAdapter: ControlledCopyAdapter = {
      store: "synapse",
      owner: "restore-test-synapse",
      default_content_class: "message",
      deletion_method: "delete",
      required: true,
      inventory: async () => ({
        complete: true,
        evidence_source: "restore-test-synapse-inventory",
        copies: [
          {
            reference: "synapse:missing-lineage",
            copy_created_at: fixedNow.toISOString(),
            restore_target: {
              database: "synapse",
              contract: "synapse-event-json-v1",
              room_id: "!restore:example.test",
              event_id: "$restore33-missing-lineage:example.test",
              event_type: "m.room.message",
              media_paths: [],
              media_paths_complete: true,
            },
          },
        ],
      }),
      cleanup: async () => ({
        status: "deleted",
        content_present: false,
        evidence_source: "restore-test-synapse-cleanup",
        object_reference: "synapse:missing-lineage",
        detail: null,
      }),
    };

    await expect(
      createRestoreAuthorityExport(workerEnv.CONTROL_DB, tenantId, fixedNow, [
        incompleteSynapseAdapter,
      ]),
    ).rejects.toThrow();
  });

  it("rejects missing or duplicate store evidence before readiness", () => {
    const storeNames = [
      "projection_backup",
      "synapse",
      "bridge_database",
      "media_store",
      "queue",
      "restic_snapshot",
      "session_credentials",
      "account_keys",
    ] as const;
    const complete: RestoreStoreStatus[] = storeNames.map((store) => ({
      ...(() => {
        const reference = `fixture:${store}`;
        return {
          references: [reference],
          copies: [
            {
              reference,
              copy_created_at: fixedNow.toISOString(),
              resource_id: `resource:${store}`,
              content_generation: "generation-1",
            },
          ],
        };
      })(),
      store,
      generation: "generation-1",
      status:
        store === "session_credentials" || store === "account_keys"
          ? ("preserved" as const)
          : ("complete" as const),
      content_present:
        store === "session_credentials" || store === "account_keys",
      evidence_source: "restore-test",
      detail: null,
    }));
    expect(validateRestoreStoreEvidence(complete)).toHaveLength(8);
    expect(() => validateRestoreStoreEvidence(complete.slice(1))).toThrow(
      "missing",
    );
    expect(() =>
      validateRestoreStoreEvidence([...complete, complete[0]!]),
    ).toThrow("duplicated");
  });

  it("filters stale archive records and returns tombstone evidence", async () => {
    const tenantId = tenant("replay");
    const removed = makeEvent({
      tenant_id: tenantId,
      account_id: "account_restore33",
      conversation_id: "conversation_restore33",
      event_id: "$restore33-removed:example.test",
      payload: { command_id: "command_restore33_removed", body: "removed" },
    });
    const retained = makeEvent({
      tenant_id: tenantId,
      account_id: "account_restore33",
      conversation_id: "conversation_restore33",
      event_id: "$restore33-retained:example.test",
      payload: { message_id: "message_restore33_retained", body: "retained" },
    });
    await archiveCanonicalEventBatch({
      bucket,
      tenantId,
      batchId: "batch_restore33_replay",
      events: [removed, retained],
      archivedAt: fixedNow.toISOString(),
      producerVersion: "restore-gate-test/1",
      sourceCheckpoint: null,
    });
    const authority = await recordRemoval(
      workerEnv.CONTROL_DB,
      {
        ...inputFor(tenantId, "command_restore33_removed"),
        resource_type: "command",
      },
      fixedNow,
    );

    const page = await readRestoreReplayPage(
      bucket,
      workerEnv.CONTROL_DB,
      tenantId,
    );
    expect(page.events.map((event) => event.event_id)).toEqual([
      retained.event_id,
    ]);
    expect(page.evidence).toMatchObject({
      tenant_id: tenantId,
      deletion_epoch: authority.deletion_epoch,
      authority_ids: [authority.id],
      removed_event_ids: [removed.event_id],
      rejected_event_ids: [removed.event_id],
      tombstones_reapplied: [authority.id],
    });
  });

  it("rechecks the removal epoch after the archive page is fetched", async () => {
    const tenantId = tenant("replay_race");
    const event = makeEvent({
      tenant_id: tenantId,
      account_id: "account_restore33",
      conversation_id: "conversation_restore33",
      event_id: "$restore33-race:example.test",
      payload: { body: "race" },
    });
    await archiveCanonicalEventBatch({
      bucket,
      tenantId,
      batchId: "batch_restore33_replay_race",
      events: [event],
      archivedAt: fixedNow.toISOString(),
      producerVersion: "restore-gate-test/1",
      sourceCheckpoint: null,
    });
    let recorded = false;
    const racedBucket = {
      list: async (...args: Parameters<R2Bucket["list"]>) => {
        const page = await bucket.list(...args);
        if (!recorded) {
          recorded = true;
          await recordRemoval(
            workerEnv.CONTROL_DB,
            {
              ...inputFor(tenantId, "command_restore33_race"),
              resource_type: "command",
            },
            fixedNow,
          );
        }
        return page;
      },
      get: (...args: Parameters<R2Bucket["get"]>) => bucket.get(...args),
    } as unknown as R2Bucket;

    await expect(
      readRestoreReplayPage(racedBucket, workerEnv.CONTROL_DB, tenantId),
    ).rejects.toMatchObject({ code: "archive_conflict" });
  });
});
