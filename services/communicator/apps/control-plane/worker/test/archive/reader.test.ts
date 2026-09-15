import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ArchiveBatchManifest,
  CanonicalEventEnvelope,
} from "@communicator/contracts";
import {
  MAX_ARCHIVE_MANIFEST_BYTES,
  MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  MAX_REPLAY_PAGE_EVENTS,
  MAX_REPLAY_PAGE_UNCOMPRESSED_BYTES,
} from "@communicator/contracts";
import {
  decodeReplayCursor,
  encodeReplayCursor,
  listCommittedManifestPage,
  readCommittedArchiveBatch,
  readReplayPage,
} from "../../archive/reader";
import { ArchiveError } from "../../archive/errors";
import {
  encodeCanonicalEventBatch,
  gzipBytes,
  sha256Hex,
} from "../../archive/codec";
import { canonicalJsonLineBytes } from "../../archive/canonical-json";
import { canonicalEventJsonBytes } from "../../archive/canonical-json";
import { deriveArchiveKeys } from "../../archive/keys";
import { archiveCanonicalEventBatch } from "../../archive/writer";
import {
  cleanupArchiveTenant,
  makeArchiveScope,
  makeEvent,
  makeEvents,
} from "./support";

const bucket = (env as Cloudflare.Env).EVENT_ARCHIVE;
const activeTenants: string[] = [];

type ArchiveScope = ReturnType<typeof makeArchiveScope>;
type ManifestPage = {
  items: Array<{ key: string; manifest: ArchiveBatchManifest }>;
  next_cursor: string | null;
};

const newScope = (): ArchiveScope => {
  const scope = makeArchiveScope();
  activeTenants.push(scope.tenantId);
  return scope;
};

const eventFor = (
  scope: ArchiveScope,
  overrides: Partial<CanonicalEventEnvelope> = {},
): CanonicalEventEnvelope =>
  makeEvent({ tenant_id: scope.tenantId, ...overrides });

const eventsFor = (
  scope: ArchiveScope,
  count: number,
): CanonicalEventEnvelope[] =>
  makeEvents(count).map((event) => ({ ...event, tenant_id: scope.tenantId }));

const seedBatch = async (
  scope: ArchiveScope,
  events: readonly CanonicalEventEnvelope[] = eventsFor(scope, 1),
  batchId = scope.batchId,
): Promise<Awaited<ReturnType<typeof archiveCanonicalEventBatch>>> =>
  archiveCanonicalEventBatch({
    bucket,
    tenantId: scope.tenantId,
    batchId,
    events,
    archivedAt: "2026-09-07T02:00:00.000Z",
    producerVersion: "reader-test/1",
    sourceCheckpoint: null,
  });

const metadataFor = (
  manifest: ArchiveBatchManifest,
): Record<string, string> => ({
  "schema-version": "1",
  "tenant-id": manifest.tenant_id,
  "batch-id": manifest.batch_id,
  "canonical-sha256": manifest.canonical_sha256,
});

const overwriteManifest = async (
  manifest: ArchiveBatchManifest,
  changes: Partial<ArchiveBatchManifest> = {},
  metadata = metadataFor(manifest),
): Promise<ArchiveBatchManifest> => {
  const key = manifestKeyFor(manifest);
  const next = { ...manifest, ...changes } as ArchiveBatchManifest;
  await bucket.put(key, canonicalJsonLineBytes(next), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: metadata,
  });
  return next;
};

const manifestKeyFor = (manifest: ArchiveBatchManifest): string => {
  const dataPrefix = "events/" + manifest.tenant_id;
  if (!manifest.data_key.startsWith(dataPrefix)) {
    throw new Error("fixture data key missing tenant prefix");
  }
  return (
    "manifests/" +
    manifest.tenant_id +
    manifest.data_key.slice(dataPrefix.length, -".jsonl.gz".length) +
    ".json"
  );
};

const overwriteDataAndManifest = async (
  committed: Awaited<ReturnType<typeof archiveCanonicalEventBatch>>,
  canonicalJsonl: Uint8Array,
  changes: Partial<ArchiveBatchManifest> = {},
): Promise<ArchiveBatchManifest> => {
  const compressed = await gzipBytes(canonicalJsonl);
  const hash = await sha256Hex(canonicalJsonl);
  const base = committed.manifest;
  await bucket.put(base.data_key, compressed, {
    httpMetadata: {
      contentType: "application/x-ndjson",
      contentEncoding: "gzip",
    },
    customMetadata: {
      "schema-version": "1",
      "tenant-id": base.tenant_id,
      "batch-id": base.batch_id,
      "canonical-sha256": hash,
    },
  });
  const dataObject = await bucket.get(base.data_key);
  if (!dataObject)
    throw new Error("fixture data object missing after overwrite");
  const next = {
    ...base,
    ...changes,
    uncompressed_bytes: canonicalJsonl.byteLength,
    compressed_bytes: dataObject.size,
    canonical_sha256: hash,
    data_etag: dataObject.etag,
  } as ArchiveBatchManifest;
  await bucket.put(committed.manifestKey, canonicalJsonLineBytes(next), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: metadataFor(next),
  });
  return next;
};

