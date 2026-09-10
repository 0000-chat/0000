import { z } from "zod";
import {
  ArchiveBatchManifestSchema,
  ArchiveManifestKeySchema,
  MAX_ARCHIVE_EVENTS,
  MAX_PRODUCER_VERSION_CHARS,
  type ArchiveBatchManifest,
} from "./archive";
import { CanonicalResourceIdSchema } from "./canonical-event";
import { TimestampSchema } from "./ids";
import {
  ProjectionEventEnvelopeSchema,
  MAX_PROJECTION_BATCH_EVENTS,
} from "./projection";

export const MAX_INGESTION_REQUEST_BYTES = 32 * 1024 * 1024;
export const MAX_INGESTION_QUEUE_POINTER_BYTES = 8 * 1024;
export const MAX_INGESTION_TIMESTAMP_CHARS = 64;
export {
  MAX_PRODUCER_VERSION_CHARS as MAX_INGESTION_PRODUCER_VERSION_CHARS,
};

const PROTOTYPE_SENSITIVE_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

/**
 * Snapshot a strict object using descriptors rather than property reads. A
 * contract boundary must not execute accessors or Proxy get traps before
 * validation has established that the input is safe.
 */
const snapshotStrictObjectInput = (input: unknown): unknown => {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return undefined;
    }

    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return undefined;

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string" || PROTOTYPE_SENSITIVE_KEYS.has(key)) {
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

const isCanonicalArrayIndexKey = (key: string, length: number): boolean => {
  const index = Number(key);
  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
};

/** Snapshot a strict array while rejecting holes, symbols, and extra keys. */
const snapshotStrictArrayInput = (input: unknown, maxLength: number): unknown => {
  try {
    if (input === null || typeof input !== "object" || !Array.isArray(input)) {
      return undefined;
    }
    if (Object.getPrototypeOf(input) !== Array.prototype) return undefined;

    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor)) return undefined;
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maxLength) {
      return undefined;
    }

    const keys = Reflect.ownKeys(input);
    if (keys.length !== length + 1) return undefined;

    const snapshot: unknown[] = [];
    for (const key of keys) {
      if (typeof key !== "string") return undefined;
      if (key === "length") continue;
      if (!isCanonicalArrayIndexKey(key, length)) return undefined;

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

    for (let index = 0; index < length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(snapshot, String(index))) {
        return undefined;
      }
    }
    snapshot.length = length;
    return snapshot;
  } catch {
    return undefined;
  }
};

const strictObject = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.preprocess(snapshotStrictObjectInput, z.object(shape).strict());

const strictArray = <Schema extends z.ZodTypeAny>(
  schema: Schema,
  maxLength: number,
  minLength = 0,
) =>
  z.preprocess(
    (input) => snapshotStrictArrayInput(input, maxLength),
    z.array(schema).min(minLength).max(maxLength),
  );

const BatchIdSchema = z
  .string()
  .regex(/^batch_[0-9a-f]{64}$/);

const ProducerVersionSchema = z
  .string()
  .min(1)
  .max(MAX_PRODUCER_VERSION_CHARS)
  .regex(/^[\x20-\x7E]+$/)
  .refine((value) => value === value.trim(), {
    message: "Producer version cannot have leading or trailing whitespace",
  });

const MatrixCheckpointDigestValueSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/);

const MatrixCheckpointDigestObjectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("matrix_sync_token_sha256"),
      value: MatrixCheckpointDigestValueSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("matrix_backfill_run_sha256"),
      value: MatrixCheckpointDigestValueSchema,
    })
    .strict(),
]);

export const MatrixCheckpointDigestSchema = z.preprocess(
  snapshotStrictObjectInput,
  MatrixCheckpointDigestObjectSchema,
);

export type MatrixCheckpointDigest = z.infer<
  typeof MatrixCheckpointDigestSchema
>;

const IngestionBatchRequestObjectSchema = strictObject({
  schema_version: z.literal(1),
  gateway_route_id: CanonicalResourceIdSchema,
  tenant_id: CanonicalResourceIdSchema,
  batch_id: BatchIdSchema,
  archived_at: TimestampSchema.max(MAX_INGESTION_TIMESTAMP_CHARS),
  producer_version: ProducerVersionSchema,
  source_checkpoint: MatrixCheckpointDigestSchema,
  events: strictArray(
    ProjectionEventEnvelopeSchema,
    Math.min(MAX_ARCHIVE_EVENTS, MAX_PROJECTION_BATCH_EVENTS),
    1,
  ),
}).superRefine((request, context) => {
  const eventIds = new Set<string>();
  let hasAccount = false;

  for (const [index, event] of request.events.entries()) {
    if (event.tenant_id !== request.tenant_id) {
      context.addIssue({
        code: "custom",
        path: ["events", index, "tenant_id"],
        message: "Every event must belong to the request tenant",
      });
    }

    if (eventIds.has(event.event_id)) {
      context.addIssue({
        code: "custom",
        path: ["events", index, "event_id"],
        message: "Event IDs must be unique within a batch",
      });
    }
    eventIds.add(event.event_id);
    if (event.account_id.length > 0) hasAccount = true;
  }

  if (!hasAccount) {
    context.addIssue({
      code: "custom",
      path: ["events"],
      message: "At least one account is required",
    });
  }
});

