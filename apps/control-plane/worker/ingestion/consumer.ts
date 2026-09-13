import {
  CommittedArchivePointerSchema,
  CanonicalResourceIdSchema,
  IngestionCommittedArchiveManifestSchema,
  MAX_INGESTION_QUEUE_POINTER_BYTES,
  ProjectionAuthorizationContextSchema,
  ProjectionConnectionBindingSchema,
  ProjectionEventEnvelopeSchema,
  compareOpaqueEventIds,
  type CommittedArchivePointer,
  type IngestionCommittedArchiveManifest,
  type ProjectionAuthorizationContext,
  type ProjectionConnectionBinding,
  type ProjectionEventEnvelope,
} from "@communicator/contracts";
import { readCommittedArchiveBatch } from "../archive/reader";
import { deriveArchiveKeys, isArchiveKeyForTenant } from "../archive/keys";
import { canonicalJsonStringify } from "../archive/canonical-json";
import { isArchiveError, type ArchiveError } from "../archive/errors";
import {
  resolveArchivedBindings,
  resolveArchivedIngestionRoute,
  type ArchivedIngestionRoute,
  type IngestionConnectionBinding,
} from "../control-directory/ingestion-repository";
import { getTenantProjection } from "../projection/routing";
import { isProjectionError, type ProjectionError } from "../projection/errors";
import type { TenantProjectionDO } from "../projection/tenant-projection";

export const INGESTION_UNAVAILABLE_RETRY_DELAY_SECONDS = 60 as const;
export const INGESTION_POISON_RETRY_DELAY_SECONDS = 300 as const;

type ConsumerFailureCode =
  | "invalid"
  | "corrupt"
  | "unavailable"
  | "not_found"
  | "forbidden"
  | "conflict"
  | "rebuilding";

const unavailableFailureCodes = new Set<ConsumerFailureCode>([
  "unavailable",
  "rebuilding",
]);

const projectionFailureNames = new Set([
  "projection_invalid",
  "projection_forbidden",
  "projection_tenant_mismatch",
  "projection_conflict",
  "projection_rebuilding",
  "projection_rebuild_failed",
  "projection_rebuild_mismatch",
  "projection_not_found",
  "projection_too_large",
  "projection_unavailable",
]);

class IngestionConsumerFailure extends Error {
  readonly failureCode: ConsumerFailureCode;

