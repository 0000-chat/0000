import { z } from "zod";
import {
  ArchiveBatchManifestSchema,
  CanonicalResourceIdSchema,
  MAX_ARCHIVE_COMPRESSED_BYTES,
  MAX_ARCHIVE_MANIFEST_BYTES,
  MAX_ARCHIVE_ETAG_CHARS,
  MAX_PRODUCER_VERSION_CHARS,
  TimestampSchema,
  type ArchiveBatchManifest,
} from "@communicator/contracts";
import { bytesEqual, canonicalJsonLineBytes } from "./canonical-json";
import {
  decodeCanonicalJsonl,
  encodeCanonicalEventBatch,
  gunzipBytes,
  sha256Hex,
  type EncodedCanonicalEventBatch,
} from "./codec";
import { ArchiveError, archiveError } from "./errors";
import { deriveArchiveKeys } from "./keys";

export { ArchiveError } from "./errors";

export type ArchiveSourceCheckpoint = {
  kind: string;
  value: string;
};

export type ArchiveCanonicalEventBatchInput = {
  bucket: R2Bucket;
  tenantId: string;
  batchId: string;
  events: readonly unknown[];
  archivedAt: string;
  producerVersion: string;
  sourceCheckpoint: ArchiveSourceCheckpoint | null;
};

export type ArchiveCanonicalEventBatchResult = {
  status: "created" | "already_committed";
  manifestKey: string;
  manifest: ArchiveBatchManifest;
};

const DATA_CONTENT_TYPE = "application/x-ndjson";
const MANIFEST_CONTENT_TYPE = "application/json";
const GZIP_CONTENT_ENCODING = "gzip";
const DATA_SCHEMA_VERSION = "1";

const ProducerVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PRODUCER_VERSION_CHARS);

type VerifiedData = {
  object: R2ObjectBody;
  decoded: Uint8Array;
};

const isR2BucketLike = (value: unknown): value is R2Bucket => {
  try {
    return (
      value !== null &&
      typeof value === "object" &&
      typeof (value as { put?: unknown }).put === "function" &&
      typeof (value as { get?: unknown }).get === "function"
    );
  } catch {
    return false;
  }
};

const parseManifest = (
  value: unknown,
  failureCode: "archive_invalid" | "archive_conflict" = "archive_invalid",
): ArchiveBatchManifest => {
  try {
    const result = ArchiveBatchManifestSchema.safeParse(value);
    if (!result.success) throw archiveError(failureCode, result.error);
    return result.data;
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError(failureCode, error);
  }
};

const manifestLineBytes = (manifest: ArchiveBatchManifest): Uint8Array => {
  let bytes: Uint8Array;
  try {
    bytes = canonicalJsonLineBytes(manifest);
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_invalid", error);
  }
  if (bytes.byteLength > MAX_ARCHIVE_MANIFEST_BYTES) {
    throw archiveError("archive_too_large");
  }
  return bytes;
};

const customMetadataFor = (
  tenantId: string,
  batchId: string,
  canonicalSha256: string,
): Record<string, string> => ({
  "schema-version": DATA_SCHEMA_VERSION,
  "tenant-id": tenantId,
  "batch-id": batchId,
  "canonical-sha256": canonicalSha256,
});

const metadataKeysEqual = (
  actual: Record<string, string> | undefined,
  expected: Record<string, string>,
): boolean => {
  try {
    if (actual === undefined || actual === null || typeof actual !== "object") {
      return false;
    }
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    if (
      !bytesEqual(
        new TextEncoder().encode(actualKeys.join("\u0000")),
        new TextEncoder().encode(expectedKeys.join("\u0000")),
      )
    ) {
      return false;
    }
    return expectedKeys.every((key) => actual[key] === expected[key]);
  } catch {
    return false;
  }
};

const dataMetadataMatches = (
  object: R2Object,
  tenantId: string,
  batchId: string,
  canonicalSha256: string,
): boolean => {
  try {
    return (
      object.httpMetadata?.contentType === DATA_CONTENT_TYPE &&
      object.httpMetadata?.contentEncoding === GZIP_CONTENT_ENCODING &&
      metadataKeysEqual(
        object.customMetadata,
        customMetadataFor(tenantId, batchId, canonicalSha256),
      )
    );
  } catch {
    return false;
  }
};

