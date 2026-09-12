import {
  ArchiveBatchManifestSchema,
  ArchiveReplayCursorPayloadSchema,
  ArchiveReplayPageSchema,
  CanonicalResourceIdSchema,
  MAX_ARCHIVE_COMPRESSED_BYTES,
  MAX_ARCHIVE_ETAG_CHARS,
  MAX_ARCHIVE_MANIFEST_BYTES,
  MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  MAX_MANIFEST_PAGE_SIZE,
  MAX_REPLAY_CURSOR_CHARS,
  MAX_REPLAY_PAGE_EVENTS,
  MAX_REPLAY_PAGE_UNCOMPRESSED_BYTES,
  MAX_R2_CURSOR_CHARS,
  type ArchiveBatchManifest,
  type ArchiveReplayPage,
  type CanonicalEventEnvelope,
} from "@communicator/contracts";
import {
  bytesEqual,
  canonicalJsonStringify,
  canonicalJsonLineBytes,
} from "./canonical-json";
import {
  decodeCanonicalJsonl,
  gunzipBytes,
  sha256Hex,
} from "./codec";
import { ArchiveError, archiveError } from "./errors";
import {
  deriveArchiveKeys,
  deriveManifestPrefix,
  isArchiveKeyForTenant,
  parseArchiveKey,
} from "./keys";

const DATA_CONTENT_TYPE = "application/x-ndjson";
const DATA_CONTENT_ENCODING = "gzip";
const MANIFEST_CONTENT_TYPE = "application/json";
const METADATA_KEYS = [
  "schema-version",
  "tenant-id",
  "batch-id",
  "canonical-sha256",
] as const;
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

type PageOptions = {
  cursor?: string;
  pageSize?: number;
};

type ManifestPageItem = {
  key: string;
  manifest: ArchiveBatchManifest;
};

type ManifestPage = {
  items: ManifestPageItem[];
  next_cursor: string | null;
};

type CommittedBatch = {
  manifest: ArchiveBatchManifest;
  events: CanonicalEventEnvelope[];
  decodedBytes: number;
};

const isR2BucketLike = (value: unknown): value is R2Bucket => {
  try {
    return (
      value !== null &&
      typeof value === "object" &&
      typeof (value as { get?: unknown }).get === "function" &&
      typeof (value as { list?: unknown }).list === "function"
    );
  } catch {
    return false;
  }
};

function assertTenantId(tenantId: unknown): asserts tenantId is string {
  if (!CanonicalResourceIdSchema.safeParse(tenantId).success) {
    throw archiveError("archive_invalid");
  }
}

function assertBucket(bucket: unknown): asserts bucket is R2Bucket {
  if (!isR2BucketLike(bucket)) throw archiveError("archive_invalid");
}

const isPlainInputObject = (value: unknown): value is object => {
  try {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null)
    );
  } catch {
    return false;
  }
};

const parsePageOptions = (
  input: unknown,
  defaultPageSize: number,
): { cursor?: string; pageSize: number } => {
  if (input === undefined) return { pageSize: defaultPageSize };
  if (!isPlainInputObject(input)) throw archiveError("archive_invalid");

  let cursor: string | undefined;
  let pageSize = defaultPageSize;
  try {
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string" || (key !== "cursor" && key !== "pageSize")) {
        throw archiveError("archive_invalid");
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw archiveError("archive_invalid");
      }
      if (key === "cursor") {
        if (descriptor.value !== undefined) {
          if (typeof descriptor.value !== "string") {
            throw archiveError("archive_invalid");
          }
          cursor = descriptor.value;
        }
      } else if (descriptor.value !== undefined) {
        pageSize = descriptor.value as number;
      }
    }
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_invalid", error);
  }

  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > MAX_MANIFEST_PAGE_SIZE
  ) {
    throw archiveError("archive_invalid");
  }
  if (cursor !== undefined && cursor.length === 0) {
    throw archiveError("archive_invalid");
  }
  return cursor === undefined ? { pageSize } : { pageSize, cursor };
};

