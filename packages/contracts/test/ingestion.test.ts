import { describe, expect, it } from "vitest";
import {
  ArchiveManifestKeySchema,
  IngestionAcceptedResponseSchema,
  IngestionBatchRequestSchema,
  IngestionCommittedArchiveManifestSchema,
  IngestionErrorCodeSchema,
  IngestionErrorResponseSchema,
  CommittedArchivePointerSchema,
  MatrixCheckpointDigestSchema,
  MAX_ARCHIVE_EVENTS,
  MAX_CANONICAL_JSON_COLLECTION_ENTRIES,
  MAX_CANONICAL_JSON_DEPTH,
  MAX_CANONICAL_JSON_NODES,
  MAX_PRODUCER_VERSION_CHARS,
  MAX_PROJECTION_BATCH_EVENTS,
  MAX_INGESTION_QUEUE_POINTER_BYTES,
  MAX_INGESTION_REQUEST_BYTES,
  MAX_INGESTION_PRODUCER_VERSION_CHARS,
  MAX_INGESTION_TIMESTAMP_CHARS,
  type CanonicalEventEnvelope,
} from "../src/index";

const BATCH_ID = `batch_${"a".repeat(64)}`;
const TENANT_ID = "tenant_pilot";
const GATEWAY_ROUTE_ID = "gateway_route_pilot";
const MANIFEST_KEY = `manifests/${TENANT_ID}/2026/09/07/01/${BATCH_ID}.json`;

const validEvent = (
  overrides: Partial<CanonicalEventEnvelope> = {},
): CanonicalEventEnvelope => ({
  schema_version: 1,
  event_id: "$event-1:communicator",
  event_type: "message.created",
  event_source: "live",
  tenant_id: TENANT_ID,
  identity_id: "identity_human",
  platform: "whatsapp",
  account_id: "account_human_whatsapp",
  conversation_id: "conversation_human_one",
  matrix_room_id: "!room:communicator",
  matrix_event_id: "$event-1:communicator",
  remote_message_id: "remote-message-1",
  occurred_at: "2026-09-07T01:02:02.000Z",
  observed_at: "2026-09-07T01:02:03.000Z",
  payload: {
    message_id: "message_one",
    direction: "inbound",
    sender_participant_id: "participant_remote",
    sender_label: "Remote sender",
    body: "hello",
    reply_to_message_id: null,
    delivery_status: "delivered",
    unread: true,
  },
  ...overrides,
});

const validRequest = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  schema_version: 1,
  gateway_route_id: GATEWAY_ROUTE_ID,
  tenant_id: TENANT_ID,
  batch_id: BATCH_ID,
  archived_at: "2026-09-07T01:03:03.000Z",
  producer_version: "gateway-2026.09.07",
  source_checkpoint: {
    kind: "matrix_sync_token_sha256",
    value: `sha256:${"b".repeat(64)}`,
  },
  events: [validEvent()],
  ...overrides,
});

const validManifest = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  schema_version: 1,
  tenant_id: TENANT_ID,
  batch_id: BATCH_ID,
  data_key: `events/${TENANT_ID}/2026/09/07/01/${BATCH_ID}.jsonl.gz`,
  compression: "gzip",
  content_type: "application/x-ndjson",
  event_count: 1,
  uncompressed_bytes: 512,
  compressed_bytes: 256,
  canonical_sha256: "c".repeat(64),
  data_etag: "etag-123",
  first_event_id: "$event-1:communicator",
  last_event_id: "$event-1:communicator",
  first_observed_at: "2026-09-07T01:02:03.000Z",
  last_observed_at: "2026-09-07T01:02:03.000Z",
  archived_at: "2026-09-07T01:03:03.000Z",
  producer: {
    service: "communicator-control-plane",
    version: "gateway-2026.09.07",
  },
  source_checkpoint: {
    kind: "matrix_sync_token_sha256",
    value: `sha256:${"b".repeat(64)}`,
  },
  ...overrides,
});

const validPointer = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  schema_version: 1,
  kind: "archive.batch.committed",
  tenant_id: TENANT_ID,
  batch_id: BATCH_ID,
  manifest_key: MANIFEST_KEY,
  canonical_sha256: "c".repeat(64),
  gateway_route_id: GATEWAY_ROUTE_ID,
  ...overrides,
});

