import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJsonLineBytes } from "../../archive/canonical-json";
import { deriveArchiveKeys } from "../../archive/keys";
import { archiveCanonicalEventBatch } from "../../archive/writer";
import { ArchiveError } from "../../archive/errors";
import { encodeCanonicalEventBatch, gunzipBytes } from "../../archive/codec";
import {
  cleanupArchiveTenant,
  cloneEvents,
  makeArchiveScope,
  makeEvent,
  makeEvents,
} from "./support";
import type { CanonicalEventEnvelope } from "@communicator/contracts";

const FIXTURE_BODY = "fixture message body that must stay private";

const DATA_HTTP_METADATA = {
  contentType: "application/x-ndjson",
  contentEncoding: "gzip",
} as const;

const MANIFEST_HTTP_METADATA = {
  contentType: "application/json",
} as const;

type ArchiveScope = ReturnType<typeof makeArchiveScope>;

const bucket = (env as Cloudflare.Env).EVENT_ARCHIVE;
const activeTenants: string[] = [];

const newScope = (): ArchiveScope => {
  const scope = makeArchiveScope();
  activeTenants.push(scope.tenantId);
  return scope;
};

afterEach(async () => {
  const tenants = activeTenants.splice(0, activeTenants.length);
  await Promise.all(
    tenants.map((tenantId) => cleanupArchiveTenant(bucket, tenantId)),
  );
});

const eventFor = (
  scope: ArchiveScope,
  overrides: Partial<CanonicalEventEnvelope> = {},
): CanonicalEventEnvelope =>
  makeEvent({
    tenant_id: scope.tenantId,
    ...overrides,
  });

const eventsFor = (
  scope: ArchiveScope,
  count: number,
): CanonicalEventEnvelope[] =>
  makeEvents(count).map((event) => ({ ...event, tenant_id: scope.tenantId }));

const listKeys = async (prefix: string): Promise<string[]> => {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
    if (page.truncated && !cursor) {
      throw new Error(
        "archive test listing returned truncated page without cursor",
      );
    }
  } while (cursor !== undefined);
  return keys.sort();
};

const tenantKeys = async (tenantId: string): Promise<string[]> =>
  (
    await Promise.all([
      listKeys(`events/${tenantId}/`),
      listKeys(`manifests/${tenantId}/`),
    ])
  )
    .flat()
    .sort();

const readBody = async (key: string): Promise<Uint8Array> => {
  const object = await bucket.get(key);
  expect(object).not.toBeNull();
  return new Uint8Array(await object!.arrayBuffer());
};

const getArchiveError = async (
  operation: Promise<unknown>,
): Promise<ArchiveError> => {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveError);
    return error as ArchiveError;
  }
  throw new Error("archive operation unexpectedly succeeded");
};

type PutValue =
  | ReadableStream
  | ArrayBuffer
  | ArrayBufferView
  | string
  | null
  | Blob;

type PutCall = {
  key: string;
  options?: R2PutOptions;
};

const forwardingBucket = (
  source: R2Bucket,
  beforePut: (call: PutCall) => void | Promise<void>,
): R2Bucket =>
  new Proxy(source, {
    get(target, property, _receiver) {
      if (property !== "put") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (
        key: string,
        value: PutValue,
        options?: R2PutOptions,
      ): Promise<R2Object | null> => {
        await beforePut(options === undefined ? { key } : { key, options });
        return target.put(key, value, options) as Promise<R2Object | null>;
      };
    },
  });

const putDataFixture = async (
  scope: ArchiveScope,
  encoded: Awaited<ReturnType<typeof encodeCanonicalEventBatch>>,
): Promise<{ dataKey: string; manifestKey: string }> => {
  const firstEvent = encoded.events[0];
  if (!firstEvent) throw new Error("fixture unexpectedly has no first event");
  const keys = deriveArchiveKeys(
    scope.tenantId,
    scope.batchId,
    firstEvent.observed_at,
  );
  await bucket.put(keys.dataKey, encoded.compressed, {
    httpMetadata: DATA_HTTP_METADATA,
    customMetadata: {
      "schema-version": "1",
      "tenant-id": scope.tenantId,
      "batch-id": scope.batchId,
      "canonical-sha256": encoded.canonicalSha256,
    },
  });
  return keys;
};

