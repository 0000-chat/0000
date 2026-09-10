import {
  MAX_REALTIME_ATTACHMENT_JSON_BYTES,
  MAX_REALTIME_IDENTITIES,
  RealtimeIdSchema,
  RealtimePositionSchema,
  RealtimeResumePositionSchema,
  RealtimeSubscriptionSchema,
  type RealtimePosition,
  type RealtimeResumePosition,
  type RealtimeSubscription,
} from "@communicator/contracts";
import { z } from "zod";

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

const isArrayIndexKey = (key: string, length: number): boolean => {
  const index = Number(key);
  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
};

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
      if (!isArrayIndexKey(key, length)) return undefined;

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

const RealtimeTimestampSchema = z.string().datetime({ offset: true }).max(64);
const RealtimePositiveIntegerSchema = z.number().int().safe().positive();
const RealtimeNonnegativeIntegerSchema = z
  .number()
  .int()
  .safe()
  .nonnegative();

const RealtimeSubscriptionArraySchema = strictArray(
  RealtimeSubscriptionSchema,
  MAX_REALTIME_IDENTITIES,
  1,
);
const RealtimeResumeArraySchema = strictArray(
  RealtimeResumePositionSchema,
  MAX_REALTIME_IDENTITIES,
);
const RealtimePositionArraySchema = strictArray(
  RealtimePositionSchema,
  MAX_REALTIME_IDENTITIES,
  1,
);

const RealtimeUpgradeContextObjectSchema = z
  .object({
    schema_version: z.literal(1),
    tenant_id: RealtimeIdSchema,
    principal_id: RealtimeIdSchema,
    membership_id: RealtimeIdSchema,
    subscriptions: RealtimeSubscriptionArraySchema,
    resume: RealtimeResumeArraySchema,
    issued_at: RealtimeTimestampSchema,
    expires_at: RealtimeTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const identities = new Set<string>();
    value.subscriptions.forEach((subscription, index) => {
      if (identities.has(subscription.identity_id)) {
        context.addIssue({
          code: "custom",
          path: ["subscriptions", index, "identity_id"],
          message: "Values must be unique",
        });
      }
      identities.add(subscription.identity_id);
    });

    const resumeIdentities = new Set<string>();
    value.resume.forEach((position, index) => {
      if (resumeIdentities.has(position.identity_id)) {
        context.addIssue({
          code: "custom",
          path: ["resume", index, "identity_id"],
          message: "Values must be unique",
        });
      }
      resumeIdentities.add(position.identity_id);
      if (!identities.has(position.identity_id)) {
        context.addIssue({
          code: "custom",
          path: ["resume", index, "identity_id"],
          message: "Resume identity must be subscribed",
        });
      }
    });
  });

export const RealtimeUpgradeContextSchema = z.preprocess(
  snapshotStrictObjectInput,
  RealtimeUpgradeContextObjectSchema,
);
export type RealtimeUpgradeContext = z.infer<
  typeof RealtimeUpgradeContextSchema
>;

const RealtimeSocketAttachmentObjectSchema = z
  .object({
    schema_version: z.literal(1),
    tenant_id: RealtimeIdSchema,
    principal_id: RealtimeIdSchema,
    subscriptions: RealtimeSubscriptionArraySchema,
    positions: RealtimePositionArraySchema,
    lease_expires_at: RealtimeTimestampSchema,
    resumed: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const subscribedIdentities = new Set(
      value.subscriptions.map((subscription) => subscription.identity_id),
    );
    const identities = new Set<string>();
    value.positions.forEach((position, index) => {
      if (identities.has(position.identity_id)) {
        context.addIssue({
          code: "custom",
          path: ["positions", index, "identity_id"],
          message: "Values must be unique",
        });
      }
      identities.add(position.identity_id);
      if (!subscribedIdentities.has(position.identity_id)) {
        context.addIssue({
          code: "custom",
          path: ["positions", index, "identity_id"],
          message: "Position identity must be subscribed",
        });
      }
    });
    if (identities.size !== subscribedIdentities.size) {
      context.addIssue({
        code: "custom",
        path: ["positions"],
        message: "Every subscribed identity must have a position",
      });
    }
  });

export const RealtimeSocketAttachmentSchema = z.preprocess(
  snapshotStrictObjectInput,
  RealtimeSocketAttachmentObjectSchema,
);
export type RealtimeSocketAttachment = z.infer<
  typeof RealtimeSocketAttachmentSchema
>;

export type RealtimeContractErrorCode =
  | "invalid_upgrade_context"
  | "invalid_socket_attachment"
  | "socket_attachment_too_large";

const REALTIME_CONTRACT_ERROR_MESSAGES: Record<
  RealtimeContractErrorCode,
  string
> = {
  invalid_upgrade_context: "Invalid realtime upgrade context",
  invalid_socket_attachment: "Invalid realtime socket attachment",
  socket_attachment_too_large: "Realtime socket attachment is too large",
};

const realtimeContractErrorCauses = new WeakMap<RealtimeContractError, unknown>();

export class RealtimeContractError extends Error {
  readonly code: RealtimeContractErrorCode;

  constructor(code: RealtimeContractErrorCode, cause?: unknown) {
    super(REALTIME_CONTRACT_ERROR_MESSAGES[code]);
    this.name = "RealtimeContractError";
    this.code = code;
    if (cause !== undefined) realtimeContractErrorCauses.set(this, cause);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const getRealtimeContractErrorCause = (
  error: RealtimeContractError,
): unknown => realtimeContractErrorCauses.get(error);

export const parseRealtimeUpgradeContext = (
  value: unknown,
): RealtimeUpgradeContext => {
  const result = RealtimeUpgradeContextSchema.safeParse(value);
  if (!result.success) {
    throw new RealtimeContractError("invalid_upgrade_context", result.error);
  }
  return result.data;
};

const realtimeTextEncoder = new TextEncoder();

export const realtimeAttachmentJsonBytes = (value: unknown): number => {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== "string") {
      throw new Error("Attachment JSON is not a string");
    }
    return realtimeTextEncoder.encode(json).byteLength;
  } catch (error) {
    throw new RealtimeContractError("invalid_socket_attachment", error);
  }
};

export const assertRealtimeAttachmentSize = <Value>(value: Value): Value => {
  const bytes = realtimeAttachmentJsonBytes(value);
  if (bytes > MAX_REALTIME_ATTACHMENT_JSON_BYTES) {
    throw new RealtimeContractError("socket_attachment_too_large");
  }
  return value;
};

export const parseRealtimeAttachment = (
  value: unknown,
): RealtimeSocketAttachment => {
  const result = RealtimeSocketAttachmentSchema.safeParse(value);
  if (!result.success) {
    throw new RealtimeContractError("invalid_socket_attachment", result.error);
  }
  return assertRealtimeAttachmentSize(result.data);
};

export const serializeRealtimeAttachment = (
  value: unknown,
): RealtimeSocketAttachment => parseRealtimeAttachment(value);

export type {
  RealtimePosition,
  RealtimeResumePosition,
  RealtimeSubscription,
};
