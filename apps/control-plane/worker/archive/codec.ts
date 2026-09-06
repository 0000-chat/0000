import {
  CanonicalEventEnvelopeSchema,
  CanonicalResourceIdSchema,
  MAX_ARCHIVE_COMPRESSED_BYTES,
  MAX_ARCHIVE_EVENTS,
  MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  MAX_EVENT_CANONICAL_BYTES,
  type CanonicalEventEnvelope,
} from "@communicator/contracts";
import {
  bytesEqual,
  canonicalJsonBytes,
} from "./canonical-json";
import { ArchiveError, archiveError } from "./errors";

export { ArchiveError } from "./errors";

export type EncodeCanonicalEventBatchInput = {
  tenantId: string;
  events: readonly unknown[];
};

export type EncodedCanonicalEventBatch = {
  tenantId: string;
  events: CanonicalEventEnvelope[];
  canonicalJsonl: Uint8Array;
  uncompressedBytes: number;
  canonicalSha256: string;
  compressed: Uint8Array;
  compressedBytes: number;
};

export type DecodeCanonicalJsonlOptions = {
  tenantId?: string;
  maxDecodedBytes?: number;
  expectedEventCount?: number;
};

const asUint8Array = (value: ArrayBuffer | ArrayBufferView | Uint8Array): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
};

const inputArraySnapshot = (input: unknown): unknown[] => {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
      throw archiveError("archive_invalid");
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor)) {
      throw archiveError("archive_invalid");
    }
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 1) {
      throw archiveError("archive_invalid");
    }
    if (length > MAX_ARCHIVE_EVENTS) {
      throw archiveError("archive_too_large");
    }

    const keys = Reflect.ownKeys(input);
    if (keys.length !== length + 1) throw archiveError("archive_invalid");
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (!Object.prototype.hasOwnProperty.call(input, key)) {
        throw archiveError("archive_invalid");
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw archiveError("archive_invalid");
      }
      snapshot.push(descriptor.value);
    }
    return snapshot;
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_invalid", error);
  }
};

const parseEvent = (input: unknown): CanonicalEventEnvelope => {
  try {
    const result = CanonicalEventEnvelopeSchema.safeParse(input);
    if (!result.success) throw archiveError("archive_invalid", result.error);
    return result.data;
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_invalid", error);
  }
};

const eventInstant = (timestamp: string): number => {
  const instant = Date.parse(timestamp);
  if (!Number.isFinite(instant)) throw archiveError("archive_invalid");
  return instant;
};

const compareEvents = (
  left: CanonicalEventEnvelope,
  right: CanonicalEventEnvelope,
): number => {
  const observed = eventInstant(left.observed_at) - eventInstant(right.observed_at);
  if (observed !== 0) return observed;
  const occurred = eventInstant(left.occurred_at) - eventInstant(right.occurred_at);
  if (occurred !== 0) return occurred;
  if (left.event_id < right.event_id) return -1;
  if (left.event_id > right.event_id) return 1;
  return 0;
};

const concatChunks = (chunks: readonly Uint8Array[], total: number): Uint8Array => {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

const readStreamBounded = async (
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  tooLargeCode: "archive_too_large" | "archive_corrupt" = "archive_too_large",
): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) {
        throw archiveError("archive_corrupt");
      }
      total += item.value.byteLength;
      if (total > maxBytes) throw archiveError(tooLargeCode);
      chunks.push(item.value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the original bounded-read/decompression failure.
    }
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_corrupt", error);
  } finally {
    reader.releaseLock();
  }
  return concatChunks(chunks, total);
};

const validateBound = (
  value: number,
  maximum: number,
): void => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw archiveError("archive_invalid");
  }
};

const streamFromBytes = (bytes: Uint8Array): ReadableStream<Uint8Array> => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const body = new Response(copy.buffer).body;
  if (body === null) throw archiveError("archive_unavailable");
  return body as ReadableStream<Uint8Array>;
};

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  try {
    const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  } catch (error) {
    throw archiveError("archive_unavailable", error);
  }
};

export const gzipBytes = async (
  bytes: Uint8Array,
  maxCompressedBytes = MAX_ARCHIVE_COMPRESSED_BYTES,
): Promise<Uint8Array> => {
  try {
    validateBound(maxCompressedBytes, MAX_ARCHIVE_COMPRESSED_BYTES);
    if (typeof CompressionStream === "undefined") {
      throw archiveError("archive_unavailable");
    }
    const compression = new CompressionStream("gzip") as unknown as TransformStream<
      Uint8Array,
      Uint8Array
    >;
    const compressed = streamFromBytes(bytes).pipeThrough(compression);
    return await readStreamBounded(compressed, maxCompressedBytes);
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_unavailable", error);
  }
};