const expectRejected = (
  schema: { safeParse: (input: unknown) => { success: boolean } },
  input: unknown,
): void => {
  let result: { success: boolean } | undefined;
  expect(() => {
    result = schema.safeParse(input);
  }).not.toThrow();
  expect(result?.success).toBe(false);
};

const defineOwnKey = (target: object, key: string | symbol, value: unknown): void => {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
};

describe("ingestion contract exports", () => {
  it("accepts the exact request, response, pointer, manifest, and error shapes", () => {
    expect(IngestionBatchRequestSchema.parse(validRequest())).toEqual(validRequest());
    expect(
      IngestionAcceptedResponseSchema.parse({
        schema_version: 1,
        tenant_id: TENANT_ID,
        batch_id: BATCH_ID,
        status: "accepted",
        archive_status: "created",
      }),
    ).toEqual({
      schema_version: 1,
      tenant_id: TENANT_ID,
      batch_id: BATCH_ID,
      status: "accepted",
      archive_status: "created",
    });
    expect(CommittedArchivePointerSchema.parse(validPointer())).toEqual(validPointer());
    expect(IngestionCommittedArchiveManifestSchema.parse(validManifest())).toEqual(
      validManifest(),
    );
    expect(IngestionErrorCodeSchema.options).toEqual([
      "ingestion_invalid",
      "ingestion_too_large",
      "ingestion_unauthenticated",
      "ingestion_not_found",
      "ingestion_conflict",
      "ingestion_unavailable",
    ]);
    expect(
      IngestionErrorResponseSchema.parse({
        error: { code: "ingestion_invalid", message: "Invalid ingestion request" },
      }),
    ).toEqual({
      error: { code: "ingestion_invalid", message: "Invalid ingestion request" },
    });
    expect(ArchiveManifestKeySchema.parse(MANIFEST_KEY)).toBe(MANIFEST_KEY);
  });

  it("rejects unexpected fields in every public envelope", () => {
    expectRejected(IngestionAcceptedResponseSchema, {
      schema_version: 1,
      tenant_id: TENANT_ID,
      batch_id: BATCH_ID,
      status: "accepted",
      archive_status: "created",
      unexpected: true,
    });
    expectRejected(IngestionErrorResponseSchema, {
      error: {
        code: "ingestion_invalid",
        message: "Invalid ingestion request",
        unexpected: true,
      },
    });
    expectRejected(IngestionErrorResponseSchema, {
      error: { code: "ingestion_invalid", message: "Invalid ingestion request" },
      unexpected: true,
    });
    expectRejected(MatrixCheckpointDigestSchema, {
      kind: "matrix_sync_token_sha256",
      value: `sha256:${"d".repeat(64)}`,
      unexpected: true,
    });
  });

  it("exports the transport and field bounds without duplicating archive limits", () => {
    expect(MAX_ARCHIVE_EVENTS).toBe(500);
    expect(MAX_PROJECTION_BATCH_EVENTS).toBe(500);
    expect(MAX_INGESTION_REQUEST_BYTES).toBe(32 * 1024 * 1024);
    expect(MAX_INGESTION_QUEUE_POINTER_BYTES).toBe(8 * 1024);
    expect(MAX_INGESTION_TIMESTAMP_CHARS).toBe(64);
    expect(MAX_INGESTION_PRODUCER_VERSION_CHARS).toBe(128);
    expect(MAX_INGESTION_PRODUCER_VERSION_CHARS).toBe(MAX_PRODUCER_VERSION_CHARS);
  });
});