  constructor(failureCode: ConsumerFailureCode) {
    super("Ingestion queue message failed");
    this.name = "IngestionConsumerFailure";
    this.failureCode = failureCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const consumerFailure = (
  failureCode: ConsumerFailureCode,
): IngestionConsumerFailure => new IngestionConsumerFailure(failureCode);

const retryDelayFor = (failureCode: ConsumerFailureCode): number =>
  unavailableFailureCodes.has(failureCode)
    ? INGESTION_UNAVAILABLE_RETRY_DELAY_SECONDS
    : INGESTION_POISON_RETRY_DELAY_SECONDS;

const compareUtf8 = (left: string, right: string): number => {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const leftByte = leftBytes[index];
    const rightByte = rightBytes[index];
    if (leftByte === undefined || rightByte === undefined) continue;
    if (leftByte !== rightByte) return leftByte - rightByte;
  }
  return leftBytes.length - rightBytes.length;
};

const parsePointer = (body: unknown): CommittedArchivePointer => {
  const parsed = CommittedArchivePointerSchema.safeParse(body);
  if (!parsed.success) throw consumerFailure("invalid");

  try {
    const encoded = new TextEncoder().encode(
      canonicalJsonStringify(parsed.data),
    );
    if (encoded.byteLength > MAX_INGESTION_QUEUE_POINTER_BYTES) {
      throw consumerFailure("invalid");
    }
  } catch (error) {
    if (error instanceof IngestionConsumerFailure) throw error;
    throw consumerFailure("invalid");
  }

  return parsed.data;
};

const assertPointerTenantKey = (pointer: CommittedArchivePointer): void => {
  if (
    !isArchiveKeyForTenant(pointer.manifest_key, pointer.tenant_id, "manifest")
  ) {
    throw consumerFailure("invalid");
  }
};

const parseArchivedEvents = (
  pointer: CommittedArchivePointer,
  events: readonly unknown[],
): ProjectionEventEnvelope[] => {
  if (!Array.isArray(events) || events.length < 1 || events.length > 500) {
    throw consumerFailure("corrupt");
  }
  const parsedEvents: ProjectionEventEnvelope[] = [];
  try {
    for (const event of events) {
      const parsed = ProjectionEventEnvelopeSchema.safeParse(event);
      if (!parsed.success) throw consumerFailure("corrupt");
      if (parsed.data.tenant_id !== pointer.tenant_id) {
        throw consumerFailure("conflict");
      }
      parsedEvents.push(parsed.data);
    }
  } catch (error) {
    if (error instanceof IngestionConsumerFailure) throw error;
    throw consumerFailure("corrupt");
  }
  if (parsedEvents.length === 0) throw consumerFailure("corrupt");
  return parsedEvents;
};

const assertManifestMatchesPointer = (
  pointer: CommittedArchivePointer,
  manifest: IngestionCommittedArchiveManifest,
): void => {
  let expectedManifestKey: string;
  try {
    expectedManifestKey = deriveArchiveKeys(
      pointer.tenant_id,
      pointer.batch_id,
      manifest.first_observed_at,
    ).manifestKey;
  } catch {
    throw consumerFailure("corrupt");
  }

  if (
    expectedManifestKey !== pointer.manifest_key ||
    manifest.tenant_id !== pointer.tenant_id ||
    manifest.batch_id !== pointer.batch_id ||
    manifest.canonical_sha256 !== pointer.canonical_sha256
  ) {
    throw consumerFailure("conflict");
  }
};

const assertHistoricalBindings = (
  pointer: CommittedArchivePointer,
  events: readonly ProjectionEventEnvelope[],
  bindings: readonly IngestionConnectionBinding[],
  route: ArchivedIngestionRoute,
): ProjectionConnectionBinding[] => {
  if (
    !Array.isArray(bindings) ||
    bindings.length === 0 ||
    bindings.length > 500
  ) {
    throw consumerFailure("conflict");
  }
  const byAccount = new Map<string, IngestionConnectionBinding>();
  for (const binding of bindings) {
    const parsedBinding = ProjectionConnectionBindingSchema.safeParse({
      account_id: binding.account_id,
      connection_id: binding.connection_id,
      identity_id: binding.identity_id,
      platform: binding.platform,
    });
    if (
      !parsedBinding.success ||
      (binding.account_status !== "active" &&
        binding.account_status !== "retired") ||
      binding.gateway_route_id !== pointer.gateway_route_id ||
      byAccount.has(parsedBinding.success ? parsedBinding.data.account_id : "")
    ) {
      throw consumerFailure("conflict");
    }
    byAccount.set(binding.account_id, {
      ...parsedBinding.data,
      gateway_route_id: binding.gateway_route_id,
      account_status: binding.account_status,
    });
  }

  const eventAccountIds = new Set<string>();
  for (const event of events) {
    const binding = byAccount.get(event.account_id);
    if (
      binding === undefined ||
      binding.gateway_route_id !== route.gateway_route_id ||
      binding.identity_id !== event.identity_id ||
      binding.platform !== event.platform
    ) {
      throw consumerFailure("conflict");
    }
    eventAccountIds.add(event.account_id);
  }

  if (
    eventAccountIds.size !== byAccount.size ||
    ![...eventAccountIds].every((accountId) => byAccount.has(accountId))
  ) {
    throw consumerFailure("conflict");
  }

  return bindings
    .map<ProjectionConnectionBinding>((binding) => ({
      account_id: binding.account_id,
      connection_id: binding.connection_id,
      identity_id: binding.identity_id,
      platform: binding.platform,
    }))
    .sort((left, right) => compareUtf8(left.account_id, right.account_id));
};

const sortedIdentityIds = (
  events: readonly ProjectionEventEnvelope[],
): string[] =>
  [...new Set(events.map((event) => event.identity_id))].sort(compareUtf8);

const authorizationFor = (
  pointer: CommittedArchivePointer,
  principalId: string,
  identityIds: readonly string[],
  scope: ProjectionAuthorizationContext["scopes"][number],
): ProjectionAuthorizationContext => {
  const candidate = {
    schema_version: 1 as const,
    tenant_id: pointer.tenant_id,
    principal_id: principalId,
    allowed_identity_ids: [...identityIds],
    scopes: [scope],
  };
  const parsed = ProjectionAuthorizationContextSchema.safeParse(candidate);
  if (!parsed.success) throw consumerFailure("forbidden");
  return parsed.data;
};

const eventComparator = (
  left: ProjectionEventEnvelope,
  right: ProjectionEventEnvelope,
): number => {
  const leftObserved = Date.parse(left.observed_at);
  const rightObserved = Date.parse(right.observed_at);
  if (!Number.isFinite(leftObserved) || !Number.isFinite(rightObserved)) {
    throw consumerFailure("corrupt");
  }
  if (leftObserved !== rightObserved) return leftObserved - rightObserved;
  return compareOpaqueEventIds(left.event_id, right.event_id);
};

const liveCheckpointFor = (
  events: readonly ProjectionEventEnvelope[],
): {
  kind: "live_event_watermark";
  value: string;
  last_observed_at: string;
  last_event_id: string;
} => {
  const greatest = events.reduce((current, next) =>
    eventComparator(next, current) > 0 ? next : current,
  );
  return {
    kind: "live_event_watermark",
    value: greatest.event_id,
    last_observed_at: greatest.observed_at,
    last_event_id: greatest.event_id,
  };
};

const archiveFailureCode = (error: ArchiveError): ConsumerFailureCode => {
  switch (error.code) {
    case "archive_unavailable":
      return "unavailable";
    case "archive_conflict":
    case "archive_tenant_mismatch":
      return "conflict";
    case "archive_invalid":
      return "invalid";
    case "archive_corrupt":
    case "archive_not_found":
    case "archive_too_large":
      return "corrupt";
  }
};

const projectionFailureCode = (error: ProjectionError): ConsumerFailureCode => {
  switch (error.code) {
    case "projection_rebuilding":
      return "rebuilding";
    case "projection_unavailable":
    case "projection_not_found":
      return "unavailable";
    case "projection_forbidden":
      return "forbidden";
    case "projection_chat_paused":
      return "conflict";
    case "projection_conflict":
    case "projection_tenant_mismatch":
    case "projection_rebuild_failed":
      return "conflict";
    case "projection_invalid":
    case "projection_too_large":
    case "projection_rebuild_mismatch":
      return "invalid";
  }
};

const codeFromUnknownError = (
  error: unknown,
): ConsumerFailureCode | undefined => {
  try {
    if (isArchiveError(error)) return archiveFailureCode(error);
    if (isProjectionError(error)) return projectionFailureCode(error);
    if (error !== null && typeof error === "object") {
      const descriptor = Object.getOwnPropertyDescriptor(error, "code");
      if (
        descriptor &&
        "value" in descriptor &&
        typeof descriptor.value === "string" &&
        projectionFailureNames.has(descriptor.value)
      ) {
        return projectionFailureCode({
          code: descriptor.value,
        } as ProjectionError);
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
};

export type IngestionConsumerServices = {
  readCommittedArchiveBatch?: typeof readCommittedArchiveBatch;
  resolveArchivedIngestionRoute?: typeof resolveArchivedIngestionRoute;
  resolveArchivedBindings?: typeof resolveArchivedBindings;
  getTenantProjection?: typeof getTenantProjection;
};

type ConsumerEnvironment = Pick<
  Cloudflare.Env,
  "CONTROL_DB" | "EVENT_ARCHIVE" | "TENANT_PROJECTION"
>;

const processMessage = async (
  body: unknown,
  environment: ConsumerEnvironment,
  services: IngestionConsumerServices,
): Promise<void> => {
  const pointer = parsePointer(body);
  assertPointerTenantKey(pointer);

  let committed: Awaited<ReturnType<typeof readCommittedArchiveBatch>>;
  try {
    committed = await (
      services.readCommittedArchiveBatch ?? readCommittedArchiveBatch
    )(environment.EVENT_ARCHIVE, pointer.tenant_id, pointer.manifest_key);
  } catch (error) {
    const failureCode = codeFromUnknownError(error);
    throw consumerFailure(failureCode ?? "unavailable");
  }

  let manifest: IngestionCommittedArchiveManifest;
  try {
    const parsed = IngestionCommittedArchiveManifestSchema.safeParse(
      committed.manifest,
    );
    if (!parsed.success) throw consumerFailure("corrupt");
    manifest = parsed.data;
  } catch (error) {
    if (error instanceof IngestionConsumerFailure) throw error;
    throw consumerFailure("corrupt");
  }
  assertManifestMatchesPointer(pointer, manifest);

  const events = parseArchivedEvents(pointer, committed.events);
  const accountIds = [...new Set(events.map((event) => event.account_id))];

  let historicalRoute: Awaited<
    ReturnType<typeof resolveArchivedIngestionRoute>
  >;
  try {
    historicalRoute = await (
      services.resolveArchivedIngestionRoute ?? resolveArchivedIngestionRoute
    )(environment.CONTROL_DB, pointer.gateway_route_id);
  } catch {
    throw consumerFailure("unavailable");
  }
  if (!historicalRoute.ok) {
    throw consumerFailure(
      historicalRoute.code === "unavailable" ? "unavailable" : "not_found",
    );
  }
  if (
    historicalRoute.value.gateway_route_id !== pointer.gateway_route_id ||
    !CanonicalResourceIdSchema.safeParse(
      historicalRoute.value.service_principal_id,
    ).success
  ) {
    throw consumerFailure("conflict");
  }

  let historicalBindings: Awaited<ReturnType<typeof resolveArchivedBindings>>;
  try {
    historicalBindings = await (
      services.resolveArchivedBindings ?? resolveArchivedBindings
    )(
      environment.CONTROL_DB,
      historicalRoute.value.gateway_route_id,
      pointer.tenant_id,
      accountIds,
    );
  } catch {
    throw consumerFailure("unavailable");
  }
  if (!historicalBindings.ok) {
    throw consumerFailure(
      historicalBindings.code === "unavailable" ? "unavailable" : "conflict",
    );
  }

  const connections = assertHistoricalBindings(
    pointer,
    events,
    historicalBindings.value,
    historicalRoute.value,
  );
  const identityIds = sortedIdentityIds(events);
  const initializeAuthorization = authorizationFor(
    pointer,
    historicalRoute.value.service_principal_id,
    identityIds,
    "projection.initialize",
  );
  const writeAuthorization = authorizationFor(
    pointer,
    historicalRoute.value.service_principal_id,
    identityIds,
    "projection.write",
  );
  const checkpoint = liveCheckpointFor(events);

  let projection: DurableObjectStub<TenantProjectionDO>;
  try {
    projection = (services.getTenantProjection ?? getTenantProjection)(
      environment,
      pointer.tenant_id,
    );
  } catch (error) {
    const failureCode = codeFromUnknownError(error);
    throw consumerFailure(failureCode ?? "unavailable");
  }

  try {
    await projection.initialize({
      schema_version: 1,
      tenant_id: pointer.tenant_id,
      initialized_at: manifest.archived_at,
      authorization: initializeAuthorization,
    });
    await projection.applyBatch({
      schema_version: 1,
      tenant_id: pointer.tenant_id,
      authorization: writeAuthorization,
      mode: "live",
      rebuild_id: null,
      connections,
      events,
      checkpoint,
    });
  } catch (error) {
    const failureCode = codeFromUnknownError(error);
    throw consumerFailure(failureCode ?? "unavailable");
  }
};

export const createIngestionQueueHandler =
  (
    services: IngestionConsumerServices = {},
  ): ExportedHandlerQueueHandler<Cloudflare.Env, unknown> =>
  async (batch, environment, _context): Promise<void> => {
    for (const message of batch.messages) {
      try {
        await processMessage(message.body, environment, services);
        message.ack();
      } catch (error) {
        const failureCode =
          error instanceof IngestionConsumerFailure
            ? error.failureCode
            : (codeFromUnknownError(error) ?? "unavailable");
        try {
          message.retry({ delaySeconds: retryDelayFor(failureCode) });
        } catch {
          // Queue runtime errors must not prevent later siblings from being handled.
        }
      }
    }
  };

export const consumeIngestionQueue = createIngestionQueueHandler();
