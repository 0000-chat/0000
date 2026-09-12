import {
  createExecutionContext,
  createMessageBatch,
  env as runtimeEnv,
  getQueueResult,
} from "cloudflare:test";
import type {
  CommittedArchivePointer,
  ProjectionConnectionBinding,
  ProjectionEventEnvelope,
} from "@communicator/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../index";
import {
  archiveCanonicalEventBatch,
  type ArchiveCanonicalEventBatchResult,
} from "../../archive/writer";
import { archiveError } from "../../archive/errors";
import { buildCommittedArchivePointer } from "../../ingestion/prepare";
import {
  createIngestionQueueHandler,
  type IngestionConsumerServices,
} from "../../ingestion/consumer";
import { projectionError } from "../../projection/errors";
import { clearDirectory, seedDirectory } from "../support/directory-fixtures";
import type { TenantProjectionDO } from "../../projection/tenant-projection";

const env = runtimeEnv as Cloudflare.Env & {
  CONTROL_DB: D1Database;
  EVENT_ARCHIVE: R2Bucket;
};

const TIMESTAMP = "2026-08-29T00:00:00.000Z";
const TENANT_ID = "tenant_consumer_valid";
const ROUTE_ID = "gateway_route_consumer";
const SERVICE_ID = "principal_consumer_service";
const IDENTITY_ID = "identity_consumer_human";
const ACCOUNT_ID = "account_consumer_whatsapp";
const CONNECTION_ID = "connection_consumer_whatsapp";
let archiveCounter = 0;

type WorkerWithQueue = {
  queue?: (
    batch: MessageBatch<unknown>,
    env: Cloudflare.Env,
    ctx: ExecutionContext,
  ) => void | Promise<void>;
};

type ProjectionStub = Pick<
  DurableObjectStub<TenantProjectionDO>,
  "initialize" | "applyBatch"
>;

const binding = (
  overrides: Partial<ProjectionConnectionBinding> = {},
): ProjectionConnectionBinding => ({
  account_id: ACCOUNT_ID,
  connection_id: CONNECTION_ID,
  identity_id: IDENTITY_ID,
  platform: "whatsapp",
  ...overrides,
});

const eventFor = (
  eventId: string,
  overrides: Partial<ProjectionEventEnvelope> = {},
): ProjectionEventEnvelope => ({
  schema_version: 1,
  event_id: eventId,
  event_type: "message.created",
  event_source: "live",
  tenant_id: TENANT_ID,
  identity_id: IDENTITY_ID,
  platform: "whatsapp",
  account_id: ACCOUNT_ID,
  conversation_id: "conversation_consumer",
  matrix_room_id: null,
  matrix_event_id: null,
  remote_message_id: "remote-consumer",
  occurred_at: "2026-08-29T01:00:00.000Z",
  observed_at: "2026-08-29T01:00:01.000Z",
  payload: {
    message_id: `message_${eventId.replace(/[^a-z0-9_]/g, "_")}`,
    direction: "inbound",
    sender_participant_id: null,
    sender_label: "Consumer test",
    body: "hello",
    reply_to_message_id: null,
    delivery_status: "unknown",
    unread: true,
  },
  ...overrides,
} as ProjectionEventEnvelope);

const serviceBinding = (
  overrides: Partial<ProjectionConnectionBinding> = {},
) => ({
  ...binding(overrides),
  gateway_route_id: ROUTE_ID,
  account_status: "active" as const,
});