describe("ingestion request cross-field constraints", () => {
  it("requires one tenant, unique event IDs, and projection-valid events", () => {
    expectRejected(IngestionBatchRequestSchema, validRequest({
      events: [validEvent(), validEvent()],
    }));
    expectRejected(IngestionBatchRequestSchema, validRequest({
      events: [validEvent({ tenant_id: "tenant_other" })],
    }));
    expectRejected(IngestionBatchRequestSchema, validRequest({
      events: [validEvent({ payload: { body: "not a projection payload" } as never })],
    }));
    expectRejected(IngestionBatchRequestSchema, validRequest({ events: [] }));
    expectRejected(IngestionBatchRequestSchema, validRequest({ events: Array.from(
      { length: MAX_ARCHIVE_EVENTS + 1 },
      (_, index) => validEvent({ event_id: `$event-${index}:communicator` }),
    ) }));
    expect(MAX_ARCHIVE_EVENTS).toBe(MAX_PROJECTION_BATCH_EVENTS);
  });

  it("requires the exact batch grammar and digest-only source checkpoint", () => {
    expect(MatrixCheckpointDigestSchema.parse({
      kind: "matrix_sync_token_sha256",
      value: `sha256:${"d".repeat(64)}`,
    })).toEqual({
      kind: "matrix_sync_token_sha256",
      value: `sha256:${"d".repeat(64)}`,
    });
    expectRejected(MatrixCheckpointDigestSchema, {
      kind: "matrix_sync_token_sha256",
      value: "matrix-next-batch-token",
    });
    expectRejected(MatrixCheckpointDigestSchema, {
      kind: "wrong-kind",
      value: `sha256:${"d".repeat(64)}`,
    });
    expectRejected(MatrixCheckpointDigestSchema, {
      kind: "matrix_sync_token_sha256",
      value: `sha256:${"D".repeat(64)}`,
    });
    expectRejected(IngestionBatchRequestSchema, validRequest({ batch_id: "batch_abc" }));
    expectRejected(IngestionBatchRequestSchema, validRequest({ batch_id: `batch_${"a".repeat(63)}g` }));
    expectRejected(IngestionBatchRequestSchema, validRequest({
      producer_version: " ",
    }));
    expectRejected(IngestionBatchRequestSchema, validRequest({
      producer_version: "",
    }));
    expectRejected(IngestionBatchRequestSchema, validRequest({
      producer_version: `x${"a".repeat(MAX_INGESTION_PRODUCER_VERSION_CHARS)}`,
    }));
    expectRejected(IngestionBatchRequestSchema, validRequest({
      source_checkpoint: { kind: "matrix_sync_token_sha256", value: "" },
    }));
    expectRejected(IngestionBatchRequestSchema, {});
    expectRejected(IngestionBatchRequestSchema, validRequest({
      archived_at: " ".repeat(MAX_INGESTION_TIMESTAMP_CHARS + 1),
    }));
  });
});

describe("pointer and committed-manifest constraints", () => {
  it("requires the manifest key to carry the same tenant and batch", () => {
    expectRejected(CommittedArchivePointerSchema, validPointer({
      manifest_key: MANIFEST_KEY.replace(TENANT_ID, "tenant_other"),
    }));
    expectRejected(CommittedArchivePointerSchema, validPointer({
      manifest_key: MANIFEST_KEY.replace(BATCH_ID, `batch_${"d".repeat(64)}`),
    }));
    expectRejected(CommittedArchivePointerSchema, validPointer({
      canonical_sha256: "D".repeat(64),
    }));
    expectRejected(CommittedArchivePointerSchema, validPointer({ unexpected: true }));
  });

  it("requires a non-null Matrix checkpoint in committed manifests", () => {
    expectRejected(IngestionCommittedArchiveManifestSchema, validManifest({
      source_checkpoint: null,
    }));
    expectRejected(IngestionCommittedArchiveManifestSchema, validManifest({
      source_checkpoint: { kind: "generic", value: "cursor-1" },
    }));
    expectRejected(IngestionCommittedArchiveManifestSchema, validManifest({
      source_checkpoint: {
        kind: "matrix_sync_token_sha256",
        value: "raw-matrix-token",
      },
    }));
    expectRejected(IngestionCommittedArchiveManifestSchema, validManifest({
      source_checkpoint: {
        kind: " matrix_sync_token_sha256",
        value: `sha256:${"b".repeat(64)} `,
      },
    }));
    expectRejected(IngestionCommittedArchiveManifestSchema, validManifest({ unexpected: true }));
  });
});

