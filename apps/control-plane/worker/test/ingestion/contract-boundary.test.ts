import type {
  IngestionBatchRequest,
  ProjectionEventEnvelope,
} from "@communicator/contracts";
import {
  IngestionBatchRequestSchema,
  MAX_ARCHIVE_EVENTS,
  MAX_INGESTION_QUEUE_POINTER_BYTES,
  MAX_PROJECTION_BATCH_BYTES,
} from "@communicator/contracts";
import { describe, expect, it } from "vitest";
import { canonicalJsonBytes } from "../../archive/canonical-json";
import { encodeCanonicalEventBatch, sha256Hex } from "../../archive/codec";
import { IngestionError } from "../../ingestion/errors";
import {
  buildCommittedArchivePointer,
  prepareIngestionBatch,
} from "../../ingestion/prepare";

const TENANT_ID = "tenant_ingestion_test";
const GATEWAY_ROUTE_ID = "gateway_route_test";
const SOURCE_CHECKPOINT = {
  kind: "matrix_sync_token_sha256" as const,
  value: `sha256:${"b".repeat(64)}`,
};
const ARCHIVED_AT = "2026-09-07T02:03:04.000+00:00";

const eventFor = (
  index: number,
  overrides: Partial<ProjectionEventEnvelope> = {},
): ProjectionEventEnvelope => ({
  schema_version: 1,
  event_id: `$event-${index}:server`,
  event_type: "message.created",
  event_source: "live",
  tenant_id: TENANT_ID,
  identity_id: "identity_ingestion",
  platform: "whatsapp",
  account_id: "account_ingestion_whatsapp",
  conversation_id: `conversation_ingestion_${String(index).padStart(4, "0")}`,
  matrix_room_id: "!room:server",
  matrix_event_id: `$matrix-${index}:server`,
  remote_message_id: `remote-${index}`,
  occurred_at: `2026-09-07T01:00:${String(index % 60).padStart(2, "0")}.000Z`,
  observed_at: `2026-09-07T01:00:${String(index % 60).padStart(2, "0")}.500Z`,
  payload: {
    message_id: `message_ingestion_${String(index).padStart(4, "0")}`,
    direction: "inbound",
    sender_participant_id: null,
    sender_label: "Ingestion fixture",
    body: "",
    reply_to_message_id: null,
    delivery_status: "unknown",
    unread: true,
  },
  ...overrides,
} as ProjectionEventEnvelope);

const identityBytesFor = async (
  request: Omit<IngestionBatchRequest, "batch_id"> & { batch_id?: string },
  canonicalSha256: string,
): Promise<string> => {
  const identity = Object.create(null) as Record<string, unknown>;
  identity.schema_version = request.schema_version;
  identity.tenant_id = request.tenant_id;
  identity.gateway_route_id = request.gateway_route_id;
  identity.canonical_sha256 = canonicalSha256;
  identity.source_checkpoint = {
    kind: request.source_checkpoint.kind,
    value: request.source_checkpoint.value,
  };
  identity.archived_at = request.archived_at;
  identity.producer_version = request.producer_version;
  return `batch_${await sha256Hex(canonicalJsonBytes(identity))}`;
};

const requestFor = async (
  events: ProjectionEventEnvelope[],
  overrides: Partial<Omit<IngestionBatchRequest, "events" | "batch_id">> = {},
): Promise<IngestionBatchRequest> => {
  const encoded = await encodeCanonicalEventBatch({ tenantId: TENANT_ID, events });
  const requestWithoutBatch = {
    schema_version: 1 as const,
    gateway_route_id: GATEWAY_ROUTE_ID,
    tenant_id: TENANT_ID,
    archived_at: ARCHIVED_AT,
    producer_version: "gateway-test-1",
    source_checkpoint: SOURCE_CHECKPOINT,
    ...overrides,
    events,
  };
  return {
    ...requestWithoutBatch,
    batch_id: await identityBytesFor(requestWithoutBatch, encoded.canonicalSha256),
  };
};