const manifestMetadataMatches = (
  object: R2Object,
  tenantId: string,
  batchId: string,
  canonicalSha256: string,
): boolean => {
  try {
    return (
      object.httpMetadata?.contentType === MANIFEST_CONTENT_TYPE &&
      metadataKeysEqual(
        object.customMetadata,
        customMetadataFor(tenantId, batchId, canonicalSha256),
      )
    );
  } catch {
    return false;
  }
};

const validDataEtag = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.trim().length <= MAX_ARCHIVE_ETAG_CHARS;

const readR2 = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_unavailable", error);
  }
};

const readObjectBytes = async (object: R2ObjectBody): Promise<Uint8Array> => {
  try {
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== object.size)
      throw archiveError("archive_conflict");
    return bytes;
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_unavailable", error);
  }
};

const verifyDataObject = async (
  bucket: R2Bucket,
  dataKey: string,
  tenantId: string,
  batchId: string,
  encoded: EncodedCanonicalEventBatch,
): Promise<VerifiedData> => {
  const object = await readR2(() => bucket.get(dataKey));
  if (object === null) throw archiveError("archive_conflict");

  try {
    if (
      object.key !== dataKey ||
      !Number.isSafeInteger(object.size) ||
      object.size < 1 ||
      object.size > MAX_ARCHIVE_COMPRESSED_BYTES ||
      !validDataEtag(object.etag) ||
      !dataMetadataMatches(object, tenantId, batchId, encoded.canonicalSha256)
    ) {
      throw archiveError("archive_conflict");
    }
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_conflict", error);
  }

  const bytes = await readObjectBytes(object);
  let decoded: Uint8Array;
  try {
    decoded = await gunzipBytes(bytes);
    await decodeCanonicalJsonl(decoded, {
      tenantId,
      expectedEventCount: encoded.events.length,
    });
    if (decoded.byteLength !== encoded.canonicalJsonl.byteLength) {
      throw archiveError("archive_conflict");
    }
    if (!bytesEqual(decoded, encoded.canonicalJsonl)) {
      throw archiveError("archive_conflict");
    }
    if ((await sha256Hex(decoded)) !== encoded.canonicalSha256) {
      throw archiveError("archive_conflict");
    }
  } catch (error) {
    if (error instanceof ArchiveError && error.code === "archive_unavailable") {
      throw error;
    }
    throw archiveError("archive_conflict", error);
  }

  return { object, decoded };
};

const buildManifest = (
  tenantId: string,
  batchId: string,
  dataKey: string,
  encoded: EncodedCanonicalEventBatch,
  dataObject: R2Object,
  archivedAt: string,
  producerVersion: string,
  sourceCheckpoint: ArchiveBatchManifest["source_checkpoint"],
): ArchiveBatchManifest => {
  const firstEvent = encoded.events[0];
  const lastEvent = encoded.events.at(-1);
  if (!firstEvent || !lastEvent || !validDataEtag(dataObject.etag)) {
    throw archiveError("archive_conflict");
  }
  const candidate = {
    schema_version: 1 as const,
    tenant_id: tenantId,
    batch_id: batchId,
    data_key: dataKey,
    compression: "gzip" as const,
    content_type: DATA_CONTENT_TYPE,
    event_count: encoded.events.length,
    uncompressed_bytes: encoded.uncompressedBytes,
    compressed_bytes: dataObject.size,
    canonical_sha256: encoded.canonicalSha256,
    data_etag: dataObject.etag.trim(),
    first_event_id: firstEvent.event_id,
    last_event_id: lastEvent.event_id,
    first_observed_at: firstEvent.observed_at,
    last_observed_at: lastEvent.observed_at,
    archived_at: archivedAt,
    producer: {
      service: "communicator-control-plane" as const,
      version: producerVersion,
    },
    source_checkpoint: sourceCheckpoint,
  };
  const manifest = parseManifest(candidate, "archive_invalid");
  manifestLineBytes(manifest);
  return manifest;
};