const encodeBase64Url = (bytes: Uint8Array): string => {
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = hasSecond ? bytes[index + 1] ?? 0 : 0;
    const third = hasThird ? bytes[index + 2] ?? 0 : 0;
    result += BASE64URL_ALPHABET[first >> 2];
    result += BASE64URL_ALPHABET[((first & 0x03) << 4) | (second >> 4)];
    if (hasSecond) {
      result += BASE64URL_ALPHABET[((second & 0x0f) << 2) | (third >> 6)];
    }
    if (hasThird) result += BASE64URL_ALPHABET[third & 0x3f];
  }
  return result;
};

const decodeBase64Url = (value: string): Uint8Array => {
  if (
    value.length === 0 ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw archiveError("archive_invalid");
  }
  const output: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of value) {
    const digit = BASE64URL_ALPHABET.indexOf(character);
    if (digit < 0) throw archiveError("archive_invalid");
    buffer = (buffer << 6) | digit;
    bits += 6;
    while (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 0xff);
      if (bits === 0) buffer = 0;
      else buffer &= (1 << bits) - 1;
    }
  }
  if (bits > 0 && buffer !== 0) throw archiveError("archive_invalid");
  return new Uint8Array(output);
};

const canonicalCursorBytes = (payload: unknown): Uint8Array => {
  const parsed = ArchiveReplayCursorPayloadSchema.safeParse(payload);
  if (!parsed.success) throw archiveError("archive_invalid", parsed.error);
  try {
    return new TextEncoder().encode(canonicalJsonStringify(parsed.data));
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_invalid", error);
  }
};

export const encodeReplayCursor = (payload: unknown): string => {
  const bytes = canonicalCursorBytes(payload);
  const encoded = encodeBase64Url(bytes);
  if (encoded.length > MAX_REPLAY_CURSOR_CHARS) {
    throw archiveError("archive_too_large");
  }
  return encoded;
};

export const decodeReplayCursor = (
  cursor: unknown,
  expectedTenantId: unknown,
  expectedPrefix: unknown,
): {
  schema_version: 1;
  tenant_id: string;
  manifest_prefix: string;
  r2_cursor: string;
} => {
  assertTenantId(expectedTenantId);
  const internalPrefix = deriveManifestPrefix(expectedTenantId);
  if (typeof expectedPrefix !== "string" || expectedPrefix !== internalPrefix) {
    throw archiveError("archive_invalid");
  }
  if (typeof cursor !== "string" || cursor.length === 0) {
    throw archiveError("archive_invalid");
  }
  if (cursor.length > MAX_REPLAY_CURSOR_CHARS) {
    throw archiveError("archive_too_large");
  }

  const bytes = decodeBase64Url(cursor);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw archiveError("archive_invalid", error);
  }
  const parsed = ArchiveReplayCursorPayloadSchema.safeParse(parsedJson);
  if (!parsed.success) throw archiveError("archive_invalid", parsed.error);
  if (parsed.data.tenant_id !== expectedTenantId) {
    throw archiveError("archive_tenant_mismatch");
  }
  if (parsed.data.manifest_prefix !== internalPrefix) {
    throw archiveError("archive_invalid");
  }
  if (parsed.data.r2_cursor.length > MAX_R2_CURSOR_CHARS) {
    throw archiveError("archive_too_large");
  }

  let canonical: string;
  try {
    canonical = encodeReplayCursor(parsed.data);
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_invalid", error);
  }
  if (canonical !== cursor) throw archiveError("archive_invalid");
  return parsed.data;
};