describe("descriptor-safe hostile input handling", () => {
  it("does not execute accessors or proxy get traps", () => {
    const accessorInput = validRequest();
    let getterCalls = 0;
    Object.defineProperty(accessorInput, "tenant_id", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error("getter must not execute");
      },
    });
    expectRejected(IngestionBatchRequestSchema, accessorInput);
    expect(getterCalls).toBe(0);

    let getCalls = 0;
    const proxyInput = new Proxy(validRequest(), {
      get: () => {
        getCalls += 1;
        throw new Error("proxy get must not execute");
      },
    });
    expect(IngestionBatchRequestSchema.safeParse(proxyInput).success).toBe(true);
    expect(getCalls).toBe(0);
  });

  it.each(["ownKeys", "getOwnPropertyDescriptor", "getPrototypeOf"] as const)(
    "rejects a proxy whose %s trap throws",
    (trap) => {
      const input = new Proxy(validRequest(), {
        [trap]: () => {
          throw new Error(`proxy ${trap} must be redacted`);
        },
      });
      expectRejected(IngestionBatchRequestSchema, input);
    },
  );

  it("rejects inherited, symbol, sparse, unexpected, and prototype-sensitive fields", () => {
    const inherited = Object.create({ inherited: true }) as Record<string, unknown>;
    Object.assign(inherited, validRequest());
    expectRejected(IngestionBatchRequestSchema, inherited);

    const withSymbol = validRequest();
    defineOwnKey(withSymbol, Symbol("secret"), "secret");
    expectRejected(IngestionBatchRequestSchema, withSymbol);

    const sparseEvents: unknown[] = [];
    sparseEvents.length = 1;
    expectRejected(IngestionBatchRequestSchema, validRequest({ events: sparseEvents }));

    expectRejected(IngestionBatchRequestSchema, validRequest({ unexpected: true }));
    expectRejected(IngestionBatchRequestSchema, validRequest({
      source_checkpoint: {
        kind: "matrix_sync_token_sha256",
        value: `sha256:${"b".repeat(64)}`,
        unexpected: true,
      },
    }));

    for (const key of ["__proto__", "prototype", "constructor"]) {
      const request = validRequest();
      defineOwnKey(request, key, "blocked");
      expectRejected(IngestionBatchRequestSchema, request);

      const pointer = validPointer();
      defineOwnKey(pointer, key, "blocked");
      expectRejected(CommittedArchivePointerSchema, pointer);
    }

    const response = {
      schema_version: 1,
      tenant_id: TENANT_ID,
      batch_id: BATCH_ID,
      status: "accepted",
      archive_status: "created",
    };
    defineOwnKey(response, Symbol("secret"), "secret");
    expectRejected(IngestionAcceptedResponseSchema, response);

    const errorResponse = {
      error: { code: "ingestion_invalid", message: "Invalid ingestion request" },
    };
    defineOwnKey(errorResponse.error, "constructor", "blocked");
    expectRejected(IngestionErrorResponseSchema, errorResponse);
  });

  it("rejects cyclic, excessively deep, and excessively wide event payloads", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expectRejected(IngestionBatchRequestSchema, validRequest({
      events: [validEvent({ payload: { cyclic } as never })],
    }));

    let deep: unknown = "leaf";
    for (let index = 0; index < 33; index += 1) deep = { child: deep };
    expectRejected(IngestionBatchRequestSchema, validRequest({
      events: [validEvent({ payload: { deep } as never })],
    }));

    const wide: Record<string, number> = {};
    for (let index = 0; index <= 10_000; index += 1) wide[`entry_${index}`] = index;
    expectRejected(IngestionBatchRequestSchema, validRequest({
      events: [validEvent({ payload: { wide } as never })],
    }));
  });

  it("rejects an acyclic payload above the canonical node bound", () => {
    const treeDepth = 16;
    const makeBinaryTree = (depth: number): unknown =>
      depth === 0
        ? 1
        : { left: makeBinaryTree(depth - 1), right: makeBinaryTree(depth - 1) };

    // 2^(16 + 1) - 1 nodes, with two entries per object and depth 16, so the
    // node limit—not collection width or traversal depth—is the bound hit.
    const totalNodes = 2 ** (treeDepth + 1) - 1;
    expect(totalNodes).toBeGreaterThan(MAX_CANONICAL_JSON_NODES);
    expect(treeDepth).toBeLessThan(MAX_CANONICAL_JSON_DEPTH);
    expect(2).toBeLessThan(MAX_CANONICAL_JSON_COLLECTION_ENTRIES);

    expectRejected(IngestionBatchRequestSchema, validRequest({
      events: [validEvent({ payload: { tree: makeBinaryTree(treeDepth) } as never })],
    }));
  });
});