export type GzipInput =
  | Uint8Array
  | ArrayBuffer
  | ArrayBufferView
  | ReadableStream<Uint8Array>;

const validateGzipHeader = (bytes: Uint8Array): void => {
  // A gzip member has a fixed ten-byte header and an eight-byte trailer. The
  // inexpensive envelope check keeps clearly malformed inputs away from the
  // workerd decompressor, whose rejected close can otherwise surface as an
  // uncaught stream diagnostic.
  if (
    bytes.byteLength < 18 ||
    bytes[0] !== 0x1f ||
    bytes[1] !== 0x8b ||
    bytes[2] !== 0x08 ||
    (bytes[3]! & 0xe0) !== 0
  ) {
    throw archiveError("archive_corrupt");
  }

  const flags = bytes[3]!;
  let offset = 10;
  if ((flags & 0x04) !== 0) {
    if (offset + 2 > bytes.byteLength - 8) throw archiveError("archive_corrupt");
    const extraLength = bytes[offset]! | (bytes[offset + 1]! << 8);
    offset += 2 + extraLength;
    if (offset > bytes.byteLength - 8) throw archiveError("archive_corrupt");
  }
  for (const flag of [0x08, 0x10]) {
    if ((flags & flag) === 0) continue;
    while (offset < bytes.byteLength - 8 && bytes[offset] !== 0) offset += 1;
    if (offset >= bytes.byteLength - 8) throw archiveError("archive_corrupt");
    offset += 1;
  }
  if ((flags & 0x02) !== 0) {
    offset += 2;
    if (offset > bytes.byteLength - 8) throw archiveError("archive_corrupt");
  }
  if (offset >= bytes.byteLength - 8) throw archiveError("archive_corrupt");
};

const boundedCompressedStream = (
  stream: ReadableStream<Uint8Array>,
  maxCompressedBytes: number,
): ReadableStream<Uint8Array> => {
  let total = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!(chunk instanceof Uint8Array)) {
          controller.error(archiveError("archive_corrupt"));
          return;
        }
        total += chunk.byteLength;
        if (total > maxCompressedBytes) {
          controller.error(archiveError("archive_too_large"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
};

export const gunzipBytes = async (
  input: GzipInput,
  maxDecodedBytes = MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  maxCompressedBytes = MAX_ARCHIVE_COMPRESSED_BYTES,
): Promise<Uint8Array> => {
  try {
    validateBound(maxDecodedBytes, MAX_ARCHIVE_UNCOMPRESSED_BYTES);
    validateBound(maxCompressedBytes, MAX_ARCHIVE_COMPRESSED_BYTES);
    if (typeof DecompressionStream === "undefined") {
      throw archiveError("archive_unavailable");
    }
    const compressedBytes =
      input instanceof ReadableStream
        ? await readStreamBounded(input, maxCompressedBytes)
        : asUint8Array(input);
    if (compressedBytes.byteLength > maxCompressedBytes) {
      throw archiveError("archive_too_large");
    }
    validateGzipHeader(compressedBytes);
    const stream = streamFromBytes(compressedBytes);
    const decompression = new DecompressionStream("gzip") as unknown as TransformStream<
      Uint8Array,
      Uint8Array
    >;
    const decompressed = boundedCompressedStream(stream, maxCompressedBytes).pipeThrough(
      decompression,
    );
    return await readStreamBounded(decompressed, maxDecodedBytes);
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_corrupt", error);
  }
};

const decodeUtf8 = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw archiveError("archive_corrupt", error);
  }
};

const decodeInputBytes = async (
  input: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> => {
  if (input instanceof ReadableStream) {
    return readStreamBounded(input, maxBytes);
  }
  const bytes = asUint8Array(input);
  if (bytes.byteLength > maxBytes) throw archiveError("archive_too_large");
  return bytes;
};

const buildCanonicalJsonl = (
  events: readonly CanonicalEventEnvelope[],
): Uint8Array => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const event of events) {
    const eventBytes = canonicalJsonBytes(event);
    if (eventBytes.byteLength > MAX_EVENT_CANONICAL_BYTES) {
      throw archiveError("archive_too_large");
    }
    const line = new Uint8Array(eventBytes.byteLength + 1);
    line.set(eventBytes);
    line[eventBytes.byteLength] = 0x0a;
    total += line.byteLength;
    if (total > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
      throw archiveError("archive_too_large");
    }
    chunks.push(line);
  }
  return concatChunks(chunks, total);
};

