import { z } from "zod";
import {
  CanonicalEventEnvelopeSchema,
  CanonicalResourceIdSchema,
  type CanonicalEventEnvelope,
} from "./canonical-event";
import { TimestampSchema } from "./ids";

export const MAX_ARCHIVE_EVENTS = 500;
export const MAX_EVENT_CANONICAL_BYTES = 1 * 1024 * 1024;
export const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 4 * 1024 * 1024;
export const MAX_ARCHIVE_COMPRESSED_BYTES = 5 * 1024 * 1024;
export const MAX_ARCHIVE_MANIFEST_BYTES = 64 * 1024;
export const MAX_ARCHIVE_KEY_CHARS = 512;
export const MAX_ARCHIVE_ETAG_CHARS = 256;
export const MAX_PRODUCER_VERSION_CHARS = 128;
export const MAX_CHECKPOINT_KIND_CHARS = 64;
export const MAX_CHECKPOINT_VALUE_CHARS = 512;
export const DEFAULT_MANIFEST_PAGE_SIZE = 50;
export const MAX_MANIFEST_PAGE_SIZE = 100;
export const DEFAULT_REPLAY_PAGE_SIZE = 1;
export const MAX_REPLAY_PAGE_EVENTS = 4 * MAX_ARCHIVE_EVENTS;
export const MAX_REPLAY_PAGE_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
export const MAX_REPLAY_CURSOR_CHARS = 4096;
export const MAX_R2_CURSOR_CHARS = 2048;
export const MAX_MANIFEST_PREFIX_CHARS = 256;

const RESOURCE_SEGMENT = "[a-z]+_[a-z0-9_]+";
const BATCH_SEGMENT = "batch_[a-z0-9_]+";
const MONTH_SEGMENT = "(?:0[1-9]|1[0-2])";
const DAY_SEGMENT = "(?:0[1-9]|[12][0-9]|3[01])";
const HOUR_SEGMENT = "(?:[01][0-9]|2[0-3])";

const DATA_KEY_PATTERN = new RegExp(
  `^events/${RESOURCE_SEGMENT}/[0-9]{4}/${MONTH_SEGMENT}/${DAY_SEGMENT}/${HOUR_SEGMENT}/${BATCH_SEGMENT}\\.jsonl\\.gz$`,
);
const MANIFEST_KEY_PATTERN = new RegExp(
  `^manifests/${RESOURCE_SEGMENT}/[0-9]{4}/${MONTH_SEGMENT}/${DAY_SEGMENT}/${HOUR_SEGMENT}/${BATCH_SEGMENT}\\.json$`,
);

const BoundedTimestampSchema = TimestampSchema.max(64);
const OpaqueEventIdSchema = z.string().trim().min(1).max(1024);
const ArchiveKeyStringSchema = z
  .string()
  .max(MAX_ARCHIVE_KEY_CHARS)
  .regex(/^[\x20-\x7E]+$/);
const PROTOTYPE_SENSITIVE_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

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

const snapshotStrictArrayInput = (
  input: unknown,
  maxLength: number,
): unknown => {
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
      const key = String(index);
      if (!Object.prototype.hasOwnProperty.call(snapshot, key))
        return undefined;
    }
    snapshot.length = length;
    return snapshot;
  } catch {
    return undefined;
  }
};

type ArchiveKeyParts = {
  tenant_id: string;
  year: string;
  month: string;
  day: string;
  hour: string;
  batch_id: string;
};

const parseArchiveKey = (
  value: string,
  prefix: "events" | "manifests",
): ArchiveKeyParts | null => {
  const segments = value.split("/");
  if (segments.length !== 7 || segments[0] !== prefix) return null;

  const file = segments[6];
  if (file === undefined) return null;
  const suffix = prefix === "events" ? ".jsonl.gz" : ".json";
  if (!file.endsWith(suffix)) return null;

  const batch_id = file.slice(0, -suffix.length);
  const tenant_id = segments[1];
  const year = segments[2];
  const month = segments[3];
  const day = segments[4];
  const hour = segments[5];
  if (
    tenant_id === undefined ||
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined
  ) {
    return null;
  }

  return { tenant_id, year, month, day, hour, batch_id };
};