const exactMetadata = (
  actual: Record<string, string> | undefined,
  expected: Record<string, string>,
): boolean => {
  try {
    if (actual === undefined || actual === null || typeof actual !== "object") {
      return false;
    }
    const keys = Reflect.ownKeys(actual);
    if (
      keys.length !== METADATA_KEYS.length ||
      keys.some((key) => typeof key !== "string")
    ) {
      return false;
    }
    for (const key of METADATA_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(actual, key);
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        descriptor.value !== expected[key]
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
};

const metadataShape = (
  actual: Record<string, string> | undefined,
  tenantId: string,
  batchId: string,
): boolean => {
  try {
    if (actual === undefined || actual === null || typeof actual !== "object") {
      return false;
    }
    const keys = Reflect.ownKeys(actual);
    if (
      keys.length !== METADATA_KEYS.length ||
      keys.some((key) => typeof key !== "string")
    ) {
      return false;
    }
    const values: Record<string, unknown> = {};
    for (const key of METADATA_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(actual, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        return false;
      }
      values[key] = descriptor.value;
    }
    return (
      values["schema-version"] === "1" &&
      values["tenant-id"] === tenantId &&
      values["batch-id"] === batchId &&
      typeof values["canonical-sha256"] === "string" &&
      /^[0-9a-f]{64}$/.test(values["canonical-sha256"])
    );
  } catch {
    return false;
  }
};

const manifestMetadata = (
  tenantId: string,
  batchId: string,
  canonicalSha256: string,
): Record<string, string> => ({
  "schema-version": "1",
  "tenant-id": tenantId,
  "batch-id": batchId,
  "canonical-sha256": canonicalSha256,
});

const dataMetadata = manifestMetadata;

const readR2 = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_unavailable", error);
  }
};

const concatBytes = (chunks: readonly Uint8Array[], total: number): Uint8Array => {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const normalizeReadableStream = (body: unknown): ReadableStream<Uint8Array> => {
  if (body === null || typeof body !== "object") {
    throw archiveError("archive_corrupt");
  }
  let source: ReadableStream<unknown>;
  try {
    if (typeof (body as { getReader?: unknown }).getReader !== "function") {
      throw archiveError("archive_corrupt");
    }
    source = body as ReadableStream<unknown>;
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_unavailable", error);
  }

  let reader: ReadableStreamDefaultReader<unknown> | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      try {
        reader = source.getReader();
      } catch (error) {
        controller.error(archiveError("archive_unavailable", error));
      }
    },
    async pull(controller) {
      if (reader === undefined) {
        controller.error(archiveError("archive_unavailable"));
        return;
      }
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          return;
        }
        if (!(result.value instanceof Uint8Array)) {
          controller.error(archiveError("archive_corrupt"));
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        controller.error(
          error instanceof ArchiveError
            ? error
            : archiveError("archive_unavailable", error),
        );
      }
    },
    async cancel(reason) {
      try {
        await reader?.cancel(reason);
      } catch {
        // Preserve the original stream failure.
      }
    },
  });
};

const readBodyBounded = async (
  body: unknown,
  maxBytes: number,
): Promise<Uint8Array> => {
  const normalized = normalizeReadableStream(body);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    reader = normalized.getReader();
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        throw archiveError("archive_corrupt");
      }
      total += result.value.byteLength;
      if (total > maxBytes) throw archiveError("archive_corrupt");
      chunks.push(result.value);
    }
  } catch (error) {
    try {
      await reader?.cancel();
    } catch {
      // Preserve the original bounded-read failure.
    }
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_unavailable", error);
  } finally {
    reader?.releaseLock();
  }
  return concatBytes(chunks, total);
};

const parseManifestBody = (
  bytes: Uint8Array,
): ArchiveBatchManifest => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw archiveError("archive_corrupt", error);
  }
  const parsed = ArchiveBatchManifestSchema.safeParse(decoded);
  if (!parsed.success) throw archiveError("archive_corrupt", parsed.error);
  let canonical: Uint8Array;
  try {
    canonical = canonicalJsonLineBytes(parsed.data);
  } catch (error) {
    throw archiveError("archive_corrupt", error);
  }
  if (!bytesEqual(bytes, canonical)) throw archiveError("archive_corrupt");
  return parsed.data;
};

const validateManifestKeyInput = (
  tenantId: string,
  manifestKey: unknown,
): NonNullable<ReturnType<typeof parseArchiveKey>> => {
  if (typeof manifestKey !== "string") throw archiveError("archive_invalid");
  const parts = parseArchiveKey(manifestKey);
  if (parts === null || parts.kind !== "manifest") {
    throw archiveError("archive_invalid");
  }
  if (parts.tenantId !== tenantId) {
    throw archiveError("archive_tenant_mismatch");
  }
  return parts;
};