const buildManifestPreview = (
  tenantId: string,
  batchId: string,
  dataKey: string,
  encoded: EncodedCanonicalEventBatch,
  archivedAt: string,
  producerVersion: string,
  sourceCheckpoint: unknown,
): ArchiveBatchManifest => {
  const firstEvent = encoded.events[0];
  const lastEvent = encoded.events.at(-1);
  if (!firstEvent || !lastEvent) throw archiveError("archive_invalid");
  const candidate = {
    schema_version: 1 as const,
    tenant_id: tenantId,
    batch_id: batchId,
    data_key: dataKey,
    compression: "gzip" as const,
    content_type: DATA_CONTENT_TYPE,
    event_count: encoded.events.length,
    uncompressed_bytes: encoded.uncompressedBytes,
    compressed_bytes: encoded.compressedBytes,
    canonical_sha256: encoded.canonicalSha256,
    // Reserve the largest JSON representation allowed by the ETag bound so
    // the manifest-size check happens before the first (data) write.
    data_etag: "\u0000".repeat(MAX_ARCHIVE_ETAG_CHARS),
    first_event_id: firstEvent.event_id,
    last_event_id: lastEvent.event_id,
    first_observed_at: firstEvent.observed_at,
    last_observed_at: lastEvent.observed_at,
    archived_at: archivedAt,
    producer: {
      service: "communicator-control-plane" as const,
      version: producerVersion,
    },
    source_checkpoint: sourceCheckpoint,
  };
  const manifest = parseManifest(candidate, "archive_invalid");
  manifestLineBytes(manifest);
  return manifest;
};

const parseStoredManifest = async (
  object: R2ObjectBody,
  manifestKey: string,
  tenantId: string,
  batchId: string,
  canonicalSha256: string,
): Promise<{ manifest: ArchiveBatchManifest; body: Uint8Array }> => {
  try {
    if (
      object.key !== manifestKey ||
      !Number.isSafeInteger(object.size) ||
      object.size < 1 ||
      object.size > MAX_ARCHIVE_MANIFEST_BYTES ||
      !manifestMetadataMatches(object, tenantId, batchId, canonicalSha256)
    ) {
      throw archiveError("archive_conflict");
    }
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_conflict", error);
  }

  const body = await readObjectBytes(object);
  if (body.byteLength > MAX_ARCHIVE_MANIFEST_BYTES) {
    throw archiveError("archive_conflict");
  }

  let decoded: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    decoded = JSON.parse(text) as unknown;
  } catch (error) {
    throw archiveError("archive_conflict", error);
  }
  const manifest = parseManifest(decoded, "archive_conflict");
  const canonical = manifestLineBytes(manifest);
  if (!bytesEqual(body, canonical)) throw archiveError("archive_conflict");
  return { manifest, body };
};

const readAndValidateCommitted = async (
  bucket: R2Bucket,
  manifestKey: string,
  expectedManifest: ArchiveBatchManifest,
  expectedManifestBytes: Uint8Array,
  encoded: EncodedCanonicalEventBatch,
  missingCode: "archive_conflict" | "archive_unavailable",
): Promise<ArchiveBatchManifest> => {
  const object = await readR2(() => bucket.get(manifestKey));
  if (object === null) throw archiveError(missingCode);
  const stored = await parseStoredManifest(
    object,
    manifestKey,
    expectedManifest.tenant_id,
    expectedManifest.batch_id,
    expectedManifest.canonical_sha256,
  );
  if (!bytesEqual(stored.body, expectedManifestBytes)) {
    throw archiveError("archive_conflict");
  }
  if (JSON.stringify(stored.manifest) !== JSON.stringify(expectedManifest)) {
    throw archiveError("archive_conflict");
  }
  const data = await verifyDataObject(
    bucket,
    expectedManifest.data_key,
    expectedManifest.tenant_id,
    expectedManifest.batch_id,
    encoded,
  );
  if (
    data.object.etag.trim() !== stored.manifest.data_etag ||
    data.object.size !== stored.manifest.compressed_bytes
  ) {
    throw archiveError("archive_conflict");
  }
  return stored.manifest;
};