const isValidUtcPartition = (parts: ArchiveKeyParts): boolean => {
  const date = new Date(
    `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00:00.000Z`,
  );
  return (
    Number.isFinite(date.getTime()) &&
    date.getUTCFullYear() === Number(parts.year) &&
    date.getUTCMonth() + 1 === Number(parts.month) &&
    date.getUTCDate() === Number(parts.day) &&
    date.getUTCHours() === Number(parts.hour)
  );
};

const isValidArchiveKey = (
  value: string,
  prefix: "events" | "manifests",
): boolean => {
  const pattern = prefix === "events" ? DATA_KEY_PATTERN : MANIFEST_KEY_PATTERN;
  if (!pattern.test(value)) return false;

  const parts = parseArchiveKey(value, prefix);
  if (!parts || !isValidUtcPartition(parts)) return false;
  if (!CanonicalResourceIdSchema.safeParse(parts.tenant_id).success)
    return false;
  return (
    parts.batch_id.startsWith("batch_") &&
    CanonicalResourceIdSchema.safeParse(parts.batch_id).success
  );
};

export const ArchiveDataKeySchema = ArchiveKeyStringSchema.refine(
  (value) => isValidArchiveKey(value, "events"),
  "Invalid archive data key",
);

export const ArchiveManifestKeySchema = ArchiveKeyStringSchema.refine(
  (value) => isValidArchiveKey(value, "manifests"),
  "Invalid archive manifest key",
);

export const ArchiveKeySchema = z.union([
  ArchiveDataKeySchema,
  ArchiveManifestKeySchema,
]);

export type ArchiveDataKey = z.infer<typeof ArchiveDataKeySchema>;
export type ArchiveManifestKey = z.infer<typeof ArchiveManifestKeySchema>;

const ProducerObjectSchema = z
  .object({
    service: z.literal("communicator-control-plane"),
    version: z.string().trim().min(1).max(MAX_PRODUCER_VERSION_CHARS),
  })
  .strict();
const ProducerSchema = z.preprocess(
  snapshotStrictObjectInput,
  ProducerObjectSchema,
);

const SourceCheckpointObjectSchema = z
  .object({
    kind: z.string().trim().min(1).max(MAX_CHECKPOINT_KIND_CHARS),
    value: z.string().trim().min(1).max(MAX_CHECKPOINT_VALUE_CHARS),
  })
  .strict();
const SourceCheckpointSchema = z.preprocess(
  snapshotStrictObjectInput,
  SourceCheckpointObjectSchema,
);

const PositiveArchiveBytes = (max: number) =>
  z.number().int().safe().positive().max(max);

const archivePartitionMatchesObservedAt = (
  dataKey: string,
  observedAt: string,
): boolean => {
  const parts = parseArchiveKey(dataKey, "events");
  if (!parts) return false;

  const instant = new Date(observedAt);
  if (!Number.isFinite(instant.getTime())) return false;

  return (
    parts.year === String(instant.getUTCFullYear()).padStart(4, "0") &&
    parts.month === String(instant.getUTCMonth() + 1).padStart(2, "0") &&
    parts.day === String(instant.getUTCDate()).padStart(2, "0") &&
    parts.hour === String(instant.getUTCHours()).padStart(2, "0")
  );
};