const validateManifestObjectMetadata = (
  object: R2ObjectBody,
  manifestKey: string,
  tenantId: string,
  batchId: string,
): void => {
  try {
    if (
      object.key !== manifestKey ||
      !Number.isSafeInteger(object.size) ||
      object.size < 1 ||
      object.size > MAX_ARCHIVE_MANIFEST_BYTES ||
      object.httpMetadata?.contentType !== MANIFEST_CONTENT_TYPE ||
      object.httpMetadata?.contentEncoding !== undefined ||
      !metadataShape(object.customMetadata, tenantId, batchId)
    ) {
      throw archiveError("archive_corrupt");
    }
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_corrupt", error);
  }
};

const readManifestOnly = async (
  bucket: R2Bucket,
  tenantId: string,
  manifestKey: string,
  missingCode: "archive_not_found" | "archive_corrupt",
): Promise<ArchiveBatchManifest> => {
  const parts = validateManifestKeyInput(tenantId, manifestKey);
  const object = await readR2(() => bucket.get(manifestKey));
  if (object === null) throw archiveError(missingCode);

  validateManifestObjectMetadata(object, manifestKey, tenantId, parts.batchId);
  // The size check above intentionally precedes the body getter. This keeps
  // oversized manifest objects from consuming their body stream.
  let bytes: Uint8Array;
  try {
    bytes = await readBodyBounded(object.body, MAX_ARCHIVE_MANIFEST_BYTES);
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_unavailable", error);
  }
  if (bytes.byteLength !== object.size) throw archiveError("archive_corrupt");
  const manifest = parseManifestBody(bytes);
  if (
    manifest.tenant_id !== tenantId ||
    manifest.batch_id !== parts.batchId ||
    !exactMetadata(
      object.customMetadata,
      manifestMetadata(tenantId, parts.batchId, manifest.canonical_sha256),
    )
  ) {
    throw archiveError("archive_corrupt");
  }

  let expectedKeys: ReturnType<typeof deriveArchiveKeys>;
  try {
    expectedKeys = deriveArchiveKeys(
      tenantId,
      manifest.batch_id,
      manifest.first_observed_at,
    );
  } catch (error) {
    if (error instanceof ArchiveError) {
      throw archiveError("archive_corrupt", error);
    }
    throw archiveError("archive_corrupt", error);
  }
  if (
    expectedKeys.manifestKey !== manifestKey ||
    expectedKeys.dataKey !== manifest.data_key
  ) {
    throw archiveError("archive_corrupt");
  }
  return manifest;
};