export const encodeCanonicalEventBatch = async ({
  tenantId,
  events,
}: EncodeCanonicalEventBatchInput): Promise<EncodedCanonicalEventBatch> => {
  if (!CanonicalResourceIdSchema.safeParse(tenantId).success) {
    throw archiveError("archive_invalid");
  }
  const snapshot = inputArraySnapshot(events);
  const parsedEvents = snapshot.map(parseEvent);
  const seen = new Set<string>();
  for (const event of parsedEvents) {
    if (event.tenant_id !== tenantId) throw archiveError("archive_tenant_mismatch");
    if (seen.has(event.event_id)) throw archiveError("archive_invalid");
    seen.add(event.event_id);
    eventInstant(event.observed_at);
    eventInstant(event.occurred_at);
  }

  const orderedEvents = [...parsedEvents].sort(compareEvents);
  const canonicalJsonl = buildCanonicalJsonl(orderedEvents);
  const canonicalSha256 = await sha256Hex(canonicalJsonl);
  const compressed = await gzipBytes(canonicalJsonl);

  return {
    tenantId,
    events: orderedEvents,
    canonicalJsonl,
    uncompressedBytes: canonicalJsonl.byteLength,
    canonicalSha256,
    compressed,
    compressedBytes: compressed.byteLength,
  };
};

export const decodeCanonicalJsonl = async (
  input: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>,
  options: DecodeCanonicalJsonlOptions = {},
): Promise<CanonicalEventEnvelope[]> => {
  const maxDecodedBytes = options.maxDecodedBytes ?? MAX_ARCHIVE_UNCOMPRESSED_BYTES;
  validateBound(maxDecodedBytes, MAX_ARCHIVE_UNCOMPRESSED_BYTES);
  if (options.tenantId !== undefined && !CanonicalResourceIdSchema.safeParse(options.tenantId).success) {
    throw archiveError("archive_invalid");
  }
  if (
    options.expectedEventCount !== undefined &&
    (!Number.isSafeInteger(options.expectedEventCount) ||
      options.expectedEventCount < 1 ||
      options.expectedEventCount > MAX_ARCHIVE_EVENTS)
  ) {
    throw archiveError("archive_invalid");
  }

  const bytes = await decodeInputBytes(input, maxDecodedBytes);
  if (bytes.byteLength === 0 || bytes.at(-1) !== 0x0a) {
    throw archiveError("archive_corrupt");
  }
  const text = decodeUtf8(bytes);
  const lines = text.split("\n");
  if (lines.at(-1) !== "") throw archiveError("archive_corrupt");
  lines.pop();
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    throw archiveError("archive_corrupt");
  }
  if (lines.some((line) => line.includes("\r"))) {
    throw archiveError("archive_corrupt");
  }
  if (lines.length > MAX_ARCHIVE_EVENTS) throw archiveError("archive_too_large");
  if (options.expectedEventCount !== undefined && lines.length !== options.expectedEventCount) {
    throw archiveError("archive_corrupt");
  }

  const events: CanonicalEventEnvelope[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line) as unknown;
    } catch (error) {
      throw archiveError("archive_corrupt", error);
    }
    let result: ReturnType<typeof CanonicalEventEnvelopeSchema.safeParse>;
    try {
      result = CanonicalEventEnvelopeSchema.safeParse(parsedJson);
    } catch (error) {
      throw archiveError("archive_corrupt", error);
    }
    if (!result.success) throw archiveError("archive_corrupt", result.error);
    const event = result.data;
    if (options.tenantId !== undefined && event.tenant_id !== options.tenantId) {
      throw archiveError("archive_corrupt");
    }
    if (seen.has(event.event_id)) throw archiveError("archive_corrupt");
    seen.add(event.event_id);
    eventInstant(event.observed_at);
    eventInstant(event.occurred_at);
    const previous = events.at(-1);
    if (previous !== undefined && compareEvents(previous, event) > 0) {
      throw archiveError("archive_corrupt");
    }
    events.push(event);
  }

  let canonical: Uint8Array;
  try {
    canonical = buildCanonicalJsonl(events);
  } catch (error) {
    if (error instanceof ArchiveError && error.code === "archive_too_large") throw error;
    throw archiveError("archive_corrupt", error);
  }
  if (!bytesEqual(bytes, canonical)) throw archiveError("archive_corrupt");
  return events;
};

export const decodeGzipCanonicalJsonl = async (
  input: GzipInput,
  options: DecodeCanonicalJsonlOptions = {},
): Promise<CanonicalEventEnvelope[]> => {
  const decoded = await gunzipBytes(
    input,
    options.maxDecodedBytes ?? MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  );
  return decodeCanonicalJsonl(decoded, options);
};

export const encodeCanonicalJsonl = encodeCanonicalEventBatch;