const ArchiveBatchManifestObjectSchema = z
  .object({
    schema_version: z.literal(1),
    tenant_id: CanonicalResourceIdSchema,
    batch_id: CanonicalResourceIdSchema.startsWith("batch_"),
    data_key: ArchiveDataKeySchema,
    compression: z.literal("gzip"),
    content_type: z.literal("application/x-ndjson"),
    event_count: z.number().int().safe().min(1).max(MAX_ARCHIVE_EVENTS),
    uncompressed_bytes: PositiveArchiveBytes(MAX_ARCHIVE_UNCOMPRESSED_BYTES),
    compressed_bytes: PositiveArchiveBytes(MAX_ARCHIVE_COMPRESSED_BYTES),
    canonical_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    data_etag: z.string().trim().min(1).max(MAX_ARCHIVE_ETAG_CHARS),
    first_event_id: OpaqueEventIdSchema,
    last_event_id: OpaqueEventIdSchema,
    first_observed_at: BoundedTimestampSchema,
    last_observed_at: BoundedTimestampSchema,
    archived_at: BoundedTimestampSchema,
    producer: ProducerSchema,
    source_checkpoint: SourceCheckpointSchema.nullable(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const keyParts = parseArchiveKey(manifest.data_key, "events");
    if (!keyParts) return;

    if (keyParts.tenant_id !== manifest.tenant_id) {
      context.addIssue({
        code: "custom",
        path: ["data_key"],
        message: "Archive data key tenant does not match manifest tenant",
      });
    }
    if (keyParts.batch_id !== manifest.batch_id) {
      context.addIssue({
        code: "custom",
        path: ["data_key"],
        message: "Archive data key batch does not match manifest batch",
      });
    }
    if (
      !archivePartitionMatchesObservedAt(
        manifest.data_key,
        manifest.first_observed_at,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["data_key"],
        message:
          "Archive data key partition does not match first observed timestamp",
      });
    }

    const firstObservedAt = Date.parse(manifest.first_observed_at);
    const lastObservedAt = Date.parse(manifest.last_observed_at);
    if (
      !Number.isFinite(firstObservedAt) ||
      !Number.isFinite(lastObservedAt) ||
      firstObservedAt > lastObservedAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["last_observed_at"],
        message:
          "Last observed timestamp must not precede first observed timestamp",
      });
    }
  });

export const ArchiveBatchManifestSchema = z.preprocess(
  snapshotStrictObjectInput,
  ArchiveBatchManifestObjectSchema,
);

export type ArchiveBatchManifest = z.infer<typeof ArchiveBatchManifestSchema>;

const ManifestPrefixSchema = z
  .string()
  .min(1)
  .max(MAX_MANIFEST_PREFIX_CHARS)
  .regex(/^[\x20-\x7E]+$/);

const ArchiveReplayCursorPayloadObjectSchema = z
  .object({
    schema_version: z.literal(1),
    tenant_id: CanonicalResourceIdSchema,
    manifest_prefix: ManifestPrefixSchema,
    r2_cursor: z.string().min(1).max(MAX_R2_CURSOR_CHARS),
  })
  .strict()
  .superRefine((cursor, context) => {
    const expectedPrefix = `manifests/${cursor.tenant_id}/`;
    if (cursor.manifest_prefix !== expectedPrefix) {
      context.addIssue({
        code: "custom",
        path: ["manifest_prefix"],
        message: "Cursor manifest prefix does not match tenant",
      });
    }
  });

export const ArchiveReplayCursorPayloadSchema = z.preprocess(
  snapshotStrictObjectInput,
  ArchiveReplayCursorPayloadObjectSchema,
);

export type ArchiveReplayCursorPayload = z.infer<
  typeof ArchiveReplayCursorPayloadSchema
>;

const ArchiveReplayPageObjectSchema = z
  .object({
    schema_version: z.literal(1),
    replay_mode: z.literal("projection_only"),
    tenant_id: CanonicalResourceIdSchema,
    manifests: z.preprocess(
      (input) => snapshotStrictArrayInput(input, MAX_MANIFEST_PAGE_SIZE),
      z.array(ArchiveBatchManifestSchema).max(MAX_MANIFEST_PAGE_SIZE),
    ),
    events: z.preprocess(
      (input) => snapshotStrictArrayInput(input, MAX_REPLAY_PAGE_EVENTS),
      z.array(CanonicalEventEnvelopeSchema).max(MAX_REPLAY_PAGE_EVENTS),
    ),
    next_cursor: z.string().min(1).max(MAX_REPLAY_CURSOR_CHARS).nullable(),
  })
  .strict()
  .superRefine((page, context) => {
    page.manifests.forEach((manifest, index) => {
      if (manifest.tenant_id !== page.tenant_id) {
        context.addIssue({
          code: "custom",
          path: ["manifests", index, "tenant_id"],
          message: "Replay page manifest tenant does not match page tenant",
        });
      }
    });
    page.events.forEach((event: CanonicalEventEnvelope, index) => {
      if (event.tenant_id !== page.tenant_id) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "tenant_id"],
          message: "Replay page event tenant does not match page tenant",
        });
      }
    });
  });

export const ArchiveReplayPageSchema = z.preprocess(
  snapshotStrictObjectInput,
  ArchiveReplayPageObjectSchema,
);

export type ArchiveReplayPage = z.infer<typeof ArchiveReplayPageSchema>;