const overwriteCompressedDataAndManifest = async (
  committed: Awaited<ReturnType<typeof archiveCanonicalEventBatch>>,
  compressed: Uint8Array,
  decodedBytes: Uint8Array,
  changes: Partial<ArchiveBatchManifest> = {},
): Promise<ArchiveBatchManifest> => {
  const hash = await sha256Hex(decodedBytes);
  const base = committed.manifest;
  await bucket.put(base.data_key, compressed, {
    httpMetadata: {
      contentType: "application/x-ndjson",
      contentEncoding: "gzip",
    },
    customMetadata: {
      "schema-version": "1",
      "tenant-id": base.tenant_id,
      "batch-id": base.batch_id,
      "canonical-sha256": hash,
    },
  });
  const dataObject = await bucket.get(base.data_key);
  if (!dataObject)
    throw new Error("fixture data object missing after overwrite");
  const next = {
    ...base,
    ...changes,
    uncompressed_bytes: decodedBytes.byteLength,
    compressed_bytes: dataObject.size,
    canonical_sha256: hash,
    data_etag: dataObject.etag,
  } as ArchiveBatchManifest;
  await bucket.put(committed.manifestKey, canonicalJsonLineBytes(next), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: metadataFor(next),
  });
  return next;
};

const makeExactUncompressedEvents = (
  scope: ArchiveScope,
  label: string,
  targetBytes = MAX_ARCHIVE_UNCOMPRESSED_BYTES,
): CanonicalEventEnvelope[] => {
  const empty = Array.from({ length: 4 }, (_, index) =>
    eventFor(scope, {
      event_id: "$" + label + "-" + index + ":server",
      payload: { body: "" },
    }),
  );
  const baseBytes = empty.reduce(
    (total, event) => total + canonicalEventJsonBytes(event).byteLength + 1,
    0,
  );
  const bodyBytes = targetBytes - baseBytes;
  const each = Math.floor(bodyBytes / empty.length);
  let remainder = bodyBytes - each * empty.length;
  return empty.map((event) => {
    const length = each + (remainder-- > 0 ? 1 : 0);
    return { ...event, payload: { body: "x".repeat(length) } };
  });
};

