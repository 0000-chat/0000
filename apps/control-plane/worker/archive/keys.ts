import {
  ArchiveDataKeySchema,
  ArchiveManifestKeySchema,
  CanonicalResourceIdSchema,
  TimestampSchema,
  type ArchiveDataKey,
  type ArchiveManifestKey,
} from "@communicator/contracts";
import { archiveError } from "./errors";

export { ArchiveError } from "./errors";

export type ArchiveKeyPair = {
  dataKey: ArchiveDataKey;
  manifestKey: ArchiveManifestKey;
};

export type ArchiveKeyParts = {
  kind: "data" | "manifest";
  tenantId: string;
  year: string;
  month: string;
  day: string;
  hour: string;
  batchId: string;
};

const BATCH_ID_PREFIX = "batch_";

const parseDateParts = (observedAt: string): Omit<ArchiveKeyParts, "kind" | "tenantId" | "batchId"> => {
  const timestampResult = TimestampSchema.max(64).safeParse(observedAt);
  if (!timestampResult.success) throw archiveError("archive_invalid");

  const instant = new Date(observedAt);
  if (!Number.isFinite(instant.getTime())) throw archiveError("archive_invalid");

  return {
    year: String(instant.getUTCFullYear()).padStart(4, "0"),
    month: String(instant.getUTCMonth() + 1).padStart(2, "0"),
    day: String(instant.getUTCDate()).padStart(2, "0"),
    hour: String(instant.getUTCHours()).padStart(2, "0"),
  };
};

const validateResourceId = (value: string, batch = false): string => {
  if (!CanonicalResourceIdSchema.safeParse(value).success) {
    throw archiveError("archive_invalid");
  }
  if (batch && !value.startsWith(BATCH_ID_PREFIX)) {
    throw archiveError("archive_invalid");
  }
  return value;
};

export const deriveManifestPrefix = (tenantId: string): string => {
  validateResourceId(tenantId);
  const prefix = `manifests/${tenantId}/`;
  if (!/^[\x20-\x7E]+$/.test(prefix)) throw archiveError("archive_invalid");
  return prefix;
};

export const deriveArchiveKeys = (
  tenantId: string,
  batchId: string,
  earliestObservedAt: string,
): ArchiveKeyPair => {
  validateResourceId(tenantId);
  validateResourceId(batchId, true);
  const parts = parseDateParts(earliestObservedAt);

  const dataKey = `events/${tenantId}/${parts.year}/${parts.month}/${parts.day}/${parts.hour}/${batchId}.jsonl.gz`;
  const manifestKey = `manifests/${tenantId}/${parts.year}/${parts.month}/${parts.day}/${parts.hour}/${batchId}.json`;

  const dataResult = ArchiveDataKeySchema.safeParse(dataKey);
  const manifestResult = ArchiveManifestKeySchema.safeParse(manifestKey);
  if (!dataResult.success || !manifestResult.success) {
    throw archiveError("archive_invalid");
  }
  return { dataKey: dataResult.data, manifestKey: manifestResult.data };
};

export const deriveArchiveKeyPair = deriveArchiveKeys;

const KEY_PATTERN = /^(events|manifests)\/([^/]+)\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})\/([^/]+)\.(jsonl\.gz|json)$/;

const validDatePart = (year: string, month: string, day: string, hour: string): boolean => {
  const instant = new Date(`${year}-${month}-${day}T${hour}:00:00.000Z`);
  return (
    Number.isFinite(instant.getTime()) &&
    instant.getUTCFullYear() === Number(year) &&
    instant.getUTCMonth() + 1 === Number(month) &&
    instant.getUTCDate() === Number(day) &&
    instant.getUTCHours() === Number(hour)
  );
};

export const parseArchiveKey = (key: string): ArchiveKeyParts | null => {
  if (typeof key !== "string") return null;
  const match = KEY_PATTERN.exec(key);
  if (!match) return null;
  const kindSegment = match[1];
  const tenantId = match[2];
  const year = match[3];
  const month = match[4];
  const day = match[5];
  const hour = match[6];
  const file = match[7];
  const suffix = match[8];
  if (
    kindSegment === undefined ||
    tenantId === undefined ||
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    file === undefined ||
    suffix === undefined
  ) {
    return null;
  }
  const kind = suffix === "jsonl.gz" ? "data" : "manifest";
  if ((kind === "data" && kindSegment !== "events") || (kind === "manifest" && kindSegment !== "manifests")) {
    return null;
  }
  const batchId = file;
  if (
    !validDatePart(year, month, day, hour) ||
    !CanonicalResourceIdSchema.safeParse(tenantId).success ||
    !batchId.startsWith(BATCH_ID_PREFIX) ||
    !CanonicalResourceIdSchema.safeParse(batchId).success
  ) {
    return null;
  }
  const schema = kind === "data" ? ArchiveDataKeySchema : ArchiveManifestKeySchema;
  if (!schema.safeParse(key).success) return null;
  return { kind, tenantId, year, month, day, hour, batchId };
};

export const isArchiveKeyForTenant = (
  key: string,
  tenantId: string,
  kind?: "data" | "manifest",
): boolean => {
  const parts = parseArchiveKey(key);
  return (
    parts !== null &&
    parts.tenantId === tenantId &&
    (kind === undefined || parts.kind === kind)
  );
};