const boundedCompressedInput = (
  body: ReadableStream<Uint8Array>,
  advertisedBytes: number,
): { stream: ReadableStream<Uint8Array>; getObservedBytes: () => number } => {
  let observedBytes = 0;
  const stream = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!(chunk instanceof Uint8Array)) {
          controller.error(archiveError("archive_corrupt"));
          return;
        }
        observedBytes += chunk.byteLength;
        if (observedBytes > advertisedBytes) {
          controller.error(archiveError("archive_corrupt"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return { stream, getObservedBytes: () => observedBytes };
};

const readDataForManifest = async (
  bucket: R2Bucket,
  tenantId: string,
  manifest: ArchiveBatchManifest,
  maxDecodedBytes: number,
): Promise<CommittedBatch> => {
  if (
    !Number.isSafeInteger(maxDecodedBytes) ||
    maxDecodedBytes < 1 ||
    maxDecodedBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES
  ) {
    throw archiveError("archive_too_large");
  }
  if (!isArchiveKeyForTenant(manifest.data_key, tenantId, "data")) {
    throw archiveError("archive_corrupt");
  }
  const object = await readR2(() => bucket.get(manifest.data_key));
  if (object === null) throw archiveError("archive_corrupt");

  try {
    if (
      object.key !== manifest.data_key ||
      !Number.isSafeInteger(object.size) ||
      object.size < 1 ||
      object.size > MAX_ARCHIVE_COMPRESSED_BYTES ||
      object.size !== manifest.compressed_bytes ||
      typeof object.etag !== "string" ||
      object.etag.length < 1 ||
      object.etag.length > MAX_ARCHIVE_ETAG_CHARS ||
      object.etag !== manifest.data_etag ||
      object.httpMetadata?.contentType !== DATA_CONTENT_TYPE ||
      object.httpMetadata?.contentEncoding !== DATA_CONTENT_ENCODING ||
      !exactMetadata(
        object.customMetadata,
        dataMetadata(tenantId, manifest.batch_id, manifest.canonical_sha256),
      )
    ) {
      throw archiveError("archive_corrupt");
    }
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_corrupt", error);
  }

  let body: ReadableStream<Uint8Array>;
  try {
    body = object.body;
  } catch (error) {
    throw archiveError("archive_unavailable", error);
  }

  let decoded: Uint8Array;
  let observedCompressedBytes: number;
  try {
    const bounded = boundedCompressedInput(
      normalizeReadableStream(body),
      object.size,
    );
    decoded = await gunzipBytes(
      bounded.stream,
      Math.min(maxDecodedBytes, MAX_ARCHIVE_UNCOMPRESSED_BYTES),
      MAX_ARCHIVE_COMPRESSED_BYTES,
    );
    observedCompressedBytes = bounded.getObservedBytes();
  } catch (error) {
    if (error instanceof ArchiveError && error.code === "archive_unavailable") {
      throw error;
    }
    // A bounded decompression overflow or malformed gzip is corruption of the
    // committed pair, including underreported manifest metadata.
    throw archiveError("archive_corrupt", error);
  }
  if (
    observedCompressedBytes !== object.size ||
    decoded.byteLength !== manifest.uncompressed_bytes
  ) {
    throw archiveError("archive_corrupt");
  }

  const computedHash = await sha256Hex(decoded);
  if (computedHash !== manifest.canonical_sha256) {
    throw archiveError("archive_corrupt");
  }

  let events: CanonicalEventEnvelope[];
  try {
    events = await decodeCanonicalJsonl(decoded, {
      tenantId,
      expectedEventCount: manifest.event_count,
      maxDecodedBytes: maxDecodedBytes,
    });
  } catch (error) {
    if (error instanceof ArchiveError && error.code === "archive_unavailable") {
      throw error;
    }
    throw archiveError("archive_corrupt", error);
  }
  const first = events[0];
  const last = events.at(-1);
  if (
    !first ||
    !last ||
    events.length !== manifest.event_count ||
    first.event_id !== manifest.first_event_id ||
    last.event_id !== manifest.last_event_id ||
    first.observed_at !== manifest.first_observed_at ||
    last.observed_at !== manifest.last_observed_at
  ) {
    throw archiveError("archive_corrupt");
  }
  return {
    manifest,
    events,
    decodedBytes: decoded.byteLength,
  };
};

const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return value;
  }
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(object as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  Object.freeze(object);
  return value;
};

const validateListResult = (
  result: unknown,
  tenantId: string,
  pageSize: number,
): { keys: string[]; truncated: boolean; cursor?: string } => {
  try {
    if (result === null || typeof result !== "object") {
      throw archiveError("archive_corrupt");
    }
    const objects = (result as { objects?: unknown }).objects;
    if (!Array.isArray(objects) || objects.length > pageSize) {
      throw archiveError("archive_corrupt");
    }
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const object of objects) {
      if (object === null || typeof object !== "object") {
        throw archiveError("archive_corrupt");
      }
      const key = (object as { key?: unknown }).key;
      if (
        typeof key !== "string" ||
        !isArchiveKeyForTenant(key, tenantId, "manifest") ||
        seen.has(key)
      ) {
        throw archiveError("archive_corrupt");
      }
      seen.add(key);
      keys.push(key);
    }
    const truncated = (result as { truncated?: unknown }).truncated;
    if (typeof truncated !== "boolean") throw archiveError("archive_corrupt");
    if (!truncated) return { keys, truncated: false };
    const cursor = (result as { cursor?: unknown }).cursor;
    if (
      typeof cursor !== "string" ||
      cursor.length === 0 ||
      cursor.length > MAX_R2_CURSOR_CHARS
    ) {
      throw archiveError("archive_corrupt");
    }
    return { keys, truncated: true, cursor };
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_corrupt", error);
  }
};

