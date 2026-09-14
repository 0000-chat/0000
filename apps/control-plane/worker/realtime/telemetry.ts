import {
  MAX_REALTIME_IDENTITIES,
  MAX_REALTIME_SOCKETS_PER_TENANT,
  RealtimeIdSchema,
  RealtimeSubscriptionSchema,
  TimestampSchema,
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

const snapshotStrictArrayInput = (input: unknown): unknown => {
  try {
    if (input === null || typeof input !== "object" || !Array.isArray(input)) {
      return undefined;
    }
    if (Object.getPrototypeOf(input) !== Array.prototype) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor)) return undefined;
    const length = lengthDescriptor.value;
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_REALTIME_IDENTITIES
    ) {
      return undefined;
    }
    const keys = Reflect.ownKeys(input);
    if (keys.length !== length + 1) return undefined;

    const snapshot: unknown[] = [];
    for (const key of keys) {
      if (key === "length") continue;
      if (
        typeof key !== "string" ||
        !/^\d+$/.test(key) ||
        Number(key) >= length
      ) {
        return undefined;
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        return undefined;
      }
      snapshot[Number(key)] = descriptor.value;
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

const RealtimeSocketOutcomeSchema = z.enum([
  "accepted",
  "resumed",
  "closed",
  "lease_expired",
  "capacity_rejected",
]);

export type RealtimeSocketOutcome = z.infer<typeof RealtimeSocketOutcomeSchema>;

const RealtimeSocketTelemetryEventObjectSchema = z
  .object({
    schema_version: z.literal(1),
    type: z.literal("realtime.socket"),
    outcome: RealtimeSocketOutcomeSchema,
    tenant_id: RealtimeIdSchema,
    identity_id: RealtimeIdSchema,
    active_tenant_socket_count: z
      .number()
      .int()
      .safe()
      .min(0)
      .max(MAX_REALTIME_SOCKETS_PER_TENANT),
    resumed: z.boolean(),
    timestamp: TimestampSchema.max(64),
  })
  .strict();

export const RealtimeSocketTelemetryEventSchema = z.preprocess(
  snapshotStrictObjectInput,
  RealtimeSocketTelemetryEventObjectSchema,
);

export type RealtimeSocketTelemetryEvent = z.infer<
  typeof RealtimeSocketTelemetryEventSchema
>;

const RealtimeTelemetrySubjectSchema = z.preprocess(
  snapshotStrictObjectInput,
  z
    .object({
      tenant_id: RealtimeIdSchema,
      subscriptions: z.preprocess(
        snapshotStrictArrayInput,
        z.array(RealtimeSubscriptionSchema).min(1).max(MAX_REALTIME_IDENTITIES),
      ),
      resumed: z.boolean(),
    })
    .strict(),
);

export type RealtimeTelemetrySubject = {
  readonly tenant_id: string;
  readonly subscriptions: readonly RealtimeSubscription[];
  readonly resumed: boolean;
};

const telemetryFailure = (): Error =>
  new Error("Invalid realtime telemetry event");

const parseSubject = (subject: RealtimeTelemetrySubject) => {
  const parsed = RealtimeTelemetrySubjectSchema.safeParse(subject);
  if (!parsed.success) throw telemetryFailure();
  return parsed.data;
};

const parseActiveSocketCount = (value: number): number => {
  const parsed = z
    .number()
    .int()
    .safe()
    .min(0)
    .max(MAX_REALTIME_SOCKETS_PER_TENANT)
    .safeParse(value);
  if (!parsed.success) throw telemetryFailure();
  return parsed.data;
};

const parseTimestamp = (value: string): string => {
  const parsed = TimestampSchema.max(64).safeParse(value);
  if (!parsed.success) throw telemetryFailure();
  return parsed.data;
};

export const buildRealtimeSocketTelemetryEvents = (
  subject: RealtimeTelemetrySubject,
  outcome: RealtimeSocketOutcome,
  activeTenantSocketCount: number,
  timestamp = new Date().toISOString(),
): RealtimeSocketTelemetryEvent[] => {
  const parsedSubject = parseSubject(subject);
  const parsedOutcome = RealtimeSocketOutcomeSchema.safeParse(outcome);
  if (!parsedOutcome.success) throw telemetryFailure();
  const activeCount = parseActiveSocketCount(activeTenantSocketCount);
  const safeTimestamp = parseTimestamp(timestamp);

  return parsedSubject.subscriptions.map((subscription) => {
    const event = RealtimeSocketTelemetryEventSchema.safeParse({
      schema_version: 1,
      type: "realtime.socket",
      outcome: parsedOutcome.data,
      tenant_id: parsedSubject.tenant_id,
      identity_id: subscription.identity_id,
      active_tenant_socket_count: activeCount,
      resumed: parsedSubject.resumed,
      timestamp: safeTimestamp,
    });
    if (!event.success) throw telemetryFailure();
    return event.data;
  });
};

export type RealtimeSocketLogger = (
  event: RealtimeSocketTelemetryEvent,
) => void;

const defaultRealtimeSocketLogger: RealtimeSocketLogger = (event) => {
  console.info(event);
};

const safeEventFields = (value: unknown): unknown => {
  const snapshot = snapshotStrictObjectInput(value);
  if (snapshot === undefined) return undefined;
  const source = snapshot as Record<string, unknown>;
  return {
    schema_version: source.schema_version,
    type: source.type,
    outcome: source.outcome,
    tenant_id: source.tenant_id,
    identity_id: source.identity_id,
    active_tenant_socket_count: source.active_tenant_socket_count,
    resumed: source.resumed,
    timestamp: source.timestamp,
  };
};

/** Wrap a sink so it receives only the closed, schema-validated event shape. */
export const createRealtimeSocketLogger =
  (
    sink: RealtimeSocketLogger = defaultRealtimeSocketLogger,
  ): RealtimeSocketLogger =>
  (value) => {
    const parsed = RealtimeSocketTelemetryEventSchema.safeParse(
      safeEventFields(value),
    );
    if (!parsed.success) return;
    sink(parsed.data);
  };

export const logRealtimeSocketOutcome = (
  logger: RealtimeSocketLogger,
  subject: RealtimeTelemetrySubject,
  outcome: RealtimeSocketOutcome,
  activeTenantSocketCount: number,
  timestamp = new Date().toISOString(),
): void => {
  const safeLogger = createRealtimeSocketLogger(logger);
  for (const event of buildRealtimeSocketTelemetryEvents(
    subject,
    outcome,
    activeTenantSocketCount,
    timestamp,
  )) {
    safeLogger(event);
  }
};

export const buildRealtimeSocketAcceptedEvents = (
  subject: RealtimeTelemetrySubject,
  activeTenantSocketCount: number,
  timestamp?: string,
): RealtimeSocketTelemetryEvent[] =>
  buildRealtimeSocketTelemetryEvents(
    subject,
    "accepted",
    activeTenantSocketCount,
    timestamp,
  );

export const buildRealtimeSocketResumedEvents = (
  subject: RealtimeTelemetrySubject,
  activeTenantSocketCount: number,
  timestamp?: string,
): RealtimeSocketTelemetryEvent[] =>
  buildRealtimeSocketTelemetryEvents(
    subject,
    "resumed",
    activeTenantSocketCount,
    timestamp,
  );

export const buildRealtimeSocketClosedEvents = (
  subject: RealtimeTelemetrySubject,
  activeTenantSocketCount: number,
  timestamp?: string,
): RealtimeSocketTelemetryEvent[] =>
  buildRealtimeSocketTelemetryEvents(
    subject,
    "closed",
    activeTenantSocketCount,
    timestamp,
  );

export const buildRealtimeSocketLeaseExpiredEvents = (
  subject: RealtimeTelemetrySubject,
  activeTenantSocketCount: number,
  timestamp?: string,
): RealtimeSocketTelemetryEvent[] =>
  buildRealtimeSocketTelemetryEvents(
    subject,
    "lease_expired",
    activeTenantSocketCount,
    timestamp,
  );

export const buildRealtimeSocketCapacityRejectedEvents = (
  subject: RealtimeTelemetrySubject,
  activeTenantSocketCount: number,
  timestamp?: string,
): RealtimeSocketTelemetryEvent[] =>
  buildRealtimeSocketTelemetryEvents(
    subject,
    "capacity_rejected",
    activeTenantSocketCount,
    timestamp,
  );

type RealtimeTelemetryEnv = {
  readonly REALTIME_SOCKET_LOGGER?: unknown;
  readonly REALTIME_TELEMETRY_LOGGER?: unknown;
};

/** Read an optional injected sink without ever inspecting arbitrary env fields. */
export const realtimeSocketLoggerFromEnv = (
  environment: unknown,
): RealtimeSocketLogger => {
  const snapshot = snapshotStrictObjectInput(environment) as
    | RealtimeTelemetryEnv
    | undefined;
  const candidate =
    snapshot?.REALTIME_SOCKET_LOGGER ?? snapshot?.REALTIME_TELEMETRY_LOGGER;
  return typeof candidate === "function"
    ? createRealtimeSocketLogger(candidate as RealtimeSocketLogger)
    : createRealtimeSocketLogger();
};
