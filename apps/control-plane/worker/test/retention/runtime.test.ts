import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlledCopyEvidenceInput } from "@communicator/contracts";
import { CONTROLLED_COPY_WORKER_LEASE_MS } from "../../retention/service";
import {
  CONTROLLED_COPY_BACKEND_ENV,
  createConfiguredControlledCopyAdapters,
  type RetentionRuntimeFetcher,
} from "../../retention/runtime";
import { CONTROLLED_COPY_RETENTION_SCHEMA } from "../../retention/schema";
import { runControlledCopyRetentionForRemoval } from "../../retention/service";
import { recordRemoval } from "../../removals/ledger";
import { removalStatusForTenant } from "../../removals/service";
import { recordRemovalWithArchivePurge } from "../../archive/lifecycle";
import worker from "../../index";

const workerEnv = env as typeof env & { CONTROL_DB: D1Database };
const fixedNow = new Date("2026-09-14T00:00:00.000Z");
const lineage = {
  tenant_id: "tenant_runtime_boundary",
  removal_id: "removal_runtime_boundary",
  resource_type: "message",
  resource_id: "message_runtime_boundary",
  content_generation: "generation_runtime_boundary",
  deletion_epoch: 1,
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

const runtimeEnvironment = (): Record<string, string> => {
  const environment: Record<string, string> = {};
  for (const config of Object.values(CONTROLLED_COPY_BACKEND_ENV)) {
    environment[config.endpoint] = "https://retention.internal.example.test";
    environment[config.token] = "test-retention-token";
  }
  return environment;
};

const evidenceFor = (store: string): ControlledCopyEvidenceInput =>
  store === "session_credentials" || store === "account_keys"
    ? {
        status: "preserved",
        content_present: true,
        evidence_source: `${store}_service`,
        object_reference: `${store}:one`,
        detail: "Separate credential lifecycle preserved the copy",
      }
    : {
        status: "deleted",
        content_present: false,
        evidence_source: `${store}_service`,
        object_reference: `${store}:one`,
        detail: "Service deleted the exact controlled copy",
      };

const serviceFetcher = (
  requests: Array<{ url: string; init: RequestInit }>,
): RetentionRuntimeFetcher =>
  vi.fn(async (input, init) => {
    const url = String(input);
    requests.push({ url, init: init ?? {} });
    const body = JSON.parse(String(init?.body)) as {
      store: string;
      operation: string;
      scope?: {
        resource_id?: string;
        content_generation?: string;
      };
    };
    if (body.operation === "inventory") {
      return new Response(
        JSON.stringify({
          complete: true,
          copies: [
            {
              reference: `${body.store}:one`,
              copy_created_at: "2026-09-12T00:00:00.000Z",
              resource_id: body.scope?.resource_id,
              content_generation: body.scope?.content_generation,
              content_class:
                body.store === "session_credentials"
                  ? "session_credential"
                  : body.store === "account_keys"
                    ? "account_key"
                    : undefined,
            },
          ],
          evidence_source: `${body.store}_service_inventory`,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(evidenceFor(body.store)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

describe("configured controlled-copy runtime boundary", () => {
  beforeEach(addRetentionSchema);

  it("runs the registered lifecycle through authenticated provider requests", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const adapters = createConfiguredControlledCopyAdapters(
      runtimeEnvironment(),
      serviceFetcher(requests),
    );
    const run = await runControlledCopyRetentionForRemoval({
      database: workerEnv.CONTROL_DB,
      adapters,
      lineage,
      canonicalArchive: "complete",
      now: fixedNow,
    });

    expect(run.completion.status).toBe("complete");
    expect(run.completion.completed_stores).toHaveLength(6);
    expect(run.completion.auxiliary_operations).toHaveLength(2);
    expect(
      run.completion.auxiliary_operations.every(
        (item) => item.status === "preserved",
      ),
    ).toBe(true);
    expect(requests).toHaveLength(16);
    expect(
      requests.every(
        ({ init }) =>
          init.headers instanceof Headers || typeof init.headers === "object",
      ),
    ).toBe(true);
    const cleanupRequest = requests.find(({ url }) => url.endsWith("/cleanup"));
    expect(cleanupRequest).toBeDefined();
    expect(cleanupRequest?.init.headers).toMatchObject({
      authorization: "Bearer test-retention-token",
    });
    expect(String(cleanupRequest?.init.body)).not.toContain(
      "test-retention-token",
    );
  });

  it("invokes the same provider boundary from the authorized removal entrypoint", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const result = await recordRemovalWithArchivePurge(
      {
        database: workerEnv.CONTROL_DB,
        bucket: (env as typeof env & { EVENT_ARCHIVE: R2Bucket }).EVENT_ARCHIVE,
        safetyWindowMs: 0,
        retentionAdapters: createConfiguredControlledCopyAdapters(
          runtimeEnvironment(),
          serviceFetcher(requests),
        ),
      },
      {
        tenant_id: "tenant_runtime_lifecycle",
        resource_type: "message",
        resource_id: "message_runtime_lifecycle",
        content_generation: "generation_runtime_lifecycle",
        account_id: null,
        conversation_id: null,
        source_event_id: null,
        source_object_key: null,
        reason: "requested",
        removed_at: fixedNow.toISOString(),
      },
      fixedNow,
    );

    expect(result.archive.operation.status).toBe("complete");
    expect(result.controlled_copy.status).toBe("complete");
    expect(result.controlled_copy.completed_stores).toHaveLength(6);
    expect(requests.filter(({ url }) => url.endsWith("/cleanup"))).toHaveLength(
      8,
    );
    const status = await removalStatusForTenant(
      workerEnv.CONTROL_DB,
      result.authority.tenant_id,
    );
    expect(status.controlled_copy).toMatchObject([
      expect.objectContaining({
        removal_id: result.authority.id,
        status: "complete",
        canonical_archive: "complete",
      }),
    ]);
  });

  it("reconciles an unavailable lifecycle row when the configured service appears", async () => {
    const unavailable = await runControlledCopyRetentionForRemoval({
      database: workerEnv.CONTROL_DB,
      adapters: [],
      lineage: { ...lineage, removal_id: "removal_runtime_reconcile" },
      canonicalArchive: "complete",
      now: fixedNow,
    });
    expect(unavailable.completion.status).toBe("incomplete");

    const requests: Array<{ url: string; init: RequestInit }> = [];
    const configured = await runControlledCopyRetentionForRemoval({
      database: workerEnv.CONTROL_DB,
      adapters: createConfiguredControlledCopyAdapters(
        runtimeEnvironment(),
        serviceFetcher(requests),
      ),
      lineage: { ...lineage, removal_id: "removal_runtime_reconcile" },
      canonicalArchive: "complete",
      now: new Date(fixedNow.getTime() + CONTROLLED_COPY_WORKER_LEASE_MS + 1),
    });
    expect(configured.completion.status).toBe("complete");
    expect(configured.completion.incomplete_stores).toHaveLength(0);
  });

  it("runs the registered scheduler and leaves absent stores explicitly incomplete", async () => {
    const authority = await recordRemoval(
      workerEnv.CONTROL_DB,
      {
        tenant_id: "tenant_runtime_scheduler",
        resource_type: "message",
        resource_id: "message_runtime_scheduler",
        content_generation: "generation_runtime_scheduler",
        account_id: null,
        conversation_id: null,
        source_event_id: null,
        source_object_key: null,
        reason: "retention",
      },
      fixedNow,
    );
    const waits: Promise<unknown>[] = [];
    if (worker.scheduled === undefined)
      throw new Error("scheduler not registered");
    await worker.scheduled({} as ScheduledController, workerEnv, {
      waitUntil(promise: Promise<unknown>) {
        waits.push(promise);
      },
    } as ExecutionContext);
    await Promise.all(waits);

    const rows = await workerEnv.CONTROL_DB.prepare(
      "SELECT store, status FROM controlled_copy_operations WHERE tenant_id = ? AND removal_id = ?",
    )
      .bind(authority.tenant_id, authority.id)
      .all<{ store: string; status: string }>();
    expect(rows.results.map((row) => row.store).sort()).toEqual([
      "account_keys",
      "bridge_database",
      "media_store",
      "projection_backup",
      "queue",
      "restic_snapshot",
      "session_credentials",
      "synapse",
    ]);
    expect(
      rows.results
        .filter(
          (row) => !["account_keys", "session_credentials"].includes(row.store),
        )
        .every((row) => row.status === "incomplete"),
    ).toBe(true);
  });
});
