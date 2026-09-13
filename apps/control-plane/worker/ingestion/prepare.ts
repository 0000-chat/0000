import {
  CommittedArchivePointerSchema,
  IngestionBatchRequestSchema,
  MAX_ARCHIVE_EVENTS,
  MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  MAX_INGESTION_QUEUE_POINTER_BYTES,
  MAX_PROJECTION_BATCH_BYTES,
  type CommittedArchivePointer,
  type IngestionBatchRequest,
  type MatrixCheckpointDigest,
  type ProjectionEventEnvelope,
} from "@communicator/contracts";
import { canonicalJsonBytes } from "../archive/canonical-json";
import {
  encodeCanonicalEventBatch,
  sha256Hex,
  type EncodedCanonicalEventBatch,
} from "../archive/codec";
import { isArchiveError, type ArchiveError } from "../archive/errors";
import type {
  ArchiveCanonicalEventBatchInput,
  ArchiveSourceCheckpoint,
} from "../archive/writer";
import { IngestionError, ingestionError, isIngestionError } from "./errors";

const PROTOTYPE_SENSITIVE_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

const BATCH_ID_PATTERN = /^batch_[0-9a-f]{64}$/;

/** The archive writer receives this after the route supplies its R2 bucket. */
export type PreparedArchiveInput = Omit<
  ArchiveCanonicalEventBatchInput,
  "bucket"
>;

export type PreparedIngestionBatch = {
  readonly request: IngestionBatchRequest;
  readonly tenantId: string;
  readonly gatewayRouteId: string;
  readonly batchId: string;
  readonly recomputedBatchId: string;
  readonly archivedAt: string;
  readonly producerVersion: string;
  readonly sourceCheckpoint: MatrixCheckpointDigest;
  readonly events: readonly ProjectionEventEnvelope[];
  readonly canonicalJsonl: Uint8Array;
  readonly uncompressedBytes: number;
  readonly canonicalSha256: string;
  readonly archiveInput: PreparedArchiveInput;
};

export type CommittedArchivePointerInput = {
  tenantId: string;
  batchId: string;
  manifestKey: string;
  canonicalSha256: string;
  gatewayRouteId: string;
};

const ownDataSnapshot = (
  input: unknown,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> | undefined => {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return undefined;
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return undefined;

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(input)) {
      if (
        typeof key !== "string" ||
        !allowedKeys.has(key) ||
        PROTOTYPE_SENSITIVE_KEYS.has(key)
      ) {
        return undefined;
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        return undefined;
      }
      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      });
    }
    return snapshot;
  } catch {
    return undefined;
  }
};

const eventCountAboveLimit = (input: unknown): boolean => {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const eventsDescriptor = Object.getOwnPropertyDescriptor(input, "events");
    if (
      eventsDescriptor === undefined ||
      !eventsDescriptor.enumerable ||
      !("value" in eventsDescriptor)
    ) {
      return false;
    }
    const events = eventsDescriptor.value;
    if (
      events === null ||
      typeof events !== "object" ||
      !Array.isArray(events) ||
      Object.getPrototypeOf(events) !== Array.prototype
    ) {
      return false;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(events, "length");
    return (
      lengthDescriptor !== undefined &&
      "value" in lengthDescriptor &&
      Number.isSafeInteger(lengthDescriptor.value) &&
      lengthDescriptor.value > MAX_ARCHIVE_EVENTS
    );
  } catch {
    return false;
  }
};

const cloneParsedRequest = (input: unknown): IngestionBatchRequest => {
  try {
    const result = IngestionBatchRequestSchema.safeParse(input);
    if (!result.success)
      throw ingestionError("ingestion_invalid", result.error);
    return structuredClone(result.data) as IngestionBatchRequest;
  } catch (error) {
    if (isIngestionError(error)) throw error;
    throw ingestionError("ingestion_invalid", error);
  }
};

const mapArchiveCode = (code: ArchiveError["code"]): IngestionError["code"] => {
  switch (code) {
    case "archive_too_large":
      return "ingestion_too_large";
    case "archive_unavailable":
    case "archive_busy":
      return "ingestion_unavailable";
    case "archive_conflict":
      return "ingestion_conflict";
    case "archive_invalid":
    case "archive_tenant_mismatch":
    case "archive_not_found":
    case "archive_corrupt":
      return "ingestion_invalid";
  }
};

/** Convert internal archive failures to the stable ingestion error contract. */
export const mapArchiveFailure = (error: unknown): IngestionError => {
  if (isIngestionError(error)) return error;
  if (isArchiveError(error))
    return ingestionError(mapArchiveCode(error.code), error);
  return ingestionError("ingestion_invalid", error);
};

const batchIdentityValue = (
  request: Pick<
    IngestionBatchRequest,
    | "schema_version"
    | "tenant_id"
    | "gateway_route_id"
    | "archived_at"
    | "producer_version"
    | "source_checkpoint"
  >,
  canonicalSha256: string,
): Record<string, unknown> => {
  // The field assignment order is intentional and documents the identity
  // contract. canonicalJsonBytes also recursively sorts these object keys.
  const value = Object.create(null) as Record<string, unknown>;
  value.schema_version = request.schema_version;
  value.tenant_id = request.tenant_id;
  value.gateway_route_id = request.gateway_route_id;
  value.canonical_sha256 = canonicalSha256;
  value.source_checkpoint = {
    kind: request.source_checkpoint.kind,
    value: request.source_checkpoint.value,
  };
  value.archived_at = request.archived_at;
  value.producer_version = request.producer_version;
  return value;
};