const errorFrom = async (operation: Promise<unknown>): Promise<IngestionError> => {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(IngestionError);
    return error as IngestionError;
  }
  throw new Error("operation unexpectedly succeeded");
};

describe("prepareIngestionBatch", () => {
  it("returns sorted projection events, exact canonical bytes, identity, and archive input", async () => {
    const events = [eventFor(2), eventFor(1)];
    const request = await requestFor(events);
    const prepared = await prepareIngestionBatch(request);
    const encoded = await encodeCanonicalEventBatch({
      tenantId: TENANT_ID,
      events,
    });

    expect(prepared.batchId).toBe(request.batch_id);
    expect(prepared.recomputedBatchId).toBe(request.batch_id);
    expect(prepared.events.map((event) => event.event_id)).toEqual([
      "$event-1:server",
      "$event-2:server",
    ]);
    expect(prepared.canonicalJsonl).toEqual(encoded.canonicalJsonl);
    expect(prepared.canonicalSha256).toBe(encoded.canonicalSha256);
    expect(prepared.archiveInput).toEqual({
      tenantId: TENANT_ID,
      batchId: request.batch_id,
      events: prepared.events,
      archivedAt: ARCHIVED_AT,
      producerVersion: "gateway-test-1",
      sourceCheckpoint: SOURCE_CHECKPOINT,
    });
  });

  it("is byte-identical across object key order and repeated preparation", async () => {
    const first = await requestFor([eventFor(1), eventFor(2)]);
    const second = JSON.parse(
      JSON.stringify({
        events: first.events.map((event) => ({
          payload: event.payload,
          observed_at: event.observed_at,
          occurred_at: event.occurred_at,
          remote_message_id: event.remote_message_id,
          matrix_event_id: event.matrix_event_id,
          matrix_room_id: event.matrix_room_id,
          conversation_id: event.conversation_id,
          account_id: event.account_id,
          platform: event.platform,
          identity_id: event.identity_id,
          tenant_id: event.tenant_id,
          event_source: event.event_source,
          event_type: event.event_type,
          event_id: event.event_id,
          schema_version: event.schema_version,
        })),
        source_checkpoint: {
          value: first.source_checkpoint.value,
          kind: first.source_checkpoint.kind,
        },
        producer_version: first.producer_version,
        archived_at: first.archived_at,
        batch_id: first.batch_id,
        tenant_id: first.tenant_id,
        gateway_route_id: first.gateway_route_id,
        schema_version: first.schema_version,
      }),
    ) as IngestionBatchRequest;

    const preparations = await Promise.all([
      prepareIngestionBatch(first),
      prepareIngestionBatch(second),
      prepareIngestionBatch(first),
    ]);
    expect(new TextDecoder().decode(preparations[0]!.canonicalJsonl)).toBe(
      new TextDecoder().decode(preparations[1]!.canonicalJsonl),
    );
    expect(preparations[0]!.canonicalSha256).toBe(preparations[1]!.canonicalSha256);
    expect(preparations[0]!.batchId).toBe(preparations[1]!.batchId);
    expect(preparations[0]!.canonicalJsonl).toEqual(preparations[2]!.canonicalJsonl);
    expect(preparations[0]!.archiveInput).toEqual(preparations[1]!.archiveInput);
  });

  it("changes identity for every immutable field and rejects a caller mismatch", async () => {
    const request = await requestFor([eventFor(1)]);
    const prepared = await prepareIngestionBatch(request);
    const immutableChanges: Array<Partial<IngestionBatchRequest>> = [
      { tenant_id: "tenant_other_ingestion" },
      { gateway_route_id: "gateway_route_other" },
      { archived_at: "2026-09-07T02:03:05.000Z" },
      { producer_version: "gateway-test-2" },
      {
        source_checkpoint: {
          kind: "matrix_sync_token_sha256",
          value: `sha256:${"c".repeat(64)}`,
        },
      },
    ];

    for (const change of immutableChanges) {
      const changed = {
        ...request,
        ...change,
        ...(change.tenant_id
          ? {
              events: request.events.map((event) => ({
                ...event,
                tenant_id: change.tenant_id,
              })),
            }
          : {}),
      } as IngestionBatchRequest;
      const encoded = await encodeCanonicalEventBatch({
        tenantId: changed.tenant_id,
        events: changed.events,
      });
      const changedId = await identityBytesFor(changed, encoded.canonicalSha256);
      expect(changedId).not.toBe(prepared.recomputedBatchId);
    }

    const mismatch = { ...request, batch_id: `batch_${"f".repeat(64)}` };
    const failure = await errorFrom(prepareIngestionBatch(mismatch));
    expect(failure.code).toBe("ingestion_invalid");
    expect(failure.message).toBe("Invalid ingestion request");
    expect(failure.message).not.toContain(request.batch_id);
  });

  it("preserves the caller archived_at and detaches/freeze-protects prepared data", async () => {
    const request = await requestFor([eventFor(1)]);
    const prepared = await prepareIngestionBatch(request);
    expect(prepared.archivedAt).toBe(ARCHIVED_AT);
    expect(prepared.archiveInput.archivedAt).toBe(ARCHIVED_AT);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.events)).toBe(true);
    expect(Object.isFrozen(prepared.archiveInput)).toBe(true);
    expect(Object.isFrozen(prepared.archiveInput.events)).toBe(true);

    request.events[0]!.payload = {
      ...(request.events[0]!.payload as Record<string, unknown>),
      body: "caller mutation",
    } as never;
    expect((prepared.events[0]!.payload as { body: string }).body).toBe("");
    expect(() => {
      (prepared.events as ProjectionEventEnvelope[])[0] = eventFor(99);
    }).toThrow();
  });

  it("returns a defensive canonicalJsonl copy on every read", async () => {
    const request = await requestFor([eventFor(1)]);
    const prepared = await prepareIngestionBatch(request);
    const canonicalBefore = prepared.canonicalJsonl.slice();
    const requestBefore = structuredClone(prepared.request);
    const eventsBefore = structuredClone(prepared.events);
    const archiveInputBefore = structuredClone(prepared.archiveInput);

    const firstRead = prepared.canonicalJsonl;
    firstRead[0] = (firstRead[0] ?? 0) ^ 0xff;

    expect(prepared.canonicalJsonl).toEqual(canonicalBefore);
    expect(await sha256Hex(prepared.canonicalJsonl)).toBe(prepared.canonicalSha256);
    expect(prepared.request).toEqual(requestBefore);
    expect(prepared.events).toEqual(eventsBefore);
    expect(prepared.archiveInput).toEqual(archiveInputBefore);
  });

  it("accepts exactly 500 events and exactly 4 MiB of canonical JSONL", async () => {
    const events = Array.from({ length: MAX_ARCHIVE_EVENTS }, (_, index) =>
      eventFor(index),
    );
    const base = await encodeCanonicalEventBatch({ tenantId: TENANT_ID, events });
    const target = MAX_PROJECTION_BATCH_BYTES;
    let remaining = target - base.uncompressedBytes;
    expect(remaining).toBeGreaterThan(0);
    for (const event of events) {
      const currentBody = (event.payload as { body: string }).body;
      const additional = Math.min(20_000 - currentBody.length, remaining);
      event.payload = {
        ...(event.payload as Record<string, unknown>),
        body: currentBody + "x".repeat(additional),
      } as never;
      remaining -= additional;
      if (remaining === 0) break;
    }
    expect(remaining).toBe(0);
    const request = await requestFor(events);
    const prepared = await prepareIngestionBatch(request);
    expect(prepared.events).toHaveLength(MAX_ARCHIVE_EVENTS);
    expect(prepared.uncompressedBytes).toBe(target);
  });

  it("rejects 501 events and canonical bytes over 4 MiB as ingestion_too_large", async () => {
    const tooManyEvents = Array.from({ length: MAX_ARCHIVE_EVENTS + 1 }, (_, index) =>
      eventFor(index),
    );
    const tooMany = {
      schema_version: 1,
      gateway_route_id: GATEWAY_ROUTE_ID,
      tenant_id: TENANT_ID,
      batch_id: `batch_${"a".repeat(64)}`,
      archived_at: ARCHIVED_AT,
      producer_version: "gateway-test-1",
      source_checkpoint: SOURCE_CHECKPOINT,
      events: tooManyEvents,
    };
    expect(IngestionBatchRequestSchema.safeParse(tooMany).success).toBe(false);
    await expect(errorFrom(prepareIngestionBatch(tooMany))).resolves.toMatchObject({
      code: "ingestion_too_large",
    });

    const events = Array.from({ length: MAX_ARCHIVE_EVENTS }, (_, index) =>
      eventFor(index),
    );
    const base = await encodeCanonicalEventBatch({ tenantId: TENANT_ID, events });
    let remaining = MAX_PROJECTION_BATCH_BYTES - base.uncompressedBytes;
    for (const event of events) {
      const currentBody = (event.payload as { body: string }).body;
      const additional = Math.min(20_000 - currentBody.length, remaining);
      event.payload = {
        ...(event.payload as Record<string, unknown>),
        body: currentBody + "x".repeat(additional),
      } as never;
      remaining -= additional;
      if (remaining === 0) break;
    }
    expect(remaining).toBe(0);
    const overflowEvent = events.find(
      (event) => (event.payload as { body: string }).body.length < 20_000,
    );
    expect(overflowEvent).toBeDefined();
    overflowEvent!.payload = {
      ...(overflowEvent!.payload as Record<string, unknown>),
      body: `${(overflowEvent!.payload as { body: string }).body}x`,
    } as never;
    const overLimit: IngestionBatchRequest = {
      schema_version: 1,
      gateway_route_id: GATEWAY_ROUTE_ID,
      tenant_id: TENANT_ID,
      batch_id: `batch_${"a".repeat(64)}`,
      archived_at: ARCHIVED_AT,
      producer_version: "gateway-test-1",
      source_checkpoint: SOURCE_CHECKPOINT,
      events,
    };
    await expect(errorFrom(prepareIngestionBatch(overLimit))).resolves.toMatchObject({
      code: "ingestion_too_large",
    });
  });
});

describe("buildCommittedArchivePointer", () => {
  it("constructs a strict pointer and enforces the canonical 8 KiB bound", async () => {
    const request = await requestFor([eventFor(1)]);
    const prepared = await prepareIngestionBatch(request);
    const pointer = buildCommittedArchivePointer({
      tenantId: prepared.tenantId,
      batchId: prepared.batchId,
      gatewayRouteId: GATEWAY_ROUTE_ID,
      manifestKey: `manifests/${TENANT_ID}/2026/09/07/01/${prepared.batchId}.json`,
      canonicalSha256: prepared.canonicalSha256,
    });

    expect(pointer).toEqual({
      schema_version: 1,
      kind: "archive.batch.committed",
      tenant_id: TENANT_ID,
      batch_id: prepared.batchId,
      manifest_key: `manifests/${TENANT_ID}/2026/09/07/01/${prepared.batchId}.json`,
      canonical_sha256: prepared.canonicalSha256,
      gateway_route_id: GATEWAY_ROUTE_ID,
    });
    expect(canonicalJsonBytes(pointer).byteLength).toBeLessThanOrEqual(
      MAX_INGESTION_QUEUE_POINTER_BYTES,
    );
    expect(Object.isFrozen(pointer)).toBe(true);
  });
});