const validateInputAndPreview = async (
  input: ArchiveCanonicalEventBatchInput,
): Promise<{
  bucket: R2Bucket;
  tenantId: string;
  batchId: string;
  encoded: EncodedCanonicalEventBatch;
  archivedAt: string;
  producerVersion: string;
  sourceCheckpoint: ArchiveBatchManifest["source_checkpoint"];
  dataKey: string;
  manifestKey: string;
}> => {
  if (!isR2BucketLike(input.bucket)) throw archiveError("archive_invalid");
  if (!CanonicalResourceIdSchema.safeParse(input.tenantId).success) {
    throw archiveError("archive_invalid");
  }
  if (
    !CanonicalResourceIdSchema.safeParse(input.batchId).success ||
    !input.batchId.startsWith("batch_")
  ) {
    throw archiveError("archive_invalid");
  }
  const archivedResult = TimestampSchema.max(64).safeParse(input.archivedAt);
  if (!archivedResult.success) throw archiveError("archive_invalid");
  const producerResult = ProducerVersionSchema.safeParse(input.producerVersion);
  if (!producerResult.success) throw archiveError("archive_invalid");

  const encoded = await encodeCanonicalEventBatch({
    tenantId: input.tenantId,
    events: input.events,
  });
  const firstEvent = encoded.events[0];
  if (!firstEvent) throw archiveError("archive_invalid");
  const keys = deriveArchiveKeys(
    input.tenantId,
    input.batchId,
    firstEvent.observed_at,
  );
  const preview = buildManifestPreview(
    input.tenantId,
    input.batchId,
    keys.dataKey,
    encoded,
    archivedResult.data,
    producerResult.data,
    input.sourceCheckpoint,
  );
  return {
    bucket: input.bucket,
    tenantId: input.tenantId,
    batchId: input.batchId,
    encoded,
    archivedAt: preview.archived_at,
    producerVersion: preview.producer.version,
    sourceCheckpoint: preview.source_checkpoint,
    dataKey: keys.dataKey,
    manifestKey: keys.manifestKey,
  };
};

export const archiveCanonicalEventBatch = async (
  input: ArchiveCanonicalEventBatchInput,
): Promise<ArchiveCanonicalEventBatchResult> => {
  let validated: Awaited<ReturnType<typeof validateInputAndPreview>>;
  try {
    if (input === null || typeof input !== "object") {
      throw archiveError("archive_invalid");
    }
    validated = await validateInputAndPreview(input);
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_invalid", error);
  }

  const {
    bucket,
    tenantId,
    batchId,
    encoded,
    archivedAt,
    producerVersion,
    sourceCheckpoint,
    dataKey,
    manifestKey,
  } = validated;
  const dataPutOptions: R2PutOptions = {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: {
      contentType: DATA_CONTENT_TYPE,
      contentEncoding: GZIP_CONTENT_ENCODING,
    },
    customMetadata: customMetadataFor(
      tenantId,
      batchId,
      encoded.canonicalSha256,
    ),
  };

  let dataPut: R2Object | null;
  try {
    dataPut = await bucket.put(
      dataKey,
      encoded.compressed.slice(),
      dataPutOptions,
    );
  } catch (error) {
    throw archiveError("archive_unavailable", error);
  }

  // A successful put and a failed conditional put are both followed by a
  // bounded content read. This makes the actual object, ETag, and size the
  // source of truth for the manifest and permits gzip implementations to
  // differ across Workers runtimes.
  const verifiedData = await verifyDataObject(
    bucket,
    dataKey,
    tenantId,
    batchId,
    encoded,
  );
  if (dataPut !== null && dataPut !== undefined) {
    try {
      if (dataPut.key !== dataKey || !validDataEtag(dataPut.etag)) {
        throw archiveError("archive_unavailable");
      }
    } catch (error) {
      if (error instanceof ArchiveError) throw error;
      throw archiveError("archive_unavailable", error);
    }
  }

  const manifest = buildManifest(
    tenantId,
    batchId,
    dataKey,
    encoded,
    verifiedData.object,
    archivedAt,
    producerVersion,
    sourceCheckpoint,
  );
  const manifestBytes = manifestLineBytes(manifest);
  const manifestPutOptions: R2PutOptions = {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: MANIFEST_CONTENT_TYPE },
    customMetadata: customMetadataFor(
      tenantId,
      batchId,
      manifest.canonical_sha256,
    ),
  };

  let manifestPut: R2Object | null;
  try {
    manifestPut = await bucket.put(
      manifestKey,
      manifestBytes.slice(),
      manifestPutOptions,
    );
  } catch (error) {
    throw archiveError("archive_unavailable", error);
  }

  if (manifestPut === null) {
    const committed = await readAndValidateCommitted(
      bucket,
      manifestKey,
      manifest,
      manifestBytes,
      encoded,
      "archive_conflict",
    );
    return {
      status: "already_committed",
      manifestKey,
      manifest: committed,
    };
  }

  const committed = await readAndValidateCommitted(
    bucket,
    manifestKey,
    manifest,
    manifestBytes,
    encoded,
    "archive_unavailable",
  );
  return {
    status: "created",
    manifestKey,
    manifest: committed,
  };
};