/** Recompute the immutable-content batch ID from an already parsed request. */
export const recomputeBatchId = async (
  request: Pick<
    IngestionBatchRequest,
    | "schema_version"
    | "tenant_id"
    | "gateway_route_id"
    | "archived_at"
    | "producer_version"
    | "source_checkpoint"
  >,
  canonicalSha256: string,
): Promise<string> => {
  try {
    const identityBytes = canonicalJsonBytes(
      batchIdentityValue(request, canonicalSha256),
    );
    return `batch_${await sha256Hex(identityBytes)}`;
  } catch (error) {
    throw mapArchiveFailure(error);
  }
};

/** Explicit alias used by callers that prefer the longer contract name. */
export const recomputeIngestionBatchId = recomputeBatchId;

const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value === null || typeof value !== "object") return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) {
      deepFreeze(descriptor.value, seen);
    }
  }
  return Object.freeze(value);
};

const sortedProjectionEvents = (
  encoded: EncodedCanonicalEventBatch,
): ProjectionEventEnvelope[] => {
  try {
    // encodeCanonicalEventBatch has already descriptor-snapshotted and
    // canonical-schema validated every event. Clone once more so no object in
    // the returned preparation aliases codec internals or caller input.
    return structuredClone(encoded.events) as ProjectionEventEnvelope[];
  } catch (error) {
    throw ingestionError("ingestion_invalid", error);
  }
};

/**
 * Parse and snapshot one ingestion request, canonicalize its projection events,
 * verify its deterministic identity, and return only detached write inputs.
 * This function performs no D1, R2, Queue, or network I/O.
 */
export const prepareIngestionBatch = async (
  input: unknown,
): Promise<PreparedIngestionBatch> => {
  if (eventCountAboveLimit(input)) {
    throw ingestionError("ingestion_too_large");
  }

  const request = cloneParsedRequest(input);

  let encoded: EncodedCanonicalEventBatch;
  try {
    encoded = await encodeCanonicalEventBatch({
      tenantId: request.tenant_id,
      events: request.events,
    });
  } catch (error) {
    throw mapArchiveFailure(error);
  }

  if (
    encoded.events.length > MAX_ARCHIVE_EVENTS ||
    encoded.uncompressedBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES ||
    encoded.uncompressedBytes > MAX_PROJECTION_BATCH_BYTES
  ) {
    throw ingestionError("ingestion_too_large");
  }

  const recomputedBatchId = await recomputeBatchId(
    request,
    encoded.canonicalSha256,
  );
  if (
    !BATCH_ID_PATTERN.test(recomputedBatchId) ||
    recomputedBatchId !== request.batch_id
  ) {
    throw ingestionError("ingestion_invalid");
  }

  const events = sortedProjectionEvents(encoded);
  const sourceCheckpoint = structuredClone(
    request.source_checkpoint,
  ) as MatrixCheckpointDigest;
  const archiveInput: PreparedArchiveInput = {
    tenantId: request.tenant_id,
    batchId: request.batch_id,
    events,
    archivedAt: request.archived_at,
    producerVersion: request.producer_version,
    sourceCheckpoint: sourceCheckpoint as ArchiveSourceCheckpoint,
  };

  // Typed-array elements cannot be frozen. Keep the validated bytes in a
  // private detached snapshot and expose a fresh copy through the frozen
  // preparation object instead.
  const canonicalJsonlSnapshot = encoded.canonicalJsonl.slice();
  const prepared: PreparedIngestionBatch = {
    request,
    tenantId: request.tenant_id,
    gatewayRouteId: request.gateway_route_id,
    batchId: request.batch_id,
    recomputedBatchId,
    archivedAt: request.archived_at,
    producerVersion: request.producer_version,
    sourceCheckpoint,
    events,
    canonicalJsonl: canonicalJsonlSnapshot.slice(),
    uncompressedBytes: encoded.uncompressedBytes,
    canonicalSha256: encoded.canonicalSha256,
    archiveInput,
  };

  Object.defineProperty(prepared, "canonicalJsonl", {
    configurable: true,
    enumerable: true,
    get: () => canonicalJsonlSnapshot.slice(),
  });

  return deepFreeze(prepared);
};

const POINTER_INPUT_KEYS = new Set([
  "tenantId",
  "batchId",
  "manifestKey",
  "canonicalSha256",
  "gatewayRouteId",
]);

/**
 * Construct the strict pointer that may be sent to Queue after the archive
 * writer has returned its verified manifest. The canonical byte bound is
 * checked before a caller can enqueue it.
 */
export const buildCommittedArchivePointer = (
  input: CommittedArchivePointerInput,
): CommittedArchivePointer => {
  const snapshot = ownDataSnapshot(input, POINTER_INPUT_KEYS);
  if (snapshot === undefined) throw ingestionError("ingestion_invalid");

  try {
    const candidate = Object.create(null) as Record<string, unknown>;
    candidate.schema_version = 1;
    candidate.kind = "archive.batch.committed";
    candidate.tenant_id = snapshot.tenantId;
    candidate.batch_id = snapshot.batchId;
    candidate.manifest_key = snapshot.manifestKey;
    candidate.canonical_sha256 = snapshot.canonicalSha256;
    candidate.gateway_route_id = snapshot.gatewayRouteId;

    const result = CommittedArchivePointerSchema.safeParse(candidate);
    if (!result.success)
      throw ingestionError("ingestion_invalid", result.error);
    const pointerBytes = canonicalJsonBytes(result.data);
    if (pointerBytes.byteLength > MAX_INGESTION_QUEUE_POINTER_BYTES) {
      throw ingestionError("ingestion_too_large");
    }

    return deepFreeze(structuredClone(result.data) as CommittedArchivePointer);
  } catch (error) {
    if (isIngestionError(error)) throw error;
    throw mapArchiveFailure(error);
  }
};

/** Explicit constructor alias for route/consumer call sites. */
export const constructCommittedArchivePointer = buildCommittedArchivePointer;
