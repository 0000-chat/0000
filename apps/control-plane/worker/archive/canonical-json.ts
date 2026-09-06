import {
  CanonicalJsonValueSchema,
  type CanonicalJsonValue,
} from "@communicator/contracts";
import { ArchiveError, archiveError } from "./errors";

export { ArchiveError } from "./errors";

const PROTOTYPE_SENSITIVE_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

const isCanonicalJsonValue = (value: unknown): value is CanonicalJsonValue => {
  try {
    return CanonicalJsonValueSchema.safeParse(value).success;
  } catch (error) {
    throw archiveError("archive_invalid", error);
  }
};

const stringifyCanonical = (value: CanonicalJsonValue): string => {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw archiveError("archive_invalid");
  }

  if (Array.isArray(value)) {
    const values: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) {
        throw archiveError("archive_invalid");
      }
      values.push(stringifyCanonical(descriptor.value as CanonicalJsonValue));
    }
    return `[${values.join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  const pairs: string[] = [];
  for (const key of keys) {
    if (PROTOTYPE_SENSITIVE_KEYS.has(key)) {
      throw archiveError("archive_invalid");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw archiveError("archive_invalid");
    }
    pairs.push(
      `${JSON.stringify(key)}:${stringifyCanonical(
        descriptor.value as CanonicalJsonValue,
      )}`,
    );
  }
  return `{${pairs.join(",")}}`;
};

/** Serialize a bounded JSON-safe value with recursive UTF-16 key ordering. */
export const canonicalJsonStringify = (value: unknown): string => {
  if (!isCanonicalJsonValue(value)) {
    throw archiveError("archive_invalid");
  }

  try {
    return stringifyCanonical(value);
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive_invalid", error);
  }
};

export const utf8ByteLength = (value: string): number => {
  try {
    return new TextEncoder().encode(value).byteLength;
  } catch (error) {
    throw archiveError("archive_unavailable", error);
  }
};

export const canonicalJsonBytes = (value: unknown): Uint8Array => {
  const serialized = canonicalJsonStringify(value);
  try {
    return new TextEncoder().encode(serialized);
  } catch (error) {
    throw archiveError("archive_unavailable", error);
  }
};

export const canonicalJsonLineBytes = (value: unknown): Uint8Array => {
  const serialized = canonicalJsonStringify(value);
  try {
    const body = new TextEncoder().encode(serialized);
    const line = new Uint8Array(body.byteLength + 1);
    line.set(body);
    line[body.byteLength] = 0x0a;
    return line;
  } catch (error) {
    throw archiveError("archive_unavailable", error);
  }
};

export const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};