const seedConsumerDirectory = async (): Promise<void> => {
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(TENANT_ID, "consumer-valid", "Consumer Valid", "active", TIMESTAMP, TIMESTAMP),
    env.CONTROL_DB.prepare(
      "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      SERVICE_ID,
      "https://consumer.example/",
      "consumer-service",
      "service",
      "Consumer service",
      "active",
      TIMESTAMP,
      TIMESTAMP,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO identities (id, tenant_id, identity_kind, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(IDENTITY_ID, TENANT_ID, "human", "Consumer identity", "active", TIMESTAMP, TIMESTAMP),
    env.CONTROL_DB.prepare(
      "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      CONNECTION_ID,
      TENANT_ID,
      IDENTITY_ID,
      "whatsapp",
      "Consumer WhatsApp",
      "ready",
      TIMESTAMP,
      TIMESTAMP,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(ROUTE_ID, SERVICE_ID, "active", TIMESTAMP, TIMESTAMP, null),
    env.CONTROL_DB.prepare(
      "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      CONNECTION_ID,
      ROUTE_ID,
      "consumer-bridge",
      "@consumer:example",
      "!consumer:example",
      TIMESTAMP,
      TIMESTAMP,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at, retired_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(ACCOUNT_ID, CONNECTION_ID, "active", TIMESTAMP, TIMESTAMP, null),
  ]);
};

const archiveFor = async (
  events: readonly ProjectionEventEnvelope[] = [eventFor("$consumer-valid:example")],
  options: {
    tenantId?: string;
    batchId?: string;
    sourceCheckpoint?: { kind: string; value: string } | null;
    archivedAt?: string;
  } = {},
): Promise<{
  committed: ArchiveCanonicalEventBatchResult;
  pointer: CommittedArchivePointer;
}> => {
  const tenantId = options.tenantId ?? TENANT_ID;
  archiveCounter += 1;
  const batchId = options.batchId ??
    `batch_${archiveCounter.toString(16).padStart(64, "0")}`;
  const committed = await archiveCanonicalEventBatch({
    bucket: env.EVENT_ARCHIVE,
    tenantId,
    batchId,
    events,
    archivedAt: options.archivedAt ?? "2026-08-29T02:00:00.000Z",
    producerVersion: "consumer-test/1",
    sourceCheckpoint: options.sourceCheckpoint ?? {
      kind: "matrix_sync_token_sha256",
      value: `sha256:${"a".repeat(64)}`,
    },
  });
  const pointer = buildCommittedArchivePointer({
    tenantId,
    batchId,
    manifestKey: committed.manifestKey,
    canonicalSha256: committed.manifest.canonical_sha256,
    gatewayRouteId: ROUTE_ID,
  });
  return { committed, pointer };
};

const runWorkerBatch = async (
  messages: Array<{ id: string; body: unknown }>,
) => {
  const batch = createMessageBatch(
    "communicator-ingestion-local",
    messages.map((message) => ({
      id: message.id,
      timestamp: new Date("2026-09-08T00:00:00.000Z"),
      body: message.body,
      attempts: 1,
    })),
  );
  const context = createExecutionContext();
  const queueHandler = (worker as unknown as WorkerWithQueue).queue;
  if (typeof queueHandler !== "function") {
    throw new Error("worker queue handler is missing");
  }
  await queueHandler(batch, env, context);
  return getQueueResult(batch, context);
};

const runInjectedBatch = async (
  body: unknown,
  services: IngestionConsumerServices,
) => {
  return (await runInjectedBatchWithRetry(body, services)).result;
};

const runInjectedBatchWithRetry = async (
  body: unknown,
  services: IngestionConsumerServices,
) => {
  const batch = createMessageBatch("consumer-test", [
    {
      id: "consumer-injected",
      timestamp: new Date("2026-09-08T00:00:00.000Z"),
      body,
      attempts: 1,
    },
  ]);
  const context = createExecutionContext();
  const message = batch.messages[0];
  let retryOptions: QueueRetryOptions | undefined;
  if (message === undefined) throw new Error("consumer test message missing");
  const originalRetry = message.retry.bind(message);
  Object.defineProperty(message, "retry", {
    configurable: true,
    value: (options?: QueueRetryOptions) => {
      retryOptions = options;
      return originalRetry(options);
    },
  });
  await createIngestionQueueHandler(services)(batch, env, context);
  return { result: await getQueueResult(batch, context), retryOptions };
};

const createMatrixFixture = async () => {
  const event = eventFor("$consumer-matrix:example");
  const { committed, pointer } = await archiveFor([event]);
  const initialize = vi.fn().mockResolvedValue({});
  const applyBatch = vi.fn().mockResolvedValue({});
  const projection = { initialize, applyBatch } as unknown as ProjectionStub;
  const readCommittedArchiveBatch = vi.fn(async () => ({
    manifest: committed.manifest,
    events: [event],
  }));
  const resolveArchivedIngestionRoute = vi.fn(async () => ({
    ok: true as const,
    value: {
      gateway_route_id: ROUTE_ID,
      service_principal_id: SERVICE_ID,
    },
  }));
  const resolveArchivedBindings = vi.fn(async () => ({
    ok: true as const,
    value: [serviceBinding()],
  }));
  const getTenantProjection = vi.fn(
    () => projection as DurableObjectStub<TenantProjectionDO>,
  );

  return {
    committed,
    pointer,
    event,
    initialize,
    applyBatch,
    readCommittedArchiveBatch,
    resolveArchivedIngestionRoute,
    resolveArchivedBindings,
    getTenantProjection,
    services: {
      readCommittedArchiveBatch,
      resolveArchivedIngestionRoute,
      resolveArchivedBindings,
      getTenantProjection,
    } satisfies IngestionConsumerServices,
  };
};

beforeEach(async () => {
  await clearDirectory(env.CONTROL_DB);
  await seedDirectory(env.CONTROL_DB);
  await seedConsumerDirectory();
});

describe("committed archive queue consumer", () => {
  it("explicitly retries a malformed pointer", async () => {
    const result = await runWorkerBatch([
      { id: "consumer-invalid-pointer", body: {} },
    ]);

    expect(result).toMatchObject({
      retryMessages: [{ msgId: "consumer-invalid-pointer" }],
      explicitAcks: [],
    });
  });

  it("reads one exact archive pair, initializes, applies once, and ACKs after success", async () => {
    const { pointer } = await archiveFor();
    const result = await runWorkerBatch([{ id: "consumer-valid", body: pointer }]);

    expect(result).toMatchObject({
      retryMessages: [],
      explicitAcks: ["consumer-valid"],
    });

    const projection = env.TENANT_PROJECTION.getByName(TENANT_ID);
    await expect(
      (await import("cloudflare:test")).runInDurableObject(projection, async (_instance, state) =>
        state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM applied_events",
        ).toArray(),
      ),
    ).resolves.toEqual([{ count: 1 }]);
  });

  it("keeps successful and failed sibling deliveries independent", async () => {
    const { pointer } = await archiveFor();
    const result = await runWorkerBatch([
      { id: "consumer-sibling-success", body: pointer },
      { id: "consumer-sibling-failure", body: {} },
    ]);

    expect(result).toMatchObject({
      retryMessages: [{ msgId: "consumer-sibling-failure" }],
      explicitAcks: ["consumer-sibling-success"],
    });
  });

  it.each([
    ["null checkpoint", null],
    ["generic checkpoint", { kind: "other_source", value: "cursor" }],
    ["raw-looking checkpoint", { kind: "matrix_sync_token", value: "raw-token" }],
  ] as const)("rejects %s before any DO access", async (_name, sourceCheckpoint) => {
    const { committed, pointer } = await archiveFor(
      [eventFor("$consumer-invalid-checkpoint:example")],
      { sourceCheckpoint },
    );
    const getProjection = vi.fn<NonNullable<IngestionConsumerServices["getTenantProjection"]>>();
    const result = await runInjectedBatch(pointer, {
      readCommittedArchiveBatch: async () => ({
        manifest: committed.manifest,
        events: [eventFor("$consumer-invalid-checkpoint:example")],
      }),
      resolveArchivedIngestionRoute: vi.fn(),
      resolveArchivedBindings: vi.fn(),
      getTenantProjection: getProjection,
    });

    expect(result).toMatchObject({
      retryMessages: [{ msgId: "consumer-injected" }],
      explicitAcks: [],
    });
    expect(getProjection).not.toHaveBeenCalled();
  });

  it("uses only the historical route principal and builds minimal sorted RPC authorization", async () => {
    const primary = eventFor("$consumer-z:example", {
      identity_id: "identity_consumer_z",
      account_id: "account_consumer_z",
      observed_at: "2026-08-29T01:00:03.000Z",
    });
    const secondary = eventFor("$consumer-a:example", {
      identity_id: "identity_consumer_a",
      account_id: "account_consumer_a",
      observed_at: "2026-08-29T01:00:03.000Z",
    });
    const { committed, pointer } = await archiveFor([primary, secondary]);
    const initialize = vi.fn().mockResolvedValue({});
    const applyBatch = vi.fn().mockResolvedValue({});
    const projection = { initialize, applyBatch } as unknown as ProjectionStub;

    const result = await runInjectedBatch(pointer, {
      readCommittedArchiveBatch: async () => ({
        manifest: committed.manifest,
        events: [primary, secondary],
      }),
      resolveArchivedIngestionRoute: async () => ({
        ok: true,
        value: {
          gateway_route_id: ROUTE_ID,
          service_principal_id: "principal_historical_owner",
        },
      }),
      resolveArchivedBindings: async () => ({
        ok: true,
        value: [
          serviceBinding({
            account_id: "account_consumer_a",
            connection_id: "connection_consumer_a",
            identity_id: "identity_consumer_a",
          }),
          serviceBinding({
            account_id: "account_consumer_z",
            connection_id: "connection_consumer_z",
            identity_id: "identity_consumer_z",
          }),
        ],
      }),
      getTenantProjection: () => projection as DurableObjectStub<TenantProjectionDO>,
    });

    expect(result).toMatchObject({
      retryMessages: [],
      explicitAcks: ["consumer-injected"],
    });
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(applyBatch).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({
      initialized_at: committed.manifest.archived_at,
      authorization: expect.objectContaining({
        principal_id: "principal_historical_owner",
        allowed_identity_ids: ["identity_consumer_a", "identity_consumer_z"],
        scopes: ["projection.initialize"],
      }),
    }));
    expect(applyBatch).toHaveBeenCalledWith(expect.objectContaining({
      authorization: expect.objectContaining({
        principal_id: "principal_historical_owner",
        allowed_identity_ids: ["identity_consumer_a", "identity_consumer_z"],
        scopes: ["projection.write"],
      }),
      checkpoint: {
        kind: "live_event_watermark",
        value: "$consumer-z:example",
        last_observed_at: "2026-08-29T01:00:03.000Z",
        last_event_id: "$consumer-z:example",
      },
    }));
  });

  it("retries a historical binding mismatch without touching the DO", async () => {
    const { committed, pointer } = await archiveFor();
    const getProjection = vi.fn<NonNullable<IngestionConsumerServices["getTenantProjection"]>>();
    const result = await runInjectedBatch(pointer, {
      readCommittedArchiveBatch: async () => ({
        manifest: committed.manifest,
        events: [eventFor("$consumer-binding-mismatch:example")],
      }),
      resolveArchivedIngestionRoute: async () => ({
        ok: true,
        value: { gateway_route_id: ROUTE_ID, service_principal_id: SERVICE_ID },
      }),
      resolveArchivedBindings: async () => ({
        ok: true,
        value: [serviceBinding({ identity_id: "identity_other" })],
      }),
      getTenantProjection: getProjection,
    });

    expect(result).toMatchObject({
      retryMessages: [{ msgId: "consumer-injected" }],
      explicitAcks: [],
    });
    expect(getProjection).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", "archive_not_found", 300],
    ["corrupt", "archive_corrupt", 300],
    ["unavailable", "archive_unavailable", 60],
  ] as const)("retries an R2 %s result with the exact delay", async (_name, code, delay) => {
    const fixture = await createMatrixFixture();
    const readCommittedArchiveBatch = vi
      .fn<NonNullable<IngestionConsumerServices["readCommittedArchiveBatch"]>>()
      .mockRejectedValue(archiveError(code));

    const { result, retryOptions } = await runInjectedBatchWithRetry(
      fixture.pointer,
      {
        ...fixture.services,
        readCommittedArchiveBatch,
      },
    );

    expect(result).toMatchObject({
      retryMessages: [{ msgId: "consumer-injected" }],
      explicitAcks: [],
    });
    expect(retryOptions).toEqual({ delaySeconds: delay });
    expect(readCommittedArchiveBatch).toHaveBeenCalledWith(
      env.EVENT_ARCHIVE,
      TENANT_ID,
      fixture.pointer.manifest_key,
    );
    expect(fixture.resolveArchivedIngestionRoute).not.toHaveBeenCalled();
    expect(fixture.getTenantProjection).not.toHaveBeenCalled();
  });

  it.each([
    ["key", (pointer: CommittedArchivePointer) => ({
      ...pointer,
      manifest_key: pointer.manifest_key.replace("/01/", "/00/"),
    })],
    ["tenant", (pointer: CommittedArchivePointer) => ({
      ...pointer,
      tenant_id: "tenant_pointer_other",
    })],
    ["batch", (pointer: CommittedArchivePointer) => ({
      ...pointer,
      batch_id: `batch_${"b".repeat(64)}`,
    })],
    ["digest", (pointer: CommittedArchivePointer) => ({
      ...pointer,
      canonical_sha256: "f".repeat(64),
    })],
  ] as const)("rejects a pointer %s mismatch before D1 or DO access", async (_name, mutate) => {
    const fixture = await createMatrixFixture();
    const readCommittedArchiveBatch = vi.fn(async () => ({
      manifest: fixture.committed.manifest,
      events: [fixture.event],
    }));
    const pointer = mutate(fixture.pointer);
    const { result, retryOptions } = await runInjectedBatchWithRetry(pointer, {
      ...fixture.services,
      readCommittedArchiveBatch,
    });

    expect(result).toMatchObject({
      retryMessages: [{ msgId: "consumer-injected" }],
      explicitAcks: [],
    });
    expect(retryOptions).toEqual({ delaySeconds: 300 });
    if (_name === "tenant" || _name === "batch") {
      expect(readCommittedArchiveBatch).not.toHaveBeenCalled();
    } else {
      expect(readCommittedArchiveBatch).toHaveBeenCalledTimes(1);
    }
    expect(fixture.resolveArchivedIngestionRoute).not.toHaveBeenCalled();
    expect(fixture.getTenantProjection).not.toHaveBeenCalled();
  });

  it.each([
    ["tenant", { tenant_id: "tenant_manifest_other" }],
    ["batch", { batch_id: `batch_${"c".repeat(64)}` }],
    ["digest", { canonical_sha256: "e".repeat(64) }],
  ] as const)("rejects a committed manifest %s mismatch before D1 or DO access", async (_name, patch) => {
    const fixture = await createMatrixFixture();
    const readCommittedArchiveBatch = vi.fn(async () => ({
      manifest: { ...fixture.committed.manifest, ...patch },
      events: [fixture.event],
    }));

    const { result, retryOptions } = await runInjectedBatchWithRetry(
      fixture.pointer,
      {
        ...fixture.services,
        readCommittedArchiveBatch,
      },
    );

    expect(result).toMatchObject({
      retryMessages: [{ msgId: "consumer-injected" }],
      explicitAcks: [],
    });
    expect(retryOptions).toEqual({ delaySeconds: 300 });
    expect(fixture.resolveArchivedIngestionRoute).not.toHaveBeenCalled();
    expect(fixture.getTenantProjection).not.toHaveBeenCalled();
  });

  it("rejects a malformed archived event before any D1 or DO access", async () => {
    const fixture = await createMatrixFixture();
    const readCommittedArchiveBatch = vi.fn(async () => ({
      manifest: fixture.committed.manifest,
      events: [{} as ProjectionEventEnvelope],
    }));

    const { result, retryOptions } = await runInjectedBatchWithRetry(
      fixture.pointer,
      {
        ...fixture.services,
        readCommittedArchiveBatch,
      },
    );

    expect(result).toMatchObject({
      retryMessages: [{ msgId: "consumer-injected" }],
      explicitAcks: [],
    });
    expect(retryOptions).toEqual({ delaySeconds: 300 });
    expect(fixture.resolveArchivedIngestionRoute).not.toHaveBeenCalled();
    expect(fixture.resolveArchivedBindings).not.toHaveBeenCalled();
    expect(fixture.getTenantProjection).not.toHaveBeenCalled();
  });

  it.each([
    ["not_found", { ok: false as const, code: "not_found" as const }, 300],
    ["unavailable", { ok: false as const, code: "unavailable" as const }, 60],
    [
      "mismatch",
      {
        ok: true as const,
        value: {
          gateway_route_id: "gateway_route_other",
          service_principal_id: SERVICE_ID,
        },
      },
      300,
    ],
  ] as const)("retries a historical route %s result with the exact delay", async (_name, routeResult, delay) => {
    const fixture = await createMatrixFixture();
    const resolveArchivedIngestionRoute = vi
      .fn<NonNullable<IngestionConsumerServices["resolveArchivedIngestionRoute"]>>()
      .mockResolvedValue(routeResult);

    const { result, retryOptions } = await runInjectedBatchWithRetry(
      fixture.pointer,
      {
        ...fixture.services,
        resolveArchivedIngestionRoute,
      },
    );

    expect(result).toMatchObject({
      retryMessages: [{ msgId: "consumer-injected" }],
      explicitAcks: [],
    });
    expect(retryOptions).toEqual({ delaySeconds: delay });
    expect(fixture.resolveArchivedBindings).not.toHaveBeenCalled();
    expect(fixture.getTenantProjection).not.toHaveBeenCalled();
  });

  it.each([
    ["not_found", { ok: false as const, code: "not_found" as const }, 300],
    ["unavailable", { ok: false as const, code: "unavailable" as const }, 60],
    ["mismatch", { ok: true as const, value: [serviceBinding({ identity_id: "identity_other" })] }, 300],
  ] as const)("retries historical bindings %s with the exact delay", async (_name, bindingsResult, delay) => {
    const fixture = await createMatrixFixture();
    const resolveArchivedBindings = vi
      .fn<NonNullable<IngestionConsumerServices["resolveArchivedBindings"]>>()
      .mockImplementation(async () =>
        bindingsResult as Awaited<
          ReturnType<NonNullable<IngestionConsumerServices["resolveArchivedBindings"]>>
        >,
      );

    const { result, retryOptions } = await runInjectedBatchWithRetry(
      fixture.pointer,
      {
        ...fixture.services,
        resolveArchivedBindings,
      },
    );

    expect(result).toMatchObject({
      retryMessages: [{ msgId: "consumer-injected" }],
      explicitAcks: [],
    });
    expect(retryOptions).toEqual({ delaySeconds: delay });
    expect(fixture.getTenantProjection).not.toHaveBeenCalled();
  });

  it.each([
    ["unavailable", "projection_unavailable", 60],
    ["rebuilding", "projection_rebuilding", 60],
    ["conflict", "projection_conflict", 300],
  ] as const)("retries a DO initialize %s with the exact delay and skips apply", async (_name, code, delay) => {
    const fixture = await createMatrixFixture();
    fixture.initialize.mockRejectedValue(projectionError(code));

    const { result, retryOptions } = await runInjectedBatchWithRetry(
      fixture.pointer,
      fixture.services,
    );

    expect(result).toMatchObject({
      retryMessages: [{ msgId: "consumer-injected" }],
      explicitAcks: [],
    });
    expect(retryOptions).toEqual({ delaySeconds: delay });
    expect(fixture.getTenantProjection).toHaveBeenCalledTimes(1);
    expect(fixture.initialize).toHaveBeenCalledTimes(1);
    expect(fixture.applyBatch).not.toHaveBeenCalled();
  });

  it.each([
    ["unavailable", "projection_unavailable", 60],
    ["rebuilding", "projection_rebuilding", 60],
    ["conflict", "projection_conflict", 300],
  ] as const)("retries a DO apply %s with the exact delay after one initialize", async (_name, code, delay) => {
    const fixture = await createMatrixFixture();
    fixture.applyBatch.mockRejectedValue(projectionError(code));

    const { result, retryOptions } = await runInjectedBatchWithRetry(
      fixture.pointer,
      fixture.services,
    );

    expect(result).toMatchObject({
      retryMessages: [{ msgId: "consumer-injected" }],
      explicitAcks: [],
    });
    expect(retryOptions).toEqual({ delaySeconds: delay });
    expect(fixture.getTenantProjection).toHaveBeenCalledTimes(1);
    expect(fixture.initialize).toHaveBeenCalledTimes(1);
    expect(fixture.applyBatch).toHaveBeenCalledTimes(1);
  });

  it("retries when the DO routing lookup is unavailable before an RPC", async () => {
    const fixture = await createMatrixFixture();
    const getTenantProjection = vi
      .fn<NonNullable<IngestionConsumerServices["getTenantProjection"]>>()
      .mockImplementation(() => {
        throw projectionError("projection_unavailable");
      });

    const { result, retryOptions } = await runInjectedBatchWithRetry(
      fixture.pointer,
      {
        ...fixture.services,
        getTenantProjection,
      },
    );

    expect(result).toMatchObject({
      retryMessages: [{ msgId: "consumer-injected" }],
      explicitAcks: [],
    });
    expect(retryOptions).toEqual({ delaySeconds: 60 });
    expect(getTenantProjection).toHaveBeenCalledTimes(1);
    expect(fixture.initialize).not.toHaveBeenCalled();
    expect(fixture.applyBatch).not.toHaveBeenCalled();
  });

  it("retries unexpected errors with the short unavailable delay and never exposes body content", async () => {
    const fixture = await createMatrixFixture();
    const sentinel = "secret-event-body-never-logged";
    const readCommittedArchiveBatch = vi
      .fn<NonNullable<IngestionConsumerServices["readCommittedArchiveBatch"]>>()
      .mockRejectedValue(new Error(sentinel));
    const { result, retryOptions } = await runInjectedBatchWithRetry(
      fixture.pointer,
      {
        ...fixture.services,
        readCommittedArchiveBatch,
      },
    );

    expect(result).toMatchObject({
      retryMessages: [{ msgId: "consumer-injected" }],
      explicitAcks: [],
    });
    expect(retryOptions).toEqual({ delaySeconds: 60 });
    expect(fixture.getTenantProjection).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });
});