describe("archiveCanonicalEventBatch", () => {
  it("writes a two-event batch as exactly one gzip data object and one manifest", async () => {
    const scope = newScope();
    const events = eventsFor(scope, 2);
    const result = await archiveCanonicalEventBatch({
      bucket,
      tenantId: scope.tenantId,
      batchId: scope.batchId,
      events,
      archivedAt: "2026-09-07T02:00:00.000Z",
      producerVersion: "test-writer",
      sourceCheckpoint: { kind: "fixture", value: "cursor-001" },
    });

    expect(result.status).toBe("created");
    expect(result.manifestKey).toBe(
      `manifests/${scope.tenantId}/2026/09/07/01/${scope.batchId}.json`,
    );
    expect(result.manifest.data_key).toBe(
      `events/${scope.tenantId}/2026/09/07/01/${scope.batchId}.jsonl.gz`,
    );
    expect(result.manifest.event_count).toBe(2);
    expect(await tenantKeys(scope.tenantId)).toEqual(
      [result.manifest.data_key, result.manifestKey].sort(),
    );

    const dataObject = await bucket.get(result.manifest.data_key);
    const manifestObject = await bucket.get(result.manifestKey);
    expect(dataObject).not.toBeNull();
    expect(manifestObject).not.toBeNull();
    expect(dataObject!.key).toBe(result.manifest.data_key);
    expect(manifestObject!.key).toBe(result.manifestKey);
    expect(
      await gunzipBytes(new Uint8Array(await dataObject!.arrayBuffer())),
    ).toEqual(
      (await encodeCanonicalEventBatch({ tenantId: scope.tenantId, events }))
        .canonicalJsonl,
    );
    expect(new TextDecoder().decode(await manifestObject!.arrayBuffer())).toBe(
      new TextDecoder().decode(canonicalJsonLineBytes(result.manifest)),
    );
  });

  it("records exact manifest fields and data/manifest storage metadata", async () => {
    const scope = newScope();
    const events = [
      eventFor(scope, {
        event_id: "$first:server",
        occurred_at: "2026-09-07T01:02:02.000Z",
        observed_at: "2026-09-07T01:02:03.000Z",
      }),
      eventFor(scope, {
        event_id: "$last:server",
        occurred_at: "2026-09-07T01:02:04.000Z",
        observed_at: "2026-09-07T01:02:05.000Z",
      }),
    ];
    const encoded = await encodeCanonicalEventBatch({
      tenantId: scope.tenantId,
      events,
    });
    const result = await archiveCanonicalEventBatch({
      bucket,
      tenantId: scope.tenantId,
      batchId: scope.batchId,
      events,
      archivedAt: "2026-09-07T02:00:00.000Z",
      producerVersion: "writer-test/1",
      sourceCheckpoint: { kind: "telegram-update", value: "cursor-001" },
    });

    const dataObject = await bucket.get(result.manifest.data_key);
    const manifestObject = await bucket.get(result.manifestKey);
    expect(dataObject).not.toBeNull();
    expect(manifestObject).not.toBeNull();
    expect(dataObject!.httpMetadata?.contentType).toBe(
      DATA_HTTP_METADATA.contentType,
    );
    expect(dataObject!.httpMetadata?.contentEncoding).toBe(
      DATA_HTTP_METADATA.contentEncoding,
    );
    expect(dataObject!.customMetadata).toEqual({
      "schema-version": "1",
      "tenant-id": scope.tenantId,
      "batch-id": scope.batchId,
      "canonical-sha256": encoded.canonicalSha256,
    });
    expect(manifestObject!.httpMetadata?.contentType).toBe(
      MANIFEST_HTTP_METADATA.contentType,
    );
    expect(manifestObject!.customMetadata).toEqual({
      "schema-version": "1",
      "tenant-id": scope.tenantId,
      "batch-id": scope.batchId,
      "canonical-sha256": encoded.canonicalSha256,
    });
    expect(result.manifest).toMatchObject({
      schema_version: 1,
      tenant_id: scope.tenantId,
      batch_id: scope.batchId,
      compression: "gzip",
      content_type: "application/x-ndjson",
      event_count: 2,
      uncompressed_bytes: encoded.uncompressedBytes,
      compressed_bytes: dataObject!.size,
      canonical_sha256: encoded.canonicalSha256,
      data_etag: dataObject!.etag,
      first_event_id: "$first:server",
      last_event_id: "$last:server",
      first_observed_at: "2026-09-07T01:02:03.000Z",
      last_observed_at: "2026-09-07T01:02:05.000Z",
      archived_at: "2026-09-07T02:00:00.000Z",
      producer: {
        service: "communicator-control-plane",
        version: "writer-test/1",
      },
      source_checkpoint: { kind: "telegram-update", value: "cursor-001" },
    });
    expect(result.manifest.compressed_bytes).toBe(dataObject!.size);
    expect(result.manifest.data_etag).toBe(dataObject!.etag);
  });

  it("does not create one R2 object per event", async () => {
    const scope = newScope();
    const events = eventsFor(scope, 5);
    const result = await archiveCanonicalEventBatch({
      bucket,
      tenantId: scope.tenantId,
      batchId: scope.batchId,
      events,
      archivedAt: "2026-09-07T02:00:00.000Z",
      producerVersion: "writer-test/1",
      sourceCheckpoint: null,
    });

    const keys = await tenantKeys(scope.tenantId);
    expect(keys).toHaveLength(2);
    expect(keys.filter((key) => key.startsWith("events/")).length).toBe(1);
    expect(keys.filter((key) => key.startsWith("manifests/")).length).toBe(1);
    expect(result.manifest.event_count).toBe(events.length);
  });

  it("does not mutate caller arrays or event/payload objects", async () => {
    const scope = newScope();
    const events = [
      eventFor(scope, {
        event_id: "$z:server",
        payload: { z: { value: 1 }, body: FIXTURE_BODY },
        observed_at: "2026-09-07T01:02:05.000Z",
      }),
      eventFor(scope, {
        event_id: "$a:server",
        payload: { a: [1, 2], body: "second" },
        observed_at: "2026-09-07T01:02:03.000Z",
      }),
    ];
    const before = structuredClone(events);
    const beforeArray = events.slice();

    await archiveCanonicalEventBatch({
      bucket,
      tenantId: scope.tenantId,
      batchId: scope.batchId,
      events,
      archivedAt: "2026-09-07T02:00:00.000Z",
      producerVersion: "writer-test/1",
      sourceCheckpoint: null,
    });

    expect(events).toEqual(before);
    expect(events).toEqual(beforeArray);
  });

  it("returns already_committed for an identical retry without changing objects", async () => {
    const scope = newScope();
    const events = eventsFor(scope, 2);
    const first = await archiveCanonicalEventBatch({
      bucket,
      tenantId: scope.tenantId,
      batchId: scope.batchId,
      events,
      archivedAt: "2026-09-07T02:00:00.000Z",
      producerVersion: "writer-test/1",
      sourceCheckpoint: { kind: "fixture", value: "cursor-001" },
    });
    const beforeData = await readBody(first.manifest.data_key);
    const beforeManifest = await readBody(first.manifestKey);
    const beforeKeys = await tenantKeys(scope.tenantId);
    const calls: PutCall[] = [];
    const retryBucket = forwardingBucket(bucket, (call) => {
      calls.push(call);
    });

    const second = await archiveCanonicalEventBatch({
      bucket: retryBucket,
      tenantId: scope.tenantId,
      batchId: scope.batchId,
      events: cloneEvents(events),
      archivedAt: "2026-09-07T02:00:00.000Z",
      producerVersion: "writer-test/1",
      sourceCheckpoint: { kind: "fixture", value: "cursor-001" },
    });

    expect(second.status).toBe("already_committed");
    expect(second.manifestKey).toBe(first.manifestKey);
    expect(second.manifest).toEqual(first.manifest);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.key)).toEqual([
      first.manifest.data_key,
      first.manifestKey,
    ]);
    expect(calls.map((call) => call.options?.onlyIf)).toEqual([
      { etagDoesNotMatch: "*" },
      { etagDoesNotMatch: "*" },
    ]);
    expect(await tenantKeys(scope.tenantId)).toEqual(beforeKeys);
    expect(await readBody(first.manifest.data_key)).toEqual(beforeData);
    expect(await readBody(first.manifestKey)).toEqual(beforeManifest);
  });

  it("rejects changed logical content for the same key without overwriting", async () => {
    const scope = newScope();
    const events = eventsFor(scope, 2);
    const first = await archiveCanonicalEventBatch({
      bucket,
      tenantId: scope.tenantId,
      batchId: scope.batchId,
      events,
      archivedAt: "2026-09-07T02:00:00.000Z",
      producerVersion: "writer-test/1",
      sourceCheckpoint: null,
    });
    const beforeData = await readBody(first.manifest.data_key);
    const beforeManifest = await readBody(first.manifestKey);

    const error = await getArchiveError(
      archiveCanonicalEventBatch({
        bucket,
        tenantId: scope.tenantId,
        batchId: scope.batchId,
        events: [
          events[0]!,
          {
            ...events[1]!,
            payload: { body: "changed logical archive body", order: 999 },
          },
        ],
        archivedAt: "2026-09-07T02:00:00.000Z",
        producerVersion: "writer-test/1",
        sourceCheckpoint: null,
      }),
    );

    expect(error.code).toBe("archive_conflict");
    expect(await tenantKeys(scope.tenantId)).toEqual(
      [first.manifest.data_key, first.manifestKey].sort(),
    );
    expect(await readBody(first.manifest.data_key)).toEqual(beforeData);
    expect(await readBody(first.manifestKey)).toEqual(beforeManifest);
  });

  it("keeps reordered identical events idempotent", async () => {
    const scope = newScope();
    const events = eventsFor(scope, 2);
    const first = await archiveCanonicalEventBatch({
      bucket,
      tenantId: scope.tenantId,
      batchId: scope.batchId,
      events,
      archivedAt: "2026-09-07T02:00:00.000Z",
      producerVersion: "writer-test/1",
      sourceCheckpoint: null,
    });
    const second = await archiveCanonicalEventBatch({
      bucket,
      tenantId: scope.tenantId,
      batchId: scope.batchId,
      events: [events[1]!, events[0]!],
      archivedAt: "2026-09-07T02:00:00.000Z",
      producerVersion: "writer-test/1",
      sourceCheckpoint: null,
    });

    expect(second.status).toBe("already_committed");
    expect(second.manifest).toEqual(first.manifest);
    expect(await tenantKeys(scope.tenantId)).toHaveLength(2);
  });

  it("rejects cross-tenant, duplicate, invalid, excessive-count, and excessive-byte input before any write", async () => {
    const scope = newScope();
    const cases: Array<{
      name: string;
      batchId?: string;
      events: readonly unknown[];
      code: ArchiveError["code"];
    }> = [
      {
        name: "cross tenant",
        events: [eventFor(scope, { tenant_id: "tenant_other" })],
        code: "archive_tenant_mismatch",
      },
      {
        name: "duplicate event ID",
        events: [
          eventFor(scope),
          eventFor(scope, { payload: { body: "different" } }),
        ],
        code: "archive_invalid",
      },
      {
        name: "invalid batch ID",
        batchId: "not-a-batch",
        events: [eventFor(scope)],
        code: "archive_invalid",
      },
      {
        name: "excessive count",
        events: eventsFor(scope, 501),
        code: "archive_too_large",
      },
      {
        name: "excessive bytes",
        events: Array.from({ length: 5 }, (_, index) =>
          eventFor(scope, {
            event_id: `$large-${index}:server`,
            payload: { body: "x".repeat(900_000) },
            occurred_at: `2026-09-07T01:02:${String(index).padStart(2, "0")}.000Z`,
            observed_at: `2026-09-07T01:02:${String(index).padStart(2, "0")}.000Z`,
          }),
        ),
        code: "archive_too_large",
      },
    ];

    for (const testCase of cases) {
      const error = await getArchiveError(
        archiveCanonicalEventBatch({
          bucket,
          tenantId: scope.tenantId,
          batchId: testCase.batchId ?? scope.batchId,
          events: testCase.events,
          archivedAt: "2026-09-07T02:00:00.000Z",
          producerVersion: "writer-test/1",
          sourceCheckpoint: null,
        }),
      );
      expect(error.code, testCase.name).toBe(testCase.code);
      expect(await tenantKeys(scope.tenantId), testCase.name).toEqual([]);
    }
  });

  it("does not write a manifest when the data put fails", async () => {
    const scope = newScope();
    const failingBucket = forwardingBucket(bucket, ({ key }) => {
      if (key.startsWith("events/")) throw new Error(FIXTURE_BODY);
    });

    const error = await getArchiveError(
      archiveCanonicalEventBatch({
        bucket: failingBucket,
        tenantId: scope.tenantId,
        batchId: scope.batchId,
        events: [eventFor(scope)],
        archivedAt: "2026-09-07T02:00:00.000Z",
        producerVersion: "writer-test/1",
        sourceCheckpoint: null,
      }),
    );

    expect(error.code).toBe("archive_unavailable");
    expect(await tenantKeys(scope.tenantId)).toEqual([]);
  });

  it("leaves one orphan data object and no manifest when the manifest put fails", async () => {
    const scope = newScope();
    const failingBucket = forwardingBucket(bucket, ({ key }) => {
      if (key.startsWith("manifests/"))
        throw new Error("synthetic manifest outage");
    });

    const error = await getArchiveError(
      archiveCanonicalEventBatch({
        bucket: failingBucket,
        tenantId: scope.tenantId,
        batchId: scope.batchId,
        events: [eventFor(scope)],
        archivedAt: "2026-09-07T02:00:00.000Z",
        producerVersion: "writer-test/1",
        sourceCheckpoint: null,
      }),
    );

    expect(error.code).toBe("archive_unavailable");
    const keys = await tenantKeys(scope.tenantId);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^events\//);
  });

  it("reuses a verified orphan data object and commits its manifest on retry", async () => {
    const scope = newScope();
    const events = [eventFor(scope)];
    const failingBucket = forwardingBucket(bucket, ({ key }) => {
      if (key.startsWith("manifests/"))
        throw new Error("synthetic manifest outage");
    });

    await expect(
      archiveCanonicalEventBatch({
        bucket: failingBucket,
        tenantId: scope.tenantId,
        batchId: scope.batchId,
        events,
        archivedAt: "2026-09-07T02:00:00.000Z",
        producerVersion: "writer-test/1",
        sourceCheckpoint: null,
      }),
    ).rejects.toMatchObject({ code: "archive_unavailable" });

    const retry = await archiveCanonicalEventBatch({
      bucket,
      tenantId: scope.tenantId,
      batchId: scope.batchId,
      events,
      archivedAt: "2026-09-07T02:00:00.000Z",
      producerVersion: "writer-test/1",
      sourceCheckpoint: null,
    });

    expect(retry.status).toBe("created");
    expect(await tenantKeys(scope.tenantId)).toEqual(
      [retry.manifest.data_key, retry.manifestKey].sort(),
    );
  });

  it("conflicts with an existing corrupted data object and never overwrites it", async () => {
    const scope = newScope();
    const events = [eventFor(scope)];
    const encoded = await encodeCanonicalEventBatch({
      tenantId: scope.tenantId,
      events,
    });
    const keys = await putDataFixture(scope, encoded);
    const corrupted = encoded.compressed.slice();
    corrupted[corrupted.length - 1]! ^= 0x01;
    await bucket.delete(keys.dataKey);
    await bucket.put(keys.dataKey, corrupted, {
      httpMetadata: DATA_HTTP_METADATA,
      customMetadata: {
        "schema-version": "1",
        "tenant-id": scope.tenantId,
        "batch-id": scope.batchId,
        "canonical-sha256": encoded.canonicalSha256,
      },
    });

    const error = await getArchiveError(
      archiveCanonicalEventBatch({
        bucket,
        tenantId: scope.tenantId,
        batchId: scope.batchId,
        events,
        archivedAt: "2026-09-07T02:00:00.000Z",
        producerVersion: "writer-test/1",
        sourceCheckpoint: null,
      }),
    );

    expect(error.code).toBe("archive_conflict");
    expect(error.message).not.toContain(FIXTURE_BODY);
    expect(await tenantKeys(scope.tenantId)).toEqual([keys.dataKey]);
    expect(await readBody(keys.dataKey)).toEqual(corrupted);
  });

  it("conflicts with an existing corrupted manifest and never overwrites it", async () => {
    const scope = newScope();
    const events = [eventFor(scope)];
    const encoded = await encodeCanonicalEventBatch({
      tenantId: scope.tenantId,
      events,
    });
    const keys = await putDataFixture(scope, encoded);
    await bucket.put(keys.manifestKey, new TextEncoder().encode(FIXTURE_BODY), {
      httpMetadata: MANIFEST_HTTP_METADATA,
      customMetadata: {
        "schema-version": "1",
        "tenant-id": scope.tenantId,
        "batch-id": scope.batchId,
        "canonical-sha256": encoded.canonicalSha256,
      },
    });

    const error = await getArchiveError(
      archiveCanonicalEventBatch({
        bucket,
        tenantId: scope.tenantId,
        batchId: scope.batchId,
        events,
        archivedAt: "2026-09-07T02:00:00.000Z",
        producerVersion: "writer-test/1",
        sourceCheckpoint: null,
      }),
    );

    expect(error.code).toBe("archive_conflict");
    expect(error.message).not.toContain(FIXTURE_BODY);
    expect(await tenantKeys(scope.tenantId)).toEqual(
      [keys.dataKey, keys.manifestKey].sort(),
    );
    expect(await readBody(keys.manifestKey)).toEqual(
      new TextEncoder().encode(FIXTURE_BODY),
    );
  });

  it("maps unexpected storage errors to safe messages without leaking fixture bodies", async () => {
    const scope = newScope();
    const failingBucket = forwardingBucket(bucket, () => {
      throw new Error(FIXTURE_BODY);
    });

    const error = await getArchiveError(
      archiveCanonicalEventBatch({
        bucket: failingBucket,
        tenantId: scope.tenantId,
        batchId: scope.batchId,
        events: [eventFor(scope)],
        archivedAt: "2026-09-07T02:00:00.000Z",
        producerVersion: "writer-test/1",
        sourceCheckpoint: null,
      }),
    );

    expect(error.code).toBe("archive_unavailable");
    expect(error.message).not.toContain(FIXTURE_BODY);
    expect(error.message).not.toContain("Error:");
    expect(await tenantKeys(scope.tenantId)).toEqual([]);
  });
});