const expectArchiveError = async (
  operation: Promise<unknown>,
  code: ArchiveError["code"],
): Promise<void> => {
  await expect(operation).rejects.toMatchObject({ code });
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

const rawCursor = (json: string): string => {
  const binary = Array.from(new TextEncoder().encode(json), (byte) =>
    String.fromCharCode(byte),
  ).join("");
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

const forwardingBucket = (
  source: R2Bucket,
  overrides: Partial<{
    list: (options?: R2ListOptions) => Promise<R2Objects>;
    get: (key: string, options?: R2GetOptions) => Promise<R2ObjectBody | null>;
  }>,
): R2Bucket =>
  new Proxy(source, {
    get(target, property, receiver) {
      if (property === "list" && overrides.list) return overrides.list;
      if (property === "get" && overrides.get) return overrides.get;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

afterEach(async () => {
  const tenants = activeTenants.splice(0, activeTenants.length);
  await Promise.all(
    tenants.map((tenantId) => cleanupArchiveTenant(bucket, tenantId)),
  );
});

describe("replay cursor", () => {
  it("round-trips a canonical unpadded base64url cursor", () => {
    const payload = {
      schema_version: 1 as const,
      tenant_id: "tenant_pilot",
      manifest_prefix: "manifests/tenant_pilot/",
      r2_cursor: "opaque-r2-cursor",
    };
    const cursor = encodeReplayCursor(payload);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain("=");
    expect(
      decodeReplayCursor(cursor, payload.tenant_id, payload.manifest_prefix),
    ).toEqual(payload);
  });

  it("rejects malformed, padded, oversized, foreign, and noncanonical cursors", () => {
    const payload = {
      schema_version: 1 as const,
      tenant_id: "tenant_pilot",
      manifest_prefix: "manifests/tenant_pilot/",
      r2_cursor: "opaque-r2-cursor",
    };
    const valid = encodeReplayCursor(payload);
    expect(() =>
      decodeReplayCursor("", payload.tenant_id, payload.manifest_prefix),
    ).toThrow(ArchiveError);
    expect(() =>
      decodeReplayCursor(
        valid + "=",
        payload.tenant_id,
        payload.manifest_prefix,
      ),
    ).toThrow(ArchiveError);
    expect(() =>
      decodeReplayCursor(
        "A".repeat(4097),
        payload.tenant_id,
        payload.manifest_prefix,
      ),
    ).toThrow(ArchiveError);
    expect(() =>
      decodeReplayCursor(valid, "tenant_other", "manifests/tenant_other/"),
    ).toThrow(ArchiveError);
    const base = JSON.stringify({
      schema_version: 1,
      tenant_id: "tenant_pilot",
      manifest_prefix: "manifests/tenant_pilot/",
      r2_cursor: "opaque-r2-cursor",
    });
    expect(() =>
      decodeReplayCursor(
        rawCursor(base.replace('"schema_version":1', '"schema_version":2')),
        "tenant_pilot",
        "manifests/tenant_pilot/",
      ),
    ).toThrow(ArchiveError);
    expect(() =>
      decodeReplayCursor(
        rawCursor(
          base.replace(
            '"r2_cursor":"opaque-r2-cursor"',
            '"unknown":true,"r2_cursor":"opaque-r2-cursor"',
          ),
        ),
        "tenant_pilot",
        "manifests/tenant_pilot/",
      ),
    ).toThrow(ArchiveError);
    expect(() =>
      decodeReplayCursor(
        rawCursor(
          base.replace('"r2_cursor":"opaque-r2-cursor"', '"r2_cursor":""'),
        ),
        "tenant_pilot",
        "manifests/tenant_pilot/",
      ),
    ).toThrow(ArchiveError);
    expect(() =>
      decodeReplayCursor(
        rawCursor(
          '{"r2_cursor":"opaque-r2-cursor","manifest_prefix":"manifests/tenant_pilot/","tenant_id":"tenant_pilot","schema_version":1}',
        ),
        "tenant_pilot",
        "manifests/tenant_pilot/",
      ),
    ).toThrow(ArchiveError);
  });
});

describe("tenant-scoped manifest listing", () => {
  it("lists only committed manifests for the trusted tenant", async () => {
    const scope = newScope();
    const other = newScope();
    const committed = await seedBatch(scope);
    await seedBatch(other);
    const orphan = await encodeCanonicalEventBatch({
      tenantId: scope.tenantId,
      events: [eventFor(scope, { event_id: "$orphan:server" })],
    });
    const orphanKeys = deriveArchiveKeys(
      scope.tenantId,
      "batch_orphan",
      orphan.events[0]!.observed_at,
    );
    await bucket.put(orphanKeys.dataKey, orphan.compressed, {
      httpMetadata: {
        contentType: "application/x-ndjson",
        contentEncoding: "gzip",
      },
      customMetadata: {
        "schema-version": "1",
        "tenant-id": scope.tenantId,
        "batch-id": "batch_orphan",
        "canonical-sha256": orphan.canonicalSha256,
      },
    });
    const result = (await listCommittedManifestPage(bucket, scope.tenantId, {
      pageSize: 100,
    })) as ManifestPage;
    expect(result.items.map((item) => item.key)).toEqual([
      committed.manifestKey,
    ]);
    expect(result.items[0]?.manifest).toEqual(committed.manifest);
    expect(result.items.every((item) => !item.key.startsWith("events/"))).toBe(
      true,
    );
  });

  it("accepts page sizes 1, 50, and 100 and rejects invalid sizes", async () => {
    const scope = newScope();
    await seedBatch(scope);
    for (const pageSize of [1, 50, 100]) {
      const result = await listCommittedManifestPage(bucket, scope.tenantId, {
        pageSize,
      });
      expect(result.items).toHaveLength(1);
    }
    for (const pageSize of [
      0,
      101,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      await expectArchiveError(
        listCommittedManifestPage(bucket, scope.tenantId, { pageSize }),
        "archive_invalid",
      );
    }
  });

  it("preserves R2 manifest key order across wrapped pages", async () => {
    const scope = newScope();
    await seedBatch(
      scope,
      [eventFor(scope, { event_id: "$page-1:server" })],
      "batch_page_1",
    );
    await seedBatch(
      scope,
      [eventFor(scope, { event_id: "$page-2:server" })],
      "batch_page_2",
    );
    await seedBatch(
      scope,
      [eventFor(scope, { event_id: "$page-3:server" })],
      "batch_page_3",
    );
    const first = await listCommittedManifestPage(bucket, scope.tenantId, {
      pageSize: 1,
    });
    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();
    const second = await listCommittedManifestPage(bucket, scope.tenantId, {
      pageSize: 1,
      cursor: first.next_cursor!,
    });
    expect(second.items).toHaveLength(1);
    expect(second.next_cursor).not.toBeNull();
    expect(second.items[0]!.key > first.items[0]!.key).toBe(true);
  });

  it("uses truncated plus a nonempty R2 cursor for continuation", async () => {
    const scope = newScope();
    const calls: R2ListOptions[] = [];
    const source = forwardingBucket(bucket, {
      list: async (options) => {
        calls.push(options ?? {});
        return {
          objects: [],
          delimitedPrefixes: [],
          truncated: true,
          cursor: "r2-next",
        };
      },
    });
    const first = await listCommittedManifestPage(source, scope.tenantId);
    expect(first.next_cursor).not.toBeNull();
    expect(calls[0]).toMatchObject({
      prefix: "manifests/" + scope.tenantId + "/",
      limit: 50,
    });
  });

  it("continues when R2 returns fewer objects than the requested limit", async () => {
    const scope = newScope();
    const committed = await seedBatch(scope);
    const calls: R2ListOptions[] = [];
    const source = forwardingBucket(bucket, {
      list: async (options) => {
        calls.push(options ?? {});
        return {
          objects: [{ key: committed.manifestKey } as R2Object],
          delimitedPrefixes: [],
          truncated: true,
          cursor: "r2-fewer-than-limit",
        };
      },
    });
    const result = await listCommittedManifestPage(source, scope.tenantId, {
      pageSize: 100,
    });
    expect(result.items).toHaveLength(1);
    expect(result.next_cursor).not.toBeNull();
    expect(calls[0]?.limit).toBe(100);
  });

  it("rejects truncated responses without a cursor and returned keys outside the prefix", async () => {
    const scope = newScope();
    const noCursor = forwardingBucket(bucket, {
      list: async () =>
        ({
          objects: [],
          delimitedPrefixes: [],
          truncated: true,
          cursor: "",
        }) as unknown as R2Objects,
    });
    await expectArchiveError(
      listCommittedManifestPage(noCursor, scope.tenantId),
      "archive_corrupt",
    );
    const outside = forwardingBucket(bucket, {
      list: async () => ({
        objects: [
          {
            key: "manifests/tenant_other/2026/09/07/01/batch_x.json",
          } as R2Object,
        ],
        delimitedPrefixes: [],
        truncated: false,
      }),
    });
    await expectArchiveError(
      listCommittedManifestPage(outside, scope.tenantId),
      "archive_corrupt",
    );
  });
});

describe("committed archive reads", () => {
  it("reads a committed batch and returns copy-safe data", async () => {
    const scope = newScope();
    const events = eventsFor(scope, 2);
    const committed = await seedBatch(scope, events);
    const result = await readCommittedArchiveBatch(
      bucket,
      scope.tenantId,
      committed.manifestKey,
    );
    expect(result.manifest).toEqual(committed.manifest);
    const encoded = await encodeCanonicalEventBatch({
      tenantId: scope.tenantId,
      events,
    });
    expect(result.events.map((event) => event.event_id)).toEqual(
      encoded.events.map((event) => event.event_id),
    );
    expect(Object.isFrozen(result.manifest)).toBe(true);
    expect(Object.isFrozen(result.events)).toBe(true);
  });

  it("reports a missing selected manifest as archive_not_found", async () => {
    const scope = newScope();
    const committed = await seedBatch(scope);
    await bucket.delete(committed.manifestKey);
    await expectArchiveError(
      readCommittedArchiveBatch(bucket, scope.tenantId, committed.manifestKey),
      "archive_not_found",
    );
  });

  it("reports missing data and every manifest-level disagreement as archive_corrupt", async () => {
    const scope = newScope();
    const committed = await seedBatch(scope, eventsFor(scope, 2));
    const original = committed.manifest;
    const originalData = await bucket.get(original.data_key);
    expect(originalData).not.toBeNull();
    const originalCompressed = new Uint8Array(
      await originalData!.arrayBuffer(),
    );
    await bucket.delete(original.data_key);
    await expectArchiveError(
      readCommittedArchiveBatch(bucket, scope.tenantId, committed.manifestKey),
      "archive_corrupt",
    );

    const cases: Array<[string, Partial<ArchiveBatchManifest>]> = [
      ["tenant", { tenant_id: "tenant_other" }],
      ["batch", { batch_id: "batch_other" }],
      ["partition", { data_key: original.data_key.replace("/01/", "/02/") }],
      ["etag", { data_etag: "wrong-etag" }],
      ["compressed size", { compressed_bytes: original.compressed_bytes + 1 }],
      [
        "data key",
        {
          data_key: original.data_key.replace(
            "events/",
            "events/tenant_other/",
          ),
        },
      ],
      ["first id", { first_event_id: "$wrong:server" }],
      ["last timestamp", { last_observed_at: "2026-09-07T00:00:00.000Z" }],
      ["count", { event_count: 1 }],
    ];
    for (const [name, changes] of cases) {
      await bucket.put(original.data_key, originalCompressed, {
        httpMetadata: {
          contentType: "application/x-ndjson",
          contentEncoding: "gzip",
        },
        customMetadata: metadataFor(original),
      });
      await overwriteManifest(original, changes);
      const error = await getArchiveError(
        readCommittedArchiveBatch(
          bucket,
          scope.tenantId,
          committed.manifestKey,
        ),
      );
      expect(error.code, name).toBe("archive_corrupt");
      await overwriteManifest(original);
    }
  });

  it("rejects an oversized manifest before consuming its body", async () => {
    const scope = newScope();
    const committed = await seedBatch(scope);
    const real = await bucket.get(committed.manifestKey);
    expect(real).not.toBeNull();
    let bodyReads = 0;
    const oversized = new Proxy(real!, {
      get(target, property, receiver) {
        if (property === "size") return MAX_ARCHIVE_MANIFEST_BYTES + 1;
        if (property === "body") {
          bodyReads += 1;
          throw new Error("fixture oversized manifest body");
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const source = forwardingBucket(bucket, {
      get: async (key, options) =>
        key === committed.manifestKey ? oversized : bucket.get(key, options),
    });
    const error = await getArchiveError(
      readCommittedArchiveBatch(source, scope.tenantId, committed.manifestKey),
    );
    expect(error.code).toBe("archive_corrupt");
    expect(error.message).not.toContain("fixture oversized manifest body");
    expect(bodyReads).toBe(0);
  });

  it("rejects data metadata, ETag, and advertised-size mismatches before body reads", async () => {
    const scope = newScope();
    const committed = await seedBatch(scope, eventsFor(scope, 2));
    const dataObject = await bucket.get(committed.manifest.data_key);
    expect(dataObject).not.toBeNull();
    const compressed = new Uint8Array(await dataObject!.arrayBuffer());
    const original = committed.manifest;

    await bucket.put(original.data_key, compressed, {
      httpMetadata: { contentType: "text/plain", contentEncoding: "gzip" },
      customMetadata: metadataFor(original),
    });
    await expectArchiveError(
      readCommittedArchiveBatch(bucket, scope.tenantId, committed.manifestKey),
      "archive_corrupt",
    );

    const realData = await bucket.get(original.data_key);
    expect(realData).not.toBeNull();
    let bodyReads = 0;
    const oversizedData = new Proxy(realData!, {
      get(target, property, receiver) {
        if (property === "size") return 5 * 1024 * 1024 + 1;
        if (property === "body") {
          bodyReads += 1;
          throw new Error("fixture oversized data body");
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const oversizedSource = forwardingBucket(bucket, {
      get: async (key, options) =>
        key === original.data_key ? oversizedData : bucket.get(key, options),
    });
    await expectArchiveError(
      readCommittedArchiveBatch(
        oversizedSource,
        scope.tenantId,
        committed.manifestKey,
      ),
      "archive_corrupt",
    );
    expect(bodyReads).toBe(0);

    await bucket.put(original.data_key, compressed, {
      httpMetadata: {
        contentType: "application/x-ndjson",
        contentEncoding: "gzip",
      },
      customMetadata: {
        ...metadataFor(original),
        extra: "not allowed",
      },
    });
    await expectArchiveError(
      readCommittedArchiveBatch(bucket, scope.tenantId, committed.manifestKey),
      "archive_corrupt",
    );

    await bucket.put(original.data_key, compressed, {
      httpMetadata: {
        contentType: "application/x-ndjson",
        contentEncoding: "gzip",
      },
      customMetadata: {
        ...metadataFor(original),
        "canonical-sha256": "b".repeat(64),
      },
    });
    await expectArchiveError(
      readCommittedArchiveBatch(bucket, scope.tenantId, committed.manifestKey),
      "archive_corrupt",
    );

    await bucket.put(original.data_key, new Uint8Array([...compressed, 0]), {
      httpMetadata: {
        contentType: "application/x-ndjson",
        contentEncoding: "gzip",
      },
      customMetadata: metadataFor(original),
    });
    await expectArchiveError(
      readCommittedArchiveBatch(bucket, scope.tenantId, committed.manifestKey),
      "archive_corrupt",
    );

    await overwriteManifest(original, { data_etag: "wrong-etag" });
    await expectArchiveError(
      readCommittedArchiveBatch(bucket, scope.tenantId, committed.manifestKey),
      "archive_corrupt",
    );
  });

  it("rejects invalid gzip, UTF-8, JSONL, hashes, counts, ordering, duplicates, and boundaries", async () => {
    const scope = newScope();
    const events = eventsFor(scope, 2);
    const committed = await seedBatch(scope, events);
    const encoded = await encodeCanonicalEventBatch({
      tenantId: scope.tenantId,
      events,
    });
    const lines = new TextDecoder()
      .decode(encoded.canonicalJsonl)
      .trimEnd()
      .split("\n");
    const reversed = new TextEncoder().encode(
      lines.slice().reverse().join("\n") + "\n",
    );
    const duplicate = new TextEncoder().encode(
      lines[0] + "\n" + lines[0] + "\n",
    );

    await overwriteCompressedDataAndManifest(
      committed,
      new TextEncoder().encode("not gzip"),
      new TextEncoder().encode("not gzip"),
    );
    await expectArchiveError(
      readCommittedArchiveBatch(bucket, scope.tenantId, committed.manifestKey),
      "archive_corrupt",
    );

    const invalidUtf8 = new Uint8Array([0xff, 0xfe]);
    await overwriteCompressedDataAndManifest(
      committed,
      await gzipBytes(invalidUtf8),
      invalidUtf8,
    );
    await expectArchiveError(
      readCommittedArchiveBatch(bucket, scope.tenantId, committed.manifestKey),
      "archive_corrupt",
    );

    const malformedJsonl = new TextEncoder().encode("not-json\n");
    await overwriteCompressedDataAndManifest(
      committed,
      await gzipBytes(malformedJsonl),
      malformedJsonl,
    );
    await expectArchiveError(
      readCommittedArchiveBatch(bucket, scope.tenantId, committed.manifestKey),
      "archive_corrupt",
    );

    await overwriteCompressedDataAndManifest(
      committed,
      await gzipBytes(reversed),
      reversed,
    );
    await expectArchiveError(
      readCommittedArchiveBatch(bucket, scope.tenantId, committed.manifestKey),
      "archive_corrupt",
    );

    await overwriteCompressedDataAndManifest(
      committed,
      await gzipBytes(duplicate),
      duplicate,
    );
    await expectArchiveError(
      readCommittedArchiveBatch(bucket, scope.tenantId, committed.manifestKey),
      "archive_corrupt",
    );

    await overwriteDataAndManifest(committed, encoded.canonicalJsonl, {
      event_count: 1,
    });
    await expectArchiveError(
      readCommittedArchiveBatch(bucket, scope.tenantId, committed.manifestKey),
      "archive_corrupt",
    );

    await overwriteManifest(committed.manifest, {
      data_etag: "wrong-etag",
      uncompressed_bytes: MAX_ARCHIVE_MANIFEST_BYTES + 1,
    });
    await expectArchiveError(
      readCommittedArchiveBatch(bucket, scope.tenantId, committed.manifestKey),
      "archive_corrupt",
    );
  });

  it("requires strict manifest metadata, UTF-8 JSON, canonical bytes, and final newline", async () => {
    const scope = newScope();
    const committed = await seedBatch(scope);
    const original = committed.manifest;
    const key = committed.manifestKey;
    const metadata = metadataFor(original);

    await bucket.put(
      key,
      canonicalJsonLineBytes({ ...original, unexpected: true }),
      {
        httpMetadata: { contentType: "application/json" },
        customMetadata: metadata,
      },
    );
    await expectArchiveError(
      readCommittedArchiveBatch(bucket, scope.tenantId, key),
      "archive_corrupt",
    );

    await bucket.put(key, new TextEncoder().encode(JSON.stringify(original)), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: metadata,
    });
    await expectArchiveError(
      readCommittedArchiveBatch(bucket, scope.tenantId, key),
      "archive_corrupt",
    );

    await bucket.put(key, new Uint8Array([0xff, 0xfe, 0xfd]), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: metadata,
    });
    await expectArchiveError(
      readCommittedArchiveBatch(bucket, scope.tenantId, key),
      "archive_corrupt",
    );

    await bucket.put(key, canonicalJsonLineBytes(original), {
      httpMetadata: { contentType: "text/plain" },
      customMetadata: metadata,
    });
    await expectArchiveError(
      readCommittedArchiveBatch(bucket, scope.tenantId, key),
      "archive_corrupt",
    );

    await bucket.put(key, canonicalJsonLineBytes(original), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { ...metadata, extra: "unexpected" },
    });
    await expectArchiveError(
      readCommittedArchiveBatch(bucket, scope.tenantId, key),
      "archive_corrupt",
    );
  });

  it("maps unexpected body-stream failures to archive_unavailable without leaking causes", async () => {
    const scope = newScope();
    const committed = await seedBatch(scope);
    const real = await bucket.get(committed.manifest.data_key);
    expect(real).not.toBeNull();
    const throwingBody = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("fixture reader stream body");
      },
    });
    const data = new Proxy(real!, {
      get(target, property, receiver) {
        if (property === "body") return throwingBody;
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const source = forwardingBucket(bucket, {
      get: async (key, options) =>
        key === committed.manifest.data_key ? data : bucket.get(key, options),
    });
    const error = await getArchiveError(
      readCommittedArchiveBatch(source, scope.tenantId, committed.manifestKey),
    );
    expect(error.code).toBe("archive_unavailable");
    expect(error.message).not.toContain("fixture reader stream body");
  });

  it("rejects a foreign manifest key before R2 access", async () => {
    const scope = newScope();
    let gets = 0;
    const source = forwardingBucket(bucket, {
      get: async () => {
        gets += 1;
        return null;
      },
    });
    await expectArchiveError(
      readCommittedArchiveBatch(
        source,
        scope.tenantId,
        "manifests/tenant_other/2026/09/07/01/batch_x.json",
      ),
      "archive_tenant_mismatch",
    );
    expect(gets).toBe(0);
  });
});

describe("projection-only replay", () => {
  it("defaults to one manifest and returns the exact replay schema", async () => {
    const scope = newScope();
    await seedBatch(scope);
    const result = await readReplayPage(bucket, scope.tenantId);
    expect(result.schema_version).toBe(1);
    expect(result.replay_mode).toBe("projection_only");
    expect(result.tenant_id).toBe(scope.tenantId);
    expect(result.manifests).toHaveLength(1);
    expect(result.events).toHaveLength(1);
  });

  it("uses page size one by default while the list API uses 50", async () => {
    const scope = newScope();
    await seedBatch(scope);
    const calls: R2ListOptions[] = [];
    const source = forwardingBucket(bucket, {
      list: async (options) => {
        calls.push(options ?? {});
        return bucket.list(options);
      },
    });
    await readReplayPage(source, scope.tenantId);
    expect(calls[0]?.limit).toBe(1);
    calls.length = 0;
    await listCommittedManifestPage(source, scope.tenantId);
    expect(calls[0]?.limit).toBe(50);
  });

  it.each([0, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid replay page size %s",
    async (pageSize) => {
      const scope = newScope();
      await expectArchiveError(
        readReplayPage(bucket, scope.tenantId, { pageSize }),
        "archive_invalid",
      );
    },
  );

  it("replays the same archive twice with identical sequences", async () => {
    const scope = newScope();
    await seedBatch(scope, eventsFor(scope, 2));
    await seedBatch(
      scope,
      [eventFor(scope, { event_id: "$event-3:server" })],
      "batch_reader_second",
    );
    const first = await readReplayPage(bucket, scope.tenantId, {
      pageSize: 100,
    });
    const second = await readReplayPage(bucket, scope.tenantId, {
      pageSize: 100,
    });
    expect(first.manifests.map((manifest) => manifest.batch_id)).toEqual(
      second.manifests.map((manifest) => manifest.batch_id),
    );
    expect(first.events.map((event) => event.event_id)).toEqual(
      second.events.map((event) => event.event_id),
    );
  });

  it("replays an individually valid 4 MiB batch with page size one", async () => {
    const scope = newScope();
    const events = makeExactUncompressedEvents(scope, "exact-single");
    const encoded = await encodeCanonicalEventBatch({
      tenantId: scope.tenantId,
      events,
    });
    expect(encoded.uncompressedBytes).toBe(MAX_ARCHIVE_UNCOMPRESSED_BYTES);
    const committed = await seedBatch(scope, events);
    const page = await readReplayPage(bucket, scope.tenantId, { pageSize: 1 });
    expect(page.manifests).toHaveLength(1);
    expect(page.manifests[0]).toEqual(committed.manifest);
    expect(page.events).toHaveLength(4);
  });

  it("accepts exact 8 MiB and 2,000-event materialized replay boundaries", async () => {
    const scope = newScope();
    const firstEvents = makeExactUncompressedEvents(scope, "exact-first");
    const secondEvents = makeExactUncompressedEvents(scope, "exact-second");
    const firstEncoded = await encodeCanonicalEventBatch({
      tenantId: scope.tenantId,
      events: firstEvents,
    });
    const secondEncoded = await encodeCanonicalEventBatch({
      tenantId: scope.tenantId,
      events: secondEvents,
    });
    expect(firstEncoded.uncompressedBytes).toBe(MAX_ARCHIVE_UNCOMPRESSED_BYTES);
    expect(secondEncoded.uncompressedBytes).toBe(
      MAX_ARCHIVE_UNCOMPRESSED_BYTES,
    );
    await seedBatch(scope, firstEvents, "batch_exact_first");
    await seedBatch(scope, secondEvents, "batch_exact_second");
    const exactBytesPage = await readReplayPage(bucket, scope.tenantId, {
      pageSize: 2,
    });
    expect(exactBytesPage.manifests).toHaveLength(2);
    expect(
      exactBytesPage.manifests.reduce(
        (sum, manifest) => sum + manifest.uncompressed_bytes,
        0,
      ),
    ).toBe(MAX_REPLAY_PAGE_UNCOMPRESSED_BYTES);

    const eventsScope = newScope();
    for (let batch = 0; batch < 4; batch += 1) {
      const batchEvents = eventsFor(eventsScope, 500).map((event, index) => ({
        ...event,
        event_id: "$batch-" + batch + "-" + index + ":server",
      }));
      await seedBatch(eventsScope, batchEvents, "batch_exact_events_" + batch);
    }
    const exactEventsPage = await readReplayPage(bucket, eventsScope.tenantId, {
      pageSize: 4,
    });
    expect(exactEventsPage.events).toHaveLength(MAX_REPLAY_PAGE_EVENTS);
  }, 15_000);

  it("rejects one-byte and one-event aggregate overflow before data GET", async () => {
    const scope = newScope();
    const byteCommits = [] as Awaited<ReturnType<typeof seedBatch>>[];
    for (let index = 0; index < 3; index += 1) {
      byteCommits.push(
        await seedBatch(
          scope,
          [
            eventFor(scope, {
              event_id: "$byte-overflow-" + index + ":server",
            }),
          ],
          "batch_byte_overflow_" + index,
        ),
      );
    }
    const byteCounts = [2_796_202, 2_796_202, 2_796_205];
    for (let index = 0; index < byteCommits.length; index += 1) {
      await overwriteManifest(byteCommits[index]!.manifest, {
        uncompressed_bytes: byteCounts[index]!,
      });
    }
    let byteDataGets = 0;
    const byteSource = forwardingBucket(bucket, {
      get: async (key, options) => {
        if (key.startsWith("events/")) byteDataGets += 1;
        return bucket.get(key, options);
      },
    });
    await expectArchiveError(
      readReplayPage(byteSource, scope.tenantId, { pageSize: 3 }),
      "archive_too_large",
    );
    expect(byteDataGets).toBe(0);

    const eventScope = newScope();
    const eventCommits = [] as Awaited<ReturnType<typeof seedBatch>>[];
    for (let index = 0; index < 5; index += 1) {
      eventCommits.push(
        await seedBatch(
          eventScope,
          [
            eventFor(eventScope, {
              event_id: "$event-overflow-" + index + ":server",
            }),
          ],
          "batch_event_overflow_" + index,
        ),
      );
    }
    const counts = [400, 400, 400, 400, 401];
    for (let index = 0; index < eventCommits.length; index += 1) {
      await overwriteManifest(eventCommits[index]!.manifest, {
        event_count: counts[index]!,
      });
    }
    let eventDataGets = 0;
    const eventSource = forwardingBucket(bucket, {
      get: async (key, options) => {
        if (key.startsWith("events/")) eventDataGets += 1;
        return bucket.get(key, options);
      },
    });
    await expectArchiveError(
      readReplayPage(eventSource, eventScope.tenantId, { pageSize: 5 }),
      "archive_too_large",
    );
    expect(eventDataGets).toBe(0);
  });

  it("retries an aggregate-overflow cursor with a smaller page size", async () => {
    const scope = newScope();
    const firstEvents = makeExactUncompressedEvents(scope, "retry-first");
    const secondEvents = makeExactUncompressedEvents(scope, "retry-second");
    const first = await seedBatch(scope, firstEvents, "batch_retry_first");
    const second = await seedBatch(scope, secondEvents, "batch_retry_second");
    const third = await seedBatch(
      scope,
      [eventFor(scope, { event_id: "$retry-third:server" })],
      "batch_retry_third",
    );
    await overwriteManifest(third.manifest, { uncompressed_bytes: 1 });
    const initialCursor = encodeReplayCursor({
      schema_version: 1,
      tenant_id: scope.tenantId,
      manifest_prefix: "manifests/" + scope.tenantId + "/",
      r2_cursor: "retry-input",
    });
    const source = forwardingBucket(bucket, {
      list: async (options) => {
        if (options?.limit === 3) {
          return {
            objects: [
              { key: first.manifestKey },
              { key: second.manifestKey },
              { key: third.manifestKey },
            ] as R2Object[],
            delimitedPrefixes: [],
            truncated: false,
          };
        }
        return {
          objects: [{ key: first.manifestKey } as R2Object],
          delimitedPrefixes: [],
          truncated: false,
        };
      },
    });
    await expectArchiveError(
      readReplayPage(source, scope.tenantId, {
        pageSize: 3,
        cursor: initialCursor,
      }),
      "archive_too_large",
    );
    const retry = await readReplayPage(source, scope.tenantId, {
      pageSize: 1,
      cursor: initialCursor,
    });
    expect(retry.manifests).toHaveLength(1);
    expect(retry.manifests[0]!.batch_id).toBe(first.manifest.batch_id);
  });

  it("preflights aggregate bounds before fetching any data body", async () => {
    const scope = newScope();
    const commits = [] as Awaited<ReturnType<typeof seedBatch>>[];
    for (let index = 0; index < 3; index += 1) {
      commits.push(
        await seedBatch(
          scope,
          [eventFor(scope, { event_id: "$overflow-" + index + ":server" })],
          "batch_overflow_" + index,
        ),
      );
    }
    for (const committed of commits) {
      await overwriteManifest(committed.manifest, {
        uncompressed_bytes: 3_000_000,
      });
    }
    let dataGets = 0;
    const source = forwardingBucket(bucket, {
      get: async (key, options) => {
        if (key.startsWith("events/")) dataGets += 1;
        return bucket.get(key, options);
      },
    });
    const error = await getArchiveError(
      readReplayPage(source, scope.tenantId, { pageSize: 3 }),
    );
    expect(error.code).toBe("archive_too_large");
    expect(dataGets).toBe(0);
  });

  it("rejects underreported decoded bytes after reading the data body", async () => {
    const scope = newScope();
    const committed = await seedBatch(scope, eventsFor(scope, 2));
    const underreported = Math.max(
      1,
      committed.manifest.uncompressed_bytes - 1,
    );
    await overwriteManifest(committed.manifest, {
      uncompressed_bytes: underreported,
    });
    await expectArchiveError(
      readReplayPage(bucket, scope.tenantId),
      "archive_corrupt",
    );
  });

  it("performs list/get reads only and never writes, deletes, or invokes actions", async () => {
    const scope = newScope();
    await seedBatch(scope);
    const calls: string[] = [];
    const source = new Proxy(bucket, {
      get(target, property, receiver) {
        if (
          property === "put" ||
          property === "delete" ||
          property === "createMultipartUpload"
        ) {
          return () => {
            calls.push(String(property));
            throw new Error("replay must remain read-only");
          };
        }
        if (property === "list" || property === "get" || property === "head") {
          const value = Reflect.get(target, property, target);
          return (...args: unknown[]) => {
            calls.push(String(property));
            return (value as (...inner: unknown[]) => unknown).apply(
              target,
              args,
            );
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    await readReplayPage(source, scope.tenantId);
    expect(
      calls.filter((call) =>
        ["put", "delete", "createMultipartUpload"].includes(call),
      ),
    ).toEqual([]);
    expect(
      calls.filter((call) => ["list", "get", "head"].includes(call)).length,
    ).toBeGreaterThan(0);
  });

  it("keeps replay errors generic and does not expose stored bodies", async () => {
    const scope = newScope();
    const source = forwardingBucket(bucket, {
      list: async () => {
        throw new Error(
          "" + "fixture reader message body that must stay private",
        );
      },
    });
    const error = await getArchiveError(readReplayPage(source, scope.tenantId));
    expect(error.code).toBe("archive_unavailable");
    expect(error.message).not.toContain("fixture reader message body");
  });
});