export const IngestionBatchRequestSchema = IngestionBatchRequestObjectSchema;

export type IngestionBatchRequest = z.infer<typeof IngestionBatchRequestSchema>;

export const IngestionAcceptedResponseSchema = strictObject({
  schema_version: z.literal(1),
  tenant_id: CanonicalResourceIdSchema,
  batch_id: BatchIdSchema,
  status: z.literal("accepted"),
  archive_status: z.enum(["created", "already_committed"]),
});

export type IngestionAcceptedResponse = z.infer<
  typeof IngestionAcceptedResponseSchema
>;

const parseManifestKeyParts = (
  value: string,
): { tenant_id: string; batch_id: string } | null => {
  const segments = value.split("/");
  if (segments.length !== 7 || segments[0] !== "manifests") return null;
  const file = segments[6];
  if (file === undefined || !file.endsWith(".json")) return null;
  const tenant_id = segments[1];
  const batch_id = file.slice(0, -".json".length);
  if (tenant_id === undefined || batch_id.length === 0) return null;
  return { tenant_id, batch_id };
};

const CommittedArchivePointerObjectSchema = strictObject({
  schema_version: z.literal(1),
  kind: z.literal("archive.batch.committed"),
  tenant_id: CanonicalResourceIdSchema,
  batch_id: BatchIdSchema,
  manifest_key: ArchiveManifestKeySchema,
  canonical_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  gateway_route_id: CanonicalResourceIdSchema,
}).superRefine((pointer, context) => {
  const keyParts = parseManifestKeyParts(pointer.manifest_key);
  if (!keyParts) return;

  if (keyParts.tenant_id !== pointer.tenant_id) {
    context.addIssue({
      code: "custom",
      path: ["manifest_key"],
      message: "Manifest key tenant does not match pointer tenant",
    });
  }
  if (keyParts.batch_id !== pointer.batch_id) {
    context.addIssue({
      code: "custom",
      path: ["manifest_key"],
      message: "Manifest key batch does not match pointer batch",
    });
  }
});

export const CommittedArchivePointerSchema =
  CommittedArchivePointerObjectSchema;

export type CommittedArchivePointer = z.infer<
  typeof CommittedArchivePointerSchema
>;

const IngestionCommittedArchiveManifestValidationSchema = z.preprocess(
  snapshotStrictObjectInput,
  z.unknown().transform((input, context) => {
    const genericResult = ArchiveBatchManifestSchema.safeParse(input);
    if (!genericResult.success) {
      context.addIssue({
        code: "custom",
        message: "Invalid committed archive manifest",
      });
      return z.NEVER;
    }

    // The generic archive contract trims its checkpoint strings. Re-check the
    // original descriptor value so this ingestion-specific contract remains
    // canonical and accepts only the exact digest representation.
    let rawCheckpoint: unknown;
    if (input !== null && typeof input === "object") {
      const checkpointDescriptor = Object.getOwnPropertyDescriptor(
        input,
        "source_checkpoint",
      );
      if (checkpointDescriptor && "value" in checkpointDescriptor) {
        rawCheckpoint = checkpointDescriptor.value;
      }
    }

    const checkpointResult = MatrixCheckpointDigestSchema.safeParse(rawCheckpoint);
    if (!checkpointResult.success) {
      context.addIssue({
        code: "custom",
        path: ["source_checkpoint"],
        message: "Committed archive manifest requires a Matrix checkpoint digest",
      });
      return z.NEVER;
    }

    return {
      ...genericResult.data,
      source_checkpoint: checkpointResult.data,
    };
  }),
);

export const IngestionCommittedArchiveManifestSchema =
  IngestionCommittedArchiveManifestValidationSchema as unknown as z.ZodType<
    Omit<ArchiveBatchManifest, "source_checkpoint"> & {
      source_checkpoint: MatrixCheckpointDigest;
    }
  >;

export type IngestionCommittedArchiveManifest = z.infer<
  typeof IngestionCommittedArchiveManifestSchema
>;

export const IngestionErrorCodeSchema = z.enum([
  "ingestion_invalid",
  "ingestion_too_large",
  "ingestion_unauthenticated",
  "ingestion_not_found",
  "ingestion_conflict",
  "ingestion_unavailable",
]);

export type IngestionErrorCode = z.infer<typeof IngestionErrorCodeSchema>;

export const IngestionErrorResponseSchema = strictObject({
  error: strictObject({
    code: IngestionErrorCodeSchema,
    message: z.string().min(1).max(100),
  }),
});

export type IngestionErrorResponse = z.infer<
  typeof IngestionErrorResponseSchema
>;