export const listCommittedManifestPage = async (
  bucket: R2Bucket,
  tenantId: string,
  options?: PageOptions,
): Promise<ManifestPage> => {
  assertTenantId(tenantId);
  const prefix = deriveManifestPrefix(tenantId);
  const parsedOptions = parsePageOptions(options, 50);
  assertBucket(bucket);

  let r2Cursor: string | undefined;
  if (parsedOptions.cursor !== undefined) {
    const decoded = decodeReplayCursor(parsedOptions.cursor, tenantId, prefix);
    r2Cursor = decoded.r2_cursor;
  }
  const listOptions: R2ListOptions = {
    prefix,
    limit: parsedOptions.pageSize,
  };
  if (r2Cursor !== undefined) listOptions.cursor = r2Cursor;

  const listed = await readR2(() => bucket.list(listOptions));
  const validated = validateListResult(listed, tenantId, parsedOptions.pageSize);
  const items: ManifestPageItem[] = [];
  for (const key of validated.keys) {
    const manifest = await readManifestOnly(
      bucket,
      tenantId,
      key,
      "archive_not_found",
    );
    items.push({ key, manifest: deepFreeze(manifest) });
  }

  let next_cursor: string | null = null;
  if (validated.truncated) {
    try {
      next_cursor = encodeReplayCursor({
        schema_version: 1,
        tenant_id: tenantId,
        manifest_prefix: prefix,
        r2_cursor: validated.cursor,
      });
    } catch (error) {
      throw archiveError("archive_corrupt", error);
    }
  }
  return deepFreeze({ items, next_cursor });
};

export const readCommittedArchiveBatch = async (
  bucket: R2Bucket,
  tenantId: string,
  manifestKey: string,
): Promise<{ manifest: ArchiveBatchManifest; events: CanonicalEventEnvelope[] }> => {
  assertTenantId(tenantId);
  validateManifestKeyInput(tenantId, manifestKey);
  assertBucket(bucket);
  const manifest = await readManifestOnly(
    bucket,
    tenantId,
    manifestKey,
    "archive_not_found",
  );
  const committed = await readDataForManifest(
    bucket,
    tenantId,
    manifest,
    MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  );
  return deepFreeze({ manifest: committed.manifest, events: committed.events });
};

const safeBoundedAdd = (
  current: number,
  value: number,
  maximum: number,
): number => {
  if (
    !Number.isSafeInteger(current) ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    current < 0 ||
    current > maximum ||
    value > maximum ||
    current > maximum - value
  ) {
    throw archiveError("archive_too_large");
  }
  return current + value;
};

export const readReplayPage = async (
  bucket: R2Bucket,
  tenantId: string,
  options?: PageOptions,
): Promise<ArchiveReplayPage> => {
  assertTenantId(tenantId);
  const parsedOptions = parsePageOptions(options, 1);
  assertBucket(bucket);
  const listed = await listCommittedManifestPage(bucket, tenantId, parsedOptions);

  let totalEvents = 0;
  let totalBytes = 0;
  for (const item of listed.items) {
    totalEvents = safeBoundedAdd(
      totalEvents,
      item.manifest.event_count,
      MAX_REPLAY_PAGE_EVENTS,
    );
    totalBytes = safeBoundedAdd(
      totalBytes,
      item.manifest.uncompressed_bytes,
      MAX_REPLAY_PAGE_UNCOMPRESSED_BYTES,
    );
  }

  const manifests: ArchiveBatchManifest[] = [];
  const events: CanonicalEventEnvelope[] = [];
  let remainingBytes = MAX_REPLAY_PAGE_UNCOMPRESSED_BYTES;
  for (const item of listed.items) {
    const batch = await readDataForManifest(
      bucket,
      tenantId,
      item.manifest,
      Math.min(remainingBytes, MAX_ARCHIVE_UNCOMPRESSED_BYTES),
    );
    remainingBytes -= batch.decodedBytes;
    manifests.push(batch.manifest);
    events.push(...batch.events);
  }

  const candidate = {
    schema_version: 1 as const,
    replay_mode: "projection_only" as const,
    tenant_id: tenantId,
    manifests,
    events,
    next_cursor: listed.next_cursor,
  };
  const parsed = ArchiveReplayPageSchema.safeParse(candidate);
  if (!parsed.success) throw archiveError("archive_corrupt", parsed.error);
  return deepFreeze(parsed.data);
};
